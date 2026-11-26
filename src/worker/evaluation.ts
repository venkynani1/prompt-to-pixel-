import { judgeSubmission } from './ai/judge';
import { AiQuotaError } from './ai/providers';
import { modelInfo } from './ai/models';
import type { AppContext } from './context';
import { addUsage, todayUsage } from './usage';

export type JobOutcome =
  | { outcome: 'done' }
  | { outcome: 'skip'; reason: string }
  | { outcome: 'retry'; delaySec: number; error?: string }
  | { outcome: 'failed'; error: string }
  | { outcome: 'paused'; reason: string };

export function backoffSeconds(attempt: number, rand = Math.random()): number {
  // 5s, 10s, 20s, 40s … capped at 5 min, ±20% jitter
  const base = Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(base * (0.8 + rand * 0.4)));
}

/** Neurons we expect the next call to cost: recent average, or a conservative estimate. */
async function expectedNeurons(ctx: AppContext, model: string): Promise<number> {
  const rows = await ctx.db.query<{ avg: string | null }>(
    `SELECT avg(neurons_est)::text AS avg FROM (
       SELECT neurons_est FROM evaluation_results WHERE model=$1 AND neurons_est > 0 ORDER BY created_at DESC LIMIT 10) x`, [model]);
  const avg = Number(rows[0]?.avg ?? 0);
  if (avg > 0) return avg * 1.2;
  const m = modelInfo(model);
  return ((2 * m.imageTokenEstimate + 900) * m.neuronsPerMIn + 300 * m.neuronsPerMOut) / 1e6;
}

export async function aiBudgetAvailable(ctx: AppContext, eventId: string, model: string, provider: string) {
  if (provider !== 'workers-ai') return { ok: true, used: 0, cap: 0, next: 0 };
  const [s] = await ctx.db.query<{ cap: number }>(`SELECT ai_neuron_daily_cap AS cap FROM host_settings WHERE event_id=$1`, [eventId]);
  const used = (await todayUsage(ctx.db)).ai_neurons ?? 0;
  const next = await expectedNeurons(ctx, model);
  return { ok: used + next <= (s?.cap ?? 8500), used, cap: s?.cap ?? 8500, next };
}

export async function refreshLeaderboard(ctx: AppContext, eventId: string) {
  await ctx.db.batch([
    { text: `DELETE FROM leaderboard_entries l USING teams t WHERE l.team_id=t.id AND t.event_id=$1 AND t.disabled`, params: [eventId] },
    { text: `INSERT INTO leaderboard_entries(event_id,team_id,r1_score,r2_score,total,r2_submitted_at,updated_at)
             SELECT t.event_id, t.id, x.r1, x.r2, coalesce(x.r1,0)+coalesce(x.r2,0)
                    + coalesce((SELECT sum(b.points) FROM bonus_points b WHERE b.team_id=t.id),0), x.r2_at, now()
             FROM teams t
             LEFT JOIN LATERAL (
               SELECT sum(s.score_total) FILTER (WHERE r.round_no=1) AS r1,
                      sum(s.score_total) FILTER (WHERE r.round_no=2) AS r2,
                      max(s.submitted_at) FILTER (WHERE r.round_no=2) AS r2_at
               FROM submissions s JOIN round_configs r ON r.id=s.round_id
               WHERE s.team_id=t.id AND s.status='scored') x ON true
             WHERE t.event_id=$1 AND NOT t.disabled
             ON CONFLICT (event_id,team_id) DO UPDATE SET r1_score=EXCLUDED.r1_score, r2_score=EXCLUDED.r2_score,
               total=EXCLUDED.total, r2_submitted_at=EXCLUDED.r2_submitted_at, updated_at=now()`, params: [eventId] },
    { text: `UPDATE leaderboard_entries l SET rank=x.rnk FROM (
               SELECT team_id, RANK() OVER (ORDER BY total DESC, coalesce(r2_score,0) DESC, r2_submitted_at ASC NULLS LAST) AS rnk
               FROM leaderboard_entries WHERE event_id=$1) x
             WHERE l.event_id=$1 AND l.team_id=x.team_id`, params: [eventId] },
    { text: `UPDATE events SET state_version=state_version+1 WHERE id=$1`, params: [eventId] },
  ]);
}

export async function bumpVersion(ctx: AppContext, eventId: string) {
  await ctx.db.query(`UPDATE events SET state_version=state_version+1 WHERE id=$1`, [eventId]);
}

/**
 * Process one evaluation job. Safe to call any number of times for the same job:
 *  - the conditional UPDATE "claim" lets only one worker run it at a time,
 *  - results are UNIQUE per job and at most one result per submission is published,
 *  - the submission is only marked scored from a non-final state.
 */
export async function processJob(ctx: AppContext, jobId: string): Promise<JobOutcome> {
  const [job] = await ctx.db.query<any>(
    `SELECT j.*, s.event_id, s.round_id, s.judge_image_id, s.status AS sub_status, s.flags,
            hs.eval_concurrency, hs.max_attempts,
            r.round_no, r.locked_provider, r.locked_model, r.locked_mode, r.reference_judge_image_id,
            r.reference_description, r.concepts
     FROM evaluation_jobs j
     JOIN submissions s ON s.id=j.submission_id
     JOIN round_configs r ON r.id=s.round_id
     JOIN host_settings hs ON hs.event_id=s.event_id
     WHERE j.id=$1`, [jobId]);
  if (!job) return { outcome: 'skip', reason: 'job not found' };
  if (!['queued', 'retry'].includes(job.status)) return { outcome: 'skip', reason: `job is ${job.status}` };
  if (['superseded', 'rejected', 'scored'].includes(job.sub_status)) {
    await ctx.db.query(`UPDATE evaluation_jobs SET status='cancelled', finished_at=now() WHERE id=$1 AND status IN ('queued','retry')`, [jobId]);
    return { outcome: 'skip', reason: `submission is ${job.sub_status}` };
  }
  if (!job.locked_model) return { outcome: 'retry', delaySec: 30, error: 'round judge not locked yet' };

  // configurable concurrency (app-level, on top of the queue's max_concurrency)
  const [{ running }] = await ctx.db.query<{ running: number }>(
    `SELECT count(*)::int AS running FROM evaluation_jobs j JOIN submissions s ON s.id=j.submission_id
     WHERE s.event_id=$1 AND j.status='running' AND j.lease_until > now()`, [job.event_id]);
  if (running >= job.eval_concurrency) return { outcome: 'retry', delaySec: 8 + Math.floor(Math.random() * 6) };

  // hard AI budget — pause instead of spending past the free allocation
  const budget = await aiBudgetAvailable(ctx, job.event_id, job.locked_model, job.locked_provider);
  if (!budget.ok) {
    await ctx.db.batch([
      { text: `UPDATE evaluation_jobs SET status='paused_quota', last_error='AI daily budget reached' WHERE id=$1 AND status IN ('queued','retry')`, params: [jobId] },
      { text: `UPDATE submissions SET status='paused_quota' WHERE id=$1 AND status IN ('queued','evaluating')`, params: [job.submission_id] },
      { text: `UPDATE events SET state_version=state_version+1 WHERE id=$1`, params: [job.event_id] },
    ]);
    return { outcome: 'paused', reason: `AI budget ${budget.used.toFixed(0)}/${budget.cap} neurons used today` };
  }

  // claim (idempotency gate)
  const claimed = await ctx.db.query<{ attempts: number }>(
    `UPDATE evaluation_jobs SET status='running', attempts=attempts+1, lease_until=now()+interval '3 minutes'
     WHERE id=$1 AND status IN ('queued','retry') RETURNING attempts`, [jobId]);
  if (!claimed.length) return { outcome: 'skip', reason: 'already claimed' };
  const attempt = claimed[0].attempts;
  await ctx.db.query(`UPDATE submissions SET status='evaluating' WHERE id=$1 AND status IN ('queued','paused_quota','failed')`, [job.submission_id]);

  try {
    const provider = ctx.providers(job.locked_provider, job.locked_model);
    const result = await judgeSubmission({
      provider,
      images: ctx.images,
      composite: ctx.composite,
      judgeImageId: job.judge_image_id,
      round: {
        round_no: job.round_no,
        locked_mode: job.locked_mode,
        reference_judge_image_id: job.reference_judge_image_id,
        reference_description: job.reference_description,
        concepts: Array.isArray(job.concepts) ? job.concepts : JSON.parse(job.concepts ?? '[]'),
      },
    });
    const flags: string[] = [...(job.flags ?? [])];
    if (result.embeddedInstructions && !flags.includes('embedded_text')) flags.push('embedded_text');
    const review = flags.some((f) => ['duplicate_exact', 'embedded_text', 'reference_copy'].includes(f));
    await ctx.db.batch([
      { text: `INSERT INTO evaluation_results(submission_id,job_id,provider,model,mode,criteria,total,feedback,raw_response,
                 input_tokens,output_tokens,neurons_est,latency_ms,is_published)
               SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,true
               WHERE NOT EXISTS (SELECT 1 FROM submissions WHERE id=$1 AND 'host_scored' = ANY(flags)) -- host's score wins
               ON CONFLICT DO NOTHING`,
        params: [job.submission_id, jobId, provider.id, provider.model, result.mode, JSON.stringify(result.criteria), result.total,
          result.feedback, result.rawText, result.inputTokens, result.outputTokens, result.neurons, result.latencyMs] },
      { text: `UPDATE submissions s SET status=$3, flags=$4, score_total=er.total, scored_at=now()
               FROM evaluation_results er
               WHERE s.id=$1 AND er.job_id=$2 AND er.is_published AND s.status IN ('evaluating','queued','paused_quota','failed')`,
        params: [job.submission_id, jobId, review ? 'needs_review' : 'scored', flags] },
      { text: `UPDATE evaluation_jobs SET status='done', finished_at=now(), lease_until=NULL, last_error=NULL WHERE id=$1`, params: [jobId] },
    ]);
    await addUsage(ctx.db, 'ai_neurons', result.neurons);
    await addUsage(ctx.db, 'ai_calls', 1);
    await refreshLeaderboard(ctx, job.event_id);
    return { outcome: 'done' };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    if (err instanceof AiQuotaError) {
      await ctx.db.batch([
        { text: `UPDATE evaluation_jobs SET status='paused_quota', attempts=greatest(attempts-1,0), lease_until=NULL, last_error=$2 WHERE id=$1`, params: [jobId, msg] },
        { text: `UPDATE submissions SET status='paused_quota' WHERE id=$1 AND status='evaluating'`, params: [job.submission_id] },
        { text: `INSERT INTO audit_logs(event_id,actor,action,detail) VALUES($1,'system','ai_quota_exhausted',$2::jsonb)`, params: [job.event_id, JSON.stringify({ jobId, msg })] },
      ]);
      await bumpVersion(ctx, job.event_id);
      return { outcome: 'paused', reason: msg };
    }
    await addUsage(ctx.db, 'ai_failures', 1);
    if (attempt >= job.max_attempts) {
      await ctx.db.batch([
        { text: `UPDATE evaluation_jobs SET status='failed', finished_at=now(), lease_until=NULL, last_error=$2 WHERE id=$1`, params: [jobId, msg] },
        { text: `UPDATE submissions SET status='failed' WHERE id=$1 AND status='evaluating'`, params: [job.submission_id] },
        { text: `INSERT INTO audit_logs(event_id,actor,action,detail) VALUES($1,'system','evaluation_failed',$2::jsonb)`, params: [job.event_id, JSON.stringify({ jobId, attempt, msg })] },
        { text: `UPDATE events SET state_version=state_version+1 WHERE id=$1`, params: [job.event_id] },
      ]);
      return { outcome: 'failed', error: msg };
    }
    const delay = backoffSeconds(attempt);
    await ctx.db.batch([
      { text: `UPDATE evaluation_jobs SET status='retry', lease_until=NULL, last_error=$2,
                 next_attempt_at=now()+make_interval(secs => $3), last_enqueued_at=now() WHERE id=$1`, params: [jobId, msg, delay] },
      { text: `UPDATE submissions SET status='queued' WHERE id=$1 AND status='evaluating'`, params: [job.submission_id] },
    ]);
    return { outcome: 'retry', delaySec: delay, error: msg };
  }
}

/** Cron safety net (every minute): close expired rounds, recover lost/stuck jobs, resume paused ones. */
export async function reconcile(ctx: AppContext): Promise<{ closed: number; requeued: number; resumed: number; recovered: number }> {
  const closed = await ctx.db.query(
    `UPDATE events e SET phase = CASE e.phase WHEN 'r1_open' THEN 'r1_judging' ELSE 'r2_judging' END,
            phase_changed_at=now(), state_version=e.state_version+1
     FROM round_configs r
     WHERE e.phase IN ('r1_open','r2_open')
       AND r.id = (SELECT ct.id FROM round_configs ct WHERE ct.event_id=e.id AND ct.spin_at IS NOT NULL ORDER BY ct.spin_at DESC LIMIT 1)
       AND r.deadline_at < now() - interval '5 seconds'
     RETURNING e.id`);

  const recovered = await ctx.db.query(
    `UPDATE evaluation_jobs SET status='retry', lease_until=NULL, last_error='lease expired (worker lost)', next_attempt_at=now(), last_enqueued_at=NULL
     WHERE status='running' AND lease_until < now() RETURNING id`);
  await ctx.db.query(
    `UPDATE submissions s SET status='queued' FROM evaluation_jobs j
     WHERE j.submission_id=s.id AND j.id = ANY($1::uuid[]) AND s.status='evaluating'`, [recovered.map((r: any) => r.id)]);

  // resume paused jobs only if the budget allows (checked per event/model)
  let resumed = 0;
  const paused = await ctx.db.query<any>(
    `SELECT s.event_id, r.locked_model, r.locked_provider, count(*)::int AS n
     FROM evaluation_jobs j JOIN submissions s ON s.id=j.submission_id JOIN round_configs r ON r.id=s.round_id
     WHERE j.status='paused_quota' GROUP BY 1,2,3`);
  for (const p of paused) {
    const b = await aiBudgetAvailable(ctx, p.event_id, p.locked_model, p.locked_provider);
    if (!b.ok) continue;
    const allow = Math.max(1, Math.floor((b.cap - b.used) / Math.max(b.next, 1)));
    const rows = await ctx.db.query(
      `UPDATE evaluation_jobs SET status='queued', next_attempt_at=now(), last_enqueued_at=NULL
       WHERE id IN (SELECT j.id FROM evaluation_jobs j JOIN submissions s ON s.id=j.submission_id
                    WHERE j.status='paused_quota' AND s.event_id=$1 ORDER BY j.created_at LIMIT $2) RETURNING id`, [p.event_id, allow]);
    resumed += rows.length;
  }

  const due = await ctx.db.query<{ id: string; submission_id: string }>(
    `UPDATE evaluation_jobs SET last_enqueued_at=now()
     WHERE id IN (SELECT id FROM evaluation_jobs
                  WHERE status IN ('queued','retry') AND next_attempt_at <= now()
                    AND (last_enqueued_at IS NULL OR last_enqueued_at < now() - interval '90 seconds')
                  ORDER BY next_attempt_at LIMIT 100)
     RETURNING id, submission_id`);
  if (due.length) await ctx.queue.sendBatch(due.map((d) => ({ jobId: d.id, submissionId: d.submission_id })));
  return { closed: closed.length, requeued: due.length, resumed, recovered: recovered.length };
}

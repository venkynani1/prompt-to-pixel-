import { describeReference, resolveR1Mode } from './ai/judge';
import type { AppContext } from './context';
import { hammingHex } from './crypto';
import { bumpVersion, refreshLeaderboard } from './evaluation';
import { QuotaError, type ContentType } from './storage';
import { addUsage } from './usage';
import { PHASE_ORDER, phaseRound, type Phase } from '../shared/types';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function audit(ctx: AppContext, eventId: string | null, actor: string, action: string, detail: object = {}) {
  await ctx.db.query(`INSERT INTO audit_logs(event_id,actor,action,detail) VALUES($1,$2,$3,$4::jsonb)`,
    [eventId, actor, action, JSON.stringify(detail)]);
}

export function canTransition(from: Phase, to: Phase): boolean {
  if (to === 'closed') return true;
  const a = PHASE_ORDER.indexOf(from), b = PHASE_ORDER.indexOf(to);
  if (a < 0 || b < 0) return false;
  return b === a + 1 || b === a - 1;
}

export async function setPhase(ctx: AppContext, event: { id: string; phase: Phase }, to: Phase, actor = 'host') {
  if (!canTransition(event.phase, to)) throw new HttpError(409, `Cannot move from ${event.phase} to ${to}`);
  const rn = phaseRound(to);
  if ((to === 'r1_open' || to === 'r2_open') && rn) {
    const [round] = await ctx.db.query<any>(`SELECT * FROM round_configs WHERE event_id=$1 AND round_no=$2`, [event.id, rn]);
    if (!round) throw new HttpError(409, 'Round is not configured');
    if (rn === 1 && !round.reference_image_id) throw new HttpError(409, 'Upload the Round 1 reference image first');
    if (rn === 2 && (!Array.isArray(round.concepts) || round.concepts.length !== 3 || round.concepts.some((c: string) => !c?.trim())))
      throw new HttpError(409, 'Round 2 needs exactly three crossover concepts');
    const [s] = await ctx.db.query<any>(`SELECT * FROM host_settings WHERE event_id=$1`, [event.id]);
    // Lock the judge the first time the round opens. Re-opening keeps the original lock.
    if (!round.locked_at) {
      const mode = rn === 1 ? resolveR1Mode(s.r1_mode, s.judge_model, ctx.capabilities.imagesBinding) : 'single';
      if (rn === 1 && mode === 'composite' && !ctx.capabilities.imagesBinding)
        throw new HttpError(409, 'Composite mode needs the Cloudflare Images binding — pick another Round 1 mode');
      if (rn === 1 && mode === 'reference-description' && !round.reference_description)
        throw new HttpError(409, 'This judge model needs a reference description. Generate it in Round 1 settings first.');
      await ctx.db.query(
        `UPDATE round_configs SET locked_provider=$2, locked_model=$3, locked_mode=$4, locked_at=now() WHERE id=$1`,
        [round.id, s.judge_provider, s.judge_model, mode]);
      await audit(ctx, event.id, actor, 'judge_locked', { round: rn, provider: s.judge_provider, model: s.judge_model, mode });
    }
    await ctx.db.query(
      `UPDATE round_configs SET opens_at=now(), deadline_at=now()+make_interval(secs => duration_sec) WHERE id=$1`, [round.id]);
  }
  if ((to === 'r1_judging' || to === 'r2_judging') && event.phase.endsWith('_open')) {
    await ctx.db.query(`UPDATE round_configs SET deadline_at=least(deadline_at, now()) WHERE event_id=$1 AND round_no=$2`, [event.id, rn]);
  }
  const updated = await ctx.db.query(
    `UPDATE events SET phase=$2, phase_changed_at=now(), state_version=state_version+1 WHERE id=$1 AND phase=$3 RETURNING id`,
    [event.id, to, event.phase]);
  if (!updated.length) throw new HttpError(409, 'Phase changed concurrently — refresh');
  if (to.endsWith('_results') || to === 'final') await refreshLeaderboard(ctx, event.id);
  await audit(ctx, event.id, actor, 'phase', { from: event.phase, to });
}

/** Lazily close a round whose server deadline has passed (cron does the same every minute). */
export async function autoClose(ctx: AppContext, eventId: string) {
  await ctx.db.query(
    `UPDATE events e SET phase = CASE e.phase WHEN 'r1_open' THEN 'r1_judging' ELSE 'r2_judging' END,
            phase_changed_at=now(), state_version=e.state_version+1
     FROM round_configs r
     WHERE e.id=$1 AND r.event_id=e.id AND e.phase IN ('r1_open','r2_open')
       AND r.round_no = CASE e.phase WHEN 'r1_open' THEN 1 ELSE 2 END
       AND r.deadline_at < now() - interval '5 seconds'`, [eventId]);
}

export interface SubmissionFiles {
  full: { bytes: Uint8Array; type: ContentType; width?: number; height?: number };
  judge: { bytes: Uint8Array; type: ContentType };
  thumb: { bytes: Uint8Array; type: ContentType };
  dhash?: string;
  prompt?: string;
}

export async function createSubmission(ctx: AppContext, eventId: string, teamId: string, files: SubmissionFiles) {
  const [ev] = await ctx.db.query<any>(
    `SELECT e.phase, r.id AS round_id, r.round_no, r.deadline_at, r.reference_image_id, r.reference_dhash,
            (r.deadline_at + interval '5 seconds' > now()) AS in_time,
            ri.sha256 AS reference_sha, hs.max_upload_bytes, hs.max_submissions_per_round, hs.storage_byte_cap, hs.bytea_byte_cap
     FROM events e
     JOIN round_configs r ON r.event_id=e.id AND r.round_no = CASE e.phase WHEN 'r1_open' THEN 1 WHEN 'r2_open' THEN 2 END
     JOIN host_settings hs ON hs.event_id=e.id
     LEFT JOIN images ri ON ri.id=r.reference_image_id
     WHERE e.id=$1`, [eventId]);
  if (!ev) throw new HttpError(409, 'No round is accepting submissions right now');
  if (!ev.in_time) { await autoClose(ctx, eventId); throw new HttpError(409, 'Time is up — submissions are closed'); }
  if (files.full.bytes.length > ev.max_upload_bytes) throw new HttpError(413, `Image too large (max ${Math.round(ev.max_upload_bytes / 1000)} KB after compression)`);
  if (files.judge.bytes.length > 250_000 || files.thumb.bytes.length > 120_000) throw new HttpError(413, 'Preview images too large');
  if (files.prompt && files.prompt.length > 2000) throw new HttpError(400, 'Prompt text too long');

  const [{ n }] = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM submissions WHERE round_id=$1 AND team_id=$2`, [ev.round_id, teamId]);
  if (n >= ev.max_submissions_per_round) throw new HttpError(429, `Submission limit reached (${ev.max_submissions_per_round} per round)`);

  const caps = { storageByteCap: Number(ev.storage_byte_cap), byteaByteCap: Number(ev.bytea_byte_cap) };
  let full, judge, thumb;
  try {
    full = await ctx.images.put({ eventId, kind: 'submission', bytes: files.full.bytes, contentType: files.full.type, width: files.full.width, height: files.full.height }, caps);
    judge = await ctx.images.put({ eventId, kind: 'judge', bytes: files.judge.bytes, contentType: files.judge.type }, caps);
    thumb = await ctx.images.put({ eventId, kind: 'thumb', bytes: files.thumb.bytes, contentType: files.thumb.type }, caps);
  } catch (e) {
    if (e instanceof QuotaError) throw new HttpError(507, 'Storage budget reached — tell the host');
    throw e;
  }
  await addUsage(ctx.db, 'uploads', 1);
  await addUsage(ctx.db, 'upload_bytes', files.full.bytes.length + files.judge.bytes.length + files.thumb.bytes.length);

  // ── duplicate / copy detection ──
  const flags: string[] = [];
  const dh = files.dhash && /^[0-9a-f]{16}$/.test(files.dhash) ? files.dhash : null;
  if (ev.round_no === 1 && (full.sha256 === ev.reference_sha || (dh && ev.reference_dhash && hammingHex(dh, ev.reference_dhash) <= 5)))
    flags.push('reference_copy');
  const others = await ctx.db.query<{ sha256: string; dhash: string | null }>(
    `SELECT i.sha256, s.dhash FROM submissions s JOIN images i ON i.id=s.image_id
     WHERE s.round_id=$1 AND s.team_id<>$2 AND s.status<>'superseded'`, [ev.round_id, teamId]);
  if (others.some((o) => o.sha256 === full.sha256)) flags.push('duplicate_exact');
  else if (dh && others.some((o) => o.dhash && hammingHex(dh, o.dhash) <= 4)) flags.push('near_duplicate');

  // A copy of the reference is not worth an AI call — hold it for the host.
  const skipAi = flags.includes('reference_copy');
  const submissionId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const stmts = [
    { text: `UPDATE evaluation_jobs SET status='cancelled', finished_at=now()
             WHERE status IN ('queued','retry','paused_quota') AND submission_id IN
               (SELECT id FROM submissions WHERE round_id=$1 AND team_id=$2 AND status<>'superseded')`, params: [ev.round_id, teamId] },
    { text: `UPDATE submissions SET status='superseded' WHERE round_id=$1 AND team_id=$2 AND status<>'superseded'`, params: [ev.round_id, teamId] },
    { text: `INSERT INTO submissions(id,event_id,round_id,team_id,image_id,judge_image_id,thumb_image_id,prompt_text,dhash,status,flags)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      params: [submissionId, eventId, ev.round_id, teamId, full.id, judge.id, thumb.id, files.prompt?.trim() || null, dh,
        skipAi ? 'needs_review' : 'queued', flags] },
    { text: `UPDATE events SET state_version=state_version+1 WHERE id=$1`, params: [eventId] },
  ];
  // transactional job creation: the job row commits atomically with the submission
  if (!skipAi) stmts.splice(3, 0, { text: `INSERT INTO evaluation_jobs(id,submission_id,last_enqueued_at) VALUES($1,$2,now())`, params: [jobId, submissionId] });
  await ctx.db.batch(stmts);
  if (n > 0) await refreshLeaderboard(ctx, eventId); // a replaced, already-scored entry must leave the board

  if (!skipAi) {
    try { await ctx.queue.send({ jobId, submissionId }); }
    catch { await ctx.db.query(`UPDATE evaluation_jobs SET last_enqueued_at=NULL WHERE id=$1`, [jobId]); } // cron will pick it up
  }
  return { submissionId, flags, status: skipAi ? 'needs_review' : 'queued' };
}

export async function requeueSubmission(ctx: AppContext, eventId: string, submissionId: string) {
  const [sub] = await ctx.db.query<any>(`SELECT id,status FROM submissions WHERE id=$1 AND event_id=$2`, [submissionId, eventId]);
  if (!sub) throw new HttpError(404, 'Submission not found');
  if (['superseded', 'rejected'].includes(sub.status)) throw new HttpError(409, `Submission is ${sub.status}`);
  const active = await ctx.db.query(`SELECT id FROM evaluation_jobs WHERE submission_id=$1 AND status IN ('queued','running','retry','paused_quota')`, [submissionId]);
  if (active.length) {
    await ctx.db.query(`UPDATE evaluation_jobs SET status='queued', next_attempt_at=now(), last_enqueued_at=NULL WHERE id=$1 AND status IN ('retry','paused_quota')`, [(active[0] as any).id]);
  } else {
    const jobId = crypto.randomUUID();
    await ctx.db.batch([
      { text: `UPDATE evaluation_results SET is_published=false WHERE submission_id=$1`, params: [submissionId] },
      { text: `UPDATE submissions SET status='queued', score_total=NULL, scored_at=NULL WHERE id=$1`, params: [submissionId] },
      { text: `INSERT INTO evaluation_jobs(id,submission_id,last_enqueued_at) VALUES($1,$2,now())`, params: [jobId, submissionId] },
    ]);
    try { await ctx.queue.send({ jobId, submissionId }); } catch { /* cron recovers */ }
  }
  await refreshLeaderboard(ctx, eventId);
}

/** Explicit, audited re-judge of a whole round with a new provider/model. Never automatic. */
export async function rejudgeRound(ctx: AppContext, eventId: string, roundNo: 1 | 2, provider: string, model: string, mode: string) {
  const [round] = await ctx.db.query<any>(`SELECT id FROM round_configs WHERE event_id=$1 AND round_no=$2`, [eventId, roundNo]);
  if (!round) throw new HttpError(404, 'Round not found');
  await ctx.db.batch([
    { text: `UPDATE round_configs SET locked_provider=$2, locked_model=$3, locked_mode=$4, locked_at=now() WHERE id=$1`, params: [round.id, provider, model, mode] },
    { text: `UPDATE evaluation_jobs SET status='cancelled', finished_at=now() WHERE status IN ('queued','retry','paused_quota','running')
             AND submission_id IN (SELECT id FROM submissions WHERE round_id=$1)`, params: [round.id] },
    { text: `UPDATE evaluation_results SET is_published=false WHERE submission_id IN (SELECT id FROM submissions WHERE round_id=$1)`, params: [round.id] },
    { text: `UPDATE submissions SET status='queued', score_total=NULL, scored_at=NULL
             WHERE round_id=$1 AND status NOT IN ('superseded','rejected') AND NOT ('reference_copy' = ANY(flags))`, params: [round.id] },
    { text: `INSERT INTO evaluation_jobs(submission_id,last_enqueued_at) SELECT id, now() FROM submissions WHERE round_id=$1 AND status='queued'`, params: [round.id] },
  ]);
  const jobs = await ctx.db.query<{ id: string; submission_id: string }>(
    `SELECT j.id, j.submission_id FROM evaluation_jobs j JOIN submissions s ON s.id=j.submission_id WHERE s.round_id=$1 AND j.status='queued'`, [round.id]);
  try { if (jobs.length) await ctx.queue.sendBatch(jobs.map((j) => ({ jobId: j.id, submissionId: j.submission_id }))); }
  catch { await ctx.db.query(`UPDATE evaluation_jobs SET last_enqueued_at=NULL WHERE id = ANY($1::uuid[])`, [jobs.map((j) => j.id)]); }
  await audit(ctx, eventId, 'host', 'rejudge_round', { roundNo, provider, model, mode });
  await refreshLeaderboard(ctx, eventId);
}

export async function generateReferenceDescription(ctx: AppContext, eventId: string) {
  const [r] = await ctx.db.query<any>(
    `SELECT r.id, r.reference_judge_image_id, coalesce(r.locked_provider, hs.judge_provider) AS provider, coalesce(r.locked_model, hs.judge_model) AS model
     FROM round_configs r JOIN host_settings hs ON hs.event_id=r.event_id WHERE r.event_id=$1 AND r.round_no=1`, [eventId]);
  if (!r?.reference_judge_image_id) throw new HttpError(409, 'Upload the reference image first');
  const ref = await ctx.images.get(r.reference_judge_image_id);
  if (!ref) throw new HttpError(409, 'Reference image missing');
  const out = await describeReference(ctx.providers(r.provider, r.model), ref);
  await addUsage(ctx.db, 'ai_neurons', out.neurons);
  await addUsage(ctx.db, 'ai_calls', 1);
  await ctx.db.query(`UPDATE round_configs SET reference_description=$2 WHERE id=$1`, [r.id, out.text]);
  await audit(ctx, eventId, 'host', 'reference_described', { model: r.model, neurons: out.neurons });
  return out.text;
}

export { bumpVersion };

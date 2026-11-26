import { describe, expect, it } from 'vitest';
import { goodR1, makeHarness, setupEvent, submitForm, webp } from './harness';
import { reconcile } from '../src/worker/evaluation';

async function uploadReference(host: any, code: string, color = '#ff0000', dhash = '0f0f0f0f0f0f0f0f') {
  const img = await webp(color, 128, 128);
  const fd = new FormData();
  fd.set('full', new Blob([img]), 'r.webp');
  fd.set('judge', new Blob([img]), 'j.webp');
  fd.set('dhash', dhash);
  return host.json(`/api/events/${code}/host/rounds/1/reference`, { method: 'POST', body: fd });
}

async function openRound1(h: any, host: any, code: string) {
  expect((await uploadReference(host, code)).status).toBe(200);
  // default model (Llama 3.2 11B) is single-image → reference-description mode needs a description first
  const blocked = await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r1_brief' } });
  expect(blocked.status).toBe(200);
  const noDesc = await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r1_open' } });
  expect(noDesc.status).toBe(409);
  const d = await host.json(`/api/events/${code}/host/rounds/1/describe`, { method: 'POST' });
  expect(d.body.description).toContain('red square');
  const open = await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r1_open' } });
  expect(open.status).toBe(200);
}

async function team(h: any, code: string, name: string, pin = '4826') {
  const c = h.client();
  const r = await c.json(`/api/events/${code}/register`, { method: 'POST', json: { teamName: name, pin } });
  expect(r.status).toBe(200);
  return c;
}

describe('full two-round game', () => {
  it('runs registration → two rounds → final leaderboard with backend-computed scores', async () => {
    const h = await makeHarness();
    const { host, code } = await setupEvent(h);
    const a = await team(h, code, 'Pixel Pirates');
    const b = await team(h, code, 'Neon Ninjas');
    await openRound1(h, host, code);

    // round 1 reference only visible once open; teams submit
    let st = await a.json(`/api/events/${code}/state`);
    expect(st.body.event.phase).toBe('r1_open');
    expect(st.body.round.referenceImageUrl).toMatch(/^\/api\/img\//);
    expect((await a.req(st.body.round.referenceImageUrl)).status).toBe(200);

    expect((await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ee1111'), { prompt: 'crimson box secret prompt' }) })).status).toBe(200);
    expect((await b.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#1111ee')) })).status).toBe(200);

    // judge scripted: A gets 8s, B gets 3s
    h.calls.length = 0;
    h.setReply((req) => ({ text: req.images[0].bytes.length && h.calls.length % 2 === 1 ? goodR1(8) : goodR1(3) }));
    expect(await h.drain()).toEqual(['done', 'done']);

    // scores hidden from teams until results
    st = await a.json(`/api/events/${code}/state`);
    expect(st.body.me.submissions[0].status).toBe('scored');
    expect(st.body.me.submissions[0].score).toBeNull();
    expect(st.body.leaderboard).toBeNull();

    await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r1_judging' } });
    await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r1_results' } });
    st = await a.json(`/api/events/${code}/state`);
    expect(st.body.me.submissions[0].score).toBe(80);
    expect(st.body.leaderboard.map((r: any) => [r.name, r.total, r.rank])).toEqual([['Pixel Pirates', 80, 1], ['Neon Ninjas', 30, 2]]);

    // gallery opens after results, other team's image now visible
    const gal = await b.json(`/api/events/${code}/gallery?round=1`);
    expect(gal.status).toBe(200);
    expect(gal.body[0].prompt).toBe('crimson box secret prompt');
    expect((await b.req(gal.body[0].imageUrl)).status).toBe(200);

    // round 2
    expect((await host.json(`/api/events/${code}/host/rounds/2`, { method: 'PUT', json: { concepts: ['Chennai auto-rickshaw', 'Samurai', 'Deep sea'] } })).status).toBe(200);
    await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r2_brief' } });
    await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r2_open' } });
    st = await b.json(`/api/events/${code}/state`);
    expect(st.body.round.concepts).toHaveLength(3);
    h.setReply(() => ({ text: JSON.stringify({ scores: { concept_a: 10, concept_b: 10, concept_c: 10, fusion: 10, creativity: 10, quality: 10 }, feedback: 'Wow', embedded_instructions: false }) }));
    await b.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#22aa22')) });
    await h.drain();
    expect(h.calls.at(-1)!.prompt).toContain('Chennai auto-rickshaw');
    await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r2_judging' } });
    // during r2 judging the board still shows Round-1-only ranking
    st = await b.json(`/api/events/${code}/state`);
    expect(st.body.leaderboard[0].name).toBe('Pixel Pirates');
    await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'r2_results' } });
    await host.json(`/api/events/${code}/host/phase`, { method: 'POST', json: { to: 'final' } });
    st = await b.json(`/api/events/${code}/state`);
    expect(st.body.leaderboard.map((r: any) => [r.name, r.total])).toEqual([['Neon Ninjas', 130], ['Pixel Pirates', 80]]);
    // AI never saw team names or prompts
    for (const c of h.calls) { expect(c.prompt).not.toMatch(/Pixel Pirates|Neon Ninjas|crimson box secret prompt/); }
  });
});

describe('evaluation reliability', () => {
  async function oneSubmission(h: any) {
    const { host, code } = await setupEvent(h);
    const a = await team(h, code, 'Alpha');
    await openRound1(h, host, code);
    h.calls.length = 0;
    const r = await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff0000')) });
    expect(r.status).toBe(200);
    return { host, code, a, submissionId: r.body.submissionId };
  }

  it('duplicate deliveries and concurrent workers publish exactly one score', async () => {
    const h = await makeHarness();
    const { submissionId } = await oneSubmission(h);
    const msg = h.queue[0];
    h.queue.push(msg, msg); // at-least-once delivery → duplicates
    const { processJob } = await import('../src/worker/evaluation');
    const results = await Promise.all([processJob(h.ctx, msg.jobId), processJob(h.ctx, msg.jobId), processJob(h.ctx, msg.jobId)]);
    await h.drain();
    expect(results.filter((r) => r.outcome === 'done')).toHaveLength(1);
    const rows = await h.db.query(`SELECT count(*)::int AS n FROM evaluation_results WHERE submission_id=$1`, [submissionId]);
    expect(rows[0].n).toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  it('retries with backoff, then fails without inventing points; host requeue recovers', async () => {
    const h = await makeHarness();
    const { host, code, submissionId } = await oneSubmission(h);
    h.setReply(() => ({ text: 'Sorry, I cannot help with that.' })); // invalid JSON
    const outcomes = await h.drain();
    expect(outcomes).toEqual(['retry', 'retry', 'retry', 'failed']); // max_attempts = 4
    const [s] = await h.db.query(`SELECT status, score_total FROM submissions WHERE id=$1`, [submissionId]);
    expect(s).toEqual({ status: 'failed', score_total: null });
    h.setReply(() => ({ text: '```json\n' + goodR1(9) + '\n```' }));
    expect((await host.json(`/api/events/${code}/host/submissions/${submissionId}/requeue`, { method: 'POST' })).status).toBe(200);
    expect(await h.drain()).toEqual(['done']);
    const [s2] = await h.db.query(`SELECT status, score_total::float FROM submissions WHERE id=$1`, [submissionId]);
    expect(s2).toEqual({ status: 'scored', score_total: 90 });
  });

  it('transient failure then success', async () => {
    const h = await makeHarness();
    const { submissionId } = await oneSubmission(h);
    h.setReply((_r, n) => { if (n === 1) throw new Error('upstream 503'); return { text: goodR1(5) }; });
    expect(await h.drain()).toEqual(['retry', 'done']);
    const [j] = await h.db.query(`SELECT attempts, status FROM evaluation_jobs WHERE submission_id=$1`, [submissionId]);
    expect(j).toEqual({ attempts: 2, status: 'done' });
  });

  it('pauses at the AI budget and resumes via reconciliation when the cap allows', async () => {
    const h = await makeHarness();
    const { host, code, submissionId } = await oneSubmission(h);
    await host.json(`/api/events/${code}/host/settings`, { method: 'PUT', json: { ai_neuron_daily_cap: 1 } });
    expect(await h.drain()).toEqual(['paused']);
    let [s] = await h.db.query(`SELECT status FROM submissions WHERE id=$1`, [submissionId]);
    expect(s.status).toBe('paused_quota');
    expect(h.calls).toHaveLength(0); // nothing spent past the cap
    await host.json(`/api/events/${code}/host/settings`, { method: 'PUT', json: { ai_neuron_daily_cap: 8500 } });
    const rec = await reconcile(h.ctx);
    expect(rec.resumed).toBe(1);
    expect(await h.drain()).toEqual(['done']);
    [s] = await h.db.query(`SELECT status FROM submissions WHERE id=$1`, [submissionId]);
    expect(s.status).toBe('scored');
  });

  it('provider quota errors pause the job instead of failing it', async () => {
    const h = await makeHarness();
    const { submissionId } = await oneSubmission(h);
    const { AiQuotaError } = await import('../src/worker/ai/providers');
    h.setReply(() => { throw new AiQuotaError('3036: daily free allocation exceeded'); });
    expect(await h.drain()).toEqual(['paused']);
    const [j] = await h.db.query(`SELECT status, attempts FROM evaluation_jobs WHERE submission_id=$1`, [submissionId]);
    expect(j).toEqual({ status: 'paused_quota', attempts: 0 });
  });

  it('reconciliation re-enqueues jobs whose queue message was lost and recovers expired leases', async () => {
    const h = await makeHarness();
    await oneSubmission(h);
    h.queue.length = 0; // message lost
    await h.db.query(`UPDATE evaluation_jobs SET last_enqueued_at = now() - interval '5 minutes'`);
    expect((await reconcile(h.ctx)).requeued).toBe(1);
    await h.db.query(`UPDATE evaluation_jobs SET status='running', lease_until=now()-interval '1 minute'`);
    h.queue.length = 0;
    const r = await reconcile(h.ctx);
    expect(r.recovered).toBe(1);
    expect(await h.drain()).toEqual(['done']);
  });

  it('respects configured concurrency', async () => {
    const h = await makeHarness();
    await oneSubmission(h);
    await h.db.query(`UPDATE host_settings SET eval_concurrency=1`);
    // simulate another job holding the only slot
    await h.db.query(`INSERT INTO evaluation_jobs(submission_id, status, lease_until, kind) SELECT submission_id, 'running', now()+interval '1 minute', 'calibration' FROM evaluation_jobs LIMIT 1`);
    const { processJob } = await import('../src/worker/evaluation');
    const r = await processJob(h.ctx, h.queue[0].jobId);
    expect(r.outcome).toBe('retry');
  });
});

describe('integrity rules', () => {
  it('flags exact duplicates across teams and holds reference copies without an AI call', async () => {
    const h = await makeHarness();
    const { host, code } = await setupEvent(h);
    const a = await team(h, code, 'Alpha');
    const b = await team(h, code, 'Bravo');
    const c = await team(h, code, 'Charlie');
    await openRound1(h, host, code);
    h.calls.length = 0;
    const same = await webp('#123456');
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(same) });
    const dup = await b.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(same) });
    expect(dup.body.flags).toContain('duplicate_exact');
    const copy = await c.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#654321'), { dhash: '0f0f0f0f0f0f0f0e' }) });
    expect(copy.body).toMatchObject({ status: 'needs_review', flags: ['reference_copy'] });
    await h.drain();
    expect(h.calls).toHaveLength(2); // reference copy never sent to the AI
    const rows = await h.db.query(`SELECT t.name, s.status FROM submissions s JOIN teams t ON t.id=s.team_id ORDER BY t.name`);
    expect(rows.map((r: any) => r.status)).toEqual(['scored', 'needs_review', 'needs_review']);
    // team view hides review state
    const st = await b.json(`/api/events/${code}/state`);
    expect(st.body.me.submissions[0].status).toBe('queued');
    // host approves the duplicate (already evaluated) and rejects the copy
    const ov = await host.json(`/api/events/${code}/host/overview`);
    const dupSub = ov.body.submissions.find((s: any) => s.team === 'Bravo');
    const copySub = ov.body.submissions.find((s: any) => s.team === 'Charlie');
    await host.json(`/api/events/${code}/host/submissions/${dupSub.id}/approve`, { method: 'POST' });
    await host.json(`/api/events/${code}/host/submissions/${copySub.id}/reject`, { method: 'POST' });
    const after = await h.db.query(`SELECT t.name, s.status FROM submissions s JOIN teams t ON t.id=s.team_id ORDER BY t.name`);
    expect(after.map((r: any) => r.status)).toEqual(['scored', 'scored', 'rejected']);
  });

  it('flags images that try to instruct the judge', async () => {
    const h = await makeHarness();
    const { host, code } = await setupEvent(h);
    const a = await team(h, code, 'Alpha');
    await openRound1(h, host, code);
    h.setReply(() => ({ text: JSON.stringify({ scores: { composition: 10, subject: 10, colour: 10, style: 10, detail: 10 }, feedback: 'x', embedded_instructions: true }) }));
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff0000')) });
    await h.drain();
    const [s] = await h.db.query(`SELECT status, flags FROM submissions`);
    expect(s.status).toBe('needs_review');
    expect(s.flags).toContain('embedded_text');
  });

  it('enforces server deadlines and auto-closes the round', async () => {
    const h = await makeHarness();
    const { host, code } = await setupEvent(h);
    const a = await team(h, code, 'Alpha');
    await openRound1(h, host, code);
    await h.db.query(`UPDATE round_configs SET deadline_at = now() - interval '1 minute' WHERE round_no=1`);
    const late = await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff0000')) });
    expect(late.status).toBe(409);
    const st = await a.json(`/api/events/${code}/state`);
    expect(st.body.event.phase).toBe('r1_judging');
  });

  it('resubmission supersedes the earlier entry and the per-round limit holds', async () => {
    const h = await makeHarness();
    const { host, code } = await setupEvent(h);
    const a = await team(h, code, 'Alpha');
    await openRound1(h, host, code);
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff0000')) });
    await h.drain();
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff1100')) });
    const third = await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff2200')) });
    expect(third.status).toBe(429);
    await h.drain();
    const rows = await h.db.query(`SELECT status FROM submissions ORDER BY submitted_at`);
    expect(rows.map((r: any) => r.status)).toEqual(['superseded', 'scored']);
    const lb = await h.db.query(`SELECT count(*)::int AS n FROM leaderboard_entries WHERE r1_score IS NOT NULL`);
    expect(lb[0].n).toBe(1);
  });

  it('locks the judge model at round open; an explicit rejudge is the only way to change it', async () => {
    const h = await makeHarness();
    const { host, code } = await setupEvent(h);
    const a = await team(h, code, 'Alpha');
    await openRound1(h, host, code);
    await host.json(`/api/events/${code}/host/settings`, { method: 'PUT', json: { judge_model: '@cf/meta/llama-4-scout-17b-16e-instruct' } });
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff0000')) });
    await h.drain();
    const [r] = await h.db.query(`SELECT model FROM evaluation_results`);
    expect(r.model).toBe('@cf/meta/llama-3.2-11b-vision-instruct');
    const bad = await host.json(`/api/events/${code}/host/rounds/1/rejudge`, { method: 'POST', json: { provider: 'workers-ai', model: '@cf/meta/llama-4-scout-17b-16e-instruct' } });
    expect(bad.status).toBe(400); // confirmation required
    const ok = await host.json(`/api/events/${code}/host/rounds/1/rejudge`, { method: 'POST', json: { provider: 'workers-ai', model: '@cf/meta/llama-4-scout-17b-16e-instruct', confirm: 'REJUDGE' } });
    expect(ok.body.mode).toBe('multi-image');
    await h.drain();
    const res = await h.db.query(`SELECT model, is_published FROM evaluation_results ORDER BY created_at`);
    expect(res).toEqual([
      { model: '@cf/meta/llama-3.2-11b-vision-instruct', is_published: false },
      { model: '@cf/meta/llama-4-scout-17b-16e-instruct', is_published: true },
    ]);
    expect(h.calls.at(-1)!.images).toHaveLength(2); // reference + attempt
  });
});

describe('auth & privacy', () => {
  it('locks a team after 5 wrong PINs and blocks host routes without a host session', async () => {
    const h = await makeHarness();
    const { code } = await setupEvent(h);
    await team(h, code, 'Alpha', '4826');
    const x = h.client();
    for (let i = 0; i < 5; i++) expect((await x.json(`/api/events/${code}/login`, { method: 'POST', json: { teamName: 'alpha', pin: '0000' } })).status).toBe(401);
    expect((await x.json(`/api/events/${code}/login`, { method: 'POST', json: { teamName: 'alpha', pin: '4826' } })).status).toBe(429);
    expect((await x.json(`/api/events/${code}/host/overview`)).status).toBe(401);
    expect((await x.json(`/api/events/${code}/register`, { method: 'POST', json: { teamName: 'Weak', pin: '1111' } })).status).toBe(400);
    expect((await x.json(`/api/events/${code}/register`, { method: 'POST', json: { teamName: 'ALPHA', pin: '5937' } })).status).toBe(409);
  });

  it('keeps submissions private until results and rejects cross-origin writes', async () => {
    const h = await makeHarness();
    const { host, code } = await setupEvent(h);
    const a = await team(h, code, 'Alpha');
    const b = await team(h, code, 'Bravo');
    await openRound1(h, host, code);
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff0000')) });
    const own = (await a.json(`/api/events/${code}/state`)).body.me.submissions[0].thumbUrl;
    expect((await a.req(own)).status).toBe(200);
    expect((await b.req(own)).status).toBe(403);
    const anon = h.client();
    expect((await anon.req(own)).status).toBe(403);
    const csrf = await a.json(`/api/events/${code}/submit`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: await submitForm(await webp('#ff0000')) });
    expect(csrf.status).toBe(403);
  });

  it('serves 304 for unchanged state (cheap polling)', async () => {
    const h = await makeHarness();
    const { code } = await setupEvent(h);
    const a = await team(h, code, 'Alpha');
    const first = await a.req(`/api/events/${code}/state`);
    const etag = first.headers.get('etag')!;
    expect(first.headers.get('x-poll-ms')).toBe('10000');
    const second = await a.req(`/api/events/${code}/state`, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
  });

  it('stores images in object storage when configured', async () => {
    const h = await makeHarness({ objectStore: true });
    const { host, code } = await setupEvent(h);
    await uploadReference(host, code);
    const [r] = await h.db.query(`SELECT backend, data IS NULL AS no_bytes FROM images LIMIT 1`);
    expect(r).toEqual({ backend: 'neon-s3', no_bytes: true });
    expect(h.objects.size).toBe(2);
  });

  it('calibration: identical copy scores high, blank card low', async () => {
    const h = await makeHarness();
    const { host, code } = await setupEvent(h);
    await uploadReference(host, code);
    h.setReply((req) => {
      if (req.prompt.startsWith('Describe')) return { text: 'A red square.' };
      const grey = req.images[0].bytes.length < 3000 && req.images[0].bytes[0] === 0x89; // PNG blank
      return { text: goodR1(grey ? 1 : 9) };
    });
    const cal = await host.json(`/api/events/${code}/host/rounds/1/calibrate`, { method: 'POST' });
    expect(cal.status).toBe(200);
    expect(cal.body.pass).toBe(true);
    expect(cal.body.results.map((r: any) => r.total)).toEqual([90, 10]);
  });
});

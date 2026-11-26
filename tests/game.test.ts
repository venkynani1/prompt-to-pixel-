import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { goodR1, goodR2, makeHarness, submitForm, webp } from './harness';
import { reconcile } from '../src/worker/evaluation';
import { MASHUP_REELS, ROUND1_SCENES } from '../src/shared/bank';

type H = Awaited<ReturnType<typeof makeHarness>>;

/** Host creates the event from the browser: name + password only. */
async function startShow(h: H, teams = 3) {
  const host = h.client();
  const st = await host.json('/api/host/start', { method: 'POST', json: { name: 'Hexaware Prompt to Pixel', password: 'secret-host', teams } });
  expect(st.status).toBe(200);
  const code = st.body.code as string;
  const ov = await host.json(`/api/events/${code}/host/overview`);
  return { host, code, pins: ov.body.teams.map((t: any) => ({ no: t.team_no, pin: '4826', id: t.id })) };
}

/** Scan → pick a free number → name + own PIN (BID WARS style). */
async function joinAs(h: H, code: string, no: number, pin: string, name?: string) {
  const c = h.client();
  const r = await c.json(`/api/events/${code}/claim`, { method: 'POST', json: { teamNo: no, pin, name: name ?? `Team ${no}` } });
  expect(r.status).toBe(200);
  return c;
}

const act = (host: any, code: string, action: string) => host.json(`/api/events/${code}/host/action`, { method: 'POST', json: { action } });
/** Skip the wheel + preview so uploads are open now. */
const skipPreview = (h: H) => h.db.query(`UPDATE round_configs SET spin_at=now()-interval '30 seconds', preview_from=now()-interval '20 seconds',
  preview_until=now()-interval '1 second', opens_at=now()-interval '1 second' WHERE spin_at IS NOT NULL AND revealed_at IS NULL`);

describe('the show: QR join → spins → auto judging → reveal → final', () => {
  it('runs end to end with summed scores per revealed spin', async () => {
    const h = await makeHarness();
    const { host, code, pins } = await startShow(h, 3);
    expect(pins).toHaveLength(3);
    expect((await h.client().json(`/api/events/${code}/slots`)).body.slots.map((x: any) => x.taken)).toEqual([false, false, false]);

    expect((await h.client().json('/api/host/start', { method: 'POST', json: { name: 'x1', password: 'whatever1' } })).status).toBe(401);
    expect((await h.client().json('/api/host/login', { method: 'POST', json: { password: 'secret-host' } })).status).toBe(200);
    expect((await h.client().json('/api/active')).body.code).toBe(code);

    const a = await joinAs(h, code, 1, pins[0].pin, 'Pixel Pirates');
    const b = await joinAs(h, code, 2, pins[1].pin, 'Neon Ninjas');
    expect((await h.client().json(`/api/events/${code}/claim`, { method: 'POST', json: { teamNo: 1, pin: '5937', name: 'Thieves' } })).status).toBe(409);
    expect((await h.client().json(`/api/events/${code}/claim`, { method: 'POST', json: { teamNo: 3, pin: '1111', name: 'Weak pin' } })).status).toBe(400);
    expect((await h.client().json(`/api/events/${code}/join`, { method: 'POST', json: { teamNo: 3, pin: '4826' } })).status).toBe(409);
    const teammate = h.client();
    expect((await teammate.json(`/api/events/${code}/join`, { method: 'POST', json: { teamNo: 1, pin: pins[0].pin } })).status).toBe(200);
    expect((await teammate.json(`/api/events/${code}/state`)).body.me.name).toBe('Pixel Pirates');
    expect((await h.client().json(`/api/events/${code}/slots`)).body.slots.map((x: any) => [x.no, x.taken, x.name])).toEqual([[1, true, 'Pixel Pirates'], [2, true, 'Neon Ninjas'], [3, false, null]]);
    let st = await h.client().json(`/api/events/${code}/state`);
    expect(st.body.event.teamCount).toBe(2);
    expect(st.body.teams.filter((t: any) => t.joined).map((t: any) => t.name)).toEqual(['Pixel Pirates', 'Neon Ninjas']);

    // ── Round 1, spin 1 ──
    expect((await act(host, code, 'spin1')).status).toBe(200);
    st = await a.json(`/api/events/${code}/state`);
    expect(st.body.event.phase).toBe('r1_open');
    const scene1 = st.body.round.sceneId;
    expect(ROUND1_SCENES.map((s) => s.id)).toContain(scene1);
    expect(new Date(st.body.round.previewUntil) > new Date(st.body.round.previewFrom)).toBe(true);
    expect((await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#e11')) })).status).toBe(409);
    await skipPreview(h);
    h.calls.length = 0;
    h.setReply((_req, n) => ({ text: goodR1(n === 1 ? 8 : 3) }));
    expect((await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#e11'), { prompt: 'crimson box secret prompt' }) })).status).toBe(200);
    expect((await b.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#11e')) })).status).toBe(200);
    expect(await h.drain()).toEqual(['done', 'done']);
    expect(h.calls[0].images).toHaveLength(2); // Llama 4 Scout default: reference + attempt in one request

    st = await a.json(`/api/events/${code}/state`);
    expect(st.body.me.current.status).toBe('scored');
    expect(st.body.me.current.score).toBeNull();
    expect(st.body.leaderboard).toBeNull();

    await act(host, code, 'end');
    expect((await act(host, code, 'reveal')).status).toBe(200);
    st = await a.json(`/api/events/${code}/state`);
    expect(st.body.me.current.score).toBe(80);
    expect(st.body.leaderboard.map((r: any) => [r.name, r.total, r.rank])).toEqual([['Pixel Pirates', 80, 1], ['Neon Ninjas', 30, 2]]);
    const gal = await b.json(`/api/events/${code}/gallery?turn=${st.body.round.turnId}`);
    expect(gal.body[0]).toMatchObject({ team: 'Pixel Pirates', prompt: 'crimson box secret prompt', sceneId: scene1 });
    expect((await b.req(gal.body[0].imageUrl)).status).toBe(200);

    // ── Round 1, spin 2 ──
    await act(host, code, 'spin1');
    st = await a.json(`/api/events/${code}/state`);
    expect(st.body.round.sceneId).not.toBe(scene1);
    expect(st.body.round.seq).toBe(2);
    expect(st.body.me.current).toBeNull();
    await skipPreview(h);
    h.setReply(() => ({ text: goodR1(5) }));
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#e22')) });
    await h.drain();
    await act(host, code, 'reveal');
    st = await a.json(`/api/events/${code}/state`);
    expect(st.body.leaderboard[0]).toMatchObject({ name: 'Pixel Pirates', r1: 130, total: 130 });

    // ── Round 2: movie mashup ──
    expect((await act(host, code, 'spin2')).status).toBe(200);
    st = await b.json(`/api/events/${code}/state`);
    const [genre, hero, setting] = st.body.round.concepts;
    expect(MASHUP_REELS.genre).toContain(genre);
    expect(MASHUP_REELS.hero).toContain(hero);
    expect(MASHUP_REELS.setting).toContain(setting);
    await skipPreview(h);
    h.setReply(() => ({ text: goodR2(10) }));
    await b.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#2a2')) });
    await h.drain();
    expect(h.calls.at(-1)!.prompt).toContain(hero);
    await act(host, code, 'end');
    expect((await act(host, code, 'final')).status).toBe(200);
    st = await b.json(`/api/events/${code}/state`);
    // tie on 130 → the higher Round 2 score ranks first
    expect(st.body.leaderboard.map((r: any) => [r.name, r.r1, r.r2, r.total, r.rank])).toEqual([['Neon Ninjas', 30, 100, 130, 1], ['Pixel Pirates', 130, null, 130, 2]]);
    for (const call of h.calls) expect(call.prompt).not.toMatch(/Pixel Pirates|Neon Ninjas|crimson box secret prompt/);
  });

  it('the host can stop a spin early and spin again; a running spin blocks a new one', async () => {
    const h = await makeHarness();
    const { host, code } = await startShow(h, 2);
    await act(host, code, 'spin1');
    expect((await act(host, code, 'spin1')).status).toBe(409);
    expect((await act(host, code, 'end')).status).toBe(200);
    expect((await h.client().json(`/api/events/${code}/state`)).body.event.phase).toBe('r1_judging');
    expect((await act(host, code, 'spin2')).status).toBe(200);
  });
});

async function oneSubmission(h: H) {
  const { host, code, pins } = await startShow(h, 2);
  const a = await joinAs(h, code, 1, pins[0].pin);
  await act(host, code, 'spin1');
  await skipPreview(h);
  h.calls.length = 0;
  const r = await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff0000')) });
  expect(r.status).toBe(200);
  return { host, code, a, pins, submissionId: r.body.submissionId };
}

describe('evaluation reliability', () => {
  it('duplicate deliveries and concurrent workers publish exactly one score', async () => {
    const h = await makeHarness();
    const { submissionId } = await oneSubmission(h);
    const msg = h.queue[0];
    h.queue.push(msg, msg);
    const { processJob } = await import('../src/worker/evaluation');
    const results = await Promise.all([processJob(h.ctx, msg.jobId), processJob(h.ctx, msg.jobId), processJob(h.ctx, msg.jobId)]);
    await h.drain();
    expect(results.filter((r) => r.outcome === 'done')).toHaveLength(1);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM evaluation_results WHERE submission_id=$1`, [submissionId]))[0].n).toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  it('retries with backoff, then fails without inventing points; host retry recovers', async () => {
    const h = await makeHarness();
    const { host, code, submissionId } = await oneSubmission(h);
    h.setReply(() => ({ text: 'Sorry, I cannot help with that.' }));
    expect(await h.drain()).toEqual(['retry', 'retry', 'retry', 'failed']);
    expect((await h.db.query(`SELECT status, score_total FROM submissions WHERE id=$1`, [submissionId]))[0]).toEqual({ status: 'failed', score_total: null });
    h.setReply(() => ({ text: '```json\n' + goodR1(9) + '\n```' }));
    expect((await host.json(`/api/events/${code}/host/submissions/${submissionId}/requeue`, { method: 'POST' })).status).toBe(200);
    expect(await h.drain()).toEqual(['done']);
    expect((await h.db.query(`SELECT status, score_total::float FROM submissions WHERE id=$1`, [submissionId]))[0]).toEqual({ status: 'scored', score_total: 90 });
  });

  it('transient failure then success', async () => {
    const h = await makeHarness();
    const { submissionId } = await oneSubmission(h);
    h.setReply((_r, n) => { if (n === 1) throw new Error('upstream 503'); return { text: goodR1(5) }; });
    expect(await h.drain()).toEqual(['retry', 'done']);
    expect((await h.db.query(`SELECT attempts, status FROM evaluation_jobs WHERE submission_id=$1`, [submissionId]))[0]).toEqual({ attempts: 2, status: 'done' });
  });

  it('pauses at the AI budget and resumes via reconciliation when the cap allows', async () => {
    const h = await makeHarness();
    const { host, code, submissionId } = await oneSubmission(h);
    await host.json(`/api/events/${code}/host/settings`, { method: 'PUT', json: { ai_neuron_daily_cap: 1 } });
    expect(await h.drain()).toEqual(['paused']);
    expect(h.calls).toHaveLength(0);
    await host.json(`/api/events/${code}/host/settings`, { method: 'PUT', json: { ai_neuron_daily_cap: 8500 } });
    expect((await reconcile(h.ctx)).resumed).toBe(1);
    expect(await h.drain()).toEqual(['done']);
    expect((await h.db.query(`SELECT status FROM submissions WHERE id=$1`, [submissionId]))[0].status).toBe('scored');
  });

  it('provider quota errors pause the job instead of failing it', async () => {
    const h = await makeHarness();
    const { submissionId } = await oneSubmission(h);
    const { AiQuotaError } = await import('../src/worker/ai/providers');
    h.setReply(() => { throw new AiQuotaError('3036: daily free allocation exceeded'); });
    expect(await h.drain()).toEqual(['paused']);
    expect((await h.db.query(`SELECT status, attempts FROM evaluation_jobs WHERE submission_id=$1`, [submissionId]))[0]).toEqual({ status: 'paused_quota', attempts: 0 });
  });

  it('reconciliation re-enqueues lost messages, recovers expired leases and closes overdue spins', async () => {
    const h = await makeHarness();
    const { code } = await oneSubmission(h);
    h.queue.length = 0;
    await h.db.query(`UPDATE evaluation_jobs SET last_enqueued_at = now() - interval '5 minutes'`);
    expect((await reconcile(h.ctx)).requeued).toBe(1);
    await h.db.query(`UPDATE evaluation_jobs SET status='running', lease_until=now()-interval '1 minute'`);
    h.queue.length = 0;
    expect((await reconcile(h.ctx)).recovered).toBe(1);
    expect(await h.drain()).toEqual(['done']);
    await h.db.query(`UPDATE round_configs SET deadline_at = now() - interval '1 minute' WHERE spin_at IS NOT NULL`);
    expect((await reconcile(h.ctx)).closed).toBe(1);
    expect((await h.client().json(`/api/events/${code}/state`)).body.event.phase).toBe('r1_judging');
  });
});

describe('integrity rules', () => {
  it('flags exact duplicates and holds a re-upload of the scene itself without an AI call', async () => {
    const h = await makeHarness();
    const { host, code, pins } = await startShow(h, 3);
    const a = await joinAs(h, code, 1, pins[0].pin);
    const b = await joinAs(h, code, 2, pins[1].pin);
    const c = await joinAs(h, code, 3, pins[2].pin);
    await act(host, code, 'spin1');
    const scene = (await a.json(`/api/events/${code}/state`)).body.round.sceneId;
    await skipPreview(h);
    h.calls.length = 0;
    const same = await webp('#123456');
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(same) });
    const dup = await b.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(same) });
    expect(dup.body.flags).toContain('duplicate_exact');
    const sceneBytes = new Uint8Array(readFileSync(`public/bank/${scene}-judge.jpg`));
    const fd = new FormData();
    fd.set('full', new Blob([sceneBytes])); fd.set('judge', new Blob([sceneBytes])); fd.set('thumb', new Blob([sceneBytes]));
    const copy = await c.json(`/api/events/${code}/submit`, { method: 'POST', body: fd });
    expect(copy.body).toMatchObject({ status: 'needs_review', flags: ['reference_copy'] });
    await h.drain();
    expect(h.calls).toHaveLength(2);
    expect((await b.json(`/api/events/${code}/state`)).body.me.current.status).toBe('queued');
    const ov = await host.json(`/api/events/${code}/host/overview`);
    await host.json(`/api/events/${code}/host/submissions/${ov.body.submissions.find((s: any) => s.team === 'Team 2').id}/approve`, { method: 'POST' });
    await host.json(`/api/events/${code}/host/submissions/${ov.body.submissions.find((s: any) => s.team === 'Team 3').id}/reject`, { method: 'POST' });
    const after = await h.db.query(`SELECT t.team_no, s.status FROM submissions s JOIN teams t ON t.id=s.team_id ORDER BY t.team_no`);
    expect(after.map((r: any) => r.status)).toEqual(['scored', 'scored', 'rejected']);
  });

  it('flags images that try to instruct the judge', async () => {
    const h = await makeHarness();
    h.setReply(() => ({ text: JSON.stringify({ scores: { composition: 10, subject: 10, colour: 10, style: 10, detail: 10 }, feedback: 'x', embedded_instructions: true }) }));
    await oneSubmission(h);
    await h.drain();
    const [s] = await h.db.query(`SELECT status, flags FROM submissions`);
    expect(s.status).toBe('needs_review');
    expect(s.flags).toContain('embedded_text');
  });

  it('enforces the server deadline', async () => {
    const h = await makeHarness();
    const { code, a } = await oneSubmission(h);
    await h.db.query(`UPDATE round_configs SET deadline_at = now() - interval '1 minute' WHERE spin_at IS NOT NULL`);
    expect((await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#00ff00')) })).status).toBe(409);
    expect((await a.json(`/api/events/${code}/state`)).body.event.phase).toBe('r1_judging');
  });

  it('a re-upload replaces the earlier one and the per-spin limit holds', async () => {
    const h = await makeHarness();
    const { code, a } = await oneSubmission(h);
    await h.drain();
    await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff1100')) });
    expect((await a.json(`/api/events/${code}/submit`, { method: 'POST', body: await submitForm(await webp('#ff2200')) })).status).toBe(429);
    await h.drain();
    expect((await h.db.query(`SELECT status FROM submissions ORDER BY submitted_at`)).map((r: any) => r.status)).toEqual(['superseded', 'scored']);
  });

  it('each spin keeps the judge it started with; an explicit re-judge is the only way to change it', async () => {
    const h = await makeHarness();
    const { host, code } = await oneSubmission(h);
    await host.json(`/api/events/${code}/host/settings`, { method: 'PUT', json: { judge_model: '@cf/mistralai/mistral-small-3.1-24b-instruct' } });
    await h.drain();
    expect((await h.db.query(`SELECT model FROM evaluation_results`))[0].model).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
    expect((await host.json(`/api/events/${code}/host/rounds/1/rejudge`, { method: 'POST', json: { provider: 'workers-ai', model: '@cf/mistralai/mistral-small-3.1-24b-instruct' } })).status).toBe(400);
    expect((await host.json(`/api/events/${code}/host/rounds/1/rejudge`, { method: 'POST', json: { provider: 'workers-ai', model: '@cf/mistralai/mistral-small-3.1-24b-instruct', confirm: 'REJUDGE' } })).status).toBe(200);
    await h.drain();
    expect(await h.db.query(`SELECT model, is_published FROM evaluation_results ORDER BY created_at`)).toEqual([
      { model: '@cf/meta/llama-4-scout-17b-16e-instruct', is_published: false },
      { model: '@cf/mistralai/mistral-small-3.1-24b-instruct', is_published: true },
    ]);
  });
});

describe('auth & privacy', () => {
  it('team PIN lockout, PIN reset, host-only routes, wrong host password', async () => {
    const h = await makeHarness();
    const { host, code, pins } = await startShow(h, 1);
    await joinAs(h, code, 1, pins[0].pin);
    const x = h.client();
    for (let i = 0; i < 5; i++) expect((await x.json(`/api/events/${code}/join`, { method: 'POST', json: { teamNo: 1, pin: '0000' } })).status).toBe(401);
    expect((await x.json(`/api/events/${code}/join`, { method: 'POST', json: { teamNo: 1, pin: pins[0].pin } })).status).toBe(429);
    const np = await host.json(`/api/events/${code}/host/teams/${pins[0].id}/new-pin`, { method: 'POST' });
    expect(np.body.pin).toMatch(/^\d{4}$/);
    expect((await x.json(`/api/events/${code}/join`, { method: 'POST', json: { teamNo: 1, pin: np.body.pin } })).status).toBe(200);
    expect((await h.client().json(`/api/events/${code}/host/overview`)).status).toBe(401);
    expect((await h.client().json('/api/host/login', { method: 'POST', json: { password: 'nope-nope' } })).status).toBe(401);
  });

  it('keeps entries private until revealed and rejects cross-origin writes', async () => {
    const h = await makeHarness();
    const { host, code, pins, a } = await oneSubmission(h);
    const b = await joinAs(h, code, 2, pins[1].pin);
    const own = (await a.json(`/api/events/${code}/state`)).body.me.current.thumbUrl;
    expect((await a.req(own)).status).toBe(200);
    expect((await b.req(own)).status).toBe(403);
    expect((await h.client().req(own)).status).toBe(403);
    await h.drain();
    await act(host, code, 'reveal');
    expect((await b.req(own)).status).toBe(200);
    const csrf = await a.json(`/api/events/${code}/submit`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: await submitForm(await webp('#ff0000')) });
    expect(csrf.status).toBe(403);
  });

  it('serves 304 for unchanged state (cheap polling)', async () => {
    const h = await makeHarness();
    const { code, pins } = await startShow(h, 1);
    const a = await joinAs(h, code, 1, pins[0].pin);
    const first = await a.req(`/api/events/${code}/state`);
    expect(first.headers.get('x-poll-ms')).toBe('8000');
    expect((await a.req(`/api/events/${code}/state`, { headers: { 'if-none-match': first.headers.get('etag')! } })).status).toBe(304);
  });

  it('stores images in object storage when configured', async () => {
    const h = await makeHarness({ objectStore: true });
    await oneSubmission(h);
    const rows = await h.db.query(`SELECT backend, data IS NULL AS no_bytes FROM images`);
    expect(rows.every((r: any) => r.backend === 'neon-s3' && r.no_bytes)).toBe(true);
    expect(h.objects.size).toBe(4); // scene judge copy + full, judge and thumb of the upload
  });
});

describe('BID WARS-style claiming', () => {
  it('two phones racing for the same free number: exactly one wins', async () => {
    const h = await makeHarness();
    const { code } = await startShow(h, 2);
    const results = await Promise.all([
      h.client().json(`/api/events/${code}/claim`, { method: 'POST', json: { teamNo: 1, pin: '4826', name: 'First' } }),
      h.client().json(`/api/events/${code}/claim`, { method: 'POST', json: { teamNo: 1, pin: '5937', name: 'Second' } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const st = (await h.client().json(`/api/events/${code}/slots`)).body.slots;
    expect(st[0].taken).toBe(true);
  });
});

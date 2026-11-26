import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { MODELS } from './ai/models';
import { resolveR1Mode } from './ai/judge';
import {
  clearCookie, HOST_COOKIE, loginHost, loginTeam, readCookie, registerTeam, revokeSession,
  sessionCookie, sessionFor, TEAM_COOKIE, validatePin,
} from './auth';
import { calibrateRound } from './calibration';
import type { AppContext } from './context';
import { detectImageType, hashSecret, randomToken, safeEqual, sha256Hex } from './crypto';
import { aiBudgetAvailable, refreshLeaderboard } from './evaluation';
import {
  audit, bumpVersion, createSubmission, generateReferenceDescription, HttpError, rejudgeRound,
  requeueSubmission, setPhase,
} from './game';
import { buildState, idx, resultsRevealed } from './state';
import type { ContentType } from './storage';
import { todayUsage } from './usage';
import { PHASE_ORDER, type Phase } from '../shared/types';

type Vars = { ctx: AppContext };
type C = Context<{ Variables: Vars; Bindings: any }>;

export function createApp(getCtx: (env: any) => AppContext, opts: { adminToken: (env: any) => string | undefined; onRequest?: (c: C) => void }) {
  const app = new Hono<{ Variables: Vars; Bindings: any }>().basePath('/api');

  app.use('*', async (c, next) => {
    c.set('ctx', getCtx(c.env));
    opts.onRequest?.(c as C);
    // CSRF defence in depth (cookies are already SameSite=Strict)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: 'Bad origin' }, 403);
    }
    await next();
    c.header('cache-control', c.res.headers.get('cache-control') ?? 'no-store');
    c.header('x-content-type-options', 'nosniff');
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    console.error(err);
    return c.json({ error: 'Something went wrong on the server' }, 500);
  });

  const secure = (c: C) => new URL(c.req.url).protocol === 'https:';
  const body = async <T,>(c: C, schema: z.ZodType<T>) => schema.parse(await c.req.json().catch(() => { throw new HttpError(400, 'JSON body expected'); }));

  async function eventByCode(c: C) {
    const code = c.req.param('code')?.toUpperCase() ?? '';
    const [e] = await c.get('ctx').db.query<any>(`SELECT * FROM events WHERE code=$1`, [code]);
    if (!e) throw new HttpError(404, 'Event not found');
    return e;
  }
  async function requireHost(c: C) {
    const e = await eventByCode(c);
    const s = await sessionFor(c.get('ctx'), readCookie(c.req.header('cookie'), HOST_COOKIE), 'host');
    if (!s || s.event_id !== e.id) throw new HttpError(401, 'Host login required');
    return e;
  }
  async function requireTeam(c: C) {
    const e = await eventByCode(c);
    const s = await sessionFor(c.get('ctx'), readCookie(c.req.header('cookie'), TEAM_COOKIE), 'team');
    if (!s || s.event_id !== e.id || !s.team_id) throw new HttpError(401, 'Team login required');
    return { event: e, teamId: s.team_id };
  }

  // ───────────── health ─────────────
  app.get('/health', async (c) => {
    const ctx = c.get('ctx');
    await ctx.db.query('SELECT 1');
    return c.json({ ok: true, storage: ctx.storageBackend, capabilities: ctx.capabilities });
  });

  // ───────────── admin bootstrap ─────────────
  app.post('/admin/events', async (c) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const expected = opts.adminToken(c.env);
    if (!expected || !safeEqual(token, expected)) throw new HttpError(401, 'Bad admin token');
    const b = await body(c, z.object({
      code: z.string().regex(/^[A-Z0-9]{4,8}$/), name: z.string().min(2).max(80), hostPassword: z.string().min(10).max(128),
    }));
    const ctx = c.get('ctx');
    const id = crypto.randomUUID();
    await ctx.db.batch([
      { text: `INSERT INTO events(id,code,name,host_pass_hash,projector_key) VALUES($1,$2,$3,$4,$5)`, params: [id, b.code, b.name, await hashSecret(b.hostPassword, 50000), randomToken(16)] },
      { text: `INSERT INTO host_settings(event_id) VALUES($1)`, params: [id] },
      { text: `INSERT INTO round_configs(event_id,round_no,title,brief,duration_sec) VALUES
               ($1,1,'Pixel Match','Recreate the reference image as closely as you can using any AI image generator.',600),
               ($1,2,'Crossover','Create ONE artwork that fuses all three concepts into a single scene.',900)`, params: [id] },
    ]);
    await audit(ctx, id, 'admin', 'event_created', { code: b.code });
    return c.json({ id, code: b.code });
  });

  // ───────────── state (adaptive polling) ─────────────
  app.get('/events/:code/state', async (c) => {
    const ctx = c.get('ctx');
    const team = readCookie(c.req.header('cookie'), TEAM_COOKIE);
    const host = readCookie(c.req.header('cookie'), HOST_COOKIE);
    const out = await buildState(ctx, c.req.param('code').toUpperCase(), {
      teamTokenHash: team ? await sha256Hex(team) : null,
      hostTokenHash: host ? await sha256Hex(host) : null,
      projectorKey: c.req.query('pk') ?? null,
    }, c.req.header('if-none-match') ?? null);
    c.header('x-poll-ms', String(out.pollMs));
    if (out.status === 404) return c.json({ error: 'Event not found' }, 404);
    c.header('etag', out.etag!);
    c.header('cache-control', 'no-cache');
    if (out.status === 304) return c.body(null, 304);
    return c.json(out.body!);
  });

  // ───────────── teams ─────────────
  const cred = z.object({ teamName: z.string().min(1).max(64), pin: z.string().min(1).max(16) });
  app.post('/events/:code/register', async (c) => {
    const e = await eventByCode(c);
    const b = await body(c, cred);
    const r = await registerTeam(c.get('ctx'), e, b.teamName, b.pin);
    c.header('set-cookie', sessionCookie(TEAM_COOKIE, r.token, secure(c)));
    return c.json({ teamId: r.teamId, name: r.name });
  });
  app.post('/events/:code/login', async (c) => {
    const e = await eventByCode(c);
    const b = await body(c, cred);
    const r = await loginTeam(c.get('ctx'), e.id, b.teamName, b.pin);
    c.header('set-cookie', sessionCookie(TEAM_COOKIE, r.token, secure(c)));
    return c.json({ teamId: r.teamId, name: r.name });
  });
  app.post('/logout', async (c) => {
    const ctx = c.get('ctx');
    await revokeSession(ctx, readCookie(c.req.header('cookie'), TEAM_COOKIE));
    await revokeSession(ctx, readCookie(c.req.header('cookie'), HOST_COOKIE));
    c.header('set-cookie', clearCookie(TEAM_COOKIE, secure(c)));
    c.res.headers.append('set-cookie', clearCookie(HOST_COOKIE, secure(c)));
    return c.json({ ok: true });
  });

  async function readImage(f: unknown, label: string) {
    if (!f || typeof f === 'string') throw new HttpError(400, `Missing ${label} image`);
    const bytes = new Uint8Array(await (f as File).arrayBuffer());
    const type = detectImageType(bytes);
    if (!type) throw new HttpError(415, `${label} must be WebP, JPEG or PNG`);
    return { bytes, type: type as ContentType };
  }

  app.post('/events/:code/submit', async (c) => {
    const { event, teamId } = await requireTeam(c);
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > 2_000_000) throw new HttpError(413, 'Upload too large');
    const form = await c.req.formData();
    const full = await readImage(form.get('full'), 'Full');
    const judge = await readImage(form.get('judge'), 'Judge');
    const thumb = await readImage(form.get('thumb'), 'Thumbnail');
    const out = await createSubmission(c.get('ctx'), event.id, teamId, {
      full: { ...full, width: Number(form.get('width')) || undefined, height: Number(form.get('height')) || undefined },
      judge, thumb,
      dhash: String(form.get('dhash') ?? '').toLowerCase(),
      prompt: String(form.get('prompt') ?? '').slice(0, 2000),
    });
    return c.json(out);
  });

  // ───────────── images (private; served through the Worker) ─────────────
  app.get('/img/:id', async (c) => {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'Not found');
    const [m] = await ctx.db.query<any>(
      `SELECT i.kind, i.event_id, i.sha256, e.phase, e.projector_key,
              s.team_id, r.round_no, (rr.reference_image_id = i.id) AS is_r1_reference
       FROM images i JOIN events e ON e.id=i.event_id
       LEFT JOIN submissions s ON (s.image_id=i.id OR s.thumb_image_id=i.id)
       LEFT JOIN round_configs r ON r.id=s.round_id
       LEFT JOIN round_configs rr ON rr.event_id=i.event_id AND rr.round_no=1
       WHERE i.id=$1`, [id]);
    if (!m) throw new HttpError(404, 'Not found');
    const host = await sessionFor(ctx, readCookie(c.req.header('cookie'), HOST_COOKIE), 'host');
    let allowed = !!host && host.event_id === m.event_id;
    if (!allowed) {
      const team = await sessionFor(ctx, readCookie(c.req.header('cookie'), TEAM_COOKIE), 'team');
      const isTeam = !!team && team.event_id === m.event_id;
      const isProjector = !!c.req.query('pk') && safeEqual(c.req.query('pk')!, m.projector_key);
      const phase = m.phase as Phase;
      if (m.kind === 'reference' && m.is_r1_reference) allowed = (isTeam || isProjector) && idx(phase) >= idx('r1_open');
      else if (m.kind === 'submission' || m.kind === 'thumb')
        allowed = (isTeam && team!.team_id === m.team_id) || ((isTeam || isProjector) && m.round_no && resultsRevealed(phase, m.round_no));
    }
    if (!allowed) throw new HttpError(403, 'Not allowed');
    if (c.req.header('if-none-match') === `"${m.sha256}"`) return c.body(null, 304);
    const img = await ctx.images.get(id);
    if (!img) throw new HttpError(404, 'Image missing');
    return new Response(img.bytes, { headers: { 'content-type': img.contentType, 'cache-control': 'private, max-age=86400, immutable', etag: `"${m.sha256}"` } });
  });

  // ───────────── gallery ─────────────
  app.get('/events/:code/gallery', async (c) => {
    const ctx = c.get('ctx');
    const e = await eventByCode(c);
    const roundNo = Number(c.req.query('round') ?? 1) === 2 ? 2 : 1;
    const pk = c.req.query('pk');
    const host = await sessionFor(ctx, readCookie(c.req.header('cookie'), HOST_COOKIE), 'host');
    const team = await sessionFor(ctx, readCookie(c.req.header('cookie'), TEAM_COOKIE), 'team');
    const viewer = (host && host.event_id === e.id) || (team && team.event_id === e.id) || (pk && safeEqual(pk, e.projector_key));
    if (!viewer) throw new HttpError(401, 'Log in to view the gallery');
    if (!resultsRevealed(e.phase, roundNo) && !(host && host.event_id === e.id)) throw new HttpError(403, 'Gallery opens when results are revealed');
    const rows = await ctx.db.query<any>(
      `SELECT s.id, t.name, s.image_id, s.thumb_image_id, s.score_total, s.prompt_text, er.feedback, er.criteria
       FROM submissions s JOIN teams t ON t.id=s.team_id JOIN round_configs r ON r.id=s.round_id
       LEFT JOIN evaluation_results er ON er.submission_id=s.id AND er.is_published
       WHERE r.event_id=$1 AND r.round_no=$2 AND s.status='scored' AND NOT t.disabled
       ORDER BY s.score_total DESC NULLS LAST`, [e.id, roundNo]);
    const q = pk && !host ? `?pk=${encodeURIComponent(pk)}` : '';
    return c.json(rows.map((r) => ({
      id: r.id, team: r.name, score: Number(r.score_total), prompt: r.prompt_text, feedback: r.feedback, criteria: r.criteria,
      imageUrl: `/api/img/${r.image_id}${q}`, thumbUrl: `/api/img/${r.thumb_image_id}${q}`,
    })));
  });

  // ───────────── host ─────────────
  app.post('/events/:code/host/login', async (c) => {
    const e = await eventByCode(c);
    const b = await body(c, z.object({ password: z.string().min(1).max(128) }));
    const token = await loginHost(c.get('ctx'), e, b.password);
    c.header('set-cookie', sessionCookie(HOST_COOKIE, token, secure(c)));
    return c.json({ ok: true });
  });

  app.get('/events/:code/host/overview', async (c) => {
    const e = await requireHost(c);
    const ctx = c.get('ctx');
    const [settings, rounds, teams, subs, auditRows, storage, dbSize] = await ctx.db.batch([
      { text: `SELECT * FROM host_settings WHERE event_id=$1`, params: [e.id] },
      { text: `SELECT r.*, ri.byte_size AS reference_bytes FROM round_configs r LEFT JOIN images ri ON ri.id=r.reference_image_id WHERE r.event_id=$1 ORDER BY round_no`, params: [e.id] },
      { text: `SELECT t.id, t.name, t.disabled, t.created_at, c.locked_until,
                 (SELECT count(*)::int FROM auth_sessions a WHERE a.team_id=t.id AND NOT a.revoked AND a.expires_at>now()) AS sessions
               FROM teams t JOIN team_credentials c ON c.team_id=t.id WHERE t.event_id=$1 ORDER BY t.created_at`, params: [e.id] },
      { text: `SELECT s.id, s.team_id, t.name AS team, r.round_no, s.status, s.flags, s.score_total, s.submitted_at, s.scored_at,
                 s.thumb_image_id, s.image_id, s.prompt_text,
                 j.status AS job_status, j.attempts, j.last_error, j.next_attempt_at,
                 er.criteria, er.feedback, er.model, er.latency_ms, er.neurons_est
               FROM submissions s JOIN teams t ON t.id=s.team_id JOIN round_configs r ON r.id=s.round_id
               LEFT JOIN LATERAL (SELECT * FROM evaluation_jobs j WHERE j.submission_id=s.id ORDER BY created_at DESC LIMIT 1) j ON true
               LEFT JOIN evaluation_results er ON er.submission_id=s.id AND er.is_published
               WHERE s.event_id=$1 AND s.status<>'superseded' ORDER BY s.submitted_at DESC`, params: [e.id] },
      { text: `SELECT actor, action, detail, created_at FROM audit_logs WHERE event_id=$1 ORDER BY id DESC LIMIT 40`, params: [e.id] },
      { text: `SELECT backend, count(*)::int AS n, coalesce(sum(byte_size),0)::bigint AS bytes FROM images GROUP BY backend` },
      { text: `SELECT pg_database_size(current_database())::bigint AS bytes` },
    ]);
    const usage = await todayUsage(ctx.db);
    const s = settings[0];
    const r1 = rounds.find((r: any) => r.round_no === 1);
    return c.json({
      event: { id: e.id, code: e.code, name: e.name, phase: e.phase, registrationOpen: e.registration_open, projectorKey: e.projector_key },
      phases: PHASE_ORDER,
      settings: s,
      effectiveR1Mode: r1?.locked_mode ?? resolveR1Mode(s.r1_mode, s.judge_model, ctx.capabilities.imagesBinding),
      rounds: rounds.map((r: any) => ({ ...r, reference_image_url: r.reference_image_id ? `/api/img/${r.reference_image_id}` : null })),
      teams,
      submissions: subs.map((x: any) => ({ ...x, thumb_url: `/api/img/${x.thumb_image_id}`, image_url: `/api/img/${x.image_id}` })),
      audit: auditRows,
      models: MODELS,
      capabilities: ctx.capabilities,
      storageBackend: ctx.storageBackend,
      usage: {
        today: usage,
        storage,
        dbBytes: Number(dbSize[0]?.bytes ?? 0),
        limits: {
          aiNeuronsFreePerDay: 10000, workerRequestsFreePerDay: 100000, neonDbBytes: 1_000_000_000, neonObjectBytes: 5_000_000_000,
          neonComputeHoursPerMonth: 100, queueRetentionHours: 24,
        },
        budget: await aiBudgetAvailable(ctx, e.id, r1?.locked_model ?? s.judge_model, r1?.locked_provider ?? s.judge_provider),
      },
    });
  });

  app.post('/events/:code/host/phase', async (c) => {
    const e = await requireHost(c);
    const b = await body(c, z.object({ to: z.enum(PHASE_ORDER as [Phase, ...Phase[]]) }));
    await setPhase(c.get('ctx'), e, b.to);
    return c.json({ ok: true });
  });

  app.post('/events/:code/host/registration', async (c) => {
    const e = await requireHost(c);
    const b = await body(c, z.object({ open: z.boolean() }));
    const ctx = c.get('ctx');
    await ctx.db.query(`UPDATE events SET registration_open=$2, state_version=state_version+1 WHERE id=$1`, [e.id, b.open]);
    await audit(ctx, e.id, 'host', 'registration', { open: b.open });
    return c.json({ ok: true });
  });

  app.put('/events/:code/host/settings', async (c) => {
    const e = await requireHost(c);
    const b = await body(c, z.object({
      judge_provider: z.enum(['workers-ai', 'ollama']).optional(),
      judge_model: z.string().min(3).max(120).optional(),
      r1_mode: z.enum(['auto', 'multi-image', 'composite', 'reference-description']).optional(),
      eval_concurrency: z.number().int().min(1).max(10).optional(),
      max_attempts: z.number().int().min(1).max(10).optional(),
      ai_neuron_daily_cap: z.number().int().min(0).max(10000).optional(),      // can never exceed the free allocation
      request_daily_cap: z.number().int().min(1000).max(100000).optional(),
      max_submissions_per_round: z.number().int().min(1).max(5).optional(),
    }));
    const ctx = c.get('ctx');
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (!keys.length) return c.json({ ok: true });
    await ctx.db.query(
      `UPDATE host_settings SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE event_id=$1`,
      [e.id, ...keys.map((k) => b[k])]);
    await audit(ctx, e.id, 'host', 'settings', b);
    return c.json({ ok: true, note: 'Judge changes apply only to rounds that have not opened yet.' });
  });

  app.put('/events/:code/host/rounds/:n', async (c) => {
    const e = await requireHost(c);
    const n = Number(c.req.param('n'));
    if (n !== 1 && n !== 2) throw new HttpError(404, 'Round not found');
    const b = await body(c, z.object({
      title: z.string().min(1).max(60).optional(),
      brief: z.string().max(600).optional(),
      duration_sec: z.number().int().min(60).max(7200).optional(),
      judging_window_sec: z.number().int().min(60).max(1800).optional(),
      concepts: z.array(z.string().trim().min(1).max(80)).length(3).optional(),
      reference_description: z.string().max(2500).optional(),
    }));
    const ctx = c.get('ctx');
    const [r] = await ctx.db.query<any>(`SELECT locked_at FROM round_configs WHERE event_id=$1 AND round_no=$2`, [e.id, n]);
    if (r?.locked_at && (b.concepts || b.reference_description)) throw new HttpError(409, 'Round already opened — concepts/description are locked for fairness');
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (keys.length) {
      await ctx.db.query(
        `UPDATE round_configs SET ${keys.map((k, i) => `${k}=$${i + 3}${k === 'concepts' ? '::jsonb' : ''}`).join(', ')} WHERE event_id=$1 AND round_no=$2`,
        [e.id, n, ...keys.map((k) => (k === 'concepts' ? JSON.stringify(b[k]) : b[k]))]);
      await bumpVersion(ctx, e.id);
      await audit(ctx, e.id, 'host', 'round_config', { round: n, fields: keys });
    }
    return c.json({ ok: true });
  });

  app.post('/events/:code/host/rounds/1/reference', async (c) => {
    const e = await requireHost(c);
    const ctx = c.get('ctx');
    const [r] = await ctx.db.query<any>(`SELECT id, locked_at FROM round_configs WHERE event_id=$1 AND round_no=1`, [e.id]);
    if (r.locked_at) throw new HttpError(409, 'Round 1 has opened — the reference is locked');
    const form = await c.req.formData();
    const full = await readImage(form.get('full'), 'Reference');
    const judge = await readImage(form.get('judge'), 'Reference judge copy');
    const dhash = String(form.get('dhash') ?? '').toLowerCase();
    const a = await ctx.images.put({ eventId: e.id, kind: 'reference', bytes: full.bytes, contentType: full.type });
    const j = await ctx.images.put({ eventId: e.id, kind: 'judge', bytes: judge.bytes, contentType: judge.type });
    await ctx.db.query(
      `UPDATE round_configs SET reference_image_id=$2, reference_judge_image_id=$3, reference_dhash=$4, reference_description=NULL, calibration=NULL WHERE id=$1`,
      [r.id, a.id, j.id, /^[0-9a-f]{16}$/.test(dhash) ? dhash : null]);
    await audit(ctx, e.id, 'host', 'reference_uploaded', { bytes: full.bytes.length });
    return c.json({ ok: true, imageUrl: `/api/img/${a.id}` });
  });

  app.post('/events/:code/host/rounds/1/describe', async (c) => {
    const e = await requireHost(c);
    const [r] = await c.get('ctx').db.query<any>(`SELECT locked_at FROM round_configs WHERE event_id=$1 AND round_no=1`, [e.id]);
    if (r?.locked_at) throw new HttpError(409, 'Round 1 has opened — the description is locked');
    return c.json({ description: await generateReferenceDescription(c.get('ctx'), e.id) });
  });

  app.post('/events/:code/host/rounds/:n/calibrate', async (c) => {
    const e = await requireHost(c);
    const n = Number(c.req.param('n')) === 2 ? 2 : 1;
    return c.json(await calibrateRound(c.get('ctx'), e.id, n));
  });

  app.post('/events/:code/host/rounds/:n/rejudge', async (c) => {
    const e = await requireHost(c);
    const n = Number(c.req.param('n')) === 2 ? 2 : 1;
    const b = await body(c, z.object({ provider: z.enum(['workers-ai', 'ollama']), model: z.string().min(3), mode: z.string().optional(), confirm: z.literal('REJUDGE') }));
    const ctx = c.get('ctx');
    const mode = n === 1 ? resolveR1Mode(b.mode ?? 'auto', b.model, ctx.capabilities.imagesBinding) : 'single';
    await rejudgeRound(ctx, e.id, n, b.provider, b.model, mode);
    return c.json({ ok: true, mode });
  });

  app.post('/events/:code/host/submissions/:id/:action', async (c) => {
    const e = await requireHost(c);
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const action = c.req.param('action');
    if (action === 'requeue') await requeueSubmission(ctx, e.id, id);
    else if (action === 'approve') {
      const [s] = await ctx.db.query<any>(
        `SELECT s.status, er.total FROM submissions s LEFT JOIN evaluation_results er ON er.submission_id=s.id AND er.is_published WHERE s.id=$1 AND s.event_id=$2`, [id, e.id]);
      if (!s) throw new HttpError(404, 'Submission not found');
      if (s.status !== 'needs_review') throw new HttpError(409, 'Only held submissions can be approved');
      if (s.total === null) {
        await ctx.db.query(`UPDATE submissions SET flags = array_append(flags,'host_cleared') WHERE id=$1`, [id]);
        await requeueSubmission(ctx, e.id, id); // never scored yet (e.g. held as reference copy) → evaluate now
      } else {
        await ctx.db.query(`UPDATE submissions SET status='scored', score_total=$2, flags = array_append(flags,'host_cleared') WHERE id=$1`, [id, s.total]);
        await refreshLeaderboard(ctx, e.id);
      }
    } else if (action === 'reject') {
      await ctx.db.query(`UPDATE submissions SET status='rejected', score_total=0 WHERE id=$1 AND event_id=$2 AND status<>'superseded'`, [id, e.id]);
      await ctx.db.query(`UPDATE evaluation_jobs SET status='cancelled', finished_at=now() WHERE submission_id=$1 AND status IN ('queued','retry','paused_quota')`, [id]);
      await refreshLeaderboard(ctx, e.id);
    } else throw new HttpError(404, 'Unknown action');
    await audit(ctx, e.id, 'host', `submission_${action}`, { id });
    return c.json({ ok: true });
  });

  app.post('/events/:code/host/teams/:id/:action', async (c) => {
    const e = await requireHost(c);
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const action = c.req.param('action');
    if (action === 'reset-pin') {
      const b = await body(c, z.object({ pin: z.string() }));
      validatePin(b.pin);
      await ctx.db.batch([
        { text: `UPDATE team_credentials SET pin_hash=$2, failed_attempts=0, locked_until=NULL WHERE team_id=$1 AND team_id IN (SELECT id FROM teams WHERE event_id=$3)`, params: [id, await hashSecret(b.pin, ctx.pinIterations), e.id] },
        { text: `UPDATE auth_sessions SET revoked=true WHERE team_id=$1`, params: [id] },
      ]);
    } else if (action === 'disable' || action === 'enable') {
      await ctx.db.query(`UPDATE teams SET disabled=$3 WHERE id=$1 AND event_id=$2`, [id, e.id, action === 'disable']);
      await refreshLeaderboard(ctx, e.id);
    } else throw new HttpError(404, 'Unknown action');
    await audit(ctx, e.id, 'host', `team_${action}`, { id });
    return c.json({ ok: true });
  });

  app.post('/events/:code/host/leaderboard/refresh', async (c) => {
    const e = await requireHost(c);
    await refreshLeaderboard(c.get('ctx'), e.id);
    return c.json({ ok: true });
  });

  return app;
}

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { MODELS } from './ai/models';
import { resolveR1Mode } from './ai/judge';
import {
  clearCookie, HOST_COOKIE, joinTeam, loginHost, loginTeam, readCookie, registerTeam, renameTeam, revokeSession,
  sessionCookie, sessionFor, TEAM_COOKIE,
} from './auth';
import type { AppContext } from './context';
import { detectImageType, hashSecret, randomToken, safeEqual, sha256Hex } from './crypto';
import { aiBudgetAvailable, refreshLeaderboard } from './evaluation';
import {
  audit, claimTeam, createSubmission, ensureTeams, hostAction, HttpError, newPinFor, rejudgeRound,
  requeueSubmission, startEvent,
  addBonus, hostScore, removeBonus,
} from './game';
import { buildState, idx } from './state';
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
      { text: `INSERT INTO events(id,code,name,host_pass_hash,projector_key) VALUES($1,$2,$3,$4,$5)`, params: [id, b.code, b.name, await hashSecret(b.hostPassword, 20000), randomToken(16)] },
      { text: `INSERT INTO host_settings(event_id) VALUES($1)`, params: [id] },
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


  // ───────────── team join (host-issued number + PIN) ─────────────
  app.post('/events/:code/join', async (c) => {
    const e = await eventByCode(c);
    const b = await body(c, z.object({ teamNo: z.number().int().min(1).max(200), pin: z.string().min(1).max(8) }));
    const r = await joinTeam(c.get('ctx'), e.id, b.teamNo, b.pin);
    c.header('set-cookie', sessionCookie(TEAM_COOKIE, r.token, secure(c)));
    return c.json({ teamId: r.teamId, name: r.name, named: r.named });
  });

  /** Free and taken team numbers for the join screen (names of taken teams only). */
  app.get('/events/:code/slots', async (c) => {
    const e = await eventByCode(c);
    const rows = await c.get('ctx').db.query<any>(
      `SELECT team_no, CASE WHEN joined_at IS NOT NULL THEN name END AS name, joined_at IS NOT NULL AS taken
       FROM teams WHERE event_id=$1 AND team_no IS NOT NULL AND NOT disabled ORDER BY team_no`, [e.id]);
    return c.json({ name: e.name, registrationOpen: e.registration_open, slots: rows.map((r) => ({ no: r.team_no, taken: r.taken, name: r.name })) });
  });

  app.post('/events/:code/claim', async (c) => {
    const e = await eventByCode(c);
    const b = await body(c, z.object({ teamNo: z.number().int().min(1).max(200), pin: z.string().max(8), name: z.string().max(64) }));
    const ctx = c.get('ctx');
    const r = await claimTeam(ctx, e, b.teamNo, b.pin, b.name);
    const token = await (await import('./auth')).createSession(ctx, e.id, 'team', r.teamId);
    c.header('set-cookie', sessionCookie(TEAM_COOKIE, token, secure(c)));
    return c.json(r);
  });

  app.post('/events/:code/team-name', async (c) => {
    const { event, teamId } = await requireTeam(c);
    const b = await body(c, z.object({ name: z.string().min(1).max(64) }));
    return c.json({ name: await renameTeam(c.get('ctx'), event.id, teamId, b.name) });
  });

  // ───────────── active event (no codes to type anywhere) ─────────────
  app.get('/active', async (c) => {
    const [e] = await c.get('ctx').db.query<any>(`SELECT code, name FROM events WHERE active LIMIT 1`);
    return c.json(e ? { code: e.code, name: e.name } : { code: null });
  });

  // ───────────── images (private; served through the Worker) ─────────────
  app.get('/img/:id', async (c) => {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'Not found');
    const [m] = await ctx.db.query<any>(
      `SELECT i.kind, i.event_id, i.sha256, e.projector_key, s.team_id, (r.revealed_at IS NOT NULL) AS revealed
       FROM images i JOIN events e ON e.id=i.event_id
       LEFT JOIN submissions s ON (s.image_id=i.id OR s.thumb_image_id=i.id)
       LEFT JOIN round_configs r ON r.id=s.round_id
       WHERE i.id=$1`, [id]);
    if (!m) throw new HttpError(404, 'Not found');
    const host = await sessionFor(ctx, readCookie(c.req.header('cookie'), HOST_COOKIE), 'host');
    let allowed = !!host && host.event_id === m.event_id;
    if (!allowed && (m.kind === 'submission' || m.kind === 'thumb')) {
      const team = await sessionFor(ctx, readCookie(c.req.header('cookie'), TEAM_COOKIE), 'team');
      const isTeam = !!team && team.event_id === m.event_id;
      const isProjector = !!c.req.query('pk') && safeEqual(c.req.query('pk')!, m.projector_key);
      allowed = (isTeam && team!.team_id === m.team_id) || ((isTeam || isProjector) && m.revealed);
    }
    if (!allowed) throw new HttpError(403, 'Not allowed');
    if (c.req.header('if-none-match') === `"${m.sha256}"`) return c.body(null, 304);
    const img = await ctx.images.get(id);
    if (!img) throw new HttpError(404, 'Image missing');
    return new Response(img.bytes, { headers: { 'content-type': img.contentType, 'cache-control': 'private, max-age=86400, immutable', etag: `"${m.sha256}"` } });
  });

  // ───────────── gallery (revealed spins only) ─────────────
  app.get('/events/:code/gallery', async (c) => {
    const ctx = c.get('ctx');
    const e = await eventByCode(c);
    const pk = c.req.query('pk');
    const host = await sessionFor(ctx, readCookie(c.req.header('cookie'), HOST_COOKIE), 'host');
    const team = await sessionFor(ctx, readCookie(c.req.header('cookie'), TEAM_COOKIE), 'team');
    const isHost = !!host && host.event_id === e.id;
    const viewer = isHost || (team && team.event_id === e.id) || (pk && safeEqual(pk, e.projector_key));
    if (!viewer) throw new HttpError(401, 'Log in to view the gallery');
    const turn = c.req.query('turn');
    const roundNo = Number(c.req.query('round') ?? 0);
    const rows = await ctx.db.query<any>(
      `SELECT s.id, t.name, s.image_id, s.thumb_image_id, s.score_total, s.prompt_text, er.feedback, er.criteria,
              r.id AS turn_id, r.round_no, r.seq, r.title, r.bank_item, r.concepts
       FROM submissions s JOIN teams t ON t.id=s.team_id JOIN round_configs r ON r.id=s.round_id
       LEFT JOIN evaluation_results er ON er.submission_id=s.id AND er.is_published
       WHERE r.event_id=$1 AND s.status='scored' AND NOT t.disabled
         AND ($2::uuid IS NULL OR r.id=$2::uuid) AND ($3::int = 0 OR r.round_no=$3::int)
         AND (r.revealed_at IS NOT NULL OR $4::boolean)
       ORDER BY r.round_no, r.seq, s.score_total DESC NULLS LAST`, [e.id, turn && /^[0-9a-f-]{36}$/.test(turn) ? turn : null, roundNo, isHost]);
    const q = pk && !isHost ? `?pk=${encodeURIComponent(pk)}` : '';
    return c.json(rows.map((r) => ({
      id: r.id, team: r.name, score: Number(r.score_total), prompt: r.prompt_text, feedback: r.feedback, criteria: r.criteria,
      imageUrl: `/api/img/${r.image_id}${q}`, thumbUrl: `/api/img/${r.thumb_image_id}${q}`,
      turnId: r.turn_id, roundNo: r.round_no, seq: r.seq, title: r.title, sceneId: r.bank_item, concepts: r.concepts ?? [],
    })));
  });

  // ───────────── host: password only, no codes or tokens ─────────────
  async function activeEvent(c: C) {
    const [e] = await c.get('ctx').db.query<any>(`SELECT * FROM events WHERE active LIMIT 1`);
    return e ?? null;
  }

  app.get('/host/status', async (c) => {
    const ctx = c.get('ctx');
    const e = await activeEvent(c);
    const s = await sessionFor(ctx, readCookie(c.req.header('cookie'), HOST_COOKIE), 'host');
    return c.json({ hasEvent: !!e, name: e?.name ?? null, code: e?.code ?? null, loggedIn: !!e && !!s && s.event_id === e.id });
  });

  app.post('/host/login', async (c) => {
    const e = await activeEvent(c);
    if (!e) throw new HttpError(404, 'No event yet — create one');
    const b = await body(c, z.object({ password: z.string().min(1).max(128) }));
    const token = await loginHost(c.get('ctx'), e, b.password);
    c.header('set-cookie', sessionCookie(HOST_COOKIE, token, secure(c)));
    return c.json({ ok: true, code: e.code });
  });

  /** Create the first event (anyone, only while none exists) or a fresh one (logged-in host of the current event). */
  app.post('/host/start', async (c) => {
    const ctx = c.get('ctx');
    const b = await body(c, z.object({ name: z.string().min(2).max(80), password: z.string().min(6).max(128), teams: z.number().int().min(1).max(120).default(20) }));
    const current = await activeEvent(c);
    if (current) {
      const s = await sessionFor(ctx, readCookie(c.req.header('cookie'), HOST_COOKIE), 'host');
      if (!s || s.event_id !== current.id) throw new HttpError(401, 'Log in to the current event before starting a new one');
    }
    const ev = await startEvent(ctx, b.name, b.password);
    await ensureTeams(ctx, ev.id, b.teams);
    const token = await (await import('./auth')).createSession(ctx, ev.id, 'host', null);
    c.header('set-cookie', sessionCookie(HOST_COOKIE, token, secure(c)));
    return c.json(ev);
  });

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
    const [settings, turns, teams, subs, auditRows, storage, dbSize] = await ctx.db.batch([
      { text: `SELECT * FROM host_settings WHERE event_id=$1`, params: [e.id] },
      { text: `SELECT id, round_no, seq, title, bank_item, concepts, spin_at, preview_from, preview_until, deadline_at, revealed_at, locked_model, locked_mode, judge_mode
               FROM round_configs WHERE event_id=$1 AND spin_at IS NOT NULL ORDER BY spin_at DESC`, params: [e.id] },
      { text: `SELECT t.id, t.team_no, t.name, t.named, t.disabled, t.joined_at, c.pin_plain, c.locked_until,
                 (SELECT count(*)::int FROM auth_sessions a WHERE a.team_id=t.id AND NOT a.revoked AND a.expires_at>now()) AS sessions
               FROM teams t JOIN team_credentials c ON c.team_id=t.id WHERE t.event_id=$1 ORDER BY t.team_no NULLS LAST, t.created_at`, params: [e.id] },
      { text: `SELECT s.id, s.team_id, t.name AS team, s.round_id AS turn_id, r.round_no, s.status, s.flags, s.score_total, s.submitted_at, s.scored_at,
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
    return c.json({
      event: { id: e.id, code: e.code, name: e.name, phase: e.phase, registrationOpen: e.registration_open, projectorKey: e.projector_key },
      settings: s,
      turns,
      teams,
      submissions: subs.map((x: any) => ({ ...x, thumb_url: `/api/img/${x.thumb_image_id}`, image_url: `/api/img/${x.image_id}` })),
      audit: auditRows,
      models: MODELS,
      capabilities: ctx.capabilities,
      storageBackend: ctx.storageBackend,
      usage: {
        today: usage, storage, dbBytes: Number(dbSize[0]?.bytes ?? 0),
        limits: { aiNeuronsFreePerDay: 10000, workerRequestsFreePerDay: 100000, neonDbBytes: 1_000_000_000, neonObjectBytes: 5_000_000_000 },
        budget: await aiBudgetAvailable(ctx, e.id, s.judge_model, s.judge_provider),
      },
    });
  });

  /** One endpoint for the whole show: spin1 | spin2 | end | reveal | final */
  app.post('/events/:code/host/action', async (c) => {
    const e = await requireHost(c);
    const b = await body(c, z.object({
      action: z.enum(['spin1', 'spin2', 'end', 'reveal', 'final', 'mystery_start', 'mystery_end', 'judge_host', 'judge_ai']),
      title: z.string().max(60).optional(),
    }));
    return c.json(await hostAction(c.get('ctx'), e, b.action, { title: b.title }));
  });

  /** Mystery round points by team number */
  app.post('/events/:code/host/bonus', async (c) => {
    const e = await requireHost(c);
    const b = await body(c, z.object({ teamNo: z.number().int().min(1).max(500), points: z.number().int().min(-1000).max(1000).refine((x) => x !== 0, 'Points cannot be 0'), note: z.string().max(80).optional() }));
    return c.json(await addBonus(c.get('ctx'), e.id, b.teamNo, b.points, b.note));
  });
  app.delete('/events/:code/host/bonus/:id', async (c) => {
    const e = await requireHost(c);
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'Not found');
    await removeBonus(c.get('ctx'), e.id, id);
    return c.json({ ok: true });
  });

  /** The host's own score for one image */
  app.post('/events/:code/host/submissions/:id/score', async (c) => {
    const e = await requireHost(c);
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'Not found');
    const b = await body(c, z.object({ score: z.number().min(0).max(100) }));
    await hostScore(c.get('ctx'), e.id, id, Math.round(b.score * 2) / 2);
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

  app.post('/events/:code/host/teams', async (c) => {
    const e = await requireHost(c);
    const b = await body(c, z.object({ count: z.number().int().min(1).max(120) }));
    await ensureTeams(c.get('ctx'), e.id, b.count);
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
      ai_neuron_daily_cap: z.number().int().min(0).max(10000).optional(),      // can never exceed the free allocation (10,000)
      request_daily_cap: z.number().int().min(1000).max(100000).optional(),
      max_submissions_per_round: z.number().int().min(1).max(5).optional(),
      host_judges_next: z.boolean().optional(),
      r1_preview_sec: z.number().int().min(3).max(30).optional(),
      r1_duration_sec: z.number().int().min(60).max(1800).optional(),
      r2_duration_sec: z.number().int().min(60).max(1800).optional(),
    }));
    const ctx = c.get('ctx');
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (!keys.length) return c.json({ ok: true });
    await ctx.db.query(
      `UPDATE host_settings SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE event_id=$1`,
      [e.id, ...keys.map((k) => b[k])]);
    await audit(ctx, e.id, 'host', 'settings', b);
    return c.json({ ok: true });
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
    await ctx.db.query(`UPDATE events SET state_version=state_version+1 WHERE id=$1`, [e.id]);
    await audit(ctx, e.id, 'host', `submission_${action}`, { id });
    return c.json({ ok: true });
  });

  app.post('/events/:code/host/teams/:id/:action', async (c) => {
    const e = await requireHost(c);
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const action = c.req.param('action');
    let pin: string | undefined;
    if (action === 'new-pin') pin = await newPinFor(ctx, e.id, id);
    else if (action === 'disable' || action === 'enable') {
      await ctx.db.query(`UPDATE teams SET disabled=$3 WHERE id=$1 AND event_id=$2`, [id, e.id, action === 'disable']);
      await ctx.db.query(`UPDATE events SET state_version=state_version+1 WHERE id=$1`, [e.id]);
    } else throw new HttpError(404, 'Unknown action');
    await audit(ctx, e.id, 'host', `team_${action}`, { id });
    return c.json({ ok: true, pin });
  });

  return app;
}

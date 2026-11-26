import { describeReference, resolveR1Mode } from './ai/judge';
import type { AppContext } from './context';
import { hammingHex, hashSecret, sha256Hex, toHex } from './crypto';
import { bumpVersion, refreshLeaderboard } from './evaluation';
import { QuotaError, type ContentType } from './storage';
import { addUsage } from './usage';
import { MASHUP_REELS, ROUND1_SCENES, sceneUrl } from '../shared/bank';
import type { Phase } from '../shared/types';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function audit(ctx: AppContext, eventId: string | null, actor: string, action: string, detail: object = {}) {
  await ctx.db.query(`INSERT INTO audit_logs(event_id,actor,action,detail) VALUES($1,$2,$3,$4::jsonb)`,
    [eventId, actor, action, JSON.stringify(detail)]);
}

/** SQL: id of the event's current (most recently spun) turn. Needs alias `e` for events. */
export const CURRENT_TURN = `(SELECT ct.id FROM round_configs ct WHERE ct.event_id=e.id AND ct.spin_at IS NOT NULL ORDER BY ct.spin_at DESC LIMIT 1)`;

export const SPIN_SEC = { 1: 6, 2: 7 } as const;     // wheel / reels animation length
export const R2_PREVIEW_SEC = 5;                      // concepts shown big before uploads open
export const LEAD_SEC = 3;                            // 'get ready' so every screen (polling every 2.5 s) sees the whole spin

function pick<T>(xs: readonly T[], avoid: T[] = []): T {
  const pool = xs.filter((x) => !avoid.includes(x));
  const from = pool.length ? pool : xs;
  const r = new Uint32Array(1); crypto.getRandomValues(r);
  return from[r[0] % from.length];
}

/** Spin the wheel: creates a new turn with a server-authoritative timeline and opens it. */
export async function spin(ctx: AppContext, event: { id: string; phase: Phase }, roundNo: 1 | 2, actor = 'host') {
  if (event.phase.endsWith('_open')) throw new HttpError(409, 'A spin is still running — end it first');
  if (event.phase === 'final' || event.phase === 'closed') throw new HttpError(409, 'The event has finished');
  const [s] = await ctx.db.query<any>(`SELECT * FROM host_settings WHERE event_id=$1`, [event.id]);
  const used = await ctx.db.query<{ bank_item: string | null; concepts: any }>(
    `SELECT bank_item, concepts FROM round_configs WHERE event_id=$1 AND round_no=$2 AND spin_at IS NOT NULL`, [event.id, roundNo]);
  const [{ seq }] = await ctx.db.query<{ seq: number }>(
    `SELECT coalesce(max(seq),0)+1 AS seq FROM round_configs WHERE event_id=$1 AND round_no=$2 AND spin_at IS NOT NULL`, [event.id, roundNo]);

  const id = crypto.randomUUID();
  let title: string, brief: string, bankItem: string | null = null, concepts: string[] = [];
  let refId: string | null = null, mode = 'single', description: string | null = null;
  if (roundNo === 1) {
    const usedIds = used.map((u) => u.bank_item).filter(Boolean) as string[];
    const scene = pick(ROUND1_SCENES, ROUND1_SCENES.filter((x) => usedIds.includes(x.id)));
    bankItem = scene.id;
    title = scene.title;
    brief = 'Memorise the scene. When it disappears, recreate it with any AI image generator and drop your best image here.';
    const bytes = ctx.assets ? await ctx.assets(sceneUrl(scene.id, 'judge')) : null;
    if (!bytes) throw new HttpError(500, 'Scene image missing from the app bundle');
    refId = (await ctx.images.put({ eventId: event.id, kind: 'judge', bytes, contentType: 'image/jpeg' })).id;
    mode = resolveR1Mode(s.r1_mode, s.judge_model, ctx.capabilities.imagesBinding);
    if (mode === 'reference-description') {
      const ref = await ctx.images.get(refId);
      const out = await describeReference(ctx.providers(s.judge_provider, s.judge_model), ref!);
      description = out.text;
      await addUsage(ctx.db, 'ai_neurons', out.neurons);
    }
  } else {
    const prev = used.map((u) => (Array.isArray(u.concepts) ? u.concepts : JSON.parse(u.concepts ?? '[]')) as string[]);
    concepts = [
      pick(MASHUP_REELS.genre, prev.map((p) => p[0] as any)),
      pick(MASHUP_REELS.hero, prev.map((p) => p[1] as any)),
      pick(MASHUP_REELS.setting, prev.map((p) => p[2] as any)),
    ];
    title = `Movie Mashup ${seq}`;
    brief = 'Design the movie poster for this film. All three must be clearly visible in ONE image. No text needed.';
  }
  const spinSec = SPIN_SEC[roundNo];
  const previewSec = roundNo === 1 ? s.r1_preview_sec : R2_PREVIEW_SEC;
  const duration = roundNo === 1 ? s.r1_duration_sec : s.r2_duration_sec;
  await ctx.db.batch([
    { text: `INSERT INTO round_configs(id,event_id,round_no,seq,title,brief,duration_sec,bank_item,concepts,
               reference_image_id,reference_judge_image_id,reference_description,
               spin_at,preview_from,preview_until,opens_at,deadline_at,
               locked_provider,locked_model,locked_mode,locked_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10,$11,
               now()+make_interval(secs => $18), now()+make_interval(secs => $12), now()+make_interval(secs => $13),
               now()+make_interval(secs => $13), now()+make_interval(secs => $14),
               $15,$16,$17,now())`,
      params: [id, event.id, roundNo, seq, title, brief, duration, bankItem, JSON.stringify(concepts), refId, description,
        LEAD_SEC + spinSec, LEAD_SEC + spinSec + previewSec, LEAD_SEC + spinSec + previewSec + duration, s.judge_provider, s.judge_model, mode, LEAD_SEC] },
    { text: `UPDATE events SET phase=$2, phase_changed_at=now(), state_version=state_version+1, registration_open=false WHERE id=$1`,
      params: [event.id, roundNo === 1 ? 'r1_open' : 'r2_open'] },
  ]);
  await audit(ctx, event.id, actor, 'spin', { roundNo, seq, bankItem, concepts, model: s.judge_model, mode });
  return { turnId: id, roundNo, seq, title, bankItem, concepts };
}

/** The host's whole control surface: one action at a time. */
export async function hostAction(ctx: AppContext, event: { id: string; phase: Phase }, action: string) {
  const p = event.phase;
  const set = (to: Phase, extra: { text: string; params?: unknown[] }[] = []) => ctx.db.batch([
    ...extra,
    { text: `UPDATE events SET phase=$2, phase_changed_at=now(), state_version=state_version+1 WHERE id=$1`, params: [event.id, to] },
  ]);
  const current = `(SELECT ct.id FROM round_configs ct WHERE ct.event_id=$1 AND ct.spin_at IS NOT NULL ORDER BY ct.spin_at DESC LIMIT 1)`;
  switch (action) {
    case 'spin1': return spin(ctx, event, 1);
    case 'spin2': return spin(ctx, event, 2);
    case 'end': {
      if (!p.endsWith('_open')) throw new HttpError(409, 'Nothing is running');
      await set(p === 'r1_open' ? 'r1_judging' : 'r2_judging', [{
        text: `UPDATE round_configs SET deadline_at=least(deadline_at, now()), preview_until=least(preview_until, now()),
                 preview_from=least(preview_from, now()), opens_at=least(opens_at, now()) WHERE id=${current}`, params: [event.id] }]);
      break;
    }
    case 'reveal': {
      if (!/^r[12]_(open|judging)$/.test(p)) throw new HttpError(409, 'Nothing to reveal yet');
      await set(p.startsWith('r1') ? 'r1_results' : 'r2_results', [
        { text: `UPDATE round_configs SET deadline_at=least(deadline_at, now()), revealed_at=now() WHERE event_id=$1 AND spin_at IS NOT NULL AND revealed_at IS NULL`, params: [event.id] },
      ]);
      break;
    }
    case 'final': {
      if (p.endsWith('_open')) throw new HttpError(409, 'End the running spin first');
      await set('final', [{ text: `UPDATE round_configs SET revealed_at=now() WHERE event_id=$1 AND spin_at IS NOT NULL AND revealed_at IS NULL`, params: [event.id] }]);
      break;
    }
    default: throw new HttpError(404, 'Unknown action');
  }
  await refreshLeaderboard(ctx, event.id);
  await audit(ctx, event.id, 'host', `action_${action}`, { from: p });
  return { ok: true };
}

/** Lazily close a spin whose server deadline has passed (cron does the same every minute). */
export async function autoClose(ctx: AppContext, eventId: string) {
  await ctx.db.query(
    `UPDATE events e SET phase = CASE e.phase WHEN 'r1_open' THEN 'r1_judging' ELSE 'r2_judging' END,
            phase_changed_at=now(), state_version=e.state_version+1
     FROM round_configs r
     WHERE e.id=$1 AND e.phase IN ('r1_open','r2_open') AND r.id = ${CURRENT_TURN}
       AND r.deadline_at < now() - interval '5 seconds'`, [eventId]);
}

// ───────────── teams (host-issued numbers + PINs, BID WARS style) ─────────────

const fastHash = async (pin: string) => {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(8)));
  return `sha$${salt}$${await sha256Hex(salt + pin)}`;
};

function randomPin(): string {
  for (;;) {
    const r = new Uint32Array(1); crypto.getRandomValues(r);
    const pin = String(1000 + (r[0] % 9000));
    if (!/^(\d)\1+$/.test(pin) && !'0123456789'.includes(pin) && !'9876543210'.includes(pin)) return pin;
  }
}

/** Ensure Team 1..count exist. Existing teams keep their PINs. 4-digit PINs use a fast salted hash
 *  (the 10 ms CPU limit forbids dozens of PBKDF2 runs in one request; brute force is stopped by lockout). */
export async function ensureTeams(ctx: AppContext, eventId: string, count: number) {
  if (count < 1 || count > 120) throw new HttpError(400, 'Choose between 1 and 120 teams');
  const existing = await ctx.db.query<{ team_no: number }>(`SELECT team_no FROM teams WHERE event_id=$1 AND team_no IS NOT NULL`, [eventId]);
  const have = new Set(existing.map((t) => t.team_no));
  const stmts: { text: string; params: unknown[] }[] = [];
  for (let n = 1; n <= count; n++) {
    if (have.has(n)) continue;
    const id = crypto.randomUUID(), pin = randomPin();
    stmts.push({ text: `INSERT INTO teams(id,event_id,name,name_key,anon_label,team_no,named) VALUES($1,$2,$3,$4,$5,$6,false)`,
      params: [id, eventId, `Team ${n}`, `team ${n}`, `Entry ${n}`, n] });
    stmts.push({ text: `INSERT INTO team_credentials(team_id,pin_hash,pin_plain) VALUES($1,$2,$3)`, params: [id, await fastHash(pin), pin] });
  }
  if (stmts.length) await ctx.db.batch([...stmts, { text: `UPDATE events SET state_version=state_version+1 WHERE id=$1`, params: [eventId] }]);
  await audit(ctx, eventId, 'host', 'teams_created', { count, added: stmts.length / 2 });
}

export async function newPinFor(ctx: AppContext, eventId: string, teamId: string) {
  const pin = randomPin();
  await ctx.db.batch([
    { text: `UPDATE team_credentials SET pin_hash=$2, pin_plain=$3, failed_attempts=0, locked_until=NULL
             WHERE team_id=$1 AND team_id IN (SELECT id FROM teams WHERE event_id=$4)`, params: [teamId, await fastHash(pin), pin, eventId] },
    { text: `UPDATE auth_sessions SET revoked=true WHERE team_id=$1`, params: [teamId] },
  ]);
  return pin;
}

/** Create a brand-new active event (deactivates the previous one). */
export async function startEvent(ctx: AppContext, name: string, password: string) {
  if (password.length < 6) throw new HttpError(400, 'Host password must be at least 6 characters');
  const id = crypto.randomUUID();
  const code = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  await ctx.db.batch([
    { text: `UPDATE events SET active=false WHERE active` },
    { text: `INSERT INTO events(id,code,name,host_pass_hash,projector_key,active) VALUES($1,$2,$3,$4,$5,true)`,
      params: [id, code, name.trim().slice(0, 80) || 'Prompt to Pixel', await hashSecret(password, 20000), toHex(crypto.getRandomValues(new Uint8Array(16)))] },
    { text: `INSERT INTO host_settings(event_id) VALUES($1)`, params: [id] },
  ]);
  await audit(ctx, id, 'host', 'event_created', { name });
  return { id, code };
}

// ───────────── submissions ─────────────

export interface SubmissionFiles {
  full: { bytes: Uint8Array; type: ContentType; width?: number; height?: number };
  judge: { bytes: Uint8Array; type: ContentType };
  thumb: { bytes: Uint8Array; type: ContentType };
  dhash?: string;
  prompt?: string;
}

export async function createSubmission(ctx: AppContext, eventId: string, teamId: string, files: SubmissionFiles) {
  const [ev] = await ctx.db.query<any>(
    `SELECT e.phase, r.id AS round_id, r.round_no, r.deadline_at,
            (r.deadline_at + interval '5 seconds' > now()) AS in_time,
            (now() >= CASE WHEN r.round_no=1 THEN r.preview_until ELSE r.preview_from END) AS started,
            ri.sha256 AS reference_sha, hs.max_upload_bytes, hs.max_submissions_per_round, hs.storage_byte_cap, hs.bytea_byte_cap
     FROM events e
     JOIN round_configs r ON r.id = ${CURRENT_TURN}
     JOIN host_settings hs ON hs.event_id=e.id
     LEFT JOIN images ri ON ri.id=r.reference_judge_image_id
     WHERE e.id=$1 AND e.phase IN ('r1_open','r2_open')`, [eventId]);
  if (!ev) throw new HttpError(409, 'Nothing is accepting images right now');
  if (!ev.started) throw new HttpError(409, 'Wait for the countdown to start');
  if (!ev.in_time) { await autoClose(ctx, eventId); throw new HttpError(409, 'Time is up — uploads are closed'); }
  if (files.full.bytes.length > ev.max_upload_bytes) throw new HttpError(413, `Image too large (max ${Math.round(ev.max_upload_bytes / 1000)} KB after compression)`);
  if (files.judge.bytes.length > 250_000 || files.thumb.bytes.length > 120_000) throw new HttpError(413, 'Preview images too large');
  if (files.prompt && files.prompt.length > 2000) throw new HttpError(400, 'Prompt text too long');

  const [{ n }] = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM submissions WHERE round_id=$1 AND team_id=$2`, [ev.round_id, teamId]);
  if (n >= ev.max_submissions_per_round) throw new HttpError(429, `You've used all ${ev.max_submissions_per_round} uploads for this one`);

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
  if (ev.round_no === 1 && judge.sha256 === ev.reference_sha) flags.push('reference_copy');
  const others = await ctx.db.query<{ sha256: string; dhash: string | null }>(
    `SELECT i.sha256, s.dhash FROM submissions s JOIN images i ON i.id=s.image_id
     WHERE s.round_id=$1 AND s.team_id<>$2 AND s.status<>'superseded'`, [ev.round_id, teamId]);
  if (others.some((o) => o.sha256 === full.sha256)) flags.push('duplicate_exact');
  else if (dh && others.some((o) => o.dhash && hammingHex(dh, o.dhash) <= 4)) flags.push('near_duplicate');

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
  if (n > 0) await refreshLeaderboard(ctx, eventId);

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

/** Explicit, audited re-judge of every spin in a round with a new provider/model. Never automatic. */
export async function rejudgeRound(ctx: AppContext, eventId: string, roundNo: 1 | 2, provider: string, model: string, mode: string) {
  const turns = `SELECT id FROM round_configs WHERE event_id=$1 AND round_no=$2 AND spin_at IS NOT NULL`;
  const subs = `SELECT id FROM submissions WHERE round_id IN (${turns})`;
  await ctx.db.batch([
    { text: `UPDATE round_configs SET locked_provider=$3, locked_model=$4, locked_mode=$5, locked_at=now() WHERE id IN (${turns})`, params: [eventId, roundNo, provider, model, mode] },
    { text: `UPDATE evaluation_jobs SET status='cancelled', finished_at=now() WHERE status IN ('queued','retry','paused_quota','running') AND submission_id IN (${subs})`, params: [eventId, roundNo] },
    { text: `UPDATE evaluation_results SET is_published=false WHERE submission_id IN (${subs})`, params: [eventId, roundNo] },
    { text: `UPDATE submissions SET status='queued', score_total=NULL, scored_at=NULL
             WHERE round_id IN (${turns}) AND status NOT IN ('superseded','rejected') AND NOT ('reference_copy' = ANY(flags))`, params: [eventId, roundNo] },
    { text: `INSERT INTO evaluation_jobs(submission_id,last_enqueued_at) SELECT id, now() FROM submissions WHERE round_id IN (${turns}) AND status='queued'`, params: [eventId, roundNo] },
  ]);
  const jobs = await ctx.db.query<{ id: string; submission_id: string }>(
    `SELECT j.id, j.submission_id FROM evaluation_jobs j JOIN submissions s ON s.id=j.submission_id WHERE s.round_id IN (${turns}) AND j.status='queued'`, [eventId, roundNo]);
  try { if (jobs.length) await ctx.queue.sendBatch(jobs.map((j) => ({ jobId: j.id, submissionId: j.submission_id }))); }
  catch { await ctx.db.query(`UPDATE evaluation_jobs SET last_enqueued_at=NULL WHERE id = ANY($1::uuid[])`, [jobs.map((j) => j.id)]); }
  await audit(ctx, eventId, 'host', 'rejudge_round', { roundNo, provider, model, mode });
  await refreshLeaderboard(ctx, eventId);
}

export { bumpVersion };

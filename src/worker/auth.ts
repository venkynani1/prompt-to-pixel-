import type { AppContext } from './context';
import { hashSecret, randomToken, sha256Hex, verifySecret } from './crypto';
import { audit, HttpError } from './game';

export const TEAM_COOKIE = 'p2p_team';
export const HOST_COOKIE = 'p2p_host';
const SESSION_HOURS = 14;

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(name: string, token: string, secure: boolean) {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`;
}
export function clearCookie(name: string, secure: boolean) {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export async function createSession(ctx: AppContext, eventId: string, role: 'team' | 'host', teamId: string | null) {
  const token = randomToken(32);
  await ctx.db.query(
    `INSERT INTO auth_sessions(token_hash,event_id,role,team_id,expires_at) VALUES($1,$2,$3,$4, now()+make_interval(hours => $5))`,
    [await sha256Hex(token), eventId, role, teamId, SESSION_HOURS]);
  return token;
}

export async function sessionFor(ctx: AppContext, token: string | null, role: 'team' | 'host') {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const rows = await ctx.db.query<{ event_id: string; team_id: string | null; code: string }>(
    `SELECT a.event_id, a.team_id, e.code FROM auth_sessions a JOIN events e ON e.id=a.event_id
     LEFT JOIN teams t ON t.id=a.team_id
     WHERE a.token_hash=$1 AND a.role=$2 AND NOT a.revoked AND a.expires_at>now() AND (t.id IS NULL OR NOT t.disabled)`,
    [await sha256Hex(token), role]);
  return rows[0] ?? null;
}

export async function revokeSession(ctx: AppContext, token: string | null) {
  if (token) await ctx.db.query(`UPDATE auth_sessions SET revoked=true WHERE token_hash=$1`, [await sha256Hex(token)]);
}

export function normaliseTeamName(name: string) {
  const clean = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (clean.length < 2 || clean.length > 32) throw new HttpError(400, 'Team name must be 2–32 characters');
  if (!/^[\p{L}\p{N} _\-'.&!]+$/u.test(clean)) throw new HttpError(400, 'Team name has unsupported characters');
  return { name: clean, key: clean.toLowerCase() };
}

export function validatePin(pin: string) {
  if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'PIN must be 4–8 digits');
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw new HttpError(400, 'PIN is too easy to guess');
}

export async function registerTeam(ctx: AppContext, event: { id: string; registration_open: boolean }, rawName: string, pin: string) {
  if (!event.registration_open) throw new HttpError(403, 'Registration is closed');
  const { name, key } = normaliseTeamName(rawName);
  validatePin(pin);
  const [{ n }] = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM teams WHERE event_id=$1`, [event.id]);
  if (n >= 150) throw new HttpError(403, 'Team limit reached');
  const teamId = crypto.randomUUID();
  const pinHash = await hashSecret(pin, ctx.pinIterations);
  try {
    await ctx.db.batch([
      { text: `INSERT INTO teams(id,event_id,name,name_key,anon_label) VALUES($1,$2,$3,$4,$5)`, params: [teamId, event.id, name, key, `Entry ${n + 1}`] },
      { text: `INSERT INTO team_credentials(team_id,pin_hash) VALUES($1,$2)`, params: [teamId, pinHash] },
      { text: `UPDATE events SET state_version=state_version+1 WHERE id=$1`, params: [event.id] },
    ]);
  } catch (e) {
    if (/unique|duplicate/i.test(String(e))) throw new HttpError(409, 'That team name is taken — log in instead');
    throw e;
  }
  await audit(ctx, event.id, `team:${teamId}`, 'team_registered', { name });
  return { teamId, name, token: await createSession(ctx, event.id, 'team', teamId) };
}

export async function loginTeam(ctx: AppContext, eventId: string, rawName: string, pin: string) {
  const { key } = normaliseTeamName(rawName);
  const [row] = await ctx.db.query<any>(
    `SELECT t.id, t.name, t.disabled, c.pin_hash, c.failed_attempts, c.locked_until, (c.locked_until > now()) AS locked
     FROM teams t JOIN team_credentials c ON c.team_id=t.id WHERE t.event_id=$1 AND t.name_key=$2`, [eventId, key]);
  if (!row || row.disabled) throw new HttpError(401, 'Team name or PIN is wrong');
  if (row.locked) throw new HttpError(429, 'Too many wrong PINs — wait a minute or ask the host');
  if (!(await verifySecret(pin, row.pin_hash))) {
    const fails = row.failed_attempts + 1;
    // 5 failures → 1 min lock, doubling each further 5 (max 30 min)
    const lockSec = fails % 5 === 0 ? Math.min(1800, 60 * 2 ** (fails / 5 - 1)) : 0;
    await ctx.db.query(
      `UPDATE team_credentials SET failed_attempts=$2, locked_until = CASE WHEN $3 > 0 THEN now()+make_interval(secs => $3) ELSE locked_until END, updated_at=now() WHERE team_id=$1`,
      [row.id, fails, lockSec]);
    throw new HttpError(401, 'Team name or PIN is wrong');
  }
  await ctx.db.query(`UPDATE team_credentials SET failed_attempts=0, locked_until=NULL WHERE team_id=$1`, [row.id]);
  return { teamId: row.id as string, name: row.name as string, token: await createSession(ctx, eventId, 'team', row.id) };
}

/** Host login has a global per-event lockout too (stored on a pseudo team-less credential via audit counting). */
export async function loginHost(ctx: AppContext, event: { id: string; host_pass_hash: string }, password: string) {
  const [{ fails }] = await ctx.db.query<{ fails: number }>(
    `SELECT count(*)::int AS fails FROM audit_logs WHERE event_id=$1 AND action='host_login_failed' AND created_at > now()-interval '10 minutes'`, [event.id]);
  if (fails >= 8) throw new HttpError(429, 'Too many attempts — wait 10 minutes');
  if (!(await verifySecret(password, event.host_pass_hash))) {
    await audit(ctx, event.id, 'anonymous', 'host_login_failed');
    throw new HttpError(401, 'Wrong host password');
  }
  await audit(ctx, event.id, 'host', 'host_login');
  return createSession(ctx, event.id, 'host', null);
}

import type { AppContext } from './context';
import { autoClose, CURRENT_TURN } from './game';
import { requestEstimate } from './usage';
import { PHASE_ORDER, type LeaderRow, type Phase, type StateResponse } from '../shared/types';

export const idx = (p: Phase) => PHASE_ORDER.indexOf(p);

/**
 * Server-directed adaptive polling. The spin → preview → countdown timeline is sent once and rendered
 * locally, so devices only poll for host actions. Screens poll fast; phones poll slowly (they are
 * told to watch the big screen for the spin). Budget pressure stretches every interval.
 */
export function pollInterval(phase: Phase, role: 'team' | 'host' | 'projector' | 'anon', waitingForScore: boolean, requestsToday: number, requestCap: number): number {
  let ms: number;
  if (role === 'host' || role === 'projector') ms = 2500;
  else if (phase === 'lobby') ms = 8_000;
  else if (phase.endsWith('_open')) ms = 15_000;
  else if (phase.endsWith('_judging')) ms = waitingForScore ? 6_000 : 8_000;
  else if (phase.endsWith('_results')) ms = 8_000;
  else ms = 20_000;
  const pressure = requestCap > 0 ? requestsToday / requestCap : 0;
  if (pressure > 0.9) ms *= 4; else if (pressure > 0.7) ms *= 2;
  return ms;
}

export interface Viewer { teamTokenHash: string | null; hostTokenHash: string | null; projectorKey: string | null }

export async function loadEventHead(ctx: AppContext, code: string, v: Viewer) {
  const rows = await ctx.db.query<any>(
    `SELECT e.id, e.code, e.name, e.phase, e.registration_open, e.mystery_at, e.mystery_title, e.state_version::int AS version, now() AS server_now,
            (e.projector_key = $2) AS is_projector,
            (SELECT a.team_id FROM auth_sessions a JOIN teams t ON t.id=a.team_id
               WHERE a.token_hash=$3 AND a.event_id=e.id AND a.role='team' AND NOT a.revoked AND a.expires_at>now() AND NOT t.disabled) AS my_team_id,
            EXISTS(SELECT 1 FROM auth_sessions a WHERE a.token_hash=$4 AND a.event_id=e.id AND a.role='host' AND NOT a.revoked AND a.expires_at>now()) AS is_host,
            (SELECT count(*)::int FROM teams t WHERE t.event_id=e.id AND NOT t.disabled AND t.joined_at IS NOT NULL) AS team_count,
            EXISTS(SELECT 1 FROM round_configs r WHERE r.id = ${CURRENT_TURN} AND e.phase IN ('r1_open','r2_open')
                   AND r.deadline_at < now() - interval '5 seconds') AS overdue,
            hs.request_daily_cap
     FROM events e JOIN host_settings hs ON hs.event_id=e.id WHERE e.code=$1`,
    [code, v.projectorKey ?? '', v.teamTokenHash ?? '', v.hostTokenHash ?? '']);
  return rows[0] ?? null;
}

const LEADERBOARD_SQL = `
  SELECT t.id AS team_id, t.name,
         sum(s.score_total) FILTER (WHERE r.round_no=1)::float AS r1,
         sum(s.score_total) FILTER (WHERE r.round_no=2)::float AS r2,
         (SELECT coalesce(sum(b.points),0) FROM bonus_points b WHERE b.team_id=t.id)::float AS bonus,
         (coalesce(sum(s.score_total) FILTER (WHERE r.id IS NOT NULL),0)
           + (SELECT coalesce(sum(b.points),0) FROM bonus_points b WHERE b.team_id=t.id))::float AS total,
         max(s.submitted_at) FILTER (WHERE r.id IS NOT NULL) AS last_at
  FROM teams t
  LEFT JOIN submissions s ON s.team_id=t.id AND s.status='scored'
  LEFT JOIN round_configs r ON r.id=s.round_id AND r.revealed_at IS NOT NULL
  WHERE t.event_id=$1 AND NOT t.disabled AND t.joined_at IS NOT NULL
  GROUP BY t.id, t.name`;

export function rankRows(rows: any[]): LeaderRow[] {
  const sorted = rows
    .map((b) => ({ teamId: b.team_id, name: b.name, r1: b.r1 === null ? null : Number(b.r1), r2: b.r2 === null ? null : Number(b.r2), bonus: Number(b.bonus ?? 0), total: Number(b.total), rank: 0 }))
    .sort((a, b) => b.total - a.total || (b.r2 ?? 0) - (a.r2 ?? 0) || a.name.localeCompare(b.name));
  sorted.forEach((row, i, arr) => { // shared rank only when the total AND the Round 2 tiebreak are equal
    const p = arr[i - 1];
    row.rank = p && p.total === row.total && (p.r2 ?? 0) === (row.r2 ?? 0) ? p.rank : i + 1;
  });
  return sorted;
}

export async function buildState(ctx: AppContext, code: string, v: Viewer, ifNoneMatch: string | null):
  Promise<{ status: 200 | 304 | 404; body?: StateResponse; etag?: string; pollMs: number }> {
  let head = await loadEventHead(ctx, code, v);
  if (!head) return { status: 404, pollMs: 30_000 };
  if (head.overdue) { await autoClose(ctx, head.id); head = await loadEventHead(ctx, code, v); }

  const role: 'team' | 'host' | 'projector' | 'anon' = head.my_team_id ? 'team' : head.is_host ? 'host' : head.is_projector ? 'projector' : 'anon';
  const phase = head.phase as Phase;
  const etag = `W/"${head.version}-${role}-${head.my_team_id ?? '0'}"`;
  const reqToday = requestEstimate();
  const basePoll = pollInterval(phase, role, phase.endsWith('_judging'), reqToday, head.request_daily_cap);
  if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, etag, pollMs: basePoll };

  const [turnRows, progRows, boardRows, teamRows, meRows, awardRows] = await ctx.db.batch([
    { text: `SELECT r.* FROM round_configs r, events e WHERE e.id=$1 AND r.id = ${CURRENT_TURN}`, params: [head.id] },
    { text: `SELECT count(*) FILTER (WHERE s.status<>'superseded')::int AS submitted,
                    count(*) FILTER (WHERE s.status='scored')::int AS scored,
                    count(*) FILTER (WHERE s.status IN ('queued','evaluating','paused_quota','host_judging'))::int AS pending,
                    count(*) FILTER (WHERE s.status='failed')::int AS failed
             FROM submissions s, events e WHERE e.id=$1 AND s.round_id = ${CURRENT_TURN}`, params: [head.id] },
    { text: LEADERBOARD_SQL, params: [head.id] },
    { text: phase === 'lobby'
      ? `SELECT team_no, name, joined_at IS NOT NULL AS joined FROM teams WHERE event_id=$1 AND NOT disabled ORDER BY team_no NULLS LAST, created_at`
      : `SELECT 1 WHERE false AND $1::uuid IS NOT NULL`, params: [head.id] },
    { text: `SELECT t.name, t.team_no, t.named, s.id, s.round_id, r.round_no, r.revealed_at IS NOT NULL AS revealed, s.status,
                    s.thumb_image_id, s.score_total, s.submitted_at, er.criteria, er.feedback
             FROM teams t
             LEFT JOIN submissions s ON s.team_id=t.id AND s.status<>'superseded'
               AND s.round_id = (SELECT ct.id FROM round_configs ct WHERE ct.event_id=t.event_id AND ct.spin_at IS NOT NULL ORDER BY ct.spin_at DESC LIMIT 1)
             LEFT JOIN round_configs r ON r.id=s.round_id
             LEFT JOIN evaluation_results er ON er.submission_id=s.id AND er.is_published
             WHERE t.id=$1`, params: [head.my_team_id ?? '00000000-0000-0000-0000-000000000000'] },
    { text: head.mystery_at
      ? `SELECT b.id, b.points, b.note, t.team_no, t.name, t.id AS team_id FROM bonus_points b JOIN teams t ON t.id=b.team_id
         WHERE b.event_id=$1 AND b.created_at >= $2 ORDER BY b.created_at DESC LIMIT 60`
      : `SELECT 1 WHERE false AND $1::uuid IS NOT NULL AND $2::timestamptz IS NULL`, params: [head.id, head.mystery_at ?? null] },
  ]);

  const r = turnRows[0];
  const board = rankRows(boardRows);
  const anyRevealed = board.some((b) => b.r1 !== null || b.r2 !== null || b.bonus !== 0) || !!r?.revealed_at;
  const iso = (d: any) => (d ? new Date(d).toISOString() : '');
  const body: StateResponse = {
    version: head.version,
    serverNow: new Date(head.server_now).toISOString(),
    pollMs: basePoll,
    event: { code: head.code, name: head.name, phase, registrationOpen: head.registration_open, teamCount: head.team_count },
    mystery: head.mystery_at ? {
      title: head.mystery_title, since: iso(head.mystery_at),
      awards: awardRows.map((a: any) => ({ id: a.id, teamId: a.team_id, teamNo: a.team_no, name: a.name, points: Number(a.points), note: a.note })),
    } : null,
    round: r ? {
      turnId: r.id, roundNo: r.round_no, seq: r.seq, title: r.title, brief: r.brief, durationSec: r.duration_sec,
      spinAt: iso(r.spin_at), previewFrom: iso(r.preview_from), previewUntil: iso(r.preview_until), deadlineAt: iso(r.deadline_at),
      sceneId: r.bank_item, concepts: r.concepts ?? [], revealed: !!r.revealed_at, judgeMode: r.judge_mode ?? 'ai',
    } : null,
    progress: r ? progRows[0] as any : null,
    leaderboard: anyRevealed ? board : null,
    teams: phase === 'lobby' ? teamRows.map((t: any) => ({ no: t.team_no, name: t.name, joined: t.joined })) : undefined,
  };
  if (role === 'team' && meRows.length) {
    const m = meRows[0];
    const mine = board.find((b) => b.teamId === head.my_team_id);
    body.me = {
      teamId: head.my_team_id, name: m.name, teamNo: m.team_no, named: m.named,
      total: mine?.total ?? 0, rank: anyRevealed ? mine?.rank ?? null : null,
      current: m.id ? {
        id: m.id, turnId: m.round_id, roundNo: m.round_no,
        status: m.status === 'needs_review' || m.status === 'host_judging' ? 'queued' : m.status, // review flags are host-only
        thumbUrl: `/api/img/${m.thumb_image_id}`,
        score: m.revealed && m.status === 'scored' ? Number(m.score_total) : null,
        criteria: m.revealed && m.status === 'scored' ? m.criteria : null,
        feedback: m.revealed && m.status === 'scored' ? m.feedback : null,
        submittedAt: iso(m.submitted_at),
      } : null,
    };
    body.pollMs = pollInterval(phase, role, !!m.id && m.status !== 'scored', reqToday, head.request_daily_cap);
  }
  return { status: 200, body, etag, pollMs: body.pollMs };
}

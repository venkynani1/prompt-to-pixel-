import type { AppContext } from './context';
import { autoClose } from './game';
import { requestEstimate } from './usage';
import { PHASE_ORDER, phaseRound, type Phase, type StateResponse } from '../shared/types';

export const idx = (p: Phase) => PHASE_ORDER.indexOf(p);
export const resultsRevealed = (phase: Phase, roundNo: 1 | 2) => idx(phase) >= idx(roundNo === 1 ? 'r1_results' : 'r2_results');

/**
 * Server-directed adaptive polling. Countdowns are rendered locally from deadlineAt + serverNow,
 * so devices only need to poll for phase changes. Budget pressure stretches every interval.
 */
export function pollInterval(phase: Phase, role: 'team' | 'host' | 'projector' | 'anon', waitingForScore: boolean, requestsToday: number, requestCap: number): number {
  let ms: number;
  if (role === 'host' || role === 'projector') ms = phase.endsWith('_open') || phase.endsWith('_judging') ? 2500 : 4000;
  else if (phase === 'lobby') ms = 10_000;
  else if (phase.endsWith('_brief')) ms = 6_000;
  else if (phase.endsWith('_open')) ms = 15_000;           // client also polls once right after its local deadline
  else if (phase.endsWith('_judging')) ms = waitingForScore ? 6_000 : 10_000;
  else if (phase.endsWith('_results')) ms = 8_000;
  else ms = 20_000;
  const pressure = requestCap > 0 ? requestsToday / requestCap : 0;
  if (pressure > 0.9) ms *= 4; else if (pressure > 0.7) ms *= 2;
  return ms;
}

export interface Viewer { teamTokenHash: string | null; hostTokenHash: string | null; projectorKey: string | null }

export async function loadEventHead(ctx: AppContext, code: string, v: Viewer) {
  const rows = await ctx.db.query<any>(
    `SELECT e.id, e.code, e.name, e.phase, e.registration_open, e.state_version::int AS version, now() AS server_now,
            (e.projector_key = $2) AS is_projector,
            (SELECT a.team_id FROM auth_sessions a JOIN teams t ON t.id=a.team_id
               WHERE a.token_hash=$3 AND a.event_id=e.id AND a.role='team' AND NOT a.revoked AND a.expires_at>now() AND NOT t.disabled) AS my_team_id,
            EXISTS(SELECT 1 FROM auth_sessions a WHERE a.token_hash=$4 AND a.event_id=e.id AND a.role='host' AND NOT a.revoked AND a.expires_at>now()) AS is_host,
            (SELECT count(*)::int FROM teams t WHERE t.event_id=e.id AND NOT t.disabled) AS team_count,
            EXISTS(SELECT 1 FROM round_configs r WHERE r.event_id=e.id AND e.phase IN ('r1_open','r2_open')
                   AND r.round_no = CASE e.phase WHEN 'r1_open' THEN 1 ELSE 2 END AND r.deadline_at < now() - interval '5 seconds') AS overdue,
            hs.request_daily_cap
     FROM events e JOIN host_settings hs ON hs.event_id=e.id WHERE e.code=$1`,
    [code, v.projectorKey ?? '', v.teamTokenHash ?? '', v.hostTokenHash ?? '']);
  return rows[0] ?? null;
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
  // a team waiting for its own score polls faster only during judging; ETag lets cheap 304s through
  const basePoll = pollInterval(phase, role, phase.endsWith('_judging'), reqToday, head.request_daily_cap);
  if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, etag, pollMs: basePoll };

  const rn = phaseRound(phase) ?? (idx(phase) >= idx('final') ? 2 : null);
  const stmts: { text: string; params?: unknown[] }[] = [];
  stmts.push({ text: `SELECT round_no, title, brief, duration_sec, deadline_at, reference_image_id, concepts FROM round_configs WHERE event_id=$1 AND round_no=$2`, params: [head.id, rn ?? 0] });
  stmts.push({ text: `SELECT count(*) FILTER (WHERE s.status<>'superseded')::int AS submitted,
                             count(*) FILTER (WHERE s.status='scored')::int AS scored,
                             count(*) FILTER (WHERE s.status IN ('queued','evaluating','paused_quota'))::int AS pending,
                             count(*) FILTER (WHERE s.status='failed')::int AS failed
                      FROM submissions s JOIN round_configs r ON r.id=s.round_id WHERE r.event_id=$1 AND r.round_no=$2`, params: [head.id, rn ?? 0] });
  const showBoard = idx(phase) >= idx('r1_results');
  stmts.push({ text: showBoard
    ? `SELECT l.team_id, t.name, l.r1_score, l.r2_score, l.total, l.rank FROM leaderboard_entries l JOIN teams t ON t.id=l.team_id
       WHERE l.event_id=$1 ORDER BY l.rank NULLS LAST, t.name LIMIT 200`
    : `SELECT 1 WHERE false AND $1::uuid IS NOT NULL`, params: [head.id] });
  stmts.push({ text: `SELECT t.name, s.id, r.round_no, s.status, s.thumb_image_id, s.score_total, s.submitted_at, er.criteria, er.feedback
                      FROM teams t
                      LEFT JOIN submissions s ON s.team_id=t.id AND s.status<>'superseded'
                      LEFT JOIN round_configs r ON r.id=s.round_id
                      LEFT JOIN evaluation_results er ON er.submission_id=s.id AND er.is_published
                      WHERE t.id=$1 ORDER BY r.round_no`, params: [head.my_team_id ?? '00000000-0000-0000-0000-000000000000'] });
  const [roundRows, progRows, boardRows, meRows] = await ctx.db.batch(stmts);

  const r = roundRows[0];
  const r2Revealed = resultsRevealed(phase, 2);
  const body: StateResponse = {
    version: head.version,
    serverNow: new Date(head.server_now).toISOString(),
    pollMs: basePoll,
    event: { code: head.code, name: head.name, phase, registrationOpen: head.registration_open, teamCount: head.team_count },
    round: r ? {
      roundNo: r.round_no,
      title: r.title,
      brief: r.brief,
      durationSec: r.duration_sec,
      deadlineAt: r.deadline_at ? new Date(r.deadline_at).toISOString() : null,
      referenceImageUrl: r.round_no === 1 && r.reference_image_id && (idx(phase) >= idx('r1_open') || role === 'host')
        ? `/api/img/${r.reference_image_id}${role === 'projector' ? `?pk=${encodeURIComponent(v.projectorKey!)}` : ''}` : null,
      concepts: r.round_no === 2 && (idx(phase) >= idx('r2_open') || role === 'host') ? (r.concepts ?? []) : [],
    } : null,
    progress: rn ? progRows[0] as any : null,
    leaderboard: showBoard ? boardRows.map((b: any) => ({
      teamId: b.team_id, name: b.name,
      r1: b.r1_score === null ? null : Number(b.r1_score),
      r2: r2Revealed && b.r2_score !== null ? Number(b.r2_score) : null,
      total: r2Revealed ? Number(b.total) : Number(b.r1_score ?? 0),
      rank: b.rank ?? 0,
    })) : null,
  };
  if (body.leaderboard && !r2Revealed) {
    // before Round 2 is revealed, rank on Round 1 only
    body.leaderboard.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    body.leaderboard.forEach((row, i, arr) => { row.rank = i > 0 && arr[i - 1].total === row.total ? arr[i - 1].rank : i + 1; });
  }
  if (role === 'team' && meRows.length) {
    body.me = {
      teamId: head.my_team_id,
      name: meRows[0].name,
      submissions: meRows.filter((m: any) => m.id).map((m: any) => {
        const revealed = resultsRevealed(phase, m.round_no);
        return {
          id: m.id, roundNo: m.round_no,
          status: m.status === 'needs_review' ? 'queued' : m.status, // review flags are host-only
          thumbUrl: `/api/img/${m.thumb_image_id}`,
          score: revealed && m.status === 'scored' ? Number(m.score_total) : null,
          criteria: revealed && m.status === 'scored' ? m.criteria : null,
          feedback: revealed && m.status === 'scored' ? m.feedback : null,
          submittedAt: new Date(m.submitted_at).toISOString(),
        };
      }),
    };
    const waiting = body.me.submissions.some((s) => s.roundNo === rn && s.status !== 'scored');
    body.pollMs = pollInterval(phase, role, waiting, reqToday, head.request_daily_cap);
  }
  return { status: 200, body, etag, pollMs: body.pollMs };
}

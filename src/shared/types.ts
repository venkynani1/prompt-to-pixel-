export type Phase =
  | 'lobby'
  | 'r1_brief' | 'r1_open' | 'r1_judging' | 'r1_results'
  | 'r2_brief' | 'r2_open' | 'r2_judging' | 'r2_results'
  | 'final' | 'closed';

export const PHASE_ORDER: Phase[] = [
  'lobby', 'r1_brief', 'r1_open', 'r1_judging', 'r1_results',
  'r2_brief', 'r2_open', 'r2_judging', 'r2_results', 'final', 'closed',
];

export function phaseRound(p: Phase): 1 | 2 | null {
  if (p.startsWith('r1_')) return 1;
  if (p.startsWith('r2_')) return 2;
  return null;
}

export const PHASE_LABEL: Record<Phase, string> = {
  lobby: 'Lobby',
  r1_brief: 'Round 1 briefing', r1_open: 'Round 1 live', r1_judging: 'Round 1 judging', r1_results: 'Round 1 results',
  r2_brief: 'Round 2 briefing', r2_open: 'Round 2 live', r2_judging: 'Round 2 judging', r2_results: 'Round 2 results',
  final: 'Final standings', closed: 'Closed',
};

export type SubmissionStatus =
  | 'queued' | 'evaluating' | 'scored' | 'needs_review' | 'failed' | 'paused_quota' | 'superseded' | 'rejected' | 'host_judging';

export interface PublicRound {
  turnId: string;
  roundNo: 1 | 2;
  seq: number;
  title: string;
  brief: string;
  durationSec: number;
  spinAt: string;          // wheel starts
  previewFrom: string;     // wheel stops → scene / concepts shown
  previewUntil: string;    // round 1: scene hidden; uploads open
  deadlineAt: string;
  sceneId: string | null;  // round 1 scene (bank id)
  concepts: string[];      // round 2 [genre, hero, setting]
  revealed: boolean;
  judgeMode: 'ai' | 'host'; // who scores this spin
}

export interface LeaderRow {
  teamId: string;
  name: string;
  r1: number | null;
  r2: number | null;
  bonus: number;           // Mystery round points
  total: number;
  rank: number;
}

export interface MySubmission {
  id: string;
  turnId: string;
  roundNo: 1 | 2;
  status: SubmissionStatus;
  thumbUrl: string;
  score: number | null;
  criteria: Record<string, number> | null;
  feedback: string | null;
  submittedAt: string;
}

export interface StateResponse {
  version: number;
  serverNow: string;
  pollMs: number;
  event: { code: string; name: string; phase: Phase; registrationOpen: boolean; teamCount: number };
  mystery: { title: string | null; since: string; awards: MysteryAward[] } | null; // a Mystery round is on: spins paused
  round: PublicRound | null;   // the current (latest) spin
  progress: { submitted: number; scored: number; pending: number; failed: number } | null;
  leaderboard: LeaderRow[] | null;   // revealed scores only
  teams?: { no: number | null; name: string; joined: boolean }[];  // lobby roll-call
  me?: {
    teamId: string; name: string; teamNo: number | null; named: boolean;
    current: MySubmission | null;       // my entry for the current spin
    total: number; rank: number | null;
  };
}

export interface MysteryAward { id: string; teamId: string; teamNo: number | null; name: string; points: number; note: string | null }

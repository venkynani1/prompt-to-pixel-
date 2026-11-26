import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { criteriaFor } from '../../shared/rubrics';
import type { LeaderRow } from '../../shared/types';
import { fmtClock } from '../lib';

export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'xl' }) {
  const cls = size === 'xl' ? 'text-[clamp(3rem,9vw,8rem)]' : size === 'md' ? 'text-3xl' : 'text-xl';
  return (
    <span className={`display font-extrabold ${cls} inline-flex items-baseline gap-[0.18em]`} aria-label="Prompt to Pixel">
      <span aria-hidden>Prompt</span>
      <span aria-hidden className="inline-flex gap-[0.06em] translate-y-[-0.05em]">
        <i className="block w-[0.16em] h-[0.62em] rounded-[2px] bg-sub-r" />
        <i className="block w-[0.16em] h-[0.62em] rounded-[2px] bg-sub-g" />
        <i className="block w-[0.16em] h-[0.62em] rounded-[2px] bg-sub-b" />
      </span>
      <span aria-hidden className="rgb-split">Pixel</span>
    </span>
  );
}

export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto px-5 pb-16 pt-6 ${wide ? 'max-w-7xl' : 'max-w-lg'}`}
      style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }}>{children}</div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'ok'; children: ReactNode }) {
  const color = kind === 'error' ? 'text-sub-r' : kind === 'ok' ? 'text-sub-g' : 'text-muted';
  return <p role={kind === 'error' ? 'alert' : 'status'} className={`text-sm ${color}`}>{children}</p>;
}

/** Big countdown. The digits carry the RGB split; the last 10 s go red. */
export function Countdown({ ms, big = false }: { ms: number | null; big?: boolean }) {
  if (ms === null) return null;
  const urgent = ms <= 10_000;
  return (
    <div className={`display font-extrabold tabular-nums ${big ? 'text-[clamp(6rem,22vw,18rem)]' : 'text-7xl'} ${urgent ? 'text-sub-r' : 'rgb-split'}`}
      style={{ fontVariationSettings: '"wdth" 75' }} role="timer" aria-live="off" aria-label={`${Math.ceil(ms / 1000)} seconds left`}>
      {fmtClock(ms)}
    </div>
  );
}

export function ScoreBreakdown({ roundNo, criteria }: { roundNo: 1 | 2; criteria: Record<string, number> }) {
  return (
    <dl className="grid gap-2">
      {criteriaFor(roundNo).map((c) => (
        <div key={c.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
          <dt className="text-sm text-muted">{c.label}</dt>
          <dd className="text-sm tabular-nums">{((criteria[c.key] ?? 0) / 10 * c.weight).toFixed(1)} / {c.weight}</dd>
          <div className="col-span-2 h-1.5 rounded-full bg-panel-2 overflow-hidden">
            <div className="h-full bg-sub-g" style={{ width: `${(criteria[c.key] ?? 0) * 10}%` }} />
          </div>
        </div>
      ))}
    </dl>
  );
}

/** The one orchestrated reveal: rows resolve from coloured pixel blocks into names, bottom-up. */
export function Leaderboard({ rows, highlight, limit = 50, big = false, showRounds = true }: { rows: LeaderRow[]; highlight?: string; limit?: number; big?: boolean; showRounds?: boolean }) {
  const reduce = useReducedMotion();
  const shown = rows.slice(0, limit);
  return (
    <ol className="grid gap-1.5">
      <AnimatePresence initial>
        {shown.map((r, i) => (
          <motion.li key={r.teamId} layout
            initial={reduce ? false : { opacity: 0, clipPath: 'inset(0 100% 0 0)' }}
            animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }}
            transition={{ delay: reduce ? 0 : (shown.length - i) * 0.07, duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
            className={`grid grid-cols-[3ch_1fr_auto] items-baseline gap-4 rounded-lg px-4 ${big ? 'py-3 text-3xl' : 'py-2.5'} ${r.teamId === highlight ? 'bg-panel-2 ring-2 ring-sub-g' : i < 3 ? 'bg-panel' : ''}`}>
            <span className={`display font-extrabold tabular-nums ${i === 0 ? 'text-sub-g' : i === 1 ? 'text-sub-b' : i === 2 ? 'text-sub-r' : 'text-muted'}`}>{r.rank}</span>
            <span className="truncate font-bold">{r.name}</span>
            <span className="tabular-nums text-right">
              {showRounds && <span className="text-muted text-[0.7em] mr-3">{r.r1 ?? '–'}{r.r2 !== null ? ` + ${r.r2}` : ''}{r.bonus ? ` ${r.bonus > 0 ? '+' : '−'} ${Math.abs(r.bonus)} mystery` : ''}</span>}
              <span className="display font-extrabold">{r.total.toFixed(1)}</span>
            </span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    queued: ['Waiting for the judge', 'text-muted'], evaluating: ['Judging now', 'text-sub-b'], scored: ['Judged', 'text-sub-g'],
    needs_review: ['Held for review', 'text-warn'], failed: ['Judging failed', 'text-sub-r'], paused_quota: ['Paused (AI quota)', 'text-warn'],
    rejected: ['Rejected', 'text-sub-r'], superseded: ['Replaced', 'text-muted'], host_judging: ['Waiting for your score', 'text-warn'],
  };
  const [label, cls] = map[status] ?? [status, 'text-muted'];
  return <span className={`text-sm font-bold ${cls}`}>{label}</span>;
}

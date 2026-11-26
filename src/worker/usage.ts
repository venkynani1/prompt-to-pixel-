import type { Db } from './db';

export type Metric = 'ai_neurons' | 'ai_calls' | 'ai_failures' | 'worker_requests' | 'uploads' | 'upload_bytes' | 'queue_ops';

export async function addUsage(db: Db, metric: Metric, value: number) {
  if (!value) return;
  await db.query(
    `INSERT INTO usage_daily(day,metric,value) VALUES((now() AT TIME ZONE 'utc')::date,$1,$2)
     ON CONFLICT (day,metric) DO UPDATE SET value = usage_daily.value + EXCLUDED.value`,
    [metric, value]);
}

export async function todayUsage(db: Db): Promise<Record<string, number>> {
  const rows = await db.query<{ metric: string; value: string }>(
    `SELECT metric, value::text FROM usage_daily WHERE day=(now() AT TIME ZONE 'utc')::date`);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.metric] = Number(r.value);
  return out;
}

/**
 * Per-isolate request counter. Writing to Postgres on every poll would double DB load,
 * so counts are flushed in blocks of FLUSH_EVERY (approximate but cheap).
 */
const FLUSH_EVERY = 20;
let pending = 0;
let lastKnownToday = 0;
let lastKnownAt = 0;

export function countRequest(db: Db, waitUntil: (p: Promise<unknown>) => void) {
  pending++;
  if (pending >= FLUSH_EVERY) {
    const n = pending;
    pending = 0;
    waitUntil(
      db.query<{ value: string }>(
        `INSERT INTO usage_daily(day,metric,value) VALUES((now() AT TIME ZONE 'utc')::date,'worker_requests',$1)
         ON CONFLICT (day,metric) DO UPDATE SET value = usage_daily.value + EXCLUDED.value RETURNING value::text`, [n])
        .then((r) => { lastKnownToday = Number(r[0]?.value ?? 0); lastKnownAt = Date.now(); })
        .catch(() => {}),
    );
  }
}

/** Last flushed estimate of today's Worker requests (good enough for adaptive polling back-off). */
export function requestEstimate(): number {
  // a value older than 10 minutes might be from yesterday's UTC day
  return Date.now() - lastKnownAt > 600_000 ? 0 : lastKnownToday;
}

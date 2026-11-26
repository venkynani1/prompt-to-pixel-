# Load test — local stack (simulated judge)

Run: 2026-11-26T11:42:12.966Z → 2026-11-26T11:45:27.882Z
Target: `http://localhost:8799` · 100 team sessions · 100 simultaneous uploads

> Real application code and SQL, served by a separate local process on PGlite (single in-process Postgres) instead of Neon, with no internet hops, and a SIMULATED AI judge (3000 ms per evaluation, concurrency 4). Neuron figures are estimates from the simulated token counts.
> This shows the app logic copes with 100 concurrent sessions. It is NOT evidence of Cloudflare/Neon latency or real AI timing; run `npm run loadtest:remote` after deploying for that.

## Latency (ms)

| Operation | Count | p50 | p95 | Max |
|---|---|---|---|---|
| Registration (burst) | 100 | 374 | 655 | 686 |
| Upload + submit (burst) | 100 | 2296 | 3250 | 3330 |
| State poll | 2083 | 6 | 12 | 3300 |

## Results

- Registration errors: **0** of 100
- Upload errors: **0** of 100
- Upload size per submission (full + judge + thumb): p50 623 KB, max 641 KB
- Countdown sync: 100 devices, spread of locally computed deadlines **14 ms**
- Judging: **100/100** scored, 0 failed, 0 paused for quota, 0 held for review
- Time from upload burst to all judged: **130.1 s**; from round close: **126.8 s** (target ≤ 300 s)
- Per-evaluation latency: p50 3000 ms, p95 3000 ms
- AI neurons used today (estimate): 1758 across 101 calls (per eval p50 17)
- Leaderboard reveal reached 100 devices within 25 s (p50 6385 ms, p95 9449 ms)
- Polling: 2083 requests, 236 were 304 Not Modified, 0 errors, **6.96 requests per device per minute**

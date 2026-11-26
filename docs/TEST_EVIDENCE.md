# Test evidence and readiness status

**Status: not production-ready yet.** The code is complete and tested locally. The checks that need your Cloudflare/Neon accounts haven't been run, because no credentials were available in the build environment.

## Done (26 Nov 2026, build environment)

| Check | Result |
|---|---|
| Type-check (Worker + React app) | ✅ pass |
| Production build, Worker bundle (`wrangler deploy --dry-run`) | ✅ 216 KB gzipped |
| Unit + integration tests (`npm test`): real PostgreSQL 17 via PGlite, real HTTP handlers, fake AI | ✅ **31 / 31 pass** |
| Migration applied twice (idempotent) on PostgreSQL 17 | ✅ |
| Full two-round game driven in headless Chrome with screenshots (`docs/screens/`) | ✅ |
| 100-session local load test (`docs/reports/LOADTEST_LOCAL.md`, simulated 3 s judge) | ✅ 0 errors; 100/100 judged in 130 s; countdown spread 14 ms |

What the integration tests prove:
- Full game flow, with totals computed on the backend.
- Scores stay hidden until results are revealed.
- Duplicate queue deliveries plus 3 concurrent workers produce exactly 1 AI call and 1 published score.
- Invalid AI output gives retries with backoff, then `failed` with **no score**; host retry recovers it.
- Quota pause → resume via the reconciler.
- Provider quota errors pause rather than fail.
- Lost queue messages and expired leases are recovered.
- The concurrency limit is respected.
- Exact duplicates are flagged; reference copies are held **without** an AI call.
- Prompt-injection flag works.
- Server deadline is enforced and the round auto-closes.
- Resubmission supersedes the earlier entry and the per-round limit holds.
- The judge is locked at round open; changing it takes an explicit, confirmed re-judge.
- PIN lockout and weak-PIN rejection work; host routes are protected.
- Images stay private until reveal; cross-origin writes are blocked.
- ETag 304 polling works.
- The object-storage path works.
- Calibration works.

## Still required before the event (run on separate days)

| Check | Command | Why it can't be done here |
|---|---|---|
| Deploy to workers.dev | `npm run setup` | needs your Cloudflare + Neon credentials |
| Neon Object Storage availability for your project | setup prints which backend is active | beta feature; per-project |
| Real model benchmark: accuracy, consistency, JSON validity, neurons/eval, latency | `npm run benchmark` | uses your Workers AI quota |
| Confirm about 130 evaluations fit under 8,500 neurons | benchmark report column *Evals in 8,500 cap* | depends on real token usage |
| 100-session load test with the real judge; 5-minute judging window | `npm run loadtest:remote` | needs deployment |
| No `exceededCpu` on the 10 ms Free CPU limit | `npx wrangler tail` during the remote load test | Cloudflare-only measurement |
| Corporate approval of Cloudflare/Neon processing + Llama licence | see the Free-tier report | organisational decision |

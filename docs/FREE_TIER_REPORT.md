# Free-tier usage report

Target additional infrastructure cost: **₹0**. Limits below were checked against official documentation on **26 Nov 2026**. Free tiers change — re-check the linked pages the week before the event.

## Verified limits

| Service | Free allocation (as documented) | What happens at the limit | Source |
|---|---|---|---|
| Workers requests | 100,000 / day, resets 00:00 UTC (05:30 IST) | Error 1027 for the rest of the UTC day | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers CPU | **10 ms per HTTP request** (wall time unlimited) | Error 1102 | same |
| Static assets | Free and unlimited | — | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers AI | 10,000 neurons / day, resets 00:00 UTC | Calls fail; needs Workers Paid to go further | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Queues | On Workers Free since Feb 2026; 10,000 operations / day; 24 h retention | Not documented for Free — treat as hard stop | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [changelog](https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/) |
| Images binding (optional) | 5,000 unique transformations / month | New transformations fail (9422); no charge | [Images pricing](https://developers.cloudflare.com/images/pricing/) |
| Neon Postgres | 1 GB storage / project, 100 CU-hours / project / month, 5 GB transfer; no card required | Writes that grow storage fail; compute suspends. **No overage billing on Free** | [Neon free plan FAQ](https://neon.com/faqs/free-plan-limits-and-quotas) |
| Neon Object Storage | 5 GB / project; **beta**, free during beta; regions: US East (Ohio, N. Virginia), Frankfurt, **Singapore** | Throttling with `503 SlowDown` | [Object Storage overview](https://neon.com/docs/storage/overview) |

## Workers AI model costs (neurons per million tokens, from the pricing page)

| Model | Input | Output | Multi-image (expected) |
|---|---|---|---|
| Llama 3.2 11B Vision | 4,410 | 61,493 | No — needs composite or written-description mode |
| Llama 4 Scout 17B | 24,545 | 77,273 | Yes |
| Gemma 3 12B | 31,371 | 50,560 | Yes |
| Mistral Small 3.1 24B | 31,876 | 50,488 | Yes |

**Estimated** cost per evaluation (≈2,000 input tokens incl. image, ≈200 output): Llama 3.2 ≈ 21 neurons; Gemma 3 ≈ 70; Llama 4 Scout ≈ 65–100 with two images. **100 evaluations + calibration + retries ≈ 130 calls**:

- Llama 3.2: ≈ 2,700 neurons — fits comfortably.
- Gemma 3 / Mistral: ≈ 9,000 — at or over the 8,500 app cap.
- Llama 4 Scout with two images: likely **does not fit**.

These are estimates. Image-token counts are model-specific and not published, so `npm run benchmark` measures the real numbers from the API's `usage` field. **Pick the model from `docs/reports/BENCHMARK.md`, not from this table.**

## Application-level hard budgets (enforced in code)

| Budget | Default | Where |
|---|---|---|
| AI neurons/day | 8,500 (below 10,000; host can lower, cannot exceed 10,000) | `host_settings.ai_neuron_daily_cap`; checked **before** every AI call using the recent average cost × 1.2 |
| Worker requests/day | 85,000 (estimate) | polling intervals ×2 above 70 %, ×4 above 90 % |
| Object storage | 4 GB of 5 GB | upload refused with a clear message |
| Postgres image fallback | 600 MB of 1 GB | upload refused with a clear message |
| Upload size | 900 KB full image (client compresses to ≈300–480 KB) | server-side check + magic-byte sniffing |
| Uploads per team per round | 2 | prevents AI budget drain by resubmission |

When an AI budget is reached, jobs go to `paused_quota`; **no submission is lost and no score is invented**. The cron reconciler resumes them automatically once budget is available (e.g. after 05:30 IST), or the host raises the cap.

## Request budget for a real event (50 teams, ~3 hours)

| Source | Estimate |
|---|---|
| Team polling (adaptive: 10 s lobby, 6 s brief, 15 s live, 6–10 s judging, 8 s results) | ≈ 33,000 |
| Projector + host (2.5–4 s) + host console (4 s) | ≈ 10,000 |
| Images served through the Worker (thumbnails, gallery, reference) | ≈ 3,000 |
| Registrations, uploads, logins | < 1,000 |
| **Total** | **≈ 47,000 of 100,000** |

The local load test measured **≈ 7 polls per device per minute during the busiest phases**. ⚠ **This assumes ONE logged-in phone per team.** Three phones per team roughly doubles team polling to ≈ 80,000. The automatic back-off then slows everyone down; the hard stop is still 100,000. Ask teams to use one phone; the host console shows devices per team.

Static files (the React app) are free and do not count.

## Other free-tier checks

- **Workers CPU (10 ms)**: all pixel work happens in the browser — compression, the 512 px judge copy, the thumbnail and the duplicate hash. Composites go through the Images binding, and images are streamed rather than decoded. PIN hashing uses 20,000 PBKDF2 iterations (native WebCrypto), with per-team lockout as the real brute-force defence. **Not yet measured on Cloudflare** — check `wrangler tail` for `exceededCpu` during the remote load test.
- **Queues**: about 3 operations per evaluation plus about 1 per redelivery; 130 evaluations use well under 1,000 of the 10,000. Shown in the host console.
- **Neon compute**: one event of about 4 hours at 0.25–2 CU uses at most about 8 of 100 CU-hours. Scale-to-zero after 5 minutes means the first request after idle takes about 0.5–1 s extra.
- **Neon storage (BYTEA fallback)**: 100 submissions × about 600 KB (full + judge + thumbnail) ≈ 60 MB.
- **Worker bundle**: 216 KB gzipped (measured with `wrangler deploy --dry-run`).

## Real-time sync decision

- **Adaptive polling with ETags** (304 when nothing changed) is used, as required. Countdowns are rendered locally from the server deadline plus an NTP-style clock offset (smallest round-trip wins). In the local load test, devices agreed within **14 ms**.
- **Durable Objects + hibernating WebSockets** would cut request usage substantially. They are on the Workers Free plan, but polling already fits the budget with about 2× headroom for 50 teams. They're the next step only if more than 1 device per team is required.
- **Neon Realtime** was not adopted: it would need a long-lived client connection to the database, which would expose database credentials or need a separate relay.

## Data processing and corporate approval — action needed by you

The app sends only image pixels and rubric text to the AI judge. It never sends team names, prompts, employee names or emails, and it collects no personal data beyond a team name and a hashed PIN.

The following is still **your decision**, and needs approval from Hexaware's InfoSec/legal team **before** the event. A technical design can't confirm it.

1. Uploaded images are processed by **Cloudflare (Workers AI)** and stored by **Neon** (Singapore region). Both are US companies acting as processors. Their terms (Cloudflare Self-Serve Subscription Agreement, Neon Terms and DPA) must be acceptable for a corporate event under Indian DPDP Act obligations.
2. **Llama 3.2 Vision** requires accepting Meta's Llama 3.2 Community Licence and Acceptable Use Policy. `npm run setup` sends the acceptance request — **you** are the one agreeing, on behalf of whoever owns the Cloudflare account.
3. Free accounts should belong to someone authorised to accept those terms for the event. If it's a personal account, confirm that's allowed.
4. Brief participants not to upload confidential client material, faces of non-consenting people, or anything they wouldn't show on the projector.

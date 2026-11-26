# Deployment (free tiers only, ~15 minutes)

You run **one command, once**, from any computer with Node.js 20+. After that the app lives entirely on Cloudflare and Neon. Your laptop is not a server and can be switched off.

Nothing here asks for a credit card or a paid plan. If any screen asks you to upgrade or add billing, stop — you're in the wrong place.

## 1. Free accounts

1. **Cloudflare**: sign up at dash.cloudflare.com. Open **Workers & Pages** once and pick your free `*.workers.dev` subdomain (deploys fail until this is done).
2. **Neon**: sign up at neon.com (Free plan, no card).
3. **GitHub**: create an empty private repo (e.g. `venkynani1/prompt-to-pixel`) and push this code:
   ```bash
   git remote add origin https://github.com/venkynani1/prompt-to-pixel.git
   git push -u origin main
   ```

## 2. Credentials (create them, keep them private)

| Value | Where |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → right sidebar *Account ID* |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → *Create Token* → template **Edit Cloudflare Workers**. Make sure it also has **Account → Workers AI → Edit** and **Account → Queues → Edit**. |
| `NEON_API_KEY` | Neon console → Account settings → API keys (or skip it and pass `DATABASE_URL` from a project you created by hand, region **AWS Asia Pacific (Singapore)**) |

**Neon Object Storage (optional but preferred)**: in the Neon console, open the project → *Object Storage* (beta) → create a **private** bucket named `p2p-images`. Copy its S3 endpoint, region and access key/secret into the `S3_*` variables below. If you skip this, or the feature isn't available for your project, images go into Postgres (BYTEA, capped at 600 MB). That's ample for 100 submissions, at about 60 MB.

## 3. Deploy

macOS / Linux / Git Bash:
```bash
npm ci
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… NEON_API_KEY=… \
EVENT_CODE=PIXEL1 EVENT_NAME="Hexaware Innovation Day" \
S3_ENDPOINT=… S3_BUCKET=p2p-images S3_REGION=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
npm run setup
```
Windows PowerShell: set each with `$env:CLOUDFLARE_API_TOKEN="…"`, then `npm run setup`.

`npm run setup`:
1. Creates the Neon project in Singapore, unless you gave a `DATABASE_URL`.
2. Applies the migrations.
3. Creates the two queues.
4. Accepts the Llama 3.2 licence.
5. Builds and deploys the app.
6. Uploads the secrets.
7. Creates your event.

It then prints the **participant URL, host console, projector URL** and host password, and saves them to `deploy-output.txt` (gitignored). It's safe to re-run, and it remembers generated values in `.setup-state.json`, which is also gitignored.

**Optional — Images binding**: to let single-image models (Llama 3.2) compare Round 1 as a side-by-side panel, uncomment the `images` block in `wrangler.jsonc` and run `npm run deploy`. The Free plan covers 5,000 transformations a month, and going over is never charged.

## 4. Verify before the event (on a DIFFERENT day — quotas reset 05:30 IST)

```bash
# a) Pick the judge model with real measurements (spends up to ~9,000 neurons)
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run benchmark
#    → docs/reports/BENCHMARK.md

# b) Load-test the deployed app with 100 sessions and the real AI judge
URL=https://prompt-to-pixel.<you>.workers.dev ADMIN_TOKEN=<from deploy-output.txt> npm run loadtest:remote
#    → docs/reports/LOADTEST_REMOTE.md   (watch `npx wrangler tail` for exceededCpu errors meanwhile)
```
Run (a) and (b) on **different** days — together they can exceed one day's 10,000 neurons. Commit both reports. Don't call the system production-ready until both pass.

## 5. Updating

`npm run deploy` (build + `wrangler deploy`). Schema changes: add `migrations/0002_*.sql`, then `DATABASE_URL=… npm run migrate`.

## Rollback

`npx wrangler rollback` restores the previous Worker version. The database is unaffected.

## Running locally (optional)

```bash
npm run build && npx tsx scripts/local-server.ts   # http://localhost:8790, PGlite + simulated judge
# create an event:
curl -X POST localhost:8790/api/admin/events -H 'authorization: Bearer local-admin-token' \
  -H 'content-type: application/json' -d '{"code":"PIXEL1","name":"Local","hostPassword":"host-password-1"}'
```

## Emergency AI fallback (Ollama)

You only need this if Workers AI is down during the event. Run `ollama serve` with `llama3.2-vision` on any machine, expose it over HTTPS (e.g. `cloudflared tunnel --url http://localhost:11434`), then:
```bash
npx wrangler secret put OLLAMA_URL      # the https tunnel URL
```
In the host console, choose provider **Local Ollama**, then use **Re-judge round**. Switching is always an explicit, logged host action, and the model is never switched silently mid-round. This is the only path that relies on a laptop, and it's off by default.

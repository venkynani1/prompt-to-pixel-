/** 100-session load test against the local stack (PGlite + SIMULATED judge) running in a separate process. */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { runLoad, toMarkdown } from './loadtest-core';

const teams = Number(process.env.TEAMS ?? 100);
const latency = Number(process.env.JUDGE_LATENCY_MS ?? 3000);
const port = 8799;
const child = spawn('npx', ['tsx', 'scripts/local-server.ts'], { env: { ...process.env, PORT: String(port), JUDGE_LATENCY_MS: String(latency) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((res) => child.stdout!.on('data', (d) => { if (String(d).includes('local Prompt to Pixel')) res(); }));
try {
  const report = await runLoad({ base: `http://localhost:${port}`, adminToken: 'local-admin-token', teams, submitters: teams, code: 'LOAD01', hostPassword: 'load-test-password', judgeTimeoutSec: 600 });
  mkdirSync('docs/reports', { recursive: true });
  writeFileSync('docs/reports/loadtest-local.json', JSON.stringify(report, null, 2));
  writeFileSync('docs/reports/LOADTEST_LOCAL.md', toMarkdown(report, 'Load test — local stack (simulated judge)', [
    'Real application code and SQL, served by a separate local process on PGlite (single in-process Postgres) instead of Neon, with no internet hops, and a SIMULATED AI judge (' + latency + ' ms per evaluation, concurrency 4). Neuron figures are estimates from the simulated token counts.',
    'This shows the app logic copes with 100 concurrent sessions. It is NOT evidence of Cloudflare/Neon latency or real AI timing; run `npm run loadtest:remote` after deploying for that.',
  ]));
} finally { child.kill(); }
process.exit(0);

/**
 * Load test against the DEPLOYED app, with the REAL Workers AI judge.
 *   URL=https://prompt-to-pixel.<you>.workers.dev ADMIN_TOKEN=… npm run loadtest:remote -- --teams 100 --submitters 100
 * Budget: 100 evaluations ≈ the neurons shown in docs/reports/BENCHMARK.md × 100, plus ~2,000 Worker requests.
 * Run on a DIFFERENT UTC day from the event (quotas reset 00:00 UTC = 05:30 IST).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { runLoad, toMarkdown } from './loadtest-core';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const base = process.env.URL, adminToken = process.env.ADMIN_TOKEN;
if (!base || !adminToken) { console.error('Set URL and ADMIN_TOKEN (both are in deploy-output.txt)'); process.exit(1); }
const teams = Number(arg('teams', '100'));
const submitters = Math.min(teams, Number(arg('submitters', '100')));
const code = `LT${Date.now().toString(36).slice(-4).toUpperCase()}`;

const report = await runLoad({
  base: base.replace(/\/$/, ''), adminToken, teams, submitters, code,
  hostPassword: `lt-${Date.now()}-password`, judgeTimeoutSec: Number(arg('judge-timeout', '900')),
});
mkdirSync('docs/reports', { recursive: true });
writeFileSync('docs/reports/loadtest-remote.json', JSON.stringify(report, null, 2));
writeFileSync('docs/reports/LOADTEST_REMOTE.md', toMarkdown(report, `Load test — deployed (${base})`, [
  `Real Cloudflare Workers + Neon + Workers AI. Event ${code} was created for this test; disable it afterwards or leave it (it is isolated).`,
]));
console.log('\nWrote docs/reports/LOADTEST_REMOTE.md');
process.exit(0);

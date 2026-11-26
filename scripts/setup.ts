/**
 * One-command, free-tier-only deployment. Run from the repo root on any computer with Node 20+:
 *
 *   CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_ACCOUNT_ID=…  NEON_API_KEY=…  npm run setup
 *   (or DATABASE_URL=… instead of NEON_API_KEY if you already created the Neon project)
 *
 * Optional: S3_ENDPOINT S3_BUCKET S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY (Neon Object Storage),
 *           EVENT_CODE EVENT_NAME HOST_PASSWORD, OLLAMA_URL OLLAMA_TOKEN.
 * It never enables paid plans, never adds billing, and is safe to re-run.
 * After it finishes, the app runs entirely on Cloudflare + Neon — your laptop can be switched off.
 */
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { migrate } from './migrate';

const env = process.env;
const say = (s: string) => console.log(`\n▸ ${s}`);
const fail = (s: string) => { console.error(`\n✗ ${s}`); process.exit(1); };
const sh = (cmd: string, input?: string) => {
  const r = spawnSync(cmd, { shell: true, input, encoding: 'utf8', env: { ...env } });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const state: Record<string, string> = existsSync('.setup-state.json') ? JSON.parse(readFileSync('.setup-state.json', 'utf8')) : {};
const save = () => writeFileSync('.setup-state.json', JSON.stringify(state, null, 2)); // gitignored; holds generated secrets

async function neonProject(): Promise<string> {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (state.DATABASE_URL) return state.DATABASE_URL;
  if (!env.NEON_API_KEY) fail('Set NEON_API_KEY (Neon console → Account → API keys) or DATABASE_URL');
  say('Creating Neon Free project "prompt-to-pixel" in AWS Asia Pacific (Singapore) — closest Neon region to India');
  const r = await fetch('https://console.neon.tech/api/v2/projects', {
    method: 'POST', headers: { authorization: `Bearer ${env.NEON_API_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ project: { name: 'prompt-to-pixel', region_id: env.NEON_REGION ?? 'aws-ap-southeast-1' } }),
  });
  const j: any = await r.json();
  if (!r.ok) fail(`Neon API: ${JSON.stringify(j).slice(0, 300)}`);
  const uri = j.connection_uris?.[0]?.connection_uri;
  if (!uri) fail('Neon did not return a connection string');
  state.DATABASE_URL = uri; state.NEON_PROJECT_ID = j.project.id; save();
  return uri;
}

async function main() {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) fail('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see docs/DEPLOYMENT.md)');

  const dbUrl = await neonProject();
  say('Applying database migrations');
  await migrate(dbUrl);

  say('Creating Cloudflare Queues (free plan)');
  for (const q of ['p2p-evals', 'p2p-evals-dlq']) {
    const r = sh(`npx wrangler queues create ${q}`);
    console.log(r.ok ? `  ✓ ${q}` : /already exists|already taken|11009/i.test(r.out) ? `  ✓ ${q} (exists)` : fail(`queue ${q}: ${r.out.slice(-400)}`));
  }

  say("Accepting Meta's Llama 3.2 Vision licence on Workers AI (required once per account)");
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct`, {
    method: 'POST', headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'agree' }),
  }).then((r) => console.log(`  ✓ licence request sent (${r.status})`));

  say('Building the app');
  execSync('npm run build', { stdio: 'inherit' });

  say('Deploying to Cloudflare Workers (workers.dev)');
  const dep = sh('npx wrangler deploy');
  console.log(dep.out.split('\n').filter((l) => /workers\.dev|Uploaded|Deployed|error/i.test(l)).join('\n'));
  if (!dep.ok) fail(`wrangler deploy failed. If it mentions a workers.dev subdomain, open dash.cloudflare.com → Workers & Pages once to choose one, then re-run.\n${dep.out.slice(-800)}`);
  const url = dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (!url) fail('Could not find the workers.dev URL in the deploy output');
  state.URL = url!; save();

  say('Setting Worker secrets (stored encrypted by Cloudflare; never sent to browsers)');
  state.ADMIN_TOKEN ??= randomBytes(24).toString('hex'); save();
  const secrets: Record<string, string> = { DATABASE_URL: dbUrl, ADMIN_TOKEN: state.ADMIN_TOKEN };
  for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'OLLAMA_URL', 'OLLAMA_TOKEN']) if (env[k]) secrets[k] = env[k]!;
  writeFileSync('.secrets.tmp.json', JSON.stringify(secrets));
  const sec = sh('npx wrangler secret bulk .secrets.tmp.json');
  unlinkSync('.secrets.tmp.json');
  if (!sec.ok) fail(`secret upload failed: ${sec.out.slice(-500)}`);
  console.log(`  ✓ ${Object.keys(secrets).join(', ')}`);
  console.log(secrets.S3_ENDPOINT ? '  Images → Neon Object Storage' : '  Images → Postgres BYTEA fallback (no S3_* credentials given)');

  say('Waiting for the Worker to answer');
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    ok = await fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false);
    if (!ok) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ok) fail(`${url}/api/health is not responding yet — re-run setup in a minute`);

  const code = (env.EVENT_CODE ?? state.EVENT_CODE ?? 'PIXEL1').toUpperCase();
  if (!state.EVENT_CODE) {
    say(`Creating event ${code}`);
    state.HOST_PASSWORD ??= env.HOST_PASSWORD ?? randomBytes(9).toString('base64url');
    const r = await fetch(`${url}/api/admin/events`, {
      method: 'POST', headers: { authorization: `Bearer ${state.ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: env.EVENT_NAME ?? 'Prompt to Pixel', hostPassword: state.HOST_PASSWORD }),
    });
    if (!r.ok && r.status !== 500) fail(`event creation: ${await r.text()}`);
    state.EVENT_CODE = code; save();
  }

  // projector key via host login
  const login = await fetch(`${url}/api/events/${code}/host/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: state.HOST_PASSWORD }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const ov: any = await fetch(`${url}/api/events/${code}/host/overview`, { headers: { cookie } }).then((r) => r.json()).catch(() => null);

  const out = `Prompt to Pixel — deployment
Participant URL : ${url}/e/${code}        (QR code is on the projector lobby screen)
Host console    : ${url}/host            event code ${code}, password ${state.HOST_PASSWORD}
Projector URL   : ${url}/e/${code}/screen?pk=${ov?.event?.projectorKey ?? '(log in to the host console → Screens)'}
Admin token     : ${state.ADMIN_TOKEN}   (only for creating more events)
Storage         : ${ov?.storageBackend ?? 'unknown'}
`;
  writeFileSync('deploy-output.txt', out);
  console.log(`\n${out}\nSaved to deploy-output.txt (gitignored — keep it private).`);
  console.log('Next: open the host console, upload the Round 1 reference, run calibration, then read docs/HOST_GUIDE.md.');
}

main().catch((e) => fail(String(e?.stack ?? e)));

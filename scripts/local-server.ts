/**
 * Local, self-contained server for UI previews and the local load test.
 * Same Hono app + SQL as production, but: PGlite instead of Neon, in-process queue,
 * and a SIMULATED judge (deterministic scores + configurable latency). Not used in production.
 */
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createApp } from '../src/worker/app';
import type { AppContext } from '../src/worker/context';
import type { Db } from '../src/worker/db';
import { processJob, reconcile } from '../src/worker/evaluation';
import { ImageStore } from '../src/worker/storage';
import { createHash } from 'node:crypto';

export async function startLocal(opts: { port?: number; judgeLatencyMs?: number; quiet?: boolean } = {}) {
  const pg = new PGlite();
  for (const f of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(`migrations/${f}`, 'utf8'));
  const db: Db = {
    query: async (t, p = []) => (await pg.query(t, p as any[])).rows as any,
    batch: (stmts) => pg.transaction(async (tx) => {
      const out: any[][] = [];
      for (const s of stmts) out.push((await tx.query(s.text, (s.params ?? []) as any[])).rows as any[]);
      return out;
    }),
  };
  const latency = opts.judgeLatencyMs ?? 2500;
  const judgeTimes: number[] = [];
  const ctx: AppContext = {
    db,
    images: new ImageStore(db, null, 'bytea'),
    queue: {
      send: async (b) => { setTimeout(() => run(b.jobId), 10); },
      sendBatch: async (bs) => { bs.forEach((b) => setTimeout(() => run(b.jobId), 10)); },
    },
    providers: (id, model) => ({
      id: 'workers-ai', model, // simulated, but reported as workers-ai so neuron estimates + budgets are exercised
      async run(req) {
        await new Promise((r) => setTimeout(r, latency * (0.7 + Math.random() * 0.6)));
        if (req.prompt.startsWith('Describe')) return { raw: 'A simulated reference description.', text: 'A simulated reference description.', inputTokens: 1800, outputTokens: 120, latencyMs: latency };
        const seed = createHash('sha1').update(req.images.at(-1)!.bytes).digest()[0];
        const v = (k: number) => Math.round(((seed + k * 37) % 9) + 1);
        const keys = req.prompt.includes('three crossover') ? ['concept_a', 'concept_b', 'concept_c', 'fusion', 'creativity', 'quality'] : ['composition', 'subject', 'colour', 'style', 'detail'];
        const text = JSON.stringify({ scores: Object.fromEntries(keys.map((k, i) => [k, v(i)])), feedback: 'Simulated judge feedback for local testing.', embedded_instructions: false });
        return { raw: text, text, inputTokens: 2000, outputTokens: 140, latencyMs: latency };
      },
    }),
    assets: async (p) => new Uint8Array(readFileSync(`public${p}`)),
    pinIterations: 20000,
    storageBackend: 'bytea',
    capabilities: { imagesBinding: false, objectStorage: false, ollama: false },
  };
  async function run(jobId: string) {
    const t0 = Date.now();
    const r = await processJob(ctx, jobId).catch((e) => ({ outcome: 'error', e }) as any);
    if (r.outcome === 'done') judgeTimes.push(Date.now() - t0);
    if (r.outcome === 'retry') setTimeout(() => run(jobId), Math.min(r.delaySec, 5) * 1000);
  }
  const cron = setInterval(() => reconcile(ctx).catch(() => {}), 15_000);
  const app = createApp(() => ctx, { adminToken: () => 'local-admin-token' });

  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = await app.fetch(new Request(url, { method: req.method, headers: req.headers as any, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) }), {}, { waitUntil() {}, passThroughOnException() {} } as any);
      const headers: Record<string, string | string[]> = {};
      r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
      const sc = r.headers.getSetCookie(); if (sc.length) headers['set-cookie'] = sc;
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let file = join('dist/client', url.pathname);
    if (!existsSync(file) || statSync(file).isDirectory()) file = 'dist/client/index.html';
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 8790, r));
  const port = (server.address() as any).port;
  if (!opts.quiet) console.log(`local Prompt to Pixel on http://localhost:${port}  (admin token: local-admin-token)`);
  return { port, ctx, db, judgeTimes, close: () => { clearInterval(cron); server.close(); } };
}

if (process.argv[1]?.endsWith('local-server.ts')) startLocal({ port: Number(process.env.PORT ?? 8790), judgeLatencyMs: Number(process.env.JUDGE_LATENCY_MS ?? 2500) });

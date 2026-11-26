import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { createApp } from '../src/worker/app';
import type { JudgeProvider, VisionRequest } from '../src/worker/ai/providers';
import type { AppContext } from '../src/worker/context';
import type { Db } from '../src/worker/db';
import type { QueueMessageBody } from '../src/worker/env';
import { processJob } from '../src/worker/evaluation';
import { ImageStore, type ObjectStore } from '../src/worker/storage';

export type ScriptedReply = (req: VisionRequest, call: number) => Promise<{ text: string; inTok?: number; outTok?: number }> | { text: string; inTok?: number; outTok?: number };

export const goodR1 = (v = 7) => JSON.stringify({ scores: { composition: v, subject: v, colour: v, style: v, detail: v }, feedback: 'Close match.', embedded_instructions: false });
export const goodR2 = (v = 6) => JSON.stringify({ scores: { concept_a: v, concept_b: v, concept_c: v, fusion: v, creativity: v, quality: v }, feedback: 'Nice fusion.', embedded_instructions: false });

export async function makeHarness(opts: { objectStore?: boolean } = {}) {
  const pg = new PGlite();
  await pg.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
  const db: Db = {
    query: async (text, params = []) => (await pg.query(text, params as any[])).rows as any,
    batch: async (stmts) => pg.transaction(async (tx) => {
      const out: any[][] = [];
      for (const s of stmts) out.push((await tx.query(s.text, (s.params ?? []) as any[])).rows as any[]);
      return out;
    }),
  };
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore | null = opts.objectStore
    ? { put: async (k, b) => { objects.set(k, b); }, get: async (k) => objects.get(k) ?? null }
    : null;

  const queue: QueueMessageBody[] = [];
  const calls: VisionRequest[] = [];
  let reply: ScriptedReply = (req) => ({ text: req.prompt.includes('three crossover') ? goodR2() : req.prompt.startsWith('Describe') ? 'A red square on white.' : goodR1() });
  const provider = (id: string, model: string): JudgeProvider => ({
    id: id as any, model,
    async run(req) {
      calls.push(req);
      const r = await reply(req, calls.length);
      return { raw: r.text, text: r.text, inputTokens: r.inTok ?? 2000, outputTokens: r.outTok ?? 120, latencyMs: 5 };
    },
  });

  const ctx: AppContext = {
    db,
    images: new ImageStore(db, store, 'auto'),
    queue: { send: async (b) => { queue.push(b); }, sendBatch: async (bs) => { queue.push(...bs); } },
    providers: provider,
    assets: async (p) => new Uint8Array(readFileSync(`public${p}`)),
    pinIterations: 1000,
    storageBackend: store ? 'neon-s3' : 'bytea',
    capabilities: { imagesBinding: false, objectStorage: !!store, ollama: false },
  };
  const app = createApp(() => ctx, { adminToken: () => 'admin-token-123' });

  return {
    pg, db, ctx, app, queue, calls, objects,
    setReply(r: ScriptedReply) { reply = r; },
    /** Deliver queued messages like the Queue would (retries re-enqueue immediately). */
    async drain(max = 200) {
      const outcomes: string[] = [];
      for (let i = 0; i < max && queue.length; i++) {
        const m = queue.shift()!;
        const r = await processJob(ctx, m.jobId);
        outcomes.push(r.outcome);
        if (r.outcome === 'retry') queue.push(m);
      }
      return outcomes;
    },
    client() { return new Client(app); },
  };
}

export class Client {
  cookies = new Map<string, string>();
  constructor(private app: ReturnType<typeof createApp>) {}
  async req(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    let bodyInit = init.body;
    if (init.json !== undefined) { headers.set('content-type', 'application/json'); bodyInit = JSON.stringify(init.json); }
    const res = await this.app.request(`https://p2p.test${path}`, { ...init, headers, body: bodyInit });
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (/Max-Age=0/.test(c)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    return res;
  }
  async json(path: string, init: RequestInit & { json?: unknown } = {}) {
    const res = await this.req(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
}

export async function webp(color: string, w = 64, h = 64, quality = 80) {
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: color } }).webp({ quality }).toBuffer());
}

export async function submitForm(full: Uint8Array, opts: { dhash?: string; prompt?: string } = {}) {
  const fd = new FormData();
  fd.set('full', new Blob([full], { type: 'image/webp' }), 'full.webp');
  fd.set('judge', new Blob([full], { type: 'image/webp' }), 'judge.webp');
  fd.set('thumb', new Blob([full], { type: 'image/webp' }), 'thumb.webp');
  if (opts.dhash) fd.set('dhash', opts.dhash);
  if (opts.prompt) fd.set('prompt', opts.prompt);
  return fd;
}

export async function setupEvent(h: Awaited<ReturnType<typeof makeHarness>>, code = 'PIXEL1') {
  const admin = h.client();
  const created = await admin.json('/api/admin/events', { method: 'POST', headers: { authorization: 'Bearer admin-token-123' }, json: { code, name: 'Test Event', hostPassword: 'host-password-1' } });
  if (created.status !== 200) throw new Error(JSON.stringify(created.body));
  const host = h.client();
  const login = await host.json(`/api/events/${code}/host/login`, { method: 'POST', json: { password: 'host-password-1' } });
  if (login.status !== 200) throw new Error('host login failed');
  return { host, code };
}

import { createApp } from './app';
import { contextFromEnv } from './context';
import type { Env, QueueMessageBody } from './env';
import { processJob, reconcile } from './evaluation';
import { addUsage, countRequest } from './usage';

const app = createApp((env: Env) => contextFromEnv(env), {
  adminToken: (env: Env) => env.ADMIN_TOKEN,
  onRequest: (c) => countRequest(c.get('ctx').db, (p) => c.executionCtx.waitUntil(p)),
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return health(env);
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  // Queue consumer: messages carry IDs only; all durable state lives in Neon.
  async queue(batch, env) {
    const appCtx = contextFromEnv(env);
    // ~3 queue operations per message (write + read + delete), +1 read per redelivery
    await addUsage(appCtx.db, 'queue_ops', batch.messages.reduce((n, m) => n + (m.attempts > 1 ? 1 : 3), 0)).catch(() => {});
    for (const msg of batch.messages) {
      try {
        const r = await processJob(appCtx, msg.body.jobId);
        if (r.outcome === 'retry') msg.retry({ delaySeconds: r.delaySec });
        else msg.ack();
        console.log(JSON.stringify({ job: msg.body.jobId, ...r }));
      } catch (err) {
        console.error('queue consumer error', err);
        msg.retry({ delaySeconds: 30 }); // DB unreachable etc. — the cron reconciler is the second safety net
      }
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(reconcile(contextFromEnv(env)).then((r) => console.log('reconcile', JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env, QueueMessageBody>;

/** Setup diagnostics that never reveal secret values. */
async function health(env: Env): Promise<Response> {
  const out = (status: number, body: object) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  const raw = env.DATABASE_URL;
  if (!raw) return out(500, { ok: false, problem: 'DATABASE_URL secret is not set on this Worker (Settings → Variables and Secrets), or it was added without clicking Deploy.' });
  const v = raw.trim();
  if (/^["']/.test(v)) return out(500, { ok: false, problem: 'DATABASE_URL starts with a quote mark. Paste only the value, without quotes.' });
  if (/^[A-Z_]+=/.test(v)) return out(500, { ok: false, problem: 'DATABASE_URL includes the variable name (e.g. NEON_DATABASE_URL=). Paste only the part starting with postgresql://' });
  if (!/^postgres(ql)?:\/\//.test(v)) return out(500, { ok: false, problem: 'DATABASE_URL must start with postgresql://' });
  let host = '';
  try { host = new URL(v).hostname; } catch { return out(500, { ok: false, problem: 'DATABASE_URL is not a valid connection string (copy it again).' }); }
  try {
    const c = contextFromEnv(env);
    const [{ n }] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('events','teams','submissions','evaluation_jobs')`);
    if (n < 4) return out(500, { ok: false, problem: 'Connected, but the tables are missing in this database. Run migrations/0001_init.sql in the Neon SQL editor.', host });
    return out(200, { ok: true, storage: c.storageBackend, capabilities: c.capabilities, dbHost: host.replace(/^([^.]{6})[^.]*/, '$1…'), adminTokenSet: !!env.ADMIN_TOKEN });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, '[url]').replace(/password[^,;]*/gi, 'password…').slice(0, 200);
    return out(500, { ok: false, problem: `Cannot query the database: ${msg}`, dbHost: host.replace(/^([^.]{6})[^.]*/, '$1…') });
  }
}

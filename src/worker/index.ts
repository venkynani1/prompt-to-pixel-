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

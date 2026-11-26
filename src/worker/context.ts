import type { CompositeFn } from './ai/judge';
import { imagesBindingComposite } from './ai/judge';
import type { ProviderFactory } from './ai/providers';
import { defaultProviderFactory } from './ai/providers';
import type { Db } from './db';
import { neonDb } from './db';
import type { Env, QueueMessageBody } from './env';
import { ImageStore, neonS3Store } from './storage';

export interface EvalQueue {
  send(body: QueueMessageBody, opts?: { delaySeconds?: number }): Promise<void>;
  sendBatch(bodies: QueueMessageBody[]): Promise<void>;
}

/** Everything business logic needs. Production builds it from bindings; tests inject fakes. */
export interface AppContext {
  db: Db;
  images: ImageStore;
  queue: EvalQueue;
  providers: ProviderFactory;
  composite?: CompositeFn;
  assets?: (path: string) => Promise<Uint8Array | null>;
  pinIterations: number;
  storageBackend: 'neon-s3' | 'bytea';
  capabilities: { imagesBinding: boolean; objectStorage: boolean; ollama: boolean };
}

export function contextFromEnv(env: Env): AppContext {
  const db = neonDb(env.DATABASE_URL);
  const s3 = env.STORAGE_MODE === 'bytea' ? null : neonS3Store(env);
  const images = new ImageStore(db, s3, env.STORAGE_MODE ?? 'auto');
  const assets = async (path: string) => {
    const res = await env.ASSETS.fetch(new Request(`https://assets.local${path}`));
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  };
  return {
    db,
    images,
    queue: {
      send: async (b, o) => { await env.EVAL_QUEUE.send(b, o); },
      sendBatch: async (bs) => { await env.EVAL_QUEUE.sendBatch(bs.map((body) => ({ body }))); },
    },
    providers: defaultProviderFactory(env),
    composite: env.IMAGES
      ? imagesBindingComposite(env.IMAGES, async () => (await env.ASSETS.fetch(new Request('https://assets.local/judge/composite-base.png'))).body!)
      : undefined,
    assets,
    pinIterations: Number(env.PIN_PBKDF2_ITERATIONS ?? 20000),
    storageBackend: images.backend,
    capabilities: { imagesBinding: !!env.IMAGES, objectStorage: !!s3, ollama: !!env.OLLAMA_URL },
  };
}

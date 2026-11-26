import { AwsClient } from 'aws4fetch';
import type { Db } from './db';
import { base64ToBytes, bytesToBase64 } from './db';
import type { Env } from './env';
import { sha256Hex } from './crypto';

export type ImageKind = 'reference' | 'submission' | 'judge' | 'thumb' | 'composite' | 'calibration';
export type ContentType = 'image/webp' | 'image/jpeg' | 'image/png';

export interface StoredImage { bytes: Uint8Array; contentType: ContentType }

/** Pluggable object store. In tests a Map-backed fake is injected. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export function neonS3Store(env: Env): ObjectStore | null {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  const aws = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION || 'us-east-1',
    service: 's3',
  });
  const base = `${env.S3_ENDPOINT.replace(/\/$/, '')}/${env.S3_BUCKET}`;
  return {
    async put(key, bytes, contentType) {
      const res = await aws.fetch(`${base}/${key}`, { method: 'PUT', body: bytes, headers: { 'content-type': contentType } });
      if (!res.ok) throw new Error(`object storage PUT ${res.status}`);
    },
    async get(key) {
      const res = await aws.fetch(`${base}/${key}`, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`object storage GET ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export interface PutImageInput {
  eventId: string;
  kind: ImageKind;
  bytes: Uint8Array;
  contentType: ContentType;
  width?: number;
  height?: number;
}

export class ImageStore {
  constructor(private db: Db, private store: ObjectStore | null, private mode: string = 'auto') {}

  get backend(): 'neon-s3' | 'bytea' {
    if (this.mode === 'bytea' || !this.store) return 'bytea';
    return 'neon-s3';
  }

  async put(input: PutImageInput, caps?: { storageByteCap: number; byteaByteCap: number }): Promise<{ id: string; sha256: string; backend: string }> {
    const sha = await sha256Hex(input.bytes);
    const id = crypto.randomUUID();
    let backend = this.backend;
    if (backend === 'neon-s3') {
      if (caps) {
        const [{ used }] = await this.db.query<{ used: string }>(
          `SELECT coalesce(sum(byte_size),0)::text AS used FROM images WHERE backend='neon-s3'`);
        if (Number(used) + input.bytes.length > caps.storageByteCap) throw new QuotaError('Object storage budget reached');
      }
      const key = `${input.eventId}/${input.kind}/${id}`;
      try {
        await this.store!.put(key, input.bytes, input.contentType);
        await this.db.query(
          `INSERT INTO images(id,event_id,kind,backend,object_key,content_type,byte_size,sha256,width,height)
           VALUES($1,$2,$3,'neon-s3',$4,$5,$6,$7,$8,$9)`,
          [id, input.eventId, input.kind, key, input.contentType, input.bytes.length, sha, input.width ?? null, input.height ?? null]);
        return { id, sha256: sha, backend };
      } catch (err) {
        if (err instanceof QuotaError) throw err;
        // Bounded fallback: object storage unavailable → compressed image into Postgres BYTEA.
        backend = 'bytea';
        await this.db.query(
          `INSERT INTO audit_logs(event_id,actor,action,detail) VALUES($1,'system','storage_fallback',$2)`,
          [input.eventId, JSON.stringify({ error: String(err) })]);
      }
    }
    if (caps) {
      const [{ used }] = await this.db.query<{ used: string }>(
        `SELECT coalesce(sum(byte_size),0)::text AS used FROM images WHERE backend='bytea'`);
      if (Number(used) + input.bytes.length > caps.byteaByteCap) throw new QuotaError('Database image budget reached');
    }
    await this.db.query(
      `INSERT INTO images(id,event_id,kind,backend,data,content_type,byte_size,sha256,width,height)
       VALUES($1,$2,$3,'bytea',decode($4,'base64'),$5,$6,$7,$8,$9)`,
      [id, input.eventId, input.kind, bytesToBase64(input.bytes), input.contentType, input.bytes.length, sha, input.width ?? null, input.height ?? null]);
    return { id, sha256: sha, backend };
  }

  async meta(id: string) {
    const rows = await this.db.query<{ id: string; event_id: string; kind: ImageKind; backend: string; object_key: string | null; content_type: ContentType; sha256: string }>(
      `SELECT id,event_id,kind,backend,object_key,content_type,sha256 FROM images WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }

  async get(id: string): Promise<StoredImage | null> {
    const rows = await this.db.query<{ backend: string; object_key: string | null; content_type: ContentType; b64: string | null }>(
      `SELECT backend, object_key, content_type, CASE WHEN backend='bytea' THEN encode(data,'base64') END AS b64
       FROM images WHERE id=$1`, [id]);
    const r = rows[0];
    if (!r) return null;
    if (r.backend === 'bytea') return { bytes: base64ToBytes(r.b64!.replace(/\s/g, '')), contentType: r.content_type };
    if (!this.store) throw new Error('Object storage not configured but image is stored there');
    const bytes = await this.store.get(r.object_key!);
    return bytes ? { bytes, contentType: r.content_type } : null;
  }
}

export class QuotaError extends Error {}

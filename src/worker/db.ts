import { neon } from '@neondatabase/serverless';

/** Minimal database interface so the same code runs on Neon (HTTP) and PGlite (tests). */
export interface Db {
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs statements in ONE transaction (single HTTP round-trip on Neon). */
  batch(statements: { text: string; params?: unknown[] }[]): Promise<Record<string, any>[][]>;
}

const cache = new Map<string, Db>();

export function neonDb(url: string): Db {
  const hit = cache.get(url);
  if (hit) return hit;
  const sql = neon(url);
  const db: Db = {
    query: (text, params = []) => sql.query(text, params as any[]) as any,
    batch: async (stmts) =>
      (await sql.transaction(stmts.map((s) => sql.query(s.text, (s.params ?? []) as any[])))) as any,
  };
  cache.set(url, db);
  return db;
}

// ── base64 helpers (bytea travels as base64 to keep CPU low) ──
export function bytesToBase64(bytes: Uint8Array): string {
  const anyB = bytes as any;
  if (typeof anyB.toBase64 === 'function') return anyB.toBase64();
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const U = Uint8Array as any;
  if (typeof U.fromBase64 === 'function') return U.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

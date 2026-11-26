/**
 * Runs during the Vercel build ONLY to create/upgrade the Neon tables using the
 * database Vercel's Neon integration attached (its secrets are only readable at build time).
 * The app itself runs on Cloudflare Workers; Vercel's deployment is not used by players.
 */
import { neonConfig, Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { migrate } from './migrate';

if (typeof (globalThis as any).WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;
const url = process.env.NEON_DATABASE_URL_UNPOOLED || process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.log('[p2p] no Neon URL in this build — skipping migrations'); process.exit(0); }

await migrate(url, (s) => console.log('[p2p]', s));
const pool = new Pool({ connectionString: url });
const { rows } = await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`);
const host = new URL(url).hostname;
console.log(`[p2p] database ready: ${rows[0].n} tables on ${host.replace(/^([^.]{4})[^.]*/, '$1…')}`);
await pool.end();

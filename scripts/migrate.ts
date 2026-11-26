/** Applies migrations/*.sql to Neon in order (tracked in schema_migrations). Usage: DATABASE_URL=… npm run migrate */
import { neonConfig, Pool } from '@neondatabase/serverless';
import ws from 'ws';

// Node 20 has no global WebSocket; Node 22+ does
if (typeof (globalThis as any).WebSocket === 'undefined') neonConfig.webSocketConstructor = ws;
import { readdirSync, readFileSync } from 'node:fs';

export async function migrate(url: string, log = console.log) {
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r: any) => r.name));
    for (const f of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) { log(`  ✓ ${f} (already applied)`); continue; }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(`migrations/${f}`, 'utf8'));
        await client.query(`INSERT INTO schema_migrations(name) VALUES($1)`, [f]);
        await client.query('COMMIT');
        log(`  ✓ ${f} applied`);
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
  } finally { await pool.end(); }
}

if (/(^|[\/])migrate.ts$/.test(process.argv[1] ?? '')) {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  migrate(process.env.DATABASE_URL).then(() => console.log('migrations complete'), (e) => { console.error(e); process.exit(1); });
}

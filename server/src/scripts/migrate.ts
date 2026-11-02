// Applies SQL migrations as the database owner, then grants the application role
// only the rights it needs (no UPDATE or DELETE on the audit log).
// Usage: DATABASE_OWNER_URL=postgres://owner:pw@db/cysoc_portal APP_DB_USER=portal_app npm run migrate
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUser = process.env.APP_DB_USER || 'portal_app';
if (!ownerUrl) { console.error('Set DATABASE_OWNER_URL to the owner connection string.'); process.exit(1); }
if (!/^[a-z_][a-z0-9_]*$/.test(appUser)) { console.error('APP_DB_USER must be a plain identifier.'); process.exit(1); }

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function pool() {
  try { const m: any = await import('pg' as string); const Pg = m.default ?? m; return new Pg.Pool({ connectionString: ownerUrl, max: 1 }); }
  catch { const { Pool } = await import('../db/mini-pg.js'); return new Pool({ connectionString: ownerUrl!, max: 1 }); }
}

const p: any = await pool();
// The database may still be starting on first boot: retry for up to two minutes.
let c: any;
for (let attempt = 1; ; attempt++) {
  try { c = await p.connect(); break; }
  catch (e: any) {
    if (attempt >= 24) throw e;
    console.log(`Database not ready (${e.message}); retrying in 5 s`);
    await new Promise(r => setTimeout(r, 5000));
  }
}
try {
  await c.query("SELECT set_config('app.role', 'system', false)");
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r: any) => r.name));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`Applying ${f}`);
    await c.query('BEGIN');
    try {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser])).rows.length > 0;
  if (exists) {
    await c.query(`GRANT USAGE ON SCHEMA public TO ${appUser}`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appUser}`);
    await c.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${appUser}`);
    await c.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${appUser}`);
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appUser}`);
    console.log(`Granted application rights to ${appUser}`);
  } else {
    console.warn(`Role ${appUser} does not exist yet; create it and run migrate again to apply grants.`);
  }
  console.log('Migrations complete');
} finally { c.release(); await p.end(); }

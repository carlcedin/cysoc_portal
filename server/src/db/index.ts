// Database access. Every request runs inside a transaction that carries the caller's role and
// tenant as PostgreSQL settings; row-level security policies use them, so even a bug in a query
// cannot return another tenant's rows.
import { config } from '../config.js';

export type Role = 'admin' | 'analyst' | 'customer' | 'system';
export interface Ctx { role: Role; tenantId: string | null; userId: string | null; }
export interface Tx { query<T = any>(sql: string, params?: unknown[]): Promise<T[]>; one<T = any>(sql: string, params?: unknown[]): Promise<T | null>; }

interface PoolLike {
  connect(): Promise<{ query(t: string, p?: unknown[]): Promise<{ rows: any[] }>; release(err?: unknown): void }>;
  end(): Promise<void>;
}

let pool: PoolLike | null = null;

async function makePool(): Promise<PoolLike> {
  try {
    const mod: any = await import('pg' as string);
    const Pg = mod.default ?? mod;
    // Keep int8 counts as numbers where safe; they are used for counts only.
    Pg.types.setTypeParser(20, (v: string) => Number(v));
    return new Pg.Pool({ connectionString: config.databaseUrl, max: 20 });
  } catch {
    const { Pool } = await import('./mini-pg.js');
    if (process.env.NODE_ENV === 'production') console.warn('[db] pg driver not installed; using built-in fallback driver');
    return new Pool({ connectionString: config.databaseUrl, max: 20 }) as unknown as PoolLike;
  }
}

export async function getPool(): Promise<PoolLike> {
  if (!pool) pool = await makePool();
  return pool;
}

export async function closePool() { if (pool) { await pool.end(); pool = null; } }

const toNum = (rows: any[]) => rows; // hook for future row normalisation

export async function withCtx<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const p = await getPool();
  const client = await p.connect();
  const tx: Tx = {
    query: async (sql, params) => toNum((await client.query(sql, params ?? [])).rows),
    one: async (sql, params) => (await client.query(sql, params ?? [])).rows[0] ?? null,
  };
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.role', $1, true), set_config('app.tenant_id', $2, true), set_config('app.user_id', $3, true)",
      [ctx.role, ctx.tenantId ?? '', ctx.userId ?? ''],
    );
    const result = await fn(tx);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); client.release(); } catch (e2) { client.release(e2); }
    throw e;
  }
}

export const system: Ctx = { role: 'system', tenantId: null, userId: null };
export const asSystem = <T>(fn: (tx: Tx) => Promise<T>) => withCtx(system, fn);

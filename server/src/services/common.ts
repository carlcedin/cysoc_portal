import { badRequest, forbidden, type Req } from '../http/core.js';
import { can, type Permission } from '../auth/permissions.js';
import type { Tx } from '../db/index.js';

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function need(req: Req, p: Permission) { if (!can(req.user.role, p)) throw forbidden(); }

/** Tenant filter for a request: customers are pinned to their tenant; staff pass ?tenant=<id>|all. */
export function scope(req: Req): string | null {
  if (req.user.role === 'customer') return req.user.tenantId;
  const t = req.query.get('tenant');
  if (!t || t === 'all') return null;
  if (!UUID.test(t)) throw badRequest('Unknown tenant.');
  return t;
}

export function str(v: unknown, name: string, max = 500, required = true): string {
  if (v === undefined || v === null || v === '') { if (required) throw badRequest(`Enter ${name}.`); return ''; }
  if (typeof v !== 'string') throw badRequest(`${name[0].toUpperCase() + name.slice(1)} must be text.`);
  const s = v.trim();
  if (required && !s) throw badRequest(`Enter ${name}.`);
  if (s.length > max) throw badRequest(`${name[0].toUpperCase() + name.slice(1)} must be ${max} characters or fewer.`);
  return s;
}

export function oneOf<T extends string>(v: unknown, list: readonly T[], name: string): T {
  if (!list.includes(v as T)) throw badRequest(`Choose a valid ${name}.`);
  return v as T;
}

export async function queue(tx: Tx, kind: string, payload: unknown) {
  await tx.query('INSERT INTO outbox (kind, payload) VALUES ($1, $2)', [kind, JSON.stringify(payload)]);
}

export async function slaTargets(tx: Tx) {
  return tx.query<{ severity: string; escalate_minutes: number; ack_hours: number }>('SELECT severity, escalate_minutes, ack_hours::float AS ack_hours FROM sla_targets ORDER BY sort');
}

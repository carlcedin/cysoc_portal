// NTS (Freshservice API v2) integration.
//  Inbound: the worker polls tickets updated since the last run and creates or updates escalations
//           for tickets whose customer field matches a tenant code.
//  Outbound: portal actions are queued in `outbox` and written back as ticket notes or status changes.
import { config } from '../config.js';
import { asSystem } from '../db/index.js';
import { getIntegration, markStatus, callJson } from './registry.js';

export interface NtsSettings {
  tenantField: string;                       // custom field holding the tenant code, e.g. cf_customer_code
  groupIds?: number[];                       // only import tickets from these groups (empty = all)
  detectedField?: string;                    // optional custom field with the SIEM detection time
  sourceField?: string;                      // optional custom field naming the SIEM
  priorityMap: Record<string, string>;       // Freshservice priority -> severity
  statusOnEscalate: number;                  // e.g. 3 Pending
  statusOnClose: number;                     // e.g. 4 Resolved
  closedStatuses: number[];                  // NTS statuses treated as closed, e.g. [4, 5]
  requestGroupId?: number;                   // group for customer service requests
  requesterEmail?: string;                   // requester used when creating request tickets
}

export const DEFAULT_NTS_SETTINGS: NtsSettings = {
  tenantField: 'cf_customer_code', groupIds: [], priorityMap: { '4': 'Critical', '3': 'High', '2': 'Medium', '1': 'Low' },
  statusOnEscalate: 3, statusOnClose: 4, closedStatuses: [4, 5],
};

async function client() {
  const integ = await getIntegration('nts');
  if (!integ || !integ.enabled || !integ.endpoint || !integ.secret) return null;
  const auth = 'Basic ' + Buffer.from(`${integ.secret}:X`).toString('base64');
  const base = integ.endpoint.replace(/\/$/, '');
  const settings: NtsSettings = { ...DEFAULT_NTS_SETTINGS, ...(integ.settings || {}) };
  const call = (path: string, init: RequestInit = {}) => callJson(base + path, { ...init, headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  return { integ, settings, call };
}

export async function testNts(): Promise<string> {
  const c = await client();
  if (!c) throw new Error('NTS is not configured or is disabled.');
  const r = await c.call('/api/v2/tickets?per_page=1');
  return `Reached NTS (${(r.tickets || []).length ? 'tickets visible' : 'no tickets returned'}).`;
}

const field = (t: any, name?: string) => (name ? t.custom_fields?.[name] ?? t[name] : undefined);

/** Pulls updated tickets into escalations. Returns the number of tickets processed. */
export async function syncInbound(): Promise<number> {
  if (config.integrationMode === 'demo') return 0;
  const c = await client();
  if (!c) return 0;
  const since = await asSystem(tx => tx.one<{ value: string }>("SELECT value FROM worker_state WHERE key = 'nts_since'"));
  const from = since?.value ?? new Date(Date.now() - 7 * 86400_000).toISOString();
  const started = new Date().toISOString();
  let processed = 0;
  try {
    const tenants = await asSystem(tx => tx.query<{ id: string; code: string; siem: string }>('SELECT id, code, siem FROM tenants WHERE active'));
    const byCode = new Map(tenants.map(t => [t.code.toLowerCase(), t]));
    for (let page = 1; page <= 50; page++) {
      const r = await c.call(`/api/v2/tickets?updated_since=${encodeURIComponent(from)}&per_page=100&page=${page}&order_type=asc`);
      const tickets: any[] = r.tickets || [];
      for (const t of tickets) {
        if (c.settings.groupIds?.length && !c.settings.groupIds.includes(t.group_id)) continue;
        const code = String(field(t, c.settings.tenantField) ?? '').toLowerCase();
        const tenant = byCode.get(code);
        if (!tenant) continue;
        const severity = c.settings.priorityMap[String(t.priority)] ?? 'Medium';
        const detected = field(t, c.settings.detectedField) || t.created_at;
        const closedInNts = c.settings.closedStatuses.includes(Number(t.status));
        await asSystem(async tx => {
          const existing = await tx.one('SELECT id, status FROM escalations WHERE nts_ticket_id = $1', [t.id]);
          if (!existing) {
            await tx.query(
              `INSERT INTO escalations (tenant_id, nts_ticket_id, ref, severity, summary, description, source, status, detected_at, triaged_at, closed_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [tenant.id, t.id, `NTS-${t.id}`, severity, String(t.subject || 'Security alert').slice(0, 300), String(t.description_text || '').slice(0, 4000),
               String(field(t, c.settings.sourceField) || tenant.siem), closedInNts ? 'closed' : 'triage', detected, t.created_at, closedInNts ? t.updated_at : null]);
          } else {
            await tx.query('UPDATE escalations SET severity = $2, summary = $3, updated_at = now() WHERE id = $1', [existing.id, severity, String(t.subject || '').slice(0, 300)]);
            // A ticket closed in NTS while still in internal triage never reached the customer: close it here too.
            if (closedInNts && existing.status === 'triage') await tx.query("UPDATE escalations SET status = 'closed', closed_at = now() WHERE id = $1", [existing.id]);
          }
        });
        processed++;
      }
      if (tickets.length < 100) break;
    }
    await asSystem(tx => tx.query("INSERT INTO worker_state (key, value) VALUES ('nts_since', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [started]));
    await markStatus('nts', true, `Synced ${processed} ticket${processed === 1 ? '' : 's'}`);
  } catch (e: any) {
    await markStatus('nts', false, e.message);
    throw e;
  }
  return processed;
}

/** Sends one queued outbound change. Throws to trigger a retry. */
export async function deliverOutbox(kind: string, payload: any): Promise<void> {
  if (config.integrationMode === 'demo') return;
  const c = await client();
  if (!c) throw new Error('NTS is not configured');
  if (kind === 'nts.note') {
    await c.call(`/api/v2/tickets/${Number(payload.ticketId)}/notes`, { method: 'POST', body: JSON.stringify({ body: payload.body, private: payload.private ?? true }) });
  } else if (kind === 'nts.status') {
    const status = payload.status === 'close' ? c.settings.statusOnClose : c.settings.statusOnEscalate;
    await c.call(`/api/v2/tickets/${Number(payload.ticketId)}`, { method: 'PUT', body: JSON.stringify({ status }) });
  } else if (kind === 'nts.request') {
    const r = await c.call('/api/v2/tickets', { method: 'POST', body: JSON.stringify({
      subject: payload.subject, description: payload.description, email: c.settings.requesterEmail || payload.email,
      priority: 2, status: 2, ...(c.settings.requestGroupId ? { group_id: c.settings.requestGroupId } : {}),
    }) });
    const ticketId = r.ticket?.id;
    if (ticketId) await asSystem(tx => tx.query('UPDATE service_requests SET nts_ticket_id = $2 WHERE id = $1', [payload.requestId, ticketId]));
  } else {
    throw new Error(`Unknown outbox kind ${kind}`);
  }
}

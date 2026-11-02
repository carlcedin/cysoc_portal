// Background worker: pulls NTS tickets, sends queued notifications and NTS write-backs with
// retries, refreshes per-tenant monitoring figures for health scoring, and expires sessions.
// Run exactly one worker process (docker-compose service `worker`).
import { config } from './config.js';
import { asSystem, closePool } from './db/index.js';
import { syncInbound, deliverOutbox } from './integrations/nts.js';
import { sendEmail, sendSms } from './integrations/notify.js';
import { tenantDashboard } from './integrations/grafana.js';
import { ackToken } from './auth/crypto.js';

async function processOutbox(): Promise<number> {
  let handled = 0;
  for (let i = 0; i < 100; i++) {
    const done = await asSystem(async tx => {
      const item = await tx.one(`SELECT id, kind, payload, attempts FROM outbox WHERE done_at IS NULL AND next_attempt_at <= now()
                                 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!item) return false;
      try {
        if (item.kind === 'email') await sendEmail(item.payload.to, item.payload.subject,
          item.payload.notificationId ? String(item.payload.text).replace('{{ACK_LINK}}', `${config.publicUrl}/ack/${ackToken(item.payload.notificationId)}`) : item.payload.text);
        else if (item.kind === 'sms') await sendSms(item.payload.to, item.payload.message);
        else await deliverOutbox(item.kind, item.payload);
        await tx.query('UPDATE outbox SET done_at = now(), last_error = NULL WHERE id = $1', [item.id]);
        if (item.payload.notificationId) await tx.query("UPDATE notifications SET status = 'sent' WHERE id = $1", [item.payload.notificationId]);
      } catch (e: any) {
        const attempts = item.attempts + 1;
        const giveUp = attempts >= 12;
        const delayMin = Math.min(60, 2 ** attempts);
        await tx.query(`UPDATE outbox SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' minutes')::interval, done_at = CASE WHEN $5 THEN now() ELSE NULL END WHERE id = $1`,
          [item.id, attempts, String(e.message).slice(0, 500), String(delayMin), giveUp]);
        if (item.payload.notificationId) await tx.query('UPDATE notifications SET status = $2 WHERE id = $1', [item.payload.notificationId, giveUp ? 'failed' : 'retrying']);
        console.warn(`[worker] ${item.kind} #${item.id} attempt ${attempts} failed: ${e.message}`);
      }
      return true;
    });
    if (!done) break;
    handled++;
  }
  return handled;
}

let lastMetrics = 0;
async function refreshMetrics() {
  if (Date.now() - lastMetrics < 15 * 60_000) return;
  lastMetrics = Date.now();
  const tenants = await asSystem(tx => tx.query('SELECT id, code, name, siem, licensed_eps, licensed_assets FROM tenants WHERE active'));
  for (const t of tenants) {
    try {
      const d = await tenantDashboard(t, '30d');
      if (!d.configured.eps && !d.configured.sources) continue;
      const peak = d.eps.length ? Math.max(...d.eps.map(p => p.v)) : null;
      const avg = d.eps.length ? d.eps.reduce((a, p) => a + p.v, 0) / d.eps.length : null;
      const down = d.sources.filter(s => !s.lastSeen || Date.now() - s.lastSeen > 15 * 60_000).length;
      await asSystem(tx => tx.query(
        `INSERT INTO tenant_metrics (tenant_id, peak_eps_30d, avg_eps_30d, sources_total, sources_down, refreshed_at) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (tenant_id) DO UPDATE SET peak_eps_30d = $2, avg_eps_30d = $3, sources_total = $4, sources_down = $5, refreshed_at = now()`,
        [t.id, peak, avg, d.sources.length, down]));
    } catch (e: any) { console.warn(`[worker] metrics for ${t.code}: ${e.message}`); }
  }
}

export async function tick() {
  try { await syncInbound(); } catch (e: any) { console.warn('[worker] NTS sync failed:', e.message); }
  try { await processOutbox(); } catch (e: any) { console.warn('[worker] outbox failed:', e.message); }
  try { await refreshMetrics(); } catch (e: any) { console.warn('[worker] metrics failed:', e.message); }
  try { await asSystem(tx => tx.query("DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - interval '1 day'")); } catch { /* next tick */ }
}

if (process.argv[1]?.endsWith('worker.js') || process.argv[1]?.endsWith('worker.ts')) {
  console.log(`[worker] started, mode=${config.integrationMode}, every ${config.workerIntervalSeconds}s`);
  let stopping = false;
  const loop = async () => { while (!stopping) { await tick(); await new Promise(r => setTimeout(r, config.workerIntervalSeconds * 1000)); } };
  const stop = async () => { stopping = true; await closePool(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  loop();
}

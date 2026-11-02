// Audit trail: every write goes to the append-only audit_log table and, when configured,
// is forwarded to the SIEM (QRadar) as LEEF over syslog.
import dgram from 'node:dgram';
import net from 'node:net';
import { config } from '../config.js';
import type { Tx } from '../db/index.js';

export interface Actor { userId: string | null; name: string; side: 'CySOC' | 'Customer' | 'System'; ip?: string; }

const leefEscape = (s: string) => s.replace(/[\t\r\n|^=]/g, ' ');
let udp: dgram.Socket | null = null;
function forward(e: { action: string; actor: Actor; tenantCode: string; details: string }) {
  if (!config.syslogHost) return;
  const ts = new Date().toISOString();
  const leef = `LEEF:2.0|TIME|CySOC Portal|1.0|${leefEscape(e.action)}|^|devTime=${ts}^usrName=${leefEscape(e.actor.name)}^src=${leefEscape(e.actor.ip || '')}^cat=${e.actor.side}^tenant=${leefEscape(e.tenantCode)}^msg=${leefEscape(e.details).slice(0, 900)}`;
  const line = `<110>1 ${ts} cysoc-portal portal - - - ${leef}`;
  try {
    if (config.syslogProtocol === 'tcp') {
      const s = net.connect(config.syslogPort, config.syslogHost, () => { s.end(line + '\n'); });
      s.on('error', err => console.warn('[syslog]', err.message));
      s.setTimeout(5000, () => s.destroy());
    } else {
      udp ??= dgram.createSocket('udp4');
      udp.send(Buffer.from(line), config.syslogPort, config.syslogHost, err => { if (err) console.warn('[syslog]', err.message); });
    }
  } catch (err: any) { console.warn('[syslog]', err.message); }
}

export async function audit(tx: Tx, actor: Actor, action: string, details: string, tenantId: string | null) {
  await tx.query(
    'INSERT INTO audit_log (user_id, actor_name, side, tenant_id, action, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [actor.userId, actor.name, actor.side, tenantId, action, details.slice(0, 2000), actor.ip ?? null],
  );
  let tenantCode = 'platform';
  if (tenantId) tenantCode = (await tx.one<{ code: string }>('SELECT code FROM tenants WHERE id = $1', [tenantId]))?.code ?? tenantId;
  forward({ action, actor, tenantCode, details });
}

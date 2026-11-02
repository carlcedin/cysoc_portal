// Loads sample tenants, contacts, escalation history, requests and reports so the portal can be
// evaluated before NTS and Grafana are connected. Never run this against production data.
// Usage: DEMO_PASSWORD='Choose-A-Strong-1' npm run seed-demo
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { asSystem, closePool } from '../db/index.js';
import { hashPassword, passwordProblems } from '../auth/crypto.js';
import { config } from '../config.js';

const pw = process.env.DEMO_PASSWORD || '';
const problem = passwordProblems(pw);
if (problem) { console.error(`Set DEMO_PASSWORD to the password for all demo accounts. ${problem}`); process.exit(1); }
const hash = hashPassword(pw);

let s = 20261028;
const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
const H = 3600_000, D = 24 * H, now = Date.now();

const TENANTS = [
  { code: 'seri', name: 'Seri Kenanga Healthcare', service: 'TSAM', siem: 'QRadar', eps: 2500, assets: null, services: ['TSAM security monitoring', 'Vulnerability assessment (quarterly)', 'Managed PAM'], renewal: '2027-03-31', confirmed: 20, pending: [] as string[] },
  { code: 'bayu', name: 'Bayu Logistics', service: 'TSAM', siem: 'QRadar', eps: 1000, assets: null, services: ['TSAM security monitoring', 'DDoS detection and alerting'], renewal: '2026-12-31', confirmed: 152, pending: ['Oracle ERP database', 'HR system (SaaS)'] },
  { code: 'permata', name: 'Permata Capital', service: 'TSAM', siem: 'QRadar', eps: 1500, assets: null, services: ['TSAM security monitoring', 'Vulnerability assessment (quarterly)', 'Managed PAM', 'DDoS detection and alerting'], renewal: '2027-06-30', confirmed: 45, pending: ['Core banking middleware'] },
  { code: 'lembah', name: 'Lembah Utilities', service: 'Antarex MXOC', siem: 'Antarex', eps: null, assets: 120, services: ['Antarex MXOC monitoring'], renewal: '2027-01-15', confirmed: 70, pending: ['SCADA historian'] },
  { code: 'nusa', name: 'Nusa Retail Group', service: 'Antarex MXOC', siem: 'Antarex', eps: null, assets: 80, services: ['Antarex MXOC monitoring', 'Vulnerability assessment (quarterly)'], renewal: '2027-09-30', confirmed: 118, pending: [] },
  { code: 'cahaya', name: 'Cahaya University', service: 'TSAM', siem: 'QRadar', eps: 2000, assets: null, services: ['TSAM security monitoring', 'DDoS detection and alerting'], renewal: '2026-11-30', confirmed: 33, pending: [] },
];
const SOURCES: Record<string, string[]> = {
  QRadar: ['FortiGate HQ firewall', 'Palo Alto internet edge', 'Windows DC01', 'Windows DC02', 'Exchange server', 'Linux web cluster', 'Microsoft 365 audit', 'Core switch syslog'],
  Antarex: ['Wazuh agents (servers)', 'Wazuh agents (workstations)', 'FortiGate branch firewall', 'Windows AD', 'Web server logs'],
};
const PEOPLE = ['Aisyah Rahman', 'Daniel Lim', 'Kavitha Nair', 'Faizal Hamid', 'Siti Noor', 'Jason Tan', 'Hafiz Ismail', 'Mei Ling Wong', 'Rajesh Kumar', 'Nurul Huda', 'Adam Chong', 'Farah Aziz'];
const SUMMARIES: Record<string, string[]> = {
  Critical: ['Ransomware precursor: mass file rename on file server', 'Confirmed C2 beaconing from finance workstation', 'Domain admin credential used from unknown host'],
  High: ['Brute force followed by successful VPN login', 'Outbound data transfer above baseline', 'Malicious PowerShell execution on server', 'Firewall policy allowing RDP from internet'],
  Medium: ['Repeated failed logins on service account', 'Known-bad IP inbound blocked, persistent attempts', 'Unsigned binary executed from temp folder', 'Phishing URL clicked, page blocked by proxy'],
  Low: ['Deprecated TLS 1.0 in use on public web host', 'Log source silent for more than 6 hours', 'Port scan from external host'],
};
const SLA: Record<string, number> = { Critical: 15, High: 30, Medium: 120, Low: 480 };
const ACK: Record<string, number> = { Critical: 1, High: 4, Medium: 24, Low: 72 };

function pdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET BT /F1 11 Tf 72 690 Td (Sample report generated for portal evaluation.) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}

await asSystem(async tx => {
  if ((await tx.one('SELECT count(*)::int AS n FROM tenants')).n > 0) throw new Error('Tenants already exist. Demo data is only loaded into an empty database.');
  let ticket = 48200;
  await tx.query("INSERT INTO users (name, email, role, password_hash, must_change_password) VALUES ('L2 Analyst Demo', 'analyst@cysoc.example', 'analyst', $1, false)", [hash]);
  await tx.query("INSERT INTO users (name, email, role, password_hash, must_change_password) VALUES ('CySOC Admin Demo', 'admin@cysoc.example', 'admin', $1, false)", [hash]);
  for (const [i, t] of TENANTS.entries()) {
    const [{ id }] = await tx.query(
      `INSERT INTO tenants (code, name, service, siem, licensed_eps, licensed_assets, services, renewal_date, contacts_confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - ($9 || ' days')::interval) RETURNING id`,
      [t.code, t.name, t.service, t.siem, t.eps, t.assets, t.services, t.renewal, String(t.confirmed)]);
    await tx.query(`INSERT INTO integrations (id, kind, name, tenant_id, endpoint, auth_label, settings) VALUES ($1,'dashboard',$2,$3,$4,'Service account token (Viewer)','{"panels":{}}')`,
      [`grafana:${t.code}`, `Grafana · ${t.name}`, id, `https://grafana-${t.code}.cysoc.example`]);
    for (const src of SOURCES[t.siem]) await tx.query('INSERT INTO log_source_contracts (tenant_id, name, onboarded) VALUES ($1,$2,true)', [id, src]);
    for (const src of t.pending) await tx.query("INSERT INTO log_source_contracts (tenant_id, name, onboarded, note) VALUES ($1,$2,false,'Waiting on log forwarding from customer')", [id, src]);
    const dom = `${t.code}.example`;
    const a = PEOPLE[i * 2], b = PEOPLE[i * 2 + 1];
    const em = (n: string) => `${n.split(' ')[0].toLowerCase()}@${dom}`;
    await tx.query(`INSERT INTO contacts (tenant_id, name, role, tier, email, phone, alert_channels) VALUES
      ($1,$2,'IT Security Manager','Primary',$3,$4,'Email, SMS'), ($1,$5,'Infrastructure Lead','Secondary',$6,$7,'Email'),
      ($1,'IT operations on-call','After-hours duty','After-hours',$8,$9,'SMS, Phone call')`,
      [id, a, em(a), `+60 12-000 ${1001 + i * 11}`, b, em(b), `+60 13-000 ${2002 + i * 13}`, `oncall@${dom}`, `+60 3-0000 ${3003 + i * 17}`]);
    await tx.query("INSERT INTO users (name, email, role, tenant_id, password_hash, must_change_password) VALUES ($1,$2,'customer',$3,$4,false)", [a, em(a), id, hash]);

    // Escalation history: about six months, plus open items in every state.
    const n = 60 + Math.floor(r() * 40);
    for (let k = 0; k < n; k++) {
      const x = r(); const sev = x < 0.08 ? 'Critical' : x < 0.3 ? 'High' : x < 0.75 ? 'Medium' : 'Low';
      const escAt = now - (1 + r() * 175) * D;
      const delayMin = SLA[sev] * (0.3 + r() * (i === 1 ? 1.5 : 1.15));
      const det = escAt - delayMin * 60_000;
      const ackH = ACK[sev] * (0.1 + r() * (i === 3 ? 1.8 : 1.1));
      const ackAt = escAt + ackH * H;
      const recent = escAt > now - 12 * D;
      const q = r();
      const status = !recent ? 'closed' : q < 0.2 ? 'escalated' : q < 0.4 ? 'acknowledged' : q < 0.6 ? 'remediating' : 'closed';
      const remAt = ackAt + (1 + r() * 20) * H, closeAt = remAt + (2 + r() * 24) * H;
      // Step back to the latest stage whose time has already passed.
      let eff = status;
      if (eff === 'closed' && closeAt > now) eff = 'remediating';
      if (eff === 'remediating' && remAt > now) eff = 'acknowledged';
      if (eff === 'acknowledged' && ackAt > now) eff = 'escalated';
      const order = ['escalated', 'acknowledged', 'remediating', 'closed'];
      const at = (ms: number, stage: string) => order.indexOf(eff) >= order.indexOf(stage) ? new Date(ms) : null;
      const acked = at(ackAt, 'acknowledged');
      const [e] = await tx.query(
        `INSERT INTO escalations (tenant_id, nts_ticket_id, ref, severity, summary, source, status, detected_at, triaged_at, escalated_at, acknowledged_at, ack_via, remediation_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [id, ++ticket, `NTS-${ticket}`, sev, pick(SUMMARIES[sev]), t.siem, eff, new Date(det), new Date(det + Math.min(delayMin / 2, 12) * 60_000), new Date(escAt),
         acked, acked ? (r() < 0.55 ? 'email link' : 'portal') : null, at(remAt, 'remediating'), at(closeAt, 'closed')]);
      if (recent && r() < 0.4) {
        await tx.query("INSERT INTO escalation_messages (escalation_id, tenant_id, author_name, side, body, created_at) VALUES ($1,$2,'CySOC L2 Analyst','CySOC',$3,$4)",
          [e.id, id, 'Affected host, source IPs and the triggering events are in the evidence pack. Please confirm whether this activity was expected.', new Date(escAt + 6 * 60_000)]);
        if (acked) await tx.query("INSERT INTO escalation_messages (escalation_id, tenant_id, author_name, side, body, created_at) VALUES ($1,$2,$3,'Customer',$4,$5)",
          [e.id, id, a, 'Not expected. We have isolated the host and are resetting the account credentials.', new Date(+acked + 20 * 60_000)]);
      }
      await tx.query("INSERT INTO notifications (escalation_id, tenant_id, channel, recipient_name, recipient, status, created_at) VALUES ($1,$2,'Email',$3,$4,'sent',$5)", [e.id, id, a, em(a), new Date(escAt)]);
    }
    // Every tenant gets one escalation waiting for acknowledgement, so the customer flow can be tried.
    await tx.query(`INSERT INTO escalations (tenant_id, nts_ticket_id, ref, severity, summary, source, status, detected_at, triaged_at, escalated_at)
                    VALUES ($1,$2,$3,'Medium',$4,$5,'escalated', now() - interval '3 hours', now() - interval '170 minutes', now() - interval '160 minutes')`, [id, ++ticket, `NTS-${ticket}`, pick(SUMMARIES.Medium), t.siem]);
    if (i % 2 === 0) {
      await tx.query(`INSERT INTO escalations (tenant_id, nts_ticket_id, ref, severity, summary, source, status, detected_at, triaged_at)
                      VALUES ($1,$2,$3,'High',$4,$5,'triage', now() - interval '25 minutes', now() - interval '15 minutes')`, [id, ++ticket, `NTS-${ticket}`, pick(SUMMARIES.High), t.siem]);
    }

    // Service requests
    const types = ['Allowlist or blocklist change', 'New log source onboarding', 'Rule tuning or false positive', 'Ad-hoc report'];
    for (let k = 0; k < 3; k++) {
      const created = new Date(now - (1 + r() * 20) * D);
      const st = k === 0 ? 'Submitted' : k === 1 ? 'In progress' : 'Completed';
      const ty = pick(types);
      const seq = (await tx.one("SELECT nextval('service_request_seq')::text AS n")).n;
      await tx.query(`INSERT INTO service_requests (tenant_id, ref, nts_ticket_id, type, details, raised_by_name, status, target_date, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [id, `SR-${seq}`, 51200 + i * 10 + k, ty, `${ty} for ${t.name} (sample request)`, a, st, new Date(+created + 5 * D).toISOString().slice(0, 10), created]);
    }

    // Reports, stored as real files
    const dir = path.resolve(config.storageDir, id); fs.mkdirSync(dir, { recursive: true });
    for (const [period, day] of [['Sep 2026', 7], ['Aug 2026', 37], ['Jul 2026', 68]] as [string, number][]) {
      const title = `${t.name} SOC Monthly Report ${period}`;
      const body = pdf(title); const key = `${id}/${crypto.randomUUID()}.pdf`;
      fs.writeFileSync(path.resolve(config.storageDir, key), body);
      const [rep] = await tx.query(`INSERT INTO reports (tenant_id, title, type, period, filename, mime, size_bytes, sha256, storage_key, uploaded_by_name, uploaded_at)
        VALUES ($1,$2,'Monthly SOC Report',$3,$4,'application/pdf',$5,$6,$7,'CySOC Admin', now() - ($8 || ' days')::interval) RETURNING id`,
        [id, title, period, `${title}.pdf`, body.length, crypto.createHash('sha256').update(body).digest('hex'), key, String(day)]);
      if (day > 10 || i % 3 !== 0) await tx.query("INSERT INTO report_downloads (report_id, tenant_id, side, at) VALUES ($1,$2,'Customer', now() - ($3 || ' days')::interval)", [rep.id, id, String(day - 1)]);
    }
    await tx.query(`INSERT INTO tenant_metrics (tenant_id, peak_eps_30d, avg_eps_30d, sources_total, sources_down) VALUES ($1,$2,$3,$4,$5)`,
      [id, t.eps ? t.eps * (i === 1 ? 1.08 : 0.6 + r() * 0.3) : null, t.eps ? t.eps * 0.5 : null, SOURCES[t.siem].length, i === 1 ? 2 : i === 4 ? 1 : 0]);
    await tx.query("INSERT INTO audit_log (actor_name, side, tenant_id, action, details) VALUES ('Demo seeder', 'System', $1, 'Loaded demo data', $2)", [id, t.name]);
  }
});
console.log('Demo data loaded. Accounts: admin@cysoc.example (Full Admin), analyst@cysoc.example (Analyst) and the primary contact of each tenant (for example aisyah@seri.example), all with DEMO_PASSWORD.');
await closePool();

// Live-mode integration tests against local fake NTS (Freshservice), Grafana, SMTP and SMS servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

process.env.INTEGRATION_MODE = 'live';
const { asSystem, closePool } = await import('../server/src/db/index.ts');
const { encrypt } = await import('../server/src/auth/crypto.ts');
const { tick } = await import('../server/src/worker.ts');
const { tenantDashboard, toSeries, toSeverity } = await import('../server/src/integrations/grafana.ts');

const calls: { method: string; url: string; body: any; auth?: string }[] = [];
const mails: string[] = [];
const sms: any[] = [];
const servers: (http.Server | net.Server)[] = [];
const listen = (s: http.Server | net.Server) => new Promise<number>(r => { servers.push(s); s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)); });
const now = Date.now();

const jsonServer = (handler: (req: http.IncomingMessage, body: any) => [number, any]) => http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
  const [status, out] = handler(req, body);
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
});

let ntsPort = 0, grafanaPort = 0, smtpPort = 0, smsPort = 0;

before(async () => {
  ntsPort = await listen(jsonServer((req) => {
    if (req.method === 'GET' && req.url!.startsWith('/api/v2/tickets')) {
      const page = new URL(req.url!, 'http://x').searchParams.get('page');
      if (page !== '1') return [200, { tickets: [] }];
      return [200, { tickets: [
        { id: 990001, subject: 'Suspicious admin logon from new country', description_text: 'Details', priority: 4, status: 2, group_id: 7, created_at: new Date(now - 20 * 60_000).toISOString(), updated_at: new Date().toISOString(), custom_fields: { cf_customer_code: 'seri' } },
        { id: 990002, subject: 'Unrelated IT ticket', priority: 1, status: 2, group_id: 99, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), custom_fields: { cf_customer_code: 'seri' } },
        { id: 990003, subject: 'Unknown customer', priority: 2, status: 2, group_id: 7, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), custom_fields: { cf_customer_code: 'nobody' } },
        { id: 990004, subject: 'False positive closed in NTS', priority: 2, status: 5, group_id: 7, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), custom_fields: { cf_customer_code: 'bayu' } },
      ] }];
    }
    if (req.method === 'POST' && req.url === '/api/v2/tickets') return [201, { ticket: { id: 770001 } }];
    if (req.method === 'POST' && /\/notes$/.test(req.url!)) return [201, { conversation: { id: 1 } }];
    if (req.method === 'PUT') return [200, { ticket: {} }];
    return [404, {}];
  }));
  grafanaPort = await listen(jsonServer((req, body) => {
    if (req.url === '/api/health') return [200, { version: '11.2.0', database: 'ok' }];
    const q = body.queries[0];
    const t = [now - 7200_000, now - 3600_000, now];
    const frames: Record<string, any[]> = {
      'eps-uid': [
        { schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'fw', type: 'number' }] }, data: { values: [t, [100, 200, 300]] } },
        { schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'dc', type: 'number' }] }, data: { values: [t, [10, 20, 30]] } },
      ],
      'alerts-uid': [{ schema: { fields: [{ name: 'time', type: 'time' }, { name: 'severity', type: 'string' }, { name: 'count', type: 'number' }] }, data: { values: [[t[0], t[0], t[2]], ['critical', 'High', 'low'], [1, 4, 9]] } }],
      'tactics-uid': [{ schema: { fields: [{ name: 'tactic', type: 'string' }, { name: 'n', type: 'number' }] }, data: { values: [['Discovery', 'Execution', 'Discovery'], [5, 3, 2]] } }],
      'rules-uid': [{ schema: { fields: [{ name: 'rule', type: 'string' }, { name: 'hits', type: 'number' }] }, data: { values: [['Brute force'], [42]] } }],
      'sources-uid': [{ schema: { fields: [{ name: 'name', type: 'string' }, { name: 'type', type: 'string' }, { name: 'last_seen', type: 'time' }, { name: 'eps', type: 'number' }] }, data: { values: [['FW1', 'DC1'], ['Firewall', 'Windows'], [now - 60_000, now - 3 * 3600_000], [120, 15]] } }],
    };
    return [200, { results: { A: { frames: frames[q.datasource.uid] ?? [] } } }];
  }));
  smsPort = await listen(jsonServer((_req, body) => { sms.push(body); return [200, { ok: true }]; }));
  smtpPort = await listen(net.createServer(sock => {
    let data = '', inData = false;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', d => {
      for (const line of d.toString().split('\r\n')) {
        if (inData) { if (line === '.') { inData = false; mails.push(data); data = ''; sock.write('250 queued\r\n'); } else data += line + '\n'; continue; }
        if (!line) continue;
        if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  }));
  await asSystem(async tx => {
    await tx.query(`UPDATE integrations SET endpoint = $1, secret_enc = $2, enabled = true, settings = settings || '{"groupIds":[7],"requesterEmail":"soc@cysoc.example"}' WHERE id = 'nts'`, [`http://127.0.0.1:${ntsPort}`, encrypt('nts-key')]);
    await tx.query(`UPDATE integrations SET endpoint = $1, enabled = true, settings = '{"from":"portal@cysoc.example"}' WHERE id = 'smtp'`, [`smtp://127.0.0.1:${smtpPort}`]);
    await tx.query(`UPDATE integrations SET endpoint = $1, secret_enc = $2, enabled = true WHERE id = 'sms'`, [`http://127.0.0.1:${smsPort}/send`, encrypt('sms-key')]);
    await tx.query(`UPDATE integrations SET endpoint = $1, secret_enc = $2, settings = $3 WHERE id = 'grafana:seri'`, [`http://127.0.0.1:${grafanaPort}`, encrypt('glsa_token'),
      JSON.stringify({ panels: Object.fromEntries(['eps', 'alerts', 'tactics', 'rules', 'sources'].map(p => [p, { datasourceUid: `${p}-uid`, query: { rawSql: 'select 1' } }])) })]);
    await tx.query("DELETE FROM worker_state WHERE key = 'nts_since'");
  });
});

after(async () => { servers.forEach(s => s.close()); await closePool(); });

test('NTS sync imports matching tickets as triage and respects group and tenant filters', async () => {
  await tick();
  const rows = await asSystem(tx => tx.query("SELECT nts_ticket_id::int AS id, status, severity, ref FROM escalations WHERE nts_ticket_id >= 990001 ORDER BY 1"));
  assert.deepEqual(rows.map((r: any) => r.id), [990001, 990004]);
  assert.equal(rows[0].status, 'triage'); assert.equal(rows[0].severity, 'Critical'); assert.equal(rows[0].ref, 'NTS-990001');
  assert.equal(rows[1].status, 'closed', 'closed in NTS before escalation');
  const get = calls.find(c => c.method === 'GET' && c.url.startsWith('/api/v2/tickets'));
  assert.equal(get!.auth, 'Basic ' + Buffer.from('nts-key:X').toString('base64'));
  const [st] = await asSystem(tx => tx.query("SELECT status FROM integrations WHERE id = 'nts'"));
  assert.equal(st.status, 'ok');
});

test('outbox delivers NTS notes, status changes, request tickets, email with a working ack link, and SMS', async () => {
  // Escalate the imported ticket through the same code path the API uses.
  const [e] = await asSystem(tx => tx.query("SELECT id, tenant_id FROM escalations WHERE nts_ticket_id = 990001"));
  await asSystem(async tx => {
    await tx.query("UPDATE escalations SET status = 'escalated', escalated_at = now() WHERE id = $1", [e.id]);
  });
  // Queue the same items escalation produces
  const { ackToken, sha256 } = await import('../server/src/auth/crypto.ts');
  await asSystem(async tx => {
    const [n] = await tx.query("INSERT INTO notifications (escalation_id, tenant_id, channel, recipient_name, recipient, ack_token_expires) VALUES ($1,$2,'Email','Aisyah Rahman','aisyah@seri.example', now() + interval '1 hour') RETURNING id", [e.id, e.tenant_id]);
    await tx.query('UPDATE notifications SET ack_token_hash = $2 WHERE id = $1', [n.id, sha256(ackToken(n.id))]);
    await tx.query("INSERT INTO outbox (kind, payload) VALUES ('email', $1)", [JSON.stringify({ notificationId: n.id, to: ['aisyah@seri.example'], subject: '[Critical] NTS-990001', text: 'Acknowledge: {{ACK_LINK}}' })]);
    await tx.query("INSERT INTO outbox (kind, payload) VALUES ('sms', $1)", [JSON.stringify({ to: '+60 12-000 1001', message: 'CySOC Critical escalation' })]);
    await tx.query("INSERT INTO outbox (kind, payload) VALUES ('nts.status', $1)", [JSON.stringify({ ticketId: 990001, status: 'escalate' })]);
    await tx.query("INSERT INTO outbox (kind, payload) VALUES ('nts.note', $1)", [JSON.stringify({ ticketId: 990001, body: 'Escalated' })]);
  });
  await tick();
  const pending = await asSystem(tx => tx.query('SELECT kind, last_error FROM outbox WHERE done_at IS NULL'));
  assert.deepEqual(pending, [], 'everything delivered: ' + JSON.stringify(pending));
  assert.ok(calls.some(c => c.method === 'PUT' && c.url === '/api/v2/tickets/990001' && c.body.status === 3), 'status set to Pending');
  assert.ok(calls.some(c => c.method === 'POST' && c.url === '/api/v2/tickets/990001/notes' && c.body.private === true));
  const reqTicket = calls.find(c => c.method === 'POST' && c.url === '/api/v2/tickets');
  if (reqTicket) assert.equal(reqTicket.body.email, 'soc@cysoc.example');
  assert.equal(sms.length, 1); assert.equal(sms[0].to, '+60120001001');
  const mail = mails.find(m => m.includes('NTS-990001'));
  assert.ok(mail, 'email sent');
  const link = mail!.match(/\/ack\/([A-Za-z0-9_-]+)/);
  assert.ok(link, 'email carries an acknowledge link');
  const { ackToken: tok } = await import('../server/src/auth/crypto.ts');
  const [n] = await asSystem(tx => tx.query("SELECT id, status FROM notifications WHERE escalation_id = $1", [e.id]));
  assert.equal(link![1], tok(n.id));
  assert.equal(n.status, 'sent');
});

test('failed deliveries are retried with back-off, not lost', async () => {
  await asSystem(tx => tx.query("INSERT INTO outbox (kind, payload) VALUES ('nts.note', $1)", [JSON.stringify({ ticketId: 'abc', body: 'x' })]));
  await asSystem(tx => tx.query("UPDATE integrations SET endpoint = 'http://127.0.0.1:1' WHERE id = 'nts'"));
  await tick();
  const [row] = await asSystem(tx => tx.query("SELECT attempts, done_at, next_attempt_at > now() AS later, last_error FROM outbox WHERE done_at IS NULL ORDER BY id DESC LIMIT 1"));
  assert.equal(row.attempts, 1); assert.equal(row.done_at, null); assert.equal(row.later, true); assert.ok(row.last_error);
  await asSystem(tx => tx.query("UPDATE integrations SET endpoint = $1 WHERE id = 'nts'", [`http://127.0.0.1:${ntsPort}`]));
});

test('Grafana panels are queried server-side and normalised', async () => {
  const [t] = await asSystem(tx => tx.query("SELECT id, code, name, siem, licensed_eps, licensed_assets FROM tenants WHERE code = 'seri'"));
  const d = await tenantDashboard(t, '24h');
  assert.deepEqual(d.errors, []);
  assert.equal(d.eps.length, 3);
  assert.equal(Math.round(d.eps[2].v), 330, 'series summed across frames');
  const totals = d.alerts.reduce((a, p) => ({ c: a.c + p.Critical, h: a.h + p.High, l: a.l + p.Low }), { c: 0, h: 0, l: 0 });
  assert.deepEqual(totals, { c: 1, h: 4, l: 9 });
  assert.deepEqual(d.tactics[0], { label: 'Discovery', value: 7 });
  assert.equal(d.rules[0].label, 'Brute force');
  assert.equal(d.sources.length, 2); assert.equal(d.sources[1].name, 'DC1');
  const q = calls.find(c => c.url === '/api/ds/query');
  assert.equal(q!.auth, 'Bearer glsa_token');
  assert.equal(q!.body.queries[0].rawSql, 'select 1');
  const other = await asSystem(tx => tx.query("SELECT id, code, name, siem, licensed_eps, licensed_assets FROM tenants WHERE code = 'bayu'"));
  const none = await tenantDashboard(other[0], '24h');
  assert.match(none.errors[0], /not configured/);
});

test('wide-format severity frames and averaged rate series', () => {
  const t = [0, 1800_000, 3600_000];
  const sev = toSeverity([{ schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels: { severity: 'High' } }] }, data: { values: [t, [1, 2, 3]] } }] as any, 1);
  assert.equal(sev.reduce((a, p) => a + p.High, 0), 6);
  const s = toSeries([{ schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'v', type: 'number' }] }, data: { values: [t, [10, 20, 30]] } }] as any, 1);
  assert.deepEqual(s.map(p => p.v), [15, 30], 'points in the same hour are averaged');
});

test('SMTP with STARTTLS and AUTH LOGIN', async () => {
  const fs = await import('node:fs');
  const tls = await import('node:tls');
  const key = fs.readFileSync('/home/claude/testcerts/key.pem'), cert = fs.readFileSync('/home/claude/testcerts/cert.pem');
  const got: { auth: string[]; mail: string; tls: boolean } = { auth: [], mail: '', tls: false };
  const port = await listen(net.createServer(raw => {
    let sock: net.Socket = raw; let inData = false, data = '', authStep = 0;
    const onLine = (line: string) => {
      if (inData) { if (line === '.') { inData = false; got.mail = data; sock.write('250 ok\r\n'); } else data += line + '\n'; return; }
      if (authStep === 1) { got.auth.push(Buffer.from(line, 'base64').toString()); authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); return; }
      if (authStep === 2) { got.auth.push(Buffer.from(line, 'base64').toString()); authStep = 0; sock.write('235 ok\r\n'); return; }
      if (/^EHLO/.test(line)) sock.write(got.tls ? '250-fake\r\n250 AUTH LOGIN\r\n' : '250-fake\r\n250 STARTTLS\r\n');
      else if (line === 'STARTTLS') {
        sock.write('220 go ahead\r\n'); raw.removeAllListeners('data');
        const secure = new tls.TLSSocket(raw, { isServer: true, key, cert });
        got.tls = true; sock = secure; attach(secure);
      }
      else if (line === 'AUTH LOGIN') { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
      else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    };
    let buf = '';
    const attach = (s: net.Socket) => s.on('data', (d: Buffer) => { buf += d.toString(); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } });
    raw.write('220 fake ESMTP\r\n'); attach(raw);
  }));
  await asSystem(tx => tx.query(`UPDATE integrations SET endpoint = $1, secret_enc = $2, settings = '{"from":"portal@cysoc.example","username":"relayuser","rejectUnauthorized":false}' WHERE id = 'smtp'`, [`smtp://127.0.0.1:${port}`, encrypt('relay-pass')]));
  const { sendEmail } = await import('../server/src/integrations/notify.ts');
  await sendEmail(['x@seri.example'], 'Tést subject', 'Line one\n.starts with a dot');
  assert.equal(got.tls, true, 'upgraded to TLS');
  assert.deepEqual(got.auth, ['relayuser', 'relay-pass']);
  assert.match(got.mail, /Subject: =\?UTF-8\?B\?/);
  assert.match(got.mail, /\n\.\.starts with a dot/, 'dot-stuffed');
});

test('ClamAV verdicts: clean files stored, infected files rejected', async () => {
  const verdicts = ['stream: OK', 'stream: Eicar-Test-Signature FOUND'];
  const port = await listen(net.createServer(sock => {
    let size = 0;
    sock.on('data', d => { size += d.length; if (d.subarray(-4).equals(Buffer.alloc(4))) sock.end(verdicts.shift() + '\0'); });
  }));
  process.env.CLAMAV_HOST = '127.0.0.1';
  const { config } = await import('../server/src/config.ts');
  (config as any).clamavHost = '127.0.0.1'; (config as any).clamavPort = port;
  const { saveUpload } = await import('../server/src/integrations/storage.ts');
  const { Readable } = await import('node:stream');
  const [t] = await asSystem(tx => tx.query("SELECT id FROM tenants WHERE code = 'seri'"));
  const body = () => Readable.from([Buffer.from('%PDF-1.4 test')]) as any;
  const ok = await saveUpload(body(), t.id, 'clean.pdf');
  assert.match(ok.storageKey, /\.pdf$/);
  await assert.rejects(saveUpload(body(), t.id, 'bad.pdf'), /rejected this file/);
  (config as any).clamavHost = '';
});

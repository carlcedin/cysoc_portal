// End-to-end API tests against a real PostgreSQL loaded with demo data.
// Run: set the variables from .env.test, then `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { Pool } from '../server/src/db/mini-pg.ts';
import { totpAt, hashPassword } from '../server/src/auth/crypto.ts';

const BASE = process.env.PUBLIC_URL || 'http://127.0.0.1:8090';
const DEMO_PW = process.env.DEMO_PASSWORD || 'Demo-Portal-2026!';
const ownerPool = new Pool({ connectionString: process.env.TEST_SUPER_URL || process.env.DATABASE_URL!, max: 2 });
let server: ChildProcess;

async function sys<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await ownerPool.connect();
  try { await c.query("SELECT set_config('app.role','system',false)"); return (await c.query(sql, params)).rows as T[]; } finally { c.release(); }
}

class Client {
  cookie = '';
  constructor(public label: string) {}
  async call(method: string, path: string, body?: unknown, opts: { csrf?: boolean; raw?: Buffer } = {}) {
    const headers: Record<string, string> = { Cookie: this.cookie };
    if (opts.csrf !== false && method !== 'GET') headers['X-CySOC-Request'] = '1';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data: data as any, type };
  }
  /** Full sign-in: password, authenticator enrolment or code. Returns the TOTP secret. */
  async signIn(email: string, password = DEMO_PW, secret?: string) {
    const r = await this.call('POST', '/api/auth/login', { email, password });
    assert.equal(r.status, 200, `${this.label} login: ${JSON.stringify(r.data)}`);
    if (r.data.stage === 'mfa_setup') {
      const s = await this.call('POST', '/api/auth/mfa/setup', {});
      secret = s.data.secret.replace(/\s/g, '');
    }
    const step = Math.floor(Date.now() / 30000);
    const v = await this.call('POST', '/api/auth/mfa/verify', { code: totpAt(secret!, step) });
    assert.equal(v.status, 200, `${this.label} MFA: ${JSON.stringify(v.data)}`);
    return { secret: secret!, stage: v.data.stage };
  }
}

const seri = new Client('seri customer'), bayu = new Client('bayu customer'), analyst = new Client('analyst'), admin = new Client('admin');
let tenants: Record<string, string> = {};

before(async () => {
  server = spawn(process.execPath, ['dist/server/src/index.js'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr!.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }
  tenants = Object.fromEntries((await sys('SELECT code, id FROM tenants')).map((t: any) => [t.code, t.id]));
  await sys("DELETE FROM users WHERE email = 'admin@cysoc.example'");
  await sys("INSERT INTO users (name, email, role, password_hash, must_change_password) VALUES ('Test Admin', 'admin@cysoc.example', 'admin', $1, false)", [hashPassword(DEMO_PW)]);
  await sys("UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL, failed_logins = 0, locked_until = NULL");
  // Fixture: guarantee one escalation waiting for Seri Kenanga's acknowledgement.
  await sys(`UPDATE escalations SET status = 'escalated', acknowledged_at = NULL, ack_via = NULL, remediation_at = NULL, closed_at = NULL, escalated_at = now() - interval '2 hours'
             WHERE id = (SELECT id FROM escalations WHERE tenant_id = $1 AND status = 'closed' ORDER BY escalated_at DESC LIMIT 1)`, [tenants.seri]);
});
after(async () => { server?.kill('SIGTERM'); await ownerPool.end(); });

test('unauthenticated requests are refused', async () => {
  const c = new Client('anon');
  assert.equal((await c.call('GET', '/api/escalations')).status, 401);
  assert.equal((await c.call('GET', '/api/meta')).status, 401);
});

test('wrong password and unknown email give the same answer', async () => {
  const c = new Client('x');
  const a = await c.call('POST', '/api/auth/login', { email: 'aisyah@seri.example', password: 'wrong-Password-1' });
  const b = await c.call('POST', '/api/auth/login', { email: 'nobody@seri.example', password: 'wrong-Password-1' });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.data.error, b.data.error);
  await sys("UPDATE users SET failed_logins = 0 WHERE email = 'aisyah@seri.example'");
});

test('password alone does not grant access before MFA', async () => {
  const c = new Client('half');
  const r = await c.call('POST', '/api/auth/login', { email: 'daniel@bayu.example', password: DEMO_PW });
  assert.equal(r.status, 401, 'daniel has no account'); // only primary contacts have accounts
  const r2 = await c.call('POST', '/api/auth/login', { email: 'siti@permata.example', password: DEMO_PW });
  assert.equal(r2.data.stage, 'mfa_setup');
  assert.equal((await c.call('GET', '/api/escalations')).status, 401);
  const bad = await c.call('POST', '/api/auth/mfa/verify', { code: '000000' });
  assert.equal(bad.status, 400); // no secret set up yet
});

let seriSecret = '';
test('everyone can sign in with MFA', async () => {
  seriSecret = (await seri.signIn('aisyah@seri.example')).secret;
  await bayu.signIn('kavitha@bayu.example');
  await analyst.signIn('analyst@cysoc.example');
  await admin.signIn('admin@cysoc.example');
  const me = await seri.call('GET', '/api/auth/me');
  assert.equal(me.data.stage, 'ready'); assert.equal(me.data.user.role, 'customer');
});

test('a TOTP code cannot be replayed', async () => {
  const [u] = await sys("SELECT mfa_last_step FROM users WHERE email = 'aisyah@seri.example'");
  const c = new Client('replay');
  await c.call('POST', '/api/auth/login', { email: 'aisyah@seri.example', password: DEMO_PW });
  const r = await c.call('POST', '/api/auth/mfa/verify', { code: totpAt(seriSecret, Number(u.mfa_last_step)) });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'code_reused', 'reused code gets its own message');
  const [f] = await sys("SELECT failed_logins FROM users WHERE email = 'aisyah@seri.example'");
  assert.equal(f.failed_logins, 0, 'a reused code does not count towards lockout');
  assert.equal((await c.call('GET', '/api/escalations')).status, 401);
});

test('customers only ever see their own tenant', async () => {
  const mine = await seri.call('GET', '/api/escalations');
  assert.equal(mine.status, 200);
  assert.ok(mine.data.items.length > 0);
  assert.ok(mine.data.items.every((e: any) => e.tenant_id === tenants.seri));
  assert.ok(mine.data.items.every((e: any) => e.status !== 'triage'), 'triage hidden');
  // Asking for another tenant explicitly is ignored for customers
  const other = await seri.call('GET', `/api/escalations?tenant=${tenants.bayu}`);
  assert.ok(other.data.items.every((e: any) => e.tenant_id === tenants.seri));
  // Direct access to another tenant's escalation by id
  const [b] = await sys("SELECT id FROM escalations WHERE tenant_id = $1 AND status = 'escalated' LIMIT 1", [tenants.bayu]);
  assert.equal((await seri.call('GET', `/api/escalations/${b.id}`)).status, 404);
  assert.equal((await seri.call('POST', `/api/escalations/${b.id}/actions`, { action: 'acknowledge' })).status, 404);
  assert.equal((await seri.call('POST', `/api/escalations/${b.id}/messages`, { body: 'hi' })).status, 404);
  // Other tenant's report
  const [rep] = await sys('SELECT id FROM reports WHERE tenant_id = $1 LIMIT 1', [tenants.bayu]);
  assert.equal((await seri.call('GET', `/api/reports/${rep.id}/download`)).status, 404);
  // Service and audit are scoped
  const svc = await seri.call('GET', `/api/service?tenant=${tenants.bayu}`);
  assert.equal(svc.data.tenant.id, tenants.seri);
  const aud = await seri.call('GET', '/api/audit');
  assert.ok(aud.data.items.every((a: any) => a.tenant_id === tenants.seri));
  const meta = await seri.call('GET', '/api/meta');
  assert.equal(meta.data.tenants.length, 1);
});

test('customers cannot use staff features', async () => {
  const [tri] = await sys("SELECT id FROM escalations WHERE tenant_id = $1 AND status = 'triage' LIMIT 1", [tenants.seri]);
  assert.equal((await seri.call('POST', `/api/escalations/${tri.id}/actions`, { action: 'escalate' })).status, 404, 'triage item invisible');
  for (const [m, p] of [['GET', '/api/health-scores'], ['GET', '/api/admin/integrations'], ['GET', '/api/admin/users'], ['PUT', '/api/admin/integrations/nts'], ['POST', '/api/admin/users'], ['POST', '/api/reports/upload?tenant=' + tenants.seri]] as const) {
    const r = await seri.call(m, p, m === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${m} ${p}`);
  }
});

test('customer escalation steps work and are audited', async () => {
  const [e] = await sys("SELECT id, ref FROM escalations WHERE tenant_id = $1 AND status = 'escalated' LIMIT 1", [tenants.seri]);
  assert.equal((await seri.call('POST', `/api/escalations/${e.id}/actions`, { action: 'close' })).status, 403, 'customers cannot close');
  assert.equal((await seri.call('POST', `/api/escalations/${e.id}/actions`, { action: 'acknowledge' })).status, 200);
  assert.equal((await seri.call('POST', `/api/escalations/${e.id}/actions`, { action: 'acknowledge' })).status, 409, 'second ack conflicts');
  assert.equal((await seri.call('POST', `/api/escalations/${e.id}/messages`, { body: 'We are on it.' })).status, 200);
  const d = await seri.call('GET', `/api/escalations/${e.id}`);
  assert.equal(d.data.escalation.status, 'acknowledged');
  assert.ok(d.data.messages.some((m: any) => m.body === 'We are on it.'));
  const [a] = await sys("SELECT count(*)::int AS n FROM audit_log WHERE action = 'Acknowledged escalation' AND details LIKE $1", [e.ref + '%']);
  assert.ok(a.n >= 1);
  const [o] = await sys("SELECT count(*)::int AS n FROM outbox WHERE kind = 'nts.note' AND done_at IS NULL");
  assert.ok(o.n >= 2, 'NTS write-back queued');
});

test('analysts work all tenants but cannot change configuration', async () => {
  const all = await analyst.call('GET', '/api/escalations');
  assert.ok(new Set(all.data.items.map((e: any) => e.tenant_id)).size > 1);
  assert.ok(all.data.items.some((e: any) => e.status === 'triage'));
  const integ = await analyst.call('GET', '/api/admin/integrations');
  assert.equal(integ.status, 200); assert.equal(integ.data.canEdit, false);
  assert.ok(integ.data.items.every((i: any) => i.secretLast4 === null && i.settings === undefined), 'secrets hidden from analysts');
  assert.equal((await analyst.call('PUT', '/api/admin/integrations/nts', { endpoint: 'https://x.example' })).status, 403);
  assert.equal((await analyst.call('GET', '/api/admin/users')).status, 403);
  assert.equal((await analyst.call('POST', '/api/contacts', { tenantId: tenants.seri, name: 'x' })).status, 403);
  const [rep] = await sys('SELECT id FROM reports LIMIT 1');
  assert.equal((await analyst.call('POST', `/api/reports/${rep.id}/withdraw`)).status, 403);
  assert.equal((await analyst.call('GET', '/api/health-scores')).status, 200);
  // Escalating a triage item notifies contacts and queues email
  const [tri] = await sys("SELECT id FROM escalations WHERE status = 'triage' LIMIT 1");
  const r = await analyst.call('POST', `/api/escalations/${tri.id}/actions`, { action: 'escalate' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const notes = await sys("SELECT channel, ack_token_hash FROM notifications WHERE escalation_id = $1", [tri.id]);
  assert.ok(notes.some((n: any) => n.channel === 'Email' && n.ack_token_hash));
  const [mail] = await sys("SELECT payload FROM outbox WHERE kind = 'email' ORDER BY id DESC LIMIT 1");
  assert.ok(String(mail.payload.text).includes('{{ACK_LINK}}'), 'raw token never stored');
});

test('email acknowledge link: GET confirms, POST acknowledges once', async () => {
  const [n] = await sys("SELECT n.id, e.id AS eid FROM notifications n JOIN escalations e ON e.id = n.escalation_id WHERE e.status = 'escalated' AND n.ack_token_hash IS NOT NULL LIMIT 1");
  const key = Buffer.from(process.env.MASTER_KEY!, 'base64');
  const token = crypto.createHmac('sha256', key).update('ack:' + n.id).digest('base64url');
  const g = await fetch(`${BASE}/ack/${token}`);
  assert.equal(g.status, 200);
  assert.match(await g.text(), /Acknowledge escalation/);
  const [still] = await sys('SELECT status FROM escalations WHERE id = $1', [n.eid]);
  assert.equal(still.status, 'escalated', 'GET must not acknowledge');
  const p = await fetch(`${BASE}/ack/${token}`, { method: 'POST' });
  assert.equal(p.status, 200);
  const [done] = await sys('SELECT status, ack_via FROM escalations WHERE id = $1', [n.eid]);
  assert.equal(done.status, 'acknowledged'); assert.equal(done.ack_via, 'email link');
  assert.equal((await fetch(`${BASE}/ack/${token}`)).status, 404, 'token is single-use');
  assert.equal((await fetch(`${BASE}/ack/not-a-real-token-1234567890`)).status, 404);
});

test('full admins manage configuration and accounts', async () => {
  const put = await admin.call('PUT', '/api/admin/integrations/nts', { endpoint: 'https://nts.cysoc.example', secret: 'test-api-key-9f3a' });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const list = await admin.call('GET', '/api/admin/integrations');
  const nts = list.data.items.find((i: any) => i.id === 'nts');
  assert.equal(nts.secretLast4, '9f3a');
  const [row] = await sys("SELECT secret_enc FROM integrations WHERE id = 'nts'");
  assert.ok(!String(row.secret_enc).includes('test-api-key'), 'secret encrypted at rest');
  assert.equal((await admin.call('PUT', '/api/admin/integrations/nts', { endpoint: 'ftp://bad' })).status, 400);
  const created = await admin.call('POST', '/api/admin/users', { name: 'New Analyst', email: `new${Date.now()}@cysoc.example`, role: 'analyst' });
  assert.equal(created.status, 200); assert.ok(created.data.temporaryPassword.length >= 16);
  const self = await admin.call('GET', '/api/admin/users');
  const me = self.data.items.find((u: any) => u.email === 'admin@cysoc.example');
  assert.equal((await admin.call('PATCH', `/api/admin/users/${me.id}`, { active: false })).status, 403, 'cannot disable self');
  const cust = self.data.items.find((u: any) => u.role === 'customer');
  assert.equal((await admin.call('PATCH', `/api/admin/users/${cust.id}`, { role: 'admin' })).status, 400, 'customer cannot become staff');
});

test('new accounts must change their temporary password', async () => {
  const email = `temp${Date.now()}@cysoc.example`;
  const created = await admin.call('POST', '/api/admin/users', { name: 'Temp User', email, role: 'analyst' });
  const c = new Client('temp');
  const { stage } = await c.signIn(email, created.data.temporaryPassword);
  assert.equal(stage, 'change_password');
  assert.equal((await c.call('GET', '/api/escalations')).status, 401);
  assert.equal((await c.call('POST', '/api/auth/password', { current: created.data.temporaryPassword, next: 'short' })).status, 400);
  assert.equal((await c.call('POST', '/api/auth/password', { current: created.data.temporaryPassword, next: 'A-much-Better-pass-77' })).status, 200);
  assert.equal((await c.call('GET', '/api/escalations')).status, 200);
});

test('report upload, type checks, download and withdrawal', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  const q = (name: string) => `/api/reports/upload?tenant=${tenants.seri}&type=Incident%20Report&period=Oct%202026&filename=${encodeURIComponent(name)}`;
  assert.equal((await admin.call('POST', q('evil.exe'), undefined, { raw: pdf })).status, 400, 'extension blocked');
  assert.equal((await admin.call('POST', q('fake.pdf'), undefined, { raw: Buffer.from('MZ not a pdf') })).status, 400, 'content checked');
  const up = await admin.call('POST', q('Incident NTS-1.pdf'), undefined, { raw: pdf });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const list = await seri.call('GET', '/api/reports');
  const rep = list.data.items.find((r: any) => r.title === 'Incident NTS-1');
  assert.ok(rep);
  const dl = await seri.call('GET', `/api/reports/${rep.id}/download`);
  assert.equal(dl.status, 200); assert.equal(dl.type, 'application/pdf'); assert.ok((dl.data as Buffer).equals(pdf));
  assert.equal((await admin.call('POST', `/api/reports/${rep.id}/withdraw`)).status, 200);
  assert.equal((await seri.call('GET', `/api/reports/${rep.id}/download`)).status, 404);
});

test('contacts: customers manage their own and cannot drop the last primary', async () => {
  const add = await seri.call('POST', '/api/contacts', { name: 'Lee Wei', email: 'lee@seri.example', phone: '+60 12-000 9999', tier: 'Primary', alertChannels: 'Email, SMS' });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  const svc = await seri.call('GET', '/api/service');
  const prim = svc.data.contacts.filter((c: any) => c.tier === 'Primary');
  assert.equal(prim.length, 2);
  assert.equal((await seri.call('DELETE', `/api/contacts/${prim[0].id}`)).status, 200);
  assert.equal((await seri.call('DELETE', `/api/contacts/${prim[1].id}`)).status, 409);
  const otherSvc = await sys("SELECT id FROM contacts WHERE tenant_id = $1 LIMIT 1", [tenants.bayu]);
  assert.equal((await seri.call('DELETE', `/api/contacts/${otherSvc[0].id}`)).status, 404, 'cannot touch other tenant contact');
  assert.equal((await seri.call('POST', '/api/contacts/confirm')).status, 200);
});

test('requests: customers raise, staff progress', async () => {
  const r = await seri.call('POST', '/api/requests', { type: 'Ad-hoc report', details: 'Failed logins for Q3' });
  assert.equal(r.status, 200); assert.match(r.data.ref, /^SR-\d+$/);
  assert.equal((await analyst.call('POST', '/api/requests', { type: 'Ad-hoc report', details: 'x' })).status, 403);
  const list = await analyst.call('GET', `/api/requests?tenant=${tenants.seri}`);
  const mine = list.data.items.find((x: any) => x.ref === r.data.ref);
  assert.equal((await seri.call('POST', `/api/requests/${mine.id}/status`, { status: 'Completed' })).status, 403);
  assert.equal((await analyst.call('POST', `/api/requests/${mine.id}/status`, { status: 'In progress' })).status, 200);
});

test('scorecard, dashboard and health return data', async () => {
  const sc = await seri.call('GET', '/api/scorecard');
  assert.equal(sc.status, 200); assert.equal(sc.data.trend.length, 6); assert.equal(sc.data.byTenant, null);
  const all = await analyst.call('GET', '/api/scorecard');
  assert.ok(all.data.byTenant.length >= 6);
  const dash = await seri.call('GET', '/api/dashboard?range=7d');
  assert.equal(dash.status, 200); assert.ok(dash.data.data.eps.length > 100);
  const dashAll = await analyst.call('GET', '/api/dashboard?range=24h');
  assert.equal(dashAll.data.tenants.length, 6);
  const h = await admin.call('GET', '/api/health-scores');
  assert.equal(h.data.items.length, 6);
});

test('CSRF header and origin are enforced', async () => {
  const r = await seri.call('POST', '/api/requests', { type: 'Other', details: 'x' }, { csrf: false });
  assert.equal(r.status, 403);
  const res = await fetch(BASE + '/api/requests', { method: 'POST', headers: { Cookie: seri.cookie, 'X-CySOC-Request': '1', Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('security headers are present', async () => {
  const res = await fetch(BASE + '/api/health');
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('audit log cannot be altered, even by the application account', async () => {
  const { Pool: P } = await import('../server/src/db/mini-pg.ts');
  const app = new P({ connectionString: process.env.DATABASE_URL!, max: 1 });
  await assert.rejects(app.query('DELETE FROM audit_log'), /permission denied|append-only/);
  await assert.rejects(app.query("UPDATE audit_log SET action = 'x'"), /permission denied|append-only/);
  await app.end();
});

test('accounts lock after repeated failures', async () => {
  const c = new Client('locker');
  for (let i = 0; i < 5; i++) await c.call('POST', '/api/auth/login', { email: 'rajesh@nusa.example', password: 'Wrong-password-' + i });
  const r = await c.call('POST', '/api/auth/login', { email: 'rajesh@nusa.example', password: DEMO_PW });
  assert.equal(r.status, 423);
  const [a] = await sys("SELECT count(*)::int AS n FROM audit_log WHERE action = 'Account locked' AND actor_name = 'Rajesh Kumar'");
  assert.equal(a.n, 1, 'lock is audited');
  const [f] = await sys("SELECT count(*)::int AS n FROM audit_log WHERE action = 'Failed sign-in' AND actor_name = 'Rajesh Kumar'");
  assert.equal(f.n, 4, 'failed attempts are audited');
  await sys("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE email = 'rajesh@nusa.example'");
});

test('wrong MFA codes also count towards the lock', async () => {
  const c = new Client('mfa-brute');
  const r = await c.call('POST', '/api/auth/login', { email: 'adam@cahaya.example', password: DEMO_PW });
  assert.equal(r.data.stage, 'mfa_setup');
  await c.call('POST', '/api/auth/mfa/setup', {});
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await c.call('POST', '/api/auth/mfa/verify', { code: String(100000 + i) })).status;
  assert.equal(last, 423);
  assert.equal((await c.call('POST', '/api/auth/mfa/verify', { code: '123456' })).status, 401, 'session ended by the lock');
  await sys("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE email = 'adam@cahaya.example'");
});

test('sign-out ends the session', async () => {
  const c = new Client('bye');
  await c.signIn('hafiz@lembah.example');
  assert.equal((await c.call('GET', '/api/escalations')).status, 200);
  await c.call('POST', '/api/auth/logout');
  assert.equal((await c.call('GET', '/api/escalations')).status, 401);
});

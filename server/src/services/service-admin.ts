// Service entitlements, escalation contacts, audit log, session metadata and administration.
import { route, badRequest, notFound, forbidden, HttpError } from '../http/core.js';
import { withCtx, asSystem } from '../db/index.js';
import { audit } from './audit.js';
import { need, scope, str, oneOf, queue, slaTargets, UUID, SEVERITIES } from './common.js';
import { can, PERMISSIONS, PERMISSION_TABLE, type Permission } from '../auth/permissions.js';
import { encrypt, hashPassword, tempPassword } from '../auth/crypto.js';
import { REQUEST_TYPES, REPORT_TYPES } from './requests-reports.js';
import { testNts, DEFAULT_NTS_SETTINGS } from '../integrations/nts.js';
import { testGrafana } from '../integrations/grafana.js';
import { testNotify } from '../integrations/notify.js';
import { config } from '../config.js';
import { CATEGORIES, CATEGORY_CODES } from './categories.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Session metadata for the front end ----------
route('GET', '/api/meta', async (req) => withCtx(req.ctx, async tx => ({
  user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, tenantId: req.user.tenantId, tenantName: req.user.tenantName },
  permissions: (Object.keys(PERMISSIONS) as Permission[]).filter(p => can(req.user.role, p)),
  tenants: await tx.query('SELECT id, code, name, service, siem, categories FROM tenants WHERE active ORDER BY name'),
  categories: CATEGORIES,
  sla: await slaTargets(tx), requestTypes: REQUEST_TYPES, reportTypes: REPORT_TYPES, integrationMode: config.integrationMode, mfaRequired: config.mfaRequired,
})));

// ---------- Service and contacts ----------
route('GET', '/api/service', async (req) => {
  const t = scope(req);
  return withCtx(req.ctx, async tx => {
    if (!t) {
      return { overview: await tx.query(`
        SELECT t.id, t.name, t.services, t.categories, t.licensed_eps, t.licensed_assets, t.renewal_date, t.contacts_confirmed_at,
               (SELECT count(*)::int FROM log_source_contracts c WHERE c.tenant_id = t.id) AS contracted,
               (SELECT count(*)::int FROM log_source_contracts c WHERE c.tenant_id = t.id AND c.onboarded) AS onboarded
        FROM tenants t WHERE t.active ORDER BY t.name`) };
    }
    const tenant = await tx.one('SELECT id, code, name, service, siem, licensed_eps, licensed_assets, services, categories, monitoring_hours, renewal_date, contacts_confirmed_at FROM tenants WHERE id = $1', [t]);
    if (!tenant) throw notFound();
    return {
      tenant,
      logSources: await tx.query('SELECT id, name, onboarded, note FROM log_source_contracts WHERE tenant_id = $1 ORDER BY onboarded, name', [t]),
      contacts: await tx.query(`SELECT id, name, role, tier, email, phone, alert_channels FROM contacts WHERE tenant_id = $1 ORDER BY array_position(ARRAY['Primary','Secondary','After-hours'], tier), name`, [t]),
      sla: await slaTargets(tx),
    };
  });
});

const TIERS = ['Primary', 'Secondary', 'After-hours'] as const;
const CHANNELS = ['Email, SMS', 'Email', 'SMS, Phone call'] as const;

route('POST', '/api/contacts', async (req) => {
  need(req, 'editContacts');
  const b = await req.body();
  const tenantId = req.user.role === 'customer' ? req.user.tenantId : b.tenantId;
  if (!UUID.test(String(tenantId))) throw badRequest('Choose a tenant.');
  const name = str(b.name, 'a name', 120), email = str(b.email, 'an email address', 200), phone = str(b.phone, 'a mobile number', 40);
  if (!EMAIL.test(email)) throw badRequest('Enter a valid email address.');
  if (!/^[+\d][\d\s-]{6,}$/.test(phone)) throw badRequest('Enter a mobile number with digits only, for example +60 12-345 6789.');
  const tier = oneOf(b.tier, TIERS, 'escalation tier'), channels = oneOf(b.alertChannels, CHANNELS, 'alert channel');
  return withCtx(req.ctx, async tx => {
    await tx.query('INSERT INTO contacts (tenant_id, name, role, tier, email, phone, alert_channels) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [tenantId, name, str(b.role, 'a role', 120, false) || 'Contact', tier, email, phone, channels]);
    await audit(tx, req.actor, 'Added contact', `${name} (${tier})`, tenantId);
    return { ok: true };
  });
});

route('DELETE', '/api/contacts/:id', async (req) => {
  need(req, 'editContacts');
  if (!UUID.test(req.params.id)) throw notFound();
  return withCtx(req.ctx, async tx => {
    const c = await tx.one('SELECT id, tenant_id, name, tier FROM contacts WHERE id = $1', [req.params.id]);
    if (!c) throw notFound();
    if (c.tier === 'Primary') {
      const n = await tx.one("SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND tier = 'Primary'", [c.tenant_id]);
      if (n.n <= 1) throw new HttpError(409, 'Keep at least one primary contact. Add a new primary before removing this one.', 'last_primary');
    }
    await tx.query('DELETE FROM contacts WHERE id = $1', [c.id]);
    await audit(tx, req.actor, 'Removed contact', c.name, c.tenant_id);
    return { ok: true };
  });
});

route('POST', '/api/contacts/confirm', async (req) => {
  need(req, 'confirmContacts');
  // Customers cannot write to tenants under row-level security; this single field is set by the server.
  await asSystem(async tx => {
    await tx.query('UPDATE tenants SET contacts_confirmed_at = now() WHERE id = $1', [req.user.tenantId]);
    await audit(tx, req.actor, 'Confirmed contacts', 'Escalation contact list', req.user.tenantId);
  });
  return { ok: true };
});

route('POST', '/api/contacts/remind', async (req) => {
  need(req, 'remindContacts');
  const { tenantId } = await req.body();
  if (!UUID.test(String(tenantId))) throw badRequest('Choose a tenant.');
  return withCtx(req.ctx, async tx => {
    const to = (await tx.query("SELECT email FROM contacts WHERE tenant_id = $1 AND tier = 'Primary'", [tenantId])).map((c: any) => c.email);
    if (!to.length) throw badRequest('This tenant has no primary contact to remind.');
    await queue(tx, 'email', { to, subject: 'Please confirm your CySOC escalation contacts', text: `Please sign in to the CySOC portal, open My service, and confirm that your escalation contacts are current. Escalations reach only the people on this list.\n\n${config.publicUrl}\n\nCySOC 24x7 Security Operations Centre` });
    await audit(tx, req.actor, 'Sent contact review reminder', to.join(', '), tenantId);
    return { ok: true, sentTo: to.length };
  });
});

// ---------- Audit log ----------
const GROUPS: Record<string, string> = {
  signin: "(action ILIKE '%sign%' OR action ILIKE '%MFA%' OR action ILIKE '%password%' OR action = 'Account locked')",
  esc: "(action ILIKE '%escalat%' OR action ILIKE '%acknowledg%' OR action ILIKE '%remediation%' OR action ILIKE '%closure%' OR action ILIKE '%message%' OR action = 'Sent reminder')",
  rep: "(action ILIKE '%report%')",
};
route('GET', '/api/audit', async (req) => {
  need(req, 'viewAudit');
  const t = scope(req);
  const group = req.query.get('group') || 'all';
  let where = 'TRUE';
  if (group === 'chg') where = `NOT ${GROUPS.signin} AND NOT ${GROUPS.esc} AND NOT ${GROUPS.rep}`;
  else if (GROUPS[group]) where = GROUPS[group];
  return withCtx(req.ctx, async tx => ({
    items: await tx.query(
      `SELECT a.id, a.at, a.actor_name, a.side, a.tenant_id, t.name AS tenant_name, a.action, a.details, a.ip
       FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
       WHERE ($1::uuid IS NULL OR a.tenant_id = $1) AND ${where} ORDER BY a.at DESC LIMIT 300`, [t]),
  }));
});

// ---------- Administration: integrations ----------
route('GET', '/api/admin/integrations', async (req) => {
  need(req, 'viewIntegrations');
  const full = can(req.user.role, 'editIntegrations');
  return withCtx(req.ctx, async tx => ({
    canEdit: full,
    items: (await tx.query(`SELECT i.*, t.name AS tenant_name FROM integrations i LEFT JOIN tenants t ON t.id = i.tenant_id
                            ORDER BY CASE i.kind WHEN 'ticketing' THEN 0 WHEN 'dashboard' THEN 1 ELSE 2 END, i.name`)).map((i: any) => ({
      id: i.id, kind: i.kind, name: i.name, tenantName: i.tenant_name, endpoint: i.endpoint, authLabel: i.auth_label,
      hasSecret: !!i.secret_enc, secretLast4: full ? i.secret_last4 : null, settings: full ? i.settings : undefined,
      enabled: i.enabled, status: i.status, statusNote: i.status_note, lastSuccessAt: i.last_success_at,
    })),
    permissions: PERMISSION_TABLE,
  }));
});

route('PUT', '/api/admin/integrations/:id', async (req) => {
  need(req, 'editIntegrations');
  const b = await req.body();
  return withCtx(req.ctx, async tx => {
    const i = await tx.one('SELECT id, name, tenant_id, endpoint, settings, enabled FROM integrations WHERE id = $1', [req.params.id]);
    if (!i) throw notFound();
    const changed: string[] = [];
    if (b.endpoint !== undefined) {
      const ep = str(b.endpoint, 'an endpoint URL', 500);
      // https everywhere; plain http only for a container on the same Docker network (a name without dots, e.g. http://grafana:3000).
      const internalHttp = /^http:\/\/[a-z0-9][a-z0-9_-]*(:\d{1,5})?(\/\S*)?$/i.test(ep);
      if (!/^(https:\/\/|smtp:\/\/)\S+$/.test(ep) && !internalHttp) throw badRequest('Enter an https:// address (smtp:// for email). Plain http:// is allowed only for a container on the same server, such as http://grafana:3000.');
      if (i.id === 'nts' && /\/api\/v2\/?$/.test(ep)) throw badRequest('Enter the Freshservice address without /api/v2, for example https://yourcompany.freshservice.com');
      if (ep !== i.endpoint) { await tx.query('UPDATE integrations SET endpoint = $2 WHERE id = $1', [i.id, ep]); changed.push('endpoint'); }
    }
    if (typeof b.secret === 'string' && b.secret.length) {
      if (b.secret.length > 2000) throw badRequest('That secret is too long.');
      await tx.query('UPDATE integrations SET secret_enc = $2, secret_last4 = $3 WHERE id = $1', [i.id, encrypt(b.secret), b.secret.slice(-4)]);
      changed.push('secret');
    }
    if (b.settings !== undefined) {
      if (typeof b.settings !== 'object' || Array.isArray(b.settings) || JSON.stringify(b.settings).length > 20000) throw badRequest('Settings must be a JSON object under 20 KB.');
      const canon = (o: any): string => JSON.stringify(o, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);
      if (canon(b.settings) !== canon(i.settings)) {
        await tx.query('UPDATE integrations SET settings = $2 WHERE id = $1', [i.id, JSON.stringify(b.settings)]);
        changed.push('settings');
      }
    }
    if (typeof b.enabled === 'boolean' && b.enabled !== i.enabled) { await tx.query('UPDATE integrations SET enabled = $2 WHERE id = $1', [i.id, b.enabled]); changed.push(b.enabled ? 'enabled' : 'disabled'); }
    if (!changed.length) return { ok: true, changed };
    await tx.query("UPDATE integrations SET updated_at = now(), status = CASE WHEN $2 THEN 'unknown' ELSE status END WHERE id = $1", [i.id, changed.some(c => c !== 'disabled' && c !== 'enabled')]);
    await audit(tx, req.actor, 'Changed API configuration', `${i.name}: ${changed.join(', ')}`, i.tenant_id);
    return { ok: true, changed };
  });
});

route('POST', '/api/admin/integrations/:id/test', async (req) => {
  need(req, 'editIntegrations');
  const b = await req.body();
  const id = req.params.id;
  const integ = await withCtx(req.ctx, tx => tx.one('SELECT id, kind, name, tenant_id, enabled FROM integrations WHERE id = $1', [id]));
  if (!integ) throw notFound();
  if (!integ.enabled) throw badRequest(`${integ.name} is disabled. Enable it before testing.`);
  let message: string;
  try {
    if (config.integrationMode === 'demo') message = 'Demo mode: no external call was made.';
    else if (id === 'nts') message = await testNts();
    else if (id.startsWith('grafana:')) message = await testGrafana(id);
    else if (id === 'smtp' || id === 'sms') message = await testNotify(id, str(b.to, id === 'smtp' ? 'an email address to send the test to' : 'a mobile number to send the test to', 200));
    else message = 'No test is available for this connection.';
  } catch (e: any) {
    await withCtx(req.ctx, tx => audit(tx, req.actor, 'Tested API connection', `${integ.name}: failed`, integ.tenant_id));
    throw new HttpError(502, `Test failed: ${e.message}`, 'test_failed');
  }
  await withCtx(req.ctx, tx => audit(tx, req.actor, 'Tested API connection', `${integ.name}: passed`, integ.tenant_id));
  return { message };
});

// ---------- Administration: users ----------
route('GET', '/api/admin/users', async (req) => {
  need(req, 'manageUsers');
  return withCtx(req.ctx, async tx => ({
    items: await tx.query(`SELECT u.id, u.name, u.email, u.role, u.tenant_id, t.name AS tenant_name, u.mfa_enabled, u.active, u.last_login_at,
                                  (u.locked_until > now()) AS locked, u.must_change_password
                           FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id ORDER BY (u.role = 'customer'), t.name NULLS FIRST, u.name`),
  }));
});

route('POST', '/api/admin/users', async (req) => {
  need(req, 'manageUsers');
  const b = await req.body();
  const name = str(b.name, 'a name', 120), email = str(b.email, 'an email address', 200).toLowerCase();
  if (!EMAIL.test(email)) throw badRequest('Enter a valid email address.');
  const role = oneOf(b.role, ['admin', 'analyst', 'customer'] as const, 'account type');
  const tenantId = role === 'customer' ? b.tenantId : null;
  if (role === 'customer' && !UUID.test(String(tenantId))) throw badRequest('Choose the customer this account belongs to.');
  const pw = tempPassword();
  return withCtx(req.ctx, async tx => {
    if (await tx.one('SELECT 1 FROM users WHERE lower(email) = $1', [email])) throw new HttpError(409, 'An account with this email already exists.', 'exists');
    await tx.query('INSERT INTO users (name, email, role, tenant_id, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,true)', [name, email, role, tenantId, hashPassword(pw)]);
    await audit(tx, req.actor, 'Created account', `${name} <${email}> as ${role}`, tenantId);
    return { temporaryPassword: pw };
  });
});

route('PATCH', '/api/admin/users/:id', async (req) => {
  need(req, 'manageUsers');
  if (!UUID.test(req.params.id)) throw notFound();
  if (req.params.id === req.user.id) throw forbidden('You cannot change your own account type or status.');
  const b = await req.body();
  return withCtx(req.ctx, async tx => {
    const u = await tx.one('SELECT id, name, role, tenant_id, active FROM users WHERE id = $1', [req.params.id]);
    if (!u) throw notFound();
    const changes: string[] = [];
    if (b.role !== undefined && b.role !== u.role) {
      if (u.role === 'customer' || b.role === 'customer') throw badRequest('Customer accounts cannot become staff accounts. Create a new account instead.');
      oneOf(b.role, ['admin', 'analyst'] as const, 'account type');
      await tx.query('UPDATE users SET role = $2 WHERE id = $1', [u.id, b.role]); changes.push(`type ${u.role} → ${b.role}`);
    }
    if (typeof b.active === 'boolean' && b.active !== u.active) {
      await tx.query('UPDATE users SET active = $2 WHERE id = $1', [u.id, b.active]); changes.push(b.active ? 'enabled' : 'disabled');
      if (!b.active) await asSystem(t2 => t2.query('DELETE FROM sessions WHERE user_id = $1', [u.id]));
    }
    if (changes.length) await audit(tx, req.actor, 'Changed account', `${u.name}: ${changes.join(', ')}`, u.tenant_id);
    return { ok: true };
  });
});

route('POST', '/api/admin/users/:id/reset-password', async (req) => {
  need(req, 'manageUsers');
  if (!UUID.test(req.params.id)) throw notFound();
  const pw = tempPassword();
  return withCtx(req.ctx, async tx => {
    const u = await tx.one('UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1 RETURNING name, tenant_id', [req.params.id, hashPassword(pw)]);
    if (!u) throw notFound();
    await asSystem(t2 => t2.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]));
    await audit(tx, req.actor, 'Reset password', u.name, u.tenant_id);
    return { temporaryPassword: pw };
  });
});

route('POST', '/api/admin/users/:id/reset-mfa', async (req) => {
  need(req, 'manageUsers');
  if (!UUID.test(req.params.id)) throw notFound();
  return withCtx(req.ctx, async tx => {
    const u = await tx.one('UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL WHERE id = $1 RETURNING name, tenant_id', [req.params.id]);
    if (!u) throw notFound();
    await asSystem(t2 => t2.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]));
    await audit(tx, req.actor, 'Reset MFA', `${u.name} must enrol again at next sign-in`, u.tenant_id);
    return { ok: true };
  });
});

// ---------- Administration: tenants and SLA ----------
route('GET', '/api/admin/tenants', async (req) => {
  need(req, 'manageTenants');
  return withCtx(req.ctx, async tx => ({
    items: await tx.query(`SELECT t.*, coalesce((SELECT json_agg(json_build_object('name', c.name, 'onboarded', c.onboarded) ORDER BY c.name) FROM log_source_contracts c WHERE c.tenant_id = t.id), '[]') AS log_sources
                           FROM tenants t ORDER BY t.name`),
  }));
});

async function saveTenant(req: any, id: string | null) {
  need(req, 'manageTenants');
  const b = await req.body();
  const code = str(b.code, 'a tenant code', 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(code)) throw badRequest('Tenant codes use lowercase letters, numbers, hyphens and underscores, and must match the customer value in NTS.');
  const name = str(b.name, 'a name', 120), service = str(b.service, 'a service', 80);
  const siem = oneOf(b.siem, ['QRadar', 'Antarex'] as const, 'SIEM');
  const intOrNull = (v: any, n: string) => { if (v === null || v === '' || v === undefined) return null; const x = Number(v); if (!Number.isInteger(x) || x < 0) throw badRequest(`${n} must be a whole number.`); return x; };
  const eps = intOrNull(b.licensedEps, 'Licensed EPS'), assets = intOrNull(b.licensedAssets, 'Licensed assets');
  const services: string[] = Array.isArray(b.services) ? b.services.map((s: unknown) => str(s, 'a service name', 120)).slice(0, 20) : [];
  const categories: string[] = Array.isArray(b.categories) ? [...new Set<string>(b.categories.map((c: unknown) => String(c)))] : [];
  const badCat = categories.find(c => !CATEGORY_CODES.includes(c));
  if (badCat) throw badRequest(`Unknown customer category ${badCat}.`);
  if (!categories.length) throw badRequest('Choose at least one customer category.');
  const renewal = b.renewalDate ? String(b.renewalDate) : null;
  if (renewal && !/^\d{4}-\d{2}-\d{2}$/.test(renewal)) throw badRequest('Use YYYY-MM-DD for the renewal date.');
  const sources: { name: string; onboarded: boolean }[] = Array.isArray(b.logSources) ? b.logSources.slice(0, 200).map((s: any) => ({ name: str(s.name, 'a log source name', 160), onboarded: !!s.onboarded })) : [];
  return withCtx(req.ctx, async tx => {
    let tid = id;
    if (id) {
      const r = await tx.one(`UPDATE tenants SET code=$2, name=$3, service=$4, siem=$5, licensed_eps=$6, licensed_assets=$7, services=$8, renewal_date=$9, monitoring_hours=$10, active=$11, categories=$12 WHERE id=$1 RETURNING id`,
        [id, code, name, service, siem, eps, assets, services, renewal, str(b.monitoringHours ?? '24x7', 'monitoring hours', 60), b.active !== false, categories]);
      if (!r) throw notFound();
    } else {
      if (await tx.one('SELECT 1 FROM tenants WHERE code = $1', [code])) throw new HttpError(409, 'A tenant with this code already exists.', 'exists');
      const [r] = await tx.query(`INSERT INTO tenants (code, name, service, siem, licensed_eps, licensed_assets, services, renewal_date, monitoring_hours, categories) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [code, name, service, siem, eps, assets, services, renewal, str(b.monitoringHours ?? '24x7', 'monitoring hours', 60), categories]);
      tid = r.id;
      await tx.query(`INSERT INTO integrations (id, kind, name, tenant_id, auth_label, settings) VALUES ($1, 'dashboard', $2, $3, 'Service account token (Viewer)', '{"panels":{}}') ON CONFLICT (id) DO NOTHING`, [`grafana:${code}`, `Grafana · ${name}`, tid]);
    }
    await tx.query('DELETE FROM log_source_contracts WHERE tenant_id = $1', [tid]);
    for (const s of sources) await tx.query('INSERT INTO log_source_contracts (tenant_id, name, onboarded) VALUES ($1,$2,$3)', [tid, s.name, s.onboarded]);
    await audit(tx, req.actor, id ? 'Updated tenant' : 'Created tenant', `${name} (${code})`, tid);
    return { id: tid };
  });
}
route('POST', '/api/admin/tenants', (req) => saveTenant(req, null));
route('PUT', '/api/admin/tenants/:id', (req) => { if (!UUID.test(req.params.id)) throw notFound(); return saveTenant(req, req.params.id); });

route('PUT', '/api/admin/sla', async (req) => {
  need(req, 'editSla');
  const b = await req.body();
  if (!Array.isArray(b.targets)) throw badRequest('Send the four severity targets.');
  return withCtx(req.ctx, async tx => {
    for (const t of b.targets) {
      const sev = oneOf(t.severity, SEVERITIES, 'severity');
      const m = Number(t.escalateMinutes), h = Number(t.ackHours);
      if (!(m > 0 && m <= 10080) || !(h > 0 && h <= 720)) throw badRequest(`Check the ${sev} targets: minutes 1–10080, hours up to 720.`);
      await tx.query('UPDATE sla_targets SET escalate_minutes = $2, ack_hours = $3 WHERE severity = $1', [sev, Math.round(m), h]);
    }
    await audit(tx, req.actor, 'Changed SLA targets', b.targets.map((t: any) => `${t.severity} ${t.escalateMinutes} min / ${t.ackHours} h`).join('; '), null);
    return { ok: true };
  });
});

export const NTS_DEFAULTS = DEFAULT_NTS_SETTINGS;

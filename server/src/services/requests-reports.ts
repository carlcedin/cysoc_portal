// Service requests (customers raise, CySOC works them in NTS) and shared reports.
import { route, badRequest, notFound, HttpError } from '../http/core.js';
import { withCtx } from '../db/index.js';
import { audit } from './audit.js';
import { need, scope, str, oneOf, queue, UUID } from './common.js';
import { saveUpload, openDownload, ALLOWED_EXT } from '../integrations/storage.js';

// Request types and target working days.
export const REQUEST_TYPES: Record<string, number> = {
  'Allowlist or blocklist change': 2, 'New log source onboarding': 10, 'VA scan scheduling': 5,
  'Rule tuning or false positive': 3, 'Ad-hoc report': 3, 'Other': 5,
};
export const REPORT_TYPES = ['Monthly SOC Report', 'Quarterly Executive Summary', 'Vulnerability Assessment Report', 'Incident Report', 'Other'];

const addWorkingDays = (d: Date, n: number) => { const x = new Date(d); while (n > 0) { x.setDate(x.getDate() + 1); if (x.getDay() !== 0 && x.getDay() !== 6) n--; } return x; };

route('GET', '/api/requests', async (req) => {
  const t = scope(req);
  return withCtx(req.ctx, async tx => ({
    types: REQUEST_TYPES,
    items: await tx.query(
      `SELECT r.id, r.ref, r.nts_ticket_id, r.tenant_id, t.name AS tenant_name, r.type, r.details, r.raised_by_name, r.status, r.target_date, r.created_at, r.updated_at
       FROM service_requests r JOIN tenants t ON t.id = r.tenant_id
       WHERE ($1::uuid IS NULL OR r.tenant_id = $1) AND (r.status <> 'Completed' OR r.updated_at > now() - interval '90 days')
       ORDER BY (r.status = 'Completed'), r.created_at DESC LIMIT 500`, [t]),
  }));
});

route('POST', '/api/requests', async (req) => {
  need(req, 'raiseRequest');
  const b = await req.body();
  const type = oneOf(b.type, Object.keys(REQUEST_TYPES), 'request type');
  const details = str(b.details, 'the request details', 4000);
  return withCtx(req.ctx, async tx => {
    const seq = await tx.one<{ n: string }>("SELECT nextval('service_request_seq')::text AS n");
    const target = addWorkingDays(new Date(), REQUEST_TYPES[type]);
    const [r] = await tx.query(
      `INSERT INTO service_requests (tenant_id, ref, type, details, raised_by_user_id, raised_by_name, status, target_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'Submitted', $7) RETURNING id, ref`,
      [req.user.tenantId, `SR-${seq!.n}`, type, details, req.user.id, req.user.name, target.toISOString().slice(0, 10)]);
    const tenant = await tx.one('SELECT name, code FROM tenants WHERE id = $1', [req.user.tenantId]);
    await queue(tx, 'nts.request', { requestId: r.id, subject: `[${tenant.code}] ${r.ref} ${type}`, description: `${details}\n\nRaised in CySOC portal by ${req.user.name} (${req.user.email}) for ${tenant.name}.`, email: req.user.email });
    await audit(tx, req.actor, 'Raised request', `${r.ref} · ${type}`, req.user.tenantId);
    return { ref: r.ref };
  });
});

route('POST', '/api/requests/:id/status', async (req) => {
  need(req, 'updateRequest');
  const { status } = await req.body();
  oneOf(status, ['In progress', 'Completed'] as const, 'status');
  if (!UUID.test(req.params.id)) throw notFound();
  return withCtx(req.ctx, async tx => {
    const r = await tx.one('SELECT id, ref, tenant_id, status, nts_ticket_id FROM service_requests WHERE id = $1', [req.params.id]);
    if (!r) throw notFound();
    const allowed = { Submitted: ['In progress', 'Completed'], 'In progress': ['Completed'], Completed: [] as string[] }[r.status as 'Submitted'];
    if (!allowed.includes(status)) throw new HttpError(409, 'This request has already moved on. Refresh to see its status.', 'conflict');
    await tx.query('UPDATE service_requests SET status = $2, updated_at = now() WHERE id = $1', [r.id, status]);
    if (r.nts_ticket_id) await queue(tx, 'nts.note', { ticketId: r.nts_ticket_id, body: `Portal status set to ${status} by ${req.user.name}.` });
    await audit(tx, req.actor, 'Updated request', `${r.ref} · ${status}`, r.tenant_id);
    return { ok: true };
  });
});

// ---------- Reports ----------
route('GET', '/api/reports', async (req) => {
  const t = scope(req);
  return withCtx(req.ctx, async tx => ({
    types: REPORT_TYPES, allowedExtensions: ALLOWED_EXT,
    items: await tx.query(
      `SELECT r.id, r.tenant_id, t.name AS tenant_name, r.title, r.type, r.period, r.filename, r.size_bytes::float AS size_bytes, r.uploaded_at, r.uploaded_by_name,
              (SELECT count(*)::int FROM report_downloads d WHERE d.report_id = r.id AND d.side = 'Customer') AS customer_downloads,
              (SELECT max(at) FROM report_downloads d WHERE d.report_id = r.id AND d.side = 'Customer') AS last_customer_download,
              (SELECT max(at) FROM report_downloads d WHERE d.report_id = r.id AND d.user_id = $2) AS my_last_download
       FROM reports r JOIN tenants t ON t.id = r.tenant_id
       WHERE r.withdrawn_at IS NULL AND ($1::uuid IS NULL OR r.tenant_id = $1)
       ORDER BY r.uploaded_at DESC LIMIT 500`, [t, req.user.id]),
  }));
});

// Raw file body; metadata in the query string. Keeps uploads streaming with no multipart parser.
route('POST', '/api/reports/upload', async (req) => {
  need(req, 'uploadReports');
  const q = req.query;
  const tenantId = q.get('tenant') || '';
  if (!UUID.test(tenantId)) throw badRequest('Choose a customer.');
  const type = oneOf(q.get('type'), REPORT_TYPES, 'report type');
  const period = str(q.get('period'), 'the period', 40);
  const filename = str(q.get('filename'), 'a file', 200).replace(/[^\w.\- ()]/g, '_');
  const notify = q.get('notify') === '1';
  const tenant = await withCtx(req.ctx, tx => tx.one('SELECT id, name FROM tenants WHERE id = $1', [tenantId]));
  if (!tenant) throw badRequest('Unknown customer.');
  const file = await saveUpload(req.raw, tenantId, filename);
  return withCtx(req.ctx, async tx => {
    const title = filename.replace(/\.[^.]+$/, '');
    await tx.query(
      `INSERT INTO reports (tenant_id, title, type, period, filename, mime, size_bytes, sha256, storage_key, uploaded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, title, type, period, filename, file.mime, file.size, file.sha256, file.storageKey, req.user.name]);
    if (notify) {
      const to = (await tx.query("SELECT email FROM contacts WHERE tenant_id = $1 AND tier IN ('Primary','Secondary')", [tenantId])).map((c: any) => c.email);
      if (to.length) await queue(tx, 'email', { to, subject: `New CySOC report: ${title}`, text: `A new ${type.toLowerCase()} for ${period} is ready in the CySOC portal under Reports.\n\nCySOC 24x7 Security Operations Centre` });
    }
    await audit(tx, req.actor, 'Uploaded report', `${filename} (sha256 ${file.sha256.slice(0, 12)}…)`, tenantId);
    return { ok: true, title };
  });
});

route('GET', '/api/reports/:id/download', async (req) => {
  need(req, 'downloadReports');
  if (!UUID.test(req.params.id)) throw notFound();
  const r = await withCtx(req.ctx, async tx => {
    const r = await tx.one('SELECT id, tenant_id, title, filename, mime, storage_key FROM reports WHERE id = $1 AND withdrawn_at IS NULL', [req.params.id]);
    if (!r) throw notFound('This report is not available.');
    await tx.query('INSERT INTO report_downloads (report_id, tenant_id, user_id, side) VALUES ($1,$2,$3,$4)', [r.id, r.tenant_id, req.user.id, req.actor.side]);
    await audit(tx, req.actor, 'Downloaded report', r.title, r.tenant_id);
    return r;
  });
  const stream = openDownload(r.storage_key);
  req.res.setHeader('Content-Type', r.mime);
  req.res.setHeader('Content-Disposition', `attachment; filename="${r.filename.replace(/"/g, '')}"`);
  req.res.setHeader('Cache-Control', 'no-store');
  stream.pipe(req.res);
  await new Promise(res => stream.on('close', res));
});

route('POST', '/api/reports/:id/withdraw', async (req) => {
  need(req, 'withdrawReports');
  if (!UUID.test(req.params.id)) throw notFound();
  return withCtx(req.ctx, async tx => {
    const r = await tx.one('UPDATE reports SET withdrawn_at = now() WHERE id = $1 AND withdrawn_at IS NULL RETURNING tenant_id, title', [req.params.id]);
    if (!r) throw notFound();
    await audit(tx, req.actor, 'Withdrew report', r.title, r.tenant_id);
    return { ok: true };
  });
});


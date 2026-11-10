// Security dashboard (Grafana), SLA scorecard (from escalation timestamps) and customer health.
import { route, badRequest } from '../http/core.js';
import { withCtx } from '../db/index.js';
import { need, scope } from './common.js';
import { tenantDashboard, combine, RANGES, type RangeKey } from '../integrations/grafana.js';
import { CATEGORIES, CATEGORY_CODES } from './categories.js';

route('GET', '/api/dashboard', async (req) => {
  const t = scope(req);
  const range = (req.query.get('range') || '7d') as RangeKey;
  if (!RANGES[range]) throw badRequest('Choose 24h, 7d or 30d.');
  const { tenants, escalations } = await withCtx(req.ctx, async tx => ({
    // Customers without a SIEM (for example DDoS-only) have no security dashboard.
    tenants: await tx.query("SELECT id, code, name, siem, licensed_eps, licensed_assets FROM tenants WHERE active AND siem <> 'None' AND ($1::uuid IS NULL OR id = $1) ORDER BY name", [t]),
    escalations: Number((await tx.one(`SELECT count(*)::int AS n FROM escalations WHERE escalated_at > now() - ($2 || ' hours')::interval AND ($1::uuid IS NULL OR tenant_id = $1)`, [t, String(RANGES[range].hours)]))?.n ?? 0),
  }));
  const per = await Promise.all(tenants.map(async (x: any) => ({ tenant: x, data: await tenantDashboard(x, range) })));
  if (t) {
    const one = per[0];
    if (!one) return { data: { range, eps: [], alerts: [], tactics: [], rules: [], sources: [], configured: { eps: false, alerts: false, tactics: false, rules: false, sources: false }, errors: [] }, licensedEps: null, escalations, tenants: null, noSiem: true };
    return { data: one.data, licensedEps: one.tenant.licensed_eps, escalations, tenants: null };
  }
  const rows = per.map(({ tenant, data }) => {
    const avg = data.eps.length ? data.eps.reduce((a, p) => a + p.v, 0) / data.eps.length : null;
    const peak = data.eps.length ? Math.max(...data.eps.map(p => p.v)) : null;
    return {
      id: tenant.id, name: tenant.name, siem: tenant.siem, licensedEps: tenant.licensed_eps, licensedAssets: tenant.licensed_assets, avgEps: avg, peakEps: peak,
      critHigh: data.alerts.reduce((a, p) => a + p.Critical + p.High, 0),
      sourcesDown: data.sources.filter(s => !s.lastSeen || Date.now() - s.lastSeen > 15 * 60_000).length,
      configured: data.configured.eps,
    };
  });
  return { data: combine(per.map(p => ({ name: p.tenant.name, data: p.data })), range), licensedEps: null, escalations, tenants: rows };
});

route('GET', '/api/scorecard', async (req) => {
  const t = scope(req);
  return withCtx(req.ctx, async tx => {
    const base = `
      WITH e AS (
        SELECT e.*, tn.name AS tenant_name, extract(epoch FROM e.escalated_at - e.detected_at) / 60 AS esc_min,
               s.escalate_minutes, s.ack_hours, s.sort
        FROM escalations e JOIN sla_targets s ON s.severity = e.severity JOIN tenants tn ON tn.id = e.tenant_id
        WHERE e.escalated_at IS NOT NULL AND ($1::uuid IS NULL OR e.tenant_id = $1))`;
    const window = `escalated_at > now() - interval '30 days'`;
    const summary = await tx.one(`${base}
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE esc_min <= escalate_minutes)::int AS within,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY esc_min) AS median_min,
             count(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acked,
             count(*) FILTER (WHERE acknowledged_at IS NOT NULL AND acknowledged_at - escalated_at <= ack_hours * interval '1 hour')::int AS acked_within,
             avg(extract(epoch FROM closed_at - escalated_at) / 3600) FILTER (WHERE closed_at IS NOT NULL) AS avg_close_h,
             count(*) FILTER (WHERE closed_at IS NOT NULL)::int AS closed
      FROM e WHERE ${window}`, [t]);
    const bySeverity = await tx.query(`
      SELECT s.severity, s.escalate_minutes, count(e.id)::int AS total,
             count(e.id) FILTER (WHERE extract(epoch FROM e.escalated_at - e.detected_at) / 60 <= s.escalate_minutes)::int AS within,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.escalated_at - e.detected_at) / 60) AS median_min
      FROM sla_targets s
      LEFT JOIN escalations e ON e.severity = s.severity AND e.escalated_at > now() - interval '30 days' AND ($1::uuid IS NULL OR e.tenant_id = $1)
      GROUP BY s.severity, s.escalate_minutes, s.sort ORDER BY s.sort`, [t]);
    const trend = await tx.query(`${base}
      , months AS (SELECT generate_series(date_trunc('month', now() AT TIME ZONE 'Asia/Kuala_Lumpur') - interval '5 months',
                                          date_trunc('month', now() AT TIME ZONE 'Asia/Kuala_Lumpur'), interval '1 month') AS m)
      SELECT to_char(m, 'Mon') AS label, count(e.id)::int AS total, count(e.id) FILTER (WHERE e.esc_min <= e.escalate_minutes)::int AS within
      FROM months LEFT JOIN e ON date_trunc('month', e.escalated_at AT TIME ZONE 'Asia/Kuala_Lumpur') = m
      GROUP BY m ORDER BY m`, [t]);
    const byTenant = t ? null : await tx.query(`${base}
      SELECT tenant_id AS id, tenant_name AS name, count(*)::int AS total,
             count(*) FILTER (WHERE esc_min <= escalate_minutes)::int AS within,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY esc_min) AS median_min,
             count(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acked,
             count(*) FILTER (WHERE acknowledged_at IS NOT NULL AND acknowledged_at - escalated_at <= ack_hours * interval '1 hour')::int AS acked_within
      FROM e WHERE ${window} GROUP BY tenant_id, tenant_name ORDER BY tenant_name`, [t]);
    return { summary, bySeverity, trend, byTenant };
  });
});

route('GET', '/api/health-scores', async (req) => {
  need(req, 'viewHealth');
  return withCtx(req.ctx, async tx => {
    const rows = await tx.query(`
      SELECT t.id, t.name, t.service, t.siem, t.licensed_eps, t.services, t.categories, t.renewal_date, t.contacts_confirmed_at,
             m.peak_eps_30d::float AS peak_eps, m.sources_down, m.sources_total, m.refreshed_at,
             (SELECT count(*)::int FROM escalations e JOIN sla_targets s ON s.severity = e.severity
                WHERE e.tenant_id = t.id AND e.escalated_at > now() - interval '30 days') AS esc_total,
             (SELECT count(*)::int FROM escalations e JOIN sla_targets s ON s.severity = e.severity
                WHERE e.tenant_id = t.id AND e.escalated_at > now() - interval '30 days'
                  AND extract(epoch FROM e.escalated_at - e.detected_at) / 60 <= s.escalate_minutes) AS esc_within,
             (SELECT count(*)::int FROM escalations e JOIN sla_targets s ON s.severity = e.severity
                WHERE e.tenant_id = t.id AND e.escalated_at > now() - interval '30 days'
                  AND coalesce(e.acknowledged_at, now()) - e.escalated_at > s.ack_hours * interval '1 hour') AS slow_acks,
             (SELECT count(*)::int FROM reports r WHERE r.tenant_id = t.id AND r.withdrawn_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM report_downloads d WHERE d.report_id = r.id AND d.side = 'Customer')) AS unread_reports,
             (SELECT count(*)::int FROM log_source_contracts c WHERE c.tenant_id = t.id AND NOT c.onboarded) AS pending_sources
      FROM tenants t LEFT JOIN tenant_metrics m ON m.tenant_id = t.id WHERE t.active ORDER BY t.name`);
    const day = 86400_000;
    const out = rows.map((r: any) => {
      const signals: { level: 'bad' | 'warn' | 'info'; text: string }[] = [];
      const opportunities: string[] = [];
      let score = 100;
      if (r.licensed_eps && r.peak_eps != null) {
        const u = r.peak_eps / r.licensed_eps;
        if (u > 1) { signals.push({ level: 'bad', text: 'Peak EPS over licence' }); opportunities.push('EPS licence upgrade'); score -= 10; }
        else if (u > 0.85) { signals.push({ level: 'warn', text: 'Peak EPS near licence' }); opportunities.push('EPS licence upgrade'); score -= 5; }
      }
      if (r.refreshed_at == null) { signals.push({ level: 'info', text: 'No monitoring data yet' }); }
      if (r.esc_total > 0) { const pct = r.esc_within / r.esc_total; if (pct < 0.9) { signals.push({ level: 'bad', text: `CySOC SLA ${Math.round(pct * 100)}%` }); score -= 15; } }
      if (r.slow_acks >= 2) { signals.push({ level: 'warn', text: `${r.slow_acks} slow customer acks` }); score -= 10; }
      if (r.sources_down > 0) { signals.push({ level: 'bad', text: `${r.sources_down} log source${r.sources_down > 1 ? 's' : ''} down` }); score -= 10; }
      const confirmedDays = r.contacts_confirmed_at ? Math.floor((Date.now() - new Date(r.contacts_confirmed_at).getTime()) / day) : null;
      if (confirmedDays === null || confirmedDays > 90) { signals.push({ level: 'warn', text: confirmedDays === null ? 'Contacts never confirmed' : `Contacts unconfirmed ${confirmedDays} d` }); score -= 10; }
      const renewalDays = r.renewal_date ? Math.ceil((new Date(r.renewal_date).getTime() - Date.now()) / day) : null;
      if (renewalDays !== null && renewalDays <= 90) { signals.push({ level: 'info', text: `Renewal in ${renewalDays} days` }); score -= 5; }
      if (r.unread_reports >= 2) { signals.push({ level: 'info', text: `${r.unread_reports} reports unread` }); score -= 5; }
      const cats: string[] = r.categories || [];
      if (!cats.includes('VA')) opportunities.push('Vulnerability assessment');
      if (!cats.includes('DDoS')) opportunities.push('DDoS detection');
      if (r.pending_sources) opportunities.push(`${r.pending_sources} log source${r.pending_sources > 1 ? 's' : ''} to onboard`);
      score = Math.max(0, score);
      return { id: r.id, name: r.name, service: r.service, categories: r.categories, score, state: score >= 85 ? 'Healthy' : score >= 65 ? 'Watch' : 'At risk', signals, opportunities, renewalDate: r.renewal_date, renewalDays };
    }).sort((a: any, b: any) => a.score - b.score);
    return { items: out };
  });
});

// ---------- Customer directory (staff): customers in a category with their live workload ----------
route('GET', '/api/customers', async (req) => {
  need(req, 'viewAllTenants');
  const category = req.query.get('category') || 'all';
  if (category !== 'all' && !CATEGORY_CODES.includes(category)) throw badRequest('Unknown customer category.');
  return withCtx(req.ctx, async tx => {
    const items = await tx.query(`
      SELECT t.id, t.code, t.name, t.service, t.siem, t.categories, t.renewal_date, t.licensed_eps, t.licensed_assets,
             count(e.id) FILTER (WHERE e.status <> 'closed')::int AS open,
             count(e.id) FILTER (WHERE e.status = 'triage')::int AS triage,
             count(e.id) FILTER (WHERE e.status = 'escalated')::int AS awaiting,
             count(e.id) FILTER (WHERE e.status = 'escalated' AND now() - e.escalated_at > s.ack_hours * interval '1 hour')::int AS overdue,
             (SELECT count(*)::int FROM service_requests r WHERE r.tenant_id = t.id AND r.status <> 'Completed') AS open_requests,
             (SELECT max(r.uploaded_at) FROM reports r WHERE r.tenant_id = t.id AND r.withdrawn_at IS NULL) AS last_report
      FROM tenants t
      LEFT JOIN escalations e ON e.tenant_id = t.id
      LEFT JOIN sla_targets s ON s.severity = e.severity
      WHERE t.active AND ($1 = 'all' OR $1 = ANY(t.categories))
      GROUP BY t.id ORDER BY t.name`, [category]);
    const counts = await tx.query(`SELECT c AS code, count(*)::int AS n FROM tenants, unnest(categories) AS c WHERE active GROUP BY c`);
    return { categories: CATEGORIES, counts: Object.fromEntries(counts.map((r: any) => [r.code, r.n])), total: (await tx.one('SELECT count(*)::int AS n FROM tenants WHERE active')).n, items };
  });
});

// Security dashboard data. In live mode each tenant has its own Grafana connection
// (integration id `grafana:<tenant code>`) with one query per panel; the server runs the queries
// through Grafana's /api/ds/query and normalises the returned data frames. The browser never
// talks to Grafana and never sees the token.
import { config } from '../config.js';
import { getIntegration, markStatus, callJson } from './registry.js';

export type RangeKey = '24h' | '7d' | '30d';
export const RANGES: Record<RangeKey, { hours: number; lineStepH: number; barStepH: number }> = {
  '24h': { hours: 24, lineStepH: 1, barStepH: 1 },
  '7d': { hours: 168, lineStepH: 1, barStepH: 24 },
  '30d': { hours: 720, lineStepH: 6, barStepH: 24 },
};
export const PANELS = ['eps', 'alerts', 'tactics', 'rules', 'sources'] as const;
type Panel = typeof PANELS[number];

export interface Point { t: number; v: number; }
export interface SevPoint { t: number; Critical: number; High: number; Medium: number; Low: number; }
export interface LabelValue { label: string; value: number; }
export interface Source { name: string; type: string; lastSeen: number | null; eps: number; tenant?: string; }
export interface DashboardData {
  range: RangeKey; eps: Point[]; alerts: SevPoint[]; tactics: LabelValue[]; rules: LabelValue[]; sources: Source[];
  configured: Record<Panel, boolean>; errors: string[];
}
const SEVS = ['Critical', 'High', 'Medium', 'Low'] as const;

// ---------- Data frame normalisation ----------
interface Frame { schema: { name?: string; fields: { name: string; type?: string; labels?: Record<string, string>; config?: any }[] }; data: { values: any[][] }; }
const fieldIdx = (f: Frame, pred: (x: Frame['schema']['fields'][0]) => boolean) => f.schema.fields.findIndex(pred);
const isTime = (x: { type?: string }) => x.type === 'time';
const isNum = (x: { type?: string }) => x.type === 'number';
const isStr = (x: { type?: string }) => x.type === 'string';

function bucketTs(t: number, stepH: number) { const s = stepH * 3600_000; return Math.floor(t / s) * s; }

/** Rate series (e.g. events per second): average each series within a bucket, then sum the series. */
export function toSeries(frames: Frame[], stepH: number): Point[] {
  const total = new Map<number, number>();
  for (const f of frames) {
    const ti = fieldIdx(f, isTime);
    if (ti < 0) continue;
    f.schema.fields.forEach((fld, i) => {
      if (!isNum(fld)) return;
      const per = new Map<number, { sum: number; n: number }>();
      f.data.values[ti].forEach((t: number, k: number) => {
        const b = bucketTs(Number(t), stepH); const a = per.get(b) ?? { sum: 0, n: 0 };
        a.sum += Number(f.data.values[i][k]) || 0; a.n++; per.set(b, a);
      });
      per.forEach((a, b) => total.set(b, (total.get(b) ?? 0) + a.sum / a.n));
    });
  }
  return [...total.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

function sevOf(s: string): typeof SEVS[number] | null {
  const m = s.toLowerCase();
  return m.includes('crit') ? 'Critical' : m.includes('high') ? 'High' : m.includes('med') ? 'Medium' : m.includes('low') ? 'Low' : null;
}

export function toSeverity(frames: Frame[], stepH: number): SevPoint[] {
  const acc = new Map<number, SevPoint>();
  const add = (t: number, sev: typeof SEVS[number] | null, v: number) => {
    if (!sev) return; const b = bucketTs(t, stepH);
    const p = acc.get(b) ?? { t: b, Critical: 0, High: 0, Medium: 0, Low: 0 }; p[sev] += v; acc.set(b, p);
  };
  for (const f of frames) {
    const ti = fieldIdx(f, isTime); if (ti < 0) continue;
    const si = fieldIdx(f, x => isStr(x) && /sev/i.test(x.name));
    if (si >= 0) { // long table: time, severity, count
      const ci = fieldIdx(f, isNum);
      f.data.values[ti].forEach((t: number, k: number) => add(Number(t), sevOf(String(f.data.values[si][k])), Number(f.data.values[ci][k]) || 0));
      continue;
    }
    f.schema.fields.forEach((fld, i) => { // wide: one numeric field per severity (by label, field or frame name)
      if (!isNum(fld)) return;
      const sev = sevOf(fld.labels?.severity ?? fld.config?.displayNameFromDS ?? (fld.name !== 'Value' ? fld.name : f.schema.name ?? ''));
      f.data.values[ti].forEach((t: number, k: number) => add(Number(t), sev, Number(f.data.values[i][k]) || 0));
    });
  }
  return [...acc.values()].sort((a, b) => a.t - b.t);
}

export function toLabelValues(frames: Frame[]): LabelValue[] {
  const acc = new Map<string, number>();
  for (const f of frames) {
    const li = fieldIdx(f, isStr), vi = fieldIdx(f, isNum);
    if (li < 0 || vi < 0) continue;
    f.data.values[li].forEach((l: string, k: number) => acc.set(String(l), (acc.get(String(l)) ?? 0) + (Number(f.data.values[vi][k]) || 0)));
  }
  return [...acc.entries()].map(([label, value]) => ({ label, value: Math.round(value) })).sort((a, b) => b.value - a.value);
}

export function toSources(frames: Frame[]): Source[] {
  const out: Source[] = [];
  for (const f of frames) {
    const by = (re: RegExp) => fieldIdx(f, x => re.test(x.name));
    const ni = by(/^(name|source|log_?source)/i), ty = by(/type/i), ls = by(/last|seen/i), ep = by(/eps|rate/i);
    if (ni < 0) continue;
    f.data.values[ni].forEach((n: string, k: number) => out.push({
      name: String(n), type: ty >= 0 ? String(f.data.values[ty][k]) : '',
      lastSeen: ls >= 0 && f.data.values[ls][k] != null ? Number(new Date(f.data.values[ls][k])) : null,
      eps: ep >= 0 ? Number(f.data.values[ep][k]) || 0 : 0,
    }));
  }
  return out;
}

// ---------- Live query ----------
async function queryPanel(integ: { endpoint: string; secret: string | null }, panel: { datasourceUid: string; query: any }, range: RangeKey, stepH: number): Promise<Frame[]> {
  const base = integ.endpoint.replace(/\/$/, '');
  const body = {
    from: `now-${RANGES[range].hours}h`, to: 'now',
    queries: [{ refId: 'A', datasource: { uid: panel.datasourceUid }, intervalMs: stepH * 3600_000, maxDataPoints: 800, ...panel.query }],
  };
  const r = await callJson(`${base}/api/ds/query`, { method: 'POST', headers: { Authorization: `Bearer ${integ.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 20000 });
  const res = r.results?.A;
  if (res?.error) throw new Error(res.error);
  return res?.frames ?? [];
}

// ---------- Demo data (INTEGRATION_MODE=demo) ----------
function seeded(seed: number) { let s = seed % 2147483647 || 1; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const RULES: Record<string, string[]> = {
  QRadar: ['Multiple Login Failures for the Same User', 'Excessive Firewall Denies from Single Source', 'Communication with Known Malicious IP', 'Login Successful After Scan Attempt', 'Potential Data Exfiltration (Outbound Volume)', 'Local L2R LDAP Reconnaissance'],
  Antarex: ['SSHD brute force attempt', 'Multiple Windows logon failures', 'File integrity: checksum changed', 'Web server 400 errors from same source', 'CIS benchmark check failed', 'Rootcheck: suspicious process'],
};
const TACTICS = ['Credential Access', 'Discovery', 'Initial Access', 'Command and Control', 'Execution', 'Lateral Movement', 'Persistence', 'Exfiltration'];
const SRC: Record<string, [string, string][]> = {
  QRadar: [['FortiGate HQ firewall', 'Firewall'], ['Palo Alto internet edge', 'Firewall'], ['Windows DC01', 'Windows'], ['Windows DC02', 'Windows'], ['Exchange server', 'Windows'], ['Linux web cluster', 'Linux'], ['Microsoft 365 audit', 'Cloud'], ['Core switch syslog', 'Network']],
  Antarex: [['Wazuh agents (servers)', 'Endpoint'], ['Wazuh agents (workstations)', 'Endpoint'], ['FortiGate branch firewall', 'Firewall'], ['Windows AD', 'Windows'], ['Web server logs', 'Linux']],
};
export function demoData(tenant: { code: string; siem: string; licensed_eps: number | null; licensed_assets: number | null }, range: RangeKey): DashboardData {
  const r = seeded(hash(tenant.code));
  const siem = tenant.siem === 'QRadar' ? 'QRadar' : 'Antarex';
  const base = tenant.licensed_eps ? tenant.licensed_eps * (0.42 + r() * 0.3) : (tenant.licensed_assets ?? 50) * 3.2;
  const R = RANGES[range]; const now = Math.floor(Date.now() / 3600_000) * 3600_000;
  const hourly: { t: number; eps: number; sev: Record<string, number> }[] = [];
  const rr = seeded(hash(tenant.code) + 99);
  for (let h = 719; h >= 0; h--) {
    const t = now - h * 3600_000; const loc = new Date(t + 8 * 3600_000);
    const diurnal = Math.max(0, Math.sin((loc.getUTCHours() - 6) / 12 * Math.PI));
    const wk = [0, 6].includes(loc.getUTCDay()) ? 0.7 : 1;
    const eps = base * (0.55 + 0.6 * diurnal) * wk * (0.9 + rr() * 0.2);
    const k = eps / base;
    hourly.push({ t, eps, sev: { Critical: rr() < 0.004 * k ? 1 : 0, High: rr() < 0.05 * k ? 1 : 0, Medium: rr() < 0.3 * k ? 1 + Math.floor(rr() * 2) : 0, Low: Math.floor(rr() * 3 * k) } });
  }
  const win = hourly.slice(-R.hours);
  const eps: Point[] = []; const alerts: SevPoint[] = [];
  for (let i = 0; i < win.length; i += R.lineStepH) { const s = win.slice(i, i + R.lineStepH); eps.push({ t: s[s.length - 1].t, v: s.reduce((a, x) => a + x.eps, 0) / s.length }); }
  for (let i = 0; i < win.length; i += R.barStepH) {
    const s = win.slice(i, i + R.barStepH); const p: SevPoint = { t: s[s.length - 1].t, Critical: 0, High: 0, Medium: 0, Low: 0 };
    s.forEach(x => SEVS.forEach(k => { p[k] += x.sev[k]; })); alerts.push(p);
  }
  const scale = R.hours / 720;
  const rules = RULES[siem].map(label => ({ label, value: Math.max(1, Math.round((40 + r() * 900) * scale)) })).sort((a, b) => b.value - a.value);
  const tactics = TACTICS.map(label => ({ label, value: Math.max(1, Math.round((10 + r() * 110) * (label === 'Credential Access' || label === 'Discovery' ? 2 : 1) * scale)) })).sort((a, b) => b.value - a.value);
  const sources = SRC[siem].map(([name, type]) => { const q = r(); const lagMin = q < 0.75 ? r() * 8 : q < 0.9 ? 20 + r() * 200 : 400 + r() * 1500; return { name, type, lastSeen: Date.now() - lagMin * 60_000, eps: Math.round(base / SRC[siem].length * (0.5 + r())) }; });
  return { range, eps, alerts, tactics, rules, sources, configured: { eps: true, alerts: true, tactics: true, rules: true, sources: true }, errors: [] };
}

// ---------- Public API ----------
const cache = new Map<string, { at: number; data: DashboardData }>();

export async function tenantDashboard(tenant: { id: string; code: string; name: string; siem: string; licensed_eps: number | null; licensed_assets: number | null }, range: RangeKey): Promise<DashboardData> {
  if (config.integrationMode === 'demo') return demoData(tenant, range);
  const key = `${tenant.code}:${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const empty: DashboardData = { range, eps: [], alerts: [], tactics: [], rules: [], sources: [], configured: { eps: false, alerts: false, tactics: false, rules: false, sources: false }, errors: [] };
  const integ = await getIntegration(`grafana:${tenant.code}`);
  if (!integ || !integ.enabled || !integ.endpoint || !integ.secret) { empty.errors.push(`Grafana is not configured for ${tenant.name}.`); return empty; }
  const panels = integ.settings?.panels ?? {};
  const R = RANGES[range];
  const out = { ...empty, configured: { ...empty.configured } };
  let failures = 0;
  await Promise.all(PANELS.map(async p => {
    const cfg = panels[p];
    if (!cfg?.datasourceUid) return;
    out.configured[p] = true;
    try {
      const frames = await queryPanel(integ, cfg, range, p === 'alerts' ? R.barStepH : R.lineStepH);
      if (p === 'eps') out.eps = toSeries(frames, R.lineStepH);
      if (p === 'alerts') out.alerts = toSeverity(frames, R.barStepH);
      if (p === 'tactics') out.tactics = toLabelValues(frames);
      if (p === 'rules') out.rules = toLabelValues(frames).slice(0, 8);
      if (p === 'sources') out.sources = toSources(frames);
    } catch (e: any) { failures++; out.errors.push(`${tenant.name} ${p} panel: ${e.message}`); }
  }));
  await markStatus(integ.id, failures === 0, failures ? out.errors[0] : 'Queries succeeded');
  cache.set(key, { at: Date.now(), data: out });
  return out;
}

export function combine(list: { name: string; data: DashboardData }[], range: RangeKey): DashboardData {
  const sumSeries = (arrs: Point[][]) => { const m = new Map<number, number>(); arrs.flat().forEach(p => m.set(p.t, (m.get(p.t) ?? 0) + p.v)); return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v })); };
  const sumSev = (arrs: SevPoint[][]) => { const m = new Map<number, SevPoint>(); arrs.flat().forEach(p => { const q = m.get(p.t) ?? { t: p.t, Critical: 0, High: 0, Medium: 0, Low: 0 }; SEVS.forEach(k => { q[k] += p[k]; }); m.set(p.t, q); }); return [...m.values()].sort((a, b) => a.t - b.t); };
  const merge = (arrs: LabelValue[][]) => { const m = new Map<string, number>(); arrs.flat().forEach(x => m.set(x.label, (m.get(x.label) ?? 0) + x.value)); return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value); };
  const configured = Object.fromEntries(PANELS.map(p => [p, list.some(x => x.data.configured[p])])) as Record<Panel, boolean>;
  return {
    range, eps: sumSeries(list.map(x => x.data.eps)), alerts: sumSev(list.map(x => x.data.alerts)),
    tactics: merge(list.map(x => x.data.tactics)), rules: merge(list.map(x => x.data.rules)).slice(0, 6),
    sources: list.flatMap(x => x.data.sources.map(s => ({ ...s, tenant: x.name }))),
    configured, errors: list.flatMap(x => x.data.errors),
  };
}

export async function testGrafana(id: string): Promise<string> {
  const integ = await getIntegration(id);
  if (!integ?.endpoint || !integ.secret) throw new Error('Set the Grafana URL and service account token first.');
  const r = await callJson(`${integ.endpoint.replace(/\/$/, '')}/api/health`, { headers: { Authorization: `Bearer ${integ.secret}` } });
  return `Grafana ${r.version ?? ''} reachable, database ${r.database ?? 'unknown'}.`;
}

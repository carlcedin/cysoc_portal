import React, { useState } from 'react';
import { useApi, Kpi, Kpis, Panel, Table, Loading, ErrorBox, Chips, LineChart, StackBars, HBars, SevLegend, kfmt, ago, SEVS } from '../ui';
import type { ViewProps } from '../App';

const RANGES: [string, string][] = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];

export function Dashboard({ meta, scope, setScope }: ViewProps) {
  const staff = meta.user.role !== 'customer';
  const [range, setRange] = useState('7d');
  const t = staff && scope !== 'all' ? `&tenant=${scope}` : '';
  const { data, error, loading } = useApi<any>(`/api/dashboard?range=${range}${t}`, [range, scope]);
  const multi = staff && scope === 'all';
  const chips = <div className="filters"><Chips idPrefix="rng" value={range} options={RANGES} onChange={setRange} /></div>;
  if (error) return <>{chips}<ErrorBox msg={error} /></>;
  if (loading && !data) return <>{chips}<Loading /></>;
  const d = data.data;
  const hours = range === '24h' ? 24 : range === '7d' ? 168 : 720;
  const avg = d.eps.length ? d.eps.reduce((a: number, p: any) => a + p.v, 0) / d.eps.length : 0;
  const peak = d.eps.length ? Math.max(...d.eps.map((p: any) => p.v)) : 0;
  const total = avg * hours * 3600;
  const sev = Object.fromEntries(SEVS.map(s => [s, d.alerts.reduce((a: number, p: any) => a + p[s], 0)])) as Record<string, number>;
  const alertSum = SEVS.reduce((a, s) => a + sev[s], 0);
  const down = d.sources.filter((s: any) => !s.lastSeen || Date.now() - s.lastSeen > 15 * 60_000);
  const src = multi ? `Combined from ${meta.tenants.length} tenant Grafana instances` : 'Grafana';
  const state = (s: any) => !s.lastSeen ? ['st-silent', 'Silent'] : Date.now() - s.lastSeen < 15 * 60_000 ? ['st-ok', 'Reporting'] : Date.now() - s.lastSeen < 6 * 3600_000 ? ['st-delay', 'Delayed'] : ['st-silent', 'Silent'];
  const lic = data.licensedEps;
  return <>
    {chips}
    {d.errors.length > 0 && <div className="banner">{d.errors.slice(0, 3).join(' ')}{d.errors.length > 3 ? ` And ${d.errors.length - 3} more.` : ''}</div>}
    <Kpis>
      <Kpi k="Events ingested" v={kfmt(total)} s={RANGES.find(r => r[0] === range)![1]} />
      <Kpi k="Average EPS" v={kfmt(avg)} s={`Peak ${kfmt(peak)}${lic ? ` · ${Math.round((avg / lic) * 100)}% of licence` : ''}`} />
      <Kpi k="Alerts raised" v={alertSum.toLocaleString()} s={`${sev.Critical} critical · ${sev.High} high`} />
      <Kpi k={staff ? 'Escalations' : 'Escalated to you'} v={data.escalations} s="Details in Escalations" />
      <Kpi k="Log sources reporting" v={`${d.sources.length - down.length}/${d.sources.length}`} s={down.length ? `${down.length} delayed or silent` : 'All reporting'} warn={down.length > 0} />
    </Kpis>
    <div className="dgrid">
      <Panel cls="span8" title="Events per second" src={src}>{d.configured.eps ? <LineChart points={d.eps} refValue={lic} hourly={range === '24h'} label="Events per second over time" /> : <div className="empty">Not configured for this tenant.</div>}</Panel>
      <Panel cls="span4" title="Detections by MITRE ATT&CK tactic" src={src}>{d.configured.tactics ? <HBars list={d.tactics.slice(0, 6)} /> : <div className="empty">Not configured.</div>}</Panel>
      <Panel cls="span8" title={`Alerts by severity, ${range === '24h' ? 'hourly' : 'daily'}`} src={src}>{d.configured.alerts ? <><SevLegend counts={sev} /><StackBars buckets={d.alerts} hourly={range === '24h'} label="Alerts by severity" /></> : <div className="empty">Not configured.</div>}</Panel>
      <Panel cls="span4" title="Top detection rules" src={src}>{d.configured.rules ? <HBars list={d.rules} /> : <div className="empty">Not configured.</div>}</Panel>
      {multi && <Panel cls="span12" title="Tenant ingestion and licence use" src="Click a row to focus on one tenant">
        <Table head={<><th>Tenant</th><th>SIEM</th><th className="num">Avg EPS</th><th className="num">Peak EPS</th><th>Licence use (avg)</th><th className="num">Critical + high</th><th className="num">Sources down</th></>}>
          {data.tenants.map((r: any) => { const u = r.licensedEps && r.avgEps != null ? r.avgEps / r.licensedEps : null; return <tr key={r.id} className="click" tabIndex={0} onClick={() => setScope(r.id)} onKeyDown={e => e.key === 'Enter' && setScope(r.id)}>
            <td><b>{r.name}</b></td><td>{r.siem}</td><td className="num mono">{r.avgEps != null ? kfmt(r.avgEps) : '—'}</td><td className="num mono">{r.peakEps != null ? kfmt(r.peakEps) : '—'}</td>
            <td>{u != null ? <span className="util"><span className="hbt"><i className={r.peakEps > r.licensedEps ? 'hot' : ''} style={{ width: `${Math.min(100, u * 100).toFixed(0)}%` }} /></span><span className="mono">{Math.round(u * 100)}% of {kfmt(r.licensedEps)}</span></span> : <span className="note">{r.licensedAssets ? `${r.licensedAssets} assets (per-asset licence)` : r.configured ? '—' : 'Grafana not configured'}</span>}</td>
            <td className="num mono">{r.critHigh.toLocaleString()}</td><td className={'num' + (r.sourcesDown ? ' breach' : '')}>{r.sourcesDown}</td></tr>; })}
        </Table>
      </Panel>}
      <Panel cls="span12" title={multi ? 'Log sources needing attention' : 'Log source health'} src={src}>
        {(multi ? down : d.sources).length === 0 ? <div className="empty">{d.configured.sources ? 'All log sources are reporting.' : 'Not configured.'}</div> :
          <Table head={<>{multi && <th>Tenant</th>}<th>Source</th><th>Type</th><th>Last event</th><th className="num">Avg EPS</th><th>Status</th></>}>
            {(multi ? down : d.sources).map((s: any, i: number) => { const st = state(s); return <tr key={i}>{multi && <td>{s.tenant}</td>}<td>{s.name}</td><td>{s.type}</td><td className="mono">{ago(s.lastSeen)}</td><td className="num mono">{kfmt(st[1] === 'Silent' ? 0 : s.eps)}</td><td><span className={'dotst ' + st[0]}>{st[1]}</span></td></tr>; })}
          </Table>}
      </Panel>
    </div>
  </>;
}

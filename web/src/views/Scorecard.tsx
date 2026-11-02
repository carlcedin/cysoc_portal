import React from 'react';
import { useApi, Kpi, Kpis, Panel, Table, Loading, ErrorBox, PctBars, Sev, pct, pctPill, minFmt } from '../ui';
import type { ViewProps } from '../App';

export function Scorecard({ meta, scope, setScope }: ViewProps) {
  const staff = meta.user.role !== 'customer';
  const q = staff && scope !== 'all' ? `?tenant=${scope}` : '';
  const { data, error, loading } = useApi<any>(`/api/scorecard${q}`, [scope]);
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;
  const s = data.summary;
  const within = pct(s.within, s.total);
  const ack = pct(s.acked_within, s.acked);
  const trend = data.trend.map((m: any) => ({ label: m.label, v: pct(m.within, m.total) }));
  return <>
    <Kpis>
      <Kpi k="Escalated within SLA" v={within == null ? '—' : within + '%'} s="Target 95% · last 30 days" warn={within != null && within < 95} />
      <Kpi k="Median detect to escalate" v={minFmt(s.median_min)} s="SIEM detection to customer notice" />
      <Kpi k="Escalations" v={s.total} s="Last 30 days" />
      <Kpi k="Customer ack within SLA" v={ack == null ? '—' : ack + '%'} s={`${s.acked} acknowledged`} />
      <Kpi k="Avg time to close" v={s.avg_close_h != null ? Math.round(s.avg_close_h) + 'h' : '—'} s={`${s.closed} closed`} />
    </Kpis>
    <div className="dgrid">
      <Panel cls="span8" title="Escalations within SLA by month" src="CySOC measured · target 95%">
        <div className="legend"><span><i style={{ background: 'var(--pink)' }} />Within SLA</span><span><i className="dash" />Target 95%</span></div>
        <PctBars items={trend} target={95} />
      </Panel>
      <Panel cls="span4" title="Performance by severity" src="Last 30 days">
        <Table head={<><th>Severity</th><th className="num">Target</th><th className="num">Count</th><th className="num">Median</th><th>Within</th></>}>
          {data.bySeverity.map((r: any) => <tr key={r.severity}><td><Sev s={r.severity} /></td><td className="num">{minFmt(r.escalate_minutes)}</td><td className="num">{r.total}</td><td className="num">{minFmt(r.median_min)}</td><td>{pctPill(pct(r.within, r.total))}</td></tr>)}
        </Table>
      </Panel>
      {data.byTenant && <Panel cls="span12" title="Performance by tenant" src="Click a row to see one tenant">
        <Table head={<><th>Tenant</th><th className="num">Escalations</th><th className="num">Median detect to escalate</th><th>Within SLA</th><th>Customer ack within SLA</th></>}>
          {data.byTenant.map((r: any) => <tr key={r.id} className="click" tabIndex={0} onClick={() => setScope(r.id)} onKeyDown={e => e.key === 'Enter' && setScope(r.id)}>
            <td><b>{r.name}</b></td><td className="num">{r.total}</td><td className="num">{minFmt(r.median_min)}</td><td>{pctPill(pct(r.within, r.total))}</td><td>{pctPill(pct(r.acked_within, r.acked))}</td></tr>)}
        </Table>
      </Panel>}
    </div>
    <p className="note">Measured from SIEM detection to the moment CySOC notifies the customer's contacts. Customer acknowledgement is measured separately against the contract acknowledgement target.</p>
  </>;
}

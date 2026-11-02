import React from 'react';
import { useApi, Kpi, Kpis, Pill, Table, Loading, ErrorBox, fmtD } from '../ui';
import type { ViewProps } from '../App';

const LEVEL: Record<string, string> = { bad: 'p-esc', warn: 'p-rem', info: 'p-tri' };
const STATE: Record<string, string> = { Healthy: 'p-closed', Watch: 'p-rem', 'At risk': 'p-esc' };

export function Health({ goService }: ViewProps & { goService: (id: string) => void }) {
  const { data, error, loading } = useApi<any>('/api/health-scores');
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;
  const rows = data.items;
  const atRisk = rows.filter((r: any) => r.state === 'At risk').length;
  return <>
    <Kpis n={4}>
      <Kpi k="At risk" v={atRisk} s="Score below 65" warn={atRisk > 0} />
      <Kpi k="Watch" v={rows.filter((r: any) => r.state === 'Watch').length} s="Score 65 to 84" />
      <Kpi k="Renewals in 90 days" v={rows.filter((r: any) => r.renewalDays != null && r.renewalDays <= 90).length} s="Plan renewal reviews" />
      <Kpi k="Opportunities" v={rows.reduce((a: number, r: any) => a + r.opportunities.length, 0)} s="Upsell and cross-sell" />
    </Kpis>
    <section className="panel"><div className="ph"><h3>Customer health</h3><span className="src">Combines monitoring, escalation, contact and report signals</span></div>
      <Table head={<><th>Tenant</th><th>Health</th><th>Signals</th><th>Opportunities</th><th>Renewal</th></>}>
        {rows.map((r: any) => <tr key={r.id} className="click" tabIndex={0} onClick={() => goService(r.id)} onKeyDown={e => e.key === 'Enter' && goService(r.id)}>
          <td><b>{r.name}</b><div className="note">{r.service}</div></td>
          <td><span className="hscore">{r.score}</span> <Pill c={STATE[r.state]}>{r.state}</Pill></td>
          <td className="wrap-t"><span className="pills">{r.signals.length ? r.signals.map((s: any) => <Pill key={s.text} c={LEVEL[s.level]}>{s.text}</Pill>) : <span className="note">No issues</span>}</span></td>
          <td className="wrap-t"><span className="pills">{r.opportunities.length ? r.opportunities.map((o: string) => <span key={o} className="pillk key">{o}</span>) : <span className="note">None</span>}</span></td>
          <td className={r.renewalDays != null && r.renewalDays <= 90 ? 'breach' : ''}>{fmtD(r.renewalDate)}</td></tr>)}
      </Table>
      <p className="note">Click a tenant to open its service page. Weights are a starting point; tune them with your account managers.</p>
    </section>
  </>;
}

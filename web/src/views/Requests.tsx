import React, { useState } from 'react';
import { api } from '../api';
import { useApi, Kpi, Kpis, Panel, Pill, Table, Loading, ErrorBox, Msg, useAction, fmtD } from '../ui';
import type { ViewProps } from '../App';

const PILL: Record<string, string> = { Submitted: 'p-ack', 'In progress': 'p-rem', Completed: 'p-closed' };

export function Requests({ meta, scope, can }: ViewProps) {
  const staff = meta.user.role !== 'customer';
  const q = staff && scope !== 'all' ? `?tenant=${scope}` : '';
  const { data, error, loading, reload } = useApi<any>(`/api/requests${q}`, [scope]);
  const types = Object.keys(meta.requestTypes);
  const [type, setType] = useState(types[0]); const [details, setDetails] = useState('');
  const { msg, busy, run } = useAction();
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;
  const today = new Date().toISOString().slice(0, 10);
  const late = (r: any) => r.status !== 'Completed' && String(r.target_date).slice(0, 10) < today;
  const items = data.items; const multi = staff && scope === 'all';
  const submit = (e: React.FormEvent) => { e.preventDefault(); run(() => api('POST', '/api/requests', { type, details }), r => `Request ${r.ref} submitted. It is now in the CySOC queue in NTS.`, () => { setDetails(''); reload(); }); };
  const setStatus = (id: string, status: string, ref: string) => run(() => api('POST', `/api/requests/${id}/status`, { status }), `${ref} is now ${status.toLowerCase()}.`, reload);
  return <>
    <Kpis n={3}>
      <Kpi k="Open requests" v={items.filter((r: any) => r.status !== 'Completed').length} s="Submitted or in progress" />
      <Kpi k="Past target" v={items.filter(late).length} s="Not yet completed" warn={items.some(late)} />
      <Kpi k="Completed" v={items.filter((r: any) => r.status === 'Completed').length} s="Last 90 days" />
    </Kpis>
    {can('raiseRequest') && <Panel title="Raise a request">
      <form className="upf" onSubmit={submit} noValidate>
        <label htmlFor="rqType">Request type<select id="rqType" value={type} onChange={e => setType(e.target.value)}>{types.map(t => <option key={t}>{t}</option>)}</select></label>
        <label htmlFor="rqText" className="span-wide">Details<input type="text" id="rqText" maxLength={4000} value={details} onChange={e => setDetails(e.target.value)} placeholder="What you need, including IPs, hosts or dates" /></label>
        <button className="btn" type="submit" id="rqBtn" disabled={busy}>Submit request</button>
      </form>
      <p className="note">Target times in working days: {types.map(t => `${t.toLowerCase()} ${meta.requestTypes[t]}`).join('; ')}.</p>
    </Panel>}
    <Panel title="Requests">
      <Table head={<><th>Ref</th><th>NTS</th>{multi && <th>Tenant</th>}<th>Type</th><th>Details</th><th>Raised by</th><th>Raised</th><th>Target</th><th>Status</th>{can('updateRequest') && <th></th>}</>}>
        {items.length ? items.map((r: any) => <tr key={r.id}>
          <td className="mono"><b>{r.ref}</b></td><td className="mono">{r.nts_ticket_id ? `NTS-${r.nts_ticket_id}` : 'Pending'}</td>{multi && <td>{r.tenant_name}</td>}
          <td>{r.type}</td><td className="wrap-t">{r.details}</td><td>{r.raised_by_name}</td><td>{fmtD(r.created_at)}</td><td className={late(r) ? 'breach' : ''}>{fmtD(r.target_date)}</td>
          <td><Pill c={PILL[r.status]}>{r.status}</Pill></td>
          {can('updateRequest') && <td>{r.status === 'Submitted' ? <button className="btn sm ghost" disabled={busy} onClick={() => setStatus(r.id, 'In progress', r.ref)}>Start work</button> : r.status === 'In progress' ? <button className="btn sm" disabled={busy} onClick={() => setStatus(r.id, 'Completed', r.ref)}>Mark completed</button> : null}</td>}
        </tr>) : <tr><td colSpan={10} className="note">No requests yet.</td></tr>}
      </Table>
      <Msg m={msg} />
    </Panel>
  </>;
}

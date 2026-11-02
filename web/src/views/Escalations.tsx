import React, { useState } from 'react';
import { api } from '../api';
import { useApi, Kpi, Kpis, Panel, Pill, Sev, Table, Loading, ErrorBox, Chips, Msg, useAction, fmt } from '../ui';
import type { ViewProps } from '../App';

const PILL: Record<string, string> = { triage: 'p-tri', escalated: 'p-esc', acknowledged: 'p-ack', remediating: 'p-rem', closed: 'p-closed' };
const LABEL: Record<string, string> = { triage: 'In CySOC triage', escalated: 'Awaiting customer', acknowledged: 'Acknowledged', remediating: 'Remediating', closed: 'Closed' };
const hrs = (a: string, b: string | number) => (new Date(b).getTime() - new Date(a).getTime()) / 3600_000;

export function Escalations({ meta, scope, setScope, can }: ViewProps) {
  const staff = meta.user.role !== 'customer';
  const q = staff && scope !== 'all' ? `?tenant=${scope}` : '';
  const { data, error, loading, reload } = useApi<{ items: any[]; sla: any[] }>(`/api/escalations${q}`, [scope]);
  const [filter, setFilter] = useState('open');
  const [openId, setOpenId] = useState<string | null>(null);
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;
  const items = data!.items;
  const ackH = Object.fromEntries(data!.sla.map(s => [s.severity, Number(s.ack_hours)]));
  const ackState = (e: any) => {
    if (!e.escalated_at) return { txt: '—', cls: '' };
    const lim = ackH[e.severity];
    if (e.acknowledged_at) return hrs(e.escalated_at, e.acknowledged_at) <= lim ? { txt: 'Met', cls: 'okt' } : { txt: 'Missed', cls: 'breach', breach: true };
    const h = hrs(e.escalated_at, Date.now());
    return h <= lim ? { txt: `${(lim - h).toFixed(1)}h left`, cls: '' } : { txt: `Overdue ${Math.round(h - lim)}h`, cls: 'breach', breach: true, overdue: true };
  };
  const open = items.filter(e => e.status !== 'closed');
  const acked = items.filter(e => e.acknowledged_at && e.escalated_at);
  const avgAck = acked.length ? acked.reduce((a, e) => a + hrs(e.escalated_at, e.acknowledged_at), 0) / acked.length : 0;
  const closed = items.filter(e => e.closed_at && e.escalated_at);
  const mttr = closed.length ? closed.reduce((a, e) => a + hrs(e.escalated_at, e.closed_at), 0) / closed.length : 0;
  const overdue = items.filter(e => (ackState(e) as any).overdue);
  const stages = [['triage', 'Triaged', 'NTS ticket', 'CySOC'], ['escalated', 'Escalated', 'Sent to customer', 'Customer'], ['acknowledged', 'Acknowledged', 'Customer confirmed', 'Customer'], ['remediating', 'Remediating', 'Fix in progress', 'Customer'], ['closed', 'Closed', 'Verified closed (90 days)', 'CySOC']].filter(s => staff || s[0] !== 'triage');
  const counts = stages.map(s => items.filter(e => e.status === s[0]).length);
  const max = Math.max(...counts, 1);
  const chipDefs: [string, string][] = [['open', 'Open'], ...(staff ? [['triage', 'In triage'] as [string, string]] : []), ['escalated', 'Awaiting ack'], ['overdue', 'Overdue'], ['closed', 'Closed'], ['all', 'All']];
  const rows = items.filter(e => filter === 'all' || (filter === 'open' ? e.status !== 'closed' : filter === 'overdue' ? (ackState(e) as any).overdue : e.status === filter));
  const multi = staff && scope === 'all';
  const byTenant = multi ? meta.tenants.map(t => {
    const d = items.filter(e => e.tenant_id === t.id);
    const br = d.filter(e => (ackState(e) as any).breach).length, od = d.filter(e => (ackState(e) as any).overdue).length;
    const ak = d.filter(e => e.acknowledged_at && e.escalated_at);
    return { t, open: d.filter(e => e.status !== 'closed').length, awaiting: d.filter(e => e.status === 'escalated').length, br, od, avg: ak.length ? (ak.reduce((a, e) => a + hrs(e.escalated_at, e.acknowledged_at), 0) / ak.length).toFixed(1) : '—' };
  }) : [];

  return <>
    <Kpis>
      <Kpi k="Open escalations" v={open.length} s={staff ? 'Includes CySOC triage' : 'Not yet closed'} />
      <Kpi k="Awaiting customer ack" v={items.filter(e => e.status === 'escalated').length} s="Escalated, no response" />
      <Kpi k="Overdue ack" v={overdue.length} s="Past severity SLA" warn={overdue.length > 0} />
      <Kpi k="Avg time to ack" v={avgAck.toFixed(1) + 'h'} s={`${acked.length} acknowledged`} />
      <Kpi k="Avg time to close" v={mttr.toFixed(0) + 'h'} s={`${closed.length} closed`} />
    </Kpis>
    <Panel title="Escalations by lifecycle stage">
      <div className="flow" style={{ gridTemplateColumns: `repeat(${stages.length},minmax(0,1fr))` }}>
        {stages.map((s, i) => <div key={s[0]} className={'stage' + (s[3] === 'Customer' ? ' cust' : '')}><span className="own">{s[3]}</span><span className="n">{counts[i]}</span><div className="bar"><i style={{ width: `${(counts[i] / max) * 100}%` }} /></div><span className="l">{s[1]}<br />{s[2]}</span></div>)}
      </div>
    </Panel>
    {multi && <Panel title="Tenant overview" src="Click a tenant to focus on it">
      <Table head={<><th>Tenant</th><th>Service</th><th className="num">Open</th><th className="num">Awaiting ack</th><th className="num">SLA breaches</th><th className="num">Avg ack (h)</th><th>Health</th></>}>
        {byTenant.map(r => <tr key={r.t.id} className="click" tabIndex={0} onClick={() => setScope(r.t.id)} onKeyDown={e => e.key === 'Enter' && setScope(r.t.id)}>
          <td><b>{r.t.name}</b></td><td>{r.t.service}</td><td className="num">{r.open}</td><td className="num">{r.awaiting}</td><td className={'num' + (r.br ? ' breach' : '')}>{r.br}</td><td className="num">{r.avg}</td>
          <td>{r.od ? <Pill c="p-esc">Chase customer</Pill> : r.br > 1 ? <Pill c="p-rem">Review SLA</Pill> : <Pill c="p-closed">On track</Pill>}</td></tr>)}
      </Table>
    </Panel>}
    <section className="panel">
      <div className="filters"><h3>Escalation register</h3><Chips idPrefix="chip" value={filter} options={chipDefs} onChange={v => { setFilter(v); setOpenId(null); }} /></div>
      <Table head={<><th>Ref</th>{multi && <th>Tenant</th>}<th>Severity</th><th>Summary</th><th>Status</th><th>Escalated</th><th>Customer ack</th><th>Ack SLA</th></>}>
        {rows.length ? rows.slice(0, 300).map(e => { const a = ackState(e); return <React.Fragment key={e.id}>
          <tr className="click" tabIndex={0} data-ref={e.ref} onClick={() => setOpenId(openId === e.id ? null : e.id)} onKeyDown={k => k.key === 'Enter' && setOpenId(openId === e.id ? null : e.id)}>
            <td className="mono">{e.ref}</td>{multi && <td>{e.tenant_name}</td>}<td><Sev s={e.severity} /></td><td className="wrap-t">{e.summary}</td>
            <td><Pill c={PILL[e.status]}>{LABEL[e.status]}</Pill></td><td className="mono">{fmt(e.escalated_at)}</td><td className="mono">{fmt(e.acknowledged_at)}</td><td className={a.cls}>{a.txt}</td></tr>
          {openId === e.id && <tr className="editrow"><td colSpan={8}><Detail id={e.id} staff={staff} can={can} onChange={reload} /></td></tr>}
        </React.Fragment>; }) : <tr><td colSpan={8} className="note">No escalations match this filter.</td></tr>}
      </Table>
      {rows.length > 300 && <p className="note">Showing the first 300. Narrow the filter or choose a tenant to see more.</p>}
    </section>
  </>;
}

function Detail({ id, staff, can, onChange }: { id: string; staff: boolean; can: (p: string) => boolean; onChange: () => void }) {
  const { data, error, reload } = useApi<any>(`/api/escalations/${id}`, [id]);
  const { msg, busy, run } = useAction();
  const [text, setText] = useState('');
  if (error) return <ErrorBox msg={error} />;
  if (!data) return <Loading />;
  const e = data.escalation;
  const steps: [string, string | null][] = [
    [`Detected by ${e.source || 'SIEM'}`, e.detected_at], ['Triaged by CySOC, NTS ticket raised', e.triaged_at], ['Escalated to customer', e.escalated_at],
    ['Customer acknowledged' + (e.ack_via ? ` via ${e.ack_via}` : ''), e.acknowledged_at], ['Customer remediation underway', e.remediation_at],
    ['Customer reported fixed, closure requested', e.closure_requested_at], ['CySOC verified and closed', e.closed_at],
  ];
  const act = (action: string, ok: string) => run(() => api('POST', `/api/escalations/${id}/actions`, { action }), ok, () => { reload(); onChange(); });
  const buttons: React.ReactNode[] = [];
  if (staff && can('staffEscalationActions')) {
    if (e.status === 'triage') buttons.push(<button key="esc" className="btn" id="b-esc" disabled={busy} onClick={() => act('escalate', 'Escalated. Customer contacts are being notified.')}>Escalate to customer</button>);
    if (e.status === 'escalated') buttons.push(<button key="rem" className="btn ghost" id="b-chase" disabled={busy} onClick={() => act('remind', 'Reminder sent to customer contacts.')}>Send reminder</button>);
    if (['acknowledged', 'remediating'].includes(e.status)) buttons.push(<button key="close" className="btn" id="b-close" disabled={busy} onClick={() => act('close', 'Closed and synced to NTS.')}>Verify and close</button>);
    if (e.status === 'triage') buttons.push(<button key="fp" className="btn ghost" id="b-fp" disabled={busy} onClick={() => act('close', 'Closed without escalation.')}>Close as no action needed</button>);
  }
  if (!staff) {
    if (e.status === 'escalated') buttons.push(<button key="ack" className="btn" id="b-ack" disabled={busy} onClick={() => act('acknowledge', 'Acknowledged. CySOC has been notified.')}>Acknowledge</button>);
    if (e.status === 'acknowledged') buttons.push(<button key="rm" className="btn" id="b-rem" disabled={busy} onClick={() => act('remediate', 'Status set to remediating.')}>Mark remediation started</button>);
    if (e.status === 'remediating' && !e.closure_requested_at) buttons.push(<button key="done" className="btn ghost" id="b-done" disabled={busy} onClick={() => act('request_closure', 'Closure requested. CySOC will verify before closing.')}>Report fixed, request closure</button>);
  }
  const post = () => run(() => api('POST', `/api/escalations/${id}/messages`, { body: text }), 'Message posted and saved to NTS.', () => { setText(''); reload(); });
  return <div className="drawer" style={{ border: 0, padding: 4 }}>
    <h4><span className="mono">{e.ref}</span> · {e.summary}</h4>
    <div className="note">{e.tenant_name} · <Sev s={e.severity} /></div>
    <ol className="tl">{steps.filter(([, at], i) => at || i < 3 || e.status !== 'closed').map(([t, at]) => <li key={t} className={at ? 'done' : ''}><div><div className="t">{t}</div><div className="d mono">{at ? fmt(at) : 'Pending'}</div></div></li>)}</ol>
    {e.escalated_at && <div className="nblock"><div className="nk">Notifications</div>
      <div className="pills">{data.notifications.length ? data.notifications.map((n: any) => <span key={n.channel + n.recipient_name} className="pillk key">{n.recipient_name} · {n.channel}{n.delivered ? '' : ' (sending)'}</span>) : <span className="note">None recorded.</span>}</div>
      {['Critical', 'High'].includes(e.severity) && <div className="note">Critical and high escalations go by email and SMS, with a one-click acknowledge link in the email.</div>}
    </div>}
    {e.status !== 'triage' && <div className="thread"><div className="nk">Discussion</div>
      {data.messages.length ? data.messages.map((m: any) => <div key={m.id} className={'msg ' + (m.side === 'CySOC' ? 'cy' : 'cu')}><div className="mh"><b>{m.author_name}</b><span className="note">{m.side} · {fmt(m.created_at)}</span></div><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>) : <div className="note">No messages yet.</div>}
      <label htmlFor="cmt" className="nk">Add a message</label>
      <textarea id="cmt" rows={2} maxLength={5000} value={text} placeholder={staff ? 'Message to the customer' : 'Message to CySOC'} onChange={ev => setText(ev.target.value)} />
      <div className="actions"><button className="btn sm ghost" id="b-post" disabled={busy || !text.trim()} onClick={post}>Post message</button><span className="note">Saved to the NTS ticket as a note.</span></div>
    </div>}
    {buttons.length > 0 && <div className="actions">{buttons}</div>}
    <Msg m={msg} />
  </div>;
}

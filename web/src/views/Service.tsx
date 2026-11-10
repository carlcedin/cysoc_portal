import React, { useState } from 'react';
import { api } from '../api';
import { useApi, Kpi, Kpis, Panel, Pill, Table, Loading, ErrorBox, Msg, useAction, fmtD, kfmt, minFmt, Sev } from '../ui';
import type { ViewProps } from '../App';

const DAY = 86400_000;
const daysSince = (d?: string | null) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null);
const daysTo = (d?: string | null) => (d ? Math.ceil((new Date(d).getTime() - Date.now()) / DAY) : null);

export function Service({ meta, scope, setScope, can }: ViewProps) {
  const staff = meta.user.role !== 'customer';
  const q = staff && scope !== 'all' ? `?tenant=${scope}` : '';
  const { data, error, loading, reload } = useApi<any>(`/api/service${q}`, [scope]);
  const { msg, busy, run } = useAction();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', role: '', tier: 'Secondary', email: '', phone: '', alertChannels: 'Email, SMS' });
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;

  if (data.overview) {
    return <Panel title="Service entitlements and contacts" src="Click a row to manage one tenant">
      <Table head={<><th>Tenant</th><th>Services</th><th>Licence</th><th className="num">Log sources</th><th>Contacts confirmed</th><th>Renewal</th></>}>
        {data.overview.map((t: any) => { const cd = daysSince(t.contacts_confirmed_at), rd = daysTo(t.renewal_date); return <tr key={t.id} className="click" tabIndex={0} onClick={() => setScope(t.id)} onKeyDown={e => e.key === 'Enter' && setScope(t.id)}>
          <td><b>{t.name}</b></td><td className="wrap-t"><span className="pills">{t.services.map((s: string) => <span key={s} className="pillk key">{s}</span>)}</span></td>
          <td>{t.licensed_eps ? kfmt(t.licensed_eps) + ' EPS' : t.licensed_assets ? t.licensed_assets + ' assets' : '—'}</td>
          <td className={'num' + (t.onboarded < t.contracted ? ' breach' : '')}>{t.onboarded} of {t.contracted}</td>
          <td className={cd == null || cd > 90 ? 'breach' : ''}>{cd == null ? 'Never' : `${cd} days ago`}</td>
          <td className={rd != null && rd <= 90 ? 'breach' : ''}>{t.renewal_date ? `${fmtD(t.renewal_date)} · ${rd} d` : '—'}</td></tr>; })}
      </Table>
    </Panel>;
  }

  const t = data.tenant, contacts = data.contacts, sources = data.logSources;
  const onboarded = sources.filter((s: any) => s.onboarded).length, pending = sources.filter((s: any) => !s.onboarded);
  const pctOn = sources.length ? Math.round((onboarded / sources.length) * 100) : 0;
  const cd = daysSince(t.contacts_confirmed_at), rd = daysTo(t.renewal_date);
  const editable = can('editContacts');
  const add = (e: React.FormEvent) => { e.preventDefault(); run(() => api('POST', '/api/contacts', { ...f, tenantId: t.id }), `${f.name} added as a ${f.tier.toLowerCase()} contact.`, () => { setF({ ...f, name: '', role: '', email: '', phone: '' }); reload(); }); };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return <>
    <Kpis n={4}>
      <Kpi k="Services" v={t.services.length} s="Active subscriptions" />
      <Kpi k="Licence" v={t.licensed_eps ? kfmt(t.licensed_eps) + ' EPS' : t.licensed_assets ?? '—'} s={t.licensed_eps ? 'Events per second' : 'Monitored assets'} />
      <Kpi k="Log sources" v={`${onboarded}/${sources.length}`} s={pending.length ? `${pending.length} pending onboarding` : 'All onboarded'} warn={pending.length > 0} />
      <Kpi k="Renewal" v={rd != null ? rd + ' days' : '—'} s={fmtD(t.renewal_date)} warn={rd != null && rd <= 90} />
    </Kpis>
    <div className="dgrid">
      <Panel cls="span4" title="Subscribed services" src="Contract schedule">
        <div className="pills">{t.services.map((s: string) => <span key={s} className="pillk pink">{s}</span>)}</div>
        <dl className="kv"><dt>Monitoring hours</dt><dd>{t.monitoring_hours}, CySOC</dd><dt>SIEM platform</dt><dd>{t.siem === 'QRadar' ? 'IBM QRadar' : t.siem === 'Antarex' ? 'Antarex (Wazuh)' : 'No SIEM monitoring'}</dd><dt>Contract renewal</dt><dd>{fmtD(t.renewal_date)}</dd></dl>
      </Panel>
      <Panel cls="span4" title="Log source onboarding" src="Contracted versus collecting">
        <div className="prog"><span className="hbt"><i style={{ width: `${pctOn}%` }} /></span><b>{pctOn}%</b></div>
        <p className="note">{onboarded} of {sources.length} contracted log sources are sending events.</p>
        {pending.length ? <ul className="plain">{pending.map((p: any) => <li key={p.id}><b>{p.name}</b><span className="note">{p.note || 'Waiting on log forwarding'}</span></li>)}</ul> : <p className="note">Nothing pending.</p>}
      </Panel>
      <Panel cls="span4" title="Service levels" src="Contract targets">
        <Table head={<><th>Severity</th><th className="num">CySOC notifies</th><th className="num">You ack</th></>}>
          {data.sla.map((s: any) => <tr key={s.severity}><td><Sev s={s.severity} /></td><td className="num">{minFmt(s.escalate_minutes)}</td><td className="num">{s.ack_hours} h</td></tr>)}
        </Table>
      </Panel>
    </div>
    <section className="panel"><h3>Escalation contacts</h3>
      {cd == null || cd > 90 ? <div className="stale"><div><b>{cd == null ? 'Contacts have never been confirmed.' : `Contacts last confirmed ${cd} days ago.`}</b> {staff ? 'The customer should review them every 90 days.' : 'Please check the list so escalations reach the right people.'}</div>
        {can('confirmContacts') && <button className="btn sm" id="ct-confirm" disabled={busy} onClick={() => run(() => api('POST', '/api/contacts/confirm'), 'Thank you. Contacts confirmed for the next 90 days.', reload)}>Confirm contacts are current</button>}
        {can('remindContacts') && <button className="btn sm ghost" id="ct-remind" disabled={busy} onClick={() => run(() => api('POST', '/api/contacts/remind', { tenantId: t.id }), 'Reminder emailed to the primary contact.')}>Send reminder</button>}
      </div> : <p className="note">Contacts confirmed {fmtD(t.contacts_confirmed_at)}. Next review due {fmtD(new Date(new Date(t.contacts_confirmed_at).getTime() + 90 * DAY))}.</p>}
      <Table head={<><th>Contact</th><th>Tier</th><th>Email</th><th>Mobile</th><th>Critical alerts by</th>{editable && <th></th>}</>}>
        {contacts.map((p: any) => <tr key={p.id}><td><b>{p.name}</b><div className="note">{p.role}</div></td>
          <td><Pill c={p.tier === 'Primary' ? 'p-pink' : p.tier === 'Secondary' ? 'p-ack' : 'p-tri'}>{p.tier}</Pill></td><td>{p.email}</td><td className="mono">{p.phone}</td><td>{p.alert_channels}</td>
          {editable && <td>{confirmId === p.id
            ? <button className="btn sm danger" disabled={busy} onClick={() => run(() => api('DELETE', `/api/contacts/${p.id}`), `${p.name} removed.`, () => { setConfirmId(null); reload(); })}>Confirm remove</button>
            : <button className="btn sm ghost" onClick={() => setConfirmId(p.id)}>Remove</button>}</td>}
        </tr>)}
      </Table>
      {editable && <form className="upf" onSubmit={add} noValidate>
        <label htmlFor="ctName">Name<input type="text" id="ctName" maxLength={120} value={f.name} onChange={set('name')} /></label>
        <label htmlFor="ctRole">Role<input type="text" id="ctRole" maxLength={120} placeholder="e.g. SOC lead" value={f.role} onChange={set('role')} /></label>
        <label htmlFor="ctTier">Escalation tier<select id="ctTier" value={f.tier} onChange={set('tier')}><option>Primary</option><option>Secondary</option><option>After-hours</option></select></label>
        <label htmlFor="ctEmail">Email<input type="email" id="ctEmail" maxLength={200} value={f.email} onChange={set('email')} /></label>
        <label htmlFor="ctPhone">Mobile<input type="text" id="ctPhone" maxLength={40} value={f.phone} onChange={set('phone')} /></label>
        <label htmlFor="ctCh">Critical alerts by<select id="ctCh" value={f.alertChannels} onChange={set('alertChannels')}><option>Email, SMS</option><option>Email</option><option>SMS, Phone call</option></select></label>
        <button className="btn" type="submit" id="ctAdd" disabled={busy}>Add contact</button>
      </form>}
      <Msg m={msg} />
    </section>
  </>;
}

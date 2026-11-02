import React, { useState } from 'react';
import { api } from '../api';
import { useApi, Panel, Pill, Table, Loading, ErrorBox, Chips, Msg, useAction, fmt, Sev } from '../ui';
import type { ViewProps } from '../App';

const IST: Record<string, [string, string]> = { ok: ['p-closed', 'Connected'], warn: ['p-rem', 'Attention'], error: ['p-esc', 'Error'], unknown: ['p-off', 'Not tested'] };
const permCell = (v: string) => <Pill c={v === 'No' || v === 'No access' ? 'p-off' : ['Yes', 'Edit', 'Manage'].includes(v) ? 'p-closed' : 'p-ack'}>{v}</Pill>;

export function Admin({ meta, can }: ViewProps) {
  const full = can('editIntegrations');
  return <>
    {!full && <div className="stale"><div><b>View only.</b> API configuration and user accounts can only be changed by a Full Admin account.</div></div>}
    <Integrations full={full} />
    {can('manageUsers') && <Users meta={meta} />}
    {can('manageTenants') && <Tenants />}
    {can('editSla') && <Sla meta={meta} />}
    <Permissions />
  </>;
}

function Integrations({ full }: { full: boolean }) {
  const { data, error, loading, reload } = useApi<any>('/api/admin/integrations');
  const { msg, busy, run, setMsg } = useAction();
  const [edit, setEdit] = useState<string | null>(null);
  const [form, setForm] = useState({ endpoint: '', secret: '', settings: '' });
  const [testTo, setTestTo] = useState<Record<string, string>>({});
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;
  const items = data.items;
  const healthy = items.filter((i: any) => i.enabled && i.status === 'ok').length;
  const startEdit = (i: any) => { setEdit(edit === i.id ? null : i.id); setForm({ endpoint: i.endpoint, secret: '', settings: JSON.stringify(i.settings ?? {}, null, 2) }); setMsg(null); };
  const save = (i: any) => (e: React.FormEvent) => {
    e.preventDefault();
    let settings: any;
    try { settings = JSON.parse(form.settings || '{}'); } catch { setMsg({ text: 'Settings must be valid JSON.', err: true }); return; }
    run(() => api('PUT', `/api/admin/integrations/${encodeURIComponent(i.id)}`, { endpoint: form.endpoint, settings, ...(form.secret ? { secret: form.secret } : {}) }),
      (r: any) => r.changed.length ? `Saved ${i.name}: ${r.changed.join(', ')} updated.` : 'No changes to save.', () => { setEdit(null); reload(); });
  };
  return <Panel title="API configuration" src={`${healthy} of ${items.length} connections healthy`}>
    <Table head={<><th>Connection</th><th>Endpoint</th><th>Authentication</th><th>Status</th><th>Last success</th></>}>
      {items.map((i: any) => { const st = i.enabled ? IST[i.status] : ['p-off', 'Disabled']; const needsTo = i.id === 'smtp' || i.id === 'sms'; return <React.Fragment key={i.id}>
        <tr><td><b>{i.name}</b><div className="note">{i.kind}</div>
          {full && <div className="apiact rowact">
            {needsTo && <input type="text" aria-label={`Send ${i.name} test to`} placeholder={i.id === 'smtp' ? 'test@example.com' : '+60…'} style={{ width: 140 }} value={testTo[i.id] ?? ''} onChange={e => setTestTo({ ...testTo, [i.id]: e.target.value })} />}
            <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api('POST', `/api/admin/integrations/${encodeURIComponent(i.id)}/test`, needsTo ? { to: testTo[i.id] } : {}), (r: any) => r.message, reload)}>Test</button>
            <button className="btn sm ghost" onClick={() => startEdit(i)}>Edit</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api('PUT', `/api/admin/integrations/${encodeURIComponent(i.id)}`, { enabled: !i.enabled }), `${i.name} ${i.enabled ? 'disabled' : 'enabled'}.`, reload)}>{i.enabled ? 'Disable' : 'Enable'}</button>
          </div>}</td>
          <td className="wrap-t mono">{i.endpoint || <span className="note">Not set</span>}</td>
          <td>{i.authLabel}<div className="note mono">{i.hasSecret ? (full ? `••••••••${i.secretLast4 ?? ''}` : 'Set (hidden)') : 'Not set'}</div></td>
          <td><Pill c={st[0]}>{st[1]}</Pill>{i.statusNote && <div className="note" style={{ whiteSpace: 'normal', maxWidth: 260 }}>{i.statusNote}</div>}</td>
          <td className="mono">{fmt(i.lastSuccessAt)}</td></tr>
        {full && edit === i.id && <tr className="editrow"><td colSpan={5}>
          <form className="upf" onSubmit={save(i)} noValidate>
            <label htmlFor="apiUrl">Endpoint URL<input type="text" id="apiUrl" value={form.endpoint} onChange={e => setForm({ ...form, endpoint: e.target.value })} placeholder={i.id === 'smtp' ? 'smtp://relay.example.com:587' : 'https://'} /></label>
            <label htmlFor="apiSecret">New {i.authLabel.toLowerCase()}<input type="password" id="apiSecret" autoComplete="off" placeholder={i.hasSecret ? 'Leave blank to keep current' : 'Enter secret'} value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} /></label>
          </form>
          <label htmlFor="apiSettings" className="nk" style={{ display: 'block', margin: '10px 0 4px' }}>Settings (JSON)</label>
          <textarea id="apiSettings" className="json" value={form.settings} onChange={e => setForm({ ...form, settings: e.target.value })} />
          <div className="actions" style={{ marginTop: 8 }}><button className="btn sm" disabled={busy} onClick={save(i)} id="apiSave">Save changes</button><button className="btn sm ghost" onClick={() => setEdit(null)}>Cancel</button></div>
          <p className="note">Secrets are write-only: they are encrypted at rest and never shown again. The integration guide describes the settings for each connection.</p>
        </td></tr>}
      </React.Fragment>; })}
    </Table>
    <Msg m={msg} />
  </Panel>;
}

function Users({ meta }: { meta: ViewProps['meta'] }) {
  const { data, error, loading, reload } = useApi<any>('/api/admin/users');
  const { msg, busy, run } = useAction();
  const [filter, setFilter] = useState('staff');
  const [temp, setTemp] = useState<{ who: string; pw: string } | null>(null);
  const [nu, setNu] = useState({ name: '', email: '', role: 'analyst', tenantId: '' });
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;
  const rows = data.items.filter((u: any) => filter === 'all' || (filter === 'staff' ? u.role !== 'customer' : u.role === 'customer'));
  const showTemp = (who: string) => (r: any) => { setTemp({ who, pw: r.temporaryPassword }); return `Temporary password created for ${who}. Share it securely; it must be changed at first sign-in.`; };
  const create = (e: React.FormEvent) => { e.preventDefault(); run(() => api('POST', '/api/admin/users', { ...nu, tenantId: nu.role === 'customer' ? nu.tenantId : undefined }), showTemp(nu.name), () => { setNu({ ...nu, name: '', email: '' }); reload(); }); };
  return <section className="panel">
    <div className="filters"><h3>User accounts</h3><Chips idPrefix="ac" value={filter} options={[['staff', 'CySOC staff'], ['customer', 'Customer accounts'], ['all', 'All']]} onChange={setFilter} /></div>
    <Table head={<><th>Account</th><th>Account type</th><th>Access</th><th>MFA</th><th>Last sign-in</th><th>Status</th><th></th></>}>
      {rows.map((u: any) => { const me = u.id === meta.user.id; return <tr key={u.id}>
        <td><b>{u.name}</b><div className="note">{u.email}</div></td>
        <td>{u.role === 'customer' ? <Pill c="p-ack">Customer</Pill> : me ? <Pill c="p-pink">{u.role === 'admin' ? 'Full Admin' : 'Analyst'}</Pill> :
          <select aria-label={`Account type for ${u.name}`} value={u.role} disabled={busy} onChange={e => run(() => api('PATCH', `/api/admin/users/${u.id}`, { role: e.target.value }), `${u.name} is now ${e.target.value === 'admin' ? 'a Full Admin' : 'an Analyst'}.`, reload)}><option value="admin">Full Admin</option><option value="analyst">Analyst</option></select>}</td>
        <td>{u.tenant_name ?? 'All tenants'}</td>
        <td>{u.mfa_enabled ? <Pill c="p-closed">Enrolled</Pill> : <Pill c="p-rem">Not yet</Pill>}</td>
        <td className="mono">{fmt(u.last_login_at)}</td>
        <td>{u.locked ? <Pill c="p-esc">Locked</Pill> : <Pill c={u.active ? 'p-closed' : 'p-off'}>{u.active ? 'Active' : 'Disabled'}</Pill>}</td>
        <td>{me ? <span className="note">You</span> : <span className="rowact">
          <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api('PATCH', `/api/admin/users/${u.id}`, { active: !u.active }), `${u.name} ${u.active ? 'disabled' : 'enabled'}.`, reload)}>{u.active ? 'Disable' : 'Enable'}</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api('POST', `/api/admin/users/${u.id}/reset-password`), showTemp(u.name), reload)}>Reset password</button>
          {u.mfa_enabled && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api('POST', `/api/admin/users/${u.id}/reset-mfa`), `${u.name} will set up MFA again at next sign-in.`, reload)}>Reset MFA</button>}
        </span>}</td></tr>; })}
    </Table>
    {temp && <div className="temp-pw" role="status"><b>Temporary password for {temp.who}</b><span className="code" id="temp-pw">{temp.pw}</span><span className="note">Shown once. Send it through a separate channel from the email address. <button className="btn sm ghost" onClick={() => setTemp(null)}>Hide</button></span></div>}
    <h3 style={{ marginTop: 6 }}>Create an account</h3>
    <form className="upf" onSubmit={create} noValidate>
      <label htmlFor="nuName">Name<input type="text" id="nuName" maxLength={120} value={nu.name} onChange={e => setNu({ ...nu, name: e.target.value })} /></label>
      <label htmlFor="nuEmail">Email<input type="email" id="nuEmail" maxLength={200} value={nu.email} onChange={e => setNu({ ...nu, email: e.target.value })} /></label>
      <label htmlFor="nuRole">Account type<select id="nuRole" value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}><option value="analyst">Analyst</option><option value="admin">Full Admin</option><option value="customer">Customer</option></select></label>
      {nu.role === 'customer' && <label htmlFor="nuTenant">Customer<select id="nuTenant" value={nu.tenantId} onChange={e => setNu({ ...nu, tenantId: e.target.value })}><option value="">Choose customer</option>{meta.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
      <button className="btn" type="submit" id="nuCreate" disabled={busy}>Create account</button>
    </form>
    <Msg m={msg} />
  </section>;
}

const parseSources = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ name: l.replace(/\s*\(pending\)\s*$/i, ''), onboarded: !/\(pending\)\s*$/i.test(l) }));
function Tenants() {
  const { data, error, loading, reload } = useApi<any>('/api/admin/tenants');
  const { msg, busy, run } = useAction();
  const blank = { id: '', code: '', name: '', service: 'TSAM', siem: 'QRadar', licensedEps: '', licensedAssets: '', services: '', renewalDate: '', sources: '' };
  const [f, setF] = useState<typeof blank | null>(null);
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;
  const open = (t?: any) => setF(t ? { id: t.id, code: t.code, name: t.name, service: t.service, siem: t.siem, licensedEps: t.licensed_eps ?? '', licensedAssets: t.licensed_assets ?? '', services: t.services.join('\n'), renewalDate: t.renewal_date ? String(t.renewal_date).slice(0, 10) : '', sources: t.log_sources.map((s: any) => s.name + (s.onboarded ? '' : ' (pending)')).join('\n') } : blank);
  const save = (e: React.FormEvent) => {
    e.preventDefault(); if (!f) return;
    const body = { code: f.code, name: f.name, service: f.service, siem: f.siem, licensedEps: f.licensedEps, licensedAssets: f.licensedAssets, services: f.services.split('\n').map(s => s.trim()).filter(Boolean), renewalDate: f.renewalDate, logSources: parseSources(f.sources) };
    run(() => api(f.id ? 'PUT' : 'POST', f.id ? `/api/admin/tenants/${f.id}` : '/api/admin/tenants', body), `${f.name} saved.${f.id ? '' : ' Add its Grafana connection under API configuration. Sign out and in again to see it in tenant lists.'}`, () => { setF(null); reload(); });
  };
  const set = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f!, [k]: e.target.value });
  return <Panel title="Tenants" right={<button className="btn sm" onClick={() => open()} id="tnNew">Add tenant</button>}>
    <Table head={<><th>Tenant</th><th>Code (NTS)</th><th>Service</th><th>Licence</th><th>Renewal</th><th></th></>}>
      {data.items.map((t: any) => <tr key={t.id}><td><b>{t.name}</b></td><td className="mono">{t.code}</td><td>{t.service} · {t.siem}</td><td>{t.licensed_eps ? `${t.licensed_eps} EPS` : t.licensed_assets ? `${t.licensed_assets} assets` : '—'}</td><td>{t.renewal_date ? String(t.renewal_date).slice(0, 10) : '—'}</td><td><button className="btn sm ghost" onClick={() => open(t)}>Edit</button></td></tr>)}
    </Table>
    {f && <form className="upf" onSubmit={save} noValidate style={{ borderTop: '1px solid var(--g2)', paddingTop: 12 }}>
      <label htmlFor="tnName">Name<input type="text" id="tnName" value={f.name} onChange={set('name')} /></label>
      <label htmlFor="tnCode">Code used in NTS<input type="text" id="tnCode" value={f.code} onChange={set('code')} placeholder="e.g. seri" /></label>
      <label htmlFor="tnService">Service<input type="text" id="tnService" value={f.service} onChange={set('service')} /></label>
      <label htmlFor="tnSiem">SIEM<select id="tnSiem" value={f.siem} onChange={set('siem')}><option>QRadar</option><option>Antarex</option></select></label>
      <label htmlFor="tnEps">Licensed EPS<input type="number" id="tnEps" min={0} value={f.licensedEps} onChange={set('licensedEps')} /></label>
      <label htmlFor="tnAssets">Licensed assets<input type="number" id="tnAssets" min={0} value={f.licensedAssets} onChange={set('licensedAssets')} /></label>
      <label htmlFor="tnRenew">Renewal date<input type="date" id="tnRenew" value={f.renewalDate} onChange={set('renewalDate')} /></label>
      <label htmlFor="tnServices" className="span-wide">Subscribed services, one per line<textarea id="tnServices" rows={3} value={f.services} onChange={set('services')} /></label>
      <label htmlFor="tnSources" className="span-wide">Contracted log sources, one per line. Add (pending) to any not yet onboarded.<textarea id="tnSources" rows={4} value={f.sources} onChange={set('sources')} /></label>
      <span className="rowact"><button className="btn" type="submit" disabled={busy} id="tnSave">Save tenant</button><button className="btn ghost" type="button" onClick={() => setF(null)}>Cancel</button></span>
    </form>}
    <Msg m={msg} />
  </Panel>;
}

function Sla({ meta }: { meta: ViewProps['meta'] }) {
  const [rows, setRows] = useState(meta.sla.map(s => ({ severity: s.severity, escalateMinutes: String(s.escalate_minutes), ackHours: String(s.ack_hours) })));
  const { msg, busy, run } = useAction();
  return <Panel title="SLA targets" src="Used by the scorecard, escalation register and customer health">
    <Table head={<><th>Severity</th><th>CySOC notifies within (minutes)</th><th>Customer acknowledges within (hours)</th></>}>
      {rows.map((r, i) => <tr key={r.severity}><td><Sev s={r.severity} /></td>
        <td><input type="number" min={1} aria-label={`${r.severity} escalate minutes`} value={r.escalateMinutes} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, escalateMinutes: e.target.value } : x))} style={{ maxWidth: 140 }} /></td>
        <td><input type="number" min={1} aria-label={`${r.severity} acknowledge hours`} value={r.ackHours} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, ackHours: e.target.value } : x))} style={{ maxWidth: 140 }} /></td></tr>)}
    </Table>
    <div className="actions"><button className="btn" disabled={busy} id="slaSave" onClick={() => run(() => api('PUT', '/api/admin/sla', { targets: rows }), 'SLA targets saved. Reload the page to apply them everywhere.')}>Save targets</button></div>
    <Msg m={msg} />
  </Panel>;
}

function Permissions() {
  const { data } = useApi<any>('/api/admin/integrations');
  if (!data) return null;
  return <Panel title="Permissions by account type">
    <Table head={<><th>Capability</th><th>Full Admin</th><th>Analyst</th><th>Customer</th></>}>
      {data.permissions.map((p: any) => <tr key={p.capability}><td><b>{p.capability}</b></td><td>{permCell(p.admin)}</td><td>{permCell(p.analyst)}</td><td>{permCell(p.customer)}</td></tr>)}
    </Table>
  </Panel>;
}

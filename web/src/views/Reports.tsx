import React, { useRef, useState } from 'react';
import { api, uploadFile } from '../api';
import { useApi, Panel, Pill, Table, Loading, ErrorBox, Chips, Msg, useAction, fmt, sz } from '../ui';
import type { ViewProps } from '../App';

export function Reports({ meta, scope, can }: ViewProps) {
  const staff = meta.user.role !== 'customer';
  const q = staff && scope !== 'all' ? `?tenant=${scope}` : '';
  const { data, error, loading, reload } = useApi<any>(`/api/reports${q}`, [scope]);
  const [type, setType] = useState('all');
  const [confirm, setConfirm] = useState<string | null>(null);
  const { msg, busy, run, setMsg } = useAction();
  const up = useAction();
  const [form, setForm] = useState({ tenant: scope !== 'all' ? scope : '', type: meta.reportTypes[0], period: '', notify: true });
  const fileRef = useRef<HTMLInputElement>(null);
  if (error) return <ErrorBox msg={error} />;
  if (loading && !data) return <Loading />;
  const items = data.items.filter((r: any) => type === 'all' || r.type === type);
  const types: [string, string][] = [['all', 'All types'], ...meta.reportTypes.filter(t => data.items.some((r: any) => r.type === t)).map(t => [t, t] as [string, string])];
  const multi = staff && scope === 'all';
  const upload = (e: React.FormEvent) => {
    e.preventDefault();
    const f = fileRef.current?.files?.[0];
    const missing = [!form.tenant && 'a customer', !form.period.trim() && 'the period', !f && 'a file'].filter(Boolean);
    if (missing.length) { up.setMsg({ text: `Add ${missing.join(', ')} before uploading.`, err: true }); return; }
    const qs = new URLSearchParams({ tenant: form.tenant, type: form.type, period: form.period, filename: f!.name, notify: form.notify ? '1' : '0' });
    up.run(() => uploadFile(`/api/reports/upload?${qs}`, f!), `Uploaded to ${meta.tenants.find(t => t.id === form.tenant)?.name}.${form.notify ? ' Their report contacts will be emailed.' : ''}`, () => { if (fileRef.current) fileRef.current.value = ''; setForm({ ...form, period: '' }); reload(); });
  };
  const download = (r: any) => {
    const a = document.createElement('a'); a.href = `/api/reports/${r.id}/download`; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    setMsg({ text: staff ? `Downloading ${r.filename}.` : `Downloading ${r.filename}. The download is recorded.` });
    setTimeout(reload, 1500);
  };
  return <>
    {can('uploadReports') && <Panel title="Upload report for a customer">
      <form className="upf" onSubmit={upload} noValidate>
        <label htmlFor="upTenant">Customer<select id="upTenant" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })}><option value="">Choose customer</option>{meta.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label htmlFor="upType">Report type<select id="upType" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>{meta.reportTypes.map(t => <option key={t}>{t}</option>)}</select></label>
        <label htmlFor="upPeriod">Period<input type="text" id="upPeriod" maxLength={40} placeholder="e.g. Oct 2026" value={form.period} onChange={e => setForm({ ...form, period: e.target.value })} /></label>
        <label htmlFor="upFile">File (PDF, DOCX, XLSX, ZIP, CSV)<input type="file" id="upFile" ref={fileRef} accept=".pdf,.docx,.xlsx,.zip,.csv" /></label>
        <label className="chk" htmlFor="upNotify"><input type="checkbox" id="upNotify" checked={form.notify} onChange={e => setForm({ ...form, notify: e.target.checked })} /> Email the customer's report contacts</label>
        <button className="btn" type="submit" id="upBtn" disabled={up.busy}>{up.busy ? 'Uploading…' : 'Upload report'}</button>
      </form>
      <Msg m={up.msg} />
    </Panel>}
    <section className="panel">
      <div className="filters"><h3>Shared reports</h3><Chips idPrefix="rt" value={type} options={types} onChange={setType} /></div>
      <Table head={<><th>Report</th>{multi && <th>Customer</th>}<th>Type</th><th>Period</th><th>Uploaded</th><th className="num">Size</th><th>{staff ? 'Customer downloads' : 'Downloaded'}</th><th></th></>}>
        {items.length ? items.map((r: any) => <tr key={r.id}>
          <td className="fname"><span>{r.title}</span><span className="ext">{r.filename.split('.').pop()}</span></td>{multi && <td>{r.tenant_name}</td>}
          <td>{r.type}</td><td>{r.period}</td><td className="mono">{fmt(r.uploaded_at)}</td><td className="num mono">{sz(r.size_bytes)}</td>
          <td className="mono">{staff ? (r.customer_downloads ? `${r.customer_downloads}× · last ${fmt(r.last_customer_download)}` : <span className="note">Not yet</span>) : (r.my_last_download ? `Last ${fmt(r.my_last_download)}` : <Pill c="p-new">New</Pill>)}</td>
          <td><span className="rowact">
            <button className={'btn sm' + (staff ? ' ghost' : '')} onClick={() => download(r)}>Download</button>
            {can('withdrawReports') && (confirm === r.id
              ? <button className="btn sm danger" disabled={busy} onClick={() => run(() => api('POST', `/api/reports/${r.id}/withdraw`), `Withdrawn. ${r.tenant_name} can no longer see this report.`, () => { setConfirm(null); reload(); })}>Confirm withdraw</button>
              : <button className="btn sm ghost" onClick={() => setConfirm(r.id)}>Withdraw</button>)}
          </span></td>
        </tr>) : <tr><td colSpan={8} className="note">No reports shared yet. CySOC uploads monthly and incident reports here.</td></tr>}
      </Table>
      <Msg m={msg} />
    </section>
  </>;
}

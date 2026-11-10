import React, { useState } from 'react';
import { useApi, Kpi, Kpis, Table, Loading, ErrorBox, fmtD } from '../ui';
import type { ViewProps } from '../App';

export const CatPills = ({ cats }: { cats: string[] }) =>
  <span className="pills">{cats.length ? cats.map(c => <span key={c} className="pillk cat">{c}</span>) : <span className="note">No category</span>}</span>;

/** Staff landing page: choose a category, see its customers, click one to open its workspace. */
export function Customers({ meta, category, setCategory, openCustomer }: ViewProps & { category: string; setCategory: (c: string) => void; openCustomer: (id: string) => void }) {
  const { data, error, loading } = useApi<any>(`/api/customers?category=${encodeURIComponent(category)}`, [category]);
  const [q, setQ] = useState('');
  const cat = meta.categories.find(c => c.code === category);
  const head = <div className="filters">
    <div className="who"><label htmlFor="catSel">Customer category</label>
      <select id="catSel" value={category} onChange={e => setCategory(e.target.value)}>
        <option value="all">All categories{data ? ` (${data.total})` : ''}</option>
        {meta.categories.map(c => <option key={c.code} value={c.code}>{c.code} · {c.name}{data ? ` (${data.counts[c.code] ?? 0})` : ''}</option>)}
      </select></div>
    <div className="who"><label htmlFor="custSearch">Find</label><input id="custSearch" type="text" placeholder="Customer name" value={q} onChange={e => setQ(e.target.value)} style={{ width: 220 }} /></div>
  </div>;
  if (error) return <>{head}<ErrorBox msg={error} /></>;
  if (loading && !data) return <>{head}<Loading /></>;
  const items = data.items.filter((c: any) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  const sum = (k: string) => data.items.reduce((a: number, c: any) => a + c[k], 0);
  return <>
    {head}
    <Kpis n={4}>
      <Kpi k={cat ? `${cat.code} customers` : 'Customers'} v={data.items.length} s={cat ? cat.name : 'Across all categories'} />
      <Kpi k="Open escalations" v={sum('open')} s={`${sum('triage')} in CySOC triage`} />
      <Kpi k="Awaiting customer ack" v={sum('awaiting')} s={`${sum('overdue')} past SLA`} warn={sum('overdue') > 0} />
      <Kpi k="Open requests" v={sum('open_requests')} s="Submitted or in progress" />
    </Kpis>
    <section className="panel">
      <div className="ph"><h3>{cat ? `${cat.code} · ${cat.name}` : 'All customers'}</h3><span className="src">Click a customer to open its tickets, dashboard, reports and service details</span></div>
      <Table head={<><th>Customer</th><th>Categories</th><th>SIEM</th><th className="num">Open</th><th className="num">In triage</th><th className="num">Awaiting ack</th><th className="num">Overdue ack</th><th className="num">Open requests</th><th>Last report</th><th>Renewal</th></>}>
        {items.length ? items.map((c: any) => <tr key={c.id} className="click" tabIndex={0} data-cust={c.code} onClick={() => openCustomer(c.id)} onKeyDown={e => e.key === 'Enter' && openCustomer(c.id)}>
          <td><b>{c.name}</b><div className="note">{c.service}</div></td><td className="wrap-t"><CatPills cats={c.categories} /></td><td>{c.siem}</td>
          <td className="num">{c.open}</td><td className="num">{c.triage}</td><td className="num">{c.awaiting}</td>
          <td className={'num' + (c.overdue ? ' breach' : '')}>{c.overdue}</td><td className="num">{c.open_requests}</td>
          <td>{c.last_report ? fmtD(c.last_report) : <span className="note">None yet</span>}</td><td>{c.renewal_date ? fmtD(c.renewal_date) : '—'}</td></tr>)
          : <tr><td colSpan={10} className="note">{q ? 'No customer matches that name.' : cat ? `No customers in ${cat.code} yet. Add the category to a customer under Administration > Tenants.` : 'No customers yet. Add them under Administration > Tenants.'}</td></tr>}
      </Table>
    </section>
  </>;
}


import React, { useState } from 'react';
import { useApi, Pill, Table, Loading, ErrorBox, Chips, fmt } from '../ui';
import type { ViewProps } from '../App';

const GROUPS: [string, string][] = [['all', 'All activity'], ['signin', 'Sign-ins'], ['esc', 'Escalations'], ['rep', 'Reports'], ['chg', 'Requests and changes']];

export function Audit({ meta, scope }: ViewProps) {
  const staff = meta.user.role !== 'customer';
  const [group, setGroup] = useState('all');
  const t = staff && scope !== 'all' ? `&tenant=${scope}` : '';
  const { data, error, loading } = useApi<any>(`/api/audit?group=${group}${t}`, [group, scope]);
  const multi = staff && scope === 'all';
  return <section className="panel">
    <div className="filters"><h3>Audit log</h3><Chips idPrefix="au" value={group} options={GROUPS} onChange={setGroup} /></div>
    <p className="note">Every sign-in, download and change is recorded with the person and time. Records cannot be edited or deleted{staff ? ', and are also forwarded to the SIEM' : ''}. All sign-ins require MFA.</p>
    {error ? <ErrorBox msg={error} /> : loading && !data ? <Loading /> :
      <Table head={<><th>Time</th><th>User</th><th>Side</th>{multi && <th>Tenant</th>}<th>Action</th><th>Details</th>{staff && <th>IP</th>}</>}>
        {data.items.length ? data.items.map((a: any) => <tr key={a.id}><td className="mono">{fmt(a.at)}</td><td>{a.actor_name}</td>
          <td><Pill c={a.side === 'CySOC' ? 'p-pink' : a.side === 'Customer' ? 'p-ack' : 'p-off'}>{a.side}</Pill></td>
          {multi && <td>{a.tenant_name ?? 'Platform'}</td>}<td><b>{a.action}</b></td><td className="wrap-t">{a.details}</td>{staff && <td className="mono">{a.ip ?? ''}</td>}</tr>)
          : <tr><td colSpan={7} className="note">No activity matches this filter.</td></tr>}
      </Table>}
    {data?.items.length === 300 && <p className="note">Showing the latest 300 entries.</p>}
  </section>;
}

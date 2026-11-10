import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { qrSvg } from './qr';
import { Msg } from './ui';
import { Escalations } from './views/Escalations';
import { Dashboard } from './views/Dashboard';
import { Scorecard } from './views/Scorecard';
import { Requests } from './views/Requests';
import { Reports } from './views/Reports';
import { Service } from './views/Service';
import { Audit } from './views/Audit';
import { Health } from './views/Health';
import { Admin } from './views/Admin';
import { Customers, CatPills } from './views/Customers';

export interface Meta {
  user: { id: string; name: string; email: string; role: 'admin' | 'analyst' | 'customer'; tenantId: string | null; tenantName: string | null };
  permissions: string[];
  tenants: { id: string; code: string; name: string; service: string; siem: string; categories: string[] }[];
  categories: { code: string; name: string }[];
  sla: { severity: string; escalate_minutes: number; ack_hours: number }[];
  requestTypes: Record<string, number>;
  reportTypes: string[];
  integrationMode: 'live' | 'demo';
  mfaRequired: boolean;
}
export interface ViewProps { meta: Meta; scope: string; setScope: (s: string) => void; can: (p: string) => boolean; }

type Stage = 'loading' | 'login' | 'mfa' | 'mfa_setup' | 'change_password' | 'ready';

const Band = ({ right }: { right?: React.ReactNode }) => (
  <div className="band"><div className="band-in"><header className="top">
    <div className="brand"><img src="/time-wordmark-white.png" alt="Time" /><span className="pname">CySOC Customer Portal</span></div>
    {right}
  </header></div></div>
);

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="auth"><Band /><main><div className="auth-card"><h1>{title}</h1>{children}</div></main>
    <footer className="foot"><span className="tm">Time</span><p>CySOC 24x7 Security Operations Centre. Access is monitored and recorded.</p></footer></div>;
}

function Login({ next }: { next: (s: Stage) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { const r = await api('POST', '/api/auth/login', { email, password }); next(r.stage); }
    catch (err: any) { setMsg({ text: err.message, err: true }); setBusy(false); }
  };
  return <AuthShell title="Sign in">
    <form onSubmit={submit} noValidate>
      <label htmlFor="email">Email<input id="email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>
      <label htmlFor="password">Password<input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <button className="btn" type="submit" id="signin" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <Msg m={msg} />
    </form>
    <p className="note">You will be asked for a code from your authenticator app next. Forgotten your password? Ask your CySOC account contact to reset it.</p>
  </AuthShell>;
}

function CodeForm({ next, label = 'Verify' }: { next: (s: Stage) => void; label?: string }) {
  const [code, setCode] = useState(''); const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { const r = await api('POST', '/api/auth/mfa/verify', { code }); next(r.stage); }
    catch (err: any) { setMsg({ text: err.message, err: true }); setBusy(false); if (err.status === 423) setTimeout(() => next('login'), 2500); }
  };
  return <form onSubmit={submit} noValidate>
    <label htmlFor="code">6-digit code<input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={e => setCode(e.target.value)} /></label>
    <button className="btn" type="submit" id="verify" disabled={busy}>{busy ? 'Checking…' : label}</button>
    <Msg m={msg} />
  </form>;
}

function MfaSetup({ next }: { next: (s: Stage) => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('POST', '/api/auth/mfa/setup', {}).then(setSetup).catch(e => setError(e.message)); }, []);
  return <AuthShell title="Set up your authenticator">
    <p>Every sign-in needs a code from an authenticator app such as Microsoft Authenticator or Google Authenticator.</p>
    {error && <Msg m={{ text: error, err: true }} />}
    {setup && <>
      <ol className="plainsteps"><li>Open the app and choose to add an account.</li><li>Scan this code, or enter the key below.</li><li>Type the 6-digit code the app shows.</li></ol>
      <div className="qr" dangerouslySetInnerHTML={{ __html: qrSvg(setup.uri, 4, 4) }} aria-label="QR code for your authenticator app" role="img" />
      <div><div className="note">Key for manual entry</div><div className="code" id="mfa-secret">{setup.secret}</div></div>
      <CodeForm next={next} label="Turn on and continue" />
    </>}
  </AuthShell>;
}

function ChangePassword({ next }: { next: (s: Stage) => void }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(null);
    if (f.next !== f.confirm) { setMsg({ text: 'The new passwords do not match.', err: true }); return; }
    setBusy(true);
    try { const r = await api('POST', '/api/auth/password', { current: f.current, next: f.next }); next(r.stage); }
    catch (err: any) { setMsg({ text: err.message, err: true }); setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return <AuthShell title="Choose a new password">
    <p>Your account has a temporary password. Choose your own to continue: at least 12 characters, mixing upper and lower case, numbers or symbols.</p>
    <form onSubmit={submit} noValidate>
      <label htmlFor="pw-current">Temporary password<input id="pw-current" type="password" autoComplete="current-password" value={f.current} onChange={set('current')} /></label>
      <label htmlFor="pw-next">New password<input id="pw-next" type="password" autoComplete="new-password" value={f.next} onChange={set('next')} /></label>
      <label htmlFor="pw-confirm">Repeat new password<input id="pw-confirm" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} /></label>
      <button className="btn" type="submit" id="pw-save" disabled={busy}>Save password</button>
      <Msg m={msg} />
    </form>
  </AuthShell>;
}

const VIEWS = [
  { id: 'customers', label: 'Customers', perm: 'viewAllTenants' },
  { id: 'escalations', label: 'Escalations', perm: null },
  { id: 'dashboard', label: 'Security dashboard', perm: null },
  { id: 'scorecard', label: 'Scorecard', perm: null },
  { id: 'requests', label: 'Requests', perm: null },
  { id: 'reports', label: 'Reports', perm: 'downloadReports' },
  { id: 'service', label: 'Service and contacts', perm: null },
  { id: 'audit', label: 'Audit log', perm: 'viewAudit' },
  { id: 'health', label: 'Customer health', perm: 'viewHealth' },
  { id: 'admin', label: 'Administration', perm: 'viewIntegrations' },
] as const;
// Tabs inside one customer's workspace.
const WORKSPACE = new Set(['escalations', 'dashboard', 'scorecard', 'requests', 'reports', 'service', 'audit']);
const LABEL_IN_WORKSPACE: Record<string, string> = { escalations: 'Tickets and escalations', service: 'Service and contacts' };

function Portal({ meta, signOut }: { meta: Meta; signOut: () => void }) {
  const can = (p: string) => meta.permissions.includes(p);
  const staff = meta.user.role !== 'customer';
  const [scope, setScopeState] = useState('all');                 // 'all' = overview, otherwise a tenant id
  const [category, setCategory] = useState('all');
  const inWorkspace = staff && scope !== 'all';
  const views = VIEWS.filter(v => (!v.perm || can(v.perm)) && (!inWorkspace || WORKSPACE.has(v.id)));
  const home = staff ? 'customers' : 'escalations';
  const valid = (v: string) => VIEWS.some(x => x.id === v && (!x.perm || can(x.perm)));
  const [view, setView] = useState(() => { const h = location.hash.slice(1); return valid(h) ? h : home; });
  useEffect(() => { const f = () => { const h = location.hash.slice(1); if (valid(h)) setView(h); }; window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const go = (v: string) => { setView(v); if (location.hash.slice(1) !== v) location.hash = v; };
  // Opening a customer keeps the current tab when it exists in the workspace, otherwise shows its tickets.
  const openCustomer = (id: string) => { setScopeState(id); if (id === 'all') go('customers'); else if (!WORKSPACE.has(view)) go('escalations'); window.scrollTo({ top: 0 }); };
  const tenant = meta.tenants.find(t => t.id === (staff ? scope : meta.user.tenantId));
  const inCategory = meta.tenants.filter(t => category === 'all' || t.categories.includes(category));
  const roleLabel = { admin: 'Full Admin', analyst: 'Analyst', customer: 'Customer' }[meta.user.role];
  const shown = views.some(v => v.id === view) ? view : (inWorkspace ? 'escalations' : home);
  const props: ViewProps = { meta, scope: staff ? scope : meta.user.tenantId!, setScope: openCustomer, can };
  const content = useMemo(() => ({
    customers: <Customers {...props} category={category} setCategory={setCategory} openCustomer={openCustomer} />,
    escalations: <Escalations {...props} />, dashboard: <Dashboard {...props} />, scorecard: <Scorecard {...props} />,
    requests: <Requests {...props} />, reports: <Reports {...props} />, service: <Service {...props} />,
    audit: <Audit {...props} />, health: <Health {...props} goService={(id: string) => { setScopeState(id); go('service'); }} />, admin: <Admin {...props} />,
  } as Record<string, React.ReactNode>)[shown], [shown, scope, category, meta]);

  return <>
    <Band right={<div className="who">
      <span className="uname">{meta.user.name}</span>
      <span className={'role ' + (meta.user.role === 'admin' ? 'admin' : meta.user.role === 'analyst' ? 'analyst' : 'cust')} id="roleBadge">{roleLabel}</span>
      <button className="signout" id="signout" onClick={signOut}>Sign out</button>
    </div>} />
    <div className="wrap">
      {!meta.mfaRequired && staff && <div className="stale" role="alert"><div><b>MFA is turned off.</b> Accounts sign in with a password only. Set MFA_REQUIRED=true in .env before customers get access.</div></div>}
      {meta.integrationMode === 'demo' && <div className="banner">Demo mode: dashboards show generated sample data and no email, SMS or NTS calls are made.</div>}
      {inWorkspace && <div className="crumbs">
        <button className="btn sm ghost" id="backToCustomers" onClick={() => openCustomer('all')}>← {category === 'all' ? 'All customers' : `${category} customers`}</button>
        <div className="who"><label htmlFor="custSwitch">Switch customer</label>
          <select id="custSwitch" value={scope} onChange={e => openCustomer(e.target.value)}>
            {(inCategory.some(t => t.id === scope) ? inCategory : meta.tenants).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></div>
      </div>}
      <div className="scope">
        <h2 id="scopeTitle">{staff ? (inWorkspace ? tenant?.name ?? 'Customer' : 'All customers') : meta.user.tenantName}</h2>
        <span className="meta">{tenant ? `${tenant.service} · ${tenant.siem}` : `${meta.tenants.length} customers`}</span>
        {tenant && <CatPills cats={tenant.categories} />}
      </div>
      <nav className="tabs" id="tabs" role="tablist" aria-label="Portal sections">
        {views.map(v => <button key={v.id} className="tab" role="tab" id={'tab-' + v.id} aria-selected={v.id === shown} onClick={() => go(v.id)}>{v.id === 'service' && !staff ? 'My service' : inWorkspace ? (LABEL_IN_WORKSPACE[v.id] ?? v.label) : v.label}</button>)}
      </nav>
      <div className="view" key={shown + scope}>{content}</div>
    </div>
    <footer className="foot"><span className="tm">Time</span><p>CySOC 24x7 Security Operations Centre. Escalation data syncs with NTS; dashboards query each tenant's Grafana; every sign-in, download and change is recorded in the audit log.</p></footer>
  </>;
}

export function App() {
  const [stage, setStage] = useState<Stage>('loading');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');
  const check = () => api('GET', '/api/auth/me').then(r => setStage(r.stage)).catch(e => setError(e.message));
  useEffect(() => { check(); const f = () => { setMeta(null); check(); }; window.addEventListener('cysoc:auth', f); return () => window.removeEventListener('cysoc:auth', f); }, []);
  useEffect(() => { if (stage === 'ready' && !meta) api<Meta>('GET', '/api/meta').then(setMeta).catch(e => setError(e.message)); }, [stage]);
  const signOut = async () => { await api('POST', '/api/auth/logout').catch(() => {}); setMeta(null); location.hash = ''; setStage('login'); };
  if (error) return <AuthShell title="Something went wrong"><Msg m={{ text: error + ' Refresh the page to try again.', err: true }} /></AuthShell>;
  if (stage === 'loading' || (stage === 'ready' && !meta)) return <div className="loading" style={{ padding: 40 }}>Loading…</div>;
  if (stage === 'login') return <Login next={setStage} />;
  if (stage === 'mfa_setup') return <MfaSetup next={setStage} />;
  if (stage === 'mfa') return <AuthShell title="Enter your code"><p>Open your authenticator app and enter the current code for CySOC Portal.</p><CodeForm next={setStage} /></AuthShell>;
  if (stage === 'change_password') return <ChangePassword next={setStage} />;
  return <Portal meta={meta!} signOut={signOut} />;
}

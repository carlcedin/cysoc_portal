import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

// ---------- Formatting (Malaysia time) ----------
const TZ = 'Asia/Kuala_Lumpur';
export const fmt = (d?: string | number | Date | null) => d ? new Date(d).toLocaleString('en-MY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }) : '—';
export const fmtD = (d?: string | number | Date | null) => d ? new Date(d).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ }) : '—';
export const kfmt = (v: number) => v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? Math.round(v / 1e3) + 'k' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v * 10) / 10);
export const minFmt = (m?: number | null) => m == null ? '—' : m < 60 ? Math.round(m) + ' min' : (m / 60).toFixed(1) + ' h';
export const ago = (ms?: number | null) => { if (ms == null) return 'Never'; const m = (Date.now() - ms) / 60000; return m < 1 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
export const sz = (b: number) => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
export const SEVS = ['Critical', 'High', 'Medium', 'Low'] as const;
export const SEV_VAR: Record<string, string> = { Critical: 'var(--red)', High: 'var(--orange)', Medium: 'var(--yellow)', Low: 'var(--blue-l)' };

// ---------- Data loading ----------
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const n = ++seq.current;
    setState(s => ({ ...s, loading: true, error: null }));
    api<T>('GET', path).then(d => { if (n === seq.current) setState({ data: d, error: null, loading: false }); })
      .catch(e => { if (n === seq.current) setState(s => ({ ...s, error: e.message, loading: false })); });
  }, [path, ...deps]);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

// ---------- Small building blocks ----------
export const Kpi = ({ k, v, s, warn }: { k: string; v: React.ReactNode; s?: React.ReactNode; warn?: boolean }) =>
  <div className={'kpi' + (warn ? ' warn' : '')}><span className="k">{k}</span><span className="v">{v}</span>{s !== undefined && <span className="s">{s}</span>}</div>;
export const Kpis = ({ n = 5, children }: { n?: number; children: React.ReactNode }) => <section className={'kpis' + (n === 3 ? ' kpi3' : n === 4 ? ' kpi4' : '')}>{children}</section>;
export const Panel = ({ title, src, cls = '', children, right }: { title: string; src?: string; cls?: string; children: React.ReactNode; right?: React.ReactNode }) =>
  <section className={'panel ' + cls}><div className="ph"><h3>{title}</h3>{right ?? (src && <span className="src">{src}</span>)}</div>{children}</section>;
export const Pill = ({ c, children }: { c: string; children: React.ReactNode }) => <span className={'pill ' + c}>{children}</span>;
export const Sev = ({ s }: { s: string }) => <span className={'sev ' + s}>{s}</span>;
export const Table = ({ head, children }: { head: React.ReactNode; children: React.ReactNode }) =>
  <div className="tbl"><table><thead><tr>{head}</tr></thead><tbody>{children}</tbody></table></div>;
export const Loading = () => <div className="loading">Loading…</div>;
export const ErrorBox = ({ msg }: { msg: string }) => <div className="err-box" role="alert"><div>{msg}</div></div>;
export const Msg = ({ m }: { m: { text: string; err?: boolean } | null }) => m ? <div className={'toast' + (m.err ? ' err' : '')} role="status">{m.text}</div> : null;

export function Chips<T extends string>({ value, options, onChange, idPrefix }: { value: T; options: [T, string][]; onChange: (v: T) => void; idPrefix: string }) {
  return <div className="chips">{options.map(([k, l]) =>
    <button key={k} id={`${idPrefix}-${k.replace(/\W+/g, '_')}`} className="chip" aria-pressed={value === k} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

export const pctPill = (p: number | null) => p == null ? <span>—</span> : <Pill c={p >= 95 ? 'p-closed' : p >= 85 ? 'p-rem' : 'p-esc'}>{p}%</Pill>;

/** Runs an action, shows its result message, and reloads. */
export function useAction() {
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string | ((r: any) => string), after?: () => void) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ text: typeof ok === 'function' ? ok(r) : ok }); after?.(); }
    catch (e: any) { setMsg({ text: e.message, err: true }); }
    finally { setBusy(false); }
  };
  return { msg, setMsg, busy, run };
}

// ---------- Charts (SVG, drawn to scale) ----------
const nice = (m: number) => { if (m <= 0) return 1; const p = 10 ** Math.floor(Math.log10(m)); const n = m / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
const xl = (t: number, hourly: boolean) => hourly
  ? new Date(t).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ })
  : new Date(t).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', timeZone: TZ });

export function LineChart({ points, refValue, hourly, label }: { points: { t: number; v: number }[]; refValue?: number | null; hourly: boolean; label: string }) {
  if (points.length < 2) return <div className="empty">No data for this period.</div>;
  const W = 640, H = 210, L = 46, R = 12, T = 14, B = 24, iw = W - L - R, ih = H - T - B;
  const mx = nice(Math.max(...points.map(p => p.v), refValue || 0) * 1.08);
  const x = (i: number) => L + (i / (points.length - 1)) * iw, y = (v: number) => T + ih - (v / mx) * ih;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  return <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
    {[0, 1, 2, 3, 4].map(k => { const v = (mx * k) / 4; return <g key={k}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="gl" /><text x={L - 6} y={y(v) + 4} textAnchor="end">{kfmt(v)}</text></g>; })}
    {[0, 1, 2, 3, 4].map(k => { const i = Math.round((k * (points.length - 1)) / 4); return <text key={'x' + k} x={x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}>{xl(points[i].t, hourly)}</text>; })}
    <path d={`${d}L${x(points.length - 1).toFixed(1)},${T + ih}L${L},${T + ih}Z`} className="area" />
    <path d={d} className="line" />
    {refValue ? <><line x1={L} x2={W - R} y1={y(refValue)} y2={y(refValue)} className="ref" /><text x={W - R} y={y(refValue) - 5} textAnchor="end" className="reft">Licensed {kfmt(refValue)} EPS</text></> : null}
    <circle cx={x(points.length - 1)} cy={y(last.v)} r={3.5} className="dot" />
  </svg>;
}

type SevPoint = { t?: number; label?: string } & Record<'Critical' | 'High' | 'Medium' | 'Low', number>;
export function StackBars({ buckets, hourly, label, totals }: { buckets: SevPoint[]; hourly?: boolean; label: string; totals?: boolean }) {
  if (!buckets.length) return <div className="empty">No alerts in this period.</div>;
  const W = 640, H = 210, L = 40, R = 8, T = 16, B = 24, iw = W - L - R, ih = H - T - B;
  const tot = (b: SevPoint) => b.Critical + b.High + b.Medium + b.Low;
  const mx = nice(Math.max(...buckets.map(tot), 1) * 1.08); const y = (v: number) => T + ih - (v / mx) * ih;
  const bw = iw / buckets.length, gap = Math.min(6, bw * 0.28), step = Math.ceil(buckets.length / 7);
  return <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
    {[0, 1, 2, 3, 4].map(k => { const v = (mx * k) / 4; return <g key={k}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="gl" /><text x={L - 6} y={y(v) + 4} textAnchor="end">{kfmt(v)}</text></g>; })}
    {buckets.map((b, i) => {
      let acc = 0; const xx = L + i * bw + gap / 2;
      return <g key={i}>
        {(['Low', 'Medium', 'High', 'Critical'] as const).map(s => { const v = b[s]; if (!v) return null; const y0 = y(acc), y1 = y(acc + v); acc += v; return <rect key={s} x={xx} y={y1} width={Math.max(1, bw - gap)} height={y0 - y1} className={'b-' + s} />; })}
        {totals && <text x={xx + (bw - gap) / 2} y={y(tot(b)) - 5} textAnchor="middle" className="vl">{tot(b)}</text>}
        {i % step === 0 && <text x={xx + (bw - gap) / 2} y={H - 6} textAnchor="middle">{b.label ?? xl(b.t!, !!hourly)}</text>}
      </g>;
    })}
  </svg>;
}

export function PctBars({ items, target }: { items: { label: string; v: number | null }[]; target: number }) {
  const W = 560, H = 200, L = 40, R = 8, T = 18, B = 24, iw = W - L - R, ih = H - T - B, y = (v: number) => T + ih - (v / 100) * ih, bw = iw / items.length, gap = bw * 0.38;
  return <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Escalations within SLA by month">
    {[0, 25, 50, 75, 100].map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="gl" /><text x={L - 6} y={y(v) + 4} textAnchor="end">{v}%</text></g>)}
    {items.map((it, i) => { const xx = L + i * bw + gap / 2, cx = xx + (bw - gap) / 2; return <g key={i}>
      {it.v != null && <rect x={xx} y={y(it.v)} width={bw - gap} height={T + ih - y(it.v)} className={i === items.length - 1 ? 'bar-now' : 'bar-ctx'} />}
      <text x={cx} y={it.v != null ? y(it.v) - 5 : y(0) - 5} textAnchor="middle" className="vl">{it.v != null ? it.v + '%' : '—'}</text>
      <text x={cx} y={H - 6} textAnchor="middle">{it.label}</text></g>; })}
    <line x1={L} x2={W - R} y1={y(target)} y2={y(target)} className="ref" />
  </svg>;
}

export function HBars({ list }: { list: { label: string; value: number }[] }) {
  if (!list.length) return <div className="empty">No data for this period.</div>;
  const m = Math.max(...list.map(x => x.value), 1);
  return <div className="hb">{list.map(x => <div className="hbr" key={x.label}><span>{x.label}</span><span className="hbt"><i style={{ width: `${((x.value / m) * 100).toFixed(1)}%` }} /></span><span className="mono num">{x.value.toLocaleString()}</span></div>)}</div>;
}

export const SevLegend = ({ counts }: { counts?: Record<string, number> }) =>
  <div className="legend">{SEVS.map(s => <span key={s}><i style={{ background: SEV_VAR[s] }} />{s}{counts ? ' ' + counts[s].toLocaleString() : ''}</span>)}</div>;

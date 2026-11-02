// Minimal HTTP toolkit on Node's http module: routing, JSON bodies, cookies, security headers.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') { super(message); }
}
export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const forbidden = (m = 'You do not have access to this.') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found.') => new HttpError(404, m, 'not_found');

export interface Req {
  raw: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  cookies: Record<string, string>;
  ip: string;
  body: () => Promise<any>;
  [k: string]: any;
}
export type Handler = (req: Req) => Promise<unknown> | unknown;

interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; }
const routes: Route[] = [];

export function route(method: string, pattern: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

function parseCookies(h?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res: http.ServerResponse, name: string, value: string, opts: { maxAge?: number; clear?: boolean } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (config.cookieSecure) parts.push('Secure');
  if (opts.clear) parts.push('Max-Age=0');
  else if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), parts.join('; ')]);
}

function securityHeaders(res: http.ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  if (!(req.headers['content-type'] || '').includes('application/json')) throw badRequest('Send JSON.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw badRequest('Invalid JSON.'); }
}

// ---------- Simple fixed-window rate limiter (per process) ----------
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return; }
  if (++b.n > max) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.', 'rate_limited');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

// ---------- Static front end ----------
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(p: string, res: http.ServerResponse): boolean {
  const root = path.resolve(config.webDir);
  let file = path.resolve(root, '.' + decodeURIComponent(p));
  if (!file.startsWith(root)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) return false;
  const ext = path.extname(file);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', ext === '.html' ? 'no-store' : 'public, max-age=3600');
  fs.createReadStream(file).pipe(res);
  return true;
}

export function send(res: http.ServerResponse, status: number, data: unknown) {
  if (res.headersSent) { res.end(); return; }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export function createServer(before: (req: Req) => Promise<void>) {
  return http.createServer(async (raw, res) => {
    securityHeaders(res);
    const url = new URL(raw.url || '/', 'http://local');
    const fwd = config.trustProxy ? String(raw.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const req: Req = {
      raw, res, method: raw.method || 'GET', path: url.pathname, query: url.searchParams, params: {},
      cookies: parseCookies(raw.headers.cookie), ip: fwd || raw.socket.remoteAddress || '',
      body: () => readBody(raw),
    };
    try {
      if (!req.path.startsWith('/api/') && !req.path.startsWith('/ack/')) {
        if (req.method === 'GET' && serveStatic(req.path, res)) return;
        throw notFound();
      }
      // CSRF defence: mutating API calls must carry the custom header and, when present, a matching Origin.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.path.startsWith('/api/')) {
        if (raw.headers['x-cysoc-request'] !== '1') throw forbidden('Missing request header.');
        const origin = raw.headers.origin;
        if (origin && origin !== config.publicUrl) throw forbidden('Cross-site request blocked.');
      }
      const match = routes.find(r => r.method === req.method && r.re.test(req.path));
      if (!match) throw notFound();
      const m = req.path.match(match.re)!;
      match.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
      await before(req);
      const out = await match.handler(req);
      if (!res.writableEnded && !res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (e: any) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message, code: e.code });
      else if (e?.code === '42501' || /row-level security/.test(e?.message || '')) send(res, 403, { error: 'You do not have access to this.', code: 'forbidden' });
      else { console.error('[http]', req.method, req.path, e); send(res, 500, { error: 'Something went wrong. The error has been logged.', code: 'server_error' }); }
    }
  });
}

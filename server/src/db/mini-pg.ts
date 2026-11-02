// A small PostgreSQL client implementing the subset of the `pg` package API this app uses
// (Pool.connect/query/end, client.query/release). Production uses the real `pg` driver; this
// fallback is only loaded when `pg` is not installed (offline development and CI sandboxes).
// Supports trust, cleartext, MD5 and SCRAM-SHA-256 authentication over plain TCP.
import net from 'node:net';
import crypto from 'node:crypto';

type Row = Record<string, unknown>;
export interface QueryResult { rows: Row[]; rowCount: number; }
interface Field { name: string; oid: number; }

function parseUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username),
  };
}

function parseArray(s: string, item: (x: string) => unknown): unknown[] {
  // Handles one-dimensional arrays with quoted elements, as produced by PostgreSQL text output.
  if (s === '{}') return [];
  const out: unknown[] = [];
  let i = 1, cur = '', quoted = false, wasQuoted = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\') { cur += s[++i]; }
      else if (c === '"') { quoted = false; }
      else cur += c;
    } else if (c === '"') { quoted = true; wasQuoted = true; }
    else if (c === ',' || c === '}') {
      out.push(!wasQuoted && cur === 'NULL' ? null : item(cur));
      cur = ''; wasQuoted = false;
    } else cur += c;
  }
  return out;
}

function parseValue(oid: number, s: string): unknown {
  switch (oid) {
    case 16: return s === 't';
    case 21: case 23: case 26: return Number(s);
    case 700: case 701: return Number(s);
    case 114: case 3802: return JSON.parse(s);
    case 1082: { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
    case 1114: return new Date(s.replace(' ', 'T'));
    case 1184: return new Date(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case 1000: return parseArray(s, x => x === 't');
    case 1007: case 1005: return parseArray(s, Number);
    case 1009: case 1015: case 2951: return parseArray(s, x => x);
    default: return s; // int8 and numeric stay strings, matching pg defaults
  }
}

function serialize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (Array.isArray(v)) return '{' + v.map(x => x === null || x === undefined ? 'NULL' : '"' + String(serialize(x)).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export class PgError extends Error {
  code?: string; detail?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M || 'PostgreSQL error');
    this.code = fields.C; this.detail = fields.D;
  }
}

class Connection {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiters: ((m: { type: string; body: Buffer }) => void)[] = [];
  private queue: { type: string; body: Buffer }[] = [];
  private busy: Promise<unknown> = Promise.resolve();
  closed = false;

  async open(opts: ReturnType<typeof parseUrl>) {
    this.sock = net.connect(opts.port, opts.host);
    this.sock.setNoDelay(true);
    await new Promise<void>((res, rej) => { this.sock.once('connect', () => res()); this.sock.once('error', rej); });
    this.sock.on('data', (d: Buffer) => this.onData(d));
    this.sock.on('close', () => { this.closed = true; });
    this.sock.on('error', () => { this.closed = true; });
    const params = Buffer.from(`user\0${opts.user}\0database\0${opts.database}\0client_encoding\0UTF8\0\0`);
    const head = Buffer.alloc(8); head.writeInt32BE(8 + params.length, 0); head.writeInt32BE(196608, 4);
    this.sock.write(Buffer.concat([head, params]));
    await this.authenticate(opts);
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) break;
      const msg = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, 1 + len) };
      this.buf = this.buf.subarray(1 + len);
      const w = this.waiters.shift();
      if (w) w(msg); else this.queue.push(msg);
    }
  }

  private next(): Promise<{ type: string; body: Buffer }> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    return new Promise(res => this.waiters.push(res));
  }

  private send(type: string, body: Buffer) {
    const head = Buffer.alloc(5); head.write(type, 0); head.writeInt32BE(body.length + 4, 1);
    this.sock.write(Buffer.concat([head, body]));
  }

  private static fields(body: Buffer) {
    const f: Record<string, string> = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) {
      const code = String.fromCharCode(body[i]);
      const end = body.indexOf(0, i + 1);
      f[code] = body.toString('utf8', i + 1, end);
      i = end + 1;
    }
    return f;
  }

  private async authenticate(o: ReturnType<typeof parseUrl>) {
    let scram: { nonce: string; clientFirstBare: string; serverSig?: Buffer } | null = null;
    for (;;) {
      const m = await this.next();
      if (m.type === 'E') throw new PgError(Connection.fields(m.body));
      if (m.type === 'R') {
        const code = m.body.readInt32BE(0);
        if (code === 0) continue; // AuthenticationOk
        if (code === 3) { this.send('p', Buffer.from(o.password + '\0')); continue; }
        if (code === 5) {
          const salt = m.body.subarray(4, 8);
          const inner = crypto.createHash('md5').update(o.password + o.user).digest('hex');
          const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
          this.send('p', Buffer.from('md5' + outer + '\0')); continue;
        }
        if (code === 10) {
          const nonce = crypto.randomBytes(18).toString('base64');
          const clientFirstBare = `n=*,r=${nonce}`;
          const data = Buffer.from('n,,' + clientFirstBare);
          const mech = Buffer.from('SCRAM-SHA-256\0');
          const len = Buffer.alloc(4); len.writeInt32BE(data.length, 0);
          this.send('p', Buffer.concat([mech, len, data]));
          scram = { nonce, clientFirstBare }; continue;
        }
        if (code === 11 && scram) {
          const serverFirst = m.body.subarray(4).toString();
          const attrs = Object.fromEntries(serverFirst.split(',').map(p => [p[0], p.slice(2)]));
          if (!attrs.r.startsWith(scram.nonce)) throw new Error('SCRAM nonce mismatch');
          const salted = crypto.pbkdf2Sync(o.password, Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
          const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
          const storedKey = crypto.createHash('sha256').update(clientKey).digest();
          const finalNoProof = `c=biws,r=${attrs.r}`;
          const authMessage = `${scram.clientFirstBare},${serverFirst},${finalNoProof}`;
          const sig = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
          const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
          const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
          scram.serverSig = crypto.createHmac('sha256', serverKey).update(authMessage).digest();
          this.send('p', Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`)); continue;
        }
        if (code === 12 && scram) {
          const v = m.body.subarray(4).toString().replace(/^v=/, '');
          if (!scram.serverSig || !crypto.timingSafeEqual(Buffer.from(v, 'base64'), scram.serverSig)) throw new Error('SCRAM server signature mismatch');
          continue;
        }
        throw new Error(`Unsupported PostgreSQL authentication method ${code}`);
      }
      if (m.type === 'Z') return;
      // S (parameter status), K (backend key) and N (notice) are ignored
    }
  }

  query(text: string, params: unknown[] = []): Promise<QueryResult> {
    const run = this.busy.then(() => this.run(text, params));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async run(text: string, params: unknown[]): Promise<QueryResult> {
    if (params.length === 0) {
      this.send('Q', Buffer.from(text + '\0'));
    } else {
      const parse = Buffer.concat([Buffer.from('\0' + text + '\0'), Buffer.from([0, 0])]);
      const parts: Buffer[] = [Buffer.from('\0\0'), Buffer.from([0, 0])];
      const n = Buffer.alloc(2); n.writeInt16BE(params.length, 0); parts.push(n);
      for (const p of params) {
        const s = serialize(p);
        const l = Buffer.alloc(4);
        if (s === null) { l.writeInt32BE(-1, 0); parts.push(l); }
        else { const b = Buffer.from(s, 'utf8'); l.writeInt32BE(b.length, 0); parts.push(l, b); }
      }
      parts.push(Buffer.from([0, 0]));
      this.send('P', parse);
      this.send('B', Buffer.concat(parts));
      this.send('D', Buffer.from('P\0'));
      this.send('E', Buffer.from('\0\0\0\0\0'));
      this.send('S', Buffer.alloc(0));
    }
    let fields: Field[] = [];
    let rows: Row[] = [];
    let rowCount = 0;
    let error: PgError | null = null;
    for (;;) {
      const m = await this.next();
      switch (m.type) {
        case 'T': {
          const count = m.body.readInt16BE(0); fields = []; rows = [];
          let i = 2;
          for (let k = 0; k < count; k++) {
            const end = m.body.indexOf(0, i);
            const name = m.body.toString('utf8', i, end);
            const oid = m.body.readInt32BE(end + 7);
            fields.push({ name, oid }); i = end + 19;
          }
          break;
        }
        case 'D': {
          const count = m.body.readInt16BE(0); const row: Row = {};
          let i = 2;
          for (let k = 0; k < count; k++) {
            const len = m.body.readInt32BE(i); i += 4;
            if (len === -1) row[fields[k].name] = null;
            else { row[fields[k].name] = parseValue(fields[k].oid, m.body.toString('utf8', i, i + len)); i += len; }
          }
          rows.push(row); break;
        }
        case 'C': {
          const tag = m.body.toString('utf8', 0, m.body.length - 1);
          const last = Number(tag.split(' ').pop());
          rowCount = Number.isFinite(last) ? last : rows.length; break;
        }
        case 'E': error = new PgError(Connection.fields(m.body)); break;
        case 'Z':
          if (error) throw error;
          return { rows, rowCount };
        default: break; // 1, 2, n, I, N, S, s
      }
    }
  }

  end() { try { this.send('X', Buffer.alloc(0)); this.sock.end(); } catch { /* already closed */ } this.closed = true; }
}

export interface PoolClient { query(text: string, params?: unknown[]): Promise<QueryResult>; release(err?: unknown): void; }

export class Pool {
  private opts: ReturnType<typeof parseUrl>;
  private idle: Connection[] = [];
  private total = 0;
  private max: number;
  private waiting: ((c: Connection) => void)[] = [];
  constructor(o: { connectionString: string; max?: number }) {
    this.opts = parseUrl(o.connectionString);
    this.max = o.max ?? 10;
  }
  private async acquire(): Promise<Connection> {
    const c = this.idle.pop();
    if (c && !c.closed) return c;
    if (this.total < this.max) {
      this.total++;
      const conn = new Connection();
      try { await conn.open(this.opts); return conn; } catch (e) { this.total--; throw e; }
    }
    return new Promise(res => this.waiting.push(res));
  }
  private give(c: Connection, destroy: boolean) {
    if (destroy || c.closed) { c.end(); this.total--; return; }
    const w = this.waiting.shift();
    if (w) w(c); else this.idle.push(c);
  }
  async connect(): Promise<PoolClient> {
    const c = await this.acquire();
    let released = false;
    return {
      query: (t, p) => c.query(t, p),
      release: (err?: unknown) => { if (!released) { released = true; this.give(c, !!err); } },
    };
  }
  async query(text: string, params?: unknown[]) {
    const c = await this.connect();
    try { const r = await c.query(text, params); c.release(); return r; } catch (e) { c.release(e); throw e; }
  }
  async end() { this.idle.forEach(c => c.end()); this.idle = []; }
}

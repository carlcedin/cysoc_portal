import crypto from 'node:crypto';
import { masterKeyBytes } from '../config.js';

// ---------- Passwords: scrypt with per-password salt ----------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, N, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(actual, expected);
}

// A dummy hash so failed lookups take as long as real ones (prevents user enumeration by timing).
export const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export function passwordProblems(pw: string): string | null {
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (classes < 3) return 'Mix at least three of: lowercase, uppercase, numbers and symbols.';
  return null;
}

export function tempPassword(): string {
  // 16 chars from an unambiguous alphabet, always containing all four classes.
  const sets = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#%*-_+='];
  const all = sets.join('');
  const chars = sets.map(s => s[crypto.randomInt(s.length)]);
  while (chars.length < 16) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

// ---------- Secrets at rest: AES-256-GCM with the master key ----------
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKeyBytes(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKeyBytes(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

// ---------- Tokens ----------
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/** Acknowledge-link token for a notification. Derived, so the raw token is never stored anywhere. */
export const ackToken = (notificationId: string) => crypto.createHmac('sha256', masterKeyBytes()).update('ack:' + notificationId).digest('base64url');

// ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[=\s]/g, '').toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error('Bad base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

/** Returns the matching time step (allowing one step of clock drift) or null. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(code))) return s;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent('CySOC Portal')}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent('CySOC Portal')}&algorithm=SHA1&digits=6&period=30`;

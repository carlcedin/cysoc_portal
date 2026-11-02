// Sign-in flow: password → authenticator code (enrol on first sign-in) → forced password change
// when an admin issued a temporary password. Sessions are random tokens stored hashed.
import { config } from '../config.js';
import { asSystem, type Ctx } from '../db/index.js';
import { route, setCookie, HttpError, badRequest, forbidden, rateLimit, type Req } from '../http/core.js';
import { audit, type Actor } from '../services/audit.js';
import { DUMMY_HASH, verifyPassword, hashPassword, passwordProblems, randomToken, sha256, encrypt, decrypt, newTotpSecret, verifyTotp, otpauthUri } from './crypto.js';
import type { AccountRole } from './permissions.js';

export const COOKIE = 'cysoc_sid';

export interface SessionUser { id: string; name: string; email: string; role: AccountRole; tenantId: string | null; tenantName: string | null; mustChangePassword: boolean; mfaEnabled: boolean; }
interface SessionInfo { idHash: string; mfaPassed: boolean; user: SessionUser; }

async function loadSession(req: Req): Promise<SessionInfo | null> {
  const token = req.cookies[COOKIE];
  if (!token || token.length > 100) return null;
  const idHash = sha256(token);
  return asSystem(async tx => {
    const r = await tx.one(`
      SELECT s.id_hash, s.mfa_passed, s.last_seen_at, u.id, u.name, u.email, u.role, u.tenant_id, u.must_change_password, u.mfa_enabled, t.name AS tenant_name
      FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE s.id_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - ($2 || ' minutes')::interval AND u.active`,
      [idHash, String(config.sessionIdleMinutes)]);
    if (!r) return null;
    if (Date.now() - new Date(r.last_seen_at).getTime() > 60_000) await tx.query('UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1', [idHash]);
    return { idHash, mfaPassed: r.mfa_passed, user: { id: r.id, name: r.name, email: r.email, role: r.role, tenantId: r.tenant_id, tenantName: r.tenant_name, mustChangePassword: r.must_change_password, mfaEnabled: r.mfa_enabled } };
  });
}

const stageOf = (s: SessionInfo | null) => !s ? 'login' : !s.mfaPassed ? (s.user.mfaEnabled ? 'mfa' : 'mfa_setup') : s.user.mustChangePassword ? 'change_password' : 'ready';

const PUBLIC = new Set(['/api/auth/login', '/api/auth/me', '/api/health', '/api/auth/logout']);
const PRE_READY = new Set(['/api/auth/mfa/setup', '/api/auth/mfa/verify', '/api/auth/password']);

/** Runs before every API handler: attaches the session and blocks anything not allowed at this stage. */
export async function attachSession(req: Req) {
  if (req.path.startsWith('/ack/')) return;
  const s = await loadSession(req);
  req.session = s;
  if (PUBLIC.has(req.path)) return;
  if (!s) throw new HttpError(401, 'Please sign in.', 'unauthenticated');
  const stage = stageOf(s);
  if (stage !== 'ready' && !PRE_READY.has(req.path)) throw new HttpError(401, 'Finish signing in first.', 'incomplete_sign_in');
  if (req.path === '/api/auth/password' && !s.mfaPassed) throw new HttpError(401, 'Finish signing in first.', 'incomplete_sign_in');
  req.user = s.user;
  req.ctx = { role: s.user.role, tenantId: s.user.tenantId, userId: s.user.id } satisfies Ctx;
  req.actor = { userId: s.user.id, name: s.user.name, side: s.user.role === 'customer' ? 'Customer' : 'CySOC', ip: req.ip } satisfies Actor;
}

export function requireRole(req: Req, ...roles: AccountRole[]) {
  if (!roles.includes(req.user.role)) throw forbidden();
}

const publicUser = (u: SessionUser) => ({ id: u.id, name: u.name, email: u.email, role: u.role, tenantId: u.tenantId, tenantName: u.tenantName });

route('GET', '/api/health', () => ({ ok: true }));

route('GET', '/api/auth/me', (req) => {
  const s: SessionInfo | null = req.session;
  return { stage: stageOf(s), user: s ? publicUser(s.user) : null };
});

route('POST', '/api/auth/login', async (req) => {
  rateLimit('login-ip:' + req.ip, 20, 10 * 60_000);
  const { email, password } = await req.body();
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) throw badRequest('Enter your email and password.');
  rateLimit('login-email:' + email.toLowerCase(), 10, 10 * 60_000);
  const generic = new HttpError(401, 'Email or password is incorrect.', 'bad_credentials');
  // Failures are recorded in their own committed transaction, then the error is raised.
  const result = await asSystem(async tx => {
    const u = await tx.one('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    if (!u || !u.active) {
      verifyPassword(password, DUMMY_HASH);
      await audit(tx, { userId: null, name: email.slice(0, 120), side: 'System', ip: req.ip }, 'Failed sign-in', 'Unknown or disabled account', null);
      return { error: generic };
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) return { error: LOCKED };
    if (!verifyPassword(password, u.password_hash)) return { error: await recordFailure(tx, u, req.ip, 'Wrong password') ?? generic };
    await tx.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
    const token = randomToken();
    await tx.query(`INSERT INTO sessions (id_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)`,
      [sha256(token), u.id, String(config.sessionMaxHours), req.ip, String(req.raw.headers['user-agent'] || '').slice(0, 300)]);
    return { token, stage: u.mfa_enabled ? 'mfa' : 'mfa_setup' };
  });
  if ('error' in result) throw result.error;
  setCookie(req.res, COOKIE, result.token, { maxAge: config.sessionMaxHours * 3600 });
  return { stage: result.stage };
});

const LOCKED = new HttpError(423, 'This account is locked after repeated failed attempts. Try again later or ask a Full Admin to unlock it.', 'locked');

/** Counts a failed password or MFA attempt; locks the account at the limit. Returns LOCKED when it locks. */
async function recordFailure(tx: any, u: any, ip: string, why: string): Promise<HttpError | null> {
  const fails = u.failed_logins + 1;
  const lock = fails >= config.loginMaxFailures;
  await tx.query(`UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END WHERE id = $1`,
    [u.id, lock ? 0 : fails, lock, String(config.loginLockMinutes)]);
  if (lock) await tx.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  await audit(tx, { userId: u.id, name: u.name, side: u.role === 'customer' ? 'Customer' : 'CySOC', ip }, lock ? 'Account locked' : why.startsWith('Wrong MFA') ? 'Failed MFA code' : 'Failed sign-in', why, u.tenant_id);
  return lock ? LOCKED : null;
}

route('POST', '/api/auth/mfa/setup', async (req) => {
  const s: SessionInfo = req.session;
  if (s.user.mfaEnabled) throw badRequest('Your authenticator is already set up.');
  const secret = newTotpSecret();
  await asSystem(tx => tx.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1 AND NOT mfa_enabled', [s.user.id, encrypt(secret)]));
  return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri: otpauthUri(secret, s.user.email) };
});

route('POST', '/api/auth/mfa/verify', async (req) => {
  const s: SessionInfo = req.session;
  rateLimit('mfa:' + s.idHash, 8, 5 * 60_000);
  const { code } = await req.body();
  const clean = String(code || '').replace(/\s/g, '');
  const result = await asSystem(async tx => {
    const u = await tx.one('SELECT id, name, role, tenant_id, mfa_secret_enc, mfa_enabled, mfa_last_step, failed_logins, locked_until FROM users WHERE id = $1', [s.user.id]);
    if (!u?.mfa_secret_enc) return { error: badRequest('Set up your authenticator first.') };
    if (u.locked_until && new Date(u.locked_until) > new Date()) return { error: LOCKED };
    const step = verifyTotp(decrypt(u.mfa_secret_enc), clean);
    if (step === null || (u.mfa_last_step && step <= Number(u.mfa_last_step))) {
      const locked = await recordFailure(tx, u, req.ip, 'Wrong MFA code');
      return { error: locked ?? new HttpError(401, 'That code did not work. Check the time on your phone and enter the current 6-digit code.', 'bad_code') };
    }
    const actor: Actor = { userId: u.id, name: u.name, side: u.role === 'customer' ? 'Customer' : 'CySOC', ip: req.ip };
    await tx.query('UPDATE users SET mfa_enabled = true, mfa_last_step = $2, last_login_at = now(), failed_logins = 0 WHERE id = $1', [u.id, step]);
    await tx.query('UPDATE sessions SET mfa_passed = true WHERE id_hash = $1', [s.idHash]);
    await audit(tx, actor, u.mfa_enabled ? 'Signed in' : 'Enrolled MFA and signed in', 'MFA: authenticator app', u.tenant_id);
    return { stage: s.user.mustChangePassword ? 'change_password' : 'ready' };
  });
  if ('error' in result) throw result.error;
  return result;
});

route('POST', '/api/auth/password', async (req) => {
  const s: SessionInfo = req.session;
  rateLimit('pw:' + s.user.id, 10, 10 * 60_000);
  const { current, next } = await req.body();
  if (typeof current !== 'string' || typeof next !== 'string') throw badRequest('Enter your current and new password.');
  const problem = passwordProblems(next);
  if (problem) throw badRequest(problem);
  if (current === next) throw badRequest('Choose a password different from the current one.');
  return asSystem(async tx => {
    const u = await tx.one('SELECT id, name, role, tenant_id, password_hash FROM users WHERE id = $1', [s.user.id]);
    if (!verifyPassword(current, u.password_hash)) throw new HttpError(401, 'Your current password is incorrect.', 'bad_credentials');
    await tx.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [u.id, hashPassword(next)]);
    await tx.query('DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2', [u.id, s.idHash]);
    await audit(tx, { userId: u.id, name: u.name, side: u.role === 'customer' ? 'Customer' : 'CySOC', ip: req.ip }, 'Changed password', 'Other sessions signed out', u.tenant_id);
    return { stage: 'ready' };
  });
});

route('POST', '/api/auth/logout', async (req) => {
  const s: SessionInfo | null = req.session;
  if (s) await asSystem(tx => tx.query('DELETE FROM sessions WHERE id_hash = $1', [s.idHash]));
  setCookie(req.res, COOKIE, '', { clear: true });
  return { ok: true };
});

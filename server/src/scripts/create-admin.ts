// Creates the first Full Admin account and prints a one-time temporary password.
// Usage: npm run create-admin -- --email admin@example.com --name "CySOC Admin"
import { asSystem, closePool } from '../db/index.js';
import { hashPassword, tempPassword } from '../auth/crypto.js';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = arg('email')?.toLowerCase(), name = arg('name') || 'CySOC Admin';
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('Usage: create-admin --email you@example.com --name "Your Name"'); process.exit(1); }
const pw = tempPassword();
await asSystem(async tx => {
  if (await tx.one('SELECT 1 FROM users WHERE lower(email) = $1', [email])) throw new Error('That email already has an account.');
  await tx.query("INSERT INTO users (name, email, role, password_hash, must_change_password) VALUES ($1, $2, 'admin', $3, true)", [name, email, hashPassword(pw)]);
  await tx.query("INSERT INTO audit_log (actor_name, side, action, details) VALUES ('Installer', 'System', 'Created account', $1)", [`${name} <${email}> as admin (bootstrap)`]);
});
console.log(`\nFull Admin created: ${email}\nTemporary password: ${pw}\n\nSign in, enrol your authenticator app, then choose a new password.\n`);
await closePool();

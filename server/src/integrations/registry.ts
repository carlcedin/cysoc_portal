// Integration settings live in the `integrations` table; secrets are encrypted with MASTER_KEY
// and only decrypted inside the server when a call is made.
import { asSystem, type Tx } from '../db/index.js';
import { decrypt } from '../auth/crypto.js';

export interface Integration {
  id: string; kind: string; name: string; tenant_id: string | null; endpoint: string; auth_label: string;
  secret_enc: string | null; secret_last4: string | null; settings: any; enabled: boolean;
  status: string; status_note: string; last_success_at: Date | null;
}

export async function getIntegration(id: string, tx?: Tx): Promise<(Integration & { secret: string | null }) | null> {
  const run = async (t: Tx) => {
    const row = await t.one<Integration>('SELECT * FROM integrations WHERE id = $1', [id]);
    if (!row) return null;
    return { ...row, secret: row.secret_enc ? decrypt(row.secret_enc) : null };
  };
  return tx ? run(tx) : asSystem(run);
}

export async function markStatus(id: string, ok: boolean, note = '') {
  await asSystem(tx => tx.query(
    `UPDATE integrations SET status = $2, status_note = $3, last_success_at = CASE WHEN $4 THEN now() ELSE last_success_at END WHERE id = $1`,
    [id, ok ? 'ok' : 'error', note.slice(0, 300), ok]));
}

/** fetch with a timeout and a readable error. */
export async function callJson(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const err: any = new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
      err.status = res.status; err.retryAfter = retryAfter;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}

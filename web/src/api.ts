// Fetch wrapper: sends the CSRF header, parses JSON, and turns errors into readable messages.
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-CySOC-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login' && !path.startsWith('/api/auth/mfa') && path !== '/api/auth/password') {
      window.dispatchEvent(new CustomEvent('cysoc:auth'));
    }
    throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`, data?.code);
  }
  return data as T;
}

export async function uploadFile(path: string, file: File): Promise<any> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'X-CySOC-Request': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || `Upload failed (${res.status}).`, data?.code);
  return data;
}

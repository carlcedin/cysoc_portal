// Outbound notifications: email over SMTP (STARTTLS or implicit TLS) and SMS over an HTTP gateway.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getIntegration, markStatus, callJson } from './registry.js';

interface SmtpSettings { from: string; username?: string; secure?: boolean; rejectUnauthorized?: boolean; }

class SmtpSession {
  private buf = '';
  private waiting: ((line: string) => void) | null = null;
  constructor(public sock: net.Socket) { this.bind(sock); }
  bind(s: net.Socket) {
    this.sock = s;
    s.setEncoding('utf8');
    s.on('data', (d: string) => { this.buf += d; this.flush(); });
  }
  private flush() {
    // A complete reply ends with a line "NNN text" (space after the code).
    const m = this.buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/);
    if (m && this.waiting) {
      const end = this.buf.indexOf(m[0]) + m[0].length;
      const reply = this.buf.slice(0, end); this.buf = this.buf.slice(end);
      const w = this.waiting; this.waiting = null; w(reply);
    }
  }
  read(): Promise<string> { return new Promise(res => { this.waiting = res; this.flush(); }); }
  async cmd(line: string | null, expect: number[]): Promise<string> {
    if (line !== null) this.sock.write(line + '\r\n');
    const reply = await this.read();
    const code = Number(reply.slice(-200).match(/(\d{3}) [^\r\n]*\r\n$/)?.[1]);
    if (!expect.includes(code)) throw new Error(`SMTP ${line?.split(' ')[0] ?? 'greeting'} failed: ${reply.trim().slice(0, 200)}`);
    return reply;
  }
}

const encodeHeader = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;

export async function sendEmail(to: string[], subject: string, text: string): Promise<void> {
  if (config.integrationMode === 'demo') return;
  const integ = await getIntegration('smtp');
  if (!integ?.enabled || !integ.endpoint) throw new Error('Email relay is not configured');
  const s: SmtpSettings = integ.settings;
  const u = new URL(integ.endpoint); // smtp://host:587
  const host = u.hostname, port = Number(u.port || (s.secure ? 465 : 587));
  const tlsOpts = { servername: host, rejectUnauthorized: s.rejectUnauthorized !== false };
  const sock: net.Socket = s.secure ? tls.connect(port, host, tlsOpts) : net.connect(port, host);
  sock.setTimeout(30_000, () => sock.destroy(new Error('SMTP timeout')));
  const errored = new Promise<never>((_, rej) => sock.once('error', rej));
  const run = async () => {
    const smtp = new SmtpSession(sock);
    await smtp.cmd(null, [220]);
    let ehlo = await smtp.cmd('EHLO cysoc-portal', [250]);
    if (!s.secure && /STARTTLS/i.test(ehlo)) {
      await smtp.cmd('STARTTLS', [220]);
      sock.removeAllListeners('data');
      const secured = tls.connect({ socket: sock, ...tlsOpts });
      await new Promise<void>((res, rej) => { secured.once('secureConnect', () => res()); secured.once('error', rej); });
      smtp.bind(secured);
      ehlo = await smtp.cmd('EHLO cysoc-portal', [250]);
    }
    if (s.username && integ.secret) {
      await smtp.cmd('AUTH LOGIN', [334]);
      await smtp.cmd(Buffer.from(s.username).toString('base64'), [334]);
      await smtp.cmd(Buffer.from(integ.secret).toString('base64'), [235]);
    }
    await smtp.cmd(`MAIL FROM:<${s.from}>`, [250]);
    for (const r of to) await smtp.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await smtp.cmd('DATA', [354]);
    const msg = [
      `From: CySOC Portal <${s.from}>`, `To: ${to.join(', ')}`, `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@cysoc-portal>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '',
      ...text.split(/\r?\n/).map(l => (l.startsWith('.') ? '.' + l : l)),
    ].join('\r\n');
    await smtp.cmd(msg + '\r\n.', [250]);
    try { await smtp.cmd('QUIT', [221]); } catch { /* some relays close immediately */ }
    smtp.sock.end();
  };
  try { await Promise.race([run(), errored]); await markStatus('smtp', true, 'Last email sent'); }
  catch (e: any) { await markStatus('smtp', false, e.message); sock.destroy(); throw e; }
}

export async function sendSms(to: string, message: string): Promise<void> {
  if (config.integrationMode === 'demo') return;
  const integ = await getIntegration('sms');
  if (!integ?.enabled || !integ.endpoint) throw new Error('SMS gateway is not configured');
  const st = integ.settings || {};
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (integ.secret) headers[st.authHeader || 'Authorization'] = st.authHeader ? integ.secret : `Bearer ${integ.secret}`;
  const body = { ...(st.extraFields || {}), [st.toField || 'to']: to.replace(/[^\d+]/g, ''), [st.messageField || 'message']: message.slice(0, 459) };
  try { await callJson(integ.endpoint, { method: 'POST', headers, body: JSON.stringify(body) }); await markStatus('sms', true, 'Last SMS sent'); }
  catch (e: any) { await markStatus('sms', false, e.message); throw e; }
}

export async function testNotify(kind: 'smtp' | 'sms', to: string) {
  if (kind === 'smtp') { await sendEmail([to], 'CySOC Portal test email', 'This is a test message from the CySOC portal. No action is needed.'); return `Test email sent to ${to}.`; }
  await sendSms(to, 'CySOC Portal test SMS. No action is needed.'); return `Test SMS sent to ${to}.`;
}

// Escalation lifecycle: triage (CySOC only) → escalated → acknowledged → remediating → closed.
// Each step is stored with its time, audited, and written back to the NTS ticket.
import { route, badRequest, notFound, forbidden, HttpError, type Req } from '../http/core.js';
import { withCtx, asSystem, type Tx } from '../db/index.js';
import { audit, type Actor } from './audit.js';
import { need, scope, str, queue, slaTargets, UUID } from './common.js';
import { ackToken, sha256 } from '../auth/crypto.js';
import { config } from '../config.js';

const COLS = `e.id, e.tenant_id, t.name AS tenant_name, e.nts_ticket_id, e.ref, e.severity, e.summary, e.source, e.status,
  e.detected_at, e.triaged_at, e.escalated_at, e.acknowledged_at, e.ack_via, e.remediation_at, e.closure_requested_at, e.closed_at`;

route('GET', '/api/escalations', async (req) => {
  const t = scope(req);
  return withCtx(req.ctx, async tx => ({
    sla: await slaTargets(tx),
    items: await tx.query(
      `SELECT ${COLS} FROM escalations e JOIN tenants t ON t.id = e.tenant_id
       WHERE ($1::uuid IS NULL OR e.tenant_id = $1) AND (e.status <> 'closed' OR e.closed_at > now() - interval '90 days')
       ORDER BY (e.status = 'closed'), array_position(ARRAY['Critical','High','Medium','Low'], e.severity), coalesce(e.escalated_at, e.detected_at) DESC
       LIMIT 1000`, [t]),
  }));
});

async function loadOne(tx: Tx, id: string) {
  if (!UUID.test(id)) throw notFound();
  const e = await tx.one(`SELECT ${COLS} FROM escalations e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1`, [id]);
  if (!e) throw notFound('This escalation does not exist or is not visible to you.');
  return e;
}

route('GET', '/api/escalations/:id', async (req) => withCtx(req.ctx, async tx => {
  const e = await loadOne(tx, req.params.id);
  const messages = await tx.query('SELECT id, author_name, side, body, created_at FROM escalation_messages WHERE escalation_id = $1 ORDER BY created_at', [e.id]);
  const notifications = await tx.query(
    `SELECT channel, recipient_name, min(created_at) AS sent_at, bool_or(status = 'sent') AS delivered
     FROM notifications WHERE escalation_id = $1 GROUP BY channel, recipient_name ORDER BY min(created_at)`, [e.id]);
  return { escalation: e, messages, notifications };
}));

const STAFF_ACTIONS: Record<string, string[]> = { escalate: ['triage'], remind: ['escalated'], close: ['triage', 'escalated', 'acknowledged', 'remediating'] };
const CUSTOMER_ACTIONS: Record<string, string[]> = { acknowledge: ['escalated'], remediate: ['acknowledged'], request_closure: ['remediating'] };

async function notifyContacts(tx: Tx, e: any, reminder: boolean) {
  const urgent = e.severity === 'Critical' || e.severity === 'High';
  const contacts = await tx.query('SELECT name, tier, email, phone, alert_channels FROM contacts WHERE tenant_id = $1', [e.tenant_id]);
  const targets = contacts.filter((c: any) => urgent || c.tier !== 'After-hours');
  if (!targets.length) throw new HttpError(409, 'This tenant has no escalation contacts. Add contacts before escalating.', 'no_contacts');
  for (const c of targets) {
    const channels: string[] = String(c.alert_channels).split(',').map((s: string) => s.trim());
    if (channels.includes('Email') || !urgent) {
      const [n] = await tx.query(`INSERT INTO notifications (escalation_id, tenant_id, channel, recipient_name, recipient, ack_token_expires) VALUES ($1,$2,'Email',$3,$4, now() + interval '72 hours') RETURNING id`,
        [e.id, e.tenant_id, c.name, c.email]);
      await tx.query('UPDATE notifications SET ack_token_hash = $2 WHERE id = $1', [n.id, sha256(ackToken(n.id))]);
      await queue(tx, 'email', {
        notificationId: n.id, to: [c.email],
        subject: `${reminder ? 'Reminder: ' : ''}[${e.severity}] ${e.ref} security escalation for ${e.tenant_name}`,
        text: `Dear ${c.name},\n\nCySOC has escalated a ${e.severity.toLowerCase()} security event for your action.\n\nReference: ${e.ref}\nSummary: ${e.summary}\nDetected: ${new Date(e.detected_at).toISOString()}\n\nAcknowledge it here: {{ACK_LINK}}\nFull details and discussion: ${config.publicUrl}/escalations\n\nThis link expires in 72 hours. If you did not expect this message, contact CySOC.\n\nCySOC 24x7 Security Operations Centre`,
      });
    }
    if (urgent && (channels.includes('SMS') || channels.includes('Phone call')) && c.phone) {
      const [n] = await tx.query(`INSERT INTO notifications (escalation_id, tenant_id, channel, recipient_name, recipient) VALUES ($1,$2,'SMS',$3,$4) RETURNING id`, [e.id, e.tenant_id, c.name, c.phone]);
      await queue(tx, 'sms', { notificationId: n.id, to: c.phone, message: `CySOC ${e.severity} escalation ${e.ref} for ${e.tenant_name}: ${e.summary.slice(0, 120)}. Check your email to acknowledge.` });
    }
  }
}

route('POST', '/api/escalations/:id/actions', async (req) => {
  const { action } = await req.body();
  return withCtx(req.ctx, async tx => {
    const e = await loadOne(tx, req.params.id);
    const staff = req.user.role !== 'customer';
    const table = staff ? STAFF_ACTIONS : CUSTOMER_ACTIONS;
    if (!table[action]) throw forbidden('That action is not available to your account.');
    need(req, staff ? 'staffEscalationActions' : 'customerEscalationActions');
    if (!table[action].includes(e.status)) throw new HttpError(409, 'This escalation has moved on since you opened it. Refresh to see its current state.', 'conflict');
    const actor: Actor = req.actor;
    let note = '';
    switch (action) {
      case 'escalate':
        await notifyContacts(tx, e, false);
        await tx.query("UPDATE escalations SET status = 'escalated', escalated_at = now(), updated_at = now() WHERE id = $1", [e.id]);
        note = `Escalated to customer via CySOC portal by ${actor.name}.`;
        if (e.nts_ticket_id) await queue(tx, 'nts.status', { ticketId: e.nts_ticket_id, status: 'escalate' });
        break;
      case 'remind':
        await notifyContacts(tx, e, true);
        note = `Reminder sent to customer contacts by ${actor.name}.`;
        break;
      case 'close':
        await tx.query("UPDATE escalations SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [e.id]);
        note = `Verified and closed in CySOC portal by ${actor.name}.`;
        if (e.nts_ticket_id) await queue(tx, 'nts.status', { ticketId: e.nts_ticket_id, status: 'close' });
        break;
      case 'acknowledge':
        await tx.query("UPDATE escalations SET status = 'acknowledged', acknowledged_at = now(), ack_via = 'portal', updated_at = now() WHERE id = $1", [e.id]);
        note = `Customer acknowledged in portal (${actor.name}).`;
        break;
      case 'remediate':
        await tx.query("UPDATE escalations SET status = 'remediating', remediation_at = now(), updated_at = now() WHERE id = $1", [e.id]);
        note = `Customer started remediation (${actor.name}).`;
        break;
      case 'request_closure':
        await tx.query('UPDATE escalations SET closure_requested_at = now(), updated_at = now() WHERE id = $1', [e.id]);
        note = `Customer reports the issue fixed and requests closure (${actor.name}).`;
        break;
    }
    if (e.nts_ticket_id) await queue(tx, 'nts.note', { ticketId: e.nts_ticket_id, body: note });
    const label: Record<string, string> = { escalate: 'Escalated', remind: 'Sent reminder', close: 'Closed escalation', acknowledge: 'Acknowledged escalation', remediate: 'Started remediation', request_closure: 'Requested closure' };
    await audit(tx, actor, label[action], `${e.ref} · ${e.summary}`, e.tenant_id);
    return { ok: true };
  });
});

route('POST', '/api/escalations/:id/messages', async (req) => {
  need(req, 'postMessage');
  const { body } = await req.body();
  const text = str(body, 'a message', 5000);
  return withCtx(req.ctx, async tx => {
    const e = await loadOne(tx, req.params.id);
    if (e.status === 'triage') throw badRequest('Escalate this event before messaging the customer.');
    await tx.query('INSERT INTO escalation_messages (escalation_id, tenant_id, author_user_id, author_name, side, body) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.id, e.tenant_id, req.user.id, req.user.name, req.actor.side, text]);
    if (e.nts_ticket_id) await queue(tx, 'nts.note', { ticketId: e.nts_ticket_id, body: `Portal message from ${req.user.name} (${req.actor.side}):\n${text}` });
    await audit(tx, req.actor, 'Posted message', e.ref, e.tenant_id);
    return { ok: true };
  });
});

// ---------- One-click acknowledgement from the email link ----------
// GET shows a confirmation page; only the POST acknowledges, so mail scanners that follow links do nothing.
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:"Work Sans",system-ui,sans-serif;margin:0;background:#fff;color:#000}header{background:#000;padding:16px 20px}header img{height:30px}main{max-width:560px;margin:40px auto;padding:0 20px}h1{font-size:24px}button{background:#F454CD;border:0;border-radius:999px;padding:10px 22px;font:inherit;font-weight:600;cursor:pointer}p{line-height:1.5}</style></head>
<body><header><img src="/time-wordmark-white.png" alt="Time"></header><main>${body}</main></body></html>`;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function findToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return asSystem(tx => tx.one(
    `SELECT n.id, n.recipient_name, n.tenant_id, e.id AS escalation_id, e.ref, e.summary, e.severity, e.status, e.nts_ticket_id
     FROM notifications n JOIN escalations e ON e.id = n.escalation_id WHERE n.ack_token_hash = $1 AND n.ack_token_expires > now()`, [sha256(token)]));
}

function html(req: Req, status: number, content: string) {
  req.res.statusCode = status;
  req.res.setHeader('Content-Type', 'text/html; charset=utf-8');
  req.res.setHeader('Cache-Control', 'no-store');
  req.res.end(content);
}

route('GET', '/ack/:token', async (req) => {
  const n = await findToken(req.params.token);
  if (!n) return html(req, 404, page('Link expired', '<h1>This link has expired</h1><p>Sign in to the CySOC portal to acknowledge the escalation.</p>'));
  if (n.status !== 'escalated') return html(req, 200, page('Already acknowledged', `<h1>${esc(n.ref)} is already acknowledged</h1><p>Sign in to the CySOC portal to follow progress.</p>`));
  return html(req, 200, page('Acknowledge escalation', `<h1>Acknowledge ${esc(n.ref)}?</h1><p><b>${esc(n.severity)}</b> · ${esc(n.summary)}</p><p>Acknowledging tells CySOC that ${esc(n.recipient_name)} has received this escalation and is acting on it.</p><form method="post"><button type="submit">Acknowledge escalation</button></form>`));
});

route('POST', '/ack/:token', async (req) => {
  const n = await findToken(req.params.token);
  if (!n) return html(req, 404, page('Link expired', '<h1>This link has expired</h1><p>Sign in to the CySOC portal to acknowledge the escalation.</p>'));
  await asSystem(async tx => {
    const r = await tx.query("UPDATE escalations SET status = 'acknowledged', acknowledged_at = now(), ack_via = 'email link', updated_at = now() WHERE id = $1 AND status = 'escalated' RETURNING id", [n.escalation_id]);
    if (r.length) {
      await tx.query('UPDATE notifications SET ack_token_hash = NULL WHERE escalation_id = $1', [n.escalation_id]);
      if (n.nts_ticket_id) await queue(tx, 'nts.note', { ticketId: n.nts_ticket_id, body: `Customer acknowledged via email link (${n.recipient_name}).` });
      await audit(tx, { userId: null, name: n.recipient_name, side: 'Customer', ip: req.ip }, 'Acknowledged escalation', `${n.ref} via email link`, n.tenant_id);
    }
  });
  return html(req, 200, page('Acknowledged', `<h1>Thank you</h1><p>${esc(n.ref)} is acknowledged. CySOC has been notified. Sign in to the portal to update remediation progress.</p>`));
});

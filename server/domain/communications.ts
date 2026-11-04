import { db } from '../db/db.js';
import { badRequest } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { orderUrl } from '../services/links.js';
import { money } from '../services/templates.js';
import { addEvent, orderMoney, requireOrder } from './orders.js';
import { customerContact, onOrderReceived } from './lifecycle.js';
import { openRequest, paymentRequestMessage } from './payments.js';

/**
 * Everything the business has sent this customer about an order, with honest statuses.
 * We use SMTP, which tells us a message was accepted for delivery, not that it arrived — so the most
 * we ever show is "Sent". WhatsApp messages go from a staff phone, so they are "Opened in WhatsApp".
 */
export const NOTIFICATION_KIND_LABEL: Record<string, string> = {
  order_received: 'Order confirmation',
  order_confirmed: 'Order confirmed',
  payment_requested: 'Payment request',
  payment_received: 'Payment received',
  invoice_ready: 'Invoice notification',
  declaration_rejected: 'Payment not confirmed',
  proof_rejected: 'Proof not accepted',
  status_changed: 'Status update',
  timeframe_changed: 'Timeframe changed',
};

export function communications(orderId: string) {
  const sent = db()
    .prepare("SELECT id, kind, recipient, subject, status, error, attempts, sent_at, created_at FROM notifications WHERE order_id = ? AND audience = 'customer' AND channel = 'email' AND kind != 'reply_suggestion' ORDER BY created_at DESC LIMIT 100")
    .all(orderId) as any[];
  const manual = db()
    .prepare("SELECT e.created_at, e.type, e.summary, u.name AS actor_name FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.order_id = ? AND e.type IN ('payment_request_whatsapp','whatsapp_opened','link_copied') ORDER BY e.created_at DESC LIMIT 100")
    .all(orderId) as any[];
  const label = (s: string) => ({ queued: 'Queued', sent: 'Sent', failed: 'Failed', skipped: 'Not sent' } as Record<string, string>)[s] ?? s;
  return [
    ...sent.map((n) => ({ at: n.sent_at ?? n.created_at, channel: 'email' as const, kind: n.kind, kind_label: NOTIFICATION_KIND_LABEL[n.kind] ?? n.kind, to: n.recipient, subject: n.subject, status: n.status, status_label: label(n.status), detail: n.error, attempts: n.attempts })),
    ...manual.map((e) => ({ at: e.created_at, channel: (e.type === 'link_copied' ? 'link' : 'whatsapp') as 'link' | 'whatsapp', kind: e.type, kind_label: e.type === 'link_copied' ? 'Portal link copied' : 'WhatsApp message', to: null, subject: null, status: 'manual', status_label: e.type === 'link_copied' ? 'Copied' : 'Opened in WhatsApp (not tracked)', detail: `${e.summary}${e.actor_name ? ` · ${e.actor_name}` : ''}`, attempts: 1 })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Sends the "we've received your order" email again (e.g. the customer can't find it). */
export function resendOrderConfirmation(orderId: string, actor: Actor) {
  const o = requireOrder(orderId);
  const c = customerContact(orderId);
  if (!c.email) throw badRequest('This order has no email address.');
  const n = (db().prepare("SELECT COUNT(*) n FROM notifications WHERE order_id = ? AND kind = 'order_received'").get(orderId) as { n: number }).n;
  onOrderReceived(orderId, { special: null, notes: null, resend: n + 1 });
  addEvent(orderId, 'confirmation_resent', `Order confirmation email ${n ? 'sent again' : 'sent'} to ${c.email}`, actor);
  audit(actor, 'order.confirmation_resent', 'order', orderId, `#${o.order_number}: order confirmation emailed to ${c.email}`);
  publish(['orders'], { orderId });
  return communications(orderId);
}

function waPhone(raw: string | null | undefined) {
  const d = (raw ?? '').replace(/\D/g, '').replace(/^0/, '27');
  return d.length >= 9 ? d : null;
}

/**
 * The WhatsApp message staff can open (and edit) for this order: the payment message while a request
 * is open, otherwise a short update with the portal link. Opening it never changes the payment status.
 */
export function whatsappDraft(orderId: string) {
  const o = requireOrder(orderId);
  const c = customerContact(orderId);
  const s = getSettings();
  const req = openRequest(orderId);
  const m = orderMoney(orderId);
  const portal = orderUrl(orderId);
  let text: string;
  let kind: 'payment' | 'update';
  if (req) {
    const msg = paymentRequestMessage(orderId, req);
    text = msg.whatsapp;
    kind = 'payment';
  } else {
    kind = 'update';
    const owed = m.balance_cents != null && m.balance_cents > 0 ? ` Outstanding: ${money(m.balance_cents)}.` : '';
    text = `Hi ${c.firstName}, this is ${s.business.name} about your order #${o.order_number}.${owed} You can see your order, payment and delivery details here: ${portal}`;
  }
  return { kind, text, phone: o.contact_phone ?? null, wa_phone: waPhone(o.contact_phone), portal_url: portal, outstanding_cents: m.balance_cents };
}

/** Staff opened WhatsApp with a (possibly edited) message. Recorded as a handoff; delivery isn't tracked. */
export function recordWhatsApp(orderId: string, text: string, actor: Actor) {
  const o = requireOrder(orderId);
  const t = text.trim();
  if (!t) throw badRequest('The message is empty.');
  addEvent(orderId, 'whatsapp_opened', `WhatsApp message opened to send by hand: “${t.slice(0, 160)}${t.length > 160 ? '…' : ''}”`, actor, { text: t.slice(0, 2000) });
  audit(actor, 'order.whatsapp_opened', 'order', orderId, `#${o.order_number}: WhatsApp message opened`);
  publish(['orders'], { orderId });
  return communications(orderId);
}

export function recordLinkCopied(orderId: string, actor: Actor) {
  requireOrder(orderId);
  addEvent(orderId, 'link_copied', 'Customer portal link copied', actor);
  return communications(orderId);
}

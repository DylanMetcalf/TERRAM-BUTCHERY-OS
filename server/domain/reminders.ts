import { db } from '../db/db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { publish } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { layout, money, signOff } from '../services/templates.js';
import { addEvent, orderMoney, requireOrder } from './orders.js';
import { customerContact } from './lifecycle.js';
import { openRequest, paymentRequestMessage } from './payments.js';
import { normalisePhone } from '../../shared/text.js';

/**
 * PAYMENT FOLLOW-UP. A week (configurable) after a payment request went out and nothing has come in, the
 * order shows up as "Payment reminder due" for staff. NOTHING IS SENT AUTOMATICALLY: a person opens the
 * order, checks the bank, and chooses "Remind for payment" (email, WhatsApp from their phone) or snoozes.
 * The timeline is worked out from the order's own events, so no extra tables are needed.
 */

/** Events that start (or restart) the waiting clock: the request (or a reminder) reached, or was handed to, the customer. Merely creating a request does not count. */
const CLOCK_EVENTS = ['payment_request_sent', 'payment_request_whatsapp', 'payment_reminder_sent', 'payment_reminder_whatsapp'];
const UNPAID_STATES = ['requested', 'pending', 'partially_paid', 'failed', 'rejected'];
const DAY = 86400_000;

export function reminderDays(): number {
  const n = getSettings().payments.reminderDays;
  return Number.isFinite(n) ? Math.max(0, Math.min(60, Math.floor(n))) : 7;
}

export interface ReminderState {
  /** Reminders are switched on and this order has an open request nobody has paid or claimed. */
  eligible: boolean;
  /** Eligible and the waiting period (or a snooze) is over. */
  due: boolean;
  days: number;
  waiting_since: string | null;
  due_at: string | null;
  days_waiting: number | null;
  snoozed_until: string | null;
  reminders_sent: number;
  last_reminder_at: string | null;
  /** Why it isn't eligible, for the order page. */
  reason: string | null;
}

const none = (reason: string, days: number): ReminderState => ({ eligible: false, due: false, days, waiting_since: null, due_at: null, days_waiting: null, snoozed_until: null, reminders_sent: 0, last_reminder_at: null, reason });

export function reminderState(orderId: string, nowMs = Date.now()): ReminderState {
  const days = reminderDays();
  const o = db().prepare('SELECT status, payment_state FROM orders WHERE id = ?').get(orderId) as { status: string; payment_state: string } | undefined;
  if (!o) return none('Order not found.', days);
  if (o.status === 'cancelled') return none('This order is cancelled.', days);
  if (!UNPAID_STATES.includes(o.payment_state)) return none(o.payment_state === 'proof_submitted' ? 'The customer says they have paid: check the bank first.' : 'Nothing is waiting on payment.', days);
  const openReq = openRequest(orderId);
  if (!openReq) return none('No payment request has been sent yet.', days);
  const claim = db()
    .prepare("SELECT 1 FROM payment_declarations WHERE order_id = ? AND status = 'submitted' UNION SELECT 1 FROM payment_proofs WHERE order_id = ? AND status = 'submitted'")
    .get(orderId, orderId);
  if (claim) return none('The customer says they have paid: check the bank first.', days);
  const evs = db()
    .prepare(`SELECT type, data, created_at FROM order_events WHERE order_id = ? AND type IN (${[...CLOCK_EVENTS, 'payment_reminder_snoozed'].map(() => '?').join(',')}) ORDER BY created_at, rowid`)
    .all(orderId, ...CLOCK_EVENTS, 'payment_reminder_snoozed') as { type: string; data: string; created_at: string }[];
  // Only what was sent for the request that is open now (a withdrawn request's send doesn't start the clock for a new one)
  const forThis = (e: { data: string }) => {
    try {
      const r = JSON.parse(e.data)?.request_id;
      return !r || r === openReq.id;
    } catch {
      return true;
    }
  };
  const clock = evs.filter((e) => e.type !== 'payment_reminder_snoozed' && forThis(e));
  const since = clock.length ? clock[clock.length - 1].created_at : null;
  const reminders = evs.filter((e) => (e.type === 'payment_reminder_sent' || e.type === 'payment_reminder_whatsapp') && forThis(e));
  const snoozes = evs.filter((e) => e.type === 'payment_reminder_snoozed' && (!since || e.created_at >= since));
  let snoozedUntil: string | null = null;
  for (const s of snoozes) {
    try {
      const u = JSON.parse(s.data)?.until;
      if (typeof u === 'string') snoozedUntil = u; // the latest snooze wins, so staff can shorten one
    } catch {
      /* ignore a malformed snooze */
    }
  }
  const base = {
    days,
    waiting_since: since,
    snoozed_until: snoozedUntil,
    reminders_sent: reminders.length,
    last_reminder_at: reminders.length ? reminders[reminders.length - 1].created_at : null,
    reason: null,
  };
  if (!days) return { ...base, eligible: false, due: false, due_at: null, days_waiting: null, reason: 'Payment reminders are switched off in Settings.' };
  if (!since) return { ...base, eligible: false, due: false, due_at: null, days_waiting: null, reason: 'The payment request hasn’t been sent yet.' };
  const dueMs = Math.max(Date.parse(since) + days * DAY, snoozedUntil ? Date.parse(snoozedUntil) : 0);
  return { ...base, eligible: true, due: nowMs >= dueMs, due_at: new Date(dueMs).toISOString(), days_waiting: Math.max(0, Math.floor((nowMs - Date.parse(since)) / DAY)) };
}

/** Orders whose reminder is due now, oldest request first (for the dashboard and the orders list). */
export function reminderDueIds(): string[] {
  if (!reminderDays()) return [];
  const rows = db()
    .prepare(`SELECT id FROM orders WHERE status != 'cancelled' AND payment_state IN (${UNPAID_STATES.map((s) => `'${s}'`).join(',')}) AND EXISTS (SELECT 1 FROM payment_requests r WHERE r.order_id = orders.id AND r.status = 'open') ORDER BY updated_at`)
    .all() as { id: string }[];
  const t = Date.now();
  return rows.filter((r) => reminderState(r.id, t).due).map((r) => r.id);
}

/** What staff see before sending: the exact email and WhatsApp text. */
export function reminderDraft(orderId: string) {
  const o = requireOrder(orderId);
  const req = openRequest(orderId);
  if (!req) throw conflict('There’s no open payment request for this order.');
  const c = customerContact(orderId);
  const s = getSettings();
  const m = paymentRequestMessage(orderId, req);
  const owing = orderMoney(orderId).balance_cents ?? req.amount_cents;
  const support = [s.business.phone ? `WhatsApp or call us on ${s.business.phone}` : null, s.business.email ? `email ${s.business.email}` : null].filter(Boolean).join(', or ');
  const email = layout({
    subject: `A friendly reminder: payment for order #${o.order_number}`,
    preheader: `${money(owing)} is still outstanding on your order.`,
    greeting: `Hi ${c.firstName},`,
    intro: [`This is a friendly reminder that payment for your order #${o.order_number} hasn’t reached us yet.`],
    blocks: [
      { facts: [['Amount outstanding', money(owing)], ['Payment reference', `${o.order_number}`]] },
      { paragraphs: ['If you have already paid, thank you! Open your payment page and tap “Already paid?” so we can check it. If not, our banking details are on the same page.'] },
    ],
    cta: { label: 'Open my payment page', url: m.url },
    closing: [`Questions? ${support || 'Reply to this email'} with your order number #${o.order_number}.`, ...signOff()],
  });
  const whatsapp = [
    `Hi ${c.firstName}, a friendly reminder from ${s.business.name}: payment for your order #${o.order_number} (${money(owing)}) hasn't reached us yet.`,
    `You can pay by EFT using the details on your secure payment page: ${m.url}`,
    `If you've already paid, please tap “Already paid?” on that page so we can check it. Thank you!`,
  ].join('\n\n');
  const digits = (normalisePhone(o.contact_phone ?? o.customer_phone ?? '') ?? '').replace(/\D/g, '');
  return { to: c.email, subject: email.subject, text: email.text, email, whatsapp, phone: o.contact_phone ?? o.customer_phone ?? null, wa_phone: digits.length >= 9 ? digits : null, amount_cents: owing, request_id: req.id as string, customerId: c.customerId };
}

/** A reminder the day payment was asked for would just be a duplicate. */
function tooSoon(st: ReminderState) {
  if (st.waiting_since && Date.now() - Date.parse(st.waiting_since) < DAY) throw conflict('Payment was only asked for today. Give the customer a day before reminding them.');
}

/** Staff chose "Remind for payment" by email. One reminder per click; a second click is refused, not duplicated. */
export function sendPaymentReminder(orderId: string, actor: Actor) {
  const o = requireOrder(orderId);
  const st = reminderState(orderId);
  if (!st.eligible) throw conflict(st.reason ?? 'A reminder can’t be sent for this order.');
  tooSoon(st);
  const d = reminderDraft(orderId);
  if (!d.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.to)) throw badRequest('This order has no usable email address. Use WhatsApp instead, or fix the email under Customer.');
  if (st.last_reminder_at && Date.now() - Date.parse(st.last_reminder_at) < 5 * 60_000) throw conflict('A reminder was just sent for this order.');
  const n = st.reminders_sent + 1;
  const r = notify({ key: `payment_reminder:${orderId}:${d.request_id}:${n}`, kind: 'payment_reminder', audience: 'customer', to: [d.to], ...d.email, replyTo: getSettings().business.email || null, orderId, customerId: d.customerId });
  if (!r.created) throw conflict('A reminder was just sent for this order.');
  const row = db().prepare('SELECT status FROM notifications WHERE id = ?').get(r.id) as { status: string } | undefined;
  if (row?.status === 'skipped') throw badRequest('That email address couldn’t be used, so nothing was sent.');
  addEvent(orderId, 'payment_reminder_sent', `Payment reminder emailed to ${d.to} (${money(d.amount_cents)})${n > 1 ? ` · reminder ${n}` : ''}`, actor, { request_id: d.request_id, n });
  audit(actor, 'payment.reminder_sent', 'order', orderId, `#${o.order_number}: payment reminder emailed (${money(d.amount_cents)})`);
  publish(['orders'], { orderId });
  return reminderState(orderId);
}

/** Staff opened WhatsApp with the reminder (possibly edited). Restarts the waiting clock; delivery isn't tracked. */
export function recordReminderWhatsApp(orderId: string, text: string, actor: Actor) {
  const o = requireOrder(orderId);
  const st = reminderState(orderId);
  if (!st.eligible) throw conflict(st.reason ?? 'A reminder can’t be sent for this order.');
  tooSoon(st);
  const t = text.trim();
  if (!t) throw badRequest('The message is empty.');
  const req = openRequest(orderId);
  addEvent(orderId, 'payment_reminder_whatsapp', `Payment reminder opened in WhatsApp to send by hand — delivery isn’t tracked: “${t.slice(0, 140)}${t.length > 140 ? '…' : ''}”`, actor, { request_id: req?.id ?? null, text: t.slice(0, 2000) });
  audit(actor, 'payment.reminder_whatsapp', 'order', orderId, `#${o.order_number}: payment reminder opened in WhatsApp`);
  publish(['orders'], { orderId });
  return reminderState(orderId);
}

/** "Not yet": hide the reminder for a few days. */
export function snoozeReminder(orderId: string, days: number, actor: Actor) {
  const o = requireOrder(orderId);
  const st = reminderState(orderId);
  if (!st.eligible) throw conflict(st.reason ?? 'Nothing to snooze.');
  const d = Math.max(1, Math.min(30, Math.floor(days)));
  const until = new Date(Date.now() + d * DAY).toISOString();
  addEvent(orderId, 'payment_reminder_snoozed', `Payment reminder snoozed for ${d} day${d === 1 ? '' : 's'}`, actor, { until, days: d });
  audit(actor, 'payment.reminder_snoozed', 'order', orderId, `#${o.order_number}: payment reminder snoozed ${d} days`);
  publish(['orders'], { orderId });
  return reminderState(orderId);
}

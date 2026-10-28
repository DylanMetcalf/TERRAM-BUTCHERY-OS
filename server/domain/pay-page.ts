import { db, id, now, tx } from '../db/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { notify } from '../services/notify.js';
import { getSettings } from '../services/settings.js';
import { orderToken, payToken, readPayToken, siteUrl } from '../services/links.js';
import { eftDetails, paymentMethods } from '../services/payment-config.js';
import { layout, money, signOff } from '../services/templates.js';
import { raiseException } from './exceptions.js';
import { addEvent, orderMoney, requireOrder } from './orders.js';
import { latestFinalization, type FinalSnapshot } from './finalize.js';
import { customerContact, staffEmails } from './lifecycle.js';
import { METHOD_LABEL, openRequest, paymentRequestMessage, recomputePayment, recordVerifiedPayment, sendPaymentRequestEmail, createPaymentRequest, paymentBlocker } from './payments.js';

/**
 * The customer's secure EFT payment page (/pay/<link>) and the staff side of sending it.
 * The page shows the finalized lines and amount, Terram's banking details and the payment
 * reference, and lets the customer upload proof or declare they've paid. Neither marks anything
 * paid: staff check the bank and verify. A superseded, paid or expired link never shows an amount
 * as payable.
 */

export function requestRow(requestId: string) {
  return db().prepare('SELECT * FROM payment_requests WHERE id = ?').get(requestId) as any | undefined;
}

/** Resolves a /pay link to its request, or throws the same "not valid" error for anything wrong. */
export function requestFromPayToken(token: string): { request: any } | { expired: true } {
  const r = readPayToken(token, (rid) => db().prepare('SELECT link_version FROM payment_requests WHERE id = ?').get(rid) as { link_version: number } | undefined);
  if ('error' in r) {
    if (r.error === 'expired') return { expired: true };
    throw notFound('That payment link');
  }
  return { request: requestRow(r.requestId)! };
}

export type PayStatus = 'awaiting_payment' | 'awaiting_verification' | 'paid' | 'superseded';

export function payView(request: any) {
  const o = requireOrder(request.order_id);
  const s = getSettings();
  const f = s.fulfilment;
  const fin = request.finalization_id ? (db().prepare('SELECT snapshot FROM order_finalizations WHERE id = ?').get(request.finalization_id) as { snapshot: string } | undefined) : undefined;
  const snapshot: FinalSnapshot | null = fin ? JSON.parse(fin.snapshot) : latestFinalization(o.id)?.snapshot ?? null;
  const m = orderMoney(o.id);
  let status: PayStatus;
  if (o.payment_state === 'paid') status = 'paid';
  else if (request.status !== 'open') status = request.status === 'paid' ? 'paid' : 'superseded';
  else if (o.payment_state === 'proof_submitted') status = 'awaiting_verification';
  else status = 'awaiting_payment';
  const payable = status === 'awaiting_payment' || status === 'awaiting_verification';
  const methods = paymentMethods();
  const wa = (s.business.phone ?? '').replace(/\D/g, '').replace(/^0/, '27');
  const declarations = db().prepare('SELECT id, amount_cents, paid_on, status, review_note, created_at FROM payment_declarations WHERE order_id = ? ORDER BY created_at DESC').all(o.id) as any[];
  const proofs = db().prepare("SELECT p.id, p.amount_claimed_cents, p.status, p.review_note, p.created_at, f.filename FROM payment_proofs p JOIN files f ON f.id = p.file_id WHERE p.order_id = ? ORDER BY p.created_at DESC").all(o.id) as any[];
  const payments = db().prepare("SELECT id, amount_cents, method, receipt_number, created_at FROM payments WHERE order_id = ? AND status = 'verified' ORDER BY created_at").all(o.id) as any[];
  return {
    status,
    business: { name: s.business.name, phone: s.business.phone || null, email: s.business.email || null, whatsapp_url: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(`Hi, it's about payment for order #${o.order_number}: `)}` : null },
    order: {
      number: o.order_number,
      date: o.created_at,
      customer_name: o.customer_name,
      storage: o.storage,
      fulfilment: o.fulfilment_type,
      address: o.fulfilment_type !== 'collection' ? o.delivery_address : null,
      collection: o.fulfilment_type === 'collection' ? [f.collectionPlace, f.collectionAddress, f.collectionHours].filter(Boolean).join(' · ') : null,
    },
    // The finalized lines this request was made from (never today's catalogue)
    lines: (snapshot?.lines ?? []).map((l) => ({ name: l.name, size: l.size, qty_label: l.qty_label, preparation: l.preparation, weight_g: l.weight_g, unit_price_cents: l.unit_price_cents, price_unit: l.price_unit, pricing: l.pricing, line_cents: l.line_cents })),
    delivery_fee_cents: snapshot?.delivery_fee_cents ?? 0,
    total_cents: snapshot?.total_cents ?? request.amount_cents,
    paid_cents: m.paid_cents,
    amount_due_cents: payable ? request.amount_cents : null,
    reference: `${o.order_number}`,
    bank: payable && methods.eft ? eftDetails() : null,
    eft_unavailable: payable && !methods.eft,
    declarations: declarations.map((d) => ({ ...d, review_note: d.status === 'rejected' ? d.review_note : null })),
    proofs: proofs.map((p) => ({ ...p, review_note: p.status === 'rejected' ? p.review_note : null })),
    payments: payments.map((p) => ({ ...p, method: METHOD_LABEL[p.method as keyof typeof METHOD_LABEL], receipt: `R${p.receipt_number}` })),
    /** The order page, for receipts, history and help (the payment link already proves access to this order). */
    order_url: `/o/${orderToken(o.id)}`,
    expires_at: request.expires_at,
  };
}

/** "I've made payment": recorded and passed to staff to check. Never marks the order paid. */
export function declarePayment(request: any, input: { amount_cents: number | null; paid_on: string | null; note: string | null }) {
  const o = requireOrder(request.order_id);
  if (request.status !== 'open') throw conflict('This payment request is no longer open. Please use the latest one we sent you.');
  if (o.payment_state === 'paid') throw conflict('This order is already paid. Thank you!');
  if (input.amount_cents != null && (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0 || input.amount_cents > 100_000_000)) throw badRequest('Check the amount you paid.');
  if (input.paid_on && !/^\d{4}-\d{2}-\d{2}$/.test(input.paid_on)) throw badRequest('Check the payment date.');
  const recent = (db().prepare('SELECT COUNT(*) n FROM payment_declarations WHERE order_id = ? AND created_at > ?').get(o.id, new Date(Date.now() - 3600_000).toISOString()) as { n: number }).n;
  if (recent >= 3) throw conflict('We’ve already received your message. We’ll confirm as soon as we’ve checked the payment.');
  const did = id('pdc_');
  const customer: Actor = { userId: null, kind: 'customer', name: o.customer_name };
  tx(() => {
    db().prepare("INSERT INTO payment_declarations (id, order_id, request_id, amount_cents, paid_on, note, status, created_at) VALUES (?,?,?,?,?,?,'submitted',?)").run(did, o.id, request.id, input.amount_cents, input.paid_on, input.note?.trim().slice(0, 500) || null, now());
    addEvent(o.id, 'payment_declared', `Customer says they’ve paid${input.amount_cents ? ` ${money(input.amount_cents)}` : ''}${input.paid_on ? ` on ${input.paid_on}` : ''} — check the bank`, customer, { declaration_id: did });
    recomputePayment(o.id);
  });
  raiseException({ type: 'payment_issue', severity: 'info', title: `Check the bank for #${o.order_number}`, detail: `${o.customer_name} says they’ve paid${input.amount_cents ? ` ${money(input.amount_cents)}` : ''}. Check that it has reflected, then confirm the payment on the order.`, order_id: o.id, dedupe_key: `declared:${did}` });
  const staff = staffEmails();
  if (staff.length) {
    const e = layout({ subject: `${o.customer_name} says they’ve paid #${o.order_number} — please check the bank`, preheader: money(request.amount_cents), intro: [`${o.customer_name} says they’ve paid${input.amount_cents ? ` ${money(input.amount_cents)}` : ''} for order #${o.order_number} (amount due ${money(request.amount_cents)}).`, 'The order is NOT marked paid until someone checks the money is in the account and confirms it in Terram.'], cta: { label: 'Open the order', url: `${siteUrl()}/orders/${o.id}` } });
    notify({ key: `staff_declared:${did}`, kind: 'staff_declared', audience: 'staff', to: staff, ...e, orderId: o.id });
  }
  const c = customerContact(o.id);
  if (c.email) {
    const ce = layout({ subject: `Thanks — we’ll check your payment for #${o.order_number}`, preheader: 'We’ll confirm once it has reflected.', greeting: `Hi ${c.firstName},`, intro: ['Thanks for letting us know you’ve paid. We’ll confirm as soon as the payment has reflected in our account.'], closing: signOff() });
    notify({ key: `declared_ack:${did}`, kind: 'payment_declared', audience: 'customer', to: [c.email], ...ce, orderId: o.id, customerId: c.customerId });
  }
  publish(['orders', 'exceptions'], { orderId: o.id });
  return did;
}

/** Staff decision on "I've made payment": confirm the amount that reflected, or ask for more information. */
export function reviewDeclaration(declarationId: string, decision: { accept: true; amount_cents: number; note?: string | null } | { accept: false; reason: string }, actor: Actor) {
  const d = db().prepare('SELECT * FROM payment_declarations WHERE id = ?').get(declarationId) as any;
  if (!d) throw notFound('That payment message');
  if (d.status !== 'submitted') throw conflict('This has already been dealt with.');
  const o = requireOrder(d.order_id);
  if (decision.accept) {
    const res = recordVerifiedPayment(d.order_id, { method: 'eft', amount_cents: decision.amount_cents, request_id: openRequest(d.order_id)?.id ?? null, note: decision.note ?? 'Customer declared payment; checked in the bank' }, actor, 'staff');
    db().prepare("UPDATE exceptions SET status = 'resolved', resolution = 'verified', resolved_by = ?, resolved_at = ? WHERE dedupe_key = ? AND status = 'open'").run(actor.userId, now(), `declared:${declarationId}`);
    return res.payment;
  }
  const reason = decision.reason?.trim();
  if (!reason) throw badRequest('Say what’s missing, so the customer knows what to do.');
  tx(() => {
    db().prepare("UPDATE payment_declarations SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?").run(actor.userId, now(), reason.slice(0, 500), declarationId);
    addEvent(o.id, 'declaration_rejected', `Payment not found yet: ${reason}`, actor, { declaration_id: declarationId });
    audit(actor, 'payment.declaration_rejected', 'order', o.id, `#${o.order_number}: payment declaration not confirmed (${reason})`);
    db().prepare("UPDATE exceptions SET status = 'resolved', resolution = 'rejected', resolved_by = ?, resolved_at = ? WHERE dedupe_key = ? AND status = 'open'").run(actor.userId, now(), `declared:${declarationId}`);
    recomputePayment(o.id);
  });
  const c = customerContact(o.id);
  if (c.email) {
    const req = openRequest(o.id);
    const e = layout({ subject: `About your payment for order #${o.order_number}`, preheader: 'We couldn’t confirm the payment yet.', greeting: `Hi ${c.firstName},`, intro: [`We haven’t been able to confirm your payment for order #${o.order_number} yet.`], blocks: [{ facts: [['What we need', reason]] }], ...(req ? { cta: { label: 'Open my payment page', url: paymentRequestMessage(o.id, req).url } } : {}), closing: ['If you think this is a mistake, please reply to this email or call us.', ...signOff()] });
    notify({ key: `declaration_rejected:${declarationId}`, kind: 'declaration_rejected', audience: 'customer', to: [c.email], ...e, orderId: o.id, customerId: c.customerId });
  }
  publish(['orders', 'exceptions'], { orderId: o.id });
  return null;
}

// ── Staff: preview and send the payment request ──────────────

function requestHistory(orderId: string) {
  const sends = db()
    .prepare("SELECT id, channel, recipient, status, error, attempts, provider_id, sent_at, created_at, event_key FROM notifications WHERE order_id = ? AND kind = 'payment_requested' ORDER BY created_at DESC")
    .all(orderId) as any[];
  const manual = db()
    .prepare("SELECT e.created_at, e.summary, u.name AS actor_name FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.order_id = ? AND e.type = 'payment_request_whatsapp' ORDER BY e.created_at DESC")
    .all(orderId) as any[];
  return [
    ...sends.map((n) => ({ at: n.sent_at ?? n.created_at, channel: 'email', to: n.recipient, status: n.status, detail: n.error, provider_ref: n.provider_id, attempts: n.attempts })),
    ...manual.map((e) => ({ at: e.created_at, channel: 'whatsapp', to: null, status: 'manual', detail: `${e.summary}${e.actor_name ? ` (${e.actor_name})` : ''}`, provider_ref: null, attempts: 1 })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** What staff see before sending: recipients, amount, link and the exact messages. Creates the request if needed. */
export function paymentRequestPreview(orderId: string, actor: Actor) {
  const o = requireOrder(orderId);
  let req = openRequest(orderId);
  if (!req) {
    const blocker = paymentBlocker(orderId);
    if (blocker) return { blocker, request: null };
    req = createPaymentRequest(orderId, actor, { notify: false }).request;
  }
  const msg = paymentRequestMessage(orderId, req);
  const phone = (msg.phone ?? '').replace(/\D/g, '').replace(/^0/, '27');
  const history = requestHistory(orderId);
  const emailed = history.some((h) => h.channel === 'email' && (h.status === 'sent' || h.status === 'queued') && (h as any).to);
  return {
    blocker: null,
    request: { id: req.id, amount_cents: req.amount_cents, created_at: req.created_at, expires_at: req.expires_at },
    url: msg.url,
    customer: { name: o.customer_name, email: msg.to, phone: msg.phone },
    email: msg.to ? { available: true, to: msg.to, subject: msg.email.subject, text: msg.email.text } : { available: false, reason: 'No email address on this order. Add one under Customer, or use WhatsApp.' },
    // There is no WhatsApp sending connection: staff send the prepared message from their own phone
    whatsapp: { connected: false, text: msg.whatsapp, link: phone.length >= 9 ? `https://wa.me/${phone}?text=${encodeURIComponent(msg.whatsapp)}` : null, reason: phone.length >= 9 ? null : 'No mobile number on this order.' },
    already_sent: emailed,
    history,
  };
}

export function sendPaymentRequest(orderId: string, opts: { email: boolean; resend: boolean }, actor: Actor) {
  const req = openRequest(orderId);
  if (!req) throw conflict('There’s no open payment request. Finalize the order first.');
  if (!opts.email) throw badRequest('Choose how to send it.');
  const history = requestHistory(orderId);
  const prior = history.filter((h) => h.channel === 'email').length;
  if (prior && !opts.resend) throw conflict('This payment request has already been emailed. Choose “Send again” to send it once more.');
  const r = sendPaymentRequestEmail(orderId, req, prior);
  if (!r) throw conflict('This order has no email address.');
  addEvent(orderId, 'payment_request_sent', `Payment request ${prior ? 'emailed again' : 'emailed'} (${money(req.amount_cents)})`, actor, { request_id: req.id, resend: prior });
  audit(actor, 'payment.request_sent', 'order', orderId, `Payment request ${money(req.amount_cents)} emailed${prior ? ' again' : ''}`, { request_id: req.id });
  publish(['orders'], { orderId });
  return requestHistory(orderId);
}

/** Staff opened WhatsApp with the prepared message to send from their own phone. Recorded as such — not as delivered. */
export function recordWhatsAppHandoff(orderId: string, actor: Actor) {
  const req = openRequest(orderId);
  if (!req) throw conflict('There’s no open payment request.');
  addEvent(orderId, 'payment_request_whatsapp', `Payment request opened in WhatsApp to send by hand (${money(req.amount_cents)}) — delivery isn’t tracked`, actor, { request_id: req.id });
  return requestHistory(orderId);
}

/** A fresh payment-page link for someone who already holds the order link (e.g. from the order page). */
export function payPathFor(orderId: string): string | null {
  const req = openRequest(orderId);
  if (!req) return null;
  return `/pay/${payToken(req, Date.now() + 7 * 86400_000)}`;
}


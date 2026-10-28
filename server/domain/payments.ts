import { db, id, nextCounter, now, tx } from '../db/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { notify } from '../services/notify.js';
import { orderUrl, payUrl, siteUrl } from '../services/links.js';
import { layout, money, signOff } from '../services/templates.js';
import { paymentMethods } from '../services/payment-config.js';
import { raiseException } from './exceptions.js';
import { addEvent, orderMoney, requireOrder, transition, type PaymentState } from './orders.js';
import { customerContact, staffEmails } from './lifecycle.js';

/**
 * PAYMENTS. One authoritative record per order:
 *   payment_requests — what we asked the customer to pay (one open at a time; superseded when the
 *                      amount changes, so an old amount can't settle a changed order);
 *   payments         — money actually received and VERIFIED (by PayFast's confirmed notification,
 *                      or by a staff member checking the bank), each with a receipt number;
 *   payment_proofs   — EFT proof the customer uploaded. A proof never marks an order paid on its own.
 * orders.payment_state is derived from these by recomputePayment(); fulfilment status is separate.
 */

export type PaymentMethod = 'online' | 'eft' | 'cash' | 'card' | 'other';
export const METHOD_LABEL: Record<PaymentMethod, string> = { online: 'Online (PayFast)', eft: 'EFT', cash: 'Cash', card: 'Card', other: 'Other' };
export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  not_requested: 'Not requested yet',
  requested: 'Payment requested',
  pending: 'Online payment in progress',
  proof_submitted: 'Awaiting verification',
  partially_paid: 'Partly paid',
  paid: 'Paid',
  failed: 'Payment failed',
  refunded: 'Refunded',
};

export function openRequest(orderId: string) {
  return db().prepare("SELECT * FROM payment_requests WHERE order_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1").get(orderId) as any | undefined;
}

/** Works out the payment state from verified payments, proofs and requests. The only writer of payment_state. */
export function recomputePayment(orderId: string): PaymentState {
  const o = db().prepare('SELECT payment_state, payment_status FROM orders WHERE id = ?').get(orderId) as any;
  if (!o) return 'not_requested';
  const paid = (db().prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE order_id = ? AND status = 'verified'").get(orderId) as { s: number }).s;
  const m = orderMoney(orderId);
  const due = m.due_cents;
  const proofs =
    (db().prepare("SELECT COUNT(*) n FROM payment_proofs WHERE order_id = ? AND status = 'submitted'").get(orderId) as { n: number }).n +
    (db().prepare("SELECT COUNT(*) n FROM payment_declarations WHERE order_id = ? AND status = 'submitted'").get(orderId) as { n: number }).n;
  const req = openRequest(orderId);
  const lastFail = db().prepare("SELECT created_at FROM payments WHERE order_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1").get(orderId) as { created_at: string } | undefined;
  const manualPaid = paid === 0 && o.payment_status === 'paid' && o.payment_state === 'paid';
  let state: PaymentState;
  if (manualPaid) state = 'paid';
  else if (paid > 0 && (due == null ? false : paid >= due)) state = 'paid';
  else if (paid > 0) state = 'partially_paid';
  else if (proofs > 0) state = 'proof_submitted';
  else if (req && o.payment_state === 'pending') state = 'pending';
  else if (req && lastFail && lastFail.created_at > req.created_at) state = 'failed';
  else if (req) state = 'requested';
  else state = 'not_requested';
  const legacy = state === 'paid' ? 'paid' : ['partially_paid', 'proof_submitted', 'pending', 'requested', 'failed'].includes(state) ? 'pending' : 'unpaid';
  db().prepare('UPDATE orders SET amount_paid_cents = ?, payment_state = ?, payment_status = ?, updated_at = ? WHERE id = ?').run(paid, state, legacy, now(), orderId);
  if (state === 'paid' && req) db().prepare("UPDATE payment_requests SET status = 'paid', closed_at = ?, closed_reason = 'Paid' WHERE id = ?").run(now(), req.id);
  return state;
}

/** Why a payment request can't be sent yet, or null when it can. */
export function paymentBlocker(orderId: string): string | null {
  const o = requireOrder(orderId);
  if (o.status === 'cancelled') return 'The order is cancelled.';
  if (['review', 'needs_clarification'].includes(o.status) || !o.confirmed_at) return 'Confirm the order first.';
  const pending = (db().prepare("SELECT COUNT(*) n FROM order_amendments WHERE order_id = ? AND status = 'proposed' AND requires_approval = 1").get(orderId) as { n: number }).n;
  if (pending) return 'A proposed change is still waiting for the customer’s answer.';
  const blocking = (db().prepare("SELECT COUNT(*) n FROM exceptions WHERE order_id = ? AND status = 'open' AND severity = 'blocking'").get(orderId) as { n: number }).n;
  if (blocking) return 'There are open questions on this order.';
  if (!o.finalized_at) return 'Do the final weighing and finalize the order first.';
  const m = orderMoney(orderId);
  if (m.due_cents == null) return 'The final amount isn’t known yet.';
  if ((m.balance_cents ?? 0) <= 0) return 'Nothing is owed on this order.';
  const methods = paymentMethods();
  if (!methods.eft && !methods.online) return 'No payment method is set up yet (Settings → Payments).';
  return null;
}

/**
 * Creates the payment request for the balance owed. Any older open request is superseded, so
 * only the current amount can be paid. Returns the existing request if one for this exact amount is open.
 */
export function createPaymentRequest(orderId: string, actor: Actor, opts: { notify?: boolean } = {}) {
  const blocker = paymentBlocker(orderId);
  if (blocker) throw conflict(blocker);
  const m = orderMoney(orderId);
  const amount = m.balance_cents!;
  const existing = openRequest(orderId);
  if (existing && existing.amount_cents === amount) return { request: existing, created: false };
  const rid = id('prq_');
  const fin = db().prepare('SELECT id FROM order_finalizations WHERE order_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1').get(orderId) as { id: string } | undefined;
  const expires = new Date(Date.now() + getSettings().payments.linkDays * 86400_000).toISOString();
  tx(() => {
    if (existing) db().prepare("UPDATE payment_requests SET status = 'superseded', closed_at = ?, closed_reason = ? WHERE id = ?").run(now(), `Replaced by a request for ${money(amount)}`, existing.id);
    db().prepare("INSERT INTO payment_requests (id, order_id, amount_cents, status, created_by_kind, created_by, created_at, expires_at, finalization_id) VALUES (?,?,?,'open',?,?,?,?,?)").run(rid, orderId, amount, actor.kind, actor.userId, now(), expires, fin?.id ?? null);
    addEvent(orderId, 'payment_requested', `Payment requested: ${money(amount)}${existing ? ` (replaces ${money(existing.amount_cents)})` : ''}`, actor, { request_id: rid, amount_cents: amount });
    audit(actor, 'payment.requested', 'order', orderId, `Payment of ${money(amount)} requested`, { request_id: rid });
    recomputePayment(orderId);
  });
  const request = db().prepare('SELECT * FROM payment_requests WHERE id = ?').get(rid) as any;
  if (opts.notify) sendPaymentRequestEmail(orderId, request);
  publish(['orders'], { orderId });
  return { request, created: true };
}

/** The payment request message (email and WhatsApp share the facts). */
export function paymentRequestMessage(orderId: string, request: any) {
  const o = requireOrder(orderId);
  const c = customerContact(orderId);
  const s = getSettings();
  const url = payUrl(request);
  const support = [s.business.phone ? `WhatsApp or call us on ${s.business.phone}` : null, s.business.email ? `email ${s.business.email}` : null].filter(Boolean).join(', or ');
  const whatsapp = [
    `Hi ${c.firstName}, your ${s.business.name} order #${o.order_number} has been packed and weighed.`,
    `Amount due: ${money(request.amount_cents)}`,
    `Pay by EFT using your secure payment page (banking details, reference and proof upload): ${url}`,
    `Please use ${o.order_number} as your payment reference. Payment must reflect in our account before your order is released for ${o.fulfilment_type === 'collection' ? 'collection' : 'delivery'}.`,
    `Thank you!`,
  ].join('\n\n');
  const email = layout({
    subject: `Payment for your order #${o.order_number}: ${money(request.amount_cents)}`,
    preheader: `Your order is packed and weighed. Amount due ${money(request.amount_cents)}.`,
    greeting: `Hi ${c.firstName},`,
    intro: [`Your order #${o.order_number} has been packed and weighed, and the final amount is ready.`],
    blocks: [
      { facts: [['Amount due', money(request.amount_cents)], ['Payment reference', `${o.order_number}`]] },
      { heading: 'How to pay', paragraphs: ['Open your secure payment page for our banking details. Pay by EFT from your banking app using your order number as the reference, then upload your proof of payment (or tap “I’ve made payment”) on the same page.', `Payment must reflect in our account before your order is released for ${o.fulfilment_type === 'collection' ? 'collection' : 'delivery'}. We’ll let you know as soon as it has been verified.`] },
    ],
    cta: { label: 'Open my payment page', url },
    closing: [`Questions? ${support || 'Reply to this email'} with your order number #${o.order_number}.`, ...signOff()],
  });
  return { url, email, whatsapp, to: c.email, phone: o.contact_phone ?? o.customer_phone ?? null, firstName: c.firstName, customerId: c.customerId };
}

export function sendPaymentRequestEmail(orderId: string, request: any, resend = 0) {
  const m = paymentRequestMessage(orderId, request);
  if (!m.to) return null;
  const s = getSettings();
  return notify({ key: `payment_requested:${request.id}${resend ? `:resend${resend}` : ''}`, kind: 'payment_requested', audience: 'customer', to: [m.to], ...m.email, replyTo: s.business.email || null, orderId, customerId: m.customerId });
}

/** Called whenever an order's lines or weights change: an open request for the wrong amount stops being payable. */
export function supersedeIfAmountChanged(orderId: string) {
  const req = openRequest(orderId);
  if (!req) return;
  const m = orderMoney(orderId);
  if (m.balance_cents === req.amount_cents) return;
  db().prepare("UPDATE payment_requests SET status = 'superseded', closed_at = ?, closed_reason = 'Order total changed' WHERE id = ?").run(now(), req.id);
  const o = requireOrder(orderId);
  addEvent(orderId, 'payment_request_superseded', `Payment request for ${money(req.amount_cents)} withdrawn because the order total changed`, { userId: null, kind: 'system' }, { request_id: req.id });
  raiseException({ type: 'payment_issue', severity: 'warning', title: `Send #${o.order_number} a new payment request`, detail: `The order total changed after ${money(req.amount_cents)} was requested. The old request can no longer be paid.`, order_id: orderId, dedupe_key: `pay-superseded:${orderId}` });
  recomputePayment(orderId);
}

export interface RecordPaymentInput {
  method: PaymentMethod;
  amount_cents: number;
  request_id?: string | null;
  provider?: string | null;
  provider_ref?: string | null;
  proof_id?: string | null;
  note?: string | null;
}

/** Records money that has been VERIFIED as received. Gives it a receipt number and tells the customer and staff. */
export function recordVerifiedPayment(orderId: string, input: RecordPaymentInput, actor: Actor, verifiedBy: 'staff' | 'provider') {
  if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) throw badRequest('Enter the amount received.');
  const o = requireOrder(orderId);
  if (input.provider && input.provider_ref) {
    const dup = db().prepare('SELECT id FROM payments WHERE provider = ? AND provider_ref = ?').get(input.provider, input.provider_ref) as { id: string } | undefined;
    if (dup) return { payment: db().prepare('SELECT * FROM payments WHERE id = ?').get(dup.id) as any, duplicate: true };
  }
  const pid = id('pay_');
  let receipt = 0;
  tx(() => {
    receipt = nextCounter('receipt_number');
    db()
      .prepare("INSERT INTO payments (id, order_id, request_id, method, amount_cents, status, provider, provider_ref, receipt_number, verified_by, verified_by_kind, proof_id, note, created_at) VALUES (?,?,?,?,?,'verified',?,?,?,?,?,?,?,?)")
      .run(pid, orderId, input.request_id ?? null, input.method, input.amount_cents, input.provider ?? null, input.provider_ref ?? null, receipt, actor.userId, verifiedBy, input.proof_id ?? null, input.note?.trim().slice(0, 500) || null, now());
    addEvent(orderId, 'payment_verified', `Payment verified: ${money(input.amount_cents)} by ${METHOD_LABEL[input.method]} (receipt R${receipt})`, actor, { payment_id: pid, amount_cents: input.amount_cents, method: input.method, verified_by: verifiedBy, provider_ref: input.provider_ref ?? null });
    audit(actor, 'payment.verified', 'order', orderId, `#${o.order_number}: ${money(input.amount_cents)} ${METHOD_LABEL[input.method]} verified (${verifiedBy})`, { payment_id: pid });
    const state = recomputePayment(orderId);
    const m = orderMoney(orderId);
    if (m.due_cents != null && m.paid_cents > m.due_cents)
      raiseException({ type: 'payment_issue', severity: 'warning', title: `#${o.order_number} has been overpaid`, detail: `Received ${money(m.paid_cents)} against ${money(m.due_cents)} due. Arrange a refund or credit with the customer.`, order_id: orderId, dedupe_key: `overpaid:${orderId}` });
    void state;
  });
  db().prepare("UPDATE payment_declarations SET status = 'accepted', reviewed_by = ?, reviewed_at = ? WHERE order_id = ? AND status = 'submitted'").run(actor.userId, now(), orderId);
  recomputePayment(orderId);
  // Paid in full and already packed & finalized: it's ready to go out (one email covers both)
  let released = false;
  const cur = requireOrder(orderId);
  if (cur.payment_state === 'paid' && cur.status === 'packed' && cur.finalized_at) {
    transition(orderId, 'ready', actor, null, { system: true, silent: true, note: 'paid — ready for ' + (cur.fulfilment_type === 'collection' ? 'collection' : 'delivery') });
    released = true;
  }
  const c = customerContact(orderId);
  const s = getSettings();
  const after = requireOrder(orderId);
  if (c.email) {
    const f = s.fulfilment;
    const next = released
      ? after.fulfilment_type === 'collection'
        ? `Your order is now ready for collection from ${[f.collectionPlace, f.collectionAddress].filter(Boolean).join(', ')}${f.collectionHours ? ` (${f.collectionHours})` : ''}.`
        : 'Your order is now ready, and we’ll be in touch to arrange delivery.'
      : null;
    const e = layout({
      subject: released ? `Payment received — order #${o.order_number} is ready` : `Payment received for order #${o.order_number} — thank you`,
      preheader: `We've received ${money(input.amount_cents)}.`,
      greeting: `Hi ${c.firstName},`,
      intro: [`We've received and verified your payment of ${money(input.amount_cents)} for order #${o.order_number}. Thank you!`, ...(next ? [next] : [])],
      blocks: [{ facts: [['Receipt number', `R${receipt}`], ['Paid by', METHOD_LABEL[input.method]], ...(after.payment_state === 'partially_paid' ? [['Still to pay', money(orderMoney(orderId).balance_cents)] as [string, string]] : [])] }],
      cta: { label: 'View my receipt', url: orderUrl(orderId, `/receipt/${pid}`) },
      closing: signOff(),
    });
    notify({ key: `payment_verified:${pid}`, kind: 'payment_verified', audience: 'customer', to: [c.email], ...e, replyTo: s.business.email || null, orderId, customerId: c.customerId });
  }
  if (verifiedBy === 'provider') {
    const staff = staffEmails();
    const e = layout({ subject: `Paid online: #${o.order_number} — ${money(input.amount_cents)}`, preheader: `${o.customer_name} paid online.`, intro: [`${o.customer_name} paid ${money(input.amount_cents)} online for order #${o.order_number}. PayFast confirmed the payment.`], cta: { label: 'Open order', url: `${siteUrl()}/orders/${orderId}` } });
    notify({ key: `staff_paid_online:${pid}`, kind: 'staff_payment', audience: 'staff', to: staff, ...e, orderId });
  }
  publish(['orders'], { orderId });
  return { payment: db().prepare('SELECT * FROM payments WHERE id = ?').get(pid) as any, duplicate: false };
}

/** A payment attempt that didn't go through (cancelled or failed at the provider). Nothing is owed or paid by it. */
export function recordFailedPayment(orderId: string, input: { method: PaymentMethod; amount_cents: number; provider: string; provider_ref: string | null; request_id: string | null; note: string }) {
  if (input.provider_ref && db().prepare("SELECT 1 FROM payments WHERE provider = ? AND provider_ref = ?").get(input.provider, input.provider_ref)) return;
  db()
    .prepare("INSERT INTO payments (id, order_id, request_id, method, amount_cents, status, provider, provider_ref, verified_by_kind, note, created_at) VALUES (?,?,?,?,?,'failed',?,?,'provider',?,?)")
    .run(id('pay_'), orderId, input.request_id, input.method, input.amount_cents, input.provider, input.provider_ref, input.note, now());
  addEvent(orderId, 'payment_failed', `Online payment didn’t go through: ${input.note}`, { userId: null, kind: 'system', name: 'PayFast' }, { provider_ref: input.provider_ref });
  db().prepare("UPDATE orders SET payment_state = 'requested' WHERE id = ? AND payment_state = 'pending'").run(orderId);
  recomputePayment(orderId);
  publish(['orders'], { orderId });
}

/** Staff correction: a recorded payment was wrong (e.g. the EFT bounced). Kept in history, no longer counted. */
export function reversePayment(paymentId: string, reason: string, actor: Actor) {
  const p = db().prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as any;
  if (!p) throw notFound('That payment');
  if (p.status !== 'verified') throw conflict('Only a verified payment can be reversed.');
  if (!reason.trim()) throw badRequest('Say why the payment is being reversed.');
  tx(() => {
    db().prepare("UPDATE payments SET status = 'reversed', note = ? WHERE id = ?").run(`${p.note ? `${p.note} · ` : ''}Reversed: ${reason.trim()}`, paymentId);
    addEvent(p.order_id, 'payment_reversed', `Payment of ${money(p.amount_cents)} reversed: ${reason.trim()}`, actor, { payment_id: paymentId });
    audit(actor, 'payment.reversed', 'order', p.order_id, `Reversed payment R${p.receipt_number} (${money(p.amount_cents)}): ${reason.trim()}`);
    recomputePayment(p.order_id);
  });
  publish(['orders'], { orderId: p.order_id });
}

/** The customer-facing and staff summary of payments on one order. */
export function paymentSummary(orderId: string, opts: { forCustomer?: boolean } = {}) {
  const o = requireOrder(orderId);
  const m = orderMoney(orderId);
  const req = openRequest(orderId);
  const payments = db().prepare("SELECT id, method, amount_cents, status, receipt_number, provider_ref, note, verified_by_kind, created_at FROM payments WHERE order_id = ? ORDER BY created_at").all(orderId) as any[];
  const proofs = db().prepare('SELECT p.id, p.file_id, p.amount_claimed_cents, p.note, p.status, p.review_note, p.created_at, f.filename, f.mime, f.size FROM payment_proofs p JOIN files f ON f.id = p.file_id WHERE p.order_id = ? ORDER BY p.created_at').all(orderId) as any[];
  const methods = paymentMethods();
  return {
    state: o.payment_state,
    state_label: PAYMENT_STATE_LABEL[o.payment_state],
    money: m,
    request: req ? { id: req.id, amount_cents: req.amount_cents, created_at: req.created_at } : null,
    methods: { eft: methods.eft, online: methods.online },
    method_problems: opts.forCustomer ? [] : methods.problems,
    blocker: opts.forCustomer ? null : paymentBlocker(orderId),
    payments: payments
      .filter((p) => !opts.forCustomer || p.status === 'verified')
      .map((p) => ({ ...p, note: opts.forCustomer ? null : p.note, method_label: METHOD_LABEL[p.method as PaymentMethod] })),
    proofs: proofs.map((p) => ({ ...p, file_id: opts.forCustomer ? undefined : p.file_id, review_note: p.status === 'rejected' || !opts.forCustomer ? p.review_note : null })),
  };
}

// ── EFT proof of payment ─────────────────────────────────────

/** The customer uploads proof of an EFT. This does NOT mark the order paid: staff check the bank first. */
export function submitProof(orderId: string, fileId: string, input: { amount_cents: number | null; note: string | null }) {
  const o = requireOrder(orderId);
  if (o.status === 'cancelled') throw conflict('This order was cancelled.');
  if (o.payment_state === 'paid') throw conflict('This order is already paid. Thank you!');
  const recent = (db().prepare("SELECT COUNT(*) n FROM payment_proofs WHERE order_id = ? AND created_at > ?").get(orderId, new Date(Date.now() - 3600_000).toISOString()) as { n: number }).n;
  if (recent >= 5) throw conflict('We’ve already received several files for this order. Please contact us if something is wrong.');
  const pid = id('pp_');
  const customer: Actor = { userId: null, kind: 'customer', name: o.customer_name };
  tx(() => {
    db().prepare("INSERT INTO payment_proofs (id, order_id, file_id, amount_claimed_cents, note, status, created_at) VALUES (?,?,?,?,?,'submitted',?)").run(pid, orderId, fileId, input.amount_cents, input.note?.trim().slice(0, 500) || null, now());
    addEvent(orderId, 'proof_received', `Proof of payment uploaded${input.amount_cents ? ` (${money(input.amount_cents)})` : ''} — waiting to be checked`, customer, { proof_id: pid });
    recomputePayment(orderId);
  });
  raiseException({ type: 'payment_issue', severity: 'info', title: `Check the EFT for #${o.order_number}`, detail: `${o.customer_name} uploaded proof of payment${input.amount_cents ? ` for ${money(input.amount_cents)}` : ''}. Check the bank, then verify or reject it on the order.`, order_id: orderId, dedupe_key: `proof:${pid}` });
  const e = layout({ subject: `Proof of payment for #${o.order_number} — please check the bank`, preheader: o.customer_name, intro: [`${o.customer_name} uploaded proof of an EFT for order #${o.order_number}${input.amount_cents ? ` (${money(input.amount_cents)})` : ''}.`, 'The order is NOT marked paid until someone checks the money is in the account and verifies it in Terram.'], cta: { label: 'Review the payment', url: `${siteUrl()}/orders/${orderId}` } });
  notify({ key: `staff_proof:${pid}`, kind: 'staff_proof', audience: 'staff', to: staffEmails(), ...e, orderId });
  const c = customerContact(orderId);
  if (c.email) {
    const ce = layout({ subject: `We've received your proof of payment for #${o.order_number}`, preheader: 'We’ll confirm once we’ve checked it.', greeting: `Hi ${c.firstName},`, intro: ['Thank you. We’ve received your proof of payment and will confirm once we’ve checked that the money has arrived in our account.'], cta: { label: 'View my order', url: orderUrl(orderId) }, closing: signOff() });
    notify({ key: `proof_received:${pid}`, kind: 'proof_received', audience: 'customer', to: [c.email], ...ce, orderId, customerId: c.customerId });
  }
  publish(['orders', 'exceptions'], { orderId });
  return pid;
}

/** Staff decision on a proof: verify the amount actually received, or reject it with a reason the customer sees. */
export function reviewProof(proofId: string, decision: { accept: true; amount_cents: number; note?: string | null } | { accept: false; reason: string }, actor: Actor) {
  const p = db().prepare('SELECT * FROM payment_proofs WHERE id = ?').get(proofId) as any;
  if (!p) throw notFound('That proof of payment');
  if (p.status !== 'submitted') throw conflict('This proof has already been reviewed.');
  const o = requireOrder(p.order_id);
  if (decision.accept) {
    const res = recordVerifiedPayment(p.order_id, { method: 'eft', amount_cents: decision.amount_cents, request_id: openRequest(p.order_id)?.id ?? null, proof_id: proofId, note: decision.note ?? null }, actor, 'staff');
    db().prepare("UPDATE payment_proofs SET status = 'accepted', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?").run(actor.userId, now(), decision.note?.trim() || null, proofId);
    recomputePayment(p.order_id);
    db().prepare("UPDATE exceptions SET status = 'resolved', resolution = 'verified', resolved_by = ?, resolved_at = ? WHERE dedupe_key = ? AND status = 'open'").run(actor.userId, now(), `proof:${proofId}`);
    publish(['orders', 'exceptions'], { orderId: p.order_id });
    return res.payment;
  }
  const reason = decision.reason?.trim();
  if (!reason) throw badRequest('Say why, so the customer knows what to do.');
  tx(() => {
    db().prepare("UPDATE payment_proofs SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?").run(actor.userId, now(), reason.slice(0, 500), proofId);
    addEvent(p.order_id, 'proof_rejected', `Proof of payment not accepted: ${reason}`, actor, { proof_id: proofId });
    audit(actor, 'payment.proof_rejected', 'order', p.order_id, `#${o.order_number}: proof rejected (${reason})`);
    db().prepare("UPDATE exceptions SET status = 'resolved', resolution = 'rejected', resolved_by = ?, resolved_at = ? WHERE dedupe_key = ? AND status = 'open'").run(actor.userId, now(), `proof:${proofId}`);
    recomputePayment(p.order_id);
  });
  const c = customerContact(p.order_id);
  if (c.email) {
    const e = layout({ subject: `About your payment for order #${o.order_number}`, preheader: 'We couldn’t confirm the payment yet.', greeting: `Hi ${c.firstName},`, intro: [`We couldn’t confirm the payment from the proof you sent for order #${o.order_number}.`], blocks: [{ facts: [['Reason', reason]] }], cta: { label: 'View my order', url: orderUrl(p.order_id, '#pay') }, closing: ['If you think this is a mistake, please reply to this email or call us.', ...signOff()] });
    notify({ key: `proof_rejected:${proofId}`, kind: 'proof_rejected', audience: 'customer', to: [c.email], ...e, orderId: p.order_id, customerId: c.customerId });
  }
  publish(['orders', 'exceptions'], { orderId: p.order_id });
  return null;
}

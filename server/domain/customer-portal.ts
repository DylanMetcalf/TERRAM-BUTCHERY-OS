import crypto from 'node:crypto';
import { db, id, json, now, tx } from '../db/db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { getSettings } from '../services/settings.js';
import { notify } from '../services/notify.js';
import { orderToken, siteUrl } from '../services/links.js';
import { eftDetails, paymentMethods } from '../services/payment-config.js';
import { formatTimeframe, layout } from '../services/templates.js';
import { STATUS_LABEL, type OrderStatus } from '../../shared/workflow.js';
import { addEvent, getItems, orderMoney, requireOrder, transition, type OrderSummary } from './orders.js';
import { listAmendments } from './amendments.js';
import { paymentSummary } from './payments.js';
import { staffEmails } from './lifecycle.js';
import { requireProduct } from './products.js';
import { payPathFor } from './pay-page.js';

/**
 * What a customer sees about their own order — and nothing more. No staff notes, no internal
 * names, no other customers. Reached only through the order's signed link or after the customer
 * has proved their email address with a one-time code.
 */

export type Stage = 'received' | 'confirmed' | 'preparing' | 'weighing' | 'payment' | 'ready' | 'on_the_way' | 'completed';
const STAGES: { key: Stage; label: string }[] = [
  { key: 'received', label: 'Received' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'preparing', label: 'Being prepared' },
  { key: 'weighing', label: 'Final weighing' },
  { key: 'payment', label: 'Payment' },
  { key: 'ready', label: 'Ready' },
  { key: 'completed', label: 'Completed' },
];

export function stageOf(status: OrderStatus, o?: { finalized_at?: string | null; payment_state?: string | null }): Stage {
  if (status === 'packed') return o?.finalized_at ? 'payment' : 'weighing';
  switch (status) {
    case 'review':
    case 'needs_clarification':
      return 'received';
    case 'confirmed':
      return 'confirmed';
    case 'cutting':
    case 'cut':
    case 'packing':
      return 'preparing';
    case 'ready':
      return 'ready';
    case 'out_for_delivery':
      return 'on_the_way';
    case 'completed':
      return 'completed';
    default:
      return 'received';
  }
}

/** Plain words for the customer: what is happening and what (if anything) they need to do. */
function nextStep(o: OrderSummary, pendingChanges: number, pay: ReturnType<typeof paymentSummary>): { who: 'terram' | 'you' | 'done'; text: string } {
  if (o.status === 'cancelled') return { who: 'done', text: 'This order was cancelled.' };
  if (o.status === 'completed') return { who: 'done', text: 'This order is complete. Thank you!' };
  if (pendingChanges) return { who: 'you', text: 'We’ve suggested a change to your order. Please accept or decline it below.' };
  if (pay.request && pay.state !== 'paid' && pay.state !== 'proof_submitted') return { who: 'you', text: `Your order is packed and weighed. Please pay ${(pay.request.amount_cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' })} using your secure payment page. Payment must reflect before your order is released.` };
  if (pay.state === 'proof_submitted') return { who: 'terram', text: 'Thanks — your payment is awaiting verification. We’ll confirm as soon as it has reflected in our account.' };
  if (o.status === 'packed' && !o.finalized_at) return { who: 'terram', text: 'Your order is packed. We’re doing the final weighing and will send you the final amount to pay.' };
  if (o.status === 'packed' && o.finalized_at) return { who: 'terram', text: 'Your order is packed and weighed. We’ll send you a payment request with the final amount shortly.' };
  if (o.status === 'needs_clarification') return { who: 'terram', text: 'We need to check something about your order and will contact you shortly.' };
  if (o.status === 'on_hold') return { who: 'terram', text: 'Your order is on hold for the moment. We’ll be in touch.' };
  if (o.status === 'review') return { who: 'terram', text: 'We’re reviewing your products, quantities and availability, and will confirm your order soon.' };
  if (o.status === 'confirmed' || o.status === 'cutting' || o.status === 'cut' || o.status === 'packing' || o.status === 'packed')
    return { who: 'terram', text: 'Your order is confirmed and in our preparation queue. We’ll let you know when it’s ready.' };
  if (o.status === 'ready') return { who: 'terram', text: o.fulfilment_type === 'delivery' ? 'Payment received — your order is ready for delivery. We’ll be in touch to arrange it.' : o.fulfilment_type === 'collection' ? 'Your order is ready for collection.' : 'Your order is ready. We’ll be in touch to arrange collection or delivery.' };
  if (o.status === 'out_for_delivery') return { who: 'terram', text: 'Your order is on its way to you.' };
  return { who: 'terram', text: STATUS_LABEL[o.status] };
}

/** Customer-safe updates, written for the customer (internal summaries can mention staff and notes). */
function customerUpdates(orderId: string) {
  const rows = db()
    .prepare(
      `SELECT type, data, created_at FROM order_events WHERE order_id = ? AND type IN
        ('created','confirmed','timeframe_changed','status_changed','payment_requested','payment_verified','payment_failed','amendment_proposed','amendment_accepted','amendment_declined','invoice_issued','invoice_sent','proof_received','proof_rejected')
       ORDER BY created_at DESC LIMIT 40`,
    )
    .all(orderId) as { type: string; data: string; created_at: string }[];
  const out: { at: string; text: string }[] = [];
  for (const r of rows) {
    const d = json<any>(r.data, {});
    const money = (c: number) => `R${(c / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
    let text: string | null = null;
    switch (r.type) {
      case 'created': text = 'Order received'; break;
      case 'confirmed': text = `Order confirmed${d.expected_from ? ` · expected ${formatTimeframe(d.expected_from, d.expected_to)}` : ''}`; break;
      case 'timeframe_changed': text = `Expected timeframe updated to ${formatTimeframe(d.after?.from, d.after?.to) ?? 'be confirmed'}`; break;
      case 'status_changed':
        if (d.to === 'cutting' && d.from === 'confirmed') text = 'Preparation started';
        else if (d.to === 'packed') text = 'Packed';
        else if (d.to === 'ready') text = 'Ready';
        else if (d.to === 'out_for_delivery') text = 'Out for delivery';
        else if (d.to === 'completed') text = 'Completed';
        else if (d.to === 'cancelled') text = 'Cancelled';
        else if (d.to === 'on_hold') text = 'On hold';
        break;
      case 'payment_requested': text = `Payment requested: ${money(d.amount_cents ?? 0)}`; break;
      case 'payment_verified': text = `Payment received: ${money(d.amount_cents ?? 0)}`; break;
      case 'payment_failed': text = 'An online payment didn’t go through'; break;
      case 'proof_received': text = 'Proof of payment received'; break;
      case 'proof_rejected': text = 'We couldn’t match your proof of payment'; break;
      case 'amendment_proposed': text = 'We suggested a change'; break;
      case 'amendment_accepted': text = 'You accepted a change'; break;
      case 'amendment_declined': text = 'You declined a change'; break;
      case 'invoice_issued': text = 'Invoice issued'; break;
      case 'invoice_sent': text = 'Invoice sent'; break;
    }
    if (text) out.push({ at: r.created_at, text });
  }
  return out;
}

export function customerOrderView(orderId: string) {
  const o = requireOrder(orderId);
  const s = getSettings();
  const items = getItems(orderId);
  const amendments = listAmendments(orderId).filter((a) => a.status !== 'withdrawn');
  const pay = paymentSummary(orderId, { forCustomer: true });
  const pending = amendments.filter((a) => a.status === 'proposed' && a.requires_approval).length;
  const stage = stageOf(o.status, o);
  const steps = (o.fulfilment_type === 'delivery' ? [...STAGES.slice(0, 6), { key: 'on_the_way' as Stage, label: 'On the way' }, STAGES[6]] : STAGES).map((x) => x);
  const idx = steps.findIndex((x) => x.key === stage);
  const methods = paymentMethods();
  const showPay = !!pay.request && o.payment_state !== 'paid';
  const invoice = json<any>((db().prepare('SELECT invoice_details, invoice_file_id FROM orders WHERE id = ?').get(orderId) as any)?.invoice_details, null);
  const invoiceFile = (db().prepare('SELECT invoice_file_id FROM orders WHERE id = ?').get(orderId) as any)?.invoice_file_id ?? null;
  const fb = db().prepare('SELECT rating, comment, created_at FROM order_feedback WHERE order_id = ?').get(orderId) as any;
  const f = s.fulfilment;
  return {
    order_number: o.order_number,
    status: o.status,
    cancelled: o.status === 'cancelled',
    on_hold: o.status === 'on_hold' || o.status === 'needs_clarification',
    stage,
    steps: steps.map((x, i) => ({ ...x, done: o.status !== 'cancelled' && i < idx, current: o.status !== 'cancelled' && i === idx })),
    next: nextStep(o, pending, pay),
    customer_name: o.customer_name,
    submitted_at: o.created_at,
    confirmed_at: o.confirmed_at,
    completed_at: o.completed_at,
    preferred_date: o.requested_date && !o.confirmed_at ? o.requested_date : null,
    storage: o.storage,
    expected: o.expected_from ? { from: o.expected_from, to: o.expected_to, label: formatTimeframe(o.expected_from, o.expected_to) } : null,
    lead_time: s.orders.leadTimeText,
    fulfilment: {
      type: o.fulfilment_type,
      address: o.fulfilment_type !== 'collection' ? o.delivery_address : null,
      collection: o.fulfilment_type === 'collection' ? { place: f.collectionPlace, address: f.collectionAddress, hours: f.collectionHours } : null,
      delivery_fee_cents: o.delivery_fee_cents,
    },
    items: items.map((i) => ({
      id: i.id,
      name: i.name_snapshot,
      qty_label: i.qty_label,
      preparation: i.preparation_label || null,
      note: i.special_instructions,
      pricing: i.pricing,
      unit_price_cents: i.price_cents,
      price_unit: i.price_unit,
      est_cents: i.est_cents,
      final_cents: i.final_cents,
    })),
    special_request: o.special_request,
    money: orderMoney(orderId),
    payment: {
      ...pay,
      pay_url: showPay ? payPathFor(orderId) : null,
      finalized: !!o.finalized_at,
      show_options: showPay,
      online: showPay && methods.online,
      eft: showPay && methods.eft ? { ...eftDetails(), reference: `${o.order_number}` } : null,
      guidance: s.payments.guidance,
    },
    amendments: amendments.map((a) => ({ id: a.id, summary: a.summary, reason: a.reason, price_impact_cents: a.price_impact_cents, needs_answer: a.status === 'proposed' && a.requires_approval, status: a.status, created_at: a.created_at, responded_at: a.responded_at })),
    invoice: {
      status: o.invoice_status,
      requested_at: o.invoice_requested_at,
      billing_name: invoice?.billing_name ?? null,
      issued_on: o.invoice_issued_on,
      reference: ['issued', 'sent'].includes(o.invoice_status) ? o.invoice_ref : null,
      has_file: ['issued', 'sent'].includes(o.invoice_status) && !!invoiceFile,
    },
    updates: customerUpdates(orderId),
    can_cancel: ['review', 'needs_clarification'].includes(o.status),
    can_reorder: o.status === 'completed' || o.status === 'cancelled' || !!o.confirmed_at,
    feedback: s.retention.feedbackEnabled && o.status === 'completed' ? { given: fb ? { rating: fb.rating, comment: fb.comment } : null } : null,
    contact: { phone: s.business.phone, email: s.business.email, name: s.business.name },
    // Google review invitation only once this customer has actually received an order from us
    social: {
      instagram: s.business.instagramUrl || null,
      review: s.business.googleReviewUrl && (o.status === 'completed' || isReturningCustomer(o.customer_id, orderId)) ? s.business.googleReviewUrl : null,
    },
  };
}

// ── Customer actions ─────────────────────────────────────────

/** "I've changed my mind" before Terram confirms. After confirmation, they contact the farm instead. */
export function customerCancel(orderId: string, reason: string | null) {
  const o = requireOrder(orderId);
  if (o.status === 'cancelled') return requireOrder(orderId);
  if (!['review', 'needs_clarification'].includes(o.status)) throw conflict('Your order has already been confirmed. Please contact us to change or cancel it.');
  transition(orderId, 'cancelled', { userId: null, kind: 'customer', name: o.customer_name }, null, { system: true, note: `Cancelled by the customer${reason?.trim() ? `: ${reason.trim().slice(0, 300)}` : ''}` });
  const e = layout({ subject: `#${o.order_number} was cancelled by ${o.customer_name}`, preheader: 'Cancelled before confirmation.', intro: [`${o.customer_name} cancelled order #${o.order_number} before it was confirmed.${reason?.trim() ? ` They said: “${reason.trim()}”` : ''}`], cta: { label: 'Open order', url: `${siteUrl()}/orders/${orderId}` } });
  notify({ key: `staff_customer_cancelled:${orderId}`, kind: 'staff_cancelled', audience: 'staff', to: staffEmails(), ...e, orderId });
  return requireOrder(orderId);
}

export function submitFeedback(orderId: string, rating: number | null, comment: string | null) {
  const o = requireOrder(orderId);
  if (!getSettings().retention.feedbackEnabled) throw conflict('Feedback isn’t open at the moment.');
  if (o.status !== 'completed') throw conflict('You can leave feedback once your order is complete.');
  if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw badRequest('Choose 1 to 5 stars.');
  if (rating == null && !comment?.trim()) throw badRequest('Choose a rating or write a comment.');
  const existing = db().prepare('SELECT id FROM order_feedback WHERE order_id = ?').get(orderId);
  if (existing) throw conflict('Thanks — we already have your feedback for this order.');
  db().prepare('INSERT INTO order_feedback (id, order_id, rating, comment, created_at) VALUES (?,?,?,?,?)').run(id('fb_'), orderId, rating, comment?.trim().slice(0, 1500) || null, now());
  addEvent(orderId, 'feedback', `Customer feedback${rating ? `: ${rating}/5` : ''}${comment?.trim() ? ` · “${comment.trim().slice(0, 200)}”` : ''}`, { userId: null, kind: 'customer', name: o.customer_name });
}

/**
 * A new draft basket from a past order, using TODAY's prices, sizes and availability. Nothing is
 * submitted or charged: the customer reviews it on the order form and sends it themselves.
 */
export function reorderDraft(orderId: string) {
  const items = getItems(orderId);
  const lines = items.map((i) => {
    const p = requireProduct(i.product_id);
    const saleOption = i.sale_option ? p.sale_options.find((o) => o.label === i.sale_option)?.id ?? null : null;
    const prep: Record<string, string> = {};
    for (const [g, v] of Object.entries(i.preparation)) {
      const opt = p.preparations.find((o) => o.group_name === g && o.name === v && o.active && o.customer_visible);
      if (opt) prep[g] = v;
    }
    let problem: string | null = null;
    if (!p.customer_visible) problem = `${i.name_snapshot} is no longer on our list.`;
    else if (!p.active) problem = `${p.customer_name} is out of stock at the moment.`;
    else if (i.sale_option && !saleOption) problem = `${p.customer_name} isn’t sold as “${i.sale_option}” any more. Please choose a size.`;
    else if (!i.sale_option && p.sale_options.length) problem = `Please choose a size for ${p.customer_name}.`;
    return {
      product_id: p.id,
      name: p.customer_name,
      sale_option: saleOption,
      qty: { kind: i.qty.kind, count: i.qty.count, weight_g: i.qty.weight_g },
      preparation: prep,
      special_instructions: i.special_instructions ?? '',
      previous_unit_price_cents: i.price_cents,
      current_unit_price_cents: p.price_cents,
      problem,
    };
  });
  return { from_order: requireOrder(orderId).order_number, lines };
}

// ── Passwordless sign-in for order history ───────────────────

export const CUSTOMER_COOKIE = 'terram_customer';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const CODE_MINUTES = 15;

/** Orders belonging to an email address (the address given on the order, or on the customer's record). */
export function ordersForEmail(email: string) {
  return db()
    .prepare(
      `SELECT o.id, o.order_number, o.status, o.created_at, o.completed_at, o.estimated_total_cents, o.final_total_cents, o.payment_state, o.expected_from, o.expected_to, o.finalized_at,
         (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.status = 'active') AS item_count
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.customer_email = ? COLLATE NOCASE OR (o.customer_email IS NULL AND c.email = ? COLLATE NOCASE)
       ORDER BY o.created_at DESC LIMIT 100`,
    )
    .all(email, email) as any[];
}

/**
 * Sends a one-time code if this address has orders with us. The answer is the same either way,
 * so the form can't be used to find out who is a customer.
 */
export function requestSignInCode(emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw badRequest('Please enter a valid email address.');
  const recent = (db().prepare('SELECT COUNT(*) n FROM customer_codes WHERE email = ? AND created_at > ?').get(email, new Date(Date.now() - 15 * 60_000).toISOString()) as { n: number }).n;
  if (recent >= 3) return; // quietly: same response, no more codes for a while
  if (!ordersForEmail(email).length) return;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const cid = id('cc_');
  db().prepare('INSERT INTO customer_codes (id, email, code_hash, expires_at, created_at) VALUES (?,?,?,?,?)').run(cid, email, sha(`${email}:${code}`), new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(), now());
  const s = getSettings();
  const e = layout({
    subject: `Your ${s.business.name} sign-in code: ${code}`,
    preheader: `Use ${code} to see your orders. It expires in ${CODE_MINUTES} minutes.`,
    intro: [`Your code to see your ${s.business.name} orders is:`],
    blocks: [{ heading: 'Code', paragraphs: [code] }],
    closing: [`It expires in ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`],
  });
  notify({ key: `signin_code:${cid}`, kind: 'signin_code', audience: 'customer', to: [email], ...e });
}

export function verifySignInCode(emailRaw: string, codeRaw: string): { token: string; expires: Date } | null {
  const email = emailRaw.trim().toLowerCase();
  const code = codeRaw.replace(/\D/g, '');
  const row = db().prepare('SELECT * FROM customer_codes WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(email, now()) as any;
  if (!row) return null;
  if (row.attempts >= 5) return null;
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(sha(`${email}:${code}`)));
  if (!ok) {
    db().prepare('UPDATE customer_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return null;
  }
  return tx(() => {
    db().prepare('UPDATE customer_codes SET used_at = ? WHERE id = ?').run(now(), row.id);
    return createCustomerSession(email);
  });
}

/** A signed-in session for an email address already proven (by code or by the emailed link). */
export function createCustomerSession(emailRaw: string): { token: string; expires: Date } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 30 * 86400_000);
  db().prepare('INSERT INTO customer_sessions (id, email, created_at, expires_at) VALUES (?,?,?,?)').run(sha(token), emailRaw.trim().toLowerCase(), now(), expires.toISOString());
  return { token, expires };
}

/** Has this customer had an order completed before (not counting this one)? Used to invite Google reviews only from real customers. */
export function isReturningCustomer(customerId: string, excludeOrderId?: string): boolean {
  return !!db().prepare("SELECT 1 FROM orders WHERE customer_id = ? AND status = 'completed' AND id != ? LIMIT 1").get(customerId, excludeOrderId ?? '');
}

export function emailForSession(token: string | undefined): string | null {
  if (!token || token.length > 100) return null;
  const row = db().prepare('SELECT email, expires_at FROM customer_sessions WHERE id = ?').get(sha(token)) as { email: string; expires_at: string } | undefined;
  if (!row || row.expires_at < now()) return null;
  return row.email;
}

export function endCustomerSession(token: string | undefined) {
  if (token) db().prepare('DELETE FROM customer_sessions WHERE id = ?').run(sha(token));
}

export function accountView(email: string) {
  const orders = ordersForEmail(email).map((o) => ({ ...o, stage: stageOf(o.status, o), status_label: STATUS_LABEL[o.status as OrderStatus], link: `/o/${orderToken(o.id)}`, money: orderMoney(o.id) }));
  const consent = db().prepare('SELECT MAX(marketing_consent) c FROM customers WHERE email = ? COLLATE NOCASE').get(email) as { c: number | null };
  return { email, orders, preferences: { reminders: !!consent?.c } };
}

/** Optional reminders on or off, for every customer record with this (verified) email. */
export function setReminderPreference(email: string, on: boolean) {
  db().prepare('UPDATE customers SET marketing_consent = ?, marketing_consent_at = ? WHERE email = ? COLLATE NOCASE').run(on ? 1 : 0, now(), email);
}

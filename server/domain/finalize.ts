import { db, id, json, now, tx } from '../db/db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { notify } from '../services/notify.js';
import { orderUrl } from '../services/links.js';
import { layout, money, signOff } from '../services/templates.js';
import { getSettings } from '../services/settings.js';
import { addEvent, getItems, recomputeTotals, requireOrder } from './orders.js';
import { customerContact } from './lifecycle.js';
import { openRequest, recomputePayment } from './payments.js';

/**
 * FINAL WEIGHING. After packing, staff enter the actual weight of every weighed line and confirm
 * the fixed packs, then FINALIZE: the lines, weights, rates and total are copied into an
 * order_finalizations row and the order is locked at that amount. The payment request is always
 * for a finalized amount. Changing a finalized order means reopening it with a reason, which keeps
 * the old version, withdraws any open payment request and tells the customer.
 */

export interface FinalLine {
  item_id: string;
  name: string;
  size: string | null;
  qty_label: string;
  preparation: string | null;
  pricing: string;
  /** Actual packed weight for weighed lines. */
  weight_g: number | null;
  unit_price_cents: number | null;
  price_unit: 'kg' | 'each' | null;
  line_cents: number;
}

export interface FinalSnapshot {
  version: number;
  order_number: number;
  customer_name: string;
  storage: string | null;
  lines: FinalLine[];
  delivery_fee_cents: number;
  total_cents: number;
  finalized_at: string;
  finalized_by: string | null;
}

const needsWeight = (pricing: string | null) => pricing === 'by_weight' || pricing === 'estimate';

/** What still stops the order being finalized (empty = ready). */
export function finalizationProblems(orderId: string): string[] {
  const o = requireOrder(orderId);
  const out: string[] = [];
  if (o.finalized_at) return ['This order is already finalized.'];
  if (o.status !== 'packed') out.push(o.status === 'packing' || o.status === 'cut' ? 'Finish packing first (tick every item, then “Packed”).' : 'Final weighing happens once the order is packed.');
  const items = getItems(orderId);
  if (!items.length) out.push('The order has no items.');
  for (const i of items) {
    if (i.pricing === 'unpriced') out.push(`${i.name_snapshot} has no price.`);
    else if (needsWeight(i.pricing) && !i.packed_weight_g) out.push(`Enter the packed weight of ${i.qty_label} ${i.name_snapshot}.`);
  }
  const pending = (db().prepare("SELECT COUNT(*) n FROM order_amendments WHERE order_id = ? AND status = 'proposed' AND requires_approval = 1").get(orderId) as { n: number }).n;
  if (pending) out.push('A suggested change is still waiting for the customer’s answer.');
  const blocking = (db().prepare("SELECT COUNT(*) n FROM exceptions WHERE order_id = ? AND status = 'open' AND severity = 'blocking'").get(orderId) as { n: number }).n;
  if (blocking) out.push('There are open questions on this order.');
  return out;
}

export function latestFinalization(orderId: string): { id: string; version: number; snapshot: FinalSnapshot; total_cents: number; created_at: string; created_by_name: string | null } | null {
  const r = db().prepare('SELECT * FROM order_finalizations WHERE order_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1').get(orderId) as any;
  return r ? { ...r, snapshot: json<FinalSnapshot>(r.snapshot, null as any) } : null;
}

export function finalizationHistory(orderId: string) {
  return (db().prepare('SELECT id, version, total_cents, created_by_name, created_at, superseded_at, superseded_reason FROM order_finalizations WHERE order_id = ? ORDER BY version DESC').all(orderId) as any[]);
}

/**
 * Locks the order at its final weighed amount. `packsConfirmed` is the packer's confirmation that
 * the fixed-pack quantities on the order are what went into the box.
 */
export function finalizeOrder(orderId: string, actor: Actor, opts: { packsConfirmed: boolean }) {
  const problems = finalizationProblems(orderId);
  if (problems.length) throw conflict(problems[0]);
  const items = getItems(orderId);
  if (items.some((i) => i.pricing === 'exact') && !opts.packsConfirmed) throw badRequest('Confirm the pack quantities first.');
  let fid = '';
  tx(() => {
    recomputeTotals(orderId);
    const o = requireOrder(orderId);
    const fresh = getItems(orderId);
    const lines: FinalLine[] = fresh.map((i) => {
      if (i.final_cents == null) throw conflict(`${i.name_snapshot} has no final price.`);
      return {
        item_id: i.id,
        name: i.name_snapshot,
        size: i.sale_option ?? null,
        qty_label: i.qty_label,
        preparation: i.preparation_label || null,
        pricing: i.pricing ?? 'exact',
        weight_g: needsWeight(i.pricing) ? i.packed_weight_g : null,
        unit_price_cents: i.price_cents,
        price_unit: i.price_unit,
        line_cents: i.final_cents,
      };
    });
    const fee = o.delivery_fee_cents ?? 0;
    const total = lines.reduce((t, l) => t + l.line_cents, fee);
    if (o.final_total_cents !== total) throw conflict('The total didn’t add up. Please try again.');
    const version = (o.finalized_version ?? 0) + 1;
    const ts = now();
    const snapshot: FinalSnapshot = { version, order_number: o.order_number, customer_name: o.customer_name, storage: o.storage ?? null, lines, delivery_fee_cents: fee, total_cents: total, finalized_at: ts, finalized_by: actor.name ?? null };
    fid = id('fin_');
    db().prepare('INSERT INTO order_finalizations (id, order_id, version, snapshot, total_cents, created_by, created_by_name, created_at) VALUES (?,?,?,?,?,?,?,?)').run(fid, orderId, version, JSON.stringify(snapshot), total, actor.userId, actor.name ?? null, ts);
    db().prepare('UPDATE orders SET finalized_at = ?, finalized_by = ?, finalized_version = ?, updated_at = ? WHERE id = ?').run(ts, actor.userId, version, ts, orderId);
    addEvent(orderId, 'finalized', `Final weighing done — order finalized at ${money(total)}${version > 1 ? ` (version ${version})` : ''}`, actor, { finalization_id: fid, version, total_cents: total });
    audit(actor, 'order.finalized', 'order', orderId, `#${o.order_number} finalized at ${money(total)} (v${version})`, { finalization_id: fid });
    recomputePayment(orderId);
  });
  publish(['orders'], { orderId });
  return latestFinalization(orderId)!;
}

/**
 * Unlocks a finalized order so it can be changed. Not allowed once money has been verified or an
 * invoice issued (reverse the payment / cancel the invoice first). The old version is kept, and an
 * open payment request is withdrawn so the old amount can't be paid.
 */
export function reopenFinalized(orderId: string, reason: string, actor: Actor) {
  const o = requireOrder(orderId);
  const why = reason.trim();
  if (!why) throw badRequest('Say why the order needs to change. It’s kept in the history.');
  if (!o.finalized_at) throw conflict('This order isn’t finalized.');
  if ((o.amount_paid_cents ?? 0) > 0) throw conflict('A payment has already been verified on this order. Reverse it first (it stays in the history), then reopen.');
  if (['issued', 'sent'].includes(o.invoice_status)) throw conflict('An invoice has already been issued for this order. Move the invoice back to “in progress” first.');
  if (['ready', 'out_for_delivery', 'completed', 'cancelled'].includes(o.status)) throw conflict('This order has already been released.');
  const req = openRequest(orderId);
  const wasSent = req ? !!db().prepare("SELECT 1 FROM notifications WHERE event_key LIKE ? AND status = 'sent'").get(`payment_requested:${req.id}%`) : false;
  tx(() => {
    const ts = now();
    db().prepare('UPDATE order_finalizations SET superseded_at = ?, superseded_by = ?, superseded_reason = ? WHERE order_id = ? AND superseded_at IS NULL').run(ts, actor.userId, why.slice(0, 500), orderId);
    db().prepare('UPDATE orders SET finalized_at = NULL, finalized_by = NULL, updated_at = ? WHERE id = ?').run(ts, orderId);
    if (req) db().prepare("UPDATE payment_requests SET status = 'superseded', closed_at = ?, closed_reason = ? WHERE id = ?").run(ts, `Order reopened: ${why.slice(0, 200)}`, req.id);
    addEvent(orderId, 'finalization_reopened', `Final amount reopened for changes: ${why}${req ? ` · payment request for ${money(req.amount_cents)} withdrawn` : ''}`, actor, { reason: why, request_id: req?.id ?? null });
    audit(actor, 'order.reopened_final', 'order', orderId, `#${o.order_number} final amount reopened: ${why}`);
    recomputePayment(orderId);
  });
  // Only tell the customer if they were actually asked to pay the old amount
  const c = customerContact(orderId);
  if (req && wasSent && c.email) {
    const s = getSettings();
    const e = layout({
      subject: `Update to the payment for order #${o.order_number}`,
      preheader: 'Please don’t pay the earlier amount yet.',
      greeting: `Hi ${c.firstName},`,
      intro: [`We need to make a change to your order #${o.order_number}, so the payment request for ${money(req.amount_cents)} has been withdrawn. Please don’t pay that amount.`, 'We’ll send you the updated amount as soon as your order is finalized again.'],
      cta: { label: 'View my order', url: orderUrl(orderId) },
      closing: ['If you’ve already paid, don’t worry — reply to this email and we’ll sort it out.', ...signOff()],
    });
    notify({ key: `payment_withdrawn:${req.id}`, kind: 'payment_withdrawn', audience: 'customer', to: [c.email], ...e, replyTo: s.business.email || null, orderId, customerId: c.customerId });
  }
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

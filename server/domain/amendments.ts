import { db, id, json, now, tx } from '../db/db.js';
import { formatQty, type Qty } from '../../shared/quantity.js';
import { priceLine } from '../../shared/pricing.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { notify } from '../services/notify.js';
import { orderUrl, siteUrl } from '../services/links.js';
import { layout, money, signOff, formatTimeframe } from '../services/templates.js';
import { raiseException } from './exceptions.js';
import { addEvent, changeTimeframe, getItem, quoteItem, removeItem, requireOrder, updateItem, validateItem } from './orders.js';
import { customerContact, staffEmails } from './lifecycle.js';
import { requireProduct } from './products.js';

/**
 * ORDER AMENDMENTS proposed by Terram (a product ran out, a weight changes the price, the date moves…).
 * Changes to what the customer agreed to need their approval: the customer accepts or declines from
 * their order page, and only an accepted change is applied. Nothing is swapped or repriced silently.
 */

export type AmendmentKind = 'change_qty' | 'remove_item' | 'replace_product' | 'timeframe' | 'other';

export interface AmendmentInput {
  kind: AmendmentKind;
  reason: string;
  item_id?: string | null;
  /** change_qty / replace_product: the new line. */
  product_id?: string | null;
  sale_option?: string | null;
  qty?: Qty | null;
  preparation?: Record<string, string> | null;
  /** timeframe */
  expected_from?: string | null;
  expected_to?: string | null;
  /** other: the question or information for the customer. */
  message?: string | null;
  /** Only for timeframe/other: false just informs the customer. Item changes always need approval. */
  requires_approval?: boolean;
}

export function listAmendments(orderId: string) {
  return (db().prepare('SELECT * FROM order_amendments WHERE order_id = ? ORDER BY created_at DESC').all(orderId) as any[]).map((a) => ({ ...a, proposal: json(a.proposal, {}), requires_approval: !!a.requires_approval }));
}

export function proposeAmendment(orderId: string, input: AmendmentInput, actor: Actor) {
  const o = requireOrder(orderId);
  if (['completed', 'cancelled'].includes(o.status)) throw conflict('This order is finished and can’t be changed.');
  const reason = input.reason?.trim();
  if (!reason) throw badRequest('Explain the reason. The customer will see it.');
  let summary = '';
  let impact: number | null = null;
  let proposal: Record<string, unknown> = {};
  let needsApproval = true;
  if (input.kind === 'change_qty' || input.kind === 'remove_item' || input.kind === 'replace_product') {
    if (!input.item_id) throw badRequest('Choose the item.');
    const it = getItem(input.item_id);
    if (it.order_id !== orderId || it.status !== 'active') throw notFound('That item');
    const before = it.final_cents ?? it.est_cents ?? 0;
    if (input.kind === 'remove_item') {
      summary = `Remove ${it.qty_label} ${it.name_snapshot}`;
      impact = -(before || 0);
      proposal = { item_id: it.id };
    } else {
      const productId = input.kind === 'replace_product' ? input.product_id : it.product_id;
      if (!productId) throw badRequest('Choose the replacement product.');
      if (!input.qty) throw badRequest('Give the new quantity.');
      const v = validateItem({ product_id: productId, sale_option: input.sale_option ?? null, qty: input.qty, preparation: input.kind === 'replace_product' ? input.preparation ?? {} : input.preparation ?? it.preparation });
      // A quantity change keeps the unit price agreed on the order; a replacement is priced as it is today
      const unit = input.kind === 'change_qty' ? it.price_cents : quoteItem(v).unit_price_cents;
      const priceUnit = input.kind === 'change_qty' ? it.price_unit : v.product.price_unit;
      const q = priceLine({ qty: v.qty, unitPriceCents: unit, priceUnit, saleKind: v.sale_option?.kind ?? null, pieceGrams: v.sale_option ? v.sale_option.grams : v.product.typical_piece_g });
      const newLabel = v.sale_option && v.sale_option.kind === 'piece' ? `${v.qty.count} × ${v.sale_option.label}` : formatQty(v.qty, v.product.piece_noun);
      summary = input.kind === 'change_qty' ? `${it.name_snapshot}: ${it.qty_label} → ${newLabel}` : `Replace ${it.qty_label} ${it.name_snapshot} with ${newLabel} ${v.product.customer_name}${v.preparation_label ? ` (${v.preparation_label})` : ''}`;
      impact = q.cents == null ? null : q.cents - (before || 0);
      proposal = { item_id: it.id, product_id: v.product.id, sale_option: v.sale_option?.id ?? null, qty: v.qty, preparation: v.preparation, new_label: newLabel, new_cents: q.cents };
    }
  } else if (input.kind === 'timeframe') {
    if (!input.expected_from) throw badRequest('Choose the new expected date.');
    summary = `New expected timeframe: ${formatTimeframe(input.expected_from, input.expected_to ?? null)}`;
    proposal = { expected_from: input.expected_from, expected_to: input.expected_to ?? null };
    needsApproval = input.requires_approval !== false;
  } else {
    const msg = input.message?.trim();
    if (!msg) throw badRequest('Write the message for the customer.');
    summary = msg.slice(0, 500);
    proposal = { message: msg };
    needsApproval = input.requires_approval !== false;
  }
  const aid = id('am_');
  tx(() => {
    db()
      .prepare("INSERT INTO order_amendments (id, order_id, item_id, kind, reason, proposal, summary, price_impact_cents, requires_approval, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,'proposed',?,?)")
      .run(aid, orderId, input.item_id ?? null, input.kind, reason.slice(0, 500), JSON.stringify(proposal), summary, impact, needsApproval ? 1 : 0, actor.userId, now());
    addEvent(orderId, 'amendment_proposed', `${needsApproval ? 'Change proposed to the customer' : 'Customer informed'}: ${summary} · ${reason}`, actor, { amendment_id: aid, impact_cents: impact });
    audit(actor, 'order.amendment_proposed', 'order', orderId, `#${o.order_number}: ${summary}`, { reason });
    if (!needsApproval) applyAmendment(aid, actor);
  });
  // Tell the customer, and ask for their answer when it's needed
  const c = customerContact(orderId);
  if (c.email) {
    const s = getSettings();
    const e = layout({
      subject: needsApproval ? `Please check a change to your order #${o.order_number}` : `An update about your order #${o.order_number}`,
      preheader: summary,
      greeting: `Hi ${c.firstName},`,
      intro: [needsApproval ? `We need your OK on a change to your order #${o.order_number}.` : `We'd like to let you know about an update to your order #${o.order_number}.`],
      blocks: [{ facts: [['Change', summary], ['Why', reason], ...(impact != null && impact !== 0 ? [['Price difference', `${impact > 0 ? '+' : '−'}${money(Math.abs(impact))}`] as [string, string]] : [])] }],
      cta: { label: needsApproval ? 'Accept or decline the change' : 'View my order', url: orderUrl(orderId, '#changes') },
      closing: [needsApproval ? "Nothing changes on your order until you've answered." : '', ...signOff()].filter(Boolean),
    });
    notify({ key: `amendment_proposed:${aid}`, kind: 'amendment_proposed', audience: 'customer', to: [c.email], ...e, replyTo: s.business.email || null, orderId, customerId: c.customerId });
  } else if (needsApproval) {
    raiseException({ type: 'customer_question', severity: 'info', title: `Call ${o.customer_name} about a change to #${o.order_number}`, detail: `They have no email address, so they won't see the proposed change online: ${summary}.`, order_id: orderId, dedupe_key: `amend-noemail:${aid}` });
  }
  publish(['orders'], { orderId });
  return listAmendments(orderId).find((a) => a.id === aid)!;
}

/** Makes an approved (or informational) change on the order itself. */
function applyAmendment(aid: string, actor: Actor) {
  const a = db().prepare('SELECT * FROM order_amendments WHERE id = ?').get(aid) as any;
  const p = json<any>(a.proposal, {});
  const ctx = { reason: `Agreed change: ${a.reason}` };
  if (a.kind === 'remove_item') removeItem(p.item_id, actor, ctx);
  else if (a.kind === 'change_qty' || a.kind === 'replace_product') {
    const product = requireProduct(p.product_id);
    updateItem(p.item_id, { product_id: product.id, sale_option: p.sale_option, qty: p.qty, preparation: p.preparation }, actor, ctx);
  } else if (a.kind === 'timeframe') changeTimeframe(a.order_id, { expected_from: p.expected_from, expected_to: p.expected_to, reason: a.reason }, actor);
  db().prepare("UPDATE order_amendments SET status = 'applied', applied_at = ? WHERE id = ?").run(now(), aid);
}

/** The customer's answer. Accepting applies the change; declining leaves the order as it was and tells Terram. */
export function respondToAmendment(orderId: string, aid: string, accept: boolean, note: string | null) {
  const a = db().prepare('SELECT * FROM order_amendments WHERE id = ? AND order_id = ?').get(aid, orderId) as any;
  if (!a) throw notFound('That change');
  if (a.status !== 'proposed' || !a.requires_approval) return { already: true, status: a.status };
  const o = requireOrder(orderId);
  const customer: Actor = { userId: null, kind: 'customer', name: o.customer_name };
  tx(() => {
    db().prepare('UPDATE order_amendments SET status = ?, responded_at = ?, response_note = ? WHERE id = ?').run(accept ? 'accepted' : 'declined', now(), note?.trim().slice(0, 500) || null, aid);
    addEvent(orderId, accept ? 'amendment_accepted' : 'amendment_declined', `Customer ${accept ? 'accepted' : 'declined'}: ${a.summary}${note?.trim() ? ` · “${note.trim()}”` : ''}`, customer, { amendment_id: aid });
    if (accept) applyAmendment(aid, customer);
    else raiseException({ type: 'amendment_declined', severity: 'warning', title: `${o.customer_name} declined a change to #${o.order_number}`, detail: `${a.summary}${note?.trim() ? `. They said: “${note.trim()}”` : ''}. Contact them to agree what happens next.`, order_id: orderId, dedupe_key: `amend-declined:${aid}` });
  });
  const staff = staffEmails();
  const e = layout({ subject: `#${o.order_number}: ${o.customer_name} ${accept ? 'accepted' : 'declined'} the change`, preheader: a.summary, intro: [`${o.customer_name} ${accept ? 'accepted' : 'declined'}: ${a.summary}.`, ...(note?.trim() ? [`Their note: “${note.trim()}”`] : []), accept ? 'The change has been made on the order.' : 'The order has not been changed. Please contact them.'], cta: { label: 'Open order', url: `${siteUrl()}/orders/${orderId}` } });
  notify({ key: `staff_amendment_answer:${aid}`, kind: 'staff_amendment', audience: 'staff', to: staff, ...e, orderId });
  publish(['orders', 'exceptions'], { orderId });
  return { already: false, status: accept ? 'applied' : 'declined' };
}

export function withdrawAmendment(aid: string, actor: Actor) {
  const a = db().prepare('SELECT * FROM order_amendments WHERE id = ?').get(aid) as any;
  if (!a) throw notFound('That change');
  if (a.status !== 'proposed') throw conflict('Only a change still waiting for an answer can be withdrawn.');
  db().prepare("UPDATE order_amendments SET status = 'withdrawn', responded_at = ? WHERE id = ?").run(now(), aid);
  addEvent(a.order_id, 'amendment_withdrawn', `Proposed change withdrawn: ${a.summary}`, actor, { amendment_id: aid });
  publish(['orders'], { orderId: a.order_id });
}

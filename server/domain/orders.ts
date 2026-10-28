import { db, id, json, nextCounter, now, tx } from '../db/db.js';
import {
  canTransition,
  EDITABLE_STATUSES,
  isPrivilegedTransition,
  STATUS_LABEL,
  type FulfilmentType,
  type OrderSource,
  type OrderStatus,
  type PaymentStatus,
} from '../../shared/workflow.js';
import { formatQty, qtyEquals, validateQty, type Qty } from '../../shared/quantity.js';
import { deliveryFeeCents } from '../../shared/delivery.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { isValidYmd } from '../lib/time.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { createCustomer, enrichCustomer, requireCustomer, type CustomerInput } from './customers.js';
import { requireProduct, resolvePreparation, type Product } from './products.js';
import { finalLine, priceLine, totalOf, withSurcharge, type Pricing, type SaleOption } from '../../shared/pricing.js';
import { onOrderConfirmed, onOrderStatusChanged, onTimeframeChanged } from './lifecycle.js';
import { recomputePayment, supersedeIfAmountChanged } from './payments.js';
import { can, type Role } from '../../shared/permissions.js';

/**
 * CENTRAL ORDER ENGINE
 * Every channel — form, WhatsApp, email, phone, import, staff — creates and
 * changes orders only through these functions. They validate against the
 * product dictionary, enforce the state machine and write an event for
 * every meaningful change.
 */

export interface ItemInput {
  product_id: string;
  /** Required on the customer form for products with pack/piece options; qty then only gives the count. */
  sale_option?: string | null;
  qty: Qty;
  preparation?: Record<string, string>;
  special_instructions?: string | null;
  source_text?: string | null;
}

export interface CreateOrderInput {
  customer: { id: string } | { new: CustomerInput };
  source: OrderSource;
  items: ItemInput[];
  status: 'review' | 'confirmed' | 'needs_clarification';
  resume_status?: 'review' | 'confirmed';
  fulfilment_type?: FulfilmentType | null;
  requested_date?: string | null;
  time_window?: string | null;
  delivery_address?: string | null;
  delivery_notes?: string | null;
  contact_phone?: string | null;
  /** Where order emails go (the customer's address as given on this order). */
  customer_email?: string | null;
  notes?: string | null;
  payment_status?: PaymentStatus;
  /** Billing details when the customer asked for an invoice. */
  invoice?: InvoiceRequestDetails | null;
  idempotency_key?: string | null;
  import_batch_id?: string | null;
  message_ids?: string[];
  created_summary?: string;
  /** Extra detail stored on the "created" event (e.g. amendments folded in during import). */
  created_data?: Record<string, unknown>;
}

export interface InvoiceRequestDetails {
  billing_name: string;
  company?: string | null;
  billing_email: string;
  billing_address?: string | null;
  vat_number?: string | null;
  instructions?: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  product_category: string;
  piece_noun: string;
  qty: Qty;
  qty_label: string;
  preparation: Record<string, string>;
  preparation_label: string;
  special_instructions: string | null;
  source_text: string | null;
  status: 'active' | 'removed';
  cut_at: string | null;
  packed_at: string | null;
  packed_weight_g: number | null;
  /** Price per unit agreed for this line (snapshot, surcharge included). */
  price_cents: number | null;
  price_unit: 'kg' | 'each' | null;
  surcharge_pct: number | null;
  sale_option: string | null;
  sale_option_kind: 'pack' | 'piece' | null;
  /** Name as it was when ordered (customer-facing documents use this). */
  name_snapshot: string;
  pricing: Pricing | null;
  est_cents: number | null;
  final_cents: number | null;
  sort_order: number;
}

export interface OrderSummary {
  id: string;
  order_number: number;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  source: OrderSource;
  status: OrderStatus;
  resume_status: OrderStatus | null;
  fulfilment_type: FulfilmentType | null;
  requested_date: string | null;
  time_window: string | null;
  delivery_address: string | null;
  delivery_notes: string | null;
  contact_phone: string | null;
  /** Distance from the shop for a delivery, and the fee it works out to (see Settings). */
  delivery_km: number | null;
  delivery_fee_cents: number | null;
  notes: string | null;
  /** Free-text request from the order form's Special requests section (not on the price list). */
  special_request: string | null;
  payment_status: PaymentStatus;
  accounting_ref: string | null;
  customer_notified_at: string | null;
  import_batch_id: string | null;
  customer_email: string | null;
  confirmed_by: string | null;
  expected_from: string | null;
  expected_to: string | null;
  estimated_total_cents: number | null;
  confirmed_total_cents: number | null;
  final_total_cents: number | null;
  amount_paid_cents: number;
  payment_state: PaymentState;
  payment_choice: string | null;
  invoice_status: InvoiceStatus;
  invoice_requested_at: string | null;
  invoice_ref: string | null;
  invoice_issued_on: string | null;
  invoice_sent_at: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  /** Fresh or frozen, as the customer chose. */
  storage: 'fresh' | 'frozen' | null;
  /** Set when final weighing is done: the order is locked at its final amount. */
  finalized_at: string | null;
  finalized_by: string | null;
  finalized_version: number;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
  item_count: number;
  items_cut: number;
  items_packed: number;
  open_exceptions: number;
  items_preview: string;
}

export type PaymentState = 'not_requested' | 'requested' | 'pending' | 'proof_submitted' | 'partially_paid' | 'paid' | 'failed' | 'refunded';
export type InvoiceStatus = 'not_requested' | 'requested' | 'in_progress' | 'issued' | 'sent' | 'cancelled';

const ORDER_SELECT = `
  SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
    (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.status = 'active') AS item_count,
    (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.status = 'active' AND i.cut_at IS NOT NULL) AS items_cut,
    (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.status = 'active' AND i.packed_at IS NOT NULL) AS items_packed,
    (SELECT COUNT(*) FROM exceptions e WHERE e.order_id = o.id AND e.status = 'open') AS open_exceptions,
    (SELECT GROUP_CONCAT(label, ', ') FROM (
       SELECT CASE i.qty_kind
         WHEN 'weight' THEN (CASE WHEN i.weight_g >= 1000 THEN printf('%gkg', i.weight_g / 1000.0) ELSE i.weight_g || 'g' END)
         WHEN 'portions' THEN i.count || '×' || (CASE WHEN i.weight_g >= 1000 THEN printf('%gkg', i.weight_g / 1000.0) ELSE i.weight_g || 'g' END)
         ELSE i.count || '' END || ' ' || p.canonical_name AS label
       FROM order_items i JOIN products p ON p.id = i.product_id
       WHERE i.order_id = o.id AND i.status = 'active' ORDER BY i.sort_order LIMIT 6)) AS items_preview
  FROM orders o JOIN customers c ON c.id = o.customer_id`;

function mapOrder(r: any): OrderSummary {
  return { ...r, items_preview: r.items_preview ?? '' };
}

export function getOrderSummary(orderId: string): OrderSummary | undefined {
  const r = db().prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(orderId);
  return r ? mapOrder(r) : undefined;
}

export function requireOrder(orderId: string): OrderSummary {
  const o = getOrderSummary(orderId);
  if (!o) throw notFound('That order');
  return o;
}

export function orderByNumber(n: number): OrderSummary | undefined {
  const r = db().prepare(`${ORDER_SELECT} WHERE o.order_number = ?`).get(n);
  return r ? mapOrder(r) : undefined;
}

const ITEM_SELECT = `SELECT i.*, p.canonical_name AS product_name, p.category AS product_category, p.piece_noun,
    COALESCE(i.unit_price_cents, p.price_cents) AS price_cents, COALESCE(i.price_unit_snap, p.price_unit) AS price_unit
  FROM order_items i JOIN products p ON p.id = i.product_id`;

export function getItems(orderId: string, includeRemoved = false): OrderItem[] {
  const rows = db()
    .prepare(
      `${ITEM_SELECT} WHERE i.order_id = ? ${includeRemoved ? '' : "AND i.status = 'active'"} ORDER BY i.sort_order, i.created_at`,
    )
    .all(orderId) as any[];
  return rows.map(mapItem);
}

export function mapItem(r: any): OrderItem {
  const qty: Qty = { kind: r.qty_kind, count: r.count, weight_g: r.weight_g };
  return {
    id: r.id,
    order_id: r.order_id,
    product_id: r.product_id,
    product_name: r.product_name,
    product_category: r.product_category,
    piece_noun: r.piece_noun,
    qty,
    qty_label: r.sale_option && r.sale_option_kind === 'piece' ? `${r.count} × ${r.sale_option}` : formatQty(qty, r.piece_noun),
    preparation: json(r.preparation, {}),
    preparation_label: r.preparation_label,
    special_instructions: r.special_instructions,
    source_text: r.source_text,
    status: r.status,
    cut_at: r.cut_at,
    packed_at: r.packed_at,
    packed_weight_g: r.packed_weight_g,
    price_cents: r.price_cents,
    price_unit: r.price_unit,
    surcharge_pct: r.surcharge_pct ?? null,
    sale_option: r.sale_option ?? null,
    sale_option_kind: r.sale_option_kind ?? null,
    name_snapshot: r.product_name_snap ?? r.product_name,
    pricing: r.pricing ?? null,
    est_cents: r.est_cents ?? null,
    final_cents: r.final_cents ?? null,
    sort_order: r.sort_order,
  };
}

export function getItem(itemId: string): OrderItem {
  const r = db()
    .prepare(
      `${ITEM_SELECT} WHERE i.id = ?`,
    )
    .get(itemId);
  if (!r) throw notFound('That item');
  return mapItem(r);
}

// ── Validation ───────────────────────────────────────────────

export interface ValidatedItem {
  product: Product;
  sale_option: SaleOption | null;
  qty: Qty;
  preparation: Record<string, string>;
  preparation_label: string;
  special_instructions: string | null;
  source_text: string | null;
}

/** Validation Engine — every item, from any source, passes through here. */
export function validateItem(input: ItemInput, opts: { allowInactive?: boolean; customer?: boolean } = {}): ValidatedItem {
  if (!input || typeof input.product_id !== 'string') throw badRequest('Each item needs a product.');
  const product = requireProduct(input.product_id);
  if (!product.active && !opts.allowInactive) throw badRequest(`${product.canonical_name} is not currently available.`);
  const q = input.qty;
  let qty: Qty;
  let saleOption: SaleOption | null = null;
  if (input.sale_option) {
    // A pack or piece option: the option fixes the size, the customer only chooses how many
    saleOption = product.sale_options.find((o) => o.id === input.sale_option) ?? null;
    if (!saleOption) throw badRequest(`That size isn’t available for ${product.customer_name}.`);
    const count = Number(q?.count);
    if (!Number.isInteger(count) || count < 1) throw badRequest(`Choose how many for ${product.customer_name}.`);
    qty = saleOption.kind === 'pack' ? { kind: 'portions', count, weight_g: saleOption.grams } : { kind: 'count', count, weight_g: null };
  } else {
    if (opts.customer && product.sale_options.length) throw badRequest(`Choose a size for ${product.customer_name}: ${product.sale_options.map((o) => o.label).join(', ')}.`);
    if (!q || !['weight', 'count', 'portions'].includes(q.kind)) throw badRequest(`Please give a quantity for ${product.canonical_name}.`);
    qty = {
      kind: q.kind,
      count: q.kind === 'weight' ? null : Number(q.count),
      weight_g: q.kind === 'count' ? null : Math.round(Number(q.weight_g)),
    };
    const problem = validateQty(qty, product.quantity_type, product.allows_portions);
    if (problem) throw badRequest(`${product.canonical_name}: ${problem}`);
  }
  // Per-product limits, counted in the units the customer chooses (packs, pieces or grams)
  const amount = qty.kind === 'weight' ? qty.weight_g ?? 0 : qty.count ?? 0;
  if (product.min_qty != null && amount < product.min_qty) throw badRequest(`${product.customer_name}: the minimum is ${product.min_qty}${qty.kind === 'weight' ? ' g' : ''}.`);
  if (product.max_qty != null && amount > product.max_qty) throw badRequest(`${product.customer_name}: the most we can take on one order is ${product.max_qty}${qty.kind === 'weight' ? ' g' : ''}. Ask us if you need more.`);
  if (opts.customer && qty.kind !== 'weight' && (qty.count ?? 0) > 500) throw badRequest(`${product.customer_name}: that’s more than we can take online. Please contact us.`);
  if (opts.customer && product.pack_size && (qty.kind !== 'count' || (qty.count ?? 0) % product.pack_size !== 0))
    throw badRequest(`${product.customer_name} are sold in lots of ${product.pack_size}. Please choose ${product.pack_size}, ${product.pack_size * 2}, ${product.pack_size * 3}…`);
  const { preparation, label } = resolvePreparation(product, input.preparation);
  const instr = input.special_instructions?.toString().trim().slice(0, 500) || null;
  return { product, sale_option: saleOption, qty, preparation, preparation_label: label, special_instructions: instr, source_text: input.source_text?.slice(0, 500) ?? null };
}

/** The price snapshot for a validated line, from the catalogue as it is right now. */
export function quoteItem(v: ValidatedItem): { unit_price_cents: number | null; price_unit: 'kg' | 'each' | null; surcharge_pct: number; pricing: Pricing; est_cents: number | null } {
  const surcharge = v.product.preparations
    .filter((o) => v.preparation[o.group_name] === o.name)
    .reduce((t, o) => t + (o.surcharge_pct || 0), 0);
  const unit = v.product.price_cents == null ? null : withSurcharge(v.product.price_cents, surcharge);
  const piece = v.sale_option ? v.sale_option.grams : v.product.typical_piece_g;
  const q = priceLine({ qty: v.qty, unitPriceCents: unit, priceUnit: v.product.price_unit, saleKind: v.sale_option?.kind ?? null, pieceGrams: piece });
  return { unit_price_cents: unit, price_unit: v.product.price_unit, surcharge_pct: surcharge, pricing: q.pricing, est_cents: q.cents };
}

function insertItem(orderId: string, v: ValidatedItem, sort: number): string {
  const itemId = id('oi_');
  const ts = now();
  const qt = quoteItem(v);
  db()
    .prepare(
      `INSERT INTO order_items (id, order_id, product_id, qty_kind, count, weight_g, preparation, preparation_label, special_instructions, source_text, sort_order, created_at, updated_at,
         sale_option, sale_option_kind, product_name_snap, unit_price_cents, price_unit_snap, surcharge_pct, pricing, est_cents)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      itemId, orderId, v.product.id, v.qty.kind, v.qty.count, v.qty.weight_g, JSON.stringify(v.preparation), v.preparation_label, v.special_instructions, v.source_text, sort, ts, ts,
      v.sale_option?.label ?? null, v.sale_option?.kind ?? null, v.product.customer_name, qt.unit_price_cents, qt.price_unit, qt.surcharge_pct, qt.pricing, qt.est_cents,
    );
  return itemId;
}

/**
 * Re-works out an order's totals from its line snapshots (never from today's catalogue).
 * Final total exists only when every line has a final price (fixed packs, or weighed when packed).
 */
export function recomputeTotals(orderId: string) {
  const items = db().prepare("SELECT id, pricing, est_cents, unit_price_cents, price_unit_snap, packed_weight_g FROM order_items WHERE order_id = ? AND status = 'active'").all(orderId) as any[];
  const order = db().prepare('SELECT delivery_fee_cents FROM orders WHERE id = ?').get(orderId) as { delivery_fee_cents: number | null } | undefined;
  if (!order) return;
  const fee = order.delivery_fee_cents ?? 0;
  let allFinal = items.length > 0;
  let finalSum = fee;
  for (const it of items) {
    const f = finalLine({ pricing: it.pricing, est_cents: it.est_cents, unit_price_cents: it.unit_price_cents, price_unit: it.price_unit_snap, packed_weight_g: it.packed_weight_g });
    db().prepare('UPDATE order_items SET final_cents = ? WHERE id = ?').run(f, it.id);
    if (f == null) allFinal = false;
    else finalSum += f;
  }
  const t = totalOf(items.map((i) => ({ pricing: i.pricing, cents: i.est_cents })), fee);
  db().prepare('UPDATE orders SET estimated_total_cents = ?, final_total_cents = ? WHERE id = ?').run(items.length ? t.estimateCents : null, allFinal ? finalSum : null, orderId);
  supersedeIfAmountChanged(orderId);
  recomputePayment(orderId);
}

/** Price summary for an order, as staff and the customer see it. */
export function orderMoney(orderId: string) {
  const o = db().prepare('SELECT estimated_total_cents, confirmed_total_cents, final_total_cents, amount_paid_cents, delivery_fee_cents FROM orders WHERE id = ?').get(orderId) as any;
  const items = db().prepare("SELECT pricing, est_cents FROM order_items WHERE order_id = ? AND status = 'active'").all(orderId) as any[];
  const t = totalOf(items.map((i) => ({ pricing: i.pricing, cents: i.est_cents })), o?.delivery_fee_cents ?? 0);
  const fin = db().prepare('SELECT total_cents FROM order_finalizations WHERE order_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1').get(orderId) as { total_cents: number } | undefined;
  // Once finalized, the amount owed is the finalized snapshot — nothing else
  const due = fin ? fin.total_cents : (o?.final_total_cents ?? (t.exact && items.length ? t.estimateCents : null));
  return {
    estimated_cents: o?.estimated_total_cents ?? null,
    estimate_is_exact: t.exact && items.length > 0,
    lines_priced_on_weight: t.pendingLines + items.filter((i) => i.pricing === 'estimate').length,
    confirmed_cents: o?.confirmed_total_cents ?? null,
    final_cents: o?.final_total_cents ?? null,
    delivery_fee_cents: o?.delivery_fee_cents ?? null,
    paid_cents: o?.amount_paid_cents ?? 0,
    /** The locked, finalized amount (null until final weighing is done). */
    finalized_cents: fin ? fin.total_cents : null,
    /** What is owed now; null until the amount is known for certain. */
    due_cents: due,
    balance_cents: due == null ? null : Math.max(0, due - (o?.amount_paid_cents ?? 0)),
  };
}

/** Older lines saved before price snapshots existed take the price on record when this ran. */
export function backfillItemSnapshots() {
  const rows = db().prepare('SELECT i.id, i.order_id FROM order_items i WHERE i.pricing IS NULL').all() as { id: string; order_id: string }[];
  if (!rows.length) return 0;
  const orders = new Set<string>();
  tx(() => {
    for (const r of rows) {
      const it = db().prepare('SELECT * FROM order_items WHERE id = ?').get(r.id) as any;
      const product = requireProduct(it.product_id);
      const v: ValidatedItem = { product, sale_option: null, qty: { kind: it.qty_kind, count: it.count, weight_g: it.weight_g }, preparation: json(it.preparation, {}), preparation_label: it.preparation_label, special_instructions: it.special_instructions, source_text: it.source_text };
      const qt = quoteItem(v);
      db()
        .prepare('UPDATE order_items SET product_name_snap = COALESCE(product_name_snap, ?), unit_price_cents = ?, price_unit_snap = ?, surcharge_pct = ?, pricing = ?, est_cents = ? WHERE id = ?')
        .run(product.customer_name, qt.unit_price_cents, qt.price_unit, qt.surcharge_pct, qt.pricing, qt.est_cents, r.id);
      orders.add(r.order_id);
    }
    for (const o of orders) recomputeTotals(o);
  });
  return rows.length;
}

export function describeItem(v: { product: Product; qty: Qty; preparation_label: string } | OrderItem): string {
  const name = 'product' in v ? v.product.canonical_name : v.product_name;
  const noun = 'product' in v ? v.product.piece_noun : v.piece_noun;
  return `${name} — ${formatQty(v.qty, noun)}${v.preparation_label ? ` (${v.preparation_label})` : ''}`;
}

export function addEvent(orderId: string, type: string, summary: string, actor: Actor, data: unknown = {}, messageId: string | null = null) {
  db()
    .prepare('INSERT INTO order_events (id, order_id, type, summary, data, actor_kind, actor_user_id, message_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id('ev_'), orderId, type, summary, JSON.stringify(data ?? {}), actor.kind, actor.userId, messageId, now());
}

function touch(orderId: string) {
  db().prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(now(), orderId);
}

// ── Create ──────────────────────────────────────────────────

export function createOrder(input: CreateOrderInput, actor: Actor): OrderSummary {
  if (input.idempotency_key) {
    const existing = db().prepare('SELECT id FROM orders WHERE idempotency_key = ?').get(input.idempotency_key) as any;
    if (existing) return requireOrder(existing.id);
  }
  const validated = input.items.map((i) => validateItem(i, { customer: input.source === 'form' }));
  if (!validated.length && input.status !== 'needs_clarification') throw badRequest('An order needs at least one item.');
  if (input.requested_date && !isValidYmd(input.requested_date)) throw badRequest('That date is not valid.');
  if (input.fulfilment_type && !['collection', 'delivery'].includes(input.fulfilment_type)) throw badRequest('Choose collection or delivery.');

  const orderId = id('or_');
  tx(() => {
    const customerId = 'id' in input.customer ? requireCustomer(input.customer.id).id : createCustomer(input.customer.new, actor).id;
    const orderNumber = nextCounter('order_number');
    const ts = now();
    db()
      .prepare(
        `INSERT INTO orders (id, order_number, customer_id, source, status, resume_status, fulfilment_type, requested_date, time_window, delivery_address, delivery_notes,
           contact_phone, notes, payment_status, import_batch_id, idempotency_key, created_by, confirmed_at, status_changed_at, created_at, updated_at,
           customer_email, confirmed_by, invoice_status, invoice_details, invoice_requested_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        orderId, orderNumber, customerId, input.source, input.status, input.status === 'needs_clarification' ? input.resume_status ?? 'review' : null,
        input.fulfilment_type ?? null, input.requested_date ?? null, input.time_window?.slice(0, 100) ?? null, input.delivery_address?.slice(0, 300) ?? null,
        input.delivery_notes?.slice(0, 500) ?? null, input.contact_phone ?? null, input.notes?.slice(0, 2000) ?? null, input.payment_status ?? 'unpaid',
        input.import_batch_id ?? null, input.idempotency_key ?? null, actor.userId, input.status === 'confirmed' ? ts : null, ts, ts, ts,
        input.customer_email?.trim().toLowerCase() || null, input.status === 'confirmed' ? actor.userId : null,
        input.invoice ? 'requested' : 'not_requested', input.invoice ? JSON.stringify(input.invoice) : null, input.invoice ? ts : null,
      );
    validated.forEach((v, i) => insertItem(orderId, v, i));
    if (input.payment_status === 'paid') db().prepare("UPDATE orders SET payment_state = 'paid' WHERE id = ?").run(orderId);
    recomputeTotals(orderId);
    if (input.status === 'confirmed') db().prepare('UPDATE orders SET confirmed_total_cents = estimated_total_cents WHERE id = ?').run(orderId);
    for (const mid of input.message_ids ?? []) db().prepare('UPDATE messages SET order_id = ?, status = ? WHERE id = ?').run(orderId, 'processed', mid);
    if (input.delivery_address || input.contact_phone) enrichCustomer(customerId, { phone: input.contact_phone, address: input.fulfilment_type === 'delivery' ? input.delivery_address : null }, actor);
    addEvent(
      orderId,
      'created',
      input.created_summary ?? `Order created from ${input.source}`,
      actor,
      { source: input.source, status: input.status, items: validated.map(describeItem), ...(input.created_data ?? {}) },
      input.message_ids?.[0] ?? null,
    );
    audit(actor, 'order.created', 'order', orderId, `Created order #${orderNumber}`, { source: input.source });
    if (input.invoice) addEvent(orderId, 'invoice_requested', `Invoice requested for ${input.invoice.billing_name}${input.invoice.company ? ` (${input.invoice.company})` : ''}`, actor);
  });
  publish(['orders', 'customers'], { orderId, summary: 'New order' });
  // Orders entered as already confirmed (staff phone orders, imports) are confirmed by that person
  if (input.status === 'confirmed') onOrderConfirmed(orderId, actor);
  return requireOrder(orderId);
}

// ── Workflow transitions ────────────────────────────────────

/**
 * Permanently deletes an order (a mistake, a test, a duplicate). Items, history and questions go
 * with it; original messages are kept but unlinked. The audit log keeps who deleted it and what it was.
 */
export function deleteOrder(orderId: string, actor: Actor): { order_number: number } {
  const o = requireOrder(orderId);
  const items = getItems(orderId).map((i) => `${i.qty_label} ${i.product_name}`).join(', ');
  tx(() => {
    db().prepare('DELETE FROM exceptions WHERE order_id = ?').run(orderId);
    db().prepare('DELETE FROM notifications WHERE order_id = ?').run(orderId);
    db().prepare('UPDATE messages SET order_id = NULL WHERE order_id = ?').run(orderId);
    db().prepare('UPDATE import_drafts SET order_id = NULL WHERE order_id = ?').run(orderId);
    db().prepare('DELETE FROM orders WHERE id = ?').run(orderId); // items and events cascade
    audit(actor, 'order.deleted', 'order', orderId, `Deleted order #${o.order_number} for ${o.customer_name} (${STATUS_LABEL[o.status]})${items ? `: ${items}` : ''}`, { order_number: o.order_number, customer_id: o.customer_id, status: o.status });
  });
  publish(['orders', 'exceptions'], { orderId });
  return { order_number: o.order_number };
}

export function transition(orderId: string, to: OrderStatus, actor: Actor, role: Role | null, opts: { note?: string; system?: boolean; confirm?: { expected_from: string | null; expected_to: string | null }; unpaidReason?: string; silent?: boolean } = {}): OrderSummary {
  const order = requireOrder(orderId);
  const from = order.status;
  if (from === to) return order;
  if (!canTransition(from, to)) throw conflict(`An order that is ${STATUS_LABEL[from].toLowerCase()} can't move to ${STATUS_LABEL[to].toLowerCase()}.`);
  if (!opts.system) {
    if (isPrivilegedTransition(from, to) && !can(role, 'orders.reopen')) throw forbidden('Only a manager can reopen this order.');
    if (to === 'cancelled' && !can(role, 'orders.cancel')) throw forbidden('Only a manager can cancel an order.');
  }
  if (to === 'confirmed' || to === 'cutting') {
    if (order.item_count === 0) throw conflict('This order has no items yet.');
    const blocking = db().prepare("SELECT COUNT(*) c FROM exceptions WHERE order_id = ? AND status = 'open' AND severity = 'blocking'").get(orderId) as any;
    if (blocking.c > 0) throw conflict('Resolve the open questions on this order first.');
  }
  if (to === 'out_for_delivery' && order.fulfilment_type !== 'delivery') throw conflict('This order is for collection, not delivery.');
  if (order.finalized_at && ['packing', 'cut', 'cutting', 'confirmed'].includes(to)) throw conflict('This order has been finalized. Use “Reopen for changes” (with a reason) first.');
  // Release for collection/delivery only once the finalized amount has been paid (or an allowed manager override)
  if (to === 'ready' && ['cut', 'packing', 'packed'].includes(from)) {
    const pay = getSettings().payments;
    if (!order.finalized_at) throw conflict('Do the final weighing and finalize the order first.');
    if (pay.requirePaymentBeforeRelease && order.payment_state !== 'paid') {
      const reason = opts.unpaidReason?.trim();
      if (!reason) throw conflict('Payment hasn’t been confirmed yet. The order is released once the payment has reflected and been verified.');
      if (!pay.allowUnpaidRelease) throw conflict('Releasing unpaid orders is switched off (Settings → Payments).');
      if (!can(role, 'payments.write')) throw forbidden('Only a manager can release an unpaid order.');
      opts = { ...opts, note: `released before payment: ${reason}` };
    }
  }
  // A first confirmation is a decision: the customer is told, so it needs the expected timeframe
  const firstConfirmation = to === 'confirmed' && !order.confirmed_at;
  if (firstConfirmation && !opts.system && !opts.confirm) throw conflict('Use “Confirm order” so the customer gets the expected timeframe.');

  tx(() => {
    const ts = now();
    const sets: string[] = ['status = ?', 'status_changed_at = ?', 'updated_at = ?'];
    const vals: unknown[] = [to, ts, ts];
    if (to === 'confirmed' && !order.confirmed_at) {
      sets.push('confirmed_at = ?', 'confirmed_by = ?', 'confirmed_total_cents = estimated_total_cents');
      vals.push(ts, actor.userId);
    }
    if (opts.confirm) {
      sets.push('expected_from = ?', 'expected_to = ?');
      vals.push(opts.confirm.expected_from, opts.confirm.expected_to);
      if (opts.confirm.expected_from) {
        sets.push('requested_date = ?');
        vals.push(opts.confirm.expected_from);
      }
    }
    if (to === 'completed') {
      sets.push('completed_at = ?');
      vals.push(ts);
    }
    if (from === 'completed') sets.push('completed_at = NULL');
    if (to === 'needs_clarification' || to === 'on_hold') {
      sets.push('resume_status = ?');
      vals.push(from === 'needs_clarification' || from === 'on_hold' ? order.resume_status : EDITABLE_STATUSES.includes(from) ? from : 'confirmed');
    }
    if (from === 'needs_clarification' || from === 'on_hold') sets.push('resume_status = NULL');
    db().prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals, orderId);
    // Physical state follows workflow state
    if (to === 'cut') db().prepare("UPDATE order_items SET cut_at = COALESCE(cut_at, ?), cut_by = COALESCE(cut_by, ?) WHERE order_id = ? AND status = 'active'").run(ts, actor.userId, orderId);
    if (to === 'packed') db().prepare("UPDATE order_items SET packed_at = COALESCE(packed_at, ?), packed_by = COALESCE(packed_by, ?) WHERE order_id = ? AND status = 'active'").run(ts, actor.userId, orderId);
    if (to === 'confirmed' && (from === 'cutting' || from === 'cut')) db().prepare('UPDATE order_items SET cut_at = NULL, cut_by = NULL WHERE order_id = ?').run(orderId);
    if ((to === 'cut' || to === 'packing') && from === 'packed') db().prepare('UPDATE order_items SET packed_at = NULL, packed_by = NULL WHERE order_id = ?').run(orderId);
    addEvent(orderId, 'status_changed', `${STATUS_LABEL[from]} → ${STATUS_LABEL[to]}${opts.note ? ` · ${opts.note}` : ''}`, actor, { from, to, note: opts.note });
    audit(actor, 'order.status_changed', 'order', orderId, `#${order.order_number}: ${from} → ${to}`, { from, to });
    if (to === 'ready') queueReadyNotification(orderId);
  });
  publish(['orders'], { orderId });
  if (firstConfirmation) onOrderConfirmed(orderId, actor);
  else if (!opts.silent) onOrderStatusChanged(orderId, from, to, actor);
  return requireOrder(orderId);
}

/** What still stops an order being confirmed (empty list = ready). Shown to staff before they confirm. */
export function confirmationProblems(orderId: string): string[] {
  const o = requireOrder(orderId);
  const out: string[] = [];
  const items = getItems(orderId);
  if (!items.length) out.push('The order has no items.');
  for (const i of items) {
    const p = requireProduct(i.product_id);
    if (!p.active) out.push(`${p.canonical_name} is marked out of stock. Change or remove it, or mark it back in stock.`);
    if (i.pricing === 'unpriced') out.push(`${p.canonical_name} has no price. Set its price under Products first.`);
  }
  const blocking = (db().prepare("SELECT COUNT(*) n FROM exceptions WHERE order_id = ? AND status = 'open' AND severity = 'blocking'").get(orderId) as { n: number }).n;
  if (blocking) out.push('Resolve the open questions on this order first.');
  const pending = (db().prepare("SELECT COUNT(*) n FROM order_amendments WHERE order_id = ? AND status = 'proposed' AND requires_approval = 1").get(orderId) as { n: number }).n;
  if (pending) out.push('A proposed change is still waiting for the customer’s answer.');
  if (!o.fulfilment_type) out.push('Choose collection or delivery.');
  if (o.fulfilment_type === 'delivery' && !o.delivery_address) out.push('Add the delivery address.');
  const c = db().prepare('SELECT phone, email FROM customers WHERE id = ?').get(o.customer_id) as { phone: string | null; email: string | null };
  if (!o.contact_phone && !c.phone && !o.customer_email && !c.email) out.push('Add a phone number or email for the customer.');
  return out;
}

/**
 * CONFIRM ORDER — the explicit decision by an authorised person, with the expected timeframe.
 * Idempotent: confirming an already-confirmed order changes nothing and sends nothing.
 */
export function confirmOrder(orderId: string, input: { expected_from: string; expected_to?: string | null }, actor: Actor, role: Role | null): { order: OrderSummary; already: boolean } {
  const o = requireOrder(orderId);
  if (o.confirmed_at && !['review', 'needs_clarification', 'on_hold'].includes(o.status)) return { order: o, already: true };
  if (o.status === 'confirmed') return { order: o, already: true };
  if (!['review', 'needs_clarification', 'on_hold'].includes(o.status)) throw conflict(`An order that is ${STATUS_LABEL[o.status].toLowerCase()} can't be confirmed.`);
  if (!isValidYmd(input.expected_from)) throw badRequest('Choose the expected date.');
  const to = input.expected_to || null;
  if (to && (!isValidYmd(to) || to < input.expected_from)) throw badRequest('The end of the timeframe must be on or after the start.');
  const problems = confirmationProblems(orderId);
  if (problems.length) throw conflict(problems[0], { problems });
  const order = transition(orderId, 'confirmed', actor, role, { confirm: { expected_from: input.expected_from, expected_to: to } });
  return { order, already: false };
}

/** Changing a timeframe the customer was given: old and new are recorded, a reason is required and the customer is told. */
export function changeTimeframe(orderId: string, input: { expected_from: string; expected_to?: string | null; reason: string }, actor: Actor): OrderSummary {
  const o = requireOrder(orderId);
  if (['completed', 'cancelled'].includes(o.status)) throw conflict('This order is finished.');
  if (!isValidYmd(input.expected_from)) throw badRequest('Choose the expected date.');
  const to = input.expected_to || null;
  if (to && (!isValidYmd(to) || to < input.expected_from)) throw badRequest('The end of the timeframe must be on or after the start.');
  const reason = input.reason?.trim();
  if (o.confirmed_at && !reason) throw badRequest('Give a reason. The customer is told about the change.');
  if (o.expected_from === input.expected_from && (o.expected_to ?? null) === to) return o;
  const before = { from: o.expected_from, to: o.expected_to };
  tx(() => {
    db().prepare('UPDATE orders SET expected_from = ?, expected_to = ?, requested_date = ?, updated_at = ? WHERE id = ?').run(input.expected_from, to, input.expected_from, now(), orderId);
    addEvent(orderId, 'timeframe_changed', `Expected timeframe changed: ${fmtRange(before.from, before.to)} → ${fmtRange(input.expected_from, to)}${reason ? ` · ${reason}` : ''}`, actor, { before, after: { from: input.expected_from, to }, reason });
    audit(actor, 'order.timeframe_changed', 'order', orderId, `#${o.order_number}: ${fmtRange(before.from, before.to)} → ${fmtRange(input.expected_from, to)}`, { reason });
  });
  if (o.confirmed_at) onTimeframeChanged(orderId, before, reason || '');
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

function fmtRange(a: string | null, b: string | null) {
  return !a ? '—' : b && b !== a ? `${a} to ${b}` : a;
}

function queueReadyNotification(orderId: string) {
  const o = requireOrder(orderId);
  db()
    .prepare("INSERT INTO notifications (id, channel, audience, kind, title, body, order_id, customer_id, status, created_at) VALUES (?, 'in_app', 'staff', 'order_ready', ?, ?, ?, ?, 'queued', ?)")
    .run(id('no_'), `#${o.order_number} is ready`, `${o.customer_name}'s order is ready for ${o.fulfilment_type ?? 'collection'}.`, orderId, o.customer_id, now());
}

/** After clarification is resolved, return the order to where it was heading. */
export function releaseIfClear(orderId: string, actor: Actor) {
  const o = getOrderSummary(orderId);
  if (!o || o.status !== 'needs_clarification') return;
  const blocking = db().prepare("SELECT COUNT(*) c FROM exceptions WHERE order_id = ? AND status = 'open' AND severity = 'blocking'").get(orderId) as any;
  if (blocking.c > 0) return;
  if (o.item_count === 0) return;
  const target = (o.resume_status as OrderStatus) === 'confirmed' ? 'confirmed' : 'review';
  transition(orderId, target, actor, null, { system: true, note: 'All questions resolved' });
}

// ── Amendments ──────────────────────────────────────────────

function productionWarning(order: OrderSummary): string | null {
  if (['cutting', 'cut', 'packing', 'packed', 'ready', 'out_for_delivery'].includes(order.status)) {
    return `Order is already ${STATUS_LABEL[order.status].toLowerCase()} — the change needs to be made physically too.`;
  }
  return null;
}

function assertAmendable(order: OrderSummary) {
  if (order.status === 'completed' || order.status === 'cancelled') throw conflict(`This order is ${STATUS_LABEL[order.status].toLowerCase()} and can no longer be changed.`);
  if (order.finalized_at) throw conflict('This order has been finalized at its weighed amount. Use “Reopen for changes” (with a reason) first.');
}

export interface AmendContext {
  messageId?: string | null;
  reason?: string;
}

export function addItem(orderId: string, input: ItemInput, actor: Actor, ctx: AmendContext = {}): OrderItem {
  const order = requireOrder(orderId);
  assertAmendable(order);
  const v = validateItem(input);
  let itemId = '';
  tx(() => {
    const sort = (db().prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 s FROM order_items WHERE order_id = ?').get(orderId) as any).s;
    itemId = insertItem(orderId, v, sort);
    recomputeTotals(orderId);
    const warn = productionWarning(order);
    addEvent(orderId, 'item_added', `Added ${describeItem(v)}`, actor, { item_id: itemId, item: describeItem(v), reason: ctx.reason, warning: warn }, ctx.messageId ?? null);
    touch(orderId);
    if (order.status === 'cut' || order.status === 'packed') regressForNewWork(order, actor);
  });
  publish(['orders'], { orderId });
  return getItem(itemId);
}

/** New or changed work on an order already past cutting sends it back so nothing is missed. */
function regressForNewWork(order: OrderSummary, actor: Actor) {
  const to: OrderStatus = order.status === 'packed' ? 'packing' : 'cutting';
  if (canTransition(order.status, to)) {
    db().prepare('UPDATE orders SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?').run(to, now(), now(), order.id);
    addEvent(order.id, 'status_changed', `${STATUS_LABEL[order.status]} → ${STATUS_LABEL[to]} · item changed after ${order.status === 'packed' ? 'packing' : 'cutting'}`, actor, { from: order.status, to, automatic: true });
  }
}

export interface ItemPatch {
  sale_option?: string | null;
  qty?: Qty;
  preparation?: Record<string, string>;
  special_instructions?: string | null;
  product_id?: string;
}

export function updateItem(itemId: string, patch: ItemPatch, actor: Actor, ctx: AmendContext = {}): OrderItem {
  const before = getItem(itemId);
  const order = requireOrder(before.order_id);
  assertAmendable(order);
  if (before.status !== 'active') throw conflict('That item has been removed.');
  const productChanged = !!patch.product_id && patch.product_id !== before.product_id;
  const beforeOption = before.sale_option ? requireProduct(before.product_id).sale_options.find((o) => o.label === before.sale_option)?.id ?? null : null;
  const v = validateItem({
    product_id: patch.product_id ?? before.product_id,
    sale_option: patch.sale_option !== undefined ? patch.sale_option : productChanged || patch.qty ? null : beforeOption,
    qty: patch.qty ?? before.qty,
    preparation: patch.preparation ?? (patch.product_id && patch.product_id !== before.product_id ? {} : before.preparation),
    special_instructions: patch.special_instructions !== undefined ? patch.special_instructions : before.special_instructions,
  });
  const changes: string[] = [];
  if (v.product.id !== before.product_id) changes.push(`${before.product_name} → ${v.product.canonical_name}`);
  if (!qtyEquals(v.qty, before.qty)) changes.push(`${formatQty(before.qty, before.piece_noun)} → ${formatQty(v.qty, v.product.piece_noun)}`);
  if (v.preparation_label !== before.preparation_label) changes.push(`${before.preparation_label || 'standard'} → ${v.preparation_label || 'standard'}`);
  if ((v.special_instructions ?? '') !== (before.special_instructions ?? '')) changes.push(v.special_instructions ? `note: "${v.special_instructions}"` : 'note removed');
  if (!changes.length) return before;
  const physicalChange = v.product.id !== before.product_id || !qtyEquals(v.qty, before.qty) || v.preparation_label !== before.preparation_label;
  tx(() => {
    db()
      .prepare(
        `UPDATE order_items SET product_id = ?, qty_kind = ?, count = ?, weight_g = ?, preparation = ?, preparation_label = ?, special_instructions = ?, updated_at = ?
         ${physicalChange ? ', cut_at = NULL, cut_by = NULL, packed_at = NULL, packed_by = NULL' : ''} WHERE id = ?`,
      )
      .run(v.product.id, v.qty.kind, v.qty.count, v.qty.weight_g, JSON.stringify(v.preparation), v.preparation_label, v.special_instructions, now(), itemId);
    // A different product or preparation is priced as it is today; a quantity change keeps the agreed unit price
    const qt = quoteItem(v);
    const keepUnit = !productChanged && v.preparation_label === before.preparation_label && before.price_cents != null;
    const unit = keepUnit ? before.price_cents : qt.unit_price_cents;
    const q = priceLine({ qty: v.qty, unitPriceCents: unit, priceUnit: keepUnit ? before.price_unit : qt.price_unit, saleKind: v.sale_option?.kind ?? null, pieceGrams: v.sale_option ? v.sale_option.grams : v.product.typical_piece_g });
    db()
      .prepare('UPDATE order_items SET sale_option = ?, sale_option_kind = ?, product_name_snap = ?, unit_price_cents = ?, price_unit_snap = ?, surcharge_pct = ?, pricing = ?, est_cents = ? WHERE id = ?')
      .run(v.sale_option?.label ?? null, v.sale_option?.kind ?? null, v.product.customer_name, unit, keepUnit ? before.price_unit : qt.price_unit, keepUnit ? before.surcharge_pct : qt.surcharge_pct, q.pricing, q.cents, itemId);
    recomputeTotals(order.id);
    const warn = physicalChange ? productionWarning(order) : null;
    addEvent(
      order.id,
      'item_amended',
      `${before.product_name}: ${changes.join(', ')}`,
      actor,
      {
        item_id: itemId,
        before: { product: before.product_name, qty: before.qty, qty_label: formatQty(before.qty, before.piece_noun), preparation: before.preparation_label },
        after: { product: v.product.canonical_name, qty: v.qty, qty_label: formatQty(v.qty, v.product.piece_noun), preparation: v.preparation_label },
        reason: ctx.reason,
        warning: warn,
      },
      ctx.messageId ?? null,
    );
    touch(order.id);
    if (physicalChange && (order.status === 'cut' || order.status === 'packed')) regressForNewWork(order, actor);
  });
  publish(['orders'], { orderId: order.id });
  return getItem(itemId);
}

export function removeItem(itemId: string, actor: Actor, ctx: AmendContext = {}) {
  const before = getItem(itemId);
  const order = requireOrder(before.order_id);
  assertAmendable(order);
  if (before.status === 'removed') return;
  tx(() => {
    db().prepare("UPDATE order_items SET status = 'removed', updated_at = ? WHERE id = ?").run(now(), itemId);
    recomputeTotals(order.id);
    addEvent(order.id, 'item_removed', `Removed ${describeItem(before)}`, actor, { item_id: itemId, item: describeItem(before), reason: ctx.reason, warning: productionWarning(order) }, ctx.messageId ?? null);
    touch(order.id);
  });
  // If everything else was already cut/packed, the order may now be complete for that stage
  syncProductionState(order.id, actor);
  publish(['orders'], { orderId: order.id });
}

export interface OrderPatch {
  fulfilment_type?: FulfilmentType | null;
  requested_date?: string | null;
  time_window?: string | null;
  delivery_address?: string | null;
  delivery_notes?: string | null;
  delivery_km?: number | null;
  contact_phone?: string | null;
  notes?: string | null;
  payment_status?: PaymentStatus;
  accounting_ref?: string | null;
  customer_id?: string;
  customer_email?: string | null;
  storage?: 'fresh' | 'frozen' | null;
}

const PATCH_LABEL: Record<keyof OrderPatch, string> = {
  delivery_km: 'Delivery distance (km)',
  fulfilment_type: 'Fulfilment',
  requested_date: 'Date',
  time_window: 'Time',
  delivery_address: 'Delivery address',
  delivery_notes: 'Delivery notes',
  contact_phone: 'Contact phone',
  notes: 'Notes',
  payment_status: 'Payment',
  accounting_ref: 'Accounting reference',
  customer_id: 'Customer',
  customer_email: 'Email for updates',
  storage: 'Fresh or frozen',
};

export function updateOrder(orderId: string, patch: OrderPatch, actor: Actor, role: Role | null, ctx: AmendContext = {}): OrderSummary {
  const order = requireOrder(orderId);
  const fields: Record<string, unknown> = {};
  const changes: string[] = [];
  for (const k of Object.keys(patch) as (keyof OrderPatch)[]) {
    let v = (patch as any)[k];
    if (typeof v === 'string') v = v.trim() || null;
    if (k === 'requested_date' && v && !isValidYmd(v)) throw badRequest('That date is not valid.');
    if (k === 'fulfilment_type' && v && !['collection', 'delivery'].includes(v)) throw badRequest('Choose collection or delivery.');
    if (k === 'payment_status' && !['unpaid', 'pending', 'paid'].includes(v)) throw badRequest('Unknown payment status.');
    if (k === 'storage' && v && !['fresh', 'frozen'].includes(v)) throw badRequest('Choose fresh or frozen.');
    if (k === 'delivery_km' && order.finalized_at) throw conflict('The delivery fee is part of the finalized amount. Reopen the order for changes first.');
    if ((k === 'payment_status' || k === 'accounting_ref') && !can(role, 'payments.write') && !ctx.reason) throw forbidden('Only a manager can change payment details.');
    if (k === 'customer_id') requireCustomer(v);
    if (k === 'customer_email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw badRequest('That email address doesn’t look right.');
    if (k === 'customer_email' && v) v = String(v).toLowerCase();
    if ((order as any)[k] === v) continue;
    fields[k] = v;
    changes.push(`${PATCH_LABEL[k]}: ${fmt((order as any)[k])} → ${fmt(v)}`);
    if (k === 'delivery_km') {
      const f = getSettings().fulfilment;
      fields.delivery_fee_cents = deliveryFeeCents(v, f.freeDeliveryKm, f.deliveryRatePerKmCents);
      if (fields.delivery_fee_cents != null) changes.push(`Delivery fee: R${((fields.delivery_fee_cents as number) / 100).toFixed(2)}`);
    }
  }
  if (!changes.length) return order;
  // Payment details, notes and the delivery distance/fee can be updated at any stage
  if (Object.keys(fields).some((k) => !['payment_status', 'accounting_ref', 'notes', 'delivery_km', 'delivery_fee_cents', 'customer_email'].includes(k))) assertAmendable(order);
  tx(() => {
    db()
      .prepare(`UPDATE orders SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), now(), orderId);
    if ('delivery_fee_cents' in fields) recomputeTotals(orderId);
    if ('payment_status' in fields) {
      // Marking paid by hand (e.g. settled in Xero or cash on collection) without an amount on record
      const verified = (db().prepare("SELECT COUNT(*) n FROM payments WHERE order_id = ? AND status = 'verified'").get(orderId) as { n: number }).n;
      if (fields.payment_status !== 'paid' && verified) throw conflict('This order has verified payments. Reverse the payment instead of marking it unpaid.');
      db().prepare('UPDATE orders SET payment_state = ? WHERE id = ?').run(fields.payment_status === 'paid' ? 'paid' : 'not_requested', orderId);
      recomputePayment(orderId);
    }
    addEvent(orderId, 'details_changed', changes.join(' · '), actor, { before: pick(order, Object.keys(fields)), after: fields, reason: ctx.reason }, ctx.messageId ?? null);
    audit(actor, 'order.updated', 'order', orderId, `#${order.order_number}: ${changes.join('; ')}`);
  });
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

function fmt(v: unknown) {
  return v == null || v === '' ? '—' : String(v);
}
function pick(o: any, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

export function markCustomerNotified(orderId: string, actor: Actor, notified = true) {
  const o = requireOrder(orderId);
  db().prepare('UPDATE orders SET customer_notified_at = ?, updated_at = ? WHERE id = ?').run(notified ? now() : null, now(), orderId);
  addEvent(orderId, 'customer_notified', notified ? 'Customer told the order is ready' : 'Customer notification cleared', actor);
  publish(['orders'], { orderId });
  return requireOrder(o.id);
}

export function addNote(orderId: string, text: string, actor: Actor) {
  const t = text.trim();
  if (!t) throw badRequest('The note is empty.');
  requireOrder(orderId);
  addEvent(orderId, 'note', t.slice(0, 1000), actor);
  touch(orderId);
  publish(['orders'], { orderId });
}

// ── Production (cutting & packing) ─────────────────────────

/** Moves orders forward automatically as physical work is recorded. */
export function syncProductionState(orderId: string, actor: Actor) {
  const o = getOrderSummary(orderId);
  if (!o || o.item_count === 0) return;
  const move = (to: OrderStatus, note: string) => {
    if (canTransition(o.status, to)) transition(orderId, to, actor, null, { system: true, note });
  };
  if (o.status === 'confirmed' && o.items_cut > 0) move(o.items_cut === o.item_count ? 'cutting' : 'cutting', 'cutting started');
  const again = getOrderSummary(orderId)!;
  if (again.status === 'cutting' && again.items_cut === again.item_count) transition(orderId, 'cut', actor, null, { system: true, note: 'all items cut' });
  if (again.status === 'cutting' && again.items_cut === 0) transition(orderId, 'confirmed', actor, null, { system: true, note: 'cutting undone' });
  const later = getOrderSummary(orderId)!;
  if (later.status === 'cut' && later.items_packed > 0) transition(orderId, 'packing', actor, null, { system: true, note: 'packing started' });
}

export function setItemsCut(itemIds: string[], cut: boolean, actor: Actor): string[] {
  const orders = new Set<string>();
  tx(() => {
    for (const itemId of itemIds) {
      const it = getItem(itemId);
      const o = requireOrder(it.order_id);
      if (!['confirmed', 'cutting', 'cut'].includes(o.status)) continue;
      if (!!it.cut_at === cut) continue;
      db().prepare('UPDATE order_items SET cut_at = ?, cut_by = ? WHERE id = ?').run(cut ? now() : null, cut ? actor.userId : null, itemId);
      addEvent(o.id, cut ? 'item_cut' : 'item_uncut', `${cut ? 'Cut' : 'Un-marked'}: ${describeItem(it)}`, actor, { item_id: itemId });
      orders.add(o.id);
    }
    for (const oid of orders) {
      const o = requireOrder(oid);
      if (!cut && o.status === 'cut') transition(oid, 'cutting', actor, null, { system: true, note: 'item un-marked' });
      syncProductionState(oid, actor);
    }
  });
  publish(['orders']);
  return [...orders];
}

export function setItemPacked(itemId: string, packed: boolean, actor: Actor, packedWeightG?: number | null) {
  const it = getItem(itemId);
  const o = requireOrder(it.order_id);
  if (!['cut', 'packing', 'cutting'].includes(o.status)) throw conflict('This order is not waiting to be packed.');
  if (packedWeightG != null) throw badRequest('Weights are entered at final weighing, once the order is packed.');
  tx(() => {
    db().prepare('UPDATE order_items SET packed_at = ?, packed_by = ?, packed_weight_g = COALESCE(?, packed_weight_g) WHERE id = ?').run(packed ? now() : null, packed ? actor.userId : null, packedWeightG ?? null, itemId);
    if (packedWeightG != null) {
      recomputeTotals(o.id);
      addEvent(o.id, 'item_weighed', `${it.product_name} weighed at ${(packedWeightG / 1000).toLocaleString('en-ZA', { maximumFractionDigits: 3 })} kg`, actor, { item_id: itemId, weight_g: packedWeightG });
    }
    if (packed && !it.cut_at) db().prepare('UPDATE order_items SET cut_at = ?, cut_by = ? WHERE id = ?').run(now(), actor.userId, itemId);
    const cur = requireOrder(o.id);
    if (cur.status === 'cutting' && cur.items_cut === cur.item_count) transition(o.id, 'cut', actor, null, { system: true, note: 'all items cut' });
    const after = requireOrder(o.id);
    if (packed && after.status === 'cut') transition(o.id, 'packing', actor, null, { system: true, note: 'packing started' });
  });
  publish(['orders'], { orderId: o.id });
}

/** "Packed" — completes packing. Next comes final weighing (weights, then finalize and request payment). */
export function completePacking(orderId: string, actor: Actor): OrderSummary {
  const o = requireOrder(orderId);
  if (!['cut', 'packing'].includes(o.status)) throw conflict('This order is not waiting to be packed.');
  if (o.items_packed < o.item_count) throw conflict('Tick every item before marking the order packed.');
  transition(orderId, 'packed', actor, null, { system: true, note: 'ready for final weighing' });
  return requireOrder(orderId);
}

/** Records (or corrects) the actual weight of a weighed item, which sets its final price. */
export function setItemWeight(itemId: string, weightG: number | null, actor: Actor) {
  const it = getItem(itemId);
  const o = requireOrder(it.order_id);
  if (o.status !== 'packed') throw conflict('Weights are entered at final weighing, once the order is packed.');
  if (o.finalized_at) throw conflict('This order has been finalized. Use “Reopen for changes” (with a reason) to correct a weight.');
  if (it.status !== 'active') throw conflict('That item has been removed.');
  if (weightG != null && (!Number.isFinite(weightG) || weightG <= 0 || weightG > 500000)) throw badRequest('That weight is not valid.');
  if ((it.packed_weight_g ?? null) === weightG) return it;
  tx(() => {
    db().prepare('UPDATE order_items SET packed_weight_g = ?, updated_at = ? WHERE id = ?').run(weightG, now(), itemId);
    recomputeTotals(o.id);
    addEvent(o.id, 'item_weighed', weightG ? `${it.product_name} weighed at ${(weightG / 1000).toLocaleString('en-ZA', { maximumFractionDigits: 3 })} kg${it.packed_weight_g ? ` (was ${(it.packed_weight_g / 1000).toLocaleString('en-ZA', { maximumFractionDigits: 3 })} kg)` : ''}` : `${it.product_name}: weight cleared`, actor, { item_id: itemId, before: it.packed_weight_g, after: weightG });
  });
  publish(['orders'], { orderId: o.id });
  return getItem(itemId);
}

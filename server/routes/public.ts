import { Hono } from 'hono';
import { db, id, now } from '../db/db.js';
import { formatQty } from '../../shared/quantity.js';
import { priceLine, totalOf, withSurcharge } from '../../shared/pricing.js';
import { normalisePhone } from '../../shared/text.js';
import { AppError, badRequest } from '../lib/errors.js';
import { addDays, localDate, weekdayOf } from '../lib/time.js';
import { CUSTOMER } from '../services/audit.js';
import { businessTz, getSettings } from '../services/settings.js';
import { orderToken } from '../services/links.js';
import { paymentMethods } from '../services/payment-config.js';
import { matchCustomer } from '../domain/customers.js';
import { findPossibleDuplicates } from '../domain/duplicates.js';
import { raiseException } from '../domain/exceptions.js';
import { createOrder, getItems, quoteItem, requireOrder, validateItem, type ItemInput } from '../domain/orders.js';
import { onOrderReceived } from '../domain/lifecycle.js';
import { listProducts, prepGroups, requireProduct, type Product } from '../domain/products.js';
import { body, PublicOrderSchema } from '../http/schemas.js';
import { rateLimit } from '../http/security.js';
import { z } from 'zod';

/** Public customer ordering — feeds the same central order engine as everything else. */
const r = new Hono();

export const PACKAGING_NOTE = 'Packaged products are prepared using our standard vacuum packaging to help maintain freshness.';

r.get('/info', (c) => {
  const s = getSettings();
  const today = localDate(new Date(), businessTz());
  const pm = paymentMethods();
  return c.json({
    business: { name: s.business.name, tagline: s.business.tagline, phone: s.business.phone, email: s.business.email, address: s.business.address },
    // Only what the order form needs — never the internal email recipients or banking details
    form: { enabled: s.customerForm.enabled, intro: s.customerForm.intro, confirmationMessage: s.customerForm.confirmationMessage, showPrices: s.customerForm.showPrices, terms: s.customerForm.terms, noticeNote: s.customerForm.noticeNote, leadTime: s.orders.leadTimeText, packagingNote: PACKAGING_NOTE },
    fulfilment: { collectionDays: s.fulfilment.collectionDays, deliveryDays: s.fulfilment.deliveryDays, deliveryEnabled: s.fulfilment.deliveryEnabled, collectionHours: s.fulfilment.collectionHours, collectionPlace: s.fulfilment.collectionPlace, collectionAddress: s.fulfilment.collectionAddress, deliveryNotes: s.fulfilment.deliveryNotes, freeDeliveryKm: s.fulfilment.freeDeliveryKm, deliveryRatePerKmCents: s.fulfilment.deliveryRatePerKmCents, customerChooses: s.fulfilment.customerChooses, showDeliveryFees: s.fulfilment.showDeliveryFees },
    payments: { online: pm.online, eft: pm.eft, guidance: s.payments.guidance },
    earliest_date: addDays(today, s.orders.leadTimeDays),
    today,
    currency: s.business.currency,
  });
});

r.get('/brand', (c) => {
  const s = getSettings();
  return c.json({ name: s.business.name, tagline: s.business.tagline, primary: s.brand.primary, showName: s.brand.showName, hasLogo: !!s.brand.logo, version: s.brand.version });
});

/** What a customer may see about a product: prices (if shown), sizes, options and availability. */
export function publicProduct(p: Product, showPrices: boolean) {
  const unit = p.price_cents;
  return {
    id: p.id,
    // Products switched off but still "shown on the form" stay listed as out of stock, so customers see them
    out_of_stock: !p.active,
    unavailable_reason: !p.active ? p.unavailable_reason : null,
    name: p.customer_name,
    category: p.category,
    description: p.description,
    image: p.image,
    quantity_type: p.quantity_type,
    allows_portions: p.allows_portions,
    piece_noun: p.piece_noun,
    typical_piece_g: p.typical_piece_g,
    pack_size: p.pack_size,
    min_qty: p.min_qty,
    max_qty: p.max_qty,
    variant_of: p.variant_of,
    variant_label: p.variant_label,
    price_cents: showPrices ? unit : null,
    price_unit: showPrices ? p.price_unit : null,
    sale_options: p.sale_options.map((o) => {
      const q = priceLine({ qty: o.kind === 'pack' ? { kind: 'portions', count: 1, weight_g: o.grams } : { kind: 'count', count: 1, weight_g: null }, unitPriceCents: unit, priceUnit: p.price_unit, saleKind: o.kind, pieceGrams: o.grams });
      return { id: o.id, label: o.label, kind: o.kind, grams: o.grams, price_cents: showPrices ? q.cents : null, pricing: q.pricing };
    }),
    options: prepGroups(p, { customerOnly: true }).map((g) => ({ group: g.group, options: g.options.map((o) => ({ name: o.name, is_default: o.is_default, surcharge_pct: o.surcharge_pct || 0 })) })),
  };
}

r.get('/catalogue', (c) => {
  const show = getSettings().customerForm.showPrices;
  const products = listProducts()
    .filter((p) => p.customer_visible)
    .map((p) => publicProduct(p, show));
  return c.json({ products });
});

/**
 * Prices a basket exactly as the order will be priced, from today's catalogue. The form shows this
 * on the review step, so a customer always sees current prices and availability before sending.
 */
export function quoteBasket(items: ItemInput[]) {
  const show = getSettings().customerForm.showPrices;
  const lines = items.map((it, index) => {
    try {
      const p = requireProduct(it.product_id);
      if (!p.customer_visible) return { index, ok: false, problem: 'This product is no longer on our list.', product_id: it.product_id, pricing: null, cents: null };
      if (!p.active) return { index, ok: false, problem: `${p.customer_name} is out of stock at the moment.`, product_id: it.product_id, pricing: null, cents: null };
      const v = validateItem(it, { customer: true });
      for (const [g, val] of Object.entries(v.preparation)) {
        const opt = p.preparations.find((o) => o.group_name === g && o.name === val);
        if (opt && !opt.customer_visible && it.preparation?.[g]) return { index, ok: false, problem: `That option is not available for ${p.customer_name}.`, product_id: it.product_id, pricing: null, cents: null };
      }
      const q = quoteItem(v);
      return {
        index,
        ok: true,
        problem: null,
        product_id: p.id,
        label: v.sale_option && v.sale_option.kind === 'piece' ? `${v.qty.count} × ${v.sale_option.label}` : formatQty(v.qty, p.piece_noun),
        preparation_label: v.preparation_label,
        pricing: show ? q.pricing : 'unpriced',
        cents: show ? q.est_cents : null,
        unit_price_cents: show ? q.unit_price_cents : null,
        price_unit: q.price_unit,
        surcharge_pct: q.surcharge_pct,
      };
    } catch (e) {
      return { index, ok: false, problem: e instanceof AppError ? e.userMessage : 'This item can’t be ordered as chosen.', product_id: it.product_id, pricing: null, cents: null };
    }
  });
  const okLines = lines.filter((l) => l.ok);
  const total = totalOf(okLines.map((l) => ({ pricing: l.pricing as any, cents: l.cents })));
  return { lines, total: { estimate_cents: okLines.length ? total.estimateCents : null, exact: total.exact && okLines.length > 0, pending_lines: total.pendingLines } };
}

const QuoteSchema = z.object({ items: PublicOrderSchema.shape.items });
r.post('/quote', rateLimit('public-quote', 120, 10 * 60_000), async (c) => {
  const input = await body(c, QuoteSchema);
  return c.json(quoteBasket(input.items as ItemInput[]));
});

void withSurcharge;

r.post('/orders', rateLimit('public-order', 8, 10 * 60_000), async (c) => {
  const s = getSettings();
  if (!s.customerForm.enabled) throw new AppError(503, 'Online ordering is paused at the moment. Please contact us directly.');
  const input = await body(c, PublicOrderSchema);
  if (input.website) return c.json({ ok: true, order_number: null }); // bot trap: pretend success
  const idemKey = `form:${input.client_ref}`;
  const existing = db().prepare('SELECT id FROM orders WHERE idempotency_key = ?').get(idemKey) as any;
  if (existing) {
    const o = requireOrder(existing.id);
    return c.json({ ok: true, order_number: o.order_number, order_url: `/o/${orderToken(o.id)}`, message: s.customerForm.confirmationMessage, replay: true });
  }
  // Business rules the form must respect (never trust the browser)
  const today = localDate(new Date(), businessTz());
  const earliest = addDays(today, s.orders.leadTimeDays);
  const date = input.requested_date ?? null;
  if (date && date < earliest) throw badRequest('Please choose a later date.');
  if (date && date > addDays(today, 90)) throw badRequest('Please choose a date within the next three months.');
  const wd = date ? weekdayOf(date) : null;
  // "Address only" mode: the customer gives an address and the family arranges collection or delivery
  const chooses = s.fulfilment.customerChooses;
  const fulfilmentType = chooses ? (input.fulfilment_type ?? 'collection') : null;
  if (!chooses) {
    if (!input.delivery_address?.trim()) throw badRequest('Please enter your address so we can arrange your order.');
  } else if (fulfilmentType === 'delivery') {
    if (!s.fulfilment.deliveryEnabled) throw badRequest('Delivery is not available at the moment.');
    if (wd != null && !s.fulfilment.deliveryDays.includes(wd)) throw badRequest('We do not deliver on that day.');
    if (!input.delivery_address?.trim()) throw badRequest('Please enter your delivery address.');
  } else if (wd != null && !s.fulfilment.collectionDays.includes(wd)) throw badRequest('We are not open for collections on that day.');
  const special = input.special_request?.trim() || null;
  if (!input.items.length && !special) throw badRequest('Please choose at least one product, or describe what you need under Special requests.');
  // Every line is re-checked and re-priced on the server; the browser's view is never trusted
  const quote = quoteBasket(input.items as ItemInput[]);
  const bad = quote.lines.find((l) => !l.ok);
  if (bad) throw new AppError(400, bad.problem ?? 'Please review your order.', 'basket_problem', { quote });
  if (input.seen_total_cents != null && quote.total.estimate_cents != null && quote.total.estimate_cents !== input.seen_total_cents) {
    throw new AppError(409, 'Some prices have changed since you started your order. Please check the new total and send again.', 'prices_changed', { quote });
  }
  const phone = normalisePhone(input.customer.phone);
  if (!phone) throw badRequest('Please enter a valid phone number.');
  const match = matchCustomer({ phone, email: input.customer.email || null });
  const customer = match.status === 'matched' ? { id: match.customer.id } : { new: { name: input.customer.name, phone: input.customer.phone, email: input.customer.email || null, address: input.delivery_address ?? null } };
  const products = new Map(input.items.map((i) => [i.product_id, requireProduct(i.product_id)]));
  // Preserve the raw submission as a message, like any other channel
  const messageId = id('ms_');
  const summary = quote.lines.map((l, k) => `${(l as any).label} ${products.get(l.product_id)!.customer_name}${(l as any).preparation_label ? ` (${(l as any).preparation_label})` : ''}${input.items[k].special_instructions ? ` — ${input.items[k].special_instructions}` : ''}`).join('\n');
  db()
    .prepare("INSERT INTO messages (id, channel, external_id, direction, sender_name, sender_phone, body, received_at, classification, status, created_at) VALUES (?, 'form', ?, 'in', ?, ?, ?, ?, 'new_order', 'processed', ?)")
    .run(messageId, input.client_ref, input.customer.name, phone, `${summary}${special ? `\nSpecial request: ${special}` : ''}\n${fulfilmentType === 'delivery' ? 'Delivery' : fulfilmentType === 'collection' ? 'Collection' : 'Preferred date'} ${date ?? 'not given'}${!chooses && input.delivery_address ? `\nAddress: ${input.delivery_address}` : ''}${input.notes ? `\nNote: ${input.notes}` : ''}\n\n${JSON.stringify(input)}`, now(), now());
  const order = createOrder(
    {
      customer,
      source: 'form',
      items: input.items.map((i) => ({ product_id: i.product_id, sale_option: i.sale_option ?? null, qty: i.qty as any, preparation: i.preparation ?? {}, special_instructions: i.special_instructions ?? null, source_text: 'Order form' })),
      // Online orders always wait for a person at Terram to confirm them. A special request alone has nothing to cut yet.
      status: !input.items.length ? 'needs_clarification' : 'review',
      fulfilment_type: fulfilmentType,
      requested_date: date,
      customer_email: input.customer.email || null,
      invoice: input.invoice ? { billing_name: input.invoice.billing_name, company: input.invoice.company || null, billing_email: input.invoice.billing_email, billing_address: input.invoice.billing_address || null, vat_number: input.invoice.vat_number || null, instructions: input.invoice.instructions || null } : null,
      delivery_address: fulfilmentType === 'collection' ? null : input.delivery_address ?? null,
      contact_phone: input.customer.phone,
      notes: input.notes ?? null,
      idempotency_key: idemKey,
      message_ids: [messageId],
      created_summary: 'Submitted through the online order form',
    },
    CUSTOMER,
  );
  db().prepare('UPDATE messages SET customer_id = ? WHERE id = ?').run(order.customer_id, messageId);
  // Reminders only with a clear yes; never taken away by ordering without ticking it
  if (input.marketing_consent) db().prepare('UPDATE customers SET marketing_consent = 1, marketing_consent_at = ? WHERE id = ?').run(now(), order.customer_id);
  if (input.customer.email) db().prepare('UPDATE customers SET email = COALESCE(email, ?) WHERE id = ?').run(input.customer.email.toLowerCase(), order.customer_id);
  if (special) {
    db().prepare('UPDATE orders SET special_request = ? WHERE id = ?').run(special, order.id);
    raiseException({
      type: 'special_request',
      severity: input.items.length ? 'warning' : 'blocking',
      title: `Special request on order #${order.order_number}`,
      detail: `${input.customer.name} asked: “${special}”. Confirm availability and price with them, then add it to the order.`,
      order_id: order.id,
      message_id: messageId,
      payload: { text: special },
    });
  }
  if (match.status !== 'matched' && match.status !== 'new') {
    raiseException({
      type: 'ambiguous_customer',
      severity: 'warning',
      title: `Is order #${order.order_number} from an existing customer?`,
      detail: `${input.customer.name} (${input.customer.phone}) ordered online as a new customer, but looks similar to an existing one.`,
      order_id: order.id,
      payload: { name: input.customer.name, phone: input.customer.phone, candidates: match.status === 'ambiguous' ? match.candidates.map((x) => ({ id: x.id, name: x.name, phone: x.phone })) : [{ id: match.customer.id, name: match.customer.name, phone: match.customer.phone }], placeholder_customer_id: order.customer_id },
    });
  }
  const dups = findPossibleDuplicates(order.customer_id, getItems(order.id).map((i) => ({ product_id: i.product_id, qty: i.qty })), { excludeOrderId: order.id, requestedDate: order.requested_date });
  if (dups.length)
    raiseException({ type: 'possible_duplicate', severity: 'warning', title: `Online order #${order.order_number} may duplicate #${dups[0].order_number}`, detail: dups[0].reasons.join(', '), order_id: order.id, payload: { duplicate_of: { order_id: dups[0].order_id, order_number: dups[0].order_number } } });
  onOrderReceived(order.id, { special, notes: input.notes ?? null });
  return c.json({ ok: true, order_number: order.order_number, order_url: `/o/${orderToken(order.id)}`, message: s.customerForm.confirmationMessage });
});

export default r;

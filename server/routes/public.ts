import { Hono } from 'hono';
import { db, id, now } from '../db/db.js';
import { estimateLinePrice, formatMoney, formatQty } from '../../shared/quantity.js';
import { escapeHtml, sendEmailInBackground } from '../services/email.js';
import { normalisePhone } from '../../shared/text.js';
import { AppError, badRequest } from '../lib/errors.js';
import { addDays, localDate, weekdayOf } from '../lib/time.js';
import { CUSTOMER } from '../services/audit.js';
import { businessTz, getSettings } from '../services/settings.js';
import { matchCustomer } from '../domain/customers.js';
import { findPossibleDuplicates } from '../domain/duplicates.js';
import { raiseException } from '../domain/exceptions.js';
import { createOrder, getItems, requireOrder } from '../domain/orders.js';
import { listProducts, prepGroups, requireProduct } from '../domain/products.js';
import { body, PublicOrderSchema } from '../http/schemas.js';
import { rateLimit } from '../http/security.js';

/** Public customer ordering — feeds the same central order engine as everything else. */
const r = new Hono();

r.get('/info', (c) => {
  const s = getSettings();
  const today = localDate(new Date(), businessTz());
  return c.json({
    business: { name: s.business.name, tagline: s.business.tagline, phone: s.business.phone, email: s.business.email, address: s.business.address },
    // Only what the order form needs — never the internal email recipients
    form: { enabled: s.customerForm.enabled, intro: s.customerForm.intro, confirmationMessage: s.customerForm.confirmationMessage, showPrices: s.customerForm.showPrices, terms: s.customerForm.terms },
    fulfilment: { collectionDays: s.fulfilment.collectionDays, deliveryDays: s.fulfilment.deliveryDays, deliveryEnabled: s.fulfilment.deliveryEnabled, collectionHours: s.fulfilment.collectionHours, collectionPlace: s.fulfilment.collectionPlace, collectionAddress: s.fulfilment.collectionAddress, deliveryNotes: s.fulfilment.deliveryNotes, freeDeliveryKm: s.fulfilment.freeDeliveryKm, deliveryRatePerKmCents: s.fulfilment.deliveryRatePerKmCents },
    earliest_date: addDays(today, s.orders.leadTimeDays),
    today,
    currency: s.business.currency,
  });
});

r.get('/brand', (c) => {
  const s = getSettings();
  return c.json({ name: s.business.name, tagline: s.business.tagline, primary: s.brand.primary, showName: s.brand.showName, hasLogo: !!s.brand.logo, version: s.brand.version });
});

r.get('/catalogue', (c) => {
  const show = getSettings().customerForm.showPrices;
  const products = listProducts()
    .filter((p) => p.active && p.customer_visible)
    .map((p) => ({
      id: p.id,
      name: p.customer_name,
      category: p.category,
      description: p.description,
      quantity_type: p.quantity_type,
      allows_portions: p.allows_portions,
      piece_noun: p.piece_noun,
      typical_piece_g: p.typical_piece_g,
      pack_size: p.pack_size,
      price_cents: show ? p.price_cents : null,
      price_unit: show ? p.price_unit : null,
      options: prepGroups(p, { customerOnly: true }).map((g) => ({ group: g.group, options: g.options.map((o) => ({ name: o.name, is_default: o.is_default })) })),
    }));
  return c.json({ products });
});

r.post('/orders', rateLimit('public-order', 8, 10 * 60_000), async (c) => {
  const s = getSettings();
  if (!s.customerForm.enabled) throw new AppError(503, 'Online ordering is paused at the moment. Please contact us directly.');
  const input = await body(c, PublicOrderSchema);
  if (input.website) return c.json({ ok: true, order_number: null }); // bot trap: pretend success
  const idemKey = `form:${input.client_ref}`;
  const existing = db().prepare('SELECT id FROM orders WHERE idempotency_key = ?').get(idemKey) as any;
  if (existing) {
    const o = requireOrder(existing.id);
    return c.json({ ok: true, order_number: o.order_number, message: s.customerForm.confirmationMessage, replay: true });
  }
  // Business rules the form must respect (never trust the browser)
  const today = localDate(new Date(), businessTz());
  const earliest = addDays(today, s.orders.leadTimeDays);
  if (input.requested_date < earliest) throw badRequest('Please choose a later date.');
  if (input.requested_date > addDays(today, 90)) throw badRequest('Please choose a date within the next three months.');
  const wd = weekdayOf(input.requested_date);
  if (input.fulfilment_type === 'delivery') {
    if (!s.fulfilment.deliveryEnabled) throw badRequest('Delivery is not available at the moment.');
    if (!s.fulfilment.deliveryDays.includes(wd)) throw badRequest('We do not deliver on that day.');
    if (!input.delivery_address?.trim()) throw badRequest('Please enter your delivery address.');
  } else if (!s.fulfilment.collectionDays.includes(wd)) throw badRequest('We are not open for collections on that day.');
  const special = input.special_request?.trim() || null;
  if (!input.items.length && !special) throw badRequest('Please choose at least one product, or describe what you need under Special requests.');
  for (const it of input.items) {
    const p = requireProduct(it.product_id);
    if (!p.active || !p.customer_visible) throw badRequest('One of the products is no longer available. Please refresh the page.');
    if (p.pack_size && (it.qty.kind !== 'count' || (it.qty.count ?? 0) % p.pack_size !== 0)) throw badRequest(`${p.customer_name} are sold in lots of ${p.pack_size}. Please choose ${p.pack_size}, ${p.pack_size * 2}, ${p.pack_size * 3}…`);
    for (const [g, v] of Object.entries(it.preparation ?? {})) {
      const opt = p.preparations.find((o) => o.group_name === g && o.name === v);
      if (!opt || !opt.customer_visible || !opt.active) throw badRequest(`That option is not available for ${p.customer_name}.`);
    }
  }
  const phone = normalisePhone(input.customer.phone);
  if (!phone) throw badRequest('Please enter a valid phone number.');
  const match = matchCustomer({ phone, email: input.customer.email || null });
  const customer = match.status === 'matched' ? { id: match.customer.id } : { new: { name: input.customer.name, phone: input.customer.phone, email: input.customer.email || null, address: input.delivery_address ?? null } };
  // Preserve the raw submission as a message, like any other channel
  const messageId = id('ms_');
  const summary = input.items.map((i) => `${formatQty(i.qty as any)} ${requireProduct(i.product_id).customer_name}${Object.values(i.preparation ?? {}).length ? ` (${Object.values(i.preparation ?? {}).join(', ')})` : ''}${i.special_instructions ? ` — ${i.special_instructions}` : ''}`).join('\n');
  db()
    .prepare("INSERT INTO messages (id, channel, external_id, direction, sender_name, sender_phone, body, received_at, classification, status, created_at) VALUES (?, 'form', ?, 'in', ?, ?, ?, ?, 'new_order', 'processed', ?)")
    .run(messageId, input.client_ref, input.customer.name, phone, `${summary}${special ? `\nSpecial request: ${special}` : ''}\n${input.fulfilment_type === 'delivery' ? 'Delivery' : 'Collection'} ${input.requested_date}${input.notes ? `\nNote: ${input.notes}` : ''}\n\n${JSON.stringify(input)}`, now(), now());
  const order = createOrder(
    {
      customer,
      source: 'form',
      items: input.items.map((i) => ({ product_id: i.product_id, qty: i.qty as any, preparation: i.preparation ?? {}, special_instructions: i.special_instructions ?? null, source_text: 'Order form' })),
      // A special request alone has nothing to cut yet: it waits until it's agreed with the customer
      status: !input.items.length ? 'needs_clarification' : s.orders.formOrdersRequireReview || special ? 'review' : 'confirmed',
      fulfilment_type: input.fulfilment_type,
      requested_date: input.requested_date,
      delivery_address: input.fulfilment_type === 'delivery' ? input.delivery_address : null,
      contact_phone: input.customer.phone,
      notes: input.notes ?? null,
      idempotency_key: idemKey,
      message_ids: [messageId],
      created_summary: 'Submitted through the online order form',
    },
    CUSTOMER,
  );
  db().prepare('UPDATE messages SET customer_id = ? WHERE id = ?').run(order.customer_id, messageId);
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
  emailNewOrder(c, order.id, special, input.notes ?? null, input.customer.email || null);
  return c.json({ ok: true, order_number: order.order_number, message: s.customerForm.confirmationMessage });
});

/** Emails a new online order to the addresses in Settings → Customer form (the family's backup copy). */
function emailNewOrder(c: any, orderId: string, special: string | null, notes: string | null, customerEmail: string | null) {
  const s = getSettings();
  const to = s.customerForm.notifyEmails;
  if (!to.length && !(customerEmail && s.customerForm.emailCustomer)) return;
  const o = requireOrder(orderId);
  const items = getItems(orderId);
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const link = `${proto}://${c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host}/orders/${o.id}`;
  const lines = items.map((i) => {
    const est = estimateLinePrice(i.qty, (i as any).price_cents ?? null, (i as any).price_unit ?? null);
    return { text: `${i.qty_label} ${i.product_name}${i.preparation_label ? ` (${i.preparation_label})` : ''}${i.special_instructions ? ` — ${i.special_instructions}` : ''}`, est };
  });
  const total = lines.every((l) => l.est != null) && lines.length ? lines.reduce((t, l) => t + (l.est ?? 0), 0) : null;
  const when = `${o.fulfilment_type === 'delivery' ? 'Delivery' : 'Collection'} on ${o.requested_date ?? '—'}`;
  const facts: [string, string][] = [
    ['Customer', `${o.customer_name}${o.contact_phone ? ` · ${o.contact_phone}` : ''}${customerEmail ? ` · ${customerEmail}` : ''}`],
    ['When', when],
    ...(o.fulfilment_type === 'delivery' && o.delivery_address ? [['Address', o.delivery_address] as [string, string]] : []),
    ...(notes ? [['Note', notes] as [string, string]] : []),
  ];
  const text = [
    `New online order #${o.order_number}`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(lines.length ? ['Items:', ...lines.map((l) => `- ${l.text}`)] : []),
    ...(total != null ? ['', `Estimated total: ${formatMoney(total, s.business.currency)}`] : []),
    ...(special ? ['', `SPECIAL REQUEST: ${special}`] : []),
    '',
    `Open it in Terram: ${link}`,
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#262626;max-width:560px">
<h2 style="margin:0 0 12px;color:#446041">New online order #${o.order_number}</h2>
<table style="border-collapse:collapse;margin-bottom:14px">${facts.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#777">${k}</td><td style="padding:3px 0"><b>${escapeHtml(v)}</b></td></tr>`).join('')}</table>
${lines.length ? `<ul style="padding-left:18px;margin:0 0 12px">${lines.map((l) => `<li style="margin:3px 0">${escapeHtml(l.text)}</li>`).join('')}</ul>` : ''}
${total != null ? `<p style="margin:0 0 12px">Estimated total: <b>${formatMoney(total, s.business.currency)}</b></p>` : ''}
${special ? `<p style="margin:0 0 12px;padding:10px 12px;background:#f8edd8;border-radius:8px"><b>Special request:</b> ${escapeHtml(special)}</p>` : ''}
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#446041;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open order in Terram</a></p>
</div>`;
  sendEmailInBackground({ to, subject: `New order #${o.order_number} — ${o.customer_name}${special ? ' (special request)' : ''}`, text, html, replyTo: customerEmail }, `online order #${o.order_number}`);

  // The customer's own copy: what they asked for, and that we'll confirm it (no staff link)
  if (customerEmail && s.customerForm.emailCustomer) {
    const b = s.business;
    const ctext = [
      `Hi ${o.customer_name.split(' ')[0]},`,
      '',
      `Thank you for your order with ${b.name}. We've received it (reference #${o.order_number}) and will be in touch to confirm it.`,
      '',
      ...(lines.length ? ['Your order:', ...lines.map((l) => `- ${l.text}`)] : []),
      ...(total != null ? ['', `Estimated total: ${formatMoney(total, b.currency)} (final price depends on the packed weight)`] : []),
      ...(special ? ['', `Special request: ${special}`] : []),
      '',
      when,
      ...(o.fulfilment_type === 'delivery' && o.delivery_address ? [`Delivery to: ${o.delivery_address}`] : []),
      '',
      `Questions? Reply to this email${b.phone ? ` or call/WhatsApp ${b.phone}` : ''}.`,
      '',
      b.name,
    ].join('\n');
    const chtml = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#262626;max-width:560px">
<p>Hi ${escapeHtml(o.customer_name.split(' ')[0])},</p>
<p>Thank you for your order with ${escapeHtml(b.name)}. We've received it (reference <b>#${o.order_number}</b>) and will be in touch to confirm it.</p>
${lines.length ? `<ul style="padding-left:18px">${lines.map((l) => `<li style="margin:3px 0">${escapeHtml(l.text)}</li>`).join('')}</ul>` : ''}
${total != null ? `<p>Estimated total: <b>${formatMoney(total, b.currency)}</b> <span style="color:#777">(final price depends on the packed weight)</span></p>` : ''}
${special ? `<p style="padding:10px 12px;background:#f8edd8;border-radius:8px"><b>Special request:</b> ${escapeHtml(special)}</p>` : ''}
<p>${escapeHtml(when)}${o.fulfilment_type === 'delivery' && o.delivery_address ? `<br>Delivery to: ${escapeHtml(o.delivery_address)}` : ''}</p>
<p style="color:#555">Questions? Reply to this email${b.phone ? ` or call/WhatsApp ${escapeHtml(b.phone)}` : ''}.</p>
<p style="color:#446041;font-weight:bold">${escapeHtml(b.name)}</p>
</div>`;
    sendEmailInBackground({ to: [customerEmail], subject: `Your ${b.name} order #${o.order_number}`, text: ctext, html: chtml, replyTo: b.email || null }, `order confirmation to the customer #${o.order_number}`);
  }
}

export default r;

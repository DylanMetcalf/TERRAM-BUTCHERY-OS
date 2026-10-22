import { db } from '../db/db.js';
import { formatQty, type Qty } from '../../shared/quantity.js';
import { STATUS_LABEL, type OrderStatus } from '../../shared/workflow.js';
import type { Actor } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { notify } from '../services/notify.js';
import { orderUrl, siteUrl } from '../services/links.js';
import { formatTimeframe, layout, money, signOff, type EmailLine } from '../services/templates.js';
import { addEvent, getItems, orderMoney, requireOrder, type OrderItem, type OrderSummary } from './orders.js';
import { requestPaymentWhenReady } from './payments.js';

/**
 * ORDER LIFECYCLE → MESSAGES. One place decides who hears about what:
 *
 *  customer (essential, transactional): received, confirmed, timeframe changed, change proposed,
 *    ready (+ payment request), payment received / not verified, invoice ready, out for delivery,
 *    completed, cancelled. Optional: preparation started (Settings).
 *  staff (internal): new order, proof of payment uploaded, online payment received,
 *    invoice requested, customer's answer to a proposed change.
 *
 * Every message has an event key, so repeating an action never sends it twice.
 */

export function customerContact(orderId: string) {
  const r = db()
    .prepare('SELECT o.customer_email, o.customer_id, c.email AS c_email, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?')
    .get(orderId) as { customer_email: string | null; customer_id: string; c_email: string | null; name: string } | undefined;
  const email = r?.customer_email || r?.c_email || null;
  return { email, customerId: r?.customer_id ?? null, firstName: (r?.name ?? '').trim().split(/\s+/)[0] || 'there' };
}

export function staffEmails(): string[] {
  const s = getSettings();
  return s.notifications.staffEmails.length ? s.notifications.staffEmails : s.customerForm.notifyEmails;
}

export function lineFor(i: OrderItem, final = false): EmailLine {
  const qty = i.sale_option && i.sale_option_kind === 'piece' ? `${i.qty.count} × ${i.sale_option}` : formatQty(i.qty as Qty, i.piece_noun);
  const detail = [i.preparation_label, i.special_instructions].filter(Boolean).join(' · ') || null;
  let price: string | null = null;
  if (final && i.final_cents != null) price = money(i.final_cents);
  else if (i.pricing === 'exact') price = money(i.est_cents);
  else if (i.pricing === 'estimate') price = `≈ ${money(i.est_cents)}`;
  else if (i.pricing === 'by_weight' && i.price_cents != null) price = `${money(i.price_cents)}/kg`;
  else if (i.pricing === 'unpriced') price = 'Price to confirm';
  return { label: `${qty} ${i.name_snapshot}`, detail, price };
}

function fulfilmentFacts(o: OrderSummary): [string, string][] {
  const f = getSettings().fulfilment;
  if (o.fulfilment_type === 'delivery') return [['Delivery', o.delivery_address ?? 'Address to be confirmed']];
  if (o.fulfilment_type === 'collection') return [['Collection', [f.collectionPlace, f.collectionAddress].filter(Boolean).join(', ') + (f.collectionHours ? ` (${f.collectionHours})` : '')]];
  return [['Collection or delivery', `We’ll arrange this with you${o.delivery_address ? ` (your address: ${o.delivery_address})` : ''}.`]];
}

function totalLine(orderId: string, final = false): string | null {
  const m = orderMoney(orderId);
  if (final && m.final_cents != null) return `Total: ${money(m.final_cents)}`;
  if (m.estimated_cents == null) return null;
  return m.estimate_is_exact ? `Total: ${money(m.estimated_cents)}` : `Estimated total: ${money(m.estimated_cents)} (weighed items are priced on their final weight)`;
}

function confirmCount(orderId: string): number {
  return (db().prepare("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND type = 'confirmed'").get(orderId) as { n: number }).n;
}

// ── Received ─────────────────────────────────────────────────
export function onOrderReceived(orderId: string, opts: { special: string | null; notes: string | null } = { special: null, notes: null }) {
  const o = requireOrder(orderId);
  const items = getItems(orderId);
  const s = getSettings();
  const c = customerContact(orderId);
  const lead = s.orders.leadTimeText;
  const wa = (s.business.phone ?? '').replace(/\D/g, '').replace(/^0/, '27');
  if (c.email && s.customerForm.emailCustomer) {
    const e = layout({
      subject: `We've received your ${s.business.name} order`,
      preheader: `Order reference #${o.order_number}. We'll review it and confirm.`,
      greeting: `Hi ${c.firstName},`,
      intro: [
        `Thank you for placing an order with ${s.business.name}.`,
        `We've received your order and will review the products, quantities and availability before confirming it.`,
      ],
      blocks: [
        { facts: [['Order reference', `#${o.order_number}`], ['Status', 'Received, waiting for our confirmation']] },
        ...(items.length ? [{ heading: 'What you ordered', lines: items.map((i) => lineFor(i)), paragraphs: [totalLine(orderId)].filter(Boolean) as string[] }] : []),
        ...(opts.special ? [{ note: `Special request: ${opts.special}\nWe'll confirm availability and price with you before anything is prepared.` }] : []),
        { heading: 'When', paragraphs: [`${lead} We'll confirm your expected timeframe once your order has been reviewed.`] },
      ],
      cta: { label: 'View my order', url: orderUrl(orderId) },
      links: wa ? [{ label: `WhatsApp us about order #${o.order_number}`, url: `https://wa.me/${wa}?text=${encodeURIComponent(`Hi, I'd like to change my order #${o.order_number}: `)}` }] : [],
      closing: [
        `Need to change something? Reply to this email with your reference #${o.order_number}${s.business.phone ? `, or call/WhatsApp ${s.business.phone}` : ''}, and we'll update your order.`,
        "You'll receive another update when your order is confirmed.",
        `Thank you for choosing ${s.business.name}.`,
        ...signOff(),
      ],
    });
    notify({ key: `order_received:${orderId}`, kind: 'order_received', audience: 'customer', to: [c.email], ...e, replyTo: s.business.email || null, orderId, customerId: c.customerId });
  }
  // The family's alert
  const staff = staffEmails();
  if (staff.length) {
    const invoice = o.invoice_status === 'requested';
    const e = layout({
      subject: `New order #${o.order_number} — ${o.customer_name}${opts.special ? ' (special request)' : ''}${invoice ? ' · invoice requested' : ''}`,
      preheader: `${items.length} item${items.length === 1 ? '' : 's'} from ${o.customer_name}`,
      intro: [`A new online order is waiting to be reviewed and confirmed.`],
      blocks: [
        { facts: [['Customer', `${o.customer_name}${o.contact_phone ? ` · ${o.contact_phone}` : ''}${c.email ? ` · ${c.email}` : ''}`], ...(o.requested_date ? [['Preferred date', o.requested_date] as [string, string]] : []), ...fulfilmentFacts(o), ...(opts.notes ? [['Note', opts.notes] as [string, string]] : [])] },
        ...(items.length ? [{ heading: 'Items', lines: items.map((i) => lineFor(i)), paragraphs: [totalLine(orderId)].filter(Boolean) as string[] }] : []),
        ...(opts.special ? [{ note: `SPECIAL REQUEST: ${opts.special}` }] : []),
        ...(invoice ? [{ note: 'The customer asked for an invoice. It is in the Invoice requests list.' }] : []),
      ],
      cta: { label: 'Open order in Terram', url: `${siteUrl()}/orders/${orderId}` },
    });
    notify({ key: `staff_new_order:${orderId}`, kind: 'staff_new_order', audience: 'staff', to: staff, ...e, replyTo: c.email, orderId });
  }
}

// ── Confirmed ────────────────────────────────────────────────
export function onOrderConfirmed(orderId: string, actor: Actor) {
  const o = requireOrder(orderId);
  const n = confirmCount(orderId) + 1;
  addEvent(orderId, 'confirmed', `Order confirmed${o.expected_from ? ` · expected ${formatTimeframe(o.expected_from, o.expected_to)}` : ''}`, actor, {
    expected_from: o.expected_from,
    expected_to: o.expected_to,
    confirmed_total_cents: o.confirmed_total_cents,
    items: getItems(orderId).map((i) => ({ item: `${i.qty_label} ${i.name_snapshot}`, preparation: i.preparation_label, unit_price_cents: i.price_cents, price_unit: i.price_unit, pricing: i.pricing, est_cents: i.est_cents })),
  });
  const c = customerContact(orderId);
  if (!c.email) return;
  const s = getSettings();
  const items = getItems(orderId);
  const when = formatTimeframe(o.expected_from, o.expected_to);
  const e = layout({
    subject: `Your ${s.business.name} order is confirmed — #${o.order_number}`,
    preheader: when ? `Expected ${when}.` : 'Your order is moving into preparation.',
    greeting: `Hi ${c.firstName},`,
    intro: [`Good news! Your order with ${s.business.name} has been confirmed.`],
    blocks: [
      { heading: 'Order reference', paragraphs: [`#${o.order_number}`] },
      { heading: 'Confirmed products', lines: items.map((i) => lineFor(i)), paragraphs: [totalLine(orderId)].filter(Boolean) as string[] },
      { heading: 'Collection or delivery', facts: fulfilmentFacts(o) },
      { heading: 'Expected timeframe', paragraphs: [when ?? "We'll let you know the expected date shortly."] },
    ],
    closing: [
      'Your order will now move into our preparation process.',
      `${s.orders.leadTimeText} The confirmed timeframe above reflects our current expectation.`,
      "If anything changes regarding your order, product availability, collection or delivery arrangements, we'll contact you directly to discuss the changes with you.",
      `Thank you for supporting ${s.business.name}. We appreciate your order and look forward to preparing it for you.`,
      ...signOff(),
    ],
    cta: { label: 'View my order and its progress', url: orderUrl(orderId) },
  });
  notify({ key: `order_confirmed:${orderId}:${n}`, kind: 'order_confirmed', audience: 'customer', to: [c.email], ...e, replyTo: s.business.email || null, orderId, customerId: c.customerId });
}

// ── Timeframe changed ────────────────────────────────────────
export function onTimeframeChanged(orderId: string, before: { from: string | null; to: string | null }, reason: string) {
  const o = requireOrder(orderId);
  const c = customerContact(orderId);
  if (!c.email || !o.confirmed_at) return;
  const s = getSettings();
  const was = formatTimeframe(before.from, before.to);
  const now = formatTimeframe(o.expected_from, o.expected_to);
  const e = layout({
    subject: `Update to your order #${o.order_number}: new expected date`,
    preheader: now ? `Now expected ${now}.` : 'Your expected date has changed.',
    greeting: `Hi ${c.firstName},`,
    intro: [`We need to let you know that the expected timeframe for your order #${o.order_number} has changed.`],
    blocks: [{ facts: [...(was ? [['Previously', was] as [string, string]] : []), ['Now expected', now ?? 'To be confirmed'], ['Why', reason]] }],
    closing: ["We're sorry for any inconvenience. If the new timeframe doesn't work for you, please reply to this email or call us and we'll work something out.", ...signOff()],
    cta: { label: 'View my order', url: orderUrl(orderId) },
  });
  const n = (db().prepare("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND type = 'timeframe_changed'").get(orderId) as { n: number }).n;
  notify({ key: `timeframe_changed:${orderId}:${n}`, kind: 'timeframe_changed', audience: 'customer', to: [c.email], ...e, replyTo: s.business.email || null, orderId, customerId: c.customerId });
}

// ── Status changes ───────────────────────────────────────────
export function onOrderStatusChanged(orderId: string, from: OrderStatus, to: OrderStatus, actor: Actor) {
  const s = getSettings();
  const o = requireOrder(orderId);
  const c = customerContact(orderId);
  const n = (db().prepare("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND type = 'status_changed' AND json_extract(data, '$.to') = ?").get(orderId, to) as { n: number }).n;
  const key = `status:${to}:${orderId}:${n}`;
  const send = (subject: string, preheader: string, intro: string[], extra: Partial<Parameters<typeof layout>[0]> = {}) => {
    if (!c.email) return;
    const e = layout({ subject, preheader, greeting: `Hi ${c.firstName},`, intro, cta: { label: 'View my order', url: orderUrl(orderId) }, closing: signOff(), ...extra });
    notify({ key, kind: `order_${to}`, audience: 'customer', to: [c.email], ...e, replyTo: s.business.email || null, orderId, customerId: c.customerId });
  };
  if (to === 'cutting' && from === 'confirmed' && s.notifications.notifyPreparation) {
    send(`We've started preparing your order #${o.order_number}`, 'Your order is being prepared.', [`Your order #${o.order_number} is now being prepared by our butchery team. We'll let you know as soon as it's ready.`]);
  } else if (to === 'ready' && !['out_for_delivery', 'completed'].includes(from)) {
    // Ask for payment now if Terram works that way and the amount is known; the request travels in this one email
    const pay = requestPaymentWhenReady(orderId, actor);
    const f = s.fulfilment;
    const how =
      o.fulfilment_type === 'delivery'
        ? "We'll be in touch to arrange delivery."
        : o.fulfilment_type === 'collection'
          ? `It's ready for collection from ${[f.collectionPlace, f.collectionAddress].filter(Boolean).join(', ')}${f.collectionHours ? ` (${f.collectionHours})` : ''}.`
          : "We'll be in touch to arrange collection or delivery.";
    const items = getItems(orderId);
    const blocks = [{ heading: 'Your order', lines: items.map((i) => lineFor(i, true)), paragraphs: [totalLine(orderId, true)].filter(Boolean) as string[] }];
    if (pay.request) {
      blocks.push({ heading: 'Payment', paragraphs: [`Amount due: ${money(pay.request.amount_cents)}`, 'You can pay online or by EFT from your order page. Your order shows as paid once the payment has been verified.'], lines: [] });
    }
    if (!c.email) return;
    const e = layout({
      subject: pay.request ? `Your order #${o.order_number} is ready — payment due ${money(pay.request.amount_cents)}` : `Your order #${o.order_number} is ready`,
      preheader: how,
      greeting: `Hi ${c.firstName},`,
      intro: [`Your order #${o.order_number} is packed and ready. ${how}`],
      blocks,
      cta: { label: pay.request ? 'View order and pay' : 'View my order', url: orderUrl(orderId) },
      closing: signOff(),
    });
    notify({ key: pay.request ? `payment_requested:${pay.request.id}` : key, kind: pay.request ? 'payment_requested' : 'order_ready', audience: 'customer', to: [c.email], ...e, replyTo: s.business.email || null, orderId, customerId: c.customerId });
  } else if (to === 'out_for_delivery') {
    send(`Your order #${o.order_number} is on its way`, 'Out for delivery.', [`Your order #${o.order_number} is out for delivery${o.delivery_address ? ` to ${o.delivery_address}` : ''}.`]);
  } else if (to === 'completed') {
    const fb = s.retention.feedbackEnabled;
    send(
      `Thank you — order #${o.order_number} is complete`,
      'Thank you for your order.',
      [`Your order #${o.order_number} has been ${o.fulfilment_type === 'delivery' ? 'delivered' : 'collected'}. Thank you for supporting ${s.business.name}!`, ...(fb ? ['If you have a moment, we’d love to hear how everything was. You can leave a quick rating on your order page.'] : [])],
      { cta: { label: fb ? 'Leave feedback' : 'View my order', url: orderUrl(orderId, fb ? '#feedback' : '') } },
    );
  } else if (to === 'cancelled') {
    send(`Your order #${o.order_number} has been cancelled`, 'Order cancelled.', [`Your order #${o.order_number} has been cancelled. If you didn't expect this, please contact us and we'll help.`]);
  }
  void STATUS_LABEL;
}

import { getSettings } from '../services/settings.js';
import { rateLimit } from '../http/security.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/db.js';
import { ORDER_STATUSES, OPEN_STATUSES, allowedTransitions, type OrderStatus } from '../../shared/workflow.js';
import { can } from '../../shared/permissions.js';
import { badRequest } from '../lib/errors.js';
import { localDate } from '../lib/time.js';
import { businessTz } from '../services/settings.js';
import { listExceptions } from '../domain/exceptions.js';
import { actionsFor } from '../domain/exception-actions.js';
import {
  addItem,
  addNote,
  completePacking,
  createOrder,
  getItem,
  getItems,
  markCustomerNotified,
  removeItem,
  requireOrder,
  setItemPacked,
  setItemsCut,
  transition,
  updateItem,
  updateOrder,
  type OrderSummary,
 deleteOrder,
  addEvent,
  confirmOrder,
  confirmationProblems,
  changeTimeframe,
  orderMoney,
  setItemWeight,
} from '../domain/orders.js';
import { listAmendments, proposeAmendment, withdrawAmendment } from '../domain/amendments.js';
import { finalizationHistory, finalizationProblems, finalizeOrder, latestFinalization, reopenFinalized } from '../domain/finalize.js';
import { paymentRequestPreview, recordWhatsAppHandoff, reviewDeclaration, sendPaymentRequest } from '../domain/pay-page.js';
import { createPaymentRequest, openRequest, paymentSummary, reversePayment, reviewProof, recordVerifiedPayment, sendPaymentRequestEmail } from '../domain/payments.js';
import { INVOICE_LABEL, listInvoiceRequests, requestInvoice, updateInvoiceRequest } from '../domain/invoices.js';
import { listNotifications, notificationProblemCount, retryNotification } from '../services/notify.js';
import { orderUrl, revokeOrderLinks } from '../services/links.js';
import { fileHeaders, readFile, storeFile } from '../services/files.js';
import { findPossibleDuplicates } from '../domain/duplicates.js';
import { raiseException } from '../domain/exceptions.js';
import { actorOf, requirePerm, roleOf, type Env } from '../http/context.js';
import { body, CreateOrderSchema, ItemSchema, OrderPatchSchema, QtySchema, PrepSchema, ymdParam } from '../http/schemas.js';
import { json } from '../db/db.js';

const r = new Hono<Env>();

const ORDER_SELECT_IDS = 'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id';

r.get('/', requirePerm('orders.read'), (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const vals: unknown[] = [];
  const today = localDate(new Date(), businessTz());
  const view = q.view ?? 'open';
  if (view === 'open') where.push(`o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`), vals.push(...OPEN_STATUSES);
  else if (view === 'review') where.push("o.status IN ('review','needs_clarification')");
  else if (view === 'production') where.push("o.status IN ('confirmed','cutting','cut','packing','packed')");
  else if (view === 'ready') where.push("o.status IN ('ready','out_for_delivery')");
  else if (view === 'today') where.push("o.requested_date = ? AND o.status != 'cancelled'"), vals.push(today);
  else if (view === 'overdue') where.push("o.requested_date < ? AND o.status NOT IN ('completed','cancelled','on_hold')"), vals.push(today);
  else if (view === 'undated') where.push("o.requested_date IS NULL AND o.status NOT IN ('completed','cancelled')");
  else if (view === 'completed') where.push("o.status = 'completed'");
  else if (view === 'cancelled') where.push("o.status = 'cancelled'");
  else if (view === 'weighing') where.push("o.status = 'packed' AND o.finalized_at IS NULL");
  else if (view === 'to_request') where.push("o.status = 'packed' AND o.finalized_at IS NOT NULL AND o.payment_state IN ('not_requested','failed')");
  else if (view === 'requested') where.push("o.status = 'packed' AND o.payment_state IN ('requested','pending','partially_paid')");
  else if (view === 'verify') where.push("o.payment_state = 'proof_submitted' AND o.status != 'cancelled'");
  else if (view === 'awaiting_payment') where.push("o.payment_state IN ('requested','pending','partially_paid','failed') AND o.status != 'cancelled'");
  else if (view === 'proofs') where.push("EXISTS (SELECT 1 FROM payment_proofs p WHERE p.order_id = o.id AND p.status = 'submitted')");
  else if (view === 'awaiting_customer') where.push("EXISTS (SELECT 1 FROM order_amendments a WHERE a.order_id = o.id AND a.status = 'proposed' AND a.requires_approval = 1)");
  if (q.status && (ORDER_STATUSES as readonly string[]).includes(q.status)) where.push('o.status = ?'), vals.push(q.status);
  const from = ymdParam(q.from);
  const to = ymdParam(q.to);
  if (from) where.push('o.requested_date >= ?'), vals.push(from);
  if (to) where.push('o.requested_date <= ?'), vals.push(to);
  if (q.customer_id) where.push('o.customer_id = ?'), vals.push(q.customer_id);
  if (q.source) where.push('o.source = ?'), vals.push(q.source);
  if (q.q) {
    const s = q.q.trim();
    const n = /^#?\d+$/.test(s) ? Number(s.replace('#', '')) : -1;
    where.push('(o.order_number = ? OR c.name LIKE ? OR o.notes LIKE ?)');
    vals.push(n, `%${s}%`, `%${s}%`);
  }
  const limit = Math.min(Number(q.limit) || 50, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const sort =
    view === 'completed' || view === 'cancelled'
      ? 'o.updated_at DESC'
      : "CASE WHEN o.requested_date IS NULL THEN 1 ELSE 0 END, o.requested_date, o.order_number";
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db().prepare(`SELECT COUNT(*) n FROM orders o JOIN customers c ON c.id = o.customer_id ${whereSql}`).get(...vals) as any).n;
  const ids = db().prepare(`${ORDER_SELECT_IDS} ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...vals, limit, offset) as { id: string }[];
  const orders = ids.map((x) => requireOrder(x.id));
  const counts = db()
    .prepare(
      `SELECT
        SUM(status NOT IN ('completed','cancelled')) open,
        SUM(status IN ('review','needs_clarification')) review,
        SUM(status IN ('confirmed','cutting','cut','packing','packed')) production,
        SUM(status IN ('ready','out_for_delivery')) ready,
        SUM(requested_date = ? AND status != 'cancelled') today,
        SUM(requested_date < ? AND status NOT IN ('completed','cancelled','on_hold')) overdue
       FROM orders`,
    )
    .get(today, today);
  return c.json({ orders, total, limit, offset, counts });
});

r.post('/', requirePerm('orders.write'), async (c) => {
  const input = await body(c, CreateOrderSchema);
  if (!input.customer_id && !input.customer) throw badRequest('Choose or add a customer.');
  const idem = c.req.header('idempotency-key') ?? null;
  const order = createOrder(
    {
      customer: input.customer_id ? { id: input.customer_id } : { new: { ...input.customer!, email: input.customer!.email || null } },
      source: input.source,
      items: input.items.map((i) => ({ ...i, preparation: i.preparation ?? {} })),
      status: input.status,
      fulfilment_type: input.fulfilment_type ?? null,
      requested_date: input.requested_date ?? null,
      time_window: input.time_window ?? null,
      delivery_address: input.delivery_address ?? null,
      delivery_notes: input.delivery_notes ?? null,
      contact_phone: input.contact_phone ?? null,
      notes: input.notes ?? null,
      payment_status: can(roleOf(c), 'payments.write') ? input.payment_status : undefined,
      idempotency_key: idem ? `manual:${idem}` : null,
      created_summary: `Entered by ${c.get('user')!.name} (${input.source === 'phone' ? 'phone call' : input.source})`,
    },
    actorOf(c),
  );
  flagDuplicates(order);
  return c.json({ order });
});

function flagDuplicates(order: OrderSummary) {
  const items = getItems(order.id).map((i) => ({ product_id: i.product_id, qty: i.qty }));
  const dups = findPossibleDuplicates(order.customer_id, items, { excludeOrderId: order.id, requestedDate: order.requested_date });
  if (dups.length) {
    raiseException({
      type: 'possible_duplicate',
      severity: 'warning',
      title: `Order #${order.order_number} may duplicate #${dups[0].order_number}`,
      detail: `${order.customer_name}: ${dups[0].reasons.join(', ')}.`,
      order_id: order.id,
      payload: { duplicate_of: { order_id: dups[0].order_id, order_number: dups[0].order_number }, reasons: dups[0].reasons },
      dedupe_key: `dup:${order.id}:${dups[0].order_id}`,
    });
  }
}

r.get('/:id', requirePerm('orders.read'), (c) => {
  const order = requireOrder(c.req.param('id'));
  const items = getItems(order.id, true);
  const events = (
    db()
      .prepare(
        `SELECT e.*, u.name AS actor_name, m.body AS message_body, m.sender_name AS message_sender FROM order_events e
         LEFT JOIN users u ON u.id = e.actor_user_id LEFT JOIN messages m ON m.id = e.message_id
         WHERE e.order_id = ? ORDER BY e.created_at, e.rowid`,
      )
      .all(order.id) as any[]
  ).map((e) => ({ ...e, data: json(e.data, {}) }));
  const messages = db()
    .prepare('SELECT id, channel, direction, sender_name, sender_phone, body, sent_at, received_at, classification FROM messages WHERE order_id = ? ORDER BY COALESCE(sent_at, received_at)')
    .all(order.id);
  const interpretations = db()
    .prepare(
      `SELECT i.id, i.message_id, i.engine, i.model, i.engine_version, i.confidence, i.intent, i.resulting_action, i.output, i.created_at, i.error FROM interpretations i
       JOIN messages m ON m.id = i.message_id WHERE m.order_id = ? ORDER BY i.created_at`,
    )
    .all(order.id)
    .map((i: any) => ({ ...i, output: json(i.output, null) }));
  const exceptions = listExceptions({ orderId: order.id, status: 'all' }).map((e) => ({ ...e, actions: e.status === 'open' ? actionsFor(e) : [] }));
  const role = roleOf(c);
  const transitions = allowedTransitions(order.status).filter((t) => (t === 'cancelled' ? can(role, 'orders.cancel') : true));
  const customer = db().prepare('SELECT id, name, phone, email, address, notes FROM customers WHERE id = ?').get(order.customer_id);
  const replies = db().prepare("SELECT id, body, created_at FROM notifications WHERE order_id = ? AND kind = 'reply_suggestion' ORDER BY created_at DESC LIMIT 3").all(order.id);
  const inv = db().prepare('SELECT invoice_details, invoice_file_id FROM orders WHERE id = ?').get(order.id) as any;
  const invoiceFile = inv?.invoice_file_id ? db().prepare('SELECT id, filename, size, created_at FROM files WHERE id = ?').get(inv.invoice_file_id) : null;
  const feedback = db().prepare('SELECT rating, comment, created_at FROM order_feedback WHERE order_id = ?').get(order.id) ?? null;
  return c.json({
    order, items, events, messages, interpretations, exceptions, transitions, customer, replies,
    money: orderMoney(order.id),
    payment: can(role, 'orders.read') ? paymentSummary(order.id) : null,
    amendments: listAmendments(order.id),
    invoice: { status: order.invoice_status, status_label: INVOICE_LABEL[order.invoice_status], details: json(inv?.invoice_details, null), reference: order.invoice_ref, issued_on: order.invoice_issued_on, sent_at: order.invoice_sent_at, file: invoiceFile },
    notifications: listNotifications({ orderId: order.id, limit: 50 }),
    confirmation_problems: ['review', 'needs_clarification', 'on_hold'].includes(order.status) ? confirmationProblems(order.id) : [],
    finalization: latestFinalization(order.id),
    finalization_history: finalizationHistory(order.id),
    finalization_problems: order.status === 'packed' && !order.finalized_at ? finalizationProblems(order.id) : [],
    declarations: db().prepare('SELECT d.*, u.name AS reviewed_by_name FROM payment_declarations d LEFT JOIN users u ON u.id = d.reviewed_by WHERE d.order_id = ? ORDER BY d.created_at DESC').all(order.id),
    release: { require_payment: getSettings().payments.requirePaymentBeforeRelease, allow_unpaid: getSettings().payments.allowUnpaidRelease },
    feedback,
  });
});

r.patch('/:id', requirePerm('orders.write'), async (c) => {
  const patch = await body(c, OrderPatchSchema);
  const order = updateOrder(c.req.param('id'), patch as any, actorOf(c), roleOf(c));
  return c.json({ order });
});

r.post('/:id/transition', requirePerm('orders.write'), async (c) => {
  const { to, note, unpaid_reason } = await body(c, z.object({ to: z.enum(ORDER_STATUSES), note: z.string().max(500).optional(), unpaid_reason: z.string().max(300).optional() }));
  const role = roleOf(c);
  if (['cutting', 'cut', 'packing', 'packed', 'ready', 'out_for_delivery', 'completed'].includes(to) && !can(role, 'production.write')) throw badRequest('You cannot move orders through production.');
  const order = transition(c.req.param('id'), to as OrderStatus, actorOf(c), role, { note, unpaidReason: unpaid_reason });
  return c.json({ order });
});

// ── Confirmation & timeframe ─────────────────────────────────
const Timeframe = z.object({ expected_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the expected date'), expected_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });

r.post('/:id/confirm', requirePerm('orders.write'), async (c) => {
  const input = await body(c, Timeframe);
  const res = confirmOrder(c.req.param('id'), { expected_from: input.expected_from, expected_to: input.expected_to ?? null }, actorOf(c), roleOf(c));
  return c.json(res);
});

r.post('/:id/timeframe', requirePerm('orders.write'), async (c) => {
  const input = await body(c, Timeframe.extend({ reason: z.string().max(500).default('') }));
  return c.json({ order: changeTimeframe(c.req.param('id'), { expected_from: input.expected_from, expected_to: input.expected_to ?? null, reason: input.reason }, actorOf(c)) });
});

// ── Amendments ───────────────────────────────────────────────
r.post('/:id/amendments', requirePerm('orders.write'), async (c) => {
  const input = await body(
    c,
    z.object({
      kind: z.enum(['change_qty', 'remove_item', 'replace_product', 'timeframe', 'other']),
      reason: z.string().trim().min(1, 'Explain the reason').max(500),
      item_id: z.string().max(64).nullable().optional(),
      product_id: z.string().max(64).nullable().optional(),
      sale_option: z.string().max(40).nullable().optional(),
      qty: QtySchema.nullable().optional(),
      preparation: PrepSchema.nullable(),
      expected_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      expected_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      message: z.string().max(1000).nullable().optional(),
      requires_approval: z.boolean().optional(),
    }),
  );
  return c.json({ amendment: proposeAmendment(c.req.param('id'), input as any, actorOf(c)) });
});

// ── Payments ─────────────────────────────────────────────────
// Final weighing: finalize at the weighed amount, or reopen (with a reason) to change it
r.post('/:id/finalize', requirePerm('orders.write'), async (c) => {
  const input = await body(c, z.object({ packs_confirmed: z.boolean().default(false) }));
  const fin = finalizeOrder(c.req.param('id'), actorOf(c), { packsConfirmed: input.packs_confirmed });
  return c.json({ finalization: fin });
});

r.post('/:id/reopen-final', requirePerm('payments.write'), async (c) => {
  const { reason } = await body(c, z.object({ reason: z.string().trim().min(3, 'Say why the order needs to change').max(500) }));
  return c.json({ order: reopenFinalized(c.req.param('id'), reason, actorOf(c)) });
});

// Payment request: preview (recipients, amount, link, messages), then send by email and/or hand off to WhatsApp
r.get('/:id/payment-request/preview', requirePerm('orders.write'), (c) => c.json(paymentRequestPreview(c.req.param('id'), actorOf(c))));

r.post('/:id/payment-request/send', requirePerm('orders.write'), rateLimit('pay-request-send', 30, 10 * 60_000), async (c) => {
  const input = await body(c, z.object({ email: z.boolean(), resend: z.boolean().default(false) }));
  return c.json({ history: sendPaymentRequest(c.req.param('id'), input, actorOf(c)) });
});

r.post('/:id/payment-request/whatsapp', requirePerm('orders.write'), (c) => c.json({ history: recordWhatsAppHandoff(c.req.param('id'), actorOf(c)) }));

r.post('/:id/payments', requirePerm('payments.write'), async (c) => {
  const input = await body(c, z.object({ method: z.enum(['eft', 'cash', 'card', 'other']), amount_cents: z.number().int().positive().max(100_000_000), note: z.string().max(500).nullable().optional() }));
  const res = recordVerifiedPayment(c.req.param('id'), { method: input.method, amount_cents: input.amount_cents, request_id: openRequest(c.req.param('id'))?.id ?? null, note: input.note ?? null }, actorOf(c), 'staff');
  return c.json({ payment: res.payment, summary: paymentSummary(c.req.param('id')) });
});

// ── Invoice request ──────────────────────────────────────────
const InvoiceDetails = z.object({
  billing_name: z.string().trim().min(2).max(120),
  company: z.string().max(120).nullable().optional(),
  billing_email: z.string().trim().email().max(200),
  billing_address: z.string().max(300).nullable().optional(),
  vat_number: z.string().max(40).nullable().optional(),
  instructions: z.string().max(500).nullable().optional(),
});

r.post('/:id/invoice/request', requirePerm('orders.write'), async (c) => {
  const d = await body(c, InvoiceDetails);
  return c.json({ order: requestInvoice(c.req.param('id'), d as any, actorOf(c)) });
});

r.patch('/:id/invoice', requirePerm('payments.write'), async (c) => {
  const u = await body(
    c,
    z.object({
      status: z.enum(['requested', 'in_progress', 'issued', 'sent', 'cancelled']).optional(),
      reference: z.string().max(80).nullable().optional(),
      issued_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      assignee: z.string().max(64).nullable().optional(),
      details: InvoiceDetails.nullable().optional(),
      notify_customer: z.boolean().optional(),
    }),
  );
  return c.json({ order: updateInvoiceRequest(c.req.param('id'), u as any, actorOf(c)) });
});

r.post('/:id/invoice/file', requirePerm('payments.write'), async (c) => {
  if (Number(c.req.header('content-length') ?? 0) > 11 * 1024 * 1024) throw badRequest('The file is too big. The limit is 10 MB.');
  const form = await c.req.parseBody();
  const file = form.file;
  if (!file || typeof file === 'string') throw badRequest('Choose the invoice file.');
  const stored = storeFile('invoice', c.req.param('id'), file.name, Buffer.from(await file.arrayBuffer()), actorOf(c));
  return c.json({ order: updateInvoiceRequest(c.req.param('id'), { file_id: stored.id }, actorOf(c)), file: stored });
});

// ── Customer link ────────────────────────────────────────────
r.get('/:id/link', requirePerm('orders.write'), (c) => {
  requireOrder(c.req.param('id'));
  return c.json({ url: orderUrl(c.req.param('id')) });
});

r.post('/:id/link/revoke', requirePerm('orders.write'), (c) => {
  const o = requireOrder(c.req.param('id'));
  revokeOrderLinks(o.id);
  addEvent(o.id, 'link_revoked', 'Customer order link replaced (old links no longer work)', actorOf(c));
  return c.json({ url: orderUrl(o.id) });
});

r.post('/:id/items', requirePerm('orders.write'), async (c) => {
  const input = await body(c, ItemSchema);
  const item = addItem(c.req.param('id'), { ...input, preparation: input.preparation ?? {} }, actorOf(c), { reason: 'Added by staff' });
  return c.json({ item });
});

// Permanent delete — managers and admins only (like cancelling)
r.delete('/:id', requirePerm('orders.cancel'), (c) => c.json({ ok: true, ...deleteOrder(c.req.param('id'), actorOf(c)) }));

r.post('/:id/notes', requirePerm('orders.write'), async (c) => {
  const { text } = await body(c, z.object({ text: z.string().min(1).max(1000) }));
  addNote(c.req.param('id'), text, actorOf(c));
  return c.json({ ok: true });
});

r.post('/:id/notified', requirePerm('production.write'), async (c) => {
  const { notified } = await body(c, z.object({ notified: z.boolean().default(true) }));
  return c.json({ order: markCustomerNotified(c.req.param('id'), actorOf(c), notified) });
});

r.post('/:id/packed', requirePerm('production.write'), (c) => c.json({ order: completePacking(c.req.param('id'), actorOf(c)) }));

export const items = new Hono<Env>();

items.patch('/:id', requirePerm('orders.write'), async (c) => {
  const patch = await body(c, z.object({ qty: QtySchema.optional(), sale_option: z.string().max(40).nullable().optional(), preparation: PrepSchema, special_instructions: z.string().max(500).nullable().optional(), product_id: z.string().max(64).optional() }));
  return c.json({ item: updateItem(c.req.param('id'), patch as any, actorOf(c), { reason: 'Edited by staff' }) });
});

items.delete('/:id', requirePerm('orders.write'), (c) => {
  removeItem(c.req.param('id'), actorOf(c), { reason: 'Removed by staff' });
  return c.json({ ok: true });
});

items.post('/:id/packed', requirePerm('production.write'), async (c) => {
  const { packed, packed_weight_g } = await body(c, z.object({ packed: z.boolean(), packed_weight_g: z.number().positive().max(500000).nullable().optional() }));
  setItemPacked(c.req.param('id'), packed, actorOf(c), packed_weight_g ?? null);
  return c.json({ item: getItem(c.req.param('id')) });
});

items.post('/:id/weight', requirePerm('production.write'), async (c) => {
  const { weight_g } = await body(c, z.object({ weight_g: z.number().positive().max(500000).nullable() }));
  return c.json({ item: setItemWeight(c.req.param('id'), weight_g == null ? null : Math.round(weight_g), actorOf(c)) });
});

items.post('/cut', requirePerm('production.write'), async (c) => {
  const { item_ids, cut } = await body(c, z.object({ item_ids: z.array(z.string().max(64)).min(1).max(500), cut: z.boolean() }));
  const orders = setItemsCut(item_ids, cut, actorOf(c));
  return c.json({ ok: true, orders });
});

export default r;

/** Staff-only actions not tied to one order URL. */
export const staffPayments = new Hono<Env>();

staffPayments.post('/proofs/:id/review', requirePerm('payments.write'), async (c) => {
  const input = await body(c, z.discriminatedUnion('accept', [z.object({ accept: z.literal(true), amount_cents: z.number().int().positive().max(100_000_000), note: z.string().max(500).nullable().optional() }), z.object({ accept: z.literal(false), reason: z.string().trim().min(1, 'Give a reason').max(500) })]));
  const payment = reviewProof(c.req.param('id'), input as any, actorOf(c));
  return c.json({ ok: true, payment });
});

staffPayments.post('/declarations/:id/review', requirePerm('payments.write'), async (c) => {
  const input = await body(c, z.discriminatedUnion('accept', [z.object({ accept: z.literal(true), amount_cents: z.number().int().positive().max(100_000_000), note: z.string().max(500).nullable().optional() }), z.object({ accept: z.literal(false), reason: z.string().trim().min(1, 'Say what’s missing').max(500) })]));
  const payment = reviewDeclaration(c.req.param('id'), input as any, actorOf(c));
  return c.json({ ok: true, payment });
});

staffPayments.post('/payments/:id/reverse', requirePerm('payments.write'), async (c) => {
  const { reason } = await body(c, z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }));
  reversePayment(c.req.param('id'), reason, actorOf(c));
  return c.json({ ok: true });
});

/** Private files (proofs, invoices) for signed-in staff only. */
staffPayments.get('/files/:id', requirePerm('orders.read'), (c) => {
  const f = readFile(c.req.param('id'));
  return c.body(new Uint8Array(f.data), 200, fileHeaders(f, c.req.query('inline') === '1'));
});

staffPayments.get('/invoices', requirePerm('orders.read'), (c) => {
  const f = c.req.query('filter');
  return c.json({ requests: listInvoiceRequests(f === 'done' || f === 'all' ? f : 'outstanding') });
});

staffPayments.get('/notifications', requirePerm('system.health'), (c) => c.json({ notifications: listNotifications({ status: c.req.query('status') || null, limit: 300 }), problems: notificationProblemCount() }));

staffPayments.post('/notifications/:id/retry', requirePerm('system.health'), (c) => {
  if (!retryNotification(c.req.param('id'))) throw badRequest('Only a message that failed or wasn’t sent can be tried again.');
  return c.json({ ok: true });
});

staffPayments.post('/amendments/:id/withdraw', requirePerm('orders.write'), (c) => {
  withdrawAmendment(c.req.param('id'), actorOf(c));
  return c.json({ ok: true });
});

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
} from '../domain/orders.js';
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
  return c.json({ order, items, events, messages, interpretations, exceptions, transitions, customer, replies });
});

r.patch('/:id', requirePerm('orders.write'), async (c) => {
  const patch = await body(c, OrderPatchSchema);
  const order = updateOrder(c.req.param('id'), patch as any, actorOf(c), roleOf(c));
  return c.json({ order });
});

r.post('/:id/transition', requirePerm('orders.write'), async (c) => {
  const { to, note } = await body(c, z.object({ to: z.enum(ORDER_STATUSES), note: z.string().max(500).optional() }));
  const role = roleOf(c);
  if (['cutting', 'cut', 'packing', 'packed', 'ready', 'out_for_delivery', 'completed'].includes(to) && !can(role, 'production.write')) throw badRequest('You cannot move orders through production.');
  const order = transition(c.req.param('id'), to as OrderStatus, actorOf(c), role, { note });
  return c.json({ order });
});

r.post('/:id/items', requirePerm('orders.write'), async (c) => {
  const input = await body(c, ItemSchema);
  const item = addItem(c.req.param('id'), { ...input, preparation: input.preparation ?? {} }, actorOf(c), { reason: 'Added by staff' });
  return c.json({ item });
});

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
  const patch = await body(c, z.object({ qty: QtySchema.optional(), preparation: PrepSchema, special_instructions: z.string().max(500).nullable().optional(), product_id: z.string().max(64).optional() }));
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

items.post('/cut', requirePerm('production.write'), async (c) => {
  const { item_ids, cut } = await body(c, z.object({ item_ids: z.array(z.string().max(64)).min(1).max(500), cut: z.boolean() }));
  const orders = setItemsCut(item_ids, cut, actorOf(c));
  return c.json({ ok: true, orders });
});

export default r;

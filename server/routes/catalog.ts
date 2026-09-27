import { Hono } from 'hono';
import { z } from 'zod';
import { db, json } from '../db/db.js';
import { formatQty } from '../../shared/quantity.js';
import { createCustomer, requireCustomer, updateCustomer } from '../domain/customers.js';
import { addAlias, createProduct, listProducts, requireProduct, updateProduct } from '../domain/products.js';
import { getOrderSummary } from '../domain/orders.js';
import { applyPrices, previewPrices } from '../domain/prices.js';
import { actorOf, requirePerm, type Env } from '../http/context.js';
import { body, CustomerSchema } from '../http/schemas.js';

// ── Customers ───────────────────────────────────────────────
export const customers = new Hono<Env>();

customers.get('/', requirePerm('customers.read'), (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const digits = q.replace(/\D/g, '');
  const where = q ? `AND (c.name LIKE ? OR c.email LIKE ? OR (? != '' AND c.phone_normalized LIKE ?))` : '';
  const args = q ? [like, like, digits.length >= 4 ? digits : '', `%${digits.slice(-9)}%`] : [];
  const rows = db()
    .prepare(
      `SELECT c.*, COUNT(o.id) AS order_count, MAX(o.created_at) AS last_order_at,
        SUM(o.status NOT IN ('completed','cancelled')) AS open_orders
       FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'cancelled'
       WHERE c.archived = 0 ${where} GROUP BY c.id ORDER BY ${q ? 'c.name' : 'COALESCE(MAX(o.created_at), c.created_at) DESC'} LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);
  const total = (db().prepare(`SELECT COUNT(*) n FROM customers c WHERE c.archived = 0 ${where}`).get(...args) as any).n;
  return c.json({ customers: rows, total });
});

customers.post('/', requirePerm('customers.write'), async (c) => {
  const input = await body(c, CustomerSchema);
  return c.json({ customer: createCustomer({ ...input, email: input.email || null }, actorOf(c)) });
});

customers.get('/:id', requirePerm('customers.read'), (c) => {
  const customer = requireCustomer(c.req.param('id'));
  const orders = (db().prepare('SELECT id FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100').all(customer.id) as any[]).map((o) => getOrderSummary(o.id));
  const frequent = (
    db()
      .prepare(
        `SELECT p.id, p.canonical_name AS name, p.piece_noun, COUNT(*) times, MAX(o.created_at) last,
          (SELECT i2.qty_kind || '|' || COALESCE(i2.count,'') || '|' || COALESCE(i2.weight_g,'') || '|' || i2.preparation_label FROM order_items i2 JOIN orders o2 ON o2.id = i2.order_id
            WHERE o2.customer_id = o.customer_id AND i2.product_id = p.id AND i2.status = 'active' ORDER BY o2.created_at DESC LIMIT 1) AS last_line
         FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
         WHERE o.customer_id = ? AND o.status != 'cancelled' AND i.status = 'active'
         GROUP BY p.id ORDER BY times DESC, last DESC LIMIT 8`,
      )
      .all(customer.id) as any[]
  ).map((f) => {
    const [kind, count, weight, prep] = (f.last_line ?? '').split('|');
    const usual = kind ? formatQty({ kind, count: count ? Number(count) : null, weight_g: weight ? Number(weight) : null } as any, f.piece_noun) : '';
    return { id: f.id, name: f.name, times: f.times, last: f.last, usual: prep ? `${usual} · ${prep}` : usual };
  });
  const amendments = (db()
    .prepare(
      `SELECT e.summary, e.created_at, o.order_number, o.id AS order_id FROM order_events e JOIN orders o ON o.id = e.order_id
       WHERE o.customer_id = ? AND e.type IN ('item_amended','amendment_applied','item_removed') ORDER BY e.created_at DESC LIMIT 10`,
    )
    .all(customer.id)) as any[];
  const messages = db().prepare('SELECT id, channel, body, received_at, classification, order_id FROM messages WHERE customer_id = ? OR order_id IN (SELECT id FROM orders WHERE customer_id = ?) ORDER BY received_at DESC LIMIT 15').all(customer.id, customer.id);
  const stats = db()
    .prepare(`SELECT COUNT(*) total, SUM(status = 'completed') completed, SUM(status NOT IN ('completed','cancelled')) open, MIN(created_at) first FROM orders WHERE customer_id = ?`)
    .get(customer.id);
  return c.json({ customer, orders, frequent, amendments, messages, stats });
});

customers.patch('/:id', requirePerm('customers.write'), async (c) => {
  const input = await body(c, CustomerSchema.partial().extend({ archived: z.boolean().optional() }));
  return c.json({ customer: updateCustomer(c.req.param('id'), { ...input, email: input.email === '' ? null : input.email } as any, actorOf(c)) });
});

// ── Products ───────────────────────────────────────────────
export const products = new Hono<Env>();

const PrepInput = z.object({
  group_name: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  keywords: z.array(z.string().max(60)).max(30).optional(),
  is_default: z.boolean().optional(),
  customer_visible: z.boolean().optional(),
  active: z.boolean().optional(),
});
const ProductInput = z.object({
  canonical_name: z.string().trim().min(1, 'Enter the product name').max(120),
  customer_name: z.string().trim().max(120).nullable().optional(),
  category: z.string().trim().min(1).max(60),
  description: z.string().max(1000).nullable().optional(),
  quantity_type: z.enum(['weight', 'count', 'either']),
  allows_portions: z.boolean().optional(),
  piece_noun: z.string().trim().max(30).optional(),
  typical_piece_g: z.number().int().positive().max(100000).nullable().optional(),
  price_cents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  price_unit: z.enum(['kg', 'each']).nullable().optional(),
  packaging: z.string().max(200).nullable().optional(),
  active: z.boolean().optional(),
  customer_visible: z.boolean().optional(),
  internal_notes: z.string().max(2000).nullable().optional(),
  aliases: z.array(z.string().max(80)).max(100).optional(),
  preparations: z.array(PrepInput).max(60).optional(),
});

products.get('/', requirePerm('products.read'), (c) => {
  const usage = new Map(
    (db().prepare("SELECT product_id, COUNT(*) n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.status = 'active' AND o.created_at >= ? GROUP BY product_id").all(new Date(Date.now() - 90 * 86400_000).toISOString()) as any[]).map((r) => [r.product_id, r.n]),
  );
  return c.json({ products: listProducts().map((p) => ({ ...p, orders_90d: usage.get(p.id) ?? 0 })) });
});

products.post('/prices/preview', requirePerm('products.write'), async (c) => {
  const { text } = await body(c, z.object({ text: z.string().min(1, 'Paste your price list').max(100_000) }));
  return c.json({ lines: previewPrices(text) });
});

products.post('/prices/apply', requirePerm('products.write'), async (c) => {
  const { changes } = await body(c, z.object({ changes: z.array(z.object({ product_id: z.string().max(64), price_cents: z.number().int().positive().max(10_000_000), price_unit: z.enum(['kg', 'each']) })).max(500) }));
  return c.json({ updated: applyPrices(changes, actorOf(c)) });
});

products.get('/:id', requirePerm('products.read'), (c) => c.json({ product: requireProduct(c.req.param('id')) }));

products.post('/', requirePerm('products.write'), async (c) => {
  const input = await body(c, ProductInput);
  return c.json({ product: createProduct(input as any, actorOf(c)) });
});

products.patch('/:id', requirePerm('products.write'), async (c) => {
  const input = await body(c, ProductInput.partial());
  return c.json({ product: updateProduct(c.req.param('id'), input as any, actorOf(c)) });
});

products.post('/:id/aliases', requirePerm('products.write'), async (c) => {
  const { phrase } = await body(c, z.object({ phrase: z.string().trim().min(1).max(80) }));
  return c.json({ product: addAlias(c.req.param('id'), phrase, 'admin', actorOf(c)) });
});

export { json };

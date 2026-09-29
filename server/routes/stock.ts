import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { can } from '../../shared/permissions.js';
import { actorOf, requirePerm, roleOf, type Env } from '../http/context.js';
import { body, ymdParam } from '../http/schemas.js';
import {
  cancelPurchase,
  createPurchase,
  deleteItem,
  deletePurchase,
  deleteSupplier,
  EXPENSE_CATEGORIES,
  getPurchase,
  itemHistory,
  listItems,
  listPurchases,
  listSuppliers,
  planRange,
  planStock,
  receivePurchase,
  recordMovement,
  requireItem,
  saveItem,
  saveSupplier,
  seedStockOnce,
  setYields,
  stockOverview,
  stockTake,
  STOCK_KINDS,
  updatePurchase,
  yieldTemplate,
} from '../domain/stock.js';
import { stockAdvice, suggestYieldsAI } from '../intelligence/stock-advisor.js';
import { aiAvailable } from '../intelligence/ai.js';

/** Stock, suppliers, purchases and the stock planner. Costs and spending are for managers. */
const r = new Hono<Env>();

const seeClosely = (c: Context<Env>) => can(roleOf(c), 'stock.costs');
/** Staff can count and use stock without seeing what it cost. */
function hideCosts<T extends Record<string, any>>(c: Context<Env>, row: T): T {
  if (seeClosely(c)) return row;
  const { cost_cents: _a, value_cents: _b, est_cost_cents: _c, ...rest } = row as any;
  return rest;
}

const num = z.number().finite();
const ItemInput = z.object({
  name: z.string().trim().min(1, 'Give the stock item a name').max(120).optional(),
  kind: z.enum(STOCK_KINDS as [string, ...string[]]).optional(),
  unit: z.enum(['kg', 'each', 'pack']).optional(),
  reorder_level: num.min(0).max(1_000_000).nullable().optional(),
  avg_weight_kg: num.min(0).max(5000).nullable().optional(),
  cost_cents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  supplier_id: z.string().max(64).nullable().optional(),
  product_id: z.string().max(64).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
  on_hand: num.min(0).max(1_000_000).optional(),
});
const SupplierInput = z.object({
  name: z.string().trim().min(1, 'Enter the supplier’s name').max(120).optional(),
  contact_name: z.string().max(120).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().max(160).nullable().optional(),
  supplies: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});
const LineInput = z.object({
  item_id: z.string().max(64).nullable().optional(),
  description: z.string().max(200).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  qty: num.positive().max(1_000_000),
  weight_kg: num.min(0).max(1_000_000).nullable().optional(),
  cost_per: z.enum(['unit', 'kg']).optional(),
  unit_cost_cents: z.number().int().min(0).max(1_000_000_000),
});
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date');
const PurchaseInput = z.object({
  supplier_id: z.string().max(64).nullable().optional(),
  ordered_on: Ymd,
  reference: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(LineInput).min(1, 'Add at least one line').max(100),
  received: z.boolean().optional(),
});

// Overview
r.get('/', requirePerm('stock.read'), (c) => {
  seedStockOnce();
  const o = stockOverview();
  const costs = seeClosely(c);
  return c.json({
    ...o,
    spend: costs ? o.spend : null,
    by_category_90d: costs ? o.by_category_90d : [],
    by_supplier_90d: costs ? o.by_supplier_90d : [],
    monthly: costs ? o.monthly : [],
    stock_value_cents: costs ? o.stock_value_cents : null,
    awaiting: costs ? o.awaiting : [],
    categories: EXPENSE_CATEGORIES,
    can_see_costs: costs,
    ai: aiAvailable(),
  });
});

// Items
r.get('/items', requirePerm('stock.read'), (c) => {
  seedStockOnce();
  return c.json({ items: listItems().map((i) => hideCosts(c, i)) });
});
r.post('/items', requirePerm('stock.write'), async (c) => {
  const input = await body(c, ItemInput);
  if (!seeClosely(c)) delete (input as any).cost_cents;
  return c.json({ item: hideCosts(c, saveItem(null, input as any, actorOf(c))) });
});
r.get('/items/:id', requirePerm('stock.read'), (c) => {
  const h = itemHistory(c.req.param('id'));
  const costs = seeClosely(c);
  return c.json({ ...h, item: hideCosts(c, h.item), purchases: costs ? h.purchases : [], template: yieldTemplate(h.item.id)?.label ?? null });
});
r.patch('/items/:id', requirePerm('stock.write'), async (c) => {
  const input = await body(c, ItemInput);
  if (!seeClosely(c)) delete (input as any).cost_cents;
  delete (input as any).on_hand; // on hand only changes through movements, so there's always a record
  return c.json({ item: hideCosts(c, saveItem(c.req.param('id'), input as any, actorOf(c))) });
});
r.delete('/items/:id', requirePerm('stock.costs'), (c) => {
  deleteItem(c.req.param('id'), actorOf(c));
  return c.json({ ok: true });
});
r.post('/items/:id/move', requirePerm('stock.write'), async (c) => {
  const input = await body(c, z.object({ kind: z.enum(['received', 'used', 'count', 'waste', 'adjust']), qty: num.min(-1_000_000).max(1_000_000), note: z.string().max(500).nullable().optional() }));
  return c.json(recordMovement(c.req.param('id'), input.kind, input.qty, input.note ?? null, actorOf(c)));
});
r.put('/items/:id/yields', requirePerm('stock.write'), async (c) => {
  const input = await body(c, z.object({ rows: z.array(z.object({ product_id: z.string().max(64), pct: num.positive().max(100), part: z.string().max(60).nullable().optional() })).max(80) }));
  return c.json({ yields: setYields(c.req.param('id'), input.rows, actorOf(c)) });
});
/** A starting point for the yields: the assistant's draft if it's on, otherwise typical figures. Nothing is saved. */
r.post('/items/:id/suggest-yields', requirePerm('stock.write'), async (c) => {
  const item = requireItem(c.req.param('id'));
  const ai = await suggestYieldsAI(item);
  if (ai) return c.json({ source: 'assistant', rows: ai.rows, note: ai.note });
  const t = yieldTemplate(item.id);
  if (t) return c.json({ source: 'typical', rows: t.rows, note: `Typical figures for a ${t.label.toLowerCase()}. Adjust them once you’ve weighed a few of your own.` });
  return c.json({ source: 'none', rows: [], note: 'There are no typical figures for this item. Add the products it gives and roughly what share of its weight each one is.' });
});

r.post('/take', requirePerm('stock.write'), async (c) => {
  const input = await body(c, z.object({ counts: z.array(z.object({ item_id: z.string().max(64), counted: num.min(0).max(1_000_000) })).min(1).max(500), note: z.string().max(500).nullable().optional() }));
  return c.json(stockTake(input.counts, input.note ?? null, actorOf(c)));
});

// Suppliers
r.get('/suppliers', requirePerm('stock.read'), (c) => {
  const list = listSuppliers();
  return c.json({ suppliers: seeClosely(c) ? list : list.map(({ spend_12m_cents: _s, ...rest }) => rest) });
});
r.post('/suppliers', requirePerm('stock.costs'), async (c) => c.json({ supplier: saveSupplier(null, await body(c, SupplierInput), actorOf(c)) }));
r.patch('/suppliers/:id', requirePerm('stock.costs'), async (c) => c.json({ supplier: saveSupplier(c.req.param('id'), await body(c, SupplierInput), actorOf(c)) }));
r.delete('/suppliers/:id', requirePerm('stock.costs'), (c) => {
  deleteSupplier(c.req.param('id'), actorOf(c));
  return c.json({ ok: true });
});

// Purchases (stock orders & expenses)
r.get('/purchases', requirePerm('stock.costs'), (c) =>
  c.json({ purchases: listPurchases({ from: ymdParam(c.req.query('from')), to: ymdParam(c.req.query('to')), supplier_id: c.req.query('supplier') || null }) }),
);
r.post('/purchases', requirePerm('stock.costs'), async (c) => c.json({ purchase: createPurchase(await body(c, PurchaseInput), actorOf(c)) }));
r.get('/purchases/:id', requirePerm('stock.costs'), (c) => c.json({ purchase: getPurchase(c.req.param('id')) }));
r.patch('/purchases/:id', requirePerm('stock.costs'), async (c) => c.json({ purchase: updatePurchase(c.req.param('id'), await body(c, PurchaseInput.partial()), actorOf(c)) }));
r.post('/purchases/:id/receive', requirePerm('stock.costs'), async (c) => {
  const input = await body(c, z.object({ received_on: Ymd.optional() }));
  return c.json({ purchase: receivePurchase(c.req.param('id'), input.received_on ?? null, actorOf(c)) });
});
r.post('/purchases/:id/cancel', requirePerm('stock.costs'), (c) => c.json({ purchase: cancelPurchase(c.req.param('id'), actorOf(c)) }));
r.delete('/purchases/:id', requirePerm('stock.costs'), (c) => {
  deletePurchase(c.req.param('id'), actorOf(c));
  return c.json({ ok: true });
});

// Planner
r.get('/plan', requirePerm('stock.read'), (c) => {
  seedStockOnce();
  const range = planRange(c.req.query('range'), ymdParam(c.req.query('from')), ymdParam(c.req.query('to')));
  const plan = planStock(range);
  return c.json({ ...plan, label: range.label, sources: plan.sources.map((s) => hideCosts(c, s)), est_total_cents: seeClosely(c) ? plan.est_total_cents : null });
});
r.post('/plan/advice', requirePerm('stock.read'), async (c) => {
  const input = await body(c, z.object({ range: z.string().max(20).optional(), from: Ymd.optional(), to: Ymd.optional(), question: z.string().max(1000).nullable().optional() }));
  const plan = planStock(planRange(input.range, input.from ?? null, input.to ?? null));
  if (!seeClosely(c)) plan.sources.forEach((s) => (s.est_cost_cents = null));
  const recent = seeClosely(c)
    ? (listPurchases({ limit: 8 }) as any[]).filter((p) => p.status !== 'cancelled').map((p) => `${p.ordered_on}: ${p.supplier_name ?? 'no supplier'} — ${p.summary ?? ''} (R${Math.round(p.total_cents / 100)})`)
    : [];
  return c.json(await stockAdvice(plan, { notes: input.question ?? null, recentPurchases: recent }));
});

export default r;

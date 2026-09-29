import { db, id, now, tx } from '../db/db.js';
import { normalise } from '../../shared/text.js';
import { totalGrams, type Qty } from '../../shared/quantity.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { addDays, localDate } from '../lib/time.js';
import { businessTz, getSettings, updateSettings } from '../services/settings.js';
import { listProducts, type Product } from './products.js';

/**
 * Stock: what's on hand (carcasses, frozen cuts, spices, packaging), the suppliers it comes from,
 * what was ordered in and what it cost, and how a carcass is usually cut up (yields). The planner
 * turns open orders into "what we need to order", using those yields. Everything here is
 * deterministic and explainable; the assistant only ever comments on these numbers.
 */

export type StockKind = 'carcass' | 'cut' | 'ingredient' | 'packaging' | 'other';
export type StockUnit = 'kg' | 'each' | 'pack';
export const STOCK_KINDS: StockKind[] = ['carcass', 'cut', 'ingredient', 'packaging', 'other'];
export const EXPENSE_CATEGORIES = ['Beef', 'Lamb', 'Other meat', 'Spices & ingredients', 'Packaging', 'Abattoir & processing', 'Transport', 'Equipment & repairs', 'Other'] as const;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ── Suppliers ──────────────────────────────────────────────
export interface Supplier {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  supplies: string | null;
  notes: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}
export type SupplierInput = Partial<Pick<Supplier, 'contact_name' | 'phone' | 'email' | 'supplies' | 'notes'>> & { name?: string; active?: boolean };

const clean = (v: string | null | undefined) => (v == null ? null : v.trim() || null);

export function listSuppliers() {
  return db()
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id AND p.status != 'cancelled') AS purchase_count,
        (SELECT COALESCE(SUM(total_cents),0) FROM purchases p WHERE p.supplier_id = s.id AND p.status != 'cancelled' AND p.ordered_on >= ?) AS spend_12m_cents,
        (SELECT MAX(ordered_on) FROM purchases p WHERE p.supplier_id = s.id AND p.status != 'cancelled') AS last_ordered_on
       FROM suppliers s ORDER BY s.active DESC, s.name COLLATE NOCASE`,
    )
    .all(addDays(today(), -365)) as (Supplier & { purchase_count: number; spend_12m_cents: number; last_ordered_on: string | null })[];
}

export function requireSupplier(sid: string): Supplier {
  const s = db().prepare('SELECT * FROM suppliers WHERE id = ?').get(sid) as Supplier | undefined;
  if (!s) throw notFound('That supplier');
  return s;
}

export function saveSupplier(sid: string | null, input: SupplierInput, actor: Actor): Supplier {
  const ts = now();
  if (!sid) {
    const name = input.name?.trim();
    if (!name) throw badRequest('The supplier needs a name.');
    sid = id('su_');
    db()
      .prepare('INSERT INTO suppliers (id, name, contact_name, phone, email, supplies, notes, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(sid, name, clean(input.contact_name), clean(input.phone), clean(input.email)?.toLowerCase() ?? null, clean(input.supplies), clean(input.notes), input.active === false ? 0 : 1, ts, ts);
    audit(actor, 'supplier.created', 'supplier', sid, `Added supplier ${name}`, input);
  } else {
    const before = requireSupplier(sid);
    const f: Record<string, unknown> = {};
    if (input.name !== undefined) {
      if (!input.name.trim()) throw badRequest('The supplier needs a name.');
      f.name = input.name.trim();
    }
    for (const k of ['contact_name', 'phone', 'supplies', 'notes'] as const) if (input[k] !== undefined) f[k] = clean(input[k]);
    if (input.email !== undefined) f.email = clean(input.email)?.toLowerCase() ?? null;
    if (input.active !== undefined) f.active = input.active ? 1 : 0;
    if (Object.keys(f).length) {
      db().prepare(`UPDATE suppliers SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(f), ts, sid);
      audit(actor, 'supplier.updated', 'supplier', sid, `Updated supplier ${before.name}`, { changes: input });
    }
  }
  publish(['stock']);
  return requireSupplier(sid);
}

export function deleteSupplier(sid: string, actor: Actor) {
  const s = requireSupplier(sid);
  // Purchases keep their history; they just no longer point at a supplier
  db().prepare('DELETE FROM suppliers WHERE id = ?').run(sid);
  audit(actor, 'supplier.deleted', 'supplier', sid, `Deleted supplier ${s.name}`, s);
  publish(['stock']);
}

// ── Stock items ────────────────────────────────────────────
export interface StockItem {
  id: string;
  name: string;
  kind: StockKind;
  unit: StockUnit;
  on_hand: number;
  reorder_level: number | null;
  avg_weight_kg: number | null;
  cost_cents: number | null;
  supplier_id: string | null;
  product_id: string | null;
  notes: string | null;
  active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
export type StockItemInput = {
  name?: string;
  kind?: StockKind;
  unit?: StockUnit;
  reorder_level?: number | null;
  avg_weight_kg?: number | null;
  cost_cents?: number | null;
  supplier_id?: string | null;
  product_id?: string | null;
  notes?: string | null;
  active?: boolean;
  on_hand?: number;
};

export function requireItem(iid: string): StockItem {
  const it = db().prepare('SELECT * FROM stock_items WHERE id = ?').get(iid) as StockItem | undefined;
  if (!it) throw notFound('That stock item');
  return it;
}

/** Kilograms in one unit of an item (null when a piece has no typical weight yet). */
export function kgPerUnit(it: Pick<StockItem, 'unit' | 'avg_weight_kg'>): number | null {
  if (it.unit === 'kg') return 1;
  return it.avg_weight_kg && it.avg_weight_kg > 0 ? it.avg_weight_kg : null;
}

export function listItems() {
  const rows = db()
    .prepare(
      `SELECT i.*, s.name AS supplier_name, p.canonical_name AS product_name,
        (SELECT COUNT(*) FROM stock_yields y WHERE y.item_id = i.id) AS yield_count,
        (SELECT MAX(created_at) FROM stock_movements m WHERE m.item_id = i.id AND m.kind = 'count') AS last_counted_at
       FROM stock_items i LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN products p ON p.id = i.product_id
       ORDER BY i.active DESC, CASE i.kind WHEN 'carcass' THEN 0 WHEN 'cut' THEN 1 WHEN 'ingredient' THEN 2 WHEN 'packaging' THEN 3 ELSE 4 END, i.sort_order, i.name COLLATE NOCASE`,
    )
    .all() as (StockItem & { supplier_name: string | null; product_name: string | null; yield_count: number; last_counted_at: string | null })[];
  return rows.map((r) => ({
    ...r,
    low: r.active && r.reorder_level != null && r.on_hand <= r.reorder_level,
    value_cents: r.cost_cents != null ? Math.round(r.on_hand * r.cost_cents) : null,
  }));
}

function checkRefs(input: StockItemInput) {
  if (input.supplier_id) requireSupplier(input.supplier_id);
  if (input.product_id && !listProducts().some((p) => p.id === input.product_id)) throw notFound('That product');
  for (const k of ['reorder_level', 'avg_weight_kg', 'on_hand'] as const) {
    const v = input[k];
    if (v != null && (!Number.isFinite(v) || v < 0)) throw badRequest('Quantities can’t be negative.');
  }
}

export function saveItem(iid: string | null, input: StockItemInput, actor: Actor): StockItem {
  checkRefs(input);
  const ts = now();
  if (!iid) {
    const name = input.name?.trim();
    if (!name) throw badRequest('Give the stock item a name.');
    iid = id('si_');
    const start = r3(input.on_hand ?? 0);
    tx(() => {
      db()
        .prepare(
          `INSERT INTO stock_items (id, name, kind, unit, on_hand, reorder_level, avg_weight_kg, cost_cents, supplier_id, product_id, notes, active, sort_order, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(iid, name, input.kind ?? 'other', input.unit ?? 'kg', start, input.reorder_level ?? null, input.avg_weight_kg ?? null, input.cost_cents ?? null, input.supplier_id ?? null, input.product_id ?? null, clean(input.notes), input.active === false ? 0 : 1, 0, ts, ts);
      if (start) db().prepare("INSERT INTO stock_movements (id, item_id, kind, qty, balance, note, created_by, created_at) VALUES (?,?,'count',?,?,?,?,?)").run(id('sm_'), iid, start, start, 'Opening stock', actor.userId, ts);
      audit(actor, 'stock.item_created', 'stock_item', iid, `Added stock item ${name}`, input);
    });
  } else {
    const before = requireItem(iid);
    const f: Record<string, unknown> = {};
    if (input.name !== undefined) {
      if (!input.name.trim()) throw badRequest('Give the stock item a name.');
      f.name = input.name.trim();
    }
    for (const k of ['kind', 'unit', 'reorder_level', 'avg_weight_kg', 'cost_cents', 'supplier_id', 'product_id'] as const) if (input[k] !== undefined) f[k] = input[k] ?? null;
    if (input.notes !== undefined) f.notes = clean(input.notes);
    if (input.active !== undefined) f.active = input.active ? 1 : 0;
    if (f.unit && f.unit !== before.unit && before.on_hand) throw conflict('Count this item down to zero before changing its unit, so the numbers stay right.');
    if (Object.keys(f).length) {
      db().prepare(`UPDATE stock_items SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(f), ts, iid);
      audit(actor, 'stock.item_updated', 'stock_item', iid, `Updated stock item ${before.name}`, { changes: input });
    }
  }
  publish(['stock']);
  return requireItem(iid);
}

export function deleteItem(iid: string, actor: Actor) {
  const it = requireItem(iid);
  tx(() => {
    db().prepare('UPDATE purchase_lines SET item_id = NULL WHERE item_id = ?').run(iid);
    db().prepare('DELETE FROM stock_items WHERE id = ?').run(iid); // movements and yields cascade
    audit(actor, 'stock.item_deleted', 'stock_item', iid, `Deleted stock item ${it.name}`, it);
  });
  publish(['stock']);
}

// ── Movements & stock take ─────────────────────────────────
export type MovementKind = 'received' | 'used' | 'count' | 'waste' | 'adjust';

/**
 * Records a change to what's on hand. `count` sets the new total (a stock take);
 * `received` adds; `used` and `waste` take away; `adjust` adds a signed amount.
 */
export function moveStock(iid: string, kind: MovementKind, qty: number, note: string | null, actor: Actor, opts: { purchaseId?: string; silent?: boolean } = {}) {
  if (!Number.isFinite(qty)) throw badRequest('Enter a number.');
  const it = requireItem(iid);
  let change: number;
  if (kind === 'count') {
    if (qty < 0) throw badRequest('A count can’t be negative.');
    change = qty - it.on_hand;
  } else if (kind === 'received') change = Math.abs(qty);
  else if (kind === 'used' || kind === 'waste') change = -Math.abs(qty);
  else change = qty;
  const balance = r3(Math.max(0, it.on_hand + change));
  change = r3(balance - it.on_hand);
  const ts = now();
  db().prepare('UPDATE stock_items SET on_hand = ?, updated_at = ? WHERE id = ?').run(balance, ts, iid);
  db()
    .prepare('INSERT INTO stock_movements (id, item_id, kind, qty, balance, note, purchase_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id('sm_'), iid, kind, change, balance, clean(note), opts.purchaseId ?? null, actor.userId, ts);
  if (!opts.silent) publish(['stock']);
  return { item_id: iid, change, balance };
}

export function recordMovement(iid: string, kind: MovementKind, qty: number, note: string | null, actor: Actor) {
  const it = requireItem(iid);
  const res = tx(() => {
    const r = moveStock(iid, kind, qty, note, actor, { silent: true });
    audit(actor, `stock.${kind}`, 'stock_item', iid, `${KIND_VERB[kind]} ${it.name}: ${r.change > 0 ? '+' : ''}${r.change} ${it.unit} (now ${r.balance})`, { qty, note });
    return r;
  });
  publish(['stock']);
  return res;
}

const KIND_VERB: Record<MovementKind, string> = { received: 'Received', used: 'Used', count: 'Counted', waste: 'Wasted', adjust: 'Adjusted' };

/** A stock take: the counted amount for each item becomes what's on hand. Items not listed are left alone. */
export function stockTake(counts: { item_id: string; counted: number }[], note: string | null, actor: Actor) {
  const results = tx(() => {
    const out = counts.map((c) => ({ ...moveStock(c.item_id, 'count', c.counted, note || 'Stock take', actor, { silent: true }), name: requireItem(c.item_id).name }));
    const changed = out.filter((o) => o.change !== 0);
    audit(actor, 'stock.take', 'stock', null, `Stock take: ${out.length} item${out.length === 1 ? '' : 's'} counted, ${changed.length} changed`, { counts, note });
    return out;
  });
  publish(['stock']);
  return { counted: results.length, changed: results.filter((r) => r.change !== 0).length, results };
}

export function itemHistory(iid: string) {
  const item = requireItem(iid);
  const movements = db()
    .prepare(`SELECT m.*, u.name AS by_name FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by WHERE m.item_id = ? ORDER BY m.created_at DESC LIMIT 60`)
    .all(iid);
  const purchases = db()
    .prepare(
      `SELECT p.id, p.ordered_on, p.received_on, p.status, s.name AS supplier_name, l.qty, l.weight_kg, l.cost_per, l.unit_cost_cents, l.total_cents
       FROM purchase_lines l JOIN purchases p ON p.id = l.purchase_id LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE l.item_id = ? AND p.status != 'cancelled' ORDER BY p.ordered_on DESC LIMIT 12`,
    )
    .all(iid);
  return { item, movements, purchases, yields: getYields(iid) };
}

// ── Yields (how a carcass is cut) ──────────────────────────
export function getYields(iid: string) {
  return db()
    .prepare(`SELECT y.product_id, y.pct, y.part, p.canonical_name AS product_name, p.category, p.price_cents, p.price_unit FROM stock_yields y JOIN products p ON p.id = y.product_id WHERE y.item_id = ? ORDER BY y.sort_order, y.pct DESC`)
    .all(iid) as { product_id: string; pct: number; part: string | null; product_name: string; category: string; price_cents: number | null; price_unit: 'kg' | 'each' | null }[];
}

export interface YieldRow {
  product_id: string;
  pct: number;
  /** Products that are different ways of cutting the same part share one %: the part's share of the weight. */
  part?: string | null;
}

export function setYields(iid: string, rows: YieldRow[], actor: Actor) {
  const it = requireItem(iid);
  const products = new Set(listProducts().map((p) => p.id));
  const seen = new Set<string>();
  const partPct = new Map<string, number>();
  let total = 0;
  const clean = rows.map((r) => ({ ...r, part: r.part?.trim() || null }));
  for (const r of clean) {
    if (!products.has(r.product_id)) throw notFound('One of the products');
    if (seen.has(r.product_id)) throw badRequest('Each product can only be listed once.');
    if (!(r.pct > 0 && r.pct <= 100)) throw badRequest('Each yield must be between 0 and 100%.');
    seen.add(r.product_id);
    if (r.part) {
      const key = normalise(r.part);
      if (!partPct.has(key)) {
        partPct.set(key, r.pct);
        total += r.pct;
      }
      r.pct = partPct.get(key)!; // every cut of a part carries the part's share
    } else total += r.pct;
  }
  if (total > 100.0001) throw badRequest(`The yields add up to ${Math.round(total * 10) / 10}%. They can’t come to more than 100% of the weight.`);
  tx(() => {
    db().prepare('DELETE FROM stock_yields WHERE item_id = ?').run(iid);
    const ins = db().prepare('INSERT INTO stock_yields (id, item_id, product_id, pct, part, sort_order) VALUES (?,?,?,?,?,?)');
    clean.forEach((r, i) => ins.run(id('sy_'), iid, r.product_id, Math.round(r.pct * 100) / 100, r.part, i));
    audit(actor, 'stock.yields_updated', 'stock_item', iid, `Updated cutting yields for ${it.name} (${clean.length} products, ${Math.round(total)}%)`, { rows: clean });
  });
  publish(['stock']);
  return getYields(iid);
}

/**
 * Starting-point yields (percent of the weight) for the usual carcass pieces, by product slug.
 * Rough South African butchery figures — every farm cuts differently, so the family should
 * adjust these after weighing a few of their own.
 */
const RIB = 'Rib';
const LOIN = 'Short loin';
const TRIM = 'Trim for mince & wors';
const SHOULDER = 'Shoulder';
const YIELD_TEMPLATES: { match: RegExp; label: string; rows: [slug: string, pct: number, part?: string][] }[] = [
  {
    match: /hind/,
    label: 'Beef hindquarter',
    rows: [
      ['beef_fillet', 2.5], ['beef_rump', 7], ['beef_sirloin', 8, LOIN], ['beef_tbone', 8, LOIN], ['beef_porterhouse', 8, LOIN],
      ['biltong_a_grade', 7], ['biltong_geel_vet', 2], ['beef_minute_steak', 3], ['beef_goulash', 6], ['beef_shin', 4],
      ['beef_mince_lean', 22, TRIM], ['beef_mince_8020', 22, TRIM], ['wors_normal', 22, TRIM], ['beef_stewing', 4], ['beef_bones', 10], ['beef_body_fat', 5],
    ],
  },
  {
    match: /fore|front/,
    label: 'Beef forequarter',
    rows: [
      ['beef_ribeye', 5, RIB], ['beef_ribeye_bone', 5, RIB], ['beef_tomahawk', 5, RIB], ['beef_short_rib', 5], ['beef_brisket', 7], ['beef_chuck_chops', 8], ['beef_blade_chops', 6],
      ['beef_stewing', 10], ['beef_goulash', 6], ['beef_mince_8020', 21, TRIM], ['wors_normal', 21, TRIM], ['droewors', 1], ['beef_shin', 3], ['beef_bones', 12], ['beef_brisket_fat', 2],
    ],
  },
  {
    match: /side|half.*(beef|cow|carcass)|beef.*half/,
    label: 'Beef side',
    rows: [
      ['beef_fillet', 1.2], ['beef_rump', 3.5], ['beef_sirloin', 4, LOIN], ['beef_tbone', 4, LOIN], ['beef_ribeye', 2.5, RIB], ['beef_tomahawk', 2.5, RIB], ['biltong_a_grade', 3.5],
      ['beef_brisket', 3.5], ['beef_chuck_chops', 4], ['beef_short_rib', 2.5], ['beef_goulash', 6], ['beef_stewing', 7], ['beef_mince_lean', 22, TRIM], ['beef_mince_8020', 22, TRIM], ['wors_normal', 22, TRIM],
      ['beef_shin', 3.5], ['beef_bones', 12], ['beef_body_fat', 3],
    ],
  },
  {
    match: /lamb|sheep|mutton/,
    label: 'Whole lamb',
    rows: [['lamb_leg', 30], ['lamb_shoulder', 20, SHOULDER], ['lamb_shoulder_chops', 20, SHOULDER], ['lamb_loin_chops', 12], ['lamb_rib_chops', 8], ['lamb_shanks', 6], ['lamb_ribs', 8], ['lamb_stew', 8], ['lamb_tails', 1]],
  },
];

export function yieldTemplate(iid: string): { label: string; rows: { product_id: string; pct: number; part: string | null; product_name: string }[] } | null {
  const it = requireItem(iid);
  const n = normalise(it.name);
  const t = YIELD_TEMPLATES.find((x) => x.match.test(n));
  if (!t) return null;
  const bySlug = new Map(listProducts().map((p) => [p.slug, p]));
  const rows = t.rows.flatMap(([slug, pct, part]) => {
    const p = bySlug.get(slug);
    return p ? [{ product_id: p.id, pct, part: part ?? null, product_name: p.canonical_name }] : [];
  });
  return rows.length ? { label: t.label, rows } : null;
}

// ── Purchases (stock orders & expenses) ────────────────────
export interface PurchaseLineInput {
  item_id?: string | null;
  description?: string | null;
  category?: string | null;
  qty: number;
  weight_kg?: number | null;
  cost_per?: 'unit' | 'kg';
  unit_cost_cents: number;
}
export interface PurchaseInput {
  supplier_id?: string | null;
  ordered_on: string;
  reference?: string | null;
  notes?: string | null;
  lines: PurchaseLineInput[];
  received?: boolean;
}

function categoryFor(it: StockItem | null): string {
  if (!it) return 'Other';
  const n = normalise(it.name);
  if (it.kind === 'ingredient') return 'Spices & ingredients';
  if (it.kind === 'packaging') return 'Packaging';
  if (/lamb|sheep|mutton/.test(n)) return 'Lamb';
  if (/beef|cow|ox|hind|fore|brisket|rump|fillet|sirloin|steak|mince|wors/.test(n)) return 'Beef';
  return it.kind === 'carcass' || it.kind === 'cut' ? 'Other meat' : 'Other';
}

function lineTotal(l: PurchaseLineInput, it: StockItem | null): { weight: number | null; total: number } {
  let weight = l.weight_kg ?? null;
  if (l.cost_per === 'kg' && weight == null) weight = it?.unit === 'kg' ? l.qty : it ? (kgPerUnit(it) ?? 0) * l.qty || null : l.qty;
  const total = l.cost_per === 'kg' ? Math.round((weight ?? 0) * l.unit_cost_cents) : Math.round(l.qty * l.unit_cost_cents);
  return { weight, total };
}

export function getPurchase(pid: string) {
  const p = db().prepare('SELECT p.*, s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?').get(pid) as any;
  if (!p) throw notFound('That purchase');
  const lines = db().prepare('SELECT l.*, i.name AS item_name, i.unit AS item_unit FROM purchase_lines l LEFT JOIN stock_items i ON i.id = l.item_id WHERE l.purchase_id = ? ORDER BY l.sort_order').all(pid);
  return { ...p, lines };
}

export function listPurchases(opts: { from?: string | null; to?: string | null; supplier_id?: string | null; limit?: number } = {}) {
  const rows = db()
    .prepare(
      `SELECT p.*, s.name AS supplier_name,
        (SELECT group_concat(description, ', ') FROM (SELECT description FROM purchase_lines WHERE purchase_id = p.id ORDER BY sort_order)) AS summary,
        (SELECT COUNT(*) FROM purchase_lines WHERE purchase_id = p.id) AS line_count
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE (? IS NULL OR p.ordered_on >= ?) AND (? IS NULL OR p.ordered_on <= ?) AND (? IS NULL OR p.supplier_id = ?)
       ORDER BY p.ordered_on DESC, p.created_at DESC LIMIT ?`,
    )
    .all(opts.from ?? null, opts.from ?? null, opts.to ?? null, opts.to ?? null, opts.supplier_id ?? null, opts.supplier_id ?? null, opts.limit ?? 200);
  return rows;
}

function writeLines(pid: string, lines: PurchaseLineInput[]): number {
  db().prepare('DELETE FROM purchase_lines WHERE purchase_id = ?').run(pid);
  const ins = db().prepare('INSERT INTO purchase_lines (id, purchase_id, item_id, description, category, qty, weight_kg, cost_per, unit_cost_cents, total_cents, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  let sum = 0;
  lines.forEach((l, i) => {
    const it = l.item_id ? requireItem(l.item_id) : null;
    const description = l.description?.trim() || it?.name;
    if (!description) throw badRequest('Each line needs a stock item or a description.');
    if (!(l.qty > 0)) throw badRequest(`Enter how much for “${description}”.`);
    if (l.unit_cost_cents < 0) throw badRequest('Costs can’t be negative.');
    const { weight, total } = lineTotal(l, it);
    sum += total;
    ins.run(id('pl_'), pid, it?.id ?? null, description, l.category?.trim() || categoryFor(it), r3(l.qty), weight != null ? r3(weight) : null, l.cost_per ?? 'unit', Math.round(l.unit_cost_cents), total, i);
  });
  return sum;
}

export function createPurchase(input: PurchaseInput, actor: Actor) {
  if (!input.lines.length) throw badRequest('Add at least one line.');
  if (input.supplier_id) requireSupplier(input.supplier_id);
  const pid = id('pu_');
  const ts = now();
  tx(() => {
    db()
      .prepare("INSERT INTO purchases (id, supplier_id, status, ordered_on, reference, notes, total_cents, created_by, created_at, updated_at) VALUES (?,?,'ordered',?,?,?,0,?,?,?)")
      .run(pid, input.supplier_id ?? null, input.ordered_on, clean(input.reference), clean(input.notes), actor.userId, ts, ts);
    const total = writeLines(pid, input.lines);
    db().prepare('UPDATE purchases SET total_cents = ? WHERE id = ?').run(total, pid);
    audit(actor, 'purchase.created', 'purchase', pid, `Recorded a purchase of ${money(total)}${input.supplier_id ? ` from ${requireSupplier(input.supplier_id).name}` : ''}`, input);
    if (input.received) receivePurchase(pid, input.ordered_on, actor, true);
  });
  publish(['stock']);
  return getPurchase(pid);
}

export function updatePurchase(pid: string, input: Partial<PurchaseInput>, actor: Actor) {
  const p = getPurchase(pid);
  if (input.supplier_id) requireSupplier(input.supplier_id);
  if (p.status === 'received' && input.lines) throw conflict('This order has already been received into stock. Record a correction on the stock item instead, or delete the purchase and enter it again.');
  tx(() => {
    const f: Record<string, unknown> = {};
    if (input.supplier_id !== undefined) f.supplier_id = input.supplier_id || null;
    if (input.ordered_on) f.ordered_on = input.ordered_on;
    if (input.reference !== undefined) f.reference = clean(input.reference);
    if (input.notes !== undefined) f.notes = clean(input.notes);
    if (input.lines) {
      if (!input.lines.length) throw badRequest('Add at least one line.');
      f.total_cents = writeLines(pid, input.lines);
    }
    if (Object.keys(f).length) db().prepare(`UPDATE purchases SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(f), now(), pid);
    audit(actor, 'purchase.updated', 'purchase', pid, `Updated a purchase${p.supplier_name ? ` from ${p.supplier_name}` : ''}`, input);
  });
  publish(['stock']);
  return getPurchase(pid);
}

/** Books a stock order into stock: adds each stocked line to what's on hand and updates the latest cost. */
export function receivePurchase(pid: string, on: string | null, actor: Actor, nested = false) {
  const p = getPurchase(pid);
  if (p.status === 'received') throw conflict('This order is already received.');
  if (p.status === 'cancelled') throw conflict('This order was cancelled.');
  const run = () => {
    for (const l of p.lines as any[]) {
      if (!l.item_id) continue;
      moveStock(l.item_id, 'received', l.qty, `From ${p.supplier_name ?? 'purchase'}${p.reference ? ` (${p.reference})` : ''}`, actor, { purchaseId: pid, silent: true });
      const it = requireItem(l.item_id);
      const perUnit = l.qty > 0 ? Math.round(l.total_cents / l.qty) : null;
      const avg = it.unit !== 'kg' && l.weight_kg && l.qty ? r3(l.weight_kg / l.qty) : it.avg_weight_kg;
      db().prepare('UPDATE stock_items SET cost_cents = COALESCE(?, cost_cents), avg_weight_kg = ?, supplier_id = COALESCE(supplier_id, ?), updated_at = ? WHERE id = ?').run(perUnit, avg, p.supplier_id, now(), l.item_id);
    }
    db().prepare("UPDATE purchases SET status = 'received', received_on = ?, updated_at = ? WHERE id = ?").run(on ?? today(), now(), pid);
    audit(actor, 'purchase.received', 'purchase', pid, `Received into stock: ${(p.lines as any[]).filter((l) => l.item_id).map((l) => `${l.qty} ${l.item_unit ?? ''} ${l.item_name}`.replace(/\s+/g, ' ')).join(', ') || 'no stocked lines'}`, {});
  };
  if (nested) run();
  else {
    tx(run);
    publish(['stock']);
  }
  return getPurchase(pid);
}

export function cancelPurchase(pid: string, actor: Actor) {
  const p = getPurchase(pid);
  if (p.status === 'received') throw conflict('This order is already in stock. Delete it instead if it was entered by mistake.');
  db().prepare("UPDATE purchases SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), pid);
  audit(actor, 'purchase.cancelled', 'purchase', pid, `Cancelled a purchase${p.supplier_name ? ` from ${p.supplier_name}` : ''}`, {});
  publish(['stock']);
  return getPurchase(pid);
}

/** Removes a purchase. If it was received, the stock it added is taken off again. */
export function deletePurchase(pid: string, actor: Actor) {
  const p = getPurchase(pid);
  tx(() => {
    if (p.status === 'received') for (const l of p.lines as any[]) if (l.item_id) moveStock(l.item_id, 'adjust', -l.qty, 'Purchase deleted', actor, { purchaseId: pid, silent: true });
    db().prepare('DELETE FROM purchases WHERE id = ?').run(pid);
    audit(actor, 'purchase.deleted', 'purchase', pid, `Deleted a purchase of ${money(p.total_cents)}${p.supplier_name ? ` from ${p.supplier_name}` : ''} (${p.ordered_on})`, p);
  });
  publish(['stock']);
}

// ── Overview & spending ────────────────────────────────────
function today() {
  return localDate(new Date(), businessTz());
}
function money(c: number) {
  return `R${(c / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function stockOverview() {
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const lastMonthStart = d.toISOString().slice(0, 10);
  const spend = (from: string, to: string) =>
    (db().prepare("SELECT COALESCE(SUM(total_cents),0) s FROM purchases WHERE status != 'cancelled' AND ordered_on >= ? AND ordered_on <= ?").get(from, to) as any).s as number;
  const yearAgo = addDays(t, -365);
  const byCategory = db()
    .prepare(`SELECT l.category, SUM(l.total_cents) total FROM purchase_lines l JOIN purchases p ON p.id = l.purchase_id WHERE p.status != 'cancelled' AND p.ordered_on >= ? GROUP BY l.category ORDER BY total DESC`)
    .all(addDays(t, -90));
  const bySupplier = db()
    .prepare(`SELECT COALESCE(s.name, 'No supplier') name, SUM(p.total_cents) total, COUNT(*) n FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.status != 'cancelled' AND p.ordered_on >= ? GROUP BY p.supplier_id ORDER BY total DESC LIMIT 8`)
    .all(addDays(t, -90));
  const monthly = db()
    .prepare(`SELECT substr(ordered_on,1,7) month, SUM(total_cents) total FROM purchases WHERE status != 'cancelled' AND ordered_on >= ? GROUP BY month ORDER BY month`)
    .all(yearAgo);
  const items = listItems().filter((i) => i.active);
  return {
    today: t,
    spend: { this_month_cents: spend(monthStart, t), last_month_cents: spend(lastMonthStart, addDays(monthStart, -1)), last_90_cents: spend(addDays(t, -90), t) },
    by_category_90d: byCategory,
    by_supplier_90d: bySupplier,
    monthly,
    stock_value_cents: items.reduce((s, i) => s + (i.value_cents ?? 0), 0),
    low: items.filter((i) => i.low).map((i) => ({ id: i.id, name: i.name, on_hand: i.on_hand, unit: i.unit, reorder_level: i.reorder_level })),
    awaiting: listPurchases({ limit: 50 }).filter((p: any) => p.status === 'ordered'),
    item_count: items.length,
    last_count_at: (db().prepare("SELECT MAX(created_at) at FROM stock_movements WHERE kind = 'count'").get() as any).at as string | null,
  };
}

// ── Planner: open orders → what to cut and what to order ───
const OPEN_FOR_PLANNING = ['review', 'needs_clarification', 'confirmed', 'cutting', 'on_hold'];

export function planRange(range: string | undefined, fromQ?: string | null, toQ?: string | null): { from: string | null; to: string | null; label: string } {
  const t = today();
  if (fromQ && toQ) return { from: fromQ, to: toQ, label: 'Chosen dates' };
  if (range === 'all') return { from: null, to: null, label: 'All open orders' };
  if (range === 'fortnight') return { from: addDays(t, -30), to: addDays(t, 13), label: 'Next 14 days' };
  if (range === 'month') return { from: addDays(t, -30), to: addDays(t, 29), label: 'Next 30 days' };
  return { from: addDays(t, -30), to: addDays(t, 6), label: 'Next 7 days' };
}

export function planStock(opts: { from: string | null; to: string | null }) {
  const products = new Map(listProducts().map((p) => [p.id, p]));
  // 1. What the open orders need, per product, in kg (not yet cut)
  const rows = db()
    .prepare(
      `SELECT i.product_id, i.qty_kind, i.count, i.weight_g, o.id AS order_id FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE i.status = 'active' AND i.cut_at IS NULL AND o.status IN (${OPEN_FOR_PLANNING.map(() => '?').join(',')})
         AND (? IS NULL OR o.requested_date IS NULL OR o.requested_date >= ?) AND (? IS NULL OR o.requested_date IS NULL OR o.requested_date <= ?)`,
    )
    .all(...OPEN_FOR_PLANNING, opts.from, opts.from, opts.to, opts.to) as { product_id: string; qty_kind: Qty['kind']; count: number | null; weight_g: number | null; order_id: string }[];
  const need = new Map<string, { kg: number; unknown: number; orders: Set<string> }>();
  for (const r of rows) {
    const p = products.get(r.product_id);
    if (!p) continue;
    const q = { kind: r.qty_kind, count: r.count, weight_g: r.weight_g } as Qty;
    let g = totalGrams(q);
    if (g == null && r.count != null && p.typical_piece_g) g = r.count * p.typical_piece_g;
    const e = need.get(p.id) ?? { kg: 0, unknown: 0, orders: new Set<string>() };
    if (g == null) e.unknown += r.count ?? 1;
    else e.kg += g / 1000;
    e.orders.add(r.order_id);
    need.set(p.id, e);
  }
  const orderCount = new Set(rows.map((r) => r.order_id)).size;

  const items = (db().prepare('SELECT * FROM stock_items WHERE active = 1').all() as StockItem[]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const yields = db().prepare('SELECT y.item_id, y.product_id, y.pct, y.part FROM stock_yields y JOIN stock_items i ON i.id = y.item_id WHERE i.active = 1').all() as { item_id: string; product_id: string; pct: number; part: string | null }[];

  // 2. Finished stock already on hand (e.g. frozen rump) covers what it can
  const onHand = new Map(items.map((i) => [i.id, i.on_hand]));
  const fromStock: { product_id: string; item_id: string; kg: number }[] = [];
  const remaining = new Map<string, number>();
  for (const [pid, e] of need) {
    let left = e.kg;
    for (const it of items.filter((i) => i.product_id === pid)) {
      const per = kgPerUnit(it);
      if (!per || left <= 0) continue;
      const availKg = (onHand.get(it.id) ?? 0) * per;
      const use = Math.min(left, availKg);
      if (use > 0) {
        onHand.set(it.id, r3((onHand.get(it.id) ?? 0) - use / per));
        fromStock.push({ product_id: pid, item_id: it.id, kg: r3(use) });
        left -= use;
      }
    }
    remaining.set(pid, r3(Math.max(0, left)));
  }

  // 3. Each product still needed comes from the source that gives the most of it per unit
  type Assigned = { product_id: string; need_kg: number; per_unit_kg: number; direct: boolean; part: string | null };
  const bySource = new Map<string, Assigned[]>();
  const uncovered: { product_id: string; need_kg: number; reason: 'no_source' | 'no_weight' }[] = [];
  for (const [pid, kg] of remaining) {
    if (kg <= 0) continue;
    const cands: { item: StockItem; perUnit: number; direct: boolean; part: string | null }[] = [];
    let missingWeight = false;
    for (const y of yields.filter((y) => y.product_id === pid)) {
      const it = itemById.get(y.item_id)!;
      const per = kgPerUnit(it);
      if (!per) missingWeight = true;
      else cands.push({ item: it, perUnit: (per * y.pct) / 100, direct: false, part: y.part });
    }
    for (const it of items.filter((i) => i.product_id === pid)) {
      const per = kgPerUnit(it);
      if (!per) missingWeight = true;
      else cands.push({ item: it, perUnit: per, direct: true, part: null });
    }
    if (!cands.length) {
      uncovered.push({ product_id: pid, need_kg: kg, reason: missingWeight ? 'no_weight' : 'no_source' });
      continue;
    }
    const best = cands.sort((a, b) => b.perUnit - a.perUnit)[0];
    const list = bySource.get(best.item.id) ?? [];
    list.push({ product_id: pid, need_kg: kg, per_unit_kg: best.perUnit, direct: best.direct, part: best.part });
    bySource.set(best.item.id, list);
  }

  // 4. Per source: how many units to cut, what's on hand, what to order, and what else it gives
  const sources = [...bySource.entries()].map(([iid, list]) => {
    const it = itemById.get(iid)!;
    const whole = it.unit !== 'kg';
    const direct = list.filter((a) => a.direct).reduce((s, a) => s + a.need_kg / a.per_unit_kg, 0);
    const cutList = list.filter((a) => !a.direct);
    // Cuts of the same part share it: the rib's weight covers rib-eye and tomahawk together
    const ys = yields.filter((y) => y.item_id === iid);
    const keyOf = (pid: string, part: string | null) => (part ? `part:${normalise(part)}` : pid);
    const groups = new Map<string, { key: string; label: string; part: string | null; pct: number; per_unit_kg: number; need_kg: number; members: string[]; needed: string[] }>();
    for (const y of ys) {
      const key = keyOf(y.product_id, y.part);
      const g = groups.get(key) ?? { key, label: y.part ?? products.get(y.product_id)?.canonical_name ?? '?', part: y.part, pct: y.pct, per_unit_kg: ((kgPerUnit(it) ?? 0) * y.pct) / 100, need_kg: 0, members: [], needed: [] };
      g.members.push(products.get(y.product_id)?.canonical_name ?? '?');
      const a = cutList.find((x) => x.product_id === y.product_id);
      if (a) {
        g.need_kg += a.need_kg;
        g.needed.push(products.get(y.product_id)?.canonical_name ?? '?');
      }
      groups.set(key, g);
    }
    const driver = [...groups.values()].filter((g) => g.need_kg > 0 && g.per_unit_kg > 0).reduce<null | { key: string; label: string; part: string | null; pct: number; per_unit_kg: number; need_kg: number; members: string[]; needed: string[] }>((m, g) => (!m || g.need_kg / g.per_unit_kg > m.need_kg / m.per_unit_kg ? g : m), null);
    const forCutsRaw = driver ? driver.need_kg / driver.per_unit_kg : 0;
    const forCuts = whole ? Math.ceil(forCutsRaw - 1e-9) : r3(forCutsRaw);
    const total = whole ? Math.ceil(direct - 1e-9) + forCuts : r3(direct + forCuts);
    const have = Math.max(0, onHand.get(iid) ?? 0);
    const toOrder = whole ? Math.max(0, Math.ceil(total - have - 1e-9)) : r3(Math.max(0, total - have));
    const per = kgPerUnit(it)!;
    const outputs = [...groups.values()]
      .map((g) => {
        const produced = r3(forCuts * per * (g.pct / 100));
        return { key: g.key, product_name: g.label, part: g.part, members: g.part ? g.members : [], pct: g.pct, yield_kg: produced, need_kg: r3(g.need_kg), extra_kg: r3(produced - g.need_kg) };
      })
      .sort((a, b) => b.need_kg - a.need_kg || b.yield_kg - a.yield_kg);
    return {
      item_id: iid,
      name: it.name,
      unit: it.unit,
      kind: it.kind,
      avg_weight_kg: it.avg_weight_kg,
      supplier_id: it.supplier_id,
      units_needed: total,
      for_cuts: forCuts,
      direct_units: r3(direct),
      on_hand: r3(have),
      to_order: toOrder,
      est_cost_cents: it.cost_cents != null ? Math.round(toOrder * it.cost_cents) : null,
      driven_by: driver ? { product_name: driver.part ? `${driver.part} (${driver.needed.join(', ')})` : driver.label, need_kg: r3(driver.need_kg) } : null,
      direct_products: list.filter((a) => a.direct).map((a) => ({ product_id: a.product_id, product_name: products.get(a.product_id)?.canonical_name ?? '?', need_kg: r3(a.need_kg) })),
      outputs,
    };
  });

  const demand = [...need.entries()]
    .map(([pid, e]) => {
      const p = products.get(pid)!;
      return { product_id: pid, product_name: p.canonical_name, category: p.category, need_kg: r3(e.kg), unknown_pieces: e.unknown, orders: e.orders.size, from_stock_kg: r3(fromStock.filter((f) => f.product_id === pid).reduce((s, f) => s + f.kg, 0)), still_needed_kg: remaining.get(pid) ?? 0 };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || b.need_kg - a.need_kg);

  return {
    from: opts.from,
    to: opts.to,
    order_count: orderCount,
    demand,
    sources: sources.sort((a, b) => b.to_order - a.to_order || a.name.localeCompare(b.name)),
    uncovered: uncovered.map((u) => ({ ...u, product_name: products.get(u.product_id)?.canonical_name ?? '?' })),
    from_stock: fromStock.map((f) => ({ ...f, item_name: itemById.get(f.item_id)?.name ?? '?', product_name: products.get(f.product_id)?.canonical_name ?? '?' })),
    est_total_cents: sources.reduce((s, x) => s + (x.est_cost_cents ?? 0), 0),
    missing_costs: sources.some((x) => x.to_order > 0 && x.est_cost_cents == null),
  };
}

// ── Starter items ──────────────────────────────────────────
/**
 * The first time the stock section opens, it starts with the usual pieces a farm butchery buys
 * (nothing on hand, no costs), each with starting-point yields, so the planner works from day one.
 * The family edits or deletes these freely; they're only added once.
 */
export function seedStockOnce() {
  if (getSettings().stock.seeded) return;
  const hasAny = (db().prepare('SELECT COUNT(*) n FROM stock_items').get() as any).n > 0;
  if (!hasAny && listProducts().length) {
    const actor: Actor = { userId: null, kind: 'system', name: 'Terram OS' };
    const starters: StockItemInput[] = [
      { name: 'Beef hindquarter', kind: 'carcass', unit: 'each', avg_weight_kg: 85, notes: 'Weights and yields are starting estimates. Update them after weighing your own.' },
      { name: 'Beef forequarter', kind: 'carcass', unit: 'each', avg_weight_kg: 95, notes: 'Weights and yields are starting estimates. Update them after weighing your own.' },
      { name: 'Whole lamb carcass', kind: 'carcass', unit: 'each', avg_weight_kg: 18, notes: 'Weights and yields are starting estimates. Update them after weighing your own.' },
      { name: 'Boerewors spice', kind: 'ingredient', unit: 'kg' },
      { name: 'Biltong spice', kind: 'ingredient', unit: 'kg' },
      { name: 'Sausage casings', kind: 'ingredient', unit: 'pack' },
      { name: 'Vacuum bags', kind: 'packaging', unit: 'pack' },
    ];
    const lambWhole = listProducts().find((p) => p.slug === 'lamb_whole');
    for (const st of starters) {
      const it = saveItem(null, { ...st, product_id: (st.name ?? '').startsWith('Whole lamb') && lambWhole ? lambWhole.id : null }, actor);
      const t = yieldTemplate(it.id);
      if (t && it.kind === 'carcass') setYields(it.id, t.rows, actor);
    }
  }
  updateSettings('stock', { seeded: true }, null);
}

import { db } from '../db/db.js';
import { formatQty, formatWeight, pluralise, type Qty } from '../../shared/quantity.js';
import { CATEGORY_ORDER, listProducts } from './products.js';
import { getItems, type OrderSummary, getOrderSummary } from './orders.js';

/**
 * Production Planner. Aggregates confirmed orders into "what does the
 * blockman need to cut?" while keeping "who needs what?" one tap away.
 * Lines only merge when product, preparation and portion size all match.
 */
export interface CutLine {
  key: string;
  product_id: string;
  product_name: string;
  category: string;
  preparation_label: string;
  qty_kind: Qty['kind'];
  portion_g: number | null;
  total_count: number;
  total_weight_g: number;
  total_label: string;
  estimate_label: string | null;
  cut_items: number;
  total_items: number;
  orders: {
    item_id: string;
    order_id: string;
    order_number: number;
    customer_name: string;
    requested_date: string | null;
    qty_label: string;
    special_instructions: string | null;
    cut: boolean;
  }[];
}

export function cuttingSheet(opts: { from?: string | null; to?: string | null; includeUndated?: boolean }) {
  const where: string[] = ["o.status IN ('confirmed','cutting','cut')", "i.status = 'active'"];
  const vals: unknown[] = [];
  const dateConds: string[] = [];
  if (opts.from && opts.to) {
    dateConds.push('(o.requested_date BETWEEN ? AND ?)');
    vals.push(opts.from, opts.to);
    if (opts.includeUndated !== false) dateConds.push('o.requested_date IS NULL');
    where.push(`(${dateConds.join(' OR ')})`);
  }
  const rows = db()
    .prepare(
      `SELECT i.id AS item_id, i.product_id, i.qty_kind, i.count, i.weight_g, i.preparation_label, i.special_instructions, i.cut_at,
              o.id AS order_id, o.order_number, o.requested_date, c.name AS customer_name,
              p.canonical_name, p.category, p.piece_noun, p.typical_piece_g, p.sort_order
       FROM order_items i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = o.customer_id JOIN products p ON p.id = i.product_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.sort_order, o.requested_date, o.order_number`,
    )
    .all(...vals) as any[];
  const lines = new Map<string, CutLine & { piece_noun: string; typical_piece_g: number | null; sort: number }>();
  for (const r of rows) {
    const portion = r.qty_kind === 'portions' ? r.weight_g : null;
    const key = `${r.product_id}|${r.preparation_label}|${r.qty_kind === 'weight' ? 'w' : r.qty_kind === 'count' ? 'c' : 'p' + portion}`;
    let line = lines.get(key);
    if (!line) {
      line = {
        key,
        product_id: r.product_id,
        product_name: r.canonical_name,
        category: r.category,
        preparation_label: r.preparation_label,
        qty_kind: r.qty_kind,
        portion_g: portion,
        total_count: 0,
        total_weight_g: 0,
        total_label: '',
        estimate_label: null,
        cut_items: 0,
        total_items: 0,
        orders: [],
        piece_noun: r.piece_noun,
        typical_piece_g: r.typical_piece_g,
        sort: r.sort_order,
      };
      lines.set(key, line);
    }
    const qty: Qty = { kind: r.qty_kind, count: r.count, weight_g: r.weight_g };
    if (r.qty_kind === 'weight') line.total_weight_g += r.weight_g;
    else {
      line.total_count += r.count;
      if (r.qty_kind === 'portions') line.total_weight_g += r.count * r.weight_g;
    }
    line.total_items++;
    if (r.cut_at) line.cut_items++;
    line.orders.push({
      item_id: r.item_id,
      order_id: r.order_id,
      order_number: r.order_number,
      customer_name: r.customer_name,
      requested_date: r.requested_date,
      qty_label: formatQty(qty, r.piece_noun),
      special_instructions: r.special_instructions,
      cut: !!r.cut_at,
    });
  }
  const out: CutLine[] = [...lines.values()].map((l) => {
    if (l.qty_kind === 'weight') l.total_label = formatWeight(l.total_weight_g);
    else if (l.qty_kind === 'portions') l.total_label = `${l.total_count} × ${formatWeight(l.portion_g!)}`;
    else l.total_label = `${l.total_count} ${l.total_count === 1 ? l.piece_noun : pluralise(l.piece_noun)}`;
    if (l.qty_kind === 'count' && l.typical_piece_g) l.estimate_label = `≈ ${formatWeight(Math.round((l.total_count * l.typical_piece_g) / 100) * 100)}`;
    if (l.qty_kind === 'portions') l.estimate_label = `${formatWeight(l.total_weight_g)} total`;
    const { piece_noun, typical_piece_g, sort, ...rest } = l;
    return rest;
  });
  const catIndex = (c: string) => (CATEGORY_ORDER.indexOf(c) === -1 ? 99 : CATEGORY_ORDER.indexOf(c));
  const sortMap = new Map(listProducts().map((p) => [p.id, p.sort_order]));
  out.sort((a, b) => catIndex(a.category) - catIndex(b.category) || (sortMap.get(a.product_id) ?? 0) - (sortMap.get(b.product_id) ?? 0) || a.preparation_label.localeCompare(b.preparation_label));
  const orderIds = new Set(rows.map((r) => r.order_id));
  return {
    lines: out,
    order_count: orderIds.size,
    total_items: rows.length,
    cut_items: rows.filter((r) => r.cut_at).length,
    undated_orders: new Set(rows.filter((r) => !r.requested_date).map((r) => r.order_id)).size,
  };
}

export interface PackOrder extends OrderSummary {
  items: ReturnType<typeof getItems>;
}

export function packingQueue(): { ready_to_pack: PackOrder[]; still_cutting: OrderSummary[] } {
  const ids = db()
    .prepare(
      `SELECT id FROM orders WHERE status IN ('cut','packing')
       ORDER BY CASE WHEN requested_date IS NULL THEN 1 ELSE 0 END, requested_date, time_window, order_number`,
    )
    .all() as { id: string }[];
  const cutting = db()
    .prepare("SELECT id FROM orders WHERE status IN ('cutting') ORDER BY requested_date, order_number")
    .all() as { id: string }[];
  return {
    ready_to_pack: ids.map((r) => ({ ...getOrderSummary(r.id)!, items: getItems(r.id) })),
    still_cutting: cutting.map((r) => getOrderSummary(r.id)!),
  };
}

export function fulfilmentBoard(date: string) {
  const ready = db()
    .prepare(
      `SELECT id FROM orders WHERE status IN ('ready','out_for_delivery','packed')
       ORDER BY CASE WHEN requested_date IS NULL THEN 1 ELSE 0 END, requested_date, time_window, order_number`,
    )
    .all() as { id: string }[];
  const upcoming = db()
    .prepare(
      `SELECT id FROM orders WHERE requested_date = ? AND status NOT IN ('ready','out_for_delivery','packed','completed','cancelled')
       ORDER BY time_window, order_number`,
    )
    .all(date) as { id: string }[];
  const completed = db()
    .prepare("SELECT id FROM orders WHERE status = 'completed' AND substr(completed_at, 1, 10) >= ? ORDER BY completed_at DESC LIMIT 50")
    .all(date) as { id: string }[];
  const map = (rows: { id: string }[]) => rows.map((r) => ({ ...getOrderSummary(r.id)!, items: getItems(r.id) }));
  return { ready: map(ready), not_ready_today: map(upcoming), completed_today: map(completed) };
}

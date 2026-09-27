import { db } from '../db/db.js';
import { formatQty, formatWeight, pluralise } from '../../shared/quantity.js';
import { isValidYmd } from '../lib/time.js';
import { badRequest } from '../lib/errors.js';

/** Operational reports — no vanity analytics. */
export function report(from: string, to: string) {
  const range = [from, to];
  const byDay = db()
    .prepare(
      `SELECT requested_date AS date, COUNT(*) orders, SUM(status = 'completed') completed, SUM(status = 'cancelled') cancelled
       FROM orders WHERE requested_date BETWEEN ? AND ? GROUP BY requested_date ORDER BY requested_date`,
    )
    .all(...range);
  const received = db()
    .prepare(`SELECT substr(created_at,1,10) AS date, COUNT(*) n FROM orders WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`)
    .all(...range);
  const byStatus = db().prepare(`SELECT status, COUNT(*) n FROM orders WHERE requested_date BETWEEN ? AND ? OR (requested_date IS NULL AND substr(created_at,1,10) BETWEEN ? AND ?) GROUP BY status`).all(from, to, from, to);
  const bySource = db().prepare(`SELECT source, COUNT(*) n FROM orders WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY source ORDER BY n DESC`).all(...range);
  const products = (
    db()
      .prepare(
        `SELECT p.id, p.canonical_name AS name, p.category, p.piece_noun,
           SUM(CASE WHEN i.qty_kind = 'weight' THEN i.weight_g WHEN i.qty_kind = 'portions' THEN i.count * i.weight_g ELSE 0 END) AS grams,
           SUM(CASE WHEN i.qty_kind = 'count' THEN i.count ELSE 0 END) AS pieces,
           COUNT(DISTINCT o.id) AS orders
         FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
         WHERE i.status = 'active' AND o.status != 'cancelled' AND o.requested_date BETWEEN ? AND ?
         GROUP BY p.id ORDER BY orders DESC, grams DESC`,
      )
      .all(...range) as any[]
  ).map((p) => ({
    ...p,
    total_label: [p.grams ? formatWeight(p.grams) : null, p.pieces ? `${p.pieces} ${p.pieces === 1 ? p.piece_noun : pluralise(p.piece_noun)}` : null].filter(Boolean).join(' + '),
  }));
  const customers = db()
    .prepare(
      `SELECT c.id, c.name, COUNT(o.id) orders, MAX(o.created_at) last_order FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status != 'cancelled' AND substr(o.created_at,1,10) BETWEEN ? AND ? GROUP BY c.id ORDER BY orders DESC LIMIT 15`,
    )
    .all(...range);
  const exceptions = db().prepare(`SELECT type, COUNT(*) n, SUM(status = 'open') open FROM exceptions WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY type ORDER BY n DESC`).all(...range);
  const amendments = db()
    .prepare(`SELECT COUNT(*) n, COUNT(DISTINCT order_id) orders FROM order_events WHERE type IN ('item_amended','item_added','item_removed','amendment_applied') AND substr(created_at,1,10) BETWEEN ? AND ?`)
    .get(...range);
  const fulfilment = db()
    .prepare(`SELECT COALESCE(fulfilment_type, 'unspecified') type, COUNT(*) n FROM orders WHERE status != 'cancelled' AND requested_date BETWEEN ? AND ? GROUP BY 1`)
    .all(...range);
  const outstanding = db()
    .prepare(
      `SELECT o.id, o.order_number, o.status, o.requested_date, c.name customer_name FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status NOT IN ('completed','cancelled') ORDER BY CASE WHEN o.requested_date IS NULL THEN 1 ELSE 0 END, o.requested_date LIMIT 100`,
    )
    .all();
  return { from, to, by_day: byDay, received, by_status: byStatus, by_source: bySource, products, customers, exceptions, amendments, fulfilment, outstanding };
}

function csvCell(v: unknown): string {
  if (v == null) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return (columns ?? []).join(',') + '\n';
  const cols = columns ?? Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

export function exportDataset(kind: string, from?: string, to?: string): { filename: string; csv: string } {
  // Dates are validated to strict YYYY-MM-DD before use, so they can never carry SQL.
  if ((from && !isValidYmd(from)) || (to && !isValidYmd(to))) throw badRequest('Invalid date range.');
  const dateFilter = from && to ? `AND COALESCE(o.requested_date, substr(o.created_at,1,10)) BETWEEN '${from}' AND '${to}'` : '';
  switch (kind) {
    case 'orders':
      return {
        filename: 'terram-orders.csv',
        csv: toCsv(
          db()
            .prepare(
              `SELECT o.order_number, o.status, o.source, c.name AS customer, c.phone, o.fulfilment_type, o.requested_date, o.time_window, o.delivery_address,
                o.payment_status, o.accounting_ref, o.notes, o.created_at, o.confirmed_at, o.completed_at
               FROM orders o JOIN customers c ON c.id = o.customer_id WHERE 1=1 ${dateFilter} ORDER BY o.order_number`,
            )
            .all() as any[],
        ),
      };
    case 'items':
      return {
        filename: 'terram-order-items.csv',
        csv: toCsv(
          (
            db()
              .prepare(
                `SELECT o.order_number, c.name AS customer, o.requested_date, o.status AS order_status, p.canonical_name AS product, i.qty_kind, i.count, i.weight_g,
                  i.preparation_label, i.special_instructions, i.status, i.cut_at, i.packed_at, i.packed_weight_g
                 FROM order_items i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = o.customer_id JOIN products p ON p.id = i.product_id
                 WHERE 1=1 ${dateFilter} ORDER BY o.order_number, i.sort_order`,
              )
              .all() as any[]
          ).map((r) => ({ ...r, quantity: formatQty({ kind: r.qty_kind, count: r.count, weight_g: r.weight_g }) })),
          ['order_number', 'customer', 'requested_date', 'order_status', 'product', 'quantity', 'qty_kind', 'count', 'weight_g', 'preparation_label', 'special_instructions', 'status', 'cut_at', 'packed_at', 'packed_weight_g'],
        ),
      };
    case 'customers':
      return { filename: 'terram-customers.csv', csv: toCsv(db().prepare('SELECT name, phone, email, address, preferred_fulfilment, notes, archived, created_at FROM customers ORDER BY name').all() as any[]) };
    case 'products':
      return {
        filename: 'terram-products.csv',
        csv: toCsv(
          db()
            .prepare(
              `SELECT p.slug, p.canonical_name, p.customer_name, p.category, p.quantity_type, p.allows_portions, p.price_cents, p.price_unit, p.active, p.customer_visible,
                (SELECT GROUP_CONCAT(alias, '; ') FROM product_aliases a WHERE a.product_id = p.id) AS aliases
               FROM products p ORDER BY p.sort_order`,
            )
            .all() as any[],
        ),
      };
    case 'messages':
      return { filename: 'terram-messages.csv', csv: toCsv(db().prepare('SELECT channel, direction, sender_name, sender_phone, body, sent_at, received_at, classification, status FROM messages ORDER BY received_at').all() as any[]) };
    case 'audit':
      return { filename: 'terram-audit-log.csv', csv: toCsv(db().prepare('SELECT a.created_at, u.name AS user, a.actor_kind, a.action, a.entity_type, a.entity_id, a.summary FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.created_at').all() as any[]) };
    default:
      throw new Error('Unknown export');
  }
}

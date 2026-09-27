import { db, json } from '../db/db.js';
import { addDays, localDate } from '../lib/time.js';
import { businessTz } from '../services/settings.js';
import { openExceptionCount } from './exceptions.js';
import { getOrderSummary } from './orders.js';

/** "What needs attention today?" — answered in one query batch. */
export function dashboard() {
  const today = localDate(new Date(), businessTz());
  const count = (sql: string, ...args: unknown[]) => ((db().prepare(sql).get(...args) as any)?.n ?? 0) as number;
  const open = "status NOT IN ('completed','cancelled')";
  const counts = {
    to_review: count("SELECT COUNT(*) n FROM orders WHERE status IN ('review','needs_clarification')"),
    needs_clarification: count("SELECT COUNT(*) n FROM orders WHERE status = 'needs_clarification'"),
    to_cut: count("SELECT COUNT(*) n FROM orders WHERE status = 'confirmed'"),
    cutting: count("SELECT COUNT(*) n FROM orders WHERE status = 'cutting'"),
    to_pack: count("SELECT COUNT(*) n FROM orders WHERE status IN ('cut','packing')"),
    ready: count("SELECT COUNT(*) n FROM orders WHERE status IN ('packed','ready')"),
    out_for_delivery: count("SELECT COUNT(*) n FROM orders WHERE status = 'out_for_delivery'"),
    on_hold: count("SELECT COUNT(*) n FROM orders WHERE status = 'on_hold'"),
    due_today: count(`SELECT COUNT(*) n FROM orders WHERE requested_date = ? AND ${open}`, today),
    overdue: count(`SELECT COUNT(*) n FROM orders WHERE requested_date < ? AND ${open} AND status != 'on_hold'`, today),
    collections_today: count(`SELECT COUNT(*) n FROM orders WHERE requested_date = ? AND fulfilment_type = 'collection' AND ${open}`, today),
    deliveries_today: count(`SELECT COUNT(*) n FROM orders WHERE requested_date = ? AND fulfilment_type = 'delivery' AND ${open}`, today),
    completed_today: count("SELECT COUNT(*) n FROM orders WHERE status = 'completed' AND completed_at >= ?", `${today}T00:00:00`),
    received_today: count('SELECT COUNT(*) n FROM orders WHERE created_at >= ?', `${today}T00:00:00`),
    open_total: count(`SELECT COUNT(*) n FROM orders WHERE ${open}`),
  };
  const exceptions = openExceptionCount();
  const ids = (sql: string, ...args: unknown[]) => (db().prepare(sql).all(...args) as { id: string }[]).map((r) => getOrderSummary(r.id)!);
  const dueToday = ids(`SELECT id FROM orders WHERE requested_date = ? AND ${open} ORDER BY fulfilment_type, time_window, order_number LIMIT 40`, today);
  const overdue = ids(`SELECT id FROM orders WHERE requested_date < ? AND ${open} AND status != 'on_hold' ORDER BY requested_date LIMIT 20`, today);
  const toReview = ids("SELECT id FROM orders WHERE status IN ('review','needs_clarification') ORDER BY created_at LIMIT 10");
  const week: { date: string; orders: number; collections: number; deliveries: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    const r = db()
      .prepare(`SELECT COUNT(*) n, SUM(fulfilment_type = 'collection') c, SUM(fulfilment_type = 'delivery') dl FROM orders WHERE requested_date = ? AND status != 'cancelled'`)
      .get(d) as any;
    week.push({ date: d, orders: r.n ?? 0, collections: r.c ?? 0, deliveries: r.dl ?? 0 });
  }
  const undated = count(`SELECT COUNT(*) n FROM orders WHERE requested_date IS NULL AND ${open}`);
  const activity = (
    db()
      .prepare(
        `SELECT e.id, e.order_id, e.type, e.summary, e.created_at, e.actor_kind, u.name AS actor_name, o.order_number, c.name AS customer_name
         FROM order_events e JOIN orders o ON o.id = e.order_id JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.type IN ('created','status_changed','item_amended','item_added','item_removed','exception_resolved','amendment_applied')
         ORDER BY e.created_at DESC LIMIT 12`,
      )
      .all() as any[]
  ).map((a) => ({ ...a }));
  const topExceptions = (db().prepare("SELECT id, type, severity, title, order_id, created_at, payload FROM exceptions WHERE status = 'open' ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at LIMIT 5").all() as any[]).map((e) => ({
    ...e,
    payload: json(e.payload, {}),
  }));
  return { today, counts, exceptions, due_today: dueToday, overdue, to_review: toReview, week, undated, activity, top_exceptions: topExceptions };
}

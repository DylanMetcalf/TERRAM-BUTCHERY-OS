import { db, json } from '../db/db.js';
import { addDays, localDate } from '../lib/time.js';
import { businessTz } from '../services/settings.js';
import { openExceptionCount } from './exceptions.js';
import { getOrderSummary } from './orders.js';
import { notificationProblemCount } from '../services/notify.js';

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
  /** Work queues for the customer platform: each count links to the list that clears it. */
  const queues = {
    awaiting_confirmation: counts.to_review,
    in_preparation: count("SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','cutting','cut')"),
    being_packed: count("SELECT COUNT(*) n FROM orders WHERE status = 'packing'"),
    awaiting_weighing: count("SELECT COUNT(*) n FROM orders WHERE status = 'packed' AND finalized_at IS NULL"),
    finalized_not_requested: count("SELECT COUNT(*) n FROM orders WHERE status = 'packed' AND finalized_at IS NOT NULL AND payment_state IN ('not_requested','failed')"),
    requests_sent: count("SELECT COUNT(*) n FROM orders WHERE status = 'packed' AND payment_state IN ('requested','pending','partially_paid')"),
    awaiting_verification: count("SELECT COUNT(*) n FROM orders WHERE payment_state = 'proof_submitted' AND status != 'cancelled'"),
    paid_ready: count("SELECT COUNT(*) n FROM orders WHERE status = 'ready'"),
    out_for_delivery: counts.out_for_delivery,
    proofs_to_verify: count("SELECT COUNT(DISTINCT order_id) n FROM payment_proofs WHERE status = 'submitted'"),
    awaiting_payment: count("SELECT COUNT(*) n FROM orders WHERE payment_state IN ('requested','pending','partially_paid','failed') AND status != 'cancelled'"),
    awaiting_customer: count("SELECT COUNT(DISTINCT order_id) n FROM order_amendments WHERE status = 'proposed' AND requires_approval = 1"),
    invoices_outstanding: count("SELECT COUNT(*) n FROM orders WHERE invoice_status IN ('requested','in_progress')"),
    failed_notifications: notificationProblemCount(),
  };
  /** Where every open order is, by production stage. Each stage opens the matching list. */
  const weekAgo = addDays(today, -6);
  const stages = [
    { key: 'new', label: 'New / Confirmed', n: count("SELECT COUNT(*) n FROM orders WHERE status IN ('review','needs_clarification','confirmed','on_hold')"), sub: counts.to_review ? `${counts.to_review} to confirm` : null },
    { key: 'cutting', label: 'Cutting', n: count("SELECT COUNT(*) n FROM orders WHERE status IN ('cutting','cut')"), sub: null },
    { key: 'packing', label: 'Packing', n: count("SELECT COUNT(*) n FROM orders WHERE status = 'packing'"), sub: null },
    { key: 'packed', label: 'Packed & Ready', n: count("SELECT COUNT(*) n FROM orders WHERE status IN ('packed','ready')"), sub: queuesSub() },
    { key: 'out', label: 'Out for Delivery', n: counts.out_for_delivery, sub: null },
    { key: 'delivered', label: 'Delivered', n: count("SELECT COUNT(*) n FROM orders WHERE status = 'completed' AND completed_at >= ?", `${weekAgo}T00:00:00`), sub: 'last 7 days' },
  ];
  function queuesSub() {
    const w = count("SELECT COUNT(*) n FROM orders WHERE status = 'packed' AND finalized_at IS NULL");
    return w ? `${w} to weigh` : null;
  }
  /** Things only we can move forward. Customer-pending items (e.g. a payment we're waiting for) are not here. */
  const waiting = [
    { key: 'confirm', label: 'Orders to confirm', n: counts.to_review, to: '/orders?view=review' },
    { key: 'cut', label: 'Confirmed · to start cutting', n: counts.to_cut, to: '/cutting' },
    { key: 'weigh', label: 'Packed · enter final weights', n: count("SELECT COUNT(*) n FROM orders WHERE status = 'packed' AND finalized_at IS NULL"), to: '/orders?view=weighing' },
    { key: 'request', label: 'Finalized · send the payment request', n: queues.finalized_not_requested, to: '/orders?view=to_request' },
    { key: 'verify', label: 'Customer says paid · check the bank', n: count("SELECT COUNT(DISTINCT o.id) n FROM orders o WHERE o.status != 'cancelled' AND o.payment_state NOT IN ('paid','waived') AND (EXISTS (SELECT 1 FROM payment_proofs p WHERE p.order_id = o.id AND p.status = 'submitted') OR EXISTS (SELECT 1 FROM payment_declarations d WHERE d.order_id = o.id AND d.status = 'submitted'))"), to: '/orders?view=verify' },
    { key: 'paid_ready', label: 'Paid · send out or hand over', n: queues.paid_ready, to: '/fulfilment' },
    { key: 'invoice', label: 'Invoices to upload', n: count("SELECT COUNT(*) n FROM orders WHERE invoice_status IN ('requested','in_progress') AND invoice_file_id IS NULL AND status != 'cancelled'"), to: '/invoices' },
    { key: 'arrange', label: 'Deliveries to arrange separately', n: count("SELECT COUNT(*) n FROM orders WHERE delivery_arrangement = 'separate' AND status NOT IN ('completed','cancelled')"), to: '/orders?view=arrange' },
  ].filter((w) => w.n > 0);
  /** Real problems that are still unresolved. */
  const attention = [
    { key: 'exceptions', label: 'Questions to decide', n: count("SELECT COUNT(*) n FROM exceptions e LEFT JOIN orders o ON o.id = e.order_id WHERE e.status = 'open' AND (o.id IS NULL OR o.status != 'cancelled')"), to: '/exceptions' },
    { key: 'emails', label: 'Emails that didn’t send', n: queues.failed_notifications, to: '/settings?tab=messages' },
    { key: 'address', label: 'Deliveries with no address', n: count("SELECT COUNT(*) n FROM orders WHERE fulfilment_type = 'delivery' AND (delivery_address IS NULL OR TRIM(delivery_address) = '') AND status NOT IN ('completed','cancelled')"), to: '/orders?view=no_address' },
    { key: 'unpaid_released', label: 'Sent out before payment · still unpaid', n: count("SELECT COUNT(*) n FROM orders WHERE released_unpaid_at IS NOT NULL AND payment_state NOT IN ('paid','waived') AND status != 'cancelled'"), to: '/orders?view=unpaid_released' },
    { key: 'delivered_unpaid', label: 'Delivered · not paid', n: count("SELECT COUNT(*) n FROM orders WHERE status = 'completed' AND payment_state NOT IN ('paid','waived') AND COALESCE(final_total_cents, estimated_total_cents, 0) > amount_paid_cents"), to: '/orders?view=delivered_unpaid' },
    { key: 'products', label: 'Product set-ups to check', n: count("SELECT COUNT(*) n FROM products WHERE active = 1 AND order_method_reviewed = 0 AND weight_ranges IS NOT NULL"), to: '/products?review=1' },
  ].filter((a) => a.n > 0);
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
           AND e.rowid = (SELECT e2.rowid FROM order_events e2 WHERE e2.order_id = e.order_id
                          AND e2.type IN ('created','status_changed','item_amended','item_added','item_removed','exception_resolved','amendment_applied')
                          ORDER BY e2.created_at DESC, e2.rowid DESC LIMIT 1)
         ORDER BY e.created_at DESC LIMIT 12`,
      )
      .all() as any[]
  ).map((a) => ({ ...a }));
  const topExceptions = (db().prepare("SELECT id, type, severity, title, order_id, created_at, payload FROM exceptions WHERE status = 'open' ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at LIMIT 5").all() as any[]).map((e) => ({
    ...e,
    payload: json(e.payload, {}),
  }));
  return { today, counts, queues, stages, waiting, attention, exceptions, due_today: dueToday, overdue, to_review: toReview, week, undated, activity, top_exceptions: topExceptions };
}

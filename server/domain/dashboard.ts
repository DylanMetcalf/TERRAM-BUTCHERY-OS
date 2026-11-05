import { db, json } from '../db/db.js';
import { addDays, localDate, localDayStartUtc } from '../lib/time.js';
import { businessTz } from '../services/settings.js';
import { openExceptionCount } from './exceptions.js';
import { getOrderSummary, orderMoney } from './orders.js';
import { PAYMENT_STATE_LABEL } from './payments.js';
import { notificationProblemCount } from '../services/notify.js';

/** Payment checks are shown in "Payments to check", so they aren't counted again as questions. */
const NOT_PAYMENT_CHECK = "COALESCE(e.dedupe_key,'') NOT LIKE 'declared:%' AND COALESCE(e.dedupe_key,'') NOT LIKE 'proof:%'";

/** One order as a dashboard row: who, what, money, delivery details and why it's here. */
function card(id: string) {
  const o = getOrderSummary(id)!;
  const m = orderMoney(id);
  const ex = db().prepare(`SELECT e.title FROM exceptions e WHERE e.order_id = ? AND e.status = 'open' AND ${NOT_PAYMENT_CHECK} ORDER BY CASE e.severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.created_at LIMIT 1`).get(id) as { title: string } | undefined;
  const decl = db().prepare("SELECT created_at, amount_cents FROM payment_declarations WHERE order_id = ? AND status = 'submitted' ORDER BY created_at DESC LIMIT 1").get(id) as { created_at: string; amount_cents: number | null } | undefined;
  const proof = db().prepare("SELECT created_at, amount_claimed_cents FROM payment_proofs WHERE order_id = ? AND status = 'submitted' ORDER BY created_at DESC LIMIT 1").get(id) as { created_at: string; amount_claimed_cents: number | null } | undefined;
  const reason = o.status === 'needs_clarification' ? (ex?.title ?? 'Needs clarification') : o.status === 'on_hold' ? 'On hold' : ex?.title ?? (o.special_request ? 'Includes a special request' : o.status === 'review' ? 'Waiting to be reviewed and confirmed' : null);
  return {
    id,
    order_number: o.order_number,
    customer_name: o.customer_name,
    status: o.status,
    created_at: o.created_at,
    confirmed_at: o.confirmed_at,
    requested_date: o.requested_date,
    fulfilment_type: o.fulfilment_type,
    delivery_address: o.delivery_address,
    delivery_notes: o.delivery_notes,
    contact_phone: o.contact_phone ?? o.customer_phone ?? null,
    payment_state: o.payment_state,
    payment_label: PAYMENT_STATE_LABEL[o.payment_state as keyof typeof PAYMENT_STATE_LABEL] ?? null,
    finalized: !!o.finalized_at,
    released_unpaid: !!o.released_unpaid_at,
    total_cents: m.due_cents ?? m.estimated_cents,
    total_exact: m.due_cents != null,
    balance_cents: m.balance_cents,
    reason,
    paid_claim: proof || decl ? { at: (proof && (!decl || proof.created_at > decl.created_at) ? proof.created_at : decl!.created_at), kind: proof && (!decl || proof.created_at > decl.created_at) ? 'proof' : 'declared', amount_cents: proof?.amount_claimed_cents ?? decl?.amount_cents ?? null } : null,
  };
}

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
    completed_today: count("SELECT COUNT(*) n FROM orders WHERE status = 'completed' AND completed_at >= ?", localDayStartUtc(today, businessTz())),
    received_today: count('SELECT COUNT(*) n FROM orders WHERE created_at >= ?', localDayStartUtc(today, businessTz())),
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
  /**
   * The five live stages, each with its orders. Every open order sits in exactly one of them; packing
   * is an internal step of Processing, and delivered orders live in Fulfilment → History.
   */
  const VERIFY = `EXISTS (SELECT 1 FROM payment_proofs p WHERE p.order_id = o.id AND p.status = 'submitted') OR EXISTS (SELECT 1 FROM payment_declarations d WHERE d.order_id = o.id AND d.status = 'submitted')`;
  const pick = (where: string, order: string, ...args: unknown[]) => {
    const rows = db().prepare(`SELECT o.id FROM orders o WHERE ${where} ORDER BY ${order} LIMIT 30`).all(...args) as { id: string }[];
    return rows.map((r) => card(r.id));
  };
  const sections = [
    { key: 'new', label: 'New / Needs review', statuses: ['review', 'needs_clarification', 'on_hold'], order: 'o.created_at' },
    { key: 'confirmed', label: 'Confirmed', statuses: ['confirmed'], order: "COALESCE(o.requested_date, '9999'), o.confirmed_at" },
    { key: 'processing', label: 'Processing', statuses: ['cutting', 'cut', 'packing'], order: "COALESCE(o.requested_date, '9999'), o.order_number" },
    { key: 'packed', label: 'Packed & Ready', statuses: ['packed', 'ready'], order: "COALESCE(o.requested_date, '9999'), o.order_number" },
    { key: 'out', label: 'Out for Delivery', statuses: ['out_for_delivery'], order: "COALESCE(o.requested_date, '9999'), o.order_number" },
  ].map((x) => {
    const where = `o.status IN (${x.statuses.map((st) => `'${st}'`).join(',')})`;
    return { key: x.key, label: x.label, n: count(`SELECT COUNT(*) n FROM orders o WHERE ${where}`), orders: pick(where, x.order) };
  });
  /** Customers who say they've paid or sent proof: check the bank, then confirm (never "request" again). */
  const payments = {
    n: count(`SELECT COUNT(*) n FROM orders o WHERE o.status != 'cancelled' AND o.payment_state NOT IN ('paid','waived') AND (${VERIFY})`),
    orders: pick(`o.status != 'cancelled' AND o.payment_state NOT IN ('paid','waived') AND (${VERIFY})`, 'o.updated_at'),
  };
  // Kept for older screens that read them
  const stages = sections.map((x) => ({ key: x.key, label: x.label, n: x.n, sub: null as string | null }));
  /** Work only we can move forward, not already shown as a section above. Customers who simply haven't paid yet are not here. */
  const waiting = [
    { key: 'weigh', label: 'Packed · enter final weights', n: count("SELECT COUNT(*) n FROM orders WHERE status = 'packed' AND finalized_at IS NULL"), to: '/orders?view=weighing' },
    { key: 'request', label: 'Finalized · payment request not sent yet', n: queues.finalized_not_requested, to: '/orders?view=to_request' },
    { key: 'invoice', label: 'Invoices to upload', n: count("SELECT COUNT(*) n FROM orders WHERE invoice_status IN ('requested','in_progress') AND invoice_file_id IS NULL AND status != 'cancelled'"), to: '/invoices' },
    { key: 'arrange', label: 'Deliveries to arrange separately', n: count("SELECT COUNT(*) n FROM orders WHERE delivery_arrangement = 'separate' AND status NOT IN ('completed','cancelled')"), to: '/orders?view=arrange' },
  ].filter((w) => w.n > 0);
  /** Real problems that are still unresolved. */
  const attention = [
    { key: 'exceptions', label: 'Questions to decide', n: count(`SELECT COUNT(*) n FROM exceptions e LEFT JOIN orders o ON o.id = e.order_id WHERE e.status = 'open' AND ${NOT_PAYMENT_CHECK} AND (o.id IS NULL OR o.status != 'cancelled')`), to: '/exceptions' },
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
  return { today, counts, queues, sections, payments, stages, waiting, attention, exceptions, due_today: dueToday, overdue, to_review: toReview, week, undated, activity, top_exceptions: topExceptions };
}

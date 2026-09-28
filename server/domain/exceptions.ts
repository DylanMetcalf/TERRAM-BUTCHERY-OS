import { db, id, json, now, tx } from '../db/db.js';
import { publish } from '../services/realtime.js';

/**
 * The Exception Queue — where the system sends anything it will not guess.
 * Each exception carries a plain-language title, the evidence, and the
 * decisions available. Resolution handlers live in exception-actions.ts.
 */
export type ExceptionType =
  | 'unknown_product'
  | 'missing_quantity'
  | 'possible_amendment'
  | 'ambiguous_reference'
  | 'possible_duplicate'
  | 'cancellation_request'
  | 'ambiguous_customer'
  | 'unclear_date'
  | 'customer_question'
  | 'special_request'
  | 'contradiction'
  | 'unmatched_message'
  | 'amendment_no_order'
  | 'ai_failure'
  | 'import_failure'
  | 'integration_failure';

export type Severity = 'blocking' | 'warning' | 'info';

export interface ExceptionRow {
  id: string;
  type: ExceptionType;
  severity: Severity;
  status: 'open' | 'resolved' | 'dismissed';
  title: string;
  detail: string | null;
  order_id: string | null;
  message_id: string | null;
  customer_id: string | null;
  import_batch_id: string | null;
  interpretation_id: string | null;
  payload: any;
  resolution: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface NewException {
  type: ExceptionType;
  severity: Severity;
  title: string;
  detail?: string | null;
  order_id?: string | null;
  message_id?: string | null;
  customer_id?: string | null;
  import_batch_id?: string | null;
  interpretation_id?: string | null;
  payload?: Record<string, unknown>;
  dedupe_key?: string | null;
}

export function raiseException(e: NewException): string {
  if (e.dedupe_key) {
    const existing = db().prepare("SELECT id FROM exceptions WHERE dedupe_key = ? AND status = 'open'").get(e.dedupe_key) as any;
    if (existing) return existing.id;
  }
  const eid = id('ex_');
  db()
    .prepare(
      `INSERT INTO exceptions (id, type, severity, status, title, detail, order_id, message_id, customer_id, import_batch_id, interpretation_id, payload, dedupe_key, created_at)
       VALUES (?,?,?,'open',?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(eid, e.type, e.severity, e.title, e.detail ?? null, e.order_id ?? null, e.message_id ?? null, e.customer_id ?? null, e.import_batch_id ?? null, e.interpretation_id ?? null, JSON.stringify(e.payload ?? {}), e.dedupe_key ?? null, now());
  if (e.order_id) {
    db()
      .prepare("INSERT INTO order_events (id, order_id, type, summary, data, actor_kind, created_at) VALUES (?,?,?,?,?,'system',?)")
      .run(id('ev_'), e.order_id, 'exception_raised', e.title, JSON.stringify({ exception_id: eid, type: e.type }), now());
  }
  publish(['exceptions']);
  return eid;
}

function mapRow(r: any): ExceptionRow {
  return { ...r, payload: json(r.payload, {}) };
}

export function getException(exceptionId: string): ExceptionRow | undefined {
  const r = db().prepare('SELECT * FROM exceptions WHERE id = ?').get(exceptionId);
  return r ? mapRow(r) : undefined;
}

export function listExceptions(filter: { status?: string; orderId?: string; batchId?: string; limit?: number } = {}): (ExceptionRow & { order_number: number | null; customer_name: string | null; message_body: string | null })[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filter.status && filter.status !== 'all') {
    where.push('e.status = ?');
    vals.push(filter.status);
  }
  if (filter.orderId) {
    where.push('e.order_id = ?');
    vals.push(filter.orderId);
  }
  if (filter.batchId) {
    where.push('e.import_batch_id = ?');
    vals.push(filter.batchId);
  }
  const rows = db()
    .prepare(
      `SELECT e.*, o.order_number, COALESCE(c.name, c2.name) AS customer_name, m.body AS message_body
       FROM exceptions e
       LEFT JOIN orders o ON o.id = e.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN customers c2 ON c2.id = e.customer_id
       LEFT JOIN messages m ON m.id = e.message_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE e.status WHEN 'open' THEN 0 ELSE 1 END, CASE e.severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.created_at DESC
       LIMIT ?`,
    )
    .all(...vals, filter.limit ?? 200) as any[];
  return rows.map((r) => ({ ...mapRow(r), order_number: r.order_number, customer_name: r.customer_name, message_body: r.message_body }));
}

export function closeException(exceptionId: string, status: 'resolved' | 'dismissed', resolution: string, note: string | null, userId: string | null) {
  tx(() => {
    db()
      .prepare('UPDATE exceptions SET status = ?, resolution = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run(status, resolution, note, userId, now(), exceptionId);
  });
  publish(['exceptions', 'orders']);
}

export function openExceptionCount(): { total: number; blocking: number } {
  const r = db().prepare("SELECT COUNT(*) total, SUM(CASE WHEN severity = 'blocking' THEN 1 ELSE 0 END) blocking FROM exceptions WHERE status = 'open'").get() as any;
  return { total: r.total ?? 0, blocking: r.blocking ?? 0 };
}

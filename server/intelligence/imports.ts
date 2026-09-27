import crypto from 'node:crypto';
import { db, id, json, now, tx } from '../db/db.js';
import { formatQty, type Qty } from '../../shared/quantity.js';
import { can, type Role } from '../../shared/permissions.js';
import type { OrderSource } from '../../shared/workflow.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { localDate } from '../lib/time.js';
import { audit, type Actor } from '../services/audit.js';
import { recordSystemEvent } from '../services/health.js';
import { publish } from '../services/realtime.js';
import { businessTz, getSettings } from '../services/settings.js';
import { createCustomer, requireCustomer } from '../domain/customers.js';
import { raiseException } from '../domain/exceptions.js';
import { addEvent, addItem, createOrder, removeItem, requireOrder, transition, updateItem, updateOrder, type ItemInput } from '../domain/orders.js';
import { getProduct, listProducts } from '../domain/products.js';
import { analyse } from './analyser.js';
import { draftStatus, refreshItem, validateDraft, type Change, type Draft, type DraftItem, type OrderDraft } from './drafts.js';
import { interpretAll } from './interpret.js';
import { recordAliasCorrection, recordUnknownPhrase } from './learning.js';
import { buildDictionary } from './matcher.js';
import { splitMessages } from './splitter.js';

export interface AnalyseInput {
  text: string;
  source?: OrderSource;
  refDate?: string;
  /** Single-order mode: the customer is already known or typed by staff. */
  customer?: { id?: string; name?: string; phone?: string } | null;
  useAi?: boolean;
}

export interface StoredDraft {
  id: string;
  position: number;
  kind: Draft['kind'];
  status: 'ready' | 'needs_review' | 'committed' | 'discarded';
  confidence: string;
  order_id: string | null;
  data: Draft & { learn?: Record<string, string>; result?: string; discard_reason?: string };
}

function today() {
  return localDate(new Date(), businessTz());
}

export async function analyseImport(input: AnalyseInput, actor: Actor): Promise<string> {
  const text = (input.text ?? '').toString();
  if (!text.trim()) throw badRequest('Paste at least one message.');
  if (text.length > 200_000) throw badRequest('That is too much text for one import. Split it into smaller batches.');
  const refDate = input.refDate && /^\d{4}-\d{2}-\d{2}$/.test(input.refDate) ? input.refDate : today();
  const source = input.source ?? 'import';
  const hash = crypto.createHash('sha256').update(text.trim()).digest('hex');
  const batchId = id('ib_');
  db()
    .prepare("INSERT INTO import_batches (id, source, raw_text, content_hash, status, reference_date, created_by, created_at) VALUES (?,?,?,?,'analysing',?,?,?)")
    .run(batchId, source, text, hash, refDate, actor.userId, now());
  try {
    const dict = buildDictionary(listProducts());
    const settings = getSettings();
    let split = splitMessages(text, refDate, dict, [settings.business.name, 'Terram', 'Terram Farm', 'Terram Butchery']);
    if (input.customer) {
      const forced = input.customer.id ? requireCustomer(input.customer.id) : null;
      split = split.map((m) =>
        m.direction === 'in' ? { ...m, sender: forced?.name ?? input.customer!.name ?? m.sender, senderPhone: forced?.phone_normalized ?? input.customer!.phone ?? m.senderPhone } : m,
      );
    }
    if (!split.length) throw badRequest('No messages were found in that text.');
    const interpreted = await interpretAll(split, dict, { useAi: input.useAi });
    const { drafts, messageDraft } = analyse(interpreted, dict, today());
    if (input.customer?.id) {
      const c = requireCustomer(input.customer.id);
      for (const d of drafts) d.customer = { ...d.customer, match: 'matched', via: 'chosen', customer_id: c.id, customer_name: c.name, name: c.name, candidates: undefined };
      revalidate(drafts);
    }
    tx(() => {
      const draftIds: string[] = [];
      drafts.forEach((d, i) => {
        const did = id('dr_');
        draftIds.push(did);
        db()
          .prepare('INSERT INTO import_drafts (id, batch_id, position, kind, data, confidence, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(did, batchId, i, d.kind, JSON.stringify(d), d.confidence, draftStatus(d), now(), now());
      });
      for (const im of interpreted) {
        const mid = id('ms_');
        const di = messageDraft.get(im.split.index);
        db()
          .prepare(
            `INSERT INTO messages (id, channel, import_batch_id, direction, sender_name, sender_phone, body, sent_at, received_at, classification, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(mid, source === 'import' ? 'whatsapp' : source, batchId, im.split.direction, im.split.sender, im.split.senderPhone, im.split.text, im.split.sentAt, now(), im.parsed.intent, 'pending', now());
        for (const r of im.records) {
          db()
            .prepare(
              `INSERT INTO interpretations (id, message_id, import_batch_id, engine, model, engine_version, raw_input, output, confidence, intent, resulting_action, latency_ms, error, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(id('in_'), mid, batchId, r.engine, r.model, r.version, im.split.text, JSON.stringify(r.output ?? null), di != null ? drafts[di].confidence : 'high', im.parsed.intent, di != null ? `draft:${drafts[di].kind}` : null, r.latencyMs, r.error ?? null, now());
        }
        // remember message ids on the drafts so commit can link them
        if (di != null) {
          const d = drafts[di];
          const m = d.messages.find((x) => x.index === im.split.index);
          if (m) (m as any).message_id = mid;
          db().prepare('UPDATE import_drafts SET data = ? WHERE id = ?').run(JSON.stringify(d), draftIds[di]);
        }
      }
      for (const d of drafts)
        if (d.kind === 'order') for (const it of d.items) if (!it.product_id && it.phrase && !it.reference) recordUnknownPhrase(it.phrase, { batch_id: batchId });
      db().prepare("UPDATE import_batches SET status = 'review', stats = ? WHERE id = ?").run(JSON.stringify(stats(drafts)), batchId);
    });
    audit(actor, 'import.analysed', 'import_batch', batchId, `Analysed ${split.length} messages → ${drafts.length} proposals`);
  } catch (err: any) {
    const msg = err?.userMessage ?? 'The import could not be analysed.';
    db().prepare("UPDATE import_batches SET status = 'failed', error = ? WHERE id = ?").run(msg, batchId);
    if (!(err?.status && err.status < 500)) {
      recordSystemEvent('error', 'import', 'Import analysis failed', err?.stack ?? String(err));
      raiseException({ type: 'import_failure', severity: 'warning', title: 'An import could not be analysed', detail: msg, import_batch_id: batchId });
    }
    throw err;
  }
  publish(['imports']);
  return batchId;
}

function stats(drafts: Draft[]) {
  const s = { messages: 0, orders: 0, amendments: 0, cancellations: 0, ready: 0, needs_review: 0, ignored: 0, attention: 0 };
  for (const d of drafts) {
    s.messages += d.messages.length;
    if (d.kind === 'ignored') {
      if (d.attention) s.attention++;
      else s.ignored++;
      continue;
    }
    if (d.kind === 'order') s.orders++;
    if (d.kind === 'amendment') s.amendments++;
    if (d.kind === 'cancellation') s.cancellations++;
    if (draftStatus(d) === 'ready') s.ready++;
    else s.needs_review++;
  }
  return s;
}

function revalidate(drafts: Draft[]) {
  const done: Draft[] = [];
  for (const d of drafts) done.push(validateDraft(d, { today: today(), previousDrafts: done }));
  return done;
}

export function getBatch(batchId: string) {
  const b = db().prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId) as any;
  if (!b) throw notFound('That import');
  const drafts = (db().prepare('SELECT * FROM import_drafts WHERE batch_id = ? ORDER BY position').all(batchId) as any[]).map(
    (r): StoredDraft => ({ id: r.id, position: r.position, kind: r.kind, status: r.status, confidence: r.confidence, order_id: r.order_id, data: json(r.data, {} as any) }),
  );
  const orderNumbers = new Map<string, number>();
  for (const d of drafts) if (d.order_id) orderNumbers.set(d.order_id, (db().prepare('SELECT order_number FROM orders WHERE id = ?').get(d.order_id) as any)?.order_number);
  return {
    id: b.id,
    source: b.source,
    status: b.status,
    reference_date: b.reference_date,
    created_at: b.created_at,
    committed_at: b.committed_at,
    error: b.error,
    raw_text: b.raw_text,
    stats: json(b.stats, {}),
    drafts: drafts.map((d) => ({ ...d, order_number: d.order_id ? orderNumbers.get(d.order_id) ?? null : null })),
  };
}

export function listBatches(limit = 20) {
  return (db().prepare('SELECT b.id, b.source, b.status, b.created_at, b.committed_at, b.stats, u.name AS created_by_name FROM import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.created_at DESC LIMIT ?').all(limit) as any[]).map((b) => ({ ...b, stats: json(b.stats, {}) }));
}

// ── Editing drafts during review ────────────────────────────

export type DraftEdit =
  | { action: 'set_item'; item_key: string; product_id?: string; qty?: Qty | null; preparation?: Record<string, string>; special_instructions?: string | null }
  | { action: 'remove_item'; item_key: string }
  | { action: 'add_item'; product_id: string; qty: Qty; preparation?: Record<string, string> }
  | { action: 'set_customer'; customer_id: string }
  | { action: 'new_customer'; name: string; phone?: string | null }
  | { action: 'set_fulfilment'; type?: 'collection' | 'delivery' | null; date?: string | null; time_window?: string | null; address?: string | null }
  | { action: 'ack'; code: string }
  | { action: 'resolve_contradiction'; item_key: string; choice: 'replace' | 'add_both' | 'keep' }
  | { action: 'choose_reference'; item_id: string }
  | { action: 'remove_change'; index: number }
  | { action: 'approve_cancel' }
  | { action: 'pending_cancellation'; choice: 'discard_order' | 'keep_order' }
  | { action: 'discard' }
  | { action: 'restore' };

export function editDraft(batchId: string, draftId: string, edit: DraftEdit, actor: Actor, role: Role | null) {
  const batch = getBatch(batchId);
  if (batch.status !== 'review') throw conflict('This import has already been confirmed.');
  const stored = batch.drafts.find((d) => d.id === draftId);
  if (!stored) throw notFound('That proposal');
  if (stored.status === 'committed') throw conflict('That order has already been created.');
  const d = stored.data;
  let status: StoredDraft['status'] | null = null;

  switch (edit.action) {
    case 'discard':
      status = 'discarded';
      break;
    case 'restore':
      status = 'needs_review';
      break;
    case 'ack':
      d.acks = [...new Set([...(d.acks ?? []), String(edit.code)])];
      break;
    case 'set_customer': {
      const c = requireCustomer(edit.customer_id);
      d.customer = { ...d.customer, match: 'matched', via: 'chosen', customer_id: c.id, customer_name: c.name, candidates: undefined };
      break;
    }
    case 'new_customer': {
      if (!edit.name?.trim()) throw badRequest('Enter the customer name.');
      d.customer = { ...d.customer, name: edit.name.trim(), phone: edit.phone ?? d.customer.phone, match: 'new', via: 'chosen', customer_id: null, customer_name: null, candidates: undefined };
      break;
    }
    case 'approve_cancel':
      if (d.kind !== 'cancellation') throw badRequest('Not a cancellation.');
      if (!can(role, 'orders.cancel')) throw forbidden('Only a manager can cancel orders.');
      d.approved = true;
      break;
    default: {
      try {
        if (d.kind === 'order') editOrderDraft(d, edit);
        else if (d.kind === 'amendment') editAmendmentDraft(d as any, edit);
        else throw badRequest('That change does not apply here.');
      } catch (e) {
        if (e instanceof DiscardSignal) status = 'discarded';
        else throw e;
      }
    }
  }
  const all = batch.drafts.map((x) => (x.id === draftId ? d : x.data));
  const revalidated = revalidate(all as Draft[]);
  tx(() => {
    batch.drafts.forEach((x, i) => {
      const nd = revalidated[i];
      const newStatus = x.id === draftId && status ? status : x.status === 'discarded' || x.status === 'committed' ? x.status : draftStatus(nd);
      db().prepare('UPDATE import_drafts SET data = ?, confidence = ?, status = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(nd), nd.confidence, newStatus, now(), x.id);
    });
    db().prepare('UPDATE import_batches SET stats = ? WHERE id = ?').run(JSON.stringify(stats(revalidated.filter((_, i) => batch.drafts[i].status !== 'discarded'))), batchId);
  });
  publish(['imports']);
  return getBatch(batchId);
}

function editOrderDraft(d: OrderDraft & { learn?: Record<string, string> }, edit: DraftEdit) {
  const find = (key: string) => {
    const it = d.items.find((i) => i.key === key);
    if (!it) throw notFound('That line');
    return it;
  };
  switch (edit.action) {
    case 'set_item': {
      const it = find(edit.item_key);
      if (edit.product_id !== undefined) {
        const p = getProduct(edit.product_id);
        if (!p) throw badRequest('Unknown product.');
        if (!it.product_id && it.phrase && !it.reference) {
          d.learn = { ...(d.learn ?? {}), [it.key]: it.phrase };
        }
        if (it.product_id !== p.id) it.preparation = {};
        it.product_id = p.id;
        it.match = 'manual';
        it.reference = false;
      }
      if (edit.qty !== undefined) {
        it.qty = edit.qty;
        it.qty_ambiguous = false;
      }
      if (edit.preparation) it.preparation = edit.preparation;
      if (edit.special_instructions !== undefined) it.special_instructions = edit.special_instructions?.trim() || null;
      Object.assign(it, refreshItem(it));
      break;
    }
    case 'remove_item':
      d.items = d.items.filter((i) => i.key !== edit.item_key);
      break;
    case 'add_item': {
      if (!getProduct(edit.product_id)) throw badRequest('Unknown product.');
      d.items.push(refreshItem({ key: id('m'), product_id: edit.product_id, product_name: null, qty: edit.qty, preparation: edit.preparation ?? {}, preparation_label: '', special_instructions: null, source_text: 'Added by staff', phrase: '', match: 'manual', suggestions: [] }));
      break;
    }
    case 'set_fulfilment':
      for (const k of ['type', 'date', 'time_window', 'address'] as const) if (k in edit) (d.fulfilment as any)[k] = (edit as any)[k] || null;
      break;
    case 'resolve_contradiction': {
      const it = find(edit.item_key);
      const inc = it.pending_replacement;
      if (!inc) break;
      if (edit.choice === 'replace') {
        it.history = [...(it.history ?? []), { from: it.qty, to: inc.qty, summary: `Replaced by “${inc.source_text}”`, message_index: inc.message_index }];
        d.events.push({ summary: `${it.product_name}: ${it.qty ? formatQty(it.qty) : '—'} → ${formatQty(inc.qty)} (replaced)`, message_index: inc.message_index });
        it.qty = inc.qty;
      } else if (edit.choice === 'add_both') {
        d.items.push({ ...it, key: id('m'), qty: inc.qty, source_text: inc.source_text, pending_replacement: null, history: [] });
      }
      it.pending_replacement = null;
      break;
    }
    case 'pending_cancellation':
      if (edit.choice === 'keep_order') d.pending_cancellation = false;
      break;
    default:
      throw badRequest('That change does not apply to an order.');
  }
  if (edit.action === 'pending_cancellation' && edit.choice === 'discard_order') throw new DiscardSignal();
}

class DiscardSignal extends Error {}

function editAmendmentDraft(d: Extract<Draft, { kind: 'amendment' }>, edit: DraftEdit) {
  switch (edit.action) {
    case 'choose_reference': {
      if (!d.reference || !d.target) throw badRequest('Nothing to choose.');
      const item = d.target.items.find((i) => i.id === edit.item_id);
      if (!item) throw badRequest('That item is not on the order.');
      if (d.reference.qty) d.changes.push({ op: 'set_qty', item_id: item.id, label: item.product_name, product_id: item.product_id, from: item.qty, to: d.reference.qty });
      d.reference = null;
      break;
    }
    case 'remove_change':
      d.changes.splice(edit.index, 1);
      break;
    case 'set_item': {
      const ch = d.changes.find((c) => c.op === 'add' && c.item.key === edit.item_key) as Extract<Change, { op: 'add' }> | undefined;
      if (!ch) throw notFound('That line');
      if (edit.product_id) {
        ch.item.product_id = edit.product_id;
        ch.item.match = 'manual';
      }
      if (edit.qty !== undefined) ch.item.qty = edit.qty;
      if (edit.preparation) ch.item.preparation = edit.preparation;
      break;
    }
    default:
      throw badRequest('That change does not apply to an amendment.');
  }
}

// ── Commit ──────────────────────────────────────────────────

export interface CommitResult {
  created: { order_id: string; order_number: number; status: string }[];
  amended: { order_id: string; order_number: number }[];
  exceptions: number;
  skipped: number;
  failed: { position: number; error: string }[];
}

export function commitBatch(batchId: string, opts: { sendRestToExceptions?: boolean; draftIds?: string[] }, actor: Actor, role: Role | null): CommitResult {
  const batch = getBatch(batchId);
  const result: CommitResult = { created: [], amended: [], exceptions: 0, skipped: 0, failed: [] };
  if (batch.status === 'committed') {
    for (const d of batch.drafts) if (d.status === 'committed' && d.order_id && d.kind === 'order') result.created.push({ order_id: d.order_id, order_number: d.order_number!, status: '' });
    return result;
  }
  if (batch.status !== 'review') throw conflict('This import cannot be confirmed.');
  const sendRest = opts.sendRestToExceptions ?? true;
  for (const stored of batch.drafts) {
    if (opts.draftIds && !opts.draftIds.includes(stored.id)) continue;
    if (stored.status === 'committed' || stored.status === 'discarded') continue;
    if (stored.status === 'needs_review' && !sendRest) {
      result.skipped++;
      continue;
    }
    try {
      const outcome = tx(() => commitDraft(batchId, stored, actor, role, result, { readyStatus: 'confirmed', source: batchSource(batchId), autoApplyAmendments: true }));
      db().prepare("UPDATE import_drafts SET status = ?, order_id = ?, data = ?, updated_at = ? WHERE id = ?").run(outcome.status, outcome.orderId ?? null, JSON.stringify({ ...stored.data, result: outcome.summary }), now(), stored.id);
    } catch (err: any) {
      const msg = err?.userMessage ?? err?.message ?? 'Unknown error';
      result.failed.push({ position: stored.position, error: msg });
      recordSystemEvent('error', 'import', `Draft ${stored.position + 1} of an import failed`, err?.stack ?? msg);
      db().prepare('UPDATE import_drafts SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...stored.data, error: msg }), now(), stored.id);
    }
  }
  const remaining = (db().prepare("SELECT COUNT(*) c FROM import_drafts WHERE batch_id = ? AND status IN ('ready','needs_review')").get(batchId) as any).c;
  if (remaining === 0) db().prepare("UPDATE import_batches SET status = 'committed', committed_at = ? WHERE id = ?").run(now(), batchId);
  audit(actor, 'import.committed', 'import_batch', batchId, `Created ${result.created.length} orders, applied ${result.amended.length} amendments, ${result.exceptions} to exceptions`, result);
  publish(['imports', 'orders', 'exceptions', 'customers']);
  return result;
}

function messageIds(d: Draft): string[] {
  return d.messages.map((m) => (m as any).message_id).filter(Boolean);
}

function firstInboundMessage(d: Draft): { id: string | null; text: string } {
  const m = d.messages.find((x) => x.direction === 'in') ?? d.messages[0];
  return { id: (m as any)?.message_id ?? null, text: m?.text ?? '' };
}

export interface CommitOptions {
  /** 'confirmed' when a person reviewed the draft (import screen); 'review' for live channels. */
  readyStatus: 'confirmed' | 'review';
  source: OrderSource;
  /** Apply clear amendments directly; otherwise they wait in exceptions for one-click confirmation. */
  autoApplyAmendments: boolean;
}

export function commitDraft(batchId: string | null, stored: Pick<StoredDraft, 'data' | 'position'>, actor: Actor, role: Role | null, result: CommitResult, opts: CommitOptions): { status: 'committed' | 'discarded'; orderId?: string; summary: string } {
  const d = stored.data;
  const msgIds = messageIds(d);
  const first = firstInboundMessage(d);
  const markMessages = (status: string, orderId: string | null = null) => {
    for (const m of msgIds) db().prepare('UPDATE messages SET status = ?, order_id = COALESCE(?, order_id) WHERE id = ?').run(status, orderId, m);
  };

  if (d.kind === 'ignored') {
    if (d.attention) {
      raiseException({
        type: d.intent === 'question' ? 'customer_question' : 'unmatched_message',
        severity: d.intent === 'question' ? 'info' : 'warning',
        title: d.intent === 'question' ? `${d.customer.name ?? 'A customer'} asked a question` : `Message from ${d.customer.name ?? 'unknown sender'} needs a look`,
        detail: first.text,
        message_id: first.id,
        customer_id: d.customer.customer_id,
        import_batch_id: batchId,
        payload: { message_text: first.text, sender: d.customer.name },
      });
      result.exceptions++;
      markMessages('exception');
    } else markMessages('ignored');
    return { status: 'committed', summary: d.attention ? 'Sent to exceptions' : 'Ignored' };
  }

  if (d.kind === 'cancellation') {
    if (!d.target) {
      raiseException({ type: 'amendment_no_order', severity: 'warning', title: `${d.customer.name ?? 'A customer'} asked to cancel, but no open order was found`, detail: first.text, message_id: first.id, customer_id: d.customer.customer_id, import_batch_id: batchId, payload: { message_text: first.text } });
      result.exceptions++;
      markMessages('exception');
      return { status: 'committed', summary: 'Sent to exceptions' };
    }
    if (d.approved && can(role, 'orders.cancel')) {
      transition(d.target.order_id, 'cancelled', actor, role, { note: `Customer asked: “${first.text}”` });
      markMessages('processed', d.target.order_id);
      result.amended.push({ order_id: d.target.order_id, order_number: d.target.order_number });
      return { status: 'committed', orderId: d.target.order_id, summary: 'Order cancelled' };
    }
    raiseException({
      type: 'cancellation_request',
      severity: 'blocking',
      title: `${d.customer.customer_name ?? d.customer.name} asked to cancel order #${d.target.order_number}`,
      detail: first.text,
      order_id: d.target.order_id,
      message_id: first.id,
      import_batch_id: batchId,
      payload: { message_text: first.text },
      dedupe_key: `cancel:${d.target.order_id}:${first.id}`,
    });
    result.exceptions++;
    markMessages('exception', d.target.order_id);
    return { status: 'committed', orderId: d.target.order_id, summary: 'Cancellation sent to exceptions' };
  }

  if (d.kind === 'amendment') {
    const blocking = d.issues.filter((i) => i.severity === 'blocking');
    if (!d.target) {
      raiseException({ type: 'amendment_no_order', severity: 'warning', title: `${d.customer.name ?? 'A customer'} sent a change, but no open order was found`, detail: first.text, message_id: first.id, customer_id: d.customer.customer_id, import_batch_id: batchId, payload: { message_text: first.text } });
      result.exceptions++;
      markMessages('exception');
      return { status: 'committed', summary: 'Sent to exceptions' };
    }
    if (!blocking.length && opts.autoApplyAmendments) {
      applyChanges(d.target.order_id, d.changes, actor, role, first.id, `Customer message: “${first.text}”`);
      markMessages('processed', d.target.order_id);
      result.amended.push({ order_id: d.target.order_id, order_number: d.target.order_number });
      return { status: 'committed', orderId: d.target.order_id, summary: 'Amendment applied' };
    }
    if (d.reference) {
      raiseException({
        type: 'ambiguous_reference',
        severity: 'blocking',
        title: `${d.customer.customer_name ?? d.customer.name}: which item should change?`,
        detail: `“${d.reference.source_text}”`,
        order_id: d.target.order_id,
        message_id: first.id,
        import_batch_id: batchId,
        payload: { message_text: first.text, qty: d.reference.qty, options: d.reference.options },
      });
      result.exceptions++;
    }
    const resolvable = d.changes.filter((c) => c.op !== 'add' || (c.item.product_id && c.item.qty));
    if (resolvable.length && (blocking.length === 0 || blocking.some((b) => b.code !== 'ambiguous_reference'))) {
      raiseException({
        type: 'possible_amendment',
        severity: 'blocking',
        title: `Possible amendment to #${d.target.order_number} (${d.customer.customer_name ?? d.customer.name})`,
        detail: first.text,
        order_id: d.target.order_id,
        message_id: first.id,
        import_batch_id: batchId,
        payload: { message_text: first.text, changes: resolvable, order_number: d.target.order_number },
      });
      result.exceptions++;
    }
    for (const c of d.changes) if (c.op === 'add' && !(c.item.product_id && c.item.qty)) {
      raiseException(unknownItemException(c.item, d.target.order_id, first, batchId));
      result.exceptions++;
    }
    markMessages('exception', d.target.order_id);
    return { status: 'committed', orderId: d.target.order_id, summary: 'Sent to exceptions' };
  }

  // Order draft
  const od = d as OrderDraft & { learn?: Record<string, string> };
  const codes = new Set(od.issues.filter((i) => i.severity === 'blocking').map((i) => i.code));
  if (codes.has('duplicate_in_batch')) {
    result.skipped++;
    markMessages('ignored');
    return { status: 'discarded', summary: 'Skipped — duplicate within this import' };
  }
  const goodItems = od.items.filter((i) => i.product_id && i.qty && !i.pending_replacement && !itemBlocked(od, i));
  const badItems = od.items.filter((i) => !goodItems.includes(i));
  const hasBlocking = codes.size > 0;

  let customer: { id: string } | { new: { name: string; phone?: string | null; email?: string | null; address?: string | null } };
  let placeholder = false;
  if (od.customer.customer_id && (od.customer.match === 'matched' || od.customer.match === 'probable')) customer = { id: od.customer.customer_id };
  else if (od.customer.match === 'new' && od.customer.name) customer = { new: { name: od.customer.name, phone: od.customer.phone, email: od.customer.email, address: od.fulfilment.type === 'delivery' ? od.fulfilment.address : null } };
  else {
    placeholder = true;
    customer = { new: { name: od.customer.name ?? 'Unknown sender', phone: od.customer.phone, email: od.customer.email } };
  }

  const items: ItemInput[] = goodItems.map((i) => ({ product_id: i.product_id!, qty: i.qty!, preparation: i.preparation, special_instructions: i.special_instructions, source_text: i.source_text }));
  const order = createOrder(
    {
      customer,
      source: opts.source,
      items,
      status: hasBlocking ? 'needs_clarification' : opts.readyStatus,
      resume_status: opts.readyStatus,
      fulfilment_type: od.fulfilment.type,
      requested_date: od.fulfilment.date,
      time_window: od.fulfilment.time_window,
      delivery_address: od.fulfilment.type === 'delivery' ? od.fulfilment.address : null,
      contact_phone: od.customer.phone,
      notes: od.notes.length ? od.notes.join('\n') : null,
      import_batch_id: batchId,
      message_ids: msgIds,
      created_summary:
        opts.readyStatus === 'confirmed'
          ? `Imported and ${hasBlocking ? 'sent for clarification' : 'confirmed'} by ${actor.name ?? 'staff'}`
          : `Received via ${opts.source} — ${hasBlocking ? 'needs clarification' : 'waiting for review'}`,
      created_data: { confidence: od.confidence, amendments: od.events.map((e) => e.summary) },
    },
    actor,
  );
  for (const e of od.events) {
    const mid = (od.messages.find((m) => m.index === e.message_index) as any)?.message_id ?? null;
    addEvent(order.id, 'amendment_applied', e.summary, actor, { during_import: true }, mid);
  }
  // Learning: staff mapped an unknown phrase to a product
  for (const [key, phrase] of Object.entries(od.learn ?? {})) {
    const it = od.items.find((i) => i.key === key);
    if (it?.product_id) recordAliasCorrection(phrase, it.product_id, actor, { order_id: order.id });
  }
  if (hasBlocking) {
    for (const it of badItems) {
      raiseException(unknownItemException(it, order.id, first, batchId));
      result.exceptions++;
    }
    if (placeholder || codes.has('ambiguous_customer') || codes.has('unknown_customer')) {
      raiseException({
        type: 'ambiguous_customer',
        severity: 'blocking',
        title: od.customer.name ? `Which ${od.customer.name} is order #${order.order_number} for?` : `Who is order #${order.order_number} for?`,
        detail: first.text,
        order_id: order.id,
        message_id: first.id,
        import_batch_id: batchId,
        payload: { name: od.customer.name, phone: od.customer.phone, candidates: od.customer.candidates ?? [], placeholder_customer_id: order.customer_id },
      });
      result.exceptions++;
    }
    if (codes.has('possible_duplicate') && od.duplicate_of?.order_id) {
      raiseException({
        type: 'possible_duplicate',
        severity: 'blocking',
        title: `Order #${order.order_number} may duplicate #${od.duplicate_of.order_number}`,
        detail: `${order.customer_name} already has a very similar order.`,
        order_id: order.id,
        import_batch_id: batchId,
        payload: { duplicate_of: od.duplicate_of },
      });
      result.exceptions++;
    }
    if (codes.has('cancellation')) {
      raiseException({ type: 'cancellation_request', severity: 'blocking', title: `${order.customer_name} asked to cancel order #${order.order_number}`, detail: od.messages.map((m) => m.text).join('\n'), order_id: order.id, import_batch_id: batchId, payload: { message_text: od.messages[od.messages.length - 1]?.text } });
      result.exceptions++;
    }
    if (codes.has('no_items') && !badItems.length) {
      raiseException({ type: 'unmatched_message', severity: 'blocking', title: `No products found for order #${order.order_number}`, detail: first.text, order_id: order.id, message_id: first.id, import_batch_id: batchId, payload: { message_text: first.text } });
      result.exceptions++;
    }
  }
  result.created.push({ order_id: order.id, order_number: order.order_number, status: order.status });
  return { status: 'committed', orderId: order.id, summary: hasBlocking ? 'Created — needs clarification' : 'Created and confirmed' };
}

function itemBlocked(d: OrderDraft, it: DraftItem) {
  return d.issues.some((i) => i.severity === 'blocking' && i.item_key === it.key);
}

function batchSource(batchId: string): OrderSource {
  const b = db().prepare('SELECT source FROM import_batches WHERE id = ?').get(batchId) as any;
  return (b?.source ?? 'import') as OrderSource;
}

function unknownItemException(it: DraftItem, orderId: string, first: { id: string | null; text: string }, batchId: string | null) {
  const payload = {
    phrase: it.phrase,
    source_text: it.source_text,
    qty: it.qty,
    product_id: it.product_id,
    preparation: it.preparation,
    special_instructions: it.special_instructions,
    suggestions: it.suggestions,
    ai_suggestion: it.ai_suggestion ?? null,
    pending_replacement: it.pending_replacement ?? null,
    reference: !!it.reference,
    message_text: first.text,
  };
  if (it.pending_replacement && it.product_id) {
    return { type: 'contradiction' as const, severity: 'blocking' as const, title: `${it.product_name}: ${it.qty ? formatQty(it.qty) : '?'} or ${formatQty(it.pending_replacement.qty)}?`, detail: `First: “${it.source_text}” · Later: “${it.pending_replacement.source_text}”`, order_id: orderId, message_id: first.id, import_batch_id: batchId, payload };
  }
  if (it.product_id && !it.qty) {
    return { type: 'missing_quantity' as const, severity: 'blocking' as const, title: `How much ${it.product_name}?`, detail: `“${it.source_text}”`, order_id: orderId, message_id: first.id, import_batch_id: batchId, payload };
  }
  if (it.product_id && it.qty) {
    return { type: 'missing_quantity' as const, severity: 'blocking' as const, title: `Check the quantity for ${it.product_name}`, detail: `“${it.source_text}” — ${formatQty(it.qty)} doesn't fit how this product is sold.`, order_id: orderId, message_id: first.id, import_batch_id: batchId, payload };
  }
  if (it.reference) {
    return { type: 'ambiguous_reference' as const, severity: 'blocking' as const, title: `Which product does “${it.source_text}” mean?`, detail: first.text, order_id: orderId, message_id: first.id, import_batch_id: batchId, payload: { ...payload, options: [] } };
  }
  return { type: 'unknown_product' as const, severity: 'blocking' as const, title: `Unknown product: “${it.phrase || it.source_text}”`, detail: first.text, order_id: orderId, message_id: first.id, import_batch_id: batchId, payload };
}

/** Applies confirmed amendment changes through the order engine (each one audited). */
export function applyChanges(orderId: string, changes: Change[], actor: Actor, role: Role | null, messageId: string | null, reason: string) {
  const order = requireOrder(orderId);
  for (const ch of changes) {
    if (ch.op === 'set_qty') updateItem(ch.item_id, { qty: ch.to, ...(ch.preparation ? { preparation: ch.preparation } : {}) }, actor, { messageId, reason });
    else if (ch.op === 'remove') removeItem(ch.item_id, actor, { messageId, reason });
    else if (ch.op === 'add' && ch.item.product_id && ch.item.qty)
      addItem(orderId, { product_id: ch.item.product_id, qty: ch.item.qty, preparation: ch.item.preparation, special_instructions: ch.item.special_instructions, source_text: ch.item.source_text }, actor, { messageId, reason });
    else if (ch.op === 'set_fulfilment') {
      const f = ch.fulfilment;
      updateOrder(
        orderId,
        {
          ...(f.type ? { fulfilment_type: f.type } : {}),
          ...(f.date ? { requested_date: f.date } : {}),
          ...(f.time_window ? { time_window: f.time_window } : {}),
          ...(f.address ? { delivery_address: f.address } : {}),
        },
        actor,
        role,
        { messageId, reason },
      );
    }
  }
  return order;
}

export { createCustomer };

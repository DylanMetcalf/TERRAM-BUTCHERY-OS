import { formatQty, qtyEquals, validateQty, type Qty } from '../../shared/quantity.js';
import { getProduct, preparationLabel, resolvePreparation } from '../domain/products.js';
import { findPossibleDuplicates, itemSimilarity } from '../domain/duplicates.js';
import type { Intent } from './parser.js';

/**
 * Drafts are proposed orders/amendments from an import or a pasted message.
 * They are editable, re-validated after every edit, and only become real
 * orders when a person confirms them.
 */
export type Confidence = 'high' | 'medium' | 'low';

export type IssueCode =
  | 'unknown_product'
  | 'missing_quantity'
  | 'invalid_quantity'
  | 'ambiguous_quantity'
  | 'fuzzy_match'
  | 'unrecognised_words'
  | 'conflicting_preparation'
  | 'unknown_customer'
  | 'ambiguous_customer'
  | 'probable_customer'
  | 'possible_duplicate'
  | 'duplicate_in_batch'
  | 'ambiguous_reference'
  | 'contradiction'
  | 'combined_messages'
  | 'no_items'
  | 'no_date'
  | 'past_date'
  | 'cancellation'
  | 'amendment_no_order'
  | 'order_in_production'
  | 'ai_suggestion';

export interface DraftIssue {
  code: IssueCode;
  severity: 'blocking' | 'warning' | 'info';
  message: string;
  item_key?: string;
  options?: any;
}

export interface DraftItem {
  key: string;
  product_id: string | null;
  product_name: string | null;
  qty: Qty | null;
  qty_label?: string;
  preparation: Record<string, string>;
  preparation_label: string;
  special_instructions: string | null;
  source_text: string;
  phrase: string;
  match: 'exact' | 'fuzzy' | 'manual' | 'unknown';
  qty_ambiguous?: boolean;
  suggestions: { product_id: string; name: string }[];
  ai_suggestion?: { product_id: string; name: string; preparation?: Record<string, string>; reason?: string } | null;
  reference?: boolean;
  history?: { from: Qty | null; to: Qty | null; summary: string; message_index: number }[];
  pending_replacement?: { qty: Qty; source_text: string; message_index: number } | null;
}

export interface DraftCustomer {
  name: string | null;
  phone: string | null;
  email: string | null;
  match: 'matched' | 'probable' | 'ambiguous' | 'new' | 'unknown';
  via?: string;
  customer_id: string | null;
  customer_name?: string | null;
  candidates?: { id: string; name: string; phone: string | null }[];
}

export interface DraftMessage {
  index: number;
  text: string;
  sender: string | null;
  sent_at: string | null;
  intent: Intent;
  direction: 'in' | 'out';
  engine: 'rules' | 'claude';
}

export interface DraftFulfilment {
  type: 'collection' | 'delivery' | null;
  date: string | null;
  time_window: string | null;
  address: string | null;
}

export type Change =
  | { op: 'set_qty'; item_id: string; label: string; product_id: string; from: Qty; to: Qty; preparation?: Record<string, string> }
  | { op: 'add'; item: DraftItem }
  | { op: 'remove'; item_id: string; label: string }
  | { op: 'set_fulfilment'; fulfilment: Partial<DraftFulfilment> };

export interface TargetOrder {
  order_id: string;
  order_number: number;
  status: string;
  requested_date: string | null;
  items: { id: string; product_id: string; label: string; qty: Qty; piece_noun: string; product_name: string }[];
}

interface DraftBase {
  customer: DraftCustomer;
  messages: DraftMessage[];
  issues: DraftIssue[];
  acks: string[]; // acknowledged warning/blocking codes (e.g. "possible_duplicate")
  confidence: Confidence;
  notes: string[];
  error?: string | null;
}

export interface OrderDraft extends DraftBase {
  kind: 'order';
  items: DraftItem[];
  fulfilment: DraftFulfilment;
  events: { summary: string; message_index: number }[];
  duplicate_of?: { order_id?: string; order_number?: number; draft_position?: number } | null;
  pending_cancellation?: boolean;
}

export interface AmendmentDraft extends DraftBase {
  kind: 'amendment';
  target: TargetOrder | null;
  changes: Change[];
  reference?: { qty: Qty | null; options: { item_id: string; label: string }[]; source_text: string } | null;
}

export interface CancellationDraft extends DraftBase {
  kind: 'cancellation';
  target: TargetOrder | null;
  approved?: boolean;
}

export interface MessageDraft extends DraftBase {
  kind: 'ignored';
  intent: Intent;
  /** Needs a person's attention (question / unclear) vs just noise (thanks). */
  attention: boolean;
}

export type Draft = OrderDraft | AmendmentDraft | CancellationDraft | MessageDraft;

export function refreshItem(item: DraftItem): DraftItem {
  const p = item.product_id ? getProduct(item.product_id) : null;
  if (!p) return { ...item, product_name: null, preparation_label: '', qty_label: item.qty ? formatQty(item.qty) : undefined };
  let label = '';
  let prep = item.preparation;
  try {
    const r = resolvePreparation(p, item.preparation);
    prep = r.preparation;
    label = r.label;
  } catch {
    label = preparationLabel(p, item.preparation);
  }
  return { ...item, product_name: p.canonical_name, preparation: prep, preparation_label: label, qty_label: item.qty ? formatQty(item.qty, p.piece_noun) : undefined };
}

export function itemIssues(item: DraftItem): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const p = item.product_id ? getProduct(item.product_id) : null;
  if (!p) {
    issues.push({
      code: 'unknown_product',
      severity: 'blocking',
      message: item.reference ? `Not sure which product “${item.source_text}” refers to.` : `We don't recognise “${item.phrase || item.source_text}”.`,
      item_key: item.key,
      options: { suggestions: item.suggestions, ai_suggestion: item.ai_suggestion ?? null },
    });
    if (!item.qty) issues.push({ code: 'missing_quantity', severity: 'blocking', message: `How much “${item.phrase || item.source_text}”?`, item_key: item.key });
    return issues;
  }
  if (!p.active) issues.push({ code: 'unknown_product', severity: 'blocking', message: `${p.canonical_name} is marked as unavailable.`, item_key: item.key, options: { suggestions: [] } });
  if (!item.qty) {
    issues.push({ code: 'missing_quantity', severity: 'blocking', message: `How much ${p.canonical_name}? No quantity was given.`, item_key: item.key });
  } else {
    const problem = validateQty(item.qty, p.quantity_type, p.allows_portions);
    if (problem) issues.push({ code: 'invalid_quantity', severity: 'blocking', message: `${p.canonical_name}: ${problem}`, item_key: item.key });
    else if (item.qty_ambiguous) issues.push({ code: 'ambiguous_quantity', severity: 'warning', message: `Check the quantity for ${p.canonical_name} — “${item.source_text}”.`, item_key: item.key });
  }
  if (item.match === 'fuzzy') issues.push({ code: 'fuzzy_match', severity: 'warning', message: `Read “${item.phrase}” as ${p.canonical_name}.`, item_key: item.key });
  if (item.special_instructions && item.match !== 'manual') {
    issues.push({ code: 'unrecognised_words', severity: 'info', message: `Kept “${item.special_instructions}” as a note on ${p.canonical_name}.`, item_key: item.key });
  }
  if (item.pending_replacement) {
    issues.push({
      code: 'contradiction',
      severity: 'blocking',
      message: `${p.canonical_name} was ordered as ${item.qty ? formatQty(item.qty, p.piece_noun) : '?'}, then later as ${formatQty(item.pending_replacement.qty, p.piece_noun)}. Replace or add both?`,
      item_key: item.key,
      options: { existing: item.qty, incoming: item.pending_replacement },
    });
  }
  return issues;
}

function customerIssues(c: DraftCustomer): DraftIssue[] {
  switch (c.match) {
    case 'unknown':
      return [{ code: 'unknown_customer', severity: 'blocking', message: 'Who is this order for? No name or number was found.' }];
    case 'ambiguous':
      return [{ code: 'ambiguous_customer', severity: 'blocking', message: `More than one customer is called ${c.name}. Which one?`, options: { candidates: c.candidates } }];
    case 'probable':
      return [{ code: 'probable_customer', severity: 'warning', message: `Matched “${c.name}” to ${c.customer_name}${c.via === 'first_name' ? ' by first name' : ''}.` }];
    default:
      return [];
  }
}

export function scoreConfidence(issues: DraftIssue[], extra: Confidence = 'high'): Confidence {
  if (issues.some((i) => i.severity === 'blocking')) return 'low';
  if (extra === 'low') return 'low';
  if (issues.some((i) => i.severity === 'warning') || extra === 'medium') return 'medium';
  return 'high';
}

export interface ValidateContext {
  today: string;
  previousDrafts: Draft[];
}

/** Recompute issues from current draft state. Pure apart from read-only DB lookups. */
export function validateDraft(d: Draft, ctx: ValidateContext): Draft {
  const acked = new Set(d.acks);
  let issues: DraftIssue[] = [];
  if (d.kind === 'order') {
    d.items = d.items.map(refreshItem);
    issues.push(...customerIssues(d.customer));
    for (const it of d.items) issues.push(...itemIssues(it));
    if (!d.items.length) issues.push({ code: 'no_items', severity: 'blocking', message: 'No products were found in this message.' });
    if (!d.fulfilment.date) issues.push({ code: 'no_date', severity: 'info', message: 'No collection or delivery date was mentioned.' });
    else if (d.fulfilment.date < ctx.today) issues.push({ code: 'past_date', severity: 'warning', message: `The requested date (${d.fulfilment.date}) is in the past.` });
    if (d.messages.filter((m) => m.direction === 'in' && m.intent === 'new_order').length > 1 && !d.events.length) {
      issues.push({ code: 'combined_messages', severity: 'info', message: `Combined ${d.messages.filter((m) => m.intent === 'new_order').length} messages from ${d.customer.name ?? 'this sender'} into one order.` });
    }
    if (d.pending_cancellation) issues.push({ code: 'cancellation', severity: 'blocking', message: `${d.customer.name ?? 'The customer'} later asked to cancel this order.` });
    // Duplicates — within this import, then against existing orders
    const resolved = d.items.filter((i) => i.product_id && i.qty) as { product_id: string; qty: Qty }[];
    const earlier = ctx.previousDrafts.findIndex(
      (o) => o.kind === 'order' && o !== d && sameSender(o.customer, d.customer) && itemSimilarity((o as OrderDraft).items.filter((i) => i.product_id && i.qty) as any, resolved) >= 0.99,
    );
    if (earlier >= 0 && resolved.length) {
      d.duplicate_of = { draft_position: earlier };
      issues.push({ code: 'duplicate_in_batch', severity: 'blocking', message: `This looks like the same order as #${earlier + 1} in this import (pasted twice?).`, options: { draft_position: earlier } });
    } else if (d.customer.customer_id && resolved.length) {
      const dups = findPossibleDuplicates(d.customer.customer_id, resolved, { requestedDate: d.fulfilment.date });
      if (dups.length) {
        d.duplicate_of = { order_id: dups[0].order_id, order_number: dups[0].order_number };
        issues.push({
          code: 'possible_duplicate',
          severity: 'blocking',
          message: `${d.customer.customer_name ?? d.customer.name} already has a very similar order (#${dups[0].order_number}).`,
          options: { order_id: dups[0].order_id, order_number: dups[0].order_number, reasons: dups[0].reasons },
        });
      } else d.duplicate_of = null;
    }
  } else if (d.kind === 'amendment') {
    issues.push(...customerIssues(d.customer).filter((i) => i.code !== 'probable_customer'));
    if (!d.target) issues.push({ code: 'amendment_no_order', severity: 'blocking', message: `${d.customer.name ?? 'This customer'} seems to be changing an order, but no open order was found.` });
    else if (['cutting', 'cut', 'packing', 'packed', 'ready'].includes(d.target.status)) {
      issues.push({ code: 'order_in_production', severity: 'warning', message: `Order #${d.target.order_number} is already being prepared — the change must also be made physically.` });
    }
    if (d.reference) {
      issues.push({
        code: 'ambiguous_reference',
        severity: 'blocking',
        message: `“${d.reference.source_text}” — which item does this refer to?`,
        options: { qty: d.reference.qty, items: d.reference.options },
      });
    }
    for (const ch of d.changes) {
      if (ch.op === 'add') {
        ch.item = refreshItem(ch.item);
        issues.push(...itemIssues(ch.item));
      }
    }
    if (!d.changes.length && !d.reference && d.target) issues.push({ code: 'no_items', severity: 'blocking', message: 'We could not tell what should change.' });
  } else if (d.kind === 'cancellation') {
    issues.push(...customerIssues(d.customer).filter((i) => i.code !== 'probable_customer'));
    if (!d.target) issues.push({ code: 'amendment_no_order', severity: 'blocking', message: `${d.customer.name ?? 'This customer'} asked to cancel, but no open order was found.` });
    else if (!d.approved) issues.push({ code: 'cancellation', severity: 'blocking', message: `Cancel order #${d.target.order_number}? A person must confirm cancellations.` });
  }
  issues = issues.filter((i) => !acked.has(i.code + (i.item_key ? ':' + i.item_key : '')) && !acked.has(i.code));
  d.issues = issues;
  d.confidence = scoreConfidence(issues, d.kind === 'amendment' && d.changes.some((c) => c.op === 'set_qty') && d.messages.some((m) => m.engine === 'claude') ? 'medium' : 'high');
  return d;
}

function sameSender(a: DraftCustomer, b: DraftCustomer) {
  if (a.customer_id && b.customer_id) return a.customer_id === b.customer_id;
  if (a.phone && b.phone) return a.phone === b.phone;
  return !!a.name && !!b.name && a.name.toLowerCase() === b.name.toLowerCase();
}

export function draftStatus(d: Draft): 'ready' | 'needs_review' {
  if (d.kind === 'ignored') return d.attention ? 'needs_review' : 'ready';
  return d.issues.some((i) => i.severity === 'blocking') ? 'needs_review' : 'ready';
}

export function describeChange(ch: Change): string {
  switch (ch.op) {
    case 'set_qty':
      return `${ch.label}: ${formatQty(ch.from)} → ${formatQty(ch.to)}`;
    case 'add':
      return `Add ${ch.item.product_name ?? ch.item.phrase}${ch.item.qty ? ' — ' + formatQty(ch.item.qty) : ''}`;
    case 'remove':
      return `Remove ${ch.label}`;
    case 'set_fulfilment':
      return `Update ${Object.keys(ch.fulfilment).join(', ')}`;
  }
}

export { qtyEquals };

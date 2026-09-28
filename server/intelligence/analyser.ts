import { db } from '../db/db.js';
import { formatQty, qtyEquals, type Qty } from '../../shared/quantity.js';
import { normalise } from '../../shared/text.js';
import { matchCustomer } from '../domain/customers.js';
import { getProduct } from '../domain/products.js';
import type { Dictionary } from './matcher.js';
import type { ParsedItem, ParsedMessage } from './parser.js';
import type { SplitMessage } from './splitter.js';
import {
  validateDraft,
  type AmendmentDraft,
  type CancellationDraft,
  type Draft,
  type DraftCustomer,
  type DraftItem,
  type DraftMessage,
  type MessageDraft,
  type OrderDraft,
  type TargetOrder,
} from './drafts.js';

/**
 * Amendment Analyst + conversation context.
 * Walks each sender's messages in order, keeping the "current" order in
 * mind, so "Actually make that 3kg" changes the order instead of creating
 * a second one. Anything it cannot place with certainty becomes an issue.
 */
export interface InterpretedMessage {
  split: SplitMessage;
  parsed: ParsedMessage;
  engine: 'rules' | 'claude';
}

export interface AnalysisResult {
  drafts: Draft[];
  messageDraft: Map<number, number>; // message index → draft position
}

const OPEN_FOR_AMEND = ['review', 'needs_clarification', 'confirmed', 'cutting', 'cut', 'packing', 'packed', 'ready', 'on_hold'];

export function openOrdersFor(customerId: string): TargetOrder[] {
  const orders = db()
    .prepare(`SELECT id, order_number, status, requested_date FROM orders WHERE customer_id = ? AND status IN (${OPEN_FOR_AMEND.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 10`)
    .all(customerId, ...OPEN_FOR_AMEND) as any[];
  return orders.map((o) => ({
    order_id: o.id,
    order_number: o.order_number,
    status: o.status,
    requested_date: o.requested_date,
    items: (
      db()
        .prepare(
          `SELECT i.id, i.product_id, i.qty_kind, i.count, i.weight_g, i.preparation_label, p.canonical_name, p.piece_noun
           FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ? AND i.status = 'active' ORDER BY i.sort_order`,
        )
        .all(o.id) as any[]
    ).map((i) => {
      const qty: Qty = { kind: i.qty_kind, count: i.count, weight_g: i.weight_g };
      return { id: i.id, product_id: i.product_id, product_name: i.canonical_name, piece_noun: i.piece_noun, qty, label: `${i.canonical_name} — ${formatQty(qty, i.piece_noun)}${i.preparation_label ? ` (${i.preparation_label})` : ''}` };
    }),
  }));
}

function historyProducts(customerId: string): { product_id: string; name: string; piece_noun: string; last_qty: Qty }[] {
  const rows = db()
    .prepare(
      `SELECT i.product_id, p.canonical_name, p.piece_noun, i.qty_kind, i.count, i.weight_g, MAX(o.created_at) last
       FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
       WHERE o.customer_id = ? AND o.status != 'cancelled' AND i.status = 'active'
       GROUP BY i.product_id ORDER BY last DESC LIMIT 12`,
    )
    .all(customerId) as any[];
  return rows.map((r) => ({ product_id: r.product_id, name: r.canonical_name, piece_noun: r.piece_noun, last_qty: { kind: r.qty_kind, count: r.count, weight_g: r.weight_g } }));
}

function resolveCustomer(sender: string | null, phone: string | null, email: string | null): DraftCustomer {
  if (!sender && !phone && !email) return { name: null, phone: null, email: null, match: 'unknown', customer_id: null };
  const m = matchCustomer({ name: sender, phone, email });
  const base = { name: sender ?? null, phone, email };
  switch (m.status) {
    case 'matched':
      return { ...base, name: base.name ?? m.customer.name, match: 'matched', via: m.via, customer_id: m.customer.id, customer_name: m.customer.name };
    case 'probable':
      return { ...base, match: 'probable', via: m.via, customer_id: m.customer.id, customer_name: m.customer.name };
    case 'ambiguous':
      return { ...base, match: 'ambiguous', customer_id: null, candidates: m.candidates.map((c) => ({ id: c.id, name: c.name, phone: c.phone })) };
    default:
      return { ...base, name: base.name ?? (phone ? phone : null), match: sender || phone ? 'new' : 'unknown', customer_id: null };
  }
}

export function toDraftItem(pi: ParsedItem, reference = false): DraftItem {
  const m = pi.match;
  return {
    key: pi.key,
    product_id: m.product?.id ?? null,
    product_name: m.product?.name ?? null,
    qty: pi.qty,
    preparation: { ...m.preparation },
    preparation_label: '',
    special_instructions: pi.instructions,
    source_text: pi.source_text,
    phrase: pi.phrase,
    match: m.status === 'matched' ? 'exact' : m.status === 'fuzzy' ? 'fuzzy' : 'unknown',
    qty_ambiguous: pi.qtyAmbiguous,
    suggestions: m.suggestions,
    ai_suggestion: pi.aiSuggestion ?? null,
    reference: reference && !m.product,
    history: [],
    pending_replacement: null,
  };
}

function dmsg(im: InterpretedMessage): DraftMessage {
  return { index: im.split.index, text: im.split.text, sender: im.split.sender, sent_at: im.split.sentAt, intent: im.parsed.intent, direction: im.split.direction, engine: im.engine };
}

function nounTokens(s: string) {
  return normalise(s).split(' ').filter(Boolean);
}

interface ConvState {
  key: string;
  customer: DraftCustomer;
  current: OrderDraft | null;
  lastItemKeys: string[]; // items touched by the most recent customer message
  targets: TargetOrder[] | null;
}

export interface AnalyseOptions {
  /** People on the Terram team: when they post in a group chat, they're not the customer. */
  teamNames?: string[];
}

export function teamNamesFromDb(): string[] {
  return (db().prepare('SELECT name FROM users WHERE active = 1').all() as { name: string }[]).map((u) => u.name);
}

export function analyse(messages: InterpretedMessage[], dict: Dictionary, today: string, opts: AnalyseOptions = {}): AnalysisResult {
  const team = new Set((opts.teamNames ?? []).map((n) => normalise(n)).filter(Boolean));
  const drafts: Draft[] = [];
  const messageDraft = new Map<number, number>();
  const convs = new Map<string, ConvState>();
  let lastInbound: ConvState | null = null;

  const convFor = (im: InterpretedMessage): ConvState => {
    const s = im.split;
    // Whose order is it? A name written in the message wins (group-chat posts on a customer's
    // behalf); otherwise the sender — unless the sender is on the Terram team.
    const senderIsTeam = !!s.sender && team.has(normalise(s.sender));
    const named = im.parsed.customerName;
    const who = named ?? (senderIsTeam ? null : s.sender);
    const phone = im.parsed.phone ?? (named || senderIsTeam ? null : s.senderPhone);
    const key = named ? `n:${normalise(named)}` : phone ? `p:${phone}` : who ? `n:${normalise(who)}` : `u:${s.index}`;
    let c = convs.get(key);
    if (!c) {
      c = { key, customer: resolveCustomer(who, phone, im.parsed.email), current: null, lastItemKeys: [], targets: null };
      convs.set(key, c);
    } else if (!c.customer.phone && phone) {
      c.customer = resolveCustomer(s.sender, phone, im.parsed.email);
    }
    return c;
  };
  const targetsFor = (c: ConvState) => {
    if (c.targets) return c.targets;
    c.targets = c.customer.customer_id && (c.customer.match === 'matched' || c.customer.match === 'probable') ? openOrdersFor(c.customer.customer_id) : [];
    return c.targets;
  };
  const addDraft = (d: Draft, im: InterpretedMessage) => {
    drafts.push(d);
    messageDraft.set(im.split.index, drafts.length - 1);
    return d;
  };
  const newOrderDraft = (c: ConvState, im: InterpretedMessage): OrderDraft => {
    const p = im.parsed;
    const d: OrderDraft = {
      kind: 'order',
      customer: { ...c.customer },
      items: p.items.map((i) => toDraftItem(i, p.flags.reference)),
      fulfilment: { type: p.fulfilment.type, date: p.fulfilment.date, time_window: p.fulfilment.time_window, address: p.fulfilment.address },
      notes: [...p.notes],
      messages: [dmsg(im)],
      issues: [],
      acks: [],
      confidence: 'high',
      events: [],
      duplicate_of: null,
    };
    if (p.flags.reference && c.customer.customer_id) attachHistorySuggestions(d.items, c.customer.customer_id);
    return d;
  };

  for (const im of messages) {
    const s = im.split;
    const p = im.parsed;

    // Outbound (Terram's own replies) are context only
    if (s.direction === 'out') {
      // Replies go with the customer they name ("Sure David"), otherwise the last person who wrote
      const words = new Set(normalise(s.text).split(' '));
      const named = [...convs.values()].find((cv) => cv.customer.name && words.has(normalise(cv.customer.name).split(' ')[0]));
      const c = named ?? lastInbound;
      if (c?.current) c.current.messages.push(dmsg(im));
      continue;
    }
    const c = convFor(im);
    lastInbound = c;

    switch (p.intent) {
      case 'chatter': {
        const d: MessageDraft = { kind: 'ignored', intent: 'chatter', attention: false, customer: { ...c.customer }, messages: [dmsg(im)], issues: [], acks: [], confidence: 'high', notes: [] };
        addDraft(d, im);
        break;
      }
      case 'question':
      case 'unknown':
      case 'customer_info':
      case 'clarification': {
        if (p.intent === 'clarification' && c.current) {
          c.current.notes.push(...p.notes);
          c.current.messages.push(dmsg(im));
          messageDraft.set(s.index, drafts.indexOf(c.current));
          break;
        }
        if (p.intent === 'customer_info') {
          if (p.phone) c.customer.phone = p.phone;
          if (p.email) c.customer.email = p.email;
          if (c.current) {
            c.current.customer.phone ??= p.phone;
            c.current.customer.email ??= p.email;
            c.current.messages.push(dmsg(im));
            messageDraft.set(s.index, drafts.indexOf(c.current));
            break;
          }
        }
        const d: MessageDraft = {
          kind: 'ignored',
          intent: p.intent,
          attention: p.intent === 'question' || p.intent === 'unknown',
          customer: { ...c.customer },
          messages: [dmsg(im)],
          issues: [],
          acks: [],
          confidence: p.intent === 'unknown' ? 'low' : 'high',
          notes: p.notes,
        };
        addDraft(d, im);
        break;
      }
      case 'fulfilment_info': {
        if (c.current) {
          mergeFulfilment(c.current, p);
          c.current.messages.push(dmsg(im));
          messageDraft.set(s.index, drafts.indexOf(c.current));
          break;
        }
        const target = targetsFor(c)[0] ?? null;
        const d: AmendmentDraft = {
          kind: 'amendment',
          customer: { ...c.customer },
          target,
          changes: [{ op: 'set_fulfilment', fulfilment: cleanFulfilment(p) }],
          messages: [dmsg(im)],
          issues: [],
          acks: [],
          confidence: 'medium',
          notes: [],
        };
        addDraft(d, im);
        break;
      }
      case 'cancellation': {
        if (c.current) {
          c.current.pending_cancellation = true;
          c.current.messages.push(dmsg(im));
          messageDraft.set(s.index, drafts.indexOf(c.current));
          break;
        }
        const d: CancellationDraft = { kind: 'cancellation', customer: { ...c.customer }, target: targetsFor(c)[0] ?? null, messages: [dmsg(im)], issues: [], acks: [], confidence: 'low', notes: [] };
        addDraft(d, im);
        break;
      }
      case 'new_order': {
        const cur = c.current;
        const differentDate = cur && p.fulfilment.date && cur.fulfilment.date && p.fulfilment.date !== cur.fulfilment.date;
        // The same lines sent again (a re-send or a double paste) — flag, never fold in silently
        const identical =
          cur &&
          p.items.length > 1 &&
          p.items.every((pi) => cur.items.some((di) => di.product_id && di.product_id === pi.match.product?.id && di.qty && pi.qty && qtyEquals(di.qty, pi.qty)));
        if (!cur || differentDate || identical || (!p.flags.addition && cur.messages.length > 0 && isFreshOrder(cur, im))) {
          const d = newOrderDraft(c, im);
          addDraft(d, im);
          c.current = d;
          c.lastItemKeys = d.items.map((i) => i.key);
          break;
        }
        // Same conversation, more items: fold in, flagging contradictions rather than doubling up
        const touched: string[] = [];
        for (const pi of p.items) {
          const incoming = toDraftItem(pi, p.flags.reference);
          if (incoming.reference && !incoming.product_id) {
            incoming.suggestions = referenceSuggestions(incoming, cur.items, c.customer.customer_id);
            cur.items.push(incoming);
            touched.push(incoming.key);
            continue;
          }
          const same = incoming.product_id ? cur.items.filter((i) => i.product_id === incoming.product_id) : [];
          if (same.length === 1 && incoming.qty && same[0].qty && !qtyEquals(same[0].qty, incoming.qty) && !p.flags.addition) {
            same[0].pending_replacement = { qty: incoming.qty, source_text: incoming.source_text, message_index: s.index };
            touched.push(same[0].key);
          } else if (same.length === 1 && incoming.qty && same[0].qty && qtyEquals(same[0].qty, incoming.qty)) {
            touched.push(same[0].key); // repeated line — nothing to add
          } else {
            cur.items.push(incoming);
            touched.push(incoming.key);
          }
        }
        mergeFulfilment(cur, p);
        cur.notes.push(...p.notes);
        cur.messages.push(dmsg(im));
        messageDraft.set(s.index, drafts.indexOf(cur));
        c.lastItemKeys = touched;
        break;
      }
      case 'amendment': {
        if (c.current) {
          applyInBatchAmendment(c, c.current, im);
          messageDraft.set(s.index, drafts.indexOf(c.current));
        } else {
          addDraft(buildAmendmentDraft(c, im, targetsFor(c)), im);
        }
        break;
      }
    }
  }

  const validated: Draft[] = [];
  for (const d of drafts) validated.push(validateDraft(d, { today, previousDrafts: validated }));
  return { drafts: validated, messageDraft };
}

/** A new message with a different set of products, well after the last one, is a new order. */
function isFreshOrder(cur: OrderDraft, im: InterpretedMessage): boolean {
  const last = cur.messages[cur.messages.length - 1];
  if (last?.sent_at && im.split.sentAt) {
    const gapH = (Date.parse(im.split.sentAt) - Date.parse(last.sent_at)) / 3600_000;
    if (gapH > 12) return true;
  }
  return false;
}

function cleanFulfilment(p: ParsedMessage) {
  const f: Record<string, unknown> = {};
  if (p.fulfilment.type) f.type = p.fulfilment.type;
  if (p.fulfilment.date) f.date = p.fulfilment.date;
  if (p.fulfilment.time_window) f.time_window = p.fulfilment.time_window;
  if (p.fulfilment.address) f.address = p.fulfilment.address;
  return f;
}

function mergeFulfilment(d: OrderDraft, p: ParsedMessage) {
  const f = p.fulfilment;
  if (f.type) d.fulfilment.type = f.type;
  if (f.date) {
    if (d.fulfilment.date && d.fulfilment.date !== f.date) d.events.push({ summary: `Date changed ${d.fulfilment.date} → ${f.date}`, message_index: -1 });
    d.fulfilment.date = f.date;
  }
  if (f.time_window) d.fulfilment.time_window = f.time_window;
  if (f.address) d.fulfilment.address = f.address;
}

/** For "those steaks": products already in this conversation first, then order history. */
function referenceSuggestions(item: DraftItem, current: DraftItem[], customerId: string | null) {
  const words = nounTokens(item.phrase);
  const inConv = current.filter((i) => i.product_id);
  // "those steaks" → only products that are steaks (by name, piece noun or an alias)
  const related = inConv.filter((i) => {
    const p = i.product_id ? getProduct(i.product_id) : undefined;
    if (!p) return false;
    const vocab = new Set([...nounTokens(p.canonical_name), ...nounTokens(p.piece_noun), ...p.aliases.flatMap((a) => a.alias.split(' '))]);
    return words.some((w) => vocab.has(w));
  });
  const out = (related.length ? related : inConv).map((i) => ({ product_id: i.product_id!, name: i.product_name ?? '' }));
  if (customerId) {
    const tmp: DraftItem[] = [{ ...item, suggestions: [] }];
    attachHistorySuggestions(tmp, customerId);
    for (const s of tmp[0].suggestions) if (!out.some((o) => o.product_id === s.product_id)) out.push(s);
  }
  return out.slice(0, 6);
}

function attachHistorySuggestions(items: DraftItem[], customerId: string) {
  const hist = historyProducts(customerId);
  for (const it of items) {
    if (it.product_id || !it.reference) continue;
    const words = nounTokens(it.phrase);
    const related = hist.filter((h) => words.some((w) => normalise(h.piece_noun) === w || nounTokens(h.name).includes(w)));
    const opts = (related.length ? related : hist).slice(0, 5).map((h) => ({ product_id: h.product_id, name: `${h.name} (last: ${formatQty(h.last_qty, h.piece_noun)})` }));
    if (opts.length) it.suggestions = opts;
  }
}

/** Items a quantity-only message ("make that 3") could refer to, narrowed by unit. */
function candidatesForBare(items: { key?: string; id?: string; qty: Qty | null; product_id: string | null }[], qty: Qty) {
  return items.filter((i) => {
    if (!i.product_id) return false;
    if (qty.kind === 'weight') return i.qty?.kind !== 'count';
    if (qty.kind === 'count') return i.qty?.kind !== 'weight' || i.qty == null;
    return true;
  });
}

/**
 * "Make the mince 3kg" when the order already has exactly one mince: a word that is
 * ambiguous on its own ("mince" → Lean or 80:20) means the one already in the conversation.
 */
function resolveFromConversation(incoming: DraftItem, pi: { match: { suggestions: { product_id: string; name: string }[] } }, inOrder: { product_id: string | null; product_name?: string | null }[]) {
  if (incoming.product_id) return;
  const ids = new Set(pi.match.suggestions.map((x) => x.product_id));
  const hits = [...new Map(inOrder.filter((i) => i.product_id && ids.has(i.product_id)).map((i) => [i.product_id!, i])).values()];
  if (hits.length !== 1) return;
  incoming.product_id = hits[0].product_id;
  incoming.product_name = hits[0].product_name ?? pi.match.suggestions.find((x) => x.product_id === hits[0].product_id)?.name ?? null;
  incoming.match = 'fuzzy';
  incoming.suggestions = [];
  incoming.reference = false;
}

function applyInBatchAmendment(c: ConvState, d: OrderDraft, im: InterpretedMessage) {
  const p = im.parsed;
  const s = im.split;
  d.messages.push(dmsg(im));
  const note = (summary: string) => d.events.push({ summary, message_index: s.index });
  const touched: string[] = [];
  for (const pi of p.items) {
    const incoming = toDraftItem(pi, p.flags.reference);
    resolveFromConversation(incoming, pi, d.items);
    if (!incoming.product_id) {
      // "4 of those steaks" style reference inside an amendment
      incoming.reference = true;
      d.items.push(incoming);
      touched.push(incoming.key);
      continue;
    }
    const same = d.items.filter((i) => i.product_id === incoming.product_id);
    if (pi.op === 'remove') {
      for (const it of same) {
        d.items = d.items.filter((x) => x !== it);
        note(`Removed ${it.product_name} (“${s.text}”)`);
      }
      continue;
    }
    if (same.length === 1) {
      const it = same[0];
      const from = it.qty;
      if (incoming.qty && (!from || !qtyEquals(from, incoming.qty))) {
        it.history = [...(it.history ?? []), { from, to: incoming.qty, summary: `“${s.text}”`, message_index: s.index }];
        it.qty = incoming.qty;
        it.pending_replacement = null;
        note(`${it.product_name}: ${from ? formatQty(from) : '—'} → ${formatQty(incoming.qty)} (amended by “${s.text}”)`);
      }
      for (const [g, v] of Object.entries(incoming.preparation)) it.preparation[g] = v;
      touched.push(it.key);
    } else if (same.length === 0) {
      d.items.push(incoming);
      note(`Added ${incoming.product_name} (“${s.text}”)`);
      touched.push(incoming.key);
    } else {
      d.items.push({ ...incoming, product_id: null, reference: true, suggestions: same.map((x) => ({ product_id: x.product_id!, name: x.product_name ?? '' })) });
    }
  }
  for (const bq of p.bareQuantities) {
    const pool = c.lastItemKeys.length ? d.items.filter((i) => c.lastItemKeys.includes(i.key)) : d.items;
    let cands = candidatesForBare(pool, bq.qty);
    if (!cands.length) cands = candidatesForBare(d.items, bq.qty);
    if (cands.length === 1) {
      const it = cands[0] as DraftItem;
      const from = it.qty;
      it.history = [...(it.history ?? []), { from, to: bq.qty, summary: `“${s.text}”`, message_index: s.index }];
      it.qty = bq.qty;
      note(`${it.product_name}: ${from ? formatQty(from) : '—'} → ${formatQty(bq.qty)} (amended by “${s.text}”)`);
      touched.push(it.key);
    } else {
      // Can't tell which item — park it as an unresolved reference
      d.items.push({
        key: `r${s.index}`,
        product_id: null,
        product_name: null,
        qty: bq.qty,
        preparation: {},
        preparation_label: '',
        special_instructions: null,
        source_text: s.text,
        phrase: s.text,
        match: 'unknown',
        suggestions: ((cands.length ? cands : d.items) as DraftItem[]).filter((x) => x.product_id).map((x) => ({ product_id: x.product_id!, name: x.product_name ?? '' })),
        reference: true,
        history: [],
      });
    }
  }
  mergeFulfilment(d, p);
  if (touched.length) c.lastItemKeys = touched;
}

function buildAmendmentDraft(c: ConvState, im: InterpretedMessage, targets: TargetOrder[]): AmendmentDraft {
  const p = im.parsed;
  const productIds = p.items.map((i) => i.match.product?.id).filter(Boolean) as string[];
  const target = targets.find((t) => productIds.length && t.items.some((i) => productIds.includes(i.product_id))) ?? targets[0] ?? null;
  const d: AmendmentDraft = { kind: 'amendment', customer: { ...c.customer }, target, changes: [], messages: [dmsg(im)], issues: [], acks: [], confidence: 'high', notes: [], reference: null };
  if (!target) return d;
  for (const pi of p.items) {
    const incoming = toDraftItem(pi, p.flags.reference);
    resolveFromConversation(incoming, pi, target.items);
    if (!incoming.product_id) {
      d.reference = {
        qty: incoming.qty,
        source_text: incoming.source_text,
        options: target.items.map((i) => ({ item_id: i.id, label: i.label })),
      };
      continue;
    }
    const same = target.items.filter((i) => i.product_id === incoming.product_id);
    if (pi.op === 'remove') {
      for (const it of same) d.changes.push({ op: 'remove', item_id: it.id, label: it.label });
      if (!same.length) d.notes.push(`${incoming.product_name} is not on order #${target.order_number}.`);
      continue;
    }
    if (same.length === 1 && incoming.qty) {
      if (!qtyEquals(same[0].qty, incoming.qty) || Object.keys(incoming.preparation).length) {
        d.changes.push({ op: 'set_qty', item_id: same[0].id, label: same[0].product_name, product_id: same[0].product_id, from: same[0].qty, to: incoming.qty, preparation: Object.keys(incoming.preparation).length ? incoming.preparation : undefined });
      }
    } else if (same.length === 0) {
      d.changes.push({ op: 'add', item: incoming });
    } else {
      d.reference = { qty: incoming.qty, source_text: incoming.source_text, options: same.map((i) => ({ item_id: i.id, label: i.label })) };
    }
  }
  for (const bq of p.bareQuantities) {
    const cands = candidatesForBare(target.items.map((i) => ({ ...i, key: i.id })), bq.qty) as TargetOrder['items'];
    if (cands.length === 1) {
      d.changes.push({ op: 'set_qty', item_id: cands[0].id, label: cands[0].product_name, product_id: cands[0].product_id, from: cands[0].qty, to: bq.qty });
      d.confidence = 'medium';
    } else {
      d.reference = { qty: bq.qty, source_text: im.split.text, options: (cands.length ? cands : target.items).map((i) => ({ item_id: i.id, label: i.label })) };
    }
  }
  if (p.fulfilment.date || p.fulfilment.type || p.fulfilment.address) d.changes.push({ op: 'set_fulfilment', fulfilment: cleanFulfilment(p) });
  return d;
}

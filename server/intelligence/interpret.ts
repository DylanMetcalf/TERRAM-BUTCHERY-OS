import { validateQty, type Qty } from '../../shared/quantity.js';
import { aiAvailable, interpretWithClaude, AI_ENGINE_VERSION, type AiInterpretation } from './ai.js';
import { matchProduct, type Dictionary } from './matcher.js';
import { nextKey, parseMessage, type ParsedItem, type ParsedMessage } from './parser.js';
import type { SplitMessage } from './splitter.js';
import type { InterpretedMessage } from './analyser.js';

export const RULES_ENGINE_VERSION = 'rules/1';

export interface InterpretationRecord {
  engine: 'rules' | 'claude';
  model: string | null;
  version: string;
  output: unknown;
  latencyMs: number;
  error?: string;
}

export interface Interpreted extends InterpretedMessage {
  records: InterpretationRecord[];
}

/** Does the rules result leave anything a person would have to puzzle over? */
export function needsAssistance(p: ParsedMessage): boolean {
  if (p.intent === 'chatter') return false;
  if (p.intent === 'unknown') return true;
  if (p.unparsed.length) return true;
  if (p.items.some((i) => !i.match.product || i.match.status !== 'matched' || !i.qty)) return true;
  if (p.bareQuantities.length && p.flags.reference) return true;
  return false;
}

/** Converts assistant output into the same shape as the rules engine, re-validated deterministically. */
export function fromAi(ai: AiInterpretation, rules: ParsedMessage, dict: Dictionary): ParsedMessage {
  const items: ParsedItem[] = [];
  const bare: ParsedMessage['bareQuantities'] = [];
  for (const it of ai.items) {
    const qty = aiQty(it);
    const phrase = it.refers_to && it.operation === 'set' && !matchProduct(it.phrase, dict).product ? it.refers_to : it.phrase;
    const match = matchProduct(phrase, dict);
    const guess = it.product_id ? dict.byId.get(it.product_id) : undefined;
    let aiSuggestion: ParsedItem['aiSuggestion'] = null;
    if (!match.product && guess && guess.active) {
      aiSuggestion = { product_id: guess.id, name: guess.name, preparation: validPrep(guess, it.preparation), reason: ai.explanation };
    }
    if (!phrase.trim() && qty) {
      bare.push({ qty, source_text: it.phrase || '' });
      continue;
    }
    const prep = match.product ? { ...match.preparation, ...validPrep(match.product, it.preparation) } : {};
    if (qty && match.product) {
      const problem = validateQty(qty, match.product.product.quantity_type, match.product.product.allows_portions);
      if (problem) {
        items.push({ key: nextKey(), source_text: it.phrase, qty, qtyAmbiguous: true, match: { ...match, preparation: prep }, phrase, instructions: it.instructions, op: it.operation, aiSuggestion });
        continue;
      }
    }
    items.push({
      key: nextKey(),
      source_text: it.phrase,
      qty,
      qtyAmbiguous: false,
      match: { ...match, preparation: prep },
      phrase,
      instructions: it.instructions ?? (match.leftover.length ? match.leftover.join(' ') : null),
      op: it.operation === 'set' ? 'set' : it.operation === 'remove' ? 'remove' : 'add',
      aiSuggestion,
    });
  }
  const fulfilment = {
    type: ai.fulfilment.type === 'unknown' ? rules.fulfilment.type : ai.fulfilment.type,
    date: /^\d{4}-\d{2}-\d{2}$/.test(ai.fulfilment.date ?? '') ? ai.fulfilment.date : rules.fulfilment.date,
    dateText: rules.fulfilment.dateText,
    time_window: ai.fulfilment.time_window ?? rules.fulfilment.time_window,
    address: ai.fulfilment.address ?? rules.fulfilment.address,
  };
  // Rules-engine date wins when both exist: it is deterministic and auditable
  if (rules.fulfilment.date) fulfilment.date = rules.fulfilment.date;
  const intent = ai.intent === 'amendment' || ai.intent === 'cancellation' ? ai.intent : items.length ? (rules.intent === 'amendment' ? 'amendment' : ai.intent === 'new_order' ? 'new_order' : ai.intent) : ai.intent;
  return {
    ...rules,
    intent,
    items,
    bareQuantities: bare.length ? bare : rules.bareQuantities,
    fulfilment,
    notes: ai.notes ? [...rules.notes, ai.notes] : rules.notes,
    unparsed: [],
    signals: [...rules.signals, `assistant:${ai.confidence}`],
  };
}

function aiQty(it: AiInterpretation['items'][number]): Qty | null {
  const count = it.count != null && Number.isFinite(it.count) ? Math.round(it.count) : null;
  const grams = it.weight_grams != null && Number.isFinite(it.weight_grams) ? Math.round(it.weight_grams) : null;
  if (it.quantity_kind === 'weight' && grams && grams > 0) return { kind: 'weight', count: null, weight_g: grams };
  if (it.quantity_kind === 'count' && count && count > 0) return { kind: 'count', count, weight_g: null };
  if (it.quantity_kind === 'portions' && count && grams && count > 0 && grams > 0) return { kind: 'portions', count, weight_g: grams };
  return null;
}

function validPrep(p: NonNullable<ReturnType<Dictionary['byId']['get']>>, sel: { group: string; option: string }[]) {
  const out: Record<string, string> = {};
  for (const s of sel ?? []) {
    const opt = p.preps.find((o) => o.group.toLowerCase() === s.group.toLowerCase() && o.name.toLowerCase() === s.option.toLowerCase());
    if (opt) out[opt.group] = opt.name;
  }
  return out;
}

/**
 * Interprets each message: rules first; the assistant only for messages the
 * rules could not fully understand, with conversation context.
 */
export async function interpretAll(split: SplitMessage[], dict: Dictionary, opts: { useAi?: boolean } = {}): Promise<Interpreted[]> {
  const useAi = (opts.useAi ?? true) && aiAvailable();
  const out: Interpreted[] = split.map((s) => {
    const started = Date.now();
    const parsed = s.direction === 'out' ? ({ ...parseMessage('', s.refDate, dict), intent: 'chatter' } as ParsedMessage) : parseMessage(s.text, s.refDate, dict);
    return {
      split: s,
      parsed,
      engine: 'rules' as const,
      records: [{ engine: 'rules' as const, model: null, version: RULES_ENGINE_VERSION, output: summarise(parsed), latencyMs: Date.now() - started }],
    };
  });
  if (!useAi) return out;
  const queue = out.filter((m) => m.split.direction === 'in' && needsAssistance(m.parsed));
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const context = out
        .filter((o) => o.split.index < m!.split.index && (o.split.sender === m!.split.sender || o.split.direction === 'out'))
        .slice(-6)
        .map((o) => `${o.split.direction === 'out' ? 'Terram' : o.split.sender ?? 'Customer'}: ${o.split.text}`);
      const r = await interpretWithClaude(m.split.text, context, m.split.refDate, dict);
      m.records.push({ engine: 'claude', model: r.model, version: AI_ENGINE_VERSION, output: r.result, latencyMs: r.latencyMs, error: r.error });
      if (r.result) {
        m.parsed = fromAi(r.result, m.parsed, dict);
        m.engine = 'claude';
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

/** Serializable summary of a parse for the interpretation log. */
export function summarise(p: ParsedMessage) {
  return {
    intent: p.intent,
    items: p.items.map((i) => ({
      text: i.source_text,
      product_id: i.match.product?.id ?? null,
      product: i.match.product?.name ?? null,
      match: i.match.status,
      qty: i.qty,
      preparation: i.match.preparation,
      op: i.op,
      suggestions: i.match.suggestions.map((s) => s.name),
      ai_suggestion: i.aiSuggestion?.name ?? null,
    })),
    bare_quantities: p.bareQuantities,
    fulfilment: p.fulfilment,
    notes: p.notes,
    flags: Object.entries(p.flags).filter(([, v]) => v).map(([k]) => k),
    unparsed: p.unparsed,
  };
}

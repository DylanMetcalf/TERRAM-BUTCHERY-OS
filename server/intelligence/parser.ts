import type { Qty } from '../../shared/quantity.js';
import { normalise, normalisePhone } from '../../shared/text.js';
import { extractDate, extractTimeWindow } from './dates.js';
import { matchProduct, type Dictionary, type MatchResult } from './matcher.js';
import { extractQuantity, preprocess } from './quantity.js';

/**
 * Message Classifier + Order Analyst (rules engine).
 * Turns one message into a structured, *unvalidated* interpretation.
 * Validation against business rules happens later in the engine.
 */
export type Intent =
  | 'new_order'
  | 'amendment'
  | 'cancellation'
  | 'clarification'
  | 'question'
  | 'fulfilment_info'
  | 'customer_info'
  | 'chatter'
  | 'unknown';

export const INTENT_LABEL: Record<Intent, string> = {
  new_order: 'New order',
  amendment: 'Order amendment',
  cancellation: 'Cancellation',
  clarification: 'Clarification',
  question: 'Customer question',
  fulfilment_info: 'Collection / delivery info',
  customer_info: 'Customer information',
  chatter: 'General chat',
  unknown: 'Unclear',
};

export interface ParsedItem {
  key: string;
  source_text: string;
  qty: Qty | null;
  qtyAmbiguous: boolean;
  match: MatchResult;
  /** The phrase the matcher saw (for unknown products and learning). */
  phrase: string;
  instructions: string | null;
  /** Amendment op hint derived from the wording. */
  op: 'add' | 'set' | 'remove' | 'none';
  /** Product the assistant thinks this is — a suggestion only, never applied automatically. */
  aiSuggestion?: { product_id: string; name: string; preparation?: Record<string, string>; reason?: string } | null;
}

export interface ParsedMessage {
  intent: Intent;
  items: ParsedItem[];
  /** Quantity-only fragments like "make that 3" — need the conversation to resolve. */
  bareQuantities: { qty: Qty; source_text: string }[];
  fulfilment: { type: 'collection' | 'delivery' | null; date: string | null; dateText: string | null; time_window: string | null; address: string | null };
  phone: string | null;
  email: string | null;
  notes: string[];
  flags: { amendment: boolean; addition: boolean; removal: boolean; cancellation: boolean; reference: boolean; replacement: boolean; question: boolean };
  unparsed: string[];
  signals: string[];
}

const CHATTER_RE = /^(?:hi|hey|hello|hallo|howzit|morning|good morning|good afternoon|evening|thanks|thank you|thank u|thanx|thx|ty|cheers|ok|okay|k|great|perfect|awesome|shot|sharp|lekker|sure|cool|no problem|no worries|will do|see you|see you then|see you saturday|appreciate it|much appreciated|brilliant|fantastic|wonderful|amazing|yes|yes please|yep|yup|no|nope|noted|done|sounds good|got it|lovely|super|nice|excellent)(?:[\s,!.]+(?:so much|a lot|very much|thanks|thank you|again|guys|terram|team|mate|buddy|all|you|too|x+|:\)|:d))*[\s!.😊🙏👍❤️🙂👌🔥😀😁x]*$/iu;
const EMOJI_ONLY_RE = /^[\s\p{Extended_Pictographic}‍️!.]+$/u;
const LEAD_IN_RE = /^(?:(?:hi|hey|hello|hallo|howzit|morning|good morning|good afternoon|afternoon|evening)(?:\s+(?:there|guys|terram|team|all))?[\s,!.:-]*)?(?:(?:please\s+)?(?:can|could|may)\s+(?:i|we|you)\s+(?:please\s+)?(?:get|have|order|book|reserve|put aside|add|also get|also have)\s*(?:me\s*)?|i(?:'d| would)\s+like(?:\s+to\s+order)?\s*|we(?:'d| would)\s+like(?:\s+to\s+order)?\s*|(?:i|we)\s+(?:want|need|would like)(?:\s+to\s+order)?\s*|(?:please\s+)?(?:send|put aside|keep aside)\s+(?:me\s+)?|order\s*(?:for\s+me)?:?\s*|my order(?: is)?:?\s*|please\s+)?/i;
const AMEND_RE = /\b(?:actually|make\s+(?:that|it|those|them|this|these|the|my|mine)|change(?:\s+(?:that|it|the|my))?|instead|rather|correction|update|i meant|meant|sorry[, ]+(?:i meant|make|change|it'?s)|not\s+\d+(?:\s*kg)?\s*(?:but|,)|only\s+(?:need|want)|reduce|increase|up\s+it|bump\s+(?:it|that)|swap|replace)\b/i;
const ADD_RE = /^\s*(?:and|also|plus|oh and|oh also|oh|another thing|p\.?s\.?)\b|\b(?:add|also|as well|aswell|too|extra|another|in addition)\b/i;
const REMOVE_RE = /\b(?:remove|take\s+off|take\s+out|drop\s+the|no\s+more|don'?t\s+need|dont\s+need|do\s+not\s+need|skip\s+the|scrap\s+the|leave\s+out|without\s+the|cancel\s+the|forget\s+the|no\s+longer\s+need\s+the)\b/i;
const CANCEL_RE = /\b(?:cancel(?:led)?\s+(?:my|the|our|this|that)?\s*order|cancel\s+(?:it|everything|all)|please\s+cancel|want\s+to\s+cancel|need\s+to\s+cancel|no\s+longer\s+need\s+(?:it|the\s+order|my\s+order|anything)|don'?t\s+need\s+(?:it|the\s+order|anything)\s+any\s*more)\b/i;
const REFERENCE_RE = /\b(?:again|same\s+as\s+(?:last|before|usual|previous)|the\s+usual|my\s+usual|usual\s+order|last\s+(?:week|time)'?s?|those|these|them|that\s+one|the\s+same)\b/i;
const REPLACE_RE = /\b(?:instead\s+of|rather\s+than|replace|swap)\b/i;
const COLLECT_RE = /\b(?:collect(?:ion|ing|ed)?|pick\s*(?:ing\s*)?up|pickup|fetch(?:ing)?|pop(?:ping)?\s+in|come\s+(?:in|by|past)|swing\s+by|i'?ll\s+get\s+it)\b/i;
const DELIVER_RE = /\b(?:deliver(?:y|ed|ing)?|drop\s*(?:it\s*)?off|dropoff|bring\s+it|courier|send\s+it)\b/i;
const ADDRESS_RE = /\b(?:address\s*(?:is)?\s*:?|deliver(?:y|ed)?\s+(?:it\s+)?to|drop\s+(?:it\s+)?(?:off\s+)?at|send\s+(?:it\s+)?to)\s*:?\s*(.{6,})$/i;
const QUESTION_START_RE = /^(?:(?:hi|hey|hello|morning)[^,?]*,\s*)?(?:do|does|have|has|is|are|any|what|when|where|how|which|will you|would you|can you|could you|are you|is there|are there)\b/i;
const STREET_RE = /\b\d{1,5}[a-z]?\s+(?:[A-Za-z][\w'’-]*\s+){0,3}[A-Za-z]*(?:street|str|st|road|rd|avenue|ave|laan|straat|weg|drive|dr|lane|crescent|cres|close|way|place|boulevard|blvd|farm|plot|estate|park|rylaan|singel)\b\.?(?:\s*,\s*[A-Za-z][\w\s'’-]{2,40})?/i;
const PHONE_RE = /(?:\+|00)?\d[\d\s()-]{7,}\d/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const NOTE_RE = /^(?:note|notes|nb|n\.b\.|ps|p\.s\.|special instructions?|instructions?)\s*[:\-]\s*(.+)$/i;
const FILLER_AFTER_STRIP = /^(?:for|on|please|pls|thanks|thank you|by|at|in the|the|this|that|it|i|we|will|would|like|to|want|can|you|,|\.|!|-|\s|and|my|order|me|please\.)*$/i;

let keySeq = 0;
export const nextKey = () => `i${(++keySeq).toString(36)}`;

function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?;])\s+(?=\S)|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const QTY_START = /^(?:\d|a\s|an\s|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|a\s+dozen|dozen|couple)/i;

/** Split "2kg mince, 4 rumps and 2 ribeyes" only where the next chunk starts with a quantity. */
function splitItems(sentence: string): string[] {
  const parts = sentence.split(/\s*(?:,|\band\b|&|\+|\bplus\b|\/|\bwith\b)\s*/i);
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (out.length && !QTY_START.test(p.trim())) out[out.length - 1] += ', ' + p;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

export function isChatter(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return CHATTER_RE.test(t) || EMOJI_ONLY_RE.test(t);
}

export function parseMessage(text: string, refDate: string, dict: Dictionary): ParsedMessage {
  const result: ParsedMessage = {
    intent: 'unknown',
    items: [],
    bareQuantities: [],
    fulfilment: { type: null, date: null, dateText: null, time_window: null, address: null },
    phone: null,
    email: null,
    notes: [],
    flags: { amendment: false, addition: false, removal: false, cancellation: false, reference: false, replacement: false, question: false },
    unparsed: [],
    signals: [],
  };
  const whole = text.trim();
  if (!whole || isChatter(whole)) {
    result.intent = 'chatter';
    return result;
  }
  result.flags.amendment = AMEND_RE.test(whole);
  result.flags.addition = ADD_RE.test(whole);
  result.flags.removal = REMOVE_RE.test(whole);
  result.flags.cancellation = CANCEL_RE.test(whole);
  result.flags.reference = REFERENCE_RE.test(whole);
  result.flags.replacement = REPLACE_RE.test(whole);
  result.flags.question = /\?\s*$/.test(whole);

  const lines = whole.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const rawLine of lines) {
    let line = rawLine.replace(/^[-*•·>]+\s*/, '').replace(/^\d+[.)]\s+(?=\D)/, '');
    const email = EMAIL_RE.exec(line);
    if (email) {
      result.email = email[0].toLowerCase();
      line = line.replace(email[0], ' ');
    }
    const note = NOTE_RE.exec(line);
    if (note) {
      result.notes.push(note[1].trim());
      continue;
    }
    const addr = ADDRESS_RE.exec(line);
    if (addr) {
      result.fulfilment.type = 'delivery';
      const d = extractDate(addr[1], refDate);
      let address = addr[1];
      if (d.date) {
        result.fulfilment.date ??= d.date;
        result.fulfilment.dateText ??= d.matched;
        address = address.replace(new RegExp(`\\s*(?:on\\s+)?${escapeRe(d.matched!)}`, 'i'), '');
      }
      address = address.replace(/[.,!\s]*\b(?:thanks|thank you|thank u|cheers|thx|ta)\b.*$/i, '');
      result.fulfilment.address = address.replace(/[.,\s]+$/, '').trim();
      line = line.slice(0, addr.index);
    }
    const phone = PHONE_RE.exec(line);
    if (phone && normalisePhone(phone[0]) && !/\d\s*(?:kg|g|x)\b/i.test(phone[0])) {
      const digits = phone[0].replace(/\D/g, '');
      if (digits.length >= 9) {
        result.phone = normalisePhone(phone[0]);
        line = line.replace(phone[0], ' ');
      }
    }
    for (const sentence of splitSentences(line)) handleSentence(sentence, refDate, dict, result);
  }

  // Intent decision — deterministic and explainable
  const hasItems = result.items.length > 0;
  const asksAboutStock = QUESTION_START_RE.test(whole) && !result.items.some((i) => i.qty);
  if (result.flags.cancellation && !result.items.some((i) => i.match.product)) {
    result.intent = 'cancellation';
    result.notes = [];
  } else if (asksAboutStock) {
    result.intent = 'question';
  } else if (result.flags.amendment || result.flags.removal || (result.bareQuantities.length > 0 && !hasItems)) {
    result.intent = 'amendment';
  } else if (hasItems) {
    result.intent = 'new_order';
  } else if (result.fulfilment.type || result.fulfilment.date || result.fulfilment.address) {
    result.intent = 'fulfilment_info';
  } else if (result.flags.question) {
    result.intent = 'question';
  } else if (result.phone || result.email) {
    result.intent = 'customer_info';
  } else if (result.notes.length) {
    result.intent = 'clarification';
  } else {
    result.intent = 'unknown';
  }
  if (result.intent === 'new_order' && result.flags.addition) result.signals.push('addition');
  return result;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function handleSentence(sentence: string, refDate: string, dict: Dictionary, result: ParsedMessage) {
  let s = sentence
    .trim()
    .replace(/^(?:(?:hi|hey|hello|hallo|howzit)(?:\s+there)?[,!.]?\s*)?(?:good\s+)?(?:morning|afternoon|evening)(?:\s+(?:guys|all|team|terram|there))?\s*[,!.]\s*/i, '')
    .trim();
  if (!s || isChatter(s)) return;

  // Fulfilment & date — may share a sentence with items ("2kg mince for Saturday")
  const collect = COLLECT_RE.test(s);
  const deliver = DELIVER_RE.test(s);
  if (collect && !deliver) result.fulfilment.type ??= 'collection';
  if (deliver) result.fulfilment.type = 'delivery';
  const date = extractDate(s, refDate);
  if (date.date) {
    if (!result.fulfilment.date) {
      result.fulfilment.date = date.date;
      result.fulfilment.dateText = date.matched;
    }
    s = s.replace(new RegExp(`\\b(?:for|on|by|this|next|coming)?\\s*${escapeRe(date.matched!)}\\b`, 'i'), ' ');
  }
  const tw = extractTimeWindow(s);
  if (tw) {
    result.fulfilment.time_window ??= tw;
    s = s.replace(new RegExp(`\\b(?:at|around|by|after|before|from)?\\s*${escapeRe(tw)}`, 'i'), ' ');
  }
  s = s
    .replace(COLLECT_RE, ' ')
    .replace(DELIVER_RE, ' ')
    .replace(/\b(?:for|will|i'?ll|we'?ll|can|please|pls|to be)\s+(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || FILLER_AFTER_STRIP.test(s)) return;

  // A street address without "deliver to" ("7 Wilgerlaan, Vredefort")
  const street = STREET_RE.exec(s);
  if (street && !matchProduct(street[0].replace(/^\s*\d+[a-z]?\s+/i, ''), dict).product) {
    result.fulfilment.address ??= street[0].replace(/[.,\s]+$/, '').trim();
    s = (s.slice(0, street.index) + ' ' + s.slice(street.index + street[0].length)).replace(/\s+/g, ' ').trim();
    if (!s || FILLER_AFTER_STRIP.test(s)) return;
  }

  // Strip polite lead-ins and amendment wording, keep the substance
  s = s.replace(LEAD_IN_RE, '').trim();
  const opHint: ParsedItem['op'] = REMOVE_RE.test(s) ? 'remove' : AMEND_RE.test(s) ? 'set' : ADD_RE.test(s) ? 'add' : 'none';
  s = s
    .replace(/\b(?:actually|sorry|oops|correction|instead|rather|please|pls|plz|thanks|thank you|cheers|again)\b[,!.]?/gi, ' ')
    .replace(/\b(?:make|change|update|swap|replace|reduce|increase|bump|up)\s+(?:that|it|those|them|this|these|the|my|mine)?\s*(?:to|into)?\b/gi, ' ')
    .replace(/\b(?:i meant|meant|not\s+\d+\s*(?:kg|g)?\s*(?:but)?)\b/gi, ' ')
    .replace(/\b(?:only\s+need|only\s+want)\b/gi, ' ')
    .replace(REMOVE_RE, ' ')
    .replace(/^\s*(?:and|also|plus|oh and|oh|add|can you add|could you add|please add)\b/i, ' ')
    .replace(/\b(?:as well|aswell|too|in addition)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s:-]+|[,.\s!?:-]+$/g, '')
    .trim();
  if (!s) return;

  for (const chunk of splitItems(s)) {
    const q = extractQuantity(chunk);
    const phrase = q.rest
      .replace(/^(?:of|x)\s+/i, '')
      .replace(/\b(?:those|these|them|that|it|the|same|one|ones|lot)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const phraseTokens = normalise(phrase);
    if (!phraseTokens) {
      if (q.qty) result.bareQuantities.push({ qty: q.qty, source_text: chunk });
      continue;
    }
    const match = matchProduct(phrase, dict);
    if (match.status === 'unknown' && !q.qty && !match.suggestions.length) {
      // Probably not an item: an instruction or remark ("no fat please", "cut thick")
      if (applyGlobalPreparation(phrase, result)) continue;
      result.unparsed.push(chunk);
      continue;
    }
    const instructions = match.leftover.length && match.product ? leftoverInstruction(chunk, match) : null;
    result.items.push({
      key: nextKey(),
      source_text: chunk,
      qty: q.qty,
      qtyAmbiguous: q.ambiguous,
      match,
      phrase: preprocess(phrase).trim(),
      instructions,
      op: opHint,
    });
  }
}

/** Instructions like "vacuum pack everything" apply to every item that supports them. */
function applyGlobalPreparation(phrase: string, result: ParsedMessage): boolean {
  const n = normalise(phrase);
  if (!n) return false;
  const mentionsAll = /\b(?:all|everything|every|each)\b/.test(n);
  let applied = false;
  for (const item of result.items) {
    const p = item.match.product;
    if (!p) continue;
    for (const opt of p.preps) {
      if (opt.keywords.some((k) => (' ' + n + ' ').includes(' ' + k.join(' ') + ' '))) {
        if (!item.match.preparation[opt.group]) {
          item.match.preparation[opt.group] = opt.name;
          applied = true;
        }
      }
    }
  }
  if (applied) return true;
  if (mentionsAll || n.split(' ').length <= 6) {
    result.notes.push(phrase);
    return true;
  }
  return false;
}

function leftoverInstruction(chunk: string, match: MatchResult): string | null {
  const words = match.leftover.filter((w) => w.length > 1);
  if (!words.length) return null;
  return words.join(' ');
}

import type { Qty } from '../../shared/quantity.js';

/**
 * Deterministic quantity extraction. Understands "2kg", "2 kilos", "500g",
 * "half a kilo", "6 x 500g", "4 rumps", "rump x4", "a dozen", "one and a half kg".
 * It never converts weight to pieces or vice versa.
 */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

const KG = '(?:kg|kgs|kilo|kilos|kilogram|kilograms|kilogramme|kilogrammes|kgram)';
const G = '(?:g|gr|grams?|grammes?|gm|gms)';
const NUM = '(\\d+(?:[.,]\\d+)?)';

export interface QtyResult {
  qty: Qty | null;
  rest: string;
  matched: string | null;
  /** More than one plausible quantity was present — needs a human. */
  ambiguous: boolean;
}

function num(s: string): number {
  return Number(s.replace(',', '.'));
}

/**
 * "80:20 mince", "80/20 mince" and "80 20 mince" are a fat ratio, not a quantity or
 * two items. Rewritten to one token ("80to20") that no quantity rule reads as a number.
 */
export function protectRatios(text: string): string {
  return text.replace(/\b(\d{2})\s*[:/\s-]\s*(\d{2})(?=\s*(?:mince|minced|beef|ground)\b)/gi, '$1to$2');
}

/** Rewrites spoken quantities into digits so the regexes stay simple. */
export function preprocess(text: string): string {
  let t = ` ${protectRatios(text.toLowerCase())} `;
  t = t.replace(/[×✖]/g, ' x ');
  t = t.replace(/\b(\d+)\s*(?:and a half|&\s*a\s*half|½)\s*/g, (_, n) => `${Number(n) + 0.5} `);
  t = t.replace(/\b(one|a)\s+and\s+a\s+half\s+/g, '1.5 ');
  t = t.replace(/\b(two)\s+and\s+a\s+half\s+/g, '2.5 ');
  t = t.replace(/\bhalf\s+(?:a\s+)?(kg|kilo|kilogram)s?\b/g, '0.5 kg');
  t = t.replace(/\b1\/2\s*(kg|kilo)s?\b/g, '0.5 kg');
  t = t.replace(/\bquarter\s+(?:of\s+)?(?:a\s+)?(kg|kilo)s?\b/g, '0.25 kg');
  t = t.replace(/\b(?:a|one)\s+(kg|kilo|kilogram)s?\b/g, '1 kg');
  // Eggs come in trays of 30: "2 trays of eggs" → 60 eggs, "a tray of eggs" → 30
  t = t.replace(/\b(?:(\d+)\s+|(?:a|an|one)\s+)?trays?\s+(?:of\s+)?(?=(?:[a-z]+\s+)?eggs?\b)/g, (_, n) => `${(n ? Number(n) : 1) * 30} `);
  t = t.replace(/\bhalf\s+(?:a\s+)?dozen\b/g, '6');
  t = t.replace(/\b(?:a|one)\s+dozen\b/g, '12');
  t = t.replace(/\b(\d+)\s+dozen\b/g, (_, n) => String(Number(n) * 12));
  t = t.replace(/\b(twenty|thirty|forty|fifty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, a, b) => String(NUMBER_WORDS[a] + NUMBER_WORDS[b]));
  t = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\b/g, (w) => String(NUMBER_WORDS[w]));
  t = t.replace(/\ba couple(?: of)?\b/g, ' couple ');
  return t.replace(/\s+/g, ' ');
}

function strip(t: string, m: RegExpExecArray): string {
  return (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
}

const toGrams = (value: number, unit: string) => Math.round(new RegExp(`^${KG}$`).test(unit) ? value * 1000 : value);

export function extractQuantity(input: string): QtyResult {
  const t = preprocess(input);

  // 6 x 500g · 6x500g · 6 packs of 500g · 6 portions @ 500g
  let m = new RegExp(`\\b(\\d+)\\s*(?:x|\\*|packs?|portions?|packets?|bags?|pieces?)\\s*(?:of|@|x|at)?\\s*${NUM}\\s*(${KG}|${G})\\b`).exec(t);
  if (m) {
    return { qty: { kind: 'portions', count: Number(m[1]), weight_g: toGrams(num(m[2]), m[3]) }, rest: strip(t, m), matched: m[0].trim(), ambiguous: false };
  }
  // 500g x 6
  m = new RegExp(`${NUM}\\s*(${KG}|${G})\\s*(?:x|\\*)\\s*(\\d+)\\b`).exec(t);
  if (m) {
    return { qty: { kind: 'portions', count: Number(m[3]), weight_g: toGrams(num(m[1]), m[2]) }, rest: strip(t, m), matched: m[0].trim(), ambiguous: false };
  }
  // Weight: 2kg, 2 kilos, 1.5 kg, 500g, 500 grams
  const weightRe = new RegExp(`${NUM}\\s*(${KG}|${G})\\b`, 'g');
  const weights = [...t.matchAll(weightRe)];
  if (weights.length) {
    const w = weights[0] as unknown as RegExpExecArray;
    const grams = toGrams(num(w[1]), w[2]);
    const rest = strip(t, w);
    // e.g. "2 x 1kg" handled above; "2 packs 1kg" etc. would leave a stray count
    const stray = /\b\d+\b/.test(rest.replace(/\b\d+\s*(?:cm|mm)\b/g, ''));
    return { qty: { kind: 'weight', count: null, weight_g: grams }, rest, matched: w[0].trim(), ambiguous: weights.length > 1 || stray };
  }
  // Count forms: 4x rump · rump x4 · 4 rumps · rumps - 4 · 2 pieces
  m = /\b(\d+)\s*x\b/.exec(t) ?? /\bx\s*(\d+)\b/.exec(t);
  if (m) {
    return { qty: { kind: 'count', count: Number(m[1]), weight_g: null }, rest: strip(t, m), matched: m[0].trim(), ambiguous: false };
  }
  const counts = [...t.matchAll(/(?<![\d.,:/])\b(\d+(?:[.,]\d+)?)\b(?!\s*(?:cm|mm|am|pm|h\b|:|\/|th\b|st\b|nd\b|rd\b))/g)];
  if (counts.length) {
    const c = counts[0] as unknown as RegExpExecArray;
    const value = num(c[1]);
    let rest = strip(t, c);
    rest = rest.replace(/\b(?:pieces?|pcs?|units?|items?|packs?|packets?)\b/g, ' ').replace(/^\s*(?:of)\b/, '').replace(/\s+/g, ' ').trim();
    if (!Number.isInteger(value)) {
      // "1.5 mince" — a fractional number with no unit is ambiguous
      return { qty: null, rest, matched: c[0], ambiguous: true };
    }
    return { qty: { kind: 'count', count: value, weight_g: null }, rest, matched: c[0].trim(), ambiguous: counts.length > 1 };
  }
  if (/\bcouple\b/.test(t)) {
    return { qty: null, rest: t.replace(/\bcouple\b/, ' ').trim(), matched: 'a couple', ambiguous: true };
  }
  // "half a lamb", "half lamb" — one of a product sold as a half (the alias keeps the word "half")
  m = /^\s*half\s+(?:a\s+|an\s+)?(?=[a-z])/.exec(t);
  if (m) return { qty: { kind: 'count', count: 1, weight_g: null }, rest: `half ${t.slice(m[0].length)}`.trim(), matched: 'half', ambiguous: false };
  // "a whole chicken", "a leg of lamb", "an oxtail"
  m = /^\s*(?:a|an)\s+/.exec(t);
  if (m) return { qty: { kind: 'count', count: 1, weight_g: null }, rest: strip(t, m), matched: 'a', ambiguous: false };
  return { qty: null, rest: t.trim(), matched: null, ambiguous: false };
}

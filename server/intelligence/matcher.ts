import { fuzzyWordEqual, normalise } from '../../shared/text.js';
import type { Product } from '../domain/products.js';

/**
 * Product Matcher — maps customer language onto the canonical product
 * dictionary. Deterministic. It can suggest, but it never creates products:
 * anything it cannot place is returned as "unknown".
 */
export interface DictProduct {
  id: string;
  name: string;
  category: string;
  piece_noun: string;
  active: boolean;
  aliases: string[][]; // token arrays
  aliasStrings: string[];
  preps: { group: string; name: string; keywords: string[][]; is_default: boolean }[];
  product: Product;
}

export interface Dictionary {
  products: DictProduct[];
  byId: Map<string, DictProduct>;
}

export interface MatchResult {
  status: 'matched' | 'fuzzy' | 'unknown' | 'ambiguous';
  product: DictProduct | null;
  preparation: Record<string, string>;
  prepMatched: string[];
  leftover: string[];
  suggestions: { product_id: string; name: string }[];
  reason?: string;
}

const SPECIES = ['beef', 'lamb', 'mutton', 'pork', 'chicken', 'veal', 'venison', 'game', 'ostrich', 'fish', 'duck', 'turkey', 'goat'];
const STOP = new Set([
  'a', 'an', 'the', 'of', 'some', 'please', 'pls', 'plz', 'and', 'also', 'plus', 'for', 'me', 'i', 'my', 'our', 'u', 'you',
  'nice', 'good', 'lovely', 'fresh', 'piece', 'pc', 'pack', 'packet', 'portion', 'each', 'about', 'around', 'approx',
  'roughly', 'x', 'kg', 'g', 'with', 'in', 'on', 'to', 'your', 'those', 'these', 'them', 'that', 'this', 'more', 'extra',
  'but', 'can', 'could', 'would', 'like', 'want', 'need', 'get', 'have', 'order', 'thank', 'thanks', 'cheer', 'hi', 'hey',
  'hello', 'just', 'too', 'as', 'well', 'if', 'possible', 'ok', 'okay', 'we', 'll', 'id', 'd', 'is', 'it', 'be', 'will',
]);
const GENERIC_NOUNS = new Set(['steak', 'cut', 'meat', 'roast', 'fillet']);

export function buildDictionary(products: Product[]): Dictionary {
  const list: DictProduct[] = products.map((p) => {
    const aliasStrings = [...new Set([normalise(p.canonical_name), normalise(p.customer_name), ...p.aliases.map((a) => a.alias)])].filter(Boolean);
    return {
      id: p.id,
      name: p.canonical_name,
      category: p.category,
      piece_noun: p.piece_noun,
      active: p.active,
      aliases: aliasStrings.map((a) => a.split(' ')),
      aliasStrings,
      preps: p.preparations
        .filter((x) => x.active)
        .map((x) => ({ group: x.group_name, name: x.name, is_default: x.is_default, keywords: x.keywords.map((k) => normalise(k).split(' ')).filter((k) => k[0]) })),
      product: p,
    };
  });
  return { products: list, byId: new Map(list.map((p) => [p.id, p])) };
}

function findSeq(tokens: string[], seq: string[], used: boolean[]): number {
  outer: for (let i = 0; i + seq.length <= tokens.length; i++) {
    for (let j = 0; j < seq.length; j++) if (used[i + j] || tokens[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/** Contiguous windows whose concatenation equals the squashed alias ("rib eye" ↔ "ribeye"). */
function findSquashed(tokens: string[], alias: string): { start: number; len: number } | null {
  const target = alias.replace(/ /g, '');
  for (let i = 0; i < tokens.length; i++) {
    let s = '';
    for (let j = i; j < Math.min(tokens.length, i + 4); j++) {
      s += tokens[j];
      if (s === target && j > i) return { start: i, len: j - i + 1 };
      if (s.length >= target.length) break;
    }
  }
  return null;
}

function speciesOf(p: DictProduct): string[] {
  const words = new Set([...p.aliasStrings.join(' ').split(' '), p.category.toLowerCase()]);
  if (words.has('mutton')) words.add('lamb');
  if (words.has('lamb')) words.add('mutton');
  return SPECIES.filter((s) => words.has(s));
}

export function matchProduct(phrase: string, dict: Dictionary): MatchResult {
  const tokens = normalise(phrase).split(' ').filter(Boolean);
  const empty: MatchResult = { status: 'unknown', product: null, preparation: {}, prepMatched: [], leftover: tokens.filter((t) => !STOP.has(t)), suggestions: [] };
  if (!tokens.length) return empty;
  const active = dict.products.filter((p) => p.active);

  // 1. Exact alias (longest wins)
  type Cand = { p: DictProduct; start: number; len: number; chars: number };
  const cands: Cand[] = [];
  const none = new Array(tokens.length).fill(false);
  for (const p of active) {
    for (let k = 0; k < p.aliases.length; k++) {
      const a = p.aliases[k];
      const at = findSeq(tokens, a, none);
      if (at >= 0) cands.push({ p, start: at, len: a.length, chars: p.aliasStrings[k].length });
      else {
        const sq = findSquashed(tokens, p.aliasStrings[k]);
        if (sq) cands.push({ p, start: sq.start, len: sq.len, chars: p.aliasStrings[k].length });
      }
    }
  }
  cands.sort((a, b) => b.len - a.len || b.chars - a.chars);
  let status: MatchResult['status'] = 'matched';
  let chosen: DictProduct | null = null;
  const used = new Array(tokens.length).fill(false);

  if (cands.length) {
    const best = cands[0];
    const rivals = cands.filter((c) => c.p.id !== best.p.id && c.len === best.len && c.chars === best.chars);
    if (rivals.length) {
      return { ...empty, status: 'ambiguous', suggestions: [best, ...rivals].map((c) => ({ product_id: c.p.id, name: c.p.name })), reason: 'More than one product matches.' };
    }
    chosen = best.p;
    for (let i = best.start; i < best.start + best.len; i++) used[i] = true;
  } else {
    // 2. Fuzzy: every word of an alias appears (allowing small typos)
    type Fz = { p: DictProduct; covered: number[]; score: number };
    const fz: Fz[] = [];
    for (const p of active) {
      for (const a of p.aliases) {
        const covered: number[] = [];
        let ok = true;
        for (const w of a) {
          const idx = tokens.findIndex((t, i) => !covered.includes(i) && fuzzyWordEqual(t, w));
          if (idx < 0) {
            ok = false;
            break;
          }
          covered.push(idx);
        }
        if (ok) fz.push({ p, covered, score: a.length * 10 + a.join('').length });
      }
    }
    fz.sort((a, b) => b.score - a.score);
    if (fz.length) {
      const best = fz[0];
      const rival = fz.find((f) => f.p.id !== best.p.id && f.score === best.score);
      if (rival) return { ...empty, status: 'ambiguous', suggestions: [best, rival].map((f) => ({ product_id: f.p.id, name: f.p.name })), reason: 'More than one product is a close match.' };
      chosen = best.p;
      status = 'fuzzy';
      for (const i of best.covered) used[i] = true;
    }
  }

  if (!chosen) return { ...empty, suggestions: suggest(tokens, active) };

  // 3. Preparation keywords (only those configured for this product)
  const preparation: Record<string, string> = {};
  const prepMatched: string[] = [];
  const kwList = chosen.preps.flatMap((o) => o.keywords.map((k) => ({ o, k }))).sort((a, b) => b.k.length - a.k.length);
  for (const { o, k } of kwList) {
    const at = findSeq(tokens, k, used);
    if (at < 0) continue;
    if (preparation[o.group] && preparation[o.group] !== o.name) {
      return { ...empty, status: 'ambiguous', product: chosen, suggestions: [{ product_id: chosen.id, name: chosen.name }], reason: `Conflicting ${o.group.toLowerCase()} instructions.` };
    }
    for (let i = at; i < at + k.length; i++) used[i] = true;
    if (!preparation[o.group]) {
      preparation[o.group] = o.name;
      prepMatched.push(k.join(' '));
    }
  }

  // 4. Leftovers — species conflicts and other products named in the same phrase
  const leftover = tokens.filter((t, i) => !used[i] && !STOP.has(t));
  const species = speciesOf(chosen);
  const conflictSpecies = leftover.find((t) => SPECIES.includes(t) && !species.includes(t));
  if (conflictSpecies) {
    return { ...empty, suggestions: suggest(tokens, active), reason: `"${conflictSpecies}" doesn't match ${chosen.name}.` };
  }
  const meaningful = leftover.filter((t) => !SPECIES.includes(t) && !(GENERIC_NOUNS.has(t) && t !== 'fillet') && !/^\d/.test(t));
  const otherProduct = meaningful.length
    ? active.find((p) => p.id !== chosen!.id && p.aliases.some((a) => a.length === 1 && meaningful.includes(a[0])))
    : undefined;
  if (otherProduct) {
    return { ...empty, status: 'unknown', suggestions: suggest(tokens, active), reason: `Could be ${chosen.name} or ${otherProduct.name}.` };
  }
  return { status, product: chosen, preparation, prepMatched, leftover: meaningful, suggestions: [] };
}

function suggest(tokens: string[], active: DictProduct[]): { product_id: string; name: string }[] {
  const phraseSpecies = tokens.filter((t) => SPECIES.includes(t));
  const scored = active
    .filter((p) => !phraseSpecies.length || phraseSpecies.some((s) => speciesOf(p).includes(s)) || !speciesOf(p).length)
    .map((p) => {
      let best = 0;
      for (const a of p.aliases) {
        let hits = 0;
        for (const w of a) if (tokens.some((t) => fuzzyWordEqual(t, w) || (t.length > 4 && w.startsWith(t)) || (w.length > 4 && t.startsWith(w)))) hits++;
        const s = hits + (hits / Math.max(a.length, 1)) * 0.5;
        if (s > best) best = s;
      }
      return { p, s: best };
    })
    .filter((x) => x.s >= 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4);
  return scored.map((x) => ({ product_id: x.p.id, name: x.p.name }));
}

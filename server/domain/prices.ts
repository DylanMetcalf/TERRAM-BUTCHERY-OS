import { normalise } from '../../shared/text.js';
import { buildDictionary, matchProduct } from '../intelligence/matcher.js';
import { listProducts, updateProduct } from './products.js';
import { badRequest } from '../lib/errors.js';
import { tx } from '../db/db.js';
import type { Actor } from '../services/audit.js';

/**
 * Price list import. Paste lines like "Beef mince R145/kg", "Rump steak - 265.00 per kg",
 * "Burger patties R28 each" or CSV "Beef Mince,145". Each line is matched to a product
 * with the same dictionary the order reader uses; nothing changes until confirmed.
 */
export interface PriceLine {
  line: string;
  product_id: string | null;
  product_name: string | null;
  old_cents: number | null;
  old_unit: 'kg' | 'each' | null;
  new_cents: number | null;
  new_unit: 'kg' | 'each' | null;
  status: 'change' | 'same' | 'unmatched' | 'no_price' | 'duplicate';
}

const PRICE_RE = /(?:R|ZAR|£|\$|€)?\s*(\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\s*(?:g|gr|grams?|kg|kilos?)\b(?!\s*\/))/gi;

function parseMoney(s: string): number | null {
  let t = s.replace(/\s/g, '');
  // "1,250.00" / "1 250,00" / "145,50"
  if (/,\d{1,2}$/.test(t) && !t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) : null;
}

export function previewPrices(text: string): PriceLine[] {
  const dict = buildDictionary(listProducts());
  const out: PriceLine[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(product|item|name)\b.*price/i.test(line)) continue;
    const unitKg = /(?:\/|per|a)\s*(?:kg|kilo)|\bkg\b\s*$|p\/kg|\bper kilogram\b/i.test(line);
    const unitEach = /(?:\/|per|a)\s*(?:each|ea|piece|pc|unit|pack|packet|patty|steak|chicken)|\beach\b|\bea\b/i.test(line);
    // The price is the last money-looking number on the line
    const nums = [...line.matchAll(PRICE_RE)].filter((m) => !/^\d{4}$/.test(m[1]));
    const priceMatch = nums[nums.length - 1];
    const cents = priceMatch ? parseMoney(priceMatch[1]) : null;
    const namePart = (priceMatch ? line.slice(0, priceMatch.index) + ' ' + line.slice(priceMatch.index! + priceMatch[0].length) : line)
      .replace(/[,;|\t]+/g, ' ')
      .replace(/(?:\/|per)\s*(?:kg|kilo|kilogram|each|ea|piece|pc|unit|pack|packet)\b/gi, ' ')
      .replace(/\b(?:R|ZAR)\b|\bp\/kg\b|[-–:=]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const m = namePart ? matchProduct(namePart, dict) : null;
    const p = m?.product?.product ?? null;
    const unit: 'kg' | 'each' | null = unitKg ? 'kg' : unitEach ? 'each' : p?.price_unit ?? (p?.quantity_type === 'count' ? 'each' : 'kg');
    let status: PriceLine['status'] = !p ? 'unmatched' : cents == null ? 'no_price' : cents === p.price_cents && unit === p.price_unit ? 'same' : 'change';
    if (p && seen.has(p.id) && status === 'change') status = 'duplicate';
    if (p) seen.add(p.id);
    out.push({ line, product_id: p?.id ?? null, product_name: p?.canonical_name ?? null, old_cents: p?.price_cents ?? null, old_unit: p?.price_unit ?? null, new_cents: cents, new_unit: p ? unit : null, status });
  }
  return out;
}

export function applyPrices(changes: { product_id: string; price_cents: number; price_unit: 'kg' | 'each' }[], actor: Actor) {
  if (!changes.length) throw badRequest('Nothing to update.');
  tx(() => {
    for (const c of changes) updateProduct(c.product_id, { price_cents: c.price_cents, price_unit: c.price_unit }, actor);
  });
  return changes.length;
}

export { normalise };

/**
 * Quantities are stored deterministically:
 *  - weight:   weight_g grams total (e.g. 2kg mince → 2000)
 *  - count:    count pieces (e.g. 4 rumps → 4)
 *  - portions: count portions × weight_g each (e.g. 6 × 500g fillet → count 6, weight_g 500)
 * Grams are integers so arithmetic never drifts.
 */
export type QtyKind = 'weight' | 'count' | 'portions';

export interface Qty {
  kind: QtyKind;
  count: number | null;
  weight_g: number | null;
}

export type QuantityType = 'weight' | 'count' | 'either';

export function formatWeight(g: number): string {
  if (g >= 1000) {
    const kg = g / 1000;
    return `${Number.isInteger(kg) ? kg : Number(kg.toFixed(3)).toString()}kg`;
  }
  return `${g}g`;
}

export function formatQty(q: Qty, pieceNoun = 'piece'): string {
  if (q.kind === 'weight') return formatWeight(q.weight_g ?? 0);
  if (q.kind === 'portions') return `${q.count} × ${formatWeight(q.weight_g ?? 0)}`;
  const n = q.count ?? 0;
  return `${n} ${n === 1 ? pieceNoun : pluralise(pieceNoun)}`;
}

/** Compact form used in dense lists: "2kg", "4", "6 × 500g". */
export function formatQtyShort(q: Qty): string {
  if (q.kind === 'weight') return formatWeight(q.weight_g ?? 0);
  if (q.kind === 'portions') return `${q.count} × ${formatWeight(q.weight_g ?? 0)}`;
  return `${q.count ?? 0}`;
}

export function pluralise(noun: string): string {
  if (!noun) return noun;
  if (/(s|x|ch|sh)$/i.test(noun)) return noun + 'es';
  if (/[^aeiou]y$/i.test(noun)) return noun.slice(0, -1) + 'ies';
  return noun + 's';
}

/** Total grams represented (portions multiply out). Null for pure counts. */
export function totalGrams(q: Qty): number | null {
  if (q.kind === 'weight') return q.weight_g ?? 0;
  if (q.kind === 'portions') return (q.count ?? 0) * (q.weight_g ?? 0);
  return null;
}

export function qtyEquals(a: Qty, b: Qty): boolean {
  return a.kind === b.kind && (a.count ?? null) === (b.count ?? null) && (a.weight_g ?? null) === (b.weight_g ?? null);
}

export function validateQty(q: Qty, quantityType: QuantityType, allowsPortions: boolean): string | null {
  if (q.kind === 'weight') {
    if (quantityType === 'count') return 'This product is sold by the piece, not by weight.';
    if (!q.weight_g || q.weight_g <= 0) return 'Weight must be more than zero.';
    if (q.weight_g > 500_000) return 'That weight looks too large (over 500kg).';
  } else if (q.kind === 'count') {
    if (quantityType === 'weight' && !allowsPortions) return 'This product is sold by weight.';
    if (!q.count || q.count <= 0 || !Number.isInteger(q.count)) return 'Quantity must be a whole number above zero.';
    if (q.count > 1000) return 'That quantity looks too large.';
  } else {
    if (!allowsPortions) return 'This product cannot be ordered in portions.';
    if (!q.count || q.count <= 0 || !Number.isInteger(q.count)) return 'Number of portions must be a whole number above zero.';
    if (!q.weight_g || q.weight_g <= 0) return 'Portion weight must be more than zero.';
    if (q.count * q.weight_g > 500_000) return 'That order looks too large.';
  }
  return null;
}

export function formatMoney(cents: number | null | undefined, currency = 'ZAR'): string {
  if (cents == null) return '—';
  const symbol = currency === 'ZAR' ? 'R' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return `${symbol}${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Estimated line price. Weight-priced products need grams; each-priced need counts. */
export function estimateLinePrice(q: Qty, priceCents: number | null, priceUnit: 'kg' | 'each' | null): number | null {
  if (priceCents == null || !priceUnit) return null;
  if (priceUnit === 'kg') {
    const g = totalGrams(q);
    return g == null ? null : Math.round((g / 1000) * priceCents);
  }
  if (q.kind === 'weight') return null;
  return (q.count ?? 0) * priceCents;
}

import type { Qty } from './quantity.js';

/**
 * DETERMINISTIC PRICING — the only place prices are worked out, on the server and in the browser.
 *
 * All money is whole cents (integers) and every step rounds once, half-up, so the same order always
 * gives the same total on every device. Nothing here is guessed or calculated by an AI model.
 *
 * Four kinds of line:
 *  - exact     fixed-weight vacuum packs (500 g mince × 3) or things sold per item (eggs): known now.
 *  - estimate  loose weight (2 kg brisket) or pieces with a known typical weight: final price after weighing.
 *  - by_weight pieces with no typical weight (a whole fillet): priced per kg once weighed.
 *  - unpriced  the product has no price yet: the farm confirms the price.
 */

export type SaleOptionKind = 'pack' | 'piece';
export interface SaleOption {
  /** Stable id stored on order lines, e.g. "500g". */
  id: string;
  /** What the customer sees, e.g. "500 g pack", "Whole fillet". */
  label: string;
  /** pack = fixed-weight vacuum pack; piece = a whole/half piece that is weighed. */
  kind: SaleOptionKind;
  /** Pack weight (pack), or a typical piece weight used for an estimate (piece, optional). */
  grams: number | null;
}

export type Pricing = 'exact' | 'estimate' | 'by_weight' | 'unpriced';

/** Price per unit after a percentage surcharge (e.g. dry-aged +25%), in whole cents. */
export function withSurcharge(priceCents: number, surchargePct: number | null | undefined): number {
  const pct = Number(surchargePct ?? 0);
  if (!pct) return priceCents;
  // Work in hundredths of a percent so 12.5% is exact: price × (10000 + pct×100) / 10000
  return roundHalfUp((priceCents * (10000 + Math.round(pct * 100))) / 10000);
}

export function roundHalfUp(n: number): number {
  return n >= 0 ? Math.floor(n + 0.5) : -Math.floor(-n + 0.5);
}

export interface LineInput {
  qty: Qty;
  unitPriceCents: number | null;
  priceUnit: 'kg' | 'each' | null;
  saleKind?: SaleOptionKind | null;
  /** Typical weight of one piece, for estimates of pieces sold per kg. */
  pieceGrams?: number | null;
}

/** The quoted price of one order line. */
export function priceLine(l: LineInput): { pricing: Pricing; cents: number | null } {
  const { qty, unitPriceCents: unit, priceUnit } = l;
  if (unit == null || !priceUnit) return { pricing: 'unpriced', cents: null };
  const count = qty.count ?? 0;
  const grams = qty.weight_g ?? 0;
  if (priceUnit === 'each') {
    if (qty.kind === 'weight') return { pricing: 'unpriced', cents: null };
    return { pricing: 'exact', cents: count * unit };
  }
  // Priced per kg
  if (qty.kind === 'portions') {
    const cents = roundHalfUp((count * grams * unit) / 1000);
    return { pricing: l.saleKind === 'pack' ? 'exact' : 'estimate', cents };
  }
  if (qty.kind === 'weight') return { pricing: 'estimate', cents: roundHalfUp((grams * unit) / 1000) };
  const piece = l.pieceGrams ?? null;
  if (piece && piece > 0) return { pricing: 'estimate', cents: roundHalfUp((count * piece * unit) / 1000) };
  return { pricing: 'by_weight', cents: null };
}

/** The final price of a line once it has been packed (and weighed where that matters). */
export function finalLine(l: { pricing: Pricing | null; est_cents: number | null; unit_price_cents: number | null; price_unit: 'kg' | 'each' | null; packed_weight_g: number | null }): number | null {
  if (l.pricing === 'exact') return l.est_cents;
  if (l.unit_price_cents == null || !l.price_unit) return null;
  if (l.price_unit === 'kg' && l.packed_weight_g && l.packed_weight_g > 0) return roundHalfUp((l.packed_weight_g * l.unit_price_cents) / 1000);
  return null;
}

export interface Totals {
  /** Sum of every line we can price now (exact + estimates). */
  estimateCents: number;
  /** True when every line is exact, so the estimate is the real amount. */
  exact: boolean;
  /** Lines that can't be priced until weighed or until the farm sets a price. */
  pendingLines: number;
}

export function totalOf(lines: { pricing: Pricing | null; cents: number | null }[], extraCents = 0): Totals {
  let estimateCents = extraCents;
  let exact = true;
  let pendingLines = 0;
  for (const l of lines) {
    if (l.cents == null) {
      pendingLines++;
      exact = false;
      continue;
    }
    estimateCents += l.cents;
    if (l.pricing !== 'exact') exact = false;
  }
  return { estimateCents, exact, pendingLines };
}

/** Parses and checks a product's configured sale options (admin input or stored JSON). */
export function parseSaleOptions(v: unknown): SaleOption[] {
  let raw: unknown = v;
  if (typeof v === 'string') {
    try {
      raw = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: SaleOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const id = String((o as any).id ?? '').trim().slice(0, 40);
    const label = String((o as any).label ?? '').trim().slice(0, 60);
    const kind = (o as any).kind === 'pack' ? 'pack' : (o as any).kind === 'piece' ? 'piece' : null;
    const g = (o as any).grams == null || (o as any).grams === '' ? null : Math.round(Number((o as any).grams));
    if (!id || !label || !kind) continue;
    if (kind === 'pack' && !(g && g > 0)) continue; // a fixed pack must have a weight
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, label, kind, grams: g && g > 0 ? g : null });
  }
  return out;
}

export function rands(cents: number | null | undefined, currency = 'ZAR'): string {
  if (cents == null) return '—';
  const symbol = currency === 'ZAR' ? 'R' : currency;
  return `${symbol}${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * How customers order a product. Each method shows only its own fields:
 *   packs         fixed-weight packs (e.g. mince: number of 500 g packets)
 *   items_weighed individual pieces priced per kg (e.g. steaks: how many, preferred weight each)
 *   items         individual items priced each (e.g. egg trays)
 *   by_weight     loose, in kilograms
 *   whole         whole/half pieces chosen from the product's sizes (e.g. whole fillet)
 *   custom        not ordered directly; ask under Special requests
 */
export type OrderMethod = 'packs' | 'items_weighed' | 'items' | 'by_weight' | 'whole' | 'custom';
export const ORDER_METHODS: OrderMethod[] = ['packs', 'items_weighed', 'items', 'by_weight', 'whole', 'custom'];
export const ORDER_METHOD_LABEL: Record<OrderMethod, string> = {
  packs: 'Fixed-weight packs',
  items_weighed: 'Individual items, priced by weight',
  items: 'Individual items, priced each',
  by_weight: 'By weight (kg)',
  whole: 'Whole / half pieces',
  custom: 'Custom order (special request)',
};

/** A preferred weight per item, e.g. 300–400 g a steak. */
export interface WeightRange { id: string; label: string; min_g: number; max_g: number }

export function parseWeightRanges(v: unknown): WeightRange[] {
  let raw: unknown = v;
  if (typeof v === 'string') {
    try {
      raw = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: WeightRange[] = [];
  for (const r of raw) {
    const min = Math.round(Number((r as any)?.min_g));
    const max = Math.round(Number((r as any)?.max_g));
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min || max > 100000) continue;
    const id = String((r as any).id ?? `${min}-${max}`).trim().slice(0, 40) || `${min}-${max}`;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, label: String((r as any).label ?? '').trim().slice(0, 40) || `${min}–${max} g`, min_g: min, max_g: max });
  }
  return out;
}

/** The method a product uses when none has been set (worked out from its existing setup; flagged for review). */
export function inferOrderMethod(p: { sale_options: { kind: string }[]; quantity_type: string; price_unit: string | null; typical_piece_g?: number | null }): OrderMethod {
  if (p.sale_options.length) return p.sale_options.every((o) => o.kind === 'pack') ? 'packs' : 'whole';
  if (p.quantity_type === 'weight') return 'by_weight';
  if (p.quantity_type === 'count') return p.price_unit === 'kg' ? 'items_weighed' : 'items';
  return p.price_unit === 'kg' && p.typical_piece_g ? 'items_weighed' : p.price_unit === 'each' ? 'items' : 'by_weight';
}

import { db } from '../db/db.js';
import { qtyEquals, type Qty } from '../../shared/quantity.js';
import { getSettings } from '../services/settings.js';

/**
 * Duplicate Detector — flags, never merges or deletes.
 * Similarity is based on product overlap and matching quantities for the same
 * customer within a time window (or for the same requested date).
 */
export interface DupCandidate {
  order_id: string;
  order_number: number;
  status: string;
  created_at: string;
  requested_date: string | null;
  similarity: number;
  reasons: string[];
}

export function itemSimilarity(a: { product_id: string; qty: Qty }[], b: { product_id: string; qty: Qty }[]): number {
  if (!a.length || !b.length) return 0;
  const pa = new Set(a.map((x) => x.product_id));
  const pb = new Set(b.map((x) => x.product_id));
  const inter = [...pa].filter((p) => pb.has(p)).length;
  const union = new Set([...pa, ...pb]).size;
  const jaccard = inter / union;
  let sameQty = 0;
  for (const x of a) if (b.some((y) => y.product_id === x.product_id && qtyEquals(x.qty, y.qty))) sameQty++;
  const qtyScore = sameQty / Math.max(a.length, b.length);
  return Math.round((jaccard * 0.6 + qtyScore * 0.4) * 100) / 100;
}

export function findPossibleDuplicates(customerId: string, items: { product_id: string; qty: Qty }[], opts: { excludeOrderId?: string; requestedDate?: string | null } = {}): DupCandidate[] {
  const hours = getSettings().orders.duplicateWindowHours;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db()
    .prepare(
      `SELECT id, order_number, status, created_at, requested_date FROM orders
       WHERE customer_id = ? AND status NOT IN ('cancelled') AND id != COALESCE(?, '')
         AND (created_at >= ? OR (requested_date IS NOT NULL AND requested_date = ?))
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(customerId, opts.excludeOrderId ?? null, since, opts.requestedDate ?? '') as any[];
  const out: DupCandidate[] = [];
  for (const r of rows) {
    const theirs = (db().prepare("SELECT product_id, qty_kind, count, weight_g FROM order_items WHERE order_id = ? AND status = 'active'").all(r.id) as any[]).map((i) => ({
      product_id: i.product_id,
      qty: { kind: i.qty_kind, count: i.count, weight_g: i.weight_g } as Qty,
    }));
    const sim = itemSimilarity(items, theirs);
    if (sim >= 0.75) {
      const reasons = ['Same customer'];
      if (sim === 1) reasons.push('identical items and quantities');
      else reasons.push('mostly the same items');
      if (opts.requestedDate && r.requested_date === opts.requestedDate) reasons.push('same date');
      out.push({ ...r, similarity: sim, reasons });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}

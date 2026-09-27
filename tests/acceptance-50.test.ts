import { beforeAll, describe, expect, it } from 'vitest';
import { freshDb, productId, STAFF } from './helpers';
import { buildChat, ORDERS, type Truth } from './fixtures/fifty-orders';
import { analyseImport, commitBatch, getBatch } from '../server/intelligence/imports';
import { completePacking, getItems, requireOrder, setItemPacked, setItemsCut, transition } from '../server/domain/orders';
import { cuttingSheet } from '../server/domain/production';
import { listExceptions } from '../server/domain/exceptions';
import { resolveExceptionAction } from '../server/domain/exception-actions';
import { getProduct } from '../server/domain/products';
import { localDate } from '../server/lib/time';
import { db } from '../server/db/db';
import type { Qty } from '../shared/quantity';

/**
 * The real test: messy WhatsApp messages → interpretation → validation →
 * exceptions → human decisions → confirmed orders → cutting → packing →
 * fulfilment → completed. Not "did it parse", but "can Terram run the day on it".
 */
function toQty(q: string | number): Qty {
  if (typeof q === 'number') return { kind: 'count', count: q, weight_g: null };
  const p = /^(\d+)x(\d+)g$/.exec(q);
  if (p) return { kind: 'portions', count: Number(p[1]), weight_g: Number(p[2]) };
  if (q.endsWith('kg')) return { kind: 'weight', count: null, weight_g: Math.round(Number(q.slice(0, -2)) * 1000) };
  return { kind: 'weight', count: null, weight_g: Number(q.slice(0, -1)) };
}
const key = (slug: string, qty: Qty, prep: string) => `${slug}|${qty.kind}|${qty.count ?? ''}|${qty.weight_g ?? ''}|${prep}`;
function truthKeys(t: Truth[]) {
  return t.map(([slug, q, prep]) => {
    const p = getProduct(productId(slug))!;
    // Only non-default choices appear in the label; compute it the same way the engine does
    const groups = new Map<string, { name: string; def: boolean }[]>();
    for (const o of p.preparations) (groups.get(o.group_name) ?? groups.set(o.group_name, []).get(o.group_name)!).push({ name: o.name, def: o.is_default });
    const label = [...groups.entries()].map(([g, opts]) => (prep?.[g] && !opts.find((o) => o.name === prep[g])?.def ? prep[g] : null)).filter(Boolean).join(' · ');
    return key(slug, toQty(q), label);
  }).sort();
}
function orderKeys(orderId: string) {
  return getItems(orderId).map((i) => key(getProduct(i.product_id)!.slug, i.qty, i.preparation_label)).sort();
}
const orderOf = (name: string) => {
  const r = db().prepare('SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.name = ?').all(name) as any[];
  return r.map((x) => requireOrder(x.id));
};

describe('50-order acceptance test', () => {
  let batchId: string;
  const today = localDate(new Date(), 'Africa/Johannesburg');

  beforeAll(async () => {
    freshDb();
    batchId = await analyseImport({ text: buildChat(today) }, STAFF);
  });

  it('separates every customer’s order and classifies every message', () => {
    const b = getBatch(batchId);
    const orderDrafts = b.drafts.filter((d) => d.kind === 'order');
    // 50 orders + Werner's double paste flagged as a separate duplicate
    expect(orderDrafts).toHaveLength(51);
    const names = new Set(orderDrafts.map((d) => (d.data as any).customer.name));
    for (const o of ORDERS) expect(names.has(o.name), o.name).toBe(true);
    const ignored = b.drafts.filter((d) => d.kind === 'ignored');
    expect(ignored.map((d) => (d.data as any).intent).sort()).toEqual(['chatter', 'chatter', 'question']);
    expect(b.stats.messages).toBe(61); // includes Terram’s own reply, kept as context
    const david = orderDrafts.find((d) => (d.data as any).customer.name === 'David Nel')!.data as any;
    expect(david.messages.map((m: any) => m.direction)).toEqual(['in', 'out', 'in']);
  });

  it('marks only genuinely unclear orders for review', () => {
    const b = getBatch(batchId);
    const review = b.drafts.filter((d) => d.kind === 'order' && d.status === 'needs_review').map((d) => (d.data as any).customer.name).sort();
    expect(review).toEqual(['Johanna Muller', 'Uys Vermeulen', 'Werner Steyn', 'Yvonne Ferreira']);
  });

  it('commits the good orders and routes the rest to exceptions without failing the batch', () => {
    const r = commitBatch(batchId, { sendRestToExceptions: true }, STAFF, 'manager');
    expect(r.failed).toEqual([]);
    expect(r.created).toHaveLength(50);
    expect(r.skipped).toBe(1); // Werner’s duplicate
    const types = listExceptions({ status: 'open' }).map((e) => e.type).sort();
    expect(types).toEqual(['contradiction', 'customer_question', 'unknown_product', 'unknown_product']);
  });

  it('every confirmed order matches what the customer actually asked for', () => {
    const mismatches: string[] = [];
    for (const o of ORDERS) {
      const orders = orderOf(o.name);
      expect(orders, o.name).toHaveLength(1);
      if (o.expect === null) {
        expect(orders[0].status, o.name).toBe('needs_clarification');
        continue;
      }
      expect(orders[0].status, o.name).toBe('confirmed');
      const want = truthKeys(o.expect);
      const got = orderKeys(orders[0].id);
      if (JSON.stringify(want) !== JSON.stringify(got)) mismatches.push(`${o.name}\n  want ${want.join(', ')}\n  got  ${got.join(', ')}`);
      if (o.fulfilment) expect(orders[0].fulfilment_type, o.name).toBe(o.fulfilment);
    }
    expect(mismatches.join('\n')).toBe('');
  });

  it('keeps an auditable trail from message to order', () => {
    const anna = orderOf('Anna Venter')[0];
    const ev = db().prepare("SELECT e.summary, m.body FROM order_events e LEFT JOIN messages m ON m.id = e.message_id WHERE e.order_id = ? AND e.type = 'amendment_applied'").get(anna.id) as any;
    expect(ev.summary).toMatch(/2kg → 3kg/);
    expect(ev.body).toMatch(/Actually make the mince 3kg/);
    // Every inbound message is preserved and accounted for
    const pending = (db().prepare("SELECT COUNT(*) n FROM messages WHERE import_batch_id = ? AND status = 'pending' AND direction = 'in'").get(batchId) as any).n;
    expect(pending).toBe(0);
  });

  it('staff resolve the exceptions in a few taps', () => {
    for (const e of listExceptions({ status: 'open' })) {
      if (e.type === 'contradiction') resolveExceptionAction(e.id, { action: 'use_later' }, STAFF, 'staff');
      else if (e.type === 'customer_question') resolveExceptionAction(e.id, { action: 'mark_answered' }, STAFF, 'staff');
      else if (e.payload.phrase?.includes('cowboy')) resolveExceptionAction(e.id, { action: 'map_product', product_id: productId('beef_ribeye'), preparation: { Bone: 'Bone-in' } }, STAFF, 'staff');
      else resolveExceptionAction(e.id, { action: 'remove_line' }, STAFF, 'staff');
    }
    expect(listExceptions({ status: 'open' })).toHaveLength(0);
    expect(orderOf('Uys Vermeulen')[0].status).toBe('confirmed');
    expect(orderKeys(orderOf('Uys Vermeulen')[0].id)).toEqual([key('beef_fillet', { kind: 'portions', count: 6, weight_g: 500 }, '')]);
    expect(orderOf('Yvonne Ferreira')[0].status).toBe('confirmed');
    // Biltong isn't sold: the order has nothing left, so it waits for a person
    const johanna = orderOf('Johanna Muller')[0];
    expect(johanna.status).toBe('needs_clarification');
    transition(johanna.id, 'cancelled', STAFF, 'manager', { note: 'We don’t sell biltong' });
  });

  it('the cutting sheet adds up exactly to the confirmed orders', () => {
    const sheet = cuttingSheet({});
    expect(sheet.order_count).toBe(49);
    const mince = sheet.lines.find((l) => l.product_name === 'Beef Mince' && !l.preparation_label && l.qty_kind === 'weight')!;
    // Anna 3kg + Marius 1kg + Yvonne 1kg
    expect(mince.total_weight_g).toBe(5000);
    const rump = sheet.lines.find((l) => l.product_name === 'Rump Steak' && !l.preparation_label)!;
    // Anna 4 + Vusi 5 + Izak 2 + Riaan 4
    expect(rump.total_count).toBe(15);
    const items = (db().prepare("SELECT COUNT(*) n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.status = 'active' AND o.status = 'confirmed'").get() as any).n;
    expect(sheet.lines.reduce((a, l) => a + l.total_items, 0)).toBe(items);
  });

  it('cutting → packing → ready → collected/delivered → completed', () => {
    const sheet = cuttingSheet({});
    for (const l of sheet.lines) setItemsCut(l.orders.map((o) => o.item_id), true, STAFF);
    const cut = (db().prepare("SELECT id FROM orders WHERE status = 'cut'").all() as any[]).map((r) => r.id);
    expect(cut).toHaveLength(49);
    for (const id of cut) {
      for (const it of getItems(id)) setItemPacked(it.id, true, STAFF);
      expect(completePacking(id, STAFF).status).toBe('ready');
    }
    for (const id of cut) {
      const o = requireOrder(id);
      if (o.fulfilment_type === 'delivery') transition(id, 'out_for_delivery', STAFF, 'staff');
      transition(id, 'completed', STAFF, 'staff');
    }
    const counts = Object.fromEntries((db().prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all() as any[]).map((r) => [r.status, r.n]));
    expect(counts).toEqual({ completed: 49, cancelled: 1 });
  });
});

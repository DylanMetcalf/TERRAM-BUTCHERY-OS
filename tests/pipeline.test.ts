import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, productId, STAFF } from './helpers';
import { analyseImport, commitBatch, editDraft, getBatch } from '../server/intelligence/imports';
import { processInbound } from '../server/intelligence/inbound';
import { listExceptions } from '../server/domain/exceptions';
import { resolveExceptionAction } from '../server/domain/exception-actions';
import { getItems, requireOrder, transition } from '../server/domain/orders';
import { listSuggestions, decideSuggestion } from '../server/intelligence/learning';
import { db } from '../server/db/db';

beforeEach(() => freshDb());

const itemsOf = (orderId: string) => getItems(orderId).map((i) => `${i.qty_label} ${i.product_name}${i.preparation_label ? ` (${i.preparation_label})` : ''}`);
const orderFor = (name: string) => {
  const r = db().prepare('SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.name = ? ORDER BY o.created_at DESC').get(name) as any;
  return r ? requireOrder(r.id) : null;
};

describe('bulk WhatsApp import — the spec scenarios', () => {
  const SAMPLE = `John:\n2kg mince\n4 rumps\n2 ribeye bone in\nCollect Saturday\n\nSarah:\n6 fillets\n1kg boerewors\n\nMark:\n3kg chicken breasts\nDelivery Friday\n\nJohn: Actually make the mince 3kg.\n\nSarah: Can I have 4 of those steaks again?\n\nMark: 2 cowboy steaks\n\nSarah:\n6 fillets\n1kg boerewors`;

  it('separates orders, folds in amendments and never guesses', async () => {
    const id = await analyseImport({ text: SAMPLE }, STAFF);
    const b = getBatch(id);
    const orders = b.drafts.filter((d) => d.kind === 'order');
    expect(orders.map((d) => (d.data as any).customer.name)).toEqual(['John', 'Sarah', 'Mark', 'Sarah']);
    const john = orders[0].data as any;
    expect(john.items.map((i: any) => i.qty_label)).toEqual(['3kg', '4 steaks', '2 steaks']);
    expect(john.events[0].summary).toMatch(/2kg → 3kg/);
    expect(orders[0].status).toBe('ready');
    expect(orders[1].status).toBe('needs_review'); // "those steaks"
    expect(orders[2].status).toBe('needs_review'); // cowboy steaks
    expect((orders[3].data as any).issues.some((i: any) => i.code === 'duplicate_in_batch')).toBe(true);

    const r = commitBatch(id, { sendRestToExceptions: true }, STAFF, 'manager');
    expect(r.created).toHaveLength(3);
    expect(r.skipped).toBe(1);
    expect(r.failed).toHaveLength(0);
    expect(itemsOf(orderFor('John')!.id)).toEqual(['3kg Beef Mince', '4 steaks Rump Steak', '2 steaks Beef Ribeye (Bone-in)']);
    expect(orderFor('John')!.status).toBe('confirmed');
    expect(orderFor('Mark')!.status).toBe('needs_clarification');
    const titles = listExceptions({ status: 'open' }).map((e) => e.type).sort();
    expect(titles).toEqual(['ambiguous_reference', 'unknown_product']);
  });

  it('is idempotent: confirming twice does not create orders twice', async () => {
    const id = await analyseImport({ text: 'Anna:\n2kg mince' }, STAFF);
    commitBatch(id, {}, STAFF, 'staff');
    commitBatch(id, {}, STAFF, 'staff');
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(1);
  });

  it('flags a re-import of the same order as a possible duplicate', async () => {
    commitBatch(await analyseImport({ text: 'Anna Venter:\n2kg mince\n4 rumps' }, STAFF), {}, STAFF, 'staff');
    const id2 = await analyseImport({ text: 'Anna Venter:\n2kg mince\n4 rumps' }, STAFF);
    const d = getBatch(id2).drafts[0];
    expect(d.status).toBe('needs_review');
    expect((d.data as any).issues.map((i: any) => i.code)).toContain('possible_duplicate');
    // Staff can still decide it's genuine
    const after = editDraft(id2, d.id, { action: 'ack', code: 'possible_duplicate' }, STAFF, 'staff');
    expect(after.drafts[0].status).toBe('ready');
  });

  it('applies a later amendment to the existing order, with history', async () => {
    commitBatch(await analyseImport({ text: 'John Smith:\n2kg mince\n4 rumps' }, STAFF), {}, STAFF, 'staff');
    const id = await analyseImport({ text: 'John Smith: actually make that 3kg mince' }, STAFF);
    const d = getBatch(id).drafts[0];
    expect(d.kind).toBe('amendment');
    expect((d.data as any).changes[0]).toMatchObject({ op: 'set_qty', label: 'Beef Mince' });
    commitBatch(id, {}, STAFF, 'staff');
    const o = orderFor('John Smith')!;
    expect(itemsOf(o.id)).toContain('3kg Beef Mince');
    const ev = db().prepare("SELECT e.*, m.body FROM order_events e LEFT JOIN messages m ON m.id = e.message_id WHERE e.order_id = ? AND e.type = 'item_amended'").get(o.id) as any;
    expect(ev.body).toMatch(/3kg mince/);
  });

  it('resolves "make that 3" using the unit to find the right line', async () => {
    const id = await analyseImport({ text: 'Gugu:\n1 whole chicken\n500g bacon\n\nGugu: make those 2' }, STAFF);
    const items = (getBatch(id).drafts[0].data as any).items;
    expect(items.map((i: any) => i.qty_label)).toEqual(['2 chickens', '500g']);
  });

  it('flags contradictions instead of adding both', async () => {
    const id = await analyseImport({ text: 'Uys: 15 fillets\n\nUys: 6 x 500g fillets' }, STAFF);
    const d = getBatch(id).drafts[0];
    expect((d.data as any).items).toHaveLength(1);
    expect((d.data as any).issues.map((i: any) => i.code)).toContain('contradiction');
    const after = editDraft(id, d.id, { action: 'resolve_contradiction', item_key: (d.data as any).items[0].key, choice: 'replace' }, STAFF, 'staff');
    expect((after.drafts[0].data as any).items[0].qty_label).toBe('6 × 500g');
    expect(after.drafts[0].status).toBe('ready');
  });

  it('keeps one bad order from blocking the rest', async () => {
    const id = await analyseImport({ text: 'A:\n2kg mince\n\nB:\n1kg biltong\n\nC:\n4 rumps' }, STAFF);
    const r = commitBatch(id, { sendRestToExceptions: true }, STAFF, 'staff');
    expect(r.created).toHaveLength(3);
    expect(orderFor('A')!.status).toBe('confirmed');
    expect(orderFor('C')!.status).toBe('confirmed');
    expect(orderFor('B')!.status).toBe('needs_clarification');
  });
});

describe('learning loop', () => {
  it('suggests an alias only after repeated corrections, and applies it only when approved', async () => {
    for (const name of ['Pat', 'Priya']) {
      commitBatch(await analyseImport({ text: `${name}:\nchicken fillets 2kg` }, STAFF), {}, STAFF, 'staff');
      const ex = listExceptions({ status: 'open' }).find((e) => e.type === 'unknown_product')!;
      resolveExceptionAction(ex.id, { action: 'map_product', product_id: productId('chicken_breast') }, STAFF, 'staff');
      if (name === 'Pat') expect(listSuggestions()).toHaveLength(0);
    }
    const [s] = listSuggestions();
    expect(s.title).toMatch(/chicken fillets/);
    // Not applied yet
    let d = getBatch(await analyseImport({ text: 'Paul:\nchicken fillets 1kg' }, STAFF)).drafts[0];
    expect(d.status).toBe('needs_review');
    decideSuggestion(s.id, 'approved', STAFF);
    d = getBatch(await analyseImport({ text: 'Petra:\nchicken fillets 1kg' }, STAFF)).drafts[0];
    expect(d.status).toBe('ready');
    expect((d.data as any).items[0].product_name).toBe('Chicken Breast Fillets');
  });
});

describe('live WhatsApp channel', () => {
  const msg = (id: string, body: string) => ({ channel: 'whatsapp' as const, external_id: id, from_phone: '+27825551234', from_name: 'John Smith', body });

  it('creates an order for review, stays quiet for "Thanks!", and ignores webhook retries', async () => {
    const a = await processInbound(msg('wamid.1', 'Can I get 2kg mince and 4 rumps for Saturday?'));
    expect(a.intent).toBe('new_order');
    const o = requireOrder(a.order_id!);
    expect(o.status).toBe('review');
    expect(a.reply_suggestion).toMatch(/received your order/);

    const retry = await processInbound(msg('wamid.1', 'Can I get 2kg mince and 4 rumps for Saturday?'));
    expect(retry.duplicate).toBe(true);
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(1);

    const thanks = await processInbound(msg('wamid.2', 'Thanks!'));
    expect(thanks.intent).toBe('chatter');
    expect(thanks.reply_suggestion).toBeNull();
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(1);
  });

  it('applies a clear amendment automatically while the order is still under review', async () => {
    const a = await processInbound(msg('w1', 'Can I get 2kg mince and 4 rumps?'));
    const b = await processInbound(msg('w2', 'Actually make that 3kg mince.'));
    expect(b.action).toBe('Amendment applied');
    expect(itemsOf(a.order_id!)).toContain('3kg Beef Mince');
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(1);
  });

  it('asks a person before changing a confirmed order', async () => {
    const a = await processInbound(msg('w1', '2kg mince and 4 rumps please'));
    transition(a.order_id!, 'confirmed', STAFF, 'staff');
    const b = await processInbound(msg('w2', 'Actually make that 3kg mince.'));
    expect(b.exceptions).toBeGreaterThan(0);
    expect(itemsOf(a.order_id!)).toContain('2kg Beef Mince');
    const ex = listExceptions({ status: 'open' }).find((e) => e.type === 'possible_amendment')!;
    resolveExceptionAction(ex.id, { action: 'apply_amendment' }, STAFF, 'staff');
    expect(itemsOf(a.order_id!)).toContain('3kg Beef Mince');
  });

  it('asks "which item?" when a vague change could mean several lines', async () => {
    const a = await processInbound(msg('w1', '4 rumps and 2 ribeyes please'));
    const b = await processInbound(msg('w2', 'make that 3'));
    expect(b.exceptions).toBe(1);
    expect(listExceptions({ status: 'open' })[0].type).toBe('ambiguous_reference');
    expect(itemsOf(a.order_id!)).toEqual(['4 steaks Rump Steak', '2 steaks Beef Ribeye']);
  });
});

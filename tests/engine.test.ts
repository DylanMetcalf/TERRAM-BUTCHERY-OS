import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, productId, STAFF } from './helpers';
import { completePacking, createOrder, getItems, requireOrder, setItemPacked, setItemsCut, transition, updateItem } from '../server/domain/orders';
import { raiseException, listExceptions } from '../server/domain/exceptions';
import { resolveExceptionAction } from '../server/domain/exception-actions';
import { cuttingSheet } from '../server/domain/production';
import { db } from '../server/db/db';
import { canTransition } from '../shared/workflow';

beforeEach(() => freshDb());

function order(status: 'review' | 'confirmed' = 'confirmed', name = 'John Smith') {
  return createOrder(
    {
      customer: { new: { name } },
      source: 'manual',
      status,
      items: [
        { product_id: productId('beef_mince'), qty: { kind: 'weight', count: null, weight_g: 2000 } },
        { product_id: productId('beef_rump'), qty: { kind: 'count', count: 4, weight_g: null } },
      ],
      fulfilment_type: 'collection',
      requested_date: '2026-10-03',
    },
    STAFF,
  );
}

describe('state machine', () => {
  it('only permits valid transitions', () => {
    expect(canTransition('review', 'confirmed')).toBe(true);
    expect(canTransition('review', 'ready')).toBe(false);
    expect(canTransition('completed', 'cutting')).toBe(false);
    const o = order('review');
    expect(() => transition(o.id, 'packed', STAFF, 'staff')).toThrow(/can't move/);
  });

  it('requires a manager to cancel', () => {
    const o = order();
    expect(() => transition(o.id, 'cancelled', STAFF, 'staff')).toThrow(/manager/);
    expect(transition(o.id, 'cancelled', STAFF, 'manager').status).toBe('cancelled');
  });

  it('blocks confirmation while a blocking question is open', () => {
    const o = order('review');
    raiseException({ type: 'unknown_product', severity: 'blocking', title: 'x', order_id: o.id, payload: {} });
    expect(() => transition(o.id, 'confirmed', STAFF, 'staff')).toThrow(/Resolve/);
  });

  it('moves orders through production as physical work is recorded', () => {
    const o = order();
    const items = getItems(o.id);
    setItemsCut([items[0].id], true, STAFF);
    expect(requireOrder(o.id).status).toBe('cutting');
    setItemsCut([items[1].id], true, STAFF);
    expect(requireOrder(o.id).status).toBe('cut');
    setItemPacked(items[0].id, true, STAFF);
    expect(requireOrder(o.id).status).toBe('packing');
    expect(() => completePacking(o.id, STAFF)).toThrow(/Tick every item/);
    setItemPacked(items[1].id, true, STAFF, 2080);
    expect(completePacking(o.id, STAFF).status).toBe('ready');
    expect(transition(o.id, 'completed', STAFF, 'staff').status).toBe('completed');
  });
});

describe('amendments', () => {
  it('records before and after instead of overwriting silently', () => {
    const o = order();
    const mince = getItems(o.id).find((i) => i.product_name === 'Beef Mince')!;
    updateItem(mince.id, { qty: { kind: 'weight', count: null, weight_g: 3000 } }, STAFF, { reason: 'Customer message' });
    const ev = db().prepare("SELECT * FROM order_events WHERE order_id = ? AND type = 'item_amended'").get(o.id) as any;
    const data = JSON.parse(ev.data);
    expect(data.before.qty_label).toBe('2kg');
    expect(data.after.qty_label).toBe('3kg');
    expect(data.reason).toBe('Customer message');
  });

  it('sends an order back to cutting if a cut item changes', () => {
    const o = order();
    setItemsCut(getItems(o.id).map((i) => i.id), true, STAFF);
    expect(requireOrder(o.id).status).toBe('cut');
    updateItem(getItems(o.id)[0].id, { qty: { kind: 'weight', count: null, weight_g: 3000 } }, STAFF);
    expect(requireOrder(o.id).status).toBe('cutting');
  });

  it('rejects preparations the product does not offer', () => {
    const o = order();
    const rump = getItems(o.id).find((i) => i.product_name === 'Rump Steak')!;
    expect(() => updateItem(rump.id, { preparation: { Bone: 'Bone-in' } }, STAFF)).toThrow(/no "Bone" option/);
  });

  it('rejects impossible quantities', () => {
    expect(() =>
      createOrder({ customer: { new: { name: 'X' } }, source: 'manual', status: 'confirmed', items: [{ product_id: productId('chicken_whole'), qty: { kind: 'weight', count: null, weight_g: 2000 } }] }, STAFF),
    ).toThrow(/sold by the piece/);
  });
});

describe('cutting sheet', () => {
  it('adds up by product while keeping preparation differences and who needs what', () => {
    order('confirmed', 'A');
    order('confirmed', 'B');
    createOrder(
      { customer: { new: { name: 'C' } }, source: 'manual', status: 'confirmed', requested_date: '2026-10-03', items: [{ product_id: productId('beef_ribeye'), qty: { kind: 'count', count: 2, weight_g: null }, preparation: { Bone: 'Bone-in' } }, { product_id: productId('beef_ribeye'), qty: { kind: 'count', count: 3, weight_g: null } }] },
      STAFF,
    );
    order('review', 'Not confirmed yet');
    const sheet = cuttingSheet({});
    const line = (name: string, prep = '') => sheet.lines.find((l) => l.product_name === name && l.preparation_label === prep)!;
    expect(line('Beef Mince').total_label).toBe('4kg');
    expect(line('Rump Steak').total_label).toBe('8 steaks');
    expect(line('Beef Ribeye', 'Bone-in').total_label).toBe('2 steaks');
    expect(line('Beef Ribeye').total_label).toBe('3 steaks');
    expect(line('Beef Mince').orders.map((o) => o.customer_name).sort()).toEqual(['A', 'B']);
    expect(sheet.order_count).toBe(3);
  });
});

describe('exceptions', () => {
  it('resolving the last blocking question releases the order', () => {
    const o = createOrder({ customer: { new: { name: 'Mark' } }, source: 'import', status: 'needs_clarification', resume_status: 'confirmed', items: [{ product_id: productId('chicken_breast'), qty: { kind: 'weight', count: null, weight_g: 3000 } }] }, STAFF);
    const ex = raiseException({ type: 'unknown_product', severity: 'blocking', title: 'Unknown product: cowboy steaks', order_id: o.id, payload: { phrase: 'cowboy steaks', qty: { kind: 'count', count: 2, weight_g: null } } });
    resolveExceptionAction(ex, { action: 'map_product', product_id: productId('beef_ribeye'), preparation: { Bone: 'Bone-in' } }, STAFF, 'staff');
    const after = requireOrder(o.id);
    expect(after.status).toBe('confirmed');
    expect(getItems(o.id).map((i) => `${i.qty_label} ${i.product_name} ${i.preparation_label}`.trim())).toContain('2 steaks Beef Ribeye Bone-in');
    expect(listExceptions({ status: 'open' })).toHaveLength(0);
  });

  it('"Ask customer" keeps the question open', () => {
    const o = order('review');
    const ex = raiseException({ type: 'unclear_date', severity: 'warning', title: 'When?', order_id: o.id });
    const r = resolveExceptionAction(ex, { action: 'ask_customer', note: 'Which Saturday?' }, STAFF, 'staff');
    expect(r.status).toBe('open');
    expect(listExceptions({ status: 'open' })[0].payload.waiting_on_customer).toBeTruthy();
  });

  it('cancelling needs manager rights even from the exception queue', () => {
    const o = order();
    const ex = raiseException({ type: 'cancellation_request', severity: 'blocking', title: 'Cancel?', order_id: o.id });
    expect(() => resolveExceptionAction(ex, { action: 'confirm_cancel' }, STAFF, 'staff')).toThrow(/manager/);
    resolveExceptionAction(ex, { action: 'confirm_cancel' }, STAFF, 'manager');
    expect(requireOrder(o.id).status).toBe('cancelled');
  });
});

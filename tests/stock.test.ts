import { beforeEach, describe, expect, it } from 'vitest';
import { Client, freshDb, productId, signedIn, STAFF } from './helpers';
import { buildApp } from '../server/app';
import { db } from '../server/db/db';
import { createOrder } from '../server/domain/orders';
import { updateProduct } from '../server/domain/products';
import { listItems, planStock, seedStockOnce } from '../server/domain/stock';
import { addDays, localDate, weekdayOf } from '../server/lib/time';

beforeEach(() => freshDb('terram'));

const today = () => localDate(new Date(), 'Africa/Johannesburg');
const weekday = () => {
  for (let i = 2; i < 10; i++) if ([2, 3, 4, 5, 6].includes(weekdayOf(addDays(today(), i)))) return addDays(today(), i);
  throw new Error('no day');
};
const kg = (g: number) => ({ kind: 'weight' as const, count: null, weight_g: g });
const item = (name: string) => listItems().find((i) => i.name === name)!;

describe('stock', () => {
  it('starts with the usual carcass pieces and starting yields, once', () => {
    seedStockOnce();
    seedStockOnce();
    const names = listItems().map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['Beef hindquarter', 'Beef forequarter', 'Whole lamb carcass', 'Boerewors spice']));
    expect(names.filter((n) => n === 'Beef hindquarter')).toHaveLength(1);
    expect(item('Beef hindquarter').yield_count).toBeGreaterThan(8);
    // each shared part counts once
    const total = (db().prepare('SELECT SUM(pct) s FROM (SELECT MAX(pct) pct FROM stock_yields WHERE item_id = ? GROUP BY COALESCE(part, product_id))').get(item('Beef hindquarter').id) as any).s;
    expect(total).toBeLessThan(100);
  });

  it('receives a purchase into stock, learns the cost and weight, and counts a stock take', async () => {
    const m = await signedIn('manager');
    await m.get('/api/stock');
    const sup = (await m.post('/api/stock/suppliers', { name: 'Karoo Lamb Co', phone: '082 000 0000', supplies: 'Lamb' })).body.supplier;
    const hind = item('Beef hindquarter');
    const r = await m.post('/api/stock/purchases', {
      supplier_id: sup.id,
      ordered_on: today(),
      lines: [
        { item_id: hind.id, qty: 2, weight_kg: 170, cost_per: 'kg', unit_cost_cents: 8500 },
        { description: 'Abattoir fee', category: 'Abattoir & processing', qty: 1, unit_cost_cents: 45000 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.purchase.total_cents).toBe(170 * 8500 + 45000);
    expect(r.body.purchase.status).toBe('ordered');
    expect(item('Beef hindquarter').on_hand).toBe(0); // not in stock until received
    expect((await m.post(`/api/stock/purchases/${r.body.purchase.id}/receive`, {})).status).toBe(200);
    const after = item('Beef hindquarter');
    expect(after.on_hand).toBe(2);
    expect(after.cost_cents).toBe(Math.round((170 * 8500) / 2));
    expect(after.avg_weight_kg).toBe(85);
    expect((await m.post(`/api/stock/purchases/${r.body.purchase.id}/receive`, {})).status).toBe(409); // not twice

    const take = await m.post('/api/stock/take', { counts: [{ item_id: hind.id, counted: 1 }, { item_id: item('Boerewors spice').id, counted: 4.5 }] });
    expect(take.body).toMatchObject({ counted: 2, changed: 2 });
    expect(item('Beef hindquarter').on_hand).toBe(1);
    expect(item('Boerewors spice').on_hand).toBe(4.5);

    const overview = (await m.get('/api/stock')).body;
    expect(overview.spend.this_month_cents).toBe(170 * 8500 + 45000);
    expect(overview.by_category_90d.map((c: any) => c.category)).toEqual(expect.arrayContaining(['Beef', 'Abattoir & processing']));

    // Deleting a received purchase takes its stock off again
    expect((await m.req('DELETE', `/api/stock/purchases/${r.body.purchase.id}`)).status).toBe(200);
    expect(item('Beef hindquarter').on_hand).toBe(0);
  });

  it('works out how many hindquarters the open orders need, and what extra they give', () => {
    seedStockOnce();
    const hind = item('Beef hindquarter');
    db().prepare('UPDATE stock_items SET on_hand = 1, cost_cents = 700000 WHERE id = ?').run(hind.id);
    // 10 kg of rump; a hindquarter (85 kg) gives 7% rump = 5.95 kg → 2 hindquarters, 1 on hand → order 1
    createOrder({ customer: { new: { name: 'Big Braai' } }, source: 'phone', status: 'confirmed', requested_date: addDays(today(), 3), items: [{ product_id: productId('beef_rump'), qty: kg(10000) }, { product_id: productId('beef_fillet'), qty: kg(2000) }] }, STAFF);
    // Rump steaks by count use the typical steak weight (300 g)
    createOrder({ customer: { new: { name: 'Steak Night' } }, source: 'phone', status: 'review', requested_date: addDays(today(), 4), items: [{ product_id: productId('beef_rump'), qty: { kind: 'count', count: 10, weight_g: null } }] }, STAFF);
    const plan = planStock({ from: addDays(today(), -30), to: addDays(today(), 6) });
    expect(plan.order_count).toBe(2);
    expect(plan.demand.find((d) => d.product_name === 'Rump')?.need_kg).toBe(13);
    const src = plan.sources.find((s) => s.name === 'Beef hindquarter')!;
    expect(src.driven_by?.product_name).toBe('Rump');
    expect(src.units_needed).toBe(3); // 13 / 5.95 = 2.18 → 3
    expect(src.on_hand).toBe(1);
    expect(src.to_order).toBe(2);
    expect(src.est_cost_cents).toBe(1_400_000);
    const fillet = src.outputs.find((o) => o.product_name === 'Fillet')!;
    expect(fillet.need_kg).toBe(2);
    expect(fillet.extra_kg).toBeCloseTo(3 * 85 * 0.025 - 2, 2);
  });

  it('lets cuts of the same part share it: tomahawk and rib-eye both come off the rib', () => {
    seedStockOnce();
    // Forequarter ≈ 95 kg, rib = 5% ≈ 4.75 kg. 2.4 kg tomahawk + 2 kg rib-eye = 4.4 kg → one forequarter, not three
    createOrder({ customer: { new: { name: 'Rib Night' } }, source: 'phone', status: 'confirmed', requested_date: addDays(today(), 2), items: [{ product_id: productId('beef_tomahawk'), qty: kg(2400) }, { product_id: productId('beef_ribeye'), qty: kg(2000) }] }, STAFF);
    const plan = planStock({ from: null, to: null });
    const fore = plan.sources.find((s) => s.name === 'Beef forequarter')!;
    expect(fore.units_needed).toBe(1);
    expect(fore.driven_by?.product_name).toMatch(/^Rib \((Tomahawk, Rib-Eye|Rib-Eye, Tomahawk)\)$/);
    const rib = fore.outputs.find((o) => o.part === 'Rib')!;
    expect(rib.need_kg).toBe(4.4);
    expect(rib.members).toEqual(expect.arrayContaining(['Tomahawk', 'Rib-Eye', 'Rib-Eye on the Bone']));
  });

  it('counts a shared part once towards the 100%', async () => {
    const m = await signedIn('manager');
    await m.get('/api/stock');
    const fore = item('Beef forequarter');
    const ok = await m.req('PUT', `/api/stock/items/${fore.id}/yields`, { rows: [{ product_id: productId('beef_ribeye'), pct: 60, part: 'Rib' }, { product_id: productId('beef_tomahawk'), pct: 60, part: 'Rib' }, { product_id: productId('beef_brisket'), pct: 30 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.yields.every((y: any) => y.part === 'Rib' ? y.pct === 60 : true)).toBe(true);
  });

  it('plans a whole lamb straight from the lamb carcasses, and flags products with no source', () => {
    seedStockOnce();
    createOrder({ customer: { new: { name: 'Spit Braai' } }, source: 'phone', status: 'confirmed', requested_date: addDays(today(), 2), items: [{ product_id: productId('lamb_whole'), qty: { kind: 'count', count: 2, weight_g: null } }, { product_id: productId('eggs'), qty: { kind: 'count', count: 30, weight_g: null } }] }, STAFF);
    const plan = planStock({ from: null, to: null });
    const lamb = plan.sources.find((s) => s.name === 'Whole lamb carcass')!;
    expect(lamb.direct_units).toBe(2);
    expect(lamb.to_order).toBe(2);
    expect(plan.demand.find((d) => d.product_name === 'Eggs')?.unknown_pieces).toBe(30);
  });

  it('keeps costs and purchases to managers; staff can count; viewers only look', async () => {
    const staff = await signedIn('staff');
    const items = (await staff.get('/api/stock/items')).body.items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).not.toHaveProperty('cost_cents');
    expect((await staff.get('/api/stock')).body.spend).toBeNull();
    expect((await staff.get('/api/stock/purchases')).status).toBe(403);
    expect((await staff.post('/api/stock/suppliers', { name: 'X' })).status).toBe(403);
    expect((await staff.post(`/api/stock/items/${items[0].id}/move`, { kind: 'used', qty: 0 })).status).toBe(200);
    const viewer = await signedIn('viewer');
    expect((await viewer.get('/api/stock/plan')).status).toBe(200);
    expect((await viewer.post('/api/stock/take', { counts: [{ item_id: items[0].id, counted: 1 }] })).status).toBe(403);
  });

  it('rejects yields that add up to more than the whole piece', async () => {
    const m = await signedIn('manager');
    await m.get('/api/stock');
    const hind = item('Beef hindquarter');
    const r = await m.req('PUT', `/api/stock/items/${hind.id}/yields`, { rows: [{ product_id: productId('beef_rump'), pct: 60 }, { product_id: productId('beef_fillet'), pct: 50 }] });
    expect(r.status).toBe(400);
    const typical = await m.post(`/api/stock/items/${hind.id}/suggest-yields`, {});
    expect(typical.body.source).toBe('typical');
    expect(typical.body.rows.length).toBeGreaterThan(5);
  });
});

describe('deleting customers', () => {
  it('lets managers delete a customer with their orders and messages; staff cannot', async () => {
    const o = createOrder({ customer: { new: { name: 'Test Person', phone: '0710000000' } }, source: 'phone', status: 'confirmed', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    db().prepare("INSERT INTO messages (id, channel, direction, customer_id, order_id, body, received_at, status, created_at) VALUES ('ms_t1','whatsapp','in',?,?,'hi','2026-01-01','processed','2026-01-01')").run(o.customer_id, o.id);
    const staff = await signedIn('staff');
    expect((await staff.req('DELETE', `/api/customers/${o.customer_id}`)).status).toBe(403);
    const m = await signedIn('manager');
    const r = await m.req('DELETE', `/api/customers/${o.customer_id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Test Person', orders: 1 });
    expect(db().prepare('SELECT COUNT(*) n FROM customers WHERE id = ?').get(o.customer_id)).toEqual({ n: 0 });
    expect(db().prepare('SELECT COUNT(*) n FROM orders WHERE id = ?').get(o.id)).toEqual({ n: 0 });
    expect(db().prepare("SELECT COUNT(*) n FROM messages WHERE id = 'ms_t1'").get()).toEqual({ n: 0 });
    expect((db().prepare("SELECT summary FROM audit_log WHERE action = 'customer.deleted'").get() as any).summary).toBe('Deleted customer Test Person and 1 order');
  });

  it('deletes several at once', async () => {
    const a = createOrder({ customer: { new: { name: 'Test A' } }, source: 'phone', status: 'review', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    const b = createOrder({ customer: { new: { name: 'Test B' } }, source: 'phone', status: 'review', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    const m = await signedIn('manager');
    const r = await m.post('/api/customers/delete', { ids: [a.customer_id, b.customer_id] });
    expect(r.body).toMatchObject({ customers: 2, orders: 2 });
    expect((db().prepare('SELECT COUNT(*) n FROM customers').get() as any).n).toBe(0);
  });
});

describe('out of stock on the order form', () => {
  it('lists an out-of-stock product as out of stock, and won’t take an order for it', async () => {
    updateProduct(productId('beef_fillet'), { active: false }, STAFF);
    updateProduct(productId('beef_tomahawk'), { active: false, customer_visible: false }, STAFF);
    const c = new Client(buildApp());
    const cat = (await c.get('/api/public/catalogue')).body.products;
    expect(cat.find((p: any) => p.name === 'Fillet')).toMatchObject({ out_of_stock: true });
    expect(cat.find((p: any) => p.name === 'Rump')).toMatchObject({ out_of_stock: false });
    expect(cat.find((p: any) => p.name === 'Tomahawk')).toBeUndefined();
    const r = await c.post('/api/public/orders', {
      customer: { name: 'Naledi Zulu', phone: '071 555 3380' },
      items: [{ product_id: productId('beef_fillet'), qty: kg(1000) }],
      delivery_address: '12 Kerk Street, Pretoria',
      requested_date: weekday(),
      client_ref: 'ref-oos-000001',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Fillet is out of stock/);
  });
});

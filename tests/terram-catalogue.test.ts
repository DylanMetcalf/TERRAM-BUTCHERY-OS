import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, STAFF } from './helpers';
import { analyseImport, getBatch } from '../server/intelligence/imports';
import { listProducts, upgradeCatalogue } from '../server/domain/products';
import { createOrder } from '../server/domain/orders';
import { Client, productId, signedIn } from './helpers';
import { buildApp } from '../server/app';
import { db } from '../server/db/db';
import { addDays, localDate, weekdayOf } from '../server/lib/time';
import { CATALOGUE } from '../server/seed/catalogue';

beforeEach(() => freshDb('terram'));

const DEFAULTS = new Set(['Standard', 'Standard pack', 'Coil', 'Whole sticks', 'Normal', 'Whole', 'Steaks', 'Sliced', 'Bone-in']);

const read = async (text: string) => {
  const b = getBatch(await analyseImport({ text, useAi: false }, STAFF));
  return b.drafts
    .filter((d) => d.kind === 'order')
    .flatMap((d) =>
      (d.data as any).items.map((i: any) => {
        const preps = Object.values(i.preparation ?? {}).filter((v) => !DEFAULTS.has(v as string));
        return `${i.qty_label} ${i.product_name}${preps.length ? ` [${preps.join(', ')}]` : ''}`;
      }),
    );
};

describe("Terram's price list as the product dictionary", () => {
  it('has every product from the beef and lamb price lists at the listed price', () => {
    const byName = new Map(listProducts().map((p) => [p.canonical_name, p]));
    const expected: [string, number][] = [
      ['Fillet', 280], ['Fillet on the Bone', 270], ['Rump', 185], ['Sirloin', 160], ['T-Bone', 180], ['Rib-Eye', 240], ['Rib-Eye on the Bone', 220], ['Tomahawk', 220], ['Porterhouse', 180],
      ['Chuck Chops', 110], ['Short Rib', 135], ['Minute Steak', 160], ['Beef Shin', 130], ['Brisket', 130], ['Blade Chops', 130],
      ['Lean Mince', 125], ['80:20 Mince', 110], ['Normal Wors', 120], ['BBQ Wors', 100],
      ['Stewing (Bone-In)', 100], ['Bones', 25], ['Goulash', 135],
      ['A-Grade Biltong', 340], ['Geel Vet Biltong', 320], ['Droewors', 340],
      ['Skilpadjies', 95], ['Smoked Brisket (Marinated)', 450], ['Brisket Fat', 130], ['Body Fat', 80],
      ['Whole Lamb', 140], ['Half Lamb', 145], ['Lamb Shoulder', 210], ['Leg of Lamb', 225],
      ['Lamb Loin Chops', 265], ['Lamb Rib Chops', 260], ['Lamb Shoulder Chops', 235],
      ['Lamb Shanks', 240], ['Lamb Ribs', 230], ['Lamb Tails', 200], ['Lamb Stew', 175], ['Whole Sheep', 135], ['Eggs', 2.5],
    ];
    for (const [name, rand] of expected) expect(byName.get(name)?.price_cents, name).toBe(rand * 100);
    expect(listProducts()).toHaveLength(CATALOGUE.length);
  });

  it('reads everyday wording onto the right products', async () => {
    expect(
      await read(`John Smith:
2kg lean mince
1kg 80/20 mince
3 x 500g 80:20 mince
4 rumps dry aged
2 ribeye bone in
1 tomahawk
3kg boerewors
2kg bbq wors
1kg droewors
500g geel vet biltong
1 leg of lamb deboned
6 lamb chops
4 shoulder chops
2kg lamb ribs
half a lamb
2 trays of eggs
3kg goulash
bones 2kg`),
    ).toEqual([
      '2kg Lean Mince',
      '1kg 80:20 Mince',
      '3 × 500g 80:20 Mince',
      '4 steaks Rump [Dry-aged]',
      '2 steaks Rib-Eye on the Bone',
      '1 steak Tomahawk',
      '3kg Normal Wors',
      '2kg BBQ Wors',
      '1kg Droewors',
      '500g Geel Vet Biltong',
      '1 leg Leg of Lamb [Deboned & rolled]',
      '6 chops Lamb Loin Chops',
      '4 chops Lamb Shoulder Chops',
      '2kg Lamb Ribs',
      '1 half lamb Half Lamb',
      '60 eggs Eggs',
      '3kg Goulash',
      '2kg Bones',
    ]);
  });

  it('asks instead of guessing when a word fits more than one product', async () => {
    const b = getBatch(await analyseImport({ text: 'Sarah:\n2kg mince\n1kg biltong', useAi: false }, STAFF));
    const order = b.drafts.find((d) => d.kind === 'order')!;
    expect(order.status).not.toBe('ready');
    const questions = b.drafts.flatMap((d) => (d.data as any).issues ?? []).concat((order.data as any).items.flatMap((i: any) => i.issues ?? []));
    expect(JSON.stringify(questions) + JSON.stringify(order.data)).toMatch(/Lean Mince[\s\S]*80:20 Mince|80:20 Mince[\s\S]*Lean Mince/);
  });

  it('moves an install that started on the generic starter list onto Terram’s list', () => {
    freshDb('test'); // old starter products, no orders yet
    upgradeCatalogue();
    expect(listProducts().map((p) => p.slug).sort()).toEqual(CATALOGUE.map((p) => p.slug).sort());
    upgradeCatalogue(); // runs once
    expect(listProducts()).toHaveLength(CATALOGUE.length);
  });

  it('keeps products used by existing orders and switches off the ones Terram doesn’t sell', () => {
    freshDb('test');
    createOrder({ customer: { new: { name: 'Jane' } }, source: 'phone', status: 'confirmed', items: [{ product_id: productId('pork_belly'), qty: { kind: 'weight', count: null, weight_g: 1000 } }] }, STAFF);
    upgradeCatalogue();
    const bySlug = new Map(listProducts().map((p) => [p.slug, p]));
    expect(bySlug.get('pork_belly')?.active).toBe(false);
    expect(bySlug.get('beef_rump')?.canonical_name).toBe('Rump');
    expect(bySlug.get('beef_rump')?.price_cents).toBe(18500);
    expect(bySlug.get('wors_normal')?.active).toBe(true);
    expect(bySlug.get('wors_normal')?.aliases.map((a) => a.alias)).toContain('wor');
  });

  it('“make the mince 3kg” means the one mince already ordered', async () => {
    expect(await read('Thabo:\n2kg lean mince\n4 rumps\n\nThabo: actually make the mince 3kg')).toEqual(['3kg Lean Mince', '4 steaks Rump']);
  });

  it('phrases the question as a choice', async () => {
    const b = getBatch(await analyseImport({ text: 'Sarah:\n2kg mince\n1kg biltong sliced', useAi: false }, STAFF));
    const msgs = (b.drafts[0].data as any).issues.map((i: any) => i.message);
    expect(msgs).toContain('Which “mince”? Lean Mince or 80:20 Mince.');
    expect(msgs).toContain('Which “biltong sliced”? A-Grade Biltong or Geel Vet Biltong.');
  });

  it('eggs are sold per egg: trays are 30, dozens are 12', async () => {
    expect(await read('Sarah:\na tray of eggs\n2 dozen eggs\n\nJohn:\n45 eggs\n\nMary:\n3 trays eggs')).toEqual(['30 eggs Eggs', '24 eggs Eggs', '45 eggs Eggs', '90 eggs Eggs']);
  });

  it('pasted egg orders that aren’t whole trays are flagged', async () => {
    const msgs = async (text: string) => (getBatch(await analyseImport({ text, useAi: false }, STAFF)).drafts[0].data as any).issues.map((i: any) => i.message);
    expect(await msgs('Sarah:\n12 eggs')).toContain('Eggs are sold in lots of 30 (30, 60, 90…). This asks for 12 eggs.');
    expect(await msgs('Sarah:\n45 eggs')).toContain('Eggs are sold in lots of 30 (30, 60, 90…). This asks for 45 eggs.');
    expect((await msgs('Sarah:\n2 trays of eggs\nCollect Saturday')).filter((m: string) => /lots of/.test(m))).toEqual([]);
  });
});

describe('customer order form', () => {
  const day = () => {
    const today = localDate(new Date(), 'Africa/Johannesburg');
    for (let i = 2; i < 10; i++) if ([2, 3, 4, 5, 6].includes(weekdayOf(addDays(today, i)))) return addDays(today, i);
    throw new Error('no day');
  };
  const order = (ref: string, extra: any) => ({ customer: { name: 'Naledi Zulu', phone: '071 555 3380' }, items: [], fulfilment_type: 'collection', delivery_address: '12 Kerk Street, Pretoria', requested_date: day(), client_ref: ref, ...extra });
  const eggs = (count: number) => ({ product_id: productId('eggs'), qty: { kind: 'count', count, weight_g: null } });

  it('only takes eggs in whole trays of 30', async () => {
    const c = new Client(buildApp());
    for (const [n, ok] of [[12, false], [45, false], [30, true], [90, true]] as const) {
      const r = await c.post('/api/public/orders', order(`ref-eggs-00${n}`, { items: [eggs(n)] }));
      expect(r.status, `${n} eggs`).toBe(ok ? 200 : 400);
      if (!ok) expect(r.body.error).toMatch(/sold in lots of 30/);
    }
  });

  it('takes a special request on its own and sends it to Needs attention', async () => {
    const c = new Client(buildApp());
    expect((await c.post('/api/public/orders', order('ref-spec-0000', {}))).status).toBe(400); // nothing at all
    const r = await c.post('/api/public/orders', order('ref-spec-0001', { special_request: 'A whole lamb cut for a potjie and braai' }));
    expect(r.status).toBe(200);
    const o = db().prepare('SELECT status, special_request FROM orders').get() as any;
    expect(o).toEqual({ status: 'needs_clarification', special_request: 'A whole lamb cut for a potjie and braai' });
    const e = db().prepare("SELECT type, severity, title FROM exceptions WHERE type = 'special_request'").get() as any;
    expect(e.title).toMatch(/Special request on order #\d+/);
    expect(e.severity).toBe('blocking');
  });

  it('keeps normal items and flags the special request alongside them', async () => {
    const c = new Client(buildApp());
    await c.post('/api/public/orders', order('ref-spec-0002', { items: [eggs(60)], special_request: 'Could you add 2kg dog bones?' }));
    expect((db().prepare('SELECT status FROM orders').get() as any).status).toBe('review');
    expect((db().prepare("SELECT severity FROM exceptions WHERE type = 'special_request'").get() as any).severity).toBe('warning');
  });

  it('asks only for an address by default, and lets customers choose when switched on', async () => {
    const c = new Client(buildApp());
    const ip = { 'x-forwarded-for': '203.0.113.77' }; // its own rate-limit bucket
    const noAddress = await c.post('/api/public/orders', order('ref-mode-0001', { items: [eggs(30)], delivery_address: null }), ip);
    expect(noAddress.status).toBe(400);
    expect(noAddress.body.error).toMatch(/address/);
    expect((await c.post('/api/public/orders', order('ref-mode-0002', { items: [eggs(30)], fulfilment_type: 'delivery' }), ip)).status).toBe(200);
    const o = db().prepare("SELECT fulfilment_type, delivery_address FROM orders ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(o).toEqual({ fulfilment_type: null, delivery_address: '12 Kerk Street, Pretoria' }); // the family arranges it

    const admin = await signedIn('admin');
    expect((await admin.req('PUT', '/api/admin/settings/fulfilment', { customerChooses: true })).status).toBe(200);
    expect((await c.post('/api/public/orders', order('ref-mode-0003', { items: [eggs(30)], delivery_address: null }), ip)).status).toBe(200);
    expect((db().prepare("SELECT fulfilment_type FROM orders ORDER BY created_at DESC LIMIT 1").get() as any).fulfilment_type).toBe('collection');
    const info = await c.get('/api/public/info');
    expect(info.body.fulfilment.customerChooses).toBe(true);
    expect(info.body.form.noticeNote).toMatch(/7–14 days/);
  });
});

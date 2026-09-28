import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, STAFF } from './helpers';
import { analyseImport, getBatch } from '../server/intelligence/imports';
import { listProducts, upgradeCatalogue } from '../server/domain/products';
import { createOrder } from '../server/domain/orders';
import { productId } from './helpers';
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
      ['Lamb Shanks', 240], ['Lamb Ribs', 230], ['Lamb Tails', 200], ['Lamb Stew', 175], ['Whole Sheep', 135], ['Tray of 30 Eggs', 60],
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
      '2 trays Tray of 30 Eggs',
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
});

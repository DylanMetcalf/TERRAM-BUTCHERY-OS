import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, productId, STAFF } from './helpers';
import { applyPrices, previewPrices } from '../server/domain/prices';
import { getProduct } from '../server/domain/products';

beforeEach(() => freshDb());

describe('price list import', () => {
  it('reads the usual ways a price list is written', () => {
    const lines = previewPrices(
      [
        'PRODUCT\tPRICE',
        'Beef Mince R149.99/kg',
        'Rump steak - R 275,00 per kg',
        'Ribeye (bone in)  R320',
        'Burger patties 200g R32 each',
        'Boerewors,165',
        'Wors 1kg pack R165',
        'Cowboy steak R350/kg',
        'Lamb chops',
      ].join('\n'),
    );
    const got = lines.map((l) => [l.product_name, l.new_cents, l.new_unit, l.status]);
    expect(got).toEqual([
      ['Beef Mince', 14999, 'kg', 'change'],
      ['Rump Steak', 27500, 'kg', 'change'],
      ['Beef Ribeye', 32000, 'kg', 'change'],
      ['Beef Burger Patties', 3200, 'each', 'change'],
      ['Boerewors', 16500, 'kg', 'change'],
      ['Boerewors', 16500, 'kg', 'duplicate'],
      [null, 35000, null, 'unmatched'],
      ['Lamb Loin Chops', null, 'kg', 'no_price'],
    ]);
  });

  it('only changes prices when confirmed, and records it', () => {
    const pid = productId('beef_mince');
    const before = getProduct(pid)!.price_cents;
    previewPrices('Beef Mince R150/kg');
    expect(getProduct(pid)!.price_cents).toBe(before);
    applyPrices([{ product_id: pid, price_cents: 15000, price_unit: 'kg' }], STAFF);
    expect(getProduct(pid)!.price_cents).toBe(15000);
  });
});

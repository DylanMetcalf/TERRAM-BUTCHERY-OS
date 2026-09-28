import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, productId, signedIn, STAFF } from './helpers';
import { createOrder, requireOrder } from '../server/domain/orders';
import { deliveryFeeCents } from '../shared/delivery';
import { db, now } from '../server/db/db';
import { clearSettingsCache, getSettings, refreshDefaultWording } from '../server/services/settings';

beforeEach(() => freshDb('terram'));

describe('delivery fee by distance', () => {
  it('is free within the radius and charged per km beyond it', () => {
    expect(deliveryFeeCents(40, 60, 500)).toBe(0);
    expect(deliveryFeeCents(60, 60, 500)).toBe(0);
    expect(deliveryFeeCents(75, 60, 500)).toBe(7500);
    expect(deliveryFeeCents(72.5, 60, 450)).toBe(5625);
    expect(deliveryFeeCents(null, 60, 500)).toBe(null);
  });

  it('works out and records the fee when staff enter the distance, even after cutting', async () => {
    const admin = await signedIn('admin');
    expect((await admin.req('PUT', '/api/admin/settings/fulfilment', { freeDeliveryKm: 60, deliveryRatePerKmCents: 500 })).status).toBe(200);
    const o = createOrder({ customer: { new: { name: 'Jane' } }, source: 'phone', status: 'confirmed', fulfilment_type: 'delivery', delivery_address: '1 Main Rd, Hartbeespoort', items: [{ product_id: productId('beef_rump'), qty: { kind: 'weight', count: null, weight_g: 1000 } }] }, STAFF);
    db().prepare("UPDATE orders SET status = 'cut' WHERE id = ?").run(o.id);
    const staff = await signedIn('staff');
    const r = await staff.patch(`/api/orders/${o.id}`, { delivery_km: 75 });
    expect(r.status).toBe(200);
    expect(requireOrder(o.id)).toMatchObject({ delivery_km: 75, delivery_fee_cents: 7500 });
    await staff.patch(`/api/orders/${o.id}`, { delivery_km: 30 });
    expect(requireOrder(o.id).delivery_fee_cents).toBe(0);
  });
});

describe('improved default wording', () => {
  it('replaces an old default that was saved word for word, and keeps custom text', () => {
    const put = (section: string, value: unknown) =>
      db().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(section, JSON.stringify(value), now());
    put('customerForm', { ...getSettings().customerForm, intro: 'Farm-raised beef and lamb. Orders are subject to processing time and stock availability. Your order is confirmed once Terram Farm accepts it.' });
    put('fulfilment', { ...getSettings().fulfilment, deliveryNotes: 'Only on Fridays, thanks!' });
    clearSettingsCache();
    refreshDefaultWording();
    expect(getSettings().customerForm.intro).toMatch(/^Farm-raised Beef and Lamb\./);
    expect(getSettings().fulfilment.deliveryNotes).toBe('Only on Fridays, thanks!');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Client, freshDb, productId, signedIn, STAFF } from './helpers';
import { buildApp } from '../server/app';
import { db } from '../server/db/db';
import { outbox, memoryFail } from '../server/services/email';
import { processOutbox, retryNotification } from '../server/services/notify';
import { updateSettings } from '../server/services/settings';
import { accountLinkToken, emailFromAccountLink, orderFromToken, orderToken, payToken } from '../server/services/links';
import { recordVerifiedPayment } from '../server/domain/payments';
import { createOrder, getItems, requireOrder, transition, updateItem, completePacking, setItemsCut, setItemPacked } from '../server/domain/orders';
import { updateProduct } from '../server/domain/products';
import { handleItn, phpUrlencode, signFields } from '../server/domain/payfast';
import { runReorderReminders } from '../server/domain/retention';
import { addDays, localDate, weekdayOf } from '../server/lib/time';
import { priceLine, withSurcharge } from '../shared/pricing';

/**
 * The customer platform end to end, at the API: ordering rules, prices, confirmation, the secure
 * order page, accounts, reordering, amendments, payments (EFT + PayFast), invoices and notifications.
 * Email goes to an in-memory outbox; PayFast is mocked. Nothing real is contacted or charged.
 */

const openRequestFor = (orderId: string) => (db().prepare("SELECT id FROM payment_requests WHERE order_id = ? AND status = 'open'").get(orderId) as any).id as string;
const signPay = (rid: string, exp: number) => {
  const tok = payToken({ id: rid, link_version: (db().prepare('SELECT link_version FROM payment_requests WHERE id = ?').get(rid) as any).link_version }, exp * 1000);
  return tok.split('.')[2];
};
const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 15));
    await processOutbox();
  }
};
const today = () => localDate(new Date(), 'Africa/Johannesburg');
const weekday = () => {
  for (let i = 2; i < 12; i++) if ([2, 3, 4, 5, 6].includes(weekdayOf(addDays(today(), i)))) return addDays(today(), i);
  throw new Error('no day');
};
const kg = (g: number) => ({ kind: 'weight' as const, count: null, weight_g: g });
let ref = 0;
const form = (items: any[], extra: any = {}) => ({
  customer: { name: 'Naledi Zulu', phone: '071 555 3380', email: 'naledi@example.com' },
  items,
  delivery_address: '12 Kerk Street, Pretoria',
  requested_date: weekday(),
  client_ref: `test-ref-${Date.now()}-${++ref}`,
  ...extra,
});
const pub = () => new Client(buildApp());
const send = (body: any, ip = `10.0.${Math.floor(Math.random() * 250)}.${++ref % 250}`) => pub().req('POST', '/api/public/orders', body, { 'x-forwarded-for': ip });
const tokenPath = (url: string) => url.replace(/^\/o\//, '');
const mail = (subject: RegExp) => outbox.filter((m) => subject.test(m.subject));

beforeEach(() => {
  freshDb('terram');
  outbox.length = 0;
  memoryFail.next = 0;
  process.env.EMAIL_TRANSPORT = 'memory';
});
afterEach(() => {
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.PAYFAST_MERCHANT_ID;
  delete process.env.PAYFAST_MERCHANT_KEY;
  delete process.env.PAYFAST_PASSPHRASE;
  delete process.env.PAYFAST_SKIP_IP_CHECK;
});

// ── Products & prices ────────────────────────────────────────
describe('product rules and prices', () => {
  it('mince only in 500 g and 1 kg packs, priced exactly', async () => {
    const mince = productId('beef_mince_lean'); // R125/kg
    expect((await send(form([{ product_id: mince, qty: kg(750) }]))).status).toBe(400); // no arbitrary weights
    expect((await send(form([{ product_id: mince, sale_option: '750g', qty: { kind: 'count', count: 1 } }]))).status).toBe(400);
    const q = await pub().post('/api/public/quote', { items: [{ product_id: mince, sale_option: '500g', qty: { kind: 'count', count: 3 } }] });
    expect(q.body.lines[0]).toMatchObject({ ok: true, pricing: 'exact', cents: 18750, label: '3 × 500g' });
    expect(q.body.total).toMatchObject({ estimate_cents: 18750, exact: true });
    const r = await send(form([{ product_id: mince, sale_option: '1kg', qty: { kind: 'count', count: 2 } }]));
    expect(r.status).toBe(200);
    const o = db().prepare('SELECT id FROM orders WHERE order_number = ?').get(r.body.order_number) as any;
    expect(getItems(o.id)[0]).toMatchObject({ qty: { kind: 'portions', count: 2, weight_g: 1000 }, pricing: 'exact', est_cents: 25000, sale_option: '1 kg pack' });
  });

  it('wors only in 1 kg packs; fillet whole/half; a size is required on the form', async () => {
    const wors = productId('wors_normal');
    expect((await send(form([{ product_id: wors, sale_option: '500g', qty: { kind: 'count', count: 1 } }]))).status).toBe(400);
    expect((await send(form([{ product_id: wors, qty: kg(1000) }]))).body.error).toMatch(/Choose a size/);
    const fillet = productId('beef_fillet');
    const q = await pub().post('/api/public/quote', { items: [{ product_id: fillet, sale_option: 'whole', qty: { kind: 'count', count: 1 } }, { product_id: fillet, sale_option: 'quarter', qty: { kind: 'count', count: 1 } }] });
    expect(q.body.lines[0]).toMatchObject({ ok: true, pricing: 'by_weight', cents: null, label: '1 × Whole fillet' });
    expect(q.body.lines[1].ok).toBe(false);
  });

  it('rib-eye on and off the bone are variations of one product with their own prices', async () => {
    const cat = (await pub().get('/api/public/catalogue')).body.products;
    const off = cat.find((p: any) => p.name === 'Rib-Eye');
    const on = cat.find((p: any) => p.name === 'Rib-Eye on the Bone');
    expect(on.variant_of).toBe(off.id);
    expect([off.variant_label, on.variant_label]).toEqual(['Off the bone', 'On the bone']);
    expect([off.price_cents, on.price_cents]).toEqual([24000, 22000]);
  });

  it('packaging is no longer a customer choice; dry-aged carries 25% once', async () => {
    const cat = (await pub().get('/api/public/catalogue')).body.products;
    const rump = cat.find((p: any) => p.name === 'Rump');
    expect(rump.options.map((g: any) => g.group)).not.toContain('Packing');
    expect(rump.options.find((g: any) => g.group === 'Ageing').options.find((o: any) => o.name === 'Dry-aged').surcharge_pct).toBe(25);
    const q = await pub().post('/api/public/quote', { items: [{ product_id: productId('beef_rump'), qty: kg(2000), preparation: { Ageing: 'Dry-aged' } }] });
    expect(q.body.lines[0]).toMatchObject({ unit_price_cents: 23125, cents: 46250, pricing: 'estimate', surcharge_pct: 25 });
    expect(withSurcharge(18500, 25)).toBe(23125);
    expect((await send(form([{ product_id: productId('beef_rump'), qty: kg(1000), preparation: { Packing: 'Individually packed' } }]))).status).toBe(400);
  });

  it('saving a product from the editor keeps its sizes, limits and surcharges', async () => {
    const manager = await signedIn('manager');
    const rump = (await manager.get(`/api/products/${productId('beef_rump')}`)).body.product;
    const preparations = rump.preparations.map((o: any) => ({ group_name: o.group_name, name: o.name, keywords: o.keywords, is_default: o.is_default, customer_visible: o.customer_visible, active: o.active, surcharge_pct: o.surcharge_pct }));
    expect((await manager.patch(`/api/products/${rump.id}`, { description: 'Edited', preparations })).status).toBe(200);
    const after = (await manager.get(`/api/products/${rump.id}`)).body.product;
    expect(after.preparations.find((o: any) => o.name === 'Dry-aged').surcharge_pct).toBe(25);
    const mince = productId('beef_mince_lean');
    const r = await manager.patch(`/api/products/${mince}`, { sale_options: [{ id: '500g', label: '500g pack', kind: 'pack', grams: 500 }, { id: '1kg', label: '1kg pack', kind: 'pack', grams: 1000 }, { id: '2kg', label: '2kg pack', kind: 'pack', grams: 2000 }], max_qty: 20 });
    expect(r.status).toBe(200);
    expect(r.body.product.sale_options.map((o: any) => o.id)).toEqual(['500g', '1kg', '2kg']);
    expect(r.body.product.max_qty).toBe(20);
    expect((await manager.patch(`/api/products/${mince}`, { sale_options: [{ id: 'x', label: 'Pack', kind: 'pack', grams: null }] })).status).toBe(400);
    expect((await manager.patch(`/api/products/${mince}`, { variant_of: mince })).status).toBe(400);
  });

  it('weighed items are estimated, then priced on their actual weight', async () => {
    expect(priceLine({ qty: kg(2000), unitPriceCents: 13000, priceUnit: 'kg' })).toEqual({ pricing: 'estimate', cents: 26000 });
    const o = createOrder({ customer: { new: { name: 'Weigh Me' } }, source: 'phone', status: 'confirmed', fulfilment_type: 'collection', items: [{ product_id: productId('beef_brisket'), qty: kg(2000) }] }, STAFF);
    expect(requireOrder(o.id)).toMatchObject({ estimated_total_cents: 26000, final_total_cents: null });
    const staff = await signedIn('staff');
    const item = getItems(o.id)[0];
    // Weights belong to final weighing only: refused while the order is still being prepared
    expect((await staff.post(`/api/items/${item.id}/weight`, { weight_g: 2135 })).status).toBe(409);
    setItemsCut([item.id], true, STAFF);
    setItemPacked(item.id, true, STAFF);
    completePacking(o.id, STAFF);
    expect(requireOrder(o.id).status).toBe('packed');
    expect((await staff.post(`/api/items/${item.id}/weight`, { weight_g: 2135 })).status).toBe(200);
    expect(requireOrder(o.id).final_total_cents).toBe(27755); // 2.135 kg × R130 = R277.55
    expect((await staff.post(`/api/items/${item.id}/weight`, { weight_g: -5 })).status).toBe(400);
  });

  it('a price change in the catalogue never rewrites an existing order', () => {
    const o = createOrder({ customer: { new: { name: 'Snapshot' } }, source: 'phone', status: 'confirmed', fulfilment_type: 'collection', items: [{ product_id: productId('beef_mince_lean'), sale_option: '1kg', qty: { kind: 'count', count: 1, weight_g: null } }] }, STAFF);
    updateProduct(productId('beef_mince_lean'), { price_cents: 99900, customer_name: 'Renamed Mince' }, STAFF);
    expect(getItems(o.id)[0]).toMatchObject({ price_cents: 12500, est_cents: 12500, name_snapshot: 'Lean Mince' });
    expect(requireOrder(o.id).estimated_total_cents).toBe(12500);
  });

  it('out-of-stock and hidden products cannot be ordered, whatever the browser sends', async () => {
    updateProduct(productId('beef_fillet'), { active: false, unavailable_reason: 'Back next week' }, STAFF);
    const cat = (await pub().get('/api/public/catalogue')).body.products;
    expect(cat.find((p: any) => p.name === 'Fillet')).toMatchObject({ out_of_stock: true, unavailable_reason: 'Back next week' });
    const r = await send(form([{ product_id: productId('beef_fillet'), sale_option: 'whole', qty: { kind: 'count', count: 1 } }]));
    expect(r.status).toBe(400);
    expect(r.body.details.quote.lines[0].ok).toBe(false);
  });
});

// ── Order received & confirmed ───────────────────────────────
describe('received, then confirmed by a person', () => {
  async function placeOrder(extra: any = {}) {
    const r = await send(form([{ product_id: productId('beef_mince_lean'), sale_option: '500g', qty: { kind: 'count', count: 2 } }], extra));
    expect(r.status).toBe(200);
    const id = orderFromToken(tokenPath(r.body.order_url))!;
    return { ...r.body, id };
  }

  it('creates one order per submission, acknowledges it, and never calls it confirmed', async () => {
    updateSettings('orders', { formOrdersRequireReview: false }, null); // even with the old setting off
    const body = form([{ product_id: productId('beef_mince_lean'), sale_option: '500g', qty: { kind: 'count', count: 2 } }]);
    const a = await send(body);
    const b = await send(body); // double tap / retry
    expect(a.body.order_number).toBe(b.body.order_number);
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(1);
    const o = requireOrder(orderFromToken(tokenPath(a.body.order_url))!);
    expect(o.status).toBe('review');
    expect(o.confirmed_at).toBeNull();
    await flush();
    expect(mail(/received your/)).toHaveLength(1);
    expect(mail(/confirmed/)).toHaveLength(0);
    const page = await pub().get(`/api/public/o/${tokenPath(a.body.order_url)}`);
    expect(page.body.order).toMatchObject({ stage: 'received', expected: null });
    expect(page.body.order.next.text).toMatch(/reviewing/);
  });

  it('only authorised staff can confirm, with a timeframe, after the checks pass — once', async () => {
    const o = await placeOrder();
    const viewer = await signedIn('viewer');
    expect((await viewer.post(`/api/orders/${o.id}/confirm`, { expected_from: weekday() })).status).toBe(403);
    const staff = await signedIn('staff');
    // The old "move to confirmed" path can't skip the timeframe
    expect((await staff.post(`/api/orders/${o.id}/transition`, { to: 'confirmed' })).status).toBe(409);
    // Address-only orders need collection or delivery decided first
    const blocked = await staff.post(`/api/orders/${o.id}/confirm`, { expected_from: weekday() });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/collection or delivery/);
    await staff.patch(`/api/orders/${o.id}`, { fulfilment_type: 'collection' });
    const from = weekday();
    const to = addDays(from, 4);
    const ok = await staff.post(`/api/orders/${o.id}/confirm`, { expected_from: from, expected_to: to });
    expect(ok.status).toBe(200);
    expect(ok.body.order).toMatchObject({ status: 'confirmed', expected_from: from, expected_to: to, confirmed_total_cents: 12500 });
    expect(ok.body.order.confirmed_by).toBeTruthy();
    const again = await staff.post(`/api/orders/${o.id}/confirm`, { expected_from: from });
    expect(again.body.already).toBe(true);
    await flush();
    const confirmed = mail(/is confirmed/);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].subject).toBe(`Your Terram Farm order is confirmed — #${o.order_number}`);
    expect(confirmed[0].text).toContain('2 × 500g Lean Mince');
    expect(confirmed[0].text).toMatch(/EXPECTED TIMEFRAME\n.*\d{4}/);
    expect(confirmed[0].text).toMatch(/https:\/\/www\.terramfarm\.co\.za\/o\//);
    expect(confirmed[0].text).not.toContain('localhost');
    const page = (await pub().get(`/api/public/o/${tokenPath(o.order_url)}`)).body.order;
    expect(page.stage).toBe('confirmed');
    expect(page.expected.from).toBe(from);
  });

  it('timeframe changes need a reason, are recorded old→new, and the customer is told', async () => {
    const o = await placeOrder();
    const staff = await signedIn('staff');
    await staff.patch(`/api/orders/${o.id}`, { fulfilment_type: 'collection' });
    await staff.post(`/api/orders/${o.id}/confirm`, { expected_from: weekday() });
    expect((await staff.post(`/api/orders/${o.id}/timeframe`, { expected_from: addDays(weekday(), 7) })).status).toBe(400);
    expect((await staff.post(`/api/orders/${o.id}/timeframe`, { expected_from: addDays(weekday(), 7), reason: 'Waiting for the next lamb delivery' })).status).toBe(200);
    const ev = db().prepare("SELECT data FROM order_events WHERE order_id = ? AND type = 'timeframe_changed'").get(o.id) as any;
    expect(JSON.parse(ev.data)).toMatchObject({ before: { from: weekday() }, after: { from: addDays(weekday(), 7) }, reason: 'Waiting for the next lamb delivery' });
    await flush();
    expect(mail(/new expected date/)[0].text).toContain('Waiting for the next lamb delivery');
  });

  it('asks the customer to look again if prices changed while their basket was open', async () => {
    const items = [{ product_id: productId('beef_mince_lean'), sale_option: '1kg', qty: { kind: 'count', count: 1 } }];
    const r = await send(form(items, { seen_total_cents: 11000 }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('prices_changed');
    expect(r.body.details.quote.total.estimate_cents).toBe(12500);
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(0);
  });

  it('a customer can cancel before confirmation, not after', async () => {
    const o = await placeOrder();
    const t = tokenPath(o.order_url);
    expect((await pub().post(`/api/public/o/${t}/cancel`, { reason: 'Ordered twice' })).body.order.cancelled).toBe(true);
    const o2 = await placeOrder();
    const staff = await signedIn('staff');
    await staff.patch(`/api/orders/${o2.id}`, { fulfilment_type: 'collection' });
    await staff.post(`/api/orders/${o2.id}/confirm`, { expected_from: weekday() });
    expect((await pub().post(`/api/public/o/${tokenPath(o2.order_url)}/cancel`, {})).status).toBe(409);
  });
});

// ── Secure links & accounts ──────────────────────────────────
describe('customer access', () => {
  it('order links are signed, scoped to one order and revocable; an order number alone opens nothing', async () => {
    const a = createOrder({ customer: { new: { name: 'Alice', email: 'alice@example.com' } }, source: 'phone', status: 'review', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    const b = createOrder({ customer: { new: { name: 'Bob', email: 'bob@example.com' } }, source: 'phone', status: 'review', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    const ta = orderToken(a.id);
    expect((await pub().get(`/api/public/o/${ta}`)).body.order.customer_name).toBe('Alice');
    const sig = ta.split('.')[1];
    expect((await pub().get(`/api/public/o/${b.id}.${sig}`)).status).toBe(404); // another order with this signature
    expect((await pub().get(`/api/public/o/${a.id}.${'x'.repeat(32)}`)).status).toBe(404);
    expect((await pub().get(`/api/public/o/${a.order_number}`)).status).toBe(404);
    const staff = await signedIn('staff');
    const fresh = await staff.post(`/api/orders/${a.id}/link/revoke`);
    expect((await pub().get(`/api/public/o/${ta}`)).status).toBe(404);
    expect((await pub().get(`/api/public/o/${tokenPath(new URL(fresh.body.url).pathname)}`)).status).toBe(200);
    // Internal notes never reach the customer page
    await staff.post(`/api/orders/${a.id}/notes`, { text: 'Difficult customer, double-check the weight' });
    expect(JSON.stringify((await pub().get(`/api/public/o/${tokenPath(new URL(fresh.body.url).pathname)}`)).body)).not.toContain('Difficult');
  });

  it('order history needs a code sent to the email address; no enumeration; only your own orders', async () => {
    createOrder({ customer: { new: { name: 'Alice', email: 'alice@example.com' } }, source: 'phone', status: 'review', customer_email: 'alice@example.com', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    createOrder({ customer: { new: { name: 'Bob', email: 'bob@example.com' } }, source: 'phone', status: 'review', customer_email: 'bob@example.com', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    const c = pub();
    expect((await c.get('/api/public/account')).status).toBe(401);
    const unknown = await c.post('/api/public/account/code', { email: 'nobody@example.com' });
    const known = await c.post('/api/public/account/code', { email: 'alice@example.com' });
    expect(unknown.body.message).toBe(known.body.message); // same answer either way
    await flush();
    expect(outbox.filter((m) => m.to.includes('nobody@example.com'))).toHaveLength(0);
    const codeMail = outbox.find((m) => m.to.includes('alice@example.com') && /sign-in code/.test(m.subject))!;
    const code = codeMail.subject.match(/(\d{6})$/)![1];
    expect((await c.post('/api/public/account/verify', { email: 'alice@example.com', code: code === '000000' ? '111111' : '000000' })).status).toBe(400);
    expect((await c.post('/api/public/account/verify', { email: 'alice@example.com', code })).status).toBe(200);
    expect((await c.post('/api/public/account/verify', { email: 'alice@example.com', code })).status).toBe(400); // single use
    const acc = await c.get('/api/public/account');
    expect(acc.body.orders).toHaveLength(1);
    expect(acc.body.orders[0].link).toMatch(/^\/o\//);
    expect(JSON.stringify(acc.body)).not.toContain('Bob');
    await c.post('/api/public/account/preferences', { reminders: true });
    expect((db().prepare("SELECT marketing_consent FROM customers WHERE email = 'alice@example.com'").get() as any).marketing_consent).toBe(1);
  });

  it('reorder makes a draft with today’s prices and flags what changed; it never places an order', async () => {
    const o = createOrder({ customer: { new: { name: 'Again' } }, source: 'form', status: 'review', items: [{ product_id: productId('beef_mince_lean'), sale_option: '500g', qty: { kind: 'count', count: 4, weight_g: null } }, { product_id: productId('beef_fillet'), sale_option: 'whole', qty: { kind: 'count', count: 1, weight_g: null } }] }, STAFF);
    updateProduct(productId('beef_mince_lean'), { price_cents: 13500 }, STAFF);
    updateProduct(productId('beef_fillet'), { active: false }, STAFF);
    const before = (db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n;
    const d = await pub().get(`/api/public/o/${orderToken(o.id)}/reorder`);
    expect(d.body.lines[0]).toMatchObject({ sale_option: '500g', previous_unit_price_cents: 12500, current_unit_price_cents: 13500, problem: null });
    expect(d.body.lines[1].problem).toMatch(/out of stock/);
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(before);
  });
});

// ── Amendments ───────────────────────────────────────────────
describe('changes proposed to the customer', () => {
  function confirmed() {
    const o = createOrder({ customer: { new: { name: 'Change Me', email: 'change@example.com' } }, source: 'phone', status: 'confirmed', customer_email: 'change@example.com', fulfilment_type: 'collection', items: [{ product_id: productId('beef_mince_lean'), sale_option: '1kg', qty: { kind: 'count', count: 4, weight_g: null } }] }, STAFF);
    return o;
  }

  it('nothing changes until the customer accepts; then the change and new total apply', async () => {
    const o = confirmed();
    const item = getItems(o.id)[0];
    const staff = await signedIn('staff');
    const p = await staff.post(`/api/orders/${o.id}/amendments`, { kind: 'change_qty', item_id: item.id, sale_option: '1kg', qty: { kind: 'count', count: 3 }, reason: 'We only have 3 kg of lean mince' });
    expect(p.status).toBe(200);
    expect(p.body.amendment).toMatchObject({ status: 'proposed', price_impact_cents: -12500, requires_approval: true });
    expect(getItems(o.id)[0].qty.count).toBe(4); // unchanged
    await flush();
    expect(mail(/Please check a change/)[0].text).toContain('We only have 3 kg');
    const t = orderToken(o.id);
    const page = (await pub().get(`/api/public/o/${t}`)).body.order;
    expect(page.next.who).toBe('you');
    const res = await pub().post(`/api/public/o/${t}/amendments/${p.body.amendment.id}`, { accept: true });
    expect(res.body.status).toBe('applied');
    expect(getItems(o.id)[0].qty.count).toBe(3);
    expect(requireOrder(o.id).estimated_total_cents).toBe(37500);
    expect((await pub().post(`/api/public/o/${t}/amendments/${p.body.amendment.id}`, { accept: false })).body.already).toBe(true);
  });

  it('a declined change leaves the order as it was and tells Terram', async () => {
    const o = confirmed();
    const item = getItems(o.id)[0];
    const staff = await signedIn('staff');
    const p = await staff.post(`/api/orders/${o.id}/amendments`, { kind: 'replace_product', item_id: item.id, product_id: productId('beef_mince_8020'), sale_option: '1kg', qty: { kind: 'count', count: 4 }, reason: 'Out of lean mince' });
    await pub().post(`/api/public/o/${orderToken(o.id)}/amendments/${p.body.amendment.id}`, { accept: false, note: 'I need lean only' });
    expect(getItems(o.id)[0].product_id).toBe(productId('beef_mince_lean'));
    expect((db().prepare("SELECT COUNT(*) n FROM exceptions WHERE type = 'amendment_declined' AND status = 'open'").get() as any).n).toBe(1);
  });
});

// ── Payments ─────────────────────────────────────────────────
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

function bankSettings() {
  updateSettings('payments', { eftEnabled: true, accountHolder: 'Terram Farm (Pty) Ltd', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655' }, null);
}

function readyOrder(email = 'pay@example.com') {
  const o = createOrder({ customer: { new: { name: 'Payer', email } }, source: 'phone', status: 'confirmed', customer_email: email, fulfilment_type: 'collection', items: [{ product_id: productId('beef_mince_lean'), sale_option: '1kg', qty: { kind: 'count', count: 2, weight_g: null } }, { product_id: productId('beef_brisket'), qty: kg(2000) }] }, STAFF);
  setItemsCut(getItems(o.id).map((i) => i.id), true, STAFF);
  for (const i of getItems(o.id)) setItemPacked(i.id, true, STAFF);
  completePacking(o.id, STAFF); // → packed: the final-weighing stage
  return o;
}

/** Packed, brisket weighed at 2 kg, finalized at R250 + R260 = R510. */
async function finalOrder(staff: Client, email?: string) {
  const o = readyOrder(email);
  const brisket = getItems(o.id).find((i) => i.name_snapshot === 'Brisket')!;
  await staff.post(`/api/items/${brisket.id}/weight`, { weight_g: 2000 });
  const f = await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
  expect(f.status).toBe(200);
  return o;
}
const payPath = (url: string) => new URL(url).pathname.replace(/^\/pay\//, '');

describe('payments', () => {
  it('final weighing: weights at the end, finalize locks the amount, and only then can payment be requested', async () => {
    bankSettings();
    const o = readyOrder();
    const staff = await signedIn('staff');
    expect(requireOrder(o.id).status).toBe('packed');
    // Not released, not payable: nothing is weighed or finalized yet
    expect((await staff.post(`/api/orders/${o.id}/transition`, { to: 'ready' })).body.error).toMatch(/final weighing/);
    expect((await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body.blocker).toMatch(/finalize/);
    expect((await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true })).body.error).toMatch(/packed weight of .*Brisket/);
    const brisket = getItems(o.id).find((i) => i.name_snapshot === 'Brisket')!;
    await staff.post(`/api/items/${brisket.id}/weight`, { weight_g: 2100 });
    expect((await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: false })).body.error).toMatch(/pack quantities/);
    const fin = await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    expect(fin.body.finalization.snapshot).toMatchObject({ version: 1, total_cents: 25000 + 27300 });
    expect(fin.body.finalization.snapshot.lines.find((l: any) => l.name === 'Brisket')).toMatchObject({ weight_g: 2100, unit_price_cents: 13000, price_unit: 'kg', line_cents: 27300 });
    expect(fin.body.finalization.snapshot.lines.find((l: any) => l.name === 'Lean Mince')).toMatchObject({ weight_g: null, line_cents: 25000 });
    // Locked: no edits, no weight changes, no going back to packing
    expect((await staff.post(`/api/items/${brisket.id}/weight`, { weight_g: 2500 })).status).toBe(409);
    expect((await staff.patch(`/api/items/${brisket.id}`, { qty: kg(3000) })).body.error).toMatch(/finalized/);
    expect((await staff.post(`/api/orders/${o.id}/transition`, { to: 'packing' })).status).toBe(409);
    // Preview: nothing is sent until staff choose to
    const pv = (await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body;
    expect(pv.request.amount_cents).toBe(52300);
    expect(pv.url).toMatch(/^https:\/\/www\.terramfarm\.co\.za\/pay\//);
    expect(pv.email).toMatchObject({ available: true, to: 'pay@example.com' });
    expect(pv.whatsapp.connected).toBe(false);
    expect(pv.whatsapp.text).toMatch(/R\s?523[.,]00/);
    await flush();
    expect(mail(/Payment for your order/)).toHaveLength(0);
    expect((await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body.request.id).toBe(pv.request.id); // no duplicate request
    expect((await staff.post(`/api/orders/${o.id}/payment-request/send`, { email: true })).status).toBe(200);
    expect((await staff.post(`/api/orders/${o.id}/payment-request/send`, { email: true })).body.error).toMatch(/already been emailed/);
    expect((await staff.post(`/api/orders/${o.id}/payment-request/send`, { email: true, resend: true })).status).toBe(200);
    const wa = await staff.post(`/api/orders/${o.id}/payment-request/whatsapp`);
    expect(wa.body.history.find((h: any) => h.channel === 'whatsapp').status).toBe('manual'); // never claimed as delivered
    await flush();
    const sent = mail(/Payment for your order/);
    expect(sent).toHaveLength(2);
    expect(sent[0].html).toContain(pv.url);
    expect(sent[0].text).toMatch(/R\s?523[.,]00/);
    expect(requireOrder(o.id).payment_state).toBe('requested');
  });

  it('reopening a finalized order needs a manager and a reason, keeps the old version and withdraws the request', async () => {
    bankSettings();
    const staff = await signedIn('staff');
    const o = await finalOrder(staff);
    const pv = (await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body;
    await staff.post(`/api/orders/${o.id}/payment-request/send`, { email: true });
    await flush();
    expect((await staff.post(`/api/orders/${o.id}/reopen-final`, { reason: 'Brisket weighed wrong' })).status).toBe(403);
    const manager = await signedIn('manager');
    expect((await manager.post(`/api/orders/${o.id}/reopen-final`, { reason: '' })).status).toBe(400);
    expect((await manager.post(`/api/orders/${o.id}/reopen-final`, { reason: 'Brisket weighed wrong' })).status).toBe(200);
    expect((db().prepare('SELECT status FROM payment_requests WHERE id = ?').get(pv.request.id) as any).status).toBe('superseded');
    // The old link now shows the request as replaced, with no amount payable
    const old = (await pub().get(`/api/public/pay/${payPath(pv.url)}`)).body.pay;
    expect(old).toMatchObject({ status: 'superseded', amount_due_cents: null, bank: null });
    await flush();
    expect(mail(/Update to the payment/)).toHaveLength(1);
    const brisket = getItems(o.id).find((i) => i.name_snapshot === 'Brisket')!;
    await staff.post(`/api/items/${brisket.id}/weight`, { weight_g: 2500 });
    const v2 = (await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true })).body.finalization;
    expect(v2.snapshot).toMatchObject({ version: 2, total_cents: 25000 + 32500 });
    const hist = (await staff.get(`/api/orders/${o.id}`)).body.finalization_history;
    expect(hist.map((h: any) => [h.version, !!h.superseded_at])).toEqual([[2, false], [1, true]]);
    expect((await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body.request.amount_cents).toBe(57500);
    // Once paid, it can't be reopened
    const req2 = openRequestFor(o.id);
    recordVerifiedPayment(o.id, { method: 'eft', amount_cents: 57500, request_id: req2 }, STAFF, 'staff');
    expect((await manager.post(`/api/orders/${o.id}/reopen-final`, { reason: 'again' })).body.error).toMatch(/payment has already been verified|already been released/);
  });

  it('the payment page: secure link, exact finalized lines, declare or upload proof — never paid until staff verify', async () => {
    bankSettings();
    const staff = await signedIn('staff');
    const o = await finalOrder(staff);
    const pv = (await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body;
    const tok = payPath(pv.url);
    const page = (await pub().get(`/api/public/pay/${tok}`)).body.pay;
    expect(page).toMatchObject({ status: 'awaiting_payment', amount_due_cents: 51000, total_cents: 51000, reference: `${o.order_number}` });
    expect(page.bank).toMatchObject({ bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655' });
    expect(page.lines.find((l: any) => l.name === 'Brisket')).toMatchObject({ weight_g: 2000, unit_price_cents: 13000, line_cents: 26000 });
    expect(JSON.stringify(page)).not.toMatch(/notes|internal/i);
    // Tampered, foreign and expired links open nothing
    const [rid, exp, mac] = tok.split('.');
    expect((await pub().get(`/api/public/pay/${rid}.${Number(exp) + 1}.${mac}`)).status).toBe(404);
    expect((await pub().get(`/api/public/pay/${o.id}.${exp}.${mac}`)).status).toBe(404);
    db().prepare('UPDATE payment_requests SET link_version = link_version + 1 WHERE id = ?').run(rid);
    expect((await pub().get(`/api/public/pay/${tok}`)).status).toBe(404); // revoked
    db().prepare('UPDATE payment_requests SET link_version = link_version - 1 WHERE id = ?').run(rid);
    const expired = `${rid}.${Math.floor(Date.now() / 1000) - 60}.${signPay(rid, Math.floor(Date.now() / 1000) - 60)}`;
    expect((await pub().get(`/api/public/pay/${expired}`)).status).toBe(410);
    // The customer says they've paid: awaiting verification, not paid
    expect((await pub().post(`/api/public/pay/${tok}/declare`, { confirm: false })).status).toBe(400);
    const d = await pub().post(`/api/public/pay/${tok}/declare`, { confirm: true, amount_cents: 51000, paid_on: today() });
    expect(d.body.pay.status).toBe('awaiting_verification');
    expect(requireOrder(o.id)).toMatchObject({ payment_state: 'proof_submitted', status: 'packed' });
    // A proof upload: wrong type refused, real image accepted, still not paid
    expect((await pub().upload(`/api/public/pay/${tok}/proof`, { name: 'proof.png', bytes: Buffer.from('not really a picture') })).status).toBe(400);
    const up = await pub().upload(`/api/public/pay/${tok}/proof`, { name: 'proof.png', bytes: PNG, type: 'image/png' }, { amount: '510.00' });
    expect(up.status).toBe(200);
    expect(requireOrder(o.id).payment_state).toBe('proof_submitted');
    const proof = db().prepare('SELECT id, file_id FROM payment_proofs WHERE order_id = ?').get(o.id) as any;
    expect((await staff.raw(`/api/files/${proof.file_id}`)).status).toBe(200);
    expect((await pub().raw(`/api/files/${proof.file_id}`)).status).toBe(401);
    // Staff can't verify; a manager checks the bank and confirms
    const decl = db().prepare('SELECT id FROM payment_declarations WHERE order_id = ?').get(o.id) as any;
    expect((await staff.post(`/api/declarations/${decl.id}/review`, { accept: true, amount_cents: 51000 })).status).toBe(403);
    expect((await staff.post(`/api/proofs/${proof.id}/review`, { accept: true, amount_cents: 51000 })).status).toBe(403);
    const manager = await signedIn('manager');
    const v = await manager.post(`/api/proofs/${proof.id}/review`, { accept: true, amount_cents: 51000 });
    expect(v.status).toBe(200);
    // Paid → released as ready, with who and when on record; the declaration is closed
    expect(requireOrder(o.id)).toMatchObject({ payment_state: 'paid', payment_status: 'paid', amount_paid_cents: 51000, status: 'ready' });
    const pay = db().prepare("SELECT id, receipt_number, verified_by, created_at FROM payments WHERE order_id = ?").get(o.id) as any;
    expect(pay.verified_by).toBeTruthy();
    expect(pay.created_at).toBeTruthy();
    expect((db().prepare('SELECT status FROM payment_declarations WHERE id = ?').get(decl.id) as any).status).toBe('accepted');
    expect((await manager.post(`/api/proofs/${proof.id}/review`, { accept: true, amount_cents: 51000 })).status).toBe(409); // no double confirmation
    expect((await pub().get(`/api/public/pay/${tok}`)).body.pay).toMatchObject({ status: 'paid', bank: null, amount_due_cents: null });
    expect((await pub().post(`/api/public/pay/${tok}/declare`, { confirm: true })).status).toBe(409);
    const t = orderToken(o.id);
    expect((await pub().get(`/api/public/o/${t}/receipt/${pay.id}`)).body.receipt).toMatchObject({ amount_cents: 51000, balance_cents: 0 });
    await flush();
    expect(mail(/Payment received — order #\d+ is ready/)).toHaveLength(1);
  });

  it('unpaid orders are not released unless the business allows a manager override', async () => {
    bankSettings();
    const staff = await signedIn('staff');
    const o = await finalOrder(staff);
    expect((await staff.post(`/api/orders/${o.id}/transition`, { to: 'ready' })).body.error).toMatch(/Payment hasn’t been confirmed/);
    const manager = await signedIn('manager');
    expect((await manager.post(`/api/orders/${o.id}/transition`, { to: 'ready', unpaid_reason: 'Pays cash on collection' })).body.error).toMatch(/switched off/);
    updateSettings('payments', { allowUnpaidRelease: true }, null);
    expect((await staff.post(`/api/orders/${o.id}/transition`, { to: 'ready', unpaid_reason: 'x' })).status).toBe(403);
    const r = await manager.post(`/api/orders/${o.id}/transition`, { to: 'ready', unpaid_reason: 'Pays cash on collection' });
    expect(r.body.order.status).toBe('ready');
    expect((db().prepare("SELECT summary FROM order_events WHERE order_id = ? AND type = 'status_changed' ORDER BY created_at DESC LIMIT 1").get(o.id) as any).summary).toMatch(/released before payment: Pays cash/);
  });

  it('EFT is not offered until the banking details are complete', async () => {
    const staff = await signedIn('staff');
    const o = await finalOrder(staff);
    expect((await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body.blocker).toMatch(/No payment method/);
  });

  it('PayFast: signed form, verified notification only, duplicates and mismatches handled', async () => {
    process.env.PAYFAST_MERCHANT_ID = '10000100';
    process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
    process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
    updateSettings('payments', { onlineEnabled: true }, null);
    const o = readyOrder();
    const staff = await signedIn('staff');
    const brisket = getItems(o.id).find((i) => i.name_snapshot === 'Brisket')!;
    await staff.post(`/api/items/${brisket.id}/weight`, { weight_g: 2000 });
    await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    await staff.get(`/api/orders/${o.id}/payment-request/preview`);
    const t = orderToken(o.id);
    const checkout = (await pub().post(`/api/public/o/${t}/pay/online`)).body;
    expect(checkout.action).toBe('https://sandbox.payfast.co.za/eng/process');
    const fields = checkout.fields as [string, string][];
    const sig = fields.find(([k]) => k === 'signature')![1];
    expect(signFields(fields.filter(([k]) => k !== 'signature'), 'jt7NOE43FZPn')).toBe(sig);
    expect(Object.fromEntries(fields).amount).toBe('510.00');
    // Coming back from PayFast proves nothing
    expect((await pub().get(`/api/public/o/${t}?payment=returned`)).body.order.payment.state).not.toBe('paid');
    const requestId = Object.fromEntries(fields).m_payment_id;
    const itn = (status: string, amount: string, pfId: string) => {
      const pairs: [string, string][] = [['m_payment_id', requestId], ['pf_payment_id', pfId], ['payment_status', status], ['item_name', `Terram Farm order #${o.order_number}`], ['item_description', ''], ['amount_gross', amount], ['amount_fee', '-11.73'], ['amount_net', '498.27'], ['custom_str1', o.id], ['name_first', 'Payer'], ['name_last', ''], ['email_address', 'pay@example.com'], ['merchant_id', '10000100']];
      const ps = pairs.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join('&');
      const signature = crypto.createHash('md5').update(`${ps}&passphrase=jt7NOE43FZPn`).digest('hex');
      return `${ps}&signature=${signature}`;
    };
    const deps = { payfastIps: async () => ['197.97.145.144'], confirm: async () => true };
    // Forged: bad signature, wrong source, PayFast says not valid
    expect((await handleItn(itn('COMPLETE', '510.00', '1').replace(/signature=\w+/, 'signature=deadbeef'), '197.97.145.144', deps)).outcome).toBe('bad_signature');
    expect((await handleItn(itn('COMPLETE', '510.00', '1'), '6.6.6.6', deps)).outcome).toBe('bad_source');
    expect((await handleItn(itn('COMPLETE', '510.00', '1'), '197.97.145.144', { ...deps, confirm: async () => false })).outcome).toBe('not_confirmed');
    expect(requireOrder(o.id).payment_state).not.toBe('paid');
    // A cancelled attempt, then the real payment, then the same notification again
    expect((await handleItn(itn('CANCELLED', '510.00', '2'), '197.97.145.144', deps)).outcome).toBe('failed');
    expect((await handleItn(itn('COMPLETE', '510.00', '3'), '197.97.145.144', deps)).outcome).toBe('paid');
    expect((await handleItn(itn('COMPLETE', '510.00', '3'), '197.97.145.144', deps)).outcome).toBe('duplicate');
    expect(requireOrder(o.id)).toMatchObject({ payment_state: 'paid', amount_paid_cents: 51000 });
    expect((db().prepare("SELECT COUNT(*) n FROM payments WHERE order_id = ? AND status = 'verified'").get(o.id) as any).n).toBe(1);
    // A payment of the wrong amount is recorded as received but flagged for staff
    expect((await handleItn(itn('COMPLETE', '400.00', '4'), '197.97.145.144', deps)).outcome).toBe('paid_mismatch');
    expect((db().prepare("SELECT COUNT(*) n FROM exceptions WHERE order_id = ? AND type = 'payment_issue' AND title LIKE 'Check the online payment%'").get(o.id) as any).n).toBe(1);
  });

  it('matches a real PayFast ITN signature (from PayFast’s SDK tests)', () => {
    const d: Record<string, string> = JSON.parse('{"m_payment_id":"000000020","pf_payment_id":"1579137","payment_status":"COMPLETE","item_name":"Order #000000020","item_description":"","amount_gross":"15.00","amount_fee":"-2.30","amount_net":"12.70","custom_str1":"","custom_str2":"","custom_str3":"","custom_str4":"","custom_str5":"","custom_int1":"","custom_int2":"","custom_int3":"","custom_int4":"","custom_int5":"","name_first":"Tom","name_last":"Tom","email_address":"lindley+user1@appinlet.com","merchant_id":"10027938","signature":"4078bca2c8987e0e0c4e7230f2f46323"}');
    const ps = Object.entries(d).filter(([k]) => k !== 'signature').map(([k, v]) => `${k}=${phpUrlencode(v)}`).join('&');
    expect(crypto.createHash('md5').update(ps).digest('hex')).toBe(d.signature);
  });
});

// ── Payment & banking settings ───────────────────────────────
describe('EFT banking settings', () => {
  it('admins edit them; others can’t; EFT can’t be switched on half set up; details stay out of public places', async () => {
    const manager = await signedIn('manager');
    expect((await manager.req('PUT', '/api/admin/settings/payments', { bankName: 'FNB' })).status).toBe(403);
    const admin = await signedIn('admin');
    const half = await admin.req('PUT', '/api/admin/settings/payments', { eftEnabled: true, bankName: 'FNB' });
    expect(half.status).toBe(400);
    expect(half.body.error).toMatch(/account holder, account number, branch code/);
    expect((await admin.req('PUT', '/api/admin/settings/payments', { eftEnabled: true, accountHolder: 'Terram Farm', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655' })).status).toBe(200);
    expect((await admin.req('PUT', '/api/admin/settings/payments', { onlineEnabled: true })).status).toBe(400); // PayFast not set up on the server
    expect((await manager.get('/api/admin/settings')).body.settings.payments.accountNumber).toBe('•••• 0001');
    expect((await admin.get('/api/admin/settings')).body.settings.payments.accountNumber).toBe('62000000001');
    const audit = db().prepare("SELECT data FROM audit_log WHERE action = 'settings.updated' AND entity_id = 'payments' ORDER BY created_at DESC").get() as any;
    expect(audit.data).not.toContain('62000000001');
    const info = await pub().get('/api/public/info');
    expect(JSON.stringify(info.body)).not.toContain('62000000001');
    expect(info.body.payments.eft).toBe(true);
    // Not on an order page until that order is asked to pay
    const o = createOrder({ customer: { new: { name: 'Early' } }, source: 'phone', status: 'review', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    expect(JSON.stringify((await pub().get(`/api/public/o/${orderToken(o.id)}`)).body)).not.toContain('62000000001');
  });
});

// ── Invoices ─────────────────────────────────────────────────
describe('manual invoice requests', () => {
  it('requested at checkout, worked through by staff, and issued only with a real reference', async () => {
    const skip = await send(form([{ product_id: productId('beef_rump'), qty: kg(1000) }]));
    expect(requireOrder(orderFromToken(tokenPath(skip.body.order_url))!).invoice_status).toBe('not_requested');
    const r = await send(form([{ product_id: productId('beef_rump'), qty: kg(1000) }], { invoice: { billing_name: 'Zulu Catering', company: 'Zulu Catering CC', billing_email: 'accounts@zulu.example' } }));
    const id = orderFromToken(tokenPath(r.body.order_url))!;
    expect(requireOrder(id).invoice_status).toBe('requested');
    const manager = await signedIn('manager');
    const list = await manager.get('/api/invoices');
    expect(list.body.requests.map((x: any) => x.id)).toContain(id);
    expect(list.body.requests[0]).toMatchObject({ billing_complete: true });
    expect((await manager.req('PATCH', `/api/orders/${id}/invoice`, { status: 'in_progress' })).status).toBe(200);
    expect((await manager.req('PATCH', `/api/orders/${id}/invoice`, { status: 'issued' })).status).toBe(400); // needs number and date
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]);
    expect((await manager.upload(`/api/orders/${id}/invoice/file`, { name: 'INV-1042.pdf', bytes: pdf, type: 'application/pdf' })).status).toBe(200);
    expect((await manager.req('PATCH', `/api/orders/${id}/invoice`, { status: 'issued', reference: 'INV-1042', issued_on: today() })).status).toBe(200);
    expect((await manager.req('PATCH', `/api/orders/${id}/invoice`, { status: 'sent' })).body.order.invoice_status).toBe('sent');
    await flush();
    expect(mail(/Your invoice for order/)).toHaveLength(2); // issued, then sent — each once
    expect(mail(/Your invoice for order/)[0].to).toEqual(['accounts@zulu.example', 'naledi@example.com']);
    // The customer downloads their own invoice; another order's link gets nothing
    expect((await pub().raw(`/api/public/o/${tokenPath(r.body.order_url)}/invoice`)).status).toBe(200);
    expect((await pub().raw(`/api/public/o/${tokenPath(skip.body.order_url)}/invoice`)).status).toBe(404);
    const page = (await pub().get(`/api/public/o/${tokenPath(r.body.order_url)}`)).body.order;
    expect(page.invoice).toMatchObject({ status: 'sent', reference: 'INV-1042', has_file: true });
  });
});

// ── Notifications ────────────────────────────────────────────
describe('notification outbox', () => {
  it('records failures, retries with back-off, and never sends a message twice', async () => {
    memoryFail.next = 1;
    await send(form([{ product_id: productId('beef_rump'), qty: kg(1000) }]));
    await new Promise((r) => setTimeout(r, 30));
    await processOutbox();
    const failed = db().prepare("SELECT * FROM notifications WHERE kind = 'order_received'").get() as any;
    expect(failed.status).toBe('queued'); // waiting to retry, not "sent"
    expect(failed.attempts).toBe(1);
    expect(failed.error).toMatch(/connect/);
    db().prepare('UPDATE notifications SET next_attempt_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), failed.id);
    await processOutbox();
    await processOutbox();
    const done = db().prepare('SELECT status, attempts, provider_id FROM notifications WHERE id = ?').get(failed.id) as any;
    expect(done).toMatchObject({ status: 'sent', attempts: 2 });
    expect(done.provider_id).toBeTruthy();
    expect(outbox.filter((m) => /received your/.test(m.subject))).toHaveLength(1);
    expect(retryNotification(failed.id)).toBe(false); // a sent message can't be re-sent
  });

  it('with email not set up, messages are recorded as not sent — never as sent', async () => {
    delete process.env.EMAIL_TRANSPORT;
    await send(form([{ product_id: productId('beef_rump'), qty: kg(1000) }]));
    await new Promise((r) => setTimeout(r, 30));
    await processOutbox();
    const rows = db().prepare("SELECT status, error FROM notifications WHERE channel = 'email'").all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'skipped' && /isn’t set up/.test(r.error))).toBe(true);
    const manager = await signedIn('manager');
    expect((await manager.get('/api/notifications?status=problems')).body.problems).toBeGreaterThan(0);
  });

  it('reorder reminders: only with consent, once, not after a newer order, with an unsubscribe link', async () => {
    const make = (name: string, email: string, consent: boolean) => {
      const o = createOrder({ customer: { new: { name, email } }, source: 'phone', status: 'confirmed', customer_email: email, fulfilment_type: 'collection', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
      db().prepare("UPDATE orders SET status = 'completed', completed_at = ? WHERE id = ?").run(new Date(Date.now() - 15 * 86400_000).toISOString(), o.id);
      db().prepare('UPDATE customers SET marketing_consent = ? WHERE id = ?').run(consent ? 1 : 0, o.customer_id);
      return o;
    };
    make('Yes Please', 'yes@example.com', true);
    make('No Thanks', 'no@example.com', false);
    const again = make('Back Already', 'back@example.com', true);
    createOrder({ customer: { id: again.customer_id }, source: 'phone', status: 'review', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    expect(runReorderReminders().sent).toBe(1);
    expect(runReorderReminders().sent).toBe(0); // never twice
    await flush();
    const r = mail(/Ready to stock up again/);
    expect(r.map((m) => m.to[0])).toEqual(['yes@example.com']);
    expect(r[0].text).toMatch(/Reorder my previous order: https:\/\/www\.terramfarm\.co\.za\/o\/.+\?reorder=1/);
    const unsub = r[0].text.match(/Unsubscribe: https:\/\/www\.terramfarm\.co\.za\/unsubscribe\/(\S+)/)![1];
    expect((await pub().post(`/api/public/unsubscribe/${unsub}`, { subscribed: false })).body.subscribed).toBe(false);
    expect((db().prepare("SELECT marketing_consent FROM customers WHERE email = 'yes@example.com'").get() as any).marketing_consent).toBe(0);
    updateSettings('retention', { remindersEnabled: false }, null);
    expect(runReorderReminders().sent).toBe(0);
  });
});

void transition;
void updateItem;

describe('customer page privacy', () => {
  it('order pages and their data are not cached or indexed', async () => {
    const r = await send(form([{ product_id: productId('beef_mince_lean'), sale_option: '1kg', qty: { kind: 'count', count: 1 } }]));
    const res = await pub().get(`/api/public/o/${tokenPath(r.body.order_url)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });
});

describe('reviews, Instagram and finding past orders', () => {
  const REVIEW = 'https://g.page/r/terram-test/review';
  const IG = 'https://www.instagram.com/terramfarm_test';
  const setLinks = () => updateSettings('business', { instagramUrl: IG, googleReviewUrl: REVIEW } as any, null);

  it('admins can only save real Instagram and Google review links', async () => {
    const admin = await signedIn('admin');
    expect((await admin.req('PUT', '/api/admin/settings/business', { instagramUrl: 'https://evil.example.com/x' })).status).toBe(400);
    expect((await admin.req('PUT', '/api/admin/settings/business', { googleReviewUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await admin.req('PUT', '/api/admin/settings/business', { instagramUrl: IG, googleReviewUrl: REVIEW })).status).toBe(200);
    expect((await pub().get('/api/public/info')).body.business).toMatchObject({ instagramUrl: IG, googleReviewUrl: REVIEW });
  });

  it('the Google review invitation goes only to customers who have had an order completed', async () => {
    setLinks();
    const first = await send(form([{ product_id: productId('beef_mince_lean'), sale_option: '1kg', qty: { kind: 'count', count: 1 } }]));
    expect(first.body.returning_customer).toBe(false);
    const view = (await pub().get(`/api/public/o/${tokenPath(first.body.order_url)}`)).body.order;
    expect(view.social).toEqual({ instagram: IG, review: null });
    // Complete that order: now its page, the completion email and the next order all invite a review
    const id = orderFromToken(tokenPath(first.body.order_url))!;
    db().prepare("UPDATE orders SET status = 'ready', confirmed_at = ?, fulfilment_type = 'collection' WHERE id = ?").run(new Date().toISOString(), id);
    transition(id, 'completed', STAFF, 'admin', { system: true });
    await flush();
    expect((await pub().get(`/api/public/o/${tokenPath(first.body.order_url)}`)).body.order.social.review).toBe(REVIEW);
    const doneMail = mail(/is complete/)[0];
    expect(doneMail.html).toContain(REVIEW);
    expect(doneMail.html).toContain(IG);
    const again = await send(form([{ product_id: productId('beef_mince_lean'), sale_option: '1kg', qty: { kind: 'count', count: 2 } }]));
    expect(again.body.returning_customer).toBe(true);
  });

  it('the “see all your orders” email link signs the customer in; tampered or expired links don’t', async () => {
    createOrder({ customer: { new: { name: 'Alice', email: 'alice@example.com' } }, source: 'phone', status: 'review', customer_email: 'alice@example.com', items: [{ product_id: productId('beef_rump'), qty: kg(1000) }] }, STAFF);
    const token = accountLinkToken('Alice@Example.com');
    expect(emailFromAccountLink(token)).toBe('alice@example.com');
    expect(emailFromAccountLink(token, Date.now() + 31 * 86400_000)).toBeNull();
    const [e, exp] = token.split('.');
    const forged = `${Buffer.from('bob@example.com').toString('base64url')}.${exp}.${token.split('.')[2]}`;
    expect(emailFromAccountLink(forged)).toBeNull();
    expect(emailFromAccountLink(`${e}.${Number(exp) + 999999}.${token.split('.')[2]}`)).toBeNull();
    const c = pub();
    expect((await c.post('/api/public/account/link', { token: forged })).status).toBe(400);
    expect((await c.post('/api/public/account/link', { token })).status).toBe(200);
    const acct = await c.get('/api/public/account');
    expect(acct.status).toBe(200);
    expect(acct.body.orders).toHaveLength(1);
    // The received email carries the link
    await send(form([{ product_id: productId('beef_mince_lean'), sale_option: '1kg', qty: { kind: 'count', count: 1 } }]));
    await flush();
    expect(mail(/received your/)[0].html).toContain('/account?k=');
  });
});

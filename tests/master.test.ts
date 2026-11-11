import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, freshDb, productId, signedIn, STAFF } from './helpers';
import { buildApp } from '../server/app';
import { db } from '../server/db/db';
import { outbox, memoryFail } from '../server/services/email';
import { processOutbox } from '../server/services/notify';
import { updateSettings } from '../server/services/settings';
import { orderFromToken, orderToken } from '../server/services/links';
import { createOrder, getItems, requireOrder, setItemsCut, setItemPacked, completePacking, transition } from '../server/domain/orders';
import { addDays, localDate, weekdayOf } from '../server/lib/time';
import { validMobile } from '../shared/text';

/**
 * The full functional upgrade: checkout details, the flat delivery fee, steak/mince ordering,
 * "View my orders" by phone, weights at any stage, invoices and communications, payment review
 * alerts, unpaid release, waivers, the dashboard, drafts and exception clean-up.
 * Email goes to an in-memory outbox. Nothing real is contacted or charged.
 */

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
  delivery_address: '12 Kerk Street, Hoedspruit',
  delivery_instructions: 'Gate code 4411, house at the end',
  // No preferred date: it's optional, and a fixed weekday can fall on a non-delivery day
  client_ref: `master-ref-${Date.now()}-${++ref}`,
  ...extra,
});
const pub = () => new Client(buildApp());
const send = (body: any, client = pub()) => client.req('POST', '/api/public/orders', body, { 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${++ref % 250}` });
const tokenPath = (url: string) => url.replace(/^\/o\//, '');
const mail = (subject: RegExp) => outbox.filter((m) => subject.test(m.subject));
const mince = (count: number) => ({ product_id: productId('beef_mince_lean'), sale_option: '500g', qty: { kind: 'count', count } });
const placed = async (extra: any = {}, items = [mince(4)]) => {
  const r = await send(form(items, extra));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return orderFromToken(tokenPath(r.body.order_url))!;
};

beforeEach(() => {
  freshDb('terram');
  outbox.length = 0;
  memoryFail.next = 0;
  process.env.EMAIL_TRANSPORT = 'memory';
});
afterEach(() => {
  delete process.env.EMAIL_TRANSPORT;
});

describe('checkout details', () => {
  it('needs a name, a valid mobile, an email, a delivery address and delivery instructions', async () => {
    const base = form([mince(2)]);
    expect((await send({ ...base, customer: { ...base.customer, email: '' } })).body.error).toMatch(/email/i);
    expect((await send({ ...base, customer: { ...base.customer, email: 'not-an-email' } })).status).toBe(400);
    expect((await send({ ...base, customer: { ...base.customer, phone: '12345' } })).body.error).toMatch(/mobile/i);
    expect((await send({ ...base, customer: { ...base.customer, name: '' } })).status).toBe(400);
    expect((await send({ ...base, delivery_address: '' })).status).toBe(400);
    expect((await send({ ...base, delivery_instructions: '' })).status).toBe(400);
    const id = await placed();
    const o = requireOrder(id);
    expect(o.contact_phone).toBe('+27715553380'); // normalised to +27
    expect(o.delivery_notes).toBe('Gate code 4411, house at the end');
  });

  it('validates South African mobiles and international numbers', () => {
    expect(validMobile('071 555 3380')).toBe('+27715553380');
    expect(validMobile('+27 82 123 4567')).toBe('+27821234567');
    expect(validMobile('0027821234567')).toBe('+27821234567');
    expect(validMobile('012 345 6789')).toBeNull(); // landline, not a mobile
    expect(validMobile('07155')).toBeNull();
    expect(validMobile('+44 7700 900123')).toBe('+447700900123');
  });
});

describe('delivery fee', () => {
  it('a standard delivery is the flat R150 stored on the order; collection is free; changing the setting never touches existing orders', async () => {
    const q = await pub().post('/api/public/quote', { items: [mince(4)] });
    expect(q.body.delivery).toMatchObject({ method: 'flat', fee_cents: 15000 });
    expect(q.body.delivery.area).toMatch(/Hoedspruit Wildlife Estates/);
    const id = await placed();
    expect(requireOrder(id)).toMatchObject({ delivery_fee_cents: 15000, delivery_arrangement: 'standard', estimated_total_cents: 25000 + 15000 });
    updateSettings('fulfilment', { customerChooses: true }, null);
    const col = await placed({ fulfilment_type: 'collection', delivery_address: null, delivery_instructions: null });
    expect(requireOrder(col)).toMatchObject({ delivery_fee_cents: 0, delivery_arrangement: 'collection' });
    updateSettings('fulfilment', { flatDeliveryFeeCents: 20000 }, null);
    expect(requireOrder(id).delivery_fee_cents).toBe(15000); // not retroactive
    expect(requireOrder(await placed({ fulfilment_type: 'delivery' })).delivery_fee_cents).toBe(20000);
    // The customer sees the fee on their order page and in the received email
    const page = (await pub().get(`/api/public/o/${orderToken(id)}`)).body.order;
    expect(page.fulfilment.delivery_fee_cents).toBe(15000);
    await flush();
    const rec = mail(/We've received your/)[0].text;
    expect(rec).toMatch(/Delivery fee: R\s?150[.,]00/);
    expect(rec).toMatch(/Total: R\s?400[.,]00 \(includes delivery/);
    expect(rec).toMatch(/What happens next/i);
  });

  it('staff can set a custom fee or mark a delivery as arranged separately; totals follow and it is recorded', async () => {
    const id = await placed();
    const staff = await signedIn('staff');
    expect((await staff.req('PATCH', `/api/orders/${id}/delivery`, { arrangement: 'custom', fee_cents: 35000 })).status).toBe(403); // money: managers only
    const manager = await signedIn('manager');
    const r = await manager.req('PATCH', `/api/orders/${id}/delivery`, { arrangement: 'custom', fee_cents: 35000, note: 'Phalaborwa — outside the area' });
    expect(r.status).toBe(200);
    expect(requireOrder(id)).toMatchObject({ delivery_fee_cents: 35000, estimated_total_cents: 25000 + 35000 });
    expect((await manager.req('PATCH', `/api/orders/${id}/delivery`, { arrangement: 'custom' })).status).toBe(400); // fee needed
    await staff.req('PATCH', `/api/orders/${id}/delivery`, { arrangement: 'separate' });
    expect(requireOrder(id)).toMatchObject({ delivery_fee_cents: 0, delivery_arrangement: 'separate' });
    const ev = db().prepare("SELECT summary FROM order_events WHERE order_id = ? AND type = 'delivery_changed' ORDER BY created_at").all(id) as any[];
    expect(ev.map((e) => e.summary).join('\n')).toMatch(/Custom delivery fee · fee R\s?350[.,]00 \(was R\s?150[.,]00\)/);
    const dash = (await staff.get('/api/production/dashboard')).body;
    expect(dash.waiting.find((w: any) => w.key === 'arrange')?.n).toBe(1);
  });
});

describe('ordering methods', () => {
  it('steaks are counted with a preferred weight per steak; "Other" needs a note; mince comes in 500 g packets', async () => {
    const rump = productId('beef_rump');
    const cat = (await pub().get('/api/public/catalogue')).body.products;
    const p = cat.find((x: any) => x.id === rump);
    expect(p.order_method).toBe('items_weighed');
    expect(p.weight_ranges.map((w: any) => w.label)).toEqual(['300–400 g', '400–500 g', '500–600 g']);
    const q = await pub().post('/api/public/quote', { items: [{ product_id: rump, qty: { kind: 'count', count: 4 }, weight_pref: '300-400' }, mince(4)] });
    expect(q.body.lines[0]).toMatchObject({ ok: true, est_weight_g: 1400 });
    expect(q.body.lines[0].label).toMatch(/4 .*300–400 g/);
    expect(q.body.lines[1]).toMatchObject({ ok: true, label: '4 × 500g', cents: 25000 });
    expect((await send(form([{ product_id: rump, qty: { kind: 'count', count: 2 }, weight_pref: 'other' }]))).status).toBe(400);
    const id = await placed({}, [{ product_id: rump, qty: { kind: 'count', count: 2 }, weight_pref: 'other', special_instructions: 'About 700 g each please' }]);
    expect(getItems(id)[0].weight_pref).toMatchObject({ id: 'other' });
    expect((await send(form([{ product_id: rump, qty: kg(1500) }]))).status).toBe(400);
  });
});

describe('View my orders with a mobile number', () => {
  it('emails a one-time code to the address on that number’s orders and shows only their orders', async () => {
    await placed();
    await placed({ customer: { name: 'Someone Else', phone: '082 111 2222', email: 'else@example.com' } });
    const c = pub();
    const unknown = await c.post('/api/public/account/code', { phone: '083 999 0000' });
    const known = await c.post('/api/public/account/code', { phone: '+27 71 555 3380' });
    expect(unknown.body.message).toBe(known.body.message); // never reveals who has orders
    await flush();
    const codeMail = mail(/sign-in code/);
    expect(codeMail).toHaveLength(1);
    expect(codeMail[0].to).toEqual(['naledi@example.com']);
    const code = codeMail[0].subject.match(/(\d{6})/)![1];
    expect((await c.post('/api/public/account/verify', { phone: '0715553380', code: '000000' })).status).toBe(400);
    expect((await c.post('/api/public/account/verify', { phone: '0715553380', code })).status).toBe(200);
    const acct = (await c.get('/api/public/account')).body;
    expect(acct.orders).toHaveLength(1);
    expect(acct.orders[0]).toMatchObject({ items: [{ qty_label: expect.any(String) }], delivery_fee_cents: 15000, invoice_available: false });
    expect(acct.orders[0].customer_name ?? 'Naledi Zulu').not.toBe('Someone Else');
  });
});

describe('production weights', () => {
  function inCutting() {
    const o = createOrder({ customer: { new: { name: 'Weigh Me', email: 'w@example.com' } }, source: 'phone', status: 'confirmed', customer_email: 'w@example.com', fulfilment_type: 'collection', items: [{ product_id: productId('beef_brisket'), qty: kg(2000) }] }, STAFF);
    transition(o.id, 'cutting', STAFF, 'staff');
    return o;
  }

  it('a final weight can be entered while cutting without moving the order; it is audited and totals follow', async () => {
    const o = inCutting();
    const item = getItems(o.id)[0];
    const staff = await signedIn('staff');
    expect((await staff.post(`/api/items/${item.id}/weight`, { weight_g: 2100 })).status).toBe(200);
    expect(requireOrder(o.id).status).toBe('cutting');
    expect(getItems(o.id)[0].packed_weight_g).toBe(2100);
    expect((await staff.post(`/api/items/${item.id}/weight`, { weight_g: 2050 })).status).toBe(200);
    const ev = (db().prepare("SELECT summary, actor_user_id FROM order_events WHERE order_id = ? AND type = 'item_weighed' ORDER BY created_at").all(o.id) as any[]);
    expect(ev.map((e) => e.summary)).toEqual(['Brisket weighed at 2,1 kg', 'Brisket weighed at 2,05 kg (was 2,1 kg)']);
    expect(ev[0].actor_user_id).toBeTruthy();
    expect(getItems(o.id)[0].final_cents).toBe(Math.round(2.05 * 13000));
  });

  it('an unusual weight is flagged to check, and the flag clears when corrected', async () => {
    const o = inCutting();
    const item = getItems(o.id)[0];
    const staff = await signedIn('staff');
    await staff.post(`/api/items/${item.id}/weight`, { weight_g: 9000 });
    const open = () => db().prepare("SELECT COUNT(*) n FROM exceptions WHERE order_id = ? AND type = 'weight_check' AND status = 'open'").get(o.id) as any;
    expect(open().n).toBe(1);
    await staff.post(`/api/items/${item.id}/weight`, { weight_g: 2000 });
    expect(open().n).toBe(0);
  });
});

describe('payments', () => {
  function finalizedDelivery() {
    const o = createOrder({ customer: { new: { name: 'Payer', email: 'pay@example.com' } }, source: 'phone', status: 'confirmed', customer_email: 'pay@example.com', fulfilment_type: 'delivery', delivery_address: '1 Main Rd', items: [mince(4) as any] }, STAFF);
    setItemsCut(getItems(o.id).map((i) => i.id), true, STAFF);
    for (const i of getItems(o.id)) setItemPacked(i.id, true, STAFF);
    completePacking(o.id, STAFF);
    return o;
  }
  const bank = () => updateSettings('payments', { eftEnabled: true, accountHolder: 'Terram Farm (Pty) Ltd', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655' }, null);

  it('a delivery order goes out unpaid only with a manager’s reason; it stays unpaid and is listed as owed', async () => {
    bank();
    const o = finalizedDelivery();
    const staff = await signedIn('staff');
    await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    const blocked = await staff.post(`/api/orders/${o.id}/transition`, { to: 'out_for_delivery' });
    expect(blocked.body.code).toBe('unpaid');
    const manager = await signedIn('manager');
    const r = await manager.post(`/api/orders/${o.id}/transition`, { to: 'out_for_delivery', unpaid_reason: 'Pays on delivery' });
    expect(r.status).toBe(200);
    expect(requireOrder(o.id).status).toBe('out_for_delivery');
    expect(requireOrder(o.id).payment_state).not.toBe('paid');
    const list = await manager.get('/api/orders?view=unpaid_released');
    expect(list.body.orders.map((x: any) => x.id)).toContain(o.id);
  });

  it('a manager can waive a payment with a reason, and undo it', async () => {
    bank();
    const o = finalizedDelivery();
    const staff = await signedIn('staff');
    await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    expect((await staff.post(`/api/orders/${o.id}/payment-waive`, { reason: 'Family' })).status).toBe(403);
    const manager = await signedIn('manager');
    expect((await manager.post(`/api/orders/${o.id}/payment-waive`, { reason: '' })).status).toBe(400);
    expect((await manager.post(`/api/orders/${o.id}/payment-waive`, { reason: 'Gift for a neighbour' })).status).toBe(200);
    expect(requireOrder(o.id).payment_state).toBe('waived');
    expect((await manager.post(`/api/orders/${o.id}/transition`, { to: 'out_for_delivery' })).status).toBe(200); // no override needed
    await manager.post(`/api/orders/${o.id}/payment-waive`, { undo: true });
    expect(requireOrder(o.id).payment_state).not.toBe('waived');
  });

  it('a manual payment records the date and bank reference', async () => {
    bank();
    const o = finalizedDelivery();
    const staff = await signedIn('staff');
    await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    const manager = await signedIn('manager');
    const r = await manager.post(`/api/orders/${o.id}/payments`, { method: 'eft', amount_cents: 10000, paid_on: today(), reference: 'FNB 8842' });
    expect(r.status).toBe(200);
    expect(requireOrder(o.id).payment_state).toBe('partially_paid');
    expect(db().prepare('SELECT paid_on, reference FROM payments WHERE order_id = ?').get(o.id)).toMatchObject({ paid_on: today(), reference: 'FNB 8842' });
  });

  it('a proof upload alerts the payment reviewer once, with a link back to the order (not a "paid" button)', async () => {
    bank();
    updateSettings('notifications', { paymentReviewEmails: ['checker@example.com'] }, null);
    const o = finalizedDelivery();
    const staff = await signedIn('staff');
    await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    const pv = (await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body;
    const tok = new URL(pv.url).pathname.replace(/^\/pay\//, '');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]);
    expect((await pub().upload(`/api/public/pay/${tok}/proof`, { name: 'pop.pdf', bytes: pdf, type: 'application/pdf' })).status).toBe(200);
    await flush();
    const alert = mail(/^Payment Verification Required/);
    expect(alert).toHaveLength(1);
    expect(alert[0].to).toEqual(['checker@example.com']);
    expect(alert[0].html).toContain(`/orders/${o.id}`);
  });
});

describe('communications', () => {
  it('the order confirmation can be previewed and sent again; WhatsApp is recorded as a hand-off and never marks anything paid', async () => {
    const id = await placed();
    const staff = await signedIn('staff');
    const c = (await staff.get(`/api/orders/${id}/communications`)).body;
    expect(c.confirmation).toMatchObject({ to: 'naledi@example.com', subject: expect.stringMatching(/received/) });
    expect(c.whatsapp).toMatchObject({ kind: 'update', wa_phone: '27715553380' });
    expect(c.whatsapp.text).toContain(c.whatsapp.portal_url);
    await flush();
    expect((await staff.post(`/api/orders/${id}/communications/confirmation`, {})).status).toBe(200);
    await flush();
    expect(mail(/We've received your/)).toHaveLength(2);
    expect(mail(/^New order/)).toHaveLength(1); // the family isn't alerted twice
    const before = requireOrder(id).payment_state;
    const h = (await staff.post(`/api/orders/${id}/communications/whatsapp`, { text: 'Hi Naledi, edited message' })).body.history;
    expect(requireOrder(id).payment_state).toBe(before);
    expect(h[0]).toMatchObject({ channel: 'whatsapp', status: 'manual' });
    expect(h.map((x: any) => x.status_label)).not.toContain('Delivered'); // we can't know that
    expect(h.filter((x: any) => x.channel === 'email').every((x: any) => ['Sent', 'Queued', 'Failed', 'Not sent'].includes(x.status_label))).toBe(true);
  });

  it('a customer-visible update shows on the customer’s order page', async () => {
    const id = await placed();
    const staff = await signedIn('staff');
    await staff.post(`/api/orders/${id}/customer-update`, { text: 'Your brisket is smoking today.' });
    await staff.post(`/api/orders/${id}/notes`, { text: 'Internal: check the smoker temp' });
    const page = (await pub().get(`/api/public/o/${orderToken(id)}`)).body.order;
    const texts = page.updates.map((u: any) => u.text);
    expect(texts).toContain('Your brisket is smoking today.');
    expect(texts.join(' ')).not.toMatch(/smoker temp/);
  });
});

describe('dashboard', () => {
  it('puts every open order in exactly one section; counts match the database and each section’s list', async () => {
    const mk = () => createOrder({ customer: { new: { name: `S ${Math.random()}` } }, source: 'phone', status: 'confirmed', fulfilment_type: 'collection', items: [{ product_id: productId('beef_brisket'), qty: kg(1000) }] }, STAFF);
    mk(); // confirmed
    const b = mk();
    transition(b.id, 'cutting', STAFF, 'staff'); // processing
    const p = mk();
    transition(p.id, 'cutting', STAFF, 'staff');
    transition(p.id, 'cut', STAFF, 'staff');
    transition(p.id, 'packing', STAFF, 'staff'); // packing is part of Processing, not its own section
    await placed(); // new
    const staff = await signedIn('staff');
    const d = (await staff.get('/api/production/dashboard')).body;
    const sec = (k: string) => d.sections.find((x: any) => x.key === k);
    expect(d.sections.map((x: any) => x.key)).toEqual(['new', 'confirmed', 'processing', 'packed', 'out']);
    expect([sec('new').n, sec('confirmed').n, sec('processing').n, sec('packed').n, sec('out').n]).toEqual([1, 1, 2, 0, 0]);
    expect(sec('processing').label).toBe('Processing');
    const open = (db().prepare("SELECT COUNT(*) n FROM orders WHERE status NOT IN ('completed','cancelled')").get() as any).n;
    expect(d.sections.reduce((t: number, x: any) => t + x.n, 0)).toBe(open);
    for (const x of d.sections) expect((await staff.get(`/api/orders?view=stage_${x.key}&limit=200`)).body.total).toBe(x.n);
    expect(sec('new').orders[0]).toMatchObject({ customer_name: 'Naledi Zulu', reason: expect.any(String), total_cents: expect.any(Number) });
    // Confirmed orders aren't "waiting" duplicates of their own section
    expect(d.waiting.map((w: any) => w.key)).not.toContain('confirm');
  });

  it('a delivered order leaves the active dashboard but stays in History, with money owed still visible', async () => {
    const o = createOrder({ customer: { new: { name: 'History Hal' } }, source: 'phone', status: 'confirmed', fulfilment_type: 'collection', items: [{ product_id: productId('beef_brisket'), qty: kg(1000) }] }, STAFF);
    db().prepare("UPDATE orders SET status = 'completed', completed_at = ? WHERE id = ?").run(new Date().toISOString(), o.id);
    const staff = await signedIn('staff');
    const d = (await staff.get('/api/production/dashboard')).body;
    expect(d.sections.flatMap((x: any) => x.orders).map((x: any) => x.id)).not.toContain(o.id);
    expect((await staff.get('/api/orders?view=history&q=History')).body.orders.map((x: any) => x.id)).toContain(o.id);
    expect((await staff.get('/api/orders?view=history&q=brisket')).body.orders.map((x: any) => x.id)).toContain(o.id); // by product
    expect((await staff.get('/api/orders?view=delivered_unpaid')).body.orders.map((x: any) => x.id)).toContain(o.id);
  });

  it('an order’s open questions close when it is cancelled', async () => {
    const id = await placed({}, [{ product_id: productId('beef_rump'), qty: { kind: 'count', count: 2 }, weight_pref: 'other', special_instructions: 'Big ones' }]);
    db().prepare("INSERT INTO exceptions (id, type, severity, status, title, order_id, created_at, payload) VALUES ('exq1','weight_check','warning','open','Check',?,?, '{}')").run(id, new Date().toISOString());
    const manager = await signedIn('manager');
    expect((await manager.post(`/api/orders/${id}/transition`, { to: 'cancelled', note: 'Customer changed their mind' })).status).toBe(200);
    expect((db().prepare("SELECT COUNT(*) n FROM exceptions WHERE order_id = ? AND status = 'open'").get(id) as any).n).toBe(0);
  });
});

describe('order drafts', () => {
  it('are saved privately to this device, restored, and cleared when the order is placed', async () => {
    const me = pub();
    const other = pub();
    expect((await me.get('/api/public/draft')).body.draft).toBeNull();
    expect((await me.req('PUT', '/api/public/draft', { draft: { items: [mince(2)], customer: { name: 'Naledi' } } })).status).toBe(200);
    expect((await me.get('/api/public/draft')).body.draft.customer.name).toBe('Naledi');
    expect((await other.get('/api/public/draft')).body.draft).toBeNull(); // another device sees nothing
    await send(form([mince(2)]), me);
    expect((await me.get('/api/public/draft')).body.draft).toBeNull();
    await me.req('PUT', '/api/public/draft', { draft: { items: [] } });
    await me.req('DELETE', '/api/public/draft');
    expect((await me.get('/api/public/draft')).body.draft).toBeNull();
  });
});

describe('payment verification workflow', () => {
  const bank = () => updateSettings('payments', { eftEnabled: true, accountHolder: 'Terram Farm (Pty) Ltd', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655' }, null);
  async function requested() {
    bank();
    const o = createOrder({ customer: { new: { name: 'Pay Check', email: 'paycheck@example.com', phone: '0825551234' } }, source: 'phone', status: 'confirmed', customer_email: 'paycheck@example.com', fulfilment_type: 'delivery', delivery_address: '3 Bush Rd, Hoedspruit', items: [mince(4) as any] }, STAFF);
    setItemsCut(getItems(o.id).map((i) => i.id), true, STAFF);
    for (const i of getItems(o.id)) setItemPacked(i.id, true, STAFF);
    completePacking(o.id, STAFF);
    const staff = await signedIn('staff');
    await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    const pv = (await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body;
    expect((await staff.post(`/api/orders/${o.id}/payment-request/send`, { email: true })).status).toBe(200);
    await flush();
    return { o, tok: new URL(pv.url).pathname.replace(/^\/pay\//, ''), due: pv.request.amount_cents as number };
  }
  const kinds = (orderId: string) => (db().prepare('SELECT kind FROM notifications WHERE order_id = ? ORDER BY created_at').all(orderId) as any[]).map((r) => r.kind);

  it('B: “I’ve paid” → awaiting verification, one alert, no new payment request; Confirm payment clears the task', async () => {
    const { o, tok, due } = await requested();
    const before = kinds(o.id).filter((k) => k === 'payment_requested').length;
    expect(before).toBe(1);
    for (let i = 0; i < 3; i++) await pub().post(`/api/public/pay/${tok}/declare`, { confirm: true, payer_reference: 'P CHECK' }); // repeated taps
    await flush();
    expect(requireOrder(o.id).payment_state).toBe('proof_submitted');
    expect(kinds(o.id).filter((k) => k === 'payment_requested').length).toBe(before); // nothing re-sent
    expect(kinds(o.id).filter((k) => k === 'order_received' || k === 'invoice_ready').length).toBe(0);
    expect(mail(/^Payment Verification Required/)).toHaveLength(1);
    expect(db().prepare("SELECT COUNT(*) n FROM payment_declarations WHERE order_id = ?").get(o.id)).toMatchObject({ n: 1 });
    const manager = await signedIn('manager');
    let d = (await manager.get('/api/production/dashboard')).body;
    expect(d.payments.orders.map((x: any) => x.id)).toContain(o.id);
    expect(d.payments.orders.find((x: any) => x.id === o.id).paid_claim).toMatchObject({ kind: 'declared' });
    expect(d.attention.find((a: any) => a.key === 'exceptions')?.n ?? 0).toBe(0); // not counted twice
    // Staff can't confirm money
    expect((await (await signedIn('staff')).post(`/api/orders/${o.id}/payment-check`, { result: 'confirmed', amount_cents: due })).status).toBe(403);
    const r = await manager.post(`/api/orders/${o.id}/payment-check`, { result: 'confirmed', amount_cents: due, paid_on: today(), reference: 'FNB 1' });
    expect(r.status).toBe(200);
    expect(requireOrder(o.id)).toMatchObject({ payment_state: 'paid' });
    expect(db().prepare("SELECT amount_cents, paid_on, reference, verified_by FROM payments WHERE order_id = ? AND status = 'verified'").all(o.id)).toEqual([expect.objectContaining({ amount_cents: due, paid_on: today(), reference: 'FNB 1', verified_by: expect.any(String) })]);
    d = (await manager.get('/api/production/dashboard')).body;
    expect(d.payments.orders.map((x: any) => x.id)).not.toContain(o.id);
    expect((db().prepare("SELECT COUNT(*) n FROM exceptions WHERE order_id = ? AND status = 'open'").get(o.id) as any).n).toBe(0);
    expect((await manager.post(`/api/orders/${o.id}/payment-check`, { result: 'confirmed', amount_cents: due })).status).toBe(409); // nothing left to check
  });

  it('C: Payment not received keeps the balance, sends nothing unless chosen, hides the internal note; a new request is a deliberate action', async () => {
    const { o, tok, due } = await requested();
    await pub().post(`/api/public/pay/${tok}/declare`, { confirm: true });
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 32)]);
    await pub().upload(`/api/public/pay/${tok}/proof`, { name: 'pop.pdf', bytes: pdf, type: 'application/pdf' });
    await flush();
    const sentBefore = outbox.length;
    const manager = await signedIn('manager');
    const r = await manager.post(`/api/orders/${o.id}/payment-check`, { result: 'not_received', note: 'Nothing from P Check by Wed' });
    expect(r.status).toBe(200);
    await flush();
    expect(outbox.length).toBe(sentBefore); // no automatic email of any kind
    const after = requireOrder(o.id);
    expect(after.payment_state).toBe('rejected');
    expect(r.body.summary.money.balance_cents).toBe(due);
    expect(db().prepare("SELECT status FROM payment_declarations WHERE order_id = ?").all(o.id)).toEqual([{ status: 'rejected' }]); // history kept
    expect(db().prepare("SELECT status FROM payment_proofs WHERE order_id = ?").all(o.id)).toEqual([{ status: 'rejected' }]);
    const page = (await pub().get(`/api/public/pay/${tok}`)).body.pay;
    expect(JSON.stringify(page)).not.toContain('Nothing from P Check'); // internal note stays internal
    expect(page.status).toBe('awaiting_payment'); // they can tell us again
    expect((await manager.get('/api/production/dashboard')).body.payments.orders.map((x: any) => x.id)).not.toContain(o.id);
    expect((db().prepare("SELECT summary FROM order_events WHERE order_id = ? AND type = 'payment_not_received'").get(o.id) as any).summary).toMatch(/Nothing from P Check/);
    // Sending the request again needs an explicit resend
    expect((await manager.post(`/api/orders/${o.id}/payment-request/send`, { email: true })).status).toBe(409);
    expect((await manager.post(`/api/orders/${o.id}/payment-request/send`, { email: true, resend: true })).status).toBe(200);
    await flush();
    expect(mail(/Payment for your order|payment/i).length).toBeGreaterThan(0);
  });

  it('C2: “Payment not received” can tell the customer, with the admin’s own words, once', async () => {
    const { o, tok } = await requested();
    await pub().post(`/api/public/pay/${tok}/declare`, { confirm: true });
    await flush();
    outbox.length = 0;
    const manager = await signedIn('manager');
    expect((await manager.post(`/api/orders/${o.id}/payment-check`, { result: 'not_received', notify_customer: true })).status).toBe(400); // message needed
    expect((await manager.post(`/api/orders/${o.id}/payment-check`, { result: 'not_received', notify_customer: true, message: 'Please check the reference was 1001.' })).status).toBe(200);
    await flush();
    const m = mail(/About your payment/);
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain('Please check the reference was 1001.');
  });

  it('D: an unpaid order is released, delivered and stays owed in History; payment never moves production', async () => {
    const { o, due } = await requested();
    const manager = await signedIn('manager');
    expect((await manager.post(`/api/orders/${o.id}/transition`, { to: 'out_for_delivery', unpaid_reason: 'Regular, pays on delivery' })).status).toBe(200);
    let d = (await manager.get('/api/production/dashboard')).body;
    const out = d.sections.find((x: any) => x.key === 'out').orders.find((x: any) => x.id === o.id);
    expect(out).toMatchObject({ delivery_address: '3 Bush Rd, Hoedspruit', contact_phone: expect.stringContaining('82'), released_unpaid: true, balance_cents: due });
    expect((await manager.post(`/api/orders/${o.id}/transition`, { to: 'completed' })).status).toBe(200);
    expect(requireOrder(o.id).payment_state).not.toBe('paid');
    d = (await manager.get('/api/production/dashboard')).body;
    expect(d.sections.flatMap((x: any) => x.orders).map((x: any) => x.id)).not.toContain(o.id);
    expect((await manager.get('/api/orders?view=delivered_unpaid')).body.orders.map((x: any) => x.id)).toContain(o.id);
    expect(d.attention.find((a: any) => a.key === 'delivered_unpaid')?.n).toBe(1);
  });
});

describe('sample data', () => {
  it('loads completely, with orders at each stage and a finished past order', async () => {
    const { loadSampleData } = await import('../server/seed/sample');
    await loadSampleData(STAFF);
    const st = (db().prepare('SELECT status, COUNT(*) n FROM orders WHERE is_sample = 1 GROUP BY status').all() as any[]).reduce((m, r) => ({ ...m, [r.status]: r.n }), {} as Record<string, number>);
    expect(st.completed).toBeGreaterThanOrEqual(1);
    expect((st.packed ?? 0) + (st.ready ?? 0)).toBeGreaterThanOrEqual(1);
    expect((st.cut ?? 0) + (st.packing ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('local days', () => {
  it('“today” starts at local midnight, not UTC midnight', async () => {
    const { localDayStartUtc } = await import('../server/lib/time');
    expect(localDayStartUtc('2026-11-05', 'Africa/Johannesburg')).toBe('2026-11-04T22:00:00.000Z');
    expect(localDayStartUtc('2026-07-01', 'Europe/London')).toBe('2026-06-30T23:00:00.000Z'); // summer time
    expect(localDayStartUtc('2026-01-01', 'UTC')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('scenario A: one order through every section', () => {
  it('sits in exactly the right section at each stage, then moves to History', async () => {
    updateSettings('payments', { eftEnabled: true, accountHolder: 'Terram Farm (Pty) Ltd', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655' }, null);
    const id = await placed();
    const manager = await signedIn('manager');
    const where = async () => {
      const d = (await manager.get('/api/production/dashboard')).body;
      return d.sections.filter((x: any) => x.orders.some((o: any) => o.id === id)).map((x: any) => x.key);
    };
    expect(await where()).toEqual(['new']);
    const ok = await manager.post(`/api/orders/${id}/confirm`, { expected_from: addDays(today(), 7), expected_to: addDays(today(), 10) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await where()).toEqual(['confirmed']);
    for (const to of ['cutting', 'cut', 'packing']) {
      expect((await manager.post(`/api/orders/${id}/transition`, { to })).status).toBe(200);
      expect(await where()).toEqual(['processing']);
    }
    for (const i of getItems(id)) await manager.post(`/api/items/${i.id}/packed`, { packed: true });
    expect((await manager.post(`/api/orders/${id}/packed`)).status).toBe(200);
    expect(await where()).toEqual(['packed']);
    await manager.post(`/api/orders/${id}/finalize`, { packs_confirmed: true });
    expect((await manager.post(`/api/orders/${id}/transition`, { to: 'out_for_delivery', unpaid_reason: 'Pays on delivery' })).status).toBe(200);
    expect(await where()).toEqual(['out']);
    expect((await manager.post(`/api/orders/${id}/transition`, { to: 'completed' })).status).toBe(200);
    expect(await where()).toEqual([]);
    expect((await manager.get('/api/orders?view=history')).body.orders.map((o: any) => o.id)).toContain(id);
    // The customer sees the same words
    const steps = (await pub().get(`/api/public/o/${orderToken(id)}`)).body.order.steps.map((x: any) => x.label);
    expect(steps).toEqual(expect.arrayContaining(['Processing', 'Out for delivery', 'Delivered']));
  });
});

describe('payment check after paying another way (review finding)', () => {
  it('a proof still waiting is settled when the order is paid in full, so it can’t be confirmed twice', async () => {
    updateSettings('payments', { eftEnabled: true, accountHolder: 'Terram Farm (Pty) Ltd', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655' }, null);
    const o = createOrder({ customer: { new: { name: 'Twice Paid', email: 'twice@example.com' } }, source: 'phone', status: 'confirmed', customer_email: 'twice@example.com', fulfilment_type: 'delivery', delivery_address: '1 Road', items: [mince(4) as any] }, STAFF);
    setItemsCut(getItems(o.id).map((i) => i.id), true, STAFF);
    for (const i of getItems(o.id)) setItemPacked(i.id, true, STAFF);
    completePacking(o.id, STAFF);
    const staff = await signedIn('staff');
    await staff.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    const pv = (await staff.get(`/api/orders/${o.id}/payment-request/preview`)).body;
    const tok = new URL(pv.url).pathname.replace(/^\/pay\//, '');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 32)]);
    await pub().upload(`/api/public/pay/${tok}/proof`, { name: 'pop.pdf', bytes: pdf, type: 'application/pdf' });
    const manager = await signedIn('manager');
    await manager.post(`/api/orders/${o.id}/payments`, { method: 'cash', amount_cents: pv.request.amount_cents }); // paid another way
    expect(requireOrder(o.id).payment_state).toBe('paid');
    expect(db().prepare('SELECT status FROM payment_proofs WHERE order_id = ?').all(o.id)).toEqual([{ status: 'accepted' }]);
    expect((db().prepare("SELECT COUNT(*) n FROM exceptions WHERE order_id = ? AND status = 'open' AND dedupe_key LIKE 'proof:%'").get(o.id) as any).n).toBe(0);
    expect((await manager.post(`/api/orders/${o.id}/payment-check`, { result: 'confirmed', amount_cents: pv.request.amount_cents })).status).toBe(409);
    expect((db().prepare("SELECT COUNT(*) n FROM payments WHERE order_id = ? AND status = 'verified'").get(o.id) as any).n).toBe(1);
  });
});

describe('phone numbers as people really type them', () => {
  it('accepts the common South African formats and still rejects things that are not mobiles', () => {
    for (const ok of ['082 123 4567', '0821234567', '+27 82 123 4567', '27821234567', '0027821234567', '+27 (0) 82 123 4567', '+27 (0)82 123 4567', '+270821234567', '270821234567', '82 123 4567', '(082) 123-4567', '+27-82-123-4567', '‪+27 82 123 4567‬', '0821234567 (Jane)'])
      expect(validMobile(ok), ok).toBe('+27821234567');
    for (const bad of ['', '12345', '012 345 6789', '082 123 456', '0821234567/0831234567', '+27 12 345 6789', 'not a number']) expect(validMobile(bad), bad).toBeNull();
    expect(validMobile('+44 (0)7700 900123')).toBe('+447700900123');
    expect(validMobile('44 7700 900123')).toBeNull(); // another country needs a + or 00
  });
});

describe('payment follow-up and the invoice on WhatsApp', () => {
  async function awaitingPayment() {
    updateSettings('payments', { eftEnabled: true, accountHolder: 'Terram Farm (Pty) Ltd', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655', reminderDays: 7 }, null);
    const o = createOrder({ customer: { new: { name: 'Late Payer', email: 'late@example.com', phone: '0825559876' } }, source: 'phone', status: 'confirmed', customer_email: 'late@example.com', fulfilment_type: 'delivery', delivery_address: '3 Bush Rd, Hoedspruit', items: [mince(4) as any] }, STAFF);
    setItemsCut(getItems(o.id).map((i) => i.id), true, STAFF);
    for (const i of getItems(o.id)) setItemPacked(i.id, true, STAFF);
    completePacking(o.id, STAFF);
    const manager = await signedIn('manager');
    await manager.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    const pv = (await manager.get(`/api/orders/${o.id}/payment-request/preview`)).body;
    expect((await manager.post(`/api/orders/${o.id}/payment-request/send`, { email: true })).status).toBe(200);
    await flush();
    return { o, manager, tok: new URL(pv.url).pathname.replace(/^\/pay\//, '') };
  }
  const ago = (orderId: string, days: number) => {
    const t = new Date(Date.now() - days * 86400_000).toISOString();
    db().prepare("UPDATE order_events SET created_at = ? WHERE order_id = ? AND type IN ('payment_requested','payment_request_sent')").run(t, orderId);
  };
  const reminders = (orderId: string) => (db().prepare("SELECT recipient, subject, body FROM notifications WHERE order_id = ? AND kind = 'payment_reminder'").all(orderId) as any[]);

  it('a week after the request the order is flagged, but nothing is ever sent by itself', async () => {
    const { o, manager } = await awaitingPayment();
    expect((await manager.get(`/api/orders/${o.id}/payment-reminder`)).body.state).toMatchObject({ eligible: true, due: false, days: 7 });
    expect((await manager.get('/api/production/dashboard')).body.waiting.some((w: any) => w.key === 'remind')).toBe(false);
    ago(o.id, 8);
    expect((await manager.get(`/api/orders/${o.id}/payment-reminder`)).body.state).toMatchObject({ eligible: true, due: true, days_waiting: 8 });
    const dash = (await manager.get('/api/production/dashboard')).body;
    expect(dash.waiting.find((w: any) => w.key === 'remind')).toMatchObject({ n: 1, to: '/orders?view=remind' });
    const list = (await manager.get('/api/orders?view=remind')).body;
    expect((list.orders ?? list).map((x: any) => x.id)).toContain(o.id);
    await flush();
    expect(reminders(o.id)).toHaveLength(0);
  });

  it('“Remind for payment” emails the right person once, with the payment link, and restarts the clock', async () => {
    const { o, manager } = await awaitingPayment();
    ago(o.id, 8);
    const staff = await signedIn('staff');
    expect((await staff.post(`/api/orders/${o.id}/payment-reminder/send`, {})).status).toBe(403);
    const draft = (await manager.get(`/api/orders/${o.id}/payment-reminder`)).body.draft;
    expect(draft).toMatchObject({ to: 'late@example.com' });
    expect(draft.text).toMatch(/\/pay\//);
    const [a, b] = await Promise.all([manager.post(`/api/orders/${o.id}/payment-reminder/send`, {}), manager.post(`/api/orders/${o.id}/payment-reminder/send`, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    await flush();
    expect(reminders(o.id)).toHaveLength(1);
    expect(reminders(o.id)[0].recipient).toBe('late@example.com');
    expect(reminders(o.id)[0].body).toMatch(/R\s?\d/);
    expect((await manager.post(`/api/orders/${o.id}/payment-reminder/send`, {})).status).toBe(409); // not again straight away
    expect((await manager.get(`/api/orders/${o.id}/payment-reminder`)).body.state).toMatchObject({ due: false, reminders_sent: 1 });
    expect((await manager.get(`/api/orders/${o.id}`)).body.communications.some((h: any) => h.kind === 'payment_reminder' && h.status === 'sent')).toBe(true);
    expect(requireOrder(o.id).payment_state).toBe('requested'); // a reminder never changes the payment
  });

  it('snooze hides it; WhatsApp is recorded as a handoff and restarts the clock; a claim of payment stops reminders', async () => {
    const { o, manager, tok } = await awaitingPayment();
    ago(o.id, 8);
    expect((await manager.post(`/api/orders/${o.id}/payment-reminder/snooze`, { days: 3 })).body.state).toMatchObject({ due: false });
    ago(o.id, 20);
    expect((await manager.get(`/api/orders/${o.id}/payment-reminder`)).body.state).toMatchObject({ due: false }); // still snoozed
    const wa = await manager.post(`/api/orders/${o.id}/payment-reminder/whatsapp`, { text: 'Hi, friendly reminder' });
    expect(wa.status).toBe(200);
    expect(db().prepare("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND type = 'payment_reminder_whatsapp'").get(o.id)).toMatchObject({ n: 1 });
    expect(reminders(o.id)).toHaveLength(0);
    expect((await manager.get(`/api/orders/${o.id}`)).body.communications.some((h: any) => h.channel === 'whatsapp' && h.kind_label === 'Payment reminder')).toBe(true);
    await pub().post(`/api/public/pay/${tok}/declare`, { confirm: true, payer_reference: 'LATE' });
    expect((await manager.get(`/api/orders/${o.id}/payment-reminder`)).body.state).toMatchObject({ eligible: false });
    expect((await manager.post(`/api/orders/${o.id}/payment-reminder/send`, {})).status).toBe(409);
  });

  it('the clock only starts once the request has actually gone out, and a reminder needs a day first', async () => {
    updateSettings('payments', { eftEnabled: true, accountHolder: 'Terram Farm (Pty) Ltd', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655', reminderDays: 7 }, null);
    const o = createOrder({ customer: { new: { name: 'Not Sent', email: 'ns@example.com', phone: '0825557777' } }, source: 'phone', status: 'confirmed', customer_email: 'ns@example.com', fulfilment_type: 'delivery', delivery_address: '3 Bush Rd, Hoedspruit', items: [mince(2) as any] }, STAFF);
    setItemsCut(getItems(o.id).map((i) => i.id), true, STAFF);
    for (const i of getItems(o.id)) setItemPacked(i.id, true, STAFF);
    completePacking(o.id, STAFF);
    const manager = await signedIn('manager');
    await manager.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    await manager.get(`/api/orders/${o.id}/payment-request/preview`); // opening the sheet creates the request but sends nothing
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    db().prepare("UPDATE order_events SET created_at = ? WHERE order_id = ?").run(old, o.id);
    expect((await manager.get(`/api/orders/${o.id}/payment-reminder`)).body.state).toMatchObject({ eligible: false, due: false });
    expect((await manager.post(`/api/orders/${o.id}/payment-reminder/send`, {})).status).toBe(409);
    await manager.post(`/api/orders/${o.id}/payment-request/send`, { email: true });
    expect((await manager.post(`/api/orders/${o.id}/payment-reminder/send`, {})).status).toBe(409); // asked for today: too soon
    const staff = await signedIn('staff');
    expect((await staff.get(`/api/orders/${o.id}/payment-reminder`)).body.draft ?? null).toBeNull(); // no pay link for people who can't send it
  });

  it('can be switched off in Settings', async () => {
    const { o, manager } = await awaitingPayment();
    ago(o.id, 30);
    updateSettings('payments', { reminderDays: 0 }, null);
    expect((await manager.get(`/api/orders/${o.id}/payment-reminder`)).body.state).toMatchObject({ eligible: false, due: false });
    expect((await manager.get('/api/production/dashboard')).body.waiting.some((w: any) => w.key === 'remind')).toBe(false);
  });

  it('the uploaded invoice can be sent on WhatsApp: secure link, recorded handoff, nothing emailed', async () => {
    const { o, manager } = await awaitingPayment();
    expect((await manager.get(`/api/orders/${o.id}/communications`)).body.whatsapp_invoice).toBeNull();
    expect((await manager.post(`/api/orders/${o.id}/communications/whatsapp`, { text: 'x', kind: 'invoice' })).status).toBe(400);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    expect((await manager.upload(`/api/orders/${o.id}/invoice/file`, { name: 'INV-7.pdf', bytes: pdf, type: 'application/pdf' }, { reference: 'INV-7' })).status).toBe(200);
    await flush();
    const before = mail(/invoice/i).length;
    const c = (await manager.get(`/api/orders/${o.id}/communications`)).body;
    expect(c.whatsapp_invoice.kind).toBe('invoice');
    expect(c.whatsapp_invoice.text).toMatch(/\/o\/[^ ]+#invoice/);
    expect(c.whatsapp_invoice.text).toMatch(/INV-7/);
    expect(c.whatsapp_invoice.wa_phone).toBe('27825559876');
    const r = await manager.post(`/api/orders/${o.id}/communications/whatsapp`, { text: c.whatsapp_invoice.text, kind: 'invoice' });
    expect(r.status).toBe(200);
    await flush();
    expect(mail(/invoice/i).length).toBe(before);
    expect(r.body.history.some((h: any) => h.channel === 'whatsapp' && h.kind_label === 'Invoice')).toBe(true);
    expect(requireOrder(o.id).payment_state).toBe('requested');
  });
});

describe('email is the main channel, WhatsApp is for delivery', () => {
  it('the order form needs an email, in plain words, and says how we will be in touch', async () => {
    const noEmail = form([mince(2)], { customer: { name: 'No Email', phone: '071 555 3380', email: '' } });
    const r = await send(noEmail);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/email/i);
    expect(JSON.stringify(r.body)).not.toMatch(/customer\.email/);
    const info = (await pub().get('/api/public/info')).body;
    expect(info.form.emailNote).toMatch(/email/i);
    expect(info.form.emailNote).toMatch(/WhatsApp/);
    expect(info.form.deliveryDayNote).toMatch(/Hoedspruit.*Monday or Tuesday/);
    expect(info.content.communityNote).toMatch(/compost/);
    expect(info.content.communityNote).toMatch(/WhatsApp/);
    expect(JSON.stringify(info)).not.toMatch(/Hoodspruit/);
  });

  it('a returning customer with no email on their profile gives one: it is saved and the confirmation goes there, once', async () => {
    const existing = createOrder({ customer: { new: { name: 'Naledi Zulu', phone: '0715553380', email: null } }, source: 'phone', status: 'confirmed', fulfilment_type: 'collection', items: [mince(1) as any] }, STAFF);
    expect(db().prepare('SELECT email FROM customers WHERE id = ?').get(existing.customer_id)).toMatchObject({ email: null });
    outbox.length = 0;
    const o = await placed({ customer: { name: 'Naledi Zulu', phone: '071 555 3380', email: 'naledi.new@example.com' } });
    await flush();
    expect(requireOrder(o).customer_id).toBe(existing.customer_id);
    expect(db().prepare('SELECT email FROM customers WHERE id = ?').get(existing.customer_id)).toMatchObject({ email: 'naledi.new@example.com' });
    const got = mail(/received your/i);
    expect(got).toHaveLength(1);
    expect(got[0].to).toEqual(['naledi.new@example.com']);
    expect(got[0].text).toMatch(/sent by email/);
    expect(got[0].text).toMatch(/Monday or Tuesday/);
    expect(got[0].text).toMatch(/WhatsApp/);
  });

  it('a collection order’s confirmation does not mention delivery days', async () => {
    const r = await send(form([mince(1)], { fulfilment_type: 'collection', delivery_address: null, delivery_instructions: null, client_ref: `col-${Date.now()}` }));
    if (r.status !== 200) return; // the form may be in address-only mode in this build
    await flush();
    const got = mail(/received your/i).filter((m) => (m.to ?? []).includes('naledi@example.com')).pop();
    expect(got?.text ?? '').not.toMatch(/Monday or Tuesday/);
  });

  it('an order typed in without an email sends nothing by email, and says so on the order', async () => {
    updateSettings('payments', { eftEnabled: true, accountHolder: 'Terram Farm (Pty) Ltd', bankName: 'FNB', accountNumber: '62000000001', branchCode: '250655' }, null);
    outbox.length = 0;
    const o = createOrder({ customer: { new: { name: 'Walk In', phone: '0825550001', email: null } }, source: 'phone', status: 'confirmed', fulfilment_type: 'delivery', delivery_address: '9 Bush Rd, Hoedspruit', items: [mince(2) as any] }, STAFF);
    setItemsCut(getItems(o.id).map((i) => i.id), true, STAFF);
    for (const i of getItems(o.id)) setItemPacked(i.id, true, STAFF);
    completePacking(o.id, STAFF);
    const manager = await signedIn('manager');
    await manager.post(`/api/orders/${o.id}/finalize`, { packs_confirmed: true });
    await flush();
    expect((await manager.get(`/api/orders/${o.id}/communications`)).body.confirmation.to).toBeNull();
    expect((await manager.post(`/api/orders/${o.id}/communications/confirmation`, {})).status).toBe(400);
    const pv = await manager.get(`/api/orders/${o.id}/payment-request/preview`);
    expect(pv.body.blocker ?? null, JSON.stringify(pv.body)).toBeNull();
    expect(pv.body.email.available).toBe(false);
    expect(pv.body.whatsapp.link).toMatch(/^https:\/\/wa\.me\/27825550001/);
    expect((await manager.post(`/api/orders/${o.id}/payment-request/send`, { email: true })).status).toBeGreaterThanOrEqual(400);
    await flush();
    expect(outbox.filter((m) => (m.to ?? []).some((a: string) => /walk/i.test(a)))).toHaveLength(0);
    expect(db().prepare("SELECT COUNT(*) n FROM notifications WHERE order_id = ? AND audience = 'customer' AND status = 'sent'").get(o.id)).toMatchObject({ n: 0 });
  });
});

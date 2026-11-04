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
  requested_date: weekday(),
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
  expect(r.status).toBe(200);
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
    expect(q.body.delivery.area).toMatch(/Hoodspruit Wildlife Estates/);
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
    const r = await staff.req('PATCH', `/api/orders/${id}/delivery`, { arrangement: 'custom', fee_cents: 35000, note: 'Phalaborwa — outside the area' });
    expect(r.status).toBe(200);
    expect(requireOrder(id)).toMatchObject({ delivery_fee_cents: 35000, estimated_total_cents: 25000 + 35000 });
    expect((await staff.req('PATCH', `/api/orders/${id}/delivery`, { arrangement: 'custom' })).status).toBe(400); // fee needed
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
  it('counts every open order in exactly one stage, and links each to its list', async () => {
    const mk = (status: string) => createOrder({ customer: { new: { name: `S ${status}` } }, source: 'phone', status: 'confirmed', fulfilment_type: 'collection', items: [{ product_id: productId('beef_brisket'), qty: kg(1000) }] }, STAFF);
    const a = mk('a');
    const b = mk('b');
    transition(b.id, 'cutting', STAFF, 'staff');
    await placed(); // review
    const staff = await signedIn('staff');
    const d = (await staff.get('/api/production/dashboard')).body;
    const n = (k: string) => d.stages.find((s: any) => s.key === k).n;
    expect(n('new')).toBe(2);
    expect(n('cutting')).toBe(1);
    expect(n('packing') + n('packed') + n('out')).toBe(0);
    for (const s of d.stages) {
      const list = (await staff.get(`/api/orders?view=stage_${s.key}&limit=200`)).body;
      expect(list.total).toBe(s.n);
    }
    expect(d.waiting.find((w: any) => w.key === 'confirm').n).toBe(1);
    expect(d.waiting.find((w: any) => w.key === 'cut').n).toBe(1);
    void a;
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

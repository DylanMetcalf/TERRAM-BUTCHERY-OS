import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Client, freshDb, productId, signedIn } from './helpers';
import { buildApp } from '../server/app';
import { addDays, localDate, nextWeekday } from '../server/lib/time';
import { db } from '../server/db/db';

beforeEach(() => freshDb());

const mince = () => ({ product_id: productId('beef_mince'), qty: { kind: 'weight', weight_g: 2000 } });

describe('authentication & permissions (enforced on the server)', () => {
  it('rejects anonymous access to internal data', async () => {
    const c = new Client();
    expect((await c.get('/api/orders')).status).toBe(401);
    expect((await c.get('/api/customers')).status).toBe(401);
  });

  it('view-only users can read but not change anything', async () => {
    const v = await signedIn('viewer');
    expect((await v.get('/api/orders')).status).toBe(200);
    const r = await v.post('/api/orders', { customer: { name: 'X' }, items: [mince()] });
    expect(r.status).toBe(403);
  });

  it('staff cannot change prices, products, users or settings', async () => {
    const s = await signedIn('staff');
    const pid = productId('beef_mince');
    expect((await s.patch(`/api/products/${pid}`, { price_cents: 1 })).status).toBe(403);
    expect((await s.post('/api/admin/users', { name: 'a', email: 'a@b.co', role: 'admin', password: 'password123' })).status).toBe(403);
    expect((await s.req('PUT', '/api/admin/settings/ai', { enabled: false })).status).toBe(403);
    expect((await s.get('/api/admin/backup')).status).toBe(403);
  });

  it('managers can change products and the change is audited', async () => {
    const m = await signedIn('manager');
    const pid = productId('beef_mince');
    const r = await m.patch(`/api/products/${pid}`, { price_cents: 15000 });
    expect(r.status).toBe(200);
    const a = db().prepare("SELECT * FROM audit_log WHERE action = 'product.price_changed'").get() as any;
    expect(a.entity_id).toBe(pid);
  });

  it('wrong passwords are rejected with a helpful message', async () => {
    await signedIn('staff');
    const r = await new Client().post('/api/auth/login', { email: 'nobody@terram.test', password: 'nope' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/do not match/);
  });
});

describe('request safety', () => {
  it('blocks state-changing requests without the CSRF header', async () => {
    const s = await signedIn('staff');
    const r = await s.req('POST', '/api/orders', { customer: { name: 'X' }, items: [mince()] }, { 'x-terram': '0' });
    expect(r.status).toBe(403);
  });

  it('replays the same response for a repeated idempotency key (double-click safe)', async () => {
    const s = await signedIn('staff');
    const key = crypto.randomUUID();
    const a = await s.post('/api/orders', { customer: { name: 'Double Click' }, items: [mince()] }, { 'idempotency-key': key });
    const b = await s.post('/api/orders', { customer: { name: 'Double Click' }, items: [mince()] }, { 'idempotency-key': key });
    expect(a.status).toBe(200);
    expect(b.body.order.id).toBe(a.body.order.id);
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(1);
  });

  it('validates input and never exposes raw errors', async () => {
    const s = await signedIn('staff');
    const r = await s.post('/api/orders', { customer: { name: 'X' }, items: [{ product_id: productId('chicken_whole'), qty: { kind: 'weight', weight_g: 2000 } }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sold by the piece/);
    const bad = await s.post('/api/orders', { customer: { name: 'X' }, items: [{ product_id: 'nope', qty: { kind: 'count', count: 1 } }] });
    expect(bad.status).toBe(404);
    expect(bad.body.error).not.toMatch(/SQLITE|stack/i);
  });

  it('neutralises spreadsheet formulas in CSV exports', async () => {
    const a = await signedIn('admin');
    await a.post('/api/customers', { name: '=HYPERLINK("http://evil")' });
    const r = await a.get('/api/admin/export/customers.csv');
    expect(r.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe('customer order form', () => {
  const nextCollectionDay = () => {
    const today = localDate(new Date(), 'Africa/Johannesburg');
    return nextWeekday(addDays(today, 1), 6); // a Saturday at least a day away
  };
  const payload = (ref: string, extra: any = {}) => ({
    customer: { name: 'Naledi Zulu', phone: '071 555 3380' },
    items: [{ product_id: productId('beef_mince'), qty: { kind: 'weight', weight_g: 1000 } }],
    fulfilment_type: 'collection',
    delivery_address: '12 Kerk Street, Pretoria',
    requested_date: nextCollectionDay(),
    client_ref: ref,
    ...extra,
  });

  it('feeds the central order engine as an order to review', async () => {
    const c = new Client(buildApp());
    const r = await c.post('/api/public/orders', payload('ref-00000001'));
    expect(r.status).toBe(200);
    const o = db().prepare('SELECT status, source FROM orders').get() as any;
    expect(o).toEqual({ status: 'review', source: 'form' });
    expect(r.body.message).not.toMatch(/confirmed\b(?! it)/i);
  });

  it('does not create a second order when the customer submits twice', async () => {
    const c = new Client(buildApp());
    await c.post('/api/public/orders', payload('ref-00000002'));
    const again = await c.post('/api/public/orders', payload('ref-00000002'));
    expect(again.body.replay).toBe(true);
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(1);
  });

  it('refuses impossible selections', async () => {
    const c = new Client(buildApp());
    const past = await c.post('/api/public/orders', payload('ref-00000003', { requested_date: '2020-01-01' }));
    expect(past.status).toBe(400);
    const internal = await c.post('/api/public/orders', payload('ref-00000004', { items: [{ product_id: productId('beef_fat'), qty: { kind: 'weight', weight_g: 1000 } }] }));
    expect(internal.status).toBe(400);
    const badPrep = await c.post('/api/public/orders', payload('ref-00000005', { items: [{ product_id: productId('beef_mince'), qty: { kind: 'weight', weight_g: 1000 }, preparation: { Bone: 'Bone-in' } }] }));
    expect(badPrep.status).toBe(400);
  });
});

describe('WhatsApp webhook', () => {
  it('rejects unsigned payloads and processes signed ones exactly once', async () => {
    process.env.WHATSAPP_APP_SECRET = 'test-secret';
    const app = buildApp();
    const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '27825550000', profile: { name: 'Lindiwe' } }], messages: [{ id: 'wamid.X', from: '27825550000', type: 'text', text: { body: '2kg mince for Friday please' }, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
    const bad = await app.request('/api/integrations/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
    expect(bad.status).toBe(401);
    for (let i = 0; i < 3; i++) {
      const ok = await app.request('/api/integrations/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': sig } });
      expect(ok.status).toBe(200);
    }
    expect((db().prepare('SELECT COUNT(*) n FROM orders').get() as any).n).toBe(1);
    delete process.env.WHATSAPP_APP_SECRET;
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, freshDb, productId, signedIn } from './helpers';
import { buildApp } from '../server/app';
import { emailSetup, explainEmailError, outbox } from '../server/services/email';
import { createCustomer } from '../server/domain/customers';
import { addDays, localDate, weekdayOf } from '../server/lib/time';
import { STAFF } from './helpers';

beforeEach(() => {
  freshDb('terram');
  outbox.length = 0;
  process.env.EMAIL_TRANSPORT = 'memory';
});
afterEach(() => {
  delete process.env.EMAIL_TRANSPORT;
});

const day = () => {
  const today = localDate(new Date(), 'Africa/Johannesburg');
  for (let i = 2; i < 10; i++) if ([2, 3, 4, 5, 6].includes(weekdayOf(addDays(today, i)))) return addDays(today, i);
  throw new Error('no day');
};
const order = (ref: string, extra: any = {}) => ({
  customer: { name: 'Naledi Zulu', phone: '071 555 3380', email: 'naledi@example.com' },
  items: [{ product_id: productId('beef_rump'), qty: { kind: 'count', count: 4, weight_g: null } }, { product_id: productId('eggs'), qty: { kind: 'count', count: 30, weight_g: null } }],
  fulfilment_type: 'collection',
  requested_date: day(),
  client_ref: ref,
  ...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('email for new online orders', () => {
  it('sends each online order once to the family addresses', async () => {
    const c = new Client(buildApp());
    await c.post('/api/public/orders', order('ref-mail-0001', { special_request: '2kg venison steaks' }));
    await c.post('/api/public/orders', order('ref-mail-0001', { special_request: '2kg venison steaks' })); // double tap
    await flush();
    expect(outbox).toHaveLength(1);
    const m = outbox[0];
    expect(m.to).toEqual(['dylan@meacreo.co.za', 'Sharonm@imagine.co.za']);
    expect(m.subject).toMatch(/^New order #\d+ — Naledi Zulu \(special request\)$/);
    expect(m.text).toContain('4 steaks Rump');
    expect(m.text).toContain('30 eggs Eggs');
    expect(m.text).toContain('SPECIAL REQUEST: 2kg venison steaks');
    expect(m.text).toMatch(/Open it in Terram: http:\/\/localhost\/orders\/or_/);
    expect(m.replyTo).toBe('naledi@example.com');
    expect(m.html).not.toContain('<script');
  });

  it('can be switched off by clearing the addresses', async () => {
    const admin = await signedIn('admin');
    expect((await admin.req('PUT', '/api/admin/settings/customerForm', { notifyEmails: [] })).status).toBe(200);
    await new Client(buildApp()).post('/api/public/orders', order('ref-mail-0002'));
    await flush();
    expect(outbox).toHaveLength(0);
    expect((await admin.req('PUT', '/api/admin/settings/customerForm', { notifyEmails: ['not-an-email'] })).status).toBe(400);
  });

  it('test email reports when email is not set up', async () => {
    delete process.env.EMAIL_TRANSPORT;
    const admin = await signedIn('admin');
    const r = await admin.post('/api/admin/test-email');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/isn’t set up/);
  });
});

describe('adding a customer who may already exist', () => {
  it('points out the same phone, the same name and a similar name', async () => {
    createCustomer({ name: 'Sarah Naidoo', phone: '082 555 1234' }, STAFF);
    createCustomer({ name: 'Pieter van Wyk', phone: '083 555 9999' }, STAFF);
    const staff = await signedIn('staff');
    const look = async (q: string) => (await staff.get(`/api/customers/lookalikes?${q}`)).body.customers.map((x: any) => `${x.name}: ${x.reason}`);
    expect(await look('name=Someone%20New&phone=0825551234')).toEqual(['Sarah Naidoo: Same phone number']);
    expect(await look('name=sarah%20naidoo')).toEqual(['Sarah Naidoo: Same name']);
    expect(await look('name=Sara%20Naidoo')).toEqual(['Sarah Naidoo: Similar name']);
    expect(await look('name=Thandi%20Mokoena&phone=0719990000')).toEqual([]);
  });

  it('never shows the recipients on the public order form', async () => {
    const r = await new Client(buildApp()).get('/api/public/info');
    expect(JSON.stringify(r.body)).not.toMatch(/meacreo|imagine\.co\.za|notifyEmails/);
    expect(r.body.form.terms).toBeTruthy();
  });

  it('explains email server problems in plain words, and forgives stray spaces or quotes', () => {
    process.env.SMTP_HOST = '  cp71.domains.co.za ';
    process.env.SMTP_PORT = '"465"';
    process.env.SMTP_USER = 'orders@terramfarm.co.za ';
    try {
      expect(emailSetup()).toEqual({ host: 'cp71.domains.co.za', port: 465, user: 'orders@terramfarm.co.za', secure: true });
      expect(explainEmailError({ code: 'EAUTH', response: '535 Incorrect authentication data' })).toMatch(/turned down the login for orders@terramfarm\.co\.za.*current password/);
      expect(explainEmailError({ code: 'ESOCKET', message: 'Hostname/IP does not match certificate\'s altnames' })).toMatch(/certificate doesn't match "cp71\.domains\.co\.za"/);
      expect(explainEmailError({ code: 'ETIMEDOUT', message: 'Connection timeout' })).toMatch(/Couldn't connect to cp71\.domains\.co\.za on port 465/);
    } finally {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_PORT;
      delete process.env.SMTP_USER;
    }
  });
});

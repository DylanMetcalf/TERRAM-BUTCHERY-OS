import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb, STAFF } from './helpers';
import { analyseImport, commitBatch, getBatch } from '../server/intelligence/imports';
import { createUser } from '../server/domain/users';
import { createCustomer } from '../server/domain/customers';

beforeEach(() => freshDb());

const summary = (batchId: string) =>
  getBatch(batchId)
    .drafts.filter((d) => d.kind === 'order')
    .map((d) => ({ who: (d.data as any).customer.name, status: d.status, items: (d.data as any).items.map((i: any) => `${i.qty_label} ${i.product_name}`) }));

describe('Terram’s real message formats', () => {
  it('group chat: the customer’s name at the bottom of each post, posted by family members', async () => {
    createUser({ name: 'Jane Metcalf', role: 'manager', family_login: true }, STAFF);
    const today = new Date().toISOString().slice(0, 10).split('-').reverse().join('/');
    const chat = [
      `[${today}, 08:01:10] Jane Metcalf: 2kg mince`,
      `4 rumps`,
      `John Smith`,
      `[${today}, 08:03:44] Jane Metcalf: 1kg boerewors`,
      `6 lamb chops`,
      `Sarah Naidoo 082 555 1234`,
      `[${today}, 08:05:02] Dylan: 3kg chicken breasts`,
      `- Pieter van Wyk`,
    ].join('\n');
    const id = await analyseImport({ text: chat }, STAFF);
    expect(summary(id)).toEqual([
      { who: 'John Smith', status: 'ready', items: ['2kg Beef Mince', '4 steaks Rump Steak'] },
      { who: 'Sarah Naidoo', status: 'ready', items: ['1kg Boerewors', '6 chops Lamb Loin Chops'] },
      { who: 'Pieter van Wyk', status: 'ready', items: ['3kg Chicken Breast Fillets'] },
    ]);
    expect((getBatch(id).drafts[1].data as any).customer.phone).toBe('+27825551234');
  });

  it('plain paste: blocks with the name underneath', async () => {
    const id = await analyseImport({ text: '2kg mince\n4 rumps\nJohn Smith\n\n1kg wors\nSarah' }, STAFF);
    expect(summary(id).map((s) => [s.who, s.items.length, s.status])).toEqual([
      ['John Smith', 2, 'ready'],
      ['Sarah', 1, 'ready'],
    ]);
  });

  it('never mistakes products, preparations or collection lines for a name', async () => {
    const id = await analyseImport({ text: 'Mom: 2kg mince\n4 rumps\nThick cut\n\nMom: 1 whole chicken\nCollect Saturday' }, STAFF);
    const s = summary(id);
    expect(s.map((x) => x.who)).toEqual(['Mom']); // same sender, so the two posts combine
    expect(s[0].items).toEqual(['2kg Beef Mince', '4 steaks Rump Steak', '1 chicken Whole Chicken']);
    const d = getBatch(id).drafts[0].data as any;
    expect(d.items[1].preparation_label).toBe('Thick cut');
    expect(d.fulfilment.type).toBe('collection');
  });

  it('a direct message with no name: staff choose the customer under “From”', async () => {
    const c = createCustomer({ name: 'Anna Venter', phone: '0821112222' }, STAFF);
    const id = await analyseImport({ text: 'Hi, please can I have 2kg mince and 1kg wors for Saturday?', customer: { id: c.id } }, STAFF);
    const [d] = summary(id);
    expect(d).toMatchObject({ who: 'Anna Venter', status: 'ready' });
    const r = commitBatch(id, {}, STAFF, 'staff');
    expect(r.created).toHaveLength(1);
  });

  it('without a name or a “From”, it asks who the order is for instead of guessing', async () => {
    const id = await analyseImport({ text: 'please can I have 2kg mince' }, STAFF);
    const d = getBatch(id).drafts[0];
    expect(d.status).toBe('needs_review');
    expect((d.data as any).issues.map((i: any) => i.code)).toContain('unknown_customer');
  });
});

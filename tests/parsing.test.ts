import { beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from './helpers';
import { listProducts } from '../server/domain/products';
import { buildDictionary, matchProduct, type Dictionary } from '../server/intelligence/matcher';
import { parseMessage } from '../server/intelligence/parser';
import { extractQuantity } from '../server/intelligence/quantity';
import { extractDate } from '../server/intelligence/dates';
import { splitMessages } from '../server/intelligence/splitter';

let dict: Dictionary;
beforeAll(() => {
  freshDb();
  dict = buildDictionary(listProducts());
});
const REF = '2026-09-27'; // a Sunday

describe('quantities', () => {
  it.each([
    ['2kg mince', { kind: 'weight', weight_g: 2000 }],
    ['2 kilos mince', { kind: 'weight', weight_g: 2000 }],
    ['mince 2 kg', { kind: 'weight', weight_g: 2000 }],
    ['half a kilo bacon', { kind: 'weight', weight_g: 500 }],
    ['1,5kg wors', { kind: 'weight', weight_g: 1500 }],
    ['500g bacon', { kind: 'weight', weight_g: 500 }],
    ['15 fillets', { kind: 'count', count: 15 }],
    ['rump x4', { kind: 'count', count: 4 }],
    ['a dozen burgers', { kind: 'count', count: 12 }],
    ['6 x 500g fillets', { kind: 'portions', count: 6, weight_g: 500 }],
    ['3 packs of 500g mince', { kind: 'portions', count: 3, weight_g: 500 }],
  ])('%s', (text, expected) => {
    expect(extractQuantity(text).qty).toMatchObject(expected);
  });

  it('never turns a count into a weight', () => {
    expect(extractQuantity('15 fillets').qty?.weight_g).toBeNull();
  });

  it('flags vague quantities instead of guessing', () => {
    const r = extractQuantity('a couple of rumps');
    expect(r.qty).toBeNull();
    expect(r.ambiguous).toBe(true);
  });
});

describe('dates', () => {
  it('resolves weekdays and relative days from the message date', () => {
    expect(extractDate('collect Saturday', REF).date).toBe('2026-10-03');
    expect(extractDate('tomorrow', REF).date).toBe('2026-09-28');
    expect(extractDate('12/10', REF).date).toBe('2026-10-12');
    expect(extractDate('3 Oct', REF).date).toBe('2026-10-03');
  });
});

describe('product matching', () => {
  const name = (phrase: string) => matchProduct(phrase, dict).product?.name ?? null;
  it('maps spelling variants to one canonical product', () => {
    for (const p of ['ribeye', 'rib eye', 'rib-eye', 'Rib Eyes', 'ribeye steak']) expect(name(p)).toBe('Beef Ribeye');
    for (const p of ['mince', 'beef mince', 'minced beef']) expect(name(p)).toBe('Beef Mince');
    for (const p of ['wors', 'boerewors', 'boere wors', 'boerwors']) expect(name(p)).toBe('Boerewors');
  });
  it('separates preparation from the product', () => {
    const r = matchProduct('ribeye on the bone', dict);
    expect(r.product?.name).toBe('Beef Ribeye');
    expect(r.preparation).toEqual({ Bone: 'Bone-in' });
  });
  it('tolerates small typos but marks them as fuzzy', () => {
    const r = matchProduct('rump steeks', dict);
    expect(r.product?.name).toBe('Rump Steak');
    expect(r.status).toBe('fuzzy');
  });
  it('never invents products', () => {
    expect(matchProduct('cowboy steak', dict).product).toBeNull();
    expect(matchProduct('biltong', dict).product).toBeNull();
  });
  it('does not match across species', () => {
    const r = matchProduct('chicken fillets', dict);
    expect(r.product).toBeNull();
    expect(r.suggestions[0].name).toBe('Chicken Breast Fillets');
  });
});

describe('message classification', () => {
  const intent = (t: string) => parseMessage(t, REF, dict).intent;
  it.each([
    ['Thanks!', 'chatter'],
    ['👍', 'chatter'],
    ['Can I get 2kg mince and 4 rumps?', 'new_order'],
    ['Actually make that 3kg mince.', 'amendment'],
    ['make those 3 instead', 'amendment'],
    ['remove the rumps please', 'amendment'],
    ['please cancel my order', 'cancellation'],
    ['do you have oxtail this week?', 'question'],
    ['collect Saturday after 2pm', 'fulfilment_info'],
  ])('%s → %s', (text, expected) => expect(intent(text)).toBe(expected));

  it('reads a full order with fulfilment', () => {
    const p = parseMessage('2kg mince\n4 rumps\n2 ribeye bone in\nCollect Saturday', REF, dict);
    expect(p.items.map((i) => [i.match.product?.name, i.qty])).toEqual([
      ['Beef Mince', { kind: 'weight', count: null, weight_g: 2000 }],
      ['Rump Steak', { kind: 'count', count: 4, weight_g: null }],
      ['Beef Ribeye', { kind: 'count', count: 2, weight_g: null }],
    ]);
    expect(p.fulfilment).toMatchObject({ type: 'collection', date: '2026-10-03' });
  });

  it('reads addresses without "deliver to"', () => {
    const p = parseMessage('4 T-bones and 2kg boerewors please, delivery Saturday. 7 Wilgerlaan, Vredefort', REF, dict);
    expect(p.fulfilment.address).toBe('7 Wilgerlaan, Vredefort');
    expect(p.items).toHaveLength(2);
  });
});

describe('splitting pasted chats', () => {
  it('separates "Name:" blocks, inline messages and WhatsApp exports', () => {
    const text = `John:\n2kg mince\n4 rumps\n\nSarah: 6 fillets\n[27/09/2026, 09:14:02] Mark Botha: 3kg chicken breasts\n[27/09/2026, 09:15:10] Terram Farm: Thanks Mark!`;
    const m = splitMessages(text, REF, dict, ['Terram Farm']);
    expect(m.map((x) => [x.sender, x.direction])).toEqual([
      ['John', 'in'],
      ['Sarah', 'in'],
      ['Mark Botha', 'in'],
      ['Terram Farm', 'out'],
    ]);
    expect(m[0].text).toBe('2kg mince\n4 rumps');
  });
  it('does not treat product lines as names', () => {
    const m = splitMessages('Mince: 2kg\nRump: 4', REF, dict, []);
    expect(m).toHaveLength(1);
    expect(m[0].sender).toBeNull();
  });
});

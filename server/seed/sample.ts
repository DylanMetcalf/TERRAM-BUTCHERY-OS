import { db, now, tx } from '../db/db.js';
import { addDays, localDate } from '../lib/time.js';
import { audit, CUSTOMER, type Actor } from '../services/audit.js';
import { businessTz } from '../services/settings.js';
import { createCustomer } from '../domain/customers.js';
import { completePacking, createOrder, getItems, markCustomerNotified, requireOrder, setItemPacked, setItemsCut, transition, updateOrder } from '../domain/orders.js';
import { listProducts } from '../domain/products.js';
import { analyseImport, commitBatch, getBatch } from '../intelligence/imports.js';

/**
 * Test Mode sample data. Everything is created through the real pipeline
 * (import → interpretation → validation → engine → workflow) and flagged
 * is_sample so it can be removed without touching real records.
 */
export const SAMPLE_WHATSAPP = `John Smith:
2kg mince
4 rumps
2 ribeye bone in
Collection Saturday

Sarah Naidoo:
6 fillets
1kg boerewors

Mark Botha:
3kg chicken breasts
Delivery Friday
deliver to 14 Kerk Street, Parys

Thandi Mokoena: Hi! Could I please get 2 lamb shanks, 1.5kg wors and a whole chicken spatchcocked for Friday? Collecting after 2pm

Pieter van Wyk:
Leg of lamb deboned and rolled
3 x 500g mince
6 pork chops thick
collect tomorrow

Annelie Steyn: Morning, 4 T-bones and 2kg boerewors please, delivery Saturday. 7 Wilgerlaan, Vredefort

Kagiso Dlamini:
10 burger patties
2kg chicken wings
1kg streaky bacon
Pick up Thursday

John Smith: Actually make the mince 3kg.

Mark Botha: 2 cowboy steaks as well please

Sarah Naidoo: Can I have 4 of those steaks again?

Grace Pillay: Do you have oxtail this week?

Pete Venter: Thanks! 👍

Liezl du Plessis:
1 brisket
2kg short rib
soup bones 2kg
Collection Saturday`;

export function sampleDataStatus() {
  const orders = (db().prepare('SELECT COUNT(*) n FROM orders WHERE is_sample = 1').get() as any).n;
  const customers = (db().prepare('SELECT COUNT(*) n FROM customers WHERE is_sample = 1').get() as any).n;
  const realOrders = (db().prepare('SELECT COUNT(*) n FROM orders WHERE is_sample = 0').get() as any).n;
  return { loaded: orders > 0, orders, customers, real_orders: realOrders };
}

export async function loadSampleData(actor: Actor) {
  if (sampleDataStatus().loaded) return;
  const today = localDate(new Date(), businessTz());
  const beforeCustomers = new Set((db().prepare('SELECT id FROM customers').all() as any[]).map((r) => r.id));
  const beforeOrders = new Set((db().prepare('SELECT id FROM orders').all() as any[]).map((r) => r.id));

  const batchId = await analyseImport({ text: SAMPLE_WHATSAPP, source: 'import', useAi: false }, actor);
  commitBatch(batchId, { sendRestToExceptions: true }, actor, 'admin');
  db().prepare('UPDATE import_batches SET is_sample = 1 WHERE id = ?').run(batchId);

  const bySlug = new Map(listProducts().map((p) => [p.slug, p.id]));
  const P = (slug: string) => bySlug.get(slug)!;

  // A phone order and a form order, so every source is represented
  const hendrik = createCustomer({ name: 'Hendrik Kruger', phone: '082 555 0192', preferred_fulfilment: 'collection' }, actor);
  const phoneOrder = createOrder(
    {
      customer: { id: hendrik.id },
      source: 'phone',
      status: 'confirmed',
      items: [
        { product_id: P('beef_sirloin'), qty: { kind: 'count', count: 4, weight_g: null }, preparation: { Thickness: 'Thick cut' } },
        { product_id: P('boerewors'), qty: { kind: 'weight', count: null, weight_g: 3000 } },
        { product_id: P('lamb_chops'), qty: { kind: 'weight', count: null, weight_g: 1500 } },
      ],
      fulfilment_type: 'collection',
      requested_date: today,
      time_window: 'morning',
      created_summary: 'Phone order (sample)',
    },
    actor,
  );
  const naledi = createCustomer({ name: 'Naledi Zulu', phone: '071 555 3380', email: 'naledi@example.com' }, actor);
  createOrder(
    {
      customer: { id: naledi.id },
      source: 'form',
      status: 'review',
      items: [
        { product_id: P('pork_belly'), qty: { kind: 'weight', count: null, weight_g: 2000 } },
        { product_id: P('pork_ribs'), qty: { kind: 'weight', count: null, weight_g: 1500 }, preparation: { Style: 'Basted' } },
      ],
      fulfilment_type: 'delivery',
      requested_date: addDays(today, 3),
      delivery_address: '22 Church Street, Parys',
      notes: 'Please call when you are close.',
      created_summary: 'Submitted through the online order form (sample)',
    },
    CUSTOMER,
  );
  const lindiwe = createCustomer({ name: 'Lindiwe Khumalo', phone: '083 555 7741' }, actor);
  const done = createOrder(
    {
      customer: { id: lindiwe.id },
      source: 'whatsapp',
      status: 'confirmed',
      items: [
        { product_id: P('beef_mince'), qty: { kind: 'weight', count: null, weight_g: 2000 } },
        { product_id: P('chicken_whole'), qty: { kind: 'count', count: 2, weight_g: null } },
      ],
      fulfilment_type: 'collection',
      requested_date: addDays(today, -1),
      created_summary: 'WhatsApp order (sample)',
    },
    actor,
  );

  // Walk orders through the real workflow so every screen has something on it
  const batch = getBatch(batchId);
  const orderFor = (name: string) => {
    const d = batch.drafts.find((x) => x.order_id && x.kind === 'order' && (x.data as any).customer?.name?.startsWith(name));
    return d?.order_id ? requireOrder(d.order_id) : null;
  };
  const advance = (orderId: string, to: 'cut' | 'packing' | 'ready' | 'completed' | 'out_for_delivery') => {
    const o = requireOrder(orderId);
    if (o.status !== 'confirmed') return;
    setItemsCut(getItems(orderId).map((i) => i.id), true, actor);
    if (to === 'cut') return;
    const items = getItems(orderId);
    setItemPacked(items[0].id, true, actor);
    if (to === 'packing') return;
    for (const it of items) setItemPacked(it.id, true, actor);
    completePacking(orderId, actor);
    if (to === 'ready') return;
    if (to === 'out_for_delivery') {
      transition(orderId, 'out_for_delivery', actor, 'admin');
      return;
    }
    markCustomerNotified(orderId, actor);
    transition(orderId, 'completed', actor, 'admin');
  };
  tx(() => {
    const thandi = orderFor('Thandi');
    const pieter = orderFor('Pieter');
    const annelie = orderFor('Annelie');
    const kagiso = orderFor('Kagiso');
    if (pieter) {
      updateOrder(pieter.id, { requested_date: today }, actor, 'admin');
      advance(pieter.id, 'ready');
    }
    if (kagiso) {
      updateOrder(kagiso.id, { requested_date: today }, actor, 'admin');
      advance(kagiso.id, 'packing');
    }
    if (annelie) advance(annelie.id, 'cut');
    if (thandi) setItemsCut([getItems(thandi.id)[0].id], true, actor);
    advance(phoneOrder.id, 'ready');
    advance(done.id, 'completed');
  });

  const newCustomers = (db().prepare('SELECT id FROM customers').all() as any[]).map((r) => r.id).filter((x) => !beforeCustomers.has(x));
  const newOrders = (db().prepare('SELECT id FROM orders').all() as any[]).map((r) => r.id).filter((x) => !beforeOrders.has(x));
  tx(() => {
    for (const c of newCustomers) db().prepare('UPDATE customers SET is_sample = 1 WHERE id = ?').run(c);
    for (const o of newOrders) db().prepare('UPDATE orders SET is_sample = 1 WHERE id = ?').run(o);
  });
  audit(actor, 'sample.loaded', 'system', null, `Loaded sample data (${newOrders.length} orders)`);
}

export function removeSampleData(actor: Actor) {
  tx(() => {
    const orders = (db().prepare('SELECT id FROM orders WHERE is_sample = 1').all() as any[]).map((r) => r.id);
    const batches = (db().prepare('SELECT id FROM import_batches WHERE is_sample = 1').all() as any[]).map((r) => r.id);
    const customers = (db().prepare('SELECT id FROM customers WHERE is_sample = 1').all() as any[]).map((r) => r.id);
    const inList = (n: number) => Array(n).fill('?').join(',');
    if (orders.length) {
      db().prepare(`DELETE FROM exceptions WHERE order_id IN (${inList(orders.length)})`).run(...orders);
      db().prepare(`DELETE FROM notifications WHERE order_id IN (${inList(orders.length)})`).run(...orders);
      db().prepare(`UPDATE messages SET order_id = NULL WHERE order_id IN (${inList(orders.length)})`).run(...orders);
      db().prepare(`UPDATE import_drafts SET order_id = NULL WHERE order_id IN (${inList(orders.length)})`).run(...orders);
      db().prepare(`DELETE FROM orders WHERE id IN (${inList(orders.length)})`).run(...orders);
    }
    if (batches.length) {
      db().prepare(`DELETE FROM exceptions WHERE import_batch_id IN (${inList(batches.length)})`).run(...batches);
      const msgs = (db().prepare(`SELECT id FROM messages WHERE import_batch_id IN (${inList(batches.length)})`).all(...batches) as any[]).map((r) => r.id);
      if (msgs.length) {
        db().prepare(`DELETE FROM exceptions WHERE message_id IN (${inList(msgs.length)})`).run(...msgs);
        db().prepare(`DELETE FROM interpretations WHERE message_id IN (${inList(msgs.length)})`).run(...msgs);
        db().prepare(`UPDATE order_events SET message_id = NULL WHERE message_id IN (${inList(msgs.length)})`).run(...msgs);
      }
      db().prepare(`DELETE FROM interpretations WHERE import_batch_id IN (${inList(batches.length)})`).run(...batches);
      db().prepare(`DELETE FROM messages WHERE import_batch_id IN (${inList(batches.length)})`).run(...batches);
      db().prepare(`DELETE FROM import_batches WHERE id IN (${inList(batches.length)})`).run(...batches);
    }
    if (customers.length) {
      const stillUsed = new Set((db().prepare(`SELECT DISTINCT customer_id FROM orders WHERE customer_id IN (${inList(customers.length)})`).all(...customers) as any[]).map((r) => r.customer_id));
      const removable = customers.filter((c) => !stillUsed.has(c));
      if (removable.length) {
        db().prepare(`DELETE FROM exceptions WHERE customer_id IN (${inList(removable.length)})`).run(...removable);
        db().prepare(`UPDATE messages SET customer_id = NULL WHERE customer_id IN (${inList(removable.length)})`).run(...removable);
        db().prepare(`UPDATE conversations SET customer_id = NULL WHERE customer_id IN (${inList(removable.length)})`).run(...removable);
        db().prepare(`DELETE FROM customers WHERE id IN (${inList(removable.length)})`).run(...removable);
      }
    }
  });
  audit(actor, 'sample.removed', 'system', null, 'Removed sample data');
  void now;
}

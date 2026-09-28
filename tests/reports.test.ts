import { beforeEach, expect, it } from 'vitest';
import { freshDb, productId, STAFF } from './helpers';
import { createOrder } from '../server/domain/orders';
import { report } from '../server/domain/reports';
import { db } from '../server/db/db';
import { addDays, localDate } from '../server/lib/time';

beforeEach(() => freshDb('terram'));

it('counts an order as completed on the day it was completed, even if it was wanted later', () => {
  const today = localDate(new Date(), 'Africa/Johannesburg');
  const o = createOrder({ customer: { new: { name: 'Jane' } }, source: 'phone', status: 'confirmed', requested_date: addDays(today, 7), items: [{ product_id: productId('beef_rump'), qty: { kind: 'weight', count: null, weight_g: 1000 } }] }, STAFF);
  db().prepare("UPDATE orders SET status = 'completed', completed_at = ? WHERE id = ?").run(new Date().toISOString(), o.id);
  const last30 = report(addDays(today, -30), today);
  expect(last30.by_day.reduce((a: number, d: any) => a + d.completed, 0)).toBe(1);
  expect((last30.by_status as any[]).find((s) => s.status === 'completed')?.n).toBe(1);
  const next7 = report(today, addDays(today, 7));
  expect(next7.by_day.reduce((a: number, d: any) => a + d.orders, 0)).toBe(1); // still listed on the day it's wanted
});

import { signedIn } from './helpers';
it('lets managers delete an order for good (staff cannot), and records it in the audit log', async () => {
  const o = createOrder({ customer: { new: { name: 'Mistake' } }, source: 'phone', status: 'review', items: [{ product_id: productId('beef_rump'), qty: { kind: 'weight', count: null, weight_g: 1000 } }] }, STAFF);
  const staff = await signedIn('staff');
  expect((await staff.req('DELETE', `/api/orders/${o.id}`)).status).toBe(403);
  const manager = await signedIn('manager');
  const r = await manager.req('DELETE', `/api/orders/${o.id}`);
  expect(r.status).toBe(200);
  expect(db().prepare('SELECT COUNT(*) n FROM orders WHERE id = ?').get(o.id)).toEqual({ n: 0 });
  expect(db().prepare('SELECT COUNT(*) n FROM order_items WHERE order_id = ?').get(o.id)).toEqual({ n: 0 });
  expect((db().prepare("SELECT summary FROM audit_log WHERE action = 'order.deleted'").get() as any).summary).toMatch(/Deleted order #\d+ for Mistake.*Rump/);
});

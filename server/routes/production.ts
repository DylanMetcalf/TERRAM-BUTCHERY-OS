import { Hono } from 'hono';
import { addDays, localDate } from '../lib/time.js';
import { businessTz } from '../services/settings.js';
import { cuttingSheet, fulfilmentBoard, packingQueue } from '../domain/production.js';
import { dashboard } from '../domain/dashboard.js';
import { db } from '../db/db.js';
import { getItems, getOrderSummary } from '../domain/orders.js';
import { requirePerm, type Env } from '../http/context.js';
import { ymdParam } from '../http/schemas.js';

const r = new Hono<Env>();

r.get('/dashboard', requirePerm('orders.read'), (c) => c.json(dashboard()));

r.get('/cutting', requirePerm('orders.read'), (c) => {
  const today = localDate(new Date(), businessTz());
  const range = c.req.query('range') ?? 'week';
  let from = ymdParam(c.req.query('from'));
  let to = ymdParam(c.req.query('to'));
  if (!from || !to) {
    if (range === 'today') from = to = today;
    else if (range === 'tomorrow') from = to = addDays(today, 1);
    else if (range === 'all') {
      from = null;
      to = null;
    } else {
      // Next 7 days, plus anything overdue so nothing falls off the sheet
      from = addDays(today, -30);
      to = addDays(today, 6);
    }
  }
  const includeUndated = c.req.query('undated') !== '0';
  return c.json({ from, to, range, today, ...cuttingSheet({ from, to, includeUndated }) });
});

/** Order dockets: every order in production for a day, with its lines. */
r.get('/dockets', requirePerm('orders.read'), (c) => {
  const date = ymdParam(c.req.query('date'));
  const ids = db()
    .prepare(
      `SELECT id FROM orders WHERE status IN ('confirmed','cutting','cut','packing','packed','ready','out_for_delivery')
       AND (? IS NULL OR requested_date = ?) ORDER BY CASE WHEN requested_date IS NULL THEN 1 ELSE 0 END, requested_date, fulfilment_type, order_number`,
    )
    .all(date, date) as { id: string }[];
  return c.json({ date, orders: ids.map((r) => ({ ...getOrderSummary(r.id)!, items: getItems(r.id) })) });
});

r.get('/packing', requirePerm('orders.read'), (c) => c.json(packingQueue()));

r.get('/fulfilment', requirePerm('orders.read'), (c) => {
  const date = ymdParam(c.req.query('date')) ?? localDate(new Date(), businessTz());
  return c.json({ date, ...fulfilmentBoard(date) });
});

export default r;

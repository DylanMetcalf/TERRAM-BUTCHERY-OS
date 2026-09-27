import { Hono } from 'hono';
import { addDays, localDate } from '../lib/time.js';
import { businessTz } from '../services/settings.js';
import { cuttingSheet, fulfilmentBoard, packingQueue } from '../domain/production.js';
import { dashboard } from '../domain/dashboard.js';
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

r.get('/packing', requirePerm('orders.read'), (c) => c.json(packingQueue()));

r.get('/fulfilment', requirePerm('orders.read'), (c) => {
  const date = ymdParam(c.req.query('date')) ?? localDate(new Date(), businessTz());
  return c.json({ date, ...fulfilmentBoard(date) });
});

export default r;

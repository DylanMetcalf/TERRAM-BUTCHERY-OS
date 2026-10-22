import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { db, now } from '../db/db.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { body } from '../http/schemas.js';
import { rateLimit } from '../http/security.js';
import { customerFromUnsubscribe, orderFromToken } from '../services/links.js';
import { fileHeaders, readFile, storeFile } from '../services/files.js';
import { getSettings } from '../services/settings.js';
import { respondToAmendment } from '../domain/amendments.js';
import { buildCheckout } from '../domain/payfast.js';
import { METHOD_LABEL, submitProof } from '../domain/payments.js';
import { requireOrder } from '../domain/orders.js';
import {
  accountView,
  CUSTOMER_COOKIE,
  customerCancel,
  customerOrderView,
  emailForSession,
  endCustomerSession,
  reorderDraft,
  requestSignInCode,
  setReminderPreference,
  submitFeedback,
  verifySignInCode,
} from '../domain/customer-portal.js';

/**
 * Customer-facing API: the order page behind a signed link, and passwordless order history.
 * Every handler first turns the link (or the signed-in email) into the one order it may touch;
 * an order number alone opens nothing.
 */
const r = new Hono();

const secure = () => process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1';

/** The order this link opens. Wrong or revoked links all get the same answer. */
function orderFor(c: Context): string {
  const orderId = orderFromToken(c.req.param('token'));
  if (!orderId) throw new AppError(404, 'This order link isn’t valid any more. Use the latest email from us, or sign in to see your orders.', 'not_found');
  return orderId;
}

const linkLimit = rateLimit('order-link', 300, 10 * 60_000);

r.get('/o/:token', linkLimit, (c) => c.json({ order: customerOrderView(orderFor(c)) }));

r.post('/o/:token/cancel', linkLimit, async (c) => {
  const orderId = orderFor(c);
  const input = await body(c, z.object({ reason: z.string().max(300).nullable().optional() }));
  customerCancel(orderId, input.reason ?? null);
  return c.json({ order: customerOrderView(orderId) });
});

r.post('/o/:token/amendments/:aid', linkLimit, async (c) => {
  const orderId = orderFor(c);
  const input = await body(c, z.object({ accept: z.boolean(), note: z.string().max(500).nullable().optional() }));
  const res = respondToAmendment(orderId, c.req.param('aid'), input.accept, input.note ?? null);
  return c.json({ ...res, order: customerOrderView(orderId) });
});

r.post('/o/:token/pay/online', rateLimit('pay-online', 20, 10 * 60_000), (c) => c.json(buildCheckout(orderFor(c))));

r.post('/o/:token/proof', rateLimit('proof-upload', 10, 60 * 60_000), async (c) => {
  const orderId = orderFor(c);
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > 6 * 1024 * 1024) throw badRequest('The file is too big. The limit is 5 MB.');
  const form = await c.req.parseBody();
  const file = form.file;
  if (!file || typeof file === 'string') throw badRequest('Choose the file with your proof of payment.');
  const amountRaw = typeof form.amount === 'string' ? form.amount.replace(/[^\d.,]/g, '').replace(',', '.') : '';
  const amount = amountRaw ? Math.round(Number(amountRaw) * 100) : null;
  if (amount != null && (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000)) throw badRequest('Check the amount you paid.');
  const o = requireOrder(orderId);
  const stored = storeFile('proof', orderId, file.name, Buffer.from(await file.arrayBuffer()), { userId: null, kind: 'customer', name: o.customer_name });
  submitProof(orderId, stored.id, { amount_cents: amount, note: typeof form.note === 'string' ? form.note : null });
  return c.json({ ok: true, order: customerOrderView(orderId) });
});

r.get('/o/:token/invoice', linkLimit, (c) => {
  const orderId = orderFor(c);
  const row = db().prepare('SELECT invoice_file_id, invoice_status FROM orders WHERE id = ?').get(orderId) as { invoice_file_id: string | null; invoice_status: string };
  if (!row.invoice_file_id || !['issued', 'sent'].includes(row.invoice_status)) throw notFound('That invoice');
  const f = readFile(row.invoice_file_id, orderId);
  return c.body(new Uint8Array(f.data), 200, fileHeaders(f));
});

/** A receipt exists only for a verified payment on this order. */
r.get('/o/:token/receipt/:pid', linkLimit, (c) => {
  const orderId = orderFor(c);
  const p = db().prepare("SELECT * FROM payments WHERE id = ? AND order_id = ? AND status = 'verified'").get(c.req.param('pid'), orderId) as any;
  if (!p) throw notFound('That receipt');
  const o = requireOrder(orderId);
  const s = getSettings();
  const paidBefore = (db().prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE order_id = ? AND status = 'verified' AND created_at <= ?").get(orderId, p.created_at) as { s: number }).s;
  const due = o.final_total_cents ?? o.confirmed_total_cents ?? o.estimated_total_cents;
  return c.json({
    receipt: {
      number: `R${p.receipt_number}`,
      date: p.created_at,
      order_number: o.order_number,
      customer_name: o.customer_name,
      amount_cents: p.amount_cents,
      method: METHOD_LABEL[p.method as keyof typeof METHOD_LABEL],
      reference: p.provider_ref ? `PayFast ${String(p.provider_ref).split(':')[0]}` : null,
      verified_by: p.verified_by_kind === 'provider' ? 'Confirmed by PayFast' : `Verified by ${s.business.name}`,
      order_total_cents: due,
      paid_to_date_cents: paidBefore,
      balance_cents: due == null ? null : Math.max(0, due - paidBefore),
      business: { name: s.business.name, address: s.business.address, phone: s.business.phone, email: s.business.email },
    },
  });
});

r.post('/o/:token/feedback', rateLimit('feedback', 10, 60 * 60_000), async (c) => {
  const orderId = orderFor(c);
  const input = await body(c, z.object({ rating: z.number().int().min(1).max(5).nullable().optional(), comment: z.string().max(1500).nullable().optional() }));
  submitFeedback(orderId, input.rating ?? null, input.comment ?? null);
  return c.json({ ok: true, order: customerOrderView(orderId) });
});

r.get('/o/:token/reorder', linkLimit, (c) => c.json(reorderDraft(orderFor(c))));

// ── Order history (passwordless) ─────────────────────────────

r.post('/account/code', rateLimit('account-code', 6, 15 * 60_000), async (c) => {
  const input = await body(c, z.object({ email: z.string().trim().max(200) }));
  requestSignInCode(input.email);
  // Same answer whether or not we know the address
  return c.json({ ok: true, message: 'If we have orders for that email address, we’ve sent it a 6-digit code. It can take a minute to arrive.' });
});

r.post('/account/verify', rateLimit('account-verify', 15, 15 * 60_000), async (c) => {
  const input = await body(c, z.object({ email: z.string().trim().max(200), code: z.string().trim().max(12) }));
  const session = verifySignInCode(input.email, input.code);
  if (!session) throw new AppError(400, 'That code isn’t right or has expired. Check the latest email, or ask for a new code.', 'bad_code');
  setCookie(c, CUSTOMER_COOKIE, session.token, { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', expires: session.expires });
  return c.json({ ok: true });
});

function signedInEmail(c: Context): string {
  const email = emailForSession(getCookie(c, CUSTOMER_COOKIE));
  if (!email) throw new AppError(401, 'Please sign in to see your orders.', 'customer_signed_out');
  return email;
}

r.get('/account', (c) => c.json(accountView(signedInEmail(c))));

r.post('/account/preferences', async (c) => {
  const email = signedInEmail(c);
  const input = await body(c, z.object({ reminders: z.boolean() }));
  setReminderPreference(email, input.reminders);
  return c.json(accountView(email));
});

r.post('/account/logout', (c) => {
  endCustomerSession(getCookie(c, CUSTOMER_COOKIE));
  deleteCookie(c, CUSTOMER_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ── Unsubscribe from reminders (from the link in a reminder email) ──

r.get('/unsubscribe/:token', (c) => {
  const cid = customerFromUnsubscribe(c.req.param('token'));
  if (!cid) throw notFound('That link');
  const row = db().prepare('SELECT name, marketing_consent FROM customers WHERE id = ?').get(cid) as { name: string; marketing_consent: number } | undefined;
  if (!row) throw notFound('That link');
  return c.json({ first_name: row.name.split(' ')[0], subscribed: !!row.marketing_consent });
});

r.post('/unsubscribe/:token', async (c) => {
  const cid = customerFromUnsubscribe(c.req.param('token'));
  if (!cid) throw notFound('That link');
  const input = await body(c, z.object({ subscribed: z.boolean() }));
  db().prepare('UPDATE customers SET marketing_consent = ?, marketing_consent_at = ? WHERE id = ?').run(input.subscribed ? 1 : 0, now(), cid);
  return c.json({ subscribed: input.subscribed });
});

export default r;

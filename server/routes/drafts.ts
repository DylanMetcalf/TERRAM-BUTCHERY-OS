import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { db, now } from '../db/db.js';
import { badRequest } from '../lib/errors.js';
import { rateLimit } from '../http/security.js';

/**
 * Unfinished order-form baskets, saved on the server so a customer who leaves (or whose browser
 * clears its storage) can pick up where they stopped. The draft is tied to a random, httpOnly
 * cookie on their device, never to a name or phone number, expires after 14 days, and is deleted
 * the moment the order is sent. A draft is never an order: nothing is created until checkout.
 */
const r = new Hono();
export const DRAFT_COOKIE = 'terram_draft';
const DAYS = 14;
const MAX_BYTES = 60_000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const secure = () => process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1';

function draftId(c: Context): string | null {
  const t = getCookie(c, DRAFT_COOKIE);
  return t && /^[A-Za-z0-9_-]{20,64}$/.test(t) ? sha(t) : null;
}

/** Called when an order is sent: the draft has done its job. */
export function deleteDraft(c: Context) {
  const id = draftId(c);
  if (id) db().prepare('DELETE FROM order_drafts WHERE id = ?').run(id);
  deleteCookie(c, DRAFT_COOKIE, { path: '/' });
}

export function purgeExpiredDrafts() {
  return db().prepare('DELETE FROM order_drafts WHERE expires_at < ?').run(now()).changes;
}

r.get('/draft', (c) => {
  const id = draftId(c);
  const row = id ? (db().prepare('SELECT data, updated_at, expires_at FROM order_drafts WHERE id = ?').get(id) as { data: string; updated_at: string; expires_at: string } | undefined) : undefined;
  if (!row || row.expires_at < now()) return c.json({ draft: null });
  c.header('Cache-Control', 'no-store');
  return c.json({ draft: JSON.parse(row.data), saved_at: row.updated_at });
});

r.put('/draft', rateLimit('order-draft', 240, 10 * 60_000), async (c) => {
  const text = await c.req.text();
  if (text.length > MAX_BYTES) throw badRequest('That order is too large to save.');
  let data: any;
  try {
    data = JSON.parse(text)?.draft;
  } catch {
    throw badRequest('Could not save your order.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('Could not save your order.');
  let token = getCookie(c, DRAFT_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) token = crypto.randomBytes(24).toString('base64url');
  const id = sha(token);
  const expires = new Date(Date.now() + DAYS * 86400_000);
  const ts = now();
  db()
    .prepare('INSERT INTO order_drafts (id, data, created_at, updated_at, expires_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, expires_at = excluded.expires_at')
    .run(id, JSON.stringify(data), ts, ts, expires.toISOString());
  setCookie(c, DRAFT_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', expires });
  return c.json({ ok: true, saved_at: ts });
});

r.delete('/draft', (c) => {
  deleteDraft(c);
  return c.json({ ok: true });
});

export default r;

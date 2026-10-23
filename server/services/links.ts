import crypto from 'node:crypto';
import { db, now } from '../db/db.js';
import { getSettings } from './settings.js';

/**
 * Customer links. Every customer-facing link uses the configured public address (never the
 * address a request happened to arrive on, and never localhost). Order links are signed: the
 * signature is an HMAC of the order id and its link version with a server secret, so links can't
 * be guessed from an order number and can be revoked by bumping the version.
 */

let secret: Buffer | null = null;

/** APP_SECRET from the environment; otherwise one is generated once and kept in the database. */
function appSecret(): Buffer {
  if (secret) return secret;
  const fromEnv = (process.env.APP_SECRET ?? '').trim();
  if (fromEnv.length >= 32) return (secret = Buffer.from(fromEnv));
  const row = db().prepare("SELECT value FROM settings WHERE key = 'app_secret'").get() as { value: string } | undefined;
  if (row) return (secret = Buffer.from(JSON.parse(row.value)));
  const fresh = crypto.randomBytes(48).toString('base64url');
  db().prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('app_secret', ?, ?)").run(JSON.stringify(fresh), now());
  const saved = db().prepare("SELECT value FROM settings WHERE key = 'app_secret'").get() as { value: string };
  return (secret = Buffer.from(JSON.parse(saved.value)));
}

/** Tests open a fresh database each time. */
export function resetLinkSecret() {
  secret = null;
}

function sign(purpose: string, ...parts: (string | number)[]): string {
  return crypto.createHmac('sha256', appSecret()).update([purpose, ...parts].join(':')).digest('base64url').slice(0, 32);
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function siteUrl(): string {
  const fromEnv = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(fromEnv)) return fromEnv;
  return getSettings().business.siteUrl.replace(/\/+$/, '');
}

// ── Order links ──────────────────────────────────────────────
export function orderToken(orderId: string): string {
  const row = db().prepare('SELECT access_version FROM orders WHERE id = ?').get(orderId) as { access_version: number } | undefined;
  return `${orderId}.${sign('order', orderId, row?.access_version ?? 1)}`;
}

export function orderUrl(orderId: string, extra = ''): string {
  return `${siteUrl()}/o/${orderToken(orderId)}${extra}`;
}

/** The order a link opens, or null if the link is wrong, tampered with or revoked. */
export function orderFromToken(token: string | undefined | null): string | null {
  if (!token || token.length > 120) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const orderId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const row = db().prepare('SELECT access_version FROM orders WHERE id = ?').get(orderId) as { access_version: number } | undefined;
  if (!row) return null;
  return same(sig, sign('order', orderId, row.access_version)) ? orderId : null;
}

/** Makes every earlier link to this order stop working (e.g. it was forwarded to the wrong person). */
export function revokeOrderLinks(orderId: string) {
  db().prepare('UPDATE orders SET access_version = access_version + 1, updated_at = ? WHERE id = ?').run(now(), orderId);
}

// ── Unsubscribe links (marketing only) ───────────────────────
export function unsubscribeUrl(customerId: string): string {
  return `${siteUrl()}/unsubscribe/${customerId}.${sign('unsub', customerId)}`;
}

export function customerFromUnsubscribe(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1 || token.length > 120) return null;
  const id = token.slice(0, dot);
  return same(token.slice(dot + 1), sign('unsub', id)) ? id : null;
}

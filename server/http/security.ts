import type { MiddlewareHandler } from 'hono';
import crypto from 'node:crypto';
import { db, now } from '../db/db.js';
import { AppError } from '../lib/errors.js';
import type { Env } from './context.js';

/** Basic hardening headers for every response. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (!c.req.path.startsWith('/api/')) {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  }
};

/**
 * CSRF protection for cookie-authenticated requests: state-changing API calls
 * must come from our own origin and carry the X-Terram header (which a
 * cross-site form cannot set). Webhooks authenticate differently and are exempt.
 */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || c.req.path.startsWith('/api/integrations/')) return next();
  if (c.req.header('x-terram') !== '1') throw new AppError(403, 'This request was blocked for security reasons. Please reload the page.', 'csrf');
  const origin = c.req.header('origin');
  if (origin) {
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
    try {
      if (new URL(origin).host !== host) throw new AppError(403, 'This request was blocked for security reasons.', 'csrf');
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(403, 'This request was blocked for security reasons.', 'csrf');
    }
  }
  return next();
};

const buckets = new Map<string, { n: number; reset: number }>();

/** Fixed-window in-memory rate limiter (per process). */
export function rateLimit(name: string, max: number, windowMs: number): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.env?.incoming?.socket?.remoteAddress ?? 'local';
    const key = `${name}:${ip}`;
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < t) {
      b = { n: 0, reset: t + windowMs };
      buckets.set(key, b);
    }
    b.n++;
    if (b.n > max) {
      c.header('Retry-After', String(Math.ceil((b.reset - t) / 1000)));
      throw new AppError(429, 'Too many attempts. Please wait a moment and try again.', 'rate_limited');
    }
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
    await next();
  };
}

/**
 * Idempotency: a POST carrying an Idempotency-Key returns the stored response
 * on retry (double-clicks, refreshes, flaky networks) instead of acting twice.
 */
export const idempotency: MiddlewareHandler<Env> = async (c, next) => {
  const key = c.req.header('idempotency-key');
  if (c.req.method !== 'POST' || !key) return next();
  if (key.length > 100) throw new AppError(400, 'Invalid idempotency key.');
  const scoped = crypto.createHash('sha256').update(`${c.get('user')?.id ?? 'anon'}:${c.req.path}:${key}`).digest('hex');
  const existing = db().prepare('SELECT status, response FROM idempotency_keys WHERE key = ?').get(scoped) as any;
  if (existing) {
    c.header('Idempotent-Replay', 'true');
    return c.body(existing.response, existing.status, { 'Content-Type': 'application/json' });
  }
  await next();
  if (c.res.status < 500 && c.res.headers.get('content-type')?.includes('application/json')) {
    const body = await c.res.clone().text();
    db().prepare('INSERT OR IGNORE INTO idempotency_keys (key, scope, user_id, status, response, created_at) VALUES (?,?,?,?,?,?)').run(scoped, c.req.path, c.get('user')?.id ?? null, c.res.status, body, now());
  }
};

export function purgeIdempotencyKeys() {
  db().prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(new Date(Date.now() - 48 * 3600_000).toISOString());
}

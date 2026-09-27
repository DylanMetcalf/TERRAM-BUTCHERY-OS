import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { can, type Permission, type Role } from '../../shared/permissions.js';
import { SESSION_COOKIE, userForToken, type SessionUser } from '../auth/sessions.js';
import { forbidden, AppError } from '../lib/errors.js';
import type { Actor } from '../services/audit.js';

export type Env = { Variables: { user: SessionUser | null; requestId: string } };

export const loadUser: MiddlewareHandler<Env> = async (c, next) => {
  c.set('user', userForToken(getCookie(c, SESSION_COOKIE)));
  await next();
};

export function requireAuth(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!c.get('user')) throw new AppError(401, 'Please sign in.', 'unauthenticated');
    await next();
  };
}

/** Server-side permission check. Hiding a button is never the only protection. */
export function requirePerm(p: Permission): MiddlewareHandler<Env> {
  return async (c, next) => {
    const u = c.get('user');
    if (!u) throw new AppError(401, 'Please sign in.', 'unauthenticated');
    if (!can(u.role, p)) throw forbidden();
    await next();
  };
}

export function actorOf(c: Context<Env>): Actor {
  const u = c.get('user');
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  return u ? { userId: u.id, kind: 'user', name: u.name, ip } : { userId: null, kind: 'system', ip };
}

export function roleOf(c: Context<Env>): Role | null {
  return c.get('user')?.role ?? null;
}

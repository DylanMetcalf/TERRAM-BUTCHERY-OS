import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { db, now } from '../db/db.js';
import { ROLE_PERMISSIONS } from '../../shared/permissions.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, destroySession, SESSION_COOKIE } from '../auth/sessions.js';
import { AppError } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { recordSystemEvent } from '../services/health.js';
import { getSettings } from '../services/settings.js';
import { createUser, needsSetup } from '../domain/users.js';
import { body } from '../http/schemas.js';
import { rateLimit } from '../http/security.js';
import type { Env } from '../http/context.js';

const r = new Hono<Env>();
const secure = () => process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1';

function startSession(c: any, userId: string) {
  const { token, expires } = createSession(userId, c.req.header('user-agent') ?? null);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', expires });
  db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
}

r.get('/me', (c) => {
  const u = c.get('user');
  const s = getSettings();
  return c.json({
    user: u ? { ...u, permissions: ROLE_PERMISSIONS[u.role] } : null,
    needs_setup: needsSetup(),
    business: { name: s.business.name, tagline: s.business.tagline, timezone: s.business.timezone, currency: s.business.currency },
  });
});

r.post('/login', rateLimit('login', 10, 5 * 60_000), async (c) => {
  const { email, password } = await body(c, z.object({ email: z.string().max(200), password: z.string().max(200) }));
  const u = db().prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim()) as any;
  const ok = u && u.active && verifyPassword(password, u.password_hash);
  if (!ok) {
    recordSystemEvent('warning', 'auth', 'Failed sign-in attempt', { email: email.slice(0, 80) });
    throw new AppError(401, 'That email and password do not match.', 'bad_credentials');
  }
  startSession(c, u.id);
  audit({ userId: u.id, kind: 'user', name: u.name }, 'auth.login', 'user', u.id, `${u.name} signed in`);
  return c.json({ ok: true });
});

/** First-run setup: creates the first admin when there are no users at all. */
r.post('/setup', rateLimit('setup', 5, 60_000), async (c) => {
  if (!needsSetup()) throw new AppError(409, 'Setup has already been completed.');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().max(200), password: z.string().min(8, 'Use at least 8 characters').max(200) }));
  const u = createUser({ ...input, role: 'admin' }, { userId: null, kind: 'system' });
  startSession(c, u.id);
  return c.json({ ok: true });
});

r.post('/logout', (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) destroySession(token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

export default r;

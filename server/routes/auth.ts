import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { db, now } from '../db/db.js';
import { ROLE_PERMISSIONS } from '../../shared/permissions.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, destroySession, FAMILY_SESSION_DAYS, SESSION_COOKIE } from '../auth/sessions.js';
import { checkFamilyCode, familyCodeSet, familyPeople } from '../auth/family.js';
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

function startSession(c: any, userId: string, via: 'password' | 'family' = 'password') {
  const { token, expires } = createSession(userId, c.req.header('user-agent') ?? null, via === 'family' ? { days: FAMILY_SESSION_DAYS, via } : {});
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', expires });
  db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
}

r.get('/me', (c) => {
  const u = c.get('user');
  const s = getSettings();
  return c.json({
    user: u ? { ...u, permissions: ROLE_PERMISSIONS[u.role] } : null,
    needs_setup: needsSetup(),
    family_login: familyCodeSet() && familyPeople().length > 0,
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
  const u = createUser({ ...input, role: 'admin', family_login: true }, { userId: null, kind: 'system' });
  startSession(c, u.id);
  return c.json({ ok: true });
});

/** Step 1 of family sign-in: the code unlocks the list of names. */
r.post('/family/people', rateLimit('family', 10, 5 * 60_000), async (c) => {
  const { code } = await body(c, z.object({ code: z.string().max(100) }));
  if (!checkFamilyCode(code)) {
    recordSystemEvent('warning', 'auth', 'Wrong family code entered');
    throw new AppError(401, 'That family code isn’t right. Check with whoever set it up.', 'bad_code');
  }
  return c.json({ people: familyPeople().map((p) => ({ id: p.id, name: p.name })) });
});

/** Step 2: pick your name. The device then stays signed in for months. */
r.post('/family/login', rateLimit('family-login', 10, 5 * 60_000), async (c) => {
  const { code, user_id } = await body(c, z.object({ code: z.string().max(100), user_id: z.string().max(64) }));
  if (!checkFamilyCode(code)) throw new AppError(401, 'That family code isn’t right.', 'bad_code');
  const person = familyPeople().find((p) => p.id === user_id);
  if (!person) throw new AppError(403, 'That person can’t use the family code. Ask an admin to allow it.', 'not_allowed');
  startSession(c, person.id, 'family');
  audit({ userId: person.id, kind: 'user', name: person.name }, 'auth.login', 'user', person.id, `${person.name} signed in with the family code`, { via: 'family', device: c.req.header('user-agent')?.slice(0, 120) });
  return c.json({ ok: true });
});

r.post('/logout', (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) destroySession(token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

export default r;

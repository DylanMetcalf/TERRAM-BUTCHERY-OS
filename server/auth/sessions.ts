import crypto from 'node:crypto';
import { db, now } from '../db/db.js';
import type { Role } from '../../shared/permissions.js';

export const SESSION_COOKIE = 'terram_session';
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(userId: string, userAgent: string | null): { token: string; expires: Date } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  db().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)').run(sha(token), userId, now(), expires.toISOString(), userAgent?.slice(0, 300) ?? null);
  return { token, expires };
}

export function userForToken(token: string | undefined): SessionUser | null {
  if (!token || token.length > 200) return null;
  const row = db()
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND u.active = 1`,
    )
    .get(sha(token)) as (SessionUser & { expires_at: string }) | undefined;
  if (!row) return null;
  if (row.expires_at < now()) {
    destroySession(token);
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

export function destroySession(token: string) {
  db().prepare('DELETE FROM sessions WHERE id = ?').run(sha(token));
}

export function destroyUserSessions(userId: string) {
  db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions() {
  db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

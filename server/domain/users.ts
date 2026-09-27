import crypto from 'node:crypto';
import { db, id, now } from '../db/db.js';
import { ROLES, type Role } from '../../shared/permissions.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { destroyUserSessions } from '../auth/sessions.js';
import { audit, type Actor } from '../services/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const SELECT_USER = "SELECT id, name, CASE WHEN email LIKE '%@people.terram.local' THEN '' ELSE email END AS email, role, active, family_login, last_login_at, created_at FROM users";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: number;
  family_login: number;
  last_login_at: string | null;
  created_at: string;
}

export function listUsers(): UserRow[] {
  return db().prepare(`${SELECT_USER} ORDER BY active DESC, name`).all() as UserRow[];
}

export function createUser(input: { name: string; email?: string | null; role: Role; password?: string | null; family_login?: boolean }, actor: Actor): UserRow {
  const name = input.name?.trim();
  if (!name) throw badRequest('Enter a name.');
  if (!ROLES.includes(input.role)) throw badRequest('Choose a role.');
  const uid = id('us_');
  // Family members don't need an email: they sign in with the family code
  const email = input.email?.trim().toLowerCase() || `${uid.toLowerCase()}@people.terram.local`;
  if (input.email?.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address.');
  if (!input.password && !input.family_login) throw badRequest('Set a password, or allow this person to use the family code.');
  if (input.password) {
    const pw = passwordProblem(input.password);
    if (pw) throw badRequest(pw);
  }
  if (db().prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw conflict('Someone already uses that email address.');
  // A random, unknown password for code-only people: they simply can't use the email sign-in
  const hash = hashPassword(input.password || crypto.randomBytes(24).toString('base64url'));
  db()
    .prepare('INSERT INTO users (id, name, email, role, password_hash, active, family_login, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)')
    .run(uid, name, email, input.role, hash, input.family_login ? 1 : 0, now(), now());
  audit(actor, 'user.created', 'user', uid, `Added ${name} (${input.role})`);
  return db().prepare(`${SELECT_USER} WHERE id = ?`).get(uid) as UserRow;
}

export function updateUser(userId: string, input: { name?: string; role?: Role; active?: boolean; password?: string; family_login?: boolean }, actor: Actor): UserRow {
  const u = db().prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!u) throw notFound('That user');
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) throw badRequest('Enter a name.');
    fields.name = input.name.trim();
  }
  if (input.role !== undefined) {
    if (!ROLES.includes(input.role)) throw badRequest('Choose a role.');
    fields.role = input.role;
  }
  if (input.active !== undefined) fields.active = input.active ? 1 : 0;
  if (input.family_login !== undefined) fields.family_login = input.family_login ? 1 : 0;
  if (input.password) {
    const pw = passwordProblem(input.password);
    if (pw) throw badRequest(pw);
    fields.password_hash = hashPassword(input.password);
  }
  // Never lock the business out: keep at least one active admin
  const demotingAdmin = u.role === 'admin' && ((input.role && input.role !== 'admin') || input.active === false);
  if (demotingAdmin) {
    const admins = (db().prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get() as any).n;
    if (admins <= 1) throw conflict('There must always be at least one active admin.');
  }
  if (!Object.keys(fields).length) return u;
  db().prepare(`UPDATE users SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(fields), now(), userId);
  if (input.active === false || input.password || input.role || input.family_login === false) destroyUserSessions(userId);
  audit(actor, 'user.updated', 'user', userId, `Updated ${u.name}`, { ...input, password: input.password ? '(changed)' : undefined });
  return db().prepare(`${SELECT_USER} WHERE id = ?`).get(userId) as UserRow;
}

export function ensureInitialAdmin() {
  const n = (db().prepare('SELECT COUNT(*) n FROM users').get() as any).n;
  if (n > 0) return null;
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (email && password) return createUser({ name: process.env.INITIAL_ADMIN_NAME || 'Administrator', email, password, role: 'admin', family_login: true }, { userId: null, kind: 'system' });
  return null;
}

export function needsSetup(): boolean {
  return (db().prepare('SELECT COUNT(*) n FROM users').get() as any).n === 0;
}

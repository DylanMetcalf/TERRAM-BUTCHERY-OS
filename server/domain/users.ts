import { db, id, now } from '../db/db.js';
import { ROLES, type Role } from '../../shared/permissions.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { destroyUserSessions } from '../auth/sessions.js';
import { audit, type Actor } from '../services/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: number;
  last_login_at: string | null;
  created_at: string;
}

export function listUsers(): UserRow[] {
  return db().prepare('SELECT id, name, email, role, active, last_login_at, created_at FROM users ORDER BY active DESC, name').all() as UserRow[];
}

export function createUser(input: { name: string; email: string; role: Role; password: string }, actor: Actor): UserRow {
  const name = input.name?.trim();
  const email = input.email?.trim().toLowerCase();
  if (!name) throw badRequest('Enter a name.');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address.');
  if (!ROLES.includes(input.role)) throw badRequest('Choose a role.');
  const pw = passwordProblem(input.password);
  if (pw) throw badRequest(pw);
  if (db().prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw conflict('Someone already uses that email address.');
  const uid = id('us_');
  db()
    .prepare('INSERT INTO users (id, name, email, role, password_hash, active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)')
    .run(uid, name, email, input.role, hashPassword(input.password), now(), now());
  audit(actor, 'user.created', 'user', uid, `Added ${name} (${input.role})`);
  return db().prepare('SELECT id, name, email, role, active, last_login_at, created_at FROM users WHERE id = ?').get(uid) as UserRow;
}

export function updateUser(userId: string, input: { name?: string; role?: Role; active?: boolean; password?: string }, actor: Actor): UserRow {
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
  if (input.active === false || input.password || input.role) destroyUserSessions(userId);
  audit(actor, 'user.updated', 'user', userId, `Updated ${u.name}`, { ...input, password: input.password ? '(changed)' : undefined });
  return db().prepare('SELECT id, name, email, role, active, last_login_at, created_at FROM users WHERE id = ?').get(userId) as UserRow;
}

export function ensureInitialAdmin() {
  const n = (db().prepare('SELECT COUNT(*) n FROM users').get() as any).n;
  if (n > 0) return null;
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (email && password) return createUser({ name: 'Administrator', email, password, role: 'admin' }, { userId: null, kind: 'system' });
  return null;
}

export function needsSetup(): boolean {
  return (db().prepare('SELECT COUNT(*) n FROM users').get() as any).n === 0;
}

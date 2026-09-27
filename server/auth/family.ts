import { db, now } from '../db/db.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * Family code: one shared code per business. Anyone with the code picks their
 * name on a new device and stays signed in. The code is stored hashed; only
 * people an admin has marked "can use the family code" appear in the list.
 */
const KEY = 'family_code_hash';

export function familyCodeSet(): boolean {
  return !!db().prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY);
}

export function setFamilyCode(code: string | null, userId: string | null) {
  if (!code) {
    db().prepare('DELETE FROM settings WHERE key = ?').run(KEY);
    return;
  }
  db()
    .prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .run(KEY, JSON.stringify(hashPassword(normaliseCode(code))), now(), userId);
}

export function checkFamilyCode(code: string): boolean {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row || !code) return false;
  try {
    return verifyPassword(normaliseCode(code), JSON.parse(row.value));
  } catch {
    return false;
  }
}

/** Codes are forgiving about case and spaces — they get typed on phones. */
export function normaliseCode(code: string) {
  return code.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function familyPeople(): { id: string; name: string; role: string }[] {
  return db().prepare("SELECT id, name, role FROM users WHERE active = 1 AND family_login = 1 ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END, name").all() as any[];
}

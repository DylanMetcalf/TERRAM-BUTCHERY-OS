import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MIGRATIONS } from './schema.js';

export type DB = Database.Database;

let current: DB | null = null;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  current = db;
  return db;
}

export function db(): DB {
  if (!current) throw new Error('Database not initialised');
  return current;
}

export function setDb(d: DB) {
  current = d;
}

function migrate(d: DB) {
  d.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set((d.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    d.transaction(() => {
      d.exec(m.sql);
      d.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, now());
    })();
  }
}

export function id(prefix = ''): string {
  // Sortable-ish, URL-safe ids: time component + randomness
  const t = Date.now().toString(36).padStart(9, '0');
  const r = crypto.randomBytes(8).toString('base64url');
  return `${prefix}${t}${r}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function json<T = unknown>(v: string | null | undefined, fallback: T): T {
  if (v == null || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function tx<T>(fn: () => T): T {
  return db().transaction(fn)();
}

export function nextCounter(name: string): number {
  const row = db().prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value').get(name) as { value: number };
  return row.value;
}

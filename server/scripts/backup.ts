/**
 * Consistent online backup of the database (safe while the server runs).
 *   npm run backup            → ./data/backups/terram-YYYY-MM-DDTHH-MM.db, keeps the newest 30
 * Schedule nightly, e.g. cron:  15 2 * * *  cd /app && npm run backup
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../db/db.js';

const dir = process.env.BACKUP_DIR ?? './data/backups';
const keep = Number(process.env.BACKUP_KEEP ?? 30);
fs.mkdirSync(dir, { recursive: true });
const db = openDatabase(process.env.DATABASE_PATH ?? './data/terram.db');
const file = path.join(dir, `terram-${new Date().toISOString().slice(0, 16).replace(':', '-')}.db`);
await db.backup(file);
const check = (await import('better-sqlite3')).default(file, { readonly: true }).prepare('PRAGMA integrity_check').get() as { integrity_check: string };
if (check.integrity_check !== 'ok') {
  console.error(`Backup written to ${file} but failed its integrity check: ${check.integrity_check}`);
  process.exit(1);
}
const old = fs.readdirSync(dir).filter((f) => /^terram-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.unlinkSync(path.join(dir, f));
console.log(`Backup OK: ${file}${old.length ? ` (removed ${old.length} old)` : ''}`);

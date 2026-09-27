import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/db.js';
import { localDate } from '../lib/time.js';
import { recordSystemEvent } from './health.js';
import { businessTz } from './settings.js';

/**
 * Background housekeeping that must run without anyone remembering to do it.
 * Today: a nightly database backup kept on the server's disk.
 */
export function backupDir(): string {
  return process.env.BACKUP_DIR ?? path.join(path.dirname(path.resolve(process.env.DATABASE_PATH ?? './data/terram.db')), 'backups');
}

export function listBackups(): { file: string; bytes: number; created_at: string }[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^terram-.*\.db$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, bytes: st.size, created_at: st.mtime.toISOString() };
    });
}

export async function runBackup(reason: 'nightly' | 'manual' = 'nightly'): Promise<string> {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `terram-${new Date().toISOString().slice(0, 16).replace(':', '-')}.db`);
  await db().backup(file);
  const keep = Number(process.env.BACKUP_KEEP ?? 14);
  for (const old of listBackups().slice(keep)) fs.unlinkSync(path.join(dir, old.file));
  recordSystemEvent('info', 'server', `Database backup saved (${reason})`, path.basename(file));
  return file;
}

let timer: NodeJS.Timeout | null = null;

/** Checks every 15 minutes; after 02:00 local time, makes today's backup if it doesn't exist yet. */
export function startJobs() {
  if (timer || process.env.TERRAM_DISABLE_JOBS === '1') return;
  const tick = async () => {
    try {
      const tz = businessTz();
      const today = localDate(new Date(), tz);
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()));
      const haveToday = listBackups().some((b) => localDate(new Date(b.created_at), tz) === today);
      if (hour >= 2 && !haveToday) await runBackup('nightly');
    } catch (e) {
      recordSystemEvent('error', 'server', 'Nightly backup failed', String((e as Error)?.stack ?? e));
    }
  };
  timer = setInterval(tick, 15 * 60_000);
  timer.unref();
  setTimeout(tick, 60_000).unref();
}

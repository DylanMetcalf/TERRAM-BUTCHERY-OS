import { serve } from '@hono/node-server';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from './db/db.js';
import { seedCatalogue, upgradeCatalogue } from './domain/products.js';
import { ensureInitialAdmin } from './domain/users.js';
import { purgeExpiredSessions } from './auth/sessions.js';
import { purgeIdempotencyKeys } from './http/security.js';
import { recordSystemEvent } from './services/health.js';
import { buildApp } from './app.js';
import { startJobs } from './services/jobs.js';

// Minimal .env loader (no dependency)
const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const dbPath = process.env.DATABASE_PATH ?? './data/terram.db';
openDatabase(dbPath);
seedCatalogue();
upgradeCatalogue();
const admin = ensureInitialAdmin();
if (admin) console.log(`[terram] Created initial admin ${admin.email}`);

const staticDir = path.resolve(process.env.STATIC_DIR ?? 'dist/web');
const app = buildApp({ staticDir: fs.existsSync(staticDir) ? staticDir : null });
const port = Number(process.env.PORT ?? 8080);

setInterval(() => {
  try {
    purgeExpiredSessions();
    purgeIdempotencyKeys();
  } catch (e) {
    recordSystemEvent('error', 'server', 'Housekeeping failed', String(e));
  }
}, 3600_000).unref();

startJobs();

serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`[terram] Butchery OS running on http://localhost:${info.port} (db: ${dbPath})`);
});

process.on('unhandledRejection', (e) => recordSystemEvent('error', 'server', 'Unhandled rejection', String((e as any)?.stack ?? e)));

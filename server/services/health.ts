import { db, id, now } from '../db/db.js';

export type Component = 'import' | 'interpreter' | 'ai' | 'database' | 'webhook.whatsapp' | 'webhook.email' | 'auth' | 'notifications' | 'integrity' | 'server';

export function recordSystemEvent(level: 'info' | 'warning' | 'error', component: Component, message: string, detail?: unknown) {
  try {
    db()
      .prepare('INSERT INTO system_events (id, level, component, message, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(id('se_'), level, component, message, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), now());
  } catch (err) {
    // Health logging must never throw into business logic.
    console.error('[health] failed to record event', err);
  }
  if (level === 'error') console.error(`[${component}] ${message}`, detail ?? '');
}

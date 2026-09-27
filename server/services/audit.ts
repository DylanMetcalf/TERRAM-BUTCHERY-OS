import { db, id, now } from '../db/db.js';

export interface Actor {
  userId: string | null;
  kind: 'user' | 'system' | 'customer';
  name?: string;
  ip?: string | null;
}

export const SYSTEM: Actor = { userId: null, kind: 'system', name: 'Terram OS' };
export const CUSTOMER: Actor = { userId: null, kind: 'customer', name: 'Customer' };

export function audit(actor: Actor, action: string, entityType: string, entityId: string | null, summary: string, data: unknown = {}) {
  db()
    .prepare('INSERT INTO audit_log (id, actor_user_id, actor_kind, action, entity_type, entity_id, summary, data, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id('au_'), actor.userId, actor.kind, action, entityType, entityId, summary, JSON.stringify(data ?? {}), actor.ip ?? null, now());
}

import { db, id, json, now } from '../db/db.js';
import { normalise } from '../../shared/text.js';
import { addAlias, getProduct, listProducts } from '../domain/products.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Improvement loop. A single correction never changes the dictionary.
 * Observed → Suggested (after N independent corrections) → Reviewed → Approved → Applied.
 */
export function recordAliasCorrection(phrase: string, productId: string, actor: Actor, context: Record<string, unknown> = {}) {
  const alias = normalise(phrase);
  const product = getProduct(productId);
  if (!alias || !product || alias.length > 60) return;
  if (product.aliases.some((a) => a.alias === alias)) return;
  // A phrase that already means another product is never suggested
  if (listProducts().some((p) => p.aliases.some((a) => a.alias === alias))) return;
  const key = `${alias}→${productId}`;
  db().prepare('INSERT INTO observations (id, kind, key, payload, user_id, created_at) VALUES (?,?,?,?,?,?)').run(id('ob_'), 'alias_correction', key, JSON.stringify({ phrase, alias, product_id: productId, ...context }), actor.userId, now());
  const count = (db().prepare("SELECT COUNT(*) c FROM observations WHERE kind = 'alias_correction' AND key = ?").get(key) as any).c;
  const threshold = getSettings().ai.learningThreshold;
  const existing = db().prepare('SELECT * FROM suggestions WHERE key = ?').get(`alias:${key}`) as any;
  if (existing) {
    db().prepare('UPDATE suggestions SET occurrences = ?, updated_at = ? WHERE id = ?').run(count, now(), existing.id);
    return;
  }
  if (count >= threshold) {
    db()
      .prepare("INSERT INTO suggestions (id, kind, key, title, detail, payload, occurrences, status, created_at, updated_at) VALUES (?, 'alias', ?, ?, ?, ?, ?, 'suggested', ?, ?)")
      .run(
        id('sg_'),
        `alias:${key}`,
        `Add “${phrase.trim()}” as another name for ${product.canonical_name}?`,
        `Staff have matched “${phrase.trim()}” to ${product.canonical_name} ${count} times. Approving means future messages using this phrase are understood automatically.`,
        JSON.stringify({ phrase: phrase.trim(), alias, product_id: productId, product_name: product.canonical_name }),
        count,
        now(),
        now(),
      );
    publish(['intelligence']);
  }
}

export function recordUnknownPhrase(phrase: string, context: Record<string, unknown> = {}) {
  const alias = normalise(phrase);
  if (!alias || alias.length > 60) return;
  db().prepare('INSERT INTO observations (id, kind, key, payload, created_at) VALUES (?,?,?,?,?)').run(id('ob_'), 'unknown_phrase', alias, JSON.stringify({ phrase, ...context }), now());
}

export function listSuggestions(status = 'suggested') {
  return (db().prepare('SELECT * FROM suggestions WHERE status = ? ORDER BY occurrences DESC, updated_at DESC').all(status) as any[]).map((s) => ({ ...s, payload: json(s.payload, {}) }));
}

export function decideSuggestion(suggestionId: string, decision: 'approved' | 'rejected', actor: Actor) {
  const s = db().prepare('SELECT * FROM suggestions WHERE id = ?').get(suggestionId) as any;
  if (!s) throw notFound('That suggestion');
  if (s.status !== 'suggested') throw badRequest('That suggestion has already been decided.');
  const payload = json<any>(s.payload, {});
  if (decision === 'approved' && s.kind === 'alias') addAlias(payload.product_id, payload.phrase, 'learned', actor);
  db().prepare('UPDATE suggestions SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(decision, actor.userId, now(), now(), suggestionId);
  audit(actor, `suggestion.${decision}`, 'suggestion', suggestionId, s.title, payload);
  publish(['intelligence', 'products']);
}

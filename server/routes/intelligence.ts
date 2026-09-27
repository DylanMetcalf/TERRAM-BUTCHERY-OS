import { Hono } from 'hono';
import { z } from 'zod';
import { db, json } from '../db/db.js';
import { can } from '../../shared/permissions.js';
import { analyseImport, commitBatch, editDraft, getBatch, listBatches, type DraftEdit } from '../intelligence/imports.js';
import { decideSuggestion } from '../intelligence/learning.js';
import { operationsIntelligence, systemHealth } from '../intelligence/insights.js';
import { listExceptions, openExceptionCount } from '../domain/exceptions.js';
import { actionsFor, resolveExceptionAction } from '../domain/exception-actions.js';
import { search } from '../domain/search.js';
import { actorOf, requireAuth, requirePerm, roleOf, type Env } from '../http/context.js';
import { body, QtySchema, PrepSchema } from '../http/schemas.js';
import { rateLimit } from '../http/security.js';

// ── Imports & message interpretation ───────────────────────
export const imports = new Hono<Env>();

imports.get('/', requirePerm('import.run'), (c) => c.json({ batches: listBatches(30) }));

imports.post('/', requirePerm('import.run'), rateLimit('import', 60, 60_000), async (c) => {
  const input = await body(
    c,
    z.object({
      text: z.string().min(1, 'Paste at least one message').max(200_000),
      source: z.enum(['import', 'whatsapp', 'email', 'phone', 'manual']).optional(),
      reference_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      customer: z.object({ id: z.string().max(64).optional(), name: z.string().max(120).optional(), phone: z.string().max(40).optional() }).nullable().optional(),
    }),
  );
  const id = await analyseImport({ text: input.text, source: input.source, refDate: input.reference_date, customer: input.customer ?? null }, actorOf(c));
  return c.json({ batch: getBatch(id) });
});

imports.get('/:id', requirePerm('import.run'), (c) => c.json({ batch: getBatch(c.req.param('id')) }));

const EditSchema = z.object({ action: z.string().max(40) }).passthrough();
imports.post('/:id/drafts/:draftId', requirePerm('import.run'), async (c) => {
  const edit = (await body(c, EditSchema)) as unknown as DraftEdit;
  if ('qty' in edit && edit.qty) QtySchema.parse(edit.qty);
  if ('preparation' in edit && edit.preparation) PrepSchema.parse(edit.preparation);
  return c.json({ batch: editDraft(c.req.param('id'), c.req.param('draftId'), edit, actorOf(c), roleOf(c)) });
});

imports.post('/:id/commit', requirePerm('import.run'), async (c) => {
  const input = await body(c, z.object({ send_rest_to_exceptions: z.boolean().default(true), draft_ids: z.array(z.string().max(64)).optional() }));
  const result = commitBatch(c.req.param('id'), { sendRestToExceptions: input.send_rest_to_exceptions, draftIds: input.draft_ids }, actorOf(c), roleOf(c));
  return c.json({ result, batch: getBatch(c.req.param('id')) });
});

// ── Exceptions ──────────────────────────────────────────────
export const exceptions = new Hono<Env>();

exceptions.get('/', requirePerm('orders.read'), (c) => {
  const status = c.req.query('status') ?? 'open';
  const list = listExceptions({ status, limit: 300 }).map((e) => ({ ...e, actions: e.status === 'open' ? actionsFor(e) : [] }));
  return c.json({ exceptions: list, counts: openExceptionCount() });
});

exceptions.post('/:id/actions', requirePerm('exceptions.resolve'), async (c) => {
  const input = await body(
    c,
    z.object({
      action: z.string().max(40),
      product_id: z.string().max(64).optional(),
      preparation: PrepSchema,
      qty: QtySchema.optional(),
      item_id: z.string().max(64).optional(),
      customer_id: z.string().max(64).optional(),
      name: z.string().max(120).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(500).optional(),
      remember: z.boolean().optional(),
    }),
  );
  return c.json(resolveExceptionAction(c.req.param('id'), input as any, actorOf(c), roleOf(c)));
});

// ── Operations Intelligence ─────────────────────────────────
export const intelligence = new Hono<Env>();

intelligence.get('/', requirePerm('intelligence.read'), (c) => c.json(operationsIntelligence()));

intelligence.post('/suggestions/:id', requirePerm('intelligence.approve'), async (c) => {
  const { decision } = await body(c, z.object({ decision: z.enum(['approved', 'rejected']) }));
  decideSuggestion(c.req.param('id'), decision, actorOf(c));
  return c.json({ ok: true });
});

intelligence.get('/interpretations', requirePerm('intelligence.read'), (c) => {
  const rows = (
    db()
      .prepare(
        `SELECT i.id, i.engine, i.model, i.engine_version, i.confidence, i.intent, i.resulting_action, i.latency_ms, i.error, i.created_at, i.raw_input, i.output,
                m.sender_name, m.order_id, o.order_number
         FROM interpretations i LEFT JOIN messages m ON m.id = i.message_id LEFT JOIN orders o ON o.id = m.order_id
         ORDER BY i.created_at DESC LIMIT 100`,
      )
      .all() as any[]
  ).map((r) => ({ ...r, output: json(r.output, null) }));
  return c.json({ interpretations: rows });
});

intelligence.get('/health', requirePerm('system.health'), (c) => c.json(systemHealth()));

// ── Search & notifications ─────────────────────────────────
export const misc = new Hono<Env>();

misc.get('/search', requireAuth(), (c) => {
  const res = search(c.req.query('q') ?? '');
  const role = roleOf(c);
  return c.json({ ...res, messages: can(role, 'orders.read') ? res.messages : [] });
});

misc.get('/notifications', requireAuth(), (c) => {
  const rows = db()
    .prepare("SELECT n.*, o.order_number FROM notifications n LEFT JOIN orders o ON o.id = n.order_id WHERE n.audience = 'staff' OR n.kind = 'reply_suggestion' ORDER BY n.created_at DESC LIMIT 30")
    .all();
  return c.json({ notifications: rows });
});

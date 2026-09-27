import { db, id, now, tx } from '../db/db.js';
import { normalise, normalisePhone } from '../../shared/text.js';
import type { OrderSource } from '../../shared/workflow.js';
import { localDate } from '../lib/time.js';
import { SYSTEM, type Actor } from '../services/audit.js';
import { recordSystemEvent } from '../services/health.js';
import { publish } from '../services/realtime.js';
import { businessTz } from '../services/settings.js';
import { raiseException } from '../domain/exceptions.js';
import { listProducts } from '../domain/products.js';
import { analyse } from './analyser.js';
import { commitDraft, type CommitResult } from './imports.js';
import { interpretAll } from './interpret.js';
import { buildDictionary } from './matcher.js';
import type { SplitMessage } from './splitter.js';
import { draftStatus, validateDraft, type Draft } from './drafts.js';

/**
 * Live channel entry point (WhatsApp Business webhook, inbound email, …).
 * Channel adapters normalise their payload into InboundMessage; everything
 * after this point is channel-agnostic and flows into the central engine.
 */
export interface InboundMessage {
  channel: 'whatsapp' | 'email' | 'sms';
  external_id: string | null;
  from_phone?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  body: string;
  sent_at?: string | null;
}

export interface InboundOutcome {
  duplicate: boolean;
  message_id: string | null;
  intent: string | null;
  action: string;
  order_id?: string | null;
  exceptions: number;
  /** A suggested reply. null = stay quiet (e.g. "Thanks!"). Nothing is sent automatically. */
  reply_suggestion: string | null;
}

/** Auto-apply clear amendments only while nobody has confirmed the order yet. */
const AUTO_APPLY_STATUSES = ['review', 'needs_clarification'];

export async function processInbound(msg: InboundMessage, actor: Actor = SYSTEM): Promise<InboundOutcome> {
  const body = (msg.body ?? '').toString().slice(0, 10_000);
  if (msg.external_id) {
    const existing = db().prepare('SELECT id, classification, order_id FROM messages WHERE channel = ? AND external_id = ?').get(msg.channel, msg.external_id) as any;
    if (existing) {
      recordSystemEvent('info', msg.channel === 'whatsapp' ? 'webhook.whatsapp' : 'webhook.email', 'Duplicate delivery ignored', { external_id: msg.external_id });
      return { duplicate: true, message_id: existing.id, intent: existing.classification, action: 'duplicate_ignored', order_id: existing.order_id, exceptions: 0, reply_suggestion: null };
    }
  }
  const phone = normalisePhone(msg.from_phone ?? null);
  const key = phone ?? (msg.from_email ? msg.from_email.toLowerCase() : normalise(msg.from_name ?? 'unknown'));
  const sentAt = msg.sent_at && !Number.isNaN(Date.parse(msg.sent_at)) ? new Date(msg.sent_at).toISOString() : now();
  const refDate = localDate(new Date(sentAt), businessTz());

  // Persist raw input first — it must survive even if interpretation fails
  const messageId = id('ms_');
  const convId = upsertConversation(msg.channel, key, sentAt);
  db()
    .prepare(
      `INSERT INTO messages (id, channel, external_id, conversation_id, direction, sender_name, sender_phone, body, sent_at, received_at, status, created_at)
       VALUES (?,?,?,?,'in',?,?,?,?,?,'pending',?)`,
    )
    .run(messageId, msg.channel, msg.external_id, convId, msg.from_name ?? null, phone, body, sentAt, now(), now());

  try {
    const dict = buildDictionary(listProducts());
    const split: SplitMessage = {
      index: 0,
      sender: msg.from_name ?? null,
      senderPhone: phone,
      text: body,
      sentAt,
      refDate,
      direction: 'in',
      line: 1,
    };
    const [interpreted] = await interpretAll([split], dict);
    if (msg.from_email && !interpreted.parsed.email) interpreted.parsed.email = msg.from_email.toLowerCase();
    // "also 2kg wors" shortly after an order → an addition to that order, not a second order
    if (interpreted.parsed.intent === 'new_order' && interpreted.parsed.flags.addition) {
      interpreted.parsed.intent = 'amendment';
      for (const it of interpreted.parsed.items) if (it.op === 'none') it.op = 'add';
    }
    const { drafts } = analyse([interpreted], dict, localDate(new Date(), businessTz()));
    const draft = validateDraft(drafts[0] as Draft, { today: localDate(new Date(), businessTz()), previousDrafts: [] });
    (draft.messages[0] as any).message_id = messageId;
    for (const r of interpreted.records) {
      db()
        .prepare(
          `INSERT INTO interpretations (id, message_id, engine, model, engine_version, raw_input, output, confidence, intent, resulting_action, latency_ms, error, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id('in_'), messageId, r.engine, r.model, r.version, body, JSON.stringify(r.output ?? null), draft.confidence, interpreted.parsed.intent, `live:${draft.kind}`, r.latencyMs, r.error ?? null, now());
    }
    db().prepare('UPDATE messages SET classification = ?, customer_id = ? WHERE id = ?').run(interpreted.parsed.intent, draft.customer.customer_id, messageId);

    const result: CommitResult = { created: [], amended: [], exceptions: 0, skipped: 0, failed: [] };
    const autoApply = draft.kind === 'amendment' && !!draft.target && AUTO_APPLY_STATUSES.includes(draft.target.status) && draftStatus(draft) === 'ready' && draft.confidence === 'high';
    const outcome = tx(() =>
      commitDraft(null, { data: draft as any, position: 0 }, actor, null, result, { readyStatus: 'review', source: msg.channel as OrderSource, autoApplyAmendments: autoApply }),
    );
    if (draft.customer.customer_id) db().prepare('UPDATE conversations SET customer_id = ? WHERE id = ?').run(draft.customer.customer_id, convId);
    else if (outcome.orderId) {
      const o = db().prepare('SELECT customer_id FROM orders WHERE id = ?').get(outcome.orderId) as any;
      if (o) db().prepare('UPDATE conversations SET customer_id = ? WHERE id = ?').run(o.customer_id, convId);
    }
    publish(['orders', 'exceptions']);
    const reply = replyFor(draft, result, outcome.summary);
    if (reply) queueReply(msg.channel, reply, outcome.orderId ?? null, draft.customer.customer_id);
    return { duplicate: false, message_id: messageId, intent: interpreted.parsed.intent, action: outcome.summary, order_id: outcome.orderId ?? null, exceptions: result.exceptions, reply_suggestion: reply };
  } catch (err: any) {
    recordSystemEvent('error', 'interpreter', 'A live message could not be processed', err?.stack ?? String(err));
    db().prepare("UPDATE messages SET status = 'exception' WHERE id = ?").run(messageId);
    raiseException({
      type: 'ai_failure',
      severity: 'warning',
      title: `A ${msg.channel} message could not be read automatically`,
      detail: body.slice(0, 500),
      message_id: messageId,
      payload: { message_text: body, sender: msg.from_name ?? phone },
    });
    return { duplicate: false, message_id: messageId, intent: null, action: 'sent_to_exceptions', exceptions: 1, reply_suggestion: null };
  }
}

function upsertConversation(channel: string, key: string, at: string): string {
  const row = db().prepare('SELECT id FROM conversations WHERE channel = ? AND key = ?').get(channel, key) as any;
  if (row) {
    db().prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(at, row.id);
    return row.id;
  }
  const cid = id('cv_');
  db().prepare('INSERT INTO conversations (id, channel, key, last_message_at, created_at) VALUES (?,?,?,?,?)').run(cid, channel, key, at, now());
  return cid;
}

/** Useful automation, not a chatbot: most messages get no reply at all. */
export function replyFor(d: Draft, result: CommitResult, summary: string): string | null {
  const name = (d.customer.customer_name ?? d.customer.name ?? '').split(' ')[0];
  const hi = name ? `Thanks ${name}` : 'Thanks';
  if (d.kind === 'ignored') return null;
  if (d.kind === 'order') {
    if (result.exceptions) return `${hi} — we've got your order and will confirm it shortly.`;
    return `${hi} — we've received your order and will confirm it shortly.`;
  }
  if (d.kind === 'amendment') {
    if (summary === 'Amendment applied') return `Got it${name ? `, ${name}` : ''} — your order has been updated.`;
    if (d.reference) return `Sorry${name ? ` ${name}` : ''}, which item should we change?`;
    return null; // a person will confirm, then reply
  }
  return null;
}

function queueReply(channel: string, body: string, orderId: string | null, customerId: string | null) {
  db()
    .prepare("INSERT INTO notifications (id, channel, audience, kind, title, body, order_id, customer_id, status, created_at) VALUES (?, ?, 'customer', 'reply_suggestion', 'Suggested reply', ?, ?, ?, 'queued', ?)")
    .run(id('no_'), channel, body, orderId, customerId, now());
}

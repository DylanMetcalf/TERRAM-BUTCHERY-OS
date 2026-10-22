import { db, id, now } from '../db/db.js';
import { emailConfigured, explainEmailError, sendEmail } from './email.js';
import { recordSystemEvent } from './health.js';
import { publish } from './realtime.js';

/**
 * CENTRAL NOTIFICATION SERVICE (transactional outbox).
 *
 * Code never sends a customer or staff email directly: it calls `notify()`, which records the
 * message in the `notifications` table inside the same flow as the change that caused it. A worker
 * then delivers it. This means:
 *  - an email problem never loses an order or payment (the record is already saved);
 *  - each message has an event key, so a double-click, retry or repeated webhook can't send it twice;
 *  - failures are retried with back-off, and what finally failed is visible to staff;
 *  - a message is only marked "sent" once the mail server has accepted it.
 *
 * Channels: email today. WhatsApp and SMS plug in as further channels (see CHANNELS) once a
 * provider and approved templates exist; until then they are never pretended to have been sent.
 */

export type Audience = 'customer' | 'staff';
export type Category = 'transactional' | 'marketing' | 'internal';
export type Channel = 'email' | 'whatsapp' | 'sms';

export interface NotifyInput {
  /** Unique per real-world event, e.g. `order_confirmed:<orderId>`. A second call with the same key does nothing. */
  key: string;
  kind: string;
  audience: Audience;
  category?: Category;
  channel?: Channel;
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string | null;
  orderId?: string | null;
  customerId?: string | null;
}

const BACKOFF_MIN = [1, 5, 30, 120, 360];
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

/** Channel adapters. Only channels with a working adapter are ever attempted. */
const CHANNELS: Record<Channel, { ready: () => boolean; reason: string }> = {
  email: { ready: () => emailConfigured(), reason: 'Email isn’t set up on the server (SMTP settings missing).' },
  whatsapp: { ready: () => false, reason: 'WhatsApp Business messaging isn’t connected yet.' },
  sms: { ready: () => false, reason: 'SMS isn’t connected yet.' },
};

export function notify(input: NotifyInput): { id: string; created: boolean } {
  const seenTo = new Set<string>();
  const to = input.to.map((x) => x.trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && !seenTo.has(x.toLowerCase()) && seenTo.add(x.toLowerCase()));
  const existing = db().prepare('SELECT id FROM notifications WHERE event_key = ?').get(input.key) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };
  const channel = input.channel ?? 'email';
  const category = input.category ?? (input.audience === 'staff' ? 'internal' : 'transactional');
  let status: 'queued' | 'skipped' = 'queued';
  let error: string | null = null;
  if (!to.length) {
    status = 'skipped';
    error = 'No email address to send to.';
  } else if (category === 'marketing' && input.customerId) {
    const c = db().prepare('SELECT marketing_consent FROM customers WHERE id = ?').get(input.customerId) as { marketing_consent: number } | undefined;
    if (!c?.marketing_consent) {
      status = 'skipped';
      error = 'The customer has not agreed to reminders.';
    }
  }
  const nid = id('no_');
  const ts = now();
  try {
    db()
      .prepare(
        `INSERT INTO notifications (id, channel, audience, kind, title, body, html, subject, recipient, reply_to, order_id, customer_id, status, error, event_key, category, attempts, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      )
      .run(nid, channel, input.audience, input.kind, input.subject, input.text, input.html, input.subject, to.join(', ') || null, input.replyTo ?? null, input.orderId ?? null, input.customerId ?? null, status, error, input.key, category, ts, ts);
  } catch (e: any) {
    // Two requests racing on the same event: the unique key lets exactly one through
    if (/UNIQUE/i.test(String(e?.message))) {
      const row = db().prepare('SELECT id FROM notifications WHERE event_key = ?').get(input.key) as { id: string };
      return { id: row.id, created: false };
    }
    throw e;
  }
  if (status === 'queued') kick();
  return { id: nid, created: true };
}

let running = false;
let again = false;

/** Delivers whatever is due. Safe to call often; only one run happens at a time. */
export async function processOutbox(limit = 25): Promise<{ sent: number; failed: number }> {
  if (running) {
    again = true;
    return { sent: 0, failed: 0 };
  }
  running = true;
  let sent = 0;
  let failed = 0;
  try {
    const ts = now();
    const due = db()
      .prepare("SELECT * FROM notifications WHERE status = 'queued' AND channel != 'in_app' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?")
      .all(ts, limit) as any[];
    for (const n of due) {
      // Claim the row so a parallel run can't send it too
      const claim = db().prepare("UPDATE notifications SET next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)").run(new Date(Date.now() + 10 * 60_000).toISOString(), now(), n.id, ts);
      if (claim.changes !== 1) continue;
      const ch = CHANNELS[n.channel as Channel];
      if (!ch || !ch.ready()) {
        db().prepare("UPDATE notifications SET status = 'skipped', error = ?, updated_at = ? WHERE id = ?").run(ch?.reason ?? 'Unknown channel.', now(), n.id);
        failed++;
        continue;
      }
      try {
        const providerId = await sendEmail({ to: String(n.recipient).split(',').map((x: string) => x.trim()), subject: n.subject ?? n.title, text: n.body ?? '', html: n.html ?? '', replyTo: n.reply_to });
        db().prepare("UPDATE notifications SET status = 'sent', sent_at = ?, provider_id = ?, attempts = attempts + 1, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(now(), providerId, now(), n.id);
        sent++;
      } catch (e) {
        const attempts = n.attempts + 1;
        const msg = explainEmailError(e);
        if (attempts >= MAX_ATTEMPTS) {
          db().prepare("UPDATE notifications SET status = 'failed', attempts = ?, error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(attempts, msg, now(), n.id);
          recordSystemEvent('error', 'notifications', `Gave up sending “${n.subject ?? n.title}” to ${n.recipient}`, msg);
        } else {
          const next = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000).toISOString();
          db().prepare('UPDATE notifications SET attempts = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?').run(attempts, msg, next, now(), n.id);
        }
        failed++;
      }
    }
  } finally {
    running = false;
  }
  if (sent || failed) publish(['notifications']);
  if (again) {
    again = false;
    void processOutbox(limit);
  }
  return { sent, failed };
}

function kick() {
  if (process.env.TERRAM_OUTBOX === 'manual') return;
  setImmediate(() => {
    processOutbox().catch((e) => recordSystemEvent('error', 'notifications', 'Outbox run failed', String(e?.stack ?? e)));
  });
}

/** Staff "Try again" on a message that failed or was skipped. Re-uses the same row, so it can't double up. */
export function retryNotification(nid: string): boolean {
  const r = db().prepare("UPDATE notifications SET status = 'queued', next_attempt_at = NULL, error = NULL, attempts = 0, updated_at = ? WHERE id = ? AND status IN ('failed','skipped') AND channel != 'in_app'").run(now(), nid);
  if (r.changes) kick();
  return r.changes > 0;
}

/** Messages someone should look at: gave up, or couldn't be sent to an address we have (not "no email given" or "no consent"). */
const PROBLEM = "(n.status = 'failed' OR (n.status = 'skipped' AND n.recipient IS NOT NULL AND n.category != 'marketing'))";

export function listNotifications(opts: { status?: string | null; orderId?: string | null; limit?: number } = {}) {
  return db()
    .prepare(
      `SELECT n.id, n.channel, n.audience, n.kind, n.category, n.subject, n.title, n.recipient, n.status, n.error, n.attempts, n.next_attempt_at, n.provider_id,
              n.sent_at, n.created_at, n.order_id, o.order_number
       FROM notifications n LEFT JOIN orders o ON o.id = n.order_id
       WHERE n.channel != 'in_app' AND (? IS NULL OR n.status = ? OR (? = 'problems' AND ${PROBLEM})) AND (? IS NULL OR n.order_id = ?)
       ORDER BY n.created_at DESC LIMIT ?`,
    )
    .all(opts.status ?? null, opts.status ?? null, opts.status ?? null, opts.orderId ?? null, opts.orderId ?? null, opts.limit ?? 200);
}

export function notificationProblemCount(): number {
  return (db().prepare(`SELECT COUNT(*) n FROM notifications n WHERE n.channel != 'in_app' AND ${PROBLEM} AND n.created_at >= ?`).get(new Date(Date.now() - 14 * 86400_000).toISOString()) as { n: number }).n;
}

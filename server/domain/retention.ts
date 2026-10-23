import { db } from '../db/db.js';
import { getSettings } from '../services/settings.js';
import { notify } from '../services/notify.js';
import { orderUrl, unsubscribeUrl } from '../services/links.js';
import { layout } from '../services/templates.js';
import { customerContact } from './lifecycle.js';

/**
 * REORDER REMINDERS (marketing). Sent once per completed order, about N days after completion,
 * only to customers who said yes to reminders, and not if they've ordered again since. Each email
 * has an unsubscribe link. The link opens the order page, where "Reorder" makes a draft basket the
 * customer reviews and sends themselves — nothing is ever ordered or charged automatically.
 */
export function runReorderReminders(at = new Date()): { sent: number } {
  const s = getSettings();
  if (!s.retention.remindersEnabled) return { sent: 0 };
  const cutoff = new Date(at.getTime() - s.retention.reminderDays * 86400_000).toISOString();
  const oldest = new Date(at.getTime() - (s.retention.reminderDays + 30) * 86400_000).toISOString();
  const due = db()
    .prepare(
      `SELECT o.id, o.order_number, o.customer_id, o.completed_at FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status = 'completed' AND o.completed_at <= ? AND o.completed_at >= ? AND c.marketing_consent = 1
         AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_key = 'reorder_reminder:' || o.id)
         AND NOT EXISTS (SELECT 1 FROM orders o2 WHERE o2.customer_id = o.customer_id AND o2.id != o.id AND o2.created_at > o.completed_at AND o2.status != 'cancelled')
         AND NOT EXISTS (SELECT 1 FROM orders o3 WHERE o3.customer_id = o.customer_id AND o3.id != o.id AND o3.status = 'completed' AND o3.completed_at > o.completed_at)
       ORDER BY o.completed_at LIMIT 50`,
    )
    .all(cutoff, oldest) as { id: string; order_number: number; customer_id: string }[];
  let sent = 0;
  for (const o of due) {
    const c = customerContact(o.id);
    if (!c.email) continue;
    const e = layout({
      subject: `Ready to stock up again? Your ${s.business.name} favourites are easy to reorder.`,
      preheader: 'Reorder your previous favourites in a few taps.',
      greeting: `Hi ${c.firstName},`,
      intro: [`We hope you're enjoying your recent ${s.business.name} order.`, "When you're ready to stock up again, you can quickly reorder your previous favourites."],
      cta: { label: 'Reorder my previous order', url: orderUrl(o.id, '?reorder=1') },
      closing: ["You'll be able to review your products, quantities, current prices and availability before confirming your new order.", `Thank you for supporting ${s.business.name}.`, `The ${s.business.name} Team`],
      footer: { text: 'Don’t want these reminders? Unsubscribe', url: unsubscribeUrl(o.customer_id) },
    });
    const r = notify({ key: `reorder_reminder:${o.id}`, kind: 'reorder_reminder', audience: 'customer', category: 'marketing', to: [c.email], ...e, replyTo: s.business.email || null, orderId: o.id, customerId: o.customer_id });
    if (r.created) sent++;
  }
  return { sent };
}

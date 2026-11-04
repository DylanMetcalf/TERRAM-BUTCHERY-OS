import { db, json, now, tx } from '../db/db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { notify } from '../services/notify.js';
import { orderUrl } from '../services/links.js';
import { layout, signOff } from '../services/templates.js';
import { addEvent, requireOrder, type InvoiceRequestDetails, type InvoiceStatus } from './orders.js';
import { customerContact } from './lifecycle.js';

/**
 * MANUAL INVOICE REQUESTS. Terram prepares invoices in its own accounting system (e.g. Xero).
 * This only tracks the customer's request and what staff have done with it. Marking a request
 * "issued" records that a person issued an invoice elsewhere; the app never creates one itself.
 */

export const INVOICE_LABEL: Record<InvoiceStatus, string> = {
  not_requested: 'Not requested',
  requested: 'Requested',
  in_progress: 'Being prepared',
  issued: 'Issued',
  sent: 'Sent to customer',
  cancelled: 'Cancelled',
};

const NEXT: Record<InvoiceStatus, InvoiceStatus[]> = {
  not_requested: ['requested'],
  requested: ['in_progress', 'issued', 'cancelled'],
  in_progress: ['issued', 'requested', 'cancelled'],
  issued: ['sent', 'in_progress'],
  sent: ['issued'],
  cancelled: ['requested'],
};

export function billingComplete(d: InvoiceRequestDetails | null): boolean {
  return !!(d && d.billing_name?.trim() && d.billing_email?.trim());
}

export function listInvoiceRequests(filter: 'outstanding' | 'done' | 'all' = 'outstanding') {
  const where =
    filter === 'outstanding' ? "o.invoice_status IN ('requested','in_progress')" : filter === 'done' ? "o.invoice_status IN ('issued','sent','cancelled')" : "o.invoice_status != 'not_requested'";
  const rows = db()
    .prepare(
      `SELECT o.id, o.order_number, o.status, o.invoice_status, o.invoice_details, o.invoice_requested_at, o.invoice_ref, o.invoice_issued_on, o.invoice_sent_at, o.invoice_file_id,
         o.final_total_cents, o.estimated_total_cents, o.payment_state, c.name AS customer_name, u.name AS assignee_name, o.invoice_assignee
       FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.invoice_assignee
       WHERE ${where} ORDER BY o.invoice_requested_at DESC LIMIT 300`,
    )
    .all() as any[];
  return rows.map((r) => {
    const d = json<InvoiceRequestDetails | null>(r.invoice_details, null);
    return { ...r, invoice_details: d, billing_complete: billingComplete(d), status_label: INVOICE_LABEL[r.invoice_status as InvoiceStatus] };
  });
}

export interface InvoiceUpdate {
  status?: InvoiceStatus;
  reference?: string | null;
  issued_on?: string | null;
  assignee?: string | null;
  details?: InvoiceRequestDetails | null;
  file_id?: string | null;
  notify_customer?: boolean;
}

/** Staff update an invoice request. Each step is recorded; issued needs the reference and date from the accounting system. */
export function updateInvoiceRequest(orderId: string, u: InvoiceUpdate, actor: Actor) {
  const o = requireOrder(orderId);
  const current = o.invoice_status;
  const f: Record<string, unknown> = {};
  const changes: string[] = [];
  if (u.details !== undefined) {
    if (u.details && !billingComplete(u.details)) throw badRequest('The invoice needs a billing name and email.');
    f.invoice_details = u.details ? JSON.stringify(u.details) : null;
    changes.push('billing details updated');
  }
  if (u.reference !== undefined) f.invoice_ref = u.reference?.trim().slice(0, 80) || null;
  if (u.issued_on !== undefined) {
    if (u.issued_on && !/^\d{4}-\d{2}-\d{2}$/.test(u.issued_on)) throw badRequest('Enter the date the invoice was issued.');
    f.invoice_issued_on = u.issued_on || null;
  }
  if (u.assignee !== undefined) f.invoice_assignee = u.assignee || null;
  if (u.file_id !== undefined) f.invoice_file_id = u.file_id;
  let to: InvoiceStatus | null = null;
  if (u.status && u.status !== current) {
    if (!NEXT[current].includes(u.status)) throw conflict(`An invoice request that is “${INVOICE_LABEL[current].toLowerCase()}” can’t be marked “${INVOICE_LABEL[u.status].toLowerCase()}”.`);
    to = u.status;
    f.invoice_status = to;
    if (to === 'requested' && !o.invoice_requested_at) f.invoice_requested_at = now();
    if (to === 'issued' && !((f.invoice_issued_on as string | null | undefined) ?? o.invoice_issued_on)) f.invoice_issued_on = new Date().toISOString().slice(0, 10);
    if (to === 'sent') f.invoice_sent_at = now();
    changes.unshift(`${INVOICE_LABEL[current]} → ${INVOICE_LABEL[to]}`);
  }
  if (!Object.keys(f).length) return o;
  tx(() => {
    db().prepare(`UPDATE orders SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(f), now(), orderId);
    const type = to === 'issued' ? 'invoice_issued' : to === 'sent' ? 'invoice_sent' : 'invoice_updated';
    addEvent(orderId, type, `Invoice: ${changes.join(' · ') || 'details updated'}${f.invoice_ref ? ` · ref ${f.invoice_ref}` : ''}`, actor, { from: current, to, reference: f.invoice_ref ?? null });
    audit(actor, 'invoice.updated', 'order', orderId, `#${o.order_number} invoice: ${changes.join(', ') || 'updated'}`);
  });
  // The customer is only emailed when staff choose to notify them (never just because a file was saved)
  if (to && ['issued', 'sent'].includes(to) && u.notify_customer === true) {
    const after = requireOrder(orderId);
    const d = json<InvoiceRequestDetails | null>((db().prepare('SELECT invoice_details, invoice_file_id FROM orders WHERE id = ?').get(orderId) as any).invoice_details, null);
    const hasFile = !!(db().prepare('SELECT invoice_file_id FROM orders WHERE id = ?').get(orderId) as any).invoice_file_id;
    const c = customerContact(orderId);
    const to2 = [d?.billing_email, c.email].filter(Boolean) as string[];
    if (to2.length) {
      const e = layout({
        subject: `Your invoice for order #${o.order_number}`,
        preheader: after.invoice_ref ? `Invoice ${after.invoice_ref}` : 'Your invoice is ready.',
        greeting: `Hi ${(d?.billing_name ?? c.firstName).split(' ')[0]},`,
        intro: [`Your invoice for order #${o.order_number} is ready${after.invoice_ref ? ` (invoice ${after.invoice_ref})` : ''}.`, hasFile ? 'You can download it from your order page.' : 'We’ve sent it to you separately; you can also ask us for a copy.'],
        cta: { label: hasFile ? 'Download my invoice' : 'View my order', url: orderUrl(orderId, hasFile ? '#invoice' : '') },
        closing: signOff(),
      });
      notify({ key: `invoice_ready:${orderId}:${to}`, kind: 'invoice_ready', audience: 'customer', to: [...new Set(to2)], ...e, orderId, customerId: c.customerId });
    }
  }
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

/** Staff add an invoice request on the customer's behalf (e.g. asked by phone). */
export function requestInvoice(orderId: string, details: InvoiceRequestDetails, actor: Actor) {
  const o = requireOrder(orderId);
  if (!billingComplete(details)) throw badRequest('The invoice needs a billing name and email.');
  if (['requested', 'in_progress', 'issued', 'sent'].includes(o.invoice_status)) throw conflict('An invoice has already been requested for this order.');
  db().prepare("UPDATE orders SET invoice_status = 'requested', invoice_details = ?, invoice_requested_at = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(details), now(), now(), orderId);
  addEvent(orderId, 'invoice_requested', `Invoice requested for ${details.billing_name}`, actor);
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

// ── Invoice file: upload / replace / remove / notify ─────────

export function invoiceFileInfo(orderId: string) {
  return (db()
    .prepare('SELECT f.id, f.filename, f.mime, f.size, f.created_at, f.uploaded_by_kind, u.name AS uploaded_by_name FROM orders o JOIN files f ON f.id = o.invoice_file_id LEFT JOIN users u ON u.id = f.uploaded_by WHERE o.id = ?')
    .get(orderId) as any) ?? null;
}

/**
 * Saves an uploaded invoice on the order (replacing any earlier one, which stays in the file store
 * for the record). The invoice becomes available on the customer's order and payment pages.
 * `notify` emails the customer; otherwise nothing is sent.
 */
export function attachInvoiceFile(orderId: string, file: { id: string; filename: string }, actor: Actor, opts: { reference?: string | null; issued_on?: string | null; notify: boolean }) {
  const o = requireOrder(orderId);
  if (opts.issued_on && !/^\d{4}-\d{2}-\d{2}$/.test(opts.issued_on)) throw badRequest('Enter the invoice date.');
  const previous = invoiceFileInfo(orderId);
  tx(() => {
    const status: InvoiceStatus = o.invoice_status === 'sent' ? 'sent' : 'issued';
    db()
      .prepare('UPDATE orders SET invoice_file_id = ?, invoice_status = ?, invoice_ref = COALESCE(?, invoice_ref), invoice_issued_on = COALESCE(?, invoice_issued_on, ?), invoice_requested_at = COALESCE(invoice_requested_at, ?), updated_at = ? WHERE id = ?')
      .run(file.id, status, opts.reference?.trim().slice(0, 80) || null, opts.issued_on || null, new Date().toISOString().slice(0, 10), now(), now(), orderId);
    addEvent(orderId, 'invoice_uploaded', `${previous ? `Invoice replaced (was ${previous.filename})` : 'Invoice uploaded'}: ${file.filename}${opts.reference ? ` · ref ${opts.reference}` : ''}`, actor, { file_id: file.id, replaced: previous?.id ?? null });
    audit(actor, 'invoice.uploaded', 'order', orderId, `#${o.order_number}: invoice ${previous ? 'replaced' : 'uploaded'} (${file.filename})`);
  });
  if (opts.notify) sendInvoiceNotification(orderId, actor);
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

export function removeInvoiceFile(orderId: string, reason: string, actor: Actor) {
  const o = requireOrder(orderId);
  const f = invoiceFileInfo(orderId);
  if (!f) throw badRequest('There is no invoice file on this order.');
  tx(() => {
    db().prepare("UPDATE orders SET invoice_file_id = NULL, invoice_status = CASE WHEN invoice_details IS NOT NULL THEN 'in_progress' ELSE 'not_requested' END, updated_at = ? WHERE id = ?").run(now(), orderId);
    addEvent(orderId, 'invoice_removed', `Invoice file removed: ${f.filename}${reason.trim() ? ` · ${reason.trim().slice(0, 200)}` : ''}`, actor, { file_id: f.id });
    audit(actor, 'invoice.removed', 'order', orderId, `#${o.order_number}: invoice file ${f.filename} removed`);
  });
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

/** "Your invoice is ready" — sent only when staff choose to; can be sent again any time. */
export function sendInvoiceNotification(orderId: string, actor: Actor) {
  const o = requireOrder(orderId);
  const f = invoiceFileInfo(orderId);
  if (!f) throw badRequest('Upload the invoice first.');
  const d = json<InvoiceRequestDetails | null>((db().prepare('SELECT invoice_details FROM orders WHERE id = ?').get(orderId) as any)?.invoice_details, null);
  const c = customerContact(orderId);
  const to = [...new Set([d?.billing_email, c.email].filter(Boolean).map((x) => x!.toLowerCase()))];
  if (!to.length) throw badRequest('This order has no email address to send the invoice to.');
  const n = (db().prepare("SELECT COUNT(*) n FROM notifications WHERE order_id = ? AND kind = 'invoice_ready'").get(orderId) as { n: number }).n;
  const e = invoiceEmail(orderId);
  notify({ key: `invoice_ready:${orderId}:${f.id}:${n}`, kind: 'invoice_ready', audience: 'customer', to, ...e, orderId, customerId: c.customerId });
  db().prepare("UPDATE orders SET invoice_status = 'sent', invoice_sent_at = ? WHERE id = ?").run(now(), orderId);
  addEvent(orderId, 'invoice_sent', `Invoice notification ${n ? 'sent again' : 'sent'} to ${to.join(', ')}`, actor, { file_id: f.id, resend: n });
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

export function invoiceEmailRecipients(orderId: string): string[] {
  const d = json<InvoiceRequestDetails | null>((db().prepare('SELECT invoice_details FROM orders WHERE id = ?').get(orderId) as any)?.invoice_details, null);
  const c = customerContact(orderId);
  return [...new Set([d?.billing_email, c.email].filter(Boolean).map((x) => x!.toLowerCase()))];
}

export function invoiceEmail(orderId: string) {
  const o = requireOrder(orderId);
  const d = json<InvoiceRequestDetails | null>((db().prepare('SELECT invoice_details FROM orders WHERE id = ?').get(orderId) as any)?.invoice_details, null);
  const c = customerContact(orderId);
  return layout({
    subject: `Your invoice for order #${o.order_number}`,
    preheader: o.invoice_ref ? `Invoice ${o.invoice_ref}` : 'Your invoice is ready to download.',
    greeting: `Hi ${(d?.billing_name ?? c.firstName).split(' ')[0]},`,
    intro: [`Your invoice for order #${o.order_number} is ready${o.invoice_ref ? ` (invoice ${o.invoice_ref})` : ''}. You can view and download it securely from your order page.`],
    cta: { label: 'View my invoice', url: orderUrl(orderId, '#invoice') },
    closing: signOff(),
  });
}

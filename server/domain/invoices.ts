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
    if (to === 'issued') {
      const ref = (f.invoice_ref as string | null | undefined) ?? o.invoice_ref;
      const date = (f.invoice_issued_on as string | null | undefined) ?? o.invoice_issued_on;
      if (!ref || !date) throw badRequest('To mark it issued, enter the invoice number and the date it was issued in your accounting system.');
    }
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
  // The customer hears once the invoice is actually ready (issued or sent)
  if (to && ['issued', 'sent'].includes(to) && (u.notify_customer ?? getSettings().notifications.invoiceReadyEmail)) {
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

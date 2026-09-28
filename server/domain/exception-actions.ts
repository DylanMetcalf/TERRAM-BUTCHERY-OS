import { db, now } from '../db/db.js';
import { can, type Role } from '../../shared/permissions.js';
import { formatQty, type Qty } from '../../shared/quantity.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { applyChanges } from '../intelligence/imports.js';
import { recordAliasCorrection } from '../intelligence/learning.js';
import { closeException, getException, type ExceptionRow } from './exceptions.js';
import { addEvent, addItem, getItem, releaseIfClear, requireOrder, transition, updateItem, updateOrder } from './orders.js';
import { requireCustomer } from './customers.js';

/**
 * Decisions a person can take on an exception. Every action goes through the
 * central order engine, so it is validated and audited like any other change.
 */
export interface ActionDef {
  key: string;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
  needs?: string; // what extra input the UI must collect
}

export function actionsFor(e: ExceptionRow): ActionDef[] {
  const dismiss: ActionDef = { key: 'dismiss', label: 'Dismiss', tone: 'neutral' };
  const ask: ActionDef = { key: 'ask_customer', label: 'Ask customer', tone: 'neutral' };
  switch (e.type) {
    case 'unknown_product':
      return [{ key: 'map_product', label: 'Choose product', tone: 'primary', needs: 'product' }, ask, { key: 'remove_line', label: 'Leave it out', tone: 'danger' }];
    case 'missing_quantity':
      return [{ key: 'set_quantity', label: 'Set quantity', tone: 'primary', needs: 'qty' }, ask, { key: 'remove_line', label: 'Leave it out', tone: 'danger' }];
    case 'ambiguous_reference':
      return [{ key: 'choose_reference', label: 'Choose', tone: 'primary', needs: e.payload?.options?.length ? 'item' : 'product' }, ask, { key: 'remove_line', label: 'Ignore', tone: 'neutral' }];
    case 'possible_amendment':
      return [{ key: 'apply_amendment', label: 'Confirm change', tone: 'primary' }, { key: 'keep_existing', label: 'Keep existing', tone: 'neutral' }, ask];
    case 'contradiction':
      return [{ key: 'use_later', label: 'Use the later amount', tone: 'primary' }, { key: 'keep_existing', label: 'Keep the first', tone: 'neutral' }, { key: 'add_both', label: 'Add both', tone: 'neutral' }, ask];
    case 'possible_duplicate':
      return [{ key: 'not_duplicate', label: 'Not a duplicate', tone: 'primary' }, { key: 'cancel_duplicate', label: 'Cancel this order', tone: 'danger' }];
    case 'cancellation_request':
      return [{ key: 'confirm_cancel', label: 'Cancel the order', tone: 'danger' }, { key: 'keep_order', label: 'Keep the order', tone: 'neutral' }, ask];
    case 'ambiguous_customer':
      return [{ key: 'choose_customer', label: 'Choose customer', tone: 'primary', needs: 'customer' }, { key: 'keep_new_customer', label: 'It’s a new customer', tone: 'neutral', needs: 'name' }];
    case 'unclear_date':
      return [{ key: 'set_date', label: 'Set date', tone: 'primary', needs: 'date' }, ask, dismiss];
    case 'customer_question':
      return [{ key: 'mark_answered', label: 'Mark answered', tone: 'primary' }, dismiss];
    case 'special_request':
      return [{ key: 'mark_handled', label: 'Agreed with customer', tone: 'primary' }, ask, dismiss];
    case 'unmatched_message':
    case 'amendment_no_order':
      return [{ key: 'mark_handled', label: 'Handled', tone: 'primary' }, dismiss];
    default:
      return [{ key: 'mark_handled', label: 'Mark resolved', tone: 'primary' }, dismiss];
  }
}

export interface ActionInput {
  action: string;
  product_id?: string;
  preparation?: Record<string, string>;
  qty?: Qty;
  item_id?: string;
  customer_id?: string;
  name?: string;
  date?: string;
  note?: string;
  remember?: boolean;
}

export function resolveExceptionAction(exceptionId: string, input: ActionInput, actor: Actor, role: Role | null) {
  const e = getException(exceptionId);
  if (!e) throw notFound('That exception');
  if (e.status !== 'open') throw conflict('This has already been dealt with.');
  const p = e.payload ?? {};
  const ctx = { messageId: e.message_id, reason: 'Resolved from exceptions' };
  const orderId = e.order_id;
  const needOrder = () => {
    if (!orderId) throw badRequest('This exception is not linked to an order.');
    return orderId;
  };
  let resolution = input.action;
  let status: 'resolved' | 'dismissed' = 'resolved';
  let summary = '';

  switch (input.action) {
    case 'dismiss':
      status = 'dismissed';
      summary = 'Dismissed';
      break;
    case 'ask_customer': {
      // Stays open — flagged as waiting on the customer
      db().prepare('UPDATE exceptions SET payload = ? WHERE id = ?').run(JSON.stringify({ ...p, waiting_on_customer: now(), question: input.note ?? null }), exceptionId);
      if (orderId) addEvent(orderId, 'note', `Waiting on customer: ${e.title}${input.note ? ` — “${input.note}”` : ''}`, actor);
      audit(actor, 'exception.ask_customer', 'exception', exceptionId, e.title);
      publish(['exceptions', 'orders']);
      return { status: 'open', waiting: true };
    }
    case 'map_product':
    case 'choose_reference':
    case 'set_quantity': {
      const oid = needOrder();
      if (input.action === 'choose_reference' && input.item_id) {
        // Amend an existing line on the order
        const it = getItem(input.item_id);
        if (it.order_id !== oid) throw badRequest('That item is on a different order.');
        const qty = input.qty ?? (p.qty as Qty | null);
        if (!qty) throw badRequest('Choose a quantity.');
        updateItem(it.id, { qty }, actor, ctx);
        summary = `${it.product_name} set to ${formatQty(qty, it.piece_noun)}`;
        break;
      }
      const productId = input.product_id ?? p.product_id;
      if (!productId) throw badRequest('Choose a product.');
      const qty = input.qty ?? (p.qty as Qty | null);
      if (!qty) throw badRequest('Enter a quantity.');
      const item = addItem(oid, { product_id: productId, qty, preparation: input.preparation ?? p.preparation ?? {}, special_instructions: p.special_instructions ?? null, source_text: p.source_text ?? null }, actor, ctx);
      summary = `Added ${item.product_name} — ${item.qty_label}`;
      if (input.action === 'map_product' && p.phrase && input.remember !== false) recordAliasCorrection(p.phrase, productId, actor, { exception_id: exceptionId });
      break;
    }
    case 'remove_line':
      summary = `Left out “${p.source_text ?? p.phrase ?? 'line'}”`;
      if (orderId) addEvent(orderId, 'note', summary, actor, {}, e.message_id);
      break;
    case 'apply_amendment': {
      const oid = needOrder();
      applyChanges(oid, p.changes ?? [], actor, role, e.message_id, `Customer message: “${p.message_text ?? ''}”`);
      summary = 'Change applied';
      break;
    }
    case 'keep_existing':
      summary = 'Kept existing order';
      if (orderId) addEvent(orderId, 'note', `Kept existing — ignored “${p.message_text ?? p.pending_replacement?.source_text ?? ''}”`, actor, {}, e.message_id);
      break;
    case 'use_later':
    case 'add_both': {
      const oid = needOrder();
      const inc = p.pending_replacement;
      if (!inc || !p.product_id) throw badRequest('Nothing to apply.');
      if (input.action === 'add_both') {
        addItem(oid, { product_id: p.product_id, qty: inc.qty, preparation: p.preparation, source_text: inc.source_text }, actor, ctx);
        summary = 'Added both';
      } else {
        const existing = db().prepare("SELECT id FROM order_items WHERE order_id = ? AND product_id = ? AND status = 'active' ORDER BY created_at LIMIT 1").get(oid, p.product_id) as any;
        if (existing) updateItem(existing.id, { qty: inc.qty }, actor, ctx);
        else addItem(oid, { product_id: p.product_id, qty: inc.qty, preparation: p.preparation, source_text: inc.source_text }, actor, ctx);
        summary = `Used ${formatQty(inc.qty)}`;
      }
      break;
    }
    case 'not_duplicate':
      summary = 'Confirmed not a duplicate';
      break;
    case 'cancel_duplicate':
    case 'confirm_cancel': {
      if (!can(role, 'orders.cancel')) throw forbidden('Only a manager can cancel orders.');
      const oid = needOrder();
      const o = requireOrder(oid);
      if (o.status !== 'cancelled') transition(oid, 'cancelled', actor, role, { note: input.action === 'cancel_duplicate' ? 'Duplicate order' : `Customer asked to cancel` });
      // Other open exceptions on a cancelled order are moot
      db().prepare("UPDATE exceptions SET status = 'dismissed', resolution = 'order_cancelled', resolved_by = ?, resolved_at = ? WHERE order_id = ? AND status = 'open' AND id != ?").run(actor.userId, now(), oid, exceptionId);
      summary = 'Order cancelled';
      break;
    }
    case 'keep_order':
      summary = 'Kept the order';
      if (orderId) addEvent(orderId, 'note', 'Cancellation request declined — order kept', actor, {}, e.message_id);
      break;
    case 'choose_customer':
    case 'keep_new_customer': {
      const oid = needOrder();
      if (input.action === 'choose_customer') {
        const c = requireCustomer(input.customer_id ?? '');
        const placeholder = p.placeholder_customer_id as string | undefined;
        updateOrder(oid, { customer_id: c.id }, actor, role, ctx);
        if (placeholder && placeholder !== c.id) {
          const others = (db().prepare('SELECT COUNT(*) n FROM orders WHERE customer_id = ?').get(placeholder) as any).n;
          if (others === 0) db().prepare('UPDATE customers SET archived = 1, updated_at = ? WHERE id = ?').run(now(), placeholder);
        }
        summary = `Order assigned to ${c.name}`;
      } else {
        const o = requireOrder(oid);
        if (input.name?.trim()) db().prepare('UPDATE customers SET name = ?, updated_at = ? WHERE id = ?').run(input.name.trim(), now(), o.customer_id);
        summary = 'Kept as a new customer';
      }
      break;
    }
    case 'set_date': {
      const oid = needOrder();
      if (!input.date) throw badRequest('Choose a date.');
      updateOrder(oid, { requested_date: input.date }, actor, role, ctx);
      summary = `Date set to ${input.date}`;
      break;
    }
    case 'mark_answered':
    case 'mark_handled':
      summary = input.action === 'mark_answered' ? 'Answered' : 'Handled';
      break;
    default:
      throw badRequest('Unknown action.');
  }
  resolution = summary || resolution;
  closeException(exceptionId, status, resolution, input.note?.trim() || null, actor.userId);
  audit(actor, `exception.${status}`, 'exception', exceptionId, `${e.title} — ${resolution}`, { action: input.action });
  if (orderId) {
    addEvent(orderId, 'exception_resolved', `${e.title} — ${resolution}`, actor, { exception_id: exceptionId, action: input.action });
    releaseIfClear(orderId, actor);
  }
  publish(['exceptions', 'orders']);
  return { status };
}

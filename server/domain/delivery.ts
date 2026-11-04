import { db, now, tx } from '../db/db.js';
import { badRequest } from '../lib/errors.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { getSettings } from '../services/settings.js';
import { money } from '../services/templates.js';
import { addEvent, recomputeTotals, requireOrder } from './orders.js';
import { refreshFinalization } from './finalize.js';
import { resolveOrderExceptions } from './exceptions.js';

/**
 * Delivery fees. A standard local delivery costs the flat fee in Settings (R150 to start). The fee
 * is written onto the order when it's placed, so changing the setting only affects new orders.
 * Deliveries outside the regular area are never priced automatically: staff set a custom fee, or
 * mark the delivery as arranged separately (no fee on this order), or change it to collection.
 */
export type DeliveryArrangement = 'standard' | 'custom' | 'separate' | 'collection';

export const ARRANGEMENT_LABEL: Record<DeliveryArrangement, string> = {
  standard: 'Standard local delivery',
  custom: 'Custom delivery fee',
  separate: 'Delivery arranged separately',
  collection: 'Collection',
};

/** The fee a new standard delivery gets today (null when the old per-km method is still selected). */
export function standardDeliveryFeeCents(): number | null {
  const f = getSettings().fulfilment;
  return f.deliveryPricing === 'flat' ? f.flatDeliveryFeeCents : null;
}

/** What the customer is told at checkout. */
export function deliveryInfo() {
  const f = getSettings().fulfilment;
  return { method: f.deliveryPricing, fee_cents: standardDeliveryFeeCents(), area: f.deliveryAreaText, policy: f.deliveryPolicyText };
}

/** Sets how an order is delivered and what it costs. Recalculates totals; a finalized order gets a new version. */
export function setDeliveryArrangement(orderId: string, input: { arrangement: DeliveryArrangement; fee_cents?: number | null; note?: string | null }, actor: Actor) {
  const o = requireOrder(orderId);
  if (['completed', 'cancelled'].includes(o.status)) throw badRequest('This order is finished.');
  if (o.amount_paid_cents > 0 && o.payment_state === 'paid') throw badRequest('This order is already paid in full. Record the delivery charge separately (e.g. a separate invoice).');
  let fee: number;
  switch (input.arrangement) {
    case 'standard': {
      const std = standardDeliveryFeeCents();
      if (std == null) throw badRequest('Set a standard delivery fee in Settings first.');
      fee = std;
      break;
    }
    case 'custom':
      if (input.fee_cents == null || !Number.isInteger(input.fee_cents) || input.fee_cents < 0 || input.fee_cents > 10_000_000) throw badRequest('Enter the delivery fee for this order.');
      fee = input.fee_cents;
      break;
    case 'separate':
    case 'collection':
      fee = 0;
      break;
    default:
      throw badRequest('Choose how this order is delivered.');
  }
  const note = input.note?.trim().slice(0, 500) || null;
  const before = o.delivery_fee_cents ?? 0;
  tx(() => {
    db()
      .prepare(`UPDATE orders SET delivery_arrangement = ?, delivery_fee_cents = ?, fulfilment_type = ?, delivery_notes = COALESCE(?, delivery_notes), updated_at = ? WHERE id = ?`)
      .run(input.arrangement, fee, input.arrangement === 'collection' ? 'collection' : 'delivery', note, now(), orderId);
    recomputeTotals(orderId);
    addEvent(orderId, 'delivery_changed', `${ARRANGEMENT_LABEL[input.arrangement]}${fee || input.arrangement === 'custom' ? ` · fee ${money(fee)}` : ''}${before !== fee ? ` (was ${money(before)})` : ''}${note ? ` · ${note}` : ''}`, actor, { arrangement: input.arrangement, before_cents: before, after_cents: fee, note });
    audit(actor, 'order.delivery_changed', 'order', orderId, `#${o.order_number}: ${ARRANGEMENT_LABEL[input.arrangement]} ${money(fee)}`);
  });
  if (input.arrangement !== 'separate') resolveOrderExceptions(orderId, { types: ['delivery_check'] }, 'arranged');
  if (before !== fee) refreshFinalization(orderId, actor, `delivery fee ${money(before)} → ${money(fee)}`);
  publish(['orders'], { orderId });
  return requireOrder(orderId);
}

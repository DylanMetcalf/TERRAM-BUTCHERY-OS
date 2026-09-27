/**
 * Order workflow — the controlled state machine.
 * Only transitions listed here are permitted, server-side and client-side.
 */
export const ORDER_STATUSES = [
  'review',
  'needs_clarification',
  'confirmed',
  'cutting',
  'cut',
  'packing',
  'packed',
  'ready',
  'out_for_delivery',
  'completed',
  'on_hold',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  review: 'To review',
  needs_clarification: 'Needs clarification',
  confirmed: 'Confirmed',
  cutting: 'Cutting',
  cut: 'Cut',
  packing: 'Packing',
  packed: 'Packed',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  completed: 'Completed',
  on_hold: 'On hold',
  cancelled: 'Cancelled',
};

/** The happy path, in order — used for progress indicators. */
export const STAGES: OrderStatus[] = ['review', 'confirmed', 'cutting', 'packing', 'ready', 'completed'];

export function stageIndex(status: OrderStatus): number {
  switch (status) {
    case 'review':
    case 'needs_clarification':
      return 0;
    case 'confirmed':
      return 1;
    case 'cutting':
    case 'cut':
      return 2;
    case 'packing':
    case 'packed':
      return 3;
    case 'ready':
    case 'out_for_delivery':
      return 4;
    case 'completed':
      return 5;
    default:
      return -1;
  }
}

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  review: ['confirmed', 'needs_clarification', 'on_hold', 'cancelled'],
  needs_clarification: ['review', 'confirmed', 'on_hold', 'cancelled'],
  confirmed: ['cutting', 'review', 'on_hold', 'cancelled'],
  cutting: ['cut', 'confirmed', 'on_hold'],
  cut: ['packing', 'packed', 'cutting', 'on_hold'],
  packing: ['packed', 'cut', 'on_hold'],
  packed: ['ready', 'packing'],
  ready: ['out_for_delivery', 'completed', 'packed'],
  out_for_delivery: ['completed', 'ready'],
  completed: ['ready'],
  on_hold: ['review', 'confirmed'],
  cancelled: ['review'],
};

/** Transitions that only managers/admins may perform (reopening, un-cancelling). */
export const PRIVILEGED_TRANSITIONS: Array<[OrderStatus, OrderStatus]> = [
  ['completed', 'ready'],
  ['cancelled', 'review'],
];

export function allowedTransitions(from: OrderStatus): OrderStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return allowedTransitions(from).includes(to);
}

export function isPrivilegedTransition(from: OrderStatus, to: OrderStatus): boolean {
  return PRIVILEGED_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

/** Orders that are still "live" (not finished, not cancelled). */
export const OPEN_STATUSES: OrderStatus[] = ORDER_STATUSES.filter((s) => s !== 'completed' && s !== 'cancelled');
/** Orders that count towards production (cutting sheet). */
export const PRODUCTION_STATUSES: OrderStatus[] = ['confirmed', 'cutting', 'cut'];
/** Orders whose items may still be freely amended without warnings. */
export const EDITABLE_STATUSES: OrderStatus[] = ['review', 'needs_clarification', 'confirmed', 'on_hold'];

/** The primary "next step" for an order — what the big button on screen does. */
export function primaryNextStep(status: OrderStatus, fulfilment: 'collection' | 'delivery' | null): { to: OrderStatus; label: string } | null {
  switch (status) {
    case 'review':
      return { to: 'confirmed', label: 'Confirm order' };
    case 'needs_clarification':
      return null;
    case 'confirmed':
      return { to: 'cutting', label: 'Start cutting' };
    case 'cutting':
      return { to: 'cut', label: 'Mark cut' };
    case 'cut':
      return { to: 'packing', label: 'Start packing' };
    case 'packing':
      return { to: 'packed', label: 'Mark packed' };
    case 'packed':
      return { to: 'ready', label: 'Mark ready' };
    case 'ready':
      return fulfilment === 'delivery'
        ? { to: 'out_for_delivery', label: 'Out for delivery' }
        : { to: 'completed', label: 'Mark collected' };
    case 'out_for_delivery':
      return { to: 'completed', label: 'Mark delivered' };
    default:
      return null;
  }
}

export const SOURCES = ['form', 'whatsapp', 'email', 'phone', 'manual', 'import'] as const;
export type OrderSource = (typeof SOURCES)[number];
export const SOURCE_LABEL: Record<OrderSource, string> = {
  form: 'Order form',
  whatsapp: 'WhatsApp',
  email: 'Email',
  phone: 'Phone',
  manual: 'In person',
  import: 'WhatsApp import',
};

export type FulfilmentType = 'collection' | 'delivery';
export type PaymentStatus = 'unpaid' | 'pending' | 'paid';
export const PAYMENT_LABEL: Record<PaymentStatus, string> = { unpaid: 'Unpaid', pending: 'Payment pending', paid: 'Paid' };

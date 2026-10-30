import type { OrderStatus, OrderSource, FulfilmentType, PaymentStatus } from '../../../shared/workflow';
import type { Qty, QuantityType } from '../../../shared/quantity';
import type { Role, Permission } from '../../../shared/permissions';

export type { OrderStatus, OrderSource, FulfilmentType, PaymentStatus, Qty, QuantityType, Role, Permission };

export interface Me {
  user: { id: string; name: string; email: string; role: Role; permissions: Permission[] } | null;
  needs_setup: boolean;
  family_login: boolean;
  business: { name: string; tagline: string; timezone: string; currency: string };
}

export interface OrderSummary {
  id: string;
  order_number: number;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  source: OrderSource;
  status: OrderStatus;
  resume_status: OrderStatus | null;
  fulfilment_type: FulfilmentType | null;
  requested_date: string | null;
  time_window: string | null;
  delivery_address: string | null;
  delivery_notes: string | null;
  delivery_km: number | null;
  delivery_fee_cents: number | null;
  special_request: string | null;
  contact_phone: string | null;
  notes: string | null;
  payment_status: PaymentStatus;
  accounting_ref: string | null;
  customer_notified_at: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
  item_count: number;
  items_cut: number;
  items_packed: number;
  open_exceptions: number;
  items_preview: string;
  customer_email?: string | null;
  expected_from?: string | null;
  expected_to?: string | null;
  confirmed_by?: string | null;
  payment_state?: PaymentState;
  invoice_status?: InvoiceStatus;
  estimated_total_cents?: number | null;
  confirmed_total_cents?: number | null;
  final_total_cents?: number | null;
  amount_paid_cents?: number | null;
  storage?: 'fresh' | 'frozen' | null;
  finalized_at?: string | null;
  finalized_version?: number;
}

export type PaymentState = 'not_requested' | 'requested' | 'pending' | 'proof_submitted' | 'partially_paid' | 'paid' | 'failed' | 'refunded';
export type InvoiceStatus = 'not_requested' | 'requested' | 'in_progress' | 'issued' | 'sent' | 'cancelled';

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  product_category: string;
  piece_noun: string;
  qty: Qty;
  qty_label: string;
  preparation: Record<string, string>;
  preparation_label: string;
  special_instructions: string | null;
  source_text: string | null;
  status: 'active' | 'removed';
  cut_at: string | null;
  packed_at: string | null;
  packed_weight_g: number | null;
  price_cents: number | null;
  price_unit: 'kg' | 'each' | null;
  sale_option?: string | null;
  sale_option_kind?: 'pack' | 'piece' | null;
  pricing?: 'exact' | 'estimate' | 'by_weight' | 'unpriced' | null;
  est_cents?: number | null;
  final_cents?: number | null;
  unit_price_cents?: number | null;
}

export interface Preparation {
  id: string;
  group_name: string;
  name: string;
  keywords: string[];
  is_default: boolean;
  customer_visible: boolean;
  active: boolean;
  surcharge_pct?: number;
}

export interface SaleOption { id: string; label: string; kind: 'pack' | 'piece'; grams: number | null }

export interface Product {
  id: string;
  slug: string;
  canonical_name: string;
  customer_name: string;
  category: string;
  description: string | null;
  quantity_type: QuantityType;
  allows_portions: boolean;
  piece_noun: string;
  typical_piece_g: number | null;
  pack_size: number | null;
  price_cents: number | null;
  price_unit: 'kg' | 'each' | null;
  packaging: string | null;
  active: boolean;
  customer_visible: boolean;
  internal_notes: string | null;
  aliases: { id: string; alias: string; source: string }[];
  preparations: Preparation[];
  orders_90d?: number;
  sale_options?: SaleOption[];
  min_qty?: number | null;
  max_qty?: number | null;
  variant_of?: string | null;
  variant_label?: string | null;
  unavailable_reason?: string | null;
  image?: string | null;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  preferred_fulfilment: FulfilmentType | null;
  order_count?: number;
  last_order_at?: string | null;
  open_orders?: number;
  created_at: string;
}

export interface ExceptionAction {
  key: string;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
  needs?: string;
}

export interface ExceptionRow {
  id: string;
  type: string;
  severity: 'blocking' | 'warning' | 'info';
  status: 'open' | 'resolved' | 'dismissed';
  title: string;
  detail: string | null;
  order_id: string | null;
  order_number: number | null;
  customer_name: string | null;
  customer_id: string | null;
  message_id: string | null;
  message_body: string | null;
  payload: any;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
  actions: ExceptionAction[];
}

export interface OrderEvent {
  id: string;
  type: string;
  summary: string;
  data: any;
  actor_kind: 'user' | 'system' | 'customer';
  actor_name: string | null;
  message_body: string | null;
  message_sender: string | null;
  created_at: string;
}

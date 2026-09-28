import { z } from 'zod';
import type { Context } from 'hono';
import { badRequest } from '../lib/errors.js';

export const QtySchema = z.object({
  kind: z.enum(['weight', 'count', 'portions']),
  count: z.number().int().positive().max(100000).nullable().optional().transform((v) => v ?? null),
  weight_g: z.number().positive().max(1_000_000).nullable().optional().transform((v) => (v == null ? null : Math.round(v))),
});

export const PrepSchema = z.record(z.string().max(60), z.string().max(80)).optional();

export const ItemSchema = z.object({
  product_id: z.string().min(1).max(64),
  qty: QtySchema,
  preparation: PrepSchema,
  special_instructions: z.string().max(500).nullable().optional(),
});

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const optStr = (max: number) => z.string().max(max).nullable().optional();

export const CustomerSchema = z.object({
  name: z.string().trim().min(1, 'Enter the customer name').max(120),
  phone: optStr(40),
  email: z.string().trim().max(200).email('Enter a valid email').nullable().optional().or(z.literal('')),
  address: optStr(300),
  notes: optStr(2000),
  preferred_fulfilment: z.enum(['collection', 'delivery']).nullable().optional(),
});

export const CreateOrderSchema = z.object({
  customer_id: z.string().max(64).optional(),
  customer: CustomerSchema.optional(),
  source: z.enum(['phone', 'manual', 'whatsapp', 'email']).default('manual'),
  items: z.array(ItemSchema).min(1, 'Add at least one product').max(100),
  status: z.enum(['review', 'confirmed']).default('confirmed'),
  fulfilment_type: z.enum(['collection', 'delivery']).nullable().optional(),
  requested_date: ymd.nullable().optional(),
  time_window: optStr(100),
  delivery_address: optStr(300),
  delivery_notes: optStr(500),
  contact_phone: optStr(40),
  notes: optStr(2000),
  payment_status: z.enum(['unpaid', 'pending', 'paid']).optional(),
});

export const OrderPatchSchema = z.object({
  fulfilment_type: z.enum(['collection', 'delivery']).nullable().optional(),
  requested_date: ymd.nullable().optional(),
  time_window: optStr(100),
  delivery_address: optStr(300),
  delivery_notes: optStr(500),
  delivery_km: z.number().min(0).max(2000).nullable().optional(),
  contact_phone: optStr(40),
  notes: optStr(2000),
  payment_status: z.enum(['unpaid', 'pending', 'paid']).optional(),
  accounting_ref: optStr(100),
  customer_id: z.string().max(64).optional(),
});

export const PublicOrderSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2, 'Please enter your name').max(120),
    phone: z.string().trim().min(7, 'Please enter a phone number').max(40),
    email: z.string().trim().max(200).email('Please enter a valid email').optional().or(z.literal('')),
  }),
  items: z.array(ItemSchema.omit({ special_instructions: true }).extend({ special_instructions: z.string().max(300).nullable().optional() })).max(40),
  special_request: optStr(1500),
  fulfilment_type: z.enum(['collection', 'delivery']),
  requested_date: ymd,
  delivery_address: optStr(300),
  notes: optStr(1000),
  website: z.string().max(0).optional(), // honeypot — must stay empty
  client_ref: z.string().min(8).max(80),
});

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('The request was not valid.');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path?.length ? ` (${first.path.join('.')})` : '';
    throw badRequest(first?.message && !first.message.startsWith('Invalid') && !first.message.startsWith('Expected') ? first.message : `Please check the details${where}.`, r.error.issues);
  }
  return r.data;
}

export function ymdParam(v: string | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

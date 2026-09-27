import { db, id, now } from '../db/db.js';
import { fuzzyWordEqual, normalise, normalisePhone } from '../../shared/text.js';
import { audit, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { badRequest, notFound } from '../lib/errors.js';

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  preferred_fulfilment: 'collection' | 'delivery' | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface CustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  preferred_fulfilment?: 'collection' | 'delivery' | null;
}

export function getCustomer(customerId: string): Customer | undefined {
  return db().prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as Customer | undefined;
}

export function requireCustomer(customerId: string): Customer {
  const c = getCustomer(customerId);
  if (!c) throw notFound('That customer');
  return c;
}

export function createCustomer(input: CustomerInput, actor: Actor): Customer {
  const name = input.name?.trim();
  if (!name) throw badRequest('The customer needs a name.');
  const cid = id('cu_');
  const ts = now();
  const phoneNorm = normalisePhone(input.phone ?? null);
  db()
    .prepare('INSERT INTO customers (id, name, phone, phone_normalized, email, address, notes, preferred_fulfilment, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(cid, name, input.phone?.trim() || null, phoneNorm, input.email?.trim().toLowerCase() || null, input.address?.trim() || null, input.notes?.trim() || null, input.preferred_fulfilment ?? null, ts, ts);
  audit(actor, 'customer.created', 'customer', cid, `Added customer ${name}`, input);
  publish(['customers']);
  return requireCustomer(cid);
}

export function updateCustomer(customerId: string, input: Partial<CustomerInput> & { archived?: boolean }, actor: Actor): Customer {
  const before = requireCustomer(customerId);
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) throw badRequest('The customer needs a name.');
    fields.name = input.name.trim();
  }
  if (input.phone !== undefined) {
    fields.phone = input.phone?.trim() || null;
    fields.phone_normalized = normalisePhone(input.phone ?? null);
  }
  if (input.email !== undefined) fields.email = input.email?.trim().toLowerCase() || null;
  if (input.address !== undefined) fields.address = input.address?.trim() || null;
  if (input.notes !== undefined) fields.notes = input.notes?.trim() || null;
  if (input.preferred_fulfilment !== undefined) fields.preferred_fulfilment = input.preferred_fulfilment || null;
  if (input.archived !== undefined) fields.archived = input.archived ? 1 : 0;
  if (!Object.keys(fields).length) return before;
  db()
    .prepare(`UPDATE customers SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(fields), now(), customerId);
  audit(actor, 'customer.updated', 'customer', customerId, `Updated ${before.name}`, { before, changes: input });
  publish(['customers']);
  return requireCustomer(customerId);
}

/** Fill in blanks only (never overwrite what staff typed) — used when orders bring new contact info. */
export function enrichCustomer(customerId: string, info: { phone?: string | null; email?: string | null; address?: string | null }, actor: Actor) {
  const c = requireCustomer(customerId);
  const patch: Partial<CustomerInput> = {};
  if (info.phone && !c.phone) patch.phone = info.phone;
  if (info.email && !c.email) patch.email = info.email;
  if (info.address && !c.address) patch.address = info.address;
  if (Object.keys(patch).length) updateCustomer(customerId, patch, actor);
}

export type CustomerMatch =
  | { status: 'matched'; via: 'phone' | 'email' | 'name'; customer: Customer }
  | { status: 'probable'; via: 'first_name' | 'similar_name'; customer: Customer }
  | { status: 'ambiguous'; candidates: Customer[] }
  | { status: 'new' };

/**
 * Customer Context Assistant — deterministic matching.
 * Phone and email are authoritative; names can only ever be "probable" unless exact and unique.
 */
export function matchCustomer(q: { name?: string | null; phone?: string | null; email?: string | null }): CustomerMatch {
  const phone = normalisePhone(q.phone ?? null);
  if (phone) {
    const rows = db().prepare('SELECT * FROM customers WHERE phone_normalized = ? AND archived = 0').all(phone) as Customer[];
    if (rows.length === 1) return { status: 'matched', via: 'phone', customer: rows[0] };
    if (rows.length > 1) return { status: 'ambiguous', candidates: rows };
  }
  if (q.email) {
    const rows = db().prepare('SELECT * FROM customers WHERE email = ? AND archived = 0').all(q.email.trim().toLowerCase()) as Customer[];
    if (rows.length === 1) return { status: 'matched', via: 'email', customer: rows[0] };
  }
  const name = q.name?.trim();
  if (!name) return { status: 'new' };
  const n = normalise(name);
  const all = db().prepare('SELECT * FROM customers WHERE archived = 0').all() as Customer[];
  const exact = all.filter((c) => normalise(c.name) === n);
  if (exact.length === 1) {
    // A bare first name matching exactly one customer called just "John" is still only probable
    return n.includes(' ') ? { status: 'matched', via: 'name', customer: exact[0] } : { status: 'probable', via: 'first_name', customer: exact[0] };
  }
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact };
  const words = n.split(' ');
  if (words.length === 1) {
    const firsts = all.filter((c) => normalise(c.name).split(' ')[0] === words[0]);
    if (firsts.length === 1) return { status: 'probable', via: 'first_name', customer: firsts[0] };
    if (firsts.length > 1) return { status: 'ambiguous', candidates: firsts.slice(0, 6) };
    return { status: 'new' };
  }
  const similar = all.filter((c) => {
    const cw = normalise(c.name).split(' ');
    return cw.length === words.length && cw.every((w, i) => fuzzyWordEqual(w, words[i]));
  });
  if (similar.length === 1) return { status: 'probable', via: 'similar_name', customer: similar[0] };
  if (similar.length > 1) return { status: 'ambiguous', candidates: similar };
  return { status: 'new' };
}

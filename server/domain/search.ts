import { db } from '../db/db.js';
import { normalise, normalisePhone } from '../../shared/text.js';
import { listProducts } from './products.js';

/** Global search — customers, orders, products, messages. Tolerates case, punctuation and plurals. */
export function search(q: string) {
  const raw = q.trim().slice(0, 100);
  if (!raw) return { customers: [], orders: [], products: [], messages: [] };
  const like = `%${raw.replace(/[%_]/g, '')}%`;
  const num = /^#?\d{3,7}$/.test(raw) ? Number(raw.replace('#', '')) : null;
  const phone = /\d{6,}/.test(raw.replace(/\D/g, '')) ? normalisePhone(raw) : null;
  const phoneDigits = raw.replace(/\D/g, '');
  const customers = db()
    .prepare(
      `SELECT id, name, phone, email FROM customers
       WHERE archived = 0 AND (name LIKE ? OR email LIKE ? OR (? != '' AND phone_normalized LIKE ?) OR (? IS NOT NULL AND phone_normalized = ?))
       ORDER BY name LIMIT 6`,
    )
    .all(like, like, phoneDigits.length >= 4 ? phoneDigits : '', `%${phoneDigits.slice(-9)}%`, phone, phone) as any[];
  const orders = db()
    .prepare(
      `SELECT o.id, o.order_number, o.status, o.requested_date, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.order_number = ? OR c.name LIKE ? OR o.notes LIKE ? OR o.delivery_address LIKE ?
       ORDER BY o.created_at DESC LIMIT 8`,
    )
    .all(num ?? -1, like, like, like) as any[];
  const n = normalise(raw);
  const products = listProducts()
    .filter((p) => normalise(p.canonical_name).includes(n) || p.aliases.some((a) => a.alias.includes(n)) || normalise(p.category) === n)
    .slice(0, 6)
    .map((p) => ({ id: p.id, name: p.canonical_name, category: p.category, active: p.active }));
  const messages = db()
    .prepare(
      `SELECT m.id, m.body, m.sender_name, m.received_at, m.order_id, o.order_number FROM messages m LEFT JOIN orders o ON o.id = m.order_id
       WHERE m.body LIKE ? ORDER BY m.received_at DESC LIMIT 5`,
    )
    .all(like) as any[];
  return { customers, orders, products, messages };
}

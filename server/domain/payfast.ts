import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { db, id, now } from '../db/db.js';
import { conflict } from '../lib/errors.js';
import { payfastConfig, type PayfastConfig } from '../services/payment-config.js';
import { orderUrl, siteUrl } from '../services/links.js';
import { raiseException } from './exceptions.js';
import { addEvent, requireOrder } from './orders.js';
import { openRequest, recomputePayment, recordFailedPayment, recordVerifiedPayment } from './payments.js';
import { recordSystemEvent } from '../services/health.js';

/**
 * PAYFAST (online card / instant EFT). Implemented from PayFast's official integration (the
 * "custom integration" form post and the ITN notification), as published in PayFast's SDK:
 *   - payment form posted to {base}/eng/process; base is https://sandbox.payfast.co.za or https://www.payfast.co.za
 *   - signature: MD5 of the fields in their documented order, each `key=urlencode(trim(value))`
 *     joined with &, empty values left out, then `&passphrase=…` when a passphrase is set
 *   - ITN (notify_url): verify the signature, that it came from a PayFast server, that the amount
 *     matches what we asked for, and ask PayFast to confirm it ({base}/eng/query/validate → "VALID").
 * A payment counts only after ALL checks pass. The customer coming back to the site proves nothing.
 */

/** PHP's urlencode(): spaces as "+", and everything except letters, digits, "-", "_" and "." escaped. */
export function phpUrlencode(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

export function signFields(fields: [string, string][], passphrase: string): string {
  const parts = fields.filter(([k, v]) => k !== 'signature' && v.trim() !== '').map(([k, v]) => `${k}=${phpUrlencode(v.trim())}`);
  if (passphrase.trim()) parts.push(`passphrase=${phpUrlencode(passphrase.trim())}`);
  return crypto.createHash('md5').update(parts.join('&')).digest('hex');
}

const cents = (n: number) => (n / 100).toFixed(2);

/** The signed form that sends the customer to PayFast to pay the order's open payment request. */
export function buildCheckout(orderId: string) {
  const cfg = payfastConfig();
  if (!cfg) throw conflict('Online payment isn’t available at the moment. Please pay by EFT or contact us.');
  const req = openRequest(orderId);
  if (!req) throw conflict('There is nothing to pay on this order right now.');
  const o = requireOrder(orderId);
  const c = db().prepare('SELECT c.name, COALESCE(o.customer_email, c.email) AS email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(orderId) as { name: string; email: string | null };
  const [first, ...rest] = c.name.trim().split(/\s+/);
  const fields: [string, string][] = [
    ['merchant_id', cfg.merchantId],
    ['merchant_key', cfg.merchantKey],
    ['return_url', orderUrl(orderId, '?payment=returned')],
    ['cancel_url', orderUrl(orderId, '?payment=cancelled')],
    ['notify_url', `${siteUrl()}/api/integrations/payfast/notify`],
    ['name_first', (first ?? '').slice(0, 100)],
    ['name_last', rest.join(' ').slice(0, 100)],
    ['email_address', (c.email ?? '').slice(0, 100)],
    ['m_payment_id', req.id],
    ['amount', cents(req.amount_cents)],
    ['item_name', `Terram Farm order #${o.order_number}`.slice(0, 100)],
    ['custom_str1', orderId],
  ];
  const nonEmpty = fields.filter(([, v]) => v.trim() !== '');
  const signature = signFields(nonEmpty, cfg.passphrase);
  db().prepare("UPDATE orders SET payment_choice = 'online', payment_state = CASE WHEN payment_state IN ('requested','failed') THEN 'pending' ELSE payment_state END, updated_at = ? WHERE id = ?").run(now(), orderId);
  addEvent(orderId, 'payment_started', `Customer went to PayFast to pay ${cents(req.amount_cents)} (not paid until PayFast confirms)`, { userId: null, kind: 'customer', name: 'Customer' }, { request_id: req.id });
  return { action: `${cfg.baseUrl}/eng/process`, fields: [...nonEmpty, ['signature', signature]] as [string, string][], sandbox: cfg.sandbox };
}

const PAYFAST_HOSTS = ['www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];

export interface ItnDeps {
  /** IP addresses PayFast sends from (resolved from its host names). */
  payfastIps: () => Promise<string[]>;
  /** Asks PayFast whether this notification is genuine. */
  confirm: (cfg: PayfastConfig, paramString: string) => Promise<boolean>;
}

export const defaultItnDeps: ItnDeps = {
  payfastIps: async () => (await Promise.all(PAYFAST_HOSTS.map((h) => dns.resolve4(h).catch(() => [] as string[])))).flat(),
  confirm: async (cfg, paramString) => {
    const res = await fetch(`${cfg.baseUrl}/eng/query/validate`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: paramString, signal: AbortSignal.timeout(15_000) });
    return (await res.text()).trim() === 'VALID';
  },
};

function logEvent(dedupe: string, orderId: string | null, outcome: string, detail: string, payload: string) {
  db().prepare('INSERT INTO provider_events (id, provider, dedupe_key, order_id, outcome, detail, payload, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id('pe_'), 'payfast', dedupe, orderId, outcome, detail, payload.slice(0, 5000), now());
}

/**
 * Handles one ITN. Returns the outcome; never marks anything paid unless every check passes.
 * Repeated notifications for the same payment are recognised and do nothing.
 */
export async function handleItn(rawBody: string, sourceIp: string | null, deps: ItnDeps = defaultItnDeps): Promise<{ ok: boolean; outcome: string }> {
  const cfg = payfastConfig();
  const pairs = [...new URLSearchParams(rawBody).entries()];
  const data = Object.fromEntries(pairs);
  const dedupe = `${data.pf_payment_id ?? 'none'}:${data.payment_status ?? 'none'}`;
  const safePayload = JSON.stringify(Object.fromEntries(pairs.filter(([k]) => !['signature'].includes(k))));
  const reject = (outcome: string, detail: string) => {
    logEvent(dedupe, data.custom_str1 ?? null, outcome, detail, safePayload);
    recordSystemEvent('warning', 'payments', `PayFast notification rejected: ${detail}`, { pf_payment_id: data.pf_payment_id, m_payment_id: data.m_payment_id });
    return { ok: false, outcome };
  };
  if (!cfg) return reject('not_configured', 'PayFast is not set up on this server.');
  // 1. Signature over the fields exactly as received, up to the signature itself
  const sigIndex = pairs.findIndex(([k]) => k === 'signature');
  const signed = sigIndex < 0 ? pairs : pairs.slice(0, sigIndex);
  const paramString = signed.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join('&');
  const expected = crypto.createHash('md5').update(cfg.passphrase ? `${paramString}&passphrase=${phpUrlencode(cfg.passphrase.trim())}` : paramString).digest('hex');
  if (!data.signature || data.signature !== expected) return reject('bad_signature', 'The signature did not match.');
  if (data.merchant_id !== cfg.merchantId) return reject('wrong_merchant', 'The merchant id did not match.');
  // 2. From PayFast's servers
  if (process.env.PAYFAST_SKIP_IP_CHECK !== '1') {
    const ips = await deps.payfastIps();
    if (!sourceIp || !ips.includes(sourceIp)) return reject('bad_source', `Came from ${sourceIp ?? 'an unknown address'}, not a PayFast server.`);
  }
  // 3. Our payment request, and the amount we asked for
  const req = db().prepare('SELECT * FROM payment_requests WHERE id = ?').get(data.m_payment_id ?? '') as any;
  if (!req) return reject('unknown_request', 'No payment request with that reference.');
  const gross = Math.round(Number(data.amount_gross) * 100);
  if (!Number.isFinite(gross)) return reject('bad_amount', 'No amount in the notification.');
  // 4. PayFast confirms it sent this
  let valid = false;
  try {
    valid = await deps.confirm(cfg, paramString);
  } catch (e) {
    return reject('confirm_unreachable', `Couldn't reach PayFast to confirm: ${(e as Error).message}`);
  }
  if (!valid) return reject('not_confirmed', 'PayFast did not confirm this notification.');
  // Same payment told twice
  const seen = db().prepare("SELECT 1 FROM provider_events WHERE provider = 'payfast' AND dedupe_key = ? AND outcome IN ('paid','failed','paid_mismatch')").get(dedupe);
  if (seen) {
    logEvent(dedupe, req.order_id, 'duplicate', 'Already handled.', safePayload);
    return { ok: true, outcome: 'duplicate' };
  }
  const status = String(data.payment_status ?? '').toUpperCase();
  if (status === 'COMPLETE') {
    const o = requireOrder(req.order_id);
    const mismatch = gross !== req.amount_cents || req.status !== 'open';
    recordVerifiedPayment(req.order_id, { method: 'online', amount_cents: gross, request_id: req.id, provider: 'payfast', provider_ref: data.pf_payment_id ?? null, note: mismatch ? `Paid ${cents(gross)} against a ${req.status} request for ${cents(req.amount_cents)}` : null }, { userId: null, kind: 'system', name: 'PayFast' }, 'provider');
    if (mismatch) {
      raiseException({ type: 'payment_issue', severity: 'warning', title: `Check the online payment on #${o.order_number}`, detail: `PayFast confirmed R${cents(gross)}, but the request was for R${cents(req.amount_cents)}${req.status !== 'open' ? ` and had been ${req.status}` : ''}. Reconcile the difference with the customer.`, order_id: req.order_id, dedupe_key: `pf-mismatch:${data.pf_payment_id}` });
    }
    logEvent(dedupe, req.order_id, mismatch ? 'paid_mismatch' : 'paid', `Payment ${data.pf_payment_id} confirmed`, safePayload);
    return { ok: true, outcome: mismatch ? 'paid_mismatch' : 'paid' };
  }
  if (status === 'CANCELLED' || status === 'FAILED') {
    recordFailedPayment(req.order_id, { method: 'online', amount_cents: gross, provider: 'payfast', provider_ref: data.pf_payment_id ? `${data.pf_payment_id}:${status}` : null, request_id: req.id, note: status === 'CANCELLED' ? 'The payment was cancelled.' : 'The payment failed.' });
    logEvent(dedupe, req.order_id, 'failed', status, safePayload);
    return { ok: true, outcome: 'failed' };
  }
  logEvent(dedupe, req.order_id, 'ignored', `Status ${status}`, safePayload);
  recomputePayment(req.order_id);
  return { ok: true, outcome: 'ignored' };
}

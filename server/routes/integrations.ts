import { Hono } from 'hono';
import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { recordSystemEvent } from '../services/health.js';
import { processInbound } from '../intelligence/inbound.js';
import { actorOf, requirePerm, type Env } from '../http/context.js';
import { body } from '../http/schemas.js';
import { rateLimit } from '../http/security.js';

/**
 * Integration boundary. Each adapter authenticates its channel and converts
 * the payload into an InboundMessage — nothing else in the system knows or
 * cares which channel a message came from.
 */
const r = new Hono<Env>();

// WhatsApp Business Cloud API — verification handshake
r.get('/whatsapp/webhook', (c) => {
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!token) throw new AppError(503, 'WhatsApp is not configured.');
  if (c.req.query('hub.mode') === 'subscribe' && c.req.query('hub.verify_token') === token) return c.text(c.req.query('hub.challenge') ?? '');
  recordSystemEvent('warning', 'webhook.whatsapp', 'Webhook verification failed');
  throw new AppError(403, 'Verification failed.');
});

r.post('/whatsapp/webhook', rateLimit('wa', 600, 60_000), async (c) => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) throw new AppError(503, 'WhatsApp is not configured.');
  const raw = await c.req.text();
  const sig = c.req.header('x-hub-signature-256') ?? '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    recordSystemEvent('warning', 'webhook.whatsapp', 'Rejected webhook with an invalid signature');
    throw new AppError(401, 'Invalid signature.');
  }
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'Invalid JSON.');
  }
  const results = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const names = new Map<string, string>((value.contacts ?? []).map((ct: any) => [ct.wa_id, ct.profile?.name]));
      for (const m of value.messages ?? []) {
        if (m.type !== 'text' || !m.text?.body) {
          recordSystemEvent('info', 'webhook.whatsapp', `Skipped a ${m.type} message (only text is read)`);
          continue;
        }
        results.push(
          await processInbound({
            channel: 'whatsapp',
            external_id: m.id,
            from_phone: m.from ? `+${m.from}` : null,
            from_name: names.get(m.from) ?? null,
            body: m.text.body,
            sent_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
          }),
        );
      }
    }
  }
  // Always 200 quickly so Meta does not retry; duplicates are ignored by external_id anyway
  return c.json({ ok: true, processed: results.length });
});

// Generic inbound email (e.g. from a mail provider's inbound-parse webhook)
r.post('/email/inbound', rateLimit('email', 120, 60_000), async (c) => {
  const token = process.env.EMAIL_INBOUND_TOKEN;
  if (!token) throw new AppError(503, 'Inbound email is not configured.');
  const auth = c.req.header('authorization') ?? '';
  const given = auth.replace(/^Bearer\s+/i, '');
  if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    recordSystemEvent('warning', 'webhook.email', 'Rejected inbound email with a bad token');
    throw new AppError(401, 'Unauthorised.');
  }
  const input = await body(c, z.object({ message_id: z.string().max(300), from_email: z.string().max(200), from_name: z.string().max(200).optional(), subject: z.string().max(500).optional(), text: z.string().max(50_000), date: z.string().max(100).optional() }));
  const text = stripQuotedReply(input.text);
  const outcome = await processInbound({ channel: 'email', external_id: input.message_id, from_email: input.from_email, from_name: input.from_name ?? null, body: input.subject && !/^re:/i.test(input.subject) ? `${text}` : text, sent_at: input.date ?? null });
  return c.json(outcome);
});

function stripQuotedReply(t: string) {
  const cut = t.search(/\n(?:On .+ wrote:|-{2,}\s*Original Message|From: .+\n)/i);
  return (cut > 0 ? t.slice(0, cut) : t).trim();
}

/** Test Mode: simulate a WhatsApp message end-to-end from inside the app. */
r.post('/simulate', requirePerm('import.run'), async (c) => {
  const input = await body(c, z.object({ from_name: z.string().max(120).optional(), from_phone: z.string().max(40).optional(), body: z.string().min(1).max(4000), external_id: z.string().max(100).optional() }));
  const outcome = await processInbound({ channel: 'whatsapp', external_id: input.external_id ?? `sim-${crypto.randomUUID()}`, from_name: input.from_name ?? null, from_phone: input.from_phone ?? null, body: input.body }, actorOf(c));
  return c.json(outcome);
});

export default r;

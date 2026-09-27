import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import { getSettings } from '../services/settings.js';
import { recordSystemEvent } from '../services/health.js';
import type { Dictionary } from './matcher.js';

/**
 * Claude-backed Order Analyst. Used only when the deterministic rules could
 * not fully understand a message (cost control + reliability). Output is
 * schema-constrained and then re-validated against the product dictionary —
 * the model can propose, never commit.
 */
export const AI_ENGINE_VERSION = 'claude-interpreter/1';

const AiItem = z.object({
  phrase: z.string().describe('The product words exactly as the customer wrote them'),
  product_id: z.string().nullable().describe('ID from the catalogue if you are confident, otherwise null. Never invent IDs.'),
  quantity_kind: z.enum(['weight', 'count', 'portions', 'unknown']),
  count: z.number().nullable().describe('Number of pieces (count) or number of portions (portions)'),
  weight_grams: z.number().nullable().describe('Total grams (weight) or grams per portion (portions)'),
  preparation: z.array(z.object({ group: z.string(), option: z.string() })).describe('Only options listed for that product'),
  instructions: z.string().nullable(),
  operation: z.enum(['add', 'set', 'remove']).describe('add = new item; set = change quantity of an existing item; remove = remove it'),
  refers_to: z.string().nullable().describe('For vague references like "make that 3", the product phrase from earlier in the conversation it refers to; null if unclear'),
});

const AiResult = z.object({
  intent: z.enum(['new_order', 'amendment', 'cancellation', 'clarification', 'question', 'fulfilment_info', 'customer_info', 'chatter', 'unknown']),
  items: z.array(AiItem),
  fulfilment: z.object({
    type: z.enum(['collection', 'delivery', 'unknown']),
    date: z.string().nullable().describe('YYYY-MM-DD, resolved relative to the message date'),
    time_window: z.string().nullable(),
    address: z.string().nullable(),
  }),
  notes: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  explanation: z.string().describe('One short sentence explaining the interpretation, for staff'),
});

export type AiInterpretation = z.infer<typeof AiResult>;

let client: Anthropic | null = null;

export function aiAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && getSettings().ai.enabled && process.env.TERRAM_DISABLE_AI !== '1';
}

function getClient() {
  if (!client) client = new Anthropic({ timeout: 45_000, maxRetries: 2 });
  return client;
}

function catalogueText(dict: Dictionary): string {
  return dict.products
    .filter((p) => p.active)
    .map((p) => {
      const prep = Object.entries(
        p.preps.reduce<Record<string, string[]>>((acc, o) => {
          (acc[o.group] ??= []).push(o.name);
          return acc;
        }, {}),
      )
        .map(([g, o]) => `${g}: ${o.join(' | ')}`)
        .join('; ');
      return `- id=${p.id} | ${p.name} | ${p.category} | sold by ${p.product.quantity_type}${p.product.allows_portions ? ' (portions allowed)' : ''} | also called: ${p.aliasStrings.slice(0, 8).join(', ')}${prep ? ` | options: ${prep}` : ''}`;
    })
    .join('\n');
}

const SYSTEM = `You interpret customer messages for a family-run farm butchery (Terram Farm, South Africa).
Messages arrive via WhatsApp and are often short, informal, and may contain typos or Afrikaans words (e.g. "wors" = boerewors).
Your job is ONLY to describe what the customer said in structured form. You do not take actions.

Rules:
- Map products only to the catalogue below. If a product is not clearly in the catalogue, set product_id to null. Never guess a different product just because it is similar.
- Never convert weight to pieces or pieces to weight. "15 fillets" is count=15. "2kg" is weight_grams=2000. "6 x 500g" is portions: count=6, weight_grams=500.
- If a quantity is missing or unclear, use quantity_kind "unknown".
- Amendments ("actually make that 3kg", "change the rumps to 6", "remove the mince") use intent "amendment" with operation set/remove.
- "Thanks", "ok", emojis and greetings are "chatter".
- Questions about stock, prices or times are "question".
- If you are not sure, say so with confidence "low". Do not fill gaps with assumptions.

CATALOGUE:
`;

export async function interpretWithClaude(message: string, context: string[], messageDate: string, dict: Dictionary): Promise<{ result: AiInterpretation | null; model: string; latencyMs: number; error?: string }> {
  const settings = getSettings().ai;
  const started = Date.now();
  const model = settings.model || 'claude-opus-5';
  try {
    const response = await getClient().messages.parse({
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM + catalogueText(dict), cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `Message date: ${messageDate}\n\nEarlier in this conversation (oldest first):\n${context.length ? context.map((c) => `> ${c}`).join('\n') : '(none)'}\n\nMessage to interpret:\n"""\n${message.slice(0, 4000)}\n"""`,
        },
      ],
      output_config: { effort: settings.effort, format: zodOutputFormat(AiResult) },
    });
    const latencyMs = Date.now() - started;
    if (response.stop_reason === 'refusal') {
      recordSystemEvent('warning', 'ai', 'The assistant declined to interpret a message', { stop_reason: response.stop_reason });
      return { result: null, model, latencyMs, error: 'declined' };
    }
    if (!response.parsed_output) {
      recordSystemEvent('warning', 'ai', 'The assistant returned an unreadable interpretation', { stop_reason: response.stop_reason });
      return { result: null, model, latencyMs, error: 'unparseable' };
    }
    return { result: response.parsed_output, model, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    let msg = 'AI request failed';
    if (err instanceof Anthropic.AuthenticationError) msg = 'AI key rejected — check ANTHROPIC_API_KEY';
    else if (err instanceof Anthropic.RateLimitError) msg = 'AI rate limited';
    else if (err instanceof Anthropic.APIConnectionError) msg = 'Could not reach the AI service';
    else if (err instanceof Anthropic.APIError) msg = `AI service error (${err.status})`;
    recordSystemEvent('error', 'ai', msg, err instanceof Error ? err.message : String(err));
    return { result: null, model, latencyMs, error: msg };
  }
}

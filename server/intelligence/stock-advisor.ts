import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import { getSettings } from '../services/settings.js';
import { recordSystemEvent } from '../services/health.js';
import { listProducts } from '../domain/products.js';
import { aiAvailable } from './ai.js';
import type { planStock, StockItem } from '../domain/stock.js';

/**
 * The assistant's part in stock: it reads the planner's numbers and explains them in plain words
 * (what to order, what extra it will give, what to watch), and can draft cutting yields for a
 * carcass. It never saves or orders anything; the family reviews and decides. Without an AI key
 * the same questions get a rules-based answer, so the section always works.
 */

type Plan = ReturnType<typeof planStock>;

let client: Anthropic | null = null;
function getClient() {
  if (!client) client = new Anthropic({ timeout: 60_000, maxRetries: 2 });
  return client;
}

const kg = (n: number) => `${Math.round(n * 10) / 10} kg`;
const units = (n: number, unit: string) => (unit === 'kg' ? kg(n) : `${n} ${unit === 'pack' ? (n === 1 ? 'pack' : 'packs') : ''}`.trim());

/** A plain summary of the plan, used as-is without AI and as the facts the AI works from. */
export function planFacts(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Open orders in range: ${plan.order_count}.`);
  if (plan.demand.length) {
    lines.push('Still to cut (kg, per product):');
    for (const d of plan.demand) lines.push(`- ${d.product_name}: ${kg(d.need_kg)}${d.unknown_pieces ? ` + ${d.unknown_pieces} pieces of unknown weight` : ''}${d.from_stock_kg ? ` (${kg(d.from_stock_kg)} from stock on hand)` : ''}`);
  }
  for (const s of plan.sources) {
    lines.push(`Source "${s.name}" (${s.unit === 'kg' ? 'by kg' : `each ≈ ${s.avg_weight_kg ?? '?'} kg`}): need ${units(s.units_needed, s.unit)}, have ${units(s.on_hand, s.unit)}, to order ${units(s.to_order, s.unit)}${s.est_cost_cents != null ? ` (≈ R${Math.round(s.est_cost_cents / 100)})` : ''}.${s.driven_by ? ` Driven by ${s.driven_by.product_name} (${kg(s.driven_by.need_kg)}).` : ''}`);
    const extras = s.outputs.filter((o) => o.extra_kg > 0.5).slice(0, 8);
    if (extras.length) lines.push(`  Extra it will give beyond orders: ${extras.map((o) => `${o.product_name} ${kg(o.extra_kg)}`).join(', ')}.`);
  }
  if (plan.uncovered.length) lines.push(`Not covered by any stock item or yield: ${plan.uncovered.map((u) => `${u.product_name} ${kg(u.need_kg)}${u.reason === 'no_weight' ? ' (source has no average weight)' : ''}`).join(', ')}.`);
  return lines.join('\n');
}

function rulesAdvice(plan: Plan): string {
  if (!plan.order_count) return 'There are no open orders to cut in this period, so there’s nothing to order for them.';
  const out: string[] = [];
  const order = plan.sources.filter((s) => s.to_order > 0);
  if (order.length) out.push(`To cover these ${plan.order_count} orders, order ${order.map((s) => `${units(s.to_order, s.unit)} ${s.unit === 'kg' ? `of ${s.name.toLowerCase()}` : s.name.toLowerCase() + (s.to_order === 1 ? '' : 's')}`).join(', ')}.`);
  else if (plan.sources.length) out.push(`What you have on hand covers these ${plan.order_count} orders.`);
  for (const s of plan.sources.filter((x) => x.driven_by)) {
    out.push(`${s.name}: ${s.driven_by!.product_name} sets the number (${kg(s.driven_by!.need_kg)} needed).`);
    const extras = s.outputs.filter((o) => o.extra_kg > 1).sort((a, b) => b.extra_kg - a.extra_kg).slice(0, 3);
    if (extras.length) out.push(`Cutting ${units(s.for_cuts, s.unit)} also gives about ${extras.map((o) => `${kg(o.extra_kg)} more ${o.product_name.toLowerCase()}`).join(', ')} than is on order. Plan to sell, freeze or turn that into mince, wors or biltong.`);
  }
  if (plan.uncovered.length) out.push(`${plan.uncovered.map((u) => u.product_name).join(', ')} ${plan.uncovered.length === 1 ? 'isn’t' : 'aren’t'} linked to anything in stock yet. Add ${plan.uncovered.length === 1 ? 'it' : 'them'} to a carcass’s yields, or as a stock item, so the plan can include ${plan.uncovered.length === 1 ? 'it' : 'them'}.`);
  if (plan.missing_costs) out.push('Some items have no cost yet. Record a purchase for them and the estimate fills in.');
  return out.join('\n\n');
}

const AdviceSchema = z.object({
  summary: z.string().describe('2–5 short paragraphs in plain South African English for a family butchery: what to order, why, what extra it gives and what to do with it, and anything to watch. No markdown headings; short bullet lists are fine.'),
});

export async function stockAdvice(plan: Plan, context: { notes?: string | null; recentPurchases: string[] }): Promise<{ text: string; engine: 'claude' | 'rules'; error?: string }> {
  const fallback = rulesAdvice(plan);
  if (!aiAvailable()) return { text: fallback, engine: 'rules' };
  const settings = getSettings().ai;
  try {
    const response = await getClient().messages.parse({
      model: settings.model || 'claude-opus-5',
      max_tokens: 16000,
      system:
        'You help a small family-run farm butchery in South Africa (Terram Farm) plan what stock to buy in. You receive a deterministic plan worked out from open orders and their own cutting yields. Explain it plainly and practically, as an experienced butcher would. Use the numbers given; never invent prices, suppliers or stock. Where the plan leaves a lot of extra of some cut, suggest sensible uses (mince, boerewors, biltong, freezer stock, specials). Point out anything that looks off (e.g. yields that seem unusual, missing weights). Keep it short.',
      messages: [
        {
          role: 'user',
          content: `PLAN\n${planFacts(plan)}\n\nRECENT PURCHASES\n${context.recentPurchases.length ? context.recentPurchases.join('\n') : '(none recorded)'}${context.notes ? `\n\nQUESTION FROM THE FAMILY\n${context.notes.slice(0, 1000)}` : ''}`,
        },
      ],
      output_config: { effort: settings.effort, format: zodOutputFormat(AdviceSchema) },
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) return { text: fallback, engine: 'rules', error: 'The assistant didn’t give a usable answer.' };
    return { text: response.parsed_output.summary.trim(), engine: 'claude' };
  } catch (err) {
    let msg = 'AI request failed';
    if (err instanceof Anthropic.AuthenticationError) msg = 'AI key rejected — check ANTHROPIC_API_KEY';
    else if (err instanceof Anthropic.RateLimitError) msg = 'AI rate limited';
    else if (err instanceof Anthropic.APIConnectionError) msg = 'Could not reach the AI service';
    else if (err instanceof Anthropic.APIError) msg = `AI service error (${err.status})`;
    recordSystemEvent('warning', 'ai', `Stock advice: ${msg}`, err instanceof Error ? err.message : String(err));
    return { text: fallback, engine: 'rules', error: msg };
  }
}

const YieldSchema = z.object({
  rows: z.array(z.object({ product_id: z.string(), pct: z.number().describe('Percent of the piece’s weight that ends up as this product (or as its part, see part)'), part: z.string().nullable().describe('When several products are alternative ways of cutting the same part (the rib as rib-eye or tomahawk; trim as mince or wors), give them the same part name and the same pct: the part’s share. Otherwise null.') })),
  note: z.string().describe('One or two sentences on the assumptions (e.g. bone-in vs boneless, what the remainder is).'),
});

/** Drafts yields for a stock item from the catalogue. Validated here; the family reviews before saving. */
export async function suggestYieldsAI(item: StockItem): Promise<{ rows: { product_id: string; pct: number; part: string | null }[]; note: string } | null> {
  if (!aiAvailable()) return null;
  const products = listProducts().filter((p) => p.active || p.customer_visible);
  const settings = getSettings().ai;
  try {
    const response = await getClient().messages.parse({
      model: settings.model || 'claude-opus-5',
      max_tokens: 16000,
      system:
        'You are an experienced South African butcher. Given a carcass or primal piece and a butchery’s product list, estimate how its weight typically splits into those products when cut for retail. Only use product ids from the list, and only products that really come from this piece. Percentages are of the piece’s weight as bought; counting each part once, together they must stay below 100 (the rest is bone loss, fat and drying). Biltong and droewors are dried weight. Be realistic rather than optimistic.',
      messages: [
        {
          role: 'user',
          content: `PIECE: ${item.name}${item.avg_weight_kg ? ` (about ${item.avg_weight_kg} kg each)` : ''}${item.notes ? `\nNotes: ${item.notes}` : ''}\n\nPRODUCTS\n${products.map((p) => `- id=${p.id} | ${p.canonical_name} | ${p.category}`).join('\n')}`,
        },
      ],
      output_config: { effort: settings.effort, format: zodOutputFormat(YieldSchema) },
    });
    const out = response.parsed_output;
    if (response.stop_reason === 'refusal' || !out) return null;
    const ids = new Set(products.map((p) => p.id));
    const seen = new Set<string>();
    const partPct = new Map<string, number>();
    const rows = out.rows
      .filter((r) => ids.has(r.product_id) && r.pct > 0 && r.pct <= 100 && !seen.has(r.product_id) && seen.add(r.product_id))
      .map((r) => {
        const part = r.part?.trim() || null;
        if (part && !partPct.has(part)) partPct.set(part, r.pct);
        return { product_id: r.product_id, pct: Math.round((part ? partPct.get(part)! : r.pct) * 10) / 10, part };
      });
    const total = rows.filter((r) => !r.part).reduce((s, r) => s + r.pct, 0) + [...partPct.values()].reduce((s, v) => s + v, 0);
    const scaled = total > 98 ? rows.map((r) => ({ ...r, pct: Math.round(((r.pct * 95) / total) * 10) / 10 })) : rows;
    return scaled.length ? { rows: scaled, note: out.note } : null;
  } catch (err) {
    recordSystemEvent('warning', 'ai', 'Couldn’t draft cutting yields', err instanceof Error ? err.message : String(err));
    return null;
  }
}

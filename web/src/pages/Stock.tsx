import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ClipboardCheck,
  Mail,
  PackageCheck,
  Pencil,
  Phone,
  Plus,
  Sparkles,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProducts } from '../components/pickers';
import {
  Badge,
  Button,
  Callout,
  Card,
  cx,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  Segmented,
  Select,
  Sheet,
  Spinner,
  Switch,
  Textarea,
  useConfirm,
  useToast,
} from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { dateTime, formatMoney, shortDate, timeAgo, todayYmd } from '../lib/format';
import { qtyUnit } from '../components/StockNeeds';

/**
 * Stock: what's on hand, what came in and what it cost, who we buy from, and a planner that turns
 * open orders into "what to order" using how each carcass is usually cut. Staff can count and
 * use stock; costs, purchases and suppliers are for managers.
 */

type Tab = 'overview' | 'plan' | 'items' | 'purchases' | 'suppliers';
const KIND_LABEL: Record<string, string> = { carcass: 'Carcasses & quarters', cut: 'Cuts & finished stock', ingredient: 'Spices & ingredients', packaging: 'Packaging', other: 'Other' };
const KIND_ONE: Record<string, string> = { carcass: 'Carcass or quarter', cut: 'Cut / finished stock', ingredient: 'Spice or ingredient', packaging: 'Packaging', other: 'Other' };

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
/** Whole rands for headline numbers, so they fit on a phone. */
const rands = (c: number | null | undefined) => (c == null ? '—' : `R${Math.round(c / 100).toLocaleString('en-ZA')}`);
const weightLabel = (kg: number | null | undefined) => (kg ? `${round(kg, 1).toLocaleString('en-ZA')} kg` : '');
const kgLabel = (n: number) => `${round(n, 1).toLocaleString('en-ZA')} kg`;
const randsToCents = (s: string) => {
  const n = Number(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && s.trim() !== '' ? Math.round(n * 100) : null;
};
const centsToRands = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
const numOrNull = (s: string) => {
  const n = Number(String(s).replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
};

export default function Stock() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true });
  const { data: overview, error, refetch } = useQuery({ queryKey: ['stock', 'overview'], queryFn: () => api.get<any>('/api/stock') });
  const costs = !!overview?.can_see_costs;
  const tabs: { value: Tab; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'plan', label: 'Order planner' },
    { value: 'items', label: 'Stock on hand' },
    ...(costs ? [{ value: 'purchases' as Tab, label: 'Purchases' }] : []),
    { value: 'suppliers', label: 'Suppliers' },
  ];
  return (
    <div className="animate-rise">
      <PageHeader title="Stock" subtitle="What’s in the cold room, what it cost, and what to order for the orders coming up." />
      <div className="-mx-5 mb-6 overflow-x-auto px-5 scrollbar-none sm:mx-0 sm:px-0">
        <Segmented value={tab} onChange={setTab} options={tabs} />
      </div>
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : !overview ? (
        <LoadingBlock rows={5} />
      ) : tab === 'overview' ? (
        <Overview o={overview} go={setTab} />
      ) : tab === 'plan' ? (
        <Planner costs={costs} ai={overview.ai} />
      ) : tab === 'items' ? (
        <Items costs={costs} />
      ) : tab === 'purchases' && costs ? (
        <Purchases categories={overview.categories} />
      ) : (
        <Suppliers costs={costs} />
      )}
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────
function Tile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ochre' }) {
  return (
    <Card className={cx('min-w-0 p-4', tone === 'ochre' && 'border-ochre/40')}>
      <div className="font-display text-[24px] font-semibold leading-none tabular [overflow-wrap:anywhere] sm:text-[30px]">{value}</div>
      <div className="mt-1.5 text-[14px] font-medium text-ink-2">{label}</div>
      {hint && <div className="text-[12.5px] text-ink-3">{hint}</div>}
    </Card>
  );
}

function Overview({ o, go }: { o: any; go: (t: Tab) => void }) {
  const costs = o.can_see_costs;
  const [receiving, setReceiving] = useState<string | null>(null);
  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {costs ? (
          <>
            <Tile label="Spent this month" value={rands(o.spend.this_month_cents)} hint={`Last month ${rands(o.spend.last_month_cents)}`} />
            <Tile label="Last 90 days" value={rands(o.spend.last_90_cents)} hint="All purchases and expenses" />
            <Tile label="Stock value" value={rands(o.stock_value_cents)} hint="At the latest cost of each item" />
          </>
        ) : (
          <Tile label="Items we keep" value={o.item_count} />
        )}
        <Tile label="Running low" value={o.low.length} hint={o.last_count_at ? `Last counted ${timeAgo(o.last_count_at)}` : 'Not counted yet'} tone={o.low.length ? 'ochre' : undefined} />
      </section>

      {!o.last_count_at && (
        <Callout tone="brand" icon={<ClipboardCheck className="size-5" />} title="Start with a stock take" action={<Button size="sm" variant="primary" onClick={() => go('items')}>Count stock</Button>}>
          Count what’s in the cold room, freezers and store once, and every delivery and cut-up after that keeps the numbers up to date.
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="min-w-0">
          <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => go('plan')}>Open planner</Button>}>What the orders need</SectionTitle>
          <PlanSnapshot />
        </section>
        <section className="min-w-0">
          <SectionTitle>Running low · {o.low.length}</SectionTitle>
          {o.low.length ? (
            <Card className="divide-y divide-line">
              {o.low.map((l: any) => (
                <div key={l.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[14px]">
                  <span className="min-w-0 truncate font-medium">{l.name}</span>
                  <span className="shrink-0 tabular text-ochre-soft-ink">{qtyUnit(l.on_hand, l.unit)} <span className="text-ink-3">/ reorder at {qtyUnit(l.reorder_level, l.unit)}</span></span>
                </div>
              ))}
            </Card>
          ) : (
            <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-[14px] text-ink-3">Nothing below its reorder level. Set reorder levels on items to be warned here.</p>
          )}
        </section>
      </div>

      {costs && o.awaiting.length > 0 && (
        <section>
          <SectionTitle>Ordered, waiting to arrive · {o.awaiting.length}</SectionTitle>
          <Card className="divide-y divide-line">
            {o.awaiting.map((p: any) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[14px]">
                <Truck className="size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.supplier_name ?? 'No supplier'} · {formatMoney(p.total_cents)}</div>
                  <div className="truncate text-[13px] text-ink-3">{shortDate(p.ordered_on)} · {p.summary}</div>
                </div>
                <Button size="sm" variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setReceiving(p.id)}>Received</Button>
              </div>
            ))}
          </Card>
        </section>
      )}

      {costs && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="min-w-0">
            <SectionTitle>Spending by month</SectionTitle>
            <MonthBars rows={o.monthly} />
          </section>
          <section className="min-w-0">
            <SectionTitle>Where the money went · last 90 days</SectionTitle>
            <ShareBars rows={o.by_category_90d.map((c: any) => ({ label: c.category, value: c.total }))} empty="No purchases recorded yet." />
            {o.by_supplier_90d.length > 0 && (
              <div className="mt-4">
                <ShareBars rows={o.by_supplier_90d.map((s: any) => ({ label: s.name, value: s.total, hint: `${s.n} order${s.n === 1 ? '' : 's'}` }))} empty="" title="By supplier" />
              </div>
            )}
          </section>
        </div>
      )}
      <PurchaseView id={receiving} onClose={() => setReceiving(null)} />
    </div>
  );
}

function PlanSnapshot() {
  const { data } = useQuery({ queryKey: ['stock', 'plan', 'week'], queryFn: () => api.get<any>('/api/stock/plan?range=week') });
  if (!data) return <Card className="flex h-28 items-center justify-center"><Spinner /></Card>;
  const order = data.sources.filter((s: any) => s.to_order > 0);
  return (
    <Card className="p-4">
      <p className="text-[14px] text-ink-2">{data.order_count ? `${data.order_count} open order${data.order_count === 1 ? '' : 's'} in the next 7 days.` : 'No open orders in the next 7 days.'}</p>
      {order.length ? (
        <ul className="mt-2 space-y-1.5">
          {order.map((s: any) => (
            <li key={s.item_id} className="flex items-baseline justify-between gap-3 text-[15px]">
              <span className="min-w-0 truncate font-medium">{s.name}</span>
              <span className="shrink-0 font-semibold tabular text-brand">Order {qtyUnit(s.to_order, s.unit)}</span>
            </li>
          ))}
        </ul>
      ) : data.order_count ? (
        <p className="mt-2 text-[15px] font-medium text-field-soft-ink">What’s on hand covers them.</p>
      ) : null}
      {data.uncovered.length > 0 && <p className="mt-2 text-[13px] text-ochre-soft-ink">{data.uncovered.length} product{data.uncovered.length === 1 ? ' isn’t' : 's aren’t'} linked to stock yet.</p>}
    </Card>
  );
}

/** Single series, one hue. Hover or tap a bar for the exact amount. */
function MonthBars({ rows: data }: { rows: { month: string; total: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Always show at least the last six months, with empty months as a sliver
  const rows = useMemo(() => {
    if (!data.length) return data;
    const now = todayYmd().slice(0, 7);
    const first = data[0].month;
    const out: { month: string; total: number }[] = [];
    const d = new Date(`${now}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 5);
    const start = first < d.toISOString().slice(0, 7) ? first : d.toISOString().slice(0, 7);
    const cur = new Date(`${start}-01T00:00:00Z`);
    while (cur.toISOString().slice(0, 7) <= now) {
      const m = cur.toISOString().slice(0, 7);
      out.push({ month: m, total: data.find((r) => r.month === m)?.total ?? 0 });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return out;
  }, [data]);
  if (!rows.length) return <p className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-3">Record purchases to see spending by month.</p>;
  const max = Math.max(...rows.map((r) => r.total), 1);
  const label = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const h = hover != null ? rows[hover] : rows[rows.length - 1];
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 h-5 text-[13px] text-ink-2" aria-live="polite"><b className="text-ink">{label(h.month)}</b> · {formatMoney(h.total)}</div>
      <div className="flex h-36 items-end gap-[2px] border-b border-line" role="img" aria-label="Spending per month">
        {rows.map((r, i) => (
          <button key={r.month} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => setHover(i)} onMouseLeave={() => setHover(null)} className="flex h-full min-w-0 flex-1 items-end focus:outline-none" aria-label={`${label(r.month)}: ${formatMoney(r.total)}`}>
            <span className={cx('block w-full rounded-t-[4px] transition-colors', hover === i ? 'bg-brand' : 'bg-brand/60')} style={{ height: `${r.total ? Math.max(3, (r.total / max) * 100) : 1}%` }} />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-3"><span>{label(rows[0].month)}</span><span>{label(rows[rows.length - 1].month)}</span></div>
    </Card>
  );
}

function ShareBars({ rows, empty, title }: { rows: { label: string; value: number; hint?: string }[]; empty: string; title?: string }) {
  if (!rows.length) return empty ? <p className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-3">{empty}</p> : null;
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <Card className="space-y-3 p-4">
      {title && <div className="text-[13px] font-semibold text-ink-2">{title}</div>}
      {rows.map((r) => (
        <div key={r.label} className="text-[14px]">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-medium">{r.label}{r.hint && <span className="font-normal text-ink-3"> · {r.hint}</span>}</span>
            <span className="shrink-0 tabular text-ink-2">{formatMoney(r.value)} <span className="text-ink-3">· {Math.round((r.value / total) * 100)}%</span></span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-sunken"><div className="h-2 rounded-full bg-brand/70" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} /></div>
        </div>
      ))}
    </Card>
  );
}

// ── Planner ────────────────────────────────────────────────
function Planner({ costs, ai }: { costs: boolean; ai: boolean }) {
  const [range, setRange] = useState<'week' | 'fortnight' | 'month' | 'all'>('week');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['stock', 'plan', range], queryFn: () => api.get<any>(`/api/stock/plan${qs({ range })}`) });
  const [advice, setAdvice] = useState<{ text: string; engine: string; error?: string } | null>(null);
  const [question, setQuestion] = useState('');
  const [ordering, setOrdering] = useState<any[] | null>(null);
  const toast = useToast();
  const ask = useMutation({
    mutationFn: () => api.post<any>('/api/stock/plan/advice', { range, question: question.trim() || null }),
    onSuccess: (r) => setAdvice(r),
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Couldn’t get advice.' }),
  });
  useEffect(() => setAdvice(null), [range]);
  const toOrder = (data?.sources ?? []).filter((s: any) => s.to_order > 0);
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-5 overflow-x-auto px-5 scrollbar-none sm:mx-0 sm:px-0">
          <Segmented value={range} onChange={setRange} options={[{ value: 'week', label: 'Next 7 days' }, { value: 'fortnight', label: '14 days' }, { value: 'month', label: '30 days' }, { value: 'all', label: 'All open orders' }]} />
        </div>
        {costs && toOrder.length > 0 && (
          <Button variant="primary" icon={<Truck className="size-4" />} onClick={() => setOrdering(toOrder.map((s: any) => ({ item_id: s.item_id, qty: String(s.to_order) })))}>Turn into a stock order</Button>
        )}
      </div>
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading || !data ? (
        <LoadingBlock />
      ) : !data.order_count ? (
        <EmptyState icon={<Boxes className="size-6" />} title="No open orders to plan for">When orders come in for these dates, this shows what they need and what to order.</EmptyState>
      ) : (
        <>
          <Card className="p-5">
            <div className="text-[13px] font-semibold uppercase tracking-[0.08em] text-ink-3">{data.label} · {data.order_count} open order{data.order_count === 1 ? '' : 's'}</div>
            {toOrder.length ? (
              <p className="mt-1.5 font-display text-[22px] font-semibold leading-snug sm:text-[26px]">
                Order {toOrder.map((s: any, i: number) => <span key={s.item_id}>{i > 0 && (i === toOrder.length - 1 ? ' and ' : ', ')}<span className="text-brand">{qtyUnit(s.to_order, s.unit)} {s.unit === 'kg' ? `of ${s.name.toLowerCase()}` : s.name.toLowerCase() + (s.to_order === 1 ? '' : 's')}</span></span>)}.
              </p>
            ) : data.sources.length ? (
              <p className="mt-1.5 font-display text-[22px] font-semibold text-field-soft-ink">What’s on hand covers these orders.</p>
            ) : (
              <p className="mt-1.5 text-[15px] text-ink-2">None of the products on these orders are linked to stock yet.</p>
            )}
            {costs && data.est_total_cents > 0 && <p className="mt-1 text-[14px] text-ink-2">About {formatMoney(data.est_total_cents)} at your latest costs{data.missing_costs ? ' (some items have no cost yet)' : ''}.</p>}
            <p className="mt-3 text-[13px] text-ink-3">Worked out from what’s still to cut on these orders, less what’s on hand, using each carcass’s cutting yields. Adjust the yields under Stock on hand as you learn your own.</p>
          </Card>

          {data.uncovered.length > 0 && (
            <Callout tone="ochre" icon={<AlertTriangle className="size-5" />} title="Not linked to any stock yet">
              {data.uncovered.map((u: any) => `${u.product_name} (${kgLabel(u.need_kg)})`).join(', ')}. {data.uncovered.some((u: any) => u.reason === 'no_weight') ? 'A carcass it comes from has no average weight yet. ' : ''}Add {data.uncovered.length === 1 ? 'it' : 'them'} to a carcass’s yields under Stock on hand so the planner can include {data.uncovered.length === 1 ? 'it' : 'them'}.
            </Callout>
          )}

          {data.sources.length > 0 && (
            <section>
              <SectionTitle>By carcass and stock item</SectionTitle>
              <div className="grid gap-4 lg:grid-cols-2">
                {data.sources.map((s: any) => <SourceCard key={s.item_id} s={s} costs={costs} />)}
              </div>
            </section>
          )}

          <section>
            <SectionTitle>Still to cut on these orders</SectionTitle>
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[14px]">
                <thead className="bg-surface-2 text-left text-[12px] uppercase tracking-[0.06em] text-ink-3">
                  <tr><th className="px-4 py-2 font-semibold">Product</th><th className="px-4 py-2 text-right font-semibold">Needed</th><th className="px-4 py-2 text-right font-semibold">From stock</th><th className="px-4 py-2 text-right font-semibold">Orders</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.demand.map((d: any) => (
                    <tr key={d.product_id}>
                      <td className="px-4 py-2.5"><div className="font-medium">{d.product_name}</div><div className="text-[12px] text-ink-3">{d.category}</div></td>
                      <td className="px-4 py-2.5 text-right tabular">{d.need_kg ? kgLabel(d.need_kg) : ''}{d.unknown_pieces ? <div className="text-[12px] text-ink-3">{d.need_kg ? '+ ' : ''}{d.unknown_pieces} piece{d.unknown_pieces === 1 ? '' : 's'}</div> : null}</td>
                      <td className="px-4 py-2.5 text-right tabular text-ink-2">{d.from_stock_kg ? kgLabel(d.from_stock_kg) : '—'}</td>
                      <td className="px-4 py-2.5 text-right tabular text-ink-2">{d.orders}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>

          <section>
            <SectionTitle>Ask the assistant</SectionTitle>
            <Card className="space-y-3 p-4">
              <p className="text-[14px] text-ink-2">{ai ? 'Get a plain-language read of this plan: what to order, what extra it gives and what to do with it.' : 'Get a plain-language summary of this plan. (The AI assistant is off, so this is worked out from the numbers.)'}</p>
              <Textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Anything specific? e.g. “We want to make 20 kg of biltong this month too.”" maxLength={1000} />
              <Button icon={<Sparkles className="size-4" />} loading={ask.isPending} onClick={() => ask.mutate()}>Explain this plan</Button>
              {advice && (
                <div className="rounded-xl bg-brand-soft/60 px-4 py-3 text-[14.5px] leading-relaxed text-ink">
                  <div className="whitespace-pre-line">{advice.text}</div>
                  <div className="mt-2 text-[12px] text-ink-3">{advice.engine === 'claude' ? 'From the AI assistant. Check it against what you know.' : `Worked out from the numbers${advice.error ? ` (${advice.error})` : ''}.`}</div>
                </div>
              )}
            </Card>
          </section>
        </>
      )}
      <PurchaseSheet open={!!ordering} onClose={() => setOrdering(null)} prefill={ordering ?? undefined} />
    </div>
  );
}

function SourceCard({ s, costs }: { s: any; costs: boolean }) {
  const [open, setOpen] = useState(false);
  const extras = s.outputs.filter((o: any) => o.extra_kg > 0.5);
  return (
    <Card className="min-w-0 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[16px] font-semibold">{s.name}</div>
          <div className="text-[13px] text-ink-3">{s.unit === 'kg' ? 'By weight' : s.avg_weight_kg ? `About ${weightLabel(s.avg_weight_kg)} each` : 'No average weight yet'}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cx('font-display text-[26px] font-semibold leading-none tabular', s.to_order > 0 ? 'text-brand' : 'text-field-soft-ink')}>{s.to_order > 0 ? qtyUnit(s.to_order, s.unit) : '✓'}</div>
          <div className="text-[12px] text-ink-3">{s.to_order > 0 ? 'to order' : 'covered'}</div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-[13px]">
        <div className="rounded-xl bg-surface-2 px-2 py-2"><dt className="text-ink-3">Needed</dt><dd className="font-semibold tabular">{qtyUnit(s.units_needed, s.unit)}</dd></div>
        <div className="rounded-xl bg-surface-2 px-2 py-2"><dt className="text-ink-3">On hand</dt><dd className="font-semibold tabular">{qtyUnit(s.on_hand, s.unit)}</dd></div>
        <div className="rounded-xl bg-surface-2 px-2 py-2"><dt className="text-ink-3">{costs ? 'Est. cost' : 'To order'}</dt><dd className="font-semibold tabular">{costs ? (s.to_order ? formatMoney(s.est_cost_cents) : '—') : qtyUnit(s.to_order, s.unit)}</dd></div>
      </dl>
      {s.driven_by && <p className="mt-3 text-[13.5px] text-ink-2"><b>{s.driven_by.product_name}</b> sets the number: {kgLabel(s.driven_by.need_kg)} needed.</p>}
      {s.direct_products.length > 0 && <p className="mt-1 text-[13.5px] text-ink-2">Sold whole: {s.direct_products.map((d: any) => `${d.product_name} (${kgLabel(d.need_kg)})`).join(', ')}.</p>}
      {extras.length > 0 && <p className="mt-1 text-[13.5px] text-ink-2">Also gives extra {extras.slice(0, 3).map((o: any) => `${o.product_name.toLowerCase()} (${kgLabel(o.extra_kg)})`).join(', ')}{extras.length > 3 ? ` and ${extras.length - 3} more` : ''}.</p>}
      {s.outputs.length > 0 && (
        <>
          <button onClick={() => setOpen(!open)} className="mt-3 inline-flex items-center gap-1 text-[13.5px] font-medium text-brand">
            <ChevronDown className={cx('size-4 transition', open && 'rotate-180')} /> {open ? 'Hide' : 'Show'} what {qtyUnit(s.for_cuts, s.unit)} {s.unit === 'kg' ? '' : s.for_cuts === 1 ? 'piece gives' : 'pieces give'}
          </button>
          {open && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[340px] text-[13px]">
                <thead className="text-left text-[11.5px] uppercase tracking-[0.06em] text-ink-3"><tr><th className="py-1 font-semibold">Product</th><th className="py-1 text-right font-semibold">Gives</th><th className="py-1 text-right font-semibold">Ordered</th><th className="py-1 text-right font-semibold">Extra</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {s.outputs.map((o: any) => (
                    <tr key={o.key}>
                      <td className="py-1.5 pr-2">{o.product_name} <span className="text-ink-3">· {o.pct}%</span>{o.members?.length > 0 && <div className="text-[11.5px] text-ink-3">{o.members.join(' / ')}</div>}</td>
                      <td className="py-1.5 text-right tabular">{kgLabel(o.yield_kg)}</td>
                      <td className="py-1.5 text-right tabular text-ink-2">{o.need_kg ? kgLabel(o.need_kg) : '—'}</td>
                      <td className={cx('py-1.5 text-right tabular', o.extra_kg < -0.05 ? 'text-danger' : 'text-ink-2')}>{o.extra_kg < -0.05 ? `short ${kgLabel(-o.extra_kg)}` : kgLabel(o.extra_kg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ── Stock on hand ──────────────────────────────────────────
function useItems() {
  return useQuery({ queryKey: ['stock', 'items'], queryFn: () => api.get<{ items: any[] }>('/api/stock/items') });
}
function useSuppliers() {
  return useQuery({ queryKey: ['stock', 'suppliers'], queryFn: () => api.get<{ suppliers: any[] }>('/api/stock/suppliers') });
}

function Items({ costs }: { costs: boolean }) {
  const can = useCan();
  const { data, isLoading, error, refetch } = useItems();
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [taking, setTaking] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const items = (data?.items ?? []).filter((i) => showInactive || i.active);
  const kinds = [...new Set(items.map((i) => i.kind))];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {can('stock.write') && <Button variant="primary" icon={<ClipboardCheck className="size-4" />} onClick={() => setTaking(true)}>Stock take</Button>}
        {can('stock.write') && <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add item</Button>}
        {(data?.items ?? []).some((i) => !i.active) && <Button variant="ghost" size="sm" onClick={() => setShowInactive(!showInactive)}>{showInactive ? 'Hide' : 'Show'} items no longer kept</Button>}
      </div>
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock />
      ) : !items.length ? (
        <EmptyState icon={<Boxes className="size-6" />} title="No stock items yet" action={can('stock.write') && <Button variant="primary" onClick={() => setAdding(true)}>Add an item</Button>}>Add what you buy in and keep: quarters, lambs, spices, casings, bags.</EmptyState>
      ) : (
        kinds.map((k) => (
          <section key={k}>
            <SectionTitle>{KIND_LABEL[k] ?? k}</SectionTitle>
            <Card className="divide-y divide-line overflow-hidden">
              {items.filter((i) => i.kind === k).map((i) => (
                <button key={i.id} onClick={() => setOpenId(i.id)} className={cx('flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2', !i.active && 'opacity-60')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{i.name}</span>
                      {i.low && <Badge size="sm" tone="ochre">Running low</Badge>}
                      {i.kind === 'carcass' && !i.yield_count && <Badge size="sm" tone="slate">No yields</Badge>}
                    </div>
                    <div className="truncate text-[13px] text-ink-3">
                      {[i.supplier_name, i.unit !== 'kg' && i.avg_weight_kg ? `≈ ${weightLabel(i.avg_weight_kg)} each` : null, i.product_name ? `Is: ${i.product_name}` : null, i.kind === 'carcass' && i.yield_count ? `${i.yield_count} cuts` : null].filter(Boolean).join(' · ') || (i.last_counted_at ? `Counted ${timeAgo(i.last_counted_at)}` : 'Not counted yet')}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-display text-[20px] font-semibold tabular">{qtyUnit(i.on_hand, i.unit)}</div>
                    {costs && i.value_cents != null && <div className="text-[12px] text-ink-3">{formatMoney(i.value_cents)}</div>}
                  </div>
                </button>
              ))}
            </Card>
          </section>
        ))
      )}
      <ItemSheet id={openId} onClose={() => setOpenId(null)} costs={costs} />
      <ItemForm open={adding} onClose={() => setAdding(false)} costs={costs} />
      <StockTakeSheet open={taking} onClose={() => setTaking(false)} items={(data?.items ?? []).filter((i) => i.active)} />
    </div>
  );
}

function ItemForm({ open, onClose, item, costs }: { open: boolean; onClose: () => void; item?: any; costs: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: products } = useProducts();
  const { data: sup } = useSuppliers();
  const [v, setV] = useState<any>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setV({
      name: item?.name ?? '',
      kind: item?.kind ?? 'carcass',
      unit: item?.unit ?? 'each',
      avg_weight_kg: item?.avg_weight_kg ?? '',
      reorder_level: item?.reorder_level ?? '',
      cost: centsToRands(item?.cost_cents),
      supplier_id: item?.supplier_id ?? '',
      product_id: item?.product_id ?? '',
      notes: item?.notes ?? '',
      active: item ? !!item.active : true,
      on_hand: '',
    });
  }, [open, item]);
  const set = (k: string, val: any) => setV((s: any) => ({ ...s, [k]: val }));
  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        name: v.name,
        kind: v.kind,
        unit: v.unit,
        avg_weight_kg: v.unit === 'kg' ? null : numOrNull(String(v.avg_weight_kg)),
        reorder_level: numOrNull(String(v.reorder_level)),
        supplier_id: v.supplier_id || null,
        product_id: v.product_id || null,
        notes: v.notes || null,
        active: v.active,
      };
      if (costs) body.cost_cents = randsToCents(String(v.cost));
      if (!item && numOrNull(String(v.on_hand)) != null) body.on_hand = numOrNull(String(v.on_hand));
      return item ? api.patch(`/api/stock/items/${item.id}`, body) : api.post('/api/stock/items', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock'] });
      toast({ tone: 'success', title: item ? 'Item updated' : 'Item added' });
      onClose();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Sheet open={open} onClose={onClose} title={item ? `Edit ${item.name}` : 'New stock item'} footer={<Button variant="primary" size="lg" full disabled={!v.name?.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Name"><Input big value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Beef hindquarter, Boerewors spice" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What is it">
            <Select value={v.kind} onChange={(e) => set('kind', e.target.value)}>{Object.entries(KIND_ONE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </Field>
          <Field label="Counted in" hint={item?.on_hand ? 'Count it down to zero to change this.' : undefined}>
            <Select value={v.unit} onChange={(e) => set('unit', e.target.value)} disabled={!!item?.on_hand}><option value="each">Pieces (each)</option><option value="kg">Kilograms</option><option value="pack">Packs</option></Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {v.unit !== 'kg' && <Field label="Average weight (kg)" optional hint="For planning, e.g. 85 for a hindquarter."><Input inputMode="decimal" value={v.avg_weight_kg ?? ''} onChange={(e) => set('avg_weight_kg', e.target.value.replace(/[^\d.,]/g, ''))} /></Field>}
          <Field label="Warn me below" optional hint="Shows as “Running low”."><Input inputMode="decimal" value={v.reorder_level ?? ''} onChange={(e) => set('reorder_level', e.target.value.replace(/[^\d.,]/g, ''))} /></Field>
          {costs && <Field label={`Cost per ${v.unit === 'kg' ? 'kg' : v.unit === 'pack' ? 'pack' : 'piece'} (R)`} optional hint="Updated automatically when you receive a purchase."><Input inputMode="decimal" value={v.cost ?? ''} onChange={(e) => set('cost', e.target.value.replace(/[^\d.,]/g, ''))} /></Field>}
          {!item && <Field label="On hand now" optional><Input inputMode="decimal" value={v.on_hand ?? ''} onChange={(e) => set('on_hand', e.target.value.replace(/[^\d.,]/g, ''))} /></Field>}
        </div>
        <Field label="Usual supplier" optional>
          <Select value={v.supplier_id} onChange={(e) => set('supplier_id', e.target.value)}><option value="">None</option>{(sup?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        </Field>
        {v.kind !== 'ingredient' && v.kind !== 'packaging' && (
          <Field label="This stock is the product" optional hint="For finished stock, like frozen rump or a whole lamb sold whole. Orders for that product use this stock first.">
            <Select value={v.product_id} onChange={(e) => set('product_id', e.target.value)}><option value="">Not a product on its own</option>{(products?.products ?? []).map((p) => <option key={p.id} value={p.id}>{p.canonical_name} · {p.category}</option>)}</Select>
          </Field>
        )}
        <Field label="Notes" optional><Textarea rows={2} value={v.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
        {item && <Switch checked={!!v.active} onChange={(x) => set('active', x)} label="Still keep this" description="Switch off for things you no longer buy. History is kept." />}
        {err && <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink">{err}</p>}
      </div>
    </Sheet>
  );
}

const MOVES: { kind: 'received' | 'used' | 'waste' | 'count'; label: string; hint: string }[] = [
  { kind: 'received', label: 'Received', hint: 'Add to stock (a delivery without a recorded purchase).' },
  { kind: 'used', label: 'Used / cut up', hint: 'Take off stock, e.g. 1 hindquarter cut up today.' },
  { kind: 'waste', label: 'Waste', hint: 'Spoiled, trimmed off or thrown away.' },
  { kind: 'count', label: 'Count', hint: 'Set what’s actually there now.' },
];

function ItemSheet({ id, onClose, costs }: { id: string | null; onClose: () => void; costs: boolean }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data } = useQuery({ queryKey: ['stock', 'item', id], queryFn: () => api.get<any>(`/api/stock/items/${id}`), enabled: !!id });
  const [editing, setEditing] = useState(false);
  const [move, setMove] = useState<(typeof MOVES)[number]['kind']>('used');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setQty(''); setNote(''); setMove('used'); }, [id]);
  const it = data?.item;
  const doMove = useMutation({
    mutationFn: () => api.post<any>(`/api/stock/items/${id}/move`, { kind: move, qty: Number(qty.replace(',', '.')), note: note || null }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['stock'] });
      toast({ tone: 'success', title: `Now ${qtyUnit(r.balance, it.unit)} on hand` });
      setQty('');
      setNote('');
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' }),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/stock/items/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stock'] }); toast({ tone: 'success', title: 'Item deleted' }); onClose(); },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not delete.' }),
  });
  const qtyOk = qty.trim() !== '' && Number.isFinite(Number(qty.replace(',', '.'))) && Number(qty.replace(',', '.')) >= 0;
  return (
    <Sheet open={!!id} onClose={onClose} width="lg" title={it?.name ?? 'Stock item'} subtitle={it ? `${KIND_ONE[it.kind]} · ${qtyUnit(it.on_hand, it.unit)}${it.unit === 'each' ? (it.on_hand === 1 ? ' piece' : ' pieces') : ''} on hand` : undefined}>
      {!data ? (
        <LoadingBlock rows={3} />
      ) : (
        <div className="space-y-7">
          {can('stock.write') && (
            <section>
              <SectionTitle>Update stock</SectionTitle>
              <Card className="space-y-3 p-4">
                <div className="-mx-1 overflow-x-auto px-1 scrollbar-none"><Segmented value={move} onChange={setMove} options={MOVES.map((m) => ({ value: m.kind, label: m.label }))} /></div>
                <p className="text-[13px] text-ink-3">{MOVES.find((m) => m.kind === move)?.hint}</p>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={move === 'count' ? `Counted (${it.unit === 'each' ? 'pieces' : it.unit})` : `How much (${it.unit === 'each' ? 'pieces' : it.unit})`} className="w-40"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.,]/g, ''))} /></Field>
                  <Field label="Note" optional className="min-w-40 flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={move === 'used' ? 'e.g. for Friday’s orders' : ''} /></Field>
                  <Button variant="primary" disabled={!qtyOk} loading={doMove.isPending} onClick={() => doMove.mutate()}>Save</Button>
                </div>
              </Card>
            </section>
          )}

          {it.kind === 'carcass' || data.yields.length > 0 ? <YieldEditor item={it} yields={data.yields} template={data.template} costs={costs} canEdit={can('stock.write')} /> : null}

          <section>
            <SectionTitle>Details</SectionTitle>
            <Card className="divide-y divide-line px-4 text-[14px]">
              <Row label="Counted in">{it.unit === 'each' ? 'Pieces' : it.unit === 'kg' ? 'Kilograms' : 'Packs'}</Row>
              {it.unit !== 'kg' && <Row label="Average weight">{it.avg_weight_kg ? weightLabel(it.avg_weight_kg) : '—'}</Row>}
              <Row label="Warn me below">{it.reorder_level != null ? qtyUnit(it.reorder_level, it.unit) : '—'}</Row>
              {costs && <Row label="Latest cost">{it.cost_cents != null ? `${formatMoney(it.cost_cents)} per ${it.unit === 'each' ? 'piece' : it.unit}` : '—'}</Row>}
              {it.notes && <Row label="Notes">{it.notes}</Row>}
            </Card>
            <div className="mt-3 flex flex-wrap gap-2">
              {can('stock.write') && <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>Edit</Button>}
              {can('stock.costs') && (
                <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} loading={remove.isPending} onClick={async () => { if (await confirm.ask({ title: `Delete ${it.name}?`, body: 'Its stock history and cutting yields go with it. Purchases stay, without the link. To stop using it but keep the history, switch off “Still keep this” instead.', confirm: 'Delete', tone: 'danger' })) remove.mutate(); }}>Delete</Button>
              )}
            </div>
          </section>

          {costs && data.purchases.length > 0 && (
            <section>
              <SectionTitle>Bought</SectionTitle>
              <Card className="divide-y divide-line text-[14px]">
                {data.purchases.map((p: any) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0"><div className="truncate font-medium">{p.supplier_name ?? 'No supplier'}</div><div className="text-[12.5px] text-ink-3">{shortDate(p.ordered_on)} · {qtyUnit(p.qty, it.unit)}{p.weight_kg && it.unit !== 'kg' ? ` · ${p.weight_kg} kg` : ''}{p.status === 'ordered' ? ' · not received yet' : ''}</div></div>
                    <div className="shrink-0 text-right tabular"><div className="font-medium">{formatMoney(p.total_cents)}</div><div className="text-[12px] text-ink-3">{formatMoney(p.unit_cost_cents)}/{p.cost_per === 'kg' ? 'kg' : it.unit === 'each' ? 'piece' : it.unit}</div></div>
                  </div>
                ))}
              </Card>
            </section>
          )}

          <section>
            <SectionTitle>History</SectionTitle>
            {data.movements.length ? (
              <Card className="divide-y divide-line text-[14px]">
                {data.movements.map((m: any) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0"><div className="font-medium">{MOVE_LABEL[m.kind]}{m.note ? <span className="font-normal text-ink-2"> · {m.note}</span> : null}</div><div className="text-[12.5px] text-ink-3">{dateTime(m.created_at)}{m.by_name ? ` · ${m.by_name}` : ''}</div></div>
                    <div className="shrink-0 text-right tabular"><div className={cx('font-medium', m.qty < 0 ? 'text-ink-2' : 'text-field-soft-ink')}>{m.qty > 0 ? '+' : ''}{qtyUnit(m.qty, it.unit)}</div><div className="text-[12px] text-ink-3">→ {qtyUnit(m.balance, it.unit)}</div></div>
                  </div>
                ))}
              </Card>
            ) : <p className="text-[14px] text-ink-3">No changes recorded yet.</p>}
          </section>
        </div>
      )}
      {it && <ItemForm open={editing} onClose={() => setEditing(false)} item={it} costs={costs} />}
      {confirm.node}
    </Sheet>
  );
}
const MOVE_LABEL: Record<string, string> = { received: 'Received', used: 'Used', count: 'Counted', waste: 'Waste', adjust: 'Correction' };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-start justify-between gap-4 py-2.5"><span className="shrink-0 text-ink-3">{label}</span><span className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{children}</span></div>;
}

interface YieldEntry { part: string | null; pct: string; products: string[] }

/** Yields as the family thinks of them: single cuts, and parts (the rib) that can be cut several ways. */
function toEntries(rows: { product_id: string; pct: number; part?: string | null }[]): YieldEntry[] {
  const out: YieldEntry[] = [];
  for (const r of rows) {
    const g = r.part ? out.find((e) => e.part?.toLowerCase() === r.part!.toLowerCase()) : null;
    if (g) g.products.push(r.product_id);
    else out.push({ part: r.part ?? null, pct: String(r.pct), products: [r.product_id] });
  }
  return out;
}

function YieldEditor({ item, yields, template, costs, canEdit }: { item: any; yields: any[]; template: string | null; costs: boolean; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: products } = useProducts();
  const byId = useMemo(() => new Map((products?.products ?? []).map((p) => [p.id, p])), [products]);
  const [entries, setEntries] = useState<YieldEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const reset = () => { setEntries(toEntries(yields)); setDirty(false); setNote(null); };
  useEffect(reset, [yields]);
  const per = item.unit === 'kg' ? 1 : item.avg_weight_kg ?? null;
  const pctOf = (e: YieldEntry) => Number(e.pct.replace(',', '.')) || 0;
  const total = entries.reduce((s, e) => s + pctOf(e), 0);
  const worth = per
    ? entries.reduce((s, e) => {
        const prices = e.products.map((pid) => byId.get(pid)).filter((p) => p?.price_unit === 'kg' && p.price_cents).map((p) => p!.price_cents!);
        return s + (prices.length ? ((per * pctOf(e)) / 100) * (prices.reduce((a, b) => a + b, 0) / prices.length) : 0);
      }, 0)
    : 0;
  const rows = entries.flatMap((e) => e.products.filter(Boolean).map((pid) => ({ product_id: pid, pct: pctOf(e), part: e.part?.trim() || null })));
  const invalid = total > 100.001 || entries.some((e) => pctOf(e) <= 0 || (e.part !== null && !e.part.trim()) || !e.products.some(Boolean)) || new Set(rows.map((r) => r.product_id)).size !== rows.length;
  const save = useMutation({
    mutationFn: () => api.put(`/api/stock/items/${item.id}/yields`, { rows }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stock'] }); toast({ tone: 'success', title: 'Cutting yields saved' }); setDirty(false); setNote(null); },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' }),
  });
  const suggest = useMutation({
    mutationFn: () => api.post<any>(`/api/stock/items/${item.id}/suggest-yields`, {}),
    onSuccess: (r) => {
      if (!r.rows.length) { toast({ tone: 'info', title: 'No suggestion for this item', body: r.note }); return; }
      setEntries(toEntries(r.rows));
      setDirty(true);
      setNote(`${r.source === 'assistant' ? 'Drafted by the AI assistant' : 'Typical figures'}: ${r.note} Check them, then save.`);
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not get a suggestion.' }),
  });
  const upd = (i: number, patch: Partial<YieldEntry>) => { setEntries(entries.map((e, j) => (j === i ? { ...e, ...patch } : e))); setDirty(true); };
  const productSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={!canEdit} aria-label={label} className="h-9">
      <option value="">Choose a product…</option>
      {(products?.products ?? []).map((x) => <option key={x.id} value={x.id}>{x.canonical_name}</option>)}
    </Select>
  );
  const pctInput = (e: YieldEntry, i: number) => (
    <div className="relative">
      <Input value={e.pct} onChange={(ev) => upd(i, { pct: ev.target.value.replace(/[^\d.,]/g, '') })} disabled={!canEdit} inputMode="decimal" className="h-9 pr-6 text-right" aria-label={e.part ? `${e.part} percent` : 'Percent'} />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[13px] text-ink-3">%</span>
    </div>
  );
  const kgCell = (e: YieldEntry) => <span className="w-14 shrink-0 text-right text-[12.5px] tabular text-ink-3">{per ? kgLabel((per * pctOf(e)) / 100) : ''}</span>;
  const removeBtn = (onClick: () => void, label: string) => canEdit && <button type="button" onClick={onClick} className="shrink-0 rounded-lg p-1.5 text-ink-3 hover:bg-sunken" aria-label={label}><X className="size-4" /></button>;
  return (
    <section>
      <SectionTitle action={canEdit && <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} loading={suggest.isPending} onClick={() => suggest.mutate()}>{entries.length ? 'Suggest again' : template ? 'Fill in typical yields' : 'Suggest yields'}</Button>}>How it’s cut</SectionTitle>
      <p className="-mt-1 mb-3 text-[13.5px] text-ink-3">What share of {item.unit === 'kg' ? 'each kg' : `one ${item.name.toLowerCase()}${per ? ` (≈ ${weightLabel(per)})` : ''}`} becomes each product. Cuts that come off the same part, like the rib as rib-eye or tomahawk, share that part. The planner uses this to work out how many to order. Weigh a few of your own and adjust.</p>
      {note && <Callout tone="brand" className="mb-3">{note}</Callout>}
      <Card className="p-3">
        {entries.length === 0 && <p className="px-1 py-3 text-[14px] text-ink-3">No products yet.</p>}
        <div className="space-y-2">
          {entries.map((e, i) =>
            e.part === null ? (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">{productSelect(e.products[0] ?? '', (v) => upd(i, { products: [v] }), 'Product')}</div>
                <div className="w-[76px] shrink-0">{pctInput(e, i)}</div>
                {kgCell(e)}
                {removeBtn(() => { setEntries(entries.filter((_, j) => j !== i)); setDirty(true); }, 'Remove')}
              </div>
            ) : (
              <div key={i} className="rounded-xl border border-line bg-surface-2 p-2">
                <div className="flex items-center gap-2">
                  <Input value={e.part} onChange={(ev) => upd(i, { part: ev.target.value })} disabled={!canEdit} placeholder="Part, e.g. Rib" className="h-9 min-w-0 flex-1 font-semibold" aria-label="Part name" />
                  <div className="w-[76px] shrink-0">{pctInput(e, i)}</div>
                  {kgCell(e)}
                  {removeBtn(() => { setEntries(entries.filter((_, j) => j !== i)); setDirty(true); }, 'Remove part')}
                </div>
                <div className="mt-2 space-y-1.5 border-l-2 border-line-strong pl-3">
                  <div className="text-[12px] text-ink-3">Can be cut as:</div>
                  {e.products.map((pid, k) => (
                    <div key={k} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">{productSelect(pid, (v) => upd(i, { products: e.products.map((x, m) => (m === k ? v : x)) }), `${e.part || 'Part'} product`)}</div>
                      {e.products.length > 1 && removeBtn(() => upd(i, { products: e.products.filter((_, m) => m !== k) }), 'Remove cut')}
                    </div>
                  ))}
                  {canEdit && <button type="button" onClick={() => upd(i, { products: [...e.products, ''] })} className="text-[13px] font-medium text-brand hover:underline">+ Another way to cut it</button>}
                </div>
              </div>
            ),
          )}
        </div>
        {canEdit && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            <button type="button" onClick={() => { setEntries([...entries, { part: null, pct: '', products: [''] }]); setDirty(true); }} className="text-[13.5px] font-medium text-brand hover:underline">+ Add a product</button>
            <button type="button" onClick={() => { setEntries([...entries, { part: '', pct: '', products: ['', ''] }]); setDirty(true); }} className="text-[13.5px] font-medium text-brand hover:underline">+ Add a part cut several ways</button>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[13.5px]">
          <span className={cx(total > 100.001 ? 'font-semibold text-danger' : 'text-ink-2')}>
            Adds up to <b className="tabular">{round(total, 1)}%</b>{total <= 100 ? ` · ${round(100 - total, 1)}% bone, fat, trim and loss` : ' — more than the whole piece'}
          </span>
          {costs && per && worth > 0 && <span className="text-ink-2">Sells for about <b>{rands(worth)}</b>{item.cost_cents ? <> · costs {rands(item.unit === 'kg' ? item.cost_cents : item.cost_cents)}</> : null}</span>}
        </div>
      </Card>
      {canEdit && dirty && (
        <div className="mt-3 flex gap-2">
          <Button variant="primary" loading={save.isPending} disabled={invalid} onClick={() => save.mutate()}>Save yields</Button>
          <Button variant="ghost" onClick={reset}>Undo changes</Button>
        </div>
      )}
    </section>
  );
}

function StockTakeSheet({ open, onClose, items }: { open: boolean; onClose: () => void; items: any[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  useEffect(() => { if (open) { setCounts({}); setNote(''); } }, [open]);
  const filled = Object.entries(counts).filter(([, v]) => v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.'))));
  const save = useMutation({
    mutationFn: () => api.post<any>('/api/stock/take', { counts: filled.map(([item_id, v]) => ({ item_id, counted: Number(v.replace(',', '.')) })), note: note || null }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['stock'] }); toast({ tone: 'success', title: `Stock take saved`, body: `${r.counted} counted, ${r.changed} changed.` }); onClose(); },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' }),
  });
  const kinds = [...new Set(items.map((i) => i.kind))];
  return (
    <Sheet open={open} onClose={onClose} width="lg" title="Stock take" subtitle="Type what you count. Leave blank anything you didn’t count." footer={<Button variant="primary" size="lg" full disabled={!filled.length} loading={save.isPending} onClick={() => save.mutate()}>Save {filled.length || ''} count{filled.length === 1 ? '' : 's'}</Button>}>
      <div className="space-y-6">
        {kinds.map((k) => (
          <section key={k}>
            <SectionTitle>{KIND_LABEL[k]}</SectionTitle>
            <Card className="divide-y divide-line">
              {items.filter((i) => i.kind === k).map((i) => {
                const v = counts[i.id] ?? '';
                const n = Number(v.replace(',', '.'));
                const diff = v.trim() !== '' && Number.isFinite(n) ? round(n - i.on_hand, 3) : null;
                return (
                  <div key={i.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{i.name}</div>
                      <div className="text-[12.5px] text-ink-3">System says {qtyUnit(i.on_hand, i.unit)}{diff != null && diff !== 0 && <span className={diff < 0 ? 'text-danger' : 'text-field-soft-ink'}> · {diff > 0 ? '+' : ''}{qtyUnit(diff, i.unit)}</span>}</div>
                    </div>
                    <div className="relative w-32 shrink-0">
                      <Input inputMode="decimal" value={v} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value.replace(/[^\d.,]/g, '') })} className="pr-12 text-right" aria-label={`${i.name} counted`} />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-ink-3">{i.unit === 'each' ? 'pcs' : i.unit}</span>
                    </div>
                  </div>
                );
              })}
            </Card>
          </section>
        ))}
        <Field label="Note" optional><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Month-end count" /></Field>
      </div>
    </Sheet>
  );
}

// ── Purchases ──────────────────────────────────────────────
function Purchases({ categories }: { categories: string[] }) {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['stock', 'purchases'], queryFn: () => api.get<{ purchases: any[] }>('/api/stock/purchases') });
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = data?.purchases ?? [];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Record a purchase or expense</Button>
      </div>
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock />
      ) : !list.length ? (
        <EmptyState icon={<Truck className="size-6" />} title="No purchases yet" action={<Button variant="primary" onClick={() => setAdding(true)}>Record one</Button>}>Record each stock order (a cow, lambs, spices) and other costs (abattoir, transport), and you’ll see what you spend and what you ordered last time.</EmptyState>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {list.map((p) => (
            <button key={p.id} onClick={() => setOpenId(p.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
              <div className="w-14 shrink-0 text-[13px] leading-tight text-ink-3">{shortDate(p.ordered_on)}<br />{p.ordered_on.slice(0, 4)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="truncate font-semibold">{p.supplier_name ?? 'No supplier'}</span><PurchaseStatus s={p.status} /></div>
                <div className="truncate text-[13px] text-ink-3">{p.summary}</div>
              </div>
              <div className={cx('shrink-0 font-semibold tabular', p.status === 'cancelled' && 'text-ink-3 line-through')}>{formatMoney(p.total_cents)}</div>
            </button>
          ))}
        </Card>
      )}
      <PurchaseSheet open={adding} onClose={() => setAdding(false)} categories={categories} />
      <PurchaseView id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function PurchaseStatus({ s }: { s: string }) {
  return s === 'received' ? <Badge size="sm" tone="field">Received</Badge> : s === 'ordered' ? <Badge size="sm" tone="ochre">Ordered</Badge> : <Badge size="sm">Cancelled</Badge>;
}

interface LineState { item_id: string; description: string; category: string; qty: string; weight_kg: string; cost_per: 'unit' | 'kg'; cost: string }
const blankLine = (): LineState => ({ item_id: '', description: '', category: '', qty: '1', weight_kg: '', cost_per: 'unit', cost: '' });

function lineTotalCents(l: LineState, item: any | undefined) {
  const cost = randsToCents(l.cost) ?? 0;
  const qty = numOrNull(l.qty) ?? 0;
  if (l.cost_per === 'kg') {
    const w = numOrNull(l.weight_kg) ?? (item?.unit === 'kg' ? qty : item?.avg_weight_kg ? item.avg_weight_kg * qty : 0);
    return Math.round(w * cost);
  }
  return Math.round(qty * cost);
}

function PurchaseSheet({ open, onClose, prefill, categories, supplierId }: { open: boolean; onClose: () => void; prefill?: { item_id: string; qty: string }[]; categories?: string[]; supplierId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: itemsData } = useItems();
  const { data: sup } = useSuppliers();
  const { data: overview } = useQuery({ queryKey: ['stock', 'overview'], queryFn: () => api.get<any>('/api/stock') });
  const cats: string[] = categories ?? overview?.categories ?? [];
  const items = (itemsData?.items ?? []).filter((i) => i.active);
  const byId = new Map(items.map((i) => [i.id, i]));
  const [v, setV] = useState({ supplier_id: '', ordered_on: todayYmd(), reference: '', notes: '', received: false });
  const [lines, setLines] = useState<LineState[]>([blankLine()]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    const first = prefill?.[0] ? byId.get(prefill[0].item_id) : null;
    setV({ supplier_id: supplierId ?? first?.supplier_id ?? '', ordered_on: todayYmd(), reference: '', notes: '', received: false });
    setLines(prefill?.length ? prefill.map((p) => { const it = byId.get(p.item_id); return { ...blankLine(), item_id: p.item_id, qty: p.qty, cost: centsToRands(it?.cost_cents) }; }) : [blankLine()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const total = lines.reduce((s, l) => s + lineTotalCents(l, byId.get(l.item_id)), 0);
  const upd = (i: number, patch: Partial<LineState>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const valid = lines.length > 0 && lines.every((l) => (l.item_id || l.description.trim()) && (numOrNull(l.qty) ?? 0) > 0 && randsToCents(l.cost) != null);
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/stock/purchases', {
        supplier_id: v.supplier_id || null,
        ordered_on: v.ordered_on,
        reference: v.reference || null,
        notes: v.notes || null,
        received: v.received,
        lines: lines.map((l) => ({ item_id: l.item_id || null, description: l.description || null, category: l.category || null, qty: numOrNull(l.qty), weight_kg: numOrNull(l.weight_kg), cost_per: l.cost_per, unit_cost_cents: randsToCents(l.cost) })),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stock'] }); toast({ tone: 'success', title: v.received ? 'Purchase saved and added to stock' : 'Purchase saved', body: v.received ? undefined : 'Mark it received when it arrives.' }); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="lg"
      title="Record a purchase"
      subtitle="A stock order or any other expense."
      footer={
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1"><div className="text-[12px] text-ink-3">Total</div><div className="font-display text-[22px] font-semibold tabular">{formatMoney(total)}</div></div>
          <Button variant="primary" size="lg" disabled={!valid || !v.ordered_on} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Supplier" optional>
            <Select value={v.supplier_id} onChange={(e) => setV({ ...v, supplier_id: e.target.value })}><option value="">None / not listed</option>{(sup?.suppliers ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </Field>
          <Field label="Date"><Input type="date" value={v.ordered_on} onChange={(e) => setV({ ...v, ordered_on: e.target.value })} /></Field>
        </div>
        <Field label="Invoice or reference" optional><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} placeholder="e.g. INV-2041" /></Field>

        <section>
          <SectionTitle>Lines</SectionTitle>
          <div className="space-y-3">
            {lines.map((l, i) => {
              const it = byId.get(l.item_id);
              const unitWord = it ? (it.unit === 'kg' ? 'kg' : it.unit === 'pack' ? 'packs' : 'pieces') : 'qty';
              return (
                <Card key={i} className="space-y-3 p-3">
                  <div className="flex items-start gap-2">
                    <Field label="Stock item" className="min-w-0 flex-1">
                      <Select value={l.item_id} onChange={(e) => { const nit = byId.get(e.target.value); upd(i, { item_id: e.target.value, cost: l.cost || centsToRands(nit?.cost_cents), cost_per: nit?.kind === 'carcass' && nit?.unit !== 'kg' ? 'kg' : 'unit' }); }}>
                        <option value="">Not stock (an expense)</option>
                        {items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </Select>
                    </Field>
                    {lines.length > 1 && <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))} className="mt-7 rounded-lg p-2 text-ink-3 hover:bg-sunken" aria-label="Remove line"><X className="size-4" /></button>}
                  </div>
                  {!l.item_id && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="What for"><Input value={l.description} onChange={(e) => upd(i, { description: e.target.value })} placeholder="e.g. Abattoir fee, transport" /></Field>
                      <Field label="Category"><Select value={l.category} onChange={(e) => upd(i, { category: e.target.value })}><option value="">Choose…</option>{cats.map((c) => <option key={c}>{c}</option>)}</Select></Field>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Field label={l.item_id ? `How many (${unitWord})` : 'Quantity'}><Input inputMode="decimal" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value.replace(/[^\d.,]/g, '') })} /></Field>
                    {it && it.unit !== 'kg' && <Field label="Total weight (kg)" optional><Input inputMode="decimal" value={l.weight_kg} onChange={(e) => upd(i, { weight_kg: e.target.value.replace(/[^\d.,]/g, '') })} placeholder={it.avg_weight_kg ? `≈ ${round((numOrNull(l.qty) ?? 0) * it.avg_weight_kg, 1)}` : ''} /></Field>}
                    <Field label="Price (R)"><Input inputMode="decimal" value={l.cost} onChange={(e) => upd(i, { cost: e.target.value.replace(/[^\d.,]/g, '') })} /></Field>
                    <Field label="Price is">
                      <Select value={l.cost_per} onChange={(e) => upd(i, { cost_per: e.target.value as 'unit' | 'kg' })}>
                        <option value="unit">{it ? `per ${it.unit === 'kg' ? 'kg' : it.unit === 'pack' ? 'pack' : 'piece'}` : 'each'}</option>
                        {(!it || it.unit !== 'kg') && <option value="kg">per kg</option>}
                      </Select>
                    </Field>
                  </div>
                  <div className="text-right text-[13.5px] text-ink-2">Line total <b className="tabular text-ink">{formatMoney(lineTotalCents(l, it))}</b></div>
                </Card>
              );
            })}
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setLines([...lines, blankLine()])}>Add a line</Button>
          </div>
        </section>

        <Field label="Notes" optional><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        <Switch checked={v.received} onChange={(x) => setV({ ...v, received: x })} label="Already received" description="Adds the stock lines to what’s on hand now. Leave off for an order that hasn’t arrived yet." />
        {err && <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink">{err}</p>}
      </div>
    </Sheet>
  );
}

function PurchaseView({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data } = useQuery({ queryKey: ['stock', 'purchase', id], queryFn: () => api.get<any>(`/api/stock/purchases/${id}`), enabled: !!id });
  const p = data?.purchase;
  const act = useMutation({
    mutationFn: (what: 'receive' | 'cancel' | 'delete') => (what === 'delete' ? api.del(`/api/stock/purchases/${id}`) : api.post(`/api/stock/purchases/${id}/${what}`, {})),
    onSuccess: (_r, what) => {
      qc.invalidateQueries({ queryKey: ['stock'] });
      toast({ tone: 'success', title: what === 'receive' ? 'Received into stock' : what === 'cancel' ? 'Order cancelled' : 'Purchase deleted' });
      if (what !== 'receive') onClose();
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not do that.' }),
  });
  return (
    <Sheet open={!!id} onClose={onClose} width="lg" title={p ? p.supplier_name ?? 'Purchase' : 'Purchase'} subtitle={p ? `${shortDate(p.ordered_on)} ${p.ordered_on.slice(0, 4)}${p.reference ? ` · ${p.reference}` : ''}` : undefined}
      footer={p && p.status === 'ordered' ? <Button variant="primary" size="lg" full icon={<PackageCheck className="size-5" />} loading={act.isPending} onClick={() => act.mutate('receive')}>It arrived: add to stock</Button> : undefined}>
      {!p ? <LoadingBlock rows={3} /> : (
        <div className="space-y-5">
          <div className="flex items-center justify-between"><PurchaseStatus s={p.status} /><span className="font-display text-[26px] font-semibold tabular">{formatMoney(p.total_cents)}</span></div>
          <Card className="divide-y divide-line text-[14px]">
            {p.lines.map((l: any) => (
              <div key={l.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0"><div className="font-medium">{l.description}</div><div className="text-[12.5px] text-ink-3">{l.category} · {l.item_id ? qtyUnit(l.qty, l.item_unit ?? '') : l.qty}{l.item_unit === 'each' ? (l.qty === 1 ? ' piece' : ' pieces') : ''}{l.weight_kg && l.item_unit !== 'kg' ? ` · ${l.weight_kg} kg` : ''} · {formatMoney(l.unit_cost_cents)}/{l.cost_per === 'kg' ? 'kg' : l.item_unit === 'kg' ? 'kg' : 'each'}</div></div>
                <div className="shrink-0 font-medium tabular">{formatMoney(l.total_cents)}</div>
              </div>
            ))}
          </Card>
          {p.notes && <p className="text-[14px] text-ink-2">{p.notes}</p>}
          {p.received_on && <p className="text-[13px] text-ink-3">Received {shortDate(p.received_on)}.</p>}
          <div className="flex flex-wrap gap-2">
            {p.status === 'ordered' && <Button size="sm" onClick={() => act.mutate('cancel')}>Cancel order</Button>}
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={async () => { if (await confirm.ask({ title: 'Delete this purchase?', body: p.status === 'received' ? 'The stock it added is taken off again. Use this for mistakes.' : 'Use this for mistakes.', confirm: 'Delete', tone: 'danger' })) act.mutate('delete'); }}>Delete</Button>
          </div>
        </div>
      )}
      {confirm.node}
    </Sheet>
  );
}

// ── Suppliers ──────────────────────────────────────────────
function Suppliers({ costs }: { costs: boolean }) {
  const { data, isLoading, error, refetch } = useSuppliers();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [viewing, setViewing] = useState<any | null>(null);
  const list = data?.suppliers ?? [];
  return (
    <div className="space-y-5">
      {costs && <div><Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>Add supplier</Button></div>}
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock />
      ) : !list.length ? (
        <EmptyState icon={<Truck className="size-6" />} title="No suppliers yet" action={costs && <Button variant="primary" onClick={() => setEditing(null)}>Add a supplier</Button>}>Add who you buy your lamb, beef and spices from, and you’ll see what you ordered from them last time.</EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((s) => (
            <button key={s.id} onClick={() => setViewing(s)} className={cx('min-w-0 rounded-2xl border border-line bg-surface p-4 text-left shadow-card transition hover:shadow-float', !s.active && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2"><span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{s.name}</span>{!s.active && <Badge size="sm">Not used</Badge>}</div>
              {s.supplies && <div className="mt-0.5 line-clamp-2 text-[13.5px] text-ink-2">{s.supplies}</div>}
              <div className="mt-2 text-[13px] text-ink-3">{s.last_ordered_on ? `Last order ${shortDate(s.last_ordered_on)}` : 'No orders yet'}{s.purchase_count ? ` · ${s.purchase_count} order${s.purchase_count === 1 ? '' : 's'}` : ''}{costs && s.spend_12m_cents ? ` · ${formatMoney(s.spend_12m_cents)} this year` : ''}</div>
            </button>
          ))}
        </div>
      )}
      <SupplierForm open={editing !== undefined} supplier={editing ?? undefined} onClose={() => setEditing(undefined)} />
      <SupplierView s={viewing} onClose={() => setViewing(null)} onEdit={() => { setEditing(viewing); setViewing(null); }} costs={costs} />
    </div>
  );
}

function SupplierView({ s, onClose, onEdit, costs }: { s: any | null; onClose: () => void; onEdit: () => void; costs: boolean }) {
  const { data } = useQuery({ queryKey: ['stock', 'purchases', 'supplier', s?.id], queryFn: () => api.get<{ purchases: any[] }>(`/api/stock/purchases${qs({ supplier: s!.id })}`), enabled: !!s && costs });
  const [ordering, setOrdering] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const last = data?.purchases?.find((p) => p.status !== 'cancelled');
  const wa = (s?.phone ?? '').replace(/\D/g, '').replace(/^0/, '27');
  return (
    <Sheet open={!!s} onClose={onClose} title={s?.name ?? ''} subtitle={s?.contact_name ?? undefined}>
      {s && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            {s.phone && <a href={`tel:${s.phone.replace(/\s/g, '')}`}><Button size="sm" icon={<Phone className="size-4" />}>Call</Button></a>}
            {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"><Button size="sm">WhatsApp</Button></a>}
            {s.email && <a href={`mailto:${s.email}`}><Button size="sm" icon={<Mail className="size-4" />}>Email</Button></a>}
            {costs && <Button size="sm" icon={<Pencil className="size-4" />} onClick={onEdit}>Edit</Button>}
          </div>
          <Card className="divide-y divide-line px-4 text-[14px]">
            <Row label="Supplies">{s.supplies ?? '—'}</Row>
            <Row label="Phone">{s.phone ?? '—'}</Row>
            <Row label="Email">{s.email ?? '—'}</Row>
            {s.notes && <Row label="Notes">{s.notes}</Row>}
          </Card>
          {costs && (
            <section>
              <SectionTitle action={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setOrdering(true)}>New order</Button>}>Orders from {s.name}</SectionTitle>
              {last && (
                <Callout tone="slate" className="mb-3" title={`Last time (${shortDate(last.ordered_on)} ${last.ordered_on.slice(0, 4)})`}>{last.summary} · {formatMoney(last.total_cents)}</Callout>
              )}
              {data?.purchases.length ? (
                <Card className="divide-y divide-line">
                  {data.purchases.map((p) => (
                    <button key={p.id} onClick={() => setOpenId(p.id)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-[14px] hover:bg-surface-2">
                      <div className="min-w-0"><div className="truncate">{p.summary}</div><div className="text-[12.5px] text-ink-3">{shortDate(p.ordered_on)} {p.ordered_on.slice(0, 4)}</div></div>
                      <div className="flex shrink-0 items-center gap-2"><PurchaseStatus s={p.status} /><span className="font-medium tabular">{formatMoney(p.total_cents)}</span></div>
                    </button>
                  ))}
                </Card>
              ) : <p className="text-[14px] text-ink-3">No orders recorded yet.</p>}
            </section>
          )}
        </div>
      )}
      <PurchaseSheet open={ordering} onClose={() => setOrdering(false)} supplierId={s?.id} />
      <PurchaseView id={openId} onClose={() => setOpenId(null)} />
    </Sheet>
  );
}

function SupplierForm({ open, onClose, supplier }: { open: boolean; onClose: () => void; supplier?: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [v, setV] = useState<any>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setErr(null); setV({ name: supplier?.name ?? '', contact_name: supplier?.contact_name ?? '', phone: supplier?.phone ?? '', email: supplier?.email ?? '', supplies: supplier?.supplies ?? '', notes: supplier?.notes ?? '', active: supplier ? !!supplier.active : true }); }
  }, [open, supplier]);
  const set = (k: string, val: any) => setV((s: any) => ({ ...s, [k]: val }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...v, contact_name: v.contact_name || null, phone: v.phone || null, email: v.email || null, supplies: v.supplies || null, notes: v.notes || null };
      return supplier ? api.patch(`/api/stock/suppliers/${supplier.id}`, body) : api.post('/api/stock/suppliers', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stock'] }); toast({ tone: 'success', title: supplier ? 'Supplier updated' : 'Supplier added' }); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/stock/suppliers/${supplier.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stock'] }); toast({ tone: 'success', title: 'Supplier deleted' }); onClose(); },
  });
  return (
    <Sheet open={open} onClose={onClose} title={supplier ? `Edit ${supplier.name}` : 'New supplier'} footer={<Button variant="primary" size="lg" full disabled={!v.name?.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Name"><Input big value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="What we buy from them" optional><Input value={v.supplies ?? ''} onChange={(e) => set('supplies', e.target.value)} placeholder="e.g. Lamb carcasses, boerewors spice" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact person" optional><Input value={v.contact_name ?? ''} onChange={(e) => set('contact_name', e.target.value)} /></Field>
          <Field label="Phone" optional><Input inputMode="tel" value={v.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
        </div>
        <Field label="Email" optional><Input type="email" value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Notes" optional hint="e.g. order days, account number, delivery arrangements."><Textarea rows={3} value={v.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
        {supplier && <Switch checked={!!v.active} onChange={(x) => set('active', x)} label="Still buying from them" />}
        {err && <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink">{err}</p>}
        {supplier && (
          <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={async () => { if (await confirm.ask({ title: `Delete ${supplier.name}?`, body: 'Their past purchases stay in your records, without the supplier name. To keep the name, switch off “Still buying from them” instead.', confirm: 'Delete', tone: 'danger' })) remove.mutate(); }}>Delete supplier</Button>
        )}
      </div>
      {confirm.node}
    </Sheet>
  );
}

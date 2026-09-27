import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusPill } from '../components/order-bits';
import { Button, Card, cx, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, SectionTitle, Segmented } from '../components/ui';
import { api, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { addDays, friendlyDate, shortDate, todayYmd } from '../lib/format';
import { SOURCE_LABEL } from '../../../shared/workflow';

const EX_LABEL: Record<string, string> = {
  unknown_product: 'Unknown product', missing_quantity: 'Missing quantity', possible_amendment: 'Possible amendment', ambiguous_reference: 'Unclear reference',
  possible_duplicate: 'Possible duplicate', cancellation_request: 'Cancellation', ambiguous_customer: 'Unclear customer', customer_question: 'Customer question',
  contradiction: 'Conflicting amounts', unmatched_message: 'Unclear message', amendment_no_order: 'Change without order', ai_failure: 'Could not read', import_failure: 'Import problem',
};

export default function Reports() {
  const today = todayYmd();
  const can = useCan();
  const [preset, setPreset] = useState<'last30' | 'week' | 'next7' | 'custom'>('last30');
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const range = preset === 'last30' ? [addDays(today, -30), today] : preset === 'week' ? [addDays(today, -6), today] : preset === 'next7' ? [today, addDays(today, 6)] : [from, to];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['reports', range[0], range[1]], queryFn: () => api.get<any>(`/api/admin/reports${qs({ from: range[0], to: range[1] })}`) });
  const exportLink = (kind: string) => `/api/admin/export/${kind}.csv${qs({ from: range[0], to: range[1] })}`;
  return (
    <div className="animate-rise">
      <PageHeader title="Reports" subtitle={`${friendlyDate(range[0], today)} – ${friendlyDate(range[1], today)}`} />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0"><Segmented value={preset} onChange={setPreset} options={[{ value: 'week', label: 'Last 7 days' }, { value: 'last30', label: 'Last 30 days' }, { value: 'next7', label: 'Next 7 days' }, { value: 'custom', label: 'Custom' }]} /></div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From" />
            <span className="text-ink-3">to</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To" />
          </div>
        )}
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <a href={exportLink('orders')}><Button size="sm" icon={<Download className="size-3.5" />}>Orders CSV</Button></a>
          <a href={exportLink('items')}><Button size="sm" icon={<Download className="size-3.5" />}>Items CSV</Button></a>
        </div>
      </div>
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading || !data ? (
        <LoadingBlock rows={5} />
      ) : (
        <div className="space-y-8">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Orders for these dates" value={data.by_day.reduce((a: number, d: any) => a + d.orders, 0)} />
            <Tile label="Completed" value={data.by_day.reduce((a: number, d: any) => a + (d.completed ?? 0), 0)} />
            <Tile label="Amendments" value={data.amendments?.n ?? 0} hint={`on ${data.amendments?.orders ?? 0} orders`} />
            <Tile label="Exceptions raised" value={data.exceptions.reduce((a: number, e: any) => a + e.n, 0)} />
          </section>

          <section>
            <SectionTitle>Orders by collection / delivery date</SectionTitle>
            <DayBars rows={data.by_day} today={today} />
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <SectionTitle>Products ordered</SectionTitle>
              <Card className="overflow-hidden">
                {data.products.length ? (
                  <table className="w-full text-[14px]">
                    <thead className="bg-surface-2 text-left text-[12px] uppercase tracking-[0.06em] text-ink-3"><tr><th className="px-4 py-2 font-semibold">Product</th><th className="px-4 py-2 text-right font-semibold">Total</th><th className="px-4 py-2 text-right font-semibold">Orders</th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {data.products.map((p: any) => (
                        <tr key={p.id}><td className="px-4 py-2.5 font-medium">{p.name}</td><td className="px-4 py-2.5 text-right tabular">{p.total_label}</td><td className="px-4 py-2.5 text-right tabular text-ink-2">{p.orders}</td></tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="px-4 py-8 text-center text-ink-3">No products in this period.</p>}
              </Card>
            </section>
            <div className="space-y-6">
              <section>
                <SectionTitle>Top customers</SectionTitle>
                <Card className="divide-y divide-line">
                  {data.customers.length ? data.customers.map((c: any) => (
                    <Link key={c.id} to={`/customers/${c.id}`} className="flex items-center justify-between px-4 py-2.5 text-[14px] hover:bg-surface-2"><span className="font-medium">{c.name}</span><span className="tabular text-ink-2">{c.orders} orders</span></Link>
                  )) : <p className="px-4 py-6 text-center text-ink-3">No customers in this period.</p>}
                </Card>
              </section>
              <section className="grid grid-cols-2 gap-4">
                <div>
                  <SectionTitle>How orders arrived</SectionTitle>
                  <Card className="divide-y divide-line text-[14px]">
                    {data.by_source.map((s: any) => <div key={s.source} className="flex justify-between px-4 py-2"><span>{SOURCE_LABEL[s.source as keyof typeof SOURCE_LABEL] ?? s.source}</span><span className="tabular font-medium">{s.n}</span></div>)}
                    {!data.by_source.length && <p className="px-4 py-4 text-center text-ink-3">—</p>}
                  </Card>
                </div>
                <div>
                  <SectionTitle>Fulfilment</SectionTitle>
                  <Card className="divide-y divide-line text-[14px]">
                    {data.fulfilment.map((f: any) => <div key={f.type} className="flex justify-between px-4 py-2"><span className="capitalize">{f.type}</span><span className="tabular font-medium">{f.n}</span></div>)}
                    {!data.fulfilment.length && <p className="px-4 py-4 text-center text-ink-3">—</p>}
                  </Card>
                </div>
              </section>
              <section>
                <SectionTitle>Exceptions by type</SectionTitle>
                <Card className="divide-y divide-line text-[14px]">
                  {data.exceptions.length ? data.exceptions.map((e: any) => <div key={e.type} className="flex justify-between px-4 py-2"><span>{EX_LABEL[e.type] ?? e.type}</span><span className="tabular"><b>{e.n}</b>{e.open ? <span className="text-ink-3"> · {e.open} open</span> : null}</span></div>) : <p className="px-4 py-4 text-center text-ink-3">None — great.</p>}
                </Card>
              </section>
            </div>
          </div>

          <section>
            <SectionTitle>Outstanding orders · {data.outstanding.length}</SectionTitle>
            {data.outstanding.length ? (
              <Card className="divide-y divide-line">
                {data.outstanding.slice(0, 30).map((o: any) => (
                  <Link key={o.id} to={`/orders/${o.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[14px] hover:bg-surface-2">
                    <span className="w-16 tabular text-ink-3">#{o.order_number}</span>
                    <span className="flex-1 font-medium">{o.customer_name}</span>
                    <span className="hidden w-32 text-ink-2 sm:block">{friendlyDate(o.requested_date, today)}</span>
                    <StatusPill status={o.status} size="sm" />
                  </Link>
                ))}
              </Card>
            ) : <EmptyState title="Nothing outstanding">Every order is completed or cancelled.</EmptyState>}
          </section>
          {can('data.export') && <p className="text-[13px] text-ink-3">Full data export and backups are in Settings → Data & backup.</p>}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="font-display text-[32px] font-semibold leading-none tabular">{value}</div>
      <div className="mt-1.5 text-[14px] font-medium text-ink-2">{label}</div>
      {hint && <div className="text-[12.5px] text-ink-3">{hint}</div>}
    </Card>
  );
}

/** Single series, one hue: bar height = orders that day. Hover/focus shows the exact numbers. */
function DayBars({ rows, today }: { rows: { date: string; orders: number; completed: number }[]; today: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length) return <EmptyState title="No orders in this period" />;
  const max = Math.max(...rows.map((r) => r.orders), 1);
  const h = hover != null ? rows[hover] : null;
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 h-5 text-[13px] text-ink-2" aria-live="polite">
        {h ? <><b className="text-ink">{friendlyDate(h.date, today)}</b> · {h.orders} order{h.orders === 1 ? '' : 's'} · {h.completed} completed</> : <span className="text-ink-3">Hover or tap a bar for details</span>}
      </div>
      <div className="flex h-40 items-end gap-[2px] border-b border-line" role="img" aria-label="Orders per day">
        {rows.map((r, i) => (
          <button
            key={r.date}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className="group flex h-full min-w-0 flex-1 items-end focus:outline-none"
            aria-label={`${r.date}: ${r.orders} orders`}
          >
            <span className={cx('block w-full rounded-t-[4px] transition-colors', hover === i ? 'bg-brand' : 'bg-brand/60')} style={{ height: `${Math.max(3, (r.orders / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-3">
        <span>{shortDate(rows[0].date)}</span>
        <span>max {max}/day</span>
        <span>{shortDate(rows[rows.length - 1].date)}</span>
      </div>
    </Card>
  );
}


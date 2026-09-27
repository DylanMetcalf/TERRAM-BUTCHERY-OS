import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardList, Plus, Printer, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { OrderRow } from '../components/OrderRow';
import { Button, Card, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, Segmented } from '../components/ui';
import { api, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { friendlyDate, todayYmd } from '../lib/format';
import type { OrderSummary } from '../lib/types';

const VIEWS = [
  { value: 'open', label: 'Open' },
  { value: 'review', label: 'To review' },
  { value: 'today', label: 'Today' },
  { value: 'production', label: 'In production' },
  { value: 'ready', label: 'Ready' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

const EMPTY: Record<string, { title: string; body: string }> = {
  open: { title: 'No open orders', body: 'New orders will appear here as soon as they arrive.' },
  review: { title: 'Nothing to review', body: 'Every order has been checked.' },
  today: { title: 'No orders today', body: 'No orders have been received for today yet.' },
  production: { title: 'Nothing in production', body: 'Confirmed orders show up here while they are cut and packed.' },
  ready: { title: 'Nothing ready yet', body: 'Packed orders waiting for collection or delivery show up here.' },
  overdue: { title: 'Nothing overdue', body: 'Every order is on time.' },
  completed: { title: 'No completed orders', body: 'Collected and delivered orders will be listed here.' },
  cancelled: { title: 'No cancelled orders', body: 'Good news.' },
  undated: { title: 'All orders have dates', body: 'Nothing is missing a collection or delivery date.' },
};

export default function Orders() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const view = params.get('view') ?? (params.get('filter') === 'undated' ? 'undated' : 'open');
  const from = params.get('from');
  const to = params.get('to');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(0), [view, debounced, from, to]);
  const limit = 50;
  const { data, isLoading, error, refetch, isPlaceholderData } = useQuery({
    queryKey: ['orders', view, debounced, from, to, page],
    queryFn: () => api.get<{ orders: OrderSummary[]; total: number; counts: Record<string, number> }>(`/api/orders${qs({ view, q: debounced, from, to, limit, offset: page * limit })}`),
    placeholderData: keepPreviousData,
  });
  const today = todayYmd();
  const setView = (v: string) => {
    const p = new URLSearchParams(params);
    p.set('view', v);
    p.delete('filter');
    setParams(p, { replace: true });
  };
  const counts = data?.counts ?? {};
  return (
    <div className="animate-rise">
      <PageHeader
        title="Orders"
        subtitle={data ? `${data.total} ${view === 'open' ? 'open' : ''} order${data.total === 1 ? '' : 's'}` : ' '}
        actions={
          can('orders.write') && (
            <>
              <Link to={`/print/dockets${qs({ date: from && from === to ? from : view === 'today' ? todayYmd() : undefined })}`} target="_blank"><Button icon={<Printer className="size-4" />}>Print dockets</Button></Link>
              <Link to="/import"><Button>Paste orders</Button></Link>
              <Link to="/orders/new"><Button variant="primary" icon={<Plus className="size-4" />}>New order</Button></Link>
            </>
          )
        }
      />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0">
          <Segmented value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v.value, label: v.label, count: counts[v.value] }))} />
        </div>
        <div className="relative lg:ml-auto lg:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or order number" className="pl-9" aria-label="Filter orders" />
        </div>
      </div>
      {(from || to) && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-sunken px-3 py-1.5 text-[13px] font-medium text-ink-2">
          {from === to ? friendlyDate(from, today) : `${friendlyDate(from, today)} – ${friendlyDate(to, today)}`}
          <button aria-label="Clear date filter" onClick={() => { const p = new URLSearchParams(params); p.delete('from'); p.delete('to'); setParams(p); }}>
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock rows={6} />
      ) : !data?.orders.length ? (
        <EmptyState icon={<ClipboardList className="size-6" />} title={debounced ? `No orders match “${debounced}”` : EMPTY[view]?.title ?? 'No orders'}>
          {debounced ? 'Try a different name or number.' : EMPTY[view]?.body}
        </EmptyState>
      ) : (
        <>
          <Card className={`overflow-hidden transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}>
            <div className="hidden items-center gap-4 border-b border-line bg-surface-2 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3 sm:flex">
              <span className="flex-1">Customer & items</span>
              <span className="w-48">When</span>
              <span className="hidden w-4 md:block" />
              <span className="w-40 text-right">Status</span>
              <span className="w-4" />
            </div>
            {data.orders.map((o) => (
              <OrderRow key={o.id} o={o} today={today} />
            ))}
          </Card>
          {data.total > limit && (
            <div className="mt-4 flex items-center justify-between text-[14px] text-ink-2">
              <span>
                {page * limit + 1}–{Math.min((page + 1) * limit, data.total)} of {data.total}
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button size="sm" disabled={(page + 1) * limit >= data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

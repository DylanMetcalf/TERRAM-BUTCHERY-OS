import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Package, Printer, Scale, Store, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BigCheck, Button, Card, cx, EmptyState, ErrorState, LoadingBlock, PageHeader, SectionTitle, useToast } from '../components/ui';
import { FinalWeighingSheet, PaymentRequestSheet, StorageBadge } from '../components/FinalWeighing';
import { api, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { friendlyDate, qtyBeforeName, todayYmd } from '../lib/format';
import type { OrderItem, OrderSummary } from '../lib/types';

type PackOrder = OrderSummary & { items: OrderItem[] };

export default function Packing() {
  const can = useCan();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['packing'], queryFn: () => api.get<{ ready_to_pack: PackOrder[]; still_cutting: OrderSummary[]; final_weighing: PackOrder[]; awaiting_payment: OrderSummary[] }>('/api/production/packing') });
  const orders = data?.ready_to_pack ?? [];
  const [weighing, setWeighing] = useState<PackOrder | null>(null);
  const [requesting, setRequesting] = useState<string | null>(null);
  const cur = weighing ? data?.final_weighing.find((x) => x.id === weighing.id) ?? weighing : null;
  return (
    <div className="animate-rise">
      <PageHeader
        title="Packing"
        subtitle={data ? `${orders.length} order${orders.length === 1 ? '' : 's'} to pack` : ' '}
        actions={<Link to="/print/packing" target="_blank"><Button icon={<Printer className="size-4" />}>Print packing slips</Button></Link>}
      />
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock rows={4} />
      ) : !orders.length && !data?.final_weighing.length ? (
        <EmptyState icon={<Package className="size-6" />} title="No packing" tone="field">
          Nothing is waiting to be packed. Orders appear here once they’re cut.
        </EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {orders.map((o) => (
            <PackCard key={o.id} o={o} />
          ))}
        </div>
      )}
      {data && data.final_weighing.length > 0 && (
        <section className="mt-8">
          <SectionTitle>Final weighing · {data.final_weighing.length}</SectionTitle>
          <p className="-mt-1 mb-3 text-[14px] text-ink-2">Packed orders: enter the actual weights, check the packs, then finalize the amount and send the payment request.</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.final_weighing.map((o) => {
              const toWeigh = o.items.filter((i) => i.status === 'active' && (i.pricing === 'by_weight' || i.pricing === 'estimate'));
              const left = toWeigh.filter((i) => !i.packed_weight_g).length;
              return (
                <Card key={o.id} className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><Link to={`/orders/${o.id}`} className="truncate font-semibold hover:underline">{o.customer_name}</Link><StorageBadge storage={o.storage} size="sm" /></div>
                    <div className="text-[13px] text-ink-3">#{o.order_number} · {toWeigh.length ? (left ? `${left} of ${toWeigh.length} to weigh` : 'All weighed') : 'Fixed packs only'}</div>
                  </div>
                  {can('orders.write') && <Button variant="primary" icon={<Scale className="size-4" />} onClick={() => setWeighing(o)}>Weigh</Button>}
                </Card>
              );
            })}
          </div>
        </section>
      )}
      {data && data.awaiting_payment.length > 0 && (
        <section className="mt-8">
          <SectionTitle>Finalized · waiting for payment · {data.awaiting_payment.length}</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {data.awaiting_payment.map((o) => (
              <button key={o.id} type="button" onClick={() => setRequesting(o.id)} className="rounded-xl border border-line bg-surface px-3 py-2 text-left text-[14px] hover:border-line-strong">
                <span className="font-medium">{o.customer_name}</span> <span className="text-ink-3">#{o.order_number} · {o.payment_state === 'proof_submitted' ? 'check payment' : o.payment_state === 'not_requested' ? 'request not sent' : 'requested'}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {cur && <FinalWeighingSheet order={cur} items={cur.items} problems={[]} open onClose={() => setWeighing(null)} onFinalized={() => { const id = cur.id; setWeighing(null); setRequesting(id); }} />}
      {requesting && <PaymentRequestSheet orderId={requesting} open onClose={() => setRequesting(null)} />}
      {data && data.still_cutting.length > 0 && (
        <section className="mt-8">
          <SectionTitle>Still being cut · {data.still_cutting.length}</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {data.still_cutting.map((o) => (
              <Link key={o.id} to={`/orders/${o.id}`} className="rounded-xl border border-line bg-surface px-3 py-2 text-[14px] hover:border-line-strong">
                <span className="font-medium">{o.customer_name}</span> <span className="text-ink-3">#{o.order_number} · {o.items_cut}/{o.item_count} cut</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PackCard({ o }: { o: PackOrder }) {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const [items, setItems] = useState(o.items);
  useEffect(() => setItems(o.items), [o.items]);
  const pack = useMutation({
    mutationFn: (v: { id: string; packed: boolean }) => api.post(`/api/items/${v.id}/packed`, { packed: v.packed }),
    onMutate: (v) => setItems((s) => s.map((i) => (i.id === v.id ? { ...i, packed_at: v.packed ? new Date().toISOString() : null } : i))),
    onError: (e) => {
      setItems(o.items);
      toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['packing'] }),
  });
  const done = useMutation({
    mutationFn: () => api.post(`/api/orders/${o.id}/packed`),
    onSuccess: () => {
      toast({ tone: 'success', title: `${o.customer_name}’s order is packed`, body: 'Next: final weighing (below).' });
      qc.invalidateQueries({ queryKey: ['packing'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['fulfilment'] });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not complete packing.' }),
  });
  const packedCount = items.filter((i) => i.packed_at).length;
  const all = packedCount === items.length && items.length > 0;
  const canPack = can('production.write');
  return (
    <Card className={cx('flex flex-col overflow-hidden transition', all && 'border-field/40')}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <Link to={`/orders/${o.id}`} className="font-display text-[19px] font-semibold leading-tight tracking-tight hover:underline">{o.customer_name}</Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13.5px] text-ink-2">
            <span className="tabular">#{o.order_number}</span>
            <StorageBadge storage={o.storage} size="sm" />
            <span className="inline-flex items-center gap-1">{o.fulfilment_type === 'delivery' ? <Truck className="size-4" /> : <Store className="size-4" />}{o.fulfilment_type === 'delivery' ? 'Delivery' : 'Collection'} · {friendlyDate(o.requested_date, todayYmd())}{o.time_window ? ` · ${o.time_window}` : ''}</span>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-sunken px-3 py-1 text-[14px] font-semibold tabular">{packedCount}/{items.length}</span>
      </div>
      <ul className="flex-1 divide-y divide-line">
        {items.map((i) => (
          <li key={i.id} className={cx('flex items-center gap-3.5 px-4 py-2.5 transition-colors sm:px-5', i.packed_at && 'bg-field-soft/40')}>
            <BigCheck checked={!!i.packed_at} disabled={!canPack} onChange={(v) => pack.mutate({ id: i.id, packed: v })} label={`${i.qty_label} ${i.product_name}`} />
            <div className="min-w-0 flex-1">
              <div className={cx('text-[16px] font-semibold leading-snug', i.packed_at && 'text-ink-2')}>
                <span className="tabular">{qtyBeforeName(i.qty)}</span> {i.product_name}
              </div>
              {i.preparation_label && <div className="text-[13.5px] font-semibold text-brand">{i.preparation_label}</div>}
              {i.special_instructions && <div className="text-[13.5px] font-medium text-ochre">⚑ {i.special_instructions}</div>}
            </div>
          </li>
        ))}
      </ul>
      {o.notes && <p className="border-t border-line bg-ochre-soft px-5 py-3 text-[14.5px] font-medium text-ochre-soft-ink">Note: {o.notes}</p>}
      {canPack && (
        <div className="border-t border-line p-3 sm:p-4">
          <Button variant={all ? 'success' : 'secondary'} size="lg" full disabled={!all} loading={done.isPending} onClick={() => done.mutate()} icon={<Check className="size-5" strokeWidth={3} />}>
            {all ? 'Packed' : `Tick ${items.length - packedCount} more item${items.length - packedCount === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
    </Card>
  );
}

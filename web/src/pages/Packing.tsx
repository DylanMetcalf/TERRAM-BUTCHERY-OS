import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Package, Printer, Scale, Store, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BigCheck, Button, Card, cx, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, SectionTitle, Sheet, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { friendlyDate, qtyBeforeName, todayYmd } from '../lib/format';
import type { OrderItem, OrderSummary } from '../lib/types';

type PackOrder = OrderSummary & { items: OrderItem[] };

export default function Packing() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['packing'], queryFn: () => api.get<{ ready_to_pack: PackOrder[]; still_cutting: OrderSummary[] }>('/api/production/packing') });
  const orders = data?.ready_to_pack ?? [];
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
      ) : !orders.length ? (
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
  const [weighing, setWeighing] = useState<OrderItem | null>(null);
  const [weight, setWeight] = useState('');
  const [items, setItems] = useState(o.items);
  useEffect(() => setItems(o.items), [o.items]);
  const pack = useMutation({
    mutationFn: (v: { id: string; packed: boolean; w?: number | null }) => api.post(`/api/items/${v.id}/packed`, { packed: v.packed, packed_weight_g: v.w ?? null }),
    onMutate: (v) => setItems((s) => s.map((i) => (i.id === v.id ? { ...i, packed_at: v.packed ? new Date().toISOString() : null, packed_weight_g: v.w ?? i.packed_weight_g } : i))),
    onError: (e) => {
      setItems(o.items);
      toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['packing'] }),
  });
  const done = useMutation({
    mutationFn: () => api.post(`/api/orders/${o.id}/packed`),
    onSuccess: () => {
      toast({ tone: 'success', title: `${o.customer_name}’s order is packed`, body: 'Moved to Ready.' });
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
      <div className="flex items-start justify-between gap-3 border-b border-line p-4 sm:p-5">
        <div className="min-w-0">
          <Link to={`/orders/${o.id}`} className="font-display text-[24px] font-semibold uppercase leading-tight tracking-tight hover:underline">{o.customer_name}</Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[14px] text-ink-2">
            <span className="tabular">#{o.order_number}</span>
            <span className="inline-flex items-center gap-1">{o.fulfilment_type === 'delivery' ? <Truck className="size-4" /> : <Store className="size-4" />}{o.fulfilment_type === 'delivery' ? 'Delivery' : 'Collection'} · {friendlyDate(o.requested_date, todayYmd())}{o.time_window ? ` · ${o.time_window}` : ''}</span>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-sunken px-3 py-1 text-[14px] font-semibold tabular">{packedCount}/{items.length}</span>
      </div>
      <ul className="flex-1 divide-y divide-line">
        {items.map((i) => (
          <li key={i.id} className={cx('flex items-center gap-4 px-4 py-3.5 transition-colors sm:px-5', i.packed_at && 'bg-field-soft/40')}>
            <BigCheck checked={!!i.packed_at} disabled={!canPack} onChange={(v) => pack.mutate({ id: i.id, packed: v })} label={`${i.qty_label} ${i.product_name}`} />
            <div className="min-w-0 flex-1">
              <div className={cx('text-[18px] font-semibold leading-snug', i.packed_at && 'text-ink-2')}>
                <span className="tabular">{qtyBeforeName(i.qty)}</span> {i.product_name}
              </div>
              {i.preparation_label && <div className="text-[15px] font-semibold text-brand">{i.preparation_label}</div>}
              {i.special_instructions && <div className="text-[14.5px] font-medium text-ochre">⚑ {i.special_instructions}</div>}
              {i.packed_weight_g && <div className="text-[13px] text-ink-3">Weighed {(i.packed_weight_g / 1000).toFixed(2)}kg</div>}
            </div>
            {canPack && (i.qty.kind !== 'count' || i.price_unit === 'kg') && (
              <button onClick={() => { setWeighing(i); setWeight(i.packed_weight_g ? String(i.packed_weight_g / 1000) : ''); }} className="rounded-xl p-2.5 text-ink-3 hover:bg-sunken hover:text-ink" aria-label={`Record weight for ${i.product_name}`}>
                <Scale className="size-5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {o.notes && <p className="border-t border-line bg-ochre-soft px-5 py-3 text-[14.5px] font-medium text-ochre-soft-ink">Note: {o.notes}</p>}
      {canPack && (
        <div className="border-t border-line p-3 sm:p-4">
          <Button variant={all ? 'success' : 'secondary'} size="xl" full disabled={!all} loading={done.isPending} onClick={() => done.mutate()} icon={<Check className="size-6" strokeWidth={3} />}>
            {all ? 'Packed' : `Tick ${items.length - packedCount} more item${items.length - packedCount === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
      <Sheet
        open={!!weighing}
        onClose={() => setWeighing(null)}
        title={`Weight · ${weighing?.product_name ?? ''}`}
        subtitle={weighing ? `Ordered ${weighing.qty_label}` : undefined}
        footer={
          <Button variant="primary" size="lg" full disabled={!Number(weight.replace(',', '.'))} onClick={() => { if (weighing) pack.mutate({ id: weighing.id, packed: true, w: Math.round(Number(weight.replace(',', '.')) * 1000) }); setWeighing(null); }}>
            Save & tick
          </Button>
        }
      >
        <Field label="Actual weight (kg)" hint="Optional — useful when weight-priced items are invoiced.">
          <Input big inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^\d.,]/g, ''))} autoFocus placeholder="e.g. 2.08" />
        </Field>
      </Sheet>
    </Card>
  );
}

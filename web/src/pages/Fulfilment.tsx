import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, MapPin, MessageCircle, Phone, Printer, Store, Truck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusPill } from '../components/order-bits';
import { Badge, Button, Card, cx, EmptyState, ErrorState, LoadingBlock, PageHeader, SectionTitle, Segmented, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useCan, useMe } from '../lib/auth';
import { friendlyDate, readyMessage, timeAgo, todayYmd, waLink } from '../lib/format';
import type { OrderItem, OrderSummary } from '../lib/types';

type FOrder = OrderSummary & { items: OrderItem[] };

export default function Fulfilment() {
  const [tab, setTab] = useState<'collection' | 'delivery'>('collection');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['fulfilment'], queryFn: () => api.get<{ date: string; ready: FOrder[]; not_ready_today: FOrder[]; completed_today: FOrder[] }>('/api/production/fulfilment') });
  const today = todayYmd();
  const of = (list: FOrder[] = []) => list.filter((o) => (tab === 'delivery' ? o.fulfilment_type === 'delivery' : o.fulfilment_type !== 'delivery'));
  const ready = of(data?.ready);
  const pending = of(data?.not_ready_today);
  const done = of(data?.completed_today);
  const count = (t: 'collection' | 'delivery') => (data?.ready ?? []).filter((o) => (t === 'delivery' ? o.fulfilment_type === 'delivery' : o.fulfilment_type !== 'delivery')).length;
  return (
    <div className="animate-rise">
      <PageHeader title="Fulfilment" subtitle="Ready orders, collections and deliveries." actions={<Link to="/print/ready" target="_blank"><Button icon={<Printer className="size-4" />}>Print ready list</Button></Link>} />
      <Segmented size="lg" value={tab} onChange={setTab} className="mb-5" options={[{ value: 'collection', label: <><Store className="size-4" />Collections</>, count: count('collection') }, { value: 'delivery', label: <><Truck className="size-4" />Deliveries</>, count: count('delivery') }]} />
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock rows={4} />
      ) : (
        <div className="space-y-8">
          <section>
            <SectionTitle>Ready · {ready.length}</SectionTitle>
            {ready.length ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {ready.map((o) => (
                  <ReadyCard key={o.id} o={o} today={today} />
                ))}
              </div>
            ) : (
              <EmptyState icon={tab === 'delivery' ? <Truck className="size-6" /> : <Store className="size-6" />} title={`No ${tab === 'delivery' ? 'deliveries' : 'collections'} ready`}>Packed orders show up here.</EmptyState>
            )}
          </section>
          {pending.length > 0 && (
            <section>
              <SectionTitle>Due today but not ready yet · {pending.length}</SectionTitle>
              <Card className="divide-y divide-line">
                {pending.map((o) => (
                  <Link key={o.id} to={`/orders/${o.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                    <span className="flex-1 font-medium">{o.customer_name} <span className="text-ink-3">#{o.order_number}</span></span>
                    <StatusPill status={o.status} size="sm" />
                  </Link>
                ))}
              </Card>
            </section>
          )}
          {done.length > 0 && (
            <section>
              <SectionTitle>Completed today · {done.length}</SectionTitle>
              <Card className="divide-y divide-line">
                {done.map((o) => (
                  <Link key={o.id} to={`/orders/${o.id}`} className="flex items-center gap-3 px-4 py-3 text-ink-2 hover:bg-surface-2">
                    <CheckCircle2 className="size-4 text-field" />
                    <span className="flex-1">{o.customer_name} <span className="text-ink-3">#{o.order_number}</span></span>
                    <span className="text-[13px] text-ink-3">{timeAgo(o.completed_at)}</span>
                  </Link>
                ))}
              </Card>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ReadyCard({ o, today }: { o: FOrder; today: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const me = useMe();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['fulfilment'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const move = useMutation({
    mutationFn: (to: string) => api.post(`/api/orders/${o.id}/transition`, { to }),
    onSuccess: (_r, to) => {
      toast({ tone: 'success', title: to === 'completed' ? (o.fulfilment_type === 'delivery' ? 'Delivered' : 'Collected') : to === 'out_for_delivery' ? 'Out for delivery' : 'Updated' });
      refresh();
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not update.' }),
  });
  const notify = useMutation({ mutationFn: () => api.post(`/api/orders/${o.id}/notified`, { notified: true }), onSuccess: refresh });
  const phone = o.contact_phone ?? o.customer_phone;
  const overdue = o.requested_date && o.requested_date < today;
  const delivery = o.fulfilment_type === 'delivery';
  const canAct = can('production.write');
  return (
    <Card className={cx('flex flex-col', overdue && 'border-danger/30')}>
      <div className="flex-1 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link to={`/orders/${o.id}`} className="text-[18px] font-semibold hover:underline">{o.customer_name}</Link>
            <div className="text-[13.5px] text-ink-3">#{o.order_number} · <span className={cx(overdue && 'font-semibold text-danger')}>{friendlyDate(o.requested_date, today)}</span>{o.time_window ? ` · ${o.time_window}` : ''}</div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StatusPill status={o.status} size="sm" />
            {o.customer_notified_at ? <Badge size="sm" tone="field">Notified</Badge> : <Badge size="sm" tone="ochre">Not told yet</Badge>}
          </div>
        </div>
        <p className="mt-2 text-[14px] text-ink-2">{o.items.map((i) => `${i.qty_label} ${i.product_name}`).join(' · ')}</p>
        {delivery && (
          <p className="mt-2 flex items-start gap-1.5 text-[14px]">
            <MapPin className="mt-0.5 size-4 shrink-0 text-ink-3" />
            {o.delivery_address ? <a className="underline decoration-line-strong underline-offset-2" href={`https://maps.google.com/?q=${encodeURIComponent(o.delivery_address)}`} target="_blank" rel="noreferrer">{o.delivery_address}</a> : <span className="font-medium text-danger">No address</span>}
          </p>
        )}
        {o.delivery_notes && <p className="mt-1 text-[13.5px] text-ink-2">{o.delivery_notes}</p>}
      </div>
      {canAct && (
        <div className="flex flex-wrap gap-2 border-t border-line bg-surface-2 p-3">
          {phone && <a href={`tel:${phone}`}><Button size="md" variant="ghost" icon={<Phone className="size-4" />} aria-label="Call" /></a>}
          {!o.customer_notified_at && (
            <Button
              size="md"
              icon={<MessageCircle className="size-4" />}
              loading={notify.isPending}
              onClick={() => {
                const link = waLink(phone, readyMessage(o, me.business.name));
                if (link) window.open(link, '_blank', 'noopener');
                notify.mutate();
              }}
            >
              {phone ? 'Tell customer' : 'Told customer'}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {delivery && o.status === 'ready' && <Button size="md" icon={<Truck className="size-4" />} loading={move.isPending && move.variables === 'out_for_delivery'} onClick={() => move.mutate('out_for_delivery')}>Out for delivery</Button>}
            {o.status === 'packed' && <Button size="md" onClick={() => move.mutate('ready')}>Mark ready</Button>}
            {(o.status === 'ready' || o.status === 'out_for_delivery') && (
              <Button variant="success" size="md" icon={<Check className="size-4" strokeWidth={3} />} loading={move.isPending && move.variables === 'completed'} onClick={() => move.mutate('completed')}>
                {delivery ? 'Delivered' : 'Collected'}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

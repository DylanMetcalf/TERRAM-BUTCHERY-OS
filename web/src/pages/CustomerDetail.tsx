import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Mail, MapPin, MessageCircle, Pencil, Phone, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { OrderRow } from '../components/OrderRow';
import { Avatar, Button, Card, EmptyState, ErrorState, LoadingBlock, SectionTitle, useConfirm, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { dateTime, shortDate, timeAgo, todayYmd, waLink } from '../lib/format';
import type { Customer, OrderSummary } from '../lib/types';
import { CustomerForm } from './Customers';

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const can = useCan();
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: () => api.del<{ name: string; orders: number }>(`/api/customers/${id}`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast({ tone: 'success', title: `${r.name} deleted`, body: r.orders ? `With ${r.orders} order${r.orders === 1 ? '' : 's'}.` : undefined });
      navigate('/customers', { replace: true });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not delete this customer.' }),
  });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<{ customer: Customer; orders: OrderSummary[]; frequent: any[]; amendments: any[]; messages: any[]; stats: any }>(`/api/customers/${id}`) });
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <LoadingBlock />;
  const c = data.customer;
  const open = data.orders.filter((o) => !['completed', 'cancelled'].includes(o.status));
  const past = data.orders.filter((o) => ['completed', 'cancelled'].includes(o.status));
  const today = todayYmd();
  const wa = waLink(c.phone);
  const doDelete = async () => {
    const n = data.orders.length;
    const ok = await confirm.ask({
      title: `Delete ${c.name}?`,
      body: (
        <>
          This removes {c.name} for good{n ? <>, <b>with {n} order{n === 1 ? '' : 's'}</b> and their messages</> : ''}. It can’t be undone. A note of what was deleted stays in the audit log.
          {open.length > 0 && <span className="mt-2 block font-medium text-danger">{open.length} of these order{open.length === 1 ? ' is' : 's are'} still open.</span>}
        </>
      ),
      confirm: 'Delete for good',
      tone: 'danger',
    });
    if (ok) remove.mutate();
  };
  return (
    <div className="animate-rise">
      <button onClick={() => navigate(-1)} className="mb-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-2 hover:text-ink"><ArrowLeft className="size-4" /> Back</button>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <Avatar name={c.name} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="break-words font-display text-[30px] font-semibold leading-tight">{c.name}</h1>
          <p className="text-[14px] text-ink-3">
            {data.stats.total ? `${data.stats.total} order${data.stats.total === 1 ? '' : 's'} since ${shortDate(data.stats.first.slice(0, 10))}` : 'No orders yet'}
            {c.preferred_fulfilment ? ` · usually ${c.preferred_fulfilment === 'delivery' ? 'delivery' : 'collects'}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.phone && <a href={`tel:${c.phone}`}><Button icon={<Phone className="size-4" />}>Call</Button></a>}
          {wa && <a href={wa} target="_blank" rel="noreferrer"><Button icon={<MessageCircle className="size-4" />}>WhatsApp</Button></a>}
          {can('customers.write') && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>}
          {can('customers.delete') && <Button variant="danger" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={doDelete}>Delete</Button>}
          {can('orders.write') && <Link to={`/orders/new?customer=${id}`}><Button variant="primary" icon={<Plus className="size-4" />}>New order</Button></Link>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {c.notes && <Card className="border-ochre/30 bg-ochre-soft p-4 text-[15px] text-ochre-soft-ink"><b>Note:</b> {c.notes}</Card>}
          <section>
            <SectionTitle>Open orders · {open.length}</SectionTitle>
            {open.length ? <Card className="overflow-hidden">{open.map((o) => <OrderRow key={o.id} o={o} today={today} />)}</Card> : <EmptyState title="No open orders">{c.name.split(' ')[0]} has nothing in progress.</EmptyState>}
          </section>
          {past.length > 0 && (
            <section>
              <SectionTitle>Previous orders · {past.length}</SectionTitle>
              <Card className="overflow-hidden">{past.slice(0, 20).map((o) => <OrderRow key={o.id} o={o} today={today} dense />)}</Card>
            </section>
          )}
        </div>
        <aside className="min-w-0 space-y-6">
          <section>
            <SectionTitle>Contact</SectionTitle>
            <Card className="space-y-2.5 p-4 text-[14.5px]">
              <div className="flex items-center gap-2"><Phone className="size-4 shrink-0 text-ink-3" /><span className="min-w-0 [overflow-wrap:anywhere]">{c.phone ?? <span className="text-ink-3">No phone</span>}</span></div>
              <div className="flex items-center gap-2"><Mail className="size-4 shrink-0 text-ink-3" /><span className="min-w-0 [overflow-wrap:anywhere]">{c.email ?? <span className="text-ink-3">No email</span>}</span></div>
              <div className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-ink-3" /><span className="min-w-0 whitespace-pre-line [overflow-wrap:anywhere]">{c.address ?? <span className="text-ink-3">No address</span>}</span></div>
            </Card>
          </section>
          {data.frequent.length > 0 && (
            <section>
              <SectionTitle>Usually orders</SectionTitle>
              <Card className="divide-y divide-line">
                {data.frequent.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0"><div className="truncate font-medium">{f.name}</div><div className="text-[12.5px] text-ink-3">Last: {f.usual}</div></div>
                    <span className="shrink-0 text-[13px] text-ink-3">{f.times}×</span>
                  </div>
                ))}
              </Card>
            </section>
          )}
          {data.amendments.length > 0 && (
            <section>
              <SectionTitle>Recent changes</SectionTitle>
              <Card className="divide-y divide-line">
                {data.amendments.map((a, i) => (
                  <Link key={i} to={`/orders/${a.order_id}`} className="block px-4 py-2.5 text-[13.5px] hover:bg-surface-2">
                    <div className="[overflow-wrap:anywhere]">{a.summary}</div>
                    <div className="text-[12px] text-ink-3">#{a.order_number} · {timeAgo(a.created_at)}</div>
                  </Link>
                ))}
              </Card>
            </section>
          )}
          {data.messages.length > 0 && (
            <section>
              <SectionTitle>Messages</SectionTitle>
              <Card className="space-y-2 p-3">
                {data.messages.slice(0, 6).map((m) => (
                  <div key={m.id} className="rounded-xl bg-sunken px-3 py-2 text-[13.5px]">
                    <div className="line-clamp-3 whitespace-pre-line [overflow-wrap:anywhere]">{m.channel === 'form' ? m.body.split('\n\n{')[0] : m.body}</div>
                    <div className="mt-1 text-[11.5px] text-ink-3">{m.channel} · {dateTime(m.received_at)}</div>
                  </div>
                ))}
              </Card>
            </section>
          )}
        </aside>
      </div>
      <CustomerForm open={editing} onClose={() => setEditing(false)} customer={c} />
      {confirm.node}
    </div>
  );
}

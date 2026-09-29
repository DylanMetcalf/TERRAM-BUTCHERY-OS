import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, ListChecks, Search, Trash2, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar, Button, Card, cx, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Segmented, Sheet, Textarea, useConfirm, useToast } from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { timeAgo } from '../lib/format';
import type { Customer } from '../lib/types';
import { LookalikeCustomers } from '../components/pickers';

export default function Customers() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [adding, setAdding] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['customers', debounced], queryFn: () => api.get<{ customers: Customer[]; total: number }>(`/api/customers${qs({ q: debounced, limit: 100 })}`), placeholderData: keepPreviousData });
  const removeMany = useMutation({
    mutationFn: (ids: string[]) => api.post<{ customers: number; orders: number }>('/api/customers/delete', { ids }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast({ tone: 'success', title: `${r.customers} customer${r.customers === 1 ? '' : 's'} deleted`, body: r.orders ? `With ${r.orders} order${r.orders === 1 ? '' : 's'}.` : undefined });
      setPicked(new Set());
      setSelecting(false);
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not delete.' }),
  });
  const chosen = (data?.customers ?? []).filter((c) => picked.has(c.id));
  const deleteChosen = async () => {
    const orders = chosen.reduce((n, c) => n + (c.order_count ?? 0), 0);
    const openOrders = chosen.reduce((n, c) => n + (c.open_orders ?? 0), 0);
    const ok = await confirm.ask({
      title: `Delete ${chosen.length} customer${chosen.length === 1 ? '' : 's'}?`,
      body: (
        <>
          {chosen.slice(0, 6).map((c) => c.name).join(', ')}{chosen.length > 6 ? ` and ${chosen.length - 6} more` : ''} will be removed for good{orders ? <>, <b>with {orders} order{orders === 1 ? '' : 's'}</b></> : ''}. This can’t be undone.
          {openOrders > 0 && <span className="mt-2 block font-medium text-danger">{openOrders} of these orders {openOrders === 1 ? 'is' : 'are'} still open.</span>}
        </>
      ),
      confirm: 'Delete for good',
      tone: 'danger',
    });
    if (ok) removeMany.mutate(chosen.map((c) => c.id));
  };
  const toggle = (cid: string) => setPicked((s) => { const n = new Set(s); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  return (
    <div className="animate-rise">
      <PageHeader
        title="Customers"
        subtitle={data ? `${data.total} customer${data.total === 1 ? '' : 's'}` : ' '}
        actions={
          <>
            {can('customers.delete') && !!data?.customers.length && (
              <Button icon={<ListChecks className="size-4" />} onClick={() => { setSelecting(!selecting); setPicked(new Set()); }}>{selecting ? 'Done' : 'Select'}</Button>
            )}
            {can('customers.write') && !selecting && <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>Add customer</Button>}
          </>
        }
      />
      {selecting && (
        <div className="sticky top-16 z-10 mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
          <span className="text-[14.5px] font-medium">{picked.size ? `${picked.size} selected` : 'Tap customers to select them'}</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPicked(picked.size === data?.customers.length ? new Set() : new Set(data?.customers.map((c) => c.id)))}>{picked.size === data?.customers.length ? 'Clear' : 'Select all'}</Button>
            <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} disabled={!picked.size} loading={removeMany.isPending} onClick={deleteChosen}>Delete</Button>
          </div>
        </div>
      )}
      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, phone or email" className="h-11 pl-9" aria-label="Search customers" />
      </div>
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock />
      ) : !data?.customers.length ? (
        <EmptyState icon={<Users className="size-6" />} title={debounced ? 'No customers found' : 'No customers yet'}>{debounced ? 'Try another name or number.' : 'Customers are added automatically when orders come in.'}</EmptyState>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {data.customers.map((c) => {
            const inner = (
              <>
              {selecting ? (
                <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full border-2', picked.has(c.id) ? 'border-brand bg-brand text-brand-ink' : 'border-line-strong bg-surface')}>{picked.has(c.id) && <Check className="size-4" strokeWidth={3} />}</span>
              ) : (
                <Avatar name={c.name} />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{c.name}</div>
                <div className="truncate text-[13px] text-ink-3">{[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'}</div>
              </div>
              <div className="hidden text-right text-[13px] sm:block">
                <div className="font-medium">{c.order_count ?? 0} order{c.order_count === 1 ? '' : 's'}</div>
                <div className="text-ink-3">{c.last_order_at ? `Last ${timeAgo(c.last_order_at)}` : 'No orders yet'}</div>
              </div>
              {!!c.open_orders && <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[12px] font-semibold text-brand-soft-ink">{c.open_orders} open</span>}
              {!selecting && <ChevronRight className="size-4 shrink-0 text-ink-3" />}
              </>
            );
            return selecting ? (
              <button key={c.id} type="button" onClick={() => toggle(c.id)} aria-pressed={picked.has(c.id)} className={cx('flex w-full items-center gap-3 px-4 py-3 text-left', picked.has(c.id) ? 'bg-brand-soft/60' : 'hover:bg-surface-2')}>{inner}</button>
            ) : (
              <Link key={c.id} to={`/customers/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">{inner}</Link>
            );
          })}
        </Card>
      )}
      <CustomerForm open={adding} onClose={() => setAdding(false)} />
      {confirm.node}
    </div>
  );
}

export function CustomerForm({ open, onClose, customer }: { open: boolean; onClose: () => void; customer?: Customer }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [v, setV] = useState({ name: '', phone: '', email: '', address: '', notes: '', preferred_fulfilment: '' as '' | 'collection' | 'delivery' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) setV({ name: customer?.name ?? '', phone: customer?.phone ?? '', email: customer?.email ?? '', address: customer?.address ?? '', notes: customer?.notes ?? '', preferred_fulfilment: customer?.preferred_fulfilment ?? '' });
  }, [open, customer]);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...v, phone: v.phone || null, email: v.email || null, address: v.address || null, notes: v.notes || null, preferred_fulfilment: v.preferred_fulfilment || null };
      return customer ? api.patch<{ customer: Customer }>(`/api/customers/${customer.id}`, body) : api.post<{ customer: Customer }>('/api/customers', body);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['customer'] });
      toast({ tone: 'success', title: customer ? 'Customer updated' : 'Customer added' });
      onClose();
      if (!customer) navigate(`/customers/${r.customer.id}`);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Sheet open={open} onClose={onClose} title={customer ? 'Edit customer' : 'New customer'} footer={<Button variant="primary" size="lg" full disabled={!v.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} big /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone" optional><Input inputMode="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
          <Field label="Email" optional><Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        </div>
        <Field label="Address" optional><Textarea rows={2} value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} /></Field>
        <Field label="Usually">
          <Segmented full value={v.preferred_fulfilment} onChange={(x) => setV({ ...v, preferred_fulfilment: x })} options={[{ value: '', label: 'No preference' }, { value: 'collection', label: 'Collects' }, { value: 'delivery', label: 'Delivery' }]} />
        </Field>
        <Field label="Notes" optional hint="Shown on every order — e.g. “likes steaks thick”, “gate code 1234”."><Textarea rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        {!customer && <LookalikeCustomers name={v.name} phone={v.phone} email={v.email} useLabel="Open" onUse={(x) => { onClose(); navigate(`/customers/${x.id}`); }} />}
        {err && <p className="text-[14px] text-danger">{err}</p>}
      </div>
    </Sheet>
  );
}

import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Store, Trash2, Truck, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ItemEditor, type ItemDraft } from '../components/ItemEditor';
import { CustomerPicker, LookalikeCustomers, NewCustomerFields, useProducts } from '../components/pickers';
import { Avatar, Button, Card, cx, Field, Input, PageHeader, SectionTitle, Segmented, Sheet, Textarea, useToast } from '../components/ui';
import { api, ApiError, newKey } from '../lib/api';
import { addDays, estimateLinePrice, formatMoney, formatQty, friendlyDate, todayYmd, weekdayShort } from '../lib/format';
import type { Customer } from '../lib/types';

const DRAFT_KEY = 'terram:new-order-draft';

interface Draft {
  customer: Customer | null;
  newCustomer: { name: string; phone: string; email: string } | null;
  items: (ItemDraft & { key: string })[];
  fulfilment: 'collection' | 'delivery';
  date: string;
  time: string;
  address: string;
  notes: string;
  source: 'phone' | 'manual' | 'whatsapp' | 'email';
  idem: string;
}

function blank(): Draft {
  return { customer: null, newCustomer: null, items: [], fulfilment: 'collection', date: '', time: '', address: '', notes: '', source: 'phone', idem: newKey() };
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { ...blank(), ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return blank();
}

export default function NewOrder() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: productData } = useProducts();
  const [d, setD] = useState<Draft>(loadDraft);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [editing, setEditing] = useState<null | { index: number | null; initial?: Partial<ItemDraft> }>(null);
  const [error, setError] = useState<string | null>(null);
  const today = todayYmd();
  const products = productData?.products ?? [];
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Started from a customer's page ("New order" there): fill that customer in
  const [params, setParams] = useSearchParams();
  const fromCustomer = params.get('customer');
  useEffect(() => {
    if (!fromCustomer) return;
    api
      .get<{ customer: Customer }>(`/api/customers/${fromCustomer}`)
      .then((r) => setD((x) => ({ ...x, customer: r.customer, newCustomer: null, fulfilment: r.customer.preferred_fulfilment ?? x.fulfilment })))
      .catch(() => undefined)
      .finally(() => setParams({}, { replace: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromCustomer]);

  useEffect(() => {
    try {
      if (d.customer || d.newCustomer || d.items.length) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {
      /* ignore */
    }
  }, [d]);

  const { data: history } = useQuery({
    queryKey: ['customer', d.customer?.id],
    queryFn: () => api.get<any>(`/api/customers/${d.customer!.id}`),
    enabled: !!d.customer?.id,
  });

  const create = useMutation({
    mutationFn: (status: 'confirmed' | 'review') =>
      api.post<{ order: { id: string; order_number: number } }>(
        '/api/orders',
        {
          customer_id: d.customer?.id,
          customer: d.customer ? undefined : { name: d.newCustomer?.name ?? '', phone: d.newCustomer?.phone || null, email: d.newCustomer?.email || null },
          source: d.source,
          status,
          items: d.items.map(({ key, ...i }) => i),
          fulfilment_type: d.fulfilment,
          requested_date: d.date || null,
          time_window: d.time || null,
          delivery_address: d.fulfilment === 'delivery' ? d.address || null : null,
          notes: d.notes || null,
        },
        { idempotencyKey: d.idem },
      ),
    onSuccess: (r, status) => {
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      toast({ tone: 'success', title: status === 'confirmed' ? `Order #${r.order.order_number} confirmed` : `Order #${r.order.order_number} saved for review` });
      navigate(`/orders/${r.order.id}`, { replace: true });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the order.'),
  });

  const hasCustomer = !!d.customer || !!d.newCustomer?.name.trim();
  const canSubmit = hasCustomer && d.items.length > 0 && (d.fulfilment === 'collection' || !!d.address.trim() || !!d.customer?.address);
  const dateChips = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const total = d.items.reduce<number | null>((s, i) => {
    const p = byId.get(i.product_id);
    const v = p ? estimateLinePrice(i.qty, p.price_cents, p.price_unit) : null;
    return s == null || v == null ? null : s + v;
  }, 0);
  const set = (patch: Partial<Draft>) => setD((s) => ({ ...s, ...patch }));

  return (
    <div className="animate-rise pb-24 lg:pb-0">
      <PageHeader
        title="New order"
        subtitle="For phone calls, walk-ins and anything typed by hand."
        actions={(d.items.length > 0 || hasCustomer) && <Button variant="ghost" icon={<X className="size-4" />} onClick={() => { setD(blank()); try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }}>Start over</Button>}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          {/* Customer */}
          <section>
            <SectionTitle>1 · Customer</SectionTitle>
            {d.customer ? (
              <Card className="flex items-center gap-3 p-4">
                <Avatar name={d.customer.name} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{d.customer.name}</div>
                  <div className="text-[13px] text-ink-3">{d.customer.phone ?? 'No phone'}{history?.stats?.total ? ` · ${history.stats.total} previous orders` : ''}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setPickCustomer(true)}>Change</Button>
              </Card>
            ) : d.newCustomer ? (
              <Card className="p-4">
                <div className="mb-3 flex items-center justify-between"><span className="text-[14px] font-semibold">New customer</span><Button size="sm" variant="ghost" onClick={() => set({ newCustomer: null })}>Cancel</Button></div>
                <NewCustomerFields value={d.newCustomer} onChange={(v) => set({ newCustomer: v })} />
                <LookalikeCustomers
                  name={d.newCustomer.name}
                  phone={d.newCustomer.phone}
                  email={d.newCustomer.email}
                  onUse={async (x) => {
                    const r = await api.get<{ customer: Customer }>(`/api/customers/${x.id}`);
                    set({ customer: r.customer, newCustomer: null, fulfilment: r.customer.preferred_fulfilment ?? d.fulfilment });
                  }}
                />
              </Card>
            ) : (
              <button onClick={() => setPickCustomer(true)} className="flex w-full items-center gap-3 rounded-2xl border-2 border-dashed border-line-strong bg-surface px-4 py-5 text-left transition hover:border-brand hover:bg-brand-soft/40">
                <span className="flex size-10 items-center justify-center rounded-xl bg-sunken text-ink-2"><UserRound className="size-5" /></span>
                <span><span className="block font-semibold">Choose a customer</span><span className="text-[13.5px] text-ink-3">Search by name or phone, or add someone new</span></span>
              </button>
            )}
            {history?.frequent?.length > 0 && (
              <div className="mt-3">
                <div className="mb-2 text-[13px] font-medium text-ink-3">Usually orders — tap to add</div>
                <div className="flex flex-wrap gap-2">
                  {history.frequent.slice(0, 6).map((f: any) => (
                    <button key={f.id} onClick={() => setEditing({ index: null, initial: { product_id: f.id } })} className="rounded-xl border border-line bg-surface px-3 py-2 text-left text-[13.5px] transition hover:border-brand active:scale-95">
                      <span className="font-medium">{f.name}</span>
                      <span className="block text-[12px] text-ink-3">{f.usual}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Items */}
          <section>
            <SectionTitle>2 · Products</SectionTitle>
            <Card className="overflow-hidden">
              {d.items.map((i, idx) => {
                const p = byId.get(i.product_id);
                const prepLabel = p ? Object.entries(i.preparation).filter(([g, v]) => p.preparations.find((o) => o.group_name === g && o.name === v && !o.is_default)).map(([, v]) => v).join(' · ') : '';
                return (
                  <div key={i.key} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{p?.canonical_name ?? '…'}</div>
                      <div className="text-[13px] text-ink-2">{[prepLabel, i.special_instructions && `“${i.special_instructions}”`].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="font-display text-[18px] font-semibold tabular">{formatQty(i.qty, p?.piece_noun)}</div>
                    <button onClick={() => setEditing({ index: idx, initial: i })} className="rounded-lg p-2 text-ink-3 hover:bg-sunken" aria-label="Edit"><Pencil className="size-4" /></button>
                    <button onClick={() => set({ items: d.items.filter((_, j) => j !== idx) })} className="rounded-lg p-2 text-ink-3 hover:bg-danger-soft hover:text-danger" aria-label="Remove"><Trash2 className="size-4" /></button>
                  </div>
                );
              })}
              <button onClick={() => setEditing({ index: null })} className="flex w-full items-center justify-center gap-2 px-4 py-4 text-[15px] font-semibold text-brand hover:bg-brand-soft/40">
                <Plus className="size-5" /> Add product
              </button>
            </Card>
          </section>

          {/* Fulfilment */}
          <section>
            <SectionTitle>3 · Collection or delivery</SectionTitle>
            <Card className="space-y-5 p-4 sm:p-5">
              <Segmented full size="lg" value={d.fulfilment} onChange={(v) => set({ fulfilment: v })} options={[{ value: 'collection', label: <><Store className="size-4" />Collection</> }, { value: 'delivery', label: <><Truck className="size-4" />Delivery</> }]} />
              <div>
                <div className="mb-2 text-[13px] font-medium text-ink-2">When?</div>
                <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-none">
                  {dateChips.map((ymd, i) => (
                    <button key={ymd} onClick={() => set({ date: d.date === ymd ? '' : ymd })} className={cx('flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-2xl border text-center transition active:scale-95', d.date === ymd ? 'border-brand bg-brand text-brand-ink' : 'border-line-strong bg-surface hover:border-ink-3')}>
                      <span className="text-[11px] font-semibold uppercase opacity-80">{i === 0 ? 'Today' : i === 1 ? 'Tmrw' : weekdayShort(ymd)}</span>
                      <span className="font-display text-[20px] font-semibold leading-none">{Number(ymd.slice(8))}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Input type="date" value={d.date} onChange={(e) => set({ date: e.target.value })} className="w-44" aria-label="Other date" />
                  <p className="text-[13px] text-ink-3">{d.date ? friendlyDate(d.date, today, { long: true }) : 'No date yet — you can add it later.'}</p>
                </div>
              </div>
              <Field label="Time" optional><Input value={d.time} onChange={(e) => set({ time: e.target.value })} placeholder="e.g. after 2pm" /></Field>
              {d.fulfilment === 'delivery' && (
                <Field label="Delivery address" hint={!d.address && d.customer?.address ? `Leave empty to use ${d.customer.address}` : undefined}>
                  <Textarea rows={2} value={d.address} onChange={(e) => set({ address: e.target.value })} placeholder={d.customer?.address ?? 'Street, town'} />
                </Field>
              )}
            </Card>
          </section>

          <section>
            <SectionTitle>4 · Anything else</SectionTitle>
            <Card className="space-y-4 p-4 sm:p-5">
              <Field label="How did the order come in?">
                <Segmented full value={d.source} onChange={(v) => set({ source: v })} options={[{ value: 'phone', label: 'Phone' }, { value: 'manual', label: 'In person' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'email', label: 'Email' }]} />
              </Field>
              <Field label="Order notes" optional><Textarea rows={2} value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
            </Card>
          </section>
        </div>

        {/* Summary */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <Card className="hidden p-5 lg:block">
            <h2 className="font-display text-xl font-semibold">Summary</h2>
            <dl className="mt-3 space-y-1.5 text-[14px]">
              <div className="flex justify-between"><dt className="text-ink-3">Customer</dt><dd className="font-medium">{d.customer?.name ?? d.newCustomer?.name ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-3">Products</dt><dd className="font-medium">{d.items.length}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-3">{d.fulfilment === 'delivery' ? 'Delivery' : 'Collection'}</dt><dd className="font-medium">{friendlyDate(d.date || null, today)}</dd></div>
              {total != null && total > 0 && <div className="flex justify-between border-t border-line pt-2"><dt className="text-ink-3">Estimated</dt><dd className="font-semibold">{formatMoney(total)}</dd></div>}
            </dl>
            {error && <p className="mt-4 rounded-xl bg-danger-soft px-3 py-2 text-[13.5px] text-danger-soft-ink">{error}</p>}
            <div className="mt-5 space-y-2">
              <Button variant="primary" size="lg" full disabled={!canSubmit} loading={create.isPending && create.variables === 'confirmed'} onClick={() => create.mutate('confirmed')}>Create & confirm</Button>
              <Button full disabled={!canSubmit} loading={create.isPending && create.variables === 'review'} onClick={() => create.mutate('review')}>Save for review</Button>
            </div>
            <p className="mt-3 text-[12px] text-ink-3">Your draft is kept on this device until you create the order.</p>
          </Card>
        </aside>
      </div>

      {/* Mobile sticky action bar */}
      <div className="safe-bottom fixed inset-x-0 bottom-[68px] z-20 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur lg:hidden">
        {error && <p className="mb-2 text-[13px] text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={!canSubmit} onClick={() => create.mutate('review')} loading={create.isPending && create.variables === 'review'}>For review</Button>
          <Button className="flex-[1.4]" variant="primary" disabled={!canSubmit} onClick={() => create.mutate('confirmed')} loading={create.isPending && create.variables === 'confirmed'}>Create & confirm</Button>
        </div>
      </div>

      <Sheet open={pickCustomer} onClose={() => setPickCustomer(false)} title="Customer">
        <CustomerPicker
          onPick={(c) => {
            set({ customer: c, newCustomer: null, address: d.address || '' , fulfilment: c.preferred_fulfilment ?? d.fulfilment });
            setPickCustomer(false);
          }}
          onCreate={(name) => {
            const phone = /^[\d\s+()-]{6,}$/.test(name) ? name : '';
            set({ customer: null, newCustomer: { name: phone ? '' : name, phone, email: '' } });
            setPickCustomer(false);
          }}
        />
      </Sheet>
      <ItemEditor
        open={!!editing}
        onClose={() => setEditing(null)}
        initial={editing?.initial}
        onSave={(item) => {
          if (editing?.index != null) set({ items: d.items.map((x, j) => (j === editing.index ? { ...item, key: x.key } : x)) });
          else set({ items: [...d.items, { ...item, key: newKey() }] });
          setEditing(null);
        }}
      />
    </div>
  );
}

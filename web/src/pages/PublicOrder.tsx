import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Plus, ShoppingBag, Store, Trash2, Truck, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Logo } from '../components/order-bits';
import { QuantityInput } from '../components/quantity-input';
import { Button, Card, cx, Field, Input, Segmented, Sheet, Spinner, Textarea } from '../components/ui';
import { api, ApiError, newKey } from '../lib/api';
import { addDays, estimateLinePrice, formatMoney, formatQty, friendlyDate, longDate } from '../lib/format';
import { useOnline } from '../lib/realtime';
import type { Qty, QuantityType } from '../lib/types';

interface CatProduct {
  id: string;
  name: string;
  category: string;
  description: string | null;
  quantity_type: QuantityType;
  allows_portions: boolean;
  piece_noun: string;
  typical_piece_g: number | null;
  price_cents: number | null;
  price_unit: 'kg' | 'each' | null;
  options: { group: string; options: { name: string; is_default: boolean }[] }[];
}
interface Line { key: string; product_id: string; qty: Qty; preparation: Record<string, string>; special_instructions: string }
interface State { step: 0 | 1 | 2 | 3; lines: Line[]; name: string; phone: string; email: string; fulfilment: 'collection' | 'delivery'; date: string; address: string; notes: string; client_ref: string }

const KEY = 'terram:customer-order';
const CATS = ['Beef', 'Lamb', 'Pork', 'Chicken', 'Sausages', 'Other'];

function initial(): State {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return JSON.parse(s);
  } catch {
    /* ignore */
  }
  return { step: 0, lines: [], name: '', phone: '', email: '', fulfilment: 'collection', date: '', address: '', notes: '', client_ref: newKey() };
}

export default function PublicOrder() {
  const online = useOnline();
  const { data: info, error: infoErr } = useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info') });
  const { data: cat } = useQuery({ queryKey: ['catalogue'], queryFn: () => api.get<{ products: CatProduct[] }>('/api/public/catalogue') });
  const [s, setS] = useState<State>(initial);
  const [adding, setAdding] = useState<{ p: CatProduct; line?: Line } | null>(null);
  const [cat_, setCat] = useState('All');
  const [done, setDone] = useState<{ number: number | null; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try {
      if (!done) localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }, [s, done]);
  useEffect(() => {
    document.title = info ? `Order · ${info.business.name}` : 'Order';
  }, [info]);
  useEffect(() => window.scrollTo({ top: 0 }), [s.step]);
  const set = (p: Partial<State>) => setS((x) => ({ ...x, ...p }));
  const products = cat?.products ?? [];
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const cats = ['All', ...CATS.filter((c) => products.some((p) => p.category === c))];
  const shown = products.filter((p) => cat_ === 'All' || p.category === cat_);
  const total = s.lines.reduce<number | null>((sum, l) => {
    const p = byId.get(l.product_id);
    const v = p ? estimateLinePrice(l.qty, p.price_cents, p.price_unit) : null;
    return sum == null || v == null ? null : sum + v;
  }, 0);
  const submit = useMutation({
    mutationFn: () =>
      api.post<{ order_number: number | null; message: string }>('/api/public/orders', {
        customer: { name: s.name, phone: s.phone, email: s.email || undefined },
        items: s.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, preparation: l.preparation, special_instructions: l.special_instructions || null })),
        fulfilment_type: s.fulfilment,
        requested_date: s.date,
        delivery_address: s.fulfilment === 'delivery' ? s.address : null,
        notes: s.notes || null,
        client_ref: s.client_ref,
      }),
    onSuccess: (r) => {
      setDone({ number: r.order_number, message: r.message });
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.'),
  });

  if (infoErr) return <Shell><p className="py-20 text-center text-ink-2">We can’t load the order form right now. Please try again in a moment.</p></Shell>;
  if (!info || !cat) return <Shell><div className="flex justify-center py-24"><Spinner className="size-6" /></div></Shell>;
  if (!info.form.enabled) return <Shell business={info.business}><Card className="mx-auto mt-10 max-w-md p-8 text-center"><h1 className="font-display text-2xl font-semibold">Online ordering is paused</h1><p className="mt-2 text-ink-2">Please contact us directly{info.business.phone ? ` on ${info.business.phone}` : ''}.</p></Card></Shell>;

  if (done)
    return (
      <Shell business={info.business}>
        <div className="mx-auto max-w-md animate-rise py-12 text-center">
          <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-field text-white"><Check className="size-8 animate-pop" strokeWidth={3} /></span>
          <h1 className="mt-6 font-display text-3xl font-semibold">Order received</h1>
          {done.number && <p className="mt-1 text-[15px] text-ink-3">Reference #{done.number}</p>}
          <p className="mt-4 text-[16px] leading-relaxed text-ink-2">{done.message}</p>
          <Button className="mt-8" onClick={() => { setDone(null); setS({ ...initial(), step: 0, lines: [], client_ref: newKey() }); }}>Place another order</Button>
        </div>
      </Shell>
    );

  const allowedDays: number[] = s.fulfilment === 'delivery' ? info.fulfilment.deliveryDays : info.fulfilment.collectionDays;
  const dates = Array.from({ length: 21 }, (_, i) => addDays(info.earliest_date, i)).filter((d) => allowedDays.includes(new Date(d + 'T00:00:00Z').getUTCDay())).slice(0, 8);
  const detailsOk = s.name.trim().length >= 2 && s.phone.replace(/\D/g, '').length >= 9;
  const whenOk = !!s.date && (s.fulfilment === 'collection' || s.address.trim().length > 5);
  const steps = ['Choose', 'Your details', 'Collection or delivery', 'Check & send'];

  return (
    <Shell business={info.business} cartCount={s.lines.length} onCart={() => set({ step: 0 })}>
      {!online && <div className="mb-4 flex items-center gap-2 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink"><WifiOff className="size-4" /> You’re offline. Your order is saved on this device — send it when you’re back online.</div>}
      <ol className="mb-6 flex gap-1.5" aria-label="Progress">
        {steps.map((t, i) => (
          <li key={t} className="flex-1">
            <div className={cx('h-1.5 rounded-full', i <= s.step ? 'bg-brand' : 'bg-line')} />
            <div className={cx('mt-1.5 hidden text-[12px] font-medium sm:block', i === s.step ? 'text-ink' : 'text-ink-3')}>{t}</div>
          </li>
        ))}
      </ol>

      {s.step === 0 && (
        <div className="animate-rise pb-28">
          <h1 className="font-display text-[30px] font-semibold leading-tight">What would you like?</h1>
          <p className="mt-2 max-w-xl text-[15.5px] text-ink-2">{info.form.intro}</p>
          <div className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none">
            {cats.map((c) => (
              <button key={c} onClick={() => setCat(c)} className={cx('h-10 shrink-0 rounded-full border px-4 text-[14px] font-medium', cat_ === c ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2')}>{c}</button>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {shown.map((p) => {
              const inCart = s.lines.filter((l) => l.product_id === p.id);
              return (
                <button key={p.id} onClick={() => setAdding({ p })} className={cx('flex items-start gap-3 rounded-2xl border bg-surface p-4 text-left shadow-card transition hover:shadow-float active:scale-[0.99]', inCart.length ? 'border-brand/50' : 'border-line')}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[16px] font-semibold">{p.name}</div>
                    {p.description && <div className="mt-0.5 text-[13.5px] text-ink-2">{p.description}</div>}
                    <div className="mt-1.5 text-[13px] text-ink-3">
                      {p.price_cents != null && <span className="font-medium text-ink-2">{formatMoney(p.price_cents, info.currency)}/{p.price_unit}</span>}
                      {p.price_cents != null && ' · '}
                      {p.quantity_type === 'weight' ? 'by weight' : p.quantity_type === 'count' ? `per ${p.piece_noun}` : `by weight or per ${p.piece_noun}`}
                    </div>
                    {inCart.length > 0 && <div className="mt-2 text-[13px] font-semibold text-brand">In your order: {inCart.map((l) => formatQty(l.qty, p.piece_noun)).join(', ')}</div>}
                  </div>
                  <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-xl', inCart.length ? 'bg-brand text-brand-ink' : 'bg-sunken text-ink-2')}>{inCart.length ? <Check className="size-4" /> : <Plus className="size-4" />}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {s.step === 1 && (
        <div className="mx-auto max-w-lg animate-rise pb-28">
          <h1 className="font-display text-[28px] font-semibold">Your details</h1>
          <p className="mt-1 text-ink-2">So we can confirm your order and let you know when it’s ready.</p>
          <div className="mt-6 space-y-4">
            <Field label="Name" htmlFor="n"><Input id="n" big autoComplete="name" value={s.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Mobile number" htmlFor="p" hint="We’ll use WhatsApp or SMS for updates."><Input id="p" big type="tel" inputMode="tel" autoComplete="tel" value={s.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="Email" htmlFor="e" optional><Input id="e" big type="email" autoComplete="email" value={s.email} onChange={(e) => set({ email: e.target.value })} /></Field>
          </div>
        </div>
      )}

      {s.step === 2 && (
        <div className="mx-auto max-w-lg animate-rise pb-28">
          <h1 className="font-display text-[28px] font-semibold">Collection or delivery?</h1>
          <div className="mt-5">
            {info.fulfilment.deliveryEnabled ? (
              <Segmented full size="lg" value={s.fulfilment} onChange={(v) => set({ fulfilment: v, date: '' })} options={[{ value: 'collection', label: <><Store className="size-4" />Collect</> }, { value: 'delivery', label: <><Truck className="size-4" />Delivery</> }]} />
            ) : (
              <p className="text-ink-2">Orders are for collection at the farm.</p>
            )}
            <p className="mt-2 text-[13.5px] text-ink-3">{s.fulfilment === 'collection' ? `Collection hours: ${info.fulfilment.collectionHours}` : info.fulfilment.deliveryNotes}</p>
          </div>
          <Field label="Which day?" className="mt-6">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {dates.map((d) => (
                <button key={d} onClick={() => set({ date: d })} className={cx('rounded-xl border px-3 py-3 text-left transition', s.date === d ? 'border-brand bg-brand text-brand-ink' : 'border-line-strong bg-surface hover:border-ink-3')}>
                  <div className="text-[14px] font-semibold">{friendlyDate(d, info.today)}</div>
                  {!['Today', 'Tomorrow'].includes(friendlyDate(d, info.today)) ? null : <div className="text-[12px] opacity-80">{longDate(d).split(' ').slice(0, 3).join(' ')}</div>}
                </button>
              ))}
            </div>
            {!dates.length && <p className="text-[14px] text-ink-3">No days are available right now — please contact us.</p>}
          </Field>
          {s.fulfilment === 'delivery' && <Field label="Delivery address" className="mt-5"><Textarea rows={3} value={s.address} onChange={(e) => set({ address: e.target.value })} autoComplete="street-address" /></Field>}
          <Field label="Anything we should know?" optional className="mt-5"><Textarea rows={2} value={s.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. it’s for a braai for 10 people" /></Field>
        </div>
      )}

      {s.step === 3 && (
        <div className="mx-auto max-w-lg animate-rise pb-28">
          <h1 className="font-display text-[28px] font-semibold">Check your order</h1>
          <Card className="mt-5 divide-y divide-line">
            {s.lines.map((l) => {
              const p = byId.get(l.product_id);
              const prep = Object.values(l.preparation).filter((v) => !p?.options.some((g) => g.options.some((o) => o.name === v && o.is_default)));
              return (
                <div key={l.key} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div><div className="font-semibold">{p?.name}</div><div className="text-[13.5px] text-ink-2">{[prep.join(', '), l.special_instructions].filter(Boolean).join(' · ')}</div></div>
                  <div className="shrink-0 font-semibold">{formatQty(l.qty, p?.piece_noun)}</div>
                </div>
              );
            })}
            {total != null && total > 0 && <div className="flex justify-between px-4 py-3 text-[14px]"><span className="text-ink-2">Estimated total</span><span className="font-semibold">{formatMoney(total, info.currency)}</span></div>}
          </Card>
          <Card className="mt-3 space-y-1 p-4 text-[14.5px]">
            <div><b>{s.name}</b> · {s.phone}</div>
            <div>{s.fulfilment === 'delivery' ? `Delivery to ${s.address}` : 'Collection'} · {s.date && longDate(s.date)}</div>
            {s.notes && <div className="text-ink-2">“{s.notes}”</div>}
          </Card>
          <p className="mt-4 text-[13.5px] text-ink-3">Prices are estimates — meat is priced by final weight. We’ll confirm your order before it’s prepared.</p>
          {error && <p className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">{error}</p>}
        </div>
      )}

      {/* Sticky action bar */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          {s.step > 0 && <Button size="lg" variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => set({ step: (s.step - 1) as State['step'] })}>Back</Button>}
          {s.step === 0 && (
            <div className="min-w-0 flex-1 text-[14px]">
              <div className="font-semibold">{s.lines.length ? `${s.lines.length} item${s.lines.length === 1 ? '' : 's'}` : 'Nothing chosen yet'}</div>
              {total != null && total > 0 && <div className="text-ink-3">≈ {formatMoney(total, info.currency)}</div>}
            </div>
          )}
          <div className={cx('flex', s.step > 0 && 'flex-1 justify-end')}>
            {s.step < 3 ? (
              <Button variant="primary" size="lg" disabled={(s.step === 0 && !s.lines.length) || (s.step === 1 && !detailsOk) || (s.step === 2 && !whenOk)} onClick={() => set({ step: (s.step + 1) as State['step'] })}>Continue</Button>
            ) : (
              <Button variant="primary" size="lg" disabled={!online} loading={submit.isPending} onClick={() => { setError(null); submit.mutate(); }}>Send order</Button>
            )}
          </div>
        </div>
      </div>

      {adding && (
        <AddSheet
          p={adding.p}
          existing={s.lines.filter((l) => l.product_id === adding.p.id)}
          currency={info.currency}
          onClose={() => setAdding(null)}
          onRemove={(key) => set({ lines: s.lines.filter((l) => l.key !== key) })}
          onAdd={(l) => { set({ lines: [...s.lines, l] }); setAdding(null); }}
        />
      )}
    </Shell>
  );
}

function AddSheet({ p, existing, onAdd, onRemove, onClose, currency }: { p: CatProduct; existing: Line[]; onAdd: (l: Line) => void; onRemove: (key: string) => void; onClose: () => void; currency: string }) {
  const [qty, setQty] = useState<Qty | null>(null);
  const [prep, setPrep] = useState<Record<string, string>>(() => Object.fromEntries(p.options.map((g) => [g.group, g.options.find((o) => o.is_default)?.name ?? g.options[0]?.name]).filter(([, v]) => v)));
  const [note, setNote] = useState('');
  const price = qty ? estimateLinePrice(qty, p.price_cents, p.price_unit) : null;
  return (
    <Sheet open onClose={onClose} title={p.name} subtitle={p.description ?? undefined} footer={<Button variant="primary" size="lg" full disabled={!qty} onClick={() => qty && onAdd({ key: newKey(), product_id: p.id, qty, preparation: prep, special_instructions: note.trim() })} icon={<ShoppingBag className="size-4" />}>Add to order{price != null ? ` · ≈ ${formatMoney(price, currency)}` : ''}</Button>}>
      <div className="space-y-6">
        {existing.length > 0 && (
          <div className="space-y-2">
            {existing.map((l) => (
              <div key={l.key} className="flex items-center justify-between rounded-xl bg-brand-soft px-3 py-2 text-[14px] text-brand-soft-ink">
                <span>Already added: <b>{formatQty(l.qty, p.piece_noun)}</b></span>
                <button onClick={() => onRemove(l.key)} className="rounded-lg p-1.5 hover:bg-white/40" aria-label="Remove"><Trash2 className="size-4" /></button>
              </div>
            ))}
          </div>
        )}
        <Field label="How much?">
          <QuantityInput value={qty} onChange={setQty} quantityType={p.quantity_type} allowsPortions={p.allows_portions} pieceNoun={p.piece_noun} />
          {p.typical_piece_g && p.quantity_type !== 'weight' && <p className="mt-2 text-[13px] text-ink-3">One {p.piece_noun} is about {p.typical_piece_g >= 1000 ? `${p.typical_piece_g / 1000}kg` : `${p.typical_piece_g}g`}.</p>}
        </Field>
        {p.options.map((g) => (
          <Field key={g.group} label={g.group}>
            <div className="flex flex-wrap gap-2">
              {g.options.map((o) => (
                <button key={o.name} type="button" onClick={() => setPrep((x) => ({ ...x, [g.group]: o.name }))} className={cx('h-11 rounded-xl border px-4 text-[14.5px] font-medium', prep[g.group] === o.name ? 'border-brand bg-brand-soft text-brand-soft-ink' : 'border-line-strong bg-surface text-ink-2')}>{o.name}</button>
              ))}
            </div>
          </Field>
        ))}
        <Field label="Special requests" optional><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. extra thick" /></Field>
      </div>
    </Sheet>
  );
}

function Shell({ children, business, cartCount, onCart }: { children: React.ReactNode; business?: any; cartCount?: number; onCart?: () => void }) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <div className="flex items-center gap-3"><Logo withWord={false} /><div><div className="font-display text-[18px] font-semibold leading-none">{business?.name ?? 'Terram Farm'}</div><div className="mt-1 text-[12px] text-ink-3">{business?.tagline ?? ''}</div></div></div>
          {!!cartCount && <button onClick={onCart} className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1.5 text-[13px] font-semibold"><ShoppingBag className="size-4" />{cartCount}</button>}
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  );
}


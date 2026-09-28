import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Pencil, Plus, Search, ShoppingBag, Store, Trash2, Truck, WifiOff, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Logo } from '../components/order-bits';
import { BackToTop } from '../components/BackToTop';
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
  pack_size: number | null;
  price_cents: number | null;
  price_unit: 'kg' | 'each' | null;
  options: { group: string; options: { name: string; is_default: boolean }[] }[];
}
interface Line { key: string; product_id: string; qty: Qty; preparation: Record<string, string>; special_instructions: string }
interface State { step: 0 | 1 | 2 | 3; lines: Line[]; name: string; phone: string; email: string; fulfilment: 'collection' | 'delivery'; date: string; address: string; notes: string; client_ref: string; accepted?: boolean; special?: string }

const KEY = 'terram:customer-order';
/** The customer's own details, kept on their device after an order so they don't retype them next time. */
const ME_KEY = 'terram:customer-me';
type Me = { name: string; phone: string; email: string; address: string };
function loadMe(): Me | null {
  try {
    const m = localStorage.getItem(ME_KEY);
    return m ? JSON.parse(m) : null;
  } catch {
    return null;
  }
}
/** "Beef – Steaks" → chip "Beef", section "Steaks" (matches the printed price lists). */
const topLevel = (category: string) => category.split(/\s+[–-]\s+/)[0];
const subLevel = (category: string) => category.split(/\s+[–-]\s+/).slice(1).join(' – ') || category;

function initial(): State {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return JSON.parse(s);
  } catch {
    /* ignore */
  }
  const me = loadMe();
  return { step: 0, lines: [], name: me?.name ?? '', phone: me?.phone ?? '', email: me?.email ?? '', fulfilment: 'collection', date: '', address: me?.address ?? '', notes: '', client_ref: newKey() };
}

export default function PublicOrder() {
  const online = useOnline();
  const { data: info, error: infoErr } = useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info') });
  const { data: cat } = useQuery({ queryKey: ['catalogue'], queryFn: () => api.get<{ products: CatProduct[] }>('/api/public/catalogue') });
  const [s, setS] = useState<State>(initial);
  const [adding, setAdding] = useState<{ p: CatProduct; line?: Line } | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [q, setQ] = useState('');
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
  const cats = ['All', ...new Set(products.map((p) => topLevel(p.category)))];
  // Search: every word must appear in the product's name, section or description ("rib eye", "wors", "lamb chops")
  const words = q.toLowerCase().replace(/[^a-z0-9: ]+/g, ' ').split(' ').filter(Boolean);
  const matches = (p: CatProduct) => {
    if (!words.length) return true;
    const hay = `${p.name} ${p.category} ${p.description ?? ''}`.toLowerCase().replace(/[^a-z0-9: ]+/g, ' ');
    return words.every((w) => hay.includes(w) || hay.replace(/ /g, '').includes(w));
  };
  const visible = products.filter((p) => (words.length || cat_ === 'All' || topLevel(p.category) === cat_) && matches(p));
  const sections = [...new Set(visible.map((p) => p.category))];
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
        special_request: s.special?.trim() || null,
        client_ref: s.client_ref,
      }),
    onSuccess: (r) => {
      setDone({ number: r.order_number, message: r.message });
      try {
        localStorage.removeItem(KEY);
        localStorage.setItem(ME_KEY, JSON.stringify({ name: s.name, phone: s.phone, email: s.email, address: s.fulfilment === 'delivery' ? s.address : (loadMe()?.address ?? '') }));
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
  const dates = Array.from({ length: 45 }, (_, i) => addDays(info.earliest_date, i)).filter((d) => allowedDays.includes(new Date(d + 'T00:00:00Z').getUTCDay())).slice(0, 16);
  const terms: string[] = (info.form.terms ?? '').split('\n').map((t: string) => t.trim()).filter(Boolean);
  const detailsOk = s.name.trim().length >= 2 && s.phone.replace(/\D/g, '').length >= 9;
  const whenOk = !!s.date && (s.fulfilment === 'collection' || s.address.trim().length > 5);
  const steps = ['Choose', 'Your details', 'Collection or delivery', 'Check & send'];

  return (
    <Shell business={info.business} cartCount={s.lines.length + (s.special?.trim() ? 1 : 0)} onCart={() => setCartOpen(true)}>
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
          <div className="relative mt-5">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4.5 -translate-y-1/2 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — e.g. rump, wors, lamb chops" className="h-12 pl-10 pr-10 text-[16px]" aria-label="Search products" />
            {q && <button type="button" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-ink-3 hover:bg-sunken" aria-label="Clear search"><X className="size-4" /></button>}
          </div>
          {!words.length && <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none">
            {cats.map((c) => (
              <button key={c} onClick={() => setCat(c)} className={cx('h-10 shrink-0 rounded-full border px-4 text-[14px] font-medium', cat_ === c ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2')}>{c}</button>
            ))}
          </div>}
          {words.length > 0 && !visible.length && (
            <p className="mt-6 rounded-2xl bg-surface-2 p-4 text-[14.5px] text-ink-2">Nothing on our price list matches “{q}”. Ask for it under <b>Special requests</b> below and we’ll let you know.</p>
          )}
          {sections.map((group) => (
            <section key={group} className="mt-7">
              <h2 className="mb-2.5 flex items-baseline gap-2 font-display text-[20px] font-bold">
                {subLevel(group) !== group && <span className="text-[15px] font-semibold text-ink-3">{topLevel(group)} ·</span>}
                {subLevel(group)}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.filter((p) => p.category === group).map((p) => {
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
            </section>
          ))}
          {(cat_ === 'All' || words.length > 0) && (
            <section className="mt-9" id="special-requests">
              <h2 className="mb-1 font-display text-[20px] font-bold">Special requests</h2>
              <p className="mb-3 max-w-xl text-[14.5px] text-ink-2">Looking for something that isn’t on our price list, like venison or a specific cut? Tell us what you’d like and roughly how much. We’ll confirm availability and price with you before anything is prepared.</p>
              <Textarea rows={4} className="max-w-2xl" value={s.special ?? ''} onChange={(e) => set({ special: e.target.value })} maxLength={1500} placeholder="e.g. 2kg venison steaks, or a picanha roast of about 1.5kg" aria-label="Special requests" />
            </section>
          )}
        </div>
      )}

      {s.step === 1 && (
        <div className="mx-auto max-w-lg animate-rise pb-28">
          <h1 className="font-display text-[28px] font-semibold">Your details</h1>
          <p className="mt-1 text-ink-2">So we can confirm your order and let you know when it’s ready. We’ll remember these on this device for next time.</p>
          {loadMe() && (
            <button type="button" className="mt-2 text-[13.5px] font-medium text-brand underline-offset-2 hover:underline" onClick={() => { try { localStorage.removeItem(ME_KEY); } catch { /* ignore */ } set({ name: '', phone: '', email: '', address: '' }); }}>
              Not you? Clear these details
            </button>
          )}
          <div className="mt-6 space-y-4">
            <Field label="Name" htmlFor="n"><Input id="n" big autoComplete="name" value={s.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Mobile number" htmlFor="p" hint="We’ll use WhatsApp or SMS for updates."><Input id="p" big type="tel" inputMode="tel" autoComplete="tel" value={s.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="Email" htmlFor="e" optional hint="We’ll email you a copy of your order."><Input id="e" big type="email" autoComplete="email" value={s.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <p className="text-[13px] text-ink-3">We only use your details for your orders and to contact you about them. We never share them.</p>
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
              <p className="text-ink-2">Orders are for collection from {info.fulfilment.collectionPlace ?? 'our shop'}.</p>
            )}
            <p className="mt-2 text-[13.5px] text-ink-3">{s.fulfilment === 'collection' ? [`Collect from ${info.fulfilment.collectionPlace ?? 'our shop'}${info.fulfilment.collectionAddress ? `, ${info.fulfilment.collectionAddress}` : ''}`, info.fulfilment.collectionHours && `Hours: ${info.fulfilment.collectionHours}`].filter(Boolean).join(' · ') : info.fulfilment.deliveryNotes}</p>
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
          <Card className={cx('mt-5 divide-y divide-line', !s.lines.length && 'hidden')}>
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
          {s.special?.trim() && (
            <Card className="mt-3 p-4 text-[14.5px]">
              <div className="text-[13.5px] font-semibold text-ink-3">Special request</div>
              <p className="mt-1 whitespace-pre-line">{s.special.trim()}</p>
              <p className="mt-2 text-[13px] text-ink-3">We’ll confirm availability and price with you.</p>
            </Card>
          )}
          <Card className="mt-3 space-y-1 p-4 text-[14.5px]">
            <div><b>{s.name}</b> · {s.phone}</div>
            <div>{s.fulfilment === 'delivery' ? `Delivery to ${s.address}` : 'Collection'} · {s.date && longDate(s.date)}</div>
            {s.notes && <div className="text-ink-2">“{s.notes}”</div>}
          </Card>
          <p className="mt-4 text-[13.5px] text-ink-3">Prices are estimates — meat is priced by final weight. We’ll confirm your order before it’s prepared.</p>
          {terms.length > 0 && (
            <Card className="mt-4 p-4">
              <h2 className="text-[13.5px] font-semibold text-ink-3">Order terms</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[14px] text-ink-2">{terms.map((t) => <li key={t}>{t}</li>)}</ul>
              <label className="mt-4 flex items-start gap-3 text-[14.5px]">
                <input type="checkbox" checked={!!s.accepted} onChange={(e) => set({ accepted: e.target.checked })} className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" />
                <span>I confirm this order is correct and understand it is only confirmed once Terram Farm accepts it.</span>
              </label>
            </Card>
          )}
          {error && <p className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">{error}</p>}
        </div>
      )}

      {/* Sticky action bar */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-3 sm:px-8">
          {s.step > 0 && <Button size="lg" variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => set({ step: (s.step - 1) as State['step'] })}>Back</Button>}
          {s.step === 0 && (
            <div className="min-w-0 flex-1 text-[14px]">
              <div className="font-semibold">{s.lines.length ? `${s.lines.length} item${s.lines.length === 1 ? '' : 's'}${s.special?.trim() ? ' + special request' : ''}` : s.special?.trim() ? 'Special request' : 'Nothing chosen yet'}</div>
              {total != null && total > 0 && <div className="text-ink-3">≈ {formatMoney(total, info.currency)}</div>}
            </div>
          )}
          <div className={cx('flex', s.step > 0 && 'flex-1 justify-end')}>
            {s.step < 3 ? (
              s.step === 0 ? (
                <Button variant="primary" size="lg" icon={<ShoppingBag className="size-4" />} disabled={!s.lines.length && !s.special?.trim()} onClick={() => setCartOpen(true)}>View order</Button>
              ) : (
                <Button variant="primary" size="lg" disabled={(s.step === 1 && !detailsOk) || (s.step === 2 && !whenOk)} onClick={() => set({ step: (s.step + 1) as State['step'] })}>Continue</Button>
              )
            ) : (
              <Button variant="primary" size="lg" disabled={!online || (terms.length > 0 && !s.accepted)} loading={submit.isPending} onClick={() => { setError(null); submit.mutate(); }}>Send order</Button>
            )}
          </div>
        </div>
      </div>

      {adding && (
        <AddSheet
          p={adding.p}
          line={adding.line}
          existing={adding.line ? [] : s.lines.filter((l) => l.product_id === adding.p.id)}
          currency={info.currency}
          onClose={() => setAdding(null)}
          onRemove={(key) => set({ lines: s.lines.filter((l) => l.key !== key) })}
          onAdd={(l) => {
            // Editing replaces the line in place; adding appends
            set({ lines: adding.line ? s.lines.map((x) => (x.key === adding.line!.key ? { ...l, key: x.key } : x)) : [...s.lines, l] });
            setAdding(null);
          }}
        />
      )}

      <Sheet
        open={cartOpen && !adding}
        onClose={() => setCartOpen(false)}
        title="Your order"
        subtitle={s.lines.length ? `${s.lines.length} item${s.lines.length === 1 ? '' : 's'}${total != null && total > 0 ? ` · ≈ ${formatMoney(total, info.currency)}` : ''}` : undefined}
        footer={
          <div className="flex gap-2">
            <Button size="lg" variant="ghost" onClick={() => setCartOpen(false)}>Add more</Button>
            <Button size="lg" variant="primary" full disabled={!s.lines.length && !s.special?.trim()} onClick={() => { setCartOpen(false); set({ step: 1 }); }}>Checkout</Button>
          </div>
        }
      >
        {!s.lines.length && !s.special?.trim() ? (
          <p className="py-6 text-center text-ink-2">Nothing in your order yet.</p>
        ) : (
          <div className="space-y-2">
            {s.lines.map((l) => {
              const p = byId.get(l.product_id);
              if (!p) return null;
              const prep = Object.values(l.preparation).filter((v) => !p.options.some((g) => g.options.some((o) => o.name === v && o.is_default)));
              const est = estimateLinePrice(l.qty, p.price_cents, p.price_unit);
              return (
                <div key={l.key} className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-[13.5px] text-ink-2">{[formatQty(l.qty, p.piece_noun), ...prep, l.special_instructions].filter(Boolean).join(' · ')}</div>
                    {est != null && <div className="text-[13px] text-ink-3">≈ {formatMoney(est, info.currency)}</div>}
                  </div>
                  <button type="button" onClick={() => setAdding({ p, line: l })} className="rounded-xl p-2.5 text-ink-2 hover:bg-sunken" aria-label={`Change ${p.name}`}><Pencil className="size-4" /></button>
                  <button type="button" onClick={() => set({ lines: s.lines.filter((x) => x.key !== l.key) })} className="rounded-xl p-2.5 text-danger hover:bg-danger-soft" aria-label={`Remove ${p.name}`}><Trash2 className="size-4" /></button>
                </div>
              );
            })}
            {s.special?.trim() && (
              <div className="flex items-start gap-3 rounded-2xl border border-ochre/40 bg-ochre-soft p-3 text-ochre-soft-ink">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">Special request</div>
                  <div className="whitespace-pre-line text-[13.5px]">{s.special.trim()}</div>
                </div>
                <button type="button" onClick={() => set({ special: '' })} className="rounded-xl p-2.5 hover:bg-white/40" aria-label="Remove special request"><Trash2 className="size-4" /></button>
              </div>
            )}
            {total != null && total > 0 && <p className="pt-2 text-right text-[15px]">Estimated total <b>{formatMoney(total, info.currency)}</b></p>}
            <p className="text-[12.5px] text-ink-3">Prices are estimates. Meat is priced by its final weight.</p>
          </div>
        )}
      </Sheet>
    </Shell>
  );
}

function AddSheet({ p, line, existing, onAdd, onRemove, onClose, currency }: { p: CatProduct; line?: Line; existing: Line[]; onAdd: (l: Line) => void; onRemove: (key: string) => void; onClose: () => void; currency: string }) {
  const [qty, setQty] = useState<Qty | null>(line?.qty ?? null);
  const [prep, setPrep] = useState<Record<string, string>>(() => line?.preparation ?? Object.fromEntries(p.options.map((g) => [g.group, g.options.find((o) => o.is_default)?.name ?? g.options[0]?.name]).filter(([, v]) => v)));
  const [note, setNote] = useState(line?.special_instructions ?? '');
  const price = qty ? estimateLinePrice(qty, p.price_cents, p.price_unit) : null;
  return (
    <Sheet open onClose={onClose} title={p.name} subtitle={p.description ?? undefined} footer={<Button variant="primary" size="lg" full disabled={!qty || (!!p.pack_size && (qty.count ?? 0) % p.pack_size !== 0)} onClick={() => qty && onAdd({ key: newKey(), product_id: p.id, qty, preparation: prep, special_instructions: note.trim() })} icon={<ShoppingBag className="size-4" />}>{line ? 'Update' : 'Add to order'}{price != null ? ` · ≈ ${formatMoney(price, currency)}` : ''}</Button>}>
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
          <QuantityInput value={qty} onChange={setQty} quantityType={p.quantity_type} allowsPortions={p.allows_portions} pieceNoun={p.piece_noun} packSize={p.pack_size ?? undefined} />
          {p.pack_size && (
            <p className={cx('mt-2 text-[13px]', qty && (qty.count ?? 0) % p.pack_size !== 0 ? 'font-medium text-danger' : 'text-ink-3')}>
              {qty && (qty.count ?? 0) % p.pack_size === 0 && (qty.count ?? 0) > 0
                ? `${(qty.count ?? 0) / p.pack_size} × ${p.pack_size} ${p.piece_noun}s`
                : `Sold in lots of ${p.pack_size}: ${p.pack_size}, ${p.pack_size * 2}, ${p.pack_size * 3}…`}
            </p>
          )}
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
        <Field label="Notes for this item" optional><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={p.quantity_type === 'count' && !p.options.length ? 'Anything we should know' : 'e.g. extra thick, 2 per pack'} /></Field>
      </div>
    </Sheet>
  );
}

function Shell({ children, business, cartCount, onCart }: { children: React.ReactNode; business?: any; cartCount?: number; onCart?: () => void }) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="bg-charcoal text-white">
        <div className="mx-auto flex h-[72px] max-w-5xl items-center justify-between gap-3 px-5 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Logo withWord={false} tone="light" />
            <div className="min-w-0">
              <div className="truncate font-display text-[19px] font-bold leading-none">{business?.name ?? 'Terram Farm'}</div>
              <div className="mt-1 text-[12.5px] font-medium opacity-80">Order form</div>
            </div>
          </div>
          {!!cartCount && <button onClick={onCart} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[13px] font-semibold"><ShoppingBag className="size-4" />{cartCount}</button>}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-7 sm:px-8 sm:py-10">{children}</main>
      <BackToTop className="bottom-[calc(96px+env(safe-area-inset-bottom))]" />
      {business?.phone && (
        <footer className="mx-auto max-w-5xl px-5 pb-32 sm:px-8 text-center text-[13px] text-ink-3">
          Questions? Call or WhatsApp <a className="font-semibold text-ink-2" href={`tel:${business.phone.replace(/\s/g, '')}`}>{business.phone}</a>
        </footer>
      )}
    </div>
  );
}

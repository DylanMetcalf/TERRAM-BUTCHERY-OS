import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CalendarClock, Check, Minus, PackageCheck, Pencil, Plus, Receipt, Search, ShoppingBag, Store, Trash2, Truck, WifiOff, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/order-bits';
import { BackToTop } from '../components/BackToTop';
import { ChangeOrderButtons, ChangeOrderLink } from '../components/ChangeOrder';
import { QuantityInput } from '../components/quantity-input';
import { Button, Card, cx, Field, Input, Segmented, Sheet, Spinner, Textarea } from '../components/ui';
import { api, ApiError, newKey } from '../lib/api';
import { addDays, formatMoney, formatQty, friendlyDate, longDate } from '../lib/format';
import { useOnline } from '../lib/realtime';
import { REORDER_KEY } from '../lib/customer';
import type { Qty, QuantityType } from '../lib/types';
import { priceLine, withSurcharge, type Pricing } from '../../../shared/pricing';

/**
 * The customer order form. Products, sizes and prices come from the one central catalogue; the
 * server re-checks and re-prices everything when the order is sent, so what the customer sees on
 * "Check & send" is exactly what the farm receives.
 */

interface SaleOpt { id: string; label: string; kind: 'pack' | 'piece'; grams: number | null; price_cents: number | null; pricing: Pricing }
export interface CatProduct {
  id: string;
  name: string;
  category: string;
  description: string | null;
  image: string | null;
  out_of_stock?: boolean;
  unavailable_reason?: string | null;
  quantity_type: QuantityType;
  allows_portions: boolean;
  piece_noun: string;
  typical_piece_g: number | null;
  pack_size: number | null;
  min_qty: number | null;
  max_qty: number | null;
  variant_of: string | null;
  variant_label: string | null;
  price_cents: number | null;
  price_unit: 'kg' | 'each' | null;
  sale_options: SaleOpt[];
  options: { group: string; options: { name: string; is_default: boolean; surcharge_pct: number }[] }[];
}
interface Line { key: string; product_id: string; sale_option?: string | null; qty: Qty; preparation: Record<string, string>; special_instructions: string }
interface InvoiceForm { wanted: boolean; billing_name: string; company: string; billing_email: string; billing_address: string; vat_number: string; instructions: string }
interface State {
  step: 0 | 1 | 2 | 3;
  lines: Line[];
  name: string;
  phone: string;
  email: string;
  fulfilment: 'collection' | 'delivery';
  date: string;
  address: string;
  notes: string;
  client_ref: string;
  accepted?: boolean;
  special?: string;
  invoice?: InvoiceForm;
  reminders?: boolean;
}
interface QuoteLine { index: number; ok: boolean; problem: string | null; product_id: string; label?: string; pricing: Pricing | null; cents: number | null; unit_price_cents?: number | null; price_unit?: 'kg' | 'each' | null }
interface Quote { lines: QuoteLine[]; total: { estimate_cents: number | null; exact: boolean; pending_lines: number } }

const KEY = 'terram:customer-order';
/** The customer's own details, kept on their device after an order so they don't retype them next time. */
const ME_KEY = 'terram:customer-me';
type Me = { name: string; phone: string; email: string; address: string };
const BLANK_INVOICE: InvoiceForm = { wanted: false, billing_name: '', company: '', billing_email: '', billing_address: '', vat_number: '', instructions: '' };

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
    if (s) return { ...JSON.parse(s), invoice: { ...BLANK_INVOICE, ...(JSON.parse(s).invoice ?? {}) } };
  } catch {
    /* ignore */
  }
  const me = loadMe();
  return { step: 0, lines: [], name: me?.name ?? '', phone: me?.phone ?? '', email: me?.email ?? '', fulfilment: 'collection', date: '', address: me?.address ?? '', notes: '', client_ref: newKey(), invoice: BLANK_INVOICE, reminders: false };
}

/** Same arithmetic as the server (shared/pricing.ts), for instant feedback while choosing. */
export function lineQuote(l: Line, p: CatProduct | undefined): { pricing: Pricing; cents: number | null; label: string } {
  if (!p) return { pricing: 'unpriced', cents: null, label: '' };
  const opt = l.sale_option ? p.sale_options.find((o) => o.id === l.sale_option) : null;
  const surcharge = p.options.reduce((t, g) => t + (g.options.find((o) => o.name === l.preparation[g.group])?.surcharge_pct ?? 0), 0);
  const unit = p.price_cents == null ? null : withSurcharge(p.price_cents, surcharge);
  const q = priceLine({ qty: l.qty, unitPriceCents: unit, priceUnit: p.price_unit, saleKind: opt?.kind ?? null, pieceGrams: opt ? opt.grams : p.typical_piece_g });
  const label = opt && opt.kind === 'piece' ? `${l.qty.count} × ${opt.label}` : formatQty(l.qty, p.piece_noun);
  return { ...q, label };
}

function priceText(pricing: Pricing | null, cents: number | null, p?: CatProduct | null, currency = 'ZAR'): string | null {
  if (pricing === 'exact' && cents != null) return formatMoney(cents, currency);
  if (pricing === 'estimate' && cents != null) return `≈ ${formatMoney(cents, currency)}`;
  if (pricing === 'by_weight' && p?.price_cents != null) return `${formatMoney(p.price_cents, currency)}/kg, priced when weighed`;
  return null;
}

/** True while someone is typing in a text box on a touch screen (the on-screen keyboard is up). */
function useTypingOnTouch() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    if (!coarse) return;
    const isText = (el: EventTarget | null) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'file', 'range'].includes(el.type));
    const on = (e: FocusEvent) => isText(e.target) && setTyping(true);
    const off = () => setTimeout(() => setTyping(isText(document.activeElement)), 50);
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    return () => {
      document.removeEventListener('focusin', on);
      document.removeEventListener('focusout', off);
    };
  }, []);
  return typing;
}

export default function PublicOrder() {
  const online = useOnline();
  const qc = useQueryClient();
  const { data: info, error: infoErr } = useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info') });
  const { data: cat } = useQuery({ queryKey: ['catalogue'], queryFn: () => api.get<{ products: CatProduct[] }>('/api/public/catalogue') });
  const [s, setS] = useState<State>(initial);
  const [adding, setAdding] = useState<{ p: CatProduct; line?: Line } | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cat_, setCat] = useState('All');
  const [done, setDone] = useState<{ number: number | null; message: string; url: string | null; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const typing = useTypingOnTouch();
  const searchRef = useRef<HTMLDivElement>(null);
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
  /** Variations (e.g. Rib-Eye on the bone) appear inside their main product's card. */
  const variantsOf = useMemo(() => {
    const m = new Map<string, CatProduct[]>();
    for (const p of products) if (p.variant_of && byId.has(p.variant_of)) (m.get(p.variant_of) ?? m.set(p.variant_of, []).get(p.variant_of)!).push(p);
    return m;
  }, [products, byId]);
  const mains = products.filter((p) => !p.variant_of || !byId.has(p.variant_of));
  const cats = ['All', ...new Set(mains.map((p) => topLevel(p.category)))];

  // A saved basket from an earlier visit may hold something that has since run out: take it out and say so
  useEffect(() => {
    if (!cat) return;
    const gone = s.lines.filter((l) => {
      const p = byId.get(l.product_id);
      return !p || p.out_of_stock || (p.sale_options.length > 0 && !p.sale_options.some((o) => o.id === l.sale_option));
    });
    if (!gone.length) return;
    const names = [...new Set(gone.map((l) => byId.get(l.product_id)?.name).filter(Boolean))];
    setS((x) => ({ ...x, lines: x.lines.filter((l) => !gone.some((g) => g.key === l.key)) }));
    setNotice(`${names.length ? names.join(', ') : 'Something in your saved order'} ${names.length > 1 ? 'aren’t' : 'isn’t'} available as you chose it any more, so we took ${names.length > 1 ? 'them' : 'it'} out of your order.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat]);

  // "Reorder" from a past order: load it as a new draft basket to review — nothing is sent automatically
  useEffect(() => {
    if (!cat) return;
    let draft: any = null;
    try {
      draft = JSON.parse(localStorage.getItem(REORDER_KEY) ?? 'null');
      localStorage.removeItem(REORDER_KEY);
    } catch {
      /* ignore */
    }
    if (!draft?.lines) return;
    const usable = draft.lines.filter((l: any) => !l.problem && byId.get(l.product_id));
    const lines: Line[] = usable.map((l: any) => ({ key: newKey(), product_id: l.product_id, sale_option: l.sale_option, qty: l.qty, preparation: l.preparation ?? {}, special_instructions: l.special_instructions ?? '' }));
    const changed = usable.filter((l: any) => l.previous_unit_price_cents != null && l.current_unit_price_cents != null && l.previous_unit_price_cents !== l.current_unit_price_cents);
    const problems = draft.lines.filter((l: any) => l.problem).map((l: any) => l.problem as string);
    setS((x) => ({ ...x, step: 0, lines, client_ref: newKey(), accepted: false }));
    setNotice(
      <>
        <b>We’ve copied order #{draft.from_order} into a new order.</b> Check the quantities and today’s prices, then send it when you’re ready.
        {changed.length > 0 && <span className="mt-1 block">Price changes since then: {changed.map((l: any) => `${l.name} now ${formatMoney(l.current_unit_price_cents)}/${byId.get(l.product_id)?.price_unit ?? 'kg'} (was ${formatMoney(l.previous_unit_price_cents)})`).join('; ')}.</span>}
        {problems.length > 0 && <span className="mt-1 block">Not added: {problems.join(' ')}</span>}
      </>,
    );
    setCartOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat]);

  // Search: every word must appear in the product's name, section, description, sizes or variations
  const words = q.toLowerCase().replace(/[^a-z0-9: ]+/g, ' ').split(' ').filter(Boolean);
  const matches = (p: CatProduct) => {
    if (!words.length) return true;
    const extra = [...(variantsOf.get(p.id) ?? []).map((v) => `${v.name} ${v.variant_label ?? ''}`), ...p.sale_options.map((o) => o.label), p.variant_label ?? ''].join(' ');
    const hay = `${p.name} ${p.category} ${p.description ?? ''} ${extra}`.toLowerCase().replace(/[^a-z0-9: ]+/g, ' ');
    return words.every((w) => hay.includes(w) || hay.replace(/ /g, '').includes(w));
  };
  const visible = mains.filter((p) => (words.length || cat_ === 'All' || topLevel(p.category) === cat_) && matches(p));
  const sections = [...new Set(visible.map((p) => p.category))];
  const local = s.lines.map((l) => lineQuote(l, byId.get(l.product_id)));
  const localTotal = local.reduce((t, l) => t + (l.cents ?? 0), 0);
  const localExact = local.length > 0 && local.every((l) => l.pricing === 'exact');

  const payload = () => ({
    customer: { name: s.name, phone: s.phone, email: s.email || undefined },
    items: s.lines.map((l) => ({ product_id: l.product_id, sale_option: l.sale_option ?? null, qty: l.qty, preparation: l.preparation, special_instructions: l.special_instructions || null })),
    fulfilment_type: info?.fulfilment?.customerChooses ? s.fulfilment : null,
    requested_date: s.date || null,
    delivery_address: !info?.fulfilment?.customerChooses || s.fulfilment === 'delivery' ? s.address : null,
    notes: s.notes || null,
    special_request: s.special?.trim() || null,
    invoice: s.invoice?.wanted
      ? { billing_name: s.invoice.billing_name, company: s.invoice.company || null, billing_email: s.invoice.billing_email, billing_address: s.invoice.billing_address || null, vat_number: s.invoice.vat_number || null, instructions: s.invoice.instructions || null }
      : null,
    marketing_consent: !!s.reminders,
    seen_total_cents: quote?.total.estimate_cents ?? null,
    client_ref: s.client_ref,
  });

  // On "Check & send", price the basket on the server with today's catalogue
  const priceCheck = useMutation({
    mutationFn: () => api.post<Quote>('/api/public/quote', { items: payload().items }),
    onSuccess: (r) => setQuote(r),
  });
  useEffect(() => {
    if (s.step === 3 && s.lines.length) priceCheck.mutate();
    else if (s.step !== 3) setQuote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.step]);

  const submit = useMutation({
    mutationFn: () => api.post<{ order_number: number | null; message: string; order_url?: string }>('/api/public/orders', payload()),
    onSuccess: (r) => {
      setDone({ number: r.order_number, message: r.message, url: r.order_url ?? null, email: s.email });
      try {
        localStorage.removeItem(KEY);
        localStorage.setItem(ME_KEY, JSON.stringify({ name: s.name, phone: s.phone, email: s.email, address: s.address || loadMe()?.address || '' }));
      } catch {
        /* ignore */
      }
    },
    onError: (e) => {
      // Prices or availability changed since the page loaded: show the new quote, keep the basket
      const details = e instanceof ApiError ? (e.details as any) : null;
      if (details?.quote) {
        setQuote(details.quote);
        qc.invalidateQueries({ queryKey: ['catalogue'] });
      }
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again. Your order is still here.');
    },
  });

  if (infoErr) return <Shell><p className="py-20 text-center text-ink-2">We can’t load the order form right now. Please try again in a moment.</p></Shell>;
  if (!info || !cat) return <Shell><div className="flex justify-center py-24"><Spinner className="size-6" /></div></Shell>;
  if (!info.form.enabled) return <Shell business={info.business}><Card className="mx-auto mt-10 max-w-md p-8 text-center"><h1 className="font-display text-2xl font-semibold">Online ordering is paused</h1><p className="mt-2 text-ink-2">Please contact us directly{info.business.phone ? ` on ${info.business.phone}` : ''}.</p></Card></Shell>;

  if (done)
    return (
      <Shell business={info.business}>
        <div className="mx-auto max-w-md animate-rise py-10 text-center">
          <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-field text-white"><Check className="size-8 animate-pop" strokeWidth={3} /></span>
          <h1 className="mt-6 font-display text-3xl font-semibold">Order received</h1>
          {done.number && <p className="mt-1 text-[15px] text-ink-3">Reference #{done.number}</p>}
          <p className="mt-4 text-[16px] leading-relaxed text-ink-2">{done.message}</p>
          <div className="mt-5 rounded-2xl bg-surface-2 p-4 text-left text-[14.5px] text-ink-2">
            <p><b className="text-ink">What happens next:</b> we check the products, quantities and availability, then confirm your order with an expected date.</p>
            <p className="mt-2">{info.form.leadTime}</p>
          </div>
          {done.email && <p className="mt-3 text-[14px] text-ink-3">A copy is on its way to {done.email}.</p>}
          {done.url && (
            <Link to={done.url} className="mt-6 inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink shadow-float">
              Track my order
            </Link>
          )}
          <div className="mt-8 rounded-2xl border border-line bg-surface p-4 text-left">
            <div className="font-semibold">Need to change something?</div>
            <p className="mt-1 text-[14px] text-ink-2">Message or call us with your reference number and we’ll update your order.</p>
            <div className="mt-3"><ChangeOrderButtons phone={info.business.phone} email={info.business.email} reference={done.number} name={s.name.split(' ')[0]} /></div>
          </div>
          <Button className="mt-8" variant="ghost" onClick={() => { setDone(null); setS({ ...initial(), step: 0, lines: [], client_ref: newKey() }); }}>Place another order</Button>
        </div>
      </Shell>
    );

  // Address-only mode (the family arranges collection/delivery) vs customers choosing
  const chooses: boolean = !!info.fulfilment.customerChooses;
  const allowedDays: number[] = !chooses ? [...new Set<number>([...info.fulfilment.collectionDays, ...info.fulfilment.deliveryDays])] : s.fulfilment === 'delivery' ? info.fulfilment.deliveryDays : info.fulfilment.collectionDays;
  const dates = Array.from({ length: 45 }, (_, i) => addDays(info.earliest_date, i)).filter((d) => allowedDays.includes(new Date(d + 'T00:00:00Z').getUTCDay())).slice(0, 12);
  const rate: number = info.fulfilment.deliveryRatePerKmCents ?? 0;
  const feeLine: string | null = info.fulfilment.showDeliveryFees
    ? `Delivery is free within ${info.fulfilment.freeDeliveryKm} km of ${info.fulfilment.collectionPlace ?? 'our shop'}.${rate > 0 ? ` Further away it’s ${formatMoney(rate, info.currency)} per km beyond that.` : ' Further away, we’ll quote you a delivery fee.'}`
    : null;
  const terms: string[] = (info.form.terms ?? '').split('\n').map((t: string) => t.trim()).filter(Boolean);
  const detailsOk = s.name.trim().length >= 2 && s.phone.replace(/\D/g, '').length >= 9 && (!s.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email));
  const inv = s.invoice ?? BLANK_INVOICE;
  const invoiceOk = !inv.wanted || (inv.billing_name.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inv.billing_email));
  const needsAddress = !chooses || s.fulfilment === 'delivery';
  const dateOk = !s.date || (s.date >= info.earliest_date && s.date <= addDays(info.today, 90) && allowedDays.includes(new Date(s.date + 'T00:00:00Z').getUTCDay()));
  const whenOk = dateOk && (!needsAddress || s.address.trim().length > 5);
  const steps = ['Choose', 'Your details', chooses ? 'Collection or delivery' : 'Address', 'Check & send'];
  const quoteProblems = quote?.lines.filter((l) => !l.ok) ?? [];
  const shownTotal = quote?.total.estimate_cents ?? (local.length ? localTotal : null);
  const shownExact = quote ? quote.total.exact : localExact;
  const pricedOnWeight = quote ? quote.lines.some((l) => l.pricing === 'estimate' || l.pricing === 'by_weight') : local.some((l) => l.pricing === 'estimate' || l.pricing === 'by_weight');
  const cartCount = s.lines.length + (s.special?.trim() ? 1 : 0);
  const hideBar = typing; // the on-screen keyboard is up: give the search box and results the room

  const totalBlock = shownTotal != null && shownTotal > 0 && (
    <div className="flex items-baseline justify-between gap-3 text-[15px]">
      <span className="text-ink-2">{shownExact ? 'Total' : 'Estimated total'}</span>
      <span className="font-semibold tabular">{formatMoney(shownTotal, info.currency)}</span>
    </div>
  );
  const priceNote = (
    <p className="text-[12.5px] leading-relaxed text-ink-3">
      {pricedOnWeight ? 'Weighed items are priced on their final weight, so the total may change a little. ' : ''}
      You only pay once your order is packed and the final amount is known. {info.form.packagingNote}
    </p>
  );

  return (
    <Shell business={info.business} cartCount={cartCount} onCart={() => setCartOpen(true)} barHidden={hideBar}>
      {!online && <div className="mb-4 flex items-center gap-2 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink"><WifiOff className="size-4" /> You’re offline. Your order is saved on this device — send it when you’re back online.</div>}
      <ol className="mb-6 flex gap-1.5" aria-label="Progress">
        {steps.map((t, i) => (
          <li key={t} className="flex-1" aria-current={i === s.step ? 'step' : undefined}>
            <div className={cx('h-1.5 rounded-full', i <= s.step ? 'bg-brand' : 'bg-line')} />
            <div className={cx('mt-1.5 hidden text-[12px] font-medium sm:block', i === s.step ? 'text-ink' : 'text-ink-3')}>{t}</div>
          </li>
        ))}
      </ol>

      {notice && (
        <div className="mb-5 flex items-start gap-3 rounded-xl bg-ochre-soft px-4 py-3 text-[14px] leading-relaxed text-ochre-soft-ink" role="status">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 rounded-lg p-1 hover:bg-black/5" aria-label="Dismiss"><X className="size-4" /></button>
        </div>
      )}

      {s.step === 0 && (
        <div className="animate-rise">
          <h1 className="font-display text-[30px] font-semibold leading-tight">What would you like?</h1>
          <p className="mt-2 max-w-2xl text-[15.5px] text-ink-2">{info.form.intro}</p>
          <p className="mt-2 flex max-w-2xl items-start gap-2 text-[14px] text-ink-2"><CalendarClock className="mt-0.5 size-4 shrink-0 text-ink-3" />{info.form.leadTime}</p>
          <ChangeOrderLink phone={info.business.phone} email={info.business.email} className="mt-2 text-[14px] font-medium text-brand underline-offset-2 hover:underline" />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
            <Link to="/account" className="font-medium text-brand underline-offset-2 hover:underline">See your past orders</Link>
          </div>

          {/* Search stays at the top of the screen while scrolling, and above the keyboard when typing */}
          <div ref={searchRef} className="sticky top-0 z-20 -mx-5 mt-5 bg-bg/95 px-5 pb-2 pt-2 backdrop-blur sm:-mx-8 sm:px-8">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-ink-3" aria-hidden />
              <Input
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onFocus={() => {
                  // On phones, lift the search box to the top so the results fit above the keyboard
                  if (window.matchMedia?.('(pointer: coarse)').matches)
                    setTimeout(() => {
                      const top = (searchRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 4;
                      if (Math.abs(window.scrollY - top) > 8) window.scrollTo({ top, behavior: 'smooth' });
                    }, 250);
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
                placeholder="Search — e.g. mince, rump, wors"
                className="h-12 bg-surface pl-10 pr-11 text-[16px] text-ink caret-[var(--brand)] [&::-webkit-search-cancel-button]:hidden"
                aria-label="Search products"
              />
              {q && <button type="button" onClick={() => setQ('')} className="absolute right-1.5 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-ink-3 hover:bg-sunken" aria-label="Clear search"><X className="size-4" /></button>}
            </div>
            {!words.length ? (
              <div className="-mx-5 mt-2 flex gap-2 overflow-x-auto px-5 pb-1 scrollbar-none sm:-mx-8 sm:px-8">
                {cats.map((c) => (
                  <button key={c} onClick={() => setCat(c)} className={cx('h-10 shrink-0 rounded-full border px-4 text-[14px] font-medium', cat_ === c ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2')}>{c}</button>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[13.5px] text-ink-3" aria-live="polite">{visible.length ? `${visible.length} product${visible.length === 1 ? '' : 's'} match “${q.trim()}”` : `Nothing matches “${q.trim()}”`}</p>
            )}
          </div>

          {words.length > 0 && !visible.length && (
            <div className="mt-4 rounded-2xl bg-surface-2 p-4 text-[14.5px] text-ink-2">
              Nothing on our price list matches “{q.trim()}”. Check the spelling, <button className="font-semibold text-brand underline" onClick={() => setQ('')}>see everything</button>, or ask for it under <b>Special requests</b> below.
            </div>
          )}
          {sections.map((group) => (
            <section key={group} className="mt-6">
              <h2 className="mb-2.5 flex items-baseline gap-2 font-display text-[20px] font-bold">
                {subLevel(group) !== group && <span className="text-[15px] font-semibold text-ink-3">{topLevel(group)} ·</span>}
                {subLevel(group)}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visible.filter((p) => p.category === group).map((p) => {
                  const family = [p, ...(variantsOf.get(p.id) ?? [])];
                  const inCart = s.lines.filter((l) => family.some((f) => f.id === l.product_id));
                  const available = family.filter((f) => !f.out_of_stock);
                  if (!available.length)
                    return (
                      <div key={p.id} className="flex items-start gap-3 rounded-2xl border border-dashed border-line-strong bg-surface-2 p-4" aria-disabled="true">
                        <div className="min-w-0 flex-1">
                          <div className="text-[16px] font-semibold text-ink-2">{p.name}</div>
                          {p.description && <div className="mt-0.5 text-[13.5px] text-ink-3">{p.description}</div>}
                          {p.price_cents != null && <div className="mt-1.5 text-[13px] text-ink-3">{formatMoney(p.price_cents, info.currency)}/{p.price_unit}</div>}
                          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-ochre-soft px-2.5 py-1 text-[12.5px] font-semibold text-ochre-soft-ink">Out of stock</div>
                          <div className="mt-1.5 text-[13px] text-ink-3">{p.unavailable_reason || 'Not available to order right now. Check back soon, or ask us under Special requests.'}</div>
                        </div>
                      </div>
                    );
                  const first = available[0];
                  return (
                    <button key={p.id} onClick={() => setAdding({ p: first })} className={cx('flex items-start gap-3 rounded-2xl border bg-surface p-4 text-left shadow-card transition hover:shadow-float active:scale-[0.99]', inCart.length ? 'border-brand/50' : 'border-line')}>
                      {p.image && <img src={p.image} alt="" className="size-16 shrink-0 rounded-xl object-cover" />}
                      <div className="min-w-0 flex-1">
                        <div className="text-[16px] font-semibold">{p.name}</div>
                        {p.description && <div className="mt-0.5 line-clamp-2 text-[13.5px] text-ink-2">{p.description}</div>}
                        <div className="mt-1.5 text-[13px] text-ink-3">
                          {p.price_cents != null && <span className="font-medium text-ink-2">{formatMoney(p.price_cents, info.currency)}/{p.price_unit}</span>}
                          {p.price_cents != null && ' · '}
                          {p.sale_options.length ? p.sale_options.map((o) => o.label).join(', ') : p.quantity_type === 'weight' ? 'by weight' : p.quantity_type === 'count' ? `per ${p.piece_noun}` : `by weight or per ${p.piece_noun}`}
                        </div>
                        {family.length > 1 && <div className="mt-1 text-[13px] text-ink-3">{family.map((f) => f.variant_label ?? f.name).join(' or ')}</div>}
                        {inCart.length > 0 && <div className="mt-2 text-[13px] font-semibold text-brand">In your order: {inCart.map((l) => lineQuote(l, byId.get(l.product_id)).label).join(', ')}</div>}
                      </div>
                      <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', inCart.length ? 'bg-brand text-brand-ink' : 'bg-sunken text-ink-2')} aria-hidden>{inCart.length ? <Check className="size-4" /> : <Plus className="size-4" />}</span>
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
          <p className="mt-8 flex max-w-2xl items-start gap-2 text-[13.5px] text-ink-3"><PackageCheck className="mt-0.5 size-4 shrink-0" />{info.form.packagingNote}</p>
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
            <Field label="Name"><Input big autoComplete="name" value={s.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Mobile number" hint="We’ll call or WhatsApp you if we need to check anything."><Input big type="tel" inputMode="tel" autoComplete="tel" value={s.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="Email" optional hint="For your order updates and a link to track your order." error={s.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email) ? 'That email address doesn’t look right.' : undefined}>
              <Input big type="email" autoComplete="email" value={s.email} onChange={(e) => set({ email: e.target.value })} />
            </Field>

            <fieldset className="rounded-2xl border border-line bg-surface p-4">
              <legend className="px-1 text-[14.5px] font-semibold">Do you require an invoice?</legend>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {[false, true].map((v) => (
                  <label key={String(v)} className={cx('flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-[14.5px]', inv.wanted === v ? 'border-brand bg-brand-soft text-brand-soft-ink' : 'border-line-strong')}>
                    <input type="radio" name="invoice" checked={inv.wanted === v} onChange={() => set({ invoice: { ...inv, wanted: v, billing_email: v && !inv.billing_email ? s.email : inv.billing_email, billing_name: v && !inv.billing_name ? s.name : inv.billing_name } })} className="size-4 accent-[var(--brand)]" />
                    {v ? 'Yes, please provide an invoice' : 'No, thank you'}
                  </label>
                ))}
              </div>
              {inv.wanted && (
                <div className="mt-4 space-y-3">
                  <Field label="Name on the invoice"><Input value={inv.billing_name} onChange={(e) => set({ invoice: { ...inv, billing_name: e.target.value } })} autoComplete="name" /></Field>
                  <Field label="Company" optional><Input value={inv.company} onChange={(e) => set({ invoice: { ...inv, company: e.target.value } })} autoComplete="organization" /></Field>
                  <Field label="Email for the invoice" error={inv.billing_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inv.billing_email) ? 'That email address doesn’t look right.' : undefined}><Input type="email" value={inv.billing_email} onChange={(e) => set({ invoice: { ...inv, billing_email: e.target.value } })} /></Field>
                  <Field label="Billing address" optional><Textarea rows={2} value={inv.billing_address} onChange={(e) => set({ invoice: { ...inv, billing_address: e.target.value } })} /></Field>
                  <Field label="VAT number" optional hint="Only if your business needs it on the invoice."><Input value={inv.vat_number} onChange={(e) => set({ invoice: { ...inv, vat_number: e.target.value } })} /></Field>
                  <Field label="Anything else for the invoice?" optional><Input value={inv.instructions} onChange={(e) => set({ invoice: { ...inv, instructions: e.target.value } })} placeholder="e.g. purchase order number" /></Field>
                </div>
              )}
            </fieldset>

            {s.email && (
              <label className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 text-[14.5px]">
                <input type="checkbox" checked={!!s.reminders} onChange={(e) => set({ reminders: e.target.checked })} className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" />
                <span>Send me an occasional reminder when it’s time to stock up again. <span className="text-ink-3">Optional. You can stop them any time.</span></span>
              </label>
            )}
            <p className="text-[13px] text-ink-3">We only use your details for your orders and to contact you about them. <a href="/privacy" target="_blank" rel="noreferrer" className="font-medium text-brand underline underline-offset-2">Privacy notice</a></p>
          </div>
        </div>
      )}

      {s.step === 2 && (
        <div className="mx-auto max-w-lg animate-rise pb-28">
          {chooses ? (
            <>
              <h1 className="font-display text-[28px] font-semibold">Collection or delivery?</h1>
              <div className="mt-5">
                {info.fulfilment.deliveryEnabled ? (
                  <Segmented full size="lg" value={s.fulfilment} onChange={(v) => set({ fulfilment: v, date: '' })} options={[{ value: 'collection', label: <><Store className="size-4" />Collect</> }, { value: 'delivery', label: <><Truck className="size-4" />Delivery</> }]} />
                ) : (
                  <p className="text-ink-2">Orders are for collection from {info.fulfilment.collectionPlace ?? 'our shop'}.</p>
                )}
                <p className="mt-2 text-[13.5px] text-ink-3">{s.fulfilment === 'collection' ? [`Collect from ${info.fulfilment.collectionPlace ?? 'our shop'}${info.fulfilment.collectionAddress ? `, ${info.fulfilment.collectionAddress}` : ''}`, info.fulfilment.collectionHours && `Hours: ${info.fulfilment.collectionHours}`].filter(Boolean).join(' · ') : info.fulfilment.deliveryNotes}</p>
                {s.fulfilment === 'delivery' && feeLine && <p className="mt-2 rounded-xl bg-brand-soft px-3 py-2 text-[13.5px] text-brand-soft-ink">{feeLine}</p>}
              </div>
            </>
          ) : (
            <>
              <h1 className="font-display text-[28px] font-semibold">Where should we bring it?</h1>
              <p className="mt-1 text-ink-2">Give us your address. We’ll contact you to arrange delivery or collection.</p>
              {feeLine && <p className="mt-3 rounded-xl bg-brand-soft px-3 py-2 text-[13.5px] text-brand-soft-ink">{feeLine}</p>}
            </>
          )}
          {needsAddress && <Field label={chooses ? 'Delivery address' : 'Your address'} hint={chooses ? undefined : 'Street address and suburb, e.g. 12 Kerk Street, Pretoria East.'} className="mt-5"><Textarea rows={3} value={s.address} onChange={(e) => set({ address: e.target.value })} autoComplete="street-address" /></Field>}
          <div className="mt-6 flex gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[13.5px] text-ink-2"><CalendarClock className="mt-0.5 size-4 shrink-0 text-ink-3" /><span>{info.form.leadTime} We’ll confirm the expected date when we confirm your order.</span></div>
          <Field label="Preferred date" optional className="mt-5" hint="Tell us if you need it by a particular day, e.g. for an event.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button type="button" onClick={() => set({ date: '' })} className={cx('rounded-xl border px-3 py-3 text-left text-[14px] font-semibold transition', !s.date ? 'border-brand bg-brand text-brand-ink' : 'border-line-strong bg-surface hover:border-ink-3')}>No preference</button>
              {dates.map((d) => (
                <button type="button" key={d} onClick={() => set({ date: d })} className={cx('rounded-xl border px-3 py-3 text-left transition', s.date === d ? 'border-brand bg-brand text-brand-ink' : 'border-line-strong bg-surface hover:border-ink-3')}>
                  <div className="text-[14px] font-semibold">{friendlyDate(d, info.today)}</div>
                  {['Today', 'Tomorrow'].includes(friendlyDate(d, info.today)) && <div className="text-[12px] opacity-80">{longDate(d).split(' ').slice(0, 3).join(' ')}</div>}
                </button>
              ))}
            </div>
            <div className="mt-3">
              {!laterOpen && !(s.date && !dates.includes(s.date)) ? (
                <button type="button" onClick={() => setLaterOpen(true)} className="inline-flex items-center gap-1.5 text-[14.5px] font-semibold text-brand underline-offset-2 hover:underline">
                  <CalendarClock className="size-4" /> Pick a later date
                </button>
              ) : (
                <div className="rounded-xl border border-line bg-surface p-3">
                  <label htmlFor="later-date" className="text-[14px] font-medium">A later date (up to 3 months ahead)</label>
                  <Input id="later-date" type="date" className="mt-2 w-48" min={info.earliest_date} max={addDays(info.today, 90)} value={s.date && !dates.includes(s.date) ? s.date : ''} onChange={(e) => set({ date: e.target.value })} />
                  {s.date && !dates.includes(s.date) && !allowedDays.includes(new Date(s.date + 'T00:00:00Z').getUTCDay()) && (
                    <p className="mt-2 text-[13px] font-medium text-danger">We’re not {s.fulfilment === 'delivery' && chooses ? 'delivering' : 'open'} on that day of the week. Please choose another day.</p>
                  )}
                  {s.date && !dates.includes(s.date) && allowedDays.includes(new Date(s.date + 'T00:00:00Z').getUTCDay()) && <p className="mt-2 text-[13px] text-ink-2">{longDate(s.date)}</p>}
                </div>
              )}
            </div>
          </Field>
          <Field label="Anything we should know?" optional className="mt-5"><Textarea rows={2} value={s.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. it’s for a braai for 10 people" /></Field>
        </div>
      )}

      {s.step === 3 && (
        <div className="mx-auto max-w-lg animate-rise pb-28">
          <h1 className="font-display text-[28px] font-semibold">Check your order</h1>
          {priceCheck.isPending && <p className="mt-2 flex items-center gap-2 text-[13.5px] text-ink-3"><Spinner className="size-4" />Checking today’s prices and availability…</p>}
          {quoteProblems.length > 0 && (
            <div className="mt-4 flex gap-3 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>Some items can’t be ordered as they are. Please remove or change them below.</div>
            </div>
          )}
          <Card className={cx('mt-5 divide-y divide-line', !s.lines.length && 'hidden')}>
            {s.lines.map((l, i) => {
              const p = byId.get(l.product_id);
              const ql = quote?.lines.find((x) => x.index === i);
              const lq = lineQuote(l, p);
              const prep = Object.values(l.preparation).filter((v) => !p?.options.some((g) => g.options.some((o) => o.name === v && o.is_default)));
              const price = ql ? (ql.ok ? priceText(ql.pricing, ql.cents, p, info.currency) : null) : priceText(lq.pricing, lq.cents, p, info.currency);
              return (
                <div key={l.key} className={cx('px-4 py-3', ql && !ql.ok && 'bg-danger-soft/40')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold">{lq.label} {p?.name ?? 'Unavailable product'}</div>
                      {(prep.length > 0 || l.special_instructions) && <div className="text-[13.5px] text-ink-2">{[prep.join(', '), l.special_instructions].filter(Boolean).join(' · ')}</div>}
                    </div>
                    {price && <div className="shrink-0 text-right text-[14px] font-semibold tabular">{price}</div>}
                  </div>
                  {ql && !ql.ok && (
                    <div className="mt-2 flex items-center justify-between gap-3 text-[13.5px] font-medium text-danger">
                      <span>{ql.problem}</span>
                      <button type="button" className="shrink-0 underline" onClick={() => { set({ lines: s.lines.filter((x) => x.key !== l.key) }); setQuote(null); setTimeout(() => priceCheck.mutate(), 0); }}>Remove</button>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="space-y-2 px-4 py-3">
              {totalBlock}
              {priceNote}
            </div>
          </Card>
          {s.special?.trim() && (
            <Card className="mt-3 p-4 text-[14.5px]">
              <div className="text-[13.5px] font-semibold text-ink-3">Special request</div>
              <p className="mt-1 whitespace-pre-line">{s.special.trim()}</p>
              <p className="mt-2 text-[13px] text-ink-3">We’ll confirm availability and price with you.</p>
            </Card>
          )}
          <Card className="mt-3 space-y-1 p-4 text-[14.5px]">
            <div><b>{s.name}</b> · {s.phone}{s.email ? ` · ${s.email}` : ''}</div>
            <div>{chooses ? (s.fulfilment === 'delivery' ? `Delivery to ${s.address}` : 'Collection') : s.address}</div>
            <div className="text-ink-2">{s.date ? `Preferred date: ${longDate(s.date)}` : 'No preferred date'}</div>
            {!chooses && <div className="text-[13.5px] text-ink-3">We’ll contact you to arrange delivery or collection.</div>}
            {s.notes && <div className="text-ink-2">“{s.notes}”</div>}
            {inv.wanted && <div className="flex items-center gap-1.5 text-ink-2"><Receipt className="size-4 text-ink-3" />Invoice to {inv.billing_name}{inv.company ? ` (${inv.company})` : ''}, {inv.billing_email}</div>}
            <button type="button" onClick={() => set({ step: 1 })} className="pt-1 text-[13.5px] font-medium text-brand underline-offset-2 hover:underline">Change details</button>
          </Card>
          <div className="mt-4 rounded-2xl bg-surface-2 p-4 text-[14px] text-ink-2">
            <p><b className="text-ink">What happens next:</b> we review your order and confirm it with an expected date. {info.form.leadTime}</p>
          </div>
          {terms.length > 0 && (
            <Card className="mt-4 p-4">
              <h2 className="text-[13.5px] font-semibold text-ink-3">Order terms</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[14px] text-ink-2">{terms.map((t) => <li key={t}>{t}</li>)}</ul>
              <label className="mt-4 flex items-start gap-3 text-[14.5px]">
                <input type="checkbox" checked={!!s.accepted} onChange={(e) => set({ accepted: e.target.checked })} className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" />
                <span>I confirm this order is correct and understand it is only confirmed once {info.business.name} accepts it.</span>
              </label>
            </Card>
          )}
          {error && <p className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">{error}</p>}
        </div>
      )}

      {/* Sticky action bar (tucked away while the on-screen keyboard is up) */}
      <div className={cx('safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur transition-transform duration-150', hideBar && 'pointer-events-none translate-y-full')} aria-hidden={hideBar || undefined}>
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-3 sm:px-8">
          {s.step > 0 && <Button size="lg" variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => { setError(null); set({ step: (s.step - 1) as State['step'] }); }}>Back</Button>}
          {s.step === 0 && (
            <div className="min-w-0 flex-1 text-[14px]">
              <div className="font-semibold">{s.lines.length ? `${s.lines.length} item${s.lines.length === 1 ? '' : 's'}${s.special?.trim() ? ' + special request' : ''}` : s.special?.trim() ? 'Special request' : 'Nothing chosen yet'}</div>
              {localTotal > 0 && <div className="text-ink-3">{localExact ? '' : '≈ '}{formatMoney(localTotal, info.currency)}</div>}
            </div>
          )}
          <div className={cx('flex', s.step > 0 && 'flex-1 justify-end')}>
            {s.step < 3 ? (
              s.step === 0 ? (
                <Button variant="primary" size="lg" icon={<ShoppingBag className="size-4" />} disabled={!cartCount} onClick={() => setCartOpen(true)}>View order</Button>
              ) : (
                <Button variant="primary" size="lg" disabled={(s.step === 1 && (!detailsOk || !invoiceOk)) || (s.step === 2 && !whenOk)} onClick={() => set({ step: (s.step + 1) as State['step'] })}>Continue</Button>
              )
            ) : (
              <Button variant="primary" size="lg" disabled={!online || (terms.length > 0 && !s.accepted) || quoteProblems.length > 0 || priceCheck.isPending} loading={submit.isPending} onClick={() => { setError(null); submit.mutate(); }}>Send order</Button>
            )}
          </div>
        </div>
      </div>

      {adding && (
        <AddSheet
          family={[byId.get(adding.p.variant_of ?? '') ?? adding.p, ...(variantsOf.get(adding.p.variant_of ?? adding.p.id) ?? [])].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)}
          start={adding.p}
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
        subtitle={s.lines.length ? `${s.lines.length} item${s.lines.length === 1 ? '' : 's'}${localTotal > 0 ? ` · ${localExact ? '' : '≈ '}${formatMoney(localTotal, info.currency)}` : ''}` : undefined}
        footer={
          <div className="flex gap-2">
            <Button size="lg" variant="ghost" onClick={() => setCartOpen(false)}>Add more</Button>
            <Button size="lg" variant="primary" full disabled={!cartCount} onClick={() => { setCartOpen(false); set({ step: 1 }); }}>Checkout</Button>
          </div>
        }
      >
        {!cartCount ? (
          <p className="py-6 text-center text-ink-2">Nothing in your order yet.</p>
        ) : (
          <div className="space-y-2">
            {s.lines.map((l) => {
              const p = byId.get(l.product_id);
              if (!p) return null;
              const lq = lineQuote(l, p);
              const prep = Object.values(l.preparation).filter((v) => !p.options.some((g) => g.options.some((o) => o.name === v && o.is_default)));
              const price = priceText(lq.pricing, lq.cents, p, info.currency);
              return (
                <div key={l.key} className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-[13.5px] text-ink-2">{[lq.label, ...prep, l.special_instructions].filter(Boolean).join(' · ')}</div>
                    {price && <div className="text-[13px] text-ink-3">{price}</div>}
                  </div>
                  <button type="button" onClick={() => setAdding({ p, line: l })} className="flex size-11 items-center justify-center rounded-xl text-ink-2 hover:bg-sunken" aria-label={`Change ${p.name}`}><Pencil className="size-4" /></button>
                  <button type="button" onClick={() => set({ lines: s.lines.filter((x) => x.key !== l.key) })} className="flex size-11 items-center justify-center rounded-xl text-danger hover:bg-danger-soft" aria-label={`Remove ${p.name}`}><Trash2 className="size-4" /></button>
                </div>
              );
            })}
            {s.special?.trim() && (
              <div className="flex items-start gap-3 rounded-2xl border border-ochre/40 bg-ochre-soft p-3 text-ochre-soft-ink">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">Special request</div>
                  <div className="whitespace-pre-line text-[13.5px]">{s.special.trim()}</div>
                </div>
                <button type="button" onClick={() => set({ special: '' })} className="flex size-11 items-center justify-center rounded-xl hover:bg-white/40" aria-label="Remove special request"><Trash2 className="size-4" /></button>
              </div>
            )}
            <div className="space-y-2 pt-2">
              {localTotal > 0 && (
                <div className="flex items-baseline justify-between text-[15px]"><span className="text-ink-2">{localExact ? 'Total' : 'Estimated total'}</span><b className="tabular">{formatMoney(localTotal, info.currency)}</b></div>
              )}
              {priceNote}
            </div>
          </div>
        )}
      </Sheet>
    </Shell>
  );
}

function Stepper({ value, onChange, min = 1, max = 99, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  return (
    <div className="inline-flex items-center rounded-xl border border-line-strong bg-surface" role="group" aria-label={label}>
      <button type="button" className="flex size-12 items-center justify-center rounded-l-xl text-ink-2 hover:bg-sunken disabled:opacity-40" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Fewer`}><Minus className="size-4" /></button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))))}
        className="h-12 w-14 border-x border-line-strong bg-surface text-center text-[17px] font-semibold tabular [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none"
        aria-label={label}
      />
      <button type="button" className="flex size-12 items-center justify-center rounded-r-xl text-ink-2 hover:bg-sunken disabled:opacity-40" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`More`}><Plus className="size-4" /></button>
    </div>
  );
}

function AddSheet({ family, start, line, existing, onAdd, onRemove, onClose, currency }: { family: CatProduct[]; start: CatProduct; line?: Line; existing: Line[]; onAdd: (l: Line) => void; onRemove: (key: string) => void; onClose: () => void; currency: string }) {
  const [pid, setPid] = useState(line?.product_id ?? start.id);
  const p = family.find((f) => f.id === pid) ?? start;
  const defaults = (prod: CatProduct) => Object.fromEntries(prod.options.map((g) => [g.group, g.options.find((o) => o.is_default)?.name ?? g.options[0]?.name]).filter(([, v]) => v));
  const [qty, setQty] = useState<Qty | null>(line?.qty ?? null);
  const [option, setOption] = useState<string | null>(line?.sale_option ?? p.sale_options[0]?.id ?? null);
  const [count, setCount] = useState<number>(line?.qty.count ?? Math.max(1, p.min_qty ?? 1));
  const [prep, setPrep] = useState<Record<string, string>>(() => line?.preparation ?? defaults(p));
  const [note, setNote] = useState(line?.special_instructions ?? '');
  useEffect(() => {
    if (line && line.product_id === p.id) return;
    setOption(p.sale_options[0]?.id ?? null);
    setPrep(defaults(p));
    setQty(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);
  const usesOptions = p.sale_options.length > 0;
  const opt = usesOptions ? p.sale_options.find((o) => o.id === option) ?? null : null;
  const finalQty: Qty | null = usesOptions ? (opt ? (opt.kind === 'pack' ? { kind: 'portions', count, weight_g: opt.grams } : { kind: 'count', count, weight_g: null }) : null) : qty;
  const draft: Line | null = finalQty ? { key: line?.key ?? newKey(), product_id: p.id, sale_option: usesOptions ? option : null, qty: finalQty, preparation: prep, special_instructions: note.trim() } : null;
  const lq = draft ? lineQuote(draft, p) : null;
  const invalidPack = !usesOptions && !!p.pack_size && (!qty || (qty.count ?? 0) % p.pack_size !== 0);
  const priceLabel = lq ? priceText(lq.pricing, lq.cents, p, currency) : null;
  return (
    <Sheet
      open
      onClose={onClose}
      title={family.length > 1 ? family[0].name : p.name}
      subtitle={p.description ?? undefined}
      footer={
        <Button variant="primary" size="lg" full disabled={!draft || invalidPack || p.out_of_stock} onClick={() => draft && onAdd(draft)} icon={<ShoppingBag className="size-4" />}>
          {line ? 'Update' : 'Add to order'}
          {priceLabel && lq?.pricing !== 'by_weight' ? ` · ${priceLabel}` : ''}
        </Button>
      }
    >
      <div className="space-y-6">
        {existing.length > 0 && (
          <div className="space-y-2">
            {existing.map((l) => (
              <div key={l.key} className="flex items-center justify-between rounded-xl bg-brand-soft px-3 py-2 text-[14px] text-brand-soft-ink">
                <span>Already added: <b>{lineQuote(l, p).label}</b></span>
                <button onClick={() => onRemove(l.key)} className="flex size-10 items-center justify-center rounded-lg hover:bg-white/40" aria-label="Remove"><Trash2 className="size-4" /></button>
              </div>
            ))}
          </div>
        )}
        {family.length > 1 && (
          <Field label="Choose">
            <div className="flex flex-wrap gap-2">
              {family.map((f) => (
                <button key={f.id} type="button" disabled={f.out_of_stock} onClick={() => setPid(f.id)} className={cx('min-h-12 rounded-xl border px-4 py-2 text-left text-[14.5px] font-medium disabled:opacity-50', pid === f.id ? 'border-brand bg-brand-soft text-brand-soft-ink' : 'border-line-strong bg-surface text-ink-2')}>
                  {f.variant_label ?? f.name}
                  {f.price_cents != null && <span className="block text-[12.5px] font-normal">{formatMoney(f.price_cents, currency)}/{f.price_unit}{f.out_of_stock ? ' · out of stock' : ''}</span>}
                </button>
              ))}
            </div>
          </Field>
        )}
        {usesOptions ? (
          <>
            <Field label="Size">
              <div className="grid gap-2 sm:grid-cols-2">
                {p.sale_options.map((o) => {
                  const each = priceText(o.pricing, o.price_cents, p, currency);
                  return (
                    <button key={o.id} type="button" onClick={() => setOption(o.id)} className={cx('rounded-xl border px-4 py-3 text-left', option === o.id ? 'border-brand bg-brand-soft text-brand-soft-ink' : 'border-line-strong bg-surface')}>
                      <div className="text-[15px] font-semibold">{o.label}</div>
                      {each && <div className="text-[13px] opacity-80">{o.pricing === 'by_weight' ? each : `${each} each`}</div>}
                    </button>
                  );
                })}
              </div>
              {opt?.kind === 'pack' && <p className="mt-2 text-[13px] text-ink-3">Fixed-weight vacuum packs.</p>}
              {opt?.kind === 'piece' && <p className="mt-2 text-[13px] text-ink-3">Priced on the actual weight once cut{opt.grams ? `; about ${opt.grams >= 1000 ? `${opt.grams / 1000} kg` : `${opt.grams} g`} each` : ''}.</p>}
            </Field>
            <Field label={opt?.kind === 'pack' ? 'How many packs?' : 'How many?'}>
              <Stepper value={count} onChange={setCount} min={Math.max(1, p.min_qty ?? 1)} max={p.max_qty ?? 50} label="Quantity" />
            </Field>
          </>
        ) : (
          <Field label="How much?">
            <QuantityInput value={qty} onChange={setQty} quantityType={p.quantity_type} allowsPortions={p.allows_portions} pieceNoun={p.piece_noun} packSize={p.pack_size ?? undefined} />
            {p.pack_size && (
              <p className={cx('mt-2 text-[13px]', qty && (qty.count ?? 0) % p.pack_size !== 0 ? 'font-medium text-danger' : 'text-ink-3')}>
                {qty && (qty.count ?? 0) % p.pack_size === 0 && (qty.count ?? 0) > 0 ? `${(qty.count ?? 0) / p.pack_size} × ${p.pack_size} ${p.piece_noun}s` : `Sold in lots of ${p.pack_size}: ${p.pack_size}, ${p.pack_size * 2}, ${p.pack_size * 3}…`}
              </p>
            )}
            {p.typical_piece_g && p.quantity_type !== 'weight' && <p className="mt-2 text-[13px] text-ink-3">One {p.piece_noun} is about {p.typical_piece_g >= 1000 ? `${p.typical_piece_g / 1000}kg` : `${p.typical_piece_g}g`}.</p>}
          </Field>
        )}
        {p.options.map((g) => (
          <Field key={g.group} label={g.group}>
            <div className="flex flex-wrap gap-2">
              {g.options.map((o) => (
                <button key={o.name} type="button" onClick={() => setPrep((x) => ({ ...x, [g.group]: o.name }))} className={cx('min-h-11 rounded-xl border px-4 text-[14.5px] font-medium', prep[g.group] === o.name ? 'border-brand bg-brand-soft text-brand-soft-ink' : 'border-line-strong bg-surface text-ink-2')}>
                  {o.name}
                  {o.surcharge_pct > 0 && <span className="ml-1 text-[12.5px] font-semibold">+{o.surcharge_pct}%</span>}
                </button>
              ))}
            </div>
            {g.options.some((o) => o.surcharge_pct > 0 && prep[g.group] === o.name) && p.price_cents != null && (
              <p className="mt-2 text-[13px] text-ink-2">
                {formatMoney(withSurcharge(p.price_cents, g.options.find((o) => o.name === prep[g.group])!.surcharge_pct), currency)}/{p.price_unit} instead of {formatMoney(p.price_cents, currency)}/{p.price_unit}. Confirmed by the farm before it’s prepared.
              </p>
            )}
          </Field>
        ))}
        {priceLabel && <p className="rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink-2">{lq?.pricing === 'exact' ? 'Price' : 'Estimated price'}: <b className="text-ink">{priceLabel}</b></p>}
        <Field label="Notes for this item" optional><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={p.quantity_type === 'count' && !p.options.length ? 'Anything we should know' : 'e.g. extra thick, 2 per pack'} /></Field>
      </div>
    </Sheet>
  );
}

function Shell({ children, business, cartCount, onCart, barHidden }: { children: ReactNode; business?: any; cartCount?: number; onCart?: () => void; barHidden?: boolean }) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="bg-charcoal text-white">
        <div className="mx-auto flex h-[72px] max-w-5xl items-center justify-between gap-3 px-5 sm:px-8">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <Logo withWord={false} tone="light" />
            <div className="min-w-0">
              <div className="truncate font-display text-[19px] font-bold leading-none">{business?.name ?? 'Terram Farm'}</div>
              <div className="mt-1 text-[12.5px] font-medium opacity-80">Order form</div>
            </div>
          </Link>
          {!!cartCount && <button onClick={onCart} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3.5 text-[13.5px] font-semibold" aria-label={`Your order: ${cartCount} item${cartCount === 1 ? '' : 's'}`}><ShoppingBag className="size-4" />{cartCount}</button>}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-7 sm:px-8 sm:py-10">{children}</main>
      {!barHidden && <BackToTop className="bottom-[calc(96px+env(safe-area-inset-bottom))]" />}
      {business?.phone && (
        <footer className="mx-auto max-w-5xl px-5 pb-32 text-center text-[13px] text-ink-3 sm:px-8">
          Questions? Call or WhatsApp <a className="font-semibold text-ink-2" href={`tel:${business.phone.replace(/\s/g, '')}`}>{business.phone}</a>
        </footer>
      )}
    </div>
  );
}

import { ChevronDown, MessageCircle, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PublicShell } from '../components/PublicShell';
import { usePublicInfo } from '../components/SiteChrome';
import { cx, Spinner } from '../components/ui';

/** The order categories are shown first, in this order; anything else the farm adds follows. */
export const FAQ_ORDER = ['Ordering', 'Products and packaging', 'Payment', 'Invoices', 'Delivery', 'Collection', 'Order updates', 'Product availability', 'Contact'];

export interface Faq { q: string; a: string; category?: string }

export function groupFaq(faq: Faq[]) {
  const cats = [...new Set(faq.map((f) => f.category || 'Ordering'))].sort((a, b) => (FAQ_ORDER.indexOf(a) + 1 || 99) - (FAQ_ORDER.indexOf(b) + 1 || 99));
  return cats.map((c) => ({ category: c, items: faq.filter((f) => (f.category || 'Ordering') === c) }));
}

export function FaqItem({ f, id }: { f: Faq; id?: string }) {
  return (
    <details className="group" id={id}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-[15.5px] font-semibold [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{f.q}</span>
        <ChevronDown className="size-4 shrink-0 text-ink-3 transition group-open:rotate-180" aria-hidden />
      </summary>
      <p className="whitespace-pre-line px-4 pb-4 text-[15px] leading-relaxed text-ink-2">{f.a}</p>
    </details>
  );
}

/** FAQs: the farm's own answers (edited in Settings), grouped by topic, with a filter and WhatsApp. */
export default function Help() {
  const { data: info } = usePublicInfo();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('All');
  useEffect(() => {
    document.title = info ? `FAQs · ${info.business.name}` : 'FAQs';
  }, [info]);
  const faq: Faq[] = info?.help?.faq ?? [];
  const wa: string | null = info?.help?.whatsapp ?? null;
  const groups = useMemo(() => groupFaq(faq), [faq]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = groups
    .filter((g) => cat === 'All' || g.category === cat || words.length > 0)
    .map((g) => ({ ...g, items: g.items.filter((f) => words.every((w) => `${f.q} ${f.a}`.toLowerCase().includes(w))) }))
    .filter((g) => g.items.length);
  return (
    <PublicShell subtitle="FAQs">
      {!info ? (
        <div className="flex justify-center py-24"><Spinner className="size-6" /></div>
      ) : (
        <div className="animate-rise space-y-6">
          <div>
            <h1 className="font-display text-[30px] font-semibold leading-tight">Frequently asked questions</h1>
            <p className="mt-2 text-[15.5px] text-ink-2">How ordering, weighing, payment and delivery work at {info.business.name}. For a particular order, open it from your latest email or <Link to="/account" className="font-semibold text-brand underline">view your orders</Link>.</p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-ink-3" aria-hidden />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the questions" aria-label="Search the questions" className="h-12 w-full rounded-[10px] border border-line-strong bg-surface pl-10 pr-11 text-[16px] outline-none focus:border-brand focus:ring-3 focus:ring-brand/15 [&::-webkit-search-cancel-button]:hidden" />
            {q && <button type="button" onClick={() => setQ('')} className="absolute right-1.5 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-ink-3" aria-label="Clear search"><X className="size-4" /></button>}
          </div>
          {!words.length && groups.length > 1 && (
            <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0" role="tablist" aria-label="Topics">
              {['All', ...groups.map((g) => g.category)].map((c) => (
                <button key={c} type="button" role="tab" aria-selected={cat === c} onClick={() => setCat(c)} className={cx('h-10 shrink-0 rounded-full border px-4 text-[14px] font-medium', cat === c ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink-2')}>{c}</button>
              ))}
            </div>
          )}
          {shown.length === 0 && <p className="rounded-2xl bg-surface-2 p-4 text-[14.5px] text-ink-2">No questions match “{q.trim()}”. {wa ? 'Ask us on WhatsApp below.' : 'Please contact us.'}</p>}
          {shown.map((g) => (
            <section key={g.category} aria-labelledby={`faq-${g.category}`}>
              <h2 id={`faq-${g.category}`} className="mb-2 font-display text-[19px] font-bold">{g.category}</h2>
              <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                {g.items.map((f, i) => <FaqItem key={i} f={f} />)}
              </div>
            </section>
          ))}
          {wa && (
            <a href={wa} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#1f9d55] text-white"><MessageCircle className="size-5" /></span>
              <span className="min-w-0"><span className="block font-semibold">Still have a question? Chat to us on WhatsApp</span><span className="block text-[13.5px] text-ink-2">{info.business.phone}</span></span>
            </a>
          )}
          <div className="flex flex-wrap gap-2">
            <Link to="/order" className="inline-flex h-12 items-center rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink">Order now</Link>
            <Link to="/" className="inline-flex h-12 items-center rounded-xl border border-line-strong bg-surface px-5 text-[15px] font-semibold">Back to home</Link>
          </div>
        </div>
      )}
    </PublicShell>
  );
}

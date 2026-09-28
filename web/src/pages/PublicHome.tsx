import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck, Mail, MessageCircle, Phone, ShoppingBag, Store, Truck } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/order-bits';
import { BackToTop } from '../components/BackToTop';
import { api } from '../lib/api';

/**
 * terramfarm.co.za — the public face of the farm for signed-out visitors: what we sell,
 * how ordering works, and the way into the order form. The staff app sits behind
 * "Staff sign in" (/login). Built from live settings and products, so it stays current.
 * This is the page the wider farm website can grow from.
 */
interface CatProduct { id: string; name: string; category: string; description: string | null }

const topLevel = (c: string) => c.split(/\s+[–-]\s+/)[0];

export default function PublicHome() {
  const { data: info } = useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info') });
  const { data: cat } = useQuery({ queryKey: ['catalogue'], queryFn: () => api.get<{ products: CatProduct[] }>('/api/public/catalogue') });
  const name: string = info?.business.name ?? 'Terram Farm';
  const phone: string = info?.business.phone ?? '';
  const email: string = info?.business.email ?? '';
  const wa = phone.replace(/\D/g, '').replace(/^0/, '27');
  const orderingOpen = info?.form?.enabled !== false;

  useEffect(() => {
    document.title = `${name} · Farm-raised Beef & Lamb`;
  }, [name]);

  // One card per range (Beef, Lamb, Eggs…) with a few of its products
  const groups = [...new Set((cat?.products ?? []).map((p) => topLevel(p.category)))].map((g) => {
    const items = (cat?.products ?? []).filter((p) => topLevel(p.category) === g);
    const text = items.length === 1 && items[0].description ? items[0].description : `${items.slice(0, 4).map((p) => p.name).join(', ')}${items.length > 4 ? ` and ${items.length - 4} more` : ''}.`;
    return { group: g, count: items.length, text };
  });

  return (
    <div className="min-h-dvh bg-bg">
      <header className="bg-charcoal text-white">
        <div className="mx-auto flex h-[72px] max-w-5xl items-center justify-between gap-3 px-5 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Logo withWord={false} tone="light" />
            <span className="truncate font-display text-[19px] font-bold">{name}</span>
          </div>
          <Link to="/login" className="shrink-0 rounded-lg px-3 py-2 text-[13.5px] font-medium text-white/75 hover:bg-white/10 hover:text-white">
            Staff sign in
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-charcoal text-white">
        <div className="mx-auto max-w-5xl px-5 pb-16 pt-10 sm:px-8 sm:pb-24 sm:pt-16">
          <p className="text-[14px] font-semibold text-white/65">A Metcalf Family Farm</p>
          <h1 className="mt-3 max-w-2xl font-display text-[38px] font-extrabold leading-[1.05] tracking-tight sm:text-[56px]">Farm-raised Beef &amp; Lamb.</h1>
          <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-white/80">{info?.business.tagline ?? 'Grown with Purpose. Shared with Passion.'} Order online and we’ll prepare it for collection or delivery.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {orderingOpen && (
              <Link to="/order" className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink shadow-float transition hover:bg-brand-hover">
                <ShoppingBag className="size-5" /> Order now
              </Link>
            )}
            {wa && (
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/25 px-5 text-[15px] font-semibold text-white transition hover:bg-white/10">
                <MessageCircle className="size-5" /> WhatsApp us
              </a>
            )}
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
        {/* What we sell */}
        {groups.length > 0 && (
          <section>
            <h2 className="font-display text-[26px] font-bold">What we offer</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              {groups.map((g) => (
                <Link key={g.group} to="/order" className="group rounded-2xl border border-line bg-surface p-5 shadow-card transition hover:shadow-float">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-display text-[20px] font-bold">{g.group}</h3>
                    {g.count > 1 && <span className="text-[13px] text-ink-3">{g.count} products</span>}
                  </div>
                  <p className="mt-2 text-[14.5px] text-ink-2">{g.text}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-[14px] font-semibold text-brand">See prices &amp; order <ArrowRight className="size-4 transition group-hover:translate-x-0.5" /></span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* How it works */}
        <section className="mt-14">
          <h2 className="font-display text-[26px] font-bold">How ordering works</h2>
          <ol className="mt-5 grid gap-4 sm:grid-cols-3">
            {[
              { icon: ShoppingBag, title: 'Choose online', body: 'Pick your cuts and quantities on our order form, check your order, then send it. Prices are shown per kg.' },
              { icon: CalendarCheck, title: 'We confirm', body: 'We check stock and confirm your order. We recommend ordering 7–14 days ahead.' },
              info?.fulfilment?.customerChooses === false
                ? { icon: Truck, title: 'Delivery or collection', body: `We’ll contact you to arrange delivery or collection from ${info?.fulfilment?.collectionPlace ?? 'our shop'}. ${info?.fulfilment?.deliveryNotes ?? ''}` }
                : { icon: info?.fulfilment?.deliveryEnabled ? Truck : Store, title: 'Collect or delivery', body: `Collect from ${info?.fulfilment?.collectionPlace ?? 'our shop'}${info?.fulfilment?.collectionHours ? ` (${info.fulfilment.collectionHours})` : ''}${info?.fulfilment?.deliveryEnabled ? `, or have it delivered. ${info?.fulfilment?.deliveryNotes ?? ''}` : '.'}` },
            ].map((s, i) => (
              <li key={s.title} className="rounded-2xl bg-surface-2 p-5">
                <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand"><s.icon className="size-5" /></span>
                <h3 className="mt-3 text-[16px] font-semibold">{i + 1}. {s.title}</h3>
                <p className="mt-1 text-[14.5px] text-ink-2">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Order CTA + contact */}
        <section className="mt-14 flex flex-col gap-6 rounded-3xl bg-brand-soft p-6 text-brand-soft-ink sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div>
            <h2 className="font-display text-[24px] font-bold">Ready to order?</h2>
            <p className="mt-1 text-[15px]">Something not on the list, like venison or a special cut? Ask under Special requests on the form.</p>
          </div>
          {orderingOpen && (
            <Link to="/order" className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink transition hover:bg-brand-hover">
              Order now <ArrowRight className="size-5" />
            </Link>
          )}
        </section>
      </main>

      <BackToTop />
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-8 text-[14px] text-ink-2 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {phone && <a href={`tel:${phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-1.5 hover:text-ink"><Phone className="size-4" />{phone}</a>}
            {email && <a href={`mailto:${email}`} className="inline-flex items-center gap-1.5 hover:text-ink"><Mail className="size-4" />{email}</a>}
          </div>
          <span className="text-ink-3"><Link to="/privacy" className="hover:text-ink">Privacy notice</Link> · © {new Date().getFullYear()} {name}</span>
        </div>
      </footer>
    </div>
  );
}

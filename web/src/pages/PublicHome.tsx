import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck, CreditCard, ExternalLink, MessageCircle, PackageCheck, Scale, ShoppingBag, Snowflake, Star, Truck } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BackToTop } from '../components/BackToTop';
import { SiteFooter, SiteHeader, usePublicInfo } from '../components/SiteChrome';
import { InstagramCard, ReviewBubble } from '../components/Social';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { FaqItem, groupFaq, type Faq } from './Help';
import { SignIn } from './CustomerAccount';

/**
 * terramfarm.co.za — the public face of the farm for signed-out visitors: what we sell, how
 * ordering, payment and delivery work, the way into the order form and "View my orders". Built
 * from live settings and products, so it stays current. Staff sign in at /login.
 */
interface CatProduct { id: string; name: string; category: string; description: string | null; out_of_stock?: boolean; variant_of?: string | null }

const topLevel = (c: string) => c.split(/\s+[–-]\s+/)[0];

const SECTIONS = [
  { id: 'products', label: 'Products' },
  { id: 'how', label: 'How it works' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'about', label: 'About' },
  { id: 'my-orders', label: 'My orders' },
  { id: 'faq', label: 'FAQs' },
  { id: 'contact', label: 'Contact' },
];

export default function PublicHome() {
  const { data: info } = usePublicInfo();
  const { data: cat } = useQuery({ queryKey: ['catalogue'], queryFn: () => api.get<{ products: CatProduct[] }>('/api/public/catalogue') });
  const loc = useLocation();
  const navigate = useNavigate();
  const name: string = info?.business.name ?? 'Terram Farm';
  const phone: string = info?.business.phone ?? '';
  const wa = phone.replace(/\D/g, '').replace(/^0/, '27');
  const orderingOpen = info?.form?.enabled !== false;
  const fee: number | null = info?.delivery?.fee_cents ?? null;

  useEffect(() => {
    document.title = `${name} · Farm-raised Beef & Lamb`;
  }, [name]);
  // "/#contact" and other section links from the other pages
  useEffect(() => {
    if (!loc.hash) return;
    const t = setTimeout(() => {
      document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
    return () => clearTimeout(t);
  }, [loc.hash, info]);

  // One card per range (Beef, Lamb, Eggs…) with a few of its products
  const offered = (cat?.products ?? []).filter((p) => !p.out_of_stock && !p.variant_of);
  const groups = [...new Set(offered.map((p) => topLevel(p.category)))].map((g) => {
    const items = offered.filter((p) => topLevel(p.category) === g);
    const text = items.length === 1 && items[0].description ? items[0].description : `${items.slice(0, 4).map((p) => p.name).join(', ')}${items.length > 4 ? ` and ${items.length - 4} more` : ''}.`;
    return { group: g, count: items.length, text };
  });
  const faqPreview: Faq[] = groupFaq(info?.help?.faq ?? []).flatMap((g) => g.items.slice(0, 1)).slice(0, 5);
  const aboutSections: { title: string; body: string }[] = info?.content?.aboutSections ?? [];

  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader />

      {/* Hero */}
      <section className="bg-charcoal text-white">
        <div className="mx-auto max-w-5xl px-5 pb-14 pt-10 sm:px-8 sm:pb-20 sm:pt-16">
          <p className="text-[14px] font-semibold text-white/65">A Metcalf Family Farm</p>
          <h1 className="mt-3 max-w-2xl font-display text-[38px] font-extrabold leading-[1.05] tracking-tight sm:text-[56px]">Farm-raised Beef &amp; Lamb.</h1>
          <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-white/80">{info?.business.tagline ?? 'Grown with Purpose. Shared with Passion.'} Order online and we’ll cut, pack and weigh it for you.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {orderingOpen && (
              <Link to="/order" className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink shadow-float transition hover:bg-brand-hover">
                <ShoppingBag className="size-5" /> Order now
              </Link>
            )}
            <a href="#my-orders" className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/25 px-5 text-[15px] font-semibold text-white transition hover:bg-white/10">View my orders</a>
            {wa && (
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/25 px-5 text-[15px] font-semibold text-white transition hover:bg-white/10">
                <MessageCircle className="size-5" /> WhatsApp us
              </a>
            )}
          </div>
        </div>
      </section>

      {/* Section navigation */}
      <nav className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur" aria-label="On this page">
        <div className="mx-auto flex max-w-5xl gap-1.5 overflow-x-auto px-5 py-2 scrollbar-none sm:px-8">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="h-9 shrink-0 rounded-full px-3.5 text-[13.5px] font-semibold leading-9 text-ink-2 hover:bg-sunken">{s.label}</a>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-5xl space-y-14 px-5 py-12 sm:px-8 sm:py-16 [&>section]:scroll-mt-16">
        {/* Intro */}
        {info?.content?.aboutIntro && (
          <section aria-label="Introduction">
            <p className="max-w-3xl font-display text-[21px] leading-relaxed text-ink sm:text-[24px]">{info.content.aboutIntro}</p>
          </section>
        )}

        {/* What we sell */}
        <section id="products">
          <h2 className="font-display text-[26px] font-bold">What we offer</h2>
          {groups.length > 0 ? (
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
          ) : (
            <p className="mt-3 text-ink-2">See our full price list on the <Link to="/order" className="font-semibold text-brand underline">order form</Link>.</p>
          )}
        </section>

        {/* Ordering information */}
        <section aria-labelledby="ordering-info">
          <h2 id="ordering-info" className="font-display text-[26px] font-bold">Good to know before you order</h2>
          <ul className="mt-5 grid gap-3 sm:grid-cols-2">
            {[
              { icon: Snowflake, title: 'Frozen and vacuum-packed', body: 'Our products are supplied frozen and vacuum-packed.' },
              { icon: Scale, title: 'Priced on the final weight', body: 'Weighed cuts are priced per kg. Weights you choose, like 300–400 g a steak, are a preference; we weigh your order when it’s packed.' },
              { icon: PackageCheck, title: 'Mince in 500 g packets', body: 'Choose the number of packets, e.g. 4 × 500 g = 2 kg.' },
              { icon: CalendarCheck, title: 'Order ahead', body: info?.form?.leadTime ?? 'Orders are subject to processing time and stock availability.' },
            ].map((x) => (
              <li key={x.title} className="flex gap-3 rounded-2xl border border-line bg-surface p-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"><x.icon className="size-5" /></span>
                <span className="min-w-0"><span className="block font-semibold">{x.title}</span><span className="mt-0.5 block text-[14.5px] text-ink-2">{x.body}</span></span>
              </li>
            ))}
          </ul>
        </section>

        {/* How it works */}
        <section id="how">
          <h2 className="font-display text-[26px] font-bold">How ordering works</h2>
          <ol className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: ShoppingBag, title: 'Choose online', body: 'Pick your products and quantities, add your details and send your order.' },
              { icon: CalendarCheck, title: 'We confirm', body: 'We check the products, quantities and availability, then confirm your order with an expected date.' },
              { icon: CreditCard, title: 'Pay the final amount', body: 'Once it’s cut, packed and weighed we send a secure payment page with the final amount. Pay by EFT, then tap “Already paid?”.' },
              { icon: Truck, title: 'Delivery', body: 'We deliver within our regular local area, or arrange it with you.' },
            ].map((s, i) => (
              <li key={s.title} className="rounded-2xl bg-surface-2 p-5">
                <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand"><s.icon className="size-5" /></span>
                <h3 className="mt-3 text-[16px] font-semibold">{i + 1}. {s.title}</h3>
                <p className="mt-1 text-[14.5px] text-ink-2">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Delivery */}
        <section id="delivery" className="rounded-3xl border border-line bg-surface p-6 sm:p-8">
          <h2 className="flex items-center gap-2 font-display text-[26px] font-bold"><Truck className="size-6 text-brand" />Delivery</h2>
          <p className="mt-3 max-w-2xl text-[15.5px] leading-relaxed text-ink-2">{info?.delivery?.area ?? 'We deliver within our regular local delivery area. Other locations can be arranged separately.'}</p>
          {fee != null && <p className="mt-3 text-[15.5px]"><b>Standard delivery fee: {formatMoney(fee, info?.currency ?? 'ZAR')}</b> per order, shown at checkout.</p>}
          <p className="mt-2 max-w-2xl text-[14.5px] text-ink-2">{info?.delivery?.policy ?? 'We will contact you to confirm the delivery arrangements.'}</p>
        </section>

        {/* About */}
        <section id="about">
          <h2 className="font-display text-[26px] font-bold">About {name}</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {aboutSections.filter((s) => s.title || s.body).slice(0, 3).map((s, i) => (
              <div key={i} className="rounded-2xl bg-surface-2 p-5">
                {s.title && <h3 className="font-semibold">{s.title}</h3>}
                {s.body && <p className="mt-1 line-clamp-5 text-[14.5px] text-ink-2">{s.body}</p>}
              </div>
            ))}
          </div>
          <Link to="/about" className="mt-4 inline-flex items-center gap-1 text-[15px] font-semibold text-brand">More about us <ArrowRight className="size-4" /></Link>
        </section>

        {/* View my orders */}
        <section id="my-orders" className="grid items-start gap-6 lg:grid-cols-[1fr_minmax(0,420px)]">
          <div>
            <h2 className="font-display text-[26px] font-bold">Already ordered?</h2>
            <p className="mt-2 max-w-md text-[15.5px] text-ink-2">See your orders, what’s been weighed, what you owe, payment and delivery status, and download your invoices. Enter your mobile number and we’ll send you a one-time code.</p>
          </div>
          <SignIn compact onDone={() => navigate('/account')} />
        </section>

        {/* Reviews + social (configured links only) */}
        {(info?.business.googleReviewUrl || info?.business.instagramUrl || info?.business.facebookUrl) && (
          <section aria-labelledby="reviews" className="grid gap-4 sm:grid-cols-2">
            <h2 id="reviews" className="sr-only">Reviews and social media</h2>
            {info.business.googleReviewUrl && (
              <div className="rounded-2xl border-2 border-ochre/40 bg-ochre-soft/40 p-5">
                <div className="flex items-center gap-1 text-ochre" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="size-5 fill-current" />)}</div>
                <div className="mt-2 font-semibold">Ordered from us? Leave us a Google review</div>
                <p className="mt-1 text-[14px] text-ink-2">It helps other families find a local farm. It takes less than a minute.</p>
                <a href={info.business.googleReviewUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-4 text-[15px] font-semibold text-brand-ink">Leave a Google review <ExternalLink className="size-4" /></a>
              </div>
            )}
            <div className="space-y-3">
              <InstagramCard url={info.business.instagramUrl} name={name} />
              {info.business.facebookUrl && (
                <a href={info.business.facebookUrl} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 transition hover:shadow-card">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#1877f2] font-display text-[22px] font-bold text-white" aria-hidden>f</span>
                  <span className="min-w-0 flex-1"><span className="block font-semibold">{name} on Facebook</span><span className="block text-[13.5px] text-ink-2">News and updates from the farm.</span></span>
                  <ExternalLink className="size-4 shrink-0 text-ink-3" />
                </a>
              )}
            </div>
          </section>
        )}

        {/* FAQ preview */}
        {faqPreview.length > 0 && (
          <section id="faq">
            <h2 className="font-display text-[26px] font-bold">Questions</h2>
            <div className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {faqPreview.map((f, i) => <FaqItem key={i} f={f} />)}
            </div>
            <Link to="/faq" className="mt-4 inline-flex items-center gap-1 text-[15px] font-semibold text-brand">All FAQs <ArrowRight className="size-4" /></Link>
          </section>
        )}

        {/* Order CTA */}
        <section className="flex flex-col gap-6 rounded-3xl bg-brand-soft p-6 text-brand-soft-ink sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div>
            <h2 className="font-display text-[24px] font-bold">Ready to order?</h2>
            <p className="mt-1 text-[15px]">Something not on the list, or a special cut? Ask under Special requests on the order form.</p>
          </div>
          {orderingOpen && (
            <Link to="/order" className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink transition hover:bg-brand-hover">
              Order now <ArrowRight className="size-5" />
            </Link>
          )}
        </section>
      </main>

      <BackToTop />
      <ReviewBubble url={info?.business.googleReviewUrl} name={name} />
      <SiteFooter />
    </div>
  );
}

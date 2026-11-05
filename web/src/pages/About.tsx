import { ArrowRight, Beef, Leaf, ListChecks, MapPin, PackageCheck, ShoppingBag, Sprout } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BackToTop } from '../components/BackToTop';
import { SiteFooter, SiteHeader, usePublicInfo } from '../components/SiteChrome';
import { GoogleReviewCard, InstagramCard, ReviewBubble } from '../components/Social';
import { Spinner } from '../components/ui';

/**
 * About Us. The words are the farm's own (Settings → About page); this page only lays them out:
 * a hero from the introduction, each section as its own block, numbered steps as a timeline and the
 * farm's tagline as a quote. Nothing is added that the farm hasn't written.
 */

type Block = { kind: 'p'; text: string } | { kind: 'steps'; steps: { n: string; title: string; text: string }[] } | { kind: 'quote'; text: string };

const paras = (t: string) => t.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);

/** Turns a section's plain text into paragraphs, numbered steps ("1. Title – text") and the tagline quote. */
function blocks(body: string, tagline: string): Block[] {
  const out: Block[] = [];
  for (const p of paras(body)) {
    const step = p.match(/^(\d+)[.)]\s+(.+)$/s);
    if (step) {
      const [title, ...rest] = step[2].split(/\s+[–—-]\s+/);
      const text = rest.join(' – ');
      const last = out[out.length - 1];
      const item = { n: step[1], title: text ? title.trim() : '', text: (text || step[2]).trim() };
      if (last?.kind === 'steps') last.steps.push(item);
      else out.push({ kind: 'steps', steps: [item] });
    } else if (tagline && p.replace(/\s+/g, ' ').toLowerCase() === tagline.replace(/\s+/g, ' ').toLowerCase()) {
      out.push({ kind: 'quote', text: p });
    } else {
      out.push({ kind: 'p', text: p });
    }
  }
  return out;
}

function iconFor(title: string) {
  const t = title.toLowerCase();
  if (/offer|product|meat|cut/.test(t)) return Beef;
  if (/how|order|work/.test(t)) return ListChecks;
  if (/where|find|visit|deliver/.test(t)) return MapPin;
  return Leaf;
}

/** Short facts, shown only when the farm's own introduction says them. */
function highlights(intro: string): { icon: typeof Leaf; text: string }[] {
  const t = intro.toLowerCase();
  return [
    /farm-raised|raise (beef|lamb)/.test(t) && { icon: Sprout, text: 'Farm-raised beef & lamb' },
    /prepared to order|prepare each order/.test(t) && { icon: ShoppingBag, text: 'Prepared to order' },
    /vacuum/.test(t) && { icon: PackageCheck, text: 'Vacuum-packed' },
  ].filter(Boolean) as { icon: typeof Leaf; text: string }[];
}

export default function About() {
  const { data: info } = usePublicInfo();
  const name: string = info?.business?.name ?? 'Terram Farm';
  useEffect(() => {
    document.title = `About Us · ${name}`;
  }, [name]);
  const intro = paras(info?.content?.aboutIntro ?? '');
  // A short first line ("From our family farm to your family table.") becomes the headline
  const headline = intro[0] && intro[0].length <= 90 ? intro[0] : 'Farm-raised Beef & Lamb';
  const lead = intro[0] && intro[0].length <= 90 ? intro.slice(1) : intro;
  const sections: { title: string; body: string }[] = (info?.content?.aboutSections ?? []).filter((s: any) => s.title || s.body);
  const tagline: string = info?.business?.tagline ?? '';
  const facts = highlights(info?.content?.aboutIntro ?? '');

  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader subtitle="About Us" />
      {!info ? (
        <div className="flex justify-center py-24"><Spinner className="size-6" /></div>
      ) : (
        <>
          {/* Hero */}
          <section className="bg-charcoal text-white">
            <div className="mx-auto max-w-5xl px-5 pb-14 pt-10 sm:px-8 sm:pb-20 sm:pt-16">
              <p className="text-[14px] font-semibold text-white/65">About {name}</p>
              <h1 className="mt-3 max-w-3xl font-display text-[34px] font-extrabold leading-[1.08] tracking-tight sm:text-[50px]">{headline}</h1>
              {lead.map((p, i) => (
                <p key={i} className={i === 0 ? 'mt-5 max-w-2xl text-[17px] leading-relaxed text-white/85 sm:text-[18px]' : 'mt-3 max-w-2xl text-[15.5px] leading-relaxed text-white/70'}>{p}</p>
              ))}
              {facts.length > 0 && (
                <ul className="mt-7 flex flex-wrap gap-2">
                  {facts.map((f) => (
                    <li key={f.text} className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-3.5 py-1.5 text-[13.5px] font-semibold text-white/90">
                      <f.icon className="size-4 text-white/70" />{f.text}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/order" className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink shadow-float transition hover:bg-brand-hover">
                  <ShoppingBag className="size-5" /> Order now
                </Link>
                {sections.length > 0 && (
                  <a href="#story" className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/25 px-5 text-[15px] font-semibold text-white transition hover:bg-white/10">Read more</a>
                )}
              </div>
            </div>
          </section>

          <main id="story" className="mx-auto max-w-5xl scroll-mt-4 space-y-6 px-5 py-12 sm:space-y-8 sm:px-8 sm:py-16">
            {sections.map((s, i) => {
              const Icon = iconFor(s.title);
              return (
                <section key={i} className="grid gap-5 rounded-3xl border border-line bg-surface p-6 shadow-card sm:p-8 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-10">
                  <header className="md:pt-1">
                    <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand"><Icon className="size-6" /></span>
                    {s.title && <h2 className="mt-4 font-display text-[24px] font-bold leading-tight sm:text-[26px]">{s.title}</h2>}
                  </header>
                  <div className="min-w-0 space-y-4">{blocks(s.body, tagline).map((b, j) => <BlockView key={j} b={b} />)}</div>
                </section>
              );
            })}

            {/* Close: order, plus reviews and Instagram (only if set up) */}
            <section className="flex flex-col gap-6 rounded-3xl bg-brand-soft p-6 text-brand-soft-ink sm:flex-row sm:items-center sm:justify-between sm:p-8">
              <div>
                <h2 className="font-display text-[24px] font-bold">Ready to order?</h2>
                <p className="mt-1 text-[15px]">Browse our beef and lamb, or read how ordering, payment and delivery work.</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Link to="/order" className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink transition hover:bg-brand-hover">Order now <ArrowRight className="size-4" /></Link>
                <Link to="/faq" className="inline-flex h-12 items-center rounded-xl border border-brand/30 bg-surface px-5 text-[15px] font-semibold text-ink">FAQs</Link>
              </div>
            </section>
            {(info.business.googleReviewUrl || info.business.instagramUrl) && (
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <GoogleReviewCard url={info.business.googleReviewUrl} name={name} lead={`Ordered from ${name}? Tell others what you thought`} />
                <InstagramCard url={info.business.instagramUrl} name={name} />
              </div>
            )}
          </main>
        </>
      )}
      <BackToTop />
      <ReviewBubble url={info?.business?.googleReviewUrl} name={name} />
      <SiteFooter />
    </div>
  );
}

function BlockView({ b }: { b: Block }): ReactNode {
  if (b.kind === 'quote')
    return (
      <blockquote className="border-l-4 border-brand pl-4 font-display text-[21px] font-semibold italic leading-snug text-ink sm:text-[23px]">{b.text}</blockquote>
    );
  if (b.kind === 'steps')
    return (
      <ol className="relative space-y-4 before:absolute before:bottom-4 before:left-[17px] before:top-4 before:w-px before:bg-line">
        {b.steps.map((st) => (
          <li key={st.n} className="relative flex gap-4">
            <span className="relative z-[1] flex size-9 shrink-0 items-center justify-center rounded-full bg-brand font-display text-[15px] font-bold text-brand-ink">{st.n}</span>
            <div className="min-w-0 pt-1">
              {st.title && <div className="font-semibold text-ink">{st.title}</div>}
              <p className="text-[15px] leading-relaxed text-ink-2">{st.text}</p>
            </div>
          </li>
        ))}
      </ol>
    );
  return <p className="whitespace-pre-line text-[15.5px] leading-relaxed text-ink-2">{b.text}</p>;
}

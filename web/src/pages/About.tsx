import { ArrowRight, Beef, Leaf, ListChecks, MapPin, ShoppingBag, Sprout } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BackToTop } from '../components/BackToTop';
import { SiteFooter, SiteHeader, usePublicInfo } from '../components/SiteChrome';
import { GoogleReviewCard, InstagramCard, ReviewBubble } from '../components/Social';
import { cx, Spinner } from '../components/ui';
import { highlights, paras, splitHeadline } from '../lib/story';

/**
 * About Us. The words are the farm's own (Settings → About page); this page only lays them out in the
 * brand colours: a hero from the introduction, each section as its own full-width band, numbered steps
 * as a timeline and the farm's tagline as a bold quote. Nothing is added that the farm hasn't written.
 */

type Block = { kind: 'p'; text: string } | { kind: 'steps'; steps: { n: string; title: string; text: string }[] } | { kind: 'quote'; text: string };

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

export default function About() {
  const { data: info } = usePublicInfo();
  const name: string = info?.business?.name ?? 'Terram Farm';
  useEffect(() => {
    document.title = `About Us · ${name}`;
  }, [name]);
  const { headline, rest: lead } = splitHeadline(info?.content?.aboutIntro, 'Farm-raised Beef & Lamb');
  const sections: { title: string; body: string }[] = (info?.content?.aboutSections ?? []).filter((s: any) => s.title || s.body);
  const tagline: string = info?.business?.tagline ?? '';
  const facts = highlights(info?.content?.aboutIntro);

  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader subtitle="About Us" />
      {!info ? (
        <div className="flex justify-center py-24"><Spinner className="size-6" /></div>
      ) : (
        <>
          {/* Hero: charcoal with the brand green rising through it */}
          <section className="relative overflow-hidden bg-charcoal text-white">
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_100%_100%,var(--brand)_0%,transparent_60%)] opacity-70" />
            <Sprout aria-hidden className="pointer-events-none absolute -bottom-12 -right-8 size-72 text-white opacity-[0.06] sm:size-96" />
            <div className="relative mx-auto max-w-5xl px-5 pb-14 pt-10 sm:px-8 sm:pb-20 sm:pt-16">
              <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[13px] font-semibold text-white/85"><Sprout className="size-4" />About {name}</p>
              <h1 className="mt-4 max-w-3xl font-display text-[34px] font-extrabold leading-[1.08] tracking-tight sm:text-[52px]">{headline}</h1>
              <span aria-hidden className="mt-6 block h-1 w-16 rounded-full bg-brand" />
              {lead.map((p, i) => (
                <p key={i} className={i === 0 ? 'mt-6 max-w-2xl text-[17px] leading-relaxed text-white/90 sm:text-[18.5px]' : 'mt-3 max-w-2xl text-[15.5px] leading-relaxed text-white/70'}>{p}</p>
              ))}
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/order" className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink shadow-float transition hover:bg-brand-hover">
                  <ShoppingBag className="size-5" /> Order now
                </Link>
                {sections.length > 0 && <a href="#story" className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/25 px-5 text-[15px] font-semibold text-white transition hover:bg-white/10">Read our story</a>}
              </div>
            </div>
          </section>

          {/* What the introduction promises, as a green strip */}
          {facts.length > 0 && (
            <section aria-label="At a glance" className="bg-brand text-brand-ink">
              <ul className="mx-auto grid max-w-5xl gap-px px-5 sm:grid-cols-3 sm:px-8">
                {facts.map((f) => (
                  <li key={f.text} className="flex items-center gap-3 py-4 sm:justify-center sm:py-5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-ink/15"><f.icon className="size-5" /></span>
                    <span className="text-[15px] font-semibold">{f.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* The farm's sections: alternating full-width bands */}
          <div id="story" className="scroll-mt-4">
            {sections.map((s, i) => {
              const Icon = iconFor(s.title);
              const tinted = i % 2 === 1;
              return (
                <section key={i} className={cx('border-b border-line', tinted ? 'bg-brand-soft' : 'bg-bg')}>
                  <div className="mx-auto grid max-w-5xl gap-6 px-5 py-12 sm:px-8 sm:py-16 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] md:gap-12">
                    <header>
                      <span className="flex size-14 items-center justify-center rounded-2xl bg-brand text-brand-ink shadow-card"><Icon className="size-7" /></span>
                      <p className="mt-5 text-[13px] font-semibold uppercase tracking-[0.14em] text-brand">{String(i + 1).padStart(2, '0')}</p>
                      {s.title && <h2 className={cx('mt-1 font-display text-[28px] font-bold leading-tight sm:text-[32px]', tinted ? 'text-brand-soft-ink' : 'text-ink')}>{s.title}</h2>}
                    </header>
                    <div className="min-w-0 space-y-5">{blocks(s.body, tagline).map((b, j) => <BlockView key={j} b={b} tinted={tinted} />)}</div>
                  </div>
                </section>
              );
            })}
          </div>

          <main className="mx-auto max-w-5xl space-y-6 px-5 py-12 sm:px-8 sm:py-16">
            <section className="relative overflow-hidden rounded-3xl bg-charcoal p-6 text-white sm:p-10">
              <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_120%_at_0%_100%,var(--brand)_0%,transparent_65%)] opacity-60" />
              <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-display text-[26px] font-bold sm:text-[30px]">Ready to order?</h2>
                  <p className="mt-1 text-[15.5px] text-white/80">Browse our beef and lamb, or read how ordering, payment and delivery work.</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Link to="/order" className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink transition hover:bg-brand-hover">Order now <ArrowRight className="size-4" /></Link>
                  <Link to="/faq" className="inline-flex h-12 items-center rounded-xl border border-white/25 px-5 text-[15px] font-semibold text-white transition hover:bg-white/10">FAQs</Link>
                </div>
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

function BlockView({ b, tinted }: { b: Block; tinted: boolean }): ReactNode {
  if (b.kind === 'quote')
    return (
      <blockquote className="relative overflow-hidden rounded-2xl bg-brand px-6 py-6 text-brand-ink shadow-card sm:px-8">
        <span aria-hidden className="absolute left-4 top-3 font-display text-[64px] font-bold leading-none opacity-25">“</span>
        <p className="relative pl-9 font-display text-[22px] font-bold leading-snug sm:text-[26px]">{b.text}</p>
      </blockquote>
    );
  if (b.kind === 'steps')
    return (
      <ol className="grid gap-3 sm:grid-cols-2">
        {b.steps.map((st, k) => (
          <li key={st.n} className={cx('flex gap-4 rounded-2xl border p-4 shadow-card', tinted ? 'border-brand/15 bg-surface' : 'border-line bg-surface', b.steps.length % 2 === 1 && k === b.steps.length - 1 && 'sm:col-span-2')}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand font-display text-[16px] font-bold text-brand-ink">{st.n}</span>
            <div className="min-w-0 pt-0.5">
              {st.title && <div className="font-semibold text-ink">{st.title}</div>}
              <p className="text-[14.5px] leading-relaxed text-ink-2">{st.text}</p>
            </div>
          </li>
        ))}
      </ol>
    );
  return <p className={cx('whitespace-pre-line text-[16px] leading-relaxed', tinted ? 'text-brand-soft-ink' : 'text-ink-2')}>{b.text}</p>;
}

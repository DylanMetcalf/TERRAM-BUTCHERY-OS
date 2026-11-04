import { ArrowRight } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { PublicShell } from '../components/PublicShell';
import { usePublicInfo } from '../components/SiteChrome';
import { InstagramCard } from '../components/Social';
import { Spinner } from '../components/ui';

/** About Us: the farm's own words, edited in Settings → Website. No claims beyond what the farm writes. */
export default function About() {
  const { data: info } = usePublicInfo();
  const name: string = info?.business?.name ?? 'Terram Farm';
  useEffect(() => {
    document.title = `About Us · ${name}`;
  }, [name]);
  const sections: { title: string; body: string }[] = info?.content?.aboutSections ?? [];
  return (
    <PublicShell subtitle="About Us">
      {!info ? (
        <div className="flex justify-center py-24"><Spinner className="size-6" /></div>
      ) : (
        <article className="animate-rise space-y-8">
          <header>
            <p className="text-[14px] font-semibold text-ink-3">About {name}</p>
            <h1 className="mt-1 font-display text-[32px] font-semibold leading-tight">Farm-raised Beef &amp; Lamb</h1>
            {info.content?.aboutIntro && <p className="mt-3 whitespace-pre-line text-[16.5px] leading-relaxed text-ink-2">{info.content.aboutIntro}</p>}
          </header>
          {sections.filter((s) => s.title || s.body).map((s, i) => (
            <section key={i}>
              {s.title && <h2 className="font-display text-[21px] font-bold">{s.title}</h2>}
              {s.body && <p className="mt-2 whitespace-pre-line text-[15.5px] leading-relaxed text-ink-2">{s.body}</p>}
            </section>
          ))}
          <InstagramCard url={info.business.instagramUrl} name={name} />
          <div className="flex flex-wrap gap-2">
            <Link to="/order" className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink">Order now <ArrowRight className="size-4" /></Link>
            <Link to="/faq" className="inline-flex h-12 items-center rounded-xl border border-line-strong bg-surface px-5 text-[15px] font-semibold">Read the FAQs</Link>
          </div>
        </article>
      )}
    </PublicShell>
  );
}

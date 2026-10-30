import { useQuery } from '@tanstack/react-query';
import { ChevronDown, MessageCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { PublicShell } from '../components/PublicShell';
import { Spinner } from '../components/ui';
import { api } from '../lib/api';

/** Help & FAQ: the farm's own answers (edited in Settings), plus a WhatsApp button. */
export default function Help() {
  const { data: info } = useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info') });
  useEffect(() => {
    document.title = info ? `Help · ${info.business.name}` : 'Help';
  }, [info]);
  const faq: { q: string; a: string }[] = info?.help?.faq ?? [];
  const wa: string | null = info?.help?.whatsapp ?? null;
  return (
    <PublicShell subtitle="Help & FAQ">
      {!info ? (
        <div className="flex justify-center py-24"><Spinner className="size-6" /></div>
      ) : (
        <div className="animate-rise space-y-6">
          <div>
            <h1 className="font-display text-[30px] font-semibold leading-tight">Help & FAQ</h1>
            <p className="mt-2 text-[15.5px] text-ink-2">How ordering, weighing, payment and delivery work at {info.business.name}. For anything about a particular order, open it from your latest email or <Link to="/account" className="font-semibold text-brand underline">see your orders</Link>.</p>
          </div>
          {wa && (
            <a href={wa} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#1f9d55] text-white"><MessageCircle className="size-5" /></span>
              <span className="min-w-0"><span className="block font-semibold">Need help? Chat to us on WhatsApp</span><span className="block text-[13.5px] text-ink-2">{info.business.phone}</span></span>
            </a>
          )}
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {faq.map((f, i) => (
              <details key={i} className="group" id={`faq-${i + 1}`}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-[15.5px] font-semibold [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <ChevronDown className="size-4 shrink-0 text-ink-3 transition group-open:rotate-180" aria-hidden />
                </summary>
                <p className="whitespace-pre-line px-4 pb-4 text-[15px] leading-relaxed text-ink-2">{f.a}</p>
              </details>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/order" className="inline-flex h-12 items-center rounded-xl bg-brand px-6 text-[16px] font-semibold text-brand-ink">Order now</Link>
            {wa && <a href={wa} target="_blank" rel="noreferrer" className="inline-flex h-12 items-center gap-2 rounded-xl border border-line-strong bg-surface px-5 text-[15px] font-semibold"><MessageCircle className="size-4 text-[#1f9d55]" />WhatsApp us</a>}
          </div>
        </div>
      )}
    </PublicShell>
  );
}

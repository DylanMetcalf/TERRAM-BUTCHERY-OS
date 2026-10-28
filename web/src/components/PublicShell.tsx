import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Logo } from './order-bits';

/** Header and footer for the customer pages (order page, order history, reminders). */
export function PublicShell({ children, subtitle }: { children: ReactNode; subtitle?: string }) {
  const { data: info } = useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info'), staleTime: 5 * 60_000 });
  const b = info?.business;
  return (
    <div className="min-h-dvh bg-bg">
      <header className="bg-charcoal text-white print:hidden">
        <div className="mx-auto flex h-[72px] max-w-3xl items-center justify-between gap-3 px-5 sm:px-8">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <Logo withWord={false} tone="light" />
            <div className="min-w-0">
              <div className="truncate font-display text-[19px] font-bold leading-none">{b?.name ?? 'Terram Farm'}</div>
              {subtitle && <div className="mt-1 text-[12.5px] font-medium opacity-80">{subtitle}</div>}
            </div>
          </Link>
          <Link to="/order" className="inline-flex h-10 shrink-0 items-center rounded-full bg-white/15 px-4 text-[13.5px] font-semibold">Order</Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-7 sm:px-8 sm:py-10">{children}</main>
      {b?.phone && (
        <footer className="mx-auto max-w-3xl px-5 pb-12 text-center text-[13px] text-ink-3 sm:px-8 print:hidden">
          Questions? Call or WhatsApp <a className="font-semibold text-ink-2" href={`tel:${b.phone.replace(/\s/g, '')}`}>{b.phone}</a>
          {b.email && <> · <a className="font-semibold text-ink-2" href={`mailto:${b.email}`}>{b.email}</a></>}
          <div className="mt-2"><Link to="/help" className="underline underline-offset-2">Help & FAQ</Link> · <a href="/privacy" className="underline underline-offset-2">Privacy notice</a></div>
        </footer>
      )}
    </div>
  );
}

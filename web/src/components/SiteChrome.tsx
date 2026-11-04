import { useQuery } from '@tanstack/react-query';
import { Mail, Menu, MessageCircle, Phone, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { Logo } from './order-bits';
import { cx } from './ui';

/**
 * The header and footer every public page shares (home, about, order form, FAQs, order and payment
 * pages), so a customer can always get back to the home page and the main sections.
 */
export const SITE_NAV = [
  { to: '/', label: 'Home' },
  { to: '/about', label: 'About Us' },
  { to: '/order', label: 'Order Now' },
  { to: '/faq', label: 'FAQs' },
  { to: '/#contact', label: 'Contact' },
] as const;

export function usePublicInfo() {
  return useQuery({ queryKey: ['public-info'], queryFn: () => api.get<any>('/api/public/info'), staleTime: 5 * 60_000 });
}

export function SiteHeader({ subtitle, width = 'max-w-5xl', right }: { subtitle?: string; width?: string; right?: ReactNode }) {
  const { data: info } = usePublicInfo();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [loc.pathname, loc.hash]);
  const active = (to: string) => (to === '/' ? loc.pathname === '/' && !loc.hash : to.startsWith('/#') ? loc.pathname === '/' && loc.hash === to.slice(1) : loc.pathname.startsWith(to) || (to === '/faq' && loc.pathname === '/help'));
  return (
    <header className="relative z-40 bg-charcoal text-white print:hidden">
      <div className={cx('mx-auto flex h-[72px] items-center justify-between gap-3 px-5 sm:px-8', width)}>
        <Link to="/" className="flex min-w-0 items-center gap-3" aria-label={`${info?.business?.name ?? 'Terram Farm'} home`}>
          <Logo withWord={false} tone="light" />
          <div className="min-w-0">
            <div className="truncate font-display text-[19px] font-bold leading-none">{info?.business?.name ?? 'Terram Farm'}</div>
            {subtitle && <div className="mt-1 truncate text-[12.5px] font-medium opacity-80">{subtitle}</div>}
          </div>
        </Link>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          {SITE_NAV.map((n) => (
            <Link key={n.to} to={n.to} className={cx('rounded-full px-3.5 py-2 text-[14px] font-semibold transition', n.to === '/order' ? 'bg-brand text-brand-ink hover:bg-brand-hover' : active(n.to) ? 'bg-white/15' : 'text-white/85 hover:bg-white/10')} aria-current={active(n.to) ? 'page' : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          {right}
          <button type="button" onClick={() => setOpen((x) => !x)} className="flex size-11 items-center justify-center rounded-full bg-white/10 lg:hidden" aria-expanded={open} aria-controls="site-menu" aria-label={open ? 'Close menu' : 'Open menu'}>
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>
      {open && (
        <nav id="site-menu" className="absolute inset-x-0 top-full border-t border-white/10 bg-charcoal shadow-float lg:hidden" aria-label="Main">
          <ul className={cx('mx-auto px-3 py-2 sm:px-6', width)}>
            {SITE_NAV.map((n) => (
              <li key={n.to}>
                <Link to={n.to} className={cx('flex h-12 items-center rounded-xl px-3 text-[16px] font-semibold', active(n.to) ? 'bg-white/15' : 'hover:bg-white/10')} aria-current={active(n.to) ? 'page' : undefined}>
                  {n.label}
                </Link>
              </li>
            ))}
            <li>
              <Link to="/account" className="flex h-12 items-center rounded-xl px-3 text-[16px] font-semibold hover:bg-white/10">View my orders</Link>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}

export function SiteFooter({ width = 'max-w-5xl', extraBottom }: { width?: string; extraBottom?: boolean }) {
  const { data: info } = usePublicInfo();
  const b = info?.business;
  const phone: string = b?.phone ?? '';
  const wa = phone.replace(/\D/g, '').replace(/^0/, '27');
  return (
    <footer id="contact" className={cx('border-t border-line print:hidden', extraBottom && 'pb-24')}>
      <div className={cx('mx-auto grid gap-6 px-5 py-8 text-[14px] text-ink-2 sm:grid-cols-[1fr_auto] sm:px-8', width)}>
        <div className="min-w-0 space-y-2">
          <div className="font-display text-[17px] font-bold text-ink">{b?.name ?? 'Terram Farm'}</div>
          {b?.address && <p className="max-w-sm">{b.address}</p>}
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {phone && <a href={`tel:${phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-1.5 hover:text-ink"><Phone className="size-4" />{phone}</a>}
            {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-ink"><MessageCircle className="size-4" />WhatsApp</a>}
            {b?.email && <a href={`mailto:${b.email}`} className="inline-flex min-w-0 items-center gap-1.5 break-all hover:text-ink"><Mail className="size-4 shrink-0" />{b.email}</a>}
          </div>
          {(b?.instagramUrl || b?.facebookUrl || b?.googleReviewUrl) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {b.instagramUrl && <a href={b.instagramUrl} target="_blank" rel="noreferrer" className="font-medium hover:text-ink">Instagram</a>}
              {b.facebookUrl && <a href={b.facebookUrl} target="_blank" rel="noreferrer" className="font-medium hover:text-ink">Facebook</a>}
              {b.googleReviewUrl && <a href={b.googleReviewUrl} target="_blank" rel="noreferrer" className="font-medium hover:text-ink">Google reviews</a>}
            </div>
          )}
        </div>
        <nav aria-label="Footer" className="flex flex-wrap content-start gap-x-4 gap-y-2 sm:max-w-xs sm:justify-end">
          {SITE_NAV.map((n) => <Link key={n.to} to={n.to} className="hover:text-ink">{n.label}</Link>)}
          <Link to="/account" className="hover:text-ink">View my orders</Link>
          <a href="/privacy" className="hover:text-ink">Privacy notice</a>
          <Link to="/login" className="text-ink-3 hover:text-ink">Staff sign in</Link>
        </nav>
      </div>
      <p className="pb-8 text-center text-[12.5px] text-ink-3">© {new Date().getFullYear()} {b?.name ?? 'Terram Farm'}</p>
    </footer>
  );
}

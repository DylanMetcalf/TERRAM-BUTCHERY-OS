import { ChevronRight, ExternalLink, Star, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deviceOrders } from '../lib/customer';
import { dateTime } from '../lib/format';

/** Instagram's mark, drawn simply (brand icons aren't in the icon set). */
function InstagramMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function InstagramCard({ url, name }: { url: string | null | undefined; name: string }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left transition hover:shadow-card">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#f58529,#dd2a7b_50%,#8134af)] text-white"><InstagramMark className="size-6" /></span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">Follow {name} on Instagram</span>
        <span className="block text-[13.5px] text-ink-2">Life on the farm, new stock and what’s coming next.</span>
      </span>
      <ExternalLink className="size-4 shrink-0 text-ink-3" />
    </a>
  );
}

/** Shown only to customers we know have had an order from us (decided by the server). */
export function GoogleReviewCard({ url, name, lead }: { url: string | null | undefined; name: string; lead?: string }) {
  if (!url) return null;
  return (
    <div className="rounded-2xl border-2 border-ochre/40 bg-ochre-soft/40 p-4 text-left">
      <div className="flex items-center gap-1 text-ochre" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="size-5 fill-current" />)}</div>
      <div className="mt-2 font-semibold">{lead ?? `Enjoyed your last order from ${name}?`}</div>
      <p className="mt-1 text-[14px] text-ink-2">A quick Google review helps other families find a local farm they can trust. It takes less than a minute.</p>
      <a href={url} target="_blank" rel="noreferrer" className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-4 text-[15px] font-semibold text-brand-ink">
        Leave a Google review <ExternalLink className="size-4" />
      </a>
    </div>
  );
}

/** Orders placed from this phone or computer (their private links), newest first. */
export function DeviceOrders({ exclude, limit = 5 }: { exclude?: number | null; limit?: number }) {
  const list = deviceOrders().filter((o) => o.number !== exclude).slice(0, limit);
  if (!list.length) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface text-left">
      <div className="px-4 pb-1 pt-3 text-[13px] font-semibold text-ink-3">Orders from this device</div>
      <ul className="divide-y divide-line">
        {list.map((o) => (
          <li key={o.number}>
            <Link to={o.url} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
              <span className="min-w-0 flex-1"><b>Order #{o.number}</b><span className="block text-[13px] text-ink-3">{dateTime(o.at)}</span></span>
              <ChevronRight className="size-4 text-ink-3" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const BUBBLE_KEY = 'terram:review-bubble-hidden';

/** Google's "G", drawn simply (brand icons aren't in the icon set). */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}

/**
 * A small, dismissible "Review us on Google" bubble for the website pages (bottom-left, so it never
 * covers the back-to-top button or an order form's action bar). Only shown when a review link is set
 * in Settings → Business; once closed it stays away for 30 days on that device.
 */
export function ReviewBubble({ url, name }: { url: string | null | undefined; name: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!url) return;
    let hidden = false;
    try {
      const t = Number(localStorage.getItem(BUBBLE_KEY) ?? 0);
      hidden = !!t && Date.now() - t < 30 * 86400_000;
    } catch {
      /* private mode: just show it */
    }
    if (hidden) return;
    const timer = setTimeout(() => setShow(true), 1200);
    return () => clearTimeout(timer);
  }, [url]);
  if (!url || !show) return null;
  const hide = () => {
    setShow(false);
    try {
      localStorage.setItem(BUBBLE_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-4 z-30 flex max-w-[calc(100vw-6rem)] animate-rise items-center rounded-full border border-line bg-surface shadow-float sm:left-6 print:hidden" role="complementary" aria-label="Google reviews">
      <a href={url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2.5 rounded-full py-2 pl-2.5 pr-1 transition hover:bg-surface-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)]"><GoogleG className="size-5" /></span>
        <span className="min-w-0 leading-tight">
          <span className="flex items-center gap-0.5 text-ochre" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="size-3 fill-current" />)}</span>
          <span className="block truncate text-[13.5px] font-semibold text-ink" title={`Review ${name} on Google`}>Review us on Google</span>
        </span>
      </a>
      <button type="button" onClick={hide} className="mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Hide the review invitation">
        <X className="size-4" />
      </button>
    </div>
  );
}

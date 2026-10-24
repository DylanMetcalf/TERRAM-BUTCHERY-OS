import { ChevronRight, ExternalLink, Star } from 'lucide-react';
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

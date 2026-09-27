import { useQuery } from '@tanstack/react-query';
import { Beef, ClipboardList, MessageCircle, Search, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { StatusPill } from './order-bits';
import { cx, Spinner } from './ui';
import { friendlyDate } from '../lib/format';

interface Result {
  key: string;
  icon: typeof User;
  title: string;
  sub?: string;
  to: string;
  extra?: React.ReactNode;
}

export function CommandSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);
  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<any>(`/api/search${qs({ q: debounced })}`),
    enabled: open && debounced.length > 0,
    placeholderData: (p) => p,
  });
  const results: Result[] = useMemo(() => {
    if (!data || !debounced) return [];
    return [
      ...data.orders.map((o: any) => ({ key: 'o' + o.id, icon: ClipboardList, title: `#${o.order_number} · ${o.customer_name}`, sub: friendlyDate(o.requested_date), to: `/orders/${o.id}`, extra: <StatusPill status={o.status} size="sm" /> })),
      ...data.customers.map((c: any) => ({ key: 'c' + c.id, icon: User, title: c.name, sub: c.phone ?? c.email ?? '', to: `/customers/${c.id}` })),
      ...data.products.map((p: any) => ({ key: 'p' + p.id, icon: Beef, title: p.name, sub: p.category + (p.active ? '' : ' · inactive'), to: `/products?open=${p.id}` })),
      ...data.messages.map((m: any) => ({ key: 'm' + m.id, icon: MessageCircle, title: m.body.slice(0, 80), sub: [m.sender_name, m.order_number ? `#${m.order_number}` : null].filter(Boolean).join(' · '), to: m.order_id ? `/orders/${m.order_id}` : '/exceptions' })),
    ];
  }, [data, debounced]);
  useEffect(() => setActive(0), [debounced]);
  if (!open) return null;
  const go = (r: Result) => {
    navigate(r.to);
    onClose();
  };
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center p-3 pt-[8vh] sm:p-6 sm:pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
      <div className="absolute inset-0 animate-fade bg-[rgb(20_16_12/0.4)] backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-xl animate-rise overflow-hidden rounded-2xl border border-line bg-surface shadow-float">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="size-5 text-ink-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              }
              if (e.key === 'Enter' && results[active]) go(results[active]);
            }}
            placeholder="Order number, customer, phone, product, message…"
            className="h-14 flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-3 focus:outline-none"
            aria-label="Search"
          />
          {isFetching && <Spinner className="size-4" />}
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {!debounced && <p className="px-3 py-6 text-center text-[14px] text-ink-3">Try “1042”, “John”, “082 555”, or “wors”.</p>}
          {debounced && !isFetching && !results.length && <p className="px-3 py-6 text-center text-[14px] text-ink-3">Nothing found for “{debounced}”.</p>}
          {results.map((r, i) => (
            <button
              key={r.key}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
              className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left', i === active ? 'bg-sunken' : '')}
            >
              <r.icon className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-ink">{r.title}</span>
                {r.sub && <span className="block truncate text-[13px] text-ink-3">{r.sub}</span>}
              </span>
              {r.extra}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

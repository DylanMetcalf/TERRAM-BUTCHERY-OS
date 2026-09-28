import { useQuery } from '@tanstack/react-query';
import { Check, Search, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, qs } from '../lib/api';
import type { Customer, Product } from '../lib/types';
import { normalise } from '../../../shared/text';
import { Avatar, Button, cx, Field, Input } from './ui';
import { formatMoney } from '../lib/format';

export function useProducts() {
  return useQuery({ queryKey: ['products'], queryFn: () => api.get<{ products: Product[] }>('/api/products'), staleTime: 60_000 });
}


/** Searchable product list grouped by category. Search understands aliases ("wors", "rib eye"). */
export function ProductPicker({ onPick, selectedId, includeInactive }: { onPick: (p: Product) => void; selectedId?: string | null; includeInactive?: boolean }) {
  const { data } = useProducts();
  const [q, setQ] = useState('');
  const products = (data?.products ?? []).filter((p) => includeInactive || p.active);
  const filtered = useMemo(() => {
    const n = normalise(q);
    if (!n) return products;
    const squashed = n.replace(/ /g, '');
    return products.filter((p) => normalise(p.canonical_name).includes(n) || p.aliases.some((a) => a.alias.includes(n) || a.alias.replace(/ /g, '').includes(squashed)) || normalise(p.category).startsWith(n));
  }, [q, products]);
  // Sections in price-list order (products arrive sorted)
  const groups = [...new Set(filtered.map((p) => p.category))].map((c) => ({ c, items: filtered.filter((p) => p.category === c) }));
  return (
    <div>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <Input data-autofocus placeholder="Search — e.g. “wors”, “rib eye”" value={q} onChange={(e) => setQ(e.target.value)} className="h-11 pl-9" aria-label="Search products" />
      </div>
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.c}>
            <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">{g.c}</div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {g.items.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPick(p)}
                  className={cx(
                    'flex min-h-12 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition active:scale-[0.98]',
                    selectedId === p.id ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium text-ink">{p.canonical_name}</span>
                    {p.price_cents != null && <span className="text-[12px] text-ink-3">{formatMoney(p.price_cents)}/{p.price_unit}</span>}
                  </span>
                  {selectedId === p.id && <Check className="size-4 shrink-0 text-brand" />}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <p className="py-6 text-center text-ink-3">No product matches “{q}”.</p>}
      </div>
    </div>
  );
}

export function CustomerPicker({ onPick, onCreate }: { onPick: (c: Customer) => void; onCreate?: (name: string) => void }) {
  const [q, setQ] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['customers', 'pick', q],
    queryFn: () => api.get<{ customers: Customer[] }>(`/api/customers${qs({ q, limit: 12 })}`),
    placeholderData: (p) => p,
  });
  return (
    <div>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
        <Input data-autofocus placeholder="Name or phone number" value={q} onChange={(e) => setQ(e.target.value)} className="h-11 pl-9" aria-label="Search customers" />
      </div>
      <div className="space-y-1.5">
        {(data?.customers ?? []).map((c) => (
          <button key={c.id} type="button" onClick={() => onPick(c)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition hover:border-line-strong hover:bg-surface-2 active:scale-[0.99]">
            <Avatar name={c.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-ink">{c.name}</span>
              <span className="block truncate text-[13px] text-ink-3">{[c.phone, c.order_count ? `${c.order_count} orders` : 'No orders yet'].filter(Boolean).join(' · ')}</span>
            </span>
          </button>
        ))}
        {!isFetching && !data?.customers.length && <p className="py-3 text-center text-sm text-ink-3">No customer found.</p>}
      </div>
      {onCreate && (
        <Button className="mt-3" full icon={<UserPlus className="size-4" />} onClick={() => onCreate(q)}>
          {q ? `Add “${q}” as a new customer` : 'Add a new customer'}
        </Button>
      )}
    </div>
  );
}

export function NewCustomerFields({ value, onChange }: { value: { name: string; phone: string; email: string }; onChange: (v: { name: string; phone: string; email: string }) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" className="sm:col-span-2">
        <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} autoComplete="off" />
      </Field>
      <Field label="Phone" optional>
        <Input value={value.phone} inputMode="tel" onChange={(e) => onChange({ ...value, phone: e.target.value })} />
      </Field>
      <Field label="Email" optional>
        <Input value={value.email} type="email" onChange={(e) => onChange({ ...value, email: e.target.value })} />
      </Field>
    </div>
  );
}

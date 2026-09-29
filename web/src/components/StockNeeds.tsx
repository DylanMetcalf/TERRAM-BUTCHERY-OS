import { useQuery } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { Badge } from './ui';

export function qtyUnit(n: number | null | undefined, unit: string) {
  if (n == null) return '—';
  const v = Math.round(n * 100) / 100;
  if (unit === 'kg') return `${v.toLocaleString('en-ZA')} kg`;
  if (unit === 'pack') return `${v.toLocaleString('en-ZA')} pack${v === 1 ? '' : 's'}`;
  return `${v.toLocaleString('en-ZA')}`;
}

/** Small card for the Cutting page: what the orders on the sheet need from stock. */
export function StockNeedsCard({ range }: { range: string }) {
  const can = useCan();
  const r = range === 'all' ? 'all' : 'week';
  const { data } = useQuery({ queryKey: ['stock', 'plan', r], queryFn: () => api.get<any>(`/api/stock/plan${qs({ range: r })}`), staleTime: 30_000, enabled: can('stock.read') });
  if (!data || !data.sources.length) return null;
  return (
    <Link to="/stock?tab=plan" className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-card transition hover:shadow-float">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"><Scale className="size-5" /></span>
      <span className="min-w-0 flex-1 text-[14.5px]">
        <span className="block font-semibold">Stock these orders need</span>
        <span className="block truncate text-ink-2">{data.sources.map((s: any) => `${qtyUnit(s.units_needed, s.unit)} ${s.unit === 'kg' ? s.name.toLowerCase() : s.name.toLowerCase() + (s.units_needed === 1 ? '' : 's')}`).join(' · ')}</span>
      </span>
      {data.sources.some((s: any) => s.to_order > 0) && <Badge tone="ochre">Need to order</Badge>}
    </Link>
  );
}

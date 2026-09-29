import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Printer, Scissors, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StockNeedsCard } from '../components/StockNeeds';
import { BigCheck, Button, Card, cx, EmptyState, ErrorState, LoadingBlock, PageHeader, Segmented, useToast } from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { friendlyDate, todayYmd } from '../lib/format';

interface CutLine {
  key: string;
  product_name: string;
  category: string;
  preparation_label: string;
  total_label: string;
  estimate_label: string | null;
  cut_items: number;
  total_items: number;
  orders: { item_id: string; order_id: string; order_number: number; customer_name: string; requested_date: string | null; qty_label: string; special_instructions: string | null; cut: boolean }[];
}
interface Sheet {
  from: string | null;
  to: string | null;
  lines: CutLine[];
  order_count: number;
  total_items: number;
  cut_items: number;
  undated_orders: number;
}

const RANGES = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'Next 7 days' },
  { value: 'all', label: 'Everything' },
];

export default function Cutting() {
  const [range, setRange] = useState(() => {
    try {
      return localStorage.getItem('terram:cut-range') ?? 'week';
    } catch {
      return 'week';
    }
  });
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['cutting', range], queryFn: () => api.get<Sheet>(`/api/production/cutting${qs({ range })}`) });
  const cut = useMutation({
    mutationFn: (v: { ids: string[]; cut: boolean; label?: string }) => api.post('/api/items/cut', { item_ids: v.ids, cut: v.cut }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['cutting', range] });
      const prev = qc.getQueryData<Sheet>(['cutting', range]);
      if (prev) {
        const ids = new Set(v.ids);
        qc.setQueryData<Sheet>(['cutting', range], {
          ...prev,
          lines: prev.lines.map((l) => {
            const orders = l.orders.map((o) => (ids.has(o.item_id) ? { ...o, cut: v.cut } : o));
            return { ...l, orders, cut_items: orders.filter((o) => o.cut).length };
          }),
        });
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['cutting', range], ctx.prev);
      toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' });
    },
    onSuccess: (_r, v) => {
      if (v.cut && v.label) toast({ tone: 'success', title: `${v.label} done` });
      qc.invalidateQueries({ queryKey: ['cutting'] });
      qc.invalidateQueries({ queryKey: ['packing'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const canCut = can('production.write');
  const setR = (r: string) => {
    setRange(r);
    try {
      localStorage.setItem('terram:cut-range', r);
    } catch {
      /* ignore */
    }
  };
  const lines = data?.lines ?? [];
  const cats = [...new Set(lines.map((l) => l.category))];
  const doneLines = lines.filter((l) => l.cut_items === l.total_items).length;
  const pct = lines.length ? Math.round((doneLines / lines.length) * 100) : 0;

  return (
    <div className="animate-rise">
      <PageHeader
        title="Cutting"
        subtitle={data ? `${data.order_count} order${data.order_count === 1 ? '' : 's'} · ${doneLines} of ${lines.length} lines done` : ' '}
        actions={<Link to={`/print/cutting${qs({ range })}`} target="_blank"><Button icon={<Printer className="size-4" />}>Print sheet</Button></Link>}
      />
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0"><Segmented value={range} onChange={setR} options={RANGES} size="lg" /></div>
        {lines.length > 0 && (
          <div className="flex flex-1 items-center gap-3 sm:justify-end">
            <div className="h-2 w-full max-w-60 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-field transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[14px] font-semibold tabular text-ink-2">{pct}%</span>
          </div>
        )}
      </div>
      {data && data.undated_orders > 0 && (
        <p className="mb-4 rounded-xl bg-ochre-soft px-4 py-2.5 text-[14px] text-ochre-soft-ink">
          Includes {data.undated_orders} order{data.undated_orders === 1 ? '' : 's'} without a date. <Link to="/orders?view=undated" className="font-semibold underline">Set dates</Link>
        </p>
      )}
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock rows={6} />
      ) : !lines.length ? (
        <EmptyState icon={<Scissors className="size-6" />} title="Nothing to cut" tone="field">
          {range === 'today' ? 'No confirmed orders need cutting today.' : 'Confirmed orders will appear here, added up by product.'}
        </EmptyState>
      ) : (
        <div className="space-y-7">
          {(range === 'week' || range === 'all') && <StockNeedsCard range={range} />}
          {cats.map((cat) => (
            <section key={cat}>
              <h2 className="mb-2 font-display text-[17px] font-semibold">{cat}</h2>
              <div className="space-y-2.5">
                {lines.filter((l) => l.category === cat).map((l) => (
                  <CutRow key={l.key} l={l} canCut={canCut} busy={cut.isPending} onCut={(ids, v, label) => cut.mutate({ ids, cut: v, label })} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function CutRow({ l, canCut, onCut, busy }: { l: CutLine; canCut: boolean; onCut: (ids: string[], cut: boolean, label?: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const done = l.cut_items === l.total_items;
  const notes = l.orders.filter((o) => o.special_instructions);
  const today = todayYmd();
  return (
    <Card className={cx('overflow-hidden transition-colors', done && 'bg-field-soft/50 border-field/25')}>
      <div className="flex items-center gap-3 px-3.5 py-3 sm:gap-4 sm:px-4">
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left" aria-expanded={open}>
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <span className={cx('text-[16px] font-semibold sm:text-[16.5px]', done && 'text-ink-2')}>{l.product_name}</span>
            {l.preparation_label && <span className="rounded-md bg-brand-soft px-2 py-0.5 text-[13px] font-semibold text-brand-soft-ink">{l.preparation_label}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-ink-3">
            <span>{l.orders.length} order{l.orders.length === 1 ? '' : 's'}</span>
            {notes.length > 0 && <span className="font-medium text-ochre">{notes.length} special instruction{notes.length === 1 ? '' : 's'}</span>}
            {l.cut_items > 0 && !done && <span className="text-field">{l.cut_items}/{l.total_items} cut</span>}
            <ChevronDown className={cx('size-4 transition', open && 'rotate-180')} />
          </div>
        </button>
        <div className="shrink-0 text-right">
          <div className={cx('font-display text-[21px] font-semibold leading-none tabular sm:text-[23px]', done && 'text-field')}>{l.total_label}</div>
          {l.estimate_label && <div className="mt-1 text-[12.5px] text-ink-3">{l.estimate_label}</div>}
        </div>
        {canCut && (
          <Button
            variant={done ? 'ghost' : 'success'}
            className="w-12 shrink-0 px-0 sm:w-auto sm:px-4"
            disabled={busy}
            onClick={() => onCut(l.orders.filter((o) => o.cut === done).map((o) => o.item_id), !done, `${l.product_name}`)}
            aria-label={done ? `Undo ${l.product_name}` : `Mark ${l.product_name} cut`}
            icon={done ? <Undo2 className="size-4" /> : <Check className="size-4" strokeWidth={3} />}
          >
            <span className="hidden sm:inline">{done ? 'Undo' : 'Done'}</span>
          </Button>
        )}
      </div>
      {(open || notes.length > 0) && (
        <ul className={cx('divide-y divide-line border-t border-line bg-surface-2', !open && 'hidden sm:block')}>
          {(open ? l.orders : notes).map((o) => (
            <li key={o.item_id} className="flex items-center gap-3 px-4 py-2">
              {canCut && open && <BigCheck size="md" checked={o.cut} onChange={(v) => onCut([o.item_id], v)} label={`${o.customer_name} cut`} />}
              <div className="min-w-0 flex-1">
                <Link to={`/orders/${o.order_id}`} className="text-[14px] font-medium hover:underline">{o.customer_name}</Link>
                <span className="ml-2 text-[12.5px] text-ink-3">#{o.order_number} · {friendlyDate(o.requested_date, today)}</span>
                {o.special_instructions && <div className="text-[13.5px] font-medium text-ochre">“{o.special_instructions}”</div>}
              </div>
              <span className="shrink-0 text-[14px] font-semibold tabular">{o.qty_label}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

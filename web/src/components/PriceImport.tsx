import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';
import { BigCheck, Button, Callout, cx, Sheet, Textarea, useToast } from './ui';

interface Line {
  line: string;
  product_id: string | null;
  product_name: string | null;
  old_cents: number | null;
  old_unit: 'kg' | 'each' | null;
  new_cents: number | null;
  new_unit: 'kg' | 'each' | null;
  status: 'change' | 'same' | 'unmatched' | 'no_price' | 'duplicate';
}

/** Paste a price list → see old vs new for every product → apply the ones you tick. */
export function PriceImport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [lines, setLines] = useState<Line[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const preview = useMutation({
    mutationFn: () => api.post<{ lines: Line[] }>('/api/products/prices/preview', { text }),
    onSuccess: (r) => {
      setLines(r.lines);
      setPicked(new Set(r.lines.map((l, i) => (l.status === 'change' ? i : -1)).filter((i) => i >= 0)));
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not read that list.' }),
  });
  const apply = useMutation({
    mutationFn: () => api.post<{ updated: number }>('/api/products/prices/apply', { changes: [...picked].map((i) => lines![i]).map((l) => ({ product_id: l.product_id, price_cents: l.new_cents, price_unit: l.new_unit })) }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      toast({ tone: 'success', title: `${r.updated} price${r.updated === 1 ? '' : 's'} updated`, body: 'Recorded in the audit log.' });
      setLines(null);
      setText('');
      onClose();
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not update prices.' }),
  });
  const changes = lines?.filter((l) => l.status === 'change').length ?? 0;
  const unmatched = lines?.filter((l) => l.status === 'unmatched') ?? [];
  const money = (c: number | null, u: string | null) => (c == null ? '—' : `${formatMoney(c)}${u ? `/${u}` : ''}`);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="lg"
      title="Update prices"
      subtitle="Paste your price list — one product per line, in any format."
      footer={
        lines ? (
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setLines(null)}>Back</Button>
            <Button variant="primary" size="lg" disabled={!picked.size} loading={apply.isPending} icon={<Check className="size-5" />} onClick={() => apply.mutate()}>
              Update {picked.size} price{picked.size === 1 ? '' : 's'}
            </Button>
          </div>
        ) : (
          <Button variant="primary" size="lg" full disabled={!text.trim()} loading={preview.isPending} iconRight={<ArrowRight className="size-4" />} onClick={() => preview.mutate()}>
            Check the list
          </Button>
        )
      }
    >
      {!lines ? (
        <div className="space-y-3">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} className="font-mono text-[13.5px]" placeholder={'Beef Mince R149.99/kg\nRump steak – R275 per kg\nBurger patties R32 each\nBoerewors, 165'} autoFocus aria-label="Price list" />
          <p className="text-[13px] text-ink-3">Copy it from a spreadsheet, a PDF or your order form. Prices change only after you confirm on the next step.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[14.5px] text-ink-2">
            <b className="text-ink">{changes}</b> price{changes === 1 ? '' : 's'} will change
            {lines.filter((l) => l.status === 'same').length ? ` · ${lines.filter((l) => l.status === 'same').length} already correct` : ''}.
          </p>
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {lines.map((l, i) =>
              l.status === 'unmatched' ? null : (
                <li key={i} className={cx('flex items-center gap-3 px-3.5 py-2.5', l.status !== 'change' && 'opacity-60')}>
                  {l.status === 'change' ? (
                    <BigCheck size="md" checked={picked.has(i)} onChange={(v) => setPicked((s) => { const n = new Set(s); v ? n.add(i) : n.delete(i); return n; })} label={`Update ${l.product_name}`} />
                  ) : (
                    <span className="w-8" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{l.product_name}</div>
                    <div className="truncate text-[12.5px] text-ink-3">“{l.line}”</div>
                  </div>
                  <div className="shrink-0 text-right text-[14px]">
                    {l.status === 'no_price' ? (
                      <span className="text-ochre">No price found</span>
                    ) : l.status === 'same' ? (
                      <span>{money(l.new_cents, l.new_unit)} · unchanged</span>
                    ) : l.status === 'duplicate' ? (
                      <span className="text-ochre">Listed twice — skipped</span>
                    ) : (
                      <>
                        <span className="text-ink-3 line-through">{money(l.old_cents, l.old_unit)}</span> <span className="font-semibold">{money(l.new_cents, l.new_unit)}</span>
                      </>
                    )}
                  </div>
                </li>
              ),
            )}
          </ul>
          {unmatched.length > 0 && (
            <Callout tone="ochre" title={`${unmatched.length} line${unmatched.length === 1 ? '' : 's'} didn’t match a product`}>
              <ul className="mt-1 list-disc pl-5">{unmatched.slice(0, 12).map((l, i) => <li key={i}>{l.line}</li>)}</ul>
              <p className="mt-2">Add these under Products (or add the wording as another name for an existing product), then paste the list again.</p>
            </Callout>
          )}
        </div>
      )}
    </Sheet>
  );
}

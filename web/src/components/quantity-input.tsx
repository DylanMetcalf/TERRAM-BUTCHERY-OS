import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Qty, QuantityType } from '../lib/types';
import { cx, Segmented } from './ui';

/**
 * Quantity entry that respects product rules: weight-only, count-only, or
 * either — plus "6 × 500g" portions where the product allows it.
 */
export function QuantityInput({ value, onChange, quantityType, allowsPortions, pieceNoun = 'piece', autoFocus, minCount }: { value: Qty | null; onChange: (q: Qty | null) => void; quantityType: QuantityType; allowsPortions: boolean; pieceNoun?: string; autoFocus?: boolean; /** e.g. eggs: 30. Starts there and the − button stops there. */ minCount?: number }) {
  const kinds: Qty['kind'][] = quantityType === 'weight' ? ['weight'] : quantityType === 'count' ? ['count'] : ['count', 'weight'];
  if (allowsPortions) kinds.push('portions');
  const [kind, setKind] = useState<Qty['kind']>(value?.kind ?? kinds[0]);
  const [count, setCount] = useState<string>(value?.count != null ? String(value.count) : kind === 'weight' ? '' : String(minCount ?? 1));
  const [kg, setKg] = useState<string>(value?.weight_g != null ? String(value.weight_g / (value.kind === 'portions' ? 1 : 1000)) : kind === 'portions' ? '500' : '1');
  const [unit, setUnit] = useState<'kg' | 'g'>(value?.kind === 'portions' ? 'g' : value?.weight_g && value.weight_g < 1000 && value.kind === 'weight' ? 'g' : 'kg');

  useEffect(() => {
    if (!kinds.includes(kind)) setKind(kinds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quantityType, allowsPortions]);

  useEffect(() => {
    const c = Math.round(Number(count));
    const w = Number(String(kg).replace(',', '.'));
    const grams = Math.round(unit === 'kg' ? w * 1000 : w);
    if (kind === 'count') onChange(c > 0 ? { kind, count: c, weight_g: null } : null);
    else if (kind === 'weight') onChange(grams > 0 ? { kind, count: null, weight_g: grams } : null);
    else onChange(c > 0 && grams > 0 ? { kind, count: c, weight_g: grams } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, count, kg, unit]);

  // With a minimum (eggs: 30), + and − move a whole minimum at a time (a tray)
  const step = (d: number) => setCount(String(Math.max(minCount ?? 1, (Math.round(Number(count)) || 0) + d * (minCount ?? 1))));
  const stepW = (d: number) => {
    const cur = Number(String(kg).replace(',', '.')) || 0;
    const inc = unit === 'kg' ? 0.5 : 100;
    const next = Math.max(inc, Math.round((cur + d * inc) * 100) / 100);
    setKg(String(next));
  };

  const counter = (
    <Stepper value={count} onChange={setCount} onStep={step} suffix={kind === 'portions' ? 'packs' : pieceNoun + (Number(count) === 1 ? '' : 's')} autoFocus={autoFocus} label="Quantity" />
  );
  const weigher = (
    <div className="flex items-center gap-2">
      <Stepper value={kg} onChange={setKg} onStep={stepW} decimal label="Weight" autoFocus={autoFocus && kind === 'weight'} />
      <Segmented size="sm" value={unit} onChange={(u) => {
        const w = Number(String(kg).replace(',', '.')) || 0;
        if (u !== unit) setKg(String(u === 'g' ? Math.round(w * 1000) : Math.round((w / 1000) * 1000) / 1000));
        setUnit(u);
      }} options={[{ value: 'kg', label: 'kg' }, { value: 'g', label: 'g' }]} />
    </div>
  );

  return (
    <div className="space-y-3">
      {kinds.length > 1 && (
        <Segmented
          value={kind}
          onChange={(k) => {
            setKind(k);
            if (k === 'portions') {
              setUnit('g');
              setKg('500');
              if (!Number(count)) setCount('2');
            } else if (k === 'weight') {
              setUnit('kg');
              setKg('1');
            } else if (!Number(count)) setCount('1');
          }}
          options={kinds.map((k) => ({ value: k, label: k === 'count' ? `By ${pieceNoun}` : k === 'weight' ? 'By weight' : 'Packs of…' }))}
          full
        />
      )}
      {kind === 'count' && counter}
      {kind === 'weight' && weigher}
      {kind === 'portions' && (
        <div className="flex flex-wrap items-center gap-2">
          <Stepper value={count} onChange={setCount} onStep={step} suffix="packs" label="Number of packs" />
          <span className="text-ink-3">×</span>
          {weigher}
        </div>
      )}
    </div>
  );
}

function Stepper({ value, onChange, onStep, suffix, decimal, label, autoFocus }: { value: string; onChange: (v: string) => void; onStep: (d: number) => void; suffix?: string; decimal?: boolean; label: string; autoFocus?: boolean }) {
  return (
    <div className="inline-flex h-12 items-center rounded-xl border border-line-strong bg-surface shadow-card">
      <button type="button" aria-label={`Less ${label.toLowerCase()}`} onClick={() => onStep(-1)} className="flex h-full w-11 items-center justify-center rounded-l-xl text-ink-2 hover:bg-sunken active:bg-line">
        <Minus className="size-4" />
      </button>
      <input
        aria-label={label}
        inputMode={decimal ? 'decimal' : 'numeric'}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(decimal ? /[^\d.,]/g : /[^\d]/g, ''))}
        onFocus={(e) => e.target.select()}
        className={cx('h-full w-16 border-x border-line bg-transparent text-center text-lg font-semibold tabular text-ink focus:outline-none')}
      />
      {suffix && <span className="px-2 text-[13px] text-ink-3">{suffix}</span>}
      <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => onStep(1)} className="flex h-full w-11 items-center justify-center rounded-r-xl text-ink-2 hover:bg-sunken active:bg-line">
        <Plus className="size-4" />
      </button>
    </div>
  );
}

import { Clock, Globe, Mail, MessageCircle, Phone, Store, Truck, Upload, Package } from 'lucide-react';
import { STATUS_LABEL, SOURCE_LABEL, stageIndex, type OrderStatus, type OrderSource } from '../../../shared/workflow';
import { Badge, cx, type Tone } from './ui';
import { friendlyDate } from '../lib/format';

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  review: 'ochre',
  needs_clarification: 'danger',
  confirmed: 'slate',
  cutting: 'brand',
  cut: 'brand',
  packing: 'brand',
  packed: 'field',
  ready: 'field',
  out_for_delivery: 'slate',
  completed: 'neutral',
  on_hold: 'neutral',
  cancelled: 'neutral',
};

export function StatusPill({ status, size }: { status: OrderStatus; size?: 'sm' | 'md' }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot size={size} className={status === 'cancelled' ? 'line-through decoration-ink-3/60' : undefined}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

const STAGE_NAMES = ['Review', 'Confirmed', 'Cut', 'Packed', 'Ready', 'Done'];

export function StageTrack({ status, compact }: { status: OrderStatus; compact?: boolean }) {
  const idx = stageIndex(status);
  if (idx < 0) return null;
  return (
    <div className="w-full" aria-label={`Stage: ${STATUS_LABEL[status]}`}>
      <div className="flex gap-1">
        {STAGE_NAMES.map((n, i) => (
          <div key={n} className={cx('h-1.5 flex-1 rounded-full transition-colors', i < idx ? 'bg-field' : i === idx ? (status === 'completed' ? 'bg-field' : 'bg-brand') : 'bg-line')} />
        ))}
      </div>
      {!compact && (
        <div className="mt-2 hidden grid-cols-6 gap-1 text-[11px] font-medium text-ink-3 sm:grid">
          {STAGE_NAMES.map((n, i) => (
            <span key={n} className={cx(i === idx && 'text-ink')}>
              {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function SourceIcon({ source, className }: { source: OrderSource; className?: string }) {
  const Icon = { form: Globe, whatsapp: MessageCircle, email: Mail, phone: Phone, manual: Store, import: Upload }[source] ?? Package;
  return <Icon className={cx('size-4', className)} aria-label={SOURCE_LABEL[source]} />;
}

export function FulfilmentLabel({ type, date, time, today, className }: { type: 'collection' | 'delivery' | null; date: string | null; time?: string | null; today?: string; className?: string }) {
  const Icon = type === 'delivery' ? Truck : type === 'collection' ? Store : Clock;
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[13px] text-ink-2', className)}>
      <Icon className="size-3.5 shrink-0 text-ink-3" />
      <span>
        {type === 'delivery' ? 'Delivery' : type === 'collection' ? 'Collect' : 'Not set'} · {friendlyDate(date, today)}
        {time ? ` · ${time}` : ''}
      </span>
    </span>
  );
}

export function Logo({ className, withWord = true, tone = 'default' }: { className?: string; withWord?: boolean; tone?: 'default' | 'light' }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 40 40" className="size-9 shrink-0" aria-hidden>
        <rect width="40" height="40" rx="11" fill="var(--brand)" />
        <circle cx="27.5" cy="13" r="4" fill="var(--brand-ink)" opacity="0.92" />
        <path d="M6 21.5h28" stroke="var(--brand-ink)" strokeWidth="2" strokeLinecap="round" />
        <path d="M17 21.5 8 33M19.3 21.5 16 33M20.7 21.5 24 33M23 21.5 32 33" stroke="var(--brand-ink)" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.92" />
      </svg>
      {withWord && (
        <span className="leading-none">
          <span className={cx('block font-display text-[19px] font-semibold tracking-tight', tone === 'light' ? 'text-white' : 'text-ink')}>Terram</span>
          <span className={cx('mt-0.5 block text-[10.5px] font-medium uppercase tracking-[0.16em]', tone === 'light' ? 'text-white/70' : 'text-ink-3')}>Butchery</span>
        </span>
      )}
    </span>
  );
}

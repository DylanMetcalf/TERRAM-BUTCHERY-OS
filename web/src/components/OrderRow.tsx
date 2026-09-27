import { AlertTriangle, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { OrderSummary } from '../lib/types';
import { FulfilmentLabel, SourceIcon, StatusPill } from './order-bits';
import { cx } from './ui';

export function OrderRow({ o, today, dense, showStatus = true }: { o: OrderSummary; today?: string; dense?: boolean; showStatus?: boolean }) {
  return (
    <Link
      to={`/orders/${o.id}`}
      className={cx('group flex items-center gap-3 border-b border-line px-4 transition last:border-b-0 hover:bg-surface-2 sm:gap-4', dense ? 'py-2.5' : 'py-3.5')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold text-ink">{o.customer_name}</span>
          <span className="shrink-0 text-[13px] tabular text-ink-3">#{o.order_number}</span>
          {o.open_exceptions > 0 && <AlertTriangle className="size-3.5 shrink-0 text-ochre" aria-label="Has open questions" />}
        </div>
        <div className="mt-0.5 truncate text-[13.5px] text-ink-2">{o.items_preview || <span className="italic text-ink-3">No items yet</span>}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 xl:hidden">
          <FulfilmentLabel type={o.fulfilment_type} date={o.requested_date} time={o.time_window} today={today} />
        </div>
      </div>
      <div className="hidden w-48 shrink-0 xl:block">
        <FulfilmentLabel type={o.fulfilment_type} date={o.requested_date} time={o.time_window} today={today} />
      </div>
      <SourceIcon source={o.source} className="hidden shrink-0 text-ink-3 md:block" />
      {showStatus && (
        <div className="w-auto shrink-0 xl:w-40 xl:text-right">
          <StatusPill status={o.status} size="sm" />
        </div>
      )}
      <ChevronRight className="hidden size-4 shrink-0 text-ink-3 transition group-hover:translate-x-0.5 sm:block" />
    </Link>
  );
}

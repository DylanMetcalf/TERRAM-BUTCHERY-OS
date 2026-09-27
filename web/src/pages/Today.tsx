import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, CalendarDays, CheckCircle2, ClipboardCheck, Package, Scissors, Store, Truck, Inbox, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { OrderRow } from '../components/OrderRow';
import { Button, Card, cx, EmptyState, ErrorState, LoadingBlock, SectionTitle } from '../components/ui';
import { api } from '../lib/api';
import { useCan, useMe } from '../lib/auth';
import { friendlyDate, greeting, longDate, timeAgo, weekdayShort } from '../lib/format';
import type { OrderSummary } from '../lib/types';

interface Dash {
  today: string;
  counts: Record<string, number>;
  exceptions: { total: number; blocking: number };
  due_today: OrderSummary[];
  overdue: OrderSummary[];
  to_review: OrderSummary[];
  week: { date: string; orders: number; collections: number; deliveries: number }[];
  undated: number;
  activity: any[];
  top_exceptions: any[];
}

export default function Today() {
  const me = useMe();
  const can = useCan();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dash>('/api/production/dashboard') });
  const first = me.user!.name.split(' ')[0];
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <LoadingBlock rows={6} />;
  const c = data.counts;
  const attention = data.exceptions.total + c.to_review;
  const maxWeek = Math.max(1, ...data.week.map((w) => w.orders));

  const flow = [
    { key: 'review', label: 'To review', n: c.to_review, to: '/orders?view=review', icon: ClipboardCheck, tone: c.to_review ? 'ochre' : 'quiet' },
    { key: 'cut', label: 'To cut', n: c.to_cut + c.cutting, sub: c.cutting ? `${c.cutting} in progress` : undefined, to: '/cutting', icon: Scissors, tone: 'brand' },
    { key: 'pack', label: 'To pack', n: c.to_pack, to: '/packing', icon: Package, tone: 'brand' },
    { key: 'ready', label: 'Ready', n: c.ready + c.out_for_delivery, sub: c.out_for_delivery ? `${c.out_for_delivery} out for delivery` : undefined, to: '/fulfilment', icon: CheckCircle2, tone: 'field' },
  ] as const;

  return (
    <div className="animate-rise space-y-7">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[14px] font-medium text-ink-3">{longDate(data.today)}</p>
          <h1 className="font-display text-[30px] font-semibold leading-tight sm:text-[38px]">
            {greeting()}, {first}.
          </h1>
        </div>
        {can('orders.write') && (
          <div className="mt-3 hidden gap-2 sm:mt-0 sm:flex">
            <Link to="/import"><Button icon={<Inbox className="size-4" />}>Paste orders</Button></Link>
            <Link to="/orders/new"><Button variant="primary">New order</Button></Link>
          </div>
        )}
      </header>

      {/* Needs attention */}
      {attention > 0 ? (
        <Card className="overflow-hidden border-brand/20">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-brand-ink">
                <AlertCircle className="size-6" />
              </span>
              <div>
                <h2 className="font-display text-[22px] font-semibold leading-snug">
                  {attention === 1 ? '1 thing needs' : `${attention} things need`} your attention
                </h2>
                <p className="mt-1 text-[15px] text-ink-2">
                  {[data.exceptions.total ? `${data.exceptions.total} question${data.exceptions.total === 1 ? '' : 's'} to decide` : null, c.to_review ? `${c.to_review} order${c.to_review === 1 ? '' : 's'} to review` : null].filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {data.exceptions.total > 0 && <Link to="/exceptions"><Button variant="primary" iconRight={<ArrowRight className="size-4" />}>Decide</Button></Link>}
              {c.to_review > 0 && <Link to="/orders?view=review"><Button>Review orders</Button></Link>}
            </div>
          </div>
          {data.top_exceptions.length > 0 && (
            <ul className="divide-y divide-line border-t border-line bg-surface-2">
              {data.top_exceptions.slice(0, 3).map((e) => (
                <li key={e.id}>
                  <Link to="/exceptions" className="flex items-center gap-3 px-5 py-3 text-[14.5px] hover:bg-sunken sm:px-6">
                    <span className={cx('size-2 shrink-0 rounded-full', e.severity === 'blocking' ? 'bg-brand' : e.severity === 'warning' ? 'bg-ochre' : 'bg-slate')} />
                    <span className="flex-1 truncate">{e.title}</span>
                    <span className="shrink-0 text-[12px] text-ink-3">{timeAgo(e.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card className="flex items-center gap-4 p-5">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-field-soft text-field">
            <CheckCircle2 className="size-6" />
          </span>
          <div>
            <h2 className="font-display text-[20px] font-semibold">Everything is under control</h2>
            <p className="text-[15px] text-ink-2">No questions waiting and no orders to review.</p>
          </div>
        </Card>
      )}

      {/* The flow of the day */}
      <section>
        <SectionTitle>Where things are</SectionTitle>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {flow.map((f) => (
            <Link key={f.key} to={f.to} className="group">
              <Card className="h-full p-4 transition group-hover:-translate-y-0.5 group-hover:shadow-float sm:p-5">
                <div className="flex items-center justify-between">
                  <span className={cx('flex size-9 items-center justify-center rounded-xl', f.tone === 'ochre' ? 'bg-ochre-soft text-ochre' : f.tone === 'field' ? 'bg-field-soft text-field' : f.tone === 'quiet' ? 'bg-sunken text-ink-3' : 'bg-brand-soft text-brand')}>
                    <f.icon className="size-[18px]" />
                  </span>
                  <ArrowRight className="size-4 text-ink-3 opacity-0 transition group-hover:opacity-100" />
                </div>
                <div className="mt-4 font-display text-[40px] font-semibold leading-none tabular">{f.n}</div>
                <div className="mt-1.5 text-[15px] font-medium text-ink">{f.label}</div>
                {'sub' in f && f.sub && <div className="text-[13px] text-ink-3">{f.sub}</div>}
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-7 lg:grid-cols-[1fr_340px]">
        <section className="min-w-0">
          <SectionTitle action={<Link to="/orders?view=today" className="text-[13px] font-medium text-brand hover:underline">All of today</Link>}>
            Due today · {c.due_today}
          </SectionTitle>
          <div className="mb-3 flex flex-wrap gap-2">
            <Pill icon={<Store className="size-3.5" />} label={`${c.collections_today} collection${c.collections_today === 1 ? '' : 's'}`} />
            <Pill icon={<Truck className="size-3.5" />} label={`${c.deliveries_today} deliver${c.deliveries_today === 1 ? 'y' : 'ies'}`} />
            <Pill icon={<CheckCircle2 className="size-3.5" />} label={`${c.completed_today} done`} />
          </div>
          {data.due_today.length ? (
            <Card className="overflow-hidden">
              {data.due_today.map((o) => (
                <OrderRow key={o.id} o={o} today={data.today} />
              ))}
            </Card>
          ) : (
            <EmptyState icon={<CalendarDays className="size-6" />} title="Nothing due today">
              No collections or deliveries are booked for today.
            </EmptyState>
          )}
          {data.overdue.length > 0 && (
            <div className="mt-7">
              <SectionTitle>Overdue · {data.overdue.length}</SectionTitle>
              <Card className="overflow-hidden border-danger/25">
                {data.overdue.map((o) => (
                  <OrderRow key={o.id} o={o} today={data.today} />
                ))}
              </Card>
            </div>
          )}
        </section>

        <aside className="space-y-7">
          <section>
            <SectionTitle>Coming up</SectionTitle>
            <Card className="p-4">
              <div className="space-y-2.5">
                {data.week.map((w, i) => (
                  <Link key={w.date} to={`/orders?view=open&from=${w.date}&to=${w.date}`} className="group flex items-center gap-3">
                    <span className={cx('w-16 shrink-0 text-[13px]', i === 0 ? 'font-semibold text-ink' : 'text-ink-2')}>{i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `${weekdayShort(w.date)} ${w.date.slice(8)}`}</span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-sunken">
                      <span className={cx('block h-full rounded-full transition-all group-hover:opacity-80', i === 0 ? 'bg-brand' : 'bg-ink-3/50')} style={{ width: `${(w.orders / maxWeek) * 100}%` }} />
                    </span>
                    <span className="w-6 shrink-0 text-right text-[13px] font-semibold tabular">{w.orders}</span>
                  </Link>
                ))}
              </div>
              {data.undated > 0 && (
                <Link to="/orders?view=undated" className="mt-4 block rounded-xl bg-ochre-soft px-3 py-2 text-[13px] font-medium text-ochre-soft-ink">
                  {data.undated} open order{data.undated === 1 ? ' has' : 's have'} no date →
                </Link>
              )}
            </Card>
          </section>
          <section>
            <SectionTitle action={can('intelligence.read') ? <Link to="/intelligence" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"><Sparkles className="size-3.5" />Insights</Link> : undefined}>Recent activity</SectionTitle>
            <Card className="divide-y divide-line">
              {data.activity.length ? (
                data.activity.slice(0, 8).map((a) => (
                  <Link key={a.id} to={`/orders/${a.order_id}`} className="block px-4 py-2.5 hover:bg-surface-2">
                    <div className="truncate text-[13.5px] text-ink">
                      <span className="font-medium">#{a.order_number} {a.customer_name}</span> · {a.summary}
                    </div>
                    <div className="text-[12px] text-ink-3">
                      {a.actor_name ?? (a.actor_kind === 'customer' ? 'Customer' : 'Terram OS')} · {timeAgo(a.created_at)}
                    </div>
                  </Link>
                ))
              ) : (
                <p className="px-4 py-6 text-center text-[14px] text-ink-3">Activity will appear here.</p>
              )}
            </Card>
          </section>
        </aside>
      </div>
      <p className="text-center text-[12px] text-ink-3">{c.open_total} open orders · {c.received_today} received today · {friendlyDate(data.today)}</p>
    </div>
  );
}

function Pill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[13px] font-medium text-ink-2">
      {icon}
      {label}
    </span>
  );
}

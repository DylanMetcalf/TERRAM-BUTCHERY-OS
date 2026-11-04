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
  queues?: Record<string, number>;
  exceptions: { total: number; blocking: number };
  due_today: OrderSummary[];
  overdue: OrderSummary[];
  to_review: OrderSummary[];
  week: { date: string; orders: number; collections: number; deliveries: number }[];
  undated: number;
  activity: any[];
  top_exceptions: any[];
  stages: { key: string; label: string; n: number; sub: string | null }[];
  waiting: { key: string; label: string; n: number; to: string }[];
  attention: { key: string; label: string; n: number; to: string }[];
}

const STAGE_ICON: Record<string, any> = { new: ClipboardCheck, cutting: Scissors, packing: Package, packed: CheckCircle2, out: Truck, delivered: Store };

export default function Today() {
  const me = useMe();
  const can = useCan();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dash>('/api/production/dashboard') });
  const first = me.user!.name.split(' ')[0];
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <LoadingBlock rows={6} />;
  const c = data.counts;
  const maxWeek = Math.max(1, ...data.week.map((w) => w.orders));
  const canPay = can('payments.write');
  const attention = (data.attention ?? []).filter((a) => a.key !== 'emails' || can('system.health')).filter((a) => a.key !== 'products' || can('settings.write'));
  const waiting = (data.waiting ?? []).filter((w) => w.key !== 'invoice' || canPay);

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

      {/* 1. Where things are: every open order in exactly one stage */}
      <section aria-labelledby="where">
        <SectionTitle><span id="where">Where things are</span></SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {data.stages.map((st) => {
            const Icon = STAGE_ICON[st.key] ?? Package;
            return (
              <Link key={st.key} to={`/orders?view=stage_${st.key}`} className="group min-w-0">
                <Card className="h-full p-4 transition group-hover:-translate-y-0.5 group-hover:shadow-float">
                  <div className="flex items-center justify-between">
                    <span className={cx('flex size-9 items-center justify-center rounded-xl', st.key === 'delivered' ? 'bg-field-soft text-field' : st.n ? 'bg-brand-soft text-brand' : 'bg-sunken text-ink-3')}>
                      <Icon className="size-[18px]" />
                    </span>
                    <ArrowRight className="size-4 text-ink-3 opacity-0 transition group-hover:opacity-100" />
                  </div>
                  <div className="mt-3 font-display text-[36px] font-semibold leading-none tabular">{st.n}</div>
                  <div className="mt-1.5 text-[14.5px] font-medium leading-snug text-ink">{st.label}</div>
                  {st.sub && <div className="text-[12.5px] text-ink-3">{st.sub}</div>}
                </Card>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_340px]">
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
          {/* 3. Waiting on us: work only we can move forward */}
          <div className="mt-7">
            <SectionTitle>Waiting on us</SectionTitle>
            {waiting.length ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {waiting.map((r) => <QueueCard key={r.key} n={r.n} label={r.label} to={r.to} />)}
              </div>
            ) : (
              <Card className="flex items-center gap-3 p-4 text-[14.5px] text-ink-2"><CheckCircle2 className="size-5 text-field" />Nothing is waiting on us right now.</Card>
            )}
          </div>

          {/* 4. Attention: real problems that are still open */}
          <div className="mt-7">
            <SectionTitle>Attention</SectionTitle>
            {attention.length ? (
              <Card className="overflow-hidden border-brand/20">
                <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
                  {attention.map((r) => <QueueCard key={r.key} n={r.n} label={r.label} to={r.to} urgent />)}
                </div>
                {data.top_exceptions.length > 0 && (
                  <ul className="divide-y divide-line border-t border-line bg-surface-2">
                    {data.top_exceptions.slice(0, 3).map((e) => (
                      <li key={e.id}>
                        <Link to={e.order_id ? `/orders/${e.order_id}` : '/exceptions'} className="flex items-center gap-3 px-4 py-3 text-[14.5px] hover:bg-sunken">
                          <span className={cx('size-2 shrink-0 rounded-full', e.severity === 'blocking' ? 'bg-brand' : e.severity === 'warning' ? 'bg-ochre' : 'bg-slate')} />
                          <span className="min-w-0 flex-1 truncate">{e.title}</span>
                          <span className="shrink-0 text-[12px] text-ink-3">{timeAgo(e.created_at)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ) : (
              <Card className="flex items-center gap-4 p-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-field-soft text-field"><CheckCircle2 className="size-5" /></span>
                <div>
                  <h3 className="font-semibold">Everything is under control</h3>
                  <p className="text-[14px] text-ink-2">No open problems.</p>
                </div>
              </Card>
            )}
          </div>

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

function QueueCard({ n, label, to, urgent }: { n: number; label: string; to: string; urgent?: boolean }) {
  return (
    <Link to={to} className="group min-w-0">
      <Card className="flex items-center gap-3 p-3.5 transition group-hover:shadow-float">
        <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl font-display text-[18px] font-semibold tabular', urgent ? 'bg-ochre-soft text-ochre-soft-ink' : 'bg-sunken text-ink')}>{n}</span>
        <span className="min-w-0 flex-1 text-[14.5px] font-medium">{label}</span>
        <ArrowRight className="size-4 shrink-0 text-ink-3" />
      </Card>
    </Link>
  );
}

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ClipboardCheck, Inbox, Landmark, MapPin, Package, Phone, Scissors, Sparkles, Truck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, Card, cx, ErrorState, LoadingBlock, SectionTitle } from '../components/ui';
import { api } from '../lib/api';
import { useCan, useMe } from '../lib/auth';
import { formatMoney, friendlyDate, greeting, longDate, timeAgo, weekdayShort } from '../lib/format';

/**
 * The dashboard answers, at a glance: what's just come in, what's confirmed, what's being processed,
 * what's packed and ready, what's out for delivery, and which payments need checking. Delivered orders
 * live in Fulfilment → History. Payment never decides where an order shows; it's shown alongside.
 */
interface DashOrder {
  id: string;
  order_number: number;
  customer_name: string;
  status: string;
  created_at: string;
  confirmed_at: string | null;
  requested_date: string | null;
  fulfilment_type: string | null;
  delivery_address: string | null;
  delivery_notes: string | null;
  contact_phone: string | null;
  payment_state: string;
  payment_label: string | null;
  finalized: boolean;
  released_unpaid: boolean;
  total_cents: number | null;
  total_exact: boolean;
  balance_cents: number | null;
  reason: string | null;
  paid_claim: { at: string; kind: 'proof' | 'declared'; amount_cents: number | null } | null;
}
interface Section { key: string; label: string; n: number; orders: DashOrder[] }
interface Dash {
  today: string;
  counts: Record<string, number>;
  sections: Section[];
  payments: { n: number; orders: DashOrder[] };
  week: { date: string; orders: number; collections: number; deliveries: number }[];
  undated: number;
  activity: any[];
  top_exceptions: any[];
  waiting: { key: string; label: string; n: number; to: string }[];
  attention: { key: string; label: string; n: number; to: string }[];
}

const SUB: Record<string, string> = {
  cutting: 'Cutting', cut: 'Cut · to pack', packing: 'Packing',
  packed: 'Packed · final weighing & payment', ready: 'Ready to go out',
};
const money = (o: DashOrder) => (o.total_cents != null ? `${o.total_exact ? '' : '≈ '}${formatMoney(o.total_cents)}` : null);
const unpaid = (o: DashOrder) => !['paid', 'waived'].includes(o.payment_state) && (o.balance_cents ?? 0) > 0;

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
  const sec = (k: string) => data.sections.find((x) => x.key === k)!;
  const fresh = sec('new');

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

      {/* At a glance: one count per live stage */}
      <nav aria-label="Where things are" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {data.sections.map((x) => (
          <a key={x.key} href={`#stage-${x.key}`} className={cx('rounded-2xl border px-3 py-2.5 transition hover:shadow-card', x.key === 'new' && x.n ? 'border-brand bg-brand text-brand-ink' : 'border-line bg-surface')}>
            <div className="font-display text-[26px] font-semibold leading-none tabular">{x.n}</div>
            <div className={cx('mt-1 text-[13px] font-medium leading-tight', x.key === 'new' && x.n ? '' : 'text-ink-2')}>{x.label}</div>
          </a>
        ))}
        <a href="#stage-payments" className={cx('rounded-2xl border px-3 py-2.5 transition hover:shadow-card', data.payments.n ? 'border-ochre bg-ochre-soft text-ochre-soft-ink' : 'border-line bg-surface')}>
          <div className="font-display text-[26px] font-semibold leading-none tabular">{data.payments.n}</div>
          <div className="mt-1 text-[13px] font-medium leading-tight">Payments to check</div>
        </a>
      </nav>

      <div className="grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-7">
          {/* A. New / needs review — the first thing to deal with */}
          <section id="stage-new" className="scroll-mt-4">
            <Card className={cx('overflow-hidden', fresh.n ? 'border-2 border-brand' : '')}>
              <div className={cx('flex items-center justify-between gap-3 px-4 py-3 sm:px-5', fresh.n ? 'bg-brand text-brand-ink' : 'bg-surface-2')}>
                <h2 className="flex items-center gap-2 font-display text-[20px] font-semibold"><ClipboardCheck className="size-5" />New orders · needs review <span className="tabular">({fresh.n})</span></h2>
                {fresh.n > fresh.orders.length && <Link to="/orders?view=stage_new" className="text-[13px] font-semibold underline">All</Link>}
              </div>
              {fresh.orders.length ? (
                <ul className="divide-y divide-line">
                  {fresh.orders.map((o) => (
                    <li key={o.id}>
                      <Link to={`/orders/${o.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2"><span className="font-semibold">{o.customer_name}</span><span className="text-[13px] text-ink-3">#{o.order_number} · received {timeAgo(o.created_at)}</span></div>
                          {o.reason && <div className={cx('mt-0.5 text-[13.5px]', o.status === 'review' && !o.reason.startsWith('Waiting') ? 'font-medium text-brand' : 'text-ink-2')}>{o.reason}</div>}
                        </div>
                        <div className="shrink-0 text-right">
                          {money(o) && <div className="text-[14px] font-semibold tabular">{money(o)}</div>}
                          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand">Review <ArrowRight className="size-3.5" /></span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 px-5 py-4 text-[14.5px] text-ink-2"><CheckCircle2 className="size-5 text-field" />No new orders waiting for review.</p>
              )}
            </Card>
          </section>

          {/* Payments to check — customers who say they've paid */}
          {data.payments.n > 0 && (
            <section id="stage-payments" className="scroll-mt-4">
              <SectionTitle>Payments to check · {data.payments.n}</SectionTitle>
              <Card className="overflow-hidden border-ochre/50">
                <ul className="divide-y divide-line">
                  {data.payments.orders.map((o) => (
                    <li key={o.id}>
                      <Link to={`/orders/${o.id}#payment-check`} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                        <Landmark className="mt-0.5 size-4 shrink-0 text-ochre" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2"><span className="font-semibold">{o.customer_name}</span><span className="text-[13px] text-ink-3">#{o.order_number}</span></div>
                          <div className="text-[13.5px] text-ink-2">{o.paid_claim?.kind === 'proof' ? 'Sent proof of payment' : 'Says they’ve paid'}{o.paid_claim ? ` ${timeAgo(o.paid_claim.at)}` : ''}{o.paid_claim?.amount_cents ? ` · ${formatMoney(o.paid_claim.amount_cents)}` : ''} — check the bank</div>
                        </div>
                        <div className="shrink-0 text-right">
                          {o.balance_cents != null && <div className="text-[14px] font-semibold tabular">{formatMoney(o.balance_cents)}</div>}
                          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand">{canPay ? 'Confirm' : 'Open'} <ArrowRight className="size-3.5" /></span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          <StageSection s={sec('confirmed')} icon={<CheckCircle2 className="size-4" />} empty="Nothing confirmed and waiting to start." detail={(o) => [o.confirmed_at ? `Confirmed ${friendlyDate(o.confirmed_at.slice(0, 10), data.today)}` : null, o.requested_date ? `wanted ${friendlyDate(o.requested_date, data.today)}` : null].filter(Boolean).join(' · ')} action="Start processing" />
          <StageSection s={sec('processing')} icon={<Scissors className="size-4" />} empty="Nothing being processed right now." detail={(o) => [SUB[o.status], o.requested_date ? `for ${friendlyDate(o.requested_date, data.today)}` : null].filter(Boolean).join(' · ')} />
          <StageSection s={sec('packed')} icon={<Package className="size-4" />} empty="Nothing packed and waiting." detail={(o) => [SUB[o.status], o.status === 'packed' && !o.finalized ? 'needs final weights' : null, o.requested_date ? `for ${friendlyDate(o.requested_date, data.today)}` : null].filter(Boolean).join(' · ')} />
          <OutSection s={sec('out')} today={data.today} />

          {waiting.length > 0 && (
            <section>
              <SectionTitle>Waiting on us</SectionTitle>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {waiting.map((r) => <QueueCard key={r.key} n={r.n} label={r.label} to={r.to} />)}
              </div>
            </section>
          )}

          <section>
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
              <Card className="flex items-center gap-3 p-4 text-[14.5px] text-ink-2"><CheckCircle2 className="size-5 text-field" />No open problems.</Card>
            )}
          </section>
          <p className="text-[13.5px] text-ink-3">Delivered orders are in <Link to="/fulfilment?tab=history" className="font-semibold text-brand hover:underline">Fulfilment → History</Link>{c.completed_today ? ` (${c.completed_today} today)` : ''}.</p>
        </div>

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

function StageSection({ s, icon, empty, detail, action }: { s: Section; icon: React.ReactNode; empty: string; detail: (o: DashOrder) => string; action?: string }) {
  return (
    <section id={`stage-${s.key}`} className="scroll-mt-4">
      <SectionTitle action={s.n > s.orders.length ? <Link to={`/orders?view=stage_${s.key}`} className="text-[13px] font-medium text-brand hover:underline">All {s.n}</Link> : undefined}>
        <span className="inline-flex items-center gap-1.5">{icon}{s.label} · {s.n}</span>
      </SectionTitle>
      {s.orders.length ? (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {s.orders.map((o) => (
              <li key={o.id}>
                <Link to={`/orders/${o.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2"><span className="font-semibold">{o.customer_name}</span><span className="text-[13px] text-ink-3">#{o.order_number}</span></div>
                    <div className="text-[13px] text-ink-2">{detail(o)}</div>
                  </div>
                  <div className="shrink-0 text-right text-[12.5px]">
                    {money(o) && <div className="text-[14px] font-semibold tabular">{money(o)}</div>}
                    {o.payment_label && <div className={unpaid(o) && o.payment_state !== 'not_requested' ? 'font-medium text-ochre' : 'text-ink-3'}>{o.payment_label}</div>}
                    {action && <span className="inline-flex items-center gap-1 font-semibold text-brand">{action} <ArrowRight className="size-3.5" /></span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[14px] text-ink-3">{empty}</p>
      )}
    </section>
  );
}

/** Out for delivery: the details you need while it's on the road. Unpaid orders stay here and are marked. */
function OutSection({ s, today }: { s: Section; today: string }) {
  return (
    <section id="stage-out" className="scroll-mt-4">
      <SectionTitle action={s.n > s.orders.length ? <Link to="/orders?view=stage_out" className="text-[13px] font-medium text-brand hover:underline">All {s.n}</Link> : undefined}>
        <span className="inline-flex items-center gap-1.5"><Truck className="size-4" />Out for Delivery · {s.n}</span>
      </SectionTitle>
      {s.orders.length ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {s.orders.map((o) => (
            <Card key={o.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <Link to={`/orders/${o.id}`} className="min-w-0 font-semibold hover:underline">{o.customer_name} <span className="font-normal text-ink-3">#{o.order_number}</span></Link>
                {unpaid(o) ? <span className="shrink-0 rounded-full bg-ochre-soft px-2 py-0.5 text-[12px] font-semibold text-ochre-soft-ink">Unpaid {o.balance_cents != null ? formatMoney(o.balance_cents) : ''}</span> : <span className="shrink-0 text-[12.5px] text-field">{o.payment_label}</span>}
              </div>
              <div className="mt-2 space-y-1 text-[13.5px] text-ink-2">
                {o.delivery_address && <div className="flex gap-1.5"><MapPin className="mt-0.5 size-3.5 shrink-0 text-ink-3" /><span className="min-w-0 break-words">{o.delivery_address}</span></div>}
                {o.delivery_notes && <div className="pl-5 text-ink-3">{o.delivery_notes}</div>}
                {o.contact_phone && <a href={`tel:${o.contact_phone}`} className="flex items-center gap-1.5 font-medium text-ink hover:underline"><Phone className="size-3.5 text-ink-3" />{o.contact_phone}</a>}
                {o.requested_date && <div className="pl-5 text-ink-3">{friendlyDate(o.requested_date, today)}</div>}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[14px] text-ink-3">Nothing out for delivery.</p>
      )}
    </section>
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

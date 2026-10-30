import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCircle2, Clock, Download, FileText, Landmark, Printer, RotateCcw, Star, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PublicShell } from '../components/PublicShell';
import { ChangeOrderButtons } from '../components/ChangeOrder';
import { Button, Card, cx, Field, Input, Sheet, Spinner, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, formatMoney, longDate } from '../lib/format';
import { REORDER_KEY, rememberOrder } from '../lib/customer';
import { GoogleReviewCard, InstagramCard } from '../components/Social';

/**
 * The customer's own order page, opened from the signed link in their emails. It shows where the
 * order is, what (if anything) the customer needs to do, and lets them pay, answer a suggested
 * change, download their invoice or receipts, leave feedback and reorder. Payment is only ever
 * shown as received once the farm (or PayFast's server notice) has confirmed it.
 */

type View = any;

export default function CustomerOrderPage() {
  const { token = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const key = ['customer-order', token];
  const { data, error, isLoading, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<{ order: View }>(`/api/public/o/${token}`), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  const o = data?.order;
  const setOrder = (order: View) => qc.setQueryData(key, { order });
  const [receipt, setReceipt] = useState<string | null>(null);
  const payment = params.get('payment');

  useEffect(() => {
    document.title = o ? `Order #${o.order_number}` : 'Your order';
    // Opened on this device (e.g. from the email): keep it in "Orders from this device"
    if (o) rememberOrder({ number: o.order_number, url: `/o/${token}`, at: o.submitted_at });
  }, [o, token]);

  // Back from PayFast: their server tells us the result; keep checking for a little while
  useEffect(() => {
    if (payment !== 'returned') return;
    const t = setInterval(() => refetch(), 4000);
    const stop = setTimeout(() => clearInterval(t), 60_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [payment, refetch]);

  const reorder = useMutation({
    mutationFn: () => api.get<any>(`/api/public/o/${token}/reorder`),
    onSuccess: (draft) => {
      try {
        localStorage.setItem(REORDER_KEY, JSON.stringify(draft));
      } catch {
        /* ignore */
      }
      navigate('/order');
    },
  });
  // The reminder email links here with ?reorder=1
  useEffect(() => {
    if (params.get('reorder') === '1' && o?.can_reorder && !reorder.isPending) reorder.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o?.can_reorder]);

  if (isLoading) return <PublicShell><div className="flex justify-center py-24"><Spinner className="size-6" /></div></PublicShell>;
  if (error || !o)
    return (
      <PublicShell>
        <Card className="mx-auto mt-6 max-w-md p-8 text-center">
          <h1 className="font-display text-2xl font-semibold">We can’t open this order</h1>
          <p className="mt-2 text-ink-2">{error instanceof ApiError ? error.message : 'Please try again in a moment.'}</p>
          <Link to="/account" className="mt-5 inline-flex h-11 items-center rounded-xl bg-brand px-5 font-semibold text-brand-ink">Sign in to see your orders</Link>
        </Card>
      </PublicShell>
    );

  const m = o.money;
  const cur = 'ZAR';
  const total = m.final_cents ?? m.confirmed_cents ?? m.estimated_cents;
  const totalLabel = m.final_cents != null ? 'Total' : m.estimate_is_exact ? 'Total' : 'Estimated total';
  const youNeedTo = o.next.who === 'you';

  return (
    <PublicShell subtitle={`Order #${o.order_number}`}>
      <div className="animate-rise space-y-5">
        <div>
          <p className="text-[14px] font-medium text-ink-3">Order #{o.order_number} · placed {dateTime(o.submitted_at)}</p>
          <h1 className="mt-1 font-display text-[28px] font-semibold leading-tight sm:text-[32px]">{o.cancelled ? 'Order cancelled' : o.steps.find((s: any) => s.current)?.label ?? 'Your order'}</h1>
        </div>

        {payment === 'returned' && o.payment.state !== 'paid' && (
          <Notice tone="info" onClose={() => setParams({})}>Thanks. We’re waiting for PayFast to confirm your payment; this page updates by itself. You’ll also get an email once it’s confirmed.</Notice>
        )}
        {payment === 'cancelled' && <Notice tone="warn" onClose={() => setParams({})}>Your online payment was cancelled. Nothing was charged. You can try again or pay by EFT.</Notice>}

        {!o.cancelled && (
          <ol className="flex gap-1.5" aria-label="Order progress">
            {o.steps.map((s: any) => (
              <li key={s.key} className="min-w-0 flex-1" aria-current={s.current ? 'step' : undefined}>
                <div className={cx('h-1.5 rounded-full', s.done || s.current ? 'bg-brand' : 'bg-line')} />
                <div className={cx('mt-1.5 truncate text-[11.5px] font-medium sm:text-[12.5px]', s.current ? 'text-ink' : 'text-ink-3')}>{s.label}</div>
              </li>
            ))}
          </ol>
        )}

        <div className={cx('flex gap-3 rounded-2xl p-4 text-[15px] leading-relaxed', youNeedTo ? 'bg-ochre-soft text-ochre-soft-ink' : o.next.who === 'done' ? 'bg-field-soft text-field-soft-ink' : 'bg-surface-2 text-ink-2')} role="status">
          {youNeedTo ? <AlertTriangle className="mt-0.5 size-5 shrink-0" /> : o.next.who === 'done' ? <CheckCircle2 className="mt-0.5 size-5 shrink-0" /> : <Clock className="mt-0.5 size-5 shrink-0" />}
          <div>
            <div className="font-semibold">{youNeedTo ? 'Your next step' : 'What’s happening'}</div>
            <p>{o.next.text}</p>
          </div>
        </div>

        <Card className="space-y-1.5 p-4 text-[14.5px]">
          {o.expected ? (
            <Row label={o.fulfilment.type === 'delivery' ? 'Expected delivery' : o.fulfilment.type === 'collection' ? 'Expected collection' : 'Expected'}><b>{o.expected.label}</b></Row>
          ) : !o.cancelled && o.stage === 'received' ? (
            <Row label="Timeframe">{o.lead_time}</Row>
          ) : null}
          {o.preferred_date && <Row label="Your preferred date">{longDate(o.preferred_date)}</Row>}
          {o.storage && <Row label="Fresh or frozen">{o.storage === 'frozen' ? 'Frozen' : 'Fresh'} · vacuum-packed</Row>}
          <Row label={o.fulfilment.type === 'delivery' ? 'Delivery to' : o.fulfilment.type === 'collection' ? 'Collection' : 'Address'}>
            {o.fulfilment.collection ? [o.fulfilment.collection.place, o.fulfilment.collection.address, o.fulfilment.collection.hours].filter(Boolean).join(' · ') || 'From the farm' : o.fulfilment.address || 'We’ll contact you to arrange this.'}
          </Row>
          {!o.fulfilment.type && <p className="text-[13.5px] text-ink-3">We’ll contact you to arrange delivery or collection.</p>}
        </Card>

        {o.amendments.some((a: any) => a.needs_answer) && <Amendments o={o} token={token} onDone={setOrder} />}

        {o.payment.show_options && <PayBox o={o} token={token} onDone={setOrder} />}

        <section>
          <h2 className="mb-2 font-display text-[20px] font-bold">Your order</h2>
          <Card className="divide-y divide-line">
            {o.items.map((i: any) => (
              <div key={i.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-semibold">{i.qty_label} {i.name}</div>
                  {(i.preparation || i.note) && <div className="text-[13.5px] text-ink-2">{[i.preparation, i.note].filter(Boolean).join(' · ')}</div>}
                </div>
                <div className="shrink-0 text-right text-[14px] tabular">
                  {i.final_cents != null ? (
                    <b>{formatMoney(i.final_cents, cur)}</b>
                  ) : i.est_cents != null ? (
                    <span className={i.pricing === 'exact' ? 'font-semibold' : 'text-ink-2'}>{i.pricing === 'exact' ? '' : '≈ '}{formatMoney(i.est_cents, cur)}</span>
                  ) : i.unit_price_cents != null ? (
                    <span className="text-ink-2">{formatMoney(i.unit_price_cents, cur)}/{i.price_unit}</span>
                  ) : (
                    <span className="text-ink-3">Price to be confirmed</span>
                  )}
                </div>
              </div>
            ))}
            {o.special_request && (
              <div className="px-4 py-3 text-[14px]">
                <div className="font-semibold">Special request</div>
                <p className="whitespace-pre-line text-ink-2">{o.special_request}</p>
              </div>
            )}
            {m.delivery_fee_cents > 0 && <div className="flex justify-between px-4 py-3 text-[14px]"><span>Delivery</span><span className="tabular">{formatMoney(m.delivery_fee_cents, cur)}</span></div>}
            <div className="space-y-1 px-4 py-3">
              {total != null && <div className="flex items-baseline justify-between text-[15.5px]"><span className="text-ink-2">{totalLabel}</span><b className="tabular">{formatMoney(total, cur)}</b></div>}
              {m.paid_cents > 0 && <div className="flex justify-between text-[14px] text-field"><span>Paid</span><span className="tabular">{formatMoney(m.paid_cents, cur)}</span></div>}
              {m.paid_cents > 0 && m.balance_cents != null && <div className="flex justify-between text-[14px]"><span>Balance</span><b className="tabular">{formatMoney(m.balance_cents, cur)}</b></div>}
              {m.final_cents == null && !m.estimate_is_exact && <p className="text-[12.5px] text-ink-3">Weighed items are priced on their final weight once packed.</p>}
            </div>
          </Card>
        </section>

        {(o.payment.payments.length > 0 || o.payment.proofs.length > 0) && (
          <section>
            <h2 className="mb-2 font-display text-[20px] font-bold">Payments</h2>
            <Card className="divide-y divide-line">
              {o.payment.payments.map((p: any) => (
                <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[14.5px]">
                  <div><b>{formatMoney(p.amount_cents, cur)}</b> · {p.method_label}<div className="text-[13px] text-ink-3">Received {dateTime(p.created_at)}</div></div>
                  <Button size="sm" variant="ghost" icon={<FileText className="size-4" />} onClick={() => setReceipt(p.id)}>Receipt</Button>
                </div>
              ))}
              {o.payment.proofs.filter((p: any) => p.status !== 'accepted').map((p: any) => (
                <div key={p.id} className="px-4 py-3 text-[14px]">
                  <div>Proof of payment{p.amount_claimed_cents ? ` for ${formatMoney(p.amount_claimed_cents, cur)}` : ''} · {dateTime(p.created_at)}</div>
                  <div className={cx('text-[13px]', p.status === 'rejected' ? 'font-medium text-danger' : 'text-ink-3')}>{p.status === 'rejected' ? `We couldn’t match this payment${p.review_note ? `: ${p.review_note}` : '.'}` : 'Waiting for us to check the bank'}</div>
                </div>
              ))}
            </Card>
          </section>
        )}

        {o.invoice.status !== 'not_requested' && o.invoice.status !== 'cancelled' && (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4 text-[14.5px]">
            <div>
              <div className="font-semibold">Invoice</div>
              <div className="text-ink-2">{['issued', 'sent'].includes(o.invoice.status) ? `Invoice ${o.invoice.reference ?? ''}${o.invoice.issued_on ? `, issued ${longDate(o.invoice.issued_on)}` : ''}` : 'Requested. We’ll send it to you once it’s prepared.'}</div>
            </div>
            {o.invoice.has_file && <a href={`/api/public/o/${token}/invoice`} className="inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong px-4 font-semibold"><Download className="size-4" />Download</a>}
          </Card>
        )}

        {o.status === 'completed' && <GoogleReviewCard url={o.social?.review} name={o.contact.name} lead={`Thank you for supporting ${o.contact.name}!`} />}
        {o.feedback && <Feedback o={o} token={token} onDone={setOrder} />}
        <InstagramCard url={o.social?.instagram} name={o.contact.name} />

        <div className="flex flex-wrap gap-2">
          {o.can_reorder && <Button size="lg" variant="primary" icon={<RotateCcw className="size-4" />} loading={reorder.isPending} onClick={() => reorder.mutate()}>Reorder</Button>}
          {o.can_cancel && <CancelButton token={token} onDone={setOrder} />}
        </div>
        {reorder.error && <p className="text-[14px] text-danger">{(reorder.error as Error).message}</p>}

        {o.updates.length > 0 && (
          <section>
            <h2 className="mb-2 font-display text-[20px] font-bold">Updates</h2>
            <ol className="space-y-2 border-l-2 border-line pl-4">
              {o.updates.map((u: any, i: number) => (
                <li key={i} className="text-[14px]"><span className="font-medium">{u.text}</span><span className="block text-[12.5px] text-ink-3">{dateTime(u.at)}</span></li>
              ))}
            </ol>
          </section>
        )}

        <Card className="p-4">
          <div className="font-semibold">Need to change something or have a question?</div>
          <p className="mt-1 text-[14px] text-ink-2">Contact us with your reference number #{o.order_number}.</p>
          <div className="mt-3"><ChangeOrderButtons phone={o.contact.phone} email={o.contact.email} reference={o.order_number} name={o.customer_name?.split(' ')[0]} /></div>
        </Card>
        <p className="text-center text-[13px] text-ink-3"><Link to="/account" className="underline underline-offset-2">See all your orders</Link> · <Link to="/help" className="underline underline-offset-2">Help & FAQ</Link></p>
      </div>
      {receipt && <ReceiptSheet token={token} id={receipt} onClose={() => setReceipt(null)} />}
    </PublicShell>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <span className="shrink-0 text-ink-3 sm:w-44">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Notice({ tone, children, onClose }: { tone: 'info' | 'warn'; children: ReactNode; onClose: () => void }) {
  return (
    <div className={cx('flex items-start gap-3 rounded-xl px-4 py-3 text-[14px]', tone === 'warn' ? 'bg-ochre-soft text-ochre-soft-ink' : 'bg-brand-soft text-brand-soft-ink')} role="status">
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-1 hover:bg-black/5" aria-label="Dismiss"><X className="size-4" /></button>
    </div>
  );
}

function Amendments({ o, token, onDone }: { o: View; token: string; onDone: (o: View) => void }) {
  const [note, setNote] = useState('');
  const answer = useMutation({
    mutationFn: (v: { id: string; accept: boolean }) => api.post<{ order: View }>(`/api/public/o/${token}/amendments/${v.id}`, { accept: v.accept, note: note || null }),
    onSuccess: (r) => onDone(r.order),
  });
  return (
    <section className="rounded-2xl border-2 border-ochre/50 bg-surface p-4">
      <h2 className="font-display text-[20px] font-bold">We’ve suggested a change</h2>
      {o.amendments.filter((a: any) => a.needs_answer).map((a: any) => (
        <div key={a.id} className="mt-3 rounded-xl bg-surface-2 p-3 text-[14.5px]">
          <p className="font-semibold">{a.summary}</p>
          {a.reason && <p className="mt-1 text-ink-2">Why: {a.reason}</p>}
          {a.price_impact_cents != null && a.price_impact_cents !== 0 && <p className="mt-1 text-ink-2">Price change: {a.price_impact_cents > 0 ? '+' : '−'}{formatMoney(Math.abs(a.price_impact_cents), 'ZAR')}</p>}
          <Field label="A note for us" optional className="mt-3"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" icon={<Check className="size-4" />} loading={answer.isPending && answer.variables?.id === a.id && answer.variables.accept} onClick={() => answer.mutate({ id: a.id, accept: true })}>Accept change</Button>
            <Button variant="ghost" loading={answer.isPending && answer.variables?.id === a.id && !answer.variables.accept} onClick={() => answer.mutate({ id: a.id, accept: false })}>Decline</Button>
          </div>
        </div>
      ))}
      {answer.error && <p className="mt-2 text-[14px] text-danger" role="alert">{(answer.error as Error).message}</p>}
    </section>
  );
}

/** The payment step on the order page: amount and status, and the way to the secure payment page. */
function PayBox({ o }: { o: View; token: string; onDone: (o: View) => void }) {
  const p = o.payment;
  const amount = p.request?.amount_cents ?? o.money.balance_cents;
  const waiting = p.state === 'proof_submitted';
  return (
    <section id="pay" className="rounded-2xl border-2 border-brand/40 bg-surface p-4">
      <h2 className="font-display text-[20px] font-bold">{waiting ? 'Payment awaiting verification' : 'Pay for your order'}</h2>
      {amount != null && <p className="mt-1 text-[15px]">Final amount: <b className="tabular">{formatMoney(amount, 'ZAR')}</b></p>}
      <p className="mt-1 text-[14px] text-ink-2">{waiting ? 'Thanks — we’ll confirm as soon as the payment has reflected in our account.' : 'Pay by EFT using the banking details and reference on your secure payment page. Once you’ve paid, just tap “I’ve paid” — no proof of payment needed.'}</p>
      {p.pay_url && (
        <Link to={p.pay_url} className="mt-3 inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-5 text-[15.5px] font-semibold text-brand-ink">
          <Landmark className="size-4" />{waiting ? 'View payment page' : 'Open payment page'}
        </Link>
      )}
      {p.pay_url && !waiting && (
        <Link to={`${p.pay_url}?paid=1`} className="ml-0 mt-2 block text-[14.5px] font-semibold text-brand underline underline-offset-2 sm:ml-3 sm:mt-0 sm:inline">Already paid? Tell us — no proof needed</Link>
      )}
    </section>
  );
}

function Feedback({ o, token, onDone }: { o: View; token: string; onDone: (o: View) => void }) {
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const send = useMutation({ mutationFn: () => api.post<{ order: View }>(`/api/public/o/${token}/feedback`, { rating, comment: comment || null }), onSuccess: (r) => onDone(r.order) });
  if (o.feedback.given) return <Card className="p-4 text-[14.5px]"><b>Thank you for your feedback.</b>{o.feedback.given.rating ? ` You rated this order ${o.feedback.given.rating}/5.` : ''}</Card>;
  return (
    <Card className="p-4">
      <h2 className="font-semibold">How was your order?</h2>
      <p className="text-[13.5px] text-ink-3">Optional. It helps us look after you.</p>
      <div className="mt-2 flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)} className="flex size-11 items-center justify-center rounded-lg hover:bg-sunken">
            <Star className={cx('size-6', rating != null && n <= rating ? 'fill-ochre text-ochre' : 'text-ink-3')} />
          </button>
        ))}
      </div>
      <Textarea rows={2} className="mt-2" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything you’d like to tell us?" aria-label="Comment" />
      <Button className="mt-3" variant="secondary" disabled={!rating && !comment.trim()} loading={send.isPending} onClick={() => send.mutate()}>Send feedback</Button>
      {send.error && <p className="mt-2 text-[14px] text-danger">{(send.error as Error).message}</p>}
    </Card>
  );
}

function CancelButton({ token, onDone }: { token: string; onDone: (o: View) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useMutation({ mutationFn: () => api.post<{ order: View }>(`/api/public/o/${token}/cancel`, { reason: reason || null }), onSuccess: (r) => { onDone(r.order); setOpen(false); } });
  return (
    <>
      <Button size="lg" variant="ghost" onClick={() => setOpen(true)}>Cancel order</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Cancel this order?" footer={<Button full size="lg" variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Yes, cancel my order</Button>}>
        <p className="text-[15px] text-ink-2">Your order hasn’t been confirmed yet, so you can still cancel it here.</p>
        <Field label="Reason" optional className="mt-4"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {cancel.error && <p className="mt-2 text-[14px] text-danger">{(cancel.error as Error).message}</p>}
      </Sheet>
    </>
  );
}

function ReceiptSheet({ token, id, onClose }: { token: string; id: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['receipt', token, id], queryFn: () => api.get<{ receipt: any }>(`/api/public/o/${token}/receipt/${id}`) });
  const r = data?.receipt;
  return (
    <Sheet open onClose={onClose} title="Payment receipt" footer={<Button full size="lg" variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.print()} disabled={!r}>Print or save as PDF</Button>}>
      {error ? <p className="text-danger">{(error as Error).message}</p> : !r ? <Spinner /> : (
        <div className="receipt space-y-3 text-[14.5px]">
          <div>
            <div className="font-display text-xl font-semibold">{r.business.name}</div>
            <div className="text-[13px] text-ink-3">{[r.business.address, r.business.phone, r.business.email].filter(Boolean).join(' · ')}</div>
          </div>
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-3">Receipt</dt><dd className="font-semibold">{r.number}</dd>
            <dt className="text-ink-3">Date</dt><dd>{dateTime(r.date)}</dd>
            <dt className="text-ink-3">Order</dt><dd>#{r.order_number}</dd>
            <dt className="text-ink-3">Customer</dt><dd>{r.customer_name}</dd>
            <dt className="text-ink-3">Method</dt><dd>{r.method}{r.reference ? ` (${r.reference})` : ''}</dd>
            <dt className="text-ink-3">Amount</dt><dd className="font-semibold tabular">{formatMoney(r.amount_cents, 'ZAR')}</dd>
            {r.order_total_cents != null && <><dt className="text-ink-3">Order total</dt><dd className="tabular">{formatMoney(r.order_total_cents, 'ZAR')}</dd></>}
            <dt className="text-ink-3">Paid to date</dt><dd className="tabular">{formatMoney(r.paid_to_date_cents, 'ZAR')}</dd>
            {r.balance_cents != null && <><dt className="text-ink-3">Balance</dt><dd className="tabular">{formatMoney(r.balance_cents, 'ZAR')}</dd></>}
          </dl>
          <p className="text-[13px] text-ink-3">{r.verified_by}. This is a payment receipt, not a tax invoice.</p>
        </div>
      )}
    </Sheet>
  );
}

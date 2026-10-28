import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Lock, Mail, MessageCircle, Snowflake, Thermometer, Unlock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, cx, Field, Input, KeyValue, SectionTitle, Sheet, Spinner, Textarea, useToast } from './ui';
import { api, ApiError } from '../lib/api';
import { dateTime, formatMoney } from '../lib/format';
import { copyText } from '../lib/clipboard';
import type { OrderItem, OrderSummary } from '../lib/types';

/**
 * Final weighing → finalize → payment request. Weights are entered only here, once the order is
 * packed. Finalizing locks the order at its weighed amount; the payment request (and the customer's
 * payment page) always uses that locked amount.
 */

export function StorageBadge({ storage, size = 'md' }: { storage: 'fresh' | 'frozen' | null | undefined; size?: 'sm' | 'md' }) {
  if (!storage) return <Badge tone="ochre" size={size}>Fresh/frozen not set</Badge>;
  return (
    <Badge tone={storage === 'frozen' ? 'slate' : 'field'} size={size}>
      {storage === 'frozen' ? <Snowflake className="size-3.5" /> : <Thermometer className="size-3.5" />}
      {storage === 'frozen' ? 'Frozen' : 'Fresh'}
    </Badge>
  );
}

function invalidate(qc: ReturnType<typeof useQueryClient>, orderId: string) {
  qc.invalidateQueries({ queryKey: ['order', orderId] });
  qc.invalidateQueries({ queryKey: ['orders'] });
  qc.invalidateQueries({ queryKey: ['dashboard'] });
  qc.invalidateQueries({ queryKey: ['packing'] });
}

const needsWeight = (i: OrderItem) => i.pricing === 'by_weight' || i.pricing === 'estimate';
const kgText = (g: number | null | undefined) => (g ? String(g / 1000) : '');

/** One line on the weighing bench: weight input for weighed lines, a summary for fixed packs. */
function WeighLine({ item, onSaved }: { item: OrderItem; onSaved: () => void }) {
  const toast = useToast();
  const [kg, setKg] = useState(kgText(item.packed_weight_g));
  useEffect(() => setKg(kgText(item.packed_weight_g)), [item.packed_weight_g]);
  const save = useMutation({
    mutationFn: (g: number | null) => api.post(`/api/items/${item.id}/weight`, { weight_g: g }),
    onSuccess: onSaved,
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save the weight.' }),
  });
  const n = Number(kg.replace(',', '.'));
  const valid = kg === '' || (n > 0 && n < 500);
  const rate = item.unit_price_cents ?? item.price_cents;
  const live = n > 0 && rate != null && item.price_unit === 'kg' ? Math.round(rate * n) : item.final_cents ?? null;
  const commit = () => {
    if (!valid) return;
    const g = kg === '' ? null : Math.round(n * 1000);
    if (g !== (item.packed_weight_g ?? null)) save.mutate(g);
  };
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="font-semibold">{item.qty_label} {item.product_name}</div>
        <div className="text-[13px] text-ink-3">{[item.preparation_label, rate != null ? `${formatMoney(rate)}/${item.price_unit}` : 'No price'].filter(Boolean).join(' · ')}</div>
        {!valid && <div className="text-[12.5px] font-medium text-danger">Enter the weight in kg, e.g. 1.25</div>}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <Input inputMode="decimal" aria-label={`Packed weight of ${item.product_name} in kg`} value={kg} onChange={(e) => setKg(e.target.value.replace(/[^\d.,]/g, ''))} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} placeholder="0.000" className={cx('h-11 w-28 pr-8 text-right text-[16px] tabular', !item.packed_weight_g && 'border-ochre')} />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[13px] text-ink-3">kg</span>
        </div>
        <div className="w-24 text-right text-[14px] font-semibold tabular">{save.isPending ? <Spinner className="ml-auto size-4" /> : live != null ? formatMoney(live) : '—'}</div>
      </div>
    </div>
  );
}

export function FinalWeighingSheet({ order, items, problems, open, onClose, onFinalized }: { order: OrderSummary; items: OrderItem[]; problems: string[]; open: boolean; onClose: () => void; onFinalized: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [packs, setPacks] = useState(false);
  const active = items.filter((i) => i.status === 'active');
  const weighed = active.filter(needsWeight);
  const fixed = active.filter((i) => !needsWeight(i));
  const missing = weighed.filter((i) => !i.packed_weight_g).length;
  const total = active.reduce<number | null>((t, i) => (t == null || i.final_cents == null ? null : t + i.final_cents), 0);
  const withFee = total != null ? total + (order.delivery_fee_cents ?? 0) : null;
  const finalize = useMutation({
    mutationFn: () => api.post(`/api/orders/${order.id}/finalize`, { packs_confirmed: packs || !fixed.length }),
    onSuccess: () => {
      invalidate(qc, order.id);
      toast({ tone: 'success', title: `Order #${order.order_number} finalized`, body: 'Next: send the customer the payment request.' });
      onFinalized();
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not finalize.' }),
  });
  const otherProblems = problems.filter((p) => !/packed weight/.test(p));
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="lg"
      title={`Final weighing · #${order.order_number}`}
      subtitle={`${order.customer_name} · weigh each weighed item and confirm the packs`}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[14px]">{withFee != null ? <>Final amount <b className="tabular">{formatMoney(withFee)}</b></> : <span className="text-ink-3">{missing} weight{missing === 1 ? '' : 's'} still to enter</span>}</div>
          <Button size="lg" variant="primary" icon={<Lock className="size-4" />} disabled={missing > 0 || (fixed.length > 0 && !packs) || otherProblems.length > 0 || withFee == null} loading={finalize.isPending} onClick={() => finalize.mutate()}>
            Finalize & request payment
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {otherProblems.length > 0 && (
          <div className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">
            <ul className="list-disc pl-5">{otherProblems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
        {weighed.length > 0 && (
          <section>
            <SectionTitle>Weighed items · enter the actual packed weight</SectionTitle>
            <Card className="divide-y divide-line">
              {weighed.map((i) => <WeighLine key={i.id} item={i} onSaved={() => invalidate(qc, order.id)} />)}
            </Card>
          </section>
        )}
        {fixed.length > 0 && (
          <section>
            <SectionTitle>Fixed packs · no weighing needed</SectionTitle>
            <Card className="divide-y divide-line">
              {fixed.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="font-semibold">{i.qty_label} {i.product_name}</div>
                    <div className="text-[13px] text-ink-3">{[i.preparation_label, i.price_cents != null ? `${formatMoney(i.price_cents)}/${i.price_unit === 'kg' ? 'kg' : 'pack'}` : null].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="text-[14px] font-semibold tabular">{i.final_cents != null ? formatMoney(i.final_cents) : '—'}</div>
                </div>
              ))}
            </Card>
            <label className="mt-3 flex items-start gap-3 text-[14.5px]">
              <input type="checkbox" checked={packs} onChange={(e) => setPacks(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" />
              <span>I’ve checked the pack quantities above match what’s packed.</span>
            </label>
          </section>
        )}
        {(order.delivery_fee_cents ?? 0) > 0 && <KeyValue label="Delivery">{formatMoney(order.delivery_fee_cents!)}</KeyValue>}
        <p className="text-[13px] text-ink-3">Finalizing locks the order at this amount. To change it afterwards, a manager reopens it with a reason; the customer is told if a payment request was already sent.</p>
      </div>
    </Sheet>
  );
}

/** Preview and send the payment request: recipients, amount, link and the exact message. */
export function PaymentRequestSheet({ orderId, open, onClose }: { orderId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['pay-preview', orderId], queryFn: () => api.get<any>(`/api/orders/${orderId}/payment-request/preview`), enabled: open });
  const [email, setEmail] = useState(true);
  const [confirmResend, setConfirmResend] = useState(false);
  useEffect(() => {
    if (open) setConfirmResend(false);
  }, [open]);
  const send = useMutation({
    mutationFn: () => api.post<{ history: any[] }>(`/api/orders/${orderId}/payment-request/send`, { email, resend: !!data?.already_sent }),
    onSuccess: () => {
      invalidate(qc, orderId);
      refetch();
      toast({ tone: 'success', title: data?.already_sent ? 'Payment request emailed again' : 'Payment request emailed', body: 'Its delivery status shows in the history below.' });
      setConfirmResend(false);
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not send.' }),
  });
  const handoff = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/payment-request/whatsapp`), onSuccess: () => { refetch(); invalidate(qc, orderId); } });
  const canEmail = !!data?.email?.available;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="lg"
      title="Payment request"
      subtitle={data?.request ? `${formatMoney(data.request.amount_cents)} · ${data.customer.name}` : undefined}
      footer={
        data?.request && (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            {data.whatsapp.link && (
              <a href={data.whatsapp.link} target="_blank" rel="noreferrer" onClick={() => handoff.mutate()} className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface px-5 text-[15px] font-semibold">
                <MessageCircle className="size-4 text-[#1f9d55]" />Open in WhatsApp
              </a>
            )}
            {data.already_sent && !confirmResend ? (
              <Button size="lg" variant="secondary" disabled={!canEmail || !email} onClick={() => setConfirmResend(true)}>Send email again…</Button>
            ) : (
              <Button size="lg" variant="primary" icon={<Mail className="size-4" />} disabled={!canEmail || !email} loading={send.isPending} onClick={() => send.mutate()}>
                {data.already_sent ? 'Yes, email it again' : 'Send by email'}
              </Button>
            )}
          </div>
        )
      }
    >
      {error ? <p className="text-danger">{(error as Error).message}</p> : isLoading || !data ? <Spinner /> : data.blocker ? (
        <p className="rounded-xl bg-ochre-soft px-4 py-3 text-[14.5px] text-ochre-soft-ink">Not yet: {data.blocker}</p>
      ) : (
        <div className="space-y-5 text-[14.5px]">
          {confirmResend && <p className="rounded-xl bg-ochre-soft px-4 py-3 text-ochre-soft-ink" role="alert">This request has already been emailed to {data.email.to}. Send it again?</p>}
          <dl className="divide-y divide-line rounded-xl border border-line px-4">
            <KeyValue label="Customer">{data.customer.name}</KeyValue>
            <KeyValue label="Amount">{formatMoney(data.request.amount_cents)}</KeyValue>
            <KeyValue label="Email">{data.email.available ? data.email.to : <span className="text-ochre">{data.email.reason}</span>}</KeyValue>
            <KeyValue label="Mobile">{data.customer.phone ?? <span className="text-ink-3">None</span>}</KeyValue>
            <KeyValue label="Link valid until">{data.request.expires_at ? dateTime(data.request.expires_at) : '—'}</KeyValue>
          </dl>
          <Field label="Payment page link">
            <div className="flex gap-2">
              <Input readOnly value={data.url} className="font-mono text-[12.5px]" onFocus={(e) => e.currentTarget.select()} />
              <Button icon={<Copy className="size-4" />} onClick={async () => toast(await copyText(data.url) ? { tone: 'success', title: 'Link copied' } : { tone: 'error', title: 'Couldn’t copy. Select the link and copy it.' })}>Copy</Button>
              <a href={data.url} target="_blank" rel="noreferrer"><Button icon={<ExternalLink className="size-4" />}>Open</Button></a>
            </div>
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[13px] font-medium text-ink-2">Send by</legend>
            <label className={cx('flex items-start gap-3', !canEmail && 'opacity-50')}>
              <input type="checkbox" checked={email && canEmail} disabled={!canEmail} onChange={(e) => setEmail(e.target.checked)} className="mt-0.5 size-5 accent-[var(--brand)]" />
              <span>Email{canEmail ? ` to ${data.email.to}` : ''}</span>
            </label>
            <p className="text-[13px] text-ink-3"><MessageCircle className="mr-1 inline size-3.5" />WhatsApp isn’t connected for automatic sending. “Open in WhatsApp” opens the message on your phone or computer to send yourself; it’s recorded as sent by hand, not as delivered.</p>
          </fieldset>
          {data.email.available && (
            <details className="rounded-xl border border-line p-3">
              <summary className="cursor-pointer font-medium">Email preview: {data.email.subject}</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-[13px] text-ink-2">{data.email.text}</pre>
            </details>
          )}
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer font-medium">WhatsApp message</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-[13px] text-ink-2">{data.whatsapp.text}</pre>
            <Button size="sm" className="mt-2" icon={<Copy className="size-3.5" />} onClick={async () => toast(await copyText(data.whatsapp.text) ? { tone: 'success', title: 'Message copied' } : { tone: 'error', title: 'Couldn’t copy.' })}>Copy message</Button>
          </details>
          <section>
            <SectionTitle>Sent so far</SectionTitle>
            {data.history.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {data.history.map((h: any, k: number) => (
                  <li key={k} className="flex items-start justify-between gap-3 px-3 py-2 text-[13.5px]">
                    <div className="min-w-0">
                      <div className="font-medium">{h.channel === 'email' ? `Email${h.to ? ` to ${h.to}` : ''}` : 'WhatsApp (sent by hand)'}</div>
                      <div className="text-[12.5px] text-ink-3">{dateTime(h.at)}{h.attempts > 1 ? ` · ${h.attempts} tries` : ''}{h.provider_ref ? ` · ref ${h.provider_ref}` : ''}</div>
                      {h.detail && <div className={cx('text-[12.5px]', h.status === 'failed' || h.status === 'skipped' ? 'text-danger' : 'text-ink-3')}>{h.detail}</div>}
                    </div>
                    <Badge size="sm" tone={h.status === 'sent' ? 'field' : h.status === 'failed' || h.status === 'skipped' ? 'danger' : h.status === 'manual' ? 'slate' : 'neutral'}>{h.status === 'manual' ? 'By hand' : h.status === 'skipped' ? 'Not sent' : h.status === 'queued' ? 'Sending' : h.status === 'sent' ? 'Sent' : 'Failed'}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-3">Nothing sent yet.</p>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}

/** The locked final amount on the order page, with its history and the manager's "reopen". */
export function FinalizationCard({ order, finalization, history, canReopen }: { order: OrderSummary; finalization: any; history: any[]; canReopen: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const reopen = useMutation({
    mutationFn: () => api.post(`/api/orders/${order.id}/reopen-final`, { reason }),
    onSuccess: () => {
      invalidate(qc, order.id);
      setReopening(false);
      setReason('');
      toast({ tone: 'success', title: 'Reopened for changes', body: 'Make the changes, then finalize again.' });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not reopen.' }),
  });
  if (!finalization && !history.length) return null;
  return (
    <section>
      <SectionTitle>Final amount</SectionTitle>
      <Card className="space-y-2 p-4 text-[14px]">
        {finalization ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-semibold"><Lock className="size-4 text-field" />{formatMoney(finalization.total_cents)}</span>
              <Badge size="sm" tone="field">Finalized{finalization.version > 1 ? ` · v${finalization.version}` : ''}</Badge>
            </div>
            <div className="text-[12.5px] text-ink-3">{finalization.created_by_name ? `${finalization.created_by_name} · ` : ''}{dateTime(finalization.created_at)}</div>
            {canReopen && !['ready', 'out_for_delivery', 'completed', 'cancelled'].includes(order.status) && (order.amount_paid_cents ?? 0) === 0 && (
              <Button size="sm" variant="ghost" icon={<Unlock className="size-3.5" />} onClick={() => setReopening(true)}>Reopen for changes…</Button>
            )}
          </>
        ) : (
          <p className="text-ink-3">Reopened for changes. Finalize again after final weighing.</p>
        )}
        {history.filter((h) => h.superseded_at).length > 0 && (
          <details className="text-[12.5px] text-ink-3">
            <summary className="cursor-pointer">Earlier versions</summary>
            <ul className="mt-1 space-y-1">{history.filter((h) => h.superseded_at).map((h) => <li key={h.id}>v{h.version}: {formatMoney(h.total_cents)} · reopened {dateTime(h.superseded_at)}{h.superseded_reason ? ` — ${h.superseded_reason}` : ''}</li>)}</ul>
          </details>
        )}
      </Card>
      <Sheet open={reopening} onClose={() => setReopening(false)} title="Reopen the final amount?" footer={<Button full size="lg" variant="danger" disabled={reason.trim().length < 3} loading={reopen.isPending} onClick={() => reopen.mutate()}>Reopen for changes</Button>}>
        <div className="space-y-4 text-[14.5px]">
          <p className="text-ink-2">The current version is kept in the history. Any open payment request is withdrawn so the old amount can’t be paid, and the customer is told if it was already sent.</p>
          <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Brisket was weighed with the tray" /></Field>
        </div>
      </Sheet>
    </section>
  );
}

/** "I've made payment" messages from the customer, for a manager to check against the bank. */
export function DeclarationsList({ orderId, declarations, due, canPay }: { orderId: string; declarations: any[]; due: number | null; canPay: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [checking, setChecking] = useState<any | null>(null);
  const [amount, setAmount] = useState('');
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState('');
  const review = useMutation({
    mutationFn: (accept: boolean) => api.post(`/api/declarations/${checking.id}/review`, accept ? { accept: true, amount_cents: Math.round(Number(amount.replace(',', '.')) * 100) } : { accept: false, reason }),
    onSuccess: (_r, accept) => {
      invalidate(qc, orderId);
      setChecking(null);
      toast({ tone: 'success', title: accept ? 'Payment confirmed' : 'Customer asked for more information' });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'That did not work.' }),
  });
  const open = declarations.filter((d) => d.status === 'submitted');
  const done = declarations.filter((d) => d.status !== 'submitted');
  if (!declarations.length) return null;
  return (
    <div className="space-y-2">
      {open.map((d) => (
        <div key={d.id} className="rounded-xl border-2 border-ochre/50 bg-ochre-soft/40 p-3 text-[14px]">
          <div className="font-semibold">Customer says they’ve paid</div>
          <div className="text-ink-2">{[d.amount_cents ? formatMoney(d.amount_cents) : null, d.paid_on ? `on ${d.paid_on}` : null, dateTime(d.created_at)].filter(Boolean).join(' · ')}</div>
          {d.note && <div className="text-ink-2">“{d.note}”</div>}
          {canPay && <Button size="sm" className="mt-2" variant="primary" onClick={() => { setChecking(d); setAmount(((d.amount_cents ?? due ?? 0) / 100).toFixed(2)); setChecked(false); setReason(''); }}>Check & confirm…</Button>}
        </div>
      ))}
      {done.length > 0 && (
        <ul className="text-[12.5px] text-ink-3">
          {done.map((d) => <li key={d.id}>“I’ve paid” {dateTime(d.created_at)} — {d.status === 'accepted' ? 'confirmed' : `not found${d.review_note ? `: ${d.review_note}` : ''}`}{d.reviewed_by_name ? ` by ${d.reviewed_by_name}` : ''}{d.reviewed_at ? ` · ${dateTime(d.reviewed_at)}` : ''}</li>)}
        </ul>
      )}
      <Sheet open={!!checking} onClose={() => setChecking(null)} title="Check the payment">
        <div className="space-y-5 text-[14.5px]">
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-ink-2">Only confirm once the money has <b>reflected in the bank account</b>.</p>
          <div className="space-y-3 rounded-xl border border-line p-3">
            <Field label="Amount that reflected (R)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40" /></Field>
            <label className="flex items-start gap-2"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 size-5 accent-[var(--brand)]" />I’ve checked the bank and this money has been received.</label>
            <Button full variant="success" icon={<Check className="size-4" />} disabled={!checked || !(Number(amount.replace(',', '.')) > 0)} loading={review.isPending && review.variables} onClick={() => review.mutate(true)}>Confirm payment received</Button>
          </div>
          <div className="space-y-3 rounded-xl border border-line p-3">
            <Field label="Or ask for more information" hint="The customer sees this."><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. We can’t see the payment yet — please send proof" /></Field>
            <Button full variant="danger" disabled={!reason.trim()} loading={review.isPending && !review.variables} onClick={() => review.mutate(false)}>Not found yet</Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

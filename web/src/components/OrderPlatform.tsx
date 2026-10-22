import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, CalendarClock, Check, Copy, ExternalLink, FileText, Mail, Plus, RotateCcw, Scale, Send, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ItemEditor, type ItemDraft } from './ItemEditor';
import { Badge, Button, Card, cx, Field, Input, KeyValue, SectionTitle, Select, Sheet, Textarea, useToast, type Tone } from './ui';
import { api, ApiError } from '../lib/api';
import { addDays, dateTime, formatMoney, longDate, todayYmd } from '../lib/format';
import type { OrderItem, OrderSummary, PaymentState } from '../lib/types';

/**
 * The order's money and customer-facing workflow on the staff order page: confirming with an
 * expected timeframe, payment requests, EFT proofs, recorded payments, invoice requests,
 * suggested changes and the customer's order link. Every action here goes through the server,
 * which checks permissions and records who did what.
 */

export const PAYMENT_TONE: Record<PaymentState, Tone> = {
  not_requested: 'neutral',
  requested: 'ochre',
  pending: 'ochre',
  proof_submitted: 'slate',
  partially_paid: 'ochre',
  paid: 'field',
  failed: 'danger',
  refunded: 'neutral',
};

function useOrderAction(orderId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return {
    done: (title?: string) => {
      qc.invalidateQueries({ queryKey: ['order', orderId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      if (title) toast({ tone: 'success', title });
    },
    fail: (e: unknown) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'That did not work.' }),
  };
}

const ymdOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function TimeframeFields({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  const today = todayYmd();
  const quick: [string, number, number][] = [['1 week', 7, 7], ['1–2 weeks', 7, 14], ['2 weeks', 14, 14]];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {quick.map(([label, a, b]) => (
          <Button key={label} size="sm" variant="secondary" onClick={() => { setFrom(addDays(today, a)); setTo(a === b ? '' : addDays(today, b)); }}>{label}</Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Expected from"><Input type="date" min={today} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" optional><Input type="date" min={from || today} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {from && <p className="text-[13px] text-ink-2">The customer will see: <b>{to && to !== from ? `${longDate(from)} – ${longDate(to)}` : longDate(from)}</b></p>}
    </div>
  );
}

/** Explicit confirmation by a person, with the expected timeframe the customer is told. */
export function ConfirmSheet({ order, problems, open, onClose }: { order: OrderSummary; problems: string[]; open: boolean; onClose: () => void }) {
  const a = useOrderAction(order.id);
  const [from, setFrom] = useState(order.requested_date ?? '');
  const [to, setTo] = useState('');
  const confirm = useMutation({
    mutationFn: () => api.post<{ already: boolean }>(`/api/orders/${order.id}/confirm`, { expected_from: from, expected_to: to && to !== from ? to : null }),
    onSuccess: (r) => {
      a.done(r.already ? 'This order was already confirmed' : 'Order confirmed. The customer has been emailed.');
      onClose();
    },
    onError: a.fail,
  });
  const badRange = !!to && to < from;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Confirm order #${order.order_number}`}
      subtitle="The customer is emailed the confirmation and expected date."
      footer={<Button full size="lg" variant="primary" icon={<Check className="size-5" />} disabled={!ymdOk(from) || badRange || problems.length > 0} loading={confirm.isPending} onClick={() => confirm.mutate()}>Confirm order</Button>}
    >
      <div className="space-y-5">
        {problems.length > 0 && (
          <div className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink" role="alert">
            <div className="font-semibold">Sort these out first:</div>
            <ul className="mt-1 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
        {order.requested_date && <p className="text-[14px] text-ink-2">Customer’s preferred date: <b>{longDate(order.requested_date)}</b></p>}
        <TimeframeFields from={from} to={to} setFrom={setFrom} setTo={setTo} />
        {badRange && <p className="text-[13px] font-medium text-danger">The end date is before the start date.</p>}
      </div>
    </Sheet>
  );
}

export function TimeframeSheet({ order, open, onClose }: { order: OrderSummary; open: boolean; onClose: () => void }) {
  const a = useOrderAction(order.id);
  const [from, setFrom] = useState(order.expected_from ?? '');
  const [to, setTo] = useState(order.expected_to ?? '');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/api/orders/${order.id}/timeframe`, { expected_from: from, expected_to: to && to !== from ? to : null, reason }),
    onSuccess: () => {
      a.done('Timeframe updated. The customer has been emailed.');
      onClose();
    },
    onError: a.fail,
  });
  return (
    <Sheet open={open} onClose={onClose} title="Change the expected timeframe" footer={<Button full size="lg" variant="primary" disabled={!ymdOk(from) || (!!to && to < from) || (!!order.confirmed_at && !reason.trim())} loading={save.isPending} onClick={() => save.mutate()}>Save and tell the customer</Button>}>
      <div className="space-y-4">
        <TimeframeFields from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <Field label="Reason" hint="The customer sees this, e.g. “Waiting for the next carcass to finish ageing”."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Sheet>
  );
}

// ── Money ────────────────────────────────────────────────────

export function MoneyCard({ money }: { money: any }) {
  if (!money) return null;
  const rows: [string, ReactNode][] = [];
  if (money.estimated_cents != null) rows.push([money.estimate_is_exact ? 'Order total' : 'Estimated total', formatMoney(money.estimated_cents)]);
  if (money.confirmed_cents != null && money.confirmed_cents !== money.estimated_cents) rows.push(['At confirmation', formatMoney(money.confirmed_cents)]);
  if (money.final_cents != null) rows.push(['Final total', <b key="f">{formatMoney(money.final_cents)}</b>]);
  else if (money.lines_priced_on_weight > 0) rows.push(['Final total', <span key="w" className="text-ink-3">After weighing ({money.lines_priced_on_weight} line{money.lines_priced_on_weight === 1 ? '' : 's'})</span>]);
  if (money.paid_cents > 0) rows.push(['Paid', <span key="p" className="text-field">{formatMoney(money.paid_cents)}</span>]);
  if (money.balance_cents != null && money.paid_cents > 0) rows.push(['Balance', <b key="b">{formatMoney(money.balance_cents)}</b>]);
  if (!rows.length) return null;
  return (
    <dl className="divide-y divide-line">
      {rows.map(([k, v]) => <KeyValue key={k} label={k}><span className="tabular">{v}</span></KeyValue>)}
    </dl>
  );
}

/** Weighed lines: the packed weight sets the final price. */
export function WeightButton({ item, orderId }: { item: OrderItem; orderId: string }) {
  const a = useOrderAction(orderId);
  const [open, setOpen] = useState(false);
  const [kg, setKg] = useState(item.packed_weight_g ? String(item.packed_weight_g / 1000) : '');
  const save = useMutation({
    mutationFn: () => api.post(`/api/items/${item.id}/weight`, { weight_g: kg ? Math.round(Number(kg.replace(',', '.')) * 1000) : null }),
    onSuccess: () => {
      a.done('Weight saved');
      setOpen(false);
    },
    onError: a.fail,
  });
  if (!item.pricing || item.pricing === 'exact' || item.pricing === 'unpriced') return null;
  const n = Number(kg.replace(',', '.'));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cx('inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-semibold', item.final_cents != null ? 'text-field hover:bg-field-soft' : 'bg-ochre-soft text-ochre-soft-ink')}>
        <Scale className="size-3.5" />{item.final_cents != null ? `${((item.packed_weight_g ?? 0) / 1000).toFixed(3)} kg · ${formatMoney(item.final_cents)}` : 'Enter weight'}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Weight: ${item.product_name}`} subtitle={item.qty_label} footer={<Button full size="lg" variant="primary" disabled={!!kg && !(n > 0 && n < 500)} loading={save.isPending} onClick={() => save.mutate()}>Save weight</Button>}>
        <Field label="Packed weight (kg)" hint={item.unit_price_cents ?? item.price_cents ? `At ${formatMoney((item.unit_price_cents ?? item.price_cents)!)}/${item.price_unit}${n > 0 && item.price_unit === 'kg' ? ` = ${formatMoney(Math.round((item.unit_price_cents ?? item.price_cents)! * n))}` : ''}` : undefined}>
          <Input inputMode="decimal" value={kg} onChange={(e) => setKg(e.target.value)} className="w-40" autoFocus />
        </Field>
      </Sheet>
    </>
  );
}

// ── Payments ─────────────────────────────────────────────────

export function PaymentPanel({ orderId, payment, canWrite, canPay }: { orderId: string; payment: any; canWrite: boolean; canPay: boolean }) {
  const a = useOrderAction(orderId);
  const [recording, setRecording] = useState(false);
  const [reviewing, setReviewing] = useState<any | null>(null);
  const request = useMutation({ mutationFn: () => api.post<{ created: boolean }>(`/api/orders/${orderId}/payment-request`), onSuccess: (r) => a.done(r.created ? 'Payment request sent to the customer' : 'A request for this amount is already open'), onError: a.fail });
  const resend = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/payment-request/resend`), onSuccess: () => a.done('Payment request sent again'), onError: a.fail });
  const reverse = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/api/payments/${v.id}/reverse`, { reason: v.reason }), onSuccess: () => a.done('Payment reversed'), onError: a.fail });
  if (!payment) return null;
  const pendingProofs = payment.proofs.filter((p: any) => p.status === 'submitted');
  return (
    <section>
      <SectionTitle>Payment</SectionTitle>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={PAYMENT_TONE[payment.state as PaymentState]}>{payment.state_label}</Badge>
          {payment.request && <span className="text-[13px] text-ink-3">Requested {formatMoney(payment.request.amount_cents)} · {dateTime(payment.request.created_at)}</span>}
        </div>
        <MoneyCard money={payment.money} />
        {payment.method_problems?.length > 0 && <p className="rounded-xl bg-ochre-soft px-3 py-2 text-[13px] text-ochre-soft-ink">{payment.method_problems.join(' ')}</p>}
        {canWrite && payment.state !== 'paid' && (
          payment.request ? (
            <Button full variant="secondary" icon={<Mail className="size-4" />} loading={resend.isPending} onClick={() => resend.mutate()}>Send the payment request again</Button>
          ) : payment.blocker ? (
            <p className="text-[13px] text-ink-3">Payment request: {payment.blocker}</p>
          ) : (
            <Button full variant="primary" icon={<Send className="size-4" />} loading={request.isPending} onClick={() => request.mutate()}>Request payment</Button>
          )
        )}
        {pendingProofs.length > 0 && (
          <div className="space-y-2">
            {pendingProofs.map((p: any) => (
              <div key={p.id} className="rounded-xl border-2 border-ochre/50 bg-ochre-soft/40 p-3 text-[14px]">
                <div className="font-semibold">Proof of payment to check</div>
                <div className="text-ink-2">{p.amount_claimed_cents ? `Customer says ${formatMoney(p.amount_claimed_cents)} · ` : ''}{dateTime(p.created_at)}</div>
                {p.note && <div className="text-ink-2">“{p.note}”</div>}
                <div className="mt-2 flex flex-wrap gap-2">
                  <a href={`/api/files/${p.file_id ?? ''}`} onClick={(e) => { if (!p.file_id) e.preventDefault(); }} target="_blank" rel="noreferrer" className={cx(!p.file_id && 'hidden')}><Button size="sm" icon={<ExternalLink className="size-3.5" />}>Open file</Button></a>
                  {canPay && <Button size="sm" variant="primary" onClick={() => setReviewing(p)}>Check & verify…</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
        {payment.payments.length > 0 && (
          <ul className="divide-y divide-line text-[14px]">
            {payment.payments.map((p: any) => (
              <li key={p.id} className="flex items-start justify-between gap-2 py-2">
                <div className={cx(p.status !== 'verified' && 'text-ink-3 line-through')}>
                  <b>{formatMoney(p.amount_cents)}</b> · {p.method_label}{p.receipt_number ? ` · R${p.receipt_number}` : ''}
                  <div className="text-[12.5px] text-ink-3 no-underline">{p.status === 'verified' ? (p.verified_by_kind === 'provider' ? 'Confirmed by PayFast' : 'Verified by staff') : p.status} · {dateTime(p.created_at)}</div>
                  {p.note && <div className="text-[12.5px] text-ink-3">{p.note}</div>}
                </div>
                {canPay && p.status === 'verified' && (
                  <button type="button" className="shrink-0 text-[12.5px] font-medium text-danger hover:underline" onClick={() => { const reason = window.prompt('Why is this payment being reversed? (e.g. refunded, recorded in error)'); if (reason?.trim()) reverse.mutate({ id: p.id, reason: reason.trim() }); }}>Reverse</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canPay && payment.state !== 'paid' && <Button full variant="ghost" icon={<Plus className="size-4" />} onClick={() => setRecording(true)}>Record a payment received</Button>}
        <p className="text-[12px] text-ink-3">An order is only marked paid when a payment is verified here or confirmed by PayFast’s server.</p>
      </Card>
      {recording && <RecordPaymentSheet orderId={orderId} due={payment.money.balance_cents} onClose={() => setRecording(false)} />}
      {reviewing && <ReviewProofSheet orderId={orderId} proof={reviewing} due={payment.money.balance_cents} onClose={() => setReviewing(null)} />}
    </section>
  );
}

const toCents = (s: string) => Math.round(Number(s.replace(/[^\d.,]/g, '').replace(',', '.')) * 100);

function RecordPaymentSheet({ orderId, due, onClose }: { orderId: string; due: number | null; onClose: () => void }) {
  const a = useOrderAction(orderId);
  const [method, setMethod] = useState<'eft' | 'cash' | 'card' | 'other'>('eft');
  const [amount, setAmount] = useState(due ? (due / 100).toFixed(2) : '');
  const [note, setNote] = useState('');
  const save = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/payments`, { method, amount_cents: toCents(amount), note: note || null }), onSuccess: () => { a.done('Payment recorded'); onClose(); }, onError: a.fail });
  return (
    <Sheet open onClose={onClose} title="Record a payment" subtitle="Only record money you have confirmed has been received." footer={<Button full size="lg" variant="primary" disabled={!(toCents(amount) > 0)} loading={save.isPending} onClick={() => save.mutate()}>Record payment</Button>}>
      <div className="space-y-4">
        <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value as any)}><option value="eft">EFT (checked in the bank)</option><option value="cash">Cash</option><option value="card">Card machine</option><option value="other">Other</option></Select></Field>
        <Field label="Amount received (R)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40" /></Field>
        <Field label="Note" optional hint="e.g. the bank reference"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Sheet>
  );
}

function ReviewProofSheet({ orderId, proof, due, onClose }: { orderId: string; proof: any; due: number | null; onClose: () => void }) {
  const a = useOrderAction(orderId);
  const [amount, setAmount] = useState(((proof.amount_claimed_cents ?? due ?? 0) / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const review = useMutation({
    mutationFn: (accept: boolean) => api.post(`/api/proofs/${proof.id}/review`, accept ? { accept: true, amount_cents: toCents(amount) } : { accept: false, reason }),
    onSuccess: (_r, accept) => { a.done(accept ? 'Payment verified. The customer gets a receipt.' : 'Proof rejected. The customer has been told why.'); onClose(); },
    onError: a.fail,
  });
  return (
    <Sheet open onClose={onClose} title="Check proof of payment" subtitle={`${proof.filename} · uploaded ${dateTime(proof.created_at)}`}>
      <div className="space-y-5">
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink-2">A proof of payment can be fake or the payment can bounce. <b>Check that the money is in the bank account</b> before verifying.</p>
        <div className="space-y-3 rounded-xl border border-line p-3">
          <Field label="Amount that arrived in the bank (R)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40" /></Field>
          <label className="flex items-start gap-2 text-[14px]"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 size-5 accent-[var(--brand)]" />I’ve checked the bank and this money has been received.</label>
          <Button full variant="success" icon={<Check className="size-4" />} disabled={!checked || !(toCents(amount) > 0)} loading={review.isPending && review.variables} onClick={() => review.mutate(true)}>Verify payment</Button>
        </div>
        <div className="space-y-3 rounded-xl border border-line p-3">
          <Field label="Or reject it" hint="The customer sees this reason."><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. We can’t find this payment in our account yet" /></Field>
          <Button full variant="danger" icon={<X className="size-4" />} disabled={!reason.trim()} loading={review.isPending && !review.variables} onClick={() => review.mutate(false)}>Reject proof</Button>
        </div>
      </div>
    </Sheet>
  );
}

// ── Invoice request (prepared manually in the accounting system) ──

export const INVOICE_TONE: Record<string, Tone> = { not_requested: 'neutral', requested: 'ochre', in_progress: 'slate', issued: 'field', sent: 'field', cancelled: 'neutral' };

export function InvoicePanel({ orderId, invoice, canWrite, canPay }: { orderId: string; invoice: any; canWrite: boolean; canPay: boolean }) {
  const a = useOrderAction(orderId);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const upd = useMutation({ mutationFn: (body: any) => api.patch(`/api/orders/${orderId}/invoice`, body), onSuccess: () => a.done('Invoice updated'), onError: a.fail });
  if (!invoice) return null;
  const d = invoice.details;
  return (
    <section>
      <SectionTitle>Invoice</SectionTitle>
      <Card className="space-y-3 p-4 text-[14px]">
        <div className="flex items-center justify-between gap-2">
          <Badge tone={INVOICE_TONE[invoice.status]}>{invoice.status_label}</Badge>
          {invoice.reference && <span className="font-semibold">{invoice.reference}</span>}
        </div>
        {d && (
          <div className="text-ink-2">
            <div className="font-medium text-ink">{d.billing_name}{d.company ? ` · ${d.company}` : ''}</div>
            <div className="break-all">{d.billing_email}</div>
            {d.billing_address && <div className="whitespace-pre-line">{d.billing_address}</div>}
            {d.vat_number && <div>VAT {d.vat_number}</div>}
            {d.instructions && <div>“{d.instructions}”</div>}
          </div>
        )}
        {invoice.issued_on && <div className="text-ink-3">Issued {longDate(invoice.issued_on)}{invoice.sent_at ? ` · sent ${dateTime(invoice.sent_at)}` : ''}</div>}
        {invoice.file && <a href={`/api/files/${invoice.file.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-brand hover:underline"><FileText className="size-4" />{invoice.file.filename}</a>}
        {canPay && invoice.status !== 'not_requested' && invoice.status !== 'cancelled' && (
          <div className="flex flex-wrap gap-2">
            {invoice.status === 'requested' && <Button size="sm" variant="secondary" loading={upd.isPending} onClick={() => upd.mutate({ status: 'in_progress' })}>Start</Button>}
            {['requested', 'in_progress', 'issued'].includes(invoice.status) && <Button size="sm" variant="primary" onClick={() => setEditing(true)}>{invoice.status === 'issued' ? 'Update / mark sent' : 'Mark issued…'}</Button>}
            {invoice.status !== 'sent' && <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} loading={upd.isPending} onClick={() => window.confirm('Cancel this invoice request?') && upd.mutate({ status: 'cancelled' })}>Cancel request</Button>}
          </div>
        )}
        {invoice.status === 'not_requested' && canWrite && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setAsking(true)}>Customer wants an invoice</Button>}
        {invoice.status === 'not_requested' && !canWrite && <p className="text-ink-3">No invoice requested.</p>}
        <p className="text-[12px] text-ink-3">Invoices are prepared by hand in your accounting software. Terram tracks the request and can attach the file.</p>
      </Card>
      {editing && <InvoiceSheet orderId={orderId} invoice={invoice} onClose={() => setEditing(false)} />}
      {asking && <InvoiceRequestSheet orderId={orderId} onClose={() => setAsking(false)} />}
    </section>
  );
}

function InvoiceSheet({ orderId, invoice, onClose }: { orderId: string; invoice: any; onClose: () => void }) {
  const a = useOrderAction(orderId);
  const [ref, setRef] = useState(invoice.reference ?? '');
  const [date, setDate] = useState(invoice.issued_on ?? todayYmd());
  const [file, setFile] = useState<File | null>(null);
  const [notify, setNotify] = useState(true);
  const save = useMutation({
    mutationFn: async (status: 'issued' | 'sent') => {
      if (file) {
        const f = new FormData();
        f.set('file', file);
        await api.upload(`/api/orders/${orderId}/invoice/file`, f);
      }
      return api.patch(`/api/orders/${orderId}/invoice`, { status, reference: ref.trim(), issued_on: date, notify_customer: notify });
    },
    onSuccess: (_r, status) => { a.done(status === 'sent' ? 'Invoice marked as sent' : 'Invoice marked as issued'); onClose(); },
    onError: a.fail,
  });
  const ok = ref.trim().length > 0 && ymdOk(date);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Invoice details"
      footer={
        <div className="flex gap-2">
          <Button size="lg" variant="secondary" disabled={!ok} loading={save.isPending && save.variables === 'issued'} onClick={() => save.mutate('issued')}>Save as issued</Button>
          <Button size="lg" variant="primary" full disabled={!ok} loading={save.isPending && save.variables === 'sent'} onClick={() => save.mutate('sent')}>Mark sent</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Invoice number / reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. INV-0042" /></Field>
        <Field label="Invoice date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Attach the invoice" optional hint={invoice.file ? `Currently attached: ${invoice.file.filename}. Choosing a new file replaces it.` : 'PDF, JPG or PNG, up to 10 MB. The customer can download it from their order page.'}>
          <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-[14px] file:mr-3 file:h-10 file:rounded-xl file:border-0 file:bg-sunken file:px-4 file:font-semibold" />
        </Field>
        <label className="flex items-start gap-2 text-[14px]"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 size-5 accent-[var(--brand)]" />Email the customer that their invoice is ready</label>
      </div>
    </Sheet>
  );
}

function InvoiceRequestSheet({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const a = useOrderAction(orderId);
  const [d, setD] = useState({ billing_name: '', company: '', billing_email: '', billing_address: '', vat_number: '', instructions: '' });
  const save = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/invoice/request`, { ...d, company: d.company || null, billing_address: d.billing_address || null, vat_number: d.vat_number || null, instructions: d.instructions || null }), onSuccess: () => { a.done('Invoice request added'); onClose(); }, onError: a.fail });
  const set = (k: keyof typeof d) => (e: any) => setD({ ...d, [k]: e.target.value });
  return (
    <Sheet open onClose={onClose} title="Invoice request" footer={<Button full size="lg" variant="primary" disabled={d.billing_name.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.billing_email)} loading={save.isPending} onClick={() => save.mutate()}>Add request</Button>}>
      <div className="space-y-3">
        <Field label="Name on the invoice"><Input value={d.billing_name} onChange={set('billing_name')} /></Field>
        <Field label="Company" optional><Input value={d.company} onChange={set('company')} /></Field>
        <Field label="Email for the invoice"><Input type="email" value={d.billing_email} onChange={set('billing_email')} /></Field>
        <Field label="Billing address" optional><Textarea rows={2} value={d.billing_address} onChange={set('billing_address')} /></Field>
        <Field label="VAT number" optional><Input value={d.vat_number} onChange={set('vat_number')} /></Field>
        <Field label="Instructions" optional><Input value={d.instructions} onChange={set('instructions')} /></Field>
      </div>
    </Sheet>
  );
}

// ── Suggested changes (the customer accepts or declines) ─────

const AMEND_TONE: Record<string, Tone> = { proposed: 'ochre', accepted: 'field', declined: 'danger', withdrawn: 'neutral', applied: 'field', informed: 'slate' };
const AMEND_LABEL: Record<string, string> = { proposed: 'Waiting for the customer', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn', applied: 'Applied', informed: 'Customer informed' };

export function AmendmentsPanel({ order, amendments, items, canWrite }: { order: OrderSummary; amendments: any[]; items: OrderItem[]; canWrite: boolean }) {
  const a = useOrderAction(order.id);
  const [open, setOpen] = useState(false);
  const withdraw = useMutation({ mutationFn: (id: string) => api.post(`/api/amendments/${id}/withdraw`), onSuccess: () => a.done('Suggestion withdrawn'), onError: a.fail });
  const finished = ['completed', 'cancelled'].includes(order.status);
  if (!amendments.length && (!canWrite || finished)) return null;
  return (
    <section>
      <SectionTitle action={canWrite && !finished && <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Suggest a change</Button>}>Changes for the customer</SectionTitle>
      <Card className="divide-y divide-line">
        {!amendments.length && <p className="px-4 py-4 text-[14px] text-ink-3">If something can’t be supplied as ordered, suggest a change here. The customer accepts or declines it from their order page; nothing changes until they do.</p>}
        {amendments.map((m) => (
          <div key={m.id} className="px-4 py-3 text-[14px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{m.summary}</span>
              <Badge size="sm" tone={AMEND_TONE[m.status] ?? 'neutral'}>{AMEND_LABEL[m.status] ?? m.status}</Badge>
            </div>
            <div className="text-ink-2">Why: {m.reason}{m.price_impact_cents ? ` · ${m.price_impact_cents > 0 ? '+' : '−'}${formatMoney(Math.abs(m.price_impact_cents))}` : ''}</div>
            {m.response_note && <div className="text-ink-2">Customer: “{m.response_note}”</div>}
            <div className="text-[12.5px] text-ink-3">{dateTime(m.created_at)}{m.responded_at ? ` · answered ${dateTime(m.responded_at)}` : ''}</div>
            {canWrite && m.status === 'proposed' && <button type="button" className="mt-1 text-[13px] font-medium text-danger hover:underline" onClick={() => withdraw.mutate(m.id)}>Withdraw</button>}
          </div>
        ))}
      </Card>
      {open && <AmendmentSheet order={order} items={items.filter((i) => i.status === 'active')} onClose={() => setOpen(false)} />}
    </section>
  );
}

function AmendmentSheet({ order, items, onClose }: { order: OrderSummary; items: OrderItem[]; onClose: () => void }) {
  const a = useOrderAction(order.id);
  const [kind, setKind] = useState<'change_qty' | 'remove_item' | 'replace_product' | 'timeframe' | 'other'>('change_qty');
  const [itemId, setItemId] = useState(items[0]?.id ?? '');
  const [line, setLine] = useState<ItemDraft | null>(null);
  const [editor, setEditor] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [from, setFrom] = useState(order.expected_from ?? '');
  const [to, setTo] = useState(order.expected_to ?? '');
  const [approval, setApproval] = useState(true);
  const item = items.find((i) => i.id === itemId);
  const send = useMutation({
    mutationFn: () =>
      api.post(`/api/orders/${order.id}/amendments`, {
        kind,
        reason,
        item_id: ['change_qty', 'remove_item', 'replace_product'].includes(kind) ? itemId : null,
        product_id: line?.product_id ?? null,
        qty: line?.qty ?? null,
        preparation: line?.preparation ?? null,
        expected_from: kind === 'timeframe' ? from : null,
        expected_to: kind === 'timeframe' && to && to !== from ? to : null,
        message: message || null,
        requires_approval: ['timeframe', 'other'].includes(kind) ? approval : true,
      }),
    onSuccess: () => { a.done('Sent to the customer'); onClose(); },
    onError: a.fail,
  });
  const needsLine = kind === 'change_qty' || kind === 'replace_product';
  const ok = reason.trim() && (!needsLine || line) && (kind !== 'timeframe' || ymdOk(from)) && (kind !== 'other' || message.trim()) && (!['change_qty', 'remove_item', 'replace_product'].includes(kind) || item);
  return (
    <Sheet open onClose={onClose} title="Suggest a change" subtitle="The customer is emailed and answers on their order page." footer={<Button full size="lg" variant="primary" disabled={!ok} loading={send.isPending} onClick={() => send.mutate()}>Send to the customer</Button>}>
      <div className="space-y-4">
        <Field label="What change?">
          <Select value={kind} onChange={(e) => { setKind(e.target.value as any); setLine(null); }}>
            <option value="change_qty">Change a quantity</option>
            <option value="replace_product">Offer a different product</option>
            <option value="remove_item">Remove an item (e.g. not available)</option>
            <option value="timeframe">Change the expected date</option>
            <option value="other">Something else / a question</option>
          </Select>
        </Field>
        {['change_qty', 'remove_item', 'replace_product'].includes(kind) && (
          <Field label="Item">
            <Select value={itemId} onChange={(e) => { setItemId(e.target.value); setLine(null); }}>
              {items.map((i) => <option key={i.id} value={i.id}>{i.qty_label} {i.product_name}</option>)}
            </Select>
          </Field>
        )}
        {needsLine && item && (
          <div>
            <Button variant="secondary" onClick={() => setEditor(true)}>{line ? 'Change the new line' : kind === 'change_qty' ? 'Set the new quantity' : 'Choose the replacement'}</Button>
            {line && <p className="mt-2 text-[13.5px] text-ink-2">New line ready. The price change is worked out from today’s prices.</p>}
          </div>
        )}
        {kind === 'timeframe' && <TimeframeFields from={from} to={to} setFrom={setFrom} setTo={setTo} />}
        {(kind === 'other' || kind === 'timeframe') && (
          <>
            {kind === 'other' && <Field label="Message for the customer"><Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>}
            <label className="flex items-start gap-2 text-[14px]"><input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} className="mt-0.5 size-5 accent-[var(--brand)]" />The customer must accept or decline</label>
          </>
        )}
        <Field label="Reason (the customer sees this)"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. We only have 1.6kg of fillet this week" /></Field>
      </div>
      {item && (
        <ItemEditor
          open={editor}
          onClose={() => setEditor(false)}
          initial={kind === 'change_qty' ? { product_id: item.product_id, qty: item.qty, preparation: item.preparation, special_instructions: item.special_instructions } : null}
          lockProduct={kind === 'change_qty'}
          title={kind === 'change_qty' ? `New quantity: ${item.product_name}` : 'Replacement product'}
          onSave={(d) => { setLine(d); setEditor(false); }}
        />
      )}
    </Sheet>
  );
}

// ── Customer link & message log ──────────────────────────────

export function CustomerLinkCard({ orderId }: { orderId: string }) {
  const a = useOrderAction(orderId);
  const toast = useToast();
  const copy = async (revoke: boolean) => {
    try {
      if (revoke && !window.confirm('Replace the customer’s order link? Links in earlier emails will stop working.')) return;
      const r = revoke ? await api.post<{ url: string }>(`/api/orders/${orderId}/link/revoke`) : await api.get<{ url: string }>(`/api/orders/${orderId}/link`);
      await navigator.clipboard?.writeText(r.url).catch(() => undefined);
      toast({ tone: 'success', title: revoke ? 'New link copied. Old links no longer work.' : 'Customer link copied', body: r.url });
      if (revoke) a.done();
    } catch (e) {
      a.fail(e);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} onClick={() => copy(false)}>Copy customer link</Button>
      <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => copy(true)}>Replace link</Button>
    </div>
  );
}

const N_TONE: Record<string, Tone> = { sent: 'field', queued: 'slate', failed: 'danger', skipped: 'neutral' };
const N_LABEL: Record<string, string> = { sent: 'Sent', queued: 'Queued', failed: 'Failed', skipped: 'Not sent' };

export function NotificationList({ rows, canRetry, compact }: { rows: any[]; canRetry: boolean; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/api/notifications/${id}/retry`),
    onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'success', title: 'Queued to send again' }); },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'That did not work.' }),
  });
  if (!rows.length) return <p className="px-4 py-4 text-[14px] text-ink-3">No messages yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((n) => (
        <li key={n.id} className="flex items-start gap-3 px-4 py-2.5 text-[13.5px]">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{n.subject ?? n.title ?? n.kind}</div>
            <div className="break-all text-[12.5px] text-ink-3">
              {!compact && n.order_number ? `#${n.order_number} · ` : ''}{n.audience === 'staff' ? 'Staff' : 'Customer'}{n.recipient ? ` · ${n.recipient}` : ''} · {dateTime(n.sent_at ?? n.created_at)}{n.attempts > 1 ? ` · ${n.attempts} tries` : ''}
            </div>
            {n.error && <div className="text-[12.5px] text-danger">{n.error}</div>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge size="sm" tone={N_TONE[n.status] ?? 'neutral'}>{N_LABEL[n.status] ?? n.status}</Badge>
            {canRetry && (n.status === 'failed' || (n.status === 'skipped' && n.recipient)) && <button type="button" className="text-[12.5px] font-medium text-brand hover:underline" onClick={() => retry.mutate(n.id)}>Try again</button>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ExpectedRow({ order, canWrite, onChange }: { order: OrderSummary; canWrite: boolean; onChange: () => void }) {
  if (!order.confirmed_at && !order.expected_from) return null;
  return (
    <KeyValue label="Expected">
      <span className="inline-flex flex-wrap items-center gap-2">
        {order.expected_from ? (order.expected_to && order.expected_to !== order.expected_from ? `${longDate(order.expected_from)} – ${longDate(order.expected_to)}` : longDate(order.expected_from)) : <span className="text-ochre">Not set</span>}
        {canWrite && !['completed', 'cancelled'].includes(order.status) && <button type="button" onClick={onChange} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"><CalendarClock className="size-3.5" />Change</button>}
      </span>
    </KeyValue>
  );
}


import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCircle2, Clock, Copy, Landmark, MessageCircle, Upload } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PublicShell } from '../components/PublicShell';
import { Button, Card, cx, Field, Input, Spinner, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { dateTime, formatMoney, todayYmd } from '../lib/format';

/**
 * The customer's secure EFT payment page. Everything here comes from the finalized order on the
 * server; the page never works out an amount itself. Paying is done in the customer's own banking
 * app — there is no bank integration, so this page gives them the exact details to copy, and a way
 * to tell us they've paid. Only staff, after checking the bank, can mark the order paid.
 */

type Pay = any;
const kg = (g: number) => `${(g / 1000).toLocaleString('en-ZA', { maximumFractionDigits: 3 })} kg`;

export default function PayPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const key = ['pay', token];
  const { data, error, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<{ pay: Pay }>(`/api/public/pay/${token}`), retry: false });
  const p = data?.pay;
  const set = (pay: Pay) => qc.setQueryData(key, { pay });
  // The order page's "Already paid?" link (?paid=1) opens straight on the "I've paid" form
  const [params] = useSearchParams();
  const [declaring, setDeclaring] = useState(params.get('paid') === '1');
  const openDeclare = () => {
    setDeclaring(true);
    setTimeout(() => document.getElementById('ive-paid')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  useEffect(() => {
    if (declaring && p?.status === 'awaiting_payment') setTimeout(() => document.getElementById('ive-paid')?.scrollIntoView({ block: 'start' }), 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.status]);
  useEffect(() => {
    document.title = p ? `Pay order #${p.order.number}` : 'Payment';
  }, [p]);

  if (isLoading) return <PublicShell subtitle="Payment"><div className="flex justify-center py-24"><Spinner className="size-6" /></div></PublicShell>;
  if (error || !p) {
    const expired = error instanceof ApiError && error.status === 410;
    return (
      <PublicShell subtitle="Payment">
        <Card className="mx-auto mt-6 max-w-md p-8 text-center">
          <h1 className="font-display text-2xl font-semibold">{expired ? 'This payment link has expired' : 'We can’t open this payment page'}</h1>
          <p className="mt-2 text-ink-2">{error instanceof ApiError && error.status !== 404 ? error.message : 'The link may be incomplete or no longer valid. Open your order from our latest email, or sign in to see your orders.'}</p>
          <Link to="/account" className="mt-5 inline-flex h-11 items-center rounded-xl bg-brand px-5 font-semibold text-brand-ink">See my orders</Link>
        </Card>
      </PublicShell>
    );
  }

  const due = p.amount_due_cents as number | null;
  return (
    <PublicShell subtitle={`Payment · order #${p.order.number}`}>
      <div className="animate-rise space-y-5">
        <div>
          <p className="text-[14px] font-medium text-ink-3">Order #{p.order.number} · {dateTime(p.order.date)}</p>
          <h1 className="mt-1 font-display text-[28px] font-semibold leading-tight sm:text-[32px]">
            {p.status === 'paid' ? 'Payment received' : p.status === 'superseded' ? 'This payment request was replaced' : p.status === 'awaiting_verification' ? 'Payment awaiting verification' : 'Pay for your order'}
          </h1>
          <p className="mt-1 text-[15px] text-ink-2">{p.order.customer_name}</p>
        </div>

        <StatusBanner p={p} />

        {due != null && (
          <Card className="p-5 text-center">
            <div className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Amount due</div>
            <div className="mt-1 font-display text-[40px] font-semibold leading-none tabular">{formatMoney(due, 'ZAR')}</div>
            <div className="mt-2 text-[14px] text-ink-2">Payment reference: <b className="tabular">{p.reference}</b></div>
            {p.status === 'awaiting_payment' && (
              <button type="button" onClick={openDeclare} className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl border border-brand/40 bg-brand-soft px-4 text-[15px] font-semibold text-brand-soft-ink">
                <Check className="size-4" />Already paid? Tap here
              </button>
            )}
          </Card>
        )}

        {p.bank && due != null && <BankDetails p={p} due={due} />}
        {p.eft_unavailable && <p className="rounded-xl bg-ochre-soft px-4 py-3 text-[14px] text-ochre-soft-ink">EFT details aren’t available right now. Please contact us to arrange payment.</p>}

        {p.status === 'awaiting_payment' && <Declare token={token} due={due} reference={p.reference} open={declaring} setOpen={setDeclaring} onDone={set} />}
        {(p.status === 'awaiting_payment' || p.status === 'awaiting_verification') && <ProofUpload token={token} due={due} onDone={set} />}

        <section>
          <h2 className="mb-2 font-display text-[20px] font-bold">Your order</h2>
          <Card className="divide-y divide-line">
            {p.lines.map((l: any, k: number) => (
              <div key={k} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-semibold">{l.qty_label} {l.name}</div>
                  <div className="text-[13px] text-ink-2">
                    {[l.preparation, l.weight_g ? `${kg(l.weight_g)} packed` : null, l.pack_price_cents != null ? `${l.pack_count} × ${formatMoney(l.pack_price_cents, 'ZAR')} per pack` : l.unit_price_cents != null ? `${formatMoney(l.unit_price_cents, 'ZAR')}/${l.price_unit === 'kg' ? 'kg' : 'each'}` : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="shrink-0 text-right font-semibold tabular">{formatMoney(l.line_cents, 'ZAR')}</div>
              </div>
            ))}
            {p.delivery_fee_cents > 0 && <div className="flex justify-between px-4 py-3"><span>Delivery</span><span className="tabular">{formatMoney(p.delivery_fee_cents, 'ZAR')}</span></div>}
            <div className="flex items-baseline justify-between px-4 py-3 text-[16px]"><span className="font-semibold">Total</span><b className="tabular">{formatMoney(p.total_cents, 'ZAR')}</b></div>
            {p.paid_cents > 0 && <div className="flex justify-between px-4 py-3 text-field"><span>Paid</span><span className="tabular">{formatMoney(p.paid_cents, 'ZAR')}</span></div>}
          </Card>
          <p className="mt-2 text-[13px] text-ink-3">
            {[p.order.storage ? (p.order.storage === 'frozen' ? 'Frozen' : 'Fresh') : null, 'vacuum-packed', p.order.fulfilment === 'collection' ? `Collection${p.order.collection ? `: ${p.order.collection}` : ''}` : p.order.address ? `Delivery to ${p.order.address}` : null].filter(Boolean).join(' · ')}
          </p>
        </section>

        {(p.declarations.length > 0 || p.proofs.length > 0 || p.payments.length > 0) && (
          <section>
            <h2 className="mb-2 font-display text-[20px] font-bold">Payment updates</h2>
            <Card className="divide-y divide-line text-[14px]">
              {p.payments.map((x: any) => <div key={x.id} className="px-4 py-3"><b className="text-field">Received {formatMoney(x.amount_cents, 'ZAR')}</b> · {x.method} · receipt {x.receipt} · {dateTime(x.created_at)}</div>)}
              {p.proofs.map((x: any) => <div key={x.id} className="px-4 py-3">Proof of payment ({x.filename}) · {dateTime(x.created_at)} — <span className={x.status === 'rejected' ? 'font-medium text-danger' : 'text-ink-2'}>{x.status === 'submitted' ? 'being checked' : x.status === 'accepted' ? 'confirmed' : `not matched${x.review_note ? `: ${x.review_note}` : ''}`}</span></div>)}
              {p.declarations.map((x: any) => <div key={x.id} className="px-4 py-3">You told us you paid{x.amount_cents ? ` ${formatMoney(x.amount_cents, 'ZAR')}` : ''}{x.payer_reference ? ` from “${x.payer_reference}”` : ''} · {dateTime(x.created_at)} — <span className={x.status === 'rejected' ? 'font-medium text-danger' : 'text-ink-2'}>{x.status === 'submitted' ? 'being checked' : x.status === 'accepted' ? 'confirmed' : `not found yet${x.review_note ? `: ${x.review_note}` : ''}`}</span></div>)}
            </Card>
          </section>
        )}

        <Card className="p-4">
          <div className="font-semibold">Need help with your payment?</div>
          <p className="mt-1 text-[14px] text-ink-2">Have your order number #{p.order.number} handy.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {p.business.whatsapp_url && <a href={p.business.whatsapp_url} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 font-semibold"><MessageCircle className="size-4 text-[#1f9d55]" />Chat to us on WhatsApp</a>}
            {p.business.phone && <a href={`tel:${p.business.phone.replace(/\s/g, '')}`} className="inline-flex h-11 items-center rounded-xl border border-line-strong bg-surface px-4 font-semibold">Call {p.business.phone}</a>}
          </div>
        </Card>
        <p className="text-center text-[13px] text-ink-3"><Link to={p.order_url} className="underline underline-offset-2">View my order</Link> · <Link to="/help" className="underline underline-offset-2">Help & FAQ</Link></p>
      </div>
    </PublicShell>
  );
}

function StatusBanner({ p }: { p: Pay }) {
  const box = (tone: string, icon: ReactNode, children: ReactNode) => <div className={cx('flex gap-3 rounded-2xl p-4 text-[15px] leading-relaxed', tone)} role="status">{icon}<div>{children}</div></div>;
  if (p.status === 'paid') return box('bg-field-soft text-field-soft-ink', <CheckCircle2 className="mt-0.5 size-5 shrink-0" />, <>Thank you — your payment has been received and verified. We’ll let you know when your order is on its way.</>);
  if (p.status === 'superseded') return box('bg-ochre-soft text-ochre-soft-ink', <AlertTriangle className="mt-0.5 size-5 shrink-0" />, <>Your order was updated, so this payment request no longer applies. <b>Please don’t pay this amount.</b> Use the latest payment request we sent you, or <Link to={p.order_url} className="font-semibold underline">open your order</Link>.</>);
  if (p.status === 'awaiting_verification') return box('bg-surface-2 text-ink-2', <Clock className="mt-0.5 size-5 shrink-0" />, <>Thanks for letting us know. We’ll confirm as soon as the payment reflects in our account, and then let you know your delivery or collection day.</>);
  return box('bg-surface-2 text-ink-2', <Landmark className="mt-0.5 size-5 shrink-0" />, <>Your order has been packed and weighed. Pay by EFT from your banking app using the details below, then tap “I’ve paid” — no proof needed. Payment must reflect before your order is released.</>);
}

/** Banking details with one-tap copy for each value, and everything at once. */
function BankDetails({ p, due }: { p: Pay; due: number }) {
  const b = p.bank;
  const amount = (due / 100).toFixed(2);
  const rows: [string, string | null][] = [
    ['Account holder', b.accountHolder],
    ['Bank', b.bankName],
    ['Account type', b.accountType],
    ['Account number', b.accountNumber],
    ['Branch code', b.branchCode],
    ['SWIFT / BIC', b.swift],
    ['Reference', p.reference],
    ['Amount', amount],
  ];
  const all = rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${k === 'Amount' ? `R${v}` : v}`).join('\n');
  return (
    <section>
      <h2 className="mb-2 font-display text-[20px] font-bold">Banking details</h2>
      <Card className="p-4">
        <dl className="divide-y divide-line">
          {rows.filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <dt className="text-[12.5px] text-ink-3">{k}</dt>
                <dd className={cx('break-all font-semibold tabular', (k === 'Reference' || k === 'Amount') && 'text-[17px]')}>{k === 'Amount' ? formatMoney(due, 'ZAR') : v}</dd>
              </div>
              <CopyButton text={v!} label={k} />
            </div>
          ))}
        </dl>
        <div className="mt-3 border-t border-line pt-3">
          <CopyButton text={all} label="all payment details" big />
          <p className="mt-2 text-[13px] text-ink-3">Then open your banking app, pay Terram Farm as a once-off payment with these details, and use <b>{p.reference}</b> as the reference.</p>
        </div>
        {b.referenceInstructions && <p className="mt-2 text-[13.5px] text-ink-2">{b.referenceInstructions}</p>}
        {b.instructions && <p className="mt-1 whitespace-pre-line text-[13.5px] text-ink-2">{b.instructions}</p>}
        {b.contact && <p className="mt-1 text-[13.5px] text-ink-2">Payment queries: {b.contact}</p>}
      </Card>
    </section>
  );
}

function CopyButton({ text, label, big }: { text: string; label: string; big?: boolean }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const go = async () => {
    const ok = await copyText(text);
    setState(ok ? 'done' : 'failed');
    setTimeout(() => setState('idle'), 2000);
  };
  const msg = state === 'done' ? 'Copied' : state === 'failed' ? 'Couldn’t copy — select and copy it' : null;
  if (big)
    return (
      <Button full size="lg" variant="primary" icon={state === 'done' ? <Check className="size-4" /> : <Copy className="size-4" />} onClick={go} aria-label={`Copy ${label}`}>
        <span aria-live="polite">{msg ?? 'Copy all payment details'}</span>
      </Button>
    );
  return (
    <button type="button" onClick={go} className={cx('inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-semibold', state === 'done' ? 'border-field text-field' : state === 'failed' ? 'border-danger text-danger' : 'border-line-strong text-ink-2 hover:bg-sunken')} aria-label={`Copy ${label}`}>
      {state === 'done' ? <Check className="size-4" /> : <Copy className="size-4" />}
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}</span>
    </button>
  );
}

/** "I've paid": the main way to tell us — no proof of payment needed. Staff check the bank and confirm. */
function Declare({ token, due, reference, open, setOpen, onDone }: { token: string; due: number | null; reference: string; open: boolean; setOpen: (v: boolean) => void; onDone: (p: Pay) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [amount, setAmount] = useState(due != null ? (due / 100).toFixed(2) : '');
  const [date, setDate] = useState(todayYmd());
  const [payer, setPayer] = useState('');
  const [note, setNote] = useState('');
  const send = useMutation({
    mutationFn: () => api.post<{ pay: Pay }>(`/api/public/pay/${token}/declare`, { confirm: true, amount_cents: amount ? Math.round(Number(amount.replace(',', '.')) * 100) : null, paid_on: date || null, payer_reference: payer || null, note: note || null }),
    onSuccess: (r) => onDone(r.pay),
  });
  return (
    <section id="ive-paid" className="scroll-mt-4 rounded-2xl border-2 border-brand/40 bg-surface p-4">
      <h2 className="font-display text-[20px] font-bold">Paid already?</h2>
      <p className="mt-1 text-[14.5px] text-ink-2">Just let us know — <b>no proof of payment needed</b>. We’ll check our bank, confirm your payment and let you know your delivery or collection day.</p>
      {!open ? (
        <Button className="mt-3" full size="lg" variant="primary" icon={<Check className="size-4" />} onClick={() => setOpen(true)}>I’ve paid</Button>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount paid (R)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Date paid"><Input type="date" max={todayYmd()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          <Field label="Name or reference the payment came from" optional hint="E.g. the account holder’s name or business name, if it’s not yours. It helps us find the payment.">
            <Input value={payer} onChange={(e) => setPayer(e.target.value)} maxLength={120} autoComplete="off" />
          </Field>
          <Field label="Anything else?" optional><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <label className="flex items-start gap-3 text-[14.5px]">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" />
            <span>I’ve paid Terram Farm using reference <b>{reference}</b>. I understand my order is confirmed as paid once the payment reflects.</span>
          </label>
          {send.error && <p className="text-[14px] text-danger" role="alert">{(send.error as Error).message}</p>}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" full disabled={!confirm} loading={send.isPending} onClick={() => send.mutate()}>Send — I’ve paid</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProofUpload({ token, due, onDone }: { token: string; due: number | null; onDone: (p: Pay) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [amount, setAmount] = useState(due != null ? (due / 100).toFixed(2) : '');
  const tooBig = !!file && file.size > 5 * 1024 * 1024;
  const send = useMutation({
    mutationFn: () => {
      const f = new FormData();
      f.set('file', file!);
      if (amount) f.set('amount', amount);
      return api.upload<{ pay: Pay }>(`/api/public/pay/${token}/proof`, f);
    },
    onSuccess: (r) => {
      setFile(null);
      onDone(r.pay);
    },
  });
  return (
    <Card className="space-y-3 p-4">
      <h2 className="flex items-center gap-2 font-semibold"><Upload className="size-4" />Have a proof of payment? <span className="font-normal text-ink-3">(optional)</span></h2>
      <p className="text-[13.5px] text-ink-2">If your banking app gives you one, you can upload it here (PDF, JPG or PNG, up to 5 MB). Not needed if you’ve tapped “I’ve paid”.</p>
      <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,.heic,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-[14px] file:mr-3 file:h-11 file:rounded-xl file:border-0 file:bg-sunken file:px-4 file:font-semibold" aria-label="Proof of payment file" />
      {tooBig && <p className="text-[13.5px] text-danger">That file is bigger than 5 MB.</p>}
      <Field label="Amount paid (R)" optional><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40" /></Field>
      {send.error && <p className="text-[14px] text-danger" role="alert">{(send.error as Error).message}</p>}
      <Button variant="primary" disabled={!file || tooBig} loading={send.isPending} onClick={() => send.mutate()}>Send proof</Button>
    </Card>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Copy, FileText, Mail, MessageCircle, Send } from 'lucide-react';
import { useState } from 'react';
import { EmailPreview } from './OrderPlatform';
import { PaymentRequestSheet } from './FinalWeighing';
import { Badge, Button, Card, SectionTitle, Sheet, Textarea, useToast, type Tone } from './ui';
import { api, ApiError } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { dateTime, formatMoney } from '../lib/format';

/**
 * Everything sent to the customer about this order, and the separate, explicit ways to send more:
 * the order confirmation, the payment request, the invoice notification, an editable WhatsApp
 * message and the portal link. Statuses are honest: email can only ever be "Sent" (accepted by our
 * mail server), never "Delivered"; WhatsApp goes from a staff phone, so it's recorded as opened.
 */
interface Comms {
  history: { at: string; channel: 'email' | 'whatsapp' | 'link'; kind: string; kind_label: string; to: string | null; subject: string | null; status: string; status_label: string; detail: string | null; attempts: number }[];
  whatsapp_invoice: Comms['whatsapp'] | null;
  whatsapp: { kind: 'payment' | 'update' | 'invoice'; text: string; phone: string | null; wa_phone: string | null; portal_url: string; outstanding_cents: number | null };
  confirmation: { to: string | null; subject: string | null; text: string | null };
}

interface ReminderData {
  state: { eligible: boolean; due: boolean; days: number; waiting_since: string | null; due_at: string | null; days_waiting: number | null; snoozed_until: string | null; reminders_sent: number; last_reminder_at: string | null; reason: string | null };
  draft: { to: string | null; subject: string; text: string; whatsapp: string; phone: string | null; wa_phone: string | null; amount_cents: number } | null;
}

const TONE: Record<string, Tone> = { sent: 'field', queued: 'slate', failed: 'danger', skipped: 'neutral', manual: 'ochre' };

export function CommunicationsPanel({ orderId, canWrite, hasInvoice, invoiceSent, canPay, paymentReady, awaitingCheck, onInvoiceNotify }: { orderId: string; canWrite: boolean; hasInvoice: boolean; invoiceSent: boolean; canPay: boolean; paymentReady: boolean; awaitingCheck?: boolean; onInvoiceNotify: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['order-comms', orderId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<Comms>(`/api/orders/${orderId}/communications`) });
  const [sheet, setSheet] = useState<'confirm' | 'whatsapp' | 'whatsapp-invoice' | 'payment' | 'reminder' | null>(null);
  const reminder = useQuery({ queryKey: ['payment-reminder', orderId], queryFn: () => api.get<ReminderData>(`/api/orders/${orderId}/payment-reminder`), enabled: canWrite && canPay });
  const rs = reminder.data?.state;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['payment-reminder', orderId] });
    qc.invalidateQueries({ queryKey: ['order', orderId] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const fail = (e: unknown) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'That did not work.' });
  const copyLink = async () => {
    if (!data) return;
    const ok = await copyText(data.whatsapp.portal_url);
    toast(ok ? { tone: 'success', title: 'Portal link copied', body: data.whatsapp.portal_url } : { tone: 'error', title: 'Couldn’t copy the link' });
    if (ok) api.post(`/api/orders/${orderId}/communications/link-copied`).then(refresh).catch(() => undefined);
  };
  const history = data?.history ?? [];
  return (
    <section id="communications">
      <SectionTitle>Communications</SectionTitle>
      {canWrite && canPay && rs?.eligible && (
        <div className={`mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${rs.due ? 'border-ochre/40 bg-ochre-soft text-ochre-soft-ink' : 'border-line bg-surface text-ink-2'}`}>
          <div className="min-w-0 text-[13.5px]">
            <div className="flex items-center gap-2 font-semibold"><BellRing className="size-4 shrink-0" />{rs.due ? 'Time to follow up on payment' : 'Payment not received yet'}</div>
            <p className="mt-0.5">
              {rs.days_waiting != null && `Payment was asked for ${rs.days_waiting} day${rs.days_waiting === 1 ? '' : 's'} ago`}
              {rs.reminders_sent ? ` · ${rs.reminders_sent} reminder${rs.reminders_sent === 1 ? '' : 's'} so far` : ''}
              {!rs.due && rs.due_at ? ` · reminder due ${dateTime(rs.due_at)}` : ''}. Check the bank first, then remind the customer. Nothing is sent unless you choose to.
            </p>
          </div>
          <Button size="sm" variant={rs.due ? 'primary' : 'secondary'} icon={<BellRing className="size-3.5" />} onClick={() => setSheet('reminder')}>Remind for payment…</Button>
        </div>
      )}
      {canWrite && data && !data.confirmation.to && (
        <p className="mb-3 flex gap-2 rounded-2xl bg-ochre-soft px-4 py-3 text-[13.5px] text-ochre-soft-ink" role="note">
          <Mail className="mt-0.5 size-4 shrink-0" />
          <span><b>No email address on this order.</b> Confirmations, payment requests, reminders and invoices can’t be emailed. Add an email under Customer, or send them on WhatsApp. Delivery is arranged on WhatsApp either way.</span>
        </p>
      )}
      <Card className="overflow-hidden">
        {canWrite && (
          <div className="grid grid-cols-1 gap-2 border-b border-line p-3 sm:grid-cols-2">
            <Button size="sm" icon={<Mail className="size-3.5" />} disabled={!data?.confirmation.to} onClick={() => setSheet('confirm')}>Send order confirmation…</Button>
            {awaitingCheck ? (
              <p className="flex items-center rounded-xl bg-ochre-soft px-3 py-2 text-[12.5px] text-ochre-soft-ink">Customer says they’ve paid: check the bank under Payment before asking again.</p>
            ) : (
              <Button size="sm" icon={<Send className="size-3.5" />} disabled={!paymentReady} onClick={() => setSheet('payment')} title={paymentReady ? undefined : 'Finalize the order first'}>Send payment request…</Button>
            )}
            <Button size="sm" icon={<FileText className="size-3.5" />} disabled={!hasInvoice || !canPay} onClick={onInvoiceNotify} title={hasInvoice ? undefined : 'Upload the invoice first'}>{invoiceSent ? 'Send invoice notification again…' : 'Send invoice notification…'}</Button>
            <Button size="sm" icon={<MessageCircle className="size-3.5" />} disabled={!data?.whatsapp_invoice} onClick={() => setSheet('whatsapp-invoice')} title={hasInvoice ? undefined : 'Upload the invoice first'}>Send invoice on WhatsApp…</Button>
            <Button size="sm" icon={<MessageCircle className="size-3.5" />} disabled={!data} onClick={() => setSheet('whatsapp')}>WhatsApp message…</Button>
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} disabled={!data} onClick={copyLink} className="sm:col-span-2">Copy customer portal link</Button>
          </div>
        )}
        {history.length ? (
          <ul className="divide-y divide-line">
            {history.map((h, i) => (
              <li key={i} className="px-4 py-2.5 text-[13.5px]">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 font-semibold">{h.kind_label}<span className="font-normal text-ink-3"> · {h.channel === 'email' ? 'Email' : h.channel === 'whatsapp' ? 'WhatsApp' : 'Link'}</span></span>
                  <Badge size="sm" tone={TONE[h.status] ?? 'neutral'}>{h.status_label}</Badge>
                </div>
                <div className="mt-0.5 break-words text-[12.5px] text-ink-3">{[h.to, dateTime(h.at), h.attempts > 1 ? `${h.attempts} attempts` : null].filter(Boolean).join(' · ')}</div>
                {h.detail && <div className="mt-0.5 break-words text-[12.5px] text-ink-2">{h.detail}</div>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-5 text-center text-[14px] text-ink-3">Nothing sent to the customer yet.</p>
        )}
        <p className="border-t border-line bg-surface-2 px-4 py-2 text-[12px] text-ink-3">“Sent” means our mail server accepted the email; we can’t see whether it reached the inbox. WhatsApp messages are sent from your phone and aren’t tracked.</p>
      </Card>
      {sheet === 'confirm' && data && <ConfirmationSheet orderId={orderId} c={data.confirmation} sentBefore={history.some((h) => h.kind === 'order_received')} onClose={() => setSheet(null)} onDone={refresh} onError={fail} />}
      {sheet === 'whatsapp' && data && <WhatsAppSheet orderId={orderId} w={data.whatsapp} onClose={() => setSheet(null)} onDone={refresh} onError={fail} />}
      {sheet === 'whatsapp-invoice' && data?.whatsapp_invoice && <WhatsAppSheet orderId={orderId} w={data.whatsapp_invoice} onClose={() => setSheet(null)} onDone={refresh} onError={fail} />}
      {sheet === 'reminder' && canPay && reminder.data?.draft && rs && <ReminderSheet orderId={orderId} d={reminder.data.draft} s={rs} onClose={() => setSheet(null)} onDone={refresh} onError={fail} />}
      <PaymentRequestSheet orderId={orderId} open={sheet === 'payment'} onClose={() => { setSheet(null); refresh(); }} />
    </section>
  );
}

function ConfirmationSheet({ orderId, c, sentBefore, onClose, onDone, onError }: { orderId: string; c: Comms['confirmation']; sentBefore: boolean; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const toast = useToast();
  const send = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/communications/confirmation`), onSuccess: () => { toast({ tone: 'success', title: 'Order confirmation sent' }); onDone(); onClose(); }, onError });
  return (
    <Sheet open onClose={onClose} title={sentBefore ? 'Send the order confirmation again' : 'Send the order confirmation'} footer={<Button full size="lg" variant="primary" disabled={!c.to} loading={send.isPending} onClick={() => send.mutate()}>{sentBefore ? 'Send again' : 'Send email'}</Button>}>
      {sentBefore && <p className="mb-3 rounded-xl bg-ochre-soft px-3 py-2 text-[13.5px] text-ochre-soft-ink">This was already sent when the order came in. Only send it again if the customer can’t find it.</p>}
      <EmailPreview to={c.to} subject={c.subject} text={c.text} />
    </Sheet>
  );
}

function WhatsAppSheet({ orderId, w, onClose, onDone, onError }: { orderId: string; w: Comms['whatsapp']; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const [text, setText] = useState(w.text);
  const record = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/communications/whatsapp`, { text, kind: w.kind === 'invoice' ? 'invoice' : 'message' }), onSuccess: () => onDone(), onError });
  const href = w.wa_phone ? `https://wa.me/${w.wa_phone}?text=${encodeURIComponent(text)}` : null;
  return (
    <Sheet
      open
      onClose={onClose}
      title={w.kind === 'invoice' ? 'Send the invoice on WhatsApp' : 'WhatsApp message'}
      subtitle={w.phone ? `To ${w.phone}` : 'No mobile number on this order'}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button size="lg" variant="ghost" onClick={async () => { await copyText(text); }}>Copy text</Button>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="flex-1" onClick={() => record.mutate()}>
              <Button full size="lg" variant="primary" icon={<MessageCircle className="size-4" />}>Open in WhatsApp</Button>
            </a>
          ) : (
            <Button full size="lg" disabled>Open in WhatsApp</Button>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-[13.5px] text-ink-2">{w.kind === 'payment' ? 'The payment message with the amount and secure payment link.' : w.kind === 'invoice' ? 'A message with a secure link where the customer views and downloads the uploaded invoice.' : 'A short update with the customer’s portal link.'} Edit it as you like — opening WhatsApp never changes the payment status. You send it from your phone.</p>
        <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="WhatsApp message" />
        <Button size="sm" variant="ghost" onClick={() => setText(w.text)}>Reset to the standard message</Button>
      </div>
    </Sheet>
  );
}

/** "Remind for payment": preview the email or WhatsApp, then send. Only ever on a deliberate click. */
function ReminderSheet({ orderId, d, s, onClose, onDone, onError }: { orderId: string; d: NonNullable<ReminderData['draft']>; s: ReminderData['state']; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const toast = useToast();
  const [how, setHow] = useState<'email' | 'whatsapp'>(d.to ? 'email' : 'whatsapp');
  const [text, setText] = useState(d.whatsapp);
  const send = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/payment-reminder/send`), onSuccess: () => { toast({ tone: 'success', title: 'Payment reminder sent', body: d.to ?? undefined }); onDone(); onClose(); }, onError });
  const wa = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/payment-reminder/whatsapp`, { text }), onSuccess: () => onDone(), onError });
  const snooze = useMutation({ mutationFn: (days: number) => api.post(`/api/orders/${orderId}/payment-reminder/snooze`, { days }), onSuccess: () => { toast({ tone: 'success', title: 'Reminder snoozed' }); onDone(); onClose(); }, onError });
  const href = d.wa_phone ? `https://wa.me/${d.wa_phone}?text=${encodeURIComponent(text)}` : null;
  return (
    <Sheet
      open
      onClose={onClose}
      title="Remind for payment"
      subtitle={`${formatMoney(d.amount_cents)} outstanding${s.reminders_sent ? ` · ${s.reminders_sent} earlier reminder${s.reminders_sent === 1 ? '' : 's'}` : ''}`}
      footer={
        how === 'email' ? (
          <Button full size="lg" variant="primary" icon={<Mail className="size-4" />} disabled={!d.to} loading={send.isPending} onClick={() => send.mutate()}>Send reminder email</Button>
        ) : href ? (
          <a href={href} target="_blank" rel="noreferrer" onClick={() => wa.mutate()} className="block"><Button full size="lg" variant="primary" icon={<MessageCircle className="size-4" />}>Open in WhatsApp</Button></a>
        ) : (
          <Button full size="lg" disabled>Open in WhatsApp</Button>
        )
      }
    >
      <div className="space-y-3">
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-[13.5px] text-ink-2">Check the bank first: if the money is in, record the payment instead. Nothing is sent until you tap the button below.</p>
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" variant={how === 'email' ? 'primary' : 'secondary'} onClick={() => setHow('email')}>Email</Button>
          <Button size="sm" variant={how === 'whatsapp' ? 'primary' : 'secondary'} onClick={() => setHow('whatsapp')}>WhatsApp</Button>
        </div>
        {how === 'email' ? (
          d.to ? <EmailPreview to={d.to} subject={d.subject} text={d.text} /> : <p className="rounded-xl bg-ochre-soft px-3 py-2 text-[13.5px] text-ochre-soft-ink">This order has no email address. Add one under Customer, or use WhatsApp.</p>
        ) : (
          <>
            <p className="text-[13px] text-ink-3">{d.phone ? `To ${d.phone}. ` : 'No mobile number on this order. '}You send it from your own phone; opening WhatsApp doesn’t change the payment status.</p>
            <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="WhatsApp reminder" />
            <Button size="sm" variant="ghost" onClick={() => setText(d.whatsapp)}>Reset to the standard message</Button>
          </>
        )}
        <div className="border-t border-line pt-3">
          <p className="mb-2 text-[13px] text-ink-3">Not yet? Hide this reminder for a while.</p>
          <div className="flex flex-wrap gap-2">{[3, 7].map((n) => <Button key={n} size="sm" variant="ghost" loading={snooze.isPending && snooze.variables === n} onClick={() => snooze.mutate(n)}>Snooze {n} days</Button>)}</div>
        </div>
      </div>
    </Sheet>
  );
}

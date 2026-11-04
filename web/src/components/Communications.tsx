import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FileText, Mail, MessageCircle, Send } from 'lucide-react';
import { useState } from 'react';
import { EmailPreview } from './OrderPlatform';
import { PaymentRequestSheet } from './FinalWeighing';
import { Badge, Button, Card, SectionTitle, Sheet, Textarea, useToast, type Tone } from './ui';
import { api, ApiError } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { dateTime } from '../lib/format';

/**
 * Everything sent to the customer about this order, and the separate, explicit ways to send more:
 * the order confirmation, the payment request, the invoice notification, an editable WhatsApp
 * message and the portal link. Statuses are honest: email can only ever be "Sent" (accepted by our
 * mail server), never "Delivered"; WhatsApp goes from a staff phone, so it's recorded as opened.
 */
interface Comms {
  history: { at: string; channel: 'email' | 'whatsapp' | 'link'; kind: string; kind_label: string; to: string | null; subject: string | null; status: string; status_label: string; detail: string | null; attempts: number }[];
  whatsapp: { kind: 'payment' | 'update'; text: string; phone: string | null; wa_phone: string | null; portal_url: string; outstanding_cents: number | null };
  confirmation: { to: string | null; subject: string | null; text: string | null };
}

const TONE: Record<string, Tone> = { sent: 'field', queued: 'slate', failed: 'danger', skipped: 'neutral', manual: 'ochre' };

export function CommunicationsPanel({ orderId, canWrite, hasInvoice, invoiceSent, canPay, paymentReady, onInvoiceNotify }: { orderId: string; canWrite: boolean; hasInvoice: boolean; invoiceSent: boolean; canPay: boolean; paymentReady: boolean; onInvoiceNotify: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['order-comms', orderId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<Comms>(`/api/orders/${orderId}/communications`) });
  const [sheet, setSheet] = useState<'confirm' | 'whatsapp' | 'payment' | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['order', orderId] });
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
      <Card className="overflow-hidden">
        {canWrite && (
          <div className="grid grid-cols-1 gap-2 border-b border-line p-3 sm:grid-cols-2">
            <Button size="sm" icon={<Mail className="size-3.5" />} disabled={!data?.confirmation.to} onClick={() => setSheet('confirm')}>Send order confirmation…</Button>
            <Button size="sm" icon={<Send className="size-3.5" />} disabled={!paymentReady} onClick={() => setSheet('payment')} title={paymentReady ? undefined : 'Finalize the order first'}>Send payment request…</Button>
            <Button size="sm" icon={<FileText className="size-3.5" />} disabled={!hasInvoice || !canPay} onClick={onInvoiceNotify} title={hasInvoice ? undefined : 'Upload the invoice first'}>{invoiceSent ? 'Send invoice notification again…' : 'Send invoice notification…'}</Button>
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
  const record = useMutation({ mutationFn: () => api.post(`/api/orders/${orderId}/communications/whatsapp`, { text }), onSuccess: () => onDone(), onError });
  const href = w.wa_phone ? `https://wa.me/${w.wa_phone}?text=${encodeURIComponent(text)}` : null;
  return (
    <Sheet
      open
      onClose={onClose}
      title="WhatsApp message"
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
        <p className="text-[13.5px] text-ink-2">{w.kind === 'payment' ? 'The payment message with the amount and secure payment link.' : 'A short update with the customer’s portal link.'} Edit it as you like — opening WhatsApp never changes the payment status. You send it from your phone.</p>
        <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="WhatsApp message" />
        <Button size="sm" variant="ghost" onClick={() => setText(w.text)}>Reset to the standard message</Button>
      </div>
    </Sheet>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Printer,
  Scissors,
  Package,
  Trash2,
  User,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { primaryNextStep, SOURCE_LABEL, STATUS_LABEL, PAYMENT_LABEL, type OrderStatus } from '../../../shared/workflow';
import { ExceptionCard } from '../components/ExceptionCard';
import { ItemEditor, type ItemDraft } from '../components/ItemEditor';
import { FulfilmentLabel, SourceIcon, StageTrack, StatusPill } from '../components/order-bits';
import { Badge, Button, Card, cx, ErrorState, Field, Input, KeyValue, LoadingBlock, SectionTitle, Segmented, Sheet, Textarea, useConfirm, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { dateTime, estimateLinePrice, formatMoney, friendlyDate, longDate, timeAgo, todayYmd, waLink } from '../lib/format';
import type { ExceptionRow, OrderEvent, OrderItem, OrderSummary } from '../lib/types';

interface Detail {
  order: OrderSummary;
  items: OrderItem[];
  events: OrderEvent[];
  messages: any[];
  interpretations: any[];
  exceptions: ExceptionRow[];
  transitions: OrderStatus[];
  customer: { id: string; name: string; phone: string | null; email: string | null; address: string | null; notes: string | null };
  replies: { id: string; body: string; created_at: string }[];
}

const SECONDARY_LABEL: Partial<Record<OrderStatus, string>> = {
  on_hold: 'Put on hold',
  needs_clarification: 'Needs clarification',
  review: 'Back to review',
  confirmed: 'Back to confirmed',
  cutting: 'Back to cutting',
  cut: 'Back to cut',
  packing: 'Back to packing',
  packed: 'Back to packed',
  ready: 'Back to ready',
  cancelled: 'Cancel order',
};

export default function OrderDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const navigate = useNavigate();
  const { ask, node: confirmNode } = useConfirm();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['order', id], queryFn: () => api.get<Detail>(`/api/orders/${id}`) });
  const [editing, setEditing] = useState<OrderItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [fulfilOpen, setFulfilOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [note, setNote] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['order', id] });
    qc.invalidateQueries({ queryKey: ['orders'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const onErr = (e: unknown) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'That did not work.' });
  const move = useMutation({
    mutationFn: (v: { to: OrderStatus; note?: string }) => api.post(`/api/orders/${id}/transition`, v),
    onSuccess: (_r, v) => {
      invalidate();
      toast({ tone: 'success', title: v.to === 'confirmed' ? 'Order confirmed' : v.to === 'completed' ? 'Order completed' : `Moved to ${STATUS_LABEL[v.to].toLowerCase()}` });
    },
    onError: onErr,
  });
  const saveItem = useMutation({
    mutationFn: (v: { itemId?: string; d: ItemDraft }) => (v.itemId ? api.patch(`/api/items/${v.itemId}`, v.d) : api.post(`/api/orders/${id}/items`, v.d)),
    onSuccess: (_r, v) => {
      setEditing(null);
      setAdding(false);
      invalidate();
      toast({ tone: 'success', title: v.itemId ? 'Item updated' : 'Item added', body: 'The change is recorded in the order history.' });
    },
    onError: onErr,
  });
  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.del(`/api/items/${itemId}`),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Item removed' });
    },
    onError: onErr,
  });
  const patch = useMutation({
    mutationFn: (body: any) => api.patch(`/api/orders/${id}`, body),
    onSuccess: () => {
      setFulfilOpen(false);
      invalidate();
      toast({ tone: 'success', title: 'Saved' });
    },
    onError: onErr,
  });
  const addNote = useMutation({
    mutationFn: (text: string) => api.post(`/api/orders/${id}/notes`, { text }),
    onSuccess: () => {
      setNote('');
      invalidate();
    },
    onError: onErr,
  });
  const notified = useMutation({
    mutationFn: (v: boolean) => api.post(`/api/orders/${id}/notified`, { notified: v }),
    onSuccess: () => invalidate(),
    onError: onErr,
  });

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <LoadingBlock rows={5} />;
  const { order: o, items, events, messages, exceptions } = data;
  const active = items.filter((i) => i.status === 'active');
  const removed = items.filter((i) => i.status === 'removed');
  const openEx = exceptions.filter((e) => e.status === 'open');
  const next = primaryNextStep(o.status, o.fulfilment_type);
  const canWrite = can('orders.write');
  const canProduce = can('production.write');
  const nextAllowed = next && data.transitions.includes(next.to) && (['review', 'confirmed'].includes(next.to) ? canWrite : canProduce);
  const blocked = openEx.some((e) => e.severity === 'blocking');
  const secondary = data.transitions.filter((t) => t !== next?.to);
  const today = todayYmd();
  const total = active.reduce<number | null>((sum, i) => {
    const p = estimateLinePrice(i.qty, i.price_cents, i.price_unit);
    return sum == null || p == null ? null : sum + p;
  }, 0);

  const doMove = async (to: OrderStatus) => {
    setMoreOpen(false);
    if (to === 'cancelled') {
      const ok = await ask({ title: `Cancel order #${o.order_number}?`, body: 'The order will be removed from cutting and packing. It stays in the history and can be reopened by a manager.', confirm: 'Cancel order', tone: 'danger' });
      if (!ok) return;
    }
    move.mutate({ to });
  };

  return (
    <div className="animate-rise">
      {confirmNode}
      <button onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/orders'))} className="mb-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Back
      </button>

      {/* Header */}
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[14px] text-ink-3">
            <span className="font-semibold tabular text-ink-2">Order #{o.order_number}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1"><SourceIcon source={o.source} className="size-3.5" /> {SOURCE_LABEL[o.source]}</span>
            <span>·</span>
            <span>{timeAgo(o.created_at)}</span>
          </div>
          <h1 className="mt-1 font-display text-[30px] font-semibold leading-tight sm:text-[36px]">
            <Link to={`/customers/${o.customer_id}`} className="hover:underline decoration-line-strong underline-offset-4">{o.customer_name}</Link>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            <StatusPill status={o.status} />
            <FulfilmentLabel type={o.fulfilment_type} date={o.requested_date} time={o.time_window} today={today} className="text-[14px]" />
            {o.fulfilment_type && o.status !== 'completed' && o.customer_notified_at && <Badge tone="field" size="sm">Customer told it’s ready</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/print/order/${o.id}`} target="_blank"><Button icon={<Printer className="size-4" />}>Print</Button></Link>
          {secondary.length > 0 && (canWrite || canProduce) && (
            <div className="relative">
              <Button icon={<MoreHorizontal className="size-4" />} onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}>More</Button>
              {moreOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
                  <div className="absolute right-0 z-20 mt-2 w-56 animate-rise overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-float">
                    {secondary.map((t) => (
                      <button key={t} onClick={() => doMove(t)} className={cx('flex w-full items-center rounded-xl px-3 py-2.5 text-left text-[14px] font-medium hover:bg-sunken', t === 'cancelled' ? 'text-danger' : 'text-ink')}>
                        {SECONDARY_LABEL[t] ?? STATUS_LABEL[t]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {o.status !== 'cancelled' && o.status !== 'on_hold' && (
        <Card className="mb-5 p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex-1"><StageTrack status={o.status} /></div>
            {next && nextAllowed && (
              <Button variant={o.status === 'ready' || o.status === 'out_for_delivery' ? 'success' : 'primary'} size="lg" loading={move.isPending} disabled={blocked && ['confirmed', 'cutting'].includes(next.to)} onClick={() => (o.status === 'packing' || o.status === 'cut' ? navigate('/packing') : move.mutate({ to: next.to }))} icon={<Check className="size-5" />} className="sm:min-w-52">
                {o.status === 'packing' || o.status === 'cut' ? 'Go to packing' : next.label}
              </Button>
            )}
          </div>
          {blocked && <p className="mt-3 text-[13.5px] text-brand">Answer the question{openEx.length > 1 ? 's' : ''} below before this order can be confirmed or cut.</p>}
          {o.status === 'needs_clarification' && !blocked && <p className="mt-3 text-[13.5px] text-ink-2">All questions are answered. Move it back to review when ready.</p>}
        </Card>
      )}
      {o.status === 'on_hold' && <Card className="mb-5 bg-sunken p-4 text-[14.5px] text-ink-2">This order is on hold. Use “More” to put it back into the workflow.</Card>}

      {openEx.length > 0 && (
        <section className="mb-6">
          <SectionTitle>Needs a decision</SectionTitle>
          <div className="space-y-3">
            {openEx.map((e) => (
              <ExceptionCard key={e.id} e={e} compact />
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          {/* Items */}
          <section>
            <SectionTitle action={canWrite && !['completed', 'cancelled'].includes(o.status) && <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add item</Button>}>
              Items · {active.length}
            </SectionTitle>
            <Card className="overflow-hidden">
              {active.length === 0 && <p className="px-5 py-8 text-center text-ink-3">No items yet.</p>}
              {active.map((i) => (
                <div key={i.id} className="flex items-start gap-3 border-b border-line px-4 py-3.5 last:border-b-0 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[16px] font-semibold text-ink">{i.product_name}</span>
                      {i.preparation_label && <span className="text-[14px] font-medium text-brand">{i.preparation_label}</span>}
                    </div>
                    {i.special_instructions && <p className="mt-0.5 text-[14px] text-ink-2">“{i.special_instructions}”</p>}
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[12.5px] text-ink-3">
                      {i.cut_at && <span className="inline-flex items-center gap-1 text-field"><Scissors className="size-3" /> Cut</span>}
                      {i.packed_at && <span className="inline-flex items-center gap-1 text-field"><Package className="size-3" /> Packed{i.packed_weight_g ? ` · ${(i.packed_weight_g / 1000).toFixed(2)}kg` : ''}</span>}
                      {i.source_text && i.source_text !== 'Order form' && <span className="truncate">from “{i.source_text}”</span>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-display text-[20px] font-semibold tabular">{i.qty_label}</div>
                    {estimateLinePrice(i.qty, i.price_cents, i.price_unit) != null && <div className="text-[12px] text-ink-3">≈ {formatMoney(estimateLinePrice(i.qty, i.price_cents, i.price_unit))}</div>}
                  </div>
                  {canWrite && !['completed', 'cancelled'].includes(o.status) && (
                    <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                      <button onClick={() => setEditing(i)} className="rounded-lg p-2 text-ink-3 hover:bg-sunken hover:text-ink" aria-label={`Edit ${i.product_name}`}><Pencil className="size-4" /></button>
                      <button
                        onClick={async () => {
                          if (await ask({ title: `Remove ${i.product_name}?`, body: 'This is recorded in the order history.', confirm: 'Remove', tone: 'danger' })) removeItem.mutate(i.id);
                        }}
                        className="rounded-lg p-2 text-ink-3 hover:bg-danger-soft hover:text-danger"
                        aria-label={`Remove ${i.product_name}`}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {removed.length > 0 && (
                <div className="border-t border-line bg-surface-2 px-5 py-2.5 text-[13px] text-ink-3">
                  Removed: {removed.map((r) => `${r.product_name} (${r.qty_label})`).join(', ')}
                </div>
              )}
              {total != null && total > 0 && (
                <div className="flex items-center justify-between border-t border-line bg-surface-2 px-5 py-3 text-[14px]">
                  <span className="text-ink-3">Estimated value</span>
                  <span className="font-semibold tabular">{formatMoney(total)}</span>
                </div>
              )}
            </Card>
          </section>

          {/* History */}
          <section>
            <SectionTitle>History</SectionTitle>
            <Card className="p-4 sm:p-5">
              <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-line">
                {events.map((e) => (
                  <EventItem key={e.id} e={e} />
                ))}
              </ol>
              {canWrite && (
                <form
                  className="mt-5 flex gap-2"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    if (note.trim()) addNote.mutate(note.trim());
                  }}
                >
                  <Input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Add a note to the history…" aria-label="Add a note" />
                  <Button type="submit" disabled={!note.trim()} loading={addNote.isPending}>Add</Button>
                </form>
              )}
            </Card>
          </section>
        </div>

        <aside className="space-y-6">
          <section>
            <SectionTitle action={canWrite && !['completed', 'cancelled'].includes(o.status) && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setFulfilOpen(true)}>Edit</Button>}>
              {o.fulfilment_type === 'delivery' ? 'Delivery' : 'Collection'}
            </SectionTitle>
            <Card className="px-4 py-1.5">
              <dl className="divide-y divide-line">
                <KeyValue label="Type">{o.fulfilment_type === 'delivery' ? 'Delivery' : o.fulfilment_type === 'collection' ? 'Collection' : <span className="text-ochre">Not set</span>}</KeyValue>
                <KeyValue label="Date">{o.requested_date ? longDate(o.requested_date) : <span className="text-ochre">Not set</span>}</KeyValue>
                {o.time_window && <KeyValue label="Time">{o.time_window}</KeyValue>}
                {o.fulfilment_type === 'delivery' && <KeyValue label="Address">{o.delivery_address ?? <span className="text-danger">Missing</span>}</KeyValue>}
                {o.delivery_notes && <KeyValue label="Notes">{o.delivery_notes}</KeyValue>}
              </dl>
              {['ready', 'out_for_delivery'].includes(o.status) && canProduce && (
                <div className="border-t border-line py-3">
                  <Button full variant={o.customer_notified_at ? 'ghost' : 'secondary'} icon={<MessageCircle className="size-4" />} onClick={() => notified.mutate(!o.customer_notified_at)} loading={notified.isPending}>
                    {o.customer_notified_at ? `Customer notified ${timeAgo(o.customer_notified_at)}` : 'Mark customer notified'}
                  </Button>
                </div>
              )}
            </Card>
          </section>

          {data.replies?.length > 0 && !['completed', 'cancelled'].includes(o.status) && (
            <section>
              <SectionTitle>Suggested reply</SectionTitle>
              <Card className="p-4">
                <p className="rounded-2xl bg-field-soft px-3.5 py-2.5 text-[14.5px] text-field-soft-ink">{data.replies[0].body}</p>
                <div className="mt-3 flex gap-2">
                  {waLink(o.contact_phone ?? data.customer.phone, data.replies[0].body) && (
                    <a className="flex-1" href={waLink(o.contact_phone ?? data.customer.phone, data.replies[0].body)!} target="_blank" rel="noreferrer"><Button full size="sm" icon={<MessageCircle className="size-3.5" />}>Send on WhatsApp</Button></a>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(data.replies[0].body).catch(() => undefined); toast({ tone: 'success', title: 'Copied' }); }}>Copy</Button>
                </div>
                <p className="mt-2 text-[12px] text-ink-3">Nothing is sent automatically — you decide.</p>
              </Card>
            </section>
          )}

          <section>
            <SectionTitle>Customer</SectionTitle>
            <Card className="p-4">
              <Link to={`/customers/${o.customer_id}`} className="flex items-center gap-2 font-semibold hover:underline"><User className="size-4 text-ink-3" />{data.customer.name}</Link>
              {(o.contact_phone || data.customer.phone) && (
                <div className="mt-3 flex gap-2">
                  <a href={`tel:${o.contact_phone ?? data.customer.phone}`} className="flex-1"><Button full size="sm" icon={<Phone className="size-3.5" />}>Call</Button></a>
                  <a href={waLink(o.contact_phone ?? data.customer.phone) ?? '#'} target="_blank" rel="noreferrer" className="flex-1"><Button full size="sm" icon={<MessageCircle className="size-3.5" />}>WhatsApp</Button></a>
                </div>
              )}
              {data.customer.notes && <p className="mt-3 rounded-xl bg-ochre-soft px-3 py-2 text-[13.5px] text-ochre-soft-ink">{data.customer.notes}</p>}
            </Card>
          </section>

          {o.notes && (
            <section>
              <SectionTitle>Order notes</SectionTitle>
              <Card className="whitespace-pre-line p-4 text-[14.5px]">{o.notes}</Card>
            </section>
          )}

          {can('payments.write') || o.payment_status !== 'unpaid' ? (
            <section>
              <SectionTitle>Payment</SectionTitle>
              <Card className="space-y-3 p-4">
                {can('payments.write') ? (
                  <>
                    <Segmented full size="sm" value={o.payment_status} onChange={(v) => patch.mutate({ payment_status: v })} options={(['unpaid', 'pending', 'paid'] as const).map((v) => ({ value: v, label: PAYMENT_LABEL[v] }))} />
                    <AccountingRef value={o.accounting_ref} onSave={(v) => patch.mutate({ accounting_ref: v })} />
                  </>
                ) : (
                  <Badge tone={o.payment_status === 'paid' ? 'field' : 'neutral'}>{PAYMENT_LABEL[o.payment_status]}</Badge>
                )}
                <p className="text-[12px] text-ink-3">Invoicing stays in your accounting software.</p>
              </Card>
            </section>
          ) : null}

          {(messages.length > 0 || data.interpretations.length > 0) && (
            <section>
              <SectionTitle>Original message{messages.length === 1 ? '' : 's'}</SectionTitle>
              <Card className="p-4">
                <div className="space-y-2.5">
                  {messages.map((m) => (
                    <div key={m.id} className={cx('rounded-2xl px-3.5 py-2.5 text-[14px]', m.direction === 'out' ? 'ml-6 bg-field-soft text-field-soft-ink' : 'mr-6 bg-sunken text-ink')}>
                      <div className="mb-0.5 text-[11.5px] font-semibold opacity-70">{m.direction === 'out' ? 'Terram' : m.sender_name ?? 'Customer'} · {m.channel} · {dateTime(m.sent_at ?? m.received_at)}</div>
                      <div className="whitespace-pre-line">{m.channel === 'form' ? m.body.split('\n\n{')[0] : m.body}</div>
                    </div>
                  ))}
                </div>
                {data.interpretations.length > 0 && (
                  <button onClick={() => setShowRaw((v) => !v)} className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-2 hover:text-ink">
                    <Bot className="size-4" /> How this was understood <ChevronDown className={cx('size-3.5 transition', showRaw && 'rotate-180')} />
                  </button>
                )}
                {showRaw && (
                  <div className="mt-2 space-y-2">
                    {data.interpretations.map((i: any) => (
                      <div key={i.id} className="rounded-xl border border-line p-3 text-[12.5px]">
                        <div className="mb-1 flex flex-wrap gap-2">
                          <Badge size="sm" tone={i.engine === 'claude' ? 'ochre' : 'slate'}>{i.engine === 'claude' ? `Assistant (${i.model})` : 'Rules engine'}</Badge>
                          <Badge size="sm" tone={i.confidence === 'high' ? 'field' : i.confidence === 'medium' ? 'ochre' : 'danger'}>{i.confidence} confidence</Badge>
                          {i.intent && <Badge size="sm">{i.intent.replace('_', ' ')}</Badge>}
                        </div>
                        {i.error && <p className="text-danger">{i.error}</p>}
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11.5px] text-ink-2">{JSON.stringify(i.output, null, 1)}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </section>
          )}
        </aside>
      </div>

      <ItemEditor open={!!editing} onClose={() => setEditing(null)} initial={editing ? { product_id: editing.product_id, qty: editing.qty, preparation: editing.preparation, special_instructions: editing.special_instructions } : null} saving={saveItem.isPending} onSave={(d) => editing && saveItem.mutate({ itemId: editing.id, d })} title={editing?.product_name} />
      <ItemEditor open={adding} onClose={() => setAdding(false)} saving={saveItem.isPending} onSave={(d) => saveItem.mutate({ d })} title="Add item" />
      <FulfilmentSheet open={fulfilOpen} onClose={() => setFulfilOpen(false)} order={o} saving={patch.isPending} onSave={(v) => patch.mutate(v)} />
    </div>
  );
}

function AccountingRef({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(value ?? '');
  return (
    <Field label="Accounting reference" optional>
      <Input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== (value ?? '') && onSave(v || null)} placeholder="e.g. INV-2041" />
    </Field>
  );
}

function EventItem({ e }: { e: OrderEvent }) {
  const icon =
    e.type === 'created' ? <CircleDot className="size-3" /> : e.type.startsWith('item') || e.type === 'amendment_applied' ? <Pencil className="size-3" /> : e.type === 'status_changed' ? <Check className="size-3" /> : e.type === 'note' ? <MessageCircle className="size-3" /> : <CircleDot className="size-3" />;
  const amended = e.type === 'item_amended' || e.type === 'amendment_applied';
  return (
    <li className="relative flex gap-3 pl-0">
      <span className={cx('relative z-[1] mt-0.5 flex size-[23px] shrink-0 items-center justify-center rounded-full border-2 border-surface', amended ? 'bg-ochre text-white' : e.type === 'status_changed' ? 'bg-field text-white' : e.type.startsWith('exception') ? 'bg-brand text-white' : 'bg-line-strong text-ink-2')}>
        {icon}
      </span>
      <div className="min-w-0 flex-1 pb-0.5">
        <p className={cx('text-[14px] leading-snug', amended ? 'font-semibold text-ink' : 'text-ink')}>{e.summary}</p>
        {e.data?.before && e.data?.after && e.data.before.qty_label !== e.data.after.qty_label && (
          <p className="mt-1 inline-flex items-center gap-2 rounded-lg bg-sunken px-2 py-1 text-[13px]">
            <span className="text-ink-3 line-through">{e.data.before.qty_label}</span> → <span className="font-semibold">{e.data.after.qty_label}</span>
          </p>
        )}
        {e.data?.warning && <p className="mt-1 text-[12.5px] font-medium text-ochre">{e.data.warning}</p>}
        {e.message_body && <p className="mt-1 rounded-xl bg-sunken px-3 py-1.5 text-[13px] text-ink-2">“{e.message_body}”{e.message_sender ? ` — ${e.message_sender}` : ''}</p>}
        <p className="mt-0.5 text-[12px] text-ink-3">
          {e.actor_name ?? (e.actor_kind === 'customer' ? 'Customer' : 'Terram OS')} · {dateTime(e.created_at)}
        </p>
      </div>
    </li>
  );
}

function FulfilmentSheet({ open, onClose, order, onSave, saving }: { open: boolean; onClose: () => void; order: OrderSummary; onSave: (v: any) => void; saving: boolean }) {
  const [type, setType] = useState(order.fulfilment_type ?? 'collection');
  const [date, setDate] = useState(order.requested_date ?? '');
  const [time, setTime] = useState(order.time_window ?? '');
  const [address, setAddress] = useState(order.delivery_address ?? '');
  const [notes, setNotes] = useState(order.delivery_notes ?? '');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Collection or delivery"
      footer={<Button variant="primary" size="lg" full loading={saving} onClick={() => onSave({ fulfilment_type: type, requested_date: date || null, time_window: time || null, delivery_address: type === 'delivery' ? address || null : order.delivery_address, delivery_notes: notes || null })}>Save</Button>}
    >
      <div className="space-y-5">
        <Segmented full size="lg" value={type} onChange={setType} options={[{ value: 'collection', label: 'Collection' }, { value: 'delivery', label: 'Delivery' }]} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Time" optional><Input value={time} onChange={(e) => setTime(e.target.value)} placeholder="e.g. after 2pm" /></Field>
        </div>
        {date && <p className="-mt-2 text-[13px] text-ink-3">{friendlyDate(date, todayYmd(), { long: true })}</p>}
        {type === 'delivery' && (
          <>
            <Field label="Delivery address"><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
            <Field label="Delivery notes" optional><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Gate code, call on arrival…" /></Field>
          </>
        )}
        {type === 'collection' && <Field label="Notes" optional><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>}
      </div>
    </Sheet>
  );
}


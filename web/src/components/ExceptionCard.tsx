import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CircleHelp, Info, MessageCircle, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatQty, timeAgo } from '../lib/format';
import type { ExceptionAction, ExceptionRow, Qty } from '../lib/types';
import { ItemEditor } from './ItemEditor';
import { CustomerPicker } from './pickers';
import { QuantityInput } from './quantity-input';
import { Badge, Button, Card, cx, Field, Input, Sheet, useToast } from './ui';

const TYPE_LABEL: Record<string, string> = {
  unknown_product: 'Unknown product',
  missing_quantity: 'Quantity needed',
  possible_amendment: 'Possible amendment',
  ambiguous_reference: 'Which item?',
  possible_duplicate: 'Possible duplicate',
  cancellation_request: 'Cancellation request',
  ambiguous_customer: 'Which customer?',
  unclear_date: 'Unclear date',
  customer_question: 'Customer question',
  special_request: 'Special request',
  contradiction: 'Conflicting amounts',
  unmatched_message: 'Unclear message',
  amendment_no_order: 'Change without an order',
  ai_failure: 'Could not read message',
  import_failure: 'Import problem',
  integration_failure: 'Integration problem',
};

function describeChange(c: any): string {
  if (c.op === 'set_qty') return `${c.label}: ${formatQty(c.from)} → ${formatQty(c.to)}`;
  if (c.op === 'add') return `Add ${c.item?.product_name ?? c.item?.phrase}${c.item?.qty ? ` — ${formatQty(c.item.qty)}` : ''}`;
  if (c.op === 'remove') return `Remove ${c.label}`;
  if (c.op === 'set_fulfilment') return `Update ${Object.entries(c.fulfilment).map(([k, v]) => `${k === 'date' ? 'date' : k === 'type' ? 'collection/delivery' : k}: ${v}`).join(', ')}`;
  return '';
}

/**
 * One decision, in plain language: what happened, what we think, and the buttons.
 * Staff never need to understand how the interpretation works.
 */
export function ExceptionCard({ e, compact }: { e: ExceptionRow; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sheet, setSheet] = useState<null | ExceptionAction>(null);
  const [qty, setQty] = useState<Qty | null>(e.payload?.qty ?? null);
  const [date, setDate] = useState('');
  const [name, setName] = useState(e.payload?.name ?? '');
  const act = useMutation({
    mutationFn: (body: any) => api.post(`/api/exceptions/${e.id}/actions`, body),
    onSuccess: (_r: any, body: any) => {
      setSheet(null);
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['order'] });
      toast({ tone: 'success', title: body.action === 'ask_customer' ? 'Marked as waiting on the customer' : body.action === 'dismiss' ? 'Dismissed' : 'Done' });
    },
    onError: (err: any) => toast({ tone: 'error', title: err.message }),
  });
  const p = e.payload ?? {};
  const waiting = !!p.waiting_on_customer;
  const Icon = e.severity === 'blocking' ? AlertTriangle : e.type === 'customer_question' ? CircleHelp : Info;
  const run = (a: ExceptionAction) => {
    if (a.needs) setSheet(a);
    else act.mutate({ action: a.key });
  };

  return (
    <Card className={cx('overflow-hidden', e.severity === 'blocking' && e.status === 'open' && 'border-brand/25')}>
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className={cx('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl', e.severity === 'blocking' ? 'bg-brand-soft text-brand' : e.severity === 'warning' ? 'bg-ochre-soft text-ochre' : 'bg-slate-soft text-slate')}>
            <Icon className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">{TYPE_LABEL[e.type] ?? e.type}</span>
              {waiting && <Badge tone="slate" size="sm">Waiting on customer</Badge>}
              {e.status !== 'open' && <Badge tone="field" size="sm">{e.status === 'resolved' ? 'Resolved' : 'Dismissed'}</Badge>}
            </div>
            <h3 className="mt-0.5 text-[16px] font-semibold leading-snug text-ink">{e.title}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
              {e.order_number && !compact && (
                <Link to={`/orders/${e.order_id}`} className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                  Order #{e.order_number} {e.customer_name ? `· ${e.customer_name}` : ''} <ArrowRight className="size-3" />
                </Link>
              )}
              <span>{timeAgo(e.created_at)}</span>
            </div>
          </div>
        </div>

        {/* Evidence */}
        <div className="mt-4 space-y-3 sm:pl-12">
          {(p.message_text || e.message_body || e.detail) && e.type !== 'possible_duplicate' && (
            <div className="flex gap-2.5 rounded-xl bg-sunken px-3.5 py-2.5">
              <MessageCircle className="mt-0.5 size-4 shrink-0 text-ink-3" />
              <p className="whitespace-pre-line text-[14.5px] text-ink">{p.message_text ? `“${p.message_text}”` : e.detail}</p>
            </div>
          )}
          {e.type === 'possible_amendment' && Array.isArray(p.changes) && (
            <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-3">
              <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">Suggested change</div>
              <ul className="mt-1.5 space-y-1">
                {p.changes.map((c: any, i: number) => (
                  <li key={i} className="text-[16px] font-semibold text-ink">{describeChange(c)}</li>
                ))}
              </ul>
            </div>
          )}
          {e.type === 'contradiction' && p.pending_replacement && (
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-line px-3 py-2.5"><div className="text-[12px] text-ink-3">First message</div><div className="text-[16px] font-semibold">{p.qty ? formatQty(p.qty) : '—'}</div></div>
              <div className="rounded-xl border border-brand/30 bg-brand-soft px-3 py-2.5"><div className="text-[12px] text-brand-soft-ink">Later message</div><div className="text-[16px] font-semibold text-brand-soft-ink">{formatQty(p.pending_replacement.qty)}</div></div>
            </div>
          )}
          {e.type === 'possible_duplicate' && p.duplicate_of && (
            <p className="text-[14px] text-ink-2">
              {e.detail} Compare with{' '}
              <Link to={`/orders/${p.duplicate_of.order_id}`} className="font-medium text-brand underline">order #{p.duplicate_of.order_number}</Link>.
            </p>
          )}
          {e.type === 'unknown_product' && p.ai_suggestion && (
            <div className="flex items-center gap-2 text-[13.5px] text-ink-2">
              <Sparkles className="size-4 text-ochre" /> The assistant thinks this might be <strong className="text-ink">{p.ai_suggestion.name}</strong> — please check.
            </div>
          )}
          {waiting && p.question && <p className="text-[13.5px] text-ink-3">Asked: “{p.question}”</p>}
          {e.status !== 'open' && e.resolution && <p className="text-[13.5px] text-ink-3">Outcome: {e.resolution}</p>}
        </div>

        {/* Quick picks for unknown products */}
        {e.status === 'open' && (e.type === 'unknown_product' || e.type === 'ambiguous_reference') && (
          <div className="mt-4 flex flex-wrap gap-2 sm:pl-12">
            {[p.ai_suggestion, ...(p.suggestions ?? [])].filter(Boolean).filter((s: any, i: number, arr: any[]) => arr.findIndex((x) => x.product_id === s.product_id) === i).slice(0, 4).map((s: any) => (
              <Button key={s.product_id} size="sm" variant="subtle" disabled={act.isPending} onClick={() => (p.qty ? act.mutate({ action: e.type === 'unknown_product' ? 'map_product' : 'choose_reference', product_id: s.product_id, preparation: s.preparation, qty: p.qty }) : setSheet({ key: 'map_product', label: 'Choose product', tone: 'primary', needs: 'product', ...{ preset: s.product_id } } as any))}>
                {s.name.replace(/ \(last:.*\)$/, '')}
                {p.qty ? ` · ${formatQty(p.qty)}` : ''}
              </Button>
            ))}
            {e.type === 'ambiguous_reference' && (p.options ?? []).map((o: any) => (
              <Button key={o.item_id} size="sm" variant="subtle" disabled={act.isPending} onClick={() => act.mutate({ action: 'choose_reference', item_id: o.item_id, qty: p.qty })}>
                {o.label.split(' — ')[0]} → {p.qty ? formatQty(p.qty) : '?'}
              </Button>
            ))}
          </div>
        )}
      </div>
      {e.status === 'open' && (
        <div className="flex flex-wrap gap-2 border-t border-line bg-surface-2 px-4 py-3 sm:px-5 sm:pl-[68px]">
          {e.actions.map((a) => (
            <Button key={a.key} size="md" variant={a.tone === 'primary' ? 'primary' : a.tone === 'danger' ? 'danger' : 'secondary'} onClick={() => run(a)} disabled={act.isPending} className="flex-1 sm:flex-none">
              {a.label}
            </Button>
          ))}
        </div>
      )}

      {/* Input sheets */}
      <ItemEditor
        open={sheet?.needs === 'product'}
        onClose={() => setSheet(null)}
        title="Add to order"
        phrase={p.phrase || p.source_text}
        initial={{ product_id: (sheet as any)?.preset ?? p.product_id ?? undefined, qty: p.qty ?? undefined, preparation: p.preparation ?? {}, special_instructions: p.special_instructions ?? null }}
        saving={act.isPending}
        onSave={(d) => act.mutate({ action: sheet?.key === 'choose_reference' ? 'choose_reference' : 'map_product', product_id: d.product_id, qty: d.qty, preparation: d.preparation, remember: true })}
      />
      <Sheet open={sheet?.needs === 'qty'} onClose={() => setSheet(null)} title="Set the quantity" subtitle={p.source_text ? `Customer wrote: “${p.source_text}”` : undefined} footer={<Button variant="primary" size="lg" full disabled={!qty} loading={act.isPending} onClick={() => act.mutate({ action: 'set_quantity', qty })}>Save quantity</Button>}>
        <QuantityInput value={qty} onChange={setQty} quantityType="either" allowsPortions pieceNoun="piece" />
      </Sheet>
      <Sheet open={sheet?.needs === 'item'} onClose={() => setSheet(null)} title="Which item should change?">
        <div className="space-y-2">
          {(p.options ?? []).map((o: any) => (
            <button key={o.item_id} onClick={() => act.mutate({ action: 'choose_reference', item_id: o.item_id, qty: p.qty })} className="w-full rounded-xl border border-line px-4 py-3 text-left hover:bg-surface-2">
              <div className="font-medium">{o.label}</div>
              {p.qty && <div className="text-[13px] text-ink-3">→ change to {formatQty(p.qty)}</div>}
            </button>
          ))}
        </div>
      </Sheet>
      <Sheet open={sheet?.needs === 'customer'} onClose={() => setSheet(null)} title="Which customer?">
        {(p.candidates ?? []).length > 0 && (
          <div className="mb-5 space-y-2">
            {p.candidates.map((c: any) => (
              <button key={c.id} onClick={() => act.mutate({ action: 'choose_customer', customer_id: c.id })} className="w-full rounded-xl border border-line px-4 py-3 text-left hover:bg-surface-2">
                <div className="font-medium">{c.name}</div>
                <div className="text-[13px] text-ink-3">{c.phone ?? 'No phone'}</div>
              </button>
            ))}
            <div className="pt-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">Or search</div>
          </div>
        )}
        <CustomerPicker onPick={(c) => act.mutate({ action: 'choose_customer', customer_id: c.id })} />
      </Sheet>
      <Sheet open={sheet?.needs === 'name'} onClose={() => setSheet(null)} title="New customer" footer={<Button variant="primary" size="lg" full loading={act.isPending} onClick={() => act.mutate({ action: 'keep_new_customer', name })}>Save</Button>}>
        <Field label="Customer name">
          <Input value={name} onChange={(ev) => setName(ev.target.value)} big />
        </Field>
      </Sheet>
      <Sheet open={sheet?.needs === 'date'} onClose={() => setSheet(null)} title="Set the date" footer={<Button variant="primary" size="lg" full disabled={!date} loading={act.isPending} onClick={() => act.mutate({ action: 'set_date', date })}>Save date</Button>}>
        <Field label="Collection / delivery date">
          <Input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} big />
        </Field>
      </Sheet>
    </Card>
  );
}

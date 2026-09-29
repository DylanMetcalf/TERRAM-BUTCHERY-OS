import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ClipboardPaste,
  EyeOff,
  History,
  MessageCircle,
  Pencil,
  RotateCcw,
  Sparkles,
  Store,
  Trash2,
  Truck,
  Undo2,
  UserRound,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ItemEditor } from '../components/ItemEditor';
import { CustomerPicker } from '../components/pickers';
import { Badge, Button, Callout, Card, cx, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Segmented, Sheet, Spinner, Textarea, useToast } from '../components/ui';
import { api, ApiError, newKey } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatQty, friendlyDate, timeAgo, todayYmd } from '../lib/format';

type DraftStatus = 'ready' | 'needs_review' | 'committed' | 'discarded';
interface StoredDraft {
  id: string;
  position: number;
  kind: 'order' | 'amendment' | 'cancellation' | 'ignored';
  status: DraftStatus;
  confidence: 'high' | 'medium' | 'low';
  order_id: string | null;
  order_number: number | null;
  data: any;
}
interface Batch {
  id: string;
  status: 'analysing' | 'review' | 'committed' | 'failed' | 'discarded';
  created_at: string;
  reference_date: string;
  stats: any;
  drafts: StoredDraft[];
  error: string | null;
}

const PLACEHOLDER = `Paste orders here — from WhatsApp, SMS or email. One order or a hundred.

John:
2kg mince
4 rumps
2 ribeye bone in
Collect Saturday

Sarah: 6 fillets and 1kg boerewors please`;

export default function ImportPage() {
  const { id } = useParams();
  return id ? <Review batchId={id} /> : <Paste />;
}

function Paste() {
  const navigate = useNavigate();
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem('terram:import-text') ?? '';
    } catch {
      return '';
    }
  });
  const [refDate, setRefDate] = useState(todayYmd());
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<{ id?: string; name: string; phone?: string } | null>(null);
  const [pickFrom, setPickFrom] = useState(false);
  const { data: history } = useQuery({ queryKey: ['imports'], queryFn: () => api.get<{ batches: any[] }>('/api/imports') });
  const analyse = useMutation({
    mutationFn: () => api.post<{ batch: Batch }>('/api/imports', { text, reference_date: refDate, customer: from ? { id: from.id, name: from.id ? undefined : from.name, phone: from.phone } : null }, { idempotencyKey: newKey() }),
    onSuccess: (r) => {
      try {
        sessionStorage.removeItem('terram:import-text');
      } catch {
        /* ignore */
      }
      navigate(`/import/${r.batch.id}`);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not read those messages.'),
  });
  const lines = text.split('\n').filter((l) => l.trim()).length;
  return (
    <div className="animate-rise">
      <PageHeader title="Paste orders" subtitle="We’ll separate the orders, match the products and show you what we understood before anything is saved." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <Card className="overflow-hidden">
            <Textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                try {
                  sessionStorage.setItem('terram:import-text', e.target.value);
                } catch {
                  /* ignore */
                }
              }}
              placeholder={PLACEHOLDER}
              className="min-h-[46vh] rounded-none border-0 px-5 py-4 font-mono text-[14px] leading-relaxed shadow-none focus:ring-0"
              aria-label="Messages to import"
              autoFocus
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2 px-4 py-2.5 text-[13.5px]">
              <span className="text-ink-2">From:</span>
              {from ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft py-1 pl-3 pr-1.5 font-medium text-brand-soft-ink">
                  {from.name}
                  <button onClick={() => setFrom(null)} className="rounded-full p-0.5 hover:bg-white/50" aria-label="Clear customer"><XCircle className="size-4" /></button>
                </span>
              ) : (
                <button onClick={() => setPickFrom(true)} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-line-strong px-3 py-1 font-medium text-ink-2 hover:border-brand hover:text-brand">
                  <UserRound className="size-3.5" /> Names are in the messages — or choose a customer
                </button>
              )}
            </div>
            <div className="flex flex-col gap-3 border-t border-line bg-surface-2 px-4 py-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2 text-[13px] text-ink-2">
                <span>Messages sent</span>
                <Input type="date" value={refDate} onChange={(e) => setRefDate(e.target.value)} className="h-9 w-40" aria-label="Date the messages were sent" />
              </div>
              <div className="flex items-center gap-2 sm:ml-auto">
                {text && <Button variant="ghost" onClick={() => setText('')}>Clear</Button>}
                <Button
                  variant="secondary"
                  icon={<ClipboardPaste className="size-4" />}
                  onClick={async () => {
                    try {
                      const t = await navigator.clipboard.readText();
                      if (t) setText((s) => (s ? s + '\n\n' : '') + t);
                    } catch {
                      setError('Your browser blocked pasting — long-press in the box and choose Paste.');
                    }
                  }}
                >
                  Paste
                </Button>
                <Button variant="primary" size="lg" disabled={!text.trim()} loading={analyse.isPending} onClick={() => analyse.mutate()} iconRight={<ArrowRight className="size-4" />}>
                  Read messages
                </Button>
              </div>
            </div>
          </Card>
          {analyse.isPending && (
            <p className="mt-3 flex items-center gap-2 text-[14px] text-ink-2">
              <Spinner className="size-4" /> Reading {lines} lines… messy messages can take a few seconds.
            </p>
          )}
          {error && <p className="mt-3 rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink">{error}</p>}
          <Sheet open={pickFrom} onClose={() => setPickFrom(false)} title="Who are these orders from?" subtitle="Use this when you copied a message without the sender’s name.">
            <CustomerPicker
              onPick={(c) => { setFrom({ id: c.id, name: c.name }); setPickFrom(false); }}
              onCreate={(name) => { if (name.trim()) { setFrom({ name: name.trim() }); setPickFrom(false); } }}
            />
          </Sheet>
        </div>
        <aside className="space-y-4">
          <Card className="p-5">
            <h3 className="font-semibold">Tips</h3>
            <ul className="mt-2 space-y-2 text-[14px] text-ink-2">
              <li>Start each order with the customer’s name, e.g. <b>John:</b> — or choose the customer under “From”.</li>
              <li>On iPhone: in WhatsApp, press and hold a message → <b>Copy</b> (or tap More… to select several), then tap <b>Paste</b> here.</li>
              <li>A WhatsApp “Export chat” works too — paste its text.</li>
              <li>Changes like <i>“actually make the mince 3kg”</i> update the order instead of creating a new one.</li>
              <li>Nothing is saved until you confirm.</li>
            </ul>
          </Card>
          {history?.batches?.length ? (
            <Card className="p-2">
              <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3"><History className="size-3.5" /> Recent imports</div>
              {history.batches.slice(0, 6).map((b) => (
                <Link key={b.id} to={`/import/${b.id}`} className="flex items-center justify-between rounded-xl px-3 py-2.5 text-[14px] hover:bg-sunken">
                  <span>
                    <span className="font-medium">{b.stats?.orders ?? 0} orders</span>
                    <span className="text-ink-3"> · {timeAgo(b.created_at)}</span>
                  </span>
                  <Badge size="sm" tone={b.status === 'committed' ? 'field' : b.status === 'review' ? 'ochre' : 'neutral'}>{b.status === 'committed' ? 'Done' : b.status === 'review' ? 'Not confirmed' : b.status}</Badge>
                </Link>
              ))}
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Review({ batchId }: { batchId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'review' | 'ready' | 'other'>('all');
  const [result, setResult] = useState<any>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['import', batchId], queryFn: () => api.get<{ batch: Batch }>(`/api/imports/${batchId}`) });
  const edit = useMutation({
    mutationFn: (v: { draftId: string; body: any }) => api.post<{ batch: Batch }>(`/api/imports/${batchId}/drafts/${v.draftId}`, v.body),
    onSuccess: (r) => qc.setQueryData(['import', batchId], r),
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'That change did not work.' }),
  });
  const [commitKey] = useState(newKey);
  const commit = useMutation({
    mutationFn: (sendRest: boolean) => api.post<{ result: any; batch: Batch }>(`/api/imports/${batchId}/commit`, { send_rest_to_exceptions: sendRest }, { idempotencyKey: commitKey }),
    onSuccess: (r) => {
      qc.setQueryData(['import', batchId], { batch: r.batch });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      setResult(r.result);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not confirm the import.' }),
  });

  const drafts = data?.batch.drafts ?? [];
  const live = drafts.filter((d) => d.status !== 'discarded');
  const actionable = live.filter((d) => !(d.kind === 'ignored' && !d.data.attention));
  const ready = actionable.filter((d) => d.status === 'ready');
  const review = actionable.filter((d) => d.status === 'needs_review');
  const ignored = drafts.filter((d) => d.kind === 'ignored' && !d.data.attention);
  const discarded = drafts.filter((d) => d.status === 'discarded');
  const shown = useMemo(() => {
    const base = drafts.filter((d) => !(d.kind === 'ignored' && !d.data.attention) && d.status !== 'discarded');
    if (filter === 'review') return base.filter((d) => d.status === 'needs_review');
    if (filter === 'ready') return base.filter((d) => d.status === 'ready');
    if (filter === 'other') return [...ignored, ...discarded];
    return base;
  }, [drafts, filter, ignored, discarded]);

  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <LoadingBlock rows={5} />;
  const b = data.batch;
  const committed = b.status === 'committed';
  const readyOrders = ready.filter((d) => d.kind === 'order').length;
  const readyChanges = ready.filter((d) => d.kind !== 'order').length;

  return (
    <div className="animate-rise pb-28">
      <PageHeader
        eyebrow={<Link to="/import" className="hover:underline">← Paste more messages</Link>}
        title={committed ? 'Import confirmed' : 'Check what we understood'}
        subtitle={`${b.stats.messages ?? 0} messages · imported ${timeAgo(b.created_at)}`}
      />

      {result && (
        <Card className="mb-6 animate-rise border-field/30 p-5">
          <div className="flex items-start gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-field text-white"><CheckCircle2 className="size-6 animate-pop" /></span>
            <div className="flex-1">
              <h2 className="font-display text-xl font-semibold">{result.created.length} order{result.created.length === 1 ? '' : 's'} created{result.amended.length ? `, ${result.amended.length} updated` : ''}</h2>
              <p className="mt-1 text-[15px] text-ink-2">
                {result.exceptions ? `${result.exceptions} question${result.exceptions === 1 ? '' : 's'} sent to Needs attention. ` : 'Nothing needs attention. '}
                {result.skipped ? `${result.skipped} skipped. ` : ''}
                {result.failed?.length ? `${result.failed.length} could not be saved — see below.` : ''}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {result.exceptions > 0 && <Link to="/exceptions"><Button variant="primary">Go to Needs attention</Button></Link>}
                <Link to="/orders?view=open"><Button>See orders</Button></Link>
                <Link to="/cutting"><Button variant="ghost">Cutting sheet</Button></Link>
              </div>
            </div>
          </div>
        </Card>
      )}

      {!committed && (
        <div className="mb-5 grid grid-cols-3 gap-3">
          <SummaryTile n={ready.length} label="Ready" tone="field" active={filter === 'ready'} onClick={() => setFilter(filter === 'ready' ? 'all' : 'ready')} />
          <SummaryTile n={review.length} label="Need a look" tone="ochre" active={filter === 'review'} onClick={() => setFilter(filter === 'review' ? 'all' : 'review')} />
          <SummaryTile n={ignored.length + discarded.length} label="Ignored" tone="neutral" active={filter === 'other'} onClick={() => setFilter(filter === 'other' ? 'all' : 'other')} />
        </div>
      )}

      {!committed && review.length > 0 && filter !== 'ready' && (
        <Callout tone="ochre" icon={<CircleHelp className="size-5" />} className="mb-5">
          Fix what you can below. Anything still unclear when you confirm goes to <b>Needs attention</b> — the rest are saved straight away.
        </Callout>
      )}

      <div className="space-y-3">
        {shown.map((d) => (
          <DraftCard key={d.id} d={d} committed={committed || d.status === 'committed'} busy={edit.isPending} onEdit={(body) => edit.mutate({ draftId: d.id, body })} canCancel={can('orders.cancel')} />
        ))}
        {!shown.length && <EmptyState title="Nothing here" icon={<Check className="size-6" />}>Choose another filter above.</EmptyState>}
      </div>

      {!committed && (
        <div className="safe-bottom fixed inset-x-0 bottom-[68px] z-20 border-t border-line bg-surface/95 backdrop-blur lg:bottom-0 lg:left-[256px]">
          <div className="mx-auto flex max-w-[1280px] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:px-6 lg:px-8">
            <p className="flex-1 text-[14px] text-ink-2">
              <b className="text-ink">{readyOrders} order{readyOrders === 1 ? '' : 's'}</b>
              {readyChanges ? ` and ${readyChanges} change${readyChanges === 1 ? '' : 's'}` : ''} ready
              {review.length ? ` · ${review.length} will go to Needs attention` : ''}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => navigate('/import')}>Later</Button>
              <Button variant="primary" size="lg" className="flex-1 sm:flex-none" disabled={!actionable.length} loading={commit.isPending} onClick={() => commit.mutate(true)} icon={<Check className="size-5" />}>
                Confirm {actionable.length === ready.length ? 'all' : `${ready.length + review.length}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({ n, label, tone, active, onClick }: { n: number; label: string; tone: 'field' | 'ochre' | 'neutral'; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx('rounded-2xl border p-4 text-left transition', active ? 'border-ink bg-surface shadow-float' : 'border-line bg-surface shadow-card hover:border-line-strong')}>
      <div className={cx('font-display text-[34px] font-semibold leading-none tabular', tone === 'field' ? 'text-field' : tone === 'ochre' ? 'text-ochre' : 'text-ink-3')}>{n}</div>
      <div className="mt-1 text-[14px] font-medium text-ink-2">{label}</div>
    </button>
  );
}

const CONF = {
  high: { label: 'Looks right', tone: 'field' as const },
  medium: { label: 'Worth a check', tone: 'ochre' as const },
  low: { label: 'Needs you', tone: 'danger' as const },
};

function DraftCard({ d, onEdit, busy, committed, canCancel }: { d: StoredDraft; onEdit: (body: any) => void; busy: boolean; committed: boolean; canCancel: boolean }) {
  const [showMsgs, setShowMsgs] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [custOpen, setCustOpen] = useState(false);
  const [fulOpen, setFulOpen] = useState(false);
  const x = d.data;
  const issues: any[] = x.issues ?? [];
  const itemIssues = (key: string) => issues.filter((i) => i.item_key === key);
  const general = issues.filter((i) => !i.item_key);
  const discarded = d.status === 'discarded';
  const today = todayYmd();

  if (d.kind === 'ignored') {
    return (
      <Card className={cx('flex items-start gap-3 p-4', !x.attention && 'bg-surface-2 shadow-none')}>
        <span className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', x.attention ? 'bg-slate-soft text-slate' : 'bg-sunken text-ink-3')}>{x.attention ? <CircleHelp className="size-4" /> : <EyeOff className="size-4" />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">
            {x.customer?.name ?? 'Unknown sender'} {x.attention ? (x.intent === 'question' ? 'asked a question' : 'sent something unclear') : <span className="font-normal text-ink-3">— no action needed</span>}
          </div>
          <p className="mt-0.5 text-[14px] text-ink-2">“{x.messages?.[0]?.text}”</p>
          {x.attention && !committed && <p className="mt-1 text-[12.5px] text-ink-3">Will go to Needs attention so someone can reply.</p>}
        </div>
      </Card>
    );
  }

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-semibold tabular text-ink-3">#{d.position + 1}</span>
      {d.status === 'committed' ? (
        <Badge tone="field" size="sm">{x.result ?? 'Saved'}{d.order_number ? ` · #${d.order_number}` : ''}</Badge>
      ) : discarded ? (
        <Badge size="sm">Won’t be imported</Badge>
      ) : (
        <Badge tone={CONF[d.confidence].tone} size="sm" dot>{CONF[d.confidence].label}</Badge>
      )}
      {x.messages?.some((m: any) => m.engine === 'claude') && <Badge tone="ochre" size="sm"><Sparkles className="size-3" />Assistant</Badge>}
    </div>
  );

  const messages = (
    <div className="border-t border-line">
      <button onClick={() => setShowMsgs((v) => !v)} className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2 sm:px-5">
        <MessageCircle className="size-4" /> {x.messages?.length === 1 ? 'Original message' : `${x.messages?.length} original messages`}
        <ChevronDown className={cx('ml-auto size-4 transition', showMsgs && 'rotate-180')} />
      </button>
      {showMsgs && (
        <div className="space-y-2 px-4 pb-4 sm:px-5">
          {x.messages.map((m: any) => (
            <div key={m.index} className={cx('whitespace-pre-line rounded-2xl px-3.5 py-2 text-[14px]', m.direction === 'out' ? 'ml-8 bg-field-soft text-field-soft-ink' : 'mr-8 bg-sunken')}>
              <span className="mb-0.5 block text-[11.5px] font-semibold opacity-70">{m.direction === 'out' ? 'Terram' : m.sender ?? 'Unknown'} · {m.intent.replace('_', ' ')}</span>
              {m.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (d.kind === 'amendment' || d.kind === 'cancellation') {
    const t = x.target;
    return (
      <Card className={cx('overflow-hidden', discarded && 'opacity-60')}>
        <div className="p-4 sm:p-5">
          {header}
          <h3 className="mt-2 text-[17px] font-semibold">
            {d.kind === 'cancellation' ? 'Cancellation request' : 'Change to an existing order'} · {x.customer?.customer_name ?? x.customer?.name}
            {t && <Link to={`/orders/${t.order_id}`} className="ml-2 text-[14px] font-medium text-brand hover:underline">#{t.order_number}</Link>}
          </h3>
          {d.kind === 'amendment' && x.changes?.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {x.changes.map((c: any, i: number) => (
                <li key={i} className="flex items-center gap-3 rounded-xl bg-ochre-soft px-3.5 py-2.5 text-ochre-soft-ink">
                  <span className="flex-1 text-[15.5px] font-semibold">
                    {c.op === 'set_qty' ? (<>{c.label}: <span className="line-through opacity-60">{formatQty(c.from)}</span> → {formatQty(c.to)}</>) : c.op === 'add' ? `Add ${c.item.product_name ?? `“${c.item.phrase}”`}${c.item.qty ? ` — ${formatQty(c.item.qty)}` : ''}` : c.op === 'remove' ? `Remove ${c.label}` : `Update ${Object.entries(c.fulfilment).map(([k, v]) => `${k}: ${v}`).join(', ')}`}
                  </span>
                  {!committed && !discarded && <button onClick={() => onEdit({ action: 'remove_change', index: i })} className="rounded-lg p-1.5 hover:bg-white/40" aria-label="Don’t apply this change"><XCircle className="size-4" /></button>}
                </li>
              ))}
            </ul>
          )}
          {x.reference && !committed && (
            <div className="mt-3">
              <p className="text-[14px] text-ink-2">“{x.reference.source_text}” — which item{x.reference.qty ? ` should become ${formatQty(x.reference.qty)}` : ''}?</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {x.reference.options.map((o: any) => (
                  <Button key={o.item_id} size="sm" variant="subtle" disabled={busy} onClick={() => onEdit({ action: 'choose_reference', item_id: o.item_id })}>{o.label}</Button>
                ))}
              </div>
            </div>
          )}
          {general.filter((i) => i.code !== 'ambiguous_reference').map((i, k) => (
            <p key={k} className={cx('mt-3 text-[14px]', i.severity === 'blocking' ? 'text-brand' : 'text-ochre')}>{i.message}</p>
          ))}
          {!committed && (
            <div className="mt-4 flex flex-wrap gap-2">
              {d.kind === 'cancellation' && t && !x.approved && canCancel && <Button variant="danger" size="sm" disabled={busy} onClick={() => onEdit({ action: 'approve_cancel' })}>Cancel order #{t.order_number}</Button>}
              {discarded ? (
                <Button size="sm" icon={<Undo2 className="size-4" />} onClick={() => onEdit({ action: 'restore' })}>Restore</Button>
              ) : (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => onEdit({ action: 'discard' })}>{d.kind === 'cancellation' ? 'Keep the order' : 'Don’t apply'}</Button>
              )}
            </div>
          )}
        </div>
        {messages}
      </Card>
    );
  }

  // Order draft
  const c = x.customer ?? {};
  const f = x.fulfilment ?? {};
  return (
    <Card className={cx('overflow-hidden', discarded && 'opacity-60', d.status === 'needs_review' && !committed && 'border-ochre/40')}>
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {header}
            <button disabled={committed} onClick={() => setCustOpen(true)} className="mt-2 flex items-center gap-2 text-left">
              <span className="font-display text-[22px] font-semibold leading-tight">{c.customer_name ?? c.name ?? 'Who is this?'}</span>
              {!committed && <Pencil className="size-3.5 text-ink-3" />}
            </button>
            <div className="mt-0.5 text-[13px] text-ink-3">
              {c.match === 'matched' ? `Existing customer${c.via === 'phone' ? ' (matched by phone)' : ''}` : c.match === 'probable' ? `Matched “${c.name}” → ${c.customer_name} — tap to change` : c.match === 'new' ? `New customer${c.phone ? ` · ${c.phone}` : ''}` : c.match === 'ambiguous' ? 'More than one customer has this name' : 'No name found'}
            </div>
          </div>
          {!committed && (
            discarded ? (
              <Button size="sm" icon={<RotateCcw className="size-4" />} onClick={() => onEdit({ action: 'restore' })}>Restore</Button>
            ) : (
              <button onClick={() => onEdit({ action: 'discard' })} className="rounded-lg p-2 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Don’t import this"><Trash2 className="size-4" /></button>
            )
          )}
        </div>

        {/* Items */}
        <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
          {(x.items ?? []).map((it: any) => {
            const its = itemIssues(it.key).filter((i) => i.code !== 'unrecognised_words' && !(i.code === 'unknown_product' && !it.product_id));
            const blocking = its.some((i) => i.severity === 'blocking');
            return (
              <li key={it.key} className={cx('px-3.5 py-3', blocking && !committed && 'bg-brand-soft/50')}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    {it.product_id ? (
                      <div className="text-[15.5px] font-semibold">
                        {it.product_name}
                        {it.preparation_label && <span className="ml-2 text-[14px] font-medium text-brand">{it.preparation_label}</span>}
                      </div>
                    ) : (
                      <div className="text-[15.5px] font-semibold text-brand">“{it.phrase || it.source_text}” <span className="text-[13px] font-medium">— {it.reference ? 'which product?' : it.suggestions?.length > 1 ? 'which one?' : 'not recognised'}</span></div>
                    )}
                    {it.special_instructions && <div className="text-[13px] text-ink-2">Note: {it.special_instructions}</div>}
                    {it.history?.length > 0 && (
                      <div className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-ochre-soft px-2 py-0.5 text-[12.5px] font-medium text-ochre-soft-ink">
                        Amended: {it.history.map((h: any) => `${h.from ? formatQty(h.from) : '—'} → ${formatQty(h.to)}`).join(', ')}
                      </div>
                    )}
                    {its.map((i: any, k: number) => (
                      <p key={k} className={cx('mt-1 text-[13px]', i.severity === 'blocking' ? 'text-brand' : 'text-ochre')}>{i.message}</p>
                    ))}
                  </div>
                  <div className="shrink-0 text-right font-display text-[18px] font-semibold tabular">{it.qty ? it.qty_label ?? formatQty(it.qty) : <span className="text-[14px] text-brand">?</span>}</div>
                  {!committed && !discarded && (
                    <button onClick={() => setEditing(it)} className="-mr-1 rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Edit line"><Pencil className="size-4" /></button>
                  )}
                </div>
                {!committed && !discarded && !it.product_id && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[it.ai_suggestion, ...(it.suggestions ?? [])].filter(Boolean).filter((s: any, i: number, a: any[]) => a.findIndex((z) => z.product_id === s.product_id) === i).slice(0, 4).map((s: any) => (
                      <Button key={s.product_id} size="sm" variant="subtle" disabled={busy} onClick={() => onEdit({ action: 'set_item', item_key: it.key, product_id: s.product_id, preparation: s.preparation })} icon={s === it.ai_suggestion ? <Sparkles className="size-3.5 text-ochre" /> : undefined}>
                        {s.name.replace(/ \(last:.*\)$/, '')}
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => setEditing(it)}>Other…</Button>
                    <Button size="sm" variant="ghost" onClick={() => onEdit({ action: 'remove_item', item_key: it.key })}>Leave out</Button>
                  </div>
                )}
                {!committed && !discarded && it.pending_replacement && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => onEdit({ action: 'resolve_contradiction', item_key: it.key, choice: 'replace' })}>Use {formatQty(it.pending_replacement.qty)}</Button>
                    <Button size="sm" disabled={busy} onClick={() => onEdit({ action: 'resolve_contradiction', item_key: it.key, choice: 'keep' })}>Keep {it.qty ? formatQty(it.qty) : ''}</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEdit({ action: 'resolve_contradiction', item_key: it.key, choice: 'add_both' })}>Add both</Button>
                  </div>
                )}
              </li>
            );
          })}
          {!committed && !discarded && (
            <li>
              <button onClick={() => setEditing({ key: null })} className="w-full px-3.5 py-2.5 text-left text-[14px] font-medium text-brand hover:bg-brand-soft/40">+ Add a product</button>
            </li>
          )}
        </ul>

        {/* Fulfilment */}
        <button disabled={committed || discarded} onClick={() => setFulOpen(true)} className="mt-3 flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-1 py-1 text-left text-[14px] text-ink-2 hover:bg-surface-2">
          <span className="inline-flex items-center gap-1.5">{f.type === 'delivery' ? <Truck className="size-4 text-ink-3" /> : <Store className="size-4 text-ink-3" />}{f.type === 'delivery' ? 'Delivery' : f.type === 'collection' ? 'Collection' : <span className="text-ochre">Collection or delivery?</span>}</span>
          <span>{f.date ? friendlyDate(f.date, today, { long: true }) : <span className="text-ochre">No date</span>}{f.time_window ? ` · ${f.time_window}` : ''}</span>
          {f.address && <span className="truncate">{f.address}</span>}
          {!committed && <Pencil className="ml-auto size-3.5 text-ink-3" />}
        </button>
        {x.notes?.length > 0 && <p className="mt-2 text-[13.5px] text-ink-2">Notes: {x.notes.join(' · ')}</p>}
        {x.events?.length > 0 && (
          <ul className="mt-3 space-y-1">
            {x.events.map((e: any, i: number) => (
              <li key={i} className="text-[13px] font-medium text-ochre-soft-ink">↻ {e.summary}</li>
            ))}
          </ul>
        )}
        {/* General issues */}
        {!committed && general.filter((i) => !['no_date', 'combined_messages'].includes(i.code) || i.severity !== 'info').map((i: any, k: number) => (
          <div key={k} className={cx('mt-3 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-[13.5px]', i.severity === 'blocking' ? 'bg-brand-soft text-brand-soft-ink' : i.severity === 'warning' ? 'bg-ochre-soft text-ochre-soft-ink' : 'bg-sunken text-ink-2')}>
            <span className="flex-1">{i.message}</span>
            {(i.code === 'possible_duplicate' || i.code === 'duplicate_in_batch') && (
              <>
                <Button size="sm" variant="ghost" onClick={() => onEdit({ action: 'discard' })}>Skip it</Button>
                <Button size="sm" onClick={() => onEdit({ action: 'ack', code: i.code })}>Import anyway</Button>
              </>
            )}
            {i.code === 'probable_customer' && <Button size="sm" onClick={() => onEdit({ action: 'ack', code: i.code })}>That’s right</Button>}
            {(i.code === 'ambiguous_customer' || i.code === 'unknown_customer') && <Button size="sm" icon={<UserRound className="size-3.5" />} onClick={() => setCustOpen(true)}>Choose</Button>}
            {i.code === 'cancellation' && (
              <>
                <Button size="sm" onClick={() => onEdit({ action: 'pending_cancellation', choice: 'discard_order' })}>Don’t import</Button>
                <Button size="sm" variant="ghost" onClick={() => onEdit({ action: 'pending_cancellation', choice: 'keep_order' })}>Import anyway</Button>
              </>
            )}
            {i.code === 'past_date' && <Button size="sm" onClick={() => setFulOpen(true)}>Change date</Button>}
          </div>
        ))}
      </div>
      {messages}

      <ItemEditor
        open={!!editing}
        onClose={() => setEditing(null)}
        phrase={editing?.phrase || undefined}
        initial={editing?.key ? { product_id: editing.product_id ?? undefined, qty: editing.qty ?? undefined, preparation: editing.preparation ?? {}, special_instructions: editing.special_instructions } : null}
        onSave={(item) => {
          if (editing?.key) onEdit({ action: 'set_item', item_key: editing.key, ...item });
          else onEdit({ action: 'add_item', ...item });
          setEditing(null);
        }}
      />
      <Sheet open={custOpen} onClose={() => setCustOpen(false)} title="Who is this order for?" subtitle={c.name ? `The message was from “${c.name}”` : undefined}>
        {c.candidates?.length > 0 && (
          <div className="mb-5 space-y-2">
            {c.candidates.map((cand: any) => (
              <button key={cand.id} onClick={() => { onEdit({ action: 'set_customer', customer_id: cand.id }); setCustOpen(false); }} className="w-full rounded-xl border border-line px-4 py-3 text-left hover:bg-surface-2">
                <div className="font-medium">{cand.name}</div>
                <div className="text-[13px] text-ink-3">{cand.phone ?? 'No phone'}</div>
              </button>
            ))}
          </div>
        )}
        <CustomerPicker
          onPick={(cu) => { onEdit({ action: 'set_customer', customer_id: cu.id }); setCustOpen(false); }}
          onCreate={(name) => { onEdit({ action: 'new_customer', name: name || c.name || 'New customer', phone: c.phone }); setCustOpen(false); }}
        />
      </Sheet>
      <FulfilmentEdit open={fulOpen} onClose={() => setFulOpen(false)} f={f} onSave={(v) => { onEdit({ action: 'set_fulfilment', ...v }); setFulOpen(false); }} />
    </Card>
  );
}

function FulfilmentEdit({ open, onClose, f, onSave }: { open: boolean; onClose: () => void; f: any; onSave: (v: any) => void }) {
  const [type, setType] = useState(f.type ?? 'collection');
  const [date, setDate] = useState(f.date ?? '');
  const [time, setTime] = useState(f.time_window ?? '');
  const [address, setAddress] = useState(f.address ?? '');
  return (
    <Sheet open={open} onClose={onClose} title="Collection or delivery" footer={<Button variant="primary" size="lg" full onClick={() => onSave({ type, date: date || null, time_window: time || null, address: address || null })}>Save</Button>}>
      <div className="space-y-4">
        <Segmented full size="lg" value={type} onChange={setType} options={[{ value: 'collection', label: 'Collection' }, { value: 'delivery', label: 'Delivery' }]} />
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Time" optional><Input value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        {type === 'delivery' && <Field label="Address"><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>}
      </div>
    </Sheet>
  );
}

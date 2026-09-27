import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, ArrowRight, Bot, Check, CheckCircle2, CircleAlert, Gauge, Lightbulb, MessageSquare, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Callout, Card, cx, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, SectionTitle, Segmented, Textarea, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';

export default function Intelligence() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const tab = params.get('tab') ?? 'overview';
  const tabs = [
    { value: 'overview', label: 'Overview' },
    { value: 'learning', label: 'Learning' },
    { value: 'log', label: 'Message log' },
    ...(can('system.health') ? [{ value: 'health', label: 'System health' }] : []),
    ...(can('import.run') ? [{ value: 'test', label: 'Try a message' }] : []),
  ];
  return (
    <div className="animate-rise">
      <PageHeader eyebrow="Terram Operations Intelligence" title="Intelligence" subtitle="What the system is noticing. It suggests and flags — people decide." />
      <div className="-mx-4 mb-6 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0">
        <Segmented value={tab} onChange={(t) => setParams({ tab: t })} options={tabs} />
      </div>
      {tab === 'overview' && <Overview />}
      {tab === 'learning' && <Learning />}
      {tab === 'log' && <Log />}
      {tab === 'health' && <Health />}
      {tab === 'test' && <TryMessage />}
    </div>
  );
}

function useIntel() {
  return useQuery({ queryKey: ['intelligence'], queryFn: () => api.get<any>('/api/intelligence') });
}

function Overview() {
  const { data, isLoading, error, refetch } = useIntel();
  if (error) return <ErrorState error={error} retry={refetch} />;
  if (isLoading || !data) return <LoadingBlock />;
  const s = data.stats;
  return (
    <div className="space-y-8">
      {!data.ai.available && (
        <Callout tone="slate" icon={<Bot className="size-5" />} title="Rules engine only">
          {data.ai.configured ? 'The message assistant is turned off in Settings.' : 'No assistant key is configured. Clear messages are still understood by the rules engine; messy ones go to Needs attention.'}
        </Callout>
      )}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Orders (30 days)" value={s.orders_30d} />
        <Stat label="Needed clarification" value={`${s.clarification_rate}%`} hint="Lower is better" />
        <Stat label="Were amended" value={`${s.amendment_rate}%`} />
        <Stat label="Read without the assistant" value={`${s.rules_only_share}%`} hint={`${s.assistant_messages_30d} of ${s.messages_30d} messages used it`} />
      </section>

      <section>
        <SectionTitle>Findings · {data.findings.length}</SectionTitle>
        {data.findings.length ? (
          <Card className="divide-y divide-line">
            {data.findings.map((f: any) => (
              <div key={f.id} className="flex items-start gap-3 px-4 py-3.5">
                <span className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', f.severity === 'attention' ? 'bg-brand-soft text-brand' : f.severity === 'warning' ? 'bg-ochre-soft text-ochre' : 'bg-slate-soft text-slate')}>
                  {f.severity === 'attention' ? <CircleAlert className="size-4" /> : f.module.includes('Improvement') ? <Lightbulb className="size-4" /> : <Activity className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">{f.module}</div>
                  <div className="font-medium">{f.title}</div>
                  <div className="text-[13.5px] text-ink-2">{f.detail}</div>
                </div>
                {f.link && <Link to={f.link}><Button size="sm" variant="ghost" iconRight={<ArrowRight className="size-3.5" />}>Open</Button></Link>}
              </div>
            ))}
          </Card>
        ) : (
          <EmptyState icon={<CheckCircle2 className="size-6" />} tone="field" title="Nothing to report">No stalled orders, gaps or recurring problems right now.</EmptyState>
        )}
      </section>

      {data.stages.length > 0 && (
        <section>
          <SectionTitle>Average time in each stage (30 days)</SectionTitle>
          <Card className="p-4">
            <div className="space-y-2.5">
              {data.stages.map((st: any) => {
                const max = Math.max(...data.stages.map((x: any) => x.avg_hours), 1);
                return (
                  <div key={st.status} className="flex items-center gap-3 text-[14px]">
                    <span className="w-36 shrink-0 text-ink-2">{st.label}</span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full bg-brand/70" style={{ width: `${(st.avg_hours / max) * 100}%` }} /></span>
                    <span className="w-20 shrink-0 text-right font-medium tabular">{st.avg_hours < 1 ? `${Math.round(st.avg_hours * 60)} min` : `${st.avg_hours} h`}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </section>
      )}

      <section>
        <SectionTitle>Specialist modules</SectionTitle>
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {data.modules.map((m: any) => (
            <Card key={m.key} className="p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{m.name}</span>
                <Badge size="sm" dot tone={m.status === 'attention' ? 'ochre' : 'field'}>{m.status === 'attention' ? 'Needs a look' : 'Running'}</Badge>
              </div>
              <p className="mt-1 text-[13.5px] text-ink-2">{m.role}</p>
              {m.note && <p className="mt-2 text-[12.5px] text-ink-3">{m.note}</p>}
            </Card>
          ))}
        </div>
        <p className="mt-4 flex items-start gap-2 text-[13px] text-ink-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" /> These modules can analyse, flag and suggest. They cannot delete or cancel orders, change prices, products, permissions or accounting information — those always need a person.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="font-display text-[30px] font-semibold leading-none tabular">{value}</div>
      <div className="mt-1.5 text-[14px] font-medium">{label}</div>
      {hint && <div className="text-[12.5px] text-ink-3">{hint}</div>}
    </Card>
  );
}

function Learning() {
  const { data, isLoading } = useIntel();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) => api.post(`/api/intelligence/suggestions/${v.id}`, { decision: v.decision }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['intelligence'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      toast({ tone: 'success', title: v.decision === 'approved' ? 'Added to the product dictionary' : 'Suggestion dismissed' });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' }),
  });
  if (isLoading || !data) return <LoadingBlock />;
  return (
    <div className="space-y-6">
      <Callout tone="slate" icon={<Lightbulb className="size-5" />} title="How learning works">
        When staff keep matching the same unknown wording to the same product, it’s suggested here. Nothing changes until someone approves it — one accidental correction never retrains the system.
        <div className="mt-2 font-medium">Observed → Suggested → Reviewed → Approved → Applied</div>
      </Callout>
      {data.suggestions.length ? (
        <div className="space-y-3">
          {data.suggestions.map((s: any) => (
            <Card key={s.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <Sparkles className="hidden size-5 shrink-0 text-ochre sm:block" />
              <div className="flex-1">
                <div className="font-semibold">{s.title}</div>
                <div className="text-[13.5px] text-ink-2">{s.detail}</div>
              </div>
              {can('intelligence.approve') && (
                <div className="flex gap-2">
                  <Button icon={<X className="size-4" />} onClick={() => decide.mutate({ id: s.id, decision: 'rejected' })} disabled={decide.isPending}>No</Button>
                  <Button variant="primary" icon={<Check className="size-4" />} onClick={() => decide.mutate({ id: s.id, decision: 'approved' })} disabled={decide.isPending}>Approve</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState icon={<Lightbulb className="size-6" />} title="No suggestions yet">When the same correction is made more than once, it will show up here for approval.</EmptyState>
      )}
    </div>
  );
}

function Log() {
  const { data, isLoading } = useQuery({ queryKey: ['intelligence', 'log'], queryFn: () => api.get<{ interpretations: any[] }>('/api/intelligence/interpretations') });
  if (isLoading || !data) return <LoadingBlock />;
  if (!data.interpretations.length) return <EmptyState icon={<MessageSquare className="size-6" />} title="No messages read yet">Imported and received messages will be logged here with what was understood.</EmptyState>;
  return (
    <Card className="divide-y divide-line">
      {data.interpretations.map((i) => (
        <details key={i.id} className="group px-4 py-3">
          <summary className="flex cursor-pointer list-none items-start gap-3">
            <Badge size="sm" tone={i.engine === 'claude' ? 'ochre' : 'slate'}>{i.engine === 'claude' ? 'Assistant' : 'Rules'}</Badge>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px]">{i.raw_input}</div>
              <div className="text-[12.5px] text-ink-3">
                {i.sender_name ?? 'Unknown'} · {i.intent?.replace('_', ' ')} · {i.confidence} confidence{i.order_number ? ` · order #${i.order_number}` : ''} · {timeAgo(i.created_at)}
                {i.error ? ` · ${i.error}` : ''}
              </div>
            </div>
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-sunken p-3 text-[12px] text-ink-2">{JSON.stringify(i.output, null, 2)}</pre>
        </details>
      ))}
    </Card>
  );
}

function Health() {
  const { data, isLoading } = useQuery({ queryKey: ['intelligence', 'health'], queryFn: () => api.get<any>('/api/intelligence/health'), refetchInterval: 30_000 });
  if (isLoading || !data) return <LoadingBlock />;
  return (
    <div className="space-y-6">
      <Card className="flex items-center gap-4 p-5">
        <span className={cx('flex size-12 items-center justify-center rounded-2xl', data.status === 'healthy' ? 'bg-field-soft text-field' : data.status === 'attention' ? 'bg-ochre-soft text-ochre' : 'bg-danger-soft text-danger')}>
          {data.status === 'healthy' ? <CheckCircle2 className="size-6" /> : <AlertTriangle className="size-6" />}
        </span>
        <div>
          <div className="font-display text-xl font-semibold">{data.status === 'healthy' ? 'All systems healthy' : data.status === 'attention' ? 'Mostly fine — a few things to check' : 'There is a problem'}</div>
          <div className="text-[13.5px] text-ink-3">Database {(data.database_size_bytes / 1024 / 1024).toFixed(1)} MB · up {Math.round(data.uptime_seconds / 3600)}h · v{data.version}</div>
        </div>
      </Card>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {data.checks.map((c: any) => (
          <Card key={c.key} className="flex items-start gap-3 p-4">
            {c.ok ? <CheckCircle2 className="mt-0.5 size-5 text-field" /> : <AlertTriangle className="mt-0.5 size-5 text-ochre" />}
            <div><div className="font-medium">{c.label}</div><div className="text-[13.5px] text-ink-2">{c.detail}</div></div>
          </Card>
        ))}
      </div>
      <section>
        <SectionTitle>Recent technical events</SectionTitle>
        {data.events.length ? (
          <Card className="divide-y divide-line">
            {data.events.slice(0, 40).map((e: any) => (
              <details key={e.id} className="px-4 py-2.5">
                <summary className="flex cursor-pointer list-none items-center gap-3 text-[14px]">
                  <Badge size="sm" tone={e.level === 'error' ? 'danger' : e.level === 'warning' ? 'ochre' : 'neutral'}>{e.level}</Badge>
                  <span className="text-ink-3">{e.component}</span>
                  <span className="flex-1 truncate">{e.message}</span>
                  <span className="shrink-0 text-[12px] text-ink-3">{dateTime(e.created_at)}</span>
                </summary>
                {e.detail && <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-sunken p-2 text-[11.5px]">{e.detail}</pre>}
              </details>
            ))}
          </Card>
        ) : (
          <EmptyState icon={<Gauge className="size-6" />} title="No events">Nothing has gone wrong.</EmptyState>
        )}
      </section>
    </div>
  );
}

function TryMessage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<any>(null);
  const send = useMutation({
    mutationFn: () => api.post<any>('/api/integrations/simulate', { from_name: name || undefined, from_phone: phone || undefined, body }),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries();
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Failed.' }),
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="space-y-4 p-5">
        <div>
          <h3 className="font-semibold">Send a test WhatsApp message</h3>
          <p className="text-[13.5px] text-ink-2">Goes through exactly the same path a real WhatsApp Business message would. Orders it creates are real (status “To review”).</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From (name)"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="John Smith" /></Field>
          <Field label="Phone" optional><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="082 555 1234" /></Field>
        </div>
        <Field label="Message"><Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Actually make that 3kg mince" /></Field>
        <div className="flex flex-wrap gap-2">
          {['Can I get 2kg mince and 4 rumps for Saturday?', 'Actually make that 3kg mince.', 'Thanks!', 'Please cancel my order'].map((t) => (
            <button key={t} onClick={() => setBody(t)} className="rounded-full border border-line px-3 py-1 text-[12.5px] text-ink-2 hover:bg-sunken">{t}</button>
          ))}
        </div>
        <Button variant="primary" disabled={!body.trim()} loading={send.isPending} onClick={() => send.mutate()}>Send test message</Button>
      </Card>
      <Card className="p-5">
        <h3 className="font-semibold">What happened</h3>
        {result ? (
          <dl className="mt-3 space-y-2 text-[14.5px]">
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Understood as</dt><dd className="font-medium">{result.intent?.replace('_', ' ') ?? '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Action</dt><dd className="text-right font-medium">{result.action}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Sent to Needs attention</dt><dd className="font-medium">{result.exceptions}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Suggested reply</dt><dd className="text-right font-medium">{result.reply_suggestion ?? <span className="text-ink-3">Stay quiet</span>}</dd></div>
            {result.order_id && <Link to={`/orders/${result.order_id}`}><Button className="mt-3" iconRight={<ArrowRight className="size-4" />}>Open the order</Button></Link>}
          </dl>
        ) : (
          <p className="mt-3 text-[14px] text-ink-3">Send a message to see how it’s handled.</p>
        )}
      </Card>
    </div>
  );
}

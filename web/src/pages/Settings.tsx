import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Database, Download, FlaskConical, KeyRound, Link2, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Callout, Card, cx, ErrorState, Field, Input, LoadingBlock, PageHeader, SectionTitle, Segmented, Select, Sheet, Switch, Textarea, useConfirm, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useCan, useMe } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';
import { ROLES, ROLE_DESCRIPTION, ROLE_LABEL, type Role } from '../../../shared/permissions';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Settings() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { value: 'business', label: 'Business' },
    { value: 'orders', label: 'Orders & fulfilment' },
    { value: 'form', label: 'Customer form' },
    { value: 'assistant', label: 'Assistant' },
    ...(can('users.manage') ? [{ value: 'team', label: 'Team' }] : []),
    ...(can('data.export') ? [{ value: 'data', label: 'Data & backup' }] : []),
    ...(can('settings.write') ? [{ value: 'test', label: 'Test mode' }] : []),
    { value: 'integrations', label: 'Integrations' },
    { value: 'audit', label: 'Audit log' },
  ];
  const tab = params.get('tab') ?? 'business';
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ settings: any; environment: any }>('/api/admin/settings') });
  return (
    <div className="animate-rise">
      <PageHeader title="Settings" subtitle={can('settings.write') ? 'Changes apply to everyone and are recorded in the audit log.' : 'Only admins can change settings.'} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 scrollbar-none lg:mx-0 lg:flex-col lg:px-0" aria-label="Settings sections">
          {tabs.map((t) => (
            <button key={t.value} onClick={() => setParams({ tab: t.value })} className={cx('shrink-0 rounded-xl px-3.5 py-2.5 text-left text-[14.5px] font-medium transition', tab === t.value ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:bg-surface/60')}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {error ? <ErrorState error={error} retry={refetch} /> : isLoading || !data ? <LoadingBlock /> : (
            <>
              {tab === 'business' && <Business s={data.settings} />}
              {tab === 'orders' && <OrdersSettings s={data.settings} />}
              {tab === 'form' && <FormSettings s={data.settings} />}
              {tab === 'assistant' && <Assistant s={data.settings} env={data.environment} />}
              {tab === 'team' && <Team />}
              {tab === 'data' && <DataBackup />}
              {tab === 'test' && <TestMode />}
              {tab === 'integrations' && <Integrations env={data.environment} />}
              {tab === 'audit' && <Audit />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function useSave(section: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: any) => api.put(`/api/admin/settings/${section}`, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      toast({ tone: 'success', title: 'Settings saved' });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' }),
  });
}

function Panel({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const can = useCan();
  return (
    <Card>
      <div className="border-b border-line px-5 py-4"><h2 className="font-display text-xl font-semibold">{title}</h2></div>
      <fieldset disabled={!can('settings.write')} className="space-y-5 p-5">{children}</fieldset>
      {footer && can('settings.write') && <div className="flex justify-end border-t border-line bg-surface-2 px-5 py-3">{footer}</div>}
    </Card>
  );
}

function Business({ s }: { s: any }) {
  const [v, setV] = useState(s.business);
  const save = useSave('business');
  return (
    <Panel title="Business details" footer={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(v)}>Save</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Tagline"><Input value={v.tagline} onChange={(e) => setV({ ...v, tagline: e.target.value })} /></Field>
        <Field label="Phone"><Input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
        <Field label="Email"><Input value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
      </div>
      <Field label="Address"><Textarea rows={2} value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Time zone" hint="Decides what “today” and “Saturday” mean."><Input value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })} /></Field>
        <Field label="Currency"><Select value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })}><option value="ZAR">South African Rand (R)</option><option value="GBP">Pound (£)</option><option value="EUR">Euro (€)</option><option value="USD">Dollar ($)</option></Select></Field>
      </div>
    </Panel>
  );
}

function DayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {DAYS.map((d, i) => (
        <button type="button" key={d} onClick={() => onChange(value.includes(i) ? value.filter((x) => x !== i) : [...value, i].sort())} className={cx('h-10 w-12 rounded-xl border text-[14px] font-medium transition', value.includes(i) ? 'border-brand bg-brand text-brand-ink' : 'border-line-strong bg-surface text-ink-2')}>
          {d}
        </button>
      ))}
    </div>
  );
}

function OrdersSettings({ s }: { s: any }) {
  const [o, setO] = useState(s.orders);
  const [f, setF] = useState(s.fulfilment);
  const saveO = useSave('orders');
  const saveF = useSave('fulfilment');
  return (
    <div className="space-y-6">
      <Panel title="Order rules" footer={<Button variant="primary" loading={saveO.isPending} onClick={() => saveO.mutate(o)}>Save</Button>}>
        <Switch checked={o.formOrdersRequireReview} onChange={(x) => setO({ ...o, formOrdersRequireReview: x })} label="Online orders need review" description="Customer form orders arrive as “To review” before they are confirmed." />
        <Switch checked={o.autoReadyAfterPacking} onChange={(x) => setO({ ...o, autoReadyAfterPacking: x })} label="Packed means ready" description="Marking an order packed also marks it ready for collection/delivery." />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Minimum notice (days)" hint="For the customer form."><Input type="number" min={0} value={o.leadTimeDays} onChange={(e) => setO({ ...o, leadTimeDays: Number(e.target.value) })} /></Field>
          <Field label="Duplicate window (hours)"><Input type="number" min={1} value={o.duplicateWindowHours} onChange={(e) => setO({ ...o, duplicateWindowHours: Number(e.target.value) })} /></Field>
          <Field label="Flag stalled after (hours)"><Input type="number" min={1} value={o.stalledHours} onChange={(e) => setO({ ...o, stalledHours: Number(e.target.value) })} /></Field>
        </div>
      </Panel>
      <Panel title="Collection & delivery" footer={<Button variant="primary" loading={saveF.isPending} onClick={() => saveF.mutate(f)}>Save</Button>}>
        <Field label="Collection days"><DayPicker value={f.collectionDays} onChange={(v) => setF({ ...f, collectionDays: v })} /></Field>
        <Field label="Collection hours"><Input value={f.collectionHours} onChange={(e) => setF({ ...f, collectionHours: e.target.value })} /></Field>
        <Switch checked={f.deliveryEnabled} onChange={(x) => setF({ ...f, deliveryEnabled: x })} label="Offer delivery" />
        {f.deliveryEnabled && (
          <>
            <Field label="Delivery days"><DayPicker value={f.deliveryDays} onChange={(v) => setF({ ...f, deliveryDays: v })} /></Field>
            <Field label="Delivery note for customers"><Input value={f.deliveryNotes} onChange={(e) => setF({ ...f, deliveryNotes: e.target.value })} /></Field>
          </>
        )}
      </Panel>
    </div>
  );
}

function FormSettings({ s }: { s: any }) {
  const [v, setV] = useState(s.customerForm);
  const save = useSave('customerForm');
  const url = `${window.location.origin}/order`;
  return (
    <Panel title="Customer order form" footer={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(v)}>Save</Button>}>
      <Callout tone="slate" icon={<Link2 className="size-5" />} action={<a href="/order" target="_blank" rel="noreferrer"><Button size="sm">Open form</Button></a>}>
        Share this link with customers: <b className="break-all">{url}</b>
      </Callout>
      <Switch checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} label="Accept online orders" description="Turn off to pause the form (e.g. over holidays)." />
      <Switch checked={v.showPrices} onChange={(x) => setV({ ...v, showPrices: x })} label="Show prices" description="Shown as estimates — final price depends on weight." />
      <Field label="Welcome text"><Textarea rows={3} value={v.intro} onChange={(e) => setV({ ...v, intro: e.target.value })} /></Field>
      <Field label="Message after ordering" hint="Don’t promise the order is confirmed if you still review it."><Textarea rows={2} value={v.confirmationMessage} onChange={(e) => setV({ ...v, confirmationMessage: e.target.value })} /></Field>
    </Panel>
  );
}

function Assistant({ s, env }: { s: any; env: any }) {
  const [v, setV] = useState(s.ai);
  const save = useSave('ai');
  return (
    <Panel title="Message assistant" footer={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(v)}>Save</Button>}>
      <Callout tone={env.ai_key ? 'field' : 'ochre'} icon={<KeyRound className="size-5" />}>
        {env.ai_key ? 'An assistant key is configured on the server.' : 'No assistant key is configured. Set ANTHROPIC_API_KEY on the server to enable it. Everything else keeps working with the rules engine.'}
      </Callout>
      <p className="text-[14px] text-ink-2">The rules engine reads clear messages instantly and for free. The assistant is only asked about messages the rules can’t fully understand — and its answers are always checked against your product list before anything is saved.</p>
      <Switch checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} label="Use the assistant for messy messages" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model"><Select value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })}><option value="claude-opus-5">Claude Opus 5 (most accurate)</option><option value="claude-sonnet-5">Claude Sonnet 5 (balanced)</option><option value="claude-haiku-4-5">Claude Haiku 4.5 (fastest, cheapest)</option></Select></Field>
        <Field label="Effort" hint="Low is usually enough for order messages."><Segmented full value={v.effort} onChange={(x) => setV({ ...v, effort: x })} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} /></Field>
      </div>
      <Field label="Suggest a new product name after this many matching corrections" hint="The learning loop never changes products without approval.">
        <Input type="number" min={1} max={20} value={v.learningThreshold} onChange={(e) => setV({ ...v, learningThreshold: Number(e.target.value) })} className="w-28" />
      </Field>
    </Panel>
  );
}

function Team() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: any[] }>('/api/admin/users') });
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'staff' as Role, password: '', active: true });
  useEffect(() => {
    if (editing) setForm({ name: editing.name ?? '', email: editing.email ?? '', role: editing.role ?? 'staff', password: '', active: editing.active !== 0 });
  }, [editing]);
  const save = useMutation({
    mutationFn: () => (editing?.id ? api.patch(`/api/admin/users/${editing.id}`, { name: form.name, role: form.role, active: form.active, password: form.password || undefined }) : api.post('/api/admin/users', form)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast({ tone: 'success', title: 'Saved' });
      setEditing(null);
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save.' }),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold">Team</h2>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>Add person</Button>
      </div>
      <Card className="divide-y divide-line">
        {data?.users.map((u) => (
          <button key={u.id} onClick={() => setEditing(u)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{u.name} {u.id === me.user!.id && <span className="text-ink-3">(you)</span>}</div>
              <div className="text-[13px] text-ink-3">{u.email} · {u.last_login_at ? `last seen ${timeAgo(u.last_login_at)}` : 'never signed in'}</div>
            </div>
            <Badge tone={u.role === 'admin' ? 'brand' : u.role === 'manager' ? 'slate' : 'neutral'}>{ROLE_LABEL[u.role as Role]}</Badge>
            {!u.active && <Badge tone="danger">Disabled</Badge>}
          </button>
        ))}
      </Card>
      <Card className="p-4">
        <SectionTitle>What each role can do</SectionTitle>
        <ul className="space-y-1.5 text-[14px]">{ROLES.map((r) => <li key={r}><b>{ROLE_LABEL[r]}</b> — {ROLE_DESCRIPTION[r]}</li>)}</ul>
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-ink-3"><ShieldCheck className="size-3.5" /> Permissions are checked on the server for every action.</p>
      </Card>
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? editing.name : 'Add a person'} footer={<Button variant="primary" size="lg" full loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
        <div className="space-y-4">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          {!editing?.id && <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>}
          <Field label="Role">
            <div className="space-y-2">
              {ROLES.map((r) => (
                <button key={r} type="button" onClick={() => setForm({ ...form, role: r })} className={cx('flex w-full items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left', form.role === r ? 'border-brand bg-brand-soft' : 'border-line')}>
                  <span className={cx('mt-1 flex size-4 items-center justify-center rounded-full border-2', form.role === r ? 'border-brand bg-brand' : 'border-line-strong')}>{form.role === r && <Check className="size-2.5 text-white" strokeWidth={4} />}</span>
                  <span><span className="block font-medium">{ROLE_LABEL[r]}</span><span className="text-[13px] text-ink-2">{ROLE_DESCRIPTION[r]}</span></span>
                </button>
              ))}
            </div>
          </Field>
          <Field label={editing?.id ? 'New password' : 'Password'} optional={!!editing?.id} hint="At least 8 characters. Changing it signs the person out everywhere."><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></Field>
          {editing?.id && <Switch checked={form.active} onChange={(x) => setForm({ ...form, active: x })} label="Can sign in" />}
        </div>
      </Sheet>
    </div>
  );
}

function DataBackup() {
  const exports = [
    ['orders', 'Orders'],
    ['items', 'Order items'],
    ['customers', 'Customers'],
    ['products', 'Products & aliases'],
    ['messages', 'Original messages'],
    ['audit', 'Audit log'],
  ];
  return (
    <div className="space-y-6">
      <Panel title="Your data">
        <p className="text-[14.5px] text-ink-2">Terram owns all of its data. Download it at any time in open formats.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {exports.map(([k, l]) => (
            <a key={k} href={`/api/admin/export/${k}.csv`} className="flex items-center justify-between rounded-xl border border-line px-4 py-3 hover:bg-surface-2">
              <span className="font-medium">{l}</span><span className="inline-flex items-center gap-1 text-[13px] text-ink-3"><Download className="size-3.5" />CSV</span>
            </a>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <a href="/api/admin/export-all"><Button icon={<Download className="size-4" />}>Everything (JSON)</Button></a>
          <a href="/api/admin/backup"><Button variant="primary" icon={<Database className="size-4" />}>Download full backup</Button></a>
        </div>
      </Panel>
      <Card className="p-5 text-[14px] text-ink-2">
        <h3 className="font-semibold text-ink">Backups</h3>
        <p className="mt-1">The backup file is a complete copy of the database, taken safely while the system is running. To restore, stop the server and replace the database file with the backup (see the README). Automated nightly backups can be scheduled on the server with <code className="rounded bg-sunken px-1">npm run backup</code>.</p>
      </Card>
    </div>
  );
}

function TestMode() {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, node } = useConfirm();
  const { data } = useQuery({ queryKey: ['sample-data'], queryFn: () => api.get<any>('/api/admin/sample-data') });
  const run = useMutation({
    mutationFn: (action: 'load' | 'remove') => api.post<any>('/api/admin/sample-data', { action }),
    onSuccess: (_r, action) => {
      qc.invalidateQueries();
      toast({ tone: 'success', title: action === 'load' ? 'Sample data loaded' : 'Sample data removed' });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Failed.' }),
  });
  return (
    <Panel title="Test mode">
      {node}
      <Callout tone="slate" icon={<FlaskConical className="size-5" />}>
        Load realistic sample customers and orders to try everything — WhatsApp imports, amendments, unknown products, cutting, packing and fulfilment. Sample records are marked and can be removed without touching real orders.
      </Callout>
      <div className="flex flex-wrap items-center gap-3">
        {data?.loaded ? (
          <>
            <Badge tone="ochre">Sample data loaded · {data.orders} orders</Badge>
            <Button variant="danger" loading={run.isPending} onClick={async () => { if (await ask({ title: 'Remove sample data?', body: 'Only sample customers and orders are removed.', confirm: 'Remove', tone: 'danger' })) run.mutate('remove'); }}>Remove sample data</Button>
          </>
        ) : (
          <Button variant="primary" loading={run.isPending} onClick={() => run.mutate('load')}>Load sample data</Button>
        )}
      </div>
      <p className="text-[13.5px] text-ink-3">Try a single WhatsApp message end-to-end in Intelligence → Try a message.</p>
    </Panel>
  );
}

function Integrations({ env }: { env: any }) {
  const origin = window.location.origin;
  const rows = [
    { name: 'WhatsApp Business (Cloud API)', ok: env.whatsapp && env.whatsapp_secret, detail: env.whatsapp ? `Webhook URL: ${origin}/api/integrations/whatsapp/webhook` : 'Not connected. Set WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET on the server, then point the Meta webhook at the URL below.', url: `${origin}/api/integrations/whatsapp/webhook` },
    { name: 'Inbound email', ok: env.email_inbound, detail: env.email_inbound ? 'Forward order emails to your provider’s inbound webhook.' : 'Not connected. Set EMAIL_INBOUND_TOKEN on the server.', url: `${origin}/api/integrations/email/inbound` },
    { name: 'Customer order form', ok: true, detail: 'Live — orders flow straight into the order engine.', url: `${origin}/order` },
    { name: 'Accounting (Xero)', ok: false, detail: 'Payment status and accounting references are stored per order, ready for a future Xero connection.' },
    { name: 'Label printer & barcodes', ok: false, detail: 'Print layouts are ready; scanner support can be added later.' },
  ];
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <Card key={r.name} className="p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold">{r.name}</span>
            <Badge tone={r.ok ? 'field' : 'neutral'} dot>{r.ok ? 'Connected' : 'Not connected'}</Badge>
          </div>
          <p className="mt-1 text-[13.5px] text-ink-2">{r.detail}</p>
          {r.url && <code className="mt-2 block break-all rounded-lg bg-sunken px-2.5 py-1.5 text-[12px] text-ink-2">{r.url}</code>}
        </Card>
      ))}
      <p className="text-[13px] text-ink-3">Every channel feeds the same order engine. Personal WhatsApp accounts are never scraped.</p>
    </div>
  );
}

function Audit() {
  const { data, isLoading } = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ entries: any[] }>('/api/admin/audit') });
  if (isLoading || !data) return <LoadingBlock />;
  return (
    <Card className="divide-y divide-line">
      {data.entries.map((e) => (
        <div key={e.id} className="flex items-start gap-3 px-4 py-2.5 text-[14px]">
          <span className="w-28 shrink-0 text-[12.5px] text-ink-3">{dateTime(e.created_at)}</span>
          <span className="w-28 shrink-0 truncate font-medium">{e.user_name ?? (e.actor_kind === 'customer' ? 'Customer' : 'System')}</span>
          <span className="min-w-0 flex-1">{e.summary ?? e.action}</span>
        </div>
      ))}
      {!data.entries.length && <p className="px-4 py-8 text-center text-ink-3">Nothing recorded yet.</p>}
    </Card>
  );
}

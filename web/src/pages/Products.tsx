import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Beef, EyeOff, Plus, Search, Sparkles, Tags, Trash2, X } from 'lucide-react';
import { PriceImport } from '../components/PriceImport';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useProducts } from '../components/pickers';
import { Badge, Button, Callout, Card, cx, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, SectionTitle, Segmented, Select, Sheet, Switch, Textarea, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatMoney } from '../lib/format';
import type { Product } from '../lib/types';
import { normalise } from '../../../shared/text';


export default function Products() {
  const { data, isLoading, error, refetch } = useProducts();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'active' | 'all' | 'inactive'>('active');
  const openId = params.get('open');
  const [creating, setCreating] = useState(false);
  const [pricing, setPricing] = useState(false);
  const { data: intel } = useQuery({ queryKey: ['intelligence'], queryFn: () => api.get<any>('/api/intelligence'), enabled: can('intelligence.read') });
  const suggestions = intel?.suggestions?.length ?? 0;
  const products = useMemo(() => {
    const n = normalise(q);
    return (data?.products ?? []).filter((p) => (show === 'all' ? true : show === 'active' ? p.active : !p.active)).filter((p) => !n || normalise(p.canonical_name).includes(n) || p.aliases.some((a) => a.alias.includes(n)));
  }, [data, q, show]);
  const cats = [...new Set(products.map((p) => p.category))];
  const current = data?.products.find((p) => p.id === openId) ?? null;
  return (
    <div className="animate-rise">
      <PageHeader
        title="Products"
        subtitle="The dictionary everything is matched against. One product, many ways of saying it."
        actions={
          can('products.write') && (
            <>
              <Button icon={<Tags className="size-4" />} onClick={() => setPricing(true)}>Update prices</Button>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Add product</Button>
            </>
          )
        }
      />
      {suggestions > 0 && can('intelligence.approve') && (
        <Callout tone="ochre" icon={<Sparkles className="size-5" />} className="mb-5" action={<Link to="/intelligence"><Button size="sm">Review</Button></Link>}>
          {suggestions} new name{suggestions === 1 ? '' : 's'} learned from staff corrections — waiting for your approval.
        </Callout>
      )}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names and aliases" className="pl-9" aria-label="Search products" />
        </div>
        <Segmented value={show} onChange={setShow} options={[{ value: 'active', label: 'Available' }, { value: 'inactive', label: 'Unavailable' }, { value: 'all', label: 'All' }]} />
      </div>
      {error ? (
        <ErrorState error={error} retry={refetch} />
      ) : isLoading ? (
        <LoadingBlock />
      ) : !products.length ? (
        <EmptyState icon={<Beef className="size-6" />} title="No products found">Try another search.</EmptyState>
      ) : (
        <div className="space-y-7">
          {cats.map((cat) => (
            <section key={cat}>
              <SectionTitle>{cat}</SectionTitle>
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {products.filter((p) => p.category === cat).map((p) => (
                  <button key={p.id} onClick={() => setParams({ open: p.id })} className={cx('rounded-2xl border bg-surface p-4 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-float', p.active ? 'border-line' : 'border-dashed border-line-strong opacity-70')}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold">{p.canonical_name}</span>
                      <span className="shrink-0 text-[13px] font-medium text-ink-2">{p.price_cents != null ? `${formatMoney(p.price_cents)}/${p.price_unit}` : <span className="text-ochre">No price</span>}</span>
                    </div>
                    <div className="mt-1 line-clamp-1 text-[13px] text-ink-3">{p.aliases.filter((a) => a.alias !== normalise(p.canonical_name)).slice(0, 5).map((a) => a.alias).join(' · ')}</div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      <Badge size="sm">{p.quantity_type === 'weight' ? 'By weight' : p.quantity_type === 'count' ? `By ${p.piece_noun}` : 'Weight or pieces'}</Badge>
                      {p.allows_portions && <Badge size="sm">Packs</Badge>}
                      {!p.active && <Badge size="sm" tone="danger">Unavailable</Badge>}
                      {!p.customer_visible && <Badge size="sm" tone="slate"><EyeOff className="size-3" />Internal</Badge>}
                      {!!p.orders_90d && <Badge size="sm" tone="field">{p.orders_90d} order{p.orders_90d === 1 ? "" : "s"} · 90d</Badge>}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <PriceImport open={pricing} onClose={() => setPricing(false)} />
      <ProductEditor open={!!current || creating} product={current} onClose={() => { setCreating(false); setParams({}); }} readOnly={!can('products.write')} />
    </div>
  );
}

interface PrepRow { group_name: string; name: string; keywords: string; is_default: boolean; customer_visible: boolean; active: boolean }

function ProductEditor({ open, onClose, product, readOnly }: { open: boolean; onClose: () => void; product: Product | null; readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState<any>({});
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState('');
  const [preps, setPreps] = useState<PrepRow[]>([]);
  const { data: allProducts } = useProducts();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setAliasInput('');
    const p = product;
    setV({
      canonical_name: p?.canonical_name ?? '',
      customer_name: p?.customer_name ?? '',
      category: p?.category ?? allProducts?.products[0]?.category ?? 'Beef – Steaks',
      description: p?.description ?? '',
      quantity_type: p?.quantity_type ?? 'weight',
      allows_portions: p?.allows_portions ?? false,
      piece_noun: p?.piece_noun ?? 'piece',
      typical_piece_g: p?.typical_piece_g ?? '',
      min_count: p?.min_count ?? '',
      price: p?.price_cents != null ? (p.price_cents / 100).toFixed(2) : '',
      price_unit: p?.price_unit ?? 'kg',
      active: p?.active ?? true,
      customer_visible: p?.customer_visible ?? true,
      internal_notes: p?.internal_notes ?? '',
    });
    setAliases((p?.aliases ?? []).map((a) => a.alias).filter((a) => a !== normalise(p?.canonical_name ?? '')));
    setPreps((p?.preparations ?? []).map((o) => ({ group_name: o.group_name, name: o.name, keywords: o.keywords.join(', '), is_default: o.is_default, customer_visible: o.customer_visible, active: o.active })));
  }, [open, product]);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        canonical_name: v.canonical_name,
        customer_name: v.customer_name || null,
        category: v.category,
        description: v.description || null,
        quantity_type: v.quantity_type,
        allows_portions: v.allows_portions,
        piece_noun: v.piece_noun || 'piece',
        typical_piece_g: v.typical_piece_g ? Number(v.typical_piece_g) : null,
        min_count: v.min_count ? Number(v.min_count) : null,
        price_cents: v.price !== '' ? Math.round(Number(String(v.price).replace(',', '.')) * 100) : null,
        price_unit: v.price !== '' ? v.price_unit : null,
        active: v.active,
        customer_visible: v.customer_visible,
        internal_notes: v.internal_notes || null,
        aliases,
        preparations: preps.filter((p) => p.group_name.trim() && p.name.trim()).map((p) => ({ ...p, keywords: p.keywords.split(',').map((k) => k.trim()).filter(Boolean) })),
      };
      return product ? api.patch(`/api/products/${product.id}`, body) : api.post('/api/products', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] });
      toast({ tone: 'success', title: product ? 'Product updated' : 'Product added' });
      onClose();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const groups = [...new Set(preps.map((p) => p.group_name))];
  const addAlias = () => {
    const a = aliasInput.trim().toLowerCase();
    if (a && !aliases.includes(a)) setAliases([...aliases, a]);
    setAliasInput('');
  };
  const set = (k: string, val: any) => setV((s: any) => ({ ...s, [k]: val }));
  return (
    <Sheet open={open} onClose={onClose} width="lg" title={product ? product.canonical_name : 'New product'} subtitle={readOnly ? 'View only' : 'Changes are recorded in the audit log.'} footer={!readOnly && <Button variant="primary" size="lg" full loading={save.isPending} disabled={!v.canonical_name?.trim()} onClick={() => save.mutate()}>Save product</Button>}>
      <fieldset disabled={readOnly} className="space-y-7">
        <section className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name (used internally)"><Input value={v.canonical_name ?? ''} onChange={(e) => set('canonical_name', e.target.value)} /></Field>
            <Field label="Name customers see" optional><Input value={v.customer_name ?? ''} onChange={(e) => set('customer_name', e.target.value)} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select value={v.category} onChange={(e) => set('category', e.target.value)}>
                {[...new Set([...(allProducts?.products ?? []).map((x) => x.category), v.category].filter(Boolean))].map((c) => <option key={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Price" optional>
              <div className="flex gap-2">
                <Input inputMode="decimal" value={v.price ?? ''} onChange={(e) => set('price', e.target.value.replace(/[^\d.,]/g, ''))} placeholder="0.00" />
                <Select value={v.price_unit} onChange={(e) => set('price_unit', e.target.value)} className="w-32"><option value="kg">per kg</option><option value="each">each</option></Select>
              </div>
            </Field>
          </div>
          <Field label="Description for customers" optional><Textarea rows={2} value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
        </section>

        <section>
          <SectionTitle>How it’s ordered</SectionTitle>
          <div className="space-y-4">
            <Segmented full value={v.quantity_type} onChange={(x) => set('quantity_type', x)} options={[{ value: 'weight', label: 'By weight' }, { value: 'count', label: 'By piece' }, { value: 'either', label: 'Either' }]} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="A piece is called" hint="e.g. steak, chop, leg"><Input value={v.piece_noun ?? ''} onChange={(e) => set('piece_noun', e.target.value)} /></Field>
              <Field label="Typical piece weight (g)" optional hint="Helps estimate totals on the cutting sheet."><Input inputMode="numeric" value={v.typical_piece_g ?? ''} onChange={(e) => set('typical_piece_g', e.target.value.replace(/\D/g, ''))} /></Field>
              {v.quantity_type !== 'weight' && <Field label="Minimum order (pieces)" optional hint="e.g. 30 for eggs. The order form won’t go lower; pasted orders below it are flagged."><Input inputMode="numeric" value={v.min_count ?? ''} onChange={(e) => set('min_count', e.target.value.replace(/\D/g, ''))} /></Field>}
            </div>
            <Switch checked={!!v.allows_portions} onChange={(x) => set('allows_portions', x)} label="Can be ordered in packs" description="e.g. “6 × 500g”" />
          </div>
        </section>

        <section>
          <SectionTitle>Other names customers use</SectionTitle>
          <p className="-mt-1 mb-3 text-[13.5px] text-ink-3">Messages using these words are matched to this product automatically. Spelling, plurals and capitals don’t matter.</p>
          <div className="flex flex-wrap gap-1.5">
            {aliases.map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full bg-sunken py-1 pl-3 pr-1.5 text-[13.5px]">
                {a}
                {!readOnly && <button type="button" onClick={() => setAliases(aliases.filter((x) => x !== a))} className="rounded-full p-0.5 hover:bg-line" aria-label={`Remove ${a}`}><X className="size-3.5" /></button>}
              </span>
            ))}
          </div>
          {!readOnly && (
            <div className="mt-3 flex gap-2">
              <Input value={aliasInput} onChange={(e) => setAliasInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } }} placeholder="Add a name, e.g. “wors”" />
              <Button type="button" onClick={addAlias}>Add</Button>
            </div>
          )}
        </section>

        <section>
          <SectionTitle>Preparation options</SectionTitle>
          <p className="-mt-1 mb-3 text-[13.5px] text-ink-3">Only these options can be chosen for this product. Keywords let messages like “on the bone” pick the right one.</p>
          <div className="space-y-4">
            {groups.map((g) => (
              <Card key={g} className="p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Input value={g} onChange={(e) => setPreps(preps.map((p) => (p.group_name === g ? { ...p, group_name: e.target.value } : p)))} className="h-9 font-semibold" aria-label="Group name" />
                  {!readOnly && <Button type="button" size="sm" variant="ghost" onClick={() => setPreps(preps.filter((p) => p.group_name !== g))} aria-label="Remove group"><Trash2 className="size-4" /></Button>}
                </div>
                <div className="space-y-2">
                  {preps.map((p, i) => p.group_name === g && (
                    <div key={i} className="grid gap-2 rounded-xl bg-surface-2 p-2 sm:grid-cols-[1fr_1.4fr_auto]">
                      <Input value={p.name} onChange={(e) => setPreps(preps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Option" className="h-9" aria-label="Option name" />
                      <Input value={p.keywords} onChange={(e) => setPreps(preps.map((x, j) => (j === i ? { ...x, keywords: e.target.value } : x)))} placeholder="keywords, comma separated" className="h-9" aria-label="Keywords" />
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => setPreps(preps.map((x, j) => (x.group_name === g ? { ...x, is_default: j === i } : x)))} className={cx('h-9 rounded-lg px-2.5 text-[12.5px] font-medium', p.is_default ? 'bg-field-soft text-field-soft-ink' : 'text-ink-3 hover:bg-sunken')}>{p.is_default ? 'Default' : 'Make default'}</button>
                        <button type="button" onClick={() => setPreps(preps.map((x, j) => (j === i ? { ...x, customer_visible: !x.customer_visible } : x)))} className={cx('h-9 rounded-lg px-2 text-[12.5px]', p.customer_visible ? 'text-ink-3' : 'bg-slate-soft text-slate-soft-ink')} title="Visible on the customer order form">{p.customer_visible ? 'Public' : 'Internal'}</button>
                        {!readOnly && <button type="button" onClick={() => setPreps(preps.filter((_, j) => j !== i))} className="rounded-lg p-2 text-ink-3 hover:bg-sunken" aria-label="Remove option"><X className="size-4" /></button>}
                      </div>
                    </div>
                  ))}
                  {!readOnly && <button type="button" onClick={() => setPreps([...preps, { group_name: g, name: '', keywords: '', is_default: false, customer_visible: true, active: true }])} className="text-[13.5px] font-medium text-brand hover:underline">+ Add option</button>}
                </div>
              </Card>
            ))}
            {!readOnly && <Button type="button" icon={<Plus className="size-4" />} onClick={() => setPreps([...preps, { group_name: groups.includes('Preparation') ? `Group ${groups.length + 1}` : 'Preparation', name: '', keywords: '', is_default: true, customer_visible: true, active: true }])}>Add option group</Button>}
          </div>
        </section>

        <section className="space-y-1">
          <SectionTitle>Availability</SectionTitle>
          <Switch checked={!!v.active} onChange={(x) => set('active', x)} label="Available" description="Unavailable products can’t be added to new orders." />
          <Switch checked={!!v.customer_visible} onChange={(x) => set('customer_visible', x)} label="Show on the customer order form" />
          <Field label="Internal notes" optional className="pt-3"><Textarea rows={2} value={v.internal_notes ?? ''} onChange={(e) => set('internal_notes', e.target.value)} /></Field>
        </section>
        {err && <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink">{err}</p>}
      </fieldset>
    </Sheet>
  );
}

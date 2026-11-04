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
  const [variationOf, setVariationOf] = useState<Product | null>(null);
  const reviewOnly = params.get('review') === '1';
  const [pricing, setPricing] = useState(false);
  const { data: intel } = useQuery({ queryKey: ['intelligence'], queryFn: () => api.get<any>('/api/intelligence'), enabled: can('intelligence.read') });
  const suggestions = intel?.suggestions?.length ?? 0;
  const products = useMemo(() => {
    const n = normalise(q);
    return (data?.products ?? []).filter((p) => !reviewOnly || (!p.order_method_reviewed && (p.weight_ranges?.length ?? 0) > 0)).filter((p) => reviewOnly || (show === 'all' ? true : show === 'active' ? p.active : !p.active)).filter((p) => !n || normalise(p.canonical_name).includes(n) || p.aliases.some((a) => a.alias.includes(n)));
  }, [data, q, show, reviewOnly]);
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
      {reviewOnly && (
        <Callout tone="ochre" className="mb-5" action={<Button size="sm" onClick={() => setParams({})}>Show all</Button>}>
          Products whose ordering set-up was added automatically (e.g. steak weight choices). Open each one, check it, and save to mark it reviewed.
        </Callout>
      )}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names and aliases" className="pl-9" aria-label="Search products" />
        </div>
        <Segmented value={show} onChange={setShow} options={[{ value: 'active', label: 'In stock' }, { value: 'inactive', label: 'Out of stock' }, { value: 'all', label: 'All' }]} />
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
                      {!p.order_method_reviewed && (p.weight_ranges?.length ?? 0) > 0 && <Badge size="sm" tone="ochre">Check set-up</Badge>}
                      {p.variant_of && <Badge size="sm" tone="slate">Variation</Badge>}
                      {!p.active && <Badge size="sm" tone="danger">{p.customer_visible ? 'Out of stock' : 'Unavailable'}</Badge>}
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
      <ProductEditor open={!!current || creating} product={current} preset={variationOf} onAddVariation={(parent) => { setParams({}); setVariationOf(parent); setCreating(true); }} onClose={() => { setCreating(false); setVariationOf(null); setParams(reviewOnly ? { review: '1' } : {}); }} readOnly={!can('products.write')} />
    </div>
  );
}

/** Resize a photo in the browser so it stays small (max 640 px, JPEG). */
async function shrinkImage(file: File): Promise<string | null> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 640 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface PrepRow { group_name: string; name: string; keywords: string; is_default: boolean; customer_visible: boolean; active: boolean; surcharge_pct: number }
interface OptRow { id: string; label: string; kind: 'pack' | 'piece'; grams: string }
const slugId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)

const METHODS: { value: NonNullable<Product['order_method']>; label: string; hint: string }[] = [
  { value: 'packs', label: 'Fixed-weight packs', hint: 'e.g. mince in 500 g packets. Customers choose how many packs.' },
  { value: 'items_weighed', label: 'Counted, priced on weight', hint: 'e.g. steaks: customers choose how many and a preferred weight each.' },
  { value: 'items', label: 'Individual items', hint: 'Customers choose how many; fixed price each.' },
  { value: 'by_weight', label: 'By weight', hint: 'Customers enter the weight they want.' },
  { value: 'whole', label: 'Whole / sized pieces', hint: 'Customers pick a size, e.g. Whole or Half.' },
  { value: 'custom', label: 'Custom / on request', hint: 'Not ordered on the form; customers ask under Special requests.' },
];
interface RangeRow { id: string; label: string; min: string; max: string }

function ProductEditor({ open, onClose, product, readOnly, onAddVariation, preset }: { open: boolean; onClose: () => void; product: Product | null; readOnly: boolean; onAddVariation?: (parent: Product) => void; preset?: Product | null }) {
  const [ranges, setRanges] = useState<RangeRow[]>([]);
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState<any>({});
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState('');
  const [preps, setPreps] = useState<PrepRow[]>([]);
  const [opts, setOpts] = useState<OptRow[]>([]);
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
      pack_size: p?.pack_size ?? '',
      price: p?.price_cents != null ? (p.price_cents / 100).toFixed(2) : '',
      price_unit: p?.price_unit ?? 'kg',
      active: p?.active ?? true,
      customer_visible: p?.customer_visible ?? true,
      internal_notes: p?.internal_notes ?? '',
      min_qty: p?.min_qty ?? '',
      max_qty: p?.max_qty ?? '',
      variant_of: p?.variant_of ?? preset?.id ?? '',
      variant_label: p?.variant_label ?? '',
      ...(!p && preset ? { canonical_name: `${preset.canonical_name} – `, category: preset.category, price_unit: preset.price_unit ?? 'kg', quantity_type: preset.quantity_type, order_method: preset.order_method, piece_noun: preset.piece_noun } : {}),
      unavailable_reason: p?.unavailable_reason ?? '',
      order_method: p?.order_method ?? (p ? undefined : 'by_weight'),
      group_only: p?.group_only ?? false,
      image: p?.image ?? null,
    });
    setRanges((p?.weight_ranges ?? []).map((r) => ({ id: r.id, label: r.label, min: String(r.min_g), max: String(r.max_g) })));
    setOpts((p?.sale_options ?? []).map((o) => ({ id: o.id, label: o.label, kind: o.kind, grams: o.grams ? String(o.grams) : '' })));
    setAliases((p?.aliases ?? []).map((a) => a.alias).filter((a) => a !== normalise(p?.canonical_name ?? '')));
    setPreps((p?.preparations ?? []).map((o) => ({ group_name: o.group_name, name: o.name, keywords: o.keywords.join(', '), is_default: o.is_default, customer_visible: o.customer_visible, active: o.active, surcharge_pct: o.surcharge_pct ?? 0 })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product, preset]);
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
        pack_size: v.pack_size ? Number(v.pack_size) : null,
        price_cents: v.price !== '' ? Math.round(Number(String(v.price).replace(',', '.')) * 100) : null,
        price_unit: v.price !== '' ? v.price_unit : null,
        active: v.active,
        customer_visible: v.customer_visible,
        internal_notes: v.internal_notes || null,
        min_qty: v.min_qty ? Number(v.min_qty) : null,
        max_qty: v.max_qty ? Number(v.max_qty) : null,
        variant_of: v.variant_of || null,
        variant_label: v.variant_label?.trim() || null,
        unavailable_reason: v.unavailable_reason?.trim() || null,
        order_method: v.order_method || null,
        group_only: !!v.group_only,
        image: v.image ?? null,
        weight_ranges: ranges.filter((r) => r.min && r.max).map((r) => ({ id: r.id || `${r.min}-${r.max}`, label: r.label.trim() || `${r.min}–${r.max} g`, min_g: Number(r.min), max_g: Number(r.max) })),
        sale_options: opts.filter((o) => o.label.trim()).map((o, i, all) => {
          let id = o.id || slugId(o.label) || `opt_${i + 1}`;
          if (all.slice(0, i).some((x) => (x.id || slugId(x.label)) === id)) id = `${id}_${i + 1}`;
          return { id, label: o.label.trim(), kind: o.kind, grams: o.grams ? Number(o.grams) : null };
        }),
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
  const variations = product ? (allProducts?.products ?? []).filter((x) => x.variant_of === product.id) : [];
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
            <Field label="Category" htmlFor="product-category" hint="Pick one, or type a new one, e.g. “Vegetables” or “Vegetables – Leafy greens”. The part before the dash becomes a tab on the order form.">
              <Input id="product-category" list="product-categories" value={v.category ?? ''} onChange={(e) => set('category', e.target.value)} placeholder="e.g. Vegetables" />
              <datalist id="product-categories">
                {[...new Set([...(allProducts?.products ?? []).map((x) => x.category), 'Vegetables'].filter(Boolean))].map((c) => <option key={c} value={c} />)}
              </datalist>
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
          <SectionTitle>How customers order it</SectionTitle>
          {product && !product.order_method_reviewed && <p className="mb-3 rounded-xl bg-ochre-soft px-3 py-2 text-[13.5px] text-ochre-soft-ink">This was worked out automatically from the old setup. Check it, then save to mark it reviewed.</p>}
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Order method">
            {METHODS.map((m) => (
              <button key={m.value} type="button" role="radio" aria-checked={v.order_method === m.value} onClick={() => set('order_method', m.value)} className={cx('rounded-xl border px-3 py-2.5 text-left', v.order_method === m.value ? 'border-brand bg-brand-soft text-brand-soft-ink' : 'border-line-strong bg-surface')}>
                <div className="text-[14.5px] font-semibold">{m.label}</div>
                <div className="text-[12.5px] opacity-80">{m.hint}</div>
              </button>
            ))}
          </div>
          {(v.order_method === 'items_weighed' || v.order_method === 'items') && (
            <div className="mt-4">
              <div className="text-[14px] font-semibold">Preferred weight choices</div>
              <p className="mb-2 text-[13px] text-ink-3">Shown as choices per {v.piece_noun || 'piece'}, plus “Other / special request”. Leave empty for none. Estimates use the middle of the range.</p>
              <div className="space-y-2">
                {ranges.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-xl bg-surface-2 p-2 sm:grid-cols-[1.3fr_6rem_6rem_auto]">
                    <Input value={r.label} onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Label, e.g. 300–400 g" className="col-span-3 h-9 sm:col-span-1" aria-label="Label" />
                    <Input inputMode="numeric" value={r.min} onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, min: e.target.value.replace(/\D/g, '') } : x)))} placeholder="from g" className="h-9" aria-label="From grams" />
                    <Input inputMode="numeric" value={r.max} onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, max: e.target.value.replace(/\D/g, '') } : x)))} placeholder="to g" className="h-9" aria-label="To grams" />
                    {!readOnly && <button type="button" onClick={() => setRanges(ranges.filter((_, j) => j !== i))} className="rounded-lg p-2 text-ink-3 hover:bg-sunken" aria-label="Remove weight choice"><X className="size-4" /></button>}
                  </div>
                ))}
                {!readOnly && <button type="button" onClick={() => setRanges([...ranges, { id: '', label: '', min: '', max: '' }])} className="text-[13.5px] font-medium text-brand hover:underline">+ Add weight choice</button>}
              </div>
            </div>
          )}
        </section>

        <section>
          <SectionTitle>Quantities</SectionTitle>
          <div className="space-y-4">
            <Segmented full value={v.quantity_type} onChange={(x) => set('quantity_type', x)} options={[{ value: 'weight', label: 'By weight' }, { value: 'count', label: 'By piece' }, { value: 'either', label: 'Either' }]} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="A piece is called" hint="e.g. steak, chop, leg"><Input value={v.piece_noun ?? ''} onChange={(e) => set('piece_noun', e.target.value)} /></Field>
              <Field label="Typical piece weight (g)" optional hint="Helps estimate totals on the cutting sheet."><Input inputMode="numeric" value={v.typical_piece_g ?? ''} onChange={(e) => set('typical_piece_g', e.target.value.replace(/\D/g, ''))} /></Field>
              {v.quantity_type !== 'weight' && <Field label="Sold in lots of (pieces)" optional hint="e.g. 30 for eggs: customers can only order 30, 60, 90… Pasted orders that don’t fit are flagged."><Input inputMode="numeric" value={v.pack_size ?? ''} onChange={(e) => set('pack_size', e.target.value.replace(/\D/g, ''))} /></Field>}
            </div>
            <Switch checked={!!v.allows_portions} onChange={(x) => set('allows_portions', x)} label="Can be ordered in packs" description="e.g. “6 × 500g”" />
          </div>
        </section>

        <section>
          <SectionTitle>Sizes customers choose</SectionTitle>
          <p className="-mt-1 mb-3 text-[13.5px] text-ink-3">Optional. When set, customers must pick one of these, e.g. 500g / 1kg packs for mince, or Whole / Half for fillet. Fixed packs are priced exactly; pieces are priced on their weight once cut.</p>
          <div className="space-y-2">
            {opts.map((o, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto] gap-2 rounded-xl bg-surface-2 p-2 sm:grid-cols-[1.3fr_9rem_7rem_auto]">
                <Input value={o.label} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="e.g. 1kg pack" className="h-9" aria-label="Size name" />
                <Select value={o.kind} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, kind: e.target.value as any } : x)))} className="h-9" aria-label="Kind"><option value="pack">Fixed pack</option><option value="piece">Piece (weighed)</option></Select>
                <div className="relative">
                  <Input inputMode="numeric" value={o.grams} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, grams: e.target.value.replace(/\D/g, '') } : x)))} placeholder={o.kind === 'pack' ? 'grams' : 'about g'} className="h-9 pr-6" aria-label="Grams" />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-ink-3">g</span>
                </div>
                {!readOnly && <button type="button" onClick={() => setOpts(opts.filter((_, j) => j !== i))} className="rounded-lg p-2 text-ink-3 hover:bg-sunken" aria-label="Remove size"><X className="size-4" /></button>}
              </div>
            ))}
            {!readOnly && <button type="button" onClick={() => setOpts([...opts, { id: '', label: '', kind: 'pack', grams: '' }])} className="text-[13.5px] font-medium text-brand hover:underline">+ Add size</button>}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Minimum per order" optional><Input inputMode="numeric" value={v.min_qty ?? ''} onChange={(e) => set('min_qty', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Maximum per order" optional><Input inputMode="numeric" value={v.max_qty ?? ''} onChange={(e) => set('max_qty', e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Show as an option of" optional hint="e.g. Rib-Eye on the bone appears inside the Rib-Eye card.">
              <Select value={v.variant_of ?? ''} onChange={(e) => set('variant_of', e.target.value)}>
                <option value="">— its own product —</option>
                {(allProducts?.products ?? []).filter((x) => x.id !== product?.id && !x.variant_of).map((x) => <option key={x.id} value={x.id}>{x.canonical_name}</option>)}
              </Select>
            </Field>
            <Field label="Option label" optional hint="e.g. On the bone"><Input value={v.variant_label ?? ''} onChange={(e) => set('variant_label', e.target.value)} /></Field>
          </div>
        </section>

        {product && !product.variant_of && (
          <section>
            <SectionTitle>Variations</SectionTitle>
            <p className="-mt-1 mb-3 text-[13.5px] text-ink-3">Each variation has its own price, description, rules and availability, e.g. Brisket → Whole / Smoked BBQ / Smoked Honey Mustard.</p>
            {variations.length > 0 && (
              <ul className="mb-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
                {variations.map((x) => (
                  <li key={x.id}>
                    <a href={`/products?open=${x.id}`} className="flex items-center justify-between gap-2 px-3 py-2.5 text-[14px] hover:bg-surface-2">
                      <span className="min-w-0"><b>{x.variant_label ?? x.canonical_name}</b>{!x.active && <span className="text-ink-3"> · out of stock</span>}</span>
                      <span className="shrink-0 text-ink-2">{x.price_cents != null ? `${formatMoney(x.price_cents)}/${x.price_unit}` : 'No price'}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && onAddVariation && <Button type="button" size="sm" icon={<Plus className="size-4" />} onClick={() => onAddVariation(product)}>Add variation</Button>}
            {variations.length > 0 && <Switch checked={!!v.group_only} onChange={(x) => set('group_only', x)} label="Only a heading for its variations" description="Customers must pick one of the variations; the main product itself can’t be ordered." />}
          </section>
        )}

        <section>
          <SectionTitle>Photo</SectionTitle>
          <div className="flex flex-wrap items-center gap-3">
            {v.image ? <img src={v.image} alt="" className="size-20 rounded-xl object-cover" /> : <span className="flex size-20 items-center justify-center rounded-xl bg-sunken text-[12px] text-ink-3">No photo</span>}
            {!readOnly && (
              <div className="space-y-1.5">
                <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Product photo" className="block text-[13.5px] file:mr-3 file:h-9 file:rounded-xl file:border-0 file:bg-sunken file:px-3 file:font-semibold" onChange={async (e) => { const fl = e.target.files?.[0]; if (!fl) return; const url = await shrinkImage(fl); if (url) set('image', url); else setErr('Use a PNG, JPG or WebP photo.'); }} />
                {v.image && <button type="button" className="text-[13px] font-medium text-danger hover:underline" onClick={() => set('image', null)}>Remove photo</button>}
              </div>
            )}
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
                    <div key={i} className="grid gap-2 rounded-xl bg-surface-2 p-2 sm:grid-cols-[1fr_1.4fr_5.5rem_auto]">
                      <Input value={p.name} onChange={(e) => setPreps(preps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Option" className="h-9" aria-label="Option name" />
                      <Input value={p.keywords} onChange={(e) => setPreps(preps.map((x, j) => (j === i ? { ...x, keywords: e.target.value } : x)))} placeholder="keywords, comma separated" className="h-9" aria-label="Keywords" />
                      <div className="relative" title="Extra charge on the price per kg, e.g. 25 for dry-aged">
                        <Input inputMode="numeric" value={p.surcharge_pct || ''} onChange={(e) => setPreps(preps.map((x, j) => (j === i ? { ...x, surcharge_pct: Math.min(200, Number(e.target.value.replace(/\D/g, '')) || 0) } : x)))} placeholder="+0" className="h-9 pr-7" aria-label="Surcharge percent" />
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-ink-3">%</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => setPreps(preps.map((x, j) => (x.group_name === g ? { ...x, is_default: j === i } : x)))} className={cx('h-9 rounded-lg px-2.5 text-[12.5px] font-medium', p.is_default ? 'bg-field-soft text-field-soft-ink' : 'text-ink-3 hover:bg-sunken')}>{p.is_default ? 'Default' : 'Make default'}</button>
                        <button type="button" onClick={() => setPreps(preps.map((x, j) => (j === i ? { ...x, customer_visible: !x.customer_visible } : x)))} className={cx('h-9 rounded-lg px-2 text-[12.5px]', p.customer_visible ? 'text-ink-3' : 'bg-slate-soft text-slate-soft-ink')} title="Visible on the customer order form">{p.customer_visible ? 'Public' : 'Internal'}</button>
                        {!readOnly && <button type="button" onClick={() => setPreps(preps.filter((_, j) => j !== i))} className="rounded-lg p-2 text-ink-3 hover:bg-sunken" aria-label="Remove option"><X className="size-4" /></button>}
                      </div>
                    </div>
                  ))}
                  {!readOnly && <button type="button" onClick={() => setPreps([...preps, { group_name: g, name: '', keywords: '', is_default: false, customer_visible: true, active: true, surcharge_pct: 0 }])} className="text-[13.5px] font-medium text-brand hover:underline">+ Add option</button>}
                </div>
              </Card>
            ))}
            {!readOnly && <Button type="button" icon={<Plus className="size-4" />} onClick={() => setPreps([...preps, { group_name: groups.includes('Preparation') ? `Group ${groups.length + 1}` : 'Preparation', name: '', keywords: '', is_default: true, customer_visible: true, active: true, surcharge_pct: 0 }])}>Add option group</Button>}
          </div>
        </section>

        <section className="space-y-1">
          <SectionTitle>Availability</SectionTitle>
          <Switch checked={!!v.active} onChange={(x) => set('active', x)} label="In stock" description="Switch off when you’ve run out. It can’t be added to new orders, and the order form shows it as “Out of stock” instead of hiding it." />
          {!v.active && <Field label="Message when out of stock" optional className="pb-2"><Input value={v.unavailable_reason ?? ''} onChange={(e) => set('unavailable_reason', e.target.value)} placeholder="e.g. Back in mid-November" /></Field>}
          <Switch checked={!!v.customer_visible} onChange={(x) => set('customer_visible', x)} label="Show on the customer order form" description="Switch off to hide it from customers completely (e.g. internal or discontinued products)." />
          <Field label="Internal notes" optional className="pt-3"><Textarea rows={2} value={v.internal_notes ?? ''} onChange={(e) => set('internal_notes', e.target.value)} /></Field>
        </section>
        {err && <p className="rounded-xl bg-danger-soft px-4 py-3 text-[14px] text-danger-soft-ink">{err}</p>}
      </fieldset>
    </Sheet>
  );
}

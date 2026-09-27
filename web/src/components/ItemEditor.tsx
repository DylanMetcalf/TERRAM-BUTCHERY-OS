import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Product, Qty } from '../lib/types';
import { formatMoney, estimateLinePrice, formatQty } from '../lib/format';
import { ProductPicker, useProducts } from './pickers';
import { QuantityInput } from './quantity-input';
import { Button, cx, Field, Sheet, Textarea } from './ui';

export interface ItemDraft {
  product_id: string;
  qty: Qty;
  preparation: Record<string, string>;
  special_instructions: string | null;
}

export function prepGroupsOf(p: Product, customerOnly = false) {
  const m = new Map<string, Product['preparations']>();
  for (const o of p.preparations) {
    if (!o.active || (customerOnly && !o.customer_visible)) continue;
    (m.get(o.group_name) ?? m.set(o.group_name, []).get(o.group_name)!).push(o);
  }
  return [...m.entries()].map(([group, options]) => ({ group, options }));
}

/** Add or edit one line. Only preparations configured for the product can be chosen. */
export function ItemEditor({ open, onClose, initial, onSave, title, saving, lockProduct, phrase }: { open: boolean; onClose: () => void; initial?: Partial<ItemDraft> | null; onSave: (d: ItemDraft) => void; title?: string; saving?: boolean; lockProduct?: boolean; phrase?: string }) {
  const { data } = useProducts();
  const [productId, setProductId] = useState<string | null>(initial?.product_id ?? null);
  const [qty, setQty] = useState<Qty | null>(initial?.qty ?? null);
  const [prep, setPrep] = useState<Record<string, string>>(initial?.preparation ?? {});
  const [note, setNote] = useState(initial?.special_instructions ?? '');
  const [picking, setPicking] = useState(!initial?.product_id);
  useEffect(() => {
    if (open) {
      setProductId(initial?.product_id ?? null);
      setQty(initial?.qty ?? null);
      setPrep(initial?.preparation ?? {});
      setNote(initial?.special_instructions ?? '');
      setPicking(!initial?.product_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const product = useMemo(() => data?.products.find((p) => p.id === productId) ?? null, [data, productId]);
  const groups = product ? prepGroupsOf(product) : [];
  const price = product && qty ? estimateLinePrice(qty, product.price_cents, product.price_unit) : null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={picking ? 'Choose a product' : title ?? (product ? product.canonical_name : 'Item')}
      subtitle={phrase ? <>Customer wrote: “{phrase}”</> : undefined}
      footer={
        !picking && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink-3">{qty && product ? `${formatQty(qty, product.piece_noun)}${price != null ? ` · ≈ ${formatMoney(price)}` : ''}` : 'Set a quantity'}</span>
            <Button variant="primary" size="lg" disabled={!product || !qty} loading={saving} onClick={() => product && qty && onSave({ product_id: product.id, qty, preparation: prep, special_instructions: note.trim() || null })}>
              Save
            </Button>
          </div>
        )
      }
    >
      {picking ? (
        <ProductPicker
          selectedId={productId}
          onPick={(p) => {
            if (p.id !== productId) {
              setPrep({});
              setQty(null);
            }
            setProductId(p.id);
            setPicking(false);
          }}
        />
      ) : product ? (
        <div className="space-y-6">
          {!lockProduct && (
            <button onClick={() => setPicking(true)} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand hover:underline">
              <ArrowLeft className="size-4" /> Change product
            </button>
          )}
          <Field label="How much?">
            <QuantityInput key={product.id} value={qty} onChange={setQty} quantityType={product.quantity_type} allowsPortions={product.allows_portions} pieceNoun={product.piece_noun} autoFocus />
          </Field>
          {groups.map((g) => {
            const current = prep[g.group] ?? g.options.find((o) => o.is_default)?.name;
            return (
              <Field key={g.group} label={g.group}>
                <div className="flex flex-wrap gap-2">
                  {g.options.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setPrep((s) => ({ ...s, [g.group]: o.name }))}
                      className={cx('h-10 rounded-xl border px-3.5 text-[14px] font-medium transition active:scale-95', current === o.name ? 'border-brand bg-brand-soft text-brand-soft-ink' : 'border-line-strong bg-surface text-ink-2 hover:border-ink-3')}
                    >
                      {o.name}
                    </button>
                  ))}
                </div>
              </Field>
            );
          })}
          <Field label="Special instructions" optional>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. trim the fat, cut 3cm thick" rows={2} />
          </Field>
        </div>
      ) : null}
    </Sheet>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ImagePlus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { applyBrandColour, brandTokens, contrast, hexToRgb, rgbToHex } from '../lib/brand';
import { useCan } from '../lib/auth';
import { Badge, Button, Callout, Card, cx, Field, Input, Segmented, Switch, useToast } from './ui';

interface BrandValue {
  logo: string | null;
  icon192: string | null;
  icon512: string | null;
  primary: string;
  showName: boolean;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = src;
  });
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

/** Keeps uploads small: raster logos are scaled to ≤ 800px and saved as PNG (transparency kept). */
async function normaliseLogo(file: File): Promise<string> {
  const data = await readFile(file);
  if (file.type === 'image/svg+xml') {
    if (data.length > 900_000) throw new Error('That SVG is too large (max ~650 KB).');
    return data;
  }
  const img = await loadImage(data);
  const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  const out = c.toDataURL('image/png');
  if (out.length > 900_000) return c.toDataURL('image/webp', 0.9);
  return out;
}

/** Square app icon: the logo centred on a background, with safe padding for rounded/“maskable” icons. */
async function makeIcon(logo: string, size: number, bg: string): Promise<string> {
  const img = await loadImage(logo);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  const w = img.naturalWidth || 512;
  const h = img.naturalHeight || 512;
  const box = size * 0.68;
  const s = Math.min(box / w, box / h);
  ctx.drawImage(img, (size - w * s) / 2, (size - h * s) / 2, w * s, h * s);
  return c.toDataURL('image/png');
}

/** The most common strong colours in the logo, as brand-colour suggestions. */
async function paletteFrom(logo: string): Promise<string[]> {
  const img = await loadImage(logo);
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, 48, 48);
  const px = ctx.getImageData(0, 0, 48, 48).data;
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    if (a < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 235 && min > 225) continue; // near white
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    buckets.set(key, e);
  }
  const colours = [...buckets.values()].sort((a, b) => b.n - a.n).map((e) => rgbToHex([e.r / e.n, e.g / e.n, e.b / e.n]));
  const distinct: string[] = [];
  for (const col of colours) {
    const rgb = hexToRgb(col);
    if (distinct.every((d) => { const o = hexToRgb(d); return Math.abs(o[0] - rgb[0]) + Math.abs(o[1] - rgb[1]) + Math.abs(o[2] - rgb[2]) > 60; })) distinct.push(col);
    if (distinct.length >= 6) break;
  }
  return distinct;
}

export function BrandKit({ initial }: { initial: BrandValue }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [v, setV] = useState<BrandValue>(initial);
  const [iconBg, setIconBg] = useState<'white' | 'brand'>('white');
  const [swatches, setSwatches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const readOnly = !can('settings.write');

  useEffect(() => {
    if (v.logo) paletteFrom(v.logo).then(setSwatches).catch(() => setSwatches([]));
  }, [v.logo]);
  // Live preview across the whole app while choosing
  useEffect(() => {
    applyBrandColour(v.primary);
    return () => applyBrandColour(qc.getQueryData<{ primary: string }>(['brand'])?.primary ?? initial.primary);
  }, [v.primary, initial.primary, qc]);

  const save = useMutation({
    mutationFn: async () => {
      let icon192: string | null = null;
      let icon512: string | null = null;
      if (v.logo) {
        const bg = iconBg === 'brand' ? brandTokens(v.primary).light['--brand'] : '#ffffff';
        icon192 = await makeIcon(v.logo, 192, bg);
        icon512 = await makeIcon(v.logo, 512, bg);
      }
      return api.put('/api/admin/settings/brand', { ...v, icon192, icon512 });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brand'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast({ tone: 'success', title: 'Brand saved', body: 'Every device picks it up automatically. Re-add the app to a Home Screen to see a new icon.' });
    },
    onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Could not save.' }),
  });

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const logo = await normaliseLogo(file);
      const pal = await paletteFrom(logo).catch(() => []);
      setSwatches(pal);
      setV((s) => ({ ...s, logo, primary: s.primary === '#7b2d26' && pal[0] ? pal[0] : s.primary }));
    } catch (e) {
      toast({ tone: 'error', title: e instanceof Error ? e.message : 'Upload failed.' });
    } finally {
      setBusy(false);
    }
  };

  const tokens = brandTokens(v.primary).light;
  const adjusted = tokens['--brand'].toLowerCase() !== v.primary.toLowerCase();
  const onWhite = contrast(hexToRgb(v.primary), [255, 255, 255]);

  return (
    <div className="space-y-6">
      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="font-display text-xl font-semibold">Brand kit</h2>
          <p className="text-[14px] text-ink-2">Your logo and colour on every screen, printout, the customer order form and the app icon.</p>
        </div>
        <fieldset disabled={readOnly} className="grid gap-6 p-5 md:grid-cols-2">
          <div className="space-y-4">
            <Field label="Logo" hint="PNG with a transparent background works best. SVG and JPG are fine too.">
              <div className="flex items-center gap-4">
                <div className="flex h-24 w-40 items-center justify-center rounded-2xl border border-dashed border-line-strong bg-surface-2 p-3">
                  {v.logo ? <img src={v.logo} alt="Logo preview" className="max-h-full max-w-full object-contain" /> : <ImagePlus className="size-7 text-ink-3" />}
                </div>
                <div className="flex flex-col gap-2">
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
                  <Button icon={<Upload className="size-4" />} loading={busy} onClick={() => fileRef.current?.click()}>{v.logo ? 'Replace' : 'Upload logo'}</Button>
                  {v.logo && <Button variant="ghost" size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setV((s) => ({ ...s, logo: null }))}>Remove</Button>}
                </div>
              </div>
            </Field>
            {v.logo && <Switch checked={v.showName} onChange={(x) => setV((s) => ({ ...s, showName: x }))} label="Show the business name next to the logo" description="Turn off if the name is already part of your logo." />}
            {v.logo && (
              <Field label="App icon background">
                <Segmented value={iconBg} onChange={setIconBg} options={[{ value: 'white', label: 'White' }, { value: 'brand', label: 'Brand colour' }]} />
              </Field>
            )}
            {v.logo && iconBg === 'brand' && swatches.some((sw) => contrast(hexToRgb(sw), hexToRgb(tokens['--brand'])) < 1.6) && (
              <Callout tone="ochre">Parts of your logo are the same colour as this background and will disappear on the icon. White usually works better.</Callout>
            )}
          </div>

          <div className="space-y-4">
            <Field label="Brand colour" hint="Used for buttons, highlights and the sign-in screen.">
              <div className="flex items-center gap-3">
                <input type="color" value={v.primary} onChange={(e) => setV((s) => ({ ...s, primary: e.target.value }))} className="h-12 w-16 cursor-pointer rounded-xl border border-line-strong bg-surface p-1" aria-label="Pick brand colour" />
                <Input value={v.primary} onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && setV((s) => ({ ...s, primary: e.target.value }))} className="w-32 font-mono" aria-label="Brand colour hex" />
              </div>
            </Field>
            {swatches.length > 0 && (
              <div>
                <div className="mb-2 text-[13px] font-medium text-ink-2">From your logo</div>
                <div className="flex flex-wrap gap-2">
                  {swatches.map((sw) => (
                    <button key={sw} type="button" onClick={() => setV((s) => ({ ...s, primary: sw }))} className={cx('flex size-10 items-center justify-center rounded-xl border-2 transition', v.primary.toLowerCase() === sw.toLowerCase() ? 'border-ink' : 'border-transparent')} style={{ background: sw }} aria-label={`Use ${sw}`} title={sw}>
                      {v.primary.toLowerCase() === sw.toLowerCase() && <Check className="size-4" style={{ color: contrast(hexToRgb(sw), [255, 255, 255]) >= 3 ? '#fff' : '#1d1b18' }} />}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {adjusted && <Callout tone="slate">This colour is very light, so a slightly deeper shade ({tokens['--brand']}) is used for buttons and text to keep them readable.</Callout>}
            {!adjusted && onWhite < 4.5 && <Callout tone="slate">Button text will be dark on this colour so it stays readable.</Callout>}
          </div>
        </fieldset>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">Preview</div>
        <div className="grid gap-6 p-5 md:grid-cols-[1fr_auto]">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {v.logo ? <img src={v.logo} alt="" className="h-10 w-auto max-w-[160px] object-contain" /> : null}
              {(!v.logo || v.showName) && <span className="font-display text-xl font-semibold">Terram</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary">New order</Button>
              <Button>Paste orders</Button>
              <Badge tone="brand" dot>Cutting</Badge>
            </div>
          </div>
          {v.logo && (
            <div className="text-center">
              <div className="mx-auto flex size-20 items-center justify-center overflow-hidden rounded-[22px] shadow-float" style={{ background: iconBg === 'brand' ? tokens['--brand'] : '#fff' }}>
                <img src={v.logo} alt="" className="h-[68%] w-[68%] object-contain" />
              </div>
              <div className="mt-2 text-[12px] text-ink-3">Home Screen icon</div>
            </div>
          )}
        </div>
        {!readOnly && (
          <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
            <Button variant="ghost" onClick={() => setV(initial)}>Undo changes</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save brand</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

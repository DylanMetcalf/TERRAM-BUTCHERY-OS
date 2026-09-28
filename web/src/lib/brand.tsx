import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './api';

export interface Brand {
  name: string;
  tagline: string;
  primary: string;
  showName: boolean;
  hasLogo: boolean;
  version: number;
}

export function useBrand() {
  return useQuery({ queryKey: ['brand'], queryFn: () => api.get<Brand>('/api/public/brand'), staleTime: 5 * 60_000 });
}

// ── colour maths (sRGB) ─────────────────────────────────────
type RGB = [number, number, number];
export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a: RGB, b: RGB): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const WHITE: RGB = [255, 255, 255];
const INK: RGB = [38, 38, 38];
const PAPER: RGB = [245, 245, 242];
/** Terram green (brand kit). The stylesheet already carries its hand-tuned tokens. */
export const DEFAULT_BRAND_COLOUR = '#446041';

/**
 * Turns one brand colour into the full set of tokens the app uses, in light and
 * dark mode. Very light brand colours are deepened so buttons and text stay readable.
 */
export function brandTokens(hex: string) {
  let base = hexToRgb(hex);
  // Keep the brand usable as a button/text colour on paper: aim for ≥ 4.5:1 against the page
  let guard = 0;
  while (contrast(base, PAPER) < 4.5 && guard++ < 20) base = mix(base, INK, 0.12);
  const ink = contrast(base, WHITE) >= 4.5 ? WHITE : INK;
  const light = {
    '--brand': rgbToHex(base),
    '--brand-hover': rgbToHex(mix(base, INK, 0.15)),
    '--brand-ink': rgbToHex(ink),
    '--brand-soft': rgbToHex(mix(base, WHITE, 0.88)),
    '--brand-soft-ink': rgbToHex(mix(base, INK, 0.3)),
    '--focus': rgbToHex(base),
  };
  let darkBase = hexToRgb(hex);
  guard = 0;
  const darkBg: RGB = [31, 31, 31];
  while (contrast(darkBase, darkBg) < 4.5 && guard++ < 20) darkBase = mix(darkBase, WHITE, 0.12);
  const dark = {
    '--brand': rgbToHex(darkBase),
    '--brand-hover': rgbToHex(mix(darkBase, WHITE, 0.12)),
    '--brand-ink': rgbToHex(contrast(darkBase, [26, 13, 11]) >= 4.5 ? [26, 13, 11] : WHITE),
    '--brand-soft': rgbToHex(mix(darkBase, darkBg, 0.78)),
    '--brand-soft-ink': rgbToHex(mix(darkBase, WHITE, 0.55)),
    '--focus': rgbToHex(darkBase),
  };
  return { light, dark };
}

export function applyBrandColour(hex: string | undefined) {
  const id = 'terram-brand-tokens';
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!hex || hex.toLowerCase() === DEFAULT_BRAND_COLOUR) {
    el?.remove();
    return;
  }
  const { light, dark } = brandTokens(hex);
  const block = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}:${v};`).join('');
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = `:root{${block(light)}} @media (prefers-color-scheme: dark){:root:not([data-theme='light']){${block(dark)}}}`;
  document.querySelector('meta[name="theme-color"][media*="light"]')?.setAttribute('content', light['--brand']);
}

/** Applies the saved brand colour to every screen, including sign-in and the customer form. */
export function BrandStyles() {
  const { data } = useBrand();
  useEffect(() => applyBrandColour(data?.primary), [data?.primary]);
  useEffect(() => {
    if (data?.hasLogo) {
      document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((l) => (l.href = `/brand/logo?v=${data.version}`));
    }
  }, [data?.hasLogo, data?.version]);
  return null;
}

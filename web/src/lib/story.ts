import { PackageCheck, ShoppingBag, Sprout, type LucideIcon } from 'lucide-react';

/**
 * Helpers for laying out the farm's own About text (Settings → About page) on the home and About
 * pages. They only split and arrange what the farm wrote — nothing is added.
 */
export const paras = (t: string | null | undefined) => (t ?? '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);

/** A short first line ("From our family farm to your family table.") works as a headline. */
export function splitHeadline(intro: string | null | undefined, fallback: string) {
  const p = paras(intro);
  if (p[0] && p[0].length <= 90) return { headline: p[0], rest: p.slice(1) };
  return { headline: fallback, rest: p };
}

/** Short facts, shown only when the farm's own introduction says them. */
export function highlights(intro: string | null | undefined): { icon: LucideIcon; text: string }[] {
  const t = (intro ?? '').toLowerCase();
  return [
    /farm-raised|raise (beef|lamb)/.test(t) && { icon: Sprout, text: 'Farm-raised beef & lamb' },
    /prepared to order|prepare each order/.test(t) && { icon: ShoppingBag, text: 'Prepared to order' },
    /vacuum/.test(t) && { icon: PackageCheck, text: 'Vacuum-packed' },
  ].filter(Boolean) as { icon: LucideIcon; text: string }[];
}

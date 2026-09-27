export { formatQty, formatQtyShort, formatWeight, formatMoney, estimateLinePrice, totalGrams } from '../../../shared/quantity';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function todayYmd(tz = 'Africa/Johannesburg'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function parse(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(ymd: string, n: number) {
  const d = parse(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string) {
  return Math.round((parse(a).getTime() - parse(b).getTime()) / 86400000);
}

/** "Today", "Tomorrow", "Sat 3 Oct" */
export function friendlyDate(ymd: string | null | undefined, today = todayYmd(), opts: { long?: boolean } = {}): string {
  if (!ymd) return 'No date';
  const diff = diffDays(ymd, today);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const d = parse(ymd);
  const wd = opts.long ? WD_LONG[d.getUTCDay()] : WD[d.getUTCDay()];
  if (diff > 1 && diff < 7 && opts.long) return `${wd}`;
  return `${wd} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export function longDate(ymd: string): string {
  const d = parse(ymd);
  return `${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function shortDate(ymd: string): string {
  const d = parse(ymd);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

export function weekdayShort(ymd: string) {
  return WD[parse(ymd).getUTCDay()];
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  const d = new Date(iso);
  return `${d.getDate()} ${MON[d.getMonth()]}`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MON[d.getMonth()]} ${clockTime(iso)}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function plural(n: number, one: string, many?: string) {
  return `${n} ${n === 1 ? one : many ?? one + 's'}`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

import { formatQty as _fq } from '../../../shared/quantity';
import type { Qty } from '../../../shared/quantity';
/** For lines where the product name follows: "10 ×" instead of "10 patties". */
export function qtyBeforeName(q: Qty): string {
  return q.kind === 'count' ? `${q.count} ×` : _fq(q);
}

/** wa.me link with an optional prefilled message. A person still presses send. */
export function waLink(phone: string | null | undefined, text?: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '27' + digits.slice(1);
  if (digits.length < 9) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function readyMessage(o: { customer_name: string; order_number: number; fulfilment_type: string | null }, business = 'Terram Farm'): string {
  const first = o.customer_name.split(' ')[0];
  return o.fulfilment_type === 'delivery'
    ? `Hi ${first}, your ${business} order #${o.order_number} is packed and will be delivered soon. Thank you!`
    : `Hi ${first}, your ${business} order #${o.order_number} is ready for collection. See you soon!`;
}

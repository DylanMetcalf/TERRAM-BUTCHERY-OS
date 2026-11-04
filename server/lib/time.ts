/**
 * Dates in the business timezone. The butchery thinks in local days
 * ("Saturday's collections"), so all day logic uses YYYY-MM-DD strings
 * computed in the configured timezone.
 */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function localDate(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayIndex(name: string): number {
  const n = name.toLowerCase();
  return WEEKDAYS.findIndex((w) => w.startsWith(n.slice(0, 3)));
}

/** Next occurrence of weekday (0=Sun) on or after `from` (same day counts). */
export function nextWeekday(from: string, weekday: number, includeToday = true): string {
  const cur = weekdayOf(from);
  let diff = (weekday - cur + 7) % 7;
  if (diff === 0 && !includeToday) diff = 7;
  return addDays(from, diff);
}

/** Monday-start week range containing ymd. */
export function weekRange(ymd: string): { from: string; to: string } {
  const wd = weekdayOf(ymd);
  const offset = (wd + 6) % 7;
  const from = addDays(ymd, -offset);
  return { from, to: addDays(from, 6) };
}

export function isValidYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** How far the timezone is ahead of UTC at that moment, in ms. */
function tzOffsetMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(d.getTime() / 1000) * 1000;
}

/**
 * The UTC instant (ISO) at which a local day starts. Timestamps are stored in UTC, so "today" in
 * Johannesburg (UTC+2) starts at 22:00 the previous day UTC — compare against this, not "YYYY-MM-DDT00:00".
 */
export function localDayStartUtc(ymd: string, tz: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  let t = utc - tzOffsetMs(new Date(utc), tz);
  const again = utc - tzOffsetMs(new Date(t), tz);
  if (again !== t) t = again; // DST edge
  return new Date(t).toISOString();
}

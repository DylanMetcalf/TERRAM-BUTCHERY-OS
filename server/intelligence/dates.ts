import { addDays, isValidYmd, nextWeekday, weekdayIndex } from '../lib/time.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WD = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)';

export interface DateResult {
  date: string | null;
  matched: string | null;
}

function monthIndex(s: string) {
  return MONTHS.indexOf(s.slice(0, 3).toLowerCase());
}

/** Resolve a day-of-month (+ optional month) to the next sensible future date. */
function resolveDayMonth(ref: string, day: number, month0: number | null, year: number | null): string | null {
  const [ry, rm] = ref.split('-').map(Number);
  const make = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (month0 != null) {
    let y = year ?? ry;
    if (year && year < 100) y = 2000 + year;
    let cand = make(y, month0);
    if (!year && isValidYmd(cand) && cand < addDays(ref, -7)) cand = make(y + 1, month0);
    return isValidYmd(cand) ? cand : null;
  }
  let cand = make(ry, rm - 1);
  if (!isValidYmd(cand) || cand < ref) {
    const nm = rm === 12 ? 0 : rm;
    const ny = rm === 12 ? ry + 1 : ry;
    cand = make(ny, nm);
  }
  return isValidYmd(cand) ? cand : null;
}

/** Extracts a requested date relative to the date the message was sent. */
export function extractDate(text: string, ref: string): DateResult {
  const t = text.toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /\b(?:the\s+)?day after tomorrow\b/.exec(t))) return { date: addDays(ref, 2), matched: m[0] };
  if ((m = /\b(?:tomorrow|tmrw|tmr|2moro|tomorow|tommorow)\b/.exec(t))) return { date: addDays(ref, 1), matched: m[0] };
  if ((m = /\b(?:today|this afternoon|this morning|tonight|later today)\b/.exec(t))) return { date: ref, matched: m[0] };
  if ((m = /\b(?:this\s+)?weekend\b/.exec(t))) return { date: nextWeekday(ref, 6), matched: m[0] };
  // 12/10, 12-10-2026, 12.10.26 — day first (South African convention)
  if ((m = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(t))) {
    const d = resolveDayMonth(ref, Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : null);
    if (d) return { date: d, matched: m[0] };
  }
  // 12 October / 12th of Oct / October 12
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/.exec(t))) {
    const d = resolveDayMonth(ref, Number(m[1]), monthIndex(m[2]), null);
    if (d) return { date: d, matched: m[0] };
  }
  if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t))) {
    const d = resolveDayMonth(ref, Number(m[2]), monthIndex(m[1]), null);
    if (d) return { date: d, matched: m[0] };
  }
  // next saturday / this sat / saturday / sat morning
  if ((m = new RegExp(`\\b(next|this|coming|on)?\\s*${WD}\\b`).exec(t))) {
    const wd = weekdayIndex(m[2]);
    if (wd >= 0) {
      const includeToday = m[1] !== 'next';
      return { date: nextWeekday(ref, wd, includeToday), matched: m[0].trim() };
    }
  }
  // "on the 12th"
  if ((m = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(t))) {
    const d = resolveDayMonth(ref, Number(m[1]), null, null);
    if (d) return { date: d, matched: m[0] };
  }
  return { date: null, matched: null };
}

export function extractTimeWindow(text: string): string | null {
  const t = text.toLowerCase();
  let m = /\b(?:at|around|by|after|before|from)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s*(?:-|to|–)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/.exec(t);
  if (m && (/[ap]m|:/.test(m[1]) || Number(m[1]) <= 12)) return m[0].replace(/\s+/g, ' ').trim();
  m = /\b(\d{1,2}(?::\d{2})\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/.exec(t);
  if (m) return m[1].trim();
  m = /\b(morning|afternoon|lunchtime|lunch time|evening|early|first thing)\b/.exec(t);
  if (m) return m[1];
  return null;
}

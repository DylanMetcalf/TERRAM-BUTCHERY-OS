import { normalise, normalisePhone, titleCase } from '../../shared/text.js';
import { isValidYmd } from '../lib/time.js';
import { looksLikeName } from './parser.js';
export { looksLikeName };
import { extractQuantity } from './quantity.js';
import type { Dictionary } from './matcher.js';

/**
 * Splits a pasted blob (WhatsApp export, copied chats, or hand-typed
 * "Name: …" blocks) into individual messages with a sender.
 */
export interface SplitMessage {
  index: number;
  sender: string | null;
  senderPhone: string | null;
  text: string;
  sentAt: string | null; // ISO datetime when known
  refDate: string; // YYYY-MM-DD used to resolve "Saturday" etc.
  direction: 'in' | 'out';
  line: number;
}

const EXPORT_RE = /^\[?(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)?)\]?\s*(?:[-–]\s*)?(?:([^:]{1,60}?):\s?)?(.*)$/i;
const HEADER_RE = /^(?:from\s*:\s*)?([\p{L}][\p{L}'’.\-]*(?:\s+[\p{L}][\p{L}'’.\-]*){0,3}|\+?\d[\d\s()-]{7,}\d)\s*(?:\((\+?[\d\s()-]{8,})\))?\s*(?::|\s[-–]\s)\s*(.*)$/u;
const SEPARATOR_RE = /^(?:[-=_*~#]{3,}|order\s*#?\s*\d+\s*:?|new order\s*:?|next order\s*:?)$/i;

const SYSTEM_LINE_RE = /(?:messages and calls are end-to-end encrypted|created group|added you|changed the subject|<media omitted>|this message was deleted|missed voice call|joined using this group)/i;

function exportDate(d: string, fallback: string): string {
  const parts = d.split(/[/.-]/).map(Number);
  let y: number, m: number, day: number;
  if (parts[0] > 999) [y, m, day] = parts;
  else {
    [day, m, y] = parts;
    if (m > 12 && day <= 12) [day, m] = [m, day]; // US-style export
  }
  if (y < 100) y += 2000;
  const ymd = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidYmd(ymd) ? ymd : fallback;
}

function exportTime(t: string): string {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?/i.exec(t)!;
  let h = Number(m[1]);
  if (m[4]?.toLowerCase() === 'p' && h < 12) h += 12;
  if (m[4]?.toLowerCase() === 'a' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`;
}

export function splitMessages(input: string, refDate: string, dict: Dictionary, businessNames: string[]): SplitMessage[] {
  const outbound = new Set(['me', 'you', ...businessNames.map((b) => normalise(b))]);
  const lines = input.replace(/\r\n?/g, '\n').replace(/\u200e|\u200f|\u202a|\u202c/g, '').split('\n');
  const out: SplitMessage[] = [];
  let cur: SplitMessage | null = null;
  /** Sender established by a header line ("John:") that owns following lines until a blank line. */
  let blockSender: { name: string | null; phone: string | null } | null = null;
  let blockStart = true;

  const push = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.trim();
      out.push(cur);
    }
    cur = null;
  };
  const start = (sender: string | null, phone: string | null, text: string, line: number, sentAt: string | null = null, rDate = refDate) => {
    push();
    const isOut = sender ? outbound.has(normalise(sender)) : false;
    cur = { index: out.length, sender: sender ? tidyName(sender) : null, senderPhone: phone, text, sentAt, refDate: rDate, direction: isOut ? 'out' : 'in', line };
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      push();
      blockSender = null;
      blockStart = true;
      continue;
    }
    if (SEPARATOR_RE.test(line)) {
      push();
      blockSender = null;
      blockStart = true;
      continue;
    }
    if (SYSTEM_LINE_RE.test(line)) continue;

    // WhatsApp export line
    const ex = EXPORT_RE.exec(line);
    if (ex && ex[3] !== undefined) {
      const d = exportDate(ex[1], refDate);
      const who = ex[3].trim();
      const phone = /^\+?[\d\s()-]{8,}$/.test(who) ? normalisePhone(who) : null;
      start(phone ? null : who, phone, ex[4] ?? '', i + 1, `${d}T${exportTime(ex[2])}`, d);
      blockSender = { name: phone ? null : who, phone };
      blockStart = false;
      continue;
    }
    if (ex && ex[3] === undefined && /^\[?\d/.test(line) && /\d:\d{2}/.test(line)) continue; // export system line

    // "John:" / "John Smith - 2kg mince" / "+27 82 555 1234: ..."
    const hd = HEADER_RE.exec(line);
    if (hd) {
      const who = hd[1].trim();
      const isPhone = /^\+?\d/.test(who);
      const phone = isPhone ? normalisePhone(who) : hd[2] ? normalisePhone(hd[2]) : null;
      if ((isPhone && phone) || (!isPhone && looksLikeName(who, dict))) {
        const name = isPhone ? null : who;
        start(name, phone, hd[3] ?? '', i + 1);
        blockSender = { name, phone };
        blockStart = false;
        continue;
      }
    }

    // First line of a block that is just a name ("Sarah Jones") followed by more lines
    if (blockStart && !cur) {
      const next = lines[i + 1]?.trim();
      const q = extractQuantity(line);
      if (next && !q.qty && looksLikeName(line.replace(/[:,.-]+$/, ''), dict)) {
        blockSender = { name: line.replace(/[:,.-]+$/, '').trim(), phone: null };
        blockStart = false;
        continue;
      }
    }

    if (cur) {
      (cur as SplitMessage).text += '\n' + line;
    } else {
      start(blockSender?.name ?? null, blockSender?.phone ?? null, line, i + 1);
    }
    blockStart = false;
  }
  push();
  return out.map((m, i) => ({ ...m, index: i }));
}

function tidyName(name: string): string {
  const n = name.replace(/[~:]+/g, '').trim();
  return n === n.toLowerCase() || n === n.toUpperCase() ? titleCase(n) : n;
}

import { escapeHtml } from './email.js';
import { getSettings } from './settings.js';
import { siteUrl } from './links.js';
import { rands } from '../../shared/pricing.js';

/**
 * Branded, responsive emails with a plain-text twin. Content builders return
 * { subject, text, html }; they only describe facts passed in (never invent dates, amounts
 * or delivery results). Every link is built from the configured public site address.
 */

export interface Email {
  subject: string;
  text: string;
  html: string;
}

export interface EmailLine {
  label: string;
  detail?: string | null;
  price?: string | null;
}

const GREEN = '#446041';
const CHARCOAL = '#303030';

export function formatDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "Friday 14 November 2026", or "14 – 21 November 2026" for a range. */
export function formatTimeframe(from: string | null, to: string | null): string | null {
  if (!from) return null;
  if (!to || to === from) return formatDate(from);
  const a = new Date(`${from}T12:00:00Z`);
  const b = new Date(`${to}T12:00:00Z`);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  const dm = (d: Date, withMonth: boolean) => d.toLocaleDateString('en-ZA', { day: 'numeric', ...(withMonth ? { month: 'long' } : {}), timeZone: 'UTC' });
  return sameMonth ? `${dm(a, false)} – ${dm(b, true)} ${b.getUTCFullYear()}` : `${dm(a, true)} – ${dm(b, true)} ${b.getUTCFullYear()}`;
}

export function money(cents: number | null | undefined): string {
  return rands(cents, getSettings().business.currency);
}

interface Block {
  heading?: string;
  /** Paragraphs of plain text (escaped for HTML). */
  paragraphs?: string[];
  lines?: EmailLine[];
  facts?: [string, string][];
  note?: string;
}

export interface LayoutInput {
  subject: string;
  preheader: string;
  greeting?: string;
  intro: string[];
  blocks?: Block[];
  cta?: { label: string; url: string };
  /** Extra plain links under the main button (e.g. "WhatsApp us about this order"). */
  links?: { label: string; url: string }[];
  closing?: string[];
  /** Small print at the very bottom, e.g. an unsubscribe link for reminders. */
  footer?: { text: string; url?: string };
}

/** Wraps content in the Terram email layout (tables + inline styles for email clients) and builds the text version. */
export function layout(i: LayoutInput): Email {
  const s = getSettings();
  const b = s.business;
  const logo = `${siteUrl()}/brand/terram-logo.png`;
  const esc = escapeHtml;
  const blockHtml = (bl: Block) => {
    let h = '';
    if (bl.heading) h += `<tr><td style="padding:22px 0 8px;font:600 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#85857e">${esc(bl.heading)}</td></tr>`;
    for (const p of bl.paragraphs ?? []) h += `<tr><td style="padding:0 0 12px;font:15px/1.6 Arial,Helvetica,sans-serif;color:${CHARCOAL}">${esc(p).replace(/\n/g, '<br>')}</td></tr>`;
    if (bl.lines?.length)
      h += `<tr><td style="padding:0 0 4px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${bl.lines
        .map(
          (l) =>
            `<tr><td style="padding:9px 0;border-bottom:1px solid #ecece8;font:15px/1.45 Arial,Helvetica,sans-serif;color:${CHARCOAL}"><b>${esc(l.label)}</b>${l.detail ? `<br><span style="color:#6b6b64;font-size:13.5px">${esc(l.detail)}</span>` : ''}</td><td align="right" valign="top" style="padding:9px 0 9px 12px;border-bottom:1px solid #ecece8;font:15px/1.45 Arial,Helvetica,sans-serif;color:${CHARCOAL};white-space:nowrap">${l.price ? esc(l.price) : ''}</td></tr>`,
        )
        .join('')}</table></td></tr>`;
    if (bl.facts?.length)
      h += `<tr><td style="padding:0 0 6px"><table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${bl.facts
        .map(([k, v]) => `<tr><td valign="top" style="padding:4px 14px 4px 0;font:14px/1.5 Arial,Helvetica,sans-serif;color:#85857e;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;font:600 14.5px/1.5 Arial,Helvetica,sans-serif;color:${CHARCOAL}">${esc(v).replace(/\n/g, '<br>')}</td></tr>`)
        .join('')}</table></td></tr>`;
    if (bl.note) h += `<tr><td style="padding:6px 0 12px"><div style="background:#f4f6f2;border-left:3px solid ${GREEN};padding:10px 12px;font:14px/1.55 Arial,Helvetica,sans-serif;color:${CHARCOAL}">${esc(bl.note).replace(/\n/g, '<br>')}</div></td></tr>`;
    return h;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(i.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f2">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(i.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e4e4de">
<tr><td style="background:${CHARCOAL};padding:18px 24px"><table role="presentation" cellspacing="0" cellpadding="0"><tr>
<td style="padding-right:12px"><img src="${esc(logo)}" width="44" height="44" alt="" style="display:block;border-radius:50%;background:#ffffff"></td>
<td style="font:700 18px/1.2 Arial,Helvetica,sans-serif;color:#ffffff">${esc(b.name)}<br><span style="font:12px/1.5 Arial,Helvetica,sans-serif;color:#cfcfc8">${esc(b.tagline)}</span></td></tr></table></td></tr>
<tr><td style="padding:24px 24px 8px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">
${i.greeting ? `<tr><td style="padding:0 0 12px;font:15px/1.6 Arial,Helvetica,sans-serif;color:${CHARCOAL}">${esc(i.greeting)}</td></tr>` : ''}
${i.intro.map((p) => `<tr><td style="padding:0 0 12px;font:15px/1.6 Arial,Helvetica,sans-serif;color:${CHARCOAL}">${esc(p)}</td></tr>`).join('')}
${(i.blocks ?? []).map(blockHtml).join('')}
${i.cta ? `<tr><td style="padding:14px 0 18px"><a href="${esc(i.cta.url)}" style="display:inline-block;background:${GREEN};color:#ffffff;font:600 15px/1 Arial,Helvetica,sans-serif;text-decoration:none;padding:14px 20px;border-radius:10px">${esc(i.cta.label)}</a></td></tr>` : ''}
${(i.links ?? []).map((l) => `<tr><td style="padding:0 0 12px;font:14.5px/1.5 Arial,Helvetica,sans-serif"><a href="${esc(l.url)}" style="color:${GREEN};font-weight:600">${esc(l.label)}</a></td></tr>`).join('')}
${(i.closing ?? []).map((p) => `<tr><td style="padding:0 0 10px;font:15px/1.6 Arial,Helvetica,sans-serif;color:${CHARCOAL}">${esc(p).replace(/\n/g, '<br>')}</td></tr>`).join('')}
</table></td></tr>
<tr><td style="padding:16px 24px 22px;border-top:1px solid #ecece8;font:12.5px/1.6 Arial,Helvetica,sans-serif;color:#85857e">${esc(b.name)}${b.phone ? ` · ${esc(b.phone)}` : ''}${b.email ? ` · <a href="mailto:${esc(b.email)}" style="color:#85857e">${esc(b.email)}</a>` : ''}${
    i.footer ? `<br>${i.footer.url ? `<a href="${esc(i.footer.url)}" style="color:#85857e">${esc(i.footer.text)}</a>` : esc(i.footer.text)}` : ''
  }</td></tr>
</table></td></tr></table></body></html>`;

  const text: string[] = [];
  if (i.greeting) text.push(i.greeting, '');
  for (const p of i.intro) text.push(p, '');
  for (const bl of i.blocks ?? []) {
    if (bl.heading) text.push(bl.heading.toUpperCase());
    for (const p of bl.paragraphs ?? []) text.push(p);
    for (const l of bl.lines ?? []) text.push(`- ${l.label}${l.detail ? ` (${l.detail})` : ''}${l.price ? `  ${l.price}` : ''}`);
    for (const [k, v] of bl.facts ?? []) text.push(`${k}: ${v}`);
    if (bl.note) text.push(bl.note);
    text.push('');
  }
  if (i.cta) text.push(`${i.cta.label}: ${i.cta.url}`, '');
  for (const l of i.links ?? []) text.push(`${l.label}: ${l.url}`, '');
  for (const p of i.closing ?? []) text.push(p, '');
  text.push(`${b.name}${b.phone ? ` · ${b.phone}` : ''}${b.email ? ` · ${b.email}` : ''}`);
  if (i.footer) text.push(i.footer.url ? `${i.footer.text}: ${i.footer.url}` : i.footer.text);
  return { subject: i.subject, html, text: text.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n' };
}

export function signOff(): string[] {
  const b = getSettings().business;
  return ['Warm regards,', `The ${b.name} Team\n${b.tagline}`];
}

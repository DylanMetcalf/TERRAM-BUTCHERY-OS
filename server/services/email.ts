import nodemailer from 'nodemailer';
import { recordSystemEvent } from './health.js';

/**
 * Outgoing email (new online orders to the family). Uses any SMTP mailbox, e.g. the
 * business email account: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (and optionally
 * SMTP_FROM) on the server. Without them nothing is sent and everything else still works.
 */
export interface OutgoingEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string | null;
}

/** Test hook: EMAIL_TRANSPORT=memory collects messages here instead of sending them. */
export const outbox: OutgoingEmail[] = [];

/** SMTP settings as typed into the host's dashboard, forgiving stray spaces or quotes around a value. */
function env(name: string): string {
  let v = (process.env[name] ?? '').trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
  return v;
}

export function emailConfigured(): boolean {
  if (process.env.EMAIL_TRANSPORT === 'memory') return true;
  return !!(env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS'));
}

export function emailFrom(): string {
  return env('SMTP_FROM') || env('SMTP_USER') || 'terram@localhost';
}

/** What the server is set to use (never the password), for Settings and error messages. */
export function emailSetup() {
  const port = Number(env('SMTP_PORT') || 587);
  return { host: env('SMTP_HOST'), port, user: env('SMTP_USER'), secure: env('SMTP_SECURE') ? env('SMTP_SECURE') === 'true' : port === 465 };
}

/** Turns SMTP errors into something a person can act on. */
export function explainEmailError(e: any): string {
  const { host, port, user } = emailSetup();
  const raw = String(e?.response ?? e?.message ?? e);
  const code = String(e?.code ?? '');
  if (code === 'EAUTH' || /\b535\b|authentication|invalid login|username and password/i.test(raw)) {
    return `The email server turned down the login for ${user}. Check that SMTP_USER is the full email address and SMTP_PASS is that mailbox's current password (after a password reset, update it in Render too). Several wrong tries can briefly lock the account; wait 15 minutes before trying again. (${raw.slice(0, 120)})`;
  }
  if (/certificate|altname|self[- ]signed|CERT_/i.test(raw)) {
    return `The email server's security certificate doesn't match "${host}". Use the server name cPanel shows under Email Accounts → Connect Devices (e.g. cp71.domains.co.za) as SMTP_HOST.`;
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNECTION|ESOCKET|timed? ?out|greeting/i.test(code + ' ' + raw)) {
    return `Couldn't connect to ${host} on port ${port}. Check SMTP_HOST, and use port 465 (or 587 if your host says so).`;
  }
  return raw.slice(0, 240);
}

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransport() {
  if (!transport) {
    const { host, port, secure, user } = emailSetup();
    transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: env('SMTP_PASS') },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transport;
}

/** Sends one email. Throws on failure (callers decide whether that matters). */
export async function sendEmail(msg: OutgoingEmail): Promise<void> {
  const to = [...new Set(msg.to.map((x) => x.trim()).filter(Boolean))];
  if (!to.length) return;
  if (process.env.EMAIL_TRANSPORT === 'memory') {
    outbox.push({ ...msg, to });
    return;
  }
  if (!emailConfigured()) throw new Error('Email is not set up on the server (SMTP settings missing).');
  await getTransport().sendMail({ from: emailFrom(), to, subject: msg.subject, text: msg.text, html: msg.html, replyTo: msg.replyTo || undefined });
}

/** Fire-and-forget: never delays or fails the request that triggered it; failures show in System health. */
export function sendEmailInBackground(msg: OutgoingEmail, what: string) {
  if (!emailConfigured()) return;
  sendEmail(msg).catch((e) => recordSystemEvent('error', 'notifications', `Couldn't email ${what}`, explainEmailError(e)));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

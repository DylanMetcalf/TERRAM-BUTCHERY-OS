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

export function emailConfigured(): boolean {
  if (process.env.EMAIL_TRANSPORT === 'memory') return true;
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function emailFrom(): string {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'terram@localhost';
}

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
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
  sendEmail(msg).catch((e) => recordSystemEvent('error', 'notifications', `Couldn't email ${what}`, String(e?.message ?? e)));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

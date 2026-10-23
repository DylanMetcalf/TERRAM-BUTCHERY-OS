import crypto from 'node:crypto';
import { db, id, now } from '../db/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { Actor } from './audit.js';

/**
 * Private files (proof of payment, invoices). Stored inside the database, so they are included in
 * backups and are never reachable by a public URL: they are only streamed to a signed-in staff
 * member or to the customer holding that order's link. The content is checked, not the file name.
 */

export type FileKind = 'proof' | 'invoice';

const LIMITS: Record<FileKind, number> = { proof: 5 * 1024 * 1024, invoice: 10 * 1024 * 1024 };
const TYPES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/heic', ext: 'heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)$/.test(b.subarray(8, 12).toString('latin1')) },
];

export function detectType(buf: Buffer) {
  return TYPES.find((t) => t.test(buf)) ?? null;
}

export function storeFile(kind: FileKind, orderId: string, filename: string, buf: Buffer, actor: Actor): { id: string; filename: string; mime: string; size: number } {
  if (!buf.length) throw badRequest('The file is empty.');
  if (buf.length > LIMITS[kind]) throw badRequest(`The file is too big. The limit is ${LIMITS[kind] / 1024 / 1024} MB.`);
  const t = detectType(buf);
  const allowed = kind === 'invoice' ? ['application/pdf', 'image/jpeg', 'image/png'] : TYPES.map((x) => x.mime);
  if (!t || !allowed.includes(t.mime)) throw badRequest(kind === 'invoice' ? 'Upload the invoice as a PDF, JPG or PNG.' : 'Upload a PDF or a photo (JPG, PNG, WebP or HEIC).');
  const base = (filename || 'file').split(/[\\/]/).pop()!.replace(/[^\w.\- ()]/g, '_').slice(0, 80) || 'file';
  const name = base.toLowerCase().endsWith(`.${t.ext}`) ? base : `${base.replace(/\.[^.]*$/, '')}.${t.ext}`;
  const fid = id('fi_');
  db()
    .prepare('INSERT INTO files (id, kind, order_id, filename, mime, size, sha256, data, uploaded_by_kind, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(fid, kind, orderId, name, t.mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), buf, actor.kind, actor.userId, now());
  return { id: fid, filename: name, mime: t.mime, size: buf.length };
}

export function readFile(fileId: string, orderId?: string) {
  const f = db().prepare('SELECT * FROM files WHERE id = ?').get(fileId) as { id: string; kind: FileKind; order_id: string; filename: string; mime: string; size: number; data: Buffer } | undefined;
  if (!f || (orderId && f.order_id !== orderId)) throw notFound('That file');
  return f;
}

/** Headers for sending a private file: never cached by shared caches, never sniffed, downloaded rather than run. */
export function fileHeaders(f: { mime: string; filename: string; size: number }, inline = false): Record<string, string> {
  return {
    'Content-Type': f.mime,
    'Content-Length': String(f.size),
    'Content-Disposition': `${inline && f.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename="${f.filename.replace(/"/g, '')}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
}

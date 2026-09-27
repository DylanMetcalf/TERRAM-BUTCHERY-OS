import { Hono } from 'hono';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now } from '../db/db.js';
import { ROLES } from '../../shared/permissions.js';
import { badRequest } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { getSettings, updateSettings, type BusinessSettings } from '../services/settings.js';
import { exportDataset, report } from '../domain/reports.js';
import { createUser, listUsers, updateUser } from '../domain/users.js';
import { loadSampleData, removeSampleData, sampleDataStatus } from '../seed/sample.js';
import { actorOf, requirePerm, type Env } from '../http/context.js';
import { body, ymdParam } from '../http/schemas.js';
import { localDate, addDays } from '../lib/time.js';
import { businessTz } from '../services/settings.js';

const r = new Hono<Env>();

// ── Settings ────────────────────────────────────────────────
const SectionSchemas: Record<keyof BusinessSettings, z.ZodTypeAny> = {
  business: z.object({
    name: z.string().trim().min(1).max(120),
    tagline: z.string().max(200),
    phone: z.string().max(40),
    email: z.string().max(200),
    address: z.string().max(300),
    timezone: z.string().max(60).refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown timezone'),
    currency: z.string().length(3),
  }).partial(),
  orders: z.object({
    formOrdersRequireReview: z.boolean(),
    autoReadyAfterPacking: z.boolean(),
    leadTimeDays: z.number().int().min(0).max(30),
    duplicateWindowHours: z.number().int().min(1).max(24 * 30),
    stalledHours: z.number().int().min(1).max(24 * 30),
  }).partial(),
  fulfilment: z.object({
    collectionDays: z.array(z.number().int().min(0).max(6)).max(7),
    deliveryDays: z.array(z.number().int().min(0).max(6)).max(7),
    deliveryEnabled: z.boolean(),
    collectionHours: z.string().max(100),
    deliveryNotes: z.string().max(500),
  }).partial(),
  ai: z.object({
    enabled: z.boolean(),
    model: z.string().regex(/^claude-[a-z0-9.-]+$/, 'Unknown model').max(60),
    effort: z.enum(['low', 'medium', 'high']),
    learningThreshold: z.number().int().min(1).max(20),
  }).partial(),
  printing: z.object({ showPrices: z.boolean(), paper: z.enum(['A4', 'Letter']) }).partial(),
  customerForm: z.object({ enabled: z.boolean(), intro: z.string().max(600), confirmationMessage: z.string().max(600), showPrices: z.boolean() }).partial(),
};

r.get('/settings', requirePerm('settings.read'), (c) =>
  c.json({ settings: getSettings(), environment: { ai_key: !!process.env.ANTHROPIC_API_KEY, whatsapp: !!process.env.WHATSAPP_VERIFY_TOKEN, whatsapp_secret: !!process.env.WHATSAPP_APP_SECRET, email_inbound: !!process.env.EMAIL_INBOUND_TOKEN } }),
);

r.put('/settings/:section', requirePerm('settings.write'), async (c) => {
  const section = c.req.param('section') as keyof BusinessSettings;
  const schema = SectionSchemas[section];
  if (!schema) throw badRequest('Unknown settings section.');
  const value = await body(c, schema);
  const before = getSettings()[section];
  const settings = updateSettings(section, value, c.get('user')!.id);
  audit(actorOf(c), 'settings.updated', 'settings', section, `Updated ${section} settings`, { before, after: settings[section] });
  publish(['settings']);
  return c.json({ settings });
});

// ── Users ──────────────────────────────────────────────────
r.get('/users', requirePerm('users.manage'), (c) => c.json({ users: listUsers() }));
r.post('/users', requirePerm('users.manage'), async (c) => {
  const input = await body(c, z.object({ name: z.string().max(120), email: z.string().max(200), role: z.enum(ROLES), password: z.string().max(200) }));
  return c.json({ user: createUser(input, actorOf(c)) });
});
r.patch('/users/:id', requirePerm('users.manage'), async (c) => {
  const input = await body(c, z.object({ name: z.string().max(120).optional(), role: z.enum(ROLES).optional(), active: z.boolean().optional(), password: z.string().max(200).optional() }));
  if (c.req.param('id') === c.get('user')!.id && (input.active === false || (input.role && input.role !== 'admin'))) throw badRequest('You cannot remove your own admin access.');
  return c.json({ user: updateUser(c.req.param('id'), input, actorOf(c)) });
});

// ── Reports & exports ──────────────────────────────────────
r.get('/reports', requirePerm('reports.read'), (c) => {
  const today = localDate(new Date(), businessTz());
  const from = ymdParam(c.req.query('from')) ?? addDays(today, -30);
  const to = ymdParam(c.req.query('to')) ?? addDays(today, 7);
  return c.json(report(from, to));
});

r.get('/export/:kind', requirePerm('reports.read'), (c) => {
  const kind = c.req.param('kind').replace(/\.csv$/, '');
  const sensitive = ['customers', 'messages', 'audit'];
  if (sensitive.includes(kind) && !c.get('user') ) throw badRequest('Not allowed.');
  if (sensitive.includes(kind)) {
    const u = c.get('user')!;
    if (u.role !== 'admin') throw badRequest('Only an admin can export this data.');
  }
  const { filename, csv } = exportDataset(kind, ymdParam(c.req.query('from')) ?? undefined, ymdParam(c.req.query('to')) ?? undefined);
  audit(actorOf(c), 'data.exported', 'export', kind, `Exported ${kind}`);
  return c.body('﻿' + csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
});

/** Full JSON export — everything Terram owns, in an open format. */
r.get('/export-all', requirePerm('data.export'), (c) => {
  const tables = ['customers', 'products', 'product_aliases', 'product_preparations', 'orders', 'order_items', 'order_events', 'messages', 'interpretations', 'exceptions', 'import_batches', 'import_drafts', 'suggestions', 'audit_log', 'settings'];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = db().prepare(`SELECT * FROM ${t}`).all();
  out.users = db().prepare('SELECT id, name, email, role, active, created_at FROM users').all();
  audit(actorOf(c), 'data.exported', 'export', 'all', 'Full data export');
  return c.body(JSON.stringify({ exported_at: now(), version: 1, data: out }, null, 1), 200, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="terram-export-${now().slice(0, 10)}.json"`,
  });
});

/** Consistent point-in-time SQLite backup (safe while the app is running). */
r.get('/backup', requirePerm('data.export'), async (c) => {
  const file = path.join(os.tmpdir(), `terram-backup-${Date.now()}.db`);
  await db().backup(file);
  const buf = fs.readFileSync(file);
  fs.unlinkSync(file);
  audit(actorOf(c), 'data.backup', 'export', 'sqlite', 'Downloaded database backup');
  return c.body(buf, 200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="terram-${now().slice(0, 10)}.db"` });
});

r.get('/audit', requirePerm('settings.read'), (c) => {
  const rows = db()
    .prepare('SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.created_at DESC LIMIT 200')
    .all();
  return c.json({ entries: rows });
});

// ── Test mode / sample data ────────────────────────────────
r.get('/sample-data', requirePerm('settings.write'), (c) => c.json(sampleDataStatus()));
r.post('/sample-data', requirePerm('settings.write'), async (c) => {
  const { action } = await body(c, z.object({ action: z.enum(['load', 'remove']) }));
  if (action === 'load') await loadSampleData(actorOf(c));
  else removeSampleData(actorOf(c));
  publish(['orders', 'customers', 'exceptions', 'imports']);
  return c.json(sampleDataStatus());
});

export default r;

import { db, json } from '../db/db.js';
import { STATUS_LABEL, type OrderStatus } from '../../shared/workflow.js';
import { normalise } from '../../shared/text.js';
import { localDate } from '../lib/time.js';
import { businessTz, getSettings } from '../services/settings.js';
import { listProducts } from '../domain/products.js';
import { aiAvailable } from './ai.js';
import { listSuggestions } from './learning.js';
import { listBackups } from '../services/jobs.js';

/**
 * TERRAM OPERATIONS INTELLIGENCE — the read-only oversight layer.
 * Every module here observes and recommends. None of them change data;
 * changes only happen when a person approves them.
 */
export interface Finding {
  id: string;
  module: string;
  severity: 'info' | 'warning' | 'attention';
  title: string;
  detail: string;
  link?: string;
}

export function operationsIntelligence() {
  const settings = getSettings();
  const today = localDate(new Date(), businessTz());
  const findings: Finding[] = [];

  // Workflow Monitor — stalled and overdue orders
  const stalledSince = new Date(Date.now() - settings.orders.stalledHours * 3600_000).toISOString();
  const stalled = db()
    .prepare(
      `SELECT o.id, o.order_number, o.status, o.status_changed_at, c.name FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status IN ('review','needs_clarification','confirmed','cutting','cut','packing','packed') AND o.status_changed_at < ?
       ORDER BY o.status_changed_at LIMIT 20`,
    )
    .all(stalledSince) as any[];
  for (const s of stalled) {
    const hours = Math.round((Date.now() - Date.parse(s.status_changed_at)) / 3600_000);
    findings.push({
      id: `stalled:${s.id}`,
      module: 'Workflow Monitor',
      severity: hours > settings.orders.stalledHours * 2 ? 'attention' : 'warning',
      title: `#${s.order_number} (${s.name}) has been “${STATUS_LABEL[s.status as OrderStatus]}” for ${hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`}`,
      detail: 'Nothing has changed on this order for a while. Check whether it is stuck.',
      link: `/orders/${s.id}`,
    });
  }
  const overdue = db()
    .prepare(`SELECT o.id, o.order_number, o.requested_date, o.status, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.requested_date < ? AND o.status NOT IN ('completed','cancelled','on_hold') ORDER BY o.requested_date LIMIT 20`)
    .all(today) as any[];
  for (const o of overdue)
    findings.push({ id: `overdue:${o.id}`, module: 'Workflow Monitor', severity: 'attention', title: `#${o.order_number} (${o.name}) was due ${o.requested_date}`, detail: `Still “${STATUS_LABEL[o.status as OrderStatus]}”.`, link: `/orders/${o.id}` });

  // Data Quality
  const noDate = (db().prepare("SELECT COUNT(*) n FROM orders WHERE requested_date IS NULL AND status IN ('confirmed','cutting','cut','packing','packed','ready')").get() as any).n;
  if (noDate) findings.push({ id: 'dq:no-date', module: 'Data Quality', severity: 'warning', title: `${noDate} confirmed order${noDate === 1 ? ' has' : 's have'} no collection/delivery date`, detail: 'They appear on every cutting sheet until a date is set.', link: '/orders?filter=undated' });
  const noAddress = (db().prepare("SELECT COUNT(*) n FROM orders WHERE fulfilment_type = 'delivery' AND (delivery_address IS NULL OR delivery_address = '') AND status NOT IN ('completed','cancelled')").get() as any).n;
  if (noAddress) findings.push({ id: 'dq:no-address', module: 'Data Quality', severity: 'attention', title: `${noAddress} delivery order${noAddress === 1 ? ' has' : 's have'} no address`, detail: 'Add the address before the order goes out.', link: '/fulfilment' });
  const dupNames = db()
    .prepare("SELECT lower(name) n, COUNT(*) c FROM customers WHERE archived = 0 GROUP BY lower(name) HAVING c > 1 LIMIT 10")
    .all() as any[];
  for (const d of dupNames) findings.push({ id: `dq:dupname:${d.n}`, module: 'Data Quality', severity: 'info', title: `${d.c} customers are called “${d.n}”`, detail: 'Possibly the same person entered twice. Check their phone numbers.', link: `/customers?q=${encodeURIComponent(d.n)}` });
  const noPrice = listProducts().filter((p) => p.active && p.price_cents == null);
  if (noPrice.length) findings.push({ id: 'dq:no-price', module: 'Data Quality', severity: 'info', title: `${noPrice.length} active product${noPrice.length === 1 ? ' has' : 's have'} no price`, detail: noPrice.slice(0, 5).map((p) => p.canonical_name).join(', '), link: '/products' });

  // Improvement Analyst — recurring unknown phrases
  const aliases = new Set(listProducts().flatMap((p) => p.aliases.map((a) => a.alias)));
  const unknown = (db().prepare("SELECT key, COUNT(*) n, MAX(created_at) last FROM observations WHERE kind = 'unknown_phrase' GROUP BY key HAVING n >= 2 ORDER BY n DESC LIMIT 10").all() as any[]).filter(
    (u) => !aliases.has(normalise(u.key)),
  );
  for (const u of unknown)
    findings.push({ id: `unknown:${u.key}`, module: 'Improvement Analyst', severity: 'info', title: `“${u.key}” has come up ${u.n} times and isn't recognised`, detail: 'If it is something you sell, add it as a product or as another name for an existing product.', link: '/products' });

  // Bottlenecks — how long orders sit in each stage (last 30 days)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const transitions = db()
    .prepare("SELECT order_id, data, created_at FROM order_events WHERE type = 'status_changed' AND created_at >= ? ORDER BY order_id, created_at")
    .all(since) as any[];
  const stageTime: Record<string, number[]> = {};
  let prev: any = null;
  for (const t of transitions) {
    const d = json<any>(t.data, {});
    if (prev && prev.order_id === t.order_id) {
      const pd = json<any>(prev.data, {});
      if (pd.to === d.from) (stageTime[d.from] ??= []).push((Date.parse(t.created_at) - Date.parse(prev.created_at)) / 3600_000);
    }
    prev = t;
  }
  const stages = Object.entries(stageTime)
    .map(([status, hs]) => ({ status, label: STATUS_LABEL[status as OrderStatus] ?? status, avg_hours: Math.round((hs.reduce((a, b) => a + b, 0) / hs.length) * 10) / 10, samples: hs.length }))
    .filter((st) => st.samples >= 3 && st.avg_hours >= 0.05)
    .sort((a, b) => b.avg_hours - a.avg_hours);
  const created30 = (db().prepare('SELECT COUNT(*) n FROM orders WHERE created_at >= ?').get(since) as any).n || 0;
  const clarified30 = (db().prepare("SELECT COUNT(DISTINCT order_id) n FROM exceptions WHERE created_at >= ? AND order_id IS NOT NULL").get(since) as any).n || 0;
  const amended30 = (db().prepare("SELECT COUNT(DISTINCT order_id) n FROM order_events WHERE type IN ('item_amended','amendment_applied','item_removed') AND created_at >= ?").get(since) as any).n || 0;
  const dupImports = (db().prepare("SELECT COUNT(*) n FROM (SELECT content_hash FROM import_batches WHERE created_at >= ? GROUP BY content_hash HAVING COUNT(*) > 1)").get(since) as any).n || 0;
  if (created30 >= 10 && clarified30 / created30 > 0.25)
    findings.push({ id: 'bn:clarify', module: 'Bottleneck Detector', severity: 'warning', title: `${Math.round((clarified30 / created30) * 100)}% of orders needed clarification this month`, detail: 'Look at the most common exception types in Reports — often a few missing product names cause most of them.', link: '/reports' });
  if (dupImports) findings.push({ id: 'bn:dup-imports', module: 'Bottleneck Detector', severity: 'info', title: `The same WhatsApp text was imported more than once (${dupImports}×) this month`, detail: 'Duplicates were caught, but it may help to clear the chat after importing.' });
  const slowest = stages.find((s) => ['packing', 'cut', 'review', 'needs_clarification', 'confirmed'].includes(s.status) && s.samples >= 5 && s.avg_hours > 24);
  if (slowest) findings.push({ id: `bn:stage:${slowest.status}`, module: 'Bottleneck Detector', severity: 'info', title: `Orders spend on average ${slowest.avg_hours}h in “${slowest.label}”`, detail: 'This is the slowest stage at the moment.' });

  // Interpretation quality
  const interp = db()
    .prepare(
      `SELECT COUNT(DISTINCT message_id) msgs,
        COUNT(DISTINCT CASE WHEN engine = 'claude' THEN message_id END) ai_msgs,
        SUM(CASE WHEN engine = 'claude' AND error IS NOT NULL THEN 1 ELSE 0 END) ai_errors
       FROM interpretations WHERE created_at >= ?`,
    )
    .get(since) as any;

  // System Health
  const errors24 = (db().prepare("SELECT COUNT(*) n FROM system_events WHERE level = 'error' AND created_at >= ?").get(new Date(Date.now() - 86400_000).toISOString()) as any).n;
  if (errors24) findings.push({ id: 'health:errors', module: 'System Health', severity: 'warning', title: `${errors24} technical problem${errors24 === 1 ? '' : 's'} in the last 24 hours`, detail: 'See System health for details.', link: '/intelligence?tab=health' });

  const suggestions = listSuggestions('suggested');
  const modules = [
    { key: 'order-analyst', name: 'Order Analyst', role: 'Reads incoming messages and proposes orders', status: 'active', note: aiAvailable() ? 'Rules first, assistant for messy messages' : 'Rules engine (assistant not configured)' },
    { key: 'product-matcher', name: 'Product Matcher', role: 'Matches customer wording to your product list', status: 'active', note: `${listProducts().reduce((n, p) => n + p.aliases.length, 0)} known phrases` },
    { key: 'validation', name: 'Validation Engine', role: 'Checks every proposal against products, quantities and rules', status: 'active', note: 'Always on — nothing bypasses it' },
    { key: 'amendments', name: 'Amendment Analyst', role: 'Understands “actually make that 3kg”', status: 'active', note: `${amended30} order${amended30 === 1 ? '' : 's'} amended in 30 days` },
    { key: 'duplicates', name: 'Duplicate Detector', role: 'Flags repeated orders — never deletes', status: 'active', note: `Window: ${settings.orders.duplicateWindowHours}h` },
    { key: 'planner', name: 'Production Planner', role: 'Builds the cutting sheet from confirmed orders', status: 'active' },
    { key: 'workflow', name: 'Workflow Monitor', role: 'Finds stalled and overdue orders', status: stalled.length || overdue.length ? 'attention' : 'active', note: `${stalled.length} stalled · ${overdue.length} overdue` },
    { key: 'quality', name: 'Data Quality', role: 'Finds gaps and inconsistencies', status: 'active' },
    { key: 'improvement', name: 'Improvement Analyst', role: 'Learns from corrections — with your approval', status: suggestions.length ? 'attention' : 'active', note: `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} waiting` },
    { key: 'health', name: 'System Health', role: 'Watches imports, integrations and errors', status: errors24 ? 'attention' : 'active', note: `${errors24} errors in 24h` },
  ];
  return {
    findings,
    suggestions,
    modules,
    stages,
    stats: {
      orders_30d: created30,
      clarification_rate: created30 ? Math.round((clarified30 / created30) * 100) : 0,
      amendment_rate: created30 ? Math.round((amended30 / created30) * 100) : 0,
      messages_30d: interp?.msgs ?? 0,
      assistant_messages_30d: interp?.ai_msgs ?? 0,
      assistant_errors_30d: interp?.ai_errors ?? 0,
      rules_only_share: interp?.msgs ? Math.round(((interp.msgs - interp.ai_msgs) / interp.msgs) * 100) : 100,
    },
    ai: { available: aiAvailable(), configured: !!process.env.ANTHROPIC_API_KEY, enabled: settings.ai.enabled, model: settings.ai.model },
  };
}

export function systemHealth() {
  const day = new Date(Date.now() - 86400_000).toISOString();
  const week = new Date(Date.now() - 7 * 86400_000).toISOString();
  const events = db().prepare('SELECT * FROM system_events ORDER BY created_at DESC LIMIT 100').all();
  const byComponent = db().prepare("SELECT component, level, COUNT(*) n FROM system_events WHERE created_at >= ? GROUP BY component, level").all(week);
  const failedImports = db().prepare("SELECT id, created_at, error FROM import_batches WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10").all();
  const dbCheck = (db().prepare('PRAGMA quick_check').get() as any)?.quick_check ?? 'unknown';
  const fk = db().prepare('PRAGMA foreign_key_check').all().length;
  const orphanItems = (db().prepare('SELECT COUNT(*) n FROM order_items i LEFT JOIN orders o ON o.id = i.order_id WHERE o.id IS NULL').get() as any).n;
  const stuckImports = (db().prepare("SELECT COUNT(*) n FROM import_batches WHERE status = 'analysing' AND created_at < ?").get(new Date(Date.now() - 15 * 60_000).toISOString()) as any).n;
  const pageCount = (db().prepare('PRAGMA page_count').get() as any).page_count;
  const pageSize = (db().prepare('PRAGMA page_size').get() as any).page_size;
  const errors24 = (db().prepare("SELECT COUNT(*) n FROM system_events WHERE level = 'error' AND created_at >= ?").get(day) as any).n;
  return {
    status: dbCheck === 'ok' && fk === 0 && orphanItems === 0 && errors24 === 0 ? 'healthy' : dbCheck !== 'ok' || fk ? 'problem' : 'attention',
    checks: [
      { key: 'database', label: 'Database integrity', ok: dbCheck === 'ok', detail: dbCheck === 'ok' ? 'All good' : String(dbCheck) },
      { key: 'references', label: 'Data references', ok: fk === 0 && orphanItems === 0, detail: fk || orphanItems ? `${fk + orphanItems} broken references` : 'All good' },
      { key: 'imports', label: 'Imports', ok: stuckImports === 0, detail: stuckImports ? `${stuckImports} import(s) stuck while analysing` : 'No stuck imports' },
      { key: 'assistant', label: 'Message assistant', ok: true, detail: aiAvailable() ? `Enabled (${getSettings().ai.model})` : process.env.ANTHROPIC_API_KEY ? 'Turned off in settings' : 'Not configured — rules engine only' },
      { key: 'whatsapp', label: 'WhatsApp integration', ok: true, detail: process.env.WHATSAPP_VERIFY_TOKEN ? 'Webhook configured' : 'Not connected (use WhatsApp import)' },
      { key: 'errors', label: 'Errors (24h)', ok: errors24 === 0, detail: errors24 ? `${errors24} error(s)` : 'None' },
      (() => {
        const b = listBackups()[0];
        const ageH = b ? (Date.now() - Date.parse(b.created_at)) / 3600_000 : Infinity;
        return { key: 'backup', label: 'Nightly backup', ok: ageH < 36, detail: b ? `Last backup ${Math.round(ageH)}h ago · ${listBackups().length} kept on the server` : 'No backup yet — the first runs after 2am' };
      })(),
    ],
    database_size_bytes: pageCount * pageSize,
    events,
    by_component: byComponent,
    failed_imports: failedImports,
    uptime_seconds: Math.round(process.uptime()),
    version: process.env.npm_package_version ?? '1.0.0',
  };
}

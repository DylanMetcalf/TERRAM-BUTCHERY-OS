import { db, id, json, now, tx } from '../db/db.js';
import { normalise } from '../../shared/text.js';
import { CATALOGUE, DRY_AGED_SURCHARGE_PCT, ORDERING_RULES, type SeedProduct } from '../seed/catalogue.js';
import { audit, SYSTEM, type Actor } from '../services/audit.js';
import { publish } from '../services/realtime.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { QuantityType } from '../../shared/quantity.js';
import { parseSaleOptions, type SaleOption } from '../../shared/pricing.js';

export interface Preparation {
  id: string;
  product_id: string;
  group_name: string;
  name: string;
  keywords: string[];
  is_default: boolean;
  customer_visible: boolean;
  active: boolean;
  sort_order: number;
  /** Extra charge for this option, e.g. 25 for dry-aged (+25%). */
  surcharge_pct: number;
}

export interface Product {
  id: string;
  slug: string;
  canonical_name: string;
  customer_name: string;
  category: string;
  description: string | null;
  quantity_type: QuantityType;
  allows_portions: boolean;
  piece_noun: string;
  typical_piece_g: number | null;
  /** Sold only in multiples of this many pieces (eggs: 30, a tray). */
  pack_size: number | null;
  price_cents: number | null;
  price_unit: 'kg' | 'each' | null;
  packaging: string | null;
  active: boolean;
  customer_visible: boolean;
  internal_notes: string | null;
  sort_order: number;
  /** Fixed packs or whole/half pieces customers must choose from (empty = order by weight or count). */
  sale_options: SaleOption[];
  min_qty: number | null;
  max_qty: number | null;
  /** Shown on the order form as an option of another product (e.g. Rib-Eye "On the bone"). */
  variant_of: string | null;
  variant_label: string | null;
  /** Why it can't be ordered right now, shown to customers when out of stock. */
  unavailable_reason: string | null;
  image: string | null;
  aliases: { id: string; alias: string; source: string }[];
  preparations: Preparation[];
}

/** Categories in the order their first product appears (the price-list order). */
export function categoryOrder(): string[] {
  return [...new Set(listProducts().map((p) => p.category))];
}

function rowToProduct(r: any, aliases: any[], preps: any[]): Product {
  return {
    id: r.id,
    slug: r.slug,
    canonical_name: r.canonical_name,
    customer_name: r.customer_name,
    category: r.category,
    description: r.description,
    quantity_type: r.quantity_type,
    allows_portions: !!r.allows_portions,
    piece_noun: r.piece_noun,
    typical_piece_g: r.typical_piece_g,
    pack_size: r.pack_size ?? null,
    price_cents: r.price_cents,
    price_unit: r.price_unit,
    packaging: r.packaging,
    active: !!r.active,
    customer_visible: !!r.customer_visible,
    internal_notes: r.internal_notes,
    sort_order: r.sort_order,
    sale_options: parseSaleOptions(r.sale_options),
    min_qty: r.min_qty ?? null,
    max_qty: r.max_qty ?? null,
    variant_of: r.variant_of ?? null,
    variant_label: r.variant_label ?? null,
    unavailable_reason: r.unavailable_reason ?? null,
    image: r.image ?? null,
    aliases: aliases.map((a) => ({ id: a.id, alias: a.alias, source: a.source })),
    preparations: preps.map((p) => ({
      id: p.id,
      product_id: p.product_id,
      group_name: p.group_name,
      name: p.name,
      keywords: json<string[]>(p.keywords, []),
      is_default: !!p.is_default,
      customer_visible: !!p.customer_visible,
      active: !!p.active,
      sort_order: p.sort_order,
      surcharge_pct: Number(p.surcharge_pct ?? 0),
    })),
  };
}

let cache: Product[] | null = null;

export function invalidateProducts() {
  cache = null;
}

export function listProducts(): Product[] {
  if (cache) return cache;
  const rows = db().prepare('SELECT * FROM products ORDER BY sort_order, canonical_name').all() as any[];
  const aliases = db().prepare('SELECT * FROM product_aliases ORDER BY alias').all() as any[];
  const preps = db().prepare('SELECT * FROM product_preparations ORDER BY group_name, sort_order').all() as any[];
  const byProduct = <T extends { product_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) (m.get(x.product_id) ?? m.set(x.product_id, []).get(x.product_id)!).push(x);
    return m;
  };
  const am = byProduct(aliases);
  const pm = byProduct(preps);
  cache = rows.map((r) => rowToProduct(r, am.get(r.id) ?? [], pm.get(r.id) ?? []));
  return cache;
}

export function getProduct(productId: string): Product | undefined {
  return listProducts().find((p) => p.id === productId);
}

export function requireProduct(productId: string): Product {
  const p = getProduct(productId);
  if (!p) throw notFound('That product');
  return p;
}

/** Group structure used by forms: { groupName: [options...] } with defaults. */
export function prepGroups(p: Product, opts: { customerOnly?: boolean } = {}) {
  const groups = new Map<string, Preparation[]>();
  for (const prep of p.preparations) {
    if (!prep.active) continue;
    if (opts.customerOnly && !prep.customer_visible) continue;
    (groups.get(prep.group_name) ?? groups.set(prep.group_name, []).get(prep.group_name)!).push(prep);
  }
  return [...groups.entries()].map(([group, options]) => ({ group, options }));
}

/**
 * Validates a preparation selection against the product's rules and fills
 * defaults. Returns the canonical selection and a human label. Throws on
 * anything not allowed — preparation must never be free-form invented.
 */
export function resolvePreparation(p: Product, selection: Record<string, string> | undefined): { preparation: Record<string, string>; label: string } {
  const groups = prepGroups(p);
  const out: Record<string, string> = {};
  for (const key of Object.keys(selection ?? {})) {
    if (!groups.some((g) => g.group === key)) throw badRequest(`${p.canonical_name} has no "${key}" option.`);
  }
  for (const g of groups) {
    const chosen = selection?.[g.group];
    if (chosen) {
      const opt = g.options.find((o) => o.name === chosen);
      if (!opt) throw badRequest(`"${chosen}" is not a valid ${g.group.toLowerCase()} option for ${p.canonical_name}.`);
      out[g.group] = opt.name;
    } else {
      const def = g.options.find((o) => o.is_default) ?? null;
      if (def) out[g.group] = def.name;
    }
  }
  return { preparation: out, label: preparationLabel(p, out) };
}

/** Label only shows non-default choices — the blockman needs to see what is different. */
export function preparationLabel(p: Product, prep: Record<string, string>): string {
  const parts: string[] = [];
  for (const g of prepGroups(p)) {
    const v = prep[g.group];
    if (!v) continue;
    const def = g.options.find((o) => o.is_default);
    if (def && def.name === v) continue;
    parts.push(v);
  }
  return parts.join(' · ');
}

// ── Mutations (admin/manager) ─────────────────────────────

export interface ProductInput {
  canonical_name: string;
  customer_name?: string | null;
  category: string;
  description?: string | null;
  quantity_type: QuantityType;
  allows_portions?: boolean;
  piece_noun?: string;
  typical_piece_g?: number | null;
  pack_size?: number | null;
  price_cents?: number | null;
  price_unit?: 'kg' | 'each' | null;
  packaging?: string | null;
  active?: boolean;
  customer_visible?: boolean;
  internal_notes?: string | null;
  sale_options?: SaleOption[] | null;
  min_qty?: number | null;
  max_qty?: number | null;
  variant_of?: string | null;
  variant_label?: string | null;
  unavailable_reason?: string | null;
  image?: string | null;
  aliases?: string[];
  preparations?: Array<{ group_name: string; name: string; keywords?: string[]; is_default?: boolean; customer_visible?: boolean; active?: boolean; surcharge_pct?: number }>;
}

function slugify(s: string) {
  return normalise(s).replace(/ /g, '_').slice(0, 60) || 'product';
}

function assertAliasesFree(aliases: string[], productId: string | null) {
  for (const a of aliases) {
    const row = db().prepare('SELECT a.product_id, p.canonical_name FROM product_aliases a JOIN products p ON p.id = a.product_id WHERE a.alias = ?').get(a) as any;
    if (row && row.product_id !== productId) throw conflict(`"${a}" already means ${row.canonical_name}. One phrase can only point to one product.`);
  }
}

function writePreparations(productId: string, preps: NonNullable<ProductInput['preparations']>) {
  const seenDefault = new Set<string>();
  db().prepare('DELETE FROM product_preparations WHERE product_id = ?').run(productId);
  const ins = db().prepare('INSERT INTO product_preparations (id, product_id, group_name, name, keywords, is_default, customer_visible, active, sort_order, surcharge_pct) VALUES (?,?,?,?,?,?,?,?,?,?)');
  preps.forEach((p, i) => {
    const group = p.group_name.trim();
    const name = p.name.trim();
    if (!group || !name) throw badRequest('Each preparation option needs a group and a name.');
    let isDefault = !!p.is_default;
    if (isDefault && seenDefault.has(group)) isDefault = false;
    if (isDefault) seenDefault.add(group);
    const kws = [...new Set((p.keywords ?? []).map((k) => normalise(k)).filter(Boolean))];
    const surcharge = Number(p.surcharge_pct ?? 0);
    if (!Number.isFinite(surcharge) || surcharge < 0 || surcharge > 200) throw badRequest(`The surcharge for "${name}" must be between 0% and 200%.`);
    ins.run(id('pp_'), productId, group, name, JSON.stringify(kws), isDefault ? 1 : 0, p.customer_visible === false ? 0 : 1, p.active === false ? 0 : 1, i, surcharge);
  });
}

/** Ordering rules: pack/piece options, quantity limits, variant grouping. Checked so customers can't be offered nonsense. */
function writeRules(productId: string, input: Partial<ProductInput>) {
  const f: Record<string, unknown> = {};
  if ('sale_options' in input) {
    const opts = parseSaleOptions(input.sale_options ?? []);
    if ((input.sale_options ?? []).length !== opts.length) throw badRequest('Each pack option needs a name, and fixed packs need a weight in grams.');
    f.sale_options = opts.length ? JSON.stringify(opts) : null;
  }
  for (const k of ['min_qty', 'max_qty'] as const) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v != null && (!Number.isInteger(v) || v < 1 || v > 100000)) throw badRequest('Quantity limits must be whole numbers.');
    f[k] = v ?? null;
  }
  if ('variant_of' in input) {
    const parent = input.variant_of || null;
    if (parent) {
      if (parent === productId) throw badRequest('A product can’t be an option of itself.');
      const pp = db().prepare('SELECT variant_of FROM products WHERE id = ?').get(parent) as { variant_of: string | null } | undefined;
      if (!pp) throw notFound('That product');
      if (pp.variant_of) throw badRequest('Choose the main product, not one of its options.');
    }
    f.variant_of = parent;
  }
  if ('variant_label' in input) f.variant_label = input.variant_label?.trim() || null;
  if ('unavailable_reason' in input) f.unavailable_reason = input.unavailable_reason?.trim().slice(0, 200) || null;
  if ('image' in input) {
    const img = input.image ?? null;
    if (img && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 400_000)) throw badRequest('Use a PNG, JPG or WebP image under 300 KB.');
    f.image = img;
  }
  if (!Object.keys(f).length) return;
  db().prepare(`UPDATE products SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(f), now(), productId);
  const row = db().prepare('SELECT min_qty, max_qty FROM products WHERE id = ?').get(productId) as { min_qty: number | null; max_qty: number | null };
  if (row.min_qty != null && row.max_qty != null && row.min_qty > row.max_qty) throw badRequest('The minimum can’t be more than the maximum.');
}

export function createProduct(input: ProductInput, actor: Actor): Product {
  const productId = id('pr_');
  const name = input.canonical_name.trim();
  if (!name) throw badRequest('The product needs a name.');
  const aliases = [...new Set([name, input.customer_name ?? '', ...(input.aliases ?? [])].map(normalise).filter(Boolean))];
  tx(() => {
    assertAliasesFree(aliases, null);
    let slug = slugify(name);
    if (db().prepare('SELECT 1 FROM products WHERE slug = ?').get(slug)) slug = `${slug}_${productId.slice(-4).toLowerCase()}`;
    const ts = now();
    const maxSort = (db().prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM products').get() as any).m;
    db()
      .prepare(
        `INSERT INTO products (id, slug, canonical_name, customer_name, category, description, quantity_type, allows_portions, piece_noun, typical_piece_g, price_cents, price_unit, packaging, active, customer_visible, internal_notes, sort_order, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        productId, slug, name, (input.customer_name || name).trim(), input.category, input.description ?? null, input.quantity_type,
        input.allows_portions ? 1 : 0, input.piece_noun || 'piece', input.typical_piece_g ?? null, input.price_cents ?? null,
        input.price_unit ?? null, input.packaging ?? null, input.active === false ? 0 : 1, input.customer_visible === false ? 0 : 1,
        input.internal_notes ?? null, maxSort + 1, ts, ts,
      );
    const ins = db().prepare('INSERT INTO product_aliases (id, product_id, alias, source, created_by, created_at) VALUES (?,?,?,?,?,?)');
    for (const a of aliases) ins.run(id('pa_'), productId, a, 'admin', actor.userId, ts);
    writePreparations(productId, input.preparations ?? []);
    writeRules(productId, input);
    audit(actor, 'product.created', 'product', productId, `Added product ${name}`, input);
  });
  invalidateProducts();
  publish(['products']);
  return requireProduct(productId);
}

export function updateProduct(productId: string, input: Partial<ProductInput>, actor: Actor): Product {
  const before = requireProduct(productId);
  tx(() => {
    const fields: Record<string, unknown> = {};
    const map: Array<[keyof ProductInput, string, (v: any) => unknown]> = [
      ['canonical_name', 'canonical_name', (v) => String(v).trim()],
      ['customer_name', 'customer_name', (v) => (v ? String(v).trim() : null)],
      ['category', 'category', String],
      ['description', 'description', (v) => v ?? null],
      ['quantity_type', 'quantity_type', String],
      ['allows_portions', 'allows_portions', (v) => (v ? 1 : 0)],
      ['piece_noun', 'piece_noun', (v) => v || 'piece'],
      ['typical_piece_g', 'typical_piece_g', (v) => v ?? null],
      ['pack_size', 'pack_size', (v) => v ?? null],
      ['price_cents', 'price_cents', (v) => v ?? null],
      ['price_unit', 'price_unit', (v) => v ?? null],
      ['packaging', 'packaging', (v) => v ?? null],
      ['active', 'active', (v) => (v ? 1 : 0)],
      ['customer_visible', 'customer_visible', (v) => (v ? 1 : 0)],
      ['internal_notes', 'internal_notes', (v) => v ?? null],
    ];
    for (const [k, col, conv] of map) if (k in input) fields[col] = conv((input as any)[k]);
    if (fields.customer_name === null) fields.customer_name = fields.canonical_name ?? before.canonical_name;
    if (Object.keys(fields).length) {
      const sets = Object.keys(fields).map((c) => `${c} = ?`).join(', ');
      db().prepare(`UPDATE products SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(fields), now(), productId);
    }
    if (input.aliases) {
      const name = (input.canonical_name ?? before.canonical_name).trim();
      const wanted = [...new Set([name, ...input.aliases].map(normalise).filter(Boolean))];
      assertAliasesFree(wanted, productId);
      const existing = new Map(before.aliases.map((a) => [a.alias, a]));
      for (const a of before.aliases) if (!wanted.includes(a.alias)) db().prepare('DELETE FROM product_aliases WHERE id = ?').run(a.id);
      const ins = db().prepare('INSERT INTO product_aliases (id, product_id, alias, source, created_by, created_at) VALUES (?,?,?,?,?,?)');
      for (const a of wanted) if (!existing.has(a)) ins.run(id('pa_'), productId, a, 'admin', actor.userId, now());
    }
    if (input.preparations) writePreparations(productId, input.preparations);
    writeRules(productId, input);
    const priceChanged = 'price_cents' in input && input.price_cents !== before.price_cents;
    audit(actor, priceChanged ? 'product.price_changed' : 'product.updated', 'product', productId, `Updated ${before.canonical_name}`, {
      before: { ...before, aliases: before.aliases.map((a) => a.alias) },
      changes: input,
    });
  });
  invalidateProducts();
  publish(['products']);
  return requireProduct(productId);
}

/** Adds a single alias — the endpoint the learning loop uses after human approval. */
export function addAlias(productId: string, phrase: string, source: 'admin' | 'learned', actor: Actor) {
  const p = requireProduct(productId);
  const alias = normalise(phrase);
  if (!alias) throw badRequest('That phrase is empty.');
  assertAliasesFree([alias], productId);
  if (p.aliases.some((a) => a.alias === alias)) return p;
  db().prepare('INSERT INTO product_aliases (id, product_id, alias, source, created_by, created_at) VALUES (?,?,?,?,?,?)').run(id('pa_'), productId, alias, source, actor.userId, now());
  audit(actor, 'product.alias_added', 'product', productId, `"${phrase}" now means ${p.canonical_name}`, { alias, source });
  invalidateProducts();
  publish(['products']);
  return requireProduct(productId);
}

export function seedCatalogue(catalogue: SeedProduct[] = CATALOGUE) {
  const count = (db().prepare('SELECT COUNT(*) c FROM products').get() as any).c;
  if (count > 0) return;
  insertCatalogue(catalogue, 0);
  applyOrderingRules(true);
}

const ORDERING_RULES_VERSION = 1;

/**
 * One-time defaults for how customers order (packs, whole/half pieces, variants, dry-aged surcharge,
 * packaging as an internal standard). Fills in only what hasn't been set, so the family's own
 * changes under Products are never overwritten.
 */
export function applyOrderingRules(force = false) {
  const row = db().prepare("SELECT value FROM settings WHERE key = 'ordering_rules_version'").get() as { value: string } | undefined;
  if (!force && row && Number(JSON.parse(row.value)) >= ORDERING_RULES_VERSION) return;
  tx(() => {
    const bySlug = new Map((db().prepare('SELECT id, slug, sale_options, variant_of, variant_label FROM products').all() as any[]).map((r) => [r.slug, r]));
    for (const [slug, rule] of Object.entries(ORDERING_RULES)) {
      const p = bySlug.get(slug);
      if (!p) continue;
      if (rule.sale_options && !p.sale_options) db().prepare('UPDATE products SET sale_options = ? WHERE id = ?').run(JSON.stringify(rule.sale_options), p.id);
      if (rule.variant_of && !p.variant_of && bySlug.get(rule.variant_of)) db().prepare('UPDATE products SET variant_of = ? WHERE id = ?').run(bySlug.get(rule.variant_of).id, p.id);
      if (rule.variant_label && !p.variant_label) db().prepare('UPDATE products SET variant_label = ? WHERE id = ?').run(rule.variant_label, p.id);
    }
    // Everything is vacuum packed as standard: packaging is no longer a customer choice
    db().prepare("UPDATE product_preparations SET customer_visible = 0 WHERE group_name = 'Packing'").run();
    db().prepare("UPDATE product_preparations SET surcharge_pct = ? WHERE group_name = 'Ageing' AND name = 'Dry-aged' AND surcharge_pct = 0").run(DRY_AGED_SURCHARGE_PCT);
    db()
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('ordering_rules_version', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(ORDERING_RULES_VERSION), now());
  });
  invalidateProducts();
}

/** Bump when server/seed/catalogue.ts changes in a way existing installs should receive. */
export const CATALOGUE_VERSION = 3;

/**
 * Brings an existing install onto Terram's real price list (version 2 replaced
 * the generic starter products). If no orders exist yet, the starter products
 * are replaced outright. Otherwise nothing is removed: Terram products that are
 * missing are added and starter products Terram doesn't sell are switched off,
 * so past orders keep their products.
 */
export function upgradeCatalogue() {
  const row = db().prepare("SELECT value FROM settings WHERE key = 'catalogue_version'").get() as { value: string } | undefined;
  const current = row ? Number(JSON.parse(row.value)) : 0;
  if (current >= CATALOGUE_VERSION) return;
  const setVersion = () =>
    db()
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('catalogue_version', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(CATALOGUE_VERSION), now());
  const slugs = new Set((db().prepare('SELECT slug FROM products').all() as { slug: string }[]).map((r) => r.slug));
  const terramSlugs = new Set(CATALOGUE.map((p) => p.slug));
  // Fresh install (seeded with the current catalogue) or already Terram's list
  if (!slugs.size || [...terramSlugs].every((s) => slugs.has(s))) {
    setVersion();
    return;
  }
  const orders = (db().prepare('SELECT COUNT(*) n FROM order_items').get() as { n: number }).n;
  tx(() => {
    if (orders === 0) {
      db().prepare('DELETE FROM products').run();
      insertCatalogue(CATALOGUE, 0);
    } else {
      // Switch off starter products Terram doesn't sell and free their words for Terram's products
      const retired = [...slugs].filter((s) => !terramSlugs.has(s));
      const off = db().prepare('UPDATE products SET active = 0, customer_visible = 0, updated_at = ? WHERE slug = ?');
      const freeAliases = db().prepare("DELETE FROM product_aliases WHERE source = 'seed' AND product_id = (SELECT id FROM products WHERE slug = ?)");
      for (const s of retired) {
        off.run(now(), s);
        freeAliases.run(s);
      }
      // Products on both lists take the price-list name, section and price
      const refresh = db().prepare('UPDATE products SET canonical_name = ?, customer_name = ?, category = ?, price_cents = ?, price_unit = ?, updated_at = ? WHERE slug = ?');
      for (const p of CATALOGUE.filter((x) => slugs.has(x.slug))) refresh.run(p.name, p.customer_name ?? p.name, p.category, p.price_cents ?? null, p.price_unit ?? null, now(), p.slug);
      const maxSort = (db().prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM products').get() as { m: number }).m;
      insertCatalogue(CATALOGUE.filter((p) => !slugs.has(p.slug)), maxSort + 1);
    }
    setVersion();
    audit(SYSTEM, 'product.catalogue_upgraded', 'system', null, orders === 0 ? "Loaded Terram's price list as the product list" : "Added Terram's price list products; starter products Terram doesn't sell were switched off");
  });
  invalidateProducts();
}

function insertCatalogue(catalogue: SeedProduct[], sortFrom: number) {
  tx(() => {
    const ts = now();
    const insP = db().prepare(
      `INSERT INTO products (id, slug, canonical_name, customer_name, category, description, quantity_type, allows_portions, piece_noun, typical_piece_g, price_cents, price_unit, active, customer_visible, internal_notes, pack_size, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
    );
    const insA = db().prepare('INSERT OR IGNORE INTO product_aliases (id, product_id, alias, source, created_at) VALUES (?,?,?,?,?)');
    catalogue.forEach((s, i) => {
      const pid = id('pr_');
      insP.run(pid, s.slug, s.name, s.customer_name ?? s.name, s.category, s.description ?? null, s.quantity_type, s.allows_portions ? 1 : 0, s.piece_noun ?? 'piece', s.typical_piece_g ?? null, s.price_cents ?? null, s.price_unit ?? null, s.customer_visible === false ? 0 : 1, s.internal_notes ?? null, s.pack_size ?? null, sortFrom + i, ts, ts);
      const aliases = new Set([s.name, s.customer_name ?? s.name, ...s.aliases].map(normalise).filter(Boolean));
      for (const a of aliases) insA.run(id('pa_'), pid, a, 'seed', ts);
      const preps = Object.entries(s.preps ?? {}).flatMap(([group, opts]) => opts.map(([name, keywords, isDefault]) => ({ group_name: group, name, keywords, is_default: !!isDefault })));
      writePreparations(pid, preps);
    });
  });
  invalidateProducts();
}

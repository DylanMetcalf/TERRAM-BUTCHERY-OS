/**
 * Database schema. Migrations are append-only: never edit a shipped migration,
 * add a new one. Each runs once inside a transaction and is recorded in _migrations.
 */
export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'core',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','staff','viewer')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- sha256 of the cookie token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  phone_normalized TEXT,
  email TEXT COLLATE NOCASE,
  address TEXT,
  notes TEXT,
  preferred_fulfilment TEXT CHECK (preferred_fulfilment IN ('collection','delivery')),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_phone ON customers(phone_normalized);
CREATE INDEX idx_customers_name ON customers(name COLLATE NOCASE);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  quantity_type TEXT NOT NULL CHECK (quantity_type IN ('weight','count','either')),
  allows_portions INTEGER NOT NULL DEFAULT 0,
  piece_noun TEXT NOT NULL DEFAULT 'piece',
  typical_piece_g INTEGER,
  price_cents INTEGER,
  price_unit TEXT CHECK (price_unit IN ('kg','each')),
  packaging TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  customer_visible INTEGER NOT NULL DEFAULT 1,
  internal_notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE product_aliases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE,     -- normalised form
  source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('seed','admin','learned')),
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_aliases_product ON product_aliases(product_id);

-- Preparation options, grouped (e.g. group "Bone": Bone-in / Boneless)
CREATE TABLE product_preparations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',   -- JSON array of phrases that select this option
  is_default INTEGER NOT NULL DEFAULT 0,
  customer_visible INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, group_name, name)
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('analysing','review','committed','failed','discarded')),
  stats TEXT NOT NULL DEFAULT '{}',
  reference_date TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  error TEXT
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  key TEXT NOT NULL,              -- phone number or normalised sender name
  customer_id TEXT REFERENCES customers(id),
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (channel, key)
);

-- Every piece of raw input, preserved forever.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_id TEXT,               -- e.g. WhatsApp message id (idempotency)
  conversation_id TEXT REFERENCES conversations(id),
  import_batch_id TEXT REFERENCES import_batches(id),
  direction TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  sender_name TEXT,
  sender_phone TEXT,
  customer_id TEXT REFERENCES customers(id),
  body TEXT NOT NULL,
  sent_at TEXT,
  received_at TEXT NOT NULL,
  classification TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','ignored','exception')),
  order_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_messages_external ON messages(channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_messages_conversation ON messages(conversation_id, received_at);
CREATE INDEX idx_messages_order ON messages(order_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  order_number INTEGER NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  resume_status TEXT,             -- where to go once clarification/hold is cleared
  fulfilment_type TEXT CHECK (fulfilment_type IN ('collection','delivery')),
  requested_date TEXT,            -- YYYY-MM-DD in business timezone
  time_window TEXT,
  delivery_address TEXT,
  delivery_notes TEXT,
  contact_phone TEXT,
  notes TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','pending','paid')),
  accounting_ref TEXT,
  customer_notified_at TEXT,
  import_batch_id TEXT REFERENCES import_batches(id),
  idempotency_key TEXT UNIQUE,
  created_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  completed_at TEXT,
  status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date ON orders(requested_date);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  qty_kind TEXT NOT NULL CHECK (qty_kind IN ('weight','count','portions')),
  count INTEGER,
  weight_g INTEGER,
  preparation TEXT NOT NULL DEFAULT '{}',   -- JSON {group: optionName}
  preparation_label TEXT NOT NULL DEFAULT '',
  special_instructions TEXT,
  source_text TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  cut_at TEXT,
  cut_by TEXT,
  packed_at TEXT,
  packed_by TEXT,
  packed_weight_g INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_items_order ON order_items(order_id);
CREATE INDEX idx_items_product ON order_items(product_id);

CREATE TABLE order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','system','customer')),
  actor_user_id TEXT REFERENCES users(id),
  message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_order ON order_events(order_id, created_at);

CREATE TABLE interpretations (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id),
  import_batch_id TEXT REFERENCES import_batches(id),
  engine TEXT NOT NULL,           -- 'rules' | 'claude'
  model TEXT,
  engine_version TEXT NOT NULL,
  raw_input TEXT NOT NULL,
  output TEXT NOT NULL,           -- validated structured interpretation (JSON)
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  intent TEXT,
  resulting_action TEXT,
  latency_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_interp_message ON interpretations(message_id);
CREATE INDEX idx_interp_batch ON interpretations(import_batch_id);

-- Proposed orders/amendments from an import, awaiting confirmation.
CREATE TABLE import_drafts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('order','amendment','cancellation','ignored')),
  data TEXT NOT NULL,             -- JSON draft (customer, items, fulfilment, issues…)
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  status TEXT NOT NULL CHECK (status IN ('ready','needs_review','committed','discarded')),
  order_id TEXT REFERENCES orders(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_drafts_batch ON import_drafts(batch_id, position);

CREATE TABLE exceptions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocking','warning','info')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  title TEXT NOT NULL,
  detail TEXT,
  order_id TEXT REFERENCES orders(id),
  message_id TEXT REFERENCES messages(id),
  customer_id TEXT REFERENCES customers(id),
  import_batch_id TEXT REFERENCES import_batches(id),
  interpretation_id TEXT REFERENCES interpretations(id),
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  resolution TEXT,
  resolution_note TEXT,
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_exceptions_status ON exceptions(status, created_at);
CREATE INDEX idx_exceptions_order ON exceptions(order_id);
CREATE UNIQUE INDEX idx_exceptions_dedupe ON exceptions(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'open';

-- Learning loop: observed → suggested → reviewed → approved → applied
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- e.g. 'alias_correction'
  key TEXT NOT NULL,              -- e.g. 'chicken fillets→<productId>'
  payload TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_observations_key ON observations(kind, key);

CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  detail TEXT,
  payload TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('suggested','approved','rejected')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_kind TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  user_id TEXT,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE system_events (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info','warning','error')),
  component TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sysevents_created ON system_events(created_at);

-- Outbound notification queue (customer/staff). Channels plug in later.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,          -- 'in_app' | 'whatsapp' | 'sms' | 'email'
  audience TEXT NOT NULL,         -- 'staff' | 'customer'
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  order_id TEXT REFERENCES orders(id),
  customer_id TEXT REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','read','skipped')),
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_notifications_status ON notifications(status, created_at);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters(name, value) VALUES ('order_number', 1000);
`,
  },
  {
    id: 2,
    name: 'sample-data-flags',
    sql: `
ALTER TABLE customers ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_batches ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 3,
    name: 'family-sign-in',
    sql: `
ALTER TABLE users ADD COLUMN family_login INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN via TEXT NOT NULL DEFAULT 'password';
`,
  },
];

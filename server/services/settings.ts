import { db, json, now } from '../db/db.js';

export interface BusinessSettings {
  business: { name: string; tagline: string; phone: string; email: string; address: string; timezone: string; currency: string };
  orders: {
    formOrdersRequireReview: boolean;
    autoReadyAfterPacking: boolean;
    leadTimeDays: number;
    duplicateWindowHours: number;
    stalledHours: number;
  };
  fulfilment: {
    collectionDays: number[]; // 0=Sun
    deliveryDays: number[];
    deliveryEnabled: boolean;
    collectionHours: string;
    deliveryNotes: string;
  };
  ai: {
    enabled: boolean;
    model: string;
    effort: 'low' | 'medium' | 'high';
    learningThreshold: number; // corrections before an alias is suggested
  };
  printing: { showPrices: boolean; paper: 'A4' | 'Letter' };
  customerForm: { enabled: boolean; intro: string; confirmationMessage: string; showPrices: boolean };
}

export const DEFAULT_SETTINGS: BusinessSettings = {
  business: {
    name: 'Terram Farm',
    tagline: 'Grown with Purpose. Shared with Passion.',
    phone: '',
    email: '',
    address: '',
    timezone: 'Africa/Johannesburg',
    currency: 'ZAR',
  },
  orders: {
    formOrdersRequireReview: true,
    autoReadyAfterPacking: true,
    leadTimeDays: 1,
    duplicateWindowHours: 72,
    stalledHours: 24,
  },
  fulfilment: {
    collectionDays: [2, 3, 4, 5, 6],
    deliveryDays: [3, 5],
    deliveryEnabled: true,
    collectionHours: '08:00 – 17:00',
    deliveryNotes: 'Deliveries within the local area only.',
  },
  ai: { enabled: true, model: 'claude-opus-5', effort: 'low', learningThreshold: 2 },
  printing: { showPrices: false, paper: 'A4' },
  customerForm: {
    enabled: true,
    intro: 'Order our farm-raised, hand-cut meat. We will confirm your order and let you know when it is ready.',
    confirmationMessage: 'Thank you — your order has been received. We will be in touch to confirm it shortly.',
    showPrices: true,
  },
};

let cache: BusinessSettings | null = null;

function deepMerge<T>(base: T, over: any): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (over ?? base) as T;
  const out: any = { ...base };
  for (const k of Object.keys(base as any)) {
    if (over && k in over) out[k] = deepMerge((base as any)[k], over[k]);
  }
  return out;
}

export function getSettings(): BusinessSettings {
  if (cache) return cache;
  const rows = db().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const stored: any = {};
  for (const r of rows) stored[r.key] = json(r.value, undefined);
  cache = deepMerge(DEFAULT_SETTINGS, stored);
  return cache;
}

export function updateSettings(section: keyof BusinessSettings, value: unknown, userId: string | null) {
  const merged = deepMerge(getSettings()[section], value);
  db()
    .prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .run(section, JSON.stringify(merged), now(), userId);
  cache = null;
  return getSettings();
}

export function clearSettingsCache() {
  cache = null;
}

export function businessTz() {
  return getSettings().business.timezone;
}

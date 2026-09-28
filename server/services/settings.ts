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
  customerForm: { enabled: boolean; intro: string; confirmationMessage: string; showPrices: boolean; terms: string; /** Who gets an email for every online order. */ notifyEmails: string[] };
  /** Brand kit: logo (data URL), generated square app icons, and the main brand colour. */
  brand: { logo: string | null; icon192: string | null; icon512: string | null; primary: string; showName: boolean; version: number };
}

/** Terram green, from the brand kit and order form. */
export const DEFAULT_BRAND_COLOUR = '#446041';

export const DEFAULT_SETTINGS: BusinessSettings = {
  business: {
    name: 'Terram Farm',
    tagline: 'Grown with Purpose. Shared with Passion.',
    phone: '+27 79 889 5569',
    email: 'orders@terramfarm.co.za',
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
    deliveryNotes: 'Delivery can be arranged. Delivery fees apply.',
  },
  ai: { enabled: true, model: 'claude-opus-5', effort: 'low', learningThreshold: 2 },
  printing: { showPrices: false, paper: 'A4' },
  customerForm: {
    enabled: true,
    intro: 'Farm-raised beef and lamb. Orders are subject to processing time and stock availability. Your order is confirmed once Terram Farm accepts it.',
    confirmationMessage: 'Thank you — your order has been received. We will be in touch to confirm it shortly.',
    showPrices: true,
    notifyEmails: ['dylan@meacreo.co.za', 'Sharonm@imagine.co.za'],
    terms: [
      'Please place orders at least 2 weeks to 1 month in advance, so we can prepare your order to the highest standard.',
      'Prices are per kg and subject to change. Your final price is based on the actual packed weight.',
      'Limited to stock availability.',
      'Dry-aged beef is available only for Rump, Sirloin, T-Bone and Rib-Eye. It is aged for up to 30 days, carries a 25% surcharge on the normal price, and must be confirmed by Terram Farm before processing.',
      'Delivery fees apply to deliveries.',
    ].join('\n'),
  },
  brand: { logo: null, icon192: null, icon512: null, primary: DEFAULT_BRAND_COLOUR, showName: true, version: 0 },
};

let cache: BusinessSettings | null = null;

function deepMerge<T>(base: T, over: any): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (over === undefined ? base : over) as T;
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

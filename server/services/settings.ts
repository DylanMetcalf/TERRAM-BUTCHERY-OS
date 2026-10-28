import { db, json, now } from '../db/db.js';

export interface BusinessSettings {
  business: {
    name: string; tagline: string; phone: string; email: string; address: string; timezone: string; currency: string;
    /** Public address of the site, used for every link in customer emails (never localhost). */
    siteUrl: string;
    /** Links shown to customers after ordering (blank = not shown). Never invented: entered by the farm. */
    instagramUrl: string;
    googleReviewUrl: string;
  };
  orders: {
    /** Kept for older installs; online orders always wait for a person to confirm them. */
    formOrdersRequireReview: boolean;
    /** General guidance shown before checkout, on the order page and in emails. Counts from confirmation. */
    leadTimeText: string;
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
    /** Where customers collect, in their words, e.g. “our shop”. */
    collectionPlace: string;
    collectionAddress: string;
    deliveryNotes: string;
    /** Deliveries within this distance of the shop are free… */
    freeDeliveryKm: number;
    /** Customers choose collection or delivery on the form. Off: they give an address and the family arranges it. */
    customerChooses: boolean;
    /** Show the free radius and per-km fee on the order form. */
    showDeliveryFees: boolean;
    /** …and each km beyond it costs this much (cents). 0 = no distance fee. */
    deliveryRatePerKmCents: number;
    /** Fresh meat on a delivery journey longer than this (hours) can't be guaranteed; frozen is recommended. */
    freshMaxHours: number;
  };
  ai: {
    enabled: boolean;
    model: string;
    effort: 'low' | 'medium' | 'high';
    learningThreshold: number; // corrections before an alias is suggested
  };
  printing: { showPrices: boolean; paper: 'A4' | 'Letter' };
  /** How customers pay. Banking details are only shown to a customer on an order that has been asked to pay. */
  payments: {
    /** 'ready': ask for payment automatically when an order is marked ready; 'manual': staff send the request. */
    trigger: 'ready' | 'manual';
    eftEnabled: boolean;
    onlineEnabled: boolean;
    accountHolder: string;
    bankName: string;
    accountType: string;
    accountNumber: string;
    branchCode: string;
    swift: string;
    referenceInstructions: string;
    eftInstructions: string;
    paymentContact: string;
    guidance: string;
    /** Orders are only released for collection/delivery once payment is verified. */
    requirePaymentBeforeRelease: boolean;
    /** Lets a manager release an unpaid order anyway (with a reason). Off unless the business switches it on. */
    allowUnpaidRelease: boolean;
    /** How long a payment-page link in an email keeps working. */
    linkDays: number;
  };
  /** Questions and answers on the Help page. Edited in Settings. */
  help: { faq: { q: string; a: string }[] };
  /** Reorder reminders and feedback after an order is completed. */
  retention: { remindersEnabled: boolean; reminderDays: number; feedbackEnabled: boolean };
  /** Who is told what (customer emails are always the essential ones; these are optional extras). */
  notifications: { staffEmails: string[]; notifyPreparation: boolean; invoiceReadyEmail: boolean };
  /** Stock section housekeeping (starter items are added once). */
  stock: { seeded: boolean };
  customerForm: { enabled: boolean; intro: string; confirmationMessage: string; showPrices: boolean; terms: string; /** Shown when choosing a date. */ noticeNote: string; /** Who gets an email for every online order. */ notifyEmails: string[]; /** Email the customer a copy of their order when they give an address. */ emailCustomer: boolean };
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
    siteUrl: 'https://www.terramfarm.co.za',
    instagramUrl: '',
    googleReviewUrl: '',
  },
  orders: {
    formOrdersRequireReview: true,
    leadTimeText: 'Orders generally require 1–2 weeks from confirmation, depending on stock availability.',
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
    collectionPlace: 'our shop',
    collectionAddress: '',
    deliveryNotes: 'We deliver in Pretoria and surrounds. A delivery fee may apply depending on distance; we’ll confirm it with you.',
    freeDeliveryKm: 60,
    deliveryRatePerKmCents: 0,
    customerChooses: false,
    showDeliveryFees: false,
    freshMaxHours: 2,
  },
  ai: { enabled: true, model: 'claude-opus-5', effort: 'low', learningThreshold: 2 },
  printing: { showPrices: false, paper: 'A4' },
  payments: {
    trigger: 'ready',
    eftEnabled: false,
    onlineEnabled: false,
    accountHolder: '',
    bankName: '',
    accountType: '',
    accountNumber: '',
    branchCode: '',
    swift: '',
    referenceInstructions: 'Please use your order number as the payment reference.',
    eftInstructions: 'Pay by EFT using the details on this page, then upload your proof of payment or tell us you’ve paid. Your order shows as paid once we have checked that the money is in our account.',
    paymentContact: '',
    guidance: 'We’ll ask for payment once your order is packed and we know the final amount.',
    requirePaymentBeforeRelease: true,
    allowUnpaidRelease: false,
    linkDays: 30,
  },
  help: {
    faq: [
      { q: 'How does ordering work?', a: 'Choose your products on the order form, add your details and send the order. Sending an order doesn’t commit you to pay yet: we first check the products, quantities and availability, then confirm the order with you.' },
      { q: 'When is my order confirmed?', a: 'Your order is only confirmed once we’ve reviewed it. You’ll get an email with the confirmation and the expected timeframe, and your order page shows the latest status.' },
      { q: 'How long does an order take?', a: '{{leadTime}} We’ll give you the expected date when we confirm your order.' },
      { q: 'Why can the final price differ from the estimate?', a: 'Many cuts are priced per kilogram, and every piece weighs slightly differently. We weigh your order once it is packed and the final amount is based on the actual weights. Fixed packs, like mince, have a set price per pack.' },
      { q: 'When do I pay?', a: 'Once your order is packed and weighed, we send you a payment request with the final amount and a secure payment page. Payment must reflect in our account before your order is released for delivery or collection.' },
      { q: 'How do I pay by EFT?', a: 'Your payment page shows our banking details, the exact amount and your payment reference (your order number). Pay from your banking app, then upload your proof of payment or tap “I’ve made payment” on the same page.' },
      { q: 'Does uploading proof of payment mean my order is paid?', a: 'Not yet. We check that the money has reflected in our bank account first. Your order page shows “awaiting verification” until then, and we let you know as soon as it’s confirmed.' },
      { q: 'Should I choose fresh or frozen?', a: 'Choose fresh if you’ll collect or if delivery is a short trip. For delivery journeys longer than about {{freshMaxHours}} hours we can’t guarantee fresh products stay in the right condition, so we recommend frozen. If you’re not sure, chat to us before you order.' },
      { q: 'How are the products packed?', a: 'Packaged products are prepared using our standard vacuum packaging to help maintain freshness.' },
      { q: 'What mince pack sizes are there?', a: 'Mince comes in 500 g vacuum packs, and in 1 kg packs where we offer them. For 2 kg of mince, for example, choose 4 × 500 g packs.' },
      { q: 'How does delivery work?', a: 'Tell us your address when you order. We’ll confirm how and when your order reaches you, and any delivery cost, when we confirm the order. Orders are released once payment has reflected.' },
      { q: 'What if something isn’t available?', a: 'If we can’t supply something exactly as ordered, we’ll suggest a change on your order page. Nothing changes until you accept it.' },
      { q: 'Can I change or cancel my order?', a: 'Before we confirm it, you can cancel on your order page. After that, message us with your order number and we’ll help.' },
      { q: 'Can I get an invoice?', a: 'Yes. Choose “I need an invoice” when you order (or ask us), and we’ll prepare it and send it to you.' },
      { q: 'How do I contact Terram Farm?', a: 'Chat to us on WhatsApp or call us on the number below, or reply to any of our emails. Have your order number handy.' },
    ],
  },
  retention: { remindersEnabled: true, reminderDays: 14, feedbackEnabled: true },
  notifications: { staffEmails: [], notifyPreparation: false, invoiceReadyEmail: true },
  stock: { seeded: false },
  customerForm: {
    enabled: true,
    intro: 'Farm-raised Beef and Lamb. Orders are subject to processing time and stock availability. Your order is confirmed once Terram Farm accepts it.',
    confirmationMessage: 'Thank you — your order has been received. We will be in touch to confirm it shortly.',
    showPrices: true,
    notifyEmails: ['dylan@meacreo.co.za', 'Sharonm@imagine.co.za'],
    emailCustomer: true,
    noticeNote: 'We recommend ordering 7–14 days ahead. Sooner dates depend on what we have in stock; we’ll confirm with you.',
    terms: [
      'We recommend placing orders 7–14 days in advance. Sooner orders depend on stock, and we’ll confirm what we can do.',
      'Prices are per kg and subject to change. Your final price is based on the actual packed weight.',
      'Limited to stock availability.',
      'Dry-aged beef is available only for Rump, Sirloin, T-Bone and Rib-Eye. It is aged for up to 30 days, carries a 25% surcharge on the normal price, and must be confirmed by Terram Farm before processing.',
      'A delivery fee may apply depending on distance; we’ll confirm it with you.',
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

/**
 * Wording we've since improved: if a saved setting still holds an old default word for word,
 * swap in the new default. Anything the family wrote themselves is left alone.
 */
const REWORDED: [section: keyof BusinessSettings, key: string, old: string[]][] = [
  ['customerForm', 'terms', ["Please place orders at least 2 weeks to 1 month in advance, so we can prepare your order to the highest standard.\nPrices are per kg and subject to change. Your final price is based on the actual packed weight.\nLimited to stock availability.\nDry-aged beef is available only for Rump, Sirloin, T-Bone and Rib-Eye. It is aged for up to 30 days, carries a 25% surcharge on the normal price, and must be confirmed by Terram Farm before processing.\nDelivery fees apply to deliveries."]],
  ['customerForm', 'intro', ['Farm-raised beef and lamb. Orders are subject to processing time and stock availability. Your order is confirmed once Terram Farm accepts it.']],
  ['fulfilment', 'deliveryNotes', ['Delivery can be arranged. Delivery fees apply.', 'We deliver in Pretoria. Delivery fees apply.', 'Deliveries within the local area only.']],
];
export function refreshDefaultWording() {
  for (const [section, key, olds] of REWORDED) {
    const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(section) as { value: string } | undefined;
    if (!row) continue;
    const stored = json<any>(row.value, {});
    if (!olds.includes(stored?.[key])) continue;
    stored[key] = (DEFAULT_SETTINGS[section] as any)[key];
    db().prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(stored), now(), section);
  }
  cache = null;
}

export function clearSettingsCache() {
  cache = null;
}

export function businessTz() {
  return getSettings().business.timezone;
}

import { db, json, now } from '../db/db.js';

export interface BusinessSettings {
  business: {
    name: string; tagline: string; phone: string; email: string; address: string; timezone: string; currency: string;
    /** Public address of the site, used for every link in customer emails (never localhost). */
    siteUrl: string;
    /** Links shown to customers after ordering (blank = not shown). Never invented: entered by the farm. */
    instagramUrl: string;
    googleReviewUrl: string;
    facebookUrl: string;
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
    /** Which days Hoedspruit deliveries usually happen, and that we'll be in touch if it changes. Shown at checkout, in emails and on the order page. */
    deliveryDayNote: string;
    /** Deliveries within this distance of the shop are free… */
    freeDeliveryKm: number;
    /** Customers choose collection or delivery on the form. Off: they give an address and the family arranges it. */
    customerChooses: boolean;
    /** Show the free radius and per-km fee on the order form. */
    showDeliveryFees: boolean;
    /** …and each km beyond it costs this much (cents). 0 = no distance fee. */
    deliveryRatePerKmCents: number;
    /** Kept for older orders; products are frozen, so customers are no longer asked. */
    freshMaxHours: number;
    /** 'flat': one fee per standard local delivery. 'per_km' is kept only for older orders. */
    deliveryPricing: 'flat' | 'per_km';
    /** The standard local delivery fee (cents), stored on each order when it's placed. */
    flatDeliveryFeeCents: number;
    /** Shown at checkout and on the FAQ: where the standard fee applies. */
    deliveryAreaText: string;
    /** Shown at checkout: how delivery is arranged. */
    deliveryPolicyText: string;
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
    /** Days after a payment request before staff are reminded to follow up (0 = off). Nothing is sent automatically. */
    reminderDays: number;
  };
  /** Questions and answers on the FAQ page, in categories. Edited in Settings. */
  help: { faq: { q: string; a: string; category?: string }[] };
  /** Editable website text (About page). Only what the farm says about itself — nothing is invented. */
  content: { aboutIntro: string; aboutSections: { title: string; body: string }[]; /** The “share the love” note: reuse our boxes for compost, share photos, tag us. */ communityNote: string };
  /** Reorder reminders and feedback after an order is completed. */
  retention: { remindersEnabled: boolean; reminderDays: number; feedbackEnabled: boolean };
  /** Who is told what (customer emails are always the essential ones; these are optional extras). */
  notifications: { staffEmails: string[]; notifyPreparation: boolean; invoiceReadyEmail: boolean; /** Who checks the bank when a customer says they've paid. */ paymentReviewEmails: string[] };
  /** Stock section housekeeping (starter items are added once). */
  stock: { seeded: boolean };
  customerForm: { enabled: boolean; intro: string; confirmationMessage: string; showPrices: boolean; terms: string; /** Shown when choosing a date. */ noticeNote: string; /** Who gets an email for every online order. */ notifyEmails: string[]; /** Email the customer a copy of their order when they give an address. */ emailCustomer: boolean; /** Tells customers that order updates come by email and delivery is arranged on WhatsApp. */ emailNote: string };
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
    facebookUrl: '',
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
    deliveryDayNote: 'We usually deliver Hoedspruit orders on a Monday or Tuesday. If that changes, we will be in touch to let you know.',
    deliveryNotes: 'We deliver in Pretoria and surrounds. A delivery fee may apply depending on distance; we’ll confirm it with you.',
    freeDeliveryKm: 60,
    deliveryRatePerKmCents: 0,
    customerChooses: false,
    showDeliveryFees: false,
    freshMaxHours: 2,
    deliveryPricing: 'flat',
    flatDeliveryFeeCents: 15000,
    deliveryAreaText: 'We deliver within our regular local delivery area: the local town and the areas around the farmhouse shop and Hoedspruit Wildlife Estates. Other locations can be arranged separately.',
    deliveryPolicyText: 'We will contact you to confirm the delivery arrangements for your order.',
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
    reminderDays: 7,
  },
  help: {
    faq: [
      { category: 'Ordering', q: 'How does ordering work?', a: 'Choose your products on the order form, add your details and send the order. We first check the products, quantities and availability, then confirm your order with you.' },
      { category: 'Ordering', q: 'When is my order confirmed?', a: 'Only once we have reviewed it. You will get an email confirming your order and the expected timeframe, and your order page always shows the latest status.' },
      { category: 'Ordering', q: 'How long does an order take?', a: '{{leadTime}} We give you the expected date when we confirm your order.' },
      { category: 'Ordering', q: 'Can I change or cancel my order?', a: 'Before we confirm it, you can cancel on your order page. After that, message us with your order number and we will help.' },
      { category: 'Products and packaging', q: 'Are your products fresh or frozen?', a: 'Our products are supplied frozen and vacuum-packed.' },
      { category: 'Products and packaging', q: 'Why can the final price differ from the estimate?', a: 'Many cuts are priced per kilogram and every piece weighs a little differently. The weight you choose (for example 300–400 g a steak) is a preference, not an exact weight. We weigh your order when it is packed and the final amount is based on the actual weights. Fixed packs, like mince, have a set price per pack.' },
      { category: 'Products and packaging', q: 'How is mince sold?', a: 'Mince comes in standard 500 g packets. For 2 kg, choose 4 packets.' },
      { category: 'Products and packaging', q: 'Can I ask for a different cut or size?', a: 'Yes. Add a note to the item, or describe what you need under Special requests, and we will confirm it with you.' },
      { category: 'Payment', q: 'When do I pay?', a: 'Once your order is packed and weighed we send you a payment request with the final amount and a secure payment page.' },
      { category: 'Payment', q: 'How do I pay by EFT?', a: 'Your payment page shows our banking details, the amount and your payment reference (your order number). Pay from your banking app, then tap “Already paid?” on the same page. Proof of payment is optional.' },
      { category: 'Payment', q: 'Does telling you I have paid mean my order is paid?', a: 'Not yet. We check that the money has reflected in our bank account, then confirm. Your order page shows the status.' },
      { category: 'Invoices', q: 'Can I get an invoice?', a: 'Yes. Ask when you order (or message us) and we will prepare it. When it is ready you can download it from your order or payment page.' },
      { category: 'Delivery', q: 'Where do you deliver and what does it cost?', a: '{{deliveryArea}} The standard delivery fee is {{deliveryFee}} per order. Deliveries outside our regular area are arranged and priced separately.' },
      { category: 'Delivery', q: 'How is delivery arranged?', a: 'Give us your full address and any directions or gate information when you order. We will contact you to confirm the delivery arrangements.' },
      { category: 'Collection', q: 'Can I collect my order?', a: 'Ask us when you order and we will confirm a collection time with you.' },
      { category: 'Order updates', q: 'How do I see my orders?', a: 'Use the link in any of our emails, or choose “View my orders” on our home page and enter your mobile number or email address. We will send you a code to open them.' },
      { category: 'Product availability', q: 'What if something is not available?', a: 'If we cannot supply something exactly as ordered, we will suggest a change on your order page. Nothing changes until you accept it.' },
      { category: 'Contact', q: 'How do I contact Terram Farm?', a: 'Chat to us on WhatsApp, call us, or reply to any of our emails. Please have your order number handy.' },
    ],
  },
  retention: { remindersEnabled: true, reminderDays: 14, feedbackEnabled: true },
  notifications: { staffEmails: [], notifyPreparation: false, invoiceReadyEmail: true, paymentReviewEmails: ['Sharonm@Imagine.co.za'] },
  content: {
    aboutIntro: 'Terram Farm raises beef and lamb on our family farm, and prepares and packs it for local families from our farmhouse shop.',
    aboutSections: [
      { title: 'What we offer', body: 'Farm-raised beef and farm-raised lamb, cut to order and vacuum-packed. Some cuts are sold in fixed packs (like our 500 g mince packets) and others are weighed, so the final price follows the actual weight.' },
      { title: 'How it works', body: 'You order online, we confirm your order, then cut, pack and weigh it. Once the final amount is known we send you a secure payment page, and we arrange delivery or collection with you.' },
      { title: 'Where we are', body: 'Our farmhouse shop serves the local town and the surrounding areas, including Hoedspruit Wildlife Estates.' },
    ],
    communityNote: 'We would love our customers to reuse our boxes for compost, and to share their photos with us: when your order arrives, or while you are braaiing or enjoying a meal. WhatsApp your photos to us with your social media handle if you would like to be tagged when we share them.',
  },
  stock: { seeded: false },
  customerForm: {
    enabled: true,
    intro: 'Farm-raised Beef and Lamb. Orders are subject to processing time and stock availability. Your order is confirmed once Terram Farm accepts it.',
    confirmationMessage: 'Thank you — your order has been received. We will be in touch to confirm it shortly.',
    showPrices: true,
    notifyEmails: ['dylan@meacreo.co.za', 'Sharonm@imagine.co.za'],
    emailCustomer: true,
    emailNote: 'Most of our order updates (your confirmation, payment details and invoice) are sent by email, so please use an email address you check. We will contact you on WhatsApp about your delivery.',
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
  ['fulfilment', 'deliveryAreaText', ['We deliver within our regular local delivery area: the local town and the areas around the farmhouse shop and Hoodspruit Wildlife Estates. Other locations can be arranged separately.']],
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
  // The About page's old "Where we are" default spelled the estate "Hoodspruit": fix it only where it is still the untouched default
  const row = db().prepare("SELECT value FROM settings WHERE key = 'content'").get() as { value: string } | undefined;
  if (row) {
    const stored = json<any>(row.value, {});
    const OLD = 'Our farmhouse shop serves the local town and the surrounding areas, including Hoodspruit Wildlife Estates.';
    if (Array.isArray(stored.aboutSections) && stored.aboutSections.some((x: any) => x?.body === OLD)) {
      stored.aboutSections = stored.aboutSections.map((x: any) => (x?.body === OLD ? { ...x, body: OLD.replace('Hoodspruit', 'Hoedspruit') } : x));
      db().prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'content'").run(JSON.stringify(stored), now());
    }
  }
  cache = null;
}

export function clearSettingsCache() {
  cache = null;
}

export function businessTz() {
  return getSettings().business.timezone;
}

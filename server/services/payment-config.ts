import { getSettings, type BusinessSettings } from './settings.js';

/**
 * What payment methods are actually usable right now. A method is only offered to a customer
 * when it is switched on AND fully set up, so nobody is told they can pay in a way that won't work.
 * Provider credentials live only in server environment variables, never in the database or browser.
 */

const EFT_REQUIRED: [keyof BusinessSettings['payments'], string][] = [
  ['accountHolder', 'account holder'],
  ['bankName', 'bank name'],
  ['accountNumber', 'account number'],
  ['branchCode', 'branch code'],
];

export function eftMissing(p: BusinessSettings['payments'] = getSettings().payments): string[] {
  return EFT_REQUIRED.filter(([k]) => !String(p[k] ?? '').trim()).map(([, label]) => label);
}

export function maskAccount(n: string | null | undefined): string {
  const digits = String(n ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length <= 4 ? '••••' : `•••• ${digits.slice(-4)}`;
}

const env = (k: string) => (process.env[k] ?? '').trim().replace(/^["']|["']$/g, '');

export interface PayfastConfig {
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  sandbox: boolean;
  baseUrl: string;
}

/** PayFast details from the server environment (PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE, PAYFAST_MODE). */
export function payfastConfig(): PayfastConfig | null {
  const merchantId = env('PAYFAST_MERCHANT_ID');
  const merchantKey = env('PAYFAST_MERCHANT_KEY');
  if (!merchantId || !merchantKey) return null;
  const sandbox = env('PAYFAST_MODE').toLowerCase() !== 'live';
  return { merchantId, merchantKey, passphrase: env('PAYFAST_PASSPHRASE'), sandbox, baseUrl: sandbox ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za' };
}

export function payfastStatus() {
  const c = payfastConfig();
  return { configured: !!c, mode: c ? (c.sandbox ? 'sandbox' : 'live') : null, passphrase: !!c?.passphrase };
}

/** The methods a customer may choose from now, with the reason any is missing (for staff). */
export function paymentMethods() {
  const p = getSettings().payments;
  const missing = eftMissing(p);
  const eft = p.eftEnabled && !missing.length;
  const online = p.onlineEnabled && !!payfastConfig();
  const problems: string[] = [];
  if (p.eftEnabled && missing.length) problems.push(`EFT is switched on but these banking details are missing: ${missing.join(', ')}.`);
  if (p.onlineEnabled && !payfastConfig()) problems.push('Online payment is switched on but PayFast is not set up on the server.');
  return { eft, online, problems };
}

/** Banking details for the EFT instructions on one order's payment page. */
export function eftDetails() {
  const p = getSettings().payments;
  return {
    accountHolder: p.accountHolder,
    bankName: p.bankName,
    accountType: p.accountType || null,
    accountNumber: p.accountNumber,
    branchCode: p.branchCode,
    swift: p.swift || null,
    referenceInstructions: p.referenceInstructions,
    instructions: p.eftInstructions,
    contact: p.paymentContact || null,
  };
}

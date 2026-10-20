// Per-country national number rules. Mirrors the landing page's country list
// (the landing file was not available at build time, so this is the initial
// set; extend CALLING_CODES to match the page's 36 codes).
export interface CountryRule { cc: string; iso: string; min: number; max: number; leading?: RegExp }

export const CALLING_CODES: CountryRule[] = [
  { cc: '91', iso: 'IN', min: 10, max: 10, leading: /^[6-9]/ },
  { cc: '1', iso: 'US/CA', min: 10, max: 10, leading: /^[2-9]/ },
  { cc: '44', iso: 'GB', min: 10, max: 10, leading: /^[1-9]/ },
  { cc: '61', iso: 'AU', min: 9, max: 9, leading: /^[2-578]/ },
  { cc: '65', iso: 'SG', min: 8, max: 8, leading: /^[3689]/ },
  { cc: '971', iso: 'AE', min: 9, max: 9, leading: /^5/ },
  { cc: '966', iso: 'SA', min: 9, max: 9, leading: /^5/ },
  { cc: '974', iso: 'QA', min: 8, max: 8 },
  { cc: '968', iso: 'OM', min: 8, max: 8 },
  { cc: '965', iso: 'KW', min: 8, max: 8 },
  { cc: '973', iso: 'BH', min: 8, max: 8 },
  { cc: '60', iso: 'MY', min: 9, max: 10 },
  { cc: '92', iso: 'PK', min: 10, max: 10, leading: /^3/ },
  { cc: '880', iso: 'BD', min: 10, max: 10, leading: /^1/ },
  { cc: '94', iso: 'LK', min: 9, max: 9 },
  { cc: '977', iso: 'NP', min: 10, max: 10 },
  { cc: '27', iso: 'ZA', min: 9, max: 9 },
  { cc: '234', iso: 'NG', min: 10, max: 10 },
  { cc: '254', iso: 'KE', min: 9, max: 9 },
  { cc: '64', iso: 'NZ', min: 8, max: 10 },
];

export class PhoneError extends Error {}

/** Normalise a country code + local number to E.164 (digits only, "+" prefixed). */
export function normalizePhone(countryCode: string, local: string): string {
  const cc = countryCode.replace(/\D/g, '');
  let digits = local.replace(/\D/g, '');
  const rule = CALLING_CODES.find((r) => r.cc === cc);
  if (!rule) throw new PhoneError(`Unsupported country code +${cc}`);
  if (digits.startsWith('00' + cc)) digits = digits.slice(2 + cc.length);
  else if (digits.startsWith(cc) && digits.length > rule.max) digits = digits.slice(cc.length);
  digits = digits.replace(/^0+/, '');
  if (digits.length < rule.min || digits.length > rule.max) throw new PhoneError('Invalid phone number length');
  if (rule.leading && !rule.leading.test(digits)) throw new PhoneError('Invalid phone number');
  return `+${cc}${digits}`;
}

export function isE164(s: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(s);
}

/** WhatsApp Cloud API wants digits without "+". */
export const toWaId = (e164: string) => e164.replace(/^\+/, '');
export const fromWaId = (wa: string) => `+${wa.replace(/\D/g, '')}`;

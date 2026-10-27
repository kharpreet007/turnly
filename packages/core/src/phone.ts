// Per-country national number rules (digits after the country code, without the leading 0).
// Lengths are deliberately lenient so real numbers are never rejected. The landing page carries the same
// table (COUNTRIES in landing/index.html); a test keeps the two in step.
export interface CountryRule { cc: string; iso: string; name: string; min: number; max: number; leading?: RegExp }

const row = (cc: string, iso: string, name: string, min: number, max: number, leading?: RegExp): CountryRule => ({ cc, iso, name, min, max, leading });

export const CALLING_CODES: CountryRule[] = [
  row('91', 'IN', 'India', 10, 10, /^[6-9]/),
  row('971', 'AE', 'UAE', 9, 9, /^5/),
  row('44', 'GB', 'UK', 9, 10, /^[1-9]/),
  row('1', 'US', 'US / Canada', 10, 10, /^[2-9]/),
  row('65', 'SG', 'Singapore', 8, 8, /^[3689]/),
  row('61', 'AU', 'Australia', 9, 9, /^[2-578]/),
  row('64', 'NZ', 'New Zealand', 8, 10),
  row('966', 'SA', 'Saudi Arabia', 9, 9, /^5/),
  row('974', 'QA', 'Qatar', 8, 8),
  row('968', 'OM', 'Oman', 8, 8),
  row('965', 'KW', 'Kuwait', 8, 8),
  row('973', 'BH', 'Bahrain', 8, 8),
  row('60', 'MY', 'Malaysia', 9, 10),
  row('92', 'PK', 'Pakistan', 10, 10, /^3/),
  row('880', 'BD', 'Bangladesh', 10, 10, /^1/),
  row('94', 'LK', 'Sri Lanka', 9, 9),
  row('977', 'NP', 'Nepal', 10, 10),
  row('27', 'ZA', 'South Africa', 9, 9),
  row('234', 'NG', 'Nigeria', 10, 10),
  row('254', 'KE', 'Kenya', 9, 9),
  row('233', 'GH', 'Ghana', 9, 9),
  row('255', 'TZ', 'Tanzania', 9, 9),
  row('256', 'UG', 'Uganda', 9, 9),
  row('20', 'EG', 'Egypt', 10, 10),
  row('62', 'ID', 'Indonesia', 9, 12),
  row('63', 'PH', 'Philippines', 10, 10),
  row('66', 'TH', 'Thailand', 9, 9),
  row('84', 'VN', 'Vietnam', 9, 10),
  row('81', 'JP', 'Japan', 9, 10),
  row('82', 'KR', 'South Korea', 9, 10),
  row('86', 'CN', 'China', 11, 11),
  row('852', 'HK', 'Hong Kong', 8, 8),
  row('49', 'DE', 'Germany', 10, 11),
  row('33', 'FR', 'France', 9, 9),
  row('39', 'IT', 'Italy', 9, 10),
  row('34', 'ES', 'Spain', 9, 9),
  row('31', 'NL', 'Netherlands', 9, 9),
  row('353', 'IE', 'Ireland', 9, 9),
  row('41', 'CH', 'Switzerland', 9, 9),
  row('46', 'SE', 'Sweden', 9, 9),
  row('90', 'TR', 'Turkey', 10, 10),
  row('55', 'BR', 'Brazil', 10, 11),
  row('52', 'MX', 'Mexico', 10, 10),
  row('7', 'RU', 'Russia', 10, 10),
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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALLING_CODES, normalizePhone } from '@turnly/core';

describe('country table', () => {
  it('the landing page carries exactly the backend table', () => {
    const html = readFileSync(new URL('../landing/index.html', import.meta.url), 'utf8');
    const m = html.match(/var COUNTRIES = (\[\[.*?\]\]);/s);
    expect(m).not.toBeNull();
    const page = JSON.parse(m![1]);
    expect(page).toEqual(CALLING_CODES.map((c) => [c.cc, c.name, c.min, c.max, c.leading ? c.leading.source : '']));
    expect(page.length).toBeGreaterThanOrEqual(36);
  });

  it('has unique country entries', () => {
    const codes = CALLING_CODES.map((c) => c.iso);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('normalises numbers from the new countries', () => {
    expect(normalizePhone('+1', '(415) 555-2671')).toBe('+14155552671');
    expect(normalizePhone('61', '0412 345 678')).toBe('+61412345678');
    expect(normalizePhone('+49', '1512 3456789')).toBe('+4915123456789');
    expect(normalizePhone('+254', '712 345 678')).toBe('+254712345678');
    expect(() => normalizePhone('+1', '115 555 2671')).toThrow();
    expect(() => normalizePhone('+86', '12345')).toThrow();
  });
});

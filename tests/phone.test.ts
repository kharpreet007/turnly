import { describe, expect, it } from 'vitest';
import { normalizePhone } from '@turnly/core';

describe('normalizePhone', () => {
  it('normalises Indian numbers', () => {
    expect(normalizePhone('+91', '98765 43210')).toBe('+919876543210');
    expect(normalizePhone('91', '09876543210')).toBe('+919876543210');
    expect(normalizePhone('+91', '+91 98765-43210')).toBe('+919876543210');
  });
  it('rejects bad numbers', () => {
    expect(() => normalizePhone('+91', '12345')).toThrow();
    expect(() => normalizePhone('+91', '5876543210')).toThrow();
    expect(() => normalizePhone('+999', '1234567890')).toThrow();
  });
});

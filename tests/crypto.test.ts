import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '@turnly/core';

describe('secret encryption', () => {
  it('round-trips and is non-deterministic', () => {
    const a = encryptSecret('EAAB-token'); const b = encryptSecret('EAAB-token');
    expect(a).not.toBe(b);
    expect(a).not.toContain('EAAB');
    expect(decryptSecret(a)).toBe('EAAB-token');
  });
});

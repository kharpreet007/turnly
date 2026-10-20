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

import { waitForDb } from '@turnly/core';
describe('waitForDb', () => {
  it('retries until the database answers, then gives up with the last error', async () => {
    let n = 0;
    const flaky = { query: async () => { if (++n < 3) throw new Error('asleep'); return {}; } } as any;
    await expect(waitForDb(flaky, 5, 1)).resolves.toBeUndefined();
    expect(n).toBe(3);
    const dead = { query: async () => { throw new Error('still asleep'); } } as any;
    await expect(waitForDb(dead, 2, 1)).rejects.toThrow('still asleep');
  });
});

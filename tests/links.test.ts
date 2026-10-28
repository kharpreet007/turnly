import { describe, expect, it } from 'vitest';
import { followUpText, whatsAppLink } from '@turnly/core';

describe('WhatsApp reply link', () => {
  it('opens the lead chat with the first reply already typed', () => {
    const link = whatsAppLink('+919876543210', 'Asha', {});
    expect(link.startsWith('https://wa.me/919876543210?text=')).toBe(true);
    expect(decodeURIComponent(link.split('?text=')[1])).toBe(
      'Hi Asha, this is the Turnly team. Thanks for your query. Our support team will contact you soon. In the meantime, are you looking for packages or services?');
  });
  it('signs with OWNER_NAME when set', () => {
    expect(followUpText('Asha', { OWNER_NAME: 'Harpreet' })).toContain('this is Harpreet from Turnly');
  });
  it('encodes names with special characters safely', () => {
    const link = whatsAppLink('+919876543210', 'A&B "Co" #1', {});
    expect(link).not.toContain(' ');
    expect(link).not.toContain('"');
    expect(decodeURIComponent(link.split('?text=')[1])).toContain('A&B "Co" #1');
  });
});

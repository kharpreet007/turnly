import { describe, expect, it } from 'vitest';
import { calendlyUrl, followUpText, formatWhen, whatsAppLink } from '@turnly/core';

const lead = { id: '630f659e-9663-4a2b-8c1d-0123456789ab', name: 'Harpreet K', phone: '+12265069968' };
const env = { CALENDLY_URL: 'https://calendly.com/kharpreet007/15min' };

describe('Calendly link', () => {
  it('carries the lead id so a booking can be matched back', () => {
    const u = new URL(calendlyUrl(env.CALENDLY_URL, lead));
    expect(u.origin + u.pathname).toBe('https://calendly.com/kharpreet007/15min');
    expect(u.searchParams.get('name')).toBe('Harpreet K');
    expect(u.searchParams.get('a1')).toBe('+12265069968');
    expect(u.searchParams.get('utm_content')).toBe(lead.id);
    expect(u.searchParams.get('utm_source')).toBe('turnly');
  });
  it('is empty without a base link', () => { expect(calendlyUrl(undefined, lead)).toBe(''); });
});

describe('WhatsApp reply link', () => {
  it('not booked: asks them to book, with the Calendly link', () => {
    const text = followUpText(lead, env);
    expect(text).toContain('Hi Harpreet K, Someone from Turnly will message you on WhatsApp at +12265069968 to plan your set-up. Please book a time that suits you for the set-up call.');
    expect(text).toContain('https://calendly.com/kharpreet007/15min?');
    expect(text).toContain(`utm_content=${lead.id}`);
  });
  it('not booked and no Calendly link: just the message', () => {
    expect(followUpText(lead, {})).not.toContain('http');
  });
  it('booked: confirms the date and time in the lead\'s own time zone', () => {
    const text = followUpText({ ...lead, callStatus: 'booked', callStart: '2026-11-04T20:00:00Z', callTz: 'America/Toronto' }, { OWNER_NAME: 'Harpreet' });
    expect(text).toContain('Hi Harpreet K, we have got your set-up request for');
    expect(text).toContain('3:00');
    expect(text).toContain('Nov');
    expect(text).toContain('Speak soon, Harpreet from Turnly.');
    expect(text).not.toContain('calendly');
  });
  it('opens the lead chat with the text already typed', () => {
    const link = whatsAppLink(lead, env);
    expect(link.startsWith('https://wa.me/12265069968?text=')).toBe(true);
    expect(decodeURIComponent(link.split('?text=')[1])).toBe(followUpText(lead, env));
    expect(link).not.toContain(' ');
  });
  it('falls back to India time for an unknown zone', () => {
    expect(formatWhen('2026-11-04T10:00:00Z', 'Not/AZone')).toContain('3:30');
  });
});

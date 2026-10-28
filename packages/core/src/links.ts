/**
 * Messages to a lead that open in WhatsApp already typed; the owner only taps Send.
 * Which text depends on whether the lead has booked the set-up call. OWNER_NAME (optional) signs the booked message.
 */
type Env = Record<string, string | undefined>;

export interface LeadLinkInfo {
  id?: string;
  name: string;
  phone: string; // E.164
  callStatus?: string;
  callStart?: Date | string | null;
  callTz?: string | null;
}

/** The Calendly booking link for one lead: carries their id (utm_content) so a booking can be matched back to them. */
export function calendlyUrl(base: string | undefined, lead: { id?: string; name: string; phone: string }): string {
  const b = base?.trim();
  if (!b) return '';
  const q = new URLSearchParams({ name: lead.name, a1: lead.phone, utm_source: 'turnly' });
  if (lead.id) q.set('utm_content', lead.id);
  return b + (b.includes('?') ? '&' : '?') + q.toString();
}

/** e.g. "Tue, 4 Nov, 3:00 pm GMT+5:30" in the given time zone (the lead's own, if known). */
export function formatWhen(start: Date | string, tz?: string | null): string {
  const d = new Date(start);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' };
  try { return d.toLocaleString('en-IN', { ...opts, timeZone: tz || 'Asia/Kolkata' }); }
  catch { return d.toLocaleString('en-IN', { ...opts, timeZone: 'Asia/Kolkata' }); }
}

export function followUpText(lead: LeadLinkInfo, env: Env = process.env): string {
  if (lead.callStatus === 'booked' && lead.callStart) {
    const sign = env.OWNER_NAME?.trim() ? `Speak soon, ${env.OWNER_NAME.trim()} from Turnly.` : 'Speak soon, the Turnly team.';
    return `Hi ${lead.name}, we have got your set-up request for ${formatWhen(lead.callStart, lead.callTz)}. ${sign}`;
  }
  const cal = calendlyUrl(env.CALENDLY_URL, lead);
  return `Hi ${lead.name}, Someone from Turnly will message you on WhatsApp at +${lead.phone.replace(/\D/g, '')} to plan your set-up. Please book a time that suits you for the set-up call.` + (cal ? `\n${cal}` : '');
}

export function whatsAppLink(lead: LeadLinkInfo, env: Env = process.env): string {
  return `https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(followUpText(lead, env))}`;
}

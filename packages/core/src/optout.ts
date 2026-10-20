const DEFAULT_KEYWORDS = ['stop', 'unsubscribe', 'cancel messages'];

export function isOptOut(text: string, extra: string[] = []): boolean {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/g, '');
  return [...DEFAULT_KEYWORDS, ...extra.map((k) => k.toLowerCase())].includes(t);
}

export const OPTOUT_CONFIRMATION = 'You have been unsubscribed and will not get any further messages from us.';

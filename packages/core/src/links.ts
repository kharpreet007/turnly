/**
 * The first reply to a lead, ready to send. Opening the link below puts this text into a WhatsApp chat
 * with the lead; the owner only taps Send. OWNER_NAME (optional) is who the message says it is from.
 */
export function followUpText(name: string, env: Record<string, string | undefined> = process.env): string {
  const who = env.OWNER_NAME?.trim() ? `this is ${env.OWNER_NAME.trim()} from Turnly` : 'this is the Turnly team';
  return `Hi ${name}, ${who}. Thanks for your query. Our support team will contact you soon. In the meantime, are you looking for packages or services?`;
}

export function whatsAppLink(phoneE164: string, name: string, env: Record<string, string | undefined> = process.env): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, '')}?text=${encodeURIComponent(followUpText(name, env))}`;
}

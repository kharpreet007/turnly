import type { Db } from './db.ts';
import { ist } from './export.ts';
import { whatsAppLink } from './links.ts';

/** Email through Resend (https://resend.com). Needs RESEND_API_KEY and ALERT_EMAIL; EMAIL_FROM is optional. */
export interface EmailConfig { apiKey: string; to: string[]; from: string }

export function emailConfig(env: Record<string, string | undefined>): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const to = (env.ALERT_EMAIL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!apiKey || !to.length) return null;
  return { apiKey, to, from: env.EMAIL_FROM?.trim() || 'Turnly <onboarding@resend.dev>' };
}

export async function sendEmail(cfg: EmailConfig, mail: { subject: string; text: string }, f: typeof fetch = fetch): Promise<void> {
  const res = await f('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: cfg.from, to: cfg.to, subject: mail.subject, text: mail.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Email failed (${res.status}): ${j.message ?? 'unknown error'}`);
  }
}

export const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1•••$2');

export interface EmailDeps { db: Db; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }

/** Email every new lead once. A failure is retried on the next call and never blocks anything else. */
export async function emailNewLeads(deps: EmailDeps): Promise<{ sent: number; error?: string }> {
  const cfg = emailConfig(deps.env ?? process.env);
  if (!cfg) return { sent: 0 };
  const { rows } = await deps.db.query(
    `select id, created_at, name, phone_e164, business_type, ad_source, wants, est_monthly_loss, consent_at
       from leads where email_sent_at is null and created_at > now() - interval '2 days' order by created_at asc limit 20`);
  let sent = 0;
  for (const l of rows) {
    const wants = Array.isArray(l.wants) ? l.wants.join('; ') : '';
    try {
      await sendEmail(cfg, {
        subject: `New Turnly lead: ${l.name} (${l.business_type})`,
        text: [
          `${l.name} asked for a demo.`, '',
          `WhatsApp: ${l.phone_e164}`, `Tap to reply on WhatsApp (message is typed for you, just press Send):`, whatsAppLink(l.phone_e164, l.name, deps.env ?? process.env),
          `Business type: ${l.business_type}`, `Source: ${l.ad_source ?? 'direct'}`,
          wants ? `Plans: ${wants}` : '', l.est_monthly_loss ? `Estimated monthly loss: Rs ${l.est_monthly_loss}` : '',
          `Time (IST): ${ist(l.created_at)}`, `Agreed to be messaged on WhatsApp: ${ist(l.consent_at)}`,
        ].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n'),
      }, deps.fetchImpl ?? fetch);
      await deps.db.query('update leads set email_sent_at = now() where id = $1', [l.id]);
      sent++;
    } catch (e) {
      return { sent, error: (e as Error).message };
    }
  }
  return { sent };
}

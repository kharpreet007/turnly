import { createHmac, timingSafeEqual } from 'node:crypto';
import { WaSendError, type WhatsAppClient } from './whatsapp.ts';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string; // whatsapp:+14155238886 (sandbox) or your own sender
  statusCallback?: string;
  /** Approved Twilio Content templates: { "turnly_demo_welcome": "HXxxxx" }. Without one, the text is sent as a plain message. */
  contentSids: Record<string, string>;
  /**
   * Sandbox fallback: a pre-approved Twilio template with two variables (e.g. the sandbox "Appointment Reminders"
   * template). Used when Twilio refuses plain text with 21654 "ContentSid Required". The message text goes in {{1}}.
   */
  fallbackContentSid?: string;
}

export function twilioConfig(env: Record<string, string | undefined>): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_WHATSAPP_FROM?.trim();
  if (!accountSid || !authToken || !from) return null;
  let contentSids: Record<string, string> = {};
  if (env.TWILIO_CONTENT_SIDS) {
    try { contentSids = JSON.parse(env.TWILIO_CONTENT_SIDS); } catch { throw new Error('TWILIO_CONTENT_SIDS is not valid JSON'); }
  }
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  return {
    accountSid, authToken, contentSids,
    fallbackContentSid: env.TWILIO_FALLBACK_CONTENT_SID?.trim() || undefined,
    from: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
    statusCallback: base ? `${base}/twilio/status` : undefined,
  };
}

export function createTwilioClient(cfg: TwilioConfig, f: typeof fetch = fetch): WhatsAppClient {
  return {
    async send(_numberId, to, payload, ctx) {
      const body = new URLSearchParams({ To: `whatsapp:${to}`, From: cfg.from });
      if (cfg.statusCallback) body.set('StatusCallback', cfg.statusCallback);
      if (payload.kind === 'template' && cfg.contentSids[payload.name]) {
        body.set('ContentSid', cfg.contentSids[payload.name]);
        body.set('ContentVariables', JSON.stringify(Object.fromEntries(payload.variables.map((v, i) => [String(i + 1), v]))));
      } else if (payload.kind === 'template') {
        body.set('Body', ctx?.renderedBody ?? '');
      } else if (payload.kind === 'interactive') {
        body.set('Body', `${payload.body}\n${payload.buttons.map((b) => `- ${b.title}`).join('\n')}`);
      } else {
        body.set('Body', payload.body);
      }
      const post = async (form: URLSearchParams) => {
        let res: Response;
        try {
          res = await f(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
            method: 'POST',
            headers: {
              authorization: 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64'),
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: form,
            signal: AbortSignal.timeout(10_000),
          });
        } catch (e) {
          throw new WaSendError(`network: ${(e as Error).message}`, true);
        }
        const json = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
        return { res, json };
      };
      let { res, json } = await post(body);
      if (!res.ok && json.code === 21654 && cfg.fallbackContentSid && !body.has('ContentSid')) {
        // Twilio wants a template here. Send the same text through the fallback template instead.
        const text = (payload.kind === 'text' ? payload.body : payload.kind === 'template' ? ctx?.renderedBody : body.get('Body')) ?? '';
        const retry = new URLSearchParams({ To: body.get('To')!, From: cfg.from });
        if (cfg.statusCallback) retry.set('StatusCallback', cfg.statusCallback);
        retry.set('ContentSid', cfg.fallbackContentSid);
        retry.set('ContentVariables', JSON.stringify({ '1': text.replace(/\s+/g, ' ').slice(0, 900), '2': 'Turnly' }));
        ({ res, json } = await post(retry));
      }
      if (!res.ok || !json.sid) {
        const transient = res.status >= 500 || res.status === 429 || json.code === 20429;
        throw new WaSendError(`Twilio ${json.code ?? res.status}: ${json.message ?? 'send failed'}`, transient, json.code);
      }
      return { waMessageId: json.sid };
    },
  };
}

/** Twilio signs url + every POST field (sorted by name, name then value) with the auth token (HMAC-SHA1, base64). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

const digits = (s: string) => s.replace(/^whatsapp:/, '').replace(/\D/g, '');

/** Shape an incoming Twilio message like a Meta webhook so one code path handles both providers. */
export function twilioInboundToMeta(p: Record<string, string>, numberId: string, nowSec = Math.floor(Date.now() / 1000)) {
  const text = (p.Body ?? '').trim();
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'twilio', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: numberId },
      contacts: [{ profile: { name: p.ProfileName }, wa_id: digits(p.From ?? '') }],
      messages: [{
        from: digits(p.From ?? ''), id: p.MessageSid, timestamp: String(nowSec),
        ...(text || Number(p.NumMedia ?? 0) === 0 ? { type: 'text', text: { body: text } } : { type: 'image', image: { id: p.MessageSid } }),
      }],
    } }] }],
  };
}

const STATUS_MAP: Record<string, string> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed' };

export function twilioStatusToMeta(p: Record<string, string>, numberId: string) {
  const status = STATUS_MAP[p.MessageStatus ?? ''];
  if (!status || !p.MessageSid) return null;
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'twilio', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: numberId },
      statuses: [{ id: p.MessageSid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: digits(p.To ?? ''),
        ...(status === 'failed' ? { errors: [{ code: p.ErrorCode ?? 'failed', title: p.ErrorMessage ?? 'Twilio could not deliver the message' }] } : {}) }],
    } }] }],
  };
}

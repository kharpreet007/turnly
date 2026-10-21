import { toWaId } from './phone.ts';

export type OutboundPayload =
  | { kind: 'text'; body: string }
  | { kind: 'template'; name: string; language: string; variables: readonly string[] }
  | { kind: 'interactive'; body: string; buttons: { id: string; title: string }[] };

export class WaSendError extends Error {
  constructor(message: string, public transient: boolean, public code?: number) { super(message); }
}

/** renderedBody: the template text with variables filled in, for providers that send plain text. */
export interface SendContext { renderedBody?: string }

export interface WhatsAppClient {
  send(phoneNumberId: string, toE164: string, payload: OutboundPayload, ctx?: SendContext): Promise<{ waMessageId: string }>;
}

export interface WaConfig { token: string; graphVersion?: string }

/** Real Meta Cloud API client. Token comes from env or a decrypted per-business token. */
export function createCloudClient(cfg: WaConfig): WhatsAppClient {
  const v = cfg.graphVersion ?? 'v21.0';
  return {
    async send(phoneNumberId, to, payload) {
      const body: Record<string, unknown> = { messaging_product: 'whatsapp', to: toWaId(to) };
      if (payload.kind === 'text') {
        Object.assign(body, { type: 'text', text: { body: payload.body } });
      } else if (payload.kind === 'template') {
        Object.assign(body, {
          type: 'template',
          template: {
            name: payload.name,
            language: { code: payload.language },
            components: payload.variables.length
              ? [{ type: 'body', parameters: payload.variables.map((text) => ({ type: 'text', text })) }]
              : [],
          },
        });
      } else {
        Object.assign(body, {
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: payload.body },
            action: { buttons: payload.buttons.map((b) => ({ type: 'reply', reply: b })) },
          },
        });
      }
      let res: Response;
      try {
        res = await fetch(`https://graph.facebook.com/${v}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        throw new WaSendError(`network: ${(e as Error).message}`, true);
      }
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        const code = json?.error?.code as number | undefined;
        // 429/5xx and Meta rate-limit codes are worth retrying; the rest are permanent.
        const transient = res.status >= 500 || res.status === 429 || [4, 80007, 130429, 131056].includes(code ?? -1);
        throw new WaSendError(json?.error?.message ?? `HTTP ${res.status}`, transient, code);
      }
      return { waMessageId: json.messages[0].id as string };
    },
  };
}

/** In-memory client for tests and WA_MODE=mock. Never touches the network. */
export function createFakeClient() {
  const sent: { phoneNumberId: string; to: string; payload: OutboundPayload }[] = [];
  let failNext: WaSendError | null = null;
  let n = 0;
  return {
    sent,
    failNextWith(e: WaSendError) { failNext = e; },
    async send(phoneNumberId: string, to: string, payload: OutboundPayload) {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      sent.push({ phoneNumberId, to, payload });
      return { waMessageId: `wamid.fake.${++n}` };
    },
  } satisfies WhatsAppClient & { sent: typeof sent; failNextWith(e: WaSendError): void };
}

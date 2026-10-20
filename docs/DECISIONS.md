# Decisions

## Owner decisions (PRD section 15)
| # | Question | Decision |
|---|---|---|
| 1 | Meta Cloud API vs BSP | **Direct Meta Cloud API.** All Meta calls sit behind the `WhatsAppClient` interface, so a BSP adapter can replace `createCloudClient` later. |
| 4 | Hosting | **Render (Singapore) + Neon (ap-southeast-1).** `render.yaml` + `Dockerfile`; one web service, one worker. |
| 3, 5 | Turnly's WhatsApp number | **Not yet available.** Use the Meta free test number. Set `PHONE_NUMBER_ID`, `WABA_ID`, `META_SYSTEM_USER_TOKEN` when ready. Until then the worker runs in `WA_MODE=mock`. |
| 2, 6, 7, 8 | Prices/currency, languages, domain, pilots | **Open.** Not needed for Phase 0. English only for now. |

Landing page: owner will upload `landing/index.html`. `landing/lead-client.js` is ready to wire in.

## Defaults chosen (change freely)
- **Stack:** TypeScript, Node 22, Fastify 5, `pg` (plain SQL migrations in `packages/core/src/migrations`), pg-boss for the queue, zod, vitest. No ORM: the schema is small and SQL keeps `business_id` isolation explicit.
- **Process model:** the API acks webhooks after the signature check and enqueues `wa_webhook`; the worker does all processing and sending. Queue retries: 3, exponential backoff.
- **Consent lives on `contacts`.** The lead form sets `opt_in`, source, timestamp and exact text. `sendMessage` is the only sender and refuses without it, so no caller can bypass the rule.
- **Send rules in `sendMessage`, in order:** blocked, opted-out, consent (business-initiated sends), 24h window for free-form, template must be `approved`, per-business throttle (`businesses.send_per_minute`, default 600), dedupe key. Refusals are written to `audit_log`.
- **STOP:** `stop`, `unsubscribe`, `cancel messages` (case-insensitive, trimmed). Sets `opt_in=false` immediately and sends one confirmation (the only send allowed to an opted-out contact). Re-opt-in only through a new form submission with consent. Per-business localised keywords are not built yet (`isOptOut` accepts extras).
- **Template categories:** `turnly_demo_welcome` is UTILITY because it answers a request the person just made. Meta may reclassify it as MARKETING; that is fine since the consent text covers it.
- **Operator alert** is a template (`turnly_operator_new_lead`) because the operator is usually outside the 24h window. The operator contact is seeded as opted-in from `OPERATOR_ALERT_PHONE`.
- **Lead dedupe:** same phone within 24h updates the lead and does not re-send. More than 5 submissions per phone per hour returns 429. Honeypot field `website` returns a fake 200 and stores nothing.
- **Phone rules:** 20 country codes so far (`packages/core/src/phone.ts`). The landing page's 36-country list was not available; extend the table to match.
- **Secrets:** AES-256-GCM helper in `crypto.ts` for per-business tokens. Phase 0 uses the single `META_SYSTEM_USER_TOKEN`; `wa_numbers.token_ref` is unused until Phase 1.
- **Admin:** a single `ADMIN_TOKEN` guards `/admin/leads` (JSON, or `?format=html`). The real operator dashboard is Phase 1.
- **Template status is blocked by default:** new templates are `pending`. Run `npm run templates -- submit`, then `sync`. On the Meta test number use `npm run templates -- status <name> approved`.

## Not done in Phase 0
- Landing page wiring (file missing), privacy/terms pages, Sentry, webhook-lag monitoring.
- 90-day message purge and the `deleteContact` admin tool.
- The per-IP rate limit is in-memory (fine for one instance).

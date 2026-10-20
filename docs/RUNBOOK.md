# Runbook (Phase 0)

## Local
```
createdb turnly && cp .env.example .env     # edit values
npm install
npm run migrate                             # applies SQL, seeds Turnly as business #1 and its templates
npm run templates -- status turnly_demo_welcome approved
npm run templates -- status turnly_operator_new_lead approved
npm run dev:api        # terminal 1
npm run dev:worker     # terminal 2 (WA_MODE=mock logs sends instead of calling Meta)
curl -XPOST localhost:3000/api/leads -H 'content-type: application/json' -d '{...}'
npm run simulate -- text +919876543210 STOP
```
Tests: `npm test` (needs Postgres; uses `turnly_test`, override with `TEST_DATABASE_URL`).

## Going live on the Meta test number
1. Meta app > WhatsApp > API setup: note the WABA ID and phone number ID, and create a system-user token.
2. Set the env vars on Render and deploy. In Meta set the webhook to `PUBLIC_BASE_URL/webhook` with `META_VERIFY_TOKEN`, and subscribe to `messages`.
3. Add the operator phone and a test phone as allowed recipients on the test number.
4. `npm run templates -- submit`, then `sync` until approved. Remove `WA_MODE=mock`.
5. Submit the form with the test phone. The welcome should arrive in under 10 seconds.

## Troubleshooting
- Lead got no welcome: `select * from audit_log where action like 'send%' order by id desc;` shows the refusal reason (`no_consent`, `template_not_approved`, `opted_out`, ...).
- Failed sends: `select error from messages where status = 'failed';`
- Webhook 401: `META_APP_SECRET` mismatch.

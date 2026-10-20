// Local WhatsApp simulator: posts a signed Meta-style webhook to the running API.
//   npm run simulate -- text +919876543210 "hello"
//   npm run simulate -- text +919876543210 STOP
//   npm run simulate -- status wamid.xxx delivered
import { signBody } from '@turnly/core';

const [kind, a, b] = process.argv.slice(2);
const base = process.env.SIM_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const phoneNumberId = process.env.PHONE_NUMBER_ID ?? 'TEST_PNID';
const value: any = { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId } };

if (kind === 'text') {
  value.contacts = [{ profile: { name: 'Sim User' }, wa_id: a.replace('+', '') }];
  value.messages = [{ from: a.replace('+', ''), id: `wamid.sim.${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: b ?? 'hi' } }];
} else if (kind === 'status') {
  value.statuses = [{ id: a, status: b ?? 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '0' }];
} else {
  console.error('usage: simulate text <+e164> <body> | simulate status <wamid> <status>');
  process.exit(1);
}

const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value }] }] });
const res = await fetch(`${base}/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(body, process.env.META_APP_SECRET!) },
  body,
});
console.log(res.status, await res.text());

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLead, exportLeads, callLabel, whatsAppLink, emailConfig, maskEmail, sheetConfig, sheetInfo, resetAllLeads, clearSheetRows, contactFootprint, deleteContact, ProtectedNumberError, twilioConfig, ist, twilioInboundToMeta, twilioStatusToMeta, verifyTwilioSignature, PHASE0_TEMPLATES, setTemplateStatus, submitTemplate, syncTemplateStatuses, upsertTemplateDefs, syncPendingLeadsToSheet, leadInput, leadsToCsv, LeadRateLimited, listLeads, PhoneError, verifySignature,
  type Db, type Queue,
} from '@turnly/core';
import type { Config } from './config.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function tokenOk(given: string | undefined, expected: string) {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildApp(deps: { db: Db; queue: Queue; config: Config }) {
  const { db, queue, config } = deps;
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true });

  await app.register(cors, { origin: config.allowedOrigins.length ? config.allowedOrigins : false });
  await app.register(rateLimit, { global: false });

  // The landing page, served from the same origin so the form posts to this API (no CORS needed).
  const landingPath = join(dirname(fileURLToPath(import.meta.url)), '../../../landing/index.html');
  app.get('/', async (_req, reply) => {
    const page = readFileSync(landingPath, 'utf8');
    return reply.type('text/html; charset=utf-8').send(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
      '<style>body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style>' +
      `<script>window.TURNLY_API_BASE = location.origin; window.TURNLY_CALENDLY_URL = ${JSON.stringify(process.env.CALENDLY_URL ?? '').replace(/</g, '\\u003c')}; window.TURNLY_WHATSAPP = ${JSON.stringify((process.env.WHATSAPP_NUMBER ?? '').replace(/\D/g, ''))};</script>` + page);
  });

  app.get('/healthz', async () => {
    await db.query('select 1');
    return { ok: true };
  });

  // --- Meta webhook: verify signature, ack fast, process in the worker ---
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    hook.get('/webhook', async (req, reply) => {
      const q = req.query as Record<string, string>;
      if (q['hub.mode'] === 'subscribe' && tokenOk(q['hub.verify_token'], config.verifyToken)) {
        return reply.type('text/plain').send(q['hub.challenge']);
      }
      return reply.code(403).send('forbidden');
    });

    hook.post('/webhook', async (req, reply) => {
      const raw = req.body as Buffer;
      if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, config.appSecret)) {
        return reply.code(401).send({ error: 'bad signature' });
      }
      let payload: unknown;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'bad json' }); }
      await queue.send('wa_webhook', payload as object);
      return reply.code(200).send({ ok: true });
    });
  });

  // --- Twilio (alternative to Meta): incoming messages and delivery statuses ---
  await app.register(async (tw) => {
    await tw.register(formbody);
    const check = (req: any, path: string) => {
      if (!config.twilio) return false;
      const base = config.publicBaseUrl ?? `${req.protocol}://${req.hostname}`;
      return verifyTwilioSignature(config.twilio.authToken, base + path, (req.body ?? {}) as Record<string, string>, req.headers['x-twilio-signature'] as string | undefined);
    };
    tw.post('/twilio/webhook', async (req, reply) => {
      if (!check(req, '/twilio/webhook')) return reply.code(403).send('forbidden');
      await queue.send('wa_webhook', twilioInboundToMeta(req.body as Record<string, string>, config.twilio!.numberId));
      return reply.type('text/xml').send('<Response></Response>');
    });
    tw.post('/twilio/status', async (req, reply) => {
      if (!check(req, '/twilio/status')) return reply.code(403).send('forbidden');
      const payload = twilioStatusToMeta(req.body as Record<string, string>, config.twilio!.numberId);
      if (payload) await queue.send('wa_webhook', payload);
      return reply.code(204).send();
    });
  });

  // --- Lead capture ---
  app.post('/api/leads', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = leadInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid',
        fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const input = parsed.data;
    // Honeypot: pretend success so bots learn nothing; store nothing, send nothing.
    if (input.website) return { ok: true };

    try {
      const r = await createLead(db, input, { ip: req.ip, userAgent: req.headers['user-agent'] });
      if (!r.duplicate) {
        await queue.send('send_welcome', { leadId: r.leadId });
        await queue.send('alert_operator', { leadId: r.leadId });
        await queue.send('capi_lead', { leadId: r.leadId });
        await queue.send('sheet_lead', { leadId: r.leadId });
        await queue.send('email_lead', { leadId: r.leadId });
      }
      return { ok: true, duplicate: r.duplicate, lead: r.leadId };
    } catch (e) {
      if (e instanceof PhoneError) {
        return reply.code(400).send({ error: 'invalid', fields: [{ field: 'phone', message: e.message }] });
      }
      if (e instanceof LeadRateLimited) return reply.code(429).send({ error: 'rate_limited' });
      throw e;
    }
  });

  // --- Minimal operator lead list ---
  await app.register(async (admin) => {
    await admin.register(formbody); // the delete confirmation posts a plain HTML form
    admin.addHook('onRequest', async (req, reply) => {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const token = bearer || (req.query as Record<string, string>).token;
      if (!tokenOk(token, config.adminToken)) return reply.code(401).send({ error: 'unauthorized' });
    });

    // Adds every lead missing from the Google Sheet and says plainly what happened.
    admin.route({ method: ['GET', 'POST'], url: '/admin/sheet/sync', handler: async (req, reply) => {
      // ?all=1 forgets what was sent before, for a sheet that was cleared. Rows already in the sheet will repeat.
      if ((req.query as Record<string, string>).all === '1') await db.query('update leads set sheet_synced_at = null');
      const r = await syncPendingLeadsToSheet({ db, env: process.env });
      let msg: string;
      if (!r.configured) msg = 'Google Sheet is not set up. In Railway Variables, add GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID (and GOOGLE_SHEET_TAB = Leads).';
      else if (r.error) msg = `Stopped after ${r.synced} of ${r.total} leads. Google said: ${r.error}`;
      else if (r.total === 0) msg = 'Nothing to add: every lead is already in the sheet.';
      else msg = `Done. Added ${r.synced} lead${r.synced === 1 ? '' : 's'} to the Google Sheet.`;
      let where = '';
      try {
        const cfg = sheetConfig(process.env);
        if (cfg) {
          const info = await sheetInfo(cfg);
          where = `<p><b>Writing to:</b> spreadsheet "${esc(info.title)}" (ID ends …${esc(cfg.sheetId.slice(-6))}), tab "${esc(cfg.tab)}". Tabs in that spreadsheet: ${esc(info.tabs.join(', '))}.` + (r.lastRange ? `<br><b>Last rows written:</b> ${esc(r.lastRange)}` : '') + '</p>';
        }
      } catch (e) { where = `<p>Could not look up the spreadsheet: ${esc((e as Error).message)}</p>`; }
      return reply.code(r.error || !r.configured ? 500 : 200).type('text/html; charset=utf-8').send(
        `<!doctype html><meta name=viewport content="width=device-width"><title>Sheet sync</title><body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px"><h2>Google Sheet sync</h2><p>${esc(msg)}</p>${where}`);
    } });

    // WhatsApp message templates: list, send to Meta for approval, refresh approval status.
    const page = (reply: any, body: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(
      `<!doctype html><meta name=viewport content="width=device-width"><title>Templates</title><body style="font:16px system-ui;max-width:760px;margin:40px auto;padding:0 16px">${body}`);
    const links = (t: string) => `<p><a href="/admin/templates/submit?token=${encodeURIComponent(t)}">1. Send templates to Meta for approval</a> &nbsp;|&nbsp; <a href="/admin/templates/sync?token=${encodeURIComponent(t)}">2. Refresh approval status</a> &nbsp;|&nbsp; <a href="/admin/templates?token=${encodeURIComponent(t)}">List</a></p>`;
    const metaEnv = () => (process.env.WABA_ID && process.env.META_SYSTEM_USER_TOKEN ? { waba: process.env.WABA_ID, token: process.env.META_SYSTEM_USER_TOKEN } : null);
    const tok = (req: any) => ((req.query as Record<string, string>).token ?? '');

    admin.get('/admin/templates', async (req, reply) => {
      await upsertTemplateDefs(db, PHASE0_TEMPLATES);
      const { rows } = await db.query(`select name, category, status, meta_template_id from templates where business_id is null order by name`);
      return page(reply, `<h2>WhatsApp templates</h2>${links(tok(req))}<table border=1 cellpadding=6><tr><th>Name<th>Type<th>Status<th>Meta id</tr>${rows.map((r: any) => `<tr><td>${esc(r.name)}<td>${esc(r.category)}<td><b>${esc(r.status)}</b><td>${esc(r.meta_template_id ?? '')}</tr>`).join('')}</table><p>Status <b>approved</b> means Meta allows us to send it.</p>`);
    });

    admin.get('/admin/templates/submit', async (req, reply) => {
      const env = metaEnv();
      if (!env) return page(reply, `<h2>Not connected to Meta yet</h2><p>Set WABA_ID and META_SYSTEM_USER_TOKEN in Railway Variables.</p>`, 500);
      await upsertTemplateDefs(db, PHASE0_TEMPLATES);
      const out: string[] = [];
      for (const t of PHASE0_TEMPLATES) {
        const { rows: [row] } = await db.query(`select meta_template_id from templates where business_id is null and name = $1 and language = $2`, [t.name, t.language]);
        if (row?.meta_template_id) { out.push(`${t.name}: already sent to Meta`); continue; }
        try {
          const r = await submitTemplate(env.waba, env.token, t);
          await setTemplateStatus(db, t.name, 'pending', r.id);
          out.push(`${t.name}: sent to Meta, waiting for approval`);
        } catch (e) { out.push(`${t.name}: Meta said: ${(e as Error).message}`); }
      }
      return page(reply, `<h2>Send templates to Meta</h2>${links(tok(req))}<ul>${out.map((o) => `<li>${esc(o)}`).join('')}</ul>`);
    });

    admin.get('/admin/templates/sync', async (req, reply) => {
      const env = metaEnv();
      if (!env) return page(reply, `<h2>Not connected to Meta yet</h2><p>Set WABA_ID and META_SYSTEM_USER_TOKEN in Railway Variables.</p>`, 500);
      try { await syncTemplateStatuses(db, env.waba, env.token); } catch (e) { return page(reply, `<h2>Meta said</h2><p>${esc((e as Error).message)}</p>`, 500); }
      return reply.redirect(`/admin/templates?token=${encodeURIComponent(tok(req))}`);
    });

    // What is sending, to whom, and why a message did not go out.
    admin.get('/admin/status', async (_req, reply) => {
      const mask = (p: string) => p.length > 6 ? `${p.slice(0, 3)}•••••${p.slice(-4)}` : p;
      const provider = process.env.WA_MODE === 'mock' ? 'MOCK (nothing is sent)'
        : twilioConfig(process.env) ? 'Twilio' : process.env.META_SYSTEM_USER_TOKEN ? 'Meta Cloud API' : 'MOCK (nothing is sent)';
      const { rows: [biz] } = await db.query(`select owner_phone_e164s from businesses where is_self`);
      const { rows: msgs } = await db.query(
        `select m.created_at, c.phone_e164, m.type, m.template_name, m.status, m.error, m.attempts
           from messages m join contacts c on c.id = m.contact_id where m.direction = 'out' order by m.created_at desc limit 20`);
      const { rows: audits } = await db.query(
        `select created_at, action, detail from audit_log where action in ('send_refused', 'send_failed') order by id desc limit 20`);
      let calendlyLine = 'NOT SET (add CALENDLY_TOKEN in Railway)';
      if (process.env.CALENDLY_TOKEN) {
        const { rows: [ev] } = await db.query(`select name, props, created_at from events where name in ('calendly_sync_error', 'calendly_sync_ok') order by id desc limit 1`);
        calendlyLine = ev?.name === 'calendly_sync_error' ? `on, last error (${ist(ev.created_at)} IST): ${ev.props.message}` : ev ? `on, last check OK (${ist(ev.created_at)} IST)` : 'on, waiting for the first check';
      }
      let sheet: string;
      try {
        if (!sheetConfig(process.env)) sheet = 'not set up (add the Google variables in Railway)';
        else {
          const { rows: [w] } = await db.query(`select count(*)::int as n from leads where sheet_synced_at is null`);
          const { rows: [ev] } = await db.query(`select name, props, created_at from events where name in ('sheet_sync_error', 'sheet_sync_ok') order by id desc limit 1`);
          sheet = `${w.n} lead(s) waiting to be added.` + (ev?.name === 'sheet_sync_error' ? ` Last error (${ist(ev.created_at)} IST): ${ev.props.message}` : ev ? ' Last sync: OK.' : '');
        }
      } catch (e) { sheet = `problem: ${(e as Error).message}`; }
      const t = (d: Date) => esc(ist(d));
      const rowsHtml = msgs.map((m: any) => `<tr><td>${t(m.created_at)}<td>${esc(mask(m.phone_e164))}<td>${esc(m.template_name ?? m.type)}<td><b>${esc(m.status)}</b><td>${esc(m.error ?? '')}</tr>`).join('');
      const auditHtml = audits.map((a: any) => `<tr><td>${t(a.created_at)}<td>${esc(a.action)}<td>${esc(a.detail?.reason ?? a.detail?.error ?? '')}<td>${esc(a.detail?.purpose ?? '')}</tr>`).join('');
      return reply.type('text/html; charset=utf-8').send(
        `<!doctype html><meta name=viewport content="width=device-width"><title>Status</title><body style="font:15px system-ui;max-width:900px;margin:30px auto;padding:0 16px">
<h2>Sending status</h2>
<p><b>Running version:</b> ${esc((process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown').slice(0, 7))} ${esc((process.env.RAILWAY_GIT_COMMIT_MESSAGE ?? '').split('\n')[0].slice(0, 90))}<br><b>Fallback template (TWILIO_FALLBACK_CONTENT_SID):</b> ${process.env.TWILIO_FALLBACK_CONTENT_SID ? 'set, ends …' + esc(process.env.TWILIO_FALLBACK_CONTENT_SID.trim().slice(-4)) : '<b>NOT SET</b>'}</p><p><b>Calendly bookings:</b> ${esc(calendlyLine)}</p><p><b>Email alerts:</b> ${esc(emailConfig(process.env) ? 'on, to ' + emailConfig(process.env)!.to.map(maskEmail).join(', ') : 'NOT SET (add RESEND_API_KEY and ALERT_EMAIL in Railway)')}</p><p><b>Google Sheet:</b> ${esc(sheet)}</p><p><b>Provider:</b> ${esc(provider)}<br><b>Alerts go to:</b> ${esc((biz?.owner_phone_e164s ?? []).map(mask).join(', ') || 'nobody (OPERATOR_ALERT_PHONE is not set)')}</p>
<h3>Last messages we tried to send</h3><table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>When (IST)<th>To<th>What<th>Status<th>Error</tr>${rowsHtml || '<tr><td colspan=5>None yet'}</table>
<h3>Messages we refused or that failed</h3><table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>When (IST)<th>Kind<th>Reason<th>For</tr>${auditHtml || '<tr><td colspan=4>None'}</table>
<p style="color:#666">Reasons: outside_window = the person has not messaged the number in the last 24 hours; template_not_approved = template not approved yet; no_consent / opted_out = we must not message them; no_number = no WhatsApp number set up.</p>`);
    });

    // Delete one person's data. GET shows what would go; only a POST deletes.
    const deletePage = (reply: any, body: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(
      `<!doctype html><meta name=viewport content="width=device-width"><title>Delete</title><body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">${body}`);
    const selfId = async () => (await db.query(`select id from businesses where is_self`)).rows[0].id as string;
    const normPhone = (raw: string) => `+${(raw ?? '').replace(/\D/g, '')}`;

    admin.get('/admin/delete-contact', async (req, reply) => {
      const q = req.query as Record<string, string>;
      const phone = normPhone(q.phone);
      const f = await contactFootprint(db, await selfId(), phone);
      if (!f.found) return deletePage(reply, `<h2>Nothing to delete</h2><p>We hold no data for ${esc(phone)}.</p>`);
      return deletePage(reply, `<h2>Delete everything for ${esc(phone)}?</h2>
<p>This permanently removes ${f.leads} lead(s), ${f.messages} message(s), ${f.conversations} conversation(s) and the contact. It cannot be undone. Rows already in your Google Sheet are not touched: delete those by hand.</p>
<form method="post" action="/admin/delete-contact?token=${encodeURIComponent(q.token ?? '')}"><input type="hidden" name="phone" value="${esc(phone)}"><button style="font:600 16px system-ui;padding:10px 18px">Yes, delete permanently</button></form>`);
    });

    admin.post('/admin/delete-contact', async (req, reply) => {
      const phone = normPhone(((req.body ?? {}) as Record<string, string>).phone ?? (req.query as Record<string, string>).phone);
      try {
        const f = await deleteContact(db, await selfId(), phone);
        return deletePage(reply, `<h2>Deleted</h2><p>Removed ${f.leads} lead(s), ${f.messages} message(s) and the contact for ${esc(phone)}. You can use this number for a fresh test now.</p>`);
      } catch (e) {
        if (e instanceof ProtectedNumberError) return deletePage(reply, `<h2>Not deleted</h2><p>${esc(e.message)}</p>`, 403);
        throw e;
      }
    });

    // Fresh start: delete every lead (and the Google Sheet rows). Needs the word RESET typed in.
    admin.get('/admin/reset-leads', async (req, reply) => {
      const q = req.query as Record<string, string>;
      const { rows: [n] } = await db.query(`select (select count(*)::int from leads) as leads`);
      return deletePage(reply, `<h2>Reset all test data?</h2>
<p>This permanently deletes <b>all ${n.leads} lead(s)</b>, their messages and contacts, and clears the data rows in your Google Sheet (the header row stays). Your own alert number is kept. It cannot be undone, and it also deletes real customers' leads if there are any.</p>
<form method="post" action="/admin/reset-leads?token=${encodeURIComponent(q.token ?? '')}"><p>Type <b>RESET</b> to confirm:<br><input name="confirm" autocomplete="off" style="font:16px system-ui;padding:8px"></p><button style="font:600 16px system-ui;padding:10px 18px">Delete everything</button></form>`);
    });

    admin.post('/admin/reset-leads', async (req, reply) => {
      if ((((req.body ?? {}) as Record<string, string>).confirm ?? '').trim() !== 'RESET') {
        return deletePage(reply, `<h2>Not deleted</h2><p>You need to type RESET exactly. Nothing was changed.</p>`, 400);
      }
      const r = await resetAllLeads(db, await selfId());
      let sheet = 'Google Sheet is not set up, so no sheet rows were cleared.';
      try {
        const cfg = sheetConfig(process.env);
        if (cfg) { await clearSheetRows(cfg); sheet = 'The Google Sheet rows were cleared.'; }
      } catch (e) { sheet = `The sheet could not be cleared (${(e as Error).message}). Delete its rows by hand.`; }
      return deletePage(reply, `<h2>Fresh start</h2><p>Deleted ${r.leads} lead(s), ${r.contacts} contact(s) and ${r.messages} message(s). ${esc(sheet)}</p><p>You can use any number again.</p>`);
    });

    admin.get('/admin/leads.csv', async (_req, reply) => {
      const csv = leadsToCsv(await exportLeads(db));
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="turnly-leads.csv"')
        .send(csv);
    });

    admin.get('/admin/leads', async (req, reply) => {
      const q = req.query as Record<string, string>;
      const rows = await listLeads(db, { status: q.status });
      if (q.format !== 'html') return rows;
      const tr = rows.map((r: any) => `<tr><td>${esc(r.created_at.toISOString?.() ?? r.created_at)}</td><td>${esc(r.name)}</td><td>${esc(r.phone_e164)}</td><td>${esc(r.business_type)}</td><td>${esc(r.ad_source)}</td><td>${esc(r.status)}</td><td>${r.opt_in ? 'yes' : r.opted_out_at ? 'opted out' : 'no'}</td><td>${esc(r.welcome_status)}</td><td>${esc(r.flow_status === 'none' ? '' : r.flow_status)}${r.answers?.interest ? '<br>' + esc([r.answers.interest, r.answers.detail, r.answers.business, r.answers.best_time].filter(Boolean).join(' / ')) : ''}</td><td>${esc(callLabel(r))}</td><td><a href="${esc(whatsAppLink({ id: r.id, name: r.name, phone: r.phone_e164, callStatus: r.call_status, callStart: r.call_start_at, callTz: r.call_tz }))}" target="_blank">${r.call_status === 'booked' ? 'Confirm call on WhatsApp' : 'Send booking link'}</a></td><td><a href="/admin/delete-contact?phone=${encodeURIComponent(r.phone_e164)}&token=${encodeURIComponent(q.token ?? '')}">Delete</a></td></tr>`).join('');
      return reply.type('text/html').send(
        `<!doctype html><meta name=viewport content="width=device-width"><title>Leads</title><p><a href="/admin/leads.csv?token=${encodeURIComponent(q.token ?? '')}"><b>Download as Excel (CSV)</b></a> &nbsp;|&nbsp; <a href="/admin/sheet/sync?token=${encodeURIComponent(q.token ?? '')}"><b>Send all leads to Google Sheet</b></a> &nbsp;|&nbsp; <a href="/admin/status?token=${encodeURIComponent(q.token ?? '')}"><b>Sending status</b></a> &nbsp;|&nbsp; <a href="/admin/reset-leads?token=${encodeURIComponent(q.token ?? '')}">Reset test data</a></p><table border=1 cellpadding=6><tr><th>When<th>Name<th>WhatsApp<th>Type<th>Source<th>Status<th>Opt-in<th>Welcome<th>Chat<th>Call<th>WhatsApp<th></tr>${tr}</table>`);
    });

    admin.patch('/admin/leads/:id', async (req, reply) => {
      const { status, notes } = (req.body ?? {}) as { status?: string; notes?: string };
      try {
        const r = await db.query(
          `update leads set status = coalesce($2, status), notes = coalesce($3, notes), updated_at = now() where id = $1 returning id, status`,
          [(req.params as { id: string }).id, status ?? null, notes ?? null]);
        if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
        await db.query(`insert into audit_log (actor, action, detail) values ('operator', 'lead_update', $1)`, [JSON.stringify({ id: r.rows[0].id, status, notes })]);
        return r.rows[0];
      } catch {
        return reply.code(400).send({ error: 'invalid status' });
      }
    });
  });

  return app;
}

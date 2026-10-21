import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLead, exportLeads, syncPendingLeadsToSheet, leadInput, leadsToCsv, LeadRateLimited, listLeads, PhoneError, verifySignature,
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
      '<script>window.TURNLY_API_BASE = location.origin;</script>' + page);
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
      }
      return { ok: true, duplicate: r.duplicate };
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
    admin.addHook('onRequest', async (req, reply) => {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const token = bearer || (req.query as Record<string, string>).token;
      if (!tokenOk(token, config.adminToken)) return reply.code(401).send({ error: 'unauthorized' });
    });

    // Adds every lead missing from the Google Sheet and says plainly what happened.
    admin.route({ method: ['GET', 'POST'], url: '/admin/sheet/sync', handler: async (_req, reply) => {
      const r = await syncPendingLeadsToSheet({ db, env: process.env });
      let msg: string;
      if (!r.configured) msg = 'Google Sheet is not set up. In Railway Variables, add GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID (and GOOGLE_SHEET_TAB = Leads).';
      else if (r.error) msg = `Stopped after ${r.synced} of ${r.total} leads. Google said: ${r.error}`;
      else if (r.total === 0) msg = 'Nothing to add: every lead is already in the sheet.';
      else msg = `Done. Added ${r.synced} lead${r.synced === 1 ? '' : 's'} to the Google Sheet.`;
      return reply.code(r.error || !r.configured ? 500 : 200).type('text/html; charset=utf-8').send(
        `<!doctype html><meta name=viewport content="width=device-width"><title>Sheet sync</title><body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px"><h2>Google Sheet sync</h2><p>${esc(msg)}</p>`);
    } });

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
      const tr = rows.map((r: any) => `<tr><td>${esc(r.created_at.toISOString?.() ?? r.created_at)}</td><td>${esc(r.name)}</td><td>${esc(r.phone_e164)}</td><td>${esc(r.business_type)}</td><td>${esc(r.ad_source)}</td><td>${esc(r.status)}</td><td>${r.opt_in ? 'yes' : r.opted_out_at ? 'opted out' : 'no'}</td><td>${esc(r.welcome_status)}</td></tr>`).join('');
      return reply.type('text/html').send(
        `<!doctype html><meta name=viewport content="width=device-width"><title>Leads</title><p><a href="/admin/leads.csv?token=${encodeURIComponent(q.token ?? '')}"><b>Download as Excel (CSV)</b></a> &nbsp;|&nbsp; <a href="/admin/sheet/sync?token=${encodeURIComponent(q.token ?? '')}"><b>Send all leads to Google Sheet</b></a></p><table border=1 cellpadding=6><tr><th>When<th>Name<th>WhatsApp<th>Type<th>Source<th>Status<th>Opt-in<th>Welcome</tr>${tr}</table>`);
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

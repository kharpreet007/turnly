import type { Db } from './db.ts';

export interface TemplateDef {
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  body: string; // {{1}}-style variables
  buttons?: { type: 'QUICK_REPLY'; text: string }[];
}

// Phase 0 templates for Turnly's own funnel (business_id null = global).
export const PHASE0_TEMPLATES: TemplateDef[] = [
  {
    name: 'turnly_demo_welcome',
    language: 'en',
    // The person asked for this on the form, so it answers their request.
    category: 'UTILITY',
    body: 'Hi {{1}}, thanks for your query. Our support team will contact you soon. In the meantime, are you looking for packages or services? Reply 1 for Packages or 2 for Services. Reply STOP to opt out.',
  },
  {
    name: 'turnly_operator_new_lead',
    language: 'en',
    category: 'UTILITY',
    body: 'New Turnly lead: {{1}} ({{2}}), {{3}}. Source: {{4}}.',
  },
  {
    name: 'turnly_operator_lead_update',
    language: 'en',
    category: 'UTILITY',
    body: 'Lead update: {{1}}. Wants: {{2}}. Business: {{3}}. Best time to call: {{4}}.',
  },
];

export async function upsertTemplateDefs(db: Db, defs: TemplateDef[]): Promise<void> {
  for (const d of defs) {
    await db.query(
      `insert into templates (business_id, name, language, category, body, buttons)
       values (null, $1, $2, $3, $4, $5)
       on conflict (name, language) where business_id is null
       do update set category = excluded.category, body = excluded.body, buttons = excluded.buttons`,
      [d.name, d.language, d.category, d.body, JSON.stringify(d.buttons ?? [])],
    );
  }
}

export async function setTemplateStatus(db: Db, name: string, status: 'pending' | 'approved' | 'rejected', metaId?: string) {
  await db.query(`update templates set status = $2, meta_template_id = coalesce($3, meta_template_id) where name = $1`, [name, status, metaId ?? null]);
}

/** Submit a template to Meta for approval and mark it pending. */
export async function submitTemplate(wabaId: string, token: string, d: TemplateDef, graphVersion = 'v21.0') {
  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: d.name, language: d.language, category: d.category,
      components: [
        { type: 'BODY', text: d.body, example: { body_text: [Array.from({ length: (d.body.match(/{{\d+}}/g) ?? []).length }, (_, i) => `Sample${i + 1}`)] } },
        ...(d.buttons?.length ? [{ type: 'BUTTONS', buttons: d.buttons }] : []),
      ],
    }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json as { id: string; status: string };
}

/** Pull approval status from Meta into our table. */
export async function syncTemplateStatuses(db: Db, wabaId: string, token: string, graphVersion = 'v21.0') {
  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates?fields=name,language,status,id&limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  for (const t of json.data as { name: string; language: string; status: string; id: string }[]) {
    const status = t.status === 'APPROVED' ? 'approved' : t.status === 'REJECTED' ? 'rejected' : 'pending';
    await db.query(`update templates set status = $3, meta_template_id = $4 where name = $1 and language = $2`, [t.name, t.language, status, t.id]);
  }
}

import type { Db } from './db.ts';

export interface LeadExportRow {
  created_at: Date; name: string; phone_e164: string; business_type: string; ad_source: string | null;
  wants: unknown; est_monthly_loss: number | null; status: string; opt_in: boolean; opted_out_at: Date | null;
  welcome_status: string | null; submissions: number; utm: Record<string, string>; fbclid: string | null;
  referrer: string | null; consent_text: string; consent_at: Date; notes: string | null;
}

export async function exportLeads(db: Db): Promise<LeadExportRow[]> {
  const { rows } = await db.query(
    `select l.created_at, l.name, l.phone_e164, l.business_type, l.ad_source, l.wants, l.est_monthly_loss,
            l.status, c.opt_in, c.opted_out_at, l.submissions, l.utm, l.fbclid, l.referrer,
            l.consent_text, l.consent_at, l.notes,
            (select status from messages m where m.contact_id = l.contact_id and m.direction = 'out'
              and m.template_name = 'turnly_demo_welcome' order by m.created_at limit 1) as welcome_status
       from leads l join contacts c on c.id = l.contact_id
      order by l.created_at desc`);
  return rows;
}

export const ist = (d: Date | string) =>
  new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16);

/** Stop spreadsheet formulas in user-supplied text (=, +, -, @ at the start). */
const safe = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function leadsToCsv(rows: LeadExportRow[]): string {
  const head = ['When (IST)', 'Name', 'WhatsApp', 'Business type', 'Source', 'Plans wanted', 'Est. monthly loss (INR)',
    'Status', 'Opt-in', 'Welcome message', 'Submissions', 'UTM', 'Referrer', 'Consent given at (IST)', 'Consent text', 'Notes'];
  const lines = rows.map((r) => {
    const wants = Array.isArray(r.wants) ? r.wants.join('; ') : '';
    const utm = Object.entries(r.utm ?? {}).map(([k, v]) => `${k}=${v}`).join('; ');
    // Phone is validated E.164, so the ="..." form is safe and keeps the + sign and all digits in Excel.
    const cols = [
      ist(r.created_at), cell(safe(r.name)), `="${r.phone_e164}"`, cell(safe(r.business_type)), cell(safe(r.ad_source)),
      cell(safe(wants)), String(r.est_monthly_loss ?? ''), r.status,
      r.opt_in ? 'yes' : r.opted_out_at ? 'opted out' : 'no', cell(safe(r.welcome_status)), String(r.submissions),
      cell(safe(utm)), cell(safe(r.referrer)), ist(r.consent_at), cell(safe(r.consent_text)), cell(safe(r.notes)),
    ];
    return cols.map((c, i) => (i === 0 || i === 13 ? cell(c) : c)).join(',');
  });
  // BOM so Excel reads UTF-8 (₹, names) correctly.
  return '﻿' + [head.map(cell).join(','), ...lines].join('\r\n') + '\r\n';
}

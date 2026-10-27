import { createSign } from 'node:crypto';

export interface SheetConfig { clientEmail: string; privateKey: string; sheetId: string; tab: string }

/** Reads GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON or base64 of it), GOOGLE_SHEET_ID, optional GOOGLE_SHEET_TAB. */
export function sheetConfig(env: Record<string, string | undefined>): SheetConfig | null {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const sheetId = env.GOOGLE_SHEET_ID?.trim();
  if (!raw || !sheetId) return null;
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  let sa: { client_email?: string; private_key?: string };
  try {
    sa = JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole downloaded file, from the first { to the last }.');
  }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  return { clientEmail: sa.client_email, privateKey: sa.private_key, sheetId, tab: env.GOOGLE_SHEET_TAB?.trim() || 'Leads' };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

let cached: { key: string; token: string; exp: number } | null = null;

async function accessToken(cfg: SheetConfig, f: typeof fetch): Promise<string> {
  if (cached && cached.key === cfg.clientEmail && cached.exp > Date.now() + 60_000) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: cfg.clientEmail, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(cfg.privateKey);
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google auth failed: ${json.error_description ?? res.status}`);
  cached = { key: cfg.clientEmail, token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export const SHEET_HEADERS = ['When (IST)', 'Name', 'WhatsApp', 'Business type', 'Source', 'Plans wanted',
  'Est. monthly loss (INR)', 'Opt-in', 'Consent text', 'UTM', 'Lead ID', 'Status', 'Notes'];

/** Appends one row (writing the header first if the tab is empty). Values go in as plain text (RAW). */
export async function appendSheetRow(cfg: SheetConfig, row: string[], f: typeof fetch = fetch): Promise<string | undefined> {
  const token = await accessToken(cfg, f);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.sheetId)}/values`;
  const tab = `'${cfg.tab.replace(/'/g, "''")}'`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const fail = async (what: string, res: Response) => {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Google Sheets ${what} failed (${res.status}): ${j.error?.message ?? ''}`);
  };

  const probe = await f(`${base}/${encodeURIComponent(`${tab}!A1`)}`, { headers: auth });
  if (!probe.ok) await fail('read', probe);
  const first = (await probe.json()) as { values?: string[][] };
  if (!first.values?.length) {
    const put = await f(`${base}/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ values: [SHEET_HEADERS] }),
    });
    if (!put.ok) await fail('header write', put);
  }
  const res = await f(`${base}/${encodeURIComponent(`${tab}!A:M`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST', headers: auth, body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) await fail('append', res);
  const done = (await res.json().catch(() => ({}))) as { updates?: { updatedRange?: string } };
  return done.updates?.updatedRange; // e.g. Leads!A5:M5
}

/** Which spreadsheet and tabs the settings point at, so a wrong or copied sheet is easy to spot. */
export async function sheetInfo(cfg: SheetConfig, f: typeof fetch = fetch): Promise<{ title: string; tabs: string[] }> {
  const token = await accessToken(cfg, f);
  const res = await f(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.sheetId)}?fields=properties.title,sheets.properties.title`, { headers: { authorization: `Bearer ${token}` } });
  const j = (await res.json().catch(() => ({}))) as { properties?: { title?: string }; sheets?: { properties?: { title?: string } }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Google Sheets lookup failed (${res.status}): ${j.error?.message ?? ''}`);
  return { title: j.properties?.title ?? '', tabs: (j.sheets ?? []).map((x) => x.properties?.title ?? '') };
}

/** Empties the data rows (row 2 down) of the tab, keeping the header row. */
export async function clearSheetRows(cfg: SheetConfig, f: typeof fetch = fetch): Promise<void> {
  const token = await accessToken(cfg, f);
  const tab = `'${cfg.tab.replace(/'/g, "''")}'`;
  const res = await f(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.sheetId)}/values/${encodeURIComponent(`${tab}!A2:M`)}:clear`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Google Sheets clear failed (${res.status}): ${j.error?.message ?? ''}`);
  }
}

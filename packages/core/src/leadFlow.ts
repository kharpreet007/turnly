import type { Db } from './db.ts';
import { sendMessage, type SendDeps } from './sendMessage.ts';

/**
 * Turnly's own lead chat: after the form, ask what the lead wants and when to call.
 * Options are numbered text so it works on any provider (real buttons come with an approved template later).
 */
export interface Option { label: string; value: string }
export interface Answers { interest?: string; detail?: string; business?: string; best_time?: string }
export interface FlowState { flow: 'lead_qualify'; step: string; misses: number; seen: string[]; answers: Answers }

interface Step {
  question: string;
  options: Option[];
  save: (a: Answers, o: Option) => void;
  next: (a: Answers) => string;
}

const opts = (...labels: string[]): Option[] => labels.map((label) => ({ label, value: label }));

export const STEPS: Record<string, Step> = {
  interest: {
    question: 'In the meantime, are you looking for packages or services?',
    options: [{ label: 'Packages', value: 'packages' }, { label: 'Services', value: 'services' }],
    save: (a, o) => { a.interest = o.value; },
    next: (a) => (a.interest === 'packages' ? 'package' : 'service'),
  },
  package: {
    question: 'Which would you like?',
    options: opts('Reply', 'Remind', 'Return'),
    save: (a, o) => { a.detail = o.value; },
    next: () => 'business',
  },
  service: {
    question: 'What do you need?',
    options: opts('Set up my WhatsApp', 'Support', 'Something else'),
    save: (a, o) => { a.detail = o.value; },
    next: () => 'business',
  },
  business: {
    question: 'What kind of business do you run?',
    options: [
      { label: 'Salon & beauty', value: 'salon' }, { label: 'Clinic & dental', value: 'clinic' },
      { label: 'Gym & fitness', value: 'gym' }, { label: 'Coaching & classes', value: 'coaching' },
      { label: 'Restaurant & café', value: 'restaurant' }, { label: 'Shop & online store', value: 'retail' },
      { label: 'Real estate', value: 'property' }, { label: 'Something else', value: 'other' },
    ],
    save: (a, o) => { a.business = o.value; },
    next: () => 'time',
  },
  time: {
    question: 'When should our team call you?',
    options: opts('Morning', 'Afternoon', 'Evening'),
    save: (a, o) => { a.best_time = o.value; },
    next: () => 'done',
  },
};

export const FIRST_STEP = 'interest';

export function welcomeText(name: string): string {
  return `Hi ${name}, thanks for your query. Our support team will contact you soon. ${STEPS.interest.question}\nReply 1 for Packages or 2 for Services.`;
}

export function renderQuestion(step: string): string {
  const s = STEPS[step];
  return `${s.question}\n${s.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\nReply with a number.`;
}

/** "2", "services", "Services please" and a button title all pick an option. */
export function matchOption(text: string, options: Option[]): Option | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^\d+$/.test(t)) return options[Number(t) - 1] ?? null;
  if (t.length < 3) return null;
  return options.find((o) => o.label.toLowerCase() === t)
    ?? options.find((o) => t.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(t))
    ?? options.find((o) => o.value.toLowerCase() === t)
    ?? null;
}

export async function startLeadFlow(db: Db, businessId: string, contactId: string, leadId: string): Promise<void> {
  const state: FlowState = { flow: 'lead_qualify', step: FIRST_STEP, misses: 0, seen: [], answers: {} };
  await db.query(
    `insert into conversations (business_id, contact_id, flow_state) values ($1, $2, $3)
     on conflict (business_id, contact_id) do update set flow_state = excluded.flow_state, needs_human = false`,
    [businessId, contactId, JSON.stringify(state)]);
  await db.query(`update leads set flow_status = 'asking', answers = '{}', answers_dirty = false, flow_alerted_at = null where id = $1`, [leadId]);
}

export type FlowOutcome = 'ignored' | 'advanced' | 'retry' | 'done' | 'handoff';

/** Handle one incoming message. Safe to call twice for the same message (it remembers message ids). */
export async function advanceLeadFlow(
  deps: SendDeps,
  m: { businessId: string; contactId: string; waMessageId: string; text: string },
): Promise<FlowOutcome> {
  const { db } = deps;
  const { rows: [c] } = await db.query(
    `select v.flow_state, l.id as lead_id, l.name
       from conversations v join leads l on l.contact_id = v.contact_id and l.business_id = v.business_id
      where v.business_id = $1 and v.contact_id = $2 and v.flow_state->>'flow' = 'lead_qualify'
      order by l.created_at desc limit 1`,
    [m.businessId, m.contactId]);
  if (!c) return 'ignored';
  const state = c.flow_state as FlowState;
  if (state.step === 'done' || state.step === 'handoff' || state.seen.includes(m.waMessageId)) return 'ignored';

  const reply = (body: string) => sendMessage(deps, {
    businessId: m.businessId, contactId: m.contactId, purpose: 'reply', payload: { kind: 'text', body },
    dedupeKey: `flow:${m.waMessageId}`, actor: 'lead_flow',
  });
  const save = async (next: FlowState, status: string, needsHuman = false) => {
    next.seen = [...state.seen, m.waMessageId].slice(-30);
    await db.query(`update conversations set flow_state = $3, needs_human = $4 where business_id = $1 and contact_id = $2`,
      [m.businessId, m.contactId, JSON.stringify(next), needsHuman]);
    await db.query(`update leads set answers = $2, flow_status = $3, answers_dirty = true where id = $1`,
      [c.lead_id, JSON.stringify(next.answers), status]);
  };

  const step = STEPS[state.step];
  const picked = matchOption(m.text, step.options);

  if (!picked) {
    const misses = state.misses + 1;
    if (misses >= 2) {
      await reply('No problem. Our support team will contact you soon.');
      await save({ ...state, step: 'handoff', misses }, 'needs_human', true);
      return 'handoff';
    }
    await reply(`Sorry, I did not get that.\n${renderQuestion(state.step)}`);
    await save({ ...state, misses }, 'asking');
    return 'retry';
  }

  const answers = { ...state.answers };
  step.save(answers, picked);
  const nextKey = step.next(answers);
  if (nextKey === 'done') {
    const when = (answers.best_time ?? 'soon').toLowerCase();
    await reply(`Thanks, ${c.name}. Our team will reach you in the ${when}.`);
    await save({ ...state, step: 'done', misses: 0, answers }, 'done');
    return 'done';
  }
  await reply(renderQuestion(nextKey));
  await save({ ...state, step: nextKey, misses: 0, answers }, 'asking');
  return 'advanced';
}

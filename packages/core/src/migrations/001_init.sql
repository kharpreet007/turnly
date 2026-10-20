create extension if not exists pgcrypto;

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'other',
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR',
  hours jsonb not null default '{}',
  avg_ticket numeric,
  plan jsonb not null default '{}',
  status text not null default 'active',
  owner_phone_e164s text[] not null default '{}',
  is_self boolean not null default false,
  send_per_minute int not null default 600,
  created_at timestamptz not null default now()
);
create unique index businesses_one_self on businesses (is_self) where is_self;

create table wa_numbers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  phone_number_id text not null unique,
  waba_id text not null,
  display_number text,
  token_ref text,
  quality_rating text,
  messaging_tier text,
  status text not null default 'active'
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  phone_e164 text not null,
  name text,
  opt_in boolean not null default false,
  opt_in_at timestamptz,
  opt_in_source text,
  opt_in_text text,
  opted_out_at timestamptz,
  last_visit_at timestamptz,
  last_inbound_at timestamptz,
  tags text[] not null default '{}',
  blocked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (business_id, phone_e164)
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  contact_id uuid not null references contacts(id),
  flow_state jsonb not null default '{}',
  bot_paused_until timestamptz,
  needs_human boolean not null default false,
  window_expires_at timestamptz,
  unique (business_id, contact_id)
);

create table templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id),
  name text not null,
  language text not null default 'en',
  category text not null,
  body text not null,
  buttons jsonb not null default '[]',
  status text not null default 'pending',
  meta_template_id text,
  unique (business_id, name, language)
);
create unique index templates_global_name on templates (name, language) where business_id is null;

create table messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  contact_id uuid not null references contacts(id),
  conversation_id uuid references conversations(id),
  direction text not null check (direction in ('in', 'out')),
  wa_message_id text,
  type text not null,
  body text,
  template_name text,
  status text not null default 'queued',
  error text,
  dedupe_key text,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);
create unique index messages_wa_id on messages (business_id, wa_message_id) where wa_message_id is not null;
create unique index messages_dedupe on messages (business_id, dedupe_key) where dedupe_key is not null;
create index messages_contact_time on messages (contact_id, created_at desc);

create table leads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  contact_id uuid not null references contacts(id),
  phone_e164 text not null,
  name text not null,
  business_type text not null,
  ad_source text,
  wants jsonb,
  est_monthly_loss numeric,
  utm jsonb not null default '{}',
  fbclid text,
  referrer text,
  user_agent text,
  ip text,
  event_id text,
  status text not null default 'new'
    check (status in ('new','contacted','demo_sent','call_booked','won','lost')),
  notes text,
  consent_text text not null,
  consent_at timestamptz not null,
  submissions int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_phone_time on leads (phone_e164, created_at desc);

create table audit_log (
  id bigserial primary key,
  business_id uuid,
  actor text not null,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table events (
  id bigserial primary key,
  business_id uuid,
  name text not null,
  props jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table leads
  add column call_status text not null default 'none' check (call_status in ('none', 'booked', 'canceled')),
  add column call_start_at timestamptz,
  add column call_tz text,
  add column call_email text,
  add column call_notified_key text;

create table calendly_bookings (
  event_uri text primary key,
  lead_id uuid references leads(id) on delete set null,
  start_time timestamptz not null,
  event_status text not null,
  invitee_name text,
  invitee_email text,
  invitee_tz text,
  invitee_created_at timestamptz,
  updated_at timestamptz not null default now()
);
create index calendly_bookings_lead on calendly_bookings (lead_id);

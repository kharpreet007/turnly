alter table leads
  add column answers jsonb not null default '{}',
  add column flow_status text not null default 'none' check (flow_status in ('none', 'asking', 'done', 'needs_human')),
  add column answers_dirty boolean not null default false,
  add column flow_alerted_at timestamptz;

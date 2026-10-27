alter table leads add column email_sent_at timestamptz;
-- Leads that existed before email alerts were switched on are not emailed retroactively.
update leads set email_sent_at = now();

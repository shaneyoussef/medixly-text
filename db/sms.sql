-- Medixly Text — SMS notifications
--
-- A migration, not part of the initial schema: the database already exists.
-- Run this once against the live project.
--
-- Consent and opt-out belong to a phone number, not to a request. One patient
-- makes many requests, and saying STOP once has to silence all of them — a
-- per-request flag would let the next submission text someone who opted out.

create table if not exists sms_contacts (
  phone         text primary key,               -- 10 digits, no formatting
  pharmacy_id   text not null references pharmacies(id),

  -- First-contact disclosure: texts aren't secure, don't reply with health
  -- details, reply STOP to opt out. docs/COMPLIANCE.md requires it before any
  -- other message goes out, so a null here means "not yet greeted".
  consent_at    timestamptz,

  opted_out     boolean not null default false,
  opted_out_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists sms_contacts_pharmacy on sms_contacts (pharmacy_id, opted_out);

-- ---------------------------------------------------------------
-- sms_log — metadata only, never the message body
--
-- Enough to answer "did we text this patient, when, and about what event",
-- which is what a custodian has to be able to account for. The body is a
-- template name; the text itself is reconstructable from api/notify.ts and
-- carries no PHI anyway.
-- ---------------------------------------------------------------
create table if not exists sms_log (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  pharmacy_id   text not null references pharmacies(id),
  phone         text not null,
  request_id    uuid,                            -- null for account-level texts
  event         text not null,                   -- 'received', 'ready', …
  provider_id   text,                            -- Twilio message SID
  outcome       text not null                    -- 'sent', 'opted_out', 'failed', …
);

create index if not exists sms_log_phone on sms_log (phone, at desc);
create index if not exists sms_log_request on sms_log (request_id, at desc);

revoke update, delete on sms_log from public;

-- ---------------------------------------------------------------
-- Row-level security, matching the rest of the schema.
-- ---------------------------------------------------------------
alter table sms_contacts enable row level security;
alter table sms_log enable row level security;

create policy pharmacy_scope_sms_contacts on sms_contacts
  for all
  using (pharmacy_id = current_setting('app.pharmacy_id', true));

create policy pharmacy_scope_sms_log on sms_log
  for select
  using (pharmacy_id = current_setting('app.pharmacy_id', true));

create trigger sms_contacts_touch before update on sms_contacts
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------
-- Retention
--
-- The contact row is the consent record and outlives any single request, the
-- same way the handoff log does — an opt-out you deleted is an opt-out you
-- cannot prove you honoured. The log holds no content, so it keeps with the
-- record it belongs to.
-- ---------------------------------------------------------------

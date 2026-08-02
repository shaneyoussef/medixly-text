-- Medixly Text — schema
-- One table serves all six intents. The shape is identical across forms;
-- only `payload` differs. Six tables would mean six endpoints, six queue
-- views, and six migrations every time something changes.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------
-- pharmacies
-- ---------------------------------------------------------------
create table pharmacies (
  id            text primary key,              -- 'oldpark'
  name          text not null,
  phone         text not null,                 -- voice line, shown to patients
  notify_email  text not null,                 -- where new requests land
  timezone      text not null default 'America/Toronto',
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- requests — every intake, every channel
-- ---------------------------------------------------------------
create type request_intent as enum (
  'REFILL','TRANSFER','RX_UPLOAD','MINOR_AILMENT','PHARMACIST_CHAT','OTC_ORDER'
);

create type request_channel as enum ('sms','web','voice','chat');

create type request_status as enum (
  'new','in_progress','waiting_on_patient','completed','cancelled'
);

create table requests (
  id            uuid primary key default gen_random_uuid(),
  reference     text unique not null,          -- 'TR-K4J8Q', shown to the patient
  pharmacy_id   text not null references pharmacies(id),

  intent        request_intent not null,
  channel       request_channel not null,
  status        request_status not null default 'new',

  -- identity, common to every form
  patient_name  text not null,
  patient_phone text not null,                 -- 10 digits, no formatting
  patient_dob   date,

  -- everything form-specific
  payload       jsonb not null default '{}'::jsonb,

  -- PHIPA consent, captured at submit
  consent_given boolean not null,
  consent_at    timestamptz not null,
  consent_method text not null default 'checkbox',  -- or 'verbal, recorded'

  -- workflow
  assigned_to   text,
  staff_notes   text,
  completed_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index on requests (pharmacy_id, status, created_at desc);
create index on requests (reference);
create index on requests (patient_phone);

-- Queue ordering: oldest unhandled first, so nothing rots at the bottom.
create view request_queue as
  select id, reference, pharmacy_id, intent, channel, status,
         patient_name, patient_phone, created_at,
         extract(epoch from (now() - created_at)) / 3600 as hours_open
  from requests
  where status in ('new','in_progress','waiting_on_patient')
  order by created_at asc;

-- ---------------------------------------------------------------
-- audit_log — append only
-- PHIPA requires the custodian to account for who accessed what, when.
-- ---------------------------------------------------------------
create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  pharmacy_id text,
  request_id  uuid,
  actor       text not null,                   -- staff id, or 'system'
  action      text not null,                   -- 'created','viewed','updated','exported'
  detail      jsonb
);

create index on audit_log (request_id, at desc);
create index on audit_log (pharmacy_id, at desc);

revoke update, delete on audit_log from public;

-- ---------------------------------------------------------------
-- Row-level security — a pharmacy sees only its own requests.
-- This is the multi-tenancy guarantee. Without it, one bad query
-- exposes every pharmacy's patients.
-- ---------------------------------------------------------------
alter table requests enable row level security;
alter table audit_log enable row level security;

create policy pharmacy_scope on requests
  for all
  using (pharmacy_id = current_setting('app.pharmacy_id', true));

create policy pharmacy_scope_audit on audit_log
  for select
  using (pharmacy_id = current_setting('app.pharmacy_id', true));

-- ---------------------------------------------------------------
-- Retention — payloads are purged on a schedule, references are kept.
-- Keeps the audit trail intact without keeping the health information.
-- Run daily. Adjust the interval to whatever the retention policy says.
-- ---------------------------------------------------------------
create or replace function purge_old_payloads(retain interval default '2 years')
returns integer language plpgsql as $$
declare n integer;
begin
  update requests
     set payload = '{"purged": true}'::jsonb,
         staff_notes = null
   where status in ('completed','cancelled')
     and completed_at < now() - retain
     and not (payload ? 'purged');
  get diagnostics n = row_count;
  insert into audit_log (actor, action, detail)
       values ('system', 'purged', jsonb_build_object('rows', n, 'retain', retain::text));
  return n;
end $$;

-- ---------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger requests_touch before update on requests
  for each row execute function touch_updated_at();

-- Medixly Text — patient/pharmacist messaging
--
-- Catches db/schema.sql up with what the live project already has, and adds
-- what the encrypted channel needs. Safe to run more than once.
--
-- This is the one channel that MAY carry health information. SMS is the front
-- door only and carries none; the forms carry structured PHI; this carries
-- whatever a patient chooses to type, which in practice is symptoms.

-- ---------------------------------------------------------------
-- The patient's way in.
--
-- A thread hangs off a request rather than off a patient account, and the
-- token is scoped to that one request. Two reasons. A patient who never made
-- an account can still be answered, and a link that leaks exposes one
-- conversation rather than a medical history.
-- ---------------------------------------------------------------
alter table requests add column if not exists chat_token      text;
alter table requests add column if not exists chat_expires_at timestamptz;

create unique index if not exists requests_chat_token_key
  on requests (chat_token) where chat_token is not null;

do $$ begin
  create type message_sender as enum ('patient','pharmacist');
exception when duplicate_object then null; end $$;

create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references requests(id) on delete cascade,
  pharmacy_id text not null references pharmacies(id),

  sender      message_sender not null,
  author      text,                    -- which staff member; null for patients

  -- Ciphertext, never plaintext. The format is self-describing:
  --
  --   mx1.<key id>.<base64url iv>.<base64url ciphertext+tag>
  --
  -- AES-256-GCM, with the key held as an edge-function secret and never in
  -- this database. That is the point: a stolen dump, a leaked backup or a
  -- support engineer with table access gets ciphertext. It is not end-to-end
  -- encryption and must not be described as such — the pharmacy can read
  -- these, because PHIPA requires the custodian to be able to.
  --
  -- The key id is in the envelope so keys can be rotated without rewriting
  -- history: old messages keep naming the key that opened them.
  body        text not null,

  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists messages_thread
  on messages (request_id, created_at);

-- Unread count for the queue, without reading a single message body.
create index if not exists messages_unread
  on messages (pharmacy_id, read_at) where sender = 'patient' and read_at is null;

alter table messages enable row level security;

do $$ begin
  create policy pharmacy_scope_messages on messages
    for all using (pharmacy_id = current_setting('app.pharmacy_id', true));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------
-- Retention
--
-- Message bodies are the most sensitive thing this system stores, so they go
-- with the request payload rather than outliving it. purge_old_payloads() in
-- schema.sql handles requests; this is its other half. The row survives with
-- its timestamps so the audit trail still shows that a conversation happened
-- and when — deleting that would defeat the log.
-- ---------------------------------------------------------------
create or replace function purge_old_messages(retain interval default '2 years')
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare n integer;
begin
  update messages m
     set body = 'purged'
    from requests r
   where m.request_id = r.id
     and r.status in ('completed','cancelled')
     and r.completed_at < now() - retain
     and m.body <> 'purged';
  get diagnostics n = row_count;
  insert into audit_log (actor, action, detail)
       values ('system', 'purged_messages', jsonb_build_object('rows', n, 'retain', retain::text));
  return n;
end $$;

-- Run Wild Melorane – database setup for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query, and click Run. Safe to run again.
--
-- All event data (entries, launch registrations, payments, settings, user accounts, audit trail)
-- lives in one row of public.app_state, written only by the "api" Edge Function. Nobody can read
-- or change it through Supabase's public API.
--
-- The views in the "reports" schema turn that data into ordinary tables you can browse in the
-- Table Editor (choose schema "reports") or query in the SQL Editor. They are read-only and are
-- not reachable from the public API either.

create table if not exists public.app_state (
  id         integer primary key default 1 check (id = 1),
  state      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.app_state (id) values (1) on conflict (id) do nothing;

-- Row-level security with no policies: the public API (anon / authenticated roles) gets nothing.
alter table public.app_state enable row level security;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.app_state from anon, authenticated';
  end if;
end $$;

-- ---------- reports (read-only views) ----------

create schema if not exists reports;

create or replace function reports.ts(ms jsonb) returns timestamptz language sql immutable as $$
  select case when ms is null or ms = 'null'::jsonb then null else to_timestamp((ms #>> '{}')::double precision / 1000) end
$$;

create or replace view reports.race_entries as
select r->>'ref'                                as ref,
       r->>'status'                             as status,
       r->>'category'                           as category,
       r->>'distance'                           as distance,
       r->>'fullName'                           as full_name,
       r->>'mobile'                             as mobile,
       nullif(r->>'email', '')                  as email,
       nullif(r->>'employer', '')               as employer,
       r->>'verification'                       as verification,
       r->>'shirtSize'                          as shirt_size,
       (r->'socks'->>'qty')::int                as socks_pairs,
       r->'socks'->>'size'                      as sock_size,
       coalesce((r->'kit'->>'needsShoes')::boolean, false) as needs_shoes,
       coalesce((r->'kit'->>'needsKit')::boolean, false)   as needs_kit,
       nullif(r->'kit'->>'shoeSize', '')        as shoe_size,
       nullif(r->'kit'->>'shortsSize', '')      as shorts_size,
       r->>'emergencyName'                      as emergency_name,
       r->>'emergencyMobile'                    as emergency_mobile,
       coalesce((r->'lodge'->>'wanted')::boolean, false)   as lodge_requested,
       coalesce((r->'buddy'->>'optIn')::boolean, false)    as run_buddy,
       r->>'cancelReason'                       as cancel_reason,
       coalesce((r->>'assisted')::boolean, false)          as organiser_assisted,
       reports.ts(r->'createdAt')               as registered_at
from public.app_state a, jsonb_array_elements(coalesce(a.state->'registrations', '[]'::jsonb)) r;

create or replace view reports.launch_registrations as
select l->>'ref'                                as ref,
       l->>'firstName'                          as first_name,
       l->>'surname'                            as surname,
       l->>'email'                              as email,
       coalesce((l->>'personalEmail')::boolean, false) as personal_email,
       l->>'status'                             as status,
       reports.ts(l->'createdAt')               as registered_at
from public.app_state a, jsonb_array_elements(coalesce(a.state->'launchRegistrations', '[]'::jsonb)) l;

-- Everything that is billed: entry fees, socks, lodge deposits and balances, sponsorships, donations.
create or replace view reports.charges as
select c->>'ref'                                as ref,
       c->>'kind'                               as kind,
       c->>'label'                              as item,
       (c->>'amount')::numeric / 100            as amount_rand,
       coalesce(p.paid, 0) / 100                as paid_rand,
       greatest(0, (c->>'amount')::numeric - coalesce(p.paid, 0)) / 100 as outstanding_rand,
       (c->>'dueDate')::date                    as due_date,
       reports.ts(c->'createdAt')               as created_at
from public.app_state a
cross join jsonb_array_elements(coalesce(a.state->'charges', '[]'::jsonb)) c
left join lateral (
  select sum((x->>'amount')::numeric) as paid
  from jsonb_array_elements(coalesce(a.state->'payments', '[]'::jsonb)) x
  where x->>'chargeId' = c->>'id' and x->>'status' = 'received'
) p on true;

create or replace view reports.payments as
select reports.ts(x->'at')                      as received_at,
       c->>'ref'                                as charge_ref,
       c->>'label'                              as item,
       (x->>'amount')::numeric / 100            as amount_rand,
       x->>'method'                             as method,
       coalesce(x->>'bankRef', x->>'providerEventId') as reference,
       x->>'recordedBy'                         as recorded_by,
       x->>'flag'                               as flag
from public.app_state a
cross join jsonb_array_elements(coalesce(a.state->'payments', '[]'::jsonb)) x
left join jsonb_array_elements(coalesce(a.state->'charges', '[]'::jsonb)) c on c->>'id' = x->>'chargeId';

create or replace view reports.donations as
select d->>'ref' as ref, d->>'donor' as donor, d->>'email' as email, (d->>'runners')::int as runners,
       (d->>'amount')::numeric / 100 as amount_rand, d->>'status' as status, reports.ts(d->'createdAt') as created_at
from public.app_state a, jsonb_array_elements(coalesce(a.state->'contributions', '[]'::jsonb)) d;

create or replace view reports.water_point_sponsors as
select w->>'ref' as ref, (w->>'point')::int as water_point, w->>'name' as sponsor, w->>'contactPerson' as contact_person,
       w->>'email' as email, w->>'phone' as phone, w->>'status' as status, reports.ts(w->'createdAt') as created_at
from public.app_state a, jsonb_array_elements(coalesce(a.state->'sponsorships', '[]'::jsonb)) w;

-- Organiser accounts, without password hashes.
create or replace view reports.users as
select u->>'email' as login, u->>'name' as name, u->>'role' as role, (u->>'active')::boolean as active,
       coalesce((u->>'mustChangePassword')::boolean, false) as must_change_password,
       reports.ts(u->'lastLoginAt') as last_sign_in, reports.ts(u->'createdAt') as created_at
from public.app_state a, jsonb_array_elements(coalesce(a.state->'users', '[]'::jsonb)) u;

create or replace view reports.audit_trail as
select reports.ts(x->'at') as at, x->>'actor' as who, x->>'action' as action, x->>'target' as record, x->>'details' as details
from public.app_state a, jsonb_array_elements(coalesce(a.state->'audit', '[]'::jsonb)) x;

-- Key settings at a glance.
create or replace view reports.key_settings as
select (s->'event'->>'date')::date                    as race_date,
       (s->'registration'->>'opensOn')::date          as race_entries_open,
       nullif(s->'launchEvent'->>'date', '')::date    as launch_date,
       s->'launchEvent'->>'time'                      as launch_time,
       s->'launchEvent'->>'venue'                     as launch_venue,
       (s->'pools'->'combined'->>'limit')::int        as combined_places,
       (s->'pools'->'community'->>'limit')::int       as community_places,
       a.updated_at                                   as last_change
from public.app_state a, lateral (select a.state->'settings' as s) x;

do $$ begin
  revoke all on schema reports from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema reports from anon, authenticated';
    execute 'revoke all on all tables in schema reports from anon, authenticated';
  end if;
end $$;

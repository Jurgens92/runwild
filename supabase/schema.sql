-- Run Wild Melorane – production database for Supabase (Postgres 15+).
--
-- The GitHub Pages preview runs its rules in the browser. That proves the flows but cannot
-- protect real capacity or personal data, because anyone can change code running in their own
-- browser. Before launch these rules move here, where they cannot be bypassed:
--
--   * Capacity: reserve_registration() locks the pool's row (SELECT ... FOR UPDATE) before
--     counting and inserting, so two people can never get the same last place.
--   * Idempotency: client_request_id and provider event ids are UNIQUE.
--   * Water points: the point's row is locked and a partial unique index is a second guard.
--   * Privacy: row-level security is on for every table. Anonymous visitors get only the
--     aggregate public_summary() and their own entry via my_entry(ref, mobile).
--
-- Run in the Supabase SQL editor, or: psql "$DATABASE_URL" -f supabase/schema.sql

create extension if not exists pgcrypto;

-- ---------- reference data ----------

create table if not exists capacity_pools (
  pool        text primary key check (pool in ('combined', 'community')),
  place_limit integer not null check (place_limit >= 0)
);
insert into capacity_pools values ('combined', 34), ('community', 16) on conflict do nothing;

create table if not exists categories (
  category      text primary key,
  pool          text references capacity_pools(pool),
  fee_cents     integer check (fee_cents >= 0),
  fee_confirmed boolean not null default false
);
insert into categories values
  ('group_employee', 'combined', 100000, true),
  ('other', 'combined', 100000, true),
  ('community', 'community', null, false),
  ('melorane_employee', null, null, false)
on conflict do nothing;

create table if not exists event_settings (
  id                     boolean primary key default true check (id),
  reservation_hours      integer not null default 72 check (reservation_hours > 0),
  registration_opens_on  date not null default '2027-02-01',   -- race entries closed to the public before this (SAST)
  launch_open            boolean not null default true,
  accept_unconfirmed_fee boolean not null default false,
  lodge_rate_cents       integer not null default 550000,
  lodge_deposit_percent  integer not null default 20 check (lodge_deposit_percent between 0 and 100),
  lodge_balance_due      date not null default '2027-01-31',
  lodge_hold_hours       integer not null default 72,
  lodge_min_nights       integer not null default 2 check (lodge_min_nights >= 1),
  socks_cents            integer check (socks_cents > 0),         -- null until the sock price is confirmed
  socks_max_per_entry    integer not null default 5,
  donation_per_runner    integer not null default 250000,         -- shoes, shorts, shirt, socks and cap
  donation_min_cents     integer not null default 5000,
  water_point_cents      integer not null default 500000,
  water_point_hold_hours integer not null default 72,
  settings               jsonb not null default '{}'::jsonb   -- texts, approvals, policies
);
insert into event_settings (id) values (true) on conflict do nothing;

create table if not exists invite_codes (
  code      text primary key,
  category  text not null references categories(category) check (category in ('group_employee', 'melorane_employee')),
  max_uses  integer default 100,        -- null = unlimited (Melorane employees have unlimited entries)
  uses      integer not null default 0
);

create table if not exists organisers (
  user_id uuid primary key,          -- auth.users.id
  email   text not null unique,
  name    text
);

create or replace function is_organiser() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from organisers where user_id = auth.uid());
$$;

-- ---------- registrations ----------

create table if not exists registrations (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,
  client_request_id text not null unique,
  category          text not null references categories(category),
  pool              text references capacity_pools(pool),
  distance          text not null check (distance in ('21k', '5k')),
  status            text not null check (status in ('draft', 'reserved', 'confirmed', 'waitlisted', 'cancelled')),
  expires_at        timestamptz,
  hold_reason       text,
  cancel_reason     text,
  verification      text not null default 'n/a' check (verification in ('n/a', 'pending', 'verified', 'declined')),
  verified_by       text,
  full_name         text not null,
  mobile            text not null,
  email             text,
  emergency_name    text not null,
  emergency_mobile  text not null,
  employer          text,
  shirt_size        text not null check (shirt_size in ('XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL')),  -- every entry includes a RunWild shirt
  socks_qty         integer not null default 0 check (socks_qty >= 0),
  socks_size        text check (socks_size in ('S (UK 3–5)', 'M (UK 6–8)', 'L (UK 9–11)', 'XL (UK 12+)')),
  details           jsonb not null default '{}'::jsonb,  -- kit request and sizes, buddy, acknowledgements
  terms_version     text not null,
  assisted_by       uuid,
  attention         text,
  created_at        timestamptz not null default now(),
  check (socks_qty = 0 or socks_size is not null)
);
create index if not exists registrations_pool_status on registrations (pool, status);
create unique index if not exists registrations_active_person on registrations (mobile, lower(full_name)) where status <> 'cancelled';

create table if not exists charges (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('entry', 'socks', 'lodge_deposit', 'lodge_balance', 'sponsorship', 'donation')),
  owner_type  text not null,
  owner_id    uuid not null,
  label       text not null,
  amount      integer not null check (amount >= 0),
  ref         text not null unique,   -- also the EFT reference
  due_date    date,
  created_at  timestamptz not null default now(),
  unique (owner_id, kind)
);

create table if not exists payments (
  id                uuid primary key default gen_random_uuid(),
  charge_id         uuid not null references charges(id),
  amount            integer not null check (amount > 0),
  method            text not null check (method in ('provider', 'eft')),
  provider_event_id text unique,
  bank_ref          text,
  recorded_by       uuid,
  flag              text,
  received_at       timestamptz not null default now(),
  unique (charge_id, bank_ref)
);

create table if not exists provider_events (
  event_id    text primary key,
  received_at timestamptz not null default now(),
  payload     jsonb
);

create table if not exists audit_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  actor   text not null,
  action  text not null,
  target  text,
  details jsonb
);

-- ---------- water points ----------

create table if not exists water_points (point integer primary key check (point between 1 and 5));
insert into water_points select generate_series(1, 5) on conflict do nothing;

create table if not exists sponsorships (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,
  client_request_id text not null unique,
  point             integer not null references water_points(point),
  name              text not null,
  contact_person    text not null,
  email             text not null,
  phone             text not null,
  website           text,
  logo_path         text,
  billing           text,
  display_consent   boolean not null default false,
  status            text not null check (status in ('reserved', 'confirmed', 'expired', 'cancelled')),
  expires_at        timestamptz,
  created_at        timestamptz not null default now()
);
-- Second line of defence: at most one live sponsorship per point.
create unique index if not exists one_live_sponsorship_per_point on sponsorships (point) where status in ('reserved', 'confirmed');

-- ---------- lodge, donations, buddies ----------

create table if not exists lodge_nights (night date primary key, beds integer not null check (beds >= 0));

create table if not exists lodge_requests (
  id              uuid primary key default gen_random_uuid(),
  registration_id uuid not null references registrations(id),
  arrival         date not null,
  departure       date not null check (departure > arrival),
  nights          integer generated always as (departure - arrival) stored,
  total           integer not null,
  deposit         integer not null,
  balance         integer not null,
  balance_due     date,
  status          text not null check (status in ('requested', 'awaiting_deposit', 'confirmed', 'paid_in_full', 'declined', 'cancelled', 'expired')),
  expires_at      timestamptz,
  created_at      timestamptz not null default now()
);

-- Canvas Lodge bookings have a minimum stay (two nights by default).
create or replace function check_lodge_min_nights() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_min integer;
begin
  select lodge_min_nights into v_min from event_settings;
  if new.departure - new.arrival < coalesce(v_min, 1) then
    raise exception 'Canvas Lodge bookings are for a minimum of % nights', v_min using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists lodge_min_nights on lodge_requests;
create trigger lodge_min_nights before insert or update of arrival, departure on lodge_requests
  for each row execute function check_lodge_min_nights();

-- Monetary donations only. ERP buys the shoes and kit and records them as stock_items.
create table if not exists donations (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,
  client_request_id text not null unique,
  donor             text not null,
  email             text not null,
  phone             text,
  runners           integer check (runners between 1 and 50),   -- null = a general amount
  amount            integer not null check (amount > 0),
  status            text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'cancelled')),
  created_at        timestamptz not null default now()
);

create table if not exists stock_items (
  id           uuid primary key default gen_random_uuid(),
  item_type    text not null check (item_type in ('shoes', 'kit')),
  sizes        jsonb not null,
  source       text not null default 'purchase' check (source in ('purchase')),
  source_id    text,
  status       text not null default 'in_stock' check (status in ('in_stock', 'allocated', 'delivered')),
  allocated_to uuid references registrations(id),
  received_at  timestamptz not null default now()
);

create table if not exists buddy_matches (
  id                uuid primary key default gen_random_uuid(),
  volunteer_id      uuid not null references registrations(id),
  community_id      uuid not null references registrations(id),
  consent_volunteer boolean not null default false,
  consent_community boolean not null default false,
  status            text not null default 'proposed' check (status in ('proposed', 'introduced', 'ended')),
  created_at        timestamptz not null default now()
);

-- ---------- helpers ----------

create or replace function new_ref(prefix text) returns text language plpgsql as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  r text;
begin
  loop
    r := prefix || '-';
    for i in 1..5 loop r := r || substr(alphabet, 1 + floor(random() * 32)::int, 1); end loop;
    exit when not exists (select 1 from registrations where ref = r) and not exists (select 1 from sponsorships where ref = r)
      and not exists (select 1 from donations where ref = r)
      and not exists (select 1 from launch_registrations where ref = r);
  end loop;
  return r;
end $$;

-- Releases unpaid reservations whose time is up. Never touches the waitlist.
create or replace function release_expired(p_pool text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with x as (
    update registrations set status = 'cancelled', cancel_reason = 'reservation_expired'
    where status = 'reserved' and expires_at is not null and expires_at <= now()
      and (p_pool is null or pool = p_pool)
    returning ref
  ), a as (insert into audit_log (actor, action, target) select 'system', 'registration.expired', ref from x returning 1)
  select count(*) into n from a;
  return n;
end $$;

-- ---------- the atomic reservation ----------

create or replace function reserve_registration(p jsonb) returns registrations
language plpgsql security definer set search_path = public as $$
declare
  v_existing registrations;
  v_cat      categories;
  v_set      event_settings;
  v_code     invite_codes;
  v_limit    integer;
  v_used     integer;
  v_reg      registrations;
  v_status   text := 'reserved';
  v_verif    text := 'n/a';
begin
  -- Same request twice (double click, retry): return the first result.
  select * into v_existing from registrations where client_request_id = p->>'client_request_id';
  if found then return v_existing; end if;

  select * into v_cat from categories where category = p->>'category';
  if not found then raise exception 'unknown category'; end if;
  select * into v_set from event_settings;
  if not v_cat.fee_confirmed and not v_set.accept_unconfirmed_fee then
    raise exception 'registration for this category opens once the fee is confirmed';
  end if;
  if (now() at time zone 'Africa/Johannesburg')::date < v_set.registration_opens_on and not is_organiser() then
    raise exception 'Race entries open on %', to_char(v_set.registration_opens_on, 'FMDD FMMonth YYYY') using errcode = 'P0001';
  end if;
  if coalesce((p->>'terms_accepted')::boolean, false) is not true then raise exception 'terms must be accepted'; end if;
  if coalesce(p->>'shirt_size', '') = '' then raise exception 'choose a RunWild shirt size'; end if;
  if coalesce((p->>'socks_qty')::int, 0) not between 0 and v_set.socks_max_per_entry then raise exception 'too many pairs of socks'; end if;

  if v_cat.category in ('group_employee', 'melorane_employee') then
    v_verif := 'pending';
    select * into v_code from invite_codes
      where upper(code) = upper(coalesce(p->>'invite_code', '')) and category = v_cat.category and (max_uses is null or uses < max_uses)
      for update;
    if found then
      update invite_codes set uses = uses + 1 where code = v_code.code;
      v_verif := 'verified';
    end if;
  end if;

  if v_verif = 'pending' then
    v_status := 'draft';                           -- no place until an organiser verifies
  elsif v_cat.pool is not null then
    -- Serialise every reservation for this pool. Concurrent callers queue here.
    select place_limit into v_limit from capacity_pools where pool = v_cat.pool for update;
    perform release_expired(v_cat.pool);
    select count(*) into v_used from registrations
      where pool = v_cat.pool
        and (status = 'confirmed' or (status = 'reserved' and (expires_at is null or expires_at > now())));
    if v_used >= v_limit then v_status := 'waitlisted'; end if;
  end if;

  begin
    insert into registrations (ref, client_request_id, category, pool, distance, status, expires_at, hold_reason, verification,
      full_name, mobile, email, emergency_name, emergency_mobile, employer, shirt_size, socks_qty, socks_size, details, terms_version, assisted_by)
    values (new_ref('RWM'), p->>'client_request_id', v_cat.category, v_cat.pool, p->>'distance', v_status,
      case when v_status = 'reserved' and v_cat.fee_confirmed and v_cat.fee_cents > 0 then now() + make_interval(hours => v_set.reservation_hours) end,
      case when v_status = 'reserved' and not v_cat.fee_confirmed then 'fee_unconfirmed' end,
      v_verif, p->>'full_name', p->>'mobile', nullif(p->>'email', ''), p->>'emergency_name', p->>'emergency_mobile',
      nullif(p->>'employer', ''), p->>'shirt_size', coalesce((p->>'socks_qty')::int, 0), nullif(p->>'socks_size', ''),
      coalesce(p->'details', '{}'::jsonb), coalesce(p->>'terms_version', 'draft'),
      case when is_organiser() then auth.uid() end)
    returning * into v_reg;
  exception when unique_violation then
    -- A simultaneous duplicate of this same request won the race: hand back its record.
    select * into v_existing from registrations where client_request_id = p->>'client_request_id';
    if found then return v_existing; end if;
    raise exception 'An active entry already exists for this name and mobile number';
  end;

  if v_status = 'reserved' and v_cat.fee_confirmed then
    if v_cat.fee_cents = 0 then
      update registrations set status = 'confirmed', expires_at = null where id = v_reg.id returning * into v_reg;
    else
      insert into charges (kind, owner_type, owner_id, label, amount, ref)
      values ('entry', 'registration', v_reg.id, 'Charitable entry fee', v_cat.fee_cents, v_reg.ref || '-E');
    end if;
  end if;

  -- Socks add-on: a separate charge, raised only once the entry holds a place and the price is set.
  if v_status = 'reserved' and v_reg.socks_qty > 0 and v_set.socks_cents is not null then
    insert into charges (kind, owner_type, owner_id, label, amount, ref)
    values ('socks', 'registration', v_reg.id, 'RunWild running socks × ' || v_reg.socks_qty, v_set.socks_cents * v_reg.socks_qty, v_reg.ref || '-S');
  end if;

  insert into audit_log (actor, action, target, details)
  values (coalesce(auth.uid()::text, 'participant'), 'registration.created', v_reg.ref, jsonb_build_object('status', v_reg.status, 'category', v_reg.category));
  return v_reg;
end $$;

-- ---------- payments ----------

-- Called only by the payment webhook (Edge Function using the service role) AFTER it has
-- verified the provider's signature. Repeated notifications are ignored.
create or replace function apply_provider_payment(p_event_id text, p_charge_ref text, p_amount integer, p_payload jsonb default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_charge charges;
  v_paid   integer;
begin
  insert into provider_events (event_id, payload) values (p_event_id, p_payload) on conflict do nothing;
  if not found then return 'duplicate'; end if;
  select * into v_charge from charges where ref = p_charge_ref for update;
  if not found then return 'unknown_charge'; end if;
  select coalesce(sum(amount), 0) into v_paid from payments where charge_id = v_charge.id;
  insert into payments (charge_id, amount, method, provider_event_id, flag)
  values (v_charge.id, p_amount, 'provider', p_event_id, case when v_paid >= v_charge.amount then 'already paid – review for refund' end);
  perform on_charge_paid(v_charge.id);
  insert into audit_log (actor, action, target, details) values ('provider', 'payment.received', p_charge_ref, jsonb_build_object('amount', p_amount));
  return 'applied';
end $$;

create or replace function record_eft(p_charge_id uuid, p_amount integer, p_bank_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_organiser() then raise exception 'organisers only'; end if;
  insert into payments (charge_id, amount, method, bank_ref, recorded_by) values (p_charge_id, p_amount, 'eft', p_bank_ref, auth.uid());
  perform on_charge_paid(p_charge_id);
  insert into audit_log (actor, action, target, details) values (auth.uid()::text, 'payment.eft', p_charge_id::text, jsonb_build_object('amount', p_amount, 'bank_ref', p_bank_ref));
end $$;

create or replace function on_charge_paid(p_charge_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c charges; v_paid integer; r registrations; v_limit integer; v_used integer;
begin
  select * into c from charges where id = p_charge_id;
  select coalesce(sum(amount), 0) into v_paid from payments where charge_id = c.id;
  if v_paid < c.amount then return; end if;
  if c.kind = 'entry' then
    select * into r from registrations where id = c.owner_id for update;
    if r.status = 'reserved' then
      update registrations set status = 'confirmed', expires_at = null where id = r.id;
    elsif r.status = 'cancelled' and r.cancel_reason = 'reservation_expired' then
      select place_limit into v_limit from capacity_pools where pool = r.pool for update;
      select count(*) into v_used from registrations where pool = r.pool
        and (status = 'confirmed' or (status = 'reserved' and (expires_at is null or expires_at > now())));
      if r.pool is null or v_used < v_limit then
        update registrations set status = 'confirmed', cancel_reason = null where id = r.id;
      else
        update registrations set attention = 'Paid after reservation expired; pool full – decide or refund' where id = r.id;
      end if;
    end if;
  elsif c.kind = 'lodge_deposit' then
    update lodge_requests set status = 'confirmed', expires_at = null where id = c.owner_id and status in ('awaiting_deposit');
  elsif c.kind = 'lodge_balance' then
    update lodge_requests set status = 'paid_in_full' where id = c.owner_id and status = 'confirmed';
  elsif c.kind = 'sponsorship' then
    update sponsorships set status = 'confirmed', expires_at = null where id = c.owner_id and status = 'reserved';
  elsif c.kind = 'donation' then
    update donations set status = 'paid' where id = c.owner_id and status = 'awaiting_payment';
  end if;
end $$;

-- ---------- donations (money only) ----------

create or replace function create_donation(p jsonb) returns donations
language plpgsql security definer set search_path = public as $$
declare v donations; s event_settings; v_runners integer := nullif(p->>'runners', '')::int; v_amount integer;
begin
  select * into v from donations where client_request_id = p->>'client_request_id';
  if found then return v; end if;
  select * into s from event_settings;
  v_amount := case when v_runners is not null then v_runners * s.donation_per_runner else (p->>'amount_cents')::int end;
  if v_amount is null or v_amount < s.donation_min_cents then raise exception 'donation is below the minimum' using errcode = 'P0001'; end if;
  insert into donations (ref, client_request_id, donor, email, phone, runners, amount)
  values (new_ref('RWM-DF'), p->>'client_request_id', p->>'donor', p->>'email', nullif(p->>'phone', ''), v_runners, v_amount)
  returning * into v;
  insert into charges (kind, owner_type, owner_id, label, amount, ref)
  values ('donation', 'donation', v.id, case when v_runners is not null then 'Kit out ' || v_runners || ' runner(s)' else 'Donation towards shoes and kit' end, v_amount, v.ref);
  return v;
end $$;

-- ---------- water points ----------

create or replace function reserve_water_point(p jsonb) returns sponsorships
language plpgsql security definer set search_path = public as $$
declare v sponsorships; s event_settings; v_point integer := (p->>'point')::int;
begin
  select * into v from sponsorships where client_request_id = p->>'client_request_id';
  if found then return v; end if;
  perform 1 from water_points where point = v_point for update;       -- serialise per point
  update sponsorships set status = 'expired' where point = v_point and status = 'reserved' and expires_at <= now();
  if exists (select 1 from sponsorships where point = v_point and status in ('reserved', 'confirmed')) then
    raise exception 'Water Point % is no longer available', v_point using errcode = 'P0001';
  end if;
  select * into s from event_settings;
  insert into sponsorships (ref, client_request_id, point, name, contact_person, email, phone, website, billing, display_consent, status, expires_at)
  values (new_ref('RWM-WS'), p->>'client_request_id', v_point, p->>'name', p->>'contact_person', p->>'email', p->>'phone',
    nullif(p->>'website', ''), nullif(p->>'billing', ''), coalesce((p->>'display_consent')::boolean, false), 'reserved', now() + make_interval(hours => s.water_point_hold_hours))
  returning * into v;
  insert into charges (kind, owner_type, owner_id, label, amount, ref)
  values ('sponsorship', 'sponsorship', v.id, 'Water Point ' || v_point || ' sponsorship', s.water_point_cents, v.ref);
  return v;
end $$;

-- ---------- launch event ----------

-- Anyone can register for the launch event. Personal mailbox domains are flagged, never refused.
create table if not exists launch_registrations (
  id                uuid primary key default gen_random_uuid(),
  ref               text not null unique,
  client_request_id text not null unique,
  first_name        text not null check (length(trim(first_name)) > 0),
  surname           text not null check (length(trim(surname)) > 0),
  email             text not null check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  personal_email    boolean not null default false,
  status            text not null default 'registered' check (status in ('registered', 'cancelled')),
  created_at        timestamptz not null default now()
);
create unique index if not exists launch_one_per_email on launch_registrations (lower(email)) where status <> 'cancelled';

create or replace function is_personal_email(p_email text) returns boolean language sql immutable as $$
  select split_part(lower(p_email), '@', 2) = any (array[
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.za', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
    'hotmail.com', 'hotmail.co.za', 'hotmail.co.uk', 'outlook.com', 'outlook.co.za', 'live.com', 'live.co.za', 'live.co.uk', 'msn.com',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com',
    'yandex.com', 'zohomail.com', 'webmail.co.za', 'mweb.co.za', 'telkomsa.net', 'vodamail.co.za', 'absamail.co.za',
    'iafrica.com', 'lantic.net', 'afrihost.co.za', 'cybersmart.co.za', 'vox.co.za', 'polka.co.za'])
    or split_part(lower(p_email), '@', 2) ~ '^(yahoo|hotmail|outlook|live|gmail)\.';
$$;

create or replace function register_for_launch(p jsonb) returns launch_registrations
language plpgsql security definer set search_path = public as $$
declare v launch_registrations; v_email text := lower(trim(p->>'email'));
begin
  select * into v from launch_registrations where client_request_id = p->>'client_request_id';
  if found then return v; end if;
  if not (select launch_open from event_settings) then raise exception 'Launch event registration is closed' using errcode = 'P0001'; end if;
  insert into launch_registrations (ref, client_request_id, first_name, surname, email, personal_email)
  values (new_ref('RWL'), p->>'client_request_id', trim(p->>'first_name'), trim(p->>'surname'), v_email, is_personal_email(v_email))
  returning * into v;
  return v;
exception when unique_violation then
  raise exception 'This email address is already registered for the launch event' using errcode = 'P0001';
end $$;

-- ---------- public and participant reads ----------

create or replace function public_summary() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pools', (select jsonb_object_agg(cp.pool, jsonb_build_object('limit', cp.place_limit, 'remaining', greatest(0, cp.place_limit - (
        select count(*) from registrations r where r.pool = cp.pool
          and (r.status = 'confirmed' or (r.status = 'reserved' and (r.expires_at is null or r.expires_at > now())))))))
      from capacity_pools cp),
    'water_points', (select jsonb_agg(jsonb_build_object('point', w.point,
        'status', coalesce((select case s.status when 'confirmed' then 'sponsored' else 'reserved' end from sponsorships s
                            where s.point = w.point and (s.status = 'confirmed' or (s.status = 'reserved' and s.expires_at > now())) limit 1), 'available'),
        'sponsor', (select s.name from sponsorships s where s.point = w.point and s.status = 'confirmed' and s.display_consent limit 1)) order by w.point)
      from water_points w),
    'donations_received', (select coalesce(sum(p.amount), 0) from payments p join charges c on c.id = p.charge_id where c.kind = 'donation'),
    'runners_funded', (select coalesce(sum(p.amount), 0) / (select donation_per_runner from event_settings) from payments p join charges c on c.id = p.charge_id where c.kind = 'donation'),
    'runners_needing_kit', (select count(*) from registrations where status <> 'cancelled'
                              and (coalesce((details->'kit'->>'needsShoes')::boolean, false) or coalesce((details->'kit'->>'needsKit')::boolean, false))),
    'bought_shoes', (select count(*) from stock_items where item_type = 'shoes'),
    'bought_kit', (select count(*) from stock_items where item_type = 'kit')
  );
$$;

-- A participant's own entry. Put rate limiting in front of this (Edge Function) at launch.
create or replace function my_entry(p_ref text, p_mobile text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('registration', to_jsonb(r) - 'client_request_id' - 'assisted_by' - 'attention',
    'charges', (select coalesce(jsonb_agg(jsonb_build_object('label', c.label, 'ref', c.ref, 'amount', c.amount,
      'paid', (select coalesce(sum(p.amount), 0) from payments p where p.charge_id = c.id))), '[]'::jsonb)
      from charges c where c.owner_id = r.id or c.owner_id in (select id from lodge_requests where registration_id = r.id)))
  from registrations r where upper(r.ref) = upper(p_ref) and r.mobile = p_mobile;
$$;

-- ---------- audit ----------

create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (actor, action, target, details)
  values (coalesce(auth.uid()::text, current_user), tg_table_name || '.' || lower(tg_op),
          coalesce((to_jsonb(new)->>'ref'), (to_jsonb(new)->>'id')),
          jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)));
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['registrations', 'charges', 'sponsorships', 'donations', 'lodge_requests', 'capacity_pools', 'categories', 'event_settings', 'invite_codes', 'stock_items', 'buddy_matches'] loop
    execute format('drop trigger if exists audit_%1$s on %1$s', t);
    execute format('create trigger audit_%1$s after update on %1$s for each row execute function audit_row()', t);
  end loop;
end $$;

-- ---------- row-level security ----------

do $$ declare t text; begin
  foreach t in array array['capacity_pools', 'categories', 'event_settings', 'invite_codes', 'organisers', 'registrations', 'charges', 'payments',
                           'provider_events', 'audit_log', 'water_points', 'sponsorships', 'lodge_nights', 'lodge_requests', 'donations', 'stock_items', 'buddy_matches', 'launch_registrations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists organisers_all on %I', t);
    execute format('create policy organisers_all on %I for all to authenticated using (is_organiser()) with check (is_organiser())', t);
  end loop;
end $$;

-- Anonymous visitors can read non-personal reference data only.
drop policy if exists public_read on categories;     create policy public_read on categories for select to anon using (true);
drop policy if exists public_read on capacity_pools; create policy public_read on capacity_pools for select to anon using (true);
drop policy if exists public_read on lodge_nights;   create policy public_read on lodge_nights for select to anon using (true);
drop policy if exists public_read on water_points;   create policy public_read on water_points for select to anon using (true);

revoke all on all tables in schema public from anon;
grant select on categories, capacity_pools, lodge_nights, water_points to anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function reserve_registration(jsonb), reserve_water_point(jsonb), create_donation(jsonb), register_for_launch(jsonb), public_summary(), my_entry(text, text) to anon, authenticated;
grant execute on function record_eft(uuid, integer, text), is_organiser() to authenticated;
-- apply_provider_payment and release_expired run only as the service role (webhook / scheduled job).

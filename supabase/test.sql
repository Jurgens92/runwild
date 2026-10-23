-- Acceptance checks for schema.sql. Each block raises an exception on failure.
\set ON_ERROR_STOP on

create or replace function t_person(cat text, i int, dist text default '21k', code text default null) returns jsonb language sql as $$
  select jsonb_build_object('client_request_id', 'req-' || cat || '-' || i, 'category', cat, 'distance', dist,
    'full_name', 'Person ' || cat || ' ' || i, 'mobile', '082' || lpad(i::text, 7, '0'), 'email', 'p' || i || '@example.org',
    'emergency_name', 'Contact', 'emergency_mobile', '0830000000', 'terms_accepted', true, 'invite_code', code)
$$;

insert into invite_codes values ('GROUP-TEST', 'group_employee', 1000, 0), ('MEL-TEST', 'melorane_employee', 1000, 0);
update event_settings set accept_unconfirmed_fee = true;

-- 1. Combined pool of 34: last accepted, next waitlisted; both distances share it.
do $$ declare r registrations; begin
  for i in 1..33 loop perform reserve_registration(t_person(case when i % 2 = 0 then 'other' else 'group_employee' end, i, case when i % 3 = 0 then '5k' else '21k' end, 'GROUP-TEST')); end loop;
  r := reserve_registration(t_person('other', 34, '5k'));
  assert r.status = 'reserved', '34th should be reserved, got ' || r.status;
  r := reserve_registration(t_person('other', 35, '21k'));
  assert r.status = 'waitlisted', '35th should be waitlisted, got ' || r.status;
  assert not exists (select 1 from charges where owner_id = r.id), 'waitlist must not be charged';
  raise notice 'PASS combined pool 34 + waitlist, shared across distances';
end $$;

-- 2. Community pool of 16.
do $$ declare r registrations; begin
  for i in 1..16 loop r := reserve_registration(t_person('community', 100 + i)); assert r.status = 'reserved', 'community ' || i; end loop;
  r := reserve_registration(t_person('community', 117));
  assert r.status = 'waitlisted', '17th community should be waitlisted';
  raise notice 'PASS community pool 16 + waitlist';
end $$;

-- 3. Melorane employees are outside both pools.
do $$ declare r registrations; begin
  r := reserve_registration(t_person('melorane_employee', 200, '5k', 'MEL-TEST'));
  assert r.status = 'reserved' and r.pool is null, 'melorane should hold a place outside pools';
  r := reserve_registration(t_person('melorane_employee', 201, '5k', 'WRONG'));
  assert r.status = 'draft', 'melorane without valid code should be draft';
  raise notice 'PASS Melorane employees outside pools; unverified held as draft';
end $$;

-- 4. Duplicate request returns the same entry.
do $$ declare a registrations; b registrations; begin
  a := reserve_registration(t_person('other', 35, '21k'));
  b := reserve_registration(t_person('other', 35, '21k'));
  assert a.id = b.id, 'duplicate request should return same row';
  raise notice 'PASS duplicate submission idempotent';
end $$;

-- 5. Repeated provider notification.
do $$ declare r registrations; s1 text; s2 text; begin
  select * into r from registrations where full_name = 'Person other 34';
  s1 := apply_provider_payment('evt-1', r.ref || '-E', 100000);
  s2 := apply_provider_payment('evt-1', r.ref || '-E', 100000);
  assert s1 = 'applied' and s2 = 'duplicate', 'got ' || s1 || '/' || s2;
  assert (select count(*) from payments p join charges c on c.id = p.charge_id where c.owner_id = r.id) = 1, 'one payment only';
  assert (select status from registrations where id = r.id) = 'confirmed', 'should be confirmed';
  raise notice 'PASS repeated payment notification ignored';
end $$;

-- 6. Expiry releases capacity without promoting the waitlist.
do $$ declare r registrations; begin
  update registrations set expires_at = now() - interval '1 minute' where pool = 'combined' and status = 'reserved' and full_name = 'Person group_employee 1';
  r := reserve_registration(t_person('other', 36));
  assert r.status = 'reserved', 'released place should be available, got ' || r.status;
  assert (select status from registrations where full_name = 'Person group_employee 1') = 'cancelled', 'expired should be cancelled';
  assert (select status from registrations where full_name = 'Person other 35') = 'waitlisted', 'waitlist untouched';
  raise notice 'PASS expiry releases a place; waitlist not auto-promoted';
end $$;

-- 7. Water point cannot be double booked.
do $$ declare ok boolean := false; begin
  perform reserve_water_point('{"client_request_id":"w1","point":2,"name":"A","contact_person":"a","email":"a@x.org","phone":"011"}');
  begin
    perform reserve_water_point('{"client_request_id":"w2","point":2,"name":"B","contact_person":"b","email":"b@x.org","phone":"011"}');
  exception when others then ok := true; end;
  assert ok, 'second sponsor for the same point should be refused';
  raise notice 'PASS water point double booking refused';
end $$;

-- 8. Anonymous role cannot read registrations, but can read the aggregate summary.
set role anon;
do $$ declare blocked boolean := false; s jsonb; begin
  begin perform 1 from registrations limit 1; exception when insufficient_privilege then blocked := true; end;
  assert blocked, 'anon must not read registrations';
  s := public_summary();
  assert (s->'pools'->'combined'->>'remaining')::int >= 0, 'summary works';
  assert s::text not like '%Person%', 'summary must not contain names';
  raise notice 'PASS anonymous visitors see aggregates only';
end $$;
reset role;

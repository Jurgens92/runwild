// End-to-end checks of the live API against a real Postgres (started by tests/server.sh).
// Uses the exact handler the Supabase Edge Function runs.

import postgres from 'postgres';
import { makeHandler } from '../supabase/functions/_shared/server.js';
import { hashPassword } from '../js/backend.js';

// Connection comes from PGHOST/PGPORT/PGUSER/PGDATABASE (set by tests/server.sh) or DATABASE_URL.
if (!process.env.PGHOST && !process.env.DATABASE_URL) { console.error('Run via: npm run test:server'); process.exit(1); }
const opts = { max: 40, onnotice: () => {} };
const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, opts) : postgres(opts);

const salt = 'server-test-salt';
const bootstrapAdmin = {
  id: 'boot', email: 'admin', name: 'Administrator', role: 'admin', salt, iterations: 100000,
  hash: await hashPassword('starting-password', salt), active: true, mustChangePassword: true, createdAt: 0, lastLoginAt: null,
};
const handle = makeHandler({ sql, bootstrapAdmin });

async function call(method, ...args) {
  const res = await handle(new Request('http://local/api', { method: 'POST', body: JSON.stringify({ method, args }) }));
  const body = await res.json();
  return { status: res.status, ...body };
}
async function ok(method, ...args) {
  const r = await call(method, ...args);
  if (r.error) throw new Error(method + ': ' + r.error.message);
  return r.result;
}

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

let n = 0;
const person = (extra = {}) => {
  n++;
  return {
    clientRequestId: 'srv-' + n, category: 'other', distance: n % 2 ? '21k' : '5k', fullName: 'Server Person ' + n,
    mobile: '082' + String(2000000 + n).slice(-7), email: 's' + n + '@example.org', emergencyName: 'Contact', emergencyMobile: '0830000000',
    termsAccepted: true, privacyAck: true, shirtSize: 'M', lodge: { wanted: false }, transportAck: true, buddy: { optIn: false }, ...extra,
  };
};

let admin;

await check('A new database starts empty, with only the bootstrap admin', async () => {
  const pub = await ok('publicSummary');
  assert(pub.registration.open === false, 'race entries closed before 1 Feb 2027');
  const [row] = await sql`select state->>'version' as v, jsonb_array_length(state->'users') as users, jsonb_array_length(state->'registrations') as regs from app_state`;
  assert(row.v && row.users === 1 && row.regs === 0, 'fresh live state saved: ' + JSON.stringify(row));
  const bad = await call('login', 'organiser@preview.local', 'runwild-preview');
  assert(bad.status === 401, 'preview login does not exist on the live site');
});

await check('Admin must change the starting password before doing anything else', async () => {
  const s = await ok('login', 'admin', 'starting-password');
  assert(s.mustChangePassword, 'must change flag');
  const blocked = await call('updateSettings', s.token, { pools: { combined: { limit: 30 } } });
  assert(blocked.status === 400 && /new password/.test(blocked.error.message), 'blocked until changed');
  await ok('changePassword', s.token, 'starting-password', 'the-new-admin-password');
  admin = s.token;
  const again = await call('login', 'admin', 'starting-password');
  assert(again.status === 401, 'old password no longer works');
});

await check('Admin can set the race date, entry opening date and launch event details', async () => {
  await ok('updateSettings', admin, { registration: { opensOn: '2026-01-01' }, event: { date: '2027-04-17' }, launchEvent: { date: '2027-01-20', dateConfirmed: true, time: '7:00 am' } });
  const pub = await ok('publicSummary');
  assert(pub.registration.open && pub.launch.date === '2027-01-20', 'settings saved in the database');
  const [k] = await sql`select race_date::text, race_entries_open::text, launch_date::text from reports.key_settings`;
  assert(k.race_date === '2027-04-17' && k.launch_date === '2027-01-20', 'reports.key_settings: ' + JSON.stringify(k));
});

await check('Admin creates an organiser account; organisers cannot change settings', async () => {
  await ok('createUser', admin, { email: 'organiser@erp.ngo', name: 'Org', role: 'organiser', password: 'temporary-password' });
  const o = await ok('login', 'organiser@erp.ngo', 'temporary-password');
  await ok('changePassword', o.token, 'temporary-password', 'organisers-password');
  const denied = await call('updateSettings', o.token, { pools: { combined: { limit: 1 } } });
  assert(denied.status === 400 && /cannot do this/.test(denied.error.message), 'organiser refused');
  const [u] = await sql`select count(*)::int as n from reports.users where login = 'organiser@erp.ngo' and role = 'organiser'`;
  assert(u.n === 1, 'visible in reports.users');
  const cols = await sql`select column_name from information_schema.columns where table_schema = 'reports' and table_name = 'users'`;
  assert(!cols.some((c) => /hash|salt/.test(c.column_name)), 'no password hashes in reports.users');
});

await check('30 simultaneous requests for the last place: exactly one gets it (real Postgres row lock)', async () => {
  for (let i = 0; i < 33; i++) await ok('submitRegistration', person());
  const results = await Promise.all(Array.from({ length: 30 }, () => call('submitRegistration', person())));
  const statuses = results.map((r) => (r.result ? r.result.status : 'error:' + r.error.message));
  const reserved = statuses.filter((x) => x === 'reserved').length;
  const waitlisted = statuses.filter((x) => x === 'waitlisted').length;
  assert(reserved === 1 && waitlisted === 29, 'got ' + reserved + ' reserved, ' + waitlisted + ' waitlisted: ' + statuses.filter((x) => x.startsWith('error')).slice(0, 2));
  const [c] = await sql`select count(*) filter (where status in ('reserved', 'confirmed'))::int as held, count(*) filter (where status = 'waitlisted')::int as wl from reports.race_entries`;
  assert(c.held === 34 && c.wl === 29, 'reports.race_entries: ' + JSON.stringify(c));
});

await check('A repeated submission (double click) creates one entry', async () => {
  const p = person();
  const [a, b] = await Promise.all([call('submitRegistration', p), call('submitRegistration', p)]);
  assert(a.result.ref === b.result.ref, 'same reference');
  const [c] = await sql`select count(*)::int as n from reports.race_entries where full_name = ${p.fullName}`;
  assert(c.n === 1, 'one row');
});

await check('Launch registrations are stored, with personal emails flagged', async () => {
  await ok('submitLaunchRegistration', { firstName: 'Thandi', surname: 'Nkosi', email: 'thandi@acme.co.za' });
  await ok('submitLaunchRegistration', { firstName: 'Pieter', surname: 'Smit', email: 'pieter@gmail.com' });
  const rows = await sql`select email, personal_email from reports.launch_registrations order by email`;
  assert(rows.length === 2 && rows[0].personal_email === true && rows[1].personal_email === false, JSON.stringify(rows));
});

await check('Entries and charges are visible in the reports views', async () => {
  const [c] = await sql`select count(*)::int as n, sum(amount_rand)::int as total from reports.charges where kind = 'entry'`;
  assert(c.n === 34, 'one entry fee per held place, got ' + c.n);
  const [p] = await sql`select count(*)::int as n from reports.audit_trail where action = 'user.created'`;
  assert(p.n === 1, 'audit trail recorded');
});

await check('Only allowed methods can be called; resets and payment signing are refused', async () => {
  for (const m of ['resetPreview', 'previewSignNotification', '_write', 'constructor', 'providerNotification']) {
    const r = await call(m);
    assert(r.status === 400 && /Unknown request/.test(r.error.message), m + ' should be refused');
  }
  const big = await handle(new Request('http://local/api', { method: 'POST', body: 'x'.repeat(800000) }));
  assert(big.status === 413, 'oversized request refused');
  const get = await handle(new Request('http://local/api'));
  assert(get.status === 405, 'GET refused');
});

await check('Supabase public-API roles cannot read the data or the reports', async () => {
  for (const q of ['select * from public.app_state', 'select * from reports.race_entries']) {
    let denied = false;
    try { await sql.begin(async (t) => { await t.unsafe('set local role anon'); await t.unsafe(q); }); } catch { denied = true; }
    assert(denied, 'anon could run: ' + q);
  }
});

await check('An older stored version is upgraded in place, not wiped', async () => {
  await sql`update app_state set state = jsonb_set(state - 'stock', '{version}', to_jsonb((state->>'version')::int - 1))`;
  const d = await ok('dashboard', admin);
  assert(d.registrations.length === 64 && Array.isArray(d.stock), 'data kept, new collection added: ' + d.registrations.length);
  assert(d.audit.some((a) => a.action === 'database.upgraded'), 'upgrade recorded');
});

await sql.end();
console.log(failed ? `\n${failed} server check(s) failed` : '\nAll server checks passed');
process.exit(failed ? 1 : 0);

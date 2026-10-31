// The live API. One Supabase Edge Function receives { method, args } from the site, runs the same
// Backend code the preview runs in the browser, and keeps all data in Postgres.
//
// Storage: one row (public.app_state, id = 1) holds the whole event as JSON. Every request locks
// that row (SELECT ... FOR UPDATE) for its whole transaction, so requests run one at a time and
// "count the places, then reserve one" can never overbook. For an event of this size that is
// plenty fast, and it means every rule is tested once, in tests/scenarios.js.
//
// backend.js, core.js and defaults.js in this folder are copies of the files in /js. Do not edit
// them here: edit /js and run `npm run sync` (npm test fails if the copies drift).

import { Backend, ValidationError, AuthError } from './backend.js';

// Only these Backend methods can be called from the site. Everything else (resetting data,
// signing payment notifications, internal helpers) is refused.
export const ALLOWED_METHODS = [
  'publicSummary', 'checkInviteCode', 'submitRegistration', 'myEntry', 'consentToMatch', 'updateMyBuddy',
  'requestLodgeForEntry', 'addSocksForEntry', 'startCheckout', 'submitSponsorship', 'submitContribution',
  'submitLaunchRegistration', 'login', 'logout', 'dashboard', 'organiserAction', 'updateSettings',
  'createUser', 'updateUser', 'changePassword', 'exportData',
];

// The account a brand-new live database starts with. Only the password's hash is stored here; the
// password itself was given to the site owner privately. It must be changed at first sign-in.
export const BOOTSTRAP_ADMIN = {
  id: 'bootstrap-admin',
  email: 'admin',
  name: 'Administrator',
  role: 'admin',
  salt: 'efab1dc74b7696471d2207152bf96602',
  iterations: 100000,
  hash: '1f6cc42d2e792b2f82e6b62fc4a80a4d22848028535655e4e399da88e45b601b',
  active: true,
  mustChangePassword: true,
  createdAt: 0,
  lastLoginAt: null,
  failedLogins: 0,
  lockedUntil: null,
};

const MAX_BODY = 700000; // a sponsor logo can be up to ~400 KB once encoded

// Lock + storage for one request. Each request gets its own, so concurrent requests never share a transaction.
export function pgStore(sql) {
  let tx = null;
  let row = null;
  return {
    lock: (fn) => sql.begin(async (t) => {
      tx = t;
      await t`insert into public.app_state (id, state) values (1, '{}'::jsonb) on conflict (id) do nothing`;
      const r = await t`select state from public.app_state where id = 1 for update`;
      row = r[0].state;
      try { return await fn(); } finally { tx = null; }
    }),
    storage: {
      read: () => row,
      write: async (st) => {
        await tx`update public.app_state set state = ${tx.json(st)}, updated_at = now() where id = 1`;
        row = st;
      },
    },
  };
}

// bootstrapAdmin can be replaced in tests, so they never need the real starting password.
export function makeHandler({ sql, env = {}, now, bootstrapAdmin = BOOTSTRAP_ADMIN }) {
  const allowOrigin = env.ALLOWED_ORIGIN || '*';
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json({ error: { name: 'Error', message: 'Use POST.' } }, 405);
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: { name: 'ValidationError', message: 'That request is too large.' } }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: { name: 'ValidationError', message: 'Bad request.' } }, 400); }
    const { method, args = [] } = body || {};
    if (!ALLOWED_METHODS.includes(method) || !Array.isArray(args)) return json({ error: { name: 'ValidationError', message: 'Unknown request.' } }, 400);

    const store = pgStore(sql);
    const be = new Backend({
      storage: store.storage,
      lock: store.lock,
      mode: 'live',
      bootstrapUsers: [bootstrapAdmin],
      // Until a payment provider is connected this secret is unused; set PAYMENT_WEBHOOK_SECRET when it is.
      providerSecret: env.PAYMENT_WEBHOOK_SECRET || crypto.randomUUID(),
      ...(now ? { now } : {}),
    });
    try {
      const result = await be[method](...args);
      return json({ result: result === undefined ? null : result });
    } catch (e) {
      if (e instanceof ValidationError) return json({ error: { name: 'ValidationError', message: e.message, fields: e.fields || {} } }, 400);
      if (e instanceof AuthError) return json({ error: { name: 'AuthError', message: e.message } }, 401);
      console.error(method, e);
      return json({ error: { name: 'Error', message: 'Something went wrong on the server. Please try again.' } }, 500);
    }
  };
}

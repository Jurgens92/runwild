// Supabase Edge Function "api": the live backend for the Run Wild Melorane site.
// Deploy:  npx supabase functions deploy api --no-verify-jwt
// The site does its own sign-in (organiser accounts live in the database), so Supabase's JWT
// check is switched off for this function; see supabase/config.toml.

import postgres from 'npm:postgres@3.4.9';
import { makeHandler } from '../_shared/server.js';

// SUPABASE_DB_URL is provided to every Edge Function automatically. prepare:false is needed for the
// connection pooler.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 4 });

const handle = makeHandler({ sql, env: Deno.env.toObject() });

Deno.serve(handle);

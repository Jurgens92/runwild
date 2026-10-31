// Runs the live API locally against your own Postgres, for testing without Supabase.
//   1. Create a database and run supabase/setup.sql in it.
//   2. DATABASE_URL=postgres://user:pass@localhost:5432/runwild npm run dev:api
//   3. In js/config.js set API_URL = 'http://localhost:8787', and serve the site (npm run serve).
// The first sign-in is the bootstrap admin (see supabase/functions/_shared/server.js).

import http from 'node:http';
import postgres from 'postgres';
import { makeHandler } from '../supabase/functions/_shared/server.js';

const port = Number(process.env.PORT || 8787);
const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
const handle = makeHandler({ sql, env: process.env });

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = req.method === 'POST' ? Buffer.concat(chunks) : undefined;
  const out = await handle(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body }));
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, () => console.log('Run Wild API on http://localhost:' + port));

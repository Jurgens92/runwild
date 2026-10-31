// Copies the shared business-rule files from /js into the Edge Function folder, so the live
// server runs exactly the code the preview and the tests run. Run with: npm run sync
// With --check it only reports whether the copies are up to date (used by npm test).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED = ['core.js', 'defaults.js', 'backend.js'];
const check = process.argv.includes('--check');

const stale = [];
for (const f of SHARED) {
  const src = readFileSync(join(root, 'js', f), 'utf8');
  const dest = join(root, 'supabase', 'functions', '_shared', f);
  const cur = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  if (cur === src) continue;
  if (check) stale.push(f);
  else { writeFileSync(dest, src); console.log('updated supabase/functions/_shared/' + f); }
}
if (check && stale.length) {
  console.error('Out of date in supabase/functions/_shared: ' + stale.join(', ') + '. Run: npm run sync');
  process.exit(1);
}

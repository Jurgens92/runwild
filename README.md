# Run Wild Melorane – event site (proof of concept)

Event site for **Run Wild Melorane**, an ERP (Elephants, Rhinos & People) initiative at Melorane ERP Game Reserve on **17 April 2027** (admins can change the date under Settings): a 21 km trail run and 5 km run/walk that helps establish a local running community.

It includes registration with capacity pools and a waitlist, RunWild shirt sizes for every entry, a socks add-on, unpaid-reservation expiry, Canvas Lodge requests and deposits (minimum two nights), water point sponsorship, monetary donations towards shoes and kit (R2,500 per runner, bought and handed out by ERP), running-kit requests from community members and Melorane employees, the Community Run Buddy programme, payment confirmation, and a private organiser dashboard with CSV exports and an audit trail.

Race entries are **closed to the public until 1 February 2027** (set under Settings; organisers can still register people). Until then the site points visitors to the **launch event** at Hazeldean Valley Trails, Pretoria East (`#/launch`): anyone can register with name, surname and business email. Personal addresses such as Gmail or Outlook are flagged for the organisers but still accepted.

Still to be confirmed by the organisers (shown as “To be confirmed” until set under Settings): start and finish locations and the running route, the launch event date and time, and the sock price.

Community members and Melorane employees enter **free**. Every one of their entries is checked by an organiser (dashboard → **Verification**): the place is held meanwhile, **Verify** confirms it and **Decline** cancels it. Melorane employees no longer need an invitation code. Which categories are checked is set under Settings.

| | |
|---|---|
| Public pages | Home · Launch event · Race info & FAQ · Get involved (water points, donations, Run Buddy) · My entry · Register. Canvas Lodge is linked from Home and Race info. |
| Organiser dashboard | `#/organiser` – sign in with an account an admin created (see **Going live** for the first admin) |

**Entry confirmation PDF.** After registering, and on **My entry**, participants can download their confirmation as a PDF (as well as print it). In the dashboard, **Participants → View** has *Download confirmation PDF* and, when the entry has an email address, *Email PDF to participant*: it downloads the PDF and opens the organiser's email program with a ready-made message to the participant – attach the PDF and send. The PDF is drawn in the browser with [jsPDF](https://github.com/parallax/jsPDF) (MIT, bundled in `js/vendor/`, loaded only when needed), so nothing is uploaded anywhere.

## How it works

The site is plain HTML, CSS and JavaScript with no build step, hosted for free on GitHub Pages. All the business rules live in `js/backend.js`, which runs in one of two places:

| | Preview | Live |
|---|---|---|
| Switched on by | `API_URL` empty in `js/config.js` | `API_URL` set to the Supabase function |
| Where the rules run | In the visitor's browser | On the server (Supabase Edge Function `api`) |
| Where data is kept | That browser only | One shared Postgres database |
| Sign-in | `organiser@preview.local` / `runwild-preview` | Accounts created by an admin; passwords stored only as salted hashes |
| Sample data | Yes, labelled | None |

In both modes every write runs inside an exclusive lock that re-reads the data, applies the change and saves it, so "count the places, then reserve one" can never overbook. Live, the lock is a Postgres row lock held for the whole request: `npm run test:server` sends 30 simultaneous requests for the last place to a real Postgres and exactly one gets it.

**Live data in the database.** Everything is in one row of `public.app_state`. Only the Edge Function can read or write it; Supabase's public API cannot (row-level security, no policies). To look at the data in Supabase, open **Table Editor** and pick the schema **reports**: read-only views of race entries, launch registrations, charges, payments, donations, water point sponsors, users (no passwords), the audit trail and key settings.

**Accounts and roles.** Admins manage users under **Users** in the dashboard.

- *Admin*: everything, including Settings (race date, entry opening date, launch event, fees, places…), Users and backups.
- *Organiser*: entries, payments, lodge, kit, buddies – no settings or users.
- *Viewer*: read-only.

New accounts and password resets use a temporary password that must be changed at first sign-in. Five wrong passwords lock an account for 15 minutes. The last active admin cannot be removed.

## Going live (Supabase)

The live database is the free Supabase project `runwild` (`https://oawrrygfebxbmlzevnhf.supabase.co`). `js/config.js` already points at it. **Never put the database password or any secret key in this repository.** The site needs neither: it only calls the function URL.

1. **Create the table** (once): Supabase dashboard → **SQL Editor** → New query → paste all of `supabase/setup.sql` → **Run**. It is safe to run again later.
2. **Deploy the API**, using either option:
   - *From GitHub (recommended)*: Supabase dashboard → avatar → **Account preferences → Access Tokens** → generate a token. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, name `SUPABASE_ACCESS_TOKEN`, paste the token. Then **Actions → Deploy API to Supabase → Run workflow**. It also redeploys by itself whenever the backend changes on `main`.
   - *From your computer*: `npx supabase login`, then `npx supabase functions deploy api --project-ref oawrrygfebxbmlzevnhf --no-verify-jwt`.
3. **Publish the site**: merge into `main` (GitHub Pages serves `main`). Do this after step 2, or the pages cannot load their data.
4. **First sign-in**: go to `#/organiser`, sign in as `admin` with the starting password you were given privately, and choose your own password. Then create an account for each organiser under **Users**.
5. Optional hardening: in Supabase → Edge Functions → Secrets, add `ALLOWED_ORIGIN` = `https://jurgens92.github.io` so only the site can call the API from a browser.
6. **Sending emails** (optional): confirmation emails for race entries, launch registrations, water point sponsorships and donations are sent through [Resend](https://resend.com) (free tier: 3,000 a month, 100 a day). In Supabase → Edge Functions → **Secrets** add:
   - `RESEND_API_KEY`: a Resend API key with *Sending access* (starts `re_`). Without it, emails are only recorded under **Messages**, as before.
   - `EMAIL_FROM` (optional): the sender. The default is `Run Wild Melorane <onboarding@resend.dev>`, Resend's test sender, which only delivers to the address of your own Resend account.
   - `EMAIL_REDIRECT_TO` (optional, for testing): send every email to this address instead (use your Resend account address with the test sender). The subject shows who it was meant for. Remove it to email participants for real.

   To email participants, verify your own domain in Resend (**Domains → Add Domain**, add the DNS records it shows), set `EMAIL_FROM` to an address on that domain and remove `EMAIL_REDIRECT_TO`. No redeploy is needed after changing secrets. Emails are sent just after the response, so visitors never wait for them. **Messages** shows each one as *Sent* or *Failed* (with Resend's reason) and has a *Resend* button. SMS messages are still only recorded.

**Changing the backend later.** Edit the files in `js/`, then run `npm run sync` to copy `core.js`, `defaults.js` and `backend.js` into `supabase/functions/_shared/` (`npm test` fails if you forget). Saved data is upgraded in place when the code changes; it is never reset.

**Backups.** Dashboard → Settings → **Download backup** saves everything as JSON. Supabase's free plan does not keep daily backups, so download one regularly.

**Tests.**

```bash
npm test             # 28 acceptance scenarios (also runnable from the dashboard)
npm run test:server  # the live API on a temporary Postgres: accounts, roles, concurrency, reports, lock-down
```

**Running the live API locally** (optional, needs Postgres): create a database, run `supabase/setup.sql` in it, start `DATABASE_URL=postgres://… npm run dev:api`, and set `API_URL` in `js/config.js` to `http://localhost:8787`.

Still to do before taking real money or sending messages: a payment provider webhook (EFT works now, recorded by organisers) and an SMS provider (SMS confirmations are recorded in the dashboard, marked *Not sent*). Emails are sent once `RESEND_API_KEY` is set (see **Going live**, step 6).

## Payments

No provider is assumed. Shortlist one that ERP finance already has an account with or can open – for example PayFast, Yoco, Ozow or Peach Payments – and check it supports **server-to-server payment notifications** (webhooks / ITN). EFT is supported now: every charge has its own reference (for example `RWM-ABCDE-E` for an entry fee, `-LD` for a lodge deposit, `-LB` for a lodge balance), and organisers reconcile it from the Payments tab.

Entry fees, lodge deposits, lodge balances, sponsorships and donations are separate charges with their own balances. The 20 % lodge deposit is never applied to anything else.

## Hosting on GitHub Pages (free)

1. In the GitHub repository, go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**. Pick `main`, folder **/ (root)**, then **Save**.
3. After a minute the site is live at `https://jurgens92.github.io/runwild/`. Send that link to reviewers.

The `.nojekyll` file tells Pages to serve the files exactly as they are.

### Custom subdomain `runwild.erp.ngo` (later, not done in this build)

Nothing on erp.ngo or its DNS has been changed. When ERP is ready:

1. Whoever manages the `erp.ngo` DNS adds a record: **CNAME** `runwild` → `jurgens92.github.io` (or the hosting address of the production site).
2. In **Settings → Pages → Custom domain**, enter `runwild.erp.ngo`, save, wait for the DNS check, then tick **Enforce HTTPS**. GitHub adds a `CNAME` file to the repo.
3. If the production site is on another host (Netlify, Vercel, Cloudflare Pages), point the CNAME at that host instead and add the domain in its dashboard.

### Linking from www.erp.ngo (Webflow)

The existing site already has a **Donate** dropdown (General Donations, #BIKES4ERP, Sponsor a Kilometre) and an **Our Projects** page with one section per programme. Suggested additions, made by whoever edits the Webflow site:

- A **Run Wild Melorane** link in the Donate dropdown and in the Melorane project links, pointing to `https://runwild.erp.ngo` (or the GitHub Pages link until the subdomain exists).
- An optional section on *Our Projects*, matching the #BIKES4ERP block: heading, short description, a "Register today" button.

The event site links back to www.erp.ngo in its footer and follows the ERP Brand Guidelines: navy and white first, the secondary blues and browns, uppercase Novecento headings and Gotham body copy (Lexend Exa and Montserrat stand in when the licensed fonts are not installed).

## Launch checklist

The organiser dashboard has a live version of this list (**Launch checklist** tab).

- [ ] Confirmed course for both distances (GPX track with elevation) to replace the sample route in `js/route.js`
- [ ] Exact race start time (the site shows "Early start – exact time to be confirmed" until it is set)
- [ ] Melorane employee entry fee and community member entry fee (no fee is assumed – both show "to be confirmed")
- [ ] Turn off "accept registrations while a fee is unconfirmed"
- [ ] Canvas Lodge open nights and bed inventory (current values are labelled sample data)
- [ ] Canvas Lodge inclusions and cancellation terms (minimum stay: two nights)
- [ ] Late-booking policy for lodge bookings after 31 January 2027
- [ ] Payment provider chosen, webhook connected, preview payment page switched off
- [ ] EFT bank details confirmed by ERP finance
- [ ] Water point responsibilities: who supplies water, refreshments, equipment and staff
- [ ] Water point sponsor benefits approved
- [ ] Organiser-approved event terms (currently a labelled draft) and privacy notice reviewed against POPIA
- [ ] Full pickup address in PJ (the Chief's Hall, 4:30 am)
- [ ] Run Buddy training resources approved
- [ ] Email provider connected (`RESEND_API_KEY`, own domain verified in Resend)
- [ ] SMS provider connected
- [ ] Live backend deployed (see **Going live**), starting admin password changed, an account for each organiser

## Project layout

```
index.html                       page shell, header and footer
css/style.css                    all styles
js/config.js                     API_URL: empty = browser preview, set = live database
js/core.js                       pure rules: money, dates, lodge maths, pool usage, email checks
js/defaults.js                   default settings and labelled sample data (preview only)
js/backend.js                    all business rules, accounts and permissions (runs in browser or server)
js/remote.js                     calls the live API with the same method names
js/app.js                        public pages and router
js/register.js                   registration wizard with review step
js/route.js                      route map and elevation profile (sample course until the GPX is supplied)
js/organiser.js                  organiser dashboard, users and settings
tests/scenarios.js               acceptance scenarios (also runnable from the dashboard)
tests/server.sh                  live API against a temporary Postgres
supabase/setup.sql               database table, lock-down and reports views (paste into Supabase)
supabase/functions/api/          the Edge Function
supabase/functions/_shared/      server.js (API handler) + synced copies of core/defaults/backend
scripts/                         sync-function.mjs, dev-api.mjs
.github/workflows/deploy-api.yml deploys the function from GitHub
assets/                          poster, logo and landscape images
```

Run locally: `npm run serve`, then open http://localhost:8080.

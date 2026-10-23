# Run Wild Melorane – event site (proof of concept)

Event site for **Run Wild Melorane**, an ERP (Elephants, Rhinos & People) initiative at Melorane ERP Game Reserve on **17 April 2027**: a 21 km trail run and 5 km run/walk that helps establish a local running community.

This is a working preview, not a mock-up. It includes registration with capacity pools and a waitlist, unpaid-reservation expiry, Canvas Lodge requests and deposits, water point sponsorship, shoe and kit donations, the Community Run Buddy programme, payment confirmation, and a private organiser dashboard with CSV exports and an audit trail.

| | |
|---|---|
| Public pages | Home · Race info & FAQ · Get involved (water points, shoe and kit donations, Run Buddy) · My entry · Register. Canvas Lodge is linked from Home and Race info. |
| Organiser | `#/organiser` – preview sign-in `organiser@preview.local` / `runwild-preview` |
| Invitation codes (preview) | `GROUP-PREVIEW`, `MELORANE-PREVIEW` |

## How the preview works and where it stops

The site is plain HTML, CSS and JavaScript with no build step, so it can be hosted for free on GitHub Pages. All the business rules live in `js/backend.js`, which is written like a server:

- Every write runs inside an exclusive lock (the browser's Web Locks API, which also covers several open tabs). The lock re-reads state, applies the change and saves, so "count the places, then reserve one" can't interleave with another registration. The test suite shows 10 simultaneous requests for the last place giving exactly one reservation. Without the lock, 5 of 5 overbook.
- Duplicate form submissions and repeated payment notifications are ignored, using request IDs and provider event IDs.
- A payment is recorded only from a signed provider notification or an organiser's EFT reconciliation. Landing on the "thank you" page does not record it.

**Limitations of the preview (be clear about these when sharing the link):**

1. **Data lives in each visitor's own browser.** Two reviewers don't see each other's test entries.
2. **Nothing here is secure.** Code running in a browser can be changed by the person using it, so the organiser password, permissions and capacity rules are illustrations only. Never put real personal data into the preview.
3. **No real payments, emails or SMSes.** "Pay online" opens a clearly marked preview page. Confirmations are queued in the dashboard and marked *Not sent*.

The brief asked what happens if the platform can't guarantee capacity protection. A static host can't, which is why the production version is already written and tested:

## Production backend (before launch)

`supabase/schema.sql` is a complete Postgres schema for [Supabase](https://supabase.com) (its free tier is enough for an event this size). It moves every rule to the server:

- **Capacity:** `reserve_registration()` locks the pool row (`SELECT … FOR UPDATE`), releases expired holds, counts and inserts, all in one transaction.
- **Water points:** `reserve_water_point()` locks the point row. A partial unique index adds a second guard.
- **Idempotency:** unique `client_request_id`, unique provider `event_id`, and unique `(charge, bank_ref)` for EFTs.
- **Privacy:** row-level security on every table. Anonymous visitors can call only `public_summary()` (aggregates) and `my_entry(ref, mobile)`. Organisers are listed in `organisers` and sign in with Supabase Auth.
- **Audit:** triggers log every update with the old and new values.

Test it against a throwaway Postgres (this includes a real 30-connection race for the last place):

```bash
npm test          # 16 acceptance scenarios against the preview engine
npm run test:sql  # schema.sql on a temporary Postgres 16: rules, RLS and concurrency
```

To finish the move, swap `js/backend.js` for calls to the Supabase functions (same method names). Then add two small Edge Functions:

- `payment-webhook`: verifies the provider's signature, then calls `apply_provider_payment()`
- `send-messages`: sends the queued confirmations through an email/SMS provider

## Payments

No provider is assumed. Shortlist one that ERP finance already has an account with or can open – for example PayFast, Yoco, Ozow or Peach Payments – and check it supports **server-to-server payment notifications** (webhooks / ITN). EFT is supported now: every charge has its own reference (for example `RWM-ABCDE-E` for an entry fee, `-LD` for a lodge deposit, `-LB` for a lodge balance), and organisers reconcile it from the Payments tab.

Entry fees, lodge deposits, lodge balances, sponsorships and donations are separate charges with their own balances. The 20 % lodge deposit is never applied to anything else.

## Hosting on GitHub Pages (free)

1. In the GitHub repository, go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**. Pick the branch with this code (`main` once merged, or `claude/sweet-lamport-55oaor` to share it now), folder **/ (root)**, then **Save**.
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
- [ ] Canvas Lodge inclusions, minimum stay and cancellation terms
- [ ] Late-booking policy for lodge bookings after 31 January 2027
- [ ] Payment provider chosen, webhook connected, preview payment page switched off
- [ ] EFT bank details confirmed by ERP finance
- [ ] Shoe and kit prices, if financial contributions are wanted; drop-off and collection arrangements
- [ ] Donation condition criteria approved
- [ ] Water point responsibilities: who supplies water, refreshments, equipment and staff
- [ ] Water point sponsor benefits approved
- [ ] Organiser-approved event terms (currently a labelled draft) and privacy notice reviewed against POPIA
- [ ] Full pickup address in PJ (the Chief's Hall, 4:30 am)
- [ ] Run Buddy training resources approved
- [ ] Email and SMS providers connected
- [ ] Production backend deployed (`supabase/schema.sql`), real organiser accounts created, preview account and sample data removed

## Project layout

```
index.html            page shell, header and footer
css/style.css         all styles
js/core.js            pure rules: money, dates, lodge maths, pool usage
js/defaults.js        organiser-editable settings and labelled sample data
js/backend.js         preview backend (locking, capacity, payments, permissions, audit)
js/app.js             public pages and router
js/register.js        registration wizard with review step
js/route.js           route map and elevation profile (sample course until the GPX is supplied)
js/organiser.js       organiser dashboard
tests/scenarios.js    acceptance scenarios (also runnable from the dashboard)
supabase/schema.sql   production database, functions and row-level security
supabase/test.sh      runs schema.sql on a temporary Postgres, including concurrency races
assets/               poster, logo and landscape images
```

Run locally: `npm run serve`, then open http://localhost:8080.

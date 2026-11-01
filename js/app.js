import { api, LIVE, esc, $, $$, toast, tbc, pageHead, messageNote, showErrors, clearErrors, formData, chargesTable, eftBlock, statusPill, rand, formatDate, formatDateTime } from './ui.js';
import { CATEGORIES, DISTANCES, SOCK_SIZES, lodgeQuote, nightsBetween, uid, addDays, isPersonalEmail, emailDomain, formatDay } from './core.js';
import { renderRegister } from './register.js';
import { renderOrganiser } from './organiser.js';
import { bindPdfButton } from './pdf.js';
import { routeExplorer, routeFacts } from './route.js';

const app = $('#app');

const routes = {
  '': home,
  register: renderRegister,
  launch,
  lodge,
  'water-points': waterPoints,
  donate,
  'run-buddy': runBuddy,
  'get-involved': getInvolved,
  info,
  'my-entry': myEntry,
  pay,
  'payment-return': paymentReturn,
  organiser: renderOrganiser,
  'about-preview': aboutPreview,
};

// Pages that live under a main nav item.
const NAV_SECTION = { 'water-points': 'get-involved', donate: 'get-involved', 'run-buddy': 'get-involved', lodge: 'info', pay: 'my-entry', 'payment-return': 'my-entry' };

async function router() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const name = parts[0] || '';
  const view = routes[name] || notFound;
  const section = NAV_SECTION[name] || name;
  $$('#nav a').forEach((a) => { if (a.getAttribute('href') === '#/' + section) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#nav').classList.remove('open');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
  try {
    await view(app, parts.slice(1).map(decodeURIComponent));
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="wrap section"><div class="notice bad"><p>Something went wrong: ${esc(e.message)}</p></div></div>`;
  }
  window.scrollTo(0, 0);
  document.title = (app.dataset.title ? app.dataset.title + ' | ' : '') + 'Run Wild Melorane | ERP';
}

// On the live site the preview banner goes away.
if (LIVE) $('#preview-strip')?.remove();

window.addEventListener('hashchange', router);
$('#menu-btn').addEventListener('click', () => {
  const open = $('#nav').classList.toggle('open');
  $('#menu-btn').setAttribute('aria-expanded', String(open));
});
router();

function setTitle(t) { app.dataset.title = t; }

const BACK_INVOLVED = { href: '#/get-involved', label: 'Get involved' };

// "Register now" for the race, or – before race entries open – a route to the launch event.
export function raceCta(s, { cls = 'btn', label = 'Register now' } = {}) {
  if (s.registration.open) return `<a class="${cls}" href="#/register">${label}</a>`;
  return `<a class="${cls}" href="#/launch">Register for the launch event</a>`;
}

function opensText(s) { return s.registration.mode === 'closed' ? 'Race entries are not open yet' : 'Race entries open ' + s.registration.opensLabel; }

// Launch event details as table rows. Unconfirmed items say so.
function launchRows(L) {
  return `<tr><th>Date</th><td>${L.dateConfirmed && L.date ? formatDate(L.date) : tbc()}</td></tr>
    <tr><th>Time</th><td>${esc(L.time)}${L.timeConfirmed ? '' : ' <span class="small muted">(provisional)</span>'}</td></tr>
    <tr><th>Where</th><td>${esc(L.venue)}${L.venueConfirmed && L.venueDetail ? '<br>' + esc(L.venueDetail) : '<br><span class="small muted">Exact venue to be confirmed</span>'}</td></tr>`;
}

function startLine(ev) {
  return ev.startTime ? esc(ev.startTime) : 'Early start – exact time to be confirmed';
}

// ---------------- Home ----------------

function placesPill(pool) {
  if (!pool) return '<span class="places open">Unlimited entries</span>';
  if (pool.full) return '<span class="places full">Waitlist open</span>';
  return `<span class="places ${pool.remaining <= 5 ? 'low' : ''}">${pool.remaining} of ${pool.limit} left</span>`;
}

const ICONS = {
  water: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
  shoe: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 16v-5l4-5 3 3 3 1 6 2a3 3 0 0 1 2 3v1H3z"/><path d="M3 19h18"/></svg>',
  buddy: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6M14 14.3c.6-.2 1.3-.3 2-.3 3.3 0 6 2.7 6 6"/></svg>',
};

function involvedTiles(s) {
  const open = s.waterPoints.filter((w) => w.status === 'available').length;
  return `<div class="grid three">
    <a class="tile" href="#/water-points">
      <span class="icon">${ICONS.water}</span>
      <h3>Sponsor a water point</h3>
      <p>Put your name or company on one of five water points along the route.</p>
      <span class="meta">${open} of 5 still available · ${rand(s.waterPointSettings.price)} suggested</span>
      <span class="link-arrow">Choose a point</span>
    </a>
    <a class="tile" href="#/donate">
      <span class="icon">${ICONS.shoe}</span>
      <h3>Kit out a runner</h3>
      <p>${rand(s.donations.perRunner)} buys one runner ${kitList(s.donations.items)}. ERP buys and hands out everything.</p>
      <span class="meta">${s.donations.progress.runnersFunded} runner${s.donations.progress.runnersFunded === 1 ? '' : 's'} funded · ${s.donations.progress.runnersNeedingKit} asked for kit</span>
      <span class="link-arrow">Donate</span>
    </a>
    <a class="tile" href="#/run-buddy">
      <span class="icon">${ICONS.buddy}</span>
      <h3>Become a Run Buddy</h3>
      <p>Registered runners can support a community runner on the road to race day.</p>
      <span class="meta">${s.buddyCounts.volunteers} volunteers so far</span>
      <span class="link-arrow">How it works</span>
    </a>
  </div>`;
}

// "Running shoes, Shorts, Shirt" → "running shoes, shorts, shirt, socks and a cap"
function kitList(items) {
  const xs = items.map((x) => x.toLowerCase()).map((x) => (x === 'cap' ? 'a cap' : x));
  return xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs.join('');
}

async function home(el) {
  setTitle('');
  const s = await api.publicSummary();
  const ev = s.event;
  const days = Math.ceil((new Date(ev.date + 'T00:00:00+02:00') - Date.now()) / 86400000);
  el.innerHTML = `
  <section class="hero">
    <div class="wrap">
      <span class="eyebrow">ERP presents</span>
      <h1>Run Wild</h1>
      <p class="place">MELORANE</p>
      <p class="when">${formatDay(ev.date)}<span>·</span>21 km trail run &amp; 5 km run/walk</p>
      <div class="btn-row">
        ${raceCta(s)}
        <a class="btn ghost" href="#/info">Race info</a>
      </div>
      ${s.registration.open ? (days > 0 ? `<p class="hero-note">${days} days to go · limited places</p>` : '') : `<p class="hero-note">${opensText(s)} · limited places</p>`}
    </div>
    <div class="hero-land" role="img" aria-label="Red dirt track through the bushveld at sunrise"></div>
  </section>

  <div class="wrap facts">
    <div><span class="label">Date</span><strong>${formatDate(ev.date)}</strong></div>
    <div><span class="label">Start</span><strong>${ev.startTime && ev.startTimeConfirmed ? esc(ev.startTime) : 'Early morning'}</strong></div>
    <div><span class="label">Venue</span><strong>Melorane ERP Game Reserve</strong></div>
    <div><span class="label">Distances</span><strong>21 km · 5 km</strong></div>
  </div>

  ${s.launch.open ? `<section class="launch-band">
    <div class="wrap">
      <div><span class="eyebrow">Before the race</span><strong>Launch event</strong> · ${esc(s.launch.venue)} · ${esc(s.launch.time)} · ${s.launch.dateConfirmed && s.launch.date ? formatDate(s.launch.date) : 'date to be confirmed'}</div>
      <a class="link-arrow" href="#/launch">Register for the launch</a>
    </div>
  </section>` : ''}

  <section class="section">
    <div class="wrap split">
      <div>
        <span class="eyebrow">The event</span>
        <h2>Run through the reserve. Build something that lasts.</h2>
        <p class="lead">Run Wild Melorane brings people together on the trails of Melorane ERP Game Reserve, with the bushveld waking up around you.</p>
        <p>${esc(ev.proceedsText)}</p>
      </div>
      <figure style="margin:0">
        <img class="poster" src="assets/poster.webp" alt="Run Wild Melorane poster: Save the date, 17 April 2027, 21 km trail run, 5 km run/walk." width="1179" height="1488" loading="lazy">
      </figure>
    </div>
  </section>

  <section class="section sand">
    <div class="wrap">
      <div class="section-head center">
        <span class="eyebrow">The route</span>
        <h2>Two ways to run wild</h2>
        <p class="lead">A 21 km trail through the reserve, or a 5 km run/walk at your own pace. The start and finish locations and the exact route are still being confirmed.</p>
      </div>
      <div class="rt" id="route"></div>
    </div>
  </section>

  <section class="section">
    <div class="wrap narrow">
      <div class="section-head center">
        <span class="eyebrow">Entries</span>
        <h2>Who can enter</h2>
        <p class="lead">Places are limited for each group, and both distances share the same places.</p>
      </div>
      <div class="entries">
        <div class="entry-row"><div><h3>Group employees &amp; other participants</h3><p>Charitable entry, supporting the local running community</p></div>${placesPill(s.pools.combined)}</div>
        <div class="entry-row"><div><h3>Community members</h3><p>Pickup from ${esc(ev.pickupPlace)} at ${esc(ev.pickupTime)}</p></div>${placesPill(s.pools.community)}</div>
        <div class="entry-row"><div><h3>Melorane employees</h3><p>Additional to the limited places · verified by the organisers</p></div>${placesPill(null)}</div>
      </div>
      <p class="small muted center" style="margin-top:16px">Every entry includes a RunWild running shirt. Your entry fee is shown once you choose your category when you register.</p>
      <div class="btn-row" style="justify-content:center;margin-top:36px">${raceCta(s, { cls: 'btn navy' })}</div>
      ${s.registration.open ? '' : `<p class="small muted center" style="margin-top:12px">${opensText(s)}.</p>`}
    </div>
  </section>

  <section class="section navy">
    <div class="wrap split top">
      <div>
        <span class="eyebrow">Race day</span>
        <h2>${formatDay(ev.date)}</h2>
        <p>Race day is at Melorane ERP Game Reserve. Want to wake up at the start line? Stay at Canvas Lodge (minimum ${s.lodge.minNights} nights) – campfires, starry skies and the bush all around.</p>
        <div class="btn-row" style="margin-top:24px"><a class="btn light" href="#/lodge">Stay at Canvas Lodge</a></div>
      </div>
      <ol class="timeline">
        <li><span class="t">${esc(ev.pickupTime)}</span><span><strong>Community pickup</strong>${esc(ev.pickupPlace)}</span></li>
        <li><span class="t">Early</span><span><strong>Arrive at the reserve</strong>Everyone else makes their own way there</span></li>
        <li><span class="t">${ev.startTime && ev.startTimeConfirmed ? esc(ev.startTime) : 'Sunrise'}</span><span><strong>Race start</strong>${ev.startTime && ev.startTimeConfirmed ? '21 km and 5 km' : 'Exact time to be confirmed'}</span></li>
        <li><span class="t">Finish</span><span><strong>Celebrate together</strong>${ev.routeConfirmed && ev.finishLocation ? esc(ev.finishLocation) : 'Finish location to be confirmed'}</span></li>
      </ol>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-head center">
        <span class="eyebrow">Not running?</span>
        <h2>Get involved</h2>
        <p class="lead">Many community runners need shoes and kit to take part. Your donation lets ERP buy it for them.</p>
      </div>
      ${involvedTiles(s)}
    </div>
  </section>

  <section class="section sand cta-band">
    <div class="wrap narrow">
      <h2>See you on the trail.</h2>
      <p class="lead">${s.registration.open ? 'Places are limited. Secure yours today.' : opensText(s) + '. Join us at the launch event first.'}</p>
      <div class="btn-row">${raceCta(s)}<a class="btn plain" href="#/info">Read the FAQ</a></div>
    </div>
  </section>`;
  routeExplorer($('#route'), { event: ev });
}

async function getInvolved(el) {
  setTitle('Get involved');
  const s = await api.publicSummary();
  el.innerHTML = `
  ${pageHead('Get involved', 'Help more runners reach the start line', 'Sponsor a water point, donate towards shoes and kit, or support a community runner as a Run Buddy. Sponsorships and donations never use a race place.')}
  <section class="section"><div class="wrap">${involvedTiles(s)}</div></section>`;
}

// ---------------- Launch event ----------------

async function launch(el) {
  setTitle('Launch event');
  const s = await api.publicSummary();
  const L = s.launch;
  const requestId = uid();
  const d = 0.018;
  const bbox = [L.lng - d, L.lat - d * 0.6, L.lng + d, L.lat + d * 0.6].map((x) => x.toFixed(4)).join(',');
  el.innerHTML = `
  ${pageHead('Launch event', 'Run Wild Melorane launch', esc(L.description))}
  <section class="section">
    <div class="wrap split top">
      <div>
        <div class="notice"><p><strong>This is the launch event, not the race.</strong> Registering here does not enter you for the ${formatDate(s.event.date)} race. ${s.registration.open ? 'Race entries are open now – <a href="#/register">register for the race</a>.' : opensText(s) + '.'}</p></div>
        <table class="summary"><tbody>${launchRows(L)}</tbody></table>
        <figure class="launch-map">
          <iframe title="Map of ${esc(L.venue)}" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&amp;layer=mapnik&amp;marker=${L.lat}%2C${L.lng}"></iframe>
          <figcaption class="small muted">${L.venueConfirmed ? esc(L.venueDetail || L.venue) + '.' : 'The pin shows the Hazeldean area in Pretoria East. The exact venue will be confirmed.'}
            <a href="${esc(L.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${L.lat},${L.lng}`)}" rel="noopener" target="_blank">Open in Google Maps</a>${L.website ? ` · <a href="${esc(L.website)}" rel="noopener" target="_blank">Venue website</a>` : ''}</figcaption>
        </figure>
      </div>
      ${L.open ? `<form class="card" id="launch-form" novalidate>
        <span class="eyebrow">Launch event</span>
        <h3>Register for the launch</h3>
        <div class="notice bad form-error" hidden></div>
        <div class="row2">
          <div class="field" data-field="firstName"><label for="lf-first">Name</label><input id="lf-first" name="firstName" type="text" autocomplete="given-name"></div>
          <div class="field" data-field="surname"><label for="lf-last">Surname</label><input id="lf-last" name="surname" type="text" autocomplete="family-name"></div>
        </div>
        <div class="field" data-field="email"><label for="lf-email">Business email <span class="hint">Please use your work address.</span></label><input id="lf-email" name="email" type="email" autocomplete="email">
          <p class="small email-flag" id="email-flag" hidden></p></div>
        <p class="small muted">We use these details only to manage the launch event and let you know when race entries open.</p>
        <button class="btn" type="submit">Register for the launch event</button>
      </form>` : '<div class="notice warn"><p>Registration for the launch event is closed.</p></div>'}
    </div>
  </section>`;
  const form = $('#launch-form');
  if (!form) return;
  const flag = () => {
    const v = form.elements.email.value;
    const show = isPersonalEmail(v);
    $('#email-flag').hidden = !show;
    if (show) $('#email-flag').textContent = `${emailDomain(v)} looks like a personal address. A business email is preferred, but you can still register with this one.`;
  };
  form.elements.email.addEventListener('input', flag);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const d = formData(form);
    d.clientRequestId = requestId;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api.submitLaunchRegistration(d);
      el.innerHTML = `${pageHead('Launch event', 'You’re registered for the launch')}
        <section class="section"><div class="wrap narrow">
          <div class="notice ok"><p>Thank you, ${esc(r.firstName)}. Reference <span class="ref">${esc(r.ref)}</span>.</p></div>
          <table class="summary"><tbody>
            <tr><th>Name</th><td>${esc(r.firstName)} ${esc(r.surname)}</td></tr>
            <tr><th>Email</th><td>${esc(r.email)}</td></tr>
            ${launchRows(r.event)}
          </tbody></table>
          ${r.personalEmail ? '<p class="small muted">You registered with a personal email address. That is fine – if you have a work address, you are welcome to let us know.</p>' : ''}
          <div class="notice sun" style="margin-top:16px"><p><strong>This is not a race entry.</strong> Entries for the ${formatDate(r.raceDate)} race ${r.raceOpensLabel ? 'open on ' + esc(r.raceOpensLabel) : 'are not open yet'}. We will email you once the launch date is confirmed.</p></div>
          ${messageNote(s)}
          <div class="btn-row"><a class="btn plain" href="#/">Back to home</a><a class="btn plain" href="#/info">Race info</a></div>
        </div></section>`;
      window.scrollTo(0, 0);
    } catch (err) { btn.disabled = false; showErrors(form, err); }
  });
}

// ---------------- Canvas Lodge ----------------

async function lodge(el) {
  setTitle('Canvas Lodge');
  const s = await api.publicSummary();
  const L = s.lodge;
  const nights = L.nights;
  const dates = [...nights.map((n) => n.date), nights.length ? addDays(nights[nights.length - 1].date, 1) : null].filter(Boolean);
  const opt = (sel) => dates.map((d) => `<option value="${d}" ${d === sel ? 'selected' : ''}>${formatDate(d)}</option>`).join('');
  const minN = L.minNights || 1;
  const qMin = lodgeQuote({ nights: minN, ratePerNight: L.ratePerNight, depositPercent: L.depositPercent });
  el.innerHTML = `
  ${pageHead('Accommodation', 'Canvas Lodge', 'Stay at Melorane ERP Game Reserve over race weekend. Offered to group employees and other participants. Minimum stay ' + minN + ' nights.', { href: '#/info', label: 'Race info' })}
  <section class="section">
    <div class="wrap split">
      <div>
        <p class="price">${rand(L.ratePerNight)} <span class="small muted" style="font-family:var(--body)">per person per night, all inclusive · minimum ${minN} nights</span></p>
        <p>Camping at the Melorane ERP Game Reserve combines the thrill of the great outdoors with knowing your stay supports the conservation of elephants and rhinos and community development. Nightly bonfires, star gazing and an off-the-grid bush experience – and you are already at the start line on race morning.</p>
        <div class="notice sun"><p><strong>Minimum stay: ${minN} nights.</strong> Canvas Lodge bookings must be for at least ${minN} nights.</p></div>
        <p class="small muted">Inclusions and cancellation terms ${tbc()} – we only publish what the organisers have confirmed.</p>

        <h3 style="margin-top:28px">How payment works</h3>
        <ul class="ticks">
          <li>Accommodation total = ${rand(L.ratePerNight)} × number of nights (at least ${minN}).</li>
          <li>A <strong>${L.depositPercent}% booking deposit</strong> secures your beds once availability is confirmed.</li>
          <li>The remaining <strong>${100 - L.depositPercent}%</strong> is due by <strong>${formatDate(L.balanceDueDate)}</strong>.</li>
          <li>The deposit is for accommodation only. It is never applied to the entry fee, socks, sponsorships or donations, which are shown and paid separately.</li>
          <li>A request is <strong>not a confirmed booking</strong> until availability has been checked and the deposit has been verified.</li>
        </ul>
        <div class="notice warn"><p><strong>Booking after ${formatDate(L.balanceDueDate)}?</strong> ${L.latePolicy.confirmed ? esc(L.latePolicy.text) : 'Late-booking terms are still to be confirmed by the organisers. We will not ask you to meet a deadline that has already passed.'}</p></div>
      </div>
      <div class="card">
        <h3>Work out your stay</h3>
        <p class="small muted">Open nights: ${nights.map((n) => formatDate(n.date) + (n.available ? '' : ' (full)')).join(', ')} ${L.inventoryConfirmed ? '' : '<span class="sample">Sample dates</span>'}</p>
        <div class="row2">
          <div class="field"><label for="la">Arrive</label><select id="la">${opt(dates[0])}</select></div>
          <div class="field"><label for="ld">Depart</label><select id="ld">${opt(dates[Math.min(minN, dates.length - 1)])}</select></div>
        </div>
        <div id="lq"></div>
        <p class="small muted">Example for one participant, ${minN} nights: accommodation ${rand(qMin.total)}, deposit ${rand(qMin.deposit)}, balance ${rand(qMin.balance)}. The entry fee is separate.</p>
        <div class="btn-row">${s.registration.open ? '<a class="btn" href="#/register">Register and request a stay</a>' : `<p class="small"><strong>${opensText(s)}.</strong> You can request a stay when you register.</p>`}</div>
        <p class="small" style="margin-top:12px">Already registered? <a href="#/my-entry">Add a stay to your entry</a>.</p>
      </div>
    </div>
  </section>`;
  const calc = () => {
    const n = nightsBetween($('#la').value, $('#ld').value);
    if (n < 1) { $('#lq').innerHTML = '<p class="err">Departure must be after arrival.</p>'; return; }
    if (n < minN) { $('#lq').innerHTML = `<p class="err">Canvas Lodge bookings are for a minimum of ${minN} nights.</p>`; return; }
    const q = lodgeQuote({ nights: n, ratePerNight: L.ratePerNight, depositPercent: L.depositPercent });
    $('#lq').innerHTML = `<table class="summary money"><tbody>
      <tr><th>Nights</th><td>${n}</td></tr>
      <tr><th>Accommodation total</th><td>${rand(q.total)}</td></tr>
      <tr><th>Booking deposit (${L.depositPercent}%)</th><td>${rand(q.deposit)}</td></tr>
      <tr><th>Balance by ${formatDate(L.balanceDueDate)}</th><td>${rand(q.balance)}</td></tr>
    </tbody></table>`;
  };
  $('#la').addEventListener('change', calc);
  $('#ld').addEventListener('change', calc);
  calc();
}

// ---------------- Water points ----------------

async function waterPoints(el, [preselect]) {
  setTitle('Sponsor a water point');
  const s = await api.publicSummary();
  const W = s.waterPointSettings;
  const resp = { tbc: 'To be confirmed', organiser: 'Organiser', sponsor: 'Sponsor' };
  const requestId = uid();
  el.innerHTML = `
  ${pageHead('Sponsorship', 'Sponsor a water point', 'Five water points keep runners going on the trail. Sponsor one in your name or your company’s.', BACK_INVOLVED)}
  <section class="section">
    <div class="wrap">
      <div class="grid five">
        ${s.waterPoints.map((w) => `
          <div class="wp ${w.status}">
            <span class="label">Water point</span>
            <span class="num">${w.point}</span>
            ${statusPill(w.status, w.status === 'available' ? 'Available' : w.status === 'reserved' ? 'Temporarily reserved' : 'Sponsored')}
            ${w.sponsorName ? `<span class="small">${esc(w.sponsorName)}</span>` : ''}
            ${w.status === 'available' ? `<button class="btn small" data-pick="${w.point}">Sponsor this point</button>` : ''}
          </div>`).join('')}
      </div>
      <p class="small muted" style="margin-top:10px">A point is temporarily reserved while a sponsor’s payment is being verified. If payment is not verified in time, it becomes available again.</p>

      <div class="split" style="margin-top:36px">
        <div>
          <h2>What sponsorship includes</h2>
          <p class="price">${rand(W.price)} <span class="small muted" style="font-family:var(--body)">suggested, per water point</span></p>
          <p>Suggested benefits, ${W.benefitsApproved ? 'approved by the organisers' : 'subject to organiser approval'}:</p>
          <ul class="ticks">${W.benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
          <h3>Who supplies what</h3>
          <table class="summary"><tbody>
            ${['water', 'refreshments', 'equipment', 'staff'].map((k) => `<tr><th>${k[0].toUpperCase() + k.slice(1)}</th><td>${W.responsibilities[k] === 'tbc' ? tbc() : esc(resp[W.responsibilities[k]])}</td></tr>`).join('')}
          </tbody></table>
          <p class="small muted" style="margin-top:12px">Sponsorship does not include race entries, accommodation, access to staff the water point or any other benefit not listed here, and it does not register anyone for the event.</p>
        </div>
        <form class="card" id="wp-form" novalidate>
          <h3>Sponsor a water point</h3>
          <div class="notice bad form-error" hidden></div>
          <div class="field" data-field="point"><label for="point">Water point</label>
            <select id="point" name="point"><option value="">Choose…</option>
            ${s.waterPoints.map((w) => `<option value="${w.point}" ${w.status !== 'available' ? 'disabled' : ''} ${String(w.point) === preselect ? 'selected' : ''}>Water Point ${w.point}${w.status !== 'available' ? ' – unavailable' : ''}</option>`).join('')}
            </select></div>
          <div class="field" data-field="name"><label for="name">Individual or company name</label><input id="name" name="name" type="text" autocomplete="organization"></div>
          <div class="field" data-field="contactPerson"><label for="cp">Contact person</label><input id="cp" name="contactPerson" type="text" autocomplete="name"></div>
          <div class="row2">
            <div class="field" data-field="email"><label for="em">Email</label><input id="em" name="email" type="email" autocomplete="email"></div>
            <div class="field" data-field="phone"><label for="ph">Telephone</label><input id="ph" name="phone" type="tel" autocomplete="tel"></div>
          </div>
          <div class="field" data-field="logo"><label for="logo">Logo <span class="hint">Optional. PNG, JPG or SVG under 300 KB.</span></label><input id="logo" name="logoFile" type="file" accept="image/png,image/jpeg,image/svg+xml"></div>
          <div class="field" data-field="website"><label for="web">Website <span class="hint">Optional</span></label><input id="web" name="website" type="url" placeholder="https://"></div>
          <div class="field"><label for="bill">Billing details <span class="hint">Optional – company registration, VAT number and billing address if you need an invoice.</span></label><textarea id="bill" name="billing"></textarea></div>
          <div class="field"><label class="check"><input type="checkbox" name="displayConsent"> You may display our name and logo on the event website and at the water point.</label></div>
          <p class="small muted">We use these details only to manage your sponsorship. See the privacy notice on the <a href="#/info">FAQ</a> page.</p>
          <button class="btn" type="submit">Reserve water point</button>
        </form>
      </div>
    </div>
  </section>`;
  $$('[data-pick]').forEach((b) => b.addEventListener('click', () => { $('#point').value = b.dataset.pick; $('#wp-form').scrollIntoView({ behavior: 'smooth' }); }));
  const form = $('#wp-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const d = formData(form);
    const file = $('#logo').files[0];
    if (file) {
      if (file.size > 300 * 1024) return showErrors(form, { message: 'Please check the highlighted fields.', fields: { logo: 'Please use a logo under 300 KB.' } });
      d.logo = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
    }
    delete d.logoFile;
    d.clientRequestId = requestId;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api.submitSponsorship(d);
      const sum = await api.publicSummary();
      el.innerHTML = `${pageHead('Sponsorship', 'Water Point ' + r.point + ' is reserved for you')}
      <section class="section"><div class="wrap narrow">
        <div class="notice sun"><p>Reference <span class="ref">${esc(r.ref)}</span>. The point is held until <strong>${formatDateTime(r.expiresAt)}</strong>. It becomes a confirmed sponsorship once payment has been verified.</p></div>
        ${chargesTable([r.charge], { payments: sum.payments })}
        ${eftBlock(sum.payments, [r.charge.ref])}
        ${messageNote(sum)}
      </div></section>`;
      window.scrollTo(0, 0);
    } catch (err) {
      btn.disabled = false;
      showErrors(form, err);
    }
  });
}

// ---------------- Donate ----------------

async function donate(el) {
  setTitle('Donate towards shoes and kit');
  const s = await api.publicSummary();
  const D = s.donations;
  const P = D.progress;
  const requestId = uid();
  const per = D.perRunner;
  const target = Math.max(D.target, P.runnersNeedingKit);
  const pct = target ? Math.min(100, Math.round((P.runnersFunded / target) * 100)) : 0;
  el.innerHTML = `
  ${pageHead('Donations', 'Kit out a runner', 'We accept monetary donations only. ERP buys the shoes and kit and hands them out to the runners who need them.', BACK_INVOLVED)}
  <section class="section">
    <div class="wrap split top">
      <div>
        <div class="card accent">
          <span class="label muted">One runner, fully kitted out</span>
          <p class="price" style="margin:4px 0">${rand(per)} <span class="small muted" style="font-family:var(--body)">per runner</span></p>
          <ul class="ticks">${D.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>
        <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-top:20px">
          <div class="kpi"><span class="label">Raised</span><div class="stat" style="font-size:1.6rem">${rand(P.raised)}</div></div>
          <div class="kpi"><span class="label">Runners funded</span><div class="stat" style="font-size:1.6rem">${P.runnersFunded}</div></div>
          <div class="kpi"><span class="label">Asked for kit</span><div class="stat" style="font-size:1.6rem">${P.runnersNeedingKit}</div></div>
        </div>
        <div class="meter" role="img" aria-label="${P.runnersFunded} of ${target} runners funded" style="height:10px;background:var(--sand);border-radius:999px;overflow:hidden;margin-top:12px"><span style="display:block;height:100%;width:${pct}%;background:var(--blue)"></span></div>
        <p class="small muted" style="margin-top:8px">${P.runnersFunded} of ${target} runners funded. “Raised” counts money that has been received. We only show totals here – never the names, sizes or needs of individual participants.</p>
        <h3 style="margin-top:28px">Why money and not items?</h3>
        <p>Buying centrally means every runner gets new shoes and kit in the right size, and nothing is wasted on sizes nobody needs. ERP buys the items, records each purchase and tracks every item until it is handed over. We are not able to accept physical donations of shoes or clothing.</p>
        <p class="small muted">Questions about a large or corporate donation? Email <a href="mailto:info@erp.ngo?subject=Run%20Wild%20Melorane%20donation">info@erp.ngo</a>.</p>
      </div>
      ${D.enabled ? `<form class="card" id="don-form" novalidate>
        <h3>Make a donation</h3>
        <div class="notice bad form-error" hidden></div>
        <fieldset data-field="mode"><span class="legend">How would you like to give?</span>
          <div class="choices cols">
            <label class="choice"><input type="radio" name="mode" value="runners" checked><span><strong>Kit out runners</strong>${rand(per)} each</span></label>
            <label class="choice"><input type="radio" name="mode" value="amount"><span><strong>Another amount</strong>any amount helps</span></label>
          </div></fieldset>
        <div class="field" data-field="runners" id="f-runners"><label for="dr">Number of runners</label><input id="dr" name="runners" type="number" min="1" max="50" value="1"></div>
        <div class="field" data-field="amount" id="f-amount" hidden><label for="da">Amount (R) <span class="hint">At least ${rand(D.minAmount)}</span></label><input id="da" name="amount" type="number" min="${D.minAmount / 100}" step="1" inputmode="numeric"></div>
        <p class="price" id="don-total" style="font-size:1.4rem"></p>
        <div class="field" data-field="donor"><label for="dn">Your name or company</label><input id="dn" name="donor" type="text" autocomplete="name"></div>
        <div class="row2">
          <div class="field" data-field="email"><label for="de">Email</label><input id="de" name="email" type="email" autocomplete="email"></div>
          <div class="field"><label for="dp">Mobile <span class="hint">Optional</span></label><input id="dp" name="phone" type="tel" autocomplete="tel"></div>
        </div>
        <p class="small muted">Pay online or by EFT on the next page. Your donation is counted once the payment has been received.</p>
        <button class="btn" type="submit">Continue to payment</button>
      </form>` : '<div class="notice warn"><p>Donations will open soon.</p></div>'}
    </div>
  </section>`;
  const form = $('#don-form');
  if (!form) return;
  const sync = () => {
    const mode = form.querySelector('[name=mode]:checked').value;
    $('#f-runners').hidden = mode !== 'runners';
    $('#f-amount').hidden = mode !== 'amount';
    $$('.choice', form).forEach((c) => c.classList.toggle('checked', c.querySelector('input').checked));
    const n = Math.max(0, Math.floor(Number(form.elements.runners.value) || 0));
    const amt = mode === 'runners' ? n * per : Math.round((Number(form.elements.amount.value) || 0) * 100);
    $('#don-total').textContent = amt > 0 ? 'Total: ' + rand(amt) : '';
  };
  $$('[name=mode]', form).forEach((r) => r.addEventListener('change', sync));
  form.elements.runners.addEventListener('input', sync);
  form.elements.amount.addEventListener('input', sync);
  sync();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const d = formData(form);
    d.clientRequestId = requestId;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const c = await api.submitContribution(d);
      const sum = await api.publicSummary();
      el.innerHTML = `${pageHead('Donations', 'Thank you for your donation')}
        <section class="section"><div class="wrap narrow">
          <div class="notice ok"><p>Donation reference <span class="ref">${esc(c.ref)}</span>: ${c.runners ? 'kit for ' + c.runners + ' runner' + (c.runners > 1 ? 's' : '') + ', ' : ''}${rand(c.amount)}.</p></div>
          ${chargesTable([c.charge], { payments: sum.payments })}
          ${eftBlock(sum.payments, [c.charge.ref])}
          ${messageNote(sum)}
          <a class="btn plain" href="#/donate">Back to donations</a>
        </div></section>`;
      window.scrollTo(0, 0);
    } catch (err) { btn.disabled = false; showErrors(form, err); }
  });
}

// ---------------- Run Buddy ----------------

async function runBuddy(el) {
  setTitle('Community Run Buddy');
  const s = await api.publicSummary();
  el.innerHTML = `
  ${pageHead('Community', 'Community Run Buddy programme', 'Pair up with a runner from the Melorane community and help them get to the start line ready.', BACK_INVOLVED)}
  <section class="section">
    <div class="wrap split">
      <div>
        <h2>How it works</h2>
        <ol class="ticks">
          <li><strong>Volunteer.</strong> Group employees and other participants can opt in when they register, or later from “My entry”. Tell us your preferred distance, running experience, availability and how you would like to help.</li>
          <li><strong>Community runners opt in too.</strong> Community participants choose whether they would like a buddy.</li>
          <li><strong>The organisers match you</strong> by hand, ideally by distance and what suits both people.</li>
          <li><strong>Both people agree</strong> before any contact details are shared.</li>
          <li><strong>Train together</strong> using training resources approved by the organisers – plans, encouragement, and preparing for race day.</li>
        </ol>
        <p>Being a buddy is optional and has nothing to do with donating shoes or kit. You can withdraw at any time.</p>
        <div class="btn-row">${s.registration.open ? '<a class="btn" href="#/register">Register and volunteer</a>' : `<span class="small"><strong>${opensText(s)}.</strong></span>`}<a class="btn plain" href="#/my-entry">Already registered? Opt in</a></div>
      </div>
      <div class="card quiet">
        <h3>So far</h3>
        <ul class="list-plain">
          <li><strong>${s.buddyCounts.volunteers}</strong> volunteer buddies</li>
          <li><strong>${s.buddyCounts.requests}</strong> community runners would like a buddy</li>
          <li><strong>${s.buddyCounts.matched}</strong> introductions made</li>
        </ul>
        <h3 style="margin-top:20px">Training resources</h3>
        <p class="small">${esc(s.buddy.resourcesText)} ${s.buddy.resourcesApproved ? '' : tbc('Awaiting approval')}</p>
      </div>
    </div>
  </section>`;
}

// ---------------- Info / FAQ ----------------

async function info(el) {
  setTitle('Race info');
  const s = await api.publicSummary();
  const ev = s.event;
  const qa = [
    ['When can I enter the race?', `${opensText(s)}. Until then race entries are closed. You can already <a href="#/launch">register for the launch event</a> – that is a separate event and does not enter you for the race.`],
    ['What is the launch event?', `${esc(s.launch.description)} It takes place at ${esc(s.launch.venue)} at ${esc(s.launch.time)}${s.launch.timeConfirmed ? '' : ' (provisional)'}; the date is ${s.launch.dateConfirmed && s.launch.date ? formatDate(s.launch.date) : 'still to be confirmed'}. Anyone can <a href="#/launch">register</a>.`],
    ['When and where is the race?', `${formatDay(ev.date)} at ${esc(ev.venue)}. ${startLine(ev)}. Plan to arrive early – the start is early in the morning.`],
    ['Which distances are there?', '<strong>21 km trail run</strong> or <strong>5 km run/walk</strong>. You choose one when you register. Both distances use the same pool of places for your category.'],
    ['Where do we start and finish, and what is the route?', `${ev.routeConfirmed ? `Start: ${esc(ev.startLocation)}. Finish: ${esc(ev.finishLocation)}. ${esc(ev.routeDescription)}` : 'The start and finish locations and the running route are still being confirmed by the organisers. We will publish them here and on the route map as soon as they are final.'}`],
    ['How many places are there?', `Group employees and other participants share one pool of ${s.pools.combined.limit} places. Community members have ${s.pools.community.limit} places. Melorane employees have unlimited entries and do not use either pool. When a pool is full you can join its waitlist – no payment is taken for a waitlist place.`],
    ['How much is the entry fee?', 'The entry fee depends on your category. It is shown as soon as you choose your category on the registration form, before you give any details. We will not ask for payment for a category whose fee has not been confirmed.'],
    ['What does the entry fee cover?', esc(ev.proceedsText) + ' Every entry also includes a RunWild running shirt.'],
    ['Do I get a running shirt?', 'Yes. Every entry, including group entries, includes a RunWild running shirt. Choose your shirt size when you register.'],
    ['Can I buy socks?', `Yes. RunWild running socks are an optional add-on when you register, or later from “My entry”. ${s.socks.confirmed && s.socks.price ? 'They cost ' + rand(s.socks.price) + ' a pair, paid separately from the entry fee.' : 'The price is still to be confirmed – you can order now and nothing is payable for socks until the price is set.'}`],
    ['What is an employee invitation code?', 'Group employees get an invitation code from the organisers (usually through their employer). Entering it on the registration form confirms you are an employee straight away, so your place is allocated immediately. Melorane employees and community members do not need a code: their entry is free, and an organiser checks each one before confirming it (the place is held in the meantime). No code, or a code that does not work? You can still register – your entry waits for an organiser to verify your employment before a place is allocated, and nothing is payable until then. Codes only confirm employment; they do not give a discount.'],
    ['I need running shoes or kit. Can I get some?', `Community members and Melorane employees can ask for running shoes and kit when they register and give their sizes. ERP buys the items with donated money (budgeted at ${rand(s.donations.perRunner)} per runner for shoes, shorts, shirt, socks and a cap) and hands them out before race day. We cannot promise items, but we will do our best.`],
    ['How do I get there?', `Community participants are picked up from ${esc(ev.pickupPlace)} at ${esc(ev.pickupTime)} on ${formatDate(ev.date)}${ev.pickupAddressConfirmed && ev.pickupFullAddress ? ' (' + esc(ev.pickupFullAddress) + ')' : ''}. Everyone else arranges their own transport and must arrive at the reserve on time, or stays at Canvas Lodge (minimum ${s.lodge.minNights} nights).`],
    ['How long is my place held while I pay?', `An unpaid reservation is held for ${s.reservationHours} hours. After that the place is released. If someone is on the waitlist, the organisers contact them – nobody is charged or confirmed automatically.`],
    ['How do I pay?', `Online through the event’s payment provider${s.payments.providerConnected ? '' : ' (being set up)'}, or by EFT using your unique payment reference. An entry is confirmed only once the payment provider notifies us or ERP finance reconciles your EFT – a screenshot or proof of payment alone does not confirm it.`],
    ['I don’t have an email address. Can I still enter?', 'Yes. Community members can register with a mobile number only. You will get a reference number on screen – write it down. Organisers can also register you in person.'],
    ['Can I change my distance or cancel?', 'Contact the organisers with your reference number. Cancellation and refund terms are part of the event terms, which are still being finalised.'],
  ];
  el.innerHTML = `
  ${pageHead('Race info', 'Everything you need to know', 'Key details, getting there, and answers to common questions.')}
  <section class="section"><div class="wrap split top">
    <div>
      <h2>Frequently asked</h2>
      <div class="faq">${qa.map(([q, a]) => `<details><summary>${q}</summary><div><p>${a}</p></div></details>`).join('')}</div>
      <h2 style="margin-top:56px">The fine print</h2>
      <div class="faq">
        <details id="terms"><summary>Event terms</summary><div>
          ${s.terms.approved ? '' : '<div class="notice warn"><p>These terms are a draft and still need organiser approval before registration opens.</p></div>'}
          <p>${esc(s.terms.text)}</p>
          <p class="small">Version ${esc(s.terms.version)}</p></div></details>
        <details id="privacy"><summary>Privacy notice</summary><div>
          <p>ERP collects your name, contact numbers, email address, emergency contact, category, distance and running shirt size – and, if you ask for running kit or order socks, your shoe, clothing and sock sizes – to run Run Wild Melorane: to manage entries and payments, transport and safety on the day, shirts and kit distribution and the Run Buddy programme.</p>
          <p>Your details are seen only by authorised organisers. We do not publish names, contact details, sizes or individual needs, and we only share your contact details with a Run Buddy once you have both agreed. Sponsors’ names and logos are shown only with their permission. You can ask to see, correct or delete your information by contacting <a href="mailto:info@erp.ngo">info@erp.ngo</a>, in line with POPIA.</p></div></details>
      </div>
    </div>
    <aside style="display:grid;gap:20px">
      <div class="card raised">
        <h3>Key details</h3>
        <table class="summary"><tbody>
          <tr><th>Date</th><td>${formatDay(ev.date)}</td></tr>
          <tr><th>Start</th><td>${ev.startTime && ev.startTimeConfirmed ? esc(ev.startTime) : 'Early start – time to be confirmed'}</td></tr>
          <tr><th>Venue</th><td>${esc(ev.venue)}</td></tr>
          <tr><th>Distances</th><td>21 km trail · 5 km run/walk</td></tr>
          ${routeFacts(ev, 'rows')}
          <tr><th>Community pickup</th><td>${esc(ev.pickupPlace)}, ${esc(ev.pickupTime)}</td></tr>
          <tr><th>Race entries</th><td>${s.registration.open ? 'Open' : s.registration.mode === 'closed' ? 'Not open yet' : 'Open ' + esc(s.registration.opensLabel)}</td></tr>
        </tbody></table>
        <div class="btn-row" style="margin-top:20px">${raceCta(s, { label: 'Register' })}</div>
      </div>
      <div class="card quiet">
        <h3>Stay at Canvas Lodge</h3>
        <p class="muted">Sleep at the reserve and wake up at the start line. ${rand(s.lodge.ratePerNight)} per person per night, all inclusive, minimum ${s.lodge.minNights} nights.</p>
        <a class="link-arrow" href="#/lodge">Lodge details</a>
      </div>
    </aside>
  </div></section>`;
}

// ---------------- My entry ----------------

async function myEntry(el, [refArg]) {
  setTitle('My entry');
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('rw-my') || 'null'); } catch { /* ignore */ }
  el.innerHTML = `${pageHead('Participants', 'My entry', 'Check your status, pay outstanding amounts, request Canvas Lodge or join the Run Buddy programme.')}
  <section class="section"><div class="wrap narrow">
    <form id="look" class="card" novalidate>
      <div class="notice bad form-error" hidden></div>
      <div class="row2">
        <div class="field"><label for="ref">Reference number</label><input id="ref" name="ref" type="text" placeholder="RWM-XXXXX" value="${esc(refArg || (saved && saved.ref) || '')}" autocapitalize="characters"></div>
        <div class="field"><label for="mob">Mobile number used to register</label><input id="mob" name="mobile" type="tel" value="${esc((saved && saved.mobile) || '')}"></div>
      </div>
      <button class="btn navy" type="submit">Show my entry</button>
      <p class="small muted" style="margin-top:10px">You can only see your own entry. Lost your reference? Contact the organisers.</p>
    </form>
    <div id="mine"></div>
  </div></section>`;
  const form = $('#look');
  const load = async () => {
    clearErrors(form);
    const { ref, mobile } = formData(form);
    try {
      const r = await api.myEntry(ref, mobile);
      try { sessionStorage.setItem('rw-my', JSON.stringify({ ref, mobile })); } catch { /* ignore */ }
      renderMine($('#mine'), r, { ref, mobile }, load);
    } catch (err) { $('#mine').innerHTML = ''; showErrors(form, err); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  if ((refArg || saved) && $('#mob').value) load();
}

export function confirmationHTML(r) {
  const cat = CATEGORIES[r.category];
  const charges = r.charges;
  const entry = charges.find((c) => c.kind === 'entry');
  const lodgeCharges = charges.filter((c) => c.kind.startsWith('lodge'));
  const sockCharges = charges.filter((c) => c.kind === 'socks');
  const statusText = {
    reserved: r.holdReason === 'awaiting_verification'
      ? 'Your place is held while an organiser checks your entry. There is nothing to pay – we will let you know once it is confirmed.'
      : r.holdReason === 'fee_unconfirmed'
      ? 'Your place is held. The entry fee for your category has not been confirmed yet, so nothing is payable now. We will let you know the fee before anything is due.'
      : `Your place is reserved until <strong>${formatDateTime(r.expiresAt)}</strong>. Pay the charitable entry fee before then to confirm it. Unpaid reservations are released automatically.`,
    confirmed: 'Your entry is confirmed. See you at Melorane!',
    waitlisted: 'This category is full, so you are on the waitlist. No payment is needed now. If a place opens up, the organisers will contact you – you will never be charged or confirmed automatically.',
    draft: 'Your employee status needs to be verified by the organisers before a place can be allocated. No place is held yet and nothing is payable.',
    cancelled: r.cancelReason === 'reservation_expired' ? 'This reservation expired because payment was not received in time.' : 'This entry has been cancelled.',
  }[r.status];
  return `
    <table class="summary"><tbody>
      <tr><th>Reference</th><td><span class="big-ref">${esc(r.ref)}</span></td></tr>
      <tr><th>Status</th><td>${statusPill(r.status)}</td></tr>
      <tr><th>Name</th><td>${esc(r.fullName)}</td></tr>
      <tr><th>Category</th><td>${esc(cat.label)}${r.verification === 'verified' ? ' · verified' : ''}</td></tr>
      <tr><th>Distance</th><td>${esc(DISTANCES[r.distance])}</td></tr>
      <tr><th>RunWild shirt</th><td>${r.shirtSize ? 'Size ' + esc(r.shirtSize) : '—'} – included with your entry</td></tr>
      ${r.socks ? `<tr><th>Socks</th><td>${r.socks.qty} pair${r.socks.qty > 1 ? 's' : ''}, size ${esc(r.socks.size)}${r.socksPrice ? '' : ' – price to be confirmed, nothing payable yet'}</td></tr>` : ''}
      ${r.kit && (r.kit.needsShoes || r.kit.needsKit) ? `<tr><th>Running kit requested</th><td>${[r.kit.needsShoes && 'Shoes (' + esc(r.kit.shoeSize + ' ' + r.kit.shoeSystem) + ')', r.kit.needsKit && 'Kit (shorts ' + esc(r.kit.shortsSize) + ')'].filter(Boolean).join(', ')}</td></tr>` : ''}
      <tr><th>Race day</th><td>${formatDate(r.event.date)} · ${r.event.startTime ? esc(r.event.startTime) : 'Early start – exact time to be confirmed'}</td></tr>
      ${r.category === 'community' ? `<tr><th>Pickup</th><td>${esc(r.event.pickupPlace)} at ${esc(r.event.pickupTime)} on ${formatDate(r.event.date)}${r.event.pickupFullAddress ? ' – ' + esc(r.event.pickupFullAddress) : ''}</td></tr>` : `<tr><th>Getting there</th><td>${r.lodgeWanted ? 'Staying at Canvas Lodge (see below).' : 'Early start from Melorane ERP Game Reserve. You arrange your own transport and arrive on time.'}</td></tr>`}
      ${r.buddy ? `<tr><th>Run Buddy</th><td>${r.buddy.optIn ? statusPill(r.buddy.status || 'awaiting_match') : 'Not taking part'}</td></tr>` : ''}
      ${!entry && r.status !== 'waitlisted' && r.status !== 'draft' ? `<tr><th>Entry fee</th><td>${r.fee.confirmed ? (r.fee.amount ? rand(r.fee.amount) : 'Free') : '<span class="tbc">To be confirmed</span>'}</td></tr>` : ''}
    </tbody></table>
    <div class="notice ${r.status === 'confirmed' ? 'ok' : r.status === 'cancelled' ? 'bad' : 'sun'}" style="margin-top:16px"><p>${statusText}</p></div>
    ${r.lodge ? `<h3>Canvas Lodge</h3>
      <p>${statusPill(r.lodge.status, { requested: 'Requested – not yet confirmed', awaiting_deposit: 'Beds held – deposit due', confirmed: 'Confirmed – balance outstanding', paid_in_full: 'Paid in full', declined: 'Declined', cancelled: 'Cancelled', expired: 'Hold expired' }[r.lodge.status])}
      ${formatDate(r.lodge.arrival)} to ${formatDate(r.lodge.departure)} · ${r.lodge.nights} night${r.lodge.nights > 1 ? 's' : ''}</p>
      ${r.lodge.note ? `<p class="small">${esc(r.lodge.note)}</p>` : ''}
      ${r.lodge.status === 'awaiting_deposit' ? `<p class="small">Beds are held until ${formatDateTime(r.lodge.expiresAt)}. Your stay is confirmed once the deposit is verified.</p>` : ''}
      ${r.lodge.balanceNote ? `<p class="small">${esc(r.lodge.balanceNote)}</p>` : ''}` : ''}
    ${charges.length ? `<h3>Amounts</h3>${chargesTable([...(entry ? [entry] : []), ...sockCharges, ...lodgeCharges], { payments: r.payments })}${eftBlock(r.payments, charges.filter((c) => c.outstanding > 0).map((c) => c.ref))}` : ''}`;
}

function renderMine(box, r, creds, reload) {
  const adult = CATEGORIES[r.category].adultOptions;
  const canLodge = adult && r.status !== 'cancelled' && (!r.lodge || ['declined', 'cancelled', 'expired'].includes(r.lodge.status));
  const m = r.match;
  const canSocks = r.status !== 'cancelled' && !r.socks;
  box.innerHTML = `<div class="card" style="margin-top:20px">${confirmationHTML(r)}
    <div class="btn-row no-print" style="margin-top:16px"><button class="btn small" id="pdf">Download confirmation (PDF)</button><button class="btn small plain" onclick="window.print()">Print</button></div>
    ${m ? `<h3>Your Run Buddy introduction</h3>
      ${m.partnerContact ? `<div class="notice ok"><p>You have both agreed. ${esc(m.partnerContact.name)} – ${esc(m.partnerContact.mobile)}${m.partnerContact.email ? ' – ' + esc(m.partnerContact.email) : ''}</p></div>`
        : m.myConsent ? `<p>You have agreed to be introduced to ${esc(m.partnerFirstName)}. Contact details are shared once they agree too.</p>`
          : `<p>The organisers suggest pairing you with <strong>${esc(m.partnerFirstName)}</strong>. Contact details are shared only once you both agree.</p>
             <div class="btn-row"><button class="btn small" id="m-yes">I agree to the introduction</button><button class="btn small plain" id="m-no">No thanks</button></div>`}` : ''}
    ${r.buddy && r.status !== 'cancelled' && r.category !== 'melorane_employee' ? `<h3>Run Buddy programme</h3>
      ${r.buddy.optIn ? `<p>You are in the programme (${esc((r.buddy.status || '').replace(/_/g, ' '))}).</p><button class="btn small danger" id="b-out">Withdraw from Run Buddy</button>`
        : r.category === 'community' ? '<button class="btn small" id="b-in">I would like a Run Buddy</button>'
          : `<details><summary>Volunteer as a Run Buddy</summary><div><form id="bf" novalidate>
            <div class="field"><label>Preferred distance</label><select name="preferredDistance"><option value="21k">21 km</option><option value="5k">5 km</option></select></div>
            <div class="field"><label>Running experience</label><input name="experience" type="text"></div>
            <div class="field"><label>Availability</label><input name="availability" type="text" placeholder="e.g. weekday evenings"></div>
            <div class="field"><label>Preferred contact method</label><select name="contactMethod"><option>WhatsApp</option><option>Phone</option><option>Email</option></select></div>
            <div class="field"><label>How you could help</label><textarea name="support"></textarea></div>
            <div class="notice bad form-error" hidden></div>
            <button class="btn small" type="submit">Volunteer</button></form></div></details>`}` : ''}
    ${canLodge ? `<h3>Add a Canvas Lodge stay</h3><form id="lf" class="row3" novalidate style="align-items:end">
        <div class="field"><label>Arrive</label><input name="arrival" type="date" min="${addDays(r.event.date, -14)}" max="${addDays(r.event.date, 14)}" value="${addDays(r.event.date, -2)}"></div>
        <div class="field"><label>Depart</label><input name="departure" type="date" min="${addDays(r.event.date, -14)}" max="${addDays(r.event.date, 14)}" value="${r.event.date}"></div>
        <div class="field"><button class="btn small" type="submit">Request stay</button></div>
        <p class="small muted" style="grid-column:1/-1;margin:0">Canvas Lodge bookings are for a minimum of ${r.lodgeMinNights} nights.</p>
        <div class="notice bad form-error" hidden style="grid-column:1/-1"></div></form>` : ''}
    ${canSocks ? `<h3>Add RunWild running socks</h3><form id="sf" class="row3" novalidate style="align-items:end">
        <div class="field"><label>Pairs</label><select name="qty">${[1, 2, 3, 4, 5].map((i) => `<option value="${i}">${i}</option>`).join('')}</select></div>
        <div class="field"><label>Sock size</label><select name="size">${SOCK_SIZES.map((x) => `<option>${esc(x)}</option>`).join('')}</select></div>
        <div class="field"><button class="btn small" type="submit">Order socks</button></div>
        <p class="small muted" style="grid-column:1/-1;margin:0">${r.socksPrice ? rand(r.socksPrice) + ' per pair, paid separately.' : 'Price to be confirmed – nothing is payable for socks until it is set.'}</p>
        <div class="notice bad form-error" hidden style="grid-column:1/-1"></div></form>` : ''}
  </div>`;
  bindPdfButton($('#pdf', box), () => r);
  const act = async (fn) => { try { await fn(); toast('Saved'); reload(); } catch (e) { toast(e.message, true); } };
  $('#m-yes', box)?.addEventListener('click', () => act(() => api.consentToMatch(creds.ref, creds.mobile, true)));
  $('#m-no', box)?.addEventListener('click', () => act(() => api.consentToMatch(creds.ref, creds.mobile, false)));
  $('#b-out', box)?.addEventListener('click', () => act(() => api.updateMyBuddy(creds.ref, creds.mobile, { optIn: false })));
  $('#b-in', box)?.addEventListener('click', () => act(() => api.updateMyBuddy(creds.ref, creds.mobile, { optIn: true })));
  $('#bf', box)?.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; api.updateMyBuddy(creds.ref, creds.mobile, { optIn: true, ...formData(f) }).then(() => { toast('Thank you for volunteering'); reload(); }, (err) => showErrors(f, err)); });
  $('#sf', box)?.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; const d = formData(f); api.addSocksForEntry(creds.ref, creds.mobile, Number(d.qty), d.size).then(() => { toast('Socks ordered'); reload(); }, (err) => showErrors(f, err)); });
  $('#lf', box)?.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; const d = formData(f); api.requestLodgeForEntry(creds.ref, creds.mobile, d.arrival, d.departure).then(() => { toast('Stay requested'); reload(); }, (err) => showErrors(f, err)); });
}

// ---------------- Payments (preview provider) ----------------

async function pay(el, [chargeRef]) {
  setTitle('Payment');
  let co;
  try { co = await api.startCheckout(chargeRef); } catch (e) {
    el.innerHTML = `${pageHead('Payment', 'Payment')}<section class="section"><div class="wrap narrow"><div class="notice warn"><p>${esc(e.message)}</p></div><a class="btn plain" href="#/my-entry">My entry</a></div></section>`;
    return;
  }
  el.innerHTML = `${pageHead('Payment', 'Pay online')}
  <section class="section"><div class="wrap narrow">
    <div class="card" style="border:2px dashed var(--tan)">
      <span class="sample">Preview payment page</span>
      <p style="margin-top:10px">This stands in for the payment provider’s hosted checkout. No card details are collected and no money moves.</p>
      <table class="summary money"><tbody>
        <tr><th>Item</th><td>${esc(co.label)}</td></tr>
        <tr><th>Reference</th><td><span class="ref">${esc(co.chargeRef)}</span></td></tr>
        <tr><th>Amount</th><td><strong>${rand(co.amount)}</strong></td></tr>
      </tbody></table>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn" id="ok">Simulate successful payment</button>
        <button class="btn plain" id="fail">Simulate failed payment</button>
      </div>
    </div>
  </div></section>`;
  const finish = (status) => {
    const eventId = 'evt_' + uid().slice(0, 12);
    sessionStorage.setItem('rw-pay', JSON.stringify({ eventId, chargeRef: co.chargeRef, amount: co.amount, status }));
    location.hash = '#/payment-return/' + encodeURIComponent(co.chargeRef);
  };
  $('#ok').addEventListener('click', () => finish('paid'));
  $('#fail').addEventListener('click', () => finish('failed'));
}

// The browser lands here after checkout. Landing here does NOT mark anything as paid; only the
// signed provider notification (simulated below with a delay) does.
async function paymentReturn(el, [chargeRef]) {
  setTitle('Payment');
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('rw-pay') || 'null'); } catch { /* ignore */ }
  el.innerHTML = `${pageHead('Payment', 'Thank you')}
  <section class="section"><div class="wrap narrow">
    <div class="notice" id="ps"><p>Waiting for the payment provider to confirm payment for <span class="ref">${esc(chargeRef)}</span>… Returning to this page does not by itself confirm a payment.</p></div>
    <div id="pr"></div>
  </div></section>`;
  if (!pending || pending.chargeRef !== chargeRef) return;
  const send = async () => {
    const n = { eventId: pending.eventId, chargeRef: pending.chargeRef, amount: pending.amount, status: pending.status };
    n.signature = await api.previewSignNotification(n);
    return api.providerNotification(n);
  };
  setTimeout(async () => {
    const res = await send();
    const ok = pending.status === 'paid' && res.ok;
    $('#ps').className = 'notice ' + (ok ? 'ok' : 'bad');
    $('#ps').innerHTML = `<p>${ok ? 'The payment provider has confirmed your payment. Your records are updated.' : 'The payment did not go through. Nothing has been charged. You can try again from “My entry”.'}</p>`;
    $('#pr').innerHTML = `<div class="btn-row"><a class="btn navy" href="#/my-entry">View my entry</a>
      <button class="btn plain small" id="again" title="Preview check: a repeated provider notification must not record a second payment">Re-send the same notification (test)</button></div>
      <p class="small muted" id="again-r"></p>`;
    $('#again').addEventListener('click', async () => {
      const r2 = await send();
      $('#again-r').textContent = r2.duplicate ? 'Duplicate notification recognised and ignored – no second payment recorded.' : JSON.stringify(r2);
    });
    sessionStorage.removeItem('rw-pay');
  }, 1200);
}

async function aboutPreview(el) {
  setTitle('About this preview');
  if (LIVE) { el.innerHTML = `${pageHead('Run Wild Melorane', 'This is the live site')}<section class="section"><div class="wrap narrow"><p>Entries and registrations are saved securely by ERP.</p><a class="btn plain" href="#/">Home</a></div></section>`; return; }
  el.innerHTML = `${pageHead('Preview', 'About this preview')}
  <section class="section"><div class="wrap narrow">
    <p>This is a working proof of concept for Run Wild Melorane. Registration (with shirt sizes and a socks add-on), capacity limits, waitlists, reservation expiry, Canvas Lodge requests, water point sponsorship, monetary donations, Run Buddy matching and the organiser dashboard all work.</p>
    <h3>What to know</h3>
    <ul class="ticks">
      <li><strong>Sample data.</strong> Records marked <span class="sample">Sample</span> are invented to show how the site looks with entries in it.</li>
      <li><strong>Your own copy.</strong> Everything is stored in this browser only. Other people opening the link see their own copy, not your test entries.</li>
      <li><strong>No real payments.</strong> “Pay online” opens a clearly marked preview payment page. EFT payments are recorded by organisers in the dashboard.</li>
      <li><strong>Nothing is sent.</strong> Confirmation emails and SMSes are queued and visible to organisers, marked as not sent, because no email or SMS provider is connected.</li>
      <li><strong>Organiser sign-in.</strong> Use <span class="ref">organiser@preview.local</span> / <span class="ref">runwild-preview</span>. In the preview this check runs in the browser; the launch version enforces it on the server.</li>
      <li><strong>Invitation codes.</strong> Try <span class="ref">GROUP-PREVIEW</span> for group employees and <span class="ref">MELORANE-PREVIEW</span> for Melorane employees.</li>
    </ul>
    <p>The capacity rules are built so that the “check the count, then reserve” step can never interleave with another registration. For launch, the same rules move to a hosted database (see the project README), where they are enforced with row locks and row-level security.</p>
    <div class="btn-row"><button class="btn plain" id="reset">Reset preview data</button><button class="btn plain" id="empty">Start with no sample data</button></div>
  </div></section>`;
  $('#reset').addEventListener('click', async () => { if (confirm('Reset all preview data in this browser?')) { await api.resetPreview({ withSamples: true }); toast('Preview data reset'); } });
  $('#empty').addEventListener('click', async () => { if (confirm('Remove all sample data in this browser?')) { await api.resetPreview({ withSamples: false }); toast('Started with an empty preview'); } });
}

async function notFound(el) {
  el.innerHTML = `<section class="section"><div class="wrap"><h1>Page not found</h1><p><a href="#/">Back to the event</a></p></div></section>`;
}

import { api, esc, $, $$, toast, tbc, pageHead, showErrors, clearErrors, formData, chargesTable, eftBlock, statusPill, rand, formatDate, formatDateTime } from './ui.js';
import { CATEGORIES, DISTANCES, lodgeQuote, nightsBetween, uid, addDays } from './core.js';
import { renderRegister } from './register.js';
import { renderOrganiser } from './organiser.js';
import { routeExplorer } from './route.js';

const app = $('#app');

const routes = {
  '': home,
  register: renderRegister,
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

window.addEventListener('hashchange', router);
$('#menu-btn').addEventListener('click', () => {
  const open = $('#nav').classList.toggle('open');
  $('#menu-btn').setAttribute('aria-expanded', String(open));
});
router();

function setTitle(t) { app.dataset.title = t; }

const BACK_INVOLVED = { href: '#/get-involved', label: 'Get involved' };

function startLine(ev) {
  return ev.startTime ? esc(ev.startTime) : 'Early start – exact time to be confirmed';
}

// ---------------- Home ----------------

function placesPill(pool) {
  if (!pool) return '<span class="places open">Open entry</span>';
  if (pool.full) return '<span class="places full">Waitlist open</span>';
  return `<span class="places ${pool.remaining <= 5 ? 'low' : ''}">${pool.remaining} of ${pool.limit} left</span>`;
}

function feeText(fee) {
  if (!fee.confirmed) return tbc();
  return fee.amount ? rand(fee.amount) : 'Free';
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
      <h3>Donate shoes or kit</h3>
      <p>Help equip up to ${s.donations.target} community runners with shoes, a vest and shorts.</p>
      <span class="meta">${s.donations.progress.shoesRequested} runners need shoes · ${s.donations.progress.kitRequested} need kit</span>
      <span class="link-arrow">Pledge a donation</span>
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

async function home(el) {
  setTitle('');
  const s = await api.publicSummary();
  const ev = s.event;
  const days = Math.ceil((new Date('2027-04-17T00:00:00+02:00') - Date.now()) / 86400000);
  el.innerHTML = `
  <section class="hero">
    <div class="wrap">
      <span class="eyebrow">ERP presents</span>
      <h1>Run Wild</h1>
      <p class="place">MELORANE</p>
      <p class="when">Saturday 17 April 2027<span>·</span>21 km trail run &amp; 5 km run/walk</p>
      <div class="btn-row">
        <a class="btn" href="#/register">Register now</a>
        <a class="btn ghost" href="#/info">Race info</a>
      </div>
      ${days > 0 ? `<p class="hero-note">${days} days to go · limited places</p>` : ''}
    </div>
    <div class="hero-land" role="img" aria-label="Red dirt track through the bushveld at sunrise"></div>
  </section>

  <div class="wrap facts">
    <div><span class="label">Date</span><strong>17 April 2027</strong></div>
    <div><span class="label">Start</span><strong>${ev.startTime && ev.startTimeConfirmed ? esc(ev.startTime) : 'Early morning'}</strong></div>
    <div><span class="label">Venue</span><strong>Melorane ERP Game Reserve</strong></div>
    <div><span class="label">Entry</span><strong>From R1,000</strong></div>
  </div>

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
        <p class="lead">A 21 km trail through the reserve, or a 5 km run/walk at your own pace. Both start and finish at the reserve gate.</p>
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
        <div class="entry-row"><div><h3>Group employees &amp; other participants</h3><p>Charitable entry, supporting the local running community</p></div>${placesPill(s.pools.combined)}<div class="fee">R1,000</div></div>
        <div class="entry-row"><div><h3>Community members</h3><p>Pickup from ${esc(ev.pickupPlace)} at ${esc(ev.pickupTime)}</p></div>${placesPill(s.pools.community)}<div class="fee">${feeText(s.fees.community)}</div></div>
        <div class="entry-row"><div><h3>Melorane employees</h3><p>Additional to the limited places · verified by the organisers</p></div>${placesPill(null)}<div class="fee">${feeText(s.fees.melorane_employee)}</div></div>
      </div>
      <div class="btn-row" style="justify-content:center;margin-top:36px"><a class="btn navy" href="#/register">Register now</a></div>
    </div>
  </section>

  <section class="section navy">
    <div class="wrap split top">
      <div>
        <span class="eyebrow">Race day</span>
        <h2>Saturday, 17 April 2027</h2>
        <p>Start and finish at Melorane ERP Game Reserve. Want to wake up at the start line? Stay the night before at Canvas Lodge – campfires, starry skies and the bush all around.</p>
        <div class="btn-row" style="margin-top:24px"><a class="btn light" href="#/lodge">Stay at Canvas Lodge</a></div>
      </div>
      <ol class="timeline">
        <li><span class="t">${esc(ev.pickupTime)}</span><span><strong>Community pickup</strong>${esc(ev.pickupPlace)}</span></li>
        <li><span class="t">Early</span><span><strong>Arrive at the reserve</strong>Everyone else makes their own way there</span></li>
        <li><span class="t">${ev.startTime && ev.startTimeConfirmed ? esc(ev.startTime) : 'Sunrise'}</span><span><strong>Race start</strong>${ev.startTime && ev.startTimeConfirmed ? '21 km and 5 km' : 'Exact time to be confirmed'}</span></li>
        <li><span class="t">Finish</span><span><strong>Celebrate together</strong>Back where it all began</span></li>
      </ol>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-head center">
        <span class="eyebrow">Not running?</span>
        <h2>Get involved</h2>
        <p class="lead">Many community runners need shoes and kit to take part. That’s where you come in.</p>
      </div>
      ${involvedTiles(s)}
    </div>
  </section>

  <section class="section sand cta-band">
    <div class="wrap narrow">
      <h2>See you on the trail.</h2>
      <p class="lead">Places are limited. Secure yours today.</p>
      <div class="btn-row"><a class="btn" href="#/register">Register now</a><a class="btn plain" href="#/info">Read the FAQ</a></div>
    </div>
  </section>`;
  routeExplorer($('#route'));
}

async function getInvolved(el) {
  setTitle('Get involved');
  const s = await api.publicSummary();
  el.innerHTML = `
  ${pageHead('Get involved', 'Help more runners reach the start line', 'Sponsor a water point, donate shoes or kit, or support a community runner as a Run Buddy. Sponsorships and donations never use a race place.')}
  <section class="section"><div class="wrap">${involvedTiles(s)}</div></section>`;
}

// ---------------- Canvas Lodge ----------------

async function lodge(el) {
  setTitle('Canvas Lodge');
  const s = await api.publicSummary();
  const L = s.lodge;
  const nights = L.nights;
  const dates = [...nights.map((n) => n.date), nights.length ? addDays(nights[nights.length - 1].date, 1) : null].filter(Boolean);
  const opt = (sel) => dates.map((d) => `<option value="${d}" ${d === sel ? 'selected' : ''}>${formatDate(d)}</option>`).join('');
  const q1 = lodgeQuote({ nights: 1, ratePerNight: L.ratePerNight, depositPercent: L.depositPercent });
  el.innerHTML = `
  ${pageHead('Accommodation', 'Canvas Lodge', 'Stay at Melorane ERP Game Reserve the night before the race. Offered to group employees and other participants.', { href: '#/info', label: 'Race info' })}
  <section class="section">
    <div class="wrap split">
      <div>
        <p class="price">R5,500 <span class="small muted" style="font-family:var(--body)">per person per night, all inclusive</span></p>
        <p>Camping at the Melorane ERP Game Reserve combines the thrill of the great outdoors with knowing your stay supports the conservation of elephants and rhinos and community development. Nightly bonfires, star gazing and an off-the-grid bush experience – and you are already at the start line on race morning.</p>
        <p class="small muted">Inclusions, minimum stay and cancellation terms ${tbc()} – we only publish what the organisers have confirmed.</p>

        <h3 style="margin-top:28px">How payment works</h3>
        <ul class="ticks">
          <li>Accommodation total = R5,500 × number of nights.</li>
          <li>A <strong>${L.depositPercent}% booking deposit</strong> secures your beds once availability is confirmed.</li>
          <li>The remaining <strong>${100 - L.depositPercent}%</strong> is due by <strong>${formatDate(L.balanceDueDate)}</strong>.</li>
          <li>The deposit is for accommodation only. It is never applied to the R1,000 charitable entry fee, sponsorships or donations, which are shown and paid separately.</li>
          <li>A request is <strong>not a confirmed booking</strong> until availability has been checked and the deposit has been verified.</li>
        </ul>
        <div class="notice warn"><p><strong>Booking after ${formatDate(L.balanceDueDate)}?</strong> ${L.latePolicy.confirmed ? esc(L.latePolicy.text) : 'Late-booking terms are still to be confirmed by the organisers. We will not ask you to meet a deadline that has already passed.'}</p></div>
      </div>
      <div class="card">
        <h3>Work out your stay</h3>
        <p class="small muted">Open nights: ${nights.map((n) => formatDate(n.date) + (n.available ? '' : ' (full)')).join(', ')} ${L.inventoryConfirmed ? '' : '<span class="sample">Sample dates</span>'}</p>
        <div class="row2">
          <div class="field"><label for="la">Arrive</label><select id="la">${opt(dates[1] || dates[0])}</select></div>
          <div class="field"><label for="ld">Depart</label><select id="ld">${opt(dates[2] || dates[1])}</select></div>
        </div>
        <div id="lq"></div>
        <p class="small muted">Example for one participant, one night: accommodation ${rand(q1.total)}, deposit ${rand(q1.deposit)}, balance ${rand(q1.balance)}. The R1,000 charitable entry fee is separate.</p>
        <div class="btn-row"><a class="btn" href="#/register">Register and request a stay</a></div>
        <p class="small" style="margin-top:12px">Already registered? <a href="#/my-entry">Add a stay to your entry</a>.</p>
      </div>
    </div>
  </section>`;
  const calc = () => {
    const n = nightsBetween($('#la').value, $('#ld').value);
    if (n < 1) { $('#lq').innerHTML = '<p class="err">Departure must be after arrival.</p>'; return; }
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
        <p class="small muted">A confirmation email has been queued. In this preview no email provider is connected, so nothing is actually sent.</p>
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
  setTitle('Donate shoes or kit');
  const s = await api.publicSummary();
  const D = s.donations;
  const P = D.progress;
  const fin = D.financialEnabled && (D.shoePrice || D.kitPrice);
  const requestId = uid();
  el.innerHTML = `
  ${pageHead('Donations', 'Donate shoes or running kit', 'Help equip up to ' + D.target + ' community runners for race day and the training that comes before it.', BACK_INVOLVED)}
  <section class="section">
    <div class="wrap">
      <div class="grid two">
        <div class="card accent">
          <h3>Donate a pair of running shoes</h3>
          <p>New or good-condition running shoes, matched to the sizes our community runners have asked for.</p>
          <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin:0">
            <div><span class="label muted">Requested</span><div class="stat" style="font-size:1.6rem">${P.shoesRequested}</div></div>
            <div><span class="label muted">Received</span><div class="stat" style="font-size:1.6rem">${P.shoesInHand}</div></div>
            <div><span class="label muted">Pledged</span><div class="stat" style="font-size:1.6rem">${P.shoesPledged}</div></div>
          </div>
          <button class="btn small" data-type="shoes" style="margin-top:12px">Pledge shoes</button>
        </div>
        <div class="card accent">
          <h3>Donate running kit: a vest and shorts</h3>
          <p>A running vest and a pair of shorts, so every community participant can line up ready to run.</p>
          <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin:0">
            <div><span class="label muted">Requested</span><div class="stat" style="font-size:1.6rem">${P.kitRequested}</div></div>
            <div><span class="label muted">Received</span><div class="stat" style="font-size:1.6rem">${P.kitInHand}</div></div>
            <div><span class="label muted">Pledged</span><div class="stat" style="font-size:1.6rem">${P.kitPledged}</div></div>
          </div>
          <button class="btn small" data-type="kit" style="margin-top:12px">Pledge kit</button>
        </div>
      </div>
      <p class="small muted" style="margin-top:12px">“Received” counts items that have physically arrived. A pledge is counted separately until it is received. We only show totals here – never the names, sizes or needs of individual participants.</p>

      <div class="split" style="margin-top:36px">
        <form class="card" id="pledge-form" novalidate>
          <h3>Pledge a physical donation</h3>
          <div class="notice bad form-error" hidden></div>
          <fieldset data-field="type"><span class="legend">What are you donating?</span>
            <div class="choices cols">
              <label class="choice"><input type="radio" name="type" value="shoes" checked><span><strong>Running shoes</strong>pairs</span></label>
              <label class="choice"><input type="radio" name="type" value="kit"><span><strong>Running kit</strong>vest + shorts sets</span></label>
            </div></fieldset>
          <div class="field" data-field="quantity"><label for="qty">Quantity</label><input id="qty" name="quantity" type="number" min="1" max="100" value="1"></div>
          <div class="row2" id="shoe-size">
            <div class="field" data-field="size"><label for="sz">Shoe size</label><input id="sz" name="size" type="text" placeholder="e.g. 8"></div>
            <div class="field"><label for="ss">Sizing system</label><select id="ss" name="sizeSystem"><option>UK</option><option>EU</option><option>US</option></select></div>
          </div>
          <div class="row2" id="kit-size" hidden>
            <div class="field" data-field="shirtSize"><label for="vs">Vest size</label><select id="vs" name="shirtSize"><option value="">Choose…</option>${['XS', 'S', 'M', 'L', 'XL', 'XXL'].map((x) => `<option>${x}</option>`).join('')}</select></div>
            <div class="field"><label for="shs">Shorts size</label><select id="shs" name="shortsSize"><option value="">Choose…</option>${['XS', 'S', 'M', 'L', 'XL', 'XXL'].map((x) => `<option>${x}</option>`).join('')}</select></div>
          </div>
          <p class="small muted">Giving several sizes? Submit one pledge per size.</p>
          <div class="field" data-field="condition"><label for="cond">Condition ${D.criteriaApproved ? '' : tbc('Criteria pending approval')}</label>
            <select id="cond" name="condition">${D.conditionCriteria.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
          <div class="field" data-field="delivery"><label for="del">How will the items reach us?</label>
            <select id="del" name="delivery"><option value="">Choose…</option><option>Drop-off</option><option>Collection requested</option><option>Courier</option><option>Bring on race day</option></select>
            <span class="hint">${D.dropOffText ? esc(D.dropOffText) : 'Drop-off points and collection arrangements will be confirmed by the organisers.'}</span></div>
          <div class="field" data-field="donor"><label for="dn">Your name or company</label><input id="dn" name="donor" type="text" autocomplete="name"></div>
          <div class="row2">
            <div class="field" data-field="email"><label for="de">Email</label><input id="de" name="email" type="email" autocomplete="email"></div>
            <div class="field"><label for="dp">Mobile <span class="hint">Optional</span></label><input id="dp" name="phone" type="tel" autocomplete="tel"></div>
          </div>
          <button class="btn" type="submit">Submit pledge</button>
        </form>
        <div>
          <h3>Prefer to contribute money?</h3>
          ${fin ? `<p>Contribute towards buying shoes (${D.shoePrice ? rand(D.shoePrice) : '—'} a pair) or kit (${D.kitPrice ? rand(D.kitPrice) : '—'} a set).</p>
            <form id="fin-form" class="card quiet" novalidate>
              <div class="row2"><div class="field"><label for="ft">Item</label><select id="ft" name="type">${D.shoePrice ? '<option value="shoes">Shoes</option>' : ''}${D.kitPrice ? '<option value="kit">Kit</option>' : ''}</select></div>
              <div class="field"><label for="fq">Quantity</label><input id="fq" name="quantity" type="number" min="1" max="50" value="1"></div></div>
              <div class="field"><label for="fn">Name</label><input id="fn" name="donor" type="text"></div>
              <div class="field"><label for="fe">Email</label><input id="fe" name="email" type="email"></div>
              <div class="notice bad form-error" hidden></div>
              <button class="btn navy" type="submit">Continue to payment</button></form>`
    : `<div class="notice warn"><p>Financial contributions towards shoes and kit will open once the organisers have confirmed item prices and payment arrangements. We do not publish estimated prices.</p></div>`}
          <p>Every item goes to a community participant registered for Run Wild Melorane, matched to the sizes they asked for. Organisers track each item from pledge to delivery.</p>
          <p class="small muted">Questions about a large or corporate donation? Email <a href="mailto:info@erp.ngo?subject=Run%20Wild%20Melorane%20donation">info@erp.ngo</a>.</p>
        </div>
      </div>
    </div>
  </section>`;
  const form = $('#pledge-form');
  const sync = () => {
    const t = form.querySelector('[name=type]:checked').value;
    $('#shoe-size').hidden = t !== 'shoes';
    $('#kit-size').hidden = t !== 'kit';
    $$('.choice', form).forEach((c) => c.classList.toggle('checked', c.querySelector('input').checked));
  };
  $$('[name=type]', form).forEach((r) => r.addEventListener('change', sync));
  $$('[data-type]').forEach((b) => b.addEventListener('click', () => { form.querySelector(`[value=${b.dataset.type}]`).checked = true; sync(); form.scrollIntoView({ behavior: 'smooth' }); }));
  sync();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const d = formData(form);
    d.clientRequestId = requestId;
    if (d.type === 'shoes') { d.shirtSize = ''; d.shortsSize = ''; } else { d.size = ''; d.sizeSystem = ''; }
    try {
      const p = await api.submitPledge(d);
      el.innerHTML = `${pageHead('Donations', 'Thank you for your pledge')}
        <section class="section"><div class="wrap narrow">
          <div class="notice ok"><p>Pledge reference <span class="ref">${esc(p.ref)}</span>: ${p.quantity} × ${p.type === 'shoes' ? 'pair(s) of running shoes, size ' + esc(p.size) + ' ' + esc(p.sizeSystem) : 'running kit set(s), vest ' + esc(p.shirtSize) + ' / shorts ' + esc(p.shortsSize)}.</p></div>
          <p>Your pledge is recorded as <strong>pledged</strong>. It will be marked as received once the items reach the organisers. We will contact you about ${esc(p.delivery.toLowerCase())}.</p>
          <p class="small muted">A confirmation message has been queued. In this preview no email provider is connected, so nothing is actually sent.</p>
          <a class="btn plain" href="#/donate">Back to donations</a>
        </div></section>`;
      window.scrollTo(0, 0);
    } catch (err) { showErrors(form, err); }
  });
  const ff = $('#fin-form');
  if (ff) ff.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await api.submitContribution(formData(ff));
      location.hash = '#/pay/' + encodeURIComponent(c.charge.ref);
    } catch (err) { showErrors(ff, err); }
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
        <div class="btn-row"><a class="btn" href="#/register">Register and volunteer</a><a class="btn plain" href="#/my-entry">Already registered? Opt in</a></div>
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
    ['When and where is the race?', `Saturday 17 April 2027 at ${esc(ev.venue)}. ${startLine(ev)}. Plan to arrive early – the start is early in the morning.`],
    ['Which distances are there?', '<strong>21 km trail run</strong> or <strong>5 km run/walk</strong>. You choose one when you register. Both distances use the same pool of places for your category.'],
    ['How many places are there?', `Group employees and other participants share one pool of ${s.pools.combined.limit} places. Community members have ${s.pools.community.limit} places. Melorane employees have no limit and do not use either pool. When a pool is full you can join its waitlist – no payment is taken for a waitlist place.`],
    ['What does the R1,000 charitable entry fee cover?', esc(ev.proceedsText) + ' It applies to group employees and other participants for either distance.'],
    ['What do community members and Melorane employees pay?', `Community members: ${s.fees.community.confirmed ? rand(s.fees.community.amount) : 'to be confirmed by the organisers'}. Melorane employees: ${s.fees.melorane_employee.confirmed ? rand(s.fees.melorane_employee.amount) : 'to be confirmed by the organisers'}. We will not ask for payment until the fee is confirmed.`],
    ['How do I get there?', `Community participants are picked up from ${esc(ev.pickupPlace)} at ${esc(ev.pickupTime)} on 17 April 2027${ev.pickupAddressConfirmed && ev.pickupFullAddress ? ' (' + esc(ev.pickupFullAddress) + ')' : ''}. Everyone else arranges their own transport and must arrive at the reserve on time, or stays at Canvas Lodge the night before.`],
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
          <p>ERP collects your name, contact numbers, email address, emergency contact, category, distance and – for community participants – clothing and shoe sizes, to run Run Wild Melorane: to manage entries and payments, transport and safety on the day, kit distribution and the Run Buddy programme.</p>
          <p>Your details are seen only by authorised organisers. We do not publish names, contact details, sizes or individual needs, and we only share your contact details with a Run Buddy once you have both agreed. Sponsors’ names and logos are shown only with their permission. You can ask to see, correct or delete your information by contacting <a href="mailto:info@erp.ngo">info@erp.ngo</a>, in line with POPIA.</p></div></details>
      </div>
    </div>
    <aside style="display:grid;gap:20px">
      <div class="card raised">
        <h3>Key details</h3>
        <table class="summary"><tbody>
          <tr><th>Date</th><td>Saturday 17 April 2027</td></tr>
          <tr><th>Start</th><td>${ev.startTime && ev.startTimeConfirmed ? esc(ev.startTime) : 'Early start – time to be confirmed'}</td></tr>
          <tr><th>Venue</th><td>${esc(ev.venue)}</td></tr>
          <tr><th>Distances</th><td>21 km trail · 5 km run/walk</td></tr>
          <tr><th>Community pickup</th><td>${esc(ev.pickupPlace)}, ${esc(ev.pickupTime)}</td></tr>
        </tbody></table>
        <div class="btn-row" style="margin-top:20px"><a class="btn" href="#/register">Register</a></div>
      </div>
      <div class="card quiet">
        <h3>Stay at Canvas Lodge</h3>
        <p class="muted">Sleep at the reserve the night before and wake up at the start line. R5,500 per person per night, all inclusive.</p>
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
  const statusText = {
    reserved: r.holdReason === 'fee_unconfirmed'
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
      <tr><th>Race day</th><td>17 April 2027 · ${r.event.startTime ? esc(r.event.startTime) : 'Early start – exact time to be confirmed'}</td></tr>
      ${r.category === 'community' ? `<tr><th>Pickup</th><td>${esc(r.event.pickupPlace)} at ${esc(r.event.pickupTime)} on 17 April 2027${r.event.pickupFullAddress ? ' – ' + esc(r.event.pickupFullAddress) : ''}</td></tr>` : `<tr><th>Getting there</th><td>${r.lodgeWanted ? 'Staying at Canvas Lodge (see below).' : 'Early start from Melorane ERP Game Reserve. You arrange your own transport and arrive on time.'}</td></tr>`}
      ${r.buddy ? `<tr><th>Run Buddy</th><td>${r.buddy.optIn ? statusPill(r.buddy.status || 'awaiting_match') : 'Not taking part'}</td></tr>` : ''}
      ${!entry && r.status !== 'waitlisted' && r.status !== 'draft' ? `<tr><th>Entry fee</th><td>${r.fee.confirmed ? rand(r.fee.amount) : '<span class="tbc">To be confirmed</span>'}</td></tr>` : ''}
    </tbody></table>
    <div class="notice ${r.status === 'confirmed' ? 'ok' : r.status === 'cancelled' ? 'bad' : 'sun'}" style="margin-top:16px"><p>${statusText}</p></div>
    ${r.lodge ? `<h3>Canvas Lodge</h3>
      <p>${statusPill(r.lodge.status, { requested: 'Requested – not yet confirmed', awaiting_deposit: 'Beds held – deposit due', confirmed: 'Confirmed – balance outstanding', paid_in_full: 'Paid in full', declined: 'Declined', cancelled: 'Cancelled', expired: 'Hold expired' }[r.lodge.status])}
      ${formatDate(r.lodge.arrival)} to ${formatDate(r.lodge.departure)} · ${r.lodge.nights} night${r.lodge.nights > 1 ? 's' : ''}</p>
      ${r.lodge.note ? `<p class="small">${esc(r.lodge.note)}</p>` : ''}
      ${r.lodge.status === 'awaiting_deposit' ? `<p class="small">Beds are held until ${formatDateTime(r.lodge.expiresAt)}. Your stay is confirmed once the deposit is verified.</p>` : ''}
      ${r.lodge.balanceNote ? `<p class="small">${esc(r.lodge.balanceNote)}</p>` : ''}` : ''}
    ${charges.length ? `<h3>Amounts</h3>${chargesTable([...(entry ? [entry] : []), ...lodgeCharges], { payments: r.payments })}${eftBlock(r.payments, charges.filter((c) => c.outstanding > 0).map((c) => c.ref))}` : ''}`;
}

function renderMine(box, r, creds, reload) {
  const adult = CATEGORIES[r.category].adultOptions;
  const canLodge = adult && r.status !== 'cancelled' && (!r.lodge || ['declined', 'cancelled', 'expired'].includes(r.lodge.status));
  const m = r.match;
  box.innerHTML = `<div class="card" style="margin-top:20px">${confirmationHTML(r)}
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
        <div class="field"><label>Arrive</label><input name="arrival" type="date" min="2027-04-01" max="2027-04-30" value="2027-04-16"></div>
        <div class="field"><label>Depart</label><input name="departure" type="date" min="2027-04-01" max="2027-04-30" value="2027-04-17"></div>
        <div class="field"><button class="btn small" type="submit">Request stay</button></div>
        <div class="notice bad form-error" hidden style="grid-column:1/-1"></div></form>` : ''}
  </div>`;
  const act = async (fn) => { try { await fn(); toast('Saved'); reload(); } catch (e) { toast(e.message, true); } };
  $('#m-yes', box)?.addEventListener('click', () => act(() => api.consentToMatch(creds.ref, creds.mobile, true)));
  $('#m-no', box)?.addEventListener('click', () => act(() => api.consentToMatch(creds.ref, creds.mobile, false)));
  $('#b-out', box)?.addEventListener('click', () => act(() => api.updateMyBuddy(creds.ref, creds.mobile, { optIn: false })));
  $('#b-in', box)?.addEventListener('click', () => act(() => api.updateMyBuddy(creds.ref, creds.mobile, { optIn: true })));
  $('#bf', box)?.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; api.updateMyBuddy(creds.ref, creds.mobile, { optIn: true, ...formData(f) }).then(() => { toast('Thank you for volunteering'); reload(); }, (err) => showErrors(f, err)); });
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
    <div class="card" style="border:2px dashed #b9a7c9">
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
  el.innerHTML = `${pageHead('Preview', 'About this preview')}
  <section class="section"><div class="wrap narrow">
    <p>This is a working proof of concept for Run Wild Melorane. Registration, capacity limits, waitlists, reservation expiry, Canvas Lodge requests, water point sponsorship, donation tracking, Run Buddy matching and the organiser dashboard all work.</p>
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

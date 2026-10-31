import { api, esc, $, $$, pageHead, showErrors, rand, formatDate, tbc } from './ui.js';
import { formatDay, CATEGORIES, DISTANCES, SHIRT_SIZES, SOCK_SIZES, lodgeQuote, nightsBetween, uid, addDays, validEmail, validMobile } from './core.js';
import { confirmationHTML } from './app.js';

const TRANSPORT_ACK = 'The event will have an early start from Melorane ERP Game Reserve. I am responsible for arranging my transport and arriving on time.';
const SIZES = SHIRT_SIZES;

// Short description per category. Fees are not shown here; the fee appears once a category is picked.
const CAT_BLURB = {
  group_employee: 'Employees of ERP group companies · invitation code',
  other: 'Friends, family and anyone else who would like to run',
  community: 'Members of the Melorane community · pickup from PJ',
  melorane_employee: 'Unlimited entries · invitation code',
};

// Which wizard step owns each field, so server-side errors send the user back to the right place.
const FIELD_STEP = {
  category: 0, inviteCode: 0,
  fullName: 1, mobile: 1, email: 1, emergencyName: 1, emergencyMobile: 1, distance: 1, employer: 1, shirtSize: 1,
  lodge: 2, lodgeDates: 2, transportAck: 2, buddyExperience: 2, buddyAvailability: 2, pickupAck: 2, shoeSize: 2, shoeSystem: 2, shortsSize: 2, socksQty: 2, socksSize: 2,
  termsAccepted: 3, privacyAck: 3,
};

export async function renderRegister(el) {
  el.dataset.title = 'Register';
  const s = await api.publicSummary();
  const token = sessionStorage.getItem('rw-org-token');
  // Race entries are closed to the public until the opening date. Organisers can still register people.
  if (!s.registration.open && !token) {
    el.innerHTML = `<section class="page-head"><div class="wrap narrow">
        <span class="eyebrow">Entries</span><h1>Race entries open ${formatDate(s.registration.opensOn)}</h1>
        <div class="reg-meta"><span>${formatDay(s.event.date)}</span><span>Melorane ERP Game Reserve</span><span>21 km trail · 5 km run/walk</span></div>
      </div></section>
      <section class="section tight"><div class="wrap narrow">
        <div class="card">
          <p class="lead" style="margin-top:0">Entries for the race are closed until <strong>${formatDate(s.registration.opensOn)}</strong>.</p>
          <p>In the meantime, join us at the <strong>launch event</strong> at ${esc(s.launch.venue)}. Registering for the launch does not enter you for the race.</p>
          <div class="btn-row"><a class="btn" href="#/launch">Register for the launch event</a><a class="btn plain" href="#/info">Race info</a></div>
        </div>
      </div></section>`;
    return;
  }
  const st = {
    step: 0,
    clientRequestId: uid(),
    d: { category: '', distance: '', lodge: { wanted: null, arrival: '', departure: '' }, buddy: { optIn: false }, kit: { shoeSystem: 'UK', needsShoes: false, needsKit: false }, socks: { qty: 0, size: '' }, communityBuddy: false },
  };
  const nights = s.lodge.nights;
  const lodgeDates = [...nights.map((n) => n.date), nights.length ? addDays(nights[nights.length - 1].date, 1) : null].filter(Boolean);
  const minNights = s.lodge.minNights || 1;

  el.innerHTML = `<section class="page-head"><div class="wrap narrow">
      <span class="eyebrow">Entries</span><h1>Register</h1>
      <div class="reg-meta"><span>${formatDay(s.event.date)}</span><span>Melorane ERP Game Reserve</span><span>21 km trail · 5 km run/walk</span></div>
    </div></section>
    <section class="section tight"><div class="wrap narrow">
      ${token ? '<div class="notice sun"><p><strong>Organiser-assisted registration.</strong> You are signed in as an organiser, so this entry will be recorded as registered on someone’s behalf.</p></div>' : ''}
      ${!s.registration.open && token ? `<div class="notice warn"><p>Race entries are closed to the public until ${formatDate(s.registration.opensOn)}. Only organisers can register people before then.</p></div>` : ''}
      <ol class="steps" id="steps"><li>Category</li><li>Your details</li><li>Options</li><li>Review</li></ol>
      <form id="reg" class="reg-card" novalidate><div id="step"></div>
        <div class="notice bad form-error" hidden></div>
        <div class="btn-row" style="justify-content:space-between;margin-top:28px">
          <button type="button" class="btn plain" id="back">Back</button>
          <button type="submit" class="btn" id="next">Continue</button>
        </div>
      </form>
      <p class="small muted center" style="margin-top:20px">Already registered? <a href="#/my-entry">View your entry</a></p>
    </div></section>`;

  const form = $('#reg');
  const d = st.d;

  const catCard = (key) => {
    const c = CATEGORIES[key];
    const fee = s.fees[key];
    const pool = c.pool ? s.pools[c.pool] : null;
    const blocked = !fee.confirmed && !s.acceptWhileFeeUnconfirmed;
    const pill = pool ? (pool.full ? '<span class="places full">Waitlist</span>' : `<span class="places ${pool.remaining <= 5 ? 'low' : ''}">${pool.remaining} left</span>`) : '<span class="places open">Unlimited</span>';
    return `<label class="choice ${blocked ? 'disabled' : ''}"><input type="radio" name="category" value="${key}" ${d.category === key ? 'checked' : ''} ${blocked ? 'disabled' : ''}>
      <span>${pill}<strong>${esc(c.label)}</strong><span class="small muted">${esc(CAT_BLURB[key])}${pool && pool.full ? ' · join the waitlist, no payment taken' : ''}</span>${blocked ? '<br><span class="small">Opens once the fee is confirmed.</span>' : ''}</span></label>`;
  };

  // The entry fee is revealed only once a category has been picked.
  const feeReveal = (key) => {
    if (!key) return '';
    const fee = s.fees[key];
    const label = CATEGORIES[key].label.toLowerCase() + 's';
    if (!fee.confirmed) return `<div class="notice"><p><strong>Entry fee for ${esc(label)}:</strong> to be confirmed. Nothing is payable until the organisers confirm it.</p></div>`;
    if (!fee.amount) return `<div class="notice ok"><p><strong>No entry fee</strong> for ${esc(label)}.</p></div>`;
    return `<div class="notice sun"><p><strong>${esc(fee.label)}: ${rand(fee.amount)}</strong> per participant, either distance. Your RunWild running shirt is included.</p></div>`;
  };

  const sizeSelect = (name, val, sizes = SIZES) => `<select id="${name}" name="${name}"><option value="">Choose…</option>${sizes.map((x) => `<option ${val === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;

  // Socks are an optional add-on for every category.
  const socksBlock = () => {
    if (!s.socks || !s.socks.enabled) return '';
    const so = s.socks;
    const qty = Number(d.socks.qty || 0);
    return `<fieldset style="margin-top:24px"><span class="legend">Add RunWild running socks?</span>
        <span class="hint">${so.confirmed && so.price ? rand(so.price) + ' per pair, paid separately from the entry fee.' : 'Price to be confirmed. Your order is recorded now and nothing is payable for socks until the organisers confirm the price.'}</span>
        <div class="row2" style="margin-top:8px">
          <div class="field" data-field="socksQty"><label for="socksQty">Pairs</label><select id="socksQty" name="socksQty">${Array.from({ length: so.maxPerEntry + 1 }, (_, i) => `<option value="${i}" ${qty === i ? 'selected' : ''}>${i === 0 ? 'No socks, thanks' : i + (i > 1 ? ' pairs' : ' pair')}</option>`).join('')}</select></div>
          <div class="field" data-field="socksSize" id="socks-size" ${qty > 0 ? '' : 'hidden'}><label for="socksSize">Sock size</label>${sizeSelect('socksSize', d.socks.size, SOCK_SIZES)}</div>
        </div></fieldset>`;
  };

  // Running kit request (community members and Melorane employees). ERP buys the items with donated funds.
  const kitBlock = (sizesAlways) => `
        <fieldset><span class="legend">Do you need running kit?</span>
          <label class="check"><input type="checkbox" name="needsShoes" ${d.kit.needsShoes ? 'checked' : ''}> Running shoes</label>
          <label class="check"><input type="checkbox" name="needsKit" ${d.kit.needsKit ? 'checked' : ''}> Running kit (shorts, socks and a cap)</label>
          <span class="hint">Your RunWild running shirt comes with your entry. ERP buys shoes and kit with donated funds, so we cannot promise items, but we will do our best.</span>
        </fieldset>
        <div id="kit-sizes" ${sizesAlways || d.kit.needsShoes || d.kit.needsKit ? '' : 'hidden'}>
          <h3>Sizes</h3>
          <p class="small muted">We use these to buy and hand out the right sizes. They are never shown publicly.</p>
          <div class="row2">
            <div class="field" data-field="shoeSize"><label for="shoeSize">Shoe size</label><input id="shoeSize" name="shoeSize" type="text" inputmode="decimal" value="${esc(d.kit.shoeSize || '')}"></div>
            <div class="field" data-field="shoeSystem"><label for="shoeSystem">Shoe sizing system</label><select id="shoeSystem" name="shoeSystem">${['UK', 'EU', 'US'].map((x) => `<option ${d.kit.shoeSystem === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          </div>
          <div class="field" data-field="shortsSize"><label for="shortsSize">Pants / shorts size</label>${sizeSelect('shortsSize', d.kit.shortsSize)}</div>
        </div>`;

  const steps = [
    // 0: category
    () => `<h2>Who are you entering as?</h2>
      <fieldset data-field="category"><div class="choices">
        ${['group_employee', 'other', 'community', 'melorane_employee'].map(catCard).join('')}
      </div></fieldset>
      <div id="fee-box">${feeReveal(d.category)}</div>
      <div id="code-box" ${CATEGORIES[d.category]?.employee ? '' : 'hidden'}>
        <div class="field" data-field="inviteCode"><label for="inviteCode">Employee invitation code <span class="hint">Your code from the organisers confirms you are an employee. No code? Continue – the organisers will verify you before a place is allocated.</span></label>
          <input id="inviteCode" name="inviteCode" type="text" value="${esc(d.inviteCode || '')}" autocapitalize="characters"></div>
        ${token ? `<label class="check"><input type="checkbox" name="organiserVerified" ${d.organiserVerified ? 'checked' : ''}> I have verified this person’s employment (organiser)</label>` : ''}
      </div>`,
    // 1: details
    () => {
      const c = CATEGORIES[d.category];
      return `<h2>Your details</h2>
      <div class="field" data-field="fullName"><label for="fullName">Full name</label><input id="fullName" name="fullName" type="text" autocomplete="name" value="${esc(d.fullName || '')}"></div>
      <div class="row2">
        <div class="field" data-field="mobile"><label for="mobile">Mobile number</label><input id="mobile" name="mobile" type="tel" autocomplete="tel" value="${esc(d.mobile || '')}" placeholder="082 123 4567"></div>
        <div class="field" data-field="email"><label for="email">Email ${c.emailRequired ? '' : '<span class="hint">Optional</span>'}</label><input id="email" name="email" type="email" autocomplete="email" value="${esc(d.email || '')}"></div>
      </div>
      ${c.employee ? `<div class="field" data-field="employer"><label for="employer">Company or employer</label><input id="employer" name="employer" type="text" value="${esc(d.employer || (d.category === 'melorane_employee' ? 'Melorane' : ''))}"></div>` : ''}
      <div class="row2">
        <div class="field" data-field="emergencyName"><label for="emergencyName">Emergency contact name</label><input id="emergencyName" name="emergencyName" type="text" value="${esc(d.emergencyName || '')}"></div>
        <div class="field" data-field="emergencyMobile"><label for="emergencyMobile">Emergency contact number</label><input id="emergencyMobile" name="emergencyMobile" type="tel" value="${esc(d.emergencyMobile || '')}"></div>
      </div>
      <fieldset data-field="distance"><span class="legend">Distance</span><div class="choices cols">
        ${Object.entries(DISTANCES).map(([k, v]) => `<label class="choice"><input type="radio" name="distance" value="${k}" ${d.distance === k ? 'checked' : ''}><span><strong>${esc(v)}</strong></span></label>`).join('')}
      </div></fieldset>
      <div class="field" data-field="shirtSize"><label for="shirtSize">RunWild running shirt size <span class="hint">Every entry includes a RunWild running shirt.</span></label>${sizeSelect('shirtSize', d.shirtSize)}</div>`;
    },
    // 2: options
    () => {
      if (d.category === 'community') {
        return `<h2>Getting there and your kit</h2>
        <div class="notice sun"><p><strong>On ${formatDate(s.event.date)}, community participants will be picked up from ${esc(s.event.pickupPlace)} at ${esc(s.event.pickupTime)}.</strong>${s.event.pickupAddressConfirmed && s.event.pickupFullAddress ? ' ' + esc(s.event.pickupFullAddress) : ''}</p></div>
        <div class="field" data-field="pickupAck"><label class="check"><input type="checkbox" name="pickupAck" ${d.pickupAck ? 'checked' : ''}> I understand the pickup arrangements and will be at ${esc(s.event.pickupPlace)} by ${esc(s.event.pickupTime)}.</label></div>
        ${kitBlock(true)}
        <fieldset style="margin-top:24px"><span class="legend">Would you like support from a Community Run Buddy?</span>
          <span class="hint">A registered runner who helps with a training plan and encouragement. Your contact details are shared only if you both agree.</span>
          <div class="choices cols" style="margin-top:8px">
            <label class="choice"><input type="radio" name="communityBuddy" value="yes" ${d.communityBuddy ? 'checked' : ''}><span><strong>Yes please</strong></span></label>
            <label class="choice"><input type="radio" name="communityBuddy" value="no" ${!d.communityBuddy ? 'checked' : ''}><span><strong>No thanks</strong></span></label>
          </div></fieldset>
        ${socksBlock()}
        ${feeNote()}`;
      }
      if (d.category === 'melorane_employee') {
        return `<h2>Running kit and socks</h2>
          <p>Melorane employees have unlimited entries, in addition to the limited places, so you do not use a group or community place. Race day is ${formatDate(s.event.date)} with an early start – exact time to be confirmed.</p>
          ${kitBlock(false)}
          ${socksBlock()}
          ${feeNote()}`;
      }
      const q = d.lodge.wanted && d.lodge.arrival && d.lodge.departure && nightsBetween(d.lodge.arrival, d.lodge.departure) >= minNights
        ? lodgeQuote({ nights: nightsBetween(d.lodge.arrival, d.lodge.departure), ratePerNight: s.lodge.ratePerNight, depositPercent: s.lodge.depositPercent }) : null;
      const dsel = (name, val) => `<select id="${name}" name="${name}"><option value="">Choose…</option>${lodgeDates.map((x) => `<option value="${x}" ${x === val ? 'selected' : ''}>${formatDate(x)}</option>`).join('')}</select>`;
      const fee = s.fees[d.category];
      return `<h2>Entry fee, accommodation and Run Buddy</h2>
        <div class="card quiet" style="margin-bottom:20px">
          <span class="label muted">${esc(fee.label)}</span>
          <p class="price" style="margin:4px 0">${fee.confirmed ? (fee.amount ? rand(fee.amount) : 'No entry fee') : tbc()} <span class="small muted" style="font-family:var(--body)">per participant, either distance · RunWild running shirt included</span></p>
          <p class="small" style="margin:0">${esc(s.event.proceedsText)}</p>
        </div>
        <fieldset data-field="lodge"><span class="legend">Would you like to stay at Canvas Lodge?</span>
          <span class="hint">Canvas Lodge: ${rand(s.lodge.ratePerNight)} per person per night, all inclusive. Bookings are for a minimum of ${minNights} nights. Requests are subject to availability.</span>
          <div class="choices cols" style="margin-top:8px">
            <label class="choice"><input type="radio" name="lodgeWanted" value="yes" ${d.lodge.wanted === true ? 'checked' : ''}><span><strong>Yes, request a stay</strong></span></label>
            <label class="choice"><input type="radio" name="lodgeWanted" value="no" ${d.lodge.wanted === false ? 'checked' : ''}><span><strong>No, I’ll travel on race day</strong></span></label>
          </div></fieldset>
        <div id="lodge-yes" ${d.lodge.wanted === true ? '' : 'hidden'}>
          <div class="row2" data-field="lodgeDates">
            <div class="field"><label for="arrival">Arrival</label>${dsel('arrival', d.lodge.arrival)}</div>
            <div class="field"><label for="departure">Departure</label>${dsel('departure', d.lodge.departure)}</div>
          </div>
          ${q ? `<table class="summary money"><tbody>
            <tr><th>${q.nights} night${q.nights > 1 ? 's' : ''} accommodation</th><td>${rand(q.total)}</td></tr>
            <tr><th>Booking deposit (${s.lodge.depositPercent}%)</th><td>${rand(q.deposit)}</td></tr>
            <tr><th>Balance (${100 - s.lodge.depositPercent}%) due ${formatDate(s.lodge.balanceDueDate)}</th><td>${rand(q.balance)}</td></tr>
          </tbody></table>
          <p class="small muted">The deposit is for accommodation only and is separate from the entry fee. Your stay is confirmed only once availability is checked and the deposit is verified.</p>` : d.lodge.arrival && d.lodge.departure ? `<p class="small err">Canvas Lodge bookings are for a minimum of ${minNights} nights.</p>` : ''}
        </div>
        <div id="lodge-no" class="field" data-field="transportAck" ${d.lodge.wanted === false ? '' : 'hidden'}>
          <label class="check"><input type="checkbox" name="transportAck" ${d.transportAck ? 'checked' : ''}> ${esc(TRANSPORT_ACK)}</label>
        </div>
        <fieldset style="margin-top:24px"><span class="legend">Would you like to volunteer as a Community Run Buddy?</span>
          <span class="hint">Support a community participant with a training plan, encouragement and race preparation. Optional.</span>
          <div class="choices cols" style="margin-top:8px">
            <label class="choice"><input type="radio" name="buddyOpt" value="yes" ${d.buddy.optIn ? 'checked' : ''}><span><strong>Yes, I’d like to help</strong></span></label>
            <label class="choice"><input type="radio" name="buddyOpt" value="no" ${!d.buddy.optIn ? 'checked' : ''}><span><strong>Not this time</strong></span></label>
          </div></fieldset>
        <div id="buddy-yes" ${d.buddy.optIn ? '' : 'hidden'}>
          <div class="row2">
            <div class="field"><label for="bdist">Preferred distance</label><select id="bdist" name="buddyDistance">${Object.entries(DISTANCES).map(([k, v]) => `<option value="${k}" ${(d.buddy.preferredDistance || d.distance) === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="field"><label for="bcontact">Preferred contact method</label><select id="bcontact" name="buddyContact">${['WhatsApp', 'Phone', 'Email'].map((x) => `<option ${d.buddy.contactMethod === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          </div>
          <div class="field" data-field="buddyExperience"><label for="bexp">Running experience</label><input id="bexp" name="buddyExperience" type="text" value="${esc(d.buddy.experience || '')}" placeholder="e.g. two half marathons, parkrun regular"></div>
          <div class="field" data-field="buddyAvailability"><label for="bav">Availability</label><input id="bav" name="buddyAvailability" type="text" value="${esc(d.buddy.availability || '')}" placeholder="e.g. weekday evenings, Saturday mornings"></div>
          <div class="field"><label for="bsup">Support you could offer <span class="hint">A sentence or two</span></label><textarea id="bsup" name="buddySupport">${esc(d.buddy.support || '')}</textarea></div>
        </div>
        ${socksBlock()}`;
    },
    // 3: review
    () => {
      const c = CATEGORIES[d.category];
      const fee = s.fees[d.category];
      const pool = c.pool ? s.pools[c.pool] : null;
      const q = d.lodge.wanted ? lodgeQuote({ nights: nightsBetween(d.lodge.arrival, d.lodge.departure), ratePerNight: s.lodge.ratePerNight, depositPercent: s.lodge.depositPercent }) : null;
      const needsCode = c.employee && !d.organiserVerified;
      const sq = Number(d.socks.qty || 0);
      const so = s.socks;
      const kitNeeds = [d.kit.needsShoes && 'Shoes (' + d.kit.shoeSize + ' ' + d.kit.shoeSystem + ')', d.kit.needsKit && 'Kit (shorts ' + d.kit.shortsSize + ')'].filter(Boolean).join(', ') || 'None';
      return `<h2>Check your entry</h2>
        ${s.terms.approved ? '' : '<div class="notice warn"><p><strong>Preview:</strong> the event terms are still a draft awaiting organiser approval.</p></div>'}
        <table class="summary"><tbody>
          <tr><th>Category</th><td>${esc(c.label)}${c.employee ? (d.inviteCode ? ' · code ' + esc(d.inviteCode) : ' · to be verified by organisers') : ''}</td></tr>
          <tr><th>Name</th><td>${esc(d.fullName)}</td></tr>
          <tr><th>Mobile</th><td>${esc(d.mobile)}</td></tr>
          <tr><th>Email</th><td>${esc(d.email || '—')}</td></tr>
          ${c.employee ? `<tr><th>Employer</th><td>${esc(d.employer)}</td></tr>` : ''}
          <tr><th>Emergency contact</th><td>${esc(d.emergencyName)} · ${esc(d.emergencyMobile)}</td></tr>
          <tr><th>Distance</th><td>${esc(DISTANCES[d.distance])}</td></tr>
          <tr><th>RunWild shirt</th><td>Size ${esc(d.shirtSize)} – included with your entry</td></tr>
          <tr><th>Socks</th><td>${sq ? sq + (sq > 1 ? ' pairs' : ' pair') + ', size ' + esc(d.socks.size) : 'None'}</td></tr>
          ${d.category === 'community' ? `<tr><th>Pickup</th><td>${esc(s.event.pickupPlace)}, ${esc(s.event.pickupTime)} – acknowledged</td></tr>
            <tr><th>Sizes</th><td>Shoe ${esc(d.kit.shoeSize)} ${esc(d.kit.shoeSystem)} · pants/shorts ${esc(d.kit.shortsSize)}</td></tr>` : ''}
          ${c.kitOptions ? `<tr><th>Running kit needed</th><td>${esc(kitNeeds)}</td></tr>` : ''}
          ${d.category === 'community' ? `<tr><th>Run Buddy</th><td>${d.communityBuddy ? 'Would like a buddy' : 'No'}</td></tr>` : ''}
          ${c.adultOptions ? `<tr><th>Canvas Lodge</th><td>${d.lodge.wanted ? `${formatDate(d.lodge.arrival)} to ${formatDate(d.lodge.departure)} (${q.nights} night${q.nights > 1 ? 's' : ''}) – request` : 'No – own transport, early arrival acknowledged'}</td></tr>
            <tr><th>Run Buddy</th><td>${d.buddy.optIn ? 'Volunteering' : 'No'}</td></tr>` : ''}
        </tbody></table>
        <h3 style="margin-top:24px">Amounts</h3>
        <div class="table-wrap"><table class="data money"><tbody>
          <tr><td>${esc(fee.label)}</td><td class="num">${fee.confirmed ? rand(fee.amount) : tbc()}</td></tr>
          ${q ? `<tr><td>Canvas Lodge deposit (${s.lodge.depositPercent}%) – payable once beds are confirmed available</td><td class="num">${rand(q.deposit)}</td></tr>
          <tr><td>Canvas Lodge balance (${100 - s.lodge.depositPercent}%) – due ${formatDate(s.lodge.balanceDueDate)}</td><td class="num">${rand(q.balance)}</td></tr>` : ''}
          ${sq ? `<tr><td>${esc(so.label)} × ${sq} – paid separately</td><td class="num">${so.confirmed && so.price ? rand(so.price * sq) : tbc()}</td></tr>` : ''}
        </tbody></table></div>
        ${pool && pool.full ? '<div class="notice warn"><p>This category is currently full. Submitting adds you to the <strong>waitlist</strong>. No entry payment is taken.</p></div>'
          : pool ? `<p class="small muted">Places are allocated when you submit. If the last place goes before then, you will be added to the waitlist instead and nothing is charged.</p>` : ''}
        ${needsCode && !d.inviteCode ? '<div class="notice warn"><p>Without an invitation code, your entry waits for organiser verification before a place is allocated.</p></div>' : ''}
        ${fee.amount && fee.confirmed ? `<p class="small muted">After submitting, your place is reserved for ${s.reservationHours} hours while you pay.</p>` : ''}
        <details style="margin-top:12px"><summary>Read the event terms</summary><div><p>${esc(s.terms.text)}</p><p class="small muted">Version ${esc(s.terms.version)}${s.terms.approved ? '' : ' – draft'}</p></div></details>
        <details><summary>Read the privacy notice</summary><div><p>ERP uses your details only to run Run Wild Melorane: entries and payments, safety and transport on the day, kit distribution and the Run Buddy programme. Only authorised organisers can see them. We never publish names, contact details, sizes or individual needs, and we only share your contact details with a Run Buddy once you have both agreed. You may ask to see, correct or delete your information at any time (POPIA).</p></div></details>
        <div class="field" data-field="termsAccepted" style="margin-top:16px"><label class="check"><input type="checkbox" name="termsAccepted" ${d.termsAccepted ? 'checked' : ''}> I accept the event terms.</label></div>
        <div class="field" data-field="privacyAck"><label class="check"><input type="checkbox" name="privacyAck" ${d.privacyAck ? 'checked' : ''}> I have read the privacy notice.</label></div>`;
    },
  ];

  function feeNote() {
    const fee = s.fees[d.category];
    if (fee.confirmed) return `<p class="small muted">Entry fee: ${fee.amount ? rand(fee.amount) : 'no entry fee'}.</p>`;
    return `<div class="notice warn"><p><strong>Entry fee to be confirmed.</strong> The fee for ${esc(CATEGORIES[d.category].label.toLowerCase())}s has not been set yet. Your place will be held and you will not be asked to pay anything until the organisers confirm the fee.</p></div>`;
  }

  function collect() {
    const f = form;
    const val = (n) => (f.elements[n] ? (f.elements[n].type === 'checkbox' ? f.elements[n].checked : f.elements[n].value) : undefined);
    const radio = (n) => { const r = f.querySelector(`[name="${n}"]:checked`); return r ? r.value : ''; };
    if (st.step === 0) {
      d.category = radio('category');
      d.inviteCode = (val('inviteCode') || '').trim();
      d.organiserVerified = !!val('organiserVerified');
    } else if (st.step === 1) {
      for (const n of ['fullName', 'mobile', 'email', 'emergencyName', 'emergencyMobile', 'employer']) if (f.elements[n]) d[n] = val(n).trim();
      d.distance = radio('distance');
      d.shirtSize = val('shirtSize');
    } else if (st.step === 2) {
      if (f.elements.socksQty) d.socks = { qty: Number(val('socksQty')), size: Number(val('socksQty')) ? val('socksSize') : '' };
      if (CATEGORIES[d.category].kitOptions) {
        d.kit = { shoeSize: val('shoeSize').trim(), shoeSystem: val('shoeSystem'), shortsSize: val('shortsSize'), needsShoes: val('needsShoes'), needsKit: val('needsKit') };
      }
      if (d.category === 'community') {
        d.pickupAck = val('pickupAck');
        d.communityBuddy = radio('communityBuddy') === 'yes';
      } else if (CATEGORIES[d.category].adultOptions) {
        const lw = radio('lodgeWanted');
        d.lodge = { wanted: lw === 'yes' ? true : lw === 'no' ? false : null, arrival: val('arrival') || '', departure: val('departure') || '' };
        d.transportAck = !!val('transportAck');
        d.buddy = radio('buddyOpt') === 'yes'
          ? { optIn: true, preferredDistance: val('buddyDistance'), contactMethod: val('buddyContact'), experience: val('buddyExperience').trim(), availability: val('buddyAvailability').trim(), support: val('buddySupport').trim() }
          : { optIn: false };
      }
    } else if (st.step === 3) {
      d.termsAccepted = val('termsAccepted');
      d.privacyAck = val('privacyAck');
    }
  }

  // Quick checks before moving on; the backend re-validates everything on submit.
  function check() {
    const e = {};
    const c = CATEGORIES[d.category];
    if (st.step === 0 && !c) e.category = 'Choose a participant category.';
    if (st.step === 1) {
      if (!d.fullName || d.fullName.length < 3) e.fullName = 'Enter your full name.';
      if (!validMobile(d.mobile)) e.mobile = 'Enter a South African mobile number, e.g. 082 123 4567.';
      if (c.emailRequired && !validEmail(d.email)) e.email = 'An email address is required for this category.';
      else if (d.email && !validEmail(d.email)) e.email = 'Check the email address.';
      if (c.employee && !d.employer) e.employer = 'Enter your company or employer.';
      if (!d.emergencyName) e.emergencyName = 'Enter an emergency contact name.';
      if (!validMobile(d.emergencyMobile)) e.emergencyMobile = 'Enter an emergency contact number.';
      if (!d.distance) e.distance = 'Choose a distance.';
      if (!d.shirtSize) e.shirtSize = 'Choose a size for your RunWild running shirt.';
    }
    if (st.step === 2) {
      if (d.socks.qty > 0 && !d.socks.size) e.socksSize = 'Choose a sock size.';
      if (d.category === 'community') {
        if (!d.pickupAck) e.pickupAck = 'Please acknowledge the pickup arrangements.';
        if (!d.kit.shoeSize) e.shoeSize = 'Enter a shoe size.';
        if (!d.kit.shortsSize) e.shortsSize = 'Choose a size.';
      } else if (d.category === 'melorane_employee') {
        if (d.kit.needsShoes && !d.kit.shoeSize) e.shoeSize = 'Enter a shoe size.';
        if (d.kit.needsKit && !d.kit.shortsSize) e.shortsSize = 'Choose a size.';
      } else if (c.adultOptions) {
        if (d.lodge.wanted === null) e.lodge = 'Please choose an option.';
        if (d.lodge.wanted && !(d.lodge.arrival && d.lodge.departure && nightsBetween(d.lodge.arrival, d.lodge.departure) > 0)) e.lodgeDates = 'Choose an arrival date and a later departure date.';
        else if (d.lodge.wanted && nightsBetween(d.lodge.arrival, d.lodge.departure) < minNights) e.lodgeDates = 'Canvas Lodge bookings are for a minimum of ' + minNights + ' nights.';
        if (d.lodge.wanted === false && !d.transportAck) e.transportAck = 'Please acknowledge this to continue.';
        if (d.buddy.optIn && !d.buddy.experience) e.buddyExperience = 'Tell us a little about your running.';
        if (d.buddy.optIn && !d.buddy.availability) e.buddyAvailability = 'Tell us when you are available.';
      }
    }
    if (st.step === 3) {
      if (!d.termsAccepted) e.termsAccepted = 'Please accept the event terms.';
      if (!d.privacyAck) e.privacyAck = 'Please confirm you have read the privacy notice.';
    }
    return e;
  }

  function draw() {
    $('#step').innerHTML = steps[st.step]();
    $$('#steps li').forEach((li, i) => { li.className = i < st.step ? 'done' : i === st.step ? 'on' : ''; });
    $('#back').style.visibility = st.step === 0 ? 'hidden' : 'visible';
    $('#next').textContent = st.step === 3 ? 'Submit registration' : 'Continue';
    $('.form-error', form).hidden = true;
    wire();
  }

  function wire() {
    const mark = () => $$('.choice', form).forEach((c) => c.classList.toggle('checked', !!c.querySelector('input:checked')));
    $$('.choice input', form).forEach((i) => i.addEventListener('change', mark));
    mark();
    $$('[name=category]', form).forEach((i) => i.addEventListener('change', () => { $('#code-box').hidden = !CATEGORIES[i.value].employee; $('#fee-box').innerHTML = feeReveal(i.value); }));
    $$('[name=socksQty]', form).forEach((i) => i.addEventListener('change', () => { $('#socks-size').hidden = Number(i.value) === 0; }));
    if (d.category === 'melorane_employee') $$('[name=needsShoes],[name=needsKit]', form).forEach((i) => i.addEventListener('change', () => { $('#kit-sizes').hidden = !(form.elements.needsShoes.checked || form.elements.needsKit.checked); }));
    $$('[name=lodgeWanted]', form).forEach((i) => i.addEventListener('change', () => { $('#lodge-yes').hidden = i.value !== 'yes'; $('#lodge-no').hidden = i.value !== 'no'; }));
    $$('[name=buddyOpt]', form).forEach((i) => i.addEventListener('change', () => { $('#buddy-yes').hidden = i.value !== 'yes'; }));
    ['arrival', 'departure'].forEach((n) => form.elements[n] && form.elements[n].addEventListener('change', () => { collect(); draw(); }));
  }

  $('#back').addEventListener('click', () => { collect(); st.step = Math.max(0, st.step - 1); draw(); window.scrollTo(0, 0); });

  let submitting = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    collect();
    const errs = check();
    if (Object.keys(errs).length) return showErrors(form, { message: 'Please check the highlighted fields.', fields: errs });
    if (st.step < 3) { st.step++; draw(); window.scrollTo(0, 0); return; }
    if (submitting) return;
    submitting = true;
    $('#next').disabled = true;
    $('#next').textContent = 'Submitting…';
    const input = {
      clientRequestId: st.clientRequestId,
      category: d.category, fullName: d.fullName, mobile: d.mobile, email: d.email, emergencyName: d.emergencyName, emergencyMobile: d.emergencyMobile,
      distance: d.distance, employer: d.employer, inviteCode: d.inviteCode, organiserVerified: d.organiserVerified,
      termsAccepted: d.termsAccepted, privacyAck: d.privacyAck, shirtSize: d.shirtSize, socks: d.socks,
    };
    if (CATEGORIES[d.category].adultOptions) Object.assign(input, { lodge: d.lodge, transportAck: d.transportAck, buddy: d.buddy });
    if (CATEGORIES[d.category].kitOptions) Object.assign(input, { kit: d.kit });
    if (d.category === 'community') Object.assign(input, { pickupAck: d.pickupAck, buddy: { optIn: d.communityBuddy } });
    try {
      const conf = await api.submitRegistration(input, { token: token || undefined });
      showConfirmation(el, conf, d);
    } catch (err) {
      submitting = false;
      $('#next').disabled = false;
      $('#next').textContent = 'Submit registration';
      const target = Math.min(...Object.keys(err.fields || {}).map((k) => FIELD_STEP[k] ?? 3), 3);
      if (Number.isFinite(target) && target !== st.step) { st.step = target; draw(); }
      showErrors(form, err);
    }
  });

  draw();
}

function showConfirmation(el, conf, d) {
  const heading = { confirmed: 'You’re in', reserved: 'Your place is reserved', waitlisted: 'You’re on the waitlist', draft: 'Entry received – awaiting verification' }[conf.status] || 'Registration received';
  el.innerHTML = `${pageHead('Entries', heading)}
    <section class="section"><div class="wrap narrow">
      ${conf.duplicateSubmission ? '<div class="notice"><p>We had already received this registration, so no duplicate entry was created.</p></div>' : ''}
      <div class="notice sun"><p><strong>Keep your reference number.</strong> You need it with your mobile number to view your entry, pay, or ask the organisers anything.${!d.email ? ' As you did not give an email address, please write it down or take a screenshot now.' : ''}</p></div>
      <div class="card">${confirmationHTML(conf)}</div>
      <p class="small muted" style="margin-top:16px">A confirmation ${d.email ? 'email and SMS have' : 'SMS has'} been queued. In this preview no email or SMS provider is connected, so nothing has actually been sent.</p>
      <div class="btn-row no-print"><a class="btn navy" href="#/my-entry/${encodeURIComponent(conf.ref)}">Go to My entry</a><button class="btn plain" onclick="window.print()">Print</button></div>
    </div></section>`;
  try { sessionStorage.setItem('rw-my', JSON.stringify({ ref: conf.ref, mobile: d.mobile })); } catch { /* ignore */ }
  window.scrollTo(0, 0);
}

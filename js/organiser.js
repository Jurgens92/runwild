import { api, esc, $, $$, toast, statusPill, sampleBadge, rand, formatDate, formatDateTime, tbc } from './ui.js';
import { CATEGORIES, DISTANCES, POOLS, SHIRT_SIZES, SOCK_SIZES, isReservationLive } from './core.js';
import { AuthError } from './backend.js';
import { scenarios } from '../tests/scenarios.js';

const TABS = [
  ['overview', 'Overview'], ['participants', 'Participants'], ['verify', 'Employee verification'], ['waitlist', 'Waitlist & cancelled'],
  ['payments', 'Payments'], ['shirts', 'Shirts & socks'], ['lodge', 'Canvas Lodge'], ['water', 'Water points'], ['donations', 'Donations & kit'],
  ['buddies', 'Run Buddy'], ['pickup', 'Pickup list'], ['messages', 'Messages'], ['audit', 'Audit trail'],
  ['settings', 'Settings'], ['checklist', 'Launch checklist'], ['tests', 'Verification tests'],
];

let token = null;
let tab = 'overview';

export async function renderOrganiser(el, [t]) {
  el.dataset.title = 'Organiser';
  token = sessionStorage.getItem('rw-org-token');
  if (t && TABS.some(([k]) => k === t)) tab = t;
  if (!token) return loginView(el);
  let data;
  try { data = await api.dashboard(token); } catch (e) {
    if (e instanceof AuthError) { sessionStorage.removeItem('rw-org-token'); return loginView(el); }
    throw e;
  }
  draw(el, data);
}

function loginView(el) {
  el.innerHTML = `<section class="page-head"><div class="wrap"><span class="eyebrow">Private</span><h1>Organiser sign-in</h1></div></section>
  <section class="section"><div class="wrap" style="max-width:440px">
    <form class="card" id="login" novalidate>
      <div class="field"><label for="le">Email</label><input id="le" name="email" type="email" autocomplete="username"></div>
      <div class="field"><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password"></div>
      <div class="notice bad" id="lerr" hidden></div>
      <button class="btn navy" type="submit">Sign in</button>
    </form>
    <div class="notice warn" style="margin-top:16px"><p><strong>Preview sign-in:</strong> organiser@preview.local / runwild-preview. In this static preview the check runs in the browser. At launch, sign-in and every organiser permission are enforced by the server (see README).</p></div>
  </div></section>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const s = await api.login($('#le').value, $('#lp').value);
      sessionStorage.setItem('rw-org-token', s.token);
      renderOrganiser(el, []);
    } catch (err) { $('#lerr').hidden = false; $('#lerr').textContent = err.message; }
  });
}

async function act(action, args, msg = 'Saved') {
  try { await api.organiserAction(token, action, args); toast(msg); refresh(); } catch (e) { toast(e.message, true); }
}
function refresh() { renderOrganiser($('#app'), [tab]); }

function draw(el, D) {
  const pending = D.registrations.filter((r) => r.verification === 'pending' && r.status === 'draft').length;
  const attention = [...D.registrations, ...D.lodgeRequests, ...D.sponsorships].filter((r) => r.attention).length;
  el.innerHTML = `<div class="org-shell">
    <nav class="org-side" aria-label="Dashboard sections">
      ${TABS.map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${v}${k === 'verify' && pending ? `<span class="count">${pending}</span>` : ''}${k === 'overview' && attention ? `<span class="count">${attention}</span>` : ''}</button>`).join('')}
      <hr class="rule" style="margin:12px 0">
      <button id="signout">Sign out</button>
    </nav>
    <div class="org-main" id="org-main"></div>
  </div>`;
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; history.replaceState(null, '', '#/organiser/' + tab); refresh(); }));
  $('#signout').addEventListener('click', async () => { await api.logout(token); sessionStorage.removeItem('rw-org-token'); location.hash = '#/'; });
  const main = $('#org-main');
  VIEWS[tab](main, D);
}

// ---------- helpers ----------

const regById = (D, id) => D.registrations.find((r) => r.id === id);
const chargesFor = (D, ownerId) => D.chargeViews.filter((c) => c.ownerId === ownerId);
const entryCharge = (D, r) => D.chargeViews.find((c) => c.ownerId === r.id && c.kind === 'entry');
const catLabel = (k) => CATEGORIES[k].label;

function table(head, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return `<p class="muted">${empty}</p>`;
  return `<div class="table-wrap"><table class="data"><thead><tr>${head.map((h) => `<th${h.startsWith('#') ? ' class="num"' : ''}>${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function csvDownload(name, header, rows) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const blob = new Blob(['﻿' + [header, ...rows].map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function regStatus(D, r) {
  let s = statusPill(r.status);
  if (r.status === 'reserved' && r.expiresAt) s += `<br><span class="small muted">until ${formatDateTime(r.expiresAt)}</span>`;
  if (r.holdReason === 'fee_unconfirmed') s += '<br><span class="small muted">held – fee unconfirmed</span>';
  if (r.status === 'cancelled' && r.cancelReason) s += `<br><span class="small muted">${esc(r.cancelReason === 'reservation_expired' ? 'reservation expired' : r.cancelReason)}</span>`;
  if (r.attention) s += `<br><span class="attention">${esc(r.attention)}</span>`;
  return s;
}

function dialog(html, onReady) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="dlg">${html}</div>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  if (onReady) onReady(d);
  return d;
}

function participantDialog(D, r) {
  const k = r.kit;
  const lr = r.lodge && r.lodge.requestId ? D.lodgeRequests.find((l) => l.id === r.lodge.requestId) : null;
  dialog(`<h3>${esc(r.fullName)} ${sampleBadge(r)}</h3>
    <table class="summary small"><tbody>
      <tr><th>Reference</th><td class="ref">${esc(r.ref)}</td></tr>
      <tr><th>Status</th><td>${regStatus(D, r)}</td></tr>
      <tr><th>Category</th><td>${esc(catLabel(r.category))} ${r.verification !== 'n/a' ? '· ' + statusPill(r.verification) : ''} ${r.verifiedBy ? '<span class="small muted">by ' + esc(r.verifiedBy) + '</span>' : ''}</td></tr>
      <tr><th>Distance</th><td>${esc(DISTANCES[r.distance])}</td></tr>
      <tr><th>RunWild shirt</th><td>${esc(r.shirtSize || '—')}</td></tr>
      <tr><th>Socks</th><td>${r.socks ? r.socks.qty + ' × ' + esc(r.socks.size) : 'None'}</td></tr>
      <tr><th>Mobile / email</th><td>${esc(r.mobile)}<br>${esc(r.email || '—')}</td></tr>
      <tr><th>Emergency contact</th><td>${esc(r.emergencyName)} · ${esc(r.emergencyMobile)}</td></tr>
      ${r.employer ? `<tr><th>Employer</th><td>${esc(r.employer)}</td></tr>` : ''}
      ${k ? `<tr><th>Kit sizes</th><td>${k.shoeSize ? 'Shoe ' + esc(k.shoeSize) + ' ' + esc(k.shoeSystem) + ', ' : ''}${k.shortsSize ? 'shorts ' + esc(k.shortsSize) : ''}<br>Needs: ${[k.needsShoes && 'shoes', k.needsKit && 'kit'].filter(Boolean).join(', ') || 'none'}</td></tr>` : ''}
      ${r.category === 'community' ? `<tr><th>Pickup acknowledged</th><td>${r.pickupAck ? 'Yes' : 'No'}</td></tr>` : ''}
      ${CATEGORIES[r.category].adultOptions ? `<tr><th>Lodge</th><td>${lr ? statusPill(lr.status) + ' ' + formatDate(lr.arrival) + ' – ' + formatDate(lr.departure) : r.transportAck ? 'No – transport acknowledged' : 'No'}</td></tr>` : ''}
      <tr><th>Run Buddy</th><td>${r.buddy && r.buddy.optIn ? statusPill(r.buddy.status) : 'No'}</td></tr>
      <tr><th>Registered</th><td>${formatDateTime(r.createdAt)}${r.assisted ? ' · organiser-assisted by ' + esc(r.assistedBy) : ''}</td></tr>
      <tr><th>Terms version</th><td>${esc(r.termsVersion)}</td></tr>
    </tbody></table>
    ${chargesFor(D, r.id).concat(lr ? chargesFor(D, lr.id) : []).map((c) => `<p class="small">${esc(c.label)}: ${rand(c.amount)} · paid ${rand(c.paid)} · <strong>outstanding ${rand(c.outstanding)}</strong> <span class="ref">${esc(c.ref)}</span></p>`).join('')}
    <div class="btn-row" style="margin-top:12px"><button class="btn small plain" value="close" onclick="this.closest('dialog').close()">Close</button></div>`);
}

function eftDialog(c) {
  dialog(`<h3>Record EFT received</h3>
    <p class="small">${esc(c.label)} · ref <span class="ref">${esc(c.ref)}</span> · outstanding ${rand(c.outstanding)}</p>
    <p class="small muted">Record only money you can see on ERP's bank statement. Proof-of-payment documents do not count.</p>
    <form method="dialog" id="eft"><div class="field"><label>Amount received (R)</label><input name="amount" type="number" step="0.01" value="${c.outstanding / 100}"></div>
    <div class="field"><label>Bank statement reference</label><input name="bankRef" type="text"></div>
    <div class="btn-row"><button class="btn small" value="ok">Record payment</button><button class="btn small plain" value="cancel" formnovalidate>Cancel</button></div></form>`, (d) => {
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return;
      const f = $('#eft', d);
      act('recordEft', { chargeId: c.id, amount: f.amount.value, bankRef: f.bankRef.value.trim() }, 'Payment recorded');
    });
  });
}

// ---------- views ----------

const VIEWS = {
  overview(m, D) {
    const u = D.usage;
    const regs = D.registrations;
    const active = regs.filter((r) => r.status !== 'cancelled');
    const mel = active.filter((r) => r.category === 'melorane_employee');
    const byCat = Object.keys(CATEGORIES).map((c) => {
      const rs = regs.filter((r) => r.category === c);
      const n = (dist, st) => rs.filter((r) => r.distance === dist && st.includes(r.status)).length;
      return `<tr><td>${esc(catLabel(c))}</td>${['21k', '5k'].map((dd) => `<td class="num">${n(dd, ['confirmed'])}</td><td class="num">${n(dd, ['reserved'])}</td>`).join('')}<td class="num">${rs.filter((r) => r.status === 'waitlisted').length}</td><td class="num">${rs.filter((r) => r.status === 'draft').length}</td></tr>`;
    });
    const sum = (kinds) => D.chargeViews.filter((c) => kinds.includes(c.kind)).reduce((a, c) => ({ due: a.due + c.amount, paid: a.paid + c.paid, out: a.out + c.outstanding }), { due: 0, paid: 0, out: 0 });
    const money = [['Entry fees', ['entry']], ['Sock add-ons', ['socks']], ['Lodge deposits', ['lodge_deposit']], ['Lodge balances', ['lodge_balance']], ['Water point sponsorships', ['sponsorship']], ['Financial donations', ['donation']]]
      .map(([l, k]) => { const s = sum(k); return `<tr><td>${l}</td><td class="num">${rand(s.due)}</td><td class="num">${rand(s.paid)}</td><td class="num">${rand(s.out)}</td></tr>`; });
    const att = [
      ...regs.filter((r) => r.attention).map((r) => ['registration', r.id, r.ref, r.attention]),
      ...D.lodgeRequests.filter((r) => r.attention).map((r) => ['lodge', r.id, (regById(D, r.registrationId) || {}).ref, r.attention]),
      ...D.sponsorships.filter((r) => r.attention).map((r) => ['sponsorship', r.id, r.ref, r.attention]),
    ];
    m.innerHTML = `<h2>Overview</h2>
      <p class="small muted">Signed in as ${esc(D.me.email)} · ${formatDateTime(D.now)} SAST</p>
      <div class="kpis">
        <div class="kpi"><span class="label">${esc(POOLS.combined.label)}</span><div class="stat">${u.combined.used} / ${u.combined.limit}</div><div class="small">${u.combined.remaining} remaining · ${u.combined.confirmed} confirmed, ${u.combined.reserved} reserved</div></div>
        <div class="kpi"><span class="label">Community members</span><div class="stat">${u.community.used} / ${u.community.limit}</div><div class="small">${u.community.remaining} remaining · ${u.community.confirmed} confirmed, ${u.community.reserved} reserved</div></div>
        <div class="kpi"><span class="label">Melorane employees</span><div class="stat">${mel.length}</div><div class="small">unlimited · outside both pools</div></div>
        <div class="kpi"><span class="label">Waitlisted</span><div class="stat">${u.combined.waitlisted + u.community.waitlisted}</div><div class="small">${u.combined.waitlisted} combined · ${u.community.waitlisted} community</div></div>
        <div class="kpi"><span class="label">Awaiting verification</span><div class="stat">${regs.filter((r) => r.status === 'draft').length}</div><div class="small">employee entries, no place held</div></div>
      </div>
      ${att.length ? `<h3>Needs attention</h3>${table(['Record', 'Issue', ''], att.map(([k, id, ref, msg]) => `<tr><td class="ref">${esc(ref || '')}</td><td>${esc(msg)}</td><td><button class="btn small plain" data-clear="${k}|${id}">Mark resolved</button></td></tr>`))}` : ''}
      <h3>Participants by category and distance</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Category</th><th class="num">21 km confirmed</th><th class="num">21 km reserved</th><th class="num">5 km confirmed</th><th class="num">5 km reserved</th><th class="num">Waitlisted</th><th class="num">Awaiting verification</th></tr></thead><tbody>${byCat.join('')}</tbody></table></div>
      <h3>Money (tracked separately)</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Stream</th><th class="num">Billed</th><th class="num">Received</th><th class="num">Outstanding</th></tr></thead><tbody>${money.join('')}</tbody></table></div>
      <p class="small muted">Billed amounts exclude waitlisted entries and entries whose fee is not yet confirmed.</p>`;
    $$('[data-clear]', m).forEach((b) => b.addEventListener('click', () => { const [kind, id] = b.dataset.clear.split('|'); const note = prompt('Resolution note'); if (note !== null) act('clearAttention', { kind, id, note }); }));
  },

  participants(m, D) {
    m.innerHTML = `<div class="toolbar"><h2 style="margin:0">Participants</h2>
      <div class="filters">
        <input id="q" type="search" placeholder="Search name, ref, mobile">
        <select id="fc"><option value="">All categories</option>${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <select id="fd"><option value="">Both distances</option>${Object.entries(DISTANCES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <select id="fs"><option value="">All statuses</option>${['confirmed', 'reserved', 'waitlisted', 'draft', 'cancelled'].map((s) => `<option>${s}</option>`).join('')}</select>
        <a class="btn small plain" href="#/register">+ Assisted registration</a>
        <button class="btn small" id="csv">CSV</button>
      </div></div><div id="list"></div>`;
    const render = () => {
      const q = $('#q').value.toLowerCase();
      const rs = D.registrations.filter((r) => (!$('#fc').value || r.category === $('#fc').value) && (!$('#fd').value || r.distance === $('#fd').value) && (!$('#fs').value || r.status === $('#fs').value)
        && (!q || (r.fullName + r.ref + r.mobile).toLowerCase().includes(q)));
      $('#list').innerHTML = `<p class="small muted">${rs.length} shown</p>` + table(['Ref', 'Name', 'Category', 'Distance', 'Status', '#Entry outstanding', ''], rs.map((r) => {
        const ch = entryCharge(D, r);
        return `<tr><td class="ref">${esc(r.ref)}</td><td>${esc(r.fullName)}${sampleBadge(r)}</td><td>${esc(catLabel(r.category))}</td><td>${r.distance === '21k' ? '21 km' : '5 km'}</td><td>${regStatus(D, r)}</td>
          <td class="num">${ch ? rand(ch.outstanding) : r.holdReason === 'fee_unconfirmed' ? tbc('Fee TBC') : '—'}</td>
          <td><div class="btn-row"><button class="btn small plain" data-view="${r.id}">View</button>${r.status === 'waitlisted' ? `<button class="btn small" data-offer="${r.id}">Offer place</button>` : ''}${r.status !== 'cancelled' ? `<button class="btn small danger" data-cancel="${r.id}">Cancel</button>` : ''}</div></td></tr>`;
      }));
      $$('[data-view]').forEach((b) => b.addEventListener('click', () => participantDialog(D, regById(D, b.dataset.view))));
      $$('[data-offer]').forEach((b) => b.addEventListener('click', () => act('offerPlace', { regId: b.dataset.offer }, 'Place offered')));
      $$('[data-cancel]').forEach((b) => b.addEventListener('click', () => { const reason = prompt('Reason for cancelling'); if (reason) act('cancelRegistration', { regId: b.dataset.cancel, reason }, 'Entry cancelled'); }));
    };
    ['q', 'fc', 'fd', 'fs'].forEach((id) => $('#' + id).addEventListener('input', render));
    $('#csv').addEventListener('click', () => csvDownload('participants', ['Reference', 'Name', 'Category', 'Distance', 'Status', 'Verification', 'Mobile', 'Email', 'Emergency name', 'Emergency number', 'Employer', 'Shirt size', 'Socks pairs', 'Sock size', 'Needs shoes', 'Needs kit', 'Shoe size', 'Shorts size', 'Entry billed', 'Entry paid', 'Entry outstanding', 'Registered', 'Assisted', 'Sample'],
      D.registrations.map((r) => { const c = entryCharge(D, r); const k = r.kit || {}; return [r.ref, r.fullName, catLabel(r.category), DISTANCES[r.distance], r.status, r.verification, r.mobile, r.email, r.emergencyName, r.emergencyMobile, r.employer, r.shirtSize || '', r.socks ? r.socks.qty : '', r.socks ? r.socks.size : '', k.needsShoes ? 'yes' : '', k.needsKit ? 'yes' : '', k.needsShoes ? (k.shoeSize + ' ' + k.shoeSystem) : '', k.needsKit ? k.shortsSize : '', c ? c.amount / 100 : '', c ? c.paid / 100 : '', c ? c.outstanding / 100 : '', formatDateTime(r.createdAt), r.assisted ? 'yes' : '', r.sample ? 'yes' : '']; })));
    render();
  },

  verify(m, D) {
    const rs = D.registrations.filter((r) => r.verification === 'pending' && r.status === 'draft');
    const recent = D.registrations.filter((r) => r.category.endsWith('employee') && r.verification !== 'pending').slice(-10).reverse();
    m.innerHTML = `<h2>Employee verification</h2>
      <p class="muted">Employee entries without a valid invitation code wait here. They hold no place and nothing is payable until verified. Approving allocates a place (or waitlists if the pool is full).</p>
      ${table(['Ref', 'Name', 'Category', 'Employer', 'Code given', 'Registered', ''], rs.map((r) => `<tr><td class="ref">${esc(r.ref)}</td><td>${esc(r.fullName)}</td><td>${esc(catLabel(r.category))}</td><td>${esc(r.employer)}</td><td>${esc(r.inviteCodeTried || '—')}</td><td>${formatDateTime(r.createdAt)}</td>
        <td><div class="btn-row"><button class="btn small" data-ok="${r.id}">Verify</button><button class="btn small plain" data-other="${r.id}">Move to “Other”</button><button class="btn small danger" data-no="${r.id}">Decline</button></div></td></tr>`), 'No entries are waiting for verification.')}
      <h3>Recently verified</h3>
      ${table(['Ref', 'Name', 'Category', 'Verification', 'By'], recent.map((r) => `<tr><td class="ref">${esc(r.ref)}</td><td>${esc(r.fullName)}${sampleBadge(r)}</td><td>${esc(catLabel(r.category))}</td><td>${statusPill(r.verification)}</td><td>${esc(r.verifiedBy || '')}</td></tr>`))}
      <h3>Invitation codes</h3>
      ${table(['Code', 'Category', '#Used', '#Limit'], D.settings.inviteCodes.map((c) => `<tr><td class="ref">${esc(c.code)}</td><td>${esc(catLabel(c.category))}</td><td class="num">${c.uses}</td><td class="num">${c.maxUses === null || c.maxUses === undefined ? 'Unlimited' : c.maxUses}</td></tr>`))}
      <p class="small muted">Edit codes under Settings.</p>`;
    $$('[data-ok]', m).forEach((b) => b.addEventListener('click', () => act('verifyEmployee', { regId: b.dataset.ok, approve: true }, 'Verified')));
    $$('[data-other]', m).forEach((b) => b.addEventListener('click', () => act('verifyEmployee', { regId: b.dataset.other, reassignTo: 'other' }, 'Moved to Other participants')));
    $$('[data-no]', m).forEach((b) => b.addEventListener('click', () => confirm('Decline and cancel this entry?') && act('verifyEmployee', { regId: b.dataset.no, approve: false }, 'Declined')));
  },

  waitlist(m, D) {
    const u = D.usage;
    const wl = D.registrations.filter((r) => r.status === 'waitlisted').sort((a, b) => a.createdAt - b.createdAt);
    const cx = D.registrations.filter((r) => r.status === 'cancelled').sort((a, b) => (b.cancelledAt || 0) - (a.cancelledAt || 0));
    m.innerHTML = `<h2>Waitlist</h2>
      <p class="muted">Released places are never filled automatically. Offer a place below when one is free – the person then gets a reservation and a normal payment window.</p>
      <p class="small">Free now: combined pool <strong>${u.combined.remaining}</strong> · community pool <strong>${u.community.remaining}</strong></p>
      ${table(['#', 'Ref', 'Name', 'Category', 'Distance', 'Joined', ''], wl.map((r, i) => {
        const free = u[CATEGORIES[r.category].pool].remaining > 0;
        return `<tr><td>${i + 1}</td><td class="ref">${esc(r.ref)}</td><td>${esc(r.fullName)}</td><td>${esc(catLabel(r.category))}</td><td>${DISTANCES[r.distance]}</td><td>${formatDateTime(r.createdAt)}</td><td>${free ? `<button class="btn small" data-offer="${r.id}">Offer place</button>` : '<span class="small muted">Pool full</span>'}</td></tr>`;
      }), 'Nobody is on the waitlist.')}
      <h2 style="margin-top:28px">Cancelled entries</h2>
      ${table(['Ref', 'Name', 'Category', 'Reason', 'When'], cx.map((r) => `<tr><td class="ref">${esc(r.ref)}</td><td>${esc(r.fullName)}${sampleBadge(r)}</td><td>${esc(catLabel(r.category))}</td><td>${esc(r.cancelReason === 'reservation_expired' ? 'Reservation expired (unpaid)' : r.cancelReason || '')}${r.attention ? `<br><span class="attention">${esc(r.attention)}</span>` : ''}</td><td>${r.cancelledAt ? formatDateTime(r.cancelledAt) : '—'}</td></tr>`))}`;
    $$('[data-offer]', m).forEach((b) => b.addEventListener('click', () => act('offerPlace', { regId: b.dataset.offer }, 'Place offered')));
  },

  payments(m, D) {
    const owner = (c) => {
      if (c.ownerType === 'registration') { const r = regById(D, c.ownerId); return r ? r.fullName : ''; }
      if (c.ownerType === 'lodge') { const l = D.lodgeRequests.find((x) => x.id === c.ownerId); const r = l && regById(D, l.registrationId); return r ? r.fullName : ''; }
      if (c.ownerType === 'sponsorship') { const s = D.sponsorships.find((x) => x.id === c.ownerId); return s ? s.name : ''; }
      const k = D.contributions.find((x) => x.id === c.ownerId); return k ? k.donor : '';
    };
    m.innerHTML = `<div class="toolbar"><h2 style="margin:0">Payments & reconciliation</h2><div class="filters">
      <select id="fk"><option value="">All streams</option><option value="entry">Entry fees</option><option value="socks">Sock add-ons</option><option value="lodge_deposit">Lodge deposits</option><option value="lodge_balance">Lodge balances</option><option value="sponsorship">Sponsorships</option><option value="donation">Donations</option></select>
      <label class="check small"><input type="checkbox" id="fo" checked> Outstanding only</label>
      <button class="btn small" id="csv">CSV</button></div></div>
      <p class="small muted">Payments are marked received only by a verified provider notification or by recording an EFT you can see on the bank statement here.</p>
      <div id="list"></div><h3>Payment log</h3><div id="log"></div>`;
    const render = () => {
      const cs = D.chargeViews.filter((c) => (!$('#fk').value || c.kind === $('#fk').value) && (!$('#fo').checked || c.outstanding > 0));
      $('#list').innerHTML = table(['Ref', 'For', 'Item', '#Billed', '#Paid', '#Outstanding', 'Due', ''], cs.map((c) => `<tr><td class="ref">${esc(c.ref)}</td><td>${esc(owner(c))}${sampleBadge(c)}</td><td>${esc(c.label)}</td><td class="num">${rand(c.amount)}</td><td class="num">${rand(c.paid)}</td><td class="num"><strong>${rand(c.outstanding)}</strong></td><td>${c.dueDate ? formatDate(c.dueDate) : ''}</td>
        <td>${c.outstanding > 0 ? `<button class="btn small plain" data-eft="${c.id}">Record EFT</button>` : statusPill('paid', 'Paid')}</td></tr>`), 'No matching charges.');
      $$('[data-eft]').forEach((b) => b.addEventListener('click', () => eftDialog(D.chargeViews.find((c) => c.id === b.dataset.eft))));
    };
    $('#fk').addEventListener('change', render);
    $('#fo').addEventListener('change', render);
    render();
    const pays = [...D.payments].sort((a, b) => b.at - a.at);
    $('#log').innerHTML = table(['When', 'Ref', '#Amount', 'Method', 'Detail'], pays.map((p) => { const c = D.chargeViews.find((x) => x.id === p.chargeId) || {}; return `<tr><td>${formatDateTime(p.at)}</td><td class="ref">${esc(c.ref || '')}</td><td class="num">${rand(p.amount)}</td><td>${p.method === 'eft' ? 'EFT' : 'Provider'}${sampleBadge(p)}</td><td class="small">${esc(p.bankRef || p.providerEventId || '')}${p.recordedBy ? ' · by ' + esc(p.recordedBy) : ''}${p.flag ? `<br><span class="attention">${esc(p.flag)}</span>` : ''}</td></tr>`; }));
    $('#csv').addEventListener('click', () => csvDownload('payments', ['Reference', 'For', 'Stream', 'Item', 'Billed', 'Paid', 'Outstanding', 'Due date'], D.chargeViews.map((c) => [c.ref, owner(c), c.kind, c.label, c.amount / 100, c.paid / 100, c.outstanding / 100, c.dueDate || ''])));
  },

  lodge(m, D) {
    const L = D.settings.lodge;
    m.innerHTML = `<div class="toolbar"><h2 style="margin:0">Canvas Lodge</h2><button class="btn small" id="csv">CSV</button></div>
      ${L.inventoryConfirmed ? '' : '<div class="notice warn"><p>Lodge inventory and dates are <strong>sample values</strong>. Set the real ones under Settings.</p></div>'}
      <h3>Inventory by night</h3>
      ${table(['Night of', '#Beds', '#Held or booked', '#Free'], D.lodgeNights.map((n) => `<tr><td>${formatDate(n.date)}</td><td class="num">${n.beds}</td><td class="num">${n.used}</td><td class="num">${n.beds - n.used}</td></tr>`))}
      <h3>Requests</h3>
      ${table(['Guest', 'Stay', 'Status', '#Total', '#Deposit paid', '#Balance outstanding', ''], D.lodgeRequests.map((l) => {
        const r = regById(D, l.registrationId) || {};
        const dep = D.chargeViews.find((c) => c.ownerId === l.id && c.kind === 'lodge_deposit');
        const bal = D.chargeViews.find((c) => c.ownerId === l.id && c.kind === 'lodge_balance');
        return `<tr><td>${esc(r.fullName || '')}${sampleBadge(l)}<br><span class="ref small">${esc(r.ref || '')}</span></td><td>${formatDate(l.arrival)} – ${formatDate(l.departure)}<br><span class="small muted">${l.nights} night(s)</span></td>
          <td>${statusPill(l.status)}${l.expiresAt && l.status === 'awaiting_deposit' ? `<br><span class="small muted">hold until ${formatDateTime(l.expiresAt)}</span>` : ''}${l.note ? `<br><span class="small muted">${esc(l.note)}</span>` : ''}${l.attention ? `<br><span class="attention">${esc(l.attention)}</span>` : ''}${l.balanceNote ? `<br><span class="small">${esc(l.balanceNote)}</span>` : ''}</td>
          <td class="num">${rand(l.total)}</td><td class="num">${dep ? rand(dep.paid) + ' / ' + rand(dep.amount) : '—'}</td><td class="num">${bal ? rand(bal.outstanding) : rand(l.balance)}</td>
          <td><div class="btn-row">${l.status === 'requested' ? `<button class="btn small" data-l="hold|${l.id}">Hold beds</button><button class="btn small danger" data-l="decline|${l.id}">Decline</button>` : ''}${['awaiting_deposit', 'confirmed', 'paid_in_full'].includes(l.status) ? `<button class="btn small danger" data-l="cancel|${l.id}">Cancel</button>` : ''}</div></td></tr>`;
      }), 'No accommodation requests yet.')}`;
    $$('[data-l]', m).forEach((b) => b.addEventListener('click', () => { const [op, id] = b.dataset.l.split('|'); if (op !== 'hold' && !confirm('Are you sure?')) return; act('lodge', { op, id }); }));
    $('#csv').addEventListener('click', () => csvDownload('canvas-lodge', ['Reference', 'Guest', 'Arrival', 'Departure', 'Nights', 'Status', 'Total', 'Deposit', 'Deposit paid', 'Balance', 'Balance paid', 'Balance due'], D.lodgeRequests.map((l) => {
      const r = regById(D, l.registrationId) || {};
      const dep = D.chargeViews.find((c) => c.ownerId === l.id && c.kind === 'lodge_deposit') || {};
      const bal = D.chargeViews.find((c) => c.ownerId === l.id && c.kind === 'lodge_balance') || {};
      return [r.ref, r.fullName, l.arrival, l.departure, l.nights, l.status, l.total / 100, l.deposit / 100, (dep.paid || 0) / 100, l.balance / 100, (bal.paid || 0) / 100, l.balanceDue || 'TBC'];
    })));
  },

  water(m, D) {
    m.innerHTML = `<div class="toolbar"><h2 style="margin:0">Water point sponsorships</h2><button class="btn small" id="csv">CSV</button></div>
      ${table(['Point', 'Status', 'Sponsor', 'Contact', 'Display consent', '#Paid', ''], D.waterPointStatus.map((w) => {
        const sp = w.sponsorshipId && D.sponsorships.find((x) => x.id === w.sponsorshipId);
        const ch = sp && D.chargeViews.find((c) => c.ownerId === sp.id);
        return `<tr><td><strong>Water Point ${w.point}</strong></td><td>${statusPill(w.status)}${sp && sp.expiresAt ? `<br><span class="small muted">hold until ${formatDateTime(sp.expiresAt)}</span>` : ''}</td>
          <td>${sp ? esc(sp.name) + sampleBadge(sp) + `<br><span class="ref small">${esc(sp.ref)}</span>` : '—'}${sp && sp.logo ? `<img src="${esc(sp.logo)}" alt="" style="max-height:32px;margin-top:4px">` : ''}</td>
          <td class="small">${sp ? esc(sp.contactPerson) + '<br>' + esc(sp.email) + '<br>' + esc(sp.phone) : ''}</td><td>${sp ? (sp.displayConsent ? 'Yes' : 'No') : ''}</td>
          <td class="num">${ch ? rand(ch.paid) + ' / ' + rand(ch.amount) : ''}</td><td>${sp ? `<button class="btn small danger" data-cx="${sp.id}">Cancel</button>` : ''}</td></tr>`;
      }))}
      <h3>All sponsorship records</h3>
      ${table(['Ref', 'Point', 'Sponsor', 'Status', 'Created'], D.sponsorships.map((s) => `<tr><td class="ref">${esc(s.ref)}</td><td>${s.point}</td><td>${esc(s.name)}${sampleBadge(s)}${s.attention ? `<br><span class="attention">${esc(s.attention)}</span>` : ''}</td><td>${statusPill(s.status)}</td><td>${formatDateTime(s.createdAt)}</td></tr>`))}`;
    $$('[data-cx]', m).forEach((b) => b.addEventListener('click', () => confirm('Cancel this sponsorship and free the water point?') && act('cancelSponsorship', { id: b.dataset.cx })));
    $('#csv').addEventListener('click', () => csvDownload('water-points', ['Reference', 'Point', 'Sponsor', 'Contact', 'Email', 'Phone', 'Website', 'Billing', 'Display consent', 'Status'], D.sponsorships.map((s) => [s.ref, s.point, s.name, s.contactPerson, s.email, s.phone, s.website, s.billing, s.displayConsent ? 'yes' : 'no', s.status])));
  },

  shirts(m, D) {
    // Shirts are ordered for every entry that holds or may get a place (not cancelled).
    const active = D.registrations.filter((r) => r.status !== 'cancelled');
    const groups = [['Confirmed', (r) => r.status === 'confirmed'], ['Reserved', (r) => r.status === 'reserved'], ['Waitlisted or awaiting verification', (r) => r.status === 'waitlisted' || r.status === 'draft']];
    const shirtRows = [...SHIRT_SIZES, ''].map((sz) => {
      const rs = active.filter((r) => (r.shirtSize || '') === sz);
      if (!sz && !rs.length) return '';
      return `<tr><td><strong>${sz || 'Not given'}</strong></td>${groups.map(([, f]) => `<td class="num">${rs.filter(f).length}</td>`).join('')}<td class="num"><strong>${rs.length}</strong></td></tr>`;
    }).filter(Boolean);
    const sockOrders = active.filter((r) => r.socks && r.socks.qty);
    const sockRows = SOCK_SIZES.map((sz) => { const os = sockOrders.filter((r) => r.socks.size === sz); return `<tr><td>${esc(sz)}</td><td class="num">${os.length}</td><td class="num"><strong>${os.reduce((a, r) => a + r.socks.qty, 0)}</strong></td></tr>`; });
    const so = D.settings.socks;
    const unbilled = sockOrders.filter((r) => ['reserved', 'confirmed'].includes(r.status) && !D.chargeViews.some((c) => c.ownerId === r.id && c.kind === 'socks'));
    m.innerHTML = `<div class="toolbar"><h2 style="margin:0">Shirts & socks</h2><button class="btn small" id="csv">CSV</button></div>
      <p class="muted">Every entry includes a RunWild running shirt. Use these totals for the shirt order. Cancelled entries are excluded.</p>
      <h3>RunWild shirts by size</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Size</th>${groups.map(([l]) => `<th class="num">${l}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${shirtRows.join('')}</tbody></table></div>
      <h3>Sock add-on orders</h3>
      <p class="small">${so.confirmed && so.price ? 'Price ' + rand(so.price) + ' per pair.' : tbc('Price not confirmed') + ' Orders are recorded but nothing is payable yet. Set the price under Settings.'}</p>
      ${table(['Size', '#Orders', '#Pairs'], sockRows)}
      ${so.confirmed && so.price && unbilled.length ? `<div class="btn-row"><button class="btn small" id="issue-socks">Issue payment requests for ${unbilled.length} sock order${unbilled.length > 1 ? 's' : ''}</button></div>` : ''}`;
    $('#issue-socks', m)?.addEventListener('click', () => act('issueSockCharges', {}, 'Sock payment requests issued'));
    $('#csv').addEventListener('click', () => csvDownload('shirts-and-socks', ['Reference', 'Name', 'Category', 'Status', 'Shirt size', 'Socks pairs', 'Sock size'], active.map((r) => [r.ref, r.fullName, catLabel(r.category), r.status, r.shirtSize || '', r.socks ? r.socks.qty : '', r.socks ? r.socks.size : ''])));
  },

  donations(m, D) {
    const needy = D.registrations.filter((r) => CATEGORIES[r.category].kitOptions && r.status !== 'cancelled' && r.kit);
    const allocatedTo = (id, type) => D.stock.find((x) => x.allocatedTo === id && x.type === type);
    const shoeKey = (sz, sys) => sz + ' ' + sys;
    const needs = {};
    for (const r of needy) {
      if (r.kit.needsShoes) { const k = 'Shoes ' + shoeKey(r.kit.shoeSize, r.kit.shoeSystem); needs[k] = needs[k] || { req: 0, alloc: 0 }; needs[k].req++; if (allocatedTo(r.id, 'shoes')) needs[k].alloc++; }
      if (r.kit.needsKit) { const k = 'Kit shirt ' + r.kit.shirtSize + ' / shorts ' + r.kit.shortsSize; needs[k] = needs[k] || { req: 0, alloc: 0 }; needs[k].req++; if (allocatedTo(r.id, 'kit')) needs[k].alloc++; }
    }
    const inStock = (label) => D.stock.filter((s) => s.status === 'in_stock' && (s.type === 'shoes' ? 'Shoes ' + shoeKey(s.size, s.sizeSystem) : 'Kit shirt ' + s.shirtSize + ' / shorts ' + s.shortsSize) === label).length;
    const P = D.donationProgress;
    const per = D.settings.donations.perRunner;
    const chOf = (c) => D.chargeViews.find((x) => x.ownerId === c.id);
    m.innerHTML = `<div class="toolbar"><h2 style="margin:0">Donations & kit</h2><button class="btn small" id="csv">CSV</button></div>
      <p class="muted">Monetary donations only. ERP buys shoes and kit (budget ${rand(per)} per runner: ${esc(D.settings.donations.items.join(', ').toLowerCase())}), records each purchase as stock below, and allocates it to the participants who asked.</p>
      <div class="kpis">
        <div class="kpi"><span class="label">Raised (received)</span><div class="stat">${rand(P.raised)}</div><div class="small">${P.runnersFunded} runner${P.runnersFunded === 1 ? '' : 's'} funded at ${rand(per)}</div></div>
        <div class="kpi"><span class="label">Asked for kit</span><div class="stat">${P.runnersNeedingKit}</div><div class="small">community members and Melorane employees · budget needed ${rand(P.runnersNeedingKit * per)}</div></div>
        <div class="kpi"><span class="label">Shoes</span><div class="small">requested ${P.shoesRequested} · bought ${P.shoesInHand} · allocated ${P.shoesAllocated}</div></div>
        <div class="kpi"><span class="label">Kit sets</span><div class="small">requested ${P.kitRequested} · bought ${P.kitInHand} · allocated ${P.kitAllocated}</div></div>
      </div>
      <h3>Donations</h3>
      ${table(['Ref', 'Donor', 'For', '#Amount', '#Received', 'Status'], D.contributions.map((c) => { const ch = chOf(c); return `<tr><td class="ref">${esc(c.ref)}</td><td>${esc(c.donor)}${sampleBadge(c)}<br><span class="small">${esc(c.email || c.phone || '')}</span></td><td>${c.runners ? c.runners + ' runner' + (c.runners > 1 ? 's' : '') : 'General'}</td><td class="num">${rand(c.amount)}</td><td class="num">${ch ? rand(ch.paid) : '—'}</td><td>${statusPill(c.status)}</td></tr>`; }), 'No donations yet.')}
      <p class="small muted">Record EFT donations under Payments, using the donation reference.</p>
      <h3>Unmet needs by size</h3>
      ${table(['Item and size', '#Requested', '#Allocated', '#Unmet', '#Matching stock'], Object.entries(needs).sort().map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.req}</td><td class="num">${v.alloc}</td><td class="num"><strong>${v.req - v.alloc}</strong></td><td class="num">${inStock(k)}</td></tr>`), 'Nobody has asked for shoes or kit.')}
      <h3>Stock (bought by ERP)</h3>
      ${table(['Item', 'Purchase note', 'Status', 'Allocated to', ''], D.stock.map((s) => {
        const r = s.allocatedTo && regById(D, s.allocatedTo);
        const opts = needy.filter((c) => (s.type === 'shoes' ? c.kit.needsShoes : c.kit.needsKit) && !allocatedTo(c.id, s.type))
          .map((c) => `<option value="${c.id}">${esc(c.ref)} ${esc(c.fullName)} – ${s.type === 'shoes' ? esc(c.kit.shoeSize + ' ' + c.kit.shoeSystem) : esc(c.kit.shirtSize + '/' + c.kit.shortsSize)}</option>`).join('');
        return `<tr><td>${s.type === 'shoes' ? 'Shoes ' + esc(s.size + ' ' + s.sizeSystem) : 'Kit ' + esc(s.shirtSize + '/' + s.shortsSize)}${sampleBadge(s)}</td><td class="small">${esc(s.sourceId || '')}</td><td>${statusPill(s.status)}</td><td>${r ? esc(r.fullName) + ' <span class="ref small">' + esc(r.ref) + '</span>' : ''}</td>
          <td>${s.status === 'in_stock' ? `<div class="btn-row"><select data-sel="${s.id}" style="min-height:34px;padding:4px"><option value="">Allocate to…</option>${opts}</select><button class="btn small" data-alloc="${s.id}">Allocate</button></div>` : s.status === 'allocated' ? `<div class="btn-row"><button class="btn small" data-dlv="${s.id}">Mark delivered</button><button class="btn small plain" data-un="${s.id}">Unallocate</button></div>` : ''}</td></tr>`;
      }), 'Nothing bought yet. Record purchases below.')}
      <h3>Record a purchase</h3>
      <form id="buy" class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;align-items:end">
        <div><label>Item</label><select name="type"><option value="shoes">Shoes</option><option value="kit">Kit (shorts, socks, cap)</option></select></div>
        <div><label>Qty</label><input name="quantity" type="number" min="1" value="1"></div>
        <div><label>Shoe size</label><input name="size" type="text"></div>
        <div><label>System</label><select name="sizeSystem"><option>UK</option><option>EU</option><option>US</option></select></div>
        <div><label>Shirt</label><input name="shirtSize" type="text"></div>
        <div><label>Shorts</label><input name="shortsSize" type="text"></div>
        <div><label>Note / invoice</label><input name="note" type="text"></div>
        <button class="btn small" type="submit">Add to stock</button>
      </form>`;
    $$('[data-alloc]', m).forEach((b) => b.addEventListener('click', () => { const v = $(`[data-sel="${b.dataset.alloc}"]`, m).value; if (!v) return toast('Choose a participant', true); act('allocate', { stockId: b.dataset.alloc, regId: v }, 'Allocated'); }));
    $$('[data-dlv]', m).forEach((b) => b.addEventListener('click', () => act('deliver', { stockId: b.dataset.dlv }, 'Marked delivered')));
    $$('[data-un]', m).forEach((b) => b.addEventListener('click', () => act('unallocate', { stockId: b.dataset.un })));
    $('#buy').addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; act('recordPurchase', Object.fromEntries(new FormData(f)), 'Purchase recorded'); });
    $('#csv').addEventListener('click', () => csvDownload('donations-and-kit', ['Type', 'Reference / item', 'Who / source', 'Amount', 'Status', 'Allocated to (ref)'], [
      ...D.contributions.map((c) => ['donation', c.ref, c.donor, c.amount / 100, c.status, '']),
      ...D.stock.map((s) => ['stock', s.type + ' ' + (s.size ? s.size + ' ' + s.sizeSystem : s.shirtSize + '/' + s.shortsSize), s.sourceId || 'purchase', '', s.status, s.allocatedTo ? (regById(D, s.allocatedTo) || {}).ref : '']),
    ]));
  },

  buddies(m, D) {
    const vols = D.registrations.filter((r) => r.category !== 'community' && r.buddy && r.buddy.optIn && r.status !== 'cancelled');
    const comm = D.registrations.filter((r) => r.category === 'community' && r.buddy && r.buddy.optIn && r.status !== 'cancelled');
    const free = (r) => !D.matches.some((x) => x.status !== 'ended' && (x.volunteerId === r.id || x.communityId === r.id));
    m.innerHTML = `<h2>Community Run Buddy</h2>
      <p class="muted">Match by hand, ideally by distance and suitability. Contact details are shared with each person only after both have agreed.</p>
      <h3>Volunteers</h3>
      ${table(['Name', 'Distance', 'Experience', 'Availability', 'Contact via', 'Status', ''], vols.map((r) => `<tr><td>${esc(r.fullName)}${sampleBadge(r)}<br><span class="small">${esc(r.buddy.support || '')}</span></td><td>${esc(DISTANCES[r.buddy.preferredDistance || r.distance])}</td><td class="small">${esc(r.buddy.experience || '')}</td><td class="small">${esc(r.buddy.availability || '')}</td><td>${esc(r.buddy.contactMethod || '')}</td><td>${statusPill(r.buddy.status)}</td>
        <td>${r.buddy.status === 'volunteered' ? `<button class="btn small" data-st="awaiting_match|${r.id}">Approve</button>` : ''} <button class="btn small danger" data-st="withdrawn|${r.id}">Withdraw</button></td></tr>`), 'No volunteers yet.')}
      <h3>Community runners who want a buddy</h3>
      ${table(['Name', 'Distance', 'Status', ''], comm.map((r) => `<tr><td>${esc(r.fullName)}${sampleBadge(r)}</td><td>${esc(DISTANCES[r.distance])}</td><td>${statusPill(r.buddy.status)}</td><td><button class="btn small danger" data-st="withdrawn|${r.id}">Withdraw</button></td></tr>`), 'Nobody has asked yet.')}
      <h3>Propose a match</h3>
      <form id="pm" class="card" style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end">
        <div><label>Volunteer</label><select name="volunteerId"><option value="">Choose…</option>${vols.filter((r) => r.buddy.status === 'awaiting_match' && free(r)).map((r) => `<option value="${r.id}">${esc(r.fullName)} – ${r.buddy.preferredDistance === '5k' ? '5 km' : '21 km'}</option>`).join('')}</select></div>
        <div><label>Community runner</label><select name="communityId"><option value="">Choose…</option>${comm.filter((r) => free(r)).map((r) => `<option value="${r.id}">${esc(r.fullName)} – ${r.distance === '5k' ? '5 km' : '21 km'}</option>`).join('')}</select></div>
        <button class="btn small" type="submit">Propose</button>
      </form>
      <h3>Matches</h3>
      ${table(['Volunteer', 'Community runner', 'Volunteer agreed', 'Runner agreed', 'Status', ''], D.matches.map((x) => {
        const v = regById(D, x.volunteerId) || {}; const c = regById(D, x.communityId) || {};
        const yn = (val, side) => x.status === 'ended' ? (val ? 'Yes' : 'No') : val ? 'Yes' : `<button class="btn small plain" data-cs="${side}|${x.id}">Record agreement</button>`;
        return `<tr><td>${esc(v.fullName)}${sampleBadge(x)}</td><td>${esc(c.fullName)}</td><td>${yn(x.consentVolunteer, 'volunteer')}</td><td>${yn(x.consentCommunity, 'community')}</td><td>${statusPill(x.status)}</td><td>${x.status !== 'ended' ? `<button class="btn small danger" data-end="${x.id}">End</button>` : ''}</td></tr>`;
      }), 'No matches yet.')}
      <p class="small muted">Participants can agree themselves from “My entry”. Use “Record agreement” when someone without email agrees in person or by phone – it is logged in the audit trail.</p>`;
    $$('[data-st]', m).forEach((b) => b.addEventListener('click', () => { const [status, id] = b.dataset.st.split('|'); act('buddyStatus', { regId: id, status }); }));
    $$('[data-cs]', m).forEach((b) => b.addEventListener('click', () => { const [side, id] = b.dataset.cs.split('|'); act('recordConsent', { matchId: id, side, agree: true }); }));
    $$('[data-end]', m).forEach((b) => b.addEventListener('click', () => act('endMatch', { matchId: b.dataset.end })));
    $('#pm').addEventListener('submit', (e) => { e.preventDefault(); act('proposeMatch', Object.fromEntries(new FormData(e.target)), 'Match proposed'); });
  },

  pickup(m, D) {
    const rs = D.registrations.filter((r) => r.category === 'community' && ['confirmed', 'reserved'].includes(r.status) && (r.status === 'confirmed' || isReservationLive(r, D.now))).sort((a, b) => a.fullName.localeCompare(b.fullName));
    const ev = D.settings.event;
    m.innerHTML = `<div class="toolbar"><h2 style="margin:0">Community pickup list</h2><div class="btn-row"><button class="btn small plain" onclick="window.print()">Print</button><button class="btn small" id="csv">CSV</button></div></div>
      <p><strong>17 April 2027 · ${esc(ev.pickupTime)} · ${esc(ev.pickupPlace)}</strong> ${ev.pickupAddressConfirmed && ev.pickupFullAddress ? '· ' + esc(ev.pickupFullAddress) : tbc('Full address to be confirmed')}</p>
      ${table(['#', 'Name', 'Ref', 'Mobile', 'Emergency contact', 'Distance', 'Status', 'On bus'], rs.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.fullName)}${sampleBadge(r)}</td><td class="ref">${esc(r.ref)}</td><td>${esc(r.mobile)}</td><td>${esc(r.emergencyName)} · ${esc(r.emergencyMobile)}</td><td>${r.distance === '5k' ? '5 km' : '21 km'}</td><td>${statusPill(r.status)}</td><td>☐</td></tr>`), 'No community participants yet.')}`;
    $('#csv').addEventListener('click', () => csvDownload('pickup-list', ['Name', 'Reference', 'Mobile', 'Emergency name', 'Emergency number', 'Distance', 'Status'], rs.map((r) => [r.fullName, r.ref, r.mobile, r.emergencyName, r.emergencyMobile, DISTANCES[r.distance], r.status])));
  },

  messages(m, D) {
    const ms = [...D.outbox].sort((a, b) => b.at - a.at);
    m.innerHTML = `<h2>Messages</h2>
      <div class="notice warn"><p>No email or SMS provider is connected, so confirmations are recorded here but <strong>not sent</strong>. To send them, connect an email service (for example a transactional email provider) and an SMS gateway – see the README.</p></div>
      ${table(['When', 'Channel', 'To', 'Ref', 'Message', 'Status'], ms.map((x) => `<tr><td>${formatDateTime(x.at)}</td><td>${x.channel.toUpperCase()}</td><td>${esc(x.to)}</td><td class="ref">${esc(x.ref)}</td><td class="small" style="white-space:pre-line">${esc(x.subject ? x.subject + '\n' : '')}${esc(x.body)}</td><td>${statusPill('pending', 'Not sent')}<br><span class="small muted">${esc(x.reason)}</span></td></tr>`), 'No messages yet.')}`;
  },

  audit(m, D) {
    const rows = [...D.audit].sort((a, b) => b.at - a.at);
    m.innerHTML = `<div class="toolbar"><h2 style="margin:0">Audit trail</h2><button class="btn small" id="csv">CSV</button></div>
      ${table(['When', 'Who', 'Action', 'Record', 'Detail'], rows.slice(0, 400).map((a) => `<tr><td>${formatDateTime(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td class="ref">${esc(a.target)}</td><td class="small">${esc(a.details)}</td></tr>`))}`;
    $('#csv').addEventListener('click', () => csvDownload('audit', ['When', 'Who', 'Action', 'Record', 'Detail'], rows.map((a) => [new Date(a.at).toISOString(), a.actor, a.action, a.target, a.details])));
  },

  settings(m, D) { settingsView(m, D); },
  checklist(m, D) { checklistView(m, D); },
  tests(m) { testsView(m); },
};

// ---------- settings ----------

function settingsView(m, D) {
  const S = D.settings;
  const r = (c) => (c === null || c === undefined ? '' : c / 100);
  const chk = (name, val, label) => `<label class="check"><input type="checkbox" name="${name}" ${val ? 'checked' : ''}> ${label}</label>`;
  const respSel = (k) => `<div class="field"><label>${k[0].toUpperCase() + k.slice(1)}</label><select name="wp_${k}">${['tbc', 'organiser', 'sponsor'].map((v) => `<option value="${v}" ${S.waterPoints.responsibilities[k] === v ? 'selected' : ''}>${{ tbc: 'To be confirmed', organiser: 'Organiser', sponsor: 'Sponsor' }[v]}</option>`).join('')}</select></div>`;
  m.innerHTML = `<h2>Event settings</h2>
  <p class="muted">Every change is recorded in the audit trail. Items marked “confirmed” are shown to the public as final.</p>
  <form id="set" novalidate>
    <div class="card" style="margin-bottom:16px"><h3>Race day</h3>
      <div class="row2"><div class="field"><label>Exact start time</label><input name="startTime" type="text" value="${esc(S.event.startTime)}" placeholder="e.g. 06:00"></div><div class="field" style="align-self:end">${chk('startTimeConfirmed', S.event.startTimeConfirmed, 'Start time confirmed – publish it')}</div></div>
      <div class="row2"><div class="field"><label>Pickup place</label><input name="pickupPlace" type="text" value="${esc(S.event.pickupPlace)}"></div><div class="field"><label>Pickup time</label><input name="pickupTime" type="text" value="${esc(S.event.pickupTime)}"></div></div>
      <div class="row2"><div class="field"><label>Full pickup address in PJ</label><input name="pickupFullAddress" type="text" value="${esc(S.event.pickupFullAddress)}"></div><div class="field" style="align-self:end">${chk('pickupAddressConfirmed', S.event.pickupAddressConfirmed, 'Address confirmed – publish it')}</div></div>
      <div class="field"><label>Where proceeds go (shown on home page and form)</label><textarea name="proceedsText">${esc(S.event.proceedsText)}</textarea></div>
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Start, finish and route</h3>
      <p class="small muted">Shown publicly as “To be confirmed” until you tick the box below.</p>
      <div class="row2"><div class="field"><label>Start location</label><input name="startLocation" type="text" value="${esc(S.event.startLocation)}" placeholder="e.g. Main gate, Melorane ERP Game Reserve"></div>
        <div class="field"><label>Finish location</label><input name="finishLocation" type="text" value="${esc(S.event.finishLocation)}"></div></div>
      <div class="field"><label>Running route <span class="hint">A short description of each distance's route</span></label><textarea name="routeDescription">${esc(S.event.routeDescription)}</textarea></div>
      ${chk('routeConfirmed', S.event.routeConfirmed, 'Start, finish and route confirmed – publish them')}
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Shirts and socks</h3>
      <p class="small muted">Every entry includes a RunWild running shirt; participants choose a size when they register. Socks are an optional add-on, charged separately.</p>
      <div class="row3"><div class="field"><label>Sock price per pair (R)</label><input name="socksPrice" type="number" min="0" step="0.01" value="${r(S.socks.price)}"></div>
        <div class="field"><label>Max pairs per entry</label><input name="socksMax" type="number" min="1" value="${S.socks.maxPerEntry}"></div>
        <div class="field" style="align-self:end">${chk('socksConfirmed', S.socks.confirmed, 'Sock price confirmed')}</div></div>
      ${chk('socksEnabled', S.socks.enabled, 'Offer socks as an add-on')}
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Places and fees</h3>
      <div class="row3"><div class="field"><label>Group employees + other (shared)</label><input name="poolCombined" type="number" min="0" value="${S.pools.combined.limit}"></div>
        <div class="field"><label>Community members</label><input name="poolCommunity" type="number" min="0" value="${S.pools.community.limit}"></div>
        <div class="field"><label>Unpaid reservation expiry (hours)</label><input name="expiryHours" type="number" min="1" value="${S.reservation.expiryHours}"></div></div>
      ${Object.keys(CATEGORIES).map((c) => `<div class="row3"><div class="field"><label>${esc(catLabel(c))} fee (R)</label><input name="fee_${c}" type="number" min="0" step="0.01" value="${r(S.fees[c].amount)}"></div>
        <div class="field" style="align-self:end">${chk('feeok_' + c, S.fees[c].confirmed, 'Fee confirmed')}</div>
        <div class="field" style="align-self:end">${S.fees[c].confirmed && D.registrations.some((x) => x.category === c && x.holdReason === 'fee_unconfirmed' && x.status === 'reserved') ? `<button type="button" class="btn small plain" data-issue="${c}">Issue payment requests to held entries</button>` : ''}</div></div>`).join('')}
      ${chk('acceptWhileFeeUnconfirmed', S.acceptWhileFeeUnconfirmed, 'Accept registrations while a category fee is unconfirmed (holds a place, nothing payable). <strong>Preview only – switch off before launch.</strong>')}
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Canvas Lodge</h3>
      <div class="row3"><div class="field"><label>Rate per person per night (R)</label><input name="lodgeRate" type="number" value="${r(S.lodge.ratePerNight)}"></div>
        <div class="field"><label>Deposit %</label><input name="lodgeDeposit" type="number" min="0" max="100" value="${S.lodge.depositPercent}"></div>
        <div class="field"><label>Balance due date</label><input name="lodgeDue" type="date" value="${S.lodge.balanceDueDate}"></div></div>
      <div class="row3"><div class="field"><label>Minimum stay (nights)</label><input name="lodgeMin" type="number" min="1" value="${S.lodge.minNights}"></div></div>
      <div class="row2"><div class="field"><label>Open nights and beds <span class="hint">One per line: yyyy-mm-dd, beds</span></label><textarea name="lodgeNights">${S.lodge.nights.map((n) => n.date + ', ' + n.beds).join('\n')}</textarea></div>
        <div class="field"><label>Deposit hold period (hours)</label><input name="lodgeHold" type="number" min="1" value="${S.lodge.holdHours}">${chk('inventoryConfirmed', S.lodge.inventoryConfirmed, 'Dates and inventory confirmed (removes “sample” label)')}</div></div>
      <div class="row3"><div class="field"><label>Late-booking policy</label><select name="lateMode"><option value="">Not set</option><option value="full_on_booking" ${S.lodge.latePolicy.mode === 'full_on_booking' ? 'selected' : ''}>Full amount on booking</option><option value="days_after_booking" ${S.lodge.latePolicy.mode === 'days_after_booking' ? 'selected' : ''}>Balance due N days after booking</option></select></div>
        <div class="field"><label>N days</label><input name="lateDays" type="number" min="1" value="${S.lodge.latePolicy.days || 7}"></div>
        <div class="field" style="align-self:end">${chk('lateOk', S.lodge.latePolicy.confirmed, 'Late-booking policy confirmed')}</div></div>
      <div class="field"><label>Late-booking wording shown to guests</label><input name="lateText" type="text" value="${esc(S.lodge.latePolicy.text)}"></div>
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Water points</h3>
      <div class="row2"><div class="field"><label>Price per water point (R)</label><input name="wpPrice" type="number" value="${r(S.waterPoints.price)}"></div><div class="field"><label>Hold period (hours)</label><input name="wpHold" type="number" min="1" value="${S.waterPoints.holdHours}"></div></div>
      <div class="row2">${['water', 'refreshments'].map(respSel).join('')}</div><div class="row2">${['equipment', 'staff'].map(respSel).join('')}</div>
      <div class="field"><label>Sponsor benefits <span class="hint">One per line</span></label><textarea name="wpBenefits">${esc(S.waterPoints.benefits.join('\n'))}</textarea></div>
      ${chk('benefitsApproved', S.waterPoints.benefitsApproved, 'Benefits approved')}
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Donations (money only)</h3>
      <div class="row3"><div class="field"><label>Kit budget per runner (R)</label><input name="perRunner" type="number" min="1" step="0.01" value="${r(S.donations.perRunner)}"></div>
        <div class="field"><label>Smallest donation (R)</label><input name="minAmount" type="number" min="1" step="1" value="${r(S.donations.minAmount)}"></div>
        <div class="field"><label>Runners to equip (target)</label><input name="donTarget" type="number" min="0" value="${S.donations.target}"></div></div>
      <div class="row2"><div class="field"><label>What the budget buys <span class="hint">One per line</span></label><textarea name="donItems">${esc(S.donations.items.join('\n'))}</textarea></div>
        <div class="field" style="align-self:end">${chk('donEnabled', S.donations.enabled, 'Accept donations')}</div></div>
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Payments</h3>
      <div class="row2"><div class="field"><label>Payment provider</label><input name="providerName" type="text" value="${esc(S.payments.providerName)}" placeholder="Not yet chosen"></div>
        <div class="field" style="align-self:end">${chk('previewProvider', S.payments.previewProvider, 'Use preview payment page (testing only)')}</div></div>
      ${chk('eftEnabled', S.payments.eftEnabled, 'Accept EFT with organiser reconciliation')}
      <div class="field"><label>EFT instructions</label><textarea name="eftDetails">${esc(S.payments.eftDetails)}</textarea>${chk('eftConfirmed', S.payments.eftConfirmed, 'Bank details confirmed by ERP finance')}</div>
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Terms, Run Buddy and access</h3>
      <div class="field"><label>Event terms</label><textarea name="terms" style="min-height:140px">${esc(S.terms.text)}</textarea></div>
      <div class="row2"><div class="field"><label>Terms version</label><input name="termsVersion" type="text" value="${esc(S.terms.version)}"></div><div class="field" style="align-self:end">${chk('termsApproved', S.terms.approved, 'Terms approved')}</div></div>
      <div class="field"><label>Run Buddy training resources</label><textarea name="buddyText">${esc(S.buddy.resourcesText)}</textarea>${chk('buddyApproved', S.buddy.resourcesApproved, 'Resources approved')}</div>
      <div class="field"><label>Employee invitation codes <span class="hint">One per line: CODE, group_employee|melorane_employee, max uses (or “unlimited”)</span></label><textarea name="codes">${esc(S.inviteCodes.map((c) => [c.code, c.category, c.maxUses === null || c.maxUses === undefined ? 'unlimited' : c.maxUses].join(', ')).join('\n'))}</textarea></div>
    </div>
    <div class="notice bad" id="serr" hidden></div>
    <button class="btn" type="submit">Save settings</button>
  </form>
  <hr class="rule"><h3>Preview data</h3><div class="btn-row"><button class="btn plain" id="reset">Reset to sample data</button><button class="btn plain" id="empty">Clear all data</button></div>`;
  $$('[data-issue]', m).forEach((b) => b.addEventListener('click', () => act('issueFeeRequests', { category: b.dataset.issue }, 'Payment requests issued')));
  $('#reset').addEventListener('click', async () => { if (confirm('Reset preview data? This signs you out.')) { await api.resetPreview({ withSamples: true }); sessionStorage.removeItem('rw-org-token'); refresh(); } });
  $('#empty').addEventListener('click', async () => { if (confirm('Delete all records? This signs you out.')) { await api.resetPreview({ withSamples: false }); sessionStorage.removeItem('rw-org-token'); refresh(); } });
  $('#set').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const cents = (v) => (v === '' || v === null ? null : Math.round(Number(v) * 100));
    const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
    const existingCodes = Object.fromEntries(S.inviteCodes.map((c) => [c.code, c.uses]));
    const patch = {
      event: { startTime: f.startTime.value.trim(), startTimeConfirmed: f.startTimeConfirmed.checked && !!f.startTime.value.trim(), pickupPlace: f.pickupPlace.value.trim(), pickupTime: f.pickupTime.value.trim(), pickupFullAddress: f.pickupFullAddress.value.trim(), pickupAddressConfirmed: f.pickupAddressConfirmed.checked && !!f.pickupFullAddress.value.trim(), proceedsText: f.proceedsText.value.trim(),
        startLocation: f.startLocation.value.trim(), finishLocation: f.finishLocation.value.trim(), routeDescription: f.routeDescription.value.trim(), routeConfirmed: f.routeConfirmed.checked },
      socks: { price: cents(f.socksPrice.value), confirmed: f.socksConfirmed.checked, maxPerEntry: parseInt(f.socksMax.value, 10), enabled: f.socksEnabled.checked },
      pools: { combined: { limit: parseInt(f.poolCombined.value, 10) }, community: { limit: parseInt(f.poolCommunity.value, 10) } },
      reservation: { expiryHours: Number(f.expiryHours.value) },
      fees: Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, { amount: cents(f['fee_' + c].value), confirmed: f['feeok_' + c].checked, label: S.fees[c].label }])),
      acceptWhileFeeUnconfirmed: f.acceptWhileFeeUnconfirmed.checked,
      lodge: {
        ratePerNight: cents(f.lodgeRate.value), depositPercent: Number(f.lodgeDeposit.value), balanceDueDate: f.lodgeDue.value, holdHours: Number(f.lodgeHold.value), minNights: parseInt(f.lodgeMin.value, 10),
        nights: lines(f.lodgeNights.value).map((l) => { const [date, beds] = l.split(',').map((x) => x.trim()); return { date, beds: parseInt(beds, 10) }; }).sort((a, b) => a.date.localeCompare(b.date)),
        inventoryConfirmed: f.inventoryConfirmed.checked,
        latePolicy: { mode: f.lateMode.value, days: Number(f.lateDays.value), confirmed: f.lateOk.checked && !!f.lateMode.value, text: f.lateText.value.trim() },
      },
      waterPoints: { price: cents(f.wpPrice.value), holdHours: Number(f.wpHold.value), responsibilities: Object.fromEntries(['water', 'refreshments', 'equipment', 'staff'].map((k) => [k, f['wp_' + k].value])), benefits: lines(f.wpBenefits.value), benefitsApproved: f.benefitsApproved.checked },
      donations: { perRunner: cents(f.perRunner.value), minAmount: cents(f.minAmount.value), target: parseInt(f.donTarget.value, 10) || 0, items: lines(f.donItems.value), enabled: f.donEnabled.checked },
      payments: { providerName: f.providerName.value.trim(), previewProvider: f.previewProvider.checked, eftEnabled: f.eftEnabled.checked, eftDetails: f.eftDetails.value.trim(), eftConfirmed: f.eftConfirmed.checked },
      terms: { text: f.terms.value.trim(), version: f.termsVersion.value.trim(), approved: f.termsApproved.checked },
      buddy: { resourcesText: f.buddyText.value.trim(), resourcesApproved: f.buddyApproved.checked },
      inviteCodes: lines(f.codes.value).map((l) => { const [code, category, max] = l.split(',').map((x) => x.trim()); const unlimited = !max || /^unlimited$/i.test(max); return { code: code.toUpperCase(), category, maxUses: unlimited ? null : parseInt(max, 10) || 100, uses: existingCodes[code.toUpperCase()] || 0 }; }).filter((c) => CATEGORIES[c.category] && CATEGORIES[c.category].employee),
    };
    try { await api.updateSettings(token, patch); toast('Settings saved'); refresh(); } catch (err) { $('#serr').hidden = false; $('#serr').textContent = err.message; }
  });
}

// ---------- launch checklist ----------

function checklistView(m, D) {
  const S = D.settings;
  const items = [
    ['Exact race start time', S.event.startTimeConfirmed],
    ['Melorane employee entry fee', S.fees.melorane_employee.confirmed],
    ['Community member entry fee', S.fees.community.confirmed],
    ['Stop accepting entries while a fee is unconfirmed', !S.acceptWhileFeeUnconfirmed],
    ['Canvas Lodge dates and inventory', S.lodge.inventoryConfirmed],
    ['Start and finish locations and running route', S.event.routeConfirmed],
    ['Sock add-on price', S.socks.confirmed || !S.socks.enabled],
    ['RunWild shirt order placed (see Shirts & socks)', false],
    ['Canvas Lodge inclusions and cancellation terms (add to event terms; minimum stay is ' + S.lodge.minNights + ' nights)', false],
    ['Late-booking policy for lodge bookings after ' + formatDate(S.lodge.balanceDueDate), S.lodge.latePolicy.confirmed],
    ['Payment provider chosen and connected (server-side notifications)', !!S.payments.providerName && S.payments.providerConnected],
    ['Preview payment page switched off', !S.payments.previewProvider],
    ['EFT bank details confirmed by ERP finance', S.payments.eftConfirmed],
    ['Water point responsibilities (water, refreshments, equipment, staff)', Object.values(S.waterPoints.responsibilities).every((v) => v !== 'tbc')],
    ['Water point sponsor benefits approved', S.waterPoints.benefitsApproved],
    ['Event terms approved', S.terms.approved],
    ['Full pickup address in PJ', S.event.pickupAddressConfirmed],
    ['Run Buddy training resources approved', S.buddy.resourcesApproved],
    ['Email and SMS providers connected', S.messaging.emailConnected && S.messaging.smsConnected],
    ['Real organiser accounts created; preview account removed', !S.organisers.some((o) => o.email === 'organiser@preview.local')],
    ['Production backend deployed (server-side capacity and permissions – see README)', false],
    ['Sample data removed', !D.registrations.some((r) => r.sample)],
  ];
  const done = items.filter((i) => i[1]).length;
  m.innerHTML = `<h2>Launch checklist</h2><p class="muted">${done} of ${items.length} done. Items update automatically from Settings.</p>
    <div class="card"><ul class="list-plain">${items.map(([t, ok]) => `<li>${ok ? statusPill('confirmed', 'Done') : statusPill('pending', 'Open')} &nbsp;${esc(t)}</li>`).join('')}</ul></div>`;
}

// ---------- verification tests ----------

async function testsView(m) {
  m.innerHTML = `<h2>Verification tests</h2>
    <p class="muted">These scenarios run against a fresh, separate copy of the backend in this browser – they do not touch your preview data. The same scenarios run from the command line with <span class="ref">npm test</span>.</p>
    <button class="btn" id="run">Run all scenarios</button><div id="out" style="margin-top:16px"></div>`;
  $('#run').addEventListener('click', async () => {
    const out = $('#out');
    out.innerHTML = '';
    let pass = 0;
    for (const sc of scenarios) {
      const row = document.createElement('div');
      row.className = 'test-row';
      try { await sc.run(); pass++; row.innerHTML = `<span class="res pass">PASS</span><span>${esc(sc.name)}</span>`; } catch (e) { row.innerHTML = `<span class="res fail">FAIL</span><span>${esc(sc.name)}<br><span class="small">${esc(e.message)}</span></span>`; }
      out.appendChild(row);
    }
    const sum = document.createElement('p');
    sum.innerHTML = `<strong>${pass} of ${scenarios.length} passed.</strong>`;
    out.prepend(sum);
  });
}

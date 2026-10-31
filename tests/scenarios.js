// Acceptance scenarios from the brief. Browser-safe (no Node imports) so organisers can run them
// from the dashboard; tests/run.mjs runs the same list from the command line.

import { Backend, memoryStorage, inProcessLock, AuthError, ValidationError, hashPassword, SCHEMA_VERSION } from '../js/backend.js';
import { lodgeQuote, poolUsage } from '../js/core.js';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const HOUR = 3600000;

// The clock is October 2026, before race entries open. Most scenarios test race rules, so they open entries first.
async function setup({ open = true } = {}) {
  const clock = { t: Date.UTC(2026, 9, 23, 8) };
  const be = new Backend({ storage: memoryStorage(), now: () => clock.t, lock: inProcessLock(), seed: false });
  if (open) await be._write((s) => { s.settings.registration.opensOn = '2026-10-01'; });
  return { be, clock };
}

let n = 0;
function person(category, distance = '21k', extra = {}) {
  n++;
  const base = {
    clientRequestId: 'req-' + n + '-' + Math.random().toString(36).slice(2),
    category, distance, fullName: 'Test Person ' + n, mobile: '082' + String(1000000 + n).slice(-7),
    email: 'p' + n + '@example.org', emergencyName: 'Contact', emergencyMobile: '0830000000',
    termsAccepted: true, privacyAck: true, shirtSize: 'M',
  };
  if (category === 'group_employee' || category === 'other') Object.assign(base, { lodge: { wanted: false }, transportAck: true, buddy: { optIn: false } });
  if (category === 'group_employee') Object.assign(base, { employer: 'Group Co', inviteCode: 'GROUP-PREVIEW' });
  if (category === 'melorane_employee') Object.assign(base, { employer: 'Melorane', inviteCode: 'MELORANE-PREVIEW' });
  if (category === 'community') Object.assign(base, { email: '', pickupAck: true, kit: { shoeSize: '8', shoeSystem: 'UK', shirtSize: 'M', shortsSize: 'M', needsShoes: true, needsKit: false }, buddy: { optIn: false } });
  return Object.assign(base, extra);
}

async function fill(be, category, count, distanceFn = () => '21k') {
  const out = [];
  for (let i = 0; i < count; i++) out.push(await be.submitRegistration(person(category, distanceFn(i))));
  return out;
}

async function usage(be) {
  return be._read((s) => poolUsage(s.registrations, s.settings, be.now()));
}

async function payEntry(be, ref, eventId) {
  const chargeRef = ref + '-E';
  const msg = { eventId, chargeRef, amount: 100000, status: 'paid' };
  msg.signature = await be.previewSignNotification(msg);
  return be.providerNotification(msg);
}

export const scenarios = [
  {
    name: 'Combined pool of 34 accepts the last place and waitlists the next person',
    async run() {
      const { be } = await setup();
      const regs = await fill(be, 'other', 20);
      regs.push(...await fill(be, 'group_employee', 13));
      const last = await be.submitRegistration(person('other'));
      eq(last.status, 'reserved', '34th entry');
      const next = await be.submitRegistration(person('group_employee'));
      eq(next.status, 'waitlisted', '35th entry');
      eq(next.charges.length, 0, 'waitlisted entry must not be charged');
      eq((await usage(be)).combined.used, 34, 'combined used');
    },
  },
  {
    name: 'Community pool accepts 16 participants and waitlists the 17th',
    async run() {
      const { be } = await setup();
      const regs = await fill(be, 'community', 16);
      assert(regs.every((r) => r.status === 'reserved'), 'first 16 should hold places');
      const next = await be.submitRegistration(person('community'));
      eq(next.status, 'waitlisted', '17th community entry');
    },
  },
  {
    name: 'Melorane employee entries do not reduce either limited pool',
    async run() {
      const { be } = await setup();
      await fill(be, 'other', 34);
      await fill(be, 'community', 16);
      const mel = await fill(be, 'melorane_employee', 10);
      assert(mel.every((r) => r.status === 'reserved' || r.status === 'confirmed'), 'Melorane employees still get places when pools are full');
      const u = await usage(be);
      eq(u.combined.used, 34, 'combined used');
      eq(u.community.used, 16, 'community used');
    },
  },
  {
    name: 'Both distances draw from the same category pool',
    async run() {
      const { be } = await setup();
      await fill(be, 'other', 34, (i) => (i % 2 ? '5k' : '21k'));
      const a = await be.submitRegistration(person('other', '5k'));
      const b = await be.submitRegistration(person('group_employee', '21k'));
      eq(a.status, 'waitlisted', '5 km after pool full');
      eq(b.status, 'waitlisted', '21 km after pool full');
    },
  },
  {
    name: 'Simultaneous requests for the final place cannot overbook',
    async run() {
      const { be } = await setup();
      await fill(be, 'other', 33);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => be.submitRegistration(person(i % 2 ? 'other' : 'group_employee', i % 2 ? '5k' : '21k'))));
      eq(results.filter((r) => r.status === 'reserved').length, 1, 'exactly one gets the last place');
      eq(results.filter((r) => r.status === 'waitlisted').length, 9, 'the rest are waitlisted');
      eq((await usage(be)).combined.used, 34, 'combined used');
    },
  },
  {
    name: 'Expired reservations release capacity and nobody is promoted automatically',
    async run() {
      const { be, clock } = await setup();
      const regs = await fill(be, 'other', 34);
      const wl = await be.submitRegistration(person('other'));
      eq(wl.status, 'waitlisted', 'pool full');
      await payEntry(be, regs[0].ref, 'evt-keep');
      clock.t += 73 * HOUR;
      const u = await usage(be);
      eq(u.combined.used, 1, 'only the paid entry still holds a place');
      const s = await be._read((st) => st.registrations.find((r) => r.ref === wl.ref));
      eq(s.status, 'waitlisted', 'waitlisted person is not promoted or charged');
      eq(await be._read((st) => st.charges.filter((c) => c.ownerId === s.id).length), 0, 'no charge for the waitlisted person');
      const fresh = await be.submitRegistration(person('other'));
      eq(fresh.status, 'reserved', 'released place can be taken');
      const expired = await be._read((st) => st.registrations.find((r) => r.ref === regs[1].ref));
      eq(expired.cancelReason, 'reservation_expired', 'expired entry recorded');
    },
  },
  {
    name: 'Repeated payment notifications do not create duplicate payments',
    async run() {
      const { be } = await setup();
      const r = await be.submitRegistration(person('other'));
      const a = await payEntry(be, r.ref, 'evt-1');
      const b = await payEntry(be, r.ref, 'evt-1');
      const c = await payEntry(be, r.ref, 'evt-1');
      assert(a.ok && !a.duplicate, 'first notification applied');
      assert(b.duplicate && c.duplicate, 'repeats recognised');
      const st = await be._read((s) => ({ pays: s.payments.length, status: s.registrations[0].status }));
      eq(st.pays, 1, 'payments recorded');
      eq(st.status, 'confirmed', 'entry confirmed');
      const entry = await be.myEntry(r.ref, await be._read((s) => s.registrations[0].mobile));
      eq(entry.charges[0].paid, 100000, 'paid once');
      eq(entry.charges[0].outstanding, 0, 'nothing outstanding');
    },
  },
  {
    name: 'Duplicate form submissions create only one entry',
    async run() {
      const { be } = await setup();
      const p = person('community');
      const [a, b] = await Promise.all([be.submitRegistration(p), be.submitRegistration(p)]);
      eq(a.ref, b.ref, 'same reference returned');
      eq(await be._read((s) => s.registrations.length), 1, 'registrations');
    },
  },
  {
    name: 'A browser redirect or forged notification does not mark a payment received',
    async run() {
      const { be } = await setup();
      const r = await be.submitRegistration(person('other'));
      await be.startCheckout(r.ref + '-E');
      const forged = await be.providerNotification({ eventId: 'x', chargeRef: r.ref + '-E', amount: 100000, status: 'paid', signature: 'bad' });
      eq(forged.ok, false, 'forged notification rejected');
      eq(await be._read((s) => s.payments.length), 0, 'no payment recorded');
      eq((await be._read((s) => s.registrations[0].status)), 'reserved', 'still reserved');
    },
  },
  {
    name: 'Canvas Lodge refuses a one-night booking (minimum two nights)',
    async run() {
      const { be } = await setup();
      let err = null;
      try { await be.submitRegistration(person('other', '21k', { lodge: { wanted: true, arrival: '2027-04-16', departure: '2027-04-17' }, transportAck: false })); } catch (e) { err = e; }
      assert(err && err.fields && /minimum of 2 nights/.test(err.fields.lodgeDates), 'one-night stay should be refused');
      eq(await be._read((s) => s.registrations.length), 0, 'nothing registered');
      const r = await be.submitRegistration(person('other'));
      const mob = await be._read((s) => s.registrations[0].mobile);
      let later = null;
      try { await be.requestLodgeForEntry(r.ref, mob, '2027-04-15', '2027-04-16'); } catch (e) { later = e; }
      assert(later && /minimum of 2 nights/.test(later.message), 'one night refused from My entry too');
    },
  },
  {
    name: 'Two lodge nights: R11,000 total, R2,200 deposit, R8,800 balance',
    async run() {
      const q = lodgeQuote({ nights: 2, ratePerNight: 550000, depositPercent: 20 });
      eq(q.total, 1100000, 'total'); eq(q.deposit, 220000, 'deposit'); eq(q.balance, 880000, 'balance');
      const { be } = await setup();
      const r = await be.submitRegistration(person('other', '21k', { lodge: { wanted: true, arrival: '2027-04-15', departure: '2027-04-17' }, transportAck: false }));
      eq(r.lodge.total, 1100000, 'stored total'); eq(r.lodge.deposit, 220000, 'stored deposit'); eq(r.lodge.balance, 880000, 'stored balance');
    },
  },
  {
    name: 'Entry fees stay separate from accommodation',
    async run() {
      const { be } = await setup();
      const r = await be.submitRegistration(person('other', '21k', { lodge: { wanted: true, arrival: '2027-04-16', departure: '2027-04-18' }, transportAck: false }));
      const kinds = r.charges.map((c) => c.kind + ':' + c.amount).sort();
      eq(kinds.join(','), 'entry:100000,lodge_balance:880000,lodge_deposit:220000', 'separate charges');
      const msg = { eventId: 'evt-dep', chargeRef: r.ref + '-LD', amount: 220000, status: 'paid' };
      msg.signature = await be.previewSignNotification(msg);
      await be.providerNotification(msg);
      const after = await be.myEntry(r.ref, await be._read((s) => s.registrations[0].mobile));
      eq(after.charges.find((c) => c.kind === 'entry').outstanding, 100000, 'entry still outstanding after deposit');
      eq(after.lodge.status, 'confirmed', 'lodge confirmed by deposit');
      eq(after.charges.find((c) => c.kind === 'lodge_deposit').outstanding, 0, 'deposit settled');
      eq(after.charges.find((c) => c.kind === 'lodge_balance').outstanding, 880000, 'balance still outstanding');
      eq(after.status, 'reserved', 'race entry not confirmed by a lodge deposit');
    },
  },
  {
    name: 'A water point cannot be sponsored twice',
    async run() {
      const { be } = await setup();
      const sp = (name) => ({ point: 3, name, contactPerson: 'X', email: 'x@example.org', phone: '0110000000', clientRequestId: name });
      const res = await Promise.allSettled([be.submitSponsorship(sp('Alpha')), be.submitSponsorship(sp('Beta'))]);
      eq(res.filter((r) => r.status === 'fulfilled').length, 1, 'one succeeds');
      eq(res.filter((r) => r.status === 'rejected').length, 1, 'one is refused');
      const regs = await be._read((s) => s.registrations.length);
      eq(regs, 0, 'sponsorship does not register anyone');
    },
  },
  {
    name: 'Donations are money only: R2,500 per runner, counted once received',
    async run() {
      const { be } = await setup();
      assert(typeof be.submitPledge !== 'function', 'physical donation pledges are no longer accepted');
      const c = await be.submitContribution({ mode: 'runners', runners: 3, donor: 'Donor', email: 'd@example.org' });
      eq(c.amount, 750000, '3 runners × R2,500');
      let p = (await be.publicSummary()).donations.progress;
      eq(p.raised, 0, 'nothing counted before payment'); eq(p.runnersFunded, 0, 'no runner funded yet');
      const msg = { eventId: 'evt-don', chargeRef: c.charge.ref, amount: 750000, status: 'paid' };
      msg.signature = await be.previewSignNotification(msg);
      await be.providerNotification(msg);
      const g = await be.submitContribution({ mode: 'amount', amount: '1000', donor: 'Other donor', email: 'o@example.org' });
      eq(g.amount, 100000, 'any amount');
      p = (await be.publicSummary()).donations.progress;
      eq(p.raised, 750000, 'raised'); eq(p.runnersFunded, 3, 'runners funded');
      let small = false;
      try { await be.submitContribution({ mode: 'amount', amount: '10', donor: 'Tiny', email: 't@example.org' }); } catch { small = true; }
      assert(small, 'donations below the minimum are refused');
    },
  },
  {
    name: 'Every entry, including group entries, needs a RunWild shirt size',
    async run() {
      const { be } = await setup();
      for (const cat of ['group_employee', 'other', 'community', 'melorane_employee']) {
        let err = null;
        try { await be.submitRegistration(person(cat, '21k', { shirtSize: '' })); } catch (e) { err = e; }
        assert(err && err.fields && err.fields.shirtSize, cat + ' without a shirt size should be refused');
      }
      const r = await be.submitRegistration(person('group_employee', '5k', { shirtSize: 'XL' }));
      eq(r.shirtSize, 'XL', 'shirt size stored');
      eq(r.charges.length, 1, 'shirt is included in the entry, not charged separately');
    },
  },
  {
    name: 'Socks are a separate add-on, charged only once the price is confirmed',
    async run() {
      const { be } = await setup();
      const a = await be.submitRegistration(person('other', '21k', { socks: { qty: 2, size: 'M (UK 6–8)' } }));
      eq(a.socks.qty, 2, 'order recorded');
      assert(!a.charges.some((c) => c.kind === 'socks'), 'no sock charge while the price is unconfirmed');
      const tok = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      await be.updateSettings(tok, { socks: { price: 8000, confirmed: true } });
      eq(await be.organiserAction(tok, 'issueSockCharges'), 1, 'held order now payable');
      const mob = await be._read((s) => s.registrations[0].mobile);
      const e = await be.myEntry(a.ref, mob);
      eq(e.charges.find((c) => c.kind === 'socks').amount, 16000, '2 pairs × R80');
      eq(e.charges.find((c) => c.kind === 'entry').amount, 100000, 'entry fee unchanged');
      const b = await be.submitRegistration(person('community'));
      const bm = await be._read((s) => s.registrations.find((x) => x.ref === b.ref).mobile);
      const after = await be.addSocksForEntry(b.ref, bm, 1, 'S (UK 3–5)');
      eq(after.socks.qty, 1, 'socks added later from My entry');
      assert(!after.charges.some((c) => c.kind === 'socks'), 'nothing payable while the entry awaits checking');
      const bid = await be._read((s) => s.registrations.find((x) => x.ref === b.ref).id);
      const v = await be.organiserAction(tok, 'verifyEmployee', { regId: bid, approve: true });
      eq(v.charges.find((c) => c.kind === 'socks').amount, 8000, 'sock charge raised once verified');
    },
  },
  {
    name: 'Melorane employees: free, unlimited, every entry checked by an organiser, and can ask for kit',
    async run() {
      const { be } = await setup();
      const regs = await fill(be, 'melorane_employee', 150);
      assert(regs.every((r) => r.status === 'reserved' && r.verification === 'pending' && r.holdReason === 'awaiting_verification'), 'all held, awaiting checking – no limit');
      assert(regs.every((r) => r.charges.length === 0), 'free: nothing payable');
      let err = null;
      try { await be.submitRegistration(person('melorane_employee', '5k', { kit: { needsShoes: true, needsKit: true } })); } catch (e) { err = e; }
      assert(err && err.fields.shoeSize && err.fields.shortsSize, 'sizes required for the kit asked for');
      const k = await be.submitRegistration(person('melorane_employee', '5k', { shirtSize: 'L', kit: { needsShoes: true, needsKit: true, shoeSize: '9', shoeSystem: 'UK', shortsSize: 'L' } }));
      eq(k.kit.shirtSize, 'L', 'kit shirt follows the entry shirt size');
      const p = (await be.publicSummary()).donations.progress;
      eq(p.runnersNeedingKit, 1, 'counted among runners needing kit');
    },
  },
  {
    name: 'Race entries are closed to the public until 1 February 2027',
    async run() {
      const { be, clock } = await setup({ open: false });
      let err = null;
      try { await be.submitRegistration(person('other')); } catch (e) { err = e; }
      assert(err && /open on 1 February 2027/.test(err.message), 'public entry refused before opening');
      eq((await be.publicSummary()).registration.open, false, 'summary says closed');
      const tok = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      const assisted = await be.submitRegistration(person('other'), { token: tok });
      eq(assisted.status, 'reserved', 'organisers can still register people');
      clock.t = Date.UTC(2027, 0, 31, 21, 59);   // 23:59 on 31 Jan in Johannesburg
      let still = false;
      try { await be.submitRegistration(person('other')); } catch { still = true; }
      assert(still, 'still closed the evening before');
      clock.t = Date.UTC(2027, 0, 31, 22, 1);    // 00:01 on 1 Feb in Johannesburg
      eq((await be.submitRegistration(person('other'))).status, 'reserved', 'open from 1 February (SAST)');
    },
  },
  {
    name: 'Admins can open race entries early to test, close them, or open at a set time',
    async run() {
      const { be, clock } = await setup({ open: false });
      const admin = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      await be.updateSettings(admin, { registration: { mode: 'open' } });
      eq((await be.publicSummary()).registration.open, true, 'Open now overrides the date');
      const test = await be.submitRegistration(person('other'));
      eq(test.status, 'reserved', 'public can register while switched open');
      await be.updateSettings(admin, { registration: { mode: 'closed' } });
      let shut = null;
      try { await be.submitRegistration(person('other')); } catch (e) { shut = e; }
      assert(shut && /not open yet/.test(shut.message), 'Closed refuses public entries');
      // Back to automatic with an 08:00 opening time on a backdated day.
      await be.updateSettings(admin, { registration: { mode: 'auto', opensOn: '2026-10-23', opensAt: '08:00' } });
      clock.t = Date.UTC(2026, 9, 23, 5, 59);   // 07:59 SAST
      eq((await be.publicSummary()).registration.open, false, 'still closed at 07:59');
      clock.t = Date.UTC(2026, 9, 23, 6, 0);    // 08:00 SAST
      const pub = await be.publicSummary();
      eq(pub.registration.open, true, 'open from 08:00');
      eq(pub.registration.opensLabel, '23 October 2026 at 08:00', 'label shows the time');
      let badTime = null;
      try { await be.updateSettings(admin, { registration: { opensAt: '25:00' } }); } catch (e) { badTime = e; }
      assert(badTime, 'invalid time refused');
    },
  },
  {
    name: 'Admins can permanently delete test entries, but never ones with money received',
    async run() {
      const { be } = await setup();
      const admin = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      const t = await be.submitRegistration(person('other', '21k', { lodge: { wanted: true, arrival: '2027-04-15', departure: '2027-04-17' }, transportAck: false, socks: { qty: 1, size: 'M (UK 6–8)' } }));
      const paid = await be.submitRegistration(person('other'));
      await payEntry(be, paid.ref, 'evt-keep-me');
      const idOf = (ref) => be._read((s) => s.registrations.find((r) => r.ref === ref).id);
      await be.createUser(admin, { email: 'org@erp.ngo', name: 'Org', role: 'organiser', password: 'temporary-pass-9' });
      const org = (await be.login('org@erp.ngo', 'temporary-pass-9')).token;
      await be.changePassword(org, 'temporary-pass-9', 'organisers-pass-9');
      let notAdmin = null;
      try { await be.organiserAction(org, 'deleteRegistration', { regId: await idOf(t.ref) }); } catch (e) { notAdmin = e; }
      assert(notAdmin && /Only admins/.test(notAdmin.message), 'organisers cannot delete');
      await be.organiserAction(admin, 'deleteRegistration', { regId: await idOf(t.ref) });
      const left = await be._read((s) => ({ regs: s.registrations.map((r) => r.ref), lodge: s.lodgeRequests.length, charges: s.charges.map((c) => c.ref) }));
      assert(!left.regs.includes(t.ref) && left.lodge === 0 && !left.charges.some((c) => c.startsWith(t.ref)), 'entry, lodge request and charges removed');
      eq((await usage(be)).combined.used, 1, 'the place is freed');
      let kept = null;
      try { await be.organiserAction(admin, 'deleteRegistration', { regId: await idOf(paid.ref) }); } catch (e) { kept = e; }
      assert(kept && /payments recorded/.test(kept.message), 'paid entry cannot be deleted');
      const l = await be.submitLaunchRegistration({ firstName: 'Test', surname: 'Person', email: 'test@acme.co.za' });
      const lid = await be._read((s) => s.launchRegistrations.find((x) => x.ref === l.ref).id);
      await be.organiserAction(admin, 'deleteLaunch', { id: lid });
      eq(await be._read((s) => s.launchRegistrations.length), 0, 'launch test registration deleted');
      assert(await be._read((s) => s.audit.some((a) => a.action === 'registration.deleted')), 'deletion recorded in the audit trail');
    },
  },
  {
    name: 'Launch event: anyone can register; personal emails are flagged but accepted',
    async run() {
      const { be } = await setup({ open: false });
      const biz = await be.submitLaunchRegistration({ firstName: 'Thandi', surname: 'Nkosi', email: 'thandi@acme.co.za' });
      eq(biz.personalEmail, false, 'business email not flagged');
      const g = await be.submitLaunchRegistration({ firstName: 'Pieter', surname: 'Smit', email: 'Pieter.Smit@GMAIL.com' });
      eq(g.personalEmail, true, 'gmail flagged');
      eq(g.email, 'pieter.smit@gmail.com', 'email stored in lower case');
      const o = await be.submitLaunchRegistration({ firstName: 'Ann', surname: 'Lee', email: 'ann@outlook.com' });
      eq(o.personalEmail, true, 'outlook flagged');
      let dup = null;
      try { await be.submitLaunchRegistration({ firstName: 'P', surname: 'S', email: 'pieter.smit@gmail.com' }); } catch (e) { dup = e; }
      assert(dup && dup.fields.email, 'same email cannot register twice');
      let bad = null;
      try { await be.submitLaunchRegistration({ firstName: '', surname: '', email: 'nope' }); } catch (e) { bad = e; }
      assert(bad && bad.fields.firstName && bad.fields.surname && bad.fields.email, 'name, surname and a valid email are required');
      eq(await be._read((s) => s.registrations.length), 0, 'launch registration is not a race entry');
      const pub = JSON.stringify(await be.publicSummary());
      assert(!pub.includes('thandi@acme.co.za'), 'launch registrations are not public');
    },
  },
  {
    name: 'User accounts: admins create users; roles limit what each person can do',
    async run() {
      const { be } = await setup();
      const admin = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      let weak = null;
      try { await be.createUser(admin, { email: 'thabo@erp.ngo', name: 'Thabo', role: 'organiser', password: 'short' }); } catch (e) { weak = e; }
      assert(weak && weak.fields.password, 'short passwords refused');
      await be.createUser(admin, { email: 'thabo@erp.ngo', name: 'Thabo', role: 'organiser', password: 'temporary-pass-1' });
      await be.createUser(admin, { email: 'viewer@erp.ngo', name: 'Vee', role: 'viewer', password: 'temporary-pass-2' });
      const dash = await be.dashboard(admin);
      assert(!JSON.stringify(dash).includes('"hash"') && !JSON.stringify(dash).includes('"salt"'), 'password hashes never leave the server');
      // New users must choose their own password first.
      const t1 = await be.login('THABO@erp.ngo', 'temporary-pass-1');
      eq(t1.mustChangePassword, true, 'temporary password must be changed');
      let blocked = null;
      try { await be.organiserAction(t1.token, 'issueSockCharges'); } catch (e) { blocked = e; }
      assert(blocked && /new password/.test(blocked.message), 'nothing else allowed until the password is changed');
      await be.changePassword(t1.token, 'temporary-pass-1', 'thabos-own-password');
      // Organisers can manage entries but not settings or users.
      let noSettings = null;
      try { await be.updateSettings(t1.token, { pools: { combined: { limit: 99 } } }); } catch (e) { noSettings = e; }
      assert(noSettings instanceof ValidationError && /cannot do this/.test(noSettings.message), 'organisers cannot change settings');
      let noUsers = null;
      try { await be.createUser(t1.token, { email: 'x@y.z', name: 'X', role: 'admin', password: 'another-password' }); } catch (e) { noUsers = e; }
      assert(noUsers, 'organisers cannot create users');
      eq((await be.dashboard(t1.token)).users.length, 0, 'organisers do not see the user list');
      // Viewers can only look.
      const v = await be.login('viewer@erp.ngo', 'temporary-pass-2');
      await be.changePassword(v.token, 'temporary-pass-2', 'viewers-own-password');
      let noAct = null;
      try { await be.organiserAction(v.token, 'issueSockCharges'); } catch (e) { noAct = e; }
      assert(noAct && /Viewer/.test(noAct.message), 'viewers cannot take actions');
      // Admins change the race and launch dates.
      await be.updateSettings(admin, { event: { date: '2027-05-01' }, launchEvent: { date: '2027-01-20', dateConfirmed: true } });
      const pub = await be.publicSummary();
      eq(pub.event.date, '2027-05-01', 'race date changed'); eq(pub.launch.date, '2027-01-20', 'launch date changed');
      let order = null;
      try { await be.updateSettings(admin, { registration: { opensOn: '2027-06-01' } }); } catch (e) { order = e; }
      assert(order, 'entries cannot open after race day');
      // Deactivating someone ends their session.
      const thaboId = (await be.dashboard(admin)).users.find((u) => u.email === 'thabo@erp.ngo').id;
      await be.updateUser(admin, thaboId, { active: false });
      let gone = null;
      try { await be.dashboard(t1.token); } catch (e) { gone = e; }
      assert(gone instanceof AuthError, 'deactivated user is signed out');
      // The last admin cannot be removed.
      const adminId = (await be.dashboard(admin)).users.find((u) => u.role === 'admin').id;
      let last = null;
      try { await be.updateUser(admin, adminId, { role: 'viewer' }); } catch (e) { last = e; }
      assert(last && /at least one active admin/.test(last.message), 'last admin protected');
    },
  },
  {
    name: 'Five wrong passwords lock the account for 15 minutes',
    async run() {
      const { be, clock } = await setup();
      for (let i = 0; i < 5; i++) { try { await be.login('organiser@preview.local', 'wrong-' + i); } catch { /* expected */ } }
      let locked = null;
      try { await be.login('organiser@preview.local', 'runwild-preview'); } catch (e) { locked = e; }
      assert(locked && /locked/.test(locked.message), 'locked even with the right password');
      clock.t += 16 * 60000;
      assert((await be.login('organiser@preview.local', 'runwild-preview')).token, 'unlocked after 15 minutes');
    },
  },
  {
    name: 'Live database: starts empty with only the bootstrap admin, and an upgrade never wipes data',
    async run() {
      const salt = 'test-salt';
      const admin = { id: 'boot', email: 'admin', name: 'Administrator', role: 'admin', salt, iterations: 100000, hash: await hashPassword('first-password!', salt), active: true, mustChangePassword: true, createdAt: 0, lastLoginAt: null };
      const storage = memoryStorage();
      const clock = { t: Date.UTC(2026, 9, 23, 8) };
      const be = new Backend({ storage, now: () => clock.t, lock: inProcessLock(), mode: 'live', bootstrapUsers: [admin] });
      const pub = await be.publicSummary();
      eq(pub.payments.previewProvider, false, 'no preview payment page on a live site');
      let noPreview = false;
      try { await be.login('organiser@preview.local', 'runwild-preview'); } catch { noPreview = true; }
      assert(noPreview, 'preview account does not exist on a live site');
      const t = (await be.login('admin', 'first-password!')).token;
      await be.changePassword(t, 'first-password!', 'a-much-better-password');
      await be.submitLaunchRegistration({ firstName: 'Keep', surname: 'Me', email: 'keep@acme.co.za' });
      eq((await be.dashboard(t)).registrations.length, 0, 'no sample data on a live site');
      let noSign = false;
      try { await be.previewSignNotification({ eventId: 'x', chargeRef: 'y', amount: 1, status: 'paid' }); } catch { noSign = true; }
      assert(noSign, 'live site never signs payment notifications for the browser');
      let noReset = false;
      try { await be.resetPreview(); } catch { noReset = true; }
      assert(noReset, 'live site cannot be reset');
      // Simulate data written by an older version of the site.
      const old = JSON.parse(storage.read());
      old.version = SCHEMA_VERSION - 1;
      delete old.settings.socks;
      delete old.stock;
      delete old.settings.verifyCategories;
      old.settings.fees.community = { amount: null, confirmed: false, label: 'Entry fee' };
      old.settings.fees.melorane_employee = { amount: null, confirmed: false, label: 'Entry fee' };
      storage.write(old);
      const d = await be.dashboard(t);
      eq(d.launchRegistrations.length, 1, 'existing data kept after upgrade');
      assert(d.settings.socks && Array.isArray(d.stock), 'new settings and collections filled in');
      assert(d.audit.some((a) => a.action === 'database.upgraded'), 'upgrade recorded');
      eq(d.settings.fees.community.confirmed && d.settings.fees.community.amount, 0, 'community made free on upgrade');
      eq(d.settings.fees.melorane_employee.confirmed && d.settings.fees.melorane_employee.amount, 0, 'Melorane made free on upgrade');
      eq(d.settings.verifyCategories.join(','), 'community,melorane_employee', 'both checked by organisers');
    },
  },
  {
    name: 'Private participant data is inaccessible to public visitors',
    async run() {
      const { be } = await setup();
      const r = await be.submitRegistration(person('community'));
      const pub = JSON.stringify(await be.publicSummary());
      assert(!pub.includes(r.fullName), 'public summary must not contain names');
      assert(!pub.includes('0821'), 'public summary must not contain mobile numbers');
      let blocked = false;
      try { await be.dashboard('not-a-token'); } catch (e) { blocked = e instanceof AuthError; }
      assert(blocked, 'dashboard requires organiser sign-in');
      let denied = false;
      try { await be.myEntry(r.ref, '0999999999'); } catch { denied = true; }
      assert(denied, 'an entry cannot be opened without the matching mobile number');
    },
  },
  {
    name: 'Community and Melorane entries are free, hold a place, and are confirmed or declined by an organiser',
    async run() {
      const { be } = await setup();
      const tok = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      const c = await be.submitRegistration(person('community'));
      const m = await be.submitRegistration(person('melorane_employee', '5k', { inviteCode: 'MELORANE-PREVIEW' }));
      for (const r of [c, m]) {
        eq(r.status, 'reserved', r.category + ' place held');
        eq(r.holdReason, 'awaiting_verification', r.category + ' awaiting check');
        eq(r.charges.length, 0, r.category + ' free');
      }
      eq(m.verification, 'pending', 'a code does not skip the check for Melorane employees');
      eq((await usage(be)).community.used, 1, 'held community entry uses a community place');
      const id = (ref) => be._read((s) => s.registrations.find((x) => x.ref === ref).id);
      const ok = await be.organiserAction(tok, 'verifyEmployee', { regId: await id(c.ref), approve: true });
      eq(ok.status, 'confirmed', 'verified free entry is confirmed');
      await be.organiserAction(tok, 'verifyEmployee', { regId: await id(m.ref), approve: false });
      eq(await be._read((s) => s.registrations.find((x) => x.ref === m.ref).status), 'cancelled', 'declined entry cancelled');
      // When the community pool is full, new entries are waitlisted (still to be checked) and keep their queue place when verified.
      await fill(be, 'community', 15);
      const wl = await be.submitRegistration(person('community'));
      eq(wl.status, 'waitlisted', 'pool full → waitlist');
      const w = await be.organiserAction(tok, 'verifyEmployee', { regId: await id(wl.ref), approve: true });
      eq(w.status, 'waitlisted', 'verifying does not jump the waitlist');
    },
  },
  {
    name: 'Group employee without a valid code holds no place until verified',
    async run() {
      const { be } = await setup();
      const r = await be.submitRegistration(person('group_employee', '5k', { inviteCode: 'WRONG' }));
      eq(r.status, 'draft', 'unverified entry');
      eq(r.charges.length, 0, 'nothing payable');
      await fill(be, 'other', 34);
      const tok = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      const g = await be.submitRegistration(person('group_employee', '21k', { inviteCode: '' }));
      eq(g.status, 'draft', 'group employee without code');
      const id = await be._read((s) => s.registrations.find((x) => x.ref === g.ref).id);
      const v = await be.organiserAction(tok, 'verifyEmployee', { regId: id, approve: true });
      eq(v.status, 'waitlisted', 'verified into a full pool goes to the waitlist');
    },
  },
  {
    name: 'Organisers can fetch an entry confirmation (for the PDF); anyone else cannot',
    async run() {
      const { be } = await setup();
      const r = await be.submitRegistration(person('other', '5k'));
      const id = await be._read((s) => s.registrations.find((x) => x.ref === r.ref).id);
      let refused = false;
      try { await be.entryConfirmation('not-a-token', id); } catch (e) { refused = e instanceof AuthError; }
      assert(refused, 'needs a signed-in organiser');
      const tok = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      const c = await be.entryConfirmation(tok, id);
      eq(c.ref, r.ref, 'same entry');
      eq(c.status, r.status, 'same status as the participant sees');
      eq(c.charges.length, r.charges.length, 'same charges');
      assert(c.email && c.mobile, 'includes contact details for emailing');
    },
  },
];

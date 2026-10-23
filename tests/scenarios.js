// Acceptance scenarios from the brief. Browser-safe (no Node imports) so organisers can run them
// from the dashboard; tests/run.mjs runs the same list from the command line.

import { Backend, memoryStorage, inProcessLock, AuthError } from '../js/backend.js';
import { lodgeQuote, poolUsage } from '../js/core.js';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const HOUR = 3600000;

function setup() {
  const clock = { t: Date.UTC(2026, 9, 23, 8) };
  const be = new Backend({ storage: memoryStorage(), now: () => clock.t, lock: inProcessLock(), seed: false });
  return { be, clock };
}

let n = 0;
function person(category, distance = '21k', extra = {}) {
  n++;
  const base = {
    clientRequestId: 'req-' + n + '-' + Math.random().toString(36).slice(2),
    category, distance, fullName: 'Test Person ' + n, mobile: '082' + String(1000000 + n).slice(-7),
    email: 'p' + n + '@example.org', emergencyName: 'Contact', emergencyMobile: '0830000000',
    termsAccepted: true, privacyAck: true,
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
      const { be } = setup();
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
      const { be } = setup();
      const regs = await fill(be, 'community', 16);
      assert(regs.every((r) => r.status === 'reserved'), 'first 16 should hold places');
      const next = await be.submitRegistration(person('community'));
      eq(next.status, 'waitlisted', '17th community entry');
    },
  },
  {
    name: 'Melorane employee entries do not reduce either limited pool',
    async run() {
      const { be } = setup();
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
      const { be } = setup();
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
      const { be } = setup();
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
      const { be, clock } = setup();
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
      const { be } = setup();
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
      const { be } = setup();
      const p = person('community');
      const [a, b] = await Promise.all([be.submitRegistration(p), be.submitRegistration(p)]);
      eq(a.ref, b.ref, 'same reference returned');
      eq(await be._read((s) => s.registrations.length), 1, 'registrations');
    },
  },
  {
    name: 'A browser redirect or forged notification does not mark a payment received',
    async run() {
      const { be } = setup();
      const r = await be.submitRegistration(person('other'));
      await be.startCheckout(r.ref + '-E');
      const forged = await be.providerNotification({ eventId: 'x', chargeRef: r.ref + '-E', amount: 100000, status: 'paid', signature: 'bad' });
      eq(forged.ok, false, 'forged notification rejected');
      eq(await be._read((s) => s.payments.length), 0, 'no payment recorded');
      eq((await be._read((s) => s.registrations[0].status)), 'reserved', 'still reserved');
    },
  },
  {
    name: 'One lodge night: R5,500 total, R1,100 deposit, R4,400 balance',
    async run() {
      const q = lodgeQuote({ nights: 1, ratePerNight: 550000, depositPercent: 20 });
      eq(q.total, 550000, 'total'); eq(q.deposit, 110000, 'deposit'); eq(q.balance, 440000, 'balance');
      const { be } = setup();
      const r = await be.submitRegistration(person('other', '21k', { lodge: { wanted: true, arrival: '2027-04-16', departure: '2027-04-17' }, transportAck: false }));
      eq(r.lodge.total, 550000, 'stored total'); eq(r.lodge.deposit, 110000, 'stored deposit'); eq(r.lodge.balance, 440000, 'stored balance');
    },
  },
  {
    name: 'Two lodge nights: R11,000 total, R2,200 deposit, R8,800 balance',
    async run() {
      const q = lodgeQuote({ nights: 2, ratePerNight: 550000, depositPercent: 20 });
      eq(q.total, 1100000, 'total'); eq(q.deposit, 220000, 'deposit'); eq(q.balance, 880000, 'balance');
    },
  },
  {
    name: 'Entry fees stay separate from accommodation',
    async run() {
      const { be } = setup();
      const r = await be.submitRegistration(person('other', '21k', { lodge: { wanted: true, arrival: '2027-04-16', departure: '2027-04-17' }, transportAck: false }));
      const kinds = r.charges.map((c) => c.kind + ':' + c.amount).sort();
      eq(kinds.join(','), 'entry:100000,lodge_balance:440000,lodge_deposit:110000', 'separate charges');
      const msg = { eventId: 'evt-dep', chargeRef: r.ref + '-LD', amount: 110000, status: 'paid' };
      msg.signature = await be.previewSignNotification(msg);
      await be.providerNotification(msg);
      const after = await be.myEntry(r.ref, await be._read((s) => s.registrations[0].mobile));
      eq(after.charges.find((c) => c.kind === 'entry').outstanding, 100000, 'entry still outstanding after deposit');
      eq(after.lodge.status, 'confirmed', 'lodge confirmed by deposit');
      eq(after.charges.find((c) => c.kind === 'lodge_deposit').outstanding, 0, 'deposit settled');
      eq(after.charges.find((c) => c.kind === 'lodge_balance').outstanding, 440000, 'balance still outstanding');
      eq(after.status, 'reserved', 'race entry not confirmed by a lodge deposit');
    },
  },
  {
    name: 'A water point cannot be sponsored twice',
    async run() {
      const { be } = setup();
      const sp = (name) => ({ point: 3, name, contactPerson: 'X', email: 'x@example.org', phone: '0110000000', clientRequestId: name });
      const res = await Promise.allSettled([be.submitSponsorship(sp('Alpha')), be.submitSponsorship(sp('Beta'))]);
      eq(res.filter((r) => r.status === 'fulfilled').length, 1, 'one succeeds');
      eq(res.filter((r) => r.status === 'rejected').length, 1, 'one is refused');
      const regs = await be._read((s) => s.registrations.length);
      eq(regs, 0, 'sponsorship does not register anyone');
    },
  },
  {
    name: 'Donation pledges remain separate from received donations',
    async run() {
      const { be } = setup();
      await be.submitPledge({ donor: 'Donor', email: 'd@example.org', type: 'shoes', quantity: 5, size: '8', sizeSystem: 'UK', condition: 'New', delivery: 'Drop-off' });
      let p = (await be.publicSummary()).donations.progress;
      eq(p.shoesPledged, 5, 'pledged'); eq(p.shoesInHand, 0, 'nothing received yet');
      const tok = (await be.login('organiser@preview.local', 'runwild-preview')).token;
      const id = await be._read((s) => s.pledges[0].id);
      await be.organiserAction(tok, 'receivePledge', { id, quantity: 2 });
      p = (await be.publicSummary()).donations.progress;
      eq(p.shoesPledged, 3, 'still pledged'); eq(p.shoesInHand, 2, 'received');
    },
  },
  {
    name: 'Private participant data is inaccessible to public visitors',
    async run() {
      const { be } = setup();
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
    name: 'Employee category without a valid code holds no place until verified',
    async run() {
      const { be } = setup();
      const r = await be.submitRegistration(person('melorane_employee', '5k', { inviteCode: 'WRONG' }));
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
];

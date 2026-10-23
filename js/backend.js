// Preview backend. It runs in the browser so the POC can be hosted for free on GitHub Pages,
// but it is written like a server: every write runs inside an exclusive lock that re-reads
// state, applies the change and saves it, so the "check capacity then reserve" step is atomic.
// In browsers the lock is the Web Locks API, which also serialises writes across open tabs.
// The production equivalent (Postgres row locks + row-level security) is in supabase/schema.sql.

import {
  CATEGORIES, DISTANCES, poolUsage, occupiesPlace, isReservationLive, entryFee, sumPaid, makeRef, uid,
  normaliseMobile, validMobile, validEmail, nightsBetween, stayNights, lodgeQuote, lodgeBalanceDue, todayJHB,
  formatDate,
} from './core.js';
import { defaultSettings, sampleData } from './defaults.js';

const SCHEMA_VERSION = 3;
const HOUR = 3600000;

export class ValidationError extends Error {
  constructor(message, fields = {}) { super(message); this.name = 'ValidationError'; this.fields = fields; }
}
export class AuthError extends Error {
  constructor(message = 'Organiser sign-in required.') { super(message); this.name = 'AuthError'; }
}

export function memoryStorage() {
  let raw = null;
  return { read: () => raw, write: (s) => { raw = s; } };
}

export function localStorageAdapter(key = 'runwild-preview-v' + SCHEMA_VERSION) {
  return {
    read: () => { try { return localStorage.getItem(key); } catch { return null; } },
    write: (s) => { try { localStorage.setItem(key, s); } catch (e) { console.warn('Could not save preview data', e); } },
  };
}

export function inProcessLock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(() => fn());
    chain = run.catch(() => {});
    return run;
  };
}

export function defaultLock() {
  const inProc = inProcessLock();
  if (globalThis.navigator && navigator.locks && navigator.locks.request) {
    return (fn) => navigator.locks.request('runwild-preview-store', () => fn());
  }
  return inProc;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Stands in for the payment provider's webhook signing secret, which in production lives only
// on the server. In the preview it is visible in the browser and offers no real protection.
const PREVIEW_PROVIDER_SECRET = 'preview-only-not-secret';

export class Backend {
  constructor({ storage = memoryStorage(), now = () => Date.now(), lock = defaultLock(), seed = true } = {}) {
    this.storage = storage;
    this.now = now;
    this.lock = lock;
    this.seed = seed;
    this.sessions = new Map();
  }

  // ---------- state handling ----------

  _fresh() {
    const settings = defaultSettings();
    const base = {
      version: SCHEMA_VERSION, createdAt: this.now(), settings,
      registrations: [], charges: [], payments: [], providerEvents: [], lodgeRequests: [], sponsorships: [],
      pledges: [], stock: [], matches: [], contributions: [], outbox: [], audit: [], sessions: [],
    };
    if (this.seed) Object.assign(base, sampleData(this.now(), settings));
    base.audit.push({ id: uid(), at: this.now(), actor: 'system', action: 'preview.created', target: '', details: this.seed ? 'Preview created with sample data' : 'Empty preview created' });
    return base;
  }

  _load() {
    const raw = this.storage.read();
    if (raw) {
      try {
        const s = JSON.parse(raw);
        if (s.version === SCHEMA_VERSION) return s;
      } catch { /* fall through to a fresh state */ }
    }
    return this._fresh();
  }

  _save(state) { this.storage.write(JSON.stringify(state)); }

  async _read(fn) {
    return this.lock(async () => {
      const s = this._load();
      this._sweep(s);
      this._save(s);
      return fn(s);
    });
  }

  async _write(fn) {
    return this.lock(async () => {
      const s = this._load();
      this._sweep(s);
      const result = await fn(s);
      this._save(s);
      return result;
    });
  }

  _audit(s, actor, action, target, details = '') {
    s.audit.push({ id: uid(), at: this.now(), actor, action, target, details });
  }

  // Releases expired holds. Never promotes anyone from the waitlist.
  _sweep(s) {
    const now = this.now();
    for (const r of s.registrations) {
      if (r.status === 'reserved' && r.expiresAt && r.expiresAt <= now) {
        r.status = 'cancelled';
        r.cancelReason = 'reservation_expired';
        r.cancelledAt = now;
        this._audit(s, 'system', 'registration.expired', r.ref, 'Unpaid reservation expired; place released');
      }
    }
    for (const l of s.lodgeRequests) {
      if (l.status === 'awaiting_deposit' && l.expiresAt && l.expiresAt <= now) {
        l.status = 'expired';
        this._audit(s, 'system', 'lodge.expired', l.id, 'Deposit not received in time; beds released');
      }
    }
    for (const sp of s.sponsorships) {
      if (sp.status === 'reserved' && sp.expiresAt && sp.expiresAt <= now) {
        sp.status = 'expired';
        this._audit(s, 'system', 'sponsorship.expired', sp.ref, 'Water Point ' + sp.point + ' hold expired');
      }
    }
  }

  _uniqueRef(s, prefix) {
    const taken = new Set([...s.registrations.map((r) => r.ref), ...s.sponsorships.map((x) => x.ref), ...s.pledges.map((x) => x.ref), ...s.contributions.map((x) => x.ref)]);
    let ref;
    do { ref = makeRef(prefix); } while (taken.has(ref));
    return ref;
  }

  _charge(s, { kind, ownerType, ownerId, label, amount, ref, dueDate = null }) {
    const ch = { id: uid(), kind, ownerType, ownerId, label, amount, ref, dueDate, createdAt: this.now() };
    s.charges.push(ch);
    return ch;
  }

  _chargeView(s, ch) {
    const paid = sumPaid(s.payments, ch.id);
    return { ...ch, paid, outstanding: Math.max(0, ch.amount - paid) };
  }

  _queueMessage(s, { to, channel, subject, body, ref }) {
    const connected = channel === 'email' ? s.settings.messaging.emailConnected : s.settings.messaging.smsConnected;
    s.outbox.push({
      id: uid(), at: this.now(), channel, to, subject, body, ref,
      status: 'not_sent',
      reason: connected ? 'Delivery not attempted in the preview' : 'No ' + (channel === 'email' ? 'email' : 'SMS') + ' provider connected',
    });
  }

  // ---------- public, no personal data ----------

  async publicSummary() {
    return this._read((s) => {
      const now = this.now();
      const usage = poolUsage(s.registrations, s.settings, now);
      const st = s.settings;
      return {
        event: clone(st.event),
        pools: Object.fromEntries(Object.entries(usage).map(([k, u]) => [k, { limit: u.limit, remaining: u.remaining, full: u.remaining === 0 }])),
        fees: clone(st.fees),
        acceptWhileFeeUnconfirmed: st.acceptWhileFeeUnconfirmed,
        reservationHours: st.reservation.expiryHours,
        terms: clone(st.terms),
        lodge: {
          ratePerNight: st.lodge.ratePerNight, depositPercent: st.lodge.depositPercent, balanceDueDate: st.lodge.balanceDueDate,
          inventoryConfirmed: st.lodge.inventoryConfirmed, latePolicy: clone(st.lodge.latePolicy),
          nights: st.lodge.nights.map((n) => ({ date: n.date, available: Math.max(0, n.beds - this._bedsUsed(s, n.date)) })),
        },
        waterPoints: this._waterPointStatus(s, false),
        waterPointSettings: clone(st.waterPoints),
        donations: { ...clone(st.donations), progress: this._donationProgress(s) },
        payments: { previewProvider: st.payments.previewProvider, providerConnected: st.payments.providerConnected, providerName: st.payments.providerName, eftEnabled: st.payments.eftEnabled, eftDetails: st.payments.eftDetails, eftConfirmed: st.payments.eftConfirmed },
        buddy: clone(st.buddy),
        buddyCounts: {
          volunteers: s.registrations.filter((r) => r.status !== 'cancelled' && r.category !== 'community' && r.buddy && r.buddy.optIn && r.buddy.status !== 'withdrawn').length,
          requests: s.registrations.filter((r) => r.status !== 'cancelled' && r.category === 'community' && r.buddy && r.buddy.optIn && r.buddy.status !== 'withdrawn').length,
          matched: s.matches.filter((m) => m.status === 'introduced').length,
        },
      };
    });
  }

  _waterPointStatus(s, withPrivate) {
    const now = this.now();
    const out = [];
    for (let p = 1; p <= 5; p++) {
      const active = s.sponsorships.find((x) => x.point === p && (x.status === 'confirmed' || (x.status === 'reserved' && (!x.expiresAt || x.expiresAt > now))));
      const status = !active ? 'available' : active.status === 'confirmed' ? 'sponsored' : 'reserved';
      const row = { point: p, status };
      if (active && active.status === 'confirmed' && active.displayConsent) { row.sponsorName = active.name; row.logo = active.logo || ''; row.website = active.website || ''; }
      if (withPrivate && active) row.sponsorshipId = active.id;
      out.push(row);
    }
    return out;
  }

  _bedsUsed(s, date) {
    const now = this.now();
    return s.lodgeRequests.filter((l) => {
      const holds = l.status === 'confirmed' || l.status === 'paid_in_full' || (l.status === 'awaiting_deposit' && (!l.expiresAt || l.expiresAt > now));
      return holds && stayNights(l.arrival, l.departure).includes(date);
    }).length;
  }

  _donationProgress(s) {
    const community = s.registrations.filter((r) => r.category === 'community' && r.status !== 'cancelled' && r.kit);
    const count = (type, status) => s.stock.filter((x) => x.type === type && (!status || x.status === status)).length;
    const pledgedOutstanding = (type) => s.pledges.filter((p) => p.type === type && (p.status === 'pledged' || p.status === 'partially_received')).reduce((a, p) => a + (p.quantity - p.receivedQty), 0);
    return {
      shoesRequested: community.filter((r) => r.kit.needsShoes).length,
      kitRequested: community.filter((r) => r.kit.needsKit).length,
      shoesPledged: pledgedOutstanding('shoes'),
      kitPledged: pledgedOutstanding('kit'),
      shoesInHand: count('shoes'),
      kitInHand: count('kit'),
      shoesAllocated: count('shoes', 'allocated') + count('shoes', 'delivered'),
      kitAllocated: count('kit', 'allocated') + count('kit', 'delivered'),
    };
  }

  async checkInviteCode(code, category) {
    return this._read((s) => {
      const c = s.settings.inviteCodes.find((x) => x.code.toUpperCase() === String(code || '').trim().toUpperCase());
      return !!c && c.category === category && c.uses < c.maxUses;
    });
  }

  // ---------- registration ----------

  _validateRegistration(s, input) {
    const e = {};
    const cat = CATEGORIES[input.category];
    if (!cat) e.category = 'Choose a participant category.';
    if (!input.fullName || input.fullName.trim().length < 3) e.fullName = 'Enter the participant’s full name.';
    if (!validMobile(input.mobile)) e.mobile = 'Enter a South African mobile number, e.g. 082 123 4567.';
    if (cat && cat.emailRequired && !validEmail(input.email)) e.email = 'An email address is required for this category.';
    if (input.email && !validEmail(input.email)) e.email = 'Check the email address.';
    if (!input.emergencyName || input.emergencyName.trim().length < 2) e.emergencyName = 'Enter an emergency contact name.';
    if (!validMobile(input.emergencyMobile)) e.emergencyMobile = 'Enter an emergency contact number.';
    if (!DISTANCES[input.distance]) e.distance = 'Choose a distance.';
    if (cat && cat.employee && !String(input.employer || '').trim()) e.employer = 'Enter the company or employer.';
    if (!input.termsAccepted) e.termsAccepted = 'Please accept the event terms.';
    if (!input.privacyAck) e.privacyAck = 'Please confirm you have read the privacy notice.';
    if (cat && cat.adultOptions) {
      if (!input.lodge || typeof input.lodge.wanted !== 'boolean') e.lodge = 'Tell us whether you want to stay at Canvas Lodge.';
      else if (input.lodge.wanted) {
        const err = this._lodgeDateError(s, input.lodge.arrival, input.lodge.departure);
        if (err) e.lodgeDates = err;
      } else if (!input.transportAck) e.transportAck = 'Please acknowledge the transport arrangement.';
      if (input.buddy && input.buddy.optIn) {
        if (!input.buddy.experience) e.buddyExperience = 'Tell us a little about your running experience.';
        if (!input.buddy.availability) e.buddyAvailability = 'Tell us when you are available.';
      }
    }
    if (input.category === 'community') {
      if (!input.pickupAck) e.pickupAck = 'Please acknowledge the pickup arrangement.';
      const k = input.kit || {};
      if (!k.shoeSize) e.shoeSize = 'Enter a shoe size.';
      if (!k.shoeSystem) e.shoeSystem = 'Choose a sizing system.';
      if (!k.shirtSize) e.shirtSize = 'Choose a shirt/vest size.';
      if (!k.shortsSize) e.shortsSize = 'Choose a shorts size.';
    }
    if (Object.keys(e).length) throw new ValidationError('Please check the highlighted fields.', e);
  }

  _lodgeDateError(s, arrival, departure) {
    if (!arrival || !departure) return 'Choose arrival and departure dates.';
    const n = nightsBetween(arrival, departure);
    if (n < 1) return 'Departure must be after arrival.';
    const open = new Set(s.settings.lodge.nights.map((x) => x.date));
    const missing = stayNights(arrival, departure).filter((d) => !open.has(d));
    if (missing.length) return 'Canvas Lodge is not open on the night of ' + missing.map(formatDate).join(', ') + '.';
    return null;
  }

  async submitRegistration(input, { token } = {}) {
    return this._write((s) => {
      const organiser = token ? this._requireOrganiser(s, token) : null;
      if (input.clientRequestId) {
        const existing = s.registrations.find((r) => r.clientRequestId === input.clientRequestId);
        if (existing) return { ...this._confirmation(s, existing), duplicateSubmission: true };
      }
      this._validateRegistration(s, input);
      const mobile = normaliseMobile(input.mobile);
      const dupe = s.registrations.find((r) => r.status !== 'cancelled' && normaliseMobile(r.mobile) === mobile && r.fullName.trim().toLowerCase() === input.fullName.trim().toLowerCase());
      if (dupe) throw new ValidationError('An active entry already exists for this name and mobile number. Use “My entry” to view it, or contact the organisers.', { mobile: 'Already registered.' });
      const fee = entryFee(s.settings, input.category);
      if (!fee.confirmed && !s.settings.acceptWhileFeeUnconfirmed) {
        throw new ValidationError('Registration for ' + CATEGORIES[input.category].label.toLowerCase() + 's opens once the organisers confirm the entry fee.');
      }
      const cat = CATEGORIES[input.category];
      const reg = {
        id: uid(), ref: this._uniqueRef(s, 'RWM'), createdAt: this.now(), clientRequestId: input.clientRequestId || uid(),
        fullName: input.fullName.trim(), category: input.category, distance: input.distance,
        mobile, email: (input.email || '').trim(), emergencyName: input.emergencyName.trim(), emergencyMobile: normaliseMobile(input.emergencyMobile),
        employer: cat.employee ? String(input.employer || '').trim() : '',
        termsVersion: s.settings.terms.version, termsApprovedAtSubmission: s.settings.terms.approved,
        status: 'draft', expiresAt: null, verification: cat.employee ? 'pending' : 'n/a',
        assisted: !!organiser, assistedBy: organiser ? organiser.email : null,
        lodge: null, buddy: null, kit: null, transportAck: false, pickupAck: false,
      };
      if (cat.adultOptions) {
        reg.lodge = { wanted: !!input.lodge.wanted };
        reg.transportAck = !input.lodge.wanted && !!input.transportAck;
        reg.buddy = input.buddy && input.buddy.optIn
          ? { optIn: true, status: 'volunteered', preferredDistance: input.buddy.preferredDistance || input.distance, experience: input.buddy.experience, availability: input.buddy.availability, contactMethod: input.buddy.contactMethod || 'Phone', support: input.buddy.support || '' }
          : { optIn: false };
      }
      if (input.category === 'community') {
        reg.pickupAck = true;
        const k = input.kit;
        reg.kit = { shoeSize: String(k.shoeSize), shoeSystem: k.shoeSystem, shirtSize: k.shirtSize, shortsSize: k.shortsSize, needsShoes: !!k.needsShoes, needsKit: !!k.needsKit };
        reg.buddy = { optIn: !!(input.buddy && input.buddy.optIn), status: input.buddy && input.buddy.optIn ? 'awaiting_match' : undefined };
      }
      s.registrations.push(reg);

      if (cat.employee) {
        const code = s.settings.inviteCodes.find((x) => x.code.toUpperCase() === String(input.inviteCode || '').trim().toUpperCase());
        if (organiser && input.organiserVerified) {
          reg.verification = 'verified';
          reg.verifiedBy = organiser.email;
        } else if (code && code.category === input.category && code.uses < code.maxUses) {
          code.uses += 1;
          reg.verification = 'verified';
          reg.verifiedBy = 'invite code ' + code.code;
        } else if (input.inviteCode) {
          reg.inviteCodeTried = String(input.inviteCode).slice(0, 40);
        }
      }
      if (reg.verification !== 'pending') this._allocate(s, reg);

      if (reg.lodge && reg.lodge.wanted) this._createLodgeRequest(s, reg, input.lodge.arrival, input.lodge.departure);

      this._audit(s, organiser ? organiser.email : 'participant', 'registration.created', reg.ref,
        CATEGORIES[reg.category].label + ', ' + DISTANCES[reg.distance] + ' → ' + reg.status + (organiser ? ' (organiser-assisted)' : ''));
      const conf = this._confirmation(s, reg);
      this._sendConfirmation(s, reg, conf);
      return conf;
    });
  }

  // The atomic step: runs inside the write lock, so the usage count and the reservation
  // cannot interleave with another registration.
  _allocate(s, reg) {
    const now = this.now();
    const pool = CATEGORIES[reg.category].pool;
    if (pool) {
      const usage = poolUsage(s.registrations.filter((r) => r.id !== reg.id), s.settings, now)[pool];
      if (usage.used >= usage.limit) {
        reg.status = 'waitlisted';
        reg.expiresAt = null;
        return;
      }
    }
    this._hold(s, reg);
  }

  _hold(s, reg) {
    const fee = entryFee(s.settings, reg.category);
    reg.holdReason = null;
    if (!fee.confirmed) {
      reg.status = 'reserved';
      reg.expiresAt = null;
      reg.holdReason = 'fee_unconfirmed';
      return;
    }
    if (fee.amount === 0) {
      reg.status = 'confirmed';
      reg.expiresAt = null;
      return;
    }
    reg.status = 'reserved';
    reg.expiresAt = this.now() + s.settings.reservation.expiryHours * HOUR;
    let ch = s.charges.find((c) => c.ownerId === reg.id && c.kind === 'entry');
    if (!ch) ch = this._charge(s, { kind: 'entry', ownerType: 'registration', ownerId: reg.id, label: fee.label, amount: fee.amount, ref: reg.ref + '-E' });
    if (sumPaid(s.payments, ch.id) >= ch.amount) { reg.status = 'confirmed'; reg.expiresAt = null; }
  }

  _createLodgeRequest(s, reg, arrival, departure) {
    const st = s.settings.lodge;
    const q = lodgeQuote({ nights: nightsBetween(arrival, departure), ratePerNight: st.ratePerNight, depositPercent: st.depositPercent });
    const bookedOn = todayJHB(new Date(this.now()));
    const due = lodgeBalanceDue({ bookedOn, standardDueDate: st.balanceDueDate, latePolicy: st.latePolicy });
    const lr = {
      id: uid(), registrationId: reg.id, arrival, departure, ...q, requestedOn: bookedOn,
      balanceDue: due.date, balanceNote: due.note, status: 'requested', expiresAt: null, createdAt: this.now(), note: '',
    };
    s.lodgeRequests.push(lr);
    reg.lodge.requestId = lr.id;
    if (reg.status === 'waitlisted' || reg.status === 'draft') {
      lr.note = 'On hold until the race entry has a place.';
    } else {
      this._tryHoldBeds(s, lr, reg);
    }
    this._audit(s, 'participant', 'lodge.requested', reg.ref, q.nights + ' night(s), ' + arrival + ' to ' + departure + ' → ' + lr.status);
    return lr;
  }

  _tryHoldBeds(s, lr, reg) {
    const st = s.settings.lodge;
    const ok = stayNights(lr.arrival, lr.departure).every((d) => {
      const night = st.nights.find((n) => n.date === d);
      return night && this._bedsUsed(s, d) < night.beds;
    });
    if (!ok) { lr.status = 'requested'; lr.note = 'No beds free on at least one night – the organisers will be in touch.'; return false; }
    lr.status = 'awaiting_deposit';
    lr.note = '';
    lr.expiresAt = this.now() + st.holdHours * HOUR;
    if (!s.charges.find((c) => c.ownerId === lr.id && c.kind === 'lodge_deposit')) {
      this._charge(s, { kind: 'lodge_deposit', ownerType: 'lodge', ownerId: lr.id, label: 'Canvas Lodge deposit (' + st.depositPercent + '%)', amount: lr.deposit, ref: reg.ref + '-LD' });
      this._charge(s, { kind: 'lodge_balance', ownerType: 'lodge', ownerId: lr.id, label: 'Canvas Lodge balance (' + (100 - st.depositPercent) + '%)', amount: lr.balance, ref: reg.ref + '-LB', dueDate: lr.balanceDue });
    }
    return true;
  }

  _confirmation(s, reg) {
    const st = s.settings;
    const charges = s.charges.filter((c) => c.ownerId === reg.id || (reg.lodge && c.ownerId === reg.lodge.requestId)).map((c) => this._chargeView(s, c));
    const lodge = reg.lodge && reg.lodge.requestId ? s.lodgeRequests.find((l) => l.id === reg.lodge.requestId) : null;
    const fee = entryFee(st, reg.category);
    const pool = CATEGORIES[reg.category].pool;
    return {
      ref: reg.ref, status: reg.status, verification: reg.verification, holdReason: reg.holdReason || null,
      expiresAt: reg.expiresAt, cancelReason: reg.cancelReason || null,
      fullName: reg.fullName, category: reg.category, distance: reg.distance, assisted: reg.assisted,
      fee, pool, charges,
      lodge: lodge ? clone(lodge) : null,
      lodgeWanted: reg.lodge ? reg.lodge.wanted : null,
      transportAck: reg.transportAck,
      buddy: reg.buddy ? { optIn: !!reg.buddy.optIn, status: reg.buddy.status || null } : null,
      event: { date: st.event.date, venue: st.event.venue, startTime: st.event.startTimeConfirmed ? st.event.startTime : '', pickupPlace: st.event.pickupPlace, pickupTime: st.event.pickupTime, pickupFullAddress: st.event.pickupAddressConfirmed ? st.event.pickupFullAddress : '' },
      payments: { previewProvider: st.payments.previewProvider, providerConnected: st.payments.providerConnected, eftEnabled: st.payments.eftEnabled, eftDetails: st.payments.eftDetails, eftConfirmed: st.payments.eftConfirmed },
    };
  }

  _sendConfirmation(s, reg, conf) {
    const lines = [
      'Run Wild Melorane – ' + formatDate(conf.event.date),
      'Reference: ' + conf.ref,
      'Status: ' + conf.status,
      'Category: ' + CATEGORIES[reg.category].label + ' · ' + DISTANCES[reg.distance],
    ];
    for (const c of conf.charges) lines.push(c.label + ': R' + (c.amount / 100) + ' – outstanding R' + (c.outstanding / 100));
    if (reg.category === 'community') lines.push('Pickup: ' + conf.event.pickupPlace + ' at ' + conf.event.pickupTime + ' on ' + formatDate(conf.event.date) + '.');
    else lines.push('Early start – exact time to be confirmed. Arrive at ' + conf.event.venue + ' in good time.');
    const body = lines.join('\n');
    if (reg.email) this._queueMessage(s, { to: reg.email, channel: 'email', subject: 'Run Wild Melorane – ' + conf.ref, body, ref: reg.ref });
    this._queueMessage(s, { to: reg.mobile, channel: 'sms', subject: '', body: 'Run Wild Melorane ref ' + conf.ref + ' – status: ' + conf.status, ref: reg.ref });
  }

  // ---------- participant self-service ----------

  _findOwn(s, ref, mobile) {
    const r = s.registrations.find((x) => x.ref.toUpperCase() === String(ref || '').trim().toUpperCase());
    if (!r || normaliseMobile(r.mobile) !== normaliseMobile(mobile)) throw new ValidationError('We could not find an entry with that reference and mobile number.');
    return r;
  }

  async myEntry(ref, mobile) {
    return this._read((s) => {
      const r = this._findOwn(s, ref, mobile);
      const conf = this._confirmation(s, r);
      conf.match = this._matchViewFor(s, r);
      conf.kit = r.kit ? clone(r.kit) : null;
      return conf;
    });
  }

  _matchViewFor(s, r) {
    const m = s.matches.find((x) => (x.volunteerId === r.id || x.communityId === r.id) && x.status !== 'ended');
    if (!m) return null;
    const mine = m.volunteerId === r.id ? 'volunteer' : 'community';
    const other = s.registrations.find((x) => x.id === (mine === 'volunteer' ? m.communityId : m.volunteerId));
    const both = m.consentVolunteer && m.consentCommunity;
    return {
      id: m.id, role: mine, status: m.status,
      myConsent: mine === 'volunteer' ? m.consentVolunteer : m.consentCommunity,
      otherConsent: mine === 'volunteer' ? m.consentCommunity : m.consentVolunteer,
      partnerFirstName: other ? other.fullName.split(' ')[0] : '',
      // Contact details are only released once both people have agreed to the introduction.
      partnerContact: both && other ? { name: other.fullName, mobile: other.mobile, email: other.email } : null,
    };
  }

  async consentToMatch(ref, mobile, agree) {
    return this._write((s) => {
      const r = this._findOwn(s, ref, mobile);
      const m = s.matches.find((x) => (x.volunteerId === r.id || x.communityId === r.id) && x.status !== 'ended');
      if (!m) throw new ValidationError('There is no buddy introduction waiting for you.');
      this._setConsent(s, m, m.volunteerId === r.id ? 'volunteer' : 'community', agree, 'participant');
      return this._matchViewFor(s, r);
    });
  }

  _setConsent(s, m, side, agree, actor) {
    if (side === 'volunteer') m.consentVolunteer = !!agree; else m.consentCommunity = !!agree;
    if (!agree) {
      m.status = 'ended';
      for (const id of [m.volunteerId, m.communityId]) {
        const reg = s.registrations.find((x) => x.id === id);
        if (reg && reg.buddy && reg.buddy.status === 'matched') reg.buddy.status = 'awaiting_match';
      }
    } else if (m.consentVolunteer && m.consentCommunity) {
      m.status = 'introduced';
    }
    this._audit(s, actor, 'buddy.consent', m.id, side + (agree ? ' agreed' : ' declined') + ' to introduction');
  }

  async updateMyBuddy(ref, mobile, buddy) {
    return this._write((s) => {
      const r = this._findOwn(s, ref, mobile);
      if (r.status === 'cancelled') throw new ValidationError('This entry is cancelled.');
      if (r.category === 'melorane_employee') throw new ValidationError('The Run Buddy programme is for group employees, other participants and community members.');
      if (!buddy.optIn) {
        r.buddy = { ...(r.buddy || {}), optIn: false, status: 'withdrawn' };
        for (const m of s.matches.filter((x) => (x.volunteerId === r.id || x.communityId === r.id) && x.status !== 'ended')) m.status = 'ended';
      } else if (r.category === 'community') {
        r.buddy = { optIn: true, status: 'awaiting_match' };
      } else {
        if (!buddy.experience || !buddy.availability) throw new ValidationError('Please add your experience and availability.');
        r.buddy = { optIn: true, status: 'volunteered', preferredDistance: buddy.preferredDistance || r.distance, experience: buddy.experience, availability: buddy.availability, contactMethod: buddy.contactMethod || 'Phone', support: buddy.support || '' };
      }
      this._audit(s, 'participant', 'buddy.updated', r.ref, r.buddy.status);
      return this._confirmation(s, r);
    });
  }

  async requestLodgeForEntry(ref, mobile, arrival, departure) {
    return this._write((s) => {
      const r = this._findOwn(s, ref, mobile);
      if (!CATEGORIES[r.category].adultOptions) throw new ValidationError('Canvas Lodge is offered to group employees and other participants.');
      if (r.status === 'cancelled') throw new ValidationError('This entry is cancelled.');
      const open = r.lodge && r.lodge.requestId && s.lodgeRequests.find((l) => l.id === r.lodge.requestId && !['declined', 'cancelled', 'expired'].includes(l.status));
      if (open) throw new ValidationError('You already have an accommodation request.');
      const err = this._lodgeDateError(s, arrival, departure);
      if (err) throw new ValidationError(err);
      r.lodge = { wanted: true };
      this._createLodgeRequest(s, r, arrival, departure);
      return this._confirmation(s, r);
    });
  }

  // ---------- payments ----------

  async startCheckout(chargeRef) {
    return this._read((s) => {
      const ch = s.charges.find((c) => c.ref === chargeRef);
      if (!ch) throw new ValidationError('Unknown payment reference.');
      if (!s.settings.payments.previewProvider && !s.settings.payments.providerConnected) throw new ValidationError('Online payment is not available yet.');
      const v = this._chargeView(s, ch);
      if (v.outstanding <= 0) throw new ValidationError('This item is already paid.');
      return { chargeRef: ch.ref, label: ch.label, amount: v.outstanding, sessionId: 'cs_' + uid().slice(0, 12) };
    });
  }

  // Simulates the provider's server signing its notification. Only used by the preview checkout.
  async previewSignNotification(n) {
    return hmac(PREVIEW_PROVIDER_SECRET, [n.eventId, n.chargeRef, n.amount, n.status].join('|'));
  }

  // Payment notification endpoint (the provider's webhook). The only online path that marks money
  // as received. A browser redirect never does.
  async providerNotification(n) {
    const expected = await hmac(PREVIEW_PROVIDER_SECRET, [n.eventId, n.chargeRef, n.amount, n.status].join('|'));
    return this._write((s) => {
      if (n.signature !== expected) {
        this._audit(s, 'provider', 'payment.rejected', n.chargeRef, 'Invalid signature');
        return { ok: false, reason: 'invalid_signature' };
      }
      if (s.providerEvents.includes(n.eventId)) return { ok: true, duplicate: true };
      s.providerEvents.push(n.eventId);
      if (n.status !== 'paid') { this._audit(s, 'provider', 'payment.' + n.status, n.chargeRef); return { ok: true, ignored: true }; }
      const ch = s.charges.find((c) => c.ref === n.chargeRef);
      if (!ch) { this._audit(s, 'provider', 'payment.unmatched', n.chargeRef, 'No matching charge'); return { ok: false, reason: 'unknown_charge' }; }
      this._applyPayment(s, ch, Number(n.amount), { method: 'provider', providerEventId: n.eventId }, 'provider');
      return { ok: true };
    });
  }

  _applyPayment(s, ch, amount, meta, actor) {
    const before = sumPaid(s.payments, ch.id);
    const p = { id: uid(), chargeId: ch.id, amount, status: 'received', at: this.now(), ...meta };
    if (before >= ch.amount) p.flag = 'Charge was already paid – possible duplicate payment, review for refund.';
    s.payments.push(p);
    this._audit(s, actor, 'payment.received', ch.ref, 'R' + amount / 100 + ' via ' + meta.method + (p.flag ? ' (flagged)' : ''));
    if (before < ch.amount && before + amount >= ch.amount) this._onChargePaid(s, ch);
  }

  _onChargePaid(s, ch) {
    const now = this.now();
    if (ch.kind === 'entry') {
      const reg = s.registrations.find((r) => r.id === ch.ownerId);
      if (!reg) return;
      if (reg.status === 'reserved') { reg.status = 'confirmed'; reg.expiresAt = null; }
      else if (reg.status === 'cancelled' && reg.cancelReason === 'reservation_expired') {
        const pool = CATEGORIES[reg.category].pool;
        const u = pool ? poolUsage(s.registrations, s.settings, now)[pool] : null;
        if (!u || u.used < u.limit) { reg.status = 'confirmed'; reg.cancelReason = null; reg.expiresAt = null; }
        else reg.attention = 'Payment received after the reservation expired and the pool is now full. Organiser decision or refund needed.';
      } else if (reg.status !== 'confirmed') reg.attention = 'Payment received while entry was ' + reg.status + '. Review needed.';
      this._audit(s, 'system', 'registration.' + reg.status, reg.ref, 'Entry fee paid');
      this._sendConfirmation(s, reg, this._confirmation(s, reg));
    } else if (ch.kind === 'lodge_deposit') {
      const lr = s.lodgeRequests.find((l) => l.id === ch.ownerId);
      if (!lr) return;
      if (lr.status === 'awaiting_deposit' || lr.status === 'requested' || lr.status === 'expired') {
        const reg = s.registrations.find((r) => r.id === lr.registrationId);
        if (lr.status !== 'awaiting_deposit') {
          lr.status = 'requested';
          if (!this._tryHoldBeds(s, lr, reg)) { lr.attention = 'Deposit received but beds are no longer free. Organiser decision or refund needed.'; return; }
        }
        lr.status = 'confirmed';
        lr.expiresAt = null;
        this._audit(s, 'system', 'lodge.confirmed', reg ? reg.ref : lr.id, 'Deposit received');
      }
    } else if (ch.kind === 'lodge_balance') {
      const lr = s.lodgeRequests.find((l) => l.id === ch.ownerId);
      if (lr && lr.status === 'confirmed') lr.status = 'paid_in_full';
    } else if (ch.kind === 'sponsorship') {
      const sp = s.sponsorships.find((x) => x.id === ch.ownerId);
      if (!sp) return;
      const clash = s.sponsorships.find((x) => x.id !== sp.id && x.point === sp.point && (x.status === 'confirmed' || (x.status === 'reserved' && (!x.expiresAt || x.expiresAt > now))));
      if (clash) { sp.attention = 'Payment received after hold expired and the point was taken. Refund or offer another point.'; return; }
      sp.status = 'confirmed';
      sp.expiresAt = null;
      this._audit(s, 'system', 'sponsorship.confirmed', sp.ref, 'Water Point ' + sp.point);
    } else if (ch.kind === 'donation') {
      const c = s.contributions.find((x) => x.id === ch.ownerId);
      if (c) c.status = 'paid';
    }
  }

  // ---------- water points ----------

  async submitSponsorship(input) {
    return this._write((s) => {
      if (input.clientRequestId) {
        const ex = s.sponsorships.find((x) => x.clientRequestId === input.clientRequestId);
        if (ex) return { ...this._sponsorshipView(s, ex), duplicateSubmission: true };
      }
      const e = {};
      const point = Number(input.point);
      if (!(point >= 1 && point <= 5)) e.point = 'Choose a water point.';
      if (!input.name || input.name.trim().length < 2) e.name = 'Enter the individual or company name.';
      if (!input.contactPerson) e.contactPerson = 'Enter a contact person.';
      if (!validEmail(input.email)) e.email = 'Enter a valid email address.';
      if (!input.phone || String(input.phone).replace(/\D/g, '').length < 9) e.phone = 'Enter a telephone number.';
      if (input.logo && input.logo.length > 400000) e.logo = 'Please use a logo under 300 KB.';
      if (input.website && !/^https?:\/\//i.test(input.website)) e.website = 'Start the website with https://';
      if (Object.keys(e).length) throw new ValidationError('Please check the highlighted fields.', e);
      const taken = this._waterPointStatus(s, false).find((w) => w.point === point);
      if (taken.status !== 'available') throw new ValidationError('Water Point ' + point + ' has just been ' + (taken.status === 'sponsored' ? 'sponsored' : 'reserved') + ' by someone else. Please choose another point.', { point: 'No longer available.' });
      const sp = {
        id: uid(), ref: this._uniqueRef(s, 'RWM-WS'), clientRequestId: input.clientRequestId || uid(), point,
        name: input.name.trim(), contactPerson: input.contactPerson.trim(), email: input.email.trim(), phone: input.phone,
        website: input.website || '', logo: input.logo || '', billing: input.billing || '', displayConsent: !!input.displayConsent,
        status: 'reserved', createdAt: this.now(), expiresAt: this.now() + s.settings.waterPoints.holdHours * HOUR,
      };
      s.sponsorships.push(sp);
      this._charge(s, { kind: 'sponsorship', ownerType: 'sponsorship', ownerId: sp.id, label: 'Water Point ' + point + ' sponsorship', amount: s.settings.waterPoints.price, ref: sp.ref });
      this._audit(s, 'public', 'sponsorship.reserved', sp.ref, 'Water Point ' + point);
      this._queueMessage(s, { to: sp.email, channel: 'email', subject: 'Water Point ' + point + ' – ' + sp.ref, body: 'Thank you. Water Point ' + point + ' is held for you until payment is verified.', ref: sp.ref });
      return this._sponsorshipView(s, sp);
    });
  }

  _sponsorshipView(s, sp) {
    const ch = s.charges.find((c) => c.ownerId === sp.id);
    return { ref: sp.ref, point: sp.point, status: sp.status, expiresAt: sp.expiresAt, name: sp.name, charge: ch ? this._chargeView(s, ch) : null };
  }

  // ---------- donations ----------

  async submitPledge(input) {
    return this._write((s) => {
      if (input.clientRequestId) {
        const ex = s.pledges.find((x) => x.clientRequestId === input.clientRequestId);
        if (ex) return { ...clone(ex), duplicateSubmission: true };
      }
      const e = {};
      if (!input.donor || input.donor.trim().length < 2) e.donor = 'Enter your name.';
      if (!validEmail(input.email) && !validMobile(input.phone)) e.email = 'Give an email address or mobile number.';
      if (!['shoes', 'kit'].includes(input.type)) e.type = 'Choose what you are donating.';
      const q = Number(input.quantity);
      if (!(q >= 1 && q <= 100)) e.quantity = 'Enter a quantity from 1 to 100.';
      if (input.type === 'shoes' && (!input.size || !input.sizeSystem)) e.size = 'Enter the shoe size and sizing system.';
      if (input.type === 'kit' && (!input.shirtSize || !input.shortsSize)) e.shirtSize = 'Enter vest and shorts sizes.';
      if (!s.settings.donations.conditionCriteria.includes(input.condition)) e.condition = 'Choose the condition.';
      if (!input.delivery) e.delivery = 'Tell us how the items will reach us.';
      if (Object.keys(e).length) throw new ValidationError('Please check the highlighted fields.', e);
      const p = {
        id: uid(), ref: this._uniqueRef(s, 'RWM-DP'), clientRequestId: input.clientRequestId || uid(), donor: input.donor.trim(), email: input.email || '', phone: input.phone || '',
        type: input.type, quantity: q, size: input.size || '', sizeSystem: input.sizeSystem || '', shirtSize: input.shirtSize || '', shortsSize: input.shortsSize || '',
        condition: input.condition, delivery: input.delivery, notes: input.notes || '', status: 'pledged', receivedQty: 0, createdAt: this.now(),
      };
      s.pledges.push(p);
      this._audit(s, 'public', 'pledge.created', p.ref, q + ' × ' + p.type);
      if (p.email) this._queueMessage(s, { to: p.email, channel: 'email', subject: 'Your Run Wild pledge ' + p.ref, body: 'Thank you for pledging ' + q + ' × ' + (p.type === 'shoes' ? 'pairs of running shoes' : 'running kit sets') + '.', ref: p.ref });
      return clone(p);
    });
  }

  async submitContribution(input) {
    return this._write((s) => {
      const d = s.settings.donations;
      const price = input.type === 'shoes' ? d.shoePrice : d.kitPrice;
      if (!d.financialEnabled || !price) throw new ValidationError('Financial contributions open once item prices and payment arrangements are confirmed.');
      if (!s.settings.payments.previewProvider && !s.settings.payments.providerConnected && !s.settings.payments.eftEnabled) throw new ValidationError('No payment method is configured yet.');
      const q = Number(input.quantity);
      if (!(q >= 1 && q <= 50)) throw new ValidationError('Enter a quantity from 1 to 50.');
      if (!input.donor || !validEmail(input.email)) throw new ValidationError('Enter your name and a valid email address.');
      const c = { id: uid(), ref: this._uniqueRef(s, 'RWM-DF'), donor: input.donor, email: input.email, type: input.type, quantity: q, amount: price * q, status: 'awaiting_payment', createdAt: this.now() };
      s.contributions.push(c);
      const ch = this._charge(s, { kind: 'donation', ownerType: 'contribution', ownerId: c.id, label: q + ' × ' + (input.type === 'shoes' ? 'shoes' : 'kit') + ' contribution', amount: c.amount, ref: c.ref });
      this._audit(s, 'public', 'contribution.created', c.ref, 'R' + c.amount / 100);
      return { ...clone(c), charge: this._chargeView(s, ch) };
    });
  }

  // ---------- organiser ----------

  _requireOrganiser(s, token) {
    const sess = (s.sessions || []).find((x) => x.token === token && x.expiresAt > this.now());
    if (!sess) throw new AuthError();
    return sess;
  }

  async login(email, password) {
    return this._write((s) => {
      const o = s.settings.organisers.find((x) => x.email.toLowerCase() === String(email || '').trim().toLowerCase() && x.password === password);
      if (!o) { this._audit(s, String(email || ''), 'auth.failed', ''); throw new AuthError('Email or password not recognised.'); }
      const token = uid();
      s.sessions = (s.sessions || []).filter((x) => x.expiresAt > this.now());
      s.sessions.push({ token, email: o.email, name: o.name, expiresAt: this.now() + 8 * HOUR });
      this._audit(s, o.email, 'auth.signed_in', '');
      return { token, email: o.email, name: o.name };
    });
  }

  async logout(token) {
    return this._write((s) => { s.sessions = (s.sessions || []).filter((x) => x.token !== token); });
  }

  async dashboard(token) {
    return this._read((s) => {
      const me = this._requireOrganiser(s, token);
      const out = clone(s);
      delete out.sessions;
      out.settings.organisers = out.settings.organisers.map((o) => ({ email: o.email, name: o.name }));
      out.me = { email: me.email, name: me.name };
      out.now = this.now();
      out.usage = poolUsage(s.registrations, s.settings, this.now());
      out.chargeViews = s.charges.map((c) => this._chargeView(s, c));
      out.waterPointStatus = this._waterPointStatus(s, true);
      out.donationProgress = this._donationProgress(s);
      out.lodgeNights = s.settings.lodge.nights.map((n) => ({ ...n, used: this._bedsUsed(s, n.date) }));
      return out;
    });
  }

  async organiserAction(token, action, args = {}) {
    return this._write((s) => {
      const me = this._requireOrganiser(s, token);
      const who = me.email;
      const reg = args.regId ? s.registrations.find((r) => r.id === args.regId) : null;
      if (args.regId && !reg) throw new ValidationError('Registration not found.');
      switch (action) {
        case 'verifyEmployee': {
          if (reg.verification !== 'pending') throw new ValidationError('This entry is not awaiting verification.');
          if (args.approve) {
            reg.verification = 'verified'; reg.verifiedBy = who;
            this._allocate(s, reg);
            if (reg.lodge && reg.lodge.requestId) {
              const lr = s.lodgeRequests.find((l) => l.id === reg.lodge.requestId);
              if (lr && lr.status === 'requested' && reg.status !== 'waitlisted') this._tryHoldBeds(s, lr, reg);
            }
            this._audit(s, who, 'employee.verified', reg.ref, '→ ' + reg.status);
          } else if (args.reassignTo) {
            const from = reg.category;
            reg.category = args.reassignTo; reg.verification = 'n/a'; reg.employer = '';
            this._allocate(s, reg);
            this._audit(s, who, 'employee.reassigned', reg.ref, from + ' → ' + reg.category + ', ' + reg.status);
          } else {
            reg.verification = 'declined'; reg.status = 'cancelled'; reg.cancelReason = 'Employee verification declined';
            this._audit(s, who, 'employee.declined', reg.ref);
          }
          this._sendConfirmation(s, reg, this._confirmation(s, reg));
          return this._confirmation(s, reg);
        }
        case 'offerPlace': {
          if (reg.status !== 'waitlisted') throw new ValidationError('Only waitlisted entries can be offered a place.');
          const pool = CATEGORIES[reg.category].pool;
          const u = poolUsage(s.registrations, s.settings, this.now())[pool];
          if (u.used >= u.limit) throw new ValidationError('There is no free place in this pool.');
          this._hold(s, reg);
          if (reg.lodge && reg.lodge.requestId) {
            const lr = s.lodgeRequests.find((l) => l.id === reg.lodge.requestId);
            if (lr && lr.status === 'requested') this._tryHoldBeds(s, lr, reg);
          }
          this._audit(s, who, 'waitlist.offered', reg.ref, '→ ' + reg.status);
          this._sendConfirmation(s, reg, this._confirmation(s, reg));
          return this._confirmation(s, reg);
        }
        case 'cancelRegistration': {
          if (reg.status === 'cancelled') throw new ValidationError('Already cancelled.');
          const prev = reg.status;
          reg.status = 'cancelled'; reg.cancelReason = args.reason || 'Cancelled by organiser'; reg.cancelledAt = this.now(); reg.expiresAt = null;
          const paid = s.charges.filter((c) => c.ownerId === reg.id).reduce((a, c) => a + sumPaid(s.payments, c.id), 0);
          if (paid) reg.attention = 'Entry fee of R' + paid / 100 + ' was paid – decide on refund or donation.';
          this._audit(s, who, 'registration.cancelled', reg.ref, prev + ' → cancelled: ' + reg.cancelReason);
          return null;
        }
        case 'recordEft': {
          const ch = s.charges.find((c) => c.id === args.chargeId);
          if (!ch) throw new ValidationError('Charge not found.');
          const amount = Math.round(Number(args.amount) * 100);
          if (!(amount > 0)) throw new ValidationError('Enter the amount received.');
          if (!args.bankRef) throw new ValidationError('Enter the bank statement reference.');
          if (s.payments.some((p) => p.chargeId === ch.id && p.bankRef === args.bankRef)) throw new ValidationError('This bank reference has already been recorded for this charge.');
          this._applyPayment(s, ch, amount, { method: 'eft', bankRef: args.bankRef, recordedBy: who }, who);
          return null;
        }
        case 'issueFeeRequests': {
          const fee = entryFee(s.settings, args.category);
          if (!fee.confirmed) throw new ValidationError('Confirm the fee for this category first.');
          let n = 0;
          for (const r of s.registrations.filter((x) => x.category === args.category && x.status === 'reserved' && x.holdReason === 'fee_unconfirmed')) { this._hold(s, r); n++; }
          this._audit(s, who, 'fees.issued', args.category, n + ' held entries now ' + (fee.amount ? 'awaiting payment' : 'confirmed'));
          return n;
        }
        case 'lodge': {
          const lr = s.lodgeRequests.find((l) => l.id === args.id);
          if (!lr) throw new ValidationError('Request not found.');
          const r = s.registrations.find((x) => x.id === lr.registrationId);
          if (args.op === 'hold') { if (!this._tryHoldBeds(s, lr, r)) throw new ValidationError('No beds free for those nights.'); }
          else if (args.op === 'decline') { lr.status = 'declined'; lr.expiresAt = null; }
          else if (args.op === 'cancel') { lr.status = 'cancelled'; lr.expiresAt = null; }
          this._audit(s, who, 'lodge.' + args.op, r ? r.ref : lr.id, '→ ' + lr.status);
          return null;
        }
        case 'cancelSponsorship': {
          const sp = s.sponsorships.find((x) => x.id === args.id);
          if (!sp) throw new ValidationError('Sponsorship not found.');
          sp.status = 'cancelled'; sp.expiresAt = null;
          this._audit(s, who, 'sponsorship.cancelled', sp.ref, 'Water Point ' + sp.point);
          return null;
        }
        case 'receivePledge': {
          const p = s.pledges.find((x) => x.id === args.id);
          if (!p) throw new ValidationError('Pledge not found.');
          const q = Number(args.quantity);
          if (!(q >= 1 && q <= p.quantity - p.receivedQty)) throw new ValidationError('Enter a quantity between 1 and ' + (p.quantity - p.receivedQty) + '.');
          for (let i = 0; i < q; i++) s.stock.push({ id: uid(), type: p.type, size: p.size, sizeSystem: p.sizeSystem, shirtSize: p.shirtSize, shortsSize: p.shortsSize, source: 'pledge', sourceId: p.id, status: 'in_stock', allocatedTo: null, receivedAt: this.now() });
          p.receivedQty += q;
          p.status = p.receivedQty >= p.quantity ? 'received' : 'partially_received';
          this._audit(s, who, 'pledge.received', p.ref, q + ' received (' + p.receivedQty + '/' + p.quantity + ')');
          return null;
        }
        case 'cancelPledge': {
          const p = s.pledges.find((x) => x.id === args.id);
          p.status = p.receivedQty ? 'received' : 'cancelled';
          p.quantity = p.receivedQty || p.quantity;
          this._audit(s, who, 'pledge.closed', p.ref);
          return null;
        }
        case 'recordPurchase': {
          const q = Number(args.quantity);
          if (!['shoes', 'kit'].includes(args.type) || !(q >= 1 && q <= 100)) throw new ValidationError('Choose an item type and quantity.');
          for (let i = 0; i < q; i++) s.stock.push({ id: uid(), type: args.type, size: args.size || '', sizeSystem: args.sizeSystem || '', shirtSize: args.shirtSize || '', shortsSize: args.shortsSize || '', source: 'purchase', sourceId: args.note || '', status: 'in_stock', allocatedTo: null, receivedAt: this.now() });
          this._audit(s, who, 'stock.purchased', args.type, q + ' added');
          return null;
        }
        case 'allocate': {
          const item = s.stock.find((x) => x.id === args.stockId);
          if (!item || item.status !== 'in_stock') throw new ValidationError('That item is not in stock.');
          if (!reg || reg.category !== 'community') throw new ValidationError('Choose a community participant.');
          if (s.stock.some((x) => x.allocatedTo === reg.id && x.type === item.type && x.status !== 'in_stock')) throw new ValidationError('This participant already has ' + item.type + ' allocated.');
          item.status = 'allocated'; item.allocatedTo = reg.id;
          this._audit(s, who, 'stock.allocated', reg.ref, item.type);
          return null;
        }
        case 'deliver': {
          const item = s.stock.find((x) => x.id === args.stockId);
          if (!item || item.status !== 'allocated') throw new ValidationError('Allocate the item first.');
          item.status = 'delivered';
          this._audit(s, who, 'stock.delivered', item.allocatedTo, item.type);
          return null;
        }
        case 'unallocate': {
          const item = s.stock.find((x) => x.id === args.stockId);
          item.status = 'in_stock'; item.allocatedTo = null;
          this._audit(s, who, 'stock.unallocated', item.id, item.type);
          return null;
        }
        case 'buddyStatus': {
          if (!reg.buddy) throw new ValidationError('Not in the buddy programme.');
          reg.buddy.status = args.status;
          if (args.status === 'withdrawn') { reg.buddy.optIn = false; for (const m of s.matches.filter((x) => (x.volunteerId === reg.id || x.communityId === reg.id) && x.status !== 'ended')) m.status = 'ended'; }
          this._audit(s, who, 'buddy.status', reg.ref, args.status);
          return null;
        }
        case 'proposeMatch': {
          const v = s.registrations.find((x) => x.id === args.volunteerId);
          const c = s.registrations.find((x) => x.id === args.communityId);
          if (!v || !c || !v.buddy || !v.buddy.optIn || !c.buddy || !c.buddy.optIn) throw new ValidationError('Both people must have opted in.');
          if (s.matches.some((m) => m.status !== 'ended' && (m.volunteerId === v.id || m.communityId === c.id))) throw new ValidationError('One of them already has an active match.');
          s.matches.push({ id: uid(), volunteerId: v.id, communityId: c.id, status: 'proposed', consentVolunteer: false, consentCommunity: false, createdAt: this.now() });
          v.buddy.status = 'matched'; c.buddy.status = 'matched';
          this._audit(s, who, 'buddy.proposed', v.ref + ' + ' + c.ref);
          return null;
        }
        case 'recordConsent': {
          const m = s.matches.find((x) => x.id === args.matchId);
          if (!m) throw new ValidationError('Match not found.');
          this._setConsent(s, m, args.side, args.agree, who + ' (recorded on behalf)');
          return null;
        }
        case 'endMatch': {
          const m = s.matches.find((x) => x.id === args.matchId);
          m.status = 'ended';
          for (const id of [m.volunteerId, m.communityId]) { const r = s.registrations.find((x) => x.id === id); if (r && r.buddy && r.buddy.status === 'matched') r.buddy.status = 'awaiting_match'; }
          this._audit(s, who, 'buddy.ended', m.id);
          return null;
        }
        case 'clearAttention': {
          const coll = { registration: s.registrations, lodge: s.lodgeRequests, sponsorship: s.sponsorships }[args.kind];
          const rec = coll && coll.find((x) => x.id === args.id);
          if (rec) { this._audit(s, who, 'attention.cleared', rec.ref || rec.id, rec.attention + ' — ' + (args.note || '')); rec.attention = null; }
          return null;
        }
        default:
          throw new ValidationError('Unknown action ' + action);
      }
    });
  }

  async updateSettings(token, patch) {
    return this._write((s) => {
      const me = this._requireOrganiser(s, token);
      const before = JSON.stringify(s.settings);
      const next = deepMerge(clone(s.settings), patch);
      const e = [];
      for (const k of ['combined', 'community']) if (!Number.isInteger(next.pools[k].limit) || next.pools[k].limit < 0) e.push('Pool limits must be whole numbers.');
      if (!(next.reservation.expiryHours >= 1)) e.push('Reservation expiry must be at least 1 hour.');
      for (const [cat, f] of Object.entries(next.fees)) if (f.confirmed && !(Number.isInteger(f.amount) && f.amount >= 0)) e.push('Set an amount for ' + CATEGORIES[cat].label + ' before confirming it.');
      if (!(next.waterPoints.price > 0)) e.push('Water point price must be above zero.');
      for (const n of next.lodge.nights) if (!/^\d{4}-\d{2}-\d{2}$/.test(n.date) || !(Number.isInteger(n.beds) && n.beds >= 0)) e.push('Each lodge night needs a date and a whole number of beds.');
      if (e.length) throw new ValidationError(e.join(' '));
      s.settings = next;
      const changed = diffKeys(JSON.parse(before), next);
      this._audit(s, me.email, 'settings.updated', '', changed.join(', '));
      return clone(next);
    });
  }

  async resetPreview({ withSamples = true } = {}) {
    return this.lock(async () => {
      this.seed = withSamples;
      this._save(this._fresh());
    });
  }
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

function diffKeys(a, b, prefix = '') {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const p = prefix ? prefix + '.' + k : k;
    if (a && b && typeof a[k] === 'object' && typeof b[k] === 'object' && !Array.isArray(a[k]) && a[k] && b[k]) out.push(...diffKeys(a[k], b[k], p));
    else if (JSON.stringify(a && a[k]) !== JSON.stringify(b && b[k])) out.push(p);
  }
  return out;
}

export { isReservationLive, occupiesPlace };

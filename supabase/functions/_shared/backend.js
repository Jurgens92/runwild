// The backend. All business rules live here, written like a server: every write runs inside an
// exclusive lock that re-reads state, applies the change and saves it, so "check capacity, then
// reserve" can never interleave with another request.
//
// It runs in two places with the same code:
//   * Preview (GitHub Pages, no API configured): in the browser, state in localStorage, lock = Web Locks.
//   * Live: on the server (Supabase Edge Function, supabase/functions/api). State is one row in
//     Postgres, and the lock is that row's lock (SELECT ... FOR UPDATE), held for the whole request.

import {
  CATEGORIES, DISTANCES, poolUsage, occupiesPlace, isReservationLive, entryFee, sumPaid, makeRef, uid,
  normaliseMobile, validMobile, validEmail, nightsBetween, stayNights, lodgeQuote, lodgeBalanceDue, todayJHB,
  formatDate, codeHasUses, SHIRT_SIZES, SOCK_SIZES, registrationOpen, registrationOpensAt, opensLabel, ENTRY_MODES, isPersonalEmail, emailDomain,
} from './core.js';
import { defaultSettings, sampleData, PREVIEW_USERS, liveSettings } from './defaults.js';

export const SCHEMA_VERSION = 8;
const HOUR = 3600000;

export const ROLES = {
  admin: { rank: 3, label: 'Admin', note: 'Everything, including settings and user accounts' },
  organiser: { rank: 2, label: 'Organiser', note: 'View and manage entries, payments, lodge, kit and buddies' },
  viewer: { rank: 1, label: 'Viewer', note: 'Read-only access to the dashboard' },
};
const MIN_PASSWORD = 10;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export class ValidationError extends Error {
  constructor(message, fields = {}) { super(message); this.name = 'ValidationError'; this.fields = fields; }
}
export class AuthError extends Error {
  constructor(message = 'Organiser sign-in required.') { super(message); this.name = 'AuthError'; }
}

// Storage adapters take and return the state object; each keeps its own serialised copy.
export function memoryStorage() {
  let raw = null;
  return { read: () => raw, write: (st) => { raw = JSON.stringify(st); } };
}

export function localStorageAdapter(key = 'runwild-preview-v' + SCHEMA_VERSION) {
  return {
    read: () => { try { return localStorage.getItem(key); } catch { return null; } },
    write: (st) => { try { localStorage.setItem(key, JSON.stringify(st)); } catch (e) { console.warn('Could not save preview data', e); } },
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
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// Passwords are stored only as salted PBKDF2-SHA256 hashes.
export async function hashPassword(password, salt, iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256));
}

export function newSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hex(b.buffer);
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function verifyPassword(password, user) {
  return sameText(await hashPassword(password, user.salt, user.iterations), user.hash);
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return 'Use at least ' + MIN_PASSWORD + ' characters.';
  if (/^(.)\1+$/.test(pw)) return 'Choose a less predictable password.';
  return null;
}

// Stands in for the payment provider's webhook signing secret. In the preview it is visible in the
// browser and offers no real protection; a live server passes its own secret and never exposes signing.
const PREVIEW_PROVIDER_SECRET = 'preview-only-not-secret';

export class Backend {
  // mode: 'preview' (browser) or 'live' (server). bootstrapUsers: the accounts a brand-new live database starts with.
  constructor({ storage = memoryStorage(), now = () => Date.now(), lock = defaultLock(), seed = true, mode = 'preview', bootstrapUsers = null, providerSecret = PREVIEW_PROVIDER_SECRET } = {}) {
    this.storage = storage;
    this.now = now;
    this.lock = lock;
    this.mode = mode;
    this.seed = mode === 'live' ? false : seed;
    this.bootstrapUsers = bootstrapUsers;
    this.providerSecret = providerSecret;
  }

  get live() { return this.mode === 'live'; }

  // ---------- state handling ----------

  _empty() {
    return {
      version: SCHEMA_VERSION, createdAt: this.now(), settings: defaultSettings(), users: [],
      registrations: [], charges: [], payments: [], providerEvents: [], lodgeRequests: [], sponsorships: [],
      stock: [], matches: [], contributions: [], launchRegistrations: [], outbox: [], audit: [], sessions: [],
    };
  }

  _fresh() {
    const base = this._empty();
    if (this.live) liveSettings(base.settings);
    base.users = clone(this.bootstrapUsers || (this.live ? [] : PREVIEW_USERS));
    if (this.seed) Object.assign(base, sampleData(this.now(), base.settings));
    const what = this.live ? 'Live database created' : this.seed ? 'Preview created with sample data' : 'Empty preview created';
    base.audit.push({ id: uid(), at: this.now(), actor: 'system', action: this.live ? 'database.created' : 'preview.created', target: '', details: what });
    return base;
  }

  // Brings stored state up to date. A preview simply starts again; a live database is never wiped:
  // new collections are added, and settings gain any new defaults while keeping every saved value.
  _upgrade(st) {
    if (!st || typeof st !== 'object' || !st.version) return { st: null, dirty: true };
    let dirty = false;
    if (st.version !== SCHEMA_VERSION) {
      if (!this.live) return { st: null, dirty: true };
      if (st.version > SCHEMA_VERSION) throw new Error('The database was written by a newer version of the site. Deploy the latest backend.');
      const base = this._empty();
      for (const k of Object.keys(base)) if (st[k] === undefined) st[k] = base[k];
      st.audit.push({ id: uid(), at: this.now(), actor: 'system', action: 'database.upgraded', target: '', details: 'Version ' + st.version + ' → ' + SCHEMA_VERSION });
      st.version = SCHEMA_VERSION;
      dirty = true;
    }
    st.settings = deepMerge(defaultSettings(), st.settings || {});
    return { st, dirty };
  }

  async _load() {
    const raw = await this.storage.read();
    let st = null;
    try { st = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { st = null; }
    const up = this._upgrade(st);
    return up.st ? up : { st: this._fresh(), dirty: true };
  }

  async _save(state) { await this.storage.write(state); }

  async _read(fn) {
    return this.lock(async () => {
      const { st, dirty } = await this._load();
      const swept = this._sweep(st);
      if (dirty || swept) await this._save(st);
      return fn(st);
    });
  }

  async _write(fn) {
    return this.lock(async () => {
      const { st } = await this._load();
      this._sweep(st);
      const result = await fn(st);
      await this._save(st);
      return result;
    });
  }

  _audit(s, actor, action, target, details = '') {
    s.audit.push({ id: uid(), at: this.now(), actor, action, target, details });
  }

  // Releases expired holds. Never promotes anyone from the waitlist.
  _sweep(s) {
    const now = this.now();
    const before = s.audit.length;
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
    s.sessions = (s.sessions || []).filter((x) => x.expiresAt > now);
    return s.audit.length !== before;
  }

  _uniqueRef(s, prefix) {
    const taken = new Set([...s.registrations.map((r) => r.ref), ...s.sponsorships.map((x) => x.ref), ...s.contributions.map((x) => x.ref), ...(s.launchRegistrations || []).map((x) => x.ref)]);
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
        registration: { mode: st.registration.mode, opensOn: st.registration.opensOn, opensAt: st.registration.opensAt, opensLabel: opensLabel(st.registration), open: registrationOpen(st, now) },
        launch: clone(st.launchEvent),
        terms: clone(st.terms),
        socks: clone(st.socks),
        lodge: {
          ratePerNight: st.lodge.ratePerNight, depositPercent: st.lodge.depositPercent, minNights: st.lodge.minNights, balanceDueDate: st.lodge.balanceDueDate,
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

  // Money raised is counted only once it is received. ERP buys the items, so "in hand" means purchased stock.
  _donationProgress(s) {
    const needing = s.registrations.filter((r) => r.kit && r.status !== 'cancelled' && CATEGORIES[r.category].kitOptions);
    const count = (type, status) => s.stock.filter((x) => x.type === type && (!status || x.status === status)).length;
    const raised = s.charges.filter((c) => c.kind === 'donation').reduce((a, c) => a + sumPaid(s.payments, c.id), 0);
    const per = s.settings.donations.perRunner;
    return {
      runnersNeedingKit: needing.filter((r) => r.kit.needsShoes || r.kit.needsKit).length,
      shoesRequested: needing.filter((r) => r.kit.needsShoes).length,
      kitRequested: needing.filter((r) => r.kit.needsKit).length,
      raised,
      runnersFunded: per ? Math.floor(raised / per) : 0,
      shoesInHand: count('shoes'),
      kitInHand: count('kit'),
      shoesAllocated: count('shoes', 'allocated') + count('shoes', 'delivered'),
      kitAllocated: count('kit', 'allocated') + count('kit', 'delivered'),
    };
  }

  async checkInviteCode(code, category) {
    return this._read((s) => {
      const c = s.settings.inviteCodes.find((x) => x.code.toUpperCase() === String(code || '').trim().toUpperCase());
      return !!c && c.category === category && codeHasUses(c);
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
    if (!SHIRT_SIZES.includes(input.shirtSize)) e.shirtSize = 'Choose a size for your RunWild running shirt.';
    const so = input.socks || {};
    const qty = Number(so.qty || 0);
    if (!(Number.isInteger(qty) && qty >= 0 && qty <= s.settings.socks.maxPerEntry)) e.socksQty = 'Choose up to ' + s.settings.socks.maxPerEntry + ' pairs.';
    else if (qty > 0 && !s.settings.socks.enabled) e.socksQty = 'Socks are not available at the moment.';
    else if (qty > 0 && !SOCK_SIZES.includes(so.size)) e.socksSize = 'Choose a sock size.';
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
      if (!k.shortsSize) e.shortsSize = 'Choose a pants/shorts size.';
    }
    if (input.category === 'melorane_employee') {
      // Sizes are only needed for the items the employee asks for.
      const k = input.kit || {};
      if (k.needsShoes && !k.shoeSize) e.shoeSize = 'Enter a shoe size.';
      if (k.needsShoes && !k.shoeSystem) e.shoeSystem = 'Choose a sizing system.';
      if (k.needsKit && !k.shortsSize) e.shortsSize = 'Choose a pants/shorts size.';
    }
    if (Object.keys(e).length) throw new ValidationError('Please check the highlighted fields.', e);
  }

  _lodgeDateError(s, arrival, departure) {
    if (!arrival || !departure) return 'Choose arrival and departure dates.';
    const n = nightsBetween(arrival, departure);
    if (n < 1) return 'Departure must be after arrival.';
    const min = s.settings.lodge.minNights || 1;
    if (n < min) return 'Canvas Lodge bookings are for a minimum of ' + min + ' nights.';
    const open = new Set(s.settings.lodge.nights.map((x) => x.date));
    const missing = stayNights(arrival, departure).filter((d) => !open.has(d));
    if (missing.length) return 'Canvas Lodge is not open on the night of ' + missing.map(formatDate).join(', ') + '.';
    return null;
  }

  async submitRegistration(input, { token } = {}) {
    return this._write((s) => {
      const organiser = token ? this._session(s, token, 'organiser') : null;
      if (input.clientRequestId) {
        const existing = s.registrations.find((r) => r.clientRequestId === input.clientRequestId);
        if (existing) return { ...this._confirmation(s, existing), duplicateSubmission: true };
      }
      // Race entries are closed to the public until the opening date. Organisers can still register people.
      if (!organiser && !registrationOpen(s.settings, this.now())) {
        throw new ValidationError(s.settings.registration.mode === 'closed' ? 'Race entries are not open yet. Until then you can register for the launch event.' : 'Race entries open on ' + opensLabel(s.settings.registration) + '. Until then you can register for the launch event.');
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
        shirtSize: input.shirtSize,
        socks: Number(input.socks && input.socks.qty) > 0 ? { qty: Number(input.socks.qty), size: input.socks.size } : null,
      };
      if (cat.adultOptions) {
        reg.lodge = { wanted: !!input.lodge.wanted };
        reg.transportAck = !input.lodge.wanted && !!input.transportAck;
        reg.buddy = input.buddy && input.buddy.optIn
          ? { optIn: true, status: 'volunteered', preferredDistance: input.buddy.preferredDistance || input.distance, experience: input.buddy.experience, availability: input.buddy.availability, contactMethod: input.buddy.contactMethod || 'Phone', support: input.buddy.support || '' }
          : { optIn: false };
      }
      if (cat.kitOptions) {
        // The kit shirt is the RunWild running shirt, so it uses the entry's shirt size.
        const k = input.kit || {};
        reg.kit = { shoeSize: String(k.shoeSize || ''), shoeSystem: k.shoeSize ? k.shoeSystem || 'UK' : '', shirtSize: input.shirtSize, shortsSize: k.shortsSize || '', needsShoes: !!k.needsShoes, needsKit: !!k.needsKit };
      }
      if (input.category === 'community') {
        reg.pickupAck = true;
        reg.buddy = { optIn: !!(input.buddy && input.buddy.optIn), status: input.buddy && input.buddy.optIn ? 'awaiting_match' : undefined };
      }
      s.registrations.push(reg);

      if (cat.employee) {
        const code = s.settings.inviteCodes.find((x) => x.code.toUpperCase() === String(input.inviteCode || '').trim().toUpperCase());
        if (organiser && input.organiserVerified) {
          reg.verification = 'verified';
          reg.verifiedBy = organiser.email;
        } else if (code && code.category === input.category && codeHasUses(code)) {
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
    } else if (fee.amount === 0) {
      reg.status = 'confirmed';
      reg.expiresAt = null;
    } else {
      reg.status = 'reserved';
      reg.expiresAt = this.now() + s.settings.reservation.expiryHours * HOUR;
      let ch = s.charges.find((c) => c.ownerId === reg.id && c.kind === 'entry');
      if (!ch) ch = this._charge(s, { kind: 'entry', ownerType: 'registration', ownerId: reg.id, label: fee.label, amount: fee.amount, ref: reg.ref + '-E' });
      if (sumPaid(s.payments, ch.id) >= ch.amount) { reg.status = 'confirmed'; reg.expiresAt = null; }
    }
    this._sockCharge(s, reg);
  }

  // Socks are a separate add-on charge. It is raised only once the entry holds a place and the
  // organisers have confirmed the sock price; until then the order is recorded with nothing payable.
  _sockCharge(s, reg) {
    const so = s.settings.socks;
    if (!reg.socks || !reg.socks.qty || !so.confirmed || !so.price) return null;
    if (!['reserved', 'confirmed'].includes(reg.status)) return null;
    let ch = s.charges.find((c) => c.ownerId === reg.id && c.kind === 'socks');
    if (!ch) ch = this._charge(s, { kind: 'socks', ownerType: 'registration', ownerId: reg.id, label: so.label + ' × ' + reg.socks.qty + ' (' + reg.socks.size + ')', amount: so.price * reg.socks.qty, ref: reg.ref + '-S' });
    return ch;
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
      shirtSize: reg.shirtSize || '',
      socks: reg.socks ? clone(reg.socks) : null,
      socksPrice: st.socks.confirmed ? st.socks.price : null,
      socksLabel: st.socks.label,
      kit: reg.kit ? clone(reg.kit) : null,
      lodgeMinNights: st.lodge.minNights,
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
      'RunWild running shirt: size ' + (reg.shirtSize || '—'),
    ];
    if (reg.socks) lines.push('Socks: ' + reg.socks.qty + ' pair(s), size ' + reg.socks.size + (conf.socksPrice ? '' : ' – price to be confirmed'));
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

  async addSocksForEntry(ref, mobile, qty, size) {
    return this._write((s) => {
      const r = this._findOwn(s, ref, mobile);
      if (r.status === 'cancelled') throw new ValidationError('This entry is cancelled.');
      if (!s.settings.socks.enabled) throw new ValidationError('Socks are not available at the moment.');
      if (r.socks && r.socks.qty) throw new ValidationError('You have already ordered socks. Contact the organisers to change your order.');
      const q = Number(qty);
      if (!(Number.isInteger(q) && q >= 1 && q <= s.settings.socks.maxPerEntry)) throw new ValidationError('Choose 1 to ' + s.settings.socks.maxPerEntry + ' pairs.');
      if (!SOCK_SIZES.includes(size)) throw new ValidationError('Choose a sock size.');
      r.socks = { qty: q, size };
      this._sockCharge(s, r);
      this._audit(s, 'participant', 'socks.ordered', r.ref, q + ' × ' + size);
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
    if (this.live) throw new ValidationError('Not available.');
    return hmac(this.providerSecret, [n.eventId, n.chargeRef, n.amount, n.status].join('|'));
  }

  // Payment notification endpoint (the provider's webhook). The only online path that marks money
  // as received. A browser redirect never does.
  async providerNotification(n) {
    const expected = await hmac(this.providerSecret, [n.eventId, n.chargeRef, n.amount, n.status].join('|'));
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

  // Monetary donations only: kit out a number of runners at the per-runner budget, or give any amount.
  async submitContribution(input) {
    return this._write((s) => {
      if (input.clientRequestId) {
        const ex = s.contributions.find((x) => x.clientRequestId === input.clientRequestId);
        if (ex) {
          const ch = s.charges.find((c) => c.ownerId === ex.id);
          return { ...clone(ex), charge: this._chargeView(s, ch), duplicateSubmission: true };
        }
      }
      const d = s.settings.donations;
      if (!d.enabled) throw new ValidationError('Donations are not open yet.');
      const pay = s.settings.payments;
      if (!pay.previewProvider && !pay.providerConnected && !pay.eftEnabled) throw new ValidationError('No payment method is configured yet.');
      const e = {};
      let runners = null;
      let amount;
      if (input.mode === 'amount') {
        amount = Math.round(Number(input.amount) * 100);
        if (!(amount >= d.minAmount && amount <= 100000000)) e.amount = 'Enter an amount of at least R' + d.minAmount / 100 + '.';
      } else {
        runners = Number(input.runners);
        if (!(Number.isInteger(runners) && runners >= 1 && runners <= 50)) e.runners = 'Choose 1 to 50 runners.';
        amount = d.perRunner * runners;
      }
      if (!input.donor || input.donor.trim().length < 2) e.donor = 'Enter your name or company.';
      if (!validEmail(input.email)) e.email = 'Enter a valid email address.';
      if (Object.keys(e).length) throw new ValidationError('Please check the highlighted fields.', e);
      const c = { id: uid(), ref: this._uniqueRef(s, 'RWM-DF'), clientRequestId: input.clientRequestId || uid(), donor: input.donor.trim(), email: input.email.trim(), phone: input.phone || '', runners, amount, status: 'awaiting_payment', createdAt: this.now() };
      s.contributions.push(c);
      const label = runners ? 'Kit out ' + runners + ' runner' + (runners > 1 ? 's' : '') : 'Donation towards shoes and kit';
      const ch = this._charge(s, { kind: 'donation', ownerType: 'contribution', ownerId: c.id, label, amount, ref: c.ref });
      this._audit(s, 'public', 'donation.created', c.ref, 'R' + amount / 100 + (runners ? ' (' + runners + ' runner' + (runners > 1 ? 's' : '') + ')' : ''));
      this._queueMessage(s, { to: c.email, channel: 'email', subject: 'Your Run Wild donation ' + c.ref, body: 'Thank you for your donation of R' + amount / 100 + '. Use reference ' + c.ref + ' if you pay by EFT.', ref: c.ref });
      return { ...clone(c), charge: this._chargeView(s, ch) };
    });
  }

  // ---------- launch event ----------

  // Anyone can register for the launch event. A personal email address (Gmail and similar) is accepted but flagged.
  async submitLaunchRegistration(input) {
    return this._write((s) => {
      s.launchRegistrations = s.launchRegistrations || [];
      if (input.clientRequestId) {
        const ex = s.launchRegistrations.find((x) => x.clientRequestId === input.clientRequestId);
        if (ex) return { ...this._launchView(s, ex), duplicateSubmission: true };
      }
      const L = s.settings.launchEvent;
      if (!L.open) throw new ValidationError('Registration for the launch event is closed.');
      const e = {};
      const firstName = String(input.firstName || '').trim();
      const surname = String(input.surname || '').trim();
      const email = String(input.email || '').trim().toLowerCase();
      if (!firstName) e.firstName = 'Enter your name.';
      if (!surname) e.surname = 'Enter your surname.';
      if (!validEmail(email)) e.email = 'Enter a valid email address.';
      if (Object.keys(e).length) throw new ValidationError('Please check the highlighted fields.', e);
      if (s.launchRegistrations.some((x) => x.status !== 'cancelled' && x.email === email)) {
        throw new ValidationError('This email address is already registered for the launch event.', { email: 'Already registered.' });
      }
      const personal = isPersonalEmail(email);
      const lr = {
        id: uid(), ref: this._uniqueRef(s, 'RWL'), clientRequestId: input.clientRequestId || uid(),
        firstName, surname, email, domain: emailDomain(email), personalEmail: personal, status: 'registered', createdAt: this.now(),
      };
      s.launchRegistrations.push(lr);
      this._audit(s, 'public', 'launch.registered', lr.ref, firstName + ' ' + surname + (personal ? ' (personal email: ' + lr.domain + ')' : ''));
      this._queueMessage(s, { to: email, channel: 'email', subject: 'Run Wild Melorane launch event – ' + lr.ref, body: 'Thank you, ' + firstName + '. You are registered for the Run Wild Melorane launch event at ' + L.venue + '. This is not a race entry: race entries open on ' + opensLabel(s.settings.registration) + '.', ref: lr.ref });
      return this._launchView(s, lr);
    });
  }

  _launchView(s, lr) {
    return { ref: lr.ref, firstName: lr.firstName, surname: lr.surname, email: lr.email, personalEmail: lr.personalEmail, status: lr.status, event: clone(s.settings.launchEvent), raceOpensOn: s.settings.registration.opensOn, raceOpensLabel: s.settings.registration.mode === 'closed' ? '' : opensLabel(s.settings.registration), raceDate: s.settings.event.date };
  }

  // ---------- organiser ----------

  // Resolves a session token to its (active) user and checks the role. Permission problems are
  // ValidationErrors so the dashboard shows a message instead of signing the person out.
  _session(s, token, minRole = 'viewer', { allowMustChange = false } = {}) {
    const sess = (s.sessions || []).find((x) => x.token === token && x.expiresAt > this.now());
    const user = sess && (s.users || []).find((u) => u.id === sess.userId && u.active);
    if (!user) throw new AuthError();
    if (user.mustChangePassword && !allowMustChange) throw new ValidationError('Please set a new password first.');
    if (ROLES[user.role].rank < ROLES[minRole].rank) throw new ValidationError('Your account (' + ROLES[user.role].label + ') cannot do this. Ask an admin.');
    return { token, userId: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: !!user.mustChangePassword };
  }

  _publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, mustChangePassword: !!u.mustChangePassword, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, locked: !!(u.lockedUntil && u.lockedUntil > this.now()) };
  }

  async login(email, password) {
    const res = await this._write(async (s) => {
      const id = String(email || '').trim().toLowerCase();
      const u = (s.users || []).find((x) => x.email.toLowerCase() === id);
      const now = this.now();
      if (u && u.lockedUntil && u.lockedUntil > now) {
        this._audit(s, id, 'auth.locked', '');
        return { error: 'Too many failed attempts. This account is locked for ' + LOCK_MINUTES + ' minutes.' };
      }
      // Hash even for unknown names, so the response time does not reveal which accounts exist.
      const ok = u ? u.active && await verifyPassword(password, u) : (await hashPassword(String(password), 'unknown-user', 100000), false);
      if (!ok) {
        if (u) {
          u.failedLogins = (u.failedLogins || 0) + 1;
          if (u.failedLogins >= MAX_FAILED_LOGINS) { u.lockedUntil = now + LOCK_MINUTES * 60000; u.failedLogins = 0; }
        }
        this._audit(s, id, 'auth.failed', '');
        return { error: 'Email or password not recognised.' };
      }
      u.failedLogins = 0; u.lockedUntil = null; u.lastLoginAt = now;
      const token = uid() + uid();
      s.sessions = (s.sessions || []).filter((x) => x.expiresAt > now);
      s.sessions.push({ token, userId: u.id, expiresAt: now + 8 * HOUR });
      this._audit(s, u.email, 'auth.signed_in', '');
      return { token, email: u.email, name: u.name, role: u.role, mustChangePassword: !!u.mustChangePassword };
    });
    if (res.error) throw new AuthError(res.error);
    return res;
  }

  async logout(token) {
    return this._write((s) => { s.sessions = (s.sessions || []).filter((x) => x.token !== token); });
  }

  async changePassword(token, current, next) {
    return this._write(async (s) => {
      const me = this._session(s, token, 'viewer', { allowMustChange: true });
      const u = s.users.find((x) => x.id === me.userId);
      if (!await verifyPassword(current, u)) throw new ValidationError('Your current password is not right.', { current: 'Not right.' });
      const problem = passwordProblem(next);
      if (problem) throw new ValidationError(problem, { next: problem });
      if (next === current) throw new ValidationError('Choose a password you have not used here before.', { next: 'Same as before.' });
      await this._setPassword(u, next, false);
      // Sign out every other session of this user.
      s.sessions = s.sessions.filter((x) => x.userId !== u.id || x.token === token);
      this._audit(s, u.email, 'user.password_changed', u.email);
      return this._publicUser(u);
    });
  }

  async _setPassword(u, password, mustChange) {
    u.salt = newSalt();
    u.iterations = 100000;
    u.hash = await hashPassword(password, u.salt, u.iterations);
    u.mustChangePassword = mustChange;
    u.failedLogins = 0;
    u.lockedUntil = null;
  }

  // Admins create accounts with a temporary password; the person must choose their own when they first sign in.
  async createUser(token, { email, name, role, password } = {}) {
    return this._write(async (s) => {
      const me = this._session(s, token, 'admin');
      const e = {};
      const id = String(email || '').trim().toLowerCase();
      if (id.length < 3 || /\s/.test(id)) e.email = 'Enter an email address or username (no spaces).';
      else if (s.users.some((u) => u.email.toLowerCase() === id)) e.email = 'There is already an account with this name.';
      if (!String(name || '').trim()) e.name = 'Enter the person’s name.';
      if (!ROLES[role]) e.role = 'Choose a role.';
      const problem = passwordProblem(password);
      if (problem) e.password = problem;
      if (Object.keys(e).length) throw new ValidationError('Please check the highlighted fields.', e);
      const u = { id: uid(), email: id, name: String(name).trim(), role, active: true, createdAt: this.now(), lastLoginAt: null };
      await this._setPassword(u, password, true);
      s.users.push(u);
      this._audit(s, me.email, 'user.created', u.email, ROLES[role].label);
      return this._publicUser(u);
    });
  }

  async updateUser(token, userId, patch = {}) {
    return this._write(async (s) => {
      const me = this._session(s, token, 'admin');
      const u = s.users.find((x) => x.id === userId);
      if (!u) throw new ValidationError('User not found.');
      const changes = [];
      const nextRole = patch.role !== undefined ? patch.role : u.role;
      const nextActive = patch.active !== undefined ? !!patch.active : u.active;
      if (!ROLES[nextRole]) throw new ValidationError('Choose a role.');
      const otherAdmins = s.users.filter((x) => x.id !== u.id && x.active && x.role === 'admin').length;
      if (u.role === 'admin' && u.active && (nextRole !== 'admin' || !nextActive) && otherAdmins === 0) {
        throw new ValidationError('There must always be at least one active admin. Make someone else an admin first.');
      }
      if (patch.name !== undefined && String(patch.name).trim() && patch.name.trim() !== u.name) { u.name = patch.name.trim(); changes.push('name'); }
      if (nextRole !== u.role) { changes.push('role ' + u.role + ' → ' + nextRole); u.role = nextRole; }
      if (nextActive !== u.active) { u.active = nextActive; changes.push(nextActive ? 'reactivated' : 'deactivated'); }
      if (patch.password) {
        const problem = passwordProblem(patch.password);
        if (problem) throw new ValidationError(problem, { password: problem });
        await this._setPassword(u, patch.password, true);
        changes.push('password reset');
      }
      if (patch.unlock) { u.lockedUntil = null; u.failedLogins = 0; changes.push('unlocked'); }
      // Role changes, deactivation and password resets end the person's open sessions.
      if (changes.some((c) => c !== 'name') && u.id !== me.userId) s.sessions = s.sessions.filter((x) => x.userId !== u.id);
      this._audit(s, me.email, 'user.updated', u.email, changes.join(', ') || 'no change');
      return this._publicUser(u);
    });
  }

  // Full backup for admins: everything except passwords and sessions.
  async exportData(token) {
    return this._read((s) => {
      const me = this._session(s, token, 'admin');
      const out = clone(s);
      delete out.sessions;
      out.users = s.users.map((u) => this._publicUser(u));
      out.exportedAt = this.now();
      out.exportedBy = me.email;
      return out;
    });
  }

  async dashboard(token) {
    return this._read((s) => {
      const me = this._session(s, token, 'viewer', { allowMustChange: true });
      const out = clone(s);
      delete out.sessions;
      out.users = me.role === 'admin' ? s.users.map((u) => this._publicUser(u)) : [];
      out.me = { email: me.email, name: me.name, role: me.role, mustChangePassword: me.mustChangePassword };
      out.mode = this.mode;
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
      const me = this._session(s, token, 'organiser');
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
            if (!CATEGORIES[reg.category].kitOptions) reg.kit = null;
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
        case 'issueSockCharges': {
          if (!s.settings.socks.confirmed || !s.settings.socks.price) throw new ValidationError('Confirm the sock price first.');
          let n = 0;
          for (const r of s.registrations) if (r.socks && r.socks.qty && !s.charges.some((c) => c.ownerId === r.id && c.kind === 'socks') && this._sockCharge(s, r)) n++;
          this._audit(s, who, 'socks.issued', '', n + ' sock orders now payable');
          return n;
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
          if (!reg || !reg.kit || !CATEGORIES[reg.category].kitOptions) throw new ValidationError('Choose a participant who asked for kit.');
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
        // Admins can permanently remove test records. Anything with money received is kept: cancel it instead.
        case 'deleteRegistration': {
          if (me.role !== 'admin') throw new ValidationError('Only admins can delete entries.');
          const lodgeIds = s.lodgeRequests.filter((l) => l.registrationId === reg.id).map((l) => l.id);
          const owners = new Set([reg.id, ...lodgeIds]);
          const chargeIds = new Set(s.charges.filter((c) => owners.has(c.ownerId)).map((c) => c.id));
          if (s.payments.some((p) => chargeIds.has(p.chargeId) && p.status === 'received')) {
            throw new ValidationError('This entry has payments recorded, so it cannot be deleted. Cancel it instead.');
          }
          s.registrations = s.registrations.filter((r) => r.id !== reg.id);
          s.lodgeRequests = s.lodgeRequests.filter((l) => !owners.has(l.id));
          s.charges = s.charges.filter((c) => !chargeIds.has(c.id));
          s.payments = s.payments.filter((p) => !chargeIds.has(p.chargeId));
          s.matches = s.matches.filter((m) => m.volunteerId !== reg.id && m.communityId !== reg.id);
          for (const item of s.stock) if (item.allocatedTo === reg.id) { item.status = 'in_stock'; item.allocatedTo = null; }
          this._audit(s, who, 'registration.deleted', reg.ref, reg.fullName + ' – permanently deleted');
          return null;
        }
        case 'deleteLaunch': {
          if (me.role !== 'admin') throw new ValidationError('Only admins can delete launch registrations.');
          const lr = (s.launchRegistrations || []).find((x) => x.id === args.id);
          if (!lr) throw new ValidationError('Launch registration not found.');
          s.launchRegistrations = s.launchRegistrations.filter((x) => x.id !== lr.id);
          this._audit(s, who, 'launch.deleted', lr.ref, lr.firstName + ' ' + lr.surname + ' – permanently deleted');
          return null;
        }
        case 'cancelLaunch': {
          const lr = (s.launchRegistrations || []).find((x) => x.id === args.id);
          if (!lr) throw new ValidationError('Launch registration not found.');
          lr.status = 'cancelled';
          this._audit(s, who, 'launch.cancelled', lr.ref);
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
      const me = this._session(s, token, 'admin');
      const before = JSON.stringify(s.settings);
      const next = deepMerge(clone(s.settings), patch);
      const e = [];
      for (const k of ['combined', 'community']) if (!Number.isInteger(next.pools[k].limit) || next.pools[k].limit < 0) e.push('Pool limits must be whole numbers.');
      if (!(next.reservation.expiryHours >= 1)) e.push('Reservation expiry must be at least 1 hour.');
      for (const [cat, f] of Object.entries(next.fees)) if (f.confirmed && !(Number.isInteger(f.amount) && f.amount >= 0)) e.push('Set an amount for ' + CATEGORIES[cat].label + ' before confirming it.');
      if (!(next.waterPoints.price > 0)) e.push('Water point price must be above zero.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next.registration.opensOn || '')) e.push('Set the date race entries open.');
      if (!ENTRY_MODES[next.registration.mode]) e.push('Choose how race entries open.');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.registration.opensAt || '')) e.push('Set the opening time as HH:MM, e.g. 08:00.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next.event.date || '')) e.push('Set the race date.');
      else if (next.registration.opensOn > next.event.date) e.push('Race entries must open before race day.');
      if (next.launchEvent.date && !/^\d{4}-\d{2}-\d{2}$/.test(next.launchEvent.date)) e.push('The launch event date must be a date.');
      if (next.launchEvent.dateConfirmed && !next.launchEvent.date) e.push('Set the launch event date before confirming it.');
      if (next.launchEvent.website && !/^https?:\/\//i.test(next.launchEvent.website)) e.push('The venue website must start with https://');
      if (next.launchEvent.mapsUrl && !/^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.app\.goo\.gl\/|goo\.gl\/maps)/i.test(next.launchEvent.mapsUrl)) e.push('The Google Maps link must be a google.com/maps or maps.app.goo.gl link.');
      if (!(Number.isFinite(next.launchEvent.lat) && Number.isFinite(next.launchEvent.lng))) e.push('The launch venue map pin needs a latitude and longitude.');
      if (!(Number.isInteger(next.lodge.minNights) && next.lodge.minNights >= 1)) e.push('Lodge minimum stay must be a whole number of nights.');
      if (next.socks.confirmed && !(Number.isInteger(next.socks.price) && next.socks.price > 0)) e.push('Set a sock price before confirming it.');
      if (!(Number.isInteger(next.socks.maxPerEntry) && next.socks.maxPerEntry >= 1)) e.push('Allow at least one pair of socks per entry.');
      if (!(Number.isInteger(next.donations.perRunner) && next.donations.perRunner > 0)) e.push('Set the per-runner kit budget.');
      if (next.event.routeConfirmed && !(next.event.startLocation && next.event.finishLocation && next.event.routeDescription)) e.push('Fill in the start, finish and route before confirming them.');
      for (const n of next.lodge.nights) if (!/^\d{4}-\d{2}-\d{2}$/.test(n.date) || !(Number.isInteger(n.beds) && n.beds >= 0)) e.push('Each lodge night needs a date and a whole number of beds.');
      if (e.length) throw new ValidationError(e.join(' '));
      s.settings = next;
      const changed = diffKeys(JSON.parse(before), next);
      this._audit(s, me.email, 'settings.updated', '', changed.join(', '));
      return clone(next);
    });
  }

  // Preview only. A live database can never be reset from the site.
  async resetPreview({ withSamples = true } = {}) {
    if (this.live) throw new ValidationError('Not available on the live site.');
    return this.lock(async () => {
      this.seed = withSamples;
      await this._save(this._fresh());
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

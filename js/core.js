// Pure business rules shared by the browser app, the demo backend and the tests.
// Amounts are integer cents (ZAR). Dates are ISO yyyy-mm-dd in Africa/Johannesburg.

export const TZ = 'Africa/Johannesburg';

// kitOptions: the participant can ask ERP for running shoes and kit (bought with donated funds).
export const CATEGORIES = {
  group_employee: { label: 'Group employee', pool: 'combined', employee: true, emailRequired: true, adultOptions: true, kitOptions: false },
  melorane_employee: { label: 'Melorane employee', pool: null, employee: true, emailRequired: false, adultOptions: false, kitOptions: true },
  other: { label: 'Other participant', pool: 'combined', employee: false, emailRequired: true, adultOptions: true, kitOptions: false },
  community: { label: 'Community member', pool: 'community', employee: false, emailRequired: false, adultOptions: false, kitOptions: true },
};

// Every entry includes a RunWild running shirt.
export const SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
export const SOCK_SIZES = ['S (UK 3–5)', 'M (UK 6–8)', 'L (UK 9–11)', 'XL (UK 12+)'];

// An invitation code with maxUses null has no usage limit.
export function codeHasUses(code) {
  return !!code && (code.maxUses === null || code.maxUses === undefined || code.uses < code.maxUses);
}

export const POOLS = {
  combined: { label: 'Group employees + other participants' },
  community: { label: 'Community members' },
};

export const DISTANCES = {
  '21k': '21 km trail run',
  '5k': '5 km run/walk',
};

export const STATUS_LABELS = {
  draft: 'Draft',
  reserved: 'Reserved – pending payment',
  confirmed: 'Confirmed',
  waitlisted: 'Waitlisted',
  cancelled: 'Cancelled',
};

export function rand(cents) {
  if (cents === null || cents === undefined) return '—';
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const c = abs % 100;
  return (neg ? '-R' : 'R') + whole + (c ? '.' + String(c).padStart(2, '0') : '');
}

// Today's date in Johannesburg as yyyy-mm-dd.
export function todayJHB(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(dt);
}

// "Saturday 17 April 2027"
export function formatDay(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-ZA', { timeZone: 'UTC', weekday: 'long' }).format(dt) + ' ' + formatDate(iso);
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function nightsBetween(arrival, departure) {
  if (!arrival || !departure) return 0;
  const a = Date.parse(arrival + 'T00:00:00Z');
  const b = Date.parse(departure + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// The individual nights (by check-in date) covered by a stay.
export function stayNights(arrival, departure) {
  const n = nightsBetween(arrival, departure);
  const out = [];
  for (let i = 0; i < n; i++) out.push(addDays(arrival, i));
  return out;
}

// Canvas Lodge maths. Deposit is 20 % of the accommodation total and never touches the entry fee.
export function lodgeQuote({ nights, ratePerNight, depositPercent = 20 }) {
  const total = ratePerNight * nights;
  const deposit = Math.round((total * depositPercent) / 100);
  return { nights, total, deposit, balance: total - deposit };
}

// When is the remaining 80 % due? Bookings made after the standard due date fall under the
// organiser's late-booking policy, which may still be unconfirmed.
export function lodgeBalanceDue({ bookedOn, standardDueDate, latePolicy }) {
  if (bookedOn <= standardDueDate) return { date: standardDueDate, note: null };
  if (!latePolicy || !latePolicy.confirmed) {
    return { date: null, note: 'Booked after ' + formatDate(standardDueDate) + ' – late-booking terms to be confirmed by the organisers.' };
  }
  if (latePolicy.mode === 'full_on_booking') return { date: bookedOn, note: latePolicy.text || 'Full amount due on booking.' };
  if (latePolicy.mode === 'days_after_booking') return { date: addDays(bookedOn, latePolicy.days || 7), note: latePolicy.text || null };
  return { date: null, note: latePolicy.text || 'See late-booking terms.' };
}

export function isReservationLive(reg, now) {
  return reg.status === 'reserved' && (!reg.expiresAt || reg.expiresAt > now);
}

// A registration occupies a place when confirmed, or reserved and not yet expired.
export function occupiesPlace(reg, now) {
  return reg.status === 'confirmed' || isReservationLive(reg, now);
}

export function poolUsage(registrations, settings, now) {
  const out = {};
  for (const [key, def] of Object.entries(settings.pools)) {
    const regs = registrations.filter((r) => CATEGORIES[r.category].pool === key);
    const confirmed = regs.filter((r) => r.status === 'confirmed').length;
    const reserved = regs.filter((r) => isReservationLive(r, now)).length;
    const used = confirmed + reserved;
    out[key] = {
      limit: def.limit,
      confirmed,
      reserved,
      used,
      remaining: Math.max(0, def.limit - used),
      waitlisted: regs.filter((r) => r.status === 'waitlisted').length,
    };
  }
  return out;
}

// Entry fee for a category. Returns { amount, confirmed }. amount is null while unconfirmed.
export function entryFee(settings, category) {
  const f = settings.fees[category];
  return { amount: f.confirmed ? f.amount : null, confirmed: !!f.confirmed, label: f.label };
}

export function sumPaid(payments, chargeId) {
  return payments.filter((p) => p.chargeId === chargeId && p.status === 'received').reduce((s, p) => s + p.amount, 0);
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeRef(prefix, randomFn = Math.random) {
  let s = '';
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[Math.floor(randomFn() * REF_ALPHABET.length)];
  return prefix + '-' + s;
}

export function uid() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function normaliseMobile(m) {
  let d = String(m || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+27')) d = '0' + d.slice(3);
  if (d.startsWith('27') && d.length === 11) d = '0' + d.slice(2);
  return d;
}

export function validMobile(m) {
  return /^0\d{9}$/.test(normaliseMobile(m));
}

export function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

// ---------- race entries opening date ----------

// Race entries: mode 'auto' opens them at opensOn + opensAt (Johannesburg time); 'open' and 'closed'
// override the date, e.g. to test registration before the real opening.
export const ENTRY_MODES = {
  auto: 'Automatic – open on the date below',
  open: 'Open now',
  closed: 'Closed',
};

export function registrationOpensAt(reg = {}) {
  if (!reg.opensOn) return null;
  return Date.parse(reg.opensOn + 'T' + (reg.opensAt || '00:00') + ':00+02:00');
}

export function registrationOpen(settings, now = Date.now()) {
  const reg = settings.registration || {};
  if (reg.mode === 'open') return true;
  if (reg.mode === 'closed') return false;
  const at = registrationOpensAt(reg);
  return at === null || now >= at;
}

// "1 February 2027" or "1 February 2027 at 08:00"
export function opensLabel(reg = {}) {
  return formatDate(reg.opensOn) + (reg.opensAt && reg.opensAt !== '00:00' ? ' at ' + reg.opensAt : '');
}

// ---------- launch event ----------

// Free or personal mailbox providers. A launch registration with one of these is flagged for the organisers, never refused.
export const PERSONAL_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.za', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.za', 'hotmail.co.uk', 'outlook.com', 'outlook.co.za', 'live.com', 'live.co.za', 'live.co.uk', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com',
  'yandex.com', 'zohomail.com', 'webmail.co.za', 'mweb.co.za', 'telkomsa.net', 'vodamail.co.za', 'absamail.co.za',
  'iafrica.com', 'lantic.net', 'afrihost.co.za', 'cybersmart.co.za', 'vox.co.za', 'polka.co.za',
];

export function emailDomain(email) {
  const m = /@([^@\s]+)$/.exec(String(email || '').trim().toLowerCase());
  return m ? m[1] : '';
}

export function isPersonalEmail(email) {
  const d = emailDomain(email);
  if (!d) return false;
  return PERSONAL_EMAIL_DOMAINS.includes(d) || /^(yahoo|hotmail|outlook|live|gmail)\./.test(d);
}

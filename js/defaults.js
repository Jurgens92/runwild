// Organiser-editable settings and the clearly labelled sample data used by the preview.
// Anything marked confirmed:false is an open decision that must be settled before launch.

export function defaultSettings() {
  return {
    event: {
      name: 'Run Wild Melorane',
      date: '2027-04-17',
      venue: 'Melorane ERP Game Reserve',
      startTime: '',
      startTimeConfirmed: false,
      pickupPlace: "the Chief's Hall in PJ",
      pickupTime: '4:30 am',
      pickupFullAddress: '',
      pickupAddressConfirmed: false,
      contactEmail: '',
      proceedsText:
        'Every R1,000 charitable entry goes towards establishing a running community around Melorane: ' +
        'shoes and kit for local runners, coaching and training support, and regular community runs after race day.',
    },
    pools: {
      combined: { limit: 34 },
      community: { limit: 16 },
    },
    fees: {
      group_employee: { amount: 100000, confirmed: true, label: 'Charitable entry fee' },
      other: { amount: 100000, confirmed: true, label: 'Charitable entry fee' },
      melorane_employee: { amount: null, confirmed: false, label: 'Entry fee' },
      community: { amount: null, confirmed: false, label: 'Entry fee' },
    },
    // Preview only: lets reviewers try the community and Melorane flows before fees are set.
    // Places are held without a payment request; nothing is charged. Switch off before launch.
    acceptWhileFeeUnconfirmed: true,
    reservation: { expiryHours: 72 },
    terms: {
      approved: false,
      version: 'draft-0.1',
      text:
        'DRAFT – awaiting organiser approval. Participants take part at their own risk, must follow marshal and ' +
        'ranger instructions at all times, and must stay on the marked route inside the reserve.',
    },
    inviteCodes: [
      { code: 'GROUP-PREVIEW', category: 'group_employee', maxUses: 100, uses: 0, note: 'Sample code' },
      { code: 'MELORANE-PREVIEW', category: 'melorane_employee', maxUses: 100, uses: 0, note: 'Sample code' },
    ],
    lodge: {
      ratePerNight: 550000,
      depositPercent: 20,
      balanceDueDate: '2027-01-31',
      // Inventory below is SAMPLE data. Lodge capacity has not been supplied.
      inventoryConfirmed: false,
      nights: [
        { date: '2027-04-15', beds: 12 },
        { date: '2027-04-16', beds: 12 },
        { date: '2027-04-17', beds: 12 },
      ],
      latePolicy: { confirmed: false, mode: '', days: 7, text: '' },
      holdHours: 72,
    },
    waterPoints: {
      price: 500000,
      holdHours: 72,
      responsibilities: { water: 'tbc', refreshments: 'tbc', equipment: 'tbc', staff: 'tbc' },
      benefits: [
        'Recognition on the event website',
        'Approved branding at the sponsored water point',
        'A post-event thank-you',
      ],
      benefitsApproved: false,
    },
    donations: {
      target: 16,
      shoePrice: null,
      kitPrice: null,
      financialEnabled: false,
      conditionCriteria: ['New', 'Used – clean, soles intact, no tears'],
      criteriaApproved: false,
      dropOffText: '',
    },
    payments: {
      providerName: '',
      providerConnected: false,
      previewProvider: true,
      eftEnabled: true,
      eftDetails: 'Bank details to be supplied by ERP finance.',
      eftConfirmed: false,
    },
    messaging: { emailConnected: false, smsConnected: false },
    buddy: {
      resourcesApproved: false,
      resourcesText: 'Training resources will be shared once approved by the organisers.',
    },
    organisers: [
      // Preview credentials. Production uses server-side authentication (see README).
      { email: 'organiser@preview.local', password: 'runwild-preview', name: 'Preview organiser' },
    ],
  };
}

const FIRST = ['Lerato', 'Johan', 'Anika', 'Sipho', 'Megan', 'Tumi', 'Pieter', 'Naledi', 'Ruan', 'Zanele',
  'Chris', 'Busi', 'Elsa', 'Kabelo', 'Nina', 'Thabo', 'Lize', 'Mpho', 'Dirk', 'Karabo', 'Sarah', 'Neo',
  'Marius', 'Palesa', 'Hanno', 'Refilwe', 'Willem', 'Dineo', 'Gerhard', 'Boitumelo', 'Annelie', 'Tshepo',
  'Kobus', 'Lindiwe', 'Ilse', 'Oratile', 'Retha', 'Kagiso', 'Jaco', 'Masego', 'Francois', 'Kelebogile'];
const INIT = 'ABDGKLMNPRSTVZ';

// Builds sample records directly. Every record carries sample:true and shows a "Sample" badge.
export function sampleData(now, settings) {
  let n = 0;
  const name = () => FIRST[n % FIRST.length] + ' ' + INIT[(n * 7) % INIT.length] + '.';
  const regs = [];
  const charges = [];
  const payments = [];
  const ts = now - 20 * 86400000;
  const mk = (category, distance, status, extra = {}) => {
    n++;
    const id = 'sample-reg-' + n;
    const r = {
      id, sample: true, ref: 'RWM-S' + String(n).padStart(4, '0'), createdAt: ts + n * 3600000,
      clientRequestId: 'seed-' + n, fullName: name(), category, distance,
      mobile: '07100' + String(10000 + n).slice(-5), email: category === 'community' ? '' : 'sample' + n + '@example.org',
      emergencyName: 'Sample contact', emergencyMobile: '0820000000', employer: category.endsWith('employee') ? (category === 'melorane_employee' ? 'Melorane' : 'Group company (sample)') : '',
      termsVersion: settings.terms.version, status, expiresAt: null, verification: category.endsWith('employee') ? 'verified' : 'n/a',
      assisted: false, lodge: null, buddy: null, kit: null, pickupAck: category === 'community', transportAck: false,
      ...extra,
    };
    regs.push(r);
    const fee = settings.fees[category];
    if (fee.confirmed && fee.amount && status !== 'waitlisted' && status !== 'draft') {
      const ch = { id: 'sample-ch-' + n, kind: 'entry', ownerType: 'registration', ownerId: id, label: fee.label, amount: fee.amount, ref: r.ref + '-E', createdAt: r.createdAt, sample: true };
      charges.push(ch);
      if (status === 'confirmed') payments.push({ id: 'sample-pay-' + n, chargeId: ch.id, amount: fee.amount, method: n % 3 ? 'provider' : 'eft', status: 'received', at: r.createdAt + 600000, providerEventId: 'seed-evt-' + n, note: 'Sample payment', sample: true });
    }
    return r;
  };

  // Combined pool: 29 confirmed + 2 live reservations = 31 of 34 used.
  for (let i = 0; i < 29; i++) mk(i % 3 === 0 ? 'group_employee' : 'other', i % 4 === 0 ? '5k' : '21k', 'confirmed', { transportAck: true });
  mk('other', '21k', 'reserved', { expiresAt: now + 30 * 3600000, transportAck: true });
  mk('group_employee', '5k', 'reserved', { expiresAt: now + 50 * 3600000, transportAck: true });
  mk('other', '21k', 'cancelled', { cancelReason: 'Withdrew (sample)' });

  // Community pool: 13 held of 16 (fee unconfirmed, so held without a payment request).
  const sizes = ['6', '7', '8', '9', '10', '7', '8', '5', '9', '6', '8', '11', '7'];
  const shirts = ['S', 'M', 'L', 'M', 'XL', 'S', 'M', 'XS', 'L', 'M', 'M', 'L', 'S'];
  for (let i = 0; i < 13; i++) {
    mk('community', i % 2 ? '5k' : '21k', 'reserved', {
      expiresAt: null, holdReason: 'fee_unconfirmed', assisted: i % 4 === 0,
      kit: { shoeSize: sizes[i], shoeSystem: 'UK', shirtSize: shirts[i], shortsSize: shirts[i], needsShoes: i % 3 !== 2, needsKit: i % 2 === 0 },
      buddy: i < 6 ? { optIn: true, status: i < 2 ? 'matched' : 'awaiting_match' } : { optIn: false },
    });
  }

  // Melorane employees: outside both limited pools.
  for (let i = 0; i < 6; i++) mk('melorane_employee', i % 2 ? '5k' : '21k', 'reserved', { expiresAt: null, holdReason: 'fee_unconfirmed' });

  // Buddy volunteers among combined-pool runners.
  const volunteers = regs.filter((r) => r.category !== 'community' && r.status === 'confirmed').slice(0, 5);
  volunteers.forEach((r, i) => {
    r.buddy = { optIn: true, status: i < 2 ? 'matched' : i === 4 ? 'volunteered' : 'awaiting_match', preferredDistance: r.distance, experience: ['Several half marathons', 'Club runner, 10 years', 'Parkrun regular', 'Trail runner', 'New to running'][i], availability: 'Weekday evenings', contactMethod: 'WhatsApp', support: 'Weekly check-ins and a shared training plan.' };
  });
  const community = regs.filter((r) => r.category === 'community');
  const matches = [
    { id: 'sample-m-1', sample: true, volunteerId: volunteers[0].id, communityId: community[0].id, status: 'introduced', consentVolunteer: true, consentCommunity: true, createdAt: now - 5 * 86400000 },
    { id: 'sample-m-2', sample: true, volunteerId: volunteers[1].id, communityId: community[1].id, status: 'proposed', consentVolunteer: true, consentCommunity: false, createdAt: now - 2 * 86400000 },
  ];

  // Lodge: a few requests in different states.
  const lodgeRequests = [];
  const lodgeFor = (r, arrival, departure, status, paid) => {
    const nights = Math.round((Date.parse(departure) - Date.parse(arrival)) / 86400000);
    const total = settings.lodge.ratePerNight * nights;
    const deposit = Math.round(total * settings.lodge.depositPercent / 100);
    const lr = { id: 'sample-l-' + r.id, sample: true, registrationId: r.id, arrival, departure, nights, total, deposit, balance: total - deposit, status, requestedOn: '2026-10-01', balanceDue: settings.lodge.balanceDueDate, createdAt: r.createdAt, expiresAt: status === 'awaiting_deposit' ? now + 40 * 3600000 : null };
    lodgeRequests.push(lr);
    r.lodge = { wanted: true, requestId: lr.id };
    const dc = { id: 'sample-ch-ld-' + r.id, kind: 'lodge_deposit', ownerType: 'lodge', ownerId: lr.id, label: 'Canvas Lodge deposit (20%)', amount: deposit, ref: r.ref + '-LD', createdAt: r.createdAt, sample: true };
    const bc = { id: 'sample-ch-lb-' + r.id, kind: 'lodge_balance', ownerType: 'lodge', ownerId: lr.id, label: 'Canvas Lodge balance (80%)', amount: total - deposit, ref: r.ref + '-LB', dueDate: settings.lodge.balanceDueDate, createdAt: r.createdAt, sample: true };
    charges.push(dc, bc);
    if (paid >= 1) payments.push({ id: 'sample-pay-ld-' + r.id, chargeId: dc.id, amount: deposit, method: 'eft', status: 'received', at: r.createdAt + 86400000, note: 'Sample payment', sample: true });
    if (paid >= 2) payments.push({ id: 'sample-pay-lb-' + r.id, chargeId: bc.id, amount: total - deposit, method: 'eft', status: 'received', at: r.createdAt + 2 * 86400000, note: 'Sample payment', sample: true });
  };
  const combinedConfirmed = regs.filter((r) => (r.category === 'other' || r.category === 'group_employee') && r.status === 'confirmed');
  lodgeFor(combinedConfirmed[2], '2027-04-16', '2027-04-17', 'confirmed', 1);
  lodgeFor(combinedConfirmed[3], '2027-04-16', '2027-04-18', 'paid_in_full', 2);
  lodgeFor(combinedConfirmed[5], '2027-04-15', '2027-04-17', 'confirmed', 1);
  lodgeFor(combinedConfirmed[8], '2027-04-16', '2027-04-17', 'awaiting_deposit', 0);
  regs.filter((r) => r.category !== 'community' && r.category !== 'melorane_employee' && !r.lodge).forEach((r) => { r.lodge = { wanted: false }; });

  // Water points: 1 sponsored, 3 temporarily reserved, 2, 4 and 5 open.
  const sponsorships = [
    { id: 'sample-sp-1', sample: true, ref: 'RWM-WS001', point: 1, name: 'Sample Engineering (Pty) Ltd', contactPerson: 'Sample contact', email: 'sponsor@example.org', phone: '0110000000', website: '', logo: '', billing: '', displayConsent: true, status: 'confirmed', createdAt: ts, expiresAt: null },
    { id: 'sample-sp-3', sample: true, ref: 'RWM-WS003', point: 3, name: 'Sample Family Trust', contactPerson: 'Sample contact', email: 'trust@example.org', phone: '0120000000', website: '', logo: '', billing: '', displayConsent: false, status: 'reserved', createdAt: now - 3600000, expiresAt: now + 47 * 3600000 },
  ];
  charges.push({ id: 'sample-ch-sp-1', kind: 'sponsorship', ownerType: 'sponsorship', ownerId: 'sample-sp-1', label: 'Water Point 1 sponsorship', amount: settings.waterPoints.price, ref: 'RWM-WS001', createdAt: ts, sample: true });
  charges.push({ id: 'sample-ch-sp-3', kind: 'sponsorship', ownerType: 'sponsorship', ownerId: 'sample-sp-3', label: 'Water Point 3 sponsorship', amount: settings.waterPoints.price, ref: 'RWM-WS003', createdAt: now - 3600000, sample: true });
  payments.push({ id: 'sample-pay-sp-1', chargeId: 'sample-ch-sp-1', amount: settings.waterPoints.price, method: 'eft', status: 'received', at: ts + 86400000, note: 'Sample payment', sample: true });

  // Donations: pledges are not stock until received.
  const pledges = [
    { id: 'sample-p-1', sample: true, ref: 'RWM-DP001', donor: 'Sample donor A', email: 'donor@example.org', phone: '', type: 'shoes', quantity: 4, size: '8', sizeSystem: 'UK', shirtSize: '', shortsSize: '', condition: 'New', delivery: 'Drop-off', status: 'received', receivedQty: 4, createdAt: ts },
    { id: 'sample-p-2', sample: true, ref: 'RWM-DP002', donor: 'Sample running club', email: 'club@example.org', phone: '', type: 'kit', quantity: 6, size: '', sizeSystem: '', shirtSize: 'M', shortsSize: 'M', condition: 'New', delivery: 'Collection requested', status: 'pledged', receivedQty: 0, createdAt: ts },
    { id: 'sample-p-3', sample: true, ref: 'RWM-DP003', donor: 'Sample donor B', email: 'donorb@example.org', phone: '', type: 'shoes', quantity: 2, size: '7', sizeSystem: 'UK', shirtSize: '', shortsSize: '', condition: 'Used – clean, soles intact, no tears', delivery: 'Courier', status: 'pledged', receivedQty: 0, createdAt: ts },
  ];
  const stock = [];
  for (let i = 0; i < 4; i++) stock.push({ id: 'sample-st-' + i, sample: true, type: 'shoes', size: '8', sizeSystem: 'UK', shirtSize: '', shortsSize: '', source: 'pledge', sourceId: 'sample-p-1', status: 'in_stock', allocatedTo: null, receivedAt: ts + 86400000 });
  const shoe8 = community.find((r) => r.kit.shoeSize === '8' && r.kit.needsShoes);
  if (shoe8) { stock[0].status = 'allocated'; stock[0].allocatedTo = shoe8.id; }

  return { registrations: regs, charges, payments, lodgeRequests, sponsorships, pledges, stock, matches, contributions: [] };
}

// Entry confirmation as a downloadable PDF. Built in the browser with jsPDF (js/vendor, MIT
// licence), which is loaded only when someone asks for a PDF. Works the same on the preview and
// the live site: the PDF is drawn from the confirmation object the backend already returns.

import { CATEGORIES, DISTANCES, STATUS_LABELS, rand, formatDate, formatDateTime } from './core.js';
import { toast } from './ui.js';

const NAVY = [19, 27, 65];
const BLUE = [0, 102, 178];
const MUTED = [116, 104, 91];
const LINE = [228, 221, 213];
const SAND = [241, 238, 234];
const TONES = { ok: [[231, 244, 241], [19, 122, 102]], bad: [[248, 233, 230], [178, 58, 42]], sun: [[251, 244, 226], [154, 100, 0]] };

const LODGE_LABELS = { requested: 'Requested – not yet confirmed', awaiting_deposit: 'Beds held – deposit due', confirmed: 'Confirmed – balance outstanding', paid_in_full: 'Paid in full', declined: 'Declined', cancelled: 'Cancelled', expired: 'Hold expired' };

// The standard PDF fonts only cover Windows-1252, so swap anything else for a close match.
const clean = (v) => String(v ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/[‐‑‒]/g, '-').replace(/[×]/g, 'x').replace(/[^\x00-\xff–—‘’“”•…€]/g, '');

// What the PDF says: the same facts as the on-screen confirmation (confirmationHTML in app.js).
export function confirmationContent(r) {
  const cat = CATEGORIES[r.category] || { label: r.category };
  const entry = r.charges.find((c) => c.kind === 'entry');
  const amounts = [...(entry ? [entry] : []), ...r.charges.filter((c) => c.kind === 'socks'), ...r.charges.filter((c) => c.kind.startsWith('lodge'))];
  const rows = [
    ['Reference', r.ref],
    ['Status', STATUS_LABELS[r.status] || r.status],
    ['Name', r.fullName],
    ['Category', cat.label + (r.verification === 'verified' ? ' · verified' : '')],
    ['Distance', DISTANCES[r.distance] || r.distance],
    ['RunWild shirt', (r.shirtSize ? 'Size ' + r.shirtSize : '—') + ' – included with your entry'],
  ];
  if (r.socks) rows.push(['Socks', `${r.socks.qty} pair${r.socks.qty > 1 ? 's' : ''}, size ${r.socks.size}${r.socksPrice ? '' : ' – price to be confirmed, nothing payable yet'}`]);
  if (r.kit && (r.kit.needsShoes || r.kit.needsKit)) rows.push(['Running kit requested', [r.kit.needsShoes && 'Shoes (' + r.kit.shoeSize + ' ' + r.kit.shoeSystem + ')', r.kit.needsKit && 'Kit (shorts ' + r.kit.shortsSize + ')'].filter(Boolean).join(', ')]);
  rows.push(['Race day', formatDate(r.event.date) + ' · ' + (r.event.startTime || 'Early start – exact time to be confirmed')]);
  if (r.category === 'community') rows.push(['Pickup', `${r.event.pickupPlace} at ${r.event.pickupTime} on ${formatDate(r.event.date)}${r.event.pickupFullAddress ? ' – ' + r.event.pickupFullAddress : ''}`]);
  else rows.push(['Getting there', r.lodgeWanted ? 'Staying at Canvas Lodge (see below).' : `Early start from ${r.event.venue || 'Melorane ERP Game Reserve'}. You arrange your own transport and arrive on time.`]);
  if (r.buddy) rows.push(['Run Buddy', r.buddy.optIn ? (r.buddy.status || 'awaiting match').replace(/_/g, ' ') : 'Not taking part']);
  if (!entry && r.status !== 'waitlisted' && r.status !== 'draft') rows.push(['Entry fee', r.fee.confirmed ? (r.fee.amount ? rand(r.fee.amount) : 'Free') : 'To be confirmed']);

  const status = {
    reserved: r.holdReason === 'awaiting_verification'
      ? 'Your place is held while an organiser checks your entry. There is nothing to pay – we will let you know once it is confirmed.'
      : r.holdReason === 'fee_unconfirmed'
        ? 'Your place is held. The entry fee for your category has not been confirmed yet, so nothing is payable now. We will let you know the fee before anything is due.'
        : `Your place is reserved until ${formatDateTime(r.expiresAt)}. Pay the charitable entry fee before then to confirm it. Unpaid reservations are released automatically.`,
    confirmed: 'Your entry is confirmed. See you at Melorane!',
    waitlisted: 'This category is full, so you are on the waitlist. No payment is needed now. If a place opens up, the organisers will contact you – you will never be charged or confirmed automatically.',
    draft: 'Your employee status needs to be verified by the organisers before a place can be allocated. No place is held yet and nothing is payable.',
    cancelled: r.cancelReason === 'reservation_expired' ? 'This reservation expired because payment was not received in time.' : 'This entry has been cancelled.',
  }[r.status] || '';

  let lodge = null;
  if (r.lodge) {
    const L = r.lodge;
    lodge = [`${LODGE_LABELS[L.status] || L.status} · ${formatDate(L.arrival)} to ${formatDate(L.departure)} · ${L.nights} night${L.nights > 1 ? 's' : ''}`];
    if (L.note) lodge.push(L.note);
    if (L.status === 'awaiting_deposit') lodge.push(`Beds are held until ${formatDateTime(L.expiresAt)}. Your stay is confirmed once the deposit is verified.`);
    if (L.balanceNote) lodge.push(L.balanceNote);
  }

  const outstandingRefs = r.charges.filter((c) => c.outstanding > 0).map((c) => c.ref);
  const eft = amounts.length && r.payments && r.payments.eftEnabled ? {
    text: 'Paying by EFT? Use the payment reference shown for each item so we can match your payment.'
      + (outstandingRefs.length ? ` Your reference${outstandingRefs.length > 1 ? 's' : ''}: ${outstandingRefs.join(', ')}.` : '')
      + ' Your payment is marked as received only once ERP finance has reconciled it against the bank statement – proof of payment on its own does not confirm an entry.',
    details: (r.payments.eftDetails || '') + (r.payments.eftConfirmed ? '' : ' (bank details to be confirmed)'),
  } : null;

  const tone = r.status === 'confirmed' ? 'ok' : r.status === 'cancelled' ? 'bad' : 'sun';
  return { rows, status, tone, lodge, amounts, eft };
}

// Draws the PDF. JsPDF is the jsPDF constructor; logo is an optional PNG data URL (white logo).
export function buildConfirmationPDF(JsPDF, r, { logo = null, generatedAt = Date.now() } = {}) {
  const c = confirmationContent(r);
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297, M = 18, CW = W - 2 * M;
  let y = 0;

  const color = (rgb, kind = 'text') => (kind === 'text' ? doc.setTextColor(...rgb) : kind === 'fill' ? doc.setFillColor(...rgb) : doc.setDrawColor(...rgb));
  const font = (size, style = 'normal', rgb = NAVY) => { doc.setFont('helvetica', style); doc.setFontSize(size); color(rgb); };
  const lines = (text, width) => doc.splitTextToSize(clean(text), width);
  const lh = (size) => size * 0.3528 * 1.35; // line height in mm for a font size in pt
  const room = (need) => { if (y + need > H - 22) { doc.addPage(); y = M; } };

  // Header band
  color(NAVY, 'fill'); doc.rect(0, 0, W, 30, 'F');
  if (logo) { try { doc.addImage(logo, 'PNG', M, 7, 47.5, 16); } catch { /* logo is optional */ } }
  font(9, 'normal', [255, 255, 255]);
  doc.text('ENTRY CONFIRMATION', W - M, 12, { align: 'right' });
  font(13, 'bold', [255, 255, 255]);
  doc.text('Run Wild Melorane', W - M, 19, { align: 'right' });
  font(9, 'normal', [191, 220, 243]);
  doc.text(clean(formatDate(r.event.date) + ' · ' + (r.event.venue || 'Melorane ERP Game Reserve')), W - M, 24.5, { align: 'right' });
  y = 38;

  // Reference panel
  color(SAND, 'fill'); doc.roundedRect(M, y, CW, 20, 2, 2, 'F');
  font(8, 'normal', MUTED); doc.text('YOUR REFERENCE', M + 6, y + 7);
  font(18, 'bold', NAVY); doc.text(clean(r.ref), M + 6, y + 15);
  font(8, 'normal', MUTED); doc.text('STATUS', W - M - 6, y + 7, { align: 'right' });
  font(11, 'bold', TONES[c.tone][1]); doc.text(clean(STATUS_LABELS[r.status] || r.status), W - M - 6, y + 14.5, { align: 'right' });
  y += 25;
  font(8.5, 'normal', MUTED);
  doc.text(clean('Keep your reference number. You need it with your mobile number to view your entry, pay, or ask the organisers anything.'), M, y);
  y += 6;

  // Details table
  const LW = 46;
  for (const [label, value] of c.rows.slice(2)) {
    const v = lines(value, CW - LW - 4);
    const h = Math.max(1, v.length) * lh(10) + 2.6;
    room(h);
    font(9, 'bold', MUTED); doc.text(clean(label), M, y + 4.3);
    font(10, 'normal', NAVY); doc.text(v, M + LW, y + 4.3);
    y += h;
    color(LINE, 'draw'); doc.setLineWidth(0.2); doc.line(M, y, W - M, y);
  }
  y += 6;

  // Status notice
  if (c.status) {
    const [bg, fg] = TONES[c.tone];
    const t = lines(c.status, CW - 12);
    const h = t.length * lh(10) + 8;
    room(h);
    color(bg, 'fill'); doc.rect(M, y, CW, h, 'F');
    color(fg, 'fill'); doc.rect(M, y, 1.4, h, 'F');
    font(10, 'normal', NAVY); doc.text(t, M + 6, y + 6.2);
    y += h + 6;
  }

  const heading = (text) => { room(14); font(12, 'bold', NAVY); doc.text(text, M, y); y += 6; };
  const para = (text, size = 10, rgb = NAVY) => { const t = lines(text, CW); room(t.length * lh(size) + 2); font(size, 'normal', rgb); doc.text(t, M, y + 3.4); y += t.length * lh(size) + 2; };

  if (c.lodge) { heading('Canvas Lodge'); c.lodge.forEach((p, i) => para(p, i ? 9 : 10, i ? MUTED : NAVY)); y += 6; }

  if (c.amounts.length) {
    heading('Amounts');
    const cols = [M + CW - 56, M + CW - 28, M + CW]; // right edges of Amount, Paid, Outstanding
    room(10);
    color(NAVY, 'fill'); doc.rect(M, y, CW, 7, 'F');
    font(8.5, 'bold', [255, 255, 255]);
    doc.text('Item', M + 2, y + 4.8);
    ['Amount', 'Paid', 'Outstanding'].forEach((h, i) => doc.text(h, cols[i] - 2, y + 4.8, { align: 'right' }));
    y += 7;
    let total = 0;
    for (const ch of c.amounts) {
      total += ch.outstanding;
      const label = lines(ch.label, cols[0] - M - 30);
      const sub = 'Ref ' + ch.ref + (ch.dueDate ? ' · balance due ' + formatDate(ch.dueDate) : '');
      const h = label.length * lh(9.5) + lh(8) + 3;
      room(h);
      font(9.5, 'normal', NAVY); doc.text(label, M + 2, y + 4.4);
      font(8, 'normal', MUTED); doc.text(clean(sub), M + 2, y + 4.4 + label.length * lh(9.5));
      font(9.5, 'normal', NAVY);
      doc.text(clean(rand(ch.amount)), cols[0] - 2, y + 4.4, { align: 'right' });
      doc.text(clean(rand(ch.paid)), cols[1] - 2, y + 4.4, { align: 'right' });
      font(9.5, 'bold', NAVY); doc.text(clean(rand(ch.outstanding)), cols[2] - 2, y + 4.4, { align: 'right' });
      y += h;
      color(LINE, 'draw'); doc.setLineWidth(0.2); doc.line(M, y, W - M, y);
    }
    room(9);
    font(9.5, 'bold', NAVY);
    doc.text('Total outstanding', cols[1] - 2, y + 5.5, { align: 'right' });
    doc.text(clean(rand(total)), cols[2] - 2, y + 5.5, { align: 'right' });
    y += 11;
  }

  if (c.eft) {
    const t = lines(c.eft.text, CW - 12), d = lines(c.eft.details, CW - 12);
    const h = t.length * lh(9.5) + d.length * lh(9) + 8;
    room(h);
    color([229, 241, 250], 'fill'); doc.rect(M, y, CW, h, 'F');
    color(BLUE, 'fill'); doc.rect(M, y, 1.4, h, 'F');
    font(9.5, 'normal', NAVY); doc.text(t, M + 6, y + 6);
    font(9, 'normal', MUTED); doc.text(d, M + 6, y + 8 + t.length * lh(9.5));
    y += h + 6;
  }

  // Footer on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    color(LINE, 'draw'); doc.setLineWidth(0.3); doc.line(M, H - 16, W - M, H - 16);
    font(8, 'normal', MUTED);
    doc.text(clean('Run Wild Melorane – an ERP (Elephants, Rhinos & People) initiative · info@erp.ngo · erp.ngo'), M, H - 11);
    doc.text(clean('Generated ' + formatDateTime(generatedAt) + (pages > 1 ? ` · page ${p} of ${pages}` : '')), W - M, H - 11, { align: 'right' });
  }
  doc.setProperties({ title: 'Run Wild Melorane – entry ' + r.ref, subject: 'Entry confirmation', author: 'ERP – Elephants, Rhinos & People' });
  return doc;
}

export const pdfFileName = (r) => `RunWild-Melorane-${String(r.ref).replace(/[^A-Za-z0-9-]/g, '')}.pdf`;

// ---------- browser only ----------

let loading = null;
function loadJsPDF() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  loading = loading || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/jspdf.umd.min.js', import.meta.url).href;
    s.onload = () => (window.jspdf ? resolve(window.jspdf.jsPDF) : reject(new Error('PDF library did not load.')));
    s.onerror = () => { loading = null; reject(new Error('Could not load the PDF library. Check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return loading;
}

async function loadLogo() {
  try {
    const blob = await (await fetch(new URL('../assets/logo-white.png', import.meta.url))).blob();
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
  } catch { return null; }
}

// Builds the PDF and starts the download.
export async function downloadConfirmationPDF(r) {
  const [JsPDF, logo] = await Promise.all([loadJsPDF(), loadLogo()]);
  buildConfirmationPDF(JsPDF, r, { logo }).save(pdfFileName(r));
}

// Wires a button to download the PDF. getConf returns (or resolves to) the confirmation object.
export function bindPdfButton(btn, getConf, after) {
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing PDF…';
    try {
      const r = await getConf();
      await downloadConfirmationPDF(r);
      if (after) after(r);
    } catch (e) {
      toast(e.message || 'Could not create the PDF.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

// Opens the organiser's email program with a ready-made message. Browsers cannot attach files to a
// mailto: link, so the PDF is downloaded first and the organiser attaches it.
export function emailConfirmation(r) {
  const subject = 'Run Wild Melorane – your entry confirmation (' + r.ref + ')';
  const body = [
    'Dear ' + r.fullName + ',',
    '',
    'Thank you for entering Run Wild Melorane on ' + formatDate(r.event.date) + '.',
    'Please find your entry confirmation attached (' + pdfFileName(r) + ').',
    '',
    'Reference: ' + r.ref,
    'Status: ' + (STATUS_LABELS[r.status] || r.status),
    'Distance: ' + (DISTANCES[r.distance] || r.distance),
    '',
    'Keep your reference number. You need it with your mobile number to view your entry, pay, or ask us anything.',
    '',
    'Kind regards,',
    'Run Wild Melorane organisers',
  ].join('\n');
  window.location.href = 'mailto:' + encodeURIComponent(r.email || '').replace(/%40/g, '@') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  toast('PDF downloaded – attach it to the email that just opened.');
}

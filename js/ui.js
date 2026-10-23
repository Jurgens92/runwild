import { Backend, localStorageAdapter } from './backend.js';
import { rand, formatDate, formatDateTime, STATUS_LABELS } from './core.js';

export const api = new Backend({ storage: localStorageAdapter() });

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, bad = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

export function tbc(text = 'To be confirmed') { return `<span class="tbc">${esc(text)}</span>`; }
export function sampleBadge(rec) { return rec && rec.sample ? ' <span class="sample">Sample</span>' : ''; }

export function statusPill(status, label) {
  const text = label || STATUS_LABELS[status] || String(status || '').replace(/_/g, ' ');
  return `<span class="status ${esc(status)}">${esc(text)}</span>`;
}

export function pageHead(eyebrow, title, intro = '', back = null) {
  return `<section class="page-head"><div class="wrap">${back ? `<a class="back" href="${esc(back.href)}">← ${esc(back.label)}</a><br>` : ''}<span class="eyebrow">${esc(eyebrow)}</span><h1>${esc(title)}</h1>${intro ? `<p>${intro}</p>` : ''}</div></section>`;
}

// Shows field errors from a ValidationError next to inputs named in err.fields.
export function showErrors(form, err) {
  $$('.err', form).forEach((e) => e.remove());
  $$('.field.invalid', form).forEach((f) => f.classList.remove('invalid'));
  const box = $('.form-error', form);
  if (box) { box.hidden = false; box.innerHTML = `<p>${esc(err.message)}</p>`; }
  let first = null;
  for (const [name, msg] of Object.entries(err.fields || {})) {
    const holder = $(`[data-field="${name}"]`, form) || ($(`[name="${name}"]`, form) || {}).closest?.('.field');
    if (!holder) continue;
    holder.classList.add('invalid');
    const s = document.createElement('span');
    s.className = 'err';
    s.textContent = msg;
    holder.appendChild(s);
    first = first || holder;
  }
  (first || box || form).scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function clearErrors(form) {
  $$('.err', form).forEach((e) => e.remove());
  $$('.field.invalid', form).forEach((f) => f.classList.remove('invalid'));
  const box = $('.form-error', form);
  if (box) box.hidden = true;
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; else if (!(el.name in out)) out[el.name] = ''; }
    else out[el.name] = el.value;
  }
  return out;
}

// Payment summary + how to pay, for any set of charges.
export function chargesTable(charges, { showPay = true, payments } = {}) {
  if (!charges.length) return '';
  const rows = charges.map((c) => `
    <tr>
      <td>${esc(c.label)}<br><span class="small muted">Ref <span class="ref">${esc(c.ref)}</span>${c.dueDate ? ' · balance due ' + esc(formatDate(c.dueDate)) : ''}</span></td>
      <td class="num">${rand(c.amount)}</td>
      <td class="num">${rand(c.paid)}</td>
      <td class="num"><strong>${rand(c.outstanding)}</strong></td>
      ${showPay ? `<td>${c.outstanding > 0 && payments && (payments.previewProvider || payments.providerConnected) ? `<a class="btn small" href="#/pay/${encodeURIComponent(c.ref)}">Pay online</a>` : c.outstanding > 0 ? '' : statusPill('paid', 'Paid')}</td>` : ''}
    </tr>`).join('');
  return `<div class="table-wrap"><table class="data money">
    <thead><tr><th>Item</th><th class="num">Amount</th><th class="num">Paid</th><th class="num">Outstanding</th>${showPay ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export function eftBlock(payments, refs) {
  if (!payments.eftEnabled) return '';
  return `<div class="notice">
    <p><strong>Paying by EFT?</strong> Use the payment reference shown for each item so we can match your payment.
    ${refs && refs.length ? 'Your reference' + (refs.length > 1 ? 's' : '') + ': ' + refs.map((r) => `<span class="ref">${esc(r)}</span>`).join(', ') + '.' : ''}
    Your payment is marked as received only once ERP finance has reconciled it against the bank statement – proof of payment on its own does not confirm an entry.</p>
    <p class="small">${esc(payments.eftDetails)} ${payments.eftConfirmed ? '' : tbc('Bank details to be confirmed')}</p>
  </div>`;
}

export { rand, formatDate, formatDateTime };

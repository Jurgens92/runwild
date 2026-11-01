// Talks to the live API (Supabase Edge Function). Same method names and results as the in-browser
// Backend, so the pages work unchanged in either mode.

import { ValidationError, AuthError } from './backend.js';

const METHODS = [
  'publicSummary', 'checkInviteCode', 'submitRegistration', 'myEntry', 'consentToMatch', 'updateMyBuddy',
  'requestLodgeForEntry', 'addSocksForEntry', 'startCheckout', 'submitSponsorship', 'submitContribution',
  'submitLaunchRegistration', 'login', 'logout', 'dashboard', 'organiserAction', 'updateSettings',
  'createUser', 'updateUser', 'changePassword', 'exportData', 'entryConfirmation',
];

export class RemoteBackend {
  constructor(url) {
    this.url = url;
    this.live = true;
    for (const m of METHODS) this[m] = (...args) => this._call(m, args);
  }

  async _call(method, args) {
    let res;
    try {
      res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
    } catch {
      throw new ValidationError('Could not reach the server. Check your connection and try again.');
    }
    let body = null;
    try { body = await res.json(); } catch { /* handled below */ }
    if (body && body.error) {
      if (body.error.name === 'AuthError') throw new AuthError(body.error.message);
      throw new ValidationError(body.error.message, body.error.fields || {});
    }
    if (!res.ok || !body) throw new ValidationError('The server could not handle that request (' + res.status + '). Please try again.');
    return body.result;
  }

  // Not available on the live site.
  async previewSignNotification() { throw new ValidationError('Online payment is not available yet.'); }
  async providerNotification() { throw new ValidationError('Online payment is not available yet.'); }
  async resetPreview() { throw new ValidationError('Not available on the live site.'); }
}

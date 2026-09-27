'use strict';

/**
 * One free trial per person.
 *
 * The 7-day trial is given once per owner phone number, payout account
 * (bank + account number, M-Pesa Till/PayBill, or linked Tuma account) and
 * full name as on the ID. A later workspace that reuses any of these keeps
 * working, but its trial ends at once: it must choose a paid plan to sell.
 * The first workspace that used them is never affected.
 *
 * Only one-way fingerprints (SHA-256) are stored, never the raw values.
 */
const crypto = require('node:crypto');

function normaliseName(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

const LABELS = {
  phone: 'this phone number',
  payout: 'this payout account',
  name: 'this ID name',
};

function createTrialGuard({ db, normalizePhone = (v) => v, log = console }) {
  try { db.exec(`ALTER TABLE businesses ADD COLUMN trial_ended_reason TEXT`); } catch (_) { /* present */ }
  db.exec(`CREATE TABLE IF NOT EXISTS trial_fingerprints (
    kind TEXT NOT NULL, fingerprint TEXT NOT NULL, business_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, fingerprint, business_id)
  )`);
  const record = db.prepare(`INSERT OR IGNORE INTO trial_fingerprints (kind, fingerprint, business_id) VALUES (?, ?, ?)`);
  // Whoever recorded the value first keeps their trial (rowid gives the order).
  const firstOther = db.prepare(`SELECT business_id FROM trial_fingerprints WHERE kind=? AND fingerprint=? AND business_id != ?
    AND rowid < (SELECT MIN(rowid) FROM trial_fingerprints WHERE kind=? AND fingerprint=? AND business_id=?)
    ORDER BY rowid LIMIT 1`);
  const endTrial = db.prepare(`UPDATE businesses SET billing_expires_at=datetime('now'), trial_ended_reason=@reason
    WHERE id=@id AND billing_status='trial' AND (billing_expires_at IS NULL OR billing_expires_at > datetime('now'))`);

  function fingerprint(kind, value) {
    let clean = String(value || '').trim();
    if (kind === 'phone') clean = normalizePhone(clean) || '';
    if (kind === 'name') clean = normaliseName(clean);
    if (kind === 'payout') clean = clean.toLowerCase().replace(/\s+/g, '');
    if (!clean || (kind === 'name' && clean.split(' ').length < 2)) return null;
    return crypto.createHash('sha256').update(`${kind}:${clean}`).digest('hex');
  }

  /**
   * Records the values for this workspace. If another workspace used any of
   * them first, this workspace's free trial ends now. Returns the reason, or null.
   */
  function check(businessId, values = {}) {
    let reason = null;
    for (const kind of ['phone', 'payout', 'name']) {
      const fp = fingerprint(kind, values[kind]);
      if (!fp) continue;
      record.run(kind, fp, businessId);
      const other = firstOther.get(kind, fp, businessId, kind, fp, businessId);
      if (other && !reason) reason = `A free trial was already used with ${LABELS[kind]}.`;
    }
    if (reason) {
      const ended = endTrial.run({ id: businessId, reason }).changes > 0;
      if (ended) log.log(`[trial guard] ended trial for ${businessId}: ${reason}`);
      return ended ? reason : null;
    }
    return null;
  }

  /** Records existing owners' phones once, so they count as used trials. */
  function backfillPhones() {
    const rows = db.prepare(`SELECT id, owner_phone, created_at FROM businesses WHERE owner_phone IS NOT NULL AND owner_phone != '' ORDER BY created_at, rowid`).all();
    const insert = db.prepare(`INSERT OR IGNORE INTO trial_fingerprints (kind, fingerprint, business_id, created_at) VALUES ('phone', ?, ?, COALESCE(?, datetime('now')))`);
    for (const row of rows) { const fp = fingerprint('phone', row.owner_phone); if (fp) insert.run(fp, row.id, row.created_at); }
  }

  return { check, backfillPhones, fingerprint };
}

module.exports = { createTrialGuard, normaliseName };

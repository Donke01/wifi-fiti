'use strict';

/**
 * Owner phone verification by SMS code.
 *
 * The free trial is given once per phone number, so the number has to be
 * shown to belong to the person signing up. Until it is verified it never
 * counts as "used": nobody can end someone else's trial by typing their
 * number first, and a made-up number cannot start a second trial that sells.
 */
const crypto = require('node:crypto');

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const SENDS_PER_HOUR_PER_WORKSPACE = 3;
const SENDS_PER_DAY_PER_PHONE = 5;

function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function createPhoneVerification({ db, send, normalizePhone, displayPhone = (v) => v, onVerified = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_phone_codes (
    business_id TEXT PRIMARY KEY, phone TEXT NOT NULL, code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS owner_phone_sends (
    business_id TEXT NOT NULL, phone TEXT NOT NULL, sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_owner_phone_sends_phone ON owner_phone_sends(phone, sent_at);`);
  const sendsForWorkspace = db.prepare('SELECT COUNT(*) AS n FROM owner_phone_sends WHERE business_id=? AND sent_at>?');
  const sendsForPhone = db.prepare('SELECT COUNT(*) AS n FROM owner_phone_sends WHERE phone=? AND sent_at>?');
  const recordSend = db.prepare('INSERT INTO owner_phone_sends (business_id, phone, sent_at) VALUES (?, ?, ?)');
  const saveCode = db.prepare(`INSERT INTO owner_phone_codes (business_id, phone, code_hash, expires_at, attempts)
    VALUES (?, ?, ?, ?, 0) ON CONFLICT(business_id) DO UPDATE SET phone=excluded.phone,
    code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0`);
  const codeFor = db.prepare('SELECT * FROM owner_phone_codes WHERE business_id=?');
  const spendAttempt = db.prepare('UPDATE owner_phone_codes SET attempts=attempts+1 WHERE business_id=?');
  const clearCode = db.prepare('DELETE FROM owner_phone_codes WHERE business_id=?');
  const markVerified = db.prepare(`UPDATE businesses SET owner_phone=@phone, owner_phone_verified=@phone,
    owner_phone_verified_at=datetime('now') WHERE id=@id`);

  function available() { return typeof send === 'function'; }

  function verified(business) {
    return Boolean(business && business.owner_phone_verified && business.owner_phone
      && normalizePhone(business.owner_phone) === normalizePhone(business.owner_phone_verified));
  }

  async function start(business, suppliedPhone) {
    if (!available()) throw httpError(503, 'Phone verification is not available right now. Please try again later.');
    const phone = normalizePhone(suppliedPhone || business.owner_phone);
    if (!phone) throw httpError(400, 'Enter a valid Kenyan phone number.');
    const now = Date.now();
    if (sendsForWorkspace.get(business.id, now - 3600_000).n >= SENDS_PER_HOUR_PER_WORKSPACE
        || sendsForPhone.get(phone, now - 86400_000).n >= SENDS_PER_DAY_PER_PHONE) {
      throw httpError(429, 'Too many codes were sent. Please wait before asking for another one.');
    }
    const code = String(crypto.randomInt(100000, 1000000));
    saveCode.run(business.id, phone, hash(`${business.id}:${code}`), now + CODE_TTL_MS);
    recordSend.run(business.id, phone, now);
    await send({ to: `+${phone}`, message: `Your Wi-Fi Fiti code is ${code}. It expires in 10 minutes. Do not share it.` });
    return { sent: true, phoneDisplay: displayPhone(phone), expiresInSeconds: CODE_TTL_MS / 1000 };
  }

  async function confirm(business, suppliedCode) {
    const row = codeFor.get(business.id);
    if (!row) throw httpError(400, 'Ask for a new code first.');
    if (row.expires_at <= Date.now()) { clearCode.run(business.id); throw httpError(410, 'That code has expired. Ask for a new one.'); }
    if (row.attempts >= MAX_ATTEMPTS) { clearCode.run(business.id); throw httpError(429, 'Too many wrong codes. Ask for a new one.'); }
    const expected = Buffer.from(row.code_hash, 'hex');
    const supplied = Buffer.from(hash(`${business.id}:${String(suppliedCode || '').replace(/\D/g, '')}`), 'hex');
    if (!crypto.timingSafeEqual(expected, supplied)) {
      spendAttempt.run(business.id);
      throw httpError(400, 'That code is not correct.');
    }
    clearCode.run(business.id);
    markVerified.run({ id: business.id, phone: row.phone });
    const trialEnded = await onVerified(business.id, row.phone);
    return { verified: true, phone: row.phone, phoneDisplay: displayPhone(row.phone), trialEnded: trialEnded || null };
  }

  return { available, verified, start, confirm };
}

module.exports = { createPhoneVerification };

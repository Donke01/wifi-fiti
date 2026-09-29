'use strict';

/**
 * PPPoE customer billing.
 *
 * The owner puts a price on each speed plan. Each subscriber then has:
 *   - paid_until: the end of the days they have paid for;
 *   - credit: money received that does not yet cover a whole plan (a short
 *     payment, or the change from an overpayment). It adds up, and as soon as
 *     it covers the plan it becomes 30 more days by itself;
 *   - install_fee_due: a one-off installation fee, paid before any days;
 *   - next_profile_id: a plan change that starts at the next renewal;
 *   - boost_profile_id / boost_until: a faster plan for 24 hours.
 *
 * Access ends `grace_days` after paid_until (owner setting, 3 by default):
 * expires_at, which the router logic in pppoe.js enforces, is always
 * paid_until + grace. Paying during the grace days continues from
 * paid_until, so grace is borrowed, not free; paying after access ended
 * starts from the moment of payment.
 *
 * Every way money arrives ends in applyPayment: an M-Pesa prompt from the pay
 * page (recorded in tenant_transactions like a hotspot sale, so callbacks,
 * receipts, payouts and the 5% collection fee are shared), a PayBill payment
 * with the username as account number, or cash the owner records. When the
 * owner's own PPPoE plan with Wi-Fi Fiti has lapsed, prompts are refused; a
 * PayBill or cash payment that still arrives is kept as credit and turned
 * into days once the owner renews (sweep).
 */

const crypto = require('node:crypto');
const { db } = require('./db');
const config = require('../config');
const pppoe = require('./pppoe');
const serviceBilling = require('./service-billing');
const mpesa = require('./mpesa');

const DAY_MS = 86400_000;
const BOOST_HOURS = 24;
const MAX_KES = 1_000_000;
const REMIND_BEFORE_DAYS = 3;

db.exec(`
  CREATE TABLE IF NOT EXISTS pppoe_billing_settings (
    business_id TEXT PRIMARY KEY,
    pay_code TEXT NOT NULL UNIQUE,
    grace_days INTEGER NOT NULL DEFAULT 3,
    remind_before INTEGER NOT NULL DEFAULT 1,
    remind_day INTEGER NOT NULL DEFAULT 1,
    remind_after INTEGER NOT NULL DEFAULT 1,
    self_change_plan INTEGER NOT NULL DEFAULT 1,
    pay_for_others INTEGER NOT NULL DEFAULT 1,
    boosts INTEGER NOT NULL DEFAULT 1,
    expired_page INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pppoe_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    kind TEXT NOT NULL,
    method TEXT NOT NULL,
    amount INTEGER NOT NULL,
    receipt TEXT,
    checkout_request_id TEXT UNIQUE,
    payer_phone TEXT,
    to_install INTEGER NOT NULL DEFAULT 0,
    days_added INTEGER NOT NULL DEFAULT 0,
    credit_before INTEGER NOT NULL DEFAULT 0,
    credit_after INTEGER NOT NULL DEFAULT 0,
    paid_until_before TEXT,
    paid_until_after TEXT,
    profile_before TEXT,
    profile_after TEXT,
    boost_until_before TEXT,
    held INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    recorded_by TEXT,
    reversed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pppoe_payments_user ON pppoe_payments(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_pppoe_payments_business ON pppoe_payments(business_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pppoe_payments_receipt ON pppoe_payments(business_id, receipt) WHERE receipt IS NOT NULL;
  -- What an M-Pesa prompt from the pay page is for, until it settles.
  CREATE TABLE IF NOT EXISTS pppoe_payment_intents (
    checkout_request_id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    target_profile_id TEXT,
    amount INTEGER NOT NULL,
    from_credit INTEGER NOT NULL DEFAULT 0,
    payer_phone TEXT,
    notify_holder INTEGER NOT NULL DEFAULT 0,
    status_token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pppoe_reminders (
    user_id TEXT NOT NULL,
    reminder_key TEXT NOT NULL,
    result TEXT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, reminder_key)
  );
`);
// The public "Home internet" page (pppoe-connect.js): off until the owner
// turns it on, with an optional headline, the areas they cover and an
// installation fee to show.
for (const statement of [
  `ALTER TABLE pppoe_billing_settings ADD COLUMN home_page INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pppoe_billing_settings ADD COLUMN home_headline TEXT`,
  `ALTER TABLE pppoe_billing_settings ADD COLUMN home_areas TEXT`,
  `ALTER TABLE pppoe_billing_settings ADD COLUMN home_install_fee INTEGER`,
]) { try { db.exec(statement); } catch (_) {} }

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function fail(message, status = 400, extra = {}) { return Object.assign(new Error(message), { status, ...extra }); }
const parse = serviceBilling.parseTime;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const kes = (n) => `KES ${Math.round(Number(n) || 0).toLocaleString('en-KE')}`;
const bool = (v) => (v ? 1 : 0);
function money(value, label, { min = 0, max = MAX_KES, allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || value === '')) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(`${label} must be a whole number of shillings${min > 0 ? ` from ${min}` : ''} up to ${max.toLocaleString('en-KE')}.`);
  return n;
}
function nairobiDay(ms) { return new Date(ms + 3 * 3600_000).toISOString().slice(0, 10); }
function nairobiDayStart(ms) { return Date.parse(`${nairobiDay(ms)}T00:00:00Z`) - 3 * 3600_000; }
function dayText(ms) {
  return new Date(ms).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' });
}
function maskName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return words.map((w) => w[0].toUpperCase() + '*'.repeat(Math.min(7, Math.max(2, w.length - 1)))).join(' ');
}
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 9) return null;
  return `0${d.slice(-9, -6)} *** ${d.slice(-3)}`;
}
function savepoint(work) {
  const name = `pppoe_bill_${crypto.randomBytes(4).toString('hex')}`;
  db.exec(`SAVEPOINT ${name}`);
  try { const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newPayCode() {
  const bytes = crypto.randomBytes(7);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
const settingsRow = db.prepare('SELECT * FROM pppoe_billing_settings WHERE business_id=?');
function settingsFor(businessId) {
  let row = settingsRow.get(businessId);
  for (let i = 0; !row && i < 5; i++) {
    try { db.prepare('INSERT INTO pppoe_billing_settings (business_id, pay_code) VALUES (?, ?)').run(businessId, newPayCode()); } catch (_) { /* code taken, retry */ }
    row = settingsRow.get(businessId);
  }
  if (!row) throw fail('Could not set up PPPoE billing.', 500);
  return {
    payCode: row.pay_code,
    graceDays: Number(row.grace_days),
    remindBefore: Boolean(row.remind_before),
    remindDay: Boolean(row.remind_day),
    remindAfter: Boolean(row.remind_after),
    selfChangePlan: Boolean(row.self_change_plan),
    payForOthers: Boolean(row.pay_for_others),
    boosts: Boolean(row.boosts),
    expiredPage: Boolean(row.expired_page),
    homePage: Boolean(row.home_page),
    homeHeadline: row.home_headline || '',
    homeAreas: homeAreasOf(row.home_areas),
    homeInstallFee: row.home_install_fee == null ? null : Number(row.home_install_fee),
  };
}
const MAX_AREAS = 60;
function homeAreasOf(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  const seen = new Set(); const areas = [];
  for (const item of list) {
    const area = String(item || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!area || seen.has(area.toLowerCase())) continue;
    seen.add(area.toLowerCase()); areas.push(area);
    if (areas.length >= MAX_AREAS) break;
  }
  return areas;
}
function saveSettings(businessId, patch = {}) {
  const current = settingsFor(businessId);
  const next = { ...current };
  if (patch.graceDays !== undefined) {
    const g = Number(patch.graceDays);
    if (!Number.isInteger(g) || g < 0 || g > 7) throw fail('Grace days must be a whole number from 0 to 7.');
    next.graceDays = g;
  }
  for (const key of ['remindBefore', 'remindDay', 'remindAfter', 'selfChangePlan', 'payForOthers', 'boosts', 'expiredPage', 'homePage']) {
    if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
  }
  if (patch.homeHeadline !== undefined) {
    const headline = String(patch.homeHeadline || '').replace(/\s+/g, ' ').trim();
    if (headline.length > 90) throw fail('Keep the headline to 90 characters or fewer.');
    next.homeHeadline = headline;
  }
  if (patch.homeAreas !== undefined) next.homeAreas = homeAreasOf(patch.homeAreas);
  if (patch.homeInstallFee !== undefined) next.homeInstallFee = patch.homeInstallFee === null || patch.homeInstallFee === '' ? null : money(patch.homeInstallFee, 'Installation fee');
  db.prepare(`UPDATE pppoe_billing_settings SET grace_days=?, remind_before=?, remind_day=?, remind_after=?, self_change_plan=?,
      pay_for_others=?, boosts=?, expired_page=?, home_page=?, home_headline=?, home_areas=?, home_install_fee=?,
      updated_at=datetime('now') WHERE business_id=?`)
    .run(next.graceDays, bool(next.remindBefore), bool(next.remindDay), bool(next.remindAfter), bool(next.selfChangePlan),
      bool(next.payForOthers), bool(next.boosts), bool(next.expiredPage), bool(next.homePage), next.homeHeadline || null,
      next.homeAreas.length ? next.homeAreas.join('\n') : null, next.homeInstallFee, businessId);
  if (next.graceDays !== current.graceDays) regraceBusiness(businessId, next.graceDays);
  return settingsFor(businessId);
}
/** A new grace length moves every billed subscriber's cut-off. */
function regraceBusiness(businessId, graceDays, now = Date.now()) {
  const users = db.prepare(`SELECT * FROM pppoe_users WHERE business_id=? AND paid_until IS NOT NULL AND status IN ('active','expired')`).all(businessId);
  for (const user of users) {
    const paidUntil = parse(user.paid_until);
    if (paidUntil == null) continue;
    const expires = paidUntil + graceDays * DAY_MS;
    db.prepare(`UPDATE pppoe_users SET expires_at=?, updated_at=datetime('now') WHERE id=?`).run(iso(expires), user.id);
    // Back inside the longer grace: switch the login back on.
    if (user.status === 'expired' && expires > now) {
      db.prepare(`UPDATE pppoe_users SET status='active' WHERE id=?`).run(user.id);
      if (user.location_id) queueJob(user, { reconnect: true });
    }
  }
}
function businessForPayCode(code) {
  const clean = String(code || '').trim().toLowerCase();
  if (!/^[a-z0-9]{4,16}$/.test(clean)) return null;
  const row = db.prepare('SELECT business_id FROM pppoe_billing_settings WHERE pay_code=?').get(clean);
  return row ? db.prepare('SELECT * FROM businesses WHERE id=?').get(row.business_id) : null;
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

const userById = db.prepare('SELECT * FROM pppoe_users WHERE id=?');
const profileById = db.prepare('SELECT * FROM pppoe_profiles WHERE id=?');
const businessById = db.prepare('SELECT * FROM businesses WHERE id=?');
function userFor(businessId, userId) {
  const user = userById.get(String(userId || ''));
  if (!user || user.business_id !== businessId) throw fail('PPPoE subscriber was not found.', 404);
  return user;
}
/** A subscriber by account number (username), as a customer or M-Pesa types it. */
function userByUsername(businessId, username) {
  const raw = String(username || '').trim();
  if (!raw || raw.length > 96) return null;
  const exact = db.prepare('SELECT * FROM pppoe_users WHERE business_id=? AND username=?').get(businessId, raw);
  if (exact) return exact;
  const loose = db.prepare('SELECT * FROM pppoe_users WHERE business_id=? AND lower(username)=lower(?)').all(businessId, raw);
  return loose.length === 1 ? loose[0] : null;
}
function billedProfile(profile) { return Boolean(profile && Number(profile.price) > 0); }
function pricedPlans(businessId) {
  return db.prepare(`SELECT * FROM pppoe_profiles WHERE business_id=? AND active=1 AND price IS NOT NULL AND price > 0 ORDER BY price, name`).all(businessId);
}
/** Price per day, to compare plans with different periods fairly. */
function perDay(profile) { return Number(profile.price) / Math.max(1, Number(profile.period_days) || 30); }

/**
 * Whether the owner's own PPPoE plan with Wi-Fi Fiti lets customers be
 * served (trial, active or its grace days). If not, customer payments are
 * refused.
 */
function ownerCanServe(business) {
  if (!business) return false;
  return serviceBilling.pppoeAddBlockDetail(business, { adding: false }) === null;
}

/* ------------------------------------------------------------------ */
/* Account state                                                       */
/* ------------------------------------------------------------------ */

function paidUntilOf(user) { return parse(user.paid_until) ?? parse(user.expires_at); }

/**
 * Where a subscriber stands:
 *   paid | due (3 days or less left) | grace | expired | awaiting_payment
 *   | no_expiry (never expires, owner-managed) | disabled
 * and how much renews the next period.
 */
function accountState(user, { now = Date.now(), settings = settingsFor(user.business_id) } = {}) {
  const profile = profileById.get(user.profile_id);
  const next = user.next_profile_id ? profileById.get(user.next_profile_id) : null;
  const renewProfile = billedProfile(next) ? next : profile;
  const paidUntil = paidUntilOf(user);
  const accessUntil = paidUntil == null ? null : (user.paid_until ? paidUntil + settings.graceDays * DAY_MS : paidUntil);
  let status;
  if (user.status === 'disabled') status = 'disabled';
  else if (user.status === 'awaiting_payment' && paidUntil == null) status = 'awaiting_payment';
  else if (paidUntil == null) status = 'no_expiry';
  else if (now < paidUntil) status = paidUntil - now <= REMIND_BEFORE_DAYS * DAY_MS ? 'due' : 'paid';
  else if (accessUntil != null && now < accessUntil) status = 'grace';
  else status = 'expired';
  const price = billedProfile(renewProfile) ? Number(renewProfile.price) : null;
  const credit = Number(user.credit) || 0;
  const installDue = Number(user.install_fee_due) || 0;
  const boostUntil = parse(user.boost_until);
  const boostProfile = boostUntil && boostUntil > now && user.boost_profile_id ? profileById.get(user.boost_profile_id) : null;
  return {
    status, billed: price != null,
    price, periodDays: renewProfile ? Number(renewProfile.period_days) || 30 : 30,
    credit, installDue,
    // What renews one period now, after credit.
    amountDue: price == null ? null : Math.max(0, installDue + price - credit),
    paidUntil: iso(paidUntil), accessUntil: iso(accessUntil),
    daysLeft: paidUntil != null && paidUntil > now ? Math.ceil((paidUntil - now) / DAY_MS) : 0,
    cutOff: accessUntil != null && now >= accessUntil,
    profile: planView(profile), nextProfile: billedProfile(next) ? planView(next) : null,
    boost: boostProfile ? { profile: planView(boostProfile), until: iso(boostUntil) } : null,
  };
}
function planView(profile) {
  if (!profile) return null;
  return {
    id: profile.id, name: profile.name, downloadRate: profile.download_rate, uploadRate: profile.upload_rate,
    price: profile.price == null ? null : Number(profile.price), periodDays: Number(profile.period_days) || 30,
    boostPrice: profile.boost_price == null ? null : Number(profile.boost_price), selfService: Boolean(profile.self_service),
  };
}

/* ------------------------------------------------------------------ */
/* Router jobs                                                         */
/* ------------------------------------------------------------------ */

function queueJob(user, { reconnect = false } = {}) {
  if (!user.location_id) return null;
  try { return pppoe.jobFor({ businessId: user.business_id, userId: user.id, action: 'upsert', reconnect }); }
  catch (error) { console.warn(`[pppoe billing] could not queue router job for ${user.id}: ${error.message}`); return null; }
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

const paymentByCheckout = db.prepare('SELECT * FROM pppoe_payments WHERE checkout_request_id=?');
const paymentByReceipt = db.prepare('SELECT * FROM pppoe_payments WHERE business_id=? AND receipt=?');
const insertPayment = db.prepare(`INSERT INTO pppoe_payments
  (business_id, user_id, username, kind, method, amount, receipt, checkout_request_id, payer_phone, to_install, days_added,
   credit_before, credit_after, paid_until_before, paid_until_after, profile_before, profile_after, boost_until_before, held, note, recorded_by)
  VALUES (@businessId, @userId, @username, @kind, @method, @amount, @receipt, @checkoutRequestId, @payerPhone, @toInstall, @daysAdded,
   @creditBefore, @creditAfter, @paidUntilBefore, @paidUntilAfter, @profileBefore, @profileAfter, @boostUntilBefore, @held, @note, @recordedBy)
  RETURNING *`);

/**
 * Turn credit into whole periods. Within the paid days or the grace days a
 * renewal continues from paid_until; once access has ended it starts now. A
 * plan change booked for the next renewal takes effect with it.
 */
function convertCredit(state, { now, graceMs }) {
  let { credit, paidUntil, profileId, nextProfileId } = state;
  let days = 0;
  for (let i = 0; i < 24; i++) {
    const next = nextProfileId ? profileById.get(nextProfileId) : null;
    const renew = billedProfile(next) ? next : profileById.get(profileId);
    if (!billedProfile(renew) || credit < Number(renew.price)) break;
    const withinAccess = paidUntil != null && paidUntil + graceMs > now;
    const base = withinAccess ? paidUntil : now;
    const period = Math.max(1, Number(renew.period_days) || 30);
    profileId = renew.id; nextProfileId = null;
    paidUntil = base + period * DAY_MS;
    credit -= Number(renew.price);
    days += period;
  }
  return { credit, paidUntil, profileId, nextProfileId, days };
}

/**
 * Apply money (or a free extension) to a subscriber. Idempotent by
 * checkout id and by M-Pesa receipt.
 *   purpose: pay | upgrade | boost | extension
 *   method:  mpesa | paybill | cash | mpesa_owner | bank | credit | owner
 */
function applyPayment({ userId, amount, method, purpose = 'pay', targetProfileId = null, fromCredit = 0, expected = null,
  receipt = null, checkoutRequestId = null, payerPhone = null, recordedBy = null, note = null, extensionDays = 0, now = Date.now() }) {
  return savepoint(() => {
    if (checkoutRequestId) {
      const done = paymentByCheckout.get(checkoutRequestId);
      if (done) return { payment: done, duplicate: true, user: userById.get(done.user_id) };
    }
    const user = userById.get(String(userId || ''));
    if (!user) throw fail('PPPoE subscriber was not found.', 404);
    const cleanReceipt = receipt ? String(receipt).trim().toUpperCase().slice(0, 40) : null;
    if (cleanReceipt) {
      const dup = paymentByReceipt.get(user.business_id, cleanReceipt);
      if (dup) {
        if (checkoutRequestId) return { payment: dup, duplicate: true, user };
        throw fail(`Receipt ${cleanReceipt} is already recorded (${kes(dup.amount)} for ${dup.username}).`, 409);
      }
    }
    const paid = Math.max(0, Math.round(Number(amount) || 0));
    const settings = settingsFor(user.business_id);
    // An owner-set expiry from before billing (no paid_until yet) is a hard
    // cut-off with no grace; once billed, access runs paid_until + grace.
    const graceMs = user.paid_until ? settings.graceDays * DAY_MS : 0;
    const newGraceMs = settings.graceDays * DAY_MS;
    const business = businessById.get(user.business_id);
    const serve = ownerCanServe(business);
    const before = { credit: Number(user.credit) || 0, install: Number(user.install_fee_due) || 0,
      paidUntil: paidUntilOf(user), profileId: user.profile_id, nextProfileId: user.next_profile_id || null };
    const wasCutOff = user.status === 'expired' || (before.paidUntil != null && before.paidUntil + graceMs <= now);
    let credit = before.credit; let install = before.install; let paidUntil = before.paidUntil;
    let profileId = before.profileId; let nextProfileId = before.nextProfileId;
    let boostProfileId = user.boost_profile_id || null; let boostUntil = parse(user.boost_until);
    let days = 0; let toInstall = 0; let kind = purpose; let reconnect = false;
    const target = targetProfileId ? profileById.get(targetProfileId) : null;
    if (target && target.business_id !== user.business_id) throw fail('That plan was not found.', 404);

    if (purpose === 'extension') {
      const add = Math.round(Number(extensionDays) || 0);
      if (add < 1 || add > 366) throw fail('Add between 1 and 366 days.');
      const base = paidUntil != null && paidUntil + graceMs > now ? paidUntil : now;
      paidUntil = base + add * DAY_MS; days = add;
    } else if (purpose === 'upgrade' && serve && target && paid >= Math.max(0, Number(expected) || 0) && credit + paid - Number(expected || 0) >= fromCredit) {
      // The difference for the days left is paid (from credit first, if asked);
      // anything over it is kept as credit.
      credit = credit + paid - Number(expected || 0) - fromCredit;
      profileId = target.id; nextProfileId = null; reconnect = true;
    } else if (purpose === 'boost' && serve && target && target.boost_price != null && paid >= Number(target.boost_price)) {
      credit += paid - Number(target.boost_price);
      const from = boostProfileId === target.id && boostUntil && boostUntil > now ? boostUntil : now;
      boostProfileId = target.id; boostUntil = from + BOOST_HOURS * 3600_000; reconnect = true;
    } else {
      // A renewal, or a short upgrade / boost payment: it counts as credit.
      kind = 'pay';
      toInstall = Math.min(install, paid); install -= toInstall;
      credit += paid - toInstall;
      if (serve && install === 0) {
        const converted = convertCredit({ credit, paidUntil, profileId, nextProfileId }, { now, graceMs });
        ({ credit, paidUntil, profileId, nextProfileId } = converted);
        days = converted.days;
      }
    }
    const profileChanged = profileId !== before.profileId;
    const expiresAt = paidUntil == null ? null : paidUntil + newGraceMs;
    let status = user.status;
    if (status !== 'disabled' && expiresAt != null && expiresAt > now && (days > 0 || status === 'awaiting_payment' || status === 'expired' || purpose !== 'pay')) status = 'active';
    db.prepare(`UPDATE pppoe_users SET credit=?, install_fee_due=?, paid_until=?, expires_at=?, profile_id=?, next_profile_id=?,
        boost_profile_id=?, boost_until=?, status=?, updated_at=datetime('now') WHERE id=?`)
      .run(credit, install, iso(paidUntil), iso(expiresAt), profileId, nextProfileId, boostProfileId, iso(boostUntil), status, user.id);
    const held = !serve && paid > 0 && purpose !== 'extension';
    const payment = insertPayment.get({
      businessId: user.business_id, userId: user.id, username: user.username, kind, method: String(method || 'cash'), amount: paid,
      receipt: cleanReceipt, checkoutRequestId: checkoutRequestId || null, payerPhone: payerPhone || null, toInstall, daysAdded: days,
      creditBefore: before.credit, creditAfter: credit, paidUntilBefore: iso(before.paidUntil), paidUntilAfter: iso(paidUntil),
      profileBefore: before.profileId, profileAfter: profileId, boostUntilBefore: user.boost_until || null,
      held: bool(held), note: note ? String(note).slice(0, 200) : null, recordedBy: recordedBy || null,
    });
    const fresh = userById.get(user.id);
    if (status === 'active' && (days > 0 || reconnect || profileChanged || wasCutOff)) {
      queueJob(fresh, { reconnect: reconnect || profileChanged || wasCutOff });
    }
    return { payment, user: fresh, held, days };
  });
}

/** Undo a payment that M-Pesa reversed. Days and credit it added are taken back. */
function reversePayment(payment, { now = Date.now() } = {}) {
  if (!payment || payment.reversed_at) return null;
  return savepoint(() => {
    const user = userById.get(payment.user_id);
    if (!user) return null;
    const settings = settingsFor(user.business_id);
    let paidUntil = paidUntilOf(user);
    if (paidUntil != null && payment.days_added) paidUntil -= payment.days_added * DAY_MS;
    const credit = Math.max(0, (Number(user.credit) || 0) - (payment.credit_after - payment.credit_before));
    const install = (Number(user.install_fee_due) || 0) + payment.to_install;
    let profileId = user.profile_id;
    let boostProfileId = user.boost_profile_id; let boostUntil = user.boost_until;
    if (payment.kind === 'upgrade' && user.profile_id === payment.profile_after) profileId = payment.profile_before;
    if (payment.kind === 'boost') { boostUntil = payment.boost_until_before; if (!boostUntil) boostProfileId = null; }
    const expiresAt = paidUntil == null ? null : paidUntil + settings.graceDays * DAY_MS;
    const cutOff = expiresAt != null && expiresAt <= now;
    const status = user.status === 'active' && cutOff ? 'expired' : user.status;
    db.prepare(`UPDATE pppoe_users SET credit=?, install_fee_due=?, paid_until=?, expires_at=?, profile_id=?, boost_profile_id=?, boost_until=?,
        status=?, updated_at=datetime('now') WHERE id=?`)
      .run(credit, install, iso(paidUntil), iso(expiresAt), profileId, boostProfileId, boostUntil, status, user.id);
    db.prepare(`UPDATE pppoe_payments SET reversed_at=datetime('now') WHERE id=?`).run(payment.id);
    const fresh = userById.get(user.id);
    if (fresh.location_id) {
      try { pppoe.jobFor({ businessId: fresh.business_id, userId: fresh.id, action: cutOff ? 'revoke' : 'upsert', reconnect: !cutOff }); }
      catch (_) { /* location gone */ }
    }
    return fresh;
  });
}
function reverseByReceipt(businessId, receipt) {
  const payment = paymentByReceipt.get(businessId, String(receipt || '').trim().toUpperCase());
  return payment ? reversePayment(payment) : null;
}

/* ------------------------------------------------------------------ */
/* Plan changes and boosts                                             */
/* ------------------------------------------------------------------ */

/**
 * What changing plan costs. A faster plan can start now: the customer pays
 * the difference in daily price for the days left (credit first if asked).
 * A cheaper plan, or any plan "at renewal", starts at the next renewal, so
 * paid days are never refunded.
 */
function changeQuote(user, targetProfileId, { timing = 'now', useCredit = true, now = Date.now() } = {}) {
  const current = profileById.get(user.profile_id);
  const target = profileById.get(String(targetProfileId || ''));
  if (!target || target.business_id !== user.business_id || !target.active || !billedProfile(target)) throw fail('That plan is not available.', 404);
  if (target.id === user.profile_id) throw fail('You are already on this plan.', 409);
  const state = accountState(user, { now });
  const faster = !billedProfile(current) || perDay(target) > perDay(current);
  const credit = state.credit;
  if (timing === 'now') {
    if (!faster) throw fail('A cheaper plan starts at your next renewal.', 409);
    if (!['paid', 'due'].includes(state.status)) throw fail('Renew first, then change plan.', 409);
    const daysLeft = state.daysLeft;
    const diff = billedProfile(current) ? Math.max(0, Math.round((perDay(target) - perDay(current)) * daysLeft)) : 0;
    const fromCredit = useCredit ? Math.min(credit, diff) : 0;
    const payNow = diff - fromCredit;
    const creditAfter = credit - fromCredit;
    return { timing: 'now', target: planView(target), faster, daysLeft, difference: diff, fromCredit, payNow,
      renewal: { at: state.paidUntil, amount: Math.max(0, Number(target.price) - creditAfter) } };
  }
  return { timing: 'renewal', target: planView(target), faster, payNow: 0,
    renewal: { at: state.paidUntil, amount: Math.max(0, Number(target.price) + state.installDue - credit) } };
}
function scheduleChange(user, targetProfileId) {
  if (targetProfileId === null) {
    db.prepare(`UPDATE pppoe_users SET next_profile_id=NULL, updated_at=datetime('now') WHERE id=?`).run(user.id);
    return userById.get(user.id);
  }
  const target = profileById.get(String(targetProfileId || ''));
  if (!target || target.business_id !== user.business_id || !target.active || !billedProfile(target)) throw fail('That plan is not available.', 404);
  db.prepare(`UPDATE pppoe_users SET next_profile_id=?, updated_at=datetime('now') WHERE id=?`)
    .run(target.id === user.profile_id ? null : target.id, user.id);
  return userById.get(user.id);
}
/** Plans a boost can run on: faster than the subscriber's, with a boost price. */
function boostOptions(user) {
  const current = profileById.get(user.profile_id);
  return db.prepare(`SELECT * FROM pppoe_profiles WHERE business_id=? AND active=1 AND boost_price IS NOT NULL AND boost_price > 0 AND id != ?`)
    .all(user.business_id, user.profile_id)
    .filter((p) => !billedProfile(current) || !billedProfile(p) || perDay(p) > perDay(current))
    .map(planView);
}
function boostQuote(user, targetProfileId, { now = Date.now() } = {}) {
  const target = boostOptions(user).find((p) => p.id === String(targetProfileId || ''));
  if (!target) throw fail('That boost is not available.', 404);
  const state = accountState(user, { now });
  if (!['paid', 'due', 'no_expiry'].includes(state.status)) throw fail('Renew first, then boost your speed.', 409);
  return { target, amount: target.boostPrice, hours: BOOST_HOURS };
}
/** Boost ends: put the subscriber back on their own plan. */
function endBoosts(now = Date.now()) {
  const due = db.prepare(`SELECT * FROM pppoe_users WHERE boost_profile_id IS NOT NULL AND boost_until IS NOT NULL`).all()
    .filter((u) => (parse(u.boost_until) || 0) <= now);
  for (const user of due) {
    db.prepare(`UPDATE pppoe_users SET boost_profile_id=NULL, boost_until=NULL, updated_at=datetime('now') WHERE id=?`).run(user.id);
    if (user.status === 'active') queueJob(userById.get(user.id), { reconnect: true });
  }
  return due.length;
}

/* ------------------------------------------------------------------ */
/* Owner-side edits                                                    */
/* ------------------------------------------------------------------ */

/** Price, period and boost price of a speed plan (owner). */
function updatePlan(businessId, profileId, patch = {}) {
  const profile = profileById.get(String(profileId || ''));
  if (!profile || profile.business_id !== businessId) throw fail('PPPoE profile was not found.', 404);
  const price = patch.price === undefined ? profile.price : money(patch.price, 'The price', { min: 1, allowNull: true });
  const periodRaw = patch.periodDays === undefined ? profile.period_days : Number(patch.periodDays);
  if (!Number.isInteger(periodRaw) || periodRaw < 1 || periodRaw > 366) throw fail('The period must be from 1 to 366 days.');
  const boostPrice = patch.boostPrice === undefined ? profile.boost_price : money(patch.boostPrice, 'The boost price', { min: 1, allowNull: true });
  const selfService = patch.selfService === undefined ? profile.self_service : bool(patch.selfService);
  let downloadRate = profile.download_rate; let uploadRate = profile.upload_rate;
  const rate = /^\d{1,5}(\.\d{1,2})?[kKmMgG]?$/;
  if (patch.downloadRate !== undefined || patch.uploadRate !== undefined) {
    downloadRate = String(patch.downloadRate ?? downloadRate).trim(); uploadRate = String(patch.uploadRate ?? uploadRate).trim();
    if (!rate.test(downloadRate) || !rate.test(uploadRate)) throw fail('Speeds look like 10M or 512k.');
  }
  const name = patch.name === undefined ? profile.name : String(patch.name || '').trim();
  if (!name || name.length > 80) throw fail('PPPoE profile name is required.');
  db.prepare(`UPDATE pppoe_profiles SET name=?, price=?, period_days=?, boost_price=?, self_service=?, download_rate=?, upload_rate=?,
      updated_at=datetime('now') WHERE id=?`).run(name, price, periodRaw, boostPrice, selfService, downloadRate, uploadRate, profile.id);
  // New speeds reach everyone on (or boosted to) this plan at once.
  if (downloadRate !== profile.download_rate || uploadRate !== profile.upload_rate) {
    const users = db.prepare(`SELECT * FROM pppoe_users WHERE (profile_id=? OR boost_profile_id=?) AND status='active' AND location_id IS NOT NULL`).all(profile.id, profile.id);
    for (const user of users) queueJob(user, { reconnect: true });
  }
  return planView(profileById.get(profile.id));
}

/** Phone, name, plan and installation fee of a subscriber (owner). */
function updateSubscriber(businessId, userId, patch = {}) {
  const user = userFor(businessId, userId);
  let phone = user.phone;
  if (patch.phone !== undefined) {
    const raw = String(patch.phone || '').trim();
    phone = raw ? mpesa.normalizePhone(raw) : null;
    if (raw && !phone) throw fail('Enter a valid Kenyan phone number, or leave it blank.');
  }
  const fullName = patch.fullName === undefined ? user.full_name : (String(patch.fullName || '').trim().slice(0, 80) || null);
  const install = patch.installFeeDue === undefined ? user.install_fee_due : money(patch.installFeeDue, 'The installation fee');
  let profileId = user.profile_id;
  if (patch.profileId !== undefined && patch.profileId !== user.profile_id) {
    const target = profileById.get(String(patch.profileId || ''));
    if (!target || target.business_id !== businessId || !target.active) throw fail('PPPoE profile was not found.', 404);
    profileId = target.id;
  }
  const next = patch.nextProfileId === undefined ? user.next_profile_id : patch.nextProfileId;
  db.prepare(`UPDATE pppoe_users SET phone=?, full_name=?, install_fee_due=?, profile_id=?, updated_at=datetime('now') WHERE id=?`)
    .run(phone, fullName, install, profileId, user.id);
  let fresh = userById.get(user.id);
  if (next !== user.next_profile_id) fresh = scheduleChange(fresh, next || null);
  if (profileId !== user.profile_id && fresh.status === 'active') queueJob(fresh, { reconnect: true });
  return fresh;
}

/**
 * Billing details for a subscriber the owner has just added: an
 * installation fee, and whether they start unpaid (they pay by link first).
 */
function setupNewSubscriber(user, { phone = null, fullName = null, installFee = 0 } = {}) {
  const cleanPhone = phone ? mpesa.normalizePhone(phone) : null;
  if (phone && !cleanPhone) throw fail('Enter a valid Kenyan phone number, or leave it blank.');
  const install = money(installFee || 0, 'The installation fee');
  const profile = profileById.get(user.profile_id);
  // A priced plan with no "paid until" given waits for its first payment
  // (by pay link, PayBill, or cash the owner records).
  const waits = billedProfile(profile) && !user.expires_at;
  const paidUntil = user.expires_at && billedProfile(profile) ? user.expires_at : null;
  const graceMs = settingsFor(user.business_id).graceDays * DAY_MS;
  db.prepare(`UPDATE pppoe_users SET phone=?, full_name=?, install_fee_due=?, paid_until=?, expires_at=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .run(cleanPhone, fullName ? String(fullName).trim().slice(0, 80) : null, install, paidUntil,
      paidUntil ? iso(parse(paidUntil) + graceMs) : user.expires_at, waits ? 'awaiting_payment' : user.status, user.id);
  return userById.get(user.id);
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

function linkKey() {
  const secret = process.env.TENANT_SECRETS_KEY || '';
  if (!secret) throw fail('Secure PPPoE secret storage is not configured.', 503);
  return crypto.createHash('sha256').update(`pppoe-pay-link:${secret}`).digest();
}
/** The private part of a subscriber's own pay link (in their SMS). */
function accountToken(user) {
  return crypto.createHmac('sha256', linkKey()).update(`${user.business_id}:${user.id}`).digest('base64url').slice(0, 22);
}
function accountTokenOk(user, supplied) {
  const expected = Buffer.from(accountToken(user));
  const actual = Buffer.from(String(supplied || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function appUrl() { return String(config.domains.appUrl || config.publicUrl || '').replace(/\/$/, ''); }
// On the tenant's own portal address when that is on (pppoe-address.js).
function payLink(user, { privateLink = true } = {}) {
  const code = settingsFor(user.business_id).payCode;
  const origin = require('./pppoe-address').payOrigin({ businessId: user.business_id, locationId: user.location_id });
  const base = `${origin}/pay/${code}/${encodeURIComponent(user.username)}`;
  return privateLink ? `${base}?k=${accountToken(user)}` : base;
}
function payPageUrl(businessId) { return `${require('./pppoe-address').payOrigin({ businessId })}/pay/${settingsFor(businessId).payCode}`; }

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function businessView(business) {
  return {
    name: business.portal_name || business.name || 'Home internet',
    supportPhone: business.support_phone ? mpesa.displayPhone(business.support_phone) : null,
    color: business.brand_primary_color || null,
  };
}
const recentPaymentsFor = db.prepare(`SELECT * FROM pppoe_payments WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ?`);
function receiptView(payment) {
  const profileAfter = payment.profile_after && payment.profile_after !== payment.profile_before ? profileById.get(payment.profile_after) : null;
  let what;
  if (payment.reversed_at) what = 'Reversed by M-Pesa';
  else if (payment.kind === 'extension') what = `${payment.days_added} days added by your provider`;
  else if (payment.kind === 'boost') what = `${BOOST_HOURS}-hour speed boost`;
  else if (payment.kind === 'upgrade') what = profileAfter ? `Upgrade to ${profileAfter.name}` : 'Plan upgrade';
  else if (payment.held) what = 'Kept as credit until your provider can reconnect you';
  else if (payment.days_added) what = `${payment.days_added} days, paid until ${dayText(parse(payment.paid_until_after))}`;
  else if (payment.to_install && payment.to_install === payment.amount) what = 'Installation fee';
  else what = 'Kept as credit';
  return {
    at: iso(parse(payment.created_at)), amount: payment.amount, method: payment.method,
    receipt: payment.receipt, what, creditAfter: payment.credit_after, reversed: Boolean(payment.reversed_at),
  };
}
/** What anyone who types the account number sees: no name, phone or receipts. */
function publicAccount(user, { now = Date.now() } = {}) {
  const state = accountState(user, { now });
  return {
    username: user.username, maskedName: maskName(user.full_name) || null,
    plan: state.profile ? { name: state.profile.name, downloadRate: state.profile.downloadRate, uploadRate: state.profile.uploadRate } : null,
    status: state.status, billed: state.billed, paidUntil: state.paidUntil, accessUntil: state.accessUntil,
    price: state.price, periodDays: state.periodDays, amountDue: state.amountDue, installDue: state.installDue > 0 ? state.installDue : 0,
    credit: state.credit,
  };
}
/** The subscriber's own view, from their private link. */
function privateAccount(user, { now = Date.now() } = {}) {
  const state = accountState(user, { now });
  const settings = settingsFor(user.business_id);
  return {
    ...publicAccount(user, { now }),
    name: user.full_name || null, phone: maskPhone(user.phone),
    daysLeft: state.daysLeft, nextPlan: state.nextProfile, boost: state.boost, currentPlan: state.profile,
    plans: settings.selfChangePlan ? pricedPlans(user.business_id).filter((p) => p.self_service).map(planView) : [],
    boosts: settings.boosts ? boostOptions(user) : [],
    receipts: recentPaymentsFor.all(user.id, 30).map(receiptView),
  };
}
/** The owner's list: every subscriber with where they stand. */
function ownerView(user, { now = Date.now(), settings } = {}) {
  const state = accountState(user, { now, settings });
  return {
    phone: user.phone ? mpesa.displayPhone(user.phone) : null, fullName: user.full_name || null,
    billing: { ...state, profile: undefined, nextProfile: state.nextProfile, boost: state.boost },
    payLink: settings && state.billed ? safeLink(user) : null,
  };
}
function safeLink(user) { try { return payLink(user); } catch (_) { return null; } }
function paymentsForOwner(businessId, { userId = null, limit = 100 } = {}) {
  const rows = userId
    ? db.prepare('SELECT * FROM pppoe_payments WHERE business_id=? AND user_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(businessId, userId, limit)
    : db.prepare('SELECT * FROM pppoe_payments WHERE business_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(businessId, limit);
  return rows.map((p) => ({ id: p.id, username: p.username, userId: p.user_id, ...receiptView(p), payerPhone: p.payer_phone ? mpesa.displayPhone(p.payer_phone) : null, recordedBy: p.recorded_by, note: p.note, held: Boolean(p.held), kind: p.kind }));
}

/* ------------------------------------------------------------------ */
/* M-Pesa prompts from the pay page                                    */
/* ------------------------------------------------------------------ */

function statusTokenHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function recordIntent({ checkoutRequestId, user, purpose, targetProfileId = null, amount, fromCredit = 0, payerPhone, notifyHolder = false }) {
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare(`INSERT INTO pppoe_payment_intents (checkout_request_id, business_id, user_id, purpose, target_profile_id, amount, from_credit, payer_phone, notify_holder, status_token_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(checkoutRequestId, user.business_id, user.id, purpose, targetProfileId, amount, fromCredit, payerPhone || null, bool(notifyHolder), statusTokenHash(token));
  return token;
}
const intentFor = db.prepare('SELECT * FROM pppoe_payment_intents WHERE checkout_request_id=?');
function intentTokenOk(intent, token) {
  if (!intent) return false;
  const a = Buffer.from(intent.status_token_hash, 'hex'); const b = Buffer.from(statusTokenHash(token), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** tenant_transactions marks a PPPoE payment with this "device". */
function transactionMac(user) { return `PPPOE:${user.id}`; }
function userIdFromTransaction(transaction) {
  const mac = String(transaction && transaction.mac || '');
  return mac.startsWith('PPPOE:') ? mac.slice(6) : null;
}
/**
 * A paid tenant_transactions row that belongs to a PPPoE subscriber: apply
 * it once. Safe to call again for the same checkout.
 */
function settleTransaction(transaction) {
  const userId = userIdFromTransaction(transaction);
  if (!userId || transaction.status !== 'paid') return null;
  const intent = intentFor.get(transaction.checkout_request_id);
  const source = transaction.payment_source === 'c2b' ? 'paybill' : 'mpesa';
  const result = applyPayment({
    userId, amount: Number(transaction.amount), method: source,
    purpose: intent ? intent.purpose : 'pay', targetProfileId: intent ? intent.target_profile_id : null,
    fromCredit: intent ? intent.from_credit : 0, expected: intent ? intent.amount : null,
    receipt: transaction.mpesa_receipt || null, checkoutRequestId: transaction.checkout_request_id,
    payerPhone: transaction.phone || (intent && intent.payer_phone) || null,
  });
  return { ...result, intent };
}

/* ------------------------------------------------------------------ */
/* SMS: receipts and reminders                                         */
/* ------------------------------------------------------------------ */

function receiptText(business, user, result) {
  const name = businessView(business).name;
  const p = result.payment;
  const state = accountState(result.user);
  const head = `${name}: received ${kes(p.amount)}${p.receipt ? `, M-Pesa ${p.receipt}` : ''} for ${user.username}.`;
  if (p.held) return `${head} It is kept as credit and your internet comes back as soon as ${name} can reconnect you.`;
  if (p.kind === 'boost') return `${head} Your speed is boosted until ${dayText(parse(result.user.boost_until))} ${new Date(parse(result.user.boost_until)).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })}.`;
  if (p.kind === 'upgrade') return `${head} You are now on ${state.profile ? state.profile.name : 'your new plan'}. Your connection restarts once to pick up the new speed.`;
  if (p.days_added) return `${head} Internet paid until ${dayText(parse(result.user.paid_until))}. Credit: ${kes(result.user.credit)}.`;
  if (p.to_install === p.amount) return `${head} Installation fee paid.${state.amountDue ? ` Pay ${kes(state.amountDue)} to start your internet: ${safeLink(result.user) || ''}` : ''}`;
  return `${head} Kept as credit (${kes(result.user.credit)}). Pay ${kes(state.amountDue)} more to add ${state.periodDays} days: ${safeLink(result.user) || ''}`;
}
/**
 * The texts a subscriber should get now, latest stage only, one per paid
 * period: 3 days before, on the day, and once when the paid days end.
 */
function remindersDue(user, { now, settings, business }) {
  const state = accountState(user, { now, settings });
  if (!state.billed || !user.phone || !['due', 'grace', 'expired'].includes(state.status)) return null;
  const paidUntil = parse(state.paidUntil);
  if (paidUntil == null) return null;
  const stamp = nairobiDay(paidUntil);
  const name = businessView(business).name;
  const link = safeLink(user) || '';
  const due = kes(state.amountDue);
  const creditNote = state.credit > 0 ? ` You have ${kes(state.credit)} credit, so ${due} renews it.` : ` ${due} renews it for ${state.periodDays} days.`;
  const dayStart = nairobiDayStart(paidUntil);
  if (now >= paidUntil) {
    if (!settings.remindAfter || now > paidUntil + 7 * DAY_MS) return null;
    const text = state.status === 'grace'
      ? `${name}: your paid internet days have ended. It stays on until ${dayText(parse(state.accessUntil))}. Pay ${due} to keep it: ${link}`
      : `${name}: your internet has ended. Pay ${due} to reconnect straight away: ${link}`;
    return { key: `after:${stamp}`, text };
  }
  if (now >= dayStart + 7 * 3600_000) {
    if (!settings.remindDay) return null;
    return { key: `day:${stamp}`, text: `${name}: your internet (${user.username}) ends today.${creditNote} Pay: ${link}` };
  }
  if (now >= paidUntil - REMIND_BEFORE_DAYS * DAY_MS && settings.remindBefore) {
    return { key: `before:${stamp}`, text: `${name}: hi${user.full_name ? ` ${String(user.full_name).split(/\s+/)[0]}` : ''}, your internet (${user.username}) is paid until ${dayText(paidUntil)}.${creditNote} Pay: ${link} or PayBill with account ${user.username}.` };
  }
  return null;
}

/**
 * Periodic work: end boosts, turn held credit into days once the owner can
 * serve again, and send reminders. `send(businessId, eventId, to, text,
 * serviceKey)` queues one SMS (FitiSignal); without it no texts go out.
 */
async function sweep({ now = Date.now(), send = null } = {}) {
  const counts = { boostsEnded: endBoosts(now), renewedFromCredit: 0, reminders: 0 };
  const users = db.prepare(`SELECT u.* FROM pppoe_users u JOIN pppoe_profiles p ON p.id=u.profile_id
    WHERE p.price IS NOT NULL AND p.price > 0 AND u.status IN ('active','expired','awaiting_payment')`).all();
  const byBusiness = new Map();
  for (const user of users) {
    let ctx = byBusiness.get(user.business_id);
    if (!ctx) {
      const business = businessById.get(user.business_id);
      ctx = { business, settings: settingsFor(user.business_id), serve: ownerCanServe(business) };
      byBusiness.set(user.business_id, ctx);
    }
    if (!ctx.business || !ctx.serve) continue;
    let current = user;
    // Credit that covers a period (e.g. a payment kept while the owner's
    // plan had lapsed) becomes days once it is needed.
    const state = accountState(current, { now, settings: ctx.settings });
    const paidUntil = parse(state.paidUntil);
    const needsDays = state.status === 'awaiting_payment' || paidUntil == null || paidUntil - now <= DAY_MS;
    if (needsDays && state.installDue === 0 && state.price && state.credit >= state.price) {
      const result = applyPayment({ userId: current.id, amount: 0, method: 'credit', purpose: 'pay', note: 'Renewed from credit', now });
      if (result.days) counts.renewedFromCredit += 1;
      current = result.user;
    }
    if (!send) continue;
    const reminder = remindersDue(current, { now, settings: ctx.settings, business: ctx.business });
    if (!reminder) continue;
    const claimed = db.prepare('INSERT OR IGNORE INTO pppoe_reminders (user_id, reminder_key) VALUES (?, ?)').run(current.id, reminder.key);
    if (!claimed.changes) continue;
    let result = 'queued';
    try {
      const queued = await send(current.business_id, `pppoe:${current.id}:${reminder.key}`, `+${current.phone}`, reminder.text, 'expiry_reminder');
      if (queued && queued.skipped) result = `skipped:${queued.reason || 'unknown'}`;
    } catch (error) { result = `error:${String(error.message).slice(0, 80)}`; }
    db.prepare('UPDATE pppoe_reminders SET result=? WHERE user_id=? AND reminder_key=?').run(result, current.id, reminder.key);
    counts.reminders += 1;
  }
  return counts;
}

module.exports = {
  DAY_MS, BOOST_HOURS,
  settingsFor, saveSettings, businessForPayCode, userFor, userByUsername, pricedPlans, planView, ownerCanServe,
  accountState, applyPayment, reversePayment, reverseByReceipt, changeQuote, scheduleChange, boostOptions, boostQuote, endBoosts,
  updatePlan, updateSubscriber, setupNewSubscriber, accountToken, accountTokenOk, payLink, payPageUrl,
  businessView, publicAccount, privateAccount, ownerView, paymentsForOwner, receiptView,
  recordIntent, intentFor, intentTokenOk, transactionMac, userIdFromTransaction, settleTransaction,
  receiptText, remindersDue, sweep, maskName,
};

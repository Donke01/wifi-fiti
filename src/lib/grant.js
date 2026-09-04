const crypto = require('crypto');
const db = require('./db');
const config = require('../config');
const mikrotik = require('./mikrotik');

/** No 0/O/1/I/l - customers read these off a screen and retype them. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * The single place time is granted, whatever paid for it: an STK push, a
 * voucher, or a Paybill transfer. Keeping one path means the top-up maths
 * and the queueing behaviour cannot drift between them.
 *
 * Returns the account's new absolute total. Callers must have already
 * established that the money is real.
 */
async function grantTime({ phone, seconds, profile, mac, ip, reason }) {
  const account = db.getAccount.get(phone);
  const previous = account ? account.total_seconds : 0;
  const alreadyUsed = account ? (account.used_seconds || 0) : 0;

  // `limit-uptime` on the router is measured against a cumulative `uptime`
  // counter that we never reset. So the new total must clear what has
  // already been consumed, or the customer is locked out the instant we
  // push it - they paid, and RouterOS immediately says the limit is spent.
  //
  // This happens whenever our ledger is behind the router: a restored
  // backup, a fresh database, or an account that predates this table.
  // Taking the larger of the two makes the grant self-correcting, and it
  // stays idempotent because the figure is frozen into the job row.
  const fromLedger = previous + seconds;
  const fromRouter = alreadyUsed + seconds;
  const totalSeconds = Math.max(fromLedger, fromRouter);

  if (fromRouter > fromLedger) {
    console.warn(
      `[grant] ledger was behind the router for ${phone} ` +
        `(ledger ${previous}s, used ${alreadyUsed}s) - granting ${totalSeconds}s ` +
        `so the customer actually gets the ${seconds}s they paid for`
    );
  }

  const password = account ? account.password : generateCode(6);

  // Packages are wall-clock subscriptions. A new purchase starts now; a
  // top-up made before expiry extends the existing subscription. Keeping
  // the absolute timestamp in SQLite makes the result independent of page
  // refreshes, router usage reports, disconnects, and server restarts.
  const now = Date.now();
  const oldExpiry = account && account.expires_at
    ? new Date(account.expires_at.replace(' ', 'T') + 'Z').getTime()
    : 0;
  const expiresAtMs = Math.max(now, Number.isFinite(oldExpiry) ? oldExpiry : 0)
    + seconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

  db.upsertAccount.run({ phone, totalSeconds, password });
  db.setExpiry.run({ phone, expiresAt });
  if (seconds > 0) db.addPurchased.run({ phone, seconds });
  if (mac) db.rememberMac.run({ phone, mac });

  if (config.provisionMode === 'poll') {
    db.addJob.run({
      site: config.site.id,
      username: phone,
      password,
      profile,
      totalSeconds,
      mac: mac || null,
      ip: ip || null,
    });
    console.log(
      `[grant] queued ${phone} +${seconds}s total=${totalSeconds}s (${reason})`
    );
    return { username: phone, password, totalSeconds, expiresAt, queued: true };
  }

  await mikrotik.provisionUser({
    username: phone,
    password,
    profile,
    seconds: totalSeconds,
    comment: reason,
    absolute: true,
  });

  try {
    await mikrotik.forceLogin({ username: phone, password, mac, ip });
  } catch (err) {
    console.warn(`[grant] auto-login failed for ${phone}: ${err.message}`);
  }

  console.log(`[grant] ${phone} +${seconds}s total=${totalSeconds}s (${reason})`);
  return { username: phone, password, totalSeconds, expiresAt, queued: false };
}

/**
 * What the portal shows, from any network.
 *
 * The router only reports usage every 10 seconds, and a customer who is
 * online is spending time in between. Reporting the last known figure
 * would show a balance that is quietly wrong - most visibly when someone
 * checks from mobile data while a TV keeps streaming on their account.
 *
 * So for accounts the router says are ONLINE we subtract the time since
 * that report. Offline accounts are left alone: their balance genuinely
 * is not moving, and guessing would only introduce error.
 *
 * The estimate is capped at two minutes of drift. If the router has gone
 * quiet for longer than that we have no idea what happened, and steadily
 * draining someone's balance on a hunch is worse than showing it frozen.
 */
function remainingFor(phone) {
  const a = db.getAccount.get(phone);
  if (!a) return null;

  if (a.expires_at) {
    const expiryMs = new Date(a.expires_at.replace(' ', 'T') + 'Z').getTime();
    const remaining = Number.isFinite(expiryMs)
      ? Math.max(0, Math.ceil((expiryMs - Date.now()) / 1000))
      : 0;
    return {
      phone: a.phone,
      password: a.password,
      totalSeconds: a.total_seconds,
      usedSeconds: a.used_seconds || 0,
      remainingSeconds: remaining,
      expiresAt: Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null,
      online: Boolean(a.is_active),
      estimated: false,
    };
  }

  // Legacy accounts without an expiry retain the old usage-based balance
  // until their next purchase migrates them to wall-clock subscriptions.
  // Hard ceiling: never show more than was actually paid for. When the
  // ledger is behind the router we inflate total_seconds to clear existing
  // usage, and without this cap that inflation would surface as free time.
  const ceiling = a.purchased_seconds || a.total_seconds;
  const banked = Math.min(
    Math.max(0, a.total_seconds - (a.used_seconds || 0)),
    ceiling
  );

  let live = banked;
  let estimated = false;

  if (a.is_active && banked > 0) {
    const row = db.secondsSinceReport.get(phone);
    const age = row && Number.isFinite(row.age) ? Math.max(0, row.age) : 0;
    const drift = Math.min(age, 120);
    if (drift > 0) {
      live = Math.max(0, banked - drift);
      estimated = true;
    }
  }

  return {
    phone: a.phone,
    password: a.password,
    totalSeconds: a.total_seconds,
    usedSeconds: a.used_seconds || 0,
    remainingSeconds: live,
    online: Boolean(a.is_active),
    estimated,
  };
}

module.exports = { grantTime, remainingFor, generateCode };

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

  db.upsertAccount.run({ phone, totalSeconds, password });
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
    return { username: phone, password, totalSeconds, queued: true };
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
  return { username: phone, password, totalSeconds, queued: false };
}

/** What the portal shows a returning customer. */
function remainingFor(phone) {
  const a = db.getAccount.get(phone);
  if (!a) return null;
  const remaining = Math.max(0, a.total_seconds - (a.used_seconds || 0));
  return {
    phone: a.phone,
    password: a.password,
    totalSeconds: a.total_seconds,
    usedSeconds: a.used_seconds || 0,
    remainingSeconds: remaining,
  };
}

module.exports = { grantTime, remainingFor, generateCode };

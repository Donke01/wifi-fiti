const crypto = require('crypto');
const config = require('../config');
const db = require('./db');
const mikrotik = require('./mikrotik');
const { findPackage } = require('../packages');

/** No 0/O/1/I/l - people read these off a screen and retype them. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generatePassword(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * Idempotent. Safe to call from the callback handler, the reconciliation
 * sweep, and a manual retry at the same time - a transaction already marked
 * provisioned short-circuits, and re-running provisionUser would otherwise
 * hand out a second helping of time.
 */
async function fulfil(tx) {
  if (tx.provisioned) {
    return {
      alreadyDone: true,
      username: tx.hotspot_username,
      password: tx.hotspot_password,
    };
  }

  const pkg = findPackage(tx.package_id);
  if (!pkg) throw new Error(`Unknown package on transaction: ${tx.package_id}`);

  const username = tx.phone; // 2547XXXXXXXX - stable identity across top-ups
  const password = tx.hotspot_password || generatePassword();

  // Poll mode: the server owns the ledger and queues work for whichever
  // router serves this site. We never reach into the router, so there is
  // nothing to expose and nothing to time out.
  if (config.provisionMode === 'poll') {
    const account = db.getAccount.get(username);
    const previous = account ? account.total_seconds : 0;
    const totalSeconds = previous + tx.seconds;
    const pass = account ? account.password : password;

    db.upsertAccount.run({ phone: username, totalSeconds, password: pass });

    db.addJob.run({
      site: config.site.id,
      username,
      password: pass,
      profile: pkg.profile,
      totalSeconds,
      mac: tx.mac || null,
      ip: tx.ip || null,
    });

    db.markProvisioned.run({
      checkoutRequestId: tx.checkout_request_id,
      username,
      password: pass,
    });

    console.log(
      `[fulfil] queued ${username} +${tx.seconds}s (${pkg.id}) ` +
        `total=${totalSeconds}s site=${config.site.id}`
    );

    return { alreadyDone: false, username, password: pass, queued: true };
  }

  // No router yet: complete the payment flow anyway so the M-Pesa side can
  // be tested on its own. The transaction is real and recorded; only the
  // provisioning is skipped.
  if (!config.mikrotik.configured) {
    db.markProvisioned.run({
      checkoutRequestId: tx.checkout_request_id,
      username,
      password,
    });
    console.log(
      '[fulfil] DRY RUN (no router configured) - would grant ' +
        username + ' +' + tx.seconds + 's (' + pkg.id + '). ' +
        'Credentials: ' + username + ' / ' + password
    );
    return { alreadyDone: false, username, password, loggedIn: false, dryRun: true };
  }

  const result = await mikrotik.provisionUser({
    username,
    password,
    profile: pkg.profile,
    seconds: tx.seconds,
    comment: `${pkg.id} ${tx.mpesa_receipt || tx.checkout_request_id}`,
  });

  // Record before attempting login: if the login call throws, the customer
  // has still been credited and must not be charged twice.
  db.markProvisioned.run({
    checkoutRequestId: tx.checkout_request_id,
    username,
    password,
  });

  let loggedIn = false;
  try {
    loggedIn = await mikrotik.forceLogin({
      username,
      password,
      mac: tx.mac,
      ip: tx.ip,
    });
  } catch (err) {
    console.warn(
      `[fulfil] auto-login failed for ${username}, credentials still valid:`,
      err.message
    );
  }

  console.log(
    `[fulfil] ${username} +${tx.seconds}s (${pkg.id}) ` +
      `total=${result.totalSeconds}s receipt=${tx.mpesa_receipt} login=${loggedIn}`
  );

  return { alreadyDone: false, username, password, loggedIn };
}

module.exports = { fulfil, generatePassword };

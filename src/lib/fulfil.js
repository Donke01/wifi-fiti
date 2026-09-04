const crypto = require('crypto');
const config = require('../config');
const db = require('./db');
const mikrotik = require('./mikrotik');
const { grantTime } = require('./grant');
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

  // The payer is not the subscription identity: one M-Pesa number may buy
  // separate packages for several phones. Reuse the account already bound
  // to this MAC; otherwise preserve the payer's original account for their
  // first device and give each additional device a stable derived username.
  let username = tx.phone;
  if (tx.mac) {
    const bound = db.accountByMac.get(tx.mac);
    if (bound && (bound.payer_phone || bound.phone) === tx.phone) {
      username = bound.phone;
    } else {
      const payerAccounts = db.accountsForPayer.all(tx.phone);
      const unbound = payerAccounts.find((a) => !a.last_mac);
      if (unbound) username = unbound.phone;
      else if (payerAccounts.length) {
        const tag = crypto.createHash('sha256').update(tx.mac).digest('hex').slice(0, 8).toUpperCase();
        username = `${tx.phone}-${tag}`;
      }
    }
  }
  const password = tx.hotspot_password || generatePassword();

  // Poll mode: the server owns the ledger and queues work for whichever
  // router serves this site. We never reach into the router, so there is
  // nothing to expose and nothing to time out.
  // Delegate to the one implementation of the top-up maths. This used to
  // be a second copy living here, which drifted: the guard that stops a
  // grant falling below the router's recorded usage was added to grant.js
  // only, so vouchers and devices got it and actual payments did not.
  if (config.provisionMode === 'poll') {
    const result = await grantTime({
      phone: username,
      payerPhone: tx.phone,
      seconds: tx.seconds,
      profile: pkg.profile,
      mac: tx.mac || null,
      ip: tx.ip || null,
      autoLogin: tx.auto_login !== 0,
      reason: `${pkg.id} ${tx.mpesa_receipt || tx.checkout_request_id}`,
    });

    db.markProvisioned.run({
      checkoutRequestId: tx.checkout_request_id,
      username,
      password: result.password,
    });

    return { alreadyDone: false, username, password: result.password, queued: true };
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

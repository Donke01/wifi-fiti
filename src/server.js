const path = require('path');
const express = require('express');

const config = require('./config');
const db = require('./lib/db');
const mpesa = require('./lib/mpesa');
const mikrotik = require('./lib/mikrotik');
const { fulfil } = require('./lib/fulfil');
const { PACKAGES, findPackage } = require('./packages');

const app = express();
app.set('trust proxy', 1);
// The router's usage report must be parsed as raw text, and this has to
// be registered BEFORE the JSON/urlencoded parsers below. RouterOS sends
// it as application/x-www-form-urlencoded, so urlencoded() would claim it
// first, hand back a null-prototype object, and mark the body as handled -
// after which String(req.body) throws "Cannot convert object to primitive
// value" and every sync 500s.
app.use('/api/router/sync', express.text({ type: '*/*', limit: '64kb' }));

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ------------------------------------------------------------------ */
/* Throttle                                                            */
/* ------------------------------------------------------------------ */

/**
 * Safaricom will not process two STK prompts for the same phone at once,
 * and hammering the endpoint gets your app flagged. In-memory is fine -
 * a restart clearing the window is harmless.
 */
const lastPush = new Map();
const PUSH_COOLDOWN_MS = 30_000;

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, t] of lastPush) if (t < cutoff) lastPush.delete(k);
}, 60_000).unref();

/* ------------------------------------------------------------------ */
/* Client identity                                                     */
/* ------------------------------------------------------------------ */

/**
 * Only ever trust the MAC and IP that RouterOS itself put in the redirect
 * URL. Express's req.ip is useless here: the client sits behind the
 * hotspot's NAT, so req.ip is the router's own WAN address, and on a
 * dual-stack listener it arrives IPv6-mapped ("::ffff:192.168.0.132"),
 * which RouterOS rejects outright. Sending it produced a confusing
 * "invalid value for argument ip" on every login attempt.
 *
 * No identity is better than a wrong one - the customer still gets
 * working credentials, they just type them once.
 */
function cleanMac(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m) ? m : null;
}

function cleanIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  return ip.split('.').every((o) => Number(o) <= 255) ? ip : null;
}

/* ------------------------------------------------------------------ */
/* Portal API                                                          */
/* ------------------------------------------------------------------ */

app.get('/api/config', (req, res) => {
  res.json({
    brandName: config.brandName,
    supportPhone: config.supportPhone,
    shortcode: config.mpesa.shortcode,
    packages: PACKAGES.map(({ id, name, detail, price }) => ({
      id,
      name,
      detail,
      price,
    })),
  });
});

app.post('/api/pay', async (req, res) => {
  const { packageId, phone: rawPhone, mac, ip } = req.body || {};

  const pkg = findPackage(packageId);
  if (!pkg) {
    return res.status(400).json({ error: 'Pick a package to continue.' });
  }

  const phone = mpesa.normalizePhone(rawPhone);
  if (!phone) {
    return res.status(400).json({
      error: 'That number does not look right. Use the format 07XX XXX XXX.',
    });
  }

  const since = lastPush.get(phone);
  if (since && Date.now() - since < PUSH_COOLDOWN_MS) {
    const wait = Math.ceil((PUSH_COOLDOWN_MS - (Date.now() - since)) / 1000);
    return res.status(429).json({
      error: `A payment request is already on its way to that phone. Wait ${wait}s before trying again.`,
    });
  }

  try {
    lastPush.set(phone, Date.now());

    const { checkoutRequestId, merchantRequestId } = await mpesa.stkPush({
      phone,
      amount: pkg.price,
      accountReference: pkg.id.toUpperCase(),
      description: pkg.name,
    });

    db.insert.run({
      checkoutRequestId,
      merchantRequestId,
      phone,
      packageId: pkg.id,
      amount: pkg.price,
      seconds: pkg.seconds,
      mac: cleanMac(mac),
      ip: cleanIp(ip),
    });

    console.log(
      `[pay] ${phone} ${pkg.id} KES${pkg.price} -> ${checkoutRequestId}`
    );

    res.json({
      checkoutRequestId,
      phoneDisplay: mpesa.displayPhone(phone),
      amount: pkg.price,
    });
  } catch (err) {
    lastPush.delete(phone);
    console.error('[pay] STK push failed:', err.message, err.daraja || '');
    res.status(502).json({
      error:
        'Could not reach M-Pesa just now. Wait a moment and try again.',
    });
  }
});

app.get('/api/status/:checkoutRequestId', (req, res) => {
  const tx = db.get.get(req.params.checkoutRequestId);
  if (!tx) return res.status(404).json({ error: 'Unknown request.' });

  const payload = { status: tx.status };

  if (tx.status === 'paid' && tx.provisioned) {
    payload.username = tx.hotspot_username;
    payload.password = tx.hotspot_password;
    payload.receipt = tx.mpesa_receipt;
    const info = remainingFor(tx.hotspot_username);
    if (info) payload.remainingSeconds = info.remainingSeconds;
  } else if (tx.status === 'paid') {
    // Paid but the router did not take it yet. Keep the client waiting
    // rather than showing a success screen that has no internet behind it.
    payload.status = 'pending';
  } else if (tx.status === 'failed') {
    payload.reason = friendlyFailure(tx.result_code, tx.result_desc);
  }

  res.json(payload);
});

function friendlyFailure(code, desc) {
  switch (Number(code)) {
    case 1032:
      return 'You cancelled the payment request.';
    case 1037:
      return 'Your phone did not respond in time. Make sure it is unlocked and on the network, then try again.';
    case 1:
      return 'Not enough money in your M-Pesa. Top up and try again.';
    case 2001:
      return 'Wrong M-Pesa PIN. Try again.';
    default:
      return desc || 'The payment did not go through. Try again.';
  }
}

/* ------------------------------------------------------------------ */
/* Daraja callback                                                     */
/* ------------------------------------------------------------------ */

app.post('/api/mpesa/callback', (req, res) => {
  // Safaricom times the webhook out at 30s and does not retry on failure.
  // Acknowledge first, work afterwards - always.
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  setImmediate(() => handleCallback(req.body).catch((err) =>
    console.error('[callback] handler threw:', err)
  ));
});

async function handleCallback(body) {
  const cb = mpesa.parseCallback(body);
  if (!cb) {
    console.warn('[callback] unrecognised payload:', JSON.stringify(body));
    return;
  }

  const tx = db.get.get(cb.checkoutRequestId);
  if (!tx) {
    console.warn(`[callback] no transaction for ${cb.checkoutRequestId}`);
    return;
  }

  if (tx.status !== 'pending') {
    console.log(`[callback] ${cb.checkoutRequestId} already ${tx.status}, ignoring replay`);
    return;
  }

  if (cb.resultCode !== 0) {
    db.markResult.run({
      checkoutRequestId: cb.checkoutRequestId,
      status: 'failed',
      resultCode: cb.resultCode,
      resultDesc: cb.resultDesc,
      receipt: null,
    });
    console.log(`[callback] ${cb.checkoutRequestId} failed: ${cb.resultDesc}`);
    return;
  }

  if (db.isDuplicateReceipt(cb.receipt, cb.checkoutRequestId)) {
    console.error(`[callback] receipt ${cb.receipt} already banked elsewhere - not crediting again`);
    return;
  }

  db.markResult.run({
    checkoutRequestId: cb.checkoutRequestId,
    status: 'paid',
    resultCode: 0,
    resultDesc: cb.resultDesc,
    receipt: cb.receipt,
  });

  await fulfil(db.get.get(cb.checkoutRequestId));
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Two things go wrong in production and both strand a paying customer:
 * the callback never arrives, or it arrives while the router is unreachable.
 * This sweep covers both. It is not optional.
 */
/**
 * How long to wait before asking Daraja directly about a payment we have
 * not had a callback for.
 *
 * The Daraja SANDBOX frequently never sends the callback at all, so in
 * testing this sweep does all the work and its interval IS the customer's
 * wait. 15s is comfortably longer than a prompt takes to answer, so we
 * are not querying transactions that are still legitimately in flight,
 * but short enough that nobody is left staring at a spinner.
 */
const STALE_AFTER_SECONDS = 15;
const RECONCILE_EVERY_MS = 8_000;

async function reconcile() {
  for (const tx of db.stalePending.all(STALE_AFTER_SECONDS)) {
    try {
      const q = await mpesa.stkQuery(tx.checkout_request_id);
      if (!q.settled) continue;

      if (q.resultCode === 0) {
        db.markResult.run({
          checkoutRequestId: tx.checkout_request_id,
          status: 'paid',
          resultCode: 0,
          resultDesc: q.resultDesc,
          receipt: null, // query does not return the receipt number
        });
        console.log(`[reconcile] recovered lost callback for ${tx.checkout_request_id}`);
        await fulfil(db.get.get(tx.checkout_request_id));
      } else {
        db.markResult.run({
          checkoutRequestId: tx.checkout_request_id,
          status: 'failed',
          resultCode: q.resultCode,
          resultDesc: q.resultDesc,
          receipt: null,
        });
      }
    } catch (err) {
      console.warn(`[reconcile] query failed for ${tx.checkout_request_id}:`, err.message);
    }
  }

  db.purgeOldJobs.run();

  for (const tx of db.paidUnprovisioned.all()) {
    try {
      await fulfil(tx);
      console.log(`[reconcile] provisioned backlog for ${tx.phone}`);
    } catch (err) {
      console.warn(`[reconcile] provisioning still failing for ${tx.phone}:`, err.message);
    }
  }
}

setInterval(() => reconcile().catch((e) => console.error('[reconcile]', e)), RECONCILE_EVERY_MS).unref();

/* ------------------------------------------------------------------ */
/* Session: what does this customer already have?                      */
/* ------------------------------------------------------------------ */

const { grantTime, remainingFor, generateCode } = require('./lib/grant');
const { findPackage: pkgById, PACKAGES: ALL_PACKAGES } = require('./packages');

/**
 * Looked up by device MAC on page load. A customer who already has time
 * must never be shown a payment screen - that is how people end up paying
 * twice for internet they already own.
 */
app.get('/api/session', (req, res) => {
  const mac = cleanMac(req.query.mac);
  if (!mac) return res.json({ found: false });

  const account = db.accountByMac.get(mac);
  if (!account) return res.json({ found: false });

  const info = remainingFor(account.phone);
  if (!info || info.remainingSeconds <= 0) return res.json({ found: false });

  res.json({
    found: true,
    phone: info.phone,
    phoneDisplay: mpesa.displayPhone(info.phone),
    username: info.phone,
    password: info.password,
    remainingSeconds: info.remainingSeconds,
    totalSeconds: info.totalSeconds,
    online: info.online,
  });
});

/** Same question, asked by typing a number instead of being recognised. */
app.post('/api/session/lookup', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Weka namba sahihi, kama 0712 345 678.' });
  }

  const info = remainingFor(phone);
  if (!info || info.remainingSeconds <= 0) {
    return res.json({ found: false });
  }

  res.json({
    found: true,
    phoneDisplay: mpesa.displayPhone(info.phone),
    username: info.phone,
    password: info.password,
    remainingSeconds: info.remainingSeconds,
    online: info.online,
  });
});

/* ------------------------------------------------------------------ */
/* Connect a TV or other device to an existing account                 */
/* ------------------------------------------------------------------ */

// A TV can't open a captive portal, so its owner registers its MAC here
// from a phone. The device then rides on the owner's balance. Capped so
// one purchase can't quietly put a whole building online.
const MAX_DEVICES_PER_ACCOUNT = 1; // paying phone + 1 added device = 2 total

app.post('/api/device/add', async (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Enter the phone number you paid with.' });
  }

  // The MAC people read off a TV uses hyphens or nothing; accept both.
  const rawMac = String((req.body && req.body.mac) || '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');
  if (rawMac.length !== 12) {
    return res.status(400).json({
      error: 'That MAC address is not complete. It should be 12 characters.',
    });
  }
  const mac = rawMac.match(/.{2}/g).join(':');

  const label = String((req.body && req.body.label) || 'TV')
    .replace(/[^\w \-]/g, '')
    .slice(0, 24) || 'TV';

  const info = remainingFor(phone);
  if (!info || info.remainingSeconds <= 0) {
    return res.status(402).json({
      error: 'This number has no active time. Buy a package first, then add your TV.',
    });
  }

  // If the device already belongs to someone else, refuse rather than
  // silently move it - that would let a balance be hijacked.
  const existing = db.getDevice.get(mac);
  if (existing && existing.phone !== phone) {
    return res.status(409).json({
      error: 'That device is already connected to another number.',
    });
  }

  if (!existing && db.countDevices.get(phone).n >= MAX_DEVICES_PER_ACCOUNT) {
    // Name what's occupying the slot. "You've hit the limit" leaves the
    // customer guessing which device to remove.
    const owned = db.devicesFor.all(phone)
      .map((d) => d.label || 'a device').join(', ');
    return res.status(409).json({
      error:
        'Each subscription covers 2 devices — your phone and one more. ' +
        `You have already added ${owned}. Remove it below to connect something else.`,
      atLimit: true,
    });
  }

  db.addDevice.run({ mac, phone, label });

  // Queue a login for the TV's MAC under the owner's credentials. In poll
  // mode the router picks this up within its interval; the TV needs no
  // portal and no typing.
  const pkg = pkgById('standard') || { profile: 'standard' };
  await grantTime({
    phone,
    seconds: 0, // no time added - the device shares the owner's balance
    profile: 'standard',
    mac,
    ip: null,
    reason: `device ${label}`,
  });

  console.log(`[device] ${mac} (${label}) attached to ${phone}`);

  res.json({
    ok: true,
    mac,
    label,
    deviceCount: db.countDevices.get(phone).n,
    remainingSeconds: info.remainingSeconds,
  });
});

app.post('/api/device/list', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid number.' });

  const devices = db.devicesFor.all(phone).map((d) => ({
    mac: d.mac, label: d.label,
  }));
  res.json({ devices, max: MAX_DEVICES_PER_ACCOUNT });
});

app.post('/api/device/remove', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const mac = String((req.body && req.body.mac) || '').toUpperCase();
  if (!phone || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
    return res.status(400).json({ error: 'Bad request.' });
  }
  db.removeDevice.run({ mac, phone });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Vouchers                                                            */
/* ------------------------------------------------------------------ */

app.post('/api/voucher/redeem', async (req, res) => {
  const raw = String((req.body && req.body.code) || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (raw.length < 6 || raw.length > 24) {
    return res.status(400).json({ error: 'Hiyo code si sahihi.' });
  }

  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Weka namba yako ya simu pia.' });
  }

  const voucher = db.getVoucher.get(raw);
  if (!voucher) return res.status(404).json({ error: 'Code haipo. Angalia tena.' });
  if (voucher.redeemed_at) {
    return res.status(409).json({ error: 'Code hii imeshatumika.' });
  }

  // The WHERE clause is the lock: two simultaneous redemptions cannot
  // both report a change, so a code can only ever be spent once.
  const claimed = db.claimVoucher.run({ code: raw, phone });
  if (claimed.changes !== 1) {
    return res.status(409).json({ error: 'Code hii imeshatumika.' });
  }

  const pkg = pkgById(voucher.package_id);
  const result = await grantTime({
    phone,
    seconds: voucher.seconds,
    profile: pkg ? pkg.profile : 'standard',
    mac: cleanMac(req.body && req.body.mac),
    ip: cleanIp(req.body && req.body.ip),
    reason: `voucher ${raw}`,
  });

  res.json({
    ok: true,
    username: result.username,
    password: result.password,
    grantedSeconds: voucher.seconds,
  });
});

/** Batch generation. Protected by ADMIN_TOKEN; no token, no endpoint. */
app.post('/api/admin/vouchers', (req, res) => {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin || String(req.headers['x-admin-token'] || '') !== admin) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const pkg = pkgById((req.body && req.body.packageId) || '');
  if (!pkg) return res.status(400).json({ error: 'Unknown package.' });

  const count = Math.min(Math.max(Number(req.body.count) || 1, 1), 200);
  const batch = new Date().toISOString().slice(0, 10);
  const codes = [];

  for (let i = 0; i < count; i++) {
    const code = 'FITI' + generateCode(8);
    db.addVoucher.run({ code, packageId: pkg.id, seconds: pkg.seconds, batch });
    codes.push(code);
  }

  console.log(`[admin] issued ${count} ${pkg.id} voucher(s)`);
  res.json({ package: pkg.id, count, codes });
});

/* ------------------------------------------------------------------ */
/* Paybill fallback                                                    */
/* ------------------------------------------------------------------ */

/**
 * Some customers cancel the STK prompt, or their SIM toolkit misbehaves.
 * They can pay the shortcode manually instead, using their phone number
 * as the account reference. Safaricom posts the result here.
 */
app.post('/api/mpesa/c2b/confirmation', (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  setImmediate(async () => {
    try {
      const b = req.body || {};
      const phone = mpesa.normalizePhone(b.BillRefNumber || b.MSISDN);
      const amount = Math.round(Number(b.TransAmount));
      const receipt = String(b.TransID || '');

      if (!phone || !Number.isFinite(amount) || amount <= 0) {
        console.warn('[c2b] unusable payload:', JSON.stringify(b));
        return;
      }
      if (db.isDuplicateReceipt(receipt, '')) {
        console.log(`[c2b] receipt ${receipt} already banked, ignoring`);
        return;
      }

      // Buy the largest package the amount covers. Anything less than the
      // cheapest package is recorded but grants nothing - the customer is
      // told to top up rather than silently losing the money.
      const affordable = ALL_PACKAGES
        .filter((p) => p.price <= amount)
        .sort((a, b2) => b2.price - a.price)[0];

      if (!affordable) {
        console.warn(`[c2b] ${phone} sent ${amount} - below the cheapest package`);
        return;
      }

      await grantTime({
        phone,
        seconds: affordable.seconds,
        profile: affordable.profile,
        mac: null,
        ip: null,
        reason: `paybill ${receipt}`,
      });
    } catch (err) {
      console.error('[c2b] handler threw:', err);
    }
  });
});

app.post('/api/mpesa/c2b/validation', (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

/* ------------------------------------------------------------------ */
/* Ledger repair                                                       */
/* ------------------------------------------------------------------ */

/**
 * Rebuild an account's balance from its payment history.
 *
 * The transactions table is the record of money actually received, so it
 * is the only thing worth trusting when the ledger and the router have
 * drifted apart - a restored backup, a bug that overwrote totals, a
 * database that started life after the customer did.
 *
 * GET reports what it would do and changes nothing. POST applies it.
 */
function rebuildLedger(phone, apply) {
  const paid = db.paidTransactionsFor.all(phone);
  const purchased = paid.reduce((sum, tx) => sum + tx.seconds, 0);

  const account = db.getAccount.get(phone);
  const used = account ? (account.used_seconds || 0) : 0;
  const currentTotal = account ? account.total_seconds : 0;

  // A customer cannot have less time than they have already consumed, or
  // they are locked out of internet they paid for.
  const rebuiltTotal = Math.max(purchased, used);

  if (apply && account) {
    db.setTotal.run({ phone, totalSeconds: rebuiltTotal });
  }

  return {
    phone,
    payments: paid.length,
    purchasedSeconds: purchased,
    usedSeconds: used,
    previousTotal: currentTotal,
    rebuiltTotal,
    remainingAfter: Math.max(0, rebuiltTotal - used),
    applied: Boolean(apply && account),
    transactions: paid.map((tx) => ({
      package: tx.package_id,
      amount: tx.amount,
      seconds: tx.seconds,
      receipt: tx.mpesa_receipt,
      at: tx.created_at,
    })),
  };
}

function adminOk(req) {
  const admin = process.env.ADMIN_TOKEN;
  return Boolean(admin) && String(req.headers['x-admin-token'] || '') === admin;
}

app.get('/api/admin/ledger/:phone', (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const phone = mpesa.normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Bad phone number.' });
  res.json(rebuildLedger(phone, false));
});

app.post('/api/admin/ledger/:phone/rebuild', (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const phone = mpesa.normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Bad phone number.' });

  const result = rebuildLedger(phone, true);

  // Push the corrected figure to the router so it takes effect now
  // rather than at the customer's next purchase.
  if (result.applied && config.provisionMode === 'poll') {
    const account = db.getAccount.get(phone);
    db.addJob.run({
      site: config.site.id,
      username: phone,
      password: account.password,
      profile: 'standard',
      totalSeconds: result.rebuiltTotal,
      mac: account.last_mac || null,
      ip: null,
    });
    result.queuedForRouter = true;
  }

  console.log(
    `[admin] rebuilt ${phone}: ${result.payments} payment(s), ` +
      `${result.previousTotal}s -> ${result.rebuiltTotal}s`
  );
  res.json(result);
});

/* ------------------------------------------------------------------ */
/* Router polling API                                                  */
/* ------------------------------------------------------------------ */

const crypto = require('crypto');
const { buildScript } = require('./lib/rsc');

/** Constant-time compare so the token cannot be guessed by timing. */
function tokenOk(supplied) {
  const expected = config.site.token;
  if (!expected) return false;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authSite(req, res) {
  const site = String(req.query.site || '');
  if (site !== config.site.id || !tokenOk(req.query.token)) {
    res.status(403).type('text/plain').send('# forbidden\n');
    return null;
  }
  return site;
}

/**
 * A router asks what work is waiting. The reply is RouterOS script, which
 * the router parses and runs in memory - no file written, no flash wear.
 * Empty means nothing to do, which is the common case.
 */
app.get('/api/router/jobs', (req, res) => {
  const site = authSite(req, res);
  if (!site) return;

  const jobs = db.pendingJobs.all(site);
  if (!jobs.length) return res.type('text/plain').send('');

  const { script, emitted, rejected } = buildScript({
    jobs,
    hotspotServer: config.site.hotspotServer,
  });

  for (const id of emitted) db.markDelivered.run(id);

  if (rejected.length) {
    console.error(
      `[router] refused to emit malformed jobs: ${rejected.join(', ')}`
    );
  }
  if (emitted.length) {
    console.log(`[router] ${site} collected job(s) ${emitted.join(', ')}`);
  }

  res.type('text/plain').send(script);
});

/**
 * The router reports what it has actually used, then collects new work in
 * the same round trip. Usage lives on the router - it is the only thing
 * that counts real seconds - so without this the portal can only show
 * what was bought, never what is left.
 *
 * Body is plain text, one line per user: username:used:limit
 */
app.post('/api/router/sync', (req, res) => {
  const site = authSite(req, res);
  if (!site) return;

  // Jobs the router ran last cycle. This replaces the old separate ack
  // fetch, which failed silently and caused endless redelivery.
  const acked = String(req.query.ack || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);

  for (const id of acked) db.markAcked.run(id, site);
  if (acked.length) console.log(`[router] ${site} acked ${acked.join(', ')}`);

  // Defensive: if anything upstream ever hands us a non-string again,
  // degrade to "no usage reported" rather than throwing.
  const raw = typeof req.body === 'string' ? req.body : '';
  const lines = raw.split('\n');
  let updated = 0;

  for (const line of lines) {
    const parts = line.trim().split(':');
    if (parts.length < 2) continue;

    const phone = parts[0].trim();
    const used = Number(parts[1]);
    if (!/^254[17]\d{8}$/.test(phone)) continue;
    if (!Number.isFinite(used) || used < 0) continue;

    // Fourth field is "1" when the customer has a live session. Older
    // routers send three fields; treat those as offline rather than
    // guessing, so an out-of-date router cannot drain balances.
    const isActive = parts.length > 3 && parts[3].trim() === '1' ? 1 : 0;

    db.recordUsage.run({ phone, usedSeconds: Math.round(used), isActive });
    updated++;
  }

  if (updated) console.log(`[router] ${site} reported usage for ${updated} user(s)`);

  const jobs = db.pendingJobs.all(site);
  if (!jobs.length) return res.type('text/plain').send('');

  const { script, emitted, rejected } = buildScript({
    jobs, hotspotServer: config.site.hotspotServer,
  });

  for (const id of emitted) db.markDelivered.run(id);
  if (rejected.length) {
    console.error(`[router] refused malformed jobs: ${rejected.join(', ')}`);
  }
  if (emitted.length) console.log(`[router] ${site} collected job(s) ${emitted.join(', ')}`);

  res.type('text/plain').send(script);
});

/** The router confirms it ran the work. Unacked jobs get redelivered. */
app.get('/api/router/ack', (req, res) => {
  const site = authSite(req, res);
  if (!site) return;

  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);

  for (const id of ids) db.markAcked.run(id, site);
  if (ids.length) console.log(`[router] ${site} acked ${ids.join(', ')}`);

  res.type('text/plain').send('# ok\n');
});

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/health', async (req, res) => {
  const out = { ok: true, mpesaEnv: config.mpesa.env };

  out.provisionMode = config.provisionMode;

  if (config.provisionMode === 'poll') {
    out.site = config.site.id;
    out.pendingJobs = db.pendingJobs.all(config.site.id).length;
    out.tokenSet = Boolean(config.site.token);
    if (!out.tokenSet) {
      out.ok = false;
      out.note = 'SITE_TOKEN is not set - routers cannot authenticate.';
    }
    return res.status(out.ok ? 200 : 503).json(out);
  }

  if (!config.mikrotik.configured) {
    out.router = { configured: false, note: 'Payments work; access is not granted.' };
    return res.json(out);
  }

  try {
    out.router = await mikrotik.testConnection();
  } catch (err) {
    out.ok = false;
    out.router = { error: err.message };
  }
  res.status(out.ok ? 200 : 503).json(out);
});

app.listen(config.port, () => {
  console.log(`${config.brandName} hotspot billing on :${config.port}`);
  console.log(`M-Pesa environment: ${config.mpesa.env}`);
  console.log(`Callback URL: ${config.publicUrl}/api/mpesa/callback`);
  if (config.mpesa.env === 'sandbox') {
    console.log('Sandbox mode - no real money will move.');
  }
  console.log(`Provisioning mode: ${config.provisionMode}`);
  if (config.provisionMode === 'poll') {
    console.log(`Site: ${config.site.id}`);
    if (!config.site.token) {
      console.log('WARNING: SITE_TOKEN is empty - no router can collect jobs.');
    }
  } else if (!config.mikrotik.configured) {
    console.log(
      'No router configured - payments are processed and recorded, but ' +
      'nobody gets internet.'
    );
  }
});

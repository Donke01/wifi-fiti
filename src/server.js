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
    testMode: config.mpesa.env === 'sandbox',
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
async function reconcile() {
  for (const tx of db.stalePending.all(40)) {
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

setInterval(() => reconcile().catch((e) => console.error('[reconcile]', e)), 30_000).unref();

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

  const ackUrl =
    `${config.publicUrl}/api/router/ack` +
    `?site=${encodeURIComponent(site)}` +
    `&token=${encodeURIComponent(config.site.token)}&ids=`;

  const { script, emitted, rejected } = buildScript({
    jobs,
    hotspotServer: config.site.hotspotServer,
    ackUrl,
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

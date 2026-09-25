'use strict';

/**
 * Sales demo module.
 *
 * Everything behind the marketing site's "Request a demo" button lives here:
 *
 *   1. Demo requests — a short lead form (with an earnings estimate and a
 *      preferred call / visit slot) that is stored, listed for the platform
 *      admin, and announced to the operator by SMS, email and WhatsApp.
 *   2. The live "pay and connect" demo — a prospect enters their own number
 *      and receives a real, tiny STK push through Tuma. When Tuma is not
 *      configured (local development, tests, or deliberately switched off)
 *      the same flow runs in a clearly labelled practice mode that moves no
 *      money.
 *
 * The module is deliberately isolated from tenant billing. Demo payments use
 * their own table, never touch a router, never grant internet access and
 * never count towards any tenant's sales or platform fees.
 */
const crypto = require('node:crypto');

const BUSINESS_TYPES = {
  cyber: 'Cyber café',
  estate: 'Estate / apartments',
  cafe: 'Café / restaurant',
  school: 'School / college',
  church: 'Church',
  shop: 'Shop / kiosk',
  hotel: 'Hotel / lodging',
  isp: 'ISP / reseller',
  other: 'Other',
};
const CONTACT_METHODS = { whatsapp: 'WhatsApp', call: 'Phone call', onsite: 'On-site visit' };
const TIME_SLOTS = {
  morning: 'Morning (8–11am)',
  midday: 'Midday (11am–2pm)',
  afternoon: 'Afternoon (2–5pm)',
  evening: 'Evening (5–7pm)',
};
const STATUSES = ['new', 'contacted', 'demo_done', 'signed_up', 'lost'];

function normalisePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('254')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[71]\d{8}$/.test(digits)) return null;
  return `254${digits}`;
}

function displayPhone(msisdn) {
  const local = `0${String(msisdn).slice(3)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

function maskPhone(msisdn) {
  const local = `0${String(msisdn || '').slice(3)}`;
  return local.length === 10 ? `${local.slice(0, 4)} ••• ${local.slice(7)}` : '—';
}

function text(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function integer(value, { min, max, fallback = null }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isoDay(date) { return date.toISOString().slice(0, 10); }

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

class ValidationError extends Error {
  constructor(message, field) { super(message); this.status = 400; this.field = field; }
}

/**
 * Validate and normalise a demo request body. Pure, so the browser rules and
 * the server rules can be tested without HTTP.
 */
function validateRequest(body, { today = new Date() } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const name = text(input.name, 80);
  if (name.length < 2) throw new ValidationError('Enter your name.', 'name');
  const phone = normalisePhone(input.phone);
  if (!phone) throw new ValidationError('Enter a valid Safaricom, Airtel or Telkom number.', 'phone');
  const email = text(input.email, 120).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new ValidationError('Enter a valid email address, or leave it blank.', 'email');
  const businessType = text(input.businessType, 20);
  if (!BUSINESS_TYPES[businessType]) throw new ValidationError('Choose your type of business.', 'businessType');
  const town = text(input.town, 60);
  if (town.length < 2) throw new ValidationError('Enter your town or area.', 'town');
  const contactMethod = CONTACT_METHODS[input.contactMethod] ? input.contactMethod : 'whatsapp';
  const preferredSlot = TIME_SLOTS[input.preferredSlot] ? input.preferredSlot : null;
  let preferredDate = null;
  if (input.preferredDate) {
    const raw = text(input.preferredDate, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
      throw new ValidationError('Choose a valid date.', 'preferredDate');
    }
    const earliest = new Date(today.getTime() - 24 * 3600 * 1000);
    const latest = new Date(today.getTime() + 90 * 24 * 3600 * 1000);
    if (raw < isoDay(earliest) || raw > isoDay(latest)) throw new ValidationError('Choose a date within the next three months.', 'preferredDate');
    preferredDate = raw;
  }
  return {
    name,
    phone,
    email: email || null,
    businessType,
    town,
    locations: integer(input.locations, { min: 1, max: 500, fallback: 1 }),
    routerModel: text(input.routerModel, 60) || null,
    usersPerDay: integer(input.usersPerDay, { min: 0, max: 100000 }),
    avgPriceKes: integer(input.avgPriceKes, { min: 0, max: 10000 }),
    contactMethod,
    preferredDate,
    preferredSlot,
    notes: text(input.notes, 500) || null,
    source: text(input.source, 40) || 'website',
  };
}

/**
 * Monthly earnings estimate shown in the form and stored with the lead.
 * Hotspot billing is 3% of confirmed sales on the operator's own rail and 5%
 * when Wi-Fi Fiti collects on their behalf (see the pricing section).
 */
function estimateEarnings({ usersPerDay, avgPriceKes, days = 30, feePercent = 3 }) {
  const users = Math.max(0, Number(usersPerDay) || 0);
  const price = Math.max(0, Number(avgPriceKes) || 0);
  const gross = Math.round(users * price * days);
  const fee = Math.round(gross * feePercent / 100);
  return { gross, fee, net: gross - fee };
}

function requestSummaryMessage(lead) {
  const when = [lead.preferredDate, lead.preferredSlot && TIME_SLOTS[lead.preferredSlot]].filter(Boolean).join(' ');
  const estimate = lead.usersPerDay && lead.avgPriceKes
    ? ` Est. KES ${estimateEarnings(lead).gross.toLocaleString('en-KE')}/mo.` : '';
  return text(
    `New Wi-Fi Fiti demo request: ${lead.name}, ${displayPhone(lead.phone)}. ` +
    `${BUSINESS_TYPES[lead.businessType]} in ${lead.town}, ${lead.locations} location${lead.locations === 1 ? '' : 's'}. ` +
    `Prefers ${CONTACT_METHODS[lead.contactMethod]}${when ? ` ${when}` : ''}.${estimate}`,
    320,
  );
}

function createDemo({
  db,
  adminOk,
  tuma = null,
  publicUrl = '',
  smsProvider = null,
  sendEmail = null,
  whatsapp = null,
  env = process.env,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (!db) throw new Error('Demo module requires a database.');
  db.exec(`
    CREATE TABLE IF NOT EXISTS demo_requests (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      phone           TEXT NOT NULL,
      email           TEXT,
      business_type   TEXT NOT NULL,
      town            TEXT NOT NULL,
      locations       INTEGER NOT NULL DEFAULT 1,
      router_model    TEXT,
      users_per_day   INTEGER,
      avg_price_kes   INTEGER,
      contact_method  TEXT NOT NULL DEFAULT 'whatsapp',
      preferred_date  TEXT,
      preferred_slot  TEXT,
      notes           TEXT,
      source          TEXT,
      status          TEXT NOT NULL DEFAULT 'new',
      admin_notes     TEXT,
      notified        TEXT,
      ip_hash         TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS demo_requests_phone ON demo_requests(phone, created_at);
    CREATE INDEX IF NOT EXISTS demo_requests_status ON demo_requests(status, created_at);
    CREATE TABLE IF NOT EXISTS demo_payments (
      checkout_request_id TEXT PRIMARY KEY,
      merchant_request_id TEXT,
      token_hash          TEXT NOT NULL,
      phone               TEXT NOT NULL,
      amount              INTEGER NOT NULL,
      mode                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      result_desc         TEXT,
      receipt             TEXT,
      session_seconds     INTEGER NOT NULL,
      settle_after        INTEGER,
      paid_at             INTEGER,
      ip_hash             TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS demo_payments_phone ON demo_payments(phone, created_at);
    CREATE INDEX IF NOT EXISTS demo_payments_created ON demo_payments(created_at);
  `);

  const settings = () => ({
    amount: integer(env.DEMO_AMOUNT_KES, { min: 1, max: 50, fallback: 1 }),
    sessionSeconds: integer(env.DEMO_SESSION_SECONDS, { min: 60, max: 3600, fallback: 300 }),
    dailyLimit: integer(env.DEMO_DAILY_LIMIT, { min: 1, max: 10000, fallback: 150 }),
    perPhoneDaily: integer(env.DEMO_PER_PHONE_DAILY, { min: 1, max: 50, fallback: 3 }),
    cooldownMs: integer(env.DEMO_PHONE_COOLDOWN_SECONDS, { min: 10, max: 3600, fallback: 90 }) * 1000,
    practiceDelayMs: integer(env.DEMO_PRACTICE_DELAY_MS, { min: 0, max: 60000, fallback: 6000 }),
    pendingTimeoutMs: integer(env.DEMO_PENDING_TIMEOUT_SECONDS, { min: 30, max: 1800, fallback: 180 }) * 1000,
    whatsappNumber: String(env.DEMO_WHATSAPP_NUMBER || '254718016683').replace(/\D/g, ''),
    notifyPhone: normalisePhone(env.DEMO_NOTIFY_PHONE || ''),
    notifyEmail: String(env.DEMO_NOTIFY_EMAIL || '').trim(),
  });

  function liveMode() {
    return String(env.DEMO_LIVE_PAYMENTS || 'on').toLowerCase() !== 'off' && Boolean(tuma && tuma.configured && tuma.configured());
  }

  const statements = {
    recentByPhone: db.prepare(`SELECT id FROM demo_requests WHERE phone=? AND status='new' AND created_at >= ? ORDER BY created_at DESC LIMIT 1`),
    insertRequest: db.prepare(`INSERT INTO demo_requests (id,name,phone,email,business_type,town,locations,router_model,users_per_day,avg_price_kes,
      contact_method,preferred_date,preferred_slot,notes,source,status,ip_hash,created_at,updated_at)
      VALUES (@id,@name,@phone,@email,@businessType,@town,@locations,@routerModel,@usersPerDay,@avgPriceKes,
      @contactMethod,@preferredDate,@preferredSlot,@notes,@source,'new',@ipHash,@now,@now)`),
    updateRequest: db.prepare(`UPDATE demo_requests SET name=@name,email=@email,business_type=@businessType,town=@town,locations=@locations,
      router_model=@routerModel,users_per_day=@usersPerDay,avg_price_kes=@avgPriceKes,contact_method=@contactMethod,
      preferred_date=@preferredDate,preferred_slot=@preferredSlot,notes=@notes,source=@source,updated_at=@now WHERE id=@id`),
    setNotified: db.prepare('UPDATE demo_requests SET notified=? WHERE id=?'),
    getRequest: db.prepare('SELECT * FROM demo_requests WHERE id=?'),
    listRequests: db.prepare('SELECT * FROM demo_requests ORDER BY created_at DESC LIMIT 500'),
    countByStatus: db.prepare('SELECT status, COUNT(*) AS n FROM demo_requests GROUP BY status'),
    adminUpdate: db.prepare('UPDATE demo_requests SET status=@status, admin_notes=@adminNotes, updated_at=@now WHERE id=@id'),
    paymentsToday: db.prepare('SELECT COUNT(*) AS n FROM demo_payments WHERE created_at >= ?'),
    phonePaymentsSince: db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM demo_payments WHERE phone=? AND created_at >= ?'),
    insertPayment: db.prepare(`INSERT INTO demo_payments (checkout_request_id,merchant_request_id,token_hash,phone,amount,mode,status,
      session_seconds,settle_after,ip_hash,created_at) VALUES (@id,@merchantId,@tokenHash,@phone,@amount,@mode,'pending',@sessionSeconds,@settleAfter,@ipHash,@now)`),
    getPayment: db.prepare('SELECT * FROM demo_payments WHERE checkout_request_id=?'),
    settle: db.prepare(`UPDATE demo_payments SET status=@status, result_desc=@resultDesc, receipt=@receipt, paid_at=@paidAt
      WHERE checkout_request_id=@id AND status='pending'`),
    // A late callback may still settle a payment the status poll already
    // marked expired, so a prospect who did pay is never shown as failed.
    settleCallback: db.prepare(`UPDATE demo_payments SET status=@status, result_desc=@resultDesc, receipt=@receipt, paid_at=@paidAt
      WHERE checkout_request_id=@id AND status IN ('pending','expired')`),
    receiptUsed: db.prepare('SELECT 1 FROM demo_payments WHERE receipt=? AND checkout_request_id != ?'),
    paymentStats: db.prepare(`SELECT mode, status, COUNT(*) AS n, COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS kes
      FROM demo_payments GROUP BY mode, status`),
    recentPayments: db.prepare('SELECT checkout_request_id,phone,amount,mode,status,result_desc,receipt,created_at,paid_at FROM demo_payments ORDER BY created_at DESC LIMIT 50'),
  };

  function nowIso() { return new Date(now()).toISOString(); }
  function ipHash(req) { return req && req.ip ? hash(`demo:${req.ip}`).slice(0, 24) : null; }

  async function notify(lead) {
    const s = settings();
    const message = requestSummaryMessage(lead);
    const channels = [];
    const attempts = [];
    if (smsProvider && s.notifyPhone) {
      attempts.push(Promise.resolve().then(() => smsProvider.send({ to: `+${s.notifyPhone}`, message }))
        .then(() => channels.push('sms'))
        .catch((error) => log.error('[demo] SMS alert failed:', error.message)));
    }
    if (sendEmail && s.notifyEmail) {
      const rows = [
        ['Name', lead.name], ['Phone', displayPhone(lead.phone)], ['Email', lead.email || '—'],
        ['Business', BUSINESS_TYPES[lead.businessType]], ['Town', lead.town], ['Locations', lead.locations],
        ['Router', lead.routerModel || '—'], ['Users per day', lead.usersPerDay ?? '—'], ['Average price', lead.avgPriceKes != null ? `KES ${lead.avgPriceKes}` : '—'],
        ['Contact by', CONTACT_METHODS[lead.contactMethod]], ['Preferred time', [lead.preferredDate, lead.preferredSlot && TIME_SLOTS[lead.preferredSlot]].filter(Boolean).join(' · ') || '—'],
        ['Notes', lead.notes || '—'],
      ];
      const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      const html = `<h2 style="font-family:sans-serif">New demo request</h2><table style="font-family:sans-serif;border-collapse:collapse">${rows
        .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#5d6d80">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`).join('')}</table>`;
      attempts.push(Promise.resolve().then(() => sendEmail({ to: s.notifyEmail, subject: `Demo request: ${lead.name} (${lead.town})`, html, text: message }))
        .then(() => channels.push('email'))
        .catch((error) => log.error('[demo] email alert failed:', error.message)));
    }
    if (whatsapp && whatsapp.configured && whatsapp.configured() && s.notifyPhone) {
      // Free-form WhatsApp text only delivers inside Meta's 24-hour service
      // window, so this channel is best effort next to SMS and email.
      attempts.push(Promise.resolve().then(() => whatsapp.sendText({ to: s.notifyPhone, body: message }))
        .then(() => channels.push('whatsapp'))
        .catch((error) => log.error('[demo] WhatsApp alert failed:', error.message)));
    }
    await Promise.all(attempts);
    statements.setNotified.run(channels.length ? channels.sort().join(',') : 'none', lead.id);
    return channels;
  }

  function whatsappLink(lead) {
    const s = settings();
    const message = `Hello Wi-Fi Fiti, I'm ${lead.name} (${BUSINESS_TYPES[lead.businessType]}, ${lead.town}). ` +
      `I've just requested a demo for ${lead.locations} location${lead.locations === 1 ? '' : 's'}.`;
    return `https://wa.me/${s.whatsappNumber}?text=${encodeURIComponent(message)}`;
  }

  let lastNotification = Promise.resolve([]);

  function createRequest(body, req) {
    // Honeypot: real people never see or fill the "website" field.
    if (body && String(body.website || '').trim()) return { id: null, ignored: true };
    const lead = validateRequest(body, { today: new Date(now()) });
    const stamp = nowIso();
    const recent = statements.recentByPhone.get(lead.phone, new Date(now() - 30 * 60 * 1000).toISOString());
    let id;
    if (recent) {
      id = recent.id;
      const { phone: _samePhone, ...fields } = lead;
      statements.updateRequest.run({ ...fields, id, now: stamp });
    } else {
      id = `demo_${crypto.randomBytes(9).toString('hex')}`;
      statements.insertRequest.run({ ...lead, id, ipHash: ipHash(req), now: stamp });
    }
    const stored = { ...lead, id };
    if (!recent) {
      lastNotification = notify(stored).catch((error) => { log.error('[demo] notify failed:', error.message); return []; });
    }
    return { id, updated: Boolean(recent), lead: stored, whatsappUrl: whatsappLink(stored) };
  }

  function rowToLead(row) {
    return {
      id: row.id, name: row.name, phone: row.phone, phoneDisplay: displayPhone(row.phone), email: row.email,
      businessType: row.business_type, businessTypeLabel: BUSINESS_TYPES[row.business_type] || row.business_type,
      town: row.town, locations: row.locations, routerModel: row.router_model,
      usersPerDay: row.users_per_day, avgPriceKes: row.avg_price_kes,
      estimateKes: row.users_per_day && row.avg_price_kes ? estimateEarnings({ usersPerDay: row.users_per_day, avgPriceKes: row.avg_price_kes }).gross : null,
      contactMethod: row.contact_method, contactLabel: CONTACT_METHODS[row.contact_method] || row.contact_method,
      preferredDate: row.preferred_date, preferredSlot: row.preferred_slot, preferredSlotLabel: TIME_SLOTS[row.preferred_slot] || null,
      notes: row.notes, source: row.source, status: row.status, adminNotes: row.admin_notes, notified: row.notified,
      createdAt: row.created_at, updatedAt: row.updated_at,
      whatsappUrl: `https://wa.me/${row.phone}`,
    };
  }

  /* ---------------- live pay-and-connect demo ---------------- */

  class LimitError extends Error { constructor(message, retryAfter) { super(message); this.status = 429; this.retryAfter = retryAfter; } }

  async function startPayment(body, req) {
    const phone = normalisePhone(body && body.phone);
    if (!phone) throw new ValidationError('Enter a valid M-Pesa number, e.g. 0712 345 678.', 'phone');
    const s = settings();
    const t = now();
    const dayStart = t - 24 * 3600 * 1000;
    if (statements.paymentsToday.get(dayStart).n >= s.dailyLimit) {
      throw new LimitError('The live demo is resting for today. Please request a demo and we will walk you through it.', 3600);
    }
    const mine = statements.phonePaymentsSince.get(phone, dayStart);
    if (mine.n >= s.perPhoneDaily) throw new LimitError('You have tried the demo a few times today. Request a demo and we will show you more.', 3600);
    if (mine.last && t - mine.last < s.cooldownMs) {
      const wait = Math.ceil((s.cooldownMs - (t - mine.last)) / 1000);
      throw new LimitError(`A prompt was just sent to this number. Try again in ${wait} seconds.`, wait);
    }
    const token = crypto.randomBytes(24).toString('hex');
    const mode = liveMode() ? 'live' : 'practice';
    let id;
    let merchantId = null;
    if (mode === 'live') {
      const pushed = await tuma.stkPush({ phone, amount: s.amount, description: 'Wi-Fi Fiti live demo', publicUrl });
      id = pushed.checkoutRequestId;
      merchantId = pushed.merchantRequestId || null;
    } else {
      id = `demo_practice_${crypto.randomBytes(12).toString('hex')}`;
    }
    statements.insertPayment.run({
      id, merchantId, tokenHash: hash(token), phone, amount: s.amount, mode,
      sessionSeconds: s.sessionSeconds, settleAfter: mode === 'practice' ? t + s.practiceDelayMs : null,
      ipHash: ipHash(req), now: t,
    });
    return { id, token, mode, amount: s.amount, sessionSeconds: s.sessionSeconds, phoneDisplay: displayPhone(phone) };
  }

  function paymentStatus(id, token) {
    const row = statements.getPayment.get(String(id || ''));
    if (!row || !safeEqualHex(row.token_hash, hash(token || ''))) return null;
    const t = now();
    if (row.status === 'pending') {
      const s = settings();
      if (row.mode === 'practice' && row.settle_after && t >= row.settle_after) {
        statements.settle.run({ id: row.checkout_request_id, status: 'paid', resultDesc: 'Practice payment confirmed.', receipt: null, paidAt: row.settle_after });
      } else if (row.mode === 'live' && t - row.created_at > s.pendingTimeoutMs) {
        statements.settle.run({ id: row.checkout_request_id, status: 'expired', resultDesc: 'No payment confirmation arrived in time.', receipt: null, paidAt: null });
      }
    }
    const fresh = statements.getPayment.get(row.checkout_request_id);
    const expiresAt = fresh.paid_at ? fresh.paid_at + fresh.session_seconds * 1000 : null;
    return {
      status: fresh.status,
      mode: fresh.mode,
      amount: fresh.amount,
      sessionSeconds: fresh.session_seconds,
      receipt: fresh.receipt,
      reason: fresh.status === 'failed' || fresh.status === 'expired' ? fresh.result_desc : null,
      paidAt: fresh.paid_at ? new Date(fresh.paid_at).toISOString() : null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      remainingSeconds: expiresAt ? Math.max(0, Math.round((expiresAt - t) / 1000)) : null,
      serverTime: new Date(t).toISOString(),
    };
  }

  function ownsCheckout(checkoutRequestId) {
    return Boolean(statements.getPayment.get(String(checkoutRequestId || '').trim()));
  }

  /** Handle a Tuma STK callback for a demo payment. Returns true when handled. */
  function handleTumaCallback(body) {
    const id = String(body && body.checkout_request_id || '').trim();
    const row = statements.getPayment.get(id);
    if (!row) return false;
    if (row.mode !== 'live' || !['pending', 'expired'].includes(row.status)) return true;
    const resultCode = Number(body && body.result_code);
    const reported = String(body && body.status || '').toLowerCase();
    const completed = resultCode === 0 && (!reported || reported === 'completed');
    if (!completed) {
      statements.settleCallback.run({ id, status: 'failed', resultDesc: text(body && (body.failure_reason || body.result_desc), 160) || 'Payment was not completed.', receipt: null, paidAt: null });
      return true;
    }
    const amount = Number(body && body.amount);
    const receipt = text(body && body.mpesa_receipt_number, 40).toUpperCase();
    if (!Number.isFinite(amount) || amount < row.amount || !/^[A-Z0-9]{8,20}$/.test(receipt) || statements.receiptUsed.get(receipt, id)) {
      log.error(`[demo] rejected callback for ${id}: amount or receipt did not verify`);
      statements.settleCallback.run({ id, status: 'failed', resultDesc: 'Payment could not be verified.', receipt: null, paidAt: null });
      return true;
    }
    statements.settleCallback.run({ id, status: 'paid', resultDesc: text(body.result_desc, 160) || 'Payment confirmed.', receipt, paidAt: now() });
    return true;
  }

  /* ---------------- HTTP routes ---------------- */

  const REQUEST_FAILED = { status: 500, message: 'We could not save your request just now. Please try again, or message us on WhatsApp.' };
  const PROMPT_FAILED = { status: 502, message: 'We could not send the payment prompt just now. Please try again in a moment.' };
  function sendError(res, error, fallback) {
    if (error instanceof ValidationError || error.status === 400) return res.status(400).json({ error: error.message, field: error.field || null });
    if (error.status === 429) return res.status(429).set('Retry-After', String(error.retryAfter || 60)).json({ error: error.message });
    log.error('[demo]', error.message);
    return res.status(fallback.status).json({ error: fallback.message });
  }

  function attachRoutes(app) {
    app.get('/api/demo/config', (req, res) => {
      const s = settings();
      res.json({
        live: liveMode(), amount: s.amount, sessionSeconds: s.sessionSeconds,
        whatsappNumber: s.whatsappNumber,
        businessTypes: BUSINESS_TYPES, contactMethods: CONTACT_METHODS, timeSlots: TIME_SLOTS,
      });
    });

    app.post('/api/demo/requests', (req, res) => {
      try {
        const result = createRequest(req.body, req);
        if (result.ignored) return res.status(201).json({ ok: true });
        return res.status(result.updated ? 200 : 201).json({ ok: true, id: result.id, whatsappUrl: result.whatsappUrl });
      } catch (error) { return sendError(res, error, REQUEST_FAILED); }
    });

    app.post('/api/demo/pay', async (req, res) => {
      try { return res.status(201).json(await startPayment(req.body, req)); }
      catch (error) { return sendError(res, error, PROMPT_FAILED); }
    });

    app.get('/api/demo/pay/:id', (req, res) => {
      const status = paymentStatus(req.params.id, req.query.token || req.get('X-Demo-Token'));
      if (!status) return res.status(404).json({ error: 'Demo payment not found.' });
      return res.json(status);
    });

    const guard = (handler) => (req, res) => {
      if (!adminOk(req)) return res.status(403).json({ error: 'Platform administrator access is required.' });
      try { res.set('Cache-Control', 'no-store'); return handler(req, res); }
      catch (error) { log.error('[demo admin]', error.message); return res.status(500).json({ error: 'Could not load demo records.' }); }
    };

    app.get('/api/admin/demo/requests', guard((req, res) => {
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const row of statements.countByStatus.all()) counts[row.status] = row.n;
      res.json({ requests: statements.listRequests.all().map(rowToLead), counts, statuses: STATUSES });
    }));

    app.patch('/api/admin/demo/requests/:id', guard((req, res) => {
      const row = statements.getRequest.get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Demo request not found.' });
      const status = req.body && STATUSES.includes(req.body.status) ? req.body.status : row.status;
      const adminNotes = req.body && req.body.adminNotes !== undefined ? text(req.body.adminNotes, 1000) || null : row.admin_notes;
      statements.adminUpdate.run({ id: row.id, status, adminNotes, now: nowIso() });
      res.json({ request: rowToLead(statements.getRequest.get(row.id)) });
    }));

    app.get('/api/admin/demo/payments', guard((req, res) => {
      res.json({
        live: liveMode(),
        stats: statements.paymentStats.all(),
        payments: statements.recentPayments.all().map((p) => ({
          id: p.checkout_request_id, phone: maskPhone(p.phone), amount: p.amount, mode: p.mode, status: p.status,
          reason: p.result_desc, receipt: p.receipt,
          createdAt: new Date(p.created_at).toISOString(), paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null,
        })),
      });
    }));
  }

  return {
    attachRoutes,
    createRequest,
    startPayment,
    paymentStatus,
    ownsCheckout,
    handleTumaCallback,
    liveMode,
    get lastNotification() { return lastNotification; },
  };
}

module.exports = {
  createDemo,
  validateRequest,
  estimateEarnings,
  requestSummaryMessage,
  normalisePhone,
  BUSINESS_TYPES,
  CONTACT_METHODS,
  TIME_SLOTS,
  STATUSES,
};

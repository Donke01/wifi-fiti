'use strict';

const crypto = require('crypto');
const team = require('./team');

/** Business records and manually processed settlements. This module never transfers money. */
function attachBusinessOperations(app, { businessAuth, db: store, adminOk, provisionTenantPayment }) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_support_tickets (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      location_id TEXT,
      subject TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_business_support_owner
      ON business_support_tickets(business_id, updated_at);
    CREATE TABLE IF NOT EXISTS business_support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      author TEXT NOT NULL CHECK(author IN ('operator','admin')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_business_support_thread
      ON business_support_messages(ticket_id, business_id, id);
    CREATE TABLE IF NOT EXISTS business_payout_requests (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      destination_type TEXT NOT NULL CHECK(destination_type IN ('mpesa','bank')),
      destination_name TEXT NOT NULL,
      destination_account TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected','cancelled')),
      external_reference TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_business_payout_owner
      ON business_payout_requests(business_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_business_payout_paid_reference
      ON business_payout_requests(external_reference) WHERE status='paid';
    CREATE TABLE IF NOT EXISTS business_payout_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payout_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      external_reference TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Old deployments recorded whole-shilling fees. New payments preserve cents.
  const hasMinorFee = db.prepare('PRAGMA table_info(tenant_transactions)').all().some(row => row.name === 'platform_fee_minor');
  const feeSql = hasMinorFee ? 'COALESCE(platform_fee_minor, CAST(ROUND(platform_fee * 100) AS INTEGER))'
    : 'CAST(ROUND(platform_fee * 100) AS INTEGER)';
  // Money Wi‑Fi Fiti collected on the tenant's behalf is owed to them: its own
  // M‑Pesa collection ('fiti') and the platform Tuma fallback ('tuma'). Direct
  // rails ('own', 'tuma_direct', 'c2b') already settled to the tenant.
  const earnedStatement = db.prepare(`SELECT COALESCE(SUM(amount * 100),0) AS gross_minor,
    COALESCE(SUM(${feeSql}),0) AS fee_minor,
    COALESCE(SUM(amount * 100 - ${feeSql}),0) AS earned_minor
    FROM tenant_transactions WHERE business_id=? AND payment_source IN ('fiti','tuma') AND status='paid'`);
  const reservedStatement = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status IN ('pending','approved') THEN amount_minor ELSE 0 END),0) AS reserved_minor,
    COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) AS paid_minor
    FROM business_payout_requests WHERE business_id=?`);
  const payoutById = db.prepare('SELECT * FROM business_payout_requests WHERE id=? AND business_id=?');
  const payoutByKey = db.prepare('SELECT * FROM business_payout_requests WHERE business_id=? AND idempotency_key=?');
  const ticketById = db.prepare(`SELECT t.*, l.name AS location_name FROM business_support_tickets t
    LEFT JOIN locations l ON l.id=t.location_id AND l.business_id=t.business_id WHERE t.id=? AND t.business_id=?`);
  const messagesForTicket = db.prepare(`SELECT id, author, body, created_at FROM business_support_messages
    WHERE ticket_id=? AND business_id=? ORDER BY id`);
  const locationOwned = db.prepare('SELECT id FROM locations WHERE id=? AND business_id=?');
  const tenantJobForRetry = db.prepare(`SELECT id FROM tenant_jobs
    WHERE location_id=? AND username=? AND acked_at IS NULL
      AND action IN ('upsert','transfer','tv-upsert')
      AND id=(SELECT MAX(newer.id) FROM tenant_jobs newer WHERE newer.location_id=tenant_jobs.location_id AND newer.username=tenant_jobs.username)
    LIMIT 1`);
  const tenantJobInsert = db.prepare(`INSERT INTO tenant_jobs
    (location_id,username,password,profile,total_seconds,rate_limit,mac,ip,action)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const billingRows = db.prepare(`SELECT t.checkout_request_id, t.plan, t.amount, t.mpesa_receipt,
    t.created_at, g.created_at AS paid_at, g.expires_at FROM business_billing_transactions t
    JOIN business_billing_grants g ON g.checkout_request_id=t.checkout_request_id AND g.business_id=t.business_id
    WHERE t.business_id=? AND t.status='paid' AND t.activated=1 ORDER BY g.created_at DESC LIMIT ? OFFSET ?`);
  const receiptRow = db.prepare(`SELECT t.checkout_request_id,t.plan,t.amount,t.mpesa_receipt,
    g.created_at AS paid_at,g.expires_at FROM business_billing_transactions t
    JOIN business_billing_grants g ON g.checkout_request_id=t.checkout_request_id AND g.business_id=t.business_id
    WHERE t.business_id=? AND t.checkout_request_id=? AND t.status='paid' AND t.activated=1`);
  const newId = prefix => `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
  const clean = (value, max) => String(value || '').trim().slice(0, max);
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  const pagination = req => ({ limit: 50, offset: Math.min(100000, Math.max(0, Math.floor(Number(req.query.offset) || 0))) });
  const ticketMessage = body => {
    const message = clean(body, 4000);
    if (!message) throw fail('Write a message before sending.');
    return message;
  };
  const atomic = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const operator = handler => (req, res) => {
    const business = businessAuth(req, res);
    if (!business) return;
    res.set('Cache-Control', 'no-store');
    try { return handler(req, res, business); }
    catch (error) {
      if (!error.status) console.error('[business operations]', error.message);
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not update these records. Please try again.' });
    }
  };
  const administrator = handler => (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Platform administrator access is required.' });
    res.set('Cache-Control', 'no-store');
    try { return handler(req, res); }
    catch (error) {
      if (!error.status) console.error('[business operations admin]', error.message);
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not update these records. Please try again.' });
    }
  };
  function balance(businessId) {
    const earned = earnedStatement.get(businessId);
    const committed = reservedStatement.get(businessId);
    const available = Number(earned.earned_minor) - Number(committed.reserved_minor) - Number(committed.paid_minor);
    return { currency: 'KES', grossMinor: Number(earned.gross_minor), feeMinor: Number(earned.fee_minor),
      earnedMinor: Number(earned.earned_minor), reservedMinor: Number(committed.reserved_minor),
      paidMinor: Number(committed.paid_minor), availableMinor: Math.max(0, available),
      processing: 'manual', note: 'Only settled Wi-Fi Fiti collection is included. Requests reserve funds for manual review. No money is transferred by this website.' };
  }
  function recordPayoutEvent(payout, action, actor, reference, note) {
    db.prepare(`INSERT INTO business_payout_events(payout_id,business_id,action,actor,external_reference,note)
      VALUES(?,?,?,?,?,?)`).run(payout.id, payout.business_id, action, actor, reference || null, note || null);
  }

  const base = '/api/business/operations';
  app.get(`${base}/customers`, operator((req, res, business) => {
    const { limit, offset } = pagination(req);
    const q = clean(req.query.q, 80);
    const search = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    const rows = db.prepare(`SELECT s.id,s.location_id,l.name AS location_name,s.payer_phone,s.mac,
      s.router_username,s.expires_at,s.used_seconds,s.is_active,s.created_at,s.updated_at,
      CASE WHEN s.expires_at>datetime('now') THEN 1 ELSE 0 END AS has_time
      FROM tenant_subscriptions s JOIN locations l ON l.id=s.location_id AND l.business_id=s.business_id
      WHERE s.business_id=? AND (?='' OR s.payer_phone LIKE ? ESCAPE '\\' OR s.mac LIKE ? ESCAPE '\\' OR s.router_username LIKE ? ESCAPE '\\')
      ORDER BY s.updated_at DESC,s.id LIMIT ? OFFSET ?`).all(business.id, q, search, search, search, limit + 1, offset);
    res.json({ customers: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null });
  }));

  app.get(`${base}/customers/:subscriptionId`, operator((req, res, business) => {
    const subscription = db.prepare(`SELECT s.id,s.location_id,l.name AS location_name,s.payer_phone,s.mac,
      s.router_username,s.device_type,s.device_label,s.expires_at,s.total_seconds,s.rate_limit,s.used_seconds,s.is_active,s.created_at,s.updated_at
      FROM tenant_subscriptions s JOIN locations l ON l.id=s.location_id AND l.business_id=s.business_id
      WHERE s.id=? AND s.business_id=?`).get(req.params.subscriptionId, business.id);
    if (!subscription) throw fail('Customer not found.', 404);
    const history = db.prepare(`SELECT checkout_request_id,package_name,amount,rate_limit,status,mpesa_receipt,payment_source,
      provisioned,created_at,updated_at FROM tenant_transactions WHERE business_id=? AND location_id=?
      AND (subscription_id=? OR (subscription_id IS NULL AND mac=? AND phone=?)) ORDER BY created_at DESC LIMIT 100`)
      .all(business.id, subscription.location_id, subscription.id, subscription.mac, subscription.payer_phone);
    const devices = db.prepare(`SELECT d.mac,d.label,d.created_at FROM tenant_devices d JOIN tenant_subscriptions s
      ON s.id=d.subscription_id AND s.location_id=d.location_id WHERE s.business_id=? AND s.id=?`)
      .all(business.id, subscription.id);
    const vouchers = db.prepare(`SELECT package_name,seconds,rate_limit,redeemed_at,batch FROM tenant_vouchers
      WHERE business_id=? AND location_id=? AND redeemed_subscription_id=? ORDER BY redeemed_at DESC LIMIT 100`)
      .all(business.id, subscription.location_id, subscription.id);
    // Sessions the router reported: when they were online, for how long,
    // how much data, and whether they are online now.
    const activity = require('./hotspot-sessions').historyForSubscription(subscription.id, business.id, 50);
    const accessCodes = team.can(req, 'customers.edit') ? {
      connectionCode: subscription.router_username,
      recoveryCode: db.prepare('SELECT password FROM tenant_subscriptions WHERE id=? AND business_id=?')
        .get(subscription.id, business.id)?.password || null,
    } : null;
    res.json({ subscription, history, devices, vouchers, activity, accessCodes });
  }));

  // Support hub: one box finds a customer by phone, voucher code or M-Pesa
  // code. Every query is pinned to the signed-in business and capped.
  const SUPPORT_RESULTS = 20;
  const secondsLeft = `CASE WHEN s.expires_at>datetime('now') AND s.mac NOT LIKE 'RELEASED:%'
    THEN CAST(ROUND((julianday(s.expires_at)-julianday('now'))*86400) AS INTEGER) ELSE 0 END`;
  const supportPayments = db.prepare(`SELECT t.checkout_request_id,t.phone,t.mac,t.package_name,t.amount,t.status,
      t.mpesa_receipt,t.payment_source,t.created_at,l.name AS location_name,j.acked_at AS switched_on_at,
      ${secondsLeft} AS seconds_left
    FROM tenant_transactions t JOIN locations l ON l.id=t.location_id AND l.business_id=t.business_id
    LEFT JOIN tenant_jobs j ON j.id=t.provisioning_job_id AND j.location_id=t.location_id
    LEFT JOIN tenant_subscriptions s ON s.id=t.subscription_id AND s.business_id=t.business_id
    WHERE t.business_id=? AND (t.mpesa_receipt=? OR t.checkout_request_id=? OR (?<>'' AND t.phone LIKE '%'||?))
    ORDER BY t.created_at DESC LIMIT ?`);
  const supportVouchers = db.prepare(`SELECT v.code,v.package_name,v.seconds,v.batch,v.created_at,v.redeemed_at,v.redeemed_by,
      v.paused_seconds,l.name AS location_name,
      CASE WHEN v.redeemed_at IS NULL AND v.paused_at IS NOT NULL THEN 'paused'
           WHEN v.redeemed_at IS NULL THEN 'open'
           WHEN v.paused_at IS NOT NULL THEN 'session_paused'
           WHEN s.expires_at>datetime('now') AND s.mac NOT LIKE 'RELEASED:%' THEN 'active'
           ELSE 'used' END AS status,
      ${secondsLeft} AS seconds_left
    FROM tenant_vouchers v JOIN locations l ON l.id=v.location_id AND l.business_id=v.business_id
    LEFT JOIN tenant_subscriptions s ON s.id=v.redeemed_subscription_id AND s.location_id=v.location_id
    WHERE v.business_id=? AND (v.code=? OR v.code='FITI'||? OR (?<>'' AND v.redeemed_by LIKE '%'||?))
    ORDER BY COALESCE(v.redeemed_at,v.created_at) DESC LIMIT ?`);
  const supportCustomers = db.prepare(`SELECT s.id,s.payer_phone,s.mac,s.expires_at,s.is_active,s.updated_at,l.name AS location_name,
      (SELECT t.package_name FROM tenant_transactions t WHERE t.business_id=s.business_id AND t.subscription_id=s.id
        ORDER BY t.created_at DESC LIMIT 1) AS package_name,
      ${secondsLeft} AS seconds_left
    FROM tenant_subscriptions s JOIN locations l ON l.id=s.location_id AND l.business_id=s.business_id
    WHERE s.business_id=? AND ?<>'' AND s.payer_phone LIKE '%'||? AND s.mac NOT LIKE 'RELEASED:%'
      AND s.mac NOT LIKE 'CLAIM:%' AND s.mac NOT LIKE 'C2B:%'
    ORDER BY s.updated_at DESC LIMIT ?`);
  function supportQuery(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (text.length < 3 || text.length > 40 || !/^[A-Za-z0-9 +()._-]+$/.test(text)) {
      throw fail('Enter a phone number, voucher code or M-Pesa code (3 to 40 letters or digits).');
    }
    const digits = text.replace(/[\s+()-]/g, '');
    // 07…, 7…, 2547… and +254 7… are the same number: match its last 9
    // digits. 4 to 8 digits match the end of a number (the dashboard shows
    // the last 4).
    const phone = /^\d{4,15}$/.test(digits) ? digits.slice(-9) : '';
    return { text, code: text.replace(/\s+/g, '').toUpperCase(), phone };
  }
  app.get('/api/business/support/search', operator((req, res, business) => {
    const { text, code, phone } = supportQuery(req.query.q);
    const capped = rows => ({ rows: rows.slice(0, SUPPORT_RESULTS), more: rows.length > SUPPORT_RESULTS });
    const payments = capped(supportPayments.all(business.id, code, text, phone, phone, SUPPORT_RESULTS + 1));
    const vouchers = capped(supportVouchers.all(business.id, code, code, phone, phone, SUPPORT_RESULTS + 1));
    const customers = capped(supportCustomers.all(business.id, phone, phone, SUPPORT_RESULTS + 1));
    res.json({ query: text, customers: customers.rows, payments: payments.rows, vouchers: vouchers.rows,
      more: payments.more || vouchers.more || customers.more, limit: SUPPORT_RESULTS });
  }));
  // Support numbers from the last 7 days of paid customers. "Switched on"
  // means the router confirmed the customer's login.
  const supportPaidWeek = db.prepare(`SELECT COUNT(*) AS paid,
      COALESCE(SUM(CASE WHEN j.acked_at IS NOT NULL THEN 1 ELSE 0 END),0) AS switched_on,
      AVG(CASE WHEN j.acked_at IS NOT NULL THEN MAX(0,(julianday(j.acked_at)-julianday(j.created_at))*86400) END) AS average_seconds
    FROM tenant_transactions t LEFT JOIN tenant_jobs j ON j.id=t.provisioning_job_id AND j.location_id=t.location_id
    WHERE t.business_id=? AND t.status='paid' AND t.created_at>=datetime('now','-7 days')`);
  // "Today" is the Kenyan day (UTC+3, no daylight saving).
  const supportEndedToday = db.prepare(`SELECT COUNT(*) AS n FROM tenant_subscriptions
    WHERE business_id=? AND mac NOT LIKE 'RELEASED:%' AND expires_at<=datetime('now')
      AND expires_at>=datetime('now','+3 hours','start of day','-3 hours')`);
  app.get('/api/business/support/summary', operator((req, res, business) => {
    const week = supportPaidWeek.get(business.id);
    const paid = Number(week.paid || 0); const switchedOn = Number(week.switched_on || 0);
    res.json({ days: 7, paid, switchedOn, notSwitchedOn: paid - switchedOn,
      averageSwitchOnSeconds: week.average_seconds == null ? null : Math.round(Number(week.average_seconds)),
      endedToday: Number(supportEndedToday.get(business.id).n || 0) });
  }));

  // A confirmed customer payment can be safely retried by the tenant. This
  // only requeues the existing package grant; it never creates a new charge.
  app.post(`${base}/transactions/:checkoutRequestId/retry`, operator((req, res, business) => {
    const transaction = db.prepare(`SELECT * FROM tenant_transactions
      WHERE checkout_request_id=? AND business_id=? AND status='paid'`).get(req.params.checkoutRequestId, business.id);
    if (!transaction) throw fail('Confirmed customer payment not found.', 404);
    if (typeof provisionTenantPayment !== 'function') throw fail('Payment recovery is temporarily unavailable.', 503);
    // The owner is retrying on purpose, e.g. after the other package ended.
    db.prepare('UPDATE tenant_transactions SET provision_error=NULL WHERE checkout_request_id=?').run(transaction.checkout_request_id);
    let provisioned;
    try { provisioned = provisionTenantPayment(transaction.checkout_request_id) || transaction; }
    catch (error) {
      if (error.code !== 'device_taken') throw error;
      db.prepare('UPDATE tenant_transactions SET provision_error=? WHERE checkout_request_id=?').run(error.message, transaction.checkout_request_id);
      throw fail('This device still has a live package bought with another number, so this payment cannot be switched on yet. Refund the customer, or retry when that package ends.', 409);
    }
    const current = db.prepare('SELECT * FROM tenant_transactions WHERE checkout_request_id=?').get(transaction.checkout_request_id);
    const subscription = current && current.subscription_id
      ? db.prepare('SELECT * FROM tenant_subscriptions WHERE id=? AND business_id=?').get(current.subscription_id, business.id)
      : null;
    if (!subscription) throw fail('The payment is confirmed but its package grant is incomplete. Try again shortly.', 409);
    let job = tenantJobForRetry.get(subscription.location_id, subscription.router_username);
    if (!job) {
      const result = tenantJobInsert.run(subscription.location_id, subscription.router_username, subscription.password,
        'standard', subscription.total_seconds, subscription.rate_limit || null, subscription.mac, null,
        subscription.device_type === 'tv' ? 'tv-upsert' : 'upsert');
      job = { id: Number(result.lastInsertRowid) };
    }
    res.json({ ok: true, recovered: true, transaction: current || provisioned, provisioningJobId: Number(job.id) });
  }));

  app.get(`${base}/tickets`, operator((req, res, business) => {
    const { limit, offset } = pagination(req);
    const rows = db.prepare(`SELECT t.*,l.name AS location_name FROM business_support_tickets t
      LEFT JOIN locations l ON l.id=t.location_id AND l.business_id=t.business_id
      WHERE t.business_id=? ORDER BY t.updated_at DESC,t.id LIMIT ? OFFSET ?`).all(business.id, limit + 1, offset);
    res.json({ tickets: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null });
  }));
  app.post(`${base}/tickets`, operator((req, res, business) => {
    const body = req.body || {};
    const subject = clean(body.subject, 120);
    const category = clean(body.category, 24);
    const message = ticketMessage(body.message);
    const locationId = clean(body.locationId, 80) || null;
    if (subject.length < 3 || !['payment','connection','router','billing','other'].includes(category)) throw fail('Enter a subject and choose a support category.');
    if (locationId && !locationOwned.get(locationId, business.id)) throw fail('Location not found.', 404);
    const ticket = atomic(() => {
      const id = newId('ticket');
      db.prepare(`INSERT INTO business_support_tickets(id,business_id,location_id,subject,category) VALUES(?,?,?,?,?)`)
        .run(id, business.id, locationId, subject, category);
      db.prepare(`INSERT INTO business_support_messages(ticket_id,business_id,author,body) VALUES(?,?,'operator',?)`).run(id, business.id, message);
      return ticketById.get(id, business.id);
    });
    res.status(201).json({ ticket });
  }));
  app.get(`${base}/tickets/:ticketId`, operator((req, res, business) => {
    const ticket = ticketById.get(req.params.ticketId, business.id);
    if (!ticket) throw fail('Ticket not found.', 404);
    res.json({ ticket, messages: messagesForTicket.all(ticket.id, business.id) });
  }));
  app.post(`${base}/tickets/:ticketId/messages`, operator((req, res, business) => {
    const ticket = ticketById.get(req.params.ticketId, business.id);
    if (!ticket) throw fail('Ticket not found.', 404);
    const message = ticketMessage(req.body && req.body.message);
    atomic(() => {
      db.prepare(`INSERT INTO business_support_messages(ticket_id,business_id,author,body) VALUES(?,?,'operator',?)`).run(ticket.id, business.id, message);
      db.prepare(`UPDATE business_support_tickets SET status='open',updated_at=datetime('now') WHERE id=? AND business_id=?`).run(ticket.id, business.id);
    });
    res.status(201).json({ ticket: ticketById.get(ticket.id, business.id), messages: messagesForTicket.all(ticket.id, business.id) });
  }));

  app.get(`${base}/billing`, operator((req, res, business) => {
    const { limit, offset } = pagination(req);
    const rows = billingRows.all(business.id, limit + 1, offset);
    res.json({ records: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null,
      note: 'Confirmed subscription payment receipts. These records are not statutory tax invoices.' });
  }));
  app.get(`${base}/billing/:checkoutRequestId/receipt`, operator((req, res, business) => {
    const receipt = receiptRow.get(business.id, req.params.checkoutRequestId);
    if (!receipt) throw fail('Confirmed payment receipt not found.', 404);
    const oneLine = value => String(value || '').replace(/[\r\n\t]/g, ' ');
    const lines = ['Wi-Fi Fiti — subscription payment receipt', '', 'Not a statutory tax invoice.', '',
      `Business: ${oneLine(business.name)}`, `Business ID: ${oneLine(business.id)}`,
      `Receipt: ${oneLine(receipt.checkout_request_id)}`, `M-Pesa reference: ${oneLine(receipt.mpesa_receipt || 'Confirmed by payment status query')}`,
      `Plan: ${oneLine(receipt.plan)}`, `Amount paid: KES ${Number(receipt.amount).toFixed(2)}`,
      `Recorded at: ${receipt.paid_at} UTC`, `Subscription valid until: ${receipt.expires_at} UTC`, '',
      'This acknowledges the confirmed platform subscription payment shown above.'];
    res.set('Content-Disposition', 'attachment; filename="wifi-fiti-payment-receipt.txt"');
    res.type('text/plain').send(lines.join('\n'));
  }));

  app.get(`${base}/payouts`, operator((req, res, business) => {
    const { limit, offset } = pagination(req);
    const rows = db.prepare('SELECT * FROM business_payout_requests WHERE business_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
      .all(business.id, limit + 1, offset);
    res.json({ balance: balance(business.id), payouts: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null });
  }));
  app.post(`${base}/payouts`, operator((req, res, business) => {
    const body = req.body || {};
    const amount = body.amountMinor;
    const key = clean(body.idempotencyKey, 100);
    const destinationType = clean(body.destinationType, 10);
    const destinationName = clean(body.destinationName, 100);
    const destinationAccount = clean(body.destinationAccount, 100);
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000000) throw fail('Enter a payout amount of at least KES 1.00.');
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw fail('This request needs a valid unique submission key. Refresh and try again.');
    if (!['mpesa','bank'].includes(destinationType) || destinationName.length < 2 || destinationAccount.length < 5 || /[\x00-\x1f]/.test(destinationName + destinationAccount)) {
      throw fail('Enter the recipient name and complete M-Pesa number or bank account details.');
    }
    let reused = false;
    const payout = atomic(() => {
      const prior = payoutByKey.get(business.id, key);
      if (prior) {
        if (prior.amount_minor !== amount || prior.destination_type !== destinationType || prior.destination_name !== destinationName || prior.destination_account !== destinationAccount) {
          throw fail('This submission key already belongs to a different request.', 409);
        }
        reused = true;
        return prior;
      }
      if (amount > balance(business.id).availableMinor) throw fail('The amount exceeds your available Wi-Fi Fiti collection balance.', 409);
      const id = newId('payout');
      db.prepare(`INSERT INTO business_payout_requests(id,business_id,idempotency_key,amount_minor,destination_type,destination_name,destination_account)
        VALUES(?,?,?,?,?,?,?)`).run(id, business.id, key, amount, destinationType, destinationName, destinationAccount);
      const saved = payoutById.get(id, business.id);
      recordPayoutEvent(saved, 'requested', 'operator', null, null);
      return saved;
    });
    res.status(reused ? 200 : 201).json({ payout, balance: balance(business.id) });
  }));
  app.post(`${base}/payouts/:payoutId/cancel`, operator((req, res, business) => {
    const payout = atomic(() => {
      const existing = payoutById.get(req.params.payoutId, business.id);
      if (!existing) throw fail('Payout request not found.', 404);
      if (existing.status === 'cancelled') return existing;
      if (existing.status !== 'pending') throw fail('Only requests still awaiting review can be cancelled.', 409);
      db.prepare(`UPDATE business_payout_requests SET status='cancelled',updated_at=datetime('now') WHERE id=? AND business_id=?`).run(existing.id, business.id);
      recordPayoutEvent(existing, 'cancelled', 'operator', null, null);
      return payoutById.get(existing.id, business.id);
    });
    res.json({ payout, balance: balance(business.id) });
  }));
  app.get(`${base}/payouts/:payoutId`, operator((req, res, business) => {
    const payout = payoutById.get(req.params.payoutId, business.id);
    if (!payout) throw fail('Payout request not found.', 404);
    const events = db.prepare(`SELECT action,actor,external_reference,note,created_at FROM business_payout_events WHERE payout_id=? AND business_id=? ORDER BY id`).all(payout.id, business.id);
    res.json({ payout, events });
  }));

  const adminBase = '/api/admin/business-operations';
  app.get(`${adminBase}/tickets`, administrator((req, res) => {
    const { limit, offset } = pagination(req);
    const rows = db.prepare(`SELECT t.*,b.name AS business_name,l.name AS location_name FROM business_support_tickets t
      JOIN businesses b ON b.id=t.business_id
      LEFT JOIN locations l ON l.id=t.location_id AND l.business_id=t.business_id
      ORDER BY t.updated_at DESC,t.id LIMIT ? OFFSET ?`).all(limit + 1, offset);
    res.json({ tickets: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null });
  }));
  app.get(`${adminBase}/tickets/:ticketId`, administrator((req, res) => {
    const ticket = db.prepare(`SELECT t.*,b.name AS business_name,l.name AS location_name FROM business_support_tickets t
      JOIN businesses b ON b.id=t.business_id
      LEFT JOIN locations l ON l.id=t.location_id AND l.business_id=t.business_id
      WHERE t.id=?`).get(req.params.ticketId);
    if (!ticket) throw fail('Ticket not found.', 404);
    res.json({ ticket, messages: messagesForTicket.all(ticket.id, ticket.business_id) });
  }));
  app.post(`${adminBase}/tickets/:ticketId/messages`, administrator((req, res) => {
    const ticket = db.prepare('SELECT * FROM business_support_tickets WHERE id=?').get(req.params.ticketId);
    if (!ticket) throw fail('Ticket not found.', 404);
    const message = ticketMessage(req.body && req.body.message);
    const status = clean(req.body && req.body.status, 20) || 'in_progress';
    if (!['open','in_progress','resolved'].includes(status)) throw fail('Choose a valid support status.');
    atomic(() => {
      db.prepare(`INSERT INTO business_support_messages(ticket_id,business_id,author,body) VALUES(?,?,'admin',?)`).run(ticket.id, ticket.business_id, message);
      db.prepare(`UPDATE business_support_tickets SET status=?,updated_at=datetime('now') WHERE id=? AND business_id=?`).run(status, ticket.id, ticket.business_id);
    });
    res.status(201).json({ ticket: ticketById.get(ticket.id, ticket.business_id), messages: messagesForTicket.all(ticket.id, ticket.business_id) });
  }));
  app.get(`${adminBase}/payouts`, administrator((req, res) => {
    const { limit, offset } = pagination(req);
    const rows = db.prepare(`SELECT p.*,b.name AS business_name FROM business_payout_requests p
      JOIN businesses b ON b.id=p.business_id ORDER BY p.created_at DESC,p.id LIMIT ? OFFSET ?`).all(limit + 1, offset);
    res.json({ payouts: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null,
      note: 'Manual settlement records only. This application does not send funds.' });
  }));
  app.get(`${adminBase}/payouts/:payoutId`, administrator((req, res) => {
    const payout = db.prepare(`SELECT p.*,b.name AS business_name FROM business_payout_requests p
      JOIN businesses b ON b.id=p.business_id WHERE p.id=?`).get(req.params.payoutId);
    if (!payout) throw fail('Payout request not found.', 404);
    const events = db.prepare(`SELECT action,actor,external_reference,note,created_at FROM business_payout_events
      WHERE payout_id=? AND business_id=? ORDER BY id`).all(payout.id, payout.business_id);
    res.json({ payout, events, balance: balance(payout.business_id) });
  }));
  app.post(`${adminBase}/payouts/:payoutId/status`, administrator((req, res) => {
    const body = req.body || {};
    const status = clean(body.status, 20);
    const reference = clean(body.externalReference, 100).toUpperCase();
    const note = clean(body.note, 1000);
    if (!['approved','paid','rejected'].includes(status)) throw fail('Choose approve, record paid, or reject.');
    if (['approved','paid'].includes(status) && !/^[A-Z0-9][A-Z0-9 ._/-]{3,99}$/.test(reference)) {
      throw fail(status === 'paid' ? 'Record the external payment reference before marking this request paid.' : 'Record an external review or payment reference before approving this request.');
    }
    if (status === 'rejected' && !note) throw fail('Explain why this request was rejected.');
    const payout = atomic(() => {
      const existing = db.prepare('SELECT * FROM business_payout_requests WHERE id=?').get(req.params.payoutId);
      if (!existing) throw fail('Payout request not found.', 404);
      if (existing.status === status) {
        if ((status === 'paid' || status === 'approved') && existing.external_reference !== reference) throw fail('This status was already recorded with a different reference.', 409);
        return existing;
      }
      const allowed = existing.status === 'pending' ? ['approved','rejected'] : existing.status === 'approved' ? ['paid','rejected'] : [];
      if (!allowed.includes(status)) throw fail('This payout cannot move to that status.', 409);
      if (status === 'paid' && db.prepare(`SELECT id FROM business_payout_requests WHERE status='paid' AND external_reference=? AND id!=?`).get(reference, existing.id)) {
        throw fail('That external payment reference has already been used for another payout.', 409);
      }
      db.prepare(`UPDATE business_payout_requests SET status=?,external_reference=?,note=?,updated_at=datetime('now') WHERE id=? AND business_id=?`)
        .run(status, reference || null, note || null, existing.id, existing.business_id);
      recordPayoutEvent(existing, status, 'admin', reference, note);
      return payoutById.get(existing.id, existing.business_id);
    });
    res.json({ payout, note: 'Recorded only. No funds were transferred by this application.' });
  }));
  return { balance };
}

module.exports = { attachBusinessOperations };

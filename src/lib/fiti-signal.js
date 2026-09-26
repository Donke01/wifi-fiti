/**
 * FitiSignal: tenant-scoped SMS and notification primitives.
 *
 * This module deliberately has no router or captive-portal dependencies.  It
 * owns prepaid SMS credits, notification cost controls, and a small provider
 * adapter boundary so a provider can be replaced without changing callers.
 */
const crypto = require('node:crypto');
const { db } = require('./db');

const PACKAGES = Object.freeze([
  { id: 'sms-500', amount: 500, credits: 500 },
  { id: 'sms-700', amount: 700, credits: 700 },
  { id: 'sms-1000', amount: 1000, credits: 1000 },
  { id: 'sms-2000', amount: 2000, credits: 2000 },
]);

const SERVICE_CATALOGUE = Object.freeze({
  payment_confirmation: { label: 'Payment confirmation', essential: true },
  package_activation: { label: 'Package activation and connection details', essential: true },
  receipt_link: { label: 'Receipt and portal link', essential: false },
  expiry_reminder: { label: 'Package expiry reminder', essential: false },
  package_expired: { label: 'Package expired notice', essential: false },
  payment_failed: { label: 'Failed payment', essential: true },
  payment_reversed: { label: 'Reversed or refunded payment', essential: true },
  tv_activation: { label: 'TV package confirmation', essential: false },
  voucher_redeemed: { label: 'Voucher redemption confirmation', essential: false },
  router_paired: { label: 'Router paired', essential: false },
  router_offline: { label: 'Router offline', essential: false },
  router_restored: { label: 'Router restored', essential: false },
  polling_failure: { label: 'Polling failure', essential: false },
  portal_setup: { label: 'Portal setup completed', essential: false },
  tenant_payment: { label: 'New payment received', essential: false },
  sales_summary: { label: 'Sales summary', essential: false },
  sms_balance_low: { label: 'Low SMS-credit balance', essential: true },
  sms_package_activated: { label: 'SMS package activated', essential: true },
  subscription_expiry: { label: 'Platform subscription expiry', essential: false },
  support_update: { label: 'Support-ticket update', essential: false },
  critical_alert: { label: 'Critical service alert', essential: true },
});

const DEFAULT_COST_CONTROLS = Object.freeze({
  combineMessages: true,
  expiryReminderHours: 24,
  routerAlertDelayMinutes: 15,
  confirmedEventsOnly: true,
  gsmOnly: true,
  optionalOptOut: true,
  deduplicateEvents: true,
  dailyLimit: null,
  monthlyLimit: null,
  maxPerCustomer: null,
});

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
function businessId(value) {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) throw new Error('Invalid business ID.');
  return result;
}
function phone(value) {
  const result = String(value || '').replace(/[\s().-]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(result)) throw new Error('Invalid recipient phone number.');
  return result.startsWith('+') ? result : `+${result}`;
}

// GSM-03.38 characters are intentionally conservative; unsupported Unicode
// is replaced before charging so a tenant cannot accidentally buy 3 segments.
const GSM_BASIC = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\f^{}\\\[~\]|€ !"#¤%&'()*+,\-.\/:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà0-9]*$/;
function gsmSafe(value) {
  return String(value || '').normalize('NFKC').replace(/[^\x00-\x7F£€ÄÖÑÜäöñüàÇèéùìòÅåØøΔΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-.\/:;<=>?¡¿@\n\r ]/g, '');
}
function segmentCount(message) {
  const text = String(message || '');
  if (!text.length) throw new Error('SMS message cannot be empty.');
  if (GSM_BASIC.test(text) && text.length <= 160) return 1;
  if (GSM_BASIC.test(text)) return Math.ceil(text.length / 153);
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}

class SmsProvider {
  async send() { throw new Error('SMS provider is not configured.'); }
}

/** Africa's Talking SMS adapter. Sandbox and live use the same payload and
 * response contract; only the hostname and credentials differ. The API key
 * is read from the process environment by the factory and is never returned
 * through tenant or admin responses. */
class AfricaTalkingSmsProvider extends SmsProvider {
  constructor({ username = 'sandbox', apiKey, senderId = '', environment = 'sandbox', timeoutMs = 10000 } = {}) {
    super();
    if (!String(apiKey || '').trim()) throw new Error('Africa\'s Talking API key is required.');
    this.username = String(username || 'sandbox').trim();
    this.apiKey = String(apiKey).trim();
    this.senderId = String(senderId || '').trim();
    this.environment = String(environment || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(timeoutMs) || 10000));
  }

  async send({ to, message }) {
    const endpoint = this.environment === 'production'
      ? 'https://api.africastalking.com/version1/messaging'
      : 'https://api.sandbox.africastalking.com/version1/messaging';
    const body = new URLSearchParams({ username: this.username, to: String(to), message: String(message) });
    if (this.senderId) body.set('from', this.senderId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { apiKey: this.apiKey, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? 'Africa\'s Talking request timed out.' : `Africa\'s Talking request failed: ${error.message}`);
    } finally { clearTimeout(timer); }
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) { payload = { raw }; }
    if (!response.ok) throw new Error(`Africa\'s Talking returned HTTP ${response.status}.`);
    const recipient = payload?.SMSMessageData?.Recipients?.[0];
    if (!recipient || String(recipient.statusCode || '') !== '100') {
      throw new Error(recipient?.status || payload?.SMSMessageData?.Message || 'Africa\'s Talking rejected the SMS.');
    }
    return { id: recipient.messageId || recipient.message_id || null, status: recipient.status, cost: recipient.cost || null };
  }
}

class FunctionSmsProvider extends SmsProvider {
  constructor(sender) {
    super();
    if (typeof sender !== 'function') throw new TypeError('SMS provider sender must be a function.');
    this.sender = sender;
  }
  send(payload) { return this.sender(payload); }
}

function createProvider(sender) { return new FunctionSmsProvider(sender); }

function createAfricaTalkingProviderFromEnv(env = process.env) {
  const apiKey = String(env.AFRICASTALKING_API_KEY || '').trim();
  if (!apiKey) return null;
  return new AfricaTalkingSmsProvider({
    username: env.AFRICASTALKING_USERNAME || 'sandbox',
    apiKey,
    senderId: env.AFRICASTALKING_SENDER_ID || '',
    environment: env.AFRICASTALKING_ENV || 'sandbox',
  });
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiti_signal_accounts (
      business_id TEXT PRIMARY KEY REFERENCES businesses(id),
      credits_available INTEGER NOT NULL DEFAULT 0,
      credits_reserved INTEGER NOT NULL DEFAULT 0,
      credits_used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fiti_signal_packages (
      id TEXT PRIMARY KEY, amount INTEGER NOT NULL, credits INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS fiti_signal_purchases (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL, package_id TEXT,
      amount INTEGER NOT NULL, credits INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      payment_ref TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fiti_signal_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, business_id TEXT NOT NULL, delta INTEGER NOT NULL,
      kind TEXT NOT NULL, reference TEXT, metadata_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fiti_signal_ledger_business ON fiti_signal_ledger(business_id, created_at);
    CREATE TABLE IF NOT EXISTS fiti_signal_settings (
      business_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fiti_signal_services (
      business_id TEXT NOT NULL, service_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (business_id, service_key)
    );
    CREATE TABLE IF NOT EXISTS fiti_signal_messages (
      id TEXT PRIMARY KEY, business_id TEXT NOT NULL, event_id TEXT NOT NULL,
      service_key TEXT NOT NULL, recipient TEXT NOT NULL, message TEXT NOT NULL,
      segments INTEGER NOT NULL, essential INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (business_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fiti_signal_messages_queue ON fiti_signal_messages(status, created_at);
  `);
  // Messages sent free during a 7-day trial never touch purchased credits.
  try { db.exec(`ALTER TABLE fiti_signal_messages ADD COLUMN trial INTEGER NOT NULL DEFAULT 0`); } catch (_) { /* present */ }
  const insert = db.prepare(`INSERT OR IGNORE INTO fiti_signal_packages (id, amount, credits) VALUES (?, ?, ?)`);
  for (const item of PACKAGES) insert.run(item.id, item.amount, item.credits);
}
init();

function accountFor(business) {
  const b = businessId(business);
  db.prepare(`INSERT OR IGNORE INTO fiti_signal_accounts (business_id) VALUES (?)`).run(b);
  return db.prepare(`SELECT * FROM fiti_signal_accounts WHERE business_id = ?`).get(b);
}

function ledger(business, delta, kind, reference, metadata) {
  db.prepare(`INSERT INTO fiti_signal_ledger (business_id, delta, kind, reference, metadata_json) VALUES (?, ?, ?, ?, ?)`)
    .run(business, delta, kind, reference || null, metadata ? JSON.stringify(metadata) : null);
}

function packages() { return db.prepare(`SELECT id, amount, credits, active FROM fiti_signal_packages WHERE active=1 ORDER BY amount`).all(); }
function balance(business) { return accountFor(business); }

function createPurchase({ businessId: business, packageId, amount }) {
  const b = businessId(business);
  const selected = packageId && db.prepare(`SELECT * FROM fiti_signal_packages WHERE id=? AND active=1`).get(packageId);
  const value = amount === undefined ? selected?.amount : Number(amount);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('SMS purchase amount must be a positive whole number.');
  if (selected && value !== selected.amount) throw new Error('SMS package amount does not match.');
  return db.prepare(`INSERT INTO fiti_signal_purchases (id,business_id,package_id,amount,credits) VALUES (?,?,?,?,?) RETURNING *`)
    .get(id('smspay'), b, selected?.id || null, value, selected?.credits || value);
}

function completePurchase({ purchaseId, paymentRef }) {
  const ref = String(paymentRef || '').trim();
  if (!ref) throw new Error('Payment reference is required.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const purchase = db.prepare(`SELECT * FROM fiti_signal_purchases WHERE id=?`).get(purchaseId);
    if (!purchase) throw new Error('SMS purchase was not found.');
    if (purchase.status === 'paid') { db.exec('COMMIT'); return { ...purchase, duplicate: true }; }
    const collision = db.prepare(`SELECT id FROM fiti_signal_purchases WHERE payment_ref=? AND status='paid'`).get(ref);
    if (collision) throw new Error('Payment reference was already used.');
    db.prepare(`UPDATE fiti_signal_purchases SET status='paid',payment_ref=?,completed_at=datetime('now') WHERE id=?`).run(ref, purchaseId);
    accountFor(purchase.business_id);
    db.prepare(`UPDATE fiti_signal_accounts SET credits_available=credits_available+?,updated_at=datetime('now') WHERE business_id=?`).run(purchase.credits, purchase.business_id);
    ledger(purchase.business_id, purchase.credits, 'purchase', purchase.id, { amount: purchase.amount, paymentRef: ref });
    const result = db.prepare(`SELECT * FROM fiti_signal_purchases WHERE id=?`).get(purchaseId);
    db.exec('COMMIT'); return result;
  } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
}

function getSettings(business) {
  const b = businessId(business);
  const row = db.prepare(`SELECT settings_json FROM fiti_signal_settings WHERE business_id=?`).get(b);
  return { ...DEFAULT_COST_CONTROLS, ...(row ? JSON.parse(row.settings_json) : {}) };
}
function getServices(business) {
  const b = businessId(business);
  return Object.fromEntries(db.prepare('SELECT service_key, enabled FROM fiti_signal_services WHERE business_id=?').all(b).map(row => [row.service_key, Boolean(row.enabled)]));
}
function setServices(business, services) {
  const b = businessId(business);
  if (!services || typeof services !== 'object') return getServices(b);
  const statement = db.prepare(`INSERT INTO fiti_signal_services (business_id,service_key,enabled,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(business_id,service_key) DO UPDATE SET enabled=excluded.enabled,updated_at=datetime('now')`);
  for (const [key, enabled] of Object.entries(services)) if (SERVICE_CATALOGUE[key]) statement.run(b, key, enabled ? 1 : 0);
  return getServices(b);
}
function setSettings(business, patch) {
  const b = businessId(business);
  const current = getSettings(b);
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_COST_CONTROLS)) if (patch && patch[key] !== undefined) next[key] = patch[key];
  for (const key of ['expiryReminderHours', 'routerAlertDelayMinutes', 'dailyLimit', 'monthlyLimit', 'maxPerCustomer']) {
    if (next[key] !== null && (!Number.isSafeInteger(Number(next[key])) || Number(next[key]) < 0)) throw new Error(`Invalid cost control: ${key}.`);
    if (next[key] !== null) next[key] = Number(next[key]);
  }
  db.prepare(`INSERT INTO fiti_signal_settings (business_id,settings_json) VALUES (?,?) ON CONFLICT(business_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=datetime('now')`).run(b, JSON.stringify(next));
  return next;
}

const TRIAL_SMS_SEGMENTS = 300;

function onTrial(businessIdValue) {
  try {
    const row = db.prepare('SELECT billing_status, billing_expires_at FROM businesses WHERE id=?').get(businessIdValue);
    if (!row || String(row.billing_status || '').toLowerCase() !== 'trial' || !row.billing_expires_at) return false;
    const raw = String(row.billing_expires_at);
    const ends = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
    return Number.isFinite(ends) && ends > Date.now();
  } catch (_) { return false; }
}

function enqueue({ businessId: business, eventId, serviceKey, to, message, essential, confirmed = true, provider = null }) {
  const b = businessId(business);
  const service = SERVICE_CATALOGUE[serviceKey];
  if (!service) throw new Error('Unknown SMS service.');
  const event = String(eventId || '').trim();
  if (!event || event.length > 180) throw new Error('A stable event ID is required.');
  const recipient = phone(to);
  const controls = getSettings(b);
  const existing = db.prepare(`SELECT * FROM fiti_signal_messages WHERE business_id=? AND event_id=?`).get(b, event);
  if (existing && controls.deduplicateEvents) return { ...existing, duplicate: true };
  if (controls.confirmedEventsOnly && !confirmed) return { queued: false, skipped: true, reason: 'unconfirmed-event' };
  const safeText = controls.gsmOnly ? gsmSafe(message) : String(message || '');
  const segments = segmentCount(safeText);
  const essentialFlag = essential === undefined ? service.essential : Boolean(essential);
  const sentInWindow = (modifier) => db.prepare(`
    SELECT COALESCE(SUM(segments), 0) AS n FROM fiti_signal_messages
     WHERE business_id=? AND status IN ('queued','sent') AND ${modifier}
  `).get(b);
  if (controls.dailyLimit !== null && Number(sentInWindow("created_at >= datetime('now','start of day')").n) + segments > controls.dailyLimit) {
    return { queued: false, skipped: true, reason: 'daily-limit', limit: controls.dailyLimit };
  }
  if (controls.monthlyLimit !== null && Number(sentInWindow("created_at >= datetime('now','start of month')").n) + segments > controls.monthlyLimit) {
    return { queued: false, skipped: true, reason: 'monthly-limit', limit: controls.monthlyLimit };
  }
  if (controls.maxPerCustomer !== null) {
    const customer = db.prepare(`SELECT COALESCE(SUM(segments),0) AS n FROM fiti_signal_messages WHERE business_id=? AND recipient=? AND status IN ('queued','sent')`).get(b, recipient);
    if (Number(customer.n) + segments > controls.maxPerCustomer) return { queued: false, skipped: true, reason: 'customer-limit', limit: controls.maxPerCustomer };
  }
  // Free SMS during an active 7-day trial, up to TRIAL_SMS_SEGMENTS so a
  // trial cannot run up an unlimited bill. Purchased credits are untouched.
  if (onTrial(b)) {
    const used = Number(db.prepare(`SELECT COALESCE(SUM(segments),0) AS n FROM fiti_signal_messages WHERE business_id=? AND trial=1 AND status IN ('queued','sent')`).get(b).n);
    if (used + segments <= TRIAL_SMS_SEGMENTS) {
      const row = db.prepare(`INSERT INTO fiti_signal_messages (id,business_id,event_id,service_key,recipient,message,segments,essential,trial) VALUES (?,?,?,?,?,?,?,?,1) RETURNING *`)
        .get(id('sms'), b, event, serviceKey, recipient, safeText, segments, essentialFlag ? 1 : 0);
      ledger(b, 0, 'trial', row.id, { serviceKey, recipient, segments });
      return row;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const account = accountFor(b);
    if (account.credits_available < segments) {
      db.exec('ROLLBACK');
      return { queued: false, skipped: true, reason: 'insufficient-credits', required: segments, available: account.credits_available };
    }
    const row = db.prepare(`INSERT INTO fiti_signal_messages (id,business_id,event_id,service_key,recipient,message,segments,essential) VALUES (?,?,?,?,?,?,?,?) RETURNING *`)
      .get(id('sms'), b, event, serviceKey, recipient, safeText, segments, essentialFlag ? 1 : 0);
    db.prepare(`UPDATE fiti_signal_accounts SET credits_available=credits_available-?,credits_reserved=credits_reserved+?,updated_at=datetime('now') WHERE business_id=?`).run(segments, segments, b);
    ledger(b, -segments, 'reserve', row.id, { serviceKey, recipient });
    db.exec('COMMIT'); return row;
  } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
}

async function processQueue(provider, { limit = 50 } = {}) {
  if (!provider || typeof provider.send !== 'function') throw new Error('An SMS provider adapter is required.');
  // The platform administrator can pause delivery without touching tenant
  // credits or router processes. Queued messages remain safely queued.
  try {
    const control = db.prepare('SELECT paused FROM fiti_signal_provider_controls WHERE id=1').get();
    if (control?.paused) return [];
  } catch (_) { /* controls table is optional until the admin module is attached */ }
  const rows = db.prepare(`SELECT * FROM fiti_signal_messages WHERE status='queued' ORDER BY created_at LIMIT ?`).all(Math.max(1, Math.min(500, Number(limit) || 50)));
  const results = [];
  for (const row of rows) {
    try {
      const result = await provider.send({ to: row.recipient, message: row.message, id: row.id });
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`UPDATE fiti_signal_messages SET status='sent',provider_id=?,updated_at=datetime('now') WHERE id=? AND status='queued'`).run(result?.id || result?.messageId || null, row.id);
      if (!row.trial) db.prepare(`UPDATE fiti_signal_accounts SET credits_reserved=MAX(0,credits_reserved-?),credits_used=credits_used+?,updated_at=datetime('now') WHERE business_id=?`).run(row.segments, row.segments, row.business_id);
      ledger(row.business_id, 0, 'sent', row.id, { segments: row.segments });
      db.exec('COMMIT'); results.push({ id: row.id, status: 'sent' });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`UPDATE fiti_signal_messages SET status='failed',error=?,updated_at=datetime('now') WHERE id=? AND status='queued'`).run(String(error.message || error).slice(0, 500), row.id);
      if (!row.trial) {
        db.prepare(`UPDATE fiti_signal_accounts SET credits_reserved=MAX(0,credits_reserved-?),credits_available=credits_available+?,updated_at=datetime('now') WHERE business_id=?`).run(row.segments, row.segments, row.business_id);
        ledger(row.business_id, row.segments, 'refund', row.id, { error: String(error.message || error).slice(0, 200) });
      }
      db.exec('COMMIT'); results.push({ id: row.id, status: 'failed', error: String(error.message || error) });
    }
  }
  return results;
}

function usage(business, { limit = 100 } = {}) {
  const b = businessId(business);
  return db.prepare(`SELECT * FROM fiti_signal_messages WHERE business_id=? ORDER BY created_at DESC LIMIT ?`).all(b, Math.max(1, Math.min(1000, Number(limit) || 100)));
}

// Tenant API boundary. Payment collection can complete a purchase later via
// completePurchase; the SMS ledger itself remains independent of routers.
function attachFitiSignalRoutes(app, { businessAuth }) {
  const operator = handler => (req, res) => {
    const business = businessAuth(req, res);
    if (!business) return;
    try { return handler(req, res, business); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  };
  const businessKey = business => business.id || business.business_id;
  app.get('/api/business/sms', operator((req, res, business) => {
    const b = businessKey(business);
    const account = balance(b);
    const messages = usage(b, { limit: 1000 });
    const trialExpiry = business.billing_expires_at
      ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(business.billing_expires_at))
        ? String(business.billing_expires_at)
        : String(business.billing_expires_at).replace(' ', 'T') + 'Z')
      : NaN;
    const trialUnlimited = String(business.billing_status || '').toLowerCase() === 'trial'
      && Number.isFinite(trialExpiry) && trialExpiry > Date.now();
    res.set('Cache-Control', 'no-store').json({
      sms: { credits: account.credits_available, reserved: account.credits_reserved,
        sent: account.credits_used, services: getServices(b), controls: getSettings(b),
        usage: messages, packageName: null, trialUnlimited,
        trialSms: trialUnlimited ? { limit: TRIAL_SMS_SEGMENTS, used: Number(db.prepare(`SELECT COALESCE(SUM(segments),0) AS n FROM fiti_signal_messages WHERE business_id=? AND trial=1 AND status IN ('queued','sent')`).get(b).n) } : null },
      packages: packages(), catalogue: SERVICE_CATALOGUE,
    });
  }));
  app.post('/api/business/sms/packages', operator((req, res, business) => {
    const body = req.body || {};
    const amount = Number(body.amount);
    const selected = packages().find(item => item.amount === amount);
    const purchase = createPurchase({ businessId: businessKey(business), packageId: selected?.id, amount });
    res.status(201).json({ purchase, message: 'SMS package created. Complete payment to activate credits.' });
  }));
  app.post('/api/business/sms/packages/:purchaseId/confirm', operator((req, res, business) => {
    const purchase = db.prepare('SELECT business_id FROM fiti_signal_purchases WHERE id=?').get(req.params.purchaseId);
    if (!purchase || purchase.business_id !== businessKey(business)) return res.status(404).json({ error: 'SMS purchase was not found.' });
    res.json({ purchase: completePurchase({ purchaseId: req.params.purchaseId, paymentRef: req.body?.paymentRef }) });
  }));
  app.put('/api/business/sms/settings', operator((req, res, business) => {
    const body = req.body || {};
    const controls = body.controls || body;
    const aliases = { combine: 'combineMessages', expiryOnce: 'expiryReminderHours', delayRouter: 'routerAlertDelayMinutes', confirmedOnly: 'confirmedEventsOnly', gsm160: 'gsmOnly', dedupe: 'deduplicateEvents' };
    const patch = {};
    Object.keys(aliases).forEach(key => { if (controls[key] !== undefined) patch[aliases[key]] = controls[key] === true ? (key === 'expiryOnce' ? 24 : key === 'delayRouter' ? 15 : true) : (key === 'expiryOnce' || key === 'delayRouter' ? null : false); });
    Object.assign(patch, controls);
    const b = businessKey(business);
    res.json({ sms: { controls: setSettings(b, patch), services: setServices(b, body.services || {}) } });
  }));
}

module.exports = {
  PACKAGES, SERVICE_CATALOGUE, DEFAULT_COST_CONTROLS,
  SmsProvider, FunctionSmsProvider, AfricaTalkingSmsProvider, createProvider, createAfricaTalkingProviderFromEnv,
  phone, gsmSafe, segmentCount, packages, balance, createPurchase, completePurchase,
  getSettings, setSettings, getServices, setServices, enqueue, processQueue, usage, attachFitiSignalRoutes,
};

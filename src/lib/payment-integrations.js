'use strict';

const crypto = require('crypto');
const { db } = require('./db');
const tuma = require('./tuma');

/**
 * Payment rails are adapters behind one tenant-facing choice.  This registry
 * deliberately stores only the selected provider and its public status; any
 * provider secrets remain in their dedicated encrypted tables.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS business_payment_integrations (
    business_id  TEXT PRIMARY KEY,
    provider     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'not_configured',
    tested_at    TEXT,
    last_error   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS business_c2b_settings (
    business_id TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    shortcode TEXT NOT NULL UNIQUE,
    account_prefix TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Each C2B shortcode gets its own secret callback path. Safaricom does not
// sign callbacks, so the path token is what proves a confirmation came from
// the URL the tenant registered rather than from someone who knows the Till.
if (!db.prepare('PRAGMA table_info(business_c2b_settings)').all().some(c => c.name === 'callback_token')) {
  db.exec('ALTER TABLE business_c2b_settings ADD COLUMN callback_token TEXT');
}
// A business can have many C2B PayBills, one per router at most. The first
// version allowed one per business (business_id was the key): rebuild that
// table once, keeping every row, its shortcode and its callback token.
if (db.prepare('PRAGMA table_info(business_c2b_settings)').all().some(c => c.name === 'business_id' && c.pk)) {
  db.exec(`
    BEGIN;
    CREATE TABLE business_c2b_settings_multi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      shortcode TEXT NOT NULL UNIQUE,
      account_prefix TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      callback_token TEXT
    );
    INSERT INTO business_c2b_settings_multi (business_id, location_id, shortcode, account_prefix, active, created_at, updated_at, callback_token)
      SELECT business_id, location_id, shortcode, account_prefix, active, created_at, updated_at, callback_token FROM business_c2b_settings;
    DROP TABLE business_c2b_settings;
    ALTER TABLE business_c2b_settings_multi RENAME TO business_c2b_settings;
    COMMIT;
  `);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_c2b_callback_token ON business_c2b_settings(callback_token)');
db.exec('CREATE INDEX IF NOT EXISTS idx_c2b_business_location ON business_c2b_settings(business_id, location_id, active)');
function newCallbackToken() { return crypto.randomBytes(24).toString('hex'); }
for (const row of db.prepare('SELECT business_id FROM business_c2b_settings WHERE callback_token IS NULL').all()) {
  db.prepare('UPDATE business_c2b_settings SET callback_token=? WHERE business_id=?').run(newCallbackToken(), row.business_id);
}

function c2bCallbackUrls(setting) {
  const base = `${process.env.PUBLIC_URL || ''}/api/c2b/t/${setting.callback_token}`;
  return { confirmation: `${base}/confirm`, validation: `${base}/validate` };
}

const providers = [
  { id: 'fiti', name: 'Wi-Fi Fiti collection', description: 'Customers pay Wi-Fi Fiti’s Tuma M-Pesa account; your sales, less 5%, build your payout balance.', available: true },
  { id: 'daraja', name: 'Safaricom Daraja API', description: 'Connect your own M-Pesa PayBill or Till credentials.', available: true },
  { id: 'tuma', name: 'Tuma Gateway', description: 'Accept bank and M-Pesa payments with direct settlement to your account.', available: true },
  { id: 'c2b', name: 'C2B PayBill reconciliation', description: 'Match customer PayBill references and reconcile them automatically.', available: true },
  { id: 'till', name: 'M-Pesa Till reconciliation', description: 'Reconcile Buy Goods / Till payments against customer accounts.', available: true },
  { id: 'bank', name: 'Bank account reconciliation', description: 'Connect a supported bank feed for automated settlement matching.', available: false },
  { id: 'manual', name: 'Manual payment recording', description: 'Record verified payments manually while an integration is pending.', available: true },
];
const byId = new Map(providers.map(provider => [provider.id, provider]));
const selected = db.prepare('SELECT * FROM business_payment_integrations WHERE business_id=?');
const save = db.prepare(`
  INSERT INTO business_payment_integrations (business_id, provider, status, updated_at)
  VALUES (?, ?, 'not_configured', datetime('now'))
  ON CONFLICT(business_id) DO UPDATE SET provider=excluded.provider,
    status='not_configured', last_error=NULL, updated_at=datetime('now')
`);
const markTested = db.prepare(`
  UPDATE business_payment_integrations SET status=@status, tested_at=datetime('now'),
    last_error=@error, updated_at=datetime('now') WHERE business_id=@businessId
`);
const c2bReport = db.prepare(`
  SELECT checkout_request_id, location_id, phone, package_name, amount, status,
         mpesa_receipt, provisioned, created_at, updated_at
    FROM tenant_transactions
   WHERE business_id=? AND payment_source='c2b'
   ORDER BY created_at DESC LIMIT 500
`);
const c2bByShortcode = db.prepare('SELECT * FROM business_c2b_settings WHERE shortcode=? AND active=1');
// The first active one (older single-PayBill screens and the PPPoE pay page).
const c2bByBusiness = db.prepare('SELECT * FROM business_c2b_settings WHERE business_id=? ORDER BY active DESC, id LIMIT 1');
const c2bListForBusiness = db.prepare('SELECT * FROM business_c2b_settings WHERE business_id=? AND active=1 ORDER BY id');
const c2bByBusinessShortcode = db.prepare('SELECT * FROM business_c2b_settings WHERE business_id=? AND shortcode=?');
const c2bAnyByShortcode = db.prepare('SELECT business_id FROM business_c2b_settings WHERE shortcode=?');
const c2bForLocation = db.prepare('SELECT * FROM business_c2b_settings WHERE business_id=? AND location_id=? AND active=1 ORDER BY id DESC LIMIT 1');
// One PayBill shows on a router's portal: a new one for that router replaces it.
const retireOthersAtLocation = db.prepare(`UPDATE business_c2b_settings SET active=0, updated_at=datetime('now')
  WHERE business_id=? AND location_id=? AND shortcode<>? AND active=1`);
const retireC2b = db.prepare(`UPDATE business_c2b_settings SET active=0, updated_at=datetime('now') WHERE business_id=? AND shortcode=? AND active=1`);
const c2bByToken = db.prepare('SELECT * FROM business_c2b_settings WHERE callback_token=? AND active=1');
const insertC2b = db.prepare(`
  INSERT INTO business_c2b_settings (business_id, location_id, shortcode, account_prefix, callback_token, updated_at)
  VALUES (@businessId, @locationId, @shortcode, @accountPrefix, @callbackToken, datetime('now'))
`);
const updateC2b = db.prepare(`UPDATE business_c2b_settings SET location_id=@locationId, account_prefix=@accountPrefix,
  active=1, updated_at=datetime('now') WHERE business_id=@businessId AND shortcode=@shortcode`);
/** Add a C2B PayBill for a router, or move an existing one to it. Throws a
 * 409 when another business already uses that shortcode. */
function saveC2bFor({ businessId, locationId, shortcode, accountPrefix }) {
  const other = c2bAnyByShortcode.get(shortcode);
  if (other && other.business_id !== businessId) throw Object.assign(new Error('That shortcode is already linked to another workspace.'), { status: 409 });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (c2bByBusinessShortcode.get(businessId, shortcode)) updateC2b.run({ businessId, locationId, shortcode, accountPrefix });
    else insertC2b.run({ businessId, locationId, shortcode, accountPrefix, callbackToken: newCallbackToken() });
    retireOthersAtLocation.run(businessId, locationId, shortcode);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return c2bByBusinessShortcode.get(businessId, shortcode);
}
function c2bView(setting) {
  const urls = c2bCallbackUrls(setting);
  return { shortcode: setting.shortcode, locationId: setting.location_id, accountPrefix: setting.account_prefix || '',
    active: Boolean(setting.active), callbackUrl: urls.confirmation, validationUrl: urls.validation };
}

function summary(businessId) {
  const row = selected.get(businessId);
  const provider = byId.get(row?.provider || 'fiti');
  return {
    providers,
    selected: provider.id,
    status: row?.status || (provider.id === 'fiti' ? 'active' : 'not_configured'),
    testedAt: row?.tested_at || null,
    lastError: row?.last_error || null,
  };
}

function attachPaymentIntegrationRoutes(app, { businessAuth, tenant, tumaTenants, onPayoutSaved = null }) {
  app.get('/api/business/integrations', (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const result = summary(business.id);
    // Reflect the existing encrypted Daraja connection as configured even if
    // the tenant selected it before this registry was introduced.
    const daraja = tenant.paymentConnectionSummary.get(business.id);
    if (result.selected === 'daraja' && daraja && result.status === 'not_configured') result.status = 'active';
    // Tuma is only ready once this tenant's own payout account exists; an
    // older "ready" from before payout accounts must not show as ready.
    if (result.selected === 'tuma' && tumaTenants && !tumaTenants.connected(business.id) && ['ready', 'active'].includes(result.status)) {
      result.status = 'pending_configuration';
      result.lastError = 'Add where Tuma should send your money to finish.';
    }
    res.json(result);
  });

  app.post('/api/business/integrations/select', (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const providerId = String(req.body?.provider || '').trim().toLowerCase();
    const provider = byId.get(providerId);
    if (!provider || !provider.available) return res.status(400).json({ error: 'Select an available payment integration.' });
    const current = selected.get(business.id);
    // Saving the provider after a successful readiness test must not erase
    // that result and make a verified integration look unconfigured again.
    if (current && current.provider === providerId) return res.status(200).json(summary(business.id));
    save.run(business.id, providerId);
    res.status(201).json(summary(business.id));
  });

  app.post('/api/business/integrations/test', async (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const row = selected.get(business.id);
    const providerId = String(req.body?.provider || row?.provider || '').trim().toLowerCase();
    const provider = byId.get(providerId);
    if (!provider || !provider.available) return res.status(400).json({ error: 'Select an available payment integration first.' });
    if (!row || row.provider !== providerId) save.run(business.id, providerId);
    // Daraja verification remains the authoritative test for the existing
    // tenant connection. Other adapters become testable when credentials are
    // configured; no fake payment is created by this endpoint.
    let status = 'pending_configuration';
    let error = null;
    if (providerId === 'fiti' || providerId === 'manual') status = 'ready';
    else if (providerId === 'daraja' && tenant.paymentConnectionSummary.get(business.id)) status = 'ready';
    else if (providerId === 'tuma') {
      // Ready means: Tuma can reach our callback, and this tenant has its own
      // Tuma business so money settles to them rather than the platform.
      if (!tuma.callbackConfigured()) {
        status = 'pending_configuration';
        error = 'Wi‑Fi Fiti is finishing its Tuma setup (callback secret). Please try again later.';
      } else if (!tumaTenants || !tumaTenants.connected(business.id)) {
        status = 'pending_configuration';
        error = 'Add where Tuma should send your money (Till, PayBill or bank) below, then run the test again.';
      } else {
        const result = await tumaTenants.test(business.id);
        status = result.ok ? 'ready' : 'error';
        error = result.ok ? null : result.error;
      }
    }
    markTested.run({ businessId: business.id, status, error });
    res.json(summary(business.id));
  });

  app.get('/api/business/integrations/c2b', (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const setting = c2bByBusiness.get(business.id);
    const urls = setting ? c2bCallbackUrls(setting) : null;
    res.json({ configured: Boolean(setting), setting: setting ? {
      locationId: setting.location_id, shortcode: setting.shortcode,
      accountPrefix: setting.account_prefix, active: Boolean(setting.active),
    } : null, callbackUrl: urls ? urls.confirmation : null, validationUrl: urls ? urls.validation : null,
    // Every active C2B PayBill, one per router at most.
    accounts: c2bListForBusiness.all(business.id).map(c2bView) });
  });

  app.post('/api/business/integrations/c2b', (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const shortcode = String(req.body?.shortcode || '').trim();
    const locationId = String(req.body?.locationId || '').trim();
    const accountPrefix = String(req.body?.accountPrefix || '').trim().slice(0, 20);
    if (!/^\d{5,12}$/.test(shortcode) || !locationId) return res.status(400).json({ error: 'Enter a valid PayBill shortcode and location.' });
    const location = tenant.locationById.get(locationId);
    if (!location || location.business_id !== business.id) return res.status(404).json({ error: 'Location not found.' });
    try {
      const saved = saveC2bFor({ businessId: business.id, locationId, shortcode, accountPrefix });
      // Only the first PayBill switches the business to C2B reconciliation;
      // adding more never changes how its other routers are paid.
      if (c2bListForBusiness.all(business.id).length === 1) save.run(business.id, 'c2b');
      if (onPayoutSaved) { try { onPayoutSaved(business.id, shortcode); } catch (error) { console.error('[c2b] trial check failed:', error.message); } }
      const view = c2bView(saved);
      res.status(201).json({ configured: true, setting: { locationId, shortcode, accountPrefix, active: true },
        callbackUrl: view.callbackUrl, validationUrl: view.validationUrl, accounts: c2bListForBusiness.all(business.id).map(c2bView) });
    } catch (error) {
      if (error.status === 409 || String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'That shortcode is already linked to another workspace.' });
      return res.status(400).json({ error: 'C2B settings could not be saved.' });
    }
  });

  app.delete('/api/business/integrations/c2b/:shortcode', (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const shortcode = String(req.params.shortcode || '').trim();
    if (!/^\d{5,12}$/.test(shortcode) || !retireC2b.run(business.id, shortcode).changes) return res.status(404).json({ error: 'That PayBill was not found.' });
    // Past payments keep their records; the shortcode just stops matching.
    res.json({ ok: true, accounts: c2bListForBusiness.all(business.id).map(c2bView) });
  });
  app.get('/api/business/integrations/c2b/reconciliation', (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const rows = c2bReport.all(business.id);
    const summary = rows.reduce((out, row) => { out.count += 1; if (row.status === 'paid') out.paid += 1; if (row.status === 'failed' || row.status === 'reversed') out.failed += 1; out.amount += row.status === 'paid' ? Number(row.amount || 0) : 0; return out; }, { count: 0, paid: 0, failed: 0, amount: 0 });
    res.json({ summary, transactions: rows });
  });
}

function c2bSettingForShortcode(shortcode) { return c2bByShortcode.get(String(shortcode || '').trim()); }
/** The active C2B PayBill shown on this router's portal, if any. */
function c2bSettingForLocation(businessId, locationId) { return c2bForLocation.get(businessId, locationId); }
/** The business's first active C2B PayBill (PPPoE pay page, reversals). */
function c2bSettingForBusiness(businessId) { const row = c2bByBusiness.get(businessId); return row && row.active ? row : undefined; }
function c2bSettingForToken(token) {
  const value = String(token || '');
  return /^[a-f0-9]{48}$/.test(value) ? c2bByToken.get(value) : undefined;
}

module.exports = { providers, summary, attachPaymentIntegrationRoutes, c2bSettingForShortcode, c2bSettingForToken, c2bSettingForLocation, c2bSettingForBusiness, c2bCallbackUrls, saveC2bFor };

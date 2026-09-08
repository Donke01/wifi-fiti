const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

/**
 * Uses Node's built-in SQLite rather than better-sqlite3.
 *
 * The native module needs a C++ compiler and a prebuilt binary matching
 * your exact Node version, and it breaks whenever V8 removes an API it
 * relied on. The built-in has no build step and cannot fall out of sync
 * with the runtime. Same SQLite underneath, same query patterns.
 *
 * Requires Node 22.5 or newer.
 */

const dir = path.dirname(path.resolve(config.databasePath));
fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(path.resolve(config.databasePath));

// WAL lets the reconciliation sweep read while a callback is writing.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    checkout_request_id TEXT PRIMARY KEY,
    merchant_request_id TEXT,
    phone               TEXT NOT NULL,
    package_id          TEXT NOT NULL,
    amount              INTEGER NOT NULL,
    seconds             INTEGER NOT NULL,
    mac                 TEXT,
    ip                  TEXT,
    auto_login          INTEGER NOT NULL DEFAULT 1,
    status              TEXT NOT NULL DEFAULT 'pending',
    result_code         INTEGER,
    result_desc         TEXT,
    mpesa_receipt       TEXT,
    hotspot_username    TEXT,
    hotspot_password    TEXT,
    provisioned         INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tx_status  ON transactions(status);
  CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_tx_receipt ON transactions(mpesa_receipt);

  -- The authoritative record of what each customer has bought.
  -- The router is a cache of this, not the other way round: if a router
  -- is reset, replaying the total restores the customer's balance.
  CREATE TABLE IF NOT EXISTS accounts (
    phone         TEXT PRIMARY KEY,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    password      TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Work waiting for a router to collect. Jobs carry an ABSOLUTE total,
  -- never a delta, so redelivery is a no-op rather than free internet.
  CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site          TEXT NOT NULL,
    username      TEXT NOT NULL,
    password      TEXT NOT NULL,
    profile       TEXT NOT NULL,
    total_seconds INTEGER NOT NULL,
    mac           TEXT,
    ip            TEXT,
    action        TEXT NOT NULL DEFAULT 'upsert',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at  TEXT,
    acked_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(site, acked_at);

  -- Vouchers: prepaid codes sold in cash, or handed out as promos.
  CREATE TABLE IF NOT EXISTS vouchers (
    code        TEXT PRIMARY KEY,
    package_id  TEXT NOT NULL,
    seconds     INTEGER NOT NULL,
    batch       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    redeemed_at TEXT,
    redeemed_by TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_vouchers_open ON vouchers(redeemed_at);

  -- Devices with no browser: TVs, consoles, streaming sticks. They can
  -- never see a captive portal, so the owner registers them by MAC and
  -- the router logs them in under the owner's account.
  CREATE TABLE IF NOT EXISTS devices (
    mac         TEXT PRIMARY KEY,
    phone       TEXT NOT NULL,
    label       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_login  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_devices_phone ON devices(phone);

  -- Commercial platform layer. These tables are deliberately separate from
  -- the original single-site ledger while existing operators are migrated.
  CREATE TABLE IF NOT EXISTS businesses (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    owner_name      TEXT NOT NULL,
    owner_phone     TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    -- A trial account can exist before its owner has named the organisation.
    -- Keeping this state on the existing business record makes the new
    -- first-login flow backwards compatible with already-created accounts.
    onboarding_state TEXT NOT NULL DEFAULT 'complete',
    organisation_completed_at TEXT,
    hotspot_name    TEXT,
    portal_name     TEXT,
    -- This is intentionally separate from organisation completion. A
    -- customer-facing address is chosen only after the first router has
    -- successfully completed its WiFi Fiti connection.
    portal_setup_completed_at TEXT,
    support_phone   TEXT,
    brand_primary_color TEXT,
    brand_logo_path TEXT,
    portal_message  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS business_sessions (
    token_hash      TEXT PRIMARY KEY,
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS locations (
    id              TEXT PRIMARY KEY,
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    name            TEXT NOT NULL,
    router_token    TEXT NOT NULL UNIQUE,
    router_pending_token_hash TEXT,
    router_pending_token_expires_at TEXT,
    router_name     TEXT,
    hotspot_server  TEXT,
    setup_mode      TEXT,
    router_model    TEXT,
    routeros_version TEXT,
    wifi_stack      TEXT,
    customer_bridge TEXT,
    wan_interface   TEXT,
    wifi_interface  TEXT,
    wifi_ssid       TEXT,
    customer_ports  TEXT,
    hotspot_subnet  TEXT,
    -- A customer page belongs to a router location, not to the whole
    -- business.  Each additional router follows the same post-connection
    -- customer-page step.
    portal_setup_completed_at TEXT,
    -- The cloud records a one-time update sent to legacy pollers that cannot
    -- report their current portal host. A reporting router is still retried
    -- whenever it declares a different host.
    router_portal_update_sent_host TEXT,
    -- A router is only ready after it proves it ran the cloud's reply on
    -- the following poll. These values make an interrupted fetch harmless:
    -- a request alone can never turn a router live or replace an active one.
    last_router_contact_at TEXT,
    router_setup_nonce TEXT,
    router_pending_setup_nonce TEXT,
    router_setup_verified_at TEXT,
    router_setup_health TEXT,
    router_setup_checked_at TEXT,
    -- Replacement settings stay isolated from the live router until its
    -- new one-time credential completes the receipt-backed handshake.
    router_pending_setup_json TEXT,
    -- Updated only after the router has fetched the new login page, not
    -- merely after the cloud asked it to do so.
    router_portal_applied_host TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS business_packages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    name            TEXT NOT NULL,
    price           INTEGER NOT NULL,
    seconds         INTEGER NOT NULL,
    rate_limit      TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_locations_business ON locations(business_id);
  CREATE INDEX IF NOT EXISTS idx_business_packages ON business_packages(business_id, active);
`);

/* Columns added after first release. SQLite has no IF NOT EXISTS for
   ALTER, so we probe and ignore the duplicate-column error. */
for (const stmt of [
  `ALTER TABLE accounts ADD COLUMN used_seconds INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE transactions ADD COLUMN last_query_at TEXT`,
  `ALTER TABLE accounts ADD COLUMN purchased_seconds INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE accounts ADD COLUMN last_mac TEXT`,
  `ALTER TABLE accounts ADD COLUMN last_seen_at TEXT`,
  `ALTER TABLE accounts ADD COLUMN expires_at TEXT`,
  `ALTER TABLE transactions ADD COLUMN auto_login INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE jobs ADD COLUMN action TEXT NOT NULL DEFAULT 'upsert'`,
  `ALTER TABLE accounts ADD COLUMN payer_phone TEXT`,
  `ALTER TABLE businesses ADD COLUMN plan TEXT NOT NULL DEFAULT 'starter'`,
  `ALTER TABLE businesses ADD COLUMN collection_mode TEXT NOT NULL DEFAULT 'own'`,
  `ALTER TABLE businesses ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'trial'`,
  `ALTER TABLE businesses ADD COLUMN billing_expires_at TEXT`,
  `ALTER TABLE businesses ADD COLUMN portal_name TEXT`,
  `ALTER TABLE businesses ADD COLUMN support_phone TEXT`,
  `ALTER TABLE businesses ADD COLUMN brand_primary_color TEXT`,
  `ALTER TABLE businesses ADD COLUMN brand_logo_path TEXT`,
  `ALTER TABLE businesses ADD COLUMN portal_message TEXT`,
  `ALTER TABLE businesses ADD COLUMN onboarding_state TEXT NOT NULL DEFAULT 'complete'`,
  `ALTER TABLE businesses ADD COLUMN organisation_completed_at TEXT`,
  `ALTER TABLE businesses ADD COLUMN hotspot_name TEXT`,
  `ALTER TABLE businesses ADD COLUMN portal_setup_completed_at TEXT`,
  `ALTER TABLE locations ADD COLUMN portal_setup_completed_at TEXT`,
  `ALTER TABLE locations ADD COLUMN router_portal_update_sent_host TEXT`,
  `ALTER TABLE locations ADD COLUMN last_router_contact_at TEXT`,
  `ALTER TABLE locations ADD COLUMN router_setup_nonce TEXT`,
  `ALTER TABLE locations ADD COLUMN router_pending_setup_nonce TEXT`,
  `ALTER TABLE locations ADD COLUMN router_setup_verified_at TEXT`,
  `ALTER TABLE locations ADD COLUMN router_setup_health TEXT`,
  `ALTER TABLE locations ADD COLUMN router_setup_checked_at TEXT`,
  `ALTER TABLE locations ADD COLUMN router_pending_setup_json TEXT`,
  `ALTER TABLE locations ADD COLUMN router_portal_applied_host TEXT`,
  `ALTER TABLE business_packages ADD COLUMN rate_limit TEXT`,
]) {
  try { db.exec(stmt); } catch { /* already present */ }
}
db.exec(`UPDATE accounts SET payer_phone = phone WHERE payer_phone IS NULL`);

// One-time migration for balances created by the earlier usage-based model.
// Whatever time was still banked becomes a wall-clock subscription starting
// at deployment, so an upgrade does not erase a customer's paid balance.
db.exec(`
  UPDATE accounts
     SET expires_at = datetime(
       'now', '+' || MAX(0, total_seconds - COALESCE(used_seconds, 0)) || ' seconds'
     )
   WHERE expires_at IS NULL
     AND total_seconds > COALESCE(used_seconds, 0)
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_mac ON accounts(last_mac);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_payer ON accounts(payer_phone);`);

const insert = db.prepare(`
  INSERT INTO transactions
    (checkout_request_id, merchant_request_id, phone, package_id,
     amount, seconds, mac, ip, status)
  VALUES
    (@checkoutRequestId, @merchantRequestId, @phone, @packageId,
     @amount, @seconds, @mac, @ip, 'pending')
`);

const requireManualLogin = db.prepare(`
  UPDATE transactions SET auto_login = 0 WHERE checkout_request_id = ?
`);

const get = db.prepare(
  `SELECT * FROM transactions WHERE checkout_request_id = ?`
);

/** Recover the checkout a captive-portal browser lost when iOS or Android
 * closed its temporary window during the M-Pesa hand-off. */
const latestPaymentForMac = db.prepare(`
  SELECT checkout_request_id, phone, amount, status, created_at
    FROM transactions
   WHERE mac = ?
     AND status = 'pending'
     AND created_at > datetime('now', '-2 hours')
   ORDER BY created_at DESC
   LIMIT 1
`);

const markResult = db.prepare(`
  UPDATE transactions
     SET status = @status,
         result_code = @resultCode,
         result_desc = @resultDesc,
         mpesa_receipt = COALESCE(@receipt, mpesa_receipt),
         updated_at = datetime('now')
   WHERE checkout_request_id = @checkoutRequestId AND (status!='paid' OR @status='paid')
`);

const markProvisioned = db.prepare(`
  UPDATE transactions
     SET provisioned = 1,
         hotspot_username = @username,
         hotspot_password = @password,
         updated_at = datetime('now')
   WHERE checkout_request_id = @checkoutRequestId
`);

const stalePending = db.prepare(`
  SELECT * FROM transactions
   WHERE status = 'pending'
     AND created_at <= datetime('now', '-' || ? || ' seconds')
     AND created_at >  datetime('now', '-2 hours')
`);

const paidUnprovisioned = db.prepare(`
  SELECT * FROM transactions
   WHERE status = 'paid' AND provisioned = 0
     AND created_at > datetime('now', '-24 hours')
`);

const findByReceipt = db.prepare(`
  SELECT checkout_request_id FROM transactions
   WHERE mpesa_receipt = ? AND checkout_request_id != ?
`);

/** Guards against Safaricom replaying a receipt we already banked. */
function isDuplicateReceipt(receipt, checkoutRequestId) {
  if (!receipt) return false;
  return Boolean(findByReceipt.get(receipt, checkoutRequestId));
}


/* ------------------------------------------------------------------ */
/* Accounts and jobs                                                   */
/* ------------------------------------------------------------------ */

const getAccount = db.prepare(`SELECT * FROM accounts WHERE phone = ?`);

const upsertAccount = db.prepare(`
  INSERT INTO accounts (phone, total_seconds, password)
  VALUES (@phone, @totalSeconds, @password)
  ON CONFLICT(phone) DO UPDATE SET
    total_seconds = @totalSeconds,
    password      = @password,
    updated_at    = datetime('now')
`);

/** Lifetime seconds actually paid for. Used as a ceiling so a ledger
 *  correction can never hand out more time than was bought. */
const addPurchased = db.prepare(`
  UPDATE accounts
     SET purchased_seconds = purchased_seconds + @seconds
   WHERE phone = @phone
`);

const addJob = db.prepare(`
  INSERT INTO jobs (site, username, password, profile, total_seconds, mac, ip, action)
  VALUES (@site, @username, @password, @profile, @totalSeconds, @mac, @ip, 'upsert')
`);

const revokeUser = db.prepare(`
  INSERT INTO jobs (site, username, password, profile, total_seconds, mac, ip, action)
  VALUES (@site, @username, '2222', 'standard', 1, NULL, NULL, 'revoke')
`);

const transferUser = db.prepare(`
  INSERT INTO jobs (site, username, password, profile, total_seconds, mac, ip, action)
  VALUES (@site, @username, @password, @profile, @totalSeconds, @mac, @ip, 'transfer')
`);

/** Undelivered, or delivered but unacknowledged for over a minute. */
const pendingJobs = db.prepare(`
  SELECT * FROM jobs
   WHERE site = ? AND acked_at IS NULL
     AND (delivered_at IS NULL
          OR delivered_at <= datetime('now', '-60 seconds'))
   ORDER BY id
   LIMIT 25
`);

const markDelivered = db.prepare(`
  UPDATE jobs SET delivered_at = datetime('now') WHERE id = ?
`);

const markAcked = db.prepare(`
  UPDATE jobs SET acked_at = datetime('now') WHERE id = ? AND site = ?
`);

const purgeOldJobs = db.prepare(`
  DELETE FROM jobs
   WHERE acked_at IS NOT NULL AND acked_at < datetime('now', '-7 days')
`);


/* ------------------------------------------------------------------ */
/* Sessions, usage and vouchers                                        */
/* ------------------------------------------------------------------ */

const accountByMac = db.prepare(
  `SELECT * FROM accounts WHERE last_mac = ? ORDER BY updated_at DESC LIMIT 1`
);

const accountsForPayer = db.prepare(`
  SELECT * FROM accounts
   WHERE COALESCE(payer_phone, phone) = ?
   ORDER BY updated_at DESC
`);

const activeAccountsForPayer = db.prepare(`
  SELECT * FROM accounts
   WHERE COALESCE(payer_phone, phone) = ?
     AND expires_at IS NOT NULL AND expires_at > datetime('now')
   ORDER BY updated_at DESC
`);

const setPayer = db.prepare(`UPDATE accounts SET payer_phone = @payerPhone WHERE phone = @phone`);

const rememberMac = db.prepare(`
  UPDATE accounts SET last_mac = @mac, last_seen_at = datetime('now')
   WHERE phone = @phone
`);

const setExpiry = db.prepare(`
  UPDATE accounts
     SET expires_at = @expiresAt,
         updated_at = datetime('now')
   WHERE phone = @phone
`);

const expiredAccounts = db.prepare(`
  SELECT phone
    FROM accounts
   WHERE expires_at IS NOT NULL
     AND expires_at <= datetime('now')
`);

const activeAccounts = db.prepare(`
  SELECT phone, password, total_seconds, last_mac
    FROM accounts
   WHERE expires_at IS NOT NULL
     AND expires_at > datetime('now')
`);

/** Usage comes from the router, which is the only thing that truly knows. */
const recordUsage = db.prepare(`
  UPDATE accounts
     SET used_seconds = @usedSeconds,
         is_active    = @isActive,
         last_seen_at = datetime('now')
   WHERE phone = @phone
`);

/** Seconds since the router last told us about this account. */
const secondsSinceReport = db.prepare(`
  SELECT CAST((julianday('now') - julianday(last_seen_at)) * 86400 AS INTEGER) AS age
    FROM accounts WHERE phone = ?
`);

const addVoucher = db.prepare(`
  INSERT INTO vouchers (code, package_id, seconds, batch)
  VALUES (@code, @packageId, @seconds, @batch)
`);

const getVoucher = db.prepare(`SELECT * FROM vouchers WHERE code = ?`);

/** Conditional UPDATE: the WHERE clause is the lock. Two simultaneous
 *  redemptions of one code cannot both report changes = 1. */
const claimVoucher = db.prepare(`
  UPDATE vouchers
     SET redeemed_at = datetime('now'), redeemed_by = @phone
   WHERE code = @code AND redeemed_at IS NULL
`);

const voucherStats = db.prepare(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN redeemed_at IS NULL THEN 1 ELSE 0 END) AS unused
    FROM vouchers
`);


/* ------------------------------------------------------------------ */
/* Browserless devices                                                 */
/* ------------------------------------------------------------------ */

const addDevice = db.prepare(`
  INSERT INTO devices (mac, phone, label) VALUES (@mac, @phone, @label)
  ON CONFLICT(mac) DO UPDATE SET phone = @phone, label = @label
`);

const getDevice = db.prepare(`SELECT * FROM devices WHERE mac = ?`);

const devicesFor = db.prepare(
  `SELECT * FROM devices WHERE phone = ? ORDER BY created_at`
);

const countDevices = db.prepare(
  `SELECT COUNT(*) AS n FROM devices WHERE phone = ?`
);

const removeDevice = db.prepare(
  `DELETE FROM devices WHERE mac = @mac AND phone = @phone`
);

const touchDevice = db.prepare(
  `UPDATE devices SET last_login = datetime('now') WHERE mac = ?`
);

/**
 * Every registered device whose owner still has time left. The router
 * re-logs these in whenever they drop off, which is the only way a TV
 * survives a reboot without someone walking over to it.
 */
const devicesToKeepOnline = db.prepare(`
  SELECT d.mac, d.phone, a.password, a.total_seconds, a.used_seconds
    FROM devices d
    JOIN accounts a ON a.phone = d.phone
   WHERE a.total_seconds > COALESCE(a.used_seconds, 0)
     AND (a.expires_at IS NULL OR a.expires_at > datetime('now'))
`);


/** Every successful purchase for one number - the money record, which is
 *  the only thing we can rebuild a balance from with confidence. */
const paidTransactionsFor = db.prepare(`
  SELECT checkout_request_id, package_id, seconds, amount, mpesa_receipt, created_at
    FROM transactions
   WHERE phone = ? AND status = 'paid'
   ORDER BY created_at
`);

const setTotal = db.prepare(`
  UPDATE accounts SET total_seconds = @totalSeconds, updated_at = datetime('now')
   WHERE phone = @phone
`);


/** Row counts, so data loss is visible instead of silent. */
const countRows = {
  transactions: db.prepare(`SELECT COUNT(*) AS n FROM transactions`),
  accounts: db.prepare(`SELECT COUNT(*) AS n FROM accounts`),
  devices: db.prepare(`SELECT COUNT(*) AS n FROM devices`),
};

function stats() {
  return {
    path: path.resolve(config.databasePath),
    transactions: countRows.transactions.get().n,
    accounts: countRows.accounts.get().n,
    devices: countRows.devices.get().n,
  };
}


/** Work still owed to the router for this customer. While this is above
 *  zero their credentials may not exist on the router yet. */
const unackedJobsFor = db.prepare(`
  SELECT COUNT(*) AS n FROM jobs WHERE username = ? AND acked_at IS NULL
`);

const unackedJobsForTotal = db.prepare(`
  SELECT COUNT(*) AS n
    FROM jobs
   WHERE username = @username
     AND total_seconds = @totalSeconds
     AND acked_at IS NULL
`);


/** Seconds since we last asked Daraja about this payment, or null. */
const querySpacing = db.prepare(`
  SELECT CAST((julianday('now') - julianday(last_query_at)) * 86400 AS INTEGER) AS age
    FROM transactions WHERE checkout_request_id = ?
`);

const touchQuery = db.prepare(`
  UPDATE transactions SET last_query_at = datetime('now')
   WHERE checkout_request_id = ?
`);

/** Age of the payment itself, so we do not query one still in flight. */
const transactionAge = db.prepare(`
  SELECT CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS age
    FROM transactions WHERE checkout_request_id = ?
`);

/** Counter resets on the router make usage go backwards. Pull the total
 *  down by the same amount so the customer's remaining time is unchanged
 *  rather than inflated by the reset. */
const reduceTotal = db.prepare(`
  UPDATE accounts
     SET total_seconds = MAX(0, total_seconds - @delta),
         updated_at = datetime('now')
   WHERE phone = @phone
`);

/* Commercial business dashboard ------------------------------------ */
const addBusiness = db.prepare(`
  INSERT INTO businesses
    (id, name, owner_name, owner_phone, email, password_hash, plan, collection_mode,
     onboarding_state, organisation_completed_at, hotspot_name)
  VALUES
    (@id, @name, @ownerName, @ownerPhone, @email, @passwordHash, @plan, @collectionMode,
     COALESCE(@onboardingState, 'complete'), @organisationCompletedAt, @hotspotName)
`);
const businessByEmail = db.prepare(`SELECT * FROM businesses WHERE email = ?`);
const businessById = db.prepare(`SELECT id, name, owner_name, owner_phone, email, plan, collection_mode, billing_status, billing_expires_at,
  onboarding_state, organisation_completed_at, hotspot_name,
  portal_name, portal_setup_completed_at, support_phone, brand_primary_color, brand_logo_path, portal_message, created_at
  FROM businesses WHERE id = ?`);
const addBusinessSession = db.prepare(`
  INSERT INTO business_sessions (token_hash, business_id, expires_at)
  VALUES (@tokenHash, @businessId, @expiresAt)
`);
const businessForSession = db.prepare(`
  SELECT b.id, b.name, b.owner_name, b.owner_phone, b.email, b.plan, b.collection_mode, b.billing_status, b.billing_expires_at,
         b.onboarding_state, b.organisation_completed_at, b.hotspot_name,
         b.portal_name, b.portal_setup_completed_at, b.support_phone, b.brand_primary_color, b.brand_logo_path, b.portal_message
    FROM business_sessions s JOIN businesses b ON b.id = s.business_id
   WHERE s.token_hash = ? AND s.expires_at > datetime('now')
`);
const completeBusinessOrganisation = db.prepare(`
  UPDATE businesses
     SET name=@name,
         owner_phone=@ownerPhone,
         hotspot_name=@hotspotName,
         portal_name=CASE WHEN portal_name IS NULL OR TRIM(portal_name)='' THEN @portalName ELSE portal_name END,
         onboarding_state='complete',
         organisation_completed_at=COALESCE(organisation_completed_at, datetime('now'))
   WHERE id=@id
`);
const setBusinessPlan = db.prepare(`
  UPDATE businesses SET plan = @plan, collection_mode = @collectionMode WHERE id = @id
`);
const setBusinessTrial = db.prepare(`
  UPDATE businesses SET billing_status='trial', billing_expires_at=@expiresAt WHERE id=@id
`);
const updateBusinessBranding = db.prepare(`
  UPDATE businesses
     SET portal_name=@portalName, support_phone=@supportPhone,
         brand_primary_color=@primaryColor, portal_message=@portalMessage
   WHERE id=@id
`);
const completeBusinessPortalSetup = db.prepare(`
  UPDATE businesses
     SET portal_setup_completed_at=COALESCE(portal_setup_completed_at, datetime('now'))
   WHERE id=@id
`);
const completeLocationPortalSetup = db.prepare(`
  UPDATE locations
     SET portal_setup_completed_at=COALESCE(portal_setup_completed_at, datetime('now'))
   WHERE id=@id AND business_id=@businessId
`);
const setBusinessLogo = db.prepare(`
  UPDATE businesses SET brand_logo_path=@brandLogoPath WHERE id=@id
`);
const businessBrandingById = db.prepare(`
  SELECT id, name, portal_name, support_phone, brand_primary_color, brand_logo_path, portal_message
    FROM businesses WHERE id=?
`);
const addLocation = db.prepare(`
  INSERT INTO locations (id, business_id, name, router_token, router_name)
  VALUES (@id, @businessId, @name, @routerToken, @routerName)
`);
const locationsForBusiness = db.prepare(`
  SELECT id, name, router_token, router_name, created_at FROM locations WHERE business_id = ? ORDER BY created_at
`);
const addBusinessPackage = db.prepare(`
  INSERT INTO business_packages (business_id, name, price, seconds, rate_limit)
  VALUES (@businessId, @name, @price, @seconds, @rateLimit)
`);
const packagesForBusiness = db.prepare(`
  SELECT id, name, price, seconds, rate_limit, active FROM business_packages WHERE business_id = ? ORDER BY price
`);

module.exports = {
  db,
  stats,
  insert,
  get,
  latestPaymentForMac,
  requireManualLogin,
  markResult,
  markProvisioned,
  stalePending,
  paidUnprovisioned,
  isDuplicateReceipt,
  getAccount,
  upsertAccount,
  addPurchased,
  addJob,
  revokeUser,
  transferUser,
  pendingJobs,
  markDelivered,
  markAcked,
  purgeOldJobs,
  unackedJobsFor,
  unackedJobsForTotal,
  querySpacing,
  touchQuery,
  transactionAge,
  reduceTotal,
  accountByMac,
  accountsForPayer,
  activeAccountsForPayer,
  setPayer,
  rememberMac,
  setExpiry,
  expiredAccounts,
  activeAccounts,
  recordUsage,
  secondsSinceReport,
  paidTransactionsFor,
  setTotal,
  addVoucher,
  getVoucher,
  claimVoucher,
  voucherStats,
  addDevice,
  getDevice,
  devicesFor,
  countDevices,
  removeDevice,
  touchDevice,
  devicesToKeepOnline,
  addBusiness,
  businessByEmail,
  businessById,
  addBusinessSession,
  businessForSession,
  completeBusinessOrganisation,
  setBusinessPlan,
  setBusinessTrial,
  updateBusinessBranding,
  completeBusinessPortalSetup,
  completeLocationPortalSetup,
  setBusinessLogo,
  businessBrandingById,
  addLocation,
  locationsForBusiness,
  addBusinessPackage,
  packagesForBusiness,
};

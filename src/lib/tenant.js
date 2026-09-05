/**
 * Tenant runtime for WiFi Fiti for Business.
 *
 * The original tables remain the legacy single-site ledger. New businesses
 * use these tables, keyed by location, so one customer's phone/MAC can never
 * leak a balance, job or payment into another operator's hotspot.
 */
const crypto = require('crypto');
const { db } = require('./db');

const tokenHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
// `locations.router_token` existed in the first dashboard schema as a
// non-null UNIQUE column. New locations store only a hash, but retain a
// unique, non-secret marker there so old deployments continue to accept
// more than one location without persisting the usable router credential.
const tokenMarker = (value) => `hash:${tokenHash(value)}`;
const nowSql = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

function secretsKey() {
  const configured = process.env.TENANT_SECRETS_KEY;
  return configured ? crypto.createHash('sha256').update(configured).digest() : null;
}

function encryptSecret(value) {
  const key = secretsKey();
  if (!key) throw new Error('Secure payment storage is not configured.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${body.toString('base64url')}`;
}

function decryptSecret(value) {
  const key = secretsKey();
  if (!key) throw new Error('Secure payment storage is not configured.');
  const [ivText, tagText, bodyText] = String(value || '').split('.');
  if (!ivText || !tagText || !bodyText) throw new Error('Saved payment credentials are incomplete.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]).toString('utf8');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_subscriptions (
    id              TEXT PRIMARY KEY,
    business_id     TEXT NOT NULL,
    location_id     TEXT NOT NULL,
    router_username TEXT NOT NULL,
    payer_phone     TEXT NOT NULL,
    mac             TEXT NOT NULL,
    password        TEXT NOT NULL,
    total_seconds   INTEGER NOT NULL DEFAULT 0,
    expires_at      TEXT NOT NULL,
    used_seconds    INTEGER NOT NULL DEFAULT 0,
    is_active       INTEGER NOT NULL DEFAULT 0,
    expiry_job_id   INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(location_id, mac),
    UNIQUE(location_id, router_username)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_sub_location_expiry
    ON tenant_subscriptions(location_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_tenant_sub_payer
    ON tenant_subscriptions(location_id, payer_phone);

  CREATE TABLE IF NOT EXISTS tenant_transactions (
    checkout_request_id TEXT PRIMARY KEY,
    merchant_request_id TEXT,
    business_id         TEXT NOT NULL,
    location_id         TEXT NOT NULL,
    phone               TEXT NOT NULL,
    package_id          INTEGER NOT NULL,
    package_name        TEXT NOT NULL,
    amount              INTEGER NOT NULL,
    seconds             INTEGER NOT NULL,
    mac                 TEXT NOT NULL,
    ip                  TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',
    result_code         INTEGER,
    result_desc         TEXT,
    mpesa_receipt       TEXT,
    subscription_id     TEXT,
    provisioning_job_id INTEGER,
    provisioned         INTEGER NOT NULL DEFAULT 0,
    payment_source      TEXT NOT NULL DEFAULT 'fiti',
    platform_fee        INTEGER NOT NULL DEFAULT 0,
    portal_token_hash   TEXT,
    portal_token_expires_at TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_tx_location_status
    ON tenant_transactions(location_id, status, created_at);

  CREATE TABLE IF NOT EXISTS tenant_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id     TEXT NOT NULL,
    username        TEXT NOT NULL,
    password        TEXT NOT NULL,
    profile         TEXT NOT NULL DEFAULT 'standard',
    total_seconds   INTEGER NOT NULL,
    mac             TEXT,
    ip              TEXT,
    action          TEXT NOT NULL DEFAULT 'upsert',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at    TEXT,
    acked_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_jobs_pending
    ON tenant_jobs(location_id, acked_at);
  CREATE INDEX IF NOT EXISTS idx_tenant_jobs_latest
    ON tenant_jobs(location_id, username, id);

  -- A paid checkout may be observed by the customer polling endpoint,
  -- Daraja's callback and the background reconciliation task. This tiny
  -- ledger is the idempotency lock: only one of them can ever credit it.
  CREATE TABLE IF NOT EXISTS tenant_payment_grants (
    checkout_request_id TEXT PRIMARY KEY,
    subscription_id     TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A subscription covers one paying device plus one browser-less TV or
  -- streaming device. It has its own RouterOS identity but shares the same
  -- wall-clock expiry, so a family cannot turn one purchase into an open
  -- hotspot.
  CREATE TABLE IF NOT EXISTS tenant_devices (
    location_id     TEXT NOT NULL,
    mac             TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    label           TEXT NOT NULL DEFAULT 'TV',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at   TEXT,
    PRIMARY KEY(location_id, mac),
    UNIQUE(location_id, subscription_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_devices_subscription
    ON tenant_devices(subscription_id);

  -- Prepaid voucher batches are isolated to a single location. The claim
  -- is made atomically below so a code cannot be redeemed twice.
  CREATE TABLE IF NOT EXISTS tenant_vouchers (
    code                    TEXT PRIMARY KEY,
    business_id             TEXT NOT NULL,
    location_id             TEXT NOT NULL,
    package_id              INTEGER,
    package_name            TEXT NOT NULL,
    seconds                 INTEGER NOT NULL,
    batch                   TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    redeemed_at             TEXT,
    redeemed_by             TEXT,
    redeemed_mac            TEXT,
    redeemed_subscription_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_vouchers_location_open
    ON tenant_vouchers(location_id, redeemed_at);

  -- Raw M-Pesa credentials are never stored. The platform's deployment
  -- secret encrypts each value independently with authenticated AES-GCM.
  CREATE TABLE IF NOT EXISTS tenant_mpesa_connections (
    business_id            TEXT PRIMARY KEY,
    collection_name        TEXT,
    shortcode              TEXT NOT NULL,
    transaction_type       TEXT NOT NULL,
    consumer_key_cipher    TEXT NOT NULL,
    consumer_secret_cipher TEXT NOT NULL,
    passkey_cipher         TEXT NOT NULL,
    last_verified_at       TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- WiFi Fiti's own monthly platform billing is kept separate from
  -- customer WiFi sales. A business only receives a renewed plan after the
  -- corresponding M-Pesa checkout is settled and activated exactly once.
  CREATE TABLE IF NOT EXISTS business_billing_transactions (
    checkout_request_id TEXT PRIMARY KEY,
    merchant_request_id TEXT,
    business_id         TEXT NOT NULL,
    plan                TEXT NOT NULL,
    phone               TEXT NOT NULL,
    amount              INTEGER NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    result_code         INTEGER,
    result_desc         TEXT,
    mpesa_receipt       TEXT,
    activated           INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_business_billing_pending
    ON business_billing_transactions(status, created_at);
  CREATE TABLE IF NOT EXISTS business_billing_grants (
    checkout_request_id TEXT PRIMARY KEY,
    business_id         TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tenant_monthly_devices (
    business_id TEXT NOT NULL,
    month TEXT NOT NULL,
    mac TEXT NOT NULL,
    PRIMARY KEY(business_id, month, mac)
  );
`);

for (const statement of [
  `ALTER TABLE locations ADD COLUMN router_token_hash TEXT`,
  // Existing paired locations used a URL token. New pairings use an HTTP
  // header so the secret never lands in RouterOS fetch URLs or web logs.
  `ALTER TABLE locations ADD COLUMN router_auth_mode TEXT NOT NULL DEFAULT 'query'`,
  `ALTER TABLE locations ADD COLUMN router_status TEXT NOT NULL DEFAULT 'waiting'`,
  `ALTER TABLE locations ADD COLUMN last_seen_at TEXT`,
  `ALTER TABLE locations ADD COLUMN hotspot_server TEXT`,
  `ALTER TABLE tenant_transactions ADD COLUMN provisioning_job_id INTEGER`,
  `ALTER TABLE tenant_transactions ADD COLUMN payment_source TEXT NOT NULL DEFAULT 'fiti'`,
  `ALTER TABLE tenant_transactions ADD COLUMN platform_fee INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tenant_transactions ADD COLUMN platform_fee_minor INTEGER`,
  `ALTER TABLE tenant_transactions ADD COLUMN portal_token_hash TEXT`,
  `ALTER TABLE tenant_transactions ADD COLUMN portal_token_expires_at TEXT`,
  `ALTER TABLE tenant_subscriptions ADD COLUMN expiry_job_id INTEGER`,
]) {
  try { db.exec(statement); } catch { /* existing deployment */ }
}

// Legacy dashboard locations stored the raw pairing token. Migrate it to a
// hash once; newly created locations never persist the secret in plaintext.
const unhashedLocations = db.prepare(`
  SELECT id, router_token FROM locations
   WHERE (router_token_hash IS NULL OR router_token_hash = '')
     AND router_token IS NOT NULL AND router_token != ''
`);
const setLocationTokenHash = db.prepare(`UPDATE locations SET router_token_hash = ? WHERE id = ?`);
const replaceLegacyToken = db.prepare(`UPDATE locations SET router_token=? WHERE id=?`);
for (const location of unhashedLocations.all()) {
  const hash = tokenHash(location.router_token);
  setLocationTokenHash.run(hash, location.id);
  replaceLegacyToken.run(`hash:${hash}`, location.id);
}

const createLocationRow = db.prepare(`
  INSERT INTO locations (id, business_id, name, router_token, router_token_hash, router_auth_mode, router_name)
  VALUES (@id, @businessId, @name, @routerTokenMarker, @routerTokenHash, 'header', @routerName)
`);
const locationById = db.prepare(`
  SELECT l.id, l.business_id, l.name, l.router_name, l.hotspot_server, l.router_token_hash, l.router_auth_mode, l.router_status, l.last_seen_at,
         b.name AS business_name, b.collection_mode, b.plan AS business_plan,
         b.billing_status, b.billing_expires_at
    FROM locations l JOIN businesses b ON b.id = l.business_id
   WHERE l.id = ?
`);
const locationsForBusiness = db.prepare(`
  SELECT id, name, router_name, hotspot_server,
         CASE WHEN router_status='online' AND (last_seen_at IS NULL OR last_seen_at <= datetime('now','-90 seconds'))
              THEN 'offline' ELSE router_status END AS router_status,
         last_seen_at, created_at
    FROM locations WHERE business_id = ? ORDER BY created_at
`);
const touchRouter = db.prepare(`
  UPDATE locations SET router_status = 'online', last_seen_at = datetime('now') WHERE id = ?
`);
const setLocationToken = db.prepare(`
  UPDATE locations SET router_token=?, router_token_hash=?, router_auth_mode='header' WHERE id=?
`);
const locationForBusiness = db.prepare(`
  SELECT id, business_id, name, router_name, router_status, last_seen_at, hotspot_server
    FROM locations WHERE id=? AND business_id=?
`);
const updateLocation = db.prepare(`
  UPDATE locations SET name=@name, router_name=@routerName, hotspot_server=@hotspotServer
   WHERE id=@id AND business_id=@businessId
`);

const packageForLocation = db.prepare(`
  SELECT p.id, p.name, p.price, p.seconds
    FROM business_packages p JOIN locations l ON l.business_id = p.business_id
   WHERE p.id = ? AND l.id = ? AND p.active = 1
`);
const packagesForLocation = db.prepare(`
  SELECT p.id, p.name, p.price, p.seconds FROM business_packages p
   JOIN locations l ON l.business_id = p.business_id
   WHERE l.id = ? AND p.active = 1 ORDER BY p.price
`);

const insertTransaction = db.prepare(`
  INSERT INTO tenant_transactions
    (checkout_request_id, merchant_request_id, business_id, location_id, phone, package_id,
     package_name, amount, seconds, mac, ip)
  VALUES (@checkoutRequestId, @merchantRequestId, @businessId, @locationId, @phone, @packageId,
          @packageName, @amount, @seconds, @mac, @ip)
`);
const getTransaction = db.prepare(`SELECT * FROM tenant_transactions WHERE checkout_request_id = ?`);
const setTransactionResult = db.prepare(`
  UPDATE tenant_transactions SET status=@status, result_code=@resultCode, result_desc=@resultDesc,
    mpesa_receipt=COALESCE(@receipt, mpesa_receipt), updated_at=datetime('now')
  WHERE checkout_request_id=@checkoutRequestId AND (status!='paid' OR @status='paid')
`);
const setTransactionTerms = db.prepare(`
  UPDATE tenant_transactions SET payment_source=@paymentSource, platform_fee=@platformFee,
    platform_fee_minor=CAST(ROUND(@platformFee * 100) AS INTEGER)
   WHERE checkout_request_id=@checkoutRequestId
`);
const setTransactionPortalCapability = db.prepare(`
  UPDATE tenant_transactions
     SET portal_token_hash=@portalTokenHash, portal_token_expires_at=@portalTokenExpiresAt
   WHERE checkout_request_id=@checkoutRequestId
`);
const setTransactionProvisioned = db.prepare(`
  UPDATE tenant_transactions SET provisioned=1, subscription_id=@subscriptionId,
    provisioning_job_id=@provisioningJobId, updated_at=datetime('now')
  WHERE checkout_request_id=@checkoutRequestId
`);
const paymentGrant = db.prepare(`
  SELECT subscription_id FROM tenant_payment_grants WHERE checkout_request_id=?
`);
const insertPaymentGrant = db.prepare(`
  INSERT INTO tenant_payment_grants (checkout_request_id, subscription_id) VALUES (?, ?)
`);
const duplicateReceipt = db.prepare(`
  SELECT checkout_request_id FROM tenant_transactions
   WHERE mpesa_receipt=? AND checkout_request_id != ? LIMIT 1
`);
const staleTransactions = db.prepare(`
  SELECT * FROM tenant_transactions WHERE status='pending'
    AND created_at <= datetime('now', '-' || ? || ' seconds')
    AND created_at > datetime('now', '-2 hours')
`);
const paidUnprovisioned = db.prepare(`
  SELECT * FROM tenant_transactions WHERE status='paid' AND provisioned=0
    AND created_at > datetime('now', '-24 hours')
`);

const subscriptionByMac = db.prepare(`SELECT * FROM tenant_subscriptions WHERE location_id=? AND mac=?`);
const subscriptionsForPayer = db.prepare(`
  SELECT * FROM tenant_subscriptions WHERE location_id=? AND payer_phone=? ORDER BY updated_at DESC
`);
const subscriptionById = db.prepare(`SELECT * FROM tenant_subscriptions WHERE id=? AND location_id=?`);
const subscriptionForPayer = db.prepare(`
  SELECT * FROM tenant_subscriptions WHERE id=? AND location_id=? AND payer_phone=?
`);
const upsertSubscription = db.prepare(`
  INSERT INTO tenant_subscriptions
    (id, business_id, location_id, router_username, payer_phone, mac, password, total_seconds, expires_at)
  VALUES (@id, @businessId, @locationId, @routerUsername, @payerPhone, @mac, @password, @totalSeconds, @expiresAt)
  ON CONFLICT(location_id, mac) DO UPDATE SET
    password=excluded.password, total_seconds=excluded.total_seconds, expires_at=excluded.expires_at,
    expiry_job_id=NULL, updated_at=datetime('now')
`);
const setSubscriptionMac = db.prepare(`
  UPDATE tenant_subscriptions SET mac=@mac, updated_at=datetime('now') WHERE id=@id AND location_id=@locationId
`);
const recordUsage = db.prepare(`
  UPDATE tenant_subscriptions SET used_seconds=@usedSeconds, is_active=@isActive, updated_at=datetime('now')
  WHERE location_id=@locationId AND router_username=@routerUsername
`);
const expiredSubscriptions = db.prepare(`
  SELECT router_username AS phone FROM tenant_subscriptions
   WHERE location_id=? AND expires_at <= datetime('now')
`);
const expiredSubscriptionsNeedingJob = db.prepare(`
  SELECT id, router_username, location_id FROM tenant_subscriptions
   WHERE location_id=? AND expires_at <= datetime('now') AND expiry_job_id IS NULL
`);
const setExpiryJob = db.prepare(`UPDATE tenant_subscriptions SET expiry_job_id=? WHERE id=? AND location_id=?`);
const activeMeter = db.prepare(`
  SELECT COUNT(DISTINCT mac) AS n FROM (
    SELECT business_id, mac FROM tenant_monthly_devices WHERE month=strftime('%Y-%m','now')
    UNION SELECT business_id, mac FROM tenant_subscriptions WHERE expires_at>=datetime('now','start of month')
  ) WHERE business_id=?
`);
const meterDevice = db.prepare(`INSERT OR IGNORE INTO tenant_monthly_devices(business_id, month, mac)
  VALUES (?, strftime('%Y-%m','now'), ?)`);

const insertJob = db.prepare(`
  INSERT INTO tenant_jobs (location_id, username, password, profile, total_seconds, mac, ip, action)
  VALUES (@locationId, @username, @password, @profile, @totalSeconds, @mac, @ip, @action)
`);
const pendingJobs = db.prepare(`
  SELECT * FROM tenant_jobs j WHERE location_id=? AND acked_at IS NULL
    AND (delivered_at IS NULL OR delivered_at <= datetime('now','-60 seconds'))
    AND NOT EXISTS (SELECT 1 FROM tenant_jobs newer
      WHERE newer.location_id=j.location_id AND newer.username=j.username AND newer.id>j.id)
  ORDER BY id LIMIT 25
`);
const markDelivered = db.prepare(`UPDATE tenant_jobs SET delivered_at=datetime('now') WHERE id=?`);
const markAcked = db.prepare(`UPDATE tenant_jobs SET acked_at=datetime('now') WHERE id=? AND location_id=?`);
const jobById = db.prepare(`SELECT j.id, j.location_id,
  (SELECT current.acked_at FROM tenant_jobs current WHERE current.location_id=j.location_id
   AND current.username=j.username ORDER BY current.id DESC LIMIT 1) AS acked_at
  FROM tenant_jobs j WHERE j.id=? AND j.location_id=?`);
// A reopened captive window must not offer a newly-created credential until
// the router has acknowledged the work that creates or moves that identity.
// Looking up by username covers both an M-Pesa purchase and a transfer.
const pendingProvisioningJobForUsername = db.prepare(`
  SELECT id, action FROM tenant_jobs
   WHERE location_id=? AND username=? AND acked_at IS NULL
     AND action IN ('upsert', 'transfer')
     AND id=(SELECT MAX(newer.id) FROM tenant_jobs newer WHERE newer.location_id=tenant_jobs.location_id
       AND newer.username=tenant_jobs.username)
   ORDER BY id DESC LIMIT 1
`);
const latestPaymentForMac = db.prepare(`
  SELECT checkout_request_id, phone, amount, status, created_at
    FROM tenant_transactions
   WHERE location_id=? AND mac=? AND status='pending'
     AND created_at > datetime('now', '-2 hours')
   ORDER BY created_at DESC LIMIT 1
`);
const pendingPaymentForPhone = db.prepare(`
  SELECT checkout_request_id, created_at FROM tenant_transactions
   WHERE location_id=? AND phone=? AND status='pending'
     AND created_at > datetime('now', '-30 seconds')
   ORDER BY created_at DESC LIMIT 1
`);
const deviceByMac = db.prepare(`SELECT * FROM tenant_devices WHERE location_id=? AND mac=?`);
const deviceForSubscription = db.prepare(`SELECT * FROM tenant_devices WHERE location_id=? AND subscription_id=?`);
const devicesForSubscription = db.prepare(`SELECT * FROM tenant_devices WHERE location_id=? AND subscription_id=? ORDER BY created_at`);
const addDevice = db.prepare(`
  INSERT INTO tenant_devices (location_id, mac, subscription_id, label)
  VALUES (@locationId, @mac, @subscriptionId, @label)
`);
const updateDevice = db.prepare(`
  UPDATE tenant_devices SET label=@label WHERE location_id=@locationId AND mac=@mac AND subscription_id=@subscriptionId
`);
const removeDevice = db.prepare(`
  DELETE FROM tenant_devices WHERE location_id=@locationId AND mac=@mac AND subscription_id=@subscriptionId
`);

const businessPackageById = db.prepare(`
  SELECT * FROM business_packages WHERE id=? AND business_id=?
`);
const updateBusinessPackage = db.prepare(`
  UPDATE business_packages SET name=@name, price=@price, seconds=@seconds
   WHERE id=@id AND business_id=@businessId
`);
const setBusinessPackageActive = db.prepare(`
  UPDATE business_packages SET active=@active WHERE id=@id AND business_id=@businessId
`);

const addVoucher = db.prepare(`
  INSERT INTO tenant_vouchers (code, business_id, location_id, package_id, package_name, seconds, batch)
  VALUES (@code, @businessId, @locationId, @packageId, @packageName, @seconds, @batch)
`);
const vouchersForBusiness = db.prepare(`
  SELECT v.code, v.location_id, l.name AS location_name, v.package_name, v.seconds, v.batch,
         v.created_at, v.redeemed_at, v.redeemed_by
    FROM tenant_vouchers v JOIN locations l ON l.id=v.location_id
   WHERE v.business_id=? ORDER BY v.created_at DESC LIMIT ?
`);
const openVoucher = db.prepare(`
  SELECT * FROM tenant_vouchers WHERE code=? AND location_id=? AND redeemed_at IS NULL
`);
const claimVoucher = db.prepare(`
  UPDATE tenant_vouchers SET redeemed_at=datetime('now'), redeemed_by=@phone, redeemed_mac=@mac
   WHERE code=@code AND location_id=@locationId AND redeemed_at IS NULL
`);
const markVoucherGranted = db.prepare(`
  UPDATE tenant_vouchers SET redeemed_subscription_id=? WHERE code=? AND location_id=?
`);

const salesSummary = db.prepare(`
  SELECT COUNT(*) AS payments, COALESCE(SUM(amount), 0) AS gross,
         COALESCE(SUM(COALESCE(platform_fee_minor, ROUND(platform_fee*100))), 0)/100.0 AS platform_fee,
         COUNT(DISTINCT mac) AS customers
    FROM tenant_transactions
   WHERE business_id=? AND status='paid' AND created_at >= ?
`);
const salesByLocation = db.prepare(`
  SELECT l.id, l.name, COUNT(t.checkout_request_id) AS payments, COALESCE(SUM(t.amount), 0) AS gross,
         COALESCE(SUM(COALESCE(t.platform_fee_minor, ROUND(t.platform_fee*100))), 0)/100.0 AS platform_fee
    FROM locations l LEFT JOIN tenant_transactions t
      ON t.location_id=l.id AND t.status='paid' AND t.created_at >= ?
   WHERE l.business_id=? GROUP BY l.id ORDER BY gross DESC, l.name
`);
const recentSales = db.prepare(`
  SELECT t.checkout_request_id, t.location_id, l.name AS location_name, t.phone, t.package_name,
         t.amount, t.status, t.mpesa_receipt, t.created_at
    FROM tenant_transactions t JOIN locations l ON l.id=t.location_id
   WHERE t.business_id=? ORDER BY t.created_at DESC LIMIT ?
`);
const paymentConnectionSummary = db.prepare(`
  SELECT collection_name, shortcode, transaction_type, last_verified_at, updated_at
    FROM tenant_mpesa_connections WHERE business_id=?
`);
const paymentConnection = db.prepare(`SELECT * FROM tenant_mpesa_connections WHERE business_id=?`);
const upsertPaymentConnection = db.prepare(`
  INSERT INTO tenant_mpesa_connections
    (business_id, collection_name, shortcode, transaction_type, consumer_key_cipher, consumer_secret_cipher, passkey_cipher, last_verified_at)
  VALUES (@businessId, @collectionName, @shortcode, @transactionType, @consumerKeyCipher, @consumerSecretCipher, @passkeyCipher, @lastVerifiedAt)
  ON CONFLICT(business_id) DO UPDATE SET
    collection_name=excluded.collection_name, shortcode=excluded.shortcode, transaction_type=excluded.transaction_type,
    consumer_key_cipher=excluded.consumer_key_cipher, consumer_secret_cipher=excluded.consumer_secret_cipher,
    passkey_cipher=excluded.passkey_cipher, last_verified_at=excluded.last_verified_at, updated_at=datetime('now')
`);
const insertBusinessBilling = db.prepare(`
  INSERT INTO business_billing_transactions
    (checkout_request_id, merchant_request_id, business_id, plan, phone, amount)
  VALUES (@checkoutRequestId, @merchantRequestId, @businessId, @plan, @phone, @amount)
`);
const businessBillingTransaction = db.prepare(`SELECT * FROM business_billing_transactions WHERE checkout_request_id=?`);
const setBusinessBillingResult = db.prepare(`
  UPDATE business_billing_transactions SET status=@status, result_code=@resultCode, result_desc=@resultDesc,
    mpesa_receipt=COALESCE(@receipt, mpesa_receipt), updated_at=datetime('now')
  WHERE checkout_request_id=@checkoutRequestId AND (status!='paid' OR @status='paid')
`);
const setBusinessBillingActivated = db.prepare(`
  UPDATE business_billing_transactions SET activated=1, updated_at=datetime('now') WHERE checkout_request_id=?
`);
const staleBusinessBilling = db.prepare(`
  SELECT * FROM business_billing_transactions WHERE status='pending'
    AND created_at <= datetime('now', '-' || ? || ' seconds')
    AND created_at > datetime('now', '-2 hours')
`);
const paidBusinessBilling = db.prepare(`
  SELECT * FROM business_billing_transactions WHERE status='paid' AND activated=0
    AND created_at > datetime('now', '-24 hours')
`);
const businessBillingGrant = db.prepare(`SELECT * FROM business_billing_grants WHERE checkout_request_id=?`);
const addBusinessBillingGrant = db.prepare(`
  INSERT INTO business_billing_grants (checkout_request_id, business_id, expires_at) VALUES (?, ?, ?)
`);
const setBusinessBilling = db.prepare(`
  UPDATE businesses SET plan=@plan, billing_status='active', billing_expires_at=@expiresAt WHERE id=@businessId
`);
const duplicateBusinessBillingReceipt = db.prepare(`
  SELECT checkout_request_id FROM business_billing_transactions
   WHERE mpesa_receipt=? AND checkout_request_id != ? LIMIT 1
`);

function createLocation({ id, businessId, name, routerName }) {
  const routerToken = crypto.randomBytes(24).toString('base64url');
  createLocationRow.run({ id, businessId, name, routerName: routerName || null,
    routerTokenHash: tokenHash(routerToken), routerTokenMarker: tokenMarker(routerToken) });
  return { id, businessId, name, routerName: routerName || null, routerToken };
}

function rotateLocationToken({ locationId, businessId }) {
  const location = locationForBusiness.get(locationId, businessId);
  if (!location) return null;
  const routerToken = crypto.randomBytes(24).toString('base64url');
  setLocationToken.run(tokenMarker(routerToken), tokenHash(routerToken), locationId);
  return { ...location, routerToken };
}

function updateLocationSettings({ locationId, businessId, name, routerName, hotspotServer }) {
  const current = locationForBusiness.get(locationId, businessId);
  if (!current) return null;
  updateLocation.run({ id: locationId, businessId, name: name || current.name,
    routerName: routerName || null, hotspotServer: hotspotServer || null });
  return locationForBusiness.get(locationId, businessId);
}

function authenticateRouter(locationId, rawToken, transport = 'header') {
  const location = locationById.get(locationId);
  if (location?.router_auth_mode === 'header' && transport !== 'header') return null;
  const expected = Buffer.from(location?.router_token_hash || '', 'hex');
  const supplied = Buffer.from(tokenHash(rawToken), 'hex');
  if (!location || !expected.length || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  touchRouter.run(locationId);
  return location;
}

function generatePassword() {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

function usernameFor({ locationId, payerPhone, mac }) {
  const existing = subscriptionByMac.get(locationId, mac);
  if (existing) return existing.router_username;
  return `${payerPhone}-${crypto.createHash('sha256').update(locationId + mac).digest('hex').slice(0, 8).toUpperCase()}`;
}

function grantSubscription({ transaction, profile = 'standard' }) {
  const existing = subscriptionByMac.get(transaction.location_id, transaction.mac);
  const id = existing?.id || `sub-${crypto.randomBytes(10).toString('hex')}`;
  const routerUsername = usernameFor({ locationId: transaction.location_id, payerPhone: transaction.phone, mac: transaction.mac });
  const password = existing?.password || generatePassword();
  const totalSeconds = (existing?.total_seconds || 0) + transaction.seconds;
  const oldExpiry = existing?.expires_at ? new Date(existing.expires_at.replace(' ', 'T') + 'Z').getTime() : 0;
  const expiresAt = nowSql(Math.max(Date.now(), Number.isFinite(oldExpiry) ? oldExpiry : 0) + transaction.seconds * 1000);
  upsertSubscription.run({ id, businessId: transaction.business_id, locationId: transaction.location_id,
    routerUsername, payerPhone: transaction.phone, mac: transaction.mac, password, totalSeconds, expiresAt });
  meterDevice.run(transaction.business_id, transaction.mac);
  const job = insertJob.run({ locationId: transaction.location_id, username: routerUsername, password, profile,
    totalSeconds, mac: transaction.mac, ip: transaction.ip || null, action: 'upsert' });
  // A top-up must refresh the TV's RouterOS ceiling too. Otherwise the
  // phone receives the extension but its paired TV disconnects early.
  for (const device of devicesForSubscription.all(transaction.location_id, id)) {
    insertJob.run({ locationId: transaction.location_id, username: `${routerUsername}-tv`, password, profile,
      totalSeconds, mac: device.mac, ip: null, action: 'upsert' });
  }
  return { id, username: routerUsername, password, totalSeconds, expiresAt,
    provisioningJobId: Number(job.lastInsertRowid) };
}

function transferSubscription({ locationId, payerPhone, subscriptionId, password, mac, ip, profile = 'standard' }) {
  const subscription = subscriptionForPayer.get(subscriptionId, locationId, payerPhone);
  if (!subscription) return null;
  const expected = Buffer.from(subscription.password);
  const supplied = Buffer.from(String(password || '').toUpperCase());
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return false;
  const expiry = new Date(subscription.expires_at.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  const occupying = subscriptionByMac.get(locationId, mac);
  if (occupying && occupying.id !== subscription.id) return { error: 'occupied' };
  if (deviceByMac.get(locationId, mac)) return { error: 'occupied' };
  meterDevice.run(subscription.business_id, subscription.mac);
  meterDevice.run(subscription.business_id, mac);
  setSubscriptionMac.run({ id: subscription.id, locationId, mac });
  const job = insertJob.run({ locationId, username: subscription.router_username, password: subscription.password,
    profile, totalSeconds: subscription.total_seconds, mac, ip: ip || null, action: 'transfer' });
  return { ...subscription, mac, provisioningJobId: Number(job.lastInsertRowid) };
}

function addTvDevice({ locationId, payerPhone, subscriptionId, password, mac, label, profile = 'standard' }) {
  const subscription = subscriptionForPayer.get(subscriptionId, locationId, payerPhone);
  if (!subscription) return { error: 'subscription' };
  const expected = Buffer.from(subscription.password);
  const supplied = Buffer.from(String(password || '').toUpperCase());
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return { error: 'password' };
  const expiry = new Date(subscription.expires_at.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return { error: 'expired' };
  if (subscription.mac === mac) return { error: 'same-device' };
  if (subscriptionByMac.get(locationId, mac)) return { error: 'owned' };
  const existingMac = deviceByMac.get(locationId, mac);
  if (existingMac && existingMac.subscription_id !== subscription.id) return { error: 'owned' };
  const existingDevice = deviceForSubscription.get(locationId, subscription.id);
  if (existingDevice && existingDevice.mac !== mac) return { error: 'limit', device: existingDevice };
  if (existingDevice) updateDevice.run({ locationId, mac, subscriptionId, label });
  else addDevice.run({ locationId, mac, subscriptionId, label });
  meterDevice.run(subscription.business_id, mac);
  const job = insertJob.run({ locationId, username: `${subscription.router_username}-tv`, password: subscription.password,
    profile, totalSeconds: subscription.total_seconds, mac, ip: null, action: 'upsert' });
  return { subscription, mac, label, provisioningJobId: Number(job.lastInsertRowid) };
}

function removeTvDevice({ locationId, payerPhone, subscriptionId, password, mac }) {
  const subscription = subscriptionForPayer.get(subscriptionId, locationId, payerPhone);
  if (!subscription) return false;
  const expected = Buffer.from(subscription.password);
  const supplied = Buffer.from(String(password || '').toUpperCase());
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return false;
  const removed = removeDevice.run({ locationId, mac, subscriptionId });
  if (!removed.changes) return false;
  insertJob.run({ locationId, username: `${subscription.router_username}-tv`, password: '2222', profile: 'standard',
    totalSeconds: 1, mac: null, ip: null, action: 'revoke' });
  return true;
}

function issueVouchers({ businessId, locationId, packageId, packageName, seconds, count, batch }) {
  const issued = [];
  for (let tries = 0; issued.length < count && tries < count * 5; tries++) {
    const code = `FITI${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    try {
      addVoucher.run({ code, businessId, locationId, packageId, packageName, seconds, batch: batch || null });
      issued.push(code);
    } catch (err) {
      if (!/UNIQUE/i.test(String(err.message))) throw err;
    }
  }
  if (issued.length !== count) throw new Error('Could not create unique voucher codes.');
  return issued;
}

function redeemVoucher({ locationId, code, phone, mac, ip, profile = 'standard' }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const voucher = openVoucher.get(code, locationId);
    if (!voucher) {
      db.exec('COMMIT');
      return null;
    }
    const claimed = claimVoucher.run({ code, locationId, phone, mac });
    if (!claimed.changes) {
      db.exec('COMMIT');
      return null;
    }
    const grant = grantSubscription({ transaction: {
      location_id: locationId, business_id: voucher.business_id, phone, mac, ip,
      seconds: voucher.seconds, checkout_request_id: `voucher-${voucher.code}`,
    }, profile });
    markVoucherGranted.run(grant.id, code, locationId);
    db.exec('COMMIT');
    return grant;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}

function queueExpiredSubscriptions(locationId) {
  const expired = expiredSubscriptionsNeedingJob.all(locationId);
  for (const subscription of expired) {
    const job = insertJob.run({ locationId, username: subscription.router_username, password: '2222',
      profile: 'standard', totalSeconds: 1, mac: null, ip: null, action: 'revoke' });
    // A TV has its own RouterOS identity and therefore its own local uptime
    // counter. Revoke it alongside the phone so a TV cannot outlive the
    // server's wall-clock expiry.
    for (const device of devicesForSubscription.all(locationId, subscription.id)) {
      insertJob.run({ locationId, username: `${subscription.router_username}-tv`, password: '2222',
        profile: 'standard', totalSeconds: 1, mac: null, ip: null, action: 'revoke' });
    }
    setExpiryJob.run(Number(job.lastInsertRowid), subscription.id, locationId);
  }
  return expired.length;
}

function savePaymentConnection({ businessId, collectionName, shortcode, transactionType, consumerKey, consumerSecret, passkey, verified = false }) {
  upsertPaymentConnection.run({ businessId, collectionName: collectionName || null, shortcode, transactionType,
    consumerKeyCipher: encryptSecret(consumerKey), consumerSecretCipher: encryptSecret(consumerSecret),
    passkeyCipher: encryptSecret(passkey), lastVerifiedAt: verified ? nowSql(Date.now()) : null });
  return paymentConnectionSummary.get(businessId);
}

function paymentCredentials(businessId) {
  const connection = paymentConnection.get(businessId);
  if (!connection) return null;
  return {
    shortcode: connection.shortcode,
    transactionType: connection.transaction_type,
    consumerKey: decryptSecret(connection.consumer_key_cipher),
    consumerSecret: decryptSecret(connection.consumer_secret_cipher),
    passkey: decryptSecret(connection.passkey_cipher),
  };
}

function activateBusinessBilling(checkoutRequestId, { periodDays = 30 } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const transaction = businessBillingTransaction.get(checkoutRequestId);
    if (!transaction) throw new Error('Unknown platform billing payment.');
    if (transaction.status !== 'paid') throw new Error('Platform billing payment is not settled.');
    const granted = businessBillingGrant.get(checkoutRequestId);
    if (granted) {
      db.exec('COMMIT');
      return { expiresAt: granted.expires_at, alreadyActivated: true };
    }
    const business = db.prepare(`SELECT billing_expires_at, billing_status, plan FROM businesses WHERE id=?`).get(transaction.business_id);
    if (!business) throw new Error('Business account is missing.');
    const currentExpiry = business.billing_expires_at ? new Date(business.billing_expires_at.replace(' ', 'T') + 'Z').getTime() : 0;
    let carryMs = Math.max(0, Number.isFinite(currentExpiry) ? currentExpiry - Date.now() : 0);
    // Carry prepaid value when switching tier, not the full number of days
    // bought at a cheaper price. Same-tier renewals retain every paid day.
    const rates = { starter: 1500, growth: 3500 };
    if (business.billing_status === 'active' && business.plan !== transaction.plan) {
      carryMs *= (rates[business.plan] || 0) / (rates[transaction.plan] || 1);
    }
    const expiresAt = nowSql(Date.now() + carryMs + periodDays * 86400_000);
    setBusinessBilling.run({ businessId: transaction.business_id, plan: transaction.plan, expiresAt });
    addBusinessBillingGrant.run(checkoutRequestId, transaction.business_id, expiresAt);
    setBusinessBillingActivated.run(checkoutRequestId);
    db.exec('COMMIT');
    return { expiresAt };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}

/**
 * Credit a paid tenant checkout exactly once.
 *
 * M-Pesa's callback is deliberately asynchronous while the customer portal
 * also queries status in the foreground.  Both can see success at nearly the
 * same time.  Keeping the claim, subscription extension and router job in
 * one SQLite transaction prevents an accidental double package.
 */
function provisionPaidTransaction(checkoutRequestId, { profile = 'standard' } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const transaction = getTransaction.get(checkoutRequestId);
    if (!transaction) throw new Error('Unknown tenant payment.');
    if (transaction.status !== 'paid') throw new Error('Tenant payment is not settled.');

    const granted = paymentGrant.get(checkoutRequestId);
    if (granted) {
      const existing = subscriptionById.get(granted.subscription_id, transaction.location_id);
      db.exec('COMMIT');
      if (!existing) throw new Error('Tenant payment grant is incomplete.');
      return {
        id: existing.id,
        username: existing.router_username,
        password: existing.password,
        totalSeconds: existing.total_seconds,
        expiresAt: existing.expires_at,
        alreadyProvisioned: true,
      };
    }

    const provisioned = grantSubscription({ transaction, profile });
    insertPaymentGrant.run(checkoutRequestId, provisioned.id);
    setTransactionProvisioned.run({ checkoutRequestId, subscriptionId: provisioned.id,
      provisioningJobId: provisioned.provisioningJobId });
    db.exec('COMMIT');
    return provisioned;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw err;
  }
}

module.exports = {
  tokenHash, createLocation, rotateLocationToken, updateLocationSettings, authenticateRouter, locationById, locationForBusiness, locationsForBusiness,
  packageForLocation, packagesForLocation, insertTransaction, getTransaction,
  setTransactionResult, setTransactionTerms, setTransactionPortalCapability, setTransactionProvisioned, staleTransactions, paidUnprovisioned, duplicateReceipt,
  subscriptionByMac, subscriptionsForPayer, subscriptionById, subscriptionForPayer, setSubscriptionMac,
  grantSubscription, provisionPaidTransaction, recordUsage, expiredSubscriptions, activeMeter,
  insertJob, pendingJobs, markDelivered, markAcked, jobById, pendingProvisioningJobForUsername, latestPaymentForMac, pendingPaymentForPhone,
  transferSubscription, addTvDevice, removeTvDevice, deviceForSubscription, devicesForSubscription,
  businessPackageById, updateBusinessPackage, setBusinessPackageActive,
  issueVouchers, redeemVoucher, vouchersForBusiness, salesSummary, salesByLocation, recentSales,
  paymentConnectionSummary, savePaymentConnection, paymentCredentials,
  insertBusinessBilling, businessBillingTransaction, setBusinessBillingResult, staleBusinessBilling,
  paidBusinessBilling, duplicateBusinessBillingReceipt, activateBusinessBilling,
  queueExpiredSubscriptions,
};

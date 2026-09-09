/**
 * Tenant runtime for WiFi Fiti for Business.
 *
 * The original tables remain the legacy single-site ledger. New businesses
 * use these tables, keyed by location, so one customer's phone/MAC can never
 * leak a balance, job or payment into another operator's hotspot.
 */
const crypto = require('crypto');
const { db } = require('./db');
const config = require('../config');
const {
  topologyFreshAt,
  validateRouterMapping,
  mappingFingerprint,
} = require('./router-topology');

const tokenHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
// `locations.router_token` existed in the first dashboard schema as a
// non-null UNIQUE column. New locations store only a hash, but retain a
// unique, non-secret marker there so old deployments continue to accept
// more than one location without persisting the usable router credential.
const tokenMarker = (value) => `hash:${tokenHash(value)}`;
const nowSql = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

function portalHostname(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || raw.length > 253) return null;
  try {
    const parsed = new URL(`https://${raw}`);
    if (parsed.hostname !== raw || parsed.port || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function managedPortalHostname(label, locationId) {
  const root = config.domains.portalRootDomain;
  if (!root) return null;
  let slug = String(label || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'wifi';
  // Location IDs currently contain 64 random bits. Keep all of that entropy
  // in generated labels: an eight-hex-character suffix would eventually
  // collide for common location names as the platform grows.
  const suffix = String(locationId || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-16) || 'portal';
  slug = slug.slice(0, Math.max(1, 63 - suffix.length - 1)).replace(/-+$/g, '') || 'wifi';
  return `${slug}-${suffix}.${root}`;
}

function managedPortalHostnameFromSlug(slug) {
  const root = config.domains.portalRootDomain;
  const label = String(slug || '').trim().toLowerCase();
  if (!root || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  return `${label}.${root}`;
}

const SYSTEM_PORTAL_LABELS = new Set([
  'www', 'cloud', 'app', 'api', 'admin', 'mail', 'smtp', 'ftp', 'status', 'help',
  'support', 'billing', 'dashboard', 'workers',
]);

function managedPortalSlugReserved(slug) {
  const label = String(slug || '').trim().toLowerCase();
  if (SYSTEM_PORTAL_LABELS.has(label)) return true;
  const root = config.domains.portalRootDomain;
  if (!root) return false;
  for (const host of [config.domains.appHost, config.domains.marketingHost, config.domains.legacyHost]) {
    const suffix = `.${root}`;
    if (host && host.endsWith(suffix) && host.slice(0, -suffix.length) === label) return true;
  }
  return false;
}

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
    rate_limit      TEXT,
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
    rate_limit          TEXT,
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
    rate_limit      TEXT,
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

  -- Remote support is a consent and lifecycle record only.  In particular,
  -- it must never become a convenient place to persist a WireGuard private
  -- key, a router password, or a generated VPN configuration.  Those remain
  -- outside the billing database until a dedicated hub integration exists.
  -- A location does not receive a row until its owner explicitly requests
  -- the optional service after pairing.
  CREATE TABLE IF NOT EXISTS tenant_remote_access (
    location_id         TEXT PRIMARY KEY,
    status              TEXT NOT NULL DEFAULT 'requested',
    requested_at        TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at         TEXT,
    configured_at       TEXT,
    revoked_at          TEXT,
    management_address  TEXT,
    hub_name            TEXT,
    -- Gateway selection is non-secret desired state kept long enough for
    -- the router's later public-key enrollment to create its peer record.
    vpn_gateway_id      TEXT,
    vpn_management_cidr TEXT,
    last_handshake_at   TEXT,
    -- This is the router's WireGuard *public* identifier only. It is not
    -- sufficient to connect to the router and must never be confused with
    -- a private key, peer configuration, or a support credential.
    router_public_key   TEXT,
    enrolled_at         TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(status IN ('requested', 'approved', 'configured', 'revoked'))
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_remote_access_status
    ON tenant_remote_access(status, updated_at);
  -- A management address is an inventory assignment, not a shared tenant
  -- network.  Keeping it unique prevents two routers being handed the same
  -- future VPN address during concurrent support work.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_remote_access_management_address
    ON tenant_remote_access(management_address)
    WHERE management_address IS NOT NULL AND status='configured';

  -- Keep a durable, append-only audit record of owner consent and platform
  -- lifecycle actions.  It intentionally contains no free-form secret or
  -- key material.
  CREATE TABLE IF NOT EXISTS tenant_remote_access_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id       TEXT NOT NULL,
    actor_type        TEXT NOT NULL,
    actor_id          TEXT NOT NULL,
    action            TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(actor_type IN ('business', 'admin', 'system')),
    CHECK(action IN ('requested', 'approved', 'configured', 'revoked'))
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_remote_access_events_location
    ON tenant_remote_access_events(location_id, id DESC);

  -- Router support controls deliberately have their own queue and their own
  -- acknowledgement channel. They must never share IDs with HotSpot
  -- provisioning jobs: a support revoke can then be retried independently
  -- without risking a customer-account action being acknowledged by mistake.
  -- activate is deliberately versioned and contains only a validated,
  -- non-secret WireGuard peer payload. Private keys stay on the router and
  -- gateway respectively; neither one belongs in this database.
  CREATE TABLE IF NOT EXISTS tenant_remote_support_controls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id   TEXT NOT NULL,
    action        TEXT NOT NULL,
    payload_json  TEXT,
    config_version INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at  TEXT,
    acked_at      TEXT,
    cancelled_at  TEXT,
    CHECK(action IN ('prepare', 'activate', 'revoke')),
    CHECK(config_version IS NULL OR config_version > 0)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_remote_support_controls_pending
    ON tenant_remote_support_controls(location_id, acked_at, cancelled_at, id);
  -- At most one outstanding command of a given kind is useful.  A newer
  -- control cancels every older unacknowledged one for this location below.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_remote_support_controls_one_pending
    ON tenant_remote_support_controls(location_id, action)
    WHERE acked_at IS NULL AND cancelled_at IS NULL;

  -- Desired peer state is intentionally separate from both the router's
  -- support-control queue and the WireGuard gateway. This gives the gateway
  -- a durable, replay-safe desired state if it restarts midway through an
  -- enrollment. It contains public keys, private tunnel addresses and opaque
  -- gateway IDs only. It must never contain a WireGuard private key, router
  -- administrator password, API token, or a full gateway configuration.
  CREATE TABLE IF NOT EXISTS tenant_vpn_peers (
    location_id               TEXT PRIMARY KEY REFERENCES locations(id),
    gateway_id                TEXT NOT NULL,
    gateway_name              TEXT NOT NULL,
    management_address        TEXT NOT NULL,
    router_public_key         TEXT NOT NULL,
    gateway_public_key        TEXT,
    desired_state             TEXT NOT NULL DEFAULT 'active',
    config_version            INTEGER NOT NULL DEFAULT 1,
    gateway_peer_id           TEXT,
    gateway_state             TEXT NOT NULL DEFAULT 'pending',
    gateway_synced_at         TEXT,
    gateway_error             TEXT,
    -- A validated, non-secret router activation payload is retained only
    -- while the desired peer is active, so an unacknowledged prepare
    -- control can later release the matching activate control safely.
    activation_payload_json   TEXT,
    last_handshake_at         TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at                TEXT,
    CHECK(desired_state IN ('active', 'revoked')),
    CHECK(config_version > 0),
    CHECK(gateway_state IN ('pending', 'ready', 'error', 'revoke_pending', 'revoked'))
  );

  -- The router inventory is intentionally not a configuration backup. It is
  -- a small validated snapshot of interface, bridge and Wi-Fi relationships
  -- reported by the paired router through its existing outbound poll. It
  -- never stores a password, MAC address, IP address, route, user, security
  -- profile, private key, or packet/traffic information.
  CREATE TABLE IF NOT EXISTS tenant_router_topologies (
    location_id       TEXT PRIMARY KEY REFERENCES locations(id),
    schema_version    INTEGER NOT NULL,
    fingerprint       TEXT NOT NULL,
    topology_json     TEXT NOT NULL,
    first_reported_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_reported_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(schema_version = 1),
    CHECK(length(fingerprint) = 64)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_router_topologies_reported
    ON tenant_router_topologies(last_reported_at);

  -- A mapping is owner-confirmed descriptive metadata, not a command queue.
  -- Its fingerprint binds it to one exact router inventory snapshot. If the
  -- router topology changes, the UI must request a fresh confirmation rather
  -- than silently applying an old port layout to a new router.
  CREATE TABLE IF NOT EXISTS tenant_router_mappings (
    location_id          TEXT PRIMARY KEY REFERENCES locations(id),
    schema_version       INTEGER NOT NULL,
    topology_fingerprint TEXT NOT NULL,
    mapping_fingerprint  TEXT NOT NULL,
    mapping_json         TEXT NOT NULL,
    confirmed_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(schema_version = 1),
    CHECK(length(topology_fingerprint) = 64),
    CHECK(length(mapping_fingerprint) = 64)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_router_mappings_topology
    ON tenant_router_mappings(topology_fingerprint);

  -- A remote mapped deployment is a small, signed, owner-requested action
  -- queue. It is intentionally distinct from WireGuard lifecycle controls
  -- and customer-provisioning jobs: a port-map verification must never
  -- acknowledge a VPN peer operation or alter paid customer access.
  --
  -- payload_json is generated only from the server's current validated
  -- inventory + owner-confirmed map. Browser input never reaches this table
  -- as RouterOS source. signature is an HMAC over the canonical envelope;
  -- it is verified again immediately before an action can become RouterOS
  -- source. nonce is a non-secret unique replay component used to derive
  -- the router's one-time acknowledgement receipt without persisting that
  -- receipt itself.
  CREATE TABLE IF NOT EXISTS tenant_mapped_deployments (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id          TEXT NOT NULL REFERENCES locations(id),
    action               TEXT NOT NULL,
    topology_fingerprint TEXT NOT NULL,
    mapping_fingerprint  TEXT NOT NULL,
    payload_json         TEXT NOT NULL,
    nonce                TEXT NOT NULL UNIQUE,
    signature            TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'queued',
    error_code           TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at         TEXT,
    acknowledged_at      TEXT,
    cancelled_at         TEXT,
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(action = 'apply_mapped_service_v1'),
    CHECK(length(topology_fingerprint) = 64),
    CHECK(length(mapping_fingerprint) = 64),
    CHECK(status IN ('queued', 'delivered', 'acknowledged', 'cancelled', 'stale', 'failed')),
    CHECK(error_code IS NULL OR error_code IN ('mapping_stale', 'replacement_pending', 'remote_access_revoked', 'invalid_signature', 'invalid_payload', 'superseded'))
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_mapped_deployments_location
    ON tenant_mapped_deployments(location_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_tenant_mapped_deployments_pending
    ON tenant_mapped_deployments(location_id, status, delivered_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_mapped_deployments_one_pending
    ON tenant_mapped_deployments(location_id, action)
    WHERE status IN ('queued', 'delivered');

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
    rate_limit              TEXT,
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

  -- A hostname belongs to exactly one location. Old hostnames remain as
  -- aliases when a business changes its public address, so an already paired
  -- router does not strand customers at a dead captive portal.
  CREATE TABLE IF NOT EXISTS tenant_portal_domains (
    hostname    TEXT PRIMARY KEY COLLATE NOCASE,
    location_id TEXT NOT NULL REFERENCES locations(id),
    kind        TEXT NOT NULL DEFAULT 'managed',
    status      TEXT NOT NULL DEFAULT 'active',
    is_primary  INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(kind IN ('managed', 'custom')),
    CHECK(status IN ('pending', 'active', 'disabled')),
    CHECK(is_primary IN (0, 1))
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_portal_domains_location
    ON tenant_portal_domains(location_id, status, is_primary);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_portal_domains_primary
    ON tenant_portal_domains(location_id) WHERE is_primary=1 AND status='active';
`);

for (const statement of [
  `ALTER TABLE locations ADD COLUMN router_token_hash TEXT`,
  `ALTER TABLE locations ADD COLUMN router_pending_token_hash TEXT`,
  `ALTER TABLE locations ADD COLUMN router_pending_token_expires_at TEXT`,
  // Existing paired locations used a URL token. New pairings use an HTTP
  // header so the secret never lands in RouterOS fetch URLs or web logs.
  `ALTER TABLE locations ADD COLUMN router_auth_mode TEXT NOT NULL DEFAULT 'query'`,
  `ALTER TABLE locations ADD COLUMN router_status TEXT NOT NULL DEFAULT 'waiting'`,
  `ALTER TABLE locations ADD COLUMN last_seen_at TEXT`,
  // `last_seen_at` is router-health telemetry: any authenticated router
  // endpoint may update it. Remote-support consent has a stronger
  // prerequisite, so it is deliberately tied to a completed /router/sync
  // round-trip instead of generic authentication activity.
  `ALTER TABLE locations ADD COLUMN last_successful_sync_at TEXT`,
  `ALTER TABLE locations ADD COLUMN hotspot_server TEXT`,
  `ALTER TABLE locations ADD COLUMN setup_mode TEXT`,
  `ALTER TABLE locations ADD COLUMN router_model TEXT`,
  `ALTER TABLE locations ADD COLUMN routeros_version TEXT`,
  `ALTER TABLE locations ADD COLUMN wifi_stack TEXT`,
  `ALTER TABLE locations ADD COLUMN customer_bridge TEXT`,
  `ALTER TABLE locations ADD COLUMN wan_interface TEXT`,
  `ALTER TABLE locations ADD COLUMN wifi_interface TEXT`,
  `ALTER TABLE locations ADD COLUMN wifi_ssid TEXT`,
  `ALTER TABLE locations ADD COLUMN customer_ports TEXT`,
  `ALTER TABLE locations ADD COLUMN hotspot_subnet TEXT`,
  `ALTER TABLE tenant_transactions ADD COLUMN provisioning_job_id INTEGER`,
  `ALTER TABLE tenant_transactions ADD COLUMN payment_source TEXT NOT NULL DEFAULT 'fiti'`,
  `ALTER TABLE tenant_transactions ADD COLUMN platform_fee INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tenant_transactions ADD COLUMN platform_fee_minor INTEGER`,
  `ALTER TABLE tenant_transactions ADD COLUMN portal_token_hash TEXT`,
  `ALTER TABLE tenant_transactions ADD COLUMN portal_token_expires_at TEXT`,
  `ALTER TABLE tenant_transactions ADD COLUMN rate_limit TEXT`,
  `ALTER TABLE tenant_subscriptions ADD COLUMN expiry_job_id INTEGER`,
  `ALTER TABLE tenant_subscriptions ADD COLUMN rate_limit TEXT`,
  `ALTER TABLE tenant_jobs ADD COLUMN rate_limit TEXT`,
  `ALTER TABLE tenant_vouchers ADD COLUMN rate_limit TEXT`,
  // An earlier version of the optional-support lifecycle did not retain the
  // router's non-secret public identifier. Keep this migration additive so
  // existing customer databases receive it without a table rebuild.
  `ALTER TABLE tenant_remote_access ADD COLUMN router_public_key TEXT`,
  `ALTER TABLE tenant_remote_access ADD COLUMN enrolled_at TEXT`,
  `ALTER TABLE tenant_remote_access ADD COLUMN vpn_gateway_id TEXT`,
  `ALTER TABLE tenant_remote_access ADD COLUMN vpn_management_cidr TEXT`,
  // The first remote-support queue only understood prepare/revoke. Keep the
  // schema upgrade additive before rebuilding its CHECK constraint below, so
  // a deployment interrupted between releases never loses an outstanding
  // cleanup control.
  `ALTER TABLE tenant_remote_support_controls ADD COLUMN payload_json TEXT`,
  `ALTER TABLE tenant_remote_support_controls ADD COLUMN config_version INTEGER`,
  `ALTER TABLE tenant_vpn_peers ADD COLUMN gateway_id TEXT`,
  `ALTER TABLE tenant_vpn_peers ADD COLUMN gateway_public_key TEXT`,
]) {
  try { db.exec(statement); } catch { /* existing deployment */ }
}

// SQLite cannot alter a CHECK constraint in place. Older deployments created
// tenant_remote_support_controls with CHECK(action IN ('prepare','revoke'));
// rebuild that one small queue atomically so they can receive the versioned
// non-secret `activate` control without dropping any pending cleanup work.
function migrateRemoteSupportControlsSchema() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tenant_remote_support_controls'`).get();
  if (!row || /['"]activate['"]/i.test(String(row.sql || ''))) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE tenant_remote_support_controls_next (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id    TEXT NOT NULL,
        action         TEXT NOT NULL,
        payload_json   TEXT,
        config_version INTEGER,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at   TEXT,
        acked_at       TEXT,
        cancelled_at   TEXT,
        CHECK(action IN ('prepare', 'activate', 'revoke')),
        CHECK(config_version IS NULL OR config_version > 0)
      );
      INSERT INTO tenant_remote_support_controls_next
        (id, location_id, action, payload_json, config_version, created_at, delivered_at, acked_at, cancelled_at)
      SELECT id, location_id, action, payload_json, config_version, created_at, delivered_at, acked_at, cancelled_at
        FROM tenant_remote_support_controls;
      DROP TABLE tenant_remote_support_controls;
      ALTER TABLE tenant_remote_support_controls_next RENAME TO tenant_remote_support_controls;
      CREATE INDEX idx_tenant_remote_support_controls_pending
        ON tenant_remote_support_controls(location_id, acked_at, cancelled_at, id);
      CREATE UNIQUE INDEX idx_tenant_remote_support_controls_one_pending
        ON tenant_remote_support_controls(location_id, action)
        WHERE acked_at IS NULL AND cancelled_at IS NULL;
    `);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
}

migrateRemoteSupportControlsSchema();

// These indexes follow the additive peer-column migrations so a short-lived
// pre-release database that already has tenant_vpn_peers can upgrade before
// SQLite is asked to index the new gateway_id column.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tenant_vpn_peers_gateway_state
    ON tenant_vpn_peers(gateway_id, desired_state, gateway_state, updated_at);
  CREATE INDEX IF NOT EXISTS idx_tenant_vpn_peers_gateway_lookup
    ON tenant_vpn_peers(gateway_id, config_version);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_vpn_peers_active_management_address
    ON tenant_vpn_peers(management_address)
    WHERE desired_state='active';
  -- One WireGuard public key belongs to one actively managed router. Without
  -- this, two locations could make a gateway's desired snapshot impossible
  -- to reconcile safely (one key cannot own two different /32 addresses).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_vpn_peers_active_router_public_key
    ON tenant_vpn_peers(router_public_key)
    WHERE desired_state='active';
`);

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

const addPortalDomain = db.prepare(`
  INSERT INTO tenant_portal_domains (hostname, location_id, kind, status, is_primary)
  VALUES (@hostname, @locationId, @kind, @status, @isPrimary)
`);
const primaryPortalDomain = db.prepare(`
  SELECT hostname, location_id, kind, status, is_primary, created_at
    FROM tenant_portal_domains
   WHERE location_id=? AND status='active' AND is_primary=1
   ORDER BY created_at DESC LIMIT 1
`);
const portalDomainByHostname = db.prepare(`
  SELECT hostname, location_id, kind, status, is_primary, created_at
    FROM tenant_portal_domains
   WHERE hostname=? AND status='active'
   LIMIT 1
`);
const portalDomainByHostnameAnyStatus = db.prepare(`
  SELECT hostname, location_id, kind, status, is_primary, created_at
    FROM tenant_portal_domains
   WHERE hostname=?
   LIMIT 1
`);
const portalDomainForLocationHostname = db.prepare(`
  SELECT hostname, location_id, kind, status, is_primary, created_at
    FROM tenant_portal_domains
   WHERE hostname=? AND location_id=? AND status='active'
   LIMIT 1
`);
const deactivatePrimaryPortalDomains = db.prepare(`
  UPDATE tenant_portal_domains SET is_primary=0
   WHERE location_id=? AND status='active' AND is_primary=1
`);
const activatePortalDomain = db.prepare(`
  UPDATE tenant_portal_domains SET status='active', is_primary=1
   WHERE hostname=? AND location_id=?
`);
const portalDomainsForLocation = db.prepare(`
  SELECT hostname, kind, status, is_primary, created_at
    FROM tenant_portal_domains WHERE location_id=? ORDER BY is_primary DESC, created_at DESC
`);
const activePortalDomainCountForLocation = db.prepare(`
  SELECT COUNT(*) AS count FROM tenant_portal_domains
   WHERE location_id=? AND status='active'
`);
const MAX_ACTIVE_PORTAL_DOMAINS_PER_LOCATION = 3;

// Customer hostnames are never generated as a side effect of starting the
// server. They are created only after the router has completed the
// receipt-backed setup handshake; existing, already-saved portal domains
// remain untouched.

const createLocationRow = db.prepare(`
  INSERT INTO locations
    (id, business_id, name, router_token, router_token_hash, router_auth_mode, router_name,
     hotspot_server, setup_mode, router_model, routeros_version, wifi_stack, customer_bridge,
     wan_interface, wifi_interface, wifi_ssid, customer_ports, hotspot_subnet)
  VALUES
    (@id, @businessId, @name, @routerTokenMarker, @routerTokenHash, 'header', @routerName,
     @hotspotServer, @setupMode, @routerModel, @routerOsVersion, @wifiStack, @customerBridge,
     @wanInterface, @wifiInterface, @wifiSsid, @customerPorts, @hotspotSubnet)
`);
const locationById = db.prepare(`
  SELECT l.id, l.business_id, l.name, l.router_name, l.hotspot_server, l.router_token_hash, l.router_pending_token_hash, l.router_pending_token_expires_at, l.router_pending_setup_json, l.router_auth_mode, l.router_status, l.last_seen_at, l.last_router_contact_at, l.last_successful_sync_at, l.router_setup_nonce, l.router_pending_setup_nonce, l.router_setup_verified_at, l.router_setup_health, l.router_setup_checked_at, l.portal_setup_completed_at, l.router_portal_update_sent_host, l.router_portal_applied_host,
         l.setup_mode, l.router_model, l.routeros_version, l.wifi_stack, l.customer_bridge, l.wan_interface, l.wifi_interface, l.wifi_ssid, l.customer_ports, l.hotspot_subnet,
         b.name AS business_name, b.portal_name, b.support_phone, b.brand_primary_color, b.brand_logo_path, b.portal_message, b.collection_mode, b.plan AS business_plan,
         b.billing_status, b.billing_expires_at,
         (SELECT d.hostname FROM tenant_portal_domains d WHERE d.location_id=l.id AND d.status='active' AND d.is_primary=1 ORDER BY d.created_at DESC LIMIT 1) AS portal_hostname
    FROM locations l JOIN businesses b ON b.id = l.business_id
   WHERE l.id = ?
`);
const locationsForBusinessQuery = db.prepare(`
  SELECT id, name, router_name, hotspot_server, setup_mode, router_model, routeros_version,
         wifi_stack, customer_bridge, wan_interface, wifi_interface, wifi_ssid, customer_ports, hotspot_subnet,
         CASE WHEN router_status='online' AND (last_seen_at IS NULL OR last_seen_at <= datetime('now','-90 seconds'))
              THEN 'offline' ELSE router_status END AS router_status,
         last_seen_at, last_router_contact_at, last_successful_sync_at,
         router_setup_verified_at, router_setup_health, router_setup_checked_at,
         portal_setup_completed_at, router_portal_update_sent_host, router_portal_applied_host, created_at,
         CASE WHEN router_pending_token_hash IS NOT NULL
                    AND router_pending_token_expires_at > datetime('now')
              THEN 1 ELSE 0 END AS router_pairing_pending,
         CASE WHEN (router_pending_token_hash IS NULL
                    OR router_pending_token_expires_at <= datetime('now'))
                    AND router_setup_verified_at IS NOT NULL
                    AND last_successful_sync_at > datetime('now','-90 seconds')
              THEN 1 ELSE 0 END AS router_sync_healthy,
         (SELECT d.hostname FROM tenant_portal_domains d WHERE d.location_id=locations.id AND d.status='active' AND d.is_primary=1 ORDER BY d.created_at DESC LIMIT 1) AS portal_hostname,
         COALESCE((SELECT r.status FROM tenant_remote_access r WHERE r.location_id=locations.id), 'not_requested') AS remote_access_status
    FROM locations WHERE business_id = ? ORDER BY created_at
`);
// Keep pairing-token state private: the owner UI only needs to know whether
// a replacement kit is still waiting to check in, never its token or expiry.
// Convert SQLite's 0/1 result into a real JavaScript boolean for every caller.
const locationsForBusiness = {
  all(businessId) {
    return locationsForBusinessQuery.all(businessId).map((location) => ({
      ...location,
      router_pairing_pending: Boolean(location.router_pairing_pending),
      router_sync_healthy: Boolean(location.router_sync_healthy),
    }));
  },
};
const touchRouter = db.prepare(`
  UPDATE locations SET last_router_contact_at = datetime('now') WHERE id = ?
`);
// Only a receipt-backed tenant /api/router/sync round trip calls this
// statement. Other authenticated routes are useful contact telemetry, but
// must never make a router live, unlock support, or promote a replacement.
const markSuccessfulRouterSync = db.prepare(`
  UPDATE locations
     SET router_status = 'online', last_seen_at = datetime('now'),
         last_router_contact_at = datetime('now'),
         last_successful_sync_at = datetime('now')
   WHERE id = ?
`);
const markRouterPortalUpdateSent = db.prepare(`
  UPDATE locations SET router_portal_update_sent_host=? WHERE id=?
`);
const markRouterPortalApplied = db.prepare(`
  UPDATE locations SET router_portal_applied_host=? WHERE id=?
`);
const stageLocationToken = db.prepare(`
  UPDATE locations
     SET router_pending_token_hash=@tokenHash,
         router_pending_token_expires_at=@expiresAt,
         router_pending_setup_nonce=NULL,
         router_pending_setup_json=@pendingSetupJson
   WHERE id=@locationId
`);
const promotePendingLocationToken = db.prepare(`
  UPDATE locations
     SET router_token=@routerTokenMarker, router_token_hash=@routerTokenHash, router_auth_mode='header',
         name=@name, router_name=@routerName, hotspot_server=@hotspotServer,
         setup_mode=@setupMode, router_model=@routerModel, routeros_version=@routerOsVersion,
         wifi_stack=@wifiStack, customer_bridge=@customerBridge, wan_interface=@wanInterface,
         wifi_interface=@wifiInterface, wifi_ssid=@wifiSsid, customer_ports=@customerPorts,
         hotspot_subnet=@hotspotSubnet,
         router_pending_token_hash=NULL, router_pending_token_expires_at=NULL,
         router_pending_setup_nonce=NULL, router_pending_setup_json=NULL,
         router_setup_nonce=NULL, router_setup_verified_at=datetime('now'),
         router_setup_health=@health, router_setup_checked_at=datetime('now'),
         router_status='online', last_router_contact_at=datetime('now'), last_seen_at=datetime('now'),
         last_successful_sync_at=datetime('now')
   WHERE id=@locationId AND router_pending_token_hash=@routerTokenHash
     AND router_pending_setup_nonce=@nonce
     AND router_pending_token_expires_at > datetime('now')
`);
const setRouterSetupNonce = db.prepare(`
  UPDATE locations
     SET router_setup_nonce=@nonce, router_setup_health=@health,
         router_setup_checked_at=datetime('now'), last_router_contact_at=datetime('now')
   WHERE id=@locationId
`);
const setPendingRouterSetupNonce = db.prepare(`
  UPDATE locations
     SET router_pending_setup_nonce=@nonce, router_setup_health=@health,
         router_setup_checked_at=datetime('now'), last_router_contact_at=datetime('now')
   WHERE id=@locationId AND router_pending_token_hash=@routerTokenHash
     AND router_pending_token_expires_at > datetime('now')
`);
const verifyActiveRouterSetup = db.prepare(`
  UPDATE locations
     SET router_setup_nonce=NULL, router_setup_verified_at=COALESCE(router_setup_verified_at, datetime('now')),
         router_setup_health=@health, router_setup_checked_at=datetime('now'),
         router_status='online', last_router_contact_at=datetime('now'), last_seen_at=datetime('now'),
         last_successful_sync_at=datetime('now')
   WHERE id=@locationId
`);
const completeTenantLocationPortalSetup = db.prepare(`
  UPDATE locations
     SET portal_setup_completed_at=COALESCE(portal_setup_completed_at, datetime('now'))
   WHERE id=@locationId
`);
const completeTenantBusinessPortalSetup = db.prepare(`
  UPDATE businesses
     SET portal_setup_completed_at=COALESCE(portal_setup_completed_at, datetime('now'))
   WHERE id=@businessId
`);
const locationForBusiness = db.prepare(`
  SELECT id, business_id, name, router_name, router_status, last_seen_at, last_router_contact_at, last_successful_sync_at,
         router_setup_verified_at, router_setup_health, router_setup_checked_at,
         portal_setup_completed_at, router_portal_update_sent_host, router_portal_applied_host, hotspot_server,
         setup_mode, router_model, routeros_version, wifi_stack, customer_bridge, wan_interface,
         wifi_interface, wifi_ssid, customer_ports, hotspot_subnet,
         CASE WHEN router_pending_token_hash IS NOT NULL
                    AND router_pending_token_expires_at > datetime('now')
              THEN 1 ELSE 0 END AS router_pairing_pending,
         (SELECT d.hostname FROM tenant_portal_domains d WHERE d.location_id=locations.id AND d.status='active' AND d.is_primary=1 ORDER BY d.created_at DESC LIMIT 1) AS portal_hostname
    FROM locations WHERE id=? AND business_id=?
`);
const updateLocation = db.prepare(`
  UPDATE locations SET name=@name, router_name=@routerName, hotspot_server=@hotspotServer,
    setup_mode=@setupMode, router_model=@routerModel, routeros_version=@routerOsVersion,
    wifi_stack=@wifiStack, customer_bridge=@customerBridge, wan_interface=@wanInterface,
    wifi_interface=@wifiInterface, wifi_ssid=@wifiSsid, customer_ports=@customerPorts,
    hotspot_subnet=@hotspotSubnet
   WHERE id=@id AND business_id=@businessId
`);
// Inventory and mapping are deliberately isolated from `locations`: setup
// fields are the owner-requested configuration, while these rows are the
// router-observed topology and the owner's confirmation of that observation.
const routerTopologyByLocation = db.prepare(`
  SELECT location_id, schema_version, fingerprint, topology_json,
         first_reported_at, last_reported_at, updated_at
    FROM tenant_router_topologies WHERE location_id=?
`);
const insertRouterTopology = db.prepare(`
  INSERT INTO tenant_router_topologies
    (location_id, schema_version, fingerprint, topology_json)
  VALUES (@locationId, 1, @fingerprint, @topologyJson)
`);
const replaceRouterTopology = db.prepare(`
  UPDATE tenant_router_topologies
     SET fingerprint=@fingerprint, topology_json=@topologyJson,
         last_reported_at=datetime('now'), updated_at=datetime('now')
   WHERE location_id=@locationId
`);
// A poll runs every few seconds. The topology is static most of the time, so
// retain a truthful freshness signal without generating a database write for
// every otherwise unchanged customer usage report.
const touchRouterTopology = db.prepare(`
  UPDATE tenant_router_topologies
     SET last_reported_at=datetime('now')
   WHERE location_id=? AND last_reported_at <= datetime('now','-90 seconds')
`);
const routerMappingByLocation = db.prepare(`
  SELECT location_id, schema_version, topology_fingerprint, mapping_fingerprint,
         mapping_json, confirmed_at, updated_at
    FROM tenant_router_mappings WHERE location_id=?
`);
const saveRouterMapping = db.prepare(`
  INSERT INTO tenant_router_mappings
    (location_id, schema_version, topology_fingerprint, mapping_fingerprint, mapping_json)
  VALUES (@locationId, 1, @topologyFingerprint, @mappingFingerprint, @mappingJson)
  ON CONFLICT(location_id) DO UPDATE SET
    schema_version=excluded.schema_version,
    topology_fingerprint=excluded.topology_fingerprint,
    mapping_fingerprint=excluded.mapping_fingerprint,
    mapping_json=excluded.mapping_json,
    confirmed_at=datetime('now'),
    updated_at=datetime('now')
`);
const mappedDeploymentById = db.prepare(`
  SELECT id, location_id, action, topology_fingerprint, mapping_fingerprint,
         payload_json, nonce, signature, status, error_code,
         created_at, delivered_at, acknowledged_at, cancelled_at, updated_at
    FROM tenant_mapped_deployments
   WHERE id=? AND location_id=?
`);
const latestMappedDeploymentByLocation = db.prepare(`
  SELECT id, location_id, action, topology_fingerprint, mapping_fingerprint,
         payload_json, nonce, signature, status, error_code,
         created_at, delivered_at, acknowledged_at, cancelled_at, updated_at
    FROM tenant_mapped_deployments
   WHERE location_id=?
   ORDER BY id DESC LIMIT 1
`);
const activeMappedDeploymentByLocation = db.prepare(`
  SELECT id, location_id, action, topology_fingerprint, mapping_fingerprint,
         payload_json, nonce, signature, status, error_code,
         created_at, delivered_at, acknowledged_at, cancelled_at, updated_at
    FROM tenant_mapped_deployments
   WHERE location_id=? AND status IN ('queued', 'delivered')
   ORDER BY id DESC LIMIT 1
`);
const insertMappedDeployment = db.prepare(`
  INSERT INTO tenant_mapped_deployments
    (location_id, action, topology_fingerprint, mapping_fingerprint, payload_json, nonce, signature)
  VALUES (@locationId, @action, @topologyFingerprint, @mappingFingerprint, @payloadJson, @nonce, @signature)
`);
const setMappedDeploymentSignature = db.prepare(`
  UPDATE tenant_mapped_deployments
     SET signature=@signature, updated_at=datetime('now')
   WHERE id=@id AND location_id=@locationId AND signature=''
`);
const markMappedDeploymentDelivered = db.prepare(`
  UPDATE tenant_mapped_deployments
     SET status='delivered', delivered_at=datetime('now'), updated_at=datetime('now')
   WHERE id=? AND location_id=? AND status IN ('queued', 'delivered')
`);
const acknowledgeMappedDeployment = db.prepare(`
  UPDATE tenant_mapped_deployments
     SET status='acknowledged', acknowledged_at=COALESCE(acknowledged_at, datetime('now')),
         error_code=NULL, updated_at=datetime('now')
   WHERE id=? AND location_id=? AND status IN ('queued', 'delivered')
`);
const markMappedDeploymentState = db.prepare(`
  UPDATE tenant_mapped_deployments
     SET status=@status, error_code=@errorCode,
         cancelled_at=CASE WHEN @status='cancelled' THEN COALESCE(cancelled_at, datetime('now')) ELSE cancelled_at END,
         updated_at=datetime('now')
   WHERE id=@id AND location_id=@locationId AND status IN ('queued', 'delivered')
`);
const cancelPendingMappedDeployments = db.prepare(`
  UPDATE tenant_mapped_deployments
     SET status='cancelled', error_code=@errorCode,
         cancelled_at=datetime('now'), updated_at=datetime('now')
   WHERE location_id=@locationId AND status IN ('queued', 'delivered')
`);
// A staged replacement has a new pairing credential and may represent an
// entirely different board.  Never let its owner see, reconfirm, or inherit
// the prior router's descriptive map while that credential is waiting to
// prove itself.  The two rows are observational metadata only, so clearing
// them cannot affect paid customers or the active router's job queue.
const deleteRouterMapping = db.prepare(`DELETE FROM tenant_router_mappings WHERE location_id=?`);
const deleteRouterTopology = db.prepare(`DELETE FROM tenant_router_topologies WHERE location_id=?`);
// A location may be discarded only while it is a genuinely unused setup
// draft. Most tenant tables intentionally do not use cascading foreign keys:
// payment and customer history must survive ordinary lifecycle operations.
// Keep the eligibility check explicit and conservative instead of risking an
// orphaned paid checkout, subscription, voucher, job, or support lifecycle.
const unusedLocationForDiscard = db.prepare(`
  SELECT l.id, l.name, l.router_status, l.last_seen_at, l.last_router_contact_at, l.last_successful_sync_at,
         (SELECT COUNT(*) FROM tenant_transactions WHERE location_id=l.id) AS transaction_count,
         (SELECT COUNT(*) FROM tenant_subscriptions WHERE location_id=l.id) AS subscription_count,
         (SELECT COUNT(*) FROM tenant_jobs WHERE location_id=l.id) AS job_count,
         (SELECT COUNT(*) FROM tenant_devices WHERE location_id=l.id) AS device_count,
         (SELECT COUNT(*) FROM tenant_vouchers WHERE location_id=l.id) AS voucher_count,
         (SELECT COUNT(*) FROM tenant_remote_access WHERE location_id=l.id) AS remote_access_count,
         (SELECT COUNT(*) FROM tenant_remote_access_events WHERE location_id=l.id) AS remote_access_event_count,
         (SELECT COUNT(*) FROM tenant_remote_support_controls WHERE location_id=l.id) AS remote_control_count,
         (SELECT COUNT(*) FROM tenant_vpn_peers WHERE location_id=l.id) AS vpn_peer_count,
         (SELECT COUNT(*) FROM tenant_router_topologies WHERE location_id=l.id) AS topology_count,
         (SELECT COUNT(*) FROM tenant_router_mappings WHERE location_id=l.id) AS mapping_count,
         (SELECT COUNT(*) FROM tenant_mapped_deployments WHERE location_id=l.id) AS mapped_deployment_count
    FROM locations l
   WHERE l.id=@locationId AND l.business_id=@businessId
`);
const deletePortalDomainsForLocation = db.prepare(`DELETE FROM tenant_portal_domains WHERE location_id=?`);
const deleteLocationForBusiness = db.prepare(`DELETE FROM locations WHERE id=? AND business_id=?`);
const databaseTableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`);

const remoteAccessByLocation = db.prepare(`
  SELECT location_id, status, requested_at, approved_at, configured_at, revoked_at,
         management_address, hub_name, vpn_gateway_id, vpn_management_cidr,
         last_handshake_at, router_public_key,
         enrolled_at, updated_at
    FROM tenant_remote_access WHERE location_id=?
`);
const remoteAccessByManagementAddress = db.prepare(`
  SELECT location_id FROM tenant_remote_access
   WHERE management_address=? AND status='configured' LIMIT 1
`);
const vpnPeerByLocation = db.prepare(`
  SELECT location_id, gateway_id, gateway_name, management_address, router_public_key, gateway_public_key,
         desired_state, config_version, gateway_peer_id, gateway_state,
         gateway_synced_at, gateway_error, activation_payload_json,
         last_handshake_at, created_at, updated_at, revoked_at
    FROM tenant_vpn_peers WHERE location_id=?
`);
const activeVpnPeerByManagementAddress = db.prepare(`
  SELECT location_id FROM tenant_vpn_peers
   WHERE management_address=? AND desired_state='active' LIMIT 1
`);
const activeVpnPeerByRouterPublicKey = db.prepare(`
  SELECT location_id FROM tenant_vpn_peers
   WHERE router_public_key=? AND desired_state='active' LIMIT 1
`);
const activeVpnPeerManagementAddresses = db.prepare(`
  SELECT management_address FROM tenant_vpn_peers
   WHERE desired_state='active' AND management_address IS NOT NULL
`);
const configuredRemoteAccessManagementAddresses = db.prepare(`
  SELECT management_address FROM tenant_remote_access
   WHERE status='configured' AND management_address IS NOT NULL
`);
const insertVpnPeer = db.prepare(`
  INSERT INTO tenant_vpn_peers
    (location_id, gateway_id, gateway_name, management_address, router_public_key, desired_state,
     config_version, gateway_state)
  VALUES (@locationId, @gatewayId, @gatewayName, @managementAddress, @routerPublicKey, 'active',
          @configVersion, 'pending')
`);
const updateVpnPeerDesired = db.prepare(`
  UPDATE tenant_vpn_peers
     SET gateway_id=@gatewayId, gateway_name=@gatewayName, management_address=@managementAddress,
         router_public_key=@routerPublicKey, desired_state='active',
         config_version=@configVersion, gateway_peer_id=NULL, gateway_state='pending',
         gateway_public_key=NULL, gateway_synced_at=NULL, gateway_error=NULL, activation_payload_json=NULL,
         last_handshake_at=NULL, revoked_at=NULL, updated_at=datetime('now')
   WHERE location_id=@locationId
`);
const markVpnPeerGatewayReady = db.prepare(`
  UPDATE tenant_vpn_peers
     SET gateway_peer_id=@gatewayPeerId, gateway_public_key=@gatewayPublicKey,
         gateway_state='ready', gateway_synced_at=datetime('now'),
         gateway_error=NULL, activation_payload_json=@activationPayloadJson,
         updated_at=datetime('now')
   WHERE location_id=@locationId AND desired_state='active' AND config_version=@configVersion
`);
const markVpnPeerGatewayError = db.prepare(`
  UPDATE tenant_vpn_peers
     SET gateway_state='error', gateway_error=@gatewayError, gateway_synced_at=datetime('now'),
         updated_at=datetime('now')
   WHERE location_id=@locationId AND desired_state='active' AND config_version=@configVersion
`);
const markVpnPeerGatewayRevoked = db.prepare(`
  UPDATE tenant_vpn_peers
     SET gateway_peer_id=NULL, gateway_state='revoked', gateway_synced_at=datetime('now'),
         gateway_error=NULL, activation_payload_json=NULL, last_handshake_at=NULL,
         updated_at=datetime('now')
   WHERE location_id=@locationId AND desired_state='revoked' AND config_version=@configVersion
`);
const revokeVpnPeerDesired = db.prepare(`
  UPDATE tenant_vpn_peers
     SET desired_state='revoked', config_version=config_version+1,
         gateway_state=CASE WHEN gateway_state='revoked' THEN 'revoked' ELSE 'revoke_pending' END,
         gateway_error=NULL, activation_payload_json=NULL, last_handshake_at=NULL,
         revoked_at=COALESCE(revoked_at, datetime('now')), updated_at=datetime('now')
   WHERE location_id=? AND desired_state='active'
`);
const updateVpnPeerHandshake = db.prepare(`
  UPDATE tenant_vpn_peers
     SET last_handshake_at=CASE
           WHEN last_handshake_at IS NULL OR last_handshake_at < @handshakeAt THEN @handshakeAt
           ELSE last_handshake_at END,
         updated_at=datetime('now')
   WHERE location_id=@locationId AND desired_state='active' AND gateway_state='ready'
`);
const remoteAccessEventsByLocation = db.prepare(`
  SELECT id, actor_type, actor_id, action, created_at
    FROM tenant_remote_access_events WHERE location_id=? ORDER BY id DESC LIMIT ?
`);
const insertRemoteAccess = db.prepare(`
  INSERT INTO tenant_remote_access (location_id, status, requested_at, updated_at)
  VALUES (?, 'requested', datetime('now'), datetime('now'))
`);
const reRequestRemoteAccess = db.prepare(`
  UPDATE tenant_remote_access
     SET status='requested', requested_at=datetime('now'), approved_at=NULL,
         configured_at=NULL, revoked_at=NULL, management_address=NULL, hub_name=NULL,
         vpn_gateway_id=NULL, vpn_management_cidr=NULL,
         last_handshake_at=NULL, updated_at=datetime('now')
   WHERE location_id=? AND status='revoked'
`);
const approveRemoteAccess = db.prepare(`
  UPDATE tenant_remote_access
     SET status='approved', approved_at=datetime('now'), revoked_at=NULL, updated_at=datetime('now')
   WHERE location_id=? AND status='requested'
`);
const configureRemoteAccess = db.prepare(`
  UPDATE tenant_remote_access
     SET status='configured', configured_at=datetime('now'), management_address=@managementAddress,
         hub_name=@hubName, revoked_at=NULL, updated_at=datetime('now')
   WHERE location_id=@locationId AND status='approved'
`);
const configureRemoteAccessWithGateway = db.prepare(`
  UPDATE tenant_remote_access
     SET status='configured', configured_at=datetime('now'), management_address=@managementAddress,
         hub_name=@hubName, vpn_gateway_id=@gatewayId, vpn_management_cidr=@managementCidr,
         revoked_at=NULL, updated_at=datetime('now')
   WHERE location_id=@locationId AND status='approved'
`);
const setRemoteAccessVpnGateway = db.prepare(`
  UPDATE tenant_remote_access
     SET hub_name=@hubName, vpn_gateway_id=@gatewayId, vpn_management_cidr=@managementCidr,
         updated_at=datetime('now')
   WHERE location_id=@locationId AND status='configured'
`);
const revokeRemoteAccess = db.prepare(`
  UPDATE tenant_remote_access
     SET status='revoked', revoked_at=datetime('now'), management_address=NULL,
         hub_name=NULL, vpn_gateway_id=NULL, vpn_management_cidr=NULL,
         last_handshake_at=NULL, router_public_key=NULL,
         enrolled_at=NULL, updated_at=datetime('now')
   WHERE location_id=? AND status IN ('requested', 'approved', 'configured')
`);
const saveRemoteAccessEnrollment = db.prepare(`
  UPDATE tenant_remote_access
     SET router_public_key=@routerPublicKey, enrolled_at=datetime('now'), updated_at=datetime('now')
   WHERE location_id=@locationId AND status IN ('approved', 'configured')
`);
const updateRemoteAccessHandshake = db.prepare(`
  UPDATE tenant_remote_access
     SET last_handshake_at=CASE
           WHEN last_handshake_at IS NULL OR last_handshake_at < @handshakeAt THEN @handshakeAt
           ELSE last_handshake_at END,
         updated_at=datetime('now')
   WHERE location_id=@locationId AND status='configured'
`);
const insertRemoteAccessEvent = db.prepare(`
  INSERT INTO tenant_remote_access_events (location_id, actor_type, actor_id, action)
  VALUES (@locationId, @actorType, @actorId, @action)
`);
const cancelPendingRemoteSupportControls = db.prepare(`
  UPDATE tenant_remote_support_controls
     SET cancelled_at=datetime('now')
   WHERE location_id=? AND acked_at IS NULL AND cancelled_at IS NULL
`);
const insertRemoteSupportControl = db.prepare(`
  INSERT INTO tenant_remote_support_controls (location_id, action, payload_json, config_version)
  VALUES (@locationId, @action, @payloadJson, @configVersion)
`);
const pendingRemoteSupportControls = db.prepare(`
  SELECT id, location_id, action, payload_json, config_version, created_at
    FROM tenant_remote_support_controls
   WHERE location_id=? AND acked_at IS NULL AND cancelled_at IS NULL
     AND (delivered_at IS NULL OR delivered_at <= datetime('now','-60 seconds'))
   ORDER BY id
   LIMIT 1
`);
const markRemoteSupportControlDelivered = db.prepare(`
  UPDATE tenant_remote_support_controls
     SET delivered_at=datetime('now')
   WHERE id=? AND cancelled_at IS NULL
`);
const markRemoteSupportControlAckedStatement = db.prepare(`
  UPDATE tenant_remote_support_controls
     SET acked_at=datetime('now')
   WHERE id=? AND location_id=? AND cancelled_at IS NULL
`);
const remoteSupportControlById = db.prepare(`
  SELECT id, location_id, action, payload_json, config_version, acked_at, cancelled_at
    FROM tenant_remote_support_controls WHERE id=? AND location_id=?
`);
const outstandingRemoteSupportControls = db.prepare(`
  SELECT id, action, payload_json, config_version
    FROM tenant_remote_support_controls
   WHERE location_id=? AND acked_at IS NULL AND cancelled_at IS NULL
   ORDER BY id
`);
const cancelPendingVpnActivationControls = db.prepare(`
  UPDATE tenant_remote_support_controls
     SET cancelled_at=datetime('now')
   WHERE location_id=? AND action='activate' AND acked_at IS NULL AND cancelled_at IS NULL
`);
const pendingRemoteSupportRevoke = db.prepare(`
  SELECT id FROM tenant_remote_support_controls
   WHERE location_id=? AND action='revoke' AND acked_at IS NULL AND cancelled_at IS NULL
   LIMIT 1
`);
const acknowledgedRemoteSupportActivation = db.prepare(`
  SELECT id FROM tenant_remote_support_controls
   WHERE location_id=? AND action='activate' AND config_version=?
     AND acked_at IS NOT NULL AND cancelled_at IS NULL
   LIMIT 1
`);

const packageForLocation = db.prepare(`
  SELECT p.id, p.name, p.price, p.seconds, p.rate_limit
    FROM business_packages p JOIN locations l ON l.business_id = p.business_id
   WHERE p.id = ? AND l.id = ? AND p.active = 1
`);
const packagesForLocation = db.prepare(`
  SELECT p.id, p.name, p.price, p.seconds, p.rate_limit FROM business_packages p
   JOIN locations l ON l.business_id = p.business_id
   WHERE l.id = ? AND p.active = 1 ORDER BY p.price
`);

const insertTransaction = db.prepare(`
  INSERT INTO tenant_transactions
    (checkout_request_id, merchant_request_id, business_id, location_id, phone, package_id,
     package_name, amount, seconds, rate_limit, mac, ip)
  VALUES (@checkoutRequestId, @merchantRequestId, @businessId, @locationId, @phone, @packageId,
          @packageName, @amount, @seconds, @rateLimit, @mac, @ip)
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
    (id, business_id, location_id, router_username, payer_phone, mac, password, total_seconds, rate_limit, expires_at)
  VALUES (@id, @businessId, @locationId, @routerUsername, @payerPhone, @mac, @password, @totalSeconds, @rateLimit, @expiresAt)
  ON CONFLICT(location_id, mac) DO UPDATE SET
    password=excluded.password, total_seconds=excluded.total_seconds, rate_limit=excluded.rate_limit, expires_at=excluded.expires_at,
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
  INSERT INTO tenant_jobs (location_id, username, password, profile, total_seconds, rate_limit, mac, ip, action)
  VALUES (@locationId, @username, @password, @profile, @totalSeconds, @rateLimit, @mac, @ip, @action)
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
  UPDATE business_packages SET name=@name, price=@price, seconds=@seconds, rate_limit=@rateLimit
   WHERE id=@id AND business_id=@businessId
`);
const setBusinessPackageActive = db.prepare(`
  UPDATE business_packages SET active=@active WHERE id=@id AND business_id=@businessId
`);

const addVoucher = db.prepare(`
  INSERT INTO tenant_vouchers (code, business_id, location_id, package_id, package_name, seconds, rate_limit, batch)
  VALUES (@code, @businessId, @locationId, @packageId, @packageName, @seconds, @rateLimit, @batch)
`);
const vouchersForBusiness = db.prepare(`
  SELECT v.code, v.location_id, l.name AS location_name, v.package_name, v.seconds, v.rate_limit, v.batch,
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

function savedSetup(setup = {}) {
  return {
    hotspotServer: setup.hotspotServer || null,
    setupMode: setup.mode || null,
    routerModel: setup.routerModel || null,
    routerOsVersion: setup.routerOsVersion || null,
    wifiStack: setup.radio || null,
    customerBridge: setup.customerBridge || null,
    wanInterface: setup.wanInterface || null,
    wifiInterface: setup.wifiInterface || null,
    wifiSsid: setup.wifiSsid || null,
    customerPorts: Array.isArray(setup.customerPorts) ? setup.customerPorts.join(',') : (setup.customerPorts || null),
    hotspotSubnet: setup.customerSubnet || null,
  };
}

function setupFromLocation(location) {
  return {
    mode: location.setup_mode || 'existing',
    routerModel: location.router_model || '',
    routerOsVersion: location.routeros_version || '7',
    radio: location.wifi_stack || 'wireless',
    customerBridge: location.customer_bridge || 'bridge-hs',
    hotspotServer: location.hotspot_server || 'hotspot1',
    wanInterface: location.wan_interface || 'ether1',
    wifiInterface: location.wifi_interface || 'wlan1',
    wifiSsid: location.wifi_ssid || '',
    customerPorts: location.customer_ports ? location.customer_ports.split(',') : [],
    customerSubnet: location.hotspot_subnet || '',
  };
}

function createLocation({ id, businessId, name, routerName, setup }) {
  const routerToken = crypto.randomBytes(24).toString('base64url');
  const saved = savedSetup(setup);
  db.exec('BEGIN IMMEDIATE');
  try {
    createLocationRow.run({ id, businessId, name, routerName: routerName || null,
      routerTokenHash: tokenHash(routerToken), routerTokenMarker: tokenMarker(routerToken), ...saved });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
  // A customer address is deliberately not reserved at draft time.  The
  // router initially uses the safe cloud URL, then the owner chooses a
  // branded subdomain after the first successful connection.
  return { id, businessId, name, routerName: routerName || null, routerToken, portalHostname: null, ...savedSetup(setup) };
}

const REMOTE_ACCESS_ACTIVE_STATES = new Set(['requested', 'approved', 'configured']);
const REMOTE_SUPPORT_CONTROL_ACTIONS = new Set(['prepare', 'activate', 'revoke']);
const VPN_GATEWAY_STATES = new Set(['ready', 'error', 'revoked']);
const MAPPED_DEPLOYMENT_ACTION = 'apply_mapped_service_v1';
const MAPPED_DEPLOYMENT_PENDING = new Set(['queued', 'delivered']);
const MAPPED_DEPLOYMENT_STATUSES = new Set(['queued', 'delivered', 'acknowledged', 'cancelled', 'stale', 'failed']);
// A keepalive-driven WireGuard session should be observed every few seconds.
// Two minutes leaves normal gateway/poll jitter room but does not let an old
// tunnel observation authorize a new deployment after the router disappears.
const MAPPED_DEPLOYMENT_HANDSHAKE_MAX_AGE_MS = 2 * 60_000;

function remoteAccessError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function gatewayId(value) {
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(raw)) {
    throw remoteAccessError('Use a gateway ID containing letters, numbers, dots, colons, underscores, or hyphens.', 400);
  }
  return raw;
}

/**
 * Support controls travel independently from customer provisioning. A newer
 * command cancels an older unacknowledged one, so a revoke cannot be followed
 * by a stale redelivered prepare command. Call only inside the lifecycle
 * transaction below.
 */
function queueRemoteSupportControl(locationId, action, { payloadJson = null, configVersion = null } = {}) {
  if (!REMOTE_SUPPORT_CONTROL_ACTIONS.has(action)) {
    throw new Error('Unsupported remote-support control action.');
  }
  if (action === 'activate') {
    if (!payloadJson || !Number.isInteger(configVersion) || configVersion < 1) {
      throw new Error('A versioned activation payload is required for this remote-support control.');
    }
  } else if (payloadJson !== null || configVersion !== null) {
    throw new Error('Only a versioned activation may carry a remote-support payload.');
  }
  cancelPendingRemoteSupportControls.run(locationId);
  return Number(insertRemoteSupportControl.run({ locationId, action, payloadJson, configVersion }).lastInsertRowid);
}

function remoteSupportRevokeIsPending(locationId) {
  return Boolean(pendingRemoteSupportRevoke.get(locationId));
}

function vpnPeerPayload(peer) {
  if (!peer) return null;
  return {
    locationId: peer.location_id,
    gatewayId: peer.gateway_id,
    gatewayName: peer.gateway_name,
    managementAddress: peer.management_address,
    // Public keys are non-secret but intentionally only exposed by the
    // privileged gateway APIs below, never through remoteAccessPayload.
    routerPublicKey: peer.router_public_key,
    gatewayPublicKey: peer.gateway_public_key || null,
    desiredState: peer.desired_state,
    configVersion: Number(peer.config_version),
    gatewayPeerId: peer.gateway_peer_id || null,
    gatewayState: peer.gateway_state,
    gatewaySyncedAt: peer.gateway_synced_at || null,
    gatewayError: peer.gateway_error || null,
    lastHandshakeAt: peer.last_handshake_at || null,
    createdAt: peer.created_at,
    updatedAt: peer.updated_at,
    revokedAt: peer.revoked_at || null,
  };
}

// An activation must not cancel the `prepare` that creates the router's
// disabled WireGuard interface. If a gateway finishes early, its validated
// payload is retained on the desired peer; acknowledging prepare releases it
// automatically below. This makes gateway and router timing independent.
function queueReadyVpnActivation(locationId) {
  const peer = vpnPeerByLocation.get(locationId);
  if (!peer || peer.desired_state !== 'active' || peer.gateway_state !== 'ready' || !peer.activation_payload_json) return null;
  const outstanding = outstandingRemoteSupportControls.all(locationId);
  if (outstanding.some((control) => control.action === 'prepare' || control.action === 'revoke')) return null;
  const matching = outstanding.find((control) => control.action === 'activate' && Number(control.config_version) === Number(peer.config_version));
  if (matching) return Number(matching.id);
  // A gateway reconciles regularly. Once the router has acknowledged this
  // exact version, another ordinary gateway heartbeat must not reissue the
  // same activation forever. A new peer/version, or an unacknowledged
  // activation after a genuine delivery failure, is still handled above.
  if (acknowledgedRemoteSupportActivation.get(locationId, Number(peer.config_version))) return null;
  // A changed desired peer always cancels an earlier activation before it is
  // reported ready. Leave any unknown future control untouched rather than
  // silently overriding it.
  if (outstanding.length) return null;
  return Number(insertRemoteSupportControl.run({
    locationId,
    action: 'activate',
    payloadJson: peer.activation_payload_json,
    configVersion: Number(peer.config_version),
  }).lastInsertRowid);
}

function revokeVpnPeerDesiredInTransaction(locationId) {
  const peer = vpnPeerByLocation.get(locationId);
  if (!peer || peer.desired_state === 'revoked') return peer;
  // An activate response can be in flight when an owner revokes consent.
  // Cancelling it prevents later router polls from collecting the old config;
  // the dedicated revoke control is queued by the caller immediately after.
  cancelPendingVpnActivationControls.run(locationId);
  revokeVpnPeerDesired.run(locationId);
  return vpnPeerByLocation.get(locationId);
}

function remoteAccessPayload(location, record) {
  const status = record ? record.status : 'not_requested';
  // Do not substitute `last_seen_at` here. Authentication is intentionally
  // shared by several safe router endpoints; only a completed sync proves
  // that the paired control-plane poll is working.
  const hasSuccessfulRouterSync = Boolean(location && location.last_successful_sync_at);
  // A database-only revoke cannot remove a persisted RouterOS interface. Do
  // not allow a fresh consent request to supersede the queued cleanup.
  const revokePending = status === 'revoked' && remoteSupportRevokeIsPending(location.id);
  // The owner needs a truthful connection state, but never a peer key,
  // endpoint credential, or a router-management secret. A configured record
  // with no peer is waiting for the router to create and report its own key;
  // a ready peer becomes live only after the gateway observes a handshake.
  const peer = vpnPeerByLocation.get(location.id);
  const gatewayState = peer
    ? peer.gateway_state
    : (record?.vpn_gateway_id && status === 'configured' ? 'preparing_router' : null);
  return {
    locationId: location.id,
    status,
    requestedAt: record?.requested_at || null,
    approvedAt: record?.approved_at || null,
    configuredAt: record?.configured_at || null,
    revokedAt: record?.revoked_at || null,
    managementAddress: record?.management_address || null,
    hubName: record?.hub_name || null,
    lastHandshakeAt: record?.last_handshake_at || null,
    gatewayState,
    gatewaySyncedAt: peer?.gateway_synced_at || null,
    gatewayError: peer?.gateway_error || null,
    cleanupPending: revokePending,
    canRequest: hasSuccessfulRouterSync && !revokePending && (status === 'not_requested' || status === 'revoked'),
    canRevoke: REMOTE_ACCESS_ACTIVE_STATES.has(status),
  };
}

function remoteAccessForLocation(location) {
  if (!location) return null;
  return remoteAccessPayload(location, remoteAccessByLocation.get(location.id));
}

function remoteAccessForBusiness({ locationId, businessId }) {
  const location = locationForBusiness.get(locationId, businessId);
  return remoteAccessForLocation(location);
}

function withRemoteAccessTransaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
}

/**
 * Stage two of router onboarding.  A business can ask for optional remote
 * support only after its router has completed its first authenticated poll.
 * This records consent; it neither issues VPN keys nor changes the router.
 */
function requestRemoteAccess({ locationId, businessId }) {
  const location = locationForBusiness.get(locationId, businessId);
  if (!location) return null;
  if (!location.last_successful_sync_at) {
    throw remoteAccessError(
      'Pair the router first. It must complete one authenticated WiFi Fiti poll before remote access can be requested.',
      409
    );
  }

  return withRemoteAccessTransaction(() => {
    const existing = remoteAccessByLocation.get(location.id);
    if (existing && existing.status !== 'revoked') return remoteAccessPayload(location, existing);
    if (existing && remoteSupportRevokeIsPending(location.id)) {
      throw remoteAccessError(
        'Remote-support cleanup is still waiting for this router to acknowledge the revoke command. Keep it paired and online, then try again.',
        409
      );
    }
    if (existing) reRequestRemoteAccess.run(location.id);
    else insertRemoteAccess.run(location.id);
    insertRemoteAccessEvent.run({ locationId: location.id, actorType: 'business', actorId: businessId, action: 'requested' });
    return remoteAccessPayload(location, remoteAccessByLocation.get(location.id));
  });
}

/** The owner can withdraw consent at any time.  A future VPN-hub worker
 * must treat this durable state as an immediate peer-revocation signal. */
function revokeRemoteAccessForBusiness({ locationId, businessId }) {
  const location = locationForBusiness.get(locationId, businessId);
  if (!location) return null;
  return withRemoteAccessTransaction(() => {
    const existing = remoteAccessByLocation.get(location.id);
    if (!existing || existing.status === 'revoked') return remoteAccessPayload(location, existing);
    // Withdrawal of consent also cancels a map-bound action that has not
    // received the router's completion receipt. It cannot be revived by a
    // later poll without a new explicit owner request.
    cancelPendingMappedDeployments.run({ locationId: location.id, errorCode: 'remote_access_revoked' });
    revokeVpnPeerDesiredInTransaction(location.id);
    revokeRemoteAccess.run(location.id);
    queueRemoteSupportControl(location.id, 'revoke');
    insertRemoteAccessEvent.run({ locationId: location.id, actorType: 'business', actorId: businessId, action: 'revoked' });
    return remoteAccessPayload(location, remoteAccessByLocation.get(location.id));
  });
}

function managementAddress(value) {
  const raw = String(value || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255) || Number(parts[0]) !== 10) {
    throw remoteAccessError('Use a private 10.x.x.x management address.', 400);
  }
  if (Number(parts[3]) === 0 || Number(parts[3]) === 255) {
    throw remoteAccessError('Use a usable private 10.x.x.x management address.', 400);
  }
  return parts.map(Number).join('.');
}

function hubName(value) {
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(raw)) {
    throw remoteAccessError('Enter a hub name using letters, numbers, spaces, dots, hyphens, or underscores.', 400);
  }
  return raw;
}

function ipv4Number(value, label = 'IPv4 address') {
  const raw = String(value || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw remoteAccessError(`Use a valid ${label}.`, 400);
  }
  return parts.reduce((number, part) => number * 256 + Number(part), 0);
}

function ipv4Text(value) {
  let number = Number(value);
  const parts = [];
  for (let index = 0; index < 4; index++) {
    parts.unshift(String(number % 256));
    number = Math.floor(number / 256);
  }
  return parts.join('.');
}

function managementCidr(value) {
  const raw = String(value || '').trim();
  const match = /^([^/]+)\/(\d{1,2})$/.exec(raw);
  if (!match) throw remoteAccessError('Use a canonical private 10.x.x.x/16–/30 management CIDR.', 400);
  const address = ipv4Number(match[1], 'management CIDR');
  const prefix = Number(match[2]);
  // Keeping this at /16 through /30 prevents an accidental whole-10/8
  // scan, while still providing 65,000+ peers on one small gateway.
  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 30 || Math.floor(address / 256 ** 3) !== 10) {
    throw remoteAccessError('Use a canonical private 10.x.x.x/16–/30 management CIDR.', 400);
  }
  const blockSize = 2 ** (32 - prefix);
  const network = Math.floor(address / blockSize) * blockSize;
  if (network !== address) {
    throw remoteAccessError('Use the network address, not a host address, for the management CIDR.', 400);
  }
  return { cidr: `${ipv4Text(network)}/${prefix}`, network, broadcast: network + blockSize - 1 };
}

function addressIsInCidr(address, cidr) {
  const number = ipv4Number(address, 'management address');
  return number > cidr.network && number < cidr.broadcast;
}

function allocateManagementAddress(cidr, locationId, existingAddress = null) {
  if (existingAddress) {
    try {
      const normalized = managementAddress(existingAddress);
      if (addressIsInCidr(normalized, cidr)) return normalized;
    } catch (_) { /* allocate a clean address instead */ }
  }
  const used = new Set([
    ...configuredRemoteAccessManagementAddresses.all().map((row) => row.management_address),
    ...activeVpnPeerManagementAddresses.all().map((row) => row.management_address),
  ]);
  // A location may retain its address while its platform record is being
  // replayed. It is safe to reuse only that location's existing assignment.
  if (existingAddress) used.delete(String(existingAddress));
  for (let value = cidr.network + 2; value < cidr.broadcast; value++) {
    const candidate = ipv4Text(value);
    // Keep compatibility with the long-standing management-address guard,
    // which reserves x.x.x.0 and x.x.x.255 even inside a wider CIDR.
    const lastOctet = value % 256;
    if (lastOctet === 0 || lastOctet === 255 || used.has(candidate)) continue;
    return candidate;
  }
  throw remoteAccessError('This VPN management CIDR has no free router addresses.', 409);
}

function vpnConfigVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647) {
    throw remoteAccessError('Use a valid positive VPN configuration version.', 400);
  }
  return version;
}

function vpnGatewayPeerId(value) {
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(raw)) {
    throw remoteAccessError('Use a safe gateway peer identifier.', 400);
  }
  return raw;
}

function vpnEndpointHost(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || raw.length > 253 || !portalHostname(raw)) {
    throw remoteAccessError('Use a hostname or IPv4 address for the VPN gateway endpoint.', 400);
  }
  return raw;
}

function vpnEndpointPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw remoteAccessError('Use a VPN gateway UDP port between 1 and 65535.', 400);
  }
  return port;
}

function vpnGatewayError(value) {
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 .:_-]{0,239}$/.test(raw) || /private|password|secret|token|credential|key/i.test(raw)) {
    throw remoteAccessError('Use a short non-secret gateway error code or message.', 400);
  }
  return raw;
}

function vpnTimestamp(value) {
  if (value === undefined || value === null || value === '') return nowSql(Date.now());
  const milliseconds = Date.parse(String(value));
  if (!Number.isFinite(milliseconds) || milliseconds > Date.now() + 5 * 60_000 || milliseconds < Date.now() - 366 * 24 * 60 * 60_000) {
    throw remoteAccessError('Use a recent valid VPN gateway timestamp.', 400);
  }
  return nowSql(milliseconds);
}

function vpnHostAddress(value, label) {
  const raw = String(value || '').trim();
  const match = /^([^/]+)(?:\/32)?$/.exec(raw);
  if (!match) throw remoteAccessError(`Use a single ${label} IPv4 address (optionally /32).`, 400);
  return managementAddress(match[1]);
}

function vpnActivationPayload({ gatewayPublicKey, endpointHost, endpointPort, gatewayAddress }, peer, access) {
  const gateway = vpnHostAddress(gatewayAddress, 'gateway');
  const management = managementAddress(peer.management_address);
  if (gateway === management) {
    throw remoteAccessError('The gateway and router VPN addresses must be different.', 400);
  }
  if (access?.vpn_management_cidr && !addressIsInCidr(gateway, managementCidr(access.vpn_management_cidr))) {
    throw remoteAccessError('The gateway VPN address must be inside the assigned management CIDR.', 400);
  }
  // This exact whitelist is the safety boundary for payload_json. It gives
  // RouterOS just the public peer material needed for a management-only
  // tunnel; it cannot carry a private key, default route, firewall rule, or
  // arbitrary RouterOS source text.
  return {
    version: 1,
    gatewayPublicKey: wireGuardPublicKey(gatewayPublicKey),
    endpointHost: vpnEndpointHost(endpointHost),
    endpointPort: vpnEndpointPort(endpointPort),
    managementAddress: `${management}/32`,
    gatewayAddress: `${gateway}/32`,
  };
}

function allocateDesiredVpnPeerInTransaction({ location, remoteAccess, gatewayId: selectedGatewayId, gatewayName: selectedGatewayName }) {
  if (!remoteAccess || remoteAccess.status !== 'configured' || !remoteAccess.router_public_key || !remoteAccess.management_address) {
    throw remoteAccessError('The router must finish approved remote-support enrollment before a VPN peer can be allocated.', 409);
  }
  const resolvedGatewayId = gatewayId(selectedGatewayId || remoteAccess.vpn_gateway_id);
  const resolvedGatewayName = hubName(selectedGatewayName || remoteAccess.hub_name);
  const address = managementAddress(remoteAccess.management_address);
  const routerPublicKey = wireGuardPublicKey(remoteAccess.router_public_key);
  const assigned = activeVpnPeerByManagementAddress.get(address);
  if (assigned && assigned.location_id !== location.id) {
    throw remoteAccessError('That VPN management address is already assigned to another router.', 409);
  }
  const keyAssigned = activeVpnPeerByRouterPublicKey.get(routerPublicKey);
  if (keyAssigned && keyAssigned.location_id !== location.id) {
    throw remoteAccessError('That router WireGuard identity is already assigned to another active location. Revoke the previous remote connection before reusing this router.', 409);
  }
  const existing = vpnPeerByLocation.get(location.id);
  if (existing && existing.desired_state === 'active' &&
      existing.gateway_id === resolvedGatewayId && existing.gateway_name === resolvedGatewayName &&
      existing.management_address === address && existing.router_public_key === routerPublicKey) {
    return existing;
  }
  const nextVersion = existing ? Number(existing.config_version) + 1 : 1;
  if (existing) {
    cancelPendingVpnActivationControls.run(location.id);
    updateVpnPeerDesired.run({ locationId: location.id, gatewayId: resolvedGatewayId, gatewayName: resolvedGatewayName,
      managementAddress: address, routerPublicKey, configVersion: nextVersion });
  } else {
    insertVpnPeer.run({ locationId: location.id, gatewayId: resolvedGatewayId, gatewayName: resolvedGatewayName,
      managementAddress: address, routerPublicKey, configVersion: nextVersion });
  }
  return vpnPeerByLocation.get(location.id);
}

/**
 * Allocate/update the gateway's durable desired peer after an enrolled
 * router has reported its public WireGuard identity. This API is privileged:
 * its result is for the gateway worker, not a tenant browser or portal.
 */
function allocateDesiredVpnPeer({ locationId, gatewayId: selectedGatewayId, gatewayName: selectedGatewayName }) {
  const location = locationById.get(locationId);
  if (!location) return null;
  return withRemoteAccessTransaction(() => {
    const remoteAccess = remoteAccessByLocation.get(location.id);
    const peer = allocateDesiredVpnPeerInTransaction({
      location,
      remoteAccess,
      gatewayId: selectedGatewayId,
      gatewayName: selectedGatewayName,
    });
    return vpnPeerPayload(peer);
  });
}

/**
 * One autonomous platform step for an owner-approved request. It allocates
 * a management /32, selects the gateway, records the non-secret desired
 * gateway selection, and queues the existing harmless `prepare` action.
 * The router still has to create its own key pair; enrollment then creates
 * the actual desired peer record without exposing a private key to WiFi Fiti.
 */
function provisionRemoteVpn({ locationId, gatewayId: selectedGatewayId, gatewayName: selectedGatewayName, managementCidr: requestedManagementCidr, actorId = 'vpn-platform' }) {
  const location = locationById.get(locationId);
  if (!location) return null;
  const resolvedGatewayId = gatewayId(selectedGatewayId);
  const resolvedGatewayName = hubName(selectedGatewayName);
  const cidr = managementCidr(requestedManagementCidr);

  return withRemoteAccessTransaction(() => {
    let remoteAccess = remoteAccessByLocation.get(location.id);
    if (!remoteAccess) throw remoteAccessError('The business has not requested remote access for this router.', 409);
    if (remoteAccess.status === 'revoked') {
      throw remoteAccessError('Remote access was revoked. The owner must request it again before VPN setup can continue.', 409);
    }

    if (remoteAccess.status === 'requested') {
      approveRemoteAccess.run(location.id);
      insertRemoteAccessEvent.run({ locationId: location.id, actorType: 'admin', actorId, action: 'approved' });
      remoteAccess = remoteAccessByLocation.get(location.id);
    }

    if (remoteAccess.status === 'approved') {
      const address = allocateManagementAddress(cidr, location.id);
      const assigned = remoteAccessByManagementAddress.get(address);
      if (assigned && assigned.location_id !== location.id) {
        throw remoteAccessError('The selected VPN management address is already assigned to another router.', 409);
      }
      configureRemoteAccessWithGateway.run({
        locationId: location.id,
        managementAddress: address,
        hubName: resolvedGatewayName,
        gatewayId: resolvedGatewayId,
        managementCidr: cidr.cidr,
      });
      queueRemoteSupportControl(location.id, 'prepare');
      insertRemoteAccessEvent.run({ locationId: location.id, actorType: 'admin', actorId, action: 'configured' });
      remoteAccess = remoteAccessByLocation.get(location.id);
    }

    if (remoteAccess.status !== 'configured') {
      throw remoteAccessError('Remote access could not be prepared for VPN provisioning.', 409);
    }
    // Upgrade a legacy manually configured support record into the durable
    // gateway model without changing its already allocated router address.
    if (!remoteAccess.vpn_gateway_id) {
      if (!addressIsInCidr(remoteAccess.management_address, cidr)) {
        throw remoteAccessError('The existing remote-support address is outside the requested VPN management CIDR.', 409);
      }
      setRemoteAccessVpnGateway.run({ locationId: location.id, hubName: resolvedGatewayName,
        gatewayId: resolvedGatewayId, managementCidr: cidr.cidr });
      remoteAccess = remoteAccessByLocation.get(location.id);
    }
    if (remoteAccess.vpn_gateway_id && remoteAccess.vpn_gateway_id !== resolvedGatewayId) {
      throw remoteAccessError('This router is already assigned to a different VPN gateway. Revoke it before moving gateways.', 409);
    }
    if (remoteAccess.vpn_management_cidr && remoteAccess.vpn_management_cidr !== cidr.cidr) {
      throw remoteAccessError('This router is already assigned to a different VPN management network. Revoke it before changing networks.', 409);
    }

    let peer = null;
    if (remoteAccess.router_public_key) {
      peer = allocateDesiredVpnPeerInTransaction({ location, remoteAccess, gatewayId: resolvedGatewayId, gatewayName: resolvedGatewayName });
    } else if (!outstandingRemoteSupportControls.all(location.id).some((control) => control.action === 'prepare')) {
      // A router may reboot or lose its local helper after acknowledging a
      // prepare command but before reporting its key. Re-running this
      // platform step safely retries preparation without allocating a peer
      // or changing the selected management address.
      queueRemoteSupportControl(location.id, 'prepare');
    }
    return {
      remoteAccess: remoteAccessPayload(location, remoteAccess),
      peer: vpnPeerPayload(peer),
      managementCidr: cidr.cidr,
    };
  });
}

/** Platform-only lifecycle. `configured` means inventory has been allocated;
 * it deliberately does not assert that a tunnel is live. */
function manageRemoteAccess({ locationId, action, managementAddress: requestedAddress, hubName: requestedHubName, actorId = 'platform' }) {
  const location = locationById.get(locationId);
  if (!location) return null;
  const operation = String(action || '').trim();

  return withRemoteAccessTransaction(() => {
    const existing = remoteAccessByLocation.get(location.id);
    if (operation === 'revoke') {
      if (!existing || existing.status === 'revoked') return remoteAccessPayload(location, existing);
      cancelPendingMappedDeployments.run({ locationId: location.id, errorCode: 'remote_access_revoked' });
      revokeVpnPeerDesiredInTransaction(location.id);
      revokeRemoteAccess.run(location.id);
      queueRemoteSupportControl(location.id, 'revoke');
      insertRemoteAccessEvent.run({ locationId: location.id, actorType: 'admin', actorId, action: 'revoked' });
      return remoteAccessPayload(location, remoteAccessByLocation.get(location.id));
    }
    if (!existing) throw remoteAccessError('The business has not requested remote access for this router.', 409);
    if (operation === 'approve') {
      if (existing.status !== 'requested') throw remoteAccessError('Remote access can only be approved after an owner request.', 409);
      approveRemoteAccess.run(location.id);
      insertRemoteAccessEvent.run({ locationId: location.id, actorType: 'admin', actorId, action: 'approved' });
      return remoteAccessPayload(location, remoteAccessByLocation.get(location.id));
    }
    if (operation === 'configure') {
      if (existing.status !== 'approved') throw remoteAccessError('Approve the owner request before recording hub allocation.', 409);
      const address = managementAddress(requestedAddress);
      const hub = hubName(requestedHubName);
      const assigned = remoteAccessByManagementAddress.get(address);
      if (assigned && assigned.location_id !== location.id) {
        throw remoteAccessError('That management address is already assigned to another router.', 409);
      }
      configureRemoteAccess.run({ locationId: location.id, managementAddress: address, hubName: hub });
      // This is not a VPN-connection command. It only creates a disabled
      // native WireGuard interface and reports its public identifier through
      // the already-paired HTTPS channel.
      queueRemoteSupportControl(location.id, 'prepare');
      insertRemoteAccessEvent.run({ locationId: location.id, actorType: 'admin', actorId, action: 'configured' });
      return remoteAccessPayload(location, remoteAccessByLocation.get(location.id));
    }
    throw remoteAccessError('Choose approve, configure, or revoke.', 400);
  });
}

function wireGuardPublicKey(value) {
  const raw = String(value || '').trim();
  // A Curve25519 WireGuard public key is exactly 32 bytes, encoded as 44
  // standard-base64 characters. Accept neither a private key format nor
  // arbitrary router text that could later be mistaken for a key.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw) || Buffer.from(raw, 'base64').length !== 32) {
    throw remoteAccessError('The router support report contains an invalid public key.', 400);
  }
  return raw;
}

/**
 * A router may report its non-secret WireGuard public identifier only after
 * the platform has configured the business's explicit request. This records
 * inventory/audit data and deliberately does not create a peer, enable an
 * interface, issue a route, or return any connection configuration.
 */
function recordRemoteAccessEnrollment({ locationId, publicKey }) {
  const location = locationById.get(locationId);
  if (!location) return null;
  return withRemoteAccessTransaction(() => {
    const existing = remoteAccessByLocation.get(location.id);
    if (!existing || existing.status !== 'configured') {
      throw remoteAccessError('Remote support enrollment is waiting for platform approval and configuration.', 409);
    }
    const normalizedPublicKey = wireGuardPublicKey(publicKey);
    // A router support identity is a durable binding, not a value that a
    // later request may silently replace. Retrying the same report is safe;
    // a replacement router requires the owner to revoke and explicitly
    // request access again, after which it must receive platform approval.
    if (existing.router_public_key) {
      if (existing.router_public_key === normalizedPublicKey) {
        // A process may have recorded the router identity just before a
        // gateway-worker retry. Replaying the same report therefore repairs
        // a missing desired peer without rotating any key or address.
        if (existing.vpn_gateway_id) {
          allocateDesiredVpnPeerInTransaction({ location, remoteAccess: existing,
            gatewayId: existing.vpn_gateway_id, gatewayName: existing.hub_name });
        }
        return remoteAccessPayload(location, existing);
      }
      throw remoteAccessError(
        'A different router support identity is already enrolled. Revoke remote access and request it again before enrolling a replacement router.',
        409
      );
    }
    saveRemoteAccessEnrollment.run({ locationId: location.id, routerPublicKey: normalizedPublicKey });
    const enrolled = remoteAccessByLocation.get(location.id);
    // Autonomous WiFi Fiti VPN provisioning records the selected gateway
    // before it asks the router to create an interface. Once that interface
    // reports its public key, create the desired gateway peer immediately.
    // Legacy prepare/configure flow remains harmless and does not obtain a
    // peer until a gateway has been explicitly selected.
    if (enrolled.vpn_gateway_id) {
      allocateDesiredVpnPeerInTransaction({ location, remoteAccess: enrolled,
        gatewayId: enrolled.vpn_gateway_id, gatewayName: enrolled.hub_name });
    }
    // `remoteAccessPayload` intentionally omits the public key. Even though
    // it is non-secret, router identity is control-plane inventory rather
    // than a business-dashboard or portal API field.
    return remoteAccessPayload(location, enrolled);
  });
}

const desiredVpnPeersByGateway = db.prepare(`
  SELECT location_id, gateway_id, gateway_name, management_address, router_public_key, gateway_public_key,
         desired_state, config_version, gateway_peer_id, gateway_state, gateway_synced_at,
         gateway_error, activation_payload_json, last_handshake_at, created_at, updated_at, revoked_at
    FROM tenant_vpn_peers
   WHERE gateway_id=?
     AND (desired_state='active' OR gateway_state!='revoked')
   ORDER BY updated_at, location_id
`);

/** Return only the desired state a trusted gateway needs to reconcile. A
 * revoked peer remains visible until the gateway confirms deletion. */
function desiredVpnPeersForGateway({ gatewayId: selectedGatewayId }) {
  const id = gatewayId(selectedGatewayId);
  return desiredVpnPeersByGateway.all(id).map(vpnPeerPayload);
}

function requireGatewayPeer({ locationId, gatewayId: selectedGatewayId, configVersion }) {
  const location = locationById.get(locationId);
  if (!location) return { location: null, peer: null };
  const peer = vpnPeerByLocation.get(location.id);
  if (!peer) throw remoteAccessError('No WiFi Fiti VPN peer is allocated for this router.', 409);
  if (peer.gateway_id !== gatewayId(selectedGatewayId)) {
    throw remoteAccessError('This router belongs to a different VPN gateway.', 409);
  }
  if (configVersion !== undefined && Number(peer.config_version) !== vpnConfigVersion(configVersion)) {
    throw remoteAccessError('This VPN gateway report is for a stale configuration version.', 409);
  }
  return { location, peer };
}

/**
 * The gateway reports the result of reconciling a desired peer. `ready`
 * means the gateway has installed the router public key and supplies only
 * the gateway's public endpoint material. The versioned activation control
 * is queued only after the router has acknowledged its safe `prepare` step.
 */
function reportVpnGatewaySync({
  locationId,
  gatewayId: selectedGatewayId,
  configVersion,
  status,
  gatewayPeerId: reportedGatewayPeerId,
  gatewayPublicKey,
  endpointHost,
  endpointPort,
  gatewayAddress,
  error,
}) {
  const normalizedStatus = String(status || '').trim().toLowerCase() === 'applied'
    ? 'ready' : String(status || '').trim().toLowerCase();
  if (!VPN_GATEWAY_STATES.has(normalizedStatus)) {
    throw remoteAccessError('Use ready, error, or revoked for the VPN gateway sync status.', 400);
  }

  return withRemoteAccessTransaction(() => {
    const { location, peer } = requireGatewayPeer({ locationId, gatewayId: selectedGatewayId, configVersion });
    if (!location) return null;
    const version = vpnConfigVersion(configVersion);

    if (normalizedStatus === 'ready') {
      if (peer.desired_state !== 'active') {
        throw remoteAccessError('A revoked VPN peer cannot be activated.', 409);
      }
      const access = remoteAccessByLocation.get(location.id);
      const activation = vpnActivationPayload({ gatewayPublicKey, endpointHost, endpointPort, gatewayAddress }, peer, access);
      markVpnPeerGatewayReady.run({
        locationId: location.id,
        configVersion: version,
        gatewayPeerId: vpnGatewayPeerId(reportedGatewayPeerId),
        gatewayPublicKey: activation.gatewayPublicKey,
        activationPayloadJson: JSON.stringify(activation),
      });
      const activationControlId = queueReadyVpnActivation(location.id);
      return { ...vpnPeerPayload(vpnPeerByLocation.get(location.id)), activationControlId };
    }

    if (normalizedStatus === 'error') {
      if (peer.desired_state !== 'active') {
        throw remoteAccessError('A revoked VPN peer cannot receive a new gateway error state.', 409);
      }
      cancelPendingVpnActivationControls.run(location.id);
      markVpnPeerGatewayError.run({ locationId: location.id, configVersion: version, gatewayError: vpnGatewayError(error) });
      return vpnPeerPayload(vpnPeerByLocation.get(location.id));
    }

    if (peer.desired_state !== 'revoked') {
      throw remoteAccessError('The gateway may confirm deletion only after WiFi Fiti revokes the desired peer.', 409);
    }
    markVpnPeerGatewayRevoked.run({ locationId: location.id, configVersion: version });
    return vpnPeerPayload(vpnPeerByLocation.get(location.id));
  });
}

/** Narrow convenience API for a gateway worker after it has installed a
 * peer. It keeps public endpoint material out of a generic free-form API. */
function recordVpnGatewayPeer(options) {
  return reportVpnGatewaySync({ ...options, status: 'ready' });
}

function recordVpnGatewayError(options) {
  return reportVpnGatewaySync({ ...options, status: 'error' });
}

/** Record a gateway-observed handshake, never a router-provided timestamp.
 * A stale timestamp cannot make a connection appear newer than the latest
 * one because both database updates are monotonic. */
function recordVpnPeerHandshake({ locationId, gatewayId: selectedGatewayId, configVersion, handshakeAt }) {
  return withRemoteAccessTransaction(() => {
    const { location, peer } = requireGatewayPeer({ locationId, gatewayId: selectedGatewayId, configVersion });
    if (!location) return null;
    if (peer.desired_state !== 'active' || peer.gateway_state !== 'ready') {
      throw remoteAccessError('A VPN handshake can be recorded only for a ready desired peer.', 409);
    }
    const timestamp = vpnTimestamp(handshakeAt);
    updateVpnPeerHandshake.run({ locationId: location.id, handshakeAt: timestamp });
    updateRemoteAccessHandshake.run({ locationId: location.id, handshakeAt: timestamp });
    return vpnPeerPayload(vpnPeerByLocation.get(location.id));
  });
}

/**
 * Platform emergency revoke. It turns desired state off immediately, queues
 * router cleanup, and withdraws the remote-access lifecycle at the same
 * time. The gateway learns it must delete the peer through
 * desiredVpnPeersForGateway until it reports `revoked` for the new version.
 */
function revokeVpnPeer({ locationId, actorId = 'vpn-gateway' }) {
  const location = locationById.get(locationId);
  if (!location) return null;
  return withRemoteAccessTransaction(() => {
    const existingPeer = vpnPeerByLocation.get(location.id);
    if (!existingPeer) return null;
    cancelPendingMappedDeployments.run({ locationId: location.id, errorCode: 'remote_access_revoked' });
    const wasActive = existingPeer.desired_state === 'active';
    const peer = revokeVpnPeerDesiredInTransaction(location.id);
    const access = remoteAccessByLocation.get(location.id);
    if (access && access.status !== 'revoked') {
      revokeRemoteAccess.run(location.id);
      queueRemoteSupportControl(location.id, 'revoke');
      insertRemoteAccessEvent.run({ locationId: location.id, actorType: 'system', actorId, action: 'revoked' });
    } else if (wasActive && !remoteSupportRevokeIsPending(location.id)) {
      queueRemoteSupportControl(location.id, 'revoke');
    }
    return vpnPeerPayload(peer);
  });
}

// Acknowledging prepare may be the final missing event when the gateway has
// already reconciled its side. Wrap the prepared statement behind the same
// `.run(id, locationId)` shape used by existing HTTP code so older callers
// keep working while the autonomous activation becomes timing-safe.
const markRemoteSupportControlAcked = {
  run(id, locationId) {
    return withRemoteAccessTransaction(() => {
      const control = remoteSupportControlById.get(id, locationId);
      const result = markRemoteSupportControlAckedStatement.run(id, locationId);
      if (result.changes && control?.action === 'prepare') queueReadyVpnActivation(locationId);
      return result;
    });
  },
};

function topologySnapshot(row) {
  if (!row || Number(row.schema_version) !== 1 || !/^[a-f0-9]{64}$/.test(String(row.fingerprint || ''))) return null;
  try {
    const topology = JSON.parse(row.topology_json);
    if (!topology || typeof topology !== 'object' || Array.isArray(topology) || Number(topology.version) !== 1) return null;
    // The fingerprint is computed over the exact canonical serialization
    // created from the validated wire grammar. A damaged row therefore never
    // becomes an owner-visible map or a source for mapping validation.
    const serialized = JSON.stringify(topology);
    const fingerprint = crypto.createHash('sha256').update(serialized).digest('hex');
    if (fingerprint !== row.fingerprint) return null;
    return {
      topology,
      fingerprint,
      firstReportedAt: row.first_reported_at,
      lastReportedAt: row.last_reported_at,
      updatedAt: row.updated_at,
    };
  } catch (_) {
    return null;
  }
}

function confirmedMapping(row, topology) {
  if (!row || Number(row.schema_version) !== 1 || !topology || !/^[a-f0-9]{64}$/.test(String(row.mapping_fingerprint || ''))) return null;
  try {
    const mapping = JSON.parse(row.mapping_json);
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
        mappingFingerprint(mapping) !== row.mapping_fingerprint) return null;
    // Validate from the stored current topology again. This keeps a manually
    // corrupted persistent row from becoming dashboard data.
    const normalized = validateRouterMapping(mapping, topology);
    return JSON.stringify(normalized) === JSON.stringify(mapping) ? normalized : null;
  } catch (_) {
    return null;
  }
}

function waitingForRouterInventory() {
  return {
    status: 'waiting_for_inventory',
    inventoryReportedAt: null,
    inventoryUpdatedAt: null,
    confirmedAt: null,
    mapping: null,
    canConfirm: false,
  };
}

function routerMappingForLocation(location) {
  if (!location) return null;
  // A new pairing token is intentionally staged while the old router stays
  // online.  Its inventory is not evidence about the replacement board, so
  // hide both the old snapshot and the old confirmation until the pending
  // token has completed its receipt and a new inventory has arrived.
  if (hasLivePendingRouterPairing(location)) return waitingForRouterInventory();
  const snapshot = topologySnapshot(routerTopologyByLocation.get(location.id));
  if (!snapshot) return waitingForRouterInventory();
  const fresh = topologyFreshAt(snapshot.lastReportedAt);
  const row = routerMappingByLocation.get(location.id);
  const mapping = confirmedMapping(row, snapshot.topology);
  let status;
  if (!fresh) status = 'inventory_stale';
  else if (row && row.topology_fingerprint !== snapshot.fingerprint) status = 'stale';
  else if (!mapping) status = 'needs_confirmation';
  else status = 'confirmed';
  return {
    status,
    inventoryReportedAt: snapshot.lastReportedAt,
    inventoryUpdatedAt: snapshot.updatedAt,
    confirmedAt: mapping && row.topology_fingerprint === snapshot.fingerprint ? row.confirmed_at : null,
    mapping: mapping && row.topology_fingerprint === snapshot.fingerprint ? mapping : null,
    canConfirm: fresh,
  };
}

function routerTopologyForLocation(location) {
  if (!location) return null;
  // See routerMappingForLocation: a pending replacement deliberately starts
  // with no visible map. Returning no historical topology also prevents an
  // owner UI from accidentally pre-filling the new router's ports.
  if (hasLivePendingRouterPairing(location)) {
    return {
      locationId: location.id,
      topology: null,
      inventory: {
        fingerprint: null,
        firstReportedAt: null,
        reportedAt: null,
        updatedAt: null,
        fresh: false,
      },
      mapping: waitingForRouterInventory(),
    };
  }
  const snapshot = topologySnapshot(routerTopologyByLocation.get(location.id));
  return {
    locationId: location.id,
    topology: snapshot?.topology || null,
    inventory: snapshot ? {
      fingerprint: snapshot.fingerprint,
      firstReportedAt: snapshot.firstReportedAt,
      reportedAt: snapshot.lastReportedAt,
      updatedAt: snapshot.updatedAt,
      fresh: topologyFreshAt(snapshot.lastReportedAt),
    } : {
      fingerprint: null,
      firstReportedAt: null,
      reportedAt: null,
      updatedAt: null,
      fresh: false,
    },
    mapping: routerMappingForLocation(location),
  };
}

function routerTopologyForBusiness({ locationId, businessId }) {
  return routerTopologyForLocation(locationForBusiness.get(locationId, businessId));
}

/**
 * Store an already parsed router report. This is called only after the same
 * authenticated poll has completed its setup receipt, so a staged or old
 * router cannot seed the new owner's mapping screen.
 */
function recordRouterTopology({ locationId, topology, fingerprint }) {
  const location = locationById.get(locationId);
  if (!location) return null;
  // The active router is deliberately allowed to keep serving customers
  // while a replacement kit is pending. Its old port list must not refill
  // the cleared mapping rows in that window.
  if (hasLivePendingRouterPairing(location)) return null;
  const serialized = JSON.stringify(topology);
  const calculated = crypto.createHash('sha256').update(serialized).digest('hex');
  if (!topology || typeof topology !== 'object' || Array.isArray(topology) ||
      Number(topology.version) !== 1 || !/^[a-f0-9]{64}$/.test(String(fingerprint || '')) || fingerprint !== calculated) {
    throw new Error('Refusing an invalid router topology snapshot.');
  }
  const existing = routerTopologyByLocation.get(location.id);
  if (!existing) insertRouterTopology.run({ locationId: location.id, fingerprint, topologyJson: serialized });
  else if (existing.fingerprint !== fingerprint || existing.topology_json !== serialized) {
    replaceRouterTopology.run({ locationId: location.id, fingerprint, topologyJson: serialized });
  } else {
    touchRouterTopology.run(location.id);
  }
  return routerTopologyForLocation(location);
}

/**
 * Confirm an owner-visible topology map. The result is descriptive metadata
 * only: it cannot create a peer, alter a bridge, move a WAN, or change any
 * Hotspot/customer traffic setting on the router.
 */
function confirmRouterMapping({ locationId, businessId, mapping }) {
  const location = locationForBusiness.get(locationId, businessId);
  if (!location) return null;
  if (hasLivePendingRouterPairing(location)) {
    throw remoteAccessError('Wait for the replacement router to pair and report its own inventory before confirming a map.', 409);
  }
  if (!location.router_setup_verified_at || !location.last_successful_sync_at) {
    throw remoteAccessError('Pair the router and wait for a completed WiFi Fiti poll before confirming its map.', 409);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const snapshot = topologySnapshot(routerTopologyByLocation.get(location.id));
    if (!snapshot || !topologyFreshAt(snapshot.lastReportedAt)) {
      throw remoteAccessError('Wait for a fresh router inventory before confirming its map.', 409);
    }
    const normalized = validateRouterMapping(mapping, snapshot.topology);
    const serialized = JSON.stringify(normalized);
    saveRouterMapping.run({
      locationId: location.id,
      topologyFingerprint: snapshot.fingerprint,
      mappingFingerprint: mappingFingerprint(normalized),
      mappingJson: serialized,
    });
    // A new confirmation is a fresh owner decision. Never let an older
    // queued action execute after the owner has reviewed the map again,
    // even when its selected interface names happen to be unchanged.
    cancelPendingMappedDeployments.run({ locationId: location.id, errorCode: 'superseded' });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
  return routerTopologyForLocation(locationForBusiness.get(locationId, businessId));
}

/* ------------------------------------------------------------------ */
/* Signed, map-bound remote deployment controls                       */
/* ------------------------------------------------------------------ */

const MAPPED_DEPLOYMENT_INTERFACE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAPPED_DEPLOYMENT_NONCE = /^[A-Za-z0-9_-]{32,64}$/;
const MAPPED_DEPLOYMENT_SIGNATURE = /^[a-f0-9]{64}$/;
const MAPPED_DEPLOYMENT_ACK = /^deploy\.([1-9]\d{0,15})\.([A-Za-z0-9_-]{32,64})(?:\.(blocked))?$/;

function mappedDeploymentToken(value) {
  const token = String(value || '').trim();
  return MAPPED_DEPLOYMENT_INTERFACE.test(token) ? token : null;
}

function mappedDeploymentTimestamp(value) {
  let text = String(value || '').trim().replace(' ', 'T');
  if (text && !/(?:Z|[+-]\d\d:\d\d)$/i.test(text)) text += 'Z';
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mappedDeploymentHandshakeFresh(value) {
  const timestamp = mappedDeploymentTimestamp(value);
  return timestamp !== null && timestamp <= Date.now() + 5 * 60_000 &&
    timestamp >= Date.now() - MAPPED_DEPLOYMENT_HANDSHAKE_MAX_AGE_MS;
}

function mappedDeploymentCurrentContext(location) {
  if (!location) return { ok: false, blocker: 'location_missing' };
  if (hasLivePendingRouterPairing(location)) return { ok: false, blocker: 'replacement_pending' };
  const snapshot = topologySnapshot(routerTopologyByLocation.get(location.id));
  if (!snapshot) return { ok: false, blocker: 'inventory_missing' };
  if (!topologyFreshAt(snapshot.lastReportedAt)) return { ok: false, blocker: 'inventory_stale' };
  const mappingRow = routerMappingByLocation.get(location.id);
  if (!mappingRow || mappingRow.topology_fingerprint !== snapshot.fingerprint) {
    return { ok: false, blocker: 'mapping_stale' };
  }
  const mapping = confirmedMapping(mappingRow, snapshot.topology);
  if (!mapping) return { ok: false, blocker: 'mapping_needs_confirmation' };
  const hotspotServer = mappedDeploymentToken(snapshot.topology.hotspotServer);
  if (!hotspotServer) return { ok: false, blocker: 'hotspot_not_detected' };
  return { ok: true, snapshot, mappingRow, mapping, hotspotServer };
}

function mappedDeploymentVpnContext(location) {
  const access = remoteAccessByLocation.get(location.id);
  const peer = vpnPeerByLocation.get(location.id);
  if (!config.vpnGateway.enabled) return { ok: false, blocker: 'vpn_not_configured' };
  if (!access || access.status !== 'configured') return { ok: false, blocker: 'remote_access_not_configured' };
  if (!peer || peer.desired_state !== 'active' || peer.gateway_state !== 'ready') {
    return { ok: false, blocker: 'vpn_not_ready' };
  }
  if (!mappedDeploymentHandshakeFresh(peer.last_handshake_at)) {
    return { ok: false, blocker: 'vpn_not_active' };
  }
  return { ok: true, access, peer };
}

function mappedDeploymentBlockerMessage(blocker) {
  const messages = {
    replacement_pending: 'Wait for the replacement router to finish pairing and report its own map.',
    inventory_missing: 'Wait for this router to report its port and Wi-Fi inventory.',
    inventory_stale: 'Wait for a fresh router inventory before deploying.',
    mapping_stale: 'The router layout changed. Review and confirm the map again before deploying.',
    mapping_needs_confirmation: 'Confirm the current router map before deploying.',
    hotspot_not_detected: 'WiFi Fiti could not verify a Hotspot server on the mapped router.',
    vpn_not_configured: 'WiFi Fiti VPN is not configured for this deployment.',
    remote_access_not_configured: 'Enable secure remote access for this router before deploying.',
    vpn_not_ready: 'Wait for the secure VPN connection to finish preparing.',
    vpn_not_active: 'Wait for an active WiFi Fiti VPN handshake before deploying.',
    remote_control_pending: 'Wait for the current secure-connection change to finish before deploying.',
  };
  return messages[blocker] || 'This router is not ready for a mapped deployment.';
}

function mappedDeploymentPayload(context) {
  // Keep property order stable: the same explicit object is HMAC-signed,
  // persisted and later verified before it can be rendered as RouterOS.
  return {
    version: 1,
    action: MAPPED_DEPLOYMENT_ACTION,
    hotspotServer: context.hotspotServer,
    mapping: {
      version: 1,
      wanInterface: context.mapping.wanInterface,
      customerBridge: context.mapping.customerBridge,
      wifiInterfaces: [...context.mapping.wifiInterfaces],
      customerPorts: [...context.mapping.customerPorts],
    },
  };
}

function normalizeMappedDeploymentPayload(value, topology) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 4 || value.version !== 1 || value.action !== MAPPED_DEPLOYMENT_ACTION ||
      !Object.prototype.hasOwnProperty.call(value, 'hotspotServer') ||
      !Object.prototype.hasOwnProperty.call(value, 'mapping')) return null;
  const hotspotServer = mappedDeploymentToken(value.hotspotServer);
  if (!hotspotServer || !topology || hotspotServer !== topology.hotspotServer) return null;
  try {
    const mapping = validateRouterMapping(value.mapping, topology);
    // A stored action must retain the canonical map which was signed. Do not
    // silently sort or repair a damaged payload before routing it to a router.
    if (JSON.stringify(mapping) !== JSON.stringify(value.mapping)) return null;
    return {
      version: 1,
      action: MAPPED_DEPLOYMENT_ACTION,
      hotspotServer,
      mapping,
    };
  } catch (_) {
    return null;
  }
}

function mappedDeploymentSigningKey() {
  const secret = String(config.vpnGateway?.controlSecret || '');
  if (!config.vpnGateway?.enabled || secret.length < 32) {
    throw remoteAccessError('WiFi Fiti VPN signing is not configured for mapped deployment.', 503);
  }
  return secret;
}

function mappedDeploymentEnvelope(row, payload) {
  return JSON.stringify({
    version: 1,
    id: Number(row.id),
    locationId: row.location_id,
    action: row.action,
    topologyFingerprint: row.topology_fingerprint,
    mappingFingerprint: row.mapping_fingerprint,
    nonce: row.nonce,
    payload,
  });
}

function mappedDeploymentSignature(row, payload) {
  return crypto.createHmac('sha256', mappedDeploymentSigningKey())
    .update(mappedDeploymentEnvelope(row, payload))
    .digest('hex');
}

function mappedDeploymentReceipt(row) {
  // A receipt is derived, never stored. Leaking a database row therefore
  // cannot by itself acknowledge an action; the VPN control secret remains
  // necessary to reproduce this value.
  return crypto.createHmac('sha256', mappedDeploymentSigningKey())
    .update(`mapped-deployment-ack\n${row.signature}`)
    .digest('base64url');
}

function equalMappedDeploymentValue(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return Boolean(a.length && a.length === b.length && crypto.timingSafeEqual(a, b));
}

function verifiedMappedDeployment(row, context) {
  if (!row || row.action !== MAPPED_DEPLOYMENT_ACTION || !MAPPED_DEPLOYMENT_NONCE.test(String(row.nonce || '')) ||
      !MAPPED_DEPLOYMENT_SIGNATURE.test(String(row.signature || '')) ||
      !/^[a-f0-9]{64}$/.test(String(row.topology_fingerprint || '')) ||
      !/^[a-f0-9]{64}$/.test(String(row.mapping_fingerprint || ''))) return null;
  let parsed;
  try { parsed = JSON.parse(row.payload_json); } catch (_) { return null; }
  const payload = normalizeMappedDeploymentPayload(parsed, context.snapshot.topology);
  if (!payload || row.topology_fingerprint !== context.snapshot.fingerprint ||
      row.mapping_fingerprint !== mappingFingerprint(payload.mapping)) return null;
  try {
    return equalMappedDeploymentValue(row.signature, mappedDeploymentSignature(row, payload)) ? payload : null;
  } catch (_) {
    // A removed/rotated deployment signing configuration must fail closed,
    // not turn a normal router poll into a server error or render a stale
    // control from a previously configured gateway.
    return null;
  }
}

function mappedDeploymentPublic(row) {
  if (!row || !MAPPED_DEPLOYMENT_STATUSES.has(row.status)) return null;
  return {
    id: Number(row.id),
    action: row.action,
    status: row.status,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at || null,
    acknowledgedAt: row.acknowledged_at || null,
    cancelledAt: row.cancelled_at || null,
    updatedAt: row.updated_at,
  };
}

function reconcileMappedDeployment(location) {
  const current = activeMappedDeploymentByLocation.get(location.id);
  if (!current) return null;
  const context = mappedDeploymentCurrentContext(location);
  if (!context.ok) {
    const errorCode = context.blocker === 'replacement_pending' ? 'replacement_pending' : 'mapping_stale';
    const status = context.blocker === 'replacement_pending' ? 'cancelled' : 'stale';
    markMappedDeploymentState.run({ id: current.id, locationId: location.id, status, errorCode });
    return activeMappedDeploymentByLocation.get(location.id);
  }
  if (current.topology_fingerprint !== context.snapshot.fingerprint ||
      current.mapping_fingerprint !== mappingFingerprint(context.mapping)) {
    markMappedDeploymentState.run({ id: current.id, locationId: location.id, status: 'stale', errorCode: 'mapping_stale' });
    return null;
  }
  return current;
}

function mappedDeploymentReadiness(location) {
  if (!location) return { canRequest: false, blocker: 'location_missing', mappingCurrent: false, vpnActive: false };
  const map = mappedDeploymentCurrentContext(location);
  const vpn = mappedDeploymentVpnContext(location);
  const remoteControlPending = outstandingRemoteSupportControls.all(location.id).length > 0;
  const blocker = !map.ok ? map.blocker : (!vpn.ok ? vpn.blocker : (remoteControlPending ? 'remote_control_pending' : null));
  return {
    canRequest: !blocker,
    blocker,
    mappingCurrent: map.ok,
    vpnActive: vpn.ok,
  };
}

function mappedDeploymentForBusiness({ locationId, businessId }) {
  const location = locationForBusiness.get(locationId, businessId);
  if (!location) return null;
  reconcileMappedDeployment(location);
  const readiness = mappedDeploymentReadiness(location);
  return {
    deployment: mappedDeploymentPublic(latestMappedDeploymentByLocation.get(location.id)),
    canRequest: readiness.canRequest,
    blocker: readiness.blocker,
    mappingCurrent: readiness.mappingCurrent,
    vpnActive: readiness.vpnActive,
  };
}

function requestMappedDeployment({ locationId, businessId }) {
  const location = locationForBusiness.get(locationId, businessId);
  if (!location) return null;
  return withRemoteAccessTransaction(() => {
    const existing = reconcileMappedDeployment(location);
    if (existing) return { ...mappedDeploymentForBusiness({ locationId, businessId }), reused: true };
    const readiness = mappedDeploymentReadiness(location);
    if (!readiness.canRequest) {
      throw remoteAccessError(mappedDeploymentBlockerMessage(readiness.blocker), 409);
    }
    const context = mappedDeploymentCurrentContext(location);
    const payload = mappedDeploymentPayload(context);
    const inserted = insertMappedDeployment.run({
      locationId: location.id,
      action: MAPPED_DEPLOYMENT_ACTION,
      topologyFingerprint: context.snapshot.fingerprint,
      mappingFingerprint: mappingFingerprint(context.mapping),
      payloadJson: JSON.stringify(payload),
      nonce: crypto.randomBytes(24).toString('base64url'),
      signature: '',
    });
    const row = mappedDeploymentById.get(Number(inserted.lastInsertRowid), location.id);
    const signature = mappedDeploymentSignature(row, payload);
    if (!setMappedDeploymentSignature.run({ id: row.id, locationId: location.id, signature }).changes) {
      throw new Error('Could not sign the mapped deployment.');
    }
    return { ...mappedDeploymentForBusiness({ locationId, businessId }), reused: false };
  });
}

/**
 * Return exactly one locally executable, server-signed deployment action for
 * a verified router poll. It shares the safe support-ack transport but never
 * shares the WireGuard lifecycle queue. An active support lifecycle action
 * wins, so a cleanup or re-enrollment cannot race a mapping action.
 */
function pendingMappedDeploymentForRouter(location) {
  if (!location || location.router_pairing_auth === 'pending' || !location.router_setup_verified_at) return null;
  if (outstandingRemoteSupportControls.all(location.id).length) return null;
  const active = reconcileMappedDeployment(location);
  if (!active) return null;
  const due = active.status === 'queued' || !active.delivered_at ||
    mappedDeploymentTimestamp(active.delivered_at) === null ||
    mappedDeploymentTimestamp(active.delivered_at) <= Date.now() - 60_000;
  if (!due) return null;
  // The action is sent only while the gateway has recently observed the
  // management tunnel. HTTPS is still the delivery path because it requires
  // no Winbox/API credential or exposed RouterOS service.
  if (!mappedDeploymentVpnContext(location).ok) return null;
  const context = mappedDeploymentCurrentContext(location);
  if (!context.ok) return null;
  const payload = verifiedMappedDeployment(active, context);
  if (!payload) {
    markMappedDeploymentState.run({ id: active.id, locationId: location.id, status: 'failed', errorCode: 'invalid_signature' });
    return null;
  }
  return {
    id: Number(active.id),
    action: MAPPED_DEPLOYMENT_ACTION,
    topologyFingerprint: active.topology_fingerprint,
    signature: active.signature,
    receipt: mappedDeploymentReceipt(active),
    hotspotServer: payload.hotspotServer,
    mapping: payload.mapping,
  };
}

function markMappedDeploymentDeliveredForRouter({ locationId, id }) {
  const deploymentId = Number(id);
  if (!Number.isInteger(deploymentId) || deploymentId < 1) return false;
  return Boolean(markMappedDeploymentDelivered.run(deploymentId, locationId).changes);
}

function acknowledgeMappedDeploymentForRouter({ locationId, acknowledgement }) {
  const match = MAPPED_DEPLOYMENT_ACK.exec(String(acknowledgement || '').trim());
  if (!match) return { handled: false, acknowledged: false };
  const deploymentId = Number(match[1]);
  const receipt = match[2];
  const blocked = match[3] === 'blocked';
  const row = mappedDeploymentById.get(deploymentId, locationId);
  if (!row) return { handled: true, acknowledged: false };
  const location = locationById.get(locationId);
  if (!location) return { handled: true, acknowledged: false };
  const context = mappedDeploymentCurrentContext(location);
  if (!context.ok || row.topology_fingerprint !== context.snapshot?.fingerprint ||
      row.mapping_fingerprint !== mappingFingerprint(context.mapping || {})) {
    if (MAPPED_DEPLOYMENT_PENDING.has(row.status)) {
      const errorCode = context.blocker === 'replacement_pending' ? 'replacement_pending' : 'mapping_stale';
      const status = context.blocker === 'replacement_pending' ? 'cancelled' : 'stale';
      markMappedDeploymentState.run({ id: row.id, locationId, status, errorCode });
    }
    return { handled: true, acknowledged: false };
  }
  const payload = verifiedMappedDeployment(row, context);
  if (!payload || !equalMappedDeploymentValue(receipt, mappedDeploymentReceipt(row))) {
    if (MAPPED_DEPLOYMENT_PENDING.has(row.status)) {
      markMappedDeploymentState.run({ id: row.id, locationId, status: 'failed', errorCode: 'invalid_signature' });
    }
    return { handled: true, acknowledged: false };
  }
  if (blocked) {
    if (MAPPED_DEPLOYMENT_PENDING.has(row.status)) {
      markMappedDeploymentState.run({ id: row.id, locationId, status: 'stale', errorCode: 'mapping_stale' });
    }
    return { handled: true, acknowledged: false, blocked: true };
  }
  if (row.status === 'acknowledged') return { handled: true, acknowledged: true, idempotent: true };
  if (!MAPPED_DEPLOYMENT_PENDING.has(row.status)) return { handled: true, acknowledged: false };
  return { handled: true, acknowledged: Boolean(acknowledgeMappedDeployment.run(row.id, locationId).changes) };
}

/**
 * Compatibility marker for an already-installed legacy poller. New generated
 * kits use `processRouterSetupReceipt` below, which requires the router to
 * echo a nonce from the previous cloud response before it can be considered
 * ready. Keeping this narrowly named helper lets old, already-paired routers
 * continue working without allowing a staged replacement to promote itself.
 */
function recordSuccessfulRouterSync(locationId) {
  verifyActiveRouterSetup.run({ locationId, health: 'legacy' });
  return locationById.get(locationId);
}

function recordRouterPortalUpdateSent(locationId, hostname) {
  markRouterPortalUpdateSent.run(hostname || null, locationId);
  return locationById.get(locationId);
}

function recordRouterPortalApplied(locationId, hostname) {
  markRouterPortalApplied.run(hostname || null, locationId);
  return locationById.get(locationId);
}

const ROUTER_SETUP_HEALTH = new Set([
  'ready', 'bridge-missing', 'hotspot-missing', 'poller-missing',
  'portal-missing', 'device-mode-blocked', 'unknown',
]);

function setupHealth(value) {
  const health = String(value || '').trim().toLowerCase();
  return ROUTER_SETUP_HEALTH.has(health) ? health : 'unknown';
}

function setupNonce() {
  // This nonce is not a credential; it is an acknowledgement challenge. It
  // is still high entropy so a stale or unrelated response cannot accidentally
  // satisfy it.
  return crypto.randomBytes(18).toString('base64url');
}

// A staged credential is deliberately separate from the active router so a
// customer connection keeps working while an owner prepares a replacement.
// Any owner-facing action that claims the *current* setup is complete must
// nevertheless treat this as unverified until the staged router echoes its
// own receipt challenge.
function hasLivePendingRouterPairing(location) {
  if (!location) return false;
  // Owner-facing location queries intentionally select only this boolean,
  // never the staged credential hash. Honour it when available so the same
  // safety gate applies to `/api/business/me`, the mapping endpoint, and
  // internal router records alike.
  if (location.router_pairing_pending !== undefined && location.router_pairing_pending !== null) {
    return Boolean(location.router_pairing_pending);
  }
  if (!location.router_pending_token_hash) return false;
  const expiresAt = Date.parse(String(location.router_pending_token_expires_at || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function pendingSetupSnapshot(location) {
  let pending = null;
  try { pending = location.router_pending_setup_json ? JSON.parse(location.router_pending_setup_json) : null; } catch (_) { /* use live settings */ }
  const current = {
    name: location.name,
    routerName: location.router_name,
    ...savedSetup(setupFromLocation(location)),
  };
  const value = pending && typeof pending === 'object' ? { ...current, ...pending } : current;
  // Only fields originating in server-side setup validation are accepted at
  // this boundary. A malformed historical JSON value can therefore never
  // become RouterOS-related configuration.
  return {
    name: String(value.name || current.name).slice(0, 80),
    routerName: value.routerName == null ? null : String(value.routerName).slice(0, 80),
    hotspotServer: value.hotspotServer || current.hotspotServer,
    setupMode: value.setupMode || current.setupMode,
    routerModel: value.routerModel || current.routerModel,
    routerOsVersion: value.routerOsVersion || current.routerOsVersion,
    wifiStack: value.wifiStack || current.wifiStack,
    customerBridge: value.customerBridge || current.customerBridge,
    wanInterface: value.wanInterface || current.wanInterface,
    wifiInterface: value.wifiInterface || current.wifiInterface,
    wifiSsid: value.wifiSsid || current.wifiSsid,
    customerPorts: value.customerPorts || current.customerPorts,
    hotspotSubnet: value.hotspotSubnet || current.hotspotSubnet,
  };
}

function issueSetupChallenge(location, pairing, health) {
  const pending = pairing === 'pending';
  const nonce = pending ? location.router_pending_setup_nonce : location.router_setup_nonce;
  const challenge = nonce || setupNonce();
  const statement = pending ? setPendingRouterSetupNonce : setRouterSetupNonce;
  const result = pending
    ? statement.run({ locationId: location.id, routerTokenHash: location.router_pending_token_hash, nonce: challenge, health })
    : statement.run({ locationId: location.id, nonce: challenge, health });
  // A staged credential may have expired between authentication and this
  // update. In that case return no challenge; the caller will simply reject
  // the next request rather than issuing a misleading receipt.
  return result.changes ? challenge : null;
}

/**
 * Process the second half of a setup round trip. A router first receives a
 * random challenge in its script response, saves it as `fitiSetupAck`, then
 * sends it back on the next poll along with a small local health report.
 * That proves the response was parsed and executed; a request that was
 * dropped before RouterOS saw its body cannot accidentally unlock service.
 */
function processRouterSetupReceipt(location, { protocol, ack, health } = {}) {
  if (!location) return { verified: false, challenge: null, location: null };
  const pairing = location.router_pairing_auth === 'pending' ? 'pending' : 'active';
  const reportedHealth = setupHealth(health);
  const currentNonce = pairing === 'pending' ? location.router_pending_setup_nonce : location.router_setup_nonce;

  // A router that was already verified can temporarily report portal-missing
  // after its branded login file is changed or lost. Treat that as a repair
  // request, not as a failed pairing: the sync response must be allowed to
  // deliver the portal-refresh script. Pending replacement routers still
  // require a fully ready receipt before they can be promoted.
  if (pairing === 'active' && location.router_setup_verified_at && reportedHealth === 'portal-missing') {
    verifyActiveRouterSetup.run({ locationId: location.id, health: reportedHealth });
    return { verified: true, portalRepair: true, challenge: null, location: locationById.get(location.id) };
  }

  // Existing field deployments did not send the receipt fields. Preserve
  // their active connection, but never use that compatibility path to switch
  // a staged credential to a new router.
  if (String(protocol || '') !== '2') {
    if (pairing === 'active') {
      verifyActiveRouterSetup.run({ locationId: location.id, health: 'legacy' });
      return { verified: true, legacy: true, challenge: null, location: locationById.get(location.id) };
    }
    return { verified: false, challenge: issueSetupChallenge(location, pairing, reportedHealth), location: locationById.get(location.id) };
  }

  // A new kit deliberately reports `portal-missing` until the cloud has
  // delivered its branded login page.  Requiring the page before accepting
  // the receipt creates a deadlock: the cloud withholds the page until the
  // receipt proves the router can execute a response, while the router keeps
  // asking for another receipt because its page is still missing.  The other
  // control-plane checks are already present in the poller, so this state is
  // safe to accept only after the nonce is echoed back.
  const receiptHealthOk = reportedHealth === 'ready' || reportedHealth === 'portal-missing';
  if (!receiptHealthOk || !currentNonce || String(ack || '') !== currentNonce) {
    return { verified: false, challenge: issueSetupChallenge(location, pairing, reportedHealth), location: locationById.get(location.id) };
  }

  if (pairing === 'active') {
    verifyActiveRouterSetup.run({ locationId: location.id, health: reportedHealth });
    return { verified: true, challenge: null, location: locationById.get(location.id) };
  }

  const next = pendingSetupSnapshot(location);
  const promotion = promotePendingLocationToken.run({
    ...next,
    locationId: location.id,
    routerTokenHash: location.router_pending_token_hash,
    health: reportedHealth,
    // `router_token` is only a non-secret uniqueness marker retained for old
    // SQLite schemas. The pending hash is already unique and does not reveal
    // the usable credential, so it is a safe marker once promotion succeeds.
    routerTokenMarker: `hash:${location.router_pending_token_hash}`,
    nonce: currentNonce,
  });
  if (promotion.changes) {
    return { verified: true, promoted: true, challenge: null, location: locationById.get(location.id) };
  }
  return { verified: false, challenge: null, location: locationById.get(location.id) };
}

/** Finish the customer-facing side automatically once the router's setup is
 * independently verified. With the gateway enabled this creates a unique
 * managed subdomain; without it customers use the durable cloud portal URL.
 */
function autoCompleteCustomerPortal(locationId) {
  const initial = locationById.get(locationId);
  if (!initial || !initial.router_setup_verified_at) return initial || null;
  db.exec('BEGIN IMMEDIATE');
  try {
    let location = locationById.get(locationId);
    if (config.domains.portalGatewayEnabled && !location.portal_hostname) {
      const hostname = managedPortalHostname(location.portal_name || location.business_name || location.name, location.id);
      const existing = hostname && portalDomainByHostnameAnyStatus.get(hostname);
      if (hostname && (!existing || existing.location_id === location.id)) {
        if (!existing) addPortalDomain.run({ hostname, locationId: location.id, kind: 'managed', status: 'active', isPrimary: 0 });
        deactivatePrimaryPortalDomains.run(location.id);
        activatePortalDomain.run(hostname, location.id);
      }
    }
    completeTenantLocationPortalSetup.run({ locationId: location.id });
    completeTenantBusinessPortalSetup.run({ businessId: location.business_id });
    db.exec('COMMIT');
    return locationById.get(location.id);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
}

function setManagedPortalHostname({ locationId, businessId, slug }) {
  if (!config.domains.portalGatewayEnabled) {
    const error = new Error('Tenant portal addresses will be available after WiFi Fiti finishes the Cloudflare gateway setup.');
    error.status = 503;
    throw error;
  }
  const location = locationForBusiness.get(locationId, businessId);
  if (!location) return null;
  // A branded public hostname changes what an unauthenticated phone opens.
  // Do not let a draft reserve or expose that customer-facing step before
  // the router has proved that its WiFi Fiti connection works at least once.
  // It may be offline later; the polling script will apply the saved address
  // on its next check-in.
  const control = locationById.get(location.id);
  if (!location.last_successful_sync_at || hasLivePendingRouterPairing(control)) {
    const error = new Error('Finish router setup before choosing the customer portal address.');
    error.status = 409;
    throw error;
  }
  const hostname = managedPortalHostnameFromSlug(slug);
  if (!hostname) {
    const error = new Error('Use 1–63 lowercase letters, numbers, or hyphens for the portal address.');
    error.status = 400;
    throw error;
  }

  const existing = portalDomainByHostnameAnyStatus.get(hostname);
  if (existing && existing.location_id !== locationId) {
    const error = new Error('That customer portal address is already in use.');
    error.status = 409;
    throw error;
  }
  const wouldAddActiveAddress = !existing || existing.status !== 'active';
  if (wouldAddActiveAddress && activePortalDomainCountForLocation.get(locationId).count >= MAX_ACTIVE_PORTAL_DOMAINS_PER_LOCATION) {
    const error = new Error('This location already has three active portal addresses. Contact WiFi Fiti support to retire an older address.');
    error.status = 409;
    throw error;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    if (!existing) addPortalDomain.run({ hostname, locationId, kind: 'managed', status: 'active', isPrimary: 0 });
    deactivatePrimaryPortalDomains.run(locationId);
    activatePortalDomain.run(hostname, locationId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
  return { ...locationForBusiness.get(locationId, businessId), portalDomains: portalDomainsForLocation.all(locationId) };
}

function rotateLocationToken({ locationId, businessId, pendingSetup } = {}) {
  const location = locationForBusiness.get(locationId, businessId);
  if (!location) return null;
  const routerToken = crypto.randomBytes(24).toString('base64url');
  const hash = tokenHash(routerToken);
  // Staging keeps the live router online until the replacement has completed
  // a two-poll receipt handshake. A pasted-but-never-imported kit therefore
  // cannot interrupt paid customers or alter their active configuration.
  const pendingSetupJson = pendingSetup ? JSON.stringify(pendingSetup) : null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const staged = stageLocationToken.run({ tokenHash: hash, expiresAt: nowSql(Date.now() + 24 * 60 * 60 * 1000), locationId, pendingSetupJson });
    if (!staged.changes) {
      db.exec('COMMIT');
      return null;
    }
    // This is a pairing-generation boundary. A topology and owner mapping
    // describe the outgoing router only; retaining either can cause the new
    // board to be displayed as configured before it has reported itself.
    // The same boundary cancels any queued mapped deployment. A response
    // already in flight cannot be recalled, so the RouterOS action also
    // validates every selected port locally before it can acknowledge.
    cancelPendingMappedDeployments.run({ locationId, errorCode: 'replacement_pending' });
    deleteRouterMapping.run(locationId);
    deleteRouterTopology.run(locationId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
  // Return a post-transaction row so a caller that uses this one-time
  // response (rather than immediately reloading `/api/business/me`) also
  // sees the replacement as pending and cannot render an old map briefly.
  return { ...locationForBusiness.get(locationId, businessId), routerToken };
}

function updateLocationSettings({ locationId, businessId, name, routerName, hotspotServer, setup }) {
  const current = locationForBusiness.get(locationId, businessId);
  if (!current) return null;
  const resolvedHotspotServer = hotspotServer === undefined
    ? (setup?.hotspotServer === undefined ? current.hotspot_server : setup.hotspotServer)
    : hotspotServer;
  const saved = savedSetup({ ...setupFromLocation(current), ...(setup || {}), hotspotServer: resolvedHotspotServer });
  updateLocation.run({ id: locationId, businessId, name: name || current.name,
    routerName: routerName === undefined ? current.router_name || null : routerName || null, ...saved });
  return locationForBusiness.get(locationId, businessId);
}

/** Stage a replacement kit and its future settings together. The active
 * router keeps both its token and its Hotspot settings until the new router
 * acknowledges the receipt challenge, at which point this snapshot promotes
 * atomically with the credential. */
function stageLocationReplacement({ locationId, businessId, name, routerName, hotspotServer, setup }) {
  const current = locationForBusiness.get(locationId, businessId);
  if (!current) return null;
  const resolvedHotspotServer = hotspotServer === undefined
    ? (setup?.hotspotServer === undefined ? current.hotspot_server : setup.hotspotServer)
    : hotspotServer;
  const saved = savedSetup({ ...setupFromLocation(current), ...(setup || {}), hotspotServer: resolvedHotspotServer });
  const next = {
    name: name || current.name,
    routerName: routerName === undefined ? current.router_name || null : routerName || null,
    ...saved,
  };
  const staged = rotateLocationToken({ locationId, businessId, pendingSetup: next });
  if (!staged) return null;
  // Reflect the owner's requested label in the one-time response without
  // claiming that the live router already uses the staged configuration.
  return { ...staged, name: next.name, router_name: next.routerName, routerToken: staged.routerToken, pending_setup: true };
}

/**
 * Delete only a pristine dashboard draft. This is intentionally not a router
 * factory reset and not an archive operation: it removes the one-time cloud
 * pairing and managed portal address before either one has served anybody.
 * Once a router has checked in or commercial data exists, the replacement-kit
 * path must be used so records and existing customers are kept safe.
 */
function discardUnusedLocation({ locationId, businessId, confirm }) {
  if (confirm !== 'DELETE') {
    const error = new Error('Type DELETE to remove an unused setup.');
    error.status = 400;
    throw error;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const location = unusedLocationForDiscard.get({ locationId, businessId });
    if (!location) {
      db.exec('COMMIT');
      return null;
    }
    // Support operations are attached by the HTTP server after this module is
    // loaded, so only query that optional table when it exists. A support
    // record is still business history and must block a discard.
    const supportTicketCount = databaseTableExists.get('business_support_tickets')
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM business_support_tickets WHERE location_id=?`).get(location.id).count)
      : 0;
    const hasHistory = Number(location.transaction_count) || Number(location.subscription_count) ||
      Number(location.job_count) || Number(location.device_count) || Number(location.voucher_count) ||
      Number(location.remote_access_count) || Number(location.remote_access_event_count) ||
      Number(location.remote_control_count) || Number(location.vpn_peer_count) ||
      Number(location.topology_count) || Number(location.mapping_count) || Number(location.mapped_deployment_count) || supportTicketCount;
    if (location.router_status !== 'waiting' || location.last_seen_at || location.last_router_contact_at || location.last_successful_sync_at || hasHistory) {
      const error = new Error('This setup has already been paired or has customer, payment, voucher, router-job, support, or remote-setup history. Keep the location and generate a replacement router kit instead.');
      error.status = 409;
      throw error;
    }
    // Delete the hostname first. It is the one location relation that has a
    // foreign-key declaration on newer databases, and it must not keep an
    // unused branded address reserved after the draft is gone.
    deletePortalDomainsForLocation.run(location.id);
    deleteLocationForBusiness.run(location.id, businessId);
    db.exec('COMMIT');
    return { id: location.id, name: location.name };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transaction already closed */ }
    throw error;
  }
}

function authenticateRouter(locationId, rawToken, transport = 'header') {
  const location = locationById.get(locationId);
  if (location?.router_auth_mode === 'header' && transport !== 'header') return null;
  const suppliedHash = tokenHash(rawToken);
  const supplied = Buffer.from(suppliedHash, 'hex');
  const matches = (expectedHash) => {
    const expected = Buffer.from(expectedHash || '', 'hex');
    return Boolean(expected.length && expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied));
  };
  if (!location || !supplied.length) return null;
  if (matches(location.router_token_hash)) {
    touchRouter.run(locationId);
    return { ...location, router_pairing_auth: 'active' };
  }
  const pendingExpiry = Date.parse(String(location.router_pending_token_expires_at || '').replace(' ', 'T') + 'Z');
  if (matches(location.router_pending_token_hash) && Number.isFinite(pendingExpiry) && pendingExpiry > Date.now()) {
    touchRouter.run(locationId);
    return { ...location, router_pairing_auth: 'pending' };
  }
  return null;
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
  // A top-up follows the package the customer selected. A blank speed means
  // return to the normal RouterOS profile rather than retain an old per-user
  // limit invisibly.
  const rateLimit = transaction.rate_limit || null;
  const oldExpiry = existing?.expires_at ? new Date(existing.expires_at.replace(' ', 'T') + 'Z').getTime() : 0;
  const expiresAt = nowSql(Math.max(Date.now(), Number.isFinite(oldExpiry) ? oldExpiry : 0) + transaction.seconds * 1000);
  upsertSubscription.run({ id, businessId: transaction.business_id, locationId: transaction.location_id,
    routerUsername, payerPhone: transaction.phone, mac: transaction.mac, password, totalSeconds, rateLimit, expiresAt });
  meterDevice.run(transaction.business_id, transaction.mac);
  const job = insertJob.run({ locationId: transaction.location_id, username: routerUsername, password, profile,
    totalSeconds, rateLimit, mac: transaction.mac, ip: transaction.ip || null, action: 'upsert' });
  // A top-up must refresh the TV's RouterOS ceiling too. Otherwise the
  // phone receives the extension but its paired TV disconnects early.
  for (const device of devicesForSubscription.all(transaction.location_id, id)) {
    insertJob.run({ locationId: transaction.location_id, username: `${routerUsername}-tv`, password, profile,
      totalSeconds, rateLimit, mac: device.mac, ip: null, action: 'upsert' });
  }
  return { id, username: routerUsername, password, totalSeconds, rateLimit, expiresAt,
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
    profile, totalSeconds: subscription.total_seconds, rateLimit: subscription.rate_limit, mac, ip: ip || null, action: 'transfer' });
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
    profile, totalSeconds: subscription.total_seconds, rateLimit: subscription.rate_limit, mac, ip: null, action: 'upsert' });
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
    totalSeconds: 1, rateLimit: null, mac: null, ip: null, action: 'revoke' });
  return true;
}

function issueVouchers({ businessId, locationId, packageId, packageName, seconds, rateLimit, count, batch }) {
  const issued = [];
  for (let tries = 0; issued.length < count && tries < count * 5; tries++) {
    const code = `FITI${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    try {
      addVoucher.run({ code, businessId, locationId, packageId, packageName, seconds,
        rateLimit: rateLimit || null, batch: batch || null });
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
      seconds: voucher.seconds, rate_limit: voucher.rate_limit, checkout_request_id: `voucher-${voucher.code}`,
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
      profile: 'standard', totalSeconds: 1, rateLimit: null, mac: null, ip: null, action: 'revoke' });
    // A TV has its own RouterOS identity and therefore its own local uptime
    // counter. Revoke it alongside the phone so a TV cannot outlive the
    // server's wall-clock expiry.
    for (const device of devicesForSubscription.all(locationId, subscription.id)) {
      insertJob.run({ locationId, username: `${subscription.router_username}-tv`, password: '2222',
        profile: 'standard', totalSeconds: 1, rateLimit: null, mac: null, ip: null, action: 'revoke' });
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
  tokenHash, createLocation, rotateLocationToken, updateLocationSettings, stageLocationReplacement, discardUnusedLocation, setManagedPortalHostname, authenticateRouter, processRouterSetupReceipt, autoCompleteCustomerPortal, recordSuccessfulRouterSync, recordRouterPortalUpdateSent, recordRouterPortalApplied,
  recordRouterTopology, routerTopologyForLocation, routerTopologyForBusiness, routerMappingForLocation, confirmRouterMapping,
  mappedDeploymentForBusiness, requestMappedDeployment, pendingMappedDeploymentForRouter,
  markMappedDeploymentDeliveredForRouter, acknowledgeMappedDeploymentForRouter,
  locationById, locationForBusiness, locationsForBusiness, primaryPortalDomain, portalDomainByHostname, portalDomainForLocationHostname, portalDomainsForLocation, managedPortalSlugReserved,
  remoteAccessForLocation, remoteAccessForBusiness, requestRemoteAccess, revokeRemoteAccessForBusiness, manageRemoteAccess, recordRemoteAccessEnrollment,
  provisionRemoteVpn, allocateDesiredVpnPeer, desiredVpnPeersForGateway, reportVpnGatewaySync,
  recordVpnGatewayPeer, recordVpnGatewayError, recordVpnPeerHandshake, revokeVpnPeer,
  pendingRemoteSupportControls, markRemoteSupportControlDelivered, markRemoteSupportControlAcked,
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

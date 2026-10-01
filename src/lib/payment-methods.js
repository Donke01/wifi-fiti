'use strict';

/**
 * Payment methods: where a router's customer payments land.
 *
 * A business can hold many methods and give each router its own:
 *   fiti            Wi-Fi Fiti collects; the sale (less the fee) is paid out
 *   daraja:<id>     one of the business's own Till / PayBill accounts
 *   tuma            the business's Tuma settlement account
 *
 * Which method a router uses (resolve):
 *   1. the router's own choice, if it is still usable
 *   2. else the business default, if it is still usable
 *   3. else the behaviour from before payment methods existed: the selected
 *      provider (Tuma), the business collection mode (own Till/PayBill), or
 *      Wi-Fi Fiti collection. Existing businesses therefore keep exactly the
 *      same payment path until they choose otherwise.
 *
 * Daraja secrets are encrypted at rest with the tenant secret key and never
 * leave this module except as credentials for an M-Pesa call.
 */

const crypto = require('node:crypto');

const KINDS = ['fiti', 'daraja', 'tuma'];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const cleanLabel = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const TRANSACTION_TYPES = { CustomerPayBillOnline: 'PayBill', CustomerBuyGoodsOnline: 'Till (Buy Goods)' };

function createPaymentMethods({ db, tenant, paymentIntegrations, tumaConnected = () => false }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_mpesa_accounts (
      id                     TEXT PRIMARY KEY,
      business_id            TEXT NOT NULL,
      label                  TEXT,
      shortcode              TEXT NOT NULL,
      transaction_type       TEXT NOT NULL,
      consumer_key_cipher    TEXT NOT NULL,
      consumer_secret_cipher TEXT NOT NULL,
      passkey_cipher         TEXT NOT NULL,
      last_verified_at       TEXT,
      active                 INTEGER NOT NULL DEFAULT 1,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_mpesa_accounts_business ON tenant_mpesa_accounts(business_id, active);
    CREATE TABLE IF NOT EXISTS business_payment_routing (
      business_id    TEXT PRIMARY KEY,
      default_method TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS location_payment_methods (
      location_id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      method      TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // The method a payment was taken with, so its status check and history
  // use that account even if the router is later moved to another one.
  try { db.exec('ALTER TABLE tenant_transactions ADD COLUMN payment_method TEXT'); } catch (_) { /* present */ }

  const accountsFor = db.prepare(`SELECT id, label, shortcode, transaction_type, last_verified_at, created_at
      FROM tenant_mpesa_accounts WHERE business_id=? AND active=1 ORDER BY created_at, rowid`);
  const accountRow = db.prepare('SELECT * FROM tenant_mpesa_accounts WHERE id=? AND business_id=?');
  const activeAccount = db.prepare('SELECT * FROM tenant_mpesa_accounts WHERE id=? AND business_id=? AND active=1');
  const sameAccount = db.prepare(`SELECT id FROM tenant_mpesa_accounts WHERE business_id=? AND shortcode=? AND transaction_type=? AND active=1`);
  const insertAccount = db.prepare(`INSERT INTO tenant_mpesa_accounts
      (id, business_id, label, shortcode, transaction_type, consumer_key_cipher, consumer_secret_cipher, passkey_cipher, last_verified_at)
      VALUES (@id, @businessId, @label, @shortcode, @transactionType, @key, @secret, @passkey, @verifiedAt)`);
  const updateAccountSecrets = db.prepare(`UPDATE tenant_mpesa_accounts SET label=COALESCE(@label, label),
      consumer_key_cipher=@key, consumer_secret_cipher=@secret, passkey_cipher=@passkey, last_verified_at=@verifiedAt,
      updated_at=datetime('now') WHERE id=@id AND business_id=@businessId`);
  const renameAccount = db.prepare(`UPDATE tenant_mpesa_accounts SET label=?, updated_at=datetime('now') WHERE id=? AND business_id=? AND active=1`);
  const retireAccount = db.prepare(`UPDATE tenant_mpesa_accounts SET active=0, updated_at=datetime('now') WHERE id=? AND business_id=? AND active=1`);
  const legacyConnections = db.prepare('SELECT * FROM tenant_mpesa_connections');
  const legacyConnection = db.prepare('SELECT * FROM tenant_mpesa_connections WHERE business_id=?');
  const routingFor = db.prepare('SELECT default_method FROM business_payment_routing WHERE business_id=?');
  const saveRouting = db.prepare(`INSERT INTO business_payment_routing (business_id, default_method, updated_at)
      VALUES (?, ?, datetime('now')) ON CONFLICT(business_id) DO UPDATE SET default_method=excluded.default_method, updated_at=datetime('now')`);
  const routerChoice = db.prepare('SELECT method FROM location_payment_methods WHERE location_id=? AND business_id=?');
  const saveRouterChoice = db.prepare(`INSERT INTO location_payment_methods (location_id, business_id, method, updated_at)
      VALUES (?, ?, ?, datetime('now')) ON CONFLICT(location_id) DO UPDATE SET method=excluded.method, business_id=excluded.business_id, updated_at=datetime('now')`);
  const clearRouterChoice = db.prepare('DELETE FROM location_payment_methods WHERE location_id=? AND business_id=?');
  const routersUsing = db.prepare('SELECT location_id FROM location_payment_methods WHERE business_id=? AND method=?');
  const setTransactionMethod = db.prepare('UPDATE tenant_transactions SET payment_method=? WHERE checkout_request_id=?');
  const collectionMode = db.prepare('SELECT collection_mode FROM businesses WHERE id=?');

  const secretsOf = (v) => ({ id: v.id, businessId: v.businessId, label: v.label, key: v.key, secret: v.secret, passkey: v.passkey, verifiedAt: v.verifiedAt });
  // The Till / PayBill connected before payment methods existed becomes the
  // first account. Its id is fixed so this is safe to run on every start.
  const legacyId = (businessId) => 'mpa-' + crypto.createHash('sha256').update('legacy:' + businessId).digest('hex').slice(0, 16);
  function syncLegacyAccount(businessId) {
    const row = legacyConnection.get(businessId);
    if (!row) return null;
    const id = legacyId(businessId);
    const values = { id, businessId, label: row.collection_name || null, shortcode: row.shortcode, transactionType: row.transaction_type,
      key: row.consumer_key_cipher, secret: row.consumer_secret_cipher, passkey: row.passkey_cipher, verifiedAt: row.last_verified_at || null };
    const existing = accountRow.get(id, businessId);
    if (!existing) insertAccount.run(values);
    else if (existing.consumer_key_cipher !== row.consumer_key_cipher || existing.passkey_cipher !== row.passkey_cipher || existing.shortcode !== row.shortcode) {
      // The older single-account form saved new credentials: carry them over.
      db.prepare(`UPDATE tenant_mpesa_accounts SET shortcode=?, transaction_type=?, active=1 WHERE id=?`).run(values.shortcode, values.transactionType, id);
      updateAccountSecrets.run(secretsOf(values));
    }
    return id;
  }
  for (const row of legacyConnections.all()) syncLegacyAccount(row.business_id);

  function accountView(row) {
    return { id: 'daraja:' + row.id, kind: 'daraja', accountId: row.id,
      label: row.label || `${TRANSACTION_TYPES[row.transaction_type] || 'M-Pesa'} ${row.shortcode}`,
      detail: `${TRANSACTION_TYPES[row.transaction_type] || 'M-Pesa'} ${row.shortcode}`,
      shortcode: row.shortcode, transactionType: row.transaction_type, verifiedAt: row.last_verified_at || null };
  }
  const fitiMethod = { id: 'fiti', kind: 'fiti', label: 'Wi-Fi Fiti collection', detail: 'Wi-Fi Fiti collects; your sales, less the fee, are paid out to you.' };
  const tumaMethod = { id: 'tuma', kind: 'tuma', label: 'Tuma settlement account', detail: 'Payments settle straight to your Tuma payout account.' };

  /** Every method this business can give a router. */
  function methodsFor(businessId) {
    const list = [fitiMethod, ...accountsFor.all(businessId).map(accountView)];
    if (tumaConnected(businessId)) list.push(tumaMethod);
    return list;
  }
  function parse(method) {
    const value = String(method || '').trim();
    if (value === 'fiti' || value === 'tuma') return { kind: value };
    const match = /^daraja:(mpa-[a-z0-9-]{4,64})$/.exec(value);
    return match ? { kind: 'daraja', accountId: match[1] } : null;
  }
  function usable(businessId, method) {
    const parsed = parse(method);
    if (!parsed) return null;
    if (parsed.kind === 'fiti') return fitiMethod;
    if (parsed.kind === 'tuma') return tumaConnected(businessId) ? tumaMethod : null;
    const row = activeAccount.get(parsed.accountId, businessId);
    return row ? accountView(row) : null;
  }
  // How payments were routed before payment methods existed.
  function legacyMethod(location) {
    const selected = paymentIntegrations.summary(location.business_id).selected;
    if (selected === 'tuma') return { ...tumaMethod, legacy: true };
    // Read it from the business: router rows from different queries differ.
    const mode = location.collection_mode !== undefined ? location.collection_mode : (collectionMode.get(location.business_id) || {}).collection_mode;
    if (mode === 'own') {
      const row = activeAccount.get(legacyId(location.business_id), location.business_id) || accountsFor.all(location.business_id)[0];
      return row ? { ...accountView(row), legacy: true } : { id: 'daraja:', kind: 'daraja', accountId: null, label: 'Your own Till / PayBill', detail: 'Not connected yet', legacy: true, missing: true };
    }
    return { ...fitiMethod, legacy: true };
  }

  function defaultFor(businessId) {
    const row = routingFor.get(businessId);
    return row && row.default_method ? row.default_method : null;
  }

  /** The method this router's customer payments use now, and why. */
  function resolve(location) {
    const own = routerChoice.get(location.id, location.business_id);
    if (own) { const method = usable(location.business_id, own.method); if (method) return { ...method, source: 'router' }; }
    const fallback = defaultFor(location.business_id);
    if (fallback) { const method = usable(location.business_id, fallback); if (method) return { ...method, source: 'default' }; }
    return { ...legacyMethod(location), source: 'legacy' };
  }

  /** Decrypted M-Pesa credentials for a daraja method (for a prompt). */
  function credentialsFor(businessId, accountId) {
    const row = accountId ? accountRow.get(accountId, businessId) : null;
    if (!row) return null;
    return {
      shortcode: row.shortcode, transactionType: row.transaction_type,
      consumerKey: tenant.decryptSecret(row.consumer_key_cipher),
      consumerSecret: tenant.decryptSecret(row.consumer_secret_cipher),
      passkey: tenant.decryptSecret(row.passkey_cipher),
    };
  }
  /** Credentials for checking a payment: the account it was taken with
   * (even if since removed), else the older single connection. */
  function credentialsForTransaction(transaction) {
    const parsed = parse(transaction.payment_method);
    if (parsed && parsed.kind === 'daraja') return credentialsFor(transaction.business_id, parsed.accountId);
    return tenant.paymentCredentials(transaction.business_id);
  }
  function recordTransactionMethod(checkoutRequestId, method) {
    if (method) setTransactionMethod.run(String(method).slice(0, 80), checkoutRequestId);
  }

  /** Add an own Till / PayBill. The caller verifies the credentials first. */
  function addAccount(businessId, { label, shortcode, transactionType, consumerKey, consumerSecret, passkey }) {
    if (!/^\d{5,12}$/.test(String(shortcode || '')) || !TRANSACTION_TYPES[transactionType]) throw fail('Enter a valid shortcode and choose PayBill or Till.');
    const existing = sameAccount.get(businessId, shortcode, transactionType);
    const values = { businessId, label: cleanLabel(label) || null, shortcode, transactionType,
      key: tenant.encryptSecret(consumerKey), secret: tenant.encryptSecret(consumerSecret), passkey: tenant.encryptSecret(passkey),
      verifiedAt: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') };
    // Adding the same Till / PayBill again replaces its credentials.
    if (existing) { updateAccountSecrets.run(secretsOf({ ...values, id: existing.id })); return accountView(accountRow.get(existing.id, businessId)); }
    const id = 'mpa-' + crypto.randomBytes(8).toString('hex');
    insertAccount.run({ ...values, id });
    return accountView(accountRow.get(id, businessId));
  }
  function renameMethod(businessId, method, label) {
    const parsed = parse(method);
    if (!parsed || parsed.kind !== 'daraja') throw fail('Only your own Till / PayBill accounts can be renamed.');
    const name = cleanLabel(label);
    if (!name) throw fail('Enter a name for this account.');
    if (!renameAccount.run(name, parsed.accountId, businessId).changes) throw fail('That account was not found.', 404);
    return usable(businessId, method);
  }
  /** Remove an own Till / PayBill. Routers that used it fall back to the
   * default; a default that pointed at it is cleared. */
  function removeMethod(businessId, method) {
    const parsed = parse(method);
    if (!parsed || parsed.kind !== 'daraja') throw fail('Only your own Till / PayBill accounts can be removed here.');
    if (!retireAccount.run(parsed.accountId, businessId).changes) throw fail('That account was not found.', 404);
    const affected = routersUsing.all(businessId, method).map((row) => row.location_id);
    db.prepare('DELETE FROM location_payment_methods WHERE business_id=? AND method=?').run(businessId, method);
    if (defaultFor(businessId) === method) saveRouting.run(businessId, null);
    // The older single-connection screen must not bring it back.
    if (parsed.accountId === legacyId(businessId)) db.prepare('DELETE FROM tenant_mpesa_connections WHERE business_id=?').run(businessId);
    return { routersMoved: affected.length };
  }
  function setDefault(businessId, method) {
    if (method == null || method === '') { saveRouting.run(businessId, null); return null; }
    if (!usable(businessId, method)) throw fail('Choose one of your payment methods.');
    saveRouting.run(businessId, method);
    return method;
  }
  function setRouterMethod(location, method) {
    if (method == null || method === '') { clearRouterChoice.run(location.id, location.business_id); return resolve(location); }
    if (!usable(location.business_id, method)) throw fail('Choose one of your payment methods.');
    saveRouterChoice.run(location.id, location.business_id, method);
    return resolve(location);
  }

  /** Everything the Payment methods page shows. */
  function overview(businessId, locations) {
    const defaultMethod = defaultFor(businessId);
    return {
      methods: methodsFor(businessId).map((method) => ({ ...method, isDefault: method.id === defaultMethod })),
      defaultMethod: defaultMethod && usable(businessId, defaultMethod) ? defaultMethod : null,
      routers: locations.map((location) => {
        const choice = routerChoice.get(location.id, businessId);
        const effective = resolve(location);
        return { locationId: location.id, name: location.name, chosen: choice ? choice.method : null,
          effective: { id: effective.id, kind: effective.kind, label: effective.label, source: effective.source, missing: Boolean(effective.missing) } };
      }),
    };
  }

  return { KINDS, methodsFor, resolve, credentialsFor, credentialsForTransaction, recordTransactionMethod,
    addAccount, renameMethod, removeMethod, setDefault, setRouterMethod, overview, syncLegacyAccount, parse, usable };
}

module.exports = { createPaymentMethods, TRANSACTION_TYPES };

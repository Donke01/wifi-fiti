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
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at  TEXT,
    acked_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(site, acked_at);
`);

const insert = db.prepare(`
  INSERT INTO transactions
    (checkout_request_id, merchant_request_id, phone, package_id,
     amount, seconds, mac, ip, status)
  VALUES
    (@checkoutRequestId, @merchantRequestId, @phone, @packageId,
     @amount, @seconds, @mac, @ip, 'pending')
`);

const get = db.prepare(
  `SELECT * FROM transactions WHERE checkout_request_id = ?`
);

const markResult = db.prepare(`
  UPDATE transactions
     SET status = @status,
         result_code = @resultCode,
         result_desc = @resultDesc,
         mpesa_receipt = COALESCE(@receipt, mpesa_receipt),
         updated_at = datetime('now')
   WHERE checkout_request_id = @checkoutRequestId
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

const addJob = db.prepare(`
  INSERT INTO jobs (site, username, password, profile, total_seconds, mac, ip)
  VALUES (@site, @username, @password, @profile, @totalSeconds, @mac, @ip)
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

module.exports = {
  db,
  insert,
  get,
  markResult,
  markProvisioned,
  stalePending,
  paidUnprovisioned,
  isDuplicateReceipt,
  getAccount,
  upsertAccount,
  addJob,
  pendingJobs,
  markDelivered,
  markAcked,
  purgeOldJobs,
};

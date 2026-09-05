const crypto = require('node:crypto');
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_browser_sessions (
    token_hash TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    mac TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_browser_subscription
    ON tenant_browser_sessions(subscription_id);
  CREATE TABLE IF NOT EXISTS request_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    resets_at INTEGER NOT NULL
  );
`);
const digest = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const save = db.prepare(`INSERT INTO tenant_browser_sessions
  (token_hash, location_id, subscription_id, mac, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+35 days'))`);
const lookup = db.prepare(`SELECT s.* FROM tenant_browser_sessions b
  JOIN tenant_subscriptions s ON s.id=b.subscription_id AND s.location_id=b.location_id AND s.mac=b.mac
  WHERE b.token_hash=? AND b.location_id=? AND b.expires_at>datetime('now')`);
const revoke = db.prepare(`DELETE FROM tenant_browser_sessions WHERE subscription_id=?`);
const consume = db.prepare(`INSERT INTO request_limits (key, count, resets_at) VALUES (?, 1, ?)
  ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN resets_at<=? THEN 1 ELSE count+1 END,
    resets_at=CASE WHEN resets_at<=? THEN excluded.resets_at ELSE resets_at END
  RETURNING count, resets_at`);

function issue(subscription) {
  const token = crypto.randomBytes(32).toString('base64url');
  save.run(digest(token), subscription.location_id, subscription.id, subscription.mac);
  return token;
}
function authenticate(locationId, token, mac) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const subscription = lookup.get(digest(token), locationId);
  return subscription && (!mac || subscription.mac === mac) ? subscription : null;
}
function allowed(key, maximum, windowMs) {
  const now = Date.now();
  const result = consume.get(digest(key), now + windowMs, now, now);
  return { allowed: result.count <= maximum, retryAfter: Math.max(1, Math.ceil((result.resets_at - now) / 1000)) };
}
function purge() {
  db.prepare(`DELETE FROM tenant_browser_sessions WHERE expires_at<=datetime('now')`).run();
  db.prepare(`DELETE FROM request_limits WHERE resets_at<?`).run(Date.now());
}
module.exports = { issue, authenticate, revoke, allowed, purge };

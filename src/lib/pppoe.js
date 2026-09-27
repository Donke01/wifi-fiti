'use strict';

/** Tenant-scoped PPPoE control plane. Router agents can consume its jobs later;
 * this module does not alter Hotspot, captive portal, or existing router kits. */
const crypto = require('node:crypto');
const { db } = require('./db');
const tenant = require('./tenant');

const key = () => process.env.TENANT_SECRETS_KEY ? crypto.createHash('sha256').update(process.env.TENANT_SECRETS_KEY).digest() : null;
function encrypt(value) {
  const k = key(); if (!k) throw new Error('Secure PPPoE secret storage is not configured.');
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function decrypt(value) {
  const k = key(); if (!k) throw new Error('Secure PPPoE secret storage is not configured.');
  const [iv, tag, body] = String(value || '').split('.'); if (!iv || !tag || !body) throw new Error('PPPoE secret is incomplete.');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const business = value => { const v = String(value || '').trim(); if (!/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw new Error('Invalid business ID.'); return v; };
// PPPoE must never borrow the captive-portal DHCP network. A deterministic
// private /24 per location keeps the router self-contained while avoiding the
// existing 10.5.50.0/24 hotspot subnet.
function pppoeSubnetForLocation(locationId) {
  const digest = crypto.createHash('sha256').update(String(locationId || '')).digest();
  const octet = 10 + (digest[0] % 200);
  return { network: `10.250.${octet}.0/24`, gateway: `10.250.${octet}.1`, pool: `10.250.${octet}.10-10.250.${octet}.250` };
}

db.exec(`
 CREATE TABLE IF NOT EXISTS pppoe_profiles (
   id TEXT PRIMARY KEY, business_id TEXT NOT NULL, name TEXT NOT NULL,
   download_rate TEXT NOT NULL, upload_rate TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
   max_sessions INTEGER NOT NULL DEFAULT 1, session_timeout_seconds INTEGER NOT NULL DEFAULT 0,
   idle_timeout_seconds INTEGER NOT NULL DEFAULT 900,
   created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
   UNIQUE(business_id,name)
 );
 CREATE TABLE IF NOT EXISTS pppoe_users (
   id TEXT PRIMARY KEY, business_id TEXT NOT NULL, location_id TEXT,
   profile_id TEXT NOT NULL, username TEXT NOT NULL, secret_ciphertext TEXT NOT NULL,
   service_name TEXT NOT NULL DEFAULT 'pppoe', status TEXT NOT NULL DEFAULT 'active',
   expires_at TEXT, max_sessions INTEGER NOT NULL DEFAULT 1,
   failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
   created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
   UNIQUE(business_id,username)
 );
 CREATE TABLE IF NOT EXISTS pppoe_jobs (
   id TEXT PRIMARY KEY, business_id TEXT NOT NULL, location_id TEXT,
   user_id TEXT NOT NULL, action TEXT NOT NULL, idempotency_key TEXT NOT NULL,
   attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
   next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT, acked_at TEXT,
   last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
   UNIQUE(business_id,idempotency_key)
 );
 CREATE INDEX IF NOT EXISTS idx_pppoe_jobs_due ON pppoe_jobs(status,next_attempt_at);
 CREATE TABLE IF NOT EXISTS pppoe_health (
   location_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown',
   active_sessions INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, details_json TEXT,
   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
 CREATE TABLE IF NOT EXISTS pppoe_audit (
   id INTEGER PRIMARY KEY AUTOINCREMENT, business_id TEXT NOT NULL, location_id TEXT,
   action TEXT NOT NULL, reference TEXT, details_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
 );
`);

// Add the hardening columns to databases created before PPPoE security was
// introduced. SQLite has no ADD COLUMN IF NOT EXISTS, so each migration is
// deliberately idempotent.
for (const statement of [
  `ALTER TABLE pppoe_profiles ADD COLUMN max_sessions INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE pppoe_profiles ADD COLUMN session_timeout_seconds INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pppoe_profiles ADD COLUMN idle_timeout_seconds INTEGER NOT NULL DEFAULT 900`,
  `ALTER TABLE pppoe_users ADD COLUMN expires_at TEXT`,
  `ALTER TABLE pppoe_users ADD COLUMN max_sessions INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE pppoe_users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pppoe_users ADD COLUMN locked_until TEXT`,
]) { try { db.exec(statement); } catch (_) {} }
db.exec(`CREATE TABLE IF NOT EXISTS pppoe_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, business_id TEXT NOT NULL, location_id TEXT,
  user_id TEXT, event TEXT NOT NULL, details_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
); CREATE INDEX IF NOT EXISTS idx_pppoe_security_events ON pppoe_security_events(business_id,created_at);`);

function profileCreate({ businessId, name, downloadRate, uploadRate, maxSessions = 1, sessionTimeoutSeconds = 0, idleTimeoutSeconds = 900 }) {
  const b = business(businessId); const n = String(name || '').trim();
  if (!n || n.length > 80) throw new Error('PPPoE profile name is required.');
  if (!String(downloadRate || '').trim() || !String(uploadRate || '').trim()) throw new Error('PPPoE rates are required.');
  // RouterOS's built-in PPP profile can enforce one active session reliably;
  // higher limits require RADIUS accounting and are intentionally rejected
  // rather than silently weakening isolation.
  const sessions = Number(maxSessions) || 1;
  if (sessions !== 1) throw new Error('This router mode supports one active PPPoE session per subscriber.');
  const sessionTimeout = Math.min(604800, Math.max(0, Number(sessionTimeoutSeconds) || 0));
  const idleTimeout = Math.min(86400, Math.max(60, Number(idleTimeoutSeconds) || 900));
  const row = db.prepare(`INSERT INTO pppoe_profiles(id,business_id,name,download_rate,upload_rate,max_sessions,session_timeout_seconds,idle_timeout_seconds) VALUES(?,?,?,?,?,?,?,?) RETURNING *`).get(id('pprof'), b, n, String(downloadRate).trim(), String(uploadRate).trim(), sessions, sessionTimeout, idleTimeout);
  db.prepare(`INSERT INTO pppoe_audit(business_id,action,reference,details_json) VALUES(?,?,?,?)`).run(b, 'profile_created', row.id, JSON.stringify({ name: n }));
  return row;
}
function profilesFor(businessId) { return db.prepare(`SELECT id,business_id,name,download_rate,upload_rate,active,max_sessions,session_timeout_seconds,idle_timeout_seconds,created_at,updated_at FROM pppoe_profiles WHERE business_id=? ORDER BY name`).all(business(businessId)); }
function userCreate({ businessId, locationId = null, profileId, username, secret, serviceName = 'pppoe', expiresAt = null, maxSessions = 1 }) {
  const b = business(businessId); const u = String(username || '').trim(); const s = String(secret || '');
  if (!/^[A-Za-z0-9._@-]{3,96}$/.test(u)) throw new Error('Invalid PPPoE username.');
  if (s.length < 8 || s.length > 128) throw new Error('PPPoE secret must be 8–128 characters.');
  const expires = expiresAt ? new Date(expiresAt) : null;
  if (expiresAt && (!expires || !Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())) throw new Error('Subscriber expiry must be a future date.');
  if (locationId) {
    const location = db.prepare('SELECT id FROM locations WHERE id=? AND business_id=?').get(locationId, b);
    if (!location) throw new Error('PPPoE location was not found for this business.');
  }
  const profile = db.prepare(`SELECT id FROM pppoe_profiles WHERE id=? AND business_id=? AND active=1`).get(profileId, b);
  if (!profile) throw new Error('PPPoE profile was not found.');
  const sessions = Number(maxSessions) || 1;
  if (sessions !== 1) throw new Error('This router mode supports one active PPPoE session per subscriber.');
  const row = db.prepare(`INSERT INTO pppoe_users(id,business_id,location_id,profile_id,username,secret_ciphertext,service_name,expires_at,max_sessions) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id,business_id,location_id,profile_id,username,service_name,status,expires_at,max_sessions,created_at,updated_at`).get(id('puser'), b, locationId, profileId, u, encrypt(s), String(serviceName).slice(0, 40) || 'pppoe', expires ? expires.toISOString() : null, sessions);
  db.prepare(`INSERT INTO pppoe_audit(business_id,location_id,action,reference,details_json) VALUES(?,?,?,?,?)`).run(b, locationId, 'user_created', row.id, JSON.stringify({ username: u }));
  return row;
}
function usersFor(businessId, locationId) { return db.prepare(`SELECT u.id,u.business_id,u.location_id,u.profile_id,u.username,u.service_name,u.status,u.expires_at,u.max_sessions,u.failed_attempts,u.locked_until,u.created_at,u.updated_at,
    j.action AS job_action, j.status AS job_status, j.last_error AS job_error, j.attempts AS job_attempts, j.updated_at AS job_updated_at
  FROM pppoe_users u LEFT JOIN pppoe_jobs j ON j.id=(SELECT id FROM pppoe_jobs WHERE user_id=u.id ORDER BY updated_at DESC, created_at DESC LIMIT 1)
  WHERE u.business_id=? AND (? IS NULL OR u.location_id=?) ORDER BY u.username`).all(business(businessId), locationId || null, locationId || null); }
/** Per router: can PPPoE run there yet, and what did the router last report. */
function routersFor(businessId) {
  const b = business(businessId);
  return db.prepare(`SELECT l.id, l.name, l.customer_bridge, h.status AS health_status, h.active_sessions, h.last_seen_at
    FROM locations l LEFT JOIN pppoe_health h ON h.location_id=l.id AND h.business_id=l.business_id
    WHERE l.business_id=? ORDER BY l.name`).all(b).map((row) => ({ id: row.id, name: row.name,
    ready: /^[A-Za-z0-9_-]{1,32}$/.test(String(row.customer_bridge || '')), customerBridge: row.customer_bridge || null,
    subnet: pppoeSubnetForLocation(row.id).network,
    health: row.last_seen_at ? { status: row.health_status, activeSessions: row.active_sessions, lastSeenAt: row.last_seen_at } : null }));
}
function revokeExpiredForLocation(locationId) {
  const rows = db.prepare(`SELECT u.*,p.business_id FROM pppoe_users u JOIN pppoe_profiles p ON p.id=u.profile_id WHERE u.location_id=? AND u.status='active' AND u.expires_at IS NOT NULL AND u.expires_at<=datetime('now')`).all(locationId);
  for (const row of rows) {
    db.prepare(`UPDATE pppoe_users SET status='expired',updated_at=datetime('now') WHERE id=? AND status='active'`).run(row.id);
    try { jobFor({ businessId: row.business_id, userId: row.id, action: 'revoke', locationId }); } catch (_) {}
    db.prepare(`INSERT INTO pppoe_security_events(business_id,location_id,user_id,event,details_json) VALUES(?,?,?,?,?)`).run(row.business_id, locationId, row.id, 'subscriber_expired', '{}');
  }
}
function setUserLock({ businessId, userId, minutes = 15 }) {
  const b = business(businessId); const user = db.prepare('SELECT * FROM pppoe_users WHERE id=? AND business_id=?').get(userId, b);
  if (!user) throw new Error('PPPoE user was not found.');
  const duration = Math.min(1440, Math.max(1, Number(minutes) || 15));
  const until = new Date(Date.now() + duration * 60_000).toISOString();
  db.prepare(`UPDATE pppoe_users SET locked_until=?,failed_attempts=failed_attempts+1,updated_at=datetime('now') WHERE id=?`).run(until, userId);
  db.prepare(`INSERT INTO pppoe_security_events(business_id,location_id,user_id,event,details_json) VALUES(?,?,?,?,?)`).run(b, user.location_id, userId, 'subscriber_locked', JSON.stringify({ minutes: duration }));
  if (user.location_id) jobFor({ businessId: b, userId, action: 'revoke', locationId: user.location_id });
  return { lockedUntil: until };
}
function clearUserLock({ businessId, userId }) {
  const b = business(businessId); const user = db.prepare('SELECT * FROM pppoe_users WHERE id=? AND business_id=?').get(userId, b);
  if (!user) throw new Error('PPPoE user was not found.');
  db.prepare(`UPDATE pppoe_users SET locked_until=NULL,failed_attempts=0,updated_at=datetime('now') WHERE id=?`).run(userId);
  db.prepare(`INSERT INTO pppoe_security_events(business_id,location_id,user_id,event,details_json) VALUES(?,?,?,?,?)`).run(b, user.location_id, userId, 'subscriber_unlocked', '{}');
  if (user.location_id) jobFor({ businessId: b, userId, action: 'upsert', locationId: user.location_id });
  return { unlocked: true };
}
function jobFor({ businessId, userId, action = 'upsert', locationId = null }) {
  const b = business(businessId); const user = db.prepare(`SELECT * FROM pppoe_users WHERE id=? AND business_id=?`).get(userId, b);
  if (!user) throw new Error('PPPoE user was not found.');
  const targetLocation = locationId || user.location_id;
  if (!targetLocation) throw new Error('A router location is required for PPPoE provisioning.');
  if (!db.prepare('SELECT id FROM locations WHERE id=? AND business_id=?').get(targetLocation, b)) throw new Error('PPPoE location was not found for this business.');
  const expired = user.expires_at && Date.parse(String(user.expires_at)) <= Date.now();
  const actionName = expired ? 'revoke' : String(action); if (!['upsert', 'revoke'].includes(actionName)) throw new Error('Invalid PPPoE action.');
  const idem = `${userId}:${actionName}`;
  const existing = db.prepare(`SELECT * FROM pppoe_jobs WHERE business_id=? AND idempotency_key=?`).get(b, idem);
  if (existing && ['queued', 'delivered'].includes(existing.status)) return existing;
  const row = db.prepare(`INSERT INTO pppoe_jobs(id,business_id,location_id,user_id,action,idempotency_key) VALUES(?,?,?,?,?,?)
    ON CONFLICT(business_id,idempotency_key) DO UPDATE SET status='queued',attempts=0,next_attempt_at=datetime('now'),last_error=NULL,updated_at=datetime('now') RETURNING *`)
    .get(id('pjob'), b, targetLocation, userId, actionName, idem);
  db.prepare(`INSERT INTO pppoe_audit(business_id,location_id,action,reference,details_json) VALUES(?,?,?,?,?)`).run(b, targetLocation, `job_${actionName}`, row.id, '{}');
  return row;
}
function claimJobs({ limit = 50 } = {}) { return db.prepare(`SELECT j.*,u.username,u.secret_ciphertext,u.profile_id,u.service_name,p.name profile_name,p.download_rate,p.upload_rate FROM pppoe_jobs j JOIN pppoe_users u ON u.id=j.user_id JOIN pppoe_profiles p ON p.id=u.profile_id WHERE j.status='queued' AND j.next_attempt_at<=datetime('now') ORDER BY j.created_at LIMIT ?`).all(Math.min(500, Math.max(1, Number(limit) || 50))).map(row => ({ ...row, secret: decrypt(row.secret_ciphertext), secret_ciphertext: undefined })); }
function markDelivered(jobId) { db.prepare(`UPDATE pppoe_jobs SET status='delivered',delivered_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='queued'`).run(jobId); }
function markAcked(jobId) { db.prepare(`UPDATE pppoe_jobs SET status='acked',acked_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('queued','delivered')`).run(jobId); }
function markFailed(jobId, error, retrySeconds = 30) { db.prepare(`UPDATE pppoe_jobs SET status='queued',attempts=attempts+1,last_error=?,next_attempt_at=datetime('now','+' || ? || ' seconds'),updated_at=datetime('now') WHERE id=?`).run(String(error || 'PPPoE job failed').slice(0, 500), Math.max(1, Number(retrySeconds) || 30), jobId); }
function recordHealth({ businessId, locationId, status, activeSessions = 0, details = {} }) { const b=business(businessId); db.prepare(`INSERT INTO pppoe_health(location_id,business_id,status,active_sessions,last_seen_at,details_json) VALUES(?,?,?,?,datetime('now'),?) ON CONFLICT(location_id) DO UPDATE SET status=excluded.status,active_sessions=excluded.active_sessions,last_seen_at=excluded.last_seen_at,details_json=excluded.details_json,updated_at=datetime('now')`).run(locationId,b,String(status||'unknown').slice(0,30),Math.max(0,Number(activeSessions)||0),JSON.stringify(details)); return healthFor(b, locationId); }
function healthFor(businessId, locationId) { return db.prepare(`SELECT * FROM pppoe_health WHERE business_id=? AND location_id=?`).get(business(businessId), locationId); }
function jobStatus(businessId, jobId) { return db.prepare(`SELECT id,business_id,location_id,user_id,action,attempts,status,next_attempt_at,delivered_at,acked_at,last_error,created_at,updated_at FROM pppoe_jobs WHERE id=? AND business_id=?`).get(jobId, business(businessId)); }
const MAX_JOB_ATTEMPTS = 5;
const HEALTH_INTERVAL_MS = 5 * 60_000;
const lastHealthAsk = new Map();
// RouterOS rate-limit is rx/tx seen from the router: rx is what the
// subscriber uploads, tx is what they download. So upload comes first.
function routerRate(downloadRate, uploadRate) { return `${String(uploadRate).trim()}/${String(downloadRate).trim()}`; }
function customerBridgeFor(locationId) {
  const location = db.prepare('SELECT customer_bridge FROM locations WHERE id=?').get(locationId) || {};
  const bridge = String(location.customer_bridge || '').trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(bridge) ? bridge : '';
}
function hasSubscribers(locationId) {
  return Boolean(db.prepare(`SELECT 1 FROM pppoe_users WHERE location_id=? LIMIT 1`).get(locationId));
}
/**
 * The PPPoE part of a router's poll reply. Every step is checked: a job is
 * reported back as done only when the router actually applied it, and as
 * failed (with a reason) otherwise, so it retries and the dashboard can say
 * why. Nothing is sent until the owner has confirmed the customer bridge,
 * because without it the router has nowhere to run the PPPoE server.
 */
function scriptForLocation(locationId, { now = Date.now() } = {}) {
  revokeExpiredForLocation(locationId);
  const bridgeName = customerBridgeFor(locationId);
  const subnet = pppoeSubnetForLocation(locationId);
  const octet = subnet.gateway.split('.')[2];
  const jobs = bridgeName ? db.prepare(`SELECT j.*,u.username,u.secret_ciphertext,u.profile_id,u.status user_status,p.name profile_name,p.download_rate,p.upload_rate
    ,u.expires_at user_expires_at,u.locked_until user_locked_until,u.max_sessions user_max_sessions,p.session_timeout_seconds,p.idle_timeout_seconds
    FROM pppoe_jobs j JOIN pppoe_users u ON u.id=j.user_id JOIN pppoe_profiles p ON p.id=u.profile_id
    WHERE j.location_id=? AND j.status IN ('queued','delivered') AND j.next_attempt_at<=datetime('now') ORDER BY j.created_at LIMIT 50`).all(locationId) : [];
  const wantHealth = bridgeName && hasSubscribers(locationId) && (jobs.length || now - (lastHealthAsk.get(locationId) || 0) >= HEALTH_INTERVAL_MS);
  if (!jobs.length && !wantHealth) return '';
  lastHealthAsk.set(locationId, now);
  const ros = value => `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\\$').replace(/[\r\n]/g, ' ')}"`;
  const bridge = ros(bridgeName);
  const lines = ['# Wi-Fi Fiti PPPoE automation', ':local fitiPppOk ""', ':local fitiPppFail ""', ':local fitiPppReason ""', ':local fitiPppInfra false'];
  const upserts = [];
  const ids = [];
  for (const job of jobs) {
    const expired = job.user_expires_at && Date.parse(String(job.user_expires_at)) <= now;
    const locked = job.user_locked_until && Date.parse(String(job.user_locked_until)) > now;
    const revoke = job.action === 'revoke' || job.user_status !== 'active' || expired || locked;
    let secret = '';
    if (!revoke) { try { secret = decrypt(job.secret_ciphertext); } catch (_) {} }
    if (!revoke && !secret) { markFailed(job.id, 'secret_unreadable', 300); continue; }
    ids.push(job.id);
    const user = ros(job.username); const profile = ros(`fiti-${job.profile_id}`);
    const ok = `:set fitiPppOk ($fitiPppOk . "${job.id},")`; const fail = `:set fitiPppFail ($fitiPppFail . "${job.id},")`;
    if (revoke) {
      // Disabling the secret stops new logins; removing the active session
      // cuts a subscriber who is still connected.
      lines.push(`:do { :if ([:len [/ppp secret find where name=${user}]] > 0) do={ /ppp secret set [find where name=${user}] disabled=yes }; :foreach fitiPppActive in=[/ppp active find where name=${user}] do={ /ppp active remove $fitiPppActive }; ${ok} } on-error={ ${fail} }`);
      continue;
    }
    const sessionTimeout = Math.min(604800, Math.max(0, Number(job.session_timeout_seconds) || 0));
    const idleTimeout = Math.min(86400, Math.max(60, Number(job.idle_timeout_seconds) || 900));
    const profileArgs = `rate-limit=${ros(routerRate(job.download_rate, job.upload_rate))} local-address="${subnet.gateway}" remote-address="fiti-pppoe-pool" dns-server=1.1.1.1,8.8.8.8 only-one=yes idle-timeout=${idleTimeout}s${sessionTimeout ? ` session-timeout=${sessionTimeout}s` : ''}`;
    upserts.push({ profile, line: `:if ($fitiPppInfra) do={ :do { :if ([:len [/ppp profile find where name=${profile}]] > 0) do={ /ppp profile set [find where name=${profile}] ${profileArgs} } else={ /ppp profile add name=${profile} ${profileArgs} comment="Wi-Fi Fiti PPPoE" }; :if ([:len [/ppp secret find where name=${user}]] > 0) do={ /ppp secret set [find where name=${user}] password=${ros(secret)} service=pppoe profile=${profile} disabled=no } else={ /ppp secret add name=${user} password=${ros(secret)} service=pppoe profile=${profile} disabled=no comment="Wi-Fi Fiti PPPoE" }; ${ok} } on-error={ ${fail} } } else={ ${fail} }` });
  }
  if (upserts.length) {
    // Router-wide setup the subscribers depend on. It runs once per batch and
    // is idempotent. If it fails, every subscriber in the batch is reported
    // failed with the reason rather than silently acknowledged.
    const defaultProfile = upserts[0].profile;
    lines.push([
      ':do {',
      `  :if ([:len [/interface bridge find where name=${bridge}]] != 1) do={ :set fitiPppReason "bridge_missing"; :error "bridge" }`,
      `  :if ([:len [/ip address find where address~"^10\\\\.250\\\\.${octet}\\\\."]] > 0) do={ :set fitiPppReason "subnet_clash"; :error "subnet" }`,
      '  :set fitiPppReason "setup_failed"',
      `  :if ([:len [/ip pool find where name="fiti-pppoe-pool"]] > 0) do={ /ip pool set [find where name="fiti-pppoe-pool"] ranges="${subnet.pool}" } else={ /ip pool add name="fiti-pppoe-pool" ranges="${subnet.pool}" comment="Wi-Fi Fiti PPPoE isolated subnet" }`,
      `  :if ([:len [/ip firewall filter find where comment="Wi-Fi Fiti PPPoE isolation"]] = 0) do={ /ip firewall filter add chain=forward action=drop src-address="${subnet.network}" dst-address="10.5.50.0/24" comment="Wi-Fi Fiti PPPoE isolation"; /ip firewall filter add chain=forward action=drop src-address="10.5.50.0/24" dst-address="${subnet.network}" comment="Wi-Fi Fiti PPPoE isolation" }`,
      `  :if ([:len [/ip firewall filter find where comment="Wi-Fi Fiti PPPoE DNS"]] = 0) do={ /ip firewall filter add chain=input action=accept src-address="${subnet.network}" protocol=udp dst-port=53 comment="Wi-Fi Fiti PPPoE DNS"; /ip firewall filter add chain=input action=accept src-address="${subnet.network}" protocol=tcp dst-port=53 comment="Wi-Fi Fiti PPPoE DNS" }`,
      // The default profile must exist before the server can point at it.
      `  :if ([:len [/ppp profile find where name=${defaultProfile}]] = 0) do={ /ppp profile add name=${defaultProfile} local-address="${subnet.gateway}" remote-address="fiti-pppoe-pool" only-one=yes comment="Wi-Fi Fiti PPPoE" }`,
      '  /ppp aaa set use-radius=no',
      // Follow the confirmed bridge if the owner changes it later.
      `  :if ([:len [/interface pppoe-server server find where comment="Wi-Fi Fiti PPPoE"]] > 0) do={ /interface pppoe-server server set [find where comment="Wi-Fi Fiti PPPoE"] service-name="pppoe" interface=${bridge} default-profile=${defaultProfile} authentication=pap,chap,mschap1,mschap2 disabled=no } else={ /interface pppoe-server server add service-name="pppoe" interface=${bridge} default-profile=${defaultProfile} authentication=pap,chap,mschap1,mschap2 disabled=no comment="Wi-Fi Fiti PPPoE" }`,
      '  :set fitiPppReason ""',
      '  :set fitiPppInfra true',
      '} on-error={ :if ([:len $fitiPppReason] = 0) do={ :set fitiPppReason "setup_failed" } }',
    ].join('\n'));
    for (const upsert of upserts) lines.push(upsert.line);
  }
  for (const idValue of ids) db.prepare("UPDATE pppoe_jobs SET status='delivered',delivered_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='queued'").run(idValue);
  // One report back: which jobs applied, which failed and why, and how the
  // PPPoE server is doing (live sessions, server enabled).
  lines.push(`:do { :global fitiUrl; :global fitiToken; :local fitiPppActiveCount 0; :do { :set fitiPppActiveCount [/ppp active print count-only where service=pppoe] } on-error={}; :local fitiPppServer "off"; :if ([:len [/interface pppoe-server server find where comment="Wi-Fi Fiti PPPoE" and disabled=no]] > 0) do={ :set fitiPppServer "on" }; /tool fetch url=($fitiUrl . "/api/router/pppoe/jobs?site=${locationId}&ack=" . $fitiPppOk . "&fail=" . $fitiPppFail . "&reason=" . $fitiPppReason . "&active=" . $fitiPppActiveCount . "&server=" . $fitiPppServer) http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=none } on-error={}`);
  return lines.join('\n');
}

const FAILURE_REASONS = new Set(['bridge_missing', 'subnet_clash', 'setup_failed', 'router_rejected', 'secret_unreadable']);
/** Apply a router's PPPoE report: acknowledgements, failures and health. */
function applyRouterReport(location, query = {}) {
  const list = (value) => String(value || '').split(',').map((v) => v.trim()).filter((v) => /^pjob_[a-f0-9]{24}$/.test(v)).slice(0, 50);
  const reason = FAILURE_REASONS.has(String(query.reason || '')) ? String(query.reason) : 'router_rejected';
  for (const idValue of list(query.ack)) {
    db.prepare(`UPDATE pppoe_jobs SET status='acked',acked_at=datetime('now'),last_error=NULL,updated_at=datetime('now') WHERE id=? AND location_id=? AND status IN ('queued','delivered')`).run(idValue, location.id);
  }
  for (const idValue of list(query.fail)) {
    const job = db.prepare(`SELECT attempts FROM pppoe_jobs WHERE id=? AND location_id=? AND status IN ('queued','delivered')`).get(idValue, location.id);
    if (!job) continue;
    const attempts = Number(job.attempts) + 1;
    // Back off, and stop after a few tries so a broken router isn't hammered.
    db.prepare(`UPDATE pppoe_jobs SET status=?,attempts=?,last_error=?,next_attempt_at=datetime('now','+' || ? || ' seconds'),updated_at=datetime('now') WHERE id=?`)
      .run(attempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'queued', attempts, reason, Math.min(3600, 60 * attempts), idValue);
  }
  if (query.server === 'on' || query.server === 'off') {
    recordHealth({ businessId: location.business_id, locationId: location.id, status: query.server === 'on' ? 'online' : 'server_off',
      activeSessions: Math.max(0, Math.floor(Number(query.active) || 0)), details: { server: query.server } });
  }
}

// One-time: speeds used to be sent download/upload, which RouterOS reads the
// wrong way round. Re-send every active subscriber once so each router's
// profiles are rewritten upload/download. Runs on the first start after deploy.
function resendForRateOrderFix() {
  db.exec(`CREATE TABLE IF NOT EXISTS pppoe_migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  if (db.prepare(`SELECT 1 FROM pppoe_migrations WHERE name='rate_order_v2'`).get()) return 0;
  const rows = db.prepare(`SELECT id,business_id FROM pppoe_users WHERE status='active' AND location_id IS NOT NULL
    AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`).all();
  let queued = 0;
  for (const row of rows) { try { jobFor({ businessId: row.business_id, userId: row.id, action: 'upsert' }); queued += 1; } catch (_) { /* location gone */ } }
  db.prepare(`INSERT INTO pppoe_migrations (name) VALUES ('rate_order_v2')`).run();
  if (queued) console.log(`[pppoe] re-sending ${queued} subscriber(s) with corrected upload/download order`);
  return queued;
}
resendForRateOrderFix();

function activeUserCount(businessId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM pppoe_users WHERE business_id=? AND status='active'
    AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`).get(businessId).n;
}

function attachPppoeRoutes(app, { businessAuth, subscriptionBlock = null }) {
  const operator = handler => (req, res) => {
    const current = businessAuth(req, res); if (!current) return;
    try { return handler(req, res, current.id || current.business_id, current); } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  };
  // Prepaid PPPoE: adding or re-provisioning a subscriber needs an active
  // (or grace-period) subscription with room for one more active user.
  const guard = (current, adding) => {
    if (!subscriptionBlock) return;
    const blocked = subscriptionBlock(current, { activeUsers: activeUserCount(current.id || current.business_id), adding });
    if (blocked) throw Object.assign(new Error(blocked), { status: 402 });
  };
  app.get('/api/business/pppoe', operator((req, res, b) => res.json({ profiles: profilesFor(b), users: usersFor(b, req.query.locationId || null), routers: routersFor(b) })));
  app.post('/api/business/pppoe/profiles', operator((req, res, b) => res.status(201).json({ profile: profileCreate({ businessId: b, name: req.body?.name, downloadRate: req.body?.downloadRate, uploadRate: req.body?.uploadRate, maxSessions: req.body?.maxSessions, sessionTimeoutSeconds: req.body?.sessionTimeoutSeconds, idleTimeoutSeconds: req.body?.idleTimeoutSeconds }) })));
  app.post('/api/business/pppoe/users', operator((req, res, b, current) => guard(current, true) || res.status(201).json({ user: userCreate({ businessId: b, locationId: req.body?.locationId, profileId: req.body?.profileId, username: req.body?.username, secret: req.body?.secret, serviceName: req.body?.serviceName, expiresAt: req.body?.expiresAt, maxSessions: req.body?.maxSessions }) })));
  app.post('/api/business/pppoe/users/:userId/provision', operator((req, res, b, current) => guard(current, false) || res.status(202).json({ job: jobFor({ businessId: b, userId: req.params.userId, action: req.body?.action || 'upsert', locationId: req.body?.locationId }) })));
  app.post('/api/business/pppoe/users/:userId/lock', operator((req, res, b) => res.json(setUserLock({ businessId: b, userId: req.params.userId, minutes: req.body?.minutes }))));
  app.post('/api/business/pppoe/users/:userId/unlock', operator((req, res, b) => res.json(clearUserLock({ businessId: b, userId: req.params.userId }))));
  app.get('/api/business/pppoe/jobs/:jobId', operator((req, res, b) => { const job = jobStatus(b, req.params.jobId); if (!job) return res.status(404).json({ error: 'PPPoE job was not found.' }); res.json({ job }); }));
  app.get('/api/business/pppoe/health/:locationId', operator((req, res, b) => res.json({ health: healthFor(b, req.params.locationId) })));

  // RouterOS-side pull protocol. A router receives only its own queued jobs;
  // credentials are decrypted in memory and never returned by tenant APIs.
  const routerLocation = (req, res) => {
    const token = String(req.get('X-WiFi-Fiti-Router') || '').trim();
    const site = String(req.query.site || '').trim();
    const row = tenant.authenticateRouter(site, token, 'header');
    if (!row || row.router_pairing_auth !== 'active' || !row.router_setup_verified_at) { res.status(403).type('text/plain').send('# PPPoE router authentication failed\n'); return null; }
    return row;
  };
  const ros = value => `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
  app.get('/api/router/pppoe/jobs', (req, res) => {
    const location = routerLocation(req, res); if (!location) return;
    applyRouterReport(location, req.query);
    // ACK fetches are deliberately side-effect-only. The regular fiti-poll
    // response is the only channel that emits executable PPPoE work; returning
    // a second script here would mark it delivered while RouterOS discards it
    // because this fetch uses output=none.
    res.type('text/plain').send('# Wi-Fi Fiti PPPoE acknowledgement accepted\n');
  });
}

module.exports = { routersFor, routerRate, applyRouterReport, pppoeSubnetForLocation, encrypt, decrypt, profileCreate, profilesFor, userCreate, usersFor, jobFor, setUserLock, clearUserLock, claimJobs, markDelivered, markAcked, markFailed, recordHealth, healthFor, jobStatus, scriptForLocation, attachPppoeRoutes };

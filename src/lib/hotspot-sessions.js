'use strict';

/*
 * Who is online right now, and each customer's session history.
 *
 * Every 30 seconds (10 while the owner watches) the ordinary check-in reply carries a short, read-only
 * RouterOS block (telemetryReplyScript). The router runs it inside the same
 * check-in job (still one check-in at a time), reads its own load and the
 * hotspot's active list, and posts one small report to /api/router/telemetry
 * with the X-WiFi-Fiti-Router header. The block is built fresh on the server
 * for every reply, so every paired router always runs the current version:
 * nothing is stored on the router and no kit needs pasting again.
 *
 * Report grammar (one item per line, nothing secret):
 *   fiti-telemetry-v1
 *   res|<cpu%>|<free mem>|<total mem>|<uptime s>|<bridge rx>|<bridge tx>|<active count>
 *   sess|<router user>|<mac>|<ip>|<session uptime s>|<bytes in>|<bytes out>|<idle s>
 * "bytes in" is what the customer sent (upload), "bytes out" what they
 * received (download), as RouterOS counts them on the hotspot.
 */

const { db } = require('./db');

// A router that has not reported within this window is "not reporting":
// its customers show as unknown and its online count falls back to the
// older rule (packages with time left), which never oversells.
const FRESH_SECONDS = 90;
// Sessions that stopped being reported (router went quiet) are closed at
// their last report after this long.
const STALE_SESSION_MINUTES = 10;
const MAX_SESSIONS = 150;
const SESSION_HISTORY_DAYS = 90;
const TELEMETRY_HISTORY_DAYS = 30;

db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_hotspot_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id      TEXT NOT NULL,
    location_id      TEXT NOT NULL,
    subscription_id  TEXT,
    router_username  TEXT NOT NULL,
    mac              TEXT,
    ip               TEXT,
    started_at       TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL,
    ended_at         TEXT,
    uptime_seconds   INTEGER NOT NULL DEFAULT 0,
    idle_seconds     INTEGER,
    bytes_in         INTEGER NOT NULL DEFAULT 0,
    bytes_out        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_hotspot_sessions_open
    ON tenant_hotspot_sessions(location_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_hotspot_sessions_subscription
    ON tenant_hotspot_sessions(subscription_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hotspot_sessions_business_open
    ON tenant_hotspot_sessions(business_id, ended_at, last_seen_at);

  CREATE TABLE IF NOT EXISTS tenant_session_reports (
    location_id   TEXT PRIMARY KEY,
    reported_at   TEXT NOT NULL,
    active_count  INTEGER NOT NULL DEFAULT 0,
    listed_count  INTEGER NOT NULL DEFAULT 0
  );
`);

const USERNAME = /^254[17]\d{8}(?:-[0-9A-F]{8})?(?:-tv)?$/;
const MAC = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

function count(value, max = 9e15) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return number <= max ? Math.round(number) : null;
}

function ipv4(value) {
  const text = String(value || '').trim();
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return null;
  return text.split('.').every((part) => Number(part) <= 255) ? text : null;
}

/** Parse a router report; null when it is not a telemetry report at all. */
function parseReport(raw) {
  const lines = String(typeof raw === 'string' ? raw : '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== 'fiti-telemetry-v1') return null;
  const report = { resources: null, sessions: [], activeCount: null, listed: 0 };
  for (const line of lines.slice(1)) {
    const parts = line.split('|');
    if (parts[0] === 'res' && !report.resources) {
      report.resources = {
        cpuPercent: parts[1], freeMemory: parts[2], totalMemory: parts[3], uptimeSeconds: parts[4],
        rxBytes: parts[5], txBytes: parts[6],
      };
      report.activeCount = count(parts[7], 100000);
    } else if (parts[0] === 'sess' && report.listed < MAX_SESSIONS) {
      report.listed += 1;
      // Only Wi-Fi Fiti customers; the owner's own hotspot logins are skipped.
      const username = String(parts[1] || '').trim();
      if (!USERNAME.test(username)) continue;
      const mac = String(parts[2] || '').trim().toUpperCase();
      report.sessions.push({
        username,
        mac: MAC.test(mac) ? mac : null,
        ip: ipv4(parts[3]),
        uptime: count(parts[4], 1e9) || 0,
        bytesIn: count(parts[5]) || 0,
        bytesOut: count(parts[6]) || 0,
        idle: count(parts[7], 1e9),
      });
    }
  }
  // A report whose list was cut short (more logins than MAX_SESSIONS)
  // cannot say who left, so nobody is marked offline from it.
  report.complete = report.activeCount == null || report.listed >= report.activeCount;
  // Customers online for the limit: those listed, or the router's own total
  // when the list was cut short.
  report.customersOnline = report.complete ? report.sessions.length : Math.max(report.sessions.length, report.activeCount);
  return report;
}

/* ---- Storage ---------------------------------------------------------- */

const subscriptionForUser = db.prepare(`SELECT id, business_id FROM tenant_subscriptions WHERE location_id=? AND router_username=?`);
const openSession = db.prepare(`SELECT * FROM tenant_hotspot_sessions
  WHERE location_id=? AND router_username=? AND COALESCE(mac,'')=COALESCE(?,'') AND ended_at IS NULL
  ORDER BY id DESC LIMIT 1`);
const updateSession = db.prepare(`UPDATE tenant_hotspot_sessions SET last_seen_at=datetime('now'), uptime_seconds=@uptime,
  idle_seconds=@idle, bytes_in=@bytesIn, bytes_out=@bytesOut, ip=COALESCE(@ip, ip), subscription_id=COALESCE(subscription_id, @subscriptionId)
  WHERE id=@id`);
const insertSession = db.prepare(`INSERT INTO tenant_hotspot_sessions
  (business_id, location_id, subscription_id, router_username, mac, ip, started_at, last_seen_at, uptime_seconds, idle_seconds, bytes_in, bytes_out)
  VALUES (@businessId, @locationId, @subscriptionId, @username, @mac, @ip, datetime('now', '-' || @uptime || ' seconds'), datetime('now'),
    @uptime, @idle, @bytesIn, @bytesOut)`);
const closeSession = db.prepare(`UPDATE tenant_hotspot_sessions SET ended_at=last_seen_at WHERE id=? AND ended_at IS NULL`);
const openSessionIds = db.prepare(`SELECT id FROM tenant_hotspot_sessions WHERE location_id=? AND ended_at IS NULL`);
const saveReport = db.prepare(`INSERT INTO tenant_session_reports (location_id, reported_at, active_count, listed_count)
  VALUES (?, datetime('now'), ?, ?)
  ON CONFLICT(location_id) DO UPDATE SET reported_at=excluded.reported_at, active_count=excluded.active_count, listed_count=excluded.listed_count`);
const closeStale = db.prepare(`UPDATE tenant_hotspot_sessions SET ended_at=last_seen_at
  WHERE ended_at IS NULL AND last_seen_at < datetime('now', '-${STALE_SESSION_MINUTES} minutes')`);
const pruneSessions = db.prepare(`DELETE FROM tenant_hotspot_sessions WHERE ended_at IS NOT NULL AND ended_at < datetime('now', '-${SESSION_HISTORY_DAYS} days')`);

function subscriptionFor(locationId, username) {
  return subscriptionForUser.get(locationId, username)
    || (username.endsWith('-tv') ? subscriptionForUser.get(locationId, username.slice(0, -3)) : null)
    || null;
}

/** Store one report: open, update and close sessions for this location. */
function recordReport(location, report) {
  if (!location || !report) return { opened: 0, updated: 0, closed: 0 };
  const result = { opened: 0, updated: 0, closed: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const seen = new Set();
    for (const session of report.sessions) {
      const subscription = subscriptionFor(location.id, session.username);
      const values = { uptime: session.uptime, idle: session.idle, bytesIn: session.bytesIn, bytesOut: session.bytesOut,
        ip: session.ip, subscriptionId: subscription ? subscription.id : null };
      const open = openSession.get(location.id, session.username, session.mac);
      if (open && seen.has(open.id)) continue;
      // The same session keeps counting up. A smaller uptime means the
      // customer left and came back between two reports: a new session.
      if (open && session.uptime >= Number(open.uptime_seconds || 0)) {
        updateSession.run({ ...values, id: open.id });
        seen.add(open.id);
        result.updated += 1;
        continue;
      }
      if (open) { closeSession.run(open.id); result.closed += 1; }
      const inserted = insertSession.run({ ...values, username: session.username, mac: session.mac,
        businessId: location.business_id, locationId: location.id });
      seen.add(Number(inserted.lastInsertRowid));
      result.opened += 1;
    }
    if (report.complete) {
      for (const { id } of openSessionIds.all(location.id)) {
        if (!seen.has(id)) { closeSession.run(id); result.closed += 1; }
      }
    }
    saveReport.run(location.id, report.customersOnline, report.sessions.length);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return result;
}

/** Close sessions whose router went quiet, and trim old history. */
function sweep() {
  const closed = closeStale.run().changes;
  pruneSessions.run();
  // tenant.js owns the telemetry table; it exists whenever the server runs.
  try { db.prepare(`DELETE FROM tenant_router_telemetry WHERE recorded_at < datetime('now', '-${TELEMETRY_HISTORY_DAYS} days')`).run(); } catch (_) { /* not created yet */ }
  return closed;
}

/* ---- Reading ---------------------------------------------------------- */

const freshSql = `datetime('now', '-${FRESH_SECONDS} seconds')`;
const reportFor = db.prepare(`SELECT reported_at, active_count, listed_count,
  CASE WHEN reported_at >= ${freshSql} THEN 1 ELSE 0 END AS fresh FROM tenant_session_reports WHERE location_id=?`);
const secondsLeft = `CASE WHEN s.expires_at>datetime('now') THEN CAST(ROUND((julianday(s.expires_at)-julianday('now'))*86400) AS INTEGER) ELSE 0 END`;
const packageName = `(SELECT t.package_name FROM tenant_transactions t WHERE t.business_id=s.business_id AND t.subscription_id=s.id
  ORDER BY t.created_at DESC LIMIT 1)`;
const onlineRows = db.prepare(`SELECT h.id AS session_id, h.router_username, h.mac, h.ip, h.started_at, h.last_seen_at,
    h.uptime_seconds, h.idle_seconds, h.bytes_in, h.bytes_out, h.subscription_id,
    s.payer_phone, s.expires_at, s.total_seconds, s.used_seconds, s.rate_limit, ${secondsLeft} AS seconds_left, ${packageName} AS package_name
  FROM tenant_hotspot_sessions h
  LEFT JOIN tenant_subscriptions s ON s.id=h.subscription_id AND s.location_id=h.location_id
  WHERE h.location_id=? AND h.ended_at IS NULL AND h.last_seen_at >= ${freshSql}
  ORDER BY h.started_at ASC LIMIT ${MAX_SESSIONS}`);
const offlineRows = db.prepare(`SELECT s.id AS subscription_id, s.router_username, s.mac, s.payer_phone, s.expires_at, s.total_seconds,
    s.used_seconds, s.rate_limit, ${secondsLeft} AS seconds_left, ${packageName} AS package_name,
    (SELECT MAX(h.last_seen_at) FROM tenant_hotspot_sessions h WHERE h.subscription_id=s.id) AS last_seen_at
  FROM tenant_subscriptions s
  WHERE s.location_id=? AND s.expires_at>datetime('now')
    AND s.mac NOT LIKE 'RELEASED:%' AND s.mac NOT LIKE 'CLAIM:%' AND s.mac NOT LIKE 'C2B:%'
  ORDER BY s.expires_at DESC LIMIT 300`);

/**
 * The owner's "Active users" view for one router. `online` are customers the
 * router reported in its last few minutes; `offline` are customers with time
 * left who are not connected now.
 */
function onlineForLocation(locationId) {
  const report = reportFor.get(locationId) || null;
  const fresh = Boolean(report && report.fresh);
  const online = fresh ? onlineRows.all(locationId) : [];
  const onlineSubscriptions = new Set(online.map((row) => row.subscription_id).filter(Boolean));
  const offline = offlineRows.all(locationId).filter((row) => !onlineSubscriptions.has(row.subscription_id));
  return {
    reportedAt: report ? report.reported_at : null,
    reporting: fresh,
    activeCount: fresh ? Math.max(Number(report.active_count || 0), online.length) : null,
    online,
    offline,
  };
}

const sessionHistory = db.prepare(`SELECT id, mac, ip, started_at, last_seen_at, ended_at, uptime_seconds, idle_seconds, bytes_in, bytes_out,
    CASE WHEN ended_at IS NULL AND last_seen_at >= ${freshSql} THEN 1 ELSE 0 END AS online
  FROM tenant_hotspot_sessions WHERE subscription_id=? AND business_id=? ORDER BY started_at DESC LIMIT ?`);
const sessionTotals = db.prepare(`SELECT COUNT(*) AS sessions, COALESCE(SUM(uptime_seconds),0) AS seconds,
    COALESCE(SUM(bytes_in),0) AS bytes_in, COALESCE(SUM(bytes_out),0) AS bytes_out, MIN(started_at) AS first_seen_at, MAX(last_seen_at) AS last_seen_at
  FROM tenant_hotspot_sessions WHERE subscription_id=? AND business_id=?`);

/** One customer's sessions, newest first, with totals. */
function historyForSubscription(subscriptionId, businessId, limit = 50) {
  const sessions = sessionHistory.all(subscriptionId, businessId, Math.max(1, Math.min(200, Number(limit) || 50)));
  const totals = sessionTotals.get(subscriptionId, businessId);
  return { online: sessions.some((row) => row.online === 1), sessions, totals };
}

/*
 * Customers online right now across a business, for the concurrent-user
 * limit. A router that reported within FRESH_SECONDS counts the sessions it
 * listed. A router that is not reporting (an older setup, or just offline)
 * counts the older way, every package with time left, so a sale is never
 * allowed on a guess.
 */
const locationsWithReports = db.prepare(`SELECT l.id, CASE WHEN r.reported_at >= ${freshSql} THEN 1 ELSE 0 END AS fresh,
    COALESCE(r.active_count, 0) AS active_count
  FROM locations l LEFT JOIN tenant_session_reports r ON r.location_id=l.id WHERE l.business_id=?`);
const openFreshAtLocation = db.prepare(`SELECT COUNT(*) AS n FROM tenant_hotspot_sessions
  WHERE location_id=? AND ended_at IS NULL AND last_seen_at >= ${freshSql}`);
const timeLeftAtLocation = db.prepare(`SELECT COUNT(*) AS n FROM tenant_subscriptions WHERE location_id=? AND expires_at>datetime('now')`);

function onlineCountForBusiness(businessId) {
  let total = 0;
  for (const location of locationsWithReports.all(businessId)) {
    total += location.fresh
      ? Math.max(Number(location.active_count || 0), openFreshAtLocation.get(location.id).n)
      : timeLeftAtLocation.get(location.id).n;
  }
  return total;
}

/* ---- The router side -------------------------------------------------- */

/*
 * The block the check-in reply carries. It only reads: system resource, the
 * customer bridge's counters and the hotspot's active list, then posts them.
 * It reuses the TLS setting the router's own fiti-poll uses, so a
 * compatibility kit (check-certificate=no) and a normal kit both work.
 */
function telemetryReplyScript() {
  return [
    ':do {',
    '  :global fitiUrl',
    '  :global fitiSite',
    '  :global fitiToken',
    '  :global fitiBridge',
    '  :local fitiTmOut "fiti-telemetry-v1\\n"',
    '  :local fitiTmCpu ""',
    '  :local fitiTmFree ""',
    '  :local fitiTmTotal ""',
    '  :local fitiTmUp ""',
    '  :local fitiTmRx ""',
    '  :local fitiTmTx ""',
    '  :do { :set fitiTmCpu [/system resource get cpu-load] } on-error={}',
    '  :do { :set fitiTmFree [/system resource get free-memory] } on-error={}',
    '  :do { :set fitiTmTotal [/system resource get total-memory] } on-error={}',
    '  :do { :set fitiTmUp [:tonum [/system resource get uptime]] } on-error={}',
    '  :do { :set fitiTmRx [/interface get [find where name=$fitiBridge] rx-byte] } on-error={}',
    '  :do { :set fitiTmTx [/interface get [find where name=$fitiBridge] tx-byte] } on-error={}',
    '  :local fitiTmActive ""',
    '  :do { :set fitiTmActive [/ip hotspot active find] } on-error={}',
    '  :set fitiTmOut ($fitiTmOut . "res|" . $fitiTmCpu . "|" . $fitiTmFree . "|" . $fitiTmTotal . "|" . $fitiTmUp . "|" . $fitiTmRx . "|" . $fitiTmTx . "|" . [:len $fitiTmActive] . "\\n")',
    '  :local fitiTmN 0',
    '  :foreach fitiTmA in=$fitiTmActive do={',
    `    :if ($fitiTmN < ${MAX_SESSIONS}) do={`,
    '      :do {',
    '        :local fitiTmU [/ip hotspot active get $fitiTmA user]',
    '        :local fitiTmM ""',
    '        :local fitiTmI ""',
    '        :local fitiTmS 0',
    '        :local fitiTmBi 0',
    '        :local fitiTmBo 0',
    '        :local fitiTmIdle ""',
    '        :do { :set fitiTmM [/ip hotspot active get $fitiTmA mac-address] } on-error={}',
    '        :do { :set fitiTmI [/ip hotspot active get $fitiTmA address] } on-error={}',
    '        :do { :set fitiTmS [:tonum [/ip hotspot active get $fitiTmA uptime]] } on-error={}',
    '        :do { :set fitiTmBi [/ip hotspot active get $fitiTmA bytes-in] } on-error={}',
    '        :do { :set fitiTmBo [/ip hotspot active get $fitiTmA bytes-out] } on-error={}',
    '        :do { :set fitiTmIdle [:tonum [/ip hotspot active get $fitiTmA idle-time]] } on-error={}',
    '        :set fitiTmOut ($fitiTmOut . "sess|" . $fitiTmU . "|" . $fitiTmM . "|" . $fitiTmI . "|" . $fitiTmS . "|" . $fitiTmBi . "|" . $fitiTmBo . "|" . $fitiTmIdle . "\\n")',
    '        :set fitiTmN ($fitiTmN + 1)',
    '      } on-error={}',
    '    }',
    '  }',
    '  :local fitiTmTls "yes"',
    '  :do { :if ([:typeof [:find [/system script get [find where name="fiti-poll"] source] "check-certificate=no"]] != "nil") do={ :set fitiTmTls "no" } } on-error={}',
    '  /tool fetch url=($fitiUrl . "/api/router/telemetry?site=" . $fitiSite) check-certificate=$fitiTmTls http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) http-method=post http-data=$fitiTmOut output=none',
    // Silent on failure: it retries next minute, and a warning every minute
    // would flood the router log.
    '} on-error={}',
  ].join('\n');
}

module.exports = {
  parseReport, recordReport, sweep, onlineForLocation, historyForSubscription, onlineCountForBusiness, telemetryReplyScript,
  FRESH_SECONDS, MAX_SESSIONS,
};

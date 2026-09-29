'use strict';

/*
 * Router terminal core: safeguards, audit log, single-use tickets and the
 * session registry shared by both transports.
 *
 * Transports (implemented in terminal-link.js):
 *   direct   Dashboard -> app -> (agent TCP relay over the gateway control
 *            channel) -> router:22. The app terminates SSH itself, so the
 *            gateway VPS only ever sees SSH ciphertext. The router admin
 *            password lives only in app memory for the session.
 *   gateway  Dashboard -> app -> agent opens the SSH session on the VPS and
 *            relays PTY frames. The password transits the VPS, so this
 *            transport additionally requires platform admin approval (the
 *            `gateway_transport` setting) AND the VPS operator opting in
 *            with WIFI_FITI_TERMINAL_PROXY=1.
 *
 * Safeguards (agreed with the business owner):
 *   - owner-only: routes are guarded 'owner' in team.js ROUTES and the
 *     WebSocket ticket binds business + location + transport.
 *   - enrolled routers only: remote access status must be `configured`
 *     with a live gateway tunnel (gatewayState `ready` + lastHandshakeAt).
 *   - blocklist: every completed input line is checked before it reaches
 *     the router. A blocked line is interrupted with Ctrl-C, the user is
 *     warned, and the attempt is audit-logged. Line-based gating has a
 *     small race (a fast command could start before Enter is processed);
 *     the audit log is the backstop.
 *   - audit: session open/close plus every input line (truncated) is
 *     written to SQLite. PTY output is never logged.
 *   - one session per router; idle timeout 10 min; absolute cap 45 min;
 *     at most 10 opens per business per hour.
 *   - the router password is never persisted, never logged, and is
 *     dropped from memory as soon as SSH authentication starts.
 */

const crypto = require('node:crypto');
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS terminal_audit_sessions (
    id            TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL,
    location_id   TEXT NOT NULL,
    transport     TEXT NOT NULL,
    actor_role    TEXT NOT NULL DEFAULT 'owner',
    opened_at     TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at     TEXT,
    close_reason  TEXT,
    lines_run     INTEGER NOT NULL DEFAULT 0,
    lines_blocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_terminal_audit_business
    ON terminal_audit_sessions(business_id, opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_terminal_audit_location
    ON terminal_audit_sessions(location_id, opened_at DESC);
  CREATE TABLE IF NOT EXISTS terminal_audit_lines (
    session_id TEXT NOT NULL REFERENCES terminal_audit_sessions(id),
    seq        INTEGER NOT NULL,
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    kind       TEXT NOT NULL, -- input | blocked | system
    text       TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE IF NOT EXISTS terminal_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SESSION_MS = 45 * 60 * 1000;
const TICKET_TTL_MS = 90 * 1000;
const MAX_LINE_LOG = 200;
const MAX_CONCURRENT_PER_BUSINESS = 5;
const OPEN_RATE_LIMIT = 10; // opens per business per hour

const TRANSPORTS = { direct: 'direct', gateway: 'gateway' };

/* ------------------------------------------------------------------ */
/* Blocklist                                                           */
/* ------------------------------------------------------------------ */

/*
 * RouterOS command verbs that are never forwarded. Matching is done on bare
 * words outside quoted strings (case-insensitive), so `:put "do not remove
 * me"` stays allowed while `/ip firewall filter remove 0` and
 * `/system reboot` are blocked. Quoted strings are stripped first: a real
 * command verb can never hide inside quotes, and words inside quotes (like
 * a comment reading "do not remove") must not trip the blocklist. The
 * two-word rule covers `/system backup load`.
 */
const BLOCKED_VERBS = new Set(['reboot', 'shutdown', 'reset-configuration', 'remove', 'disable', 'restore']);

/** Returns a human label for the blocked command, or null when allowed. */
function blockedCommandLabel(line) {
  const clean = String(line || '').trim();
  if (!clean) return null;
  const unquoted = clean.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  const words = unquoted.replace(/^\/+/, '').split(/[\s\/]+/).map((word) => word.toLowerCase()).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (BLOCKED_VERBS.has(words[i])) return words[i];
    if (words[i] === 'backup' && words[i + 1] === 'load') return 'backup load';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Platform settings (the gateway-transport kill switch)               */
/* ------------------------------------------------------------------ */

const getSettingStmt = db.prepare('SELECT value FROM terminal_settings WHERE key=?');
const setSettingStmt = db.prepare(
  `INSERT INTO terminal_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
);

function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

/** Transport 2 (agent-side SSH proxy) needs explicit platform admin approval. */
function gatewayTransportApproved() {
  return getSetting('gateway_transport', 'off') === 'on';
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

const insertSessionStmt = db.prepare(
  `INSERT INTO terminal_audit_sessions (id, business_id, location_id, transport, actor_role)
   VALUES (?, ?, ?, ?, ?)`
);
const insertLineStmt = db.prepare(
  `INSERT INTO terminal_audit_lines (session_id, seq, kind, text)
   VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM terminal_audit_lines WHERE session_id=?), ?, ?)`
);
const closeSessionStmt = db.prepare(
  `UPDATE terminal_audit_sessions
   SET closed_at=datetime('now'), close_reason=?, lines_run=?, lines_blocked=?
   WHERE id=? AND closed_at IS NULL`
);
const sessionStatsStmt = db.prepare(
  `SELECT
     SUM(CASE WHEN kind='input' THEN 1 ELSE 0 END) AS lines_run,
     SUM(CASE WHEN kind='blocked' THEN 1 ELSE 0 END) AS lines_blocked
   FROM terminal_audit_lines WHERE session_id=?`
);
const recentSessionsStmt = db.prepare(
  `SELECT id, business_id, location_id, transport, actor_role, opened_at, closed_at,
          close_reason, lines_run, lines_blocked
   FROM terminal_audit_sessions WHERE business_id=? ORDER BY opened_at DESC LIMIT ?`
);

const newId = (prefix) => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;

function auditSessionOpen({ businessId, locationId, transport, actorRole = 'owner' }) {
  const id = newId('term');
  insertSessionStmt.run(id, businessId, locationId, transport, actorRole);
  auditLine(id, 'system', `session opened via ${transport} transport`);
  return id;
}

function auditLine(sessionId, kind, text) {
  const safe = String(text || '').slice(0, MAX_LINE_LOG);
  insertLineStmt.run(sessionId, sessionId, kind, safe);
}

function auditSessionClose(sessionId, reason) {
  const stats = sessionStatsStmt.get(sessionId) || {};
  closeSessionStmt.run(reason, Number(stats.lines_run) || 0, Number(stats.lines_blocked) || 0, sessionId);
}

function recentSessions(businessId, limit = 50) {
  return recentSessionsStmt.all(businessId, Math.min(Math.max(Number(limit) || 50, 1), 200));
}

/* ------------------------------------------------------------------ */
/* Single-use WebSocket tickets                                        */
/* ------------------------------------------------------------------ */

const tickets = new Map(); // ticket -> { businessId, locationId, transport, expiresAt }

function createTicket({ businessId, locationId, transport }) {
  if (!TRANSPORTS[transport]) throw Object.assign(new Error('Unknown terminal transport.'), { status: 400 });
  const ticket = `term-ticket-${crypto.randomBytes(18).toString('hex')}`;
  tickets.set(ticket, { businessId, locationId, transport, expiresAt: Date.now() + TICKET_TTL_MS });
  if (tickets.size % 25 === 0) sweepTickets();
  return ticket;
}

function consumeTicket(ticket) {
  const entry = tickets.get(String(ticket || ''));
  if (entry) tickets.delete(String(ticket || ''));
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

function sweepTickets(now = Date.now()) {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt < now) tickets.delete(ticket);
  }
}

/* ------------------------------------------------------------------ */
/* Session registry: one session per router, rate limits, timeouts     */
/* ------------------------------------------------------------------ */

const sessionsByLocation = new Map(); // locationId -> session
const opensByBusiness = new Map(); // businessId -> [timestamps]

function checkRateLimit(businessId, now = Date.now()) {
  const windowStart = now - 3600_000;
  const opens = (opensByBusiness.get(businessId) || []).filter((at) => at > windowStart);
  if (opens.length >= OPEN_RATE_LIMIT) {
    throw Object.assign(new Error('Too many terminal sessions opened recently. Try again later.'), { status: 429 });
  }
  opens.push(now);
  opensByBusiness.set(businessId, opens);
}

function concurrentSessions(businessId) {
  let count = 0;
  for (const session of sessionsByLocation.values()) {
    if (session.businessId === businessId) count++;
  }
  return count;
}

function registerSession(session) {
  if (sessionsByLocation.has(session.locationId)) {
    throw Object.assign(new Error('A terminal session is already open for this router.'), { status: 409 });
  }
  if (concurrentSessions(session.businessId) >= MAX_CONCURRENT_PER_BUSINESS) {
    throw Object.assign(new Error('Too many open terminal sessions.'), { status: 429 });
  }
  sessionsByLocation.set(session.locationId, session);
}

function unregisterSession(locationId) {
  sessionsByLocation.delete(locationId);
}

function getSession(locationId) {
  return sessionsByLocation.get(locationId) || null;
}

/** Close idle or over-long sessions. Returns the closed sessions. */
function sweepSessions(now = Date.now()) {
  const closed = [];
  for (const session of sessionsByLocation.values()) {
    if (now - session.lastActivityAt > IDLE_TIMEOUT_MS) {
      closed.push({ session, reason: 'idle timeout' });
    } else if (now - session.openedAt > MAX_SESSION_MS) {
      closed.push({ session, reason: 'maximum session length reached' });
    }
  }
  for (const { session, reason } of closed) {
    try { session.close(reason); } catch (_) { /* closing is best-effort */ }
  }
  return closed;
}

/* ------------------------------------------------------------------ */
/* Eligibility: enrolled routers only                                  */
/* ------------------------------------------------------------------ */

/**
 * The terminal is only offered for routers whose remote access is fully
 * enrolled: status `configured`, gateway peer `ready`, and the gateway has
 * observed a WireGuard handshake (lastHandshakeAt). Anything earlier means
 * there is no tunnel to reach the router through.
 */
function terminalEligible(remoteAccess) {
  if (!remoteAccess) return false;
  return String(remoteAccess.status || '') === 'configured'
    && String(remoteAccess.gatewayState || '') === 'ready'
    && Boolean(remoteAccess.lastHandshakeAt);
}

module.exports = {
  IDLE_TIMEOUT_MS,
  MAX_SESSION_MS,
  TICKET_TTL_MS,
  MAX_LINE_LOG,
  TRANSPORTS,
  blockedCommandLabel,
  getSetting,
  setSetting,
  gatewayTransportApproved,
  auditSessionOpen,
  auditLine,
  auditSessionClose,
  recentSessions,
  createTicket,
  consumeTicket,
  sweepTickets,
  checkRateLimit,
  registerSession,
  unregisterSession,
  getSession,
  sweepSessions,
  terminalEligible,
};

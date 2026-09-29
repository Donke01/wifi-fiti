'use strict';

/*
 * Router tools: one-off jobs an owner runs from the dashboard (router health,
 * log, speed test, check a customer, save a backup, restart). Like every
 * other router job they travel in the router's own poll reply and the router
 * answers over HTTPS with its token, so nothing on the router is opened up.
 * One tool at a time per router; read-only except backup and restart.
 */
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_router_tools (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id TEXT NOT NULL,
    tool        TEXT NOT NULL,
    args_json   TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'queued',
    result      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS tenant_router_tools_location ON tenant_router_tools(location_id, status);
`);

const TOOLS = new Set(['health', 'log', 'speed', 'customer', 'backup', 'reboot']);
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const SENT_TIMEOUT_MS = 3 * 60_000;
const QUEUED_TIMEOUT_MS = 10 * 60_000;
const RUNS_PER_HOUR = 30;
const SPEED_BYTES = 2 * 1024 * 1024;
const BACKUP_NAME = 'wifi-fiti-backup';

function toolError(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function parseSqlTime(value) { const t = Date.parse(String(value || '').replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : 0; }

const insertTool = db.prepare(`INSERT INTO tenant_router_tools (location_id, tool, args_json) VALUES (?, ?, ?)`);
const activeTool = db.prepare(`SELECT * FROM tenant_router_tools WHERE location_id=? AND status IN ('queued','sent') ORDER BY id LIMIT 1`);
const toolById = db.prepare(`SELECT * FROM tenant_router_tools WHERE id=? AND location_id=?`);
const recentTools = db.prepare(`SELECT * FROM tenant_router_tools WHERE location_id=? ORDER BY id DESC LIMIT 12`);
const runsLastHour = db.prepare(`SELECT COUNT(*) AS n FROM tenant_router_tools WHERE location_id=? AND created_at >= datetime('now','-1 hour')`);
const setTool = db.prepare(`UPDATE tenant_router_tools SET status=@status, result=COALESCE(@result, result), updated_at=datetime('now') WHERE id=@id`);

/** Queue a tool. `busyChange` blocks a restart while a network change runs. */
const pruneTools = db.prepare(`DELETE FROM tenant_router_tools WHERE created_at < datetime('now','-30 days')`);
function queueTool(locationId, tool, args = {}, { busyChange = false, online = true } = {}) {
  if (!TOOLS.has(tool)) throw toolError('Unknown tool.');
  try { pruneTools.run(); } catch (_) {}
  if (!online) throw toolError('This router has not checked in for a few minutes, so it can\u2019t run a tool now. Check its power and internet connection.', 409);
  settleStale(locationId);
  if (activeTool.get(locationId)) throw toolError('Another tool is still running on this router. Wait for it to finish.', 409);
  if (runsLastHour.get(locationId).n >= RUNS_PER_HOUR) throw toolError('That is a lot of tools in one hour. Try again a little later.', 429);
  const clean = {};
  if (tool === 'customer') {
    let mac = String(args.mac || '').trim().toUpperCase().replace(/-/g, ':');
    if (/^[0-9A-F]{12}$/.test(mac)) mac = mac.match(/../g).join(':');
    if (!MAC.test(mac)) throw toolError('Enter the device’s MAC address (like AA:BB:CC:11:22:33), or a phone number that bought a package here.');
    clean.mac = mac;
  }
  if (tool === 'reboot') {
    if (args.confirm !== true) throw toolError('Confirm the restart first.');
    if (busyChange) throw toolError('A network change is on its way to this router. Restart it after the change is done.', 409);
  }
  const id = Number(insertTool.run(locationId, tool, JSON.stringify(clean)).lastInsertRowid);
  return publicTool(toolById.get(id, locationId));
}

// A tool the router never collected, or never answered, is closed so the
// owner is not left waiting and another can run.
function settleStale(locationId, now = Date.now()) {
  const row = activeTool.get(locationId);
  if (!row) return;
  const age = now - parseSqlTime(row.updated_at);
  if ((row.status === 'sent' && age > SENT_TIMEOUT_MS) || (row.status === 'queued' && age > QUEUED_TIMEOUT_MS)) {
    setTool.run({ id: row.id, status: 'failed', result: 'error=no_answer' });
  }
}

function hasQueuedTool(locationId) { return Boolean(activeTool.get(locationId)); }
/** A restart is waiting or on its way: a network change must not start now. */
function restartPending(locationId) { const row = activeTool.get(locationId); return Boolean(row && row.tool === 'reboot'); }
const speedDownloads = new Map();
/** Whether this router may download the speed-test file right now. */
function allowSpeedDownload(locationId) {
  const row = activeTool.get(locationId);
  if (!row || row.tool !== 'speed' || row.status !== 'sent') return false;
  const n = speedDownloads.get(row.id) || 0;
  if (n >= 2) return false;
  speedDownloads.set(row.id, n + 1);
  if (speedDownloads.size > 500) speedDownloads.clear();
  return true;
}

/* ---------------------------------------------------------------- scripts */

// The router posts its answer (text, key=value lines) with its token, with the
// same verified-then-compatibility double try as the poller.
// Certificate checking follows this router's own poller: verified TLS unless
// its kit is the compatibility one (no usable CA store). Never a verified try
// then an unverified retry, which would hand the token to anyone who can make
// the first one fail.
const CERT_LINES = [
  ':local fitiCk "yes"',
  ':do { :if ([:typeof [:find [/system script get [find where name="fiti-poll"] source] "check-certificate=yes"]] = "nil") do={ :set fitiCk "no" } } on-error={}',
];
function answerLines(id) {
  const url = '($fitiUrl . "/api/router/tool?site=" . $fitiSite . "&id=' + id + '")';
  return [`:do { /tool fetch url=${url} check-certificate=$fitiCk http-method=post http-data=$fitiOut http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=none } on-error={}`];
}
// A tool that needs a router permission the poller may not have (older kits):
// checked first, and said plainly instead of failing silently.
function needsPolicy(policy) {
  return `:local fitiPol ""; :do { :set fitiPol [:tostr [/system script get [find where name="fiti-poll"] policy]] } on-error={}; :if ([:typeof [:find $fitiPol "${policy}"]] = "nil") do={ :set fitiOut "error=needs_permission\\n" }`;
}
const rosSrc = (lines) => '"' + lines.join('\r\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
function toolScript(row) {
  let args = {}; try { args = JSON.parse(row.args_json || '{}'); } catch (_) {}
  const id = row.id;
  const body = [];
  switch (row.tool) {
    case 'health':
      body.push(
        ':set fitiOut ("uptime=" . [:tostr [/system resource get uptime]] . "\\ncpu=" . [:tostr [/system resource get cpu-load]] . "\\nfree=" . [:tostr [/system resource get free-memory]] . "\\ntotal=" . [:tostr [/system resource get total-memory]] . "\\nversion=" . [:tostr [/system resource get version]] . "\\nboard=" . [:tostr [/system resource get board-name]] . "\\nhdd=" . [:tostr [/system resource get free-hdd-space]] . "\\nclock=" . [:tostr [/system clock get date]] . " " . [:tostr [/system clock get time]] . "\\n")',
        ':do { :set fitiOut ($fitiOut . "hotspot_users=" . [:len [/ip hotspot active find]] . "\\n") } on-error={}',
      );
      break;
    case 'log':
      // The last 30 entries, each cut to 180 characters.
      body.push(
        ':local ids [/log find]; :local n [:len $ids]; :local s ($n - 30); :if ($s < 0) do={ :set s 0 }',
        ':for i from=$s to=($n - 1) do={ :do { :local e [:pick $ids $i]; :local m [:tostr [/log get $e message]]; :if ([:len $m] > 180) do={ :set m [:pick $m 0 180] }; :set fitiOut ($fitiOut . "line=" . [:tostr [/log get $e time]] . "|" . [:tostr [/log get $e topics]] . "|" . $m . "\\n") } on-error={} }',
      );
      break;
    case 'speed':
      // In the background: the router's next check-ins (and payments) never
      // wait behind the download. The test file is not saved (output=none).
      return backgroundSpeed(id);
    case 'customer': {
      const mac = MAC.test(String(args.mac || '')) ? args.mac : '00:00:00:00:00:00';
      body.push(
        `:set fitiOut ("mac=${mac}\\n")`,
        `:do { :set fitiOut ($fitiOut . "active=" . [:len [/ip hotspot active find where mac-address="${mac}"]] . "\\n") } on-error={}`,
        `:do { :local h [/ip hotspot host find where mac-address="${mac}"]; :set fitiOut ($fitiOut . "host=" . [:len $h] . "\\n"); :if ([:len $h] > 0) do={ :set fitiOut ($fitiOut . "authorized=" . [:tostr [/ip hotspot host get [:pick $h 0] authorized]] . "\\naddress=" . [:tostr [/ip hotspot host get [:pick $h 0] address]] . "\\n") } } on-error={}`,
        `:do { :set fitiOut ($fitiOut . "user=" . [:len [/ip hotspot user find where mac-address="${mac}"]] . "\\n") } on-error={}`,
        `:do { :set fitiOut ($fitiOut . "binding=" . [:len [/ip hotspot ip-binding find where mac-address="${mac}"]] . "\\n") } on-error={}`,
      );
      break;
    }
    case 'backup':
      // One backup kept on the router, replaced each time (small routers have
      // little flash).
      body.push(
        needsPolicy('sensitive'),
        `:if ([:len $fitiOut] = 0) do={ :local fn "${BACKUP_NAME}"; :if ([:len [/file find where name="flash"]] > 0) do={ :set fn ("flash/" . $fn) }; :do { /system backup save name=$fn dont-encrypt=yes; :delay 2s; :set fitiOut ("saved=yes\\nname=" . $fn . ".backup\\nsize=" . [:tostr [/file get [find where name=($fn . ".backup")] size]] . "\\n") } on-error={ :set fitiOut "error=backup_failed\\n" } }`,
      );
      break;
    case 'reboot':
      body.push(needsPolicy('reboot'), ':if ([:len $fitiOut] = 0) do={ :set fitiOut "state=restarting\\n" }');
      break;
    default: return '';
  }
  const lines = [
    `# Wi-Fi Fiti tool ${id}: ${row.tool}`,
    ':do {',
    ':global fitiUrl', ':global fitiToken', ':global fitiSite',
    ':local fitiOut ""',
    ...CERT_LINES,
    ...body,
    ...answerLines(id),
  ];
  // The restart runs after the answer is sent and this reply has finished,
  // and only when the poller is allowed to restart the router.
  if (row.tool === 'reboot') lines.push(':if ($fitiOut = "state=restarting\\n") do={ :execute ":delay 5s; /system reboot" }');
  lines.push('} on-error={}');
  return lines.join('\n');
}

function backgroundSpeed(id) {
  const job = [
    ':global fitiUrl', ':global fitiToken', ':global fitiSite',
    ':local fitiOut ""',
    ...CERT_LINES,
    ':do { :local u ($fitiUrl . "/api/router/speed-test?site=" . $fitiSite); :local r [/tool fetch url=$u check-certificate=$fitiCk http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=none idle-timeout=15s as-value]; :set fitiOut ("downloaded=" . [:tostr ($r->"downloaded")] . "\\nduration=" . [:tostr ($r->"duration")] . "\\n") } on-error={ :set fitiOut "error=download_failed\\n" }',
    ':do { :set fitiOut ($fitiOut . "ping_ok=" . [:tostr [/ping 8.8.8.8 count=4]] . "\\n") } on-error={}',
    ...answerLines(id),
  ];
  return [`# Wi-Fi Fiti tool ${id}: speed`, `:execute script=${rosSrc(job)}`].join('\n');
}

/** The next tool for this router's poll reply, at most one at a time. */
function nextToolScript(location) {
  settleStale(location.id);
  const row = activeTool.get(location.id);
  if (!row || row.status !== 'queued') return '';
  const script = toolScript(row);
  if (!script) { setTool.run({ id: row.id, status: 'failed', result: 'error=unknown_tool' }); return ''; }
  setTool.run({ id: row.id, status: 'sent', result: null });
  return script;
}

/** The router's answer: plain key=value lines, kept short. */
function recordAnswer(location, id, body) {
  const row = toolById.get(Number(id), location.id);
  if (!row || row.status !== 'sent') return 'unknown';
  const text = String(body || '').replace(/\r/g, '').slice(0, 12000);
  setTool.run({ id: row.id, status: /^error=/m.test(text) && !/^(line|saved|ping_ok)=/m.test(text) ? 'failed' : 'done', result: text });
  return 'ok';
}

function kv(text) {
  const out = {}; const lines = [];
  String(text || '').split('\n').forEach((l) => { const i = l.indexOf('='); if (i <= 0) return; const k = l.slice(0, i); const v = l.slice(i + 1); if (k === 'line') lines.push(v); else out[k] = v; });
  return { out, lines };
}
function bytes(value) {
  const m = String(value || '').trim().match(/^([\d.]+)\s*([KMG]?i?B)?$/i);
  if (!m) return null;
  const n = Number(m[1]); const unit = (m[2] || 'B').toUpperCase();
  return Math.round(n * ({ B: 1, KIB: 1024, KB: 1024, MIB: 1048576, MB: 1048576, GIB: 1073741824, GB: 1073741824 }[unit] || 1));
}
function seconds(value) {
  // RouterOS durations: "1s", "2s340ms", "00:00:02.34", "1w2d3h4m5s".
  const v = String(value || '').trim();
  const clock = v.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  let total = 0; let any = false;
  v.replace(/(\d+(?:\.\d+)?)(w|d|h|ms|m|s)/g, (_, n, u) => { any = true; total += Number(n) * ({ w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 }[u]); return ''; });
  return any ? total : null;
}

/** What the dashboard shows for a run: status plus a small parsed summary. */
function publicTool(row) {
  if (!row) return null;
  let args = {}; try { args = JSON.parse(row.args_json || '{}'); } catch (_) {}
  const { out, lines } = kv(row.result);
  const summary = {};
  if (row.status === 'done' || row.status === 'failed') {
    if (out.error) summary.error = out.error;
    if (row.tool === 'health') {
      const free = bytes(out.free); const total = bytes(out.total);
      Object.assign(summary, { uptime: out.uptime || null, cpu: out.cpu != null ? Number(out.cpu) : null, freeMemory: free, totalMemory: total, version: out.version || null, board: out.board || null, freeStorage: bytes(out.hdd), clock: out.clock || null, hotspotUsers: out.hotspot_users != null ? Number(out.hotspot_users) : null });
    } else if (row.tool === 'log') {
      summary.lines = lines.map((l) => { const [time, topics, ...rest] = l.split('|'); return { time: time || '', topics: topics || '', message: rest.join('|') }; });
    } else if (row.tool === 'speed') {
      if (out.error) summary.downloadFailed = true;
      const got = bytes(out.downloaded ? `${out.downloaded}KiB` : null); const secs = seconds(out.duration);
      if (got && secs) summary.mbps = Math.round((got * 8 / secs / 1e6) * 10) / 10;
      if (out.ping_ok != null) summary.pingOk = Number(out.ping_ok);
    } else if (row.tool === 'customer') {
      Object.assign(summary, { online: Number(out.active || 0) > 0, seen: Number(out.host || 0) > 0, authorized: out.authorized === 'true', address: out.address || null, hasUser: Number(out.user || 0) > 0, bypassed: Number(out.binding || 0) > 0 });
    } else if (row.tool === 'backup') {
      Object.assign(summary, { saved: out.saved === 'yes', size: out.size ? Number(out.size) || bytes(out.size) : null, name: out.name || `${BACKUP_NAME}.backup` });
    } else if (row.tool === 'reboot') {
      summary.restarting = true;
    }
  }
  return { id: row.id, tool: row.tool, args, status: row.status, summary, createdAt: row.created_at, updatedAt: row.updated_at };
}

function listTools(locationId) { settleStale(locationId); return recentTools.all(locationId).map(publicTool); }

/** The last finished Router health check, for the router card: { cpu, freeMemory, totalMemory, uptime, hotspotUsers, at } or null. */
const lastHealth = db.prepare(`SELECT * FROM tenant_router_tools WHERE location_id=? AND tool='health' AND status='done' ORDER BY id DESC LIMIT 1`);
function latestHealth(locationId) {
  const run = publicTool(lastHealth.get(locationId));
  if (!run || run.summary.error) return null;
  const { cpu, freeMemory, totalMemory, uptime, hotspotUsers } = run.summary;
  const number = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
  return { cpu: number(cpu), freeMemory: number(freeMemory), totalMemory: number(totalMemory), uptime: uptime || null, hotspotUsers: number(hotspotUsers), at: run.updatedAt };
}

module.exports = { queueTool, nextToolScript, recordAnswer, listTools, latestHealth, hasQueuedTool, restartPending, allowSpeedDownload, toolScript, publicTool, TOOLS, SPEED_BYTES, _test: { bytes, seconds } };

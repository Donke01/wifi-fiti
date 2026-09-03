const { RouterOsClient } = require('./routeros-api');
const config = require('../config');

/**
 * One short-lived connection per operation. On a 650MHz hAP lite this is
 * cheaper than babysitting a long-lived socket that dies silently when the
 * router reboots or the link flaps, and payments are infrequent enough that
 * the handshake cost is irrelevant.
 */
async function withRouter(fn) {
  const conn = new RouterOsClient({
    host: config.mikrotik.host,
    port: config.mikrotik.port,
    user: config.mikrotik.user,
    password: config.mikrotik.password,
    timeout: 10000,
  });

  await conn.connect();
  try {
    return await fn(conn);
  } finally {
    try {
      conn.close();
    } catch {
      /* socket already gone - nothing to do */
    }
  }
}

/* ------------------------------------------------------------------ */
/* RouterOS duration parsing                                           */
/* ------------------------------------------------------------------ */

/**
 * RouterOS reports durations in two shapes depending on magnitude:
 *   "3h", "1w2d3h4m5s"      (suffix form)
 *   "1d 02:30:00", "02:30:00" (clock form)
 * Both have to round-trip to seconds or top-ups silently reset people's time.
 */
function parseRouterOsTime(value) {
  if (value === undefined || value === null || value === '') return 0;
  const s = String(value).trim();

  if (/^\d+$/.test(s)) return Number(s);

  let total = 0;
  let rest = s;

  const dayPrefix = rest.match(/^(\d+)d\s+/);
  if (dayPrefix) {
    total += Number(dayPrefix[1]) * 86400;
    rest = rest.slice(dayPrefix[0].length);
  }

  const clock = rest.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (clock) {
    return (
      total + Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
    );
  }

  const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  const matches = rest.matchAll(/(\d+)([wdhms])/g);
  for (const [, n, u] of matches) total += Number(n) * units[u];

  return total;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

async function findUser(conn, username) {
  const rows = await conn.write('/ip/hotspot/user/print', [`?name=${username}`]);
  return rows && rows.length ? rows[0] : null;
}

/**
 * Create the user, or add time to an existing one.
 *
 * Top-up maths: RouterOS `limit-uptime` is a lifetime cap measured against
 * a running `uptime` counter. Remaining time is (limit - uptime), so a new
 * limit of (limit + purchased) preserves whatever the customer had left
 * without touching counters. Adding time is therefore always safe to repeat.
 */
async function provisionUser({ username, password, profile, seconds, comment }) {
  return withRouter(async (conn) => {
    const existing = await findUser(conn, username);

    if (existing) {
      const currentLimit = parseRouterOsTime(existing['limit-uptime']);
      const newLimit = currentLimit + seconds;

      await conn.write('/ip/hotspot/user/set', [
        `=.id=${existing['.id']}`,
        `=limit-uptime=${newLimit}`,
        `=password=${password}`,
        `=profile=${profile}`,
        `=comment=${comment}`,
        '=disabled=no',
      ]);

      return { created: false, totalSeconds: newLimit };
    }

    await conn.write('/ip/hotspot/user/add', [
      `=name=${username}`,
      `=password=${password}`,
      `=profile=${profile}`,
      `=limit-uptime=${seconds}`,
      `=server=${config.mikrotik.hotspotServer}`,
      `=comment=${comment}`,
    ]);

    return { created: true, totalSeconds: seconds };
  });
}

/**
 * Log the device in server-side. The browser redirect to $(link-login-only)
 * is the primary path; this is the backstop for captive-portal mini-browsers
 * that refuse to follow it. Failure here is non-fatal - the customer still
 * has valid credentials they can type in.
 */
async function forceLogin({ username, password, mac, ip }) {
  if (!mac && !ip) return false;

  return withRouter(async (conn) => {
    const args = [`=user=${username}`, `=password=${password}`];
    if (ip) args.push(`=ip=${ip}`);
    if (mac) args.push(`=mac-address=${mac.toUpperCase()}`);

    await conn.write('/ip/hotspot/active/login', args);
    return true;
  });
}

async function testConnection() {
  return withRouter(async (conn) => {
    const [identity] = await conn.write('/system/identity/print');
    const [resource] = await conn.write('/system/resource/print');
    return {
      identity: identity?.name,
      version: resource?.version,
      board: resource?.['board-name'],
      freeMemory: resource?.['free-memory'],
    };
  });
}

module.exports = {
  provisionUser,
  forceLogin,
  testConnection,
  parseRouterOsTime,
};

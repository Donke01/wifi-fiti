/**
 * Generates RouterOS script for a site to execute.
 *
 * SECURITY: everything here becomes code on someone's router. Each field
 * is checked against an allowlist pattern immediately before it is
 * interpolated - not "upstream already validated it", because upstream
 * changes and this does not. A single unescaped quote in a username would
 * turn a provisioning job into arbitrary command execution.
 *
 * Jobs that fail validation are dropped and logged, never emitted.
 */

const PATTERNS = {
  username: /^254[17]\d{8}(?:-[0-9A-F]{8})?(?:-tv)?$/,
  password: /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,12}$/,
  profile: /^[a-z0-9-]{1,20}$/,
  server: /^[A-Za-z0-9_-]{1,32}$/,
  mac: /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/,
  ip: /^\d{1,3}(\.\d{1,3}){3}$/,
};

function safe(field, value) {
  if (typeof value !== 'string') return null;
  return PATTERNS[field].test(value) ? value : null;
}

function safeSeconds(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 366 * 86400) return null;
  return n;
}

/**
 * One job -> a RouterOS block that is safe to run repeatedly.
 *
 * `limit-uptime` is set to an absolute total rather than incremented, so
 * a redelivered job is a no-op instead of free internet. If the user was
 * lost to a router reset, this recreates them with their full balance -
 * the server is the source of truth, the router is a cache.
 */
function jobToScript(job, hotspotServer) {
  const username = safe('username', job.username);
  if (job.action === 'revoke') {
    if (!username) return null;
    return `:local u "${username}"\n` +
      `:do { /ip hotspot active remove [find user=$u] } on-error={}\n` +
      `:do { /ip hotspot cookie remove [find user=$u] } on-error={}\n` +
      `:do { /ip hotspot user remove [find name=$u] } on-error={}`;
  }
  const password = safe('password', job.password);
  const profile = safe('profile', job.profile);
  const server = safe('server', hotspotServer);
  const seconds = safeSeconds(job.total_seconds);

  if (!username || !password || !profile || !server || !seconds) {
    return null;
  }

  const mac = safe('mac', job.mac || '');
  const ip = safe('ip', job.ip || '');

  const lines = [
    `:local u "${username}"`,
    `:local p "${password}"`,
    `:if ([:len [/ip hotspot user find name=$u]] > 0) do={`,
    `  /ip hotspot user set [find name=$u] limit-uptime=${seconds} password=$p profile=${profile} disabled=no`,
    `} else={`,
    `  /ip hotspot user add name=$u password=$p profile=${profile} limit-uptime=${seconds} server=${server}`,
    `}`,
  ];

  // A username is one physical-device slot. Binding it here means copied
  // credentials cannot be used by a third phone or laptop.
  if (mac) {
    lines.splice(4, 0, `  /ip hotspot user set [find name=$u] mac-address=${mac}`);
    lines[6] = `  /ip hotspot user add name=$u password=$p profile=${profile} limit-uptime=${seconds} server=${server} mac-address=${mac}`;
  }

  // Auto-login is best effort. A failure here must not abort the script
  // and lose the provisioning above, hence the swallowed on-error.
  // TVs have no useful captive-portal browser, so log their dedicated
  // identity in as soon as it is provisioned. Phones with an IP are the
  // legacy direct-login path; the current portal submits login itself.
  if (ip || username.endsWith('-tv')) {
    const args = ['user=$u', 'password=$p'];
    if (mac) args.push(`mac-address=${mac}`);
    if (ip) args.push(`ip=${ip}`);
    lines.push(`:do { /ip hotspot active login ${args.join(' ')} } on-error={}`);
  }

  return lines.join('\n');
}

/**
 * Assemble the full response. Ends with an acknowledgement fetch so the
 * server learns the work landed; unacknowledged jobs are redelivered.
 */
function buildScript({ jobs, hotspotServer }) {
  const blocks = [];
  const emitted = [];
  const rejected = [];

  for (const job of jobs) {
    const block = jobToScript(job, hotspotServer);
    if (block) {
      blocks.push(block);
      emitted.push(job.id);
    } else {
      rejected.push(job.id);
    }
  }

  if (!blocks.length) return { script: '', emitted, rejected };

  // Acknowledge by leaving the ids in a global that the next sync call
  // carries back, rather than firing a second fetch from inside the
  // parsed script.
  //
  // That second fetch was wrapped in on-error={} to stop a network blip
  // aborting the provisioning above - which meant that when it failed it
  // failed silently, the job was never acked, and the server redelivered
  // it every 60 seconds. Each redelivery rewrote limit-uptime, so a
  // customer who topped up watched their balance snap back to the old
  // figure once a minute.
  //
  // Riding on the sync request removes the failure mode entirely: that
  // connection is already proven, and the ack arrives within 10 seconds.
  const ack = `:global fitiAck "${emitted.join(',')}"`;

  return { script: blocks.join('\n') + '\n' + ack + '\n', emitted, rejected };
}

/** Disable subscriptions whose wall-clock expiry has passed. The router
 * polls every five seconds, so an expired customer is disconnected even if
 * their browser is closed and their RouterOS uptime allowance is unused. */
function buildExpiryScript(accounts) {
  const blocks = [];
  for (const account of accounts || []) {
    const username = safe('username', account.phone);
    if (!username) continue;
    blocks.push(
      `:local u "${username}"\n` +
      `:do { /ip hotspot active remove [find user=$u] } on-error={}\n` +
      `:do { /ip hotspot user set [find name=$u] disabled=yes } on-error={}\n` +
      `:local tv ($u . "-tv")\n` +
      `:do { /ip hotspot active remove [find user=$tv] } on-error={}\n` +
      `:do { /ip hotspot user set [find name=$tv] disabled=yes } on-error={}`
    );
  }
  return blocks.join('\n');
}

module.exports = { buildScript, buildExpiryScript, jobToScript, safe, safeSeconds };

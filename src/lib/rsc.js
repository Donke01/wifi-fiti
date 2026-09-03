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
  username: /^254[17]\d{8}$/,
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

  // Auto-login is best effort. A failure here must not abort the script
  // and lose the provisioning above, hence the swallowed on-error.
  if (mac || ip) {
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
function buildScript({ jobs, hotspotServer, ackUrl }) {
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

  // Only reachable if every block above ran without throwing.
  const ack = `:do { /tool fetch url="${ackUrl}${emitted.join(',')}" output=none keep-result=no } on-error={}`;

  return { script: blocks.join('\n') + '\n' + ack + '\n', emitted, rejected };
}

module.exports = { buildScript, jobToScript, safe, safeSeconds };

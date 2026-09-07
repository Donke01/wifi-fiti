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

const crypto = require('crypto');

const PATTERNS = {
  username: /^254[17]\d{8}(?:-[0-9A-F]{8})?(?:-tv)?$/,
  password: /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,12}$/,
  profile: /^[a-z0-9-]{1,20}$/,
  server: /^[A-Za-z0-9_-]{1,32}$/,
  // The business editor accepts only this small RouterOS speed grammar.
  // Recheck it here because this value is interpolated into router code.
  rateLimit: /^\d+(?:\.\d+)?[kM]\/\d+(?:\.\d+)?[kM]$/,
  mac: /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/,
  ip: /^\d{1,3}(\.\d{1,3}){3}$/,
};

function safe(field, value) {
  if (typeof value !== 'string') return null;
  return PATTERNS[field].test(value) ? value : null;
}

function safeSeconds(value) {
  const n = Number(value);
  // `limit-uptime` is a router-side safety ceiling. The authoritative
  // entitlement is the server wall-clock expiry, so long-lived customers
  // must not eventually receive an invalid RouterOS job simply because
  // their lifetime purchases crossed one year.
  if (!Number.isInteger(n) || n < 1 || n > 10 * 366 * 86400) return null;
  return n;
}

/**
 * RouterOS v7 applies a HotSpot bandwidth cap through a *user profile*,
 * not the local `/ip hotspot user` record.  Keep the generated name short
 * and deterministic: the router can reuse one profile for every package
 * with the same speed, without letting an editable package name become a
 * RouterOS identifier.
 */
function rateProfileName(rateLimit) {
  return `fiti-${crypto.createHash('sha256').update(rateLimit).digest('hex').slice(0, 12)}`;
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
      `:if ([:len [/ip hotspot active find where user=$u]] > 0) do={ /ip hotspot active remove [find where user=$u] }\n` +
      `:if ([:len [/ip hotspot cookie find where user=$u]] > 0) do={ /ip hotspot cookie remove [find where user=$u] }\n` +
      `:if ([:len [/ip hotspot user find where name=$u]] > 0) do={ /ip hotspot user remove [find where name=$u] }`;
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
  const rateLimit = job.rate_limit ? safe('rateLimit', job.rate_limit) : null;
  // A malformed optional rate must reject the whole job. Silently omitting
  // it would turn a paid speed package into unlimited/profile speed.
  if (job.rate_limit && !rateLimit) return null;
  const effectiveProfile = rateLimit ? rateProfileName(rateLimit) : profile;
  const profileArg = rateLimit ? 'profile=$fitiProfile' : `profile=${effectiveProfile}`;
  const update = [`limit-uptime=${seconds}`, 'password=$p', profileArg, 'disabled=no'];
  const add = ['name=$u', 'password=$p', profileArg, `limit-uptime=${seconds}`, `server=${server}`];
  if (mac) { update.push(`mac-address=${mac}`); add.push(`mac-address=${mac}`); }

  const lines = [];
  if (rateLimit) {
    // `rate-limit` belongs to `/ip hotspot user profile` in RouterOS v7.
    // A profile is created once per safe, canonical package speed. The
    // normal package path continues to use the operator's `standard`
    // profile, so it keeps the router's normal speed and settings.
    lines.push(
      `:local fitiProfile "${effectiveProfile}"`,
      `:local fitiRate "${rateLimit}"`,
      // Clone the operator's standard profile so package speeds retain its
      // cookie, queue and session settings. The explicit set also repairs a
      // managed profile if it was edited directly on the router.
      `:if ([:len [/ip hotspot user profile find where name=$fitiProfile]] = 0) do={ /ip hotspot user profile add copy-from=${profile} name=$fitiProfile rate-limit=$fitiRate } else={ /ip hotspot user profile set [find where name=$fitiProfile] rate-limit=$fitiRate }`
    );
  }
  lines.push(
    `:local u "${username}"`,
    `:local p "${password}"`,
    `:if ([:len [/ip hotspot user find name=$u]] > 0) do={`,
    `  /ip hotspot user set [find name=$u] ${update.join(' ')}`,
    `} else={`,
    `  /ip hotspot user add ${add.join(' ')}`,
    `}`
  );

  if (job.action === 'transfer') {
    lines.unshift(
      `:if ([:len [/ip hotspot active find where user="${username}"]] > 0) do={ /ip hotspot active remove [find where user="${username}"] }`,
      `:if ([:len [/ip hotspot cookie find where user="${username}"]] > 0) do={ /ip hotspot cookie remove [find where user="${username}"] }`
    );
  }

  // Auto-login is best effort. A failure here must not abort the script
  // and lose the provisioning above, hence the swallowed on-error.
  // TVs have no useful captive-portal browser, so log their dedicated
  // identity in as soon as it is provisioned. Phones with a captive-portal
  // IP receive the same best-effort direct login; the browser never posts
  // hotspot credentials itself.
  if (ip || username.endsWith('-tv') || job.action === 'transfer') {
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

/*
 * Optional remote-support controls use a different queue and acknowledgement
 * from tenant HotSpot jobs. Keep the emitted language intentionally tiny:
 * `prepare` may run the already-installed bootstrap helper, while `revoke`
 * can only turn off the managed scheduler and delete the managed, disabled
 * WireGuard interface. Neither action is allowed to touch a HotSpot user,
 * billing poll, peer, address, route, firewall rule, service, or WAN port.
 */
function remoteSupportControlToScript(control) {
  const id = Number(control && control.id);
  if (!Number.isInteger(id) || id < 1) return null;

  if (control.action === 'prepare') {
    return [
      ':global fitiSupportEnabled "yes"',
      ':local fitiSupportBootstrap [/system script find where name="fiti-support-bootstrap"]',
      ':local fitiSupportPrepared false',
      ':if ([:len $fitiSupportBootstrap] = 1) do={',
      '  :do {',
      '    /system script run $fitiSupportBootstrap',
      '    :set fitiSupportPrepared true',
      '  } on-error={',
      '    :log warning "fiti support: bootstrap failed; support preparation will retry"',
      '  }',
      '} else={',
      '  :log warning "fiti support: bootstrap helper is not installed; support preparation will retry"',
      '}',
      `:if ($fitiSupportPrepared) do={ :global fitiSupportAck "${id}" }`,
    ].join('\n');
  }

  if (control.action === 'revoke') {
    return [
      ':global fitiSupportEnabled "no"',
      ':global fitiSupportInterface',
      ':local fitiSupportCleanupOk true',
      ':local fitiSupportSchedulers [/system scheduler find where name="fiti-support-enroll"]',
      ':foreach fitiSupportScheduler in=$fitiSupportSchedulers do={',
      '  :local fitiSupportSchedulerComment [/system scheduler get $fitiSupportScheduler comment]',
      '  :if ([:typeof [:find $fitiSupportSchedulerComment "WiFi Fiti: optional remote-support public-key enrollment"]] != "nil") do={',
      '    :do { /system scheduler disable $fitiSupportScheduler } on-error={',
      '      :set fitiSupportCleanupOk false',
      '      :log warning "fiti support: could not disable the managed scheduler"',
      '    }',
      '  } else={',
      '    :set fitiSupportCleanupOk false',
      '    :log warning "fiti support: scheduler name belongs to a non-WiFi-Fiti task; leaving it untouched"',
      '  }',
      '}',
      ':local fitiSupportWireguards [/interface wireguard find where name=$fitiSupportInterface]',
      ':foreach fitiSupportWireguard in=$fitiSupportWireguards do={',
      '  :local fitiSupportWireguardComment [/interface wireguard get $fitiSupportWireguard comment]',
      '  :if ([:typeof [:find $fitiSupportWireguardComment "WiFi Fiti support:"]] != "nil") do={',
      '    :do { /interface wireguard disable $fitiSupportWireguard } on-error={',
      '      :set fitiSupportCleanupOk false',
      '      :log warning "fiti support: could not disable the managed interface"',
      '    }',
      '    :if ($fitiSupportCleanupOk) do={',
      '      :do { /interface wireguard remove $fitiSupportWireguard } on-error={',
      '        :set fitiSupportCleanupOk false',
      '        :log warning "fiti support: could not remove the managed interface"',
      '      }',
      '    }',
      '  } else={',
      '    :set fitiSupportCleanupOk false',
      '    :log warning "fiti support: interface name belongs to a non-WiFi-Fiti tunnel; leaving it untouched"',
      '  }',
      '}',
      `:if ($fitiSupportCleanupOk) do={ :global fitiSupportAck "${id}" } else={ :log warning "fiti support: cleanup incomplete; revoke will retry" }`,
    ].join('\n');
  }

  return null;
}

function buildRemoteSupportScript({ controls }) {
  const blocks = [];
  const emitted = [];
  const rejected = [];
  for (const control of controls || []) {
    const block = remoteSupportControlToScript(control);
    if (block) {
      blocks.push(block);
      emitted.push(control.id);
    } else {
      rejected.push(control && control.id);
    }
  }
  return { script: blocks.join('\n') + (blocks.length ? '\n' : ''), emitted, rejected };
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
      // A router replacement is allowed to have no record of an expired
      // account. RouterOS treats `set [find]` as an error; when that error
      // escapes :parse it prevents every later paid-user job in this poll
      // response from running. Check for an actual item before each action.
      `:if ([:len [/ip hotspot active find where user=$u]] > 0) do={ /ip hotspot active remove [find where user=$u] }\n` +
      `:if ([:len [/ip hotspot user find where name=$u]] > 0) do={ /ip hotspot user set [find where name=$u] disabled=yes }\n` +
      `:local tv ($u . "-tv")\n` +
      `:if ([:len [/ip hotspot active find where user=$tv]] > 0) do={ /ip hotspot active remove [find where user=$tv] }\n` +
      `:if ([:len [/ip hotspot user find where name=$tv]] > 0) do={ /ip hotspot user set [find where name=$tv] disabled=yes }`
    );
  }
  return blocks.join('\n');
}

module.exports = {
  buildScript, buildExpiryScript, jobToScript, rateProfileName, safe, safeSeconds,
  remoteSupportControlToScript, buildRemoteSupportScript,
};

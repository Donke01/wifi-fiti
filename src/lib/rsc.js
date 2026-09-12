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
  if (job.action === 'offboard-lockdown') {
    return [
      ':foreach fitiActive in=[/ip hotspot active find] do={ /ip hotspot active remove $fitiActive }',
      // RouterOS protects its built-in `default-trial` identity: attempting
      // to disable it aborts the whole job with "only limits and routes can
      // be changed". Exclude that system record while locking every other
      // HotSpot account, including all WiFi Fiti customer users.
      ':foreach fitiUser in=[/ip hotspot user find where name!="default-trial"] do={ /ip hotspot user disable $fitiUser }',
      ':foreach fitiServer in=[/ip hotspot find] do={ /ip hotspot disable $fitiServer }',
      ':foreach fitiNat in=[/ip firewall nat find where comment="WiFi Fiti hotspot NAT"] do={ /ip firewall nat disable $fitiNat }',
      ':log warning "WiFi Fiti offboarding: customer access locked; router reset will follow"',
    ].join('\n');
  }
  if (job.action === 'offboard-reset') {
    return ':delay 1s\n/system reset-configuration no-defaults=yes skip-backup=yes';
  }
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
  if (ip || username.endsWith('-tv') || job.action === 'transfer' || job.action === 'tv-upsert') {
    // RouterOS versions differ in how strictly they validate the optional
    // client identity. Keep one bad/stale IP from cancelling the entire
    // login: try the MAC and IP independently, then fall back to credentials
    // alone. Every attempt is best-effort and the provisioning above remains
    // authoritative.
    if (mac) lines.push(`:do { /ip hotspot active login user=$u password=$p mac-address=${mac} } on-error={}`);
    if (ip) lines.push(`:do { /ip hotspot active login user=$u password=$p ip=${ip} } on-error={}`);
    if (!mac && !ip) lines.push(':do { /ip hotspot active login user=$u password=$p } on-error={}');
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
 * from tenant HotSpot jobs.  They deliberately have a narrow, independently
 * validated input surface: a cloud worker may provide the WiFi Fiti gateway's
 * *public* key, endpoint and two management /32s, but never a private key,
 * arbitrary RouterOS source, a customer LAN route, or a default route.
 *
 * `prepare` creates the disabled key pair and reports only its public half.
 * The gateway creates the matching peer independently, then the server emits
 * `activate`.  This order matters: generating a replacement key during
 * activation would leave the gateway with a peer it can never authenticate.
 */

const SUPPORT_INTERFACE = 'fiti-support-wg';
const SUPPORT_VPN_PREFIX = 'WiFi Fiti VPN:';
const SUPPORT_LEGACY_PREFIX = 'WiFi Fiti support:';

function supportControlId(control) {
  const id = Number(control && control.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function supportPublicKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) return null;
  return Buffer.from(key, 'base64').length === 32 ? key : null;
}

function supportEndpointHost(value) {
  const host = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!host || host.length > 253 || host.includes('://') || host.includes(':')) return null;

  // A numeric public endpoint is useful while a DNS record propagates.  A
  // hostname must be a normal DNS name, not a URL, wildcard or shell value.
  const ipv4 = host.split('.');
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return host;
  if (!host.includes('.')) return null;
  return host.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ) ? host : null;
}

function supportEndpointPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function supportManagementAddress(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  // The WiFi Fiti gateway reserves 10.254.0.0/16 exclusively for remote
  // management. Keeping this check local means a cloud regression cannot
  // accidentally put the customer HotSpot subnet on the support interface.
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/32)?$/.exec(raw);
  if (!match) return null;
  const octets = match[1].split('.').map(Number);
  if (octets.some((octet) => octet > 255) || octets[0] !== 10 || octets[1] !== 254) return null;
  if (octets[3] === 0 || octets[3] === 255) return null;
  return `${octets.join('.')}/32`;
}

function supportConfigVersion(value) {
  const version = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return /^[A-Za-z0-9._-]{1,64}$/.test(version) ? version : null;
}

function activationControl(control) {
  const id = supportControlId(control);
  const gatewayPublicKey = supportPublicKey(control && control.gatewayPublicKey);
  const endpointHost = supportEndpointHost(control && control.endpointHost);
  const endpointPort = supportEndpointPort(control && control.endpointPort);
  const managementAddress = supportManagementAddress(control && control.managementAddress);
  const gatewayAddress = supportManagementAddress(control && control.gatewayAddress);
  const configVersion = supportConfigVersion(control && control.configVersion);
  if (!id || !gatewayPublicKey || !endpointHost || !endpointPort || !managementAddress || !gatewayAddress || !configVersion) return null;
  if (managementAddress === gatewayAddress) return null;
  return { id, gatewayPublicKey, endpointHost, endpointPort, managementAddress, gatewayAddress, configVersion };
}

/**
 * Configure the native RouterOS WireGuard client after the gateway has
 * already installed the router public key. All mutable resources are marked
 * with a specific WiFi Fiti comment, so a collision with a customer's own
 * interface/peer/address/route/firewall rule is a safe no-op and retries are
 * idempotent.
 *
 * The only route emitted is the gateway's own /32.  Customer LAN prefixes
 * and 0.0.0.0/0 are rejected structurally: neither can enter the command
 * language nor the peer allowed-address list.
 */
function remoteSupportActivateToScript(control) {
  const activation = activationControl(control);
  if (!activation) return null;
  const {
    id, gatewayPublicKey, endpointHost, endpointPort,
    managementAddress, gatewayAddress, configVersion,
  } = activation;

  return [
    ':global fitiSupportEnabled',
    ':global fitiSupportInterface',
    `:if ([:len $fitiSupportInterface] = 0) do={ :set fitiSupportInterface "${SUPPORT_INTERFACE}" }`,
    `:local fitiSupportGatewayKey "${gatewayPublicKey}"`,
    `:local fitiSupportEndpoint "${endpointHost}"`,
    `:local fitiSupportEndpointPort ${endpointPort}`,
    `:local fitiSupportAddress "${managementAddress}"`,
    `:local fitiSupportGateway "${gatewayAddress}"`,
    `:local fitiSupportVersion "${configVersion}"`,
    `:local fitiSupportInterfaceTag "${SUPPORT_VPN_PREFIX} interface "`,
    `:local fitiSupportPeerTag "${SUPPORT_VPN_PREFIX} gateway peer "`,
    `:local fitiSupportAddressTag "${SUPPORT_VPN_PREFIX} management address "`,
    `:local fitiSupportRouteTag "${SUPPORT_VPN_PREFIX} gateway route "`,
    `:local fitiSupportFirewallTag "${SUPPORT_VPN_PREFIX} gateway input "`,
    ':local fitiSupportOk true',
    '',
    // Do not create an interface here. The key must be the exact public key
    // the gateway accepted during `prepare`; missing it needs a deliberate
    // re-enrollment, not a silently generated replacement identity.
    ':local fitiSupportWireguard [/interface wireguard find where name=$fitiSupportInterface]',
    ':if ([:len $fitiSupportWireguard] != 1) do={',
    '  :set fitiSupportOk false',
    '  :log warning "fiti support: activation needs the prepared WireGuard interface; re-enroll this router"',
    '} else={',
    '  :local fitiSupportWireguardComment [/interface wireguard get $fitiSupportWireguard comment]',
    `  :if (([:typeof [:find $fitiSupportWireguardComment "${SUPPORT_LEGACY_PREFIX}"]] != "nil") || ([:typeof [:find $fitiSupportWireguardComment "${SUPPORT_VPN_PREFIX}"]] != "nil")) do={`,
    '    :do { /interface wireguard set $fitiSupportWireguard comment=($fitiSupportInterfaceTag . $fitiSupportVersion) } on-error={',
    '      :set fitiSupportOk false',
    '      :log warning "fiti support: could not tag the prepared WireGuard interface"',
    '    }',
    '  } else={',
    '    :set fitiSupportOk false',
    '    :log warning "fiti support: fiti-support-wg belongs to a non-WiFi-Fiti tunnel; leaving it untouched"',
    '  }',
    '}',
    '',
    // The support interface may contain only WiFi Fiti's tagged gateway peer.
    // A user-created peer is never removed or reconfigured by this control.
    ':local fitiSupportPeer ""',
    ':local fitiSupportPeerCount 0',
    ':local fitiSupportPeerUnsafe false',
    ':if ($fitiSupportOk) do={',
    '  :foreach fitiSupportPeerItem in=[/interface wireguard peers find where interface=$fitiSupportInterface] do={',
    '    :local fitiSupportPeerComment [/interface wireguard peers get $fitiSupportPeerItem comment]',
    '    :if ([:typeof [:find $fitiSupportPeerComment $fitiSupportPeerTag]] != "nil") do={',
    '      :if ($fitiSupportPeerCount = 0) do={',
    '        :set fitiSupportPeer $fitiSupportPeerItem',
    '      } else={',
    '        :do { /interface wireguard peers remove $fitiSupportPeerItem } on-error={',
    '          :set fitiSupportOk false',
    '          :log warning "fiti support: could not remove a duplicate managed gateway peer"',
    '        }',
    '      }',
    '      :set fitiSupportPeerCount ($fitiSupportPeerCount + 1)',
    '    } else={',
    '      :set fitiSupportPeerUnsafe true',
    '    }',
    '  }',
    '  :if ($fitiSupportPeerUnsafe) do={',
    '    :set fitiSupportOk false',
    '    :log warning "fiti support: an unowned peer uses fiti-support-wg; leaving it untouched"',
    '  } else={',
    '    :if ($fitiSupportPeerCount = 0) do={',
    '      :do {',
    '        /interface wireguard peers add interface=$fitiSupportInterface public-key=$fitiSupportGatewayKey endpoint-address=$fitiSupportEndpoint endpoint-port=$fitiSupportEndpointPort allowed-address=$fitiSupportGateway persistent-keepalive=25s comment=($fitiSupportPeerTag . $fitiSupportVersion)',
    '        :set fitiSupportPeer [/interface wireguard peers find where interface=$fitiSupportInterface comment=($fitiSupportPeerTag . $fitiSupportVersion)]',
    '      } on-error={',
    '        :set fitiSupportOk false',
    '        :log warning "fiti support: could not add the managed gateway peer"',
    '      }',
    '    } else={',
    '      :do { /interface wireguard peers set $fitiSupportPeer public-key=$fitiSupportGatewayKey endpoint-address=$fitiSupportEndpoint endpoint-port=$fitiSupportEndpointPort allowed-address=$fitiSupportGateway persistent-keepalive=25s disabled=no comment=($fitiSupportPeerTag . $fitiSupportVersion) } on-error={',
    '        :set fitiSupportOk false',
    '        :log warning "fiti support: could not update the managed gateway peer"',
    '      }',
    '    }',
    '  }',
    '}',
    '',
    // A management /32 is placed only on the prepared interface. Check both
    // an address conflict and an unexpected address on that interface before
    // doing anything, so a local configuration is never overwritten.
    ':local fitiSupportAddressConflict false',
    ':if ($fitiSupportOk) do={',
    '  :foreach fitiSupportAddressCheck in=[/ip address find where address=$fitiSupportAddress] do={',
    '    :local fitiSupportAddressCheckComment [/ip address get $fitiSupportAddressCheck comment]',
    '    :local fitiSupportAddressCheckInterface [/ip address get $fitiSupportAddressCheck interface]',
    '    :if ($fitiSupportAddressCheckInterface != $fitiSupportInterface) do={',
    '      :set fitiSupportAddressConflict true',
    '    } else={',
    '      :if ([:typeof [:find $fitiSupportAddressCheckComment $fitiSupportAddressTag]] = "nil") do={ :set fitiSupportAddressConflict true }',
    '    }',
    '  }',
    '  :if ($fitiSupportAddressConflict) do={',
    '    :set fitiSupportOk false',
    '    :log warning "fiti support: management address is already owned by another router resource"',
    '  }',
    '}',
    ':local fitiSupportManagedAddress ""',
    ':local fitiSupportAddressUnsafe false',
    ':if ($fitiSupportOk) do={',
    '  :foreach fitiSupportAddressItem in=[/ip address find where comment~"^WiFi Fiti VPN: management address"] do={',
    '    :local fitiSupportAddressComment [/ip address get $fitiSupportAddressItem comment]',
    '    :local fitiSupportAddressInterface [/ip address get $fitiSupportAddressItem interface]',
    '    :if ($fitiSupportAddressInterface != $fitiSupportInterface) do={',
    '      :set fitiSupportAddressUnsafe true',
    '    } else={',
    '      :if ([:len $fitiSupportManagedAddress] = 0) do={',
    '        :set fitiSupportManagedAddress $fitiSupportAddressItem',
    '      } else={',
    '        :do { /ip address remove $fitiSupportAddressItem } on-error={',
    '          :set fitiSupportOk false',
    '          :log warning "fiti support: could not remove a duplicate managed address"',
    '        }',
    '      }',
    '    }',
    '  }',
    '  :foreach fitiSupportAddressItem in=[/ip address find where interface=$fitiSupportInterface] do={',
    '    :local fitiSupportAddressComment [/ip address get $fitiSupportAddressItem comment]',
    '    :if ([:typeof [:find $fitiSupportAddressComment $fitiSupportAddressTag]] = "nil") do={ :set fitiSupportAddressUnsafe true }',
    '  }',
    '  :if ($fitiSupportAddressUnsafe) do={',
    '    :set fitiSupportOk false',
    '    :log warning "fiti support: an unowned address uses fiti-support-wg; leaving it untouched"',
    '  } else={',
    '    :if ([:len $fitiSupportManagedAddress] = 0) do={',
    '      :do { /ip address add address=$fitiSupportAddress interface=$fitiSupportInterface comment=($fitiSupportAddressTag . $fitiSupportVersion) } on-error={',
    '        :set fitiSupportOk false',
    '        :log warning "fiti support: could not add the management address"',
    '      }',
    '    } else={',
    '      :do { /ip address set $fitiSupportManagedAddress address=$fitiSupportAddress interface=$fitiSupportInterface disabled=no comment=($fitiSupportAddressTag . $fitiSupportVersion) } on-error={',
    '        :set fitiSupportOk false',
    '        :log warning "fiti support: could not update the management address"',
    '      }',
    '    }',
    '  }',
    '}',
    '',
    // RouterOS does not infer routes from peer allowed-addresses. This is the
    // sole static route: the gateway /32 through the already-owned WG link.
    ':local fitiSupportRouteConflict false',
    ':if ($fitiSupportOk) do={',
    '  :foreach fitiSupportRouteCheck in=[/ip route find where dst-address=$fitiSupportGateway] do={',
    '    :local fitiSupportRouteCheckComment [/ip route get $fitiSupportRouteCheck comment]',
    '    :if ([:typeof [:find $fitiSupportRouteCheckComment $fitiSupportRouteTag]] = "nil") do={ :set fitiSupportRouteConflict true }',
    '  }',
    '  :if ($fitiSupportRouteConflict) do={',
    '    :set fitiSupportOk false',
    '    :log warning "fiti support: gateway route is already owned by another router resource"',
    '  }',
    '}',
    ':local fitiSupportManagedRoute ""',
    ':if ($fitiSupportOk) do={',
    '  :foreach fitiSupportRouteItem in=[/ip route find where comment~"^WiFi Fiti VPN: gateway route"] do={',
    '    :if ([:len $fitiSupportManagedRoute] = 0) do={',
    '      :set fitiSupportManagedRoute $fitiSupportRouteItem',
    '    } else={',
    '      :do { /ip route remove $fitiSupportRouteItem } on-error={',
    '        :set fitiSupportOk false',
    '        :log warning "fiti support: could not remove a duplicate managed gateway route"',
    '      }',
    '    }',
    '  }',
    '  :if ([:len $fitiSupportManagedRoute] = 0) do={',
    '    :do { /ip route add dst-address=$fitiSupportGateway gateway=$fitiSupportInterface distance=1 comment=($fitiSupportRouteTag . $fitiSupportVersion) } on-error={',
    '      :set fitiSupportOk false',
    '      :log warning "fiti support: could not add the gateway-only route"',
    '    }',
    '  } else={',
    '    :do { /ip route set $fitiSupportManagedRoute dst-address=$fitiSupportGateway gateway=$fitiSupportInterface distance=1 disabled=no comment=($fitiSupportRouteTag . $fitiSupportVersion) } on-error={',
    '      :set fitiSupportOk false',
    '      :log warning "fiti support: could not update the gateway-only route"',
    '    }',
    '  }',
    '}',
    '',
    // This lets only the gateway /32 access RouterOS through an authenticated
    // tunnel. We do not enable SSH, Winbox, API or any other public service.
    ':local fitiSupportManagedFirewall ""',
    ':if ($fitiSupportOk) do={',
    '  :foreach fitiSupportFirewallItem in=[/ip firewall filter find where comment~"^WiFi Fiti VPN: gateway input"] do={',
    '    :if ([:len $fitiSupportManagedFirewall] = 0) do={',
    '      :set fitiSupportManagedFirewall $fitiSupportFirewallItem',
    '    } else={',
    '      :do { /ip firewall filter remove $fitiSupportFirewallItem } on-error={',
    '        :set fitiSupportOk false',
    '        :log warning "fiti support: could not remove a duplicate managed firewall rule"',
    '      }',
    '    }',
    '  }',
    '  :if ([:len $fitiSupportManagedFirewall] = 0) do={',
    '    :do { /ip firewall filter add chain=input action=accept in-interface=$fitiSupportInterface src-address=$fitiSupportGateway comment=($fitiSupportFirewallTag . $fitiSupportVersion) place-before=0 } on-error={',
    '      :set fitiSupportOk false',
    '      :log warning "fiti support: could not add the authenticated gateway firewall rule"',
    '    }',
    '  } else={',
    '    :do { /ip firewall filter set $fitiSupportManagedFirewall chain=input action=accept in-interface=$fitiSupportInterface src-address=$fitiSupportGateway disabled=no comment=($fitiSupportFirewallTag . $fitiSupportVersion) } on-error={',
    '      :set fitiSupportOk false',
    '      :log warning "fiti support: could not update the authenticated gateway firewall rule"',
    '    }',
    '    :if ($fitiSupportOk) do={ :do { /ip firewall filter move $fitiSupportManagedFirewall destination=0 } on-error={ :set fitiSupportOk false; :log warning "fiti support: could not place the authenticated gateway firewall rule first" } }',
    '  }',
    '}',
    '',
    ':if ($fitiSupportOk) do={',
    '  :do { /interface wireguard enable $fitiSupportWireguard } on-error={',
    '    :set fitiSupportOk false',
    '    :log warning "fiti support: WireGuard configuration is ready but the interface could not be enabled"',
    '  }',
    '}',
    `:if ($fitiSupportOk) do={ :global fitiSupportEnabled "active"; :global fitiSupportAck "${id}"; :log info ("fiti support: WireGuard gateway configuration " . $fitiSupportVersion . " is active") } else={ :log warning "fiti support: gateway activation incomplete; it will retry" }`,
  ].join('\n');
}
function remoteSupportControlToScript(control) {
  const id = supportControlId(control);
  if (!id) return null;

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

  if (control.action === 'activate') {
    return remoteSupportActivateToScript(control);
  }

  if (control.action === 'revoke') {
    return [
      ':global fitiSupportEnabled "no"',
      ':global fitiSupportInterface',
      `:if ([:len $fitiSupportInterface] = 0) do={ :set fitiSupportInterface "${SUPPORT_INTERFACE}" }`,
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
      // These are the only rules WiFi Fiti inserts into the input chain. A
      // rule whose comment has been copied onto another interface is left
      // alone and keeps the revoke retry pending for an operator to inspect.
      ':foreach fitiSupportFirewall in=[/ip firewall filter find where comment~"^WiFi Fiti VPN: gateway input"] do={',
      '  :local fitiSupportFirewallInterface [/ip firewall filter get $fitiSupportFirewall in-interface]',
      '  :if ($fitiSupportFirewallInterface = $fitiSupportInterface) do={',
      '    :do { /ip firewall filter remove $fitiSupportFirewall } on-error={',
      '      :set fitiSupportCleanupOk false',
      '      :log warning "fiti support: could not remove the managed gateway firewall rule"',
      '    }',
      '  } else={',
      '    :set fitiSupportCleanupOk false',
      '    :log warning "fiti support: a tagged firewall rule belongs to another interface; leaving it untouched"',
      '  }',
      '}',
      ':foreach fitiSupportRoute in=[/ip route find where comment~"^WiFi Fiti VPN: gateway route"] do={',
      '  :local fitiSupportRouteGateway [/ip route get $fitiSupportRoute gateway]',
      '  :if ($fitiSupportRouteGateway = $fitiSupportInterface) do={',
      '    :do { /ip route remove $fitiSupportRoute } on-error={',
      '      :set fitiSupportCleanupOk false',
      '      :log warning "fiti support: could not remove the managed gateway-only route"',
      '    }',
      '  } else={',
      '    :set fitiSupportCleanupOk false',
      '    :log warning "fiti support: a tagged route uses another gateway; leaving it untouched"',
      '  }',
      '}',
      ':foreach fitiSupportAddress in=[/ip address find where comment~"^WiFi Fiti VPN: management address"] do={',
      '  :local fitiSupportAddressInterface [/ip address get $fitiSupportAddress interface]',
      '  :if ($fitiSupportAddressInterface = $fitiSupportInterface) do={',
      '    :do { /ip address remove $fitiSupportAddress } on-error={',
      '      :set fitiSupportCleanupOk false',
      '      :log warning "fiti support: could not remove the management address"',
      '    }',
      '  } else={',
      '    :set fitiSupportCleanupOk false',
      '    :log warning "fiti support: a tagged address belongs to another interface; leaving it untouched"',
      '  }',
      '}',
      ':local fitiSupportWireguards [/interface wireguard find where name=$fitiSupportInterface]',
      ':if ([:len $fitiSupportWireguards] > 1) do={',
      '  :set fitiSupportCleanupOk false',
      '  :log warning "fiti support: multiple interfaces use the managed name; leaving them untouched"',
      '} else={',
      '  :foreach fitiSupportWireguard in=$fitiSupportWireguards do={',
      '    :local fitiSupportWireguardComment [/interface wireguard get $fitiSupportWireguard comment]',
      `    :if (([:typeof [:find $fitiSupportWireguardComment "${SUPPORT_LEGACY_PREFIX}"]] != "nil") || ([:typeof [:find $fitiSupportWireguardComment "${SUPPORT_VPN_PREFIX}"]] != "nil")) do={`,
      '      :local fitiSupportPeerUnsafe false',
      '      :foreach fitiSupportPeer in=[/interface wireguard peers find where interface=$fitiSupportInterface] do={',
      '        :local fitiSupportPeerComment [/interface wireguard peers get $fitiSupportPeer comment]',
      `        :if ([:typeof [:find $fitiSupportPeerComment "${SUPPORT_VPN_PREFIX} gateway peer "]] != "nil") do={`,
      '          :do { /interface wireguard peers remove $fitiSupportPeer } on-error={',
      '            :set fitiSupportCleanupOk false',
      '            :log warning "fiti support: could not remove the managed gateway peer"',
      '          }',
      '        } else={',
      '          :set fitiSupportPeerUnsafe true',
      '        }',
      '      }',
      '      :if ($fitiSupportPeerUnsafe) do={',
      '        :set fitiSupportCleanupOk false',
      '        :log warning "fiti support: an unowned peer uses fiti-support-wg; leaving the interface untouched"',
      '      } else={',
      '        :do { /interface wireguard disable $fitiSupportWireguard } on-error={',
      '      :set fitiSupportCleanupOk false',
      '      :log warning "fiti support: could not disable the managed interface"',
      '        }',
      '        :do { /interface wireguard remove $fitiSupportWireguard } on-error={',
      '        :set fitiSupportCleanupOk false',
      '        :log warning "fiti support: could not remove the managed interface"',
      '      }',
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

/*
 * A mapped deployment is deliberately much narrower than a generic remote
 * command facility.  The cloud never accepts RouterOS source from a browser
 * (or from the VPN gateway).  It can emit exactly one reviewed action:
 * verify the owner-confirmed map against the live router, then apply the
 * corresponding WiFi Fiti service selectors.
 *
 * The action uses the already-installed `fitiSupportAck` transport because
 * every paired poller knows how to return it on the following authenticated
 * HTTPS poll.  Its value is namespaced (`deploy.<id>.<receipt>`) so it cannot
 * acknowledge a WireGuard lifecycle control by accident.  The receipt is a
 * server-generated capability; the server verifies its HMAC before marking
 * the deployment acknowledged.
 *
 * There are intentionally no commands here for RouterOS administrator
 * credentials, WAN/default routes, IP addresses, DHCP, NAT, bridge
 * membership, Wi-Fi settings, general firewall policy, Hotspot construction,
 * or service exposure.  The narrow exception is an explicitly tagged
 * postrouting TTL mangle rule: it is WiFi Fiti's existing anti-tethering
 * service resource, is checked structurally before it is touched, and cannot
 * affect routing or inbound management.
 */
const MAPPED_DEPLOYMENT_ACTION = 'apply_mapped_service_v1';
const MAPPED_DEPLOYMENT_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAPPED_DEPLOYMENT_RECEIPT = /^[A-Za-z0-9_-]{32,64}$/;
const MAPPED_DEPLOYMENT_SIGNATURE = /^[a-f0-9]{64}$/;
const MAPPED_DEPLOYMENT_TTL_TAG = 'WiFi Fiti anti-tethering';
const MAPPED_DEPLOYMENT_PORTAL_TAG = 'WiFi Fiti customer portal';
const MAPPED_DEPLOYMENT_POLLER_NAME = 'fiti-poll';
const MAPPED_DEPLOYMENT_POLLER_COMMENT = 'WiFi Fiti: sync usage, ack jobs, collect work';

function mappedDeploymentName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return MAPPED_DEPLOYMENT_TOKEN.test(name) ? name : null;
}

function mappedDeploymentNames(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const names = value.map(mappedDeploymentName);
  if (names.some((name) => !name) || new Set(names).size !== names.length) return null;
  return names;
}

function mappedDeploymentControl(control) {
  const id = supportControlId(control);
  if (!id || control?.action !== MAPPED_DEPLOYMENT_ACTION) return null;
  const receipt = typeof control.receipt === 'string' ? control.receipt : '';
  const signature = typeof control.signature === 'string' ? control.signature : '';
  const mapping = control?.mapping;
  const hotspotServer = mappedDeploymentName(control?.hotspotServer);
  const topologyFingerprint = typeof control?.topologyFingerprint === 'string' ? control.topologyFingerprint : '';
  if (!MAPPED_DEPLOYMENT_RECEIPT.test(receipt) || !MAPPED_DEPLOYMENT_SIGNATURE.test(signature) ||
      !/^[a-f0-9]{64}$/.test(topologyFingerprint) || !mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
      Number(mapping.version) !== 1 || !hotspotServer) return null;

  const wanInterface = mappedDeploymentName(mapping.wanInterface);
  const customerBridge = mappedDeploymentName(mapping.customerBridge);
  const wifiInterfaces = mappedDeploymentNames(mapping.wifiInterfaces, 8);
  const customerPorts = mappedDeploymentNames(mapping.customerPorts, 32);
  if (!wanInterface || !customerBridge || !wifiInterfaces || !customerPorts ||
      wifiInterfaces.includes(wanInterface) || customerPorts.includes(wanInterface)) return null;

  // Do not put the HMAC in a RouterOS log or a mutable router-global. The
  // server verifies it before rendering this independently validated control;
  // the one-time receipt is sufficient for the return acknowledgement.
  const lines = [
    ':global fitiSupportAck',
    ':global fitiBridge',
    ':global fitiHotspotServer',
    ':global fitiPortalHost',
    ':global fitiPortalAppliedHost',
    ':local fitiMappedDeploymentOk true',
    ':local fitiMappedDeploymentMapOk true',
    `:local fitiMappedDeploymentWan "${wanInterface}"`,
    `:local fitiMappedDeploymentBridge "${customerBridge}"`,
    `:local fitiMappedDeploymentHotspot "${hotspotServer}"`,
    `:local fitiMappedDeploymentTtlTag "${MAPPED_DEPLOYMENT_TTL_TAG}"`,
    `:local fitiMappedDeploymentPortalTag "${MAPPED_DEPLOYMENT_PORTAL_TAG}"`,
    `:local fitiMappedDeploymentPollName "${MAPPED_DEPLOYMENT_POLLER_NAME}"`,
    `:local fitiMappedDeploymentPollComment "${MAPPED_DEPLOYMENT_POLLER_COMMENT}"`,
    '',
    // Validate rather than rearrange hardware. A changed board or a local
    // edit is a safe no-op and remains visible in the dashboard as pending.
    ':if ([:len [/interface ethernet find where name=$fitiMappedDeploymentWan]] != 1) do={',
    '  :set fitiMappedDeploymentOk false',
    '  :log warning "fiti deploy: confirmed WAN interface is no longer available; map must be reviewed"',
    '}',
    ':if ([:len [/interface bridge find where name=$fitiMappedDeploymentBridge]] != 1) do={',
    '  :set fitiMappedDeploymentOk false',
    '  :log warning "fiti deploy: confirmed customer bridge is no longer available; map must be reviewed"',
    '}',
    ':if ([:len [/ip hotspot find where name=$fitiMappedDeploymentHotspot]] != 1) do={',
    '  :set fitiMappedDeploymentOk false',
    '  :log warning "fiti deploy: detected Hotspot server is no longer available; no change was made"',
    '} else={',
    '  :local fitiMappedDeploymentHotspotBridge [/ip hotspot get [find where name=$fitiMappedDeploymentHotspot] interface]',
    '  :if ($fitiMappedDeploymentHotspotBridge != $fitiMappedDeploymentBridge) do={',
    '    :set fitiMappedDeploymentOk false',
    '    :log warning "fiti deploy: Hotspot is not on the confirmed customer bridge; no change was made"',
    '  }',
    '}',
    ':if ([:len [/interface bridge port find where bridge=$fitiMappedDeploymentBridge interface=$fitiMappedDeploymentWan]] != 0) do={',
    '  :set fitiMappedDeploymentOk false',
    '  :log warning "fiti deploy: confirmed WAN is now a customer-bridge member; no change was made"',
    '}',
  ];

  for (const port of customerPorts) {
    lines.push(
      `:if ([:len [/interface ethernet find where name="${port}"]] != 1 || [:len [/interface bridge port find where bridge=$fitiMappedDeploymentBridge interface="${port}"]] != 1) do={`,
      '  :set fitiMappedDeploymentOk false',
      '  :log warning "fiti deploy: a confirmed customer Ethernet port changed; no change was made"',
      '}'
    );
  }
  for (const wifi of wifiInterfaces) {
    lines.push(
      `:if ([:len [/interface find where name="${wifi}"]] != 1 || [:len [/interface bridge port find where bridge=$fitiMappedDeploymentBridge interface="${wifi}"]] != 1) do={`,
      '  :set fitiMappedDeploymentOk false',
      '  :log warning "fiti deploy: a confirmed Wi-Fi interface changed; no change was made"',
      '}'
    );
  }

  lines.push(
    '',
    // Before changing any service resource, prove it is either absent or
    // recognisably WiFi Fiti-owned. This makes a copied comment/name a safe
    // failure rather than permission to overwrite an operator's scheduler or
    // rule. Paid jobs retain their selected profiles: inventing a new profile
    // here would be cosmetic because it would not govern those jobs.
    ':if ($fitiMappedDeploymentOk = false) do={ :set fitiMappedDeploymentMapOk false }',
    '',
    ':local fitiMappedDeploymentTtlRule ""',
    ':local fitiMappedDeploymentTtlRuleCount 0',
    ':local fitiMappedDeploymentTtlUnsafe false',
    ':foreach fitiMappedDeploymentTtlCheck in=[/ip firewall mangle find where comment=$fitiMappedDeploymentTtlTag] do={',
    '  :local fitiMappedDeploymentTtlChain [/ip firewall mangle get $fitiMappedDeploymentTtlCheck chain]',
    '  :local fitiMappedDeploymentTtlInterface [/ip firewall mangle get $fitiMappedDeploymentTtlCheck out-interface]',
    '  :local fitiMappedDeploymentTtlAction [/ip firewall mangle get $fitiMappedDeploymentTtlCheck action]',
    '  :local fitiMappedDeploymentTtlValue [/ip firewall mangle get $fitiMappedDeploymentTtlCheck new-ttl]',
    '  :local fitiMappedDeploymentTtlPass [/ip firewall mangle get $fitiMappedDeploymentTtlCheck passthrough]',
    '  :if (($fitiMappedDeploymentTtlChain = "postrouting") && ($fitiMappedDeploymentTtlInterface = $fitiMappedDeploymentBridge) && ($fitiMappedDeploymentTtlAction = "change-ttl") && ($fitiMappedDeploymentTtlValue = "set:1") && ($fitiMappedDeploymentTtlPass = true)) do={',
    '    :if ($fitiMappedDeploymentTtlRuleCount = 0) do={ :set fitiMappedDeploymentTtlRule $fitiMappedDeploymentTtlCheck }',
    '    :set fitiMappedDeploymentTtlRuleCount ($fitiMappedDeploymentTtlRuleCount + 1)',
    '  } else={',
    '    :set fitiMappedDeploymentTtlUnsafe true',
    '  }',
    '}',
    ':if ($fitiMappedDeploymentTtlUnsafe) do={',
    '  :set fitiMappedDeploymentOk false',
    '  :log warning "fiti deploy: anti-tethering tag belongs to a different rule; no change was made"',
    '}',
    // The scheduler is enabled only when both its script and its durable
    // scheduler marker match the current WiFi Fiti agent. We deliberately do
    // not create or rewrite a scheduler remotely.
    ':local fitiMappedDeploymentPollScript ""',
    ':local fitiMappedDeploymentPollScriptCount 0',
    ':foreach fitiMappedDeploymentPollScriptCheck in=[/system script find where name=$fitiMappedDeploymentPollName] do={',
    '  :set fitiMappedDeploymentPollScript $fitiMappedDeploymentPollScriptCheck',
    '  :set fitiMappedDeploymentPollScriptCount ($fitiMappedDeploymentPollScriptCount + 1)',
    '}',
    ':local fitiMappedDeploymentPollScheduler ""',
    ':local fitiMappedDeploymentPollSchedulerCount 0',
    ':foreach fitiMappedDeploymentPollSchedulerCheck in=[/system scheduler find where name=$fitiMappedDeploymentPollName] do={',
    '  :set fitiMappedDeploymentPollScheduler $fitiMappedDeploymentPollSchedulerCheck',
    '  :set fitiMappedDeploymentPollSchedulerCount ($fitiMappedDeploymentPollSchedulerCount + 1)',
    '}',
    ':if (($fitiMappedDeploymentPollScriptCount != 1) || ($fitiMappedDeploymentPollSchedulerCount != 1)) do={',
    '  :set fitiMappedDeploymentOk false',
    '  :log warning "fiti deploy: WiFi Fiti polling agent is incomplete; no scheduler was changed"',
    '} else={',
    '  :local fitiMappedDeploymentPollSource [/system script get $fitiMappedDeploymentPollScript source]',
    '  :local fitiMappedDeploymentPollSchedulerComment [/system scheduler get $fitiMappedDeploymentPollScheduler comment]',
    '  :local fitiMappedDeploymentPollEvent [/system scheduler get $fitiMappedDeploymentPollScheduler on-event]',
    '  :if (([:typeof [:find $fitiMappedDeploymentPollSource "X-WiFi-Fiti-Router: "]] = "nil") || ([:typeof [:find $fitiMappedDeploymentPollSource "fiti: token missing, not polling"]] = "nil") || ($fitiMappedDeploymentPollSchedulerComment != $fitiMappedDeploymentPollComment) || ($fitiMappedDeploymentPollEvent != "/system script run fiti-poll")) do={',
    '    :set fitiMappedDeploymentOk false',
    '    :log warning "fiti deploy: fiti-poll is not the recognised WiFi Fiti agent; no scheduler was changed"',
    '  }',
    '}',
    // The hostname remains local state supplied by the paired installer, not
    // a browser or deployment payload. Allow only an ordinary hostname before
    // it can become a walled-garden destination.
    ':local fitiMappedDeploymentPortalHost $fitiPortalHost',
    ':local fitiMappedDeploymentPortalHostOk true',
    ':if ([:len $fitiMappedDeploymentPortalHost] > 0) do={',
    '  :if (([:len $fitiMappedDeploymentPortalHost] > 253) || ([:typeof [:find $fitiMappedDeploymentPortalHost "."]] = "nil") || ([:pick $fitiMappedDeploymentPortalHost 0 1] = ".") || ([:pick $fitiMappedDeploymentPortalHost ([:len $fitiMappedDeploymentPortalHost] - 1) [:len $fitiMappedDeploymentPortalHost]] = ".")) do={ :set fitiMappedDeploymentPortalHostOk false }',
    '  :local fitiMappedDeploymentPortalOffset 0',
    '  :while ($fitiMappedDeploymentPortalOffset < [:len $fitiMappedDeploymentPortalHost]) do={',
    '    :local fitiMappedDeploymentPortalCharacter [:pick $fitiMappedDeploymentPortalHost $fitiMappedDeploymentPortalOffset ($fitiMappedDeploymentPortalOffset + 1)]',
    '    :if ([:typeof [:find "abcdefghijklmnopqrstuvwxyz0123456789.-" $fitiMappedDeploymentPortalCharacter]] = "nil") do={ :set fitiMappedDeploymentPortalHostOk false }',
    '    :set fitiMappedDeploymentPortalOffset ($fitiMappedDeploymentPortalOffset + 1)',
    '  }',
    '}',
    ':if ($fitiMappedDeploymentPortalHostOk = false) do={',
    '  :set fitiMappedDeploymentOk false',
    '  :log warning "fiti deploy: stored customer portal host is invalid; no portal change was made"',
    '}',
    '',
    // All checks passed. From here on, every mutable resource is scoped by a
    // fixed WiFi Fiti name/comment and errors leave the acknowledgement
    // pending for a safe retry.
    ':if ($fitiMappedDeploymentOk) do={',
    '  :if ($fitiMappedDeploymentTtlRuleCount = 0) do={',
    '    :do { /ip firewall mangle add chain=postrouting out-interface=$fitiMappedDeploymentBridge action=change-ttl new-ttl=set:1 passthrough=yes comment=$fitiMappedDeploymentTtlTag } on-error={',
    '      :set fitiMappedDeploymentOk false',
    '      :log warning "fiti deploy: could not create the WiFi Fiti anti-tethering rule"',
    '    }',
    '  } else={',
    '    :do { /ip firewall mangle set $fitiMappedDeploymentTtlRule disabled=no passthrough=yes } on-error={',
    '      :set fitiMappedDeploymentOk false',
    '      :log warning "fiti deploy: could not enable the WiFi Fiti anti-tethering rule"',
    '    }',
    '    :if ($fitiMappedDeploymentOk && $fitiMappedDeploymentTtlRuleCount > 1) do={',
    '      :foreach fitiMappedDeploymentTtlDuplicate in=[/ip firewall mangle find where comment=$fitiMappedDeploymentTtlTag] do={',
    '        :if ($fitiMappedDeploymentTtlDuplicate != $fitiMappedDeploymentTtlRule) do={',
    '          :do { /ip firewall mangle remove $fitiMappedDeploymentTtlDuplicate } on-error={',
    '            :set fitiMappedDeploymentOk false',
    '            :log warning "fiti deploy: could not remove a duplicate WiFi Fiti anti-tethering rule"',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
    ':if ($fitiMappedDeploymentOk && [:len $fitiMappedDeploymentPortalHost] > 0) do={',
    '  :if ([:len [/ip hotspot walled-garden find where dst-host=$fitiMappedDeploymentPortalHost]] = 0) do={',
    '    :do { /ip hotspot walled-garden add dst-host=$fitiMappedDeploymentPortalHost comment=$fitiMappedDeploymentPortalTag } on-error={',
    '      :set fitiMappedDeploymentOk false',
    '      :log warning "fiti deploy: could not add the WiFi Fiti customer portal walled-garden entry"',
    '    }',
    '  }',
    '}',
    ':if ($fitiMappedDeploymentOk) do={',
    '  :do { /system scheduler enable $fitiMappedDeploymentPollScheduler } on-error={',
    '    :set fitiMappedDeploymentOk false',
    '    :log warning "fiti deploy: could not enable the recognised WiFi Fiti poller"',
    '  }',
    '}',
    // These globals are WiFi Fiti-owned selectors consumed by the installed
    // outbound poller. Clearing only the applied marker prompts the existing
    // server-side portal refresher on the next normal poll; it does not fetch
    // arbitrary code or rewrite a boot script here.
    ':if ($fitiMappedDeploymentOk) do={',
    '  :set fitiBridge $fitiMappedDeploymentBridge',
    '  :set fitiHotspotServer $fitiMappedDeploymentHotspot',
    '  :if ([:len $fitiMappedDeploymentPortalHost] > 0) do={ :set fitiPortalAppliedHost "" }',
    `  :global fitiSupportAck "deploy.${id}.${receipt}"`,
    `  :log info "fiti deploy: verified mapped service action ${id} applied and WiFi Fiti service resources reconciled"`,
    '} else={',
    '  :if ($fitiMappedDeploymentMapOk = false) do={',
    // Report a finite map mismatch through the existing acknowledgement
    // transport. Railway marks only this outcome stale and asks the owner to
    // reconfirm. A service-resource error deliberately leaves no ACK below.
    `    :global fitiSupportAck "deploy.${id}.${receipt}.blocked"`,
    '    :log warning "fiti deploy: confirmed map no longer matches this router; it will not be acknowledged"',
    '  } else={',
    '    :log warning "fiti deploy: WiFi Fiti service reconciliation did not complete; it will retry without changing the confirmed map"',
    '  }',
    '}'
  );
  return lines.join('\n');
}

function buildMappedDeploymentScript({ control } = {}) {
  const script = mappedDeploymentControl(control);
  return script
    ? { script: script + '\n', emitted: [control.id], rejected: [] }
    : { script: '', emitted: [], rejected: control ? [control.id] : [] };
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
  MAPPED_DEPLOYMENT_ACTION, mappedDeploymentControl, buildMappedDeploymentScript,
};

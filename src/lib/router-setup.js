'use strict';

/*
 * Router setup kits are intentionally generated on the server.  A kit
 * contains a one-time router credential, so keeping validation and RouterOS
 * quoting here prevents a browser field from becoming RouterOS source.
 *
 * There are two deliberately different paths:
 *
 *   existing — preserve WAN, Wi-Fi, DHCP and Hotspot settings; only pair
 *              WiFi Fiti after verifying the selected bridge and Hotspot.
 *   new      — a known RouterOS 7 template for a router that was reset with
 *              no default configuration.  It never resets a router itself.
 */

const IDENTIFIER = /^[A-Za-z0-9_-]{1,32}$/;
const SAFE_DISPLAY = /^[A-Za-z0-9 ._\-@!#%&()+,/:]{1,80}$/;
const SAFE_SECRET = /^[A-Za-z0-9!#%&*+,.@_\-]{1,63}$/;

const MODEL_PROFILES = Object.freeze({
  'hap-lite': {
    label: 'hAP lite / RB941',
    radio: 'wireless',
    wifiInterface: 'wlan1',
    customerPorts: ['ether2', 'ether3', 'ether4'],
    bridge: 'bridge-hs',
  },
  rb951ui: {
    label: 'RB951Ui',
    radio: 'wireless',
    wifiInterface: 'wlan1',
    customerPorts: ['ether2', 'ether3', 'ether4', 'ether5'],
    bridge: 'bridge-hs',
  },
  'legacy-wireless': {
    label: 'Other RouterOS 7 legacy-wireless router',
    radio: 'wireless',
    wifiInterface: 'wlan1',
    customerPorts: ['ether2', 'ether3', 'ether4', 'ether5'],
    bridge: 'bridge-hs',
  },
  'modern-wifi': {
    label: 'RouterOS 7 modern WiFi router',
    radio: 'wifi',
    wifiInterface: 'wifi1',
    customerPorts: ['ether2', 'ether3', 'ether4', 'ether5'],
    bridge: 'bridge-hs',
  },
});

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function text(value, label, max = 80, required = false) {
  const out = String(value || '').trim();
  if (!out && required) throw invalid(`Enter ${label}.`);
  if (out.length > max || (out && !SAFE_DISPLAY.test(out))) {
    throw invalid(`${label} contains unsupported characters.`);
  }
  return out;
}

function identifier(value, label, fallback) {
  const out = String(value || fallback || '').trim();
  if (!IDENTIFIER.test(out)) throw invalid(`Enter a valid ${label}. Use letters, numbers, hyphens, or underscores only.`);
  return out;
}

function routerString(value, label, min, max) {
  const out = String(value || '').trim();
  if (out.length < min || out.length > max || !SAFE_SECRET.test(out)) {
    throw invalid(`${label} must be ${min}-${max} characters and cannot contain spaces, quotes, dollar signs, or line breaks.`);
  }
  return out;
}

function parsePorts(value, fallback) {
  const raw = String(value || '').trim();
  const parts = (raw ? raw.split(',') : fallback || []).map((item) => identifier(item, 'customer interface'));
  const unique = [...new Set(parts)];
  if (!unique.length || unique.length > 8) throw invalid('Enter one to eight customer LAN interfaces, separated by commas.');
  return unique;
}

function ipv4(value, label) {
  const raw = String(value || '').trim();
  const bits = raw.split('.');
  if (bits.length !== 4 || bits.some((bit) => !/^\d{1,3}$/.test(bit) || Number(bit) > 255)) {
    throw invalid(`Enter a valid ${label}.`);
  }
  return bits.map(Number);
}

function ipv4Number(address) {
  return address.reduce((total, octet) => total * 256 + octet, 0);
}

function cidrRange(address, prefix) {
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipv4Number(address) / size) * size;
  return { start, end: start + size - 1 };
}

function isPrivate(address) {
  return address[0] === 10 ||
    (address[0] === 172 && address[1] >= 16 && address[1] <= 31) ||
    (address[0] === 192 && address[1] === 168);
}

function customerNetwork(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.+)\/24$/);
  if (!match) throw invalid('Customer subnet must be a private /24 network, for example 10.5.50.0/24.');
  const address = ipv4(match[1], 'customer subnet');
  if (!isPrivate(address) || address[3] !== 0) {
    throw invalid('Customer subnet must be a private /24 network ending in .0.');
  }
  const prefix = address.slice(0, 3).join('.');
  return { cidr: `${prefix}.0/24`, gateway: `${prefix}.1`, pool: `${prefix}.10-${prefix}.250` };
}

function staticWan(value, gateway, dnsServers, customerNetwork) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.+)\/(8|9|1\d|2\d|30)$/);
  if (!match) throw invalid('Enter a valid static WAN address with its prefix, for example 192.168.1.2/24.');
  const address = ipv4(match[1], 'static WAN address');
  const nextHop = ipv4(gateway, 'static WAN gateway');
  if (address.join('.') === nextHop.join('.')) throw invalid('The static WAN address and gateway must be different.');
  const prefix = Number(match[2]);
  const wanRange = cidrRange(address, prefix);
  const addressNumber = ipv4Number(address);
  const gatewayNumber = ipv4Number(nextHop);
  if (addressNumber === wanRange.start || addressNumber === wanRange.end || gatewayNumber === wanRange.start || gatewayNumber === wanRange.end) {
    throw invalid('The static WAN address and gateway must be usable host addresses.');
  }
  if (gatewayNumber < wanRange.start || gatewayNumber > wanRange.end) {
    throw invalid('The static WAN gateway must be inside the static WAN subnet.');
  }
  const customer = cidrRange(ipv4(customerNetwork.cidr.replace('/24', ''), 'customer subnet'), 24);
  if (wanRange.start <= customer.end && customer.start <= wanRange.end) {
    throw invalid('The static WAN subnet cannot overlap the customer Hotspot subnet.');
  }
  const dns = String(dnsServers || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!dns.length || dns.length > 3) throw invalid('Enter one to three DNS servers, separated by commas.');
  dns.forEach((server) => ipv4(server, 'DNS server'));
  return { address: `${address.join('.')}/${match[2]}`, gateway: nextHop.join('.'), dns: dns.join(',') };
}

function ros(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function fetchTlsOption(url) {
  return new URL(url).protocol === 'https:' ? ' check-certificate=yes' : '';
}

// RouterOS terminal paste executes each top-level line as its own command.
// Keep the generated kit inside one :do block so :local values survive the
// paste and the first preflight error stops the rest of the installer. This
// is also valid when the same text is imported from an .rsc file.
function wrapRouterScript(lines) {
  return [
    ':do {',
    ...lines.map((line) => line ? `  ${line}` : line),
    '} on-error={',
    '  :log warning "WiFi Fiti setup stopped. Fix the displayed error, then generate a fresh kit."',
    '}',
  ].join('\n') + '\n';
}

function setupPrefix({ location, token, appUrl, portalUrl, config }) {
  const origin = new URL(appUrl).origin;
  const host = new URL(origin).hostname;
  const portalOrigin = new URL(portalUrl || appUrl).origin;
  const portalHost = new URL(portalOrigin).hostname;
  return [
    ':global fitiUrl ' + ros(origin),
    ':global fitiPortalUrl ' + ros(portalOrigin),
    ':global fitiPortalHost ' + ros(portalHost),
    ':global fitiPortalAppliedHost ""',
    ':global fitiSite ' + ros(location.id),
    ':global fitiToken ' + ros(token),
    ':global fitiSetupAck ""',
    ':global fitiSetupProtocol "2"',
    ':global fitiBridge ' + ros(config.customerBridge),
    ':global fitiHotspotServer ' + ros(config.hotspotServer),
    // Remote support is intentionally dormant in every generated kit. The
    // router-side helper can create a *disabled* native WireGuard interface
    // and report only its public key once an owner-consent job turns this on.
    // No gateway endpoint, peer, route or firewall rule is generated here.
    ':global fitiSupportEnabled "no"',
    ':global fitiSupportEnrollUrl ' + ros(origin + '/api/router/support-enroll'),
    ':global fitiSupportInterface "fiti-support-wg"',
    ':local fitiHost ' + ros(host),
  ];
}

function pairingSuffix({ appUrl, portalUrl, location, token, config }) {
  const origin = new URL(appUrl).origin;
  const host = new URL(origin).hostname;
  const portalOrigin = new URL(portalUrl || appUrl).origin;
  const portalHost = new URL(portalOrigin).hostname;
  const bootstrap = [
    ':global fitiUrl ' + ros(origin),
    ':global fitiPortalUrl ' + ros(portalOrigin),
    ':global fitiPortalHost ' + ros(portalHost),
    ':global fitiPortalAppliedHost ""',
    ':global fitiSite ' + ros(location.id),
    ':global fitiToken ' + ros(token),
    ':global fitiSetupAck ""',
    ':global fitiSetupProtocol "2"',
    ':global fitiBridge ' + ros(config.customerBridge),
    ':global fitiHotspotServer ' + ros(config.hotspotServer),
    ':local fitiHost ' + ros(host),
    ':local fitiPortalHost ' + ros(portalHost),
    ':if ([:len [/ip hotspot walled-garden find where dst-host=$fitiHost]] = 0) do={ /ip hotspot walled-garden add dst-host=$fitiHost comment="WiFi Fiti cloud API" }',
    ':if ($fitiPortalHost != $fitiHost) do={ :if ([:len [/ip hotspot walled-garden find where dst-host=$fitiPortalHost]] = 0) do={ /ip hotspot walled-garden add dst-host=$fitiPortalHost comment="WiFi Fiti customer portal" } }',
    ':do {',
    '  /tool fetch url=' + ros(origin + '/tenant-router-install.rsc') + fetchTlsOption(origin) + ' dst-path="fiti-tenant-install.rsc"',
    '  /import file-name="fiti-tenant-install.rsc"',
    '  /system scheduler disable [find where name="fiti-first-install"]',
    '  :log info "fiti: cloud installer completed"',
    '} on-error={',
    '  :log warning "fiti: waiting for WAN/DNS before cloud pairing"',
    '}',
  ];
  return [
    '/system script remove [find where name="fiti-first-install"]',
    '/system scheduler remove [find where name="fiti-first-install"]',
    '/system script add name="fiti-first-install" policy=read,write,ftp,policy,test source={',
    ...bootstrap,
    '}',
    '/system scheduler add name="fiti-first-install" interval=15s policy=read,write,ftp,policy,test on-event="/system script run fiti-first-install" comment="WiFi Fiti: retry cloud installer until paired"',
    '/system script run fiti-first-install',
    ':put "WiFi Fiti setup started. It will retry cloud pairing every 15 seconds until the router checks in."',
  ];
}

function assertExistingHotspotLines(config) {
  const hotspotServer = ros(config.hotspotServer);
  const customerBridge = ros(config.customerBridge);
  return [
    ':local fitiCheckHotspot ' + hotspotServer,
    ':local fitiCheckBridge ' + customerBridge,
    ':if ([:len [/ip hotspot find where name=$fitiCheckHotspot]] != 1) do={ :error "Hotspot server not found. Check its name before importing." }',
    ':if ([:len [/interface bridge find where name=$fitiCheckBridge]] != 1) do={ :error "Customer bridge not found. Check its name before importing." }',
    ':local fitiHotspotBridge [/ip hotspot get [find where name=$fitiCheckHotspot] interface]',
    ':if ($fitiHotspotBridge != $fitiCheckBridge) do={ :error "The selected Hotspot server is not on the selected customer bridge." }',
  ];
}

function buildExistingRouterKit({ location, token, appUrl, portalUrl, config }) {
  return wrapRouterScript([
    '# WiFi Fiti — existing-router pairing kit',
    '# This kit preserves the WAN, Wi-Fi, DHCP and Hotspot configuration.',
    '# It replaces only the captive login redirect and WiFi Fiti polling scripts.',
    // Do all read-only checks before creating globals or a retry scheduler.
    // A wrong bridge/Hotspot name therefore leaves an existing live router
    // completely untouched.
    ...assertExistingHotspotLines(config),
    ...setupPrefix({ location, token, appUrl, portalUrl, config }),
    ...pairingSuffix({ appUrl, portalUrl, location, token, config }),
  ]);
}

function newRouterWirelessLines(config) {
  return [
    ':if ($fitiWifiStack = "wireless") do={',
    '  :if ([:len [/interface wireless security-profiles find where name="fiti-wifi-security"]] = 0) do={',
    '    /interface wireless security-profiles add name="fiti-wifi-security" mode=dynamic-keys',
    '  }',
    '  /interface wireless security-profiles set [find where name="fiti-wifi-security"] authentication-types=wpa2-psk',
    '  /interface wireless security-profiles set [find where name="fiti-wifi-security"] wpa2-pre-shared-key=' + ros(config.wifiPassword),
    '  /interface wireless security-profiles set [find where name="fiti-wifi-security"] supplicant-identity=MikroTik',
    '  /interface wireless set [find where name=$fitiWifiInterface] mode=ap-bridge band=2ghz-b/g/n',
    '  /interface wireless set [find where name=$fitiWifiInterface] ssid=' + ros(config.wifiSsid) + ' security-profile="fiti-wifi-security"',
    '  /interface wireless set [find where name=$fitiWifiInterface] country=kenya disabled=no',
    '} else={',
    '  /interface wifi set [find where name=$fitiWifiInterface] configuration.mode=ap configuration.country=Kenya',
    '  /interface wifi set [find where name=$fitiWifiInterface] configuration.ssid=' + ros(config.wifiSsid) + ' disabled=no',
    '  /interface wifi set [find where name=$fitiWifiInterface] security.authentication-types=wpa2-psk',
    '  /interface wifi set [find where name=$fitiWifiInterface] security.passphrase=' + ros(config.wifiPassword),
    '}',
  ];
}

function newRouterWirelessDetectionLines(config) {
  const expected = ros(config.wifiInterface);
  const alternate = config.wifiInterface === 'wlan1' ? 'wifi1' : 'wlan1';
  return [
    // RouterOS 7 has two Wi-Fi stacks. The legacy wireless package exposes
    // wlan1, while the newer wifi package normally exposes wifi1. Probe the
    // selected name and both supported menus before changing anything.
    ':local fitiWifiId ""',
    ':local fitiWifiStack ""',
    ':do { :set fitiWifiId [/interface wireless find where name=' + expected + '] } on-error={ :set fitiWifiId "" }',
    ':if ([:len $fitiWifiId] = 1) do={ :set fitiWifiStack "wireless" } else={',
    '  :do { :set fitiWifiId [/interface wifi find where name=' + expected + '] } on-error={ :set fitiWifiId "" }',
    '  :if ([:len $fitiWifiId] = 1) do={ :set fitiWifiStack "wifi" } else={',
    '    :set fitiWifiInterface ' + ros(alternate),
    '    :do { :set fitiWifiId [/interface wireless find where name=$fitiWifiInterface] } on-error={ :set fitiWifiId "" }',
    '    :if ([:len $fitiWifiId] = 1) do={ :set fitiWifiStack "wireless" } else={',
    '      :do { :set fitiWifiId [/interface wifi find where name=$fitiWifiInterface] } on-error={ :set fitiWifiId "" }',
    '      :if ([:len $fitiWifiId] = 1) do={ :set fitiWifiStack "wifi" }',
    '    }',
    '  }',
    '}',
    ':if ([:len $fitiWifiStack] = 0) do={ :error "No supported WiFi interface found. Check /interface print; expected wlan1 or wifi1." }',
    ':if ([:len [/interface bridge port find where interface=$fitiWifiInterface]] > 0) do={ :error "WiFi interface is already in a bridge. Use the existing-router path instead." }',
  ];
}

function newRouterWanLines(config) {
  if (config.wanMode === 'pppoe') {
    return [
      '/interface pppoe-client add name="fiti-wan" interface=$fitiWanInterface user=' + ros(config.pppoeUser) + ' password=' + ros(config.pppoePassword) + ' add-default-route=yes use-peer-dns=no disabled=no comment="WiFi Fiti WAN"',
      ':local fitiWanOut "fiti-wan"',
    ];
  }
  if (config.wanMode === 'static') {
    return [
      '/ip address add address=' + ros(config.wan.address) + ' interface=$fitiWanInterface comment="WiFi Fiti WAN"',
      '/ip route add dst-address=0.0.0.0/0 gateway=' + ros(config.wan.gateway) + ' comment="WiFi Fiti WAN"',
      ':local fitiWanOut $fitiWanInterface',
    ];
  }
  return [
    // A customer may have completed the optional WAN preparation command
    // before importing this kit.  RouterOS permits only one DHCP client per
    // interface, so adopt that client instead of failing the whole import.
    ':local fitiWanDhcp [/ip dhcp-client find where interface=$fitiWanInterface]',
    ':if ([:len $fitiWanDhcp] = 0) do={',
    '  /ip dhcp-client add interface=$fitiWanInterface disabled=no add-default-route=yes use-peer-dns=no comment="WiFi Fiti WAN"',
    '} else={',
    '  /ip dhcp-client set $fitiWanDhcp disabled=no add-default-route=yes use-peer-dns=no comment="WiFi Fiti WAN"',
    '}',
    ':local fitiWanOut $fitiWanInterface',
  ];
}

function routerDnsLine(config) {
  const servers = config.wanMode === 'static' ? config.wan.dns : '1.1.1.1,8.8.8.8';
  return '/ip dns set allow-remote-requests=yes servers=' + servers;
}

function newRouterSecurityLines() {
  return [
    '/interface list add name="fiti-local-admin" comment="WiFi Fiti local administration"',
    '/interface list member add list="fiti-local-admin" interface=$fitiBridge',
    '/ip firewall filter add chain=input action=accept connection-state=established,related,untracked comment="WiFi Fiti established"',
    '/ip firewall filter add chain=input action=drop connection-state=invalid comment="WiFi Fiti invalid input"',
    '/ip firewall filter add chain=input action=accept in-interface=$fitiWanInterface protocol=udp src-port=67 dst-port=68 comment="WiFi Fiti WAN DHCP"',
    '/ip firewall filter add chain=input action=accept in-interface=$fitiBridge protocol=udp dst-port=53,67 comment="WiFi Fiti guest DNS and DHCP"',
    '/ip firewall filter add chain=input action=accept in-interface=$fitiBridge protocol=tcp dst-port=53,80,443 comment="WiFi Fiti guest portal"',
    '/ip firewall filter add chain=input action=drop in-interface=$fitiWanOut comment="WiFi Fiti block WAN management"',
    '/ip firewall filter add chain=input action=drop in-interface=$fitiBridge comment="WiFi Fiti guest isolation"',
  ];
}

function newRouterMacSecurityLines() {
  // These services can interrupt an active MAC WinBox terminal. Run them
  // after the pairing script has been installed and started, so a console
  // restart cannot leave a router half-configured.
  return [
    '/tool mac-server set allowed-interface-list="fiti-local-admin"',
    '/tool mac-server mac-winbox set allowed-interface-list="fiti-local-admin"',
    '/ip neighbor discovery-settings set discover-interface-list="fiti-local-admin"',
  ];
}

function buildNewRouterKit({ location, token, appUrl, portalUrl, config }) {
  const checks = [config.wanInterface, ...config.customerPorts]
    .map((name) => ':if ([:len [/interface find where name=' + ros(name) + ']] != 1) do={ :error ' + ros(`Interface ${name} was not found.`) + ' }');
  const bridgeMembershipChecks = [...config.customerPorts]
    .map((name) => ':if ([:len [/interface bridge port find where interface=' + ros(name) + ']] > 0) do={ :error ' + ros(`Interface ${name} is already in a bridge. Use the existing-router path instead.`) + ' }');
  const bridgePorts = config.customerPorts.map((name) => '/interface bridge port add bridge=$fitiBridge interface=' + ros(name));
  return wrapRouterScript([
    '# WiFi Fiti — new/reset RouterOS 7 setup kit',
    '# Use only on a router reset with NO default configuration.',
    '# Connect with MAC WinBox or Ethernet. This script never resets the router itself.',
    '# Router administrator credentials are never changed by this installer.',
    // Read-only preflight comes before globals or network mutations. It is
    // safe to stop here and switch to the existing-router path.
    ':if ([:len [/interface bridge find where name=' + ros(config.customerBridge) + ']] > 0) do={ :error "Customer bridge already exists. Use the existing-router path instead." }',
    ':if ([:len [/ip hotspot find where name=' + ros(config.hotspotServer) + ']] > 0) do={ :error "Hotspot server already exists. Use the existing-router path instead." }',
    ...checks,
    ...bridgeMembershipChecks,
    ':if ([:len [/user find where name="admin"]] != 1) do={ :error "Default admin account was not found. Stop and use the existing-router path." }',
    ...setupPrefix({ location, token, appUrl, portalUrl, config }),
    ':local fitiWanInterface ' + ros(config.wanInterface),
    ':local fitiWifiInterface ' + ros(config.wifiInterface),
    ...newRouterWirelessDetectionLines(config),
    '/interface bridge add name=$fitiBridge protocol-mode=rstp comment="WiFi Fiti customer network"',
    ...bridgePorts,
    ...newRouterWirelessLines(config),
    '/interface bridge port add bridge=$fitiBridge interface=$fitiWifiInterface',
    ...newRouterWanLines(config),
    '/ip address add address=' + ros(config.network.gateway + '/24') + ' interface=$fitiBridge comment="WiFi Fiti customer gateway"',
    '/ip pool add name="fiti-pool" ranges=' + ros(config.network.pool),
    '/ip dhcp-server add name="fiti-dhcp" interface=$fitiBridge address-pool="fiti-pool" lease-time=1h disabled=no',
    '/ip dhcp-server network add address=' + ros(config.network.cidr) + ' gateway=' + ros(config.network.gateway) + ' dns-server=' + ros(config.network.gateway),
    routerDnsLine(config),
    '/ip firewall nat add chain=srcnat out-interface=$fitiWanOut action=masquerade comment="WiFi Fiti hotspot NAT"',
    '/ip hotspot profile add name="fiti-hsprof" hotspot-address=' + ros(config.network.gateway) + ' html-directory="hotspot" login-by=http-chap,http-pap use-radius=no',
    '/ip hotspot add name=$fitiHotspotServer interface=$fitiBridge address-pool="fiti-pool" profile="fiti-hsprof" addresses-per-mac=1 idle-timeout=10m keepalive-timeout=5m disabled=no',
    ':if ([:len [/ip hotspot user profile find where name="standard"]] = 0) do={ /ip hotspot user profile add name="standard" shared-users=1 add-mac-cookie=yes mac-cookie-timeout=1d status-autorefresh=1m transparent-proxy=no }',
    ...newRouterSecurityLines(),
    ...pairingSuffix({ appUrl, portalUrl, location, token, config }),
    ...newRouterMacSecurityLines(),
  ]);
}

function validateRouterSetup(input) {
  const mode = String(input && input.mode || '').trim();
  if (!['new', 'existing'].includes(mode)) throw invalid('Choose whether this is a new/reset router or an existing Hotspot router.');
  const routerOsVersion = String(input && input.routerOsVersion || '').trim();
  if (routerOsVersion !== '7') throw invalid('WiFi Fiti guided setup currently requires RouterOS 7.');
  const modelProfile = String(input && input.modelProfile || '').trim();
  const profile = MODEL_PROFILES[modelProfile];
  if (mode === 'new' && !profile) throw invalid('Choose a supported router profile for a new/reset router.');
  if (mode === 'new' && String(input && input.freshRouterConfirmed || '') !== 'yes') {
    throw invalid('Confirm that this is a fresh/reset router before generating its setup kit.');
  }
  const fallback = profile || MODEL_PROFILES['legacy-wireless'];
  const customerBridge = identifier(input && input.customerBridge, 'customer bridge', fallback.bridge);
  const hotspotServer = identifier(input && input.hotspotServer, 'Hotspot server name', 'hotspot1');
  const routerModel = text(input && input.routerModel, 'router model', 80, mode === 'new') || (profile ? profile.label : 'Existing MikroTik');
  const requestedCustomerPorts = mode === 'new'
    ? [...fallback.customerPorts]
    : parsePorts(input && input.customerPorts, fallback.customerPorts);
  const config = {
    mode,
    routerOsVersion,
    modelProfile: profile ? modelProfile : 'existing-router',
    routerModel,
    radio: fallback.radio,
    customerBridge,
    hotspotServer,
    wanInterface: identifier(input && input.wanInterface, 'WAN interface', 'ether1'),
    wifiInterface: identifier(input && input.wifiInterface, 'WiFi interface', fallback.wifiInterface),
    // A new-router profile is authoritative for physical customer ports. A
    // stale browser form must not send ether5 to an hAP lite, which only has
    // ether1–ether4. Existing-router mode does not touch these ports.
    customerPorts: mode === 'new' ? [...fallback.customerPorts] : requestedCustomerPorts,
    wifiSsid: '',
    wifiPassword: '',
    customerSubnet: '',
    wanMode: '',
    wan: null,
    pppoeUser: '',
    pppoePassword: '',
  };
  if (config.customerPorts.includes(config.wanInterface) || config.customerPorts.includes(config.wifiInterface)) {
    throw invalid('Customer LAN interfaces cannot also be the WAN or WiFi interface.');
  }
  if (mode === 'new') {
    config.wifiSsid = text(input && input.wifiSsid, 'WiFi name', 32, true);
    if (!config.wifiSsid || /["\\$\r\n]/.test(config.wifiSsid)) throw invalid('WiFi name cannot contain quotes, backslashes, dollar signs, or line breaks.');
    config.wifiPassword = routerString(input && input.wifiPassword, 'WiFi password', 8, 63);
    config.network = customerNetwork(input && input.customerSubnet);
    config.customerSubnet = config.network.cidr;
    config.wanMode = String(input && input.wanMode || 'dhcp').trim();
    if (!['dhcp', 'pppoe', 'static'].includes(config.wanMode)) throw invalid('Choose the WAN connection type.');
    if (config.wanMode === 'pppoe') {
      config.pppoeUser = routerString(input && input.pppoeUser, 'PPPoE username', 1, 63);
      config.pppoePassword = routerString(input && input.pppoePassword, 'PPPoE password', 1, 63);
    }
    if (config.wanMode === 'static') config.wan = staticWan(input && input.staticWanAddress, input && input.staticWanGateway, input && input.dnsServers, config.network);
  }
  return config;
}

function setupSummary(config) {
  if (config.mode === 'existing') {
    return `Pairs the existing ${config.hotspotServer} Hotspot on ${config.customerBridge}; it does not change WAN, Wi-Fi or DHCP.`;
  }
  return `Creates ${config.wifiSsid} on ${config.customerBridge}, a ${config.network.cidr} customer network, ${config.hotspotServer}, and WiFi Fiti polling.`;
}

function buildRouterSetup({ location, token, appUrl, portalUrl, input }) {
  const config = validateRouterSetup(input);
  const script = config.mode === 'new'
    ? buildNewRouterKit({ location, token, appUrl, portalUrl, config })
    : buildExistingRouterKit({ location, token, appUrl, portalUrl, config });
  const warnings = config.mode === 'new'
    ? [
      'Paste or import the complete kit in one operation. Do not run it line by line; the kit is one RouterOS transaction.',
      'Use this only after resetting the router with no default configuration. It does not reset the router for you.',
      'The kit never changes the RouterOS administrator password. Set and save that password yourself before putting the router into service.',
      'It keeps retrying cloud pairing every 15 seconds until WAN and DNS are ready. Do not use it on a router serving customers.',
      'The router must have RouterOS 7 and device-mode fetch enabled.',
    ]
    : [
      'Paste or import the complete kit in one operation. Do not run it line by line; the kit is one RouterOS transaction.',
      'This keeps WAN, Wi-Fi, DHCP, Hotspot and administrator credentials, but replaces the captive login redirect and WiFi Fiti polling scripts.',
      'Back up a busy router first. The selected Hotspot must run on the selected customer bridge.',
      'The router must have RouterOS 7, working internet/DNS, and device-mode fetch enabled.',
    ];
  return { config, script, summary: setupSummary(config), warnings };
}

module.exports = {
  MODEL_PROFILES,
  validateRouterSetup,
  buildExistingRouterKit,
  buildNewRouterKit,
  buildRouterSetup,
};

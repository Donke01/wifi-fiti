'use strict';

/**
 * Render the CA-compatible form of the current router kit.
 *
 * The compatibility kit is deliberately not a second installer. Keeping one
 * source of truth means captive-portal, payment, polling, receipt and hotspot
 * fixes cannot silently land in the normal kit but miss older RouterOS boards.
 * The only supported difference is disabling certificate verification for
 * boards whose RouterOS trust store cannot validate the HTTPS certificate.
 */
function compatibilityRouterKit(source) {
  return String(source || '')
    .replace(/check-certificate=yes/g, 'check-certificate=no')
    .replace(/tenant-router-install\.rsc/g, 'tenant-router-install-compat.rsc');
}

/**
 * Render an isolated telemetry test kit from the production kit.  This is an
 * additive transform: the production installer remains the source of truth
 * and is never edited.  Every optional RouterOS read is guarded so an older
 * board simply reports blanks and continues its normal poll.
 */
function telemetryTestRouterKit(source) {
  const input = String(source || '');
  const marker = String.raw`  :local url (\$fitiUrl . \"/api/router/sync\?site=\" . \$fitiSite`;
  const telemetryLines = [
    '  :local fitiTelemetryCpu \\"\\"',
    '  :local fitiTelemetryFreeMemory \\"\\"',
    '  :local fitiTelemetryTotalMemory \\"\\"',
    '  :local fitiTelemetryUptimeSeconds \\"\\"',
    '  :local fitiTelemetryUptimeText \\"\\"',
    '  :local fitiTelemetryRxBytes \\"\\"',
    '  :local fitiTelemetryTxBytes \\"\\"',
    '  :local fitiTelemetryActiveUsers \\"\\"',
    '  :local fitiTelemetryDevices \\"\\"',
    '  :do { :set fitiTelemetryCpu [/system resource get cpu-load] } on-error={}',
    '  :do { :set fitiTelemetryFreeMemory [/system resource get free-memory] } on-error={}',
    '  :do { :set fitiTelemetryTotalMemory [/system resource get total-memory] } on-error={}',
    '  :do { :set fitiTelemetryUptimeSeconds ([:tonsec [/system resource get uptime]] / 1000000000) } on-error={}',
    '  :do { :set fitiTelemetryUptimeText [/system resource get uptime] } on-error={}',
    '  :do { :set fitiTelemetryRxBytes [/interface get [find where name=\\$fitiBridge] rx-byte] } on-error={}',
    '  :do { :set fitiTelemetryTxBytes [/interface get [find where name=\\$fitiBridge] tx-byte] } on-error={}',
    '  :do { :set fitiTelemetryActiveUsers [:len [/ip hotspot active find]] } on-error={}',
    // Keep the discovery report small and limited to bound customer DHCP
    // leases. Hostnames are optional; the portal still has a safe manual MAC
    // fallback when a board does not expose this menu.
    '  :do { :foreach fitiLease in=[/ip dhcp-server lease find where status=bound] do={ :local fitiLeaseMac [/ip dhcp-server lease get $fitiLease mac-address]; :local fitiLeaseIp [/ip dhcp-server lease get $fitiLease address]; :if ([:len $fitiTelemetryDevices] < 1800) do={ :if ([:len $fitiTelemetryDevices] > 0) do={ :set fitiTelemetryDevices ($fitiTelemetryDevices . \",\") }; :set fitiTelemetryDevices ($fitiTelemetryDevices . $fitiLeaseMac . \\"~\\" . $fitiLeaseIp) } } } on-error={}',
  ];
  const telemetry = telemetryLines.map((line) => line + '\\r\\\n\\n').join('');
  if (!input.includes(marker)) return input;
  const withReads = input.replace(marker, telemetry + '\\n' + marker);
  const bridgeMarker = String.raw`&bridge=\" . \$fitiBridge)`;
  const telemetrySuffix = String.raw`&bridge=\" . \$fitiBridge . \"&telemetry=1&cpu=\" . \$fitiTelemetryCpu . \"&freeMem=\" . \$fitiTelemetryFreeMemory . \"&totalMem=\" . \$fitiTelemetryTotalMemory . \"&uptime=\" . \$fitiTelemetryUptimeSeconds . \"&uptimeText=\" . \$fitiTelemetryUptimeText . \"&rx=\" . \$fitiTelemetryRxBytes . \"&tx=\" . \$fitiTelemetryTxBytes . \"&activeUsers=\" . \$fitiTelemetryActiveUsers . \"&devices=\" . \$fitiTelemetryDevices)`;
  return withReads.replace(bridgeMarker, telemetrySuffix);
}

/**
 * Render the fourth, isolated VLAN test kit. It deliberately starts from the
 * exact production kit and adds only disabled VLAN interfaces on the Wi-Fi
 * Fiti customer bridge. Bridge VLAN filtering is not enabled automatically:
 * that is the safety boundary that prevents a test kit from locking an owner
 * out before tagged/untagged ports have been verified on real hardware.
 */
function vlanTestRouterKit(source, options = {}) {
  const input = String(source || '').trimEnd();
  const baseId = Number(options.baseId == null ? 10 : options.baseId);
  // A VLAN test kit is deliberately limited to four consecutive IDs. The
  // default remains 10/20/30/40 for compatibility with the existing test kit.
  const ids = options.baseId == null
    ? { management: 10, hotspot: 20, pppoe: 30, tv: 40 }
    : { management: baseId, hotspot: baseId + 1, pppoe: baseId + 2, tv: baseId + 3 };
  const validIds = Object.values(ids).every((id) => Number.isInteger(id) && id >= 1 && id <= 4094);
  if (!validIds) throw Object.assign(new Error('VLAN IDs must be integers from 1 to 4094.'), { status: 400 });
  const block = [
    '',
    '# Wi-Fi Fiti VLAN KIT (TEST) — copied from the stable connection kit',
    '# VLAN interfaces are staged disabled until the tenant confirms switch/AP port mapping.',
    ':onerror fitiVlanError in={',
    '  :local fitiWanInterface ""',
    '  :local fitiWanType "Unknown"',
    '  :local fitiActivePppoe ""',
    '  :do { :set fitiActivePppoe [/interface pppoe-client find where running=yes] } on-error={}',
    '  :if ([:len $fitiActivePppoe] > 0) do={ :set fitiWanInterface [/interface pppoe-client get [:pick $fitiActivePppoe 0] name]; :set fitiWanType "PPPoE" }',
    '  :if ($fitiWanInterface = "") do={ :local fitiBoundDhcp ""; :do { :set fitiBoundDhcp [/ip dhcp-client find where status=bound] } on-error={}; :if ([:len $fitiBoundDhcp] > 0) do={ :set fitiWanInterface [/ip dhcp-client get [:pick $fitiBoundDhcp 0] interface]; :set fitiWanType "DHCP" } }',
    '  :if ($fitiWanInterface = "") do={ :local fitiActiveLte ""; :do { :set fitiActiveLte [/interface lte find where running=yes] } on-error={}; :if ([:len $fitiActiveLte] > 0) do={ :set fitiWanInterface [/interface lte get [:pick $fitiActiveLte 0] name]; :set fitiWanType "LTE" } }',
    '  :if ($fitiWanInterface = "") do={ :local fitiDefaultRoutes ""; :do { :set fitiDefaultRoutes [/ip route find dst-address=0.0.0.0/0 active=yes] } on-error={}; :if ([:len $fitiDefaultRoutes] > 0) do={ :local fitiRoute [:pick $fitiDefaultRoutes 0]; :do { :set fitiWanInterface [/ip route get $fitiRoute gateway-interface] } on-error={}; :if ($fitiWanInterface = "") do={ :local fitiImmediateGw [/ip route get $fitiRoute immediate-gw]; :local fitiPercent [:find $fitiImmediateGw "%"]; :if ([:typeof $fitiPercent] != "nil") do={ :set fitiWanInterface [:pick $fitiImmediateGw ($fitiPercent + 1) [:len $fitiImmediateGw]] } }; :set fitiWanType "Static/DefaultRoute" } }',
    '  :if ($fitiWanInterface = "") do={ :error "Wi-Fi Fiti VLAN kit could not detect an active WAN interface. Connect WAN and retry." }',
    '  :put ("Wi-Fi Fiti VLAN WAN detected: " . $fitiWanInterface . " (" . $fitiWanType . ")")',
    '  :global fitiBridge',
    '  :local fitiVlanBridge $fitiBridge',
    '  :if ([:len $fitiVlanBridge] = 0 || [:len [/interface bridge find where name=$fitiVlanBridge]] != 1) do={ :error "Wi-Fi Fiti VLAN kit could not find the paired customer bridge. Complete stable onboarding first." }',
    `  :if ([:len [/interface vlan find where name="fiti-vlan-management"]] = 0) do={ :if ([:len [/interface vlan find where vlan-id=${ids.management} interface=$fitiVlanBridge]] > 0) do={ :error "VLAN ${ids.management} is already used on the customer bridge." }; /interface vlan add name="fiti-vlan-management" vlan-id=${ids.management} interface=$fitiVlanBridge disabled=yes comment="Wi-Fi Fiti VLAN test management" }`,
    `  :if ([:len [/interface vlan find where name="fiti-vlan-hotspot"]] = 0) do={ :if ([:len [/interface vlan find where vlan-id=${ids.hotspot} interface=$fitiVlanBridge]] > 0) do={ :error "VLAN ${ids.hotspot} is already used on the customer bridge." }; /interface vlan add name="fiti-vlan-hotspot" vlan-id=${ids.hotspot} interface=$fitiVlanBridge disabled=yes comment="Wi-Fi Fiti VLAN test hotspot" }`,
    `  :if ([:len [/interface vlan find where name="fiti-vlan-pppoe"]] = 0) do={ :if ([:len [/interface vlan find where vlan-id=${ids.pppoe} interface=$fitiVlanBridge]] > 0) do={ :error "VLAN ${ids.pppoe} is already used on the customer bridge." }; /interface vlan add name="fiti-vlan-pppoe" vlan-id=${ids.pppoe} interface=$fitiVlanBridge disabled=yes comment="Wi-Fi Fiti VLAN test PPPoE" }`,
    `  :if ([:len [/interface vlan find where name="fiti-vlan-tv"]] = 0) do={ :if ([:len [/interface vlan find where vlan-id=${ids.tv} interface=$fitiVlanBridge]] > 0) do={ :error "VLAN ${ids.tv} is already used on the customer bridge." }; /interface vlan add name="fiti-vlan-tv" vlan-id=${ids.tv} interface=$fitiVlanBridge disabled=yes comment="Wi-Fi Fiti VLAN test TV" }`,
    `  :put "Wi-Fi Fiti VLAN test interfaces staged: ${ids.management} management, ${ids.hotspot} hotspot, ${ids.pppoe} PPPoE, ${ids.tv} TV"`,
    '} do={',
    '  :log warning ("Wi-Fi Fiti VLAN test kit stopped: " . $fitiVlanError)',
    '  :put ("Wi-Fi Fiti VLAN test kit stopped: " . $fitiVlanError)',
    '}',
    '',
  ].join('\n');
  return input + '\n' + block;
}

/**
 * Render the explicit VLAN overlay kit. This is intentionally separate from
 * vlanTestRouterKit: it can enable bridge VLAN filtering only when the caller
 * supplies a trunk and an explicit activation flag. The stable connection kit
 * is never modified in-place.
 */
function vlanOverlayRouterKit(source, options = {}) {
  const input = String(source || '').trimEnd();
  const baseId = Number(options.baseId == null ? 51 : options.baseId);
  const trunk = String(options.trunk || '').trim();
  const accessPorts = String(options.accessPorts || '').trim();
  const nativePorts = String(options.nativePorts || '').trim();
  const activate = options.activate === true;
  const subnet = String(options.subnet || `10.250.${baseId + 1}.0/24`).trim();
  const ids = { management: baseId, hotspot: baseId + 1, pppoe: baseId + 2, tv: baseId + 3 };
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trunk)) throw Object.assign(new Error('VLAN overlay requires a valid trunk interface.'), { status: 400 });
  const listedPorts = [...(accessPorts ? accessPorts.split(',') : []), ...(nativePorts ? nativePorts.split(',') : [])].map((name) => name.trim());
  if (listedPorts.some((name) => !/^[A-Za-z0-9_-]{1,32}$/.test(name) || name === trunk)) throw Object.assign(new Error('VLAN overlay ports must be valid interfaces and cannot include the trunk.'), { status: 400 });
  if (new Set(listedPorts).size !== listedPorts.length) throw Object.assign(new Error('VLAN overlay native and access ports must not be repeated.'), { status: 400 });
  if (activate && !nativePorts) throw Object.assign(new Error('VLAN overlay activation requires explicit native ports so existing traffic is not disconnected.'), { status: 400 });
  if (!Object.values(ids).every((id) => Number.isInteger(id) && id >= 1 && id <= 4094)) throw Object.assign(new Error('VLAN overlay IDs must be integers from 1 to 4094.'), { status: 400 });
  const subnetMatch = subnet.match(/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.(\d{1,3})\.(\d{1,3})\.0\/24$/);
  const subnetParts = subnet.replace(/\/24$/, '').split('.').map(Number);
  if (!subnetMatch || subnetParts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || subnetParts[3] !== 0) throw Object.assign(new Error('VLAN overlay subnet must be a private /24 ending in .0.'), { status: 400 });
  const prefix = subnet.replace(/\.0\/24$/, '');
  const gateway = `${prefix}.1`;
  const pool = `${prefix}.10-${prefix}.250`;
  const tag = `fiti-vlan-${baseId}`;
  // The overlay must not reuse the /24 that Wi-Fi Fiti PPPoE already gives
  // this router's subscribers, or both would hand out the same addresses.
  const overlayPrefixes = [prefix, `10.250.${ids.pppoe}`];
  if (options.pppoeSubnet) {
    const pppoePrefix = String(options.pppoeSubnet).replace(/\.0\/24$/, '');
    if (overlayPrefixes.includes(pppoePrefix)) throw Object.assign(new Error(`This router's PPPoE subscribers already use ${options.pppoeSubnet}. Choose another VLAN base ID or subnet.`), { status: 409 });
  }
  const pppoePoolCheck = `  :foreach fitiPppPool in=[/ip pool find where name="fiti-pppoe-pool"] do={ :local fitiPppRanges [:tostr [/ip pool get $fitiPppPool ranges]]; ${overlayPrefixes.map((value) => `:if ([:typeof [:find $fitiPppRanges "${value}."]] != "nil") do={ :error "The VLAN overlay subnet clashes with Wi-Fi Fiti PPPoE addresses on this router. Choose another VLAN base ID or subnet." }`).join('; ')} }`;
  const accessPortChecks = accessPorts
    ? accessPorts.split(',').map((name) => `  :if ([:len [/interface bridge port find where bridge=$fitiOverlayBridge interface="${name.trim()}"]] != 1) do={ :error "The selected VLAN access port is not on the customer bridge: ${name.trim()}" }`).join('\n')
    : '';
  const nativePortChecks = nativePorts
    ? nativePorts.split(',').map((name) => `  :if ([:len [/interface bridge port find where bridge=$fitiOverlayBridge interface="${name.trim()}"]] != 1) do={ :error "The selected native port is not on the customer bridge: ${name.trim()}" }`).join('\n')
    : '';
  const accessPvid = accessPorts
    ? `  :foreach fitiAccessPort in=[/interface bridge port find where bridge=$fitiOverlayBridge interface~"^(${accessPorts.split(',').map((name) => name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$"] do={ /interface bridge port set $fitiAccessPort pvid=${ids.hotspot} }`
    : '';
  const block = [
    '',
    '# Wi-Fi Fiti VLAN OVERLAY KIT (EXPLICIT TEST/APPLY)',
    `# Base VLAN ${baseId}; trunk ${trunk}; customer subnet ${subnet}`,
    `:onerror fitiVlanOverlayError in={`,
    '  :global fitiBridge',
    `  :local fitiOverlayBridge $fitiBridge`,
    `  :local fitiOverlayTrunk "${trunk}"`,
    `  :local fitiOverlayAccess "${accessPorts}"`,
    `  :local fitiOverlayNative "${nativePorts}"`,
    `  :local fitiOverlayBase ${baseId}`,
    '  :local fitiWanInterface ""',
    '  :local fitiWanType "Unknown"',
    '  :local fitiActivePppoe ""',
    '  :do { :set fitiActivePppoe [/interface pppoe-client find running=yes] } on-error={}',
    '  :if ([:len $fitiActivePppoe] > 0) do={ :set fitiWanInterface [/interface pppoe-client get [:pick $fitiActivePppoe 0] name]; :set fitiWanType "PPPoE" }',
    '  :if ($fitiWanInterface = "") do={ :local fitiBoundDhcp ""; :do { :set fitiBoundDhcp [/ip dhcp-client find where status=bound] } on-error={}; :if ([:len $fitiBoundDhcp] > 0) do={ :set fitiWanInterface [/ip dhcp-client get [:pick $fitiBoundDhcp 0] interface]; :set fitiWanType "DHCP" } }',
    '  :if ($fitiWanInterface = "") do={ :local fitiActiveLte ""; :do { :set fitiActiveLte [/interface lte find running=yes] } on-error={}; :if ([:len $fitiActiveLte] > 0) do={ :set fitiWanInterface [/interface lte get [:pick $fitiActiveLte 0] name]; :set fitiWanType "LTE" } }',
    '  :if ($fitiWanInterface = "") do={ :local fitiDefaultRoutes ""; :do { :set fitiDefaultRoutes [/ip route find dst-address=0.0.0.0/0 active=yes] } on-error={}; :if ([:len $fitiDefaultRoutes] > 0) do={ :local fitiRoute [:pick $fitiDefaultRoutes 0]; :do { :set fitiWanInterface [/ip route get $fitiRoute gateway-interface] } on-error={}; :if ($fitiWanInterface = "") do={ :local fitiImmediateGw [/ip route get $fitiRoute immediate-gw]; :local fitiPercent [:find $fitiImmediateGw "%"]; :if ([:typeof $fitiPercent] != "nil") do={ :set fitiWanInterface [:pick $fitiImmediateGw ($fitiPercent + 1) [:len $fitiImmediateGw]] } }; :set fitiWanType "Static/DefaultRoute" } }',
    '  :if ($fitiWanInterface = "") do={ :error "Wi-Fi Fiti VLAN overlay could not detect an active WAN interface." }',
    '  :put ("Wi-Fi Fiti VLAN overlay WAN detected: " . $fitiWanInterface . " (" . $fitiWanType . ")")',
    `  :if ([:len $fitiOverlayBridge] = 0 || [:len [/interface bridge find where name=$fitiOverlayBridge]] != 1) do={ :error "Wi-Fi Fiti VLAN overlay could not find the paired customer bridge." }`,
    `  :if ([:len [/interface bridge port find where bridge=$fitiOverlayBridge interface=$fitiOverlayTrunk]] != 1) do={ :error "The selected VLAN trunk is not a port of the customer bridge." }`,
    accessPortChecks,
    nativePortChecks,
    pppoePoolCheck,
    activate ? `  :local fitiOverlayOriginalFiltering [/interface bridge get $fitiOverlayBridge vlan-filtering]` : '',
    `  :if ([:len [/interface vlan find where vlan-id=${ids.management} interface=$fitiOverlayBridge]] > 0 || [:len [/interface vlan find where vlan-id=${ids.hotspot} interface=$fitiOverlayBridge]] > 0 || [:len [/interface vlan find where vlan-id=${ids.pppoe} interface=$fitiOverlayBridge]] > 0 || [:len [/interface vlan find where vlan-id=${ids.tv} interface=$fitiOverlayBridge]] > 0) do={ :error "One or more requested VLAN IDs are already in use on the customer bridge." }`,
    `  :if ([:len [/ip address find where address="${gateway}/24"]] > 0 || [:len [/ip pool find where name="${tag}-pool"]] > 0) do={ :error "The requested VLAN overlay subnet or pool already exists." }`,
    `  :put "Wi-Fi Fiti VLAN overlay preflight passed: trunk ${trunk}, VLANs ${ids.management}/${ids.hotspot}/${ids.pppoe}/${ids.tv}, subnet ${subnet}"`,
    activate ? `  :local fitiOverlayCreatedVlan ""` : '  :put "Validation-only mode: no VLAN filtering or customer traffic changes were applied."',
    activate ? `  :do { /interface vlan add name="${tag}-management" vlan-id=${ids.management} interface=$fitiOverlayBridge disabled=no comment="Wi-Fi Fiti VLAN overlay management"; /interface vlan add name="${tag}-hotspot" vlan-id=${ids.hotspot} interface=$fitiOverlayBridge disabled=no comment="Wi-Fi Fiti VLAN overlay hotspot"; /interface vlan add name="${tag}-pppoe" vlan-id=${ids.pppoe} interface=$fitiOverlayBridge disabled=no comment="Wi-Fi Fiti VLAN overlay PPPoE"; /interface vlan add name="${tag}-tv" vlan-id=${ids.tv} interface=$fitiOverlayBridge disabled=no comment="Wi-Fi Fiti VLAN overlay TV" } on-error={ :error "Could not create VLAN interfaces; no overlay was applied." }` : '',
    activate ? `  :do { /ip address add address="${gateway}/24" interface="${tag}-hotspot" comment="Wi-Fi Fiti VLAN overlay hotspot gateway"; /ip pool add name="${tag}-pool" ranges="${pool}" comment="Wi-Fi Fiti VLAN overlay hotspot pool"; /ip dhcp-server add name="${tag}-dhcp" interface="${tag}-hotspot" address-pool="${tag}-pool" disabled=no comment="Wi-Fi Fiti VLAN overlay DHCP"; /ip dhcp-server network add address="${subnet}" gateway="${gateway}" dns-server="${gateway}" comment="Wi-Fi Fiti VLAN overlay DHCP network"; /ip hotspot profile add name="${tag}-hsprof" hotspot-address="${gateway}" login-by=http-chap,http-pap html-directory=hotspot comment="Wi-Fi Fiti VLAN overlay profile"; /ip hotspot add name="${tag}-hotspot" interface="${tag}-hotspot" address-pool="${tag}-pool" profile="${tag}-hsprof" disabled=no comment="Wi-Fi Fiti VLAN overlay HotSpot" } on-error={ :error "HotSpot overlay resources could not be created; review and remove only Wi-Fi Fiti tagged resources before retrying." }` : '',
    activate ? `  :do { /ip address add address="10.250.${ids.pppoe}.1/24" interface="${tag}-pppoe" comment="Wi-Fi Fiti VLAN overlay PPPoE gateway"; /ip pool add name="${tag}-pppoe-pool" ranges="10.250.${ids.pppoe}.10-10.250.${ids.pppoe}.250" comment="Wi-Fi Fiti VLAN overlay PPPoE pool"; /ppp profile add name="${tag}-pppoe-profile" local-address="10.250.${ids.pppoe}.1" remote-address="${tag}-pppoe-pool" dns-server=1.1.1.1,8.8.8.8 use-upnp=no only-one=yes comment="Wi-Fi Fiti VLAN overlay PPPoE profile"; /interface pppoe-server server add service-name="${tag}-pppoe" interface="${tag}-pppoe" default-profile="${tag}-pppoe-profile" authentication=pap,chap,mschap1,mschap2 disabled=no comment="Wi-Fi Fiti VLAN overlay PPPoE" } on-error={ :error "PPPoE overlay resources could not be created." }` : '',
    activate ? `  :do { /ip firewall nat add chain=srcnat action=masquerade src-address="${subnet}" out-interface=$fitiWanInterface comment="Wi-Fi Fiti VLAN overlay NAT ${baseId}"; /ip firewall filter add chain=input action=accept protocol=udp dst-port=53 src-address="${subnet}" comment="Wi-Fi Fiti VLAN overlay DNS ${baseId}"; /ip firewall filter add chain=input action=accept protocol=tcp dst-port=53 src-address="${subnet}" comment="Wi-Fi Fiti VLAN overlay DNS ${baseId}" } on-error={ :error "VLAN overlay firewall/NAT resources could not be created." }` : '',
    activate ? `  :do { ${accessPvid} :foreach fitiNativePort in=[/interface bridge port find where bridge=$fitiOverlayBridge interface~"^(${nativePorts.split(',').map((name) => name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$"] do={ /interface bridge port set $fitiNativePort pvid=1 } /interface bridge vlan add bridge=$fitiOverlayBridge vlan-ids=1 tagged=$fitiOverlayBridge untagged=$fitiOverlayNative comment="Wi-Fi Fiti VLAN overlay native ${baseId}"; /interface bridge vlan add bridge=$fitiOverlayBridge vlan-ids=${ids.management},${ids.pppoe},${ids.tv} tagged=$fitiOverlayBridge,$fitiOverlayTrunk comment="Wi-Fi Fiti VLAN overlay tagged trunk ${baseId}"; /interface bridge vlan add bridge=$fitiOverlayBridge vlan-ids=${ids.hotspot} tagged=$fitiOverlayBridge,$fitiOverlayTrunk${accessPorts ? ` untagged=$fitiOverlayAccess` : ''} comment="Wi-Fi Fiti VLAN overlay hotspot ${baseId}"; /interface bridge set $fitiOverlayBridge vlan-filtering=yes } on-error={ :error "Bridge VLAN tagging could not be enabled; existing bridge traffic was not intentionally changed." }` : '',
    activate ? `  :if ($fitiWanType = "PPPoE") do={ :do { /ip firewall mangle add chain=forward action=change-mss new-mss=clamp-to-pmtu passthrough=yes out-interface=$fitiWanInterface comment="Wi-Fi Fiti VLAN overlay MSS ${baseId}" } on-error={ :log warning "Wi-Fi Fiti VLAN overlay could not add PPPoE MSS clamp" } }` : '',
    activate ? `  :put "Wi-Fi Fiti VLAN overlay applied. Confirm trunk reachability and HotSpot DHCP before enrolling customers."` : '',
    '} do={',
    activate ? `  :do { /interface bridge vlan remove [find where bridge=$fitiOverlayBridge comment~"Wi-Fi Fiti VLAN overlay"] } on-error={}; :do { /ip hotspot remove [find where name="${tag}-hotspot"] } on-error={}; :do { /ip hotspot profile remove [find where name="${tag}-hsprof"] } on-error={}; :do { /ip dhcp-server network remove [find where comment="Wi-Fi Fiti VLAN overlay DHCP network"] } on-error={}; :do { /ip dhcp-server remove [find where name="${tag}-dhcp"] } on-error={}; :do { /ip pool remove [find where name="${tag}-pool" || name="${tag}-pppoe-pool"] } on-error={}; :do { /ip address remove [find where comment~"Wi-Fi Fiti VLAN overlay"] } on-error={}; :do { /ppp profile remove [find where name="${tag}-pppoe-profile"] } on-error={}; :do { /interface pppoe-server server remove [find where comment="Wi-Fi Fiti VLAN overlay PPPoE"] } on-error={}; :do { /ip firewall nat remove [find where comment="Wi-Fi Fiti VLAN overlay NAT ${baseId}"] } on-error={}; :do { /ip firewall filter remove [find where comment="Wi-Fi Fiti VLAN overlay DNS ${baseId}"] } on-error={}; :do { /ip firewall mangle remove [find where comment="Wi-Fi Fiti VLAN overlay MSS ${baseId}"] } on-error={}; :do { /interface vlan remove [find where name="${tag}-management" || name="${tag}-hotspot" || name="${tag}-pppoe" || name="${tag}-tv"] } on-error={}; :do { /interface bridge set $fitiOverlayBridge vlan-filtering=$fitiOverlayOriginalFiltering } on-error={}` : '',
    '  :log warning ("Wi-Fi Fiti VLAN overlay stopped: " . $fitiVlanOverlayError)',
    '  :put ("Wi-Fi Fiti VLAN overlay stopped: " . $fitiVlanOverlayError)',
    '}',
    '',
  ].filter(Boolean).join('\n');
  return input + '\n' + block;
}

/*
 * Universal kit installer (test slot). Derived from the stable installer at
 * request time, so every stable fix carries over, with three differences:
 *   - it pairs a router that has no Hotspot yet instead of refusing, never
 *     defaults to a `hotspot1`/`bridge-hs` that may not exist, and reports
 *     `awaiting-map` until the owner maps the router in the dashboard;
 *   - it tells the cloud it is the universal kit (`kit=universal`), so the
 *     cloud holds Hotspot/PPPoE work and never opens a Wi-Fi it did not map;
 *   - it adds a read-only layout report (inventory v2) every 30 seconds.
 * It changes no interface, bridge, VLAN, address, DHCP, PPPoE or firewall.
 */
const UNIVERSAL_INSTALLER = 'tenant-router-install-universal.rsc';

// RouterOS source for the layout report. Read-only: every command is a
// find/get, and the result is only stored in the fitiInventory global that
// the poller sends with its next authenticated sync.
function inventoryScriptLines() {
  const safe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-';
  const add = (expr) => `:if ($fitiInvLines < 190) do={ :set fitiInvOut ($fitiInvOut . ${expr} . "\\n"); :set fitiInvLines ($fitiInvLines + 1) }`;
  return [
    ':global fitiInventory',
    ':local fitiInvOut "fiti-inventory-v2\\n"',
    ':local fitiInvLines 0',
    ':local fitiInvSkipped 0',
    `:local fitiInvSafe do={ :local v [:tostr $1]; :if ([:len $v] = 0 || [:len $v] > 64) do={ :return false }; :local i 0; :while ($i < [:len $v]) do={ :if ([:typeof [:find "${safe}" [:pick $v $i ($i + 1)]]] = "nil") do={ :return false }; :set i ($i + 1) }; :return true }`,
    `:local fitiInvClean do={ :local v [:tostr $1]; :local o ""; :local i 0; :while ($i < [:len $v] && $i < 48) do={ :local c [:pick $v $i ($i + 1)]; :if ([:typeof [:find "${safe}" $c]] = "nil") do={ :set o ($o . "_") } else={ :set o ($o . $c) }; :set i ($i + 1) }; :return $o }`,
    `:do { :local v [/system resource get version]; :local sp [:find $v " "]; :if ([:typeof $sp] != "nil") do={ :set v [:pick $v 0 $sp] }; :if ([$fitiInvSafe $v]) do={ ${add('("inv|system|routeros|" . $v)')} } } on-error={}`,
    `:do { :local b [$fitiInvClean [/system resource get board-name]]; :if ([$fitiInvSafe $b]) do={ ${add('("inv|board|" . $b)')} } } on-error={}`,
    `:do { :foreach i in=[/interface find where dynamic=no] do={ :local nm [/interface get $i name]; :local tp [/interface get $i type]; :local st "down"; :do { :if ([/interface get $i running] = true) do={ :set st "up" } } on-error={}; :do { :if ([/interface get $i disabled] = true) do={ :set st "disabled" } } on-error={}; :if ([$fitiInvSafe $nm] && [$fitiInvSafe $tp]) do={ ${add('("inv|if|" . $nm . "|" . $tp . "|" . $st)')} } else={ :set fitiInvSkipped ($fitiInvSkipped + 1) } } } on-error={}`,
    `:do { :foreach v in=[/interface vlan find] do={ :local nm [/interface vlan get $v name]; :local id [/interface vlan get $v vlan-id]; :local pr [/interface vlan get $v interface]; :if ([$fitiInvSafe $nm] && [$fitiInvSafe $pr]) do={ ${add('("inv|vlan|" . $nm . "|" . $id . "|" . $pr)')} } } } on-error={}`,
    `:do { :foreach p in=[/interface bridge port find] do={ :local br [/interface bridge port get $p bridge]; :local ifc [/interface bridge port get $p interface]; :if ([$fitiInvSafe $br] && [$fitiInvSafe $ifc]) do={ ${add('("inv|bport|" . $br . "|" . $ifc)')} } } } on-error={}`,
    `:do { :foreach c in=[/interface pppoe-client find] do={ :local nm [/interface pppoe-client get $c name]; :local ifc [/interface pppoe-client get $c interface]; :if ([$fitiInvSafe $nm] && [$fitiInvSafe $ifc]) do={ ${add('("inv|pppoe-client|" . $nm . "|" . $ifc)')} } } } on-error={}`,
    `:do { :foreach c in=[/interface pppoe-server server find] do={ :local sv [$fitiInvClean [/interface pppoe-server server get $c service-name]]; :local ifc [/interface pppoe-server server get $c interface]; :local en "enabled"; :if ([/interface pppoe-server server get $c disabled] = true) do={ :set en "disabled" }; :if ([$fitiInvSafe $sv] && [$fitiInvSafe $ifc]) do={ ${add('("inv|pppoe-server|" . $sv . "|" . $ifc . "|" . $en)')} } } } on-error={}`,
    `:do { :foreach a in=[/ip address find where disabled=no] do={ :local ifc [/ip address get $a interface]; :if ([$fitiInvSafe $ifc]) do={ ${add('("inv|addr|" . $ifc)')} } } } on-error={}`,
    `:do { :foreach d in=[/ip dhcp-server find] do={ :local ifc [/ip dhcp-server get $d interface]; :local en "enabled"; :if ([/ip dhcp-server get $d disabled] = true) do={ :set en "disabled" }; :if ([$fitiInvSafe $ifc]) do={ ${add('("inv|dhcp-server|" . $ifc . "|" . $en)')} } } } on-error={}`,
    `:do { :foreach d in=[/ip dhcp-client find] do={ :local ifc [/ip dhcp-client get $d interface]; :local stt [$fitiInvClean [/ip dhcp-client get $d status]]; :if ([$fitiInvSafe $ifc]) do={ ${add('("inv|dhcp-client|" . $ifc . "|" . $stt)')} } } } on-error={}`,
    `:do { :foreach h in=[/ip hotspot find] do={ :local nm [/ip hotspot get $h name]; :local ifc [/ip hotspot get $h interface]; :if ([$fitiInvSafe $nm] && [$fitiInvSafe $ifc]) do={ ${add('("inv|hotspot|" . $nm . "|" . $ifc)')} } } } on-error={}`,
    // Which interface actually carries the internet, in the same order the
    // stable kits use: a running PPPoE client, a bound DHCP client, then the
    // active default route (covers static WAN and LTE).
    ':local fitiInvWan ""',
    ':local fitiInvWanKind ""',
    ':do { :foreach p in=[/interface pppoe-client find where running=yes] do={ :if ($fitiInvWan = "") do={ :set fitiInvWan [/interface pppoe-client get $p name]; :set fitiInvWanKind "pppoe" } } } on-error={}',
    ':if ($fitiInvWan = "") do={ :do { :foreach c in=[/ip dhcp-client find where status=bound] do={ :if ($fitiInvWan = "") do={ :set fitiInvWan [/ip dhcp-client get $c interface]; :set fitiInvWanKind "dhcp" } } } on-error={} }',
    ':if ($fitiInvWan = "") do={ :do { :foreach r in=[/ip route find where dst-address=0.0.0.0/0 and active=yes] do={ :if ($fitiInvWan = "") do={ :local g [:tostr [/ip route get $r immediate-gw]]; :local pc [:find $g "%"]; :if ([:typeof $pc] != "nil") do={ :set fitiInvWan [:pick $g ($pc + 1) [:len $g]]; :set fitiInvWanKind "static" } } } } on-error={} }',
    `:if ([$fitiInvSafe $fitiInvWan]) do={ ${add('("inv|wan|" . $fitiInvWan . "|" . $fitiInvWanKind)')} }`,
    `:if ($fitiInvSkipped > 0) do={ ${add('("inv|skipped|" . $fitiInvSkipped)')} }`,
    ':set fitiInventory ($fitiInvOut . "fiti-inventory-end\\n")',
  ];
}

// Embed RouterOS source as a script `source=` value in the same continuation
// format the stable installer uses.
function routerScriptSource(lines) {
  const esc = (line) => line.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
  return 'source="\\\n' + lines.map(esc).join('\\r\\\n\\n') + '\\r\\\n\\n"';
}

function replaceOnce(text, find, replacement, label) {
  const index = text.indexOf(find);
  if (index < 0 || text.indexOf(find, index + find.length) >= 0) throw new Error(`Universal installer: stable installer changed near ${label}.`);
  return text.slice(0, index) + replacement + text.slice(index + find.length);
}

function universalInstaller(source) {
  let out = String(source || '');
  out = replaceOnce(out, '# =====================================================================\n#  Wi-Fi Fiti for Business',
    '# UNIVERSAL KIT INSTALLER (TEST): pairs any router without changing its network.\n# =====================================================================\n#  Wi-Fi Fiti for Business', 'header');
  // Never invent a bridge name on a router the owner has not mapped yet.
  out = replaceOnce(out, ':if ([:len $fitiBridge] = 0) do={ :set fitiBridge "bridge-hs" }\n',
    ':if ([:typeof $fitiBridge] != "str") do={ :set fitiBridge "" }\n', 'bridge default');
  const hotspotStart = ':global fitiHotspotServer\n:if ([:len $fitiHotspotServer] = 0) do={ :set fitiHotspotServer "hotspot1" }\n';
  const hotspotEnd = '\n:global fitiAck ""\n';
  const a = out.indexOf(hotspotStart); const b = out.indexOf(hotspotEnd, a);
  if (a < 0 || b < 0) throw new Error('Universal installer: stable installer changed near the Hotspot block.');
  const block = out.slice(a + hotspotStart.length, b);
  out = out.slice(0, a) + [
    ':global fitiHotspotServer',
    ':if ([:typeof $fitiHotspotServer] != "str") do={ :set fitiHotspotServer "" }',
    '# A router with a Hotspot keeps the stable behaviour. A router without one is',
    '# paired as it is and waits for the owner to map it in the dashboard.',
    ':if ([:len $fitiHotspotServer] > 0 && [:len [/ip hotspot find where name=$fitiHotspotServer]] = 1) do={',
    block,
    '} else={',
    '  :set fitiHotspotServer ""',
    '  :set fitiBridge ""',
    '  :log info "fiti: paired without a Hotspot; map this router in the Wi-Fi Fiti dashboard"',
    '}',
  ].join('\n') + out.slice(b);
  // Poller: report awaiting-map instead of a missing Hotspot/bridge, and do not
  // ask for a portal page there is no Hotspot to hold yet.
  out = replaceOnce(out,
    '\\n  :if ([:len [/ip hotspot find where name=\\$fitiHotspotServer]] != 1) do={ :set fitiHealth \\"hotspot-missing\\" }\\r\\\n\\n  :if ([:len [/interface bridge find where name=\\$fitiBridge]] != 1) do={ :set fitiHealth \\"bridge-missing\\" }\\r\\\n',
    '\\n  :if ([:len \\$fitiHotspotServer] = 0) do={ :set fitiHealth \\"awaiting-map\\" } else={ :if ([:len [/ip hotspot find where name=\\$fitiHotspotServer]] != 1) do={ :set fitiHealth \\"hotspot-missing\\" }; :if ([:len [/interface bridge find where name=\\$fitiBridge]] != 1) do={ :set fitiHealth \\"bridge-missing\\" } }\\r\\\n',
    'poller health');
  out = replaceOnce(out,
    ':if ([:len \\$fitiPortalHost] > 0 && \\$fitiPortalAppliedHost != \\$fitiPortalHost) do={ :set fitiHealth \\"portal-missing\\" }',
    ':if ([:len \\$fitiHotspotServer] > 0 && [:len \\$fitiPortalHost] > 0 && \\$fitiPortalAppliedHost != \\$fitiPortalHost) do={ :set fitiHealth \\"portal-missing\\" }',
    'portal health');
  out = replaceOnce(out, '\\"&bridge=\\" . \\$fitiBridge)', '\\"&bridge=\\" . \\$fitiBridge . \\"&kit=universal\\")', 'sync URL');
  // Poller: send the latest layout report with the next sync.
  out = replaceOnce(out, '\\n:global fitiTopologyTick\\r\\\n', '\\n:global fitiTopologyTick\\r\\\n\\n:global fitiInventory\\r\\\n', 'poller globals');
  out = replaceOnce(out, '\\n  :local fitiHealth \\"ready\\"\\r\\\n',
    '\\n  :if ([:len \\$fitiInventory] > 0) do={ :set report (\\$report . \\$fitiInventory); :set fitiInventory \\"\\" }\\r\\\n\\n  :local fitiHealth \\"ready\\"\\r\\\n', 'poller inventory');
  out = replaceOnce(out, '\n:put ""\n:put "Business router paired. Polling is active (2s)."\n', [
    '',
    '# --- Router layout report (read-only) --------------------------------',
    '/system script remove [find name="fiti-inventory"]',
    '/system script add name=fiti-inventory policy=read,test ' + routerScriptSource(inventoryScriptLines()),
    '/system scheduler remove [find name="fiti-inventory"]',
    ':local fitiInventoryStartDate [/system clock get date]',
    ':local fitiInventoryStartTime [/system clock get time]',
    '/system scheduler add name=fiti-inventory start-date=$fitiInventoryStartDate start-time=$fitiInventoryStartTime interval=30s disabled=no \\',
    '  policy=read,test on-event="/system script run fiti-inventory" \\',
    '  comment="Wi-Fi Fiti: report router layout (read-only)"',
    ':do { /system script run fiti-inventory } on-error={ :log warning "fiti: layout report failed; it will retry" }',
    '',
    ':put ""',
    ':if ([:len $fitiHotspotServer] = 0) do={ :put "Router paired with the universal kit. Nothing on your network was changed. Map it in the Wi-Fi Fiti dashboard." }',
    ':put "Business router paired. Polling is active (2s)."',
    '',
  ].join('\n'), 'closing');
  return out;
}

module.exports = { compatibilityRouterKit, telemetryTestRouterKit, vlanTestRouterKit, vlanOverlayRouterKit, universalInstaller, inventoryScriptLines, UNIVERSAL_INSTALLER };

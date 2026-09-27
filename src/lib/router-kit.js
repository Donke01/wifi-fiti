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
  const activate = options.activate === true;
  const subnet = String(options.subnet || `10.250.${baseId + 1}.0/24`).trim();
  const ids = { management: baseId, hotspot: baseId + 1, pppoe: baseId + 2, tv: baseId + 3 };
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trunk)) throw Object.assign(new Error('VLAN overlay requires a valid trunk interface.'), { status: 400 });
  if (!Object.values(ids).every((id) => Number.isInteger(id) && id >= 1 && id <= 4094)) throw Object.assign(new Error('VLAN overlay IDs must be integers from 1 to 4094.'), { status: 400 });
  const subnetMatch = subnet.match(/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.(\d{1,3})\.(\d{1,3})\.0\/24$/);
  const subnetParts = subnet.replace(/\/24$/, '').split('.').map(Number);
  if (!subnetMatch || subnetParts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || subnetParts[3] !== 0) throw Object.assign(new Error('VLAN overlay subnet must be a private /24 ending in .0.'), { status: 400 });
  const prefix = subnet.replace(/\.0\/24$/, '');
  const gateway = `${prefix}.1`;
  const pool = `${prefix}.10-${prefix}.250`;
  const tag = `fiti-vlan-${baseId}`;
  const block = [
    '',
    '# Wi-Fi Fiti VLAN OVERLAY KIT (EXPLICIT TEST/APPLY)',
    `# Base VLAN ${baseId}; trunk ${trunk}; customer subnet ${subnet}`,
    `:onerror fitiVlanOverlayError in={`,
    '  :global fitiBridge',
    `  :local fitiOverlayBridge $fitiBridge`,
    `  :local fitiOverlayTrunk "${trunk}"`,
    `  :local fitiOverlayBase ${baseId}`,
    `  :if ([:len $fitiOverlayBridge] = 0 || [:len [/interface bridge find where name=$fitiOverlayBridge]] != 1) do={ :error "Wi-Fi Fiti VLAN overlay could not find the paired customer bridge." }`,
    `  :if ([:len [/interface bridge port find where bridge=$fitiOverlayBridge interface=$fitiOverlayTrunk]] != 1) do={ :error "The selected VLAN trunk is not a port of the customer bridge." }`,
    activate ? `  :local fitiOverlayOriginalFiltering [/interface bridge get $fitiOverlayBridge vlan-filtering]` : '',
    `  :if ([:len [/interface vlan find where vlan-id=${ids.management} interface=$fitiOverlayBridge]] > 0 || [:len [/interface vlan find where vlan-id=${ids.hotspot} interface=$fitiOverlayBridge]] > 0 || [:len [/interface vlan find where vlan-id=${ids.pppoe} interface=$fitiOverlayBridge]] > 0 || [:len [/interface vlan find where vlan-id=${ids.tv} interface=$fitiOverlayBridge]] > 0) do={ :error "One or more requested VLAN IDs are already in use on the customer bridge." }`,
    `  :if ([:len [/ip address find where address="${gateway}/24"]] > 0 || [:len [/ip pool find where name="${tag}-pool"]] > 0) do={ :error "The requested VLAN overlay subnet or pool already exists." }`,
    `  :put "Wi-Fi Fiti VLAN overlay preflight passed: trunk ${trunk}, VLANs ${ids.management}/${ids.hotspot}/${ids.pppoe}/${ids.tv}, subnet ${subnet}"`,
    activate ? `  :local fitiOverlayCreatedVlan ""` : '  :put "Validation-only mode: no VLAN filtering or customer traffic changes were applied."',
    activate ? `  :do { /interface vlan add name="${tag}-management" vlan-id=${ids.management} interface=$fitiOverlayBridge disabled=no comment="Wi-Fi Fiti VLAN overlay management"; /interface vlan add name="${tag}-hotspot" vlan-id=${ids.hotspot} interface=$fitiOverlayBridge disabled=no comment="Wi-Fi Fiti VLAN overlay hotspot"; /interface vlan add name="${tag}-pppoe" vlan-id=${ids.pppoe} interface=$fitiOverlayBridge disabled=no comment="Wi-Fi Fiti VLAN overlay PPPoE"; /interface vlan add name="${tag}-tv" vlan-id=${ids.tv} interface=$fitiOverlayBridge disabled=no comment="Wi-Fi Fiti VLAN overlay TV" } on-error={ :error "Could not create VLAN interfaces; no overlay was applied." }` : '',
    activate ? `  :do { /ip address add address="${gateway}/24" interface="${tag}-hotspot" comment="Wi-Fi Fiti VLAN overlay hotspot gateway"; /ip pool add name="${tag}-pool" ranges="${pool}" comment="Wi-Fi Fiti VLAN overlay hotspot pool"; /ip dhcp-server add name="${tag}-dhcp" interface="${tag}-hotspot" address-pool="${tag}-pool" disabled=no comment="Wi-Fi Fiti VLAN overlay DHCP"; /ip dhcp-server network add address="${subnet}" gateway="${gateway}" dns-server="${gateway}" comment="Wi-Fi Fiti VLAN overlay DHCP network"; /ip hotspot profile add name="${tag}-hsprof" hotspot-address="${gateway}" login-by=http-chap,http-pap html-directory=hotspot comment="Wi-Fi Fiti VLAN overlay profile"; /ip hotspot add name="${tag}-hotspot" interface="${tag}-hotspot" address-pool="${tag}-pool" profile="${tag}-hsprof" disabled=no comment="Wi-Fi Fiti VLAN overlay HotSpot" } on-error={ :error "HotSpot overlay resources could not be created; review and remove only Wi-Fi Fiti tagged resources before retrying." }` : '',
    activate ? `  :do { /ip firewall nat add chain=srcnat action=masquerade src-address="${subnet}" out-interface=$fitiWanInterface comment="Wi-Fi Fiti VLAN overlay NAT ${baseId}"; /ip firewall filter add chain=input action=accept protocol=udp dst-port=53 src-address="${subnet}" comment="Wi-Fi Fiti VLAN overlay DNS ${baseId}"; /ip firewall filter add chain=input action=accept protocol=tcp dst-port=53 src-address="${subnet}" comment="Wi-Fi Fiti VLAN overlay DNS ${baseId}" } on-error={ :error "VLAN overlay firewall/NAT resources could not be created." }` : '',
    activate ? `  :do { /interface bridge vlan add bridge=$fitiOverlayBridge vlan-ids=${ids.management},${ids.hotspot},${ids.pppoe},${ids.tv} tagged=$fitiOverlayBridge,$fitiOverlayTrunk comment="Wi-Fi Fiti VLAN overlay tagged trunk ${baseId}"; /interface bridge set $fitiOverlayBridge vlan-filtering=yes } on-error={ :error "Bridge VLAN tagging could not be enabled; existing bridge traffic was not intentionally changed." }` : '',
    activate ? `  :put "Wi-Fi Fiti VLAN overlay applied. Confirm trunk reachability and HotSpot DHCP before enrolling customers."` : '',
    '} do={',
    activate ? `  :do { /interface bridge vlan remove [find where bridge=$fitiOverlayBridge comment~"Wi-Fi Fiti VLAN overlay tagged trunk ${baseId}"] } on-error={}; :do { /ip hotspot remove [find where name="${tag}-hotspot"] } on-error={}; :do { /ip hotspot profile remove [find where name="${tag}-hsprof"] } on-error={}; :do { /ip dhcp-server network remove [find where comment="Wi-Fi Fiti VLAN overlay DHCP network"] } on-error={}; :do { /ip dhcp-server remove [find where name="${tag}-dhcp"] } on-error={}; :do { /ip pool remove [find where name="${tag}-pool"] } on-error={}; :do { /ip address remove [find where comment="Wi-Fi Fiti VLAN overlay hotspot gateway"] } on-error={}; :do { /ip firewall nat remove [find where comment="Wi-Fi Fiti VLAN overlay NAT ${baseId}"] } on-error={}; :do { /ip firewall filter remove [find where comment="Wi-Fi Fiti VLAN overlay DNS ${baseId}"] } on-error={}; :do { /interface vlan remove [find where name="${tag}-management" || name="${tag}-hotspot" || name="${tag}-pppoe" || name="${tag}-tv"] } on-error={}; :do { /interface bridge set $fitiOverlayBridge vlan-filtering=$fitiOverlayOriginalFiltering } on-error={}` : '',
    '  :log warning ("Wi-Fi Fiti VLAN overlay stopped: " . $fitiVlanOverlayError)',
    '  :put ("Wi-Fi Fiti VLAN overlay stopped: " . $fitiVlanOverlayError)',
    '}',
    '',
  ].filter(Boolean).join('\n');
  return input + '\n' + block;
}

module.exports = { compatibilityRouterKit, telemetryTestRouterKit, vlanTestRouterKit, vlanOverlayRouterKit };

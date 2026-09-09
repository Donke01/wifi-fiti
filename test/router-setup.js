'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateRouterSetup,
  buildRouterSetup,
} = require('../src/lib/router-setup');
const { remoteSupportControlToScript, buildRemoteSupportScript, mappedDeploymentControl } = require('../src/lib/rsc');

const location = { id: 'loc-router-setup-test', name: 'Test location' };
const appUrl = 'https://cloud.wififiti.co.ke';
const token = 'router-pairing-token-for-tests-only';

function kit(input) {
  return buildRouterSetup({ location, token, appUrl, input });
}

function expectInvalid(input, message) {
  assert.throws(() => validateRouterSetup(input), (error) => error && error.status === 400, message);
}

const existing = {
  mode: 'existing', routerOsVersion: '7', customerBridge: 'guest-bridge', hotspotServer: 'guest-hotspot',
};

const newRouter = {
  mode: 'new', routerOsVersion: '7', modelProfile: 'hap-lite', routerModel: 'hAP lite',
  customerBridge: 'bridge-hs', hotspotServer: 'hotspot1', wanInterface: 'ether1',
  wifiInterface: 'wlan1', customerPorts: 'ether2,ether3,ether4',
  wifiSsid: 'Fiti Guest WiFi', wifiPassword: 'SafeWifiPass9', freshRouterConfirmed: 'yes', customerSubnet: '10.5.50.0/24', wanMode: 'dhcp',
};

const existingKit = kit(existing);
assert.equal(existingKit.config.mode, 'existing');
assert.match(existingKit.script, /existing-router pairing kit/);
assert.match(existingKit.script, /:global fitiBridge "guest-bridge"/);
assert.match(existingKit.script, /:global fitiHotspotServer "guest-hotspot"/);
assert.match(existingKit.script, /:global fitiSupportEnabled "no"/);
assert.match(existingKit.script, /:global fitiSupportEnrollUrl "https:\/\/cloud\.wififiti\.co\.ke\/api\/router\/support-enroll"/);
assert.match(existingKit.script, /:global fitiSupportInterface "fiti-support-wg"/);
assert.match(existingKit.script, /:global fitiSetupProtocol "2"/);
assert.match(existingKit.script, /check-certificate=yes/);
assert.match(existingKit.script, /builtin-trust-store=all/,
  'the generated kit enables RouterOS built-in CAs before its first HTTPS fetch');
assert.match(existingKit.script, /builtin-trust-anchors=trusted/,
  'older RouterOS 7 releases receive the legacy trust-store fallback');
assert.doesNotMatch(existingKit.script, /:global fitiSupportEnabled "yes"/);
assert.match(existingKit.script, /tenant-router-install\.rsc/);
assert.match(existingKit.script, /\/system scheduler add name="fiti-first-install" start-date=1970-01-01 start-time=00:00:00 interval=15s[\s\S]*on-event=\{/,
  'existing-router pairing also uses the scheduler-owned retry bootstrap');
assert.doesNotMatch(existingKit.script, /\/system script add name="fiti-first-install"/,
  'existing-router retries do not depend on a helper script that may disappear');
assert.match(existingKit.script, /selected Hotspot server is not on the selected customer bridge/);
assert.doesNotMatch(existingKit.script, /\/ip address add|\/system reset-configuration|\/ip service/);
const installer = fs.readFileSync(path.join(__dirname, '../public/tenant-router-install.rsc'), 'utf8');
assert.match(installer, /X-WiFi-Fiti-Router/);
assert.doesNotMatch(installer, /[?&]token=/);
assert.match(installer, /fiti-support-bootstrap/);
assert.match(installer, /\/interface wireguard add name=\\\$fitiSupportInterface disabled=yes/);
assert.match(installer, /public-key/);
assert.match(installer, /WiFi Fiti support public key/);
assert.match(installer, /api\/router\/support-enroll/);
assert.match(installer, /fitiSupportExpectedUrl/);
assert.match(installer, /\/system scheduler add name=fiti-support-enroll interval=1h disabled=yes/);
assert.match(installer, /:global fitiSupportAck ""/);
assert.match(installer, /:global fitiSetupAck ""/);
assert.match(installer, /:global fitiSetupProtocol/);
assert.match(installer, /fitiPortalAppliedHost/);
assert.match(installer, /&hotspot=.*fitiHotspotServer/,
  'router sync reports an automatically detected Hotspot name');
assert.match(installer, /&bridge=.*fitiBridge/,
  'router sync reports an automatically detected customer bridge');
assert.match(installer, /check-certificate=yes/);
assert.match(installer, /builtin-trust-store=all/,
  'the downloaded installer enables built-in CAs before fetching the portal');
assert.match(installer, /fitiJobError/,
  'polling captures the actual RouterOS parse error instead of hiding it');
assert.match(installer, /job script failed to run: /,
  'polling includes the captured parse error in the router log');
assert.match(installer, /&supportAck=/);
const bootSource = installer.slice(installer.indexOf('/system script add name=fiti-boot'), installer.indexOf('# --- Optional remote-support'));
assert.match(bootSource, /fiti-support-enroll/);
assert.match(bootSource, /\/system scheduler disable/,
  'a reboot restores the dormant scheduler state');
assert.match(bootSource, /fitiHotspotServer/,
  'a reboot restores the Hotspot server used by the health check');
assert.doesNotMatch(installer, /\/interface wireguard peers/);
assert.doesNotMatch(installer, /persistent-keepalive/);
assert.doesNotMatch(installer, /\[:parse \\$fitiSupportReply\]/);
assert.doesNotMatch(installer, /:local fitiSupportReply/);
const supportSource = installer.slice(installer.indexOf(':local fitiSupportSource'), installer.indexOf('/system scheduler add name=fiti-globals'));
assert.match(supportSource, /:if \(\\\$fitiSupportEnabled = \\"yes\\"\) do=\{/,
  'a persisted disabled interface must never restart support work by itself');
assert.doesNotMatch(supportSource, /fitiSupportEnabled = \\"yes\\"\) \|\|/,
  'only an explicit prepare control may run the dormant bootstrap');
assert.match(supportSource, /:error \\"fiti support: enrollment failed\\"/,
  'a failed public-key report must leave prepare unacknowledged for a safe retry');
assert.match(supportSource, /output=none/,
  'the empty enrollment acknowledgement is not parsed or stored on the router');
assert.doesNotMatch(supportSource, /\/ip (?:address|route|firewall|service) /);
assert.doesNotMatch(supportSource, /endpoint-address|endpoint-port/);
const pollSource = installer.slice(installer.indexOf('/system script add name=fiti-poll'), installer.indexOf('# --- Restore settings at boot'));
assert.match(pollSource, /fitiSupportAck/);
assert.match(pollSource, /fiti-topology-v1/,
  'the paired poller can report a bounded router topology through its existing outbound sync');
assert.match(pollSource, /fitiTopologyTick >= 6/,
  'inventory is sampled periodically instead of adding work to every five-second billing poll');
assert.match(pollSource, /fitiTopologySafe/,
  'only delimiter-safe router interface labels are emitted into the topology grammar');
assert.match(pollSource, /\/interface ethernet find/);
assert.match(pollSource, /\/interface bridge port find/);
assert.match(pollSource, /topo\|wifi\|/,
  'the report distinguishes Wi-Fi stack/interface state from generic interfaces');
assert.doesNotMatch(pollSource, /private-key|password|security-profile|mac-address|\/ip address|\/ip route/i,
  'topology telemetry excludes credentials, hardware addresses and L3/route data');
assert.match(pollSource, /:global fitiPortalHost/,
  'the polling script retains the current customer portal host');
assert.match(pollSource, /&portal=\\\" \. \\\$/,
  'each sync reports the customer portal host so the cloud can safely refresh it');
assert.doesNotMatch(pollSource, /fitiSupportEnabled|support-enroll|wireguard|fiti-support/);
assert.match(pollSource, /:onerror fitiSyncError in=\{/,
  'a failed cloud fetch retains RouterOS’s exact error instead of collapsing it to “unreachable”');
assert.match(pollSource, /fiti: cloud sync failed: /,
  'the sync error is emitted without exposing the router credential');
assert.doesNotMatch(pollSource, /fiti: server unreachable/,
  'the generic fetch error is replaced by the captured RouterOS error');
assert.ok(pollSource.includes('status\\") = \\"finished'),
  'the watchdog accepts the documented successful Fetch result');
assert.doesNotMatch(pollSource, /fitiSyncCode|\$reply->\\\"code\\\"/,
  'RouterOS exposes HTTP codes through its fetch-error path, not a successful as-value result');
assert.match(pollSource, /:local fitiFirstInstallScheduler/,
  'the installed poller owns completion of the bootstrap watchdog');
assert.match(pollSource, /fitiFirstInstallComment/,
  'only the WiFi Fiti-owned bootstrap scheduler is eligible for modification');
assert.match(pollSource, /WiFi Fiti: retry cloud installer/,
  'the watchdog guard matches the scheduler created by the generated kit');
assert.match(pollSource, /\/system scheduler disable \\\$fitiFirstInstallScheduler/,
  'only the named first-install scheduler is disabled after a verified poll');
assert.match(pollSource, /fiti: cloud sync verified; first-install retry disabled/,
  'the router log makes the successful handoff observable');
assert.ok(
  pollSource.indexOf(':if (\\$ok) do={') < pollSource.indexOf('fitiFirstInstallScheduler'),
  'the bootstrap watchdog cannot be disabled before a successful cloud sync'
);

const prepareSupport = remoteSupportControlToScript({ id: 91, action: 'prepare' });
assert.match(prepareSupport, /:global fitiSupportEnabled "yes"/);
assert.match(prepareSupport, /\/system script run \$fitiSupportBootstrap/);
assert.match(prepareSupport, /:global fitiSupportAck "91"/);
assert.doesNotMatch(prepareSupport, /\/ip (?:hotspot|address|route|firewall|service)\b/);
assert.doesNotMatch(prepareSupport, /(?:peers|endpoint-address|endpoint-port|persistent-keepalive)/);

const gatewayPublicKey = Buffer.alloc(32, 9).toString('base64');
const activateSupport = remoteSupportControlToScript({
  id: 92,
  action: 'activate',
  gatewayPublicKey,
  endpointHost: 'vpn.wififiti.co.ke',
  endpointPort: 51820,
  managementAddress: '10.254.0.23/32',
  gatewayAddress: '10.254.0.1/32',
  configVersion: '2026.09.09-1',
});
assert.match(activateSupport, /fiti-support-wg/);
assert.match(activateSupport, new RegExp(gatewayPublicKey.replace(/[+/]/g, '\\$&')));
assert.match(activateSupport, /activation needs the prepared WireGuard interface/);
assert.doesNotMatch(activateSupport, /\/interface wireguard add/,
  'activation never rotates the prepared router key after the gateway accepted it');
assert.match(activateSupport, /endpoint-address=\$fitiSupportEndpoint endpoint-port=\$fitiSupportEndpointPort/);
assert.match(activateSupport, /allowed-address=\$fitiSupportGateway persistent-keepalive=25s/,
  'only the gateway /32 is permitted through the peer, with an outbound keepalive');
assert.match(activateSupport, /\/ip address (?:add|set).*fitiSupportAddress/,
  'the router receives only its assigned management /32');
assert.match(activateSupport, /\/ip route (?:add|set).*dst-address=\$fitiSupportGateway gateway=\$fitiSupportInterface/,
  'RouterOS receives only the explicit gateway /32 return route');
assert.match(activateSupport, /\/ip firewall filter (?:add|set).*chain=input action=accept in-interface=\$fitiSupportInterface src-address=\$fitiSupportGateway/,
  'management input is constrained to the authenticated gateway source');
assert.match(activateSupport, /WiFi Fiti VPN: gateway peer/);
assert.match(activateSupport, /WiFi Fiti VPN: management address/);
assert.match(activateSupport, /WiFi Fiti VPN: gateway route/);
assert.match(activateSupport, /WiFi Fiti VPN: gateway input/);
assert.match(activateSupport, /:global fitiSupportAck "92"/,
  'activation uses the separate support acknowledgement only after configuration succeeds');
assert.doesNotMatch(activateSupport, /private-key|0\.0\.0\.0\/0|\/ip firewall nat|\/ip hotspot|\/ip service|customer gateway/i,
  'an activation control cannot reroute customers, alter the Hotspot, add NAT, or expose a service');

assert.equal(remoteSupportControlToScript({
  id: 93, action: 'activate', gatewayPublicKey,
  endpointHost: 'vpn.wififiti.co.ke"; /system reboot', endpointPort: 51820,
  managementAddress: '10.254.0.23/32', gatewayAddress: '10.254.0.1/32', configVersion: '1',
}), null, 'an endpoint injection is rejected before it becomes RouterOS source');
assert.equal(remoteSupportControlToScript({
  id: 94, action: 'activate', gatewayPublicKey,
  endpointHost: 'vpn.wififiti.co.ke', endpointPort: 51820,
  managementAddress: '10.5.50.23/32', gatewayAddress: '10.254.0.1/32', configVersion: '1',
}), null, 'a customer-LAN address cannot become a support-interface address');
assert.equal(remoteSupportControlToScript({
  id: 95, action: 'activate', gatewayPublicKey,
  endpointHost: 'vpn.wififiti.co.ke', endpointPort: 51820,
  managementAddress: '10.254.0.23/32', gatewayAddress: '0.0.0.0/0', configVersion: '1',
}), null, 'a default route cannot be smuggled into an activation control');
assert.equal(remoteSupportControlToScript({
  id: 96, action: 'activate', gatewayPublicKey,
  endpointHost: 'vpn.wififiti.co.ke', endpointPort: 51820,
  managementAddress: '10.254.0.23/32', gatewayAddress: '10.254.0.1/32', configVersion: '1;reboot',
}), null, 'a configuration version is not an arbitrary RouterOS interpolation point');

const revokeSupport = remoteSupportControlToScript({ id: 92, action: 'revoke' });
assert.match(revokeSupport, /:global fitiSupportEnabled "no"/);
assert.match(revokeSupport, /:global fitiSupportInterface/);
assert.match(revokeSupport, /name=\$fitiSupportInterface/);
assert.match(revokeSupport, /\/system scheduler disable \$fitiSupportScheduler/);
assert.match(revokeSupport, /\/ip firewall filter remove \$fitiSupportFirewall/);
assert.match(revokeSupport, /\/ip route remove \$fitiSupportRoute/);
assert.match(revokeSupport, /\/ip address remove \$fitiSupportAddress/);
assert.match(revokeSupport, /\/interface wireguard peers remove \$fitiSupportPeer/);
assert.match(revokeSupport, /\/interface wireguard disable \$fitiSupportWireguard/);
assert.match(revokeSupport, /\/interface wireguard remove \$fitiSupportWireguard/);
assert.match(revokeSupport, /WiFi Fiti support:/);
assert.match(revokeSupport, /WiFi Fiti VPN:/);
assert.match(revokeSupport, /:if \(\$fitiSupportCleanupOk\) do=\{ :global fitiSupportAck "92" \}/,
  'a revoke acknowledgement is emitted only after managed cleanup succeeds');
assert.match(revokeSupport, /:global fitiSupportAck "92"/);
assert.doesNotMatch(revokeSupport, /fiti-poll|\/ip hotspot|\/ip firewall nat|\/ip service|0\.0\.0\.0\/0/,
  'revoke removes only tagged tunnel resources and cannot affect customer service');
assert.doesNotMatch(revokeSupport, /endpoint-address|endpoint-port|persistent-keepalive|private-key/);
assert.equal(remoteSupportControlToScript({ id: 93, action: 'connect' }), null,
  'only prepare/activate/revoke controls may be emitted');
assert.equal(remoteSupportControlToScript({ id: 0, action: 'revoke' }), null,
  'a malformed control id must not become router code');
const supportBatch = buildRemoteSupportScript({ controls: [{ id: 97, action: 'activate', gatewayPublicKey, endpointHost: 'vpn.wififiti.co.ke', endpointPort: 51820, managementAddress: '10.254.0.23/32', gatewayAddress: '10.254.0.1/32', configVersion: '2' }, { id: 98, action: 'revoke' }, { id: 0, action: 'prepare' }] });
assert.deepEqual(supportBatch.emitted, [97, 98]);
assert.deepEqual(supportBatch.rejected, [0]);

const mappedDeployment = mappedDeploymentControl({
  id: 117,
  action: 'apply_mapped_service_v1',
  receipt: 'M'.repeat(32),
  signature: 'a'.repeat(64),
  topologyFingerprint: 'b'.repeat(64),
  hotspotServer: 'hotspot1',
  mapping: {
    version: 1,
    wanInterface: 'ether1',
    customerBridge: 'bridge-hs',
    wifiInterfaces: ['wlan1'],
    customerPorts: ['ether2', 'ether3'],
  },
});
assert.ok(mappedDeployment, 'a signed, finite mapped deployment renders a local verifier');
assert.doesNotMatch(mappedDeployment, /\/ip hotspot user profile (?:add|set)/,
  'paid jobs retain their already-selected profiles; deployment does not invent an unused profile');
assert.match(mappedDeployment, /\/ip firewall mangle add chain=postrouting out-interface=\$fitiMappedDeploymentBridge action=change-ttl new-ttl=set:1/);
assert.match(mappedDeployment, /WiFi Fiti anti-tethering/);
assert.match(mappedDeployment, /\/ip hotspot walled-garden add dst-host=\$fitiMappedDeploymentPortalHost comment=\$fitiMappedDeploymentPortalTag/);
assert.match(mappedDeployment, /:set fitiPortalAppliedHost ""/,
  'the existing safe portal refresher is prompted on the next authenticated poll');
assert.match(mappedDeployment, /\/system scheduler enable \$fitiMappedDeploymentPollScheduler/,
  'only a locally recognised WiFi Fiti polling scheduler can be enabled');
assert.match(mappedDeployment, /fiti-poll is not the recognised WiFi Fiti agent/,
  'a name collision is a safe blocked receipt rather than a remote overwrite');
assert.match(mappedDeployment, /:global fitiSupportAck "deploy\.117\./,
  'the expanded action preserves the namespaced existing acknowledgement transport');
assert.match(mappedDeployment, /WiFi Fiti service reconciliation did not complete; it will retry without changing the confirmed map/,
  'a tagged service-resource conflict is retried rather than being misreported as a stale physical map');
assert.doesNotMatch(mappedDeployment,
  /\/system (?:reset-configuration|reboot|shutdown)|\/user\b|password=|private-key|0\.0\.0\.0\/0|\/ip (?:route|address|dhcp-client|dhcp-server|firewall (?:filter|nat))|\/interface bridge port (?:add|remove|set)|\/interface (?:wifi|wireless) (?:add|set)|\/ip service\b/i,
  'mapped deployment remains unable to alter credentials, WAN/L3, bridge membership, radio settings, generic firewall policy or service exposure');
assert.equal(mappedDeploymentControl({
  id: 118,
  action: 'apply_mapped_service_v1',
  receipt: 'M'.repeat(32),
  signature: 'a'.repeat(64),
  topologyFingerprint: 'b'.repeat(64),
  hotspotServer: 'hotspot1',
  mapping: { version: 1, wanInterface: 'ether1; /system reboot', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether2'] },
}), null, 'a map value cannot become RouterOS source during the service reconciliation');

const edgeKit = buildRouterSetup({ location, token, appUrl, portalUrl: 'https://test-branch.wififiti.co.ke', input: existing });
assert.match(edgeKit.script, /:global fitiUrl "https:\/\/cloud\.wififiti\.co\.ke"/);
assert.match(edgeKit.script, /:global fitiPortalHost "test-branch\.wififiti\.co\.ke"/);
assert.match(edgeKit.script, /dst-host=\$fitiPortalHost/);
assert.match(installer, /fitiLoginUrl.*\?portal=/);

const newKit = kit(newRouter);
assert.equal(newKit.config.mode, 'new');
assert.match(newKit.script, /new\/reset RouterOS 7 setup kit/);
assert.match(newKit.script, /^:onerror fitiSetupError in=\{/,
  'the complete kit is one RouterOS transaction so local variables survive terminal paste');
assert.match(newKit.script, /\} do=\{/,
  'a setup error is caught and printed instead of leaving a silent partial import');
assert.match(newKit.script, /WiFi Fiti setup stopped: /,
  'the exact RouterOS failure is visible in the terminal and log');
assert.match(newKit.script, /\/interface wireless set/);
assert.match(newKit.script, /fitiWifiStack/);
assert.match(newKit.script, /No supported WiFi interface found/);
assert.doesNotMatch(newKit.script, /Interface wlan1 was not found/,
  'Wi-Fi is detected at runtime instead of being rejected by a static interface-name check');
assert.match(newKit.script, /:foreach fitiEther in=\[\/interface ethernet find\] do=\{/,
  'customer Ethernet ports are discovered from the router at runtime');
assert.match(newKit.script, /customer Ethernet ports: /,
  'the detected board and customer-port count are reported in the terminal');
assert.doesNotMatch(newKit.script, /Interface ether[2345] was not found/,
  'a model profile cannot reject a valid router because it has a different port count');
assert.match(newKit.script, /\/ip hotspot add name=\$fitiHotspotServer/);
assert.match(newKit.script, /\/ip firewall nat add chain=srcnat/);
assert.match(newKit.script, /\/ip pool add name="fiti-pool"/);
assert.match(newKit.script, /administrator credentials are never changed/);
assert.doesNotMatch(newKit.script, /\/user set .*password/);
assert.doesNotMatch(newKit.script, /interface="ether5"/,
  'the hAP lite profile never receives a non-existent ether5 port');
assert.match(newKit.script, /:local fitiWanDhcp \[\/ip dhcp-client find where interface=\$fitiWanInterface\]/,
  'the kit detects a DHCP client created during optional WAN preparation');
assert.match(newKit.script, /:if \(\[:len \$fitiWanDhcp\] = 0\) do=\{\n\s+\/ip dhcp-client add interface=\$fitiWanInterface disabled=no add-default-route=yes use-peer-dns=yes comment="WiFi Fiti WAN"\n\s+\} else=\{\n\s+\/ip dhcp-client set \$fitiWanDhcp disabled=no add-default-route=yes use-peer-dns=yes comment="WiFi Fiti WAN"\n\s+\}/,
  'the kit creates or adopts the WAN DHCP client and honours reachable ISP DNS');
assert.match(newKit.script, /RouterOS device mode blocks a required WiFi Fiti feature/,
  'a blocked device-mode feature stops before a router can be half-configured');
assert.match(newKit.script, /fetch=yes scheduler=yes hotspot=yes/,
  'the kit gives the owner the narrow physical-confirmation command for required features');
assert.match(newKit.script, /RouterOS has flagged this configuration/,
  'a flagged router is stopped before a scheduler or portal can be partially replaced');
assert.ok(newKit.script.indexOf(':local fitiDeviceFetch') < newKit.script.indexOf(':global fitiUrl'),
  'the device-mode preflight runs before staged router globals can affect an existing poller');
assert.doesNotMatch(newKit.script, /servers=1\.1\.1\.1,8\.8\.8\.8/,
  'DHCP onboarding does not force public resolvers that an upstream may block');
assert.doesNotMatch(newKit.script, /XenFi WAN/,
  'generated router configuration remains WiFi Fiti-branded after WAN preparation');

const automaticKit = kit({ mode: 'auto', routerOsVersion: '7', wifiSsid: 'Automatic Guest WiFi', wifiPassword: 'SafeWifiPass9', customerSubnet: '10.5.52.0/24', wanMode: 'dhcp' });
assert.equal(automaticKit.config.mode, 'auto');
assert.match(automaticKit.script, /automatic RouterOS 7 setup kit/);
assert.match(automaticKit.script, /Multiple Hotspot servers found/);
assert.match(automaticKit.script, /A bridge exists but no Hotspot server was found/);
assert.ok(automaticKit.script.indexOf(':local fitiDeviceFetch') < automaticKit.script.indexOf(':global fitiUrl'),
  'automatic setup checks device mode before recording any new pairing credential');
assert.match(automaticKit.script, /\[\/interface wireless find\]/,
  'automatic setup discovers a reset radio even while RouterOS leaves it disabled');
assert.match(automaticKit.script, /\[\/interface wifi find\]/,
  'automatic setup discovers a reset modern WiFi radio even while it is disabled');
assert.doesNotMatch(automaticKit.script, /find where disabled=no/,
  'a no-defaults reset must not be rejected just because its WiFi interface starts disabled');
assert.match(automaticKit.script, /customer Ethernet ports:/);
assert.match(automaticKit.script, /existing DHCP-server or NAT configuration/);
assert.match(automaticKit.script, /existing non-DHCP IP configuration/);
assert.match(automaticKit.script, /A DHCP client already exists on another interface/);
assert.match(automaticKit.script, /fitiBootstrapHotspots/);
assert.match(automaticKit.config.mode === 'auto' ? automaticKit.summary : '', /safely chooses the existing-router or fresh-router setup/,
  'automatic setup explains the detection decision');
assert.match(newKit.script, /block WAN management/);
assert.match(newKit.script, /\/system scheduler add name="fiti-first-install" start-date=1970-01-01 start-time=00:00:00 interval=15s/);
assert.match(newKit.script, /on-event=\{\n\s*:do \{\n\s*\/certificate settings set builtin-trust-store=all/,
  'the first-install scheduler contains the bootstrap source instead of depending on a second RouterOS script');
assert.doesNotMatch(newKit.script, /\/system script add name="fiti-first-install"/,
  'there is no transient helper script for the scheduler to lose after a partial import');
assert.doesNotMatch(newKit.script, /on-event="\/system script run fiti-first-install"/,
  'the retry scheduler cannot become an orphan that repeatedly calls a missing script');
assert.match(newKit.script, /\/system scheduler run \[find where name="fiti-first-install"\]/,
  'the initial pairing attempt exercises the same self-contained scheduler event used by retries');
assert.ok(
  newKit.script.indexOf('/system scheduler remove [find where name="fiti-first-install"]') < newKit.script.indexOf('/system script remove [find where name="fiti-first-install"]'),
  'an older retry scheduler is removed before its legacy helper script, avoiding one last orphaned execution race'
);
assert.match(newKit.script, /fiti: cloud pairing retry:/,
  'bootstrap failures retain the RouterOS error instead of being mislabelled as DNS');
assert.match(newKit.script, /cloud installer imported; waiting for first secure sync/,
  'the installer watchdog remains active until the polling agent proves cloud reachability');
assert.match(newKit.script, /\/file remove \[find where name="fiti-tenant-install\.rsc"\] } on-error=\{\}/,
  'a retry removes any retained installer file before downloading a fresh cloud agent');
assert.match(newKit.script, /Fresh WiFi Fiti cloud installer was not downloaded/,
  'a failed download is diagnosed instead of importing an obsolete retained file');
assert.ok(newKit.script.indexOf('/file remove [find where name="fiti-tenant-install.rsc"] } on-error={}') < newKit.script.indexOf('/tool fetch url='),
  'retained installer cleanup happens before the first cloud fetch');
assert.ok(newKit.script.indexOf('Fresh WiFi Fiti cloud installer was not downloaded') < newKit.script.indexOf('/import file-name="fiti-tenant-install.rsc"'),
  'the retry verifies that a fresh file exists before it imports anything');
assert.ok(newKit.script.indexOf('/system scheduler run [find where name="fiti-first-install"]') < newKit.script.indexOf('/tool mac-server set'),
  'MAC management restrictions run only after the critical pairing scheduler is installed and started');
assert.doesNotMatch(newKit.script, /\/system reset-configuration|\/ip service|\/user add/);
assert.match(installer, /\/system scheduler add name=fiti-poll start-date=1970-01-01 start-time=00:00:00 interval=5s disabled=no/,
  'the installed polling agent starts from a clock-safe epoch schedule after every reboot');
assert.match(installer, /RouterOS device mode blocks a required WiFi Fiti feature/,
  'the downloaded installer also fails clearly before a partial Hotspot change on a blocked router');

const modernKit = kit({ ...newRouter, modelProfile: 'modern-wifi', routerModel: 'Modern WiFi router', wifiInterface: 'wifi1' });
assert.match(modernKit.script, /\/interface wifi set/);
assert.match(modernKit.script, /\/interface wireless find/,
  'the modern kit probes both RouterOS Wi-Fi stacks before selecting the right one');

const staticKit = kit({
  ...newRouter,
  wanMode: 'static', staticWanAddress: '192.168.1.2/24', staticWanGateway: '192.168.1.1', dnsServers: '9.9.9.9,1.1.1.1',
});
assert.match(staticKit.script, /servers=9\.9\.9\.9,1\.1\.1\.1/);
assert.doesNotMatch(staticKit.script, /servers=1\.1\.1\.1,8\.8\.8\.8/);

expectInvalid({ ...existing, customerBridge: 'bridge-hs; /system reboot' }, 'RouterOS injection is rejected');
expectInvalid({ ...newRouter, wanInterface: 'ether2' }, 'WAN cannot be a customer port');
expectInvalid({ ...newRouter, customerSubnet: '8.8.8.0/24' }, 'Customer network must be private');
expectInvalid({ ...newRouter, wifiPassword: 'has spaces' }, 'WiFi secret must be shell-safe');
expectInvalid({ ...newRouter, freshRouterConfirmed: 'no' }, 'fresh router setup requires explicit confirmation');
expectInvalid({ ...newRouter, wanMode: 'static', staticWanAddress: '192.168.1.2/24', staticWanGateway: '192.168.2.1', dnsServers: '1.1.1.1' }, 'static gateway must share its subnet');
expectInvalid({ ...newRouter, wanMode: 'static', staticWanAddress: '10.5.50.2/24', staticWanGateway: '10.5.50.1', dnsServers: '1.1.1.1' }, 'static WAN must not overlap the Hotspot network');
expectInvalid({ ...newRouter, routerOsVersion: '6' }, 'unsupported RouterOS version is rejected');

console.log('Router setup: safe existing and new-router kits passed.');

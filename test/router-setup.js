'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateRouterSetup,
  buildRouterSetup,
} = require('../src/lib/router-setup');
const { remoteSupportControlToScript, buildRemoteSupportScript } = require('../src/lib/rsc');

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
assert.match(pollSource, /:global fitiPortalHost/,
  'the polling script retains the current customer portal host');
assert.match(pollSource, /&portal=\\\" \. \\\$/,
  'each sync reports the customer portal host so the cloud can safely refresh it');
assert.doesNotMatch(pollSource, /fitiSupportEnabled|support-enroll|wireguard|fiti-support/);

const prepareSupport = remoteSupportControlToScript({ id: 91, action: 'prepare' });
assert.match(prepareSupport, /:global fitiSupportEnabled "yes"/);
assert.match(prepareSupport, /\/system script run \$fitiSupportBootstrap/);
assert.match(prepareSupport, /:global fitiSupportAck "91"/);
assert.doesNotMatch(prepareSupport, /\/ip (?:hotspot|address|route|firewall|service)\b/);
assert.doesNotMatch(prepareSupport, /(?:peers|endpoint-address|endpoint-port|persistent-keepalive)/);

const revokeSupport = remoteSupportControlToScript({ id: 92, action: 'revoke' });
assert.match(revokeSupport, /:global fitiSupportEnabled "no"/);
assert.match(revokeSupport, /:global fitiSupportInterface/);
assert.match(revokeSupport, /name=\$fitiSupportInterface/);
assert.match(revokeSupport, /\/system scheduler disable \$fitiSupportScheduler/);
assert.match(revokeSupport, /\/interface wireguard disable \$fitiSupportWireguard/);
assert.match(revokeSupport, /\/interface wireguard remove \$fitiSupportWireguard/);
assert.match(revokeSupport, /WiFi Fiti support:/);
assert.match(revokeSupport, /:if \(\$fitiSupportCleanupOk\) do=\{ :global fitiSupportAck "92" \}/,
  'a revoke acknowledgement is emitted only after managed cleanup succeeds');
assert.match(revokeSupport, /:global fitiSupportAck "92"/);
assert.doesNotMatch(revokeSupport, /fiti-poll|\/ip (?:hotspot|address|route|firewall|service)\b/);
assert.doesNotMatch(revokeSupport, /(?:peers|endpoint-address|endpoint-port|persistent-keepalive)/);
assert.equal(remoteSupportControlToScript({ id: 93, action: 'connect' }), null,
  'only inert prepare/revoke controls may be emitted');
assert.equal(remoteSupportControlToScript({ id: 0, action: 'revoke' }), null,
  'a malformed control id must not become router code');
const supportBatch = buildRemoteSupportScript({ controls: [{ id: 94, action: 'revoke' }, { id: 0, action: 'prepare' }] });
assert.deepEqual(supportBatch.emitted, [94]);
assert.deepEqual(supportBatch.rejected, [0]);

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
assert.match(newKit.script, /:if \(\[:len \$fitiWanDhcp\] = 0\) do=\{\n\s+\/ip dhcp-client add interface=\$fitiWanInterface disabled=no add-default-route=yes use-peer-dns=no comment="WiFi Fiti WAN"\n\s+\} else=\{\n\s+\/ip dhcp-client set \$fitiWanDhcp disabled=no add-default-route=yes use-peer-dns=no comment="WiFi Fiti WAN"\n\s+\}/,
  'the kit creates or adopts the WAN DHCP client without a duplicate-client failure');
assert.doesNotMatch(newKit.script, /XenFi WAN/,
  'generated router configuration remains WiFi Fiti-branded after WAN preparation');

const automaticKit = kit({ mode: 'auto', routerOsVersion: '7', wifiSsid: 'Automatic Guest WiFi', wifiPassword: 'SafeWifiPass9', customerSubnet: '10.5.52.0/24', wanMode: 'dhcp' });
assert.equal(automaticKit.config.mode, 'auto');
assert.match(automaticKit.script, /automatic RouterOS 7 setup kit/);
assert.match(automaticKit.script, /Multiple Hotspot servers found/);
assert.match(automaticKit.script, /A bridge exists but no Hotspot server was found/);
assert.match(automaticKit.script, /\[\/interface wireless find where disabled=no\]/);
assert.match(automaticKit.script, /\[\/interface wifi find where disabled=no\]/);
assert.match(automaticKit.script, /customer Ethernet ports:/);
assert.match(automaticKit.script, /existing DHCP-server or NAT configuration/);
assert.match(automaticKit.script, /existing non-DHCP IP configuration/);
assert.match(automaticKit.script, /A DHCP client already exists on another interface/);
assert.match(automaticKit.script, /fitiBootstrapHotspots/);
assert.match(automaticKit.config.mode === 'auto' ? automaticKit.summary : '', /safely chooses the existing-router or fresh-router setup/,
  'automatic setup explains the detection decision');
assert.match(newKit.script, /block WAN management/);
assert.match(newKit.script, /\/system scheduler add name="fiti-first-install" interval=15s/);
assert.match(newKit.script, /fiti: waiting for WAN\/DNS before cloud pairing/);
assert.ok(newKit.script.indexOf('/system script run fiti-first-install') < newKit.script.indexOf('/tool mac-server set'),
  'MAC management restrictions run only after the critical pairing script is installed');
assert.doesNotMatch(newKit.script, /\/system reset-configuration|\/ip service|\/user add/);

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

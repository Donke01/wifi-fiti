'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateRouterSetup,
  buildRouterSetup,
} = require('../src/lib/router-setup');

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
  wifiSsid: 'Fiti Guest WiFi', wifiPassword: 'SafeWifiPass9', routerAdminPassword: 'AdminSetupPass9', customerSubnet: '10.5.50.0/24', wanMode: 'dhcp',
};

const existingKit = kit(existing);
assert.equal(existingKit.config.mode, 'existing');
assert.match(existingKit.script, /existing-router pairing kit/);
assert.match(existingKit.script, /:global fitiBridge "guest-bridge"/);
assert.match(existingKit.script, /:global fitiHotspotServer "guest-hotspot"/);
assert.match(existingKit.script, /tenant-router-install\.rsc/);
assert.match(existingKit.script, /selected Hotspot server is not on the selected customer bridge/);
assert.doesNotMatch(existingKit.script, /\/ip address add|\/system reset-configuration|\/ip service/);
const installer = fs.readFileSync(path.join(__dirname, '../public/tenant-router-install.rsc'), 'utf8');
assert.match(installer, /X-WiFi-Fiti-Router/);
assert.doesNotMatch(installer, /[?&]token=/);

const edgeKit = buildRouterSetup({ location, token, appUrl, portalUrl: 'https://test-branch.wififiti.co.ke', input: existing });
assert.match(edgeKit.script, /:global fitiUrl "https:\/\/cloud\.wififiti\.co\.ke"/);
assert.match(edgeKit.script, /:global fitiPortalHost "test-branch\.wififiti\.co\.ke"/);
assert.match(edgeKit.script, /dst-host=\$fitiPortalHost/);
assert.match(installer, /fitiLoginUrl.*\?portal=/);

const newKit = kit(newRouter);
assert.equal(newKit.config.mode, 'new');
assert.match(newKit.script, /new\/reset RouterOS 7 setup kit/);
assert.match(newKit.script, /\/interface wireless set/);
assert.match(newKit.script, /\/ip hotspot add name=\$fitiHotspotServer/);
assert.match(newKit.script, /\/ip firewall nat add chain=srcnat/);
assert.match(newKit.script, /\/ip pool add name="fiti-pool"/);
assert.match(newKit.script, /\/user set \[find where name="admin"\] password="AdminSetupPass9"/);
assert.match(newKit.script, /block WAN management/);
assert.match(newKit.script, /\/system scheduler add name="fiti-first-install" interval=15s/);
assert.match(newKit.script, /fiti: waiting for WAN\/DNS before cloud pairing/);
assert.doesNotMatch(newKit.script, /\/system reset-configuration|\/ip service|\/user add/);

const modernKit = kit({ ...newRouter, modelProfile: 'modern-wifi', routerModel: 'Modern WiFi router', wifiInterface: 'wifi1' });
assert.match(modernKit.script, /\/interface wifi set/);
assert.doesNotMatch(modernKit.script, /\/interface wireless set/);

const staticKit = kit({
  ...newRouter,
  wanMode: 'static', staticWanAddress: '192.168.1.2/24', staticWanGateway: '192.168.1.1', dnsServers: '9.9.9.9,1.1.1.1',
});
assert.match(staticKit.script, /servers=9\.9\.9\.9,1\.1\.1\.1/);
assert.doesNotMatch(staticKit.script, /servers=1\.1\.1\.1,8\.8\.8\.8/);

const generatedPasswordKit = kit({ ...newRouter, routerAdminPassword: '' });
assert.match(generatedPasswordKit.script, /Router administrator login: admin \/ [A-Za-z0-9!#%&*+,.@_-]{12,}/);

expectInvalid({ ...existing, customerBridge: 'bridge-hs; /system reboot' }, 'RouterOS injection is rejected');
expectInvalid({ ...newRouter, customerPorts: 'ether1,ether2' }, 'WAN cannot be a customer port');
expectInvalid({ ...newRouter, customerSubnet: '8.8.8.0/24' }, 'Customer network must be private');
expectInvalid({ ...newRouter, wifiPassword: 'has spaces' }, 'WiFi secret must be shell-safe');
expectInvalid({ ...newRouter, routerAdminPassword: 'short-pass' }, 'router administrator password must be strong');
expectInvalid({ ...newRouter, wanMode: 'static', staticWanAddress: '192.168.1.2/24', staticWanGateway: '192.168.2.1', dnsServers: '1.1.1.1' }, 'static gateway must share its subnet');
expectInvalid({ ...newRouter, wanMode: 'static', staticWanAddress: '10.5.50.2/24', staticWanGateway: '10.5.50.1', dnsServers: '1.1.1.1' }, 'static WAN must not overlap the Hotspot network');
expectInvalid({ ...newRouter, routerOsVersion: '6' }, 'unsupported RouterOS version is rejected');

console.log('Router setup: safe existing and new-router kits passed.');

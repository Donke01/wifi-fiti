'use strict';

const assert = require('node:assert/strict');
const { captiveDiscoveryForLocation, DISCOVERY_TEMPLATE_VERSION, DISCOVERY_ROLLBACK_TEMPLATE_VERSION } = require('../src/lib/captive-discovery');
const { renderRouterCaptiveApi } = require('../src/lib/router-captive-api');

const names = [
  'FITI_CAPTIVE_DISCOVERY_V2_LOCATIONS',
  'FITI_CAPTIVE_DISCOVERY_ROLLBACK_LOCATIONS',
  'FITI_CAPTIVE_DISCOVERY_DNS_NAME',
  'FITI_CAPTIVE_DISCOVERY_CERTIFICATE',
];
for (const name of names) delete process.env[name];

assert.deepEqual(captiveDiscoveryForLocation('loc-pilot'), { mode: 'disabled', version: null },
  'discovery must fail closed until its location, hostname, and certificate are all explicit');
process.env.FITI_CAPTIVE_DISCOVERY_V2_LOCATIONS = 'loc-pilot';
process.env.FITI_CAPTIVE_DISCOVERY_DNS_NAME = 'router-1.example.net';
process.env.FITI_CAPTIVE_DISCOVERY_CERTIFICATE = 'router-1.example.net';
assert.deepEqual(captiveDiscoveryForLocation('loc-pilot'), {
  mode: 'enabled', dnsName: 'router-1.example.net', certificate: 'router-1.example.net', version: DISCOVERY_TEMPLATE_VERSION,
});
assert.deepEqual(captiveDiscoveryForLocation('loc-other'), { mode: 'disabled', version: null },
  'a pilot must not change other locations');
process.env.FITI_CAPTIVE_DISCOVERY_ROLLBACK_LOCATIONS = 'loc-pilot';
assert.deepEqual(captiveDiscoveryForLocation('loc-pilot'), { mode: 'disabled', version: null },
  'contradictory enable and rollback lists must not alter a router');
process.env.FITI_CAPTIVE_DISCOVERY_V2_LOCATIONS = '';
assert.deepEqual(captiveDiscoveryForLocation('loc-pilot'), {
  mode: 'rollback', dnsName: 'router-1.example.net', certificate: 'router-1.example.net', version: DISCOVERY_ROLLBACK_TEMPLATE_VERSION,
});
process.env.FITI_CAPTIVE_DISCOVERY_DNS_NAME = 'not a hostname';
assert.deepEqual(captiveDiscoveryForLocation('loc-pilot'), { mode: 'disabled', version: null },
  'unsafe RouterOS source must never be generated from environment text');
for (const name of names) delete process.env[name];

const api = renderRouterCaptiveApi();
assert.match(api, /"captive": \$\(if logged-in == 'yes'\)false/, 'RouterOS decides captive state natively');
assert.match(api, /"user-portal-url": "\$\(link-login-only\)"/, 'the API supplies the HotSpot login URL');
assert.match(api, /"can-extend-session": true/, 'devices may present the existing payment portal');
assert.doesNotMatch(api, /seconds-remaining|remaining-time/i,
  'wall-clock billing never masquerades as RouterOS session uptime');

console.log('captive discovery tests passed');

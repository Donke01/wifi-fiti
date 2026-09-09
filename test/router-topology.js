'use strict';

/*
 * Narrow parser/mapping unit tests. The full HTTP ownership and poll path is
 * covered by router-topology-integration.js; these tests make the protocol
 * grammar and safety boundary obvious without starting Express.
 */

const assert = require('node:assert/strict');
const {
  parseRouterTopology,
  validateRouterMapping,
  topologyFreshAt,
} = require('../src/lib/router-topology');

const report = [
  '254712345678-AB12CD34:0:3600:1',
  'fiti-topology-v1',
  'topo|system|routeros|7.24.2',
  'topo|wan|ether1',
  'topo|hotspot|hotspot1',
  'topo|customer-bridge|bridge-hs',
  'topo|interface|ether|ether1|up',
  'topo|interface|ether|ether2|down',
  'topo|interface|ether|ether3|down',
  'topo|interface|bridge|bridge-hs|up',
  'topo|interface|wireless|wlan1|up',
  'topo|wifi|wireless|wlan1|up',
  'topo|bridge-port|bridge-hs|ether2',
  'topo|bridge-port|bridge-hs|ether3',
  'topo|bridge-port|bridge-hs|wlan1',
  'fiti-topology-end',
].join('\n') + '\n';

const parsed = parseRouterTopology(report);
assert.ok(parsed, 'a poll can carry an optional topology block');
assert.match(parsed.fingerprint, /^[a-f0-9]{64}$/);
assert.deepEqual(parsed.topology, {
  version: 1,
  routerosVersion: '7.24.2',
  wanInterface: 'ether1',
  hotspotServer: 'hotspot1',
  customerBridge: 'bridge-hs',
  interfaces: [
    { type: 'bridge', name: 'bridge-hs', state: 'up' },
    { type: 'ether', name: 'ether1', state: 'up' },
    { type: 'ether', name: 'ether2', state: 'down' },
    { type: 'ether', name: 'ether3', state: 'down' },
    { type: 'wireless', name: 'wlan1', state: 'up' },
  ],
  wifiInterfaces: [{ stack: 'wireless', name: 'wlan1', state: 'up' }],
  bridgePorts: [
    { bridge: 'bridge-hs', interface: 'ether2' },
    { bridge: 'bridge-hs', interface: 'ether3' },
    { bridge: 'bridge-hs', interface: 'wlan1' },
  ],
});
const inventoryKeys = new Set();
JSON.stringify(parsed.topology, (key, value) => { if (key) inventoryKeys.add(key); return value; });
for (const forbidden of ['password', 'privateKey', 'secret', 'token', 'mac', 'address', 'route', 'user', 'securityProfile']) {
  assert.equal(inventoryKeys.has(forbidden), false,
    `the normalized inventory must not contain a ${forbidden} field`);
}

assert.deepEqual(validateRouterMapping({
  wanInterface: 'ether1', customerBridge: 'bridge-hs',
  wifiInterfaces: ['wlan1'], customerPorts: ['ether3', 'ether2'],
}, parsed.topology), {
  version: 1, wanInterface: 'ether1', customerBridge: 'bridge-hs',
  wifiInterfaces: ['wlan1'], customerPorts: ['ether2', 'ether3'],
});

assert.throws(() => validateRouterMapping({
  wanInterface: 'ether2', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether3'],
}, parsed.topology), /WAN interface is already a member/,
  'a customer bridge port can never be confirmed as the WAN');
assert.throws(() => validateRouterMapping({
  wanInterface: 'ether1', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether99'],
}, parsed.topology), /not a detected member/,
  'arbitrary interface names cannot become a stored mapping');

assert.throws(() => parseRouterTopology(report.replace('topo|bridge-port|bridge-hs|wlan1', 'topo|bridge-port|bridge-hs|wlan1|extra')),
  /Invalid router topology bridge port/,
  'the grammar rejects appended data instead of accepting an ambiguous record');
assert.throws(() => parseRouterTopology(report.replace('topo|interface|wireless|wlan1|up', 'topo|interface|wireless|bad|name|up')),
  /Invalid router topology interface/,
  'a delimiter inside a router value cannot create a different record');
const logicalWan = parseRouterTopology(report.replace('topo|wan|ether1', 'topo|wan|pppoe-out1'));
assert.equal(logicalWan.topology.wanInterface, 'pppoe-out1',
  'a logical WAN label does not discard the physical customer-port inventory');
assert.equal(parseRouterTopology('254712345678-AB12CD34:0:3600:1\n'), null,
  'older pollers continue to work with no inventory block');
assert.equal(topologyFreshAt(new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')), true);
assert.equal(topologyFreshAt(new Date().toISOString()), true,
  'explicit ISO timestamps are not made invalid by an extra UTC suffix');
assert.equal(topologyFreshAt('2000-01-01 00:00:00'), false);

console.log('router topology tests passed');

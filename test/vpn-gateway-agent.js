'use strict';

const assert = require('node:assert/strict');
const {
  acknowledgeReport,
  configFromEnv,
  managementAllowedAddress,
  normalizeState,
  observations,
  readWireGuardStatus,
  reconcile,
  reportForState,
  validDesiredPeer,
} = require('../vpn-gateway/agent');

const alpha = Buffer.alloc(32, 11).toString('base64');
const bravo = Buffer.alloc(32, 12).toString('base64');
const unowned = Buffer.alloc(32, 13).toString('base64');
const gateway = Buffer.alloc(32, 14).toString('base64');

const showCalls = [];
const showOutput = new Map([
  ['show wg-fiti public-key', `${gateway}\n`],
  ['show wg-fiti listen-port', '51820\n'],
  ['show wg-fiti peers', `${alpha}\n${unowned}\n`],
  ['show wg-fiti allowed-ips', `${alpha}\t10.254.0.2/32\n${unowned}\t10.254.99.9/32\n`],
  ['show wg-fiti latest-handshakes', `${alpha}\t1710000000\n${unowned}\t0\n`],
  ['show wg-fiti endpoints', `${alpha}\t198.51.100.10:12345\n${unowned}\t198.51.100.11:54321\n`],
  ['show wg-fiti persistent-keepalive', `${alpha}\t25\n${unowned}\t0\n`],
]);
const showRunner = (program, args) => {
  showCalls.push([program, ...args]);
  const output = showOutput.get(args.join(' '));
  return output === undefined ? { status: 1, stdout: '', stderr: 'unknown command' } : { status: 0, stdout: output, stderr: '' };
};

const parsed = readWireGuardStatus('wg-fiti', showRunner);
assert.equal(parsed.publicKey, gateway);
assert.equal(parsed.listenPort, 51820);
assert.equal(parsed.peers.get(alpha).lastHandshakeEpoch, 1710000000);
assert.equal(parsed.peers.get(alpha).allowedIps, '10.254.0.2/32');
assert.ok(!showCalls.some((parts) => parts.includes('dump')),
  'the agent must not read a WireGuard dump, because it includes the private key');

assert.equal(managementAllowedAddress('10.254.0.2/32'), '10.254.0.2/32');
assert.equal(managementAllowedAddress('10.254.1.1/32'), '10.254.1.1/32');
assert.equal(managementAllowedAddress('10.254.0.1/32'), null, 'the gateway address is never a router peer address');
assert.equal(managementAllowedAddress('10.254.0.0/32'), null, 'reserved/network-style addresses are rejected');
assert.equal(managementAllowedAddress('10.0.0.2/32'), null, 'the agent cannot accept another private network');
assert.equal(managementAllowedAddress('10.254.0.2/24'), null, 'only an exact host /32 is accepted');

assert.deepEqual(validDesiredPeer({ publicKey: alpha, allowedAddress: '10.254.0.2/32' }), {
  publicKey: alpha,
  allowedAddress: '10.254.0.2/32',
});
assert.equal(validDesiredPeer({ publicKey: alpha, allowedAddress: '0.0.0.0/0' }), null,
  'a gateway can never accept a default-route peer');
assert.equal(validDesiredPeer({ publicKey: alpha, allowedAddress: '192.168.1.2/32' }), null,
  'a gateway can never accept an unrelated private peer address');

const legacyState = normalizeState({ version: 1, managedPeerKeys: [alpha] });
assert.deepEqual(legacyState.managedPeers, [{ publicKey: alpha, allowedAddress: null }],
  'a v1 state file keeps only known ownership during a safe migration');

assert.deepEqual(observations(parsed, {
  version: 2,
  managedPeers: [{ publicKey: alpha, allowedAddress: '10.254.0.2/32' }],
  pendingAppliedPeers: [],
  pendingRemovedPeerKeys: [],
  reportedHandshakes: {},
}), [{ publicKey: alpha, allowedAddress: '10.254.0.2/32', lastHandshakeEpoch: 1710000000 }]);

const commands = [];
const runner = (program, args) => {
  commands.push([program, ...args]);
  return { status: 0, stdout: '', stderr: '' };
};
const next = reconcile({
  interfaceName: 'wg-fiti',
  desiredPeers: [{ publicKey: bravo, allowedAddress: '10.254.0.3/32' }],
  dump: parsed,
  state: {
    version: 2,
    managedPeers: [{ publicKey: alpha, allowedAddress: '10.254.0.2/32' }],
    pendingAppliedPeers: [],
    pendingRemovedPeerKeys: [],
    reportedHandshakes: {},
  },
  run: runner,
});
assert.deepEqual(commands, [
  ['wg', 'set', 'wg-fiti', 'peer', bravo, 'allowed-ips', '10.254.0.3/32', 'persistent-keepalive', '25'],
  ['wg', 'set', 'wg-fiti', 'peer', alpha, 'remove'],
]);
assert.deepEqual(next, {
  version: 3,
  managedPeers: [{ publicKey: bravo, allowedAddress: '10.254.0.3/32' }],
  pendingAppliedPeers: [{ publicKey: bravo, allowedAddress: '10.254.0.3/32' }],
  pendingRemovedPeerKeys: [alpha],
  reportedHandshakes: {},
  desiredRevision: null,
  desiredPeers: [],
}, 'adds/removals are retained until the core has acknowledged their observed state');
assert.ok(!commands.some((parts) => parts.includes(unowned)),
  'the gateway must never remove a peer it did not record as managed');
assert.ok(!commands.flat().includes('0.0.0.0/0'),
  'the gateway must never install a default-route peer');

const confirmedDump = {
  publicKey: gateway,
  listenPort: 51820,
  peers: new Map([[bravo, {
    publicKey: bravo,
    allowedIps: '10.254.0.3/32',
    lastHandshakeEpoch: 1710000100,
    endpoint: '198.51.100.12:12345',
    persistentKeepalive: 25,
  }]]),
};
const report = reportForState(confirmedDump, next);
assert.deepEqual(report, {
  appliedPeers: [{ publicKey: bravo, allowedAddress: '10.254.0.3/32' }],
  removedPeerKeys: [alpha],
  observations: [{ publicKey: bravo, allowedAddress: '10.254.0.3/32', lastHandshakeEpoch: 1710000100 }],
  knownRevision: null,
}, 'the core receives one confirmed applied /32, one confirmed removal, and only a new handshake');
const acknowledged = acknowledgeReport(next, report);
assert.deepEqual(acknowledged.pendingAppliedPeers, []);
assert.deepEqual(acknowledged.pendingRemovedPeerKeys, []);
assert.deepEqual(acknowledged.reportedHandshakes, { [bravo]: 1710000100 });
assert.deepEqual(reportForState(confirmedDump, acknowledged), {
  appliedPeers: [], removedPeerKeys: [], observations: [],
  knownRevision: null,
}, 'an unchanged peer does not write to Railway every five seconds');

const config = configFromEnv({
  WIFI_FITI_CORE_URL: 'https://cloud.wififiti.co.ke',
  WIFI_FITI_GATEWAY_ID: 'primary',
  WIFI_FITI_GATEWAY_SECRET: 'x'.repeat(32),
  WIFI_FITI_GATEWAY_PUBLIC_KEY: gateway,
});
assert.equal(config.interfaceName, 'wg-fiti');
assert.equal(config.pollSeconds, 5);
assert.equal(config.gatewayPublicKey, gateway);

assert.throws(() => configFromEnv({
  WIFI_FITI_CORE_URL: 'https://cloud.wififiti.co.ke',
  WIFI_FITI_GATEWAY_ID: 'primary',
  WIFI_FITI_GATEWAY_SECRET: 'x'.repeat(32),
}), /WIFI_FITI_GATEWAY_PUBLIC_KEY/);
assert.throws(() => configFromEnv({
  WIFI_FITI_CORE_URL: 'http://cloud.wififiti.co.ke',
  WIFI_FITI_GATEWAY_ID: 'primary',
  WIFI_FITI_GATEWAY_SECRET: 'x'.repeat(32),
  WIFI_FITI_GATEWAY_PUBLIC_KEY: gateway,
}), /HTTPS/);

console.log('vpn gateway agent tests passed');

'use strict';

const assert = require('assert');
const { parseRouterTopology, topologyFingerprint } = require('../src/lib/router-topology');

const base = [
  'fiti-topology-v1',
  'topo|system|routeros|7.24.2',
  'topo|wan|ether1',
  'topo|hotspot|hotspot1',
  'topo|customer-bridge|bridge-hs',
  'topo|interface|ether|ether1|up',
  'topo|interface|ether|ether2|up',
  'topo|interface|bridge|bridge-hs|up',
  'topo|interface|wireless|wlan1|up',
  'topo|wifi|wireless|wlan1|up',
  'topo|bridge-port|bridge-hs|ether2',
  'topo|bridge-port|bridge-hs|wlan1',
  'fiti-topology-end',
].join('\n');
const changedState = base.replace('topo|interface|ether|ether2|up', 'topo|interface|ether|ether2|down')
  .replace('topo|interface|wireless|wlan1|up', 'topo|interface|wireless|wlan1|disabled')
  .replace('topo|wifi|wireless|wlan1|up', 'topo|wifi|wireless|wlan1|disabled');
const first = parseRouterTopology(base);
const second = parseRouterTopology(changedState);
assert.notDeepStrictEqual(first.topology, second.topology, 'live state remains visible to the dashboard');
assert.strictEqual(topologyFingerprint(first.topology), topologyFingerprint(second.topology), 'live state changes must not require remapping');
console.log('router topology stability tests passed');

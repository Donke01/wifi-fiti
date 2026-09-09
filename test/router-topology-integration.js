'use strict';

/* Owner/API contract for the safe router mapping workflow. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

const databasePath = '/tmp/wifi-fiti-router-topology-integration.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(databasePath + suffix); } catch (_) { /* fresh test database */ }
}

Object.assign(process.env, {
  PORT: '0',
  PUBLIC_URL: 'https://cloud.wififiti.co.ke',
  APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke',
  LEGACY_HOST: 'wififiti.co.ke',
  MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'router-topology-key',
  MPESA_CONSUMER_SECRET: 'router-topology-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'router-topology-passkey',
  PROVISION_MODE: 'poll',
  SITE_TOKEN: 'router-topology-site-token',
  TENANT_SECRETS_KEY: 'router-topology-encryption-key',
  ADMIN_TOKEN: 'router-topology-admin-token',
  DATABASE_PATH: databasePath,
});

let server;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function captureServer(...args) {
  server = this;
  return originalListen.apply(this, args);
};
require('../src/server');
http.Server.prototype.listen = originalListen;

function delay() { return new Promise((resolve) => setImmediate(resolve)); }

async function api(endpoint, { method = 'GET', body, token, routerToken, contentType } = {}) {
  await delay();
  const headers = { Host: 'cloud.wififiti.co.ke' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routerToken) headers['X-WiFi-Fiti-Router'] = routerToken;
  if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
    method, headers, body: body === undefined ? undefined : (contentType ? body : JSON.stringify(body)),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed, text };
}

async function createBusiness(email, name) {
  const response = await api('/api/business/register', {
    method: 'POST',
    body: { name, ownerName: 'Owner', phone: '0712000000', email, password: 'test-password', plan: 'starter', collectionMode: 'fiti' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.token;
}

function topology({ includeEther4 = false } = {}) {
  return [
    'fiti-topology-v1',
    'topo|system|routeros|7.24.2',
    'topo|wan|ether1',
    'topo|hotspot|hotspot1',
    'topo|customer-bridge|bridge-hs',
    'topo|interface|ether|ether1|up',
    'topo|interface|ether|ether2|down',
    'topo|interface|ether|ether3|down',
    ...(includeEther4 ? ['topo|interface|ether|ether4|down'] : []),
    'topo|interface|bridge|bridge-hs|up',
    'topo|interface|wireless|wlan1|up',
    'topo|wifi|wireless|wlan1|up',
    'topo|bridge-port|bridge-hs|ether2',
    'topo|bridge-port|bridge-hs|ether3',
    ...(includeEther4 ? ['topo|bridge-port|bridge-hs|ether4'] : []),
    'topo|bridge-port|bridge-hs|wlan1',
    'fiti-topology-end',
  ].join('\n') + '\n';
}

async function completeRouterSync(location, body = '') {
  const query = `site=${encodeURIComponent(location.id)}&ack=&protocol=2&health=ready`;
  const first = await api(`/api/router/sync?${query}`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.equal(first.status, 200, first.text);
  const challenge = first.text.match(/:set fitiSetupAck "([^"]+)"/);
  if (!challenge) return first;
  return api(`/api/router/sync?${query}&setupAck=${encodeURIComponent(challenge[1])}`, {
    method: 'POST', routerToken: location.routerToken, body, contentType: 'text/plain',
  });
}

// A current protocol-2 poll receives a short receipt challenge before it
// carries normal work again. Follow that one round trip so topology remains
// tied to a completed router response, just like the real RouterOS poller.
async function reportTopologyAfterPairing(location, body) {
  const query = `site=${encodeURIComponent(location.id)}&ack=&protocol=2&health=ready`;
  const first = await api(`/api/router/sync?${query}`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.equal(first.status, 200, first.text);
  const challenge = first.text.match(/:set fitiSetupAck "([^"]+)"/);
  assert.ok(challenge, 'the current poll receives its receipt challenge');
  return api(`/api/router/sync?${query}&setupAck=${encodeURIComponent(challenge[1])}`, {
    method: 'POST', routerToken: location.routerToken, body, contentType: 'text/plain',
  });
}

async function main() {
  const alphaToken = await createBusiness('topology-alpha@example.test', 'Topology Alpha');
  const bravoToken = await createBusiness('topology-bravo@example.test', 'Topology Bravo');
  const created = await api('/api/business/locations', {
    method: 'POST', token: alphaToken, body: { name: 'Alpha site', routerName: 'hAP lite' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const location = created.body.location;
  const topologyEndpoint = `/api/business/locations/${encodeURIComponent(location.id)}/router-topology`;
  const mappingEndpoint = `/api/business/locations/${encodeURIComponent(location.id)}/router-mapping`;

  const paired = await completeRouterSync(location, topology());
  assert.equal(paired.status, 200, paired.text);

  const ownerTopology = await api(topologyEndpoint, { token: alphaToken });
  assert.equal(ownerTopology.status, 200, JSON.stringify(ownerTopology.body));
  assert.equal(ownerTopology.body.inventory.fresh, true);
  assert.equal(ownerTopology.body.topology.wanInterface, 'ether1');
  assert.deepEqual(ownerTopology.body.topology.wifiInterfaces, [{ stack: 'wireless', name: 'wlan1', state: 'up' }]);
  assert.equal(ownerTopology.body.mapping.status, 'needs_confirmation');
  const responseKeys = new Set();
  JSON.stringify(ownerTopology.body, (key, value) => { if (key) responseKeys.add(key); return value; });
  for (const forbidden of ['password', 'privateKey', 'secret', 'token', 'mac', 'address', 'route', 'user']) {
    assert.equal(responseKeys.has(forbidden), false,
      `the owner inventory response has no ${forbidden} field`);
  }

  const foreignTopology = await api(topologyEndpoint, { token: bravoToken });
  assert.equal(foreignTopology.status, 404, 'one business cannot inspect another router inventory');

  const arbitrary = await api(mappingEndpoint, {
    method: 'PUT', token: alphaToken,
    body: { wanInterface: 'ether99', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether2'] },
  });
  assert.equal(arbitrary.status, 400, 'the mapping endpoint refuses an interface not reported by the router');
  const wrongBridgePort = await api(mappingEndpoint, {
    method: 'PUT', token: alphaToken,
    body: { wanInterface: 'ether2', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether3'] },
  });
  assert.equal(wrongBridgePort.status, 400, 'a customer bridge port cannot be confirmed as WAN');

  const confirmed = await api(mappingEndpoint, {
    method: 'PUT', token: alphaToken,
    body: { wanInterface: 'ether1', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether3', 'ether2'] },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.mapping.status, 'confirmed');
  assert.deepEqual(confirmed.body.mapping.mapping, {
    version: 1, wanInterface: 'ether1', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether2', 'ether3'],
  });

  const workspace = await api('/api/business/me', { token: alphaToken });
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.locations[0].routerMapping.status, 'confirmed',
    'the mapping state is available to the sequential dashboard without exposing the full topology');

  const db = require('../src/lib/db').db;
  db.prepare("UPDATE tenant_router_topologies SET last_reported_at='2000-01-01 00:00:00' WHERE location_id=?").run(location.id);
  const oldInventory = await api(topologyEndpoint, { token: alphaToken });
  assert.equal(oldInventory.body.mapping.status, 'inventory_stale');
  assert.equal(oldInventory.body.mapping.canConfirm, false,
    'a dashboard cannot reconfirm a map from an old router report');
  const refreshed = await reportTopologyAfterPairing(location, topology());
  assert.equal(refreshed.status, 200);
  const refreshedInventory = await api(topologyEndpoint, { token: alphaToken });
  assert.equal(refreshedInventory.body.mapping.status, 'confirmed');

  // A staged token keeps the outgoing router online while a replacement kit
  // is pasted. Its inventory must not be shown as the replacement's map,
  // and a late poll from the outgoing token must not repopulate it.
  const oldRouterToken = location.routerToken;
  const staged = await api(`/api/business/locations/${encodeURIComponent(location.id)}/router-token`, {
    method: 'POST', token: alphaToken, body: {},
  });
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  const replacementToken = staged.body.location.routerToken;
  assert.ok(replacementToken);
  const waitingWorkspace = await api('/api/business/me', { token: alphaToken });
  assert.equal(waitingWorkspace.body.locations[0].routerMapping.status, 'waiting_for_inventory');
  const waitingTopology = await api(topologyEndpoint, { token: alphaToken });
  assert.equal(waitingTopology.body.topology, null);
  assert.equal(waitingTopology.body.inventory.fresh, false);
  assert.equal(waitingTopology.body.mapping.mapping, null);
  const pendingConfirmation = await api(mappingEndpoint, {
    method: 'PUT', token: alphaToken,
    body: { wanInterface: 'ether1', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether2'] },
  });
  assert.equal(pendingConfirmation.status, 409,
    'the owner cannot confirm a replacement from the outgoing router map');
  const outgoingTopology = await reportTopologyAfterPairing({ ...location, routerToken: oldRouterToken }, topology());
  assert.equal(outgoingTopology.status, 200);
  const stillWaiting = await api(topologyEndpoint, { token: alphaToken });
  assert.equal(stillWaiting.body.mapping.status, 'waiting_for_inventory',
    'an outgoing router poll cannot refill cleared replacement metadata');

  const replacementLocation = { ...location, routerToken: replacementToken };
  const replacementTopology = await reportTopologyAfterPairing(replacementLocation, topology({ includeEther4: true }));
  assert.equal(replacementTopology.status, 200);
  const replacementInventory = await api(topologyEndpoint, { token: alphaToken });
  assert.equal(replacementInventory.body.mapping.status, 'needs_confirmation');
  assert.equal(replacementInventory.body.topology.interfaces.some((item) => item.name === 'ether4'), true);
  assert.equal(replacementInventory.body.mapping.mapping, null,
    'the replacement must receive an owner confirmation even where its port names overlap');
  const replacementConfirmed = await api(mappingEndpoint, {
    method: 'PUT', token: alphaToken,
    body: { wanInterface: 'ether1', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether2', 'ether4'] },
  });
  assert.equal(replacementConfirmed.status, 200);
  assert.equal(replacementConfirmed.body.mapping.status, 'confirmed');

  const malformed = await reportTopologyAfterPairing(replacementLocation,
    'fiti-topology-v1\ntopo|interface|ether|bad|name|up\nfiti-topology-end\n');
  assert.equal(malformed.status, 200, 'invalid optional inventory cannot interrupt a billing/control-plane poll');
  const stillConfirmed = await api(topologyEndpoint, { token: alphaToken });
  assert.equal(stillConfirmed.body.mapping.status, 'confirmed', 'invalid inventory did not replace the last valid map');

  const changed = await reportTopologyAfterPairing(replacementLocation, topology());
  assert.equal(changed.status, 200);
  const stale = await api(topologyEndpoint, { token: alphaToken });
  assert.equal(stale.body.mapping.status, 'stale', 'a changed router layout requires owner reconfirmation');

  const topologyRow = db.prepare('SELECT topology_json FROM tenant_router_topologies WHERE location_id=?').get(location.id);
  assert.ok(topologyRow);
  const storedKeys = new Set();
  JSON.stringify(JSON.parse(topologyRow.topology_json), (key, value) => { if (key) storedKeys.add(key); return value; });
  for (const forbidden of ['password', 'privateKey', 'secret', 'token', 'mac', 'address', 'route', 'user']) {
    assert.equal(storedKeys.has(forbidden), false, `topology storage has no ${forbidden} field`);
  }

  console.log('router topology HTTP integration passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  if (server) server.close();
});

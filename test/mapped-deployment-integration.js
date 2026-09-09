'use strict';

/*
 * Full owner -> signed queue -> RouterOS poll acknowledgement contract for
 * the deliberately narrow mapped deployment. This is separate from the VPN
 * lifecycle test because it proves a gateway handshake is a hard prerequisite
 * and that no browser value can become arbitrary RouterOS source.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

const databasePath = '/tmp/wifi-fiti-mapped-deployment-integration.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(databasePath + suffix); } catch (_) { /* fresh test database */ }
}

const gatewayPublicKey = Buffer.alloc(32, 51).toString('base64');
const routerPublicKey = Buffer.alloc(32, 52).toString('base64');
const gatewaySecret = 'mapped-deployment-gateway-secret-long-enough';

Object.assign(process.env, {
  PORT: '0',
  PUBLIC_URL: 'https://cloud.wififiti.co.ke',
  APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke',
  LEGACY_HOST: 'wififiti.co.ke',
  MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'mapped-deployment-key',
  MPESA_CONSUMER_SECRET: 'mapped-deployment-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'mapped-deployment-passkey',
  PROVISION_MODE: 'poll',
  SITE_TOKEN: 'mapped-deployment-site-token',
  TENANT_SECRETS_KEY: 'mapped-deployment-encryption-key',
  ADMIN_TOKEN: 'mapped-deployment-admin-token',
  DATABASE_PATH: databasePath,
  VPN_GATEWAY_ENABLED: 'true',
  VPN_GATEWAY_ID: 'primary',
  VPN_GATEWAY_ENDPOINT: 'vpn.wififiti.co.ke',
  VPN_GATEWAY_PORT: '51820',
  VPN_GATEWAY_PUBLIC_KEY: gatewayPublicKey,
  VPN_GATEWAY_ADDRESS: '10.254.0.1',
  VPN_GATEWAY_MANAGEMENT_CIDR: '10.254.0.0/16',
  VPN_GATEWAY_CONTROL_SECRET: gatewaySecret,
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

async function api(endpoint, { method = 'GET', body, token, routerToken, gateway, contentType } = {}) {
  await delay();
  const headers = { Host: 'cloud.wififiti.co.ke' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routerToken) headers['X-WiFi-Fiti-Router'] = routerToken;
  if (gateway) headers['X-WiFi-Fiti-Gateway'] = gateway;
  if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : (contentType ? body : JSON.stringify(body)),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed, text };
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
  assert.ok(challenge, 'a newly paired router receives the setup receipt challenge');
  return api(`/api/router/sync?${query}&setupAck=${encodeURIComponent(challenge[1])}`, {
    method: 'POST', routerToken: location.routerToken, body, contentType: 'text/plain',
  });
}

function supportEnrollment(locationId) {
  return `version=1\nsite=${locationId}\ninterface=fiti-support-wg\npublic-key=${routerPublicKey}\n`;
}

function map(location, token) {
  return api(`/api/business/locations/${encodeURIComponent(location.id)}/router-mapping`, {
    method: 'PUT', token,
    body: { wanInterface: 'ether1', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether2', 'ether3'] },
  });
}

async function enableAndHandshakeVpn(location, token) {
  const remoteEndpoint = `/api/business/locations/${encodeURIComponent(location.id)}/remote-access`;
  const supportEndpoint = `/api/router/support-enroll?site=${encodeURIComponent(location.id)}`;
  const gatewayEndpoint = '/api/internal/vpn-gateways/primary/sync';
  const requested = await api(remoteEndpoint, { method: 'POST', token, body: { consent: true } });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const prepare = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  const prepareAck = prepare.text.match(/:global fitiSupportAck "(\d+)"/);
  assert.ok(prepareAck, 'remote access queues the separate harmless prepare control');
  const enrolled = await api(supportEndpoint, {
    method: 'POST', routerToken: location.routerToken, body: supportEnrollment(location.id), contentType: 'text/plain',
  });
  assert.equal(enrolled.status, 204, enrolled.text);
  const desired = await api(gatewayEndpoint, { method: 'POST', gateway: gatewaySecret, body: {} });
  assert.equal(desired.status, 200, JSON.stringify(desired.body));
  const applied = await api(gatewayEndpoint, {
    method: 'POST', gateway: gatewaySecret,
    body: { appliedPeers: [{ publicKey: routerPublicKey, allowedAddress: '10.254.0.2/32' }] },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const activate = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=&supportAck=${prepareAck[1]}`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  const activateAck = activate.text.match(/:global fitiSupportAck "(\d+)"/);
  assert.ok(activateAck, 'gateway readiness + prepare receipt release activation');
  const activationReceipt = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=&supportAck=${activateAck[1]}`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.equal(activationReceipt.status, 200, activationReceipt.text);
  const handshaken = await api(gatewayEndpoint, {
    method: 'POST', gateway: gatewaySecret,
    body: { observations: [{
      publicKey: routerPublicKey, allowedAddress: '10.254.0.2/32', lastHandshakeEpoch: Math.floor(Date.now() / 1000),
    }] },
  });
  assert.equal(handshaken.status, 200, JSON.stringify(handshaken.body));
}

async function main() {
  const register = await api('/api/business/register', {
    method: 'POST',
    body: { name: 'Mapped Deployment', ownerName: 'Owner', phone: '0712000000', email: 'mapped-deployment@example.test', password: 'test-password', plan: 'starter', collectionMode: 'fiti' },
  });
  assert.equal(register.status, 201, JSON.stringify(register.body));
  const ownerToken = register.body.token;
  const foreignRegister = await api('/api/business/register', {
    method: 'POST',
    body: { name: 'Foreign', ownerName: 'Other', phone: '0712000001', email: 'mapped-deployment-foreign@example.test', password: 'test-password', plan: 'starter', collectionMode: 'fiti' },
  });
  assert.equal(foreignRegister.status, 201);
  const foreignToken = foreignRegister.body.token;
  const created = await api('/api/business/locations', {
    method: 'POST', token: ownerToken, body: { name: 'Mapped Site', routerName: 'hAP lite' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const location = created.body.location;
  const deploymentEndpoint = `/api/business/locations/${encodeURIComponent(location.id)}/mapped-deployment`;

  const paired = await completeRouterSync(location, topology());
  assert.equal(paired.status, 200, paired.text);
  const confirmed = await map(location, ownerToken);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  const foreign = await api(deploymentEndpoint, { token: foreignToken });
  assert.equal(foreign.status, 404, 'one business cannot inspect another location deployment state');
  const arbitrary = await api(deploymentEndpoint, {
    method: 'POST', token: ownerToken, body: { action: 'apply', command: '/system reboot' },
  });
  assert.equal(arbitrary.status, 400, 'the owner endpoint refuses arbitrary command fields');
  const wrongAction = await api(deploymentEndpoint, { method: 'POST', token: ownerToken, body: { action: 'shell' } });
  assert.equal(wrongAction.status, 400, 'the owner endpoint accepts one finite action only');
  const beforeVpn = await api(deploymentEndpoint, { method: 'POST', token: ownerToken, body: { action: 'apply' } });
  assert.equal(beforeVpn.status, 409, 'a current map alone cannot authorize remote deployment');
  assert.match(beforeVpn.body.error, /secure remote access|VPN/i);

  await enableAndHandshakeVpn(location, ownerToken);
  const ready = await api(deploymentEndpoint, { token: ownerToken });
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body.canRequest, true);
  assert.equal(ready.body.mappingCurrent, true);
  assert.equal(ready.body.vpnActive, true);
  assert.equal(ready.body.deployment, null);

  const queued = await api(deploymentEndpoint, { method: 'POST', token: ownerToken, body: { action: 'apply' } });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.reused, false);
  assert.equal(queued.body.deployment.status, 'queued');
  const responseKeys = new Set();
  JSON.stringify(queued.body, (key, value) => { if (key) responseKeys.add(key); return value; });
  for (const forbidden of ['signature', 'nonce', 'receipt', 'payload', 'command', 'password', 'privateKey', 'token']) {
    assert.equal(responseKeys.has(forbidden), false, `owner deployment response has no ${forbidden}`);
  }
  const repeat = await api(deploymentEndpoint, { method: 'POST', token: ownerToken, body: { action: 'apply' } });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.reused, true, 'an unresolved owner request is idempotent');
  assert.equal(repeat.body.deployment.id, queued.body.deployment.id);

  const delivered = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.equal(delivered.status, 200, delivered.text);
  const deploymentAck = delivered.text.match(/:global fitiSupportAck "(deploy\.\d+\.[A-Za-z0-9_-]{32,64})"/);
  assert.ok(deploymentAck, 'the mapped action gets a namespaced one-time acknowledgement receipt');
  assert.match(delivered.text, /fitiMappedDeploymentWan/);
  assert.match(delivered.text, /fitiMappedDeploymentBridge/);
  assert.match(delivered.text, /fitiMappedDeploymentHotspot/);
  assert.match(delivered.text, /confirmed customer Ethernet port changed/);
  assert.match(delivered.text, /confirmed Wi-Fi interface changed/);
  assert.doesNotMatch(delivered.text, /\/system (?:reset-configuration|reboot|shutdown)|\/user |password=|0\.0\.0\.0\/0|\/ip (?:route|address|firewall|firewall nat)|\/ip hotspot (?:add|set)|\/interface bridge port (?:add|remove|set)/i,
    'the map action cannot change admin access, routes, L3, Hotspot construction or bridge membership');

  const deliveredState = await api(deploymentEndpoint, { token: ownerToken });
  assert.equal(deliveredState.body.deployment.status, 'delivered');
  const acknowledged = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=&supportAck=${encodeURIComponent(deploymentAck[1])}`, {
    method: 'POST', routerToken: location.routerToken, body: topology(), contentType: 'text/plain',
  });
  assert.equal(acknowledged.status, 200, acknowledged.text);
  const complete = await api(deploymentEndpoint, { token: ownerToken });
  assert.equal(complete.body.deployment.status, 'acknowledged');
  assert.ok(complete.body.deployment.acknowledgedAt, 'the server records the router acknowledgement');

  // A router whose local port checks no longer match sends a finite blocked
  // receipt rather than retrying the same deployment indefinitely. The owner
  // must reconfirm the map before asking for another action.
  const reconfirmForBlocked = await map(location, ownerToken);
  assert.equal(reconfirmForBlocked.status, 200);
  const blockedQueued = await api(deploymentEndpoint, { method: 'POST', token: ownerToken, body: { action: 'apply' } });
  assert.equal(blockedQueued.status, 202);
  const blockedDelivery = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  const blockedAck = blockedDelivery.text.match(/:global fitiSupportAck "(deploy\.\d+\.[A-Za-z0-9_-]{32,64})"/);
  assert.ok(blockedAck);
  assert.match(blockedDelivery.text, new RegExp(`${blockedAck[1].replace(/[.]/g, '\\.')}\\.blocked`),
    'the local validation failure has a bounded status receipt');
  const blockedReceipt = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=&supportAck=${encodeURIComponent(blockedAck[1] + '.blocked')}`, {
    method: 'POST', routerToken: location.routerToken, body: topology(), contentType: 'text/plain',
  });
  assert.equal(blockedReceipt.status, 200);
  const blockedState = await api(deploymentEndpoint, { token: ownerToken });
  assert.equal(blockedState.body.deployment.status, 'stale');
  assert.equal(blockedState.body.deployment.errorCode, 'mapping_stale');

  // A current topology is part of the signature boundary. Even a
  // syntactically valid persisted map cannot be changed after the owner has
  // requested deployment: it no longer matches the signed envelope.
  const newMap = await map(location, ownerToken);
  assert.equal(newMap.status, 200);
  const second = await api(deploymentEndpoint, { method: 'POST', token: ownerToken, body: { action: 'apply' } });
  assert.equal(second.status, 202);
  const database = require('../src/lib/db').db;
  database.prepare("UPDATE tenant_mapped_deployments SET payload_json=? WHERE id=?").run(
    JSON.stringify({ version: 1, action: 'apply_mapped_service_v1', hotspotServer: 'hotspot1', mapping: {
      version: 1, wanInterface: 'ether1', customerBridge: 'bridge-hs', wifiInterfaces: ['wlan1'], customerPorts: ['ether2'],
    } }),
    second.body.deployment.id
  );
  const rejected = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.equal(rejected.status, 200);
  assert.doesNotMatch(rejected.text, /fitiMappedDeploymentWan/,
    'a tampered signed payload is not rendered into the router response');
  const failed = await api(deploymentEndpoint, { token: ownerToken });
  assert.equal(failed.body.deployment.status, 'failed');
  assert.equal(failed.body.deployment.errorCode, 'invalid_signature');

  // A changed inventory invalidates the old confirmation. It must block a
  // fresh request rather than blindly treating similarly named ports as the
  // same router layout.
  const changed = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
    method: 'POST', routerToken: location.routerToken, body: topology({ includeEther4: true }), contentType: 'text/plain',
  });
  assert.equal(changed.status, 200);
  const stale = await api(deploymentEndpoint, { method: 'POST', token: ownerToken, body: { action: 'apply' } });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /layout changed|confirm the map/i);

  console.log('mapped deployment HTTP contract passed');
}

main().then(async () => {
  const database = require('../src/lib/db').db;
  if (server) await new Promise((resolve) => server.close(resolve));
  database.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(databasePath + suffix); } catch (_) { /* test cleanup */ }
  }
}, async (error) => {
  console.error(error.stack || error);
  if (server) await new Promise((resolve) => server.close(resolve));
  process.exitCode = 1;
});

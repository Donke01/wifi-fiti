/*
 * End-to-end contract for the self-hosted management gateway.
 *
 * It exercises the real Express route, the owner-consent flow, RouterOS
 * control queue and gateway reconciliation without a real router or VPS.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

const databasePath = '/tmp/wifi-fiti-vpn-gateway-integration.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(databasePath + suffix); } catch (_) { /* fresh test database */ }
}

const gatewayPublicKey = Buffer.alloc(32, 41).toString('base64');
const routerPublicKey = Buffer.alloc(32, 42).toString('base64');
const gatewaySecret = 'vpn-gateway-integration-secret-which-is-long-enough';

Object.assign(process.env, {
  PORT: '0',
  PUBLIC_URL: 'https://cloud.wififiti.co.ke',
  APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke',
  LEGACY_HOST: 'wififiti.co.ke',
  MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'vpn-integration-key',
  MPESA_CONSUMER_SECRET: 'vpn-integration-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'vpn-integration-passkey',
  PROVISION_MODE: 'poll',
  SITE_TOKEN: 'vpn-integration-site-token',
  TENANT_SECRETS_KEY: 'vpn-integration-encryption-key',
  ADMIN_TOKEN: 'vpn-integration-admin-token',
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

function delay() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

async function registerBusiness() {
  const response = await api('/api/business/register', {
    method: 'POST',
    body: {
      name: 'Gateway Test Internet', ownerName: 'Owner', phone: '0712000000',
      email: 'vpn-gateway@example.test', password: 'test-password', plan: 'starter', collectionMode: 'fiti',
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.token;
}

function supportEnrollment(locationId) {
  return `version=1\nsite=${locationId}\ninterface=fiti-support-wg\npublic-key=${routerPublicKey}\n`;
}

async function completeRouterSync(location) {
  const query = `site=${encodeURIComponent(location.id)}&ack=&protocol=2&health=ready`;
  const first = await api(`/api/router/sync?${query}`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  const challenge = first.text.match(/:set fitiSetupAck "([^"]+)"/);
  if (!challenge) return first;
  return api(`/api/router/sync?${query}&setupAck=${encodeURIComponent(challenge[1])}`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
}

async function main() {
  const agentAsset = await api('/vpn-gateway/agent.js');
  assert.equal(agentAsset.status, 200, agentAsset.text);
  assert.match(agentAsset.text, /WIFI_FITI_CORE_URL/,
    'a private source repository must not prevent a new VPS from downloading the non-secret agent');
  assert.match(agentAsset.text, /wg show .* dump/,
    'the public agent artifact is the reviewed implementation, not a separate installer copy');
  const unitAsset = await api('/vpn-gateway/wifi-fiti-vpn-agent.service');
  assert.equal(unitAsset.status, 200, unitAsset.text);
  assert.match(unitAsset.text, /InaccessiblePaths=\/etc\/wireguard/,
    'the bootstrap unit keeps the WireGuard private-key directory inaccessible to the agent');

  const businessToken = await registerBusiness();
  const created = await api('/api/business/locations', {
    method: 'POST', token: businessToken, body: { name: 'Gateway Site', routerName: 'hAP lite' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const location = created.body.location;
  const remoteEndpoint = `/api/business/locations/${encodeURIComponent(location.id)}/remote-access`;
  const supportEndpoint = `/api/router/support-enroll?site=${encodeURIComponent(location.id)}`;
  const gatewayEndpoint = '/api/internal/vpn-gateways/primary/sync';

  const paired = await completeRouterSync(location);
  assert.equal(paired.status, 200, paired.text);

  const unauthorized = await api(gatewayEndpoint, { method: 'POST', body: {} });
  assert.equal(unauthorized.status, 404, 'the internal gateway endpoint stays invisible without its separate secret');
  const malformed = await api(gatewayEndpoint, {
    method: 'POST', gateway: gatewaySecret, body: { appliedPeers: [{ publicKey: 'not-a-wireguard-key' }] },
  });
  assert.equal(malformed.status, 400, 'the gateway route refuses malformed peer observations');

  const requested = await api(remoteEndpoint, { method: 'POST', token: businessToken, body: { consent: true } });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.remoteAccess.status, 'configured', 'gateway-enabled consent moves directly to harmless router preparation');
  assert.equal(requested.body.remoteAccess.managementAddress, '10.254.0.2');
  assert.equal(requested.body.remoteAccess.gatewayState, 'preparing_router');
  assert.equal(JSON.stringify(requested.body).includes(routerPublicKey), false, 'owner output never exposes a router identity');

  const prepare = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.equal(prepare.status, 200, prepare.text);
  const prepareAck = prepare.text.match(/:global fitiSupportAck "(\d+)"/);
  assert.ok(prepareAck, 'the router receives a separate, safe WireGuard preparation acknowledgement');
  assert.match(prepare.text, /\/system script run \$fitiSupportBootstrap/);
  assert.doesNotMatch(prepare.text, /endpoint-address|private-key|0\.0\.0\.0\/0|\/ip hotspot|\/ip firewall nat/i);

  const enrolled = await api(supportEndpoint, {
    method: 'POST', routerToken: location.routerToken, body: supportEnrollment(location.id), contentType: 'text/plain',
  });
  assert.equal(enrolled.status, 204, enrolled.text);

  const desired = await api(gatewayEndpoint, { method: 'POST', gateway: gatewaySecret, body: {} });
  assert.equal(desired.status, 200, JSON.stringify(desired.body));
  assert.equal(desired.body.version, 2);
  assert.equal(desired.body.unchanged, false);
  assert.match(desired.body.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(desired.body.peers, [{ publicKey: routerPublicKey, allowedAddress: '10.254.0.2/32' }],
    'the gateway receives only the router public key and a management /32');
  const unchanged = await api(gatewayEndpoint, {
    method: 'POST', gateway: gatewaySecret, body: { knownRevision: desired.body.revision },
  });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.body, { version: 2, revision: desired.body.revision, unchanged: true, peers: [] },
    'ordinary health polls receive only a stable desired-state revision');

  const applied = await api(gatewayEndpoint, {
    method: 'POST', gateway: gatewaySecret,
    body: { knownRevision: desired.body.revision, appliedPeers: [{ publicKey: routerPublicKey, allowedAddress: '10.254.0.2/32' }] },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  const activate = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=&supportAck=${prepareAck[1]}`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.equal(activate.status, 200, activate.text);
  const activateAck = activate.text.match(/:global fitiSupportAck "(\d+)"/);
  assert.ok(activateAck, 'router activation waits for both its own preparation and gateway confirmation');
  assert.match(activate.text, new RegExp(gatewayPublicKey.replace(/[+/]/g, '\\$&')));
  assert.match(activate.text, /allowed-address=\$fitiSupportGateway persistent-keepalive=25s/);
  assert.match(activate.text, /dst-address=\$fitiSupportGateway gateway=\$fitiSupportInterface/);
  assert.doesNotMatch(activate.text, /private-key|0\.0\.0\.0\/0|\/ip hotspot|\/ip firewall nat|\/ip service/i,
    'activation stays management-only and cannot alter customer networking');

  const activated = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=&supportAck=${activateAck[1]}`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.equal(activated.status, 200, activated.text);
  const repeatApplied = await api(gatewayEndpoint, {
    method: 'POST', gateway: gatewaySecret,
    body: { appliedPeers: [{ publicKey: routerPublicKey, allowedAddress: '10.254.0.2/32' }] },
  });
  assert.equal(repeatApplied.status, 200);
  const noRepeatedActivation = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.doesNotMatch(noRepeatedActivation.text, /fitiSupportGatewayKey/,
    'gateway heartbeats cannot enqueue the same activation after the router acknowledged it');

  const handshaken = await api(gatewayEndpoint, {
    method: 'POST', gateway: gatewaySecret,
    body: { observations: [{
      publicKey: routerPublicKey, allowedAddress: '10.254.0.2/32', lastHandshakeEpoch: Math.floor(Date.now() / 1000),
    }] },
  });
  assert.equal(handshaken.status, 200, JSON.stringify(handshaken.body));
  const live = await api(remoteEndpoint, { token: businessToken });
  assert.equal(live.status, 200);
  assert.equal(live.body.remoteAccess.gatewayState, 'ready');
  assert.ok(live.body.remoteAccess.lastHandshakeAt, 'only a trusted gateway observation can show a live tunnel');
  assert.equal(Object.prototype.hasOwnProperty.call(live.body.remoteAccess, 'routerPublicKey'), false);

  const revoked = await api(remoteEndpoint, { method: 'PATCH', token: businessToken, body: { action: 'revoke' } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.remoteAccess.status, 'revoked');
  const afterRevoke = await api(gatewayEndpoint, { method: 'POST', gateway: gatewaySecret, body: { knownRevision: desired.body.revision } });
  assert.equal(afterRevoke.body.unchanged, false, 'a revoke changes the desired revision even when the agent has a cached snapshot');
  assert.deepEqual(afterRevoke.body.peers, [], 'revocation removes the router from the gateway desired snapshot immediately');
  const removalConfirmed = await api(gatewayEndpoint, {
    method: 'POST', gateway: gatewaySecret, body: { removedPeerKeys: [routerPublicKey] },
  });
  assert.equal(removalConfirmed.status, 200);
  assert.deepEqual(removalConfirmed.body.peers, []);
  const cleanup = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
    method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
  });
  assert.match(cleanup.text, /\/interface wireguard remove \$fitiSupportWireguard/);
  assert.doesNotMatch(cleanup.text, /fiti-poll|\/ip hotspot|\/ip firewall nat|0\.0\.0\.0\/0/,
    'revoking support leaves the ordinary billing/control plane untouched');

  console.log('VPN gateway HTTP lifecycle: consent, prepare, activate, handshake and revoke passed.');
}

main().then(async () => {
  const db = require('../src/lib/db').db;
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(databasePath + suffix); } catch (_) { /* test cleanup */ }
  }
}, async (error) => {
  console.error(error.stack || error);
  if (server) await new Promise((resolve) => server.close(resolve));
  process.exitCode = 1;
});

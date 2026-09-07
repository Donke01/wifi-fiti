/*
 * Remote-support onboarding HTTP contract.
 *
 * Run with:
 *   node --require ./test/in-process-http.js test/remote-onboarding.js
 *
 * This deliberately verifies the consent/inventory lifecycle only.  No VPN
 * peer, router command, private key, or external service is involved.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const databasePath = '/tmp/wifi-fiti-remote-onboarding-test.db';
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
  MPESA_CONSUMER_KEY: 'remote-onboarding-key',
  MPESA_CONSUMER_SECRET: 'remote-onboarding-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'remote-onboarding-passkey',
  PROVISION_MODE: 'poll',
  SITE_TOKEN: 'remote-onboarding-site-token',
  TENANT_SECRETS_KEY: 'remote-onboarding-encryption-key',
  ADMIN_TOKEN: 'remote-onboarding-admin-token',
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

const failures = [];
let passed = 0;

function delay() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function api(endpoint, { method = 'GET', body, token, adminToken, routerToken, contentType } = {}) {
  await delay();
  const headers = { Host: 'cloud.wififiti.co.ke' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  if (routerToken) headers['X-WiFi-Fiti-Router'] = routerToken;
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

async function test(name, work) {
  try {
    await work();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n${error.stack}`);
  }
}

async function createBusiness(email) {
  const registered = await api('/api/business/register', {
    method: 'POST',
    body: {
      name: email.startsWith('alpha') ? 'Alpha Internet' : 'Bravo Internet',
      ownerName: 'Owner', phone: '0712000000', email, password: 'test-password',
      plan: 'starter', collectionMode: 'fiti',
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  return registered.body.token;
}

const supportPublicKey = Buffer.alloc(32, 7).toString('base64');
const replacementSupportPublicKey = Buffer.alloc(32, 8).toString('base64');

function supportEnrollmentPayload(site, publicKey = supportPublicKey) {
  return `version=1\nsite=${site}\ninterface=fiti-support-wg\npublic-key=${publicKey}\n`;
}

async function main() {
  const alphaToken = await createBusiness('alpha-remote@example.test');
  const bravoToken = await createBusiness('bravo-remote@example.test');
  const created = await api('/api/business/locations', {
    method: 'POST', token: alphaToken,
    body: { name: 'Alpha Main', routerName: 'RB951Ui' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const location = created.body.location;
  const bravoLocationCreated = await api('/api/business/locations', {
    method: 'POST', token: bravoToken,
    body: { name: 'Bravo Main', routerName: 'hAP lite' },
  });
  assert.equal(bravoLocationCreated.status, 201, JSON.stringify(bravoLocationCreated.body));
  const bravoLocation = bravoLocationCreated.body.location;
  const endpoint = `/api/business/locations/${encodeURIComponent(location.id)}/remote-access`;
  const supportEndpoint = `/api/router/support-enroll?site=${encodeURIComponent(location.id)}`;
  let prepareControlId = null;

  await test('exposes a non-sensitive default state in the owner workspace', async () => {
    const response = await api(endpoint, { token: alphaToken });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body.remoteAccess).sort(), [
      'approvedAt', 'canRequest', 'canRevoke', 'cleanupPending', 'configuredAt', 'hubName', 'lastHandshakeAt',
      'locationId', 'managementAddress', 'requestedAt', 'revokedAt', 'status',
    ].sort());
    assert.equal(response.body.remoteAccess.status, 'not_requested');
    assert.equal(response.body.remoteAccess.canRequest, false);
    assert.ok(!/key|password|secret|token/i.test(JSON.stringify(response.body)));
    const workspace = await api('/api/business/me', { token: alphaToken });
    assert.equal(workspace.body.locations[0].remote_access_status, 'not_requested');
  });

  await test('requires explicit consent and a completed authenticated router poll', async () => {
    const db = require('../src/lib/db').db;
    const noConsent = await api(endpoint, { method: 'POST', token: alphaToken, body: {} });
    assert.equal(noConsent.status, 400);

    // A normal authenticated router request is still useful health
    // telemetry, but it must not count as a successful control-plane sync.
    const jobs = await api(`/api/router/jobs?site=${encodeURIComponent(location.id)}`, {
      routerToken: location.routerToken,
    });
    assert.equal(jobs.status, 200, jobs.text);
    const beforeSync = db.prepare('SELECT last_seen_at, last_successful_sync_at FROM locations WHERE id=?').get(location.id);
    assert.ok(beforeSync.last_seen_at, 'authenticated router requests still update ordinary health telemetry');
    assert.equal(beforeSync.last_successful_sync_at, null,
      'only the completed /api/router/sync route may unlock remote-support consent');

    const tooEarly = await api(endpoint, { method: 'POST', token: alphaToken, body: { consent: true } });
    assert.equal(tooEarly.status, 409);
    assert.match(tooEarly.body.error, /authenticated WiFi Fiti poll/);

    const rejectedSync = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
      method: 'POST', routerToken: 'wrong-router-token', body: '', contentType: 'text/plain',
    });
    assert.equal(rejectedSync.status, 403);
    assert.equal(db.prepare('SELECT last_successful_sync_at FROM locations WHERE id=?').get(location.id).last_successful_sync_at, null,
      'a rejected sync cannot create the required onboarding proof');

    const paired = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
      method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
    });
    assert.equal(paired.status, 200, paired.text);
    assert.ok(db.prepare('SELECT last_successful_sync_at FROM locations WHERE id=?').get(location.id).last_successful_sync_at,
      'the valid sync stores the dedicated proof used by the owner-consent check');
  });

  await test('enforces ownership, records consent once, and exposes status through /me', async () => {
    const foreign = await api(endpoint, { token: bravoToken });
    assert.equal(foreign.status, 404);

    const requested = await api(endpoint, { method: 'POST', token: alphaToken, body: { consent: true } });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.remoteAccess.status, 'requested');
    assert.equal(requested.body.remoteAccess.canRevoke, true);
    const repeated = await api(endpoint, { method: 'POST', token: alphaToken, body: { consent: true } });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.remoteAccess.status, 'requested');

    const db = require('../src/lib/db').db;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenant_remote_access_events WHERE location_id=? AND action='requested'")
      .get(location.id).n, 1, 'repeat clicks cannot manufacture additional owner-consent events');
    const workspace = await api('/api/business/me', { token: alphaToken });
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.locations[0].remote_access_status, 'requested');
    assert.equal(workspace.body.locations[0].remoteAccess.status, 'requested');
  });

  await test('requires the header-paired router, an exact report, and platform approval', async () => {
    const beforeApproval = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(location.id), contentType: 'text/plain',
    });
    assert.equal(beforeApproval.status, 409);
    assert.match(beforeApproval.text, /platform approval/i);

    const malformed = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(location.id) + 'unexpected=value\n', contentType: 'text/plain',
    });
    assert.equal(malformed.status, 400);

    const queryCredential = await api(`${supportEndpoint}&token=${encodeURIComponent(location.routerToken)}`, {
      method: 'POST', body: supportEnrollmentPayload(location.id), contentType: 'text/plain',
    });
    assert.equal(queryCredential.status, 403, 'the support endpoint must never accept a URL pairing token');

    const otherBusinessRouter = await api(supportEndpoint, {
      method: 'POST', routerToken: bravoLocation.routerToken,
      body: supportEnrollmentPayload(location.id), contentType: 'text/plain',
    });
    assert.equal(otherBusinessRouter.status, 403, 'a router pairing token cannot report into another business location');
  });

  await test('keeps platform approval and inventory allocation behind the admin token', async () => {
    const denied = await api(`/api/admin/locations/${encodeURIComponent(location.id)}/remote-access`, {
      method: 'PATCH', body: { action: 'approve' },
    });
    assert.equal(denied.status, 403);
    const approved = await api(`/api/admin/locations/${encodeURIComponent(location.id)}/remote-access`, {
      method: 'PATCH', adminToken: 'remote-onboarding-admin-token', body: { action: 'approve' },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.remoteAccess.status, 'approved');
    const beforeConfiguration = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(location.id), contentType: 'text/plain',
    });
    assert.equal(beforeConfiguration.status, 409,
      'approval alone must not bind a support identity before platform configuration');
    const invalidAddress = await api(`/api/admin/locations/${encodeURIComponent(location.id)}/remote-access`, {
      method: 'PATCH', adminToken: 'remote-onboarding-admin-token',
      body: { action: 'configure', managementAddress: '192.168.88.2', hubName: 'Nairobi hub' },
    });
    assert.equal(invalidAddress.status, 400);
    const configured = await api(`/api/admin/locations/${encodeURIComponent(location.id)}/remote-access`, {
      method: 'PATCH', adminToken: 'remote-onboarding-admin-token',
      body: { action: 'configure', managementAddress: '10.251.0.21', hubName: 'Nairobi hub' },
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.remoteAccess.status, 'configured');
    assert.equal(configured.body.remoteAccess.managementAddress, '10.251.0.21');
    assert.equal(configured.body.remoteAccess.lastHandshakeAt, null,
      'allocated inventory must not pretend that a VPN tunnel is already live');
  });

  await test('delivers an inert prepare control through a separate support acknowledgement channel', async () => {
    const prepared = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
      method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
    });
    assert.equal(prepared.status, 200, prepared.text);
    const supportAck = prepared.text.match(/:global fitiSupportAck "(\d+)"/);
    assert.ok(supportAck, 'prepare uses the support ACK global, not the billing ACK global');
    prepareControlId = Number(supportAck[1]);
    assert.match(prepared.text, /:global fitiSupportEnabled "yes"/);
    assert.match(prepared.text, /\/system script run \$fitiSupportBootstrap/);
    assert.doesNotMatch(prepared.text, /\/ip (?:hotspot|address|route|firewall|service)\b/);
    assert.doesNotMatch(prepared.text, /(?:wireguard peers|endpoint-address|endpoint-port|persistent-keepalive)/);
    assert.doesNotMatch(prepared.text, /:global fitiAck "/,
      'support controls cannot share a billing acknowledgement marker');

    const db = require('../src/lib/db').db;
    const control = db.prepare('SELECT action, delivered_at, acked_at FROM tenant_remote_support_controls WHERE id=?').get(prepareControlId);
    assert.deepEqual({ action: control.action, ackedAt: control.acked_at }, { action: 'prepare', ackedAt: null });
    assert.ok(control.delivered_at, 'the prepare control is delivered independently of ordinary tenant jobs');
  });

  await test('records an approved router public identifier without disclosing or activating anything', async () => {
    const enrolled = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(location.id), contentType: 'text/plain',
    });
    assert.equal(enrolled.status, 204, enrolled.text);
    assert.equal(enrolled.text, '', 'successful enrollment is deliberately an empty acknowledgement, never VPN configuration');

    const db = require('../src/lib/db').db;
    const saved = db.prepare('SELECT router_public_key, enrolled_at FROM tenant_remote_access WHERE location_id=?').get(location.id);
    assert.equal(saved.router_public_key, supportPublicKey);
    assert.ok(saved.enrolled_at);

    const repeated = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(location.id), contentType: 'text/plain',
    });
    assert.equal(repeated.status, 204, repeated.text);
    assert.deepEqual(
      db.prepare('SELECT router_public_key, enrolled_at FROM tenant_remote_access WHERE location_id=?').get(location.id),
      saved,
      'repeating the same router public key is idempotent and does not refresh the binding'
    );

    const replacement = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(location.id, replacementSupportPublicKey), contentType: 'text/plain',
    });
    assert.equal(replacement.status, 409);
    assert.match(replacement.text, /different router support identity/i);
    assert.deepEqual(
      db.prepare('SELECT router_public_key, enrolled_at FROM tenant_remote_access WHERE location_id=?').get(location.id),
      saved,
      'a different router public key cannot silently replace the enrolled router'
    );

    const ownerView = await api(endpoint, { token: alphaToken });
    assert.equal(ownerView.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(ownerView.body.remoteAccess, 'routerPublicKey'), false);
    assert.equal(JSON.stringify(ownerView.body).includes(supportPublicKey), false,
      'the router public identifier is inventory only and is not exposed through the owner API');

    const wrongBodySite = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(bravoLocation.id), contentType: 'text/plain',
    });
    assert.equal(wrongBodySite.status, 400, 'the signed site parameter and body site must match exactly');
  });

  await test('requires router cleanup acknowledgement before a replacement identity can be requested', async () => {
    const revoked = await api(endpoint, { method: 'PATCH', token: alphaToken, body: { action: 'revoke' } });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.remoteAccess.status, 'revoked');
    assert.equal(revoked.body.remoteAccess.managementAddress, null);
    assert.equal(revoked.body.remoteAccess.canRequest, false,
      'new owner consent remains blocked while the router has not acknowledged cleanup');
    const revokedReport = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(location.id), contentType: 'text/plain',
    });
    assert.equal(revokedReport.status, 409, 'withdrawn consent prevents a router from re-recording support identity');
    const db = require('../src/lib/db').db;
    const wiped = db.prepare('SELECT router_public_key, enrolled_at FROM tenant_remote_access WHERE location_id=?').get(location.id);
    assert.equal(wiped.router_public_key, null, 'revocation removes the retained router identifier');
    assert.equal(wiped.enrolled_at, null, 'revocation removes the retained enrollment time');

    const revokeControl = db.prepare(`SELECT id, action, acked_at FROM tenant_remote_support_controls
      WHERE location_id=? AND cancelled_at IS NULL ORDER BY id DESC LIMIT 1`).get(location.id);
    assert.equal(revokeControl.action, 'revoke');
    assert.equal(revokeControl.acked_at, null);
    assert.ok(db.prepare('SELECT cancelled_at FROM tenant_remote_support_controls WHERE id=?').get(prepareControlId).cancelled_at,
      'a revoke cancels an unacknowledged prepare so it can never be redelivered afterwards');
    const blockedReRequest = await api(endpoint, { method: 'POST', token: alphaToken, body: { consent: true } });
    assert.equal(blockedReRequest.status, 409);
    assert.match(blockedReRequest.body.error, /cleanup.*acknowledge/i);

    const cleanup = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=`, {
      method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
    });
    assert.equal(cleanup.status, 200, cleanup.text);
    const cleanupAckId = cleanup.text.match(/:global fitiSupportAck "(\d+)"/);
    assert.ok(cleanupAckId, 'the explicit revoke command has its own acknowledgement marker');
    assert.equal(Number(cleanupAckId[1]), revokeControl.id);
    assert.match(cleanup.text, /:global fitiSupportEnabled "no"/);
    assert.match(cleanup.text, /\/system scheduler disable \$fitiSupportScheduler/);
    assert.match(cleanup.text, /\/interface wireguard remove \$fitiSupportWireguard/);
    assert.doesNotMatch(cleanup.text, /fiti-poll|\/ip (?:hotspot|address|route|firewall|service)\b/);
    assert.doesNotMatch(cleanup.text, /(?:wireguard peers|endpoint-address|endpoint-port|persistent-keepalive)/);

    const cleanupAck = await api(`/api/router/sync?site=${encodeURIComponent(location.id)}&ack=&supportAck=${cleanupAckId[1]}`, {
      method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain',
    });
    assert.equal(cleanupAck.status, 200, cleanupAck.text);
    assert.ok(db.prepare('SELECT acked_at FROM tenant_remote_support_controls WHERE id=?').get(revokeControl.id).acked_at,
      'only the paired router sync acknowledgement clears the cleanup gate');
    const readyToRequest = await api(endpoint, { token: alphaToken });
    assert.equal(readyToRequest.status, 200);
    assert.equal(readyToRequest.body.remoteAccess.canRequest, true);

    const reRequested = await api(endpoint, { method: 'POST', token: alphaToken, body: { consent: true } });
    assert.equal(reRequested.status, 200);
    assert.equal(reRequested.body.remoteAccess.status, 'requested');
    const reApproved = await api(`/api/admin/locations/${encodeURIComponent(location.id)}/remote-access`, {
      method: 'PATCH', adminToken: 'remote-onboarding-admin-token', body: { action: 'approve' },
    });
    assert.equal(reApproved.status, 200);
    const reConfigured = await api(`/api/admin/locations/${encodeURIComponent(location.id)}/remote-access`, {
      method: 'PATCH', adminToken: 'remote-onboarding-admin-token',
      body: { action: 'configure', managementAddress: '10.251.0.21', hubName: 'Nairobi hub' },
    });
    assert.equal(reConfigured.status, 200);
    const replacementAfterNewConsent = await api(supportEndpoint, {
      method: 'POST', routerToken: location.routerToken,
      body: supportEnrollmentPayload(location.id, replacementSupportPublicKey), contentType: 'text/plain',
    });
    assert.equal(replacementAfterNewConsent.status, 204, replacementAfterNewConsent.text);
    assert.equal(db.prepare('SELECT router_public_key FROM tenant_remote_access WHERE location_id=?').get(location.id).router_public_key,
      replacementSupportPublicKey,
      'only the explicit revoke, cleanup acknowledgement, re-request, approval, and configuration cycle permits a replacement identity');
  });

  console.log(`\nRemote onboarding HTTP: ${passed} passed, ${failures.length} failed`);
  return failures.length ? 1 : 0;
}

main().then(async (code) => {
  const db = require('../src/lib/db').db;
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(databasePath + suffix); } catch (_) { /* test cleanup */ }
  }
  process.exit(code);
}, async (error) => {
  console.error(error.stack);
  if (server) await new Promise((resolve) => server.close(resolve));
  process.exit(1);
});

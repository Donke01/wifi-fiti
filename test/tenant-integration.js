/*
 * Run with: node test/tenant-integration.js
 *
 * Exercise the real Express app and router polling endpoints against an
 * isolated SQLite database. Only Safaricom's external HTTP service is mocked;
 * production callback verification remains enabled. No money is moved and no
 * physical router is changed. RouterOS scripts are inspected and acknowledged
 * through the same HTTP protocol the router uses.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-tenant-http-'));
Object.assign(process.env, {
  PORT: '0',
  PUBLIC_URL: 'https://wifi-fiti.example.test',
  APP_URL: 'https://app.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke',
  LEGACY_HOST: 'wififiti.co.ke',
  MPESA_ENV: 'production',
  MPESA_CONSUMER_KEY: 'platform-test-key',
  MPESA_CONSUMER_SECRET: 'platform-test-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'platform-test-passkey',
  PROVISION_MODE: 'poll',
  SITE_ID: 'legacy-integration-site',
  SITE_TOKEN: 'legacy-integration-router-token',
  TENANT_SECRETS_KEY: 'integration-only-encryption-key-do-not-deploy',
  ADMIN_TOKEN: 'integration-admin-token',
  DATABASE_PATH: path.join(temporaryDirectory, 'hotspot.db'),
});

const realFetch = global.fetch;
const darajaCalls = [];
const payments = new Map();
let nextCheckout = 0;
global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  assert.equal(target.hostname, 'api.safaricom.co.ke', 'unexpected external request in integration test');
  const body = options.body ? JSON.parse(options.body) : null;
  darajaCalls.push({ path: target.pathname, body, headers: options.headers });
  if (target.pathname === '/oauth/v1/generate') {
    return Response.json({ access_token: 'mock-daraja-access-token', expires_in: 3599 });
  }
  if (target.pathname === '/mpesa/stkpush/v1/processrequest') {
    const id = `ws_CO_INTEGRATION_${++nextCheckout}`;
    const merchantId = `merchant-integration-${nextCheckout}`;
    payments.set(id, { id, merchantId, request: body, result: null });
    return Response.json({ ResponseCode: '0', CheckoutRequestID: id, MerchantRequestID: merchantId });
  }
  if (target.pathname === '/mpesa/stkpushquery/v1/query') {
    const payment = payments.get(body.CheckoutRequestID);
    assert.ok(payment, 'query must identify a checkout created by the mock merchant');
    assert.equal(body.BusinessShortCode, payment.request.BusinessShortCode,
      'payment verification must use the same merchant that received the payment');
    if (payment.result === null) {
      return Response.json({ errorCode: '500.001.1001', errorMessage: 'Transaction is being processed' });
    }
    return Response.json({ ResultCode: payment.result, ResultDesc: payment.result === 0 ? 'Success' : 'Cancelled' });
  }
  throw new Error(`Unexpected Daraja endpoint: ${target.pathname}`);
};

let server;
let origin;
let database;
let tenant;
const failures = [];
let passed = 0;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function eventually(check, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(10);
  }
  assert.fail(message);
}

async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n${error.stack}`);
  }
}

async function api(endpoint, { method = 'GET', body, token, portalToken, sessionToken, adminToken, routerToken, host, forwardedHost, redirect } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (portalToken) headers['X-WiFi-Fiti-Portal'] = portalToken;
  if (sessionToken) headers['X-WiFi-Fiti-Session'] = sessionToken;
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  if (routerToken) headers['X-WiFi-Fiti-Router'] = routerToken;
  if (host) headers.Host = host;
  if (forwardedHost) headers['X-Forwarded-Host'] = forwardedHost;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await realFetch(origin + endpoint, {
    method, headers, redirect: redirect || 'follow', body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = await response.text();
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { parsed = content; }
  return { status: response.status, body: parsed, text: content, headers: response.headers };
}

async function routerSync(location, { ack = [], report = '', token = location.routerToken, transport = 'header' } = {}) {
  const query = new URLSearchParams({ site: location.id, ack: ack.join(',') });
  const headers = { 'Content-Type': 'text/plain' };
  if (transport === 'header') headers['X-WiFi-Fiti-Router'] = token;
  else query.set('token', token);
  const response = await realFetch(`${origin}/api/router/sync?${query}`, {
    method: 'POST', headers, body: report,
  });
  const script = await response.text();
  const match = script.match(/:global fitiAck "([\d,]+)"/);
  return { status: response.status, script, ids: match ? match[1].split(',').map(Number) : [] };
}

function endpoint(location, suffix) {
  return `/api/tenant/${location.id}/${suffix}`;
}

async function operator(suffix, collectionMode = 'fiti', rateLimit = '2M/5M') {
  const registered = await api('/api/business/register', { method: 'POST', body: {
    name: `${suffix} Internet`, ownerName: `${suffix} Owner`, phone: '0712000000',
    email: `${suffix.toLowerCase()}@example.test`, password: 'integration-password',
    plan: 'starter', collectionMode,
  } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const token = registered.body.token;
  const located = await api('/api/business/locations', { method: 'POST', token,
    body: { name: `${suffix} Main`, routerName: 'RB951Ui' } });
  assert.equal(located.status, 201, JSON.stringify(located.body));
  const packaged = await api('/api/business/packages', { method: 'POST', token,
    body: { name: `${suffix} Hour`, price: 20, hours: 1, rateLimit } });
  assert.equal(packaged.status, 201, JSON.stringify(packaged.body));
  return { token, business: registered.body.business, location: located.body.location, portalUrl: located.body.portalUrl,
    package: packaged.body.packages[0] };
}

async function voucher(operator, mac, phone = '254712000001') {
  const issued = await api('/api/business/vouchers', { method: 'POST', token: operator.token,
    body: { locationId: operator.location.id, packageId: operator.package.id, count: 1, batch: 'HTTP tests' } });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const redeemed = await api(endpoint(operator.location, 'voucher/redeem'), { method: 'POST',
    body: { code: issued.body.codes[0], phone, mac, ip: '10.5.50.20' } });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  return { code: issued.body.codes[0], ...redeemed.body };
}

async function checkout(operator, mac, phone) {
  const response = await api(endpoint(operator.location, 'pay'), { method: 'POST', body: {
    packageId: operator.package.id, phone, mac, ip: '10.5.50.21',
  } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.portalToken, 'new checkout must return a portal capability');
  return response.body;
}

async function callback(checkoutId, resultCode = 0, overrides = {}) {
  const payment = payments.get(checkoutId);
  assert.ok(payment);
  const response = await api('/api/mpesa/callback', { method: 'POST', body: {
    Body: { stkCallback: {
      MerchantRequestID: payment.merchantId, CheckoutRequestID: checkoutId, ResultCode: resultCode,
      ResultDesc: resultCode === 0 ? 'Success' : 'Cancelled',
      CallbackMetadata: { Item: [
        { Name: 'Amount', Value: payment.request.Amount },
        { Name: 'PhoneNumber', Value: Number(payment.request.PhoneNumber) },
        { Name: 'MpesaReceiptNumber', Value: `TESTRECEIPT${checkoutId.split('_').at(-1)}` },
      ] },
      ...overrides,
    } },
  } });
  assert.equal(response.status, 200);
  assert.equal(response.body.ResultCode, 0, 'callback HTTP acknowledgement is separate from settlement');
  // The real endpoint acknowledges first, then verifies in setImmediate.
  await pause(30);
}

async function boot() {
  // The app starts its own listener. Capture it without replacing its HTTP
  // behaviour so tests can use an OS-assigned port and close it on completion.
  const originalListen = http.Server.prototype.listen;
  let resolveListening;
  let rejectListening;
  const listening = new Promise((resolve, reject) => {
    resolveListening = resolve; rejectListening = reject;
  });
  http.Server.prototype.listen = function (...args) {
    server = this;
    this.once('listening', resolveListening);
    this.once('error', rejectListening);
    return originalListen.apply(this, args);
  };
  try {
    require('../src/server');
  } finally {
    http.Server.prototype.listen = originalListen;
  }
  await listening;
  origin = `http://127.0.0.1:${server.address().port}`;
  database = require('../src/lib/db').db;
  tenant = require('../src/lib/tenant');
}

async function main() {
  await test('an unset APP_URL keeps a staging deployment on its configured public URL', async () => {
    const result = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/config').domains.appUrl)"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, APP_URL: '', PUBLIC_URL: 'https://staging.wififiti.example.test' },
    }).toString();
    assert.equal(result, 'https://staging.wififiti.example.test');
  });

  await boot();

  await test('the root is the public landing while app is live and legacy root traffic stays compatible', async () => {
    const root = 'wififiti.co.ke';
    const appHost = 'app.wififiti.co.ke';
    const marketing = await api('/', { host: root, redirect: 'manual' });
    assert.equal(marketing.status, 200);
    assert.match(marketing.text, /Run your Wi‑Fi business/);
    assert.match(marketing.text, /app\.wififiti\.co\.ke\/business\.html/);
    assert.match(marketing.text, /canonical" href="https:\/\/wififiti\.co\.ke\//);
    assert.equal(marketing.headers.get('x-robots-tag'), null, 'the public landing must be indexable');
    const appLink = await api('/business.html?do-not-forward=this', { host: root, redirect: 'manual' });
    assert.equal(appLink.status, 302);
    assert.equal(appLink.headers.get('location'), 'https://app.wififiti.co.ke/business.html');
    const rootApi = await api('/api/config', { host: root, redirect: 'manual' });
    assert.equal(rootApi.status, 200, 'legacy portal API must remain live during migration');
    assert.equal(rootApi.headers.get('x-robots-tag'), 'noindex, nofollow');
    const rootPoll = await api('/api/router/sync?site=nope', { method: 'POST', body: {}, host: root, redirect: 'manual' });
    assert.equal(rootPoll.status, 403, 'legacy router polling must reach the application during migration');
    assert.equal(rootPoll.headers.get('x-robots-tag'), 'noindex, nofollow');
    const rootCallback = await api('/api/mpesa/callback', { method: 'POST', body: {}, host: root, redirect: 'manual' });
    assert.equal(rootCallback.status, 200, 'legacy payment callbacks must reach the application during migration');
    assert.equal(rootCallback.headers.get('x-robots-tag'), 'noindex, nofollow');
    const rootPortal = await api('/p/any-location', { host: root, redirect: 'manual' });
    assert.equal(rootPortal.status, 404, 'an unknown legacy location may be absent but its route must reach the app');
    assert.equal(rootPortal.headers.get('x-robots-tag'), 'noindex, nofollow');
    const appRoot = await api('/', { host: appHost, redirect: 'manual' });
    assert.equal(appRoot.status, 302);
    assert.equal(appRoot.headers.get('location'), '/business.html');
    assert.equal((await api('/api/config', { host: appHost, redirect: 'manual' })).status, 200,
      'the live app host must serve the application API');
    const forwardedHost = await api('/', { host: appHost, forwardedHost: root, redirect: 'manual' });
    assert.equal(forwardedHost.status, 302, 'host routing must use Host, not a forwarded host value');
    const legacyAtApp = await api('/legacy?mac=AA:BB:CC:00:00:01', { host: appHost, redirect: 'manual' });
    assert.equal(legacyAtApp.status, 200);
    assert.match(legacyAtApp.text, /WiFi Fiti/);
    const oldRouterPortal = await api('/?mac=AA:BB:CC:00:00:01', { host: root, redirect: 'manual' });
    assert.equal(oldRouterPortal.status, 200);
    assert.equal(oldRouterPortal.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(oldRouterPortal.text, /WiFi Fiti/);
    const absentWww = await api('/', { host: 'www.wififiti.co.ke', redirect: 'manual' });
    assert.equal(absentWww.status, 421, 'www is not part of this two-domain deployment');
    const unknownHost = await api('/api/config', { host: 'unexpected.example.test', redirect: 'manual' });
    assert.equal(unknownHost.status, 421, 'unknown hosts must not expose the live app');
    const freshRouterSetup = fs.readFileSync(path.join(__dirname, '..', 'routeros', 'hotspot-setup.rsc'), 'utf8');
    assert.match(freshRouterSetup, /:global portalHost\s+"app\.wififiti\.co\.ke"/);
    assert.match(freshRouterSetup, /add dst-host="\$portalHost" action=allow comment="WiFi Fiti live app"/);
  });

  const alpha = await operator('Alpha');
  const bravo = await operator('Bravo', 'own');
  console.log('\nTenant HTTP integration (production payment verification)');

  await test('business accounts, packages, location controls, and router secrets are isolated', async () => {
    assert.equal((await api('/api/business/me')).status, 401);
    assert.equal(alpha.portalUrl, `https://app.wififiti.co.ke/p/${alpha.location.id}`);
    const mine = await api('/api/business/me', { token: alpha.token });
    assert.deepEqual(mine.body.locations.map((item) => item.id), [alpha.location.id]);
    assert.equal(mine.body.locations[0].routerToken, undefined, 'pairing secret is shown only once');
    assert.equal(mine.body.locations[0].router_token, undefined);
    const publicConfig = await api(endpoint(alpha.location, 'config'));
    assert.deepEqual(publicConfig.body.packages.map((item) => item.id), [alpha.package.id]);
    assert.equal(publicConfig.body.packages[0].rate_limit, '2M/5M');
    assert.equal(publicConfig.headers.get('referrer-policy'), 'no-referrer');
    const routerLogin = await api(`/api/tenant/${alpha.location.id}/router-login`, { routerToken: alpha.location.routerToken });
    assert.equal(routerLogin.status, 200);
    assert.match(routerLogin.text, new RegExp(`https://app\\.wififiti\\.co\\.ke/p/${alpha.location.id}`));
    const canonicalSpeed = await api(`/api/business/packages/${alpha.package.id}`, { method: 'PATCH', token: alpha.token,
      body: { rateLimit: '512K/1m' } });
    assert.equal(canonicalSpeed.status, 200, JSON.stringify(canonicalSpeed.body));
    assert.equal(canonicalSpeed.body.packages.find((item) => item.id === alpha.package.id).rate_limit, '512k/1M');
    const restoredSpeed = await api(`/api/business/packages/${alpha.package.id}`, { method: 'PATCH', token: alpha.token,
      body: { rateLimit: '2M/5M' } });
    assert.equal(restoredSpeed.status, 200, JSON.stringify(restoredSpeed.body));
    const foreignPay = await api(endpoint(alpha.location, 'pay'), { method: 'POST',
      body: { packageId: bravo.package.id, phone: '0712000002', mac: 'AA:BB:CC:00:00:02' } });
    assert.equal(foreignPay.status, 400);
    assert.equal((await api(`/api/business/packages/${bravo.package.id}`, { method: 'PATCH',
      token: alpha.token, body: { price: 1 } })).status, 404);
    assert.equal((await api(`/api/business/locations/${bravo.location.id}/router-token`, {
      method: 'POST', token: alpha.token, body: {} })).status, 404);
    assert.equal((await routerSync(alpha.location, { token: bravo.location.routerToken })).status, 403);
    assert.equal((await routerSync(alpha.location, { transport: 'query' })).status, 403,
      'a newly paired router must not accept a secret in the URL');
    assert.equal((await api('/api/business/vouchers', { method: 'POST', token: alpha.token,
      body: { locationId: bravo.location.id, packageId: alpha.package.id } })).status, 400);
    assert.equal((await api('/api/business/packages', { method: 'POST', token: alpha.token,
      body: { name: 'Broken speed', price: 1, hours: 1, rateLimit: '5M; /system reboot' } })).status, 400,
      'package speed input must not become RouterOS script syntax');
    assert.equal((await api('/api/admin/business-operations/tickets')).status, 403);
    assert.equal((await api('/api/admin/business-operations/tickets', { adminToken: 'wrong-token' })).status, 403);
    assert.equal((await api('/api/admin/business-operations/tickets', { adminToken: 'integration-admin-token' })).status, 200);
  });

  await test('voucher grants survive HTTP reloads and require the correct router acknowledgement', async () => {
    const mac = 'AA:BB:CC:00:00:10';
    const granted = await voucher(alpha, mac);
    assert.equal(granted.status, 'pending');
    assert.ok(granted.remainingSeconds > 3590 && granted.remainingSeconds <= 3600);
    const jobPath = endpoint(alpha.location, `router-jobs/${granted.provisioningJobId}`);
    assert.equal((await api(jobPath)).body.ready, false);
    assert.equal((await api(endpoint(bravo.location, `router-jobs/${granted.provisioningJobId}`))).status, 404);
    const foreignRouter = await routerSync(bravo.location, { ack: [granted.provisioningJobId] });
    assert.equal(foreignRouter.script, '');
    assert.equal((await api(jobPath)).body.ready, false, 'another router cannot acknowledge this job');
    const delivered = await routerSync(alpha.location);
    assert.ok(delivered.ids.includes(granted.provisioningJobId));
    assert.ok(delivered.script.includes(`mac-address=${mac}`));
    assert.ok(delivered.script.includes('rate-limit=2M/5M'));
    await routerSync(alpha.location, { ack: delivered.ids });
    assert.equal((await api(jobPath)).body.ready, true);
    const first = await api(endpoint(alpha.location, `session?mac=${mac}`));
    const second = await api(endpoint(alpha.location, `session?mac=${mac}`));
    assert.equal(first.body.expiresAt, second.body.expiresAt, 'reload does not reset expiry');
    for (const key of ['password', 'username', 'payerPhone', 'subscriptionId']) {
      assert.equal(first.body[key], undefined, 'knowing a MAC must not disclose login credentials or payer identity');
    }
    const replay = await api(endpoint(alpha.location, 'voucher/redeem'), { method: 'POST',
      body: { code: granted.code, phone: '0712000001', mac: 'AA:BB:CC:00:00:11' } });
    assert.equal(replay.status, 409);
    const crossLocation = await api(endpoint(bravo.location, 'voucher/redeem'), { method: 'POST',
      body: { code: granted.code, phone: '0712000001', mac: 'AA:BB:CC:00:00:12' } });
    assert.equal(crossLocation.status, 409);
  });

  await test('verified STK settlement grants exactly once and reveals credentials only after router ack with a portal token', async () => {
    const payment = await checkout(alpha, 'AA:BB:CC:00:00:20', '0712000020');
    const id = payment.checkoutRequestId;
    const statusPath = endpoint(alpha.location, `status/${id}`);
    const request = payments.get(id).request;
    assert.equal(request.Amount, alpha.package.price);
    assert.equal(request.BusinessShortCode, '174379');
    assert.equal(request.CallBackURL, 'https://wifi-fiti.example.test/api/mpesa/callback');
    assert.equal((await api(statusPath)).status, 403);
    assert.equal((await api(statusPath, { portalToken: 'wrong-token' })).status, 403);
    assert.equal((await api(endpoint(bravo.location, `status/${id}`), { portalToken: payment.portalToken })).status, 404);
    payments.get(id).result = 0;
    await Promise.all([callback(id), callback(id)]);
    await eventually(() => tenant.getTransaction.get(id).provisioned, 'verified payment was not provisioned');
    const transaction = tenant.getTransaction.get(id);
    const subscription = tenant.subscriptionById.get(transaction.subscription_id, alpha.location.id);
    const expiry = subscription.expires_at;
    const beforeAck = await api(statusPath, { portalToken: payment.portalToken });
    assert.equal(beforeAck.body.status, 'pending');
    assert.equal(beforeAck.body.awaitingRouter, true);
    assert.equal(beforeAck.body.password, undefined);
    const delivered = await routerSync(alpha.location);
    assert.ok(delivered.ids.includes(transaction.provisioning_job_id));
    await routerSync(alpha.location, { ack: delivered.ids });
    const paid = await api(statusPath, { portalToken: payment.portalToken });
    assert.equal(paid.body.status, 'paid');
    assert.equal(paid.body.password, subscription.password);
    assert.equal(paid.body.subscriptionId, subscription.id);
    await callback(id);
    await api(statusPath, { portalToken: payment.portalToken });
    const repeated = tenant.subscriptionById.get(subscription.id, alpha.location.id);
    assert.equal(repeated.expires_at, expiry, 'callback replay cannot extend the expiry');
    assert.equal(repeated.total_seconds, alpha.package.seconds);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM tenant_payment_grants WHERE checkout_request_id=?').get(id).n, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM tenant_jobs WHERE location_id=? AND username=?').get(alpha.location.id, subscription.router_username).n, 1);
    const stored = database.prepare('SELECT portal_token_hash FROM tenant_transactions WHERE checkout_request_id=?').get(id);
    assert.notEqual(stored.portal_token_hash, payment.portalToken);
    assert.equal((await api(statusPath)).status, 403, 'completed payment still requires the capability');
    database.prepare("UPDATE tenant_transactions SET portal_token_expires_at=datetime('now','-1 second') WHERE checkout_request_id=?").run(id);
    assert.equal((await api(statusPath, { portalToken: payment.portalToken })).status, 403, 'expired capability cannot recover credentials');
    const dashboard = await api('/api/business/dashboard', { token: alpha.token });
    assert.equal(dashboard.body.gross, 20);
    assert.equal(dashboard.body.platformFee, 1);
    assert.equal((await api('/api/business/dashboard', { token: bravo.token })).body.gross, 0);
  });

  await test('production rejects a forged successful callback when Daraja reports pending or cancelled', async () => {
    const pending = await checkout(alpha, 'AA:BB:CC:00:00:30', '0712000030');
    await callback(pending.checkoutRequestId);
    assert.equal(tenant.getTransaction.get(pending.checkoutRequestId).status, 'pending');
    assert.equal(tenant.subscriptionByMac.get(alpha.location.id, 'AA:BB:CC:00:00:30'), undefined);
    assert.ok(darajaCalls.some((call) => call.path.includes('stkpushquery') && call.body.CheckoutRequestID === pending.checkoutRequestId));
    payments.get(pending.checkoutRequestId).result = 1032;
    await callback(pending.checkoutRequestId);
    await eventually(() => tenant.getTransaction.get(pending.checkoutRequestId).status === 'failed', 'Daraja cancellation was not retained');
    assert.equal(tenant.subscriptionByMac.get(alpha.location.id, 'AA:BB:CC:00:00:30'), undefined);
    const status = await api(endpoint(alpha.location, `status/${pending.checkoutRequestId}`), { portalToken: pending.portalToken });
    assert.equal(status.body.status, 'failed');
    assert.equal(status.body.password, undefined);
  });

  await test('own M-Pesa collection verifies and charges the business merchant without exposing its secrets', async () => {
    const connected = await api('/api/business/payment-collection', { method: 'POST', token: bravo.token, body: {
      collectionName: 'Bravo PayBill', shortcode: '654321', transactionType: 'CustomerPayBillOnline',
      consumerKey: 'bravo-private-key', consumerSecret: 'bravo-private-secret', passkey: 'bravo-private-passkey',
    } });
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    assert.ok(!JSON.stringify(connected.body).includes('bravo-private'));
    const summary = await api('/api/business/payment-collection', { token: bravo.token });
    assert.equal(summary.body.configured, true);
    assert.ok(!JSON.stringify(summary.body).includes('bravo-private'));
    assert.equal((await api('/api/business/payment-collection', { token: alpha.token })).body.configured, false);
    const payment = await checkout(bravo, 'AA:BB:CC:00:00:40', '0712000040');
    assert.equal(payments.get(payment.checkoutRequestId).request.BusinessShortCode, '654321');
    payments.get(payment.checkoutRequestId).result = 0;
    await callback(payment.checkoutRequestId);
    await eventually(() => tenant.getTransaction.get(payment.checkoutRequestId).provisioned, 'own merchant payment was not provisioned');
    const tx = tenant.getTransaction.get(payment.checkoutRequestId);
    assert.equal(tx.payment_source, 'own');
    assert.equal(tx.platform_fee, 0);
    const query = darajaCalls.find((call) => call.path.includes('stkpushquery') && call.body.CheckoutRequestID === payment.checkoutRequestId);
    assert.equal(query.body.BusinessShortCode, '654321');
  });

  await test('one linked TV and the phone both expire through router sync without generating repeated revoke jobs', async () => {
    const granted = await voucher(alpha, 'AA:BB:CC:00:00:50', '254712000050');
    const deviceRequest = { phone: '0712000050', subscriptionId: granted.subscriptionId,
      password: granted.password, mac: 'AA:BB:CC:00:00:51', label: 'Living room TV' };
    const added = await api(endpoint(alpha.location, 'devices/add'), { method: 'POST', body: deviceRequest });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const second = await api(endpoint(alpha.location, 'devices/add'), { method: 'POST',
      body: { ...deviceRequest, mac: 'AA:BB:CC:00:00:52' } });
    assert.equal(second.status, 409);
    const wrongPassword = await api(endpoint(alpha.location, 'devices/remove'), { method: 'POST',
      body: { ...deviceRequest, password: 'NOTMINE' } });
    assert.equal(wrongPassword.status, 403);
    const provisioned = await routerSync(alpha.location);
    await routerSync(alpha.location, { ack: provisioned.ids });
    database.prepare("UPDATE tenant_subscriptions SET expires_at=datetime('now','-1 second'),expiry_job_id=NULL WHERE id=?").run(granted.subscriptionId);
    const expired = await routerSync(alpha.location);
    assert.equal(expired.ids.length, 2);
    assert.ok(expired.script.includes(`:local u "${granted.username}"`));
    assert.ok(expired.script.includes(`:local u "${granted.username}-tv"`));
    assert.ok(expired.script.includes('/ip hotspot active remove'));
    assert.equal((await api(endpoint(alpha.location, 'session?mac=AA:BB:CC:00:00:50'))).body.found, false);
    assert.deepEqual((await routerSync(alpha.location)).ids, [], 'delivery waits for the acknowledgement window before retrying');
    database.prepare("UPDATE tenant_jobs SET delivered_at=datetime('now','-61 seconds') WHERE location_id=? AND acked_at IS NULL").run(alpha.location.id);
    const redelivered = await routerSync(alpha.location);
    assert.deepEqual(redelivered.ids, expired.ids, 'offline acknowledgement retries the same revoke jobs');
    assert.equal((await routerSync(alpha.location, { ack: expired.ids })).script, '');
    assert.equal((await routerSync(alpha.location)).script, '', 'acknowledged expiry is not emitted forever');
  });

  await test('business plan payment requires verified settlement and activates the chosen plan exactly once', async () => {
    const preference = await api('/api/business/billing-plan', { method: 'POST', token: alpha.token,
      body: { plan: 'growth', collectionMode: 'fiti' } });
    assert.equal(preference.status, 200);
    assert.equal(preference.body.checkoutRequired, true);
    assert.equal((await api('/api/business/me', { token: alpha.token })).body.business.plan, 'starter');
    const payment = await api('/api/business/billing/checkout', { method: 'POST', token: alpha.token,
      body: { plan: 'growth', phone: '0712000060' } });
    assert.equal(payment.status, 200, JSON.stringify(payment.body));
    assert.equal(payment.body.amount, 3500);
    const id = payment.body.checkoutRequestId;
    const billingPath = `/api/business/billing/status/${id}`;
    assert.equal((await api(billingPath, { token: bravo.token })).status, 404);
    await callback(id);
    assert.equal((await api('/api/business/me', { token: alpha.token })).body.business.plan, 'starter', 'forged callback cannot upgrade a business');
    payments.get(id).result = 0;
    await Promise.all([callback(id), callback(id)]);
    await eventually(() => tenant.businessBillingTransaction.get(id).status === 'paid', 'verified plan payment was not settled');
    const active = await api(billingPath, { token: alpha.token });
    assert.equal(active.body.status, 'paid');
    const account = (await api('/api/business/me', { token: alpha.token })).body.business;
    assert.equal(account.plan, 'growth');
    assert.equal(account.billing_status, 'active');
    const expiry = account.billing_expires_at;
    await callback(id);
    await api(billingPath, { token: alpha.token });
    assert.equal((await api('/api/business/me', { token: alpha.token })).body.business.billing_expires_at, expiry);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM business_billing_grants WHERE checkout_request_id=?').get(id).n, 1);
  });

  await test('platform administrator request limits cover changing record IDs', async () => {
    // Three administrator checks above already consumed three of the shared
    // 30-attempt window. Each new ticket ID must still count against it.
    for (let i = 0; i < 27; i++) {
      const response = await api(`/api/admin/business-operations/tickets/rate-limit-${i}`, {
        adminToken: 'integration-admin-token',
      });
      assert.equal(response.status, 404);
    }
    const blocked = await api('/api/admin/business-operations/tickets/rate-limit-blocked', {
      adminToken: 'integration-admin-token',
    });
    assert.equal(blocked.status, 429);
  });

  console.log(`\nTenant HTTP integration: ${passed} passed, ${failures.length} failed`);
  return failures.length ? 1 : 0;
}

main().then(finish, (error) => {
  console.error(error.code === 'EPERM'
    ? 'Tenant HTTP integration could not start: this environment does not permit a local HTTP listener (EPERM).'
    : error.stack);
  finish(1);
});

async function finish(exitCode) {
  global.fetch = realFetch;
  if (server && server.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (database) database.close();
  // Delete only this run's generated files, using resolved explicit paths.
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.join(temporaryDirectory, `hotspot.db${suffix}`)); } catch (error) {
      if (error.code !== 'ENOENT') console.error(error.message);
    }
  }
  try { fs.rmdirSync(temporaryDirectory); } catch (error) { console.error(error.message); }
  process.exit(exitCode);
}

'use strict';

// Tenant payments to Wi‑Fi Fiti through Wi‑Fi Fiti's own Tuma account, with
// Daraja as fallback. Real Express app and SQLite; Tuma and Safaricom are
// mocked. No money moves.
//   node --require ./test/in-process-http.js test/platform-tuma.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-platform-tuma-'));
const CALLBACK_SECRET = 'platform-tuma-callback-secret-0123456789';
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://wifi-fiti.example.test', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke', PORTAL_ROOT_DOMAIN: 'wififiti.co.ke', EDGE_GATEWAY_SECRET: 'platform-tuma-edge-gateway-secret-for-tests', PORTAL_GATEWAY_ENABLED: 'true',
  MPESA_ENV: 'production', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  PROVISION_MODE: 'poll', SITE_ID: 'site', SITE_TOKEN: 'site-token', TENANT_SECRETS_KEY: 'platform-tuma-test-key',
  ADMIN_TOKEN: 'admin', DATABASE_PATH: path.join(dir, 'hotspot.db'),
  TUMA_API_BASE_URL: 'https://api.tuma.test', TUMA_API_EMAIL: 'platform@wififiti.test',
  TUMA_API_KEY: 'tuma_platform_key_0123456789abcdef', TUMA_CALLBACK_SECRET: CALLBACK_SECRET,
});

const realFetch = global.fetch;
const calls = { tuma: [], daraja: [] };
let tumaDown = false; let n = 0;
global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  const body = options.body ? JSON.parse(options.body) : null;
  if (target.hostname === 'api.tuma.test') {
    calls.tuma.push({ path: target.pathname, body });
    if (target.pathname === '/auth/token') return Response.json({ success: true, token: 'jwt-platform' });
    if (target.pathname === '/payment/stk-push') {
      if (tumaDown) return Response.json({ success: false, message: 'Service unavailable' }, { status: 503 });
      return Response.json({ success: true, data: { checkout_request_id: `ws_CO_TUMA_${++n}`, merchant_request_id: `m${n}` } });
    }
  }
  if (target.hostname === 'api.safaricom.co.ke') {
    calls.daraja.push({ path: target.pathname, body });
    if (target.pathname === '/oauth/v1/generate') return Response.json({ access_token: 'daraja', expires_in: 3599 });
    if (target.pathname === '/mpesa/stkpush/v1/processrequest') return Response.json({ ResponseCode: '0', CheckoutRequestID: `ws_CO_DARAJA_${++n}`, MerchantRequestID: `d${n}` });
    if (target.pathname === '/mpesa/stkpushquery/v1/query') return Response.json({ errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }, { status: 500 });
  }
  throw new Error(`unexpected request to ${target.href}`);
};

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 4).join('\n       ')}`); }
}

(async () => {
  let server;
  const originalListen = http.Server.prototype.listen;
  const listening = new Promise((resolve) => {
    http.Server.prototype.listen = function (...args) { server = this; this.once('listening', resolve); return originalListen.apply(this, args); };
  });
  try { require('../src/server'); } finally { http.Server.prototype.listen = originalListen; }
  await listening;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const database = require('../src/lib/db').db;

  database.prepare(`INSERT INTO businesses (id, name, owner_name, owner_phone, email, password_hash, billing_status, billing_expires_at, onboarding_state)
    VALUES ('biz', 'Kitale Cyber', 'Don', '0712345678', 'don@test.ke', 'x', 'trial', datetime('now','-1 day'), 'complete')`).run();
  database.prepare(`INSERT INTO business_sessions (token_hash, business_id, expires_at) VALUES (?, 'biz', datetime('now','+1 day'))`)
    .run(crypto.createHash('sha256').update('session-token').digest('hex'));

  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', Host: 'cloud.wififiti.co.ke', Authorization: 'Bearer session-token', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const callback = (body) => call('POST', `/api/tuma/callback?key=${encodeURIComponent(CALLBACK_SECRET)}`, body);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const row = (id) => database.prepare('SELECT * FROM business_billing_transactions WHERE checkout_request_id=?').get(id);
  const business = () => database.prepare('SELECT hotspot_concurrent, hotspot_billing_expires_at FROM businesses WHERE id=?').get('biz');

  console.log('\nPlatform collection through Tuma');
  let checkout;

  await test('a prepaid service payment is prompted through Wi‑Fi Fiti\'s Tuma account', async () => {
    const res = await call('POST', '/api/business/network-services/checkout', { hotspotConcurrent: 100, phone: '0712345678' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    checkout = res.body.checkoutRequestId;
    assert.match(checkout, /^ws_CO_TUMA_/);
    const push = calls.tuma.find((c) => c.path === '/payment/stk-push');
    assert.equal(push.body.amount, 1000);
    assert.match(push.body.callback_url, /\/api\/tuma\/callback\?key=/);
    assert.equal(calls.daraja.filter((c) => c.path.includes('stkpush/v1/processrequest')).length, 0);
    assert.equal(row(checkout).payment_source, 'tuma');
  });

  await test('the status check waits for Tuma instead of asking Daraja', async () => {
    const before = calls.daraja.length;
    const res = await call('GET', `/api/business/billing/status/${checkout}`);
    assert.equal(res.body.status, 'pending');
    assert.equal(calls.daraja.length, before);
  });

  await test('a short payment never activates the service', async () => {
    await callback({ checkout_request_id: checkout, status: 'completed', result_code: 0, amount: 10, mpesa_receipt_number: 'TUMA000001' });
    await settle();
    assert.equal(row(checkout).status, 'pending');
    assert.equal(business().hotspot_concurrent, 0);
  });

  await test('Tuma\'s success callback activates the service once', async () => {
    await callback({ checkout_request_id: checkout, status: 'completed', result_code: 0, amount: 1000, mpesa_receipt_number: 'TUMA000002' });
    await settle();
    assert.equal(row(checkout).status, 'paid');
    assert.equal(row(checkout).mpesa_receipt, 'TUMA000002');
    const after = business();
    assert.equal(after.hotspot_concurrent, 100);
    assert.ok(after.hotspot_billing_expires_at);
    await callback({ checkout_request_id: checkout, status: 'completed', result_code: 0, amount: 1000, mpesa_receipt_number: 'TUMA000002' });
    await settle();
    assert.equal(business().hotspot_billing_expires_at, after.hotspot_billing_expires_at, 'a replay adds no time');
    const status = await call('GET', `/api/business/billing/status/${checkout}`);
    assert.equal(status.body.status, 'paid');
  });

  await test('a failed Tuma payment is recorded as failed', async () => {
    const res = await call('POST', '/api/business/network-services/checkout', { hotspotConcurrent: 200, phone: '0712345679' });
    await callback({ checkout_request_id: res.body.checkoutRequestId, status: 'failed', result_code: 1032, failure_reason: 'Request cancelled by user' });
    await settle();
    assert.equal(row(res.body.checkoutRequestId).status, 'failed');
    assert.equal(business().hotspot_concurrent, 100);
  });

  await test('if Tuma is unreachable the prompt falls back to Daraja', async () => {
    tumaDown = true;
    database.prepare(`UPDATE business_billing_transactions SET created_at=datetime('now','-10 minutes') WHERE status='pending'`).run();
    const res = await call('POST', '/api/business/network-services/checkout', { hotspotConcurrent: 100, phone: '0712345670' });
    tumaDown = false;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.checkoutRequestId, /^ws_CO_DARAJA_/);
    assert.equal(row(res.body.checkoutRequestId).payment_source, 'daraja');
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

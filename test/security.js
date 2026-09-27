'use strict';

// Regression tests for the security audit fixes. Real Express app and SQLite;
// Safaricom and Tuma are mocked. No money moves.
//   node --require ./test/in-process-http.js test/security.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-security-'));
const CALLBACK_SECRET = 'security-tuma-callback-secret-0123456789';
const SITE_C2B_TOKEN = 'site-c2b-token-0123456789abcdef';
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://wifi-fiti.example.test', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke', PORTAL_ROOT_DOMAIN: 'wififiti.co.ke', EDGE_GATEWAY_SECRET: 'security-edge-gateway-secret-for-tests', PORTAL_GATEWAY_ENABLED: 'true',
  MPESA_ENV: 'production', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  MPESA_C2B_CALLBACK_TOKEN: SITE_C2B_TOKEN, MPESA_CALLBACK_IPS: '196.201.214.200',
  PROVISION_MODE: 'poll', SITE_ID: 'site', SITE_TOKEN: 'site-token', TENANT_SECRETS_KEY: 'security-test-key',
  ADMIN_TOKEN: 'admin', DATABASE_PATH: path.join(dir, 'hotspot.db'),
  TUMA_API_BASE_URL: 'https://api.tuma.test', TUMA_API_EMAIL: 'platform@wififiti.test',
  TUMA_API_KEY: 'tuma_platform_key_0123456789abcdef', TUMA_CALLBACK_SECRET: CALLBACK_SECRET,
});

const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  if (target.hostname === 'api.tuma.test' && target.pathname === '/auth/token') return Response.json({ success: true, token: 'jwt' });
  if (target.hostname === 'api.safaricom.co.ke' && target.pathname === '/oauth/v1/generate') return Response.json({ access_token: 'daraja', expires_in: 3599 });
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

  // A paying tenant (not on trial) with one location and a KES 20 package.
  database.prepare(`INSERT INTO businesses (id, name, owner_name, owner_phone, email, password_hash, billing_status, billing_expires_at, onboarding_state, hotspot_concurrent, hotspot_billing_expires_at)
    VALUES ('biz', 'Kitale Cyber', 'Don', '0712345678', 'don@test.ke', 'x', 'active', datetime('now','+20 day'), 'complete', 100, datetime('now','+20 day'))`).run();
  database.prepare(`INSERT INTO business_sessions (token_hash, business_id, expires_at) VALUES (?, 'biz', datetime('now','+1 day'))`)
    .run(crypto.createHash('sha256').update('session-token').digest('hex'));
  database.prepare(`INSERT INTO locations (id, business_id, name, router_token) VALUES ('loc', 'biz', 'Main', 'rt')`).run();
  database.prepare(`INSERT INTO business_packages (business_id, name, price, seconds) VALUES ('biz', 'Day pass', 20, 86400)`).run();

  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', Host: 'cloud.wififiti.co.ke', Authorization: 'Bearer session-token', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  const tx = (receipt) => database.prepare('SELECT * FROM tenant_transactions WHERE mpesa_receipt=?').get(receipt);
  const c2bBody = (receipt, extra = {}) => ({ TransID: receipt, TransAmount: '20', BusinessShortCode: '600100', BillRefNumber: '0711000001', MSISDN: '254711000001', ...extra });

  console.log('\nC2B confirmation');
  let urls;
  await test('saving C2B settings returns secret callback URLs', async () => {
    const saved = await call('POST', '/api/business/integrations/c2b', { shortcode: '600100', locationId: 'loc' });
    assert.equal(saved.status, 201);
    assert.match(saved.body.callbackUrl, /\/api\/c2b\/t\/[a-f0-9]{48}\/confirm$/);
    assert.match(saved.body.validationUrl, /\/validate$/);
    assert.doesNotMatch(saved.body.callbackUrl, /mpesa|safaricom/i, 'Daraja rejects URLs with these words');
    urls = saved.body;
    const again = await call('GET', '/api/business/integrations/c2b');
    assert.equal(again.body.callbackUrl, urls.callbackUrl, 'the token is stable across reads');
  });
  const tokenPath = () => new URL(urls.callbackUrl).pathname;

  await test('a forged confirmation on the old URL provisions nothing', async () => {
    await call('POST', '/api/mpesa/c2b/tenant/confirmation', c2bBody('FORGED001'));
    await settle();
    assert.equal(tx('FORGED001'), undefined);
  });
  await test('a wrong token is rejected', async () => {
    const response = await call('POST', `/api/c2b/t/${'0'.repeat(48)}/confirm`, c2bBody('FORGED002'));
    assert.equal(response.status, 404);
    await settle();
    assert.equal(tx('FORGED002'), undefined);
  });
  await test('the right token with another shortcode provisions nothing', async () => {
    await call('POST', tokenPath(), c2bBody('FORGED003', { BusinessShortCode: '999999' }));
    await settle();
    assert.equal(tx('FORGED003'), undefined);
  });
  await test('the secret URL provisions a real payment', async () => {
    const response = await call('POST', tokenPath(), c2bBody('REAL0001'));
    assert.equal(response.body.ResultCode, 0);
    await settle();
    assert.equal(tx('REAL0001').status, 'paid');
  });
  await test('the old URL still works from a Safaricom address', async () => {
    process.env.MPESA_CALLBACK_IPS = '127.0.0.1';
    try {
      await call('POST', '/api/mpesa/c2b/tenant/confirmation', c2bBody('REAL0002'));
      await settle();
      assert.equal(tx('REAL0002').status, 'paid');
    } finally { process.env.MPESA_CALLBACK_IPS = '196.201.214.200'; }
  });
  await test('an unauthenticated reversal cannot cut a customer off', async () => {
    await call('POST', '/api/mpesa/c2b/tenant/reversal', { OriginalTransactionID: 'REAL0001' });
    await settle();
    assert.equal(tx('REAL0001').status, 'paid');
  });
  await test('a reversal on the secret URL is honoured', async () => {
    await call('POST', new URL(urls.callbackUrl).pathname.replace(/confirm$/, 'reversal'), { OriginalTransactionID: 'REAL0001' });
    await settle();
    assert.equal(tx('REAL0001').status, 'reversed');
  });
  await test('the site C2B URL needs its token', async () => {
    const wrong = await call('POST', '/api/c2b/site/not-the-token-000000000/confirm', { TransID: 'SITE001', TransAmount: '50', BusinessShortCode: '174379', BillRefNumber: '0722000009' });
    assert.equal(wrong.status, 404);
    const legacy = await call('POST', '/api/mpesa/c2b/confirmation', { TransID: 'SITE002', TransAmount: '50', BusinessShortCode: '174379', BillRefNumber: '0722000009' });
    assert.equal(legacy.body.ResultCode, 0, 'Safaricom still gets an acknowledgement');
    await settle();
    const lookup = await call('POST', '/api/session/lookup', { phone: '0722000009' });
    assert.equal(lookup.body.found, false, 'a forged site confirmation grants no time');
  });

  // @@MORE@@

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });

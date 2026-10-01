'use strict';

// Regression test for OWNER_PHONE_VERIFICATION_DISABLED: a temporary kill
// switch for pausing owner-phone SMS verification (and the Tuma payout
// account block that depends on it) without clearing AFRICASTALKING_API_KEY.
// Real Express app and SQLite; Safaricom and Tuma are mocked. No money moves.
//   node --require ./test/in-process-http.js test/phone-verification-disabled.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-phone-verify-disabled-'));
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://wifi-fiti.example.test', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke', PORTAL_ROOT_DOMAIN: 'wififiti.co.ke', EDGE_GATEWAY_SECRET: 'phone-verify-disabled-edge-gateway-secret',
  MPESA_ENV: 'production', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  MPESA_C2B_CALLBACK_TOKEN: 'site-c2b-token-0123456789abcdef', MPESA_CALLBACK_IPS: '196.201.214.200',
  PROVISION_MODE: 'poll', SITE_ID: 'site', SITE_TOKEN: 'site-token', TENANT_SECRETS_KEY: 'phone-verify-disabled-test-key',
  ADMIN_TOKEN: 'admin', DATABASE_PATH: path.join(dir, 'hotspot.db'),
  TUMA_API_BASE_URL: 'https://api.tuma.test', TUMA_API_EMAIL: 'platform@wififiti.test',
  TUMA_API_KEY: 'tuma_platform_key_0123456789abcdef', TUMA_CALLBACK_SECRET: 'phone-verify-disabled-callback-secret-0123456789',
  // The Sender ID is still pending, but the key itself stays configured -
  // the kill switch, not a missing key, is what should pause verification.
  AFRICASTALKING_API_KEY: 'at-test-key', AFRICASTALKING_USERNAME: 'sandbox',
  OWNER_PHONE_VERIFICATION_DISABLED: 'true',
});
const smsSent = [];

const realFetch = global.fetch;
let pushes = 0;
global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  if (target.hostname === 'api.tuma.test' && target.pathname === '/auth/token') return Response.json({ success: true, token: 'jwt' });
  if (target.hostname === 'api.tuma.test' && target.pathname === '/payment/stk-push') return Response.json({ success: true, data: { checkout_request_id: `ws_CO_PVD_${++pushes}`, merchant_request_id: `m${pushes}` } });
  if (target.hostname === 'api.tuma.test' && target.pathname === '/reference/banks') return Response.json({ success: true, data: [{ id: 'mpesa-till', name: 'M-Pesa Till', code: 'BUYGOODS' }] });
  if (target.hostname === 'api.tuma.test' && target.pathname === '/businesses' && options.method === 'POST') return Response.json({ success: true, data: { id: 'tuma-biz-1', api_key: 'tuma-child-key', email: 'trial1-payout@test.ke' } });
  if (target.hostname === 'api.sandbox.africastalking.com') {
    const form = new URLSearchParams(String(options.body));
    smsSent.push({ to: form.get('to'), message: form.get('message') });
    return Response.json({ SMSMessageData: { Recipients: [{ statusCode: 100, status: 'Success', messageId: `at${smsSent.length}` }] } });
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

  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', Host: 'cloud.wififiti.co.ke', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const sessionFor = (id, token) => database.prepare(`INSERT INTO business_sessions (token_hash, business_id, expires_at) VALUES (?, ?, datetime('now','+1 day'))`)
    .run(crypto.createHash('sha256').update(token).digest('hex'), id);
  const trialBusiness = (id, phone) => {
    database.prepare(`INSERT INTO businesses (id, name, owner_name, owner_phone, email, password_hash, billing_status, billing_expires_at, onboarding_state, collection_mode)
      VALUES (?, 'Trial Co', 'Owner', ?, ?, 'x', 'trial', datetime('now','+6 day'), 'complete', 'fiti')`).run(id, phone, `${id}@test.ke`);
    sessionFor(id, `${id}-token`);
  };
  const as = (id) => ({ Authorization: `Bearer ${id}-token` });

  trialBusiness('trial1', '254722333111');
  database.prepare(`INSERT INTO locations (id, business_id, name, router_token) VALUES ('tloc', 'trial1', 'Trial', 'rt-pvd')`).run();
  database.prepare(`INSERT INTO business_packages (business_id, name, price, seconds) VALUES ('trial1', 'Trial hour', 2, 3600)`).run();
  const trialPkg = database.prepare("SELECT id FROM business_packages WHERE business_id='trial1'").get().id;

  console.log('\nOWNER_PHONE_VERIFICATION_DISABLED=true');
  await test('the API key stays configured, but the switch reports verification unavailable', async () => {
    const me = await call('GET', '/api/business/me', null, as('trial1'));
    assert.equal(me.body.phoneVerification.available, false, JSON.stringify(me.body.phoneVerification));
    assert.equal(me.body.phoneVerification.required, false, JSON.stringify(me.body.phoneVerification));
  });
  await test('an unverified trial can sell while the switch is on', async () => {
    const response = await call('POST', '/api/tenant/tloc/pay', { packageId: trialPkg, phone: '0711000030', mac: 'AA:BB:CC:30:00:01' });
    assert.notEqual(response.status, 402, JSON.stringify(response.body));
  });
  await test('no SMS is ever sent while the switch is on', () => {
    assert.equal(smsSent.length, 0);
  });
  await test('an unverified trial can still create its Tuma payout account', async () => {
    const saved = await call('POST', '/api/business/tuma/settlement', { email: 'trial1-payout@test.ke', destinationType: 'till', accountNumber: '123456', settlementName: 'Trial Owner', mobile: '0722333111' }, as('trial1'));
    assert.notEqual(saved.status, 403, JSON.stringify(saved.body));
    assert.notDeepEqual(saved.body && saved.body.needs, { action: 'verify_phone' }, JSON.stringify(saved.body));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

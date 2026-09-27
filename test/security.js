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
  AFRICASTALKING_API_KEY: 'at-test-key', AFRICASTALKING_USERNAME: 'sandbox',
});
const smsSent = [];

const realFetch = global.fetch;
let pushes = 0;
global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  if (target.hostname === 'api.tuma.test' && target.pathname === '/auth/token') return Response.json({ success: true, token: 'jwt' });
  if (target.hostname === 'api.tuma.test' && target.pathname === '/payment/stk-push') return Response.json({ success: true, data: { checkout_request_id: `ws_CO_SEC_${++pushes}`, merchant_request_id: `m${pushes}` } });
  if (target.hostname === 'api.sandbox.africastalking.com') {
    const form = new URLSearchParams(String(options.body));
    smsSent.push({ to: form.get('to'), message: form.get('message') });
    return Response.json({ SMSMessageData: { Recipients: [{ statusCode: 100, status: 'Success', messageId: `at${smsSent.length}` }] } });
  }
  if (target.hostname === 'api.safaricom.co.ke' && target.pathname === '/oauth/v1/generate') return Response.json({ access_token: 'daraja', expires_in: 3599 });
  if (target.hostname === 'api.safaricom.co.ke' && target.pathname === '/mpesa/stkpush/v1/processrequest') return Response.json({ ResponseCode: '0', CheckoutRequestID: `ws_CO_DAR_${++pushes}`, MerchantRequestID: `d${pushes}` });
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

  console.log('\nSMS credits and Tuma callbacks');
  const tuma = (body) => call('POST', `/api/tuma/callback?key=${encodeURIComponent(CALLBACK_SECRET)}`, body);
  const credits = () => (database.prepare("SELECT credits_available FROM fiti_signal_accounts WHERE business_id='biz'").get() || { credits_available: 0 }).credits_available;
  await test('a tenant can no longer mark SMS credits paid', async () => {
    const created = database.prepare(`INSERT INTO fiti_signal_purchases (id,business_id,package_id,amount,credits) VALUES ('smspay_x','biz','sms-500',500,500) RETURNING id`).get();
    const response = await call('POST', `/api/business/sms/packages/${created.id}/confirm`, { paymentRef: 'MADEUP' });
    assert.equal(response.status, 404);
    assert.equal(credits(), 0);
  });
  await test('only catalogue SMS amounts can be bought', async () => {
    const response = await call('POST', '/api/business/sms/packages', { amount: 1 });
    assert.equal(response.status, 400);
  });
  await test('SMS credits arrive only after the payment callback', async () => {
    const started = await call('POST', '/api/business/sms/packages', { amount: 500 });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(credits(), 0, 'no credits before payment');
    await tuma({ checkout_request_id: started.body.checkoutRequestId, status: 'completed', result_code: 0, amount: 500, mpesa_receipt_number: 'SMSRCPT01' });
    await settle();
    assert.equal(credits(), 500);
  });

  const tenantLib = require('../src/lib/tenant');
  const tumaTx = (id, amount) => {
    tenantLib.insertTransaction.run({ checkoutRequestId: id, merchantRequestId: `m-${id}`, businessId: 'biz', locationId: 'loc', phone: '254711000002',
      packageId: 1, packageName: 'Day pass', amount, seconds: 86400, rateLimit: null, mac: 'AA:BB:CC:00:00:02', ip: null });
    tenantLib.setTransactionTerms.run({ checkoutRequestId: id, paymentSource: 'tuma_direct', platformFee: 0 });
  };
  const status = (id) => database.prepare('SELECT status FROM tenant_transactions WHERE checkout_request_id=?').get(id).status;
  await test('a Tuma success without an amount grants nothing', async () => {
    tumaTx('ws_CO_TUMA_NOAMT', 20);
    await tuma({ checkout_request_id: 'ws_CO_TUMA_NOAMT', merchant_request_id: 'm-ws_CO_TUMA_NOAMT', status: 'completed', result_code: 0, mpesa_receipt_number: 'TUMARC001' });
    await settle();
    assert.equal(status('ws_CO_TUMA_NOAMT'), 'pending');
  });
  await test('a Tuma success for the wrong amount grants nothing', async () => {
    tumaTx('ws_CO_TUMA_LOW', 20);
    await tuma({ checkout_request_id: 'ws_CO_TUMA_LOW', merchant_request_id: 'm-ws_CO_TUMA_LOW', status: 'completed', result_code: 0, amount: 1, mpesa_receipt_number: 'TUMARC002' });
    await settle();
    assert.equal(status('ws_CO_TUMA_LOW'), 'pending');
  });
  await test('a Tuma success with the right amount is paid', async () => {
    tumaTx('ws_CO_TUMA_OK', 20);
    await tuma({ checkout_request_id: 'ws_CO_TUMA_OK', merchant_request_id: 'm-ws_CO_TUMA_OK', status: 'completed', result_code: 0, amount: 20, mpesa_receipt_number: 'TUMARC003' });
    await settle();
    assert.equal(status('ws_CO_TUMA_OK'), 'paid');
  });

  console.log('\nMAC and password leaks');
  await test('device discovery hides MACs behind short-lived tokens', async () => {
    tenantLib.recordRouterDevices({ locationId: 'loc', encoded: 'AA:BB:CC:11:22:33~10.5.50.9~LivingRoomTV' });
    const found = await call('GET', '/api/tenant/loc/device-discovery');
    assert.equal(found.status, 200);
    const text = JSON.stringify(found.body);
    assert.doesNotMatch(text, /11:22:33|112233/, text);
    const device = found.body.devices.find((item) => item.label === 'LivingRoomTV');
    assert.match(device.id, /^dev:/);
    database.prepare("UPDATE business_payment_integrations SET provider='fiti' WHERE business_id='biz'").run();
    database.prepare("UPDATE businesses SET collection_mode='fiti' WHERE id='biz'").run();
    const wrong = await call('POST', '/api/tenant/loc/pay', { packageId: 1, phone: '0711000009', deviceType: 'tv', mac: device.id, deviceConfirm: '0000' });
    assert.equal(wrong.status, 400);
    const right = await call('POST', '/api/tenant/loc/pay', { packageId: 1, phone: '0711000009', deviceType: 'tv', mac: device.id, deviceConfirm: '2233' });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    const row = database.prepare("SELECT mac FROM tenant_transactions WHERE phone='254711000009' ORDER BY rowid DESC").get();
    assert.equal(row.mac, 'AA:BB:CC:11:22:33');
    const other = await call('POST', '/api/tenant/other-location/pay', { packageId: 1, phone: '0711000009', deviceType: 'tv', mac: device.id, deviceConfirm: '2233' });
    assert.equal(other.status, 404);
  });
  await test('looking up a phone number never returns full MACs', async () => {
    database.prepare(`INSERT INTO tenant_subscriptions (id,business_id,location_id,router_username,payer_phone,mac,password,total_seconds,expires_at)
      VALUES ('sub-leak','biz','loc','u-leak','254711000003','AA:BB:CC:44:55:66','PW1234',3600,datetime('now','+1 hour'))`).run();
    for (const route of ['/api/tenant/loc/subscriptions/check', '/api/tenant/loc/devices/list']) {
      const response = await call('POST', route, { phone: '0711000003' });
      assert.equal(response.status, 200);
      const text = JSON.stringify(response.body);
      assert.ok(text.includes('sub-leak'), route);
      assert.doesNotMatch(text, /AA:BB:CC:44|PW1234/, `${route}: ${text}`);
    }
  });
  await test('a PayBill payment binds to the first device that recovers it', async () => {
    const first = await call('POST', '/api/tenant/loc/payment-recover', { phone: '0711000001', receipt: 'REAL0002', mac: 'AA:BB:CC:77:77:77' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.password, 'the recovering device gets its credentials');
    assert.equal(tx('REAL0002').mac, 'AA:BB:CC:77:77:77');
  });
  await test('phone + receipt from another device re-sends but reveals nothing', async () => {
    const other = await call('POST', '/api/tenant/loc/payment-recover', { phone: '0711000001', receipt: 'REAL0002', mac: 'AA:BB:CC:88:88:88' });
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'other_device');
    assert.equal(other.body.password, undefined);
    assert.equal(other.body.sessionToken, undefined);
  });
  await test('legacy lookup by phone gives the password only to the device that owns the time', async () => {
    await call('POST', `/api/c2b/site/${SITE_C2B_TOKEN}/confirm`, { TransID: 'SITE003', TransAmount: '50', BusinessShortCode: '174379', BillRefNumber: '0722000010' });
    await settle(); await settle();
    const bare = await call('POST', '/api/session/lookup', { phone: '0722000010' });
    assert.equal(bare.body.found, true);
    assert.equal(bare.body.password, undefined, 'no device, no password');
    const mine = await call('POST', '/api/session/lookup', { phone: '0722000010', mac: 'AA:BB:CC:00:10:01' });
    assert.ok(mine.body.password, 'first device picks up the PayBill time');
    const theirs = await call('POST', '/api/session/lookup', { phone: '0722000010', mac: 'AA:BB:CC:00:10:02' });
    assert.equal(theirs.body.found, true);
    assert.equal(theirs.body.password, undefined);
    const check = await call('POST', '/api/subscriptions/check', { phone: '0722000010' });
    assert.doesNotMatch(JSON.stringify(check.body), /AA:BB:CC:00:10:01/);
  });
  await test('legacy TV add needs the paying device, not just the number', async () => {
    const byPhone = await call('POST', '/api/device/add', { phone: '0722000010', mac: 'AA:BB:CC:00:10:09' });
    assert.equal(byPhone.status, 409);
    const fromOwner = await call('POST', '/api/device/add', { phone: '0722000010', mac: 'AA:BB:CC:00:10:09', ownerMac: 'AA:BB:CC:00:10:01' });
    assert.equal(fromOwner.status, 200, JSON.stringify(fromOwner.body));
  });

  console.log('\nRate limits');
  await test('one package cannot be guessed at more than 20 times in 15 minutes', async () => {
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await call('POST', '/api/tenant/loc/subscriptions/transfer', { phone: '0711000003', subscriptionId: 'sub-leak', password: `GUESS${i}`, mac: `AA:BB:CC:DD:${String(i).padStart(2, '0')}:01` });
    }
    assert.equal(last.status, 429);
  });
  const edge = (ip) => ({ 'X-WiFi-Fiti-Edge': process.env.EDGE_GATEWAY_SECRET, 'X-WiFi-Fiti-Client-IP': ip });
  await test('claim-code guesses from many addresses still run out', async () => {
    let status;
    for (let i = 0; i < 101; i += 1) {
      const response = await call('POST', '/api/tenant/loc/claim', { code: String(10000000 + i), mac: `AA:BB:CC:EE:${String(i % 100).padStart(2, '0')}:${i < 100 ? '01' : '02'}` }, edge(`198.51.100.${i % 250}`));
      status = response.status;
      if (i === 100) assert.match(response.body.error, /Wait a few minutes/);
    }
    assert.equal(status, 429);
  });
  await test('a forged client IP header without the edge secret is ignored', async () => {
    const response = await call('POST', '/api/tenant/loc/claim', { code: '12345678', mac: 'AA:BB:CC:EE:00:02' }, { 'X-WiFi-Fiti-Client-IP': '203.0.113.9' });
    assert.equal(response.status, 429, 'still inside the same location budget');
  });

  console.log('\nOnboarding and trial');
  const sessionFor = (id, token) => database.prepare(`INSERT INTO business_sessions (token_hash, business_id, expires_at) VALUES (?, ?, datetime('now','+1 day'))`)
    .run(crypto.createHash('sha256').update(token).digest('hex'), id);
  const trialBusiness = (id, phone) => {
    database.prepare(`INSERT INTO businesses (id, name, owner_name, owner_phone, email, password_hash, billing_status, billing_expires_at, onboarding_state, collection_mode)
      VALUES (?, 'Trial Co', 'Owner', ?, ?, 'x', 'trial', datetime('now','+6 day'), 'complete', 'fiti')`).run(id, phone, `${id}@test.ke`);
    sessionFor(id, `${id}-token`);
  };
  const as = (id) => ({ Authorization: `Bearer ${id}-token` });
  trialBusiness('trial1', '254722111111');
  database.prepare(`INSERT INTO locations (id, business_id, name, router_token) VALUES ('tloc', 'trial1', 'Trial', 'rt2')`).run();
  database.prepare(`INSERT INTO business_packages (business_id, name, price, seconds) VALUES ('trial1', 'Trial hour', 2, 3600)`).run();
  const trialPkg = database.prepare("SELECT id FROM business_packages WHERE business_id='trial1'").get().id;
  const codeFromSms = () => (smsSent[smsSent.length - 1].message.match(/\b(\d{6})\b/) || [])[1];

  await test('an unverified trial cannot sell', async () => {
    const response = await call('POST', '/api/tenant/tloc/pay', { packageId: trialPkg, phone: '0711000020', mac: 'AA:BB:CC:20:00:01' });
    assert.equal(response.status, 402, JSON.stringify(response.body));
    const me = await call('GET', '/api/business/me', null, as('trial1'));
    assert.equal(me.body.phoneVerification.required, true);
  });
  await test('typing someone else\'s number does not end their trial', async () => {
    trialBusiness('squatter', '254722111111');
    const victim = await call('GET', '/api/business/me', null, as('trial1'));
    assert.equal(victim.body.business.trial_ended_reason, null);
  });
  await test('a wrong SMS code is refused and counted', async () => {
    const sent = await call('POST', '/api/business/phone/verify/start', {}, as('trial1'));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(smsSent[smsSent.length - 1].to, '+254722111111');
    const wrong = await call('POST', '/api/business/phone/verify/confirm', { code: '000000' === codeFromSms() ? '111111' : '000000' }, as('trial1'));
    assert.equal(wrong.status, 400);
  });
  await test('the right SMS code verifies the phone and unlocks sales', async () => {
    const ok = await call('POST', '/api/business/phone/verify/confirm', { code: codeFromSms() }, as('trial1'));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.trialEnded, null);
    const response = await call('POST', '/api/tenant/tloc/pay', { packageId: trialPkg, phone: '0711000020', mac: 'AA:BB:CC:20:00:01' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  });
  await test('verifying a number already used for a trial ends the second trial', async () => {
    await call('POST', '/api/business/phone/verify/start', { phone: '0722111111' }, as('squatter'));
    const confirmed = await call('POST', '/api/business/phone/verify/confirm', { code: codeFromSms() }, as('squatter'));
    assert.equal(confirmed.status, 200);
    assert.match(String(confirmed.body.trialEnded), /already used/);
  });
  await test('SMS codes are capped per workspace', async () => {
    trialBusiness('spammer', '254722333333');
    let last;
    for (let i = 0; i < 4; i += 1) last = await call('POST', '/api/business/phone/verify/start', { phone: `07223333${String(30 + i)}` }, as('spammer'));
    assert.equal(last.status, 429);
  });
  await test('trial packages last at most a day', async () => {
    const long = await call('POST', '/api/business/packages', { name: 'Week', price: 3, hours: 168 }, as('trial1'));
    assert.equal(long.status, 400);
    assert.equal(long.body.trialLimit, 'duration');
  });
  await test('a trial hotspot serves at most 10 customers at once', async () => {
    for (let i = 0; i < 10; i += 1) {
      database.prepare(`INSERT INTO tenant_subscriptions (id,business_id,location_id,router_username,payer_phone,mac,password,total_seconds,expires_at)
        VALUES (?, 'trial1', 'tloc', ?, '254711000030', ?, 'PW', 3600, datetime('now','+1 hour'))`).run(`tsub${i}`, `tu${i}`, `AA:BB:CC:30:00:${String(i).padStart(2, '0')}`);
    }
    const response = await call('POST', '/api/tenant/tloc/pay', { packageId: trialPkg, phone: '0711000031', mac: 'AA:BB:CC:31:00:01' });
    assert.equal(response.status, 402, JSON.stringify(response.body));
  });
  await test('a lapsed trial with no plan keeps a one-router limit', async () => {
    database.prepare(`INSERT INTO businesses (id, name, owner_name, owner_phone, email, password_hash, billing_status, billing_expires_at, onboarding_state)
      VALUES ('lapsed', 'Lapsed', 'Owner', '254722444444', 'lapsed@test.ke', 'x', 'trial', datetime('now','-10 day'), 'complete')`).run();
    sessionFor('lapsed', 'lapsed-token');
    database.prepare(`INSERT INTO locations (id, business_id, name, router_token) VALUES ('lloc', 'lapsed', 'One', 'rt3')`).run();
    const second = await call('POST', '/api/business/locations', { location: 'Two', routerName: 'R2' }, as('lapsed'));
    assert.equal(second.status, 402, JSON.stringify(second.body));
  });

  console.log('\nAccount recovery');
  await test('forgot-password answers the same for unknown emails', async () => {
    const response = await call('POST', '/api/business/forgot-password', { email: 'nobody@nowhere.test' });
    assert.equal(response.status, 200);
  });
  await test('a password reset signs out every session', async () => {
    database.prepare(`INSERT INTO business_email_verifications (id, email, purpose, business_id, code_hash, expires_at, last_sent_at)
      VALUES ('verify_reset', 'don@test.ke', 'reset', 'biz', ?, datetime('now','+3 minutes'), datetime('now'))`).run(crypto.createHash('sha256').update('123456').digest('hex'));
    const reset = await call('POST', '/api/business/reset-password', { verificationId: 'verify_reset', code: '123456', password: 'new-password-1' });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const me = await call('GET', '/api/business/me');
    assert.equal(me.status, 401);
  });

  // @@MORE@@

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });

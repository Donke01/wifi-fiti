'use strict';

// Per-tenant Tuma settlement tests. Tuma's HTTP API is mocked with a fake
// fetch; the SQLite database is in memory. No network, no money.
//   node --require ./test/in-process-http.js test/tuma-tenant.js
Object.assign(process.env, {
  TUMA_API_BASE_URL: 'https://api.tuma.test',
  TUMA_API_EMAIL: 'platform@wififiti.test',
  TUMA_API_KEY: 'tuma_platform_key_0123456789abcdef',
  TUMA_CALLBACK_SECRET: 'callback-secret-for-tests-0123456789',
});

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

// ---- fake Tuma ------------------------------------------------------------
const calls = [];
const tumaBusinesses = new Map();
const validKeys = new Map([['platform@wififiti.test', 'tuma_platform_key_0123456789abcdef']]);
const BANKS = [
  { id: 'b-till', name: 'In-House M-PESA Business Till Number', code: 'BUYGOODS' },
  { id: 'b-paybill', name: 'In-House M-PESA Business Paybill', code: 'PAYBILL' },
  { id: 'b-equity', name: 'Equity Bank', code: '68' },
  { id: 'b-kcb', name: 'KCB Bank', code: '01' },
];
let failCreate = null;
const realFetch = global.fetch;
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.tuma.test') return realFetch(input, options);
  const body = options.body ? JSON.parse(options.body) : null;
  const auth = String(options.headers && options.headers.Authorization || '');
  calls.push({ method: options.method || 'GET', path: url.pathname, body, auth });
  const tokenOwner = auth.startsWith('Bearer jwt:') ? auth.slice('Bearer jwt:'.length) : null;
  if (url.pathname === '/auth/token') {
    if (validKeys.get(body.email) !== body.api_key) return Response.json({ success: false, message: 'Invalid credentials' }, { status: 401 });
    return Response.json({ success: true, token: `jwt:${body.email}` });
  }
  if (!tokenOwner) return Response.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  if (url.pathname === '/reference/banks') return Response.json({ success: true, data: BANKS });
  if (url.pathname === '/businesses' && options.method === 'POST') {
    assert.equal(tokenOwner, 'platform@wififiti.test', 'sub-businesses must be created with the platform token');
    if (failCreate) return Response.json({ success: false, message: failCreate }, { status: failCreate === 'auth' ? 401 : 422 });
    for (const field of ['name', 'email', 'mobile', 'bank_id', 'account_number', 'logo']) assert.ok(body[field], `missing ${field}`);
    assert.match(body.mobile, /^254\d{9}$/);
    const id = crypto.randomUUID();
    const apiKey = `tuma_${crypto.randomBytes(20).toString('hex')}`;
    const bank = BANKS.find(b => b.id === body.bank_id);
    tumaBusinesses.set(id, { ...body });
    validKeys.set(body.email, apiKey);
    return Response.json({ success: true, data: { id, api_key: apiKey, email: body.email, bank_name: bank.name, bank_code: bank.code, account_number: body.account_number, is_active: true } }, { status: 201 });
  }
  if (url.pathname.startsWith('/businesses/') && options.method === 'PUT') {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    if (!tumaBusinesses.has(id)) return Response.json({ success: false, message: 'Not found' }, { status: 404 });
    tumaBusinesses.set(id, { ...tumaBusinesses.get(id), ...body });
    return Response.json({ success: true, data: { id, ...tumaBusinesses.get(id) } });
  }
  if (url.pathname === '/payment/stk-push') {
    return Response.json({ success: true, data: { checkout_request_id: `ws_CO_${tokenOwner}_${calls.length}`, merchant_request_id: 'm-1' } });
  }
  return Response.json({ success: false, message: 'Not found' }, { status: 404 });
};

const tuma = require('../src/lib/tuma');
const { createTumaTenants, normaliseMobile } = require('../src/lib/tuma-tenants');

// ---- helpers ---------------------------------------------------------------
const key = crypto.randomBytes(32);
const encrypt = (value) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(String(value)), c.final()]); return [iv, c.getAuthTag(), b].map(x => x.toString('base64url')).join('.'); };
const decrypt = (value) => { const [iv, tag, b] = value.split('.').map(x => Buffer.from(x, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(b), d.final()]).toString(); };

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 4).join('\n       ')}`); }
}

function harness() {
  const db = new DatabaseSync(':memory:');
  const businesses = new Map();
  const tenants = createTumaTenants({ db, tuma, encrypt, decrypt, logoUrlFor: (b) => `https://cloud.test/media/logo/${b.id}`, log: { error() {} } });
  const app = express();
  app.use(express.json());
  const businessAuth = (req, res) => { const b = businesses.get(req.get('authorization')); if (!b) { res.status(401).json({ error: 'Please sign in.' }); return null; } return b; };
  tenants.attachRoutes(app, { businessAuth });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, auth, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: auth || '' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const addBusiness = (id, extra = {}) => businesses.set(id, { id, name: `Biz ${id}`, email: `${id}@tenant.test`, owner_phone: '0712345678', ...extra });
  return { db, tenants, call, addBusiness, close: () => server.close() };
}

(async () => {
  console.log('\nTuma adapter');

  await test('normalises Kenyan mobile numbers to 254XXXXXXXXX', () => {
    assert.equal(normaliseMobile('0712 345 678'), '254712345678');
    assert.equal(normaliseMobile('+254110123456'), '254110123456');
    assert.equal(normaliseMobile('12345'), null);
  });

  await test('classifies Tuma destinations into Till, PayBill and banks', async () => {
    const list = await tuma.banks({ fresh: true });
    assert.deepEqual(list.map(b => b.kind), ['till', 'paybill', 'bank', 'bank']);
  });

  await test('caches one token per credential pair', async () => {
    calls.length = 0;
    await tuma.accessToken();
    assert.equal(calls.filter(c => c.path === '/auth/token').length, 0, 'platform token was cached by the banks call');
    validKeys.set('other@tenant.test', 'tuma_other_key_00000000000000000');
    const other = { email: 'other@tenant.test', apiKey: 'tuma_other_key_00000000000000000' };
    const token = await tuma.accessToken(other);
    await tuma.accessToken(other);
    assert.equal(token, 'jwt:other@tenant.test');
    assert.equal(calls.filter(c => c.path === '/auth/token').length, 1);
  });

  console.log('\nTenant settlement');

  await test('creates a Tuma business for an M-Pesa Till and keeps secrets encrypted', async () => {
    const h = harness(); h.addBusiness('t1');
    calls.length = 0;
    const res = await h.call('POST', '/api/business/tuma/settlement', 't1', { destinationType: 'till', accountNumber: '512 3456', settlementName: 'Wanjiru Akinyi Otieno', mobile: '0712345678' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.connected, true);
    assert.equal(res.body.account.destinationType, 'till');
    assert.equal(res.body.account.accountLast4, '3456');
    assert.ok(res.body.account.verifiedAt, 'new credentials are verified straight away');
    const create = calls.find(c => c.path === '/businesses');
    assert.equal(create.body.bank_id, 'b-till');
    assert.equal(create.body.account_number, '5123456');
    assert.equal(create.body.email, 't1@tenant.test');
    assert.equal(create.body.logo, 'https://cloud.test/media/logo/t1');
    const row = h.db.prepare('SELECT * FROM tenant_tuma_accounts WHERE business_id=?').get('t1');
    assert.ok(!row.api_key_cipher.includes('tuma_'), 'API key is not stored in plain text');
    assert.ok(!row.account_cipher.includes('5123456'), 'account number is not stored in plain text');
    assert.ok(!JSON.stringify(res.body).includes('tuma_'), 'API key never reaches the browser');
    h.close();
  });

  await test('STK pushes for that tenant authenticate as the tenant, not the platform', async () => {
    const h = harness(); h.addBusiness('t2');
    await h.call('POST', '/api/business/tuma/settlement', 't2', { destinationType: 'paybill', accountNumber: '400200', mobile: '0712345678', settlementName: 'Juma Otieno' });
    const credentials = h.tenants.credentialsFor('t2');
    assert.equal(credentials.email, 't2@tenant.test');
    calls.length = 0;
    const pushed = await tuma.stkPush({ credentials, phone: '254700000001', amount: 20, publicUrl: 'https://cloud.test', description: '1 hour' });
    assert.match(pushed.checkoutRequestId, /t2@tenant\.test/);
    const push = calls.find(c => c.path === '/payment/stk-push');
    assert.equal(push.auth, 'Bearer jwt:t2@tenant.test');
    assert.match(push.body.callback_url, /\/api\/tuma\/callback\?key=/);
    h.close();
  });

  await test('changing the destination updates the same Tuma business', async () => {
    const h = harness(); h.addBusiness('t3');
    await h.call('POST', '/api/business/tuma/settlement', 't3', { destinationType: 'till', accountNumber: '5123456', mobile: '0712345678', settlementName: 'Juma Otieno' });
    const before = h.db.prepare('SELECT tuma_business_id FROM tenant_tuma_accounts WHERE business_id=?').get('t3').tuma_business_id;
    calls.length = 0;
    const res = await h.call('POST', '/api/business/tuma/settlement', 't3', { destinationType: 'bank', bankId: 'b-equity', accountNumber: '0170299999999', mobile: '0712345678', settlementName: 'Juma Otieno' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.account.destinationName, 'Equity Bank');
    assert.equal(calls.filter(c => c.path === '/businesses').length, 0, 'no second business is created');
    const put = calls.find(c => c.method === 'PUT');
    assert.equal(put.path, `/businesses/${before}`);
    assert.equal(put.body.bank_id, 'b-equity');
    h.close();
  });

  await test('rejects bad details with the field to fix', async () => {
    const h = harness(); h.addBusiness('t4');
    const cases = [
      [{ destinationType: 'cash' }, 'destinationType'],
      [{ destinationType: 'till', accountNumber: '12', mobile: '0712345678' }, 'accountNumber'],
      [{ destinationType: 'bank', bankId: 'nope', accountNumber: '1234567', mobile: '0712345678' }, 'bankId'],
      [{ destinationType: 'bank', bankId: 'b-till', accountNumber: '1234567', mobile: '0712345678' }, 'bankId'],
      [{ destinationType: 'till', accountNumber: '5123456', settlementName: 'Juma Otieno', mobile: '555' }, 'mobile'],
      [{ destinationType: 'till', accountNumber: '5123456', settlementName: 'Juma', mobile: '0712345678' }, 'settlementName'],
      [{ destinationType: 'till', accountNumber: '5123456', mobile: '0712345678' }, 'settlementName'],
    ];
    for (const [body, field] of cases) {
      const res = await h.call('POST', '/api/business/tuma/settlement', 't4', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.field, field);
    }
    assert.equal(h.tenants.credentialsFor('t4'), null);
    h.close();
  });

  await test('a Tuma 401 is reported as 502, never as a dashboard sign-out', async () => {
    const h = harness(); h.addBusiness('t5');
    failCreate = 'auth';
    const res = await h.call('POST', '/api/business/tuma/settlement', 't5', { destinationType: 'till', accountNumber: '5123456', mobile: '0712345678', settlementName: 'Juma Otieno' });
    failCreate = null;
    assert.equal(res.status, 502);
    assert.match(res.body.error, /Tuma did not accept/);
    h.close();
  });

  await test('links an existing Tuma account after verifying its key', async () => {
    const h = harness(); h.addBusiness('t6');
    validKeys.set('owner@own.test', 'tuma_own_account_key_000000000000');
    const bad = await h.call('POST', '/api/business/tuma/link', 't6', { email: 'owner@own.test', apiKey: 'tuma_wrong_key_0000000000000000' });
    assert.equal(bad.status, 400);
    const ok = await h.call('POST', '/api/business/tuma/link', 't6', { email: 'owner@own.test', apiKey: 'tuma_own_account_key_000000000000' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.account.mode, 'linked');
    assert.equal(h.tenants.credentialsFor('t6').apiKey, 'tuma_own_account_key_000000000000');
    const off = await h.call('DELETE', '/api/business/tuma/link', 't6');
    assert.equal(off.status, 200);
    assert.equal(h.tenants.credentialsFor('t6'), null);
    h.close();
  });

  await test('readiness test re-verifies the tenant credentials', async () => {
    const h = harness(); h.addBusiness('t7');
    assert.equal((await h.tenants.test('t7')).ok, false);
    await h.call('POST', '/api/business/tuma/settlement', 't7', { destinationType: 'till', accountNumber: '5123456', mobile: '0712345678', settlementName: 'Juma Otieno' });
    assert.equal((await h.tenants.test('t7')).ok, true);
    validKeys.set('t7@tenant.test', 'revoked');
    const result = await h.tenants.test('t7');
    assert.equal(result.ok, false);
    assert.match(h.tenants.view('t7').account.lastError, /Invalid credentials/);
    h.close();
  });

  await test('destinations endpoint groups Till, PayBill and sorted banks', async () => {
    const h = harness(); h.addBusiness('t8');
    const res = await h.call('GET', '/api/business/tuma/destinations', 't8');
    assert.equal(res.status, 200);
    assert.equal(res.body.till.id, 'b-till');
    assert.equal(res.body.paybill.id, 'b-paybill');
    assert.deepEqual(res.body.banks.map(b => b.name), ['Equity Bank', 'KCB Bank']);
    h.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();

/*
 * PPPoE customer payments through the real Express app: the pay page API,
 * M-Pesa prompts settled by a verified callback, plan changes and boosts
 * from a private link, paying for someone else, PayBill with the username
 * as account number (and its reversal), refusal while the owner's plan has
 * lapsed, and the owner's cash payments. Only Safaricom is mocked.
 *
 * Run with: node --require ./test/in-process-http.js test/pppoe-pay-integration.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-pppoe-pay-'));
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://wifi-fiti.example.test', APP_URL: 'https://wifi-fiti.example.test',
  MPESA_ENV: 'production', ALLOW_UNVERIFIED_SIGNUPS: 'true',
  MPESA_CONSUMER_KEY: 'platform-test-key', MPESA_CONSUMER_SECRET: 'platform-test-secret',
  MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'platform-test-passkey', PLATFORM_COLLECTION: 'daraja',
  PROVISION_MODE: 'poll', TENANT_SECRETS_KEY: 'pppoe-pay-integration-key-do-not-deploy',
  DATABASE_PATH: path.join(temporaryDirectory, 'pppoe.db'),
});

const realFetch = global.fetch;
const payments = new Map();
let nextCheckout = 0;
global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  assert.equal(target.hostname, 'api.safaricom.co.ke', `unexpected external request to ${target.hostname}`);
  const body = options.body ? JSON.parse(options.body) : null;
  if (target.pathname === '/oauth/v1/generate') return Response.json({ access_token: 'token', expires_in: 3599 });
  if (target.pathname === '/mpesa/stkpush/v1/processrequest') {
    const id = `ws_CO_PPPOE_${++nextCheckout}`;
    payments.set(id, { id, merchantId: `merchant-${nextCheckout}`, request: body, result: null });
    return Response.json({ ResponseCode: '0', CheckoutRequestID: id, MerchantRequestID: `merchant-${nextCheckout}` });
  }
  if (target.pathname === '/mpesa/stkpushquery/v1/query') {
    const payment = payments.get(body.CheckoutRequestID);
    if (!payment || payment.result === null) return Response.json({ errorCode: '500.001.1001', errorMessage: 'Transaction is being processed' });
    return Response.json({ ResultCode: payment.result, ResultDesc: payment.result === 0 ? 'Success' : 'Cancelled' });
  }
  throw new Error(`Unexpected Daraja endpoint: ${target.pathname}`);
};

let server; let origin; let database;
const failures = []; let passed = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (check()) return; await pause(10); }
  assert.fail(message);
}
async function test(name, run) {
  try { await run(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error.stack}`); }
}
async function api(endpoint, { method = 'GET', body, token, portalToken } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (portalToken) headers['X-WiFi-Fiti-Portal'] = portalToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await realFetch(origin + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed, text };
}
async function callback(checkoutId, receipt) {
  const payment = payments.get(checkoutId);
  payment.result = 0;
  const response = await api('/api/mpesa/callback', { method: 'POST', body: { Body: { stkCallback: {
    MerchantRequestID: payment.merchantId, CheckoutRequestID: checkoutId, ResultCode: 0, ResultDesc: 'Success',
    CallbackMetadata: { Item: [
      { Name: 'Amount', Value: payment.request.Amount },
      { Name: 'PhoneNumber', Value: Number(payment.request.PhoneNumber) },
      { Name: 'MpesaReceiptNumber', Value: receipt },
    ] } } } } });
  assert.equal(response.status, 200);
  await pause(40);
}
async function boot() {
  const originalListen = http.Server.prototype.listen;
  let resolveListening;
  const listening = new Promise((resolve) => { resolveListening = resolve; });
  http.Server.prototype.listen = function (...args) { server = this; this.once('listening', resolveListening); return originalListen.apply(this, args); };
  try { require('../src/server'); } finally { http.Server.prototype.listen = originalListen; }
  await listening;
  origin = `http://127.0.0.1:${server.address().port}`;
  database = require('../src/lib/db').db;
}
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const DAY = 86400_000;

async function main() {
  await boot();
  const registered = await api('/api/business/register', { method: 'POST', body: {
    name: 'Kitale Net', ownerName: 'Owner', phone: '0713000001', email: 'kitale@example.test', password: 'integration-password', plan: 'starter', collectionMode: 'fiti' } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const token = registered.body.token; const businessId = registered.body.business.id;
  const located = await api('/api/business/locations', { method: 'POST', token, body: { name: 'Main', routerName: 'hAP' } });
  assert.equal(located.status, 201, JSON.stringify(located.body));
  const locationId = located.body.location.id;
  // A paying owner: out of the trial, with PPPoE capacity.
  const payingOwner = () => database.prepare(`UPDATE businesses SET billing_status='active', pppoe_billing_expires_at=?, pppoe_users=50, portal_name='Kitale WiFi' WHERE id=?`).run(sql(Date.now() + 30 * DAY), businessId);
  payingOwner();

  let home; let fast; let jane; let link; let code; let k;
  await test('the owner prices plans and adds a subscriber who waits for the first payment', async () => {
    home = (await api('/api/business/pppoe/profiles', { method: 'POST', token, body: { name: 'Home', downloadRate: '10M', uploadRate: '5M' } })).body.profile;
    fast = (await api('/api/business/pppoe/profiles', { method: 'POST', token, body: { name: 'Fast', downloadRate: '20M', uploadRate: '10M' } })).body.profile;
    assert.equal((await api(`/api/business/pppoe/profiles/${home.id}`, { method: 'PATCH', token, body: { price: 1500 } })).body.profile.price, 1500);
    assert.equal((await api(`/api/business/pppoe/profiles/${fast.id}`, { method: 'PATCH', token, body: { price: 2500, boostPrice: 100 } })).status, 200);
    assert.equal((await api(`/api/business/pppoe/profiles/${home.id}`, { method: 'PATCH', token, body: { price: -1 } })).status, 400);
    const bad = await api('/api/business/pppoe/users', { method: 'POST', token, body: { locationId, profileId: home.id, username: 'nobody', secret: 'a-secure-secret', phone: '123' } });
    assert.equal(bad.status, 400, 'a bad phone is refused before the subscriber exists');
    assert.equal(database.prepare(`SELECT COUNT(*) n FROM pppoe_users WHERE username='nobody'`).get().n, 0);
    const created = await api('/api/business/pppoe/users', { method: 'POST', token, body: {
      locationId, profileId: home.id, username: 'jane.w', secret: 'a-secure-secret', phone: '0712345678', fullName: 'Jane Wanjiku' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    jane = created.body.user;
    assert.equal(jane.status, 'awaiting_payment'); assert.equal(jane.secret_ciphertext, undefined, 'the stored secret never leaves the server');
    const billing = await api('/api/business/pppoe/billing', { token });
    assert.equal(billing.status, 200);
    link = billing.body.subscribers[jane.id].payLink;
    assert.match(link, /^https:\/\/wifi-fiti\.example\.test\/pay\/[a-z0-9]+\/jane\.w\?k=/);
    code = link.split('/pay/')[1].split('/')[0]; k = new URL(link).searchParams.get('k');
    assert.equal(billing.body.subscribers[jane.id].billing.amountDue, 1500);
  });

  await test('the pay page shows a masked account to anyone and the full one to its own link', async () => {
    const page = await api(`/pay/${code}/jane.w`);
    assert.equal(page.status, 200); assert.match(page.text, /<html/);
    assert.equal((await api('/pay/nope1234/jane.w')).status, 404);
    const info = await api(`/api/pppoe-pay/${code}`);
    assert.equal(info.body.business.name, 'Kitale WiFi'); assert.equal(info.body.paused, null);
    const pub = await api(`/api/pppoe-pay/${code}/account/jane.w`);
    assert.equal(pub.body.private, false); assert.equal(pub.body.account.maskedName, 'J*** W******');
    assert.equal(pub.body.account.name, undefined); assert.equal(pub.body.account.receipts, undefined);
    assert.equal((await api(`/api/pppoe-pay/${code}/account/JANE.W`)).body.account.username, 'jane.w');
    assert.equal((await api(`/api/pppoe-pay/${code}/account/jane.x`)).status, 404);
    const mine = await api(`/api/pppoe-pay/${code}/account/jane.w?k=${k}`);
    assert.equal(mine.body.private, true); assert.equal(mine.body.account.name, 'Jane Wanjiku');
    assert.equal((await api(`/api/pppoe-pay/${code}/account/jane.w?k=${k.slice(1)}x`)).body.private, false, 'a wrong key is only the public view');
  });

  await test('an M-Pesa prompt from the pay page adds 30 days once its callback is verified', async () => {
    const started = await api(`/api/pppoe-pay/${code}/account/jane.w/pay`, { method: 'POST', body: { phone: '0712345678', k } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.amount, 1500);
    const id = started.body.checkoutRequestId;
    assert.equal(payments.get(id).request.Amount, 1500);
    assert.equal(payments.get(id).request.AccountReference, 'jane.w', 'the M-Pesa account reference is the username');
    const statusPath = `/api/pppoe-pay/${code}/status/${id}`;
    assert.equal((await api(statusPath)).status, 404, 'status needs the token from this payment');
    assert.equal((await api(statusPath, { portalToken: started.body.statusToken })).body.status, 'pending');
    await callback(id, 'PPPOE0000A1');
    const tx = database.prepare('SELECT * FROM tenant_transactions WHERE checkout_request_id=?').get(id);
    assert.equal(tx.status, 'paid'); assert.equal(tx.provisioned, 1);
    const user = database.prepare('SELECT * FROM pppoe_users WHERE id=?').get(jane.id);
    assert.equal(user.status, 'active');
    assert.ok(Math.abs(Date.parse(user.paid_until) - (Date.now() + 30 * DAY)) < 60_000);
    const status = await api(statusPath, { portalToken: started.body.statusToken });
    assert.equal(status.body.status, 'paid'); assert.match(status.body.receipt.what, /30 days/);
    assert.equal(database.prepare(`SELECT COUNT(*) n FROM pppoe_jobs WHERE user_id=? AND action='upsert'`).get(jane.id).n, 1, 'the login goes to the router');
    await callback(id, 'PPPOE0000A1');
    assert.equal(database.prepare('SELECT COUNT(*) n FROM pppoe_payments WHERE user_id=?').get(jane.id).n, 1, 'a replayed callback adds nothing');
    const dashboard = await api('/api/business/dashboard', { token });
    assert.equal(dashboard.body.gross, 1500, 'PPPoE payments count as sales');
    assert.equal(dashboard.body.platformFee, 75, 'Wi-Fi Fiti collection keeps 5%, as for the hotspot');
  });

  await test('the own link upgrades now for the difference, schedules at renewal, and boosts', async () => {
    const quote = await api(`/api/pppoe-pay/${code}/account/jane.w/quote`, { method: 'POST', body: { k, profileId: fast.id, timing: 'now' } });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.quote.payNow, 1000, '30 days left at (2500-1500)/30 a day');
    assert.equal((await api(`/api/pppoe-pay/${code}/account/jane.w/quote`, { method: 'POST', body: { profileId: fast.id } })).status, 403, 'plan changes need the own link');
    const up = await api(`/api/pppoe-pay/${code}/account/jane.w/pay`, { method: 'POST', body: { k, phone: '0712000002', purpose: 'upgrade', profileId: fast.id, timing: 'now' } });
    assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.amount, 1000);
    await callback(up.body.checkoutRequestId, 'PPPOE0000A2');
    const user = database.prepare('SELECT * FROM pppoe_users WHERE id=?').get(jane.id);
    assert.equal(user.profile_id, fast.id);
    assert.equal(database.prepare(`SELECT reconnect FROM pppoe_jobs WHERE user_id=? AND action='upsert'`).get(jane.id).reconnect, 1);
    const sched = await api(`/api/pppoe-pay/${code}/account/jane.w/pay`, { method: 'POST', body: { k, phone: '0712345678', purpose: 'upgrade', profileId: home.id, timing: 'renewal' } });
    assert.equal(sched.body.scheduled, true); assert.equal(sched.body.account.nextPlan.id, home.id);
    // Fast is the top plan: it has no faster boost. Boost Home users onto Fast.
    database.prepare('UPDATE pppoe_users SET profile_id=?, next_profile_id=NULL WHERE id=?').run(home.id, jane.id);
    const boost = await api(`/api/pppoe-pay/${code}/account/jane.w/pay`, { method: 'POST', body: { k, phone: '0712000003', purpose: 'boost', profileId: fast.id } });
    assert.equal(boost.status, 200, JSON.stringify(boost.body)); assert.equal(boost.body.amount, 100);
    await callback(boost.body.checkoutRequestId, 'PPPOE0000A3');
    const boosted = database.prepare('SELECT * FROM pppoe_users WHERE id=?').get(jane.id);
    assert.equal(boosted.boost_profile_id, fast.id);
    assert.ok(Date.parse(boosted.boost_until) > Date.now() + 23 * 3600_000);
  });

  await test('anyone can pay an account by its number, unless the owner requires the phone', async () => {
    const other = await api(`/api/pppoe-pay/${code}/account/jane.w/pay`, { method: 'POST', body: { phone: '0722000111', amount: 700, notify: true } });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal((await api(`/api/pppoe-pay/${code}/account/jane.w/pay`, { method: 'POST', body: { phone: '0722000112', purpose: 'boost', profileId: fast.id } })).status, 403, 'a stranger cannot change the speed');
    assert.equal((await api(`/api/business/pppoe/billing/settings`, { method: 'PUT', token, body: { payForOthers: false } })).body.settings.payForOthers, false);
    const locked = await api(`/api/pppoe-pay/${code}/account/jane.w`);
    assert.equal(locked.body.needsPhone, true); assert.equal(locked.body.account.maskedName, undefined);
    assert.equal((await api(`/api/pppoe-pay/${code}/account/jane.w/pay`, { method: 'POST', body: { phone: '0722000113', amount: 700 } })).status, 403);
    assert.equal((await api(`/api/pppoe-pay/${code}/account/jane.w/verify`, { method: 'POST', body: { phone: '0799999999' } })).status, 403);
    const verified = await api(`/api/pppoe-pay/${code}/account/jane.w/verify`, { method: 'POST', body: { phone: '0712 345 678' } });
    assert.equal(verified.body.private, true); assert.equal(verified.body.token, k);
    await api(`/api/business/pppoe/billing/settings`, { method: 'PUT', token, body: { payForOthers: true } });
  });

  await test('PayBill with the username as account number pays the subscriber; a reversal takes it back', async () => {
    database.prepare(`INSERT INTO business_c2b_settings (business_id, location_id, shortcode, account_prefix, active, callback_token) VALUES (?,?,?,?,1,?)`)
      .run(businessId, locationId, '600111', '', 'abababababababababababababababababababababababab');
    const before = database.prepare('SELECT * FROM pppoe_users WHERE id=?').get(jane.id);
    const validation = await api('/api/c2b/t/abababababababababababababababababababababababab/validate', { method: 'POST', body: { BusinessShortCode: '600111', BillRefNumber: 'JANE.W', TransAmount: '1500' } });
    assert.equal(validation.body.ResultCode, 0);
    const confirmed = await api('/api/c2b/t/abababababababababababababababababababababababab/confirm', { method: 'POST', body: {
      TransID: 'PBJANE0001', BusinessShortCode: '600111', BillRefNumber: 'JANE.W', TransAmount: '1500', MSISDN: '254712345678' } });
    assert.equal(confirmed.status, 200);
    await eventually(() => database.prepare(`SELECT 1 FROM pppoe_payments WHERE receipt='PBJANE0001'`).get(), 'PayBill payment was not applied');
    const after = database.prepare('SELECT * FROM pppoe_users WHERE id=?').get(jane.id);
    assert.equal(Date.parse(after.paid_until) - Date.parse(before.paid_until), 30 * DAY);
    const reversal = await api('/api/c2b/t/abababababababababababababababababababababababab/reversal', { method: 'POST', body: { OriginalTransactionID: 'PBJANE0001' } });
    assert.equal(reversal.status, 200);
    await eventually(() => database.prepare('SELECT paid_until FROM pppoe_users WHERE id=?').get(jane.id).paid_until === before.paid_until, 'reversal was not applied');
    assert.equal(database.prepare(`SELECT status FROM tenant_transactions WHERE mpesa_receipt='PBJANE0001'`).get().status, 'reversed');
  });

  await test('while the owner\'s own plan has lapsed, customer payments are refused', async () => {
    database.prepare(`UPDATE businesses SET pppoe_billing_expires_at=? WHERE id=?`).run(sql(Date.now() - 30 * DAY), businessId);
    const info = await api(`/api/pppoe-pay/${code}`);
    assert.match(info.body.paused, /can't take payments right now/);
    const refused = await api(`/api/pppoe-pay/${code}/account/jane.w/pay`, { method: 'POST', body: { phone: '0712345678', k } });
    assert.equal(refused.status, 402); assert.equal(refused.body.code, 'provider_paused');
    const validation = await api('/api/c2b/t/abababababababababababababababababababababababab/validate', { method: 'POST', body: { BusinessShortCode: '600111', BillRefNumber: 'jane.w', TransAmount: '1500' } });
    assert.equal(validation.body.ResultCode, 'C2B00016', 'PayBill turns the money back where validation is on');
    const unrelated = await api('/api/c2b/t/abababababababababababababababababababababababab/validate', { method: 'POST', body: { BusinessShortCode: '600111', BillRefNumber: '0712000000', TransAmount: '10' } });
    assert.equal(unrelated.body.ResultCode, 0, 'hotspot PayBill payments are not affected');
    const credit = database.prepare('SELECT credit FROM pppoe_users WHERE id=?').get(jane.id).credit;
    await api('/api/c2b/t/abababababababababababababababababababababababab/confirm', { method: 'POST', body: {
      TransID: 'PBJANE0002', BusinessShortCode: '600111', BillRefNumber: 'jane.w', TransAmount: '1500', MSISDN: '254712345678' } });
    await eventually(() => database.prepare(`SELECT 1 FROM pppoe_payments WHERE receipt='PBJANE0002'`).get(), 'held payment was not recorded');
    const held = database.prepare(`SELECT * FROM pppoe_payments WHERE receipt='PBJANE0002'`).get();
    assert.equal(held.held, 1); assert.equal(held.days_added, 0);
    assert.equal(database.prepare('SELECT credit FROM pppoe_users WHERE id=?').get(jane.id).credit, credit + 1500, 'money that still arrives is kept as credit');
    payingOwner();
  });

  await test('the owner records cash, extends days, and a typed receipt is never counted twice', async () => {
    const cash = await api(`/api/business/pppoe/users/${jane.id}/payments`, { method: 'POST', token, body: { amount: 500, method: 'cash', note: 'At the shop' } });
    assert.equal(cash.status, 201, JSON.stringify(cash.body));
    const dup = await api(`/api/business/pppoe/users/${jane.id}/payments`, { method: 'POST', token, body: { amount: 1500, method: 'mpesa_owner', receipt: 'PPPOE0000A1' } });
    assert.equal(dup.status, 409, 'a receipt that came in automatically is refused');
    const before = Date.parse(database.prepare('SELECT paid_until FROM pppoe_users WHERE id=?').get(jane.id).paid_until);
    const extended = await api(`/api/business/pppoe/users/${jane.id}/extend`, { method: 'POST', token, body: { days: 2, note: 'Outage' } });
    assert.equal(extended.status, 201);
    assert.equal(Date.parse(database.prepare('SELECT paid_until FROM pppoe_users WHERE id=?').get(jane.id).paid_until) - before, 2 * DAY);
    const list = await api(`/api/business/pppoe/payments?userId=${jane.id}`, { token });
    assert.ok(list.body.payments.length >= 6);
    const intruder = await api('/api/business/register', { method: 'POST', body: {
      name: 'Other', ownerName: 'O', phone: '0713000002', email: 'other@example.test', password: 'integration-password', plan: 'starter', collectionMode: 'fiti' } });
    assert.equal((await api(`/api/business/pppoe/users/${jane.id}/payments`, { method: 'POST', token: intruder.body.token, body: { amount: 500 } })).status, 404, 'another business cannot touch this subscriber');
  });

  console.log(`\nPPPoE pay integration: ${passed} passed, ${failures.length} failed`);
  return failures.length ? 1 : 0;
}

main().then(finish, (error) => { console.error(error.stack); finish(1); });
async function finish(exitCode) {
  global.fetch = realFetch;
  if (server && server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (database) database.close();
  try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch (_) {}
  process.exit(exitCode);
}

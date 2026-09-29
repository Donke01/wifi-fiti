'use strict';

/*
 * Dashboard real data: the support hub search and numbers, the router card's
 * health data and the Account & limits router limit. Every answer must
 * belong to the signed-in business only.
 *   node --require ./test/in-process-http.js test/dashboard-data.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-dashboard-data-'));
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://cloud.wififiti.co.ke', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke', MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  PROVISION_MODE: 'poll', SITE_TOKEN: 'dashboard-site-token', TENANT_SECRETS_KEY: 'dashboard-key',
  ADMIN_TOKEN: 'dashboard-admin', DATABASE_PATH: path.join(dir, 'hotspot.db'),
});

let server;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function captureServer(...args) { server = this; return originalListen.apply(this, args); };
require('../src/server');
http.Server.prototype.listen = originalListen;

async function api(endpoint, { method = 'GET', body, token } = {}) {
  await new Promise((resolve) => setImmediate(resolve));
  const headers = { Host: 'cloud.wififiti.co.ke' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed };
}
async function createBusiness(email, name, phone) {
  const registered = await api('/api/business/register', { method: 'POST',
    body: { name, ownerName: 'Owner', phone, email, password: 'test-password', plan: 'starter', collectionMode: 'fiti' } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const token = registered.body.token;
  const created = await api('/api/business/locations', { method: 'POST', token, body: { name: name + ' shop', routerName: 'router' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const me = await api('/api/business/me', { token });
  return { token, id: me.body.business.id, location: created.body.location.id, me: me.body };
}
const search = (token, q) => api('/api/business/support/search?q=' + encodeURIComponent(q), { token });

(async () => {
  const db = require('../src/lib/db').db;
  const alpha = await createBusiness('dash-alpha@example.test', 'Alpha', '0712000201');
  const bravo = await createBusiness('dash-bravo@example.test', 'Bravo', '0712000202');

  // The same customer phone buys at both businesses.
  const subscription = db.prepare(`INSERT INTO tenant_subscriptions(id,business_id,location_id,router_username,payer_phone,mac,password,total_seconds,expires_at,is_active)
    VALUES(?,?,?,?,?,?,'secret',3600,datetime('now',?),1)`);
  subscription.run('sub-alpha', alpha.id, alpha.location, 'u-alpha', '254722333444', 'AA:BB:CC:00:00:01', '+30 minutes');
  subscription.run('sub-bravo', bravo.id, bravo.location, 'u-bravo', '254722333444', 'AA:BB:CC:00:00:02', '+30 minutes');
  subscription.run('sub-ended', alpha.id, alpha.location, 'u-ended', '254733000111', 'AA:BB:CC:00:00:03', '-1 minutes');
  const job = db.prepare(`INSERT INTO tenant_jobs(location_id,username,password,total_seconds,created_at,acked_at) VALUES(?,?,'secret',3600,datetime('now','-10 minutes'),?)`);
  const switchedOn = Number(job.run(alpha.location, 'u-alpha', db.prepare(`SELECT datetime('now','-10 minutes','+20 seconds') AS t`).get().t).lastInsertRowid);
  const waiting = Number(job.run(alpha.location, 'u-ended', null).lastInsertRowid);
  const payment = db.prepare(`INSERT INTO tenant_transactions(checkout_request_id,business_id,location_id,phone,package_id,package_name,amount,seconds,mac,status,mpesa_receipt,subscription_id,provisioning_job_id)
    VALUES(?,?,?,?,1,?,?,3600,?,?,?,?,?)`);
  payment.run('ws_CO_alpha_1', alpha.id, alpha.location, '254722333444', '1 hour', 20, 'AA:BB:CC:00:00:01', 'paid', 'SGR7ALPHA1', 'sub-alpha', switchedOn);
  payment.run('ws_CO_alpha_2', alpha.id, alpha.location, '254733000111', '1 hour', 20, 'AA:BB:CC:00:00:03', 'paid', 'SGR7ALPHA2', 'sub-ended', waiting);
  payment.run('ws_CO_bravo_1', bravo.id, bravo.location, '254722333444', 'Bravo day', 50, 'AA:BB:CC:00:00:02', 'paid', 'SGR7BRAVO1', 'sub-bravo', null);
  const voucher = db.prepare(`INSERT INTO tenant_vouchers(code,business_id,location_id,package_name,seconds) VALUES(?,?,?,?,3600)`);
  voucher.run('FITIAAAA000001', alpha.id, alpha.location, 'Alpha voucher');
  voucher.run('FITIBBBB000001', bravo.id, bravo.location, 'Bravo voucher');

  // Authentication and input checks.
  assert.equal((await search(null, '0722333444')).status, 401, 'the search needs a signed-in business');
  assert.equal((await api('/api/business/support/summary')).status, 401, 'the numbers need a signed-in business');
  for (const bad of ['', 'ab', 'x'.repeat(41), "1' OR '1'='1", '<script>', '%%%']) {
    const refused = await search(alpha.token, bad);
    assert.equal(refused.status, 400, 'refused: ' + JSON.stringify(bad));
    assert.match(refused.body.error, /phone number, voucher code or M-Pesa code/);
  }
  console.log('  ok   support search needs sign-in and a valid query');

  // One phone in every common spelling finds the same customer, and only
  // this business's records.
  for (const spelling of ['0722333444', '+254 722 333 444', '254722333444', '722333444', '3444']) {
    const found = await search(alpha.token, spelling);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual(found.body.customers.map((row) => row.id), ['sub-alpha'], spelling + ' finds the customer');
    assert.deepEqual(found.body.payments.map((row) => row.checkout_request_id), ['ws_CO_alpha_1'], spelling + ' finds the payment');
    const text = JSON.stringify(found.body);
    assert.doesNotMatch(text, /bravo|BRAVO|sub-bravo|Bravo/, 'nothing from another business: ' + spelling);
    assert.doesNotMatch(text, /secret/, 'router passwords never leave the server');
  }
  const customer = (await search(alpha.token, '0722333444')).body;
  assert.ok(customer.customers[0].seconds_left > 1500 && customer.customers[0].seconds_left <= 1800, 'time left is shown');
  assert.equal(customer.customers[0].package_name, '1 hour');
  assert.equal(customer.customers[0].location_name, 'Alpha shop');
  assert.equal(customer.payments[0].status, 'paid');
  assert.ok(customer.payments[0].switched_on_at, 'a confirmed login shows when it was switched on');
  const bravoView = (await search(bravo.token, '0722333444')).body;
  assert.deepEqual(bravoView.payments.map((row) => row.checkout_request_id), ['ws_CO_bravo_1'], 'business B sees only its own payment for the same phone');
  assert.equal(bravoView.payments[0].switched_on_at, null);
  console.log('  ok   phone search finds one customer in any spelling, per business');

  // Receipt, transaction ID and voucher code (any case, with or without FITI).
  assert.deepEqual((await search(alpha.token, 'sgr7alpha2')).body.payments.map((row) => row.checkout_request_id), ['ws_CO_alpha_2']);
  assert.deepEqual((await search(alpha.token, 'ws_CO_alpha_2')).body.payments.map((row) => row.mpesa_receipt), ['SGR7ALPHA2']);
  const code = (await search(alpha.token, 'fitiaaaa000001')).body;
  assert.deepEqual(code.vouchers.map((row) => [row.code, row.status, row.location_name]), [['FITIAAAA000001', 'open', 'Alpha shop']]);
  assert.deepEqual((await search(alpha.token, 'AAAA000001')).body.vouchers.map((row) => row.code), ['FITIAAAA000001'], 'the FITI prefix is optional');
  for (const other of ['SGR7BRAVO1', 'ws_CO_bravo_1', 'FITIBBBB000001']) {
    const blocked = (await search(alpha.token, other)).body;
    assert.equal(blocked.customers.length + blocked.payments.length + blocked.vouchers.length, 0, 'business A cannot find ' + other);
  }
  assert.deepEqual((await search(bravo.token, 'SGR7BRAVO1')).body.payments.map((row) => row.package_name), ['Bravo day']);
  console.log('  ok   receipt and voucher codes are found only by their own business');

  // Results are capped.
  for (let index = 0; index < 25; index += 1) {
    payment.run(`ws_CO_many_${index}`, alpha.id, alpha.location, '254799000000', 'Many', 5, 'AA:BB:CC:00:10:' + String(index).padStart(2, '0'), 'failed', null, null, null);
  }
  const many = (await search(alpha.token, '0799000000')).body;
  assert.equal(many.payments.length, 20); assert.equal(many.more, true); assert.equal(many.limit, 20);
  console.log('  ok   results are capped at 20 of each kind');

  // Support numbers: the last 7 days of paid customers.
  const summary = await api('/api/business/support/summary', { token: alpha.token });
  assert.equal(summary.status, 200);
  assert.deepEqual({ paid: summary.body.paid, switchedOn: summary.body.switchedOn, notSwitchedOn: summary.body.notSwitchedOn },
    { paid: 2, switchedOn: 1, notSwitchedOn: 1 });
  assert.equal(summary.body.averageSwitchOnSeconds, 20, 'paid to switched on');
  assert.equal(summary.body.endedToday, 1, 'a package that ran out a minute ago ended today');
  const bravoSummary = (await api('/api/business/support/summary', { token: bravo.token })).body;
  assert.deepEqual([bravoSummary.paid, bravoSummary.switchedOn, bravoSummary.averageSwitchOnSeconds, bravoSummary.endedToday], [1, 0, null, 0]);
  console.log('  ok   support numbers come from each business\'s own payments');

  // Router card: the last Router health check fills in when the kit sends no telemetry.
  const empty = await api(`/api/business/router-telemetry?locationId=${alpha.location}`, { token: alpha.token });
  assert.equal(empty.status, 200); assert.equal(empty.body.latest, null); assert.equal(empty.body.health, null, 'no data, no numbers');
  db.prepare(`INSERT INTO tenant_router_tools(location_id,tool,status,result) VALUES(?,'health','done',?)`)
    .run(alpha.location, 'uptime=3d4h\ncpu=12\nfree=20.5MiB\ntotal=64.0MiB\nversion=7.24.2\nhotspot_users=4\n');
  db.prepare(`INSERT INTO tenant_router_tools(location_id,tool,status,result) VALUES(?,'health','failed','error=no_answer')`).run(alpha.location);
  const health = (await api(`/api/business/router-telemetry?locationId=${alpha.location}`, { token: alpha.token })).body.health;
  assert.deepEqual({ ...health, at: undefined }, { cpu: 12, freeMemory: 21495808, totalMemory: 67108864, uptime: '3d4h', hotspotUsers: 4, at: undefined }, 'the last finished check, not the failed one');
  assert.equal((await api(`/api/business/router-telemetry?locationId=${alpha.location}`, { token: bravo.token })).status, 404, 'another business cannot read this router');
  console.log('  ok   router card uses the last Router health check');

  // Account & limits: one router on the trial, no limit once hotspot is paid.
  assert.equal(alpha.me.routerLimit, 1, 'the free trial has one router');
  db.prepare(`UPDATE businesses SET hotspot_billing_expires_at=datetime('now','+30 days'), hotspot_concurrent=100 WHERE id=?`).run(alpha.id);
  assert.equal((await api('/api/business/me', { token: alpha.token })).body.routerLimit, null, 'paid hotspot: no router limit');
  assert.equal((await api('/api/business/me', { token: bravo.token })).body.routerLimit, 1);
  console.log('  ok   router limit follows the trial and paid plans');

  console.log('Dashboard data: support search, numbers, router health and limits passed.');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

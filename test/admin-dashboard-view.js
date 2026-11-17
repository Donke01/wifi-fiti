'use strict';

/*
 * Platform-admin dashboard view and the PPPoE PayBill hint.
 *   node --require ./test/in-process-http.js test/admin-dashboard-view.js
 *
 * - Only the platform admin (with ADMIN_PASSWORD) can open a tenant dashboard.
 * - The session reads everything, writes nothing, and is audited.
 * - It works for a business with no router and an ended trial.
 * - PPPoE reminders mention PayBill only when the tenant's own PayBill is
 *   connected for C2B, because only then is such a payment ever recorded.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-admin-view-'));
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://cloud.wififiti.co.ke', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke', MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  PROVISION_MODE: 'poll', SITE_TOKEN: 'admin-view-site', TENANT_SECRETS_KEY: 'admin-view-key',
  ADMIN_TOKEN: 'admin-view-token', ADMIN_PASSWORD: 'admin-view-password', DATABASE_PATH: path.join(dir, 'hotspot.db'),
});

let server;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function captureServer(...args) { server = this; return originalListen.apply(this, args); };
require('../src/server');
http.Server.prototype.listen = originalListen;

async function api(endpoint, { method = 'GET', body, token, admin } = {}) {
  await new Promise((resolve) => setImmediate(resolve));
  const headers = { Host: 'cloud.wififiti.co.ke' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-password'] = admin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: response.status, body: parsed };
}

let html_;
(async () => {
  const { db } = require('../src/lib/db');
  const pppoeBilling = require('../src/lib/pppoe-billing');

  // A business with no router whose trial has already ended.
  const registered = await api('/api/business/register', { method: 'POST',
    body: { name: 'No Router Ltd', ownerName: 'Owner', phone: '0712000401', email: 'admin-view@example.test', password: 'test-password', plan: 'starter', collectionMode: 'fiti' } });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const ownerToken = registered.body.token;
  const id = (await api('/api/business/me', { token: ownerToken })).body.business.id;
  db.prepare(`UPDATE businesses SET billing_status='trial', billing_expires_at=datetime('now','-1 day') WHERE id=?`).run(id);
  const open = (opts) => api(`/api/admin/control-plane/tenants/${id}/dashboard-session`, { method: 'POST', body: {}, ...opts });

  // Only the platform admin may open it.
  assert.equal((await open({})).status, 403, 'no admin credentials: refused');
  assert.equal((await open({ admin: 'wrong' })).status, 403, 'wrong admin password: refused');
  assert.equal((await open({ token: ownerToken })).status, 403, 'a business session is not an admin');
  assert.equal((await api('/api/admin/control-plane/tenants/biz-0000000000000000/dashboard-session', { method: 'POST', body: {}, admin: 'admin-view-password' })).status, 404);

  const opened = await open({ admin: 'admin-view-password' });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.readOnly, true);
  const adminToken = opened.body.token;
  assert.match(adminToken, /^[A-Za-z0-9_-]{40,}$/);
  const stored = db.prepare('SELECT token_hash, admin_view, member_id, expires_at FROM business_sessions WHERE admin_view=1').all();
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, adminToken, 'only the hash is stored');
  assert.equal(stored[0].member_id, null);
  const hours = (Date.parse(stored[0].expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 3600_000;
  assert.ok(hours > 1.9 && hours <= 2, 'the admin view lasts two hours');
  const audit = db.prepare(`SELECT action, business_id FROM platform_admin_audit WHERE action='tenant_dashboard_viewed'`).all().map((row) => ({ ...row }));
  assert.deepEqual(audit, [{ action: 'tenant_dashboard_viewed', business_id: id }], 'opening a dashboard is audited');

  // It reads the whole dashboard even with no router and an ended trial.
  const me = await api('/api/business/me', { token: adminToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.adminView, true);
  assert.equal(me.body.locations.length, 0, 'no router is needed');
  assert.equal((await api('/api/business/me', { token: ownerToken })).body.adminView, false, 'the owner is not an admin view');
  assert.equal((await api('/api/business/dashboard?period=7d', { token: adminToken })).status, 200);

  // ...and writes nothing.
  for (const [method, endpoint, body] of [
    ['POST', '/api/business/locations', { name: 'x', routerName: 'x' }],
    ['PATCH', '/api/business/branding', { portalName: 'Hacked' }],
    ['DELETE', '/api/business/packages/1', undefined],
    ['POST', '/api/business/organisation', { organisationName: 'x' }],
  ]) {
    const refused = await api(endpoint, { method, body, token: adminToken });
    assert.equal(refused.status, 403, `${method} ${endpoint} is refused in admin view`);
    assert.equal(refused.body.code, 'admin_view_read_only');
  }
  assert.equal((await api('/api/business/locations', { method: 'POST', token: ownerToken, body: { name: 'Owner shop', routerName: 'r' } })).status, 201, 'the owner can still write');

  // Ending the admin view removes that session only.
  assert.equal((await api('/api/business/logout', { method: 'POST', body: {}, token: adminToken })).status, 200);
  assert.equal((await api('/api/business/me', { token: adminToken })).status, 401);
  assert.equal((await api('/api/business/me', { token: ownerToken })).status, 200, 'the owner stays signed in');

  // PPPoE PayBill hint: only with the tenant's own C2B PayBill.
  assert.equal(pppoeBilling.payBillFor(id), null, 'Tuma / no C2B: no PayBill');
  assert.equal((await api('/api/business/me', { token: ownerToken })).body.pppoePayBill, null);
  const location = db.prepare('SELECT id FROM locations WHERE business_id=?').get(id).id;
  db.prepare(`INSERT INTO business_c2b_settings(business_id,location_id,shortcode,account_prefix,callback_token) VALUES(?,?,?,?,?)`).run(id, location, '600123', 'NET', 'tok-admin-view-test');
  assert.deepEqual(pppoeBilling.payBillFor(id), { shortcode: '600123', accountPrefix: 'NET' });
  assert.deepEqual((await api('/api/business/me', { token: ownerToken })).body.pppoePayBill, { shortcode: '600123', accountPrefix: 'NET' });
  db.prepare(`UPDATE business_c2b_settings SET active=0 WHERE business_id=?`).run(id);
  assert.equal(pppoeBilling.payBillFor(id), null, 'an inactive C2B setting offers no PayBill');

  // Live Home: day-by-day totals cover this period and the one before it,
  // count paid money only, and keep failed attempts for the success rate.
  const loc2 = db.prepare('SELECT id FROM locations WHERE business_id=?').get(id).id;
  const addSale = db.prepare(`INSERT INTO tenant_transactions(checkout_request_id,business_id,location_id,phone,package_id,package_name,amount,seconds,mac,status,created_at)
    VALUES(?,?,?,'254700000001',1,'1 Hour',?,3600,'AA:BB:CC:00:00:09',?,datetime('now',?))`);
  addSale.run('ws_live_a', id, loc2, 100, 'paid', '-1 hours');
  addSale.run('ws_live_b', id, loc2, 50, 'paid', '-1 hours');
  addSale.run('ws_live_c', id, loc2, 999, 'failed', '-1 hours');
  addSale.run('ws_live_d', id, loc2, 70, 'paid', '-10 days'); // previous 7-day period
  addSale.run('ws_live_e', id, loc2, 30, 'paid', '-20 days'); // outside both
  const week = await api('/api/business/dashboard?period=7d', { token: ownerToken });
  assert.equal(week.status, 200);
  const total = (key) => week.body.daily.reduce((s, r) => s + r[key], 0);
  assert.equal(total('gross'), 220, 'paid money only, this period and the previous one');
  assert.equal(total('payments'), 3);
  assert.equal(total('failed'), 1, 'failed attempts are counted for the success rate');
  assert.ok(week.body.daily.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)), 'days are calendar dates');
  assert.equal(week.body.gross, 150, 'the period total itself is unchanged');

  // The dashboard wiring is in place.
  assert.match(html_ = fs.readFileSync(path.join(__dirname, '..', 'public', 'business.html'), 'utf8'), /<script src="\/home-live\.js"><\/script>/);
  assert.match(html_, /window\.FitiHomeLive\.render\(/, 'the live Home view renders after each overview load');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'business.html'), 'utf8');
  assert.match(html, /<script src="\/fiti-notify\.js"><\/script>/);
  assert.match(html, /function openRouterDraftModal\(\) \{ if \(adminView\) return;/, 'admin view never forces the add-router modal');
  assert.doesNotMatch(html, /admin-view-token[^\n]*localStorage\.setItem/, 'the admin token is never put in localStorage');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'platform-admin.html'), 'utf8');
  assert.match(admin, /data-action="dashboard">Open dashboard</);
  assert.doesNotMatch(admin, /admin-view=1[^']*token/, 'the token is never put in the URL');

  console.log('Admin dashboard view and PPPoE PayBill hint passed.');
  server.close(); process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

'use strict';

// Team accounts: roles, the route → permission table, invites, sessions,
// the Attendant's "today only" sales and the activity log.
// Real Express app and SQLite, on a database first made with the schema
// from before team accounts (an existing owner and session).
//   node --require ./test/in-process-http.js test/team.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-team-'));
const DATABASE_PATH = path.join(dir, 'hotspot.db');
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://wifi-fiti.example.test', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke',
  MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  PROVISION_MODE: 'poll', SITE_ID: 'site', SITE_TOKEN: 'site-token', TENANT_SECRETS_KEY: 'team-test-key',
  ADMIN_TOKEN: 'admin', DATABASE_PATH,
});
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const scrypt = (password) => { const salt = 'aabbccddeeff00112233445566778899'; return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`; };

// ---- A database from before team accounts --------------------------------
{
  const old = new DatabaseSync(DATABASE_PATH);
  old.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_name TEXT NOT NULL, owner_phone TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE business_sessions (token_hash TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  old.prepare(`INSERT INTO businesses (id, name, owner_name, owner_phone, email, password_hash) VALUES ('biz', 'Kitale Cyber', 'Don', '254712345678', 'don@test.ke', ?)`).run(scrypt('owner-password'));
  old.prepare(`INSERT INTO business_sessions (token_hash, business_id, expires_at) VALUES (?, 'biz', datetime('now','+1 day'))`).run(sha('old-owner-session'));
  old.close();
  // The migration runs twice (two deploys): it must be idempotent.
  for (let i = 0; i < 2; i += 1) execFileSync(process.execPath, ['-e', "require('./src/lib/db')"], { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'pipe' });
}

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
  const team = require('../src/lib/team');

  database.prepare(`UPDATE businesses SET billing_status='active', billing_expires_at=datetime('now','+20 day'), hotspot_concurrent=100, hotspot_billing_expires_at=datetime('now','+20 day') WHERE id='biz'`).run();
  database.prepare(`INSERT INTO locations (id, business_id, name, router_token, router_setup_verified_at) VALUES ('loc', 'biz', 'Main', 'rt', datetime('now'))`).run();
  database.prepare(`INSERT INTO business_packages (business_id, name, price, seconds) VALUES ('biz', 'Day pass', 20, 86400)`).run();
  const packageId = database.prepare(`SELECT id FROM business_packages WHERE business_id='biz'`).get().id;

  const call = async (method, url, body, token) => {
    const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', Host: 'cloud.wififiti.co.ke', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const OWNER_OLD = 'old-owner-session';

  console.log('\nMigration: the existing owner is unchanged');
  await test('the schema gained member_id and the team tables', () => {
    const columns = database.prepare('PRAGMA table_info(business_sessions)').all().map((column) => column.name);
    assert.ok(columns.includes('member_id'));
    for (const table of ['business_members', 'business_invites', 'business_activity']) {
      assert.ok(database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table), table);
    }
  });
  await test('an old session (no member) is the owner and still works', async () => {
    const me = await call('GET', '/api/business/me', null, OWNER_OLD);
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.business.id, 'biz');
    assert.equal(me.body.member.role, 'owner');
    assert.ok(me.body.member.permissions.includes('team'));
    assert.equal(me.body.packages.length, 1);
  });
  let ownerToken;
  await test('the owner signs in with the same email and password', async () => {
    const login = await call('POST', '/api/business/login', { email: 'don@test.ke', password: 'owner-password' });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    ownerToken = login.body.token;
    assert.equal(database.prepare('SELECT member_id FROM business_sessions WHERE token_hash=?').get(sha(ownerToken)).member_id, null);
    assert.equal((await call('GET', '/api/business/team', null, ownerToken)).status, 200);
    assert.equal((await call('POST', '/api/business/login', { email: 'don@test.ke', password: 'wrong-password' })).status, 401);
  });

  console.log('\nRoute table');
  await test('every /api/business route is listed in the permission table', () => {
    const app = server.listeners('request')[0];
    const missing = [];
    for (const layer of app._router.stack) {
      if (!layer.route || typeof layer.route.path !== 'string' || !/^\/api\/business\//.test(layer.route.path)) continue;
      for (const method of Object.keys(layer.route.methods)) {
        const found = team.routeFor(method.toUpperCase(), layer.route.path.replace(/:\w+/g, 'x1'));
        if (!found || found.pattern !== layer.route.path) missing.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  console.log('\nInvites');
  const invite = async (body) => {
    const response = await call('POST', '/api/business/team/invites', body, ownerToken);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  const tokenOf = (link) => decodeURIComponent(new URL(link).hash.replace(/^#invite=/, ''));
  await test('an invite gives a one-time link and a WhatsApp share link; only a hash is stored', async () => {
    const made = await invite({ role: 'manager', name: 'Mary', phone: '0711000001' });
    assert.match(made.link, /^https:\/\/cloud\.wififiti\.co\.ke\/business\.html#invite=/);
    assert.match(made.whatsappUrl, /^https:\/\/wa\.me\/254711000001\?text=/);
    assert.ok(decodeURIComponent(made.whatsappUrl).includes(made.link));
    assert.equal(made.emailed, false, 'no Resend in tests');
    const token = tokenOf(made.link);
    const row = database.prepare('SELECT * FROM business_invites WHERE id=?').get(made.invite.id);
    assert.equal(row.token_hash, sha(token));
    assert.ok(!JSON.stringify(row).includes(token), 'the raw token is not stored');
    const days = (Date.parse(row.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 86400_000;
    assert.ok(days > 6.9 && days <= 7, `expires in 7 days (${days})`);
    const check = await call('POST', '/api/business/invite/check', { token });
    assert.equal(check.status, 200);
    assert.equal(check.body.roleLabel, 'Manager');
    assert.equal(check.body.businessName, 'Kitale Cyber');
  });

  const members = {};
  const join = async (role, login, extra = {}) => {
    const made = await invite({ role, name: `${role} person` });
    const accepted = await call('POST', '/api/business/invite/accept', { token: tokenOf(made.link), name: `${role} person`, password: `${role}-password`, ...login, ...extra });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    members[role] = { token: accepted.body.token, id: accepted.body.member.id, link: made.link, login };
    return accepted;
  };
  await test('accepting sets name + password and signs the person in', async () => {
    const accepted = await join('manager', { email: 'mary@test.ke' });
    assert.equal(accepted.body.member.role, 'manager');
    const me = await call('GET', '/api/business/me', null, members.manager.token);
    assert.equal(me.body.member.name, 'manager person');
    assert.equal(me.body.member.roleLabel, 'Manager');
    assert.equal(database.prepare('SELECT member_id FROM business_sessions WHERE token_hash=?').get(sha(members.manager.token)).member_id, members.manager.id);
  });
  await test('an invite link works only once', async () => {
    const again = await call('POST', '/api/business/invite/accept', { token: tokenOf(members.manager.link), name: 'Eve', email: 'eve@test.ke', password: 'eve-password' });
    assert.equal(again.status, 410);
    assert.equal((await call('POST', '/api/business/invite/check', { token: tokenOf(members.manager.link) })).status, 410);
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM business_members WHERE email='eve@test.ke'`).get().n, 0);
  });
  await test('an expired invite cannot be used', async () => {
    const made = await invite({ role: 'viewer' });
    database.prepare(`UPDATE business_invites SET expires_at=datetime('now','-1 minute') WHERE id=?`).run(made.invite.id);
    const accepted = await call('POST', '/api/business/invite/accept', { token: tokenOf(made.link), name: 'Late', email: 'late@test.ke', password: 'late-password' });
    assert.equal(accepted.status, 410);
    assert.match(accepted.body.error, /expired/);
  });
  await test('the owner can cancel a pending invite', async () => {
    const made = await invite({ role: 'attendant', name: 'Cancelled' });
    const team1 = await call('GET', '/api/business/team', null, ownerToken);
    assert.ok(team1.body.invites.some((item) => item.id === made.invite.id));
    assert.equal((await call('DELETE', `/api/business/team/invites/${made.invite.id}`, null, ownerToken)).status, 200);
    const accepted = await call('POST', '/api/business/invite/accept', { token: tokenOf(made.link), name: 'X', email: 'x@test.ke', password: 'x-password1' });
    assert.equal(accepted.status, 410);
    assert.match(accepted.body.error, /cancelled/);
  });
  await test('a new link replaces a lost one', async () => {
    const made = await invite({ role: 'viewer', name: 'Relink' });
    const fresh = await call('POST', `/api/business/team/invites/${made.invite.id}/link`, null, ownerToken);
    assert.equal(fresh.status, 200);
    assert.equal((await call('POST', '/api/business/invite/check', { token: tokenOf(made.link) })).status, 404, 'old link stops working');
    assert.equal((await call('POST', '/api/business/invite/check', { token: tokenOf(fresh.body.link) })).status, 200);
    await call('DELETE', `/api/business/team/invites/${made.invite.id}`, null, ownerToken);
  });
  await test('a login already in use is refused (owner email, another member)', async () => {
    const made = await invite({ role: 'viewer' });
    const token = tokenOf(made.link);
    assert.equal((await call('POST', '/api/business/invite/accept', { token, name: 'A', email: 'don@test.ke', password: 'aaaa-password' })).status, 409);
    assert.equal((await call('POST', '/api/business/invite/accept', { token, name: 'A', email: 'mary@test.ke', password: 'aaaa-password' })).status, 409);
    assert.equal((await call('POST', '/api/business/invite/accept', { token, name: 'A', password: 'aaaa-password' })).status, 400, 'needs an email or phone');
    assert.equal((await call('POST', '/api/business/invite/accept', { token, name: 'A', email: 'a@test.ke', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/business/invite/check', { token })).status, 200, 'a refused try does not use the link');
    await call('DELETE', `/api/business/team/invites/${made.invite.id}`, null, ownerToken);
  });
  await test('staff cannot invite, and the owner role cannot be given', async () => {
    assert.equal((await call('POST', '/api/business/team/invites', { role: 'viewer' }, members.manager.token)).status, 403);
    assert.equal((await call('POST', '/api/business/team/invites', { role: 'owner' }, ownerToken)).status, 400);
  });

  await join('attendant', { phone: '0711000002' });
  await join('technician', { email: 'tech@test.ke' });
  await join('viewer', { email: 'viewer@test.ke', phone: '0711000004' });

  await test('customer access codes are shown to owner and manager only', async () => {
    database.prepare(`INSERT INTO tenant_subscriptions
      (id,business_id,location_id,router_username,payer_phone,mac,password,total_seconds,expires_at)
      VALUES ('sub-codes','biz','loc','254711000001-ABCDEF12','254711000001','AA:BB:CC:00:00:01','ABCD23',3600,datetime('now','+1 hour'))`).run();
    const endpoint = '/api/business/operations/customers/sub-codes';
    for (const token of [ownerToken, members.manager.token]) {
      const response = await call('GET', endpoint, null, token);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.accessCodes, { connectionCode: '254711000001-ABCDEF12', recoveryCode: 'ABCD23' });
    }
    const attendant = await call('GET', endpoint, null, members.attendant.token);
    assert.equal(attendant.status, 200);
    assert.equal(attendant.body.accessCodes, null);
    assert.doesNotMatch(JSON.stringify(attendant.body), /ABCD23/);
    assert.equal((await call('GET', endpoint, null, members.technician.token)).status, 403);
  });

  console.log('\nSigning in as a team member');
  await test('a member signs in with email or phone', async () => {
    const byPhone = await call('POST', '/api/business/login', { email: '0711000002', password: 'attendant-password' });
    assert.equal(byPhone.status, 200, JSON.stringify(byPhone.body));
    assert.equal(byPhone.body.member.role, 'attendant');
    const byEmail = await call('POST', '/api/business/login', { email: 'VIEWER@test.ke', password: 'viewer-password' });
    assert.equal(byEmail.status, 200);
    assert.equal((await call('POST', '/api/business/login', { email: '+254711000004', password: 'viewer-password' })).status, 200);
    assert.equal((await call('POST', '/api/business/login', { email: 'tech@test.ke', password: 'wrong-password' })).status, 401);
  });

  console.log('\nPermissions per role');
  const loc = '/api/business/locations/loc';
  const cases = {
    manager: {
      allowed: [['GET', '/api/business/vouchers'], ['POST', '/api/business/packages', { name: 'Hour', price: 10, hours: 1 }], ['GET', '/api/business/dashboard'],
        ['GET', '/api/business/operations/customers'], ['GET', `${loc}/tools`], ['POST', `${loc}/tools`, { tool: 'backup' }], ['GET', `/api/business/router-telemetry?locationId=loc`],
        ['GET', `${loc}/remote-access`], ['GET', '/api/business/portal-templates']],
      denied: [['GET', '/api/business/payment-collection'], ['POST', '/api/business/payment-collection', {}], ['POST', '/api/business/operations/payouts', {}],
        ['GET', '/api/business/operations/payouts'], ['DELETE', loc], ['GET', '/api/business/team'], ['GET', '/api/business/integrations'],
        ['POST', '/api/business/tuma/settlement', {}], ['POST', '/api/business/billing/checkout', {}], ['PATCH', '/api/business/organisation', {}]],
    },
    attendant: {
      allowed: [['GET', '/api/business/vouchers'], ['POST', '/api/business/vouchers', { locationId: 'loc', packageId, count: 2 }], ['GET', '/api/business/dashboard'],
        ['GET', '/api/business/operations/customers'], ['POST', '/api/business/operations/transactions/nope/retry', {}], ['GET', '/api/business/tenant-dashboard']],
      denied: [['POST', '/api/business/packages', { name: 'x', price: 1, hours: 1 }], [`PATCH`, `/api/business/packages/${packageId}`, { price: 1 }],
        ['POST', '/api/business/vouchers/manage', { action: 'delete', codes: [] }], ['GET', '/api/business/pppoe/payments'], ['GET', '/api/business/router-telemetry?locationId=loc'],
        ['GET', `${loc}/tools`], ['GET', '/api/business/payment-collection'], ['GET', '/api/business/team']],
    },
    technician: {
      allowed: [['GET', '/api/business/router-telemetry?locationId=loc'], ['GET', `${loc}/tools`], ['POST', `${loc}/tools`, { tool: 'health' }],
        ['GET', `${loc}/router-topology`], ['GET', `${loc}/remote-access`], ['GET', `${loc}/network-plan/review`], ['PATCH', loc, { name: 'Main shop' }]],
      denied: [['GET', '/api/business/dashboard'], ['GET', '/api/business/tenant-dashboard'], ['POST', '/api/business/packages', { name: 'x', price: 1, hours: 1 }],
        ['GET', '/api/business/vouchers'], ['POST', `${loc}/tools`, { tool: 'backup' }], ['DELETE', loc], ['GET', '/api/business/payment-collection'],
        ['GET', '/api/business/operations/customers']],
    },
    viewer: {
      allowed: [['GET', '/api/business/dashboard'], ['GET', '/api/business/tenant-dashboard'], ['GET', '/api/business/pppoe/payments'], ['GET', '/api/business/me']],
      denied: [['POST', '/api/business/vouchers', { locationId: 'loc', packageId, count: 1 }], ['GET', '/api/business/vouchers'], [`PATCH`, `/api/business/packages/${packageId}`, { price: 1 }],
        ['POST', '/api/business/operations/transactions/nope/retry', {}], ['GET', '/api/business/router-telemetry?locationId=loc'], ['PATCH', loc, { name: 'x' }],
        ['GET', '/api/business/operations/customers'], ['GET', '/api/business/team']],
    },
  };
  for (const [role, { allowed, denied }] of Object.entries(cases)) {
    await test(`${role}: allowed routes pass the permission check`, async () => {
      for (const [method, url, body] of allowed) {
        const response = await call(method, url, body, members[role].token);
        assert.notEqual(response.status, 403, `${method} ${url} → ${JSON.stringify(response.body)}`);
        assert.notEqual(response.status, 401, `${method} ${url}`);
      }
    });
    await test(`${role}: other routes are refused (403)`, async () => {
      for (const [method, url, body] of denied) {
        const response = await call(method, url, body, members[role].token);
        assert.equal(response.status, 403, `${method} ${url} → ${response.status}`);
      }
    });
    await test(`${role}: a route missing from the table is denied`, async () => {
      assert.equal((await call('GET', '/api/business/not-a-route', null, members[role].token)).status, 403);
      assert.equal((await call('POST', '/api/business/secret-new-thing', {}, members[role].token)).status, 403);
    });
  }
  await test('the owner reaches everything (an unknown route is just 404)', async () => {
    assert.equal((await call('GET', '/api/business/not-a-route', null, ownerToken)).status, 404);
    assert.equal((await call('GET', '/api/business/payment-collection', null, ownerToken)).status, 200);
  });
  await test('no session still gets 401, not 403', async () => {
    assert.equal((await call('GET', '/api/business/vouchers')).status, 401);
    assert.equal((await call('GET', '/api/business/vouchers', null, 'not-a-session-token')).status, 401);
  });
  await test('/me tells each person their role and hides prices from a technician', async () => {
    const tech = await call('GET', '/api/business/me', null, members.technician.token);
    assert.equal(tech.body.member.role, 'technician');
    assert.deepEqual(tech.body.packages, []);
    assert.ok(tech.body.member.permissions.includes('routers.view'));
    assert.ok(!tech.body.member.permissions.includes('backups'));
    const attendant = await call('GET', '/api/business/me', null, members.attendant.token);
    assert.equal(attendant.body.packages.length >= 1, true);
  });

  console.log('\nAttendant sees today only');
  const addSale = (id, when) => database.prepare(`INSERT INTO tenant_transactions (checkout_request_id, business_id, location_id, phone, package_id, package_name, amount, seconds, mac, status, created_at)
    VALUES (?, 'biz', 'loc', '254711000009', ?, 'Day pass', 20, 86400, 'AA:BB:CC:00:00:09', 'paid', ${when})`).run(id, packageId);
  addSale('today-sale', "datetime('now')");
  addSale('old-sale', "datetime('now','-3 days')");
  await test('the dashboard is restricted to today whatever period is asked', async () => {
    const owner = await call('GET', '/api/business/dashboard?period=30d', null, ownerToken);
    assert.equal(owner.body.payments, 2);
    const attendant = await call('GET', '/api/business/dashboard?period=90d', null, members.attendant.token);
    assert.equal(attendant.status, 200);
    assert.equal(attendant.body.period, 'today');
    assert.equal(attendant.body.payments, 1);
    assert.deepEqual(attendant.body.transactions.map((row) => row.checkout_request_id), ['today-sale']);
    assert.deepEqual(attendant.body.recentPayments.map((row) => row.checkout_request_id), ['today-sale']);
    assert.ok(attendant.body.since >= team.todayStart());
  });
  await test('the analytics report is restricted to today as well', async () => {
    const owner = await call('GET', '/api/business/tenant-dashboard?period=30d', null, ownerToken);
    assert.equal(owner.body.summary.payments, 2);
    const attendant = await call('GET', '/api/business/tenant-dashboard?period=30d', null, members.attendant.token);
    assert.equal(attendant.body.summary.payments, 1);
    assert.deepEqual(attendant.body.report.map((row) => row.checkout_request_id), ['today-sale']);
    const viewer = await call('GET', '/api/business/tenant-dashboard?period=30d', null, members.viewer.token);
    assert.equal(viewer.body.summary.payments, 2, 'a Viewer sees the full period');
  });
  console.log('\nMoney stays with the roles that see it');
  await test('the customer check hides the amount paid from a Technician', async () => {
    database.prepare(`INSERT INTO tenant_subscriptions (id, business_id, location_id, router_username, payer_phone, mac, password, total_seconds, expires_at)
      VALUES ('sub-check', 'biz', 'loc', 'u-check', '254711000009', 'AA:BB:CC:00:00:09', 'pw', 86400, datetime('now','+1 day'))`).run();
    database.prepare(`INSERT INTO tenant_router_tools (location_id, tool, args_json, status, result) VALUES ('loc', 'customer', '{"mac":"AA:BB:CC:00:00:09"}', 'done', 'active=1')`).run();
    const lastPayment = async (token) => {
      const response = await call('GET', `${loc}/tools`, null, token);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const run = response.body.runs.find((item) => item.tool === 'customer');
      assert.ok(run && run.account && run.account.lastPayment, JSON.stringify(response.body));
      return run.account.lastPayment;
    };
    const tech = await lastPayment(members.technician.token);
    assert.equal('amount' in tech, false, 'no amount for a Technician');
    assert.equal(tech.status, 'paid', 'the Technician still sees that it was paid');
    assert.equal((await lastPayment(ownerToken)).amount, 20);
    assert.equal((await lastPayment(members.manager.token)).amount, 20);
  });
  await test('the go-live card shows a Technician no sale amount or package price', async () => {
    const owner = await call('GET', `${loc}/go-live`, null, ownerToken);
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    const tech = await call('GET', `${loc}/go-live`, null, members.technician.token);
    assert.equal(tech.status, 200, JSON.stringify(tech.body));
    assert.equal(owner.body.sale.amount, 20);
    assert.equal('amount' in tech.body.sale, false);
    assert.equal(tech.body.sale.packageName, owner.body.sale.packageName, 'the rest of the card is the same');
    assert.equal(typeof owner.body.packages.cheapest.price, 'number');
    assert.deepEqual(Object.keys(tech.body.packages.cheapest), ['name']);
  });
  await test('PPPoE payments are listed for roles that see sales, not for an Attendant', async () => {
    database.prepare(`INSERT INTO pppoe_payments (business_id, user_id, username, kind, method, amount) VALUES ('biz', 'pppoe-user', 'jane', 'renewal', 'cash', 1500)`).run();
    const owner = await call('GET', '/api/business/pppoe/billing', null, ownerToken);
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    assert.equal(owner.body.payments.length, 1);
    assert.equal((await call('GET', '/api/business/pppoe/billing', null, members.manager.token)).body.payments.length, 1);
    const attendant = await call('GET', '/api/business/pppoe/billing', null, members.attendant.token);
    assert.equal(attendant.status, 200);
    assert.deepEqual(attendant.body.payments, []);
    assert.equal((await call('GET', '/api/business/pppoe/payments', null, members.attendant.token)).status, 403);
    assert.equal((await call('GET', '/api/business/pppoe/billing', null, members.technician.token)).status, 403, 'a Technician has no PPPoE customers');
    assert.equal((await call('GET', '/api/business/operations/payouts', null, members.manager.token)).status, 403, 'payouts stay owner-only');
    assert.equal((await call('GET', '/api/business/operations/billing', null, members.manager.token)).status, 403, 'receipts stay owner-only');
    assert.equal((await call('GET', '/api/business/operations/tickets', null, members.technician.token)).status, 200, 'a Technician can use support');
  });
  await test('today starts at midnight in Nairobi', () => {
    assert.equal(team.todayStart(Date.parse('2026-09-29T20:59:00Z')), '2026-09-28 21:00:00');
    assert.equal(team.todayStart(Date.parse('2026-09-29T21:00:00Z')), '2026-09-29 21:00:00');
  });

  console.log('\nRemoving someone or changing a role');
  await test('changing a role ends their sessions at once', async () => {
    const other = await call('POST', '/api/business/login', { email: 'viewer@test.ke', password: 'viewer-password' });
    const changed = await call('PATCH', `/api/business/team/members/${members.viewer.id}`, { role: 'attendant' }, ownerToken);
    assert.equal(changed.status, 200);
    assert.equal((await call('GET', '/api/business/me', null, members.viewer.token)).status, 401);
    assert.equal((await call('GET', '/api/business/me', null, other.body.token)).status, 401);
    const again = await call('POST', '/api/business/login', { email: 'viewer@test.ke', password: 'viewer-password' });
    assert.equal(again.body.member.role, 'attendant');
    members.viewer.token = again.body.token;
  });
  await test('removing someone ends their sessions and their login', async () => {
    const removed = await call('DELETE', `/api/business/team/members/${members.viewer.id}`, null, ownerToken);
    assert.equal(removed.status, 200);
    assert.equal((await call('GET', '/api/business/vouchers', null, members.viewer.token)).status, 401);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM business_sessions WHERE member_id=?').get(members.viewer.id).n, 0);
    assert.equal((await call('POST', '/api/business/login', { email: 'viewer@test.ke', password: 'viewer-password' })).status, 401);
    const list = await call('GET', '/api/business/team', null, ownerToken);
    assert.ok(!list.body.members.some((member) => member.id === members.viewer.id));
  });
  await test('a session left behind for a removed member is refused even without the delete', async () => {
    database.prepare(`INSERT INTO business_sessions (token_hash, business_id, member_id, expires_at) VALUES (?, 'biz', ?, datetime('now','+1 day'))`).run(sha('stale-member-session'), members.viewer.id);
    assert.equal((await call('GET', '/api/business/me', null, 'stale-member-session')).status, 401);
  });

  console.log('\nPasswords');
  await test('the owner makes a one-time reset link for a member', async () => {
    const reset = await call('POST', `/api/business/team/members/${members.technician.id}/reset`, null, ownerToken);
    assert.equal(reset.status, 201, JSON.stringify(reset.body));
    const token = tokenOf(reset.body.link);
    const check = await call('POST', '/api/business/invite/check', { token });
    assert.equal(check.body.kind, 'reset');
    const used = await call('POST', '/api/business/invite/accept', { token, password: 'new-tech-password' });
    assert.equal(used.status, 200);
    assert.equal((await call('GET', '/api/business/me', null, members.technician.token)).status, 401, 'old sessions end');
    assert.equal((await call('POST', '/api/business/login', { email: 'tech@test.ke', password: 'technician-password' })).status, 401);
    assert.equal((await call('POST', '/api/business/login', { email: 'tech@test.ke', password: 'new-tech-password' })).status, 200);
    assert.equal((await call('POST', '/api/business/invite/accept', { token, password: 'again-password' })).status, 410);
    members.technician.token = used.body.token;
  });
  await test('the owner password reset still works and keeps staff signed in', async () => {
    database.prepare(`INSERT INTO business_email_verifications (id, email, purpose, business_id, code_hash, expires_at, last_sent_at)
      VALUES ('verify-test', 'don@test.ke', 'reset', 'biz', ?, datetime('now','+3 minutes'), datetime('now'))`).run(sha('123456'));
    const reset = await call('POST', '/api/business/reset-password', { verificationId: 'verify-test', code: '123456', password: 'owner-password-2' });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal((await call('GET', '/api/business/me', null, OWNER_OLD)).status, 401);
    assert.equal((await call('GET', '/api/business/me', null, members.manager.token)).status, 200);
    const login = await call('POST', '/api/business/login', { email: 'don@test.ke', password: 'owner-password-2' });
    assert.equal(login.status, 200);
    ownerToken = login.body.token;
  });
  await test('staff emails cannot be used to register a new business', async () => {
    const response = await call('POST', '/api/business/register', { email: 'mary@test.ke', password: 'password1' });
    assert.equal(response.status, 409);
  });

  console.log('\nActivity log');
  await test('money, package, voucher, router and team actions are logged with who did them', async () => {
    const log = (await call('GET', '/api/business/team', null, ownerToken)).body.activity;
    const find = (action, role) => log.find((row) => row.action === action && row.actor_role === role);
    assert.ok(find('Invited someone', 'owner'), 'owner invite');
    assert.ok(find('Joined the team', 'manager'), 'manager joined');
    const vouchers = find('Created vouchers', 'attendant');
    assert.ok(vouchers, 'attendant vouchers');
    assert.equal(vouchers.actor_name, 'attendant person');
    assert.match(vouchers.target, /Router: Main/);
    assert.match(vouchers.target, /2 codes/);
    assert.ok(find('Added a package', 'manager'), 'manager package');
    assert.ok(find('Changed a router', 'technician'), 'technician rename');
    assert.ok(find('Changed a role', 'owner'), 'role change');
    assert.ok(find('Removed someone', 'owner'), 'removal');
    assert.ok(find('Made a password reset link', 'owner'));
    assert.ok(log.every((row) => row.created_at), 'each row has a time');
  });
  await test('refused and failed actions are not logged', async () => {
    const log = (await call('GET', '/api/business/team', null, ownerToken)).body.activity;
    assert.ok(!log.some((row) => row.actor_role === 'viewer' && row.action === 'Created vouchers'));
    assert.ok(!log.some((row) => row.action === 'Ran a router tool' && row.actor_role === 'technician' && /backup/.test(row.target || '')));
  });
  await test('staff cannot read the activity log', async () => {
    assert.equal((await call('GET', '/api/business/team', null, members.manager.token)).status, 403);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });

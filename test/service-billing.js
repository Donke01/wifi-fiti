'use strict';

// Prepaid service entitlements and reminders. Pure rules plus an in-memory
// SQLite for the reminder log. No network, no money.
//   node test/service-billing.js
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const sb = require('../src/lib/service-billing');
const { createServiceReminders } = require('../src/lib/service-reminders');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

const NOW = Date.parse('2026-10-10T09:00:00Z');
const DAY = 86400_000;
const at = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString().replace('T', ' ').slice(0, 19);

(async () => {
  console.log('\nPeriods and grace');

  await test('a period is active, then in grace for 3 days, then expired', () => {
    assert.equal(sb.periodState(at(1), NOW).status, 'active');
    assert.equal(sb.periodState(at(-1), NOW).status, 'grace');
    assert.equal(sb.periodState(at(-2.9), NOW).status, 'grace');
    assert.equal(sb.periodState(at(-3.1), NOW).status, 'expired');
    assert.equal(sb.periodState(null, NOW).status, 'none');
  });

  console.log('\nHotspot sales');

  const paid = { billing_status: 'trial', billing_expires_at: at(-20), hotspot_billing_expires_at: at(10), hotspot_concurrent: 100 };

  await test('an active trial sells without limits', () => {
    assert.equal(sb.hotspotSaleBlock({ billing_status: 'trial', billing_expires_at: at(3) }, { activeNow: 5000 }, NOW), null);
  });

  await test('an ended trial with no service stops new sales', () => {
    assert.match(sb.hotspotSaleBlock({ billing_status: 'trial', billing_expires_at: at(-1) }, {}, NOW), /renewed/);
  });

  await test('paid hotspot capacity sells until users online reach the tier', () => {
    assert.equal(sb.hotspotSaleBlock(paid, { activeNow: 99 }, NOW), null);
    assert.match(sb.hotspotSaleBlock(paid, { activeNow: 100 }, NOW), /full right now/);
  });

  await test('a device renewing its own time is never blocked by capacity', () => {
    assert.equal(sb.hotspotSaleBlock(paid, { activeNow: 250, renewing: true }, NOW), null);
  });

  await test('sales continue through the 3-day grace period, then stop', () => {
    assert.equal(sb.hotspotSaleBlock({ ...paid, hotspot_billing_expires_at: at(-2) }, { activeNow: 10 }, NOW), null);
    assert.match(sb.hotspotSaleBlock({ ...paid, hotspot_billing_expires_at: at(-4) }, { activeNow: 10 }, NOW), /renewed/);
  });

  await test('a legacy Starter/Growth plan keeps selling until it runs out', () => {
    const legacy = { billing_status: 'active', billing_expires_at: at(5) };
    assert.equal(sb.hotspotSaleBlock(legacy, {}, NOW), null);
    assert.match(sb.hotspotSaleBlock({ ...legacy, billing_expires_at: at(-5) }, {}, NOW), /renewed/);
  });

  await test('operators created before billing existed are not switched off', () => {
    assert.equal(sb.hotspotSaleBlock({ billing_status: 'active', billing_expires_at: null }, {}, NOW), null);
  });

  await test('a suspended workspace never sells', () => {
    assert.match(sb.hotspotSaleBlock({ ...paid, billing_status: 'suspended' }, {}, NOW), /unavailable/);
  });

  await test('paid hotspot capacity lifts the router limit, even when bought during the trial', () => {
    assert.equal(sb.routerLimitLifted(paid, NOW), true);
    assert.equal(sb.routerLimitLifted({ billing_status: 'trial', billing_expires_at: at(3), hotspot_billing_expires_at: at(10) }, NOW), true);
    assert.equal(sb.routerLimitLifted({ billing_status: 'trial', billing_expires_at: at(3) }, NOW), false, 'a trial alone keeps one router');
  });

  console.log('\nPPPoE subscribers');

  const pppoe = { billing_status: 'active', pppoe_billing_expires_at: at(10), pppoe_users: 40 };

  await test('subscribers can be added up to the paid number', () => {
    assert.equal(sb.pppoeAddBlock(pppoe, { activeUsers: 39 }, NOW), null);
    assert.match(sb.pppoeAddBlock(pppoe, { activeUsers: 40 }, NOW), /covers 40 PPPoE users/);
    assert.equal(sb.pppoeAddBlock(pppoe, { activeUsers: 40, adding: false }, NOW), null, 're-provisioning an existing user is fine');
  });

  await test('without a PPPoE subscription the owner is told to subscribe', () => {
    assert.match(sb.pppoeAddBlock({ billing_status: 'active' }, {}, NOW), /Subscribe to PPPoE/);
    assert.match(sb.pppoeAddBlock({ ...pppoe, pppoe_billing_expires_at: at(-5) }, {}, NOW), /has ended/);
    assert.equal(sb.pppoeAddBlock({ ...pppoe, pppoe_billing_expires_at: at(-1) }, { activeUsers: 1 }, NOW), null, 'grace');
  });

  console.log('\nReminders');

  await test('reminders are due 3 days before, in grace, and once sales stop', () => {
    assert.deepEqual(sb.dueReminders('hotspot', at(2), NOW).map(r => r.stage), ['before']);
    assert.deepEqual(sb.dueReminders('hotspot', at(5), NOW), []);
    assert.deepEqual(sb.dueReminders('hotspot', at(-1), NOW).map(r => r.stage), ['grace']);
    assert.deepEqual(sb.dueReminders('hotspot', at(-4), NOW).map(r => r.stage), ['stopped']);
    assert.deepEqual(sb.dueReminders('hotspot', at(-30), NOW), []);
  });

  await test('each reminder is sent once by SMS and email', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE businesses (id TEXT, name TEXT, portal_name TEXT, owner_phone TEXT, email TEXT, billing_status TEXT,
      billing_expires_at TEXT, hotspot_billing_expires_at TEXT, pppoe_billing_expires_at TEXT)`);
    db.prepare(`INSERT INTO businesses VALUES ('b1','Kitale Cyber',NULL,'0712345678','owner@kc.test','trial',?,?,NULL)`).run(at(-20), at(2));
    db.prepare(`INSERT INTO businesses VALUES ('b2','Trial Shop',NULL,'0712345679','t@shop.test','trial',?,NULL,NULL)`).run(at(1));
    const sms = []; const emails = [];
    let clock = NOW;
    const reminders = createServiceReminders({ db, now: () => clock, log: { error() {} },
      smsProvider: { async send(m) { sms.push(m); } }, sendEmail: async (m) => { emails.push(m); } });
    assert.equal(await reminders.run(), 2);
    assert.equal(await reminders.run(), 0, 'nothing is repeated');
    assert.equal(sms.length, 2);
    assert.equal(sms[0].to, '+254712345678');
    assert.match(sms[0].message, /Kitale Cyber: your Wi-Fi Fiti hotspot subscription ends on/);
    assert.match(sms[1].message, /free trial ends on/);
    assert.equal(emails.length, 2);
    clock = NOW + 3 * DAY; // hotspot now in grace, trial ended
    assert.equal(await reminders.run(), 2);
    assert.match(sms[2].message, /3 grace days/);
    assert.match(sms[3].message, /trial has ended/);
  });

  await test('old Starter/Growth tenants are told to move to prepaid capacity', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE businesses (id TEXT, name TEXT, portal_name TEXT, owner_phone TEXT, email TEXT, billing_status TEXT,
      billing_expires_at TEXT, hotspot_billing_expires_at TEXT, pppoe_billing_expires_at TEXT)`);
    db.prepare(`INSERT INTO businesses VALUES ('old','Old Plan Co',NULL,'0712000000',NULL,'active',?,NULL,NULL)`).run(at(2));
    db.prepare(`INSERT INTO businesses VALUES ('moved','Moved Co',NULL,'0712000001',NULL,'active',?,?,NULL)`).run(at(2), at(25));
    const sms = [];
    const reminders = createServiceReminders({ db, now: () => NOW, log: { error() {} }, smsProvider: { async send(m) { sms.push(m); } } });
    assert.equal(await reminders.run(), 1, 'a tenant already on prepaid hotspot capacity is not nagged');
    assert.match(sms[0].message, /Old Plan Co: .*replaced by prepaid capacity from KES 1,000/);
  });

  console.log('\nAdding users mid-period');

  const active = { billing_status: 'active', hotspot_concurrent: 200, hotspot_billing_expires_at: at(15), pppoe_users: 40, pppoe_billing_expires_at: at(15) };

  await test('usage is ok, near at 90% and full at capacity', () => {
    const u = sb.capacityUsage(active, { hotspotOnline: 179, pppoeActive: 36 });
    assert.equal(u.hotspot.level, 'ok'); assert.equal(u.pppoe.level, 'near');
    assert.equal(sb.capacityUsage(active, { hotspotOnline: 200 }).hotspot.level, 'full');
    assert.equal(u.hotspot.suggested, 300); assert.equal(u.pppoe.suggested, 50);
  });

  await test('adding users costs the price difference for the days left only', () => {
    const q = sb.upgradeQuote(active, { hotspotConcurrent: 300, pppoeUsers: 50 }, NOW);
    assert.deepEqual(q.items.map(i => [i.kind, i.fullDiffKes, i.amountKes, i.daysLeft]), [['hotspot', 1000, 500, 15], ['pppoe', 150, 75, 15]]);
    assert.equal(q.totalKes, 575);
  });

  await test('a move within the same hotspot tier is free', () => {
    const q = sb.upgradeQuote({ ...active, hotspot_concurrent: 150 }, { hotspotConcurrent: 200 }, NOW);
    assert.equal(q.totalKes, 0);
  });

  await test('an upgrade needs an active period and a bigger number', () => {
    assert.throws(() => sb.upgradeQuote(active, { hotspotConcurrent: 200 }, NOW), /more users than you have/);
    assert.throws(() => sb.upgradeQuote({ ...active, hotspot_billing_expires_at: at(-1) }, { hotspotConcurrent: 300 }, NOW), /Renew it/);
  });

  await test('the owner is prompted once when nearly full and once when full', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE businesses (id TEXT, name TEXT, portal_name TEXT, owner_phone TEXT, email TEXT, billing_status TEXT,
      billing_expires_at TEXT, hotspot_billing_expires_at TEXT, pppoe_billing_expires_at TEXT, hotspot_concurrent INTEGER, pppoe_users INTEGER)`);
    db.prepare(`INSERT INTO businesses VALUES ('b1','Kitale Cyber',NULL,'0712345678',NULL,'active',NULL,?,NULL,200,0)`).run(at(15));
    let online = 185;
    const sms = [];
    const reminders = createServiceReminders({ db, now: () => NOW, log: { error() {} }, smsProvider: { async send(m) { sms.push(m.message); } },
      capacityUsage: (b) => sb.capacityUsage(b, { hotspotOnline: online }) });
    assert.equal(await reminders.run(), 1);
    assert.equal(await reminders.run(), 0);
    assert.match(sms[0], /185 of 200 users online at once.*days left this month/);
    online = 200;
    assert.equal(await reminders.capacityPrompt('b1', 'hotspot', 'full'), true);
    assert.equal(await reminders.capacityPrompt('b1', 'hotspot', 'full'), false, 'once per capacity');
    assert.match(sms[1], /plan is full .*turned away/);
    db.prepare(`UPDATE businesses SET hotspot_concurrent=300`).run();
    online = 300;
    assert.equal(await reminders.capacityPrompt('b1', 'hotspot', 'full'), true, 'a new capacity can prompt again');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();

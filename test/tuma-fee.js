'use strict';

// Tuma monthly fee pass-through: thresholds, grace, pause and reminders.
// In-memory SQLite, no network, no money.
//   node test/tuma-fee.js
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createTumaFee, monthKey, monthBounds, FEE_KES } = require('../src/lib/tuma-fee');
const { createServiceReminders } = require('../src/lib/service-reminders');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

const DAY = 86400_000;
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function setup(nowMs) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenant_transactions (checkout_request_id TEXT PRIMARY KEY, business_id TEXT, amount INTEGER, status TEXT,
      payment_source TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE tuma_fee_payments (business_id TEXT, month TEXT, amount INTEGER, checkout_request_id TEXT UNIQUE,
      paid_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (business_id, month));
    CREATE TABLE business_billing_transactions (checkout_request_id TEXT, business_id TEXT, plan TEXT, service_kind TEXT,
      status TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE businesses (id TEXT, name TEXT, portal_name TEXT, owner_phone TEXT, email TEXT, billing_status TEXT,
      billing_expires_at TEXT, hotspot_billing_expires_at TEXT, pppoe_billing_expires_at TEXT);
    CREATE TABLE tenant_tuma_accounts (business_id TEXT, active INTEGER);
  `);
  let n = 0;
  const sale = (amount, atMs, source = 'tuma_direct', business = 'b1') => db.prepare(`INSERT INTO tenant_transactions VALUES (?,?,?,?,?,?,?)`)
    .run(`tx${++n}`, business, amount, 'paid', source, sql(atMs), sql(atMs));
  let clock = nowMs;
  const fee = createTumaFee({ db, now: () => clock });
  return { db, fee, sale, setNow: (ms) => { clock = ms; }, now: () => clock };
}

// 15 Oct 2026, 12:00 Nairobi time.
const MID_OCT = Date.parse('2026-10-15T09:00:00Z');

(async () => {
  console.log('\nMonths');

  await test('months follow Kenyan time, not UTC', () => {
    assert.equal(monthKey(Date.parse('2026-09-30T21:30:00Z')), '2026-10', '00:30 on 1 Oct in Nairobi');
    assert.deepEqual(monthBounds('2026-10'), { start: '2026-09-30 21:00:00', end: '2026-10-31 21:00:00' });
  });

  await test('the fee is KES 3,000', () => { assert.equal(FEE_KES, 3000); });

  console.log('\nStages');

  await test('below KES 80,000 nothing is due', () => {
    const h = setup(MID_OCT);
    h.sale(79999, MID_OCT - DAY);
    const s = h.fee.state('b1');
    assert.equal(s.current.stage, 'below');
    assert.equal(s.current.canPay, false);
    assert.equal(h.fee.salesBlock('b1'), null);
  });

  await test('from KES 80,000 the tenant is warned and may pay early', () => {
    const h = setup(MID_OCT);
    h.sale(50000, MID_OCT - 5 * DAY); h.sale(30000, MID_OCT - DAY);
    const s = h.fee.state('b1');
    assert.equal(s.current.stage, 'approaching');
    assert.equal(s.current.canPay, true);
    assert.equal(h.fee.payableMonth('b1').month, '2026-10');
  });

  await test('only sales settled to the tenant\'s own Tuma business count', () => {
    const h = setup(MID_OCT);
    h.sale(90000, MID_OCT - DAY, 'own'); h.sale(90000, MID_OCT - DAY, 'tuma');
    assert.equal(h.fee.state('b1').current.salesKes, 0);
  });

  await test('at KES 100,000 the fee is due, with 3 days before sales pause', () => {
    const h = setup(MID_OCT);
    h.sale(60000, MID_OCT - 3 * DAY); h.sale(40000, MID_OCT - DAY);
    let s = h.fee.state('b1');
    assert.equal(s.current.stage, 'due');
    assert.equal(s.current.pauseAt, new Date(MID_OCT - DAY + 3 * DAY).toISOString());
    assert.equal(h.fee.salesBlock('b1'), null, 'still selling in the grace days');
    h.setNow(MID_OCT + 2.1 * DAY);
    s = h.fee.state('b1');
    assert.equal(s.current.stage, 'overdue');
    assert.match(h.fee.salesBlock('b1'), /temporarily unavailable/);
  });

  await test('paying the fee lifts the pause at once', () => {
    const h = setup(MID_OCT + 5 * DAY);
    h.sale(100000, MID_OCT - DAY);
    assert.ok(h.fee.salesBlock('b1'));
    h.db.prepare(`INSERT INTO tuma_fee_payments (business_id, month, amount, checkout_request_id) VALUES ('b1','2026-10',3000,'c1')`).run();
    assert.equal(h.fee.state('b1').current.stage, 'paid');
    assert.equal(h.fee.salesBlock('b1'), null);
    assert.equal(h.fee.payableMonth('b1'), null);
  });

  await test('an unpaid fee from last month still pauses sales until it is paid', () => {
    const h = setup(Date.parse('2026-11-05T09:00:00Z'));
    h.sale(120000, MID_OCT);
    const s = h.fee.state('b1');
    assert.equal(s.current.stage, 'below');
    assert.equal(s.previous.month, '2026-10');
    assert.ok(h.fee.salesBlock('b1'));
    assert.equal(h.fee.payableMonth('b1').month, '2026-10', 'the oldest unpaid month is paid first');
  });

  console.log('\nReminders');

  await test('owners get one reminder per stage by SMS', async () => {
    const h = setup(MID_OCT);
    h.db.prepare(`INSERT INTO businesses VALUES ('b1','Kitale Cyber',NULL,'0712345678',NULL,'active',NULL,NULL,NULL)`).run();
    h.db.prepare(`INSERT INTO tenant_tuma_accounts VALUES ('b1', 1)`).run();
    const sms = [];
    const reminders = createServiceReminders({ db: h.db, tumaFee: h.fee, now: h.now, log: { error() {} },
      smsProvider: { async send(m) { sms.push(m.message); } } });
    h.sale(85000, MID_OCT - DAY);
    assert.equal(await reminders.run(), 1);
    assert.equal(await reminders.run(), 0);
    assert.match(sms[0], /Kitale Cyber: your Tuma sales this month are KES 85,000.*KES 3,000/);
    h.sale(20000, MID_OCT);
    assert.equal(await reminders.run(), 1);
    assert.match(sms[1], /KES 3,000 Tuma fee is due/);
    h.setNow(MID_OCT + 4 * DAY);
    assert.equal(await reminders.run(), 1);
    assert.match(sms[2], /new sales are paused/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();

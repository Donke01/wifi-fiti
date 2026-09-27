'use strict';
// One free trial per phone, payout account and ID name. In-memory SQLite.
//   node test/trial-guard.js
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createTrialGuard, normaliseName } = require('../src/lib/trial-guard');
const phone = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('254')) d = d.slice(3); else if (d.startsWith('0')) d = d.slice(1); return /^[71]\d{8}$/.test(d) ? '254' + d : null; };

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE businesses (id TEXT PRIMARY KEY, owner_phone TEXT, billing_status TEXT, billing_expires_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
const add = (id, ownerPhone, status = 'trial') => db.prepare(`INSERT INTO businesses (id, owner_phone, billing_status, billing_expires_at) VALUES (?, ?, ?, datetime('now','+7 days'))`).run(id, ownerPhone, status);
const onTrial = (id) => db.prepare(`SELECT billing_expires_at > datetime('now') AS t, trial_ended_reason AS r FROM businesses WHERE id=?`).get(id);

add('old', '0712000001', 'active'); // an existing operator from before the guard
const guard = createTrialGuard({ db, normalizePhone: phone, log: { log() {} } });
guard.backfillPhones();

assert.equal(normaliseName('  Wanjiru  Akinyi Otieno '), normaliseName('otieno WANJIRU akinyi'), 'name order and case do not matter');

add('a', '0712000002');
assert.equal(guard.check('a', { phone: '0712 000 002' }), null, 'a new phone keeps its trial');
assert.equal(onTrial('a').t, 1);

add('b', '+254712000002');
assert.match(guard.check('b', { phone: '+254712000002' }), /this phone number/, 'the same phone in another format is caught');
assert.equal(onTrial('b').t, 0); assert.match(onTrial('b').r, /phone number/);
assert.equal(onTrial('a').t, 1, 'the first workspace keeps its trial');
assert.equal(guard.check('a', { phone: '0712000002' }), null, 'rechecking the first workspace changes nothing');

add('c', '0712000001');
assert.match(guard.check('c', { phone: '0712000001' }), /phone number/, 'phones of existing operators count as used');

add('d', '0712000004');
assert.equal(guard.check('d', { phone: '0712000004', payout: 'b-eq:0170299999999', name: 'Wanjiru Akinyi Otieno' }), null);
add('e', '0712000005');
assert.match(guard.check('e', { phone: '0712000005', payout: 'b-eq:0170 2999 99999' }), /payout account/, 'the same bank account is caught');
add('f', '0712000006');
assert.match(guard.check('f', { phone: '0712000006', payout: 'b-till:5123456', name: 'Otieno Wanjiru Akinyi' }), /ID name/, 'the same ID name in any order is caught');
add('g', '0712000007');
assert.equal(guard.check('g', { name: 'Wanjiru' }), null, 'a single name is too weak to match on');

const stored = db.prepare('SELECT fingerprint FROM trial_fingerprints').all().map((r) => r.fingerprint);
assert.ok(stored.every((f) => /^[0-9a-f]{64}$/.test(f)), 'only hashes are stored');
console.log('Trial guard: one free trial per phone, payout account and ID name; first workspace keeps it; only hashes stored - passed');

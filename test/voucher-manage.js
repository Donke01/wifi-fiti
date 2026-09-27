/* Voucher manager: pause, resume, extend and delete, singly or in bulk, for unused and in-use vouchers. */
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiti-voucher-manage-'));
Object.assign(process.env, { PUBLIC_URL: 'https://fiti.test', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's',
  MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p', PROVISION_MODE: 'poll', SITE_TOKEN: 'x', TENANT_SECRETS_KEY: 'k',
  DATABASE_PATH: path.join(dir, 't.db') });
const { db } = require('../src/lib/db'); const tenant = require('../src/lib/tenant');
db.prepare(`INSERT INTO businesses (id,name,owner_name,owner_phone,email,password_hash,onboarding_state)
  VALUES ('b1','B','O','0712345678','b1@x.test','h','complete'),('b2','C','O','0712345679','b2@x.test','h','complete')`).run();
db.prepare(`INSERT INTO locations (id,business_id,name,router_token) VALUES ('l1','b1','Main','rt1')`).run();
const codes = tenant.issueVouchers({ businessId: 'b1', locationId: 'l1', packageId: null, packageName: '1 hour',
  seconds: 3600, rateLimit: null, count: 5, batch: 'Friday' });
const [a, b, c, d, e] = codes;
const manage = (action, list, extra = {}) => tenant.manageVouchers({ businessId: 'b1', codes: list, action, ...extra });
const row = (code) => db.prepare('SELECT * FROM tenant_vouchers WHERE code=?').get(code);
const status = (code) => tenant.vouchersForBusiness.all('b1', 100).find((v) => v.code === code).status;
const redeem = (code, mac) => tenant.redeemVoucher({ locationId: 'l1', code, phone: '254712000111', mac, ip: '10.5.50.9' });
const lastJob = () => db.prepare(`SELECT action, total_seconds FROM tenant_jobs WHERE location_id='l1' ORDER BY id DESC LIMIT 1`).get();
const leftOf = (subId) => (Date.parse(db.prepare('SELECT expires_at FROM tenant_subscriptions WHERE id=?').get(subId).expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 1000;

// Another business's owner cannot touch these vouchers.
assert.deepStrictEqual(tenant.manageVouchers({ businessId: 'b2', codes: [a], action: 'delete' }).changed, 0);
assert.ok(row(a));
assert.throws(() => manage('extend', [a], { seconds: 10 }), /1 minute/);
assert.throws(() => manage('explode', [a]), /Unknown/);
assert.throws(() => manage('pause', []), /Select/);

// Unused: pause blocks redemption, resume allows it again.
assert.strictEqual(manage('pause', [a, b]).changed, 2);
assert.strictEqual(status(a), 'paused');
assert.strictEqual(redeem(a, 'AA:BB:CC:00:00:01'), null, 'a paused voucher cannot be redeemed');
assert.strictEqual(manage('pause', [a]).skipped[0].reason, 'already paused');
assert.strictEqual(manage('resume', [a]).changed, 1);
assert.strictEqual(status(a), 'open');

// Unused: extend adds to the voucher's value.
manage('extend', [c], { seconds: 1800 });
assert.strictEqual(row(c).seconds, 5400);

// In use: pause disconnects and holds the remaining time; resume restores it.
const grant = redeem(a, 'AA:BB:CC:00:00:01');
assert.ok(grant && grant.id);
assert.strictEqual(status(a), 'active');
assert.strictEqual(manage('pause', [a]).changed, 1);
assert.strictEqual(status(a), 'session_paused');
assert.strictEqual(lastJob().action, 'revoke', 'the customer is disconnected');
assert.ok(row(a).paused_seconds > 3500 && row(a).paused_seconds <= 3600);
assert.ok(leftOf(grant.id) <= 0, 'the session no longer counts as live');
manage('extend', [a], { seconds: 600 });
assert.ok(row(a).paused_seconds > 4100, 'extending a paused session adds to the held time');
assert.strictEqual(manage('resume', [a]).changed, 1);
assert.strictEqual(status(a), 'active');
assert.strictEqual(lastJob().action, 'upsert', 'the customer is provisioned again');
assert.ok(leftOf(grant.id) > 4100 && leftOf(grant.id) <= 4200);

// In use: extend adds time to the running session and the router ceiling.
const before = leftOf(grant.id);
manage('extend', [a], { seconds: 3600 });
assert.ok(leftOf(grant.id) - before > 3590);
assert.strictEqual(lastJob().action, 'upsert');

// Trial cap: a voucher cannot be stretched past the trial package length.
const capped = manage('extend', [d], { seconds: 24 * 3600, maxSeconds: 24 * 3600 });
assert.strictEqual(capped.changed, 0);
assert.match(capped.skipped[0].reason, /trial limit/);
assert.strictEqual(row(d).seconds, 3600);

// Delete: unused codes go, used ones are kept as sales history.
const deleted = manage('delete', [a, b, d, e, 'FITINOPE']);
assert.strictEqual(deleted.changed, 3);
assert.deepStrictEqual(deleted.skipped.map((s) => s.code).sort(), [a, 'FITINOPE'].sort());
assert.ok(row(a), 'the used voucher is kept');
assert.ok(!row(b) && !row(d) && !row(e));
assert.ok(row(c));
console.log('Voucher manager: pause, resume, extend and delete for unused and in-use vouchers, tenant isolation, trial cap - passed');

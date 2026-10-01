/* node test/c2b-multi.js - many C2B PayBills per business, one per router. */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-c2b-multi-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
// The first version: one PayBill per business, business_id is the key.
legacy.db.exec(`
  CREATE TABLE business_c2b_settings (
    business_id TEXT PRIMARY KEY, location_id TEXT NOT NULL, shortcode TEXT NOT NULL UNIQUE,
    account_prefix TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), callback_token TEXT);
  INSERT INTO business_c2b_settings (business_id, location_id, shortcode, account_prefix, callback_token)
    VALUES ('biz-a', 'loc-a1', '600111', 'KIT', '${'a'.repeat(48)}');
`);
require('../src/lib/tenant'); // creates tenant_transactions, as the server does first
const integrations = require('../src/lib/payment-integrations');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 3).join('\n       ')}`); process.exitCode = 1; }
}
console.log('C2B PayBills');

t('the old one-per-business table is rebuilt with every row and token kept', () => {
  const columns = legacy.db.prepare('PRAGMA table_info(business_c2b_settings)').all();
  assert.ok(!columns.some((c) => c.name === 'business_id' && c.pk), 'business_id is no longer the key');
  const setting = integrations.c2bSettingForToken('a'.repeat(48));
  assert.strictEqual(setting.shortcode, '600111'); assert.strictEqual(setting.location_id, 'loc-a1'); assert.strictEqual(setting.account_prefix, 'KIT');
});

t('a business can add a PayBill per router', () => {
  integrations.saveC2bFor({ businessId: 'biz-a', locationId: 'loc-a2', shortcode: '600222', accountPrefix: '' });
  assert.strictEqual(integrations.c2bSettingForLocation('biz-a', 'loc-a1').shortcode, '600111');
  assert.strictEqual(integrations.c2bSettingForLocation('biz-a', 'loc-a2').shortcode, '600222');
  assert.strictEqual(integrations.c2bSettingForShortcode('600222').location_id, 'loc-a2');
  const token = integrations.c2bSettingForShortcode('600222').callback_token;
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.notStrictEqual(token, 'a'.repeat(48), 'each PayBill has its own secret callback link');
});

t('a new PayBill for the same router replaces the old one there', () => {
  integrations.saveC2bFor({ businessId: 'biz-a', locationId: 'loc-a1', shortcode: '600333', accountPrefix: '' });
  assert.strictEqual(integrations.c2bSettingForLocation('biz-a', 'loc-a1').shortcode, '600333');
  assert.strictEqual(integrations.c2bSettingForShortcode('600111'), undefined, 'the replaced one stops matching');
  integrations.saveC2bFor({ businessId: 'biz-a', locationId: 'loc-a1', shortcode: '600111', accountPrefix: 'KIT' });
  assert.strictEqual(integrations.c2bSettingForToken('a'.repeat(48)).shortcode, '600111', 'bringing it back keeps its old link');
});

t('a shortcode used by another business is refused', () => {
  assert.throws(() => integrations.saveC2bFor({ businessId: 'biz-b', locationId: 'loc-b1', shortcode: '600222', accountPrefix: '' }), (error) => error.status === 409);
  assert.strictEqual(integrations.c2bSettingForShortcode('600222').business_id, 'biz-a');
});

t('the business-wide PayBill (PPPoE pay page) is the first active one', () => {
  assert.strictEqual(integrations.c2bSettingForBusiness('biz-a').shortcode, '600111');
  assert.strictEqual(integrations.c2bSettingForBusiness('biz-b'), undefined);
});

console.log(`\n${pass} passed`);

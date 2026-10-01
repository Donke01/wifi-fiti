/* node test/recovery-code.js - the recovery code is shown before payment and is the one that works. */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_TOKEN = 'rc-test-token';
process.env.TENANT_SECRETS_KEY = 'rc-test-storage-key';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-recovery-code-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
const tenant = require('../src/lib/tenant');

let pass = 0;
function t(name, fn) { fn(); pass += 1; console.log(`  ok   ${name}`); }

console.log('Recovery code before payment');

legacy.addBusiness.run({ id: 'biz-rc', name: 'RC Biz', ownerName: 'Owner', ownerPhone: '254700000000',
  email: 'rc@fiti.test', passwordHash: 'x', plan: 'starter', collectionMode: 'fiti' });
const location = tenant.createLocation({ id: 'loc-rc', businessId: 'biz-rc', name: 'RC Spot' });
const locationId = (location && location.id) || 'loc-rc';

const transaction = (mac, recoveryCode) => ({ business_id: 'biz-rc', location_id: locationId, phone: '254712345678',
  mac, seconds: 3600, rate_limit: null, device_type: 'phone', device_label: '', recovery_code: recoveryCode });

t('generated codes use the unambiguous recovery alphabet', () => {
  for (let i = 0; i < 50; i += 1) assert.match(tenant.generatePassword(), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
});

t('a new package uses exactly the code shown while paying', () => {
  const grant = tenant.grantSubscription({ transaction: transaction('A4:30:7A:00:00:01', 'K7MX4Q') });
  assert.strictEqual(grant.password, 'K7MX4Q');
  assert.strictEqual(tenant.subscriptionById.get(grant.id, locationId).password, 'K7MX4Q');
});

t('a top-up of a running package keeps the code the customer saved', () => {
  const grant = tenant.grantSubscription({ transaction: transaction('A4:30:7A:00:00:01', 'ZZZZZZ') });
  assert.strictEqual(grant.password, 'K7MX4Q');
});

t('a new package after the old one ended uses the newly shown code', () => {
  legacy.db.prepare(`UPDATE tenant_subscriptions SET expires_at=datetime('now','-1 minute') WHERE location_id=? AND mac=?`)
    .run(locationId, 'A4:30:7A:00:00:01');
  const grant = tenant.grantSubscription({ transaction: transaction('A4:30:7A:00:00:01', 'P3QR7T') });
  assert.strictEqual(grant.password, 'P3QR7T');
});

t('payments without a shown code (vouchers, older portals) still get a code', () => {
  const grant = tenant.grantSubscription({ transaction: transaction('A4:30:7A:00:00:02', null) });
  assert.match(grant.password, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  const bad = tenant.grantSubscription({ transaction: transaction('A4:30:7A:00:00:03', 'x"; /system reset') });
  assert.match(bad.password, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
});

t('the portal shows the code on the PIN screen', () => {
  const html = fs.readFileSync(require.resolve('../public/tenant-portal.html'), 'utf8');
  assert.ok(html.includes('id="waiting-recovery-code"'));
  assert.match(html, /showEarlyRecovery\(\);\s*async function check\(\)/);
});

t('payment connects straight away, with no receipt step', () => {
  const html = fs.readFileSync(require.resolve('../public/tenant-portal.html'), 'utf8');
  assert.ok(!html.includes('id="receipt-prompt"') && !html.includes('id="download-receipt"'));
  assert.match(html, /active\(result\);\s*if \(wasOfflinePurchase\)[^\n]*\n\s*else connectAfterAck\(result\);/);
});

console.log(`\n${pass} passed`);

/* Wall-clock subscriptions must survive refreshes and run while offline. */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'tok-clock';
process.env.DATABASE_PATH = '/tmp/wallclock-test.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync('/tmp/wallclock-test.db' + s); } catch {} }

const db = require('../src/lib/db');
const { grantTime, remainingFor } = require('../src/lib/grant');
const { buildExpiryScript } = require('../src/lib/rsc');

(async function () {
  const phone = '254712000099';
  await grantTime({ phone, seconds: 3600, profile: 'standard', mac: null, ip: null, reason: 'test' });
  const first = remainingFor(phone);
  assert.ok(first.expiresAt, 'expiry must be persisted');

  db.db.prepare("UPDATE accounts SET expires_at = datetime('now', '+3500 seconds'), is_active = 0 WHERE phone = ?").run(phone);
  const offline = remainingFor(phone);
  assert.ok(offline.remainingSeconds >= 3499 && offline.remainingSeconds <= 3500,
    'offline time must come from expiry');

  await grantTime({ phone, seconds: 600, profile: 'standard', mac: null, ip: null, reason: 'topup' });
  const topped = remainingFor(phone);
  assert.ok(topped.remainingSeconds >= 4098 && topped.remainingSeconds <= 4100,
    'top-up must extend the existing expiry');

  db.db.prepare("UPDATE accounts SET expires_at = datetime('now', '-1 second') WHERE phone = ?").run(phone);
  assert.strictEqual(remainingFor(phone).remainingSeconds, 0, 'expired time must not return after refresh');
  const script = buildExpiryScript(db.expiredAccounts.all());
  assert.ok(script.includes('disabled=yes') && script.includes('active remove'),
    'router must disconnect expired accounts');

  db.insert.run({ checkoutRequestId: 'recover-ios-1', merchantRequestId: 'm',
    phone, packageId: 'hr1', amount: 10, seconds: 3600,
    mac: 'AA:BB:CC:DD:EE:99', ip: '192.168.88.99' });
  const recovered = db.latestPaymentForMac.get('AA:BB:CC:DD:EE:99');
  assert.strictEqual(recovered.checkout_request_id, 'recover-ios-1',
    'a captive portal reload must recover its pending checkout by MAC');

  console.log('\nWall-clock subscriptions\n  ok   expiry, offline countdown, top-up, router disconnect and payment recovery');
})();

/* One M-Pesa number may fund independent purchasing devices. */
const assert = require('assert');
const fs = require('fs');

process.env.PROVISION_MODE = 'poll';
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'multi-token';
process.env.DATABASE_PATH = '/tmp/multi-device-balance.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + s); } catch {} }

const db = require('../src/lib/db');
const { fulfil } = require('../src/lib/fulfil');

function paid(id, mac, seconds) {
  db.insert.run({ checkoutRequestId: id, merchantRequestId: `m-${id}`,
    phone: '254748181876', packageId: 'hr1', amount: 10, seconds, mac, ip: null });
  db.markResult.run({ checkoutRequestId: id, status: 'paid', resultCode: 0,
    resultDesc: 'ok', receipt: `R-${id}` });
  return db.get.get(id);
}

(async () => {
  await fulfil(paid('one', 'AA:BB:CC:DD:EE:01', 3600));
  await fulfil(paid('two', 'AA:BB:CC:DD:EE:02', 3600));

  const accounts = db.accountsForPayer.all('254748181876');
  assert.strictEqual(accounts.length, 2, 'payer should own two separate balances');
  assert.notStrictEqual(accounts[0].phone, accounts[1].phone, 'router identities must differ');
  assert.strictEqual(db.accountByMac.get('AA:BB:CC:DD:EE:01').total_seconds, 3600);
  assert.strictEqual(db.accountByMac.get('AA:BB:CC:DD:EE:02').total_seconds, 3600);

  await fulfil(paid('topup', 'AA:BB:CC:DD:EE:02', 3600));
  assert.strictEqual(db.accountByMac.get('AA:BB:CC:DD:EE:01').total_seconds, 3600,
    'top-up for device two must not alter device one');
  assert.strictEqual(db.accountByMac.get('AA:BB:CC:DD:EE:02').total_seconds, 7200);
  console.log('multi-device balances: ok');
})().catch((e) => { console.error(e); process.exit(1); });

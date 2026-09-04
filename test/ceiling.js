/* Remaining time must never exceed what was actually paid for, however
   badly the ledger and the router have drifted. */
const assert = require('assert');
const fs = require('fs');

const PORT = 15500;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k'; process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379'; process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll'; process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'tok-ceil'; process.env.DATABASE_PATH = '/tmp/ceil.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync('/tmp/ceil.db' + s); } catch {} }

require('../src/server');
const db = require('../src/lib/db');
const { grantTime } = require('../src/lib/grant');
const realFetch = global.fetch;

const lookup = (phone) => realFetch(`http://127.0.0.1:${PORT}/api/session/lookup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone }),
}).then((r) => r.json());

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400));
  console.log('\nPurchased-time ceiling');

  await t('one hour bought means at most one hour shown', async () => {
    // Ledger far behind the router, so the grant inflates the total.
    db.upsertAccount.run({ phone: '254712000030', totalSeconds: 0, password: 'ABC234' });
    db.recordUsage.run({ phone: '254712000030', usedSeconds: 10665, isActive: 0 });
    await grantTime({ phone: '254712000030', seconds: 3600, profile: 'standard',
                      mac: null, ip: null, reason: 'hr1' });
    const s = await lookup('0712000030');
    assert.strictEqual(s.remainingSeconds, 3600,
      'inflation must not leak into the balance');
  });

  await t('a stale usage figure cannot inflate the balance', async () => {
    // Router has not reported at all: used stays 0 while total is inflated.
    db.upsertAccount.run({ phone: '254712000031', totalSeconds: 50000, password: 'BCD345' });
    db.db.prepare('UPDATE accounts SET purchased_seconds = 3600 WHERE phone = ?')
      .run('254712000031');
    const s = await lookup('0712000031');
    assert.strictEqual(s.remainingSeconds, 3600, 'capped at what was bought');
  });

  await t('two purchases add up, still capped at their sum', async () => {
    db.upsertAccount.run({ phone: '254712000032', totalSeconds: 0, password: 'CDE456' });
    await grantTime({ phone: '254712000032', seconds: 3600, profile: 'standard',
                      mac: null, ip: null, reason: 'hr1' });
    await grantTime({ phone: '254712000032', seconds: 10800, profile: 'standard',
                      mac: null, ip: null, reason: 'hr3' });
    const s = await lookup('0712000032');
    assert.strictEqual(s.remainingSeconds, 14400);
  });

  await t('router usage does not change a wall-clock subscription', async () => {
    db.recordUsage.run({ phone: '254712000032', usedSeconds: 400, isActive: 0 });
    const s = await lookup('0712000032');
    assert.strictEqual(s.remainingSeconds, 14400);
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();

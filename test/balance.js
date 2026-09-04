/* The balance a customer sees from ANY network must be honest: it has to
   keep counting down while they are online, and hold still when not. */
const assert = require('assert');
const fs = require('fs');

const PORT = 15000;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'tok-bal';
process.env.DATABASE_PATH = '/tmp/bal-test.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync('/tmp/bal-test.db' + s); } catch {} }

require('../src/server');
const db = require('../src/lib/db');
const realFetch = global.fetch;

const sync = (body) => realFetch(
  `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-bal`,
  { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
);
const lookup = (phone) => realFetch(`http://127.0.0.1:${PORT}/api/session/lookup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone }),
}).then((r) => r.json());

/** Backdate the last report so we can test drift without waiting. */
function ageReport(phone, seconds) {
  db.db.prepare(
    `UPDATE accounts SET last_seen_at = datetime('now', '-' || ? || ' seconds') WHERE phone = ?`
  ).run(seconds, phone);
}

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400));
  console.log('\nBalance accuracy from any network');

  db.upsertAccount.run({ phone: '254712000010', totalSeconds: 3600, password: 'ABC234' });

  await t('offline account reports its banked balance exactly', async () => {
    await sync('254712000010:600:3600:0\n');
    ageReport('254712000010', 60);
    const s = await lookup('0712000010');
    assert.strictEqual(s.remainingSeconds, 3000, 'offline balance must not drift');
    assert.strictEqual(s.online, false);
  });

  await t('online account keeps counting down between reports', async () => {
    await sync('254712000010:600:3600:1\n');
    ageReport('254712000010', 45);
    const s = await lookup('0712000010');
    assert.strictEqual(s.online, true);
    assert.strictEqual(s.remainingSeconds, 2955, '3000 banked minus 45s since the report');
  });

  await t('drift is capped so a silent router cannot drain a balance', async () => {
    await sync('254712000010:600:3600:1\n');
    ageReport('254712000010', 4000); // router has been quiet over an hour
    const s = await lookup('0712000010');
    assert.strictEqual(s.remainingSeconds, 2880, '3000 minus the 120s cap, not 4000');
  });

  await t('a three-field report from an old router means offline', async () => {
    // Backwards compatibility: never assume active, or an out-of-date
    // router would drain everyone's balance.
    await sync('254712000010:600:3600\n');
    ageReport('254712000010', 90);
    const s = await lookup('0712000010');
    assert.strictEqual(s.online, false);
    assert.strictEqual(s.remainingSeconds, 3000);
  });

  await t('an exhausted account reports nothing left, not a negative', async () => {
    db.upsertAccount.run({ phone: '254712000011', totalSeconds: 3600, password: 'BCD345' });
    await sync('254712000011:3600:3600:1\n');
    ageReport('254712000011', 300);
    const s = await lookup('0712000011');
    assert.strictEqual(s.found, false);
  });

  await t('balance is reachable without being on the hotspot', async () => {
    // No mac, no hotspot params - just the public endpoint, as it would be
    // over mobile data.
    const s = await lookup('0712000010');
    assert.ok(s.found, 'lookup by phone must work off-network');
    assert.ok(s.username && s.password, 'credentials returned for re-login');
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();

/* node test/devices.js - Connect your TV */
const assert = require('assert');
const fs = require('fs');

const PORT = 14100;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'passkey';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'tok-dev';
process.env.DATABASE_PATH = '/tmp/dev-test.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync('/tmp/dev-test.db' + s); } catch {} }

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const j = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('safaricom.co.ke')) {
    if (u.includes('/oauth/')) return j({ access_token: 't', expires_in: '3599' });
    if (u.includes('/stkpush/')) return j({ CheckoutRequestID: 'ws_D', MerchantRequestID: 'm', ResponseCode: '0' });
    if (u.includes('/stkpushquery/')) return j({ errorCode: '500.001.1001' });
  }
  return realFetch(url, opts);
};

require('../src/server');
const db = require('../src/lib/db');

const post = (p, body) => realFetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400));

  // give an owner some time
  db.upsertAccount.run({ phone: '254712000001', totalSeconds: 86400, password: 'ABC234' });

  console.log('\nConnect your TV');

  await t('refuses a device when the number has no time', async () => {
    const r = await post('/api/device/add', { phone: '0799000000', mac: 'AABBCCDDEEFF' });
    assert.strictEqual(r.s, 402);
  });

  await t('rejects an incomplete MAC', async () => {
    const r = await post('/api/device/add', { phone: '0712000001', mac: 'AABBCC' });
    assert.strictEqual(r.s, 400);
  });

  await t('accepts a MAC with no separators', async () => {
    const r = await post('/api/device/add', { phone: '0712000001', mac: 'AABBCCDDEE01', label: 'Samsung TV' });
    assert.strictEqual(r.s, 200);
    assert.strictEqual(r.b.mac, 'AA:BB:CC:DD:EE:01');
  });

  await t('rejects a second extra device but accepts hyphen format', async () => {
    // The first device already used the one extra slot, so this must fail
    // on the cap, not on formatting.
    const r = await post('/api/device/add', { phone: '0712000001', mac: 'AA-BB-CC-DD-EE-02', label: 'Decoder' });
    assert.strictEqual(r.s, 409, 'should hit the cap');
  });

  await t('re-adding the same device updates it rather than duplicating', async () => {
    const r0 = await post('/api/device/add', { phone: '0712000001', mac: 'AABBCCDDEE01', label: 'Living room TV' });
    assert.strictEqual(r0.s, 200, 'updating an existing device must not hit the cap');
    const r = await post('/api/device/list', { phone: '0712000001' });
    assert.strictEqual(r.b.devices.length, 1);
    assert.strictEqual(r.b.devices[0].label, 'Living room TV');
  });

  await t('allows only one extra device (phone counts as the second)', async () => {
    const r = await post('/api/device/add', { phone: '0712000001', mac: 'AABBCCDDEE03' });
    assert.strictEqual(r.s, 409, 'second extra device should be rejected');
    assert.ok(/2 devices/.test(r.b.error), 'error should explain the limit: ' + r.b.error);
    assert.ok(r.b.atLimit, 'should flag atLimit so the portal can react');
  });

  await t('refuses to steal a device owned by another number', async () => {
    db.upsertAccount.run({ phone: '254733000009', totalSeconds: 3600, password: 'XYZ345' });
    const r = await post('/api/device/add', { phone: '0733000009', mac: 'AABBCCDDEE01' });
    assert.strictEqual(r.s, 409);
  });

  await t('adding a TV queues a router login without adding time', async () => {
    const before = db.getAccount.get('254712000001').total_seconds;
    // a job with the TV mac should exist
    const jobs = db.pendingJobs.all('kitale-1');
    const tvJob = jobs.find((j) => j.mac === 'AA:BB:CC:DD:EE:01');
    assert.ok(tvJob, 'a login job for the TV should be queued');
    assert.strictEqual(db.getAccount.get('254712000001').total_seconds, before, 'balance must not change');
  });

  await t('lists a customer devices', async () => {
    const r = await post('/api/device/list', { phone: '0712000001' });
    assert.strictEqual(r.b.devices.length, 1);
    assert.strictEqual(r.b.max, 1);
  });

  await t('removing a device frees the slot again', async () => {
    await post('/api/device/remove', { phone: '0712000001', mac: 'AA:BB:CC:DD:EE:01' });
    const list = await post('/api/device/list', { phone: '0712000001' });
    assert.strictEqual(list.b.devices.length, 0);
    const r = await post('/api/device/add', { phone: '0712000001', mac: 'AABBCCDDEE09', label: 'Laptop' });
    assert.strictEqual(r.s, 200, 'slot should be free after removal');
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();

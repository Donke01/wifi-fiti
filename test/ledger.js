/* Rebuilding a balance from payment history, for when the ledger and the
   router have drifted apart. */
const assert = require('assert');
const fs = require('fs');

const PORT = 15100;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'tok-led';
process.env.ADMIN_TOKEN = 'admin-led';
process.env.DATABASE_PATH = '/tmp/led-test.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync('/tmp/led-test.db' + s); } catch {} }

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const j = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('safaricom.co.ke')) {
    if (u.includes('/oauth/')) return j({ access_token: 't', expires_in: '3599' });
    if (u.includes('/stkpush/')) return j({ CheckoutRequestID: 'ws_L' + Math.random(), MerchantRequestID: 'm', ResponseCode: '0' });
  }
  return realFetch(url, opts);
};

require('../src/server');
const db = require('../src/lib/db');

const ADMIN = { 'x-admin-token': 'admin-led' };
const get = (p, h) => realFetch(`http://127.0.0.1:${PORT}${p}`, { headers: h })
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const post = (p, b, h) => realFetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}),
  body: JSON.stringify(b || {}),
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

/** Record a paid purchase the way the callback handler would. */
function recordPurchase(phone, id, pkg, seconds, amount) {
  db.insert.run({ checkoutRequestId: id, merchantRequestId: 'm', phone,
    packageId: pkg, amount, seconds, mac: null, ip: null });
  db.markResult.run({ checkoutRequestId: id, status: 'paid', resultCode: 0,
    resultDesc: 'ok', receipt: 'R' + id });
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400));
  console.log('\nLedger repair');

  const PHONE = '254748181876';
  // Ten purchases, but a bug left the account holding only one hour -
  // exactly the production situation.
  recordPurchase(PHONE, 'tx1', 'hr1', 3600, 10);
  for (let i = 2; i <= 10; i++) recordPurchase(PHONE, 'tx' + i, 'hr3', 10800, 20);
  db.upsertAccount.run({ phone: PHONE, totalSeconds: 3600, password: 'ABC234' });
  db.recordUsage.run({ phone: PHONE, usedSeconds: 3600, isActive: 0 });

  await t('refuses without an admin token', async () => {
    const r = await get(`/api/admin/ledger/${PHONE}`);
    assert.strictEqual(r.s, 403);
  });

  await t('reports the shortfall without changing anything', async () => {
    const r = await get(`/api/admin/ledger/${PHONE}`, ADMIN);
    assert.strictEqual(r.s, 200);
    assert.strictEqual(r.b.payments, 10);
    assert.strictEqual(r.b.purchasedSeconds, 3600 + 9 * 10800);
    assert.strictEqual(r.b.previousTotal, 3600);
    assert.strictEqual(r.b.applied, false);
    assert.strictEqual(db.getAccount.get(PHONE).total_seconds, 3600, 'must not have written');
  });

  await t('rebuild restores every purchase', async () => {
    const r = await post(`/api/admin/ledger/${PHONE}/rebuild`, {}, ADMIN);
    assert.strictEqual(r.s, 200);
    assert.strictEqual(r.b.rebuiltTotal, 3600 + 9 * 10800);
    assert.strictEqual(db.getAccount.get(PHONE).total_seconds, 3600 + 9 * 10800);
  });

  await t('remaining time is now correct', async () => {
    const s = await post('/api/session/lookup', { phone: '0748181876' });
    assert.strictEqual(s.b.found, true);
    assert.strictEqual(s.b.remainingSeconds, 9 * 10800, 'purchased minus the hour used');
  });

  await t('queues the corrected total for the router', async () => {
    const jobs = db.pendingJobs.all('kitale-1');
    const job = jobs.find((j) => j.username === PHONE);
    assert.ok(job, 'no job queued');
    assert.strictEqual(job.total_seconds, 3600 + 9 * 10800);
  });

  await t('never sets a total below what was already used', async () => {
    const P2 = '254722000020';
    recordPurchase(P2, 'tz1', 'hr1', 3600, 10);
    db.upsertAccount.run({ phone: P2, totalSeconds: 0, password: 'BCD345' });
    db.recordUsage.run({ phone: P2, usedSeconds: 9999, isActive: 0 });
    const r = await post(`/api/admin/ledger/${P2}/rebuild`, {}, ADMIN);
    assert.strictEqual(r.b.rebuiltTotal, 9999, 'must not lock the customer out');
  });

  await t('is safe to run twice', async () => {
    const a = await post(`/api/admin/ledger/${PHONE}/rebuild`, {}, ADMIN);
    const b = await post(`/api/admin/ledger/${PHONE}/rebuild`, {}, ADMIN);
    assert.strictEqual(a.b.rebuiltTotal, b.b.rebuiltTotal);
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();

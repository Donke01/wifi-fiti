/* Poll-mode end to end: node test/poll.js */
const assert = require('assert');
const fs = require('fs');

const PORT = 13800;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'passkey';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'test-token-abc123';
process.env.MIKROTIK_HOTSPOT_SERVER = 'hotspot1';
process.env.MIKROTIK_HOST = '';
process.env.MIKROTIK_USER = '';
process.env.MIKROTIK_PASSWORD = '';
process.env.DATABASE_PATH = '/tmp/poll-test.db';

for (const f of ['', '-wal', '-shm']) {
  try { fs.unlinkSync('/tmp/poll-test.db' + f); } catch {}
}

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const j = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('safaricom.co.ke')) {
    if (u.includes('/oauth/')) return j({ access_token: 't', expires_in: '3599' });
    if (u.includes('/stkpush/')) return j({
      MerchantRequestID: 'm', CheckoutRequestID: 'ws_' + (global.__n = (global.__n || 0) + 1),
      ResponseCode: '0',
    });
    if (u.includes('/stkpushquery/')) return j({ errorCode: '500.001.1001' });
  }
  return realFetch(url, opts);
};

require('../src/server');

const api = (p) => realFetch(`http://127.0.0.1:${PORT}${p}`);
const json = (p, i) => realFetch(`http://127.0.0.1:${PORT}${p}`, i)
  .then(async (r) => ({ s: r.status, b: await r.json() }));

let pass = 0; const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

async function buy(phone, pkg, mac, ip) {
  const r = await json('/api/pay', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packageId: pkg, phone, mac, ip }),
  });
  const id = r.b.checkoutRequestId;
  await json('/api/mpesa/callback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Body: { stkCallback: {
      MerchantRequestID: 'm', CheckoutRequestID: id, ResultCode: 0, ResultDesc: 'ok',
      CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'R' + id }] },
    }}}),
  });
  await new Promise((r) => setTimeout(r, 300));
  return id;
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400));
  console.log('\nPoll-mode provisioning');

  await t('rejects a wrong token', async () => {
    const r = await api('/api/router/jobs?site=kitale-1&token=wrong');
    assert.strictEqual(r.status, 403);
  });

  await t('rejects an unknown site', async () => {
    const r = await api('/api/router/jobs?site=nairobi-9&token=test-token-abc123');
    assert.strictEqual(r.status, 403);
  });

  await t('rejects a token of a different length without crashing', async () => {
    const r = await api('/api/router/jobs?site=kitale-1&token=x');
    assert.strictEqual(r.status, 403);
  });

  await t('returns empty when there is no work', async () => {
    const r = await api('/api/router/jobs?site=kitale-1&token=test-token-abc123');
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.text()).trim(), '');
  });

  await t('a payment produces a collectable job', async () => {
    await buy('0748181876', 'hr3', 'AA:BB:CC:DD:EE:01', '192.168.88.254');
    const script = await (await api('/api/router/jobs?site=kitale-1&token=test-token-abc123')).text();
    assert.ok(script.includes('254748181876'), 'username missing');
    assert.ok(script.includes('limit-uptime=10800'), 'wrong duration');
    assert.ok(script.includes('mac-address=AA:BB:CC:DD:EE:01'), 'mac missing');
    assert.ok(script.includes('/ip hotspot user add'), 'no add branch');
    assert.ok(script.includes('/api/router/ack'), 'no acknowledgement');
  });

  await t('a collected job is not handed out again straight away', async () => {
    const script = await (await api('/api/router/jobs?site=kitale-1&token=test-token-abc123')).text();
    assert.strictEqual(script.trim(), '', 'job was redelivered immediately');
  });

  await t('acknowledging retires the job', async () => {
    const r = await api('/api/router/ack?site=kitale-1&token=test-token-abc123&ids=1');
    assert.strictEqual(r.status, 200);
    const h = await json('/api/health');
    assert.strictEqual(h.b.pendingJobs, 0);
  });

  await t('a top-up carries the ABSOLUTE total, not the increment', async () => {
    await new Promise((r) => setTimeout(r, 31000)); // clear the STK throttle
    await buy('0748181876', 'day1', 'AA:BB:CC:DD:EE:01', '192.168.88.254');
    const script = await (await api('/api/router/jobs?site=kitale-1&token=test-token-abc123')).text();
    // 3h already owned + 24h bought = 97200s. An increment would say 86400.
    assert.ok(script.includes('limit-uptime=97200'),
      'expected absolute total 97200, got:\n' + script);
  });

  await t('an unacknowledged job is redelivered, and is safe to replay', async () => {
    // Force the job to look stale, as if the router died mid-script.
    db.db.exec("UPDATE jobs SET delivered_at = datetime('now','-120 seconds') WHERE acked_at IS NULL");
    const a = await (await api('/api/router/jobs?site=kitale-1&token=test-token-abc123')).text();
    assert.ok(a.includes('limit-uptime=97200'), 'not redelivered');
    // Replaying sets the same total, so the customer gains nothing extra.
    const totals = [...a.matchAll(/limit-uptime=(\d+)/g)].map((m) => m[1]);
    assert.ok(totals.every((v) => v === '97200'), 'redelivery changed the total');
  });

  await t('health reports poll mode and the site', async () => {
    const h = await json('/api/health');
    assert.strictEqual(h.b.provisionMode, 'poll');
    assert.strictEqual(h.b.site, 'kitale-1');
    assert.strictEqual(h.b.tokenSet, true);
  });

  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();

const db = require('../src/lib/db');

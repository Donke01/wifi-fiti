/* node test/features.js - session, vouchers, paybill, usage */
const assert = require('assert');
const fs = require('fs');

const PORT = 13900;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'passkey';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'tok-features-123';
process.env.ADMIN_TOKEN = 'admin-secret-xyz';
process.env.DATABASE_PATH = '/tmp/feat-test.db';

for (const s of ['', '-wal', '-shm']) {
  try { fs.unlinkSync('/tmp/feat-test.db' + s); } catch {}
}

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const j = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('safaricom.co.ke')) {
    if (u.includes('/oauth/')) return j({ access_token: 't', expires_in: '3599' });
    if (u.includes('/stkpush/')) return j({ CheckoutRequestID: 'ws_F', MerchantRequestID: 'm', ResponseCode: '0' });
    if (u.includes('/stkpushquery/')) return j({ errorCode: '500.001.1001' });
  }
  return realFetch(url, opts);
};

require('../src/server');
const db = require('../src/lib/db');

const get = (p, h) => realFetch(`http://127.0.0.1:${PORT}${p}`, { headers: h })
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const post = (p, body, headers) => realFetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: JSON.stringify(body),
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400));

  console.log('\nVouchers');

  let code;

  await t('admin endpoint refuses a wrong token', async () => {
    const r = await post('/api/admin/vouchers', { packageId: 'hr3', count: 1 },
      { 'x-admin-token': 'nope' });
    assert.strictEqual(r.s, 403);
  });

  await t('admin endpoint refuses no token at all', async () => {
    const r = await post('/api/admin/vouchers', { packageId: 'hr3', count: 1 });
    assert.strictEqual(r.s, 403);
  });

  await t('generates a batch of codes', async () => {
    const r = await post('/api/admin/vouchers', { packageId: 'hr3', count: 3 },
      { 'x-admin-token': 'admin-secret-xyz' });
    assert.strictEqual(r.s, 200);
    assert.strictEqual(r.b.codes.length, 3);
    assert.ok(r.b.codes.every((c) => /^FITI[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(c)),
      'codes should avoid look-alike characters: ' + r.b.codes.join(','));
    code = r.b.codes[0];
  });

  await t('rejects an unknown code', async () => {
    const r = await post('/api/voucher/redeem', { code: 'FITINOTREAL9', phone: '0712345678' });
    assert.strictEqual(r.s, 404);
  });

  await t('redeems a valid code', async () => {
    const r = await post('/api/voucher/redeem',
      { code, phone: '0722000001', mac: 'AA:BB:CC:DD:EE:11' });
    assert.strictEqual(r.s, 200);
    assert.strictEqual(r.b.username, '254722000001');
    assert.strictEqual(r.b.grantedSeconds, 10800);
  });

  await t('refuses to redeem the same code twice', async () => {
    const r = await post('/api/voucher/redeem', { code, phone: '0733000002' });
    assert.strictEqual(r.s, 409);
  });

  await t('two racing redemptions cannot both win', async () => {
    const r = await post('/api/admin/vouchers', { packageId: 'day1', count: 1 },
      { 'x-admin-token': 'admin-secret-xyz' });
    const c = r.b.codes[0];
    const [a, b] = await Promise.all([
      post('/api/voucher/redeem', { code: c, phone: '0744000003' }),
      post('/api/voucher/redeem', { code: c, phone: '0755000004' }),
    ]);
    const wins = [a, b].filter((x) => x.s === 200).length;
    assert.strictEqual(wins, 1, `expected exactly one winner, got ${wins}`);
  });

  console.log('\nSession recognition');

  await t('recognises a returning device by MAC', async () => {
    const r = await get('/api/session?mac=AA:BB:CC:DD:EE:11');
    assert.strictEqual(r.b.found, true);
    assert.strictEqual(r.b.username, '254722000001');
    assert.ok(r.b.remainingSeconds > 0);
  });

  await t('does not recognise an unknown device', async () => {
    const r = await get('/api/session?mac=FF:FF:FF:FF:FF:FF');
    assert.strictEqual(r.b.found, false);
  });

  await t('ignores a malformed MAC rather than erroring', async () => {
    const r = await get('/api/session?mac=notamac');
    assert.strictEqual(r.s, 200);
    assert.strictEqual(r.b.found, false);
  });

  await t('finds an account by phone number', async () => {
    const r = await post('/api/session/lookup', { phone: '0722000001' });
    assert.strictEqual(r.b.found, true);
    assert.strictEqual(r.b.remainingSeconds, 10800);
  });

  await t('reports nothing for a phone with no balance', async () => {
    const r = await post('/api/session/lookup', { phone: '0799999999' });
    assert.strictEqual(r.b.found, false);
  });

  console.log('\nUsage reporting');

  await t('records usage from the router and reduces remaining time', async () => {
    const body = '254722000001:3600:10800\n';
    const r = await realFetch(
      `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-features-123`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }
    );
    assert.strictEqual(r.status, 200);
    const s = await post('/api/session/lookup', { phone: '0722000001' });
    assert.strictEqual(s.b.remainingSeconds, 7200, 'should be 10800 - 3600');
  });

  await t('sync ignores junk lines without failing', async () => {
    const body = 'garbage\n:::\n254722000001:notanumber\n999:5:5\n';
    const r = await realFetch(
      `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-features-123`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }
    );
    assert.strictEqual(r.status, 200);
    const s = await post('/api/session/lookup', { phone: '0722000001' });
    assert.strictEqual(s.b.remainingSeconds, 7200, 'junk should not have altered usage');
  });

  await t('accepts the urlencoded content-type RouterOS actually sends', async () => {
    // Regression: RouterOS /tool fetch posts as x-www-form-urlencoded.
    // urlencoded() used to claim the body first and hand back a
    // null-prototype object, making String(req.body) throw and every
    // sync return 500.
    // Use a fresh account: an earlier test already drove this one's usage
    // up, and reporting a LOWER figure here would look like a counter
    // reset and trigger the balance adjustment, which is not what this
    // test is about.
    db.upsertAccount.run({ phone: '254733000077', totalSeconds: 10800, password: 'ABC234' });

    const r = await realFetch(
      `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-features-123`,
      { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '254733000077:1800:10800\n' }
    );
    assert.strictEqual(r.status, 200, 'urlencoded sync must not 500');
    const s = await post('/api/session/lookup', { phone: '0733000077' });
    assert.strictEqual(s.b.remainingSeconds, 9000, 'usage should have been recorded');
  });

  await t('survives a completely empty body', async () => {
    const r = await realFetch(
      `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-features-123`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' }
    );
    assert.strictEqual(r.status, 200);
  });

  await t('sync rejects a bad token', async () => {
    const r = await realFetch(
      `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=wrong`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' }
    );
    assert.strictEqual(r.status, 403);
  });

  await t('a fully used account reports no time left', async () => {
    await realFetch(
      `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-features-123`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: '254722000001:10800:10800\n' }
    );
    const s = await post('/api/session/lookup', { phone: '0722000001' });
    assert.strictEqual(s.b.found, false, 'exhausted account should not look active');
  });

  console.log('\nPaybill fallback');

  await t('credits a C2B payment to the account in BillRefNumber', async () => {
    await post('/api/mpesa/c2b/confirmation', {
      TransID: 'RGH12345', TransAmount: '50', BillRefNumber: '0766000005', MSISDN: '254766000005',
    });
    await new Promise((r) => setTimeout(r, 400));
    const s = await post('/api/session/lookup', { phone: '0766000005' });
    assert.strictEqual(s.b.found, true);
    assert.strictEqual(s.b.remainingSeconds, 86400, '50 bob should buy the 24h package');
  });

  await t('picks the best package the amount covers, not the first', async () => {
    await post('/api/mpesa/c2b/confirmation', {
      TransID: 'RGH99999', TransAmount: '130', BillRefNumber: '0777000006',
    });
    await new Promise((r) => setTimeout(r, 400));
    const s = await post('/api/session/lookup', { phone: '0777000006' });
    // 130 covers the 120/= three-day package but not the 250/= week.
    assert.strictEqual(s.b.remainingSeconds, 3 * 24 * 3600);
  });

  await t('grants nothing when the amount is below every package', async () => {
    await post('/api/mpesa/c2b/confirmation', {
      TransID: 'RGH00001', TransAmount: '5', BillRefNumber: '0788000007',
    });
    await new Promise((r) => setTimeout(r, 300));
    const s = await post('/api/session/lookup', { phone: '0788000007' });
    assert.strictEqual(s.b.found, false);
  });

  await t('config exposes the shortcode for the paybill screen', async () => {
    const r = await get('/api/config');
    assert.strictEqual(r.b.shortcode, '174379');
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();

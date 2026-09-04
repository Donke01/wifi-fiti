/* End-to-end: node test/e2e.js
 * Boots the real server against a mock router and a faked Daraja. */
const assert = require('assert');
const fs = require('fs');

const PORT = 13000;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`;
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.PROVISION_MODE = 'api';
process.env.SITE_TOKEN = '';
process.env.MPESA_PASSKEY = 'passkey';
process.env.MIKROTIK_HOST = '127.0.0.1';
process.env.MIKROTIK_PORT = '18729';
process.env.MIKROTIK_USER = 'test';
process.env.MIKROTIK_PASSWORD = 'test';
process.env.DATABASE_PATH = '/tmp/hotspot-e2e.db';
process.env.BRAND_NAME = 'WiFi Fiti';

try { fs.unlinkSync('/tmp/hotspot-e2e.db'); } catch {}
try { fs.unlinkSync('/tmp/hotspot-e2e.db-wal'); } catch {}
try { fs.unlinkSync('/tmp/hotspot-e2e.db-shm'); } catch {}

/* ---- fake Daraja ------------------------------------------------- */
const darajaCalls = [];
const realFetch = global.fetch;

global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes('safaricom.co.ke')) {
    darajaCalls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });

    if (u.includes('/oauth/')) {
      return jsonRes({ access_token: 'fake-token', expires_in: '3599' });
    }
    if (u.includes('/stkpush/')) {
      return jsonRes({
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_TEST_001',
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing',
      });
    }
    if (u.includes('/stkpushquery/')) {
      return jsonRes({ errorCode: '500.001.1001', errorMessage: 'processing' });
    }
  }
  return realFetch(url, opts);
};

function jsonRes(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

/* ---- boot ---------------------------------------------------------- */
const { startMockRouter } = require('./mock-router');

let pass = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}

const api = (path, init) =>
  realFetch(`http://127.0.0.1:${PORT}${path}`, init).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

(async function main() {
  const mock = await startMockRouter(18729);
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));

  console.log('\nEnd-to-end payment flow');

  await t('portal loads the tariff', async () => {
    const r = await api('/api/config');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.brandName, 'WiFi Fiti');
    assert.strictEqual(r.body.testMode, undefined, 'test-mode badge was removed');
    assert.strictEqual(r.body.packages.length, 5);
    assert.strictEqual(r.body.shortcode, '174379', 'portal needs this for the paybill screen');
    const prices = Object.fromEntries(r.body.packages.map((p) => [p.id, p.price]));
    assert.deepStrictEqual(prices, { hr1: 10, hr3: 20, day1: 50, day3: 120, wk1: 400 });
    assert.ok(r.body.packages.every((p) => p.price > 0));
  });

  await t('rejects a malformed phone number before calling Daraja', async () => {
    const before = darajaCalls.length;
    const r = await api('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'day1', phone: '12345' }),
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(darajaCalls.length, before, 'should not have hit Daraja');
  });

  await t('rejects an unknown package', async () => {
    const r = await api('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'free-forever', phone: '0712345678' }),
    });
    assert.strictEqual(r.status, 400);
  });

  await t('initiates an STK push with a correctly built payload', async () => {
    const r = await api('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'day1',
        phone: '0712 345 678',
        mac: 'AA:BB:CC:DD:EE:01',
        ip: '10.5.50.42',
      }),
    });

    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.checkoutRequestId, 'ws_CO_TEST_001');
    assert.strictEqual(r.body.amount, 50);
    assert.strictEqual(r.body.phoneDisplay, '0712 345 678');

    const push = darajaCalls.filter((c) => c.url.includes('/stkpush/')).pop();
    assert.strictEqual(push.body.PhoneNumber, '254712345678');
    assert.strictEqual(push.body.PartyA, '254712345678');
    assert.strictEqual(push.body.Amount, 50);
    assert.strictEqual(push.body.BusinessShortCode, '174379');
    assert.ok(/^\d{14}$/.test(push.body.Timestamp), 'timestamp must be 14 digits');
    assert.ok(
      push.body.CallBackURL.endsWith('/api/mpesa/callback'),
      'callback URL must be absolute and public'
    );

    const expectedPw = Buffer.from(
      `174379passkey${push.body.Timestamp}`
    ).toString('base64');
    assert.strictEqual(push.body.Password, expectedPw, 'password digest wrong');
  });

  await t('status is pending before the callback arrives', async () => {
    const r = await api('/api/status/ws_CO_TEST_001');
    assert.strictEqual(r.body.status, 'pending');
    assert.strictEqual(r.body.password, undefined);
  });

  await t('throttles a second push to the same number', async () => {
    const r = await api('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'hr3', phone: '0712345678' }),
    });
    assert.strictEqual(r.status, 429);
  });

  await t('acknowledges the callback immediately with ResultCode 0', async () => {
    const r = await api('/api/mpesa/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Body: { stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_TEST_001',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: { Item: [
            { Name: 'Amount', Value: 50 },
            { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
            { Name: 'TransactionDate', Value: 20260829102115 },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ]},
        }},
      }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ResultCode, 0);
  });

  await t('provisions the user on the router', async () => {
    await new Promise((r) => setTimeout(r, 600));
    const u = mock.users.get('254712345678');
    assert.ok(u, 'user was never created on the router');
    assert.strictEqual(u['limit-uptime'], '86400');
  });

  await t('status now returns working credentials', async () => {
    const r = await api('/api/status/ws_CO_TEST_001');
    assert.strictEqual(r.body.status, 'paid');
    assert.strictEqual(r.body.username, '254712345678');
    assert.strictEqual(r.body.receipt, 'NLJ7RT61SV');
    assert.ok(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(r.body.password),
      `password "${r.body.password}" should avoid look-alike characters`);
  });

  await t('the device was auto-logged-in by MAC', async () => {
    const login = mock.log.filter((l) => l.cmd === '/ip/hotspot/active/login').pop();
    assert.ok(login, 'no login call was made');
    assert.ok(login.args.includes('=mac-address=AA:BB:CC:DD:EE:01'));
    assert.ok(login.args.includes('=ip=10.5.50.42'));
  });

  await t('a replayed callback does not grant a second helping of time', async () => {
    const before = mock.users.get('254712345678')['limit-uptime'];

    await api('/api/mpesa/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Body: { stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_TEST_001',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: { Item: [
            { Name: 'Amount', Value: 50 },
            { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
          ]},
        }},
      }),
    });

    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(
      mock.users.get('254712345678')['limit-uptime'], before,
      'replay granted extra time - customers would get free internet'
    );
  });

  await t('a cancelled payment reports a human-readable reason', async () => {
    const db = require('../src/lib/db');
    db.insert.run({
      checkoutRequestId: 'ws_CO_TEST_002', merchantRequestId: 'm2',
      phone: '254722000000', packageId: 'hr3', amount: 20,
      seconds: 10800, mac: null, ip: null,
    });

    await api('/api/mpesa/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Body: { stkCallback: {
          MerchantRequestID: 'm2', CheckoutRequestID: 'ws_CO_TEST_002',
          ResultCode: 1032, ResultDesc: 'Request cancelled by user',
        }},
      }),
    });

    await new Promise((r) => setTimeout(r, 400));
    const r = await api('/api/status/ws_CO_TEST_002');
    assert.strictEqual(r.body.status, 'failed');
    assert.match(r.body.reason, /cancelled/i);
    assert.ok(!mock.users.has('254722000000'), 'must not provision on failure');
  });

  await t('health check reports the router', async () => {
    const r = await api('/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.router.board, 'hAP lite');
  });

  mock.server.close();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();

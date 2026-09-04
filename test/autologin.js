/* The portal must not report success until the router has actually
   created the account, or auto sign-in fails and the customer has to
   press a button themselves. */
const assert = require('assert');
const fs = require('fs');

const PORT = 15400;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'tok-auto';
process.env.DATABASE_PATH = '/tmp/auto-test.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync('/tmp/auto-test.db' + s); } catch {} }

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const j = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('safaricom.co.ke')) {
    if (u.includes('/oauth/')) return j({ access_token: 't', expires_in: '3599' });
    if (u.includes('/stkpush/')) return j({ CheckoutRequestID: 'ws_AUTO', MerchantRequestID: 'm', ResponseCode: '0' });
  }
  return realFetch(url, opts);
};

require('../src/server');
const db = require('../src/lib/db');

const post = (p, b) => realFetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const get = (p) => realFetch(`http://127.0.0.1:${PORT}${p}`)
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const sync = (ack) => realFetch(
  `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-auto` + (ack ? `&ack=${ack}` : ''),
  { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' }
).then((r) => r.text());

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400));
  console.log('\nAuto sign-in timing');

  await post('/api/pay', { packageId: 'hr1', phone: '0748181876', mac: 'AA:BB:CC:DD:EE:01' });
  await post('/api/mpesa/callback', { Body: { stkCallback: {
    MerchantRequestID: 'm', CheckoutRequestID: 'ws_AUTO', ResultCode: 0, ResultDesc: 'ok',
    CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'RA1' }] } } } });
  await new Promise((r) => setTimeout(r, 400));

  await t('holds at pending while the router has not applied the job', async () => {
    const r = await get('/api/status/ws_AUTO');
    assert.strictEqual(r.b.status, 'pending', 'must not claim success yet');
    assert.strictEqual(r.b.awaitingRouter, true, 'should say why it is waiting');
    assert.strictEqual(r.b.password, undefined, 'credentials must not leak early');
  });

  let ids;
  await t('router collects the job', async () => {
    const script = await sync();
    assert.ok(script.includes('254748181876'));
    const m = script.match(/:global fitiAck "([^"]*)"/);
    ids = m && m[1];
    assert.ok(ids, 'no ack ids');
  });

  await t('still pending until the router confirms', async () => {
    const r = await get('/api/status/ws_AUTO');
    assert.strictEqual(r.b.status, 'pending', 'delivery is not confirmation');
  });

  await t('reports success once the router acknowledges', async () => {
    await sync(ids);
    const r = await get('/api/status/ws_AUTO');
    assert.strictEqual(r.b.status, 'paid');
    assert.ok(r.b.username && r.b.password, 'credentials should now be released');
    assert.ok(r.b.remainingSeconds > 0);
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();

const PORT = 13500;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'http://127.0.0.1:' + PORT;
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.PROVISION_MODE = 'api';
process.env.MPESA_PASSKEY = 'passkey';
process.env.DATABASE_PATH = '/tmp/dryrun.db';
// Set empty rather than delete: config.js loads dotenv, and dotenv will
// happily repopulate a deleted variable from a real .env file, silently
// turning this into a different test. dotenv never overwrites a variable
// that already exists, so "" survives.
process.env.MIKROTIK_HOST = '';
process.env.MIKROTIK_USER = '';
process.env.MIKROTIK_PASSWORD = '';

const fs = require('fs');
for (const f of ['/tmp/dryrun.db','/tmp/dryrun.db-wal','/tmp/dryrun.db-shm']) { try{fs.unlinkSync(f)}catch{} }

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const j = (o) => ({ ok:true, status:200, json:async()=>o, text:async()=>JSON.stringify(o) });
  if (u.includes('safaricom.co.ke')) {
    if (u.includes('/oauth/')) return j({ access_token:'t', expires_in:'3599' });
    if (u.includes('/stkpush/')) return j({ MerchantRequestID:'m1', CheckoutRequestID:'ws_CO_DRY', ResponseCode:'0' });
    if (u.includes('/stkpushquery/')) return j({ errorCode:'500.001.1001' });
  }
  return realFetch(url, opts);
};

require('../src/server');
const api = (p, i) => realFetch('http://127.0.0.1:'+PORT+p, i).then(async r => ({s:r.status, b:await r.json()}));

setTimeout(async () => {
  const assert = require('assert');
  let ok = 0;

  const h = await api('/api/health');
  assert.strictEqual(h.b.router.configured, false);
  console.log('  ok   health reports router not configured'); ok++;

  const pay = await api('/api/pay', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ packageId:'day1', phone:'0712345678' }) });
  assert.strictEqual(pay.s, 200);
  console.log('  ok   STK push still works with no router'); ok++;

  await api('/api/mpesa/callback', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ Body:{ stkCallback:{ MerchantRequestID:'m1', CheckoutRequestID:'ws_CO_DRY',
      ResultCode:0, ResultDesc:'ok', CallbackMetadata:{ Item:[
        {Name:'Amount',Value:50},{Name:'MpesaReceiptNumber',Value:'NLJ7RT61SV'}]}}}}) });

  await new Promise(r => setTimeout(r, 500));
  const st = await api('/api/status/ws_CO_DRY');
  assert.strictEqual(st.b.status, 'paid');
  assert.ok(st.b.username && st.b.password);
  console.log('  ok   payment completes end to end, credentials issued'); ok++;
  console.log('\n' + ok + ' passed');
  process.exit(0);
}, 500);

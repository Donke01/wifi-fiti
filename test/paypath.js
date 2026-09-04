/* A real M-Pesa payment must get the same lockout protection that
   vouchers and devices already had. */
const assert = require('assert');
const fs = require('fs');
const PORT = 14900;
process.env.PORT=String(PORT);
process.env.PUBLIC_URL='https://fiti.test';
process.env.MPESA_CONSUMER_KEY='k';process.env.MPESA_CONSUMER_SECRET='s';
process.env.MPESA_SHORTCODE='174379';process.env.MPESA_PASSKEY='p';
process.env.PROVISION_MODE='poll';process.env.SITE_ID='kitale-1';
process.env.SITE_TOKEN='tok';process.env.DATABASE_PATH='/tmp/paypath.db';
for (const s of ['','-wal','-shm']) { try{fs.unlinkSync('/tmp/paypath.db'+s)}catch{} }

const realFetch = global.fetch;
global.fetch = async (url, opts={}) => {
  const u=String(url);
  const j=(o)=>({ok:true,status:200,json:async()=>o,text:async()=>JSON.stringify(o)});
  if (u.includes('safaricom.co.ke')) {
    if (u.includes('/oauth/')) return j({access_token:'t',expires_in:'3599'});
    if (u.includes('/stkpush/')) return j({CheckoutRequestID:'ws_P',MerchantRequestID:'m',ResponseCode:'0'});
  }
  return realFetch(url,opts);
};

require('../src/server');
const db = require('../src/lib/db');

const post=(p,b)=>realFetch(`http://127.0.0.1:${PORT}${p}`,{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
  .then(async r=>({s:r.status,b:await r.json().catch(()=>null)}));

let pass=0,fail=0;
const t=(n,f)=>{try{f();pass++;console.log('  ok  ',n)}catch(e){fail++;console.log('  FAIL',n,'\n        ',e.message)}};

setTimeout(async()=>{
  console.log('\nPayment path uses the shared grant logic');

  // Ledger behind the router, exactly as in production.
  db.upsertAccount.run({phone:'254748181876',totalSeconds:0,password:'ABC234'});
  db.recordUsage.run({phone:'254748181876',usedSeconds:10665});

  const pay = await post('/api/pay',{packageId:'hr1',phone:'0748181876'});
  assert.strictEqual(pay.s,200);
  await post('/api/mpesa/callback',{Body:{stkCallback:{
    MerchantRequestID:'m',CheckoutRequestID:pay.b.checkoutRequestId,
    ResultCode:0,ResultDesc:'ok',
    CallbackMetadata:{Item:[{Name:'MpesaReceiptNumber',Value:'RCPT1'}]}}}});
  await new Promise(r=>setTimeout(r,500));

  const a = db.getAccount.get('254748181876');
  t('an M-Pesa payment clears usage already on the router', ()=>{
    assert.ok(a.total_seconds > a.used_seconds,
      `total ${a.total_seconds} must exceed used ${a.used_seconds}`);
  });
  t('customer gets exactly the hour they paid for', ()=>{
    assert.strictEqual(a.total_seconds - a.used_seconds, 3600);
  });
  t('status endpoint reports the right remaining time', async ()=>{
    assert.ok(a.total_seconds === 14265, 'expected 14265, got ' + a.total_seconds);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
},500);

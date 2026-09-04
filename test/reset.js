/* A router counter reset must not inflate a customer's remaining time. */
const assert = require('assert'); const fs = require('fs');
const PORT = 15500;
process.env.PORT=String(PORT);process.env.PUBLIC_URL='https://fiti.test';
process.env.MPESA_CONSUMER_KEY='k';process.env.MPESA_CONSUMER_SECRET='s';
process.env.MPESA_SHORTCODE='174379';process.env.MPESA_PASSKEY='p';
process.env.PROVISION_MODE='poll';process.env.SITE_ID='kitale-1';
process.env.SITE_TOKEN='tok-r';process.env.DATABASE_PATH='/tmp/reset.db';
for (const s of ['','-wal','-shm']) { try{fs.unlinkSync('/tmp/reset.db'+s)}catch{} }
require('../src/server');
const db=require('../src/lib/db');
const f=global.fetch;
const sync=(b)=>f(`http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-r`,
  {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b});
const look=(p)=>f(`http://127.0.0.1:${PORT}/api/session/lookup`,{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p})}).then(r=>r.json());
let pass=0,fail=0;
const t=(n,fn)=>{try{fn();pass++;console.log('  ok  ',n)}catch(e){fail++;console.log('  FAIL',n,'\n        ',e.message)}};
setTimeout(async()=>{
  console.log('\nRouter counter reset');
  db.upsertAccount.run({phone:'254712000030',totalSeconds:14265,password:'ABC234'});
  await sync('254712000030:10665:14265:0\n');
  const before = await look('0712000030');
  t('remaining is correct before the reset', ()=>{
    assert.strictEqual(before.remainingSeconds, 3600);
  });
  // Someone runs /ip hotspot user reset-counters
  await sync('254712000030:0:14265:0\n');
  const after = await look('0712000030');
  t('remaining is unchanged after a counter reset', ()=>{
    assert.strictEqual(after.remainingSeconds, 3600,
      'reset inflated the balance to ' + after.remainingSeconds);
  });
  t('total was pulled down to match', ()=>{
    assert.strictEqual(db.getAccount.get('254712000030').total_seconds, 3600);
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
},500);

/* Regression: a customer whose router usage exceeds our ledger must still
   get the time they paid for, not an instant lockout. */
const assert = require('assert');
const fs = require('fs');
const PORT = 14700;
process.env.PORT=String(PORT);
process.env.PUBLIC_URL='https://fiti.test';
process.env.MPESA_CONSUMER_KEY='k';process.env.MPESA_CONSUMER_SECRET='s';
process.env.MPESA_SHORTCODE='174379';process.env.MPESA_PASSKEY='p';
process.env.PROVISION_MODE='poll';process.env.SITE_ID='kitale-1';
process.env.SITE_TOKEN='tok';process.env.DATABASE_PATH='/tmp/lockout.db';
for (const s of ['','-wal','-shm']) { try{fs.unlinkSync('/tmp/lockout.db'+s)}catch{} }

require('../src/server');
const db = require('../src/lib/db');
const { grantTime } = require('../src/lib/grant');

let pass=0, fail=0;
const t=(n,f)=>{try{f();pass++;console.log('  ok  ',n)}catch(e){fail++;console.log('  FAIL',n,'\n        ',e.message)}};

setTimeout(async () => {
  console.log('\nLedger-behind-router lockout');

  // Exactly Don's situation: router has logged 2h57m45s of use, but our
  // ledger is empty because it predates the accounts table.
  db.upsertAccount.run({ phone:'254748181876', totalSeconds:0, password:'ABC234' });
  db.recordUsage.run({ phone:'254748181876', usedSeconds:10665, isActive:0 });

  await grantTime({ phone:'254748181876', seconds:3600, profile:'standard',
                    mac:null, ip:null, reason:'hr1 test' });

  const acct = db.getAccount.get('254748181876');
  t('grant clears the usage already on the router', () => {
    assert.ok(acct.total_seconds > acct.used_seconds,
      `total ${acct.total_seconds} must exceed used ${acct.used_seconds}`);
  });
  t('customer gets exactly the hour they paid for', () => {
    assert.strictEqual(acct.total_seconds - acct.used_seconds, 3600);
  });
  t('the queued job carries the corrected total', () => {
    const job = db.pendingJobs.all('kitale-1').pop();
    assert.strictEqual(job.total_seconds, 14265);
  });

  // And the ordinary case must be unaffected.
  db.upsertAccount.run({ phone:'254722000002', totalSeconds:10800, password:'BCD345' });
  db.recordUsage.run({ phone:'254722000002', usedSeconds:600, isActive:0 });
  await grantTime({ phone:'254722000002', seconds:3600, profile:'standard',
                    mac:null, ip:null, reason:'topup' });
  t('a normal top-up still just adds to the ledger', () => {
    assert.strictEqual(db.getAccount.get('254722000002').total_seconds, 14400);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
}, 500);

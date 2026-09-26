/* The 7-day trial is free: SMS without purchased credits, up to the trial allowance. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = '/tmp/fiti-trial-free-test.sqlite';
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(path + suffix); } catch (_) {} }
Object.assign(process.env, { PUBLIC_URL: 'https://fiti.test', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's',
  MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p', DATABASE_PATH: path });

const { db } = require('../src/lib/db');
const add = (id, status, expires) => db.prepare(`INSERT INTO businesses (id,name,owner_name,owner_phone,email,password_hash,billing_status,billing_expires_at)
  VALUES (?,?,?,?,?,?,?,?)`).run(id, id, 'Owner', '+254700000000', `${id}@example.com`, 'hash', status, expires);
add('on-trial', 'trial', "2999-01-01 00:00:00");
add('trial-ended', 'trial', "2000-01-01 00:00:00");
const signal = require('../src/lib/fiti-signal');
const send = (business, n) => signal.enqueue({ businessId: business, eventId: `e-${business}-${n}`, serviceKey: 'payment_confirmation',
  to: '254712345678', message: 'Payment received. Your package is active.' });

(async () => {
  assert.strictEqual(signal.balance('on-trial').credits_available, 0);
  const first = send('on-trial', 1);
  assert.strictEqual(first.status, 'queued', 'a trial tenant sends without buying credits');
  assert.strictEqual(first.trial, 1);
  const sent = await signal.processQueue(signal.createProvider(async () => ({ id: 'p1' })));
  assert.strictEqual(sent[0].status, 'sent');
  const account = signal.balance('on-trial');
  assert.strictEqual(account.credits_available, 0); assert.strictEqual(account.credits_reserved, 0, 'purchased credits are never touched');
  for (let i = 2; i <= 300; i += 1) assert.strictEqual(send('on-trial', i).status, 'queued');
  assert.strictEqual(send('on-trial', 301).reason, 'insufficient-credits', 'the free allowance is 300 SMS');
  assert.strictEqual(send('trial-ended', 1).reason, 'insufficient-credits', 'after the trial, SMS needs credits');
  console.log('Trial: free SMS within the allowance, purchased credits untouched, credits required after the trial - passed');
})().catch((error) => { console.error(error); process.exit(1); });

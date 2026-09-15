/* FitiSignal is deliberately tested without a provider or router. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = '/tmp/fiti-signal-test.sqlite';
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(path + suffix); } catch (_) {} }
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'test-key';
process.env.MPESA_CONSUMER_SECRET = 'test-secret';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'test-passkey';
process.env.DATABASE_PATH = path;

const { db } = require('../src/lib/db');
db.prepare(`INSERT INTO businesses (id,name,owner_name,owner_phone,email,password_hash) VALUES (?,?,?,?,?,?)`)
  .run('signal-test', 'Signal Test', 'Owner', '+254700000000', 'signal-test@example.com', 'hash');
const signal = require('../src/lib/fiti-signal');

assert.deepStrictEqual(signal.packages().map((row) => row.amount), [500, 700, 1000, 2000]);
assert.strictEqual(signal.segmentCount('a'.repeat(160)), 1);
assert.strictEqual(signal.segmentCount('a'.repeat(161)), 2);
assert.strictEqual(signal.phone('254712345678'), '+254712345678');

const purchase = signal.createPurchase({ businessId: 'signal-test', packageId: 'sms-500' });
signal.completePurchase({ purchaseId: purchase.id, paymentRef: 'PAY-1' });
assert.strictEqual(signal.balance('signal-test').credits_available, 500);
assert.strictEqual(signal.completePurchase({ purchaseId: purchase.id, paymentRef: 'PAY-1' }).duplicate, true);

const queued = signal.enqueue({
  businessId: 'signal-test', eventId: 'payment-1', serviceKey: 'payment_confirmation',
  to: '254712345678', message: 'Payment received. Your package is active.',
});
assert.strictEqual(queued.status, 'queued');
assert.strictEqual(signal.enqueue({
  businessId: 'signal-test', eventId: 'payment-1', serviceKey: 'payment_confirmation',
  to: '254712345678', message: 'duplicate',
}).duplicate, true);

(async () => {
  const sent = await signal.processQueue(signal.createProvider(async () => ({ id: 'provider-1' })));
  assert.strictEqual(sent[0].status, 'sent');
  assert.strictEqual(signal.balance('signal-test').credits_used, 1);

  signal.setSettings('signal-test', { dailyLimit: 1 });
  const blocked = signal.enqueue({
    businessId: 'signal-test', eventId: 'payment-2', serviceKey: 'payment_confirmation',
    to: '254712345678', message: 'another message',
  });
  assert.strictEqual(blocked.reason, 'daily-limit');

  const failedPurchase = signal.createPurchase({ businessId: 'signal-test', amount: 1 });
  signal.completePurchase({ purchaseId: failedPurchase.id, paymentRef: 'PAY-2' });
  signal.setSettings('signal-test', { dailyLimit: null });
  signal.enqueue({ businessId: 'signal-test', eventId: 'fail-1', serviceKey: 'receipt_link', to: '254712345678', message: 'Receipt' });
  await signal.processQueue(signal.createProvider(async () => { throw new Error('provider unavailable'); }));
  const afterFailure = signal.balance('signal-test');
  assert.strictEqual(afterFailure.credits_reserved, 0);
  assert.strictEqual(afterFailure.credits_available, 500);
  console.log('FitiSignal: package credits, deduplication, limits, queue and refund tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

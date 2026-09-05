/*
 * Tenant core is deliberately tested without HTTP, M-Pesa, or a router.
 * That makes the important commercial boundary cheap to verify: a location
 * can only see its own packages, subscriptions, jobs, and router secret.
 */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_TOKEN = 'tenant-test-token';
process.env.TENANT_SECRETS_KEY = 'tenant-test-storage-key';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-tenant-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
const tenant = require('../src/lib/tenant');

function addBusiness(id, name, email) {
  legacy.addBusiness.run({
    id,
    name,
    ownerName: 'Test Owner',
    ownerPhone: '254700000000',
    email,
    passwordHash: 'not-a-real-password',
    plan: 'starter',
    collectionMode: 'fiti',
  });
}

function addPaidTransaction({ checkoutRequestId, businessId, locationId, packageId, packageName, amount, seconds, phone, mac }) {
  tenant.insertTransaction.run({
    checkoutRequestId,
    merchantRequestId: `merchant-${checkoutRequestId}`,
    businessId,
    locationId,
    phone,
    packageId,
    packageName,
    amount,
    seconds,
    mac,
    ip: '10.5.50.20',
  });
  tenant.setTransactionResult.run({
    checkoutRequestId,
    status: 'paid',
    resultCode: 0,
    resultDesc: 'Accepted',
    receipt: `RCPT-${checkoutRequestId}`,
  });
  return tenant.getTransaction.get(checkoutRequestId);
}

(function () {
  addBusiness('business-a', 'Alpha Internet', 'alpha@example.test');
  addBusiness('business-b', 'Bravo Internet', 'bravo@example.test');

  const alpha = tenant.createLocation({
    id: 'location-alpha', businessId: 'business-a', name: 'Alpha Main', routerName: 'hAP lite',
  });
  const bravo = tenant.createLocation({
    id: 'location-bravo', businessId: 'business-b', name: 'Bravo Main', routerName: 'RB951Ui',
  });

  // Router pairing secrets are given to the business once. The database only
  // retains a SHA-256 hash, and a token for one location never pairs another.
  const stored = legacy.db.prepare(
    'SELECT router_token, router_token_hash FROM locations WHERE id = ?'
  ).get(alpha.id);
  assert.notStrictEqual(stored.router_token, alpha.routerToken, 'raw router secret must not be stored');
  assert.strictEqual(stored.router_token_hash, tenant.tokenHash(alpha.routerToken));
  assert.notStrictEqual(stored.router_token_hash, alpha.routerToken);
  assert.strictEqual(Object.hasOwn(tenant.locationById.get(alpha.id), 'router_token'), false);
  assert.strictEqual(tenant.authenticateRouter(alpha.id, 'wrong-token'), null);
  assert.strictEqual(tenant.authenticateRouter(bravo.id, alpha.routerToken), null);
  assert.strictEqual(tenant.authenticateRouter(alpha.id, alpha.routerToken).business_id, 'business-a');
  const paired = tenant.locationById.get(alpha.id);
  assert.strictEqual(paired.router_status, 'online');
  assert.ok(paired.last_seen_at, 'successful pairing should record router health');

  const alphaPackageId = legacy.addBusinessPackage.run({
    businessId: 'business-a', name: 'Ten minutes', price: 10, seconds: 600,
  }).lastInsertRowid;
  const bravoPackageId = legacy.addBusinessPackage.run({
    businessId: 'business-b', name: 'One hour', price: 30, seconds: 3600,
  }).lastInsertRowid;
  const alphaPackages = tenant.packagesForLocation.all(alpha.id);
  const bravoPackages = tenant.packagesForLocation.all(bravo.id);
  assert.deepStrictEqual(alphaPackages.map((p) => p.name), ['Ten minutes']);
  assert.deepStrictEqual(bravoPackages.map((p) => p.name), ['One hour']);
  assert.strictEqual(tenant.packageForLocation.get(bravoPackageId, alpha.id), undefined,
    'a package from another business must not be purchasable at this location');

  const phone = '254712000001';
  const mac = 'AA:BB:CC:DD:EE:01';
  const firstPayment = addPaidTransaction({
    checkoutRequestId: 'tenant-payment-a1', businessId: 'business-a', locationId: alpha.id,
    packageId: alphaPackageId, packageName: 'Ten minutes', amount: 10, seconds: 600, phone, mac,
  });
  const firstGrant = tenant.grantSubscription({ transaction: firstPayment });
  const initialExpiry = new Date(firstGrant.expiresAt.replace(' ', 'T') + 'Z').getTime();
  assert.ok(initialExpiry > Date.now() + 590000, 'first grant needs a future wall-clock expiry');
  assert.strictEqual(firstGrant.totalSeconds, 600);

  // A repeat purchase keeps the same credentials and extends from the prior
  // expiry, not from the browser timer or router activity counter.
  const topUp = addPaidTransaction({
    checkoutRequestId: 'tenant-payment-a2', businessId: 'business-a', locationId: alpha.id,
    packageId: alphaPackageId, packageName: 'Two minutes', amount: 4, seconds: 120, phone, mac,
  });
  const extended = tenant.grantSubscription({ transaction: topUp });
  const extendedExpiry = new Date(extended.expiresAt.replace(' ', 'T') + 'Z').getTime();
  assert.strictEqual(extended.id, firstGrant.id);
  assert.strictEqual(extended.username, firstGrant.username);
  assert.strictEqual(extended.totalSeconds, 720);
  assert.ok(extendedExpiry >= initialExpiry + 119000 && extendedExpiry <= initialExpiry + 121000,
    'top-up must add time to the persisted expiry');

  const alphaJobs = tenant.pendingJobs.all(alpha.id);
  assert.deepStrictEqual(alphaJobs.map((job) => job.total_seconds), [720],
    'router jobs carry absolute totals so retrying them is safe');
  assert.strictEqual(tenant.pendingJobs.all(bravo.id).length, 0,
    'a tenant router must never receive another tenant\'s jobs');
  tenant.markDelivered.run(alphaJobs[0].id);
  tenant.markAcked.run(alphaJobs[0].id, alpha.id);
  assert.deepStrictEqual(tenant.pendingJobs.all(alpha.id), [], 'an older job must not reapply after its replacement is acknowledged');

  // The same payer and MAC at another business is a separate subscription.
  // Usage reports are scoped by location even if the router usernames match.
  const bravoPayment = addPaidTransaction({
    checkoutRequestId: 'tenant-payment-b1', businessId: 'business-b', locationId: bravo.id,
    packageId: bravoPackageId, packageName: 'One hour', amount: 30, seconds: 3600, phone, mac,
  });
  const bravoGrant = tenant.grantSubscription({ transaction: bravoPayment });
  tenant.recordUsage.run({
    locationId: alpha.id, routerUsername: firstGrant.username, usedSeconds: 183, isActive: 1,
  });
  const alphaSubscription = tenant.subscriptionByMac.get(alpha.id, mac);
  const bravoSubscription = tenant.subscriptionByMac.get(bravo.id, mac);
  assert.strictEqual(alphaSubscription.used_seconds, 183);
  assert.strictEqual(alphaSubscription.is_active, 1);
  assert.strictEqual(bravoSubscription.used_seconds, 0,
    'usage reported by Alpha must not alter Bravo\'s customer record');
  assert.strictEqual(bravoSubscription.router_username, bravoGrant.username);
  assert.strictEqual(tenant.activeMeter.get('business-a').n, 1);
  assert.strictEqual(tenant.activeMeter.get('business-b').n, 1);

  // Daraja may deliver a callback while the customer's status poll is also
  // seeing the same successful checkout. Provisioning that one payment twice
  // must retain its first grant/job rather than add a second package.
  const replayPayment = addPaidTransaction({
    checkoutRequestId: 'tenant-payment-idempotent', businessId: 'business-a', locationId: alpha.id,
    packageId: alphaPackageId, packageName: 'Fifteen minutes', amount: 15, seconds: 900,
    phone: '254712000009', mac: 'AA:BB:CC:DD:EE:09',
  });
  const replayFirst = tenant.provisionPaidTransaction(replayPayment.checkout_request_id);
  const transactionAfterFirst = tenant.getTransaction.get(replayPayment.checkout_request_id);
  const jobsAfterFirst = legacy.db.prepare(
    'SELECT COUNT(*) AS n FROM tenant_jobs WHERE location_id=? AND username=?'
  ).get(alpha.id, replayFirst.username).n;
  assert.strictEqual(replayFirst.totalSeconds, 900);
  assert.ok(transactionAfterFirst.provisioned, 'the paid checkout must be marked provisioned');
  assert.ok(transactionAfterFirst.provisioning_job_id, 'the queued router job id must be retained');
  assert.strictEqual(transactionAfterFirst.provisioning_job_id, replayFirst.provisioningJobId);
  assert.strictEqual(tenant.jobById.get(transactionAfterFirst.provisioning_job_id, alpha.id).location_id, alpha.id);

  const replaySecond = tenant.provisionPaidTransaction(replayPayment.checkout_request_id);
  const transactionAfterSecond = tenant.getTransaction.get(replayPayment.checkout_request_id);
  const replaySubscription = tenant.subscriptionByMac.get(alpha.id, 'AA:BB:CC:DD:EE:09');
  const jobsAfterSecond = legacy.db.prepare(
    'SELECT COUNT(*) AS n FROM tenant_jobs WHERE location_id=? AND username=?'
  ).get(alpha.id, replayFirst.username).n;
  assert.strictEqual(replaySecond.alreadyProvisioned, true);
  assert.strictEqual(replaySecond.id, replayFirst.id);
  assert.strictEqual(replaySecond.totalSeconds, 900);
  assert.strictEqual(replaySubscription.total_seconds, 900,
    'a replayed paid callback must not add another package');
  assert.strictEqual(transactionAfterSecond.provisioning_job_id, transactionAfterFirst.provisioning_job_id);
  assert.strictEqual(jobsAfterFirst, 1);
  assert.strictEqual(jobsAfterSecond, 1, 'a replayed paid callback must not queue another router job');
  assert.strictEqual(
    tenant.transferSubscription({
      locationId: alpha.id, payerPhone: '254712000009', subscriptionId: replayFirst.id,
      password: replayFirst.password, mac, ip: '10.5.50.21',
    }).error,
    'occupied',
    'moving time onto another existing subscription must be rejected cleanly'
  );

  // One physical TV can be attached to a subscription. The router receives a
  // dedicated MAC-bound account, and a second TV is refused.
  const tv = tenant.addTvDevice({ locationId: alpha.id, payerPhone: phone, subscriptionId: firstGrant.id,
    password: firstGrant.password, mac: 'AA:BB:CC:DD:EE:99', label: 'Living room TV' });
  assert.ok(tv.provisioningJobId > 0);
  assert.strictEqual(tenant.deviceForSubscription.get(alpha.id, firstGrant.id).label, 'Living room TV');
  assert.strictEqual(tenant.addTvDevice({ locationId: alpha.id, payerPhone: phone, subscriptionId: firstGrant.id,
    password: firstGrant.password, mac: 'AA:BB:CC:DD:EE:98', label: 'Second TV' }).error, 'limit');
  assert.strictEqual(tenant.addTvDevice({ locationId: alpha.id, payerPhone: phone, subscriptionId: firstGrant.id,
    password: firstGrant.password, mac, label: 'Phone again' }).error, 'same-device');

  // Expiry is server wall-clock based. The linked TV uses a distinct router
  // identity, so both identities must receive a single idempotent revoke.
  legacy.db.prepare(`UPDATE tenant_subscriptions
    SET expires_at=datetime('now', '-1 second'), expiry_job_id=NULL WHERE id=?`).run(firstGrant.id);
  assert.strictEqual(tenant.queueExpiredSubscriptions(alpha.id), 1);
  const expiryRevokes = legacy.db.prepare(`SELECT username FROM tenant_jobs
    WHERE location_id=? AND action='revoke' AND username IN (?, ?)
    ORDER BY username`).all(alpha.id, firstGrant.username, `${firstGrant.username}-tv`);
  assert.deepStrictEqual(expiryRevokes.map((job) => job.username),
    [firstGrant.username, `${firstGrant.username}-tv`].sort());
  assert.strictEqual(tenant.queueExpiredSubscriptions(alpha.id), 0,
    'an expired subscription must not create revoke jobs on every router poll');
  assert.strictEqual(tenant.removeTvDevice({ locationId: alpha.id, payerPhone: phone, subscriptionId: firstGrant.id,
    password: firstGrant.password, mac: 'AA:BB:CC:DD:EE:99' }), true);

  // Vouchers are location-scoped and claim atomically, so a used code cannot
  // credit a second device or a different business.
  const [voucher] = tenant.issueVouchers({ businessId: 'business-a', locationId: alpha.id,
    packageId: alphaPackageId, packageName: 'Ten minutes', seconds: 600, count: 1, batch: 'test' });
  const redeemed = tenant.redeemVoucher({ locationId: alpha.id, code: voucher, phone,
    mac: 'AA:BB:CC:DD:EE:77', ip: '10.5.50.77' });
  assert.ok(redeemed && redeemed.provisioningJobId > 0);
  assert.strictEqual(tenant.redeemVoucher({ locationId: alpha.id, code: voucher, phone,
    mac: 'AA:BB:CC:DD:EE:78', ip: '10.5.50.78' }), null);
  assert.strictEqual(tenant.redeemVoucher({ locationId: bravo.id, code: voucher, phone,
    mac: 'AA:BB:CC:DD:EE:78', ip: '10.5.50.78' }), null, 'voucher cannot cross locations');

  // Own-collection Daraja credentials are encrypted at rest and only
  // recoverable with the deployment master key.
  tenant.savePaymentConnection({ businessId: 'business-a', collectionName: 'Alpha PayBill', shortcode: '123456',
    transactionType: 'CustomerPayBillOnline', consumerKey: 'consumer-key', consumerSecret: 'consumer-secret', passkey: 'passkey', verified: true });
  assert.deepStrictEqual(tenant.paymentCredentials('business-a'), { shortcode: '123456', transactionType: 'CustomerPayBillOnline',
    consumerKey: 'consumer-key', consumerSecret: 'consumer-secret', passkey: 'passkey' });
  const encrypted = legacy.db.prepare('SELECT consumer_key_cipher FROM tenant_mpesa_connections WHERE business_id=?').get('business-a');
  assert.ok(!encrypted.consumer_key_cipher.includes('consumer-key'), 'raw M-Pesa credentials must not be stored');

  // Platform plan payments have their own idempotent activation ledger.
  tenant.insertBusinessBilling.run({ checkoutRequestId: 'business-plan-payment', merchantRequestId: 'merchant-plan',
    businessId: 'business-a', plan: 'growth', phone, amount: 3500 });
  tenant.setBusinessBillingResult.run({ checkoutRequestId: 'business-plan-payment', status: 'paid',
    resultCode: 0, resultDesc: 'Accepted', receipt: 'PLAN-RECEIPT' });
  const activated = tenant.activateBusinessBilling('business-plan-payment');
  assert.ok(new Date(activated.expiresAt.replace(' ', 'T') + 'Z').getTime() > Date.now());
  assert.strictEqual(tenant.activateBusinessBilling('business-plan-payment').alreadyActivated, true);
  const billedBusiness = legacy.businessById.get('business-a');
  assert.strictEqual(billedBusiness.plan, 'growth');
  assert.strictEqual(billedBusiness.billing_status, 'active');

  console.log('\nTenant core\n  ok   isolation, subscriptions, router jobs, TV access, vouchers, encrypted collection and billing');
})();

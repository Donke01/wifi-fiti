/*
 * Tenant core is deliberately tested without HTTP, M-Pesa, or a router.
 * That makes the important commercial boundary cheap to verify: a location
 * can only see its own packages, subscriptions, jobs, and router secret.
 */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.PORTAL_ROOT_DOMAIN = 'fiti.test';
process.env.EDGE_GATEWAY_SECRET = 'tenant-test-edge-secret-0123456789abcdef';
process.env.PORTAL_GATEWAY_ENABLED = 'true';
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

function addPaidTransaction({ checkoutRequestId, businessId, locationId, packageId, packageName, amount, seconds, rateLimit = null, phone, mac }) {
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
    rateLimit,
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

  // A dashboard owner may abandon an untouched draft, but that operation is
  // deliberately narrow: it requires the exact confirmation and removes the
  // paired hostname along with the one-time router credential.  It must not
  // become a way to erase a router that has ever checked in.
  const unusedDraft = tenant.createLocation({
    id: 'location-unused-draft', businessId: 'business-a', name: 'Unused draft', routerName: 'hAP lite',
  });
  assert.throws(
    () => tenant.discardUnusedLocation({ locationId: unusedDraft.id, businessId: 'business-a', confirm: 'delete' }),
    (error) => error && error.status === 400 && /Type DELETE/.test(error.message),
    'discarding a draft requires an explicit, case-sensitive confirmation'
  );
  assert.ok(tenant.locationById.get(unusedDraft.id), 'a rejected discard leaves the draft intact');
  assert.ok(tenant.portalDomainByHostname.get(unusedDraft.portalHostname),
    'a rejected discard keeps the unused portal address reserved');
  const discarded = tenant.discardUnusedLocation({
    locationId: unusedDraft.id, businessId: 'business-a', confirm: 'DELETE',
  });
  assert.deepStrictEqual(discarded, { id: unusedDraft.id, name: 'Unused draft' });
  assert.strictEqual(tenant.locationById.get(unusedDraft.id), undefined,
    'a confirmed discard removes the unused location record');
  assert.strictEqual(tenant.portalDomainByHostname.get(unusedDraft.portalHostname), undefined,
    'a confirmed discard frees the managed portal address');
  assert.strictEqual(tenant.authenticateRouter(unusedDraft.id, unusedDraft.routerToken), null,
    'the discarded one-time pairing credential cannot check in later');

  const pairedDraft = tenant.createLocation({
    id: 'location-paired-draft', businessId: 'business-a', name: 'Paired draft', routerName: 'hAP lite',
  });
  assert.ok(tenant.authenticateRouter(pairedDraft.id, pairedDraft.routerToken),
    'the paired-draft guard is exercised after a real router authentication');
  assert.throws(
    () => tenant.discardUnusedLocation({ locationId: pairedDraft.id, businessId: 'business-a', confirm: 'DELETE' }),
    (error) => error && error.status === 409 && /already been paired/.test(error.message),
    'a router that has checked in must use staged replacement setup instead of deletion'
  );
  assert.ok(tenant.locationById.get(pairedDraft.id), 'a paired location remains intact after the rejected discard');

  // The support module is attached later by the HTTP server. If a draft has
  // already been discussed with support, it is business history too and must
  // not be silently orphaned by the discard control.
  legacy.db.exec(`CREATE TABLE business_support_tickets (
    id TEXT PRIMARY KEY, business_id TEXT NOT NULL, location_id TEXT,
    subject TEXT NOT NULL, category TEXT NOT NULL
  )`);
  const supportDraft = tenant.createLocation({
    id: 'location-support-draft', businessId: 'business-a', name: 'Support draft', routerName: 'hAP lite',
  });
  legacy.db.prepare(`INSERT INTO business_support_tickets(id,business_id,location_id,subject,category) VALUES(?,?,?,?,?)`)
    .run('ticket-support-draft', 'business-a', supportDraft.id, 'Need help with setup', 'router');
  assert.throws(
    () => tenant.discardUnusedLocation({ locationId: supportDraft.id, businessId: 'business-a', confirm: 'DELETE' }),
    (error) => error && error.status === 409 && /support/.test(error.message),
    'support history blocks deletion even before a router has checked in'
  );

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
  assert.strictEqual(paired.last_successful_sync_at, null,
    'generic router authentication must not be mistaken for a completed control-plane sync');

  // Remote support is intentionally a second, owner-consented onboarding
  // stage. It is unavailable before the first authenticated router poll,
  // stores no VPN credential, and remains fully scoped to the owner.
  const beforeRemoteAccess = tenant.remoteAccessForBusiness({ locationId: alpha.id, businessId: 'business-a' });
  assert.strictEqual(beforeRemoteAccess.status, 'not_requested');
  assert.strictEqual(beforeRemoteAccess.canRequest, false,
    'a router login, jobs request, or other authenticated endpoint must not unlock remote support');
  assert.strictEqual(tenant.remoteAccessForBusiness({ locationId: alpha.id, businessId: 'business-b' }), null,
    'one business cannot inspect another business remote-support lifecycle');
  assert.throws(
    () => tenant.requestRemoteAccess({ locationId: alpha.id, businessId: 'business-a' }),
    (error) => error && error.status === 409 && /authenticated WiFi Fiti poll/.test(error.message),
    'owner consent requires a successful sync rather than a generic authenticated router request'
  );
  assert.throws(
    () => tenant.requestRemoteAccess({ locationId: bravo.id, businessId: 'business-b' }),
    (error) => error && error.status === 409 && /authenticated WiFi Fiti poll/.test(error.message),
    'a router must pair before its owner can request remote support'
  );
  tenant.recordSuccessfulRouterSync(alpha.id);
  const synchronized = tenant.locationById.get(alpha.id);
  assert.ok(synchronized.last_successful_sync_at,
    'the dedicated completed-sync timestamp is durable once the sync handler records success');
  assert.strictEqual(tenant.remoteAccessForBusiness({ locationId: alpha.id, businessId: 'business-a' }).canRequest, true);
  const requestedRemoteAccess = tenant.requestRemoteAccess({ locationId: alpha.id, businessId: 'business-a' });
  assert.strictEqual(requestedRemoteAccess.status, 'requested');
  assert.strictEqual(requestedRemoteAccess.canRevoke, true);
  assert.strictEqual(tenant.requestRemoteAccess({ locationId: alpha.id, businessId: 'business-a' }).status, 'requested',
    'repeating the owner request is idempotent');
  assert.strictEqual(legacy.db.prepare('SELECT COUNT(*) AS n FROM tenant_remote_access_events WHERE location_id=? AND action=\'requested\'')
    .get(alpha.id).n, 1, 'idempotent requests produce one consent event');
  const supportPublicKey = Buffer.alloc(32, 7).toString('base64');
  assert.throws(
    () => tenant.recordRemoteAccessEnrollment({ locationId: alpha.id, publicKey: supportPublicKey }),
    (error) => error && error.status === 409 && /platform approval/.test(error.message),
    'a router cannot record remote-support identity before the platform approves owner consent'
  );
  const remoteColumns = legacy.db.prepare('PRAGMA table_info(tenant_remote_access)').all().map((column) => column.name);
  assert.ok(remoteColumns.includes('router_public_key') && remoteColumns.includes('enrolled_at'),
    'the control plane records a non-secret router public identifier and report time');
  assert.ok(!remoteColumns.some((name) => /private.*key|password|secret/i.test(name)),
    'the billing database must never store private keys or router credentials');
  assert.strictEqual(tenant.manageRemoteAccess({ locationId: alpha.id, action: 'approve' }).status, 'approved');
  assert.throws(
    () => tenant.manageRemoteAccess({ locationId: alpha.id, action: 'configure', managementAddress: '192.168.1.2', hubName: 'Nairobi hub' }),
    (error) => error && error.status === 400,
    'hub inventory only accepts the dedicated 10.x management range'
  );
  const configuredRemoteAccess = tenant.manageRemoteAccess({
    locationId: alpha.id, action: 'configure', managementAddress: '10.251.0.21', hubName: 'Nairobi hub',
  });
  assert.strictEqual(configuredRemoteAccess.status, 'configured');
  assert.strictEqual(configuredRemoteAccess.managementAddress, '10.251.0.21');
  assert.strictEqual(configuredRemoteAccess.lastHandshakeAt, null,
    'configured inventory must not claim a live tunnel before hub telemetry exists');
  const enrolledRemoteAccess = tenant.recordRemoteAccessEnrollment({ locationId: alpha.id, publicKey: supportPublicKey });
  assert.strictEqual(enrolledRemoteAccess.status, 'configured');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(enrolledRemoteAccess, 'routerPublicKey'), false,
    'router identity is not exposed in an owner-facing lifecycle payload');
  const savedEnrollment = legacy.db.prepare(
    'SELECT router_public_key, enrolled_at FROM tenant_remote_access WHERE location_id=?'
  ).get(alpha.id);
  assert.strictEqual(savedEnrollment.router_public_key, supportPublicKey);
  assert.ok(savedEnrollment.enrolled_at, 'the public-key report time is durable');
  const repeatedEnrollment = tenant.recordRemoteAccessEnrollment({ locationId: alpha.id, publicKey: supportPublicKey });
  assert.strictEqual(repeatedEnrollment.status, 'configured', 'repeating the same public key is safe and idempotent');
  assert.deepStrictEqual(legacy.db.prepare(
    'SELECT router_public_key, enrolled_at FROM tenant_remote_access WHERE location_id=?'
  ).get(alpha.id), savedEnrollment, 'an idempotent report must not replace or refresh the router identity binding');
  const replacementSupportPublicKey = Buffer.alloc(32, 8).toString('base64');
  assert.throws(
    () => tenant.recordRemoteAccessEnrollment({ locationId: alpha.id, publicKey: replacementSupportPublicKey }),
    (error) => error && error.status === 409 && /different router support identity/i.test(error.message),
    'a different router identity cannot overwrite an enrolled router'
  );
  assert.deepStrictEqual(legacy.db.prepare(
    'SELECT router_public_key, enrolled_at FROM tenant_remote_access WHERE location_id=?'
  ).get(alpha.id), savedEnrollment, 'a rejected replacement report leaves the original identity intact');
  assert.throws(
    () => tenant.recordRemoteAccessEnrollment({ locationId: alpha.id, publicKey: 'not-a-wireguard-public-key' }),
    (error) => error && error.status === 400,
    'only a 32-byte WireGuard public key is accepted'
  );
  const revokedRemoteAccess = tenant.revokeRemoteAccessForBusiness({ locationId: alpha.id, businessId: 'business-a' });
  assert.strictEqual(revokedRemoteAccess.status, 'revoked');
  assert.strictEqual(revokedRemoteAccess.managementAddress, null,
    'revocation removes non-secret hub inventory from the owner payload');
  const revokeControl = tenant.pendingRemoteSupportControls.all(alpha.id).find((control) => control.action === 'revoke');
  assert.ok(revokeControl, 'revocation queues a router cleanup command before another router can be enrolled');
  assert.strictEqual(tenant.remoteAccessForBusiness({ locationId: alpha.id, businessId: 'business-a' }).canRequest, false,
    'the owner cannot supersede remote-support cleanup with a new request');
  assert.throws(
    () => tenant.requestRemoteAccess({ locationId: alpha.id, businessId: 'business-a' }),
    (error) => error && error.status === 409 && /cleanup.*acknowledge/i.test(error.message),
    'a replacement router must wait for the previous router cleanup acknowledgement'
  );
  tenant.markRemoteSupportControlAcked.run(revokeControl.id, alpha.id);
  assert.strictEqual(tenant.requestRemoteAccess({ locationId: alpha.id, businessId: 'business-a' }).status, 'requested',
    'a revoked owner may make a fresh consent request after router cleanup, which requires re-approval');
  assert.throws(
    () => tenant.recordRemoteAccessEnrollment({ locationId: alpha.id, publicKey: supportPublicKey }),
    (error) => error && error.status === 409,
    'a new request must be approved again before a router can report an identity'
  );
  assert.strictEqual(tenant.manageRemoteAccess({ locationId: alpha.id, action: 'approve' }).status, 'approved',
    'the re-request remains subject to a fresh platform approval');
  assert.strictEqual(tenant.manageRemoteAccess({
    locationId: alpha.id, action: 'configure', managementAddress: '10.251.0.21', hubName: 'Nairobi hub',
  }).status, 'configured',
  're-approval must be followed by fresh platform configuration');
  assert.strictEqual(tenant.recordRemoteAccessEnrollment({ locationId: alpha.id, publicKey: replacementSupportPublicKey }).status, 'configured',
    'only the explicit revoke, cleanup acknowledgement, re-request, approval, and configuration cycle permits a replacement router identity');
  assert.strictEqual(legacy.db.prepare(
    'SELECT router_public_key FROM tenant_remote_access WHERE location_id=?'
  ).get(alpha.id).router_public_key, replacementSupportPublicKey);

  // The generated label retains enough of the ID to stay unique at scale, and
  // location/domain creation is atomic when a malformed legacy record happens
  // to occupy a hostname.
  assert.match(alpha.portalHostname, /-locationalpha\.fiti\.test$/, 'the full available location-id suffix is retained');
  const collisionOwner = tenant.createLocation({
    id: 'collision-owner', businessId: 'business-a', name: 'Collision owner', routerName: 'hAP lite',
  });
  const collidingId = 'loc-1234567890abcdef';
  legacy.db.prepare(`INSERT INTO tenant_portal_domains (hostname, location_id, kind, status, is_primary)
    VALUES (?, ?, 'managed', 'active', 0)`).run('collision-1234567890abcdef.fiti.test', collisionOwner.id);
  assert.throws(() => tenant.createLocation({
    id: collidingId, businessId: 'business-a', name: 'Collision', routerName: 'hAP lite',
  }), /UNIQUE constraint failed/);
  assert.strictEqual(tenant.locationById.get(collidingId), undefined, 'a portal-host collision rolls back the new location and its pairing token');

  tenant.setManagedPortalHostname({ locationId: alpha.id, businessId: 'business-a', slug: 'alpha-one' });
  tenant.setManagedPortalHostname({ locationId: alpha.id, businessId: 'business-a', slug: 'alpha-two' });
  assert.throws(() => tenant.setManagedPortalHostname({ locationId: alpha.id, businessId: 'business-a', slug: 'alpha-three' }), /three active portal addresses/);
  assert.strictEqual(tenant.managedPortalSlugReserved('cloud'), true, 'system host labels cannot be claimed by tenants');
  const staged = tenant.rotateLocationToken({ locationId: alpha.id, businessId: 'business-a' });
  assert.ok(staged.routerToken, 'replacement kit receives a one-time staged credential');
  assert.strictEqual(tenant.locationsForBusiness.all('business-a').find((location) => location.id === alpha.id).router_pairing_pending, true,
    'the owner workspace reports a replacement-router pairing only while its staged token is valid');
  assert.strictEqual(tenant.authenticateRouter(alpha.id, alpha.routerToken).business_id, 'business-a',
    'the live router stays online until the replacement kit checks in');
  assert.strictEqual(tenant.authenticateRouter(alpha.id, staged.routerToken).business_id, 'business-a');
  assert.strictEqual(tenant.authenticateRouter(alpha.id, alpha.routerToken), null,
    'the old router is retired only after the staged credential checks in');
  assert.strictEqual(tenant.locationsForBusiness.all('business-a').find((location) => location.id === alpha.id).router_pairing_pending, false,
    'the owner workspace clears pairing-pending immediately after the staged token promotes');
  alpha.routerToken = staged.routerToken;

  const expiring = tenant.rotateLocationToken({ locationId: bravo.id, businessId: 'business-b' });
  assert.ok(expiring.routerToken);
  assert.strictEqual(tenant.locationsForBusiness.all('business-b')[0].router_pairing_pending, true);
  legacy.db.prepare(`UPDATE locations SET router_pending_token_expires_at=datetime('now','-1 second') WHERE id=?`).run(bravo.id);
  assert.strictEqual(tenant.locationsForBusiness.all('business-b')[0].router_pairing_pending, false,
    'an expired replacement token is never presented as a pending router pairing');
  assert.strictEqual(tenant.authenticateRouter(bravo.id, expiring.routerToken), null,
    'an expired replacement token cannot promote itself');

  const alphaPackageId = legacy.addBusinessPackage.run({
    businessId: 'business-a', name: 'Ten minutes', price: 10, seconds: 600, rateLimit: '2M/5M',
  }).lastInsertRowid;
  const bravoPackageId = legacy.addBusinessPackage.run({
    businessId: 'business-b', name: 'One hour', price: 30, seconds: 3600, rateLimit: null,
  }).lastInsertRowid;
  const alphaPackages = tenant.packagesForLocation.all(alpha.id);
  const bravoPackages = tenant.packagesForLocation.all(bravo.id);
  assert.deepStrictEqual(alphaPackages.map((p) => p.name), ['Ten minutes']);
  assert.strictEqual(alphaPackages[0].rate_limit, '2M/5M');
  assert.deepStrictEqual(bravoPackages.map((p) => p.name), ['One hour']);
  assert.strictEqual(tenant.packageForLocation.get(bravoPackageId, alpha.id), undefined,
    'a package from another business must not be purchasable at this location');

  const phone = '254712000001';
  const mac = 'AA:BB:CC:DD:EE:01';
  const firstPayment = addPaidTransaction({
    checkoutRequestId: 'tenant-payment-a1', businessId: 'business-a', locationId: alpha.id,
    packageId: alphaPackageId, packageName: 'Ten minutes', amount: 10, seconds: 600, rateLimit: '2M/5M', phone, mac,
  });
  const firstGrant = tenant.grantSubscription({ transaction: firstPayment });
  const initialExpiry = new Date(firstGrant.expiresAt.replace(' ', 'T') + 'Z').getTime();
  assert.ok(initialExpiry > Date.now() + 590000, 'first grant needs a future wall-clock expiry');
  assert.strictEqual(firstGrant.totalSeconds, 600);
  assert.strictEqual(firstGrant.rateLimit, '2M/5M');

  // A repeat purchase keeps the same credentials and extends from the prior
  // expiry, not from the browser timer or router activity counter.
  const topUp = addPaidTransaction({
    checkoutRequestId: 'tenant-payment-a2', businessId: 'business-a', locationId: alpha.id,
    packageId: alphaPackageId, packageName: 'Two minutes', amount: 4, seconds: 120, rateLimit: null, phone, mac,
  });
  const extended = tenant.grantSubscription({ transaction: topUp });
  const extendedExpiry = new Date(extended.expiresAt.replace(' ', 'T') + 'Z').getTime();
  assert.strictEqual(extended.id, firstGrant.id);
  assert.strictEqual(extended.username, firstGrant.username);
  assert.strictEqual(extended.totalSeconds, 720);
  assert.strictEqual(tenant.subscriptionByMac.get(alpha.id, mac).rate_limit, null,
    'a speedless package restores the normal router profile speed');
  assert.ok(extendedExpiry >= initialExpiry + 119000 && extendedExpiry <= initialExpiry + 121000,
    'top-up must add time to the persisted expiry');

  const alphaJobs = tenant.pendingJobs.all(alpha.id);
  assert.deepStrictEqual(alphaJobs.map((job) => job.total_seconds), [720],
    'router jobs carry absolute totals so retrying them is safe');
  assert.strictEqual(alphaJobs[0].rate_limit, null);
  const normalSpeedScript = require('../src/lib/rsc').jobToScript(alphaJobs[0], 'hotspot1');
  assert.ok(normalSpeedScript.includes('profile=standard'),
    'a normal-speed package must return the customer to the router standard profile');
  assert.ok(!normalSpeedScript.includes('rate-limit='),
    'RouterOS v7 does not accept rate-limit on /ip hotspot user records');
  const limitedSpeedScript = require('../src/lib/rsc').jobToScript({ ...alphaJobs[0], rate_limit: '2M/5M' }, 'hotspot1');
  assert.ok(limitedSpeedScript.includes('/ip hotspot user profile add'),
    'a package speed must create a dedicated HotSpot user profile');
  assert.ok(limitedSpeedScript.includes('copy-from=standard'),
    'a package speed profile must retain the router standard profile settings');
  assert.ok(limitedSpeedScript.includes('rate-limit=$fitiRate'),
    'the dedicated profile must carry the selected speed');
  assert.ok(limitedSpeedScript.includes('profile=$fitiProfile'),
    'the customer must be assigned to the dedicated speed profile');
  assert.ok(!limitedSpeedScript.split('\n').some((line) =>
    /\/ip hotspot user (?:set|add)\b/.test(line) && line.includes('rate-limit=')),
  'a speed must never be emitted on an unsupported HotSpot user command');
  assert.strictEqual(require('../src/lib/rsc').jobToScript({ ...alphaJobs[0], rate_limit: '2M/5M;:beep' }, 'hotspot1'), null,
    'a corrupted rate setting must never become RouterOS code');
  assert.strictEqual(tenant.pendingJobs.all(bravo.id).length, 0,
    'a tenant router must never receive another tenant\'s jobs');
  tenant.markDelivered.run(alphaJobs[0].id);
  tenant.markAcked.run(alphaJobs[0].id, alpha.id);
  assert.deepStrictEqual(tenant.pendingJobs.all(alpha.id), [], 'an older job must not reapply after its replacement is acknowledged');

  // The same payer and MAC at another business is a separate subscription.
  // Usage reports are scoped by location even if the router usernames match.
  const bravoPayment = addPaidTransaction({
    checkoutRequestId: 'tenant-payment-b1', businessId: 'business-b', locationId: bravo.id,
    packageId: bravoPackageId, packageName: 'One hour', amount: 30, seconds: 3600, rateLimit: null, phone, mac,
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
    packageId: alphaPackageId, packageName: 'Fifteen minutes', amount: 15, seconds: 900, rateLimit: '2M/1M',
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
    packageId: alphaPackageId, packageName: 'Ten minutes', seconds: 600, rateLimit: '2M/5M', count: 1, batch: 'test' });
  const redeemed = tenant.redeemVoucher({ locationId: alpha.id, code: voucher, phone,
    mac: 'AA:BB:CC:DD:EE:77', ip: '10.5.50.77' });
  assert.ok(redeemed && redeemed.provisioningJobId > 0);
  assert.strictEqual(tenant.subscriptionByMac.get(alpha.id, 'AA:BB:CC:DD:EE:77').rate_limit, '2M/5M',
    'a voucher keeps the speed package that was active when the code was issued');
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

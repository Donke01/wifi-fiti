/*
 * node test/tv-connect.js - Buy for TV: nearby devices and getting the TV online.
 *
 * 1. Every router's telemetry report lists devices waiting on the customer
 *    network, and those reach the portal's nearby-device list.
 * 2. A paid TV receives a MAC authenticated HotSpot account with its own
 *    time and speed limits; existing subscriptions get a repair job.
 */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_TOKEN = 'tv-test-token';
process.env.TENANT_SECRETS_KEY = 'tv-test-storage-key';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-tv-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
const tenant = require('../src/lib/tenant');
const hotspotSessions = require('../src/lib/hotspot-sessions');
const { jobToScript } = require('../src/lib/rsc');

let pass = 0;
function t(name, fn) { fn(); pass += 1; console.log(`  ok   ${name}`); }

console.log('Buy for TV');

const TV_MAC = 'A4:30:7A:11:22:33';
const TV_USER = '254712345678-0A1B2C3D-tv';

t('the telemetry block reads waiting HotSpot hosts', () => {
  const script = hotspotSessions.telemetryReplyScript();
  assert.match(script, /\/ip hotspot host find/);
  assert.match(script, /"dev\|"/);
  assert.match(script, /host-name/);
});

t('device lines are parsed and junk is dropped', () => {
  const report = hotspotSessions.parseReport([
    'fiti-telemetry-v1',
    'res|5|1000|2000|60|1|2|0',
    `dev|${TV_MAC.toLowerCase()}|10.5.50.23|Living-Room TV;rm`,
    'dev|not-a-mac|10.5.50.24|x',
    'dev|AA:BB:CC:DD:EE:FF|999.1.1.1|x',
  ].join('\n'));
  assert.deepStrictEqual(report.devices, [{ mac: TV_MAC, ip: '10.5.50.23', hostname: 'Living-Room TVrm' }]);
});

legacy.addBusiness.run({ id: 'biz-tv', name: 'TV Biz', ownerName: 'Owner', ownerPhone: '254700000000',
  email: 'tv@fiti.test', passwordHash: 'x', plan: 'starter', collectionMode: 'fiti' });
const location = tenant.createLocation({ id: 'loc-tv', businessId: 'biz-tv', name: 'TV Spot' });
const locationId = (location && location.id) || 'loc-tv';

t('reported devices reach the nearby-device list', () => {
  assert.strictEqual(tenant.recordRouterDeviceEntries(locationId, [{ mac: TV_MAC, ip: '10.5.50.23', hostname: 'Living-Room TV' }]), 1);
  const devices = tenant.routerDevicesForLocation(locationId);
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].mac, TV_MAC);
});

t('a TV job creates a MAC authenticated account instead of using the read-only active menu', () => {
  const script = jobToScript({ action: 'tv-upsert', username: TV_USER, password: 'ABCD2345', profile: 'standard',
    total_seconds: 3600, mac: TV_MAC, ip: null }, 'hotspot1');
  assert.match(script, /\/ip hotspot user add name=\$fitiTvMac password=""/);
  assert.match(script, /login-by=\[:toarray/);
  assert.doesNotMatch(script, /\/ip hotspot active login/);
});

t('a phone job with an IP keeps its direct login only', () => {
  const script = jobToScript({ action: 'upsert', username: '254712345678', password: 'ABCD2345', profile: 'standard',
    total_seconds: 3600, mac: TV_MAC, ip: '10.5.50.9' }, 'hotspot1');
  assert.ok(!script.includes('fitiTvHost'));
  assert.match(script, /ip=10\.5\.50\.9/);
});

t('existing paid TVs get one repair job without another purchase', () => {
  const insert = legacy.db.prepare(`INSERT INTO tenant_subscriptions
    (id, business_id, location_id, router_username, payer_phone, mac, password, total_seconds, expires_at, device_type)
    VALUES (?, 'biz-tv', ?, ?, '254712345678', ?, 'ABCD2345', 3600, datetime('now', ?), ?)`);
  insert.run('sub-tv', locationId, TV_USER, TV_MAC, '+1 hour', 'tv');
  insert.run('sub-old-tv', locationId, '254712345678-0A1B2C3E-tv', 'A4:30:7A:11:22:44', '-1 hour', 'tv');
  insert.run('sub-phone', locationId, '254712345679', 'A4:30:7A:11:22:55', '+1 hour', 'phone');
  tenant.recordRouterDeviceEntries(locationId, [
    { mac: 'A4:30:7A:11:22:44', ip: '10.5.50.24' },
    { mac: 'A4:30:7A:11:22:55', ip: '10.5.50.25' },
  ]);
  assert.strictEqual(tenant.queueTvAccessRepair(locationId), 1);
  assert.strictEqual(tenant.queueTvAccessRepair(locationId), 0, 'an unacknowledged repair is not duplicated');
  const jobs = tenant.pendingJobs.all(locationId).filter((job) => job.action === 'tv-upsert');
  assert.deepStrictEqual(jobs.map((job) => job.username), [TV_USER]);
});

t('the MAC account refuses anything that could become router code', () => {
  assert.strictEqual(jobToScript({ action: 'tv-upsert', username: TV_USER, password: 'ABCD2345', profile: 'standard', total_seconds: 3600, mac: 'aa:bb' }, 'hotspot1'), null);
});

console.log(`\n${pass} passed`);

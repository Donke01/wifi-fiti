/* PPPoE on the router: speed order, cutting revoked sessions, waiting for the router map,
 * honest acknowledgements with failure reasons, health reports and the VLAN overlay clash guard. */
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiti-pppoe-router-'));
Object.assign(process.env, { PUBLIC_URL: 'https://fiti.test', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's',
  MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p', TENANT_SECRETS_KEY: 'pppoe-router-key', DATABASE_PATH: path.join(dir, 't.db') });
const { db } = require('../src/lib/db'); const pppoe = require('../src/lib/pppoe');
const { vlanOverlayRouterKit } = require('../src/lib/router-kit');
db.prepare(`INSERT INTO businesses(id,name,owner_name,owner_phone,email,password_hash) VALUES('b1','B','O','254700000000','b@x.test','h')`).run();
db.prepare(`INSERT INTO locations(id,business_id,name,router_token) VALUES('l1','b1','Kitale','rt1')`).run();
const profile = pppoe.profileCreate({ businessId: 'b1', name: 'Home 10/2', downloadRate: '10M', uploadRate: '2M' });
const user = pppoe.userCreate({ businessId: 'b1', locationId: 'l1', profileId: profile.id, username: 'alice', secret: 'a-secure-secret' });
const job = pppoe.jobFor({ businessId: 'b1', userId: user.id });
const jobRow = (id) => db.prepare('SELECT * FROM pppoe_jobs WHERE id=?').get(id);
const location = { id: 'l1', business_id: 'b1' };
let now = Date.now();
const script = () => { now += 10 * 60_000; return pppoe.scriptForLocation('l1', { now }); };

// Waiting for the router map: nothing is sent and the job stays queued.
assert.strictEqual(script(), '', 'no PPPoE work before the customer bridge is confirmed');
assert.strictEqual(jobRow(job.id).status, 'queued');
assert.deepStrictEqual(pppoe.routersFor('b1').map((r) => r.ready), [false]);
db.prepare(`UPDATE locations SET customer_bridge='bridge-hs' WHERE id='l1'`).run();
assert.deepStrictEqual(pppoe.routersFor('b1').map((r) => r.ready), [true]);

// Speeds: RouterOS reads upload/download, so a 10 down / 2 up plan is "2M/10M".
const first = script();
assert.match(first, /rate-limit="2M\/10M"/);
assert.doesNotMatch(first, /rate-limit="10M\/2M"/);
assert.match(first, /interface pppoe-server server add service-name="pppoe" interface="bridge-hs"/);
assert.match(first, /:set fitiPppReason "bridge_missing"/, 'setup checks the bridge exists on the router');
assert.match(first, /:set fitiPppReason "subnet_clash"/, 'setup checks the PPPoE range is free');
assert.match(first, new RegExp(`:set fitiPppOk \\(\\$fitiPppOk \\. "${job.id},"\\)`), 'success is reported per job');
assert.match(first, /&ack=" \. \$fitiPppOk \. "&fail=" \. \$fitiPppFail \. "&reason=" \. \$fitiPppReason/);
assert.doesNotMatch(first, /\} on-error=\{\}\n:if \(\$fitiPppInfra\)/, 'setup failures are not swallowed');
const open = (first.match(/\{/g) || []).length; const close = (first.match(/\}/g) || []).length;
assert.strictEqual(open, close, 'the RouterOS script has balanced blocks');
assert.strictEqual(jobRow(job.id).status, 'delivered');

// A failure report keeps the job, records why, and backs off; five failures stop it.
pppoe.applyRouterReport(location, { ack: '', fail: `${job.id},`, reason: 'subnet_clash', active: '0', server: 'off' });
let row = jobRow(job.id);
assert.strictEqual(row.status, 'queued'); assert.strictEqual(row.attempts, 1); assert.strictEqual(row.last_error, 'subnet_clash');
assert.strictEqual(pppoe.usersFor('b1')[0].job_error, 'subnet_clash', 'the dashboard can show why');
assert.strictEqual(pppoe.healthFor('b1', 'l1').status, 'server_off');
pppoe.applyRouterReport(location, { fail: job.id, reason: 'made-up' });
assert.strictEqual(jobRow(job.id).last_error, 'router_rejected', 'unknown reasons are not stored as given');
for (let i = 0; i < 3; i++) pppoe.applyRouterReport(location, { fail: job.id, reason: 'setup_failed' });
assert.strictEqual(jobRow(job.id).status, 'failed');
assert.doesNotMatch(script(), /ppp secret/, 'a failed job is not retried until the owner provisions again');

// Provisioning again resets it; a success report acknowledges it and records health.
pppoe.jobFor({ businessId: 'b1', userId: user.id });
db.prepare(`UPDATE pppoe_jobs SET next_attempt_at=datetime('now','-1 second') WHERE id=?`).run(job.id);
assert.match(script(), /ppp secret add name="alice"/);
pppoe.applyRouterReport(location, { ack: `${job.id},`, fail: '', reason: '', active: '3', server: 'on' });
assert.strictEqual(jobRow(job.id).status, 'acked');
assert.strictEqual(jobRow(job.id).last_error, null);
assert.deepStrictEqual([pppoe.healthFor('b1', 'l1').status, pppoe.healthFor('b1', 'l1').active_sessions], ['online', 3]);
pppoe.applyRouterReport({ id: 'other', business_id: 'b1' }, { ack: job.id });

// Health is asked for now and then even without jobs, not on every poll.
const healthOnly = script();
assert.match(healthOnly, /ppp active print count-only where service=pppoe/);
assert.doesNotMatch(healthOnly, /ppp secret/);
assert.strictEqual(pppoe.scriptForLocation('l1', { now: now + 1000 }), '', 'not again within five minutes');

// Locking (or expiry) disables the account and cuts the live session.
pppoe.setUserLock({ businessId: 'b1', userId: user.id, minutes: 30 });
const revoke = script();
assert.match(revoke, /\/ppp secret set \[find where name="alice"\] disabled=yes/);
assert.match(revoke, /:foreach fitiPppActive in=\[\/ppp active find where name="alice"\] do=\{ \/ppp active remove \$fitiPppActive \}/);
assert.doesNotMatch(revoke, /pppoe-server server add/, 'a revoke-only batch does not touch the server');

// The VLAN overlay refuses a subnet that this router's PPPoE already uses.
const pppoeSubnet = pppoe.pppoeSubnetForLocation('l1').network;
const octet = Number(pppoeSubnet.split('.')[2]);
const base = ':local fitiUrl "x"';
assert.throws(() => vlanOverlayRouterKit(base, { baseId: octet - 2, trunk: 'ether5', nativePorts: 'ether2', pppoeSubnet }), (e) => e.status === 409 && /PPPoE/.test(e.message));
assert.throws(() => vlanOverlayRouterKit(base, { baseId: 60, trunk: 'ether5', nativePorts: 'ether2', subnet: pppoeSubnet, pppoeSubnet }), (e) => e.status === 409);
const safeBase = octet > 100 ? 60 : 150;
const kit = vlanOverlayRouterKit(base, { baseId: safeBase, trunk: 'ether5', nativePorts: 'ether2', pppoeSubnet });
assert.match(kit, /\/ip pool find where name="fiti-pppoe-pool"/, 'the router also checks its live PPPoE pool');
// A blocked add says which subscribe pop-up to open.
const billing = require('../src/lib/service-billing');
const future = new Date(Date.now() + 10 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
const past = new Date(Date.now() - 40 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
assert.strictEqual(billing.pppoeAddBlockDetail({ billing_status: 'active' }).reason, 'none');
assert.strictEqual(billing.pppoeAddBlockDetail({ billing_status: 'active', pppoe_billing_expires_at: past, pppoe_users: 35 }).reason, 'expired');
assert.strictEqual(billing.pppoeAddBlockDetail({ billing_status: 'active', pppoe_billing_expires_at: future, pppoe_users: 2 }, { activeUsers: 2 }).reason, 'capacity');
assert.strictEqual(billing.pppoeAddBlockDetail({ billing_status: 'active', pppoe_billing_expires_at: future, pppoe_users: 2 }, { activeUsers: 1 }), null);
assert.strictEqual(billing.pppoeAddBlock({ billing_status: 'active' }), 'Subscribe to PPPoE + Static IP to add subscribers.');
console.log('PPPoE router: speed order, session cut on revoke, waits for router map, honest acks with reasons, health, overlay clash guard - passed');

/* Router delete: a router that has reported health and nearby devices can still be deleted. */
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiti-router-delete-'));
Object.assign(process.env, { PUBLIC_URL: 'https://fiti.test', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's',
  MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p', PROVISION_MODE: 'poll', SITE_TOKEN: 'x', TENANT_SECRETS_KEY: 'k',
  DATABASE_PATH: path.join(dir, 't.db') });
const { db } = require('../src/lib/db'); const tenant = require('../src/lib/tenant');
db.prepare(`INSERT INTO businesses (id,name,owner_name,owner_phone,email,password_hash,onboarding_state)
  VALUES ('b1','B','O','0712345678','b1@x.test','h','complete'),('b2','C','O','0712345679','b2@x.test','h','complete')`).run();
db.prepare(`INSERT INTO locations (id,business_id,name,router_token) VALUES ('l1','b1','Main','rt1')`).run();
tenant.recordRouterDevices({ locationId: 'l1', encoded: 'AA:BB:CC:11:22:33~10.5.50.9~TV' });
tenant.recordRouterTelemetry({ locationId: 'l1', cpuPercent: 5, freeMemory: 1, totalMemory: 2, uptimeSeconds: 10,
  uptimeText: '10s', rxBytes: 1, txBytes: 1, activeUsers: 1 });
const count = (table) => db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE location_id='l1'`).get().n;
assert.strictEqual(count('tenant_router_telemetry'), 1);
assert.strictEqual(count('tenant_router_devices'), 1);

assert.ok(!tenant.deleteLocationForOwner({ locationId: 'l1', businessId: 'b2', confirm: 'DELETE' }), 'another business cannot delete it');
assert.deepStrictEqual(tenant.deleteLocationForOwner({ locationId: 'l1', businessId: 'b1', confirm: 'DELETE' }),
  { id: 'l1', name: 'Main', deleted: true });
assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM locations WHERE id='l1'`).get().n, 0);
assert.strictEqual(count('tenant_router_telemetry'), 0);
assert.strictEqual(count('tenant_router_devices'), 0);
console.log('Router delete: router with health samples and nearby devices is deleted, tenant isolation - passed');

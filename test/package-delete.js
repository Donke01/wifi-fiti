/* Package delete: removed if never used, archived (hidden, history kept) if sold. */
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiti-package-delete-'));
Object.assign(process.env, { PUBLIC_URL: 'https://fiti.test', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's',
  MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p', PROVISION_MODE: 'poll', SITE_TOKEN: 'x', DATABASE_PATH: path.join(dir, 't.db') });
const store = require('../src/lib/db'); const tenant = require('../src/lib/tenant'); const db = store.db;
db.prepare(`INSERT INTO businesses (id,name,owner_name,owner_phone,email,password_hash) VALUES ('b1','B','O','0712345678','b1@x.test','h'),('b2','C','O','0712345679','b2@x.test','h')`).run();
db.prepare(`INSERT INTO locations (id,business_id,name,router_token) VALUES ('l1','b1','Main','rt1')`).run();
const addPkg = (name) => { store.addBusinessPackage.run({ businessId: 'b1', name, price: 20, seconds: 3600, rateLimit: null }); return db.prepare('SELECT id FROM business_packages WHERE name=?').get(name).id; };
const unused = addPkg('Unused'); const sold = addPkg('Sold');
db.prepare(`INSERT INTO tenant_transactions (checkout_request_id,business_id,location_id,phone,package_id,package_name,amount,seconds,mac,status)
  VALUES ('ws1','b1','l1','254712345678',?,'Sold',20,3600,'AA:BB:CC:DD:EE:FF','paid')`).run(sold);

assert.strictEqual(tenant.deletePackageForOwner(unused, 'b2'), null, 'another business cannot delete it');
assert.deepStrictEqual(tenant.deletePackageForOwner(unused, 'b1'), { result: 'removed' });
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM business_packages WHERE id=?').get(unused).n, 0);
assert.deepStrictEqual(tenant.deletePackageForOwner(sold, 'b1'), { result: 'archived' });
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM business_packages WHERE id=?').get(sold).n, 1, 'history keeps the row');
assert.deepStrictEqual(store.packagesForBusiness.all('b1'), [], 'hidden from the dashboard');
assert.strictEqual(tenant.packageForLocation.get(sold, 'l1'), undefined, 'never sold at the portal again');
assert.strictEqual(tenant.businessPackageById.get(sold, 'b1'), undefined, 'cannot be edited or resumed');
assert.strictEqual(tenant.deletePackageForOwner(sold, 'b1'), null, 'deleting twice is a no-op');
assert.strictEqual(db.prepare('SELECT package_name FROM tenant_transactions WHERE checkout_request_id=?').get('ws1').package_name, 'Sold');
console.log('Package delete: unused removed, sold archived with history kept, tenant isolation - passed');

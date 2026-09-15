const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const dbPath = '/tmp/fiti-signal-admin-test.sqlite';
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch (_) {} }
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k'; process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '1'; process.env.MPESA_PASSKEY = 'p'; process.env.DATABASE_PATH = dbPath;
process.env.ADMIN_CONFIRMATION_PHRASE = 'CONFIRM-TEST';
const store = require('../src/lib/db');
require('../src/lib/tenant');
const { attachFitiSignalAdminControls } = require('../src/lib/fiti-signal-admin-controls');
const { createPurchase, completePurchase } = require('../src/lib/fiti-signal');
store.db.prepare(`INSERT INTO businesses(id,name,owner_name,owner_phone,email,password_hash) VALUES(?,?,?,?,?,?)`)
  .run('admin-test', 'Admin Test', 'Owner', '+254700000000', 'admin-test@example.com', 'hash');
const app = express(); app.use(express.json());
attachFitiSignalAdminControls(app, { db: store, adminOk: req => req.headers['x-admin-token'] === 'ok' });
const server = http.createServer(app);
server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(base + path, { ...options, headers: { 'x-admin-token': 'ok', 'content-type': 'application/json', ...(options.headers || {}) } }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    let result = await call('/api/admin/fiti-signal/control/tenants'); assert.strictEqual(result.status, 200); assert.strictEqual(result.body.tenants.length, 1);
    result = await call('/api/admin/fiti-signal/control/tenants/admin-test/lifecycle/suspend', { method: 'POST', body: JSON.stringify({}) }); assert.strictEqual(result.status, 400);
    result = await call('/api/admin/fiti-signal/control/tenants/admin-test/lifecycle/suspend', { method: 'POST', body: JSON.stringify({ confirmation: 'CONFIRM-TEST' }) }); assert.strictEqual(result.body.tenant.status, 'suspended');
    const purchase = createPurchase({ businessId: 'admin-test', amount: 500 }); completePurchase({ purchaseId: purchase.id, paymentRef: 'ADMIN-PAY' });
    result = await call('/api/admin/fiti-signal/control/tenants/admin-test/credits', { method: 'POST', body: JSON.stringify({ confirmation: 'CONFIRM-TEST', delta: 10, reason: 'test' }) }); assert.strictEqual(result.body.account.credits_available, 510);
    result = await call('/api/admin/fiti-signal/control/provider/pause', { method: 'POST', body: JSON.stringify({ confirmation: 'CONFIRM-TEST' }) }); assert.strictEqual(result.body.providerPaused, true);
    result = await call('/api/admin/fiti-signal/control/audit'); assert.ok(result.body.events.length >= 3);
    console.log('FitiSignal admin controls: lifecycle, confirmation, credits, provider pause and audit tests passed');
  } catch (error) { console.error(error); process.exitCode = 1; } finally { server.close(); }
});

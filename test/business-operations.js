'use strict';

// Isolated SQLite and route-handler tests: no live money, network or router.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fiti-operations-test-'));
process.env.PUBLIC_URL = 'https://wifi-fiti.test';
process.env.MPESA_CONSUMER_KEY = 'test';
process.env.MPESA_CONSUMER_SECRET = 'test';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'test';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_TOKEN = 'test-site-token';
process.env.DATABASE_PATH = path.join(directory, 'test.db');

const store = require('../src/lib/db');
require('../src/lib/tenant');
const { attachBusinessOperations } = require('../src/lib/business-operations');
const db = store.db;
if (!db.prepare('PRAGMA table_info(tenant_transactions)').all().some(row => row.name === 'platform_fee_minor')) {
  db.exec('ALTER TABLE tenant_transactions ADD COLUMN platform_fee_minor INTEGER');
}
const routes = [];
const app = { get(route, handler) { routes.push({ method: 'GET', route, handler }); }, post(route, handler) { routes.push({ method: 'POST', route, handler }); } };
attachBusinessOperations(app, {
  db: store,
  businessAuth(req, res) {
    const business = db.prepare('SELECT id,name FROM businesses WHERE id=?').get(req.headers.authorization || '');
    if (!business) { res.status(401).json({ error: 'Please sign in.' }); return null; }
    return business;
  },
  adminOk: req => req.headers['x-admin-token'] === 'test-admin',
});

function request(method, url, { business, admin, body } = {}) {
  const parsed = new URL(url, 'https://test.invalid');
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const names = [];
    const pattern = candidate.route.split('/').map(part => part[0] === ':' ? (names.push(part.slice(1)), '([^/]+)') : part).join('/');
    const match = parsed.pathname.match(new RegExp('^' + pattern + '$'));
    if (!match) continue;
    const req = { params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])),
      query: Object.fromEntries(parsed.searchParams), body: body || {}, headers: { authorization: business, 'x-admin-token': admin ? 'test-admin' : undefined } };
    const result = { status: 200, headers: {}, body: null };
    const res = { status(value) { result.status = value; return this; }, set(name, value) { result.headers[name] = value; return this; },
      json(value) { result.body = value; return this; }, type(value) { result.headers['Content-Type'] = value; return this; }, send(value) { result.body = value; return this; } };
    candidate.handler(req, res);
    return result;
  }
  throw new Error('Unknown test route: ' + method + ' ' + url);
}
const base = '/api/business/operations';
const adminBase = '/api/admin/business-operations';
function payoutBody(key, amount = 1000) { return { idempotencyKey: key, amountMinor: amount,
  destinationType: 'mpesa', destinationName: 'Test operator', destinationAccount: '0712345678' }; }

try {
  for (const id of ['a','b']) {
    store.addBusiness.run({ id, name: 'Business ' + id, ownerName: 'Owner', ownerPhone: '254712345678',
      email: id + '@test.invalid', passwordHash: 'never-export-this', plan: 'starter', collectionMode: 'fiti' });
    db.prepare(`INSERT INTO locations(id,business_id,name,router_token) VALUES(?,?,?,?)`).run('loc-' + id, id, 'Location ' + id, 'hash-' + id);
    db.prepare(`INSERT INTO tenant_subscriptions(id,business_id,location_id,router_username,payer_phone,mac,password,total_seconds,expires_at)
      VALUES(?,?,?,?,?,?,?,3600,datetime('now','+1 hour'))`).run('sub-' + id, id, 'loc-' + id, '254712345678-' + id,
        '254712345678', 'AA:BB:CC:DD:EE:' + (id === 'a' ? '01' : '02'), 'sensitive-password');
  }
  const insertPayment = db.prepare(`INSERT INTO tenant_transactions(checkout_request_id,business_id,location_id,phone,package_id,package_name,
    amount,seconds,mac,status,payment_source,platform_fee,platform_fee_minor,subscription_id)
    VALUES(?,?,?,?,1,'Test package',?,3600,?,?,?,?,?,?)`);
  insertPayment.run('old-a', 'a', 'loc-a', '254712345678', 20, 'AA:BB:CC:DD:EE:01', 'paid', 'fiti', 1, null, 'sub-a');
  insertPayment.run('new-a', 'a', 'loc-a', '254712345678', 10, 'AA:BB:CC:DD:EE:01', 'paid', 'fiti', 1, 50, 'sub-a');
  insertPayment.run('own-a', 'a', 'loc-a', '254712345678', 1000, 'AA:BB:CC:DD:EE:01', 'paid', 'own', 0, 0, 'sub-a');
  insertPayment.run('pending-a', 'a', 'loc-a', '254712345678', 5000, 'AA:BB:CC:DD:EE:01', 'pending', 'fiti', 0, 0, 'sub-a');
  insertPayment.run('paid-b', 'b', 'loc-b', '254712345678', 900, 'AA:BB:CC:DD:EE:02', 'paid', 'fiti', 0, 0, 'sub-b');

  for (const route of routes) {
    const response = request(route.method, route.route.replace(/:[^/]+/g, 'unknown'));
    assert.equal(response.status, route.route.startsWith(adminBase) ? 403 : 401, route.route + ' requires authentication');
  }
  const customers = request('GET', base + '/customers', { business: 'a' });
  assert.equal(customers.status, 200);
  assert.deepEqual(customers.body.customers.map(row => row.id), ['sub-a']);
  assert.equal(request('GET', base + '/customers?q=%25', { business: 'a' }).body.customers.length, 0, 'literal wildcard does not match every customer');
  assert.equal(request('GET', base + '/customers/sub-b', { business: 'a' }).status, 404);
  const detail = request('GET', base + '/customers/sub-a', { business: 'a' });
  assert.equal(detail.body.history.length, 4);
  assert.equal(JSON.stringify(detail.body).includes('sensitive-password'), false);

  let balance = request('GET', base + '/payouts', { business: 'a' }).body.balance;
  assert.equal(balance.grossMinor, 3000);
  assert.equal(balance.feeMinor, 150, 'new cents override whole-shilling legacy field; older rows fall back');
  assert.equal(balance.availableMinor, 2850, 'only settled platform collection earns payout balance');
  const first = request('POST', base + '/payouts', { business: 'a', body: payoutBody('first-idempotency-key') });
  assert.equal(first.status, 201);
  assert.equal(first.body.balance.availableMinor, 1850);
  const duplicate = request('POST', base + '/payouts', { business: 'a', body: payoutBody('first-idempotency-key') });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.payout.id, first.body.payout.id);
  assert.equal(duplicate.body.balance.reservedMinor, 1000, 'retry must not reserve again');
  assert.equal(request('POST', base + '/payouts', { business: 'a', body: payoutBody('first-idempotency-key', 1200) }).status, 409, 'key cannot change its amount');
  assert.equal(request('POST', base + '/payouts', { business: 'a', body: payoutBody('second-idempotency-key', 1900) }).status, 409, 'another request cannot overspend reserved balance');
  assert.equal(request('GET', base + '/payouts/' + first.body.payout.id, { business: 'b' }).status, 404);
  assert.equal(request('POST', base + '/payouts/' + first.body.payout.id + '/cancel', { business: 'b' }).status, 404);
  assert.equal(request('POST', base + '/payouts/' + first.body.payout.id + '/cancel', { business: 'a' }).body.balance.availableMinor, 2850);
  const active = request('POST', base + '/payouts', { business: 'a', body: payoutBody('new-active-payout-key', 2000) }).body.payout;
  assert.equal(request('POST', adminBase + '/payouts/' + active.id + '/status', { admin: true, body: { status: 'approved' } }).status, 400);
  assert.equal(request('POST', adminBase + '/payouts/' + active.id + '/status', { admin: true, body: { status: 'paid', externalReference: 'PAY-1' } }).status, 409, 'review precedes payment record');
  assert.equal(request('POST', adminBase + '/payouts/' + active.id + '/status', { admin: true, body: { status: 'approved', externalReference: 'REVIEW-1' } }).status, 200);
  assert.equal(request('POST', base + '/payouts/' + active.id + '/cancel', { business: 'a' }).status, 409);
  const paid = request('POST', adminBase + '/payouts/' + active.id + '/status', { admin: true, body: { status: 'paid', externalReference: 'MPESA-SETTLED-1' } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.payout.status, 'paid');
  assert.match(paid.body.note, /No funds were transferred/);
  balance = request('GET', base + '/payouts', { business: 'a' }).body.balance;
  assert.equal(balance.paidMinor, 2000);
  assert.equal(balance.reservedMinor, 0);
  assert.equal(balance.availableMinor, 850, 'paid money remains consumed after reservation ends');
  const secondBusiness = request('POST', base + '/payouts', { business: 'b', body: payoutBody('another-business-key') }).body.payout;
  request('POST', adminBase + '/payouts/' + secondBusiness.id + '/status', { admin: true, body: { status: 'approved', externalReference: 'REVIEW-2' } });
  assert.equal(request('POST', adminBase + '/payouts/' + secondBusiness.id + '/status', { admin: true, body: { status: 'paid', externalReference: 'MPESA-SETTLED-1' } }).status, 409, 'one external transfer cannot settle multiple requests');
  assert.equal(request('POST', adminBase + '/payouts/' + secondBusiness.id + '/status', { admin: true, body: { status: 'rejected', note: 'Incorrect receiving account' } }).status, 200);
  assert.equal(request('GET', base + '/payouts', { business: 'b' }).body.balance.reservedMinor, 0);

  const ticketPayload = { subject: 'Help with this payment', category: 'payment', locationId: 'loc-a', message: 'Customer paid but cannot connect.' };
  assert.equal(request('POST', base + '/tickets', { business: 'b', body: ticketPayload }).status, 404, 'foreign location cannot be attached');
  const ticket = request('POST', base + '/tickets', { business: 'a', body: ticketPayload }).body.ticket;
  assert.equal(request('GET', base + '/tickets/' + ticket.id, { business: 'b' }).status, 404);
  assert.equal(request('POST', base + '/tickets/' + ticket.id + '/messages', { business: 'b', body: { message: 'Intrusion' } }).status, 404);
  assert.equal(request('POST', adminBase + '/tickets/' + ticket.id + '/messages', { admin: true, body: { message: 'Router connection restored.', status: 'resolved' } }).status, 201);
  let conversation = request('GET', base + '/tickets/' + ticket.id, { business: 'a' }).body;
  assert.equal(conversation.ticket.status, 'resolved');
  assert.deepEqual(conversation.messages.map(message => message.author), ['operator', 'admin']);
  request('POST', base + '/tickets/' + ticket.id + '/messages', { business: 'a', body: { message: 'It happened again.' } });
  assert.equal(request('GET', base + '/tickets/' + ticket.id, { business: 'a' }).body.ticket.status, 'open');

  db.prepare(`INSERT INTO business_billing_transactions(checkout_request_id,business_id,plan,phone,amount,status,activated,mpesa_receipt)
    VALUES('billing-a','a','starter','254712345678',1500,'paid',1,'PLAN123')`).run();
  assert.equal(request('GET', base + '/billing', { business: 'a' }).body.records.length, 0, 'payment without activation grant has no receipt');
  db.prepare(`INSERT INTO business_billing_grants(checkout_request_id,business_id,expires_at) VALUES('billing-a','a',datetime('now','+30 days'))`).run();
  assert.equal(request('GET', base + '/billing', { business: 'a' }).body.records.length, 1);
  assert.equal(request('GET', base + '/billing/billing-a/receipt', { business: 'b' }).status, 404);
  const receipt = request('GET', base + '/billing/billing-a/receipt', { business: 'a' });
  assert.equal(receipt.status, 200);
  assert.match(receipt.body, /Not a statutory tax invoice/);
  assert.match(receipt.body, /KES 1500.00/);
  console.log('Business operations: auth, tenant isolation, exact fees, atomic payout reservations, manual settlement records, support threads and receipts passed.');
} finally {
  db.close();
  // Only this test-created, resolved temporary directory is removed.
  fs.rmSync(directory, { recursive: true, force: true });
}

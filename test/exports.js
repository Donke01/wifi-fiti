/* node test/exports.js - more downloads: customer receipts, PPPoE CSVs, payout statement, plan receipts. */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-exports-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
const tenant = require('../src/lib/tenant');
const team = require('../src/lib/team');
const { toCsv } = require('../src/lib/documents/csv');
const { createPayoutStatement } = require('../src/lib/payout-statement');
// The payout tables are created when the business operations routes attach.
const routes = [];
const fakeApp = new Proxy({}, { get: (_, method) => (path) => routes.push([String(method).toUpperCase(), path]) });
require('../src/lib/business-operations').attachBusinessOperations(fakeApp, { businessAuth: () => null, db: legacy, adminOk: () => false, provisionTenantPayment: () => null });

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 3).join('\n       ')}`); process.exitCode = 1; }
}
console.log('Exports');

t('CSV: quotes, line breaks and spreadsheet formulas are made safe', () => {
  const csv = toCsv(['Name', 'Amount', 'Note'], [['=HYPERLINK("http://x")', -50, 'line one\nline "two"'], ['+254 712', 20, '@SUM(A1)']]);
  assert.ok(csv.startsWith('﻿'), 'starts with a byte order mark for Excel');
  const lines = csv.slice(1).split('\r\n');
  assert.strictEqual(lines[0], 'Name,Amount,Note');
  assert.strictEqual(lines[1], `"'=HYPERLINK(""http://x"")",-50,"line one\nline ""two"""`);
  assert.strictEqual(lines[2], `'+254 712,20,'@SUM(A1)`);
});

legacy.addBusiness.run({ id: 'biz-x', name: 'Kitale Cafe', ownerName: 'Owner', ownerPhone: '254700000000',
  email: 'x@fiti.test', passwordHash: 'x', plan: 'starter', collectionMode: 'fiti' });
tenant.createLocation({ id: 'loc-x', businessId: 'biz-x', name: 'Kitale' });
let n = 0;
function sale({ amount, source = 'fiti', status = 'paid', at, fee }) {
  n += 1; const id = `ws_X${n}`;
  tenant.insertTransaction.run({ checkoutRequestId: id, merchantRequestId: 'm', businessId: 'biz-x', locationId: 'loc-x', phone: '254712345678',
    packageId: 1, packageName: '1 hour', amount, seconds: 3600, rateLimit: null, mac: `AA:BB:CC:00:00:${String(n).padStart(2, '0')}`, ip: null });
  legacy.db.prepare(`UPDATE tenant_transactions SET status=?, payment_source=?, platform_fee=?, platform_fee_minor=?, created_at=? WHERE checkout_request_id=?`)
    .run(status, source, fee / 100, fee, at, id);
}
const ago = (days, hour = '09:00:00') => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10) + ' ' + hour;
sale({ amount: 20, at: ago(2), fee: 100 });
sale({ amount: 50, at: ago(2, '10:00:00'), fee: 250 });
sale({ amount: 30, at: ago(1), source: 'tuma', fee: 150 });
sale({ amount: 999, at: ago(1), source: 'own', fee: 0 });            // own Till: not Wi-Fi Fiti's money
sale({ amount: 40, at: ago(1), status: 'failed', fee: 200 });         // failed: not counted
sale({ amount: 70, at: ago(60), fee: 350 });                          // before the 30-day period
const payout = legacy.db.prepare(`INSERT INTO business_payout_requests (id, business_id, idempotency_key, amount_minor, destination_type, destination_name, destination_account, status, external_reference, created_at)
  VALUES (?, 'biz-x', ?, ?, 'mpesa', 'Morgan Mfo', '254712345678', ?, ?, ?)`);
payout.run('payout-1', 'key-1', 5000, 'paid', 'QWE123', ago(1, '12:00:00'));
payout.run('payout-2', 'key-2', 2000, 'pending', null, ago(1, '13:00:00'));
payout.run('payout-3', 'key-3', 1000, 'rejected', null, ago(1, '14:00:00'));

const statements = createPayoutStatement(legacy.db);
t('payout statement: Wi-Fi Fiti-collected sales per day, after fee, and every payout', () => {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
  const data = statements.statement('biz-x', since);
  const sales = data.lines.filter((line) => line.status === 'Collected');
  assert.deepStrictEqual(sales.map((line) => line.moneyIn), [66.5, 28.5], 'day one: 70 less 3.50 fee; day two: Tuma 30 less 1.50');
  assert.match(sales[0].description, /2 payments, fee KES 3\.5/);
  const payouts = data.lines.filter((line) => line.status !== 'Collected');
  assert.deepStrictEqual(payouts.map((line) => [line.status, line.moneyOut, line.reference]),
    [['Paid', 50, 'QWE123'], ['Waiting for review', 20, ''], ['Rejected', null, '']]);
  assert.match(payouts[0].description, /M-Pesa ••5678/);
  assert.deepStrictEqual(data.period, { collectedNet: 95, fee: 5, paidOut: 50, gross: 100, held: 20, opening: 66.5, closing: 91.5 },
    'opening is the old sale after fee; closing = opening + sales - fees - paid - in review');
  // All time includes the old sale: 66.5 + 28.5 + 66.5 = 161.5 earned.
  assert.deepStrictEqual(data.allTime, { earned: 161.5, paidOut: 50, waiting: 20, available: 91.5 });
});

t('payout statement: report has the period and the Money page balance', () => {
  const spec = statements.reportSpec({ business: legacy.businessById.get('biz-x'), since: '1970-01-01 00:00:00', rangeLabel: 'All time', format: 'pdf' });
  assert.strictEqual(spec.title, 'Payout statement');
  assert.deepStrictEqual(spec.balance.map((item) => [item.op || '', item.value]), [['', 'KES 0.00'], ['+', 'KES 170.00'], ['−', 'KES 8.50'],
    ['−', 'KES 50.00'], ['−', 'KES 20.00'], ['=', 'KES 91.50']], 'opening + sales - fees - paid - in review = the Money page balance');
  assert.strictEqual(spec.rows.length, 7, 'opening line, three sales days, three payouts');
  assert.strictEqual(spec.rows[0].description, 'Opening balance');
  const paid = spec.rows.find((row) => row.status === 'Paid');
  assert.strictEqual(paid.gross, '', 'a payout has no money in');
  assert.strictEqual(spec.rows[spec.rows.length - 1].balance, 91.5, 'the running balance ends on Available');
  assert.strictEqual(spec.rows.find((row) => row.status === 'Rejected').moneyOut, '', 'a rejected payout takes nothing');
  assert.strictEqual(spec.totals.balance, 91.5);
});

t('only the right roles can download each file', () => {
  const route = (method, path) => team.routeFor(method, path);
  const receipt = route('GET', '/api/business/transactions/ws_X1/receipt');
  assert.ok(team.roleCan('attendant', receipt.permission) && team.roleCan('manager', receipt.permission) && team.roleCan('viewer', receipt.permission));
  assert.ok(!team.roleCan('technician', receipt.permission), 'a Technician sees no money');
  const customers = route('GET', '/api/business/pppoe/export/customers');
  assert.ok(team.roleCan('attendant', customers.permission) && !team.roleCan('viewer', customers.permission));
  const pppoePayments = route('GET', '/api/business/pppoe/export/payments');
  assert.ok(team.roleCan('viewer', pppoePayments.permission) && !team.roleCan('attendant', pppoePayments.permission));
  const statement = route('GET', '/api/business/operations/payouts/statement');
  assert.strictEqual(statement.permission, 'owner');
  assert.strictEqual(statement.pattern, '/api/business/operations/payouts/statement', 'not mistaken for a payout id');
  const order = routes.filter((route) => route[0] === 'GET').map((route) => route[1]);
  assert.ok(order.indexOf('/api/business/operations/payouts/statement') < order.indexOf('/api/business/operations/payouts/:payoutId'), 'the statement route answers before the payout-id route');
});

t('receipt slip: hotspot details by default, custom fields for a plan receipt', () => {
  const { receiptData } = require('../src/lib/documents/receipt');
  const hotspot = receiptData({ business: { name: 'Kitale Cafe' }, transaction: { checkout_request_id: 'ws_1', amount: 20, status: 'paid',
    phone: '254712345678', package_name: '1 hour', mpesa_receipt: 'QAB12', location_name: 'Kitale', created_at: '2026-10-01 09:00:00' } });
  assert.strictEqual(hotspot.title, 'Payment receipt');
  assert.deepStrictEqual(hotspot.fields.map((field) => field[0]), ['Receipt number', 'Package', 'Started', 'Hotspot', 'Phone', 'M-Pesa code', 'Confirmed', 'Total paid']);
  assert.deepStrictEqual(hotspot.fields.find((field) => field[0] === 'Phone'), ['Phone', '0712 345 678']);
  const plan = receiptData({ business: null, numberPrefix: 'WFP', title: 'Wi-Fi Fiti plan receipt', footnote: 'Not a statutory tax invoice.',
    transaction: { checkout_request_id: 'ws_2', amount: 1500, status: 'paid' }, fields: [['Plan', 'growth'], ['M-Pesa code', '']] });
  assert.strictEqual(plan.brand.name, 'Wi-Fi Fiti');
  assert.match(plan.number, /^WFP-/);
  assert.deepStrictEqual(plan.fields.slice(1), [['Plan', 'growth'], ['M-Pesa code', '—'], ['Note', 'Not a statutory tax invoice.']]);
  assert.strictEqual(plan.amount, 'KES 1,500');
});

t('table export: a dashboard table becomes an Excel/PDF report with totals', () => {
  const { tableReportSpec, receiptReportSpec } = require('../src/lib/documents/table-export');
  const spec = tableReportSpec({ business: { name: 'Kitale Cafe' }, kind: 'transactions', format: 'pdf', rangeLabel: 'Last 30 days',
    rows: [['Date (UTC)', 'Phone', 'Amount (KES)', 'Status'], ['2026-10-01 09:00', '0712 345 678', 20, 'paid'], ['2026-10-01 10:00', '=CMD()', '50.5', 'paid'], ['2026-10-01 11:00', null, '', 'failed']] });
  assert.strictEqual(spec.title, 'Transactions');
  assert.strictEqual(spec.rangeLabel, 'Last 30 days');
  assert.deepStrictEqual(spec.columns.map((c) => [c.label, c.money]), [['Date (UTC)', false], ['Phone', false], ['Amount', true], ['Status', false]]);
  assert.deepStrictEqual(spec.rows.map((r) => r.c2), [20, 50.5, ''], 'money cells are numbers; a blank stays blank');
  assert.deepStrictEqual(spec.summary, [{ label: 'Rows', value: '3' }, { label: 'Total amount', value: 'KES 70.5' }]);
  assert.deepStrictEqual(spec.totals, { c0: 'Total', c2: 70.5 }, 'a totals line under the money column');
  assert.ok(spec.columns[3].status, 'the Status column gets coloured dots');
  assert.strictEqual(spec.rows[2].c1, '', 'a missing value is blank');
  assert.throws(() => tableReportSpec({ kind: 'secrets', rows: [['A']] }), /Choose a table/);
  assert.throws(() => tableReportSpec({ kind: 'sales', rows: [] }), /nothing to export/);
  assert.throws(() => tableReportSpec({ kind: 'sales', rows: [['A'], ...Array.from({ length: 20001 }, () => ['x'])] }), /Too many rows/);
  const wide = tableReportSpec({ kind: 'customers', rows: [Array.from({ length: 30 }, (_, i) => `Col ${i}`), Array.from({ length: 30 }, () => 'x'.repeat(500))] });
  assert.strictEqual(wide.columns.length, 20, 'at most 20 columns');
  assert.strictEqual(wide.rows[0].c0.length, 300, 'long cells are cut');
  const receipt = receiptReportSpec({ business: null, title: 'Payment receipt', amount: 'KES 20', status: 'PAID', fields: [['Phone', '0712'], ['Note', '']] });
  assert.deepStrictEqual(receipt.rows, [{ field: 'Phone', value: '0712' }, { field: 'Note', value: '—' }]);
});

t('every signed-in role may turn the table it sees into Excel/PDF', () => {
  const route = team.routeFor('POST', '/api/business/reports/table');
  assert.strictEqual(route.permission, 'any');
  for (const role of team.STAFF_ROLES) assert.ok(team.roleCan(role, route.permission));
});

t('the dashboard offers Excel, PDF and CSV for every table export', () => {
  const html = fs.readFileSync(require.resolve('../public/business.html'), 'utf8');
  assert.match(html, /var TABLE_FORMATS = \[\['xlsx', 'Excel \(\.xlsx\)'\], \['pdf', 'PDF'\], \['csv', 'CSV'\]\];/);
  for (const kind of ['packages', 'sales', 'transactions', 'vouchers', 'customers', 'analytics']) assert.match(html, new RegExp(`data-export-table="${kind}">[^<]*▾</button>`), kind);
  assert.match(html, /\[\['pdf', 'PDF'\], \['xlsx', 'Excel \(\.xlsx\)'\], \['docx', 'Word \(\.docx\)'\]\]/, 'customer receipts');
  assert.match(html, /\[\['pdf', 'PDF'\], \['xlsx', 'Excel \(\.xlsx\)'\]\], function \(format\) \{ downloadPlanReceipt/, 'plan receipts');
  const pppoe = fs.readFileSync(require.resolve('../public/pppoe.html'), 'utf8');
  assert.match(pppoe, /\[\['xlsx', 'Excel \(\.xlsx\)'\], \['pdf', 'PDF'\], \['csv', 'CSV'\]\]/);
});

console.log(`\n${pass} passed`);

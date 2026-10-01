/* node test/documents.js - receipts and reports: layout, numbers, PDF and Excel output. */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-documents-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
const tenant = require('../src/lib/tenant');
const { measure } = require('./helpers/doc-measure');
const { receiptData, buildReceiptPdf, duration, speed } = require('../src/lib/documents/receipt');
const { receiptLayout } = require('../src/lib/documents/layout-receipt');
const { reportLayout } = require('../src/lib/documents/layout-report');
const { buildReportPdf, buildReportXlsx, reportBrand } = require('../src/lib/documents/report');
const { cleanText } = require('../src/lib/documents/canvas');
const qrcodegen = require('../src/lib/documents/qrcodegen');
const { createReportData, change } = require('../src/lib/report-data');
const { createPayoutStatement } = require('../src/lib/payout-statement');

let pass = 0;
const pending = [];
function t(name, fn) {
  const done = () => { pass += 1; console.log(`  ok   ${name}`); };
  const failed = (error) => { console.log(`  FAIL ${name}\n       ${String(error.stack).split('\n').slice(0, 4).join('\n       ')}`); process.exitCode = 1; };
  try { const result = fn(); if (result && result.then) pending.push(result.then(done, failed)); else done(); } catch (error) { failed(error); }
}

/** Every text run inside the page, and no two text runs drawn over each other. */
function checkPage(page, label) {
  const boxes = [];
  let dx = 0; let dy = 0;
  for (const o of page.ops) {
    if (o.op === 'push') { dx += o.dx; dy += o.dy; }
    if (o.op === 'pop') { dx = 0; dy = 0; }
    if (o.op !== 'text') continue;
    const w = measure(o.text, o.size, o.weight) + (o.spacing || 0) * (o.text.length - 1);
    const box = { x1: o.x + dx, y1: o.y + dy - o.size * 0.74, x2: o.x + dx + w, y2: o.y + dy + o.size * 0.2, text: o.text };
    assert.ok(box.x1 >= -0.5 && box.x2 <= page.width + 0.5 && box.y1 >= 0 && box.y2 <= page.height, `${label}: "${o.text}" is off the page`);
    for (const other of boxes) {
      const ix = Math.min(box.x2, other.x2) - Math.max(box.x1, other.x1);
      const iy = Math.min(box.y2, other.y2) - Math.max(box.y1, other.y1);
      assert.ok(!(ix > 1 && iy > 1), `${label}: "${o.text}" overlaps "${other.text}"`);
    }
    boxes.push(box);
  }
  return boxes;
}
const texts = (page) => page.ops.filter((o) => o.op === 'text').map((o) => o.text);

console.log('Documents');

const now = new Date('2026-10-01T06:25:00Z');
const business = { id: 'biz-d', business_name: 'Kitale Cafe', portal_name: 'Kitale Cafe Wi-Fi', support_phone: '0712 345 678', brand_primary_color: '#5B3FC4' };
const paid = { checkout_request_id: 'ws_CO_1', phone: '254712345678', package_name: '24 Hours', amount: 50, seconds: 86400, rate_limit: '5M/10M',
  mac: 'a4:30:7a:1c:5e:02', ip: '10.5.50.23', device_type: 'phone', device_label: 'Galaxy A14', status: 'paid', mpesa_receipt: 'SJK3XYZ123',
  created_at: '2026-10-01 06:12:00', updated_at: '2026-10-01 06:12:41', location_name: 'Kitale Stage', router_name: 'Kitale-Stage-hAP',
  wifi_ssid: 'KitaleCafe-WiFi', payment_source: 'fiti', recovery_code: 'K7MX4Q', portal_url: 'https://kitale-stage.wififiti.co.ke' };

t('time and speed read like people say them', () => {
  assert.strictEqual(duration(3600), '1 hour');
  assert.strictEqual(duration(86400), '24 hours');
  assert.strictEqual(duration(604800), '7 days');
  assert.strictEqual(duration(5400), '1 h 30 min');
  assert.strictEqual(speed('5M/10M'), 'Up to 10 Mbps down, 5 up', 'RouterOS rx/tx is upload/download for the customer');
  assert.strictEqual(speed('512k/2M'), 'Up to 2 Mbps down, 512k up');
  assert.strictEqual(speed(''), '');
});

t('a customer receipt carries the Wi-Fi, device, payment, recovery code and reconnect steps', () => {
  const d = receiptData({ business, transaction: paid, audience: 'customer', now });
  const page = receiptLayout(d, measure);
  checkPage(page, 'customer receipt');
  const all = texts(page);
  for (const expected of ['Kitale Cafe Wi-Fi', 'KES 50', 'Paid', 'Up to 10 Mbps down, 5 up', 'Phone, Galaxy A14', 'A4:30:7A:1C:5E:02', '10.5.50.23',
    'Kitale-Stage-hAP', 'KitaleCafe-WiFi', '0712 345 678', 'SJK3XYZ123', 'KES 50.00', 'K7MX4Q', 'Reconnect in 3 steps', 'Time left', '23 h 48 min']) {
    assert.ok(all.includes(expected), `shows ${expected}`);
  }
  assert.ok(page.ops.some((o) => o.op === 'path' && o.fill && o.d.length > 500), 'a QR code is drawn');
  assert.ok(page.height > 700 && page.width === 388, 'the page is as tall as the ticket');
});

t('a business download leaves out the customer recovery code', () => {
  const page = receiptLayout(receiptData({ business, transaction: paid, audience: 'business', now }), measure);
  checkPage(page, 'business receipt');
  assert.ok(!texts(page).some((text) => text.includes('K7MX4Q')), 'no recovery code');
  assert.ok(texts(page).includes('Customer paid'));
});

t('a pending payment says what happens next; a long name and amount still fit', () => {
  const d = receiptData({ business: { ...business, portal_name: 'The Very Long Named Riverside Hotel and Conference Centre Wi-Fi' },
    transaction: { ...paid, status: 'pending', mpesa_receipt: null, amount: 1250000, package_name: 'Monthly unlimited family bundle with extras' }, audience: 'customer', now });
  const page = receiptLayout(d, measure);
  checkPage(page, 'pending receipt');
  const all = texts(page);
  assert.ok(all.includes('Waiting for M-Pesa') && all.includes('Not received yet') && all.includes('As soon as M-Pesa confirms'));
  assert.ok(!all.includes('Reconnect in 3 steps'), 'no reconnect steps before payment');
});

t('the QR code encodes the address (finder patterns in three corners)', () => {
  const code = qrcodegen.QrCode.encodeText('https://kitale-stage.wififiti.co.ke', qrcodegen.QrCode.Ecc.MEDIUM);
  const n = code.size;
  for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    assert.ok(code.getModule(x, y) && code.getModule(x + 6, y + 6) && !code.getModule(x + 1, y + 1) && code.getModule(x + 3, y + 3));
  }
});

t('text the font cannot draw is cleaned, look-alikes kept', () => {
  assert.strictEqual(cleanText('Paid ✓\u0007 KES 50 – 1 Oct'), 'Paid Yes  KES 50 – 1 Oct');
  assert.strictEqual(cleanText('😀Kitale'), 'Kitale');
});

t('the receipt PDF is built with the embedded font', () => buildReceiptPdf({ business, transaction: paid, audience: 'customer', now }).then((buffer) => {
  assert.ok(Buffer.isBuffer(buffer) && buffer.slice(0, 4).toString() === '%PDF');
}));

// ---------------------------------------------------------------- reports
legacy.addBusiness.run({ id: 'biz-r', name: 'Kitale Cafe', ownerName: 'Morgan', ownerPhone: '254712345678', email: 'r@fiti.test', passwordHash: 'x', plan: 'starter', collectionMode: 'fiti' });
tenant.createLocation({ id: 'loc-a', businessId: 'biz-r', name: 'Kitale Stage' });
tenant.createLocation({ id: 'loc-b', businessId: 'biz-r', name: 'Eldoret Market' });
const reportNow = new Date('2026-10-01T20:30:00Z');
let n = 0;
function sale({ daysAgo, hour, amount = 50, pkg = '24 hours', seconds = 86400, mac, status = 'paid', location = 'loc-a', source = 'fiti', device = 'phone' }) {
  n += 1;
  const at = new Date(reportNow.getTime() - daysAgo * 86400_000); at.setUTCHours(hour, 0, 0, 0);
  tenant.insertTransaction.run({ checkoutRequestId: `ws_R${n}`, merchantRequestId: 'm', businessId: 'biz-r', locationId: location, phone: '254712000' + String(n).padStart(3, '0'),
    packageId: 1, packageName: pkg, amount, seconds, rateLimit: null, mac: mac || `AA:00:00:00:00:${String(n % 90).padStart(2, '0')}`, ip: null });
  legacy.db.prepare(`UPDATE tenant_transactions SET status=?, payment_source=?, device_type=?, mpesa_receipt=?, platform_fee_minor=?, created_at=? WHERE checkout_request_id=?`)
    .run(status, source, device, status === 'paid' ? `SJ${n}` : null, Math.round(amount * 5), at.toISOString().replace('T', ' ').slice(0, 19), `ws_R${n}`);
}
// This period (last 30 days): 60 sales; the 30 days before: 40.
for (let i = 0; i < 60; i += 1) sale({ daysAgo: i % 28, hour: 14 + (i % 5), amount: i % 3 ? 50 : 20, pkg: i % 3 ? '24 hours' : '1 hour', location: i % 4 ? 'loc-a' : 'loc-b', source: i % 2 ? 'fiti' : 'tuma', device: i % 10 ? 'phone' : 'tv', mac: `AA:00:00:00:01:${String(i % 25).padStart(2, '0')}` });
for (let i = 0; i < 40; i += 1) sale({ daysAgo: 31 + (i % 25), hour: 10, amount: 50, mac: `AA:00:00:00:01:${String(i % 10).padStart(2, '0')}` });
sale({ daysAgo: 2, hour: 9, amount: 30, status: 'failed' });
sale({ daysAgo: 1, hour: 9, amount: 20, status: 'pending' });
const biz = legacy.db.prepare(`SELECT * FROM businesses WHERE id='biz-r'`).get();
const data = createReportData(legacy.db);

t('changes against the period before read plainly', () => {
  assert.deepStrictEqual(change(112, 100), { text: '+12%', good: true });
  assert.deepStrictEqual(change(4, 5, { betterWhenLower: true }), { text: '-20%', good: true });
  assert.deepStrictEqual(change(64, 61, { money: true }), { text: '+KES 3', good: true });
  assert.deepStrictEqual(change(5, 0), { text: 'New this period', good: true });
  assert.strictEqual(change(0, 0), null);
});

t('revenue: figures, each day, packages, hotspots, hours and customers all add up', () => {
  const spec = data.revenueSpec({ business: biz, now: reportNow, generatedBy: 'Morgan' });
  const gross = 40 * 50 + 20 * 20;
  assert.strictEqual(spec.summary[0].value, `KES ${gross.toLocaleString('en-KE')}`);
  assert.deepStrictEqual(spec.summary[0].change, { text: '+20%', good: true }, 'vs 40 x KES 50 the period before');
  assert.strictEqual(spec.summary[1].value, '60');
  assert.strictEqual(spec.daily.points.reduce((s, p) => s + p.value, 0), gross, 'the daily chart adds up to Collected');
  assert.deepStrictEqual(spec.rows.map((r) => [r.package, r.count, r.amount]), [['24 hours', 40, 2000], ['1 hour', 20, 400]]);
  assert.strictEqual(spec.totals.amount, gross);
  const hotspots = spec.breakdowns.find((b) => b.title === 'By hotspot');
  assert.strictEqual(hotspots.rows.reduce((s, r) => s + r.share, 0), gross);
  assert.strictEqual(spec.heatmap.rows.flatMap((r) => r.values).reduce((a, b) => a + b, 0), 60, 'every paid payment is in the busiest hours');
  assert.ok(spec.heatmap.rows.every((r) => r.values.slice(0, 17).every((v) => !v)), 'sales at 14-18 UTC show at 5-9 pm Kenya time');
  assert.strictEqual(spec.customers.ring.value, '25 customers', 'all 25 came back (10 paid before, the rest paid more than once)');
  assert.strictEqual(spec.customers.stats.find((s) => s.label === 'Not collected').value, 'KES 30');
  for (const [i, page] of reportLayout({ ...spec, generatedLabel: 'Made today' }, measure, reportBrand(biz)).entries()) checkPage(page, `revenue page ${i + 1}`);
});

t('transactions: every row, paid-only total, and pages that repeat the header', () => {
  const spec = data.ledgerSpec({ business: biz, now: reportNow });
  assert.strictEqual(spec.rows.length, 62);
  assert.strictEqual(spec.totals.amount, 2400, 'failed and pending are listed but not counted');
  assert.ok(spec.rows.some((r) => r.status === 'Failed') && spec.rows.some((r) => r.status === 'Pending'));
  assert.strictEqual(spec.rows[0].phone.replace(/\d/g, '#'), '#### ### ###', 'phones in local format');
  const pages = reportLayout({ ...spec, generatedLabel: 'Made today' }, measure, reportBrand(biz));
  assert.ok(pages.length >= 2, 'a long list continues on more pages');
  pages.forEach((page, i) => {
    checkPage(page, `transactions page ${i + 1}`);
    assert.ok(texts(page).includes(`Page ${i + 1} of ${pages.length}`));
    assert.ok(texts(page).includes('M-Pesa code') || !texts(page).some((x) => /^SJ\d+$/.test(x)), 'rows always sit under a header');
  });
});

t('reports build as PDF and as Excel with filters, totals, data bars and extra sheets', () => {
  const spec = data.ledgerSpec({ business: biz, now: reportNow, generatedBy: 'Morgan' });
  const ExcelJS = require('exceljs');
  const builds = [buildReportPdf(spec), buildReportXlsx(spec), buildReportXlsx(data.revenueSpec({ business: biz, now: reportNow }))];
  const wb = ExcelJS.Workbook.last; // the test stand-in records the last workbook made
  return Promise.all(builds).then(([pdf, xlsx, revenue]) => {
    assert.strictEqual(pdf.slice(0, 4).toString(), '%PDF');
    assert.ok(Buffer.isBuffer(xlsx) && Buffer.isBuffer(revenue));
    if (!wb) return; // the real exceljs: the buffers are the check
    assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['Revenue', 'By hotspot', 'Paid to', 'Device', 'By day', 'Busiest hours', 'Customers']);
    assert.ok(wb.sheets[5].cf[0].rules[0].type === 'colorScale', 'busiest hours are shaded');
  });
});

t('the transactions sheet totals paid payments with a formula and filters on the header', () => {
  const ExcelJS = require('exceljs');
  if (!('last' in ExcelJS.Workbook)) return; // only the test stand-in records what was written
  const spec = data.ledgerSpec({ business: biz, now: reportNow });
  const built = buildReportXlsx(spec);
  const wb = ExcelJS.Workbook.last;
  return built.then(() => {
    const sheet = wb.sheets[0];
    assert.deepStrictEqual(sheet.autoFilter, { from: { row: 8, column: 1 }, to: { row: 8, column: 11 } });
    const total = sheet.getCell(8 + spec.rows.length + 2, 11).value;
    assert.match(total.formula, /^SUMIFS\(K9:K70,H9:H70,"Paid"\)$/);
    assert.strictEqual(total.result, 2400);
    assert.ok(sheet.cf.some((cf) => cf.rules[0].type === 'dataBar' && cf.ref === 'K9:K70'));
  });
});

t('payout statement: opening balance + sales - fees - payouts = Available, line by line', () => {
  const fakeApp = new Proxy({}, { get: () => () => {} });
  require('../src/lib/business-operations').attachBusinessOperations(fakeApp, { businessAuth: () => null, db: legacy, adminOk: () => false, provisionTenantPayment: () => null });
  const ago = (d) => new Date(reportNow.getTime() - d * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
  const pay = legacy.db.prepare(`INSERT INTO business_payout_requests (id, business_id, idempotency_key, amount_minor, destination_type, destination_name, destination_account, status, external_reference, created_at)
    VALUES (?, 'biz-r', ?, ?, 'mpesa', 'Morgan', '254712345678', ?, ?, ?)`);
  pay.run('po-1', 'k1', 100000, 'paid', 'QWE1', ago(40));
  pay.run('po-2', 'k2', 50000, 'paid', 'QWE2', ago(10));
  pay.run('po-3', 'k3', 20000, 'pending', null, ago(2));
  pay.run('po-4', 'k4', 9000, 'rejected', null, ago(1));
  const statements = createPayoutStatement(legacy.db);
  const since = ago(30);
  const spec = statements.reportSpec({ business: biz, since, rangeLabel: 'Last 30 days' });
  const all = statements.statement('biz-r', since);
  const num = (text) => Number(String(text).replace(/[^\d.]/g, ''));
  const [opening, sales, fees, out, held, available] = spec.balance.map((b) => num(b.value));
  assert.strictEqual(Math.round((opening + sales - fees - out - held) * 100), Math.round(available * 100));
  assert.strictEqual(available, all.allTime.available, 'matches the Money page');
  assert.strictEqual(spec.rows[spec.rows.length - 1].balance, available, 'the running balance ends on it');
  assert.strictEqual(spec.lists[0].items[0].label, 'M-Pesa ending 5678, Morgan');
  const pages = reportLayout({ ...spec, generatedLabel: 'Made today' }, measure, reportBrand(biz));
  pages.forEach((page, i) => checkPage(page, `statement page ${i + 1}`));
  return buildReportPdf(spec).then((pdf) => assert.strictEqual(pdf.slice(0, 4).toString(), '%PDF'));
});

Promise.all(pending).then(() => console.log(`\n${pass} passed`));

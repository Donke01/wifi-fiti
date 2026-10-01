'use strict';

/*
 * The numbers behind the revenue report and the transactions report:
 * headline figures compared with the period before, money per day, sales
 * by package, hotspot, payment destination and device, the busiest hours
 * and customer figures. Everything is read from tenant_transactions for
 * one business, with days and hours in Kenya time (UTC+3).
 *
 * Returns report specs for documents/report.js (see the field list there).
 */

const EAT = "'+3 hours'";
const DAY_MS = 86400_000;
const PAID_TO = { fiti: 'Wi-Fi Fiti M-Pesa', own: 'Own Till or PayBill', tuma: 'Tuma', tuma_direct: 'Tuma', c2b: 'PayBill' };
const DEVICES = { phone: 'Phones', tv: 'TVs', laptop: 'Laptops', tablet: 'Tablets' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const sqlTime = (date) => date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
const kes = (n) => 'KES ' + Math.round(Number(n) || 0).toLocaleString('en-KE');
const count = (n) => Math.round(Number(n) || 0).toLocaleString('en-KE');
const plural = (n, word) => `${count(n)} ${word}${Number(n) === 1 ? '' : 's'}`;
const maskPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return String(phone || '');
  const local = digits.startsWith('254') ? `0${digits.slice(3)}` : digits;
  return `${local.slice(0, 4)} *** ${local.slice(-3)}`;
};
const phoneText = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  const local = digits.startsWith('254') && digits.length === 12 ? `0${digits.slice(3)}` : digits;
  return local.length === 10 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : String(phone || '');
};
/** "1 Oct" style label for a Kenya-time day string "2026-10-01". */
const dayLabel = (day, withYear) => {
  const [y, m, d] = String(day).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
};
/** Kenya-time "9:12 am" and "1 Oct" for a SQL UTC time. */
function eatParts(sql) {
  const at = new Date(String(sql).replace(' ', 'T') + 'Z');
  if (Number.isNaN(at.getTime())) return { day: '', time: '' };
  const k = new Date(at.getTime() + 3 * 3600_000);
  const h = k.getUTCHours();
  return {
    day: `${k.getUTCDate()} ${MONTHS[k.getUTCMonth()]}`,
    time: `${h % 12 || 12}:${String(k.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`,
  };
}

/** Change against the period before: "+12%", or a plain difference for small numbers. */
function change(now, before, { money = false, betterWhenLower = false, suffix = '' } = {}) {
  now = Number(now) || 0; before = Number(before) || 0;
  if (!before && !now) return null;
  if (!before) return { text: 'New this period', good: !betterWhenLower };
  const diff = now - before;
  if (Math.abs(diff) < 1e-9) return { text: 'Same as before', good: null };
  const good = betterWhenLower ? diff < 0 : diff > 0;
  if (money) return { text: `${diff > 0 ? '+' : '-'}${kes(Math.abs(diff))}${suffix}`, good };
  const pct = Math.round((diff / before) * 100);
  return { text: `${pct > 0 ? '+' : ''}${pct}%${suffix}`, good };
}

function createReportData(db) {
  const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  const deviceCol = has('tenant_transactions', 'device_type') ? "COALESCE(t.device_type,'phone')" : "'phone'";

  const totals = db.prepare(`SELECT COUNT(*) AS payments, COALESCE(SUM(amount),0) AS gross, COUNT(DISTINCT mac) AS customers,
      COALESCE(SUM(seconds),0) AS seconds
    FROM tenant_transactions WHERE business_id=? AND status='paid' AND created_at >= ? AND created_at < ?`);
  const failed = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM tenant_transactions
    WHERE business_id=? AND status NOT IN ('paid','pending','processing') AND created_at >= ? AND created_at < ?`);
  const byDay = db.prepare(`SELECT date(created_at, ${EAT}) AS day, COALESCE(SUM(amount),0) AS gross, COUNT(*) AS payments
    FROM tenant_transactions WHERE business_id=? AND status='paid' AND created_at >= ? GROUP BY day`);
  const byPackage = db.prepare(`SELECT package_name AS name, COUNT(*) AS n, COALESCE(SUM(amount),0) AS gross
    FROM tenant_transactions WHERE business_id=? AND status='paid' AND created_at >= ? GROUP BY package_name ORDER BY gross DESC, n DESC`);
  const byHotspot = db.prepare(`SELECT l.name, COUNT(t.checkout_request_id) AS n, COALESCE(SUM(t.amount),0) AS gross
    FROM locations l LEFT JOIN tenant_transactions t ON t.location_id=l.id AND t.status='paid' AND t.created_at >= ?
    WHERE l.business_id=? GROUP BY l.id ORDER BY gross DESC, l.name`);
  const bySource = db.prepare(`SELECT payment_source AS source, COUNT(*) AS n, COALESCE(SUM(amount),0) AS gross
    FROM tenant_transactions WHERE business_id=? AND status='paid' AND created_at >= ? GROUP BY payment_source ORDER BY gross DESC`);
  const byDevice = db.prepare(`SELECT ${deviceCol} AS device, COUNT(*) AS n, COALESCE(SUM(t.amount),0) AS gross
    FROM tenant_transactions t WHERE t.business_id=? AND t.status='paid' AND t.created_at >= ? GROUP BY device ORDER BY n DESC`);
  const hours = db.prepare(`SELECT CAST(strftime('%w', created_at, ${EAT}) AS INTEGER) AS wd, CAST(strftime('%H', created_at, ${EAT}) AS INTEGER) AS hr, COUNT(*) AS n
    FROM tenant_transactions WHERE business_id=? AND status='paid' AND created_at >= ? GROUP BY wd, hr`);
  const returning = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT mac FROM tenant_transactions WHERE business_id=? AND status='paid' AND created_at >= ?
      GROUP BY mac HAVING COUNT(*) > 1 OR mac IN (SELECT mac FROM tenant_transactions WHERE business_id=? AND status='paid' AND created_at < ?))`);
  const newCustomers = db.prepare(`SELECT COUNT(DISTINCT mac) AS n FROM tenant_transactions t WHERE business_id=? AND status='paid' AND created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM tenant_transactions p WHERE p.business_id=t.business_id AND p.mac=t.mac AND p.status='paid' AND p.created_at < ?)`);
  const returningGross = db.prepare(`SELECT COALESCE(SUM(amount),0) AS gross FROM tenant_transactions t WHERE business_id=? AND status='paid' AND created_at >= ?
      AND (EXISTS (SELECT 1 FROM tenant_transactions p WHERE p.business_id=t.business_id AND p.mac=t.mac AND p.status='paid' AND p.created_at < ?)
        OR (SELECT COUNT(*) FROM tenant_transactions q WHERE q.business_id=t.business_id AND q.mac=t.mac AND q.status='paid' AND q.created_at >= ?) > 1)`);
  const topCustomer = db.prepare(`SELECT phone, COUNT(*) AS n, COALESCE(SUM(amount),0) AS gross FROM tenant_transactions
    WHERE business_id=? AND status='paid' AND created_at >= ? GROUP BY mac ORDER BY n DESC, gross DESC LIMIT 1`);
  const ledgerRows = db.prepare(`SELECT t.checkout_request_id, l.name AS location_name, t.phone, ${deviceCol} AS device, t.package_name, t.amount, t.seconds,
      t.status, t.payment_source, t.mpesa_receipt, t.created_at, t.updated_at
    FROM tenant_transactions t JOIN locations l ON l.id=t.location_id
    WHERE t.business_id=? AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT ?`);
  const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM locations WHERE business_id=?) AS hotspots,
      (SELECT COUNT(*) FROM tenant_transactions WHERE business_id=? AND created_at >= ?) AS rows`);

  function period(days, now = new Date()) {
    const since = new Date(now.getTime() - days * DAY_MS);
    const before = new Date(now.getTime() - 2 * days * DAY_MS);
    return { now, since, before, sinceSql: sqlTime(since), beforeSql: sqlTime(before), nowSql: sqlTime(new Date(now.getTime() + 60_000)) };
  }
  const rangeLabel = (p) => {
    const day = (d) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
    const a = day(p.since); const b = day(p.now);
    return a.slice(0, 4) === b.slice(0, 4) ? `${dayLabel(a)} to ${dayLabel(b, true)}` : `${dayLabel(a, true)} to ${dayLabel(b, true)}`;
  };

  /** One value per Kenya-time day from `since` to now, zero-filled. */
  function dailySeries(businessId, p) {
    const found = new Map(byDay.all(businessId, p.sinceSql).map((row) => [row.day, row]));
    const points = [];
    const start = new Date(p.since.getTime() + 3 * 3600_000); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(p.now.getTime() + 3 * 3600_000);
    for (let d = start; d <= end; d = new Date(d.getTime() + DAY_MS)) {
      const key = d.toISOString().slice(0, 10);
      const row = found.get(key);
      const [, , dd] = key.split('-').map(Number);
      points.push({ day: key, label: dd === 1 || !points.length ? dayLabel(key) : String(dd), fullLabel: dayLabel(key, true),
        value: row ? Number(row.gross) : 0, payments: row ? Number(row.payments) : 0 });
    }
    return points;
  }

  function breakdowns(businessId, p) {
    const hotspot = byHotspot.all(p.sinceSql, businessId).filter((row) => row.gross > 0 || row.n > 0);
    const source = bySource.all(businessId, p.sinceSql);
    const device = byDevice.all(businessId, p.sinceSql);
    const merged = new Map();
    for (const row of source) {
      const label = PAID_TO[row.source] || String(row.source || 'Other');
      const prev = merged.get(label) || { n: 0, gross: 0 };
      merged.set(label, { n: prev.n + row.n, gross: prev.gross + Number(row.gross) });
    }
    return [
      { title: 'By hotspot', labelHeader: 'Hotspot', rows: hotspot.map((row) => ({ label: row.name, value: kes(row.gross), share: Number(row.gross), note: plural(row.n, 'payment') })) },
      { title: 'Paid to', labelHeader: 'Paid to', rows: [...merged].map(([label, row]) => ({ label, value: kes(row.gross), share: row.gross, note: '' })) },
      { title: 'Device', labelHeader: 'Device', valueHeader: 'Payments', money: false, rows: device.map((row) => ({ label: DEVICES[row.device] || 'Other', value: count(row.n), share: Number(row.n), note: '' })) },
    ];
  }

  function headline(businessId, p) {
    const now = totals.get(businessId, p.sinceSql, p.nowSql);
    const prev = totals.get(businessId, p.beforeSql, p.sinceSql);
    const lost = failed.get(businessId, p.sinceSql, p.nowSql);
    const lostPrev = failed.get(businessId, p.beforeSql, p.sinceSql);
    const avg = now.payments ? now.gross / now.payments : 0;
    const avgPrev = prev.payments ? prev.gross / prev.payments : 0;
    const fresh = newCustomers.get(businessId, p.sinceSql, p.sinceSql).n;
    return { now, prev, lost, lostPrev, avg, avgPrev, fresh };
  }

  function revenueSpec({ business, days = 30, generatedBy, now }) {
    const p = period(days, now);
    const h = headline(business.id, p);
    const daily = dailySeries(business.id, p);
    const best = daily.reduce((a, b) => (b.value > a.value ? b : a), daily[0] || { value: 0 });
    const packages = byPackage.all(business.id, p.sinceSql);
    const totalGross = Number(h.now.gross) || 0;
    const grid = WEEKDAYS.map((label) => ({ label, values: Array(24).fill(0) }));
    for (const row of hours.all(business.id, p.sinceSql)) grid[(row.wd + 6) % 7].values[row.hr] = Number(row.n);
    const back = returning.get(business.id, p.sinceSql, business.id, p.sinceSql).n;
    const backGross = returningGross.get(business.id, p.sinceSql, p.sinceSql, p.sinceSql).gross;
    const top = topCustomer.get(business.id, p.sinceSql);
    const c = counts.get(business.id, business.id, p.sinceSql);
    return {
      business, title: 'Revenue', rangeLabel: rangeLabel(p), generatedAt: p.now.toISOString(), generatedBy,
      compareLabel: `Compared with the ${days} days before`, orientation: 'portrait',
      filters: [`Hotspots: all ${c.hotspots}`, `Packages: all ${packages.length}`, 'Paid payments only'],
      summary: [
        { label: 'Collected', value: kes(totalGross), change: change(totalGross, h.prev.gross) },
        { label: 'Payments', value: count(h.now.payments), change: change(h.now.payments, h.prev.payments) },
        { label: 'Customers', value: count(h.now.customers), change: h.fresh ? { text: `+${count(h.fresh)} new`, good: true } : change(h.now.customers, h.prev.customers) },
        { label: 'Average sale', value: kes(h.avg), change: h.avgPrev ? change(h.avg, h.avgPrev, { money: true }) : null },
      ],
      daily: { title: 'Collected each day', aside: best && best.value ? `Best day ${best.fullLabel}, ${kes(best.value)}` : '', points: daily },
      tableTitle: 'By package', tableAside: plural(packages.length, 'package'),
      columns: [
        { key: 'package', label: 'Package', width: 26 },
        { key: 'count', label: 'Sold', width: 10, align: 'right' },
        { key: 'share', label: 'Share', width: 9, align: 'right' },
        { key: 'amount', label: 'Revenue', width: 40, align: 'right', money: true, bar: true },
      ],
      rows: packages.map((row) => ({ package: row.name || 'Package', count: Number(row.n), share: totalGross ? `${Math.round((row.gross / totalGross) * 100)}%` : '0%', amount: Number(row.gross) })),
      totals: { package: 'Total', count: count(h.now.payments), share: '100%', amount: totalGross },
      breakdowns: breakdowns(business.id, p),
      heatmap: { title: 'Busiest hours', rows: grid },
      customers: h.now.customers ? {
        title: 'Customers', aside: totalGross ? `Returning customers paid ${Math.round((backGross / totalGross) * 100)}% of revenue` : '',
        ring: { fraction: back / h.now.customers, label: 'Came back', value: plural(back, 'customer'), note: `${count(h.fresh)} new this period` },
        stats: [
          { label: 'Wi-Fi time sold', value: `${Math.round(h.now.seconds / 3600).toLocaleString('en-KE')} h`, note: `${(h.now.seconds / 3600 / h.now.customers).toFixed(1)} h a customer` },
          { label: 'Top customer', value: top ? plural(top.n, 'payment') : '', note: top ? maskPhone(top.phone) : '' },
          { label: 'Not collected', value: kes(h.lost.amount), note: `${count(h.lost.n)} failed` },
          { label: 'Busiest day', value: best && best.value ? best.fullLabel : 'None yet', note: best && best.value ? plural(best.payments, 'payment') : '' },
        ],
      } : null,
      notes: ['Revenue is paid payments, before Wi-Fi Fiti fees. Days and hours are Kenya time.'],
    };
  }

  function ledgerSpec({ business, days = 30, generatedBy, now, limit = 2000 }) {
    const p = period(days, now);
    const h = headline(business.id, p);
    const daily = dailySeries(business.id, p);
    const list = ledgerRows.all(business.id, p.sinceSql, limit);
    const c = counts.get(business.id, business.id, p.sinceSql);
    const status = (s) => ({ paid: 'Paid', pending: 'Pending', processing: 'Pending', failed: 'Failed', cancelled: 'Cancelled', refunded: 'Refunded' }[s] || String(s || '').replace(/^\w/, (x) => x.toUpperCase()));
    const rows = list.map((row) => {
      const at = eatParts(row.created_at);
      const ends = row.status === 'paid' && row.seconds ? eatParts(sqlTime(new Date(new Date(String(row.created_at).replace(' ', 'T') + 'Z').getTime() + row.seconds * 1000))) : null;
      return {
        date: at.day, time: at.time, location: row.location_name || '', phone: phoneText(row.phone), device: (DEVICES[row.device] || 'Other').replace(/s$/, ''),
        package: row.package_name || '', paidTo: (PAID_TO[row.payment_source] || '').replace('Wi-Fi Fiti M-Pesa', 'Wi-Fi Fiti').replace('Own Till or PayBill', 'Own till'),
        status: status(row.status), receipt: row.mpesa_receipt || '—', ends: ends ? `${ends.day}, ${ends.time}` : '—', amount: Number(row.amount) || 0,
      };
    });
    const paidRows = rows.filter((row) => row.status === 'Paid');
    return {
      business, title: 'Transactions', rangeLabel: rangeLabel(p), generatedAt: p.now.toISOString(), generatedBy,
      compareLabel: `Compared with the ${days} days before`, orientation: 'landscape',
      filters: [`Hotspots: all ${c.hotspots}`, 'Status: all', rows.length < c.rows ? `${count(rows.length)} of ${count(c.rows)} rows shown` : `${plural(rows.length, 'row')}`],
      summary: [
        { label: 'Collected', value: kes(h.now.gross), change: change(h.now.gross, h.prev.gross, { suffix: ' vs before' }) },
        { label: 'Payments', value: count(h.now.payments), change: change(h.now.payments, h.prev.payments) },
        { label: 'Customers', value: count(h.now.customers), change: h.fresh ? { text: `+${count(h.fresh)} new`, good: true } : null },
        { label: 'Failed', value: count(h.lost.n), change: change(h.lost.n, h.lostPrev.n, { betterWhenLower: true }) },
        { label: 'Average sale', value: kes(h.avg), change: h.avgPrev ? change(h.avg, h.avgPrev, { money: true }) : null },
      ],
      spark: { title: 'Collected each day', values: daily.map((d) => d.value), from: daily.length ? daily[0].fullLabel : '', to: daily.length ? daily[daily.length - 1].fullLabel : '' },
      daily: { sheetTitle: 'By day', points: daily, title: 'Collected each day', excelOnly: true },
      columns: [
        { key: 'date', label: 'Date', width: 6 }, { key: 'time', label: 'Time', width: 6.5, muted: true },
        { key: 'location', label: 'Hotspot', width: 11 }, { key: 'phone', label: 'Phone', width: 10 },
        { key: 'device', label: 'Device', width: 6.5 }, { key: 'package', label: 'Package', width: 8 },
        { key: 'paidTo', label: 'Paid to', width: 7.5 }, { key: 'status', label: 'Status', width: 8, status: true },
        { key: 'receipt', label: 'M-Pesa code', width: 10 }, { key: 'ends', label: 'Wi-Fi ends', width: 11 },
        { key: 'amount', label: 'Amount', width: 8.5, align: 'right', money: true, sumWhere: { key: 'status', equals: 'Paid' } },
      ],
      rows,
      totals: { date: 'Shown', location: plural(rows.length, 'payment'), status: `${count(paidRows.length)} paid`, amount: paidRows.reduce((s, row) => s + row.amount, 0) },
      breakdowns: breakdowns(business.id, p),
      notes: ['The amount total counts paid payments only. Failed and pending payments are listed but not counted. Times are Kenya time.'],
    };
  }

  return { revenueSpec, ledgerSpec, period, rangeLabel, change };
}

module.exports = { createReportData, change, maskPhone, phoneText, eatParts };

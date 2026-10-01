'use strict';

/*
 * Excel and PDF versions of the dashboard's table exports (packages, sales,
 * transactions, usage, vouchers, customers). The dashboard sends the exact
 * rows it shows (with the owner's filters and search applied) and gets the
 * same table back as a branded report from documents/report.js, so the
 * file always matches the screen.
 *
 * The rows come from the signed-in person's own dashboard, so they cannot
 * reach anyone else's data; the limits only keep one request bounded.
 */

const MAX_ROWS = 20000;
const MAX_COLUMNS = 20;
const MAX_CELL = 300;

const TITLES = {
  packages: 'Packages', sales: 'Sales', transactions: 'Transactions',
  analytics: 'Usage report', vouchers: 'Vouchers', customers: 'Customers',
};
const fail = (message) => Object.assign(new Error(message), { status: 400 });
const cleanCell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_CELL);
};

/** { kind, rows: [[header...], [values...]...] } -> a report spec. */
function tableReportSpec({ business, kind, rows, rangeLabel, format }) {
  const title = TITLES[kind];
  if (!title) throw fail('Choose a table to export.');
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) throw fail('There is nothing to export.');
  if (rows.length - 1 > MAX_ROWS) throw fail(`Too many rows to export at once (more than ${MAX_ROWS.toLocaleString('en-KE')}). Narrow the search or period.`);
  const header = rows[0].slice(0, MAX_COLUMNS).map((label) => String(cleanCell(label) || ' ').slice(0, 60));
  if (!header.length) throw fail('There is nothing to export.');
  const columns = header.map((label, i) => {
    const money = /\(KES\)/i.test(label);
    const long = /name|package|location|router|description|note|result|batch/i.test(label);
    return { key: `c${i}`, label: money ? label.replace(/\s*\(KES\)/i, '') : label, money, align: money ? 'right' : 'left',
      width: format === 'pdf' ? (long ? 22 : money ? 14 : 16) : (long ? 28 : 18) };
  });
  const body = rows.slice(1).filter(Array.isArray).map((row) => {
    const out = {};
    columns.forEach((column, i) => {
      const value = cleanCell(row[i]);
      out[column.key] = column.money ? (value === '' ? '' : Number(value) || 0) : value;
    });
    return out;
  });
  const summary = [{ label: 'Rows', value: body.length.toLocaleString('en-KE') }];
  columns.filter((column) => column.money).slice(0, 2).forEach((column) => {
    const total = body.reduce((sum, row) => sum + (typeof row[column.key] === 'number' ? row[column.key] : 0), 0);
    summary.push({ label: `Total ${column.label.toLowerCase()}`, value: 'KES ' + total.toLocaleString('en-KE', { maximumFractionDigits: 2 }) });
  });
  return { business, title, rangeLabel: rangeLabel || 'As shown in your dashboard', generatedAt: new Date().toISOString(), summary, columns, rows: body };
}

/**
 * A two-column "Field | Value" report for one receipt, so a receipt can be
 * downloaded as Excel too. fields: [[label, value]].
 */
function receiptReportSpec({ business, title, amount, status, fields }) {
  return {
    business, title, rangeLabel: 'Payment receipt', generatedAt: new Date().toISOString(),
    summary: [{ label: 'Amount', value: amount }, { label: 'Status', value: status }],
    columns: [{ key: 'field', label: 'Field', width: 22 }, { key: 'value', label: 'Value', width: 46 }],
    rows: fields.map(([label, value]) => ({ field: String(label), value: value == null || value === '' ? '—' : String(value) })),
  };
}

module.exports = { tableReportSpec, receiptReportSpec, TITLES, MAX_ROWS };

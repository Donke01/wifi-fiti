'use strict';

/*
 * CSV for spreadsheet downloads. A cell that starts with = + - @ (or a tab
 * or carriage return) is a formula in Excel and Google Sheets: a customer
 * name such as =HYPERLINK(...) would run when the owner opens the file. Such
 * cells are prefixed with an apostrophe, which spreadsheets show as text.
 * Negative numbers stay numbers. A UTF-8 byte order mark keeps names with
 * accents readable in Excel.
 */

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value).replace(/\r\n?/g, '\n');
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** header: [labels], rows: [[values]] -> CSV text with a BOM. */
function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Send a CSV download. filename: letters, digits, dot, dash and underscore only. */
function sendCsv(res, filename, header, rows) {
  const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '') || 'export.csv';
  res.set('Content-Disposition', `attachment; filename="${safe}"`).set('Cache-Control', 'no-store');
  res.type('text/csv; charset=utf-8').send(toCsv(header, rows));
}

module.exports = { toCsv, sendCsv, cell };

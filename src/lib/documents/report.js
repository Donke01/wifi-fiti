'use strict';

/*
 * Reports as PDF (layout-report.js drawn with pdfkit) and Excel (exceljs).
 * One spec drives both, so the two formats always carry the same numbers.
 *
 * spec:
 *   business            tenant branding source, or null for Wi-Fi Fiti (admin) branding
 *   title, rangeLabel   "Revenue", "2 Sep to 1 Oct 2026"
 *   generatedAt, generatedBy, compareLabel ("Compared with the 30 days before")
 *   filters             ['Hotspots: all 2', ...]                       (chips)
 *   summary             [{ label, value, change: { text, good } }]   (headline figures)
 *   balance             [{ label, value, op }]                        (instead of summary: opening + in - out = available)
 *   spark               { title, values: [n], from, to }              (small daily bars beside the figures, landscape)
 *   daily               { title, aside, points: [{ label, value }], money }
 *   columns             [{ key, label, width, align, money, status, muted, bar }]
 *   rows, totals        totals: { key: value } shown under the table
 *   cents               money with two decimals
 *   breakdowns          [{ title, aside, money, rows: [{ label, value, share, note }] }]
 *   heatmap             { title, rows: [{ label, values: [24 numbers] }] }
 *   customers           { title, aside, ring: { fraction, label, value, note }, stats: [{ label, value, note }] }
 *   lists               [{ title, items: [string | { label, note, tag }] }]
 *   notes               [string]                                      (footnotes)
 *   orientation         'portrait' | 'landscape' (default: landscape over 5 columns)
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { reportLayout, statusColor, moneyText } = require('./layout-report');
const { renderPdf, pdfMeasure } = require('./render-pdf');
const { PALETTE } = require('./canvas');
const { PLATFORM, formatDateTime, tenantBrand } = require('./brand');

const MARK_PNG = path.join(__dirname, 'assets', 'wifi-mark.png');

function reportBrand(business) {
  if (!business) return { name: PLATFORM.name, colorHex: PLATFORM.colorHex, colorCss: PLATFORM.colorCss, note: 'Platform, all businesses', footer: 'Wi-Fi Fiti, M-Pesa hotspot billing. wififiti.co.ke' };
  const b = tenantBrand(business);
  return { ...b, note: business.id ? `Business ID ${business.id}` : '' };
}

function generatedLabel(spec) {
  const at = formatDateTime(spec.generatedAt || new Date().toISOString());
  return `Made ${at}${spec.generatedBy ? ` by ${spec.generatedBy}` : ''}`;
}

/* ---------------------------------------------------------------- pdf */

function buildReportPdf(spec) {
  try {
    const brand = reportBrand(spec.business);
    const pages = reportLayout({ ...spec, generatedLabel: generatedLabel(spec) }, spec.measure || pdfMeasure(), brand);
    return renderPdf(pages, { Title: `${brand.name} ${spec.title}` });
  } catch (error) { return Promise.reject(error); }
}

/* --------------------------------------------------------------- xlsx */

const argb = (css) => 'FF' + String(css).replace('#', '').toUpperCase();
const FONT = 'Calibri';
const MONEY_FMT = '"KES" #,##0;-"KES" #,##0;"KES" 0;@';
const MONEY_CENTS_FMT = '"KES" #,##0.00;-"KES" #,##0.00;"KES" 0.00;@';

function colLetter(n) {
  let s = ''; let x = n;
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
  return s || 'A';
}

function sheetName(name, used) {
  let base = String(name || 'Sheet').replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Sheet';
  let candidate = base; let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base.slice(0, 25)} ${i++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

const fill = (css) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(css) } });

/** The branded top of every sheet: brand edge, title, period line. Returns the next free row. */
function sheetHeading(wb, sheet, { brand, title, subtitle, lastCol, markId }) {
  const last = colLetter(lastCol);
  sheet.getRow(1).height = 6;
  for (let c = 1; c <= lastCol; c += 1) sheet.getCell(1, c).fill = fill(brand.colorCss);
  sheet.getRow(2).height = 36;
  sheet.mergeCells(`A2:${last}2`);
  sheet.getCell('A2').value = { richText: [
    { text: title, font: { name: FONT, size: 20, bold: true, color: { argb: argb(PALETTE.ink) } } },
    { text: `   ${brand.name}`, font: { name: FONT, size: 11, color: { argb: argb(PALETTE.muted) } } },
  ] };
  sheet.getCell('A2').alignment = { vertical: 'middle', indent: markId != null ? 4 : 0 };
  if (markId != null) sheet.addImage(markId, { tl: { col: 0.15, row: 1.25 }, ext: { width: 26, height: 22 }, editAs: 'oneCell' });
  sheet.getRow(3).height = 18;
  sheet.mergeCells(`A3:${last}3`);
  sheet.getCell('A3').value = subtitle;
  sheet.getCell('A3').font = { name: FONT, size: 9.5, color: { argb: argb(PALETTE.muted) } };
  sheet.getCell('A3').alignment = { vertical: 'top', indent: markId != null ? 4 : 0 };
  sheet.getRow(4).height = 8;
  return 5;
}

function headerRow(sheet, rowNumber, labels, brand, aligns = []) {
  const row = sheet.getRow(rowNumber);
  labels.forEach((label, i) => {
    const cell = row.getCell(i + 1);
    cell.value = label;
    cell.font = { name: FONT, bold: true, size: 10, color: { argb: argb(PALETTE.ink) } };
    cell.fill = fill('#E3F2F3');
    cell.alignment = { horizontal: aligns[i] || 'left', vertical: 'middle', indent: aligns[i] === 'right' ? 0 : 1 };
    cell.border = { bottom: { style: 'medium', color: { argb: argb(brand.colorCss) } } };
  });
  row.height = 22;
}

function bodyCell(cell, { zebra, align, numFmt, color, bold }) {
  cell.font = { name: FONT, size: 10, color: { argb: argb(color || PALETTE.ink) }, bold: !!bold };
  cell.alignment = { horizontal: align || 'left', vertical: 'middle', indent: align === 'right' ? 0 : 1 };
  cell.border = { bottom: { style: 'thin', color: { argb: argb(PALETTE.line) } } };
  if (numFmt) cell.numFmt = numFmt;
  if (zebra) cell.fill = fill(PALETTE.zebra);
}

function dataBars(sheet, ref, brand) {
  sheet.addConditionalFormatting({ ref, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'max' }],
    color: { argb: argb('#9FD3DB') } }] });
}

async function buildReportXlsx(spec) {
  const brand = reportBrand(spec.business);
  const wb = new ExcelJS.Workbook();
  wb.creator = PLATFORM.name;
  wb.created = new Date();
  const used = new Set();
  let markId = null;
  try { markId = wb.addImage({ buffer: fs.readFileSync(MARK_PNG), extension: 'png' }); } catch (_) { markId = null; }
  const money = spec.cents ? MONEY_CENTS_FMT : MONEY_FMT;
  const cols = spec.columns || [];
  const kpis = spec.balance && spec.balance.length
    ? spec.balance.map((b) => ({ label: `${b.op ? `${b.op} ` : ''}${b.label}`, value: b.value }))
    : (spec.summary || []);
  const lastCol = Math.max(cols.length, Math.min(kpis.length * 2, 10), 6);
  const subtitle = [spec.rangeLabel, generatedLabel(spec), ...(spec.filters || [])].filter(Boolean).join('.   ');

  const sheet = wb.addWorksheet(sheetName(spec.title || 'Report', used), {
    views: [{ state: 'frozen', ySplit: 8, showGridLines: false }],
    properties: { tabColor: { argb: argb(brand.colorCss) } },
    pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: cols.length > 5 ? 'landscape' : 'portrait',
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: `&L&8${brand.name}, ${String(spec.title || '').replace(/&/g, '&&')}&R&8Page &P of &N` },
  });
  cols.forEach((col, i) => { sheet.getColumn(i + 1).width = Math.max(col.width || 18, col.money ? 14 : 10); });
  for (let c = cols.length + 1; c <= lastCol; c += 1) sheet.getColumn(c).width = 16;
  let r = sheetHeading(wb, sheet, { brand, title: spec.title, subtitle, lastCol, markId });

  // Figures: label over value, each over two columns when there is room.
  if (kpis.length) {
    const span = Math.max(1, Math.floor(lastCol / kpis.length));
    kpis.forEach((kpi, i) => {
      const start = 1 + i * span; const end = Math.min(lastCol, start + span - 1);
      if (end > start) { sheet.mergeCells(r, start, r, end); sheet.mergeCells(r + 1, start, r + 1, end); }
      const label = sheet.getCell(r, start);
      label.value = kpi.label;
      label.font = { name: FONT, size: 9, color: { argb: argb(PALETTE.muted) } };
      label.alignment = { indent: 1, vertical: 'bottom' };
      const value = sheet.getCell(r + 1, start);
      const runs = [{ text: String(kpi.value), font: { name: FONT, size: i === 0 ? 17 : 14, bold: true, color: { argb: argb(i === 0 ? brand.colorCss : PALETTE.ink) } } }];
      if (kpi.change && kpi.change.text) {
        runs.push({ text: `  ${kpi.change.text}`, font: { name: FONT, size: 9, bold: true,
          color: { argb: argb(kpi.change.good === false ? PALETTE.failed : kpi.change.good === true ? PALETTE.paid : PALETTE.muted) } } });
      }
      value.value = { richText: runs };
      value.alignment = { indent: 1, vertical: 'middle' };
    });
    sheet.getRow(r).height = 16; sheet.getRow(r + 1).height = 26;
  }
  r += 3; // row 8: the table header

  const headerAt = r;
  if (cols.length) {
    headerRow(sheet, headerAt, cols.map((col) => col.label), brand, cols.map((col) => col.align));
    sheet.autoFilter = { from: { row: headerAt, column: 1 }, to: { row: headerAt, column: cols.length } };
    spec.rows.forEach((row, idx) => {
      const excelRow = sheet.getRow(headerAt + 1 + idx);
      cols.forEach((col, i) => {
        const cell = excelRow.getCell(i + 1);
        const raw = row[col.key];
        cell.value = col.money ? (raw === '' || raw == null ? null : Number(raw) || 0) : (raw == null ? '' : raw);
        bodyCell(cell, { zebra: idx % 2 === 1, align: col.align, numFmt: col.money ? money : undefined,
          color: col.status ? statusColor(String(raw || ''), brand.colorCss) : col.muted ? PALETTE.muted : undefined,
          bold: col.status || col.align === 'right' });
      });
      excelRow.height = 18;
    });
    const first = headerAt + 1; const lastRow = headerAt + spec.rows.length;
    if (spec.rows.length) {
      // Totals that follow the filters: SUBTOTAL ignores rows hidden by a filter.
      const totalRow = sheet.getRow(lastRow + 2);
      cols.forEach((col, i) => {
        const cell = totalRow.getCell(i + 1);
        const letter = colLetter(i + 1);
        if (i === 0) cell.value = cols.some((k) => k.sumWhere) ? 'Total paid' : 'Total, rows shown';
        else if (col.money && col.sumWhere && cols.findIndex((k) => k.key === col.sumWhere.key) >= 0) {
          // Only rows with a given status count (paid payments), e.g. =SUMIFS(K9:K40,H9:H40,"Paid").
          const by = colLetter(cols.findIndex((k) => k.key === col.sumWhere.key) + 1);
          const result = spec.rows.reduce((s, row) => s + (row[col.sumWhere.key] === col.sumWhere.equals ? Number(row[col.key]) || 0 : 0), 0);
          cell.value = { formula: `SUMIFS(${letter}${first}:${letter}${lastRow},${by}${first}:${by}${lastRow},"${String(col.sumWhere.equals).replace(/"/g, '')}")`, result };
        } else if (col.money) {
          const result = spec.rows.reduce((s, row) => s + (Number(row[col.key]) || 0), 0);
          cell.value = { formula: `SUBTOTAL(9,${letter}${first}:${letter}${lastRow})`, result };
        } else if (spec.totals && spec.totals[col.key] != null && i > 0) cell.value = String(spec.totals[col.key]);
        cell.font = { name: FONT, size: 10.5, bold: true, color: { argb: argb(col.money && i === cols.length - 1 ? brand.colorCss : PALETTE.ink) } };
        cell.fill = fill(PALETTE.paper);
        cell.border = { top: { style: 'medium', color: { argb: argb(PALETTE.ink) } } };
        cell.alignment = { horizontal: col.align || 'left', vertical: 'middle', indent: col.align === 'right' ? 0 : 1 };
        if (col.money) cell.numFmt = money;
      });
      totalRow.height = 22;
      cols.forEach((col, i) => {
        if (col.money && (col.bar || i === cols.length - 1)) dataBars(sheet, `${colLetter(i + 1)}${first}:${colLetter(i + 1)}${lastRow}`, brand);
      });
    }
    const footer = sheet.getRow(lastRow + 4);
    footer.getCell(1).value = [...(spec.notes || []), `${generatedLabel(spec)}. Billed on ${PLATFORM.name}, ${PLATFORM.tagline}.`].join('  ');
    footer.getCell(1).font = { name: FONT, italic: true, size: 8.5, color: { argb: argb(PALETTE.muted) } };
  }

  // One more sheet per breakdown, the daily figures and the busiest hours.
  const extraSheet = (title, headers, aligns, widths) => {
    const s = wb.addWorksheet(sheetName(title, used), { views: [{ state: 'frozen', ySplit: 5, showGridLines: false }],
      properties: { tabColor: { argb: argb('#9FD3DB') } } });
    widths.forEach((w, i) => { s.getColumn(i + 1).width = w; });
    sheetHeading(wb, s, { brand, title, subtitle: [spec.title, spec.rangeLabel].filter(Boolean).join(', '), lastCol: Math.max(headers.length, 4), markId });
    headerRow(s, 5, headers, brand, aligns);
    return s;
  };
  for (const b of spec.breakdowns || []) {
    if (!b.rows || !b.rows.length) continue;
    const isMoney = b.money !== false;
    const total = b.rows.reduce((sum, row) => sum + (Number(row.share) || 0), 0) || 1;
    const s = extraSheet(b.title, [b.labelHeader || 'Name', b.valueHeader || (isMoney ? 'Amount' : 'Count'), 'Share', 'Details'], ['left', 'right', 'right', 'left'], [28, 16, 10, 36]);
    b.rows.forEach((row, idx) => {
      const values = [row.label, Number(row.share) || 0, (Number(row.share) || 0) / total, row.note || ''];
      values.forEach((value, i) => {
        const cell = s.getCell(6 + idx, i + 1);
        cell.value = value;
        bodyCell(cell, { zebra: idx % 2 === 1, align: i === 1 || i === 2 ? 'right' : 'left', numFmt: i === 1 ? (isMoney ? money : '#,##0') : i === 2 ? '0%' : undefined, bold: i === 1 });
      });
    });
    dataBars(s, `B6:B${5 + b.rows.length}`, brand);
  }
  if (spec.daily && spec.daily.points && spec.daily.points.length) {
    const isMoney = spec.daily.money !== false;
    const s = extraSheet(spec.daily.sheetTitle || 'By day', ['Day', isMoney ? 'Amount' : 'Count'], ['left', 'right'], [18, 16]);
    spec.daily.points.forEach((p, idx) => {
      const day = s.getCell(6 + idx, 1); day.value = p.fullLabel || p.label; bodyCell(day, { zebra: idx % 2 === 1 });
      const v = s.getCell(6 + idx, 2); v.value = Number(p.value) || 0; bodyCell(v, { zebra: idx % 2 === 1, align: 'right', numFmt: isMoney ? money : '#,##0', bold: true });
    });
    dataBars(s, `B6:B${5 + spec.daily.points.length}`, brand);
  }
  if (spec.heatmap && spec.heatmap.rows && spec.heatmap.rows.length) {
    const hours = Array.from({ length: 24 }, (_, h) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`));
    const s = extraSheet(spec.heatmap.title || 'Busiest hours', ['Day', ...hours], ['left', ...hours.map(() => 'right')], [10, ...hours.map(() => 6.5)]);
    spec.heatmap.rows.forEach((row, idx) => {
      const day = s.getCell(6 + idx, 1); day.value = row.label; bodyCell(day, { bold: true });
      row.values.forEach((v, h) => { const cell = s.getCell(6 + idx, h + 2); cell.value = v; bodyCell(cell, { align: 'right' }); });
    });
    s.addConditionalFormatting({ ref: `B6:Y${5 + spec.heatmap.rows.length}`, rules: [{ type: 'colorScale',
      cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: argb('#F2F7F6') }, { argb: argb(brand.colorCss) }] }] });
  }
  if (spec.customers) {
    const s = extraSheet(spec.customers.title || 'Customers', ['Figure', 'Value', 'Details'], ['left', 'left', 'left'], [26, 22, 40]);
    const items = [{ label: spec.customers.ring.label, value: spec.customers.ring.value, note: spec.customers.ring.note }, ...(spec.customers.stats || [])];
    items.forEach((item, idx) => [item.label, item.value, item.note || ''].forEach((value, i) => {
      const cell = s.getCell(6 + idx, i + 1); cell.value = value; bodyCell(cell, { zebra: idx % 2 === 1, bold: i === 1 });
    }));
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { buildReportXlsx, buildReportPdf, reportBrand, moneyText };

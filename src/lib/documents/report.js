'use strict';

/*
 * One flexible report generator (.xlsx and .pdf) behind three call sites:
 * a tenant's revenue summary, a tenant's raw transaction ledger, and the
 * platform-wide admin report. All three are "a KPI strip, then a table,
 * over a date range" - the same shape - so one generator with different
 * columns/summary/branding avoids three near-duplicate implementations
 * that would drift apart the first time one of them needs a fix.
 *
 * .xlsx (exceljs) is the primary format: a report is tabular data someone
 * re-sorts, filters or drops into their own spreadsheet. .pdf (pdfkit) is
 * the fixed, printable version of the same numbers - what actually gets
 * shared or filed, where a live spreadsheet would be the wrong artifact.
 *
 * Shape of `spec`:
 *   {
 *     business,            // tenant branding source, or null/undefined for platform (admin) branding
 *     title,                // "Revenue report" | "Transaction ledger" | "Platform report"
 *     rangeLabel,           // "1 – 29 Sep 2026"
 *     summary: [{ label, value }],           // KPI tiles across the top
 *     columns: [{ key, label, width, align, money }],
 *     rows: [{ ...columns by key }],
 *     generatedAt,
 *   }
 */

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { drawWifiMark } = require('./wifi-mark');
const { PLATFORM, formatDateTime, tenantBrand } = require('./brand');

function reportBrand(business) {
  if (!business) return { name: PLATFORM.name, colorHex: PLATFORM.colorHex, colorCss: PLATFORM.colorCss, supportPhone: '', poweredBy: PLATFORM.tagline, subtitle: 'Platform-wide, all tenants' };
  const b = tenantBrand(business);
  return { ...b, subtitle: b.name };
}

/* --------------------------------------------------------------- xlsx */

async function buildReportXlsx(spec) {
  const brand = reportBrand(spec.business);
  const wb = new ExcelJS.Workbook();
  wb.creator = PLATFORM.name;
  wb.created = new Date();

  const sheet = wb.addWorksheet(spec.title || 'Report', {
    views: [{ state: 'frozen', ySplit: 9 }],
    // Someone opening this in Excel/Sheets never sees pagination - it's an
    // ordinary scrolling sheet. But it's still a spreadsheet, and printing
    // or exporting one straight to PDF with no page setup at all split a
    // wide band/KPI row across two pages, spilling a stray colored sliver
    // onto page 2. fitToWidth keeps the whole report on one page wide.
    pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape', margins: { left: 0.3, right: 0.3, top: 0.3, bottom: 0.3, header: 0, footer: 0 } },
  });
  const kpis = spec.summary || [];
  // The band/KPI row need enough total column *width* to hold the title
  // text and every KPI tile once this prints or exports to PDF - a narrow
  // 3-column report (lastCol driven only by spec.columns.length) clipped
  // both the title and the last KPI tile at the printable page edge, even
  // though they looked fine only when scrolled past on screen. A wider
  // minimum column count, plus a real default width on any column past
  // the data columns (ExcelJS's own default is ~8.4, far too narrow),
  // fixes both.
  const lastCol = Math.max(spec.columns.length, kpis.length, 6);
  const lastColLetter = colLetter(lastCol);
  for (let c = spec.columns.length + 1; c <= lastCol; c++) sheet.getColumn(c).width = 16;

  // Colored header band (rows 1-3), same brand color as the receipt and
  // the pdf, with the Wi-Fi mark in the first cell.
  for (let r = 1; r <= 3; r++) {
    sheet.getRow(r).height = r === 2 ? 26 : 10;
    for (let c = 1; c <= lastCol; c++) sheet.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + brand.colorHex } };
  }
  sheet.mergeCells(`A2:B2`);
  sheet.getCell('A2').value = '((•))';
  sheet.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A2').alignment = { horizontal: 'left', vertical: 'middle' };
  sheet.mergeCells(`C2:${lastColLetter}2`);
  const title = sheet.getCell('C2');
  title.value = `${brand.name} — ${spec.title}`;
  title.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  title.alignment = { horizontal: 'left', vertical: 'middle' };

  sheet.mergeCells('A4:' + lastColLetter + '4');
  sheet.getCell('A4').value = `${brand.subtitle} · ${spec.rangeLabel}`;
  sheet.getCell('A4').font = { color: { argb: 'FF' + PLATFORM.grey }, italic: true };
  sheet.getRow(4).height = 18;

  // KPI row: each tile is a bordered, tinted box (label over value), not
  // bare cells, so the summary reads as cards rather than a stray row.
  let row = 6;
  const tileSpan = Math.max(1, Math.floor(lastCol / Math.max(kpis.length, 1)));
  kpis.forEach((kpi, i) => {
    const startCol = 1 + i * tileSpan;
    const endCol = i === kpis.length - 1 ? lastCol : startCol + tileSpan - 1;
    const startL = colLetter(startCol); const endL = colLetter(endCol);
    for (const r of [row, row + 1]) {
      if (endCol > startCol) sheet.mergeCells(`${startL}${r}:${endL}${r}`);
      const cell = sheet.getCell(r, startCol);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7F8' } };
      cell.border = { top: { style: 'thin', color: { argb: 'FFE1E8EC' } }, left: { style: 'thin', color: { argb: 'FFE1E8EC' } },
        right: { style: 'thin', color: { argb: 'FFE1E8EC' } }, bottom: r === row ? { style: 'hair', color: { argb: 'FFE1E8EC' } } : { style: 'thin', color: { argb: 'FFE1E8EC' } } };
    }
    const c = sheet.getCell(row, startCol);
    c.value = kpi.label.toUpperCase(); c.font = { color: { argb: 'FF' + PLATFORM.grey }, size: 9, bold: true }; c.alignment = { indent: 1, vertical: 'bottom' };
    const v = sheet.getCell(row + 1, startCol);
    v.value = kpi.value; v.font = { bold: true, size: 15, color: { argb: 'FF' + brand.colorHex } }; v.alignment = { indent: 1, vertical: 'top' };
  });
  sheet.getRow(row).height = 16; sheet.getRow(row + 1).height = 22;
  row += 3;

  const headerRow = sheet.getRow(row);
  spec.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + PLATFORM.colorDark } };
    cell.alignment = { horizontal: col.align || 'left', vertical: 'middle' };
    sheet.getColumn(i + 1).width = col.width || 18;
  });
  headerRow.height = 20;

  spec.rows.forEach((r, idx) => {
    const excelRow = sheet.addRow(spec.columns.map((col) => r[col.key]));
    excelRow.eachCell((cell, i) => {
      const col = spec.columns[i - 1];
      cell.alignment = { horizontal: col.align || 'left' };
      // Two decimal places, so a fee share's cents are kept; a blank cell stays blank.
      if (col.money) cell.numFmt = '"KES" #,##0.00;-"KES" #,##0.00;"KES" 0.00;@';
      if (idx % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAFB' } };
    });
  });

  sheet.addRow([]);
  const footerRow = sheet.addRow([`Generated ${formatDateTime(spec.generatedAt || new Date().toISOString())} · ${brand.poweredBy}`]);
  footerRow.getCell(1).font = { italic: true, size: 8, color: { argb: 'FF' + PLATFORM.grey } };

  return wb.xlsx.writeBuffer();
}

function colLetter(n) {
  let s = ''; let x = n;
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
  return s || 'A';
}

/* ---------------------------------------------------------------- pdf */

function buildReportPdf(spec) {
  const brand = reportBrand(spec.business);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 40, left: 36, right: 36 }, layout: (spec.columns || []).length > 5 ? 'landscape' : 'portrait' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 72;

    // Full-bleed colored header band, same treatment as the receipt: the
    // mark plus the brand name in white, on the tenant's own color. The
    // icon and title are measured and centred together as one lockup -
    // centring each independently (icon at a fixed offset, title with its
    // own align:'center') let a short brand name drift under the icon.
    const bandH = 64;
    doc.rect(0, 0, doc.page.width, bandH).fill(`#${brand.colorHex}`);
    const headerText = `${brand.name} — ${spec.title}`;
    const markSize = 28; const gap = 10;
    let titleSize = 19;
    doc.font('Helvetica-Bold').fontSize(titleSize);
    // Shrink the title rather than let it wrap: text({lineBreak:false}) still
    // wraps when a `width` is passed (a pdfkit quirk), so a too-narrow band
    // for a long tenant name + title once showed two stacked lines instead
    // of one - shrinking to fit and dropping `width` keeps it a single line.
    const maxTextW = doc.page.width - 72 - markSize - gap;
    let textW = doc.widthOfString(headerText);
    while (textW > maxTextW && titleSize > 12) {
      titleSize -= 1;
      doc.fontSize(titleSize);
      textW = doc.widthOfString(headerText);
    }
    const lockupW = markSize + gap + textW;
    const lockupX = (doc.page.width - lockupW) / 2;
    const markY = 18 + (19 - titleSize) / 2;
    drawWifiMark(doc, { x: lockupX, y: markY, size: markSize, color: '#FFFFFF' });
    const textY = 22 + (19 - titleSize) * 0.6;
    doc.fillColor('#FFFFFF').text(headerText, lockupX + markSize + gap, textY, { lineBreak: false });
    doc.y = bandH + 14;
    doc.font('Helvetica').fontSize(10).fillColor('#6B7A87').text(`${brand.subtitle} · ${spec.rangeLabel}`, { align: 'center' });
    doc.moveDown(1);

    // KPI strip: bordered, tinted cards rather than bare numbers, evenly
    // spaced and centred as a block.
    const kpis = spec.summary || [];
    if (kpis.length) {
      const gap = 10;
      const tileW = (pageWidth - gap * (kpis.length - 1)) / kpis.length;
      const tileH = 52;
      const y0 = doc.y;
      kpis.forEach((kpi, i) => {
        const x = 36 + i * (tileW + gap);
        doc.roundedRect(x, y0, tileW, tileH, 6).fillAndStroke('#F4F7F8', '#E1E8EC');
        doc.font('Helvetica').fontSize(7.5).fillColor('#6B7A87').text(kpi.label.toUpperCase(), x + 10, y0 + 10, { width: tileW - 20, align: 'left' });
        doc.font('Helvetica-Bold').fontSize(16).fillColor(`#${brand.colorHex}`).text(String(kpi.value), x + 10, y0 + 24, { width: tileW - 20, align: 'left' });
      });
      doc.y = y0 + tileH + 16;
    }

    // Table.
    const cols = spec.columns;
    const widths = proportionalWidths(cols, pageWidth);
    const drawHeader = () => {
      const y = doc.y;
      doc.rect(36, y, pageWidth, 20).fill(`#${PLATFORM.colorDark}`);
      let x = 36;
      cols.forEach((col, i) => {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF').text(col.label, x + 4, y + 6, { width: widths[i] - 8, align: col.align || 'left' });
        x += widths[i];
      });
      doc.y = y + 20;
    };
    drawHeader();
    let stripe = false;
    for (const r of spec.rows) {
      if (doc.y > doc.page.height - 70) { doc.addPage({ size: 'A4', layout: cols.length > 5 ? 'landscape' : 'portrait', margins: { top: 36, bottom: 40, left: 36, right: 36 } }); drawHeader(); }
      const y = doc.y;
      const rowH = 16;
      if (stripe) doc.rect(36, y, pageWidth, rowH).fill('#F4F7F8');
      stripe = !stripe;
      let x = 36;
      cols.forEach((col, i) => {
        const raw = r[col.key];
        // A blank money cell (e.g. "Money out" on a sales line) stays blank.
        const text = col.money ? (raw === '' || raw == null ? '' : `KES ${Number(raw || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`) : String(raw ?? '');
        doc.font('Helvetica').fontSize(8.5).fillColor('#101820').text(text, x + 4, y + 3, { width: widths[i] - 8, align: col.align || 'left' });
        x += widths[i];
      });
      doc.y = y + rowH;
    }

    doc.moveDown(1);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#6B7A87')
      .text(`Generated ${formatDateTime(spec.generatedAt || new Date().toISOString())} · ${brand.poweredBy}`, { align: 'center' });
    doc.end();
  });
}

function proportionalWidths(cols, pageWidth) {
  const total = cols.reduce((s, c) => s + (c.width || 18), 0);
  return cols.map((c) => ((c.width || 18) / total) * pageWidth);
}

module.exports = { buildReportXlsx, buildReportPdf };

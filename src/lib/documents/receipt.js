'use strict';

/*
 * The customer's proof of payment for one hotspot top-up: what M-Pesa
 * itself never gives them (a package name, how much time it bought, whose
 * hotspot it was). Deliberately a single centred slip, not a business
 * invoice - it is read once, on a phone, seconds after paying.
 *
 * Two independent renderers (docx via the `docx` package, pdf via
 * `pdfkit`) build the same layout from the same data, so a change to one
 * format is not a silent drift from the other.
 *
 * Both carry a colored header band (the tenant's own brand color, or
 * Wi-Fi Fiti teal when they haven't set one) with the Wi-Fi mark: the pdf
 * draws it live as vector (drawWifiMark, any color, always crisp); the
 * docx embeds the bundled navy PNG (assets/wifi-mark.png) since docx has
 * no vector-drawing API - a small, brand-neutral mark reads fine next to
 * the brand-colored name text either way.
 */

const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, ShadingType, ImageRun } = require('docx');
const PDFDocument = require('pdfkit');
const { drawWifiMark } = require('./wifi-mark');
const { PLATFORM, formatKes, formatDateTime, tenantBrand, documentNumber } = require('./brand');

const MARK_PNG = path.join(__dirname, 'assets', 'wifi-mark.png');

function statusWord(status) {
  if (status === 'paid' || status === 'completed') return { text: 'PAID', color: PLATFORM.colorGood };
  if (status === 'pending' || status === 'processing') return { text: 'PENDING', color: PLATFORM.colorWarn };
  return { text: 'NOT COMPLETED', color: PLATFORM.colorBad };
}

/**
 * Normalizes whatever a transaction row looks like into what the two
 * renderers need. Optional `title`, `fields` ([[label, value]], replacing
 * the hotspot fields) and `footnote` let other receipts (a Wi-Fi Fiti plan
 * payment) reuse the same slip.
 */
function receiptData({ business, transaction, receiptNumber, title, fields, footnote, numberPrefix }) {
  const brand = tenantBrand(business);
  const number = receiptNumber || documentNumber(numberPrefix || 'RCT', transaction.checkout_request_id || transaction.mpesa_receipt || transaction.id);
  const date = formatDateTime(transaction.updated_at || transaction.created_at);
  const routerSite = transaction.location_name || '';
  const defaultFields = [['Receipt no.', number], ['Date', date], ['Phone', transaction.phone || ''],
    ['Package', transaction.package_name || ''], ['M-Pesa code', transaction.mpesa_receipt || '—'],
    ...(routerSite ? [['Hotspot', routerSite]] : [])];
  return {
    brand,
    number,
    date,
    phone: transaction.phone || '',
    packageName: transaction.package_name || '',
    amount: formatKes(transaction.amount),
    mpesaReceipt: transaction.mpesa_receipt || '—',
    status: statusWord(transaction.status),
    routerSite,
    title: title || 'HOTSPOT PAYMENT RECEIPT',
    fields: (fields || defaultFields).map(([label, value]) => [String(label), String(value == null || value === '' ? '—' : value)]),
    footnote: footnote || '',
  };
}

/* --------------------------------------------------------------- docx */

function buildReceiptDocx(input) {
  const d = receiptData(input);
  const center = AlignmentType.CENTER;
  const bandFill = { type: ShadingType.CLEAR, color: 'auto', fill: d.brand.colorHex };

  const line = (text, opts = {}) => new Paragraph({ alignment: center, spacing: { after: opts.after ?? 80 },
    children: [new TextRun({ text, bold: !!opts.bold, size: opts.size || 20, color: opts.color, italics: !!opts.italics })] });
  const rule = () => new Paragraph({ alignment: center, spacing: { before: 120, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D9E2E7' } }, children: [] });
  const dashedRule = () => new Paragraph({ alignment: center, spacing: { before: 160, after: 160 },
    border: { bottom: { style: BorderStyle.DASHED, size: 4, color: 'B8C4CC' } }, children: [] });
  // A single centred line per field ("Label  Value"), so the whole slip
  // reads as one centred block - the shape a printed till receipt has.
  const kv = (label, value) => new Paragraph({ alignment: center, spacing: { after: 60 }, children: [
    new TextRun({ text: `${label}  `, size: 18, color: PLATFORM.grey }),
    new TextRun({ text: value, size: 18, bold: true }),
  ] });

  let mark = null;
  try {
    mark = new ImageRun({ data: fs.readFileSync(MARK_PNG), transformation: { width: 30, height: 25 }, type: 'png' });
  } catch (_) { /* asset missing: the band still reads fine as text-only */ }

  const band = new Paragraph({ alignment: center, spacing: { before: 160, after: 160 }, shading: bandFill,
    children: [
      ...(mark ? [mark, new TextRun({ text: '   ' })] : []),
      new TextRun({ text: d.brand.name, bold: true, size: 30, color: 'FFFFFF' }),
    ] });

  const statusPill = new Paragraph({ alignment: center, spacing: { before: 40, after: 220 }, shading: { type: ShadingType.CLEAR, color: 'auto', fill: d.status.color },
    children: [new TextRun({ text: `  ${d.status.text}  `, bold: true, size: 17, color: 'FFFFFF' })] });

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 5400, height: 8600 }, margin: { top: 0, bottom: 720, left: 0, right: 0 } } },
      children: [
        band,
        line(d.title, { size: 15, color: PLATFORM.grey, after: 180 }),
        line(d.amount, { bold: true, size: 46, color: PLATFORM.colorDark, after: 60 }),
        statusPill,
        ...d.fields.map(([label, value]) => kv(label, value)),
        dashedRule(),
        ...(d.footnote ? [line(d.footnote, { size: 15, color: PLATFORM.grey })] : []),
        line(d.brand.poweredBy, { size: 15, color: PLATFORM.grey, italics: true }),
        ...(d.brand.supportPhone ? [line(`Support: ${d.brand.supportPhone}`, { size: 15, color: PLATFORM.grey })] : []),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

/* ---------------------------------------------------------------- pdf */

function buildReceiptPdf(input) {
  const d = receiptData(input);
  return new Promise((resolve, reject) => {
    const width = 320; // a narrow slip, like a till receipt, not a full A4 page
    const doc = new PDFDocument({ size: [width, 560], margins: { top: 0, bottom: 28, left: 20, right: 20 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const centerText = (text, opts = {}) => doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 10)
      .fillColor(opts.color || '#101820').text(text, 20, doc.y, { width: width - 40, align: 'center' }).moveDown(opts.gap ?? 0.3);
    const dashedRule = () => {
      const y = doc.y + 6;
      doc.save().dash(3, { space: 2 }).moveTo(20, y).lineTo(width - 20, y).strokeColor('#B8C4CC').lineWidth(1).stroke().undash().restore();
      doc.y = y + 12;
    };
    const kv = (label, value) => {
      const labelW = doc.font('Helvetica').fontSize(8.5).widthOfString(label + '  ');
      const valueW = doc.font('Helvetica-Bold').fontSize(8.5).widthOfString(value);
      const startX = (width - labelW - valueW) / 2;
      const y = doc.y;
      doc.font('Helvetica').fontSize(8.5).fillColor('#6B7A87').text(label + '  ', startX, y, { continued: true, lineBreak: false });
      doc.font('Helvetica-Bold').fillColor('#101820').text(value, { lineBreak: true });
      doc.moveDown(0.15);
    };

    // Header band: full-bleed color, the mark stacked above the tenant
    // name (a logo lockup) rather than beside it, so a long business name
    // never collides with the icon.
    const bandH = 92;
    doc.rect(0, 0, width, bandH).fill(`#${d.brand.colorHex}`);
    drawWifiMark(doc, { x: width / 2 - 15, y: 14, size: 30, color: '#FFFFFF' });
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF').text(d.brand.name, 14, 54, { width: width - 28, align: 'center' });
    doc.y = bandH + 14;

    centerText(d.title, { size: 8, color: '#6B7A87', gap: 0.5 });
    centerText(d.amount, { bold: true, size: 27, color: '#06111F', gap: 0.15 });

    // Status pill: a small rounded, filled badge rather than plain text.
    doc.font('Helvetica-Bold').fontSize(9);
    const pillText = d.status.text;
    const pillW = doc.widthOfString(pillText) + 26;
    const pillX = (width - pillW) / 2;
    const pillY = doc.y;
    doc.roundedRect(pillX, pillY, pillW, 18, 9).fill(`#${d.status.color}`);
    doc.fillColor('#FFFFFF').text(pillText, pillX, pillY + 5, { width: pillW, align: 'center' });
    doc.y = pillY + 18;
    doc.moveDown(1);

    d.fields.forEach(([label, value]) => kv(label, value));
    doc.moveDown(0.5);
    dashedRule();
    if (d.footnote) centerText(d.footnote, { size: 7.5, color: '#6B7A87' });
    centerText(d.brand.poweredBy, { size: 7.5, color: '#6B7A87' });
    if (d.brand.supportPhone) centerText(`Support: ${d.brand.supportPhone}`, { size: 7.5, color: '#6B7A87' });
    doc.end();
  });
}

module.exports = { buildReceiptDocx, buildReceiptPdf, receiptData };

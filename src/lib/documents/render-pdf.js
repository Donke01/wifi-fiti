'use strict';

/*
 * Replays canvas pages with pdfkit, using the bundled Bricolage Grotesque
 * (SIL Open Font License, see fonts/OFL.txt) so every PDF looks the same on
 * every phone and printer, whatever fonts it has.
 */

const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, 'fonts');
const FONTS = { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold' };
const fontName = (weight) => `Brico-${FONTS[weight] ? weight : weight >= 650 ? 700 : 400}`;

function registerFonts(doc) {
  for (const [weight, file] of Object.entries(FONTS)) {
    doc.registerFont(`Brico-${weight}`, path.join(FONT_DIR, `BricolageGrotesque-${file}.ttf`));
  }
}

function newDocument(size, info) {
  const doc = new PDFDocument({ size, margins: { top: 0, bottom: 0, left: 0, right: 0 }, autoFirstPage: false,
    info: { Producer: 'Wi-Fi Fiti', Creator: 'Wi-Fi Fiti', ...(info || {}) } });
  registerFonts(doc);
  return doc;
}

/** A measure(text, size, weight) backed by pdfkit's metrics for the embedded font. */
function pdfMeasure() {
  const doc = newDocument([100, 100]);
  return (text, size, weight) => doc.font(fontName(weight)).fontSize(size).widthOfString(String(text));
}

function drawOps(doc, ops) {
  for (const o of ops) {
    switch (o.op) {
      case 'text':
        doc.save();
        if (o.opacity != null) doc.fillOpacity(o.opacity);
        doc.font(fontName(o.weight)).fontSize(o.size).fillColor(o.color)
          .text(o.text, o.x, o.y, { lineBreak: false, baseline: 'alphabetic', characterSpacing: o.spacing || 0 });
        doc.restore();
        break;
      case 'rect':
        doc.save();
        if (o.radius) doc.roundedRect(o.x, o.y, o.w, o.h, o.radius); else doc.rect(o.x, o.y, o.w, o.h);
        if (o.opacity != null) doc.fillOpacity(o.opacity);
        if (o.fill && o.fill !== 'none' && o.stroke) doc.lineWidth(o.strokeWidth).fillAndStroke(o.fill, o.stroke);
        else if (o.fill && o.fill !== 'none') doc.fill(o.fill);
        else if (o.stroke) doc.lineWidth(o.strokeWidth).stroke(o.stroke);
        doc.restore();
        break;
      case 'circle':
        doc.save();
        doc.circle(o.cx, o.cy, o.r);
        if (o.fill && o.stroke) doc.lineWidth(o.strokeWidth).fillAndStroke(o.fill, o.stroke);
        else if (o.fill) doc.fill(o.fill);
        else if (o.stroke) doc.lineWidth(o.strokeWidth).stroke(o.stroke);
        doc.restore();
        break;
      case 'line':
        doc.save();
        doc.moveTo(o.x1, o.y1).lineTo(o.x2, o.y2).lineWidth(o.width);
        if (o.dash) doc.dash(o.dash[0], { space: o.dash[1] });
        doc.stroke(o.color);
        doc.restore();
        break;
      case 'path':
        doc.save();
        doc.path(o.d);
        if (o.fill) doc.fill(o.fill);
        else if (o.stroke) doc.lineWidth(o.strokeWidth).lineCap(o.cap || 'butt').stroke(o.stroke);
        doc.restore();
        break;
      case 'arcs': {
        const [x, y, w, h] = o.clip;
        doc.save();
        doc.rect(x, y, w, h).clip();
        doc.strokeOpacity(o.opacity).lineWidth(o.width);
        for (const r of o.radii) doc.circle(o.cx, o.cy, r).stroke(o.color);
        doc.restore();
        break;
      }
      case 'push':
        doc.save();
        doc.translate(o.dx, o.dy);
        break;
      case 'pop':
        doc.restore();
        break;
      default:
        break;
    }
  }
}

/** pages: [{ width, height, ops }] -> PDF Buffer. */
function renderPdf(pages, info) {
  return new Promise((resolve, reject) => {
    const doc = newDocument([pages[0].width, pages[0].height], info);
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      for (const page of pages) {
        doc.addPage({ size: [page.width, page.height], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        drawOps(doc, page.ops);
      }
      doc.end();
    } catch (error) { reject(error); }
  });
}

module.exports = { renderPdf, pdfMeasure, fontName, FONT_DIR };

'use strict';

/*
 * A tiny drawing surface for documents. Layout code (layout-receipt.js,
 * layout-report.js) draws onto a Canvas, which only records absolute
 * shapes and text runs. render-pdf.js then replays them with pdfkit, and
 * render-svg.js replays them as SVG for previews and tests, so the two can
 * never disagree about where anything sits.
 *
 * Text is measured with the `measure(text, size, weight)` function the
 * renderer supplies (pdfkit's own metrics for the PDF), and always placed
 * by its baseline.
 */

const qrcodegen = require('./qrcodegen');

const PALETTE = Object.freeze({
  ink: '#0E2A33',
  muted: '#5E7480',
  line: '#DCE7E5',
  paper: '#F2F7F6',
  zebra: '#F8FBFA',
  brand: '#007D90',
  mint: '#8EE7D1',
  white: '#FFFFFF',
  paid: '#1E8E5A',
  paidBg: '#E2F4EA',
  pending: '#C98A00',
  pendingBg: '#FFE7A8',
  failed: '#C0392B',
  failedBg: '#FBE5E2',
  refunded: '#6B5BD2',
});

/** Mix colour a toward b by t (0..1); both '#RRGGBB'. */
function blend(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((x, i) => Math.round(x + (pb[i] - x) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Text the embedded font can draw: control characters out, a few look-alikes swapped. */
function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[✓✔]/g, 'Yes')
    .replace(/[^ -ɏ‐-‧‰-⁞€™←-↓−]/g, '');
}

class Canvas {
  constructor({ width, height, measure }) {
    this.width = width;
    this.height = height;
    this.measure = measure;
    this.ops = [];
  }

  textWidth(text, size, weight = 400, spacing = 0) {
    const s = cleanText(text);
    return this.measure(s, size, weight) + (spacing ? spacing * Math.max(0, s.length - 1) : 0);
  }

  /** Draw one line of text by its baseline; returns its width. */
  text(x, y, value, { size = 10, weight = 400, color = PALETTE.ink, align = 'left', box = 0, spacing = 0, opacity } = {}) {
    const s = cleanText(value);
    if (!s) return 0;
    const w = this.textWidth(s, size, weight, spacing);
    let tx = x;
    if (align === 'right') tx = x + box - w;
    else if (align === 'center') tx = x + (box - w) / 2;
    this.ops.push({ op: 'text', x: tx, y, text: s, size, weight, color, spacing, opacity });
    return w;
  }

  /** Text that may not fit: shortened with an ellipsis to `max` width. */
  fitText(x, y, value, max, opts = {}) {
    let s = cleanText(value);
    const { size = 10, weight = 400, spacing = 0 } = opts;
    if (this.textWidth(s, size, weight, spacing) > max) {
      while (s.length > 1 && this.textWidth(s + '…', size, weight, spacing) > max) s = s.slice(0, -1);
      s = s.trimEnd() + '…';
    }
    return this.text(x, y, s, opts);
  }

  /** Greedy word wrap to `max` width. */
  wrap(value, size, weight, max) {
    const lines = [];
    let current = '';
    for (const word of cleanText(value).split(/\s+/).filter(Boolean)) {
      const trial = current ? `${current} ${word}` : word;
      if (!current || this.textWidth(trial, size, weight) <= max) current = trial;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    return lines;
  }

  rect(x, y, w, h, fill, { radius = 0, stroke, strokeWidth = 1, opacity } = {}) {
    if (w <= 0 || h <= 0) return;
    this.ops.push({ op: 'rect', x, y, w, h, fill, radius: Math.min(radius, w / 2, h / 2), stroke, strokeWidth, opacity });
  }

  circle(cx, cy, r, fill, { stroke, strokeWidth = 1 } = {}) {
    this.ops.push({ op: 'circle', cx, cy, r, fill, stroke, strokeWidth });
  }

  line(x1, y1, x2, y2, color = PALETTE.line, width = 0.8, dash) {
    this.ops.push({ op: 'line', x1, y1, x2, y2, color, width, dash });
  }

  /** An SVG path string, filled or stroked. */
  path(d, { fill, stroke, strokeWidth = 1, cap = 'butt' } = {}) {
    this.ops.push({ op: 'path', d, fill, stroke, strokeWidth, cap });
  }

  /** Part of a ring from 12 o'clock, clockwise (a donut chart segment). */
  ring(cx, cy, r, width, color, fraction) {
    const f = Math.max(0, Math.min(fraction, 0.9999));
    if (f <= 0) return;
    const end = -Math.PI / 2 + f * 2 * Math.PI;
    const x0 = cx; const y0 = cy - r;
    const x1 = cx + r * Math.cos(end); const y1 = cy + r * Math.sin(end);
    this.path(`M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      { stroke: color, strokeWidth: width });
  }

  /** Concentric signal arcs around (cx, cy), shown only inside the clip rectangle. */
  arcs(cx, cy, radii, color, opacity, width, clip) {
    this.ops.push({ op: 'arcs', cx, cy, radii, color, opacity, width, clip });
  }

  /** The Wi-Fi mark, `size` wide with its top-left at (x, y). */
  mark(x, y, size, color) {
    const k = size / 24;
    const p = (px, py) => `${(x + px * k).toFixed(2)} ${(y + py * k).toFixed(2)}`;
    this.circle(x + 12 * k, y + 19.68 * k, 2.16 * k, color);
    this.path(`M${p(6.821, 14.678)}A${(7.2 * k).toFixed(3)} ${(7.2 * k).toFixed(3)} 0 0 1 ${p(17.179, 14.678)}`, { stroke: color, strokeWidth: 2.4 * k, cap: 'round' });
    this.path(`M${p(3.368, 11.344)}A${(12 * k).toFixed(3)} ${(12 * k).toFixed(3)} 0 0 1 ${p(20.632, 11.344)}`, { stroke: color, strokeWidth: 2.16 * k, cap: 'round' });
    this.path(`M${p(-0.084, 8.009)}A${(16.8 * k).toFixed(3)} ${(16.8 * k).toFixed(3)} 0 0 1 ${p(24.084, 8.009)}`, { stroke: color, strokeWidth: 1.92 * k, cap: 'round' });
  }

  /** A QR code for `data`, `size` wide; drawn as one filled path. */
  qr(x, y, size, data, color = PALETTE.ink) {
    const code = qrcodegen.QrCode.encodeText(String(data), qrcodegen.QrCode.Ecc.MEDIUM);
    const k = size / code.size;
    let d = '';
    for (let row = 0; row < code.size; row += 1) {
      // Runs of dark modules on a row become one rectangle each.
      let col = 0;
      while (col < code.size) {
        if (!code.getModule(col, row)) { col += 1; continue; }
        let end = col;
        while (end < code.size && code.getModule(end, row)) end += 1;
        d += `M${(x + col * k).toFixed(2)} ${(y + row * k).toFixed(2)}h${((end - col) * k).toFixed(2)}v${k.toFixed(2)}h${(-(end - col) * k).toFixed(2)}z`;
        col = end;
      }
    }
    this.path(d, { fill: color });
    return code.size;
  }

  /** A rounded label; returns its width. */
  chip(x, y, label, { fill, color, size = 8, weight = 600, dot } = {}) {
    const h = size + 9;
    const w = this.textWidth(label, size, weight) + (dot ? 24 : 16);
    this.rect(x, y, w, h, fill, { radius: h / 2 });
    if (dot) this.circle(x + 10, y + h / 2, 2.8, dot);
    this.text(x + (dot ? 17 : 8), y + h / 2 + size * 0.36, label, { size, weight, color });
    return w;
  }
}

module.exports = { Canvas, PALETTE, blend, cleanText };

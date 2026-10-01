'use strict';

/*
 * Report pages (A4): a large title with the business's mark and faint
 * signal arcs, filter chips, a strip of headline figures (or a balance
 * worked out from opening to available), an optional daily chart, the
 * table (continuing over as many pages as it needs, header repeated),
 * totals, then optional breakdowns with share bars, a busiest-hours
 * heatmap, customer figures, account lists and notes.
 *
 * Every block is optional, so one layout serves the revenue report, the
 * transaction list, the payout statement, dashboard table exports and the
 * platform report. Spec fields beyond the original ones (title,
 * rangeLabel, summary, columns, rows, generatedAt) are documented in
 * report.js.
 */

const { Canvas, PALETTE: P, blend } = require('./canvas');

const A4 = { portrait: [595.28, 841.89], landscape: [841.89, 595.28] };
const FOOT = 46; // reserved at the bottom of every page

const STATUS_TONES = [
  [/refund/i, P.refunded],
  [/fail|reject|cancel|revers|expired|not completed|error/i, P.failed],
  [/pend|wait|process|approved|review|queued|unpaid/i, P.pending],
  [/collect|opening|balance/i, null], // brand color
  [/paid|complete|success|active|confirmed|sent|redeemed|yes/i, P.paid],
];
function statusColor(text, brand) {
  for (const [pattern, color] of STATUS_TONES) if (pattern.test(text)) return color || brand;
  return P.muted;
}

function moneyText(value, cents) {
  if (value === '' || value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return 'KES ' + n.toLocaleString('en-KE', cents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 });
}

function reportLayout(spec, measure, brandInfo) {
  const brand = brandInfo.colorCss || P.brand;
  const cols = spec.columns || [];
  const orientation = spec.orientation || (cols.length > 5 ? 'landscape' : 'portrait');
  const [W, H] = A4[orientation];
  const M = 32;
  const inner = W - 2 * M;
  const pages = [];
  let c; let y;

  const newPage = (first) => {
    c = new Canvas({ width: W, height: H, measure });
    pages.push(c);
    c.rect(0, 0, W, H, P.white);
    c.rect(0, 0, W, 6, brand);
    if (first) {
      c.arcs(W + 10, -40, [70, 110, 150, 190], brand, 0.10, 14, [0, 6, W, 96]);
      c.mark(M, 26, 15, brand);
      const nameW = c.text(M + 21, 37, brandInfo.name, { size: 10.5, weight: 700 });
      if (brandInfo.note) c.text(M + 21 + nameW + 8, 37, brandInfo.note, { size: 9, color: P.muted });
      const rightW = Math.max(c.textWidth(spec.rangeLabel || '', 10.5, 700), 120);
      let titleSize = 28;
      while (titleSize > 18 && c.textWidth(spec.title, titleSize, 800) > inner - rightW - 20) titleSize -= 1;
      c.text(M, 74, spec.title, { size: titleSize, weight: 800 });
      c.text(M, 37, spec.rangeLabel || '', { size: 10.5, weight: 700, align: 'right', box: inner });
      if (spec.generatedLabel) c.text(M, 51, spec.generatedLabel, { size: 8.5, color: P.muted, align: 'right', box: inner });
      if (spec.compareLabel) c.text(M, 63, spec.compareLabel, { size: 8.5, color: P.muted, align: 'right', box: inner });
      y = 86;
      if (spec.filters && spec.filters.length) {
        let x = M;
        for (const filter of spec.filters) {
          const w = c.textWidth(filter, 8, 500) + 16;
          if (x + w > W - M) break;
          x += c.chip(x, y, filter, { fill: P.paper, color: P.ink, size: 8, weight: 500 }) + 6;
        }
        y += 28;
      } else y += 8;
    } else {
      c.mark(M, 20, 12, brand);
      c.text(M + 17, 29.5, `${brandInfo.name}, ${spec.title}`, { size: 9.5, weight: 700 });
      c.text(M, 29.5, spec.rangeLabel || '', { size: 8.5, color: P.muted, align: 'right', box: inner });
      y = 52;
    }
  };
  const room = () => H - FOOT - y;
  const ensure = (needed) => { if (room() < needed) newPage(false); };

  const heading = (x, yy, text, w, aside) => {
    const tw = c.text(x, yy, text, { size: 11.5, weight: 700 });
    let end = x + w;
    if (aside) end -= c.text(x, yy, aside, { size: 8.5, color: P.muted, align: 'right', box: w }) + 10;
    if (end > x + tw + 20) c.line(x + tw + 10, yy - 4, end, yy - 4);
  };

  newPage(true);

  // ---- Headline figures (or a balance equation), with an optional sparkline.
  if (spec.balance && spec.balance.length) {
    const ew = inner / spec.balance.length;
    spec.balance.forEach((item, i) => {
      const bx = M + i * ew;
      const last = i === spec.balance.length - 1;
      if (last) c.rect(bx + 10, y - 4, ew - 10, 58, brand, { radius: 10 });
      if (item.op) {
        c.circle(bx, y + 24, 9, P.paper);
        c.text(bx - 9, y + 27.8, item.op, { size: 11, weight: 700, align: 'center', box: 18 });
      }
      const tx = bx + (i ? 22 : 0);
      c.fitText(tx, y + 14, item.label, ew - 30, { size: 8.5, weight: 500, color: last ? P.white : P.muted });
      let size = last ? 14 : 13;
      while (size > 9 && c.textWidth(item.value, size, 800) > ew - 30) size -= 0.5;
      c.text(tx, y + 38, item.value, { size, weight: last ? 800 : 700, color: last ? P.white : P.ink });
    });
    y += 76;
  } else if (spec.summary && spec.summary.length) {
    const sparkW = spec.spark && orientation === 'landscape' ? 200 : 0;
    const stripW = inner - (sparkW ? sparkW + 20 : 0);
    const fw = stripW / spec.summary.length;
    spec.summary.forEach((kpi, i) => {
      const fx = M + i * fw + (i ? 12 : 0);
      const maxW = fw - (i ? 16 : 6);
      c.fitText(fx, y + 10, kpi.label, maxW, { size: 8.5, weight: 500, color: P.muted });
      let size = i === 0 ? 20 : 15;
      while (size > 9 && c.textWidth(String(kpi.value), size, 800) > maxW) size -= 0.5;
      c.text(fx, y + 34, String(kpi.value), { size, weight: i === 0 ? 800 : 700, color: i === 0 ? brand : P.ink });
      if (kpi.change && kpi.change.text) {
        c.chip(fx, y + 41, kpi.change.text, kpi.change.good === false
          ? { fill: P.failedBg, color: P.failed, size: 7.5 }
          : kpi.change.good === true ? { fill: P.paidBg, color: P.paid, size: 7.5 } : { fill: P.paper, color: P.muted, size: 7.5 });
      }
      if (i) c.line(M + i * fw, y, M + i * fw, y + 56);
    });
    if (sparkW && spec.spark.values.length) {
      const sx = W - M - sparkW;
      c.text(sx, y + 10, spec.spark.title || 'Each day', { size: 8.5, weight: 500, color: P.muted });
      const top = Math.max(...spec.spark.values, 1);
      const slot = sparkW / spec.spark.values.length;
      spec.spark.values.forEach((v, i) => {
        const bh = 30 * (v / top);
        c.rect(sx + i * slot, y + 48 - bh, Math.max(slot * 0.62, 1), Math.max(bh, v ? 1 : 0), v === top ? brand : blend(brand, P.white, 0.5), { radius: Math.min(1, slot * 0.3) });
      });
      if (spec.spark.from) c.text(sx, y + 60, spec.spark.from, { size: 7, color: P.muted });
      if (spec.spark.to) c.text(sx, y + 60, spec.spark.to, { size: 7, color: P.muted, align: 'right', box: sparkW });
    }
    y += spec.summary.some((k) => k.change && k.change.text) || sparkW ? 82 : 66;
  }

  // ---- Daily chart
  if (spec.daily && !spec.daily.excelOnly && spec.daily.points && spec.daily.points.length > 1 && spec.daily.points.some((p) => p.value > 0)) {
    ensure(150);
    heading(M, y + 6, spec.daily.title || 'Each day', inner, spec.daily.aside);
    const ch = 92; const top = y + 26;
    const values = spec.daily.points.map((p) => Number(p.value) || 0);
    const max = Math.max(...values);
    const steps = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 250000, 500000, 1000000];
    const step = steps.find((s) => max / s <= 4) || Math.pow(10, Math.ceil(Math.log10(max / 4)));
    const ceiling = Math.max(step, Math.ceil(max / step) * step);
    const short = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}m` : v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(v));
    for (let k = 0; k <= ceiling; k += step) {
      const gy = top + ch - ch * (k / ceiling);
      c.line(M + 34, gy, W - M, gy, '#EAF1F0', 0.7);
      c.text(M, gy + 3, short(k), { size: 7.5, color: P.muted, align: 'right', box: 28 });
    }
    const slot = (inner - 34) / values.length;
    const peak = values.indexOf(max);
    const labelEvery = Math.ceil(values.length / 8);
    values.forEach((v, i) => {
      const bh = ch * (v / ceiling);
      c.rect(M + 34 + i * slot + slot * 0.18, top + ch - bh, slot * 0.64, bh, i === peak ? brand : blend(brand, P.white, 0.45), { radius: Math.min(2.5, slot * 0.25) });
      if (i % labelEvery === 0 || i === values.length - 1) {
        c.text(M + 34 + i * slot, top + ch + 12, spec.daily.points[i].label, { size: 7, color: P.muted, align: 'center', box: slot });
      }
    });
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const ay = top + ch - ch * (avg / ceiling);
    c.line(M + 34, ay, W - M, ay, P.ink, 0.9, [3, 3]);
    const tag = `Average ${spec.daily.money === false ? Math.round(avg) : moneyText(Math.round(avg))} a day`;
    const tw = c.textWidth(tag, 7.5, 600) + 10;
    c.rect(W - M - tw, ay - 15, tw, 12, P.ink, { radius: 6 });
    c.text(W - M - tw + 5, ay - 6.3, tag, { size: 7.5, weight: 600, color: P.white });
    const px = M + 34 + peak * slot + slot / 2;
    const peakText = spec.daily.money === false ? String(max) : moneyText(max);
    const pw = c.textWidth(peakText, 7.5, 700);
    c.text(Math.min(Math.max(px - pw / 2, M + 34), W - M - pw), top + ch - ch * (max / ceiling) - 6, peakText, { size: 7.5, weight: 700, color: brand });
    y = top + ch + 34;
  }

  // ---- Table (continues over pages)
  if (cols.length) {
    const total = cols.reduce((s, col) => s + (col.width || 18), 0);
    const widths = cols.map((col) => ((col.width || 18) / total) * inner);
    const size = cols.length > 8 ? 8 : 8.5;
    const drawHeader = () => {
      let x = M;
      cols.forEach((col, i) => {
        c.fitText(x + (col.align === 'right' ? 0 : 0), y, col.label, widths[i] - 8, { size: 8, weight: 600, color: P.muted, align: col.align === 'right' ? 'right' : 'left', box: widths[i] - 8 });
        x += widths[i];
      });
      c.line(M, y + 7, W - M, y + 7, P.ink, 1.3);
      y += 7;
    };
    if (spec.tableTitle) { ensure(60); heading(M, y + 6, spec.tableTitle, inner, spec.tableAside); y += 28; }
    ensure(50);
    y += 4;
    drawHeader();
    const shares = cols.filter((col) => col.bar).map((col) => Math.max(...spec.rows.map((r) => Number(r[col.key]) || 0), 0) || 1);
    if (!spec.rows.length) {
      y += 22;
      c.text(M, y - 7, spec.emptyText || 'Nothing in this period.', { size: 9, color: P.muted });
      c.line(M, y, W - M, y, P.line, 0.6);
    }
    spec.rows.forEach((row, n) => {
      const texts = cols.map((col) => (col.money ? moneyText(row[col.key], spec.cents) : String(row[col.key] == null ? '' : row[col.key])));
      const lines = cols.map((col, i) => (col.align === 'right' || col.status || col.bar
        ? [texts[i]]
        : c.wrap(texts[i], size, 400, widths[i] - 8).slice(0, 3)));
      const rowH = Math.max(...lines.map((l) => l.length)) * (size + 3) + 8;
      if (room() < rowH + 4) { newPage(false); y += 4; drawHeader(); }
      if (n % 2) c.rect(M, y, inner, rowH, P.zebra);
      let x = M;
      const base = y + 4 + size;
      cols.forEach((col, i) => {
        const text = texts[i];
        if (col.status && text) {
          c.circle(x + 3, base - size * 0.36, 2.8, statusColor(text, brand));
          c.fitText(x + 10, base, text, widths[i] - 18, { size, weight: 500 });
        } else if (col.bar) {
          const share = (Number(row[col.key]) || 0) / shares[cols.filter((k) => k.bar).indexOf(col)];
          const valueW = c.textWidth(moneyText(row[col.key], spec.cents), size, 600) + 14;
          const track = Math.max(widths[i] - valueW - 18, 20);
          c.rect(x + 8, base - 7, track, 7, blend(brand, P.white, 0.88), { radius: 3.5 });
          c.rect(x + 8, base - 7, Math.max(track * share, 4), 7, brand, { radius: 3.5 });
          c.text(x, base, col.money ? moneyText(row[col.key], spec.cents) : text, { size, weight: 600, align: 'right', box: widths[i] - 8 });
        } else if (col.align === 'right') {
          c.fitText(x, base, text, widths[i] - 8, { size, weight: 600, align: 'right', box: widths[i] - 8, color: text ? P.ink : P.muted });
        } else {
          const color = col.muted || !text || text === '—' ? P.muted : P.ink;
          lines[i].forEach((line, j) => c.fitText(x, base + j * (size + 3), line, widths[i] - 8, { size, color }));
        }
        x += widths[i];
      });
      y += rowH;
      c.line(M, y, W - M, y, P.line, 0.6);
    });
    if (spec.totals) {
      if (room() < 26) { newPage(false); y += 4; }
      c.line(M, y + 1, W - M, y + 1, P.ink, 1.3);
      y += 18;
      let x = M;
      cols.forEach((col, i) => {
        const value = spec.totals[col.key];
        if (value != null && value !== '') {
          const text = col.money && typeof value === 'number' ? moneyText(value, spec.cents) : String(value);
          const last = i === cols.length - 1 && col.money;
          c.fitText(x, y, text, (col.align === 'right' ? widths[i] : widths[i] + (widths[i + 1] || 0)) - 8,
            { size: size + 0.5, weight: 800, color: last ? brand : P.ink, align: col.align === 'right' ? 'right' : 'left', box: widths[i] - 8 });
        }
        x += widths[i];
      });
      y += 8;
    }
    y += 22;
  }

  // ---- Breakdowns with share bars, in columns
  const breakdowns = (spec.breakdowns || []).filter((b) => b.rows && b.rows.length);
  if (breakdowns.length) {
    const per = orientation === 'landscape' ? 3 : 2;
    for (let start = 0; start < breakdowns.length; start += per) {
      const group = breakdowns.slice(start, start + per);
      const bw = (inner - (per - 1) * 24) / per;
      const height = Math.max(...group.map((b) => 24 + b.rows.reduce((s, r) => s + (r.note ? 26 : 20), 0)));
      ensure(height + 10);
      group.forEach((b, i) => {
        const bx = M + i * (bw + 24);
        heading(bx, y + 6, b.title, bw, b.aside);
        let by = y + 30;
        const top = Math.max(...b.rows.map((r) => Number(r.share) || 0), 0) || 1;
        const labelW = Math.min(bw * 0.38, Math.max(...b.rows.map((r) => c.textWidth(r.label, 9, 500))) + 12);
        for (const r of b.rows) {
          c.fitText(bx, by, r.label, labelW - 8, { size: 9, weight: 500 });
          const vw = c.text(bx, by, r.value, { size: 9, weight: 700, align: 'right', box: bw });
          const track = Math.max(bw - labelW - vw - 12, 16);
          c.rect(bx + labelW, by - 7, track, 7, blend(brand, P.white, 0.88), { radius: 3.5 });
          c.rect(bx + labelW, by - 7, Math.max(track * ((Number(r.share) || 0) / top), 4), 7, brand, { radius: 3.5 });
          if (r.note) c.fitText(bx + labelW, by + 11, r.note, bw - labelW, { size: 7.5, color: P.muted });
          by += r.note ? 26 : 20;
        }
      });
      y += height + 16;
    }
  }

  // ---- Busiest hours heatmap
  if (spec.heatmap && spec.heatmap.rows && spec.heatmap.rows.some((r) => r.values.some(Boolean))) {
    const rows = spec.heatmap.rows;
    const cellH = 13;
    ensure(30 + rows.length * (cellH + 2) + 24);
    heading(M, y + 6, spec.heatmap.title || 'Busiest hours', inner - 150);
    const lx = W - M - 112;
    c.text(lx - 28, y + 6, 'Fewer', { size: 7.5, color: P.muted });
    for (let k = 0; k < 5; k += 1) c.rect(lx + 2 + k * 16, y - 1.5, 14, 8, blend('#EEF5F4', brand, k / 4), { radius: 2 });
    c.text(lx + 86, y + 6, 'More', { size: 7.5, color: P.muted, align: 'right', box: 26 });
    const gx = M + 30; const gy = y + 20;
    const cell = (inner - 30) / 24;
    const max = Math.max(...rows.flatMap((r) => r.values), 1);
    rows.forEach((r, ri) => {
      c.text(M, gy + ri * (cellH + 2) + 9.5, r.label, { size: 7.5, weight: 500, color: P.muted });
      r.values.forEach((v, ci) => c.rect(gx + ci * cell + 1, gy + ri * (cellH + 2), cell - 2, cellH, blend('#EEF5F4', brand, Math.sqrt(v / max)), { radius: 2.5 }));
    });
    const by = gy + rows.length * (cellH + 2) + 9;
    [[0, '12 am'], [6, '6 am'], [12, '12 pm'], [18, '6 pm'], [23, '11 pm']].forEach(([h, label]) => c.text(gx + h * cell, by, label, { size: 7, color: P.muted }));
    y = by + 24;
  }

  // ---- Customers: a ring plus figures
  if (spec.customers) {
    const cu = spec.customers;
    ensure(100);
    heading(M, y + 6, cu.title || 'Customers', inner, cu.aside);
    const cx = M + 34; const cy = y + 56; const r = 26;
    c.circle(cx, cy, r, null, { stroke: blend(brand, P.white, 0.88), strokeWidth: 10 });
    c.ring(cx, cy, r, 10, brand, cu.ring.fraction);
    c.text(cx - r, cy + 4, `${Math.round(cu.ring.fraction * 100)}%`, { size: 11, weight: 800, align: 'center', box: 2 * r });
    c.text(M + 72, y + 40, cu.ring.label, { size: 8.5, weight: 500, color: P.muted });
    c.text(M + 72, y + 56, cu.ring.value, { size: 11, weight: 700 });
    if (cu.ring.note) c.text(M + 72, y + 72, cu.ring.note, { size: 8, color: P.muted });
    const stats = cu.stats || [];
    const sw = (inner - 190) / Math.max(stats.length, 1);
    stats.forEach((s, i) => {
      const x0 = M + 190 + i * sw;
      c.line(x0 - 10, y + 30, x0 - 10, y + 78);
      c.fitText(x0, y + 40, s.label, sw - 14, { size: 8.5, weight: 500, color: P.muted });
      c.fitText(x0, y + 56, s.value, sw - 14, { size: 11, weight: 700 });
      if (s.note) c.fitText(x0, y + 72, s.note, sw - 14, { size: 8, color: P.muted });
    });
    y += 100;
  }

  // ---- Side-by-side lists (payout accounts, notes)
  const lists = (spec.lists || []).filter((l) => l.items && l.items.length);
  if (lists.length) {
    const lw = (inner - 20 * (lists.length - 1)) / lists.length;
    // Plain strings are bullet points (wrapped); objects are { label, note, tag } entries.
    const laid = lists.map((l) => l.items.map((item) => (typeof item === 'string'
      ? { lines: c.wrap(item, 8.5, 400, lw - 10).slice(0, 3) } : item)));
    const heightOf = (items) => 24 + items.reduce((s, it) => s + (it.lines ? it.lines.length * 11 + 4 : it.note ? 26 : 15), 0);
    const height = Math.max(...laid.map(heightOf));
    ensure(height);
    lists.forEach((l, i) => {
      const lx0 = M + i * (lw + 20);
      heading(lx0, y + 6, l.title, lw);
      let ly = y + 26;
      for (const item of laid[i]) {
        if (item.lines) {
          c.circle(lx0 + 3, ly - 3, 2, brand);
          item.lines.forEach((line, j) => c.text(lx0 + 10, ly + j * 11, line, { size: 8.5 }));
          ly += item.lines.length * 11 + 4;
        } else {
          const w = c.fitText(lx0, ly, item.label, lw - (item.tag ? 70 : 0), { size: 9, weight: 600 });
          if (item.tag) c.chip(lx0 + w + 8, ly - 9.5, item.tag, { fill: blend(brand, P.white, 0.88), color: brand, size: 7.5 });
          if (item.note) c.fitText(lx0, ly + 11, item.note, lw, { size: 7.5, color: P.muted });
          ly += item.note ? 26 : 15;
        }
      }
    });
    y += height;
  }

  // ---- Footnotes, then the footer on every page
  const notes = spec.notes || [];
  if (notes.length) {
    // Right under the content, or on a new page when the page is full.
    const lines = notes.flatMap((note) => c.wrap(note, 7.5, 400, inner));
    if (room() < lines.length * 11 + 4) newPage(false);
    lines.forEach((line, i) => c.text(M, y + 4 + i * 11, line, { size: 7.5, color: P.muted }));
  }
  pages.forEach((page, i) => {
    page.line(M, H - 30, W - M, H - 30);
    page.mark(M, H - 24, 10, P.muted);
    page.text(M + 14, H - 16, brandInfo.footer || 'Billed on Wi-Fi Fiti, M-Pesa hotspot billing. wififiti.co.ke', { size: 7.5, weight: 500, color: P.muted });
    page.text(M, H - 16, `Page ${i + 1} of ${pages.length}`, { size: 7.5, weight: 500, color: P.muted, align: 'right', box: inner });
  });
  return pages.map((page) => ({ width: W, height: H, ops: page.ops }));
}

module.exports = { reportLayout, statusColor, moneyText, A4 };

'use strict';

/*
 * The receipt as a ticket: the amount large on the business's color with
 * Wi-Fi signal arcs, a tear-off line, then everything the customer may
 * need later, in labelled sections. The page is as tall as its content.
 *
 * Input (from receipt.js receiptData):
 *   brand { name, colorCss }, place, number, when, amountLabel, amount,
 *   state ('paid'|'pending'|'failed'), stateLabel, subtitle, saved,
 *   sections [{ title, items: [{ kind, label, value, fraction }] }]
 *     kind: 'row' | 'code' | 'good' | 'bar' | 'total' | 'note'
 *   recovery { code, note }, steps { title, items: [] },
 *   qr { url, title, note }, contacts [[label, value]], footer, printed
 */

const { Canvas, PALETTE: P, blend } = require('./canvas');

const W = 360;
const M = 24;

function receiptLayout(d, measure) {
  const c = new Canvas({ width: W, height: 0, measure });
  const brand = d.brand.colorCss || P.brand;
  const soft = blend(brand, P.white, 0.72);
  const inner = W - 2 * M;

  // ---- Brand block
  const headH = d.saved ? 214 : 192;
  c.rect(0, 0, W, headH + 18, brand, { radius: 18 });
  c.rect(0, headH - 18, W, 18, brand);
  c.arcs(W - 14, headH + 14, [36, 66, 96, 126, 156, 186], P.white, 0.12, 10, [0, 0, W, headH]);
  c.mark(M, 22, 20, P.white);
  const right = Math.max(c.textWidth(d.number, 9, 600), c.textWidth(d.when, 9, 500)) + 12;
  c.fitText(M + 28, 34, d.brand.name, inner - 28 - right, { size: 13, weight: 700, color: P.white });
  if (d.place) c.fitText(M + 28, 49, d.place, inner - 28 - right, { size: 9, weight: 500, color: soft });
  c.text(M, 34, d.number, { size: 9, weight: 600, color: P.white, align: 'right', box: inner });
  c.text(M, 49, d.when, { size: 9, weight: 500, color: soft, align: 'right', box: inner });
  c.text(M, 86, d.amountLabel, { size: 10, weight: 500, color: soft });
  let amountSize = 50;
  while (amountSize > 28 && c.textWidth(d.amount, amountSize, 800) > inner) amountSize -= 2;
  c.text(M, 134, d.amount, { size: amountSize, weight: 800, color: P.white });
  const state = { paid: [P.mint, P.paid], pending: [P.pendingBg, P.pending], failed: [P.failedBg, P.failed] }[d.state] || [P.mint, P.paid];
  const chipW = c.chip(M, 150, d.stateLabel, { fill: state[0], color: P.ink, size: 10, dot: state[1] });
  if (d.subtitle) c.fitText(M + chipW + 10, 163.5, d.subtitle, inner - chipW - 10, { size: 10, weight: 600, color: P.white });
  if (d.saved) {
    c.rect(M, 182, inner, 18, blend(brand, '#000000', 0.18), { radius: 9 });
    c.fitText(M + 10, 194.5, d.saved, inner - 20, { size: 8.5, weight: 500, color: P.white });
  }

  // ---- Tear-off line
  const tear = headH + 16;
  c.circle(0, tear, 9, P.paper);
  c.circle(W, tear, 9, P.paper);
  c.line(16, tear, W - 16, tear, P.line, 1.4, [4, 4]);

  // ---- Sections
  let y = headH + 50;
  const heading = (title) => {
    const tw = c.text(M, y, title, { size: 11, weight: 700 });
    c.line(M + tw + 10, y - 3.5, W - M, y - 3.5);
    y += 21;
  };
  for (const section of d.sections || []) {
    if (!section.items || !section.items.length) continue;
    heading(section.title);
    for (const item of section.items) {
      if (item.kind === 'bar') {
        c.text(M, y, item.label, { size: 9.5, color: P.muted });
        c.text(M, y, item.value, { size: 9.5, weight: 600, align: 'right', box: inner });
        c.rect(M, y + 7, inner, 6, blend(brand, P.white, 0.88), { radius: 3 });
        c.rect(M, y + 7, Math.max(inner * Math.max(0, Math.min(1, item.fraction || 0)), 6), 6, brand, { radius: 3 });
        y += 30;
      } else if (item.kind === 'total') {
        c.line(M, y - 11, W - M, y - 11, P.ink, 1.2);
        y += 6;
        c.text(M, y, item.label, { size: 11, weight: 700 });
        c.text(M, y + 1, item.value, { size: 15, weight: 800, color: brand, align: 'right', box: inner });
        y += 22;
      } else if (item.kind === 'note') {
        for (const line of c.wrap(item.value, 8.5, 400, inner)) { c.text(M, y, line, { size: 8.5, color: P.muted }); y += 12; }
        y += 4;
      } else {
        const labelW = c.text(M, y, item.label, { size: 9.5, color: P.muted });
        const color = item.kind === 'good' ? P.paid : P.ink;
        const spacing = item.kind === 'code' ? 0.6 : 0;
        const max = inner - labelW - 14;
        const value = String(item.value);
        if (c.textWidth(value, 9.5, 600, spacing) <= max) c.text(M, y, value, { size: 9.5, weight: 600, color, align: 'right', box: inner, spacing });
        else {
          // A long value wraps onto lines of its own, right-aligned.
          const lines = c.wrap(value, 9.5, 600, max);
          lines.forEach((line, i) => c.text(M, y + i * 13, line, { size: 9.5, weight: 600, color, align: 'right', box: inner }));
          y += (lines.length - 1) * 13;
        }
        y += 19;
      }
    }
    y += 12;
  }

  // ---- Recovery code
  if (d.recovery && d.recovery.code) {
    const lines = c.wrap(d.recovery.note || '', 8.5, 400, inner - 186);
    const h = Math.max(78, 30 + 12 * lines.length);
    c.rect(M, y, inner, h, P.paper, { radius: 12 });
    c.rect(M, y, 5, h, brand, { radius: 2.5 });
    c.text(M + 18, y + 22, 'Recovery code', { size: 9, weight: 600, color: P.muted });
    c.text(M + 18, y + 54, d.recovery.code, { size: 26, weight: 800, spacing: 3 });
    lines.forEach((line, i) => c.text(M + 168, y + 22 + 12 * i, line, { size: 8.5, color: P.muted }));
    y += h + 22;
  }

  // ---- Numbered steps
  if (d.steps && d.steps.items && d.steps.items.length) {
    heading(d.steps.title);
    y -= 1;
    d.steps.items.forEach((step, i) => {
      c.circle(M + 8, y - 3.5, 8, brand);
      c.text(M, y, String(i + 1), { size: 9, weight: 700, color: P.white, align: 'center', box: 16 });
      const lines = c.wrap(step, 9, 400, inner - 26);
      lines.forEach((line, j) => c.text(M + 26, y + 12 * j, line, { size: 9 }));
      y += 12 * lines.length + 10;
    });
    y += 10;
  }

  // ---- QR code to the online copy
  if (d.qr && d.qr.url) {
    c.rect(M, y, inner, 104, P.white, { radius: 12, stroke: P.line, strokeWidth: 1 });
    c.qr(M + 12, y + 12, 80, d.qr.url, P.ink);
    c.fitText(M + 108, y + 30, d.qr.title, inner - 120, { size: 10.5, weight: 700 });
    c.wrap(d.qr.note || '', 8.5, 400, inner - 120).slice(0, 3)
      .forEach((line, i) => c.text(M + 108, y + 46 + 12 * i, line, { size: 8.5, color: P.muted }));
    c.fitText(M + 108, y + 88, d.qr.url.replace(/^https?:\/\//, ''), inner - 120, { size: 8.5, weight: 600, color: brand });
    y += 104 + 22;
  }

  // ---- Contacts and footer
  c.line(M, y, W - M, y);
  y += 18;
  const contacts = (d.contacts || []).filter(([, value]) => value);
  if (contacts.length) {
    const cw = inner / contacts.length;
    contacts.forEach(([label, value], i) => {
      c.text(M + i * cw, y, label, { size: 8, weight: 500, color: P.muted });
      c.fitText(M + i * cw, y + 13, value, cw - 8, { size: 8.5, weight: 600 });
    });
    y += 32;
  } else y += 4;
  c.mark(M, y - 9, 12, brand);
  c.text(M + 17, y, d.footer || 'Billed on Wi-Fi Fiti', { size: 8, weight: 500, color: P.muted });
  if (d.printed) c.text(M, y, d.printed, { size: 8, color: P.muted, align: 'right', box: inner });

  // The ticket sits on a pale page with a margin, so its rounded corners and
  // tear-off notches show on screen and in print.
  const ticketH = Math.ceil(y + 22);
  const G = 14;
  const ops = [
    { op: 'rect', x: 0, y: 0, w: W + 2 * G, h: ticketH + 2 * G, fill: P.paper, radius: 0 },
    { op: 'push', dx: G, dy: G },
    { op: 'rect', x: 0, y: 0, w: W, h: ticketH, fill: P.white, radius: 18 },
    ...c.ops,
    { op: 'pop' },
  ];
  return { width: W + 2 * G, height: ticketH + 2 * G, ops };
}

module.exports = { receiptLayout, RECEIPT_WIDTH: W };

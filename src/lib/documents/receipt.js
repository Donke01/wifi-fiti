'use strict';

/*
 * Receipts: a customer's proof of payment for a hotspot package, and Wi-Fi
 * Fiti's own plan receipt. Both are drawn by layout-receipt.js as a ticket
 * (amount on the business's color, then sections of details) and come out
 * as PDF (render-pdf.js), Word (.docx, same content as plain sections) or
 * Excel (via table-export.js receiptReportSpec, one row per detail).
 *
 * receiptData() turns whatever a transaction row has into those sections.
 * A detail the row doesn't have is simply left out, so an older payment
 * without a device label or speed still gets a tidy receipt.
 */

const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, ShadingType, TabStopType } = require('docx');
const { receiptLayout } = require('./layout-receipt');
const { renderPdf, pdfMeasure } = require('./render-pdf');
const { PLATFORM, formatKes, formatDateTime, tenantBrand, documentNumber } = require('./brand');

const STATES = {
  paid: { state: 'paid', label: 'Paid', word: 'PAID' },
  completed: { state: 'paid', label: 'Paid', word: 'PAID' },
  pending: { state: 'pending', label: 'Waiting for M-Pesa', word: 'PENDING' },
  processing: { state: 'pending', label: 'Waiting for M-Pesa', word: 'PENDING' },
};
const FAILED = { state: 'failed', label: 'Not completed', word: 'NOT COMPLETED' };

const PAID_TO = {
  fiti: 'Wi-Fi Fiti M-Pesa, collected for the business',
  own: "The business's own Till or PayBill",
  tuma: 'Tuma', tuma_direct: 'Tuma',
  c2b: 'PayBill',
};
const DEVICE = { phone: 'Phone', tv: 'TV', laptop: 'Laptop', tablet: 'Tablet', other: 'Other device' };

function parseSqlTime(value) {
  let text = String(value || '').trim().replace(' ', 'T');
  if (!text) return null;
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(text)) text += 'Z';
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** 86400 -> "24 hours", 604800 -> "7 days", 5400 -> "1 h 30 min". */
function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return '';
  const days = s / 86400; const hours = s / 3600;
  if (s % 86400 === 0 && days >= 2) return `${days} days`;
  if (s % 3600 === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(hours)} h ${Math.round((s % 3600) / 60)} min`;
}

/** RouterOS "rx/tx" (upload/download as the router sees the customer) -> words. */
function speed(rateLimit) {
  const m = String(rateLimit || '').trim().match(/^(\d+(?:\.\d+)?)([kKmMgG]?)\/(\d+(?:\.\d+)?)([kKmMgG]?)/);
  if (!m) return '';
  const mbps = (value, unit) => {
    const n = Number(value) * ({ k: 0.001, m: 1, g: 1000 }[unit.toLowerCase()] || 0.000001);
    return n >= 1 ? `${Number(n.toFixed(1))}` : `${Math.round(n * 1000)}k`;
  };
  return `Up to ${mbps(m[3], m[4])} Mbps down, ${mbps(m[1], m[2])} up`;
}

/** 254712345678 -> 0712 345 678 */
function phoneText(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const local = digits.startsWith('254') && digits.length === 12 ? `0${digits.slice(3)}` : digits;
  return local.length === 10 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : String(phone || '');
}

const kesCents = (amount) => 'KES ' + Number(amount || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Everything the renderers need, from a transaction row (tenant_transactions
 * plus optional joined fields: location_name, router_name, wifi_ssid,
 * expires_at, portal_url, paid_to). `audience` 'customer' adds the recovery
 * code and reconnect steps; a business download leaves them out.
 *
 * Other receipts (the Wi-Fi Fiti plan receipt) pass their own `sections`,
 * `title`, `subtitle` and `footnote`.
 */
function receiptData({ business, transaction, receiptNumber, numberPrefix, title, subtitle, sections, footnote, fields,
  audience = 'business', now = new Date(), qr, place, amountLabel, contacts, footer }) {
  const t = transaction || {};
  const brand = business === null
    ? { name: PLATFORM.name, colorHex: PLATFORM.colorHex, colorCss: PLATFORM.colorCss, supportPhone: '', poweredBy: `${PLATFORM.name}, ${PLATFORM.tagline}` }
    : tenantBrand(business);
  const number = receiptNumber || documentNumber(numberPrefix || 'RCT', t.checkout_request_id || t.mpesa_receipt || t.id);
  const status = STATES[t.status] || FAILED;
  const paidAt = parseSqlTime(t.updated_at || t.created_at);
  const when = formatDateTime(t.updated_at || t.created_at);
  const customer = audience === 'customer';

  let built = sections;
  let recovery = null; let steps = null; let qrBlock = qr || null;
  if (!built) {
    const wifi = [];
    if (t.package_name) wifi.push({ kind: 'row', label: 'Package', value: t.package_name });
    const time = duration(t.seconds);
    if (time && time.toLowerCase() !== String(t.package_name || '').trim().toLowerCase()) wifi.push({ kind: 'row', label: 'Time', value: time });
    const rate = speed(t.rate_limit);
    if (rate) wifi.push({ kind: 'row', label: 'Speed', value: rate });
    const ends = parseSqlTime(t.expires_at) || (paidAt && t.seconds && status.state === 'paid' ? new Date(paidAt.getTime() + Number(t.seconds) * 1000) : null);
    if (status.state === 'paid' && paidAt) wifi.push({ kind: 'row', label: 'Started', value: formatDateTime(paidAt.toISOString()) });
    if (status.state === 'paid' && ends) wifi.push({ kind: 'row', label: 'Ends', value: formatDateTime(ends.toISOString()) });
    if (status.state === 'pending') wifi.push({ kind: 'row', label: 'Starts', value: 'As soon as M-Pesa confirms' });
    if (status.state === 'paid' && ends && t.seconds && ends > now) {
      const left = (ends.getTime() - now.getTime()) / 1000;
      wifi.push({ kind: 'bar', label: 'Time left', value: duration(Math.max(60, Math.round(left / 60) * 60)), fraction: Math.min(1, left / Number(t.seconds)) });
    } else if (status.state === 'paid' && ends && ends <= now) wifi.push({ kind: 'row', label: 'Time left', value: 'Used up' });

    const device = [];
    const kind = DEVICE[String(t.device_type || '').toLowerCase()];
    const label = String(t.device_label || '').trim();
    if (kind || label) device.push({ kind: 'row', label: 'Device', value: [kind, label].filter(Boolean).join(', ') });
    if (t.mac) device.push({ kind: 'code', label: 'MAC address', value: String(t.mac).toUpperCase() });
    if (t.ip) device.push({ kind: 'code', label: 'IP address', value: t.ip });
    if (t.location_name) device.push({ kind: 'row', label: 'Hotspot', value: t.location_name });
    if (t.router_name) device.push({ kind: 'row', label: 'Router', value: t.router_name });
    if (t.wifi_ssid) device.push({ kind: 'row', label: 'Network name', value: t.wifi_ssid });

    const payment = [];
    if (t.phone) payment.push({ kind: 'row', label: status.state === 'pending' ? 'Prompt sent to' : 'Phone', value: phoneText(t.phone) });
    const paidTo = t.paid_to || PAID_TO[t.payment_source];
    if (paidTo) payment.push({ kind: 'row', label: 'Paid to', value: paidTo });
    payment.push({ kind: 'code', label: 'M-Pesa code', value: t.mpesa_receipt || (status.state === 'pending' ? 'Not received yet' : '—') });
    if (status.state === 'paid' && when) payment.push({ kind: 'row', label: 'Confirmed', value: when });
    if (status.state === 'failed' && t.result_desc) payment.push({ kind: 'row', label: 'M-Pesa said', value: String(t.result_desc).slice(0, 120) });
    payment.push({ kind: 'row', label: 'Receipt number', value: number });
    payment.push({ kind: 'total', label: status.state === 'paid' ? 'Total paid' : 'To pay', value: kesCents(t.amount) });
    payment.push({ kind: 'note', value: status.state === 'pending'
      ? 'Enter your M-Pesa PIN on your phone. You are not charged until you approve.'
      : 'Prices include all charges. M-Pesa may charge its own fee on your side.' });

    built = [
      { title: 'Your Wi-Fi', items: wifi },
      { title: customer ? 'This device' : 'Device', items: device },
      { title: 'Payment', items: payment },
    ];

    const code = t.recovery_code || t.password;
    if (customer && code) {
      recovery = { code, note: status.state === 'paid'
        ? 'Lost connection or changed phone? Open wififiti.net on this Wi-Fi and enter this code with your phone number.'
        : 'Save this now. It starts working once M-Pesa confirms, and gets you back online on any device.' };
      if (status.state === 'paid') {
        steps = { title: 'Reconnect in 3 steps', items: [
          t.wifi_ssid ? `Join ${t.wifi_ssid}.` : 'Join this Wi-Fi.',
          'Open wififiti.net, or wait for the sign-in page.',
          `Tap "Already paid? Recover your package" and enter ${code}.`] };
      }
    }
    if (!qrBlock && t.portal_url) {
      qrBlock = { url: t.portal_url, title: customer ? 'Open the Wi-Fi page' : "This hotspot's Wi-Fi page",
        note: customer ? 'Scan while on this Wi-Fi to check time left or buy more time.' : 'Where customers buy and recover packages.' };
    }
  }
  if (fields && !sections) built = [{ title: 'Details', items: fields.map(([label, value]) => ({ kind: 'row', label, value })) }];

  // Flat [label, value] pairs: the Excel receipt and anything that lists fields.
  const flat = [['Receipt number', number]];
  for (const section of built) {
    for (const item of section.items) {
      if (item.kind === 'note' || item.label === 'Receipt number') continue;
      flat.push([item.label, item.value == null || item.value === '' ? '—' : String(item.value)]);
    }
  }
  if (footnote) flat.push(['Note', footnote]);
  if (footnote) built = [...built, { title: 'Note', items: [{ kind: 'note', value: footnote }] }];

  const amount = formatKes(t.amount);
  return {
    brand, number, when, date: when, amount,
    amountLabel: amountLabel || (status.state === 'paid' ? (customer ? 'You paid' : 'Customer paid') : status.state === 'pending' ? 'Waiting for approval' : 'Not paid'),
    state: status.state, stateLabel: status.label,
    status: { text: status.word, color: status.state === 'paid' ? PLATFORM.colorGood : status.state === 'pending' ? PLATFORM.colorWarn : PLATFORM.colorBad },
    subtitle: subtitle != null ? subtitle : (t.package_name ? `${t.package_name}${/wi-?fi/i.test(t.package_name) ? '' : ' of Wi-Fi'}` : ''),
    place: place != null ? place : [t.location_name, t.wifi_ssid && t.wifi_ssid !== t.location_name ? t.wifi_ssid : ''].filter(Boolean).join(', '),
    title: title || 'Payment receipt',
    sections: built, recovery, steps, qr: qrBlock,
    contacts: contacts || [['Help line', brand.supportPhone], ['Wi-Fi page', business === null ? '' : 'wififiti.net'], ['Receipt', number]],
    footer: footer || (business === null ? 'wififiti.co.ke' : `Billed on ${PLATFORM.name}`),
    printed: `Printed ${formatDateTime(now.toISOString())}`,
    fields: flat, footnote: footnote || '',
    phone: t.phone || '', packageName: t.package_name || '', mpesaReceipt: t.mpesa_receipt || '—', routerSite: t.location_name || '',
  };
}

/* ---------------------------------------------------------------- pdf */

function buildReceiptPdf(input) {
  try {
    const d = receiptData(input);
    const page = receiptLayout(d, input.measure || pdfMeasure());
    return renderPdf([page], { Title: `${d.brand.name} receipt ${d.number}` });
  } catch (error) { return Promise.reject(error); }
}

/* --------------------------------------------------------------- docx */

function buildReceiptDocx(input) {
  const d = receiptData(input);
  const brand = d.brand.colorHex || PLATFORM.colorHex;
  const ink = '0E2A33'; const muted = '5E7480';
  const FONT = 'Bricolage Grotesque';
  const run = (text, opts = {}) => new TextRun({ text: String(text), font: FONT, size: opts.size || 19, bold: !!opts.bold, color: opts.color || ink, characterSpacing: opts.spacing });
  const para = (children, opts = {}) => new Paragraph({ children, spacing: { before: opts.before || 0, after: opts.after ?? 80 }, alignment: opts.align,
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined, border: opts.border, indent: opts.indent,
    tabStops: [{ type: TabStopType.RIGHT, position: 9000 }] });
  const rule = (color = 'DCE7E5', style = BorderStyle.SINGLE) => ({ bottom: { style, size: 6, color, space: 4 } });

  const children = [
    para([run(d.brand.name, { size: 26, bold: true, color: 'FFFFFF' }), run(`\t${d.number}`, { size: 17, color: 'FFFFFF', bold: true })], { fill: brand, before: 0, after: 0, indent: { left: 200, right: 200 } }),
    para([run(d.place || ' ', { size: 17, color: 'E6F4F6' }), run(`\t${d.when}`, { size: 17, color: 'E6F4F6' })], { fill: brand, after: 0, indent: { left: 200, right: 200 } }),
    para([run(d.amountLabel, { size: 19, color: 'E6F4F6' })], { fill: brand, before: 0, after: 0, indent: { left: 200 } }),
    para([run(d.amount, { size: 72, bold: true, color: 'FFFFFF' })], { fill: brand, after: 0, indent: { left: 200 } }),
    para([run(` ${d.stateLabel} `, { size: 19, bold: true, color: ink }), run(d.subtitle ? `   ${d.subtitle}` : '', { size: 19, bold: true, color: 'FFFFFF' })], { fill: brand, after: 200, indent: { left: 200 } }),
    para([], { border: rule('B8C4CC', BorderStyle.DASHED), after: 200 }),
  ];
  for (const section of d.sections) {
    if (!section.items.length) continue;
    children.push(para([run(section.title, { size: 22, bold: true })], { before: 160, after: 100, border: rule() }));
    for (const item of section.items) {
      if (item.kind === 'note') children.push(para([run(item.value, { size: 16, color: muted })], { after: 120 }));
      else if (item.kind === 'total') children.push(para([run(item.label, { size: 22, bold: true }), run(`\t${item.value}`, { size: 28, bold: true, color: brand })], { before: 80, border: { top: { style: BorderStyle.SINGLE, size: 10, color: ink, space: 4 } } }));
      else children.push(para([run(item.label, { color: muted }), run(`\t${item.value}`, { bold: true, color: item.kind === 'good' ? '1E8E5A' : ink })]));
    }
  }
  if (d.recovery) {
    children.push(para([run('Recovery code', { size: 17, bold: true, color: muted })], { before: 240, after: 0, fill: 'F2F7F6', indent: { left: 200 } }));
    children.push(para([run(d.recovery.code, { size: 44, bold: true, spacing: 60 })], { after: 0, fill: 'F2F7F6', indent: { left: 200 } }));
    children.push(para([run(d.recovery.note, { size: 16, color: muted })], { after: 160, fill: 'F2F7F6', indent: { left: 200, right: 200 } }));
  }
  if (d.steps) {
    children.push(para([run(d.steps.title, { size: 22, bold: true })], { before: 160, after: 100, border: rule() }));
    d.steps.items.forEach((step, i) => children.push(para([run(`${i + 1}   `, { bold: true, color: brand }), run(step)])));
  }
  if (d.qr) children.push(para([run(`${d.qr.title}: `, { bold: true }), run(d.qr.url, { color: brand })], { before: 160 }));
  const contacts = d.contacts.filter(([, value]) => value);
  children.push(para([], { border: rule(), after: 120 }));
  if (contacts.length) children.push(para(contacts.flatMap(([label, value], i) => [run(`${i ? '     ' : ''}${label}  `, { size: 16, color: muted }), run(value, { size: 16, bold: true })])));
  children.push(para([run(d.footer, { size: 16, color: muted }), run(`\t${d.printed}`, { size: 16, color: muted })]));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT } } } },
    sections: [{ properties: { page: { size: { width: 10800, height: 15840 }, margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildReceiptDocx, buildReceiptPdf, receiptData, duration, speed };

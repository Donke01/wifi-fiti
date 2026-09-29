'use strict';

/*
 * Shared look for every generated document (receipts, reports). One place
 * for the palette and the small text helpers every generator needs, so a
 * customer receipt, a tenant report and an admin report always read as the
 * same family of document even though they are built by three different
 * libraries (docx, pdfkit, exceljs).
 *
 * Colors match the marketing site's teal (public/marketing.html --cyan),
 * but on white: a receipt gets printed, forwarded as a screenshot, and
 * opened on a cheap Android screen in bright sunlight - a dark theme that
 * looks good on the dashboard would be unreadable there.
 */

// The exact palette public/marketing.html uses for its light (print-safe)
// mode (line 25: --cyan:#007d90 - the dark-bg mint #5ce6d2 fails contrast
// on white paper). Documents are the one place Wi-Fi Fiti's brand has to
// work in print and on a cheap phone screen in sunlight, so the palette
// stays print-safe rather than reaching for the site's neon dark-mode hues.
const PLATFORM = Object.freeze({
  name: 'Wi-Fi Fiti',
  tagline: 'M-Pesa hotspot billing',
  colorHex: '007D90',    // teal - primary brand accent, no leading # (docx/exceljs want it bare)
  colorCss: '#007D90',
  colorDeep: '005A6B',   // deeper teal, for gradients/pressed states
  colorDark: '06111F',   // deep navy - marketing.html's --night; headers/bands
  colorDarkCss: '#06111F',
  colorMint: '5CE6D2',   // marketing.html's --cyan (dark-mode); a bright highlight, used sparingly on print
  colorGold: 'B8860B',   // marketing.html's --gold, darkened for contrast on white
  colorGood: '1E8E5A',   // paid / confirmed
  colorGoodBg: 'E3F5EC',
  colorWarn: 'B8860B',   // pending
  colorWarnBg: 'FBF1DC',
  colorBad: 'C0392B',    // failed / reversed
  colorBadBg: 'FBE9E7',
  grey: '6B7A87',
  faintLine: 'D9E2E7',
  tint: 'E6F4F6',        // 8-10% teal wash, for panels/bands
});

function formatKes(amount) {
  const n = Number(amount) || 0;
  return 'KES ' + n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDateTime(value) {
  let text = String(value || '').trim().replace(' ', 'T');
  if (text && !/(?:Z|[+-]\d\d:\d\d)$/i.test(text)) text += 'Z';
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return String(value || '');
  return at.toLocaleString('en-KE', {
    timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).replace(',', ' ·');
}

function formatDate(value) {
  let text = String(value || '').trim().replace(' ', 'T');
  if (text && !/(?:Z|[+-]\d\d:\d\d)$/i.test(text)) text += 'Z';
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return String(value || '');
  return at.toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric' });
}

/** Deterministic, short, human-readable id for a document that has none yet. */
function documentNumber(prefix, seed) {
  const s = String(seed || Date.now());
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return `${prefix}-${hash.toString(36).toUpperCase().padStart(6, '0').slice(-6)}`;
}

/** What a tenant's documents are branded with; falls back to plain Wi-Fi Fiti branding. */
function tenantBrand(business) {
  const name = (business && (business.portal_name || business.business_name || business.name)) || PLATFORM.name;
  const color = (business && business.brand_primary_color && /^#?[0-9a-fA-F]{6}$/.test(business.brand_primary_color))
    ? business.brand_primary_color.replace('#', '')
    : PLATFORM.colorHex;
  return {
    name,
    colorHex: color,
    colorCss: `#${color}`,
    supportPhone: (business && business.support_phone) || '',
    poweredBy: `Billed on ${PLATFORM.name} — ${PLATFORM.tagline}`,
  };
}

// The Wi-Fi Fiti vector mark lives in ./wifi-mark.js (pdfkit-only; docx and
// xlsx have no vector-drawing API, so their headers use a text lockup
// instead - see receipt.js's docx band and report.js's xlsx band).

module.exports = { PLATFORM, formatKes, formatDateTime, formatDate, documentNumber, tenantBrand };

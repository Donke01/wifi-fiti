function purchaseDeviceType(value) {
  if (value === undefined || value === null || value === '') return 'phone';
  return value === 'phone' || value === 'tv' ? value : null;
}

function normaliseTvMac(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase();
  if (!/^(?:[0-9A-F]{12}|(?:[0-9A-F]{2}:){5}[0-9A-F]{2}|(?:[0-9A-F]{2}-){5}[0-9A-F]{2})$/.test(raw)) return null;
  const compact = raw.replace(/[:-]/g, '');
  if (compact === '000000000000' || (parseInt(compact.slice(0, 2), 16) & 1)) return null;
  return compact.match(/../g).join(':');
}

function normaliseDeviceLabel(value, type) {
  return String(value || '').replace(/[^\w -]/g, '').trim().slice(0, 24) || (type === 'tv' ? 'TV' : '');
}

module.exports = { purchaseDeviceType, normaliseTvMac, normaliseDeviceLabel };

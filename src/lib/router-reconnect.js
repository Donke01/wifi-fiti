'use strict';

// Only router-authenticated HotSpot host telemetry may initiate a reconnect.
// No customer-controlled MAC, query parameter, receipt or phone number grants it.
const COOLDOWN_MS = 90_000;
const MAX_PER_REPORT = 15;
const MIN_REMAINING_MS = 30_000; // Never queue a slow fallback at the wall-clock expiry boundary.
const lastAttempt = new Map();

function optedIn(locationId, list = process.env.FITI_ROUTER_RECONNECT_LOCATIONS || '') {
  return Boolean(locationId && String(list).split(',').map(x => x.trim()).includes(String(locationId)));
}

function reconnectCandidates({ location, report, findSubscription, now = Date.now(), enabled = optedIn(location && location.id) }) {
  if (!enabled || !location || !report || !Array.isArray(report.devices)) return [];
  const active = new Set((report.sessions || []).map(s => String(s.mac || '').toUpperCase()));
  const seen = new Set();
  const found = [];
  for (const dev of report.devices) {
    if (found.length >= MAX_PER_REPORT) break;
    const mac = String(dev.mac || '').toUpperCase();
    const ip = String(dev.ip || '');
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ||
      ip.split('.').some(n => Number(n) > 255) || seen.has(mac) || active.has(mac)) continue;
    seen.add(mac);
    const subscription = findSubscription(location.id, mac);
    if (!subscription || subscription.mac !== mac || subscription.location_id !== location.id ||
        subscription.device_type === 'tv' || !subscription.router_username || !subscription.password) continue;
    const expiry = Date.parse(String(subscription.expires_at || '').replace(' ', 'T') + 'Z');
    if (!Number.isFinite(expiry) || expiry - now <= MIN_REMAINING_MS) continue;
    const key = location.id + ':' + mac;
    if ((lastAttempt.get(key) || 0) > now - COOLDOWN_MS) continue;
    found.push({ key, mac, ip, subscription });
  }
  return found;
}

function markAttempt(key, at = Date.now()) {
  lastAttempt.set(key, at);
  if (lastAttempt.size > 5000) {
    for (const [k, time] of lastAttempt) if (time < at - COOLDOWN_MS) lastAttempt.delete(k);
  }
}

module.exports = { reconnectCandidates, markAttempt, optedIn, COOLDOWN_MS, MIN_REMAINING_MS };

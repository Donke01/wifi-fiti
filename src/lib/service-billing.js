'use strict';

/**
 * Prepaid service entitlements.
 *
 * Tenants prepay monthly capacity instead of giving up a share of their
 * sales:
 *   - Hotspot: KES 1,000 per 100 peak concurrent customers.
 *   - PPPoE + Static IP: KES 500 under 35 users, then KES 15 per active user.
 * Wi‑Fi Fiti collection (the tenant has no Till of their own) still carries
 * its 5% fee, because that money passes through Wi‑Fi Fiti.
 *
 * Once a paid period ends there are GRACE_DAYS during which sales continue
 * and the dashboard warns the owner. After that, new sales stop. Customers who
 * are already online always keep the time they paid for.
 *
 * This file is pure: it takes business rows and counts and returns decisions,
 * so every rule is unit-tested without a database or network.
 */

const GRACE_DAYS = 3;
const DAY_MS = 86400_000;

function parseTime(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const value = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
  return Number.isFinite(value) ? value : null;
}

function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

/** active | grace | expired | none, with the key dates. */
function periodState(expiresRaw, now = Date.now()) {
  const expiresAt = parseTime(expiresRaw);
  if (expiresAt == null) return { status: 'none', expiresAt: null, graceEndsAt: null, daysLeft: null };
  const graceEndsAt = expiresAt + GRACE_DAYS * DAY_MS;
  const status = now < expiresAt ? 'active' : now < graceEndsAt ? 'grace' : 'expired';
  const target = status === 'active' ? expiresAt : graceEndsAt;
  return { status, expiresAt: iso(expiresAt), graceEndsAt: iso(graceEndsAt), daysLeft: Math.max(0, Math.ceil((target - now) / DAY_MS)) };
}

function trialState(business, now = Date.now()) {
  if (String(business && business.billing_status || '').toLowerCase() !== 'trial') return { active: false, endsAt: null };
  const ends = parseTime(business.billing_expires_at);
  return { active: ends != null && ends > now, endsAt: iso(ends) };
}

/**
 * Starter / Growth monthly plans paid before prepaid services existed keep
 * working until their paid period (plus grace) runs out.
 */
function legacyPlanState(business, now = Date.now()) {
  if (!business || String(business.billing_status || '').toLowerCase() === 'trial') return { status: 'none', expiresAt: null, graceEndsAt: null, daysLeft: null };
  return periodState(business.billing_expires_at, now);
}

function usable(state) { return state.status === 'active' || state.status === 'grace'; }

function summary(business, now = Date.now()) {
  const trial = trialState(business, now);
  const hotspot = { ...periodState(business && business.hotspot_billing_expires_at, now), capacity: Number(business && business.hotspot_concurrent || 0) };
  const pppoe = { ...periodState(business && business.pppoe_billing_expires_at, now), capacity: Number(business && business.pppoe_users || 0) };
  const legacy = legacyPlanState(business, now);
  return { graceDays: GRACE_DAYS, trial, hotspot, pppoe, legacy };
}

/**
 * Returns a customer-facing reason a hotspot sale must not start, or null.
 *   activeNow: customers of this business online right now
 *   renewing:  this device already has a subscription at this location
 */
function hotspotSaleBlock(business, { activeNow = 0, renewing = false } = {}, now = Date.now()) {
  if (!business) return 'This WiFi location was not found.';
  if (String(business.billing_status || '').toLowerCase() === 'suspended') return 'This WiFi service is temporarily unavailable.';
  const s = summary(business, now);
  if (s.trial.active) return null;
  if (usable(s.hotspot)) {
    if (!renewing && s.hotspot.capacity > 0 && activeNow >= s.hotspot.capacity) {
      return 'This WiFi is full right now. Please try again in a few minutes.';
    }
    return null;
  }
  if (usable(s.legacy)) return null;
  // Operators created before billing existed have no dates at all. They keep
  // selling so a migration never switches off a live business.
  if (s.hotspot.status === 'none' && !business.billing_expires_at) return null;
  return 'This WiFi service needs its subscription renewed before it can take a new payment.';
}

/** Reason the owner cannot add or re-provision a PPPoE user, or null. */
function pppoeAddBlock(business, { activeUsers = 0, adding = true } = {}, now = Date.now()) {
  if (!business) return 'Business not found.';
  if (String(business.billing_status || '').toLowerCase() === 'suspended') return 'This workspace is suspended. Contact Wi‑Fi Fiti support.';
  const s = summary(business, now);
  if (s.trial.active) return null;
  if (!usable(s.pppoe)) {
    return s.pppoe.status === 'none'
      ? 'Subscribe to PPPoE + Static IP in Billing & payments before adding subscribers.'
      : 'Your PPPoE + Static IP subscription has ended. Renew it in Billing & payments to manage subscribers.';
  }
  if (adding && s.pppoe.capacity > 0 && activeUsers >= s.pppoe.capacity) {
    return `Your plan covers ${s.pppoe.capacity} PPPoE users. Increase it in Billing & payments to add more.`;
  }
  return null;
}

/** Routers are unlimited while hotspot capacity is paid; otherwise the plan's limit applies. */
function routerLimitLifted(business, now = Date.now()) {
  const s = summary(business, now);
  return !s.trial.active && usable(s.hotspot);
}

/**
 * Which reminders are due for one service period. The caller records each
 * key it sends so nothing is repeated.
 */
function dueReminders(kind, expiresRaw, now = Date.now()) {
  const expiresAt = parseTime(expiresRaw);
  if (expiresAt == null) return [];
  const stamp = new Date(expiresAt).toISOString().slice(0, 10);
  const due = [];
  if (now >= expiresAt - 3 * DAY_MS && now < expiresAt) due.push({ key: `${kind}:${stamp}:before`, stage: 'before' });
  if (now >= expiresAt && now < expiresAt + GRACE_DAYS * DAY_MS) due.push({ key: `${kind}:${stamp}:grace`, stage: 'grace' });
  // Only send the "sales stopped" notice within a week of it happening, so a
  // long-abandoned workspace is not messaged forever.
  if (now >= expiresAt + GRACE_DAYS * DAY_MS && now < expiresAt + (GRACE_DAYS + 7) * DAY_MS) due.push({ key: `${kind}:${stamp}:stopped`, stage: 'stopped' });
  return due;
}

function reminderText(kind, stage, expiresRaw, businessName) {
  const label = kind === 'pppoe' ? 'PPPoE + Static IP' : 'hotspot';
  const expiresAt = parseTime(expiresRaw);
  const day = (ms) => new Date(ms).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' });
  const name = businessName ? `${businessName}: ` : '';
  if (stage === 'before') return `${name}your Wi-Fi Fiti ${label} subscription ends on ${day(expiresAt)}. Renew in your dashboard (Billing & payments) to keep taking payments.`;
  if (stage === 'grace') return `${name}your Wi-Fi Fiti ${label} subscription has ended. Sales continue for ${GRACE_DAYS} grace days, until ${day(expiresAt + GRACE_DAYS * DAY_MS)}. Renew now to avoid interruption.`;
  return `${name}new ${label} sales have stopped because the subscription was not renewed. Customers already online keep their time. Renew in your dashboard to resume.`;
}

module.exports = {
  GRACE_DAYS, parseTime, periodState, summary, hotspotSaleBlock, pppoeAddBlock, routerLimitLifted, dueReminders, reminderText,
};

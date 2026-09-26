'use strict';

/**
 * Tuma's monthly fee, passed on to tenants.
 *
 * Tuma charges Wi‑Fi Fiti a flat KES 2,500 for any tenant (sub-business)
 * whose sales reach KES 100,000 in a month. Wi‑Fi Fiti charges the tenant
 * KES 3,000 for it (FEE_KES):
 *   - from KES 80,000 the tenant is reminded and can pay early;
 *   - at KES 100,000 the fee is due;
 *   - if it is still unpaid GRACE_DAYS after that, new sales pause until it
 *     is paid (customers already online keep their time).
 * Months are calendar months in Kenya time (EAT, UTC+3). Only payments that
 * settled straight to the tenant's own Tuma business ('tuma_direct') count.
 */

const FEE_KES = 3000; // Tuma's KES 2,500 plus Wi‑Fi Fiti's KES 500
const THRESHOLD_KES = 100000;
const WARN_AT_KES = 80000;
const GRACE_DAYS = 3;
const EAT_OFFSET_MS = 3 * 3600_000;
const DAY_MS = 86400_000;

/** 'YYYY-MM' for the Kenyan calendar month containing `ms`. */
function monthKey(ms) {
  return new Date(ms + EAT_OFFSET_MS).toISOString().slice(0, 7);
}

/** UTC SQL bounds [start, end) of a Kenyan calendar month. */
function monthBounds(key) {
  const [y, m] = key.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) - EAT_OFFSET_MS;
  const end = Date.UTC(y, m, 1) - EAT_OFFSET_MS;
  const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  return { start: sql(start), end: sql(end) };
}

function previousMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function parseSql(raw) {
  const text = String(raw || '');
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : null;
}

function createTumaFee({ db, now = () => Date.now() }) {
  const salesRows = db.prepare(`SELECT amount, COALESCE(updated_at, created_at) AS at FROM tenant_transactions
    WHERE business_id=? AND payment_source='tuma_direct' AND status='paid' AND created_at>=? AND created_at<?
    ORDER BY created_at, rowid`);
  const paidFor = db.prepare('SELECT amount, paid_at FROM tuma_fee_payments WHERE business_id=? AND month=?');
  const pendingFee = db.prepare(`SELECT checkout_request_id FROM business_billing_transactions
    WHERE business_id=? AND service_kind='tuma_fee' AND plan=? AND status='pending' AND created_at>datetime('now','-3 minutes')`);

  function monthState(businessId, key, at) {
    const { start, end } = monthBounds(key);
    let sales = 0; let crossedAt = null;
    for (const row of salesRows.all(businessId, start, end)) {
      sales += Number(row.amount || 0);
      if (crossedAt == null && sales >= THRESHOLD_KES) crossedAt = parseSql(row.at);
    }
    const paid = paidFor.get(businessId, key) || null;
    let stage = 'below';
    if (paid) stage = 'paid';
    else if (sales >= THRESHOLD_KES) stage = at >= (crossedAt || at) + GRACE_DAYS * DAY_MS ? 'overdue' : 'due';
    else if (sales >= WARN_AT_KES) stage = 'approaching';
    return {
      month: key, salesKes: sales, thresholdKes: THRESHOLD_KES, warnAtKes: WARN_AT_KES, feeKes: FEE_KES, graceDays: GRACE_DAYS,
      stage, paidAt: paid ? paid.paid_at : null,
      dueAt: crossedAt ? new Date(crossedAt).toISOString() : null,
      pauseAt: crossedAt && !paid ? new Date(crossedAt + GRACE_DAYS * DAY_MS).toISOString() : null,
      canPay: !paid && sales >= WARN_AT_KES,
    };
  }

  /** This month's fee state, plus last month's if it is still unpaid. */
  function state(businessId) {
    const at = now();
    const current = monthState(businessId, monthKey(at), at);
    const last = monthState(businessId, previousMonth(monthKey(at)), at);
    const outstanding = [last, current].find(s => s.stage === 'due' || s.stage === 'overdue') || null;
    return { current, previous: last.stage === 'due' || last.stage === 'overdue' ? last : null, outstanding };
  }

  /** Customer-facing reason new sales must pause, or null. */
  function salesBlock(businessId) {
    const s = state(businessId);
    return [s.previous, s.current].some(m => m && m.stage === 'overdue')
      ? 'This WiFi service is temporarily unavailable. Please try again later.'
      : null;
  }

  /** The month the tenant may pay for now (oldest unpaid first), or null. */
  function payableMonth(businessId) {
    const s = state(businessId);
    if (s.previous) return s.previous;
    return s.current.canPay ? s.current : null;
  }

  function pendingCheckout(businessId, month) {
    return pendingFee.get(businessId, `tuma-fee-${month}`) || null;
  }

  return { state, salesBlock, payableMonth, pendingCheckout, monthState };
}

module.exports = { createTumaFee, monthKey, monthBounds, FEE_KES, THRESHOLD_KES, WARN_AT_KES, GRACE_DAYS };

'use strict';

/**
 * Payout statement: the money Wi-Fi Fiti collected for a business (its own
 * M-Pesa collection 'fiti' and the platform Tuma fallback 'tuma'), the fee
 * kept, and what was paid out or is waiting for review, over a period.
 *
 * Sales are shown one line per day (a busy hotspot has thousands of
 * payments; the ledger report lists them one by one). Payout requests are
 * one line each. Amounts are in shillings with cents.
 *
 * The summary uses the same all-time sums as the Money page balance
 * (business-operations.js), so the "Available" figure always matches it.
 */

const minorToKes = (minor) => Math.round(Number(minor || 0)) / 100;
const PAYOUT_STATUS = { pending: 'Waiting for review', approved: 'Approved', paid: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled' };

function createPayoutStatement(db) {
  const hasMinorFee = db.prepare('PRAGMA table_info(tenant_transactions)').all().some((row) => row.name === 'platform_fee_minor');
  const feeSql = hasMinorFee ? 'COALESCE(platform_fee_minor, CAST(ROUND(platform_fee * 100) AS INTEGER))' : 'CAST(ROUND(platform_fee * 100) AS INTEGER)';
  // Days in Kenya time (UTC+3), so a sale at 01:00 EAT is on that day.
  const salesByDay = db.prepare(`SELECT date(created_at, '+3 hours') AS day, COUNT(*) AS payments,
      COALESCE(SUM(amount * 100),0) AS gross_minor, COALESCE(SUM(${feeSql}),0) AS fee_minor
    FROM tenant_transactions WHERE business_id=? AND payment_source IN ('fiti','tuma') AND status='paid' AND created_at >= ?
    GROUP BY day ORDER BY day`);
  const payoutsSince = db.prepare(`SELECT id, amount_minor, destination_type, destination_name, destination_account, status,
      external_reference, created_at, updated_at FROM business_payout_requests WHERE business_id=? AND created_at >= ? ORDER BY created_at, id`);
  const allTime = db.prepare(`SELECT COALESCE(SUM(amount * 100),0) AS gross_minor, COALESCE(SUM(${feeSql}),0) AS fee_minor
    FROM tenant_transactions WHERE business_id=? AND payment_source IN ('fiti','tuma') AND status='paid'`);
  const committed = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('pending','approved') THEN amount_minor ELSE 0 END),0) AS reserved_minor,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) AS paid_minor
    FROM business_payout_requests WHERE business_id=?`);

  /** Lines and totals for a business since `since` (SQL UTC time). */
  function statement(businessId, since) {
    const lines = [];
    let periodIn = 0; let periodFee = 0; let periodPaid = 0;
    for (const day of salesByDay.all(businessId, since)) {
      const net = Number(day.gross_minor) - Number(day.fee_minor);
      periodIn += net; periodFee += Number(day.fee_minor);
      lines.push({ sortKey: `${day.day} 00:00:00`, date: day.day,
        description: `Customer sales collected by Wi-Fi Fiti (${day.payments} payment${day.payments === 1 ? '' : 's'}, fee KES ${minorToKes(day.fee_minor).toLocaleString('en-KE')})`,
        moneyIn: minorToKes(net), moneyOut: null, status: 'Collected', reference: '' });
    }
    for (const payout of payoutsSince.all(businessId, since)) {
      const counts = payout.status === 'paid' || payout.status === 'pending' || payout.status === 'approved';
      if (payout.status === 'paid') periodPaid += Number(payout.amount_minor);
      const account = String(payout.destination_account || '');
      lines.push({ sortKey: String(payout.created_at), date: String(payout.created_at).slice(0, 10),
        description: `Payout to ${payout.destination_name} (${payout.destination_type === 'mpesa' ? 'M-Pesa' : 'bank'} ••${account.slice(-4)})`,
        moneyIn: null, moneyOut: counts ? minorToKes(payout.amount_minor) : null,
        status: PAYOUT_STATUS[payout.status] || payout.status, reference: payout.external_reference || '' });
    }
    lines.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const total = allTime.get(businessId); const held = committed.get(businessId);
    const earned = Number(total.gross_minor) - Number(total.fee_minor);
    return {
      lines,
      period: { collectedNet: minorToKes(periodIn), fee: minorToKes(periodFee), paidOut: minorToKes(periodPaid) },
      allTime: { earned: minorToKes(earned), paidOut: minorToKes(held.paid_minor), waiting: minorToKes(held.reserved_minor),
        available: minorToKes(Math.max(0, earned - Number(held.reserved_minor) - Number(held.paid_minor))) },
    };
  }

  /** A report spec (documents/report.js) for this statement. */
  function reportSpec({ business, since, rangeLabel, format }) {
    const data = statement(business.id, since);
    const kes = (value) => 'KES ' + Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return {
      business, title: 'Payout statement', rangeLabel, generatedAt: new Date().toISOString(),
      summary: [
        { label: 'Collected for you (this period, after fee)', value: kes(data.period.collectedNet) },
        { label: 'Paid out (this period)', value: kes(data.period.paidOut) },
        { label: 'Waiting for review', value: kes(data.allTime.waiting) },
        { label: 'Available to request now', value: kes(data.allTime.available) },
      ],
      columns: [
        { key: 'date', label: 'Date', width: format === 'pdf' ? 14 : 12 },
        { key: 'description', label: 'Description', width: format === 'pdf' ? 44 : 60 },
        { key: 'moneyIn', label: 'Money in', width: 14, align: 'right', money: true },
        { key: 'moneyOut', label: 'Money out', width: 14, align: 'right', money: true },
        { key: 'status', label: 'Status', width: format === 'pdf' ? 16 : 18 },
        { key: 'reference', label: 'Reference', width: format === 'pdf' ? 14 : 20 },
      ],
      rows: data.lines.map((line) => ({ date: line.date, description: line.description,
        moneyIn: line.moneyIn == null ? '' : line.moneyIn, moneyOut: line.moneyOut == null ? '' : line.moneyOut,
        status: line.status, reference: line.reference })),
    };
  }

  return { statement, reportSpec };
}

module.exports = { createPayoutStatement };

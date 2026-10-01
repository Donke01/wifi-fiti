'use strict';

/**
 * Payout statement: the money Wi-Fi Fiti collected for a business (its own
 * M-Pesa collection 'fiti' and the platform Tuma fallback 'tuma'), the fee
 * kept, and what was paid out or is waiting for review, over a period.
 *
 * Sales are shown one line per day (a busy hotspot has thousands of
 * payments; the transactions report lists them one by one). Payout requests
 * are one line each. Amounts are in shillings with cents.
 *
 * The balance follows the Money page (business-operations.js): earned (sales
 * less fees) minus payouts that are paid or still in review. So the statement
 * opens with the balance at the start of the period, every line moves it,
 * and it closes on the same "Available" figure the Money page shows.
 */

const minorToKes = (minor) => Math.round(Number(minor || 0)) / 100;
const PAYOUT_STATUS = { pending: 'Waiting for review', approved: 'Approved', paid: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled' };
const HOLDS = new Set(['pending', 'approved']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (day) => { const [, m, d] = String(day).slice(0, 10).split('-').map(Number); return d && m ? `${d} ${MONTHS[m - 1]}` : String(day || ''); };
const kes = (value) => 'KES ' + Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const earnedBefore = db.prepare(`SELECT COALESCE(SUM(amount * 100),0) - COALESCE(SUM(${feeSql}),0) AS minor
    FROM tenant_transactions WHERE business_id=? AND payment_source IN ('fiti','tuma') AND status='paid' AND created_at < ?`);
  const takenBefore = db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS minor FROM business_payout_requests
    WHERE business_id=? AND status IN ('paid','pending','approved') AND created_at < ?`);
  const allTime = db.prepare(`SELECT COALESCE(SUM(amount * 100),0) AS gross_minor, COALESCE(SUM(${feeSql}),0) AS fee_minor
    FROM tenant_transactions WHERE business_id=? AND payment_source IN ('fiti','tuma') AND status='paid'`);
  const committed = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('pending','approved') THEN amount_minor ELSE 0 END),0) AS reserved_minor,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) AS paid_minor
    FROM business_payout_requests WHERE business_id=?`);
  const destinations = db.prepare(`SELECT destination_type, destination_name, destination_account, MAX(created_at) AS last_at, COUNT(*) AS n
    FROM business_payout_requests WHERE business_id=? GROUP BY destination_type, destination_account ORDER BY last_at DESC LIMIT 4`);

  /** Lines and totals for a business since `since` (SQL UTC time). */
  function statement(businessId, since) {
    const lines = [];
    let periodIn = 0; let periodFee = 0; let periodPaid = 0; let periodHeld = 0; let periodGross = 0;
    for (const day of salesByDay.all(businessId, since)) {
      const gross = Number(day.gross_minor); const fee = Number(day.fee_minor);
      periodIn += gross - fee; periodFee += fee; periodGross += gross;
      lines.push({ sortKey: `${day.day} 00:00:00`, date: day.day,
        description: `Customer sales collected by Wi-Fi Fiti (${day.payments} payment${day.payments === 1 ? '' : 's'}, fee KES ${minorToKes(fee).toLocaleString('en-KE')})`,
        gross: minorToKes(gross), fee: minorToKes(fee), moneyIn: minorToKes(gross - fee), moneyOut: null, status: 'Collected', reference: '', change: gross - fee, payments: day.payments });
    }
    for (const payout of payoutsSince.all(businessId, since)) {
      const counts = payout.status === 'paid' || HOLDS.has(payout.status);
      if (payout.status === 'paid') periodPaid += Number(payout.amount_minor);
      if (HOLDS.has(payout.status)) periodHeld += Number(payout.amount_minor);
      const account = String(payout.destination_account || '');
      lines.push({ sortKey: String(payout.created_at), date: String(payout.created_at).slice(0, 10),
        description: `Payout to ${payout.destination_name} (${payout.destination_type === 'mpesa' ? 'M-Pesa' : 'bank'} ••${account.slice(-4)})`,
        gross: null, fee: null, moneyIn: null, moneyOut: counts ? minorToKes(payout.amount_minor) : null,
        status: PAYOUT_STATUS[payout.status] || payout.status, reference: payout.external_reference || '', change: counts ? -Number(payout.amount_minor) : 0 });
    }
    lines.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const opening = Number(earnedBefore.get(businessId, since).minor) - Number(takenBefore.get(businessId, since).minor);
    let running = opening;
    for (const line of lines) { running += line.change; line.balance = minorToKes(running); }
    const total = allTime.get(businessId); const held = committed.get(businessId);
    const earned = Number(total.gross_minor) - Number(total.fee_minor);
    return {
      lines,
      period: { collectedNet: minorToKes(periodIn), fee: minorToKes(periodFee), paidOut: minorToKes(periodPaid),
        gross: minorToKes(periodGross), held: minorToKes(periodHeld), opening: minorToKes(opening), closing: minorToKes(running) },
      allTime: { earned: minorToKes(earned), paidOut: minorToKes(held.paid_minor), waiting: minorToKes(held.reserved_minor),
        available: minorToKes(Math.max(0, earned - Number(held.reserved_minor) - Number(held.paid_minor))) },
    };
  }

  /** A report spec (documents/report.js) for this statement. */
  function reportSpec({ business, since, rangeLabel, generatedBy }) {
    const data = statement(business.id, since);
    const p = data.period;
    const feeShare = p.gross ? Math.round((p.fee / p.gross) * 1000) / 10 : 0;
    const accounts = destinations.all(business.id).map((row, i) => ({
      label: `${row.destination_type === 'mpesa' ? 'M-Pesa' : 'Bank'} ending ${String(row.destination_account || '').slice(-4)}, ${row.destination_name}`,
      note: `${row.n} payout${row.n === 1 ? '' : 's'}, last on ${dayText(row.last_at)}`, tag: i === 0 ? 'Last used' : '' }));
    return {
      business, title: 'Payout statement', rangeLabel, generatedAt: new Date().toISOString(), generatedBy, cents: true, orientation: 'landscape',
      filters: ['Money Wi-Fi Fiti collected for you', p.gross ? `Fees: ${feeShare}% of sales` : 'No fees this period', `${data.lines.length} line${data.lines.length === 1 ? '' : 's'}`],
      balance: [
        { label: 'Opening balance', value: kes(p.opening) },
        { label: 'Sales collected', value: kes(p.gross), op: '+' },
        { label: 'Fees', value: kes(p.fee), op: '−' },
        { label: 'Paid out', value: kes(p.paidOut), op: '−' },
        { label: 'In review', value: kes(p.held), op: '−' },
        { label: 'Available now', value: kes(p.closing), op: '=' },
      ],
      columns: [
        { key: 'date', label: 'Date', width: 7 },
        { key: 'description', label: 'What happened', width: 34 },
        { key: 'reference', label: 'Reference', width: 11, muted: true },
        { key: 'status', label: 'Status', width: 13, status: true },
        { key: 'gross', label: 'In', width: 11, align: 'right', money: true },
        { key: 'fee', label: 'Fee', width: 9, align: 'right', money: true },
        { key: 'moneyOut', label: 'Out', width: 11, align: 'right', money: true },
        { key: 'balance', label: 'Balance', width: 12, align: 'right', money: true },
      ],
      rows: [
        { date: dayText(new Date(new Date(String(since).replace(' ', 'T') + 'Z').getTime() + 3 * 3600_000).toISOString()), description: 'Opening balance', reference: '', status: 'Opening', gross: '', fee: '', moneyOut: '', balance: p.opening },
        ...data.lines.map((line) => ({ date: dayText(line.date), description: line.payments ? `Sales collected, ${line.payments} payment${line.payments === 1 ? '' : 's'}` : line.description,
          reference: line.reference || '', status: line.status, gross: line.gross == null ? '' : line.gross, fee: line.fee == null ? '' : line.fee,
          moneyOut: line.moneyOut == null ? '' : line.moneyOut, balance: line.balance })),
      ],
      totals: { date: 'Totals', gross: p.gross, fee: p.fee, moneyOut: Math.round((p.paidOut + p.held) * 100) / 100, balance: p.closing },
      lists: [
        { title: 'Where payouts went', items: accounts },
        { title: 'Good to know', items: [
          'In review is money in payout requests not yet sent. It stays out of Available until rejected or cancelled.',
          'Rejected and cancelled payouts are listed but take nothing from the balance.',
          'Sales paid to your own Till or PayBill go straight to you and are not on this statement.',
          'Available now matches the Money page. Days are Kenya time.'] },
      ],
    };
  }

  return { statement, reportSpec };
}

module.exports = { createPayoutStatement };

'use strict';

/**
 * Tenant Dashboard read model. Analytics are computed here, outside payment
 * and router-control paths, so reports cannot change provisioning state.
 */
function attachTenantDashboardRoutes(app, { businessAuth, db }) {
  const tableExists = name => Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`
  ).get(name));
  const number = value => Number(value || 0);
  const sqlDate = ms => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

  app.get('/api/business/tenant-dashboard', (req, res) => {
    const business = businessAuth(req, res);
    if (!business) return;
    const businessId = business.id;
    const period = ['7d', '30d', '90d'].includes(String(req.query.period)) ? String(req.query.period) : '30d';
    const days = Number(period.slice(0, -1));
    const since = sqlDate(Date.now() - days * 86400_000);
    const locations = db.prepare(`
      SELECT l.id, l.name, l.router_name, l.router_status, l.router_model,
             l.last_seen_at, l.last_successful_sync_at, l.portal_setup_completed_at,
             (SELECT d.hostname FROM tenant_portal_domains d
                WHERE d.location_id=l.id AND d.status='active' AND d.is_primary=1
                ORDER BY d.created_at DESC LIMIT 1) AS portal_hostname
        FROM locations l WHERE l.business_id=? ORDER BY l.created_at DESC
    `).all(businessId);
    const requestedLocation = String(req.query.locationId || '').trim();
    const selectedLocation = requestedLocation ? locations.find(location => String(location.id) === requestedLocation) : null;
    if (requestedLocation && !selectedLocation) return res.status(400).json({ error: 'That location is not part of this workspace.' });
    const locationIds = selectedLocation ? [selectedLocation.id] : locations.map(location => location.id);
    const placeholders = locationIds.map(() => '?').join(',') || "''";
    const sales = db.prepare(`
      SELECT COUNT(*) AS payments, COALESCE(SUM(amount),0) AS gross
        FROM tenant_transactions
       WHERE business_id=? AND status='paid' AND created_at>=?
         AND location_id IN (${placeholders})
    `).get(businessId, since, ...locationIds);
    const transactionRows = db.prepare(`
      SELECT t.checkout_request_id, t.location_id, l.name AS location_name, t.phone,
             t.mac, t.package_name, t.amount, t.status, t.payment_source,
             t.mpesa_receipt, t.result_desc, t.created_at, t.updated_at
        FROM tenant_transactions t JOIN locations l ON l.id=t.location_id
       WHERE t.business_id=? AND t.created_at>=? AND t.location_id IN (${placeholders})
       ORDER BY t.created_at DESC LIMIT 2000
    `).all(businessId, since, ...locationIds);
    const activeSubscriptions = db.prepare(`
      SELECT COUNT(*) AS count FROM tenant_subscriptions
       WHERE business_id=? AND is_active=1 AND expires_at>datetime('now')
         AND location_id IN (${placeholders})
    `).get(businessId, ...locationIds);
    const deviceStats = db.prepare(`
      SELECT COUNT(DISTINCT mac) AS devices, COALESCE(SUM(used_seconds),0) AS used_seconds
        FROM tenant_subscriptions
       WHERE business_id=? AND location_id IN (${placeholders})
         AND (created_at>=? OR is_active=1 OR expires_at>=datetime('now'))
    `).get(businessId, ...locationIds, since);
    const packages = db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN active=1 THEN 1 ELSE 0 END),0) AS active
        FROM business_packages WHERE business_id=?
    `).get(businessId);
    let pppoe = { subscribers: 0, active: 0 };
    if (tableExists('pppoe_users')) pppoe = db.prepare(`
      SELECT COUNT(*) AS subscribers,
             COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active
        FROM pppoe_users WHERE business_id=?
    `).get(businessId);
    let sms = { credits: 0, sent: 0, reserved: 0 };
    if (tableExists('fiti_signal_accounts')) sms = db.prepare(`
      SELECT credits_available AS credits, credits_used AS sent, credits_reserved AS reserved
        FROM fiti_signal_accounts WHERE business_id=?
    `).get(businessId) || sms;

    // Telemetry is optional for older routers. Counter resets/reboots are
    // treated as a new window and never produce negative traffic.
    const telemetryColumns = tableExists('tenant_router_telemetry')
      ? new Set(db.prepare('PRAGMA table_info(tenant_router_telemetry)').all().map(column => column.name))
      : new Set();
    const telemetryField = name => telemetryColumns.has(name) ? name : `NULL AS ${name}`;
    const telemetryRows = telemetryColumns.size && locationIds.length
      ? db.prepare(`SELECT ${['location_id', 'cpu_percent', 'free_memory', 'total_memory', 'uptime_seconds', 'uptime_text', 'rx_bytes', 'tx_bytes', 'active_users', 'recorded_at'].map(telemetryField).join(',')}
                      FROM tenant_router_telemetry
                     WHERE location_id IN (${placeholders}) AND recorded_at>=?
                     ORDER BY recorded_at ASC LIMIT 10000`).all(...locationIds, since)
      : [];
    const telemetryByLocation = new Map();
    telemetryRows.forEach(row => {
      if (!telemetryByLocation.has(row.location_id)) telemetryByLocation.set(row.location_id, []);
      telemetryByLocation.get(row.location_id).push(row);
    });
    let dataBytes = 0; let downloadBytes = 0; let uploadBytes = 0; let activeUsersPeak = 0;
    telemetryByLocation.forEach(rows => {
      let previous = null;
      rows.forEach(row => {
        activeUsersPeak = Math.max(activeUsersPeak, number(row.active_users));
        if (previous) {
          const rx = Math.max(0, number(row.rx_bytes) - number(previous.rx_bytes));
          const tx = Math.max(0, number(row.tx_bytes) - number(previous.tx_bytes));
          downloadBytes += rx; uploadBytes += tx; dataBytes += rx + tx;
        }
        previous = row;
      });
    });
    const bucketMs = days <= 7 ? 3600_000 : 86400_000;
    const buckets = new Map();
    const bucketFor = value => {
      const raw = String(value || '');
      const time = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z').getTime();
      const stamp = Number.isFinite(time) ? new Date(Math.floor(time / bucketMs) * bucketMs).toISOString() : raw;
      if (!buckets.has(stamp)) buckets.set(stamp, { at: stamp, dataBytes: 0, downloadBytes: 0, uploadBytes: 0, activeUsers: 0, sessions: 0, revenueKes: 0 });
      return buckets.get(stamp);
    };
    transactionRows.filter(row => row.status === 'paid').forEach(row => {
      const bucket = bucketFor(row.created_at); bucket.sessions += 1; bucket.revenueKes += number(row.amount);
    });
    telemetryByLocation.forEach(rows => {
      let previous = null;
      rows.forEach(row => {
        const bucket = bucketFor(row.recorded_at); bucket.activeUsers = Math.max(bucket.activeUsers, number(row.active_users));
        if (previous) {
          const rx = Math.max(0, number(row.rx_bytes) - number(previous.rx_bytes));
          const tx = Math.max(0, number(row.tx_bytes) - number(previous.tx_bytes));
          bucket.downloadBytes += rx; bucket.uploadBytes += tx; bucket.dataBytes += rx + tx;
        }
        previous = row;
      });
    });
    const sessionCount = number(sales.payments);
    const usedSeconds = number(deviceStats.used_seconds);
    const averageSessionSeconds = sessionCount ? Math.round(usedSeconds / sessionCount) : 0;
    res.set('Cache-Control', 'no-store').json({
      module: { codename: 'tenant-dashboard', version: 2 }, period,
      locationId: selectedLocation ? selectedLocation.id : null,
      summary: {
        locations: locations.length,
        onlineLocations: locations.filter(item => item.last_successful_sync_at && item.router_status !== 'offboarding').length,
        activeSubscriptions: number(activeSubscriptions.count), payments: sessionCount, sessions: sessionCount,
        customers: number(deviceStats.devices), grossKes: number(sales.gross), packages: number(packages.active),
        dataBytes, downloadBytes, uploadBytes, activeUsersPeak, sessionSeconds: usedSeconds, averageSessionSeconds,
        pppoeSubscribers: number(pppoe.subscribers), activePppoeSubscribers: number(pppoe.active),
        smsCredits: number(sms.credits), smsSent: number(sms.sent), smsReserved: number(sms.reserved),
      },
      locations,
      series: Array.from(buckets.values()).sort((a, b) => String(a.at).localeCompare(String(b.at))),
      report: transactionRows,
      reportMeta: { sessionBasis: 'confirmed paid package sessions', usageBasis: 'router RX/TX counter deltas', generatedAt: new Date().toISOString() },
    });
  });
}

module.exports = { attachTenantDashboardRoutes };

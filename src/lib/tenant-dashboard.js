'use strict';

/**
 * Tenant Dashboard module (codename: tenant-dashboard).
 *
 * This is the read-model boundary for the tenant workspace.  It deliberately
 * lives outside business.html and outside the payment/router control planes so
 * the dashboard can be rebuilt screen by screen without changing provisioning,
 * captive-portal, PPPoE, or onboarding behavior.
 */

function attachTenantDashboardRoutes(app, { businessAuth, db }) {
  const tableExists = name => Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`
  ).get(name));

  const number = value => Number(value || 0);

  app.get('/api/business/tenant-dashboard', (req, res) => {
    const business = businessAuth(req, res);
    if (!business) return;
    const businessId = business.id;
    const period = ['7d', '30d', '90d'].includes(String(req.query.period)) ? String(req.query.period) : '30d';
    const days = Number(period.slice(0, -1));
    const since = new Date(Date.now() - days * 86400_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

    const locations = db.prepare(`
      SELECT l.id, l.name, l.router_name, l.router_status, l.router_model,
             l.last_seen_at, l.last_successful_sync_at, l.portal_setup_completed_at,
             (SELECT d.hostname FROM tenant_portal_domains d
                WHERE d.location_id=l.id AND d.status='active' AND d.is_primary=1
                ORDER BY d.created_at DESC LIMIT 1) AS portal_hostname
        FROM locations l WHERE l.business_id=? ORDER BY l.created_at DESC
    `).all(businessId);
    const sales = db.prepare(`
      SELECT COUNT(*) AS payments, COALESCE(SUM(amount),0) AS gross,
             COUNT(DISTINCT phone) AS customers
        FROM tenant_transactions
       WHERE business_id=? AND status='paid' AND created_at>=?
    `).get(businessId, since);
    const activeSubscriptions = db.prepare(`
      SELECT COUNT(*) AS count FROM tenant_subscriptions
       WHERE business_id=? AND is_active=1 AND expires_at>datetime('now')
    `).get(businessId);
    const packages = db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN active=1 THEN 1 ELSE 0 END),0) AS active
        FROM business_packages WHERE business_id=?
    `).get(businessId);

    let pppoe = { subscribers: 0, active: 0 };
    if (tableExists('pppoe_users')) {
      pppoe = db.prepare(`
        SELECT COUNT(*) AS subscribers,
               COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active
          FROM pppoe_users WHERE business_id=?
      `).get(businessId);
    }

    let sms = { credits: 0, sent: 0, reserved: 0 };
    if (tableExists('fiti_signal_accounts')) {
      sms = db.prepare(`
        SELECT credits_available AS credits, credits_used AS sent,
               credits_reserved AS reserved
          FROM fiti_signal_accounts WHERE business_id=?
      `).get(businessId) || sms;
    }

    res.set('Cache-Control', 'no-store').json({
      module: { codename: 'tenant-dashboard', version: 1 },
      period,
      summary: {
        locations: locations.length,
        onlineLocations: locations.filter(item => item.last_successful_sync_at && item.router_status !== 'offboarding').length,
        activeSubscriptions: number(activeSubscriptions.count),
        payments: number(sales.payments),
        customers: number(sales.customers),
        grossKes: number(sales.gross),
        packages: number(packages.active),
        pppoeSubscribers: number(pppoe.subscribers),
        activePppoeSubscribers: number(pppoe.active),
        smsCredits: number(sms.credits),
        smsSent: number(sms.sent),
        smsReserved: number(sms.reserved),
      },
      locations,
    });
  });
}

module.exports = { attachTenantDashboardRoutes };

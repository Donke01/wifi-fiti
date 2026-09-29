'use strict';

const { buildReportXlsx, buildReportPdf } = require('./documents/report');
const { formatKes } = require('./documents/brand');

// Read-only platform control-plane data. Mutating router/payment operations
// remain behind their existing, purpose-specific admin endpoints.
function attachPlatformAdmin(app, { db, adminOk }) {
  db = db.db || db;
  const guard = handler => (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Platform administrator access is required.' });
    try { res.set('Cache-Control', 'no-store'); return handler(req, res); }
    catch (error) { console.error('[platform admin]', error.message); return res.status(500).json({ error: 'Could not load platform records.' }); }
  };
  app.get('/api/admin/platform/overview', guard((req, res) => {
    const summary = {
      tenants: db.prepare('SELECT COUNT(*) AS n FROM businesses').get().n,
      locations: db.prepare('SELECT COUNT(*) AS n FROM locations').get().n,
      onlineLocations: db.prepare("SELECT COUNT(*) AS n FROM locations WHERE last_router_contact_at >= datetime('now','-2 minutes')").get().n,
      paidTransactions: db.prepare("SELECT COUNT(*) AS n FROM tenant_transactions WHERE status='paid'").get().n,
      pendingTransactions: db.prepare("SELECT COUNT(*) AS n FROM tenant_transactions WHERE status='pending'").get().n,
      activeSubscriptions: db.prepare("SELECT COUNT(*) AS n FROM tenant_subscriptions WHERE expires_at > datetime('now')").get().n,
      openTickets: db.prepare("SELECT COUNT(*) AS n FROM business_support_tickets WHERE status != 'resolved'").get().n,
      revenueKes: db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM tenant_transactions WHERE status='paid'").get().n,
    };
    res.json({ summary, generatedAt: new Date().toISOString() });
  }));
  app.get('/api/admin/platform/tenants', guard((req, res) => {
    res.json({ tenants: db.prepare(`SELECT b.id,b.name,b.email,b.owner_phone,b.plan,b.onboarding_state,b.billing_status,b.billing_expires_at,b.portal_name,b.support_phone,b.brand_primary_color,b.created_at,
      (SELECT COUNT(*) FROM locations l WHERE l.business_id=b.id) AS locations,
      (SELECT COUNT(*) FROM tenant_transactions t WHERE t.business_id=b.id AND t.status='paid') AS paid_transactions,
      (SELECT COALESCE(SUM(t.amount),0) FROM tenant_transactions t WHERE t.business_id=b.id AND t.status='paid') AS revenue_kes
      FROM businesses b ORDER BY b.created_at DESC`).all() });
  }));
  app.get('/api/admin/platform/locations', guard((req, res) => {
    res.json({ locations: db.prepare(`SELECT l.id,l.business_id,b.name AS business_name,l.name,l.router_name,l.router_model,
      l.routeros_version,l.hotspot_server,l.setup_mode,l.last_router_contact_at,l.router_setup_health,
      CASE WHEN l.last_router_contact_at >= datetime('now','-2 minutes') THEN 'online' ELSE 'offline' END AS status
      FROM locations l JOIN businesses b ON b.id=l.business_id ORDER BY l.last_router_contact_at DESC`).all() });
  }));
  app.get('/api/admin/platform/transactions', guard((req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    res.json({ transactions: db.prepare(`SELECT t.checkout_request_id,t.business_id,b.name AS business_name,t.location_id,
      t.phone,t.package_name,t.amount,t.status,t.mpesa_receipt,t.provisioned,t.created_at,t.updated_at
      FROM tenant_transactions t JOIN businesses b ON b.id=t.business_id ORDER BY t.created_at DESC LIMIT ?`).all(limit) });
  }));
  // A branded, printable platform-wide report (.xlsx or .pdf): every
  // tenant, its main location, paid transactions and revenue - the numbers
  // above, handed to whoever needs a file rather than a dashboard.
  app.get('/api/admin/platform/report', guard((req, res) => {
    const format = String(req.query.format || 'xlsx') === 'pdf' ? 'pdf' : 'xlsx';
    const rows = db.prepare(`SELECT b.name AS tenant, b.plan AS plan,
        (SELECT l.name FROM locations l WHERE l.business_id=b.id ORDER BY l.created_at ASC LIMIT 1) AS location,
        (SELECT COUNT(*) FROM tenant_transactions t WHERE t.business_id=b.id AND t.status='paid') AS transactions,
        (SELECT COALESCE(SUM(t.amount),0) FROM tenant_transactions t WHERE t.business_id=b.id AND t.status='paid') AS amount
      FROM businesses b ORDER BY amount DESC`).all();
    const totals = db.prepare(`SELECT COUNT(*) AS tenants,
        (SELECT COUNT(*) FROM tenant_transactions WHERE status='paid') AS transactions,
        (SELECT COALESCE(SUM(amount),0) FROM tenant_transactions WHERE status='paid') AS revenue
      FROM businesses`).get();
    const spec = {
      business: null, title: 'Platform report', rangeLabel: 'All time', generatedAt: new Date().toISOString(),
      summary: [
        { label: 'Tenants', value: String(totals.tenants || 0) },
        { label: 'Total collected', value: formatKes(totals.revenue || 0) },
        { label: 'Transactions', value: String(totals.transactions || 0) },
      ],
      columns: [
        { key: 'tenant', label: 'Tenant', width: 26 },
        { key: 'location', label: 'Location', width: 18 },
        { key: 'transactions', label: 'Transactions', width: 14, align: 'right' },
        { key: 'amount', label: 'Revenue', width: 16, align: 'right', money: true },
        { key: 'plan', label: 'Plan', width: 12 },
      ],
      rows: rows.map((row) => ({ tenant: row.tenant, location: row.location || '—', transactions: Number(row.transactions || 0), amount: Number(row.amount || 0), plan: row.plan || 'Starter' })),
    };
    const build = format === 'pdf' ? buildReportPdf : buildReportXlsx;
    build(spec).then((buffer) => {
      res.set('Content-Disposition', `attachment; filename="platform-report.${format}"`);
      res.type(format).send(buffer);
    }).catch((error) => { console.error('[platform report]', error.message); res.status(500).json({ error: 'Could not build the platform report right now.' }); });
  }));
}

module.exports = { attachPlatformAdmin };

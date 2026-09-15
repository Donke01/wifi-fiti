'use strict';

/* Single-administrator platform controls. Kept separate from portal/router
 * handlers; each mutation is explicit, audited, and confirmation-protected. */
function attachAdminControlPlane(app, { db: suppliedDb, adminOk, tenant, confirmationPhrase } = {}) {
  const db = suppliedDb.db || suppliedDb;
  const phrase = String(confirmationPhrase || process.env.ADMIN_CONFIRMATION_PHRASE || 'CONFIRM');
  db.exec(`CREATE TABLE IF NOT EXISTS platform_admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, business_id TEXT,
    reference TEXT, actor TEXT NOT NULL, details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const guard = handler => (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Platform administrator access is required.' });
    try { res.set('Cache-Control', 'no-store'); return handler(req, res); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  };
  const confirm = req => {
    const supplied = String(req.body?.confirmation || req.headers['x-confirmation-phrase'] || '');
    if (supplied !== phrase) { const e = new Error('Confirmation phrase is required.'); e.status = 400; throw e; }
  };
  const audit = (req, action, businessId, reference, details = {}) => db.prepare(
    `INSERT INTO platform_admin_audit(action,business_id,reference,actor,details_json) VALUES(?,?,?,?,?)`
  ).run(action, businessId || null, reference || null, String(req.ip || 'platform-admin'), JSON.stringify(details));
  const tenantRow = id => db.prepare('SELECT id,name,email,plan,collection_mode,billing_status,billing_expires_at FROM businesses WHERE id=?').get(id);
  const requireTenant = id => { const row = tenantRow(id); if (!row) { const e = new Error('Tenant was not found.'); e.status = 404; throw e; } return row; };

  app.get('/api/admin/control-plane/tenants', guard((req, res) => res.json({ tenants: db.prepare(`
    SELECT b.id,b.name,b.email,b.plan,b.collection_mode,b.billing_status,b.billing_expires_at,b.created_at,
      (SELECT COUNT(*) FROM locations l WHERE l.business_id=b.id) locations
    FROM businesses b ORDER BY b.created_at DESC`).all() })));

  app.patch('/api/admin/control-plane/tenants/:businessId/billing', guard((req, res) => {
    const b = requireTenant(req.params.businessId); confirm(req);
    const plan = String(req.body?.plan ?? b.plan).trim();
    const collectionMode = String(req.body?.collectionMode ?? b.collection_mode).trim();
    const status = String(req.body?.billingStatus ?? b.billing_status).trim();
    if (!/^[a-z0-9_-]{1,40}$/i.test(plan) || !/^[a-z0-9_-]{1,40}$/i.test(collectionMode) || !/^[a-z0-9_-]{1,40}$/i.test(status)) throw new Error('Invalid billing values.');
    const expires = req.body?.billingExpiresAt === null ? null : (req.body?.billingExpiresAt || b.billing_expires_at);
    db.prepare(`UPDATE businesses SET plan=?,collection_mode=?,billing_status=?,billing_expires_at=? WHERE id=?`).run(plan, collectionMode, status, expires, b.id);
    audit(req, 'tenant_billing_change', b.id, null, { plan, collectionMode, status, expires });
    res.json({ tenant: tenantRow(b.id) });
  }));

  app.post('/api/admin/control-plane/tenants/:businessId/revoke-sessions', guard((req, res) => {
    const b = requireTenant(req.params.businessId); confirm(req);
    const result = db.prepare('DELETE FROM business_sessions WHERE business_id=?').run(b.id);
    audit(req, 'tenant_sessions_revoked', b.id, null, { count: result.changes });
    res.json({ revoked: result.changes });
  }));

  // Safe device override hook: uses the tenant runtime's existing guarded
  // statement, never alters router credentials or bypasses package expiry.
  app.post('/api/admin/control-plane/subscriptions/:subscriptionId/device', guard((req, res) => {
    confirm(req);
    const row = db.prepare('SELECT id,business_id,location_id,mac FROM tenant_subscriptions WHERE id=?').get(req.params.subscriptionId);
    if (!row) { const e = new Error('Subscription was not found.'); e.status = 404; throw e; }
    const mac = String(req.body?.mac || '').trim().toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) throw new Error('A valid MAC address is required.');
    const occupant = db.prepare('SELECT id FROM tenant_subscriptions WHERE location_id=? AND mac=? AND id<>?').get(row.location_id, mac, row.id);
    if (occupant) { const e = new Error('That device is already assigned.'); e.status = 409; throw e; }
    if (tenant?.setSubscriptionMac?.run) tenant.setSubscriptionMac.run({ id: row.id, locationId: row.location_id, mac });
    else db.prepare('UPDATE tenant_subscriptions SET mac=?,updated_at=datetime(\'now\') WHERE id=?').run(mac, row.id);
    audit(req, 'subscription_device_override', row.business_id, row.id, { mac });
    res.json({ subscription: db.prepare('SELECT id,business_id,location_id,mac,expires_at,is_active FROM tenant_subscriptions WHERE id=?').get(row.id) });
  }));

  app.get('/api/admin/control-plane/audit', guard((req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
    res.json({ events: db.prepare('SELECT * FROM platform_admin_audit ORDER BY id DESC LIMIT ?').all(limit) });
  }));
  app.get('/api/admin/control-plane/audit.csv', guard((req, res) => {
    const rows = db.prepare('SELECT * FROM platform_admin_audit ORDER BY id DESC LIMIT 5000').all();
    const csv = ['id,action,business_id,reference,actor,details_json,created_at', ...rows.map(row => [row.id,row.action,row.business_id,row.reference,row.actor,row.details_json,row.created_at].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="wifi-fiti-admin-audit.csv"').send(csv);
  }));
}

module.exports = { attachAdminControlPlane };

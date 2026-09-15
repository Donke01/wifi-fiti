'use strict';

/**
 * FitiSignal's single-administrator control plane.  This is intentionally a
 * separate attachment from router and captive-portal administration.
 */
function attachFitiSignalAdminControls(app, { db: suppliedDb, adminOk, confirmationPhrase } = {}) {
  const db = suppliedDb.db || suppliedDb;
  const phrase = String(confirmationPhrase || process.env.ADMIN_CONFIRMATION_PHRASE || 'CONFIRM');
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiti_signal_tenant_controls (
      business_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active',
      reason TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(status IN ('active','suspended','deleted'))
    );
    CREATE TABLE IF NOT EXISTS fiti_signal_admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
      business_id TEXT, reference TEXT, actor TEXT NOT NULL,
      details_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fiti_signal_provider_controls (
      id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const guard = handler => (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Platform administrator access is required.' });
    try { res.set('Cache-Control', 'no-store'); return handler(req, res); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  };
  const requireConfirmation = req => {
    const supplied = String(req.body?.confirmation || req.body?.confirmationPhrase || req.headers['x-confirmation-phrase'] || '');
    if (supplied !== phrase) { const e = new Error('Confirmation phrase is required.'); e.status = 400; throw e; }
  };
  const audit = (req, action, businessId, reference, details = {}) => db.prepare(
    `INSERT INTO fiti_signal_admin_audit(action,business_id,reference,actor,details_json) VALUES(?,?,?,?,?)`
  ).run(action, businessId || null, reference || null, String(req.ip || 'platform-admin'), JSON.stringify(details));
  const business = id => db.prepare('SELECT id,name,email FROM businesses WHERE id=?').get(id);
  const ensureBusiness = id => { const row = business(id); if (!row) { const e = new Error('Tenant was not found.'); e.status = 404; throw e; } return row; };

  app.get('/api/admin/fiti-signal/control/tenants', guard((req, res) => res.json({ tenants: db.prepare(`
    SELECT b.id,b.name,b.email,b.created_at,COALESCE(c.status,'active') status,c.reason,c.updated_at,
      COALESCE(a.credits_available,0) sms_credits
    FROM businesses b LEFT JOIN fiti_signal_tenant_controls c ON c.business_id=b.id
    LEFT JOIN fiti_signal_accounts a ON a.business_id=b.id ORDER BY b.created_at DESC`).all() })));

  app.post('/api/admin/fiti-signal/control/tenants/:businessId/lifecycle/:action', guard((req, res) => {
    const b = ensureBusiness(req.params.businessId); const action = req.params.action;
    if (!['suspend', 'restore', 'delete'].includes(action)) { const e = new Error('Unknown tenant action.'); e.status = 404; throw e; }
    requireConfirmation(req);
    const status = action === 'suspend' ? 'suspended' : action === 'delete' ? 'deleted' : 'active';
    db.prepare(`INSERT INTO fiti_signal_tenant_controls(business_id,status,reason) VALUES(?,?,?)
      ON CONFLICT(business_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=datetime('now')`)
      .run(b.id, status, String(req.body?.reason || '').slice(0, 300) || null);
    audit(req, `tenant_${action}`, b.id, null, { status });
    res.json({ tenant: { ...b, status }, message: `Tenant ${action}d.` });
  }));

  app.get('/api/admin/fiti-signal/control/payments', guard((req, res) => res.json({ payments: db.prepare(`
    SELECT t.checkout_request_id,t.business_id,b.name business_name,t.location_id,t.phone,t.package_name,
      t.amount,t.status,t.mpesa_receipt,t.provisioned,t.created_at,t.updated_at
    FROM tenant_transactions t JOIN businesses b ON b.id=t.business_id ORDER BY t.created_at DESC LIMIT 500`).all() })));

  app.post('/api/admin/fiti-signal/control/payments/:checkoutRequestId/refund', guard((req, res) => {
    requireConfirmation(req);
    const id = req.params.checkoutRequestId;
    const row = db.prepare('SELECT * FROM tenant_transactions WHERE checkout_request_id=?').get(id);
    if (!row) { const e = new Error('Payment was not found.'); e.status = 404; throw e; }
    if (!['paid', 'provisioned'].includes(row.status) && row.status !== 'refunded') { const e = new Error('Only a settled payment can be refunded.'); e.status = 409; throw e; }
    if (row.status === 'refunded') return res.json({ payment: row, duplicate: true });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE tenant_transactions SET status='refunded',result_desc=?,updated_at=datetime('now') WHERE checkout_request_id=?`).run(String(req.body?.reason || 'Refunded by administrator').slice(0, 500), id);
      if (row.subscription_id) db.prepare(`UPDATE tenant_subscriptions SET is_active=0,expires_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(row.subscription_id);
      audit(req, 'payment_refund', row.business_id, id, { amount: row.amount, receipt: row.mpesa_receipt });
      const payment = db.prepare('SELECT * FROM tenant_transactions WHERE checkout_request_id=?').get(id);
      db.exec('COMMIT'); res.json({ payment });
    } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }));

  app.post('/api/admin/fiti-signal/control/tenants/:businessId/credits', guard((req, res) => {
    requireConfirmation(req); const b = ensureBusiness(req.params.businessId);
    const delta = Number(req.body?.delta); if (!Number.isSafeInteger(delta) || delta === 0) throw new Error('Credit adjustment must be a non-zero whole number.');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO fiti_signal_accounts(business_id) VALUES(?)').run(b.id);
      const account = db.prepare('SELECT * FROM fiti_signal_accounts WHERE business_id=?').get(b.id);
      if (delta < 0 && account.credits_available < Math.abs(delta)) { const e = new Error('Adjustment exceeds available credits.'); e.status = 409; throw e; }
      db.prepare(`UPDATE fiti_signal_accounts SET credits_available=credits_available+?,updated_at=datetime('now') WHERE business_id=?`).run(delta, b.id);
      db.prepare(`INSERT INTO fiti_signal_ledger(business_id,delta,kind,reference,metadata_json) VALUES(?,?,?, ?,?)`).run(b.id, delta, 'admin_adjustment', null, JSON.stringify({ reason: String(req.body?.reason || '').slice(0, 300) }));
      audit(req, 'sms_credit_adjustment', b.id, null, { delta });
      const updated = db.prepare('SELECT * FROM fiti_signal_accounts WHERE business_id=?').get(b.id); db.exec('COMMIT'); res.json({ account: updated });
    } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }));

  app.post('/api/admin/fiti-signal/control/provider/:action', guard((req, res) => {
    if (!['pause', 'resume'].includes(req.params.action)) { const e = new Error('Unknown provider action.'); e.status = 404; throw e; }
    requireConfirmation(req);
    db.prepare(`INSERT INTO fiti_signal_provider_controls(id,paused) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET paused=excluded.paused,updated_at=datetime('now')`).run(req.params.action === 'pause' ? 1 : 0);
    audit(req, `provider_${req.params.action}`, null, null);
    res.json({ providerPaused: req.params.action === 'pause' });
  }));

  app.get('/api/admin/fiti-signal/control/audit', guard((req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ events: db.prepare('SELECT * FROM fiti_signal_admin_audit ORDER BY id DESC LIMIT ?').all(limit) });
  }));
}

module.exports = { attachFitiSignalAdminControls };

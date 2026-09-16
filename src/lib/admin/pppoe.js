'use strict';

function attachPppoeAdmin(app, { db: suppliedDb, adminOk, confirmationPhrase } = {}) {
  const db = suppliedDb.db || suppliedDb;
  const phrase = String(confirmationPhrase || process.env.ADMIN_CONFIRMATION_PHRASE || 'CONFIRM');
  const guard = handler => (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Platform administrator access is required.' });
    try { res.set('Cache-Control', 'no-store'); return handler(req, res); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  };
  const confirm = req => {
    const password = String(req.body?.adminPassword || req.headers['x-admin-password'] || '');
    if (process.env.ADMIN_PASSWORD && password === String(process.env.ADMIN_PASSWORD)) return;
    if (!process.env.ADMIN_PASSWORD && String(req.body?.confirmation || '') === phrase) return;
    const e = new Error(process.env.ADMIN_PASSWORD ? 'Administrator password is required.' : 'Confirmation phrase is required.'); e.status = 400; throw e;
  };
  app.get('/api/admin/pppoe/profiles', guard((req, res) => res.json({ profiles: db.prepare(`SELECT p.*,COUNT(u.id) subscriber_count FROM pppoe_profiles p LEFT JOIN pppoe_users u ON u.profile_id=p.id GROUP BY p.id ORDER BY p.name`).all() })));
  app.get('/api/admin/pppoe/subscribers', guard((req, res) => res.json({ subscribers: db.prepare(`SELECT u.id,u.business_id,u.location_id,u.username,u.service_name,u.status,u.created_at,u.updated_at,p.name profile_name,(p.download_rate||'')||'/'||(p.upload_rate||'') rate_limit,COALESCE(h.status,'unknown') connection_status FROM pppoe_users u JOIN pppoe_profiles p ON p.id=u.profile_id LEFT JOIN pppoe_health h ON h.business_id=u.business_id AND h.location_id=u.location_id ORDER BY u.created_at DESC`).all() })));
  app.post('/api/admin/pppoe/subscribers/:id/toggle', guard((req, res) => {
    confirm(req); const row = db.prepare('SELECT * FROM pppoe_users WHERE id=?').get(req.params.id); if (!row) return res.status(404).json({ error: 'PPPoE subscriber was not found.' });
    const status = row.status === 'active' ? 'disabled' : 'active'; db.prepare("UPDATE pppoe_users SET status=?,updated_at=datetime('now') WHERE id=?").run(status, row.id);
    db.prepare(`INSERT INTO pppoe_jobs(id,business_id,location_id,user_id,action,idempotency_key) VALUES(?,?,?,?,?,?) ON CONFLICT(business_id,idempotency_key) DO UPDATE SET status='queued',attempts=0,next_attempt_at=datetime('now')`).run(`pjob_${Date.now()}_${Math.random().toString(16).slice(2)}`, row.business_id, row.location_id, row.id, status === 'active' ? 'upsert' : 'revoke', `${row.id}:${status === 'active' ? 'upsert' : 'revoke'}`);
    res.json({ status });
  }));
  app.post('/api/admin/pppoe/subscribers/:id/reset-secret', guard((req, res) => {
    confirm(req); const row = db.prepare('SELECT * FROM pppoe_users WHERE id=?').get(req.params.id); if (!row) return res.status(404).json({ error: 'PPPoE subscriber was not found.' });
    const secret = `Fiti${Math.random().toString(36).slice(2, 10)}!`; const pppoe = require('../pppoe');
    db.prepare('UPDATE pppoe_users SET secret_ciphertext=?,updated_at=datetime(\'now\') WHERE id=?').run(pppoe.encrypt(secret), row.id);
    db.prepare(`INSERT INTO pppoe_jobs(id,business_id,location_id,user_id,action,idempotency_key) VALUES(?,?,?,?,?,?) ON CONFLICT(business_id,idempotency_key) DO UPDATE SET status='queued',attempts=0,next_attempt_at=datetime('now')`).run(`pjob_${Date.now()}_${Math.random().toString(16).slice(2)}`, row.business_id, row.location_id, row.id, 'upsert', `${row.id}:upsert`);
    res.json({ status: 'queued', secret });
  }));
}

module.exports = { attachPppoeAdmin };

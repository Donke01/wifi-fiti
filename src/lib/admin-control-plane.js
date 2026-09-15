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
  // A platform-admin phrase proves the caller is allowed into this control
  // plane.  A second, action-specific phrase prevents a pasted/admin-console
  // request from turning a routine review into an irreversible router action.
  const confirmIntent = (req, expected) => {
    confirm(req);
    if (String(req.body?.intent || '') !== expected) {
      const error = new Error(`Type ${expected} to confirm this router action.`);
      error.status = 400;
      throw error;
    }
  };
  const audit = (req, action, businessId, reference, details = {}) => db.prepare(
    `INSERT INTO platform_admin_audit(action,business_id,reference,actor,details_json) VALUES(?,?,?,?,?)`
  ).run(action, businessId || null, reference || null, String(req.ip || 'platform-admin'), JSON.stringify(details));
  const tenantRow = id => db.prepare('SELECT id,name,email,plan,collection_mode,billing_status,billing_expires_at FROM businesses WHERE id=?').get(id);
  const requireTenant = id => { const row = tenantRow(id); if (!row) { const e = new Error('Tenant was not found.'); e.status = 404; throw e; } return row; };
  // Do not reuse tenant.locationById here: it intentionally selects pairing
  // hashes and encrypted setup material for the router runtime.  Admin
  // diagnostics need operational state, not reusable credentials.
  const adminLocation = id => db.prepare(`
    SELECT l.id,l.business_id,b.name AS business_name,l.name,l.router_name,l.hotspot_server,
      l.setup_mode,l.router_model,l.routeros_version,l.wifi_stack,l.customer_bridge,
      l.wan_interface,l.wifi_interface,l.wifi_ssid,l.customer_ports,l.hotspot_subnet,
      l.router_status,l.offboarding_started_at,l.last_seen_at,l.last_router_contact_at,
      l.last_successful_sync_at,l.router_setup_verified_at,l.router_setup_health,
      l.router_setup_checked_at,l.portal_setup_completed_at,l.router_portal_update_sent_host,
      l.router_portal_applied_host,
      CASE WHEN l.router_pending_token_hash IS NOT NULL
                  AND l.router_pending_token_expires_at > datetime('now') THEN 1 ELSE 0 END AS pairing_pending,
      l.router_pending_token_expires_at AS pairing_expires_at,
      (SELECT d.hostname FROM tenant_portal_domains d WHERE d.location_id=l.id
        AND d.status='active' AND d.is_primary=1 ORDER BY d.created_at DESC LIMIT 1) AS portal_hostname
    FROM locations l JOIN businesses b ON b.id=l.business_id WHERE l.id=?
  `).get(id);
  const requireLocation = id => {
    const row = adminLocation(id);
    if (!row) { const error = new Error('Router location was not found.'); error.status = 404; throw error; }
    return row;
  };
  const publicLocation = row => ({
    id: row.id, businessId: row.business_id, businessName: row.business_name, name: row.name,
    routerName: row.router_name, hotspotServer: row.hotspot_server, setupMode: row.setup_mode,
    routerModel: row.router_model, routerOsVersion: row.routeros_version, wifiStack: row.wifi_stack,
    customerBridge: row.customer_bridge, wanInterface: row.wan_interface, wifiInterface: row.wifi_interface,
    wifiSsid: row.wifi_ssid, customerPorts: row.customer_ports, hotspotSubnet: row.hotspot_subnet,
    routerStatus: row.router_status, offboardingStartedAt: row.offboarding_started_at,
    lastSeenAt: row.last_seen_at, lastRouterContactAt: row.last_router_contact_at,
    lastSuccessfulSyncAt: row.last_successful_sync_at, setupVerifiedAt: row.router_setup_verified_at,
    setupHealth: row.router_setup_health, setupCheckedAt: row.router_setup_checked_at,
    portalSetupCompletedAt: row.portal_setup_completed_at, portalHostname: row.portal_hostname,
    portalAppliedHost: row.router_portal_applied_host, portalUpdateSentHost: row.router_portal_update_sent_host,
    pairingPending: Boolean(row.pairing_pending), pairingExpiresAt: row.pairing_expires_at,
  });

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

  /* ---------------------------------------------------------------------- */
  /* Router / location control plane                                         */
  /* ---------------------------------------------------------------------- */

  // Inventory is separate from the business dashboard's owner-scoped view.
  // It deliberately excludes router tokens, credential hashes, saved setup
  // source, customer MAC addresses, payment information, and VPN secrets.
  app.get('/api/admin/control-plane/locations', guard((req, res) => {
    const locations = db.prepare('SELECT id FROM locations ORDER BY created_at DESC').all()
      .map(({ id }) => publicLocation(adminLocation(id)));
    res.json({ locations });
  }));

  app.get('/api/admin/control-plane/locations/:locationId/diagnostics', guard((req, res) => {
    const location = requireLocation(req.params.locationId);
    const jobSummary = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END) AS pending,
      MAX(created_at) AS latest_created_at, MAX(acked_at) AS latest_acked_at
      FROM tenant_jobs WHERE location_id=?`).get(location.id);
    const paymentSummary = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN provisioned=1 THEN 1 ELSE 0 END) AS provisioned
      FROM tenant_transactions WHERE location_id=?`).get(location.id);
    const subscriptionSummary = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN is_active=1 AND expires_at > datetime('now') THEN 1 ELSE 0 END) AS active
      FROM tenant_subscriptions WHERE location_id=?`).get(location.id);
    const lifecycleJobs = db.prepare(`SELECT id,action,created_at,delivered_at,acked_at
      FROM tenant_jobs WHERE location_id=? AND action IN ('offboard-lockdown','offboard-reset')
      ORDER BY id DESC LIMIT 4`).all(location.id);
    const portalDomains = db.prepare(`SELECT hostname,kind,status,is_primary,created_at
      FROM tenant_portal_domains WHERE location_id=? ORDER BY is_primary DESC,created_at DESC`).all(location.id)
      .map(domain => ({ ...domain, isPrimary: Boolean(domain.is_primary) }));
    res.json({
      location: publicLocation(location),
      onboarding: {
        paired: Boolean(location.last_successful_sync_at),
        setupVerified: Boolean(location.router_setup_verified_at),
        pairingPending: Boolean(location.pairing_pending),
        portalApplied: Boolean(location.portal_hostname && location.router_portal_applied_host === location.portal_hostname),
      },
      jobs: { total: Number(jobSummary.total || 0), pending: Number(jobSummary.pending || 0), latestCreatedAt: jobSummary.latest_created_at, latestAcknowledgedAt: jobSummary.latest_acked_at },
      payments: { total: Number(paymentSummary.total || 0), pending: Number(paymentSummary.pending || 0), paid: Number(paymentSummary.paid || 0), provisioned: Number(paymentSummary.provisioned || 0) },
      subscriptions: { total: Number(subscriptionSummary.total || 0), active: Number(subscriptionSummary.active || 0) },
      lifecycleJobs,
      portalDomains,
    });
  }));

  // Rotation leaves a live router's active credential in place.  The one-time
  // pairing value is returned only in this no-store response and is never
  // placed in the audit log. Generating/rendering the full kit remains the
  // owner onboarding flow, which avoids duplicating RouterOS source here.
  app.post('/api/admin/control-plane/locations/:locationId/pairing-token/rotate', guard((req, res) => {
    confirmIntent(req, 'ROTATE PAIRING TOKEN');
    const before = requireLocation(req.params.locationId);
    const rotated = tenant.rotateLocationToken({ locationId: before.id, businessId: before.business_id });
    if (!rotated) { const error = new Error('Router location was not found.'); error.status = 404; throw error; }
    const location = requireLocation(before.id);
    audit(req, 'router_pairing_token_rotated', before.business_id, before.id, {
      hadActiveRouter: Boolean(before.last_successful_sync_at), pendingUntil: location.pairing_expires_at,
    });
    res.json({
      location: publicLocation(location),
      // This is deliberately the only response field containing the credential.
      // No audit event, location listing, or diagnostic endpoint returns it.
      oneTimePairingToken: rotated.routerToken,
      expiresAt: location.pairing_expires_at,
      nextStep: 'Generate the replacement connection kit through the tenant onboarding flow.',
    });
  }));

  app.patch('/api/admin/control-plane/locations/:locationId/portal', guard((req, res) => {
    confirmIntent(req, 'SET PORTAL ADDRESS');
    const location = requireLocation(req.params.locationId);
    const slug = String(req.body?.slug || '').trim().toLowerCase();
    if (tenant.managedPortalSlugReserved?.(slug)) {
      const error = new Error('Choose a different customer portal address.'); error.status = 400; throw error;
    }
    const updated = tenant.setManagedPortalHostname({ locationId: location.id, businessId: location.business_id, slug });
    if (!updated) { const error = new Error('Router location was not found.'); error.status = 404; throw error; }
    const safe = requireLocation(location.id);
    audit(req, 'router_portal_hostname_set', location.business_id, location.id, { hostname: safe.portal_hostname });
    res.json({ location: publicLocation(safe), portalHostname: safe.portal_hostname });
  }));

  // Offboarding is intentionally a staged, observable operation. It first
  // locks the router on its next authenticated poll; reset is a separate
  // action and cannot be queued until the lockdown job is acknowledged.
  app.post('/api/admin/control-plane/locations/:locationId/lifecycle/offboard', guard((req, res) => {
    confirmIntent(req, 'OFFBOARD ROUTER');
    const location = requireLocation(req.params.locationId);
    const offboarded = tenant.offboardLocation({ locationId: location.id, businessId: location.business_id, confirm: 'OFFBOARD ROUTER' });
    if (!offboarded) { const error = new Error('Router location was not found.'); error.status = 404; throw error; }
    audit(req, 'router_offboard_requested', location.business_id, location.id, { previousStatus: location.router_status, alreadyOffboarding: location.router_status === 'offboarding' });
    res.json({ location: publicLocation(requireLocation(location.id)), state: 'lockdown_queued', nextStep: 'Wait for the router to acknowledge lockdown before queueing a factory reset.' });
  }));

  app.post('/api/admin/control-plane/locations/:locationId/lifecycle/reset', guard((req, res) => {
    confirmIntent(req, 'QUEUE ROUTER RESET');
    const location = requireLocation(req.params.locationId);
    if (location.router_status !== 'offboarding') {
      const error = new Error('Offboard this router first. A reset is never sent to an active location.'); error.status = 409; throw error;
    }
    const lifecycle = db.prepare(`SELECT id,action,created_at,delivered_at,acked_at FROM tenant_jobs
      WHERE location_id=? AND action IN ('offboard-lockdown','offboard-reset') ORDER BY id DESC`).all(location.id);
    const reset = lifecycle.find(job => job.action === 'offboard-reset');
    if (reset) return res.json({ reset, queued: true, duplicate: true });
    const lockdown = lifecycle.find(job => job.action === 'offboard-lockdown');
    if (!lockdown?.acked_at) {
      const error = new Error('The router has not acknowledged the lockdown job. Restore its WAN/poller connection before queueing reset.'); error.status = 409; throw error;
    }
    if (!tenant.queueOffboardReset(location.id)) {
      const error = new Error('The reset could not be queued. Refresh diagnostics and try again.'); error.status = 409; throw error;
    }
    const queued = db.prepare(`SELECT id,action,created_at,delivered_at,acked_at FROM tenant_jobs
      WHERE location_id=? AND action='offboard-reset' ORDER BY id DESC LIMIT 1`).get(location.id);
    audit(req, 'router_reset_queued', location.business_id, location.id, { lockdownJobId: lockdown.id, resetJobId: queued.id });
    res.json({ reset: queued, queued: true, nextStep: 'The router will factory-reset only after it receives this queued reset job.' });
  }));

  // Fresh drafts can be deleted, but a paired or commercial location cannot
  // be force-deleted. It must complete the offboard sequence above so the
  // ledger and customer access history are retained safely.
  app.post('/api/admin/control-plane/locations/:locationId/lifecycle/delete-draft', guard((req, res) => {
    confirmIntent(req, 'DELETE UNUSED SETUP');
    const location = requireLocation(req.params.locationId);
    const removed = tenant.discardUnusedLocation({ locationId: location.id, businessId: location.business_id, confirm: 'DELETE' });
    if (!removed) { const error = new Error('Router location was not found.'); error.status = 404; throw error; }
    audit(req, 'router_draft_deleted', location.business_id, location.id, { name: removed.name });
    res.json({ removed });
  }));

  // Final removal is allowed only once the reset command has been delivered
  // to an already quarantined router.  It is never a generic force-delete.
  app.post('/api/admin/control-plane/locations/:locationId/lifecycle/finalize', guard((req, res) => {
    confirmIntent(req, 'FINALIZE OFFBOARD');
    const location = requireLocation(req.params.locationId);
    const removed = tenant.finalizeOffboardLocation(location.id, location.business_id);
    if (!removed) {
      const error = new Error('The reset job has not yet been delivered. Keep the location quarantined or wait for the seven-day cleanup window.'); error.status = 409; throw error;
    }
    audit(req, 'router_offboard_finalized', location.business_id, location.id, { name: removed.name });
    res.json({ removed });
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

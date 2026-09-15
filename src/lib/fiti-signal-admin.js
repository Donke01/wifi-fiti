'use strict';

/**
 * FitiSignal platform-admin read model and controls.
 *
 * This module deliberately does not participate in router, captive portal, or
 * payment provisioning. It provides the admin surface for the SMS module;
 * message delivery can be attached later without changing these contracts.
 */
function attachFitiSignalAdmin(app, { db, adminOk }) {
  db = db.db || db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiti_signal_admin_settings (
      id INTEGER PRIMARY KEY CHECK (id=1),
      provider_name TEXT NOT NULL DEFAULT 'not configured',
      price_per_segment_minor INTEGER NOT NULL DEFAULT 100,
      gsm_character_limit INTEGER NOT NULL DEFAULT 160,
      expiry_reminder_hours INTEGER NOT NULL DEFAULT 24,
      router_alert_delay_minutes INTEGER NOT NULL DEFAULT 15,
      combine_messages INTEGER NOT NULL DEFAULT 1,
      confirmed_events_only INTEGER NOT NULL DEFAULT 1,
      remove_unicode INTEGER NOT NULL DEFAULT 1,
      deduplicate_events INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO fiti_signal_admin_settings(id) VALUES(1);
  `);

  const admin = handler => (req, res) => {
    if (!adminOk(req)) return res.status(403).json({ error: 'Platform administrator access is required.' });
    res.set('Cache-Control', 'no-store');
    try { return handler(req, res); } catch (error) {
      console.error('[fiti-signal admin]', error.message);
      return res.status(500).json({ error: 'Could not load FitiSignal records.' });
    }
  };
  const cleanInteger = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const settings = db.prepare('SELECT * FROM fiti_signal_admin_settings WHERE id=1');

  app.get('/api/admin/fiti-signal/overview', admin((req, res) => {
    const summary = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='purchase' THEN delta ELSE 0 END),0) AS credits_purchased,
      COALESCE(SUM(CASE WHEN kind='sent' THEN ABS(CAST(json_extract(metadata_json,'$.segments') AS INTEGER)) ELSE 0 END),0) AS credits_used,
      COALESCE(SUM(CASE WHEN kind='refund' THEN delta ELSE 0 END),0) AS credits_refunded,
      COALESCE((SELECT SUM(amount) FROM fiti_signal_purchases WHERE status='paid'),0) AS revenue,
      (SELECT COUNT(*) FROM fiti_signal_messages) AS messages_total,
      (SELECT COUNT(*) FROM fiti_signal_messages WHERE status='sent') AS messages_delivered,
      (SELECT COUNT(*) FROM fiti_signal_messages WHERE status='failed') AS messages_failed,
      (SELECT COUNT(*) FROM businesses) AS tenants
      FROM fiti_signal_ledger`).get();
    const provider = {
      status: String(process.env.SMS_PROVIDER_NAME || settings.get().provider_name || 'not configured'),
      balance: null,
      note: 'Provider balance becomes live when the SMS adapter is configured.'
    };
    res.json({ module: 'FitiSignal', currency: 'KES', summary, settings: settings.get(), provider });
  }));

  app.get('/api/admin/fiti-signal/tenants', admin((req, res) => {
    const rows = db.prepare(`SELECT b.id,b.name,b.email,b.created_at,
      COALESCE((SELECT credits_available FROM fiti_signal_accounts WHERE business_id=b.id),0) AS credits_remaining,
      COALESCE((SELECT SUM(amount) FROM fiti_signal_purchases WHERE business_id=b.id AND status='paid'),0) AS sms_revenue,
      (SELECT COUNT(*) FROM fiti_signal_messages m WHERE m.business_id=b.id) AS messages_sent
      FROM businesses b ORDER BY b.created_at DESC`).all();
    res.json({ tenants: rows });
  }));

  app.get('/api/admin/fiti-signal/packages', admin((req, res) => {
    res.json({ packages: db.prepare('SELECT id, amount, credits, active FROM fiti_signal_packages WHERE active=1 ORDER BY amount').all() });
  }));

  // Unified platform read models. These are intentionally read-only: they
  // give administrators one place to audit the platform without allowing an
  // accidental admin action to alter a router or captive portal.
  app.get('/api/admin/platform/overview', admin((req, res) => {
    const scalar = sql => Number(db.prepare(sql).get()?.n || 0);
    const summary = {
      tenants: scalar('SELECT COUNT(*) n FROM businesses'),
      locations: scalar('SELECT COUNT(*) n FROM locations'),
      routersOnline: scalar("SELECT COUNT(*) n FROM locations WHERE last_router_contact_at >= datetime('now','-5 minutes')"),
      payments: scalar("SELECT COUNT(*) n FROM tenant_transactions WHERE status='paid'"),
      pendingPayments: scalar("SELECT COUNT(*) n FROM tenant_transactions WHERE status='pending'"),
      supportOpen: scalar("SELECT COUNT(*) n FROM business_support_tickets WHERE status <> 'resolved'"),
      smsQueued: scalar("SELECT COUNT(*) n FROM fiti_signal_messages WHERE status='queued'"),
      smsCredits: scalar('SELECT COALESCE(SUM(credits_available),0) n FROM fiti_signal_accounts'),
    };
    // Include the legacy dashboard names while the unified UI migrates.
    res.json({ generatedAt: new Date().toISOString(), summary: {
      ...summary, onlineLocations: summary.routersOnline, paidTransactions: summary.payments,
      pendingTransactions: summary.pendingPayments, activeSubscriptions: scalar("SELECT COUNT(*) n FROM tenant_subscriptions WHERE expires_at > datetime('now')"),
      openTickets: summary.supportOpen, revenueKes: scalar("SELECT COALESCE(SUM(amount),0) n FROM tenant_transactions WHERE status='paid'"),
    }, ...summary });
  }));
  app.get('/api/admin/platform/tenants', admin((req, res) => {
    res.json({ tenants: db.prepare(`SELECT b.id,b.name,b.email,b.owner_phone,b.created_at,b.onboarding_state,
      (SELECT COUNT(*) FROM locations l WHERE l.business_id=b.id) locations,
      (SELECT COUNT(*) FROM tenant_transactions t WHERE t.business_id=b.id AND t.status='paid') paid_payments,
      COALESCE((SELECT credits_available FROM fiti_signal_accounts a WHERE a.business_id=b.id),0) sms_credits
      FROM businesses b ORDER BY b.created_at DESC LIMIT 500`).all() });
  }));
  app.get('/api/admin/platform/routers', admin((req, res) => {
    res.json({ routers: db.prepare(`SELECT l.id,l.business_id,b.name AS business_name,l.name,l.router_name,
      l.router_model,l.routeros_version,l.setup_mode,l.hotspot_server,l.customer_bridge,l.wan_interface,
      l.last_router_contact_at,l.router_setup_health,l.router_setup_verified_at,
      CASE WHEN l.last_router_contact_at >= datetime('now','-5 minutes') THEN 1 ELSE 0 END online
      FROM locations l JOIN businesses b ON b.id=l.business_id ORDER BY l.last_router_contact_at DESC LIMIT 500`).all() });
  }));
  app.get('/api/admin/platform/locations', admin((req, res) => {
    const rows = db.prepare(`SELECT l.id,l.business_id,b.name AS business_name,l.name,l.router_name,l.router_model,
      l.last_router_contact_at,l.router_setup_health,
      CASE WHEN l.last_router_contact_at >= datetime('now','-5 minutes') THEN 'online' ELSE 'offline' END status
      FROM locations l JOIN businesses b ON b.id=l.business_id ORDER BY l.last_router_contact_at DESC LIMIT 500`).all();
    res.json({ locations: rows });
  }));
  app.get('/api/admin/platform/payments', admin((req, res) => {
    res.json({ payments: db.prepare(`SELECT t.checkout_request_id,t.business_id,b.name AS business_name,t.location_id,
      t.phone,t.package_name,t.amount,t.status,t.mpesa_receipt,t.provisioned,t.created_at,t.updated_at
      FROM tenant_transactions t JOIN businesses b ON b.id=t.business_id ORDER BY t.created_at DESC LIMIT 500`).all() });
  }));
  app.get('/api/admin/platform/transactions', admin((req, res) => {
    const rows = db.prepare(`SELECT t.checkout_request_id,t.business_id,b.name AS business_name,t.location_id,t.phone,
      t.package_name,t.amount,t.status,t.provisioned,t.created_at,t.updated_at
      FROM tenant_transactions t JOIN businesses b ON b.id=t.business_id ORDER BY t.created_at DESC LIMIT 500`).all();
    res.json({ transactions: rows });
  }));
  app.get('/api/admin/platform/packages', admin((req, res) => {
    res.json({ packages: db.prepare(`SELECT p.id,p.business_id,b.name AS business_name,p.name,p.price,p.seconds,p.rate_limit,p.active,p.created_at
      FROM business_packages p JOIN businesses b ON b.id=p.business_id ORDER BY p.created_at DESC LIMIT 500`).all() });
  }));
  app.get('/api/admin/platform/onboarding', admin((req, res) => {
    res.json({ states: db.prepare(`SELECT onboarding_state state,COUNT(*) count FROM businesses GROUP BY onboarding_state ORDER BY onboarding_state`).all(),
      routers: db.prepare(`SELECT CASE WHEN router_setup_verified_at IS NOT NULL THEN 'verified' WHEN last_router_contact_at IS NOT NULL THEN 'contacted' ELSE 'not_started' END state,COUNT(*) count FROM locations GROUP BY state`).all() });
  }));
  app.get('/api/admin/platform/support', admin((req, res) => {
    res.json({ tickets: db.prepare(`SELECT t.id,t.business_id,b.name business_name,t.subject,t.category,t.status,t.updated_at
      FROM business_support_tickets t JOIN businesses b ON b.id=t.business_id ORDER BY t.updated_at DESC LIMIT 500`).all() });
  }));

  app.get('/api/admin/fiti-signal/messages', admin((req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ messages: db.prepare(`SELECT id,business_id,event_id,service_key,recipient,segments,status,provider_id,error,created_at
      FROM fiti_signal_messages ORDER BY created_at DESC LIMIT ?`).all(limit) });
  }));

  app.patch('/api/admin/fiti-signal/settings', admin((req, res) => {
    const body = req.body || {};
    const current = settings.get();
    const next = {
      provider_name: String(body.providerName ?? current.provider_name).trim().slice(0, 80) || 'not configured',
      price_per_segment_minor: cleanInteger(body.pricePerSegmentMinor, current.price_per_segment_minor, 1, 100000),
      gsm_character_limit: cleanInteger(body.gsmCharacterLimit, current.gsm_character_limit, 70, 160),
      expiry_reminder_hours: cleanInteger(body.expiryReminderHours, current.expiry_reminder_hours, 1, 168),
      router_alert_delay_minutes: cleanInteger(body.routerAlertDelayMinutes, current.router_alert_delay_minutes, 1, 1440),
      combine_messages: body.combineMessages === undefined ? current.combine_messages : (body.combineMessages ? 1 : 0),
      confirmed_events_only: body.confirmedEventsOnly === undefined ? current.confirmed_events_only : (body.confirmedEventsOnly ? 1 : 0),
      remove_unicode: body.removeUnicode === undefined ? current.remove_unicode : (body.removeUnicode ? 1 : 0),
      deduplicate_events: body.deduplicateEvents === undefined ? current.deduplicate_events : (body.deduplicateEvents ? 1 : 0),
    };
    db.prepare(`UPDATE fiti_signal_admin_settings SET provider_name=?,price_per_segment_minor=?,gsm_character_limit=?,
      expiry_reminder_hours=?,router_alert_delay_minutes=?,combine_messages=?,confirmed_events_only=?,remove_unicode=?,
      deduplicate_events=?,updated_at=datetime('now') WHERE id=1`).run(
      next.provider_name, next.price_per_segment_minor, next.gsm_character_limit, next.expiry_reminder_hours,
      next.router_alert_delay_minutes, next.combine_messages, next.confirmed_events_only, next.remove_unicode,
      next.deduplicate_events);
    res.json({ settings: settings.get() });
  }));
}

module.exports = { attachFitiSignalAdmin };

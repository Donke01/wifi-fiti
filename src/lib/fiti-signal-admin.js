'use strict';

/**
 * FitiSignal platform-admin read model and controls.
 *
 * This module deliberately does not participate in router, captive portal, or
 * payment provisioning. It provides the admin surface for the SMS module;
 * message delivery can be attached later without changing these contracts.
 */
function attachFitiSignalAdmin(app, { db, adminOk }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiti_signal_settings (
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
    INSERT OR IGNORE INTO fiti_signal_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS fiti_signal_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount INTEGER NOT NULL CHECK(amount > 0),
      credits INTEGER NOT NULL CHECK(credits > 0),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fiti_signal_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('purchase','use','refund','adjustment')),
      credits INTEGER NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fiti_signal_credits_business
      ON fiti_signal_credits(business_id, created_at);
    CREATE TABLE IF NOT EXISTS fiti_signal_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id TEXT NOT NULL,
      recipient TEXT,
      service TEXT,
      segments INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued',
      provider_reference TEXT,
      event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fiti_signal_messages_business
      ON fiti_signal_messages(business_id, created_at);
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
  const settings = db.prepare('SELECT * FROM fiti_signal_settings WHERE id=1');

  app.get('/api/admin/fiti-signal/overview', admin((req, res) => {
    const summary = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='purchase' THEN credits ELSE 0 END),0) AS credits_purchased,
      COALESCE(SUM(CASE WHEN kind='use' THEN ABS(credits) ELSE 0 END),0) AS credits_used,
      COALESCE(SUM(CASE WHEN kind='refund' THEN credits ELSE 0 END),0) AS credits_refunded,
      COALESCE(SUM(CASE WHEN kind='purchase' THEN amount ELSE 0 END),0) AS revenue,
      (SELECT COUNT(*) FROM fiti_signal_messages) AS messages_total,
      (SELECT COUNT(*) FROM fiti_signal_messages WHERE status='delivered') AS messages_delivered,
      (SELECT COUNT(*) FROM fiti_signal_messages WHERE status IN ('failed','rejected')) AS messages_failed,
      (SELECT COUNT(*) FROM businesses) AS tenants
      FROM fiti_signal_credits`).get();
    const provider = {
      status: String(process.env.SMS_PROVIDER_NAME || settings.get().provider_name || 'not configured'),
      balance: null,
      note: 'Provider balance becomes live when the SMS adapter is configured.'
    };
    res.json({ module: 'FitiSignal', currency: 'KES', summary, settings: settings.get(), provider });
  }));

  app.get('/api/admin/fiti-signal/tenants', admin((req, res) => {
    const rows = db.prepare(`SELECT b.id,b.name,b.email,b.created_at,
      COALESCE(SUM(CASE WHEN c.kind IN ('purchase','refund','adjustment') THEN c.credits ELSE 0 END),0)
        - COALESCE(SUM(CASE WHEN c.kind='use' THEN ABS(c.credits) ELSE 0 END),0) AS credits_remaining,
      COALESCE(SUM(CASE WHEN c.kind='purchase' THEN c.amount ELSE 0 END),0) AS sms_revenue,
      (SELECT COUNT(*) FROM fiti_signal_messages m WHERE m.business_id=b.id) AS messages_sent
      FROM businesses b LEFT JOIN fiti_signal_credits c ON c.business_id=b.id
      GROUP BY b.id ORDER BY b.created_at DESC`).all();
    res.json({ tenants: rows });
  }));

  app.get('/api/admin/fiti-signal/packages', admin((req, res) => {
    res.json({ packages: db.prepare('SELECT * FROM fiti_signal_packages WHERE active=1 ORDER BY amount').all() });
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
    db.prepare(`UPDATE fiti_signal_settings SET provider_name=?,price_per_segment_minor=?,gsm_character_limit=?,
      expiry_reminder_hours=?,router_alert_delay_minutes=?,combine_messages=?,confirmed_events_only=?,remove_unicode=?,
      deduplicate_events=?,updated_at=datetime('now') WHERE id=1`).run(
      next.provider_name, next.price_per_segment_minor, next.gsm_character_limit, next.expiry_reminder_hours,
      next.router_alert_delay_minutes, next.combine_messages, next.confirmed_events_only, next.remove_unicode,
      next.deduplicate_events);
    res.json({ settings: settings.get() });
  }));
}

module.exports = { attachFitiSignalAdmin };

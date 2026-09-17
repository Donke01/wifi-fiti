const { db } = require('./db');
const config = require('../config');
const whatsapp = require('./whatsapp');

// WhatsApp is deliberately a notification side-effect.  A provider outage,
// an unapproved template, or a missing token must never interrupt payment
// confirmation or router provisioning.
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_notifications (
    event_id       TEXT PRIMARY KEY,
    recipient      TEXT NOT NULL,
    template_name  TEXT NOT NULL,
    language_code  TEXT NOT NULL DEFAULT 'en_US',
    parameters_json TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'pending',
    attempts       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error     TEXT,
    sent_at        TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_notifications_due
    ON whatsapp_notifications(status, next_attempt_at);
`);
// Recover a delivery claimed by a process that was restarted or killed.
db.prepare(`UPDATE whatsapp_notifications SET status='pending', updated_at=datetime('now')
             WHERE status='sending' AND updated_at <= datetime('now', '-10 minutes')`).run();

const insertNotification = db.prepare(`
  INSERT OR IGNORE INTO whatsapp_notifications
    (event_id, recipient, template_name, language_code, parameters_json)
  VALUES (@eventId, @recipient, @templateName, @languageCode, @parametersJson)
`);
const dueNotifications = db.prepare(`
  SELECT * FROM whatsapp_notifications
   WHERE status='pending' AND next_attempt_at <= datetime('now')
   ORDER BY created_at LIMIT @limit
`);
const markSending = db.prepare(`
  UPDATE whatsapp_notifications
     SET status='sending', attempts=attempts+1, updated_at=datetime('now')
   WHERE event_id=@eventId AND status='pending'
`);
const markSent = db.prepare(`
  UPDATE whatsapp_notifications
     SET status='sent', sent_at=datetime('now'), updated_at=datetime('now'), last_error=NULL
   WHERE event_id=@eventId
`);
const markRetry = db.prepare(`
  UPDATE whatsapp_notifications
     SET status=CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
         next_attempt_at=datetime('now', '+' || CASE
           WHEN attempts <= 1 THEN 15
           WHEN attempts <= 3 THEN 60
           WHEN attempts <= 5 THEN 300
           ELSE 1800 END || ' seconds'),
         last_error=@error, updated_at=datetime('now')
   WHERE event_id=@eventId
`);
const queueStats = db.prepare(`
  SELECT status, COUNT(*) AS count FROM whatsapp_notifications GROUP BY status
`);

function templateName() {
  return String(process.env.WHATSAPP_PAYMENT_TEMPLATE || '').trim();
}

function portalUrl(transaction) {
  // A tenant portal may be branded per location, but the base application URL
  // remains a useful, always-valid fallback until that URL is known here.
  return String(process.env.PUBLIC_URL || config.publicUrl || '').replace(/\/$/, '');
}

function paymentParameters(transaction) {
  const name = transaction.customer_name || transaction.name || 'Customer';
  const amount = Number(transaction.amount);
  const amountText = Number.isFinite(amount) ? `KES ${amount}` : 'your payment';
  const packageName = transaction.package_name || transaction.package_id || 'Wi-Fi package';
  return [name, amountText, packageName, portalUrl(transaction)];
}

function enqueuePayment(transaction, { eventIdPrefix = 'payment' } = {}) {
  const template = templateName();
  const phone = String(transaction?.phone || '').trim();
  const id = String(transaction?.checkout_request_id || '').trim();
  if (!template || !phone || !id) return false;
  insertNotification.run({
    eventId: `${eventIdPrefix}:${id}`,
    recipient: phone,
    templateName: template,
    languageCode: String(process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim() || 'en_US',
    parametersJson: JSON.stringify(paymentParameters(transaction)),
  });
  return true;
}

async function processQueue({ limit = 25 } = {}) {
  // This is intentionally a no-op until both credentials and an approved
  // template are present.  Draft templates cannot be sent by Meta.
  if (!whatsapp.configured() || !templateName()) return { sent: 0, skipped: true };
  let sent = 0;
  for (const row of dueNotifications.all({ limit: Math.max(1, Math.min(100, Number(limit) || 25)) })) {
    const claimed = markSending.run({ eventId: row.event_id });
    if (!claimed.changes) continue;
    try {
      await whatsapp.sendTemplate({
        to: row.recipient,
        name: row.template_name,
        languageCode: row.language_code,
        parameters: JSON.parse(row.parameters_json || '[]'),
      });
      markSent.run({ eventId: row.event_id });
      sent += 1;
    } catch (error) {
      markRetry.run({ eventId: row.event_id, error: String(error.message || error).slice(0, 500) });
    }
  }
  return { sent, skipped: false };
}

function stats() {
  return Object.fromEntries(queueStats.all().map(row => [row.status, Number(row.count)]));
}

module.exports = { enqueuePayment, processQueue, stats };

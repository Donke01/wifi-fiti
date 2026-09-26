'use strict';

/**
 * Subscription reminders for tenant owners: 3 days before a prepaid service
 * or trial ends, when a paid service enters its grace period, and when sales
 * stop. Sent by SMS (platform Africa's Talking account) and email; each
 * reminder key is recorded so it is sent at most once.
 */
const serviceBilling = require('./service-billing');

const DAY_MS = 86400_000;

function trialReminders(business, now) {
  if (String(business.billing_status || '').toLowerCase() !== 'trial') return [];
  const ends = serviceBilling.parseTime(business.billing_expires_at);
  if (ends == null) return [];
  const stamp = new Date(ends).toISOString().slice(0, 10);
  if (now >= ends - 3 * DAY_MS && now < ends) return [{ key: `trial:${stamp}:before`, kind: 'trial', stage: 'before', expires: business.billing_expires_at }];
  if (now >= ends && now < ends + 7 * DAY_MS) return [{ key: `trial:${stamp}:ended`, kind: 'trial', stage: 'ended', expires: business.billing_expires_at }];
  return [];
}

function trialText(stage, expiresRaw, name) {
  const ends = serviceBilling.parseTime(expiresRaw);
  const day = new Date(ends).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' });
  const who = name ? `${name}: ` : '';
  return stage === 'before'
    ? `${who}your Wi-Fi Fiti free trial ends on ${day}. Choose your hotspot capacity in Billing & payments to keep taking payments without a break.`
    : `${who}your Wi-Fi Fiti free trial has ended, so new sales are paused. Subscribe in Billing & payments to resume. Customers already online keep their time.`;
}

function createServiceReminders({ db, smsProvider = null, sendEmail = null, now = () => Date.now(), log = console }) {
  db.exec(`CREATE TABLE IF NOT EXISTS business_billing_reminders (
    reminder_key TEXT NOT NULL,
    business_id  TEXT NOT NULL,
    channels     TEXT,
    sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_id, reminder_key)
  )`);
  const candidates = db.prepare(`SELECT id, name, portal_name, owner_phone, email, billing_status, billing_expires_at,
      hotspot_billing_expires_at, pppoe_billing_expires_at
    FROM businesses WHERE billing_status != 'suspended'
      AND (billing_expires_at IS NOT NULL OR hotspot_billing_expires_at IS NOT NULL OR pppoe_billing_expires_at IS NOT NULL)`);
  const claim = db.prepare(`INSERT OR IGNORE INTO business_billing_reminders (reminder_key, business_id) VALUES (?, ?)`);
  const setChannels = db.prepare(`UPDATE business_billing_reminders SET channels=? WHERE reminder_key=? AND business_id=?`);

  function dueFor(business, at) {
    const due = [...trialReminders(business, at)];
    for (const kind of ['hotspot', 'pppoe']) {
      const raw = business[`${kind}_billing_expires_at`];
      for (const item of serviceBilling.dueReminders(kind, raw, at)) due.push({ ...item, kind, expires: raw });
    }
    // A reminder that is already past (e.g. "before" once "grace" is due)
    // is superseded; only the latest stage for each kind is sent.
    const latest = new Map();
    for (const item of due) latest.set(item.kind, item);
    return [...latest.values()];
  }

  async function deliver(business, item) {
    const name = business.portal_name || business.name || '';
    const text = item.kind === 'trial' ? trialText(item.stage, item.expires, name) : serviceBilling.reminderText(item.kind, item.stage, item.expires, name);
    const channels = [];
    const phone = String(business.owner_phone || '').replace(/\D/g, '');
    const intl = phone.startsWith('254') ? phone : phone.startsWith('0') ? `254${phone.slice(1)}` : phone;
    if (smsProvider && /^254[17]\d{8}$/.test(intl)) {
      try { await smsProvider.send({ to: `+${intl}`, message: text }); channels.push('sms'); }
      catch (error) { log.error('[billing reminders] SMS failed:', error.message); }
    }
    if (sendEmail && business.email) {
      try {
        const safe = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        await sendEmail({ to: business.email, subject: item.stage === 'before' ? 'Your Wi-Fi Fiti subscription ends soon' : 'Your Wi-Fi Fiti subscription needs renewing',
          text, html: `<p>${safe}</p><p><a href="https://cloud.wififiti.co.ke/business#payments">Open Billing &amp; payments</a></p>` });
        channels.push('email');
      } catch (error) { if (error.code !== 'EMAIL_NOT_CONFIGURED') log.error('[billing reminders] email failed:', error.message); }
    }
    return channels;
  }

  async function run() {
    const at = now();
    let sent = 0;
    for (const business of candidates.all()) {
      for (const item of dueFor(business, at)) {
        // Claim first so two overlapping runs never double-send.
        if (!claim.run(item.key, business.id).changes) continue;
        const channels = await deliver(business, item);
        setChannels.run(channels.join(',') || 'none', item.key, business.id);
        sent += 1;
      }
    }
    return sent;
  }

  return { run, dueFor };
}

module.exports = { createServiceReminders };

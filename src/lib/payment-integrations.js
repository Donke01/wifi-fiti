'use strict';

const { db } = require('./db');

/**
 * Payment rails are adapters behind one tenant-facing choice.  This registry
 * deliberately stores only the selected provider and its public status; any
 * provider secrets remain in their dedicated encrypted tables.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS business_payment_integrations (
    business_id  TEXT PRIMARY KEY,
    provider     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'not_configured',
    tested_at    TEXT,
    last_error   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const providers = [
  { id: 'fiti', name: 'Wi-Fi Fiti collection', description: 'Use Wi-Fi Fiti’s managed M-Pesa collection account.', available: true },
  { id: 'daraja', name: 'Safaricom Daraja API', description: 'Connect your own M-Pesa PayBill or Till credentials.', available: true },
  { id: 'tuma', name: 'Tuma Gateway', description: 'Accept bank and M-Pesa payments with direct settlement to your account.', available: true },
  { id: 'c2b', name: 'C2B PayBill reconciliation', description: 'Match customer PayBill references and reconcile them automatically.', available: true },
  { id: 'till', name: 'M-Pesa Till reconciliation', description: 'Reconcile Buy Goods / Till payments against customer accounts.', available: true },
  { id: 'bank', name: 'Bank account reconciliation', description: 'Connect a supported bank feed for automated settlement matching.', available: false },
  { id: 'manual', name: 'Manual payment recording', description: 'Record verified payments manually while an integration is pending.', available: true },
];
const byId = new Map(providers.map(provider => [provider.id, provider]));
const selected = db.prepare('SELECT * FROM business_payment_integrations WHERE business_id=?');
const save = db.prepare(`
  INSERT INTO business_payment_integrations (business_id, provider, status, updated_at)
  VALUES (?, ?, 'not_configured', datetime('now'))
  ON CONFLICT(business_id) DO UPDATE SET provider=excluded.provider,
    status='not_configured', last_error=NULL, updated_at=datetime('now')
`);
const markTested = db.prepare(`
  UPDATE business_payment_integrations SET status=@status, tested_at=datetime('now'),
    last_error=@error, updated_at=datetime('now') WHERE business_id=@businessId
`);

function summary(businessId) {
  const row = selected.get(businessId);
  const provider = byId.get(row?.provider || 'fiti');
  return {
    providers,
    selected: provider.id,
    status: row?.status || (provider.id === 'fiti' ? 'active' : 'not_configured'),
    testedAt: row?.tested_at || null,
    lastError: row?.last_error || null,
  };
}

function attachPaymentIntegrationRoutes(app, { businessAuth, tenant }) {
  app.get('/api/business/integrations', (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const result = summary(business.id);
    // Reflect the existing encrypted Daraja connection as configured even if
    // the tenant selected it before this registry was introduced.
    const daraja = tenant.paymentConnectionSummary.get(business.id);
    if (result.selected === 'daraja' && daraja && result.status === 'not_configured') result.status = 'active';
    res.json(result);
  });

  app.post('/api/business/integrations/select', (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const providerId = String(req.body?.provider || '').trim().toLowerCase();
    const provider = byId.get(providerId);
    if (!provider || !provider.available) return res.status(400).json({ error: 'Select an available payment integration.' });
    save.run(business.id, providerId);
    res.status(201).json(summary(business.id));
  });

  app.post('/api/business/integrations/test', async (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    const row = selected.get(business.id);
    const providerId = String(req.body?.provider || row?.provider || '').trim().toLowerCase();
    const provider = byId.get(providerId);
    if (!provider || !provider.available) return res.status(400).json({ error: 'Select an available payment integration first.' });
    if (!row || row.provider !== providerId) save.run(business.id, providerId);
    // Daraja verification remains the authoritative test for the existing
    // tenant connection. Other adapters become testable when credentials are
    // configured; no fake payment is created by this endpoint.
    let status = 'pending_configuration';
    let error = null;
    if (providerId === 'fiti' || providerId === 'manual') status = 'ready';
    else if (providerId === 'daraja' && tenant.paymentConnectionSummary.get(business.id)) status = 'ready';
    markTested.run({ businessId: business.id, status, error });
    res.json(summary(business.id));
  });
}

module.exports = { providers, summary, attachPaymentIntegrationRoutes };

'use strict';

/**
 * Per-tenant Tuma settlement.
 *
 * Wi‑Fi Fiti's platform Tuma account creates one child "business" per tenant
 * (POST /businesses). Tuma returns an API key for that child; STK pushes made
 * with the child's own key settle straight to the destination the tenant
 * chose: an M‑Pesa Till (BUYGOODS), an M‑Pesa PayBill (PAYBILL), or a bank /
 * Sacco account. Tenants who already run their own Tuma account can link it
 * with their email + API key instead.
 *
 * Secrets (the child API key and the full account number) are encrypted with
 * TENANT_SECRETS_KEY. Only the last four digits are ever returned to a browser.
 */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function httpError(status, message, field) {
  return Object.assign(new Error(message), { status, field, expose: true });
}

function normaliseMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('254')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return /^[71]\d{8}$/.test(digits) ? `254${digits}` : null;
}

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function last4(value) {
  const text = String(value || '');
  return text.length <= 4 ? text : text.slice(-4);
}

function createTumaTenants({ db, tuma, encrypt, decrypt, logoUrlFor, onPayoutSaved = null, beforeCreate = null, log = console }) {
  // Each new Tuma sub-business is a real account at Tuma; cap how many one
  // workspace can create so sign-ups cannot be used to spam Tuma.
  db.exec(`CREATE TABLE IF NOT EXISTS tuma_business_creations (business_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const creationsToday = db.prepare(`SELECT COUNT(*) AS n FROM tuma_business_creations WHERE business_id=? AND created_at>datetime('now','-1 day')`);
  const recordCreation = db.prepare(`INSERT INTO tuma_business_creations (business_id) VALUES (?)`);
  const MAX_CREATIONS_PER_DAY = 3;
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_tuma_accounts (
      business_id       TEXT PRIMARY KEY,
      mode              TEXT NOT NULL DEFAULT 'managed',
      tuma_business_id  TEXT,
      email             TEXT NOT NULL,
      api_key_cipher    TEXT NOT NULL,
      destination_type  TEXT,
      bank_id           TEXT,
      bank_name         TEXT,
      bank_code         TEXT,
      account_cipher    TEXT,
      account_last4     TEXT,
      settlement_name   TEXT,
      mobile            TEXT,
      active            INTEGER NOT NULL DEFAULT 1,
      verified_at       TEXT,
      last_error        TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const byBusiness = db.prepare('SELECT * FROM tenant_tuma_accounts WHERE business_id=?');
  const insert = db.prepare(`
    INSERT INTO tenant_tuma_accounts (business_id, mode, tuma_business_id, email, api_key_cipher,
      destination_type, bank_id, bank_name, bank_code, account_cipher, account_last4, settlement_name,
      mobile, active, verified_at, last_error)
    VALUES (@businessId, @mode, @tumaBusinessId, @email, @apiKeyCipher, @destinationType, @bankId,
      @bankName, @bankCode, @accountCipher, @accountLast4, @settlementName, @mobile, 1, @verifiedAt, @lastError)
  `);
  const updateDestination = db.prepare(`
    UPDATE tenant_tuma_accounts SET destination_type=@destinationType, bank_id=@bankId, bank_name=@bankName,
      bank_code=@bankCode, account_cipher=@accountCipher, account_last4=@accountLast4,
      settlement_name=@settlementName, mobile=@mobile, active=1, last_error=NULL, updated_at=datetime('now')
    WHERE business_id=@businessId
  `);
  const markVerified = db.prepare(`UPDATE tenant_tuma_accounts SET verified_at=datetime('now'), last_error=NULL,
    updated_at=datetime('now') WHERE business_id=?`);
  const markError = db.prepare(`UPDATE tenant_tuma_accounts SET last_error=?, updated_at=datetime('now') WHERE business_id=?`);
  const deactivate = db.prepare(`UPDATE tenant_tuma_accounts SET active=0, updated_at=datetime('now') WHERE business_id=?`);
  // Trial tenants who never subscribe have their Tuma business switched off
  // after TRIAL_DORMANT_DAYS; it is switched back on as soon as they pay.
  try { db.exec(`ALTER TABLE tenant_tuma_accounts ADD COLUMN suspended_reason TEXT`); } catch (_) { /* present */ }
  const suspend = db.prepare(`UPDATE tenant_tuma_accounts SET active=0, suspended_reason=?, updated_at=datetime('now') WHERE business_id=? AND active=1`);
  const resume = db.prepare(`UPDATE tenant_tuma_accounts SET active=1, suspended_reason=NULL, updated_at=datetime('now') WHERE business_id=?`);

  // Report the payout account and ID name to the one-trial-per-person guard.
  // Returns the reason the trial ended, if it did.
  function reportPayout(businessId, row) {
    if (!onPayoutSaved) return null;
    try { return onPayoutSaved(businessId, row); } catch (error) { log.error('[tuma tenants] trial check failed:', error.message); return null; }
  }

  // Guards against a double-click creating two Tuma businesses for one tenant.
  const inFlight = new Set();

  function publicView(row) {
    if (!row) return { connected: false, account: null };
    return {
      connected: Boolean(row.active),
      account: {
        mode: row.mode,
        destinationType: row.destination_type || null,
        destinationName: row.bank_name || null,
        bankId: row.bank_id || null,
        accountLast4: row.account_last4 || null,
        settlementName: row.settlement_name || null,
        mobile: row.mobile || null,
        email: row.email,
        active: Boolean(row.active),
        verifiedAt: row.verified_at || null,
        lastError: row.last_error || null,
        suspendedReason: row.suspended_reason || null,
        updatedAt: row.updated_at,
      },
    };
  }

  /** Decrypted { email, apiKey } for STK pushes, or null when not connected. */
  function credentialsFor(businessId) {
    const row = byBusiness.get(businessId);
    if (!row || !row.active) return null;
    return { email: row.email, apiKey: decrypt(row.api_key_cipher) };
  }

  async function destinations() {
    const list = await tuma.banks();
    return {
      till: list.find(bank => bank.kind === 'till') || null,
      paybill: list.find(bank => bank.kind === 'paybill') || null,
      banks: list.filter(bank => bank.kind === 'bank').sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async function validateDestination(body, business) {
    const type = String(body.destinationType || '').trim().toLowerCase();
    if (!['till', 'paybill', 'bank'].includes(type)) throw httpError(400, 'Choose where Tuma should send your money.', 'destinationType');
    const list = await tuma.banks();
    let bank;
    if (type === 'bank') {
      bank = list.find(item => item.id === String(body.bankId || '').trim() && item.kind === 'bank');
      if (!bank) throw httpError(400, 'Choose your bank or Sacco from the list.', 'bankId');
    } else {
      bank = list.find(item => item.kind === type);
      if (!bank) throw httpError(503, `Tuma is not offering M‑Pesa ${type === 'till' ? 'Till' : 'PayBill'} settlement right now.`, 'destinationType');
    }
    const rawAccount = String(body.accountNumber || '').replace(/[\s-]/g, '');
    if (type !== 'bank' && !/^\d{5,10}$/.test(rawAccount)) {
      throw httpError(400, `Enter your ${type === 'till' ? 'Till' : 'PayBill'} number (digits only).`, 'accountNumber');
    }
    if (type === 'bank' && !/^[A-Za-z0-9]{5,34}$/.test(rawAccount)) {
      throw httpError(400, 'Enter a valid account number (at least 5 characters).', 'accountNumber');
    }
    // Tuma registers each tenant under the account holder's full name exactly
    // as it appears on their ID, so the bank can match the payout account.
    const settlementName = cleanText(body.settlementName, 120);
    if (!/^\p{L}[\p{L}'.-]*(\s+\p{L}[\p{L}'.-]*)+$/u.test(settlementName)) {
      throw httpError(400, 'Enter your full name exactly as it appears on your ID (at least two names).', 'settlementName');
    }
    const mobile = normaliseMobile(body.mobile || business.owner_phone);
    if (!mobile) throw httpError(400, 'Enter a Safaricom, Airtel or Telkom number, e.g. 0712 345 678.', 'mobile');
    return { type, bank, accountNumber: rawAccount, settlementName, mobile };
  }

  function destinationColumns(businessId, d) {
    return {
      businessId,
      destinationType: d.type,
      bankId: d.bank.id,
      bankName: d.bank.name,
      bankCode: d.bank.code,
      accountCipher: encrypt(d.accountNumber),
      accountLast4: last4(d.accountNumber),
      settlementName: d.settlementName,
      mobile: d.mobile,
    };
  }

  /** Creates the tenant's Tuma business, or updates where its money goes. */
  async function saveSettlement(business, body = {}) {
    if (!tuma.credentialsConfigured()) {
      throw httpError(409, 'Wi‑Fi Fiti has not finished connecting its Tuma platform account yet. Please try again later.');
    }
    if (inFlight.has(business.id)) throw httpError(409, 'Your payout account is already being set up. Please wait a moment.');
    inFlight.add(business.id);
    try {
      const destination = await validateDestination(body, business);
      const existing = byBusiness.get(business.id);
      const tumaFields = {
        name: destination.settlementName,
        mobile: destination.mobile,
        bankId: destination.bank.id,
        accountNumber: destination.accountNumber,
        logo: logoUrlFor(business),
        description: `Wi‑Fi hotspot payments for ${cleanText(business.portal_name || business.name, 200)} (owner: ${destination.settlementName}) via Wi‑Fi Fiti`,
      };

      if (existing && existing.mode === 'managed' && existing.tuma_business_id) {
        await tuma.updateBusiness(existing.tuma_business_id, tumaFields);
        updateDestination.run(destinationColumns(business.id, destination));
        const trialEnded = reportPayout(business.id, { payout: destination.type === 'bank' ? `${destination.bank.id}:${destination.accountNumber}` : `mpesa:${destination.accountNumber}`, name: destination.settlementName });
        return { ...publicView(byBusiness.get(business.id)), trialEnded };
      }
      if (existing && existing.mode === 'linked') {
        throw httpError(409, 'This workspace uses your own Tuma account. Change the payout destination inside your Tuma dashboard, or disconnect it here first.');
      }

      const email = String(body.email || business.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email for the Tuma account.', 'email');
      const blocked = beforeCreate ? beforeCreate(business) : null;
      if (blocked) throw Object.assign(httpError(403, blocked), { needs: { action: 'verify_phone' } });
      if (creationsToday.get(business.id).n >= MAX_CREATIONS_PER_DAY) throw httpError(429, 'Too many Tuma accounts were set up for this workspace today. Please try again tomorrow or contact support.');
      recordCreation.run(business.id);
      const created = await tuma.createBusiness({ ...tumaFields, email });
      const apiKeyCipher = encrypt(created.apiKey);
      let verifiedAt = null;
      let lastError = null;
      try { await tuma.verify({ email: created.email || email, apiKey: created.apiKey }); verifiedAt = new Date().toISOString().replace('T', ' ').slice(0, 19); }
      catch (error) { lastError = String(error.message || 'Tuma could not verify the new account.').slice(0, 240); }
      const row = { ...destinationColumns(business.id, destination), mode: 'managed', tumaBusinessId: created.id,
        email: created.email || email, apiKeyCipher, verifiedAt, lastError };
      if (existing) {
        db.prepare('DELETE FROM tenant_tuma_accounts WHERE business_id=?').run(business.id);
      }
      insert.run(row);
      const trialEnded = reportPayout(business.id, { payout: destination.type === 'bank' ? `${destination.bank.id}:${destination.accountNumber}` : `mpesa:${destination.accountNumber}`, name: destination.settlementName });
      return { ...publicView(byBusiness.get(business.id)), trialEnded };
    } catch (error) {
      if (error.expose) throw error;
      // A Tuma-side HTTP status (e.g. 401 on the platform token) must never
      // reach the dashboard as-is: a 401 there means "sign the tenant out".
      log.error('[tuma tenants] settlement save failed:', error.status || '', error.message);
      throw httpError(502, `Tuma did not accept these details: ${String(error.message || 'unknown error').slice(0, 200)}`);
    } finally {
      inFlight.delete(business.id);
    }
  }

  /** Links a tenant's existing Tuma account (their own email + API key). */
  async function linkExisting(business, body = {}) {
    const email = String(body.email || '').trim().toLowerCase();
    const apiKey = String(body.apiKey || '').trim();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter the email your Tuma account uses.', 'email');
    if (apiKey.length < 16) throw httpError(400, 'Paste the API key from your Tuma dashboard.', 'apiKey');
    const existing = byBusiness.get(business.id);
    if (existing && existing.mode === 'managed' && existing.active) {
      throw httpError(409, 'Wi‑Fi Fiti already created a Tuma account for this workspace. Update its payout destination instead.');
    }
    try { tuma.forgetToken({ email, apiKey }); await tuma.verify({ email, apiKey }); }
    catch (error) { throw httpError(400, `Tuma did not accept that email and API key: ${String(error.message || '').slice(0, 160)}`, 'apiKey'); }
    if (existing) db.prepare('DELETE FROM tenant_tuma_accounts WHERE business_id=?').run(business.id);
    insert.run({ businessId: business.id, mode: 'linked', tumaBusinessId: null, email, apiKeyCipher: encrypt(apiKey),
      destinationType: 'own', bankId: null, bankName: 'Your Tuma account', bankCode: null, accountCipher: null,
      accountLast4: null, settlementName: cleanText(business.portal_name || business.name, 120), mobile: null,
      verifiedAt: new Date().toISOString().replace('T', ' ').slice(0, 19), lastError: null });
    const trialEnded = reportPayout(business.id, { payout: `tuma:${email}` });
    return { ...publicView(byBusiness.get(business.id)), trialEnded };
  }

  /* ---- More Tuma settlement accounts ---------------------------------
   * The main account above stays exactly as it was (Tuma fee, trial
   * switch-off and the Billing & payments screen use it). A business can add
   * more, each its own Tuma sub-business or linked Tuma account, and give
   * routers to them in Settings → Payment methods (payment-methods.js).
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_tuma_extra_accounts (
      id                TEXT PRIMARY KEY,
      business_id       TEXT NOT NULL,
      label             TEXT,
      mode              TEXT NOT NULL DEFAULT 'managed',
      tuma_business_id  TEXT,
      email             TEXT NOT NULL,
      api_key_cipher    TEXT NOT NULL,
      destination_type  TEXT,
      bank_id           TEXT,
      bank_name         TEXT,
      bank_code         TEXT,
      account_cipher    TEXT,
      account_last4     TEXT,
      settlement_name   TEXT,
      mobile            TEXT,
      active            INTEGER NOT NULL DEFAULT 1,
      removed           INTEGER NOT NULL DEFAULT 0,
      suspended_reason  TEXT,
      verified_at       TEXT,
      last_error        TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_tuma_extra_business ON tenant_tuma_extra_accounts(business_id, removed);
  `);
  const extrasFor = db.prepare(`SELECT * FROM tenant_tuma_extra_accounts WHERE business_id=? AND removed=0 ORDER BY created_at, rowid`);
  const extraById = db.prepare(`SELECT * FROM tenant_tuma_extra_accounts WHERE id=? AND business_id=?`);
  const insertExtra = db.prepare(`
    INSERT INTO tenant_tuma_extra_accounts (id, business_id, label, mode, tuma_business_id, email, api_key_cipher,
      destination_type, bank_id, bank_name, bank_code, account_cipher, account_last4, settlement_name, mobile, verified_at, last_error)
    VALUES (@id, @businessId, @label, @mode, @tumaBusinessId, @email, @apiKeyCipher, @destinationType, @bankId,
      @bankName, @bankCode, @accountCipher, @accountLast4, @settlementName, @mobile, @verifiedAt, @lastError)
  `);
  const removeExtraRow = db.prepare(`UPDATE tenant_tuma_extra_accounts SET removed=1, active=0, updated_at=datetime('now') WHERE id=? AND business_id=? AND removed=0`);
  const suspendExtra = db.prepare(`UPDATE tenant_tuma_extra_accounts SET active=0, suspended_reason=?, updated_at=datetime('now') WHERE id=? AND active=1 AND removed=0`);
  const resumeExtra = db.prepare(`UPDATE tenant_tuma_extra_accounts SET active=1, suspended_reason=NULL, updated_at=datetime('now') WHERE id=? AND removed=0`);
  const newExtraId = () => 'tma-' + require('node:crypto').randomBytes(8).toString('hex');

  function extraView(row) {
    const where = row.mode === 'linked' ? 'Your own Tuma account'
      : `${row.destination_type === 'bank' ? (row.bank_name || 'Bank') : row.destination_type === 'paybill' ? 'PayBill' : 'Till'} ••${row.account_last4 || ''}`;
    return { id: row.id, label: row.label || where, detail: `Tuma settles to ${where}`, mode: row.mode,
      destinationType: row.destination_type || null, accountLast4: row.account_last4 || null,
      active: Boolean(row.active), suspendedReason: row.suspended_reason || null, lastError: row.last_error || null };
  }
  /** The extra Tuma accounts of a business (not removed). */
  function extraAccounts(businessId) { return extrasFor.all(businessId).map(extraView); }
  function extraUsable(businessId, id) { const row = extraById.get(String(id || ''), businessId); return Boolean(row && !row.removed && (row.active || row.suspended_reason === 'trial-ended')); }
  function extraCredentials(businessId, id) {
    const row = extraById.get(String(id || ''), businessId);
    if (!row || row.removed || !row.active) return null;
    return { email: row.email, apiKey: decrypt(row.api_key_cipher) };
  }
  /** Before a payment: an extra account switched off at trial end comes back. */
  async function resumeExtraIfSuspended(businessId, id, isEntitled) {
    const row = extraById.get(String(id || ''), businessId);
    if (!row || row.active || row.removed || row.suspended_reason !== 'trial-ended' || !isEntitled(businessId)) return false;
    if (row.tuma_business_id) { try { await tuma.updateBusiness(row.tuma_business_id, { active: true }); } catch (error) { log.error(`[tuma tenants] Tuma did not accept switching on ${row.id}:`, error.message); } }
    return resumeExtra.run(row.id).changes > 0;
  }

  /** Add one more Tuma settlement account: a new Tuma sub-business that
   * settles to the Till, PayBill or bank given, or a linked Tuma account. */
  async function addExtra(business, body = {}) {
    if (!routable(business.id)) throw httpError(409, 'Connect your main Tuma payout account in Settings → Billing & payments first, then add more here.');
    const label = cleanText(body.label, 60) || null;
    const lockKey = business.id + ':extra';
    if (inFlight.has(lockKey)) throw httpError(409, 'A Tuma account is already being set up. Please wait a moment.');
    inFlight.add(lockKey);
    try {
      if (body.mode === 'linked') {
        const email = String(body.email || '').trim().toLowerCase();
        const apiKey = String(body.apiKey || '').trim();
        if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter the email your Tuma account uses.', 'email');
        if (apiKey.length < 16) throw httpError(400, 'Paste the API key from your Tuma dashboard.', 'apiKey');
        try { tuma.forgetToken({ email, apiKey }); await tuma.verify({ email, apiKey }); }
        catch (error) { throw httpError(400, `Tuma did not accept that email and API key: ${String(error.message || '').slice(0, 160)}`, 'apiKey'); }
        const id = newExtraId();
        insertExtra.run({ id, businessId: business.id, label, mode: 'linked', tumaBusinessId: null, email, apiKeyCipher: encrypt(apiKey),
          destinationType: 'own', bankId: null, bankName: 'Your Tuma account', bankCode: null, accountCipher: null, accountLast4: null,
          settlementName: cleanText(business.portal_name || business.name, 120), mobile: null,
          verifiedAt: new Date().toISOString().replace('T', ' ').slice(0, 19), lastError: null });
        const trialEnded = reportPayout(business.id, { payout: `tuma:${email}` });
        return { ...extraView(extraById.get(id, business.id)), trialEnded };
      }
      if (!tuma.credentialsConfigured()) throw httpError(409, 'Wi‑Fi Fiti has not finished connecting its Tuma platform account yet. Please try again later.');
      const destination = await validateDestination(body, business);
      const email = String(body.email || business.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email for the Tuma account.', 'email');
      const blocked = beforeCreate ? beforeCreate(business) : null;
      if (blocked) throw Object.assign(httpError(403, blocked), { needs: { action: 'verify_phone' } });
      if (creationsToday.get(business.id).n >= MAX_CREATIONS_PER_DAY) throw httpError(429, 'Too many Tuma accounts were set up for this workspace today. Please try again tomorrow or contact support.');
      recordCreation.run(business.id);
      const created = await tuma.createBusiness({
        name: destination.settlementName, mobile: destination.mobile, bankId: destination.bank.id, accountNumber: destination.accountNumber,
        logo: logoUrlFor(business), email,
        description: `Wi‑Fi hotspot payments for ${cleanText(business.portal_name || business.name, 200)}${label ? ` (${label})` : ''} (owner: ${destination.settlementName}) via Wi‑Fi Fiti`,
      });
      let verifiedAt = null; let lastError = null;
      try { await tuma.verify({ email: created.email || email, apiKey: created.apiKey }); verifiedAt = new Date().toISOString().replace('T', ' ').slice(0, 19); }
      catch (error) { lastError = String(error.message || 'Tuma could not verify the new account.').slice(0, 240); }
      const id = newExtraId();
      insertExtra.run({ ...destinationColumns(business.id, destination), id, label, mode: 'managed', tumaBusinessId: created.id,
        email: created.email || email, apiKeyCipher: encrypt(created.apiKey), verifiedAt, lastError });
      const trialEnded = reportPayout(business.id, { payout: destination.type === 'bank' ? `${destination.bank.id}:${destination.accountNumber}` : `mpesa:${destination.accountNumber}`, name: destination.settlementName });
      return { ...extraView(extraById.get(id, business.id)), trialEnded };
    } catch (error) {
      if (error.expose) throw error;
      log.error('[tuma tenants] extra account failed:', error.status || '', error.message);
      throw httpError(502, `Tuma did not accept these details: ${String(error.message || 'unknown error').slice(0, 200)}`);
    } finally {
      inFlight.delete(lockKey);
    }
  }
  /** Stop using an extra account. A Wi‑Fi Fiti-created one is switched off at Tuma too. */
  async function removeExtra(businessId, id) {
    const row = extraById.get(String(id || ''), businessId);
    if (!row || row.removed) throw httpError(404, 'That Tuma account was not found.');
    if (row.mode === 'managed' && row.tuma_business_id) {
      try { await tuma.updateBusiness(row.tuma_business_id, { active: false }); }
      catch (error) { log.error(`[tuma tenants] Tuma did not accept switching off ${row.id}:`, error.message); }
    }
    removeExtraRow.run(row.id, businessId);
    return true;
  }

  function connected(businessId) {
    const row = byBusiness.get(businessId);
    return Boolean(row && row.active);
  }
  /** Can a router be given Tuma? Yes when connected, and also while switched
   * off at trial end: the payment switches it back on if the plan is active. */
  function routable(businessId) {
    const row = byBusiness.get(businessId);
    return Boolean(row && (row.active || row.suspended_reason === 'trial-ended'));
  }

  async function test(businessId) {
    if (!connected(businessId)) return { ok: false, error: 'Add where Tuma should send your money first.' };
    try {
      const credentials = credentialsFor(businessId);
      tuma.forgetToken(credentials);
      await tuma.verify(credentials);
      markVerified.run(businessId);
      return { ok: true };
    } catch (error) {
      const message = String(error.message || 'Tuma verification failed.').slice(0, 240);
      markError.run(message, businessId);
      return { ok: false, error: message };
    }
  }

  function send(res, error) {
    const status = error.status || 500;
    if (status >= 500 && status !== 502 && status !== 503) log.error('[tuma tenants]', error);
    res.status(status).json({ error: status === 500 ? 'Something went wrong saving your payout account.' : error.message, field: error.field || null, ...(error.needs ? { needs: error.needs } : {}) });
  }

  function attachRoutes(app, { businessAuth }) {
    app.get('/api/business/tuma/destinations', async (req, res) => {
      const business = businessAuth(req, res); if (!business) return;
      if (!tuma.credentialsConfigured()) return res.status(409).json({ error: 'Wi‑Fi Fiti has not finished connecting its Tuma platform account yet.' });
      try { res.json(await destinations()); }
      catch (error) { log.error('[tuma tenants] banks failed:', error.message); res.status(502).json({ error: 'Could not load Tuma’s list of banks right now. Please try again.' }); }
    });

    app.get('/api/business/tuma/settlement', (req, res) => {
      const business = businessAuth(req, res); if (!business) return;
      res.json({ ...publicView(byBusiness.get(business.id)), platformReady: tuma.credentialsConfigured() });
    });

    app.post('/api/business/tuma/settlement', async (req, res) => {
      const business = businessAuth(req, res); if (!business) return;
      try { res.status(201).json(await saveSettlement(business, req.body || {})); }
      catch (error) { send(res, error); }
    });

    app.post('/api/business/tuma/link', async (req, res) => {
      const business = businessAuth(req, res); if (!business) return;
      try { res.status(201).json(await linkExisting(business, req.body || {})); }
      catch (error) { send(res, error); }
    });

    app.delete('/api/business/tuma/link', (req, res) => {
      const business = businessAuth(req, res); if (!business) return;
      const row = byBusiness.get(business.id);
      if (!row || row.mode !== 'linked') return res.status(404).json({ error: 'No linked Tuma account to disconnect.' });
      deactivate.run(business.id);
      res.json(publicView(byBusiness.get(business.id)));
    });
  }

  /**
   * Switch off managed Tuma businesses of trial tenants who never subscribed
   * (isDormant), and back on for anyone suspended who now has an active
   * trial or paid service (isEntitled). Local credentials stop being used
   * either way; Tuma is told too where it allows it.
   */
  async function sweep({ isDormant, isEntitled }) {
    const rows = db.prepare(`SELECT * FROM tenant_tuma_accounts WHERE mode='managed' AND tuma_business_id IS NOT NULL`).all();
    const result = { suspended: 0, resumed: 0 };
    for (const row of rows) {
      if (row.active && isDormant(row.business_id)) {
        try { await tuma.updateBusiness(row.tuma_business_id, { active: false }); }
        catch (error) { log.error(`[tuma tenants] Tuma did not accept switching off ${row.business_id}:`, error.message); }
        if (suspend.run('trial-ended', row.business_id).changes) result.suspended += 1;
      } else if (!row.active && row.suspended_reason === 'trial-ended' && isEntitled(row.business_id)) {
        if (await resumeAccount(row)) result.resumed += 1;
      }
    }
    // Extra accounts follow the same rule.
    for (const row of db.prepare(`SELECT * FROM tenant_tuma_extra_accounts WHERE mode='managed' AND tuma_business_id IS NOT NULL AND removed=0`).all()) {
      if (row.active && isDormant(row.business_id)) {
        try { await tuma.updateBusiness(row.tuma_business_id, { active: false }); }
        catch (error) { log.error(`[tuma tenants] Tuma did not accept switching off ${row.id}:`, error.message); }
        if (suspendExtra.run('trial-ended', row.id).changes) result.suspended += 1;
      } else if (!row.active && row.suspended_reason === 'trial-ended' && isEntitled(row.business_id)) {
        if (await resumeExtraIfSuspended(row.business_id, row.id, isEntitled)) result.resumed += 1;
      }
    }
    return result;
  }

  async function resumeAccount(row) {
    try { await tuma.updateBusiness(row.tuma_business_id, { active: true }); }
    catch (error) { log.error(`[tuma tenants] Tuma did not accept switching on ${row.business_id}:`, error.message); }
    return resume.run(row.business_id).changes > 0;
  }

  /** Switch a suspended account back on immediately (e.g. at checkout). */
  async function resumeIfSuspended(businessId, isEntitled) {
    const row = byBusiness.get(businessId);
    if (!row || row.active || row.suspended_reason !== 'trial-ended' || !isEntitled(businessId)) return false;
    return resumeAccount(row);
  }

  return { attachRoutes, connected, credentialsFor, sweep, resumeIfSuspended, saveSettlement, linkExisting, destinations, test, view: (id) => publicView(byBusiness.get(id)),
    routable, extraAccounts, extraUsable, extraCredentials, resumeExtraIfSuspended, addExtra, removeExtra, send };
}

module.exports = { createTumaTenants, normaliseMobile };

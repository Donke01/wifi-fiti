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

function createTumaTenants({ db, tuma, encrypt, decrypt, logoUrlFor, log = console }) {
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
        return publicView(byBusiness.get(business.id));
      }
      if (existing && existing.mode === 'linked') {
        throw httpError(409, 'This workspace uses your own Tuma account. Change the payout destination inside your Tuma dashboard, or disconnect it here first.');
      }

      const email = String(body.email || business.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email for the Tuma account.', 'email');
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
      return publicView(byBusiness.get(business.id));
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
    return publicView(byBusiness.get(business.id));
  }

  function connected(businessId) {
    const row = byBusiness.get(businessId);
    return Boolean(row && row.active);
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
    res.status(status).json({ error: status === 500 ? 'Something went wrong saving your payout account.' : error.message, field: error.field || null });
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

  return { attachRoutes, connected, credentialsFor, saveSettlement, linkExisting, destinations, test, view: (id) => publicView(byBusiness.get(id)) };
}

module.exports = { createTumaTenants, normaliseMobile };

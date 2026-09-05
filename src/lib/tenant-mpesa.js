/**
 * Per-business M-Pesa client.
 *
 * WiFi Fiti collection uses the platform Daraja account in `mpesa.js`.
 * Businesses that bring their own Till/PayBill use this client with their
 * encrypted credentials. Keeping it separate prevents a tenant credential
 * from leaking into the platform client cache.
 */
const config = require('../config');
const crypto = require('node:crypto');

const tokenCache = new Map();

function timestamp() {
  const nairobi = new Date(Date.now() + 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${nairobi.getUTCFullYear()}${pad(nairobi.getUTCMonth() + 1)}${pad(nairobi.getUTCDate())}` +
    `${pad(nairobi.getUTCHours())}${pad(nairobi.getUTCMinutes())}${pad(nairobi.getUTCSeconds())}`;
}

function password(credentials, ts) {
  return Buffer.from(`${credentials.shortcode}${credentials.passkey}${ts}`).toString('base64');
}

function cacheKey(credentials) {
  return crypto.createHash('sha256').update(`${credentials.shortcode}:${credentials.consumerKey}:${credentials.consumerSecret}`).digest('hex');
}

async function accessToken(credentials) {
  const key = cacheKey(credentials);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const basic = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64');
  const response = await fetch(`${config.mpesa.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!response.ok) throw new Error(`M-Pesa authentication failed (${response.status}).`);
  const body = await response.json().catch(() => ({}));
  if (!body.access_token) throw new Error('M-Pesa did not return an access token.');
  tokenCache.set(key, { value: body.access_token, expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 3599) - 120) * 1000 });
  return body.access_token;
}

async function stkPush({ credentials, phone, amount, accountReference, description }) {
  const token = await accessToken(credentials);
  const ts = timestamp();
  const response = await fetch(`${config.mpesa.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: credentials.shortcode,
      Password: password(credentials, ts),
      Timestamp: ts,
      TransactionType: credentials.transactionType,
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: credentials.shortcode,
      PhoneNumber: phone,
      CallBackURL: `${config.publicUrl}/api/mpesa/callback`,
      AccountReference: String(accountReference).slice(0, 12),
      TransactionDesc: String(description).slice(0, 13),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ResponseCode !== '0') {
    throw new Error(body.errorMessage || body.ResponseDescription || 'M-Pesa rejected the payment request.');
  }
  return { checkoutRequestId: body.CheckoutRequestID, merchantRequestId: body.MerchantRequestID };
}

async function stkQuery({ credentials, checkoutRequestId }) {
  const token = await accessToken(credentials);
  const ts = timestamp();
  const response = await fetch(`${config.mpesa.baseUrl}/mpesa/stkpushquery/v1/query`, {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: credentials.shortcode,
      Password: password(credentials, ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`M-Pesa query is unavailable (${response.status}).`);
  return {
    raw: body,
    settled: body.ResultCode !== undefined,
    resultCode: body.ResultCode !== undefined ? Number(body.ResultCode) : null,
    resultDesc: body.ResultDesc || body.errorMessage || null,
  };
}

async function verify(credentials) {
  tokenCache.delete(cacheKey(credentials));
  await accessToken(credentials);
  return true;
}

module.exports = { stkPush, stkQuery, verify };

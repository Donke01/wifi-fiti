'use strict';

/**
 * Tuma Payments adapter.
 *
 * Tuma authenticates a configured business with its API email + API key,
 * returns a short-lived JWT, and accepts STK push requests. Payment truth is
 * received through our callback endpoint; we never grant a package merely
 * because the push request was accepted.
 */
const crypto = require('node:crypto');

const baseUrl = String(process.env.TUMA_API_BASE_URL || 'https://api.tuma.co.ke').replace(/\/$/, '');
const email = String(process.env.TUMA_API_EMAIL || '').trim();
const apiKey = String(process.env.TUMA_API_KEY || '').trim();
const callbackSecret = String(process.env.TUMA_CALLBACK_SECRET || '').trim();
// One cached JWT per credential pair: the platform account and every tenant
// sub-business authenticate separately. Keys are hashed so raw API keys never
// sit in a Map key.
const tokenCache = new Map();
const banksCache = { value: null, expiresAt: 0 };
const BANKS_TTL_MS = 12 * 60 * 60 * 1000;

function configured() {
  return credentialsConfigured() && callbackSecret.length >= 24;
}

function callbackConfigured() {
  return callbackSecret.length >= 24;
}

function credentialsConfigured() {
  return email.length > 3 && apiKey.length >= 16;
}

function configurationStatus() {
  const missing = [];
  if (email.length <= 3) missing.push('TUMA_API_EMAIL');
  if (apiKey.length < 16) missing.push('TUMA_API_KEY');
  if (callbackSecret.length < 24) missing.push('TUMA_CALLBACK_SECRET');
  return { configured: missing.length === 0, missing };
}

function callbackUrl(publicUrl) {
  const base = String(publicUrl || '').replace(/\/$/, '') + '/api/tuma/callback';
  return `${base}?key=${encodeURIComponent(callbackSecret)}`;
}

function cacheKey(account) {
  return crypto.createHash('sha256').update(`${account.email}\u0000${account.apiKey}`).digest('hex');
}

/**
 * Returns a JWT for `credentials` ({ email, apiKey }) or, when omitted, for
 * the platform account configured in Railway.
 */
async function accessToken(credentials) {
  const account = credentials
    ? { email: String(credentials.email || '').trim(), apiKey: String(credentials.apiKey || '').trim() }
    : { email, apiKey };
  if (!credentials && !credentialsConfigured()) throw new Error('Tuma API credentials are not configured on this deployment.');
  if (account.email.length <= 3 || account.apiKey.length < 16) throw new Error('This Tuma account is missing its API credentials.');
  const key = cacheKey(account);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(`${baseUrl}/auth/token`, {
    signal: AbortSignal.timeout(15000), method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, api_key: account.apiKey }),
  });
  const body = await response.json().catch(() => ({}));
  // Tuma's documented auth response returns `token` at the top level. Keep
  // the nested form as a compatibility fallback for older API deployments.
  const token = body && (body.token || (body.data && body.data.token));
  if (!response.ok || !token) throw new Error(body.message || `Tuma authentication failed (${response.status}).`);
  // Tuma tokens are normally about 24 hours. Keep a conservative one-hour
  // cache so a deployment never races an expiring token.
  tokenCache.set(key, { value: token, expiresAt: Date.now() + 55 * 60 * 1000 });
  return token;
}

function forgetToken(credentials) {
  if (!credentials) return;
  tokenCache.delete(cacheKey({ email: String(credentials.email || '').trim(), apiKey: String(credentials.apiKey || '').trim() }));
}

async function stkPush({ credentials, phone, amount, description, publicUrl }) {
  const token = await accessToken(credentials);
  const response = await fetch(`${baseUrl}/payment/stk-push`, {
    signal: AbortSignal.timeout(15000), method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(Number(amount)), phone: String(phone),
      callback_url: callbackUrl(publicUrl),
      description: String(description || 'Wi-Fi Fiti payment').slice(0, 100),
    }),
  });
  const body = await response.json().catch(() => ({}));
  const data = body && body.data;
  if (!response.ok || !body.success || !data || !data.checkout_request_id) {
    throw new Error((body && body.message) || `Tuma payment request failed (${response.status}).`);
  }
  return {
    checkoutRequestId: data.checkout_request_id,
    merchantRequestId: data.merchant_request_id || null,
  };
}

async function verify(credentials) {
  await accessToken(credentials);
  return true;
}

async function platformRequest(method, pathname, body) {
  const token = await accessToken();
  const response = await fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(20000), method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const error = new Error((payload && payload.message) || `Tuma request failed (${response.status}).`);
    error.status = response.status;
    error.details = payload && (payload.errors || payload.details) || null;
    throw error;
  }
  return payload && payload.data !== undefined ? payload.data : payload;
}

function normaliseBank(row) {
  const code = String(row.code || row.bank_code || '').trim();
  const name = String(row.name || row.bank_name || '').trim();
  const upper = code.toUpperCase();
  const kind = upper === 'BUYGOODS' ? 'till' : upper === 'PAYBILL' ? 'paybill' : 'bank';
  return { id: String(row.id || '').trim(), name, code, kind };
}

/** Tuma's live settlement destinations: M-Pesa Till, PayBill, banks, Saccos. */
async function banks({ fresh = false } = {}) {
  if (!fresh && banksCache.value && banksCache.expiresAt > Date.now()) return banksCache.value;
  const data = await platformRequest('GET', '/reference/banks');
  const rows = Array.isArray(data) ? data : Array.isArray(data && data.banks) ? data.banks : [];
  const list = rows.map(normaliseBank).filter(bank => bank.id && bank.name);
  if (!list.length) throw new Error('Tuma returned no settlement destinations.');
  banksCache.value = list;
  banksCache.expiresAt = Date.now() + BANKS_TTL_MS;
  return list;
}

function businessPayload(fields) {
  const out = {};
  if (fields.name !== undefined) out.name = String(fields.name);
  if (fields.email !== undefined) out.email = String(fields.email);
  if (fields.mobile !== undefined) out.mobile = String(fields.mobile);
  if (fields.bankId !== undefined) out.bank_id = String(fields.bankId);
  if (fields.accountNumber !== undefined) out.account_number = String(fields.accountNumber);
  if (fields.logo !== undefined) out.logo = String(fields.logo);
  if (fields.description) out.description = String(fields.description).slice(0, 1000);
  return out;
}

function normaliseBusiness(data) {
  const row = data && (data.business || data);
  return {
    id: row && row.id ? String(row.id) : null,
    apiKey: row && (row.api_key || row.apiKey) ? String(row.api_key || row.apiKey) : null,
    email: row && row.email ? String(row.email) : null,
    bankName: row && row.bank_name || null,
    bankCode: row && row.bank_code || null,
    accountNumber: row && row.account_number || null,
    active: row && row.is_active !== undefined ? Boolean(row.is_active) : true,
  };
}

/** Creates a child business under the platform account. Returns its API key. */
async function createBusiness(fields) {
  const created = normaliseBusiness(await platformRequest('POST', '/businesses', businessPayload(fields)));
  if (!created.id || !created.apiKey) throw new Error('Tuma created the business but did not return its API key.');
  return created;
}

async function updateBusiness(id, fields) {
  return normaliseBusiness(await platformRequest('PUT', `/businesses/${encodeURIComponent(id)}`, businessPayload(fields)));
}

function safeEqualCallbackKey(value) {
  const supplied = Buffer.from(String(value || ''));
  const expected = Buffer.from(callbackSecret);
  return Boolean(callbackSecret) && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function callbackAuthorized(value) {
  return safeEqualCallbackKey(value);
}

module.exports = {
  configured, credentialsConfigured, callbackConfigured, configurationStatus, callbackUrl, accessToken, forgetToken, stkPush, verify,
  callbackAuthorized, banks, createBusiness, updateBusiness, normaliseBank,
};

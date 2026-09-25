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
const tokenCache = { value: '', expiresAt: 0 };

function configured() {
  return email.length > 3 && apiKey.length >= 16 && callbackSecret.length >= 24;
}

function callbackUrl(publicUrl) {
  const base = String(publicUrl || '').replace(/\/$/, '') + '/api/tuma/callback';
  return `${base}?key=${encodeURIComponent(callbackSecret)}`;
}

async function accessToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now()) return tokenCache.value;
  if (!configured()) throw new Error('Tuma credentials are not configured on this deployment.');
  const response = await fetch(`${baseUrl}/auth/token`, {
    signal: AbortSignal.timeout(15000), method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, api_key: apiKey }),
  });
  const body = await response.json().catch(() => ({}));
  // Tuma's documented auth response returns `token` at the top level. Keep
  // the nested form as a compatibility fallback for older API deployments.
  const token = body && (body.token || (body.data && body.data.token));
  if (!response.ok || !token) throw new Error(body.message || `Tuma authentication failed (${response.status}).`);
  // Tuma tokens are normally about 24 hours. Keep a conservative one-hour
  // cache so a deployment never races an expiring token.
  tokenCache.value = token;
  tokenCache.expiresAt = Date.now() + 55 * 60 * 1000;
  return token;
}

async function stkPush({ phone, amount, description, publicUrl }) {
  const token = await accessToken();
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

async function verify() {
  await accessToken();
  return true;
}

function safeEqualCallbackKey(value) {
  const supplied = Buffer.from(String(value || ''));
  const expected = Buffer.from(callbackSecret);
  return Boolean(callbackSecret) && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function callbackAuthorized(value) {
  return safeEqualCallbackKey(value);
}

module.exports = { configured, callbackUrl, accessToken, stkPush, verify, callbackAuthorized };

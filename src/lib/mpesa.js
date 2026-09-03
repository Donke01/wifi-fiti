const config = require('../config');

const { baseUrl, consumerKey, consumerSecret, shortcode, passkey } =
  config.mpesa;

/* ------------------------------------------------------------------ */
/* Phone numbers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Daraja only accepts 2547XXXXXXXX / 2541XXXXXXXX. Everything a human
 * might type has to be funnelled into that shape before it leaves here.
 * Returns null if it isn't a plausible Kenyan mobile number.
 */
function normalizePhone(input) {
  if (!input) return null;
  let d = String(input).replace(/\D/g, '');

  if (d.startsWith('254')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);

  // Safaricom, Airtel and Telkom mobile ranges are 7XXXXXXXX and 1XXXXXXXX
  if (!/^[71]\d{8}$/.test(d)) return null;
  return '254' + d;
}

/** 0712 345 678 - friendlier to show back to the user than 254712345678 */
function displayPhone(msisdn) {
  const local = '0' + msisdn.slice(3);
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
    'base64'
  );

  const res = await fetch(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${basic}` } }
  );

  if (!res.ok) {
    throw new Error(
      `Daraja auth failed (${res.status}): ${await res.text()}`
    );
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Daraja auth returned no access_token');
  }

  // Token lives ~3599s. Expire ours early so we never race the boundary.
  const ttl = Number(data.expires_in || 3599);
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + (ttl - 120) * 1000,
  };

  return tokenCache.value;
}

/* ------------------------------------------------------------------ */
/* STK Push                                                            */
/* ------------------------------------------------------------------ */

/** Daraja checks the timestamp against Nairobi time, not UTC. */
function timestamp() {
  const nairobi = new Date(Date.now() + 3 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    nairobi.getUTCFullYear() +
    p(nairobi.getUTCMonth() + 1) +
    p(nairobi.getUTCDate()) +
    p(nairobi.getUTCHours()) +
    p(nairobi.getUTCMinutes()) +
    p(nairobi.getUTCSeconds())
  );
}

function buildPassword(ts) {
  return Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
}

async function stkPush({ phone, amount, accountReference, description }) {
  const token = await getAccessToken();
  const ts = timestamp();

  const payload = {
    BusinessShortCode: shortcode,
    Password: buildPassword(ts),
    Timestamp: ts,
    TransactionType: config.mpesa.transactionType,
    Amount: Math.round(amount), // Daraja rejects decimals
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: `${config.publicUrl}/api/mpesa/callback`,
    AccountReference: String(accountReference).slice(0, 12),
    TransactionDesc: String(description).slice(0, 13),
  };

  const res = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.ResponseCode !== '0') {
    const err = new Error(
      data.errorMessage || data.ResponseDescription || 'STK push rejected'
    );
    err.daraja = data;
    throw err;
  }

  return {
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
  };
}

/* ------------------------------------------------------------------ */
/* STK Query - the safety net for lost callbacks                       */
/* ------------------------------------------------------------------ */

async function stkQuery(checkoutRequestId) {
  const token = await getAccessToken();
  const ts = timestamp();

  const res = await fetch(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: buildPassword(ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    }),
  });

  const data = await res.json().catch(() => ({}));

  // ResultCode 1032 = cancelled by user, 1037 = timeout/unreachable,
  // 0 = success. While still in flight Daraja answers with an
  // errorCode of 500.001.1001 ("transaction is being processed").
  return {
    raw: data,
    settled: data.ResultCode !== undefined,
    resultCode: data.ResultCode !== undefined ? Number(data.ResultCode) : null,
    resultDesc: data.ResultDesc || data.errorMessage || null,
  };
}

/* ------------------------------------------------------------------ */
/* Callback parsing                                                    */
/* ------------------------------------------------------------------ */

function parseCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return null;

  const items = cb.CallbackMetadata?.Item || [];
  const pick = (name) => items.find((i) => i.Name === name)?.Value;

  return {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDesc: cb.ResultDesc,
    amount: pick('Amount'),
    receipt: pick('MpesaReceiptNumber'),
    phone: pick('PhoneNumber'),
    transactionDate: pick('TransactionDate'),
  };
}

module.exports = {
  normalizePhone,
  displayPhone,
  stkPush,
  stkQuery,
  parseCallback,
};

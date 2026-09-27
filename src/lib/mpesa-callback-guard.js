'use strict';

/**
 * Safaricom does not sign M-Pesa callbacks. A callback is only trusted when
 * it arrives on a URL that carries a secret token (preferred), or, for URLs
 * registered before tokens existed, when it comes from one of Safaricom's
 * published callback addresses.
 *
 * MPESA_CALLBACK_IPS replaces the default list (comma separated), so an
 * operator can follow Safaricom if its addresses change without a deploy.
 */
const SAFARICOM_CALLBACK_IPS = [
  '196.201.214.200', '196.201.214.206', '196.201.213.114', '196.201.214.207',
  '196.201.214.208', '196.201.213.44', '196.201.212.127', '196.201.212.138',
  '196.201.212.129', '196.201.212.136', '196.201.212.74', '196.201.212.69',
];

function normaliseIp(value) {
  return String(value || '').trim().replace(/^::ffff:/i, '');
}

function trustedIps(env = process.env) {
  const configured = String(env.MPESA_CALLBACK_IPS || '').split(',').map(normaliseIp).filter(Boolean);
  return new Set(configured.length ? configured : SAFARICOM_CALLBACK_IPS);
}

function fromSafaricom(req, env = process.env) {
  return trustedIps(env).has(normaliseIp(req && req.ip));
}

module.exports = { SAFARICOM_CALLBACK_IPS, fromSafaricom, normaliseIp, trustedIps };

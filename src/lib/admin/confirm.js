'use strict';

const crypto = require('crypto');

/* Every dangerous platform-admin action is confirmed with ADMIN_PASSWORD, on
 * top of the admin token. There is no fallback phrase: while ADMIN_PASSWORD
 * is unset, those actions are refused. */
function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Hashing both sides first gives equal-length buffers, so the compare takes
// the same time whatever was typed, including its length.
function adminPasswordMatches(supplied) {
  const configured = String(process.env.ADMIN_PASSWORD || '');
  if (!configured || !supplied) return false;
  return crypto.timingSafeEqual(digest(supplied), digest(configured));
}

function requireAdminPassword(req) {
  if (!process.env.ADMIN_PASSWORD) {
    const error = new Error('Admin actions are off until ADMIN_PASSWORD is set on the server.');
    error.status = 503;
    throw error;
  }
  // Older admin pages send the typed value as `confirmation`.
  const supplied = String(req.body?.adminPassword || req.headers['x-admin-password'] ||
    req.body?.confirmation || req.body?.confirmationPhrase || req.headers['x-confirmation-phrase'] || '');
  if (!adminPasswordMatches(supplied)) {
    const error = new Error('Administrator password is required.');
    error.status = 400;
    throw error;
  }
}

module.exports = { adminPasswordMatches, requireAdminPassword };

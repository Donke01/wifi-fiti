'use strict';

/**
 * Render the CA-compatible form of the current router kit.
 *
 * The compatibility kit is deliberately not a second installer. Keeping one
 * source of truth means captive-portal, payment, polling, receipt and hotspot
 * fixes cannot silently land in the normal kit but miss older RouterOS boards.
 * The only supported difference is disabling certificate verification for
 * boards whose RouterOS trust store cannot validate the HTTPS certificate.
 */
function compatibilityRouterKit(source) {
  return String(source || '')
    .replace(/check-certificate=yes/g, 'check-certificate=no')
    .replace(/tenant-router-install\.rsc/g, 'tenant-router-install-compat.rsc');
}

module.exports = { compatibilityRouterKit };

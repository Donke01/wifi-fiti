'use strict';

/*
 * Which address a PPPoE customer's pay link uses.
 *
 * A tenant's hotspot portal already has its own first-level address
 * (kitale.wififiti.co.ke), served by the Cloudflare portal gateway
 * (edge/portal-gateway). The same address can serve the PPPoE pay page:
 * kitale.wififiti.co.ke/pay/<code>/<account>. It is used only when:
 *  - the portal gateway is on (PORTAL_GATEWAY_ENABLED with its domain and
 *    secret), and
 *  - PPPOE_TENANT_ADDRESS=true, set once the Worker that also serves PPPoE
 *    pages is deployed. Until then every link stays on cloud, which keeps
 *    working, and links already sent keep working on both.
 * A router's own address comes first; otherwise the business's first router
 * with PPPoE subscribers (or its first router) that has one. With no tenant
 * address it is the cloud address, as before.
 */

const { db } = require('./db');
const config = require('../config');

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function cloudOrigin() { return String(config.domains.appUrl || config.publicUrl || '').replace(/\/$/, ''); }

function tenantAddressOn() {
  return Boolean(config.domains.portalGatewayEnabled)
    && ['1', 'true', 'on', 'yes'].includes(String(process.env.PPPOE_TENANT_ADDRESS || '').trim().toLowerCase());
}

function tenantHost({ businessId, locationId } = {}) {
  if (!tenantAddressOn()) return null;
  try {
    // tenant.js owns this table; read it only when it is there.
    const row = (locationId && db.prepare(`SELECT hostname FROM tenant_portal_domains
        WHERE location_id=? AND is_primary=1 AND status='active' LIMIT 1`).get(locationId))
      || (businessId && db.prepare(`SELECT d.hostname FROM tenant_portal_domains d JOIN locations l ON l.id=d.location_id
        WHERE l.business_id=? AND d.is_primary=1 AND d.status='active'
        ORDER BY EXISTS(SELECT 1 FROM pppoe_users u WHERE u.location_id=l.id) DESC, l.created_at, l.id LIMIT 1`).get(businessId));
    const host = row && String(row.hostname || '').toLowerCase();
    return host && HOST.test(host) ? host : null;
  } catch (_) {
    return null;
  }
}

/** https://<tenant address> when it is on and exists, else the cloud origin. */
function payOrigin(scope) {
  const host = tenantHost(scope);
  return host ? `https://${host}` : cloudOrigin();
}

module.exports = { payOrigin, tenantHost, tenantAddressOn, cloudOrigin };

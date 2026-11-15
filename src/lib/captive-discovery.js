'use strict';

// RouterOS only advertises the DHCP captive-portal option when a HotSpot
// profile has both a DNS name and a server certificate.  Keep that change
// fail-closed and explicitly per-location: using the payment portal hostname
// here would be wrong unless its certificate is installed on the router.
const DISCOVERY_TEMPLATE_VERSION = 'v3';
const DISCOVERY_ROLLBACK_TEMPLATE_VERSION = 'v4';

function listed(name, locationId) {
  const id = String(locationId || '');
  return Boolean(id) && String(process.env[name] || '').split(',').some((item) => item.trim() === id);
}

function hostname(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || raw.length > 253 || /[^a-z0-9.-]/.test(raw) || raw.includes('..')) return null;
  const labels = raw.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return raw;
}

function certificateName(value) {
  const raw = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw) ? raw : null;
}

function captiveDiscoveryForLocation(locationId) {
  const enabled = listed('FITI_CAPTIVE_DISCOVERY_V2_LOCATIONS', locationId);
  const rollback = listed('FITI_CAPTIVE_DISCOVERY_ROLLBACK_LOCATIONS', locationId);
  // A contradictory rollout is not a safe configuration. Do nothing until
  // the operator selects a single explicit state.
  if (enabled === rollback) return { mode: 'disabled', version: null };
  const dnsName = hostname(process.env.FITI_CAPTIVE_DISCOVERY_DNS_NAME);
  const certificate = certificateName(process.env.FITI_CAPTIVE_DISCOVERY_CERTIFICATE);
  if (!dnsName || !certificate) return { mode: 'disabled', version: null };
  return { mode: enabled ? 'enabled' : 'rollback', dnsName, certificate,
    // The rollback needs its own observed revision. Without it, a router that
    // previously reported v2 could make the server believe the clear action
    // had already happened and never receive it.
    version: enabled ? DISCOVERY_TEMPLATE_VERSION : DISCOVERY_ROLLBACK_TEMPLATE_VERSION };
}

module.exports = { DISCOVERY_TEMPLATE_VERSION, DISCOVERY_ROLLBACK_TEMPLATE_VERSION, captiveDiscoveryForLocation };

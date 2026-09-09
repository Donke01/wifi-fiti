const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const db = require('./lib/db');
const tenant = require('./lib/tenant');
const tenantAccess = require('./lib/tenant-access');
const tenantMpesa = require('./lib/tenant-mpesa');
const mpesa = require('./lib/mpesa');
const mikrotik = require('./lib/mikrotik');
const { fulfil } = require('./lib/fulfil');
const { validateRouterSetup, buildRouterSetup } = require('./lib/router-setup');
const { parseRouterTopology } = require('./lib/router-topology');
const { PACKAGES, findPackage } = require('./packages');

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  // Captive portal links carry RouterOS values and one-time pairing URLs can
  // carry a router credential. Do not let browsers forward either to a
  // third-party asset or destination.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ------------------------------------------------------------------ */
/* Public site / application host boundary                            */
/* ------------------------------------------------------------------ */

const publicDirectory = path.join(__dirname, '..', 'public');
const vpnGatewayDirectory = path.join(__dirname, '..', 'vpn-gateway');

// Use the raw Host header rather than req.hostname. `trust proxy` is enabled
// for Railway, so an untrusted X-Forwarded-Host must not decide whether a
// request reaches the public marketing site or the signed-in application.
function requestHost(req) {
  const value = String(req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) return value.replace(/^\[([^\]]+)](?::\d+)?$/, '$1').replace(/\.$/, '');
  return value.replace(/:\d+$/, '').replace(/\.$/, '');
}

function edgeHostname(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || raw.length > 253) return null;
  try {
    const parsed = new URL(`https://${raw}`);
    if (parsed.hostname !== raw || parsed.port || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function edgeGatewayAuthenticated(req) {
  const expected = Buffer.from(config.edgeGatewaySecret || '');
  const supplied = Buffer.from(String(req.get('X-WiFi-Fiti-Edge') || ''));
  return Boolean(expected.length && supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied));
}

function vpnGatewayAuthenticated(req) {
  if (!config.vpnGateway.enabled) return false;
  const expected = Buffer.from(config.vpnGateway.controlSecret || '');
  const supplied = Buffer.from(String(req.get('X-WiFi-Fiti-Gateway') || ''));
  return Boolean(expected.length && supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied));
}

function validWireGuardPublicKey(value) {
  const key = String(value || '').trim();
  return /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32 ? key : null;
}

function validVpnManagementAddress(value) {
  const raw = String(value || '').trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/.exec(raw);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255) || octets[0] !== 10 || octets[1] !== 254) return null;
  // 10.254.0.1 belongs to the gateway, while network/broadcast-like values
  // are never issued to routers by the allocator.
  if ((octets[2] === 0 && octets[3] === 1) || octets[3] === 0 || octets[3] === 255) return null;
  return `${octets.join('.')}/32`;
}

const MAX_VPN_GATEWAY_REPORT_ITEMS = 65_536;

function vpnGatewayReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Invalid VPN gateway report.'); error.status = 400; throw error;
  }
  const array = (value, name) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_VPN_GATEWAY_REPORT_ITEMS) {
      const error = new Error(`Invalid VPN gateway ${name}.`); error.status = 400; throw error;
    }
    return value;
  };
  const appliedPeers = array(body.appliedPeers, 'applied peers').map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      const error = new Error('Invalid VPN gateway applied peer.'); error.status = 400; throw error;
    }
    const publicKey = validWireGuardPublicKey(entry.publicKey);
    const allowedAddress = validVpnManagementAddress(entry.allowedAddress);
    if (!publicKey || !allowedAddress) {
      const error = new Error('Invalid VPN gateway applied peer.'); error.status = 400; throw error;
    }
    return { publicKey, allowedAddress };
  });
  const removedPeerKeys = array(body.removedPeerKeys, 'removed peers').map((value) => {
    const publicKey = validWireGuardPublicKey(value);
    if (!publicKey) { const error = new Error('Invalid VPN gateway removed peer.'); error.status = 400; throw error; }
    return publicKey;
  });
  const observations = array(body.observations, 'observations').flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const publicKey = validWireGuardPublicKey(entry.publicKey);
    const allowedAddress = validVpnManagementAddress(entry.allowedAddress);
    const epoch = Number(entry.lastHandshakeEpoch);
    if (!publicKey || !allowedAddress || !Number.isSafeInteger(epoch) || epoch <= 0) return [];
    return [{ publicKey, allowedAddress, lastHandshakeEpoch: epoch }];
  });
  const unique = (items, key) => {
    const seen = new Set();
    for (const item of items) {
      const value = key(item);
      if (seen.has(value)) { const error = new Error('VPN gateway report contains a duplicate peer.'); error.status = 400; throw error; }
      seen.add(value);
    }
  };
  unique(appliedPeers, (item) => item.publicKey);
  unique(removedPeerKeys, (item) => item);
  unique(observations, (item) => item.publicKey);
  const knownRevisionRaw = body.knownRevision;
  const knownRevision = knownRevisionRaw === undefined || knownRevisionRaw === null || knownRevisionRaw === ''
    ? null : String(knownRevisionRaw);
  if (knownRevision !== null && !/^[a-f0-9]{64}$/.test(knownRevision)) {
    const error = new Error('Invalid VPN gateway desired-state revision.'); error.status = 400; throw error;
  }
  return { appliedPeers, removedPeerKeys, observations, knownRevision };
}

function vpnGatewayPeerId(peer) {
  // A gateway peer id is an audit label only. It is deterministic, contains
  // no credential, and never exposes a base64 key to a restrictive ID field.
  return `wg-${crypto.createHash('sha256').update(`${peer.locationId}:${peer.configVersion}:${peer.routerPublicKey}`).digest('hex').slice(0, 32)}`;
}

function vpnGatewayDesiredSnapshot(gatewayId) {
  const peers = tenant.desiredVpnPeersForGateway({ gatewayId })
    .filter((peer) => peer.desiredState === 'active')
    .map((peer) => ({ publicKey: peer.routerPublicKey, allowedAddress: `${peer.managementAddress}/32` }))
    .sort((a, b) => a.publicKey.localeCompare(b.publicKey));
  // The agent keeps the last complete public desired set locally. A stable
  // digest means routine five-second health polls return a few bytes instead
  // of repeatedly transferring every tenant router peer.
  const revision = crypto.createHash('sha256').update(JSON.stringify(peers)).digest('hex');
  return { revision, peers };
}

function portalUrlForLocation(location) {
  const hostname = edgeHostname(location && (location.portal_hostname || location.portalHostname));
  if (config.domains.portalGatewayEnabled && hostname) return `https://${hostname}`;
  return `${config.domains.appUrl}/p/${encodeURIComponent(location.id)}`;
}

function portalUrlForRouter(location, requestedHostname) {
  const hostname = edgeHostname(requestedHostname);
  if (config.domains.portalGatewayEnabled && hostname) {
    const domain = tenant.portalDomainForLocationHostname.get(hostname, location.id);
    if (domain) return `https://${domain.hostname}`;
  }
  // Older router kits did not include a portal hostname. Preserve their
  // working cloud redirect until they are deliberately re-paired.
  return `${config.domains.appUrl}/p/${encodeURIComponent(location.id)}`;
}

/**
 * Keep a paired router's captive-login redirect aligned with the customer
 * address selected after setup. It uses a reported current host when
 * available, otherwise the known cloud host used by older kits. It creates one exact
 * walled-garden entry and refreshes login.html; it never opens an inbound
 * management service or changes a customer's network.
 *
 * The polling agent re-applies this desired address after every boot.  That
 * is deliberately safer than rewriting a router's boot script from a remote
 * response: a temporary old address after a restart is repaired on the next
 * poll, while an invalid boot-script rewrite can stop all future updates.
 */
function routerPortalRefreshScript(location, { reportedPortalAppliedHost, reportedPortalHost } = {}) {
  if (!config.domains.portalGatewayEnabled) return '';
  const desiredHost = edgeHostname(location && location.portal_hostname);
  const appliedHost = edgeHostname(reportedPortalAppliedHost);
  const legacyHost = edgeHostname(reportedPortalHost);
  if (!desiredHost) return '';
  // New pollers report portalApplied only after the replacement login file
  // was fetched. Older pollers retain compatibility when their reported
  // address already matches, without affecting router pairing readiness.
  if (appliedHost === desiredHost || (!appliedHost && legacyHost === desiredHost)) return '';
  const desiredUrl = `https://${desiredHost}`;
  return [
    ':global fitiUrl',
    ':global fitiSite',
    ':global fitiToken',
    ':global fitiPortalUrl',
    ':global fitiPortalHost',
    ':global fitiPortalAppliedHost',
    ':global fitiHotspotServer',
    ':if ([:len $fitiHotspotServer] = 0) do={ :set fitiHotspotServer "hotspot1" }',
    ':if ([:len $fitiPortalHost] = 0) do={ :set fitiPortalHost "" }',
    ':if ([:len $fitiPortalAppliedHost] = 0) do={ :set fitiPortalAppliedHost "" }',
    `:local fitiDesiredPortalHost "${desiredHost}"`,
    `:local fitiDesiredPortalUrl "${desiredUrl}"`,
    ':if ($fitiPortalAppliedHost != $fitiDesiredPortalHost) do={',
    '  :if ([:len [/ip hotspot walled-garden find where dst-host=$fitiDesiredPortalHost]] = 0) do={ /ip hotspot walled-garden add dst-host=$fitiDesiredPortalHost comment="WiFi Fiti customer portal" }',
    '  :if ([:len [/ip hotspot find where name=$fitiHotspotServer]] = 1) do={',
    '    :local fitiProfile [/ip hotspot get [find where name=$fitiHotspotServer] profile]',
    '    :local fitiHtmlDir [/ip hotspot profile get [find where name=$fitiProfile] html-directory]',
    '    :if ([:len $fitiHtmlDir] = 0) do={ :set fitiHtmlDir "hotspot" }',
    '    :local fitiLoginUrl ($fitiUrl . "/api/tenant/" . $fitiSite . "/router-login?portal=" . $fitiDesiredPortalHost)',
    '    :do {',
    '      /tool fetch url=$fitiLoginUrl check-certificate=yes http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) dst-path=($fitiHtmlDir . "/login.html")',
    '      :set fitiPortalHost $fitiDesiredPortalHost',
    '      :set fitiPortalUrl $fitiDesiredPortalUrl',
    '      :set fitiPortalAppliedHost $fitiDesiredPortalHost',
    '      :log info "fiti: customer portal address updated"',
    '    } on-error={ :log warning "fiti: customer portal login page download failed" }',
    '  } else={ :log warning "fiti: customer portal update skipped; Hotspot server was not found" }',
    '}',
  ].join('\n') + '\n';
}

function edgePortalOriginForRequest(req, location) {
  const host = requestHost(req);
  if (host !== config.domains.appHost && !localDevelopmentHost(host)) return null;
  if (!edgeGatewayAuthenticated(req)) return null;
  const hostname = edgeHostname(req.get('X-WiFi-Fiti-Portal-Host'));
  if (!hostname) return null;
  const domain = tenant.portalDomainForLocationHostname.get(hostname, location.id);
  return domain ? `https://${domain.hostname}` : null;
}

function localDevelopmentHost(host) {
  // A developer can still run the service directly at localhost. A LAN test
  // should set APP_URL to that LAN address instead of relying on an arbitrary
  // Host header, which keeps production's named-host boundary meaningful.
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

function legacyPortalRequest(req) {
  // A legacy Hotspot redirect always contains RouterOS identity values. Keep
  // it working on the former application root while a normal human visit sees
  // the public WiFi Fiti Business site.
  const search = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
  return /(?:^|&)(?:mac|ip|link-login-only|link-orig|error)=/i.test(search);
}

function sendLegacyPortal(res) {
  return res.sendFile(path.join(publicDirectory, 'index.html'));
}

function redirectToApp(req, res) {
  // Marketing links never need to carry a router MAC, portal capability or
  // other query value across hostnames. Only redirect the small public set of
  // dashboard paths below, and deliberately drop any supplied query string.
  return res.redirect(302, config.domains.appUrl + req.path);
}

app.use((req, res, next) => {
  const host = requestHost(req);
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  res.vary('Host');

  // The production marketing site uses the root domain. Until every old
  // router has moved to app, that same host must retain only the legacy
  // portal/API routes it needs. This makes ordinary root visits public while
  // preventing an old RouterOS login or M-Pesa callback from breaking.
  const servesSeparateMarketingHost =
    host === config.domains.marketingHost && host !== config.domains.appHost;
  if (servesSeparateMarketingHost) {
    const keepsLegacyCompatibility = host === config.domains.legacyHost;
    if (isGet && (req.path === '/' || req.path === '/index.html')) {
      if (legacyPortalRequest(req)) {
        if (!keepsLegacyCompatibility) return res.status(404).type('text/plain').send('Not found.');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        return sendLegacyPortal(res);
      }
      return res.sendFile(path.join(publicDirectory, 'marketing.html'));
    }
    if (isGet && req.path === '/marketing.html') {
      return res.sendFile(path.join(publicDirectory, 'marketing.html'));
    }
    // The public landing lives at the root; the original dashboard and
    // operations pages have moved to app.
    if (isGet && (req.path === '/business.html' || req.path === '/operations.html')) {
      return redirectToApp(req, res);
    }
    if (isGet && (req.path === '/legacy' || req.path === '/legacy/')) {
      if (!keepsLegacyCompatibility) return redirectToApp(req, res);
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return sendLegacyPortal(res);
    }
    // Keep the narrow set of paths used by older routers and outstanding
    // payment flows while the router-by-router migration is underway.
    if (req.path.startsWith('/api/') || req.path.startsWith('/p/')) {
      if (!keepsLegacyCompatibility) return res.status(404).type('text/plain').send('Not found.');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return next();
    }
    if (isGet && /^\/assets\/[A-Za-z0-9._-]+$/.test(req.path)) return next();
    return res.status(404).type('text/plain').send('Not found.');
  }

  if (host === config.domains.appHost) {
    if (req.path === '/' || req.path === '/index.html') {
      if (legacyPortalRequest(req)) return sendLegacyPortal(res);
      return res.redirect(302, '/business.html');
    }
    if (req.path === '/legacy' || req.path === '/legacy/') return sendLegacyPortal(res);
    if (req.path === '/marketing.html') return res.redirect(302, config.domains.marketingUrl);
    // The app host is the full runtime: dashboard, customer portals, M-Pesa
    // callbacks, and outbound router polling all continue to its routes.
    // If an old/staging setup intentionally has app and legacy on one host,
    // fall through so that compatibility branch can apply its headers.
    if (host !== config.domains.legacyHost) return next();
  }

  // The legacy host only differs from the marketing host in a transitional or
  // staging configuration. Keep it available for routers and callbacks there.
  if (host === config.domains.legacyHost) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    // Business users should land on app even if they follow an old bookmark.
    // Keep portal and API paths here because existing routers still use them.
    // In a local or transitional single-host deployment the app and legacy
    // names may intentionally be identical. Redirecting a business page in
    // that case would point straight back to itself forever.
    if (host !== config.domains.appHost && isGet && (req.path === '/business.html' || req.path === '/operations.html')) return redirectToApp(req, res);
    return next();
  }

  // Do not expose the live portal, dashboard, payment callbacks, or router
  // API through Railway's generated URL or an arbitrary attached hostname.
  // Localhost remains useful for development; LAN testing should configure
  // that LAN name/address as APP_URL explicitly.
  if (localDevelopmentHost(host)) return next();
  return res.status(421).type('text/plain').send('Misdirected request.');
});

// The router's usage report must be parsed as raw text, and this has to
// be registered BEFORE the JSON/urlencoded parsers below. RouterOS sends
// it as application/x-www-form-urlencoded, so urlencoded() would claim it
// first, hand back a null-prototype object, and mark the body as handled -
// after which String(req.body) throws "Cannot convert object to primitive
// value" and every sync 500s. This comes after host routing so rejected
// hostnames never spend work parsing application-only requests.
app.use('/api/router/sync', express.text({ type: '*/*', limit: '64kb' }));
// Optional remote-support enrollment is also RouterOS plain text. Keep it
// ahead of urlencoded(), which otherwise consumes RouterOS fetch payloads
// before the exact versioned report can be validated.
app.use('/api/router/support-enroll', express.text({ type: '*/*', limit: '2kb' }));
// The self-hosted VPN gateway is the only trusted machine that needs a
// larger, peer-state JSON report. Register its parser before the normal API
// parser so an intentionally bounded gateway snapshot does not share the
// small browser-body limit used by payment and dashboard requests.
app.use('/api/internal/vpn-gateways', express.json({ limit: '4mb' }));
// Brand logos are stored on the persistent volume and are deliberately kept
// separate from the small JSON bodies used by payment and router endpoints.
app.use('/api/business/branding/logo', express.json({ limit: '520kb' }));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(publicDirectory));

// This repository is intentionally private, so a new VPS cannot rely on a
// public raw-GitHub URL to retrieve its non-secret management agent. Serve the
// immutable-on-deploy agent and unit from the already trusted application host
// instead. These files contain no router credential, private key, or gateway
// secret; the secret is supplied separately in the VPS environment file.
function sendVpnGatewayBootstrap(res, filename, type) {
  res.setHeader('Cache-Control', 'no-store');
  res.type(type);
  return res.sendFile(path.join(vpnGatewayDirectory, filename));
}

app.get('/vpn-gateway/agent.js', (req, res) => sendVpnGatewayBootstrap(res, 'agent.js', 'application/javascript'));
app.get('/vpn-gateway/wifi-fiti-vpn-agent.service', (req, res) =>
  sendVpnGatewayBootstrap(res, 'wifi-fiti-vpn-agent.service', 'text/plain')
);

// Limit credential guessing and payment-prompt abuse with a persisted
// window. A service restart must not reset these limits.
app.use((req, res, next) => {
  const path = req.path;
  let key, maximum, windowMs;
  if (path === '/api/business/login' || path === '/api/business/register') {
    key = path + ':' + req.ip;
    maximum = path.endsWith('register') ? 20 : 50;
    windowMs = 15 * 60_000;
  } else if (path.startsWith('/api/admin/')) {
    // The platform desk is token-protected, but bound its guessing surface
    // as well. This leaves room for an operator to refresh the desk without
    // allowing unlimited token attempts from one address.
    key = '/api/admin:' + req.ip;
    maximum = 30;
    windowMs = 5 * 60_000;
  } else if (req.method === 'POST' && path.startsWith('/api/tenant/')) {
    const identity = String(req.body && (req.body.phone || req.body.subscriptionId || req.body.mac) || '').slice(0, 100);
    key = path + ':' + req.ip + ':' + identity;
    maximum = path.endsWith('/pay') ? 12 : 40;
    windowMs = 5 * 60_000;
  }
  if (key) {
    const limit = tenantAccess.allowed(key, maximum, windowMs);
    if (!limit.allowed) return res.status(429).set('Retry-After', String(limit.retryAfter))
      .json({ error: 'Too many attempts. Please wait a few minutes before trying again.' });
  }
  next();
});
setInterval(() => tenantAccess.purge(), 60 * 60_000).unref();

/* ------------------------------------------------------------------ */
/* Throttle                                                            */
/* ------------------------------------------------------------------ */

/**
 * Safaricom will not process two STK prompts for the same phone at once,
 * and hammering the endpoint gets your app flagged. In-memory is fine -
 * a restart clearing the window is harmless.
 */
const lastPush = new Map();
const PUSH_COOLDOWN_MS = 30_000;

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, t] of lastPush) if (t < cutoff) lastPush.delete(k);
}, 60_000).unref();

/* ------------------------------------------------------------------ */
/* Commercial business onboarding                                     */
/* ------------------------------------------------------------------ */

function businessId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${digest}`;
}

function passwordMatches(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function issueBusinessSession(businessId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.addBusinessSession.run({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    businessId,
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
  });
  return token;
}

function businessAuth(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'Please sign in.' }); return null; }
  const business = db.businessForSession.get(crypto.createHash('sha256').update(token).digest('hex'));
  if (!business) { res.status(401).json({ error: 'Your session has expired. Please sign in again.' }); return null; }
  return business;
}

const logoDirectory = path.join(path.dirname(path.resolve(config.databasePath)), 'tenant-logos');
const logoTypes = {
  'image/png': { extension: 'png', valid: (value) => value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { extension: 'jpg', valid: (value) => value.length >= 4 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff },
  'image/webp': { extension: 'webp', valid: (value) => value.length >= 12 && value.subarray(0, 4).equals(Buffer.from('RIFF')) && value.subarray(8, 12).equals(Buffer.from('WEBP')) },
};

function portalText(value, label, max, required = false) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !text) throw Object.assign(new Error(`Enter ${label}.`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${label} is too long.`), { status: 400 });
  return text || null;
}

function primaryColor(value) {
  const color = String(value || '').trim().toUpperCase();
  if (!color) return null;
  if (!/^#[0-9A-F]{6}$/.test(color)) throw Object.assign(new Error('Choose a valid six-digit brand colour.'), { status: 400 });
  return color;
}

function brandingPayload(business, { assetOrigin = config.domains.appUrl } = {}) {
  const logo = business && business.brand_logo_path;
  return {
    name: business && (business.portal_name || business.name) || config.brandName,
    supportPhone: business && business.support_phone || config.supportPhone || '',
    primaryColor: business && /^#[0-9A-Fa-f]{6}$/.test(String(business.brand_primary_color || '')) ? business.brand_primary_color.toUpperCase() : null,
    message: business && business.portal_message || '',
    logoUrl: logo && business && business.id
      ? `${assetOrigin}/media/logo/${encodeURIComponent(business.id)}?v=${encodeURIComponent(logo)}`
      : null,
  };
}

function decodeLogo(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!match || !logoTypes[match[1]]) throw Object.assign(new Error('Upload a PNG, JPEG, or WebP logo.'), { status: 400 });
  const data = Buffer.from(match[2], 'base64');
  if (data.length < 16 || data.length > 360 * 1024 || !logoTypes[match[1]].valid(data)) {
    throw Object.assign(new Error('Logo file is invalid or larger than 360 KB.'), { status: 400 });
  }
  return { data, ...logoTypes[match[1]] };
}

app.get('/media/logo/:businessId', (req, res) => {
  const id = String(req.params.businessId || '');
  if (!/^biz-[a-f0-9]{16}$/.test(id)) return res.status(404).type('text/plain').send('Not found.');
  const business = db.businessBrandingById.get(id);
  const filename = business && String(business.brand_logo_path || '');
  if (!filename || !/^biz-[a-f0-9]{16}-[a-f0-9]{16}\.(?:png|jpg|webp)$/.test(filename)) {
    return res.status(404).type('text/plain').send('Not found.');
  }
  const file = path.resolve(logoDirectory, filename);
  if (!file.startsWith(logoDirectory + path.sep) || !fs.existsSync(file)) return res.status(404).type('text/plain').send('Not found.');
  const type = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.jpg') ? 'image/jpeg' : 'image/webp';
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type(type).sendFile(file);
});

const BUSINESS_PLANS = {
  starter: { name: 'Starter', monthlyKes: 1500, routerLimit: 2, activeDeviceLimit: 2000 },
  growth: { name: 'Growth', monthlyKes: 3500, routerLimit: 5, activeDeviceLimit: 5000 },
  custom: { name: 'Custom', monthlyKes: null, routerLimit: null, activeDeviceLimit: null },
};

function validBusinessPlan(plan, collectionMode) {
  return BUSINESS_PLANS[plan] && ['own', 'fiti'].includes(collectionMode);
}

function textField(value, label, max, required = false) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !text) throw Object.assign(new Error(`Enter ${label}.`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${label} is too long.`), { status: 400 });
  return text;
}

function organisationIsComplete(business) {
  return Boolean(
    business &&
    String(business.onboarding_state || 'complete') !== 'organisation' &&
    String(business.name || '').trim() &&
    mpesa.normalizePhone(business.owner_phone)
  );
}

function onboardingState(business, locations = []) {
  const organisationComplete = organisationIsComplete(business);
  return {
    organisationComplete,
    hotspotName: business && business.hotspot_name || null,
    nextStep: !organisationComplete ? 'organisation' : !locations.length ? 'router' : 'setup',
  };
}

function requireOrganisation(business, res) {
  if (organisationIsComplete(business)) return true;
  res.status(409).json({ error: 'Create your organisation before adding a router.' });
  return false;
}

function locationDraftInput(body, { routerNameRequired = false } = {}) {
  const source = body || {};
  const location = textField(source.location === undefined
    ? (source.locationName === undefined ? source.name : source.locationName)
    : source.location, 'a location', 80, true);
  const routerName = textField(source.routerName === undefined ? source.router : source.routerName,
    'a router name', 80, routerNameRequired);
  return { location, routerName: routerName || null };
}

function canAddLocation(business, res) {
  const plan = BUSINESS_PLANS[business.plan];
  const existing = tenant.locationsForBusiness.all(business.id);
  if (plan.routerLimit && existing.length >= plan.routerLimit) {
    res.status(402).json({
      error: `${plan.name} includes ${plan.routerLimit} router${plan.routerLimit === 1 ? '' : 's'}. Choose a larger plan before adding another location.`,
    });
    return false;
  }
  return true;
}

function createLocationDraft(business, body, res, { routerNameRequired = false } = {}) {
  const { location: name, routerName } = locationDraftInput(body, { routerNameRequired });
  if (!canAddLocation(business, res)) return null;
  const location = tenant.createLocation({ id: businessId('loc'), businessId: business.id, name, routerName });
  return { location, portalUrl: portalUrlForLocation(location), coreUrl: config.domains.appUrl };
}

app.post('/api/business/register', (req, res) => {
  const body = req.body || {};
  const rawName = String(body.name || '').trim();
  const rawOwnerName = String(body.ownerName || '').trim();
  const rawPhone = String(body.phone || '').trim();
  const rawHotspotName = String(body.hotspotName === undefined ? '' : body.hotspotName).trim();
  const hasOrganisationFields = Boolean(rawName || rawOwnerName || rawPhone || rawHotspotName);
  const name = rawName.slice(0, 80);
  const ownerName = rawOwnerName.slice(0, 80);
  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const ownerPhone = mpesa.normalizePhone(rawPhone);
  const password = String(req.body && req.body.password || '');
  const plan = String(req.body && req.body.plan || 'starter');
  const collectionMode = String(req.body && req.body.collectionMode || 'own');
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
    return res.status(400).json({ error: 'Enter a valid email and an 8-character password.' });
  }
  if (hasOrganisationFields && (!name || !ownerName || !ownerPhone)) {
    return res.status(400).json({ error: 'Enter business details, a valid email and an 8-character password.' });
  }
  if (!validBusinessPlan(plan, collectionMode)) return res.status(400).json({ error: 'Choose a valid WiFi Fiti plan.' });
  if (db.businessByEmail.get(email)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const id = businessId('biz');
  const registrationIsComplete = hasOrganisationFields;
  try {
    db.addBusiness.run({
      id,
      // A blank, clearly marked record is safer than inventing a phone or
      // organisation name. It cannot add a router until the owner completes
      // the authenticated organisation step below.
      name: registrationIsComplete ? name : '',
      ownerName: registrationIsComplete ? ownerName : '',
      ownerPhone: registrationIsComplete ? ownerPhone : '',
      email,
      passwordHash: hashPassword(password),
      plan: plan === 'custom' ? 'starter' : plan,
      collectionMode,
      onboardingState: registrationIsComplete ? 'complete' : 'organisation',
      organisationCompletedAt: registrationIsComplete
        ? new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
        : null,
      hotspotName: rawHotspotName ? textField(rawHotspotName, 'hotspot name', 80, true) : null,
    });
    db.setBusinessTrial.run({ id, expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') });
    const token = issueBusinessSession(id);
    const business = db.businessById.get(id);
    res.status(201).json({ token, business, onboarding: onboardingState(business), requestedCustom: plan === 'custom' });
  } catch (err) {
    console.error('[business] registration failed:', err.message);
    res.status(500).json({ error: 'Could not create the business account.' });
  }
});

app.post('/api/business/login', (req, res) => {
  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const password = String(req.body && req.body.password || '');
  const business = db.businessByEmail.get(email);
  if (!business || !passwordMatches(password, business.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  const account = db.businessById.get(business.id);
  res.json({ token: issueBusinessSession(business.id), business: account,
    onboarding: onboardingState(account, tenant.locationsForBusiness.all(business.id)) });
});

app.post('/api/business/logout', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  db.db.prepare('DELETE FROM business_sessions WHERE token_hash=? AND business_id=?')
    .run(crypto.createHash('sha256').update(token).digest('hex'), business.id);
  res.json({ ok: true });
});

app.get('/api/business/me', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const locations = tenant.locationsForBusiness.all(business.id)
    .map((location) => ({
      ...location,
      remoteAccess: tenant.remoteAccessForLocation(location),
      // This is summary-only. The full non-secret inventory is available
      // through the owner-scoped topology endpoint when the mapping step is
      // open; no router credentials, addresses, traffic or VPN material is
      // ever placed in the general dashboard response.
      routerMapping: tenant.routerMappingForLocation(location),
    }));
  res.json({ business, onboarding: onboardingState(business, locations), plan: BUSINESS_PLANS[business.plan], locations, packages: db.packagesForBusiness.all(business.id),
    monthlyActiveDevices: tenant.activeMeter.get(business.id).n,
    // This is deliberately a public capability rather than configuration:
    // owners need to know whether a managed customer address can be chosen,
    // but the edge credential must never leave the server.
    portalAddressing: {
      enabled: config.domains.portalGatewayEnabled,
      rootDomain: config.domains.portalRootDomain || null,
      kind: 'managed-subdomain',
    },
    note: 'Monthly active-device usage is measured from subscriptions at paired locations.' });
});

/** Complete the organisation profile immediately after a trial account is
 * created. This intentionally happens before any router identity or setup
 * secret is issued, so a user can correct these ordinary business details
 * without a router replacement workflow. */
function saveOrganisation(req, res) {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const body = req.body || {};
    const name = textField(body.organisationName === undefined
      ? (body.organizationName === undefined ? body.name : body.organizationName)
      : body.organisationName, 'organisation name', 80, true);
    const phone = mpesa.normalizePhone(body.phone === undefined ? body.ownerPhone : body.phone);
    const hotspotName = textField(body.hotspotName === undefined ? body.hotspot_name : body.hotspotName,
      'hotspot name', 80, true);
    if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number.' });
    db.completeBusinessOrganisation.run({ id: business.id, name, ownerPhone: phone, hotspotName, portalName: name });
    const updated = db.businessById.get(business.id);
    res.json({ business: updated, onboarding: onboardingState(updated) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save your organisation.' });
  }
}

app.post('/api/business/organisation', saveOrganisation);
app.patch('/api/business/organisation', saveOrganisation);

// The Cloudflare Worker is intentionally stateless. It asks the Railway core
// to resolve a hostname rather than maintaining a second, eventually stale
// copy of tenant/location data at the edge. This endpoint never exposes a
// router token, M-Pesa credential, customer record or business session.
app.get('/api/edge/portal/resolve', (req, res) => {
  const host = requestHost(req);
  if (host !== config.domains.appHost && !localDevelopmentHost(host)) {
    return res.status(404).type('text/plain').send('Not found.');
  }
  if (!config.domains.portalGatewayEnabled || !edgeGatewayAuthenticated(req)) {
    return res.status(404).type('text/plain').send('Not found.');
  }
  const hostname = edgeHostname(req.query.host);
  const domain = hostname && tenant.portalDomainByHostname.get(hostname);
  const location = domain && tenant.locationById.get(domain.location_id);
  if (!domain || !location) return res.status(404).type('text/plain').send('Not found.');
  res.json({ hostname: domain.hostname, locationId: location.id, businessId: location.business_id });
});

/** Customer-facing portal identity. Branding remains in the cloud rather
 * than on a router, so logo delivery is reliable behind a captive portal. */
app.patch('/api/business/branding', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const body = req.body || {};
    const portalName = portalText(body.portalName === undefined ? (business.portal_name || business.name) : body.portalName, 'customer-facing business name', 80, true);
    const supportRaw = String(body.supportPhone === undefined ? business.support_phone || '' : body.supportPhone || '').trim();
    const supportPhone = supportRaw ? mpesa.normalizePhone(supportRaw) : null;
    if (supportRaw && !supportPhone) return res.status(400).json({ error: 'Enter a valid Kenyan support phone number, or leave it blank.' });
    const color = primaryColor(body.primaryColor === undefined ? business.brand_primary_color : body.primaryColor);
    const message = portalText(body.portalMessage === undefined ? business.portal_message : body.portalMessage, 'portal message', 120);
    db.updateBusinessBranding.run({ id: business.id, portalName, supportPhone, primaryColor: color, portalMessage: message });
    const updated = db.businessById.get(business.id);
    res.json({ business: updated, branding: brandingPayload(updated) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save portal branding.' });
  }
});

/**
 * The first customer-facing screen is intentionally completed only after a
 * router has checked in. This keeps a new owner on one clear path: connect
 * the router first, then choose the address customers will see.
 */
app.post('/api/business/onboarding/customer-portal', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const body = req.body || {};
    const locationId = String(body.locationId || '').trim();
    const currentLocation = tenant.locationForBusiness.get(locationId, business.id);
    if (!currentLocation) return res.status(404).json({ error: 'Router location not found.' });
    if (!currentLocation.last_successful_sync_at || currentLocation.router_pairing_pending) {
      return res.status(409).json({ error: 'Finish router setup before choosing the customer portal address.' });
    }
    const portalName = portalText(body.portalName === undefined ? (business.portal_name || business.name) : body.portalName,
      'customer-facing business name', 80, true);
    const supportRaw = String(body.supportPhone === undefined ? business.support_phone || '' : body.supportPhone || '').trim();
    const supportPhone = supportRaw ? mpesa.normalizePhone(supportRaw) : null;
    if (supportRaw && !supportPhone) return res.status(400).json({ error: 'Enter a valid Kenyan support phone number, or leave it blank.' });

    let location = currentLocation;
    if (config.domains.portalGatewayEnabled) {
      const slug = String(body.portalSlug || '').trim().toLowerCase();
      if (!slug) return res.status(400).json({ error: 'Choose a customer portal address.' });
      if (tenant.managedPortalSlugReserved(slug)) return res.status(400).json({ error: 'Choose a different customer portal address.' });
      location = tenant.setManagedPortalHostname({ locationId: currentLocation.id, businessId: business.id, slug });
    }

    db.updateBusinessBranding.run({
      id: business.id,
      portalName,
      supportPhone,
      primaryColor: primaryColor(business.brand_primary_color),
      portalMessage: portalText(business.portal_message, 'portal message', 120),
    });
    db.completeBusinessPortalSetup.run({ id: business.id });
    db.completeLocationPortalSetup.run({ id: location.id, businessId: business.id });
    location = tenant.locationForBusiness.get(location.id, business.id);
    const updated = db.businessById.get(business.id);
    res.json({ business: updated, location, portalUrl: portalUrlForLocation(location) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save the customer portal.' });
  }
});

app.post('/api/business/branding/logo', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const logo = decodeLogo(req.body && req.body.dataUrl);
    fs.mkdirSync(logoDirectory, { recursive: true, mode: 0o700 });
    const filename = `${business.id}-${crypto.randomBytes(8).toString('hex')}.${logo.extension}`;
    const temporary = path.join(logoDirectory, `.${filename}.upload`);
    const destination = path.join(logoDirectory, filename);
    fs.writeFileSync(temporary, logo.data, { mode: 0o600 });
    fs.renameSync(temporary, destination);
    db.setBusinessLogo.run({ id: business.id, brandLogoPath: filename });
    const updated = db.businessById.get(business.id);
    res.status(201).json({ business: updated, branding: brandingPayload(updated) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save the logo.' });
  }
});

app.post('/api/business/billing-plan', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const plan = String(req.body && req.body.plan || '');
  const collectionMode = String(req.body && req.body.collectionMode || '');
  if (!validBusinessPlan(plan, collectionMode)) return res.status(400).json({ error: 'Choose a valid plan.' });
  // Changing collection mode is immediate. Changing the paid platform plan
  // is completed only after the monthly M-Pesa checkout below settles.
  if (plan !== business.plan && plan !== 'custom') {
    db.setBusinessPlan.run({ id: business.id, plan: business.plan, collectionMode });
    return res.json({ plan: BUSINESS_PLANS[business.plan], collectionMode,
      checkoutRequired: true, requestedPlan: plan, amount: BUSINESS_PLANS[plan].monthlyKes });
  }
  if (plan === 'custom') {
    db.setBusinessPlan.run({ id: business.id, plan: business.plan, collectionMode });
    return res.json({ plan: BUSINESS_PLANS[business.plan], collectionMode,
      contactRequired: true, requestedPlan: 'custom' });
  }
  db.setBusinessPlan.run({ id: business.id, plan, collectionMode });
  res.json({ plan: BUSINESS_PLANS[plan], collectionMode });
});

app.post('/api/business/billing/checkout', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const plan = String(req.body && req.body.plan || business.plan);
  const definition = BUSINESS_PLANS[plan];
  const phone = mpesa.normalizePhone(req.body && req.body.phone || business.owner_phone);
  if (!definition || !definition.monthlyKes) return res.status(400).json({ error: 'Custom plans are arranged with WiFi Fiti directly.' });
  if (!phone) return res.status(400).json({ error: 'Enter the M-Pesa number that should pay for this plan.' });
  if (definition.routerLimit && tenant.locationsForBusiness.all(business.id).length > definition.routerLimit) {
    return res.status(409).json({ error: 'This plan does not cover your existing routers. Choose a plan with enough router capacity.' });
  }
  const pending = db.db.prepare(`SELECT checkout_request_id FROM business_billing_transactions
    WHERE business_id=? AND status='pending' AND created_at>datetime('now','-3 minutes')
    ORDER BY created_at DESC LIMIT 1`).get(business.id);
  if (pending) return res.status(409).json({ error: 'Your previous plan payment is still processing. Check its status before sending another request.' });
  const throttleKey = `platform:${business.id}:${phone}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) return res.status(429).json({ error: 'A plan payment request is already on its way. Please wait a moment.' });
  try {
    lastPush.set(throttleKey, Date.now());
    const pushed = await mpesa.stkPush({ phone, amount: definition.monthlyKes,
      accountReference: `WF-${plan}`, description: `${definition.name} plan` });
    tenant.insertBusinessBilling.run({ checkoutRequestId: pushed.checkoutRequestId,
      merchantRequestId: pushed.merchantRequestId, businessId: business.id, plan, phone, amount: definition.monthlyKes });
    res.json({ checkoutRequestId: pushed.checkoutRequestId, plan, amount: definition.monthlyKes,
      phoneDisplay: mpesa.displayPhone(phone) });
  } catch (err) {
    lastPush.delete(throttleKey);
    console.error('[business billing] STK push failed:', err.message);
    res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});

async function queryBusinessBillingNow(transaction) {
  const age = Date.now() - new Date(transaction.created_at + 'Z').getTime();
  if (!Number.isFinite(age) || age < QUERY_AFTER_MS) return transaction;
  const last = lastQueryAt.get(transaction.checkout_request_id) || 0;
  if (Date.now() - last < QUERY_EVERY_MS) return transaction;
  lastQueryAt.set(transaction.checkout_request_id, Date.now());
  try {
    const result = await mpesa.stkQuery(transaction.checkout_request_id);
    if (!result.settled) return transaction;
    if (result.resultCode === 0) {
      tenant.setBusinessBillingResult.run({ checkoutRequestId: transaction.checkout_request_id,
        status: 'paid', resultCode: 0, resultDesc: result.resultDesc, receipt: null });
      tenant.activateBusinessBilling(transaction.checkout_request_id);
    } else if (age >= QUERY_FAILURE_AFTER_MS) {
      tenant.setBusinessBillingResult.run({ checkoutRequestId: transaction.checkout_request_id,
        status: 'failed', resultCode: result.resultCode, resultDesc: result.resultDesc, receipt: null });
    }
  } catch (err) {
    console.warn(`[business billing] query failed for ${transaction.checkout_request_id}: ${err.message}`);
  }
  return tenant.businessBillingTransaction.get(transaction.checkout_request_id);
}

app.get('/api/business/billing/status/:checkoutRequestId', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  let transaction = tenant.businessBillingTransaction.get(req.params.checkoutRequestId);
  if (!transaction || transaction.business_id !== business.id) return res.status(404).json({ error: 'Plan payment not found.' });
  if (transaction.status === 'pending') transaction = await queryBusinessBillingNow(transaction);
  if (transaction.status === 'paid') {
    try { tenant.activateBusinessBilling(transaction.checkout_request_id); }
    catch (err) { console.error('[business billing] activation failed:', err.message); }
  }
  transaction = tenant.businessBillingTransaction.get(transaction.checkout_request_id);
  res.json({ status: transaction.status === 'paid' && !transaction.activated ? 'pending' : transaction.status, plan: transaction.plan, amount: transaction.amount,
    expiresAt: transaction.status === 'paid' ? db.businessById.get(business.id).billing_expires_at : null,
    reason: transaction.status === 'failed' ? friendlyFailure(transaction.result_code, transaction.result_desc) : null });
});

app.get('/api/business/billing/recover', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const transaction = db.db.prepare(`SELECT * FROM business_billing_transactions
    WHERE business_id=? AND ((status='pending' AND created_at>datetime('now','-2 hours'))
      OR (status!='pending' AND updated_at>datetime('now','-30 minutes')))
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(business.id);
  if (!transaction) return res.json({ found: false });
  res.json({ found: true, checkoutRequestId: transaction.checkout_request_id,
    plan: transaction.plan, amount: transaction.amount, phoneDisplay: mpesa.displayPhone(transaction.phone),
    status: transaction.status === 'paid' && !transaction.activated ? 'pending' : transaction.status,
    expiresAt: transaction.activated ? business.billing_expires_at : null,
    reason: transaction.status === 'failed' ? friendlyFailure(transaction.result_code, transaction.result_desc) : null });
});

app.get('/api/business/payment-collection', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const connection = tenant.paymentConnectionSummary.get(business.id);
  res.json({
    mode: business.collection_mode,
    configured: Boolean(connection),
    secureStorageReady: Boolean(process.env.TENANT_SECRETS_KEY),
    connection: connection ? {
      collectionName: connection.collection_name,
      shortcode: connection.shortcode,
      transactionType: connection.transaction_type,
      lastVerifiedAt: connection.last_verified_at,
    } : null,
  });
});

/** Connect a business-owned Daraja account. Credentials are verified before
 * storage and encrypted at rest; this endpoint never returns them. */
app.post('/api/business/payment-collection', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const collectionName = String(req.body && req.body.collectionName || '').trim().slice(0, 80);
  const shortcode = String(req.body && req.body.shortcode || '').trim();
  const transactionType = String(req.body && req.body.transactionType || 'CustomerPayBillOnline');
  const consumerKey = String(req.body && req.body.consumerKey || '').trim();
  const consumerSecret = String(req.body && req.body.consumerSecret || '').trim();
  const passkey = String(req.body && req.body.passkey || '').trim();
  if (!/^\d{5,12}$/.test(shortcode) || !['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'].includes(transactionType) ||
      consumerKey.length < 4 || consumerSecret.length < 4 || passkey.length < 4) {
    return res.status(400).json({ error: 'Enter valid Daraja credentials, a shortcode, and the correct transaction type.' });
  }
  if (!process.env.TENANT_SECRETS_KEY) {
    return res.status(503).json({ error: 'Secure payment storage has not been configured by WiFi Fiti yet.' });
  }
  const credentials = { shortcode, transactionType, consumerKey, consumerSecret, passkey };
  try {
    await tenantMpesa.verify(credentials);
    const connection = tenant.savePaymentConnection({ businessId: business.id, collectionName, ...credentials, verified: true });
    res.status(201).json({ configured: true, connection: {
      collectionName: connection.collection_name, shortcode: connection.shortcode,
      transactionType: connection.transaction_type, lastVerifiedAt: connection.last_verified_at,
    } });
  } catch (err) {
    console.warn(`[business payment collection] verification failed for ${business.id}: ${err.message}`);
    res.status(400).json({ error: 'M-Pesa could not verify those credentials. Check the Daraja app and try again.' });
  }
});

/** Create a location and a one-time, server-generated RouterOS setup kit.
 * The token is returned only in this response, inside the script. */
app.post('/api/business/router-setup', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  if (!requireOrganisation(business, res)) return;
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 80);
  const requestedRouterName = String(body.routerName || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Give this location a name.' });
  try {
    const setup = validateRouterSetup(body);
    if (!canAddLocation(business, res)) return;
    const location = tenant.createLocation({ id: businessId('loc'), businessId: business.id, name,
      routerName: requestedRouterName || setup.routerModel, setup });
    const portalUrl = portalUrlForLocation(location);
    const generated = buildRouterSetup({ location, token: location.routerToken, appUrl: config.domains.appUrl, portalUrl, input: body });
    res.status(201).json({
      location,
      portalUrl,
      coreUrl: config.domains.appUrl,
      setup: { mode: generated.config.mode, summary: generated.summary, warnings: generated.warnings, script: generated.script },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not create this router setup.' });
  }
});

/** Rebuild a one-time kit for an existing location. Rotating the token is
 * staged: the live router keeps working until this kit checks in. */
app.post('/api/business/locations/:locationId/router-setup', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const current = tenant.locationForBusiness.get(String(req.params.locationId), business.id);
  if (!current) return res.status(404).json({ error: 'Location not found.' });
  const body = req.body || {};
  try {
    const setup = validateRouterSetup(body);
    // A first kit for a saved draft is not replacing a live router. Ask for
    // explicit confirmation only once this location has actually checked in.
    if (['auto', 'new'].includes(setup.mode) && current.last_successful_sync_at && String(body.replaceRouter || '') !== 'yes') {
      return res.status(400).json({ error: 'Confirm that this new/reset kit is replacing the current router before generating it.' });
    }
    const name = body.name === undefined ? current.name : String(body.name || '').trim().slice(0, 80);
    const routerName = body.routerName === undefined ? current.router_name : String(body.routerName || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Give this location a name.' });
    // Keep the live router's Hotspot settings intact while the replacement
    // kit is being pasted. Both the new token and the future settings promote
    // together only after the replacement completes its receipt handshake.
    const location = tenant.stageLocationReplacement({ locationId: current.id, businessId: business.id, name, routerName,
      hotspotServer: setup.hotspotServer, setup });
    if (!location) return res.status(404).json({ error: 'Location not found.' });
    const portalUrl = portalUrlForLocation(location);
    const generated = buildRouterSetup({ location, token: location.routerToken, appUrl: config.domains.appUrl, portalUrl, input: body });
    res.json({
      location,
      portalUrl,
      coreUrl: config.domains.appUrl,
      setup: { mode: generated.config.mode, summary: generated.summary, warnings: generated.warnings, script: generated.script },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not create this router setup.' });
  }
});

app.post('/api/business/locations', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  if (!requireOrganisation(business, res)) return;
  try {
    // The first-login router dialog calls this same durable location API.
    // `location` is accepted as the plain-language field name while `name`
    // remains supported for every existing dashboard integration.
    const draft = createLocationDraft(business, req.body, res);
    if (!draft) return;
    const locations = tenant.locationsForBusiness.all(business.id);
    res.status(201).json({ ...draft, draft: true, onboarding: onboardingState(business, locations) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not add this router location.' });
  }
});

/* ------------------------------------------------------------------ */
/* Router inventory and owner-confirmed mapping                       */
/* ------------------------------------------------------------------ */

// The full snapshot is owner-scoped rather than part of a public portal or
// gateway response. It contains only validated interface/bridge/Wi-Fi/WAN
// labels; it never includes addresses, MACs, users, routes, credentials,
// security profiles, private keys or traffic data.
app.get('/api/business/locations/:locationId/router-topology', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const result = tenant.routerTopologyForBusiness({ locationId: String(req.params.locationId), businessId: business.id });
  if (!result) return res.status(404).json({ error: 'Location not found.' });
  res.json(result);
});

// Confirmation stores descriptive dashboard metadata only. The tenant layer
// requires every requested WAN, bridge, Wi-Fi interface and customer port to
// be present in the current, fresh router inventory; arbitrary interface
// names can never become persistent configuration through this endpoint.
app.put('/api/business/locations/:locationId/router-mapping', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const result = tenant.confirmRouterMapping({
      locationId: String(req.params.locationId),
      businessId: business.id,
      mapping: req.body || {},
    });
    if (!result) return res.status(404).json({ error: 'Location not found.' });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not confirm this router map.' });
  }
});

/* ------------------------------------------------------------------ */
/* Optional remote-support onboarding                                  */
/* ------------------------------------------------------------------ */

/** This stage records explicit business consent only. It deliberately does
 * not generate a VPN key, expose a router service, or modify the router.
 * A later hub integration will consume approved/configured records. */
app.get('/api/business/locations/:locationId/remote-access', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const remoteAccess = tenant.remoteAccessForBusiness({ locationId: String(req.params.locationId), businessId: business.id });
  if (!remoteAccess) return res.status(404).json({ error: 'Location not found.' });
  res.json({ remoteAccess });
});

app.post('/api/business/locations/:locationId/remote-access', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  if (!req.body || req.body.consent !== true) {
    return res.status(400).json({ error: 'Confirm that WiFi Fiti may prepare remote support for this router.' });
  }
  try {
    let remoteAccess = tenant.requestRemoteAccess({ locationId: String(req.params.locationId), businessId: business.id });
    if (!remoteAccess) return res.status(404).json({ error: 'Location not found.' });
    // A configured self-hosted gateway lets consent move directly into the
    // safe prepare stage. The router still creates its own WireGuard key;
    // neither a router password nor a private key enters Railway. Keeping
    // the legacy requested state when the feature flag is off preserves the
    // existing manual approval workflow for deployments without a gateway.
    if (config.vpnGateway.enabled) {
      const provisioned = tenant.provisionRemoteVpn({
        locationId: String(req.params.locationId),
        gatewayId: config.vpnGateway.id,
        gatewayName: 'WiFi Fiti secure gateway',
        managementCidr: config.vpnGateway.managementCidr,
        actorId: `business:${business.id}`,
      });
      remoteAccess = provisioned && provisioned.remoteAccess;
    }
    res.json({ remoteAccess });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not request remote access.' });
  }
});

app.patch('/api/business/locations/:locationId/remote-access', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  if (String(req.body && req.body.action || '') !== 'revoke') {
    return res.status(400).json({ error: 'Choose the revoke action.' });
  }
  try {
    const remoteAccess = tenant.revokeRemoteAccessForBusiness({ locationId: String(req.params.locationId), businessId: business.id });
    if (!remoteAccess) return res.status(404).json({ error: 'Location not found.' });
    res.json({ remoteAccess });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not revoke remote access.' });
  }
});

/* ------------------------------------------------------------------ */
/* Self-hosted WireGuard gateway                                       */
/* ------------------------------------------------------------------ */

/**
 * The VPS pulls this endpoint; Railway never opens a connection to a
 * customer router or to the VPS. The request may report only observed state
 * for peers already known to the database. All endpoint/key/address material
 * for activation is reconstructed from Railway configuration, never trusted
 * from the gateway request.
 */
app.post('/api/internal/vpn-gateways/:gatewayId/sync', (req, res) => {
  if (!config.vpnGateway.enabled || String(req.params.gatewayId) !== config.vpnGateway.id || !vpnGatewayAuthenticated(req)) {
    return res.status(404).type('text/plain').send('Not found.');
  }
  try {
    const report = vpnGatewayReport(req.body);
    const peers = tenant.desiredVpnPeersForGateway({ gatewayId: config.vpnGateway.id });
    const byPublicKey = new Map(peers.map((peer) => [peer.routerPublicKey, peer]));

    // A reported application is accepted only for the exact currently
    // assigned /32. A delayed gateway response for an older configuration is
    // ignored, then the response below tells the gateway the current state.
    for (const applied of report.appliedPeers) {
      const peer = byPublicKey.get(applied.publicKey);
      if (!peer || peer.desiredState !== 'active' || applied.allowedAddress !== `${peer.managementAddress}/32`) continue;
      try {
        tenant.recordVpnGatewayPeer({
          locationId: peer.locationId,
          gatewayId: config.vpnGateway.id,
          configVersion: peer.configVersion,
          gatewayPeerId: vpnGatewayPeerId(peer),
          gatewayPublicKey: config.vpnGateway.publicKey,
          endpointHost: config.vpnGateway.endpointHost,
          endpointPort: config.vpnGateway.endpointPort,
          gatewayAddress: config.vpnGateway.address,
        });
      } catch (error) {
        // A business can revoke consent between the gateway snapshot and this
        // individual state transition. The tenant lifecycle is authoritative;
        // a 409 merely makes this old observation harmless.
        if (error.status !== 409) throw error;
      }
    }

    // Revocation is proven only once the agent says its managed peer is no
    // longer present. The desired record stays visible until this happens,
    // which keeps an offline router from retaining a gateway peer by mistake.
    for (const publicKey of report.removedPeerKeys) {
      const peer = byPublicKey.get(publicKey);
      if (!peer || peer.desiredState !== 'revoked') continue;
      try {
        tenant.reportVpnGatewaySync({
          locationId: peer.locationId,
          gatewayId: config.vpnGateway.id,
          configVersion: peer.configVersion,
          status: 'revoked',
        });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }

    // Re-read after application/revocation transitions. Handshakes are
    // monotonic and are accepted only for an active, ready peer with the
    // exact currently assigned /32. Bad/stale observations never make the
    // whole gateway poll fail.
    const currentPeers = tenant.desiredVpnPeersForGateway({ gatewayId: config.vpnGateway.id });
    const currentByPublicKey = new Map(currentPeers.map((peer) => [peer.routerPublicKey, peer]));
    const now = Date.now();
    for (const observation of report.observations) {
      const peer = currentByPublicKey.get(observation.publicKey);
      const observedAt = observation.lastHandshakeEpoch * 1000;
      if (!peer || peer.desiredState !== 'active' || peer.gatewayState !== 'ready' ||
          observation.allowedAddress !== `${peer.managementAddress}/32` ||
          observedAt < now - 366 * 24 * 60 * 60 * 1000 || observedAt > now + 5 * 60 * 1000) continue;
      try {
        tenant.recordVpnPeerHandshake({
          locationId: peer.locationId,
          gatewayId: config.vpnGateway.id,
          configVersion: peer.configVersion,
          handshakeAt: new Date(observedAt).toISOString(),
        });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }

    const desired = vpnGatewayDesiredSnapshot(config.vpnGateway.id);
    if (report.knownRevision && report.knownRevision === desired.revision) {
      return res.json({ version: 2, revision: desired.revision, unchanged: true, peers: [] });
    }
    res.json({ version: 2, revision: desired.revision, unchanged: false, peers: desired.peers });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[vpn gateway] sync failed:', error.message);
    res.status(status).json({ error: status === 400 ? error.message : 'VPN gateway sync failed.' });
  }
});

/** A replacement credential is shown once. It is staged for 24 hours, so the
 * current router remains connected until the replacement makes its first
 * authenticated check-in. */
app.post('/api/business/locations/:locationId/router-token', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const location = tenant.rotateLocationToken({ locationId: String(req.params.locationId), businessId: business.id });
  if (!location) return res.status(404).json({ error: 'Location not found.' });
  res.json({
    location,
    portalUrl: portalUrlForLocation(location),
    coreUrl: config.domains.appUrl,
  });
});

app.post('/api/business/packages', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const name = String(req.body && req.body.name || '').trim().slice(0, 48);
  const price = Number(req.body && req.body.price);
  const hours = Number(req.body && req.body.hours);
  const rate = normaliseRateLimit(req.body && req.body.rateLimit);
  if (!name || !Number.isInteger(price) || price < 1 || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 31 || !rate.valid) {
    return res.status(400).json({ error: 'Enter a package name, price, duration up to 31 days, and a valid upload/download speed such as 2M/5M.' });
  }
  db.addBusinessPackage.run({ businessId: business.id, name, price, seconds: Math.round(hours * 3600), rateLimit: rate.value });
  res.status(201).json({ packages: db.packagesForBusiness.all(business.id) });
});

app.patch('/api/business/packages/:packageId', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const id = Number(req.params.packageId);
  const current = tenant.businessPackageById.get(id, business.id);
  if (!current) return res.status(404).json({ error: 'Package not found.' });
  const name = String(req.body && req.body.name || current.name).trim().slice(0, 48);
  const price = req.body && req.body.price === undefined ? current.price : Number(req.body.price);
  const hours = req.body && req.body.hours === undefined ? current.seconds / 3600 : Number(req.body.hours);
  const rate = normaliseRateLimit(req.body && req.body.rateLimit === undefined ? current.rate_limit : req.body.rateLimit);
  if (!name || !Number.isInteger(price) || price < 1 || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 31 || !rate.valid) {
    return res.status(400).json({ error: 'Enter a package name, price, duration up to 31 days, and a valid upload/download speed such as 2M/5M.' });
  }
  tenant.updateBusinessPackage.run({ id, businessId: business.id, name, price, seconds: Math.round(hours * 3600), rateLimit: rate.value });
  res.json({ packages: db.packagesForBusiness.all(business.id) });
});

app.patch('/api/business/packages/:packageId/availability', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const id = Number(req.params.packageId);
  if (!tenant.businessPackageById.get(id, business.id)) return res.status(404).json({ error: 'Package not found.' });
  tenant.setBusinessPackageActive.run({ id, businessId: business.id, active: req.body && req.body.active === false ? 0 : 1 });
  res.json({ packages: db.packagesForBusiness.all(business.id) });
});

app.patch('/api/business/locations/:locationId', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const current = tenant.locationForBusiness.get(String(req.params.locationId), business.id);
  if (!current) return res.status(404).json({ error: 'Location not found.' });
  const name = String(req.body && req.body.name === undefined ? current.name : req.body.name || '').trim().slice(0, 80);
  const routerName = String(req.body && req.body.routerName === undefined ? current.router_name || '' : req.body.routerName || '').trim().slice(0, 80);
  const hotspotServer = String(req.body && req.body.hotspotServer === undefined ? current.hotspot_server || '' : req.body.hotspotServer || '').trim();
  if (!name || (hotspotServer && !/^[A-Za-z0-9_-]{1,32}$/.test(hotspotServer))) {
    return res.status(400).json({ error: 'Enter a location name and a valid RouterOS hotspot server name.' });
  }
  const location = tenant.updateLocationSettings({ locationId: current.id, businessId: business.id, name, routerName, hotspotServer });
  res.json({ location });
});

// This intentionally removes only a pristine, unpaired setup draft. It is
// not a shortcut for deleting customer records or remotely factory-resetting
// a router; established locations use the staged replacement-kit flow.
app.delete('/api/business/locations/:locationId', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const location = tenant.discardUnusedLocation({
      locationId: String(req.params.locationId),
      businessId: business.id,
      confirm: String(req.body && req.body.confirm || ''),
    });
    if (!location) return res.status(404).json({ error: 'Location not found.' });
    res.json({ deleted: true, locationId: location.id });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not delete this setup.' });
  }
});

// A managed address is a first-level Cloudflare hostname, for example
// lakeview-main.wififiti.co.ke. It is intentionally a location address: a
// router can then open exactly the portal that owns its customer jobs.
app.patch('/api/business/locations/:locationId/portal-address', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const slug = String(req.body && req.body.slug || '').trim().toLowerCase();
  if (tenant.managedPortalSlugReserved(slug)) return res.status(400).json({ error: 'Choose a different portal address.' });
  try {
    const location = tenant.setManagedPortalHostname({ locationId: String(req.params.locationId), businessId: business.id, slug });
    if (!location) return res.status(404).json({ error: 'Location not found.' });
    res.json({ location, portalUrl: portalUrlForLocation(location), coreUrl: config.domains.appUrl,
      aliases: tenant.portalDomainsForLocation.all(location.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save the customer portal address.' });
  }
});

app.get('/api/business/dashboard', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const period = String(req.query.period || '30d');
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const since = new Date(Date.now() - days * 86400_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const totals = tenant.salesSummary.get(business.id, since);
  const gross = Number(totals.gross || 0);
  const platformFee = Number(totals.platform_fee || 0);
  res.json({
    period, since, gross, payments: Number(totals.payments || 0), customers: Number(totals.customers || 0),
    platformFee, netToBusiness: gross - platformFee,
    byLocation: tenant.salesByLocation.all(since, business.id),
    recentPayments: tenant.recentSales.all(business.id, 25),
  });
});

app.get('/api/business/vouchers', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  res.json({ vouchers: tenant.vouchersForBusiness.all(business.id, 100) });
});

app.post('/api/business/vouchers', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const locationId = String(req.body && req.body.locationId || '');
  const packageId = Number(req.body && req.body.packageId);
  const count = Math.min(Math.max(Math.floor(Number(req.body && req.body.count) || 1), 1), 200);
  const location = tenant.locationForBusiness.get(locationId, business.id);
  const pkg = tenant.businessPackageById.get(packageId, business.id);
  if (!location || !pkg || !pkg.active) return res.status(400).json({ error: 'Choose one of your active packages and locations.' });
  try {
    const codes = tenant.issueVouchers({ businessId: business.id, locationId, packageId: pkg.id,
      packageName: pkg.name, seconds: pkg.seconds, rateLimit: pkg.rate_limit, count,
      batch: String(req.body && req.body.batch || '').trim().slice(0, 40) });
    res.status(201).json({ codes, locationId, package: pkg.name });
  } catch (err) {
    console.error('[business vouchers] issue failed:', err.message);
    res.status(500).json({ error: 'Could not create vouchers.' });
  }
});

/* ------------------------------------------------------------------ */
/* Tenant customer portal                                             */
/* ------------------------------------------------------------------ */

function tenantRemaining(subscription) {
  if (!subscription) return 0;
  const raw = String(subscription.expires_at || subscription.expiresAt || '');
  const expiry = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - Date.now()) / 1000)) : 0;
}

function tenantSessionPayload(subscription, issueToken = false) {
  return { found: true, authenticated: true, subscriptionId: subscription.id,
    payerPhone: subscription.payer_phone, username: subscription.router_username,
    password: subscription.password, remainingSeconds: tenantRemaining(subscription),
    rateLimit: subscription.rate_limit || null,
    expiresAt: subscription.expires_at.replace(' ', 'T') + 'Z',
    device: tenant.deviceForSubscription.get(subscription.location_id, subscription.id) || null,
    awaitingRouter: Boolean(tenant.pendingProvisioningJobForUsername.get(subscription.location_id, subscription.router_username)),
    ...(issueToken ? { sessionToken: tenantAccess.issue(subscription) } : {}) };
}

function tenantSessionForRequest(location, req) {
  return tenantAccess.authenticate(location.id, req.get('X-WiFi-Fiti-Session'),
    cleanMac(req.query.mac || req.body && req.body.mac));
}

function tenantPortalCapability() {
  return crypto.randomBytes(24).toString('base64url');
}

function tenantPortalCapabilityOk(transaction, supplied) {
  const expected = Buffer.from(String(transaction && transaction.portal_token_hash || ''), 'hex');
  const actual = Buffer.from(tenant.tokenHash(supplied), 'hex');
  if (!expected.length || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
  const expiresAt = new Date(String(transaction.portal_token_expires_at || '').replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function tenantProvisioningPending(transaction) {
  if (!transaction || !transaction.provisioned || !transaction.subscription_id) return true;
  if (!transaction.provisioning_job_id) return true;
  const job = tenant.jobById.get(transaction.provisioning_job_id, transaction.location_id);
  return !job || !job.acked_at;
}

function tenantPaidPayload(transaction) {
  const subscription = tenant.subscriptionById.get(transaction.subscription_id, transaction.location_id);
  if (!subscription) return { status: 'pending', awaitingRouter: true };
  if (tenantProvisioningPending(transaction)) return { status: 'pending', awaitingRouter: true };
  if (subscription.mac !== transaction.mac) return { status: 'transferred',
    reason: 'This package was moved to another device. Use its WiFi recovery code to move it back.' };
  return { status: 'paid', ...tenantSessionPayload(subscription, true) };
}

function provisionTenantPayment(checkoutRequestId) {
  const transaction = tenant.getTransaction.get(checkoutRequestId);
  if (!transaction || transaction.status !== 'paid') return transaction;
  if (!transaction.provisioned) tenant.provisionPaidTransaction(checkoutRequestId);
  return tenant.getTransaction.get(checkoutRequestId);
}

async function queryTenantMpesa(transaction) {
  if (transaction.payment_source === 'own') {
    const credentials = tenant.paymentCredentials(transaction.business_id);
    if (!credentials) throw new Error('Business M-Pesa credentials are unavailable.');
    return tenantMpesa.stkQuery({ credentials, checkoutRequestId: transaction.checkout_request_id });
  }
  return mpesa.stkQuery(transaction.checkout_request_id);
}

async function queryTenantNow(transaction) {
  const age = Date.now() - new Date(transaction.created_at + 'Z').getTime();
  if (!Number.isFinite(age) || age < QUERY_AFTER_MS) return transaction;
  const last = lastQueryAt.get(transaction.checkout_request_id) || 0;
  if (Date.now() - last < QUERY_EVERY_MS) return transaction;
  lastQueryAt.set(transaction.checkout_request_id, Date.now());

  try {
    const result = await queryTenantMpesa(transaction);
    if (!result.settled) return transaction;
    if (result.resultCode === 0) {
      tenant.setTransactionResult.run({ checkoutRequestId: transaction.checkout_request_id,
        status: 'paid', resultCode: 0, resultDesc: result.resultDesc, receipt: null });
      return provisionTenantPayment(transaction.checkout_request_id);
    }
    if (age >= QUERY_FAILURE_AFTER_MS) {
      tenant.setTransactionResult.run({ checkoutRequestId: transaction.checkout_request_id,
        status: 'failed', resultCode: result.resultCode, resultDesc: result.resultDesc, receipt: null });
    }
  } catch (err) {
    console.warn(`[tenant status] query failed for ${transaction.checkout_request_id}: ${err.message}`);
  }
  return tenant.getTransaction.get(transaction.checkout_request_id);
}

function publicLocation(id, res) {
  const location = tenant.locationById.get(id);
  if (!location) { res.status(404).json({ error: 'This WiFi location was not found.' }); return null; }
  return location;
}

function businessCanSell(location) {
  if (location.billing_status === 'suspended') return 'This WiFi service is temporarily unavailable.';
  if (!location.billing_expires_at) return null; // existing operators are migrated without interruption
  const expiry = new Date(location.billing_expires_at.replace(' ', 'T') + 'Z').getTime();
  if (Number.isFinite(expiry) && expiry <= Date.now()) {
    return 'This WiFi service needs its business plan renewed before it can take a new payment.';
  }
  return null;
}

app.get('/p/:locationId', (req, res) => {
  if (!tenant.locationById.get(req.params.locationId)) return res.status(404).send('WiFi location not found.');
  res.sendFile(path.join(__dirname, '..', 'public', 'tenant-portal.html'));
});

app.get('/api/tenant/:locationId/config', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const assetOrigin = edgePortalOriginForRequest(req, location) || config.domains.appUrl;
  const branding = brandingPayload({
    id: location.business_id, name: location.business_name, portal_name: location.portal_name,
    support_phone: location.support_phone, brand_primary_color: location.brand_primary_color,
    brand_logo_path: location.brand_logo_path, portal_message: location.portal_message,
  }, { assetOrigin });
  res.json({ location: { id: location.id, name: location.name, businessName: branding.name }, branding,
    packages: tenant.packagesForLocation.all(location.id), supportPhone: branding.supportPhone });
});

app.get('/api/tenant/:locationId/session', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const authenticated = tenantSessionForRequest(location, req);
  if (authenticated) return res.json(tenantSessionPayload(authenticated));
  const mac = cleanMac(req.query.mac);
  const subscription = mac && tenant.subscriptionByMac.get(location.id, mac);
  const remainingSeconds = tenantRemaining(subscription);
  if (!subscription || remainingSeconds <= 0) return res.json({ found: false });
  // A MAC address is only a router routing hint, not proof of ownership.
  // Never disclose credentials, phone numbers or subscription ids from it.
  res.json({ found: true, manualConnect: true, remainingSeconds,
    expiresAt: subscription.expires_at.replace(' ', 'T') + 'Z' });
});

app.post('/api/tenant/:locationId/session/connect', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const subscription = tenantSessionForRequest(location, req);
  if (!subscription) return res.status(403).json({ error: 'Use your WiFi recovery code to reconnect this package.' });
  if (!tenantRemaining(subscription)) return res.status(402).json({ error: 'This package has ended. Choose a new package to continue.' });
  const ip = cleanIp(req.body && req.body.ip);
  const job = tenant.insertJob.run({ locationId: location.id, username: subscription.router_username,
    password: subscription.password, profile: 'standard', totalSeconds: subscription.total_seconds,
    rateLimit: subscription.rate_limit, mac: subscription.mac, ip, action: 'upsert' });
  res.json({ ...tenantSessionPayload(subscription), status: 'pending', provisioningJobId: Number(job.lastInsertRowid) });
});

app.post('/api/tenant/:locationId/pay', async (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const salesBlocked = businessCanSell(location);
  if (salesBlocked) return res.status(402).json({ error: salesBlocked });
  const pkg = tenant.packageForLocation.get(Number(req.body && req.body.packageId), location.id);
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const mac = cleanMac(req.body && req.body.mac);
  const ip = cleanIp(req.body && req.body.ip);
  if (!pkg || !phone || !mac) return res.status(400).json({ error: 'Choose a package, enter a valid number, and reconnect to this WiFi.' });
  const plan = BUSINESS_PLANS[location.business_plan] || BUSINESS_PLANS.starter;
  const existingSubscription = tenant.subscriptionByMac.get(location.id, mac);
  if (!existingSubscription && plan.activeDeviceLimit && tenant.activeMeter.get(location.business_id).n >= plan.activeDeviceLimit) {
    return res.status(402).json({ error: 'This WiFi location has reached its current monthly customer limit. Please contact the operator.' });
  }
  const pendingPayment = tenant.pendingPaymentForPhone.get(location.id, phone);
  if (pendingPayment) {
    return res.status(429).json({ error: 'A payment request is already on its way to this number. Please check the phone first.' });
  }
  const throttleKey = `${location.id}:${phone}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) {
    return res.status(429).json({ error: 'A payment request is already on its way. Please wait a moment.' });
  }
  try {
    lastPush.set(throttleKey, Date.now());
    let pushed;
    let paymentSource = 'fiti';
    let platformFee = pkg.price * 5 / 100;
    if (location.collection_mode === 'own') {
      let credentials;
      try { credentials = tenant.paymentCredentials(location.business_id); }
      catch (err) {
        lastPush.delete(throttleKey);
        return res.status(409).json({ error: 'This operator needs to reconnect their own M-Pesa collection account.' });
      }
      if (!credentials) {
        lastPush.delete(throttleKey);
        return res.status(409).json({ error: 'This operator must finish connecting their own M-Pesa collection account before taking payments.' });
      }
      pushed = await tenantMpesa.stkPush({ credentials, phone, amount: pkg.price,
        accountReference: `WF-${location.id.slice(-6)}`, description: pkg.name });
      paymentSource = 'own';
      platformFee = 0;
    } else {
      pushed = await mpesa.stkPush({ phone, amount: pkg.price,
        accountReference: `WF-${location.id.slice(-6)}`, description: pkg.name });
    }
    const portalToken = tenantPortalCapability();
    tenant.insertTransaction.run({ checkoutRequestId: pushed.checkoutRequestId,
      merchantRequestId: pushed.merchantRequestId, businessId: location.business_id, locationId: location.id,
      phone, packageId: pkg.id, packageName: pkg.name, amount: pkg.price, seconds: pkg.seconds,
      rateLimit: pkg.rate_limit, mac, ip });
    tenant.setTransactionTerms.run({ checkoutRequestId: pushed.checkoutRequestId, paymentSource, platformFee });
    tenant.setTransactionPortalCapability.run({
      checkoutRequestId: pushed.checkoutRequestId,
      portalTokenHash: tenant.tokenHash(portalToken),
      portalTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    });
    res.json({ checkoutRequestId: pushed.checkoutRequestId, portalToken, amount: pkg.price, phoneDisplay: mpesa.displayPhone(phone) });
  } catch (err) {
    lastPush.delete(throttleKey);
    console.error('[tenant pay] STK push failed:', err.message);
    res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});

app.get('/api/tenant/:locationId/status/:checkoutRequestId', async (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  let tx = tenant.getTransaction.get(req.params.checkoutRequestId);
  if (!tx || tx.location_id !== location.id) return res.status(404).json({ error: 'Payment not found.' });
  if (!tenantPortalCapabilityOk(tx, req.get('X-WiFi-Fiti-Portal'))) {
    return res.status(403).json({ error: 'This payment page has expired. Start a new M-Pesa request from this WiFi.' });
  }
  if (tx.status === 'pending') {
    tx = await queryTenantNow(tx);
  }
  if (tx.status === 'paid') {
    try { tx = provisionTenantPayment(tx.checkout_request_id); }
    catch (err) {
      console.error(`[tenant status] could not provision ${tx.checkout_request_id}:`, err.message);
      return res.json({ status: 'pending', awaitingRouter: true });
    }
    return res.json(tenantPaidPayload(tx));
  }
  res.json({ status: tx.status, reason: tx.status === 'failed' ? friendlyFailure(tx.result_code, tx.result_desc) : null });
});

function publicTenantSubscription(locationId, subscription) {
  const remainingSeconds = tenantRemaining(subscription);
  const device = tenant.deviceForSubscription.get(locationId, subscription.id);
  return {
    id: subscription.id,
    mac: subscription.mac,
    remainingSeconds,
    rateLimit: subscription.rate_limit || null,
    expiresAt: subscription.expires_at.replace(' ', 'T') + 'Z',
    device: device ? { mac: device.mac, label: device.label } : null,
  };
}

app.post('/api/tenant/:locationId/subscriptions/check', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter the number used to buy the package.' });
  const subscriptions = tenant.subscriptionsForPayer.all(location.id, phone)
    .map((subscription) => publicTenantSubscription(location.id, subscription))
    .filter((subscription) => subscription.remainingSeconds > 0);
  res.json({ found: subscriptions.length > 0, subscriptions });
});

/** Move a remaining package to the device currently opening the portal.
 * The receipt password prevents a guessed phone number from taking over a
 * customer’s time; RouterOS then removes the old live session. */
app.post('/api/tenant/:locationId/subscriptions/transfer', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const subscriptionId = String(req.body && req.body.subscriptionId || '');
  const password = String(req.body && req.body.password || '');
  const mac = cleanMac(req.body && req.body.mac);
  const ip = cleanIp(req.body && req.body.ip);
  if (!phone || !subscriptionId || !password || !mac) {
    return res.status(400).json({ error: 'Choose the package, enter its WiFi password, and reconnect to this WiFi.' });
  }
  const moved = tenant.transferSubscription({ locationId: location.id, payerPhone: phone, subscriptionId,
    password, mac, ip });
  if (moved && moved.error === 'occupied') {
    return res.status(409).json({ error: 'This device already has another active package. Use that package or wait for it to end before moving this one.' });
  }
  if (!moved) return res.status(403).json({ error: 'That package has ended or its WiFi password is not correct.' });
  tenantAccess.revoke.run(moved.id);
  const movedSession = tenant.subscriptionById.get(moved.id, location.id);
  res.json({ status: 'pending', provisioningJobId: moved.provisioningJobId,
    ...tenantSessionPayload(movedSession, true) });
});

app.get('/api/tenant/:locationId/router-jobs/:jobId', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const id = Number(req.params.jobId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid router job.' });
  const job = tenant.jobById.get(id, location.id);
  if (!job) return res.status(404).json({ error: 'Router job not found.' });
  res.json({ ready: Boolean(job.acked_at) });
});

function deviceMac(value) {
  const compact = String(value || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return compact.length === 12 ? compact.match(/.{2}/g).join(':') : null;
}

app.post('/api/tenant/:locationId/devices/list', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter the number used to buy the package.' });
  const subscriptions = tenant.subscriptionsForPayer.all(location.id, phone)
    .map((subscription) => publicTenantSubscription(location.id, subscription))
    .filter((subscription) => subscription.remainingSeconds > 0);
  res.json({ subscriptions, maxDevicesPerSubscription: 1 });
});

app.post('/api/tenant/:locationId/devices/add', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const subscriptionId = String(req.body && req.body.subscriptionId || '');
  const mac = deviceMac(req.body && req.body.mac);
  const password = String(req.body && req.body.password || '');
  const label = String(req.body && req.body.label || 'TV').replace(/[^\w \-]/g, '').trim().slice(0, 24) || 'TV';
  if (!phone || !subscriptionId || !mac || !password) {
    return res.status(400).json({ error: 'Enter the package WiFi password and a complete TV MAC address.' });
  }
  const added = tenant.addTvDevice({ locationId: location.id, payerPhone: phone, subscriptionId, password, mac, label });
  if (added.error === 'subscription' || added.error === 'password') {
    return res.status(403).json({ error: 'That package or WiFi password is not correct.' });
  }
  if (added.error === 'expired') return res.status(402).json({ error: 'This package has ended. Buy time before connecting a TV.' });
  if (added.error === 'same-device') return res.status(400).json({ error: 'Use the MAC address of the TV or streaming device, not the phone already using this package.' });
  if (added.error === 'owned') return res.status(409).json({ error: 'That device is already attached to another customer package.' });
  if (added.error === 'limit') return res.status(409).json({
    error: `This package already has ${added.device.label || 'a TV'} connected. Remove it before adding another device.`,
    device: { mac: added.device.mac, label: added.device.label },
  });
  res.json({ status: 'pending', provisioningJobId: added.provisioningJobId, mac: added.mac, label: added.label });
});

app.post('/api/tenant/:locationId/devices/remove', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const subscriptionId = String(req.body && req.body.subscriptionId || '');
  const mac = deviceMac(req.body && req.body.mac);
  const password = String(req.body && req.body.password || '');
  if (!phone || !subscriptionId || !mac || !password) return res.status(400).json({ error: 'Complete the package details before removing a device.' });
  const removed = tenant.removeTvDevice({ locationId: location.id, payerPhone: phone, subscriptionId, password, mac });
  if (!removed) return res.status(403).json({ error: 'The selected device or WiFi password is not correct.' });
  res.json({ ok: true });
});

app.post('/api/tenant/:locationId/voucher/redeem', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const salesBlocked = businessCanSell(location);
  if (salesBlocked) return res.status(402).json({ error: salesBlocked });
  const code = String(req.body && req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const mac = cleanMac(req.body && req.body.mac);
  const ip = cleanIp(req.body && req.body.ip);
  if (code.length < 6 || !phone || !mac) return res.status(400).json({ error: 'Enter a valid voucher code, phone number, and reconnect to this WiFi.' });
  const plan = BUSINESS_PLANS[location.business_plan] || BUSINESS_PLANS.starter;
  if (!tenant.subscriptionByMac.get(location.id, mac) && plan.activeDeviceLimit && tenant.activeMeter.get(location.business_id).n >= plan.activeDeviceLimit) {
    return res.status(402).json({ error: 'This WiFi location has reached its current monthly customer limit. Please contact the operator.' });
  }
  try {
    const result = tenant.redeemVoucher({ locationId: location.id, code, phone, mac, ip });
    if (!result) return res.status(409).json({ error: 'That voucher is not available at this location, or it has already been used.' });
    res.json({ status: 'pending', provisioningJobId: result.provisioningJobId,
      ...tenantSessionPayload(tenant.subscriptionById.get(result.id, location.id), true) });
  } catch (err) {
    console.error('[tenant voucher] redemption failed:', err.message);
    res.status(500).json({ error: 'Could not redeem the voucher. Please try again.' });
  }
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

app.get('/api/tenant/:locationId/router-login', (req, res) => {
  const header = req.get('X-WiFi-Fiti-Router');
  const location = tenant.authenticateRouter(req.params.locationId, header || req.query.token, header ? 'header' : 'query');
  if (!location) return res.status(403).type('text/plain').send('forbidden');
  const portal = `${portalUrlForRouter(location, req.query.portal)}?mac=$(mac)&ip=$(ip)&link-login-only=$(link-login-only-esc)&link-orig=$(link-orig-esc)`;
  const safePortal = escapeHtml(portal);
  res.type('text/html').send(`<!doctype html><meta http-equiv="refresh" content="0;url=${safePortal}"><title>${escapeHtml(location.business_name)}</title><p>Opening WiFi payment page… <a href="${safePortal}">Continue</a></p>`);
});

/* ------------------------------------------------------------------ */
/* Client identity                                                     */
/* ------------------------------------------------------------------ */

/**
 * Only ever trust the MAC and IP that RouterOS itself put in the redirect
 * URL. Express's req.ip is useless here: the client sits behind the
 * hotspot's NAT, so req.ip is the router's own WAN address, and on a
 * dual-stack listener it arrives IPv6-mapped ("::ffff:192.168.0.132"),
 * which RouterOS rejects outright. Sending it produced a confusing
 * "invalid value for argument ip" on every login attempt.
 *
 * No identity is better than a wrong one - the customer still gets
 * working credentials, they just type them once.
 */
function cleanMac(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m) ? m : null;
}

function cleanIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  return ip.split('.').every((o) => Number(o) <= 255) ? ip : null;
}

/**
 * RouterOS accepts a rich `rate-limit` grammar, but package editors should
 * not be able to turn a customer package into arbitrary RouterOS syntax.
 * Keep the commercial setting intentionally small: upload/download values
 * using k or M, for example `2M/5M`. RouterOS reads those as rx/tx from the
 * router's perspective: customer upload, then customer download. An empty
 * setting means “use the router profile's normal speed”.
 */
function normaliseRateLimit(value) {
  const rate = String(value == null ? '' : value).trim().replace(/\s+/g, '');
  if (!rate) return { valid: true, value: null };
  const parts = rate.split('/');
  if (parts.length !== 2 || !parts.every((part) => /^\d+(?:\.\d+)?[kKmM]$/.test(part))) {
    return { valid: false, value: null };
  }
  const validAmount = parts.every((part) => {
    const amount = Number(part.slice(0, -1));
    return Number.isFinite(amount) && amount > 0 && amount <= 10000;
  });
  if (!validAmount) return { valid: false, value: null };
  const canonical = parts.map((part) => {
    const amount = part.slice(0, -1);
    return amount + (part.at(-1).toLowerCase() === 'k' ? 'k' : 'M');
  }).join('/');
  return { valid: true, value: canonical };
}

/* ------------------------------------------------------------------ */
/* Portal API                                                          */
/* ------------------------------------------------------------------ */

app.get('/api/config', (req, res) => {
  res.json({
    brandName: config.brandName,
    supportPhone: config.supportPhone,
    shortcode: config.mpesa.shortcode,
    packages: PACKAGES.map(({ id, name, detail, price }) => ({
      id,
      name,
      detail,
      price,
    })),
  });
});

app.post('/api/pay', async (req, res) => {
  const { packageId, phone: rawPhone, mac, ip } = req.body || {};

  const pkg = findPackage(packageId);
  if (!pkg) {
    return res.status(400).json({ error: 'Pick a package to continue.' });
  }

  const phone = mpesa.normalizePhone(rawPhone);
  if (!phone) {
    return res.status(400).json({
      error: 'That number does not look right. Use the format 07XX XXX XXX.',
    });
  }

  const since = lastPush.get(phone);
  if (since && Date.now() - since < PUSH_COOLDOWN_MS) {
    const wait = Math.ceil((PUSH_COOLDOWN_MS - (Date.now() - since)) / 1000);
    return res.status(429).json({
      error: `A payment request is already on its way to that phone. Wait ${wait}s before trying again.`,
    });
  }

  try {
    lastPush.set(phone, Date.now());

    const { checkoutRequestId, merchantRequestId } = await mpesa.stkPush({
      phone,
      amount: pkg.price,
      accountReference: pkg.id.toUpperCase(),
      description: pkg.name,
    });

    db.insert.run({
      checkoutRequestId,
      merchantRequestId,
      phone,
      packageId: pkg.id,
      amount: pkg.price,
      seconds: pkg.seconds,
      mac: cleanMac(mac),
      ip: cleanIp(ip),
    });
    // Captive portal windows close when RouterOS force-logs a device in.
    // Provision first, then let the customer tap Connect now so they see
    // confirmation and their countdown instead of an apparent crash.
    db.requireManualLogin.run(checkoutRequestId);

    console.log(
      `[pay] ${phone} ${pkg.id} KES${pkg.price} -> ${checkoutRequestId}`
    );

    res.json({
      checkoutRequestId,
      phoneDisplay: mpesa.displayPhone(phone),
      amount: pkg.price,
    });
  } catch (err) {
    lastPush.delete(phone);
    console.error('[pay] STK push failed:', err.message, err.daraja || '');
    res.status(502).json({
      error:
        'Could not reach M-Pesa just now. Wait a moment and try again.',
    });
  }
});

/**
 * Daraja's sandbox often never sends the callback, so the background sweep
 * ends up doing the confirming - and its interval becomes the customer's
 * wait. Since the portal is already polling this endpoint every 3 seconds,
 * ask Daraja directly right here instead of waiting for the next sweep.
 *
 * Throttled per transaction so a customer refreshing does not hammer
 * Safaricom, and only after 6s, which is longer than a prompt takes to
 * answer but far shorter than the sweep.
 */
const lastQueryAt = new Map();
const QUERY_AFTER_MS = 6_000;
const QUERY_EVERY_MS = 4_000;
// Daraja can briefly return timeout/cancellation-looking results while the
// handset prompt is still resolving. Success is safe to accept immediately;
// a failure is only final after this grace window or via the callback.
const QUERY_FAILURE_AFTER_MS = 3 * 60_000;

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of lastQueryAt) if (v < cutoff) lastQueryAt.delete(k);
}, 60_000).unref();

async function queryNow(tx) {
  const id = tx.checkout_request_id;
  const age = Date.now() - new Date(tx.created_at + 'Z').getTime();
  if (!Number.isFinite(age) || age < QUERY_AFTER_MS) return;

  const last = lastQueryAt.get(id) || 0;
  if (Date.now() - last < QUERY_EVERY_MS) return;
  lastQueryAt.set(id, Date.now());

  try {
    const q = await mpesa.stkQuery(id);
    if (!q.settled) return;

    if (q.resultCode === 0) {
      db.markResult.run({ checkoutRequestId: id, status: 'paid',
        resultCode: 0, resultDesc: q.resultDesc, receipt: null });
      console.log(`[status] confirmed ${id} on demand`);
      await fulfil(db.get.get(id));
    } else if (age >= QUERY_FAILURE_AFTER_MS) {
      db.markResult.run({ checkoutRequestId: id, status: 'failed',
        resultCode: q.resultCode, resultDesc: q.resultDesc, receipt: null });
    } else {
      console.log(`[status] ${id} returned ${q.resultCode}; keeping pending during grace window`);
    }
  } catch (err) {
    console.warn(`[status] on-demand query failed for ${id}: ${err.message}`);
  }
}

app.get('/api/status/:checkoutRequestId', async (req, res) => {
  let tx = db.get.get(req.params.checkoutRequestId);
  if (!tx) return res.status(404).json({ error: 'Unknown request.' });

  if (tx.status === 'pending') {
    await queryNow(tx);
    tx = db.get.get(req.params.checkoutRequestId);
  }

  const payload = { status: tx.status };
  payload.manualLogin = tx.auto_login === 0;

  // In poll mode "provisioned" only means the job was queued. The router
  // may not have created the user yet, so announcing success here makes
  // the portal try to sign in with credentials that do not exist, fail,
  // and bounce the customer back - which is why they had to press
  // "Continue browsing" themselves a few seconds later. Wait for the ack.
  const awaitingRouter =
    config.provisionMode === 'poll' &&
    tx.hotspot_username &&
    db.unackedJobsForTotal.get({
      username: tx.hotspot_username,
      totalSeconds: db.getAccount.get(tx.hotspot_username)?.total_seconds || tx.seconds,
    }).n > 0;

  if (tx.status === 'paid' && tx.provisioned && !awaitingRouter) {
    payload.username = tx.hotspot_username;
    payload.password = tx.hotspot_password;
    payload.receipt = tx.mpesa_receipt;
    const info = remainingFor(tx.hotspot_username);
    if (info) payload.remainingSeconds = info.remainingSeconds;
    if (info && info.expiresAt) payload.expiresAt = info.expiresAt;
  } else if (tx.status === 'paid') {
    // Paid, but the router has not applied it yet. Keep the customer on
    // the waiting screen rather than showing success with no internet
    // behind it.
    payload.status = 'pending';
    payload.awaitingRouter = true;
  } else if (tx.status === 'failed') {
    payload.reason = friendlyFailure(tx.result_code, tx.result_desc);
  }

  res.json(payload);
});

/** Captive portal assistants are disposable browser windows. iOS commonly
 * closes one while the customer approves an STK prompt, and Android may
 * recreate it after connectivity changes. Recover the server-side checkout
 * by the MAC RouterOS placed in the portal URL. */
app.get('/api/payment/recover', (req, res) => {
  const mac = cleanMac(req.query.mac);
  if (!mac) return res.json({ found: false });
  const tx = db.latestPaymentForMac.get(mac);
  if (!tx) return res.json({ found: false });
  res.json({
    found: true,
    checkoutId: tx.checkout_request_id,
    phone: tx.phone,
    amount: tx.amount,
    startedAt: new Date(tx.created_at.replace(' ', 'T') + 'Z').getTime(),
  });
});

function friendlyFailure(code, desc) {
  switch (Number(code)) {
    case 1032:
      return 'You cancelled the payment request.';
    case 1037:
      return 'Your phone did not respond in time. Make sure it is unlocked and on the network, then try again.';
    case 1:
      return 'Not enough money in your M-Pesa. Top up and try again.';
    case 2001:
      return 'Wrong M-Pesa PIN. Try again.';
    default:
      return desc || 'The payment did not go through. Try again.';
  }
}

/* ------------------------------------------------------------------ */
/* Daraja callback                                                     */
/* ------------------------------------------------------------------ */

app.post('/api/mpesa/callback', (req, res) => {
  // Safaricom times the webhook out at 30s and does not retry on failure.
  // Acknowledge first, work afterwards - always.
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  setImmediate(() => handleCallback(req.body).catch((err) =>
    console.error('[callback] handler threw:', err)
  ));
});

function callbackReceipt(callback) {
  const receipt = String(callback && callback.receipt || '').trim().toUpperCase();
  return /^[A-Z0-9]{6,32}$/.test(receipt) ? receipt : null;
}

function callbackNeedsVerification(callback, transaction) {
  // A late authentic success may recover an earlier timeout. A callback
  // arriving after STK Query succeeded can also fill in the receipt without
  // crediting the subscription a second time.
  return transaction.status === 'pending' || (Number(callback.resultCode) === 0 &&
    (transaction.status === 'failed' || !transaction.mpesa_receipt));
}

function callbackMatchesTransaction(callback, transaction) {
  if (!transaction || !callback) return false;
  if (transaction.merchant_request_id &&
      String(callback.merchantRequestId || '') !== String(transaction.merchant_request_id)) {
    console.warn(`[callback] merchant request mismatch for ${transaction.checkout_request_id}`);
    return false;
  }
  // A successful STK callback includes the amount and paying number. These
  // values are not used to grant time, but rejecting mismatches prevents a
  // guessed checkout id from being paired with unrelated callback metadata.
  if (Number(callback.resultCode) === 0 && callback.amount !== undefined &&
      Math.round(Number(callback.amount)) !== Number(transaction.amount)) {
    console.warn(`[callback] amount mismatch for ${transaction.checkout_request_id}`);
    return false;
  }
  if (Number(callback.resultCode) === 0 && callback.phone !== undefined) {
    const paidBy = mpesa.normalizePhone(callback.phone);
    if (paidBy && transaction.phone && paidBy !== transaction.phone) {
      console.warn(`[callback] payer mismatch for ${transaction.checkout_request_id}`);
      return false;
    }
  }
  return true;
}

/**
 * Daraja callbacks do not carry a request signature. In production, treat
 * their payload only as a signal to query the checkout directly with the
 * merchant credentials; a forged HTTP POST must never create Wi-Fi time or
 * activate a business plan. Sandbox has no real funds and intentionally
 * keeps the direct callback behaviour used by the offline test suite.
 */
async function confirmCallbackResult(callback, transaction, query, ledgerName) {
  if (!callbackMatchesTransaction(callback, transaction)) return null;
  if (config.mpesa.env !== 'production') {
    return { settled: true, resultCode: Number(callback.resultCode), resultDesc: callback.resultDesc };
  }
  try {
    const result = await query();
    if (!result || !result.settled) {
      console.warn(`[${ledgerName} callback] checkout ${transaction.checkout_request_id} was not settled by Daraja query; leaving it pending`);
      return null;
    }
    return result;
  } catch (err) {
    console.warn(`[${ledgerName} callback] could not verify ${transaction.checkout_request_id}: ${err.message}`);
    return null;
  }
}

async function handleCallback(body) {
  const cb = mpesa.parseCallback(body);
  if (!cb) {
    console.warn('[callback] unrecognised payload:', JSON.stringify(body));
    return;
  }

  const tx = db.get.get(cb.checkoutRequestId);
  if (!tx) {
    const tenantTx = tenant.getTransaction.get(cb.checkoutRequestId);
    if (tenantTx) {
      await handleTenantCallback(cb, tenantTx);
      return;
    }
    const billingTx = tenant.businessBillingTransaction.get(cb.checkoutRequestId);
    if (billingTx) {
      await handleBusinessBillingCallback(cb, billingTx);
      return;
    }
    console.warn(`[callback] no transaction for ${cb.checkoutRequestId}`);
    return;
  }

  if (!callbackNeedsVerification(cb, tx)) {
    console.log(`[callback] ${cb.checkoutRequestId} already ${tx.status}, ignoring replay`);
    return;
  }

  const confirmed = await confirmCallbackResult(cb, tx, () => mpesa.stkQuery(tx.checkout_request_id), 'legacy');
  if (!confirmed) return;
  if (confirmed.resultCode !== 0) {
    db.markResult.run({
      checkoutRequestId: cb.checkoutRequestId,
      status: 'failed',
      resultCode: confirmed.resultCode,
      resultDesc: confirmed.resultDesc || cb.resultDesc,
      receipt: null,
    });
    console.log(`[callback] ${cb.checkoutRequestId} failed: ${confirmed.resultDesc || cb.resultDesc}`);
    return;
  }
  const receipt = callbackReceipt(cb);
  if (db.isDuplicateReceipt(receipt, cb.checkoutRequestId) ||
      tenant.duplicateReceipt.get(receipt, cb.checkoutRequestId) ||
      tenant.duplicateBusinessBillingReceipt.get(receipt, cb.checkoutRequestId)) {
    console.error(`[callback] receipt ${receipt} already banked elsewhere - not crediting again`);
    return;
  }

  db.markResult.run({
    checkoutRequestId: cb.checkoutRequestId,
    status: 'paid',
    resultCode: 0,
    resultDesc: confirmed.resultDesc || cb.resultDesc,
    receipt,
  });

  await fulfil(db.get.get(cb.checkoutRequestId));
}

async function handleTenantCallback(cb, tx) {
  if (!callbackNeedsVerification(cb, tx)) {
    console.log(`[tenant callback] ${cb.checkoutRequestId} already ${tx.status}, ignoring replay`);
    return;
  }
  const confirmed = await confirmCallbackResult(cb, tx, () => queryTenantMpesa(tx), 'tenant');
  if (!confirmed) return;
  if (confirmed.resultCode !== 0) {
    tenant.setTransactionResult.run({
      checkoutRequestId: cb.checkoutRequestId,
      status: 'failed', resultCode: confirmed.resultCode, resultDesc: confirmed.resultDesc || cb.resultDesc, receipt: null,
    });
    console.log(`[tenant callback] ${cb.checkoutRequestId} failed: ${confirmed.resultDesc || cb.resultDesc}`);
    return;
  }

  // A receipt is globally unique on M-Pesa. Check both the original live
  // hotspot ledger and the tenant ledger so a callback replay cannot grant
  // two businesses a package.
  const receipt = callbackReceipt(cb);
  if (db.isDuplicateReceipt(receipt, cb.checkoutRequestId) ||
      tenant.duplicateReceipt.get(receipt, cb.checkoutRequestId) ||
      tenant.duplicateBusinessBillingReceipt.get(receipt, cb.checkoutRequestId)) {
    console.error(`[tenant callback] receipt ${receipt} already banked elsewhere - not crediting again`);
    return;
  }

  tenant.setTransactionResult.run({
    checkoutRequestId: cb.checkoutRequestId,
    status: 'paid', resultCode: 0, resultDesc: confirmed.resultDesc || cb.resultDesc, receipt,
  });
  try {
    provisionTenantPayment(cb.checkoutRequestId);
  } catch (err) {
    // The payment stays paid and reconciliation will retry safely; the
    // idempotent grant ledger guarantees it cannot be credited twice.
    console.error(`[tenant callback] provisioning ${cb.checkoutRequestId} failed:`, err.message);
  }
}

async function handleBusinessBillingCallback(cb, transaction) {
  if (!callbackNeedsVerification(cb, transaction)) {
    console.log(`[business billing callback] ${cb.checkoutRequestId} already ${transaction.status}, ignoring replay`);
    return;
  }
  const confirmed = await confirmCallbackResult(cb, transaction, () => mpesa.stkQuery(transaction.checkout_request_id), 'business billing');
  if (!confirmed) return;
  if (confirmed.resultCode !== 0) {
    tenant.setBusinessBillingResult.run({ checkoutRequestId: cb.checkoutRequestId,
      status: 'failed', resultCode: confirmed.resultCode, resultDesc: confirmed.resultDesc || cb.resultDesc, receipt: null });
    return;
  }
  const receipt = callbackReceipt(cb);
  if (db.isDuplicateReceipt(receipt, cb.checkoutRequestId) ||
      tenant.duplicateReceipt.get(receipt, cb.checkoutRequestId) ||
      tenant.duplicateBusinessBillingReceipt.get(receipt, cb.checkoutRequestId)) {
    console.error(`[business billing callback] receipt ${receipt} already banked elsewhere - not activating plan`);
    return;
  }
  tenant.setBusinessBillingResult.run({ checkoutRequestId: cb.checkoutRequestId,
    status: 'paid', resultCode: 0, resultDesc: confirmed.resultDesc || cb.resultDesc, receipt });
  try {
    tenant.activateBusinessBilling(cb.checkoutRequestId);
  } catch (err) {
    console.error(`[business billing callback] activation ${cb.checkoutRequestId} failed:`, err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Two things go wrong in production and both strand a paying customer:
 * the callback never arrives, or it arrives while the router is unreachable.
 * This sweep covers both. It is not optional.
 */
/**
 * How long to wait before asking Daraja directly about a payment we have
 * not had a callback for.
 *
 * The Daraja SANDBOX frequently never sends the callback at all, so in
 * testing this sweep does all the work and its interval IS the customer's
 * wait. 15s is comfortably longer than a prompt takes to answer, so we
 * are not querying transactions that are still legitimately in flight,
 * but short enough that nobody is left staring at a spinner.
 */
const STALE_AFTER_SECONDS = 15;
const RECONCILE_EVERY_MS = 8_000;

async function reconcile() {
  for (const tx of db.stalePending.all(STALE_AFTER_SECONDS)) {
    try {
      const q = await mpesa.stkQuery(tx.checkout_request_id);
      if (!q.settled) continue;

      if (q.resultCode === 0) {
        db.markResult.run({
          checkoutRequestId: tx.checkout_request_id,
          status: 'paid',
          resultCode: 0,
          resultDesc: q.resultDesc,
          receipt: null, // query does not return the receipt number
        });
        console.log(`[reconcile] recovered lost callback for ${tx.checkout_request_id}`);
        await fulfil(db.get.get(tx.checkout_request_id));
      } else {
        const age = Date.now() - new Date(tx.created_at + 'Z').getTime();
        if (!Number.isFinite(age) || age < QUERY_FAILURE_AFTER_MS) continue;
        db.markResult.run({
          checkoutRequestId: tx.checkout_request_id,
          status: 'failed',
          resultCode: q.resultCode,
          resultDesc: q.resultDesc,
          receipt: null,
        });
      }
    } catch (err) {
      console.warn(`[reconcile] query failed for ${tx.checkout_request_id}:`, err.message);
    }
  }

  db.purgeOldJobs.run();

  for (const tx of db.paidUnprovisioned.all()) {
    try {
      await fulfil(tx);
      console.log(`[reconcile] provisioned backlog for ${tx.phone}`);
    } catch (err) {
      console.warn(`[reconcile] provisioning still failing for ${tx.phone}:`, err.message);
    }
  }

  for (const tx of tenant.staleTransactions.all(STALE_AFTER_SECONDS)) {
    try {
      const q = await queryTenantMpesa(tx);
      if (!q.settled) continue;
      if (q.resultCode === 0) {
        tenant.setTransactionResult.run({
          checkoutRequestId: tx.checkout_request_id,
          status: 'paid', resultCode: 0, resultDesc: q.resultDesc, receipt: null,
        });
        provisionTenantPayment(tx.checkout_request_id);
        console.log(`[tenant reconcile] recovered ${tx.checkout_request_id}`);
      } else {
        const age = Date.now() - new Date(tx.created_at + 'Z').getTime();
        if (!Number.isFinite(age) || age < QUERY_FAILURE_AFTER_MS) continue;
        tenant.setTransactionResult.run({
          checkoutRequestId: tx.checkout_request_id,
          status: 'failed', resultCode: q.resultCode, resultDesc: q.resultDesc, receipt: null,
        });
      }
    } catch (err) {
      console.warn(`[tenant reconcile] query failed for ${tx.checkout_request_id}:`, err.message);
    }
  }

  for (const tx of tenant.paidUnprovisioned.all()) {
    try {
      provisionTenantPayment(tx.checkout_request_id);
      console.log(`[tenant reconcile] provisioned backlog for ${tx.phone}`);
    } catch (err) {
      console.warn(`[tenant reconcile] provisioning still failing for ${tx.phone}:`, err.message);
    }
  }

  for (const tx of tenant.staleBusinessBilling.all(STALE_AFTER_SECONDS)) {
    try {
      const q = await mpesa.stkQuery(tx.checkout_request_id);
      if (!q.settled) continue;
      if (q.resultCode === 0) {
        tenant.setBusinessBillingResult.run({ checkoutRequestId: tx.checkout_request_id,
          status: 'paid', resultCode: 0, resultDesc: q.resultDesc, receipt: null });
        tenant.activateBusinessBilling(tx.checkout_request_id);
        console.log(`[business billing reconcile] renewed ${tx.business_id}`);
      } else {
        const age = Date.now() - new Date(tx.created_at + 'Z').getTime();
        if (!Number.isFinite(age) || age < QUERY_FAILURE_AFTER_MS) continue;
        tenant.setBusinessBillingResult.run({ checkoutRequestId: tx.checkout_request_id,
          status: 'failed', resultCode: q.resultCode, resultDesc: q.resultDesc, receipt: null });
      }
    } catch (err) {
      console.warn(`[business billing reconcile] query failed for ${tx.checkout_request_id}:`, err.message);
    }
  }

  for (const tx of tenant.paidBusinessBilling.all()) {
    try { tenant.activateBusinessBilling(tx.checkout_request_id); }
    catch (err) { console.warn(`[business billing reconcile] activation failed for ${tx.business_id}:`, err.message); }
  }
}

setInterval(() => reconcile().catch((e) => console.error('[reconcile]', e)), RECONCILE_EVERY_MS).unref();

/* ------------------------------------------------------------------ */
/* Session: what does this customer already have?                      */
/* ------------------------------------------------------------------ */

const { grantTime, remainingFor, generateCode } = require('./lib/grant');
const { findPackage: pkgById, PACKAGES: ALL_PACKAGES } = require('./packages');

/**
 * Looked up by device MAC on page load. A customer who already has time
 * must never be shown a payment screen - that is how people end up paying
 * twice for internet they already own.
 */
app.get('/api/session', (req, res) => {
  const mac = cleanMac(req.query.mac);
  if (!mac) return res.json({ found: false });

  const account = db.accountByMac.get(mac);
  if (!account) return res.json({ found: false });

  const info = remainingFor(account.phone);
  if (!info || info.remainingSeconds <= 0) return res.json({ found: false });

  res.json({
    found: true,
    phone: account.payer_phone || account.phone,
    phoneDisplay: mpesa.displayPhone(account.payer_phone || account.phone),
    username: info.phone,
    password: info.password,
    remainingSeconds: info.remainingSeconds,
    expiresAt: info.expiresAt,
    totalSeconds: info.totalSeconds,
    online: info.online,
  });
});

/** Same question, asked by typing a number instead of being recognised. */
app.post('/api/session/lookup', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Weka namba sahihi, kama 0712 345 678.' });
  }

  // `accountMac` is an explicit choice from the multi-device picker.
  // `mac` is the device currently viewing the captive portal.
  const requestedMac = cleanMac(req.body && (req.body.accountMac || req.body.mac));
  let accountId = phone;
  if (requestedMac) {
    const bound = db.accountByMac.get(requestedMac);
    if (bound && (bound.payer_phone || bound.phone) === phone) accountId = bound.phone;
  }
  if (accountId === phone) {
    const active = db.activeAccountsForPayer.all(phone);
    if (active.length === 1) accountId = active[0].phone;
    else if (active.length > 1) {
      return res.json({
        found: false,
        multiple: true,
        devices: active
          .filter((account) => account.last_mac)
          .map((account) => ({
            mac: account.last_mac,
            remainingSeconds: remainingFor(account.phone).remainingSeconds,
          })),
      });
    }
  }

  const info = remainingFor(accountId);
  if (!info || info.remainingSeconds <= 0) {
    return res.json({ found: false });
  }

  res.json({
    found: true,
    phoneDisplay: mpesa.displayPhone(phone),
    username: info.phone,
    password: info.password,
    remainingSeconds: info.remainingSeconds,
    expiresAt: info.expiresAt,
    online: info.online,
  });
});

/** Check before taking more money: a payer may already own usable time. */
app.post('/api/subscriptions/check', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid M-Pesa number.' });
  const subscriptions = db.activeAccountsForPayer.all(phone)
    .map((account) => ({
      username: account.phone,
      mac: account.last_mac,
      remainingSeconds: remainingFor(account.phone).remainingSeconds,
    }))
    .filter((account) => account.remainingSeconds > 0);
  res.json({ found: subscriptions.length > 0, subscriptions });
});

/** Password-authorised move of an existing subscription to this device. */
app.post('/api/subscriptions/transfer', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const username = String((req.body && req.body.username) || '');
  const suppliedPassword = String((req.body && req.body.password) || '').toUpperCase();
  const mac = cleanMac(req.body && req.body.mac);
  const ip = cleanIp(req.body && req.body.ip);
  if (!phone || !mac || !suppliedPassword) {
    return res.status(400).json({ error: 'Enter the WiFi password from the receipt.' });
  }

  const account = db.getAccount.get(username);
  const info = account && remainingFor(account.phone);
  const expected = Buffer.from(account ? account.password : '');
  const supplied = Buffer.from(suppliedPassword);
  const passwordOk = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  if (!account || (account.payer_phone || account.phone) !== phone || !passwordOk ||
      !info || info.remainingSeconds <= 0) {
    return res.status(403).json({ error: 'The selected package or WiFi password is incorrect.' });
  }

  db.rememberMac.run({ phone: account.phone, mac });
  db.transferUser.run({
    site: config.site.id, username: account.phone, password: account.password,
    profile: 'standard', totalSeconds: account.total_seconds, mac, ip,
  });
  console.log(`[transfer] ${account.phone} moved to ${mac}`);
  res.json({ ok: true, username: account.phone,
    remainingSeconds: info.remainingSeconds, expiresAt: info.expiresAt });
});

/* ------------------------------------------------------------------ */
/* Connect one TV to an existing account                              */
/* ------------------------------------------------------------------ */

// A TV can't open a captive portal, so its owner registers its MAC here
// from a phone. The device then rides on the owner's balance. Capped so
// one purchase can't quietly put a whole building online.
const MAX_DEVICES_PER_ACCOUNT = 1; // paying phone + 1 added device = 2 total

function deviceOwner(phone, ownerMac) {
  const mac = cleanMac(ownerMac);
  if (mac) {
    const account = db.accountByMac.get(mac);
    if (account && (account.payer_phone || account.phone) === phone) return account.phone;
  }
  const active = db.activeAccountsForPayer.all(phone);
  if (active.length === 1) return active[0].phone;
  if (active.length > 1) return null;
  const all = db.accountsForPayer.all(phone);
  if (all.length === 1) return all[0].phone;
  return all.length === 0 ? phone : null;
}

app.post('/api/device/add', async (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Enter the phone number you paid with.' });
  }

  // The MAC people read off a TV uses hyphens or nothing; accept both.
  const rawMac = String((req.body && req.body.mac) || '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');
  if (rawMac.length !== 12) {
    return res.status(400).json({
      error: 'That MAC address is not complete. It should be 12 characters.',
    });
  }
  const mac = rawMac.match(/.{2}/g).join(':');

  const label = String((req.body && req.body.label) || 'TV')
    .replace(/[^\w \-]/g, '')
    .slice(0, 24) || 'TV';

  const owner = deviceOwner(phone, req.body && req.body.ownerMac);
  if (!owner) {
    return res.status(409).json({
      error: 'This number has several devices. Open this page from the purchasing device.',
    });
  }
  const info = remainingFor(owner);
  if (!info || info.remainingSeconds <= 0) {
    return res.status(402).json({
      error: 'This number has no active time. Buy a package first, then add your TV.',
    });
  }

  // If the device already belongs to someone else, refuse rather than
  // silently move it - that would let a balance be hijacked.
  const existing = db.getDevice.get(mac);
  if (existing && existing.phone !== owner) {
    return res.status(409).json({
      error: 'That device is already connected to another number.',
    });
  }

  if (!existing && db.countDevices.get(owner).n >= MAX_DEVICES_PER_ACCOUNT) {
    // Name what's occupying the slot. "You've hit the limit" leaves the
    // customer guessing which device to remove.
    const owned = db.devicesFor.all(owner)
      .map((d) => d.label || 'a device').join(', ');
    return res.status(409).json({
      error:
        'Each subscription covers your paying phone and one TV. ' +
        `You have already added ${owned}. Remove it below to connect something else.`,
      atLimit: true,
    });
  }

  db.addDevice.run({ mac, phone: owner, label });

  // Queue a login for the TV's MAC under a separate, MAC-bound identity. In poll
  // mode the router picks this up within its interval; the TV needs no
  // portal and no typing.
  if (config.provisionMode === 'poll') {
    db.addJob.run({
      site: config.site.id,
      username: `${owner}-tv`,
      password: info.password,
      profile: 'standard',
      totalSeconds: info.totalSeconds,
      mac,
      ip: null,
    });
  }

  console.log(`[device] ${mac} (${label}) attached to ${owner}`);

  res.json({
    ok: true,
    mac,
    label,
    deviceCount: db.countDevices.get(owner).n,
    remainingSeconds: info.remainingSeconds,
  });
});

app.post('/api/device/list', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid number.' });

  const owner = deviceOwner(phone, req.body && req.body.ownerMac);
  if (!owner) return res.json({ devices: [], max: MAX_DEVICES_PER_ACCOUNT });

  const devices = db.devicesFor.all(owner).map((d) => ({
    mac: d.mac, label: d.label,
  }));
  res.json({ devices, max: MAX_DEVICES_PER_ACCOUNT });
});

app.post('/api/device/remove', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const mac = String((req.body && req.body.mac) || '').toUpperCase();
  if (!phone || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
    return res.status(400).json({ error: 'Bad request.' });
  }
  const owner = deviceOwner(phone, req.body && req.body.ownerMac);
  if (!owner) return res.status(409).json({ error: 'Open this page from the purchasing device.' });
  const removed = db.removeDevice.run({ mac, phone: owner });
  if (removed.changes && config.provisionMode === 'poll') {
    db.revokeUser.run({ site: config.site.id, username: `${owner}-tv` });
  }
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Vouchers                                                            */
/* ------------------------------------------------------------------ */

app.post('/api/voucher/redeem', async (req, res) => {
  const raw = String((req.body && req.body.code) || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (raw.length < 6 || raw.length > 24) {
    return res.status(400).json({ error: 'Hiyo code si sahihi.' });
  }

  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Weka namba yako ya simu pia.' });
  }

  const voucher = db.getVoucher.get(raw);
  if (!voucher) return res.status(404).json({ error: 'Code haipo. Angalia tena.' });
  if (voucher.redeemed_at) {
    return res.status(409).json({ error: 'Code hii imeshatumika.' });
  }

  // The WHERE clause is the lock: two simultaneous redemptions cannot
  // both report a change, so a code can only ever be spent once.
  const claimed = db.claimVoucher.run({ code: raw, phone });
  if (claimed.changes !== 1) {
    return res.status(409).json({ error: 'Code hii imeshatumika.' });
  }

  const pkg = pkgById(voucher.package_id);
  const result = await grantTime({
    phone,
    seconds: voucher.seconds,
    profile: pkg ? pkg.profile : 'standard',
    mac: cleanMac(req.body && req.body.mac),
    ip: cleanIp(req.body && req.body.ip),
    reason: `voucher ${raw}`,
  });

  res.json({
    ok: true,
    username: result.username,
    password: result.password,
    grantedSeconds: voucher.seconds,
  });
});

/** Batch generation. Protected by ADMIN_TOKEN; no token, no endpoint. */
app.post('/api/admin/vouchers', (req, res) => {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin || String(req.headers['x-admin-token'] || '') !== admin) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const pkg = pkgById((req.body && req.body.packageId) || '');
  if (!pkg) return res.status(400).json({ error: 'Unknown package.' });

  const count = Math.min(Math.max(Number(req.body.count) || 1, 1), 200);
  const batch = new Date().toISOString().slice(0, 10);
  const codes = [];

  for (let i = 0; i < count; i++) {
    const code = 'FITI' + generateCode(8);
    db.addVoucher.run({ code, packageId: pkg.id, seconds: pkg.seconds, batch });
    codes.push(code);
  }

  console.log(`[admin] issued ${count} ${pkg.id} voucher(s)`);
  res.json({ package: pkg.id, count, codes });
});

/* ------------------------------------------------------------------ */
/* Paybill fallback                                                    */
/* ------------------------------------------------------------------ */

/**
 * Some customers cancel the STK prompt, or their SIM toolkit misbehaves.
 * They can pay the shortcode manually instead, using their phone number
 * as the account reference. Safaricom posts the result here.
 */
app.post('/api/mpesa/c2b/confirmation', (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  setImmediate(async () => {
    try {
      const b = req.body || {};
      const phone = mpesa.normalizePhone(b.BillRefNumber || b.MSISDN);
      const amount = Math.round(Number(b.TransAmount));
      const receipt = String(b.TransID || '');

      if (!phone || !Number.isFinite(amount) || amount <= 0) {
        console.warn('[c2b] unusable payload:', JSON.stringify(b));
        return;
      }
      if (db.isDuplicateReceipt(receipt, '')) {
        console.log(`[c2b] receipt ${receipt} already banked, ignoring`);
        return;
      }

      // Buy the largest package the amount covers. Anything less than the
      // cheapest package is recorded but grants nothing - the customer is
      // told to top up rather than silently losing the money.
      const affordable = ALL_PACKAGES
        .filter((p) => p.price <= amount)
        .sort((a, b2) => b2.price - a.price)[0];

      if (!affordable) {
        console.warn(`[c2b] ${phone} sent ${amount} - below the cheapest package`);
        return;
      }

      await grantTime({
        phone,
        seconds: affordable.seconds,
        profile: affordable.profile,
        mac: null,
        ip: null,
        reason: `paybill ${receipt}`,
      });
    } catch (err) {
      console.error('[c2b] handler threw:', err);
    }
  });
});

app.post('/api/mpesa/c2b/validation', (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

/* ------------------------------------------------------------------ */
/* Ledger repair                                                       */
/* ------------------------------------------------------------------ */

/**
 * Rebuild an account's balance from its payment history.
 *
 * The transactions table is the record of money actually received, so it
 * is the only thing worth trusting when the ledger and the router have
 * drifted apart - a restored backup, a bug that overwrote totals, a
 * database that started life after the customer did.
 *
 * GET reports what it would do and changes nothing. POST applies it.
 */
function rebuildLedger(phone, apply) {
  const paid = db.paidTransactionsFor.all(phone);
  const purchased = paid.reduce((sum, tx) => sum + tx.seconds, 0);

  const account = db.getAccount.get(phone);
  const used = account ? (account.used_seconds || 0) : 0;
  const currentTotal = account ? account.total_seconds : 0;

  // A customer cannot have less time than they have already consumed, or
  // they are locked out of internet they paid for.
  const rebuiltTotal = Math.max(purchased, used);

  if (apply && account) {
    db.setTotal.run({ phone, totalSeconds: rebuiltTotal });
  }

  return {
    phone,
    payments: paid.length,
    purchasedSeconds: purchased,
    usedSeconds: used,
    previousTotal: currentTotal,
    rebuiltTotal,
    remainingAfter: Math.max(0, rebuiltTotal - used),
    applied: Boolean(apply && account),
    transactions: paid.map((tx) => ({
      package: tx.package_id,
      amount: tx.amount,
      seconds: tx.seconds,
      receipt: tx.mpesa_receipt,
      at: tx.created_at,
    })),
  };
}

function adminOk(req) {
  const admin = process.env.ADMIN_TOKEN;
  const supplied = String(req.headers['x-admin-token'] || '');
  if (!admin) return false;
  const expectedBytes = Buffer.from(admin);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

/** Platform lifecycle for a business-owned remote-support request. This is
 * intentionally an inventory/consent API: no key, endpoint credential or
 * router command is accepted here. The VPN hub integration comes later. */
app.patch('/api/admin/locations/:locationId/remote-access', (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const remoteAccess = tenant.manageRemoteAccess({
      locationId: String(req.params.locationId),
      action: req.body && req.body.action,
      managementAddress: req.body && req.body.managementAddress,
      hubName: req.body && req.body.hubName,
      actorId: 'platform-admin',
    });
    if (!remoteAccess) return res.status(404).json({ error: 'Location not found.' });
    res.json({ remoteAccess });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not update remote access.' });
  }
});

app.get('/api/admin/ledger/:phone', (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const phone = mpesa.normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Bad phone number.' });
  res.json(rebuildLedger(phone, false));
});

app.post('/api/admin/ledger/:phone/rebuild', (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const phone = mpesa.normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Bad phone number.' });

  const result = rebuildLedger(phone, true);

  // Push the corrected figure to the router so it takes effect now
  // rather than at the customer's next purchase.
  if (result.applied && config.provisionMode === 'poll') {
    const account = db.getAccount.get(phone);
    db.addJob.run({
      site: config.site.id,
      username: phone,
      password: account.password,
      profile: 'standard',
      totalSeconds: result.rebuiltTotal,
      mac: account.last_mac || null,
      ip: null,
    });
    result.queuedForRouter = true;
  }

  console.log(
    `[admin] rebuilt ${phone}: ${result.payments} payment(s), ` +
      `${result.previousTotal}s -> ${result.rebuiltTotal}s`
  );
  res.json(result);
});

/* ------------------------------------------------------------------ */
/* Router polling API                                                  */
/* ------------------------------------------------------------------ */

const { buildScript, buildExpiryScript, buildRemoteSupportScript } = require('./lib/rsc');

/** Constant-time compare so the token cannot be guessed by timing. */
function tokenOk(supplied) {
  const expected = config.site.token;
  if (!expected) return false;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authSite(req, res) {
  const site = String(req.query.site || '');
  if (site !== config.site.id || !tokenOk(req.query.token)) {
    res.status(403).type('text/plain').send('# forbidden\n');
    return null;
  }
  return site;
}

/** Tenant routers use their location id as `site` and a unique pairing
 * secret. Keep this branch deliberately separate from the legacy site so a
 * valid tenant acknowledgement can never touch the original hotspot jobs. */
function tenantRouterForRequest(req, res) {
  const site = String(req.query.site || '');
  if (!site.startsWith('loc-')) return null;
  const header = req.get('X-WiFi-Fiti-Router');
  const location = tenant.authenticateRouter(site, header || req.query.token, header ? 'header' : 'query');
  if (!location) {
    res.status(403).type('text/plain').send('# forbidden\n');
    return false;
  }
  return location;
}

function invalidRemoteSupportEnrollment() {
  const error = new Error('Invalid remote-support enrollment report.');
  error.status = 400;
  return error;
}

/**
 * This is intentionally a tiny, exact protocol rather than generic JSON:
 * RouterOS sends this raw text through /tool fetch, and strict field order
 * prevents a future option from being silently accepted. The report carries
 * no private key and the successful response carries no VPN configuration.
 */
function parseRemoteSupportEnrollment(rawBody, expectedLocationId) {
  if (typeof rawBody !== 'string') throw invalidRemoteSupportEnrollment();
  const match = /^version=1\nsite=([^\n]+)\ninterface=fiti-support-wg\npublic-key=([A-Za-z0-9+/]{43}=)\n$/.exec(rawBody);
  if (!match || match[1] !== expectedLocationId || Buffer.from(match[2], 'base64').length !== 32) {
    throw invalidRemoteSupportEnrollment();
  }
  return { publicKey: match[2] };
}

/**
 * The router reports its public WireGuard identifier after a future opt-in
 * job creates a disabled interface. Pairing is header-only here: accepting a
 * URL token would leak a router credential through request logs. The handler
 * is deliberately inert: it records nothing until platform approval and
 * returns 204, never a peer, endpoint, route, or activation instruction.
 */
app.post('/api/router/support-enroll', (req, res) => {
  const locationId = String(req.query.site || '');
  const location = tenant.authenticateRouter(locationId, req.get('X-WiFi-Fiti-Router'), 'header');
  if (!location) return res.status(403).type('text/plain').send('forbidden');
  if (location.router_pairing_auth !== 'active' || !location.router_setup_verified_at) {
    return res.status(409).type('text/plain').send('router setup is not verified');
  }
  try {
    const { publicKey } = parseRemoteSupportEnrollment(req.body, location.id);
    tenant.recordRemoteAccessEnrollment({ locationId: location.id, publicKey });
    return res.status(204).end();
  } catch (error) {
    return res.status(error.status || 500).type('text/plain').send(
      error.status ? error.message : 'Could not record remote-support enrollment.'
    );
  }
});

function routerAckIds(value) {
  return String(value || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);
}

function routerSetupReceiptScript(challenge) {
  if (!challenge) return '';
  return [
    ':global fitiSetupAck',
    `:set fitiSetupAck "${challenge}"`,
    ':log info "fiti: setup receipt queued"',
  ].join('\n') + '\n';
}

function hydratedRemoteSupportControls(controls) {
  const hydrated = [];
  const rejected = [];
  for (const control of controls || []) {
    if (!control || control.action !== 'activate') {
      hydrated.push(control);
      continue;
    }
    try {
      const payload = JSON.parse(String(control.payload_json || ''));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('not an object');
      hydrated.push({
        id: control.id,
        action: 'activate',
        ...payload,
        // The database version, not a payload value, is the authoritative
        // replay boundary for the RouterOS activation script.
        configVersion: String(control.config_version),
      });
    } catch (_) {
      // A corrupt persistent control must never be rendered as RouterOS
      // source. Keep it queued for an operator/database recovery instead of
      // marking it delivered and losing the evidence.
      rejected.push(control.id);
    }
  }
  return { controls: hydrated, rejected };
}

function tenantRouterScript(location, { reportedPortalAppliedHost, reportedPortalHost } = {}) {
  // A candidate replacement must not collect jobs or acknowledge old work
  // before it has completed the receipt challenge. This protects a live
  // router from a partially imported or misdirected replacement kit.
  if (location.router_pairing_auth === 'pending' || !location.router_setup_verified_at) {
    return { script: '', emitted: [], rejected: [], supportEmitted: [], supportRejected: [] };
  }
  tenant.queueExpiredSubscriptions(location.id);
  const jobs = tenant.pendingJobs.all(location.id);
  const controls = tenant.pendingRemoteSupportControls.all(location.id);
  const portal = routerPortalRefreshScript(location, { reportedPortalAppliedHost, reportedPortalHost });
  if (!jobs.length && !controls.length) {
    return { script: portal, emitted: [], rejected: [], supportEmitted: [], supportRejected: [] };
  }

  // Support controls always use their own queue and ACK global. They are
  // emitted before customer provisioning so a requested cleanup cannot be
  // held behind a large batch of ordinary HotSpot work.
  const hydratedControls = hydratedRemoteSupportControls(controls);
  const support = buildRemoteSupportScript({ controls: hydratedControls.controls });
  support.rejected.push(...hydratedControls.rejected);
  for (const id of support.emitted) tenant.markRemoteSupportControlDelivered.run(id);
  if (support.rejected.length) {
    console.error(`[tenant router] ${location.id} refused malformed support control(s): ${support.rejected.join(', ')}`);
  }
  if (support.emitted.length) {
    console.log(`[tenant router] ${location.id} collected support control(s) ${support.emitted.join(', ')}`);
  }

  if (!jobs.length) {
    return { script: [portal, support.script].filter(Boolean).join('\n'), emitted: [], rejected: [], supportEmitted: support.emitted, supportRejected: support.rejected };
  }

  const { script, emitted, rejected } = buildScript({
    jobs,
    hotspotServer: location.hotspot_server || config.site.hotspotServer,
  });
  for (const id of emitted) tenant.markDelivered.run(id);
  if (rejected.length) {
    console.error(`[tenant router] ${location.id} refused malformed jobs: ${rejected.join(', ')}`);
  }
  if (emitted.length) console.log(`[tenant router] ${location.id} collected job(s) ${emitted.join(', ')}`);
  return {
    script: [portal, support.script, script].filter(Boolean).join('\n'),
    emitted,
    rejected,
    supportEmitted: support.emitted,
    supportRejected: support.rejected,
  };
}

function acknowledgeTenantRouterJobs(location, value) {
  const ids = routerAckIds(value);
  for (const id of ids) tenant.markAcked.run(id, location.id);
  if (ids.length) console.log(`[tenant router] ${location.id} acked ${ids.join(', ')}`);
  return ids;
}

function acknowledgeTenantRemoteSupportControls(location, value) {
  const ids = routerAckIds(value);
  for (const id of ids) tenant.markRemoteSupportControlAcked.run(id, location.id);
  if (ids.length) console.log(`[tenant router] ${location.id} acked support control(s) ${ids.join(', ')}`);
  return ids;
}

function ingestTenantUsage(location, rawBody) {
  const raw = typeof rawBody === 'string' ? rawBody : '';
  let updated = 0;
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(':');
    if (parts.length < 2) continue;
    const username = parts[0].trim();
    const used = Number(parts[1]);
    if (!/^254[17]\d{8}(?:-[0-9A-F]{8})?(?:-tv)?$/.test(username) || username.endsWith('-tv')) continue;
    if (!Number.isFinite(used) || used < 0) continue;
    const isActive = parts.length > 3 && parts[3].trim() === '1' ? 1 : 0;
    tenant.recordUsage.run({ locationId: location.id, routerUsername: username,
      usedSeconds: Math.round(used), isActive });
    updated++;
  }
  if (updated) console.log(`[tenant router] ${location.id} reported usage for ${updated} user(s)`);
}

/**
 * Inventory travels inside the normal authenticated poll and is deliberately
 * best-effort. A malformed or outdated topology block must never prevent
 * customer billing, expiry jobs, acknowledgements, or the next poll from
 * succeeding. The parser accepts only the narrow non-secret grammar in
 * router-topology.js and tenant storage hashes its canonical result.
 */
function ingestTenantTopology(location, rawBody) {
  try {
    const report = parseRouterTopology(typeof rawBody === 'string' ? rawBody : '');
    if (!report) return null;
    return tenant.recordRouterTopology({ locationId: location.id, ...report });
  } catch (error) {
    // Do not echo or log router input—interface names may be customer chosen.
    // This is observability-only data; silently ignore an invalid snapshot so
    // the same request remains a safe billing/control-plane poll.
    return null;
  }
}

/**
 * A router asks what work is waiting. The reply is RouterOS script, which
 * the router parses and runs in memory - no file written, no flash wear.
 * Empty means nothing to do, which is the common case.
 */
app.get('/api/router/jobs', (req, res) => {
  const location = tenantRouterForRequest(req, res);
  if (location === false) return;
  if (location) return res.type('text/plain').send(tenantRouterScript(location, {
    reportedPortalAppliedHost: req.query.portalApplied,
    reportedPortalHost: req.query.portal,
  }).script);

  const site = authSite(req, res);
  if (!site) return;

  const jobs = db.pendingJobs.all(site);
  if (!jobs.length) return res.type('text/plain').send('');

  const { script, emitted, rejected } = buildScript({
    jobs,
    hotspotServer: config.site.hotspotServer,
  });

  for (const id of emitted) db.markDelivered.run(id);

  if (rejected.length) {
    console.error(
      `[router] refused to emit malformed jobs: ${rejected.join(', ')}`
    );
  }
  if (emitted.length) {
    console.log(`[router] ${site} collected job(s) ${emitted.join(', ')}`);
  }

  res.type('text/plain').send(script);
});

/**
 * The router reports diagnostics and collects new work in the same round
 * trip. Subscription time itself comes from the server's absolute expiry;
 * the response also disconnects accounts whose expiry has passed.
 *
 * Body is plain text, one line per user: username:used:limit
 */
app.post('/api/router/sync', (req, res) => {
  const location = tenantRouterForRequest(req, res);
  if (location === false) return;
  if (location) {
    const receipt = tenant.processRouterSetupReceipt(location, {
      protocol: req.query.protocol,
      ack: req.query.setupAck,
      health: req.query.health,
    });
    if (!receipt.verified) {
      // The response is deliberately receipt-only. Do not accept usage,
      // jobs, or support controls until the router proves it executed a prior
      // response. A dropped response cannot be mistaken for a paired router.
      return res.type('text/plain').send(routerSetupReceiptScript(receipt.challenge));
    }
    let readyLocation = tenant.autoCompleteCustomerPortal(receipt.location.id) || receipt.location;
    // Automatic kits discover the live Hotspot and customer bridge on the
    // router. Persist those detected names before emitting queued jobs so a
    // custom Hotspot is never addressed as the default `hotspot1`.
    const reportedHotspot = String(req.query.hotspot || '').trim();
    const reportedBridge = String(req.query.bridge || '').trim();
    if ((reportedHotspot && /^[A-Za-z0-9_-]{1,32}$/.test(reportedHotspot)) || (reportedBridge && /^[A-Za-z0-9_-]{1,32}$/.test(reportedBridge))) {
      readyLocation = tenant.updateLocationSettings({
        locationId: readyLocation.id,
        businessId: readyLocation.business_id,
        hotspotServer: reportedHotspot || readyLocation.hotspot_server,
        setup: reportedBridge ? { customerBridge: reportedBridge } : {},
      }) || readyLocation;
    }
    const appliedHost = edgeHostname(req.query.portalApplied);
    if (appliedHost && appliedHost === edgeHostname(readyLocation.portal_hostname)) {
      readyLocation = tenant.recordRouterPortalApplied(readyLocation.id, appliedHost);
    }
    acknowledgeTenantRouterJobs(readyLocation, req.query.ack);
    acknowledgeTenantRemoteSupportControls(readyLocation, req.query.supportAck);
    ingestTenantTopology(readyLocation, req.body);
    ingestTenantUsage(readyLocation, req.body);
    const response = tenantRouterScript(readyLocation, {
      reportedPortalAppliedHost: req.query.portalApplied,
      reportedPortalHost: req.query.portal,
    }).script;
    return res.type('text/plain').send(response);
  }

  const site = authSite(req, res);
  if (!site) return;

  // Jobs the router ran last cycle. This replaces the old separate ack
  // fetch, which failed silently and caused endless redelivery.
  const acked = String(req.query.ack || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);

  for (const id of acked) db.markAcked.run(id, site);
  if (acked.length) console.log(`[router] ${site} acked ${acked.join(', ')}`);

  // Defensive: if anything upstream ever hands us a non-string again,
  // degrade to "no usage reported" rather than throwing.
  const raw = typeof req.body === 'string' ? req.body : '';
  const lines = raw.split('\n');
  let updated = 0;

  for (const line of lines) {
    const parts = line.trim().split(':');
    if (parts.length < 2) continue;

    const phone = parts[0].trim(); // Router username / subscription id
    const used = Number(parts[1]);
    if (!/^254[17]\d{8}(?:-[0-9A-F]{8})?(?:-tv)?$/.test(phone)) continue;
    if (phone.endsWith('-tv')) continue; // TV shares its owner's wall-clock balance
    if (!Number.isFinite(used) || used < 0) continue;

    // Fourth field is "1" when the customer has a live session. Older
    // routers send three fields; treat those as offline rather than
    // guessing, so an out-of-date router cannot drain balances.
    const isActive = parts.length > 3 && parts[3].trim() === '1' ? 1 : 0;
    const usedNow = Math.round(used);

    // Usage going backwards means the router's counters were reset, or the
    // user was recreated. The total still includes time the router has now
    // forgotten, so without an adjustment the customer's remaining balance
    // would jump up by however much they had already consumed.
    const before = db.getAccount.get(phone);
    if (before && usedNow < (before.used_seconds || 0)) {
      const delta = (before.used_seconds || 0) - usedNow;
      db.reduceTotal.run({ phone, delta });
      console.log(
        `[router] ${phone} counters reset (${before.used_seconds}s -> ${usedNow}s); ` +
          `total reduced by ${delta}s to keep remaining time honest`
      );
    }

    db.recordUsage.run({ phone, usedSeconds: usedNow, isActive });
    updated++;
  }

  if (updated) console.log(`[router] ${site} reported usage for ${updated} user(s)`);

  const jobs = db.pendingJobs.all(site);
  const expiryScript = buildExpiryScript(db.expiredAccounts.all());
  if (!jobs.length) return res.type('text/plain').send(expiryScript);

  const { script, emitted, rejected } = buildScript({
    jobs, hotspotServer: config.site.hotspotServer,
  });

  for (const id of emitted) db.markDelivered.run(id);
  if (rejected.length) {
    console.error(`[router] refused malformed jobs: ${rejected.join(', ')}`);
  }
  if (emitted.length) console.log(`[router] ${site} collected job(s) ${emitted.join(', ')}`);

  res.type('text/plain').send([expiryScript, script].filter(Boolean).join('\n'));
});

/** The router confirms it ran the work. Unacked jobs get redelivered. */
app.get('/api/router/ack', (req, res) => {
  const location = tenantRouterForRequest(req, res);
  if (location === false) return;
  if (location) {
    acknowledgeTenantRouterJobs(location, req.query.ids);
    acknowledgeTenantRemoteSupportControls(location, req.query.supportIds || req.query.supportAck);
    return res.type('text/plain').send('# ok\n');
  }

  const site = authSite(req, res);
  if (!site) return;

  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);

  for (const id of ids) db.markAcked.run(id, site);
  if (ids.length) console.log(`[router] ${site} acked ${ids.join(', ')}`);

  res.type('text/plain').send('# ok\n');
});

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/health', async (req, res) => {
  const out = { ok: true, mpesaEnv: config.mpesa.env, database: db.stats() };

  out.provisionMode = config.provisionMode;

  if (config.provisionMode === 'poll') {
    out.site = config.site.id;
    out.pendingJobs = db.pendingJobs.all(config.site.id).length;
    out.tokenSet = Boolean(config.site.token);
    if (!out.tokenSet) {
      out.ok = false;
      out.note = 'SITE_TOKEN is not set - routers cannot authenticate.';
    }
    return res.status(out.ok ? 200 : 503).json(out);
  }

  if (!config.mikrotik.configured) {
    out.router = { configured: false, note: 'Payments work; access is not granted.' };
    return res.json(out);
  }

  try {
    out.router = await mikrotik.testConnection();
  } catch (err) {
    out.ok = false;
    out.router = { error: err.message };
  }
  res.status(out.ok ? 200 : 503).json(out);
});

require('./lib/business-operations').attachBusinessOperations(app, { businessAuth, tenant, db, config, adminOk });

app.listen(config.port, () => {
  console.log(`${config.brandName} hotspot billing on :${config.port}`);
  console.log(`M-Pesa environment: ${config.mpesa.env}`);
  console.log(`Callback URL: ${config.publicUrl}/api/mpesa/callback`);
  if (config.mpesa.env === 'sandbox') {
    console.log('Sandbox mode - no real money will move.');
  }
  const s = db.stats();
  console.log(
    `Database: ${s.path} ` +
      `(${s.transactions} payments, ${s.accounts} accounts, ${s.devices} devices)`
  );

  // On Railway, Render and similar the container filesystem is rebuilt on
  // every deploy. A database outside a mounted volume therefore loses every
  // payment record each time you push - silently, because a fresh empty
  // database works perfectly well. Customers simply find their balance gone.
  const onVolume = /^\/(data|mnt|var\/data|storage)\b/.test(s.path);
  if (!onVolume) {
    console.warn(
      '\n*** WARNING: the database is NOT on a mounted volume. ***\n' +
      `    ${s.path}\n` +
      '    Every deploy will erase all payments, balances and devices.\n' +
      '    Mount a volume and set DATABASE_PATH to a path inside it.\n'
    );
  }

  console.log(`Provisioning mode: ${config.provisionMode}`);
  if (config.provisionMode === 'poll') {
    console.log(`Site: ${config.site.id}`);
    if (!config.site.token) {
      console.log('WARNING: SITE_TOKEN is empty - no router can collect jobs.');
    }
    // Apply the new device locks to subscriptions that existed before this
    // release. Jobs are absolute and idempotent, so doing this once per
    // deployment is safe even if Railway restarts during delivery.
    let migrated = 0;
    for (const account of db.activeAccounts.all()) {
      if (account.last_mac) {
        db.addJob.run({
          site: config.site.id, username: account.phone,
          password: account.password, profile: 'standard',
          totalSeconds: account.total_seconds, mac: account.last_mac, ip: null,
        });
        migrated++;
      }
      for (const device of db.devicesFor.all(account.phone)) {
        db.addJob.run({
          site: config.site.id, username: `${account.phone}-tv`,
          password: account.password, profile: 'standard',
          totalSeconds: account.total_seconds, mac: device.mac, ip: null,
        });
      }
    }
    if (migrated) console.log(`[devices] queued ${migrated} existing phone lock(s)`);
  } else if (!config.mikrotik.configured) {
    console.log(
      'No router configured - payments are processed and recorded, but ' +
      'nobody gets internet.'
    );
  }
});

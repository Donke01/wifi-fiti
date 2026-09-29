const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const db = require('./lib/db');
const tenant = require('./lib/tenant');
const tenantAccess = require('./lib/tenant-access');
const tenantMpesa = require('./lib/tenant-mpesa');
const tuma = require('./lib/tuma');
const mpesa = require('./lib/mpesa');
const mikrotik = require('./lib/mikrotik');
const { fulfil } = require('./lib/fulfil');
const { validateRouterSetup, buildExistingRouterBootstrap, buildRouterSetup, buildUniversalRouterKit } = require('./lib/router-setup');
const { parseRouterTopology, parseRouterInventory } = require('./lib/router-topology');
const routerChanges = require('./lib/router-changes');
const routerTools = require('./lib/router-tools');
const { PACKAGES, findPackage } = require('./packages');
const { purchaseDeviceType, normaliseTvMac, normaliseDeviceLabel } = require('./lib/device-purchase');
const { sendEmail, verificationEmail } = require('./lib/email');
const { compatibilityRouterKit, telemetryTestRouterKit, vlanOverlayRouterKit, universalInstaller, inventoryScriptUpdate, INVENTORY_AGENT } = require('./lib/router-kit');
const pppoe = require('./lib/pppoe');
const pppoeBilling = require('./lib/pppoe-billing');
const whatsapp = require('./lib/whatsapp');
const whatsappNotifications = require('./lib/whatsapp-notifications');
const paymentIntegrations = require('./lib/payment-integrations');
const mpesaCallbackGuard = require('./lib/mpesa-callback-guard');
const serviceBilling = require('./lib/service-billing');
const { createTumaTenants } = require('./lib/tuma-tenants');
const { createTumaFee, FEE_KES: TUMA_FEE_KES } = require('./lib/tuma-fee');
// One free trial per owner phone, payout account and ID name.
const trialGuard = require('./lib/trial-guard').createTrialGuard({ db: db.db, normalizePhone: mpesa.normalizePhone });
trialGuard.backfillPhones();
// Owner phones are verified by SMS before they count for the one-trial rule
// and before a trial workspace can sell. Without an SMS provider the phone
// is recorded at sign-up as before.
const { createPhoneVerification } = require('./lib/phone-verify');
const ownerSms = require('./lib/fiti-signal').createAfricaTalkingProviderFromEnv();
const phoneVerification = createPhoneVerification({ db: db.db, normalizePhone: mpesa.normalizePhone, displayPhone: mpesa.displayPhone,
  send: ownerSms ? (message) => ownerSms.send(message) : null,
  onVerified: (businessId, phone) => trialGuard.check(businessId, { phone }) });
// Trial workspaces must verify the owner phone before selling or creating a
// Tuma account (only enforced when SMS verification is available).
function ownerPhoneBlock(business) {
  if (!phoneVerification.available() || !trialLimited(business) || phoneVerification.verified(business)) return null;
  return 'Verify your phone number to start taking payments on your free trial.';
}
// Created early: sales checks and the reminder worker both read it.
const tumaFee = createTumaFee({ db: db.db });
const { createDemo } = require('./lib/demo');

const app = express();
app.set('trust proxy', 1);
// Portal traffic reaches us through the Cloudflare edge gateway, so every
// request would otherwise share the Worker's address. Trust the client IP
// it forwards only when the edge secret is valid.
app.use((req, res, next) => {
  const forwarded = String(req.get('X-WiFi-Fiti-Client-IP') || '').trim();
  if (forwarded && forwarded.length <= 45 && /^[0-9a-fA-F:.]+$/.test(forwarded) && edgeGatewayAuthenticated(req)) {
    Object.defineProperty(req, 'ip', { value: forwarded, configurable: true });
  }
  next();
});
app.use((req, res, next) => {
  // Captive portal links carry RouterOS values and one-time pairing URLs can
  // carry a router credential. Do not let browsers forward either to a
  // third-party asset or destination.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The signed-in dashboard embeds the exact customer portal in its live
  // template preview. Keep every other page frame-protected; only this
  // same-origin, data-free preview route may be embedded.
  res.setHeader('X-Frame-Options', req.path === '/tenant-portal.html' && req.query.preview === '1' ? 'SAMEORIGIN' : 'DENY');
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

function publicHostname() {
  try { return new URL(String(config.publicUrl || '')).hostname || null; } catch (_) { return null; }
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
    // A router can remain paired while its HotSpot was disabled by a prior
    // offboard/test action.  Re-enable only the configured customer server as
    // part of the portal refresh; offboarding removes/locks the router and is
    // handled separately by the command queue.
    ':if ([:len [/ip hotspot find where name=$fitiHotspotServer]] = 1) do={ /ip hotspot enable [find where name=$fitiHotspotServer] }',
    // Avoid RouterOS's local dns-name alias (for example login.net) taking
    // over desktop captive assistants before they follow the external portal.
    ':if ([:len [/ip hotspot find where name=$fitiHotspotServer]] = 1) do={ :local fitiProfile [/ip hotspot get [find where name=$fitiHotspotServer] profile]; /ip hotspot profile set [find where name=$fitiProfile] dns-name="" }',
    '  :if ([:len [/ip hotspot walled-garden find where dst-host=$fitiDesiredPortalHost]] = 0) do={ /ip hotspot walled-garden add dst-host=$fitiDesiredPortalHost comment="Wi-Fi Fiti customer portal" }',
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
  // the public Wi-Fi Fiti Business site.
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

const DEMO_PAGES = {
  '/demo': 'demo.html',
  '/demo/try': 'demo-try.html',
  '/demo/dashboard': 'demo-dashboard.html',
};

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
    if (isGet && (req.path === '/business' || req.path === '/business.html' || req.path === '/operations.html')) {
      return redirectToApp(req, res);
    }
    // "Request a demo" and the live demos run on the app host, where their
    // API and payment callback live. Keep short /demo links on the root.
    if (isGet && DEMO_PAGES[req.path]) return redirectToApp(req, res);
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
    if (isGet && req.path === '/business') return res.sendFile(path.join(publicDirectory, 'business.html'));
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
    if (host !== config.domains.appHost && isGet && (req.path === '/business' || req.path === '/business.html' || req.path === '/operations.html')) return redirectToApp(req, res);
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
app.use('/api/router/tool', express.text({ type: '*/*', limit: '16kb' }));
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
// Compatibility installer for older RouterOS CA stores. It contains no
// location secret; the authenticated bootstrap decides when to reference it.
app.get('/tenant-router-install-compat.rsc', (req, res) => {
  try {
    const source = fs.readFileSync(path.join(publicDirectory, 'tenant-router-install.rsc'), 'utf8');
    res.type('text/plain').send(compatibilityRouterKit(source));
  } catch (_) { res.status(404).type('text/plain').send('# installer unavailable\n'); }
});
// Isolated telemetry test installer. The production tenant-router-install.rsc
// remains untouched; only a test bootstrap is allowed to reference this path.
app.get('/tenant-router-install-telemetry-test.rsc', (req, res) => {
  try {
    const source = fs.readFileSync(path.join(publicDirectory, 'tenant-router-install.rsc'), 'utf8');
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send(telemetryTestRouterKit(source));
  } catch (_) { res.status(404).type('text/plain').send('# telemetry test installer unavailable\n'); }
});
// The roots Wi-Fi Fiti's certificates chain to, for routers that have no
// built-in CA store (the hAP lite). Public and served without a certificate
// check on the router's side; the connection kit accepts only these exact
// certificates, by SHA-256 fingerprint, so a tampered copy is never trusted.
const ROUTER_ROOT_NAMES = ['ISRG Root X1', 'ISRG Root X2', 'GTS Root R1', 'GTS Root R4'];
const ROUTER_ROOTS_PEM = (() => {
  const tls = require('node:tls'); const { X509Certificate } = require('node:crypto');
  return ROUTER_ROOT_NAMES.map((cn) => tls.rootCertificates.find((pem) => new X509Certificate(pem).subject.split('\n').includes('CN=' + cn)))
    .filter(Boolean).map((pem) => pem.trim() + '\n').join('');
})();
app.get('/router-roots.pem', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('text/plain').send(ROUTER_ROOTS_PEM);
});
// The current UTC time for a router whose clock is wrong (a reset hAP lite
// often starts weeks behind, so every certificate looks "not valid yet").
// Public, no credential: "2026-09-28 12:50:05 sep/28/2026" — the RouterOS 7
// date, the time, then the older RouterOS date format.
app.get('/router-time', (req, res) => {
  const now = new Date();
  const iso = now.toISOString();
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const legacy = `${months[now.getUTCMonth()]}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain').send(`${iso.slice(0, 10)} ${iso.slice(11, 19)} ${legacy}`);
});

// Universal kit installer (test slot): the stable installer, transformed to
// pair a router without changing its network. Only the universal kit uses it.
app.get('/tenant-router-install-universal.rsc', (req, res) => {
  try {
    const source = fs.readFileSync(path.join(publicDirectory, 'tenant-router-install.rsc'), 'utf8');
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send(universalInstaller(source));
  } catch (error) {
    console.error('[router] universal installer unavailable:', error.message);
    res.status(404).type('text/plain').send('# universal installer unavailable\n');
  }
});
app.get('/tenant-router-install-universal-compat.rsc', (req, res) => {
  try {
    const source = fs.readFileSync(path.join(publicDirectory, 'tenant-router-install.rsc'), 'utf8');
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send(compatibilityRouterKit(universalInstaller(source)));
  } catch (error) {
    console.error('[router] universal compatibility installer unavailable:', error.message);
    res.status(404).type('text/plain').send('# universal installer unavailable\n');
  }
});
// Clean dashboard alias. Keep business.html available for existing bookmarks
// and for older integrations that still use the filename.
app.get('/business', (req, res) => res.sendFile(path.join(publicDirectory, 'business.html')));
for (const [route, file] of Object.entries(DEMO_PAGES)) app.get(route, (req, res) => res.sendFile(path.join(publicDirectory, file)));
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
const LEGACY_CUSTOMER_POSTS = new Set(['/api/session/lookup', '/api/subscriptions/check', '/api/subscriptions/transfer',
  '/api/device/add', '/api/device/list', '/api/device/remove', '/api/voucher/redeem', '/api/pay']);
// Routes that check a secret (recovery code, receipt, claim code, voucher).
const SECRET_CHECKING_POSTS = /\/(subscriptions\/transfer|devices\/(add|remove)|payment-recover|voucher\/redeem|claim)$/;
app.use((req, res, next) => {
  const path = req.path;
  let key, maximum, windowMs;
  if (path === '/api/business/login' || path === '/api/business/register') {
    key = path + ':' + req.ip;
    maximum = path.endsWith('register') ? 20 : 50;
    windowMs = 15 * 60_000;
  } else if (req.method === 'POST' && ['/api/business/forgot-password', '/api/business/reset-password', '/api/business/verify-login',
    '/api/business/verify-registration', '/api/business/resend-code', '/api/business/phone/verify/confirm'].includes(path)) {
    // Code-checking and code-sending routes, per address.
    key = path + ':' + req.ip;
    maximum = 20;
    windowMs = 15 * 60_000;
  } else if (path.startsWith('/api/admin/')) {
    // The platform desk is token-protected, but bound its guessing surface
    // as well. This leaves room for an operator to refresh the desk without
    // allowing unlimited token attempts from one address.
    key = '/api/admin:' + req.ip;
    maximum = 30;
    windowMs = 5 * 60_000;
  } else if (req.method === 'POST' && (path === '/api/demo/requests' || path === '/api/demo/pay')) {
    // Public, unauthenticated forms. The pay route also has its own per-phone
    // and daily caps so nobody can use it to spam strangers with prompts.
    key = path + ':' + req.ip;
    maximum = path.endsWith('/pay') ? 8 : 10;
    windowMs = 15 * 60_000;
  } else if (req.method === 'POST' && (path.startsWith('/api/tenant/') || LEGACY_CUSTOMER_POSTS.has(path))) {
    // Customers behind one hotspot share the router's public IP, so the key
    // includes the phone/package being acted on. Two more budgets stop that
    // being gamed: one per IP for the whole location whatever identity is
    // sent, and one per phone/package across all IPs (a distributed guess
    // at one customer's recovery code).
    const identity = String(req.body && (req.body.phone || req.body.subscriptionId || req.body.mac) || '').slice(0, 100);
    const scope = path.startsWith('/api/tenant/') ? path.split('/').slice(0, 4).join('/') : '/api/legacy';
    const perIpIdentity = tenantAccess.allowed(path + ':' + req.ip + ':' + identity, path.endsWith('/pay') ? 12 : 40, 5 * 60_000);
    const perIp = tenantAccess.allowed(scope + ':ip:' + req.ip, 600, 5 * 60_000);
    const secretGuess = SECRET_CHECKING_POSTS.test(path) && identity
      ? tenantAccess.allowed(path + ':id:' + identity, 20, 15 * 60_000) : { allowed: true };
    const blocked = [perIpIdentity, perIp, secretGuess].find((limit) => !limit.allowed);
    if (blocked) return res.status(429).set('Retry-After', String(blocked.retryAfter))
      .json({ error: 'Too many attempts. Please wait a few minutes before trying again.' });
  } else if (path.startsWith('/api/pppoe-pay/')) {
    // The PPPoE pay page is public: bound how fast one address can look up
    // account numbers (masked, but still a list), try phone numbers against
    // an account, or start prompts.
    const lookup = /\/account\/[^/]+$/.test(path) && req.method === 'GET';
    const verify = path.endsWith('/verify');
    const limits = [
      tenantAccess.allowed('pppoe-pay:ip:' + req.ip, 300, 5 * 60_000),
      lookup ? tenantAccess.allowed('pppoe-pay:lookup:' + req.ip, 40, 5 * 60_000) : { allowed: true },
      verify ? tenantAccess.allowed('pppoe-pay:verify:' + req.ip, 10, 15 * 60_000) : { allowed: true },
      verify ? tenantAccess.allowed('pppoe-pay:verify-account:' + path, 8, 15 * 60_000) : { allowed: true },
      path.endsWith('/pay') ? tenantAccess.allowed('pppoe-pay:prompt:' + req.ip, 12, 5 * 60_000) : { allowed: true },
    ];
    const blocked = limits.find((limit) => !limit.allowed);
    if (blocked) return res.status(429).set('Retry-After', String(blocked.retryAfter))
      .json({ error: 'Too many attempts. Please wait a few minutes before trying again.' });
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
const googleOAuthStates = new Map();

function googleOAuthConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const validClientId = /^[0-9A-Za-z_-]+\.apps\.googleusercontent\.com$/.test(clientId);
  const validClientSecret = clientSecret.length >= 16 && clientSecret !== '...';
  return validClientId && validClientSecret ? { clientId, clientSecret } : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [state, value] of googleOAuthStates) {
    if (!value || value.expiresAt <= now) googleOAuthStates.delete(state);
  }
}, 60_000).unref();

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
    // Customer-facing portals must use the tenant's support contact. Do not
    // silently substitute Wi‑Fi Fiti's platform number when a tenant has not
    // configured one.
    supportPhone: business && business.support_phone || '',
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
  // Workspace access has no platform subscription.  Keep these internal
  // entitlement names for backwards-compatible records and limits; tenants
  // pay only for the prepaid network services they activate.
  // Routers are unlimited for every paying workspace: pricing is by users.
  // Only the 7-day trial is limited to one router (businessPlanEntitlements).
  starter: { name: 'Workspace', monthlyKes: null, routerLimit: null, activeDeviceLimit: 2000 },
  growth: { name: 'Workspace Plus', monthlyKes: null, routerLimit: null, activeDeviceLimit: 5000 },
  custom: { name: 'Custom', monthlyKes: null, routerLimit: null, activeDeviceLimit: null },
};

// Monthly plans that can no longer be bought or renewed.
const RETIRED_PLANS = new Set(['starter', 'growth']);

// Fixed prepaid network-service pricing. These charges are independent of
// customer sales and never take a percentage of tenant revenue.
const NETWORK_SERVICE_PRICING = Object.freeze({
  pppoe: { label: 'PPPoE + Static IP', floorUsers: 35, floorKes: 500, perUserKes: 15 },
  // KES 1,000 covers up to 100 concurrent users; each user above 100 is KES 10.
  hotspot: { label: 'Hotspot', floorConcurrent: 100, floorKes: 1000, perExtraUserKes: 10 },
});

function networkServiceQuote({ pppoeUsers = 0, hotspotConcurrent = 0 } = {}) {
  const p = Math.max(0, Math.floor(Number(pppoeUsers) || 0));
  const h = Math.max(0, Math.floor(Number(hotspotConcurrent) || 0));
  const pppoeAmount = p ? (p < NETWORK_SERVICE_PRICING.pppoe.floorUsers ? NETWORK_SERVICE_PRICING.pppoe.floorKes : p * NETWORK_SERVICE_PRICING.pppoe.perUserKes) : 0;
  const hp = NETWORK_SERVICE_PRICING.hotspot;
  const hotspotAmount = h ? hp.floorKes + Math.max(0, h - hp.floorConcurrent) * hp.perExtraUserKes : 0;
  return { pppoeUsers: p, hotspotConcurrent: h, pppoeAmount, hotspotAmount, total: pppoeAmount + hotspotAmount };
}

// Trial access is intentionally time-bound but feature-complete.  Keep this
// entitlement calculation in one place so onboarding, dashboards and sales
// limits cannot drift apart.
const TRIAL_DAYS = 7;
// Free-trial throttles: enough to test real payments, not to run a business
// for free. They lift the moment the tenant chooses a plan.
const TRIAL_LIMITS = Object.freeze({ maxPackagePriceKes: 3, maxPackages: 3, maxPackageHours: 24, maxVouchers: 5, maxPppoeUsers: 2, maxHotspotUsers: 10 });
const TRIAL_PROMPTS_PER_DAY = 50;
const TRIAL_LIMIT_NOTE = 'These limits lift as soon as you subscribe to hotspot or PPPoE users.';
// Attached to a blocked owner request (`needs`) so the dashboard opens a pop-up
// to do the missing step right there, then retries, instead of sending the
// owner to another page.
const SUBSCRIBE_TRIAL = Object.freeze({ action: 'subscribe', service: 'any', reason: 'trial_limit' });
// Trial throttles apply only while on the free trial with no paid plan yet.
function trialLimited(business) {
  if (!trialActive(business)) return false;
  const s = serviceBilling.summary(business);
  const paid = (x) => x.status === 'active' || x.status === 'grace';
  return !(paid(s.hotspot) || paid(s.pppoe));
}
function trialActive(business) {
  if (!business || String(business.billing_status || '').toLowerCase() !== 'trial') return false;
  const raw = String(business.billing_expires_at || '').trim();
  if (!raw) return false;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
  return Number.isFinite(parsed) && parsed > Date.now();
}

function businessPlanEntitlements(business) {
  const plan = BUSINESS_PLANS[business && business.plan] || BUSINESS_PLANS.starter;
  if (!trialActive(business)) return plan;
  return { ...plan, routerLimit: 1, activeDeviceLimit: null, trialUnlimited: true, trialDays: TRIAL_DAYS };
}

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
  // A router that has been offboarded is retained as a quarantine record until
  // it reconnects and receives the reset. It must not block the owner's next
  // onboarding step or consume plan capacity while it is waiting offline.
  const activeLocations = locations.filter((location) => String(location.router_status || '').toLowerCase() !== 'offboarding');
  return {
    organisationComplete,
    hotspotName: business && business.hotspot_name || null,
    nextStep: !organisationComplete ? 'organisation' : !activeLocations.length ? 'router' : 'setup',
  };
}

function requireOrganisation(business, res) {
  if (organisationIsComplete(business)) return true;
  res.status(409).json({ error: 'Add your organisation details before adding a router.', needs: { action: 'organisation' } });
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
  const plan = businessPlanEntitlements(business);
  // Paid hotspot capacity is priced per concurrent customer, not per router.
  // One router while on the free trial, and still one after a trial ends
  // without a plan (each router also takes a VPN peer). Paying for hotspot or
  // PPPoE, or a paid account, lifts the limit.
  if (serviceBilling.routerLimitLifted(business)) return true;
  const services = serviceBilling.summary(business);
  if (services.pppoe && ['active', 'grace'].includes(services.pppoe.status)) return true;
  const onTrialAccount = String(business.billing_status || '').toLowerCase() === 'trial';
  const limit = plan.routerLimit || (onTrialAccount ? 1 : null);
  const existing = tenant.locationsForBusiness.all(business.id)
    .filter((location) => String(location.router_status || '').toLowerCase() !== 'offboarding');
  if (limit && existing.length >= limit) {
    res.status(402).json({
      error: trialActive(business)
        ? 'Your free trial includes one router. Subscribe to hotspot or PPPoE users and you can add as many routers as you need.'
        : 'Subscribe to hotspot or PPPoE users to add more routers. Once you do, you can add as many as you need.',
      needs: { action: 'subscribe', service: 'any', reason: 'router_limit' },
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

const EMAIL_CODES_PER_DAY = 10;
function existingAccountEmail() {
  const link = `${config.domains.appUrl}/business?mode=login`;
  return {
    subject: 'Someone tried to create a Wi-Fi Fiti account with your email',
    text: `Your email already has a Wi-Fi Fiti account, so no new account was created.\n\nSign in here: ${link}\nForgot your password? Use "Forgot password" on that page.\n\nIf this wasn't you, you can ignore this email.`,
    html: `<p>Your email already has a Wi-Fi Fiti account, so no new account was created.</p><p><a href="${link}">Sign in</a>. Forgot your password? Use "Forgot password" on that page.</p><p>If this wasn't you, you can ignore this email.</p>`,
  };
}
function emailVerificationEnabled() { return config.email.provider === 'resend'; }
function verificationHash(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
function verificationExpiry() { return new Date(Date.now() + 3 * 60_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''); }
async function beginEmailVerification({ email, purpose, businessId: businessIdValue = null, payload = null, recipientName = '' }) {
  const last = db.db.prepare(`SELECT last_sent_at FROM business_email_verifications WHERE email=? AND purpose=? ORDER BY created_at DESC LIMIT 1`).get(email, purpose);
  if (last && Date.now() - Date.parse(String(last.last_sent_at).replace(' ', 'T') + 'Z') < 60_000) {
    throw Object.assign(new Error('A verification code was already sent. Wait one minute before requesting another.'), { status: 429 });
  }
  // Each code allows 5 guesses; cap codes per email per day so the guesses
  // cannot add up (and nobody can flood an inbox).
  const sentToday = tenantAccess.allowed(`email-codes:${email}`, EMAIL_CODES_PER_DAY, 86400_000);
  if (!sentToday.allowed) throw Object.assign(new Error('Too many codes were sent to this email today. Please try again tomorrow.'), { status: 429 });
  const code = String(crypto.randomInt(100000, 1000000));
  const id = businessId('verify');
  db.deleteEmailVerifications.run(email, purpose);
  db.addEmailVerification.run({ id, email, purpose, businessId: businessIdValue, payloadJson: payload ? JSON.stringify(payload) : null, codeHash: verificationHash(code), expiresAt: verificationExpiry(), lastSentAt: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') });
  try { await sendEmail({ to: email, ...verificationEmail(code, purpose, recipientName) }); }
  catch (error) { db.db.prepare('DELETE FROM business_email_verifications WHERE id=?').run(id); throw error; }
  return id;
}

function consumeEmailVerification(id, code, purpose) {
  const row = db.emailVerificationById.get(id);
  if (!row || row.purpose !== purpose || row.expires_at <= new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')) throw Object.assign(new Error('That verification code has expired. Request a new one.'), { status: 400 });
  if (row.attempts >= 5) throw Object.assign(new Error('Too many incorrect codes. Request a new one.'), { status: 429 });
  if (verificationHash(String(code || '').trim()) !== row.code_hash) { db.updateEmailVerificationAttempt.run(id); throw Object.assign(new Error('The verification code is incorrect.'), { status: 400 }); }
  db.db.prepare('DELETE FROM business_email_verifications WHERE id=?').run(id);
  return row;
}

app.post('/api/business/register', async (req, res) => {
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
  if (!validBusinessPlan(plan, collectionMode)) return res.status(400).json({ error: 'Choose a valid Wi-Fi Fiti plan.' });
  if (db.businessByEmail.get(email)) {
    // With email codes on, answer exactly as for a new sign-up so the form
    // cannot be used to find out who has an account. The owner gets an email
    // telling them to sign in instead.
    if (emailVerificationEnabled()) {
      if (tenantAccess.allowed(`email-codes:${email}`, EMAIL_CODES_PER_DAY, 86400_000).allowed) {
        Promise.resolve().then(() => sendEmail({ to: email, ...existingAccountEmail() }))
          .catch((error) => console.error('[business] existing-account notice failed:', error.message));
      }
      return res.status(202).json({ verificationRequired: true, verificationId: businessId('verify'), email, message: 'Enter the verification code sent to your email.' });
    }
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  if (!emailVerificationEnabled() && !phoneVerification.available() && config.mpesa.env === 'production'
      && String(process.env.ALLOW_UNVERIFIED_SIGNUPS || '').toLowerCase() !== 'true') {
    // Neither the email nor the phone can be checked, so nothing would stop
    // throwaway sign-ups. Refuse until one verification channel is set up.
    console.error('[business] sign-up refused: configure RESEND (email codes) or AFRICASTALKING (SMS codes)');
    return res.status(503).json({ error: 'New sign-ups are paused for a moment. Please try again later or contact Wi-Fi Fiti support.' });
  }
  if (emailVerificationEnabled()) {
    try {
      const verificationId = await beginEmailVerification({ email, purpose: 'register', recipientName: ownerName || email.split('@')[0], payload: { name, ownerName, ownerPhone, passwordHash: hashPassword(password), plan: plan === 'custom' ? 'starter' : plan, collectionMode, registrationIsComplete: hasOrganisationFields, hotspotName: rawHotspotName ? textField(rawHotspotName, 'hotspot name', 80, true) : null, requestedCustom: plan === 'custom' } });
      return res.status(202).json({ verificationRequired: true, verificationId, email, message: 'Enter the verification code sent to your email.' });
    } catch (error) { return res.status(error.status || 502).json({ error: error.message || 'Verification email could not be sent.' }); }
  }
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
    db.setBusinessTrial.run({ id, expiresAt: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') });
    if (registrationIsComplete && !phoneVerification.available()) trialGuard.check(id, { phone: ownerPhone });
    const token = issueBusinessSession(id);
    const business = db.businessById.get(id);
    res.status(201).json({ token, business, onboarding: onboardingState(business), requestedCustom: plan === 'custom' });
  } catch (err) {
    console.error('[business] registration failed:', err.message);
    res.status(500).json({ error: 'Could not create the business account.' });
  }
});

app.post('/api/business/verify-registration', (req, res) => {
  try {
    const row = consumeEmailVerification(String(req.body && req.body.verificationId || ''), req.body && req.body.code, 'register');
    const payload = JSON.parse(row.payload_json || '{}');
    const id = businessId('biz');
    db.addBusiness.run({ id, name: payload.registrationIsComplete ? payload.name : '', ownerName: payload.registrationIsComplete ? payload.ownerName : '', ownerPhone: payload.registrationIsComplete ? payload.ownerPhone : '', email: row.email, passwordHash: payload.passwordHash, plan: payload.plan, collectionMode: payload.collectionMode, onboardingState: payload.registrationIsComplete ? 'complete' : 'organisation', organisationCompletedAt: payload.registrationIsComplete ? new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') : null, hotspotName: payload.hotspotName });
    db.setBusinessTrial.run({ id, expiresAt: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') });
    if (payload.registrationIsComplete && !phoneVerification.available()) trialGuard.check(id, { phone: payload.ownerPhone });
    const account = db.businessById.get(id);
    res.status(201).json({ token: issueBusinessSession(id), business: account, onboarding: onboardingState(account), requestedCustom: payload.requestedCustom });
  } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Could not verify the account.' }); }
});

app.post('/api/business/login', async (req, res) => {
  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const password = String(req.body && req.body.password || '');
  const business = db.businessByEmail.get(email);
  if (!business || !passwordMatches(password, business.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (emailVerificationEnabled()) {
    try {
      const verificationId = await beginEmailVerification({ email, purpose: 'login', businessId: business.id, recipientName: business.owner_name || email.split('@')[0] });
      return res.status(202).json({ verificationRequired: true, verificationId, email, message: 'Enter the verification code sent to your email.' });
    } catch (error) { return res.status(error.status || 502).json({ error: error.message || 'Verification email could not be sent.' }); }
  }
  const account = db.businessById.get(business.id);
  res.json({ token: issueBusinessSession(business.id), business: account,
    onboarding: onboardingState(account, tenant.locationsForBusiness.all(business.id)) });
});

// Google OAuth is intentionally configuration-gated. The controls are shown
// consistently on login and registration, but no redirect is attempted until
// the deployment has a Google client id, secret and callback configured.
app.get('/api/business/google/start', (req, res) => {
  const oauth = googleOAuthConfig();
  if (!oauth) {
    return res.redirect(`${config.domains.appUrl}/business.html?google_error=${encodeURIComponent('Google sign-in is not configured on this deployment yet. Use email sign-in.')}`);
  }
  const { clientId } = oauth;
  const mode = String(req.query.mode || 'login') === 'register' ? 'register' : 'login';
  const state = crypto.randomBytes(24).toString('base64url');
  googleOAuthStates.set(state, { mode, expiresAt: Date.now() + 10 * 60_000 });
  // Bind the state to this browser so a sign-in started elsewhere cannot be
  // completed here (login CSRF).
  res.cookie('fiti_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60_000, path: '/api/business/google' });
  const redirectUri = `${config.domains.appUrl}/api/business/google/callback`;
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', access_type: 'online', state, prompt: 'select_account' });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/business/google/callback', async (req, res) => {
  const state = googleOAuthStates.get(String(req.query.state || ''));
  googleOAuthStates.delete(String(req.query.state || ''));
  const cookieState = (String(req.headers.cookie || '').match(/(?:^|;\s*)fiti_oauth_state=([^;]+)/) || [])[1] || '';
  res.clearCookie('fiti_oauth_state', { path: '/api/business/google' });
  if (!state || state.expiresAt < Date.now() || !req.query.code || cookieState !== String(req.query.state || '')) return res.status(400).send('Google sign-in expired. Return to Wi-Fi Fiti and try again.');
  try {
    const oauth = googleOAuthConfig();
    if (!oauth) throw new Error('Google OAuth is not configured');
    const { clientId, clientSecret } = oauth;
    const redirectUri = `${config.domains.appUrl}/api/business/google/callback`;
    const exchange = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: String(req.query.code), client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
    if (!exchange.ok) throw new Error('Google token exchange failed');
    const tokens = await exchange.json();
    const profileResponse = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(tokens.id_token || '')));
    if (!profileResponse.ok) throw new Error('Google identity verification failed');
    const profile = await profileResponse.json();
    if (profile.aud !== clientId || profile.email_verified !== 'true' || !/^\S+@\S+\.\S+$/.test(String(profile.email || ''))) throw new Error('Google account email could not be verified');
    const email = String(profile.email).toLowerCase();
    let account = db.businessByEmail.get(email);
    if (!account) {
      const id = businessId('biz');
      db.addBusiness.run({ id, name: '', ownerName: String(profile.name || email.split('@')[0]).slice(0, 80), ownerPhone: '', email, passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')), plan: 'starter', collectionMode: 'own', onboardingState: 'organisation', organisationCompletedAt: null, hotspotName: null });
      db.setBusinessTrial.run({ id, expiresAt: new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') });
      account = db.businessById.get(id);
    }
    const token = issueBusinessSession(account.id);
    // The fragment never reaches servers, proxies or access logs.
    res.redirect(`${config.domains.appUrl}/business.html#google_token=${encodeURIComponent(token)}`);
  } catch (error) {
    console.error('[business] Google sign-in failed:', error.message);
    res.status(502).send('Google sign-in could not be completed. Return to Wi-Fi Fiti and use email sign-in.');
  }
});

app.post('/api/business/verify-login', (req, res) => {
  try {
    const row = consumeEmailVerification(String(req.body && req.body.verificationId || ''), req.body && req.body.code, 'login');
    const account = db.businessById.get(row.business_id);
    if (!account) throw Object.assign(new Error('Account no longer exists.'), { status: 404 });
    res.json({ token: issueBusinessSession(account.id), business: account, onboarding: onboardingState(account, tenant.locationsForBusiness.all(account.id)) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Could not verify the sign-in.' }); }
});

// A code can only be re-sent after the previous three-minute code has expired.
// The verification id is an opaque, one-time handle, so this does not expose
// whether an email belongs to an account.
app.post('/api/business/resend-code', async (req, res) => {
  const verificationId = String(req.body && req.body.verificationId || '').trim();
  const current = db.emailVerificationById.get(verificationId);
  const allowedPurposes = new Set(['register', 'login', 'reset']);
  if (!current || !allowedPurposes.has(current.purpose)) {
    return res.status(400).json({ error: 'This verification request is no longer valid. Start again.' });
  }
  const expiry = Date.parse(String(current.expires_at || '').replace(' ', 'T') + 'Z');
  if (!Number.isFinite(expiry) || expiry > Date.now()) {
    return res.status(429).json({ error: 'Wait until the current code expires before requesting another.' });
  }
  let payload = null;
  let recipientName = current.email.split('@')[0];
  if (current.purpose === 'register') {
    try { payload = JSON.parse(current.payload_json || '{}'); } catch (_) { payload = {}; }
    recipientName = payload.ownerName || recipientName;
  } else if (current.business_id) {
    const business = db.businessById.get(current.business_id);
    if (business) recipientName = business.owner_name || recipientName;
  }
  try {
    const newId = await beginEmailVerification({
      email: current.email,
      purpose: current.purpose,
      businessId: current.business_id || null,
      payload,
      recipientName,
    });
    res.json({ verificationRequired: true, verificationId: newId, email: current.email, message: 'A new verification code has been sent.' });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || 'The verification email could not be sent.' });
  }
});

app.post('/api/business/forgot-password', async (req, res) => {
  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const generic = { message: 'If that email belongs to a Wi-Fi Fiti account, a password reset code has been sent.' };
  if (!/^\S+@\S+\.\S+$/.test(email) || !emailVerificationEnabled()) return res.json(generic);
  const business = db.businessByEmail.get(email);
  // Answer the same way whether or not the email has an account, so this
  // cannot be used to find out who uses Wi-Fi Fiti.
  if (!business) return res.json({ ...generic, verificationRequired: true, verificationId: businessId('verify'), email });
  try {
    const verificationId = await beginEmailVerification({ email, purpose: 'reset', businessIdValue: business.id, businessId: business.id, recipientName: business.owner_name || email.split('@')[0] });
    res.json({ ...generic, verificationRequired: true, verificationId, email });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: error.message });
    console.error('[business] reset email failed:', error.message);
    res.json({ ...generic, verificationRequired: true, verificationId: businessId('verify'), email });
  }
});

app.post('/api/business/reset-password', (req, res) => {
  try {
    const password = String(req.body && req.body.password || '');
    if (password.length < 8) throw Object.assign(new Error('Use a password with at least 8 characters.'), { status: 400 });
    const row = consumeEmailVerification(String(req.body && req.body.verificationId || ''), req.body && req.body.code, 'reset');
    if (!row.business_id) throw Object.assign(new Error('This reset request is invalid.'), { status: 400 });
    db.setBusinessPassword.run(hashPassword(password), row.business_id);
    // Anyone signed in with the old password is signed out.
    db.db.prepare('DELETE FROM business_sessions WHERE business_id=?').run(row.business_id);
    res.json({ message: 'Password updated. You can now sign in.' });
  } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Could not reset the password.' }); }
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
  res.json({ business, onboarding: onboardingState(business, locations), plan: businessPlanEntitlements(business), services: serviceBilling.summary(business), serviceUsage: serviceUsage(business), servicePlan: servicePlan(business), trialLimits: trialLimited(business) ? TRIAL_LIMITS : null, phoneVerification: { available: phoneVerification.available(), verified: phoneVerification.verified(business), required: Boolean(ownerPhoneBlock(business)) }, tumaFee: tumaFee.state(business.id), locations, packages: db.packagesForBusiness.all(business.id),
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
    if (!phoneVerification.available()) trialGuard.check(business.id, { phone });
    const updated = db.businessById.get(business.id);
    res.json({ business: updated, onboarding: onboardingState(updated) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save your organisation.' });
  }
}

app.post('/api/business/phone/verify/start', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try { res.json(await phoneVerification.start(business, req.body && req.body.phone)); }
  catch (error) {
    if (!error.status) console.error('[phone verify] SMS failed:', error.message);
    res.status(error.status || 502).json({ error: error.status ? error.message : 'We could not send the SMS. Check the number and try again.' });
  }
});
app.post('/api/business/phone/verify/confirm', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const result = await phoneVerification.confirm(business, req.body && req.body.code);
    const updated = db.businessById.get(business.id);
    res.json({ ...result, business: updated, onboarding: onboardingState(updated) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

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
  // During the seven-day trial, plan selection is configuration only.  Do not
  // create a checkout or charge the owner; the selected plan becomes the
  // renewal plan when the trial expires.
  if (trialActive(business)) {
    db.setBusinessPlan.run({ id: business.id, plan, collectionMode });
    const updated = { ...business, plan, collection_mode: collectionMode };
    return res.json({ plan: businessPlanEntitlements(updated), collectionMode,
      checkoutRequired: false, trial: true, trialDays: TRIAL_DAYS, requestedPlan: plan });
  }
  // Changing collection mode is immediate. Starter/Growth can no longer be
  // bought, so a plan change never starts a checkout; capacity is bought
  // through /api/business/network-services/checkout instead.
  if (plan !== business.plan && plan !== 'custom') {
    db.setBusinessPlan.run({ id: business.id, plan: business.plan, collectionMode });
    return res.json({ plan: BUSINESS_PLANS[business.plan], collectionMode });
  }
  if (plan === 'custom') {
    db.setBusinessPlan.run({ id: business.id, plan: business.plan, collectionMode });
    return res.json({ plan: BUSINESS_PLANS[business.plan], collectionMode,
      contactRequired: true, requestedPlan: 'custom' });
  }
  db.setBusinessPlan.run({ id: business.id, plan, collectionMode });
  res.json({ plan: BUSINESS_PLANS[plan], collectionMode });
});

app.get('/api/business/network-services', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const quote = networkServiceQuote({
    pppoeUsers: req.query.pppoeUsers ?? business.pppoe_users,
    hotspotConcurrent: req.query.hotspotConcurrent ?? business.hotspot_concurrent,
  });
  res.json({ pricing: NETWORK_SERVICE_PRICING, quote, services: serviceBilling.summary(business), usage: serviceUsage(business), plan: servicePlan(business), current: {
    pppoeUsers: Number(business.pppoe_users || 0),
    pppoeExpiresAt: business.pppoe_billing_expires_at || null,
    hotspotConcurrent: Number(business.hotspot_concurrent || 0),
    hotspotExpiresAt: business.hotspot_billing_expires_at || null,
  }});
});

// The capacity a tenant has chosen, what they pay now and what it renews at.
// On an active trial the answer is always "KES 0 now", renewing when the
// trial ends.
function servicePlan(business) {
  const services = serviceBilling.summary(business);
  const hotspotConcurrent = Math.max(Number(business.planned_hotspot || 0), Number(business.hotspot_concurrent || 0));
  const pppoeUsers = Math.max(Number(business.planned_pppoe || 0), Number(business.pppoe_users || 0));
  const quote = networkServiceQuote({ hotspotConcurrent, pppoeUsers });
  const onTrial = services.trial.active;
  return {
    hotspotConcurrent, pppoeUsers, quote, chosen: Boolean(quote.total),
    trial: services.trial, payNowKes: onTrial ? 0 : quote.total, renewKes: quote.total,
    renewsAt: onTrial ? services.trial.endsAt : null,
  };
}

// Save the chosen capacity without paying (used by the setup flow).
app.post('/api/business/network-services/plan', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const quote = networkServiceQuote(req.body || {});
  if (!quote.pppoeUsers && !quote.hotspotConcurrent) return res.status(400).json({ error: 'Choose hotspot users, PPPoE users, or both.' });
  if (quote.hotspotConcurrent > 100000 || quote.pppoeUsers > 100000) return res.status(400).json({ error: 'That capacity is too large. Contact Wi‑Fi Fiti for a custom plan.' });
  db.db.prepare('UPDATE businesses SET planned_hotspot=?, planned_pppoe=? WHERE id=?').run(quote.hotspotConcurrent, quote.pppoeUsers, business.id);
  res.json({ plan: servicePlan(db.businessById.get(business.id)) });
});

// Users online / active now against each paid capacity.
const pppoeActiveNow = db.db.prepare(`SELECT COUNT(*) AS n FROM pppoe_users WHERE business_id=? AND status='active'
  AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`);
function serviceUsage(business) {
  let pppoeActive = 0;
  try { pppoeActive = pppoeActiveNow.get(business.id).n; } catch { /* PPPoE tables not created yet */ }
  return serviceBilling.capacityUsage(business, { hotspotOnline: hotspotOnlineNow.get(business.id).n, pppoeActive });
}

// Add users mid-period: pay the price difference for the days left.
app.get('/api/business/network-services/upgrade-quote', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try { res.json(serviceBilling.upgradeQuote(business, { hotspotConcurrent: req.query.hotspotConcurrent, pppoeUsers: req.query.pppoeUsers })); }
  catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.post('/api/business/network-services/upgrade', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  let quote;
  try { quote = serviceBilling.upgradeQuote(business, { hotspotConcurrent: req.body && req.body.hotspotConcurrent, pppoeUsers: req.body && req.body.pppoeUsers }); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  const target = (kind) => (quote.items.find(item => item.kind === kind) || {}).to || 0;
  // Moving up within the KES 1,000 base (e.g. 50 to 100 hotspot users) costs nothing.
  if (!quote.totalKes) {
    db.db.prepare(`UPDATE businesses SET hotspot_concurrent=MAX(hotspot_concurrent, ?), pppoe_users=MAX(pppoe_users, ?) WHERE id=?`)
      .run(target('hotspot'), target('pppoe'), business.id);
    return res.json({ applied: true, quote });
  }
  const phone = mpesa.normalizePhone(req.body && req.body.phone || business.owner_phone);
  if (!phone) return res.status(400).json({ error: 'Enter the M-Pesa number that should pay for the extra users.' });
  const pending = db.db.prepare(`SELECT checkout_request_id FROM business_billing_transactions
    WHERE business_id=? AND status='pending' AND created_at>datetime('now','-3 minutes') LIMIT 1`).get(business.id);
  if (pending) return res.status(409).json({ error: 'A service payment is already processing. Check your phone.' });
  const throttleKey = `network-upgrade:${business.id}:${phone}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) return res.status(429).json({ error: 'A payment request is already on its way. Please wait a moment.' });
  if (platformPushesToday(business.id) >= PLATFORM_PUSHES_PER_DAY) return res.status(429).json({ error: PLATFORM_PUSH_LIMIT_MESSAGE });
  try {
    lastPush.set(throttleKey, Date.now());
    const pushed = await platformStkPush({ phone, amount: quote.totalKes, accountReference: 'WF-ADDUSERS', description: 'Wi-Fi Fiti extra users' });
    recordPlatformBilling(pushed, { checkoutRequestId: pushed.checkoutRequestId, merchantRequestId: pushed.merchantRequestId,
      businessId: business.id, plan: 'services-upgrade', phone, amount: quote.totalKes, serviceKind: 'upgrade',
      pppoeUsers: target('pppoe'), hotspotConcurrent: target('hotspot') });
    res.json({ checkoutRequestId: pushed.checkoutRequestId, quote, phoneDisplay: mpesa.displayPhone(phone) });
  } catch (err) {
    lastPush.delete(throttleKey);
    console.error('[network upgrade] STK push failed:', err.message);
    res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});

app.post('/api/business/network-services/checkout', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const quote = networkServiceQuote(req.body || {});
  if (!quote.pppoeUsers && !quote.hotspotConcurrent) return res.status(400).json({ error: 'Enter at least one PPPoE/static-IP user or hotspot concurrency tier.' });
  const phone = mpesa.normalizePhone(req.body && req.body.phone || business.owner_phone);
  if (!phone) return res.status(400).json({ error: 'Enter the M-Pesa number that should pay for these services.' });
  const pending = db.db.prepare(`SELECT checkout_request_id FROM business_billing_transactions
    WHERE business_id=? AND status='pending' AND created_at>datetime('now','-3 minutes') ORDER BY created_at DESC LIMIT 1`).get(business.id);
  if (pending) return res.status(409).json({ error: 'A service subscription payment is already processing.' });
  const throttleKey = `network-services:${business.id}:${phone}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) return res.status(429).json({ error: 'A service payment request is already on its way. Please wait a moment.' });
  if (platformPushesToday(business.id) >= PLATFORM_PUSHES_PER_DAY) return res.status(429).json({ error: PLATFORM_PUSH_LIMIT_MESSAGE });
  try {
    lastPush.set(throttleKey, Date.now());
    const pushed = await platformStkPush({ phone, amount: quote.total, accountReference: 'WF-SERVICES', description: 'Wi-Fi Fiti network services' });
    const serviceKind = quote.pppoeUsers && quote.hotspotConcurrent ? 'combined' : quote.pppoeUsers ? 'pppoe' : 'hotspot';
    recordPlatformBilling(pushed, { checkoutRequestId: pushed.checkoutRequestId, merchantRequestId: pushed.merchantRequestId,
      businessId: business.id, plan: `services-${serviceKind}`, phone, amount: quote.total, serviceKind,
      pppoeUsers: quote.pppoeUsers, hotspotConcurrent: quote.hotspotConcurrent });
    res.json({ checkoutRequestId: pushed.checkoutRequestId, serviceKind, quote, phoneDisplay: mpesa.displayPhone(phone) });
  } catch (err) {
    lastPush.delete(throttleKey);
    console.error('[network services] STK push failed:', err.message);
    res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});

app.post('/api/business/billing/checkout', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const plan = String(req.body && req.body.plan || business.plan);
  const definition = BUSINESS_PLANS[plan];
  const phone = mpesa.normalizePhone(req.body && req.body.phone || business.owner_phone);
  // Starter and Growth are retired: every workspace now prepays hotspot and
  // PPPoE capacity. Time already paid on an old plan is still honoured.
  if (RETIRED_PLANS.has(plan)) {
    return res.status(410).json({ error: 'Starter and Growth plans have been replaced by prepaid hotspot and PPPoE capacity. Choose your capacity under Prepaid network services.' });
  }
  if (!definition || !definition.monthlyKes) return res.status(400).json({ error: 'Custom plans are arranged with Wi-Fi Fiti directly.' });
  if (!phone) return res.status(400).json({ error: 'Enter the M-Pesa number that should pay for this plan.' });
  const activeLocations = tenant.locationsForBusiness.all(business.id)
    .filter((location) => String(location.router_status || '').toLowerCase() !== 'offboarding');
  if (definition.routerLimit && activeLocations.length > definition.routerLimit) {
    return res.status(409).json({ error: 'This plan does not cover your existing routers. Choose a plan with enough router capacity.' });
  }
  const pending = db.db.prepare(`SELECT checkout_request_id FROM business_billing_transactions
    WHERE business_id=? AND status='pending' AND created_at>datetime('now','-3 minutes')
    ORDER BY created_at DESC LIMIT 1`).get(business.id);
  if (pending) return res.status(409).json({ error: 'Your previous plan payment is still processing. Check its status before sending another request.' });
  const throttleKey = `platform:${business.id}:${phone}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) return res.status(429).json({ error: 'A plan payment request is already on its way. Please wait a moment.' });
  if (platformPushesToday(business.id) >= PLATFORM_PUSHES_PER_DAY) return res.status(429).json({ error: PLATFORM_PUSH_LIMIT_MESSAGE });
  try {
    lastPush.set(throttleKey, Date.now());
    const pushed = await platformStkPush({ phone, amount: definition.monthlyKes,
      accountReference: `WF-${plan}`, description: `${definition.name} plan` });
    recordPlatformBilling(pushed, { checkoutRequestId: pushed.checkoutRequestId,
      merchantRequestId: pushed.merchantRequestId, businessId: business.id, plan, phone, amount: definition.monthlyKes,
      serviceKind: 'platform', pppoeUsers: 0, hotspotConcurrent: 0 });
    res.json({ checkoutRequestId: pushed.checkoutRequestId, plan, amount: definition.monthlyKes,
      phoneDisplay: mpesa.displayPhone(phone) });
  } catch (err) {
    lastPush.delete(throttleKey);
    console.error('[business billing] STK push failed:', err.message);
    res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});

/**
 * Tenant payments to Wi‑Fi Fiti (prepaid services, extra users, the Tuma
 * fee) go to Wi‑Fi Fiti's own Tuma account when it is configured, and fall
 * back to the platform Daraja shortcode otherwise or if Tuma is unreachable.
 * Set PLATFORM_COLLECTION=daraja to force Daraja.
 */
// Each prompt lands on a real phone from Wi-Fi Fiti's shortcode. Cap how many
// one workspace can send a day so sign-ups cannot spam strangers.
const PLATFORM_PUSHES_PER_DAY = 10;
const PLATFORM_PUSH_LIMIT_MESSAGE = 'Too many payment requests were sent from this workspace today. Please try again tomorrow or contact support.';
const platformPushCount = db.db.prepare(`SELECT COUNT(*) AS n FROM business_billing_transactions WHERE business_id=? AND created_at>datetime('now','-1 day')`);
function platformPushesToday(businessId) { return platformPushCount.get(businessId).n; }

async function platformStkPush({ phone, amount, accountReference, description }) {
  const preferTuma = String(process.env.PLATFORM_COLLECTION || 'tuma').toLowerCase() !== 'daraja';
  if (preferTuma && tuma.configured()) {
    try {
      const pushed = await tuma.stkPush({ phone, amount, publicUrl: config.publicUrl, description: `${description} (${accountReference})` });
      return { ...pushed, source: 'tuma' };
    } catch (err) {
      console.warn(`[platform collection] Tuma prompt failed, using Daraja: ${err.message} ${err.details || ''}`);
    }
  }
  const pushed = await mpesa.stkPush({ phone, amount, accountReference, description });
  return { ...pushed, source: 'daraja' };
}

function recordPlatformBilling(pushed, row) {
  tenant.insertBusinessBilling.run(row);
  tenant.setBusinessBillingSource.run(pushed.source || 'daraja', row.checkoutRequestId);
}

async function queryBusinessBillingNow(transaction) {
  // Tuma confirms through its callback; there is no Daraja query to make.
  if (transaction.payment_source === 'tuma') return transaction;
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
  const updatedBusiness = db.businessById.get(business.id);
  res.json({ status: transaction.status === 'paid' && !transaction.activated ? 'pending' : transaction.status, plan: transaction.plan, amount: transaction.amount,
    serviceKind: transaction.service_kind || 'platform', quote: transaction.service_kind && transaction.service_kind !== 'platform' ? networkServiceQuote(transaction) : null,
    expiresAt: transaction.status === 'paid' ? (transaction.service_kind && transaction.service_kind !== 'platform' ? (updatedBusiness.pppoe_billing_expires_at || updatedBusiness.hotspot_billing_expires_at) : updatedBusiness.billing_expires_at) : null,
    reason: transaction.status === 'failed' ? friendlyFailure(transaction.result_code, transaction.result_desc) : null });
});

app.get('/api/business/billing/recover', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const transaction = db.db.prepare(`SELECT * FROM business_billing_transactions
    WHERE business_id=? AND COALESCE(service_kind,'platform') NOT IN ('tuma_fee','sms')
      AND ((status='pending' AND created_at>datetime('now','-2 hours'))
      OR (status!='pending' AND updated_at>datetime('now','-30 minutes')))
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(business.id);
  if (!transaction) return res.json({ found: false });
  res.json({ found: true, checkoutRequestId: transaction.checkout_request_id,
    plan: transaction.plan, amount: transaction.amount, serviceKind: transaction.service_kind || 'platform', quote: transaction.service_kind && transaction.service_kind !== 'platform' ? networkServiceQuote(transaction) : null, phoneDisplay: mpesa.displayPhone(transaction.phone),
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
    return res.status(503).json({ error: 'Secure payment storage has not been configured by Wi-Fi Fiti yet.' });
  }
  const credentials = { shortcode, transactionType, consumerKey, consumerSecret, passkey };
  try {
    await tenantMpesa.verify(credentials);
    const connection = tenant.savePaymentConnection({ businessId: business.id, collectionName, ...credentials, verified: true });
    // An M-Pesa shortcode is a payout account for the one-trial rule too.
    const trialEnded = trialGuard.check(business.id, { payout: `mpesa:${shortcode}` });
    res.status(201).json({ configured: true, trialEnded, connection: {
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
    const loader = tenant.storeRouterSetupScript({
      locationId: location.id, token: location.routerToken, pairing: 'active', script: generated.script,
    });
    res.status(201).json({
      location,
      portalUrl,
      coreUrl: config.domains.appUrl,
      setup: { mode: generated.config.mode, summary: generated.summary, warnings: generated.warnings, script: generated.script, loader,
        loaderStatus: loader ? 'ready' : (process.env.TENANT_SECRETS_KEY ? 'unavailable' : 'storage_not_configured') },
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
    // A first kit for a saved draft is not replacing a live router. Once a
    // location has checked in, every kind of fresh kit changes its pairing
    // credential, so require the same explicit confirmation for automatic,
    // reset and existing-router kits alike.
    if (current.last_successful_sync_at && String(body.replaceRouter || '') !== 'yes') {
      return res.status(400).json({ error: 'Confirm that this kit is replacing the current router before generating it.' });
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
    const loader = tenant.storeRouterSetupScript({
      locationId: location.id, token: location.routerToken, pairing: 'pending', script: generated.script,
    });
    res.json({
      location,
      portalUrl,
      coreUrl: config.domains.appUrl,
      setup: { mode: generated.config.mode, summary: generated.summary, warnings: generated.warnings, script: generated.script, loader,
        loaderStatus: loader ? 'ready' : (process.env.TENANT_SECRETS_KEY ? 'unavailable' : 'storage_not_configured') },
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
  // The universal kit's fuller layout report (every interface and what it is
  // used for) rides alongside the stable map data.
  const locationId = String(req.params.locationId);
  layoutViewedAt.set(locationId, Date.now());
  res.json({ ...result, layout: tenant.routerInventoryForLocation(locationId), plan: tenant.routerPlanForLocation(locationId), changes: tenant.routerChangesForLocation(locationId) });
});

// The owner's network map for a universal-kit router: new bridges from free
// ports and/or a job for an existing bridge or VLAN. Checked against the
// router's latest layout report and saved; nothing is sent to the router yet.
app.put('/api/business/locations/:locationId/network-plan', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const plan = tenant.saveRouterPlan({ locationId: String(req.params.locationId), businessId: business.id, plan: req.body && req.body.plan });
    if (!plan) return res.status(404).json({ error: 'Location not found.' });
    res.json({ plan });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save this network map.' });
  }
});
app.delete('/api/business/locations/:locationId/network-plan', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  if (!tenant.deleteRouterPlan({ locationId: String(req.params.locationId), businessId: business.id })) return res.status(404).json({ error: 'Location not found.' });
  res.json({ plan: null });
});

// Stage 3: review the saved map, apply it to the router, undo one change.
function networkChangeRoute(handler, failure) {
  return (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    try {
      const result = handler(business, req);
      if (result === null) return res.status(404).json({ error: 'Location not found.' });
      res.json(result);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : failure });
    }
  };
}
app.get('/api/business/locations/:locationId/network-plan/review', networkChangeRoute((business, req) => {
  const review = tenant.reviewRouterPlan({ locationId: String(req.params.locationId), businessId: business.id });
  return review && { review };
}, 'Could not review this network map.'));
app.post('/api/business/locations/:locationId/network-plan/apply', networkChangeRoute((business, req) => {
  const changes = tenant.applyRouterPlan({ locationId: String(req.params.locationId), businessId: business.id, confirm: Boolean(req.body && req.body.confirm === true) });
  return changes && { changes };
}, 'Could not apply this network map.'));
app.post('/api/business/locations/:locationId/network-changes/:changeId/undo', networkChangeRoute((business, req) => {
  const changes = tenant.undoRouterChange({ locationId: String(req.params.locationId), businessId: business.id, changeId: req.params.changeId });
  return changes && { changes };
}, 'Could not undo this change.'));
app.post('/api/business/locations/:locationId/network-changes/:changeId/rename', networkChangeRoute((business, req) => {
  const changes = tenant.renameRouterBridge({ locationId: String(req.params.locationId), businessId: business.id, changeId: req.params.changeId, name: req.body && req.body.name });
  return changes && { changes };
}, 'Could not rename this bridge.'));

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
/* Map-bound remote deployment                                         */
/* ------------------------------------------------------------------ */

// This API is intentionally *not* a remote terminal. The only accepted
// browser request is an explicit request for the reviewed map-bound action;
// every RouterOS value is rebuilt server-side from a fresh inventory and the
// owner's confirmed map. No command, script, credential or route field can
// cross this boundary.
app.get('/api/business/locations/:locationId/mapped-deployment', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const result = tenant.mappedDeploymentForBusiness({ locationId: String(req.params.locationId), businessId: business.id });
  if (!result) return res.status(404).json({ error: 'Location not found.' });
  res.json(result);
});

app.post('/api/business/locations/:locationId/mapped-deployment', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || body.action !== 'apply') {
    return res.status(400).json({ error: 'Use only the apply action for a verified router map.' });
  }
  try {
    const result = tenant.requestMappedDeployment({ locationId: String(req.params.locationId), businessId: business.id });
    if (!result) return res.status(404).json({ error: 'Location not found.' });
    res.status(result.reused ? 200 : 202).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not queue the verified router deployment.' });
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
    return res.status(400).json({ error: 'Confirm that Wi-Fi Fiti may prepare remote support for this router.' });
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
        gatewayName: 'Wi-Fi Fiti secure gateway',
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
  const current = tenant.locationForBusiness.get(String(req.params.locationId), business.id);
  if (!current) return res.status(404).json({ error: 'Location not found.' });
  if (String(req.body && req.body.confirm || '') !== 'ROTATE ROUTER TOKEN') {
    return res.status(400).json({ error: 'Type ROTATE ROUTER TOKEN to generate a replacement credential.' });
  }
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
  if (trialLimited(business)) {
    if (price > TRIAL_LIMITS.maxPackagePriceKes) return res.status(400).json({ error: `During your free trial, packages cost KES 1 to KES ${TRIAL_LIMITS.maxPackagePriceKes}. ${TRIAL_LIMIT_NOTE}`, needs: SUBSCRIBE_TRIAL, trialLimit: 'price' });
    if (hours > TRIAL_LIMITS.maxPackageHours) return res.status(400).json({ error: `During your free trial, packages last up to ${TRIAL_LIMITS.maxPackageHours} hours. ${TRIAL_LIMIT_NOTE}`, needs: SUBSCRIBE_TRIAL, trialLimit: 'duration' });
    if (db.packagesForBusiness.all(business.id).length >= TRIAL_LIMITS.maxPackages) return res.status(400).json({ error: `Your free trial includes up to ${TRIAL_LIMITS.maxPackages} packages. ${TRIAL_LIMIT_NOTE}`, needs: SUBSCRIBE_TRIAL, trialLimit: 'count' });
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
  if (trialLimited(business) && price > TRIAL_LIMITS.maxPackagePriceKes) {
    return res.status(400).json({ error: `During your free trial, packages cost KES 1 to KES ${TRIAL_LIMITS.maxPackagePriceKes}. ${TRIAL_LIMIT_NOTE}`, needs: SUBSCRIBE_TRIAL, trialLimit: 'price' });
  }
  if (trialLimited(business) && hours > TRIAL_LIMITS.maxPackageHours) {
    return res.status(400).json({ error: `During your free trial, packages last up to ${TRIAL_LIMITS.maxPackageHours} hours. ${TRIAL_LIMIT_NOTE}`, needs: SUBSCRIBE_TRIAL, trialLimit: 'duration' });
  }
  tenant.updateBusinessPackage.run({ id, businessId: business.id, name, price, seconds: Math.round(hours * 3600), rateLimit: rate.value });
  res.json({ packages: db.packagesForBusiness.all(business.id) });
});

app.delete('/api/business/packages/:packageId', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const deleted = tenant.deletePackageForOwner(Number(req.params.packageId), business.id);
  if (!deleted) return res.status(404).json({ error: 'Package not found.' });
  res.json({ ...deleted, packages: db.packagesForBusiness.all(business.id) });
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

// Delete a tenant-owned router configuration. This removes the cloud pairing,
// portal mapping, jobs and router-specific services so the next onboarding is
// treated as a brand-new router. It never factory-resets the physical device.
app.delete('/api/business/locations/:locationId', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  try {
    const location = tenant.deleteLocationForOwner({
      locationId: String(req.params.locationId),
      businessId: business.id,
      confirm: String(req.body && req.body.confirm || ''),
    });
    if (!location) return res.status(404).json({ error: 'Location not found.' });
    res.json({ deleted: true, locationId: location.id });
  } catch (error) {
    if (!error.status) console.error(`[business] router delete failed for ${req.params.locationId}:`, error.message);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not delete this router.' });
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
    transactions: tenant.salesTransactions.all(business.id, since, 500),
  });
});

app.get('/api/business/router-telemetry', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const locationId = String(req.query.locationId || '');
  const location = tenant.locationForBusiness.get(locationId, business.id);
  if (!location) return res.status(404).json({ error: 'Location not found.' });
  const period = String(req.query.period || '24h');
  const hours = period === '1h' ? 1 : period === '6h' ? 6 : period === '7d' ? 168 : 24;
  const since = new Date(Date.now() - hours * 3600_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  res.json({ locationId, period, ...tenant.routerTelemetryForLocationId(location.id, { since, limit: 1000 }) });
});

app.get('/api/business/vouchers', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  res.json({ vouchers: tenant.vouchersForBusiness.all(business.id, 2000) });
});

// Bulk voucher actions from the voucher manager: pause, resume, extend, delete.
app.post('/api/business/vouchers/manage', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const body = req.body || {};
  const action = String(body.action || '');
  const minutes = Math.floor(Number(body.minutes) || 0);
  try {
    const result = tenant.manageVouchers({ businessId: business.id, codes: body.codes, action, seconds: minutes * 60,
      // On the free trial a voucher can't be stretched past the trial package length.
      maxSeconds: trialLimited(business) ? TRIAL_LIMITS.maxPackageHours * 3600 : null });
    console.log(`[business vouchers] ${business.id} ${action} changed=${result.changed} skipped=${result.skipped.length}`);
    res.json({ ...result, vouchers: tenant.vouchersForBusiness.all(business.id, 2000) });
  } catch (err) {
    if (!err.status) console.error('[business vouchers] manage failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not update the vouchers.' });
  }
});

app.post('/api/business/vouchers', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const locationId = String(req.body && req.body.locationId || '');
  const packageId = Number(req.body && req.body.packageId);
  const count = Math.min(Math.max(Math.floor(Number(req.body && req.body.count) || 1), 1), 200);
  const location = tenant.locationForBusiness.get(locationId, business.id);
  const pkg = tenant.businessPackageById.get(packageId, business.id);
  if (!location || !pkg || !pkg.active) return res.status(400).json({ error: 'Choose one of your active packages and locations.' });
  if (trialLimited(business)) {
    const issued = db.db.prepare('SELECT COUNT(*) AS n FROM tenant_vouchers WHERE business_id=?').get(business.id).n;
    if (issued + count > TRIAL_LIMITS.maxVouchers) {
      return res.status(400).json({ error: `Your free trial includes up to ${TRIAL_LIMITS.maxVouchers} vouchers (${Math.max(0, TRIAL_LIMITS.maxVouchers - issued)} left). ${TRIAL_LIMIT_NOTE}`, needs: SUBSCRIBE_TRIAL, trialLimit: 'vouchers' });
    }
  }
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
  const payment = tenant.latestPaidTransactionForSubscription.get(subscription.id, subscription.location_id);
  return { found: true, authenticated: true, subscriptionId: subscription.id,
    payerPhone: subscription.payer_phone, username: subscription.router_username,
    password: subscription.password, remainingSeconds: tenantRemaining(subscription),
    rateLimit: subscription.rate_limit || null,
    expiresAt: subscription.expires_at.replace(' ', 'T') + 'Z',
    payment: payment ? {
      reference: payment.mpesa_receipt || payment.checkout_request_id,
      packageName: payment.package_name,
      amount: payment.amount,
      paidAt: payment.updated_at || payment.created_at,
      source: payment.payment_source || 'fiti',
    } : null,
    device: tenant.deviceForSubscription.get(subscription.location_id, subscription.id) || null,
    deviceType: subscription.device_type || 'phone',
    deviceLabel: subscription.device_label || '',
    mac: subscription.mac,
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

function unboundPayBillPayment(transaction) { return String(transaction && transaction.mac || '').startsWith('C2B:'); }

function tenantPaidPayload(transaction) {
  if (transaction && String(transaction.mac || '').startsWith('CLAIM:')) {
    return { status: transaction.status === 'paid' ? 'awaiting_claim' : 'pending', awaitingClaim: true };
  }
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
  // A PPPoE subscriber's payment adds days or credit, not a hotspot package.
  if (pppoeBilling.userIdFromTransaction(transaction)) return settlePppoeTransaction(transaction);
  // Offline purchases stay paid-but-unbound until the customer presents the
  // one-time claim code from the target device's captive portal.
  if (String(transaction.mac || '').startsWith('CLAIM:')) return transaction;
  if (unboundPayBillPayment(transaction)) return transaction;
  if (!transaction.provisioned) tenant.provisionPaidTransaction(checkoutRequestId);
  const provisioned = tenant.getTransaction.get(checkoutRequestId);
  // WhatsApp receipts cost money per message; a free-trial KES 1 sale does not send one.
  const paidAt = tenant.locationById.get(provisioned.location_id);
  if (!paidAt || !trialLimited(paidAt)) whatsappNotifications.enqueuePayment(provisioned, { eventIdPrefix: 'tenant-payment' });
  return provisioned;
}

function settlePppoeTransaction(transaction) {
  if (!transaction.provisioned) {
    try {
      const result = pppoeBilling.settleTransaction(transaction);
      tenant.setTransactionProvisioned.run({ checkoutRequestId: transaction.checkout_request_id, subscriptionId: null, provisioningJobId: null });
      if (result && !result.duplicate) notifyPppoePayment(result);
    } catch (err) {
      tenant.setProvisionError.run(String(err.message).slice(0, 200), transaction.checkout_request_id);
      throw err;
    }
  }
  return tenant.getTransaction.get(transaction.checkout_request_id);
}

/**
 * SMS receipt for a PPPoE payment: to whoever paid, and to the account holder
 * unless someone else paid and chose not to tell them. Uses the tenant's
 * FitiSignal credits; a failure never affects the payment.
 */
function notifyPppoePayment(result) {
  try {
    const user = result.user;
    const business = db.businessById.get(user.business_id);
    if (!business) return;
    const text = pppoeBilling.receiptText(business, user, result);
    const payer = result.payment.payer_phone ? mpesa.normalizePhone(result.payment.payer_phone) : null;
    const holder = user.phone || null;
    const targets = new Set();
    if (payer) targets.add(payer);
    const paidBySomeoneElse = payer && holder && payer !== holder;
    if (holder && !(paidBySomeoneElse && result.intent && !result.intent.notify_holder)) targets.add(holder);
    for (const to of targets) {
      try {
        fitiSignal.enqueue({ businessId: business.id, eventId: `pppoe-pay:${result.payment.id}:${to}`, serviceKey: 'payment_confirmation', to: `+${to}`, message: text });
      } catch (error) { console.warn(`[pppoe receipt] SMS not queued: ${error.message}`); }
    }
  } catch (error) { console.warn(`[pppoe receipt] ${error.message}`); }
}

async function queryTenantMpesa(transaction) {
  // Tuma settles through its authenticated callback. There is no Daraja
  // checkout-query call to make for a Tuma checkout; keeping it pending here
  // prevents the browser's status poll from declaring a payment failed before
  // Tuma delivers its callback.
  if (transaction.payment_source === 'tuma' || transaction.payment_source === 'tuma_direct') return { settled: false, resultCode: null, resultDesc: 'Waiting for Tuma callback.' };
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

// Whether this location may take a new sale at all: trial, a paid hotspot
// service or a legacy plan, each with a 3-day grace period after expiry.
function businessCanSell(location) {
  return serviceBilling.hotspotSaleBlock(location, { renewing: true }) || tumaFee.salesBlock(location.business_id)
    || (ownerPhoneBlock(location) ? 'This WiFi is not taking payments yet. Please ask the operator.' : null);
}

const hotspotOnlineNow = db.db.prepare(`SELECT COUNT(*) AS n FROM tenant_subscriptions
  WHERE business_id=? AND expires_at>datetime('now')`);

// Capacity check for one new sale. Prepaid hotspot capacity counts customers
// online right now; legacy Starter/Growth plans keep their monthly device cap.
function hotspotCapacityBlock(location, renewing) {
  if (renewing) return null;
  if (trialActive(location)) {
    // Enough customers to test with, not enough to run a building for free.
    if (trialLimited(location) && hotspotOnlineNow.get(location.business_id).n >= TRIAL_LIMITS.maxHotspotUsers) {
      return 'This WiFi is full right now. Please try again later.';
    }
    return null;
  }
  const services = serviceBilling.summary(location);
  if (services.hotspot.status === 'active' || services.hotspot.status === 'grace') {
    const blocked = serviceBilling.hotspotSaleBlock(location, { activeNow: hotspotOnlineNow.get(location.business_id).n, renewing: false });
    // A customer was turned away: prompt the owner to add users (once per level).
    if (blocked && serviceReminders) serviceReminders.capacityPrompt(location.business_id, 'hotspot', 'full').catch((err) => console.error('[capacity prompt]', err.message));
    return blocked;
  }
  const plan = BUSINESS_PLANS[location.business_plan] || BUSINESS_PLANS.starter;
  if (plan.activeDeviceLimit && tenant.activeMeter.get(location.business_id).n >= plan.activeDeviceLimit) {
    return 'This WiFi location has reached its current monthly customer limit. Please contact the operator.';
  }
  return null;
}

app.get('/p/:locationId', (req, res) => {
  if (!tenant.locationById.get(req.params.locationId)) return res.status(404).send('WiFi location not found.');
  // Always revalidate: a captive browser holding yesterday's portal script is
  // how fixed bugs keep reappearing.
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'tenant-portal.html'));
});

// Each tenant gets an installable app whose start URL stays on that tenant's
// portal. The manifest is deliberately public, just like the portal itself;
// it contains no account or payment data.
app.get('/api/tenant/:locationId/manifest.webmanifest', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const name = String(location.portal_name || location.business_name || 'Wi-Fi Fiti').trim().slice(0, 80);
  const start = `/p/${encodeURIComponent(location.id)}`;
  res.type('application/manifest+json').set('Cache-Control', 'public, max-age=300').json({
    name: `${name} WiFi`, short_name: name.slice(0, 24), start_url: start,
    scope: start + '/', display: 'standalone', background_color: '#f6f8fc',
    theme_color: '#1769d8', icons: [{ src: '/wifi-fiti-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
});

app.get('/api/tenant/:locationId/config', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const assetOrigin = edgePortalOriginForRequest(req, location) || config.domains.appUrl;
  const branding = brandingPayload({
    id: location.business_id, name: location.business_name, portal_name: location.portal_name,
    support_phone: location.support_phone, brand_primary_color: location.brand_primary_color,
    brand_logo_path: location.brand_logo_path, portal_message: location.portal_message,
  }, { assetOrigin });
  const payment = tenant.paymentConnectionSummary.get(location.business_id);
  const portalTemplate = db.db.prepare(`SELECT id,name,layout,accent_color,welcome_message,show_packages,show_utilities,font_family,text_align,package_style,background_style
    FROM tenant_portal_templates WHERE business_id=? AND active=1 ORDER BY updated_at DESC LIMIT 1`).get(location.business_id) || null;
  res.json({ location: { id: location.id, name: location.name, businessName: branding.name },
    portalUrl: portalUrlForLocation(location), branding,
    template: portalTemplate ? { id: portalTemplate.id, name: portalTemplate.name, layout: portalTemplate.layout, accentColor: portalTemplate.accent_color, welcomeMessage: portalTemplate.welcome_message, showPackages: Boolean(portalTemplate.show_packages), showUtilities: Boolean(portalTemplate.show_utilities), fontFamily: portalTemplate.font_family || 'modern', textAlign: portalTemplate.text_align || 'center', packageStyle: portalTemplate.package_style || 'stacked', backgroundStyle: portalTemplate.background_style || 'aurora' } : null,
    packages: tenant.packagesForLocation.all(location.id), supportPhone: branding.supportPhone,
    paybill: payment ? { shortcode: payment.shortcode, transactionType: payment.transaction_type } : null });
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

// Receipts are rendered by the server rather than assembled as a browser Blob.
// This keeps downloads usable in captive browsers and on iOS Files, while the
// session token remains in an HTTPS POST body instead of a URL.
app.post('/api/tenant/:locationId/receipt/:subscriptionId', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const subscription = tenantAccess.authenticate(location.id, String(req.body && req.body.sessionToken || ''), '');
  if (!subscription || subscription.id !== req.params.subscriptionId) return res.status(403).type('text/plain').send('Receipt access expired. Reconnect and try again.');
  const payment = tenant.latestPaidTransactionForSubscription.get(subscription.id, subscription.location_id);
  const assetOrigin = config.domains.appUrl;
  const branding = brandingPayload({
    id: location.business_id, name: location.business_name, portal_name: location.portal_name,
    support_phone: location.support_phone, brand_primary_color: location.brand_primary_color,
    brand_logo_path: location.brand_logo_path, portal_message: location.portal_message,
  }, { assetOrigin });
  const portal = portalUrlForLocation(location);
  const logo = branding.logoUrl || `${assetOrigin}/assets/wifi-fiti-logo.png`;
  const esc = escapeHtml;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WiFi receipt · ${esc(branding.name)}</title><style>body{font:16px Arial,sans-serif;color:#122740;max-width:640px;margin:0 auto;padding:32px 22px}img{width:84px;height:84px;object-fit:contain;display:block;margin-bottom:14px}h1{color:#1769d8;margin-bottom:4px}table{width:100%;border-collapse:collapse;margin:24px 0}td{padding:12px 0;border-bottom:1px solid #dce5f0}td:first-child{color:#687a91;width:42%}.code{font:800 24px monospace;letter-spacing:.12em;color:#168c62}.note{padding:15px;background:#f3f8ff;border-radius:10px;line-height:1.5}a{color:#1769d8;overflow-wrap:anywhere}</style><img src="${esc(logo)}" alt="${esc(branding.name)}"><h1>${esc(branding.name)}</h1><p>Payment receipt · WiFi access</p><table><tr><td>Customer portal</td><td><a href="${esc(portal)}">${esc(portal)}</a></td></tr><tr><td>Payment reference</td><td>${esc(payment ? (payment.mpesa_receipt || payment.checkout_request_id) : 'Pending reference')}</td></tr><tr><td>Package</td><td>${esc(payment && payment.package_name || 'WiFi package')}</td></tr><tr><td>Amount paid</td><td>KES ${esc(payment && payment.amount == null ? '' : payment ? Number(payment.amount).toLocaleString() : '')}</td></tr><tr><td>Paying number</td><td>${esc(subscription.payer_phone)}</td></tr><tr><td>Valid until</td><td>${esc(new Date(subscription.expires_at.replace(' ', 'T') + 'Z').toLocaleString())}</td></tr><tr><td>Recovery code</td><td class="code">${esc(subscription.password)}</td></tr></table><div class="note"><strong>Keep this receipt.</strong><br>Use the recovery code and paying number on the customer portal to check balance or move this package to another phone.</div><p>Generated ${esc(new Date().toLocaleString())}</p></html>`;
  // Inline rendering is more reliable than forced downloads in captive
  // browsers and iOS. The customer can screenshot, save, print, or share it
  // from the browser, with the receipt still carrying a stable filename.
  res.set('Content-Disposition', `inline; filename="wifi-fiti-receipt-${subscription.id}.html"`);
  res.type('html').send(html);
});

app.post('/api/tenant/:locationId/session/connect', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const subscription = tenantSessionForRequest(location, req);
  if (!subscription) return res.status(403).json({ error: 'Use your WiFi recovery code to reconnect this package.' });
  if (!tenantRemaining(subscription)) return res.status(402).json({ error: 'This package has ended. Choose a new package to continue.' });
  const ip = cleanIp(req.body && req.body.ip);
  const job = tenant.insertJob.run({ locationId: location.id, username: subscription.router_username,
    password: subscription.password, profile: 'standard', totalSeconds: subscription.total_seconds,
    rateLimit: subscription.rate_limit, mac: subscription.mac,
    ip: subscription.device_type === 'tv' ? null : ip,
    action: subscription.device_type === 'tv' ? 'tv-upsert' : 'upsert' });
  res.json({ ...tenantSessionPayload(subscription), status: 'pending', provisioningJobId: Number(job.lastInsertRowid) });
});

// Recover a confirmed payment whose router job was missed or never
// acknowledged. Receipt + paying number are required, and the existing grant
// is reused so recovery cannot create a second package or charge.
app.post('/api/tenant/:locationId/payment-recover', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const receipt = String(req.body && req.body.receipt || '').trim().toUpperCase().replace(/\s+/g, '');
  const mac = cleanMac(req.body && req.body.mac);
  if (!phone || !/^[A-Z0-9]{6,32}$/.test(receipt)) return res.status(400).json({ error: 'Enter the paying number and the M-Pesa transaction code.' });
  let transaction = tenant.paidTransactionByReceipt.get(location.id, phone, receipt);
  if (!transaction) return res.status(404).json({ error: 'We could not find a confirmed payment for that number and transaction code.' });
  if (String(transaction.mac || '').startsWith('CLAIM:')) {
    // Bought before joining the Wi-Fi and the claim code was never used (or
    // expired): the paying number and receipt bind it to this device.
    if (!mac) return res.status(400).json({ error: 'Join this Wi‑Fi on the device you want to connect, then try again.' });
    if (tenant.subscriptionLive(tenant.subscriptionByMac.get(location.id, mac) || {}) && tenant.subscriptionByMac.get(location.id, mac).payer_phone !== transaction.phone) {
      return res.status(409).json({ code: 'device_taken', error: 'This device already has a package bought with another number. Recover your payment on another device, or wait for that package to end.' });
    }
    tenant.bindUnclaimedPayment({ checkoutRequestId: transaction.checkout_request_id, mac });
    tenant.setPaymentDeviceIp({ checkoutRequestId: transaction.checkout_request_id, ip: cleanIp(req.body && req.body.ip) });
    transaction = tenant.getTransaction.get(transaction.checkout_request_id);
  }
  if (unboundPayBillPayment(transaction)) {
    // A PayBill payment is bound to the first device that recovers it.
    if (!mac) return res.status(400).json({ error: 'Join this Wi‑Fi on the device you want to connect, then try again.' });
    const capacityBlocked = hotspotCapacityBlock(location, Boolean(tenant.subscriptionByMac.get(location.id, mac)));
    if (capacityBlocked) return res.status(402).json({ error: capacityBlocked });
    tenant.bindPayBillPayment({ checkoutRequestId: transaction.checkout_request_id, mac });
    tenant.setPaymentDeviceIp({ checkoutRequestId: transaction.checkout_request_id, ip: cleanIp(req.body && req.body.ip) });
    transaction = tenant.getTransaction.get(transaction.checkout_request_id);
  }
  try {
    if (!transaction.provisioned) {
      tenant.clearProvisionError.run(transaction.checkout_request_id);
      try { provisionTenantPayment(transaction.checkout_request_id); }
      catch (error) {
        if (error.code !== 'device_taken') throw error;
        tenant.setProvisionError.run(error.message, transaction.checkout_request_id);
        return res.status(409).json({ code: 'device_taken', error: 'Your payment is safe, but this device still has a package bought with another number. Ask the WiFi operator to move your payment, or try again when that package ends.' });
      }
    }
    transaction = tenant.getTransaction.get(transaction.checkout_request_id);
    const subscription = tenant.subscriptionById.get(transaction.subscription_id, location.id);
    if (!subscription) return res.status(409).json({ error: 'The payment is confirmed but its package grant is incomplete. Try again shortly.' });
    if (!tenantRemaining(subscription)) return res.status(410).json({ error: 'That package has already expired.' });
    let pending = tenant.pendingProvisioningJobForUsername.get(location.id, subscription.router_username);
    if (!pending) {
      const job = tenant.insertJob.run({ locationId: location.id, username: subscription.router_username,
        password: subscription.password, profile: 'standard', totalSeconds: subscription.total_seconds,
        rateLimit: subscription.rate_limit, mac: subscription.mac,
        ip: subscription.mac === mac ? cleanIp(req.body && req.body.ip) : null,
        action: subscription.device_type === 'tv' ? 'tv-upsert' : 'upsert' });
      pending = { id: Number(job.lastInsertRowid) };
    }
    // Phone + receipt are printed on an SMS that people forward. They may
    // re-send the package to the device that owns it, but credentials and a
    // session token are only handed to that same device.
    if (!mac || subscription.mac !== mac) {
      return res.status(409).json({ code: 'other_device', recovered: true,
        error: 'Your package was re-sent to the device it belongs to. To use it on this device, choose Check remaining time and enter your WiFi recovery code.' });
    }
    res.json({ status: 'pending', recovered: true, provisioningJobId: Number(pending.id), ...tenantSessionPayload(subscription, true) });
  } catch (error) {
    console.error(`[tenant recovery] could not requeue ${transaction.checkout_request_id}:`, error.message);
    res.status(409).json({ error: 'The payment was found, but the router job could not be requeued yet. Try again shortly.' });
  }
});

// ---- Go live (stage 4): from a set-up router to the first paying customer --
// One read-only answer, from the same checks a real purchase uses, so the
// owner's checklist can never say "ready" while a customer would be refused.
function goLiveStatus(location) {
  const business = db.businessById.get(location.business_id);
  const layout = location.router_kit === 'universal' ? tenant.routerInventoryForLocation(location.id) : null;
  // The router must be checking in (it switches customers on) and running a
  // hotspot Wi-Fi Fiti serves: its own, or the one the kit adopted.
  const health = String(location.router_setup_health || '');
  const syncedAt = Date.parse(String(location.last_successful_sync_at || '').replace(' ', 'T') + 'Z');
  const online = Number.isFinite(syncedAt) && Date.now() - syncedAt < 5 * 60_000;
  const served = /^(ready|portal-missing)$/.test(health)
    || (location.router_kit === 'universal' && Boolean(layout && (layout.hotspots || []).some((h) => h.name === 'fiti-hotspot')));
  const hotspotOn = Boolean(location.router_setup_verified_at) && online && served;
  const hotspotNote = !online ? 'Your router has not checked in for a few minutes. Check its power and internet connection.'
    : !served ? 'Map your router first: set up the hotspot on the map.' : 'Customers can join and see your login page.';
  const trial = trialLimited(location);
  const packages = tenant.packagesForLocation.all(location.id);
  const sellable = packages.filter((p) => !trial || (p.price <= TRIAL_LIMITS.maxPackagePriceKes && p.seconds <= TRIAL_LIMITS.maxPackageHours * 3600));
  // How money reaches the owner, as /pay decides it.
  let collection = { ready: true, provider: 'fiti', note: 'Wi-Fi Fiti collects the payments for you.' };
  const selected = paymentIntegrations.summary(location.business_id).selected;
  if (selected === 'tuma') {
    let own = null; let broken = false;
    try { own = tumaTenants.credentialsFor(location.business_id); } catch (_) { broken = true; }
    if (broken) collection = { ready: false, provider: 'tuma', note: 'Reconnect your Tuma payout account.' };
    else if (!tuma.callbackConfigured() || (!own && !tuma.configured())) collection = { ready: false, provider: 'tuma', note: 'Tuma is selected but not set up yet.' };
    else collection = { ready: true, provider: 'tuma', note: own ? 'Payments go straight to your Tuma payout account.' : 'Payments are collected through Wi-Fi Fiti’s Tuma account and paid out to you.' };
  } else if (location.collection_mode === 'own') {
    let creds = null; try { creds = tenant.paymentCredentials(location.business_id); } catch (_) { creds = null; }
    collection = creds ? { ready: true, provider: 'own', note: 'Payments go to your own M-Pesa PayBill or Till.' }
      : { ready: false, provider: 'own', note: 'Finish connecting your own M-Pesa PayBill or Till.' };
  }
  // Why a purchase would be refused, told to the owner (the customer-facing
  // wording says "ask the operator"), with what fixes it.
  const phoneBlock = ownerPhoneBlock(location);
  const serviceBlock = serviceBilling.hotspotSaleBlock(location, { renewing: true });
  const feeBlock = tumaFee.salesBlock(location.business_id);
  let blocked = null; let fix = collection.ready ? null : 'payments';
  if (phoneBlock) { blocked = phoneBlock; fix = 'verify_phone'; }
  else if (String(location.billing_status || '').toLowerCase() === 'suspended') { blocked = 'Your Wi-Fi Fiti account is paused, so customers can’t buy yet. Contact Wi-Fi Fiti support.'; fix = null; }
  else if (serviceBlock) { blocked = 'Your hotspot subscription needs renewing before customers can buy. Renew it in Settings → Billing & payments.'; fix = 'payments'; }
  else if (feeBlock) { blocked = 'The Tuma fee is overdue, so new sales are paused. Pay it in Settings → Billing & payments.'; fix = 'payments'; }
  else if (hotspotCapacityBlock(location, false)) { blocked = trialLimited(location) ? `Your free trial allows ${TRIAL_LIMITS.maxHotspotUsers} customers online at once, and it is full right now. New customers can buy once someone's time ends, or subscribe for more.` : 'Your hotspot is full right now: new customers can buy once someone\u2019s time ends, or raise your plan in Settings → Billing & payments.'; fix = 'payments'; }
  const sale = tenant.latestSale(location.id);
  return {
    locationId: location.id,
    portalUrl: portalUrlForLocation(location),
    trial,
    trialLimits: trial ? { maxPriceKes: TRIAL_LIMITS.maxPackagePriceKes, maxHours: TRIAL_LIMITS.maxPackageHours, maxPackages: TRIAL_LIMITS.maxPackages } : null,
    hotspot: { ready: hotspotOn, online, note: hotspotNote },
    packages: { ready: sellable.length > 0, count: packages.length, sellable: sellable.length, cheapest: sellable.length ? sellable.reduce((a, b) => (a.price <= b.price ? a : b)) : null },
    portal: { ready: true, customised: Boolean(business && (business.portal_name || business.brand_logo_path)), name: (business && (business.portal_name || business.name)) || '' },
    payments: { ready: collection.ready && !blocked, provider: collection.provider, note: blocked || collection.note, blocked: Boolean(blocked), fix },
    paying: tenant.paymentInProgress(location.id),
    sale: sale ? { packageName: sale.packageName, amount: sale.amount, receipt: sale.receipt, paidAt: sale.paidAt, connected: Boolean(sale.connectedAt), connectedAt: sale.connectedAt, problem: sale.provisionError && !sale.provisioned ? sale.provisionError : null, count: sale.count } : null,
    // Live once any paid customer has been switched on, not only the latest.
    live: tenant.firstCustomerConnected(location.id),
  };
}
app.get('/api/business/locations/:locationId/go-live', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const owned = tenant.locationForBusiness.get(String(req.params.locationId), business.id);
  if (!owned) return res.status(404).json({ error: 'Location not found.' });
  // The same location record a customer's purchase is checked against.
  const location = tenant.locationById.get(owned.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json(goLiveStatus(location));
});
// ---- Router tools: run and follow from the dashboard --------------------
function toolLocation(req, res) {
  const business = businessAuth(req, res); if (!business) return null;
  const location = tenant.locationForBusiness.get(String(req.params.locationId), business.id);
  if (!location) { res.status(404).json({ error: 'Location not found.' }); return null; }
  if (!location.router_setup_verified_at) { res.status(409).json({ error: 'Pair this router first: tools run on a router that is checking in.' }); return null; }
  return location;
}
// A customer check: what Wi-Fi Fiti knows (package, payment) next to what the
// router sees for that device.
function customerAccount(locationId, mac) {
  const sub = tenant.subscriptionByMac.get(locationId, mac);
  if (!sub) return null;
  const expires = Date.parse(String(sub.expires_at).replace(' ', 'T') + 'Z');
  const pay = db.db.prepare(`SELECT package_name AS packageName, amount, status, mpesa_receipt AS receipt, updated_at AS at FROM tenant_transactions WHERE location_id=? AND mac=? ORDER BY updated_at DESC LIMIT 1`).get(locationId, mac);
  return { phone: String(sub.payer_phone || '').replace(/^(\d{3})\d+(\d{3})$/, '$1•••$2'), expiresAt: sub.expires_at, hasTime: Number.isFinite(expires) && expires > Date.now(), active: Boolean(sub.is_active), lastPayment: pay || null };
}
app.get('/api/business/locations/:locationId/tools', (req, res) => {
  const location = toolLocation(req, res); if (!location) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ runs: routerTools.listTools(location.id).map((run) => (run.tool === 'customer' && run.args.mac ? { ...run, account: customerAccount(location.id, run.args.mac) } : run)) });
});
app.post('/api/business/locations/:locationId/tools', (req, res) => {
  const location = toolLocation(req, res); if (!location) return;
  const tool = String(req.body && req.body.tool || '');
  const args = { ...(req.body || {}) };
  // A phone number that bought a package here finds that customer's device.
  if (tool === 'customer' && args.phone && !args.mac) {
    const phone = mpesa.normalizePhone(args.phone);
    const sub = phone && db.db.prepare(`SELECT mac FROM tenant_subscriptions WHERE location_id=? AND payer_phone=? AND mac NOT LIKE 'CLAIM:%' ORDER BY updated_at DESC LIMIT 1`).get(location.id, phone);
    if (!sub) return res.status(404).json({ error: 'No package was bought with that number at this location. Try the device’s MAC address instead.' });
    args.mac = sub.mac;
  }
  try {
    const synced = Date.parse(String(location.last_successful_sync_at || '').replace(' ', 'T') + 'Z');
    const run = routerTools.queueTool(location.id, tool, args, { busyChange: location.router_kit === 'universal' && routerChanges.hasActiveChange(location.id), online: Number.isFinite(synced) && Date.now() - synced < 5 * 60_000 });
    res.status(201).json({ run, runs: routerTools.listTools(location.id) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not start that tool.' }); }
});

// Ready-made packages for an owner with none yet: they can edit or remove
// them. Inside the free trial's limits while the trial lasts.
app.post('/api/business/packages/starter', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  if (db.packagesForBusiness.all(business.id).length) return res.status(409).json({ error: 'You already have packages. Edit them in Packages.', packages: db.packagesForBusiness.all(business.id) });
  const starter = trialLimited(business)
    ? [{ name: '30 minutes', price: 1, hours: 0.5 }, { name: '2 hours', price: 2, hours: 2 }, { name: '1 day', price: 3, hours: 24 }]
    : [{ name: '1 hour', price: 10, hours: 1 }, { name: '1 day', price: 50, hours: 24 }, { name: '1 week', price: 250, hours: 24 * 7 }];
  for (const p of starter) db.addBusinessPackage.run({ businessId: business.id, name: p.name, price: p.price, seconds: Math.round(p.hours * 3600), rateLimit: null });
  res.status(201).json({ packages: db.packagesForBusiness.all(business.id) });
});

app.post('/api/tenant/:locationId/pay', async (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const salesBlocked = businessCanSell(location);
  if (salesBlocked) return res.status(402).json({ error: salesBlocked });
  const pkg = tenant.packageForLocation.get(Number(req.body && req.body.packageId), location.id);
  // A package priced above the trial cap (e.g. created before the cap) is
  // never sold while the operator is on the free trial.
  if (pkg && trialLimited(location) && (pkg.price > TRIAL_LIMITS.maxPackagePriceKes || pkg.seconds > TRIAL_LIMITS.maxPackageHours * 3600)) {
    return res.status(402).json({ error: 'This package is not available yet. Please choose another package or ask the operator.' });
  }
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  const deviceType = purchaseDeviceType(req.body && req.body.deviceType);
  let mac;
  if (deviceType === 'tv' && String(req.body && req.body.mac || '').startsWith('dev:')) {
    // A device picked from discovery: check the token and the typed suffix.
    mac = macFromDeviceToken(location.id, req.body.mac);
    if (!mac) return res.status(400).json({ error: 'That device list has expired. Tap Refresh and choose the device again.' });
    const confirm = String(req.body && req.body.deviceConfirm || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    if (confirm !== mac.replace(/:/g, '').slice(-4)) return res.status(400).json({ error: 'The last four MAC characters do not match the selected device.' });
  } else {
    mac = deviceType === 'tv' ? normaliseTvMac(req.body && req.body.mac) : cleanMac(req.body && req.body.mac);
  }
  const deviceLabel = normaliseDeviceLabel(req.body && req.body.deviceLabel, deviceType);
  const ip = cleanIp(req.body && req.body.ip);
  if (!pkg || !phone || !deviceType || (deviceType === 'tv' && !mac)) return res.status(400).json({ error: 'Choose a package, enter a valid number, and select the device.' });
  const offlineClaim = !mac && deviceType === 'phone';
  if (offlineClaim) mac = `CLAIM:${crypto.randomBytes(12).toString('hex')}`;
  const existingSubscription = offlineClaim ? null : tenant.subscriptionByMac.get(location.id, mac);
  // Never take money for a device that another number's live package owns:
  // the payment could not be switched on.
  if (existingSubscription && tenant.subscriptionLive(existingSubscription)
      && (existingSubscription.payer_phone !== phone || (existingSubscription.device_type || 'phone') !== deviceType)) {
    return res.status(409).json({ code: 'device_taken', error: deviceType === 'tv'
      ? 'This TV already has a package bought with another number. Use that package until it ends.'
      : 'This device already has a package bought with another number. Use that package, or check its time with that number.' });
  }
  const capacityBlocked = hotspotCapacityBlock(location, Boolean(existingSubscription));
  if (capacityBlocked) return res.status(402).json({ error: capacityBlocked });
  const pendingPayment = tenant.pendingPaymentForPhone.get(location.id, phone);
  if (pendingPayment) {
    return res.status(429).json({ error: 'A payment request is already on its way to this number. Please check the phone first.' });
  }
  const throttleKey = `${location.id}:${phone}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) {
    return res.status(429).json({ error: 'A payment request is already on its way. Please wait a moment.' });
  }
  // A free-trial portal can prompt any number; keep that to a test volume.
  if (trialLimited(location) && !tenantAccess.allowed(`trial-prompts:${location.business_id}`, TRIAL_PROMPTS_PER_DAY, 86400_000).allowed) {
    return res.status(429).json({ error: 'This WiFi has reached its payment limit for today. Please try again tomorrow.' });
  }
  try {
    lastPush.set(throttleKey, Date.now());
    const { pushed, paymentSource, platformFee } = await pushTenantPrompt(location, {
      phone, amount: pkg.price, description: pkg.name, accountReference: `WF-${location.id.slice(-6)}` });
    const portalToken = tenantPortalCapability();
    tenant.insertTransaction.run({ checkoutRequestId: pushed.checkoutRequestId,
      merchantRequestId: pushed.merchantRequestId, businessId: location.business_id, locationId: location.id,
      phone, packageId: pkg.id, packageName: pkg.name, amount: pkg.price, seconds: pkg.seconds,
      rateLimit: pkg.rate_limit, mac, ip: deviceType === 'tv' ? null : ip });
    tenant.setTransactionDevice.run({ checkoutRequestId: pushed.checkoutRequestId, deviceType, deviceLabel });
    tenant.setTransactionTerms.run({ checkoutRequestId: pushed.checkoutRequestId, paymentSource, platformFee });
    tenant.setTransactionPortalCapability.run({
      checkoutRequestId: pushed.checkoutRequestId,
      portalTokenHash: tenant.tokenHash(portalToken),
      portalTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    });
    if (offlineClaim) {
      const claimCode = String(crypto.randomInt(10000000, 100000000));
      tenant.createPaymentClaim({ checkoutRequestId: pushed.checkoutRequestId, locationId: location.id,
        code: claimCode, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') });
      res.json({ checkoutRequestId: pushed.checkoutRequestId, portalToken, amount: pkg.price,
        phoneDisplay: mpesa.displayPhone(phone), deviceType, deviceLabel, claimCode, claimExpiresInSeconds: 600 });
      return;
    }
    res.json({ checkoutRequestId: pushed.checkoutRequestId, portalToken, amount: pkg.price, phoneDisplay: mpesa.displayPhone(phone), deviceType, deviceLabel, mac });
  } catch (err) {
    lastPush.delete(throttleKey);
    if (err.promptStatus) return res.status(err.promptStatus).json({ error: err.message });
    console.error('[tenant pay] STK push failed:', err.message);
    res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});

/**
 * Send an M-Pesa prompt for a customer payment by the rail this business
 * uses: its own Tuma business (direct settlement), its own Daraja PayBill or
 * Till, or Wi-Fi Fiti collection (Tuma, falling back to Daraja) with the 5%
 * fee. Shared by hotspot packages and PPPoE subscriptions. A setup problem
 * the customer should hear about throws with `promptStatus`.
 */
async function pushTenantPrompt(location, { phone, amount, description, accountReference }) {
  const setupError = (message) => Object.assign(new Error(message), { promptStatus: 409 });
  let pushed;
  let paymentSource = 'fiti';
  let platformFee = amount * 5 / 100;
  const selectedProvider = paymentIntegrations.summary(location.business_id).selected;
  if (selectedProvider === 'tuma') {
    // Prefer the tenant's own Tuma business: the money settles directly to
    // the Till / PayBill / bank they chose. Without one, the platform Tuma
    // account collects and the sale is owed to the tenant ('tuma').
    let tenantTuma = null;
    // A tenant who subscribed after their Tuma business was switched off
    // gets it back before this payment, so the money still goes to them.
    await tumaTenants.resumeIfSuspended(location.business_id, tumaAccountEntitled).catch(() => false);
    try { tenantTuma = tumaTenants.credentialsFor(location.business_id); }
    catch (err) { throw setupError('This operator needs to reconnect their Tuma payout account.'); }
    // Both paths need the callback secret: it is how Tuma's result reaches us.
    if (!tuma.callbackConfigured() || (!tenantTuma && !tuma.configured())) {
      throw setupError('Tuma is selected but its API credentials are not configured yet.');
    }
    pushed = await tuma.stkPush({ credentials: tenantTuma || undefined, phone, amount,
      publicUrl: config.publicUrl, description });
    paymentSource = tenantTuma ? 'tuma_direct' : 'tuma';
    platformFee = 0;
  } else if (location.collection_mode === 'own') {
    let credentials;
    try { credentials = tenant.paymentCredentials(location.business_id); }
    catch (err) { throw setupError('This operator needs to reconnect their own M-Pesa collection account.'); }
    if (!credentials) throw setupError('This operator must finish connecting their own M-Pesa collection account before taking payments.');
    pushed = await tenantMpesa.stkPush({ credentials, phone, amount, accountReference, description });
    paymentSource = 'own';
    platformFee = 0;
  } else {
    // Wi-Fi Fiti collection: the customer pays Wi-Fi Fiti's Tuma account
    // and the sale, less Wi-Fi Fiti's 5%, is owed to the tenant ('tuma').
    // Daraja on the platform shortcode stays as the fallback ('fiti').
    // PLATFORM_COLLECTION=daraja forces Daraja.
    const preferTuma = String(process.env.PLATFORM_COLLECTION || 'tuma').toLowerCase() !== 'daraja';
    if (preferTuma && tuma.configured() && tuma.callbackConfigured()) {
      try {
        pushed = await tuma.stkPush({ phone, amount, publicUrl: config.publicUrl, description });
        paymentSource = 'tuma';
      } catch (err) {
        console.warn(`[tenant collection] Wi-Fi Fiti Tuma prompt failed for KES ${amount}, using Daraja: ${err.message} ${err.details || ''}`);
      }
    }
    if (!pushed) {
      pushed = await mpesa.stkPush({ phone, amount, accountReference, description });
      paymentSource = 'fiti';
    }
  }
  return { pushed, paymentSource, platformFee };
}

app.get('/api/tenant/:locationId/status/:checkoutRequestId', async (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  let tx = tenant.getTransaction.get(req.params.checkoutRequestId);
  if (!tx || tx.location_id !== location.id) return res.status(404).json({ error: 'Payment not found.' });
  if (!tenantPortalCapabilityOk(tx, req.get('X-WiFi-Fiti-Portal'))) {
    // An offline purchase whose code was entered on another device: that
    // device now holds the payment page. Tell the buying page where the
    // package went; its credentials and session stay on the claiming device.
    if (tenant.claimedElsewhere(tx.checkout_request_id)) return res.json({ status: 'claimed', claimed: true });
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
    // Looked up by phone number alone, so never the full MAC.
    mac: maskMac(subscription.mac),
    remainingSeconds,
    rateLimit: subscription.rate_limit || null,
    expiresAt: subscription.expires_at.replace(' ', 'T') + 'Z',
    deviceType: subscription.device_type || 'phone',
    deviceLabel: subscription.device_label || '',
    device: device ? { mac: maskMac(device.mac), label: device.label } : null,
  };
}
function maskMac(value) {
  const parts = String(value || '').split(':');
  return parts.length === 6 ? `${parts[0]}:••:••:••:${parts[4]}:${parts[5]}` : (value ? 'Saved device' : null);
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
  if (moved && moved.error === 'device_locked') {
    return res.status(409).json({ code: 'device_locked', error: 'A TV package is locked to its original TV MAC address.' });
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

const paymentClaimAttempts = new Map();
app.post('/api/tenant/:locationId/claim', async (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const code = String(req.body && req.body.code || '').replace(/\D/g, '');
  const mac = cleanMac(req.body && req.body.mac);
  const attemptKey = `${location.id}:${req.ip}`;
  const now = Date.now();
  const attempt = paymentClaimAttempts.get(attemptKey) || { at: now, count: 0 };
  if (now - attempt.at > 60_000) { attempt.at = now; attempt.count = 0; }
  if (++attempt.count > 8) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  paymentClaimAttempts.set(attemptKey, attempt);
  if (!/^\d{8}$/.test(code) || !mac) return res.status(400).json({ error: 'Enter the 8-digit claim code after joining this Wi‑Fi.' });
  // Wrong codes never match a claim row, so count them per location: a
  // guesser rotating IPs or MACs still runs out of tries.
  const failures = `claim-failures:${location.id}`;
  const budget = tenantAccess.peek(failures, 100);
  if (!budget.allowed) return res.status(429).set('Retry-After', String(budget.retryAfter)).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  const claimed = tenant.claimPaymentDevice({ locationId: location.id, code, mac });
  if (claimed.error === 'invalid' || claimed.error === 'mac') tenantAccess.allowed(failures, 100, 10 * 60_000);
  console.log(`[tenant claim] ${location.id} ${claimed.error ? `refused (${claimed.error})` : claimed.reclaimed ? 'handed back to the same device' : 'bound to a device'}`);
  if (claimed.error === 'pending') return res.json({ status: 'pending', awaitingPayment: true });
  if (claimed.error === 'expired') return res.status(410).json({ error: 'This claim code has expired. Start a new payment.' });
  if (claimed.error === 'locked') return res.status(429).json({ error: 'This claim code is locked. Start a new payment.' });
  if (claimed.error || !claimed.checkoutRequestId) return res.status(403).json({ error: 'That claim code is not valid for this Wi‑Fi.' });
  // Record the claiming device's hotspot IP so the router logs it in as soon
  // as the package is created (a claim has no IP from the purchase).
  tenant.setPaymentDeviceIp({ checkoutRequestId: claimed.checkoutRequestId, ip: cleanIp(req.body && req.body.ip) });
  let tx = tenant.getTransaction.get(claimed.checkoutRequestId);
  // The code is single-use, so hand this device the payment page: a fresh
  // capability replaces the buying device's, and this device follows the
  // router setup and signs in exactly like an on-Wi-Fi purchase.
  const portalToken = tenantPortalCapability();
  tenant.setTransactionPortalCapability.run({ checkoutRequestId: tx.checkout_request_id,
    portalTokenHash: tenant.tokenHash(portalToken),
    portalTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') });
  const handoff = { checkoutRequestId: tx.checkout_request_id, portalToken };
  if (tx.status === 'pending') tx = await queryTenantNow(tx);
  if (tx.status === 'paid') {
    try { tx = provisionTenantPayment(tx.checkout_request_id); }
    catch (err) { return res.json({ status: 'pending', awaitingRouter: true, ...handoff }); }
    // A repeat claim after the package was already created: ask the router
    // to log this device in again, now with its current hotspot IP.
    const claimIp = cleanIp(req.body && req.body.ip);
    if (claimed.reclaimed && claimIp && tx.subscription_id) {
      const subscription = tenant.subscriptionById.get(tx.subscription_id, location.id);
      if (subscription && subscription.mac === mac && tenantRemaining(subscription)) {
        tenant.insertJob.run({ locationId: location.id, username: subscription.router_username, password: subscription.password,
          profile: 'standard', totalSeconds: subscription.total_seconds, rateLimit: subscription.rate_limit, mac: subscription.mac,
          ip: claimIp, action: 'upsert' });
      }
    }
    return res.json({ ...tenantPaidPayload(tx), ...handoff });
  }
  res.json({ status: 'pending', awaitingPayment: true, ...handoff });
});

function deviceMac(value) {
  const compact = String(value || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return compact.length === 12 ? compact.match(/.{2}/g).join(':') : null;
}

// Discovery is a convenience only: the router reports recently bound
// customer-network leases over its authenticated sync channel. The portal
// receives masked identifiers and a short-lived confirmation token, never a
// device's full MAC in the UI. Manual MAC entry remains the fallback for TVs
// that use static addressing or do not advertise a lease.
// Discovery hands out an encrypted, short-lived device token instead of the
// MAC, and only the vendor part of the MAC. The customer proves the choice by
// typing the MAC's last four characters, which the server checks at /pay.
const DEVICE_TOKEN_TTL_MS = 15 * 60_000;
function deviceTokenFor(locationId, mac) {
  return 'dev:' + tenant.encryptSecret(JSON.stringify({ l: locationId, m: mac, e: Date.now() + DEVICE_TOKEN_TTL_MS }));
}
function macFromDeviceToken(locationId, token) {
  try {
    const value = JSON.parse(tenant.decryptSecret(String(token).slice(4)));
    return value && value.l === locationId && value.e > Date.now() ? deviceMac(value.m) : null;
  } catch (_) { return null; }
}
app.get('/api/tenant/:locationId/device-discovery', (req, res) => {
  const location = publicLocation(req.params.locationId, res); if (!location) return;
  const excluded = deviceMac(req.query.excludeMac);
  const devices = tenant.routerDevicesForLocation(location.id)
    .filter((device) => !excluded || device.mac !== excluded)
    .map((device) => ({
      id: deviceTokenFor(location.id, device.mac),
      label: device.hostname || 'Wi‑Fi device',
      maskedMac: device.mac.split(':').slice(0, 3).join(':') + ':••:••:••',
      lastSeenAt: device.last_seen_at,
    }));
  res.set('Cache-Control', 'no-store').json({ devices, refreshedAt: new Date().toISOString(), maxAgeSeconds: 300 });
});

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
  return res.status(402).json({ error: 'TV access requires a separate package. Choose Buy for TV.' });
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
  const capacityBlocked = hotspotCapacityBlock(location, Boolean(tenant.subscriptionByMac.get(location.id, mac)));
  if (capacityBlocked) return res.status(402).json({ error: capacityBlocked });
  try {
    const result = tenant.redeemVoucher({ locationId: location.id, code, phone, mac, ip });
    if (!result) return res.status(409).json({ error: 'That voucher is not available at this location, has already been used, or is paused.' });
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
  // RouterOS exposes `link-login-only` and `link-orig-esc`; there is no
  // `link-login-only-esc` variable. Using the latter leaves the customer
  // portal with a literal, unusable form action, so payment succeeds but the
  // captive browser never authenticates until the page is refreshed.
  const portal = `${portalUrlForRouter(location, req.query.portal)}?mac=$(mac)&ip=$(ip)&link-login-only=$(link-login-only)&link-orig=$(link-orig-esc)`;
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
  if (!mac || !fromLegacySite(req)) return res.json({ found: false });
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

// Tuma sends a normalized JSON callback for the checkout id returned by its
// STK endpoint. The callback URL includes a deployment-only secret so an
// arbitrary POST cannot mark a Wi-Fi package paid.
app.post('/api/tuma/callback', (req, res) => {
  const suppliedKey = req.query.key || req.get('X-Tuma-Callback-Key');
  if (!tuma.callbackAuthorized(suppliedKey)) return res.status(401).json({ error: 'Unauthorized callback.' });
  res.status(200).json({ success: true, message: 'Accepted' });
  setImmediate(() => {
    // Live-demo prompts share Tuma's callback URL but never touch tenant
    // billing; the demo module claims only checkout ids it created.
    try { if (demo.handleTumaCallback(req.body)) return; }
    catch (err) { console.error('[tuma callback] demo handler threw:', err); return; }
    handleTumaBusinessBilling(req.body)
      .then((handled) => handled ? null : handleTumaCallback(req.body))
      .catch((err) => console.error('[tuma callback] handler threw:', err));
  });
});

// A tenant paying Wi‑Fi Fiti (prepaid services, extra users, Tuma fee)
// through Wi‑Fi Fiti's own Tuma account. Returns true when the checkout id
// belongs to a platform billing payment.
async function handleTumaBusinessBilling(body) {
  const checkoutRequestId = String(body && body.checkout_request_id || '').trim();
  if (!/^[-A-Za-z0-9_]{8,160}$/.test(checkoutRequestId)) return false;
  const transaction = tenant.businessBillingTransaction.get(checkoutRequestId);
  if (!transaction || transaction.payment_source !== 'tuma') return false;
  // A late success may still recover a payment marked failed after a
  // timeout; a paid one is never processed twice.
  if (transaction.status === 'paid') {
    console.log(`[tuma billing callback] ${checkoutRequestId} already paid, ignoring replay`);
    return true;
  }
  const resultCode = Number(body && body.result_code);
  const completed = String(body && body.status || '').toLowerCase() === 'completed' || resultCode === 0;
  const resultDesc = String(body && (body.result_desc || body.failure_reason) || '').slice(0, 240) || null;
  if (!completed || (Number.isFinite(resultCode) && resultCode !== 0)) {
    tenant.setBusinessBillingResult.run({ checkoutRequestId, status: 'failed',
      resultCode: Number.isFinite(resultCode) ? resultCode : 1, resultDesc: resultDesc || 'Tuma payment was not completed.', receipt: null });
    return true;
  }
  // The amount must match what was asked; a short payment never activates.
  if (Math.round(Number(body.amount)) !== Math.round(Number(transaction.amount))) {
    console.error(`[tuma billing callback] ${checkoutRequestId} amount ${body.amount} does not match ${transaction.amount}; not activating`);
    return true;
  }
  const receipt = String(body.mpesa_receipt_number || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(receipt) || db.isDuplicateReceipt(receipt, checkoutRequestId) ||
      tenant.duplicateReceipt.get(receipt, checkoutRequestId) || tenant.duplicateBusinessBillingReceipt.get(receipt, checkoutRequestId)) {
    console.error(`[tuma billing callback] receipt ${receipt || 'missing'} invalid or already used; not activating ${checkoutRequestId}`);
    return true;
  }
  tenant.setBusinessBillingResult.run({ checkoutRequestId, status: 'paid', resultCode: 0, resultDesc: resultDesc || 'Tuma payment completed.', receipt });
  try { tenant.activateBusinessBilling(checkoutRequestId); }
  catch (err) { console.error(`[tuma billing callback] activation ${checkoutRequestId} failed:`, err.message); }
  return true;
}

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

async function handleTumaCallback(body) {
  const checkoutRequestId = String(body && body.checkout_request_id || '').trim();
  if (!/^[-A-Za-z0-9_]{8,160}$/.test(checkoutRequestId)) return;
  const tx = tenant.getTransaction.get(checkoutRequestId);
  if (!tx || (tx.payment_source !== 'tuma' && tx.payment_source !== 'tuma_direct')) return;
  const resultCode = Number(body && body.result_code);
  const completed = String(body && body.status || '').toLowerCase() === 'completed' || resultCode === 0;
  const settledCode = Number.isFinite(resultCode) ? resultCode : (completed ? 0 : 1);
  const callback = {
    checkoutRequestId,
    merchantRequestId: body && body.merchant_request_id,
    resultCode: settledCode,
    resultDesc: body && (body.result_desc || body.failure_reason),
    amount: body && body.amount,
    receipt: body && body.mpesa_receipt_number,
  };
  if (!callbackNeedsVerification(callback, tx)) return;
  // The shared callback key is the only thing authenticating a Tuma callback,
  // so a success must also state the amount, and it must match the checkout.
  if (settledCode === 0 && completed && (callback.amount === undefined || callback.amount === null || callback.amount === '' ||
      Math.round(Number(callback.amount)) !== Number(tx.amount))) {
    console.warn(`[tuma callback] ${checkoutRequestId} success without the expected amount; not granting`);
    return;
  }
  if (!callbackMatchesTransaction(callback, tx)) return;
  if (settledCode !== 0 || !completed) {
    tenant.setTransactionResult.run({ checkoutRequestId, status: 'failed', resultCode: settledCode,
      resultDesc: callback.resultDesc || 'Tuma payment was not completed.', receipt: null });
    return;
  }
  const receipt = callbackReceipt(callback);
  if (!receipt || db.isDuplicateReceipt(receipt, checkoutRequestId) ||
      tenant.duplicateReceipt.get(receipt, checkoutRequestId) ||
      tenant.duplicateBusinessBillingReceipt.get(receipt, checkoutRequestId)) {
    console.error(`[tuma callback] receipt ${receipt || 'missing'} already used or invalid; not crediting ${checkoutRequestId}`);
    return;
  }
  tenant.setTransactionResult.run({ checkoutRequestId, status: 'paid', resultCode: 0,
    resultDesc: callback.resultDesc || 'Tuma payment completed.', receipt });
  try { provisionTenantPayment(checkoutRequestId); }
  catch (err) { console.error(`[tuma callback] provisioning ${checkoutRequestId} failed:`, err.message); }
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
    // Tuma checkouts settle only by callback; there is nothing to query.
    // Give up on one after an hour so the customer can simply pay again.
    if (tx.payment_source === 'tuma' || tx.payment_source === 'tuma_direct') {
      const age = Date.now() - new Date(String(tx.created_at).replace(' ', 'T') + 'Z').getTime();
      if (age > 60 * 60_000) tenant.setTransactionResult.run({ checkoutRequestId: tx.checkout_request_id,
        status: 'failed', resultCode: 1037, resultDesc: 'No confirmation was received from Tuma.', receipt: null });
      continue;
    }
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
      // A device another number's live package owns will not free itself in
      // 8 seconds. Record it once and stop retrying; the customer's "Already
      // paid?" recovery tries again, and the owner sees it in the dashboard.
      if (err.code === 'device_taken') {
        tenant.setProvisionError.run(err.message, tx.checkout_request_id);
        console.warn(`[tenant reconcile] ${tx.checkout_request_id} (${tx.phone}) paid but the device has another number's live package; needs the operator`);
      } else {
        console.warn(`[tenant reconcile] provisioning still failing for ${tx.phone}:`, err.message);
      }
    }
  }

  for (const tx of tenant.staleBusinessBilling.all(STALE_AFTER_SECONDS)) {
    // Tuma-collected payments settle only by callback. Give up on one after
    // an hour so the tenant can try again; it never activates without proof.
    if (tx.payment_source === 'tuma') {
      const age = Date.now() - new Date(String(tx.created_at).replace(' ', 'T') + 'Z').getTime();
      if (age > 60 * 60_000) tenant.setBusinessBillingResult.run({ checkoutRequestId: tx.checkout_request_id,
        status: 'failed', resultCode: 1037, resultDesc: 'No confirmation was received from Tuma.', receipt: null });
      continue;
    }
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
// The legacy portal identifies a device by the MAC its router puts in the
// redirect. A MAC typed in from anywhere else on the internet proves nothing,
// so credentials and payment details go only to requests arriving from the
// site's own connection: the address the router last polled from. Until the
// router has polled (e.g. just after a restart) the check stays open.
let legacySiteSeen = null;
function fromLegacySite(req) {
  // Escape hatch for a site whose router polls over a different connection
  // (e.g. a VPN) from its customers.
  if (String(process.env.LEGACY_SITE_IP_CHECK || '').toLowerCase() === 'off') return true;
  if (!legacySiteSeen || Date.now() - legacySiteSeen.at > 15 * 60_000) return true;
  return String(req.ip || '') === legacySiteSeen.ip;
}

app.get('/api/session', (req, res) => {
  const mac = cleanMac(req.query.mac);
  if (!mac || !fromLegacySite(req)) return res.json({ found: false });

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
  const viewingMac = cleanMac(req.body && req.body.mac);
  const requestedMac = cleanMac(req.body && (req.body.accountMac || req.body.mac));
  let accountId = phone;
  const active = db.activeAccountsForPayer.all(phone);
  const picked = String(req.body && req.body.accountId || '');
  if (picked && active.some((account) => account.phone === picked)) accountId = picked;
  else if (requestedMac) {
    const bound = db.accountByMac.get(requestedMac);
    if (bound && (bound.payer_phone || bound.phone) === phone) accountId = bound.phone;
  }
  if (accountId === phone) {
    if (active.length === 1) accountId = active[0].phone;
    else if (active.length > 1) {
      return res.json({
        found: false,
        multiple: true,
        devices: active
          .filter((account) => account.last_mac)
          .map((account) => ({
            id: account.phone,
            mac: maskMac(account.last_mac),
            remainingSeconds: remainingFor(account.phone).remainingSeconds,
          })),
      });
    }
  }

  const info = remainingFor(accountId);
  if (!info || info.remainingSeconds <= 0) {
    return res.json({ found: false });
  }

  // A phone number is not proof of ownership. Balance is fine to show, but
  // the WiFi password goes only to the device the time belongs to, or to the
  // first device that picks up a PayBill payment that has no device yet.
  const account = db.getAccount.get(accountId);
  const onSite = fromLegacySite(req);
  let ownDevice = Boolean(onSite && viewingMac && account && account.last_mac === viewingMac);
  if (!ownDevice && onSite && viewingMac && account && !account.last_mac && !db.accountByMac.get(viewingMac)) {
    db.rememberMac.run({ phone: account.phone, mac: viewingMac });
    ownDevice = true;
  }
  res.json({
    found: true,
    phoneDisplay: mpesa.displayPhone(phone),
    remainingSeconds: info.remainingSeconds,
    expiresAt: info.expiresAt,
    online: info.online,
    ...(ownDevice ? { username: info.phone, password: info.password } : { otherDevice: true }),
  });
});

/** Check before taking more money: a payer may already own usable time. */
app.post('/api/subscriptions/check', (req, res) => {
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid M-Pesa number.' });
  const subscriptions = db.activeAccountsForPayer.all(phone)
    .map((account) => ({
      username: account.phone,
      mac: maskMac(account.last_mac),
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

// Managing TVs needs the paying device itself: the portal's MAC must be
// bound to an account paid for by this number. A phone number alone is not
// proof of ownership.
function deviceOwner(phone, ownerMac, req) {
  const mac = cleanMac(ownerMac);
  if (!mac || (req && !fromLegacySite(req))) return null;
  const account = db.accountByMac.get(mac);
  return account && (account.payer_phone || account.phone) === phone ? account.phone : null;
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

  const owner = deviceOwner(phone, req.body && req.body.ownerMac, req);
  if (!owner) {
    return res.status(409).json({
      error: 'Open this page on the phone that paid, while it is connected to this WiFi.',
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

  const owner = deviceOwner(phone, req.body && req.body.ownerMac, req);
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
  const owner = deviceOwner(phone, req.body && req.body.ownerMac, req);
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
  const expected = Buffer.from(String(process.env.ADMIN_TOKEN || ''));
  const supplied = Buffer.from(String(req.headers['x-admin-token'] || ''));
  if (!expected.length || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
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
 *
 * Safaricom does not sign callbacks, so a confirmation is only acted on when
 * it arrives on the secret URL (/api/c2b/site/<MPESA_C2B_CALLBACK_TOKEN>/…),
 * or on the original URL from one of Safaricom's callback addresses.
 */
function handleSiteC2bConfirmation(req) {
  setImmediate(async () => {
    try {
      const b = req.body || {};
      const phone = mpesa.normalizePhone(b.BillRefNumber || b.MSISDN);
      const amount = Math.round(Number(b.TransAmount));
      const receipt = String(b.TransID || '').trim().toUpperCase();
      const shortcode = String(b.BusinessShortCode || b.ShortCode || '').trim();
      if (!receipt || (config.mpesa.shortcode && shortcode !== String(config.mpesa.shortcode))) {
        console.warn('[c2b] callback without a receipt or for another shortcode ignored');
        return;
      }

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
}

function siteC2bTokenOk(token) {
  const expected = Buffer.from(String(config.mpesa.c2bCallbackToken || ''));
  const supplied = Buffer.from(String(token || ''));
  return expected.length >= 16 && supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}
function ackC2b(res) { res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' }); }
function untrustedCallback(label, req) {
  console.warn(`[${label}] ignored callback from untrusted address ${req.ip}`);
}

app.post('/api/c2b/site/:token/confirm', (req, res) => {
  if (!siteC2bTokenOk(req.params.token)) return res.status(404).json({ error: 'Not found' });
  ackC2b(res);
  handleSiteC2bConfirmation(req);
});
app.post('/api/c2b/site/:token/validate', (req, res) => {
  if (!siteC2bTokenOk(req.params.token)) return res.status(404).json({ error: 'Not found' });
  ackC2b(res);
});

app.post('/api/mpesa/c2b/confirmation', (req, res) => {
  ackC2b(res);
  if (!mpesaCallbackGuard.fromSafaricom(req)) return untrustedCallback('c2b', req);
  handleSiteC2bConfirmation(req);
});

app.post('/api/mpesa/c2b/validation', (req, res) => {
  ackC2b(res);
});

/* Tenant C2B callbacks. Safaricom requires an immediate response, so the
 * package lookup and provisioning run after acknowledgement. The secret path
 * token identifies the tenant; the original shortcode-only URLs are honoured
 * only from Safaricom's callback addresses while tenants re-register. */
function handleTenantC2bConfirmation(req, setting) {
  setImmediate(async () => {
    try {
      const body = req.body || {};
      const receipt = String(body.TransID || '').trim().toUpperCase();
      const shortcode = String(body.BusinessShortCode || body.ShortCode || '').trim();
      // The token decides the tenant; the body must name the same shortcode.
      if (!setting || !receipt || shortcode !== String(setting.shortcode)) return;
      if (tenant.duplicateReceipt.get(receipt, '') || db.isDuplicateReceipt(receipt, '')) return;

      const rawReference = String(body.BillRefNumber || '').trim();
      const reference = setting.account_prefix && rawReference.startsWith(setting.account_prefix)
        ? rawReference.slice(setting.account_prefix.length) : rawReference;
      // A PPPoE subscriber pays with their username as the account number.
      const pppoeUser = reference ? pppoeBilling.userByUsername(setting.business_id, reference) : null;
      if (pppoeUser) { recordPppoePayBill({ setting, body, receipt, user: pppoeUser }); return; }
      const phone = mpesa.normalizePhone(reference) || mpesa.normalizePhone(body.MSISDN);
      const amount = Math.round(Number(body.TransAmount));
      if (!phone || !Number.isFinite(amount) || amount <= 0) {
        console.warn(`[tenant c2b] unmatched payment ${receipt}: invalid account or amount`);
        return;
      }
      const packages = tenant.packagesForLocation.all(setting.location_id)
        .filter(pkg => Number(pkg.price) <= amount).sort((a, b) => Number(b.price) - Number(a.price));
      const pkg = packages[0];
      if (!pkg) { console.warn(`[tenant c2b] ${receipt}: amount below package minimum`); return; }
      const checkoutRequestId = `c2b_${receipt}`.replace(/[^A-Za-z0-9_.=-]/g, '').slice(0, 64);
      const existing = tenant.getTransaction.get(checkoutRequestId);
      if (existing) return;
      tenant.insertTransaction.run({
        checkoutRequestId, merchantRequestId: `C2B-${receipt}`.slice(0, 64),
        businessId: setting.business_id, locationId: setting.location_id,
        phone, packageId: pkg.id, packageName: pkg.name, amount: Number(pkg.price),
        seconds: Number(pkg.seconds), rateLimit: pkg.rate_limit || null,
        // No device yet: the customer binds it from the portal with the
        // paying number and this receipt (payment-recover).
        mac: `C2B:${receipt}`.slice(0, 64), ip: null,
      });
      tenant.setTransactionTerms.run({ checkoutRequestId, paymentSource: 'c2b', platformFee: 0 });
      tenant.setTransactionResult.run({ checkoutRequestId, status: 'paid', resultCode: 0,
        resultDesc: 'C2B payment confirmed', receipt });
      provisionTenantPayment(checkoutRequestId);
      console.log(`[tenant c2b] ${receipt} matched ${phone} at ${setting.location_id}`);
    } catch (error) {
      console.error('[tenant c2b] handler failed:', error.message);
    }
  });
}

function recordPppoePayBill({ setting, body, receipt, user }) {
  const amount = Math.round(Number(body.TransAmount));
  if (!Number.isFinite(amount) || amount <= 0) { console.warn(`[tenant c2b] ${receipt}: invalid PPPoE amount`); return; }
  const checkoutRequestId = `c2b_${receipt}`.replace(/[^A-Za-z0-9_.=-]/g, '').slice(0, 64);
  if (tenant.getTransaction.get(checkoutRequestId)) return;
  const locationId = user.location_id && tenant.locationById.get(user.location_id) ? user.location_id : setting.location_id;
  tenant.insertTransaction.run({
    checkoutRequestId, merchantRequestId: `C2B-${receipt}`.slice(0, 64),
    businessId: setting.business_id, locationId,
    phone: mpesa.normalizePhone(body.MSISDN) || '', packageId: 0, packageName: `PPPoE ${user.username}`.slice(0, 80),
    amount, seconds: 0, rateLimit: null, mac: pppoeBilling.transactionMac(user), ip: null,
  });
  tenant.setTransactionTerms.run({ checkoutRequestId, paymentSource: 'c2b', platformFee: 0 });
  tenant.setTransactionResult.run({ checkoutRequestId, status: 'paid', resultCode: 0, resultDesc: 'C2B payment confirmed', receipt });
  provisionTenantPayment(checkoutRequestId);
  console.log(`[tenant c2b] ${receipt} paid PPPoE account ${user.username}`);
}

// Safaricom may notify us later that a previously accepted C2B payment was
// reversed. Reversals never grant a second package and immediately queue the
// router revoke job for any subscription created from that receipt.
function handleTenantC2bReversal(req, setting) {
  if (!setting) return;
  setImmediate(() => {
    try {
      const body = req.body || {};
      const receipt = String(body.OriginalTransactionID || body.OriginalReceipt || body.TransID || '').trim().toUpperCase();
      if (!receipt) return;
      // Only a receipt this tenant's own shortcode was paid with can be reversed.
      const transaction = db.db.prepare('SELECT * FROM tenant_transactions WHERE mpesa_receipt=? AND business_id=? AND payment_source=\'c2b\' AND status=\'paid\' LIMIT 1').get(receipt, setting.business_id);
      if (!transaction) return;
      db.db.prepare("UPDATE tenant_transactions SET status='reversed', result_desc='C2B payment reversed', updated_at=datetime('now') WHERE checkout_request_id=? AND status='paid'").run(transaction.checkout_request_id);
      if (pppoeBilling.userIdFromTransaction(transaction)) {
        pppoeBilling.reverseByReceipt(setting.business_id, receipt);
        console.log(`[tenant c2b] reversed PPPoE payment ${receipt}`);
        return;
      }
      if (transaction.subscription_id) {
        const subscription = tenant.subscriptionById.get(transaction.subscription_id, transaction.location_id);
        if (subscription) {
          db.db.prepare("UPDATE tenant_subscriptions SET expires_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND location_id=?").run(subscription.id, subscription.location_id);
          tenant.insertJob.run({ locationId: subscription.location_id, username: subscription.router_username, password: subscription.password || '2222', profile: 'standard', totalSeconds: 1, rateLimit: subscription.rate_limit || null, mac: subscription.mac, ip: null, action: 'revoke' });
        }
      }
      console.log(`[tenant c2b] reversed ${receipt}`);
    } catch (error) { console.error('[tenant c2b] reversal failed:', error.message); }
  });
}

function tenantC2bValidation(setting, req) {
  const shortcode = String(req.body?.BusinessShortCode || req.body?.ShortCode || '').trim();
  if (!setting || shortcode !== String(setting.shortcode)) return { ResultCode: 1, ResultDesc: 'Rejected' };
  // A PPPoE payment is turned back (money never leaves the customer) while
  // the owner's own PPPoE plan has lapsed and they could not be reconnected.
  // This needs Safaricom's validation switched on for the PayBill; without it
  // the payment is kept as credit instead (pppoe-billing).
  const rawReference = String(req.body?.BillRefNumber || '').trim();
  const reference = setting.account_prefix && rawReference.startsWith(setting.account_prefix)
    ? rawReference.slice(setting.account_prefix.length) : rawReference;
  const pppoeUser = reference ? pppoeBilling.userByUsername(setting.business_id, reference) : null;
  if (pppoeUser && !pppoeBilling.ownerCanServe(db.businessById.get(setting.business_id))) return { ResultCode: 'C2B00016', ResultDesc: 'Rejected' };
  return { ResultCode: 0, ResultDesc: 'Accepted' };
}

app.post('/api/c2b/t/:token/validate', (req, res) => {
  res.status(200).json(tenantC2bValidation(paymentIntegrations.c2bSettingForToken(req.params.token), req));
});
app.post('/api/c2b/t/:token/confirm', (req, res) => {
  const setting = paymentIntegrations.c2bSettingForToken(req.params.token);
  if (!setting) return res.status(404).json({ error: 'Not found' });
  ackC2b(res);
  handleTenantC2bConfirmation(req, setting);
});
app.post('/api/c2b/t/:token/reversal', (req, res) => {
  const setting = paymentIntegrations.c2bSettingForToken(req.params.token);
  if (!setting) return res.status(404).json({ error: 'Not found' });
  ackC2b(res);
  handleTenantC2bReversal(req, setting);
});

function legacyTenantSetting(req) {
  const shortcode = String(req.body?.BusinessShortCode || req.body?.ShortCode || '').trim();
  return paymentIntegrations.c2bSettingForShortcode(shortcode);
}
app.post('/api/mpesa/c2b/tenant/validation', (req, res) => {
  if (!mpesaCallbackGuard.fromSafaricom(req)) return res.status(200).json({ ResultCode: 1, ResultDesc: 'Rejected' });
  res.status(200).json(tenantC2bValidation(legacyTenantSetting(req), req));
});
app.post('/api/mpesa/c2b/tenant/confirmation', (req, res) => {
  ackC2b(res);
  if (!mpesaCallbackGuard.fromSafaricom(req)) return untrustedCallback('tenant c2b', req);
  handleTenantC2bConfirmation(req, legacyTenantSetting(req));
});
app.post('/api/mpesa/c2b/tenant/reversal', (req, res) => {
  ackC2b(res);
  if (!mpesaCallbackGuard.fromSafaricom(req)) return untrustedCallback('tenant c2b', req);
  // A reversal names the original receipt, not always the shortcode; scope it
  // to the receipt's own tenant.
  const receipt = String(req.body?.OriginalTransactionID || req.body?.OriginalReceipt || req.body?.TransID || '').trim().toUpperCase();
  const row = receipt && db.db.prepare("SELECT business_id FROM tenant_transactions WHERE mpesa_receipt=? AND payment_source='c2b' LIMIT 1").get(receipt);
  const setting = row && db.db.prepare('SELECT * FROM business_c2b_settings WHERE business_id=? AND active=1').get(row.business_id);
  handleTenantC2bReversal(req, setting);
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
  const admin = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
  const supplied = String(req.headers['x-admin-password'] || req.headers['x-admin-token'] || '');
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

const { buildScript, buildExpiryScript, buildRemoteSupportScript, buildMappedDeploymentScript } = require('./lib/rsc');

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
  legacySiteSeen = { ip: String(req.ip || ''), at: Date.now() };
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

/**
 * The one-line bootstrap has a location id in its URL so RouterOS knows
 * which kit to fetch. Its pairing credential must remain in the request
 * header: accepting a `token=` query parameter here would put a reusable
 * router credential in browser, proxy, and RouterOS fetch logs.
 */
function tenantRouterForHeaderRequest(req, res) {
  const site = String(req.query.site || '');
  const header = req.get('X-WiFi-Fiti-Router');
  if (!site.startsWith('loc-') || !header) {
    res.status(403).type('text/plain').send('# forbidden\n');
    return null;
  }
  const location = tenant.authenticateRouter(site, header, 'header');
  if (!location) {
    res.status(403).type('text/plain').send('# forbidden\n');
    return null;
  }
  return location;
}

/**
 * A location-specific fetch/import convenience for a still-unverified
 * router. The browser has already received the transparent full fallback;
 * this route returns that exact server-generated kit only after header
 * authentication. The encrypted-at-rest copy is removed on verification.
 */
app.get('/api/router/v1/bootstrap', (req, res) => {
  const location = tenantRouterForHeaderRequest(req, res);
  if (!location) return;
  try {
    let script = tenant.routerSetupScriptFor(location);
    // A narrow compatibility fallback keeps older, unverified
    // existing-Hotspot kits usable after deployment. It cannot configure a
    // reset/automatic router and is deliberately unavailable after pairing.
    if (!script && location.router_pairing_auth !== 'pending' && !location.router_setup_verified_at) {
      script = buildExistingRouterBootstrap({
        location,
        token: req.get('X-WiFi-Fiti-Router'),
        appUrl: config.domains.appUrl,
        portalUrl: portalUrlForLocation(location),
      });
    }
    if (!script) {
      return res.status(409).type('text/plain').send(
        '# Wi-Fi Fiti bootstrap is unavailable. Generate a fresh connection kit from the dashboard.\n'
      );
    }
    // Keep the normal kit certificate-verified. The explicit compatibility
    // option is only for older RouterOS boards with an empty CA store and does not
    // change the encrypted kit retained at rest.
    if (String(req.query.compat || '') === '1') script = compatibilityRouterKit(script);
    // Test-only replica: add guarded router telemetry without changing the
    // production kit stored for ordinary onboarding. Promotion is deliberate.
    if (String(req.query.telemetry || '') === '1') {
      // The encrypted setup script is the pairing wrapper; it normally pulls
      // the stable installer. Point only this test wrapper at the isolated
      // telemetry endpoint, which transforms the same stable source.
      script = script.replace(/tenant-router-install\.rsc/g, 'tenant-router-install-telemetry-test.rsc');
    }
    // Fourth kit slot: the universal kit (test). It pairs a router in any
    // state without changing its network, so an owner's VLANs, PPPoE and
    // other interfaces keep working; the owner then maps where customers
    // connect. It is only issued while a fresh one-time kit exists.
    if (String(req.query.vlan || '') === '1' || String(req.query.mode || '') === 'universal') {
      script = buildUniversalRouterKit({ location, token: req.get('X-WiFi-Fiti-Router'),
        appUrl: config.domains.appUrl, portalUrl: portalUrlForLocation(location) });
      // Same recovery option as the standard kit, for boards whose RouterOS
      // trust store cannot validate the certificate yet.
      if (String(req.query.compat || '') === '1') {
        script = compatibilityRouterKit(script).replace(/tenant-router-install-universal\.rsc/g, 'tenant-router-install-universal-compat.rsc');
      }
    }
    // Explicit core-router overlay kit. It is never returned by the existing
    // VLAN TEST button: callers must request mode=overlay, provide a bridge
    // trunk, and opt into activation with activate=1.
    if (String(req.query.mode || '') === 'overlay') {
      const requestedBaseId = String(req.query.vlan_id || '').trim();
      const baseId = requestedBaseId === '' ? undefined : Number(requestedBaseId);
      const trunk = String(req.query.trunk || '').trim();
      const accessPorts = String(req.query.access || '').trim();
      const nativePorts = String(req.query.native || '').trim();
      const subnet = String(req.query.subnet || '').trim() || undefined;
      script = vlanOverlayRouterKit(script, { baseId, trunk, accessPorts, nativePorts, subnet, pppoeSubnet: pppoe.pppoeSubnetForLocation(location.id).network, activate: String(req.query.activate || '') === '1' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'X-WiFi-Fiti-Router');
    return res.type('text/plain').send(script);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[router bootstrap] could not render location kit:', error.message);
    return res.status(status).type('text/plain').send(status < 500
      ? `# ${String(error.message).replace(/[\r\n]/g, ' ')}\n`
      : '# Wi-Fi Fiti bootstrap is unavailable. Generate a fresh full connection kit from the dashboard.\n'
    );
  }
});

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
// The router's answer about a network change from the owner's map. "confirmed"
// is the only reply that makes the router keep an applied change.
app.get('/api/router/change', (req, res) => {
  const locationId = String(req.query.site || '');
  const location = tenant.authenticateRouter(locationId, req.get('X-WiFi-Fiti-Router'), 'header');
  if (!location) return res.status(403).type('text/plain').send('forbidden');
  if (location.router_pairing_auth !== 'active' || !location.router_setup_verified_at) return res.status(409).type('text/plain').send('not-paired');
  res.type('text/plain').send(tenant.recordRouterChangeAnswer(location, req.query));
});

// ---- Router tools (dashboard "Tools"): the router's answers -------------
function toolRouter(req, res) {
  const location = tenant.authenticateRouter(String(req.query.site || ''), req.get('X-WiFi-Fiti-Router'), 'header');
  if (!location) { res.status(403).type('text/plain').send('forbidden'); return null; }
  if (location.router_pairing_auth !== 'active' || !location.router_setup_verified_at) { res.status(409).type('text/plain').send('not-paired'); return null; }
  return location;
}
app.post('/api/router/tool', (req, res) => {
  const location = toolRouter(req, res); if (!location) return;
  res.type('text/plain').send(routerTools.recordAnswer(location, req.query.id, typeof req.body === 'string' ? req.body : ''));
});
// The speed test's download: random bytes (never compressible), only for a
// paired router, never cached.
const SPEED_TEST_BYTES = crypto.randomBytes(routerTools.SPEED_BYTES);
app.get('/api/router/speed-test', (req, res) => {
  const location = toolRouter(req, res); if (!location) return;
  if (!routerTools.allowSpeedDownload(location.id)) return res.status(429).type('text/plain').send('no speed test running');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Encoding', 'identity');
  res.type('application/octet-stream').send(SPEED_TEST_BYTES);
});

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

// Provisioning is delivered over the router's outbound poll. Idle routers
// use a five-second heartbeat; a response carrying a queued job or deployment
// temporarily switches that same scheduler to one second so payment access
// is acknowledged quickly. The next empty response restores five seconds.
// This is emitted as an idempotent, ownership-checked command, so existing
// routers adopt the policy without a manual re-import or second installer.
// The poll scheduler's on-event: skip this tick while a sync is still running.
const POLL_GUARD_EVENT = ':if ([:len [/system script job find where script=\\"fiti-poll\\"]] = 0) do={ /system script run fiti-poll }';
function tenantPollTuningScript(intervalSeconds = 5) {
  const interval = intervalSeconds === 1 ? '1s' : '5s';
  return [
    ':local fitiPollSchedulers [/system scheduler find where name="fiti-poll"]',
    ':foreach fitiPollSchedulerId in=$fitiPollSchedulers do={',
    '  :local fitiPollSchedulerComment [/system scheduler get $fitiPollSchedulerId comment]',
    '  :if ([:typeof [:find $fitiPollSchedulerComment "Wi-Fi Fiti: sync usage, ack jobs, collect work"]] != "nil") do={',
    '    :local fitiPollRunCount [/system scheduler get $fitiPollSchedulerId run-count]',
    // Do not rewrite start-date/start-time here. On RouterOS, resetting the
    // start timestamp on every sync can postpone the next run indefinitely;
    // the installer anchors it once to the router's current clock. For an
    // already-installed scheduler that never fired (run-count=0), repair the
    // stale start timestamp exactly once on the next successful sync.
    // Only touch the scheduler when it differs: every "set" is logged, and a
    // set on every 5-second sync flooded the router log.
    `    :if (([/system scheduler get $fitiPollSchedulerId interval] != [:totime "${interval}"]) || ([/system scheduler get $fitiPollSchedulerId disabled] = true)) do={ /system scheduler set $fitiPollSchedulerId interval=${interval} disabled=no }`,
    // One sync at a time. On a slow board (hAP lite) a sync can take longer
    // than the interval; overlapping syncs piled up, held the CPU at 100% and
    // crashed the console. Installed routers get the guard from here.
    `    :if ([:typeof [:find [/system scheduler get $fitiPollSchedulerId on-event] "script job find"]] = "nil") do={ /system scheduler set $fitiPollSchedulerId on-event="${POLL_GUARD_EVENT}" }`,
    '    :if ($fitiPollRunCount = 0) do={',
    '      :local fitiPollStartDate [/system clock get date]',
    '      :local fitiPollStartTime [/system clock get time]',
    '      /system scheduler set $fitiPollSchedulerId start-date=$fitiPollStartDate start-time=$fitiPollStartTime',
    '    }',
    '  }',
    '}',
  ].join('\n') + '\n';
}

function tenantOpenWifiScript(location) {
  const stack = String(location && location.wifi_stack || '').trim();
  const iface = String(location && location.wifi_interface || '').trim();
  if (!/^(?:wireless|wifi)$/.test(stack) || !/^[A-Za-z0-9_-]{1,32}$/.test(iface)) return '';
  if (stack === 'wireless') {
    const command = `/interface wireless security-profiles add name="fiti-wifi-security" mode=none; /interface wireless security-profiles set [find where name="fiti-wifi-security"] mode=none authentication-types="" wpa2-pre-shared-key=""; /interface wireless set [find where name="${iface}"] security-profile="fiti-wifi-security"`;
    return [
      ':do {',
      `  [:parse ${JSON.stringify(command)}]`,
      '} on-error={',
      '  :do { [:parse "/interface wireless security-profiles set [find default=yes] mode=none"] } on-error={}',
      `  :do { [:parse ${JSON.stringify(`/interface wireless set [find where name="${iface}"] security-profile=default`)}] } on-error={}`,
      '}',
    ].join('\n') + '\n';
  }
  const command = `/interface wifi set [find where name="${iface}"] security.authentication-types="" security.passphrase=""`;
  return [
    ':do {',
    `  [:parse ${JSON.stringify(command)}]`,
    '} on-error={}',
  ].join('\n') + '\n';
}

// Universal-kit routers paired with an older layout report get the current
// one in place on their next poll (at most every 10 minutes), so a fix does
// not need a re-pairing. Support-control replies stay narrow and never carry it.
const inventoryUpdateSentAt = new Map();
function tenantRouterScript(location, options = {}) {
  const core = tenantRouterScriptCore(location, options);
  const result = withRouterTool(location, core);
  // A reply that carries a tool carries no network change as well.
  if (result !== core && result.script !== core.script) return result;
  if (location.router_kit !== 'universal' || (result.supportEmitted && result.supportEmitted.length)) return result;
  const extra = [];
  const layout = tenant.routerInventoryForLocation(location.id);
  // A network change from the owner's map, at most one at a time.
  try {
    const change = routerChanges.nextScript(location, {
      wan: layout && layout.wan && layout.wan.interface,
      wans: ((layout && layout.wans) || []).map((w) => w.interface),
      wanList: (layout && layout.wanList) || [],
      cloudHost: publicHostname(),
      portalHost: edgeHostname(location.portal_hostname),
      pppoeNet: (() => { try { return pppoe.pppoeSubnetForLocation(location.id).network; } catch (_) { return null; } })(),
      layout,
    });
    if (change) extra.push(change);
  } catch (error) { console.error('[router changes] could not build a change:', error.message); }
  // A change is the heaviest thing a small router runs, and it sends its own
  // layout report when it finishes, so nothing else rides along with it.
  if (extra.length) return { ...result, script: [result.script, ...extra].filter(Boolean).join('\n') };
  if (layout && (Number(layout.agent) || 1) < INVENTORY_AGENT) {
    const last = inventoryUpdateSentAt.get(location.id) || 0;
    if (Date.now() - last >= 10 * 60_000) { inventoryUpdateSentAt.set(location.id, Date.now()); extra.push(inventoryScriptUpdate()); }
  } else if (layout && inventoryAgeOver(layout.reportedAt, layoutReportEvery(location.id))) {
    // The layout report is run from the poll reply about every 30 seconds.
    // Reports from the router's own 30-second timer never reached the cloud
    // on the RB951 (the timer and the poller do not share the report), while
    // a report run from the reply always does. The old timer is removed.
    const lastAsk = inventoryRefreshAskedAt.get(location.id) || 0;
    if (Date.now() - lastAsk >= Math.min(25_000, layoutReportEvery(location.id))) { inventoryRefreshAskedAt.set(location.id, Date.now()); extra.push(INVENTORY_REFRESH_LINE, INVENTORY_TIMER_REMOVE_LINE); }
  }
  if (!extra.length) return result;
  return { ...result, script: [result.script, ...extra].filter(Boolean).join('\n') };
}
// The layout report is heavy for a small board (a hAP lite at 100% CPU spent
// much of it listing interfaces and pools). It runs every 25 s only while the
// owner has the router open in the dashboard (the page asks every few
// seconds); otherwise every 10 minutes. A change sends its own report.
const layoutViewedAt = new Map();
const LAYOUT_VIEW_WINDOW_MS = 2 * 60_000;
function layoutReportEvery(locationId) {
  return Date.now() - (layoutViewedAt.get(locationId) || 0) < LAYOUT_VIEW_WINDOW_MS ? 25_000 : 10 * 60_000;
}
const portalPendingSince = new Map();
const PORTAL_FAST_MS = 2 * 60_000;
// A tool the owner started rides along with the next ordinary reply.
function withRouterTool(location, result) {
  if (!location.router_setup_verified_at || location.router_pairing_auth === 'pending' || (result.supportEmitted && result.supportEmitted.length)) return result;
  // A network change travels alone (small routers); the tool waits for it.
  if (location.router_kit === 'universal' && routerChanges.hasActiveChange(location.id)) return result;
  let script = '';
  try { script = routerTools.nextToolScript(location); } catch (error) { console.error('[router tools] could not build a tool:', error.message); }
  return script ? { ...result, script: [result.script, script].filter(Boolean).join('\n') } : result;
}
const inventoryRefreshAskedAt = new Map();
const INVENTORY_REFRESH_LINE = ':do { /system script run fiti-inventory } on-error={ :log warning "fiti: layout report failed; it will retry" }';
// The separate 30-second layout timer is no longer used; the poll reply runs
// the report instead. find is silent once it is gone, so nothing is logged.
const INVENTORY_TIMER_REMOVE_LINE = ':do { :local t [/system scheduler find where name="fiti-inventory" and comment~"Wi-Fi Fiti"]; :if ([:len $t] > 0) do={ /system scheduler remove $t } } on-error={}';
function inventoryAgeOver(reportedAt, ageMs) {
  let text = String(reportedAt || '').trim().replace(' ', 'T');
  if (text && !/(?:Z|[+-]\d\d:\d\d)$/i.test(text)) text += 'Z';
  const at = Date.parse(text);
  return !Number.isFinite(at) || Date.now() - at > ageMs;
}

function tenantRouterScriptCore(location, { reportedPortalAppliedHost, reportedPortalHost } = {}) {
  // A candidate replacement must not collect jobs or acknowledge old work
  // before it has completed the receipt challenge. This protects a live
  // router from a partially imported or misdirected replacement kit.
  if (location.router_pairing_auth === 'pending' || !location.router_setup_verified_at) {
    return { script: '', emitted: [], rejected: [], supportEmitted: [], supportRejected: [] };
  }
  tenant.queueExpiredSubscriptions(location.id);
  // A universal-kit router paired before it had a Hotspot is "awaiting map":
  // Hotspot users, the portal page, mapped deployments and PPPoE all wait
  // until the owner maps where customers connect. Nothing is sent that
  // assumes a Hotspot or bridge the router does not have.
  const awaitingMap = location.router_kit === 'universal' && String(location.router_setup_health || '') === 'awaiting-map';
  const jobs = awaitingMap ? [] : tenant.pendingJobs.all(location.id);
  const controls = tenant.pendingRemoteSupportControls.all(location.id);
  // A mapped deployment deliberately waits behind any WireGuard lifecycle
  // work. Both use the existing support-ack global, and remote cleanup or
  // re-enrollment must never race a map-bound service selector update.
  const deployment = controls.length || awaitingMap ? null : tenant.pendingMappedDeploymentForRouter(location);
  const portal = awaitingMap ? '' : routerPortalRefreshScript(location, { reportedPortalAppliedHost, reportedPortalHost });
  // PPPoE provisioning rides the same authenticated outbound poll as hotspot
  // work. This keeps one durable router channel, with the PPPoE module
  // marking jobs delivered only when the script is actually emitted.
  const pppoeScript = awaitingMap ? '' : pppoe.scriptForLocation(location.id);
  // Keep remote-support responses narrowly scoped: the cleanup/activation
  // tests (and, more importantly, operators) must be able to see that a
  // support control cannot touch the customer poller. The tuning command is
  // retried on the next ordinary sync once the control is acknowledged.
  // A network change from the owner's map also polls every second until the
  // router has confirmed it, so each step follows the last within a second.
  const changeInFlight = location.router_kit === 'universal' && routerChanges.hasActiveChange(location.id);
  // A waiting login-page update polls fast for two minutes at most; a router
  // that cannot finish it (or keeps retrying) falls back to the normal pace.
  let portalFast = false;
  if (portal) { const since = portalPendingSince.get(location.id) || Date.now(); portalPendingSince.set(location.id, since); portalFast = Date.now() - since < PORTAL_FAST_MS; }
  else portalPendingSince.delete(location.id);
  // A customer paying right now: be polling every second before the payment
  // lands, so their login is on the router about a second after it is paid.
  const paying = tenant.paymentInProgress(location.id);
  const toolWaiting = routerTools.hasQueuedTool(location.id);
  const fastPoll = Boolean(jobs.length || deployment || portalFast || changeInFlight || paying || toolWaiting);
  const pollTuning = controls.length ? '' : tenantPollTuningScript(fastPoll ? 1 : 5);
  // Opening a Wi-Fi (removing its password) is only for the stable kit, which
  // built that Wi-Fi for customers. A universal-kit router's Wi-Fi may be the
  // owner's private network, so it is never touched here.
  const openWifi = controls.length || location.router_kit === 'universal' ? '' : tenantOpenWifiScript(location);
  if (!jobs.length && !controls.length && !deployment) {
    return { script: [pollTuning, openWifi, portal, pppoeScript].filter(Boolean).join('\n'), emitted: [], rejected: [], supportEmitted: [], supportRejected: [] };
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

  const mapped = buildMappedDeploymentScript({ control: deployment });
  for (const id of mapped.emitted) tenant.markMappedDeploymentDeliveredForRouter({ locationId: location.id, id });
  if (mapped.rejected.length) {
    console.error(`[tenant router] ${location.id} refused malformed mapped deployment(s): ${mapped.rejected.join(', ')}`);
  }
  if (mapped.emitted.length) {
    console.log(`[tenant router] ${location.id} collected mapped deployment(s) ${mapped.emitted.join(', ')}`);
  }

  if (!jobs.length) {
    return { script: [pollTuning, openWifi, portal, support.script, mapped.script, pppoeScript].filter(Boolean).join('\n'), emitted: [], rejected: [], supportEmitted: support.emitted, supportRejected: support.rejected };
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
    script: [pollTuning, openWifi, portal, support.script, mapped.script, script, pppoeScript].filter(Boolean).join('\n'),
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
  // One line per paid login: M-Pesa prompt → paid (job queued) → sent to the
  // router → router confirmed. Shows which step makes a customer wait.
  for (const id of ids) {
    try {
      const t = tenant.jobPaymentTiming(id, location.id);
      if (!t) continue;
      const at = (v) => { const ms = Date.parse(String(v || '').replace(' ', 'T') + 'Z'); return Number.isFinite(ms) ? ms : null; };
      const gap = (a, b) => (a != null && b != null ? `${Math.round((b - a) / 1000)}s` : '?');
      const prompt = at(t.promptAt); const paid = at(t.jobAt); const sent = at(t.deliveredAt); const now = Date.now();
      console.log(`[payment timing] ${location.id} job ${id}: prompt→paid ${gap(prompt, paid)}, paid→sent ${gap(paid, sent)}, sent→confirmed ${gap(sent, now)}, total ${gap(prompt, now)}`);
    } catch (_) { /* timing is informational only */ }
  }
  return ids;
}

function acknowledgeTenantRemoteSupportControls(location, value) {
  const mapped = tenant.acknowledgeMappedDeploymentForRouter({ locationId: location.id, acknowledgement: value });
  if (mapped.handled) {
    if (mapped.acknowledged) console.log(`[tenant router] ${location.id} acknowledged mapped deployment${mapped.idempotent ? ' (repeat)' : ''}`);
    if (mapped.blocked) console.warn(`[tenant router] ${location.id} reported a mapped deployment topology mismatch`);
    return mapped.acknowledged ? [Number(String(value).split('.')[1])] : [];
  }
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
function ingestTenantInventory(location, rawBody) {
  try {
    const inventory = parseRouterInventory(typeof rawBody === 'string' ? rawBody : '');
    return inventory ? tenant.recordRouterInventory(location.id, inventory) : null;
  } catch (_) {
    // Same rule as the topology report: never echo router input; ignore a bad report.
    return null;
  }
}

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

// Telemetry is accepted only from the authenticated, test-kit-marked poll.
// Each value is validated again in tenant storage; any malformed field is
// ignored without affecting pairing, billing, topology or job delivery.
function ingestTenantTelemetry(location, query) {
  if (String(query && query.telemetry || '') !== '1') return null;
  try {
    return tenant.recordRouterTelemetry({
      locationId: location.id,
      cpuPercent: query.cpu,
      freeMemory: query.freeMem,
      totalMemory: query.totalMem,
      uptimeSeconds: query.uptime,
      uptimeText: query.uptimeText,
      rxBytes: query.rx,
      txBytes: query.tx,
      activeUsers: query.activeUsers,
    });
  } catch (_) {
    return null;
  }
}

function ingestTenantDevices(location, query) {
  if (String(query && query.telemetry || '') !== '1') return 0;
  try {
    return tenant.recordRouterDevices({ locationId: location.id, encoded: String(query.devices || '') });
  } catch (_) {
    return 0;
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
    // The universal kit announces itself so its router is paired without a
    // Hotspot and never receives work that assumes one.
    const kit = String(req.query.kit || '') === 'universal' ? 'universal' : null;
    if (kit) { tenant.setRouterKit(location.id, kit); location.router_kit = kit; }
    const receipt = tenant.processRouterSetupReceipt(location, {
      protocol: req.query.protocol,
      ack: req.query.setupAck,
      health: req.query.health,
      kit,
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
    // New kits write the customer portal login page during installation and
    // report the desired host on their first verified sync. Treat that as an
    // applied portal immediately; older kits still receive the queued refresh
    // script below and must report portalApplied after downloading the page.
    const reportedPortalHost = edgeHostname(req.query.portal);
    const desiredPortalHost = edgeHostname(readyLocation.portal_hostname);
    if (!appliedHost && reportedPortalHost && desiredPortalHost && reportedPortalHost === desiredPortalHost && String(req.query.health || '') !== 'portal-missing') {
      readyLocation = tenant.recordRouterPortalApplied(readyLocation.id, reportedPortalHost);
    }
    // Refresh the narrow map snapshot before accepting a map-bound action
    // receipt. A router that changed ports since the action was issued is
    // therefore marked stale instead of being recorded as deployed.
    ingestTenantTopology(readyLocation, req.body);
    ingestTenantInventory(readyLocation, req.body);
    ingestTenantTelemetry(readyLocation, req.query);
    ingestTenantDevices(readyLocation, req.query);
    acknowledgeTenantRouterJobs(readyLocation, req.query.ack);
    acknowledgeTenantRemoteSupportControls(readyLocation, req.query.supportAck);
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
  // Anyone may ask whether the service is up; the details (database counts,
  // provisioning mode, router test) are for the platform admin only.
  if (!adminOk(req)) return res.json({ ok: true });
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

require('./lib/business-operations').attachBusinessOperations(app, { businessAuth, tenant, db, config, adminOk, provisionTenantPayment });
const fitiSignal = require('./lib/fiti-signal');
fitiSignal.attachFitiSignalRoutes(app, { businessAuth, startPayment: async ({ business, purchase, phone: supplied }) => {
  const phone = mpesa.normalizePhone(supplied || business.owner_phone);
  if (!phone) { const error = new Error('Enter the M-Pesa number that should pay for the SMS credits.'); error.status = 400; throw error; }
  const throttleKey = `sms-credits:${business.id}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) { const error = new Error('A payment request is already on its way. Please wait a moment.'); error.status = 429; throw error; }
  if (platformPushesToday(business.id) >= PLATFORM_PUSHES_PER_DAY) { const error = new Error(PLATFORM_PUSH_LIMIT_MESSAGE); error.status = 429; throw error; }
  lastPush.set(throttleKey, Date.now());
  try {
    const pushed = await platformStkPush({ phone, amount: purchase.amount, accountReference: 'WF-SMS', description: 'Wi-Fi Fiti SMS credits' });
    recordPlatformBilling(pushed, { checkoutRequestId: pushed.checkoutRequestId, merchantRequestId: pushed.merchantRequestId,
      businessId: business.id, plan: `sms-${purchase.id}`, phone, amount: purchase.amount, serviceKind: 'sms', pppoeUsers: 0, hotspotConcurrent: 0 });
    return { checkoutRequestId: pushed.checkoutRequestId, phoneDisplay: mpesa.displayPhone(phone) };
  } catch (error) { lastPush.delete(throttleKey); throw error; }
} });
// Start the notification worker only when a provider key is configured. This
// keeps local/test deployments inert while allowing Railway to deliver queued
// transactional SMS automatically in sandbox or production.
const smsProvider = fitiSignal.createAfricaTalkingProviderFromEnv();
// Sales demo: lead form, live pay-and-connect demo and their admin views.
const demo = createDemo({
  db: db.db, adminOk, tuma, publicUrl: config.publicUrl, smsProvider, sendEmail, whatsapp,
});
demo.attachRoutes(app);
// Prepaid subscription reminders: 3 days before expiry, grace, and stop.
const serviceReminders = require('./lib/service-reminders').createServiceReminders({ db: db.db, smsProvider, sendEmail, tumaFee, capacityUsage: serviceUsage });
const runServiceReminders = () => serviceReminders.run().catch((err) => console.error('[billing reminders]', err.message));
setTimeout(runServiceReminders, 60_000).unref();
setInterval(runServiceReminders, 60 * 60_000).unref();
if (smsProvider) {
  const smsWorker = () => fitiSignal.processQueue(smsProvider, { limit: 50 })
    .catch((error) => console.error('[fiti-signal] provider worker failed:', error.message));
  smsWorker();
  const smsWorkerTimer = setInterval(smsWorker, 5000);
  smsWorkerTimer.unref?.();
  console.log(`FitiSignal provider: Africa's Talking (${smsProvider.environment})`);
} else {
  console.log('FitiSignal provider: not configured (messages remain queued).');
}
// WhatsApp delivery is independent of SMS and payment provisioning. The
// worker stays inert until Meta credentials and an approved template exist.
const whatsappWorker = () => whatsappNotifications.processQueue({ limit: 50 })
  .catch((error) => console.error('[whatsapp] provider worker failed:', error.message));
whatsappWorker();
const whatsappWorkerTimer = setInterval(whatsappWorker, 5000);
whatsappWorkerTimer.unref?.();
require('./lib/pppoe').attachPppoeRoutes(app, { businessAuth, subscriptionBlock: (business, usage) => {
  if (trialLimited(business) && usage.adding && usage.activeUsers >= TRIAL_LIMITS.maxPppoeUsers) {
    return { message: `Your free trial includes up to ${TRIAL_LIMITS.maxPppoeUsers} PPPoE users. ${TRIAL_LIMIT_NOTE}`, needs: { action: 'subscribe', service: 'pppoe', reason: 'trial_limit' } };
  }
  const block = serviceBilling.pppoeAddBlockDetail(business, usage);
  if (!block) return null;
  return { message: block.message, needs: block.reason ? { action: 'subscribe', service: 'pppoe', reason: block.reason } : null };
}, userExtras: {
  // Phone, name and installation fee are checked before the subscriber exists.
  check(body) {
    const raw = String(body.phone || '').trim();
    const phone = raw ? mpesa.normalizePhone(raw) : null;
    if (raw && !phone) throw Object.assign(new Error('Enter a valid Kenyan phone number for the subscriber, or leave it blank.'), { status: 400 });
    const installFee = Number(body.installFee || 0);
    if (!Number.isInteger(installFee) || installFee < 0 || installFee > 1_000_000) throw Object.assign(new Error('The installation fee must be a whole number of shillings.'), { status: 400 });
    return { phone, fullName: body.fullName, installFee };
  },
  apply(user, checked) {
    const { secret_ciphertext: _hidden, ...safe } = pppoeBilling.setupNewSubscriber(user, checked);
    return safe;
  },
} });

/* ------------------------------------------------------------------ */
/* PPPoE customer payments                                             */
/* ------------------------------------------------------------------ */

// The pay page: a subscriber's own link (with its private k), or the
// business's page where anyone types an account number.
app.get(['/pay/:code', '/pay/:code/:username'], (req, res) => {
  if (!pppoeBilling.businessForPayCode(req.params.code)) return res.status(404).type('text/plain').send('This pay page was not found.');
  res.set('Cache-Control', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(publicDirectory, 'pppoe-pay.html'));
});

function pppoePayContext(req, res) {
  const business = pppoeBilling.businessForPayCode(req.params.code);
  if (!business) { res.status(404).json({ error: 'This pay page was not found.' }); return null; }
  const settings = pppoeBilling.settingsFor(business.id);
  return { business, settings };
}
function pppoePayBill(businessId) {
  const row = db.db.prepare('SELECT shortcode, account_prefix FROM business_c2b_settings WHERE business_id=? AND active=1').get(businessId);
  return row ? { shortcode: row.shortcode, accountPrefix: row.account_prefix || '' } : null;
}
/** Why customers of this business cannot pay online right now, or null. */
function pppoePayBlock(business) {
  const name = business.portal_name || business.name || 'Your provider';
  if (!pppoeBilling.ownerCanServe(business)) return { code: 'provider_paused', error: `${name} can't take payments right now. Nothing has been charged. Please call ${name} to renew your internet.` };
  const sales = tumaFee.salesBlock(business.id);
  if (sales) return { code: 'provider_paused', error: sales };
  if (ownerPhoneBlock(business)) return { code: 'provider_paused', error: `${name} is not taking payments yet. Please ask them.` };
  return null;
}
/** The account asked for, and whether the request carries its private link. */
function pppoeAccountFor(ctx, req, res) {
  const user = pppoeBilling.userByUsername(ctx.business.id, String(req.params.username || '').slice(0, 96));
  if (!user) { res.status(404).json({ error: `No account called ${String(req.params.username || '').slice(0, 40)} here. Check the spelling with whoever gave it to you.` }); return null; }
  const supplied = req.query.k || (req.body && req.body.k) || req.get('X-WiFi-Fiti-Account');
  return { user, owner: Boolean(supplied) && pppoeBilling.accountTokenOk(user, supplied) };
}

app.get('/api/pppoe-pay/:code', (req, res) => {
  const ctx = pppoePayContext(req, res); if (!ctx) return;
  const block = pppoePayBlock(ctx.business);
  res.json({
    business: { ...pppoeBilling.businessView(ctx.business), logoUrl: brandingPayload(ctx.business).logoUrl || null },
    payBill: pppoePayBill(ctx.business.id),
    features: { payForOthers: ctx.settings.payForOthers, changePlan: ctx.settings.selfChangePlan, boosts: ctx.settings.boosts },
    paused: block ? block.error : null,
  });
});

app.get('/api/pppoe-pay/:code/account/:username', (req, res) => {
  const ctx = pppoePayContext(req, res); if (!ctx) return;
  const found = pppoeAccountFor(ctx, req, res); if (!found) return;
  if (found.owner) return res.json({ private: true, account: pppoeBilling.privateAccount(found.user), token: pppoeBilling.accountToken(found.user) });
  // Anyone may pay an account by its number (unless the owner turned that
  // off); they see only the plan, the amount due and a masked name.
  if (!ctx.settings.payForOthers) return res.json({ private: false, needsPhone: true, account: { username: found.user.username } });
  res.json({ private: false, account: pppoeBilling.publicAccount(found.user) });
});

// The phone number on the account opens its private view (receipts, plan changes).
app.post('/api/pppoe-pay/:code/account/:username/verify', (req, res) => {
  const ctx = pppoePayContext(req, res); if (!ctx) return;
  const found = pppoeAccountFor(ctx, req, res); if (!found) return;
  const phone = mpesa.normalizePhone(req.body && req.body.phone);
  if (!phone || !found.user.phone || phone !== found.user.phone) return res.status(403).json({ error: 'That is not the phone number on this account.' });
  res.json({ private: true, token: pppoeBilling.accountToken(found.user), account: pppoeBilling.privateAccount(found.user) });
});

app.post('/api/pppoe-pay/:code/account/:username/quote', (req, res) => {
  const ctx = pppoePayContext(req, res); if (!ctx) return;
  const found = pppoeAccountFor(ctx, req, res); if (!found) return;
  if (!found.owner) return res.status(403).json({ error: 'Open this from your own pay link to change plan or boost.' });
  try {
    const body = req.body || {};
    if (body.purpose === 'boost') return res.json({ quote: pppoeBilling.boostQuote(found.user, body.profileId) });
    res.json({ quote: pppoeBilling.changeQuote(found.user, body.profileId, { timing: body.timing === 'renewal' ? 'renewal' : 'now', useCredit: body.useCredit !== false }) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.post('/api/pppoe-pay/:code/account/:username/pay', async (req, res) => {
  const ctx = pppoePayContext(req, res); if (!ctx) return;
  const found = pppoeAccountFor(ctx, req, res); if (!found) return;
  const { business, settings } = ctx; const user = found.user;
  const body = req.body || {};
  const purpose = ['pay', 'upgrade', 'boost'].includes(body.purpose) ? body.purpose : 'pay';
  if (!found.owner && !settings.payForOthers) return res.status(403).json({ error: 'Open your own pay link, or enter the phone number on this account first.' });
  const block = pppoePayBlock(business);
  if (block) return res.status(402).json(block);
  const state = pppoeBilling.accountState(user);
  if (!state.billed) return res.status(409).json({ error: 'This account is not set up for online payments. Please ask your provider.' });
  let amount; let targetProfileId = null; let fromCredit = 0;
  try {
    if (purpose === 'pay') {
      amount = body.amount === undefined || body.amount === null || body.amount === '' ? state.amountDue : Number(body.amount);
      const most = Math.max(state.price * 12 + state.installDue, 1);
      if (!Number.isInteger(amount) || amount < 1 || amount > most) return res.status(400).json({ error: `Enter an amount from KES 1 to KES ${most.toLocaleString('en-KE')}.` });
    } else {
      if (!found.owner) return res.status(403).json({ error: 'Open this from your own pay link to change plan or boost.' });
      if (purpose === 'upgrade') {
        if (!settings.selfChangePlan) return res.status(403).json({ error: 'Please ask your provider to change your plan.' });
        const timing = body.timing === 'renewal' ? 'renewal' : 'now';
        const quote = pppoeBilling.changeQuote(user, body.profileId, { timing, useCredit: body.useCredit !== false });
        if (timing === 'renewal') {
          const updated = pppoeBilling.scheduleChange(user, quote.target.id);
          return res.json({ scheduled: true, account: pppoeBilling.privateAccount(updated) });
        }
        if (!quote.payNow) {
          // Covered by credit: nothing to pay, the plan moves now.
          const result = pppoeBilling.applyPayment({ userId: user.id, amount: 0, method: 'credit', purpose: 'upgrade', targetProfileId: quote.target.id,
            expected: 0, fromCredit: quote.fromCredit, note: 'Upgrade paid from credit' });
          return res.json({ applied: true, account: pppoeBilling.privateAccount(result.user) });
        }
        amount = quote.payNow; targetProfileId = quote.target.id; fromCredit = quote.fromCredit;
      } else {
        if (!settings.boosts) return res.status(403).json({ error: 'Speed boosts are not offered here.' });
        const quote = pppoeBilling.boostQuote(user, body.profileId);
        amount = quote.amount; targetProfileId = quote.target.id;
      }
    }
  } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  const phone = mpesa.normalizePhone(body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid M-Pesa number, e.g. 0712 345 678.' });
  if (trialLimited(business) && amount > TRIAL_LIMITS.maxPackagePriceKes) {
    return res.status(402).json({ code: 'trial_limit', error: 'Online payments above KES 3 open once your provider finishes their Wi-Fi Fiti trial. Please pay them directly for now.' });
  }
  const locationId = user.location_id || (db.db.prepare('SELECT id FROM locations WHERE business_id=? ORDER BY rowid LIMIT 1').get(business.id) || {}).id;
  const location = locationId && tenant.locationById.get(locationId);
  if (!location) return res.status(409).json({ error: 'This provider has not finished setting up yet.' });
  if (tenant.pendingPaymentForPhone.get(location.id, phone)) return res.status(429).json({ error: 'A payment request is already on its way to this number. Please check the phone first.' });
  const throttleKey = `${location.id}:${phone}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) return res.status(429).json({ error: 'A payment request is already on its way. Please wait a moment.' });
  if (trialLimited(business) && !tenantAccess.allowed(`trial-prompts:${business.id}`, TRIAL_PROMPTS_PER_DAY, 86400_000).allowed) {
    return res.status(429).json({ error: 'This provider has reached its payment limit for today. Please try again tomorrow.' });
  }
  try {
    lastPush.set(throttleKey, Date.now());
    const label = purpose === 'boost' ? 'Speed boost' : purpose === 'upgrade' ? 'Plan upgrade' : 'Internet';
    const { pushed, paymentSource, platformFee } = await pushTenantPrompt(location, {
      phone, amount, description: `${label} ${user.username}`.slice(0, 40), accountReference: user.username.slice(0, 12) });
    tenant.insertTransaction.run({ checkoutRequestId: pushed.checkoutRequestId, merchantRequestId: pushed.merchantRequestId,
      businessId: business.id, locationId: location.id, phone, packageId: 0,
      packageName: `PPPoE ${label.toLowerCase()} · ${user.username}`.slice(0, 80), amount, seconds: 0, rateLimit: null,
      mac: pppoeBilling.transactionMac(user), ip: null });
    tenant.setTransactionTerms.run({ checkoutRequestId: pushed.checkoutRequestId, paymentSource, platformFee });
    const statusToken = pppoeBilling.recordIntent({ checkoutRequestId: pushed.checkoutRequestId, user, purpose, targetProfileId, amount,
      fromCredit, payerPhone: phone, notifyHolder: body.notify !== false });
    res.json({ checkoutRequestId: pushed.checkoutRequestId, statusToken, amount, phoneDisplay: mpesa.displayPhone(phone) });
  } catch (err) {
    lastPush.delete(throttleKey);
    if (err.promptStatus) return res.status(err.promptStatus).json({ error: err.message });
    console.error('[pppoe pay] STK push failed:', err.message);
    res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});

app.get('/api/pppoe-pay/:code/status/:checkoutRequestId', async (req, res) => {
  const ctx = pppoePayContext(req, res); if (!ctx) return;
  const intent = pppoeBilling.intentFor.get(String(req.params.checkoutRequestId || ''));
  if (!intent || intent.business_id !== ctx.business.id || !pppoeBilling.intentTokenOk(intent, req.get('X-WiFi-Fiti-Portal'))) {
    return res.status(404).json({ error: 'Payment not found.' });
  }
  let tx = tenant.getTransaction.get(intent.checkout_request_id);
  if (!tx) return res.status(404).json({ error: 'Payment not found.' });
  if (tx.status === 'pending') tx = await queryTenantNow(tx);
  if (tx.status === 'paid') {
    try { tx = provisionTenantPayment(tx.checkout_request_id); }
    catch (err) { console.error(`[pppoe status] ${tx.checkout_request_id}:`, err.message); return res.json({ status: 'pending' }); }
    const payment = db.db.prepare('SELECT * FROM pppoe_payments WHERE checkout_request_id=?').get(tx.checkout_request_id);
    const user = db.db.prepare('SELECT * FROM pppoe_users WHERE id=?').get(intent.user_id);
    return res.json({ status: 'paid', receipt: payment ? pppoeBilling.receiptView(payment) : null, account: user ? pppoeBilling.publicAccount(user) : null });
  }
  res.json({ status: tx.status, reason: tx.status === 'failed' ? friendlyFailure(tx.result_code, tx.result_desc) : null });
});

/* ---- Owner side ---------------------------------------------------- */

function pppoeOwnerRoute(handler) {
  return (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    try { return handler(req, res, business); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  };
}
app.get('/api/business/pppoe/billing', pppoeOwnerRoute((req, res, business) => {
  const settings = pppoeBilling.settingsFor(business.id);
  const users = db.db.prepare('SELECT * FROM pppoe_users WHERE business_id=? ORDER BY username').all(business.id);
  res.json({
    settings, payPage: pppoeBilling.payPageUrl(business.id), payBill: pppoePayBill(business.id),
    serving: pppoeBilling.ownerCanServe(db.businessById.get(business.id)),
    subscribers: Object.fromEntries(users.map((u) => [u.id, pppoeBilling.ownerView(u, { settings })])),
    payments: pppoeBilling.paymentsForOwner(business.id, { limit: 50 }),
  });
}));
app.put('/api/business/pppoe/billing/settings', pppoeOwnerRoute((req, res, business) => {
  res.json({ settings: pppoeBilling.saveSettings(business.id, req.body || {}) });
}));
app.patch('/api/business/pppoe/profiles/:profileId', pppoeOwnerRoute((req, res, business) => {
  res.json({ profile: pppoeBilling.updatePlan(business.id, req.params.profileId, req.body || {}) });
}));
app.patch('/api/business/pppoe/users/:userId', pppoeOwnerRoute((req, res, business) => {
  const user = pppoeBilling.updateSubscriber(business.id, req.params.userId, req.body || {});
  res.json({ subscriber: pppoeBilling.ownerView(user, { settings: pppoeBilling.settingsFor(business.id) }) });
}));
// Cash, money sent to the owner's own number, or a bank transfer.
app.post('/api/business/pppoe/users/:userId/payments', pppoeOwnerRoute((req, res, business) => {
  const user = pppoeBilling.userFor(business.id, req.params.userId);
  const body = req.body || {};
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) return res.status(400).json({ error: 'Enter the amount received in whole shillings.' });
  const method = ['cash', 'mpesa_owner', 'bank'].includes(body.method) ? body.method : 'cash';
  const receipt = String(body.receipt || '').trim().toUpperCase().slice(0, 40) || null;
  if (receipt && tenant.duplicateReceipt.get(receipt, '')) return res.status(409).json({ error: `Receipt ${receipt} already came in automatically.` });
  const result = pppoeBilling.applyPayment({ userId: user.id, amount, method, receipt, note: body.note, recordedBy: business.owner_name || 'Owner' });
  notifyPppoePayment(result);
  res.status(201).json({ held: result.held, days: result.days, payment: pppoeBilling.receiptView(result.payment),
    subscriber: pppoeBilling.ownerView(result.user, { settings: pppoeBilling.settingsFor(business.id) }) });
}));
app.post('/api/business/pppoe/users/:userId/extend', pppoeOwnerRoute((req, res, business) => {
  const user = pppoeBilling.userFor(business.id, req.params.userId);
  const result = pppoeBilling.applyPayment({ userId: user.id, amount: 0, method: 'owner', purpose: 'extension', extensionDays: req.body && req.body.days,
    note: req.body && req.body.note, recordedBy: business.owner_name || 'Owner' });
  res.status(201).json({ subscriber: pppoeBilling.ownerView(result.user, { settings: pppoeBilling.settingsFor(business.id) }) });
}));
app.post('/api/business/pppoe/users/:userId/send-link', pppoeOwnerRoute((req, res, business) => {
  const user = pppoeBilling.userFor(business.id, req.params.userId);
  if (!user.phone) return res.status(400).json({ error: 'Add the subscriber\'s phone number first.' });
  const state = pppoeBilling.accountState(user);
  const name = business.portal_name || business.name || '';
  const text = `${name}: pay for your internet (${user.username})${state.amountDue ? `, ${`KES ${state.amountDue.toLocaleString('en-KE')}`} due` : ''}: ${pppoeBilling.payLink(user)}`;
  const queued = fitiSignal.enqueue({ businessId: business.id, eventId: `pppoe-link:${user.id}:${Date.now()}`, serviceKey: 'receipt_link', to: `+${user.phone}`, message: text });
  if (queued && queued.skipped) return res.status(402).json({ error: queued.reason === 'insufficient-credits' ? 'Buy SMS credits to send the link, or copy it instead.' : 'The SMS was not sent (your SMS limits). Copy the link instead.' });
  res.json({ sent: true });
}));
app.get('/api/business/pppoe/payments', pppoeOwnerRoute((req, res, business) => {
  res.json({ payments: pppoeBilling.paymentsForOwner(business.id, { userId: req.query.userId ? String(req.query.userId) : null, limit: 200 }) });
}));

// Boost ends, credit renewals and customer reminders.
const runPppoeBilling = () => pppoeBilling.sweep({ send: async (businessId, eventId, to, message, serviceKey) =>
  fitiSignal.enqueue({ businessId, eventId, serviceKey, to, message }) }).catch((err) => console.error('[pppoe billing]', err.message));
setTimeout(runPppoeBilling, 90_000).unref();
setInterval(runPppoeBilling, 10 * 60_000).unref();
// Tenant Dashboard is a read-model module. Keep it mounted independently so
// its UI can be rebuilt incrementally without touching router or payment code.
require('./lib/tenant-dashboard').attachTenantDashboardRoutes(app, { businessAuth, db: db.db });
require('./lib/tenant-portal-templates').attachTenantPortalTemplateRoutes(app, { businessAuth, db: db.db });
// Per-tenant Tuma settlement: each tenant gets its own Tuma business so
// customer payments settle straight to that tenant's Till, PayBill or bank.
const tumaTenants = createTumaTenants({
  db: db.db, tuma, encrypt: tenant.encryptSecret, decrypt: tenant.decryptSecret,
  onPayoutSaved: (businessId, values) => trialGuard.check(businessId, values),
  beforeCreate: (business) => ownerPhoneBlock(business),
  logoUrlFor: (business) => brandingPayload(business).logoUrl || `${config.domains.appUrl}/assets/wifi-fiti-logo.png`,
});
tumaTenants.attachRoutes(app, { businessAuth });

// Trial tenants who never subscribe: switch their Tuma business off after
// TRIAL_DORMANT_DAYS, and back on as soon as they have a trial or paid service.
const TRIAL_DORMANT_DAYS = 30;
function tumaAccountEntitled(businessId) {
  const business = db.businessById.get(businessId); if (!business) return false;
  const s = serviceBilling.summary(business);
  const usable = (x) => x.status === 'active' || x.status === 'grace';
  return s.trial.active || usable(s.hotspot) || usable(s.pppoe) || usable(s.legacy);
}
function tumaAccountDormant(businessId) {
  const business = db.businessById.get(businessId); if (!business) return false;
  if (String(business.billing_status || '').toLowerCase() !== 'trial' || tumaAccountEntitled(businessId)) return false;
  const ended = serviceBilling.parseTime(business.billing_expires_at);
  return ended != null && Date.now() - ended > TRIAL_DORMANT_DAYS * 86400_000;
}
const runTumaSweep = () => tumaTenants.sweep({ isDormant: tumaAccountDormant, isEntitled: tumaAccountEntitled })
  .then((r) => { if (r.suspended || r.resumed) console.log(`[tuma tenants] switched off ${r.suspended}, back on ${r.resumed}`); })
  .catch((err) => console.error('[tuma tenants] sweep failed:', err.message));
setTimeout(runTumaSweep, 90_000).unref();
setInterval(runTumaSweep, 60 * 60_000).unref();

// Tuma bills KES 2,500 a month once a tenant's Tuma sales reach KES 100,000.
// Wi‑Fi Fiti charges the tenant KES 3,000 for it; the tenant pays here by M‑Pesa.
app.get('/api/business/tuma/fee', (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  res.json(tumaFee.state(business.id));
});
app.post('/api/business/tuma/fee/checkout', async (req, res) => {
  const business = businessAuth(req, res); if (!business) return;
  const due = tumaFee.payableMonth(business.id);
  if (!due) return res.status(409).json({ error: 'There is no Tuma fee to pay right now.' });
  if (tumaFee.pendingCheckout(business.id, due.month)) return res.status(409).json({ error: 'Your Tuma fee payment is already processing. Check your phone.' });
  const phone = mpesa.normalizePhone(req.body && req.body.phone || business.owner_phone);
  if (!phone) return res.status(400).json({ error: 'Enter the M-Pesa number that should pay the Tuma fee.' });
  const throttleKey = `tuma-fee:${business.id}:${phone}`;
  const previous = lastPush.get(throttleKey);
  if (previous && Date.now() - previous < PUSH_COOLDOWN_MS) return res.status(429).json({ error: 'A payment request is already on its way. Please wait a moment.' });
  if (platformPushesToday(business.id) >= PLATFORM_PUSHES_PER_DAY) return res.status(429).json({ error: PLATFORM_PUSH_LIMIT_MESSAGE });
  try {
    lastPush.set(throttleKey, Date.now());
    const pushed = await platformStkPush({ phone, amount: TUMA_FEE_KES, accountReference: 'WF-TUMAFEE', description: `Tuma fee ${due.month}` });
    recordPlatformBilling(pushed, { checkoutRequestId: pushed.checkoutRequestId, merchantRequestId: pushed.merchantRequestId,
      businessId: business.id, plan: `tuma-fee-${due.month}`, phone, amount: TUMA_FEE_KES, serviceKind: 'tuma_fee', pppoeUsers: 0, hotspotConcurrent: 0 });
    res.json({ checkoutRequestId: pushed.checkoutRequestId, month: due.month, amount: TUMA_FEE_KES, phoneDisplay: mpesa.displayPhone(phone) });
  } catch (err) {
    lastPush.delete(throttleKey);
    console.error('[tuma fee] STK push failed:', err.message);
    res.status(502).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});
paymentIntegrations.attachPaymentIntegrationRoutes(app, { businessAuth, tenant, tumaTenants, onPayoutSaved: (businessId, shortcode) => trialGuard.check(businessId, { payout: `mpesa:${shortcode}` }) });
whatsapp.attachWhatsAppRoutes(app);
// The admin module owns privileged dashboard routes and controls. It is
// intentionally mounted separately from tenant, router, and portal modules.
require('./lib/admin').attachAdminModule(app, { db, adminOk, tenant });

if (config.mpesa.env !== 'production' && /^https:\/\//.test(String(config.publicUrl || '')) && !/\.(test|localhost)(\/|$)/.test(String(config.publicUrl || ''))) {
  console.warn('*** WARNING: MPESA_ENV is not "production". Sandbox M-Pesa callbacks are trusted without a Daraja query. Set MPESA_ENV=production on a live deployment. ***');
}

app.listen(config.port, () => {
  console.log(`${config.brandName} hotspot billing on :${config.port}`);
  console.log(`M-Pesa environment: ${config.mpesa.env}`);
  console.log(`Callback URL: ${config.publicUrl}/api/mpesa/callback`);
  const tumaConfig = tuma.configurationStatus();
  console.log(`[tuma] API email: ${tumaConfig.missing.includes('TUMA_API_EMAIL') ? 'missing' : 'set'}; API key: ${tumaConfig.missing.includes('TUMA_API_KEY') ? 'missing' : 'set'}; callback secret: ${tumaConfig.missing.includes('TUMA_CALLBACK_SECRET') ? 'missing' : 'set'}`);
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

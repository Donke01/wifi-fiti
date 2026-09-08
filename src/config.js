require('dotenv').config();

const required = [
  'PUBLIC_URL',
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_SHORTCODE',
  'MPESA_PASSKEY',
];

// The router is deliberately NOT required. You should be able to prove the
// M-Pesa half works before any hardware exists; without this, a missing
// router password blocks testing the part that has nothing to do with it.
const routerConfigured = Boolean(
  process.env.MIKROTIK_HOST &&
  process.env.MIKROTIK_USER &&
  process.env.MIKROTIK_PASSWORD
);

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing required environment variables:\n  ' + missing.join('\n  '));
  console.error('\nCopy .env.example to .env and fill it in.');
  process.exit(1);
}

const env = process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox';

function localHttpHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.endsWith('.localhost') || value.endsWith('.test');
}

function webOrigin(value, name) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    // Router credentials and customer payment sessions must never traverse
    // an ordinary production HTTP origin. Local and .test development hosts
    // remain available for the in-process test suite and local preview.
    if (parsed.protocol === 'http:' && !localHttpHost(parsed.hostname)) throw new Error('HTTPS required');
    return parsed.origin;
  } catch (_) {
    console.error(`${name} must be a full https:// URL (http:// is allowed only for localhost or .test development hosts).`);
    process.exit(1);
  }
}

function hostname(value, name) {
  try { return new URL(value).hostname.toLowerCase(); }
  catch (_) {
    console.error(`${name} must be a full http:// or https:// URL.`);
    process.exit(1);
  }
}

function bareHostname(value, name) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(`https://${raw}`);
    if (parsed.hostname !== raw || parsed.port || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('not a bare hostname');
    return raw;
  } catch (_) {
    console.error(`${name} must be a bare hostname such as wififiti.co.ke.`);
    process.exit(1);
  }
}

const publicUrl = webOrigin(process.env.PUBLIC_URL, 'PUBLIC_URL');
// `PUBLIC_URL` was the original application's only public-origin setting.
// Keep an older or staging deployment safe when APP_URL has not been added:
// generated portals and pairing kits must stay on that deployment, never jump
// to the production app host. Production sets both values to the app domain.
const appUrl = process.env.APP_URL
  ? webOrigin(process.env.APP_URL, 'APP_URL')
  : publicUrl;
// The root domain is the public WiFi Fiti Business site. The live billing
// application, captive portals, and router polling live on APP_URL.
const marketingUrl = webOrigin(process.env.MARKETING_URL || 'https://wififiti.co.ke', 'MARKETING_URL');
const legacyHost = String(process.env.LEGACY_HOST || 'wififiti.co.ke').trim().toLowerCase().replace(/\.$/, '') || 'wififiti.co.ke';
// The Cloudflare Worker owns this hostname space. It is intentionally
// separate from APP_URL: Railway remains the only app, payment callback and
// router-poll origin. The explicit switch prevents a DNS/route deployment
// mistake from changing live customer links merely because the credentials
// were saved in Railway early.
const portalRootDomain = bareHostname(process.env.PORTAL_ROOT_DOMAIN || '', 'PORTAL_ROOT_DOMAIN');
const edgeGatewaySecret = String(process.env.EDGE_GATEWAY_SECRET || '');
const portalGatewayRequested = String(process.env.PORTAL_GATEWAY_ENABLED || '').trim().toLowerCase() === 'true';
if (Boolean(portalRootDomain) !== Boolean(edgeGatewaySecret)) {
  console.error('Set PORTAL_ROOT_DOMAIN and EDGE_GATEWAY_SECRET together, or leave both empty.');
  process.exit(1);
}
if (edgeGatewaySecret && edgeGatewaySecret.length < 32) {
  console.error('EDGE_GATEWAY_SECRET must be at least 32 characters. Generate it with: openssl rand -hex 32');
  process.exit(1);
}
if (portalGatewayRequested && (!portalRootDomain || !edgeGatewaySecret)) {
  console.error('PORTAL_GATEWAY_ENABLED=true requires PORTAL_ROOT_DOMAIN and EDGE_GATEWAY_SECRET.');
  process.exit(1);
}
const portalGatewayEnabled = portalGatewayRequested && Boolean(portalRootDomain && edgeGatewaySecret);

module.exports = {
  port: Number(process.env.PORT || 3000),
  publicUrl,
  domains: {
    appUrl,
    appHost: hostname(appUrl, 'APP_URL'),
    marketingUrl,
    marketingHost: hostname(marketingUrl, 'MARKETING_URL'),
    legacyHost,
    portalRootDomain,
    portalGatewayEnabled,
  },

  edgeGatewaySecret,

  mpesa: {
    env,
    baseUrl:
      env === 'production'
        ? 'https://api.safaricom.co.ke'
        : 'https://sandbox.safaricom.co.ke',
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    transactionType:
      process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
  },

  // 'poll'  - routers fetch jobs from us. Nothing inbound, scales to many
  //           sites, survives NAT. The default.
  // 'api'   - we connect out to one router's API. Simpler for a single
  //           site on the same LAN.
  provisionMode: process.env.PROVISION_MODE === 'api' ? 'api' : 'poll',

  site: {
    id: process.env.SITE_ID || 'site-1',
    token: process.env.SITE_TOKEN || '',
    hotspotServer: process.env.MIKROTIK_HOTSPOT_SERVER || 'hotspot1',
  },

  mikrotik: {
    configured: routerConfigured,
    host: process.env.MIKROTIK_HOST,
    port: Number(process.env.MIKROTIK_PORT || 8728),
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASSWORD,
    hotspotServer: process.env.MIKROTIK_HOTSPOT_SERVER || 'hotspot1',
  },

  databasePath: process.env.DATABASE_PATH || './data/hotspot.db',
  brandName: process.env.BRAND_NAME || 'WiFi Fiti',
  supportPhone: process.env.SUPPORT_PHONE || '',
};

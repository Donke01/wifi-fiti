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

function wireGuardPublicKey(value, name) {
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw) || Buffer.from(raw, 'base64').length !== 32) {
    console.error(`${name} must be a 32-byte WireGuard public key in standard base64 format.`);
    process.exit(1);
  }
  return raw;
}

function privateIpv4(value, name) {
  const raw = String(value || '').trim();
  const octets = raw.split('.');
  const numeric = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : NaN));
  const privateRange = numeric.length === 4 && numeric.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    (numeric[0] === 10 || (numeric[0] === 172 && numeric[1] >= 16 && numeric[1] <= 31) || (numeric[0] === 192 && numeric[1] === 168));
  if (!privateRange) {
    console.error(`${name} must be a private IPv4 address.`);
    process.exit(1);
  }
  return numeric.join('.');
}

function privateIpv4Cidr(value, name) {
  const raw = String(value || '').trim();
  const match = /^(.+)\/(\d{1,2})$/.exec(raw);
  if (!match || Number(match[2]) < 8 || Number(match[2]) > 30) {
    console.error(`${name} must be a private IPv4 CIDR such as 10.254.0.0/16.`);
    process.exit(1);
  }
  return `${privateIpv4(match[1], name)}/${Number(match[2])}`;
}

// The RouterOS activation helper deliberately accepts only this management
// network. Keeping the application configuration equally narrow prevents a
// future environment typo from sending a customer LAN, a default route, or a
// differently shaped VPN network to a router. A later multi-gateway design
// can expand this together with the reviewed RouterOS allowlist.
function wifiFitiManagementNetwork(address, cidr) {
  if (address !== '10.254.0.1' || cidr !== '10.254.0.0/16') {
    console.error('WiFi Fiti VPN management is fixed to VPN_GATEWAY_ADDRESS=10.254.0.1 and VPN_GATEWAY_MANAGEMENT_CIDR=10.254.0.0/16.');
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

// The WiFi Fiti gateway is deliberately a separate, outbound-only
// WireGuard control plane. It carries router-management traffic only: never
// customer browsing, M-Pesa, portal traffic, or router credentials. Keep
// its private key exclusively on the VPS; Railway receives only this public
// identity and an independently scoped pull-agent secret.
const vpnGatewayRequested = String(process.env.VPN_GATEWAY_ENABLED || '').trim().toLowerCase() === 'true';
const vpnGatewayId = String(process.env.VPN_GATEWAY_ID || '').trim();
const vpnGatewayEndpoint = String(process.env.VPN_GATEWAY_ENDPOINT || '').trim();
const vpnGatewayPortRaw = String(process.env.VPN_GATEWAY_PORT || '').trim();
const vpnGatewayPublicKeyRaw = String(process.env.VPN_GATEWAY_PUBLIC_KEY || '').trim();
const vpnGatewayAddressRaw = String(process.env.VPN_GATEWAY_ADDRESS || '').trim();
const vpnGatewayManagementCidrRaw = String(process.env.VPN_GATEWAY_MANAGEMENT_CIDR || '').trim();
const vpnGatewayControlSecret = String(process.env.VPN_GATEWAY_CONTROL_SECRET || '');
let vpnGateway = { enabled: false };
if (vpnGatewayRequested) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(vpnGatewayId)) {
    console.error('VPN_GATEWAY_ID must contain lowercase letters, numbers, and hyphens, beginning with a letter.');
    process.exit(1);
  }
  const endpointHost = bareHostname(vpnGatewayEndpoint, 'VPN_GATEWAY_ENDPOINT');
  const endpointPort = Number(vpnGatewayPortRaw);
  if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535) {
    console.error('VPN_GATEWAY_PORT must be an integer from 1 to 65535.');
    process.exit(1);
  }
  if (vpnGatewayControlSecret.length < 32) {
    console.error('VPN_GATEWAY_CONTROL_SECRET must be at least 32 characters. Generate it with: openssl rand -hex 32');
    process.exit(1);
  }
  const address = privateIpv4(vpnGatewayAddressRaw, 'VPN_GATEWAY_ADDRESS');
  const managementCidr = privateIpv4Cidr(vpnGatewayManagementCidrRaw, 'VPN_GATEWAY_MANAGEMENT_CIDR');
  wifiFitiManagementNetwork(address, managementCidr);
  vpnGateway = {
    enabled: true,
    id: vpnGatewayId,
    endpointHost,
    endpointPort,
    publicKey: wireGuardPublicKey(vpnGatewayPublicKeyRaw, 'VPN_GATEWAY_PUBLIC_KEY'),
    address,
    managementCidr,
    controlSecret: vpnGatewayControlSecret,
  };
}

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
  vpnGateway,

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

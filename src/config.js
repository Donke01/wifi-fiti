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

module.exports = {
  port: Number(process.env.PORT || 3000),
  publicUrl: process.env.PUBLIC_URL.replace(/\/$/, ''),

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

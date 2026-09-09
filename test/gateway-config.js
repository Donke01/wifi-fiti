'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const base = {
  PUBLIC_URL: 'https://config.test',
  MPESA_CONSUMER_KEY: 'config-key',
  MPESA_CONSUMER_SECRET: 'config-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'config-passkey',
  PORTAL_ROOT_DOMAIN: '',
  EDGE_GATEWAY_SECRET: '',
  PORTAL_GATEWAY_ENABLED: 'false',
};

function load(overrides) {
  return spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: root,
    env: { ...process.env, ...base, ...overrides },
    encoding: 'utf8',
  });
}

let result = load({});
assert.equal(result.status, 0, result.stderr);

result = load({ PORTAL_ROOT_DOMAIN: 'wififiti.co.ke' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /together/);

result = load({ EDGE_GATEWAY_SECRET: 'a'.repeat(64) });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /together/);

result = load({ PORTAL_ROOT_DOMAIN: 'wififiti.co.ke', EDGE_GATEWAY_SECRET: 'short' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /at least 32 characters/);

result = load({ PORTAL_GATEWAY_ENABLED: 'true' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /requires PORTAL_ROOT_DOMAIN/);

result = load({
  PORTAL_ROOT_DOMAIN: 'wififiti.co.ke',
  EDGE_GATEWAY_SECRET: 'a'.repeat(64),
  PORTAL_GATEWAY_ENABLED: 'true',
});
assert.equal(result.status, 0, result.stderr);

const vpn = {
  VPN_GATEWAY_ENABLED: 'true',
  VPN_GATEWAY_ID: 'primary',
  VPN_GATEWAY_ENDPOINT: 'vpn.wififiti.co.ke',
  VPN_GATEWAY_PORT: '51820',
  VPN_GATEWAY_PUBLIC_KEY: Buffer.alloc(32, 19).toString('base64'),
  VPN_GATEWAY_ADDRESS: '10.254.0.1',
  VPN_GATEWAY_MANAGEMENT_CIDR: '10.254.0.0/16',
  VPN_GATEWAY_CONTROL_SECRET: 'g'.repeat(64),
};
result = load(vpn);
assert.equal(result.status, 0, result.stderr);

result = load({ ...vpn, VPN_GATEWAY_MANAGEMENT_CIDR: '10.253.0.0/16' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /fixed to/);

result = load({ ...vpn, VPN_GATEWAY_ADDRESS: '10.254.0.2' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /fixed to/);

console.log('Cloudflare and VPN gateway configuration: safe activation checks passed.');

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

console.log('Cloudflare gateway configuration: safe activation checks passed.');

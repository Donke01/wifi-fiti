'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { embedPublicPortalConfig } = require('../src/lib/portal-bootstrap');

const config = {
  location: { id: 'loc-123', name: 'SUPERSURF' },
  packages: [{ id: 'hour', price: 10, name: '</script><script>bad()</script>' }],
};
const html = embedPublicPortalConfig('<!doctype html><html><head><title>WiFi</title></head><body>test</body></html>', config);
assert.equal((html.match(/<\/head>/g) || []).length, 1);
assert.ok(!html.includes('<script>bad()'), 'untrusted package labels cannot create script nodes');
assert.ok(!html.includes('</script><script>bad()'), 'inline JSON remains HTML-safe');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context = { globalThis: {} };
vm.runInNewContext(script, context);
assert.equal(context.globalThis.__WIFI_FITI_CONFIG__.location.id, 'loc-123');
assert.equal(context.globalThis.__WIFI_FITI_CONFIG__.packages[0].price, 10);
assert.equal(context.globalThis.__WIFI_FITI_CONFIG__.packages[0].name, config.packages[0].name);
assert.throws(() => embedPublicPortalConfig('missing head', config), /Missing/);
console.log('portal bootstrap tests passed');

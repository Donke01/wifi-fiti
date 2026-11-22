'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderRouterLoginPage, ROUTER_LOGIN_TEMPLATE_VERSION } = require('../src/lib/router-login');

assert.equal(ROUTER_LOGIN_TEMPLATE_VERSION, 'v5');
const target = 'https://supersurf.wififiti.co.ke/?mac=$(mac)&ip=$(ip)&link-login-only=$(link-login-only)&link-orig=$(link-orig-esc)';
const html = renderRouterLoginPage({ title: 'SUPERSURF', portalUrl: target });
assert.match(html, /^<!doctype html>/);
assert.match(html, /window\.location\.replace/);
assert.match(html, /http-equiv="refresh"/);
assert.match(html, /Open packages/);
assert.ok(html.includes('mac=$(mac)'));
assert.ok(html.includes('link-login-only=$(link-login-only)'));
assert.ok(html.includes('link-orig=$(link-orig-esc)'));
assert.ok(!html.includes('src="http'), 'no remote assets before payment');
let redirected = '';
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInNewContext(script, { window: { location: { replace: (url) => { redirected = url; } } } });
assert.equal(redirected, target);
const native = renderRouterLoginPage({ title: 'SUPERSURF', portalUrl: target, httpRedirect: true });
assert.deepEqual(native.split('\n').slice(0, 3), [
  '$(if http-status == 302)Hotspot login required$(endif)',
  '$(if http-header == "Location")' + target + '$(endif)',
  '$(if http-header == "Cache-Control")no-store$(endif)',
]);
assert.ok(native.endsWith(html), 'the native redirect retains the HTML fallback');
assert.throws(() => renderRouterLoginPage({
  portalUrl: 'https://safe.example/?x=1\r\nFake-Header: value', httpRedirect: true,
}), /Invalid captive portal Location header/);
const hostile = renderRouterLoginPage({ title: '<b>x</b>', portalUrl: 'https://safe.example/?x=</script><script>evil()</script>&q="' });
assert.ok(!hostile.includes('<script>evil()'), 'target cannot escape script context');
assert.match(hostile, /&lt;b&gt;x&lt;\/b&gt;/);
assert.throws(() => renderRouterLoginPage({ portalUrl: 'http://router/login' }), /HTTPS/);
console.log('router login tests passed');

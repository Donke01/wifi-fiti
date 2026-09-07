'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/business.html'), 'utf8');

assert.match(html, /id="remote-onboarding-section"/, 'the dashboard explains the two-stage onboarding path');
assert.match(html, /Remote setup/, 'each location exposes managed setup without hiding it in a support-only view');
assert.match(html, /\/remote-access/, 'the UI calls a location-scoped remote-access API');
assert.match(html, /consent:\s*true/, 'a business owner must explicitly consent before remote access is requested');
assert.match(html, /action:\s*'revoke'/, 'an owner can revoke remote access');
assert.match(html, /Customer traffic and payments never use this support path/, 'the UI does not imply customer traffic is routed through support access');
assert.doesNotMatch(html, /privateKey|private-key|vpnPrivate/i, 'the business UI must never render VPN private material');

// A tenant must be able to find its branded WiFi Fiti address before one has
// been assigned.  Keeping this inside a `location.portal_hostname` condition
// made the capability invisible precisely when a new location needed it.
const locationEditor = html.match(/function renderLocationEditor\(location, card\) \{[\s\S]*?\n\s*function rotateLocationToken/);
assert.ok(locationEditor, 'the location editor remains a distinct dashboard surface');
assert.match(locationEditor[0], /field\('Customer portal address',\s*'portalSlug'/,
  'the location editor always includes the managed portal-address field');
assert.doesNotMatch(locationEditor[0], /if\s*\(\s*location\.portal_hostname\s*\)\s*field\(\s*'Customer portal address'/,
  'the managed portal-address field is not hidden until a hostname already exists');

// Starting over must be safe for a live business: the dashboard can clear
// unsaved wizard choices or stage a replacement kit, while deletion stays
// limited to an explicitly confirmed, unused draft. It must never offer a
// remote RouterOS factory reset.
assert.match(html, /Start router setup again/,
  'each location offers a safe way to begin its router setup again');
assert.match(html, /Clear setup form/,
  'the setup wizard can clear only unsaved form choices');
assert.match(html, /Delete unused setup/,
  'a pristine location exposes a clearly scoped discard action');
assert.match(html, /confirm:\s*'DELETE'/,
  'the UI sends the explicit deletion confirmation required by the API');
assert.doesNotMatch(html, /\/system\s+reset-configuration/,
  'the dashboard must not offer a remote RouterOS factory reset');

for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);

console.log('Business UI: remote onboarding, discoverable managed portal addressing, and client-script safety passed.');

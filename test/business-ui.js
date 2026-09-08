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
// limited to an explicitly confirmed, unused draft. The new-router reset
// instruction is deliberately a copy-only, optional manual action; it is
// never sent to a router by WiFi Fiti.
assert.match(html, /Start router setup again/,
  'each location offers a safe way to begin its router setup again');
assert.match(html, /Clear setup form/,
  'the setup wizard can clear only unsaved form choices');
assert.match(html, /Delete unused setup/,
  'a pristine location exposes a clearly scoped discard action');
assert.match(html, /confirm:\s*'DELETE'/,
  'the UI sends the explicit deletion confirmation required by the API');
assert.match(html, /Initial Preparation \(Optional\)/,
  'fresh-router preparation is explicitly optional');
assert.match(html, /\/system reset-configuration no-defaults=yes skip-backup=yes/,
  'the manual reset instruction uses valid RouterOS no-defaults syntax');
assert.match(html, /WiFi Fiti never resets a router remotely/,
  'the reset instruction makes its manual, owner-controlled scope explicit');
assert.doesNotMatch(html, /no-default=yes/,
  'the UI does not publish the invalid singular no-default reset property');

// First-time owners should see one safe setup stage at a time. A current,
// completed router sync—not a generic router request—must unlock the final
// commercial stage.
assert.match(html, /id="onboarding-section"/,
  'the business workspace includes a dedicated guided setup surface');
assert.match(html, /SELF-ONBOARDING/,
  'the onboarding journey has a focused self-onboarding heading');
assert.match(html, /Add router.*Setup & connect.*Go live/s,
  'the journey presents the requested three-stage sequence');
assert.match(html, /sequential-onboarding[\s\S]*section:not\(#onboarding-section\)/,
  'unrelated dashboard pages are hidden while the sequential flow is active');
assert.match(html, /unlocked:\s*unlocked/,
  'the journey remembers which explicit Next action has unlocked each stage');
assert.match(html, /number <= flow\.unlocked/,
  'future stages remain locked until the owner explicitly advances to them');
assert.match(html, /last_successful_sync_at/,
  'router pairing is derived from a completed secure sync');
assert.match(html, /router_pairing_pending/,
  'a staged replacement router cannot inherit the old router pairing state');
assert.match(html, /router_sync_healthy/,
  'go-live progression requires a fresh successful router sync');
assert.match(html, /onboardingStatusFingerprint/,
  'unchanged router-status checks can avoid rebuilding the guided setup UI');
assert.match(html, /checks this router automatically every 5 seconds/,
  'an awaiting router receives a clear, live connection status');
assert.match(html, /confirmFreshOnboardingRouter/,
  'continuing and finishing revalidate a fresh secure router sync');
assert.match(html, /model\.needsRouterCheck \? 5000 : 30000/,
  'a verified router is still rechecked while its setup flow remains open');
assert.match(html, /document\.visibilityState === 'hidden'/,
  'automatic status checks pause while the dashboard is not visible');
assert.match(html, /Router needs to reconnect/,
  'a historically paired but offline router is never presented as ready for customers');
assert.match(html, /Review or delete unused setup/,
  'the guided setup exposes the safe recovery route for a pristine draft');
assert.match(html, /openOnboardingPortal/,
  'the customer-portal step leads owners to their managed portal address settings');
assert.match(html, /@media\(max-width:900px\)\{\.onboarding-flow-head[\s\S]*\.setup-rail\{grid-template-columns:1fr/,
  'the three setup stages stay readable in one connected mobile/tablet sequence');
assert.match(html, /Initial Preparation \(Optional\)/,
  'safe optional preparation guidance is available in the connection stage');
assert.match(html, /WiFi Fiti never resets a router remotely/,
  'the new onboarding language keeps router resets explicitly owner-controlled');

// New business owners create a sign-in first, then complete only their
// organisation profile. Router identity is collected in a small dialog so
// the first connection guide does not begin with the large advanced form.
assert.match(html, /id="organisation-setup"/,
  'a signed-in trial account receives a dedicated organisation step');
assert.match(html, /name="organisationName"[\s\S]*name="phone"[\s\S]*name="hotspotName"/,
  'the organisation step asks only for organisation, phone and hotspot name');
assert.match(html, /Create organisation/,
  'the organisation step has one clear completion action');
assert.match(html, /\/api\/business\/organisation/,
  'the client saves the authenticated organisation profile');
assert.match(html, /id="router-draft-modal"/,
  'organisation completion opens the compact add-router dialog');
assert.match(html, /name="routerName"[\s\S]*name="location"/,
  'the add-router dialog captures router name and location');
assert.match(html, /openRouterDraftModal\(\)/,
  'the initial router route is launched from the short dialog');

// Secure remote access is the selected presentation route, but it must not
// pretend that the current outbound polling check is a VPN handshake. Two
// manual unsuccessful checks expose the explicitly selectable polling path.
assert.match(html, /Secure remote access/,
  'the recommended secure remote route is visible first');
assert.match(html, /WiFi Fiti polling/,
  'the customer can select the polling fallback');
assert.match(html, /connectionAttemptCount\(location\)/,
  'fallback availability tracks connection checks per router');
assert.match(html, /attempts < 2/,
  'the fallback is deferred until two unsuccessful checks');
assert.match(html, /recordConnectionAttempt\(current\.location\)/,
  'manual unsuccessful checks are recorded before exposing fallback');
assert.doesNotMatch(html, /VPN connected/i,
  'the UI does not falsely claim a VPN handshake without a real gateway');
assert.match(html, /\/system\/device-mode\/update mode=advanced/,
  'device-mode guidance is directly copyable');
assert.match(html, /physical confirmation and reboot/,
  'device-mode guidance accurately requires local RouterOS confirmation');

for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);

console.log('Business UI: remote onboarding, discoverable managed portal addressing, and client-script safety passed.');

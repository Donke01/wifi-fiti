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

// A customer address is intentionally deferred until the router has proved
// its WiFi Fiti connection. The normal dashboard must not tease an owner
// with a setting that the server will correctly refuse.
const locationEditor = html.match(/function renderLocationEditor\(location, card\) \{[\s\S]*?\n\s*function rotateLocationToken/);
assert.ok(locationEditor, 'the location editor remains a distinct dashboard surface');
assert.match(locationEditor[0], /field\('Customer portal address',\s*'portalSlug'/,
  'the location editor has a managed portal-address field for connected routers');
assert.match(locationEditor[0], /var routerPending = routerPairingPending\(location\); var routerConnected = Boolean\(location\.last_successful_sync_at && !routerPending\)/,
  'the location editor treats a staged replacement as unverified even when the old router has a sync timestamp');
assert.match(locationEditor[0], /Connect this router first/,
  'an unconnected router receives a direct explanation instead of an unusable field');
assert.match(locationEditor[0], /A replacement router is waiting for its secure check-in/,
  'the location editor explains why a pending replacement cannot change the customer address');

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
  'future stages remain locked until the current stage is complete');
assert.match(html, /\.setup-rail\{pointer-events:none\}/,
  'the progress rail is informational and cannot reopen unrelated setup pages');
assert.match(html, /var item = el\('div', 'setup-stage '/,
  'progress items are display-only rather than clickable controls');
assert.match(html, /last_successful_sync_at/,
  'router pairing is derived from a completed secure sync');
assert.match(html, /router_pairing_pending/,
  'a staged replacement router cannot inherit the old router pairing state');
assert.match(html, /router_sync_healthy/,
  'go-live progression requires a fresh successful router sync');
assert.match(html, /function beginFreshRouterPairing\(model\)/,
  'returning to onboarding explicitly starts a fresh pairing rather than trusting a prior sync');
assert.match(html, /function startRouterSetupAgain\(location\) \{[\s\S]*?requireFreshRouterSetup\(location\);[\s\S]*?forgetSetup\(location\.id\)/,
  'the visible Start router setup again action suppresses a prior verified state before the new kit is issued');
assert.match(html, /var freshKitRequired = Boolean\(location && !routerPairingPending\(location\) && freshRouterSetupRequired\(location\)\)/,
  'a requested re-pairing cannot inherit a previous router verification');
assert.match(html, /!freshKitRequired && routerSuccessfullyPaired\(location\)/,
  'the old secure sync remains blocked until a new kit is issued and succeeds');
assert.match(html, /The next page asks for the customer Wi-Fi name and password, then creates one visible kit/,
  'a re-pairing preserves the explicit SSID and password screen instead of silently creating a random kit');
assert.match(html, /Create a fresh connection kit/,
  'a requested re-pairing clearly explains why the old router is no longer verified');
assert.match(html, /clearFreshRouterSetup\(location\); saveSetup\(result\.location, result\.portalUrl, result\.setup\)/,
  'the browser-only restart marker is cleared only after the owner issues a new kit');
assert.doesNotMatch(html, /startFreshRouterConnection/,
  'the focused journey does not call the removed background kit generator');
assert.match(html, /Waiting for router/,
  'a staged replacement is clearly presented as awaiting its own secure sync');
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
assert.match(html, /Create a different kit/,
  'the guided setup offers a single clear recovery action for its connection kit');
assert.match(html, /Copy connection kit/,
  'the normal onboarding route lets an owner copy the complete RouterOS kit directly');
assert.match(html, /appendCustomerPortalSetup/,
  'the customer-page step is rendered directly after router connection');
assert.match(html, /!model\.portalReady/,
  'customer page setup precedes packages and payment configuration');
assert.match(html, /portal_setup_completed_at/,
  'customer-page completion is tracked per selected router location');
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

// The normal connection route is one outbound-only path. It must not pretend
// to be a working VPN or make the owner choose between duplicate installers.
assert.match(html, /Secure outbound connection/,
  'the recommended outbound route is visible first');
assert.doesNotMatch(html, /VPN connected/i,
  'the UI does not falsely claim a VPN handshake without a real gateway');
assert.match(html, /\/system device-mode update mode=advanced/,
  'device-mode guidance is directly copyable');
assert.match(html, /confirm the physical prompt/,
  'device-mode guidance accurately requires local RouterOS confirmation');
const onboardingRenderer = html.match(/function renderOnboarding\(\) \{[\s\S]*?\n\s*function readFileDataUrl/);
assert.ok(onboardingRenderer, 'the guided setup renderer is present');
assert.doesNotMatch(onboardingRenderer[0], /mountSetupPanel\([^\n]*router-setup-section/,
  'the legacy large router form is not mounted inside the focused journey');
assert.match(onboardingRenderer[0], /appendSimpleRouterSetup\(connectBody, model\)/,
  'the focused journey mounts one compact router-kit screen');
assert.match(html, /Automatic router detection/,
  'the focused journey lets the router kit choose the safe setup path');
assert.match(html, /payload\.modelProfile = 'auto'/,
  'the focused journey does not ask customers to guess a board profile');
assert.match(html, /Download \.rsc/,
  'the focused connection screen offers a file download instead of forcing a long terminal paste');
assert.match(html, /downloadRouterScript\(script\)/,
  'the focused connection screen downloads the saved router kit');
assert.match(html, /\/api\/business\/onboarding\/customer-portal/,
  'customer-page details use the post-connection endpoint');

for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);

console.log('Business UI: focused onboarding, post-connection customer pages, and client-script safety passed.');

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/business.html'), 'utf8');

assert.match(html, /<section class="section" id="remote-section">[^\n]*Customer traffic and payments never use this path[^\n]*It turns on by itself once a new router finishes setup\. You can turn it off for any router below at any time, and it stays off until you turn it on again\./, 'the Remote access part explains the path, that it starts only after setup, and that turning it off sticks');
assert.match(html, /Remote setup/, 'each location exposes managed setup without hiding it in a support-only view');
assert.match(html, /\/remote-access/, 'the UI calls a location-scoped remote-access API');
assert.match(html, /consent:\s*true/, 'a business owner must explicitly consent before remote access is requested');
assert.match(html, /action:\s*'revoke'/, 'an owner can revoke remote access');
assert.match(html, /Customer traffic and payments never use this path/, 'the UI does not imply customer traffic is routed through support access');
assert.match(html, /function renderRemoteRouters\(\) \{[\s\S]*?openRemoteAccess\(location, card, open\)/, 'the Remote access part opens the same consent-gated panel for each router');
assert.doesNotMatch(html, /privateKey|private-key|vpnPrivate/i, 'the business UI must never render VPN private material');
assert.match(html, /\/mapped-deployment/, 'the mapped deployment remains location-scoped and owner-authenticated');
assert.match(html, /action:\s*'apply'/, 'the browser can request only the finite reviewed mapped-deployment action');
assert.match(html, /Apply Wi-Fi Fiti service/, 'the remote panel makes the post-map action explicit rather than implying a generic terminal');
assert.match(html, /fresh private management handshake/, 'the UI explains that deployment is gated by a current private connection');
assert.match(html, /It never changes WAN, bridge membership, Wi‑Fi name or password, DHCP, NAT, generic firewall policy, Hotspot address, or router administrator access/, 'the UI precisely defines the autonomous deployment boundary');

// A customer address is intentionally deferred until the router has proved
// its Wi-Fi Fiti connection. The normal dashboard must not tease an owner
// with a setting that the server will correctly refuse.
const locationEditor = html.match(/function renderLocationEditor\(location, card\) \{[\s\S]*?\n\s*function renderLocations/);
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
// never sent to a router by Wi-Fi Fiti.
assert.match(html, /Start router setup again/,
  'each location offers a safe way to begin its router setup again');
assert.doesNotMatch(html, /Offboard \/ remove router|\/offboard|OFFBOARD ROUTER/,
  'remote router offboarding is temporarily hidden from the dashboard');
assert.doesNotMatch(html, /id="router-setup-section"|id="location-setup-section"|Generate secure router setup/,
  'the old router wizard is gone: guided setup is the only way to create a router kit');
assert.match(html, /\$\('add-router'\)\.addEventListener\('click', function \(\) \{ if \(state\.workspace\) startAdditionalRouter\(\); \}\);/,
  'Add router on the Routers page starts guided setup');
assert.match(html, /Remove unused setup/,
  'a location exposes only an explicit unused-draft removal action');
assert.match(html, /function discardUnusedRouterSetup\(location, button, error\)/,
  'the editor uses the same draft-only removal path as the focused onboarding flow');
assert.doesNotMatch(html, /DELETE ROUTER|Rotate router token/,
  'the dashboard does not expose a broad live-router deletion or unactionable token-rotation control');
assert.match(html, /function routerCanBeRemoved\(location\)/,
  'the guided journey uses a conservative local check before exposing router removal');
assert.match(html, /function removeOnboardingRouter\(model, button\)/,
  'the guided journey has a dedicated unused-router removal path');
assert.match(html, /Remove router/,
  'the router can be removed directly from the focused onboarding pages');
assert.match(html, /never resets the physical router/,
  'router removal accurately states that it removes cloud setup only');
assert.match(html, /Back to router/,
  'the connection stages provide a direct return to router details');
assert.match(html, /Back to secure connection/,
  'the mapping stage can return to the preceding connection stage');
assert.match(html, /Back to workspace/,
  'owners can leave onboarding without deleting their saved progress');
assert.match(html, /Router setup is paused\./,
  'leaving an incomplete journey presents an accurate resumable state');
assert.match(html, /'Router just reset\? Give it internet first'\); add\(preparation, 'p', 'setup-preparation-copy', 'Optional: /,
  'fresh-router preparation is explicitly optional');
assert.match(html, /\/system reset-configuration no-defaults=yes skip-backup=yes/,
  'the manual reset instruction uses valid RouterOS no-defaults syntax');
assert.match(html, /Wi-Fi Fiti never resets a router remotely/,
  'the reset instruction makes its manual, owner-controlled scope explicit');
assert.doesNotMatch(html, /no-default=yes/,
  'the UI does not publish the invalid singular no-default reset property');

// First-time owners should see one safe setup stage at a time. A current,
// completed router sync—not a generic router request—must unlock the final
// commercial stage.
assert.match(html, /id="onboarding-section"/,
  'the business workspace includes a dedicated guided setup surface');
assert.match(html, /'onboarding-flow-kicker', 'SETUP GUIDE'/,
  'the onboarding journey has a focused setup-guide heading');
assert.doesNotMatch(html, /onboarding-flow-count|setup stage/,
  'the rail and "Step N of 3" show progress, without a second counter');
assert.match(html, /Add router.*Secure connection.*Map router/s,
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
assert.match(html, /function beginFreshRouterPairing\(model\) \{[\s\S]*?if \(routerPairingPending\(location\) \|\| !routerSuccessfullyPaired\(location\)\) \{ setConnectionPhase\(location, 'install'\); advanceOnboardingStage\(model, 2, 'connect'\); return; \}\n\s*requireFreshRouterSetup\(location\); forgetSetup\(location\.id\);/,
  'a router that verified before still needs a fresh kit; one that never connected keeps its saved kit');
assert.match(html, /function startRouterSetupAgain\(location\) \{[\s\S]*?requireFreshRouterSetup\(location\);[\s\S]*?forgetSetup\(location\.id\)/,
  'the visible Start router setup again action suppresses a prior verified state before the new kit is issued');
assert.match(html, /var freshKitRequired = Boolean\(location && !routerPairingPending\(location\) && freshRouterSetupRequired\(location\)\)/,
  'a requested re-pairing cannot inherit a previous router verification');
assert.match(html, /!freshKitRequired && routerSuccessfullyPaired\(location\)/,
  'the old secure sync remains blocked until a new kit is issued and succeeds');
assert.match(html, /On the next page, tap Generate connection kit to make a new kit, then paste it in WinBox/,
  'a re-pairing waits for the owner to generate the new kit instead of silently creating one');
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
assert.match(html, /model\.needsRouterCheck \? 5000 : waitsForMap \? 10000 : 30000/,
  'connection and post-connection map states both receive bounded automatic checks');
assert.match(html, /document\.visibilityState === 'hidden'/,
  'automatic status checks pause while the dashboard is not visible');
assert.match(html, /Router needs to reconnect/,
  'a historically paired but offline router is never presented as ready for customers');
assert.match(html, /moreOption\('Generate a new kit'/,
  'the guided setup offers a single clear recovery action for its connection kit');
assert.doesNotMatch(html, /Create a different kit/,
  'the pairing card does not repeat the kit recovery action');
assert.match(html, /Copy connection kit/,
  'the normal onboarding route lets an owner copy the complete RouterOS kit directly');
assert.match(html, /appendRouterMappingSetup/,
  'the third focused step renders a router map after secure connection');
assert.match(html, /routerMappingStatus/,
  'onboarding follows the server-provided mapping status rather than guessed names');
assert.match(html, /routerMappingConfirmed/,
  'only a confirmed, current router map unlocks the normal workspace');
assert.match(html, /!routerPairingPending\(location\) && routerMappingStatus\(location\) === 'confirmed'/,
  'a staged replacement cannot inherit a previous router map in the browser');
assert.match(html, /\(!stored \|\| !stored\.active\) && model\.configured\) return \{ active: false/,
  'an existing workspace stays usable while an optional router map is reviewed');
assert.match(html, /Customer branding, packages and payments follow in your workspace/,
  'customer-facing and commercial settings are deferred until router setup is complete');
assert.match(html, /\/router-topology/,
  'the mapping page reads the owner-scoped router inventory endpoint');
assert.match(html, /\/router-mapping/,
  'the owner can save a confirmed router map through its dedicated endpoint');
assert.match(html, /wanInterface: wanSelect\.value, customerBridge: bridgeSelect\.value, wifiInterfaces: selectedChecks\('wifiInterfaces'\), customerPorts: selectedChecks\('customerPorts'\)/,
  'the confirmation sends only the selected WAN, bridge, Wi-Fi and Ethernet interface names');
assert.match(html, /It does not alter bridges, Wi-Fi, Hotspot, firewall rules or router administrator access/,
  'the mapping screen clearly states that confirmation cannot reconfigure the router');
assert.match(html, /router-map-board/,
  'detected Ethernet, bridge and Wi-Fi interfaces have an original visual map');
assert.match(html, /Choose the physical WAN port/,
  'an unknown WAN is never silently guessed from the first Ethernet port');
assert.match(html, /This layout cannot be mapped yet/,
  'incomplete router inventories receive a clear blocked state instead of empty selectors');
assert.match(html, /'Map router', 'Choose where customers connect'/,
  'the progress rail describes the map step in plain words');
assert.match(html, /@media\(max-width:900px\)\{\.onboarding-flow-head[\s\S]*\.setup-rail\{grid-template-columns:1fr/,
  'the three setup stages stay readable in one connected mobile/tablet sequence');
assert.match(html, /if \(!model\.syncHealthy\) appendPreparation\(connectBody, model\.location, phase === 'prepare'\);/,
  'safe optional preparation guidance is available in the connection stage');
assert.match(html, /Wi-Fi Fiti never resets a router remotely/,
  'the new onboarding language keeps router resets explicitly owner-controlled');
assert.match(html, /function connectionPhaseFor\(model\)/,
  'the connection stage remembers which single focused page an owner was on');
assert.doesNotMatch(html, /Prepare your router|Continue to secure connection/,
  'step 2 is one page: preparation is a collapsed section, not a page of its own');
assert.doesNotMatch(html, /appendConnectionMilestones/,
  'step 2 relies on the stage rail above it, without a second rail');
assert.doesNotMatch(html, /appendConnectionMilestones\(connectBody, phase\)/,
  'the secure-kit page relies on the stage rail above it, without a second rail');
assert.match(html, /\/ip dhcp-client add interface=ether1 disabled=no comment="Wi-Fi Fiti WAN"/,
  'new DHCP routers can be prepared with a visible, copyable WAN command');
assert.match(html, /Skip it for PPPoE, static IP or another WAN port/,
  'the WAN guidance does not pretend that DHCP on ether1 fits every router');
assert.match(html, /Wi-Fi Fiti already retries through its outbound polling link/,
  'failed connection checks offer an honest recovery path rather than a fake second transport');
assert.match(html, /Review WAN preparation/,
  'two unsuccessful connection checks open the WAN preparation section');

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
assert.match(html, /<button type="submit">Save and continue<\/button><button type="button" class="secondary" id="router-draft-later">/,
  'the add-router dialog has one clear save action');
assert.doesNotMatch(html, /router-draft-clear|Clear fields/, 'the add-router dialog has no clear-fields button');
assert.match(html, /Shown on the customer login page\.[\s\S]*Your own number[\s\S]*Becomes the default customer Wi-Fi name/,
  'each organisation field says what it is for');
assert.match(html, /if \(!hotspot\.dataset\.edited\) hotspot\.value = event\.currentTarget\.value;/,
  'the hotspot name follows the organisation name until the owner edits it');
assert.match(html, /if \(!pairingWait && !model\.syncHealthy && !model\.freshKitRequired && !model\.paired && !routerPairingPending\(model\.location\)\) return;/,
  'before a kit exists, Generate connection kit is the only main action');
assert.match(html, /waitForStart: true, startedAt: saved && saved\.copiedAt \|\| ''/,
  'the pairing timer starts only once the kit is copied');

// The normal connection route is one outbound-only path. It must not pretend
// to be a working VPN or make the owner choose between duplicate installers.
assert.match(html, /Secure outbound connection/,
  'the recommended outbound route is visible first');
assert.doesNotMatch(html, /VPN connected/i,
  'the UI does not falsely claim a VPN handshake without a real gateway');
assert.match(html, /\/system device-mode update fetch=yes scheduler=yes hotspot=yes/,
  'device-mode guidance is directly copyable and enables only required features');
assert.match(html, /confirm the physical prompt/,
  'device-mode guidance accurately requires local RouterOS confirmation');
const onboardingRenderer = html.match(/function renderOnboarding\(\) \{[\s\S]*?\n\s*function readFileDataUrl/);
assert.ok(onboardingRenderer, 'the guided setup renderer is present');
assert.doesNotMatch(onboardingRenderer[0], /mountSetupPanel\([^\n]*router-setup-section/,
  'the legacy large router form is not mounted inside the focused journey');
assert.match(onboardingRenderer[0], /appendSimpleRouterSetup\(connectBody, model\)/,
  'the focused journey mounts one compact router-kit screen');
assert.match(onboardingRenderer[0], /phase === 'prepare'/,
  'the preparation section opens only when the owner asked for it');
assert.match(html, /add\(modes, 'summary', '', 'Other kit'\)/,
  'the focused journey lets the owner choose the kit, with the connection kit first');
assert.match(html, /kitOption\('universal', 'Connection kit \(recommended\)'/, 'the connection kit is the recommended choice');
assert.match(html, /ssid\.label\.classList\.toggle\('hidden', !automatic\); ssid\.input\.disabled = !automatic;/, 'the Wi-Fi name is asked only for the automatic hotspot kit');
assert.match(html, /if \(!automatic\) payload\.wifiSsid = /, 'the connection kit still generates a valid fallback kit without asking for Wi-Fi');
assert.match(html, /payload\.modelProfile = 'auto'/,
  'the focused journey does not ask customers to guess a board profile');
assert.match(html, /payload\.autoRouterConfirmed = 'yes'/,
  'automatic kits require the owner to acknowledge their fresh-router capability');
assert.match(html, /It may configure a fresh\/reset router after checking the device/,
  'automatic-kit confirmation explains the possible router mutation before generation');
assert.doesNotMatch(html, /Download \.rsc|Download full kit|Show full RouterOS kit \(fallback\)/,
  'the focused connection screen hides downloads and fallback scripts');
assert.match(html, /\/api\/business\/onboarding\/customer-portal/,
  'customer-page details use the post-connection endpoint');

// A RouterOS kit is executable configuration. A browser session must never
// keep offering an older saved kit after its bootstrap behavior changes. The
// owner has to deliberately generate a current replacement; merely loading
// the dashboard does not rotate the still-pending server-side credential.
assert.match(html, /var routerKitRevision = 'scheduler-event-v6';/,
  'stored connection kits carry an explicit bootstrap revision');
assert.match(html, /function storedRouterKitIsCurrent\(setup\) \{ return Boolean\(storedRouterKitHasScript\(setup\) && setup\.kitRevision === routerKitRevision\); \}/,
  'only a script saved with the current bootstrap revision is eligible for copying');
assert.match(html, /kitRevision: hasGeneratedScript \? routerKitRevision : ''/,
  'only freshly generated full scripts are marked current in session storage');
assert.match(html, /script: generated\.script, loader: generated\.loader === true/,
  'the browser retains the server approval for a one-line loader with the current kit');
assert.match(html, /function routerBootstrapCommand\(setup, compatibility\)/,
  'current connection kits can render a concise cloud-bootstrap command');
assert.match(html, /setup\.setup\.loader === true/,
  'the concise command is offered only when the server retained the exact one-time kit');
assert.match(html, /\/api\/router\/v1\/bootstrap\?site=/,
  'the concise command fetches Wi-Fi Fiti’s location-specific bootstrap endpoint');
assert.match(html, /http-header-field="' \+ rosQuote\('X-WiFi-Fiti-Router: ' \+ routerToken\)/,
  'the concise command authenticates with the per-location router token, not a global credential');
assert.match(html, /Copy connection kit/,
  'owners can copy the single secure connection kit directly');
assert.match(html, /Use this only if the router stops with "no trusted CA certificate found"\. It skips certificate checks for this router\. Continue\?/,
  'the CA recovery kit requires an explicit security acknowledgement before copying');
assert.match(html, /var script = fallbackChosen \? routerBootstrapCommand\(saved\) : routerBootstrapCommand\(saved, false, false, true\);/, 'the universal kit is the default connection kit unless the owner chose the fallback');
assert.match(html, /Copy automatic hotspot kit \(fallback\)/, 'the automatic kit stays available as the fallback');
assert.doesNotMatch(html, /Download full kit|Download \\.rsc|Show full RouterOS kit \(fallback\)/,
  'the customer onboarding view does not expose downloads or fallback scripts');
assert.match(html, /Wi-Fi Fiti kit was not downloaded\. Check WAN, DNS and RouterOS certificate trust, then retry\./,
  'a failed short installer stops before importing a stale file');
assert.match(html, /Paste this complete kit once/,
  'the dashboard explains that the copied connection kit is complete');
const compactKitUi = html.match(/function appendSimpleRouterSetup\(body, model\) \{[\s\S]*?\n\s*function selectedMode\(\)/);
assert.ok(compactKitUi, 'the compact connection-kit UI is present');
assert.match(compactKitUi[0], /saved && saved\.token && storedRouterKitIsCurrent\(saved\)/,
  'the copy controls are gated on the current stored kit revision');
assert.match(compactKitUi[0], /storedRouterKitIsStale\(saved\)/,
  'an older cached script is detected instead of silently reused');
assert.match(compactKitUi[0], /This saved connection kit is out of date and cannot be copied\./,
  'owners receive a direct fresh-kit instruction before a stale RouterOS command can be copied');
assert.doesNotMatch(html, /function renderPairingKits\(/,
  'the legacy pairing-kit list is gone, so no second list can surface a cached command');
assert.match(html, /\/system device-mode update fetch=yes scheduler=yes hotspot=yes/,
  'the onboarding hint enables only the three required RouterOS device-mode features');
assert.doesNotMatch(html, /\/system device-mode update mode=advanced/,
  'the onboarding hint does not overwrite unrelated owner device-mode choices');

for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);

// Exercise every screen that shows a connection kit: a button present
// somewhere in the HTML is not enough if owners enter through a different
// setup screen. Guided setup is the only one; the old wizard result and the
// saved-kit list are gone.
assert.doesNotMatch(html, /id="router-setup-output"|id="setup-list"|id="router-setup-form"/, 'no second kit screen outside guided setup');
const vm = require('node:vm');
class TestElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.listeners = {}; this.classList = { add() {}, remove() {} }; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
let savedKits = {};
let copiedCommand = '';
const elements = new Map();
const uiLocation = { id: 'loc-installer-test', name: 'Test router', routerToken: 'test-pairing-token-1234567890' };
const context = vm.createContext({
  document: { createElement: tag => new TestElement(tag) },
  window: { location: { origin: 'https://cloud.example.test' } },
  $: id => { if (!elements.has(id)) elements.set(id, new TestElement('div')); return elements.get(id); },
  routerKitRevision: html.match(/var routerKitRevision = '([^']+)'/)[1],
  state: { workspace: { business: {}, locations: [uiLocation] } },
  getSetups: () => savedKits,
  saveSetups: value => { savedKits = value; },
  copyText: value => { copiedCommand = value; },
  publicPortal: () => 'https://cloud.example.test/p/loc-installer-test',
  setConnectionPhase() {}, mergeLocation() {}, rememberOnboardingLocation() {},
  onboardingModel: () => ({}), onboardingFlowState: () => ({ active: false }),
  advanceOnboardingStage() {}, renderLocations() {}, downloadRouterScript() {},
});
vm.runInContext(html.match(/var ROUTER_ROOT_PINS = \[[^\]]*\];/)[0], context);
for (const name of ['el', 'add', 'clear', 'setupAction', 'saveSetup', 'rosQuote', 'routerCommands', 'routerRootTrustSteps', 'routerCertificateFix', 'routerClockFix',
  'routerBootstrapCommand', 'storedRouterKitHasScript', 'storedRouterKitIsCurrent', 'storedRouterKitIsStale',
  'appendRouterInstaller', 'appendSimpleRouterSetup']) {
  const declaration = html.match(new RegExp('      function ' + name + '\\([^]*?(?=\\n      function |\\n    \\}\\)\\(\\);)'));
  assert.ok(declaration, name + ' is available to exercise');
  vm.runInContext(declaration[0], context);
}
for (const loaderStatus of ['ready', 'storage_not_configured', 'unavailable', '']) {
  const generated = { mode: 'auto', script: '# Test full kit\n:put "test"', loader: loaderStatus === 'ready', loaderStatus };
  context.saveSetup(uiLocation, context.publicPortal(), generated);
  const guided = new TestElement('div'); context.appendSimpleRouterSetup(guided, { location: uiLocation });
  for (const [screen, root] of [['guided setup', guided]]) {
    const nodes = descendants(root);
    const buttons = nodes.filter(node => node.tagName === 'button' && node.textContent === 'Copy connection kit');
    assert.equal(buttons.length, 1, screen + ' always identifies the secure connection kit');
    var loaderReady = loaderStatus === 'ready';
    assert.equal(Boolean(buttons[0].disabled), !loaderReady,
      screen + (loaderReady ? ' enables the server-retained secure bootstrap' : ' blocks copying when the secure bootstrap is unavailable'));
    copiedCommand = '';
    if (loaderReady) {
      delete savedKits[uiLocation.id].copiedAt;
      buttons[0].listeners.click();
      assert.match(String(savedKits[uiLocation.id].copiedAt), /^\d{4}-\d\d-\d\dT/, screen + ' records when the kit was copied');
      assert.match(copiedCommand, /\/api\/router\/v1\/bootstrap\?site=loc-installer-test/,
        screen + ' copies the authenticated short bootstrap rather than exposing full RouterOS source');
      assert.match(copiedCommand, /check-certificate=yes/,
        screen + ' keeps certificate verification enabled in the standard bootstrap');
      assert.match(copiedCommand, /&vlan=1/, screen + ' copies the universal kit by default');
      assert.ok(copiedCommand.length < 500, screen + ' copies a short connection kit');
      assert.ok(nodes.some(node => node.tagName === 'button' && node.textContent === 'Copy certificate fix'), screen + ' offers the certificate fix for routers without CAs');
      assert.ok(nodes.some(node => node.tagName === 'button' && node.textContent === 'Copy device-mode fix'), screen + ' offers the device-mode fix next to the certificate and clock fixes');
      const fallback = nodes.find(node => node.tagName === 'button' && node.textContent === 'Copy automatic hotspot kit (fallback)');
      assert.ok(fallback, screen + ' offers the automatic kit as a fallback');
    }
    assert.equal(copiedCommand === '', !loaderReady,
      screen + ' does not expose a browser fallback when the encrypted kit is unavailable');
    assert.equal(nodes.some(node => node.tagName === 'button' && /Download/.test(node.textContent)), false, screen + ' keeps downloads hidden');
  }
}
const stale = new TestElement('div');
context.appendRouterInstaller(stale, { ...savedKits[uiLocation.id], kitRevision: 'old' });
assert.equal(stale.children.length, 0, 'a shared installer panel cannot expose a stale kit');

{
  const setup = { ...savedKits[uiLocation.id], setup: { ...(savedKits[uiLocation.id].setup || {}), loader: true } };
  const universal = context.routerBootstrapCommand(setup, false, false, true);
  assert.match(universal, /&vlan=1/);
  assert.ok(universal.length < 500, 'the connection kit is a short paste (' + universal.length + ' characters)');
  assert.doesNotMatch(universal, /BEGIN CERTIFICATE|router-roots/, 'no certificates in the main command');
  assert.match(universal, /check-certificate=yes dst-path="fiti\.rsc"; \/import fiti\.rsc$/, 'download securely, then run it');
  const fix = context.routerCertificateFix();
  assert.ok(fix.length < 1200, 'the certificate fix is a short second paste (' + fix.length + ' characters)');
  assert.match(fix, /\/router-roots\.pem" check-certificate=no dst-path="fiti-roots\.pem"/, 'the public roots file needs no CA to download');
  assert.doesNotMatch(fix, /X-WiFi-Fiti-Router|loc-installer-test/, 'the certificate fix sends no router credential');
  assert.match(fix, /else=\{ \/certificate remove \$c \}/, 'any certificate that does not match a pinned fingerprint is removed');
  assert.doesNotMatch(context.routerBootstrapCommand(setup, true, false, true), /router-roots/, 'the CA-compatibility command is unchanged');
  const clockFix = context.routerClockFix();
  assert.ok(clockFix.length < 900, 'the clock fix is a short paste (' + clockFix.length + ' characters)');
  assert.match(clockFix, /\/router-time" check-certificate=no output=user as-value\]->"data"\)/, 'the time is read as data, never run');
  assert.doesNotMatch(clockFix, /X-WiFi-Fiti-Router|\/import|:parse|:execute/, 'the clock fix sends no router credential and runs nothing it downloads');
  assert.match(clockFix, /:if \(\$now != \$day\) do=\{ \/system clock set date=\$day time=\[:pick \$r 11 19\]/, 'the clock is set only when the date is wrong and the reply looks like a date');
  assert.match(clockFix, /\[a-z\]\[a-z\]\[a-z\]\/\[0-3\]\[0-9\]\/20\[0-9\]\[0-9\]\\\$"\)\) do=\{ :error "bad reply" \}/, 'a reply that is not exactly a date is refused');
}
// The pinned fingerprints are exactly those of Mozilla's roots (via Node's
// trust store), so only the genuine certificates are ever trusted.
{
  const tls = require('node:tls'); const crypto = require('node:crypto');
  const pins = html.match(/var ROUTER_ROOT_PINS = \[([^\]]*)\];/)[1].match(/[0-9a-f]{64}/g);
  const expected = ['ISRG Root X1', 'ISRG Root X2', 'GTS Root R1', 'GTS Root R4'].map((cn) => new crypto.X509Certificate(tls.rootCertificates.find((pem) => new crypto.X509Certificate(pem).subject.split('\n').includes('CN=' + cn))).fingerprint256.replace(/:/g, '').toLowerCase());
  assert.deepEqual(pins, expected, 'each pin is the genuine root certificate');
}
assert.match(html, /if \(snapshot\.layout\) appendRouterLayoutBoard\(box, snapshot\.layout, location, snapshot\.plan \|\| null, snapshot\.changes \|\| \[\]\);/,
  'a universal-kit router shows its full layout on the routerboard itself');
assert.match(html, /function appendRouterLayoutBoard\(parent, layout, location, savedPlan, changes\)/);
assert.match(html, /function plannable\(item\) \{ return Boolean\(item && \(item\.free \|\| item\.movableFrom \|\| item\.shareWifi\)\); \}/, 'only free or movable parts, or a radio that can share a customer Wi-Fi, can be planned');
assert.match(html, /function quickSetupCard\(\)/, 'a router with no hotspot gets a one-step setup');
assert.match(html, /'Set up in one step'/);
assert.match(html, /stays yours for managing the router \(WinBox, connect by MAC\)/, 'one step setup keeps a port for the owner');
assert.match(html, /Your own Wi-Fi keeps working as it is/, 'and says the owner\'s Wi-Fi is left alone');
assert.match(html, /rebooted_wifi: 'The router restarted while adding the customer Wi-Fi/, 'a restart during a change is explained, not "no answer"');
assert.match(html, /function appendNetworkPlanner\(/, 'the routerboard carries the network map planner');
assert.match(html, /\/network-plan'/, 'the planner saves the map to the network-plan endpoint');
assert.match(html, /'rb-badge ' \+ state, state === 'internet' \? 'Internet' : state === 'free' \? 'Free' : state === 'movable' \? 'Movable' : 'In use'/,
  'every part says whether it is free, in use or carrying the internet');
// The "Design your portal" form overrides the global button (inline-flex)
// and input (full width, 47px tall) rules: preset buttons stack the title over
// its description, and the "Show …" choices are small checkboxes on the same
// line as their label, at every width.
{
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = html.match(new RegExp('(?:^|[}\\s])' + escaped + '\\{([^}]*)\\}', 'm'));
    assert.ok(match, selector + ' has its own rule');
    return match[1];
  };
  assert.match(rule('.portal-template-preset'), /(^|;)display:block/, 'preset buttons are blocks, not the global inline-flex row');
  assert.match(rule('.portal-template-preset strong'), /display:block/, 'the preset title sits on its own line');
  assert.match(rule('.portal-template-creator label.check'), /display:flex/);
  const checkbox = rule('.portal-template-creator label.check input');
  assert.match(checkbox, /width:20px/, 'checkboxes are not full width');
  assert.match(checkbox, /min-height:0/, 'checkboxes drop the 47px field height');
  const form = html.match(/<form id="portal-template-form"[\s\S]*?<\/form>/)[0];
  assert.equal((form.match(/<label class="check"><input name="show(?:Packages|Utilities)" type="checkbox"/g) || []).length, 2,
    'both "Show …" choices are checkboxes inside label.check');
}
// Ready-made portal designs: each sets every option, the server accepts it
// unchanged, and its accent stays readable on the white cards.
{
  const { DatabaseSync } = require('node:sqlite');
  const catalog = vm.runInNewContext(html.match(/var PORTAL_TEMPLATE_CATALOG = (\[[\s\S]*?\n {6}\]);/)[1]);
  assert.equal(catalog.length, 15, 'the gallery offers the full set of designs');
  assert.doesNotMatch(html, /Extended ready-template gallery|extendedCatalog/, 'one gallery list: no second script replaces it and doubles its buttons');
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length, 'design ids are unique');
  assert.match(html, /function chooseCatalogItem\(item\) \{[^}]*form\.elements\.fontFamily\.value = item\.fontFamily; form\.elements\.textAlign\.value = item\.textAlign; form\.elements\.packageStyle\.value = item\.packageStyle; form\.elements\.backgroundStyle\.value = item\.backgroundStyle;/,
    'Use this design sets every option, not only the layout and colour');
  const handlers = {}; const app = {}; ['get', 'post', 'patch', 'delete'].forEach((method) => { app[method] = (route, handler) => { handlers[method + ' ' + route] = handler; }; });
  require('../src/lib/tenant-portal-templates').attachTenantPortalTemplateRoutes(app, { businessAuth: () => ({ id: 'biz-catalog' }), db: new DatabaseSync(':memory:') });
  const call = (key, body) => { let status = 200; let payload; handlers[key]({ body, params: {} }, { status(code) { status = code; return this; }, json(value) { payload = value; return this; }, set() { return this; }, end() { return this; } }); return { status, payload }; };
  const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (const item of catalog) {
    for (const key of ['name', 'description', 'layout', 'accentColor', 'welcomeMessage', 'fontFamily', 'textAlign', 'packageStyle', 'backgroundStyle']) assert.ok(item[key], item.id + ' sets ' + key);
    const saved = call('post /api/business/portal-templates', Object.assign({}, item, { showPackages: true, showUtilities: true }));
    assert.equal(saved.status, 201, item.id + ' is accepted by the server: ' + JSON.stringify(saved.payload));
    for (const key of ['name', 'layout', 'accentColor', 'welcomeMessage', 'fontFamily', 'textAlign', 'packageStyle', 'backgroundStyle']) assert.equal(saved.payload.template[key], item[key], item.id + ' keeps its ' + key);
    assert.ok(1.05 / (luminance(item.accentColor) + 0.05) >= 4.5, item.id + ' accent keeps 4.5:1 contrast on white');
  }
  // "Rounded" was dropped (no rounded system font on Android): a cached
  // dashboard or an older portal that still sends it gets "modern".
  assert.notEqual(catalog.some((item) => item.fontFamily === 'rounded'), true, 'no design uses the dropped rounded font');
  assert.doesNotMatch(html, /<option value="rounded">/, 'the dashboard no longer offers Rounded');
  const roundedSave = call('post /api/business/portal-templates', { name: 'Old rounded', layout: 'classic', accentColor: '#1769D8', fontFamily: 'rounded' });
  assert.equal(roundedSave.status, 201, JSON.stringify(roundedSave.payload));
  assert.equal(roundedSave.payload.template.fontFamily, 'modern', 'a saved "rounded" is stored and shown as modern');
  assert.equal(call('post /api/business/portal-templates', { name: 'Bad font', layout: 'classic', accentColor: '#1769D8', fontFamily: 'comic' }).status, 400);
  const { portalFont } = require('../src/lib/tenant-portal-templates');
  assert.deepEqual(['rounded', '', null, 'modern', 'condensed', 'mono'].map(portalFont), ['modern', 'modern', 'modern', 'modern', 'condensed', 'mono']);
}
// Portal font stacks use only fonts that Android and iPhone ship (the portal
// loads no web fonts behind the walled garden), plus CSS generic families.
{
  const portal = fs.readFileSync(path.join(__dirname, '../public/tenant-portal.html'), 'utf8');
  const shipped = new Set([
    // generic CSS families
    'sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-monospace', '-apple-system',
    // iOS
    'Avenir Next Condensed', 'Menlo',
    // Android (fonts.xml family names, used by Chrome on Android)
    'sans-serif-condensed',
  ]);
  const stacks = [
    ...[...portal.matchAll(/body\[data-portal-font="([a-z]+)"\]\{font-family:([^;}]+)/g)].map((m) => ['portal ' + m[1], m[2]]),
    ...[...html.matchAll(/\.portal-template-preview\[data-previewfont-family="([a-z]+)"\]\{font-family:([^;}]+)/g)].map((m) => ['preview ' + m[1], m[2]]),
    ...[...portal.matchAll(/(\.utility b|\.mpesa-word|\.mpesa-button \.mpesa-label)\{[^}]*?font-family:([^;}]+)/g)].map((m) => [m[1], m[2]]),
  ];
  const kinds = stacks.map(([where]) => where);
  for (const expected of ['portal condensed', 'portal mono', 'preview condensed', 'preview mono', '.utility b', '.mpesa-word', '.mpesa-button .mpesa-label']) assert.ok(kinds.includes(expected), expected + ' has a font stack');
  assert.equal(kinds.some((where) => /rounded/.test(where)), false, 'no rounded font rule is left');
  for (const [where, stack] of stacks) {
    for (const font of stack.split(',').map((name) => name.trim().replace(/^["']|["']$/g, ''))) assert.ok(shipped.has(font), where + ': ' + font + ' is not a font Android or iPhone ships');
  }
  assert.match(portal, /document\.body\.dataset\.portalFont = template\.fontFamily === 'rounded' \? 'modern' : template\.fontFamily;/, 'the portal shows a saved rounded design as modern');
}
console.log('Business UI: focused router onboarding, mapping, and client-script safety passed.');
assert.match(html, /if \(routerBoardsShown\[boardKey\]\) \{ board\.classList\.add\('rb-settled'\);/, 'redraws do not replay the routerboard entrance motion');
assert.match(html, /\.router-map\.rb-settled,\.rb-settled \.router-port,\.rb-settled \.rb-net/);
assert.match(html, /\/network-plan\/apply', \{ method: 'POST', body: JSON\.stringify\(\{ confirm: true \}\) \}/, 'applying sends an explicit confirmation');
assert.match(html, /tick\.addEventListener\('change', function \(\) \{ go\.disabled = !tick\.checked; \}\);/, 'Apply stays disabled until the owner ticks that they read the changes');
assert.match(html, /undo\.textContent = 'Tap again to undo'/, 'undo needs a second tap');
assert.match(html, /if \(bridge\.job !== job && \/\^fiti-\(hotspot\|pppoe\)\(-\\d\+\)\?\$\/\.test\(bridge\.name\)\) \{ bridge\.name = ''; bridge\.name = freshName\(job\); \}/, 'switching a job renames a default bridge name, never one the owner typed');
assert.match(html, /\/network-changes\/' \+ encodeURIComponent\(change\.id\) \+ '\/rename'/, 'a Wi-Fi Fiti bridge can be renamed from the dashboard');
assert.match(html, /function appendPatienceCard\(parent, options\)/, 'every setup wait uses one guided waiting card');
assert.match(html, /title: 'Connecting your router'/, 'pairing says what is happening while the router connects');
assert.match(html, /title: 'Reading your router'/, 'the first layout report has a reassuring wait');
assert.match(html, /'Router checks and applies it', 'Router confirms it is still online', 'Final check of its report'/, 'a change in flight shows its steps');
assert.match(html, /If anything goes wrong, the router puts everything back by itself\./, 'owners are told a failed change is undone automatically');
assert.match(html, /savedKit && savedKit\.token/, 'the pairing card only appears once a kit exists');
assert.match(html, /add\(reserveCopy, 'strong', '', 'Reserve a port for management'\)/, 'the map offers a visible card to reserve a port for management');
assert.match(html, /!home\(item\.name\) && item\.free && !item\.movableFrom; \}\);/, 'only a truly free port can be reserved, never one carrying customers');
assert.match(html, /The router is working on it now; follow it under Changes on the router above\./, 'the saved-map note never says nothing changed while a change runs');
assert.match(html, /var busyOnRouter = \(changes \|\| \[\]\)\.some\(function \(c\) \{ return \/\^\(queued\|sent\|confirming\|applied\|undo-queued\|undo-sent\)\$\/\.test\(c\.status\); \}\);/, 'Review and apply stays hidden until the change is settled');
assert.match(html, /low_memory: 'The router is short of memory/);
assert.match(html, /if \(document\.visibilityState === 'hidden'\) \{ changeFollowTimer = setTimeout\(followChange, 3000\); return; \}/, 'a background tab postpones following a change, never stops it');
assert.match(html, /if \(plannerInUse\(\)\) \{ if \(!changeFollowTimer\) changeFollowTimer = setTimeout\(followChange, 3000\); \}/, 'editing the map postpones following a change, never stops it');
assert.match(html, /startedAt: undoing \? \(inFlight\.updatedAt \|\| inFlight\.createdAt\) : inFlight\.createdAt/, 'an undo is timed from when it started');
assert.match(html, /var ended = \/\^\(failed\|reverted\|cancelled\|no-answer\|undone\)\$\/;/, 'a saved bridge whose change failed or was undone is dropped, so the one-step setup comes back');
assert.match(html, /var hotspotTaken = Boolean\(running\) \|\| draftHas\('hotspot'\);/, 'a second hotspot bridge is not offered');
assert.match(html, /addHotspot\.disabled = hotspotTaken;/);
assert.match(html, /'Add Wi-Fi to it below instead of a second one\.' : 'Use it for hotspot customers \(Use an existing bridge\) instead of adding a second one\.'/);
assert.match(html, /entry\.wifi = \{ ssid: defaultSsid\(\), radio: it\.name \};/, 'Wi-Fi can be added to a hotspot that already runs');
assert.match(html, /undo removes only the Wi-Fi\./);
assert.match(html, /hotspot_missing: 'The hotspot is no longer running on that bridge/);
assert.match(html, /<select aria-label="Analytics location"><option value="">All routers<\/option><\/select>/, 'All routers sends no location filter'); assert.match(html, /<select id="customers-location" aria-label="Customer location"><option value="">All routers<\/option><\/select>/, 'All routers shows every customer');
// Go live (stage 4): one card from a set-up router to the first paying customer.
assert.match(html, /function appendGoLive\(parent, location, options\)/);
assert.match(html, /'\/api\/business\/locations\/' \+ encodeURIComponent\(locationId\) \+ '\/go-live'/, 'the card reads the same checks a purchase uses');
assert.match(html, /api\('\/api\/business\/packages\/starter', \{ method: 'POST', body: '\{\}' \}\)/, 'starter packages in one tap');
assert.match(html, /if \(snapshot\.layout && \(snapshot\.layout\.hotspots \|\| \[\]\)\.length\) appendGoLive\(box, location, \{ finish: true \}\);/, 'shown on the map once a hotspot runs');
assert.match(html, /'golive-finish'[\s\S]{0,300}Go to my dashboard[\s\S]{0,300}completeOnboarding\(onboardingModel\(\)\)/, 'the map ends with a way to the dashboard');
assert.match(html, /s\.error === 'needs_permission'/, 'an older kit is told to paste the kit again');
assert.match(html, /The file holds your router passwords/, 'backup warning');
assert.match(html, /input\.value = toolCustomerInput/, 'the customer box keeps its text while the page refreshes');
assert.match(html, /el\('button', '', 'Router map'\)[\s\S]{0,300}openRouterMap\(location\)/, 'every universal router has a Router map button on the Routers page');
assert.match(html, /model\.mappingConfirmed && onboardingFlowState\(model\)\.active && !\(model\.location && model\.location\.router_kit === 'universal'\)/, 'an open universal map is not closed under the owner');
assert.match(html, /model\.needsRouterMapping \|\| universalMapOpen\(model\)/, 'an open map keeps refreshing');
assert.match(html, /renderOverviewInsights\(\); (?:if \(can\('routers\.view'\)\) )?renderGoLiveOverview\(\);/, 'and on Overview');
assert.match(html, /\}, busy \? 5000 : 20000\);/, 'fast only while a purchase is happening');
assert.match(html, /if \(document\.visibilityState === 'hidden'\) \{ scheduleGoLive\(\); return; \}/, 'no checks from a hidden tab');
assert.match(html, /localStorage\.setItem\('fiti_golive_done:' \+ id, '1'\)/, 'the celebration shows once');
// Map: adopt an owner's hotspot, PPPoE on a VLAN, Wi-Fi channel.
assert.match(html, /'Bill this hotspot with Wi-Fi Fiti'/, 'an owner\'s own hotspot can be billed as it is');
assert.match(html, /String\(location\.router_setup_health \|\| ''\) === 'awaiting-map'/, 'offered only while Wi-Fi Fiti is not billing it yet');
assert.match(html, /adopt: e\.adopt \? true : undefined/, 'a saved adoption survives a redraw');
assert.match(html, /function appendWifiOptions\(panel, radioItem, wifi\)/);
assert.match(html, /if \(!radioItem \|\| radioItem\.shareWifi \|\| !WIFI_CHANNELS\[radioItem\.band\]\) return;/, 'a channel only for a radio Wi-Fi Fiti takes over, with a known band');
assert.match(html, /add\(more, 'summary', '', 'More Wi-Fi options'\)/);
assert.match(html, /login_backup_failed: /);
// Router tools page.
assert.match(html, /\{ id: 'tools', label: 'Router tools', sections: \['tools-section'\] \}/, 'Router tools is a part of the Routers page');
assert.match(html, /\{ tool: 'reboot', title: 'Restart the router'/);
assert.match(html, /if \(card\.danger && !go\.dataset\.armed\) \{ go\.dataset\.armed = '1'; go\.textContent = 'Tap again to restart';/, 'a restart needs two taps');
assert.match(html, /section\.offsetParent === null \|\| document\.visibilityState === 'hidden'\) \{ scheduleTools\(\); return; \}/, 'no checks from a hidden page');
assert.match(html, /box\.classList\.add\('kit-console'\)/, 'the connection kit is shown as one console');
assert.match(html, /\.sequential-onboarding \.overview-controls\{display:none!important\}/, 'overview filters stay out of the setup guide');
assert.match(html, /add\(wifiCopy, 'strong', '', radiosIn\.length \? 'Customer Wi-Fi' : 'Add Wi-Fi to this hotspot'\)/, 'every hotspot bridge shows its Wi-Fi panel');
assert.match(html, /'Wi-Fi can only join a hotspot bridge\. PPPoE customers connect by cable\.'/, 'a radio dropped on a PPPoE bridge is refused with a reason');
assert.match(html, /goes\.textContent = item\.shareWifi \? '📶 can add a separate customer Wi-Fi' : '📶 can broadcast customer Wi-Fi'/, 'free radios say they can broadcast customer Wi-Fi');
assert.match(html, /var radioHint = isRadio\(item\) && \(item\.free \|\| item\.shareWifi\)/, 'a radio already in a Wi-Fi Fiti bridge is not offered again');
// Step 2 for a router that paired and then went quiet (for example during
// step 3): it is offline, so say what to check instead of "correct a setting".
{
  for (const name of ['routerPairingPending', 'routerSuccessfullyPaired', 'routerSyncHealthy', 'routerWentQuiet', 'routerHealthLabel', 'appendConnectionState']) {
    const declaration = html.match(new RegExp('      function ' + name + '\\([^]*?(?=\\n      function |\\n    \\}\\)\\(\\);)'));
    assert.ok(declaration, name + ' is available to exercise');
    vm.runInContext(declaration[0], context);
  }
  const stateCard = (location) => {
    const body = new TestElement('div');
    context.appendConnectionState(body, { location, paired: context.routerSuccessfullyPaired(location),
      syncHealthy: context.routerSyncHealthy(location), freshKitRequired: false });
    return descendants(body).map((node) => node.textContent).filter(Boolean).join(' | ');
  };
  const quiet = { id: 'loc-quiet', router_kit: 'universal', last_successful_sync_at: '2026-09-29 08:00:00', router_status: 'offline',
    router_sync_healthy: false, router_setup_health: 'awaiting-map' };
  const offlineText = stateCard(quiet);
  assert.match(offlineText, /Router is offline/);
  assert.match(offlineText, /has power and that the internet cable is in its WAN port/);
  assert.match(offlineText, /then wait a minute\. It reconnects by itself/);
  assert.doesNotMatch(offlineText, /needs attention|Correct the router setting|map its network next/, 'an offline router is not told to correct a setting');
  // A router that still polls but reports a real fault keeps that message.
  assert.match(stateCard({ ...quiet, id: 'loc-faulty', router_status: 'online', router_setup_health: 'hotspot-missing' }),
    /Router setup needs attention \| Hotspot missing\. Correct the router setting/);
  // "Paired · map its network next" is a status, not a fault.
  assert.doesNotMatch(stateCard({ ...quiet, id: 'loc-waiting', router_status: 'online' }), /needs attention/);
  // No "Generate connection kit" above the offline card: the router needs no
  // new kit. Starting setup again (fresh kit required) still offers one.
  // The kit form needs a little more DOM than the tiny one offers.
  class FormElement extends TestElement {
    constructor(tag) { super(tag); this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } }; }
    querySelectorAll() { return []; }
  }
  const kitArea = (location, freshKitRequired) => {
    const body = new TestElement('div'); const createElement = context.document.createElement;
    context.document.createElement = (tag) => new FormElement(tag);
    try { context.appendSimpleRouterSetup(body, { location, business: {}, freshKitRequired }); }
    finally { context.document.createElement = createElement; }
    return descendants(body).map((node) => node.textContent).filter(Boolean).join(' | ');
  };
  assert.doesNotMatch(kitArea(quiet, false), /Generate connection kit|Create the connection kit|Copy connection kit/);
  assert.match(kitArea({ ...quiet, id: 'loc-quiet-online', router_status: 'online' }, false), /Generate connection kit/,
    'a router that is not offline keeps the kit form');
  assert.match(kitArea(quiet, true), /Generate connection kit/, 'starting setup again still makes a kit');
  assert.match(html, /routerWentQuiet\(model\.location\) \? 'Router offline'/, 'the step 2 badge says the router is offline');
}
// The dashboard's portal preview shows "Lipa na PayBill" by the portal's
// rule: only an active C2B PayBill, which customers see at its own location.
{
  const previewContext = vm.createContext({});
  vm.runInContext(html.match(/      function portalPreviewPayBill\([^]*?(?=\n      function )/)[0], previewContext);
  const locations = [{ id: 'loc-a', name: 'Kitale Main' }, { id: 'loc-b', name: 'Sirende' }];
  const none = previewContext.portalPreviewPayBill(undefined, locations);
  assert.equal(none.paybill, null, 'no PayBill tile before integrations load or without a PayBill');
  assert.match(none.note, /once you register a PayBill under Payment integrations/);
  assert.equal(previewContext.portalPreviewPayBill({ c2b: { configured: false, setting: null } }, locations).paybill, null);
  assert.equal(previewContext.portalPreviewPayBill({ c2b: { setting: { locationId: 'loc-b', shortcode: '600555', active: false } } }, locations).paybill, null,
    'a paused PayBill is not shown');
  const active = previewContext.portalPreviewPayBill({ c2b: { setting: { locationId: 'loc-b', shortcode: '600555', accountPrefix: 'WF', active: true } } }, locations);
  assert.deepEqual({ ...active.paybill }, { shortcode: '600555', accountPrefix: 'WF' });
  assert.equal(active.note, 'Lipa na PayBill (600555) shows only at Sirende.');
  assert.match(html, /var payBill = portalPreviewPayBill\(state\.integrations, state\.workspace && state\.workspace\.locations\); previewConfig\.paybill = payBill\.paybill;/,
    'the preview sends the PayBill to the portal preview');
  assert.match(html, /if \(typeof refreshPortalPreview === 'function'\) refreshPortalPreview\(\);/, 'the preview follows a PayBill saved later');
}
// "Back to workspace" works before the first router exists: leaving stays
// left (in this tab), and the overview offers "Add your first router".
{
  const progress = new Map();
  const flowContext = vm.createContext({ sessionStorage: { getItem: (key) => progress.get(key) ?? null, setItem: (key, value) => progress.set(key, value) } });
  for (const name of ['onboardingProgressKey', 'readOnboardingProgress', 'saveOnboardingProgress', 'onboardingMaximumStage', 'onboardingFlowState']) {
    vm.runInContext(html.match(new RegExp('      function ' + name + '\\([^]*?(?=\\n      function )'))[0], flowContext);
  }
  const noRouter = { business: { id: 'biz-new' }, configured: false, syncHealthy: false };
  assert.equal(flowContext.onboardingFlowState(noRouter).active, true, 'a new owner starts in the setup guide');
  flowContext.saveOnboardingProgress(noRouter.business, { active: false, stage: 1, unlocked: 1 });
  assert.equal(flowContext.onboardingFlowState(noRouter).active, false, 'Back to workspace leaves the guide with no router');
  flowContext.saveOnboardingProgress(noRouter.business, { active: true, stage: 1, unlocked: 1 });
  assert.equal(flowContext.onboardingFlowState(noRouter).active, true, 'Add your first router re-enters it');
  assert.match(html, /noRouter \? 'NO ROUTER YET'/);
  assert.match(html, /if \(noRouter\) \{ setupAction\(compactActions, 'Add your first router', '', function \(\) \{ startNewOnboardingFlow\(model\.business\); setTimeout\(openRouterDraftModal, 0\); \}\);/);
}
// Portal templates load once when their page opens: not also at sign-in, and
// not again on each workspace refresh while the page stays open.
assert.doesNotMatch(html, /if \(token\) reloadPortalTemplates\(\);/, 'no second load at sign-in');
assert.match(html, /if \(requested === 'portal-templates'\) \{ if \(!portalTemplatesOpen && token && reloadPortalTemplates\) reloadPortalTemplates\(\); portalTemplatesOpen = true; \} else portalTemplatesOpen = false;/);
console.log('Business UI: step 2 offline card, leaving setup without a router, and one portal template load passed.');

// Real data instead of placeholders: CSV exports, the support hub search,
// Account & limits and the router card.
{
  assert.doesNotMatch(html, /No records yet|No records available for this report|Search is ready/, 'no export or search returns made-up rows');
  assert.doesNotMatch(html, /<div class="metric-label">Router limit<\/div><div class="metric-value">1<\/div>/, 'the router limit is not fixed text');
  assert.doesNotMatch(html, /Active users<\/div><div class="metric-value">0<\/div>|CPU load<\/div><div class="metric-value">0%<\/div>|Memory usage<\/div><div class="metric-value">0%<\/div>/, 'the router card shows no made-up numbers');
  assert.doesNotMatch(html, /Login rate<\/div><div class="metric-value">0%<\/div>|Expired today<\/div><div class="metric-value">0<\/div>/, 'the support numbers are not fixed text');
  assert.match(html, /api\('\/api\/business\/support\/search\?q=' \+ encodeURIComponent\(query\)\)/, 'the support hub searches on the server');
  assert.match(html, /https:\/\/wa\.me\/254718016683\?text=/, 'the setup guide links to the right WhatsApp number');
  // The wrong number (one digit too many) is gone from the whole repository.
  const root = path.join(__dirname, '..');
  const wrong = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.claude'].includes(entry.name) || entry.name === 'changes.diff') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.statSync(full).size < 5e6 && fs.readFileSync(full, 'utf8').includes('2547180166' + '833')) wrong.push(path.relative(root, full));
    }
  }(root));
  assert.deepEqual(wrong, [], 'the wrong WhatsApp number is gone');

  const nodes = new Map();
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.className = ''; this.style = {}; this.classList = { add() {}, remove() {} }; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren() { this.children = []; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener() {}
  }
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const text = (node) => [node.textContent, ...node.children.map(text)].join(' ');
  const ui = vm.createContext({
    document: { createElement: (tag) => new Node(tag), createTextNode: (value) => ({ tagName: '#text', textContent: value, children: [] }) },
    $: (id) => { if (!nodes.has(id)) nodes.set(id, new Node('div')); return nodes.get(id); },
    state: {}, analyticsSnapshot: null,
  });
  for (const name of ['el', 'add', 'clear', 'plural', 'kes', 'duration', 'when', 'maskedPhone', 'isActive', 'statusClass', 'analyticsDuration',
    'voucherStatus', 'voucherStatusLabel', 'voucherDuration', 'filteredVouchers', 'csvCell', 'buildCsv', 'csvFileName', 'textMatches', 'filteredPackages',
    'salesMatches', 'filteredTransactions', 'customerActive', 'filteredCustomers', 'txExportRow', 'exportRows', 'supportTimeLeft', 'supportCard',
    'renderSupportResults', 'renderAccountLimits', 'reading', 'routerCardValues']) {
    const declaration = html.match(new RegExp('      function ' + name + '\\([^]*?(?=\\n      function |\\n      var |\\n    \\}\\)\\(\\);)'));
    assert.ok(declaration, name + ' is available to exercise');
    vm.runInContext(declaration[0], ui);
  }
  for (const name of ['VOUCHER_STATUS', 'VOUCHER_BADGE', 'TX_EXPORT_HEADER']) vm.runInContext(html.match(new RegExp('      var ' + name + ' = [^\\n]*'))[0], ui);

  // CSV: quotes, commas and newlines are escaped; formulas stay plain text.
  assert.equal(ui.buildCsv([['a,b', 'say "hi"', 'line 1\nline 2'], ['=SUM(A1)', '+254712', '-cmd', '@x', '\tt', '\rr', -5, 12.5, null, undefined, 'plain']]),
    '"a,b","say ""hi""","line 1\nline 2"\r\n"\'=SUM(A1)","\'+254712","\'-cmd","\'@x","\'\tt","\'\rr","-5","12.5","","","plain"\r\n');
  assert.equal(ui.csvFileName('customers', new Date(2026, 8, 9)), 'wifi-fiti-customers-2026-09-09.csv', 'the file name carries the date');

  // Every export: header only when there are no rows, never a fake row.
  for (const kind of ['packages', 'sales', 'transactions', 'analytics', 'vouchers', 'customers']) {
    const rows = ui.exportRows(kind);
    assert.equal(rows.length, 1, kind + ' with no data exports just its header');
    assert.ok(rows[0].length > 3 && rows[0].every((cell) => typeof cell === 'string' && cell), kind + ' has a header row');
  }

  // Exports hold the real rows and follow the page's filters.
  ui.state.workspace = { packages: [{ name: '1 hour', price: 20, seconds: 3600, active: 1 }, { name: 'Day pass', price: 50, seconds: 86400, active: 0, rate_limit: '2M/2M' }] };
  ui.state.dashboard = { transactions: [
    { checkout_request_id: 'ws_1', created_at: '2026-09-29 08:00:00', location_name: 'Kitale', phone: '254722333444', mac: 'AA:01', package_name: '1 hour', amount: 20, status: 'paid', payment_source: 'fiti', mpesa_receipt: 'SGR1' },
    { checkout_request_id: 'ws_2', created_at: '2026-09-29 09:00:00', location_name: 'Sirende', phone: '254733000111', mac: 'AA:02', package_name: '=HYPERLINK("x")', amount: 50, status: 'failed', payment_source: 'fiti', result_desc: 'Cancelled, by user' }] };
  ui.state.customers = [
    { location_id: 'loc-1', location_name: 'Kitale', payer_phone: '254722333444', mac: 'AA:01', router_username: 'u1', has_time: 1, is_active: 1, used_seconds: 600, expires_at: '2026-09-29 10:00:00' },
    { location_id: 'loc-2', location_name: 'Sirende', payer_phone: '254733000111', mac: 'AA:02', router_username: 'u2', has_time: 0, is_active: 0, used_seconds: 3600, expires_at: '2026-09-28 10:00:00' }];
  ui.state.vouchers = [{ code: 'FITI01', location_id: 'loc-1', location_name: 'Kitale', package_name: '1 hour', seconds: 3600, status: 'open' }, { code: 'FITI02', location_id: 'loc-1', location_name: 'Kitale', package_name: '1 hour', seconds: 3600, status: 'used', redeemed_by: '254722333444', redeemed_at: '2026-09-29 08:30:00' }];
  ui.analyticsSnapshot = { report: [{ created_at: '2026-09-29 08:00:00', location_name: 'Kitale', phone: '254722333444', amount: 20, status: 'paid' }] };
  assert.deepEqual(plain(ui.exportRows('packages').slice(1)), [['1 hour', 20, '1 hour', 'Router default', 'Active'], ['Day pass', 50, '1 day', '2M/2M', 'Paused']]);
  ui.$('packages-status-filter').value = 'paused';
  assert.deepEqual(plain(ui.exportRows('packages').slice(1).map((row) => row[0])), ['Day pass'], 'the package status filter applies');
  assert.equal(ui.exportRows('transactions').length, 3);
  ui.$('transactions-status').value = 'failed';
  const failed = ui.exportRows('transactions');
  assert.deepEqual(plain(failed.slice(1).map((row) => row[9])), ['ws_2'], 'the transaction status filter applies');
  assert.match(ui.buildCsv(failed), /"'=HYPERLINK\(""x""\)"/, 'a formula in a package name is neutralised');
  assert.match(ui.buildCsv(failed), /"Cancelled, by user"/);
  ui.$('sales-search').value = 'sgr1';
  assert.deepEqual(plain(ui.exportRows('sales').slice(1).map((row) => row[9])), ['ws_1'], 'the sales search applies');
  ui.$('customers-location').value = 'loc-2';
  assert.deepEqual(plain(ui.exportRows('customers').slice(1)), [['254733000111', 'AA:02', 'Sirende', 'u2', 'Expired', '1h 0m', '2026-09-28 10:00:00']], 'the customer location filter applies');
  ui.$('customers-location').value = ''; ui.$('customers-status').value = 'active';
  assert.deepEqual(plain(ui.exportRows('customers').slice(1).map((row) => row[0])), ['254722333444'], 'the customer status filter applies');
  ui.$('vm-status').value = 'used';
  assert.deepEqual(plain(ui.exportRows('vouchers').slice(1)), [['FITI02', 'Kitale', '1 hour', 60, null, 'Used up', '254722333444', '2026-09-29 08:30:00']], 'the voucher filters apply');
  assert.equal(ui.exportRows('analytics').length, 2);
  // Payouts are not shown yet, so there is no payout export either.
  assert.equal(ui.exportRows('disbursements'), null);

  // Support hub results: plain text, masked phones, time left, statuses.
  const results = new Node('div');
  const count = ui.renderSupportResults(results, { query: '0722333444',
    customers: [{ payer_phone: '254722333444', mac: 'AA:01', location_name: 'Kitale', package_name: '1 hour', seconds_left: 1500, expires_at: '2026-09-29 10:00:00' }],
    payments: [{ phone: '254722333444', package_name: '<b>1 hour</b>', location_name: 'Kitale', status: 'paid', mpesa_receipt: 'SGR1', switched_on_at: null, amount: 20, created_at: '2026-09-29 08:00:00' }],
    vouchers: [{ code: 'FITI01', package_name: '1 hour', location_name: 'Kitale', status: 'active', seconds_left: 600, redeemed_by: '254722333444', redeemed_at: '2026-09-29 08:30:00' }] });
  assert.equal(count, 3);
  const shown = text(results);
  assert.match(shown, /•••• 3444 · 1 hour/); assert.doesNotMatch(shown, /254722333444/, 'phones are masked as elsewhere on the dashboard');
  assert.match(shown, /25m left/); assert.match(shown, /Receipt SGR1 · Paid, not switched on yet/); assert.match(shown, /FITI01 · 1 hour/); assert.match(shown, /In use/); assert.match(shown, /10m left/);
  assert.match(shown, /<b>1 hour<\/b>/, 'names are shown as text, never as HTML');
  const none = new Node('div');
  assert.equal(ui.renderSupportResults(none, { query: 'SGR9', customers: [], payments: [], vouchers: [] }), 0);
  assert.match(text(none), /Nothing found/);

  // Account & limits from the workspace data.
  ui.state.vouchers = [{}, {}];
  ui.state.workspace = { business: { billing_status: 'trial' }, services: { trial: { active: true, endsAt: '2026-10-05T10:00:00Z' }, hotspot: { status: 'none' }, pppoe: { status: 'none' }, legacy: { status: 'none' } },
    serviceUsage: { hotspot: { used: 3, capacity: 0 }, pppoe: { used: 1, capacity: 0 } }, trialLimits: { maxPackagePriceKes: 3, maxPackages: 3, maxPackageHours: 24, maxVouchers: 5, maxPppoeUsers: 2, maxHotspotUsers: 10 },
    routerLimit: 1, locations: [{ router_status: 'online' }], packages: [{}, {}] };
  ui.renderAccountLimits();
  const value = (id) => [nodes.get(id).textContent, nodes.get(id + '-foot').textContent];
  assert.equal(value('account-plan')[0], 'Free trial'); assert.match(value('account-plan')[1], /^Ends /);
  assert.deepEqual(value('account-routers'), ['1 of 1', 'Free trial: 1 router']);
  assert.deepEqual(value('account-hotspot'), ['3 of 10', 'With time now · free trial limit']);
  assert.deepEqual(value('account-packages'), ['2 of 3', 'Free trial: up to KES 3, 24 h each']);
  assert.deepEqual(value('account-vouchers'), ['2 of 5', 'Free trial limit']);
  assert.deepEqual(value('account-pppoe'), ['1 of 2', 'Active · free trial limit']);
  ui.state.workspace = { business: { billing_status: 'trial' }, services: { trial: { active: false, endsAt: '2026-09-20T10:00:00Z' }, hotspot: { status: 'active', expiresAt: '2026-10-20T10:00:00Z' }, pppoe: { status: 'none' }, legacy: { status: 'none' } },
    serviceUsage: { hotspot: { used: 40, capacity: 100 }, pppoe: { used: 0, capacity: 0 } }, trialLimits: null, routerLimit: null, locations: [{}, {}, { router_status: 'offboarding' }], packages: [{}] };
  ui.renderAccountLimits();
  assert.equal(value('account-plan')[0], 'Hotspot'); assert.match(value('account-plan')[1], /^Hotspot paid to /);
  assert.deepEqual(value('account-routers'), ['2', 'No router limit'], 'routers are unlimited once hotspot is paid');
  assert.deepEqual(value('account-hotspot'), ['40 of 100', 'With time now · paid for 100']);
  assert.deepEqual(value('account-packages'), ['1', 'No package limit']);

  // Router card readings: empty, missing or non-numeric is no reading; 0 is 0.
  assert.deepEqual(['', '  ', null, undefined, 'n/a', true, '0', 0, '12.5', 40].map(ui.reading), [null, null, null, null, null, null, 0, 0, 12.5, 40]);
  const card = (result, online = true) => plain(ui.routerCardValues(result, online));
  const checkIn = { at: '2026-09-29 08:00:00', customersOnline: 3, routerosVersion: '7.24.2', board: 'hAP_lite', layoutAt: '2026-09-29 07:55:00' };
  const atCheckIn = 'From the last check-in · ' + ui.when(checkIn.at);
  // Nothing at all yet.
  assert.deepEqual(card({ latest: null, health: null, checkIn: null }).cards.map((item) => item.value), ['—', '—', '—', '—']);
  assert.equal(card({ latest: null, health: null, checkIn: null }).details, '');
  // Only check-ins: customers online and router details, labelled as such; the rest waits for Router health.
  const fromCheckIn = card({ latest: null, health: null, checkIn });
  assert.deepEqual(fromCheckIn.cards[1], { value: '3', foot: atCheckIn });
  assert.deepEqual(fromCheckIn.cards.map((item) => item.value), ['—', '3', '—', '—']);
  assert.equal(fromCheckIn.cards[2].foot, 'Run Router health in Router tools');
  assert.equal(fromCheckIn.details, 'From the last check-in: RouterOS 7.24.2 · Board hAP_lite');
  assert.equal(card({ latest: null, health: null, checkIn: { ...checkIn, customersOnline: 0, routerosVersion: null, board: null } }).cards[1].value, '0', 'no customers online is 0, not a dash');
  assert.equal(card({ latest: null, health: null, checkIn: { ...checkIn, routerosVersion: null, board: null } }).details, '', 'an older kit sends no RouterOS or board');
  const offline = card({ latest: null, health: null, checkIn }, false);
  assert.deepEqual(offline.cards[0], { value: 'Offline', foot: 'Router is not checking in · last ' + ui.when(checkIn.at) });
  // A Router health result takes over and says so.
  const health = { cpu: 12, freeMemory: 16 * 1048576, totalMemory: 64 * 1048576, uptime: '3d4h', hotspotUsers: 4, at: '2026-09-29 09:00:00' };
  const fromHealth = card({ latest: null, health, checkIn });
  const healthFoot = 'From Router health · ' + ui.when(health.at);
  assert.deepEqual(fromHealth.cards, [{ value: '3d4h', foot: healthFoot }, { value: '4', foot: healthFoot }, { value: '12.0%', foot: healthFoot }, { value: '75.0%', foot: healthFoot }]);
  // Empty CPU: a dash, never 0%. A real 0 is 0%.
  for (const empty of ['', null, undefined, 'n/a']) {
    const blank = card({ latest: null, health: { ...health, cpu: empty, hotspotUsers: empty }, checkIn });
    assert.deepEqual(blank.cards[2], { value: '—', foot: 'Router health gave no reading · ' + ui.when(health.at) }, 'empty CPU ' + JSON.stringify(empty));
    assert.deepEqual(blank.cards[1], { value: '3', foot: atCheckIn }, 'no customer count in the health check: the last check-in fills in');
  }
  assert.equal(card({ latest: null, health: { ...health, cpu: 0 }, checkIn }).cards[2].value, '0.0%');
  assert.equal(card({ latest: null, health: { ...health, cpu: '0' }, checkIn }).cards[2].value, '0.0%');
  assert.equal(card({ latest: null, health: { ...health, freeMemory: '' }, checkIn }).cards[3].value, '—', 'empty memory is a dash too');
  // The kit's own telemetry, when newer than the health check.
  const latest = { cpu_percent: '', total_memory: 1000, free_memory: 250, active_users: 7, uptime_seconds: 90000, recorded_at: '2026-09-29 10:00:00' };
  const fromTelemetry = card({ latest, health, checkIn });
  assert.deepEqual(fromTelemetry.cards.map((item) => item.value), ['1d 1h', '7', '—', '75.0%']);
  assert.equal(fromTelemetry.cards[0].foot, 'From the router’s report · ' + ui.when(latest.recorded_at));
  assert.equal(fromTelemetry.cards[2].foot, 'Not in the router’s report · ' + ui.when(latest.recorded_at));
  assert.equal(card({ latest: { ...latest, cpu_percent: 0 }, health: null, checkIn: null }).cards[2].value, '0.0%');
  assert.match(html, /details\.textContent = values\.details/, 'check-in details are set as text');
  assert.doesNotMatch(html, /s\.cpu != null \? s\.cpu \+ '%'/, 'Router tools shows a dash for an empty CPU reading too');
  console.log('Business UI: real exports, support search results and Account & limits passed.');
}

// Settings → Receipts and Customers → Contact Wi-Fi Fiti support, drawn by the
// page's own helpers in the tiny DOM. Text only, never HTML.
{
  const calls = [];
  const help = vm.createContext({
    document: { createElement: tag => new TestElement(tag) },
    downloadPlanReceipt: (record) => calls.push(['download', record.checkout_request_id]),
    openSupportTicket: (id) => calls.push(['open', id]),
  });
  for (const name of ['el', 'add', 'clear', 'kes', 'when', 'planReceiptLabel', 'supportTicketStatus', 'helpEmpty', 'drawPlanReceipts', 'drawSupportTickets', 'drawSupportThread']) {
    const declaration = html.match(new RegExp('      function ' + name + '\\([^]*?(?=\\n      function |\\n      // |\\n      var |\\n    \\}\\)\\(\\);)'));
    assert.ok(declaration, name + ' is available to exercise');
    vm.runInContext(declaration[0], help);
  }
  const texts = root => descendants(root).map(node => node.textContent).filter(Boolean);
  const receipts = new TestElement('div');
  help.drawPlanReceipts(receipts, [], false);
  assert.ok(texts(receipts).includes('No plan receipts yet'), 'no receipts: a plain empty message');
  help.drawPlanReceipts(receipts, [{ checkout_request_id: 'ws_CO_1', plan: 'services-hotspot', amount: 1000, mpesa_receipt: 'TST123', paid_at: '2026-09-01 10:00:00', expires_at: '2026-10-01 10:00:00' }], false);
  assert.ok(texts(receipts).includes('Hotspot users · KES 1,000'), 'a receipt names what was paid for, in plain words');
  assert.ok(texts(receipts).some(text => /^Paid .* · Valid until .* · M-Pesa TST123$/.test(text)), 'a receipt shows when it was paid, how long it lasts and the M-Pesa code');
  const download = descendants(receipts).find(node => node.tagName === 'button');
  assert.equal(download.textContent, 'Download receipt');
  download.listeners.click(); assert.deepEqual(calls.pop(), ['download', 'ws_CO_1'], 'Download receipt downloads that receipt');
  help.drawPlanReceipts(receipts, [{ checkout_request_id: 'ws_CO_2', plan: 'sms-7', amount: 200 }], true);
  assert.equal(descendants(receipts).filter(node => node.textContent === 'Download receipt').length, 2, 'Show more adds to the list');
  assert.equal(help.planReceiptLabel('services-pppoe'), 'PPPoE + Static IP users');
  assert.equal(help.planReceiptLabel('sms-12'), 'SMS credits');
  assert.equal(help.planReceiptLabel('tuma_fee'), 'Tuma fee');
  assert.equal(help.planReceiptLabel(''), 'Wi-Fi Fiti payment');
  assert.equal(help.planReceiptLabel('constructor'), 'Constructor', 'object keys are not plan names');

  const tickets = new TestElement('div');
  help.drawSupportTickets(tickets, [], false);
  assert.ok(texts(tickets).includes('No questions yet'));
  help.drawSupportTickets(tickets, [{ id: 'ticket-1', subject: '<b>Paid but offline</b>', status: 'in_progress', location_name: null, updated_at: '2026-09-02 08:00:00' }], false);
  assert.ok(texts(tickets).includes('<b>Paid but offline</b>'), 'a subject is shown as text');
  assert.ok(texts(tickets).some(text => /^In progress · All my routers · Updated /.test(text)), 'the status is in plain words');
  descendants(tickets).find(node => node.textContent === 'Read replies').listeners.click();
  assert.deepEqual(calls.pop(), ['open', 'ticket-1'], 'Read replies opens that ticket');

  const thread = new TestElement('div');
  help.drawSupportThread(thread, { ticket: { id: 'ticket-1', subject: 'Paid but offline', status: 'resolved', location_name: 'Kitale' }, messages: [
    { author: 'operator', body: 'A customer paid.', created_at: '2026-09-02 08:00:00' }, { author: 'admin', body: 'Fixed now.', created_at: '2026-09-02 09:00:00' }] });
  assert.ok(texts(thread).includes('Resolved · Kitale'));
  assert.ok(texts(thread).some(text => /^You · /.test(text)) && texts(thread).some(text => /^Wi-Fi Fiti support · /.test(text)), 'each message says who wrote it');
  assert.ok(texts(thread).includes('Fixed now.'));
  assert.ok(descendants(thread).some(node => node.tagName === 'textarea' && node.required && node.maxLength === 4000), 'the owner can reply');
  assert.ok(descendants(thread).some(node => node.textContent === 'Send reply' && node.type === 'submit'));
}
assert.match(html, /<section class="section" id="receipts-section">[^\n]*Plan receipts[^\n]*not tax invoices/, 'the receipts part says receipts are not tax invoices');
assert.match(html, /<section class="section" id="support-section"[^\n]*\n        <section class="section" id="support-tickets-section">[^\n]*<h2>Contact Wi-Fi Fiti support<\/h2>[^\n]*You won't get an SMS or email, so check back here\.[^\n]*<form id="ticket-form">/, 'the support-ticket screen sits under Customers, next to Support search, and says replies come here only');
for (const value of ['payment', 'connection', 'router', 'billing', 'other']) assert.match(html, new RegExp('<option value="' + value + '">'), 'ticket category ' + value + ' matches the server');

// Team accounts: every dashboard section has a permission in public/team.js
// (a section missing there is shown to the owner only), so rearranging the
// pages keeps each role's view. Add new section ids to SECTIONS.
{
  const teamUi = fs.readFileSync(path.join(__dirname, '../public/team.js'), 'utf8');
  const sectionsBlock = teamUi.match(/var SECTIONS = \{([\s\S]*?)\};/);
  assert.ok(sectionsBlock, 'team.js maps sections to permissions');
  const mapped = new Set(Array.from(sectionsBlock[1].matchAll(/'?([a-z-]+)'?:/g), (match) => match[1]));
  const modules = html.match(/var moduleSections = \{([\s\S]*?)\};/);
  assert.ok(modules, 'the dashboard lists each page\'s sections');
  // Quoted page names ('router-setup', 'portal-templates') are keys, not sections.
  const ids = new Set(Array.from(modules[1].matchAll(/\[([^\]]*)\]/g), (match) => match[1]).join(',').match(/[a-z-]+/g));
  for (const id of ids) assert.ok(mapped.has(id), `section ${id} has a team permission in public/team.js`);
  assert.match(html, /remove\.setAttribute\('data-permission', 'routers\.delete'\)/, 'Delete router is hidden from roles that cannot delete routers');
  assert.match(html, /tool: 'backup', permission: 'backups'/, 'router backups are hidden from a Technician');
  assert.match(html, /window\.FitiTeam\.apply\(data\.member, moduleSections, dashboardPages\)/, 'the dashboard applies the signed-in role');
}

// Team accounts: pppoe.html and operations.html are gated by role too
// (public/team-gate.js). A role without the page gets a plain message and a
// link back; parts a role can't use are left out.
{
  const vm = require('node:vm');
  const gateSource = fs.readFileSync(path.join(__dirname, '../public/team-gate.js'), 'utf8');
  // A tiny DOM: createElement, appendChild, removeChild, textContent.
  const node = (tag) => ({ tag, children: [], attrs: {}, className: '', textContent: '', href: '', id: '',
    get firstChild() { return this.children[0] || null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; },
    setAttribute(key, value) { this.attrs[key] = value; } });
  const document = { createElement: node };
  const sandbox = { window: { document }, document };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(gateSource, sandbox);
  const gate = sandbox.window.FitiGate;
  const tech = { role: 'technician', roleLabel: 'Technician', permissions: ['routers.view', 'tools', 'support'] };
  assert.equal(gate.can(null, 'payouts'), true, 'no member (an older server) is the owner');
  assert.equal(gate.can({ role: 'owner', permissions: [] }, 'payouts'), true, 'the owner may do everything');
  assert.equal(gate.can(tech, 'customers.view'), false);
  assert.equal(gate.can(tech, ['customers.view', 'support']), true, 'any one permission in a list is enough');
  const target = node('section'); target.appendChild(node('div'));
  const card = gate.blocked(target, tech, { cardClass: 'card', linkClass: 'back' });
  assert.equal(target.children.length, 1, 'the page controls are replaced');
  assert.equal(card.id, 'role-blocked');
  assert.equal(card.children[0].textContent, 'Your role can’t open this page');
  assert.match(card.children[1].textContent, /signed in as Technician\. .*Ask the owner/);
  assert.equal(card.children[2].href, '/business.html', 'a link back to the dashboard');

  const pppoe = fs.readFileSync(path.join(__dirname, '../public/pppoe.html'), 'utf8');
  assert.match(pppoe, /<script src="\/team-gate\.js"><\/script>/);
  assert.match(pppoe, /if \(!can\('customers\.view'\)\) \{ window\.FitiGate\.blocked\(app, me\.member/, 'pppoe.html checks the role before loading subscribers');
  assert.match(pppoe, /b\.billed && can\('payments\.record'\) \? h\('button', \{ type: 'button', class: 'small', text: 'Record payment'/);
  assert.match(pppoe, /can\('customers\.edit'\) \? h\('button', \{ type: 'button', class: 'secondary small', text: 'Edit'/);
  assert.match(pppoe, /row\(\[can\('customers\.edit'\) \? addSubscriberCard\(\) : null, can\('packages\.edit'\) \? plansCard\(\) : null\]\)/);
  assert.match(pppoe, /if \(can\('sales\.view'\)\) app\.appendChild\(h\('div', \{ style: 'margin-top:16px' \}, \[paymentsCard\(\)\]\)\)/);
  assert.match(pppoe, /!can\('billing'\) \? null : h\('button', \{ type: 'button', text: 'Renew plan'/, 'only the owner renews the plan');

  const ops = fs.readFileSync(path.join(__dirname, '../public/operations.html'), 'utf8');
  assert.match(ops, /<script src="\/team-gate\.js"><\/script>/);
  assert.match(ops, /var parts = \{ customers: 'customers\.view', support: 'support', billing: 'billing', payouts: 'payouts' \};/, 'receipts and payouts are owner-only');
  assert.match(ops, /if \(!shown\.length\) \{ \$\('role-gate'\)\.classList\.remove\('hidden'\); window\.FitiGate\.blocked\(/);
  assert.match(ops, /Promise\.allSettled\(shown\.map\(/, 'only the parts a role may use are loaded');
  assert.match(ops, /if \(can\('payouts'\)\) \{\s*\$\('payout-form'\)/, 'payout details are filled for the owner only');

  // The Attendant's sales card says Today; the customer check and the go-live
  // card cope with no amount (the server leaves it out for a Technician).
  assert.match(html, /\$\('sales-payments-foot'\)\.textContent = today \? 'Today' : 'In selected period'/);
  assert.match(html, /acc\.lastPayment\.amount != null \? kes\(acc\.lastPayment\.amount\) \+ ' · ' : ''/);
  assert.match(html, /var paid = sale && sale\.amount != null \? 'Paid ' \+ kes\(sale\.amount\) : 'Paid';/);
}

// Active users (public/online-users.js): opened from the router card; plain
// words for each customer online, idle, offline; money only for roles with
// sales; nothing written as HTML.
{
  const source = fs.readFileSync(path.join(__dirname, '../public/online-users.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML/, 'customer data is only ever written with textContent');
  const load = (canDo) => {
    const context = { window: { FitiTeam: { can: canDo } }, document: {}, localStorage: { getItem: () => '' }, Date, Math, Number, String, Array, Boolean, setInterval, clearInterval };
    vm.runInNewContext(source, context);
    return context.window.FitiOnlineUsers._test;
  };
  const owner = load(() => true);
  assert.equal(owner.span(45), '45s'); assert.equal(owner.span(125), '2m'); assert.equal(owner.span(3 * 3600 + 5 * 60), '3h 05m'); assert.equal(owner.span(2 * 86400 + 7200), '2d 2h');
  assert.equal(owner.bytes(950), '950 B'); assert.equal(owner.bytes(5200000), '5.2 MB'); assert.equal(owner.bytes(1.3e9), '1.3 GB');
  assert.equal(owner.phone('254711000001'), '0711000001');
  assert.equal(owner.shortMac('AA:BB:CC:DD:EE:FF'), '••:EE:FF');
  const row = { router_username: '254711000001', payer_phone: '254711000001', mac: 'AA:BB:CC:00:00:01', ip: '10.5.50.11',
    uptime_seconds: 3720, idle_seconds: 30, bytes_in: 700000, bytes_out: 52000000, package_name: '1 day', subscription_id: 'sub-1', seconds_left: 72000 };
  const view = owner.onlineRowView(row);
  assert.equal(view.status, 'Online'); assert.equal(view.onlineFor, '1h 02m'); assert.equal(view.data, '↓ 52 MB · ↑ 700 KB');
  assert.equal(view.plan, '1 day · 20h 00m left'); assert.equal(view.device, '••:00:01 · 10.5.50.11'); assert.equal(view.clickable, true);
  assert.equal(owner.onlineRowView({ ...row, idle_seconds: 600 }).status, 'Idle 10m', 'idle five minutes or more is shown as idle');
  assert.equal(owner.onlineRowView({ ...row, router_username: '254711000001-tv' }).tv, true);
  assert.equal(owner.offlineRowView({ payer_phone: '254711000003', package_name: '1 week', seconds_left: 90000, last_seen_at: null }).status, 'Not connected yet');
  assert.match(owner.capacityText({ online: 100, limit: 100, level: 'full' }), /^100 of 100 online on your plan · Full: new customers wait until someone leaves\. Customers with time left can still reconnect\.$/);
  assert.equal(owner.capacityText({ online: 3, limit: 0 }), '');
  assert.match(owner.capacityText({ online: 4, limit: 10, level: 'ok' }, false), /^4 of 10 counted on your plan \(every package with time left, until the router reports\)$/);
  const body = { subscription: { payer_phone: '254711000001', expires_at: '2999-01-01 00:00:00', used_seconds: 7200, mac: 'AA:BB:CC:00:00:01', location_name: 'Kitale' },
    history: [{ created_at: '2026-09-29 08:00:00', package_name: '1 day', amount: 50, status: 'paid', mpesa_receipt: 'SGR7ABC' }], vouchers: [],
    activity: { online: true, sessions: [{ started_at: '2026-09-29 08:01:00', ended_at: null, online: 1, uptime_seconds: 600, bytes_in: 1000, bytes_out: 2000000, mac: 'AA:BB:CC:00:00:01', ip: '10.5.50.11' }],
      totals: { seconds: 5400, bytes_in: 5000, bytes_out: 9000000, last_seen_at: '2026-09-29 08:11:00' } } };
  const detail = owner.detailView(body, Date.parse('2026-09-29T09:00:00Z'));
  assert.equal(detail.status, 'Online now');
  assert.equal(JSON.stringify(detail.stats.map((item) => item[0])), JSON.stringify(['Time left', 'Time used', 'Online in total', 'Data used']));
  assert.equal(detail.sessions[0][1], 'Online now');
  assert.equal(detail.payments[0][2], 'KES 50');
  const technician = load((permission) => permission === 'routers.view');
  assert.equal(technician.onlineRowView(row).clickable, false, 'a role without customers.view does not open customer history');
  assert.equal(technician.detailView(body).payments[0][2], '—', 'no amount without a sales permission');
  // The router card's Active users number opens it, for roles that may.
  assert.match(html, /<article class="metric router-active-users" data-online-users>/);
  assert.match(html, /<script src="\/online-users\.js" defer><\/script>/);
  assert.match(html, /window\.FitiOnlineUsers && \(can\('customers\.view'\) \|\| can\('routers\.view'\)\)/);
  assert.match(html, /'No update since ' \+ when\(latest\.recorded_at\)/, 'an old chart says how old it is');
  assert.match(html, /card\.dataset\.cardModule \|\| card\.hasAttribute\('data-online-users'\)\) return;/, 'the card opens who is online, not the Customers page');
}

// Live refresh: every 2 s, redraws only on a real change, pauses while busy.
{
  const liveStable = vm.runInNewContext('(' + html.match(/function liveStable\(value\) \{[\s\S]*?\n/)[0].replace(/^function liveStable/, 'function') + ')');
  const before = [{ business: { id: 'b', name: 'Shop' }, locations: [{ id: 'l', router_status: 'online', last_seen_at: '2026-09-29 10:00:00' }] }, { since: '2026-09-29 00:00:00', totals: { gross: 50 } }];
  const tick = JSON.parse(JSON.stringify(before)); tick[0].locations[0].last_seen_at = '2026-09-29 10:00:05'; tick[1].since = '2026-09-29 00:00:02';
  assert.equal(liveStable(tick), liveStable(before), 'a router check-in or the clock alone never redraws the page');
  const sale = JSON.parse(JSON.stringify(before)); sale[1].totals.gross = 70;
  assert.notEqual(liveStable(sale), liveStable(before), 'a new sale redraws it');
  const offline = JSON.parse(JSON.stringify(before)); offline[0].locations[0].router_status = 'offline';
  assert.notEqual(liveStable(offline), liveStable(before), 'a router going offline redraws it');
  assert.match(html, /var LIVE_EVERY_MS = 2000;/);
  assert.match(html, /document\.visibilityState === 'hidden' \|\| liveInFlight \|\| moduleView === 'onboarding' \|\| userBusy\(\)/, 'paused while hidden, busy or in setup');
  assert.match(html, /\/\^\(INPUT\|SELECT\|TEXTAREA\)\$\/\.test\(active\.tagName\)/, 'never while a field has focus');
  assert.match(html, /Date\.now\(\) - lastUserInputAt < 8000/, 'nor within 8 seconds of typing');
  assert.match(html, /document\.querySelector\('\.ou-backdrop, \.router-draft-modal:not\(\.hidden\), \.rb-review'\)/, 'nor with a dialog or the map review open');
  assert.match(html, /if \(moduleView === 'routers' && can\('routers\.view'\)\) \{ var section = \$\('router-observability-section'\);/);
  assert.match(fs.readFileSync(path.join(__dirname, '../public/online-users.js'), 'utf8'), /var REFRESH_MS = 2000;/, 'Active users refreshes every 2 seconds');
}

// Router terminal history: owners see past sessions in the Remote access
// module; the list refreshes whenever a terminal modal closes.
assert.match(html, /function renderTerminalHistory\(root\)/, 'the dashboard renders a terminal history section');
assert.match(html, /Terminal history/, 'the history section is labeled');
assert.match(html, /\/api\/business\/terminal\/audit/, 'history comes from the business audit endpoint');
assert.match(html, /if \(!can\('team'\)\) return;/, 'terminal history is owner-only');
assert.match(fs.readFileSync(path.join(__dirname, '../public/terminal.js'), 'utf8'), /onClose: function/, 'the terminal modal exposes an onClose hook for refresh');

// Overview honesty: the chart plots the period's paid transactions per
// day (per hour for today, per week for 90 days); the KPIs use the
// server's real gross, fee and net. Nothing is fabricated when idle.
assert.match(html, /function overviewPaidTransactions\(\)/, 'the overview chart reads paid transactions only');
assert.match(html, /function overviewRevenueBuckets\(rows\)/, 'revenue is bucketed per day, hour or week');
assert.match(html, /dashboard\.netToBusiness/, 'the net KPI uses the server net, not a guess');
assert.match(html, /overview-kpi-label">Platform fee/, 'the fee KPI names the real platform fee');
assert.match(html, /No paid sales in this view/, 'an empty chart says so instead of drawing fake bars');
assert.doesNotMatch(html, /index % 4 === 0 \? \.08/, 'no fabricated fallback wave when there are no sales');
assert.doesNotMatch(html, /<span>Proceeds<\/span><span>Commission<\/span>/, 'no proceeds/commission split the data cannot support');
// The source filter names real collection rails and redraws the chart.
assert.match(html, /option value="own">Own Till \/ PayBill/, 'the filter offers the real own-collection rail');
assert.match(html, /option value="tuma">Tuma/, 'the filter offers the real Tuma rail');
assert.match(html, /Source filter: ' \+ this\.options\[this\.selectedIndex\]\.text; renderOverviewInsights/, 'changing the source redraws the overview');
{
  const block = html.match(/var OVERVIEW_SOURCE_LABELS = [\s\S]*?\n      function renderOverviewInsights/)[0]
    .replace(/\n      function renderOverviewInsights$/, '');
  const source = { value: 'all' };
  const pad = (n) => String(n).padStart(2, '0');
  const at = (daysAgo, hour) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hour)}:00:00`; };
  const transactions = [
    { status: 'paid', amount: 20, payment_source: 'fiti', created_at: at(0, 12) },
    { status: 'paid', amount: 50, payment_source: 'own', created_at: at(1, 12) },
    { status: 'paid', amount: 30, payment_source: 'c2b', created_at: at(1, 13) },
    { status: 'pending', amount: 999, payment_source: 'fiti', created_at: at(0, 12) },
  ];
  const context = vm.createContext({ state: { dashboard: { period: '90d', transactions } }, salesPeriod: '30d', $: (id) => (id === 'overview-source' ? source : null) });
  vm.runInContext(block + '\nthis.__test = { paid: overviewPaidTransactions, buckets: overviewRevenueBuckets };', context);
  const total = (rows) => rows.reduce((sum, row) => sum + row.revenueKes, 0);
  assert.equal(total(context.__test.buckets(context.__test.paid()).buckets), 100, 'paid revenue is plotted exactly; pending is excluded');
  source.value = 'own';
  assert.equal(total(context.__test.buckets(context.__test.paid()).buckets), 80, 'the own-collection filter keeps own and C2B rails only');
  source.value = 'tuma';
  assert.equal(total(context.__test.buckets(context.__test.paid()).buckets), 0, 'an unused rail charts nothing, not a guess');
  source.value = 'all';
  assert.equal(context.__test.buckets(context.__test.paid()).buckets.length, 13, 'a 90-day view has 13 weekly bars');
  context.state.dashboard.period = '7d';
  assert.equal(context.__test.buckets(context.__test.paid()).buckets.length, 7, 'a 7-day view has 7 daily bars');
  context.state.dashboard.period = 'today';
  assert.equal(context.__test.buckets(context.__test.paid()).buckets.length, 24, "today's view has 24 hourly bars");
}

// Customer history opens in a dialog, never a blocking browser alert.
assert.match(html, /id="customer-modal" role="dialog" aria-modal="true"/, 'customers open in a labelled dialog');
assert.match(html, /function openCustomerModal\(customer\)/, 'the dialog renders identity plus package history');
assert.doesNotMatch(html, /window\.alert\('Customer '/, 'no native alert for customer details');
assert.match(html, /customer-modal-close'\)\.addEventListener\('click'/, 'the dialog closes from its button');
assert.match(html, /event\.key === 'Escape' && !\$\('customer-modal'\)/, 'Escape closes the dialog');

// Failed loads read as failures, not as quiet zeros.
assert.match(html, /id="sales-error"/, 'the sales panel has its own error slot');
assert.match(html, /id="analytics-error" role="alert"/, 'analytics failures surface next to the metrics');
assert.doesNotMatch(html, /analytics-load-note/, 'the analytics error path writes to a real element');
assert.match(html, /state\.dashboardError = results\[1\]\.status === 'fulfilled' \? null/, 'a failed sales fetch is remembered, not replaced by zeros');
assert.match(html, /\$\('sales-gross'\)\.textContent = failed \? '—'/, 'failed sales metrics show a dash, not KES 0');

// Live freshness: the pill names the update age, pauses honestly while
// editing, and a live redraw never moves the reader's scroll position.
assert.match(html, /id="live-pill"/, 'the topline carries a live-update pill');
assert.match(html, /function renderLivePill\(\)/, 'the pill renders from the last successful poll');
assert.match(html, /Live · just now/, 'a current page says it is live');
assert.match(html, /Paused while editing/, 'typing pauses updates openly instead of going silently stale');
assert.match(html, /Reconnecting…/, 'repeated failures read as reconnecting, not live');
assert.match(html, /liveLastOk = Date\.now\(\); liveFailures = 0;/, 'every successful poll refreshes the age, not only redraws');
assert.match(html, /window\.scrollTo\(\{ top: y, left: 0, behavior: 'instant' \}\)/, 'a live redraw restores scroll instantly, ignoring smooth scrolling');

// Analytics report: truncation is labelled, paged, and exportable whole.
assert.match(html, /function analyticsReportRow\(row\)/, 'report rows render through one helper');
assert.match(html, /'Showing ' \+ visible\.length \+ ' of ' \+ rows\.length/, 'a truncated report says how much is shown');
assert.match(html, /data-report-more.*Show more/, 'a truncated report pages forward');
assert.match(html, /Export report downloads every record/, 'the full report stays one export away');
assert.doesNotMatch(html, /rows\.slice\(0, 200\)\.map/, 'no silent 200-row cut with a total count beside it');

// Customer dialog: the full number is one copy tap away; lists stay masked.
assert.match(html, /id="customer-modal-contact"/, 'the dialog has a contact row');
assert.match(html, /Call or M-Pesa ' \+ contactPhone/, 'the dialog shows the full callable number');
assert.match(html, /customer-modal-copy'\)\.addEventListener\('click'/, 'the number copies from the dialog');
assert.match(html, /copyText\(number, event\.currentTarget\)/, 'copying reuses the clipboard helper with its Copied feedback');

// Sales cards arrive at Transactions with their context, not a blank list.
assert.match(html, /card\.dataset\.txQuery = payment\.mpesa_receipt \|\| payment\.phone/, 'a payment card carries its receipt or phone');
assert.match(html, /card\.dataset\.txQuery = entry\.name/, 'a router breakdown card carries its router');
assert.match(html, /card\.dataset\.txQuery && module === 'transactions'/, 'navigation applies the carried query to Transactions');
assert.match(html, /search\.value = card\.dataset\.txQuery/, 'the Transactions search is filled before the jump');

// Destructive voucher and template actions arm on first tap; router
// mutations keep their explicit blocking confirmations.
assert.match(html, /function tapArmed\(button, armedLabel\)/, 'one arming helper backs the two-tap actions');
assert.match(html, /Tap again to delete ' \+ plural\(codes\.length, 'voucher'\)/, 'voucher deletion arms with its count');
assert.match(html, /Tap again to pause/, 'voucher pausing arms instead of blocking');
assert.match(html, /tapArmed\(button, 'Tap again to delete'\)/, 'template deletion arms instead of blocking');
assert.doesNotMatch(html, /window\.confirm\('Delete ' \+ plural\(codes\.length/, 'no blocking dialog for voucher deletion');
assert.doesNotMatch(html, /window\.confirm\('Delete this inactive portal template\?'\)/, 'no blocking dialog for template deletion');
assert.match(html, /window\.confirm\('Apply Wi-Fi Fiti service/, 'router-mutating actions keep their explicit confirmation');

// The mobile sign-out icon reads as power/exit, not share/external.
assert.match(html, /\.sidebar \.signout:before\{content:"⏻"/, 'the collapsed sign-out uses an exit glyph');
assert.doesNotMatch(html, /signout:before\{content:"↗"/, 'the share-looking arrow is gone');

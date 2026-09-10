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
assert.match(html, /Customer traffic and payments never use this path/, 'the UI does not imply customer traffic is routed through support access');
assert.doesNotMatch(html, /privateKey|private-key|vpnPrivate/i, 'the business UI must never render VPN private material');
assert.match(html, /\/mapped-deployment/, 'the mapped deployment remains location-scoped and owner-authenticated');
assert.match(html, /action:\s*'apply'/, 'the browser can request only the finite reviewed mapped-deployment action');
assert.match(html, /Apply WiFi Fiti service/, 'the remote panel makes the post-map action explicit rather than implying a generic terminal');
assert.match(html, /fresh private management handshake/, 'the UI explains that deployment is gated by a current private connection');
assert.match(html, /It never changes WAN, bridge membership, Wi‑Fi name or password, DHCP, NAT, generic firewall policy, Hotspot address, or router administrator access/, 'the UI precisely defines the autonomous deployment boundary');

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
assert.match(html, /model\.needsRouterCheck \? 5000 : waitsForMap \? 10000 : 30000/,
  'connection and post-connection map states both receive bounded automatic checks');
assert.match(html, /document\.visibilityState === 'hidden'/,
  'automatic status checks pause while the dashboard is not visible');
assert.match(html, /Router needs to reconnect/,
  'a historically paired but offline router is never presented as ready for customers');
assert.match(html, /Create a different kit/,
  'the guided setup offers a single clear recovery action for its connection kit');
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
assert.match(html, /Confirm the layout after sync/,
  'the connection milestones accurately describe the next focused page');
assert.match(html, /@media\(max-width:900px\)\{\.onboarding-flow-head[\s\S]*\.setup-rail\{grid-template-columns:1fr/,
  'the three setup stages stay readable in one connected mobile/tablet sequence');
assert.match(html, /Initial Preparation \(Optional\)/,
  'safe optional preparation guidance is available in the connection stage');
assert.match(html, /WiFi Fiti never resets a router remotely/,
  'the new onboarding language keeps router resets explicitly owner-controlled');
assert.match(html, /function connectionPhaseFor\(model\)/,
  'the connection stage remembers which single focused page an owner was on');
assert.match(html, /Continue to secure connection/,
  'preparation has one explicit transition into the secure kit page');
assert.match(html, /appendConnectionMilestones\(prepareBody, phase\)/,
  'the preparation page shows progress without rendering the following work');
assert.match(html, /appendConnectionMilestones\(connectBody, phase\)/,
  'the secure-kit page retains the same compact progress context');
assert.match(html, /\/ip dhcp-client add interface=ether1 disabled=no comment="WiFi Fiti WAN"/,
  'new DHCP routers can be prepared with a visible, copyable WAN command');
assert.match(html, /Skip it for PPPoE, static IP or another WAN port/,
  'the WAN guidance does not pretend that DHCP on ether1 fits every router');
assert.match(html, /WiFi Fiti already retries through its outbound polling link/,
  'failed connection checks offer an honest recovery path rather than a fake second transport');
assert.match(html, /Review WAN preparation/,
  'two unsuccessful connection checks route the owner back to the prerequisite page');

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
  'only the preparation page is rendered before the owner explicitly continues');
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

// A RouterOS kit is executable configuration. A browser session must never
// keep offering an older saved kit after its bootstrap behavior changes. The
// owner has to deliberately generate a current replacement; merely loading
// the dashboard does not rotate the still-pending server-side credential.
assert.match(html, /var routerKitRevision = 'one-line-loader-v5';/,
  'stored connection kits carry an explicit bootstrap revision');
assert.match(html, /function storedRouterKitIsCurrent\(setup\) \{ return Boolean\(storedRouterKitHasScript\(setup\) && setup\.kitRevision === routerKitRevision\); \}/,
  'only a script saved with the current bootstrap revision is eligible for copying');
assert.match(html, /kitRevision: hasGeneratedScript \? routerKitRevision : ''/,
  'only freshly generated full scripts are marked current in session storage');
assert.match(html, /script: generated\.script, loader: generated\.loader === true/,
  'the browser retains the server approval for a one-line loader with the current kit');
assert.match(html, /function routerBootstrapCommand\(setup\)/,
  'current connection kits can render a concise cloud-bootstrap command');
assert.match(html, /setup\.setup\.loader === true/,
  'the concise command is offered only when the server retained the exact one-time kit');
assert.match(html, /\/api\/router\/v1\/bootstrap\?site=/,
  'the concise command fetches WiFi Fiti’s location-specific bootstrap endpoint');
assert.match(html, /http-header-field="' \+ rosQuote\('X-WiFi-Fiti-Router: ' \+ routerToken\)/,
  'the concise command authenticates with the per-location router token, not a global credential');
assert.match(html, /Copy one-line installer/,
  'owners can copy the concise installer directly instead of a long terminal paste');
assert.match(html, /WiFi Fiti kit was not downloaded\. Check WAN, DNS and RouterOS certificate trust, then retry\./,
  'a failed short installer stops before importing a stale file');
assert.match(html, /fetches the exact one-time kit over authenticated HTTPS/,
  'the dashboard explains that the short command fetches rather than guesses the selected setup');
const compactKitUi = html.match(/function appendSimpleRouterSetup\(body, model\) \{[\s\S]*?\n\s*function selectedMode\(\)/);
assert.ok(compactKitUi, 'the compact connection-kit UI is present');
assert.match(compactKitUi[0], /saved && saved\.token && storedRouterKitIsCurrent\(saved\)/,
  'the copy controls are gated on the current stored kit revision');
assert.match(compactKitUi[0], /storedRouterKitIsStale\(saved\)/,
  'an older cached script is detected instead of silently reused');
assert.match(compactKitUi[0], /This saved connection kit is out of date and cannot be copied\./,
  'owners receive a direct fresh-kit instruction before a stale RouterOS command can be copied');
assert.match(html, /item && item\.token && storedRouterKitIsCurrent\(item\)/,
  'the legacy pairing-kit list also refuses to surface a stale cached command');
assert.match(html, /\/system device-mode update fetch=yes scheduler=yes hotspot=yes/,
  'the onboarding hint enables only the three required RouterOS device-mode features');
assert.doesNotMatch(html, /\/system device-mode update mode=advanced/,
  'the onboarding hint does not overwrite unrelated owner device-mode choices');

for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);

// Exercise all three public result screens: a button present somewhere in
// the HTML is not enough if owners enter through a different setup screen.
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
for (const name of ['el', 'add', 'clear', 'setupAction', 'saveSetup', 'rosQuote', 'routerCommands',
  'routerBootstrapCommand', 'storedRouterKitHasScript', 'storedRouterKitIsCurrent', 'storedRouterKitIsStale',
  'appendRouterInstaller', 'appendSimpleRouterSetup', 'renderPairingKits', 'showRouterSetup']) {
  const declaration = html.match(new RegExp('      function ' + name + '\\([^]*?(?=\\n      function |\\n    \\}\\)\\(\\);)'));
  assert.ok(declaration, name + ' is available to exercise');
  vm.runInContext(declaration[0], context);
}
for (const loaderStatus of ['ready', 'storage_not_configured', 'unavailable', '']) {
  const generated = { mode: 'auto', script: '# Test full kit\n:put "test"', loader: loaderStatus === 'ready', loaderStatus };
  context.showRouterSetup({ location: uiLocation, portalUrl: context.publicPortal(), setup: generated });
  const guided = new TestElement('div'); context.appendSimpleRouterSetup(guided, { location: uiLocation });
  for (const [screen, root] of [['setup result', elements.get('router-setup-output')], ['saved kits', elements.get('setup-list')], ['guided setup', guided]]) {
    const nodes = descendants(root);
    const buttons = nodes.filter(node => node.tagName === 'button' && node.textContent === 'Copy one-line installer');
    assert.equal(buttons.length, 1, screen + ' always identifies the one-line installer');
    assert.equal(buttons[0].disabled, !generated.loader, screen + ' enables copying only for an available installer');
    if (generated.loader) {
      copiedCommand = ''; buttons[0].listeners.click();
      assert.ok(copiedCommand.includes('/api/router/v1/bootstrap?site=' + uiLocation.id), screen + ' copies the selected router installer');
      assert.ok(copiedCommand.includes('X-WiFi-Fiti-Router: ' + uiLocation.routerToken));
      assert.ok(!copiedCommand.includes('\n'), screen + ' copies a single line');
      assert.notEqual(copiedCommand, generated.script, screen + ' does not copy the full kit through the short-command button');
    } else {
      const message = loaderStatus === 'storage_not_configured' ? 'secure installer storage has not been configured' : 'could not prepare the one-line installer';
      assert.ok(nodes.some(node => node.textContent.includes(message)), screen + ' explains installer unavailability');
      assert.ok(nodes.some(node => node.tagName === 'button' && node.textContent === 'Download .rsc'), screen + ' keeps the full kit available');
    }
  }
}
const stale = new TestElement('div');
context.appendRouterInstaller(stale, { ...savedKits[uiLocation.id], kitRevision: 'old' });
assert.equal(stale.children.length, 0, 'a shared installer panel cannot expose a stale kit');

console.log('Business UI: focused router onboarding, mapping, and client-script safety passed.');

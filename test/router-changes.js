'use strict';

/*
 * Universal kit stage 3: a saved network map is applied to the router safely.
 * Preflight first, undo written before any change, a boot guard, the router
 * must reach the cloud again to keep a change, the next layout report
 * re-checks it, and each change can be undone later.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

const databasePath = '/tmp/wifi-fiti-router-changes.db';
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(databasePath + suffix); } catch (_) {} }
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://cloud.wififiti.co.ke', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke', MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  PROVISION_MODE: 'poll', SITE_TOKEN: 'changes-site-token', TENANT_SECRETS_KEY: 'changes-key',
  ADMIN_TOKEN: 'changes-admin', DATABASE_PATH: databasePath,
});

const { parseRouterInventory } = require('../src/lib/router-topology');

// An RB951 like the owner's: hotspot1 on bridge-hs (built by Wi-Fi Fiti), ether5 free.
function rb951(extra = []) {
  return ['fiti-inventory-v2', 'inv|agent|4', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up', 'inv|if|ether4|ether|up',
    'inv|if|ether5|ether|up', 'inv|if|wlan1|wlan|up', 'inv|if|bridge-hs|bridge|up', 'inv|fiti-bridge|bridge-hs',
    'inv|bport|bridge-hs|ether2', 'inv|bport|bridge-hs|ether3', 'inv|bport|bridge-hs|ether4', 'inv|bport|bridge-hs|wlan1',
    'inv|addr|bridge-hs', 'inv|dhcp-server|bridge-hs|enabled', 'inv|hotspot|hotspot1|bridge-hs', 'inv|pppoe-server|service1|bridge-hs|enabled',
    'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', ...extra, 'fiti-inventory-end'].join('\n') + '\n';
}
// A freshly reset hAP lite: no hotspot, nothing in a bridge.
function blank(extra = []) {
  return ['fiti-inventory-v2', 'inv|agent|4', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up', 'inv|if|wlan1|wlan|up',
    'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', ...extra, 'fiti-inventory-end'].join('\n') + '\n';
}

// ---- Scripts: order of safety steps, and nothing unexpected --------------
{
  require('../src/lib/tenant');
  const rc = require('../src/lib/router-changes');
  const plan = { bridges: [{ name: 'fiti-pppoe', job: 'pppoe', ports: ['ether4', 'ether5'] }], existing: [{ interface: 'bridge-hs', job: 'hotspot', alreadyRunning: true }],
    moves: [{ interface: 'ether4', from: 'bridge-hs' }] };
  const review = rc.reviewPlan(plan, parseRouterInventory(rb951()));
  assert.equal(review.changes.length, 1, 'a hotspot that already runs needs no change');
  assert.match(review.notes[0], /bridge-hs already runs a hotspot/);
  assert.match(review.notes.join(' '), /No free Ethernet port is left for you/, 'the owner is warned before losing every free port');
  const keptReview = rc.reviewPlan({ ...plan, bridges: [{ name: 'fiti-pppoe', job: 'pppoe', ports: ['ether4'] }], keep: ['ether5'] }, parseRouterInventory(rb951()));
  assert.match(keptReview.notes.join(' '), /ether5 is reserved for you to manage the router/);
  assert.doesNotMatch(keptReview.notes.join(' '), /No free Ethernet port/);
  assert.match(review.changes[0].lines.join(' '), /Move ether4 out of bridge-hs into fiti-pppoe/);
  assert.match(review.changes[0].lines.join(' '), /A PPPoE server you set up yourself stays as it is/);
  const script = rc.applyScript(review.changes[0], 7, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke' });
  const at = (pattern) => { const i = script.search(pattern); assert.ok(i >= 0, `missing ${pattern}`); return i; };
  const preflight = at(/interface bridge port find where interface="ether4" and bridge="bridge-hs"\]\] != 1/);
  const stop = at(/:error "fiti-change-preflight"/);
  const undo = at(/\/system script add name="fiti-undo-7"/);
  const guard = at(/\/system scheduler add name="fiti-revert-7" start-time=startup/);
  const firstChange = at(/\n  \/interface bridge add name="fiti-pppoe"/);
  const confirm = at(/:execute script=/);
  assert.ok(preflight < stop && stop < undo && undo < guard && guard < firstChange && firstChange < confirm,
    'preflight, then undo, then the boot guard, then the change, then the cloud check');
  assert.match(script, /\/interface bridge port remove \[find where interface="ether4" and bridge="bridge-hs"\]/, 'only the planned port leaves bridge-hs');
  assert.doesNotMatch(script, /\/interface bridge port remove \[find where interface="ether[23]"|wlan1/, 'the hotspot ports are not touched');
  assert.doesNotMatch(script, /\/ip hotspot add|\/ip address add/, 'a PPPoE bridge starts no hotspot');
  assert.match(script, /state=applied/); assert.match(script, /\\"confirmed\\"/, 'only a "confirmed" reply keeps the change');
  assert.match(script, /while \(\(\(\\\$ok = false\) && \(\\\$i < 26\)\)\)/, 'the router keeps trying the cloud for about 80 seconds');
  assert.match(script, /:if \(\\\$i = 0\) do=\{ :delay 1s \} else=\{ :delay 3s \}/, 'the first confirm comes after 1 second, then every 3');
  assert.match(script, /:log info "fiti: network change 7 started"/, 'the router log shows when a change starts');
  assert.match(script, /state=kept.*system script run fiti-inventory/s, 'a fresh layout report follows straight after keeping it');
  assert.match(script, /fiti-undo-7.*source=".*bridge port add bridge=\\"bridge-hs\\" interface=\\"ether4\\"/, 'undo puts ether4 back in bridge-hs');
  assert.match(script, /fiti-undo-7.*source=".*interface bridge remove \[find where name=\\"fiti-pppoe\\"\]/, 'undo removes the new bridge');
  assert.match(script, /fiti-prev-7/, 'the PPPoE server returns to where it was on undo');
  const undoSource = require('../src/lib/router-changes').undoLines(review.changes[0], 7);
  assert.match(undoSource[undoSource.length - 1], /scheduler remove \[find where name="fiti-revert-7"\]/, 'the reboot guard goes only once the undo finished');
  assert.ok(undoSource.some((l) => /fiti-undo-incomplete/.test(l)), 'a partial undo throws and keeps its guard');
  assert.match(script, /bridge port find where bridge="bridge-hs"\]\] <= 1\) do=\{ :set fitiWhy "bridge_would_empty" \}/, 'bridge-hs keeps a port');
  assert.match(script, /vlan-filtering\] = true\) do=\{ :set fitiWhy "vlan_filtering" \}/);
  assert.match(script, /state=kept/, 'the router says when it kept the change');
  assert.doesNotMatch(script, /\/system reset|\/user |password=|\/interface ethernet set|\/ip route (add|set|remove)|\/interface (wireless|wifi) set/, 'no reset, users, WAN or radio changes');

  // Hotspot on a fresh router: a free subnet is chosen on the router.
  const hs = rc.reviewPlan({ bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['ether2', 'wlan1'] }], existing: [], moves: [] }, parseRouterInventory(blank()));
  assert.equal(hs.blockers.length, 0);
  const hsScript = rc.applyScript(hs.changes[0], 9, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke', portalHost: 'kitale.wififiti.co.ke' });
  assert.match(hsScript, /:if \(\[:len \[\/ip hotspot find\]\] > 0\) do=\{ :set fitiWhy "hotspot_exists" \}/, 'never a second hotspot');
  assert.match(hsScript, /no_free_subnet/, 'stops when every 10.5.50-59 network is taken');
  assert.match(hsScript, /\/ip hotspot add name="fiti-hotspot" interface="fiti-hs"/);
  assert.match(hsScript, /chain=input in-interface="fiti-hs" action=drop comment="Wi-Fi Fiti change 9" place-before=\$fitiAnchor/, 'customers cannot open router settings');
  const order = ['in-interface="ether1" protocol=udp dst-port=53 action=drop', 'in-interface="fiti-hs" protocol=tcp dst-port=53,80,443,64872-64875 action=accept',
    'in-interface="fiti-hs" protocol=udp dst-port=53,67,64872 action=accept', 'in-interface="fiti-hs" action=drop', 'allow-remote-requests=yes'].map((t) => hsScript.indexOf(t));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), 'accepts before the drop, and DNS is opened only after the internet side is closed');
  assert.match(hsScript, /:set fitiAnchor \[:pick \$s 0\]/, 'one fixed anchor keeps the rule order');
  assert.match(hsScript, /"m8"=255\.0\.0\.0/, 'overlapping networks of any size count as used');
  assert.match(hsScript, /subnet_check_failed/, 'a surprise while reading networks stops the change');
  assert.match(hsScript, /64872-64875/, 'the hotspot login itself stays reachable');
  assert.match(hsScript, /\/ip route find where dst-address!=0\.0\.0\.0\/0/, 'routes (VPNs, static) count as used too');
  assert.match(hsScript, /:if \(\(\$ip & \$m\) = \(\$cand & \$m\)\) do=\{ :set used true \}/);
  assert.match(hsScript, /interface="ether2"\]\] > 0\) do=\{ :set fitiWhy "port_in_use" \}/, 'a port with an IP address is never bridged');
  assert.match(hsScript, /in-interface="ether1" protocol=udp dst-port=53 action=drop/, 'the router DNS is not opened to the internet');
  assert.match(hsScript, /walled-garden add dst-host="kitale.wififiti.co.ke"/);
  assert.match(hsScript, /:set fitiHotspotServer "fiti-hotspot"/, 'the poller serves the new hotspot');
  assert.match(hsScript, /name="fiti-map"/, 'and keeps it after a reboot');
  assert.match(hsScript, /fiti-undo-9.*ip hotspot remove.*ip address remove \[find where comment=\\"Wi-Fi Fiti change 9\\"\]/, 'undo removes everything the hotspot added');

  // Customer Wi-Fi on a new hotspot bridge: radio on last, put back on undo.
  const wifiPlan = { bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['ether2', 'wlan1'], wifi: { ssid: 'Sirende WiFi', radios: [{ name: 'wlan1', type: 'wlan' }] } }], existing: [], moves: [] };
  const wifiReview = rc.reviewPlan(wifiPlan, parseRouterInventory(blank()));
  assert.match(wifiReview.changes[0].title, /Wi-Fi "Sirende WiFi"/);
  assert.match(wifiReview.changes[0].lines.join(' '), /Turn on wlan1 and broadcast the open Wi-Fi "Sirende WiFi"/);
  const wifiScript = rc.applyScript(wifiReview.changes[0], 11, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke' });
  assert.match(wifiScript, /:if \(\[:len \[\/interface wireless find where name="wlan1"\]\] != 1\) do=\{ :set fitiWhy "radio_missing" \}/, 'the radio must still be there');
  assert.ok(wifiScript.indexOf('name="fiti-radio-11-wlan1-ssid" source=') < wifiScript.indexOf('/interface wireless set [find where name="wlan1"] mode=ap-bridge'), 'the radio\'s old settings are kept before it changes');
  assert.ok(wifiScript.indexOf('/ip hotspot add name="fiti-hotspot"') < wifiScript.indexOf('/interface wireless set [find where name="wlan1"] mode=ap-bridge'), 'the radio turns on only once the hotspot is ready');
  assert.match(wifiScript, /mode=ap-bridge ssid="Sirende WiFi" security-profile="fiti-open-11" disabled=no/);
  const wifiUndo = rc.undoLines(wifiReview.changes[0], 11).join('\n');
  assert.match(wifiUndo, /\/interface wireless set \[find where name="wlan1"\] ssid=\$s mode=\$m security-profile=\$p disabled=\(\$d = "true"\)/, 'undo puts the radio back exactly');
  assert.ok(wifiUndo.indexOf('interface wireless set') < wifiUndo.indexOf('bridge remove'), 'the radio is restored before its bridge goes');

  // A radio that is on is the owner's Wi-Fi: customers get a separate
  // network on it and the owner's radio is never changed.
  const { validateNetworkPlan } = require('../src/lib/router-topology');
  const ownerLayout = parseRouterInventory(blank(['inv|if|bridge-home|bridge|up', 'inv|bport|bridge-home|wlan1', 'inv|addr|bridge-home', 'inv|dhcp-server|bridge-home|enabled']));
  const ownerRadio = ownerLayout.interfaces.find((i) => i.name === 'wlan1');
  assert.equal(ownerRadio.locked, true, 'the owner\'s Wi-Fi is in use');
  assert.equal(ownerRadio.shareWifi, true, 'but it can carry a separate customer network');
  const shared = validateNetworkPlan({ bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['ether2', 'wlan1'], wifi: { ssid: 'Kitale WiFi' } }] }, ownerLayout);
  assert.deepEqual(shared.bridges[0].wifi.radios, [{ name: 'wlan1', type: 'wlan', mode: 'virtual' }]);
  assert.deepEqual(shared.moves, [], 'the owner\'s radio does not leave its bridge');
  const offLayout = parseRouterInventory(blank(['inv|if|wlan1|wlan|disabled']).replace('inv|if|wlan1|wlan|up\n', ''));
  assert.equal(validateNetworkPlan({ bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['wlan1'], wifi: { ssid: 'Kitale WiFi' } }] }, offLayout).bridges[0].wifi.radios[0].mode, 'takeover',
    'a switched-off radio is simply turned on for customers');
  const stationWan = parseRouterInventory(['fiti-inventory-v2', 'inv|if|ether2|ether|up', 'inv|if|wlan1|wlan|up', 'inv|dhcp-client|wlan1|bound', 'inv|wan|wlan1|dhcp', 'fiti-inventory-end'].join('\n'));
  assert.equal(stationWan.interfaces.find((i) => i.name === 'wlan1').shareWifi, false, 'a radio that carries the internet is never used');
  const sharedReview = rc.reviewPlan(shared, ownerLayout);
  assert.match(sharedReview.changes[0].lines.join(' '), /Add a separate open Wi-Fi "Kitale WiFi" on wlan1 for customers\. Your own Wi-Fi on wlan1 keeps working exactly as it is/);
  assert.doesNotMatch(sharedReview.changes[0].lines.join(' '), /Add wlan1 to fiti-hs/);
  const sharedScript = rc.applyScript(sharedReview.changes[0], 12, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke' });
  assert.doesNotMatch(sharedScript, /\/interface wireless set/, 'the owner\'s radio settings are never changed');
  assert.doesNotMatch(sharedScript, /bridge port (add|find)[^\n]*interface="wlan1"/, 'nor is it moved or checked as a bridge port');
  assert.match(sharedScript, /\/interface wireless add name="fiti-wlan-12" master-interface="wlan1" mode=ap-bridge ssid="Kitale WiFi" security-profile="fiti-open-12" disabled=no/);
  assert.match(sharedScript, /\/interface bridge port add bridge="fiti-hs" interface="fiti-wlan-12"/);
  assert.match(sharedScript, /:set fitiWhy "radio_busy"/, 'a radio that is off or a client is refused before anything changes');
  assert.ok(sharedScript.indexOf('/ip hotspot add name="fiti-hotspot"') < sharedScript.indexOf('/interface wireless add name="fiti-wlan-12"'), 'the customer network appears only once the hotspot is ready');
  const sharedUndo = rc.undoLines(sharedReview.changes[0], 12).join('\n');
  assert.match(sharedUndo, /\/interface wireless remove \[find where name="fiti-wlan-12"\]/);
  assert.doesNotMatch(sharedUndo, /\/interface wireless set/);
  assert.ok(sharedUndo.indexOf('wireless remove') < sharedUndo.indexOf('security-profiles remove'), 'the network goes before its security profile');
  assert.match(sharedUndo, /:if \(\[:len \[\/interface find where name="fiti-wlan-12"\]\] > 0\) do=\{ :error "fiti-undo-incomplete" \}/);
  // A separate Wi-Fi Fiti network is not a free part of the router.
  const afterShare = parseRouterInventory(blank(['inv|if|fiti-wlan-12|wlan|up', 'inv|if|fiti-hs|bridge|up', 'inv|bport|fiti-hs|fiti-wlan-12', 'inv|fiti-bridge|fiti-hs']));
  const virtual = afterShare.interfaces.find((i) => i.name === 'fiti-wlan-12');
  assert.equal(virtual.physical, false); assert.equal(virtual.free, false); assert.equal(virtual.shareWifi, false);

  // A restart in the middle of a change is reported with the step it reached.
  assert.match(sharedScript, /\/system script add name="fiti-step-12"[^\n]* source="start"/);
  assert.match(sharedScript, /on-event="\/system script run fiti-reboot-12"/, 'the startup guard runs the restart reporter');
  assert.ok(sharedScript.indexOf('source="wifi"') < sharedScript.indexOf('/interface wireless add name="fiti-wlan-12"'), 'the step is saved before the Wi-Fi is added');
  assert.ok(sharedScript.indexOf('source="hotspot"') < sharedScript.indexOf('/ip hotspot add'), 'and before the hotspot is built');
  const reporter = sharedScript.match(/name="fiti-reboot-12"[^\n]*source="((?:[^"\\]|\\.)*)"/)[1].replace(/\\(["\\$nr])/g, (m, c) => ({ n: '\n', r: '' })[c] || c);
  assert.ok(reporter.indexOf('/system script run fiti-undo-12') < reporter.indexOf('/tool fetch'), 'the reporter undoes first, then reports');
  assert.match(reporter, /state=reverted&reason=" \. \$why/);
  assert.match(reporter, /:local why \("rebooted_" \. \$step\)/);

  // Blockers instead of risky guesses.
  const blocked = rc.reviewPlan({ bridges: [], existing: [{ interface: 'bridge-hs', job: 'pppoe' }, { interface: 'vlan9', job: 'pppoe' }], moves: [] },
    parseRouterInventory(rb951(['inv|if|vlan9|vlan|up', 'inv|vlan|vlan9|9|ether3'])));
  assert.match(blocked.blockers.join(' '), /PPPoE on the VLAN vlan9 is coming next/);
  const busyBridge = rc.reviewPlan({ bridges: [], existing: [{ interface: 'bridge-own', job: 'hotspot' }], moves: [] },
    parseRouterInventory(blank(['inv|if|bridge-own|bridge|up', 'inv|addr|bridge-own'])));
  assert.match(busyBridge.blockers[0], /already has its own IP address or DHCP server/);
  assert.equal(busyBridge.changes.length, 0);
  assert.match(rc.undoScript(7), /\/system script run fiti-undo-7/);
}

// ---- The cloud: review, apply, deliver, confirm, verify, undo ------------
let server;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function captureServer(...args) { server = this; return originalListen.apply(this, args); };
require('../src/server');
http.Server.prototype.listen = originalListen;

async function api(endpoint, { method = 'GET', body, token, routerToken, contentType } = {}) {
  await new Promise((resolve) => setImmediate(resolve));
  const headers = { Host: 'cloud.wififiti.co.ke' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routerToken) headers['X-WiFi-Fiti-Router'] = routerToken;
  if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, { method, headers,
    body: body === undefined ? undefined : (contentType ? body : JSON.stringify(body)) });
  const text = await response.text(); let parsedBody; try { parsedBody = JSON.parse(text); } catch (_) { parsedBody = text; }
  return { status: response.status, body: parsedBody, text };
}
async function createBusiness(email, name, phone) {
  const response = await api('/api/business/register', { method: 'POST',
    body: { name, ownerName: 'Owner', phone, email, password: 'test-password', plan: 'starter', collectionMode: 'fiti' } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.token;
}
async function pairedUniversal(token, name, report) {
  const created = await api('/api/business/router-setup', { method: 'POST', token, body: {
    name, routerName: 'router', mode: 'auto', routerOsVersion: '7', modelProfile: 'auto', autoRouterConfirmed: 'yes',
    customerBridge: 'bridge-hs', hotspotServer: 'hotspot1', wifiSsid: 'Shop WiFi', wifiPassword: 'SafeWifiPass9',
    customerSubnet: '10.5.51.0/24', wanMode: 'dhcp' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const location = created.body.location;
  const site = encodeURIComponent(location.id);
  await api(`/api/router/v1/bootstrap?site=${site}&vlan=1`, { routerToken: location.routerToken });
  const poll = (body = '', extra = '') => api(`/api/router/sync?site=${site}&ack=&protocol=2&health=awaiting-map&hotspot=&bridge=&kit=universal${extra}`,
    { method: 'POST', routerToken: location.routerToken, body, contentType: 'text/plain' });
  const first = await poll();
  const challenge = first.text.match(/:set fitiSetupAck "([^"]+)"/); assert.ok(challenge, first.text);
  const paired = await poll(report, `&setupAck=${encodeURIComponent(challenge[1])}`);
  assert.equal(paired.status, 200, paired.text);
  const answer = (query) => api(`/api/router/change?site=${site}&${query}`, { routerToken: location.routerToken });
  return { location, site, poll, answer };
}

(async () => {
  const db = require('../src/lib/db').db;
  const pppoe = require('../src/lib/pppoe');
  const alpha = await createBusiness('changes-alpha@example.test', 'Changes Alpha', '0712000101');
  const bravo = await createBusiness('changes-bravo@example.test', 'Changes Bravo', '0712000102');
  const kitale = await pairedUniversal(alpha, 'Kitale', rb951());
  const base = `/api/business/locations/${kitale.site}`;

  // Save the owner's map: PPPoE on ether4 (moved out of bridge-hs) and ether5.
  const saved = await api(`${base}/network-plan`, { method: 'PUT', token: alpha, body: { plan: {
    bridges: [{ name: 'fiti-pppoe', job: 'pppoe', ports: ['ether4', 'ether5'] }], existing: [{ interface: 'bridge-hs', job: 'hotspot' }] } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const review = await api(`${base}/network-plan/review`, { token: alpha });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.review.canApply, true, JSON.stringify(review.body.review.blockers));
  assert.equal(review.body.review.changes.length, 1);
  assert.equal((await api(`${base}/network-plan/review`, { token: bravo })).status, 404, 'another business cannot see it');
  assert.equal((await api(`${base}/network-plan/apply`, { method: 'POST', token: bravo, body: { confirm: true } })).status, 404, 'or apply it');
  assert.equal((await api(`${base}/network-plan/apply`, { method: 'POST', token: alpha, body: {} })).status, 400, 'applying needs an explicit confirm');
  assert.equal(pppoe.customerBridgeFor(kitale.location.id), '', 'PPPoE has nowhere to run before the map is applied');

  const applied = await api(`${base}/network-plan/apply`, { method: 'POST', token: alpha, body: { confirm: true } });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.changes[0].status, 'queued');
  assert.equal((await api(`${base}/network-plan/apply`, { method: 'POST', token: alpha, body: { confirm: true } })).status, 409, 'one batch at a time');

  // The next poll carries the change; the one after waits for the answer.
  const delivered = await kitale.poll(rb951());
  assert.match(delivered.text, /interval=1s disabled=no/, 'the router checks in every second while a change is in flight');
  const id = (delivered.text.match(/# Wi-Fi Fiti network change (\d+)/) || [])[1];
  assert.ok(id, 'the change is in the poll reply');
  assert.match(delivered.text, /\/interface bridge add name="fiti-pppoe"/);
  assert.doesNotMatch((await kitale.poll(rb951())).text, /network change/, 'never sent twice while waiting');
  assert.equal((await api(`/api/router/change?site=${kitale.site}&id=${id}&state=applied`)).status, 403, 'the router credential is required');

  // The router reaches the cloud again: confirmed, then the report verifies it.
  const confirm = await kitale.answer(`id=${id}&state=applied`);
  assert.equal(confirm.text, 'confirmed');
  const topo = () => api(`${base}/router-topology`, { token: alpha });
  assert.equal((await topo()).body.changes[0].status, 'confirming');
  assert.equal((await kitale.answer(`id=${id}&state=applied`)).text, 'confirmed', 'a lost reply can be asked for again');
  assert.doesNotMatch((await kitale.poll(rb951())).text, /network change/, 'nothing else is sent until the router says it kept it');
  await kitale.answer(`id=${id}&state=kept`);
  assert.equal((await topo()).body.changes[0].status, 'applied');
  assert.equal((await topo()).body.plan, null, 'a fully applied map is cleared');
  assert.equal(pppoe.customerBridgeFor(kitale.location.id), 'fiti-pppoe', 'the PPPoE page now runs its server on the mapped bridge');
  const after = rb951(['inv|if|fiti-pppoe|bridge|up', 'inv|fiti-bridge|fiti-pppoe', 'inv|bport|fiti-pppoe|ether4', 'inv|bport|fiti-pppoe|ether5'])
    .replace('inv|bport|bridge-hs|ether4\n', '');
  await kitale.poll(after);
  const verified = (await topo()).body.changes[0];
  assert.equal(verified.status, 'verified', 'the layout report shows what was planned');
  assert.equal(verified.canUndo, true);
  assert.equal((await kitale.answer(`id=${id}&state=applied`)).text, 'not-confirmed', 'a settled change is not re-confirmed');

  // Rename the bridge on the router; PPPoE follows it.
  const renameUrl = `${base}/network-changes/${id}/rename`;
  assert.equal((await api(renameUrl, { method: 'POST', token: bravo, body: { name: 'fiti-ppp' } })).status, 404, 'another business cannot rename it');
  assert.equal((await api(renameUrl, { method: 'POST', token: alpha, body: { name: 'bridge-hs' } })).status, 400, 'a name already on the router is refused');
  assert.equal((await api(renameUrl, { method: 'POST', token: alpha, body: { name: 'bad name' } })).status, 400);
  const renamed = await api(renameUrl, { method: 'POST', token: alpha, body: { name: 'fiti-ppp' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const renameReply = await kitale.poll(after);
  const renameId = (renameReply.text.match(/# Wi-Fi Fiti network change (\d+): rename fiti-pppoe to fiti-ppp/) || [])[1];
  assert.ok(renameId, renameReply.text.slice(0, 300));
  assert.match(renameReply.text, /\/interface bridge set \[find where name="fiti-pppoe"\] name="fiti-ppp"/);
  assert.match(renameReply.text, /not_fiti_bridge/, 'only a bridge Wi-Fi Fiti built is renamed');
  assert.match(renameReply.text, /fiti-undo-.*name=\\"fiti-ppp\\"\] name=\\"fiti-pppoe\\"/, 'its undo renames it back');
  assert.equal((await kitale.answer(`id=${renameId}&state=applied`)).text, 'confirmed');
  await kitale.answer(`id=${renameId}&state=kept`);
  assert.equal(pppoe.customerBridgeFor(kitale.location.id), 'fiti-ppp', 'the PPPoE page follows the new name');
  const renamedLayout = after.replace(/fiti-pppoe/g, 'fiti-ppp');
  await kitale.poll(renamedLayout);
  const afterRename = (await topo()).body.changes;
  assert.equal(afterRename.find((c) => String(c.id) === renameId).status, 'verified');
  assert.equal(afterRename.find((c) => String(c.id) === id).currentName, 'fiti-ppp');
  assert.equal(afterRename.find((c) => String(c.id) === id).status, 'verified', 'the renamed bridge still checks out');
  const blockedByRename = await api(`${base}/network-changes/${id}/undo`, { method: 'POST', token: alpha });
  assert.equal(blockedByRename.status, 409);
  assert.match(blockedByRename.body.error, /Undo the rename to fiti-ppp first/);
  assert.equal((await api(`${base}/network-changes/${renameId}/undo`, { method: 'POST', token: alpha })).status, 200);
  assert.match((await kitale.poll(renamedLayout)).text, new RegExp(`/system script run fiti-undo-${renameId}`));
  await kitale.answer(`id=${renameId}&state=undone`);
  assert.equal(pppoe.customerBridgeFor(kitale.location.id), 'fiti-pppoe', 'undoing the rename brings the old name back');

  // Undo one change later.
  assert.equal((await api(`${base}/network-changes/${id}/undo`, { method: 'POST', token: bravo })).status, 404);
  const undo = await api(`${base}/network-changes/${id}/undo`, { method: 'POST', token: alpha });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  const undoReply = await kitale.poll(after);
  assert.match(undoReply.text, new RegExp(`/system script run fiti-undo-${id}`));
  await kitale.answer(`id=${id}&state=undone`);
  assert.equal((await topo()).body.changes[0].status, 'undone');
  assert.equal(pppoe.customerBridgeFor(kitale.location.id), '', 'after undo PPPoE has no mapped bridge again');

  // Undo order: a change that took a port from this bridge is undone first.
  const insert = db.prepare(`INSERT INTO tenant_router_changes (location_id, batch_id, seq, kind, target, job, spec_json, status, reason) VALUES (?, 'bx', 0, 'bridge', ?, ?, ?, ?, ?)`);
  const hsRow = insert.run(kitale.location.id, 'fiti-a', 'hotspot', JSON.stringify({ title: 'fiti-a', ports: ['ether2'], moves: [] }), 'verified', null).lastInsertRowid;
  insert.run(kitale.location.id, 'fiti-b', 'pppoe', JSON.stringify({ title: 'fiti-b', ports: ['ether2'], moves: [{ interface: 'ether2', from: 'fiti-a' }] }), 'verified', null);
  const blockedUndo = await api(`${base}/network-changes/${hsRow}/undo`, { method: 'POST', token: alpha });
  assert.equal(blockedUndo.status, 409);
  assert.match(blockedUndo.body.error, /Undo fiti-b first/);
  const partial = insert.run(kitale.location.id, 'fiti-c', 'hotspot', JSON.stringify({ title: 'fiti-c', ports: [], moves: [] }), 'failed', 'undo_incomplete').lastInsertRowid;
  assert.equal((await topo()).body.changes.find((c) => c.id === Number(partial)).canUndo, true, 'a partial undo can be finished from the dashboard');
  db.prepare(`DELETE FROM tenant_router_changes WHERE batch_id='bx'`).run();

  // A preflight failure stops the rest of the batch.
  const hap = await pairedUniversal(bravo, 'Hap', blank());
  const hapBase = `/api/business/locations/${hap.site}`;
  assert.equal((await api(`${hapBase}/network-plan`, { method: 'PUT', token: bravo, body: { plan: {
    bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['ether2', 'wlan1'], wifi: { ssid: 'Hap WiFi' } }, { name: 'fiti-ppp', job: 'pppoe', ports: ['ether3'] }] } } })).status, 200);
  const two = await api(`${hapBase}/network-plan/apply`, { method: 'POST', token: bravo, body: { confirm: true } });
  assert.deepEqual(two.body.changes.map((c) => c.job).reverse(), ['hotspot', 'pppoe'], 'the hotspot is applied first');
  const hsReply = await hap.poll(blank());
  const hsId = (hsReply.text.match(/# Wi-Fi Fiti network change (\d+)/) || [])[1];
  assert.match(hsReply.text, /\/ip hotspot add name="fiti-hotspot" interface="fiti-hs"/);
  await hap.answer(`id=${hsId}&state=failed&reason=no_free_subnet`);
  const hapChanges = (await api(`${hapBase}/router-topology`, { token: bravo })).body.changes;
  assert.equal(hapChanges.find((c) => String(c.id) === hsId).status, 'failed');
  assert.equal(hapChanges.find((c) => c.job === 'pppoe').status, 'cancelled', 'nothing else is sent after a failure');
  assert.ok((await api(`${hapBase}/router-topology`, { token: bravo })).body.plan, 'a failed map is kept to fix and retry');
  assert.doesNotMatch((await hap.poll(blank())).text, /network change/);

  // A stale report blocks applying; so does a router on another kit.
  db.prepare(`UPDATE tenant_router_inventory SET reported_at=datetime('now','-10 minutes') WHERE location_id=?`).run(hap.location.id);
  assert.equal((await api(`${hapBase}/network-plan/apply`, { method: 'POST', token: bravo, body: { confirm: true } })).status, 409);
  db.prepare(`UPDATE locations SET router_kit=NULL WHERE id=?`).run(hap.location.id);
  assert.equal((await api(`${hapBase}/network-plan/review`, { token: bravo })).status, 409);
  db.prepare(`UPDATE locations SET router_kit='universal' WHERE id=?`).run(hap.location.id);

  // An unanswered change times out instead of blocking forever.
  db.prepare(`UPDATE tenant_router_inventory SET reported_at=datetime('now') WHERE location_id=?`).run(hap.location.id);
  assert.equal((await api(`${hapBase}/network-plan/apply`, { method: 'POST', token: bravo, body: { confirm: true } })).status, 200);
  const retry = await hap.poll(blank());
  const retryId = (retry.text.match(/# Wi-Fi Fiti network change (\d+)/) || [])[1];
  db.prepare(`UPDATE tenant_router_changes SET updated_at=datetime('now','-5 minutes') WHERE id=?`).run(Number(retryId));
  await hap.poll(blank());
  assert.equal((await api(`${hapBase}/router-topology`, { token: bravo })).body.changes.find((c) => String(c.id) === retryId).status, 'sent',
    'still waiting after 5 minutes: the router may still be trying to confirm');
  assert.equal((await hap.answer(`id=${retryId}&state=applied`)).text, 'confirmed', 'a slow router is still confirmed');
  db.prepare(`UPDATE tenant_router_changes SET status='sent', updated_at=datetime('now','-9 minutes') WHERE id=?`).run(Number(retryId));
  await hap.poll(blank());
  const timedOut = (await api(`${hapBase}/router-topology`, { token: bravo })).body.changes.find((c) => String(c.id) === retryId);
  assert.equal(timedOut.status, 'no-answer');
  // The router restarted in the middle: its startup guard put everything
  // back and says so once it is online again, even after the timeout.
  assert.match(retry.text, new RegExp(`fiti-wlan-${retryId}" master-interface="wlan1"`), 'the Hap\'s radio (on) gets a separate customer network');
  await hap.answer(`id=${retryId}&state=reverted&reason=rebooted_wifi`);
  const rebooted = (await api(`${hapBase}/router-topology`, { token: bravo })).body.changes.find((c) => String(c.id) === retryId);
  assert.equal(rebooted.status, 'reverted'); assert.equal(rebooted.reason, 'rebooted_wifi');

  // A shared radio is verified by its customer network in the bridge.
  const rcm = require('../src/lib/router-changes');
  const vRow = Number(insert.run(hap.location.id, 'fiti-v', 'hotspot', JSON.stringify({ title: 'fiti-v', ports: ['ether2', 'wlan1'], moves: [],
    wifi: { ssid: 'V', radios: [{ name: 'wlan1', type: 'wlan', mode: 'virtual' }] } }), 'applied', null).lastInsertRowid);
  rcm.recheck(hap.location.id, parseRouterInventory(blank([`inv|if|fiti-v|bridge|up`, `inv|if|fiti-wlan-${vRow}|wlan|up`, 'inv|bport|fiti-v|ether2', `inv|bport|fiti-v|fiti-wlan-${vRow}`, 'inv|hotspot|fiti-hotspot|fiti-v'])));
  assert.equal(db.prepare('SELECT status FROM tenant_router_changes WHERE id=?').get(vRow).status, 'verified');

  // Deleting a router removes its change history.
  assert.equal((await api(`${hapBase}`, { method: 'DELETE', token: bravo, body: { confirm: 'DELETE' } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_router_changes WHERE location_id=?').get(hap.location.id).n, 0);

  console.log('Router changes: preflight, undo first, boot guard, cloud confirm, verify, undo, one at a time, owner-only - passed');
  server.close(); process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

'use strict';

/*
 * Universal kit (test slot): pairs a router in any state without changing its
 * network, reports its full layout, and the cloud holds Hotspot/PPPoE work and
 * never opens a Wi-Fi until the owner maps it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const databasePath = '/tmp/wifi-fiti-universal-kit.db';
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(databasePath + suffix); } catch (_) {} }
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://cloud.wififiti.co.ke', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke', MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  PROVISION_MODE: 'poll', SITE_TOKEN: 'universal-site-token', TENANT_SECRETS_KEY: 'universal-kit-key',
  ADMIN_TOKEN: 'universal-admin', DATABASE_PATH: databasePath,
});

const { buildUniversalRouterKit } = require('../src/lib/router-setup');
const { universalInstaller, inventoryScriptLines } = require('../src/lib/router-kit');
const { parseRouterInventory, validateNetworkPlan } = require('../src/lib/router-topology');

// Commands that would change a router's network. The universal kit and its
// layout report must contain none of them.
const NETWORK_CHANGES = /\/(?:interface (?:bridge|vlan|wireless|wifi|ethernet|pppoe-client|pppoe-server server|bridge port) (?:add|set|remove)|interface bridge port (?:add|set|remove)|ip (?:address|pool|dhcp-server|dhcp-client|route|firewall (?:filter|nat|mangle)|dns) (?:add|set|remove)|interface (?:wireless|wifi) security-profiles)/;
function braces(text) {
  let depth = 0;
  for (const ch of text.replace(/"(?:[^"\\]|\\.)*"/g, '')) { if (ch === '{') depth++; if (ch === '}') depth--; if (depth < 0) return false; }
  return depth === 0;
}
function decodeScriptSource(text, marker) {
  let i = text.indexOf(marker); assert.ok(i >= 0, 'script source present'); i += marker.length;
  let out = '';
  for (;;) {
    const c = text[i];
    if (c === '"') break;
    if (c === '\\') { const n = text[i + 1]; if (n === '\n') { i += 2; continue; } const m = { '\\': '\\', '"': '"', $: '$', '?': '?', n: '\n', r: '\r' }[n]; assert.ok(m !== undefined, `valid escape \\${n}`); out += m; i += 2; continue; }
    assert.notEqual(c, '\n', 'no raw newline inside a RouterOS string');
    out += c; i++;
  }
  return out;
}

// ---- The kit -------------------------------------------------------------
const kit = buildUniversalRouterKit({ location: { id: 'loc-universal-test' }, token: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  appUrl: 'https://cloud.wififiti.co.ke', portalUrl: 'https://kitale.wififiti.co.ke' });
assert.match(kit, /UNIVERSAL KIT \(TEST\)/);
assert.doesNotMatch(kit, NETWORK_CHANGES, 'the universal kit changes no interface, VLAN, address, DHCP, PPPoE or firewall');
assert.match(kit, /\/tenant-router-install-universal\.rsc/);
assert.doesNotMatch(kit, /\/tenant-router-install\.rsc/, 'it never pulls the stable installer that requires a Hotspot');
assert.match(kit, /:global fitiBridge ""/, 'no bridge name is assumed');
assert.match(kit, /:global fitiHotspotServer ""/, 'no Hotspot name is assumed');
assert.match(kit, /\[:len \$fitiBootstrapHotspots\] = 1\) do=\{ :local fitiBootstrapHotspot/, 'a single existing Hotspot is adopted as it is');
assert.ok(braces(kit), 'the kit has balanced blocks');
assert.throws(() => buildUniversalRouterKit({ location: { id: 'bad id' }, token: 'x', appUrl: 'https://a.test' }));

// ---- The installer ------------------------------------------------------
const stable = fs.readFileSync(path.join(__dirname, '..', 'public', 'tenant-router-install.rsc'), 'utf8');
const installer = universalInstaller(stable);
assert.match(installer, /UNIVERSAL KIT INSTALLER/);
assert.match(installer, /awaiting-map/);
assert.match(installer, /&kit=universal/);
assert.doesNotMatch(installer, /set fitiHotspotServer "hotspot1"/, 'no hotspot1 default');
assert.doesNotMatch(installer, /set fitiBridge "bridge-hs"/, 'no bridge-hs default');
assert.match(installer, /paired without a Hotspot/);
assert.ok(braces(installer.split('/system script add name=fiti-poll')[0]), 'installer top-level blocks balance');
const inventorySource = decodeScriptSource(installer, 'name=fiti-inventory policy=read,test source="');
assert.equal(inventorySource, inventoryScriptLines().join('\r\n') + '\r\n', 'the layout report is embedded exactly');
assert.doesNotMatch(inventorySource, NETWORK_CHANGES, 'the layout report is read-only');
assert.match(inventorySource, /\/interface bridge find where comment~"Wi-Fi Fiti"\]/, 'the report names the bridges Wi-Fi Fiti built');
assert.doesNotMatch(installer, /scheduler add name=fiti-inventory/, 'no separate layout timer: the poll reply runs the report');
assert.ok(braces(inventorySource));
assert.doesNotMatch(inventorySource, /dynamic=no/, 'the generic interface find (returns only bridges on RouterOS 7.24) is not used');
for (const menu of ['ethernet', 'wireless', 'wifi', 'bridge', 'vlan', 'pppoe-client', 'lte', 'wireguard']) {
  assert.match(inventorySource, new RegExp(`\\[/interface ${menu} find\\]`), `interfaces are listed from the ${menu} menu`);
}
assert.match(inventorySource, /inv\|agent\|4/);
const pollerSource = decodeScriptSource(installer, 'name=fiti-poll policy=read,write,ftp,test,policy source="');
assert.match(pollerSource, /:global fitiInventory/);
assert.match(pollerSource, /:set report \(\$report \. \$fitiInventory\)/, 'the poller sends the layout report with its sync');
assert.ok(braces(pollerSource));
assert.equal(stable, fs.readFileSync(path.join(__dirname, '..', 'public', 'tenant-router-install.rsc'), 'utf8'), 'the stable installer is untouched');

// ---- The layout report --------------------------------------------------
function layout(extra = []) {
  return ['fiti-inventory-v2', 'inv|system|routeros|7.24.2', 'inv|board|hAP_lite',
    'inv|if|ether1|ether|up', 'inv|if|ether2|ether|down', 'inv|if|ether3|ether|up', 'inv|if|ether4|ether|up', 'inv|if|pwr-line1|ether|down',
    'inv|if|wlan1|wlan|up', 'inv|if|vlan100|vlan|up', 'inv|if|pppoe-out1|pppoe-out|up', 'inv|if|bridge-tv|bridge|up',
    'inv|vlan|vlan100|100|ether1', 'inv|pppoe-client|pppoe-out1|vlan100', 'inv|bport|bridge-tv|ether4',
    'inv|addr|bridge-tv', 'inv|dhcp-server|bridge-tv|enabled', 'inv|wan|pppoe-out1|pppoe', ...extra, 'fiti-inventory-end'].join('\n') + '\n';
}
const parsed = parseRouterInventory('usage-line\n' + layout(['inv|brand-new-record|x']));
const byName = Object.fromEntries(parsed.interfaces.map((i) => [i.name, i]));
assert.deepEqual(parsed.wan, { interface: 'pppoe-out1', kind: 'pppoe' });
for (const name of ['pppoe-out1', 'vlan100', 'ether1']) assert.equal(byName[name].internet, true, `${name} is on the internet path`);
assert.equal(byName.ether1.locked, true);
assert.match(byName.ether1.usage.join(), /VLAN 100/);
assert.equal(byName.ether4.free, false, 'a bridge member is in use');
assert.equal(byName['bridge-tv'].locked, true);
assert.deepEqual(byName['bridge-tv'].members, ['ether4']);
assert.deepEqual(parsed.freeInterfaces.sort(), ['ether2', 'ether3', 'pwr-line1', 'wlan1']);
assert.equal(parseRouterInventory('no report here'), null);
assert.throws(() => parseRouterInventory('fiti-inventory-v2\ninv|if|bad name|ether|up\nfiti-inventory-end'));
assert.throws(() => parseRouterInventory('fiti-inventory-v2\ninv|vlan|v|9999|ether1\ninv|if|ether1|ether|up\nfiti-inventory-end'));
assert.throws(() => parseRouterInventory('fiti-inventory-v2\ninv|if|ether1|ether|up\n'), 'an unterminated report is refused');
const serialized = JSON.stringify(parsed);
for (const forbidden of ['"address"', '"mac"', '"password"', '"secret"', '"token"', '"route"']) assert.ok(!serialized.includes(forbidden), `no ${forbidden} field`);

// ---- The network map (stage 2: saved plan only) ---------------------------
const plan = validateNetworkPlan({ bridges: [{ name: 'bridge-guests', job: 'hotspot', ports: ['wlan1', 'ether3'], wifi: { ssid: 'Guest WiFi' } }],
  existing: [{ interface: 'bridge-tv', job: 'pppoe' }] }, parsed);
assert.deepEqual(plan, { version: 1, bridges: [{ name: 'bridge-guests', job: 'hotspot', ports: ['ether3', 'wlan1'], wifi: { ssid: 'Guest WiFi', radios: [{ name: 'wlan1', type: 'wlan' }] } }],
  existing: [{ interface: 'bridge-tv', job: 'pppoe', alreadyRunning: false }], moves: [], keep: [] });
const refuses = (input, pattern, why) => assert.throws(() => validateNetworkPlan(input, parsed), (e) => e.status === 400 && pattern.test(e.message), why);
refuses({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether4'] }] }, /already in use/, 'a port in use stays as it is');
refuses({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether1'] }] }, /already in use/, 'the internet port cannot be moved');
refuses({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether2'] }, { name: 'b2', job: 'pppoe', ports: ['ether2'] }] }, /one bridge/);
refuses({ bridges: [{ name: 'bridge-tv', job: 'hotspot', ports: ['ether2'] }] }, /already exists/);
refuses({ bridges: [{ name: 'bad name', job: 'hotspot', ports: ['ether2'] }] }, /short name/);
refuses({ bridges: [{ name: 'b1', job: 'dns', ports: ['ether2'] }] }, /Hotspot or PPPoE/);
refuses({ bridges: [{ name: 'b1', job: 'hotspot', ports: [] }] }, /at least one/);
refuses({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether9'] }] }, /latest report/);
refuses({ existing: [{ interface: 'vlan100', job: 'hotspot' }] }, /internet/, 'the internet VLAN is locked');
refuses({ existing: [{ interface: 'ether2', job: 'hotspot' }] }, /bridge or VLAN/);
refuses({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether2'] }], existing: [{ interface: 'bridge-tv', job: 'hotspot' }] }, /one place for hotspot/);
refuses({}, /first/);
assert.deepEqual(validateNetworkPlan({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether2'] }], keep: ['ether3'] }, parsed).keep, ['ether3'], 'a port can be kept for management');
refuses({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether3'] }], keep: ['ether3'] }, /reserved for managing/, 'a kept port never goes into a customer bridge');
refuses({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether2'] }], keep: ['ether1'] }, /internet/);
// Customer Wi-Fi: a radio (even a switched-off one) can join a hotspot bridge with a name.
const radioLayout = parseRouterInventory(['fiti-inventory-v2', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|wlan1|wlan|disabled', 'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', 'fiti-inventory-end'].join('\n'));
assert.equal(radioLayout.interfaces.find((i) => i.name === 'wlan1').free, true, 'a switched-off radio with no job is free to use');
assert.deepEqual(validateNetworkPlan({ bridges: [{ name: 'fiti-hotspot', job: 'hotspot', ports: ['wlan1', 'ether2'], wifi: { ssid: 'Sirende WiFi' } }] }, radioLayout).bridges[0].wifi,
  { ssid: 'Sirende WiFi', radios: [{ name: 'wlan1', type: 'wlan' }] });
assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'fiti-hotspot', job: 'hotspot', ports: ['wlan1'] }] }, radioLayout), /Give the customer Wi-Fi/, 'a hotspot Wi-Fi needs a name');
assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'fiti-hotspot', job: 'hotspot', ports: ['wlan1'], wifi: { ssid: 'Bad"Name' } }] }, radioLayout), /without quotes/);
assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'fiti-pppoe', job: 'pppoe', ports: ['wlan1'], wifi: { ssid: 'x' } }] }, radioLayout), /Wi-Fi can only join a hotspot bridge/, 'PPPoE customers connect by cable');
assert.equal(validateNetworkPlan({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether2'], wifi: { ssid: 'ignored' } }] }, radioLayout).bridges[0].wifi, undefined, 'no radio, no Wi-Fi');
assert.throws(() => validateNetworkPlan({ existing: [] }, null), (e) => e.status === 409);
// Ports in a bridge Wi-Fi Fiti built may move; ports in the owner's bridges may not.
const fitiLayout = parseRouterInventory(['fiti-inventory-v2', 'inv|agent|3', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up', 'inv|if|ether4|ether|up',
  'inv|if|ether5|ether|up', 'inv|if|wlan1|wlan|up', 'inv|if|bridge-hs|bridge|up', 'inv|if|bridge-own|bridge|up', 'inv|fiti-bridge|bridge-hs',
  'inv|bport|bridge-hs|ether2', 'inv|bport|bridge-hs|ether3', 'inv|bport|bridge-hs|wlan1', 'inv|bport|bridge-own|ether4', 'inv|bport|bridge-own|ether5',
  'inv|vlan|vlan9|9|ether3', 'inv|if|vlan9|vlan|up', 'inv|hotspot|hotspot1|bridge-hs', 'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', 'fiti-inventory-end'].join('\n'));
assert.deepEqual(fitiLayout.fitiBridges, ['bridge-hs']);
assert.deepEqual(fitiLayout.movableInterfaces.sort(), ['ether2', 'wlan1'], 'only ports whose one job is the Wi-Fi Fiti bridge can move (ether3 also carries a VLAN)');
assert.deepEqual(fitiLayout.freeInterfaces, [], 'nothing is free on this router');
const moved = validateNetworkPlan({ bridges: [{ name: 'fiti-pppoe', job: 'pppoe', ports: ['ether2'] }] }, fitiLayout);
assert.deepEqual(moved.moves, [{ interface: 'ether2', from: 'bridge-hs' }], 'the plan records which port leaves which bridge');
assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'b1', job: 'pppoe', ports: ['ether4'] }] }, fitiLayout), /already in use/, "the owner's own bridge stays locked");
assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'b1', job: 'pppoe', ports: ['ether3'] }] }, fitiLayout), /already in use/);
const oneLeft = parseRouterInventory(['fiti-inventory-v2', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|bridge-hs|bridge|up', 'inv|fiti-bridge|bridge-hs',
  'inv|bport|bridge-hs|ether2', 'inv|wan|ether1|dhcp', 'fiti-inventory-end'].join('\n'));
assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'b1', job: 'pppoe', ports: ['ether2'] }] }, oneLeft), /at least one port in bridge-hs/, 'a Wi-Fi Fiti bridge is never emptied');
assert.deepEqual(plan.moves, [], 'a plan of free ports moves nothing');
const withHotspot = parseRouterInventory(layout(['inv|hotspot|hotspot1|bridge-tv']));
assert.equal(withHotspot.hotspots.length, 1);
{
  assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether2'] }] }, withHotspot), /already runs a hotspot on bridge-tv/, 'no second hotspot');
  assert.equal(validateNetworkPlan({ existing: [{ interface: 'bridge-tv', job: 'hotspot' }] }, withHotspot).existing[0].alreadyRunning, true);
}

// ---- The cloud: pairing, held work, no open Wi-Fi, layout for the owner --
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
async function createBusiness(email, name) {
  const response = await api('/api/business/register', { method: 'POST',
    body: { name, ownerName: 'Owner', phone: '0712000000', email, password: 'test-password', plan: 'starter', collectionMode: 'fiti' } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.token;
}

(async () => {
  const db = require('../src/lib/db').db;
  const alpha = await createBusiness('universal-alpha@example.test', 'Universal Alpha');
  const bravo = await createBusiness('universal-bravo@example.test', 'Universal Bravo');
  const created = await api('/api/business/router-setup', { method: 'POST', token: alpha, body: {
    name: 'Kitale', routerName: 'hAP lite', mode: 'auto', routerOsVersion: '7', modelProfile: 'auto', autoRouterConfirmed: 'yes',
    customerBridge: 'bridge-hs', hotspotServer: 'hotspot1', wifiSsid: 'Kitale WiFi', wifiPassword: 'SafeWifiPass9',
    customerSubnet: '10.5.51.0/24', wanMode: 'dhcp' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const location = created.body.location;
  const site = encodeURIComponent(location.id);

  const universalKit = await api(`/api/router/v1/bootstrap?site=${site}&vlan=1`, { routerToken: location.routerToken });
  assert.equal(universalKit.status, 200, universalKit.text);
  assert.match(universalKit.text, /UNIVERSAL KIT \(TEST\)/, 'the fourth kit slot is now the universal kit');
  assert.match(universalKit.text, /\/file remove \[find where name="fiti\.rsc"\]/, 'the downloaded kit removes its own file');
  assert.doesNotMatch(universalKit.text, NETWORK_CHANGES);
  assert.doesNotMatch(universalKit.text, /Kitale WiFi|SafeWifiPass9/, 'none of the automatic kit\'s Wi-Fi settings are applied');
  const standardKit = await api(`/api/router/v1/bootstrap?site=${site}`, { routerToken: location.routerToken });
  assert.match(standardKit.text, /automatic RouterOS 7 setup kit/, 'the standard kit is unchanged');
  assert.equal((await api(`/api/router/v1/bootstrap?site=${site}&vlan=1`)).status, 403, 'the router credential is required');

  const compatKit = await api(`/api/router/v1/bootstrap?site=${site}&vlan=1&compat=1`, { routerToken: location.routerToken });
  assert.equal(compatKit.status, 200, compatKit.text);
  assert.match(compatKit.text, /UNIVERSAL KIT \(TEST\)/);
  assert.match(compatKit.text, /tenant-router-install-universal-compat\.rsc/, 'the CA-compatibility universal kit pulls its own installer');
  assert.doesNotMatch(compatKit.text, /check-certificate=yes/);
  assert.doesNotMatch(compatKit.text, NETWORK_CHANGES);
  const compatInstaller = await api('/tenant-router-install-universal-compat.rsc');
  assert.equal(compatInstaller.status, 200);
  assert.match(compatInstaller.text, /awaiting-map/);
  assert.match(compatInstaller.text, /&kit=universal/);
  assert.doesNotMatch(compatInstaller.text, /check-certificate=yes/, 'its poller syncs without certificate checks, like the standard compatibility installer');
  const roots = await api('/router-roots.pem');
  assert.equal(roots.status, 200);
  const { X509Certificate } = require('node:crypto');
  const servedRoots = roots.text.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((p) => p.trim()).map((pem) => new X509Certificate(pem));
  assert.deepEqual(servedRoots.map((c) => c.subject.split('\n').find((l) => l.startsWith('CN='))), ['CN=ISRG Root X1', 'CN=ISRG Root X2', 'CN=GTS Root R1', 'CN=GTS Root R4'],
    'the public roots file holds exactly the four roots the connection kit pins');
  const served = await api('/tenant-router-install-universal.rsc');
  assert.equal(served.status, 200);
  assert.equal(served.text, installer);

  // Pairing: awaiting-map is accepted only from the universal kit.
  const query = (extra) => `/api/router/sync?site=${site}&ack=&protocol=2&health=awaiting-map&hotspot=&bridge=${extra}`;
  const stranger = await api(query(''), { method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain' });
  const strangerChallenge = stranger.text.match(/:set fitiSetupAck "([^"]+)"/);
  assert.ok(strangerChallenge);
  const notUniversal = await api(query(`&setupAck=${encodeURIComponent(strangerChallenge[1])}`), { method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain' });
  assert.match(notUniversal.text, /fitiSetupAck/, 'a stable-kit router without a Hotspot is not paired');
  assert.equal(db.prepare('SELECT router_setup_verified_at FROM locations WHERE id=?').get(location.id).router_setup_verified_at, null);

  const first = await api(query('&kit=universal'), { method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain' });
  const challenge = first.text.match(/:set fitiSetupAck "([^"]+)"/); assert.ok(challenge, first.text);
  // Queue work that assumes a Hotspot, then check it is held.
  db.prepare(`INSERT INTO tenant_jobs (location_id, username, password, profile, total_seconds, action) VALUES (?, '254700000001-ABCDEF12', 'pw', 'standard', 3600, 'upsert')`).run(location.id);
  const paired = await api(query(`&kit=universal&setupAck=${encodeURIComponent(challenge[1])}`), { method: 'POST', routerToken: location.routerToken, body: layout(), contentType: 'text/plain' });
  assert.equal(paired.status, 200, paired.text);
  const row = db.prepare('SELECT router_setup_verified_at, router_setup_health, router_kit, wifi_interface FROM locations WHERE id=?').get(location.id);
  assert.ok(row.router_setup_verified_at, 'the universal kit pairs a router that has no Hotspot');
  assert.equal(row.router_setup_health, 'awaiting-map');
  assert.equal(row.router_kit, 'universal');
  assert.ok(row.wifi_interface, 'the location still has a saved Wi-Fi interface from its setup form');
  for (const response of [paired]) {
    assert.doesNotMatch(response.text, /security-profiles|security\.passphrase|authentication-types/, 'a universal-kit router\'s Wi-Fi is never opened');
    assert.doesNotMatch(response.text, /\/ip hotspot user|254700000001/, 'Hotspot work is held until the router is mapped');
    assert.doesNotMatch(response.text, /pppoe-server server (?:add|set)|\/ppp secret|login\.html/, 'no PPPoE or portal work either');
  }
  // A router on the old layout report (no agent line) gets the current one in place.
  const { inventoryScriptLines: currentLines } = require('../src/lib/router-kit');
  const update = paired.text.match(/\/system script set \[find where name="fiti-inventory"\] policy=read,test source="((?:[^"\\]|\\.)*)"/);
  assert.ok(update, 'an old layout report is replaced on the next poll');
  assert.match(paired.text, /\/system script set \[find where name="fiti-inventory"\] policy=read,test source=/, 'the update keeps the report able to read the router');
  const decodedUpdate = update[1].replace(/\\(["\\$nr])/g, (m, c) => ({ n: '\n', r: '\r' })[c] || c);
  assert.equal(decodedUpdate, currentLines().join('\r\n') + '\r\n', 'with exactly the current script');
  const again = await api(query('&kit=universal'), { method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain' });
  assert.doesNotMatch(again.text, /security-profiles|security\.passphrase|\/ip hotspot user/);
  assert.doesNotMatch(again.text, /name="fiti-inventory"\] source=/, 'the update is not resent on every poll');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_jobs WHERE location_id=? AND delivered_at IS NULL').get(location.id).n, 1, 'the held job is still queued');

  // A current router whose own timer's reports stop arriving is asked for one.
  const current = await api(query('&kit=universal'), { method: 'POST', routerToken: location.routerToken, body: layout(['inv|agent|4']), contentType: 'text/plain' });
  assert.doesNotMatch(current.text, /system script run fiti-inventory/, 'a fresh report needs no refresh');
  db.prepare(`UPDATE tenant_router_inventory SET reported_at=datetime('now','-3 minutes') WHERE location_id=?`).run(location.id);
  const stale = await api(query('&kit=universal'), { method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain' });
  assert.match(stale.text, /:do \{ \/system script run fiti-inventory \} on-error=/, 'an old report is refreshed from the poll reply');
  assert.match(stale.text, /\/system scheduler find where name="fiti-inventory" and comment~"Wi-Fi Fiti"/, 'the unused layout timer is removed');
  assert.match(stale.text, /:if \(\(\[\/system scheduler get \$fitiPollSchedulerId interval\] != \[:totime "(1s|5s)"\]\) \|\| \(\[\/system scheduler get \$fitiPollSchedulerId disabled\] = true\)\) do=\{ \/system scheduler set/,
    'the poll timer is only changed when it differs, so the router log stays quiet');
  assert.doesNotMatch(stale.text, /^\s*\/system scheduler set \$fitiPollSchedulerId interval=\d+s disabled=no\s*$/m, 'never an unconditional set on every sync');
  assert.doesNotMatch(stale.text, /name="fiti-inventory"\] source=/, 'without resending the script');
  const soon = await api(query('&kit=universal'), { method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain' });
  assert.doesNotMatch(soon.text, /system script run fiti-inventory/, 'at most once a minute');
  await api(query('&kit=universal'), { method: 'POST', routerToken: location.routerToken, body: layout(['inv|agent|4']), contentType: 'text/plain' });

  // The owner sees the layout; another business cannot.
  const topologyEndpoint = `/api/business/locations/${site}/router-topology`;
  const view = await api(topologyEndpoint, { token: alpha });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual(view.body.layout.freeInterfaces.sort(), ['ether2', 'ether3', 'pwr-line1', 'wlan1']);
  assert.equal(view.body.layout.wan.interface, 'pppoe-out1');
  assert.equal((await api(topologyEndpoint, { token: bravo })).status, 404);
  const workspace = await api('/api/business/me', { token: alpha });
  assert.equal(workspace.body.locations[0].router_kit, 'universal');
  assert.equal(workspace.body.locations[0].router_setup_health, 'awaiting-map');

  // The owner saves a map; it is checked against the router's report.
  const planEndpoint = `/api/business/locations/${site}/network-plan`;
  const goodPlan = { bridges: [{ name: 'bridge-guests', job: 'hotspot', ports: ['ether2', 'wlan1'], wifi: { ssid: 'Guest WiFi', radios: [{ name: 'wlan1', type: 'wlan' }] } }], existing: [] };
  const savedPlan = await api(planEndpoint, { method: 'PUT', token: alpha, body: { plan: goodPlan } });
  assert.equal(savedPlan.status, 200, JSON.stringify(savedPlan.body));
  assert.deepEqual(savedPlan.body.plan.bridges, goodPlan.bridges);
  assert.equal((await api(planEndpoint, { method: 'PUT', token: alpha, body: { plan: { bridges: [{ name: 'b1', job: 'hotspot', ports: ['ether4'] }] } } })).status, 400, 'a port in use is refused');
  assert.equal((await api(planEndpoint, { method: 'PUT', token: bravo, body: { plan: goodPlan } })).status, 404, 'another business cannot map this router');
  assert.deepEqual((await api(topologyEndpoint, { token: alpha })).body.plan.bridges, goodPlan.bridges, 'the saved map comes back with the layout');
  assert.doesNotMatch((await api(query('&kit=universal'), { method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain' })).text,
    NETWORK_CHANGES, 'saving a map changes nothing on the router yet');
  db.prepare(`UPDATE tenant_router_inventory SET reported_at=datetime('now','-2 days') WHERE location_id=?`).run(location.id);
  assert.equal((await api(planEndpoint, { method: 'PUT', token: alpha, body: { plan: goodPlan } })).status, 409, 'an old report must be refreshed first');
  db.prepare(`UPDATE tenant_router_inventory SET reported_at=datetime('now') WHERE location_id=?`).run(location.id);
  const cleared = await api(planEndpoint, { method: 'DELETE', token: alpha });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal((await api(topologyEndpoint, { token: alpha })).body.plan, null);
  assert.equal((await api(planEndpoint, { method: 'PUT', token: alpha, body: { plan: goodPlan } })).status, 200);
  db.prepare(`UPDATE locations SET router_kit=NULL WHERE id=?`).run(location.id);
  assert.equal((await api(planEndpoint, { method: 'PUT', token: alpha, body: { plan: goodPlan } })).status, 409, 'only universal-kit routers are mapped');
  db.prepare(`UPDATE locations SET router_kit='universal' WHERE id=?`).run(location.id);

  // Deleting the router also removes its layout report.
  const removed = await api(`/api/business/locations/${site}`, { method: 'DELETE', token: alpha, body: { confirm: 'DELETE' } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_router_inventory WHERE location_id=?').get(location.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_router_plans WHERE location_id=?').get(location.id).n, 0, 'and its saved map');

  console.log('Universal kit: pairs without changing the network, read-only layout report, awaiting-map pairing only for this kit, held work, no open Wi-Fi, owner-only layout, checked network map - passed');
  server.close(); process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

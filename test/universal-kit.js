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
const { parseRouterInventory } = require('../src/lib/router-topology');

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
assert.ok(braces(inventorySource));
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
    assert.doesNotMatch(response.text, /pppoe-server|login\.html/, 'no PPPoE or portal work either');
  }
  const again = await api(query('&kit=universal'), { method: 'POST', routerToken: location.routerToken, body: '', contentType: 'text/plain' });
  assert.doesNotMatch(again.text, /security-profiles|security\.passphrase|\/ip hotspot user/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_jobs WHERE location_id=? AND delivered_at IS NULL').get(location.id).n, 1, 'the held job is still queued');

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

  // Deleting the router also removes its layout report.
  const removed = await api(`/api/business/locations/${site}`, { method: 'DELETE', token: alpha, body: { confirm: 'DELETE' } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_router_inventory WHERE location_id=?').get(location.id).n, 0);

  console.log('Universal kit: pairs without changing the network, read-only layout report, awaiting-map pairing only for this kit, held work, no open Wi-Fi, owner-only layout - passed');
  server.close(); process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

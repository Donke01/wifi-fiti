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

// ---- Adopt: bill a hotspot the owner already runs ---------------------------
{
  require('../src/lib/tenant');
  const rc = require('../src/lib/router-changes');
  const { validateNetworkPlan } = require('../src/lib/router-topology');
  const own = parseRouterInventory(['fiti-inventory-v2', 'inv|agent|6', 'inv|system|routeros|7.24.2', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up',
    'inv|if|bridge-own|bridge|up', 'inv|bport|bridge-own|ether2', 'inv|addr|bridge-own', 'inv|dhcp-server|bridge-own|enabled', 'inv|hotspot|hotspot1|bridge-own',
    'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', 'fiti-inventory-end'].join('\n'));
  const plan = validateNetworkPlan({ existing: [{ interface: 'bridge-own', job: 'hotspot', adopt: true }] }, own);
  assert.deepEqual(plan.existing[0].adopt, { hotspot: 'hotspot1' });
  assert.throws(() => validateNetworkPlan({ existing: [{ interface: 'bridge-own', job: 'pppoe', adopt: true }] }, own), /does not run a hotspot to bill/);
  const change = rc.reviewPlan(plan, own).changes[0];
  assert.equal(change.kind, 'adopt'); assert.equal(change.title, 'bridge-own · Bill hotspot "hotspot1"');
  assert.match(change.lines.join(' '), /Keep your hotspot "hotspot1" on bridge-own exactly as it is/);
  const script = rc.applyScript(change, 61, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke', portalHost: 'shop.wififiti.co.ke' });
  assert.doesNotMatch(script, /\/ip hotspot (add|remove|set)|\/ip address add|\/ip pool add|\/ip dhcp-server add|\/interface bridge (add|port)|\/ip firewall/, 'nothing about the owner\'s hotspot is rebuilt');
  assert.match(script, /:if \(\[:len \[\/ip hotspot find where name="hotspot1" and interface="bridge-own"\]\] != 1\) do=\{ :set fitiWhy "hotspot_missing" \}/);
  assert.match(script, /:if \(\[:len \[\/file get \$f contents\]\] != \[\/file get \$f size\]\) do=\{ :set fitiWhy "login_backup_failed" \}/, 'a login page that cannot be read in full is never overwritten');
  const backup = script.indexOf('/file add name=($fitiDir . "/login-before-wifi-fiti.html") contents=[/file get $fitiLogin contents]');
  assert.ok(backup > 0 && backup < script.indexOf(':set fitiHotspotServer "hotspot1"'), 'the owner\'s login page is saved before Wi-Fi Fiti serves the hotspot');
  assert.match(script, /walled-garden add dst-host="shop\.wififiti\.co\.ke" comment="Wi-Fi Fiti change 61"/);
  assert.match(script, /:set fitiPortalAppliedHost ""/, 'the login page refresh runs again for this hotspot');
  const undo = rc.undoLines(change, 61).join('\n');
  assert.ok(undo.indexOf(':set fitiHotspotServer ""') < undo.indexOf('/file set $l contents=[/file get $k contents]'), 'billing stops before the login page goes back');
  assert.match(undo, /:if \(!\$fitiBack\) do=\{ :error "fiti-undo-incomplete" \}/, 'the undo is incomplete until the owner\'s login page is back');
  assert.match(undo, /\/ip hotspot profile set \[find where name=\$p\] dns-name=\$n/);
  assert.doesNotMatch(undo, /\/ip hotspot remove|\/ip hotspot profile remove/, 'the owner\'s hotspot keeps running');
  // Checks added after review: RouterOS 7 only; enabled; password login; not
  // shared; backup verified; no login page before means none after undo;
  // the portal's walled-garden entry is removed only if this change added it.
  const v6 = parseRouterInventory(['fiti-inventory-v2', 'inv|agent|6', 'inv|system|routeros|6.49.8', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up',
    'inv|if|bridge-own|bridge|up', 'inv|bport|bridge-own|ether2', 'inv|hotspot|hotspot1|bridge-own', 'inv|wan|ether1|dhcp', 'fiti-inventory-end'].join('\n'));
  assert.throws(() => validateNetworkPlan({ existing: [{ interface: 'bridge-own', job: 'hotspot', adopt: true }] }, v6), /needs RouterOS 7/);
  assert.match(script, /disabled\] = true\) do=\{ :set fitiWhy "hotspot_disabled" \}/);
  assert.match(script, /login-by\]\] ~ "http-pap"\)\) do=\{ :set fitiWhy "login_pap_missing" \}/);
  assert.match(script, /:if \(\(\$p2 = \$fitiAdoptProf\) \|\| \(\$d2 = \$d\)\) do=\{ :set fitiWhy "hotspot_shared" \}/);
  assert.ok(script.indexOf(':local fitiAdoptProf ""') < script.indexOf(':set fitiAdoptProf [/ip hotspot get'), 'the profile is read into a variable both check blocks can see');
  assert.match(script, /contents\] != \[\/file get \$fitiLogin contents\]\) do=\{ :do \{ \/file remove \[find where name=\(\$fitiDir \. "\/login-before-wifi-fiti\.html"\)\] \} on-error=\{\}; :error "fiti-adopt-backup" \}/, 'a bad copy is deleted before stopping');
  assert.match(undo, /\[:tostr \[:len \[\/file get \$k contents\]\]\] = \$fitiSize\)\) do=\{/, 'only a complete copy is ever put back');
  assert.match(script, /html-directory-override\]\]\] > 0\) do=\{ :set fitiWhy "login_override" \}/);
  assert.match(undo, /:if \(\(\$fitiHad = "0"\) && \(\[:len \$l\] = 1\)\) do=\{ :do \{ \/file remove \$l \}/, 'no login page before: none after undo');
  assert.match(undo, /:if \(\[\/system script get \[find where name="fiti-adopt-61-wg"\] source\] = "0"\) do=\{ \/ip hotspot walled-garden remove \[find where comment="Wi-Fi Fiti customer portal"\] \}/);
  assert.ok(undo.indexOf('/system script remove [find where name="fiti-map"]') < undo.indexOf(':set fitiHotspotServer ""'), 'the boot copy goes before the live globals');
  assert.match(undo, /:local fitiDir ""; :do \{ :set fitiDir/, 'safe to run again: nothing saved means nothing to put back');
}

// ---- Customer Wi-Fi channel ("More Wi-Fi options") --------------------------
{
  require('../src/lib/tenant');
  const rc = require('../src/lib/router-changes');
  const { validateNetworkPlan } = require('../src/lib/router-topology');
  const radioLayout = (state, extra = []) => parseRouterInventory(['fiti-inventory-v2', 'inv|agent|6', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', `inv|if|wlan1|wlan|${state}`,
    'inv|radio|wlan1|2ghz', 'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', ...extra, 'fiti-inventory-end'].join('\n'));
  const off = radioLayout('disabled');
  assert.equal(off.interfaces.find((i) => i.name === 'wlan1').band, '2ghz', 'the report says which band each radio uses');
  const plan = validateNetworkPlan({ bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['ether2', 'wlan1'], wifi: { ssid: 'Shop', channel: 6 } }] }, off);
  assert.deepEqual([plan.bridges[0].wifi.channel, plan.bridges[0].wifi.frequency], [6, 2437]);
  assert.equal(validateNetworkPlan({ bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['wlan1'], wifi: { ssid: 'Shop' } }] }, off).bridges[0].wifi.channel, undefined, 'Automatic by default');
  assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['wlan1'], wifi: { ssid: 'Shop', channel: 36 } }] }, off), /Choose Automatic or one of channels 1, 6, 11/);
  assert.throws(() => validateNetworkPlan({ bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['wlan1'], wifi: { ssid: 'Shop', channel: 6 } }] }, radioLayout('up')), /follows your own Wi-Fi/, 'a shared radio keeps the owner\'s channel');
  const change = rc.reviewPlan(plan, off).changes[0];
  assert.match(change.lines.join(' '), /on channel 6/);
  const script = rc.applyScript(change, 51, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke' });
  assert.ok(script.indexOf('name="fiti-radio-51-wlan1-freq" source=[:tostr [/interface wireless get [find where name="wlan1"] frequency]]') < script.indexOf('frequency=2437 disabled=no'), 'the old channel is saved before it changes');
  const undo = rc.undoLines(change, 51).join('\n');
  assert.match(undo, /:local f \[\/system script get \[find where name="fiti-radio-51-wlan1-freq"\] source\]; \/interface wireless set \[find where name="wlan1"\] frequency=\$f/, 'undo puts the old channel back');
  assert.match(undo, /remove \[find where name="fiti-radio-51-wlan1-freq"\]/);
  assert.doesNotMatch(rc.applyScript(rc.reviewPlan(validateNetworkPlan({ bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['wlan1'], wifi: { ssid: 'Shop' } }] }, off), off).changes[0], 52, { wan: 'ether1' }), /frequency/, 'Automatic leaves the channel alone');
}

// ---- Two internet connections (main + backup / load-shared) --------------
{
  require('../src/lib/tenant');
  const rc = require('../src/lib/router-changes');
  const twoWan = (extra = []) => ['fiti-inventory-v2', 'inv|agent|5', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up', 'inv|if|ether4|ether|up',
    'inv|if|pppoe-out1|pppoe-out|up', 'inv|pppoe-client|pppoe-out1|ether2', 'inv|addr|ether1', 'inv|dhcp-client|ether1|bound',
    'inv|wan|ether1|dhcp', 'inv|wans|ether1|dhcp', 'inv|wans|pppoe-out1|pppoe', ...extra, 'fiti-inventory-end'].join('\n') + '\n';
  const layout = parseRouterInventory(twoWan());
  assert.deepEqual(layout.wans.map((w) => w.interface), ['ether1', 'pppoe-out1'], 'both lines are reported, the main one first');
  const byName = Object.fromEntries(layout.interfaces.map((i) => [i.name, i]));
  assert.ok(byName.ether1.internet && byName['pppoe-out1'].internet && byName.ether2.internet, 'both lines and the port under the backup are internet, so they stay locked');
  assert.ok(!byName.ether2.free, 'the backup line\'s port is never offered to customers');
  assert.match(byName['pppoe-out1'].usage.join(' '), /Internet connection/);
  const plan = { bridges: [{ name: 'fiti-hs', job: 'hotspot', ports: ['ether3'] }], existing: [], moves: [] };
  const review = rc.reviewPlan(plan, layout);
  assert.match(review.changes[0].lines.join(' '), /get internet through ether1 or pppoe-out1/);
  const ctx = { wan: 'ether1', wans: layout.wans.map((w) => w.interface), wanList: layout.wanList, cloudHost: 'cloud.wififiti.co.ke' };
  const script = rc.applyScript(review.changes[0], 31, ctx);
  for (const w of ['ether1', 'pppoe-out1']) {
    assert.match(script, new RegExp(`/ip firewall nat add chain=srcnat src-address=\\("10\\.5\\." \\. \\$fitiNet \\. "\\.0/24"\\) out-interface="${w}" action=masquerade`), `customers are shared out through ${w} too (failover)`);
    assert.match(script, new RegExp(`chain=input in-interface="${w}" protocol=udp dst-port=53 action=drop`), `the router's DNS is closed on ${w}`);
    assert.match(script, new RegExp(`:if \\(\\[:len \\[/interface find where name="${w}"\\]\\] != 1\\) do=\\{ :set fitiWhy "wan_missing" \\}`));
  }
  assert.match(rc.undoLines(review.changes[0], 31).join('\n'), /\/ip firewall nat remove \[find where comment="Wi-Fi Fiti change 31"\]/, 'undo removes every rule the change added');
  // A router with a "WAN" list holding the main line: the rules follow the
  // list (a line added later is covered), plus any line outside the list.
  const listed = parseRouterInventory(twoWan(['inv|if|lte1|lte|up', 'inv|wans|lte1|static', 'inv|wanlist|WAN|ether1', 'inv|wanlist|WAN|pppoe-out1']));
  const listScript = rc.applyScript(rc.reviewPlan(plan, listed).changes[0], 32, { wan: 'ether1', wans: listed.wans.map((w) => w.interface), wanList: listed.wanList, cloudHost: 'cloud.wififiti.co.ke' });
  assert.match(listScript, /out-interface-list=WAN action=masquerade/);
  assert.match(listScript, /chain=input in-interface-list=WAN protocol=tcp dst-port=53 action=drop/);
  assert.match(listScript, /out-interface="lte1" action=masquerade/, 'a line outside the list is covered on its own');
  assert.doesNotMatch(listScript, /out-interface="ether1"|out-interface="pppoe-out1"/, 'lines in the list are covered by the list');
  assert.match(listScript, /:if \(\[:len \[\/interface list find where name="WAN"\]\] != 1\) do=\{ :set fitiWhy "wan_missing" \}/);
  // An older report (agent 4) with only the main line keeps today's rules.
  const old = rc.applyScript(review.changes[0], 33, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke' });
  assert.match(old, /out-interface="ether1" action=masquerade/);
  assert.doesNotMatch(old, /pppoe-out1|interface-list/);
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
  assert.match(wifiScript, /:while \(\(\[\/system resource get free-memory\] < 3145728\) && \(\$fitiWait < 15\)\) do=\{/, 'the change waits for free memory first');
  assert.ok(wifiScript.indexOf('"low_memory"') < wifiScript.indexOf('/system script add name="fiti-undo-11"'), 'a router short of memory stops before anything is written');
  assert.ok(wifiScript.indexOf('name="fiti-radio-11-wlan1-ssid" source=') < wifiScript.indexOf('/interface wireless set [find where name="wlan1"] mode=ap-bridge'), 'the radio\'s old settings are kept before it changes');
  assert.ok(wifiScript.indexOf('/ip hotspot add name="fiti-hotspot"') < wifiScript.indexOf('/interface wireless set [find where name="wlan1"] mode=ap-bridge'), 'the radio turns on only once the hotspot is ready');
  assert.match(wifiScript, /mode=ap-bridge ssid="Sirende WiFi" security-profile="fiti-open-11" disabled=no/);
  const wifiUndo = rc.undoLines(wifiReview.changes[0], 11).join('\n');
  assert.match(wifiUndo, /\/interface wireless set \[find where name="wlan1"\] ssid=\$s mode=\$m security-profile=\$p disabled=\(\$d = "true"\)/, 'undo puts the radio back exactly');

  // Wi-Fi added to a hotspot that already runs (a cable-only one-step setup):
  // only the radio changes; the hotspot and its cable ports stay as they are.
  {
    const { validateNetworkPlan } = require('../src/lib/router-topology');
    const cableOnly = parseRouterInventory(['fiti-inventory-v2', 'inv|agent|4', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up', 'inv|if|wlan1|wlan|disabled',
      'inv|if|fiti-hotspot|bridge|up', 'inv|fiti-bridge|fiti-hotspot', 'inv|bport|fiti-hotspot|ether2', 'inv|addr|fiti-hotspot', 'inv|dhcp-server|fiti-hotspot|enabled',
      'inv|hotspot|fiti-hotspot|fiti-hotspot', 'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', 'fiti-inventory-end'].join('\n'));
    const saved = validateNetworkPlan({ existing: [{ interface: 'fiti-hotspot', job: 'hotspot', wifi: { ssid: 'Shop WiFi', radio: 'wlan1' } }], keep: ['ether3'] }, cableOnly);
    assert.deepEqual(saved.existing[0], { interface: 'fiti-hotspot', job: 'hotspot', alreadyRunning: true, wifi: { ssid: 'Shop WiFi', radios: [{ name: 'wlan1', type: 'wlan', mode: 'takeover' }] } });
    assert.throws(() => validateNetworkPlan({ existing: [{ interface: 'fiti-hotspot', job: 'pppoe', wifi: { ssid: 'x', radio: 'wlan1' } }] }, cableOnly), /bridge that already runs the hotspot/);
    assert.throws(() => validateNetworkPlan({ existing: [{ interface: 'fiti-hotspot', job: 'hotspot', wifi: { ssid: 'x', radio: 'ether3' } }] }, cableOnly), /not a Wi-Fi radio/);
    const addWifi = rc.reviewPlan(saved, cableOnly);
    assert.equal(addWifi.changes.length, 1);
    assert.equal(addWifi.changes[0].kind, 'wifi');
    assert.equal(addWifi.changes[0].title, 'fiti-hotspot · Wi-Fi "Shop WiFi"');
    assert.match(addWifi.changes[0].lines.join(' '), /Keep the hotspot on fiti-hotspot and its ports exactly as they are/);
    const addScript = rc.applyScript(addWifi.changes[0], 21, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke' });
    assert.doesNotMatch(addScript, /\/ip hotspot add|\/interface bridge add|\/ip address add|\/ip pool add/, 'the running hotspot is not rebuilt');
    assert.match(addScript, /:if \(\[:len \[\/ip hotspot find where interface="fiti-hotspot"\]\] = 0\) do=\{ :set fitiWhy "hotspot_missing" \}/, 'the hotspot must still be running there');
    assert.match(addScript, /:if \(\[:len \[\/interface bridge port find where interface="wlan1"\]\] > 0\) do=\{ :set fitiWhy "port_changed" \}/, 'the radio must still be free');
    assert.ok(addScript.indexOf('name="fiti-radio-21-wlan1-ssid" source=') < addScript.indexOf('/interface wireless set [find where name="wlan1"] mode=ap-bridge'), 'the radio settings are saved first');
    assert.match(addScript, /\/interface bridge port add bridge="fiti-hotspot" interface="wlan1"/);
    const addUndo = rc.undoLines(addWifi.changes[0], 21).join('\n');
    assert.match(addUndo, /\/interface bridge port remove \[find where interface="wlan1"\]/);
    assert.match(addUndo, /\/interface wireless set \[find where name="wlan1"\] ssid=\$s mode=\$m security-profile=\$p disabled=\(\$d = "true"\)/, 'undo puts the radio back exactly');
    assert.doesNotMatch(addUndo, /\/ip hotspot remove|\/interface bridge remove/, 'undo leaves the hotspot running');
    // Once the Wi-Fi is on the router, the saved map does not add it again.
    const withWifi = parseRouterInventory(['fiti-inventory-v2', 'inv|agent|4', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up', 'inv|if|wlan1|wlan|up',
      'inv|if|fiti-hotspot|bridge|up', 'inv|fiti-bridge|fiti-hotspot', 'inv|bport|fiti-hotspot|ether2', 'inv|bport|fiti-hotspot|wlan1', 'inv|addr|fiti-hotspot', 'inv|dhcp-server|fiti-hotspot|enabled',
      'inv|hotspot|fiti-hotspot|fiti-hotspot', 'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', 'fiti-inventory-end'].join('\n'));
    // Only a switched-off radio is taken over, checked on the router too; the
    // undo proves the radio is back before dropping its saved settings.
    assert.match(addScript, /:do \{ :if \(\[\/interface wireless get \[find where name="wlan1"\] disabled\] != true\) do=\{ :set fitiWhy "radio_busy" \} \} on-error=\{ :set fitiWhy "radio_missing" \}/);
    assert.ok(addUndo.indexOf('source]; :if ([:tostr [/interface wireless get [find where name="wlan1"] disabled]] != $d)') < addUndo.indexOf('/system script remove [find where name="fiti-radio-21-wlan1-ssid"]'),
      'the saved radio settings stay until the radio is proven back');
    // A map saved while the radio was off, applied after the owner switched it
    // on: checked again, it becomes a separate network, never a takeover.
    const nowOn = parseRouterInventory(['fiti-inventory-v2', 'inv|agent|4', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up', 'inv|if|wlan1|wlan|up',
      'inv|if|fiti-hotspot|bridge|up', 'inv|fiti-bridge|fiti-hotspot', 'inv|bport|fiti-hotspot|ether2', 'inv|addr|fiti-hotspot', 'inv|dhcp-server|fiti-hotspot|enabled',
      'inv|hotspot|fiti-hotspot|fiti-hotspot', 'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', 'fiti-inventory-end'].join('\n'));
    assert.equal(validateNetworkPlan(saved, nowOn).existing[0].wifi.radios[0].mode, 'virtual');
    const again = rc.reviewPlan(saved, withWifi);
    assert.equal(again.changes.length, 0, 'Wi-Fi already on the router is not added twice');
    assert.match(again.notes.join(' '), /already runs a hotspot with customer Wi-Fi/);
  }
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
  // PPPoE on a VLAN (customers delivered tagged on one cable): its own change,
  // pointing Wi-Fi Fiti's PPPoE server at the VLAN; undo points it back.
  const vlanChange = blocked.changes.find((c) => c.target === 'vlan9');
  assert.ok(vlanChange, 'a VLAN can carry PPPoE customers');
  assert.equal(vlanChange.job, 'pppoe');
  const vlanScript = rc.applyScript(vlanChange, 41, { wan: 'ether1', cloudHost: 'cloud.wififiti.co.ke' });
  assert.match(vlanScript, /:if \(\[:len \[\/interface find where name="vlan9"\]\] != 1\) do=\{ :set fitiWhy "interface_missing" \}/);
  assert.match(vlanScript, /\/interface pppoe-server server set \[find where comment="Wi-Fi Fiti PPPoE"\] interface="vlan9"/);
  assert.match(rc.undoLines(vlanChange, 41).join('\n'), /fiti-prev-41/, 'undo puts the PPPoE server back where it was');
  assert.doesNotMatch(vlanScript, /\/interface bridge add|\/interface vlan (add|set|remove)/, 'the VLAN itself is not touched');
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
  assert.match(delivered.text, /:if \(\[:typeof \[:find \[\/system scheduler get \$fitiPollSchedulerId on-event\] "script job find"\]\] = "nil"\) do=\{ \/system scheduler set \$fitiPollSchedulerId on-event=":if \(\[:len \[\/system script job find where script=\\"fiti-poll\\"\]\] = 0\) do=\{ \/system script run fiti-poll \}" \}/,
    'installed routers get the one-sync-at-a-time guard, set only once');
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
  // A change travels alone: no layout report rides along (small routers
  // restarted when both ran at once); the change sends its own when done.
  db.prepare(`UPDATE tenant_router_inventory SET reported_at=datetime('now','-1 minutes') WHERE location_id=?`).run(hap.location.id);
  const hsReply = await hap.poll('');
  assert.doesNotMatch(hsReply.text, /:do \{ \/system script run fiti-inventory \} on-error=\{ :log warning "fiti: layout report failed; it will retry" \}/, 'no layout report in the same reply as a change');
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

  // Wi-Fi added to a hotspot that already runs, end to end; the hotspot's own
  // change cannot be undone while the Wi-Fi added to it is still there.
  {
    const charlie = await createBusiness('changes-charlie@example.test', 'Changes Charlie', '0712000103');
    const cableOnly = (extra = []) => ['fiti-inventory-v2', 'inv|agent|4', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up', 'inv|if|wlan1|wlan|disabled',
      'inv|if|fiti-hotspot|bridge|up', 'inv|fiti-bridge|fiti-hotspot', 'inv|bport|fiti-hotspot|ether2', 'inv|addr|fiti-hotspot', 'inv|dhcp-server|fiti-hotspot|enabled',
      'inv|hotspot|fiti-hotspot|fiti-hotspot', 'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', ...extra, 'fiti-inventory-end'].join('\n') + '\n';
    const shop = await pairedUniversal(charlie, 'Shop', cableOnly());
    const shopBase = `/api/business/locations/${shop.site}`;
    const hsRow = Number(db.prepare(`INSERT INTO tenant_router_changes (location_id, batch_id, seq, kind, target, job, spec_json, status) VALUES (?, 'bh', 0, 'bridge', 'fiti-hotspot', 'hotspot', ?, 'verified')`)
      .run(shop.location.id, JSON.stringify({ title: 'fiti-hotspot · Hotspot', ports: ['ether2'], moves: [] })).lastInsertRowid);
    const put = await api(`${shopBase}/network-plan`, { method: 'PUT', token: charlie, body: { plan: { existing: [{ interface: 'fiti-hotspot', job: 'hotspot', wifi: { ssid: 'Shop WiFi', radio: 'wlan1' } }], keep: ['ether3'] } } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const applied = await api(`${shopBase}/network-plan/apply`, { method: 'POST', token: charlie, body: { confirm: true } });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const wifiChange = applied.body.changes.find((c) => c.kind === 'wifi');
    assert.ok(wifiChange, 'the Wi-Fi is its own change');
    const sent = await shop.poll('');
    assert.match(sent.text, /\/interface bridge port add bridge="fiti-hotspot" interface="wlan1"/);
    assert.equal((await shop.answer(`id=${wifiChange.id}&state=applied`)).text, 'confirmed');
    await shop.answer(`id=${wifiChange.id}&state=kept`);
    await shop.poll(cableOnly(['inv|bport|fiti-hotspot|wlan1']).replace('inv|if|wlan1|wlan|disabled', 'inv|if|wlan1|wlan|up'));
    const after = (await api(`${shopBase}/router-topology`, { token: charlie })).body.changes;
    assert.equal(after.find((c) => c.id === wifiChange.id).status, 'verified', 'the radio in the hotspot bridge verifies the change');
    const blocked = await api(`${shopBase}/network-changes/${hsRow}/undo`, { method: 'POST', token: charlie });
    assert.equal(blocked.status, 409); assert.match(blocked.body.error, /Undo the Wi-Fi added to fiti-hotspot first/);
    assert.equal((await api(`${shopBase}/network-changes/${wifiChange.id}/undo`, { method: 'POST', token: charlie })).status, 200, 'the Wi-Fi alone can be undone');
    assert.match((await shop.poll('')).text, new RegExp(`/system script run fiti-undo-${wifiChange.id}`));

  // Adopt, end to end: an owner's own hotspot billed by Wi-Fi Fiti.
  {
    const delta = await createBusiness('changes-delta@example.test', 'Changes Delta', '0712000104');
    const ownLayout = (extra = []) => ['fiti-inventory-v2', 'inv|agent|6', 'inv|system|routeros|7.24.2', 'inv|if|ether1|ether|up', 'inv|if|ether2|ether|up', 'inv|if|ether3|ether|up',
      'inv|if|bridge-own|bridge|up', 'inv|bport|bridge-own|ether2', 'inv|addr|bridge-own', 'inv|dhcp-server|bridge-own|enabled', 'inv|hotspot|hotspot1|bridge-own',
      'inv|dhcp-client|ether1|bound', 'inv|wan|ether1|dhcp', ...extra, 'fiti-inventory-end'].join('\n') + '\n';
    const cafe = await pairedUniversal(delta, 'Cafe', ownLayout());
    const cafeBase = `/api/business/locations/${cafe.site}`;
    assert.equal((await api(`${cafeBase}/network-plan`, { method: 'PUT', token: delta, body: { plan: { existing: [{ interface: 'bridge-own', job: 'hotspot', adopt: true }] } } })).status, 200);
    const applied = await api(`${cafeBase}/network-plan/apply`, { method: 'POST', token: delta, body: { confirm: true } });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const adoptChange = applied.body.changes.find((c) => c.kind === 'adopt');
    assert.ok(adoptChange);
    assert.match((await cafe.poll('')).text, /:set fitiHotspotServer "hotspot1"/);
    assert.equal((await cafe.answer(`id=${adoptChange.id}&state=applied`)).text, 'confirmed');
    await cafe.answer(`id=${adoptChange.id}&state=kept`);
    await cafe.poll(ownLayout());
    assert.equal((await api(`${cafeBase}/router-topology`, { token: delta })).body.changes.find((c) => c.id === adoptChange.id).status, 'verified');
    // Once billed, the saved "adopt" is ignored: a later map change never repeats it.
    assert.equal((await api(`${cafeBase}/network-plan`, { method: 'PUT', token: delta, body: { plan: { existing: [{ interface: 'bridge-own', job: 'hotspot', adopt: true }] } } })).status, 200);
    const again = await api(`${cafeBase}/network-plan/apply`, { method: 'POST', token: delta, body: { confirm: true } });
    assert.equal(again.status, 409, 'nothing to do: the hotspot is already billed');
    assert.equal((await api(`${cafeBase}/network-changes/${adoptChange.id}/undo`, { method: 'POST', token: delta })).status, 200);
    assert.match((await cafe.poll('')).text, new RegExp(`/system script run fiti-undo-${adoptChange.id}`));
  }

  // Router tools: queued from the dashboard, run from the poll reply, answered
  // by the router with its token.
  {
    const echo = await createBusiness('changes-echo@example.test', 'Changes Echo', '0712000105');
    const box = await pairedUniversal(echo, 'Box', blank());
    const toolsUrl = `/api/business/locations/${box.site}/tools`;
    assert.equal((await api(toolsUrl, { token: bravo })).status, 404, 'another business cannot use them');
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'format-disk' } })).status, 400, 'only known tools');
    const started = await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'health' } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'log' } })).status, 409, 'one tool at a time');
    const reply = await box.poll('');
    const toolId = (reply.text.match(/# Wi-Fi Fiti tool (\d+): health/) || [])[1];
    assert.ok(toolId, 'the tool rides the poll reply');
    assert.match(reply.text, /interval=1s disabled=no/, 'the router checks in fast while a tool waits');
    assert.match(reply.text, /\/api\/router\/tool\?site=" \. \$fitiSite \. "&id=\d+"\) check-certificate=\$fitiCk http-method=post http-data=\$fitiOut/);
    assert.match(reply.text, /:local fitiCk "yes"/, 'verified TLS unless the poller itself is the compatibility kit');
    assert.doesNotMatch(reply.text, /check-certificate=no/, 'never an unverified retry');
    assert.doesNotMatch((await box.poll('')).text, /# Wi-Fi Fiti tool/, 'sent once');
    const answerUrl = `/api/router/tool?site=${box.site}&id=${toolId}`;
    assert.equal((await api(answerUrl, { method: 'POST', body: 'uptime=1h2m\ncpu=37\n', contentType: 'text/plain' })).status, 403, 'only the router may answer');
    assert.equal((await api(answerUrl, { method: 'POST', routerToken: box.location.routerToken, body: 'uptime=1h2m\ncpu=37\nfree=6.2MiB\ntotal=32.0MiB\nversion=7.24.1 (stable)\nboard=hAP lite\nhdd=6.8MiB\nhotspot_users=3\n', contentType: 'text/plain' })).text, 'ok');
    let runs = (await api(toolsUrl, { token: echo })).body.runs;
    assert.equal(runs[0].status, 'done');
    assert.deepEqual([runs[0].summary.cpu, runs[0].summary.freeMemory, runs[0].summary.totalMemory, runs[0].summary.board, runs[0].summary.hotspotUsers], [37, Math.round(6.2 * 1048576), 32 * 1048576, 'hAP lite', 3]);
    // Speed test: the download is only for the router, and is timed.
    assert.equal((await api(`/api/router/speed-test?site=${box.site}`)).status, 403);
    assert.equal((await api(`/api/router/speed-test?site=${box.site}`, { routerToken: box.location.routerToken })).status, 429, 'no speed test running: no download');
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'speed' } })).status, 201);
    const speedReply = (await box.poll('')).text;
    assert.match(speedReply, /:execute/, 'the download runs in the background');
    const blob = await api(`/api/router/speed-test?site=${box.site}`, { routerToken: box.location.routerToken });
    assert.equal(blob.status, 200); assert.ok(blob.text.length > 1000000, 'a real 2 MB download');
    assert.equal((await api(`/api/router/speed-test?site=${box.site}`, { routerToken: box.location.routerToken })).status, 200, 'one retry allowed');
    assert.equal((await api(`/api/router/speed-test?site=${box.site}`, { routerToken: box.location.routerToken })).status, 429, 'but not a third');
    const speedId = (speedReply.match(/tool (\d+): speed/) || [])[1];
    assert.equal((await api(`/api/router/tool?site=${box.site}&id=${speedId}`, { method: 'POST', routerToken: box.location.routerToken, body: 'error=download_failed\nping_ok=4\n', contentType: 'text/plain' })).text, 'ok');
    runs = (await api(toolsUrl, { token: echo })).body.runs;
    assert.equal(runs[0].summary.downloadFailed, true); assert.equal(runs[0].summary.pingOk, 4, 'the ping is kept when the download failed');
    const tools = require('../src/lib/router-tools');
    assert.equal(tools._test.seconds('2s340ms'), 2.34); assert.equal(tools._test.seconds('00:00:04'), 4); assert.equal(tools._test.bytes('2048KiB'), 2097152);
    // A customer by phone must have bought here; the restart needs a confirm.
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'customer', phone: '0799000000' } })).status, 404);
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'customer', mac: 'not-a-mac' } })).status, 400);
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'reboot' } })).status, 400, 'a restart must be confirmed');
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'reboot', confirm: true } })).status, 201);
    const restart = await box.poll('');
    assert.match(restart.text, /error=needs_permission/, 'an older kit without the reboot permission is told plainly');
    assert.match(restart.text, /:if \(\$fitiOut = "state=restarting\\n"\) do=\{ :execute/, 'it restarts only when allowed');
    assert.ok(restart.text.indexOf('/api/router/tool?site=') < restart.text.indexOf(':execute ":delay 5s; /system reboot"'), 'it answers first, then restarts');
    // A router that never answers does not block the page for ever.
    db.prepare(`UPDATE tenant_router_tools SET updated_at=datetime('now','-5 minutes') WHERE status='sent'`).run();
    runs = (await api(toolsUrl, { token: echo })).body.runs;
    assert.equal(runs[0].status, 'failed'); assert.equal(runs[0].summary.error, 'no_answer', 'a router that went quiet is shown as not answering');
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'customer', mac: 'aabbcc112233' } })).status, 201, 'a MAC without separators is fine');
    const custReply = (await box.poll('')).text;
    assert.match(custReply, /mac-address="AA:BB:CC:11:22:33"/);
    db.prepare(`UPDATE tenant_router_tools SET status='done' WHERE status IN ('queued','sent')`).run();
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'backup' } })).status, 201, 'the next tool can run');
    assert.match((await box.poll('')).text, /needs_permission[\s\S]*system backup save/, 'the backup checks its permission first');
    db.prepare(`UPDATE tenant_router_tools SET status='done' WHERE status IN ('queued','sent')`).run();
    // A router that has not checked in for minutes is not sent a tool.
    db.prepare(`UPDATE locations SET last_successful_sync_at=datetime('now','-10 minutes') WHERE id=?`).run(box.site);
    assert.equal((await api(toolsUrl, { method: 'POST', token: echo, body: { tool: 'health' } })).status, 409, 'offline routers are refused');
    db.prepare(`UPDATE locations SET last_successful_sync_at=datetime('now') WHERE id=?`).run(box.site);
  }

  // Go live (stage 4): from a set-up router to the first paying customer.
  {
    const charlieToken = charlie;
    const shopId = shop.location.id;
    const goLive = async () => { const r = await api(`/api/business/locations/${encodeURIComponent(shopId)}/go-live`, { token: charlieToken }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
    let g = await goLive();
    assert.equal(g.hotspot.ready, true, 'the hotspot runs on the router');
    assert.equal(g.packages.count, 0); assert.equal(g.packages.ready, false);
    assert.equal(g.live, false); assert.equal(g.sale, null);
    assert.equal(g.trial, true); assert.equal(g.trialLimits.maxPriceKes, 3);
    assert.ok(g.portalUrl, 'the owner can open their login page');
    assert.equal(typeof g.payments.ready, 'boolean'); assert.ok(g.payments.note);
    assert.equal((await api(`/api/business/locations/${encodeURIComponent(shopId)}/go-live`, { token: bravo })).status, 404, 'another business cannot read it');
    const starter = await api('/api/business/packages/starter', { method: 'POST', token: charlieToken, body: {} });
    assert.equal(starter.status, 201, JSON.stringify(starter.body));
    assert.deepEqual(starter.body.packages.map((p) => [p.name, p.price]).sort(), [['1 day', 3], ['2 hours', 2], ['30 minutes', 1]], 'starter packages stay inside the free trial');
    assert.ok(starter.body.packages.every((p) => p.seconds <= 24 * 3600));
    assert.equal((await api('/api/business/packages/starter', { method: 'POST', token: charlieToken, body: {} })).status, 409, 'never added twice');
    g = await goLive();
    assert.equal(g.packages.ready, true); assert.equal(g.packages.sellable, 3);
    assert.deepEqual([g.packages.cheapest.name, g.packages.cheapest.price], ['30 minutes', 1]);
    // A test purchase: paid, then the router switches the customer on.
    const pkg = starter.body.packages.find((p) => p.price === 1);
    const jobId = Number(db.prepare(`INSERT INTO tenant_jobs (location_id, username, password, profile, total_seconds, mac) VALUES (?, 'u1', 'p1', 'standard', 1800, 'AA:BB:CC:00:00:99')`).run(shopId).lastInsertRowid);
    db.prepare(`INSERT INTO tenant_transactions (checkout_request_id, business_id, location_id, phone, package_id, package_name, amount, seconds, mac, status, mpesa_receipt, provisioning_job_id)
      VALUES ('golive-1', ?, ?, '254700000001', ?, '30 minutes', 1, 1800, 'AA:BB:CC:00:00:99', 'paid', 'TST123', ?)`).run(shop.location.business_id || db.prepare('SELECT business_id FROM locations WHERE id=?').get(shopId).business_id, shopId, pkg.id, jobId);
    g = await goLive();
    assert.equal(g.live, false, 'paid but not switched on yet');
    assert.equal(g.sale.amount, 1); assert.equal(g.sale.receipt, 'TST123'); assert.equal(g.sale.connected, false);
    db.prepare(`UPDATE tenant_jobs SET acked_at=datetime('now') WHERE id=?`).run(jobId);
    g = await goLive();
    assert.equal(g.live, true, 'live once the router has switched the first customer on');
    assert.equal(g.sale.connected, true); assert.equal(g.sale.count, 1);
    // A newer sale still waiting (e.g. an offline claim) does not undo "live".
    db.prepare(`INSERT INTO tenant_transactions (checkout_request_id, business_id, location_id, phone, package_id, package_name, amount, seconds, mac, status, mpesa_receipt, updated_at)
      VALUES ('golive-2', ?, ?, '254700000002', ?, '30 minutes', 1, 1800, 'CLAIM:x', 'paid', 'TST124', datetime('now','+1 minute'))`).run(db.prepare('SELECT business_id FROM locations WHERE id=?').get(shopId).business_id, shopId, pkg.id);
    g = await goLive();
    assert.equal(g.live, true, 'still live'); assert.equal(g.sale.receipt, 'TST124'); assert.equal(g.sale.count, 2);
    // A router that stopped checking in is not ready to switch customers on.
    db.prepare(`UPDATE locations SET last_successful_sync_at=datetime('now','-10 minutes') WHERE id=?`).run(shopId);
    g = await goLive();
    assert.equal(g.hotspot.ready, false); assert.equal(g.hotspot.online, false); assert.match(g.hotspot.note, /has not checked in/);
  }
  }

  // Deleting a router removes its change history.
  assert.equal((await api(`${hapBase}`, { method: 'DELETE', token: bravo, body: { confirm: 'DELETE' } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenant_router_changes WHERE location_id=?').get(hap.location.id).n, 0);

  console.log('Router changes: preflight, undo first, boot guard, cloud confirm, verify, undo, one at a time, owner-only - passed');
  server.close(); process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

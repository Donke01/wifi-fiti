'use strict';

/*
 * Stage 3 of the universal kit: apply a saved network map to the router.
 *
 * A saved plan becomes a short queue of changes, one per bridge or existing
 * interface. Each change is delivered in the router's normal poll reply and is
 * built to be safe on a live network:
 *
 *   1. Preflight (read-only). The router checks that everything is still as
 *      the dashboard showed it: the ports are where the report said, the new
 *      bridge name is free, a subnet is free. Any surprise stops the change
 *      before anything is touched.
 *   2. The undo script is written to the router BEFORE any change, and a boot
 *      guard is armed that runs it if the router restarts mid-change.
 *   3. The change runs. If any command fails, the undo runs at once.
 *   4. The router must reach the cloud again within about 90 seconds. Only
 *      the cloud's "confirmed" reply keeps the change; otherwise the router
 *      undoes it by itself (for example if the change cut its internet).
 *   5. The next layout report re-checks the router: the change is "verified"
 *      only when the report shows what was planned.
 *
 * The undo script stays on the router afterwards, so the owner can undo any
 * single bridge later from the dashboard.
 */
const { db } = require('./db');

const SAFE = /^[A-Za-z0-9_.-]{1,64}$/;
const ACTIVE = ['queued', 'sent', 'confirming', 'undo-queued', 'undo-sent'];
// The router's confirm loop tries up to 16 times, 3-5 s apart, each try up
// to two fetches that can each time out: under 7 minutes at worst. The server must
// wait longer than that, or it would answer "not confirmed" to a change that
// worked and the router would put it back.
const SENT_TIMEOUT_MS = 8 * 60_000;
const CONFIRMING_SETTLE_MS = 10 * 60_000;
const HOTSPOT_NAME = 'fiti-hotspot';

function changeError(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function safe(name) { if (!SAFE.test(String(name || ''))) throw changeError('Unexpected interface name.'); return String(name); }
const ros = (value) => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/[\r\n]/g, ' ') + '"';
// Escape RouterOS source for a quoted string (a script body or :execute).
const src = (lines) => '"' + lines.join('\r\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
const jobLabel = (job) => (job === 'pppoe' ? 'PPPoE' : 'Hotspot');

function parseSqlTime(value) {
  let text = String(value || '').trim().replace(' ', 'T');
  if (text && !/(?:Z|[+-]\d\d:\d\d)$/i.test(text)) text += 'Z';
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : 0;
}

/**
 * Turn a saved plan into the list of changes it needs, with plain-language
 * lines for the review screen. Things v1 cannot do safely yet are returned as
 * blockers instead of being attempted.
 */
function reviewPlan(plan, layout) {
  const byName = new Map((layout && layout.interfaces || []).map((item) => [item.name, item]));
  const running = (layout && layout.hotspots || [])[0] || null;
  const pppoeNow = (layout && layout.pppoeServers || []).map((s) => s.interface);
  const wan = layout && layout.wan && layout.wan.interface;
  const changes = []; const blockers = []; const notes = [];
  const moves = new Map((plan && plan.moves || []).map((m) => [m.interface, m.from]));
  const hotspotLines = (target, created) => [
    created ? `Start a new hotspot (${HOTSPOT_NAME}) on ${target}, with its own private network (the first free one from 10.5.50.0/24 to 10.5.59.0/24) and DHCP.` : `Start a hotspot (${HOTSPOT_NAME}) on ${target}, with its own private network and DHCP.`,
    `Hotspot customers on ${target} get internet through ${wan}, can reach only the login page and DNS on the router, and can't open router settings.`,
    'Customer billing, the login page and vouchers then run on this hotspot.',
  ];
  const pppoeLines = (target) => [
    `PPPoE customers connect on ${target}.`,
    pppoeNow.length
      ? `Wi-Fi Fiti's PPPoE server runs on ${target} from now on. A PPPoE server runs on ${pppoeNow.join(', ')} today: if it is Wi-Fi Fiti's, it moves to ${target}, and PPPoE customers plugged in elsewhere must move to ${target}'s ports. A PPPoE server you set up yourself stays as it is.`
      : `Wi-Fi Fiti's PPPoE server starts on ${target} when you add your first PPPoE customer.`,
  ];
  for (const bridge of plan && plan.bridges || []) {
    const lines = [`Create bridge ${bridge.name}.`];
    const shared = virtualPorts(bridge);
    for (const port of bridge.ports) {
      if (shared.has(port)) continue;
      const from = moves.get(port);
      lines.push(from ? `Move ${port} out of ${from} into ${bridge.name}. Anything plugged into ${port} joins ${bridge.name}.` : `Add ${port} to ${bridge.name}.`);
    }
    if (bridge.job === 'hotspot') {
      if (running) { blockers.push(`This router already runs a hotspot on ${running.interface}.`); continue; }
      if (!wan) { blockers.push('The router has not reported which connection carries the internet, so a hotspot cannot be started yet.'); continue; }
      lines.push(...hotspotLines(bridge.name, true));
      if (bridge.wifi) for (const radio of bridge.wifi.radios) lines.push(isVirtual(radio)
        ? `Add a separate open Wi-Fi "${bridge.wifi.ssid}" on ${radio.name} for customers. Your own Wi-Fi on ${radio.name} keeps working exactly as it is; customers join the new one and the login page controls internet access.`
        : `Turn on ${radio.name} and broadcast the open Wi-Fi "${bridge.wifi.ssid}". Customers join it freely; the login page controls internet access.`);
    } else {
      lines.push(...pppoeLines(bridge.name));
    }
    changes.push({ kind: 'bridge', target: bridge.name, job: bridge.job, ports: bridge.ports.slice(),
      moves: bridge.ports.filter((p) => moves.has(p)).map((p) => ({ interface: p, from: moves.get(p) })),
      wifi: bridge.job === 'hotspot' && bridge.wifi ? bridge.wifi : undefined,
      title: `${bridge.name} · ${jobLabel(bridge.job)}${bridge.job === 'hotspot' && bridge.wifi ? ` · Wi-Fi "${bridge.wifi.ssid}"` : ''}`, lines });
  }
  for (const entry of plan && plan.existing || []) {
    const item = byName.get(entry.interface) || {};
    if (entry.job === 'hotspot') {
      if (entry.alreadyRunning || (running && running.interface === entry.interface)) { notes.push(`${entry.interface} already runs a hotspot. It stays exactly as it is.`); continue; }
      const usage = item.usage || [];
      if (usage.some((u) => /^(Has an IP address|DHCP server|Hotspot )/.test(u))) {
        blockers.push(`${entry.interface} already has its own IP address or DHCP server, so Wi-Fi Fiti won't start a hotspot there. Put free ports into a new hotspot bridge instead.`); continue;
      }
      if (!wan) { blockers.push('The router has not reported which connection carries the internet, so a hotspot cannot be started yet.'); continue; }
      changes.push({ kind: 'existing', target: entry.interface, job: 'hotspot', ports: [], moves: [],
        title: `${entry.interface} · Hotspot`, lines: [`Keep ${entry.interface} and its ports as they are.`, ...hotspotLines(entry.interface, false)] });
    } else {
      if (item.type !== 'bridge') { blockers.push(`PPPoE on the VLAN ${entry.interface} is coming next. For now, give PPPoE a bridge.`); continue; }
      changes.push({ kind: 'existing', target: entry.interface, job: 'pppoe', ports: [], moves: [],
        title: `${entry.interface} · PPPoE`, lines: [`Keep ${entry.interface} and its ports as they are.`, ...pppoeLines(entry.interface)] });
    }
  }
  // Keep a way in for the owner: a port kept for management, or a warning
  // when every free port is about to become a customer port.
  const used = new Set((plan && plan.bridges || []).flatMap((b) => b.ports));
  const kept = (plan && plan.keep) || [];
  if (kept.length) notes.push(`${kept.join(' and ')} ${kept.length > 1 ? 'are' : 'is'} reserved for you to manage the router with WinBox (connect by MAC address).`);
  else if (changes.length && !(layout && layout.interfaces || []).some((i) => i.physical && i.free && i.type === 'ether' && !used.has(i.name))) {
    notes.push('No free Ethernet port is left for you. Once customer ports block router settings, manage this router from the internet side (WinBox to its WAN address) or reserve a port for management on the map.');
  }
  // Hotspot first, so its customers keep a network while ports move to PPPoE.
  changes.sort((a, b) => Number(a.job === 'pppoe') - Number(b.job === 'pppoe'));
  return { changes, blockers, notes };
}

/* ---------------------------------------------------------------- scripts */

function reportFetch(query) {
  // Same double try as the poller: verified TLS first, then the compatibility
  // path for routers without a usable CA store.
  const url = '($fitiUrl . "/api/router/change?site=" . $fitiSite . "' + query + '")';
  return `:do { /tool fetch url=${url} check-certificate=yes http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=none } on-error={ :do { /tool fetch url=${url} http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=none } on-error={} }`;
}

/*
 * The undo, stored on the router before the change runs. Every step is
 * idempotent, so it is safe on a half-applied change and safe to run twice.
 * It ends by checking that the router really is back where it was, and only
 * then removes its reboot guard: a partial undo throws, keeps the guard and
 * keeps itself, so it runs again.
 */
function undoLines(change, id) {
  const tag = `Wi-Fi Fiti change ${id}`;
  const target = safe(change.target);
  const lines = [];
  if (change.kind === 'rename') {
    const from = safe(change.from);
    lines.push(`:do { :if ([:len [/interface bridge find where name="${target}"]] = 1) do={ /interface bridge set [find where name="${target}"] name="${from}" } } on-error={}`);
    if (change.job === 'hotspot') lines.push(...hotspotNameLines(target, from));
    lines.push(`:if ([:len [/interface bridge find where name="${from}"]] != 1) do={ :error "fiti-undo-incomplete" }`);
    lines.push(`:do { /system scheduler remove [find where name="fiti-revert-${id}"] } on-error={}`);
    return lines;
  }
  lines.push(...radioUndoLines(change, id));
  if (change.job === 'pppoe') {
    lines.push(`:do { :local p [/system script get [find where name="fiti-prev-${id}"] source]; :if ([:len $p] > 0) do={ /interface pppoe-server server set [find where comment="Wi-Fi Fiti PPPoE"] interface=$p } else={ :foreach s in=[/interface pppoe-server server find where comment="Wi-Fi Fiti PPPoE" and interface="${target}"] do={ /interface pppoe-server server set $s disabled=yes } } } on-error={}`);
  }
  if (change.job === 'hotspot') {
    lines.push(
      `:do { /ip hotspot remove [find where name="${HOTSPOT_NAME}" and profile="fiti-hs-${id}"] } on-error={}`,
      `:do { /ip hotspot profile remove [find where name="fiti-hs-${id}"] } on-error={}`,
      `:do { /ip dhcp-server remove [find where name="fiti-dhcp-${id}"] } on-error={}`,
      `:do { /ip dhcp-server network remove [find where comment="${tag}"] } on-error={}`,
      `:do { /ip pool remove [find where name="fiti-pool-${id}"] } on-error={}`,
      `:do { /ip address remove [find where comment="${tag}"] } on-error={}`,
      `:do { /ip firewall nat remove [find where comment="${tag}"] } on-error={}`,
      `:do { /ip firewall filter remove [find where comment="${tag}"] } on-error={}`,
      `:do { /ip firewall mangle remove [find where comment="${tag}"] } on-error={}`,
      `:do { :local d [/system script get [find where name="fiti-prevdns-${id}"] source]; :if ($d = "false") do={ /ip dns set allow-remote-requests=no } } on-error={}`,
      ':global fitiBridge', ':global fitiHotspotServer',
      `:if ($fitiHotspotServer = "${HOTSPOT_NAME}") do={ :set fitiHotspotServer ""; :set fitiBridge "" }`,
      `:do { :if ([/system script get [find where name="fiti-map"] comment] = "${tag}") do={ /system script remove [find where name="fiti-map"] } } on-error={}`,
      `:do { :local b [/system script get [find where name="fiti-prevboot-${id}"] source]; :if ([:len $b] > 0) do={ /system scheduler set [find where name="fiti-globals"] on-event=$b } } on-error={}`,
    );
  }
  if (change.kind === 'bridge') {
    lines.push(`:do { /interface bridge port remove [find where bridge="${target}"] } on-error={}`);
    for (const move of change.moves) lines.push(`:do { :if ([:len [/interface bridge port find where interface="${safe(move.interface)}"]] = 0) do={ /interface bridge port add bridge="${safe(move.from)}" interface="${safe(move.interface)}" } } on-error={}`);
    lines.push(`:do { /interface bridge remove [find where name="${target}"] } on-error={}`);
  }
  // Check the router is really back, before letting go of the reboot guard.
  if (change.kind === 'bridge') {
    lines.push(`:if ([:len [/interface find where name="${target}"]] > 0) do={ :error "fiti-undo-incomplete" }`);
    for (const move of change.moves) lines.push(`:if ([:len [/interface bridge port find where interface="${safe(move.interface)}" and bridge="${safe(move.from)}"]] != 1) do={ :error "fiti-undo-incomplete" }`);
  }
  if (change.job === 'hotspot') {
    lines.push(`:if (([:len [/ip hotspot find where profile="fiti-hs-${id}"]] > 0) || ([:len [/ip address find where comment="${tag}"]] > 0)) do={ :error "fiti-undo-incomplete" }`);
  }
  lines.push(...radioUndoCheckLines(change, id));
  for (const leftover of ['prev', 'prevdns', 'prevboot']) lines.push(`:do { /system script remove [find where name="fiti-${leftover}-${id}"] } on-error={}`);
  lines.push(`:do { /system scheduler remove [find where name="fiti-revert-${id}"] } on-error={}`);
  return lines;
}

// The poller keeps serving the hotspot after its bridge is renamed: its
// global and the boot copy in fiti-map follow the new name.
function hotspotNameLines(oldName, newName) {
  return [
    ':global fitiBridge',
    `:if ($fitiBridge = "${oldName}") do={ :set fitiBridge "${newName}" }`,
    `:do { :if ([/system script get [find where name="fiti-map"] comment] ~ "^Wi-Fi Fiti change") do={ /system script set [find where name="fiti-map"] source=${src([`:global fitiBridge "${newName}"`, `:global fitiHotspotServer "${HOTSPOT_NAME}"`])} } } on-error={}`,
  ];
}

/*
 * Customer Wi-Fi on a hotspot bridge: the radio is switched on as an open
 * access point. Its previous name, mode, security and on/off state are kept on
 * the router so the undo puts it back exactly. `wlan` is the RouterOS
 * `wireless` package (hAP lite, RB951); `wifi` is the newer `wifi` package.
 */
function radioKey(id, radio, field) { return `fiti-radio-${id}-${safe(radio)}-${field}`; }
// A radio that is switched on keeps the owner's Wi-Fi: customers get their
// own network on top of it (a virtual AP). Plans saved before this carry no
// mode and meant a takeover.
function isVirtual(radio) { return Boolean(radio && radio.mode === 'virtual'); }
function virtualRadioName(radio, id) { return `${radio.type === 'wlan' ? 'fiti-wlan' : 'fiti-wifi'}-${id}`; }
function virtualPorts(change) { return new Set(((change && change.wifi && change.wifi.radios) || []).filter(isVirtual).map((r) => r.name)); }
function radioApplyLines(change, id) {
  const lines = [];
  if (!change.wifi) return lines;
  const ssid = ros(change.wifi.ssid);
  const tag = `Wi-Fi Fiti change ${id}`;
  for (const radio of change.wifi.radios || []) {
    const r = safe(radio.name);
    if (isVirtual(radio)) {
      // The owner's radio is not touched at all: a second, open network on
      // the same radio joins the customer bridge.
      const v = virtualRadioName(radio, id);
      if (radio.type === 'wlan') {
        lines.push(
          `:if ([:len [/interface wireless security-profiles find where name="fiti-open-${id}"]] = 0) do={ /interface wireless security-profiles add name="fiti-open-${id}" mode=none }`,
          `/interface wireless add name="${v}" master-interface="${r}" mode=ap-bridge ssid=${ssid} security-profile="fiti-open-${id}" disabled=no comment="${tag}"`,
        );
      } else {
        lines.push(`/interface wifi add name="${v}" master-interface="${r}" configuration.ssid=${ssid} configuration.mode=ap security.authentication-types="" disabled=no comment="${tag}"`);
      }
      lines.push(`/interface bridge port add bridge="${safe(change.target)}" interface="${v}"`);
      continue;
    }
    if (radio.type === 'wlan') {
      const get = (prop) => `[:tostr [/interface wireless get [find where name="${r}"] ${prop}]]`;
      lines.push(
        `/system script add name="${radioKey(id, r, 'ssid')}" source=${get('ssid')}`,
        `/system script add name="${radioKey(id, r, 'mode')}" source=${get('mode')}`,
        `/system script add name="${radioKey(id, r, 'sec')}" source=${get('security-profile')}`,
        `/system script add name="${radioKey(id, r, 'off')}" source=${get('disabled')}`,
        `:if ([:len [/interface wireless security-profiles find where name="fiti-open-${id}"]] = 0) do={ /interface wireless security-profiles add name="fiti-open-${id}" mode=none }`,
        `/interface wireless set [find where name="${r}"] mode=ap-bridge ssid=${ssid} security-profile="fiti-open-${id}" disabled=no`,
      );
    } else {
      const get = (prop) => `[:tostr [/interface wifi get [find where name="${r}"] ${prop}]]`;
      lines.push(
        `/system script add name="${radioKey(id, r, 'ssid')}" source=${get('configuration.ssid')}`,
        `/system script add name="${radioKey(id, r, 'mode')}" source=${get('configuration.mode')}`,
        `/system script add name="${radioKey(id, r, 'sec')}" source=${get('security.authentication-types')}`,
        `/system script add name="${radioKey(id, r, 'off')}" source=${get('disabled')}`,
        `/interface wifi set [find where name="${r}"] configuration.ssid=${ssid} configuration.mode=ap security.authentication-types="" disabled=no`,
      );
    }
  }
  return lines;
}
function radioUndoLines(change, id) {
  const lines = [];
  if (!change.wifi) return lines;
  for (const radio of change.wifi.radios || []) {
    const r = safe(radio.name);
    if (isVirtual(radio)) {
      // Removing the customer network also takes it out of the bridge; the
      // owner's radio was never changed.
      lines.push(`:do { /interface ${radio.type === 'wlan' ? 'wireless' : 'wifi'} remove [find where name="${virtualRadioName(radio, id)}"] } on-error={}`);
      continue;
    }
    const val = (field) => `[/system script get [find where name="${radioKey(id, r, field)}"] source]`;
    if (radio.type === 'wlan') {
      lines.push(`:do { :local s ${val('ssid')}; :local m ${val('mode')}; :local p ${val('sec')}; :local d ${val('off')}; /interface wireless set [find where name="${r}"] ssid=$s mode=$m security-profile=$p disabled=($d = "true") } on-error={}`);
    } else {
      lines.push(`:do { :local s ${val('ssid')}; :local m ${val('mode')}; :local a ${val('sec')}; :local d ${val('off')}; /interface wifi set [find where name="${r}"] configuration.ssid=$s configuration.mode=$m security.authentication-types=$a disabled=($d = "true") } on-error={}`);
    }
  }
  lines.push(`:do { /interface wireless security-profiles remove [find where name="fiti-open-${id}"] } on-error={}`);
  for (const radio of change.wifi.radios || []) {
    if (isVirtual(radio)) continue;
    for (const field of ['ssid', 'mode', 'sec', 'off']) lines.push(`:do { /system script remove [find where name="${radioKey(id, radio.name, field)}"] } on-error={}`);
  }
  return lines;
}
// The undo is complete only once the customer network is gone.
function radioUndoCheckLines(change, id) {
  return ((change.wifi && change.wifi.radios) || []).filter(isVirtual)
    .map((radio) => `:if ([:len [/interface find where name="${virtualRadioName(radio, id)}"]] > 0) do={ :error "fiti-undo-incomplete" }`);
}

// Masks for prefix lengths 0-24: an existing network overlaps a candidate /24
// when both agree on the shorter of the two prefixes.
const MASKS = '{' + Array.from({ length: 25 }, (_, len) => {
  const n = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return `"m${len}"=${[24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.')}`;
}).join(';') + '}';

function subnetPreflightLines() {
  return [
    ':local fitiNet ""',
    // Any surprise while reading the router's networks stops the change.
    ':do {',
    `:local fitiMasks ${MASKS}`,
    // Every network the router already uses: addresses, routes (VPNs, static)
    // and DHCP networks. A candidate that overlaps any of them is skipped.
    ':local fitiUsed [:toarray ""]',
    ':foreach a in=[/ip address find] do={ :set fitiUsed ($fitiUsed , [:tostr [/ip address get $a address]]) }',
    ':do { :foreach r in=[/ip route find where dst-address!=0.0.0.0/0] do={ :set fitiUsed ($fitiUsed , [:tostr [/ip route get $r dst-address]]) } } on-error={}',
    ':foreach d in=[/ip dhcp-server network find] do={ :set fitiUsed ($fitiUsed , [:tostr [/ip dhcp-server network get $d address]]) }',
    ':foreach n in={50;51;52;53;54;55;56;57;58;59} do={',
    '  :if ($fitiNet = "") do={',
    '    :local cand [:toip ("10.5." . $n . ".0")]',
    '    :local used false',
    '    :foreach p in=$fitiUsed do={',
    '      :local sl [:find $p "/"]',
    '      :if ([:typeof $sl] != "nil") do={',
    '        :local ip [:toip [:pick $p 0 $sl]]',
    '        :local len [:tonum [:pick $p ($sl + 1) [:len $p]]]',
    '        :if (([:typeof $ip] = "ip") && ([:typeof $len] = "num")) do={',
    '          :if ($len > 24) do={ :set len 24 }',
    '          :local m ($fitiMasks->("m" . $len))',
    '          :if (($ip & $m) = ($cand & $m)) do={ :set used true }',
    '        }',
    '      }',
    '    }',
    // Pools: every range; a range uses this /24 if it reaches into it at all.
    '    :local c0 ($cand - 0.0.0.0)',
    '    :foreach pl in=[/ip pool find] do={',
    '      :foreach rg in=[:toarray [/ip pool get $pl ranges]] do={',
    '        :local r [:tostr $rg]; :local dash [:find $r "-"]; :local sl2 [:find $r "/"]',
    '        :if ([:typeof $sl2] != "nil") do={ :local pip [:toip [:pick $r 0 $sl2]]; :if ([:typeof $pip] = "ip") do={ :if (($pip & 255.255.255.0) = $cand) do={ :set used true } } } else={',
    '          :local a1 $r; :local a2 $r',
    '          :if ([:typeof $dash] != "nil") do={ :set a1 [:pick $r 0 $dash]; :set a2 [:pick $r ($dash + 1) [:len $r]] }',
    '          :local i1 [:toip $a1]; :local i2 [:toip $a2]',
    '          :if (([:typeof $i1] = "ip") && ([:typeof $i2] = "ip")) do={ :if ((($i1 - 0.0.0.0) <= ($c0 + 255)) && (($i2 - 0.0.0.0) >= $c0)) do={ :set used true } }',
    '        }',
    '      }',
    '    }',
    '    :if ($used = false) do={ :set fitiNet [:tostr $n] }',
    '  }',
    '}',
    '} on-error={ :set fitiWhy "subnet_check_failed" }',
    ':if (($fitiNet = "") && ([:len $fitiWhy] = 0)) do={ :set fitiWhy "no_free_subnet" }',
  ];
}

function hotspotApplyLines(change, id, { wan, cloudHost, portalHost, pppoeNet }) {
  const tag = `Wi-Fi Fiti change ${id}`;
  const target = safe(change.target);
  const out = safe(wan);
  const net = '("10.5." . $fitiNet . ".0/24")';
  const gw = '("10.5." . $fitiNet . ".1")';
  // Every rule goes directly before the first ordinary input rule, in its
  // final order (inserting before one fixed anchor keeps that order). On a
  // router with no input rules yet they are simply added, in the same order.
  const rule = (args) => `:if ([:typeof $fitiAnchor] = "id") do={ /ip firewall filter add ${args} comment="${tag}" place-before=$fitiAnchor } else={ /ip firewall filter add ${args} comment="${tag}" }`;
  const lines = [
    `/system script add name="fiti-prevdns-${id}" source=[:tostr [/ip dns get allow-remote-requests]]`,
    `:do { /system script add name="fiti-prevboot-${id}" source=[/system scheduler get [find where name="fiti-globals"] on-event] } on-error={}`,
    ':local fitiAnchor ""',
    ':do { :local s [/ip firewall filter find where chain=input dynamic=no]; :if ([:len $s] > 0) do={ :set fitiAnchor [:pick $s 0] } } on-error={}',
    // The router's DNS answers hotspot customers, never the internet side:
    // these drops exist before DNS is opened.
    rule(`chain=input in-interface="${out}" protocol=udp dst-port=53 action=drop`),
    rule(`chain=input in-interface="${out}" protocol=tcp dst-port=53 action=drop`),
    // Customers may reach only DNS, DHCP and the login page on the router.
    // 64872-64875 are where RouterOS itself serves the hotspot login.
    rule(`chain=input in-interface="${target}" protocol=tcp dst-port=53,80,443,64872-64875 action=accept`),
    rule(`chain=input in-interface="${target}" protocol=udp dst-port=53,67,64872 action=accept`),
    rule(`chain=input in-interface="${target}" action=drop`),
    `/ip address add address=("10.5." . $fitiNet . ".1/24") interface="${target}" comment="${tag}"`,
    `/ip pool add name="fiti-pool-${id}" ranges=("10.5." . $fitiNet . ".10-10.5." . $fitiNet . ".250") comment="${tag}"`,
    `/ip dhcp-server add name="fiti-dhcp-${id}" interface="${target}" address-pool="fiti-pool-${id}" lease-time=1h disabled=no comment="${tag}"`,
    `/ip dhcp-server network add address=${net} gateway=${gw} dns-server=${gw} comment="${tag}"`,
    '/ip dns set allow-remote-requests=yes',
    `/ip firewall nat add chain=srcnat src-address=${net} out-interface="${out}" action=masquerade comment="${tag}"`,
    `/ip firewall mangle add chain=postrouting out-interface="${target}" action=change-ttl new-ttl=set:1 passthrough=yes comment="${tag}"`,
  ];
  if (pppoeNet && /^10\.250\.\d{1,3}\.0\/24$/.test(pppoeNet)) {
    // Keep hotspot and PPPoE customers apart, whichever hotspot network was chosen.
    const fwd = (args) => `:if ([:typeof $fitiFwdAnchor] = "id") do={ /ip firewall filter add ${args} comment="${tag}" place-before=$fitiFwdAnchor } else={ /ip firewall filter add ${args} comment="${tag}" }`;
    lines.push(
      ':local fitiFwdAnchor ""',
      ':do { :local s [/ip firewall filter find where chain=forward dynamic=no]; :if ([:len $s] > 0) do={ :set fitiFwdAnchor [:pick $s 0] } } on-error={}',
      fwd(`chain=forward action=drop src-address=${net} dst-address="${pppoeNet}"`),
      fwd(`chain=forward action=drop src-address="${pppoeNet}" dst-address=${net}`),
    );
  }
  lines.push(
    `/ip hotspot profile add name="fiti-hs-${id}" hotspot-address=${gw} html-directory="hotspot" login-by=http-chap,http-pap use-radius=no`,
    `/ip hotspot add name="${HOTSPOT_NAME}" interface="${target}" address-pool="fiti-pool-${id}" profile="fiti-hs-${id}" addresses-per-mac=1 idle-timeout=10m keepalive-timeout=5m disabled=no`,
    ':if ([:len [/ip hotspot user profile find where name="standard"]] = 0) do={ /ip hotspot user profile add name="standard" shared-users=1 add-mac-cookie=yes mac-cookie-timeout=1d status-autorefresh=1m transparent-proxy=no }',
  );
  for (const host of [...new Set([cloudHost, portalHost].filter((h) => h && /^[A-Za-z0-9.-]{1,253}$/.test(h)))]) {
    lines.push(`:if ([:len [/ip hotspot walled-garden find where dst-host="${host}"]] = 0) do={ /ip hotspot walled-garden add dst-host="${host}" comment="Wi-Fi Fiti cloud" }`);
  }
  lines.push(
    // The poller serves this hotspot from now on, and keeps it after a reboot.
    ':global fitiBridge', ':global fitiHotspotServer',
    `:set fitiBridge "${target}"`, `:set fitiHotspotServer "${HOTSPOT_NAME}"`,
    ':do { :if ([/system script get [find where name="fiti-map"] comment] ~ "^Wi-Fi Fiti change") do={ /system script remove [find where name="fiti-map"] } } on-error={}',
    `/system script add name="fiti-map" policy=read,write,ftp,test,policy comment="${tag}" source=${src([`:global fitiBridge "${target}"`, `:global fitiHotspotServer "${HOTSPOT_NAME}"`])}`,
    ':do { /system scheduler set [find where name="fiti-globals"] on-event="/system script run fiti-boot; :do { /system script run fiti-map } on-error={}; /system script run fiti-poll" } on-error={}',
  );
  return lines;
}

// Read-only checks that a port is still free of any other job on the router.
function portFreeChecks(port) {
  const p = safe(port);
  return [
    `:if ([:len [/ip address find where interface="${p}"]] > 0) do={ :set fitiWhy "port_in_use" }`,
    `:if ([:len [/ip dhcp-client find where interface="${p}"]] > 0) do={ :set fitiWhy "port_in_use" }`,
    `:if ([:len [/interface vlan find where interface="${p}"]] > 0) do={ :set fitiWhy "port_in_use" }`,
    `:do { :if ([:len [/interface pppoe-client find where interface="${p}"]] > 0) do={ :set fitiWhy "port_in_use" } } on-error={}`,
    `:if ([:len [/interface pppoe-server server find where interface="${p}"]] > 0) do={ :set fitiWhy "port_in_use" }`,
  ];
}

/** The script a poll reply carries to apply one change. */
function applyScript(change, id, context) {
  if (change.kind === 'rename') return renameScript(change, id);
  const name = change.kind === 'bridge' ? safe(change.target) : null;
  const tag = `Wi-Fi Fiti change ${id}`;
  const lines = [
    `# Wi-Fi Fiti network change ${id}: ${change.title.replace(/[^A-Za-z0-9 ._-]/g, ' ').replace(/\s+/g, ' ')}`,
    ':do {',
    ':global fitiUrl', ':global fitiToken', ':global fitiSite',
    ':local fitiWhy ""',
    `:if ([:len [/system script find where name="fiti-undo-${id}"]] > 0) do={ :set fitiWhy "already_delivered" }`,
  ];
  // 1. Preflight (read-only): nothing is touched unless the router is still
  //    exactly as the dashboard showed it.
  if (name) {
    lines.push(`:if ([:len [/interface find where name="${name}"]] > 0) do={ :set fitiWhy "name_taken" }`);
    const leaving = new Map();
    const shared = virtualPorts(change);
    for (const port of change.ports) {
      if (shared.has(port)) continue;
      const from = (change.moves.find((m) => m.interface === port) || {}).from;
      lines.push(`:if ([:len [/interface find where name="${safe(port)}"]] != 1) do={ :set fitiWhy "port_changed" }`);
      lines.push(from
        ? `:if ([:len [/interface bridge port find where interface="${safe(port)}" and bridge="${safe(from)}"]] != 1) do={ :set fitiWhy "port_changed" }`
        : `:if ([:len [/interface bridge port find where interface="${safe(port)}"]] > 0) do={ :set fitiWhy "port_changed" }`);
      lines.push(...portFreeChecks(port));
      if (from) leaving.set(from, (leaving.get(from) || 0) + 1);
    }
    for (const [from, count] of leaving) {
      // The bridge a port leaves keeps at least one port, and bridges using
      // VLAN filtering are left alone (their port settings would be lost).
      lines.push(`:if ([:len [/interface bridge port find where bridge="${safe(from)}"]] <= ${count}) do={ :set fitiWhy "bridge_would_empty" }`);
      lines.push(`:do { :if ([/interface bridge get [find where name="${safe(from)}"] vlan-filtering] = true) do={ :set fitiWhy "vlan_filtering" } } on-error={ :set fitiWhy "port_changed" }`);
    }
  } else {
    lines.push(`:if ([:len [/interface find where name="${safe(change.target)}"]] != 1) do={ :set fitiWhy "interface_missing" }`);
  }
  for (const radio of (change.wifi && change.wifi.radios) || []) {
    const menu = radio.type === 'wlan' ? 'wireless' : 'wifi';
    const r = safe(radio.name);
    lines.push(`:if ([:len [/interface ${menu} find where name="${r}"]] != 1) do={ :set fitiWhy "radio_missing" }`);
    if (isVirtual(radio)) {
      // The owner's radio must still be on and serving as an access point;
      // a second network cannot ride on a radio that is off or a client.
      const v = virtualRadioName(radio, id);
      lines.push(`:if ([:len [/interface find where name="${v}"]] > 0) do={ :set fitiWhy "name_taken" }`);
      lines.push(radio.type === 'wlan'
        ? `:do { :local m [/interface wireless get [find where name="${r}"] mode]; :if ((($m != "ap-bridge") && ($m != "bridge")) || ([/interface wireless get [find where name="${r}"] disabled] = true)) do={ :set fitiWhy "radio_busy" } } on-error={ :set fitiWhy "radio_missing" }`
        : `:do { :local m [:tostr [/interface wifi get [find where name="${r}"] configuration.mode]]; :if ((($m != "ap") && ($m != "")) || ([/interface wifi get [find where name="${r}"] disabled] = true)) do={ :set fitiWhy "radio_busy" } } on-error={ :set fitiWhy "radio_missing" }`);
    }
  }
  if (change.job === 'hotspot') {
    lines.push(
      `:if ([:len [/interface find where name="${safe(context.wan)}"]] != 1) do={ :set fitiWhy "wan_missing" }`,
      ':if ([:len [/ip hotspot find]] > 0) do={ :set fitiWhy "hotspot_exists" }',
      `:if ([:len [/ip pool find where name="fiti-pool-${id}"]] > 0) do={ :set fitiWhy "name_taken" }`,
      `:do { :if (([:len [/system script find where name="fiti-map"]] > 0) && (!([/system script get [find where name="fiti-map"] comment] ~ "^Wi-Fi Fiti change"))) do={ :set fitiWhy "name_taken" } } on-error={}`,
    );
    if (!name) {
      const t = safe(change.target);
      lines.push(`:if (([:len [/ip address find where interface="${t}"]] > 0) || ([:len [/ip dhcp-server find where interface="${t}"]] > 0)) do={ :set fitiWhy "interface_in_use" }`);
    }
    lines.push(...subnetPreflightLines());
  }
  if (change.job === 'pppoe') {
    lines.push(':if ([:len [/interface pppoe-server server find where comment="Wi-Fi Fiti PPPoE"]] > 1) do={ :set fitiWhy "pppoe_ambiguous" }');
  }
  lines.push(`:if ([:len $fitiWhy] > 0) do={ ${reportFetch(`&id=${id}&state=failed&reason=" . $fitiWhy . "`)}; :error "fiti-change-preflight" }`);
  // 2. The undo is on the router before anything changes, with a guard that
  //    runs it if the router restarts before the cloud confirms.
  lines.push(`/system script add name="fiti-undo-${id}" policy=read,write,ftp,test,policy comment="${tag}" source=${src(undoLines(change, id))}`);
  // The step reached is saved on the router, so a restart in the middle can
  // be reported afterwards ("restarted while adding the Wi-Fi") instead of
  // leaving the dashboard with no answer.
  lines.push(`/system script add name="fiti-step-${id}" comment="${tag}" source="start"`);
  lines.push(`/system script add name="fiti-reboot-${id}" policy=read,write,ftp,test,policy comment="${tag}" source=${src(rebootLines(id))}`);
  lines.push(`/system scheduler add name="fiti-revert-${id}" start-time=startup policy=read,write,ftp,test,policy on-event="/system script run fiti-reboot-${id}" comment="${tag}: undo if the router restarts before the cloud confirms"`);
  // 3. The change. Any failure runs the undo at once.
  const step = (name) => `/system script set [find where name="fiti-step-${id}"] source="${name}"`;
  const body = [];
  if (name) {
    body.push(`/interface bridge add name="${name}" protocol-mode=rstp comment="Wi-Fi Fiti customer network (${jobLabel(change.job)})"`);
    const shared = virtualPorts(change);
    for (const port of change.ports) {
      if (shared.has(port)) continue;
      const from = (change.moves.find((m) => m.interface === port) || {}).from;
      if (from) body.push(`/interface bridge port remove [find where interface="${safe(port)}" and bridge="${safe(from)}"]`);
      body.push(`/interface bridge port add bridge="${name}" interface="${safe(port)}"`);
    }
  }
  if (change.job === 'hotspot') { body.push(step('hotspot')); body.push(...hotspotApplyLines(change, id, context)); }
  if (change.wifi) { body.push(step('wifi')); body.push(...radioApplyLines(change, id)); }
  if (change.job === 'pppoe') {
    body.push(
      ':local fitiPrev ""; :do { :set fitiPrev [/interface pppoe-server server get [find where comment="Wi-Fi Fiti PPPoE"] interface] } on-error={}',
      `/system script add name="fiti-prev-${id}" source=$fitiPrev`,
      `:if ([:len [/interface pppoe-server server find where comment="Wi-Fi Fiti PPPoE"]] = 1) do={ /interface pppoe-server server set [find where comment="Wi-Fi Fiti PPPoE"] interface="${safe(change.target)}" }`,
    );
  }
  // A partial undo keeps its script and guard, and says so, so the owner can
  // retry it from the dashboard.
  const undoNow = `:local fitiUndoWhy "undo_incomplete"; :do { /system script run fiti-undo-${id}; /system script remove [find where name="fiti-undo-${id}"]; :set fitiUndoWhy "" } on-error={}`;
  lines.push(`:log info "fiti: network change ${id} started"`);
  lines.push(':local fitiApplied false', ':do {', ...body.map((l) => '  ' + l), '  ' + step('confirm'), '  :set fitiApplied true', `  :log info "fiti: network change ${id} applied; checking the cloud"`,
    `} on-error={ ${undoNow}; :local fitiWhyFail "router_rejected"; :if ([:len $fitiUndoWhy] > 0) do={ :set fitiWhyFail $fitiUndoWhy }; ${reportFetch(`&id=${id}&state=failed&reason=" . $fitiWhyFail . "`)} }`);
  lines.push(`:if ($fitiApplied) do={ :execute script=${src(confirmLines(id, undoNow))} }`);
  lines.push('} on-error={}');
  return lines.join('\n');
}

// The progress marker and restart reporter are only needed while a change is
// waiting for the cloud.
function stepCleanupLines(id) {
  return [`:do { /system script remove [find where name="fiti-step-${id}"] } on-error={}`, `:do { /system script remove [find where name="fiti-reboot-${id}"] } on-error={}`];
}

// Runs at startup if the router restarted before the cloud confirmed: undo
// first, then tell the cloud what happened and at which step, retrying while
// the internet connection comes up.
function rebootLines(id) {
  const query = `&id=${id}&state=reverted&reason=" . $why . "`;
  const url = '($fitiUrl . "/api/router/change?site=" . $fitiSite . "' + query + '")';
  return [
    ':local step "start"',
    `:do { :set step [/system script get [find where name="fiti-step-${id}"] source] } on-error={}`,
    ':local why ("rebooted_" . $step)',
    ':local undone false',
    `:do { /system script run fiti-undo-${id}; :set undone true } on-error={}`,
    `:if ($undone) do={ :do { /system script remove [find where name="fiti-undo-${id}"] } on-error={}; :do { /system script remove [find where name="fiti-step-${id}"] } on-error={} } else={ :set why "undo_incomplete" }`,
    ':log warning ("fiti: restarted during network change ' + id + ' (" . $step . "); put it back")',
    ':local sent false', ':local i 0',
    ':while (($sent = false) && ($i < 18)) do={',
    '  :delay 10s',
    '  :global fitiUrl', '  :global fitiToken', '  :global fitiSite',
    `  :if ([:len $fitiUrl] > 0) do={ :do { /tool fetch url=${url} check-certificate=yes http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=none; :set sent true } on-error={ :do { /tool fetch url=${url} http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=none; :set sent true } on-error={} } }`,
    '  :set i ($i + 1)',
    '}',
    // A partial undo keeps this reporter and its guard, so it runs again.
    `:if ($undone) do={ :do { /system script remove [find where name="fiti-reboot-${id}"] } on-error={} }`,
  ];
}

// Keep a change only if the router can still reach the cloud. After the cloud
// confirms, the guard goes and the router says it kept the change.
function confirmLines(id, undoNow) {
  return [
    ':global fitiUrl', ':global fitiToken', ':global fitiSite',
    ':local ok false', ':local i 0',
    // First try after 1 s, then every 3 s, for about 80 s: a quick router is
    // confirmed within seconds, and even if every fetch times out this ends
    // well inside the cloud's 8-minute wait.
    ':while ((($ok = false) && ($i < 26))) do={',
    '  :if ($i = 0) do={ :delay 1s } else={ :delay 3s }',
    `  :local u ($fitiUrl . "/api/router/change?site=" . $fitiSite . "&id=${id}&state=applied")`,
    '  :local r ""',
    '  :do { :set r ([/tool fetch url=$u check-certificate=yes http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=user as-value]->"data") } on-error={ :do { :set r ([/tool fetch url=$u http-header-field=("X-WiFi-Fiti-Router: " . $fitiToken) output=user as-value]->"data") } on-error={} }',
    '  :if ($r = "confirmed") do={ :set ok true }',
    '  :set i ($i + 1)',
    '}',
    ':if ($ok) do={',
    `  :do { /system scheduler remove [find where name="fiti-revert-${id}"] } on-error={}`,
    `  :log info "fiti: network change ${id} confirmed"`,
    ...stepCleanupLines(id).map((l) => '  ' + l),
    '  ' + reportFetch(`&id=${id}&state=kept`),
    // A fresh layout report goes with the next sync, so the change is
    // verified within seconds instead of waiting for the next scheduled one.
    '  :do { /system script run fiti-inventory } on-error={}',
    '} else={',
    `  :log warning "fiti: network change ${id} lost the cloud; undoing it"`,
    `  ${undoNow}`,
    '  :delay 5s',
    '  ' + reportFetch(`&id=${id}&state=reverted&reason=" . $fitiUndoWhy . "`),
    ...stepCleanupLines(id).map((l) => '  ' + l),
    '}',
  ];
}

/** Rename a bridge Wi-Fi Fiti built. RouterOS keeps every reference to it. */
function renameScript(change, id) {
  const from = safe(change.from); const to = safe(change.target);
  const tag = `Wi-Fi Fiti change ${id}`;
  const undoNow = `:local fitiUndoWhy "undo_incomplete"; :do { /system script run fiti-undo-${id}; /system script remove [find where name="fiti-undo-${id}"]; :set fitiUndoWhy "" } on-error={}`;
  const lines = [
    `# Wi-Fi Fiti network change ${id}: rename ${from} to ${to}`,
    ':do {',
    ':global fitiUrl', ':global fitiToken', ':global fitiSite',
    ':local fitiWhy ""',
    `:if ([:len [/system script find where name="fiti-undo-${id}"]] > 0) do={ :set fitiWhy "already_delivered" }`,
    `:if ([:len [/interface bridge find where name="${from}"]] != 1) do={ :set fitiWhy "interface_missing" }`,
    `:if ([:len [/interface find where name="${to}"]] > 0) do={ :set fitiWhy "name_taken" }`,
    `:do { :if (!([/interface bridge get [find where name="${from}"] comment] ~ "Wi-Fi Fiti")) do={ :set fitiWhy "not_fiti_bridge" } } on-error={}`,
    `:if ([:len $fitiWhy] > 0) do={ ${reportFetch(`&id=${id}&state=failed&reason=" . $fitiWhy . "`)}; :error "fiti-change-preflight" }`,
    `/system script add name="fiti-undo-${id}" policy=read,write,ftp,test,policy comment="${tag}" source=${src(undoLines(change, id))}`,
    `/system scheduler add name="fiti-revert-${id}" start-time=startup policy=read,write,ftp,test,policy on-event="/system script run fiti-undo-${id}" comment="${tag}: undo if the router restarts before the cloud confirms"`,
    `:log info "fiti: network change ${id} started"`,
    ':local fitiApplied false',
    ':do {',
    `  /interface bridge set [find where name="${from}"] name="${to}"`,
    ...(change.job === 'hotspot' ? hotspotNameLines(from, to).map((l) => '  ' + l) : []),
    '  :set fitiApplied true',
    `} on-error={ ${undoNow}; :local fitiWhyFail "router_rejected"; :if ([:len $fitiUndoWhy] > 0) do={ :set fitiWhyFail $fitiUndoWhy }; ${reportFetch(`&id=${id}&state=failed&reason=" . $fitiWhyFail . "`)} }`,
    `:if ($fitiApplied) do={ :execute script=${src(confirmLines(id, undoNow))} }`,
    '} on-error={}',
  ];
  return lines.join('\n');
}

/** The script a poll reply carries to undo an applied change. */
function undoScript(id) {
  return [
    `# Wi-Fi Fiti: undo network change ${id}`,
    ':do {',
    ':global fitiUrl', ':global fitiToken', ':global fitiSite',
    `:if ([:len [/system script find where name="fiti-undo-${id}"]] = 1) do={`,
    `  :local fitiUndone false; :do { /system script run fiti-undo-${id}; :set fitiUndone true } on-error={}`,
    `  :if ($fitiUndone) do={ /system script remove [find where name="fiti-undo-${id}"]; ${stepCleanupLines(id).join('; ')}; ${reportFetch(`&id=${id}&state=undone`)} } else={ ${reportFetch(`&id=${id}&state=undo-failed`)} }`,
    `} else={ ${reportFetch(`&id=${id}&state=undo-missing`)} }`,
    '} on-error={}',
  ].join('\n');
}

/* ---------------------------------------------------------------- storage */

const insertChange = db.prepare(`INSERT INTO tenant_router_changes (location_id, batch_id, seq, kind, target, job, spec_json, status)
  VALUES (@locationId, @batchId, @seq, @kind, @target, @job, @spec, 'queued')`);
const changesFor = db.prepare(`SELECT * FROM tenant_router_changes WHERE location_id=? ORDER BY id DESC LIMIT 40`);
const activeFor = db.prepare(`SELECT * FROM tenant_router_changes WHERE location_id=? AND status IN ('queued','sent','confirming','undo-queued','undo-sent') ORDER BY id`);
const changeById = db.prepare(`SELECT * FROM tenant_router_changes WHERE id=? AND location_id=?`);
const setStatus = db.prepare(`UPDATE tenant_router_changes SET status=@status, reason=@reason, updated_at=datetime('now') WHERE id=@id`);

function publicChange(row) {
  let spec = {}; try { spec = JSON.parse(row.spec_json); } catch (_) {}
  return { id: row.id, batchId: row.batch_id, kind: row.kind, target: row.target, job: row.job, title: spec.title || row.target,
    lines: spec.lines || [], status: row.status, reason: row.reason || null, createdAt: row.created_at, updatedAt: row.updated_at,
    canUndo: ['applied', 'verified', 'mismatch'].includes(row.status) || row.reason === 'undo_incomplete' };
}

function listChanges(locationId) {
  return changesFor.all(locationId).map((row) => {
    const change = publicChange(row);
    if (row.kind === 'bridge') {
      change.currentName = currentName(locationId, row.target, row.id);
      change.canRename = ['applied', 'verified', 'mismatch'].includes(row.status);
    }
    return change;
  });
}
function hasActiveChange(locationId) { return activeFor.all(locationId).length > 0; }

function queueBatch(locationId, changes) {
  const batchId = `b${Date.now().toString(36)}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    changes.forEach((change, seq) => insertChange.run({ locationId, batchId, seq, kind: change.kind, target: change.target, job: change.job,
      spec: JSON.stringify({ title: change.title, lines: change.lines, ports: change.ports, moves: change.moves, from: change.from, wifi: change.wifi }) }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return batchId;
}

function queueUndo(locationId, id) {
  const row = changeById.get(id, locationId);
  if (!row) throw changeError('That change was not found.', 404);
  if (!['applied', 'verified', 'mismatch'].includes(row.status) && row.reason !== 'undo_incomplete') throw changeError('Only an applied change can be undone.', 409);
  if (hasActiveChange(locationId)) throw changeError('Wait for the change in progress to finish first.', 409);
  const newer = db.prepare(`SELECT id FROM tenant_router_changes WHERE location_id=? AND job=? AND kind!='rename' AND id>? AND status IN ('applied','verified','mismatch') LIMIT 1`).get(locationId, row.job, row.id);
  if (newer) throw changeError(`Undo the newer ${jobLabel(row.job)} change first.`, 409);
  // A newer change that moved a port out of this bridge must be undone first,
  // or its port would have no bridge to go back to.
  const later = db.prepare(`SELECT spec_json, target FROM tenant_router_changes WHERE location_id=? AND id>? AND status IN ('applied','verified','mismatch')`).all(locationId, row.id);
  for (const other of later) {
    let spec = {}; try { spec = JSON.parse(other.spec_json); } catch (_) {}
    if ((spec.moves || []).some((m) => m.from === row.target)) throw changeError(`Undo ${other.target} first: it took a port from ${row.target}.`, 409);
    if (spec.from === row.target) throw changeError(`Undo the rename to ${other.target} first.`, 409);
  }
  setStatus.run({ id: row.id, status: 'undo-queued', reason: null });
  return publicChange(changeById.get(id, locationId));
}

function cancelRest(locationId, batchId, reason) {
  db.prepare(`UPDATE tenant_router_changes SET status='cancelled', reason=?, updated_at=datetime('now') WHERE location_id=? AND batch_id=? AND status='queued'`).run(reason, locationId, batchId);
}

/**
 * The next piece of work for a poll reply: at most one change or undo at a
 * time, and never while one is still waiting for the router's answer.
 */
function nextScript(location, context, now = Date.now()) {
  const active = activeFor.all(location.id);
  for (const row of active) {
    if (!['sent', 'confirming', 'undo-sent'].includes(row.status)) continue;
    const age = now - parseSqlTime(row.updated_at);
    if (age < SENT_TIMEOUT_MS) return '';
    if (row.status === 'confirming') {
      // Longer than the router's own confirm loop can last, so it has finished.
      if (age < CONFIRMING_SETTLE_MS) return '';
      // The cloud confirmed but the router's "kept" never arrived. Its layout
      // report, if newer than the confirmation, says whether it kept it.
      const layout = context && context.layout;
      if (layout && parseSqlTime(layout.reportedAt) > parseSqlTime(row.updated_at)) {
        const kept = matchesLayout(row, layout);
        setStatus.run({ id: row.id, status: kept ? 'verified' : 'reverted', reason: kept ? null : 'lost_cloud' });
        if (!kept) cancelRest(location.id, row.batch_id, 'previous_reverted');
        continue;
      }
      if (age < 3 * SENT_TIMEOUT_MS) return '';
    }
    // No answer: the router may have undone it itself. Stop the batch and let
    // the owner look before anything else is sent.
    setStatus.run({ id: row.id, status: row.status === 'undo-sent' ? 'undo-no-answer' : 'no-answer', reason: 'no_answer' });
    if (row.status !== 'undo-sent') cancelRest(location.id, row.batch_id, 'previous_no_answer');
    return '';
  }
  const row = activeFor.all(location.id).find((r) => r.status === 'queued' || r.status === 'undo-queued');
  if (!row) return '';
  let spec = {}; try { spec = JSON.parse(row.spec_json); } catch (_) {}
  if (row.status === 'undo-queued') { const script = undoScript(row.id); setStatus.run({ id: row.id, status: 'undo-sent', reason: null }); return script; }
  const change = { kind: row.kind, target: row.target, job: row.job, ports: spec.ports || [], moves: spec.moves || [], title: spec.title || row.target, from: spec.from, wifi: spec.wifi };
  let script;
  try { script = applyScript(change, row.id, context); } catch (error) {
    // Built before it is marked sent, so a change that cannot be built is
    // reported as such instead of waiting for an answer that never comes.
    setStatus.run({ id: row.id, status: 'failed', reason: 'cannot_build' }); cancelRest(location.id, row.batch_id, 'previous_failed');
    return '';
  }
  setStatus.run({ id: row.id, status: 'sent', reason: null });
  return script;
}

const REASONS = new Set(['radio_missing', 'not_fiti_bridge', 'already_delivered', 'name_taken', 'port_changed', 'port_in_use', 'bridge_would_empty', 'vlan_filtering', 'interface_missing',
  'interface_in_use', 'wan_missing', 'hotspot_exists', 'no_free_subnet', 'subnet_check_failed', 'pppoe_ambiguous', 'router_rejected', 'undo_incomplete', 'radio_busy']);
// "The router restarted while …": the step a change had reached.
const REBOOT_REASONS = new Set(['rebooted_start', 'rebooted_hotspot', 'rebooted_wifi', 'rebooted_confirm']);
/** The router's answer about a change. Returns the reply body. */
function routerAnswer(location, query) {
  const id = Number(query.id);
  const row = Number.isInteger(id) ? changeById.get(id, location.id) : null;
  if (!row) return 'unknown';
  const state = String(query.state || '');
  if (state === 'applied') {
    // The router keeps the change only on this reply. It may ask again if a
    // reply is lost, so a change being confirmed is confirmed again.
    if (row.status === 'sent') { setStatus.run({ id, status: 'confirming', reason: null }); return 'confirmed'; }
    if (row.status === 'confirming') return 'confirmed';
    return 'not-confirmed';
  }
  if (state === 'kept') {
    if (row.status === 'confirming') setStatus.run({ id, status: 'applied', reason: null });
    return 'ok';
  }
  if (state === 'failed' && row.status === 'sent') {
    const reason = REASONS.has(String(query.reason)) ? String(query.reason) : 'router_rejected';
    setStatus.run({ id, status: 'failed', reason }); cancelRest(location.id, row.batch_id, 'previous_failed');
  } else if (state === 'reverted' && ['sent', 'confirming', 'applied', 'verified', 'no-answer'].includes(row.status)) {
    const why = String(query.reason);
    const reason = why === 'undo_incomplete' || REBOOT_REASONS.has(why) ? why : 'lost_cloud';
    setStatus.run({ id, status: 'reverted', reason }); cancelRest(location.id, row.batch_id, 'previous_reverted');
  } else if (state === 'undone' && row.status === 'undo-sent') {
    setStatus.run({ id, status: 'undone', reason: null });
  } else if ((state === 'undo-failed' || state === 'undo-missing') && row.status === 'undo-sent') {
    setStatus.run({ id, status: 'applied', reason: state.replace('-', '_') });
  }
  return 'ok';
}

/** The next layout report re-checks every applied change. */
function matchesLayout(row, layout) {
  let spec = {}; try { spec = JSON.parse(row.spec_json); } catch (_) {}
  // A bridge renamed later is checked under its current name.
  const name = row.kind === 'bridge' ? currentName(row.location_id, row.target, row.id) : row.target;
  const item = (layout.interfaces || []).find((i) => i.name === name);
  let ok = Boolean(item);
  if (ok && row.kind === 'rename') ok = !(layout.interfaces || []).some((i) => i.name === spec.from);
  if (ok && row.kind === 'bridge') {
    // A shared radio shows up in the bridge as its customer network.
    const shared = new Map(((spec.wifi && spec.wifi.radios) || []).filter(isVirtual).map((r) => [r.name, virtualRadioName(r, row.id)]));
    ok = (spec.ports || []).every((p) => (item.members || []).includes(shared.get(p) || p));
  }
  if (ok && row.job === 'hotspot') ok = (layout.hotspots || []).some((h) => h.interface === name && h.name === HOTSPOT_NAME);
  return ok;
}
function recheck(locationId, layout) {
  if (!layout) return;
  const rows = db.prepare(`SELECT * FROM tenant_router_changes WHERE location_id=? AND status IN ('applied','mismatch')`).all(locationId);
  for (const row of rows) {
    const ok = matchesLayout(row, layout);
    setStatus.run({ id: row.id, status: ok ? 'verified' : 'mismatch', reason: ok ? null : 'report_differs' });
  }
}

/** Where PPPoE runs on a universal-kit router, once a map put it somewhere. */
const LIVE = "('applied','verified','mismatch')";
/** What a bridge created by a change is called now, following later renames. */
function currentName(locationId, name, afterId) {
  const renames = db.prepare(`SELECT id, target, spec_json FROM tenant_router_changes WHERE location_id=? AND kind='rename' AND id>? AND status IN ${LIVE} ORDER BY id`).all(locationId, afterId);
  let current = name;
  for (const r of renames) { let spec = {}; try { spec = JSON.parse(r.spec_json); } catch (_) {} if (spec.from === current) current = r.target; }
  return current;
}
function appliedPppoeInterface(locationId) {
  const row = db.prepare(`SELECT id, target FROM tenant_router_changes WHERE location_id=? AND job='pppoe' AND kind!='rename' AND status IN ${LIVE} ORDER BY id DESC LIMIT 1`).get(locationId);
  return row ? currentName(locationId, row.target, row.id) : '';
}

/**
 * Rename a bridge a map created. Checked against a fresh layout report, then
 * sent like any other change: preflight, undo first, cloud confirm, verify.
 */
function queueRename(locationId, changeId, newName, layout, validName) {
  const row = changeById.get(Number(changeId), locationId);
  if (!row || row.kind !== 'bridge') throw changeError('That bridge was not found.', 404);
  if (!['applied', 'verified', 'mismatch'].includes(row.status)) throw changeError('Only a bridge that is on the router can be renamed.', 409);
  if (hasActiveChange(locationId)) throw changeError('Wait for the change in progress to finish first.', 409);
  const from = currentName(locationId, row.target, row.id);
  const to = String(newName || '').trim();
  if (!validName.test(to)) throw changeError('Use a short name: letters, numbers, - or _, starting with a letter.');
  if (to === from) throw changeError(`It is already called ${from}.`);
  const items = (layout && layout.interfaces) || [];
  if (!items.some((i) => i.name === from && i.type === 'bridge')) throw changeError(`${from} is not on the router's latest report.`, 409);
  if (items.some((i) => i.name === to)) throw changeError(`${to} already exists on the router. Choose another name.`);
  const lines = [`Rename bridge ${from} to ${to}.`, `Its ports, ${jobLabel(row.job)} service and settings stay exactly as they are.`];
  queueBatch(locationId, [{ kind: 'rename', target: to, job: row.job, ports: [], moves: [], from, title: `${from} → ${to} · Rename`, lines }]);
  return listChanges(locationId);
}

function batchSettled(locationId, batchId) {
  const rows = db.prepare(`SELECT status FROM tenant_router_changes WHERE location_id=? AND batch_id=?`).all(locationId, batchId);
  return rows.length > 0 && rows.every((r) => ['applied', 'verified'].includes(r.status));
}

module.exports = { queueRename, currentName, reviewPlan, applyScript, undoScript, undoLines, queueBatch, queueUndo, listChanges, hasActiveChange, nextScript, routerAnswer,
  recheck, appliedPppoeInterface, batchSettled, HOTSPOT_NAME, ACTIVE };

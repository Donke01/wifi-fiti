'use strict';

/*
 * Router topology inventory is deliberately a narrow, text-only protocol.
 * It is carried inside the already authenticated RouterOS polling body, so
 * there is no inbound connection to a customer router and no second router
 * credential.  The protocol never accepts addresses, MAC addresses, client
 * state, security profiles, Wi-Fi passphrases, RouterOS users, routes, or
 * WireGuard material.
 *
 * A current report looks like this (ordinary usage lines may appear before
 * or after it):
 *
 *   fiti-topology-v1
 *   topo|wan|ether1
 *   topo|customer-bridge|bridge-hs
 *   topo|interface|ether|ether1|up
 *   topo|wifi|wireless|wlan1|up
 *   topo|bridge-port|bridge-hs|ether2
 *   fiti-topology-end
 *
 * Keeping the grammar this small makes it practical for RouterOS scripts and
 * prevents an arbitrary RouterOS value from becoming a dashboard field.
 */

const crypto = require('crypto');

const BEGIN = 'fiti-topology-v1';
const END = 'fiti-topology-end';
const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const ROUTEROS_VERSION = /^[0-9][A-Za-z0-9_.-]{0,31}$/;
const INTERFACE_TYPES = new Set(['ether', 'bridge', 'wireless', 'wifi']);
const INTERFACE_STATES = new Set(['up', 'down', 'disabled', 'unknown']);
const WIFI_STACKS = new Set(['wireless', 'wifi']);

const LIMITS = Object.freeze({
  lines: 96,
  interfaces: 32,
  wifiInterfaces: 8,
  bridgePorts: 64,
});

function topologyError(message) {
  const error = new Error(message);
  error.code = 'invalid_router_topology';
  return error;
}

function safeToken(value, label) {
  const token = String(value || '');
  if (!TOKEN.test(token)) throw topologyError(`Invalid router topology ${label}.`);
  return token;
}

function addOnce(map, key, value, label) {
  if (map.has(key)) throw topologyError(`Duplicate router topology ${label}.`);
  map.set(key, value);
}

/**
 * Parse one optional topology block out of an authenticated router poll.
 * `null` means the poll came from an older agent and contains no inventory.
 * Invalid blocks throw, allowing callers to ignore topology without risking
 * a payment/usage sync failure.
 */
function parseRouterTopology(rawBody) {
  if (typeof rawBody !== 'string') return null;
  const lines = rawBody.split(/\r?\n/);
  // Do not build an ever-growing array while scanning an untrusted request.
  // A regular router sends exactly one short block, but a bounded linear scan
  // is just as clear and keeps malformed authenticated input inexpensive.
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== BEGIN) continue;
    if (start >= 0) throw topologyError('Duplicate router topology report.');
    start = index;
  }
  if (start < 0) return null;
  const end = lines.indexOf(END, start + 1);
  if (end < 0 || lines.indexOf(END, end + 1) >= 0 || end - start - 1 > LIMITS.lines) {
    throw topologyError('Incomplete router topology report.');
  }

  const scalar = new Map();
  const interfaces = new Map();
  const wifiInterfaces = new Map();
  const bridgePorts = new Map();

  for (const line of lines.slice(start + 1, end)) {
    if (!line || line.length > 160) throw topologyError('Invalid router topology record.');
    const fields = line.split('|');
    if (fields[0] !== 'topo') throw topologyError('Invalid router topology record.');
    const kind = fields[1];

    if (kind === 'wan' || kind === 'hotspot' || kind === 'customer-bridge') {
      if (fields.length !== 3) throw topologyError('Invalid router topology record.');
      addOnce(scalar, kind, safeToken(fields[2], kind), kind);
      continue;
    }
    if (kind === 'system') {
      if (fields.length !== 4 || fields[2] !== 'routeros' || !ROUTEROS_VERSION.test(fields[3])) {
        throw topologyError('Invalid router topology system record.');
      }
      addOnce(scalar, 'routeros', fields[3], 'routeros version');
      continue;
    }
    if (kind === 'interface') {
      if (fields.length !== 5 || !INTERFACE_TYPES.has(fields[2]) || !INTERFACE_STATES.has(fields[4])) {
        throw topologyError('Invalid router topology interface.');
      }
      const name = safeToken(fields[3], 'interface name');
      if (interfaces.size >= LIMITS.interfaces) throw topologyError('Too many router topology interfaces.');
      addOnce(interfaces, name, { type: fields[2], name, state: fields[4] }, 'interface');
      continue;
    }
    if (kind === 'wifi') {
      if (fields.length !== 5 || !WIFI_STACKS.has(fields[2]) || !INTERFACE_STATES.has(fields[4])) {
        throw topologyError('Invalid router topology Wi-Fi interface.');
      }
      const name = safeToken(fields[3], 'Wi-Fi interface name');
      if (wifiInterfaces.size >= LIMITS.wifiInterfaces) throw topologyError('Too many router topology Wi-Fi interfaces.');
      addOnce(wifiInterfaces, name, { stack: fields[2], name, state: fields[4] }, 'Wi-Fi interface');
      continue;
    }
    if (kind === 'bridge-port') {
      if (fields.length !== 4) throw topologyError('Invalid router topology bridge port.');
      const bridge = safeToken(fields[2], 'bridge name');
      const name = safeToken(fields[3], 'bridge-port interface name');
      const key = `${bridge}\u0000${name}`;
      if (bridgePorts.size >= LIMITS.bridgePorts) throw topologyError('Too many router topology bridge ports.');
      addOnce(bridgePorts, key, { bridge, interface: name }, 'bridge port');
      continue;
    }
    throw topologyError('Unknown router topology record.');
  }

  if (!interfaces.size) throw topologyError('Router topology contains no interfaces.');
  for (const wifi of wifiInterfaces.values()) {
    const iface = interfaces.get(wifi.name);
    if (!iface || iface.type !== wifi.stack || iface.state !== wifi.state) {
      throw topologyError('Router topology Wi-Fi interface does not match its interface record.');
    }
  }
  for (const port of bridgePorts.values()) {
    const bridge = interfaces.get(port.bridge);
    if (!bridge || bridge.type !== 'bridge' || !interfaces.has(port.interface)) {
      throw topologyError('Router topology bridge port does not match its interfaces.');
    }
  }
  // A WAN can legitimately be a logical interface (for example PPPoE or a
  // VLAN) whose physical parent is still the owner-selected Ethernet port.
  // Keep that detected WAN label without discarding the entire useful port
  // map merely because the compact inventory deliberately lists only the
  // physical Ethernet, bridge and Wi-Fi interface classes.
  if (scalar.has('customer-bridge')) {
    const bridge = interfaces.get(scalar.get('customer-bridge'));
    if (!bridge || bridge.type !== 'bridge') throw topologyError('Router topology customer bridge is invalid.');
  }

  const topology = {
    version: 1,
    routerosVersion: scalar.get('routeros') || null,
    wanInterface: scalar.get('wan') || null,
    hotspotServer: scalar.get('hotspot') || null,
    customerBridge: scalar.get('customer-bridge') || null,
    interfaces: [...interfaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    wifiInterfaces: [...wifiInterfaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    bridgePorts: [...bridgePorts.values()].sort((a, b) =>
      a.bridge.localeCompare(b.bridge) || a.interface.localeCompare(b.interface)),
  };
  // Keep the parser's legacy digest for callers that used it as a transport
  // integrity value. Tenant storage normalizes it to the stable layout
  // fingerprint below, so live link-state changes cannot invalidate mapping.
  const serialized = JSON.stringify(topology);
  return { topology, fingerprint: crypto.createHash('sha256').update(serialized).digest('hex') };
}

function topologyFreshAt(value, now = Date.now(), maxAgeMs = 5 * 60_000) {
  let text = String(value || '').trim().replace(' ', 'T');
  // SQLite's datetime('now') is UTC but has no explicit zone. Preserve an
  // explicit ISO zone if a future database adapter supplies one instead of
  // accidentally producing an invalid "ZZ" timestamp.
  if (text && !/(?:Z|[+-]\d\d:\d\d)$/i.test(text)) text += 'Z';
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && timestamp <= now && timestamp >= now - maxAgeMs;
}

function mappingError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function mappingName(value, label, { required = true } = {}) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw && !required) return null;
  if (!TOKEN.test(raw)) throw mappingError(`Choose a valid ${label} from the detected router inventory.`);
  return raw;
}

function mappingNames(value, label, { min = 0, max = 32 } = {}) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw mappingError(`Choose ${min ? 'at least one' : 'up to'} ${label} from the detected router inventory.`);
  }
  const names = value.map((item) => mappingName(item, label));
  if (new Set(names).size !== names.length) throw mappingError(`Choose each ${label} only once.`);
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Confirm a purely descriptive owner mapping. This never emits RouterOS
 * source or changes a router. Every selected item must occur in the current
 * topology snapshot, and customer-side ports/Wi-Fi must be bridge members of
 * the selected customer bridge.
 */
function validateRouterMapping(input, topology) {
  if (!topology || !Array.isArray(topology.interfaces)) {
    throw mappingError('Wait for a fresh router inventory before confirming its map.', 409);
  }
  const wanInterface = mappingName(input && input.wanInterface, 'WAN interface');
  const customerBridge = mappingName(input && input.customerBridge, 'customer bridge');
  const wifiInterfaces = mappingNames(input && input.wifiInterfaces, 'Wi-Fi interface', { max: LIMITS.wifiInterfaces });
  const customerPorts = mappingNames(input && input.customerPorts, 'customer Ethernet port', { max: LIMITS.interfaces });
  const interfaces = new Map(topology.interfaces.map((item) => [item.name, item]));
  const wifi = new Set((topology.wifiInterfaces || []).map((item) => item.name));
  const bridgePorts = new Set((topology.bridgePorts || []).map((item) => `${item.bridge}\u0000${item.interface}`));
  const wan = interfaces.get(wanInterface);
  const bridge = interfaces.get(customerBridge);
  if (!wan || wan.type !== 'ether') {
    throw mappingError('Choose a detected Ethernet interface for WAN.');
  }
  if (!bridge || bridge.type !== 'bridge') {
    throw mappingError('Choose a detected bridge for customer traffic.');
  }
  if (bridgePorts.has(`${customerBridge}\u0000${wanInterface}`)) {
    throw mappingError('The WAN interface is already a member of the customer bridge. Choose the correct WAN or customer bridge.');
  }
  for (const name of wifiInterfaces) {
    if (!wifi.has(name) || !bridgePorts.has(`${customerBridge}\u0000${name}`)) {
      throw mappingError(`Wi-Fi interface ${name} is not a detected member of ${customerBridge}.`);
    }
  }
  for (const name of customerPorts) {
    const iface = interfaces.get(name);
    if (!iface || iface.type !== 'ether' || name === wanInterface || !bridgePorts.has(`${customerBridge}\u0000${name}`)) {
      throw mappingError(`Customer Ethernet port ${name} is not a detected member of ${customerBridge}.`);
    }
  }
  return { version: 1, wanInterface, customerBridge, wifiInterfaces, customerPorts };
}

function mappingFingerprint(mapping) {
  return crypto.createHash('sha256').update(JSON.stringify(mapping)).digest('hex');
}

// Running/disabled flags change as customers connect and disconnect. They
// are useful display data, but never represent a layout change and therefore
// must not invalidate an owner's confirmed WAN/bridge/port map.
function topologyFingerprint(topology) {
  const stable = {
    version: topology.version,
    routerosVersion: topology.routerosVersion,
    wanInterface: topology.wanInterface,
    hotspotServer: topology.hotspotServer,
    customerBridge: topology.customerBridge,
    interfaces: (topology.interfaces || []).map(({ type, name }) => ({ type, name })),
    wifiInterfaces: (topology.wifiInterfaces || []).map(({ stack, name }) => ({ stack, name })),
    bridgePorts: topology.bridgePorts || [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/*
 * Inventory v2: the fuller layout report sent only by the universal kit.
 * It lists every configured interface and what it is already used for, so
 * the dashboard can show a true map and lock anything the owner's existing
 * network depends on. Like v1 it never carries addresses, MACs, secrets,
 * users or routes: only interface names, types and roles.
 *
 *   fiti-inventory-v2
 *   inv|system|routeros|7.24.2
 *   inv|board|hAP_lite
 *   inv|if|ether1|ether|up
 *   inv|vlan|vlan100|100|ether1
 *   inv|bport|bridge-tv|ether5
 *   inv|pppoe-client|pppoe-out1|vlan100
 *   inv|pppoe-server|pppoe|bridge-home|enabled
 *   inv|addr|bridge-home
 *   inv|dhcp-server|bridge-home|enabled
 *   inv|dhcp-client|ether1|bound
 *   inv|hotspot|hotspot1|bridge-hs
 *   inv|wan|pppoe-out1|pppoe
 *   inv|skipped|2
 *   fiti-inventory-end
 */
const INVENTORY_BEGIN = 'fiti-inventory-v2';
const INVENTORY_END = 'fiti-inventory-end';
const INVENTORY_LIMITS = Object.freeze({ lines: 200, interfaces: 64 });
const INVENTORY_STATES = new Set(['up', 'down', 'disabled']);
const WAN_KINDS = new Set(['pppoe', 'dhcp', 'static']);
const PHYSICAL_TYPES = new Set(['ether', 'wlan', 'wifi', 'wireless']);

function parseRouterInventory(rawBody) {
  if (typeof rawBody !== 'string') return null;
  const lines = rawBody.split(/\r?\n/);
  const start = lines.indexOf(INVENTORY_BEGIN);
  if (start < 0) return null;
  if (lines.indexOf(INVENTORY_BEGIN, start + 1) >= 0) throw topologyError('Duplicate router inventory report.');
  const end = lines.indexOf(INVENTORY_END, start + 1);
  if (end < 0 || end - start - 1 > INVENTORY_LIMITS.lines) throw topologyError('Incomplete router inventory report.');
  const inv = { version: 2, agent: 1, routerosVersion: null, board: null, wan: null, skipped: 0,
    interfaces: new Map(), vlans: [], bridgePorts: [], pppoeClients: [], pppoeServers: [],
    addressed: new Set(), dhcpServers: [], dhcpClients: [], hotspots: [], fitiBridges: new Set() };
  const tok = (value, label) => safeToken(value, label);
  for (const line of lines.slice(start + 1, end)) {
    if (!line) continue;
    if (line.length > 200) throw topologyError('Invalid router inventory record.');
    const f = line.split('|');
    if (f[0] !== 'inv') throw topologyError('Invalid router inventory record.');
    switch (f[1]) {
      case 'system': if (f[2] === 'routeros' && ROUTEROS_VERSION.test(f[3] || '')) inv.routerosVersion = f[3]; break;
      case 'board': inv.board = tok(f[2], 'board name'); break;
      case 'agent': inv.agent = Math.max(1, Math.min(99, Math.floor(Number(f[2]) || 1))); break;
      case 'if': {
        if (f.length !== 5 || !INVENTORY_STATES.has(f[4])) throw topologyError('Invalid router inventory interface.');
        const name = tok(f[2], 'interface name');
        if (inv.interfaces.size >= INVENTORY_LIMITS.interfaces) throw topologyError('Too many router inventory interfaces.');
        if (!inv.interfaces.has(name)) inv.interfaces.set(name, { name, type: tok(f[3], 'interface type'), state: f[4] });
        break;
      }
      case 'vlan': {
        const id = Number(f[3]);
        if (!Number.isInteger(id) || id < 1 || id > 4094) throw topologyError('Invalid router inventory VLAN.');
        inv.vlans.push({ name: tok(f[2], 'VLAN name'), vlanId: id, parent: tok(f[4], 'VLAN parent') });
        break;
      }
      case 'bport': inv.bridgePorts.push({ bridge: tok(f[2], 'bridge'), interface: tok(f[3], 'bridge port') }); break;
      case 'pppoe-client': inv.pppoeClients.push({ name: tok(f[2], 'PPPoE client'), interface: tok(f[3], 'PPPoE client interface') }); break;
      case 'pppoe-server': inv.pppoeServers.push({ service: tok(f[2], 'PPPoE service'), interface: tok(f[3], 'PPPoE server interface'), enabled: f[4] !== 'disabled' }); break;
      case 'addr': inv.addressed.add(tok(f[2], 'address interface')); break;
      case 'fiti-bridge': inv.fitiBridges.add(tok(f[2], 'Wi-Fi Fiti bridge')); break;
      case 'dhcp-server': inv.dhcpServers.push({ interface: tok(f[2], 'DHCP server interface'), enabled: f[3] !== 'disabled' }); break;
      case 'dhcp-client': inv.dhcpClients.push({ interface: tok(f[2], 'DHCP client interface'), status: TOKEN.test(f[3] || '') ? f[3] : 'unknown' }); break;
      case 'hotspot': inv.hotspots.push({ name: tok(f[2], 'Hotspot name'), interface: tok(f[3], 'Hotspot interface') }); break;
      case 'wan': inv.wan = { interface: tok(f[2], 'WAN interface'), kind: WAN_KINDS.has(f[3]) ? f[3] : 'static' }; break;
      case 'skipped': inv.skipped = Math.max(0, Math.min(999, Math.floor(Number(f[2]) || 0))); break;
      default: break; // newer agents may add records; ignore what this server does not know
    }
  }
  if (!inv.interfaces.size) throw topologyError('Router inventory contains no interfaces.');
  return describeInventory(inv);
}

/**
 * Work out what each interface is already used for. Anything the owner's
 * existing network depends on is locked; the internet path (the WAN and
 * every interface under it, e.g. pppoe-out1 -> vlan100 -> ether1) always is.
 */
function describeInventory(inv) {
  const uses = new Map([...inv.interfaces.keys()].map((name) => [name, []]));
  const use = (name, label) => { if (!uses.has(name)) return; if (!uses.get(name).includes(label)) uses.get(name).push(label); };
  const internet = new Set();
  const parentOf = new Map();
  inv.vlans.forEach((v) => parentOf.set(v.name, v.parent));
  inv.pppoeClients.forEach((c) => parentOf.set(c.name, c.interface));
  if (inv.wan) {
    let cursor = inv.wan.interface; const seen = new Set();
    while (cursor && !seen.has(cursor)) { seen.add(cursor); internet.add(cursor); cursor = parentOf.get(cursor); }
  }
  internet.forEach((name) => use(name, name === (inv.wan && inv.wan.interface) ? 'Internet connection' : 'Carries the internet connection'));
  inv.vlans.forEach((v) => use(v.parent, `Carries VLAN ${v.vlanId} (${v.name})`));
  inv.pppoeClients.forEach((c) => use(c.interface, `Runs PPPoE client ${c.name}`));
  inv.bridgePorts.forEach((p) => use(p.interface, `In bridge ${p.bridge}`));
  inv.pppoeServers.forEach((s) => use(s.interface, `PPPoE server${s.enabled ? '' : ' (disabled)'}`));
  inv.addressed.forEach((name) => use(name, 'Has an IP address'));
  inv.dhcpServers.forEach((d) => use(d.interface, `DHCP server${d.enabled ? '' : ' (disabled)'}`));
  inv.dhcpClients.forEach((d) => use(d.interface, 'DHCP client'));
  inv.hotspots.forEach((h) => use(h.interface, `Hotspot ${h.name}`));
  const members = new Map();
  inv.bridgePorts.forEach((p) => { if (!members.has(p.bridge)) members.set(p.bridge, []); members.get(p.bridge).push(p.interface); });
  // Most important first: a card shows its first two uses.
  const weight = (label) => [/^Internet connection/, /^Carries the internet/, /^Hotspot /, /^PPPoE server/, /^Runs PPPoE client/, /^DHCP server/, /^DHCP client/, /^Has an IP address/, /^In bridge /, /^Carries VLAN /]
    .findIndex((pattern) => pattern.test(label));
  const rank = (label) => { const w = weight(label); return w < 0 ? 99 : w; };
  const interfaces = [...inv.interfaces.values()].map((item) => {
    const usage = (uses.get(item.name) || []).slice().sort((a, b) => rank(a) - rank(b));
    const physical = PHYSICAL_TYPES.has(item.type);
    const vlan = inv.vlans.find((v) => v.name === item.name);
    // A port whose only job is membership of a bridge Wi-Fi Fiti built itself
    // may be moved to another bridge. Ports in the owner's own bridges, or
    // with any other job, stay locked.
    const ports = inv.bridgePorts.filter((p) => p.interface === item.name);
    const movableFrom = physical && !internet.has(item.name) && item.state !== 'disabled' && ports.length === 1
      && inv.fitiBridges.has(ports[0].bridge) && usage.length === 1 && usage[0] === `In bridge ${ports[0].bridge}` ? ports[0].bridge : null;
    return {
      ...item,
      physical,
      vlanId: vlan ? vlan.vlanId : null,
      parent: parentOf.get(item.name) || null,
      members: item.type === 'bridge' ? (members.get(item.name) || []).sort() : undefined,
      fitiBuilt: item.type === 'bridge' ? inv.fitiBridges.has(item.name) : undefined,
      movableFrom,
      usage,
      internet: internet.has(item.name),
      // Free: a port or radio nothing depends on. Everything else is kept as it is.
      free: physical && !usage.length && item.state !== 'disabled',
      locked: internet.has(item.name) || Boolean(usage.length) || !physical,
    };
  }).sort((a, b) => Number(b.physical) - Number(a.physical) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return {
    version: 2,
    agent: inv.agent,
    routerosVersion: inv.routerosVersion,
    board: inv.board,
    wan: inv.wan,
    skipped: inv.skipped,
    interfaces,
    vlans: inv.vlans,
    bridgePorts: inv.bridgePorts,
    pppoeClients: inv.pppoeClients,
    pppoeServers: inv.pppoeServers,
    dhcpServers: inv.dhcpServers,
    dhcpClients: inv.dhcpClients,
    hotspots: inv.hotspots,
    freeInterfaces: interfaces.filter((i) => i.free).map((i) => i.name),
    movableInterfaces: interfaces.filter((i) => i.movableFrom).map((i) => i.name),
    fitiBridges: [...inv.fitiBridges].filter((name) => inv.interfaces.has(name)).sort(),
  };
}

/*
 * Network plan (stage 2 of the universal kit). The owner maps where hotspot
 * and PPPoE customers connect: new bridges built only from FREE ports and
 * radios, and/or a job for an existing bridge or VLAN. The plan is checked
 * against the router's latest layout report and only saved here; nothing is
 * sent to the router until the owner applies it (stage 3).
 *
 *   { version: 1,
 *     bridges:  [{ name: 'fiti-hotspot', job: 'hotspot', ports: ['ether2', 'wlan1'] }],
 *     existing: [{ interface: 'bridge-home', job: 'pppoe' }] }
 */
const PLAN_JOBS = new Set(['hotspot', 'pppoe']);
const PLAN_BRIDGE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const PLAN_EXISTING_TYPES = new Set(['bridge', 'vlan']);

function planError(message) { const error = new Error(message); error.status = 400; return error; }

function validateNetworkPlan(input, layout) {
  if (!layout || !Array.isArray(layout.interfaces)) throw mappingError('Wait for the router to report its layout before saving a map.', 409);
  const byName = new Map(layout.interfaces.map((item) => [item.name, item]));
  const hotspotOn = new Map((layout.hotspots || []).map((h) => [h.interface, h.name]));
  const pppoeOn = new Set((layout.pppoeServers || []).map((p) => p.interface));
  // Ports the owner keeps for managing the router (WinBox); never bridged.
  const rawKeep = Array.isArray(input && input.keep) ? input.keep : [];
  if (rawKeep.length > 2) throw planError('Keep at most 2 ports for management.');
  const keep = [...new Set(rawKeep.map((p) => String(p || '').trim()))].map((port) => {
    const item = byName.get(port);
    if (!item || !item.physical) throw planError(`${port || 'That port'} is not a port on this router's latest report.`);
    if (item.internet) throw planError(`${port} carries the internet connection. Choose another port to keep for management.`);
    return port;
  });
  const rawBridges = Array.isArray(input && input.bridges) ? input.bridges : [];
  const rawExisting = Array.isArray(input && input.existing) ? input.existing : [];
  if (rawBridges.length > 4) throw planError('Add up to 4 new bridges.');
  if (rawExisting.length > 4) throw planError('Choose up to 4 existing bridges or VLANs.');
  const usedPorts = new Set();
  const moves = [];
  const names = new Set();
  const jobs = [];
  const bridges = rawBridges.map((raw) => {
    const name = String(raw && raw.name || '').trim();
    if (!PLAN_BRIDGE_NAME.test(name)) throw planError('Give each new bridge a short name: letters, numbers, - or _, starting with a letter.');
    if (byName.has(name)) throw planError(`${name} already exists on the router. Choose another name.`);
    if (names.has(name)) throw planError(`Two new bridges are both called ${name}.`);
    names.add(name);
    const job = String(raw && raw.job || '');
    if (!PLAN_JOBS.has(job)) throw planError(`Choose Hotspot or PPPoE for ${name}.`);
    const ports = Array.isArray(raw && raw.ports) ? raw.ports.map((p) => String(p || '').trim()) : [];
    if (!ports.length) throw planError(`Drag at least one free port or Wi-Fi into ${name}.`);
    if (ports.length > 16) throw planError(`${name} has too many ports.`);
    for (const port of ports) {
      const item = byName.get(port);
      if (!item) throw planError(`${port} is not on this router's latest report.`);
      if (!item.free && !item.movableFrom) throw planError(`${port} is already in use on the router, so it stays as it is. Choose a free port.`);
      if (keep.includes(port)) throw planError(`${port} is kept for managing the router. Choose another port for ${name}.`);
      if (usedPorts.has(port)) throw planError(`${port} can only belong to one bridge.`);
      usedPorts.add(port);
      if (item.movableFrom) moves.push({ interface: port, from: item.movableFrom });
    }
    jobs.push(job);
    return { name, job, ports: ports.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
  });
  const seenExisting = new Set();
  const existing = rawExisting.map((raw) => {
    const name = String(raw && raw.interface || '').trim();
    const item = byName.get(name);
    if (!item) throw planError(`${name || 'That interface'} is not on this router's latest report.`);
    if (!PLAN_EXISTING_TYPES.has(item.type)) throw planError(`Only an existing bridge or VLAN can be given a job. Put ${name} into a new bridge instead.`);
    if (item.internet) throw planError(`${name} carries the internet connection, so it stays as it is.`);
    if (seenExisting.has(name)) throw planError(`${name} is listed twice.`);
    seenExisting.add(name);
    const job = String(raw && raw.job || '');
    if (!PLAN_JOBS.has(job)) throw planError(`Choose Hotspot or PPPoE for ${name}.`);
    jobs.push(job);
    return { interface: name, job, alreadyRunning: job === 'hotspot' ? hotspotOn.has(name) : pppoeOn.has(name) };
  });
  if (!bridges.length && !existing.length) throw planError('Add a bridge or choose an existing bridge or VLAN first.');
  keep.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // A Wi-Fi Fiti bridge keeps at least one port, so whatever runs on it
  // (e.g. the hotspot on bridge-hs) still has somewhere for customers to connect.
  const leaving = new Map();
  moves.forEach((m) => leaving.set(m.from, (leaving.get(m.from) || 0) + 1));
  leaving.forEach((count, from) => {
    const bridge = byName.get(from);
    if (bridge && (bridge.members || []).length - count < 1) throw planError(`Leave at least one port in ${from}, so it keeps working.`);
  });
  if (jobs.filter((j) => j === 'hotspot').length > 1) throw planError('Choose one place for hotspot customers.');
  if (jobs.filter((j) => j === 'pppoe').length > 1) throw planError('Choose one place for PPPoE customers.');
  // One customer Hotspot per router: if the router already runs one somewhere
  // else, the plan must use that one rather than add a second.
  const hotspotPlan = [...bridges, ...existing].find((entry) => entry.job === 'hotspot');
  const runningHotspot = [...hotspotOn.keys()][0];
  if (hotspotPlan && runningHotspot && (hotspotPlan.interface || hotspotPlan.name) !== runningHotspot) {
    throw planError(`This router already runs a hotspot on ${runningHotspot}. Use it for hotspot customers instead of adding another.`);
  }
  moves.sort((a, b) => a.interface.localeCompare(b.interface, undefined, { numeric: true }));
  return { version: 1, bridges, existing, moves, keep };
}

module.exports = {
  BEGIN,
  END,
  LIMITS,
  parseRouterTopology,
  topologyFreshAt,
  topologyFingerprint,
  validateRouterMapping,
  mappingFingerprint,
  INVENTORY_BEGIN,
  INVENTORY_END,
  parseRouterInventory,
  describeInventory,
  validateNetworkPlan,
};

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

module.exports = {
  BEGIN,
  END,
  LIMITS,
  parseRouterTopology,
  topologyFreshAt,
  validateRouterMapping,
  mappingFingerprint,
};

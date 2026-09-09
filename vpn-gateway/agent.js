#!/usr/bin/env node
'use strict';

/*
 * WiFi Fiti WireGuard gateway reconciler.
 *
 * This runs on the VPN VPS, not on Railway. It owns only peer records that
 * are present in its local state file. The WireGuard private key never enters
 * this process: status is collected with non-secret `wg show` fields rather
 * than `wg show ... dump`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
const GATEWAY_ID = /^[a-z][a-z0-9-]{0,62}$/;
const INTERFACE = /^[A-Za-z0-9_.-]{1,15}$/;
const MAX_PEERS = 20_000;
const DESIRED_REVISION = /^[a-f0-9]{64}$/;

function fail(message) {
  const error = new Error(message);
  error.code = 'CONFIG';
  throw error;
}

function wireGuardPublicKey(value, name) {
  const key = String(value || '').trim();
  if (!PUBLIC_KEY.test(key) || Buffer.from(key, 'base64').length !== 32) {
    fail(`${name} must be a 32-byte WireGuard public key in standard base64 format.`);
  }
  return key;
}

/*
 * The first production gateway intentionally reserves just this management
 * network. Keep the VPS-side boundary as strict as the application and the
 * RouterOS activation script: a compromised or misconfigured control plane
 * must not turn this agent into a route/source-address oracle for another
 * private network.
 */
function managementAllowedAddress(value) {
  const raw = String(value || '').trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/.exec(raw);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255) || octets[0] !== 10 || octets[1] !== 254) return null;
  // Keep the same conservative reservations as the app allocator. The
  // gateway itself is 10.254.0.1, so it can never be handed to a router.
  if (octets[3] === 0 || octets[3] === 255 || (octets[2] === 0 && octets[3] === 1)) return null;
  const canonical = `${octets.join('.')}/32`;
  return raw === canonical ? canonical : null;
}

function configFromEnv(env = process.env) {
  const coreUrl = String(env.WIFI_FITI_CORE_URL || '').trim().replace(/\/$/, '');
  let parsed;
  try { parsed = new URL(coreUrl); } catch (_) { fail('WIFI_FITI_CORE_URL must be a complete HTTPS URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail('WIFI_FITI_CORE_URL must be a bare HTTPS origin.');
  }
  const gatewayId = String(env.WIFI_FITI_GATEWAY_ID || '').trim();
  if (!GATEWAY_ID.test(gatewayId)) fail('WIFI_FITI_GATEWAY_ID is invalid.');
  const secret = String(env.WIFI_FITI_GATEWAY_SECRET || '');
  if (secret.length < 32) fail('WIFI_FITI_GATEWAY_SECRET must contain at least 32 characters.');
  const gatewayPublicKey = wireGuardPublicKey(env.WIFI_FITI_GATEWAY_PUBLIC_KEY, 'WIFI_FITI_GATEWAY_PUBLIC_KEY');
  const interfaceName = String(env.WIFI_FITI_WG_INTERFACE || 'wg-fiti').trim();
  if (!INTERFACE.test(interfaceName)) fail('WIFI_FITI_WG_INTERFACE is invalid.');
  const pollSeconds = Number(env.WIFI_FITI_GATEWAY_POLL_SECONDS || 5);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 3 || pollSeconds > 60) fail('WIFI_FITI_GATEWAY_POLL_SECONDS must be an integer from 3 to 60.');
  const stateFile = String(env.WIFI_FITI_GATEWAY_STATE_FILE || '/var/lib/wifi-fiti-vpn-agent/state.json');
  if (!path.isAbsolute(stateFile)) fail('WIFI_FITI_GATEWAY_STATE_FILE must be an absolute path.');
  return { coreUrl, gatewayId, secret, gatewayPublicKey, interfaceName, pollSeconds, stateFile };
}

function command(program, args, run = spawnSync) {
  const result = run(program, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000 });
  if (result.error) throw new Error(`${program} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${program} failed: ${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  return String(result.stdout || '');
}

function peerLines(text, label, transform) {
  const rows = new Map();
  for (const line of String(text || '').trim().split('\n').filter(Boolean)) {
    const fields = line.split('\t');
    if (!PUBLIC_KEY.test(fields[0] || '')) continue;
    rows.set(fields[0], transform(fields.slice(1)));
  }
  if (rows.size > MAX_PEERS) throw new Error(`WireGuard returned too many ${label} records.`);
  return rows;
}

function peerKeyLines(text) {
  const keys = String(text || '').trim().split('\n').filter(Boolean).filter((key) => PUBLIC_KEY.test(key));
  if (keys.length > MAX_PEERS) throw new Error('WireGuard returned too many peer records.');
  return [...new Set(keys)];
}

/** Read only non-secret WireGuard fields. Never call `wg show ... dump`: its
 * first tab-delimited field is the private interface key. */
function readWireGuardStatus(interfaceName, run = spawnSync) {
  const publicKey = String(command('wg', ['show', interfaceName, 'public-key'], run)).trim();
  if (!PUBLIC_KEY.test(publicKey) || Buffer.from(publicKey, 'base64').length !== 32) {
    throw new Error('WireGuard did not return a valid gateway public key.');
  }
  const listenPort = Number(String(command('wg', ['show', interfaceName, 'listen-port'], run)).trim());
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('WireGuard did not return a valid listen port.');
  }
  const keys = peerKeyLines(command('wg', ['show', interfaceName, 'peers'], run));
  const allowedIps = peerLines(command('wg', ['show', interfaceName, 'allowed-ips'], run), 'allowed-IP', (fields) => fields[0] || '');
  const handshakes = peerLines(command('wg', ['show', interfaceName, 'latest-handshakes'], run), 'handshake', (fields) => Number(fields[0]) || 0);
  const endpoints = peerLines(command('wg', ['show', interfaceName, 'endpoints'], run), 'endpoint', (fields) => fields[0] || '');
  const keepalives = peerLines(command('wg', ['show', interfaceName, 'persistent-keepalive'], run), 'keepalive', (fields) => Number(fields[0]) || 0);
  const peers = new Map();
  for (const key of keys) {
    peers.set(key, {
      publicKey: key,
      allowedIps: allowedIps.get(key) || '',
      lastHandshakeEpoch: handshakes.get(key) || 0,
      endpoint: endpoints.get(key) || '',
      persistentKeepalive: keepalives.get(key) || 0,
    });
  }
  return { publicKey, listenPort, peers };
}

function statePeer(value) {
  if (typeof value === 'string' && PUBLIC_KEY.test(value)) return { publicKey: value, allowedAddress: null };
  if (!value || typeof value !== 'object' || !PUBLIC_KEY.test(String(value.publicKey || ''))) return null;
  const allowedAddress = value.allowedAddress === null || value.allowedAddress === undefined
    ? null : managementAllowedAddress(value.allowedAddress);
  if (value.allowedAddress !== null && value.allowedAddress !== undefined && !allowedAddress) return null;
  return { publicKey: String(value.publicKey), allowedAddress };
}

function dedupeStatePeers(values) {
  const peers = new Map();
  for (const raw of Array.isArray(values) ? values : []) {
    const peer = statePeer(raw);
    if (peer) peers.set(peer.publicKey, peer);
  }
  return [...peers.values()].sort((a, b) => a.publicKey.localeCompare(b.publicKey));
}

function emptyState() {
  return {
    version: 3,
    managedPeers: [],
    pendingAppliedPeers: [],
    pendingRemovedPeerKeys: [],
    reportedHandshakes: {},
    desiredRevision: null,
    desiredPeers: [],
  };
}

function normalizeState(value) {
  const input = value && typeof value === 'object' ? value : {};
  // Version 1 stored only keys. Preserve their ownership on upgrade, but do
  // not claim an applied configuration until `wg show` confirms its /32.
  const managedPeers = dedupeStatePeers(Array.isArray(input.managedPeers) ? input.managedPeers : input.managedPeerKeys);
  const managedKeys = new Set(managedPeers.map((peer) => peer.publicKey));
  const pendingAppliedPeers = dedupeStatePeers(input.pendingAppliedPeers)
    .filter((peer) => peer.allowedAddress && managedKeys.has(peer.publicKey));
  const pendingRemovedPeerKeys = [...new Set((Array.isArray(input.pendingRemovedPeerKeys) ? input.pendingRemovedPeerKeys : [])
    .filter((key) => PUBLIC_KEY.test(String(key || '')))
    .map(String))].sort();
  const reportedHandshakes = {};
  for (const [key, epoch] of Object.entries(input.reportedHandshakes || {})) {
    const numeric = Number(epoch);
    if (PUBLIC_KEY.test(key) && Number.isInteger(numeric) && numeric > 0) reportedHandshakes[key] = numeric;
  }
  const candidateRevision = DESIRED_REVISION.test(String(input.desiredRevision || '')) ? String(input.desiredRevision) : null;
  const rawDesiredPeers = Array.isArray(input.desiredPeers) ? input.desiredPeers : null;
  const desiredPeers = dedupeStatePeers(rawDesiredPeers)
    .filter((peer) => peer.allowedAddress);
  const desiredSnapshotValid = rawDesiredPeers !== null && desiredPeers.length === rawDesiredPeers.length;
  // Never send a cache validator without the matching local snapshot. A
  // missing/corrupt state file must ask Railway for a complete desired set.
  return {
    version: 3,
    managedPeers,
    pendingAppliedPeers,
    pendingRemovedPeerKeys,
    reportedHandshakes,
    desiredRevision: desiredSnapshotValid ? candidateRevision : null,
    desiredPeers,
  };
}

function readState(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState();
    throw new Error(`Could not read gateway state: ${error.message}`);
  }
}

function writeState(file, state) {
  const safeState = normalizeState(state);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(safeState, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validDesiredPeer(value) {
  if (!value || typeof value !== 'object') return null;
  const publicKey = String(value.publicKey || '');
  const allowedAddress = managementAllowedAddress(value.allowedAddress);
  if (!PUBLIC_KEY.test(publicKey) || !allowedAddress) return null;
  return { publicKey, allowedAddress };
}

function statePeerMap(state) {
  return new Map(normalizeState(state).managedPeers.map((peer) => [peer.publicKey, peer]));
}

function pendingPeerMap(state) {
  return new Map(normalizeState(state).pendingAppliedPeers.map((peer) => [peer.publicKey, peer]));
}

function reportForState(dump, state) {
  const safeState = normalizeState(state);
  const pendingApplied = pendingPeerMap(safeState);
  const appliedPeers = [...pendingApplied.values()]
    .filter((peer) => {
      const current = dump.peers.get(peer.publicKey);
      return Boolean(current && current.allowedIps === peer.allowedAddress && current.persistentKeepalive === 25);
    })
    .sort((a, b) => a.publicKey.localeCompare(b.publicKey));
  const removedPeerKeys = safeState.pendingRemovedPeerKeys
    .filter((key) => !dump.peers.has(key));
  const observations = [];
  for (const peer of safeState.managedPeers) {
    const current = dump.peers.get(peer.publicKey);
    const epoch = Number(current && current.lastHandshakeEpoch) || 0;
    if (!peer.allowedAddress || !Number.isInteger(epoch) || epoch <= 0 || epoch <= (safeState.reportedHandshakes[peer.publicKey] || 0)) continue;
    observations.push({ publicKey: peer.publicKey, allowedAddress: peer.allowedAddress, lastHandshakeEpoch: epoch });
  }
  return {
    appliedPeers,
    removedPeerKeys,
    observations,
    knownRevision: safeState.desiredRevision,
  };
}

// Kept as a small compatibility helper for callers/tests that only need
// observations; unlike the old implementation it does not resend stale data.
function observations(dump, state) {
  return reportForState(dump, state).observations;
}

function acknowledgeReport(state, report) {
  const safeState = normalizeState(state);
  const applied = new Set((report.appliedPeers || []).map((peer) => peer.publicKey));
  const removed = new Set((report.removedPeerKeys || []).map(String));
  const reportedHandshakes = { ...safeState.reportedHandshakes };
  for (const observation of report.observations || []) {
    if (PUBLIC_KEY.test(String(observation.publicKey || '')) && Number.isInteger(Number(observation.lastHandshakeEpoch)) && Number(observation.lastHandshakeEpoch) > 0) {
      reportedHandshakes[observation.publicKey] = Number(observation.lastHandshakeEpoch);
    }
  }
  return normalizeState({
    ...safeState,
    pendingAppliedPeers: safeState.pendingAppliedPeers.filter((peer) => !applied.has(peer.publicKey)),
    pendingRemovedPeerKeys: safeState.pendingRemovedPeerKeys.filter((key) => !removed.has(key)),
    reportedHandshakes,
    desiredRevision: safeState.desiredRevision,
    desiredPeers: safeState.desiredPeers,
  });
}

function reconcile({ interfaceName, desiredPeers, dump, state, run = spawnSync }) {
  const desired = new Map();
  for (const rawPeer of Array.isArray(desiredPeers) ? desiredPeers : []) {
    const peer = validDesiredPeer(rawPeer);
    if (!peer) throw new Error('Gateway received an invalid desired peer.');
    if (desired.has(peer.publicKey)) throw new Error('Gateway received the same desired peer twice.');
    if (desired.size >= MAX_PEERS) throw new Error('Gateway received too many desired peers.');
    desired.set(peer.publicKey, peer);
  }

  const safeState = normalizeState(state);
  const nextManaged = statePeerMap(safeState);
  const pendingApplied = pendingPeerMap(safeState);
  const pendingRemoved = new Set(safeState.pendingRemovedPeerKeys);
  const reportedHandshakes = { ...safeState.reportedHandshakes };

  for (const peer of desired.values()) {
    const current = dump.peers.get(peer.publicKey);
    const previous = nextManaged.get(peer.publicKey);
    const matches = Boolean(current && current.allowedIps === peer.allowedAddress && current.persistentKeepalive === 25);
    if (!matches) {
      command('wg', ['set', interfaceName, 'peer', peer.publicKey, 'allowed-ips', peer.allowedAddress, 'persistent-keepalive', '25'], run);
      // The next cycle confirms `wg show` really contains this exact peer
      // before Railway is told it is safe to activate the router side.
      pendingApplied.set(peer.publicKey, peer);
      delete reportedHandshakes[peer.publicKey];
    } else if (!previous || previous.allowedAddress !== peer.allowedAddress) {
      // Safe adoption after an agent restart/state restoration: it matches
      // the core's exact desired record, and still waits one report cycle.
      pendingApplied.set(peer.publicKey, peer);
    }
    nextManaged.set(peer.publicKey, peer);
    pendingRemoved.delete(peer.publicKey);
  }

  for (const [publicKey] of statePeerMap(safeState)) {
    if (desired.has(publicKey)) continue;
    if (dump.peers.has(publicKey)) command('wg', ['set', interfaceName, 'peer', publicKey, 'remove'], run);
    nextManaged.delete(publicKey);
    pendingApplied.delete(publicKey);
    pendingRemoved.add(publicKey);
    delete reportedHandshakes[publicKey];
  }

  return normalizeState({
    version: 3,
    managedPeers: [...nextManaged.values()],
    pendingAppliedPeers: [...pendingApplied.values()],
    pendingRemovedPeerKeys: [...pendingRemoved],
    reportedHandshakes,
    desiredRevision: safeState.desiredRevision,
    desiredPeers: safeState.desiredPeers,
  });
}

async function requestDesired(config, report, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(`${config.coreUrl}/api/internal/vpn-gateways/${encodeURIComponent(config.gatewayId)}/sync`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-WiFi-Fiti-Gateway': config.secret,
      },
      body: JSON.stringify(report),
    });
    if (!response.ok) throw new Error(`Gateway sync rejected with HTTP ${response.status}.`);
    const body = await response.json();
    if (!body || body.version !== 2 || !DESIRED_REVISION.test(String(body.revision || '')) ||
        typeof body.unchanged !== 'boolean' || !Array.isArray(body.peers)) {
      throw new Error('Gateway sync response is malformed.');
    }
    if (body.unchanged && body.peers.length) throw new Error('Gateway returned an inconsistent unchanged response.');
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function cycle(config, { run = spawnSync, fetchImpl = fetch } = {}) {
  const state = readState(config.stateFile);
  const dump = readWireGuardStatus(config.interfaceName, run);
  if (dump.publicKey !== config.gatewayPublicKey) {
    throw new Error('The live WireGuard interface public key does not match WIFI_FITI_GATEWAY_PUBLIC_KEY. Refusing to reconcile peers.');
  }
  const report = reportForState(dump, state);
  const desired = await requestDesired(config, report, fetchImpl);
  const acknowledged = acknowledgeReport(state, report);
  const desiredPeers = desired.unchanged ? acknowledged.desiredPeers : desired.peers;
  if (desired.unchanged && !acknowledged.desiredRevision) {
    throw new Error('Gateway returned an unchanged desired state before the agent had a local snapshot.');
  }
  const next = reconcile({ interfaceName: config.interfaceName, desiredPeers, dump, state: {
    ...acknowledged,
    desiredRevision: desired.revision,
    desiredPeers,
  }, run });
  writeState(config.stateFile, next);
  return { desired: desiredPeers.length, managed: next.managedPeers.length };
}

async function main() {
  const config = configFromEnv();
  let delayMs = config.pollSeconds * 1000;
  for (;;) {
    try {
      const result = await cycle(config);
      console.log(`[wifi-fiti-gateway] reconciled ${result.managed} peer(s); ${result.desired} desired`);
      delayMs = config.pollSeconds * 1000;
    } catch (error) {
      console.error(`[wifi-fiti-gateway] ${error.message}`);
      delayMs = Math.min(Math.max(delayMs * 2, config.pollSeconds * 1000), 60_000);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[wifi-fiti-gateway] fatal: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  acknowledgeReport,
  configFromEnv,
  emptyState,
  managementAllowedAddress,
  normalizeState,
  observations,
  readState,
  readWireGuardStatus,
  reconcile,
  reportForState,
  requestDesired,
  validDesiredPeer,
  writeState,
  cycle,
};

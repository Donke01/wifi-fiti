#!/usr/bin/env node
'use strict';

/*
 * Router terminal reachability probe.
 *
 * Runs on the VPS gateway. Walks the three layers a terminal session needs
 * for a router's tunnel address and reports exactly which one fails:
 *
 *   1. WireGuard tunnel: a wg peer routes the address and has a recent handshake
 *   2. TCP: port 22 on the tunnel address accepts connections
 *   3. SSH: the endpoint completes an SSH handshake (banner + key exchange),
 *      proven by reaching the authentication step with dummy credentials
 *
 * Usage: node probe-terminal.js <tunnel-ip> [port]
 * Honors WIFI_FITI_WG_INTERFACE (default wg-fiti).
 *
 * Never sends real credentials: layer 3 uses deliberately invalid
 * credentials and treats "authentication rejected" as success, because
 * reaching the auth step proves the SSH handshake works. Run one probe
 * at a time; repeated bad-password attempts can trip RouterOS
 * brute-force protection.
 *
 * Exit codes: 0 all layers pass, 10 tunnel failed, 20 TCP failed,
 * 30 SSH failed, 64 usage/policy error.
 */

const net = require('node:net');
const { Client } = require('ssh2');
const agent = require('./agent');

const INTERFACE = String(process.env.WIFI_FITI_WG_INTERFACE || 'wg-fiti').trim();
const HANDSHAKE_FRESH_SECONDS = 180;
const CONNECT_TIMEOUT_MS = 8000;

function usage() {
  console.error('Usage: node probe-terminal.js <tunnel-ip> [port]');
  console.error('Probes the router-terminal path for one tunnel address from this gateway.');
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipInCidr(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function checkTunnel(targetIp) {
  let status;
  try {
    status = agent.readWireGuardStatus(INTERFACE);
  } catch (error) {
    const message = String(error.message || error);
    if (/ENOENT/.test(message)) {
      return { ok: false, detail: `the 'wg' tool is not installed on this gateway (run this probe on the VPS gateway)` };
    }
    return { ok: false, detail: `could not read WireGuard status on ${INTERFACE}: ${message}` };
  }
  const now = Math.floor(Date.now() / 1000);
  const routed = [];
  for (const peer of status.peers.values()) {
    for (const cidr of String(peer.allowedIps || '').split(/[\s,]+/).filter(Boolean)) {
      if (ipInCidr(targetIp, cidr)) { routed.push(peer); break; }
    }
  }
  if (!routed.length) {
    return {
      ok: false,
      detail: `no WireGuard peer routes ${targetIp} (is the router enrolled and its tunnel configured?)`,
    };
  }
  const stale = routed.filter((peer) => now - (peer.lastHandshakeEpoch || 0) > HANDSHAKE_FRESH_SECONDS);
  if (stale.length === routed.length) {
    const ages = routed.map((peer) => {
      const epoch = peer.lastHandshakeEpoch || 0;
      return epoch ? `${now - epoch}s ago` : 'never';
    });
    return {
      ok: false,
      detail: `peer routes ${targetIp} but the last handshake is stale (${ages.join(', ')}); the tunnel is down`,
    };
  }
  const fresh = routed.find((peer) => now - (peer.lastHandshakeEpoch || 0) <= HANDSHAKE_FRESH_SECONDS);
  const age = now - (fresh.lastHandshakeEpoch || 0);
  return { ok: true, detail: `peer handshake ${age}s ago` };
}

function checkTcp(targetIp, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: targetIp, port, timeout: CONNECT_TIMEOUT_MS });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done({ ok: true, detail: `connected in ${Date.now() - started}ms` }));
    socket.once('timeout', () => done({
      ok: false,
      detail: `timed out after ${CONNECT_TIMEOUT_MS}ms (routing or firewall is dropping packets to ${targetIp}:${port})`,
    }));
    socket.once('error', (error) => {
      const hints = {
        ECONNREFUSED: `connection refused: nothing is listening on ${port} (is SSH enabled on the router?)`,
        EHOSTUNREACH: 'host unreachable: no route to the tunnel address',
        ENETUNREACH: 'network unreachable: the tunnel interface may be down',
      };
      done({ ok: false, detail: hints[error.code] || `TCP error: ${error.message}` });
    });
  });
}

function checkSsh(targetIp, port) {
  return new Promise((resolve) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      resolve({ ok: false, detail: `SSH handshake timed out after ${CONNECT_TIMEOUT_MS}ms` });
    }, CONNECT_TIMEOUT_MS);
    let banner = '';
    conn.on('banner', (message) => { banner = String(message || '').trim(); });
    conn.on('ready', () => {
      // Should never happen with dummy credentials, but it still proves SSH works.
      clearTimeout(timer);
      conn.end();
      resolve({ ok: true, detail: banner ? `banner: ${banner} (authenticated?! check credentials)` : 'authenticated' });
    });
    conn.on('error', (error) => {
      clearTimeout(timer);
      const message = String((error && error.message) || error);
      // Reaching the authentication step proves banner + key exchange worked.
      if (/all configured authentication methods failed/i.test(message)) {
        resolve({
          ok: true,
          detail: `${banner ? `banner: ${banner}; ` : ''}reached authentication (rejected dummy credentials, as expected)`,
        });
        return;
      }
      if (/handshake|kex|banner|protocol/i.test(message)) {
        resolve({ ok: false, detail: `SSH handshake failed before authentication: ${message}` });
        return;
      }
      resolve({ ok: false, detail: `SSH error: ${message}` });
    });
    try {
      conn.connect({
        host: targetIp,
        port,
        username: 'terminal-probe',
        password: `invalid-${Date.now()}`,
        readyTimeout: CONNECT_TIMEOUT_MS,
        algorithms: undefined,
      });
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, detail: `could not start SSH: ${error.message}` });
    }
  });
}

async function main() {
  const [targetIp, portRaw] = process.argv.slice(2);
  const port = portRaw === undefined ? 22 : Number(portRaw);
  if (!targetIp || !Number.isInteger(port) || port < 1 || port > 65535) {
    usage();
    process.exit(64);
  }
  const policyError = agent.validRelayTarget(targetIp, port);
  if (policyError) {
    console.error(`Not probing: ${policyError}`);
    console.error('The probe only covers the terminal relay policy: 10.254.0.0/16, SSH port 22.');
    process.exit(64);
  }

  console.log(`Router terminal probe: ${targetIp}:${port} (interface ${INTERFACE})\n`);
  const layers = [
    ['WireGuard tunnel', () => checkTunnel(targetIp)],
    ['TCP', () => checkTcp(targetIp, port)],
    ['SSH handshake', () => checkSsh(targetIp, port)],
  ];
  const codes = [10, 20, 30];
  for (let i = 0; i < layers.length; i++) {
    const [name, check] = layers[i];
    let result;
    try {
      result = await check();
    } catch (error) {
      result = { ok: false, detail: `probe error: ${error.message}` };
    }
    const label = result.ok ? 'OK  ' : 'FAIL';
    console.log(`[${i + 1}/3] ${name.padEnd(16)} ${label}  ${result.detail}`);
    if (!result.ok) {
      console.log(`\nThe terminal will not work: layer ${i + 1} (${name}) failed.`);
      console.log('Fix this layer first, then re-run the probe.');
      process.exit(codes[i]);
    }
  }
  console.log('\nAll layers pass: the terminal should be able to open a shell on this router.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Probe crashed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { checkTunnel, checkTcp, checkSsh, ipInCidr };

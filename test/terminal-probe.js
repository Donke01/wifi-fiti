'use strict';

/* Router terminal reachability probe: the layer checks, exercised with
 * mocked network peers. The full CLI path is for the VPS gateway. */

const assert = require('node:assert/strict');
const net = require('node:net');
const probe = require('../vpn-gateway/probe-terminal');

/* ---- ipInCidr ---- */

assert.equal(probe.ipInCidr('10.254.0.7', '10.254.0.7/32'), true);
assert.equal(probe.ipInCidr('10.254.0.7', '10.254.0.0/16'), true);
assert.equal(probe.ipInCidr('10.254.0.7', '10.254.0.8/32'), false);
assert.equal(probe.ipInCidr('10.254.0.7', '10.0.0.0/8'), true);
assert.equal(probe.ipInCidr('192.168.1.1', '10.254.0.0/16'), false);
assert.equal(probe.ipInCidr('not-an-ip', '10.254.0.0/16'), false);
assert.equal(probe.ipInCidr('10.254.0.7', 'garbage'), false);

/* ---- checkTcp: success and refusal, against local sockets ---- */

async function main() {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const openPort = server.address().port;

  const ok = await probe.checkTcp('127.0.0.1', openPort);
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /connected in/);

  const refused = await probe.checkTcp('127.0.0.1', 1);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /refused|nothing is listening/);

  server.close();

  /* ---- checkSsh: a banner with no handshake behind it ---- */

  const bannerServer = net.createServer((socket) => {
    socket.write('SSH-2.0-ROS_SSH\r\n');
    // Never completes key exchange; the probe must time out, not hang.
  });
  await new Promise((resolve) => bannerServer.listen(0, '127.0.0.1', resolve));
  const bannerPort = bannerServer.address().port;
  const bannerOnly = await probe.checkSsh('127.0.0.1', bannerPort);
  assert.equal(bannerOnly.ok, false);
  assert.match(bannerOnly.detail, /timed out|handshake/i);
  bannerServer.close();

  /* ---- checkSsh: not an SSH server at all ---- */

  const httpish = net.createServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\n\r\n');
    socket.end();
  });
  await new Promise((resolve) => httpish.listen(0, '127.0.0.1', resolve));
  const httpPort = httpish.address().port;
  const notSsh = await probe.checkSsh('127.0.0.1', httpPort);
  assert.equal(notSsh.ok, false);
  httpish.close();

  /* ---- checkTunnel: degrades gracefully without WireGuard ---- */

  const tunnel = probe.checkTunnel('10.254.0.7');
  assert.equal(tunnel.ok, false);
  assert.match(tunnel.detail, /wg|WireGuard|no WireGuard peer/i);

  console.log('terminal-probe: all assertions passed');
}

main().catch((error) => { console.error(error); process.exit(1); });

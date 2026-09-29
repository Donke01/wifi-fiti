'use strict';

/* Router terminal link layer: agent control channel, relay sockets, and
 * the blocked-line session flow. The SSH transports themselves are
 * exercised with mocked peers; real routers are not required. */

process.env.DATABASE_PATH = '/tmp/wifi-fiti-terminal-link-test.db';
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '1';
process.env.MPESA_PASSKEY = 'p';
try { require('node:fs').unlinkSync('/tmp/wifi-fiti-terminal-link-test.db'); } catch (_) {}

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const terminalLink = require('../src/lib/terminal-link');
const terminal = require('../src/lib/router-terminal');

function fakeAgentWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => { ws.sent.push(JSON.parse(String(data))); };
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  ws.terminate = ws.close;
  ws.ping = () => {};
  return ws;
}

async function main() {
  /* ---- Control channel attach, hello, capabilities ---- */

  const agentWs = fakeAgentWs();
  const detach = terminalLink.attachAgent('gw-test', agentWs);
  assert.equal(terminalLink.channelOnline('gw-test'), true);
  terminalLink._routeAgentFrame('gw-test', JSON.stringify({ type: 'hello', capabilities: ['tcp-relay'] }));
  assert.deepEqual(terminalLink.channelCapabilities('gw-test'), ['tcp-relay']);

  /* ---- Relay socket: app -> agent tcp-open, agent -> app data ---- */

  const opened = terminalLink.openRelaySocket('gw-test', '10.254.0.7', 22);
  const openFrame = agentWs.sent.find((frame) => frame.type === 'tcp-open');
  assert.ok(openFrame, 'app sends tcp-open to the agent');
  assert.equal(openFrame.host, '10.254.0.7');
  assert.equal(openFrame.port, 22);

  terminalLink._routeAgentFrame('gw-test', JSON.stringify({ type: 'tcp-opened', id: openFrame.id }));
  const socket = await opened;
  assert.ok(socket && typeof socket.write === 'function', 'relay socket resolves');

  const received = [];
  socket.on('data', (chunk) => received.push(chunk.toString()));
  terminalLink._routeAgentFrame('gw-test', JSON.stringify({
    type: 'tcp-data', id: openFrame.id, chunk: Buffer.from('router-echo').toString('base64'),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ['router-echo']);

  socket.write('client-bytes');
  const dataFrame = agentWs.sent.find((frame) => frame.type === 'tcp-data' && frame.id === openFrame.id);
  assert.ok(dataFrame, 'socket writes are forwarded as tcp-data');
  assert.equal(Buffer.from(dataFrame.chunk, 'base64').toString(), 'client-bytes');

  terminalLink._routeAgentFrame('gw-test', JSON.stringify({ type: 'tcp-closed', id: openFrame.id }));
  await new Promise((resolve) => socket.on('close', resolve));

  /* ---- Unknown gateway: relay open fails fast ---- */

  await assert.rejects(
    terminalLink.openRelaySocket('gw-missing', '10.254.0.7', 22),
    (error) => error.status === 503
  );

  detach();
  assert.equal(terminalLink.channelOnline('gw-test'), false);

  /* ---- Session blocked-line flow: Ctrl-C + audit ---- */

  const session = terminalLink.createTerminalSession({
    businessId: 'biz-link', locationId: 'loc-link', transport: 'direct',
    gatewayId: 'gw-test', managementAddress: '10.254.0.7',
  });
  const written = [];
  session.shell = { write: (data) => written.push(String(data)), resize() {}, close() {} };
  let blockedNotice = null;
  session.onBlocked = (line, label) => { blockedNotice = { line, label }; };

  session.handleUserData('/system reboot\n');
  assert.ok(written.includes('\x03'), 'blocked line is interrupted with Ctrl-C');
  assert.equal(blockedNotice.label, 'reboot');

  session.handleUserData('/ip address print\n');
  assert.equal(blockedNotice.label, 'reboot', 'allowed line does not trigger a block');
  session.close('test done');

  const [recent] = terminal.recentSessions('biz-link', 5);
  assert.equal(recent.lines_blocked, 1);
  assert.equal(recent.lines_run, 1);
  assert.equal(recent.close_reason, 'test done');

  // Idle sweep closes the session through the registry path.
  const session2 = terminalLink.createTerminalSession({
    businessId: 'biz-link', locationId: 'loc-link-2', transport: 'direct',
    gatewayId: 'gw-test', managementAddress: '10.254.0.7',
  });
  session2.shell = { write() {}, resize() {}, close() {} };
  terminal.registerSession(session2);
  session2.lastActivityAt = Date.now() - terminal.IDLE_TIMEOUT_MS - 1000;
  terminal.sweepSessions();
  assert.equal(session2.closed, true);

  console.log('terminal-link: all assertions passed');
}

main().catch((error) => { console.error(error); process.exit(1); });

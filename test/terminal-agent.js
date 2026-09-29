'use strict';

/* Gateway agent terminal control channel: relay target validation, config,
 * handshake, and frame routing with mocked network peers. */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const agent = require('../vpn-gateway/agent');

/* ---- Relay targets stay inside the management network, SSH port only ---- */

assert.equal(agent.validRelayTarget('10.254.0.7', 22), null);
assert.equal(agent.validRelayTarget('10.254.99.200', 22), null);
assert.ok(agent.validRelayTarget('10.254.0.7', 80), 'non-SSH ports are refused');
assert.ok(agent.validRelayTarget('10.254.0.7', 2222), 'non-SSH ports are refused');
assert.ok(agent.validRelayTarget('192.168.1.1', 22), 'LAN addresses are refused');
assert.ok(agent.validRelayTarget('10.0.0.7', 22), 'other 10/8 addresses are refused');
assert.ok(agent.validRelayTarget('10.254.0.1', 22), 'the gateway address itself is refused');
assert.ok(agent.validRelayTarget('10.254.0.255', 22), 'broadcast is refused');
assert.ok(agent.validRelayTarget('not-an-ip', 22), 'garbage is refused');
assert.ok(agent.validRelayTarget('', 22), 'empty host is refused');

/* ---- Config: disabled by default, proxy is a separate opt-in ---- */

assert.equal(agent.terminalControlConfigFromEnv({}), null);
const base = { coreUrl: 'https://cloud.wififiti.co.ke', gatewayId: 'primary', secret: 's'.repeat(32) };
const enabled = agent.terminalControlConfigFromEnv({ WIFI_FITI_TERMINAL_CONTROL: '1' }, base);
assert.equal(enabled.gatewayId, 'primary');
assert.equal(enabled.allowProxy, false);
const withProxy = agent.terminalControlConfigFromEnv(
  { WIFI_FITI_TERMINAL_CONTROL: 'true', WIFI_FITI_TERMINAL_PROXY: '1' }, base);
assert.equal(withProxy.allowProxy, true);
assert.equal(
  agent.terminalControlUrl(base),
  'wss://cloud.wififiti.co.ke/api/internal/vpn-gateways/primary/terminal-control'
);

/* ---- Control channel with mocked WebSocket + TCP dial ---- */

function mockWebSocketClass(capture) {
  return class MockWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      capture.url = url;
      capture.headers = options && options.headers;
      this.readyState = 1;
      this.sent = [];
      capture.instance = this;
      setImmediate(() => this.emit('open'));
    }
    send(data) { this.sent.push(JSON.parse(String(data))); }
    ping() {}
    close() { this.readyState = 3; this.emit('close'); }
  };
}

function mockNet() {
  // A fake TCP socket that behaves like a connected relay target.
  return {
    connect() {
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.write = (chunk) => { socket.lastWrite = chunk; };
      socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
      setImmediate(() => socket.emit('connect'));
      return socket;
    },
  };
}

async function main() {
  // --- TCP relay allowed, shell proxy off ---
  const capture = {};
  const stop = agent.startTerminalControl(
    { coreUrl: 'https://cloud.wififiti.co.ke', gatewayId: 'primary', secret: 's'.repeat(32), allowProxy: false },
    { wsImpl: mockWebSocketClass(capture), netImpl: mockNet(), connectDelayMs: 50 }
  );
  await new Promise((resolve) => setImmediate(resolve));
  const ws = capture.instance;
  assert.ok(ws, 'agent dials out to the control channel');
  assert.equal(capture.url, 'wss://cloud.wififiti.co.ke/api/internal/vpn-gateways/primary/terminal-control');
  assert.equal(capture.headers['X-WiFi-Fiti-Gateway'], 's'.repeat(32));
  const hello = ws.sent.find((frame) => frame.type === 'hello');
  assert.deepEqual(hello.capabilities, ['tcp-relay']);

  ws.emit('message', JSON.stringify({ type: 'ping' }));
  assert.ok(ws.sent.find((frame) => frame.type === 'pong'), 'ping gets a pong');

  // Invalid relay target: refused without dialling.
  ws.emit('message', JSON.stringify({ type: 'tcp-open', id: 'r-bad', host: '192.168.1.9', port: 22 }));
  const refused = ws.sent.find((frame) => frame.type === 'tcp-error' && frame.id === 'r-bad');
  assert.ok(refused, 'off-network relay target is refused');

  // Valid relay target: opened and bridged.
  ws.emit('message', JSON.stringify({ type: 'tcp-open', id: 'r-ok', host: '10.254.0.9', port: 22 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ws.sent.find((frame) => frame.type === 'tcp-opened' && frame.id === 'r-ok'), 'relay opens');
  ws.emit('message', JSON.stringify({ type: 'tcp-close', id: 'r-ok' }));

  // Shell proxy without the VPS opt-in: refused.
  ws.emit('message', JSON.stringify({ type: 'shell-open', id: 's-no', host: '10.254.0.9', port: 22, username: 'admin' }));
  const shellRefused = ws.sent.find((frame) => frame.type === 'shell-error' && frame.id === 's-no');
  assert.ok(shellRefused, 'shell proxy is refused when WIFI_FITI_TERMINAL_PROXY is off');
  stop();

  // --- Shell proxy opted in: waits for auth ---
  const capture2 = {};
  const stop2 = agent.startTerminalControl(
    { coreUrl: 'https://cloud.wififiti.co.ke', gatewayId: 'primary', secret: 's'.repeat(32), allowProxy: true },
    { wsImpl: mockWebSocketClass(capture2), netImpl: mockNet(), connectDelayMs: 50 }
  );
  await new Promise((resolve) => setImmediate(resolve));
  const ws2 = capture2.instance;
  const hello2 = ws2.sent.find((frame) => frame.type === 'hello');
  assert.deepEqual(hello2.capabilities, ['tcp-relay', 'shell-proxy']);
  ws2.emit('message', JSON.stringify({ type: 'shell-open', id: 's-ok', host: '10.254.0.9', port: 22, username: 'admin' }));
  const authRequired = ws2.sent.find((frame) => frame.type === 'shell-auth-required' && frame.id === 's-ok');
  assert.ok(authRequired, 'shell waits for the router password before dialling');
  // Empty password: rejected without dialling.
  ws2.emit('message', JSON.stringify({ type: 'shell-auth', id: 's-ok', password: '' }));
  const authFailed = ws2.sent.find((frame) => frame.type === 'shell-error' && frame.id === 's-ok');
  assert.ok(authFailed, 'empty password is rejected');
  stop2();

  console.log('terminal-agent: all assertions passed');
}

main().catch((error) => { console.error(error); process.exit(1); });

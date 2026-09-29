'use strict';

/*
 * Terminal link layer: the app side of the gateway control channel and the
 * two transports that ride on it.
 *
 * The VPS gateway agent dials OUT to the app and holds a persistent
 * WebSocket at /api/internal/vpn-gateways/:gatewayId/terminal-control
 * (authenticated with the gateway secret). The app multiplexes terminal
 * sessions over that one connection:
 *
 *   direct transport   app --{tcp-open/data}--> agent --TCP--> router:22,
 *                      then the app's own ssh2 client terminates SSH over a
 *                      virtual socket. The agent only sees SSH ciphertext.
 *   gateway transport  app --{shell-open/auth}--> agent runs ssh2 itself and
 *                      relays PTY frames. The router password transits the
 *                      VPS, so this transport requires platform admin
 *                      approval (router-terminal.gatewayTransportApproved)
 *                      and the VPS operator opting in (WIFI_FITI_TERMINAL_PROXY=1).
 *
 * Every frame is JSON: { type, id, ... }. Binary payloads are base64.
 * Relay targets are validated by the agent: 10.254.0.0/16, port 22 only.
 */

const crypto = require('node:crypto');
const { Duplex } = require('node:stream');
const terminal = require('./router-terminal');

const OPEN = 1; // ws.OPEN without requiring 'ws' at module load
const REQUEST_TIMEOUT_MS = 12_000;
const HEARTBEAT_MS = 25_000;

/* ------------------------------------------------------------------ */
/* Control channel registry                                            */
/* ------------------------------------------------------------------ */

// gatewayId -> { ws, capabilities:Set, pending:Map<id, entry>, lastPong }
const channels = new Map();

function getChannel(gatewayId) {
  const channel = channels.get(String(gatewayId || ''));
  if (!channel) return null;
  if (channel.ws.readyState !== OPEN) { channels.delete(String(gatewayId || '')); return null; }
  return channel;
}

function channelOnline(gatewayId) {
  return Boolean(getChannel(gatewayId));
}

function channelCapabilities(gatewayId) {
  const channel = getChannel(gatewayId);
  return channel ? [...channel.capabilities] : [];
}

function newFrameId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function sendFrame(channel, frame) {
  channel.ws.send(JSON.stringify(frame));
}

/**
 * Attach an agent WebSocket (already authenticated by the caller).
 * Returns a detach function.
 */
function attachAgent(gatewayId, ws) {
  const id = String(gatewayId || '');
  const previous = channels.get(id);
  if (previous) { try { previous.ws.close(4000, 'replaced'); } catch (_) {} }

  const channel = { ws, capabilities: new Set(), pending: new Map(), lastPong: Date.now() };
  channels.set(id, channel);

  const heartbeat = setInterval(() => {
    if (ws.readyState !== OPEN) { clearInterval(heartbeat); return; }
    if (Date.now() - channel.lastPong > HEARTBEAT_MS * 2) {
      try { ws.terminate(); } catch (_) {}
      return;
    }
    try { ws.ping(); } catch (_) {}
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  ws.on('pong', () => { channel.lastPong = Date.now(); });
  ws.on('message', (raw) => routeAgentFrame(id, raw));
  ws.on('close', () => {
    clearInterval(heartbeat);
    if (channels.get(id) === channel) channels.delete(id);
    for (const [, entry] of channel.pending) entry.reject(new Error('Gateway control channel closed.'));
    channel.pending.clear();
  });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });

  return () => { try { ws.close(1000, 'detach'); } catch (_) {} };
}

function routeAgentFrame(gatewayId, raw) {
  let frame;
  try { frame = JSON.parse(String(raw)); } catch (_) { return; }
  const channel = channels.get(String(gatewayId || ''));
  if (!channel) return;
  if (frame && frame.type === 'hello' && Array.isArray(frame.capabilities)) {
    for (const cap of frame.capabilities) channel.capabilities.add(String(cap));
    return;
  }
  if (frame && frame.type === 'pong') { channel.lastPong = Date.now(); return; }
  const entry = frame && frame.id ? channel.pending.get(String(frame.id)) : null;
  if (!entry) return;
  try { entry.onFrame(frame); } catch (_) { /* a bad frame must not kill the channel */ }
}

/** Send a request frame and route the matching response frames to onFrame. */
function channelRequest(gatewayId, frame, onFrame, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const channel = getChannel(gatewayId);
  if (!channel) return Promise.reject(Object.assign(new Error('The gateway agent is not connected.'), { status: 503 }));
  return new Promise((resolve, reject) => {
    const id = String(frame.id);
    const timer = setTimeout(() => {
      channel.pending.delete(id);
      reject(Object.assign(new Error('The gateway agent did not respond in time.'), { status: 504 }));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    channel.pending.set(id, {
      onFrame: (response) => {
        try { onFrame(response, { resolve, reject }); }
        catch (error) { clearTimeout(timer); channel.pending.delete(id); reject(error); }
      },
      reject: (error) => { clearTimeout(timer); channel.pending.delete(id); reject(error); },
    });
    try { sendFrame(channel, frame); }
    catch (error) { clearTimeout(timer); channel.pending.delete(id); reject(error); }
  });
}

/* ------------------------------------------------------------------ */
/* TCP relay socket (direct transport)                                 */
/* ------------------------------------------------------------------ */

/**
 * Open a virtual socket to host:port through the gateway agent. Resolves
 * with a Duplex stream once the agent confirms the TCP connection.
 */
function openRelaySocket(gatewayId, host, port) {
  const id = newFrameId('relay');
  let settled = false;
  let socket = null;

  socket = new Duplex({
    read() { /* data is pushed from agent frames */ },
    write(chunk, _encoding, callback) {
      const channel = getChannel(gatewayId);
      if (!channel) { callback(new Error('Gateway control channel lost.')); return; }
      try {
        sendFrame(channel, { type: 'tcp-data', id, chunk: Buffer.from(chunk).toString('base64') });
        callback();
      } catch (error) { callback(error); }
    },
    destroy(error, callback) {
      const channel = getChannel(gatewayId);
      if (channel && settled) {
        try { sendFrame(channel, { type: 'tcp-close', id }); } catch (_) {}
      }
      callback(error);
    },
  });

  const opened = channelRequest(gatewayId, { type: 'tcp-open', id, host, port }, (frame, { resolve, reject }) => {
    if (settled) {
      // Late frames after settle: still route data/close to the socket.
      if (frame.type === 'tcp-data' && frame.chunk) socket.push(Buffer.from(String(frame.chunk), 'base64'));
      if (frame.type === 'tcp-closed' || frame.type === 'tcp-error') socket.destroy(frame.type === 'tcp-error' ? new Error(String(frame.message || 'Relay failed.')) : null);
      return;
    }
    if (frame.type === 'tcp-opened') {
      settled = true;
      socket.__relayId = id;
      trackRelaySocket(gatewayId, id, socket);
      resolve(socket);
      return;
    }
    if (frame.type === 'tcp-data' && frame.chunk) { socket.push(Buffer.from(String(frame.chunk), 'base64')); return; }
    if (frame.type === 'tcp-error') { reject(Object.assign(new Error(String(frame.message || 'Could not reach the router.')), { status: 502 })); return; }
    if (frame.type === 'tcp-closed') { reject(Object.assign(new Error('The relay closed before the connection opened.'), { status: 502 })); }
  }).then(() => socket);

  return opened;
}

/** Route frames for an already-open relay socket (registered after open). */
function trackRelaySocket(gatewayId, id, socket) {
  const channel = getChannel(gatewayId);
  if (!channel) return;
  channel.pending.set(String(id), {
    onFrame: (frame) => {
      if (frame.type === 'tcp-data' && frame.chunk) socket.push(Buffer.from(String(frame.chunk), 'base64'));
      else if (frame.type === 'tcp-closed') socket.destroy();
      else if (frame.type === 'tcp-error') socket.destroy(new Error(String(frame.message || 'Relay failed.')));
    },
    reject: (error) => socket.destroy(error),
  });
  const originalDestroy = socket._destroy.bind(socket);
  socket._destroy = (error, callback) => {
    channel.pending.delete(String(id));
    originalDestroy(error, callback);
  };
}

/* ------------------------------------------------------------------ */
/* Transports                                                          */
/* ------------------------------------------------------------------ */

function lazySsh2() {
  try { return require('ssh2'); }
  catch (error) { throw Object.assign(new Error('SSH support is not installed.'), { status: 503 }); }
}

/**
 * Direct transport: the app terminates SSH over a relay socket.
 * Returns { write, resize, close } once the shell is open.
 */
async function openDirectShell({ gatewayId, host, username, password, cols = 80, rows = 24, ssh2Impl = null }) {
  if (!channelOnline(gatewayId)) throw Object.assign(new Error('The gateway agent is not connected.'), { status: 503 });
  const { Client } = ssh2Impl || lazySsh2();
  const sock = await openRelaySocket(gatewayId, host, 22);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const done = (error, handle) => {
      if (error) { try { conn.end(); } catch (_) {} try { sock.destroy(); } catch (_) {} reject(error); }
      else resolve(handle);
    };
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols, rows }, (error, stream) => {
        if (error) { done(Object.assign(new Error('Could not open a shell on the router.'), { status: 502 })); return; }
        done(null, {
          stream,
          write: (data) => { try { stream.write(data); } catch (_) {} },
          resize: (c, r) => { try { stream.setWindow(r, c, 0, 0); } catch (_) {} },
          close: () => { try { stream.close(); } catch (_) {} try { conn.end(); } catch (_) {} },
        });
      });
    });
    conn.on('error', (error) => {
      const message = /auth|password|permission/i.test(String((error && error.message) || ''))
        ? 'SSH authentication failed. Check the router username and password.'
        : 'Could not reach the router over the secure tunnel.';
      done(Object.assign(new Error(message), { status: 502 }));
    });
    // The password is handed to ssh2 here and dropped from this scope the
    // moment authentication starts; it is never stored on any object.
    let secret = String(password || '');
    try {
      conn.connect({ sock, username: String(username || 'admin'), password: secret, readyTimeout: 15000, keepaliveInterval: 15000 });
    } finally { secret = ''; }
  });
}

/**
 * Gateway transport: the agent terminates SSH on the VPS and relays PTY
 * frames. Only used with platform admin approval.
 */
async function openGatewayShell({ gatewayId, host, username, password, cols = 80, rows = 24 }) {
  if (!channelOnline(gatewayId)) throw Object.assign(new Error('The gateway agent is not connected.'), { status: 503 });
  const id = newFrameId('shell');
  let onData = null;
  let onClose = null;
  const handle = {
    onData: (fn) => { onData = fn; },
    onClose: (fn) => { onClose = fn; },
    write: (data) => {
      const channel = getChannel(gatewayId);
      if (!channel) return;
      try { sendFrame(channel, { type: 'shell-data', id, chunk: Buffer.from(String(data), 'utf8').toString('base64') }); } catch (_) {}
    },
    resize: (c, r) => {
      const channel = getChannel(gatewayId);
      if (!channel) return;
      try { sendFrame(channel, { type: 'shell-resize', id, cols: c, rows: r }); } catch (_) {}
    },
    close: () => {
      const channel = getChannel(gatewayId);
      if (channel) { try { sendFrame(channel, { type: 'shell-close', id }); } catch (_) {} }
      if (channel) channel.pending.delete(id);
      if (onClose) { const fn = onClose; onClose = null; fn('closed by user'); }
    },
  };
  // The password crosses the control channel to the VPS only in this
  // transport, which is why it needs platform admin approval.
  let secret = String(password || '');
  await channelRequest(gatewayId, { type: 'shell-open', id, host, port: 22, username: String(username || 'admin'), cols, rows }, (frame, { resolve, reject }) => {
    if (frame.type === 'shell-opened') { resolve(); return; }
    if (frame.type === 'shell-auth-required') {
      const channel = getChannel(gatewayId);
      try { sendFrame(channel, { type: 'shell-auth', id, password: secret }); } catch (error) { reject(error); return; }
      secret = '';
      return;
    }
    if (frame.type === 'shell-data' && frame.chunk) { if (onData) onData(Buffer.from(String(frame.chunk), 'base64').toString('utf8')); return; }
    if (frame.type === 'shell-error') { secret = ''; reject(Object.assign(new Error(String(frame.message || 'The gateway could not open the shell.') ), { status: 502 })); return; }
    if (frame.type === 'shell-closed') {
      if (onClose) { const fn = onClose; onClose = null; fn(String(frame.reason || 'shell closed')); }
    }
  }, { timeoutMs: 30_000 }).finally(() => { secret = ''; });
  return handle;
}

/* ------------------------------------------------------------------ */
/* Session: transport + safeguards + audit                             */
/* ------------------------------------------------------------------ */

function createTerminalSession({ businessId, locationId, transport, gatewayId, managementAddress }) {
  const auditId = terminal.auditSessionOpen({ businessId, locationId, transport });
  const session = {
    businessId,
    locationId,
    transport,
    auditId,
    openedAt: Date.now(),
    lastActivityAt: Date.now(),
    shell: null,
    inputBuffer: '',
    closed: false,
    onOutput: null,   // (chunk:string) => void, set by the socket layer
    onBlocked: null,  // (line, label) => void
    onClosed: null,   // (reason) => void

    touch() { this.lastActivityAt = Date.now(); },

    async start({ username, password, cols, rows }) {
      if (this.closed) throw new Error('Session is closed.');
      const common = { gatewayId, host: managementAddress, username, password, cols, rows };
      if (transport === terminal.TRANSPORTS.direct) {
        const { Client } = lazySsh2();
        this.shell = await openDirectShell({ ...common, ssh2Impl: { Client } });
        this.attachDirectStream(this.shell.stream);
      } else if (transport === terminal.TRANSPORTS.gateway) {
        if (!terminal.gatewayTransportApproved()) {
          throw Object.assign(new Error('The gateway proxy transport needs platform admin approval.'), { status: 403 });
        }
        this.shell = await openGatewayShell(common);
      } else {
        throw Object.assign(new Error('Unknown terminal transport.'), { status: 400 });
      }
      this.touch();
      terminal.registerSession(this);
      if (transport === terminal.TRANSPORTS.gateway && this.shell.onData) {
        this.shell.onData((chunk) => this.handleOutput(chunk));
        this.shell.onClose((reason) => this.close(reason || 'shell closed'));
      }
      // Direct transport: ssh2 stream events are wired by attachDirectStream.
      return this;
    },

    /** Wire an ssh2 shell stream (direct transport) to this session. */
    attachDirectStream(stream) {
      stream.on('data', (chunk) => this.handleOutput(chunk.toString('utf8')));
      stream.on('close', () => this.close('shell closed'));
      stream.on('error', () => this.close('shell error'));
    },

    handleOutput(chunk) {
      if (this.closed) return;
      this.touch();
      if (this.onOutput) { try { this.onOutput(chunk); } catch (_) {} }
    },

    /**
     * Every completed input line is checked against the blocklist before
     * it is considered sent. Forwarding itself is immediate (the router
     * echoes keystrokes); on a blocked line we send Ctrl-C at once, warn
     * the user and audit the attempt.
     */
    handleUserData(chunk) {
      if (this.closed || !this.shell) return;
      this.touch();
      const text = String(chunk);
      this.shell.write(text);
      this.inputBuffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let newlineIndex;
      while ((newlineIndex = this.inputBuffer.indexOf('\n')) !== -1) {
        const line = this.inputBuffer.slice(0, newlineIndex);
        this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
        const label = terminal.blockedCommandLabel(line);
        if (label) {
          try { this.shell.write('\x03'); } catch (_) {}
          terminal.auditLine(this.auditId, 'blocked', line);
          if (this.onBlocked) { try { this.onBlocked(line.trim(), label); } catch (_) {} }
        } else if (line.trim()) {
          terminal.auditLine(this.auditId, 'input', line);
        }
      }
      if (this.inputBuffer.length > 4096) this.inputBuffer = this.inputBuffer.slice(-4096);
    },

    resize(cols, rows) {
      if (this.closed || !this.shell) return;
      const c = Math.min(Math.max(Number(cols) || 80, 20), 400);
      const r = Math.min(Math.max(Number(rows) || 24, 5), 200);
      try { this.shell.resize(c, r); } catch (_) {}
    },

    close(reason = 'closed') {
      if (this.closed) return;
      this.closed = true;
      try { if (this.shell) this.shell.close(); } catch (_) {}
      terminal.unregisterSession(this.locationId);
      terminal.auditSessionClose(this.auditId, String(reason).slice(0, 120));
      if (this.onClosed) { try { this.onClosed(String(reason)); } catch (_) {} }
    },
  };
  return session;
}

module.exports = {
  attachAgent,
  channelOnline,
  channelCapabilities,
  openRelaySocket,
  openDirectShell,
  openGatewayShell,
  createTerminalSession,
  // test hooks
  _channels: channels,
  _routeAgentFrame: routeAgentFrame,
};

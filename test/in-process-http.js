/**
 * Optional network-free transport for the HTTP integration tests:
 *   node --require ./test/in-process-http.js test/tenant-integration.js
 *
 * Keeps real Express routing, middleware, body parsing, status codes and
 * headers. Only the TCP transport is replaced; this is not a socket test.
 * Useful in restricted environments that cannot listen on localhost.
 */
const http = require('node:http');
const { Duplex } = require('node:stream');
const servers = new Map();
let nextPort = 48000;
const originalFetch = global.fetch;
http.Server.prototype.listen = function (...args) {
  const port = Number(args[0]) || nextPort++;
  servers.set(port, this);
  this.address = () => ({ address: '127.0.0.1', family: 'IPv4', port });
  Object.defineProperty(this, 'listening', { configurable: true, get: () => servers.has(port) });
  this.closeAllConnections = () => {};
  this.close = callback => { servers.delete(port); if (callback) setImmediate(callback); return this; };
  const callback = args.find(argument => typeof argument === 'function');
  if (callback) this.once('listening', callback);
  setImmediate(() => this.emit('listening'));
  return this;
};
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const server = servers.get(Number(url.port));
  if (!server || !['127.0.0.1', 'localhost'].includes(url.hostname)) return originalFetch(input, options);
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(chunk, encoding, done) { done(); } });
    socket.remoteAddress = '127.0.0.1';
    const request = new http.IncomingMessage(socket);
    request.method = options.method || 'GET';
    request.url = url.pathname + url.search;
    request.headers = Object.fromEntries(new Headers(options.headers || {}));
    // Tests can deliberately exercise virtual-host routing. A real HTTP
    // client supplies Host separately from the transport address, so preserve
    // an explicit header and otherwise use the URL host as before.
    if (!request.headers.host) request.headers.host = url.host;
    if (options.body !== undefined) request.headers['content-length'] = String(Buffer.byteLength(options.body));
    const response = new http.ServerResponse(request);
    const chunks = [];
    response.write = (chunk, encoding) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)); return true; };
    response.end = (chunk, encoding) => {
      if (chunk) response.write(chunk, encoding);
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.getHeaders())) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      resolve(new Response([204,304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
      response.emit('finish');
      return response;
    };
    request.on('error', reject); response.on('error', reject);
    server.emit('request', request, response);
    if (options.body !== undefined) request.push(Buffer.from(options.body));
    request.push(null);
  });
};

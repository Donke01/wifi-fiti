'use strict';

/*
 * Router polling capacity benchmark.
 *
 * Run with:
 *   node test/load-router-poll.js
 *
 * This starts the real Express application against a temporary SQLite file,
 * creates simulated paired routers, and measures ordinary /api/router/sync
 * requests. It does not contact Safaricom or change a physical router.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const databasePath = path.join('/tmp', `wifi-fiti-load-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(databasePath + suffix); } catch (_) { /* fresh run */ }
}

Object.assign(process.env, {
  PORT: '0',
  PUBLIC_URL: 'https://cloud.wififiti.co.ke',
  APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke',
  LEGACY_HOST: 'wififiti.co.ke',
  MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'load-test-key',
  MPESA_CONSUMER_SECRET: 'load-test-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'load-test-passkey',
  PROVISION_MODE: 'poll',
  SITE_TOKEN: 'load-test-site-token',
  TENANT_SECRETS_KEY: 'load-test-encryption-key',
  DATABASE_PATH: databasePath,
});

let server;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function captureServer(...args) {
  server = this;
  return originalListen.apply(this, args);
};
require('../src/server');
http.Server.prototype.listen = originalListen;

const tenant = require('../src/lib/tenant');

async function api(endpoint, { method = 'GET', body, token, routerToken } = {}) {
  const headers = { Host: 'cloud.wififiti.co.ke' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routerToken) headers['X-WiFi-Fiti-Router'] = routerToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

async function createRouters(count, runId) {
  const registered = await api('/api/business/register', {
    method: 'POST',
    body: {
      name: 'Load Test Business', ownerName: 'Load Test', phone: '0712000000',
      email: `load-${process.pid}-${runId}@example.test`, password: 'load-test-password',
      plan: 'starter', collectionMode: 'fiti',
    },
  });
  assert.equal(registered.status, 201, registered.text);
  const business = JSON.parse(registered.text).business;
  const routers = [];
  for (let index = 0; index < count; index += 1) {
    const location = tenant.createLocation({
      id: `loc-load-${process.pid}-${runId}-${index}`,
      businessId: business.id,
      name: `Load router ${index}`,
      routerName: 'simulated-router',
      setup: { mode: 'existing', customerBridge: 'bridge-hs', hotspotServer: 'hotspot1' },
    });
    // This represents a router that has already completed its one-time
    // setup receipt. The benchmark measures ordinary billing polls.
    tenant.recordSuccessfulRouterSync(location.id);
    routers.push(location);
  }
  return routers;
}

async function runRound(routers) {
  const started = performance.now();
  const results = await Promise.all(routers.map(async (router) => {
    const requestStarted = performance.now();
    const response = await api(`/api/router/sync?site=${encodeURIComponent(router.id)}&protocol=2&health=ready`, {
      method: 'POST', routerToken: router.routerToken, body: '',
    });
    return { status: response.status, latency: performance.now() - requestStarted };
  }));
  const elapsed = performance.now() - started;
  const latencies = results.map((result) => result.latency);
  const failures = results.filter((result) => result.status !== 200).length;
  return {
    routers: routers.length,
    elapsed,
    throughput: routers.length / (elapsed / 1000),
    failures,
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  };
}

async function main() {
  console.log('Wi-Fi Fiti router poll capacity benchmark');
  console.log('Temporary database:', databasePath);
  for (const count of [50, 100, 250, 500]) {
    const routers = await createRouters(count, count);
    // Warm-up the SQLite connection and Express route before recording data.
    await runRound(routers.slice(0, Math.min(10, routers.length)));
    const result = await runRound(routers);
    console.log(JSON.stringify({
      routers: result.routers,
      requestsPerSecond: Number(result.throughput.toFixed(1)),
      p50Ms: Number(result.p50.toFixed(1)),
      p95Ms: Number(result.p95.toFixed(1)),
      p99Ms: Number(result.p99.toFixed(1)),
      failures: result.failures,
    }));
  }
  await new Promise((resolve) => server.close(resolve));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

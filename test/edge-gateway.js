'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const host = 'lakeview-main.wififiti.co.ke';
const mapping = { hostname: host, locationId: 'loc-edge-test', businessId: 'biz-edge-test' };
const env = { CORE_ORIGIN: 'https://cloud.wififiti.co.ke', EDGE_GATEWAY_SECRET: 'edge-test-secret' };

function upstream(calls, options = {}) {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const call = { request, url };
    calls.push(call);
    if (url.pathname === '/api/edge/portal/resolve') {
      if (options.missing) return new Response('Not found.', { status: 404 });
      return Response.json(mapping);
    }
    if (url.pathname === `/p/${mapping.locationId}`) {
      return new Response('<!doctype html><html><head><title>Customer Wi-Fi</title></head><body>Portal</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (url.pathname === `/api/tenant/${mapping.locationId}/session`) {
      if (options.redirectSession) return new Response('', {
        status: 302,
        headers: { location: 'https://cloud.wififiti.co.ke/business.html', 'set-cookie': 'cloud-session=private' },
      });
      return new Response(JSON.stringify({ found: false }), {
        headers: { 'content-type': 'application/json', 'set-cookie': 'cloud-session=private', server: 'railway-core' },
      });
    }
    if (url.pathname === `/api/tenant/${mapping.locationId}/pay`) {
      call.body = await request.text();
      return Response.json({ accepted: true });
    }
    if (url.pathname === `/media/logo/${mapping.businessId}`) return new Response('logo', { headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected upstream request: ${url}`);
  };
}

(async () => {
  const worker = await import(pathToFileURL(path.join(__dirname, '../edge/portal-gateway/src/index.js')).href);

  {
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const result = await worker.handleRequest(new Request(`https://${host}/?mac=AA:BB:CC:DD:EE:FF`, {
      headers: { Authorization: 'Bearer should-not-forward', Cookie: 'secret=should-not-forward' },
    }), env, { fetch: upstream(calls) });
    const html = await result.text();
    assert.equal(result.status, 200);
    assert.match(html, /globalThis\.__WIFI_FITI_LOCATION_ID__="loc-edge-test"/);
    assert.equal(calls.length, 2, 'gateway should resolve then fetch only the mapped portal shell');
    assert.equal(calls[1].url.origin, env.CORE_ORIGIN);
    assert.equal(calls[1].url.pathname, `/p/${mapping.locationId}`);
    assert.equal(calls[1].request.headers.get('x-wifi-fiti-edge'), env.EDGE_GATEWAY_SECRET);
    assert.equal(calls[1].request.headers.get('x-wifi-fiti-portal-host'), host);
    assert.equal(calls[1].request.headers.get('authorization'), null);
    assert.equal(calls[1].request.headers.get('cookie'), null);
    assert.equal(result.headers.get('cache-control'), 'no-store');

    const cachedCalls = [];
    const cached = await worker.handleRequest(new Request(`https://${host}/api/tenant/${mapping.locationId}/session`), env, { fetch: upstream(cachedCalls) });
    assert.equal(cached.status, 200);
    assert.equal(cachedCalls.length, 1, 'a short verified mapping cache avoids a resolver call for payment polling');
    assert.equal(cachedCalls[0].url.pathname, `/api/tenant/${mapping.locationId}/session`);
  }

  {
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const result = await worker.handleRequest(new Request(`https://${host}/api/tenant/${mapping.locationId}/session`, {
      headers: { 'X-WiFi-Fiti-Session': 'customer-session', 'X-WiFi-Fiti-Portal': 'payment-capability', Cookie: 'nope' },
    }), env, { fetch: upstream(calls) });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].request.headers.get('x-wifi-fiti-session'), 'customer-session');
    assert.equal(calls[1].request.headers.get('x-wifi-fiti-portal'), 'payment-capability');
    assert.equal(calls[1].request.headers.get('cookie'), null);
    assert.equal(result.headers.get('set-cookie'), null, 'core cookies must never be set on a tenant hostname');
    assert.equal(result.headers.get('server'), null, 'core infrastructure headers are not reflected through the gateway');
  }

  {
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const body = JSON.stringify({ packageId: 7, phone: '254712000001' });
    const result = await worker.handleRequest(new Request(`https://${host}/api/tenant/${mapping.locationId}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wifi-fiti-session': 'customer-session', cookie: 'never-forward' },
      body,
    }), env, { fetch: upstream(calls) });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body, body, 'a payment POST body reaches the mapped core endpoint intact');
    assert.equal(calls[1].request.headers.get('x-wifi-fiti-session'), 'customer-session');
    assert.equal(calls[1].request.headers.get('cookie'), null);
  }

  {
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const result = await worker.handleRequest(new Request(`https://${host}/api/tenant/loc-another-business/session`), env, { fetch: upstream(calls) });
    assert.equal(result.status, 404, 'a tenant hostname must never proxy another location');
    assert.equal(calls.length, 1, 'only resolution is allowed before rejecting a foreign location');
  }

  {
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const result = await worker.handleRequest(new Request(`https://${host}/api/router/sync?site=${mapping.locationId}`), env, { fetch: upstream(calls) });
    assert.equal(result.status, 404, 'router polling must remain at cloud and never reach the Worker');
    assert.equal(calls.length, 1);
  }

  {
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const result = await worker.handleRequest(new Request(`https://unknown.wififiti.co.ke/`), env, { fetch: upstream(calls, { missing: true }) });
    assert.equal(result.status, 404, 'unregistered wildcard hosts should not reveal a portal');
    assert.equal(calls.length, 1);
  }

  {
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const result = await worker.handleRequest(new Request(`https://${host}/api/tenant/${mapping.locationId}/session`), env,
      { fetch: upstream(calls, { redirectSession: true }) });
    assert.equal(result.status, 502, 'a core redirect is never reflected at the tenant hostname');
    assert.equal(result.headers.get('location'), null);
    assert.equal(result.headers.get('set-cookie'), null);
  }

  {
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const result = await worker.handleRequest(new Request('https://cloud.wififiti.co.ke/api/health'), env, { fetch: upstream(calls) });
    assert.equal(result.status, 404, 'an accidental cloud Worker route fails closed instead of recursively fetching itself');
    assert.equal(calls.length, 0);
  }

  {
    // Cloudflare invokes the default module export with a third execution
    // context argument. That context is not a fetch runtime; the gateway must
    // ignore it and use the Worker global fetch implementation instead.
    worker.clearPortalMappingCacheForTests();
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = upstream(calls);
    try {
      const executionContext = Object.freeze({
        waitUntil() {
          throw new Error('the gateway must not treat the execution context as a runtime');
        },
      });
      const result = await worker.default.fetch(new Request(`https://${host}/`), env, executionContext);
      assert.equal(result.status, 200, 'the default Worker export must ignore Cloudflare\'s execution context argument');
      assert.equal(calls.length, 2, 'the default Worker export must use global fetch for resolution and portal delivery');
      assert.equal(calls[0].url.pathname, '/api/edge/portal/resolve');
      assert.equal(calls[1].url.pathname, `/p/${mapping.locationId}`);
    } finally {
      global.fetch = originalFetch;
    }
  }

  console.log('Cloudflare tenant portal gateway: request isolation passed.');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

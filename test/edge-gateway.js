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
      return Response.json(options.payCode ? { ...mapping, pppoePayCode: options.payCode } : mapping);
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
    if (url.pathname === '/home/abcd1234') return new Response('<!doctype html><title>Home internet</title>', { headers: { 'content-type': 'text/html' } });
    if (/^\/pay\/abcd1234(?:\/|$)/.test(url.pathname)) return new Response('<!doctype html><title>Pay</title>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname.startsWith('/api/pppoe-pay/abcd1234')) {
      call.body = request.method === 'POST' ? await request.text() : null;
      return Response.json({ ok: true });
    }
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
    // The same address serves the business's PPPoE pay page, and only its own.
    const pay = { payCode: 'abcd1234' };
    const call = async (url, init) => { worker.clearPortalMappingCacheForTests(); const calls = []; const result = await worker.handleRequest(new Request(url, init), env, { fetch: upstream(calls, pay) }); return { result, calls }; };
    let { result, calls } = await call(`https://${host}/pay`);
    assert.equal(result.status, 302); assert.equal(result.headers.get('location'), '/pay/abcd1234', '/pay goes to the business\'s own pay page');
    assert.equal(calls.length, 1, 'only resolution before the redirect');
    ({ result, calls } = await call(`https://${host}/pay/abcd1234`));
    assert.equal(result.status, 200); assert.equal(calls[1].url.pathname, '/pay/abcd1234');
    ({ result, calls } = await call(`https://${host}/pay/abcd1234/jane.w?k=private-link`));
    assert.equal(result.status, 200); assert.equal(calls[1].url.pathname, '/pay/abcd1234/jane.w');
    assert.equal(calls[1].url.search, '?k=private-link', 'a subscriber\'s private link keeps its key');
    const body = JSON.stringify({ phone: '0712000001', months: 1 });
    ({ result, calls } = await call(`https://${host}/api/pppoe-pay/abcd1234/account/jane.w/pay`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'nope' }, body }));
    assert.equal(result.status, 200); assert.equal(calls[1].body, body, 'a payment reaches the core intact');
    assert.equal(calls[1].request.headers.get('cookie'), null);
    ({ result, calls } = await call(`https://${host}/pay/zzzz9999`));
    assert.equal(result.status, 404, 'another business\'s pay code is not served here'); assert.equal(calls.length, 1);
    ({ result, calls } = await call(`https://${host}/api/pppoe-pay/zzzz9999/account/jane.w`));
    assert.equal(result.status, 404); assert.equal(calls.length, 1);
    ({ result } = await call(`https://${host}/pay/abcd1234/a/b`));
    assert.equal(result.status, 404, 'only /pay/<code>/<account>');
    ({ result } = await call(`https://${host}/api/pppoe-pay/abcd1234/account/jane.w`, { method: 'DELETE' }));
    assert.equal(result.status, 405);
    // The "Home internet" page: /home, its own code only, GET/HEAD only.
    ({ result, calls } = await call(`https://${host}/home`));
    assert.equal(result.status, 302); assert.equal(result.headers.get('location'), '/home/abcd1234');
    ({ result, calls } = await call(`https://${host}/home/abcd1234`));
    assert.equal(result.status, 200); assert.equal(calls[1].url.pathname, '/home/abcd1234');
    assert.match(await result.text(), /Home internet/);
    ({ result, calls } = await call(`https://${host}/home/zzzz9999`));
    assert.equal(result.status, 404); assert.equal(calls.length, 1);
    ({ result } = await call(`https://${host}/home/abcd1234`, { method: 'POST', body: '{}' }));
    assert.equal(result.status, 405);
    const request = JSON.stringify({ fullName: 'Amina', phone: '0712000002', area: 'Milimani' });
    ({ result, calls } = await call(`https://${host}/api/pppoe-pay/abcd1234/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request }));
    assert.equal(result.status, 200); assert.equal(calls[1].body, request, 'a connection request reaches the core intact');
    worker.clearPortalMappingCacheForTests();
    const plain = await worker.handleRequest(new Request(`https://${host}/pay`), env, { fetch: upstream([]) });
    assert.equal(plain.status, 404, 'a business without PPPoE billing has no pay page here');
    worker.clearPortalMappingCacheForTests();
    assert.equal((await worker.handleRequest(new Request(`https://${host}/home`), env, { fetch: upstream([]) })).status, 404);
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

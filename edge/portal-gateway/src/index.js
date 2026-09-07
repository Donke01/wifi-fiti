/*
 * WiFi Fiti tenant portal edge gateway.
 *
 * This Worker has no database and never handles router polling, M-Pesa
 * callbacks, dashboard traffic or credentials. Railway remains the source of
 * truth. The Worker resolves one allowed tenant hostname, then proxies only
 * that location's customer-facing portal surface to the canonical cloud app.
 */

const RESOLVE_TIMEOUT_MS = 2_500;
const PROXY_TIMEOUT_MS = 7_000;
const PORTAL_CACHE_TTL_MS = 30_000;
const MAX_PORTAL_CACHE_ENTRIES = 512;
// This is deliberately a small, per-isolate cache of *validated hostname
// mappings only*. It never contains payment/session data. A returning phone
// polls several times while paying, so even a short cache prevents needless
// resolver round-trips without making hostname changes slow to take effect.
const portalMappingCache = new Map();

function response(status, text) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    },
  });
}

function hostname(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || raw.length > 253) return null;
  try {
    const parsed = new URL(`https://${raw}`);
    if (parsed.hostname !== raw || parsed.port || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function coreOrigin(env) {
  try {
    const origin = new URL(env.CORE_ORIGIN || '');
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) return null;
    return origin;
  } catch (_) {
    return null;
  }
}

function bootstrap(locationId) {
  // Location IDs are server-generated, but JSON escaping keeps this safe even
  // if the identifier format changes later.
  const value = JSON.stringify(String(locationId)).replace(/</g, '\\u003c');
  return `<script>globalThis.__WIFI_FITI_LOCATION_ID__=${value};</script>`;
}

function proxiedHeaders(request, env, host) {
  const headers = new Headers();
  // Do not copy arbitrary browser headers upstream. In particular, do not let
  // a visitor inject a forged edge credential, router credential, dashboard
  // cookie, Host, Authorization or X-Forwarded-* identity.
  for (const name of ['accept', 'accept-language', 'content-type', 'user-agent',
    'x-wifi-fiti-session', 'x-wifi-fiti-portal']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('X-WiFi-Fiti-Edge', env.EDGE_GATEWAY_SECRET || '');
  headers.set('X-WiFi-Fiti-Portal-Host', host);
  return headers;
}

function upstreamRequest(request, origin, env, host, pathname) {
  const target = new URL(pathname, origin);
  target.search = new URL(request.url).search;
  const init = {
    method: request.method,
    headers: proxiedHeaders(request, env, host),
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // Required by Node's Fetch implementation for a streamed request body;
    // ignored by the Workers runtime, where the same stream is supported.
    init.duplex = 'half';
  }
  return new Request(target, init);
}

function copiedResponse(upstream, body, { transformed = false } = {}) {
  // Do not reflect an upstream redirect, cookie, CORS policy, server header or
  // another host-bound header onto the tenant hostname. The portal needs only
  // representation metadata; its protective headers are set consistently here.
  const headers = new Headers();
  const allowed = ['content-type', 'content-language', 'content-disposition', 'etag', 'last-modified', 'accept-ranges'];
  if (!transformed) allowed.push('content-encoding');
  for (const name of allowed) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

async function fetchWithTimeout(runtime, input, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await runtime.fetch(input, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cachedPortal(origin, host) {
  const key = `${origin.origin}\u0000${host}`;
  const cached = portalMappingCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    portalMappingCache.delete(key);
    return null;
  }
  return cached.portal;
}

function cachePortal(origin, host, portal) {
  const key = `${origin.origin}\u0000${host}`;
  const now = Date.now();
  for (const [entryKey, entry] of portalMappingCache) {
    if (entry.expiresAt <= now) portalMappingCache.delete(entryKey);
  }
  if (!portalMappingCache.has(key) && portalMappingCache.size >= MAX_PORTAL_CACHE_ENTRIES) {
    portalMappingCache.delete(portalMappingCache.keys().next().value);
  }
  portalMappingCache.set(key, { portal, expiresAt: now + PORTAL_CACHE_TTL_MS });
}

export function clearPortalMappingCacheForTests() {
  portalMappingCache.clear();
}

async function resolvePortal(origin, env, host, runtime) {
  const cached = cachedPortal(origin, host);
  if (cached) return { portal: cached };
  const target = new URL('/api/edge/portal/resolve', origin);
  target.searchParams.set('host', host);
  let upstream;
  try {
    upstream = await fetchWithTimeout(runtime, target, {
      headers: { 'X-WiFi-Fiti-Edge': env.EDGE_GATEWAY_SECRET || '' },
      redirect: 'manual',
    }, RESOLVE_TIMEOUT_MS);
  } catch (_) {
    return { unavailable: true };
  }
  if (upstream.status === 404) return { missing: true };
  if (!upstream.ok) return { unavailable: true };
  try {
    const portal = await upstream.json();
    if (!portal || !portal.locationId || !portal.businessId || hostname(portal.hostname) !== host) return { unavailable: true };
    cachePortal(origin, host, portal);
    return { portal };
  } catch (_) {
    return { unavailable: true };
  }
}

function tenantApiPath(pathname, locationId) {
  const prefix = `/api/tenant/${encodeURIComponent(locationId)}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

// Use the Worker global object by default so its native fetch implementation
// keeps the receiver Cloudflare expects. Tests can still inject a small fetch
// runtime explicitly.
export async function handleRequest(request, env, runtime = globalThis) {
  const url = new URL(request.url);
  const host = hostname(url.hostname);
  const origin = coreOrigin(env);
  if (!host || !origin || !env.EDGE_GATEWAY_SECRET) return response(503, 'Customer portal unavailable.');
  // This route must never be attached to the core hostname. Failing closed
  // avoids a recursive Worker → cloud → Worker loop if its no-Worker route is
  // mistakenly omitted during deployment.
  if (host === origin.hostname) return response(404, 'Customer portal not found.');

  const resolution = await resolvePortal(origin, env, host, runtime);
  if (resolution.missing) return response(404, 'Customer portal not found.');
  if (!resolution.portal) return response(503, 'Customer portal unavailable.');
  const portal = resolution.portal;
  const { pathname } = url;

  if (pathname === '/' || pathname === '/index.html' || pathname === `/p/${encodeURIComponent(portal.locationId)}`) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return response(405, 'Method not allowed.');
    let upstream;
    try {
      upstream = await fetchWithTimeout(runtime,
        upstreamRequest(request, origin, env, host, `/p/${encodeURIComponent(portal.locationId)}`), null, PROXY_TIMEOUT_MS);
    } catch (_) {
      return response(503, 'Customer portal unavailable.');
    }
    if (!upstream.ok) return response(503, 'Customer portal unavailable.');
    if (request.method === 'HEAD') return copiedResponse(upstream, null);
    const html = await upstream.text();
    if (!/<\/head\s*>/i.test(html)) return response(503, 'Customer portal unavailable.');
    return copiedResponse(upstream, html.replace(/<\/head\s*>/i, `${bootstrap(portal.locationId)}</head>`), { transformed: true });
  }

  if (tenantApiPath(pathname, portal.locationId)) {
    if (!['GET', 'POST'].includes(request.method)) return response(405, 'Method not allowed.');
    try {
      const upstream = await fetchWithTimeout(runtime, upstreamRequest(request, origin, env, host, pathname), null, PROXY_TIMEOUT_MS);
      if (upstream.status >= 300 && upstream.status < 400) return response(502, 'Customer portal unavailable.');
      return copiedResponse(upstream, upstream.body);
    } catch (_) {
      return response(503, 'Customer portal unavailable.');
    }
  }

  const logoPath = `/media/logo/${encodeURIComponent(portal.businessId)}`;
  if (pathname === logoPath && (request.method === 'GET' || request.method === 'HEAD')) {
    try {
      const upstream = await fetchWithTimeout(runtime, upstreamRequest(request, origin, env, host, pathname), null, PROXY_TIMEOUT_MS);
      if (upstream.status >= 300 && upstream.status < 400) return response(502, 'Customer portal unavailable.');
      return copiedResponse(upstream, upstream.body);
    } catch (_) {
      return response(503, 'Customer portal unavailable.');
    }
  }

  return response(404, 'Customer portal not found.');
}

// Cloudflare invokes module workers as fetch(request, env, executionContext).
// Keep the injectable runtime reserved for direct tests and call the handler
// with only the Worker request and bindings in production.
export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

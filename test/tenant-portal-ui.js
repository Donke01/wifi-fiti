'use strict';

// Runs the real embedded portal script with a minimal DOM and a controlled clock.
// No sockets, live payments, or router are used. This checks page behavior, not
// browser rendering or the operating system's captive-portal window behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/tenant-portal.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 1, 'exercise the actual portal application script');
const originTime = Date.parse('2026-09-05T12:00:00Z');
const site = 'loc-test';
const mac = 'AA:BB:CC:DD:EE:01';
const storagePrefix = 'fiti_' + site + '_' + mac;
const apiPrefix = '/api/tenant/' + site;
const pendingCheckout = {
  checkoutRequestId: 'checkout-saved-1', portalToken: 'opaque-checkout-capability', startedAt: originTime,
};
const activeSession = {
  found: true, authenticated: true, subscriptionId: 'subscription-1', payerPhone: '254712345678',
  username: 'router-user-1', password: 'RECOVERY1', remainingSeconds: 3600,
  expiresAt: new Date(originTime + 3600000).toISOString(), device: null,
};

class Element {
  constructor(tagName, attributes = '') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.style = {};
    this.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
    this.textContent = '';
    this.disabled = false;
    this.className = attributes.match(/\bclass="([^"]*)"/)?.[1] || '';
    const element = this;
    this.classList = {
      contains(name) { return element.className.split(/\s+/).includes(name); },
      toggle(name, force) {
        const classes = new Set(element.className.split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        element.className = [...classes].join(' ');
        return enabled;
      },
      add(name) { this.toggle(name, true); },
      remove(name) { this.toggle(name, false); },
    };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  querySelectorAll(selector) {
    assert.ok(selector.startsWith('.'), 'minimal DOM only needs class selectors');
    const matches = [];
    for (const child of this.children) {
      if (child.classList.contains(selector.slice(1))) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
}

function storage(data, blocked = false) {
  return {
    getItem(key) { if (blocked) throw new Error('Browser storage is blocked'); return data.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('Browser storage is blocked'); data.set(key, value); },
    removeItem(key) { if (blocked) throw new Error('Browser storage is blocked'); data.delete(key); },
  };
}

function createPage(options = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    elements.set(match[3], new Element(match[1], match[2]));
  }
  const localData = options.localData || new Map();
  const sessionData = options.sessionData || new Map();
  const requests = [];
  const navigations = [];
  const cssVariables = new Map();
  let now = options.now || originTime;
  let nextTimer = 0;
  const timers = new Map();
  class ClockDate extends Date {
    constructor(...values) { super(...(values.length ? values : [now])); }
    static now() { return now; }
  }
  function schedule(callback, delay, repeat = false) {
    const id = ++nextTimer;
    timers.set(id, { id, callback, delay: Math.max(1, Number(delay) || 1), due: now + Math.max(1, Number(delay) || 1), repeat });
    return id;
  }
  const location = {
    pathname: '/p/' + site,
    search: '?' + new URLSearchParams({ mac, ip: '10.5.50.123' }),
    assign(value) { navigations.push(['assign', value]); },
    replace(value) { navigations.push(['replace', value]); },
    reload() { navigations.push(['reload']); },
  };
  Object.defineProperty(location, 'href', { set(value) { navigations.push(['href', value]); } });
  const context = {
    console, Date: ClockDate, URLSearchParams, location,
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: storage(localData, options.blockLocalStorage),
    sessionStorage: storage(sessionData),
    document: {
      title: '',
      documentElement: { style: { setProperty(name, value) { cssVariables.set(name, value); } } },
      getElementById(id) { assert.ok(elements.has(id), 'script references an existing element: ' + id); return elements.get(id); },
      createElement(tagName) { return new Element(tagName); },
    },
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: id => timers.delete(id),
    fetch: async (url, settings = {}) => {
      const request = {
        path: String(url).replace(apiPrefix, ''), method: settings.method || 'GET',
        headers: settings.headers || {}, body: settings.body ? JSON.parse(settings.body) : undefined,
      };
      requests.push(request);
      let body;
      if (request.path === '/config') {
        body = options.config || { location: { businessName: 'Test WiFi', name: 'Test location' },
          packages: [{ id: 1, name: 'One hour', price: 20, seconds: 3600 }] };
      } else if (options.respond) {
        body = await options.respond(request);
      }
      if (body === undefined && request.path.startsWith('/session?')) body = { found: false };
      if (body === undefined && request.path.startsWith('/status/')) body = { status: 'pending' };
      if (body === undefined && request.path === '/subscriptions/check') body = { found: false, subscriptions: [] };
      if (body === undefined && request.path === '/pay') body = { ...pendingCheckout, checkoutRequestId: 'unexpected-new-checkout' };
      assert.notEqual(body, undefined, 'unexpected portal request: ' + request.method + ' ' + request.path);
      return { ok: true, status: 200, json: async () => body };
    },
  };
  vm.runInNewContext(scripts[0], context, { filename: 'tenant-portal.html', timeout: 1000 });

  async function flush() {
    // Resolve boot/fetch/json/handler promises without changing the page clock.
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  return {
    localData, sessionData, requests, navigations, cssVariables, flush,
    element: id => elements.get(id),
    visible: id => !elements.get(id).classList.contains('hidden'),
    count: pathname => requests.filter(request => request.path === pathname).length,
    async click(id) {
      const element = elements.get(id);
      assert.ok(element && typeof element.onclick === 'function', id + ' has a click handler');
      assert.equal(element.disabled, false, id + ' is enabled');
      await element.onclick();
      await flush();
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      let callbacks = 0;
      while (true) {
        await flush();
        const next = [...timers.values()].filter(timer => timer.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        assert.ok(++callbacks < 10000, 'timer callbacks must remain bounded');
        now = next.due;
        if (next.repeat) next.due += next.delay; else timers.delete(next.id);
        next.callback();
      }
      now = target;
      await flush();
    },
  };
}

function savedCheckout() { return new Map([[storagePrefix + '_checkout', JSON.stringify(pendingCheckout)]]); }
const failures = [];
let passed = 0;
async function test(name, callback) {
  try { await callback(); passed++; console.log('  ok   ' + name); }
  catch (error) { failures.push(name); console.error('  FAIL ' + name + '\n' + error.stack); }
}

(async () => {
  await test('customer branding is applied from the public portal configuration', async () => {
    const page = createPage({ config: {
      location: { businessName: 'Fallback WiFi', name: 'Kisumu Main' },
      branding: {
        name: 'Lakeview Internet', supportPhone: '254712345678', primaryColor: '#19A974',
        message: 'Fast Wi-Fi for Lakeview guests.', logoUrl: '/media/logo/biz-test',
      },
      packages: [{ id: 1, name: 'One hour', price: 20, seconds: 3600 }],
    } });
    await page.flush();
    assert.equal(page.element('brand').textContent, 'Lakeview Internet');
    assert.equal(page.element('location').textContent, 'Kisumu Main');
    assert.equal(page.element('portal-message').textContent, 'Fast Wi-Fi for Lakeview guests.');
    assert.equal(page.element('brand-logo').src, '/media/logo/biz-test');
    assert.equal(page.cssVariables.get('--blue'), '#19A974');
    assert.equal(page.cssVariables.get('--aqua'), '#19A974');
    assert.match(page.element('support').textContent, /254712345678/);
  });

  await test('saved payment resumes across refresh and remains on the waiting page beyond five seconds', async () => {
    const data = savedCheckout();
    const page = createPage({ localData: data });
    await page.flush();
    assert.equal(page.visible('waiting'), true);
    await page.advance(5100);
    assert.equal(page.visible('waiting'), true);
    assert.equal(page.visible('buy'), false);
    assert.ok(page.count('/status/' + pendingCheckout.checkoutRequestId) >= 3);
    assert.equal(page.count('/pay'), 0);
    assert.deepEqual(page.navigations, []);
    const refreshed = createPage({ localData: data, now: originTime + 5100 });
    await refreshed.flush();
    assert.equal(refreshed.visible('waiting'), true);
    assert.equal(refreshed.count('/pay'), 0);
    const status = refreshed.requests.find(request => request.path.startsWith('/status/'));
    assert.equal(status.headers['X-WiFi-Fiti-Portal'], pendingCheckout.portalToken);
  });

  await test('returning to packages and pressing pay resumes a pending checkout without a duplicate charge request', async () => {
    const page = createPage({ localData: savedCheckout() });
    await page.flush();
    await page.click('leave-waiting');
    assert.equal(page.visible('buy'), true);
    assert.equal(page.visible('resume-payment'), true);
    page.element('phone').value = '0712345678';
    await page.click('pay');
    assert.equal(page.count('/pay'), 0, 'existing checkout must be checked before creating another payment');
    assert.equal(page.visible('waiting'), true);
    assert.equal(page.visible('resume-payment'), false);
    assert.equal(JSON.parse(page.localData.get(storagePrefix + '_checkout')).checkoutRequestId, pendingCheckout.checkoutRequestId);
  });

  await test('an authenticated saved session connects automatically and waits for router acknowledgement', async () => {
    let ready = false;
    const sessionToken = 'opaque-browser-session-capability';
    const page = createPage({
      localData: new Map([[storagePrefix + '_session', JSON.stringify(sessionToken)]]),
      respond(request) {
        assert.equal(request.headers['X-WiFi-Fiti-Session'], sessionToken);
        if (request.path.startsWith('/session?')) return { ...activeSession };
        if (request.path === '/session/connect') return { ...activeSession, provisioningJobId: 19, awaitingRouter: true };
        if (request.path === '/router-jobs/19') return { ready };
      },
    });
    await page.flush();
    assert.equal(page.count('/session/connect'), 1, 'no Connect button is needed after refresh');
    const connect = page.requests.find(request => request.path === '/session/connect');
    assert.equal(connect.body.mac, mac);
    assert.equal(connect.body.ip, '10.5.50.123');
    await page.advance(5100);
    assert.equal(page.visible('waiting'), true);
    assert.equal(page.visible('buy'), false);
    assert.equal(page.count('/session/connect'), 1, 'polling must not queue repeated reconnects');
    ready = true;
    await page.advance(2500);
    assert.equal(page.visible('active'), true);
    assert.equal(page.element('recovery-code').textContent, activeSession.password);
    const before = page.element('clock').textContent;
    await page.advance(65000);
    assert.notEqual(page.element('clock').textContent, before, 'time continues without a refresh');
    assert.equal(page.count('/pay'), 0);
    assert.deepEqual(page.navigations, []);
  });

  await test('sessionStorage resumes a payment when access to localStorage is blocked', async () => {
    const page = createPage({ blockLocalStorage: true, sessionData: savedCheckout() });
    await page.flush();
    assert.equal(page.visible('waiting'), true);
    assert.equal(page.count('/status/' + pendingCheckout.checkoutRequestId), 1);
    assert.equal(page.count('/pay'), 0);
  });

  await test('sessionStorage restores authentication when access to localStorage is blocked', async () => {
    const sessionToken = 'session-storage-capability';
    const page = createPage({
      blockLocalStorage: true,
      sessionData: new Map([[storagePrefix + '_session', JSON.stringify(sessionToken)]]),
      respond(request) {
        assert.equal(request.headers['X-WiFi-Fiti-Session'], sessionToken);
        if (request.path.startsWith('/session?')) return { ...activeSession };
        if (request.path === '/session/connect') return { ...activeSession, provisioningJobId: 20 };
        if (request.path === '/router-jobs/20') return { ready: true };
      },
    });
    await page.flush();
    assert.equal(page.count('/session/connect'), 1);
    assert.equal(page.visible('active'), true);
  });

  await test('temporary payment network failures keep waiting and recover without navigation', async () => {
    let statusCalls = 0;
    const page = createPage({
      localData: savedCheckout(),
      respond(request) {
        if (request.path.startsWith('/status/')) {
          statusCalls++;
          if (statusCalls <= 3) throw new Error('Network interrupted');
          return { ...activeSession, status: 'paid', sessionToken: 'new-browser-capability' };
        }
      },
    });
    await page.flush();
    await page.advance(5100);
    assert.equal(page.visible('waiting'), true);
    assert.equal(page.visible('buy'), false);
    await page.advance(2400);
    assert.equal(page.visible('active'), true);
    assert.equal(page.localData.has(storagePrefix + '_checkout'), false);
    assert.equal(JSON.parse(page.localData.get(storagePrefix + '_session')), 'new-browser-capability');
    assert.equal(page.count('/pay'), 0);
    assert.deepEqual(page.navigations, []);
  });

  console.log('\nTenant portal UI: ' + passed + ' passed, ' + failures.length + ' failed.');
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });

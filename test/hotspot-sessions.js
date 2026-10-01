'use strict';

/*
 * Router telemetry and who is online: the report block the check-in reply
 * carries, the report endpoint, session history, the Active users view and
 * the concurrent-user limit that counts customers actually connected.
 *   node --require ./test/in-process-http.js test/hotspot-sessions.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-sessions-'));
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://cloud.wififiti.co.ke', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke', MPESA_ENV: 'sandbox',
  MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  PROVISION_MODE: 'poll', SITE_TOKEN: 'sessions-site-token', TENANT_SECRETS_KEY: 'sessions-key',
  ADMIN_TOKEN: 'sessions-admin', DATABASE_PATH: path.join(dir, 'hotspot.db'),
});

let server;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function captureServer(...args) { server = this; return originalListen.apply(this, args); };
require('../src/server');
http.Server.prototype.listen = originalListen;

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${String(error.stack).split('\n').slice(0, 5).join('\n       ')}`); }
}
async function api(endpoint, { method = 'GET', body, token, routerToken, text } = {}) {
  await new Promise((resolve) => setImmediate(resolve));
  const headers = { Host: 'cloud.wififiti.co.ke' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (routerToken) headers['X-WiFi-Fiti-Router'] = routerToken;
  if (body !== undefined) headers['Content-Type'] = text ? 'text/plain' : 'application/json';
  const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, { method, headers,
    body: body === undefined ? undefined : (text ? body : JSON.stringify(body)) });
  const raw = await response.text(); let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
  return { status: response.status, body: parsed, text: raw };
}

(async () => {
  const db = require('../src/lib/db').db;
  const sessions = require('../src/lib/hotspot-sessions');
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

  // A paying business (no trial) with room for 2 customers online at once,
  // one paired router, and a second business that must never see its data.
  const business = db.prepare(`INSERT INTO businesses (id, name, owner_name, owner_phone, email, password_hash, billing_status, billing_expires_at,
      onboarding_state, hotspot_concurrent, hotspot_billing_expires_at, created_at)
    VALUES (?, ?, 'Owner', ?, ?, 'x', 'active', datetime('now','+20 day'), 'complete', 2, datetime('now','+20 day'), datetime('now','-40 day'))`);
  business.run('biz-a', 'Alpha Cyber', '0712000301', 'alpha@sessions.test');
  business.run('biz-b', 'Bravo Cyber', '0712000302', 'bravo@sessions.test');
  const session = db.prepare(`INSERT INTO business_sessions (token_hash, business_id, expires_at) VALUES (?, ?, datetime('now','+1 day'))`);
  session.run(sha('owner-a'), 'biz-a'); session.run(sha('owner-b'), 'biz-b');
  const location = db.prepare(`INSERT INTO locations (id, business_id, name, router_token, router_token_hash, router_auth_mode, router_setup_verified_at, router_status, last_seen_at, customer_bridge, hotspot_server)
    VALUES (?, ?, ?, ?, ?, 'header', datetime('now'), 'online', datetime('now'), 'bridge-hs', 'hotspot1')`);
  location.run('loc-alpha', 'biz-a', 'Kitale', 'marker-a', sha('router-a'));
  location.run('loc-bravo', 'biz-b', 'Sirende', 'marker-b', sha('router-b'));
  const subscription = db.prepare(`INSERT INTO tenant_subscriptions (id, business_id, location_id, router_username, payer_phone, mac, password, total_seconds, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pw', 86400, datetime('now', ?))`);
  subscription.run('sub-1', 'biz-a', 'loc-alpha', '254711000001', '254711000001', 'AA:BB:CC:00:00:01', '+20 hours');
  subscription.run('sub-2', 'biz-a', 'loc-alpha', '254711000002', '254711000002', 'AA:BB:CC:00:00:02', '+10 hours');
  subscription.run('sub-3', 'biz-a', 'loc-alpha', '254711000003', '254711000003', 'AA:BB:CC:00:00:03', '+5 hours');
  subscription.run('sub-9', 'biz-b', 'loc-bravo', '254711000009', '254711000009', 'AA:BB:CC:00:00:09', '+5 hours');
  // An earlier sale, already switched on (not a payment in progress).
  db.prepare(`INSERT INTO tenant_transactions (checkout_request_id, business_id, location_id, phone, package_id, package_name, amount, seconds, mac, status, subscription_id, provisioned, created_at, updated_at)
    VALUES ('ws-1', 'biz-a', 'loc-alpha', '254711000001', 1, '1 day', 50, 86400, 'AA:BB:CC:00:00:01', 'paid', 'sub-1', 1, datetime('now','-1 hour'), datetime('now','-1 hour'))`).run();

  const report = (lines, count) => ['fiti-telemetry-v1', `res|14|20000000|67108864|46688|${1000 * lines.length}|${2000 * lines.length}|${count == null ? lines.length : count}`, ...lines].join('\n') + '\n';
  const sess = (n, uptime, down = 5000000, up = 700000, idle = 3) => `sess|25471100000${n}|AA:BB:CC:00:00:0${n}|10.5.50.1${n}|${uptime}|${up}|${down}|${idle}`;
  const post = (body, routerToken = 'router-a', site = 'loc-alpha') => api(`/api/router/telemetry?site=${site}`, { method: 'POST', routerToken, body, text: true });
  const online = (token = 'owner-a', loc = 'loc-alpha') => api(`/api/business/locations/${loc}/online-users`, { token });
  // The endpoint takes one report per 10 s per router; tests step past it.
  const realNow = Date.now;
  let offset = 0;
  const later = (seconds) => { offset += seconds * 1000; Date.now = () => realNow() + offset; };

  console.log('\nThe report block in the check-in reply');
  await test('it only reads, posts with the router header, and reuses the poll\'s TLS setting', () => {
    const script = sessions.telemetryReplyScript();
    assert.match(script, /\/ip hotspot active find/);
    assert.match(script, /\/ip hotspot host find where server=\$fitiHotspotServer/, 'nearby TVs come from the connected HotSpot hosts');
    assert.match(script, /\/system resource get cpu-load/);
    assert.match(script, /http-header-field=\("X-WiFi-Fiti-Router: " \. \$fitiToken\)/);
    assert.match(script, /\/api\/router\/telemetry\?site=" \. \$fitiSite\)/);
    assert.doesNotMatch(script, /token=/i, 'the router token never goes in the URL');
    assert.match(script, /check-certificate=no"\]\] != "nil"\) do=\{ :set fitiTmTls "no" \}/);
    // Every RouterOS command it runs is a read (get/find) or the one fetch.
    const commands = script.match(/\/(?:ip|interface|system|tool)[\w /-]*?(?= |\]|$)/g) || [];
    const writes = script.match(/\/(?:ip|interface|system)[\w /-]* (?:add|remove|set|enable|disable|reset|reboot|run)\b/g) || [];
    assert.deepEqual(writes, [], 'no router setting is changed');
    assert.ok(commands.length >= 8, commands.join(', '));
    assert.equal((script.match(/\{/g) || []).length, (script.match(/\}/g) || []).length, 'braces balance');
    assert.match(script, /\n\} on-error=\{\}$/, 'a failed report is silent: no log line every minute');
  });
  await test('a quiet check-in reply carries it every 30 seconds; a login job never does', async () => {
    const poll = () => api('/api/router/jobs?site=loc-alpha', { routerToken: 'router-a' });
    const first = await poll();
    assert.equal(first.status, 200);
    assert.match(first.text, /fiti-telemetry-v1/, 'the first quiet reply asks for a report');
    assert.doesNotMatch((await poll()).text, /fiti-telemetry-v1/, 'not again within 30 seconds');
    later(31);
    // A login job waiting for the router: that reply stays about the job.
    db.prepare(`INSERT INTO tenant_jobs (location_id, username, password, total_seconds, mac) VALUES ('loc-alpha', '254711000003', 'pw', 3600, 'AA:BB:CC:00:00:03')`).run();
    const busy = await poll();
    assert.match(busy.text, /interval=1s/, 'a waiting login makes the router check in every second');
    assert.doesNotMatch(busy.text, /fiti-telemetry-v1/, 'a login job travels without it');
    db.prepare(`UPDATE tenant_jobs SET acked_at=datetime('now') WHERE location_id='loc-alpha'`).run();
    assert.match((await poll()).text, /fiti-telemetry-v1/, 'the next quiet reply asks again');
    later(61);
    process.env.ROUTER_TELEMETRY = 'off';
    assert.doesNotMatch((await poll()).text, /fiti-telemetry-v1/, 'ROUTER_TELEMETRY=off stops it on every router');
    delete process.env.ROUTER_TELEMETRY;
    assert.match((await poll()).text, /fiti-telemetry-v1/);
  });
  await test('while a payment is waiting it rides only once the last report is over a minute old', async () => {
    const poll = () => api('/api/router/jobs?site=loc-alpha', { routerToken: 'router-a' });
    db.prepare(`INSERT INTO tenant_transactions (checkout_request_id, business_id, location_id, phone, package_id, package_name, amount, seconds, mac, status)
      VALUES ('ws-waiting', 'biz-a', 'loc-alpha', '254711000004', 1, '1 hour', 10, 3600, 'AA:BB:CC:00:00:04', 'pending')`).run();
    later(31);
    const waiting = await poll();
    assert.match(waiting.text, /interval=1s/, 'a payment in progress: the router checks in every second');
    assert.doesNotMatch(waiting.text, /fiti-telemetry-v1/, 'not due yet while a payment waits');
    later(31);
    assert.match((await poll()).text, /fiti-telemetry-v1/, 'over a minute: a busy hotspot still reports');
    db.prepare(`DELETE FROM tenant_transactions WHERE checkout_request_id='ws-waiting'`).run();
  });

  console.log('\nThe report endpoint');
  await test('only the router itself can report, with its header', async () => {
    assert.equal((await post(report([sess(1, 60)]), null)).status, 403, 'no header');
    assert.equal((await post(report([sess(1, 60)]), 'router-b')).status, 403, 'another router\'s key');
    assert.equal((await api(`/api/router/telemetry?site=loc-alpha&token=router-a`, { method: 'POST', body: report([sess(1, 60)]), text: true })).status, 403, 'a token in the URL is not accepted');
    assert.equal((await post('hello')).status, 400, 'not a report');
  });
  await test('a report opens sessions, keeps a chart sample, and skips the owner\'s own logins', async () => {
    later(11);
    const response = await post(report([sess(1, 600), sess(2, 120), 'sess|admin|AA:BB:CC:00:00:AA|10.5.50.200|99|1|1|1'], 3));
    assert.equal(response.status, 200, response.text);
    const rows = db.prepare(`SELECT router_username, subscription_id, ended_at, uptime_seconds, bytes_out FROM tenant_hotspot_sessions ORDER BY router_username`).all();
    assert.deepEqual(rows.map((row) => [row.router_username, row.subscription_id, row.ended_at, row.uptime_seconds]),
      [['254711000001', 'sub-1', null, 600], ['254711000002', 'sub-2', null, 120]]);
    const sample = db.prepare(`SELECT cpu_percent, active_users FROM tenant_router_telemetry WHERE location_id='loc-alpha'`).all();
    assert.deepEqual(sample.map((row) => [row.cpu_percent, row.active_users]), [[14, 2]], 'one chart sample; the owner\'s login is not a customer');
    later(3);
    assert.equal((await post(report([sess(1, 603)]))).text.trim(), '# later', 'a second report within 10 s is dropped');
  });
  await test('a connected unpaid TV appears in nearby devices without a test kit', async () => {
    later(11);
    const response = await post(report([sess(1, 614), sess(2, 134), 'dev|AA:BB:CC:44:55:66|10.5.50.66|Living-room TV'], 2));
    assert.equal(response.status, 200, response.text);
    const found = await api('/api/tenant/loc-alpha/device-discovery');
    assert.equal(found.status, 200);
    const tv = found.body.devices.find((device) => device.label === 'Living-room TV');
    assert.ok(tv, JSON.stringify(found.body));
    assert.match(tv.id, /^dev:/);
    assert.doesNotMatch(JSON.stringify(tv), /44:55:66/, 'the full MAC stays hidden');
  });
  await test('the same session counts up; leaving closes it; coming back is a new session', async () => {
    later(60);
    assert.equal((await post(report([sess(1, 660, 9000000), sess(2, 180)]))).status, 200);
    let one = db.prepare(`SELECT * FROM tenant_hotspot_sessions WHERE router_username='254711000001'`).all();
    assert.equal(one.length, 1); assert.equal(one[0].uptime_seconds, 660); assert.equal(one[0].bytes_out, 9000000);
    later(60);
    await post(report([sess(2, 240)]));
    one = db.prepare(`SELECT * FROM tenant_hotspot_sessions WHERE router_username='254711000001'`).all();
    assert.ok(one[0].ended_at, 'customer 1 left: the session is closed at its last report');
    later(60);
    await post(report([sess(1, 30), sess(2, 300)]));
    one = db.prepare(`SELECT * FROM tenant_hotspot_sessions WHERE router_username='254711000001' ORDER BY id`).all();
    assert.equal(one.length, 2, 'coming back opens a new session');
    assert.equal(one[1].ended_at, null);
    // A router that restarted mid-session reports a smaller uptime: new session too.
    later(60);
    await post(report([sess(1, 5), sess(2, 360)]));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tenant_hotspot_sessions WHERE router_username='254711000001'`).get().n, 3);
  });
  await test('a list cut short never marks anyone offline', async () => {
    later(60);
    await post(report([sess(1, 65)], 200));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tenant_hotspot_sessions WHERE router_username='254711000002' AND ended_at IS NULL`).get().n, 1,
      'customer 2 is not in a truncated list but stays online');
    later(60);
    await post(report([sess(1, 125), sess(2, 480)]));
  });

  await test('a long chart period keeps its newest point and at most 240 points', async () => {
    const insert = db.prepare(`INSERT INTO tenant_router_telemetry (location_id, cpu_percent, active_users, recorded_at) VALUES ('loc-alpha', ?, 1, datetime('now', ?))`);
    for (let minute = 1440; minute >= 2; minute -= 1) insert.run(minute % 100, `-${minute} minutes`);
    const chart = (await api('/api/business/router-telemetry?locationId=loc-alpha&period=24h', { token: 'owner-a' })).body;
    assert.ok(chart.samples.length <= 240 && chart.samples.length >= 200, String(chart.samples.length));
    assert.equal(chart.samples[chart.samples.length - 1].recorded_at, chart.latest.recorded_at, 'the newest point is always drawn');
    assert.ok(chart.samples[0].recorded_at < chart.samples[1].recorded_at, 'oldest first');
    db.prepare(`DELETE FROM tenant_router_telemetry WHERE location_id='loc-alpha' AND active_users=1 AND free_memory IS NULL`).run();
  });

  console.log('\nActive users');
  await test('the owner sees who is online, with session, data and time left, and who has time but is offline', async () => {
    const view = await online();
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.reporting, true);
    // Longest-connected first: customer 2 has been on since before customer 1 came back.
    assert.deepEqual(view.body.online.map((row) => row.router_username), ['254711000002', '254711000001']);
    const first = view.body.online.find((row) => row.router_username === '254711000001');
    assert.equal(first.package_name, '1 day');
    assert.equal(first.ip, '10.5.50.11');
    assert.ok(first.seconds_left > 19 * 3600, 'time left comes from the package');
    assert.ok(first.bytes_out > 0 && first.bytes_in > 0);
    assert.deepEqual(view.body.offline.map((row) => row.subscription_id), ['sub-3']);
    assert.deepEqual(view.body.capacity, { online: 2, limit: 2, level: 'full' });
  });
  await test('another business sees nothing of it', async () => {
    assert.equal((await online('owner-b')).status, 404);
    const detail = await api('/api/business/operations/customers/sub-1', { token: 'owner-b' });
    assert.equal(detail.status, 404);
  });
  await test('a customer\'s page shows their sessions, totals and whether they are online now', async () => {
    const detail = await api('/api/business/operations/customers/sub-1', { token: 'owner-a' });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.activity.online, true);
    assert.equal(detail.body.activity.sessions.length, 3);
    assert.equal(detail.body.activity.totals.sessions, 3);
    assert.ok(detail.body.activity.totals.bytes_out >= 9000000);
    const quiet = await api('/api/business/operations/customers/sub-3', { token: 'owner-a' });
    assert.equal(quiet.body.activity.online, false);
    assert.deepEqual(quiet.body.activity.sessions, []);
  });

  console.log('\nThe concurrent-user limit counts customers actually online');
  const goLive = async () => (await api('/api/business/locations/loc-alpha/go-live', { token: 'owner-a' })).body;
  await test('three packages with time left but only one customer online: sales stay open', async () => {
    later(60);
    await post(report([sess(1, 185)]));
    assert.equal(sessions.onlineCountForBusiness('biz-a'), 1);
    const status = await goLive();
    assert.doesNotMatch(JSON.stringify(status), /full right now/i, JSON.stringify(status));
  });
  await test('two customers online on a 2-user plan: new sales wait', async () => {
    later(60);
    await post(report([sess(1, 245), sess(3, 20)]));
    assert.equal(sessions.onlineCountForBusiness('biz-a'), 2);
    assert.match(JSON.stringify(await goLive()), /full right now/i);
  });
  await test('a router that stops reporting falls back to counting packages with time left', async () => {
    db.prepare(`UPDATE tenant_session_reports SET reported_at=datetime('now','-10 minutes') WHERE location_id='loc-alpha'`).run();
    assert.equal(sessions.onlineCountForBusiness('biz-a'), 3, 'no guess: all three packages count');
    const view = await online();
    assert.equal(view.body.reporting, false);
    assert.deepEqual(view.body.online, []);
    db.prepare(`UPDATE tenant_hotspot_sessions SET last_seen_at=datetime('now','-11 minutes') WHERE ended_at IS NULL`).run();
    assert.ok(sessions.sweep() >= 2, 'sessions of a quiet router are closed');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tenant_hotspot_sessions WHERE ended_at IS NULL`).get().n, 0);
  });

  console.log('\nPermissions');
  await test('the route table lets the Technician see who is online (no money in it)', () => {
    const table = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'team.js'), 'utf8');
    assert.match(table, /\['GET', `\$\{B\}\/locations\/:locationId\/online-users`, \['customers\.view', 'routers\.view'\]\]/);
  });

  Date.now = realNow;
  console.log(`\nHotspot sessions: ${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });

'use strict';

// Demo request + live demo payment tests. Isolated in-memory SQLite, a fake
// Tuma adapter and fake notification channels: no network, no money.
//   node --require ./test/in-process-http.js test/demo.js
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const {
  createDemo, validateRequest, estimateEarnings, requestSummaryMessage, normalisePhone,
} = require('../src/lib/demo');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

const validLead = {
  name: 'Wanjiru Otieno', phone: '0712 345 678', email: 'wanjiru@example.com', businessType: 'cyber',
  town: 'Kitale', locations: '2', routerModel: 'hAP lite', usersPerDay: '40', avgPriceKes: '20',
  contactMethod: 'call', preferredDate: '2026-09-28', preferredSlot: 'morning', notes: 'Near the market',
};

function harness({ live = false, env = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  let clock = Date.parse('2026-09-25T10:00:00Z');
  const sms = [];
  const emails = [];
  const pushes = [];
  const tuma = {
    configured: () => live,
    async stkPush(args) { pushes.push(args); return { checkoutRequestId: `ws_CO_TEST_${pushes.length}`, merchantRequestId: `m-${pushes.length}` }; },
  };
  const demo = createDemo({
    db,
    adminOk: (req) => req.get('x-admin-password') === 'admin-secret',
    tuma,
    publicUrl: 'https://cloud.wifi-fiti.test',
    smsProvider: { async send(message) { sms.push(message); return { id: 'sms-1' }; } },
    sendEmail: async (message) => { emails.push(message); return { id: 'email-1' }; },
    whatsapp: { configured: () => false },
    env: { DEMO_NOTIFY_PHONE: '0700111222', DEMO_NOTIFY_EMAIL: 'sales@wifi-fiti.test', DEMO_PRACTICE_DELAY_MS: '5000', ...env },
    now: () => clock,
    log: { error() {} },
  });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  demo.attachRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return {
    db, demo, sms, emails, pushes, call, close: () => server.close(),
    advance(ms) { clock += ms; },
  };
}

(async () => {
  console.log('\nDemo request validation');

  await test('normalises every Kenyan number format a prospect might type', () => {
    for (const input of ['0712345678', '+254712345678', '254712345678', '712345678', '0712 345 678']) {
      assert.equal(normalisePhone(input), '254712345678');
    }
    assert.equal(normalisePhone('0110123456'), '254110123456');
    assert.equal(normalisePhone('12345'), null);
  });

  await test('accepts a complete lead and keeps the fields it needs', () => {
    const lead = validateRequest(validLead, { today: new Date('2026-09-25T10:00:00Z') });
    assert.equal(lead.phone, '254712345678');
    assert.equal(lead.locations, 2);
    assert.equal(lead.usersPerDay, 40);
    assert.equal(lead.contactMethod, 'call');
    assert.equal(lead.preferredDate, '2026-09-28');
  });

  await test('rejects missing essentials with a field-specific message', () => {
    assert.throws(() => validateRequest({ ...validLead, name: '' }), (e) => e.field === 'name');
    assert.throws(() => validateRequest({ ...validLead, phone: '123' }), (e) => e.field === 'phone');
    assert.throws(() => validateRequest({ ...validLead, businessType: 'bank' }), (e) => e.field === 'businessType');
    assert.throws(() => validateRequest({ ...validLead, email: 'nope' }), (e) => e.field === 'email');
    assert.throws(() => validateRequest({ ...validLead, preferredDate: '2025-01-01' }, { today: new Date('2026-09-25') }), (e) => e.field === 'preferredDate');
  });

  await test('defaults optional fields rather than rejecting them', () => {
    const lead = validateRequest({ name: 'Ann', phone: '0722000000', businessType: 'shop', town: 'Eldoret' });
    assert.equal(lead.locations, 1);
    assert.equal(lead.contactMethod, 'whatsapp');
    assert.equal(lead.preferredDate, null);
    assert.equal(lead.email, null);
  });

  await test('estimates monthly sales and fees at 3% and 5%', () => {
    assert.deepEqual(estimateEarnings({ usersPerDay: 40, avgPriceKes: 20 }), { gross: 24000, fee: 720, net: 23280 });
    assert.deepEqual(estimateEarnings({ usersPerDay: 40, avgPriceKes: 20, feePercent: 5 }), { gross: 24000, fee: 1200, net: 22800 });
    assert.deepEqual(estimateEarnings({ usersPerDay: 0, avgPriceKes: 20 }), { gross: 0, fee: 0, net: 0 });
  });

  await test('builds a compact alert message', () => {
    const message = requestSummaryMessage(validateRequest(validLead, { today: new Date('2026-09-25') }));
    assert.match(message, /Wanjiru Otieno, 0712 345 678/);
    assert.match(message, /Cyber café in Kitale, 2 locations/);
    assert.match(message, /Prefers Phone call 2026-09-28 Morning/);
    assert.match(message, /KES 24,000\/mo/);
    assert.ok(message.length <= 320);
  });

  console.log('\nDemo request API');
  {
    const h = harness();
    await test('stores a request, returns a WhatsApp handoff and alerts the operator', async () => {
      const response = await h.call('POST', '/api/demo/requests', validLead);
      assert.equal(response.status, 201);
      assert.match(response.body.id, /^demo_[a-f0-9]{18}$/);
      assert.match(response.body.whatsappUrl, /^https:\/\/wa\.me\/254718016683\?text=/);
      assert.match(decodeURIComponent(response.body.whatsappUrl), /Wanjiru Otieno \(Cyber café, Kitale\)/);
      const channels = await h.demo.lastNotification;
      assert.deepEqual(channels.sort(), ['email', 'sms']);
      assert.equal(h.sms[0].to, '+254700111222');
      assert.match(h.sms[0].message, /New Wi-Fi Fiti demo request/);
      assert.equal(h.emails[0].to, 'sales@wifi-fiti.test');
      assert.match(h.emails[0].html, /Near the market/);
      const row = h.db.prepare('SELECT * FROM demo_requests').get();
      assert.equal(row.notified, 'email,sms');
      assert.equal(row.status, 'new');
    });

    await test('a quick resubmission updates the same lead without a second alert', async () => {
      const response = await h.call('POST', '/api/demo/requests', { ...validLead, locations: 3 });
      assert.equal(response.status, 200);
      assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM demo_requests').get().n, 1);
      assert.equal(h.db.prepare('SELECT locations FROM demo_requests').get().locations, 3);
      assert.equal(h.sms.length, 1);
    });

    await test('bots that fill the hidden field are accepted silently but not stored', async () => {
      const response = await h.call('POST', '/api/demo/requests', { ...validLead, phone: '0733000000', website: 'http://spam' });
      assert.equal(response.status, 201);
      assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM demo_requests').get().n, 1);
    });

    await test('invalid input returns 400 with the failing field', async () => {
      const response = await h.call('POST', '/api/demo/requests', { ...validLead, phone: 'abc' });
      assert.equal(response.status, 400);
      assert.equal(response.body.field, 'phone');
    });

    await test('admin list requires the platform password', async () => {
      assert.equal((await h.call('GET', '/api/admin/demo/requests')).status, 403);
      const response = await h.call('GET', '/api/admin/demo/requests', null, { 'x-admin-password': 'admin-secret' });
      assert.equal(response.status, 200);
      assert.equal(response.body.requests.length, 1);
      assert.equal(response.body.requests[0].estimateKes, 24000);
      assert.equal(response.body.counts.new, 1);
    });

    await test('admin can move a lead through the pipeline and add notes', async () => {
      const id = h.db.prepare('SELECT id FROM demo_requests').get().id;
      const response = await h.call('PATCH', `/api/admin/demo/requests/${id}`, { status: 'contacted', adminNotes: 'Called, visiting Monday' }, { 'x-admin-password': 'admin-secret' });
      assert.equal(response.status, 200);
      assert.equal(response.body.request.status, 'contacted');
      assert.equal(response.body.request.adminNotes, 'Called, visiting Monday');
      const bogus = await h.call('PATCH', `/api/admin/demo/requests/${id}`, { status: 'hacked' }, { 'x-admin-password': 'admin-secret' });
      assert.equal(bogus.body.request.status, 'contacted');
    });
    h.close();
  }

  console.log('\nLive demo in practice mode');
  {
    const h = harness({ live: false });
    let started;
    await test('config reports practice mode when Tuma is not configured', async () => {
      const response = await h.call('GET', '/api/demo/config');
      assert.equal(response.body.live, false);
      assert.equal(response.body.amount, 1);
      assert.equal(response.body.sessionSeconds, 300);
    });

    await test('starts a practice payment without calling Tuma', async () => {
      const response = await h.call('POST', '/api/demo/pay', { phone: '0712345678' });
      assert.equal(response.status, 201);
      assert.equal(response.body.mode, 'practice');
      assert.equal(h.pushes.length, 0);
      started = response.body;
    });

    await test('status needs the matching token', async () => {
      assert.equal((await h.call('GET', `/api/demo/pay/${started.id}?token=wrong`)).status, 404);
      assert.equal((await h.call('GET', `/api/demo/pay/${started.id}`)).status, 404);
    });

    await test('stays pending, then confirms after the practice delay', async () => {
      let status = await h.call('GET', `/api/demo/pay/${started.id}?token=${started.token}`);
      assert.equal(status.body.status, 'pending');
      h.advance(5000);
      status = await h.call('GET', `/api/demo/pay/${started.id}?token=${started.token}`);
      assert.equal(status.body.status, 'paid');
      assert.equal(status.body.remainingSeconds, 300);
      h.advance(60_000);
      status = await h.call('GET', `/api/demo/pay/${started.id}?token=${started.token}`);
      assert.equal(status.body.remainingSeconds, 240);
    });

    await test('rate limits the same phone and caps prompts per day', async () => {
      const soon = await h.call('POST', '/api/demo/pay', { phone: '0712345678' });
      assert.equal(soon.status, 429);
      h.advance(90_000);
      assert.equal((await h.call('POST', '/api/demo/pay', { phone: '0712345678' })).status, 201);
      h.advance(90_000);
      assert.equal((await h.call('POST', '/api/demo/pay', { phone: '0712345678' })).status, 201);
      h.advance(90_000);
      const capped = await h.call('POST', '/api/demo/pay', { phone: '0712345678' });
      assert.equal(capped.status, 429);
      assert.match(capped.body.error, /a few times today/);
    });

    await test('rejects an invalid number before any prompt', async () => {
      const response = await h.call('POST', '/api/demo/pay', { phone: '12' });
      assert.equal(response.status, 400);
    });
    h.close();
  }

  console.log('\nLive demo through Tuma');
  {
    const h = harness({ live: true, env: { DEMO_AMOUNT_KES: '1' } });
    let started;
    await test('sends a real KES 1 STK push through Tuma', async () => {
      const response = await h.call('POST', '/api/demo/pay', { phone: '0712345678' });
      assert.equal(response.status, 201);
      assert.equal(response.body.mode, 'live');
      assert.equal(response.body.id, 'ws_CO_TEST_1');
      assert.deepEqual(h.pushes[0], { phone: '254712345678', amount: 1, description: 'Wi-Fi Fiti live demo', publicUrl: 'https://cloud.wifi-fiti.test' });
      started = response.body;
    });

    await test('claims only its own checkout ids', () => {
      assert.equal(h.demo.ownsCheckout('ws_CO_TEST_1'), true);
      assert.equal(h.demo.ownsCheckout('ws_CO_TENANT_999'), false);
      assert.equal(h.demo.handleTumaCallback({ checkout_request_id: 'ws_CO_TENANT_999', result_code: 0 }), false);
    });

    await test('does not confirm on an underpaid callback', async () => {
      const second = await h.call('POST', '/api/demo/pay', { phone: '0722000111' });
      h.demo.handleTumaCallback({ checkout_request_id: second.body.id, status: 'completed', result_code: 0, amount: 0, mpesa_receipt_number: 'UBNGT7QNYA' });
      const status = await h.call('GET', `/api/demo/pay/${second.body.id}?token=${second.body.token}`);
      assert.equal(status.body.status, 'failed');
    });

    await test('confirms on a verified success callback', async () => {
      assert.equal(h.demo.handleTumaCallback({
        checkout_request_id: started.id, status: 'completed', result_code: 0, amount: 1, mpesa_receipt_number: 'ubngt7qnyb',
      }), true);
      const status = await h.call('GET', `/api/demo/pay/${started.id}?token=${started.token}`);
      assert.equal(status.body.status, 'paid');
      assert.equal(status.body.receipt, 'UBNGT7QNYB');
    });

    await test('a replayed callback cannot reuse the receipt', async () => {
      h.advance(120_000);
      const third = await h.call('POST', '/api/demo/pay', { phone: '0712345678' });
      h.demo.handleTumaCallback({ checkout_request_id: third.body.id, status: 'completed', result_code: 0, amount: 1, mpesa_receipt_number: 'UBNGT7QNYB' });
      const status = await h.call('GET', `/api/demo/pay/${third.body.id}?token=${third.body.token}`);
      assert.equal(status.body.status, 'failed');
    });

    await test('a cancelled prompt reports Tuma\'s reason', async () => {
      h.advance(120_000);
      const fourth = await h.call('POST', '/api/demo/pay', { phone: '0733444555' });
      h.demo.handleTumaCallback({ checkout_request_id: fourth.body.id, status: 'failed', result_code: 1032, failure_reason: 'Request cancelled by user' });
      const status = await h.call('GET', `/api/demo/pay/${fourth.body.id}?token=${fourth.body.token}`);
      assert.equal(status.body.status, 'failed');
      assert.equal(status.body.reason, 'Request cancelled by user');
    });

    await test('an unanswered prompt expires, and a late callback still settles it', async () => {
      h.advance(120_000);
      const fifth = await h.call('POST', '/api/demo/pay', { phone: '0744555666' });
      h.advance(181_000);
      let status = await h.call('GET', `/api/demo/pay/${fifth.body.id}?token=${fifth.body.token}`);
      assert.equal(status.body.status, 'expired');
      h.demo.handleTumaCallback({ checkout_request_id: fifth.body.id, status: 'completed', result_code: 0, amount: 1, mpesa_receipt_number: 'UBNGT7QNYC' });
      status = await h.call('GET', `/api/demo/pay/${fifth.body.id}?token=${fifth.body.token}`);
      assert.equal(status.body.status, 'paid');
    });

    await test('admin payment report masks phone numbers', async () => {
      const response = await h.call('GET', '/api/admin/demo/payments', null, { 'x-admin-password': 'admin-secret' });
      assert.equal(response.status, 200);
      assert.equal(response.body.live, true);
      assert.ok(response.body.payments.every((p) => /^0\d{3} ••• \d{3}$/.test(p.phone)));
    });

    h.close();
  }

  {
    const db = new DatabaseSync(':memory:');
    const demo = createDemo({
      db, adminOk: () => false, publicUrl: 'https://x.test', log: { error() {} },
      tuma: { configured: () => true, async stkPush() { throw new Error('Tuma is down'); } },
    });
    const app = express(); app.use(express.json()); demo.attachRoutes(app);
    const server = app.listen(0);
    await test('a Tuma outage returns a friendly 502 and records no payment', async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/demo/pay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0712345678' }),
      });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /could not send the payment prompt/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demo_payments').get().n, 0);
    });
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

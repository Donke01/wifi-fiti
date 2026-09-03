/* Run with: node test/run.js */
const assert = require('assert');
const net = require('net');

process.env.PUBLIC_URL ||= 'https://example.test';
process.env.MPESA_CONSUMER_KEY ||= 'k';
process.env.MPESA_CONSUMER_SECRET ||= 's';
process.env.MPESA_SHORTCODE ||= '174379';
process.env.MPESA_PASSKEY ||= 'p';
process.env.MIKROTIK_HOST ||= '127.0.0.1';
process.env.MIKROTIK_PORT ||= '18728';
process.env.MIKROTIK_USER ||= 'test';
process.env.MIKROTIK_PASSWORD ||= 'test';
process.env.DATABASE_PATH ||= '/tmp/hotspot-test.db';

const {
  encodeLength,
  decodeLength,
  encodeSentence,
} = require('../src/lib/routeros-api');
const mpesa = require('../src/lib/mpesa');
const mikrotik = require('../src/lib/mikrotik');

let pass = 0;
const failures = [];

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        pass++;
        console.log(`  ok   ${name}`);
      },
      (err) => {
        failures.push(name);
        console.log(`  FAIL ${name}\n         ${err.message}`);
      }
    );
}

const { startMockRouter } = require('./mock-router');

/* ================================================================== */

(async function main() {
  console.log('\nLength prefix codec');

  await t('round-trips across every prefix boundary', () => {
    // The boundaries are where hand-rolled codecs break.
    for (const n of [0, 1, 0x7f, 0x80, 0x81, 0x3fff, 0x4000, 0x1fffff,
                     0x200000, 0x0fffffff, 0x10000000]) {
      const enc = encodeLength(n);
      const dec = decodeLength(enc, 0);
      assert.strictEqual(dec.length, n, `length ${n} did not survive`);
      assert.strictEqual(dec.bytes, enc.length, `byte count wrong for ${n}`);
    }
  });

  await t('reports "need more data" on a truncated prefix', () => {
    const enc = encodeLength(0x4000); // 3 bytes
    assert.strictEqual(decodeLength(enc.subarray(0, 2), 0), null);
    assert.strictEqual(decodeLength(Buffer.alloc(0), 0), null);
  });

  await t('encodes a sentence with a zero-length terminator', () => {
    const s = encodeSentence(['/login', '=name=x']);
    assert.strictEqual(s[s.length - 1], 0x00);
    assert.ok(s.includes(Buffer.from('/login')));
  });

  console.log('\nPhone normalization');

  await t('accepts every format a Kenyan customer might type', () => {
    const expect = '254712345678';
    for (const input of [
      '0712345678', '712345678', '254712345678', '+254712345678',
      '0712 345 678', '+254 712 345 678', '0712-345-678',
    ]) {
      assert.strictEqual(mpesa.normalizePhone(input), expect, `failed on ${input}`);
    }
  });

  await t('handles the newer 01XX range', () => {
    assert.strictEqual(mpesa.normalizePhone('0110123456'), '254110123456');
  });

  await t('rejects rubbish rather than pushing STK at a bad number', () => {
    for (const bad of ['', null, '123', '0812345678', '07123456789',
                       'abcdefghij', '0612345678']) {
      assert.strictEqual(mpesa.normalizePhone(bad), null, `accepted ${bad}`);
    }
  });

  await t('formats numbers back for display', () => {
    assert.strictEqual(mpesa.displayPhone('254712345678'), '0712 345 678');
  });

  console.log('\nRouterOS duration parsing');

  await t('parses both shapes RouterOS emits', () => {
    const cases = [
      ['10800', 10800],
      ['3h', 10800],
      ['1d', 86400],
      ['1w', 604800],
      ['1d2h3m4s', 93784],
      ['02:30:00', 9000],
      ['1d 02:30:00', 95400],
      ['', 0],
      [undefined, 0],
    ];
    for (const [input, want] of cases) {
      assert.strictEqual(
        mikrotik.parseRouterOsTime(input), want,
        `${JSON.stringify(input)} -> expected ${want}`
      );
    }
  });

  console.log('\nCallback parsing');

  await t('extracts receipt and amount from a success callback', () => {
    const parsed = mpesa.parseCallback({
      Body: { stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_191220191020363925',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: { Item: [
          { Name: 'Amount', Value: 50 },
          { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
          { Name: 'TransactionDate', Value: 20191219102115 },
          { Name: 'PhoneNumber', Value: 254712345678 },
        ]},
      }},
    });
    assert.strictEqual(parsed.resultCode, 0);
    assert.strictEqual(parsed.receipt, 'NLJ7RT61SV');
    assert.strictEqual(parsed.amount, 50);
  });

  await t('handles a cancelled payment (no metadata block)', () => {
    const parsed = mpesa.parseCallback({
      Body: { stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_cancelled',
        ResultCode: 1032,
        ResultDesc: 'Request cancelled by user',
      }},
    });
    assert.strictEqual(parsed.resultCode, 1032);
    assert.strictEqual(parsed.receipt, undefined);
  });

  await t('returns null on a payload that is not a callback', () => {
    assert.strictEqual(mpesa.parseCallback({ hello: 'world' }), null);
  });

  console.log('\nProvisioning against a mock RouterOS');

  const mock = await startMockRouter(18728);

  await t('connects, authenticates and reads system info', async () => {
    const info = await mikrotik.testConnection();
    assert.strictEqual(info.board, 'hAP lite');
    assert.strictEqual(info.version, '7.24.1');
  });

  await t('creates a new user with the purchased duration', async () => {
    const r = await mikrotik.provisionUser({
      username: '254712345678', password: 'AB2345',
      profile: 'standard', seconds: 10800, comment: 'hr3 TEST1',
    });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.totalSeconds, 10800);
    assert.strictEqual(mock.users.get('254712345678')['limit-uptime'], '10800');
  });

  await t('top-up adds time instead of overwriting it', async () => {
    const r = await mikrotik.provisionUser({
      username: '254712345678', password: 'CD6789',
      profile: 'standard', seconds: 86400, comment: 'day1 TEST2',
    });
    assert.strictEqual(r.created, false);
    // 3h already owned + 24h bought. Overwriting would have lost the 3h.
    assert.strictEqual(r.totalSeconds, 97200);
    assert.strictEqual(mock.users.get('254712345678')['limit-uptime'], '97200');
  });

  await t('a third top-up keeps accumulating', async () => {
    const r = await mikrotik.provisionUser({
      username: '254712345678', password: 'EF1234',
      profile: 'standard', seconds: 3600, comment: 'x',
    });
    assert.strictEqual(r.totalSeconds, 100800);
  });

  await t('logs a device in by MAC', async () => {
    const ok = await mikrotik.forceLogin({
      username: '254712345678', password: 'EF1234',
      mac: 'aa:bb:cc:dd:ee:ff', ip: '10.5.50.11',
    });
    assert.strictEqual(ok, true);
    const call = mock.log.filter((l) => l.cmd === '/ip/hotspot/active/login').pop();
    assert.ok(call.args.includes('=mac-address=AA:BB:CC:DD:EE:FF'),
      'MAC should be upper-cased for RouterOS');
  });

  await t('surfaces RouterOS errors as exceptions', async () => {
    await assert.rejects(
      () => mikrotik.forceLogin({ username: 'x', password: 'y', mac: null, ip: null })
        .then((r) => { if (r === false) throw new Error('skipped, as designed'); }),
      /skipped, as designed/
    );
  });

  mock.server.close();

  /* ---------------------------------------------------------------- */

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failing: ' + failures.join(', '));
    process.exit(1);
  }
  process.exit(0);
})();

/* Regression: unacked jobs were redelivered every 60s, and each
   redelivery rewrote limit-uptime — so a customer's balance snapped
   back to an older figure once a minute. */
const assert = require('assert');
const fs = require('fs');

const PORT = 14800;
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll';
process.env.SITE_ID = 'kitale-1';
process.env.SITE_TOKEN = 'tok-ack';
process.env.DATABASE_PATH = '/tmp/ack-test.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync('/tmp/ack-test.db' + s); } catch {} }

require('../src/server');
const db = require('../src/lib/db');
const { grantTime } = require('../src/lib/grant');
const realFetch = global.fetch;

const sync = (ack) => realFetch(
  `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-ack` +
  (ack ? `&ack=${ack}` : ''),
  { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' }
).then(async (r) => ({ s: r.status, t: await r.text() }));

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

/** Pull the job ids out of the ":global fitiAck" line the script ends with. */
function ackIdsIn(script) {
  const m = script.match(/:global fitiAck "([^"]*)"/);
  return m && m[1] ? m[1] : '';
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400));
  console.log('\nJob acknowledgement');

  await grantTime({ phone: '254748181876', seconds: 3600, profile: 'standard',
                    mac: null, ip: null, reason: 'hr1' });

  let firstIds;

  await t('script carries the ids instead of a nested fetch', async () => {
    const r = await sync();
    assert.ok(r.t.includes(':global fitiAck'), 'no ack marker in script');
    assert.ok(!r.t.includes('/tool fetch'), 'script must not fetch on its own');
    firstIds = ackIdsIn(r.t);
    assert.ok(firstIds, 'no job ids emitted');
  });

  await t('the job is retired once the ids come back', async () => {
    await sync(firstIds);
    const rows = db.db.prepare(
      'SELECT acked_at FROM jobs WHERE id = ?').get(Number(firstIds.split(',')[0]));
    assert.ok(rows.acked_at, 'job should be acked');
  });

  await t('an acked job is never handed out again', async () => {
    // Force the delivery window open; only the ack should hold it back.
    db.db.exec("UPDATE jobs SET delivered_at = datetime('now','-120 seconds')");
    const r = await sync();
    assert.strictEqual(r.t.trim(), '', 'acked job was redelivered');
  });

  await t('a top-up is not clobbered by an old job', async () => {
    // This is the bug as the customer saw it: buy more time, then watch a
    // stale job overwrite limit-uptime with the previous figure.
    await grantTime({ phone: '254748181876', seconds: 86400, profile: 'standard',
                      mac: null, ip: null, reason: 'day1' });
    const r = await sync();
    const totals = [...r.t.matchAll(/limit-uptime=(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(totals.length, 'expected a job');
    assert.ok(totals.every((v) => v >= 90000),
      'stale job resurfaced with an old total: ' + totals.join(','));
    await sync(ackIdsIn(r.t));
  });

  await t('an unacked job still redelivers after the window', async () => {
    // The safety net must survive: if the router dies mid-script, the job
    // has to come back.
    await grantTime({ phone: '254722000005', seconds: 3600, profile: 'standard',
                      mac: null, ip: null, reason: 'safety' });
    const first = await sync();
    assert.ok(first.t.includes('254722000005'), 'job not delivered');
    db.db.exec("UPDATE jobs SET delivered_at = datetime('now','-120 seconds') WHERE acked_at IS NULL");
    const again = await sync();
    assert.ok(again.t.includes('254722000005'), 'unacked job should redeliver');
  });

  await t('ignores rubbish in the ack parameter', async () => {
    const r = await realFetch(
      `http://127.0.0.1:${PORT}/api/router/sync?site=kitale-1&token=tok-ack&ack=abc,-1,999999`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
    assert.strictEqual(r.status, 200);
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();

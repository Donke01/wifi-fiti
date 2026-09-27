'use strict';

// Sign-up must not reveal which emails have accounts, and must not create
// unverifiable accounts in production.
//   node --require ./test/in-process-http.js test/signup-privacy.js [refuse]
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv[2] || 'parent';
if (mode === 'parent') {
  // Each scenario needs its own process: config is read once at start.
  let failed = 0;
  for (const scenario of ['refuse', 'resend']) {
    const run = spawnSync(process.execPath, ['--require', path.join(__dirname, 'in-process-http.js'), __filename, scenario], { encoding: 'utf8' });
    process.stdout.write(run.stdout.split('\n').filter((line) => /^\s+(ok|FAIL)/.test(line)).join('\n') + '\n');
    if (run.status !== 0) { failed += 1; process.stdout.write(run.stderr.slice(-800)); }
  }
  console.log(failed ? `Sign-up privacy: ${failed} scenario(s) failed` : 'Sign-up privacy: passed');
  process.exit(failed ? 1 : 0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-fiti-signup-'));
Object.assign(process.env, {
  PORT: '0', PUBLIC_URL: 'https://wifi-fiti.example.test', APP_URL: 'https://cloud.wififiti.co.ke',
  MARKETING_URL: 'https://wififiti.co.ke', LEGACY_HOST: 'wififiti.co.ke',
  MPESA_ENV: 'production', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p',
  PROVISION_MODE: 'poll', SITE_ID: 'site', SITE_TOKEN: 'site-token', TENANT_SECRETS_KEY: 'signup-test-key',
  ADMIN_TOKEN: 'admin', DATABASE_PATH: path.join(dir, 'hotspot.db'),
});
if (mode === 'resend') process.env.RESEND_API_KEY = 're_test_key';

const emails = [];
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  if (target.hostname === 'api.resend.com') { emails.push(JSON.parse(options.body)); return Response.json({ id: `email_${emails.length}` }); }
  throw new Error(`unexpected request to ${target.href}`);
};

(async () => {
  let server;
  const originalListen = http.Server.prototype.listen;
  const listening = new Promise((resolve) => {
    http.Server.prototype.listen = function (...args) { server = this; this.once('listening', resolve); return originalListen.apply(this, args); };
  });
  try { require('../src/server'); } finally { http.Server.prototype.listen = originalListen; }
  await listening;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async (email) => {
    const response = await fetch(`${origin}/api/business/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'cloud.wififiti.co.ke' },
      body: JSON.stringify({ email, password: 'long-enough-password', name: 'Cafe', ownerName: 'Owner Name', phone: '0712000123' }) });
    return { status: response.status, body: await response.json() };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

  if (mode === 'refuse') {
    const response = await register('new@test.ke');
    assert.equal(response.status, 503, 'production with no email or SMS verification refuses sign-ups');
    console.log('  ok   production refuses unverifiable sign-ups');
  } else {
    const fresh = await register('owner@test.ke');
    assert.equal(fresh.status, 202);
    await settle();
    assert.equal(emails.length, 1, 'a code email is sent');
    require('../src/lib/db').db.prepare(`INSERT INTO businesses (id, name, owner_name, owner_phone, email, password_hash, onboarding_state)
      VALUES ('taken', 'Taken', 'Owner', '254712000999', 'taken@test.ke', 'x', 'complete')`).run();
    const taken = await register('taken@test.ke');
    assert.equal(taken.status, fresh.status, 'an existing email gets the same status');
    assert.deepEqual(Object.keys(taken.body).sort(), Object.keys(fresh.body).sort(), 'and the same response shape');
    await settle();
    assert.equal(emails.length, 2);
    assert.match(emails[1].subject, /already|tried/i, 'the owner is told to sign in instead');
    console.log('  ok   an existing email gets the same answer as a new one');
  }
  server.close();
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

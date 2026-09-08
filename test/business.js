const assert = require('assert');
const fs = require('fs');
const PORT = 15600;
process.env.PORT = String(PORT); process.env.PUBLIC_URL = 'https://fiti.test';
// A developer may run the complete app and legacy compatibility routes on
// one host. Keep this explicit in the test so a business-page redirect cannot
// accidentally point back to the very same URL forever.
process.env.APP_URL = 'https://fiti.test'; process.env.LEGACY_HOST = 'fiti.test';
process.env.MARKETING_URL = 'https://marketing.fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k'; process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379'; process.env.MPESA_PASSKEY = 'p';
process.env.PROVISION_MODE = 'poll'; process.env.SITE_TOKEN = 'business-test-token';
process.env.DATABASE_PATH = '/tmp/business-test.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + s); } catch {} }
require('../src/server');
const call = (path, body, token) => fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST',
  headers: Object.assign({'Content-Type':'application/json'}, token ? {Authorization:`Bearer ${token}`} : {}),
  body: JSON.stringify(body || {}) }).then(async r => ({ status:r.status, body:await r.json() }));
(async () => {
  await new Promise(r => setTimeout(r, 200));
  const sameHostBusinessPage = await fetch(`http://127.0.0.1:${PORT}/business.html`, {
    headers: { Host: 'fiti.test' }, redirect: 'manual',
  });
  assert.strictEqual(sameHostBusinessPage.status, 200,
    'a single-host local deployment must serve the dashboard instead of redirecting to itself');
  const created = await call('/api/business/register', {name:'North Star WiFi',ownerName:'Amina',phone:'0712345678',email:'amina@example.test',password:'securepass',plan:'starter',collectionMode:'own'});
  assert.strictEqual(created.status, 201); assert.ok(created.body.token);
  assert.strictEqual(created.body.onboarding.organisationComplete, true);
  const token = created.body.token;
  const location = await call('/api/business/locations',{name:'Kitale One',routerName:'RB951Ui'},token);
  assert.strictEqual(location.status,201); assert.ok(location.body.location.routerToken);
  const pkg = await call('/api/business/packages',{name:'Three hours',price:20,hours:3},token);
  assert.strictEqual(pkg.status,201); assert.strictEqual(pkg.body.packages.length,1);
  const plan = await call('/api/business/billing-plan',{plan:'growth',collectionMode:'fiti'},token);
  assert.strictEqual(plan.status,200); assert.strictEqual(plan.body.checkoutRequired,true); assert.strictEqual(plan.body.amount,3500);
  const login = await call('/api/business/login',{email:'amina@example.test',password:'securepass'});
  assert.strictEqual(login.status,200); assert.ok(login.body.token);

  // A new trial account may now be created with account credentials only.
  // It is intentionally prevented from issuing a router token until the
  // owner completes the small, authenticated organisation form.
  const trial = await call('/api/business/register', {
    email:'trial@example.test', password:'another-secure-password',
  });
  assert.strictEqual(trial.status, 201);
  assert.strictEqual(trial.body.onboarding.organisationComplete, false);
  assert.strictEqual(trial.body.onboarding.nextStep, 'organisation');
  const trialToken = trial.body.token;
  const blocked = await call('/api/business/locations', { location:'Trial location', routerName:'hAP lite' }, trialToken);
  assert.strictEqual(blocked.status, 409, 'a pending account cannot mint router pairing credentials');
  const organisation = await call('/api/business/organisation', {
    organisationName:'Trial Connect', phone:'0712345679', hotspotName:'Trial Connect WiFi',
  }, trialToken);
  assert.strictEqual(organisation.status, 200);
  assert.strictEqual(organisation.body.business.name, 'Trial Connect');
  assert.strictEqual(organisation.body.business.owner_phone, '254712345679');
  assert.strictEqual(organisation.body.business.hotspot_name, 'Trial Connect WiFi');
  assert.strictEqual(organisation.body.onboarding.nextStep, 'router');
  const routerDraft = await call('/api/business/locations', {
    location:'Trial Main', routerName:'RB951Ui',
  }, trialToken);
  assert.strictEqual(routerDraft.status, 201);
  assert.strictEqual(routerDraft.body.draft, true);
  assert.strictEqual(routerDraft.body.location.name, 'Trial Main');
  assert.strictEqual(routerDraft.body.location.routerName, 'RB951Ui');
  assert.strictEqual(routerDraft.body.onboarding.nextStep, 'setup');
  console.log('business onboarding: ok');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});

const assert = require('assert');
const fs = require('fs');
const PORT = 15600;
process.env.PORT = String(PORT); process.env.PUBLIC_URL = 'https://fiti.test';
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
  const created = await call('/api/business/register', {name:'North Star WiFi',ownerName:'Amina',phone:'0712345678',email:'amina@example.test',password:'securepass'});
  assert.strictEqual(created.status, 201); assert.ok(created.body.token);
  const token = created.body.token;
  const location = await call('/api/business/locations',{name:'Kitale One',routerName:'RB951Ui'},token);
  assert.strictEqual(location.status,201); assert.ok(location.body.location.routerToken);
  const pkg = await call('/api/business/packages',{name:'Three hours',price:20,hours:3},token);
  assert.strictEqual(pkg.status,201); assert.strictEqual(pkg.body.packages.length,1);
  const login = await call('/api/business/login',{email:'amina@example.test',password:'securepass'});
  assert.strictEqual(login.status,200); assert.ok(login.body.token);
  console.log('business onboarding: ok');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});

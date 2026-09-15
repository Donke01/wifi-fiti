const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const p = '/tmp/admin-control-plane.sqlite'; for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(p + s); } catch (_) {}
process.env.PUBLIC_URL='https://fiti.test'; process.env.MPESA_CONSUMER_KEY='k'; process.env.MPESA_CONSUMER_SECRET='s'; process.env.MPESA_SHORTCODE='1'; process.env.MPESA_PASSKEY='p'; process.env.DATABASE_PATH=p; process.env.ADMIN_CONFIRMATION_PHRASE='CONFIRM-ADMIN';
const store = require('../src/lib/db'); const tenant = require('../src/lib/tenant');
store.db.prepare(`INSERT INTO businesses(id,name,owner_name,owner_phone,email,password_hash) VALUES(?,?,?,?,?,?)`).run('b1','Tenant','Owner','+254700000000','a@example.com','hash');
store.db.prepare(`INSERT INTO tenant_subscriptions(id,business_id,location_id,router_username,payer_phone,mac,password,total_seconds,expires_at) VALUES(?,?,?,?,?,?,?, ?,datetime('now','+1 day'))`).run('s1','b1','loc1','u1','+254700000000','AA:BB:CC:DD:EE:FF','PW',100);
const { attachAdminControlPlane } = require('../src/lib/admin-control-plane'); const app=express(); app.use(express.json()); attachAdminControlPlane(app,{db:store,tenant,adminOk:r=>r.headers['x-admin-token']==='ok'}); const server=http.createServer(app);
server.listen(0, async()=>{const base=`http://127.0.0.1:${server.address().port}`; const call=(path,o={},csv=false)=>fetch(base+path,{...o,headers:{'x-admin-token':'ok','content-type':'application/json',...(o.headers||{})}}).then(async r=>({status:r.status,body:csv?await r.text():await r.json()})); try {
  let r=await call('/api/admin/control-plane/tenants/b1/billing',{method:'PATCH',body:JSON.stringify({plan:'pro',confirmation:'CONFIRM-ADMIN'})}); assert.strictEqual(r.body.tenant.plan,'pro');
  r=await call('/api/admin/control-plane/tenants/b1/revoke-sessions',{method:'POST',body:JSON.stringify({})}); assert.strictEqual(r.status,400);
  r=await call('/api/admin/control-plane/subscriptions/s1/device',{method:'POST',body:JSON.stringify({confirmation:'CONFIRM-ADMIN',mac:'11:22:33:44:55:66'})}); assert.strictEqual(r.body.subscription.mac,'11:22:33:44:55:66');
  r=await call('/api/admin/control-plane/audit.csv',{},true); assert.strictEqual(r.status,200); assert.ok(r.body.includes('tenant_billing_change'));
  console.log('Admin control plane: billing, confirmation, device override and audit export tests passed');
} catch(e){console.error(e);process.exitCode=1} finally{server.close()}});

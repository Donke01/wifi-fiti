'use strict';
const assert = require('node:assert/strict');
const { reconnectCandidates, optedIn, markAttempt } = require('../src/lib/router-reconnect');
const location = { id: 'loc-test' }, now = Date.now();
const paid = { location_id: location.id, mac: 'AA:BB:CC:DD:EE:01', router_username:'254712345678',
  password:'TEST-ONLY', device_type:'phone', total_seconds: 3600,
  expires_at:new Date(now+3600000).toISOString().replace('T',' ').replace(/\.\d{3}Z$/, '') };
const report = { devices: [{ mac: paid.mac, ip:'10.5.50.34' }], sessions:[] };
const get = (id,mac)=>id===location.id&&mac===paid.mac?paid:null;
assert.equal(optedIn(location.id, ''), false, 'feature off by default');
assert.equal(optedIn(location.id, 'loc-other,loc-test'), true);
assert.equal(reconnectCandidates({location,report,findSubscription:get,now,enabled:false}).length,0);
assert.equal(reconnectCandidates({location,report,findSubscription:get,now,enabled:true}).length,1);
assert.equal(reconnectCandidates({location,report:{...report,sessions:[{mac:paid.mac}]},findSubscription:get,now,enabled:true}).length,0,'no repeated login if already active');
assert.equal(reconnectCandidates({location,report:{devices:[{mac:paid.mac,ip:'192.168.0.999'}]},findSubscription:get,now,enabled:true}).length,0);
assert.equal(reconnectCandidates({location,report,findSubscription:()=>({...paid,expires_at:new Date(now-1000).toISOString()}),now,enabled:true}).length,0,'expired package must not reconnect');
assert.equal(reconnectCandidates({location,report,findSubscription:()=>({...paid,device_type:'tv'}),now,enabled:true}).length,0,'TV cannot enter phone reconnect');
assert.equal(reconnectCandidates({location,report,findSubscription:()=>({...paid,mac:'AA:BB:CC:DD:EE:99'}),now,enabled:true}).length,0,'wrong MAC denied');
assert.equal(reconnectCandidates({location,report,findSubscription:()=>({...paid,location_id:'loc-other'}),now,enabled:true}).length,0,'different location denied');
assert.equal(reconnectCandidates({location,report,findSubscription:get,now,enabled:true}).length,1);
markAttempt('loc-test:'+paid.mac,now);
assert.equal(reconnectCandidates({location,report,findSubscription:get,now:now+1000,enabled:true}).length,0,'cooldown avoids poll flooding');
assert.equal(reconnectCandidates({location,report,findSubscription:get,now:now+91000,enabled:true}).length,1,'retry after cooldown');
console.log('Router-verified reconnect candidate checks passed.');

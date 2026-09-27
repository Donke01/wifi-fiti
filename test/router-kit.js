'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compatibilityRouterKit, vlanTestRouterKit } = require('../src/lib/router-kit');

const standard = fs.readFileSync(path.join(__dirname, '../public/tenant-router-install.rsc'), 'utf8');
const compat = compatibilityRouterKit(standard);

assert.ok(standard.length > 1000, 'the production router kit must be present');
assert.ok(compat.includes('tenant-router-install-compat.rsc') || !standard.includes('tenant-router-install.rsc'));
assert.ok(!compat.includes('check-certificate=yes'), 'CA kit must not retain certificate checks');
assert.strictEqual(
  compat.replace(/check-certificate=no/g, 'check-certificate=yes').replace(/tenant-router-install-compat\.rsc/g, 'tenant-router-install.rsc'),
  standard,
  'CA kit must be exactly the current production kit apart from TLS compatibility'
);
console.log('router-kit parity tests passed');

const vlan = vlanTestRouterKit(standard);
assert.ok(vlan.startsWith(standard.trimEnd()), 'VLAN kit must preserve the stable kit exactly');
assert.ok(vlan.includes('fiti-vlan-management') && vlan.includes('vlan-id=10'));
assert.ok(vlan.includes('fiti-vlan-hotspot') && vlan.includes('vlan-id=20'));
assert.ok(vlan.includes('fiti-vlan-pppoe') && vlan.includes('vlan-id=30'));
assert.ok(vlan.includes('fiti-vlan-tv') && vlan.includes('vlan-id=40'));
assert.ok(vlan.includes('disabled=yes'), 'VLAN test interfaces must be staged safely');
console.log('VLAN kit isolation tests passed');

const customVlan = vlanTestRouterKit(standard, { baseId: 51 });
assert.ok(customVlan.includes('vlan-id=51') && customVlan.includes('vlan-id=52'));
assert.ok(customVlan.includes('vlan-id=53') && customVlan.includes('vlan-id=54'));
assert.ok(customVlan.includes('VLAN 51 is already used'), 'custom VLAN kit must include collision checks');
assert.throws(() => vlanTestRouterKit(standard, { baseId: 4093 }), /VLAN IDs must be integers/);
assert.ok(customVlan.startsWith(standard.trimEnd()), 'custom VLAN kit must preserve stable source exactly');
console.log('custom VLAN staging tests passed');

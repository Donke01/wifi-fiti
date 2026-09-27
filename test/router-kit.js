'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compatibilityRouterKit, vlanTestRouterKit, vlanOverlayRouterKit } = require('../src/lib/router-kit');

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
assert.ok(customVlan.includes('/ip dhcp-client find where status=bound'), 'VLAN kit must detect DHCP WANs');
assert.ok(customVlan.includes('/interface pppoe-client find where running=yes'), 'VLAN kit must detect PPPoE WANs');
assert.ok(customVlan.includes('/interface lte find where running=yes'), 'VLAN kit must guard LTE WAN detection');
assert.ok(customVlan.includes('gateway-interface'), 'VLAN kit must prefer the route gateway interface');
console.log('custom VLAN staging tests passed');

const overlayPlan = vlanOverlayRouterKit(standard, { baseId: 51, trunk: 'ether1', activate: false });
assert.ok(overlayPlan.startsWith(standard.trimEnd()), 'overlay kit must preserve the stable source exactly');
assert.ok(overlayPlan.includes('VLAN overlay preflight passed'));
assert.ok(overlayPlan.includes('Validation-only mode'));
assert.ok(!overlayPlan.includes('vlan-filtering=yes'), 'validation-only overlay must not enable bridge filtering');
const overlayApply = vlanOverlayRouterKit(standard, { baseId: 51, trunk: 'sfp-sfpplus1', nativePorts: 'ether2', accessPorts: 'ether3,ether4', activate: true, subnet: '10.250.52.0/24' });
assert.ok(overlayApply.includes('/interface bridge set $fitiOverlayBridge vlan-filtering=yes'));
assert.ok(overlayApply.includes('Wi-Fi Fiti VLAN overlay tagged trunk 51'));
assert.ok(overlayApply.includes('vlan-id=52') && overlayApply.includes('vlan-id=53'));
assert.ok(overlayApply.includes('untagged=$fitiOverlayNative') && overlayApply.includes('pvid=1'));
assert.ok(overlayApply.includes('Wi-Fi Fiti VLAN overlay stopped'), 'overlay must include a failure path');
assert.throws(() => vlanOverlayRouterKit(standard, { baseId: 51, trunk: 'ether1', activate: true }), /explicit native ports/);
assert.throws(() => vlanOverlayRouterKit(standard, { baseId: 51, trunk: 'ether1', subnet: '192.0.2.0/24' }), /private \/24/);
console.log('VLAN overlay tests passed');

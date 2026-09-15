'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compatibilityRouterKit } = require('../src/lib/router-kit');

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

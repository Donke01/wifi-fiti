/* node test/tuma-extra.js - more than one Tuma settlement account. */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.TENANT_SECRETS_KEY = 'tuma-extra-test-key';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-tuma-extra-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
const tenant = require('../src/lib/tenant');
const paymentIntegrations = require('../src/lib/payment-integrations');
const { createTumaTenants } = require('../src/lib/tuma-tenants');
const { createPaymentMethods } = require('../src/lib/payment-methods');

// A stand-in for Tuma's API: records what Wi-Fi Fiti asked it to do.
const calls = [];
let created = 0;
const tuma = {
  credentialsConfigured: () => true,
  banks: async () => [{ id: 'till', name: 'M-Pesa Till', code: 'BUYGOODS', kind: 'till' }, { id: 'paybill', name: 'M-Pesa PayBill', code: 'PAYBILL', kind: 'paybill' }, { id: 'b-eq', name: 'Equity Bank', code: '68', kind: 'bank' }],
  createBusiness: async (fields) => { calls.push(['create', fields.accountNumber]); created += 1; return { id: `tb-${created}`, email: fields.email, apiKey: `api-key-${created}-0123456789abcdef` }; },
  updateBusiness: async (id, fields) => { calls.push(['update', id, fields]); return {}; },
  verify: async () => true,
  forgetToken: () => {},
};
const tumaTenants = createTumaTenants({ db: legacy.db, tuma, encrypt: tenant.encryptSecret, decrypt: tenant.decryptSecret, logoUrlFor: () => null, log: { error() {} } });
const methods = createPaymentMethods({ db: legacy.db, tenant, paymentIntegrations,
  tumaConnected: (id) => tumaTenants.routable(id), tumaExtras: tumaTenants });

let pass = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 3).join('\n       ')}`); process.exitCode = 1; }
}

(async () => {
  console.log('More Tuma accounts');
  legacy.addBusiness.run({ id: 'biz-t', name: 'Tuma Biz', ownerName: 'Owner', ownerPhone: '254712345678',
    email: 'owner@fiti.test', passwordHash: 'x', plan: 'starter', collectionMode: 'fiti' });
  const business = legacy.businessById.get('biz-t');
  tenant.createLocation({ id: 'loc-t1', businessId: 'biz-t', name: 'Kitale' });
  tenant.createLocation({ id: 'loc-t2', businessId: 'biz-t', name: 'Eldoret' });
  const owner = { destinationType: 'till', accountNumber: '123456', settlementName: 'Morgan James Mfo', mobile: '0712345678' };

  await t('extra accounts need the main Tuma account first', async () => {
    await assert.rejects(tumaTenants.addExtra(business, owner), (error) => error.status === 409 && /main Tuma/.test(error.message));
  });

  let extra;
  await t('an extra account is its own Tuma sub-business; the main one is untouched', async () => {
    await tumaTenants.saveSettlement(business, owner);
    extra = await tumaTenants.addExtra(business, { ...owner, destinationType: 'bank', bankId: 'b-eq', accountNumber: '0123456789', label: 'Eldoret bank' });
    assert.match(extra.id, /^tma-[a-f0-9]{16}$/);
    assert.strictEqual(extra.label, 'Eldoret bank');
    assert.deepStrictEqual(calls.filter((call) => call[0] === 'create').map((call) => call[1]), ['123456', '0123456789']);
    assert.strictEqual(tumaTenants.credentialsFor('biz-t').apiKey, 'api-key-1-0123456789abcdef');
    assert.strictEqual(tumaTenants.extraCredentials('biz-t', extra.id).apiKey, 'api-key-2-0123456789abcdef');
    const stored = legacy.db.prepare('SELECT api_key_cipher, account_cipher FROM tenant_tuma_extra_accounts WHERE id=?').get(extra.id);
    assert.ok(!stored.api_key_cipher.includes('api-key-2') && !stored.account_cipher.includes('0123456789'), 'secrets are encrypted');
  });

  await t('each router can settle to a different Tuma account', async () => {
    const list = methods.methodsFor('biz-t').map((item) => item.id);
    assert.deepStrictEqual(list, ['fiti', 'tuma', 'tuma:' + extra.id]);
    methods.setRouterMethod(tenant.locationById.get('loc-t2'), 'tuma:' + extra.id);
    methods.setRouterMethod(tenant.locationById.get('loc-t1'), 'tuma');
    const eldoret = methods.resolve(tenant.locationById.get('loc-t2'));
    assert.strictEqual(eldoret.kind, 'tuma'); assert.strictEqual(eldoret.accountId, extra.id);
    const kitale = methods.resolve(tenant.locationById.get('loc-t1'));
    assert.strictEqual(kitale.kind, 'tuma'); assert.strictEqual(kitale.accountId, undefined);
  });

  await t('a linked Tuma account can be added as well', async () => {
    const linked = await tumaTenants.addExtra(business, { mode: 'linked', email: 'mine@tuma.test', apiKey: 'my-own-api-key-123456' });
    assert.strictEqual(linked.mode, 'linked');
    assert.strictEqual(tumaTenants.extraCredentials('biz-t', linked.id).email, 'mine@tuma.test');
  });

  await t('trial switch-off covers extras, and they come back when entitled', async () => {
    await tumaTenants.sweep({ isDormant: () => true, isEntitled: () => false });
    assert.strictEqual(tumaTenants.extraCredentials('biz-t', extra.id), null, 'a switched-off account is not used');
    assert.strictEqual(methods.resolve(tenant.locationById.get('loc-t2')).accountId, extra.id, 'the router keeps its choice while switched off');
    assert.ok(await tumaTenants.resumeExtraIfSuspended('biz-t', extra.id, () => true));
    assert.ok(tumaTenants.extraCredentials('biz-t', extra.id));
    await tumaTenants.resumeIfSuspended('biz-t', () => true);
  });

  await t('removing an extra switches it off at Tuma and moves its routers to the default', async () => {
    const tumaId = legacy.db.prepare('SELECT tuma_business_id FROM tenant_tuma_extra_accounts WHERE id=?').get(extra.id).tuma_business_id;
    await tumaTenants.removeExtra('biz-t', extra.id);
    assert.ok(calls.some((call) => call[0] === 'update' && call[1] === tumaId && call[2].active === false));
    assert.strictEqual(methods.detach('biz-t', 'tuma:' + extra.id).length, 1);
    assert.ok(!methods.methodsFor('biz-t').some((item) => item.id === 'tuma:' + extra.id));
    assert.strictEqual(methods.resolve(tenant.locationById.get('loc-t2')).source, 'legacy');
    await assert.rejects(tumaTenants.removeExtra('biz-t', extra.id), (error) => error.status === 404);
  });

  await t("another business cannot use these accounts", async () => {
    assert.strictEqual(tumaTenants.extraCredentials('biz-other', extra.id), null);
    assert.strictEqual(methods.usable('biz-other', 'tuma:' + extra.id), null);
  });

  console.log(`\n${pass} passed`);
})();

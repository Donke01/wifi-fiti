/* node test/payment-methods.js - many payment methods, one per router. */
const assert = require('assert');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.TENANT_SECRETS_KEY = 'payment-methods-test-key';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-payment-methods-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
const tenant = require('../src/lib/tenant');
const paymentIntegrations = require('../src/lib/payment-integrations');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.stack.split('\n').slice(0, 3).join('\n       ')}`); process.exitCode = 1; }
}
const throwsWith = (fn, status, pattern) => assert.throws(fn, (error) => error.status === status && pattern.test(error.message));

console.log('Payment methods');

const addBusiness = (id, mode) => legacy.addBusiness.run({ id, name: id, ownerName: 'Owner', ownerPhone: '254700000000',
  email: `${id}@fiti.test`, passwordHash: 'x', plan: 'starter', collectionMode: mode });
addBusiness('biz-own', 'own');
addBusiness('biz-fiti', 'fiti');
addBusiness('biz-other', 'fiti');
// A Till connected with the older one-account screen, before payment methods.
tenant.savePaymentConnection({ businessId: 'biz-own', collectionName: 'Main Till', shortcode: '123456',
  transactionType: 'CustomerBuyGoodsOnline', consumerKey: 'key-old', consumerSecret: 'secret-old', passkey: 'pass-old', verified: true });
const kitale = tenant.createLocation({ id: 'loc-kitale', businessId: 'biz-own', name: 'Kitale' }) || { id: 'loc-kitale' };
const eldoret = tenant.createLocation({ id: 'loc-eldoret', businessId: 'biz-own', name: 'Eldoret' }) || { id: 'loc-eldoret' };
tenant.createLocation({ id: 'loc-fiti', businessId: 'biz-fiti', name: 'Fiti spot' });
tenant.createLocation({ id: 'loc-other', businessId: 'biz-other', name: 'Other' });

let tumaOn = false;
const { createPaymentMethods } = require('../src/lib/payment-methods');
const methods = createPaymentMethods({ db: legacy.db, tenant, paymentIntegrations, tumaConnected: () => tumaOn });
const loc = (id) => tenant.locationById.get(id);

t('existing businesses keep their old payment path', () => {
  const own = methods.resolve(loc('loc-kitale'));
  assert.strictEqual(own.kind, 'daraja'); assert.strictEqual(own.source, 'legacy'); assert.strictEqual(own.shortcode, '123456');
  assert.strictEqual(methods.credentialsFor('biz-own', own.accountId).consumerKey, 'key-old');
  const fiti = methods.resolve(loc('loc-fiti'));
  assert.strictEqual(fiti.kind, 'fiti'); assert.strictEqual(fiti.source, 'legacy');
});

let paybill;
t('a business can add more Till / PayBill accounts', () => {
  paybill = methods.addAccount('biz-own', { label: 'Eldoret PayBill', shortcode: '555111', transactionType: 'CustomerPayBillOnline',
    consumerKey: 'key-2', consumerSecret: 'secret-2', passkey: 'pass-2' });
  methods.addAccount('biz-own', { label: '', shortcode: '777888', transactionType: 'CustomerPayBillOnline',
    consumerKey: 'key-3', consumerSecret: 'secret-3', passkey: 'pass-3' });
  const list = methods.methodsFor('biz-own');
  assert.deepStrictEqual(list.map((item) => item.kind), ['fiti', 'daraja', 'daraja', 'daraja']);
  assert.deepStrictEqual(list.slice(1).map((item) => item.label), ['Main Till', 'Eldoret PayBill', 'PayBill 777888']);
  const stored = legacy.db.prepare('SELECT consumer_key_cipher, passkey_cipher FROM tenant_mpesa_accounts WHERE id=?').get(paybill.accountId);
  assert.ok(!stored.consumer_key_cipher.includes('key-2') && !stored.passkey_cipher.includes('pass-2'), 'secrets are encrypted at rest');
  assert.ok(!JSON.stringify(list).includes('key-2'), 'secrets never appear in the list');
});

t('adding the same Till / PayBill again replaces its keys, not a duplicate', () => {
  methods.addAccount('biz-own', { shortcode: '555111', transactionType: 'CustomerPayBillOnline',
    consumerKey: 'key-2b', consumerSecret: 'secret-2b', passkey: 'pass-2b' });
  assert.strictEqual(methods.methodsFor('biz-own').length, 4);
  assert.strictEqual(methods.credentialsFor('biz-own', paybill.accountId).consumerKey, 'key-2b');
});

t('each router can use its own method; others use the default', () => {
  methods.setRouterMethod(loc('loc-eldoret'), paybill.id);
  const eldoretMethod = methods.resolve(loc('loc-eldoret'));
  assert.strictEqual(eldoretMethod.id, paybill.id); assert.strictEqual(eldoretMethod.source, 'router');
  assert.strictEqual(methods.resolve(loc('loc-kitale')).source, 'legacy');
  methods.setDefault('biz-own', 'fiti');
  const kitaleMethod = methods.resolve(loc('loc-kitale'));
  assert.strictEqual(kitaleMethod.kind, 'fiti'); assert.strictEqual(kitaleMethod.source, 'default');
  assert.strictEqual(methods.resolve(loc('loc-eldoret')).id, paybill.id, 'a router choice beats the default');
  methods.setRouterMethod(loc('loc-eldoret'), null);
  assert.strictEqual(methods.resolve(loc('loc-eldoret')).source, 'default', 'clearing it returns to the default');
});

t("one business cannot use another business's account", () => {
  throwsWith(() => methods.setRouterMethod(loc('loc-other'), paybill.id), 400, /Choose one of your payment methods/);
  throwsWith(() => methods.setDefault('biz-other', paybill.id), 400, /Choose one/);
  assert.strictEqual(methods.credentialsFor('biz-other', paybill.accountId), null);
  throwsWith(() => methods.setRouterMethod(loc('loc-kitale'), 'daraja:../../x'), 400, /Choose one/);
});

t('Tuma is offered only once connected', () => {
  throwsWith(() => methods.setDefault('biz-own', 'tuma'), 400, /Choose one/);
  tumaOn = true;
  assert.ok(methods.methodsFor('biz-own').some((item) => item.id === 'tuma'));
  methods.setRouterMethod(loc('loc-kitale'), 'tuma');
  assert.strictEqual(methods.resolve(loc('loc-kitale')).kind, 'tuma');
  tumaOn = false;
  assert.strictEqual(methods.resolve(loc('loc-kitale')).source, 'default', 'a disconnected Tuma falls back to the default');
  methods.setRouterMethod(loc('loc-kitale'), null);
});

t('removing an account moves its routers to the default and clears it as default', () => {
  methods.setRouterMethod(loc('loc-eldoret'), paybill.id);
  methods.setDefault('biz-own', paybill.id);
  const result = methods.removeMethod('biz-own', paybill.id);
  assert.strictEqual(result.routersMoved, 1);
  assert.strictEqual(methods.overview('biz-own', [loc('loc-eldoret')]).defaultMethod, null);
  assert.strictEqual(methods.resolve(loc('loc-eldoret')).source, 'legacy');
  assert.ok(!methods.methodsFor('biz-own').some((item) => item.id === paybill.id));
  throwsWith(() => methods.removeMethod('biz-own', 'fiti'), 400, /Only your own/);
});

t('a payment is checked with the account it was taken with, even after removal', () => {
  tenant.insertTransaction.run({ checkoutRequestId: 'ws_PM1', merchantRequestId: 'm', businessId: 'biz-own', locationId: 'loc-eldoret',
    phone: '254712345678', packageId: 1, packageName: '1 hour', amount: 20, seconds: 3600, rateLimit: null, mac: 'AA:BB:CC:00:00:01', ip: null });
  methods.recordTransactionMethod('ws_PM1', paybill.id);
  const transaction = tenant.getTransaction.get('ws_PM1');
  assert.strictEqual(transaction.payment_method, paybill.id);
  assert.strictEqual(methods.credentialsForTransaction(transaction).consumerKey, 'key-2b');
  // Older payments, with no method recorded, use the older single connection.
  assert.strictEqual(methods.credentialsForTransaction({ business_id: 'biz-own', payment_method: null }).consumerKey, 'key-old');
});

t('removing the older connected Till does not come back on restart', () => {
  const main = methods.methodsFor('biz-own').find((item) => item.label === 'Main Till');
  methods.removeMethod('biz-own', main.id);
  const again = createPaymentMethods({ db: legacy.db, tenant, paymentIntegrations, tumaConnected: () => false });
  assert.ok(!again.methodsFor('biz-own').some((item) => item.label === 'Main Till'));
});

t('the overview lists every router with what it uses', () => {
  methods.setDefault('biz-own', 'fiti');
  const view = methods.overview('biz-own', [loc('loc-kitale'), loc('loc-eldoret')]);
  assert.deepStrictEqual(view.routers.map((router) => [router.name, router.effective.kind, router.effective.source]),
    [['Kitale', 'fiti', 'default'], ['Eldoret', 'fiti', 'default']]);
  assert.strictEqual(view.methods.find((item) => item.id === 'fiti').isDefault, true);
});

console.log(`\n${pass} passed`);

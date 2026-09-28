/* PPPoE customer billing: installation fee, credit, prepaid days, grace, plan
 * changes, 24-hour boosts, held payments while the owner's plan has lapsed,
 * reversals, reminders, private links and the router side of each. */
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiti-pppoe-billing-'));
Object.assign(process.env, { PUBLIC_URL: 'https://fiti.test', APP_URL: 'https://cloud.fiti.test', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's',
  MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p', TENANT_SECRETS_KEY: 'pppoe-billing-key', DATABASE_PATH: path.join(dir, 't.db') });
const { db } = require('../src/lib/db');
const pppoe = require('../src/lib/pppoe');
const billing = require('../src/lib/pppoe-billing');

const DAY = 86400_000;
const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const T0 = Date.now();
db.prepare(`INSERT INTO businesses(id,name,owner_name,owner_phone,email,password_hash,billing_status,pppoe_billing_expires_at,pppoe_users,portal_name)
  VALUES('b1','Kitale Net','O','254700000000','b@x.test','h','active',?,50,'Kitale WiFi')`).run(sql(T0 + 60 * DAY));
db.prepare(`INSERT INTO locations(id,business_id,name,router_token,customer_bridge) VALUES('l1','b1','Kitale','rt1','bridge-pppoe')`).run();
const home = pppoe.profileCreate({ businessId: 'b1', name: 'Home', downloadRate: '10M', uploadRate: '5M' });
const fast = pppoe.profileCreate({ businessId: 'b1', name: 'Fast', downloadRate: '20M', uploadRate: '10M' });
const basic = pppoe.profileCreate({ businessId: 'b1', name: 'Basic', downloadRate: '5M', uploadRate: '2M' });
billing.updatePlan('b1', home.id, { price: 1500 });
billing.updatePlan('b1', fast.id, { price: 2500, boostPrice: 100 });
billing.updatePlan('b1', basic.id, { price: 1000 });
assert.throws(() => billing.updatePlan('b1', home.id, { price: 12.5 }), /whole number/);
assert.throws(() => billing.updatePlan('other', home.id, { price: 10 }), /not found/);

// ---- A new subscriber on a priced plan waits for the first payment -------
let user = pppoe.userCreate({ businessId: 'b1', locationId: 'l1', profileId: home.id, username: 'jane.w', secret: 'a-secure-secret' });
user = billing.setupNewSubscriber(user, { phone: '0712345678', fullName: 'Jane Wanjiku', installFee: 2000 });
assert.equal(user.status, 'awaiting_payment');
assert.equal(user.phone, '254712345678');
let state = billing.accountState(user, { now: T0 });
assert.equal(state.status, 'awaiting_payment');
assert.equal(state.amountDue, 3500, 'installation fee plus the first month');
assert.equal(billing.maskName('Jane Wanjiku'), 'J*** W******');

const jobs = () => db.prepare(`SELECT * FROM pppoe_jobs WHERE user_id=? ORDER BY created_at`).all(user.id);
let r = billing.applyPayment({ userId: user.id, amount: 2000, method: 'cash', now: T0 });
assert.equal(r.payment.to_install, 2000); assert.equal(r.user.install_fee_due, 0); assert.equal(r.user.credit, 0);
assert.equal(r.user.status, 'awaiting_payment', 'the installation fee alone starts nothing');
r = billing.applyPayment({ userId: user.id, amount: 1000, method: 'cash', now: T0 });
assert.equal(r.user.credit, 1000); assert.equal(r.days, 0, 'a short payment is kept as credit');
assert.equal(jobs().length, 0, 'nothing goes to the router before days are paid');
r = billing.applyPayment({ userId: user.id, amount: 500, method: 'mpesa', receipt: 'QJK4X7T2LM', checkoutRequestId: 'ws_1', now: T0 });
assert.equal(r.days, 30); assert.equal(r.user.credit, 0); assert.equal(r.user.status, 'active');
assert.equal(Date.parse(r.user.paid_until), T0 + 30 * DAY);
assert.equal(Date.parse(r.user.expires_at), T0 + 33 * DAY, 'access runs three grace days past paid-until');
assert.equal(jobs().length, 1); assert.equal(jobs()[0].action, 'upsert');
// Replays: the same checkout is applied once; a typed receipt that exists is refused.
assert.equal(billing.applyPayment({ userId: user.id, amount: 500, method: 'mpesa', receipt: 'QJK4X7T2LM', checkoutRequestId: 'ws_1', now: T0 }).duplicate, true);
assert.throws(() => billing.applyPayment({ userId: user.id, amount: 500, method: 'mpesa_owner', receipt: 'qjk4x7t2lm', now: T0 }), (e) => e.status === 409);
assert.equal(billing.userFor('b1', user.id).credit, 0);

// Paying ahead continues from paid-until; the change is kept as credit.
r = billing.applyPayment({ userId: user.id, amount: 2000, method: 'cash', now: T0 + DAY });
assert.equal(Date.parse(r.user.paid_until), T0 + 60 * DAY); assert.equal(r.user.credit, 500);

// ---- Grace and expiry ----------------------------------------------------
const paidUntil = T0 + 60 * DAY;
assert.equal(billing.accountState(r.user, { now: paidUntil - 2 * DAY }).status, 'due');
assert.equal(billing.accountState(r.user, { now: paidUntil + DAY }).status, 'grace');
assert.equal(billing.accountState(r.user, { now: paidUntil + 4 * DAY }).status, 'expired');
assert.equal(billing.accountState(r.user, { now: paidUntil - 2 * DAY }).amountDue, 1000, 'credit lowers what renews it');
// Paying during grace continues from paid-until (grace is borrowed).
r = billing.applyPayment({ userId: user.id, amount: 1000, method: 'cash', now: paidUntil + DAY });
assert.equal(Date.parse(r.user.paid_until), paidUntil + 30 * DAY); assert.equal(r.user.credit, 0);
// After access ended, a payment counts from the moment it arrives.
db.prepare(`UPDATE pppoe_users SET status='expired' WHERE id=?`).run(user.id);
const late = paidUntil + 30 * DAY + 5 * DAY;
r = billing.applyPayment({ userId: user.id, amount: 1500, method: 'cash', now: late });
assert.equal(Date.parse(r.user.paid_until), late + 30 * DAY); assert.equal(r.user.status, 'active');
assert.equal(jobs().at(-1).reconnect, 1, 'a returning customer is reconnected (leaves the expired profile)');

// ---- Grace setting ------------------------------------------------------
billing.saveSettings('b1', { graceDays: 5 });
assert.equal(Date.parse(billing.userFor('b1', user.id).expires_at), late + 35 * DAY);
assert.throws(() => billing.saveSettings('b1', { graceDays: 9 }), /0 to 7/);
billing.saveSettings('b1', { graceDays: 3 });

// ---- Plan changes -------------------------------------------------------
const now = late + 10 * DAY; // 20 days left of Home (1,500 / 30 days)
user = billing.userFor('b1', user.id);
db.prepare('UPDATE pppoe_users SET credit=500 WHERE id=?').run(user.id); user = billing.userFor('b1', user.id);
const up = billing.changeQuote(user, fast.id, { timing: 'now', useCredit: true, now });
assert.equal(up.daysLeft, 20); assert.equal(up.difference, 667, '(2500-1500)/30 per day for 20 days');
assert.equal(up.fromCredit, 500); assert.equal(up.payNow, 167);
assert.equal(billing.changeQuote(user, fast.id, { timing: 'now', useCredit: false, now }).payNow, 667);
assert.throws(() => billing.changeQuote(user, basic.id, { timing: 'now', now }), /next renewal/);
assert.equal(billing.changeQuote(user, basic.id, { timing: 'renewal', now }).renewal.amount, 500);
// Paying the difference moves the plan now and reconnects.
r = billing.applyPayment({ userId: user.id, amount: 167, method: 'mpesa', purpose: 'upgrade', targetProfileId: fast.id, expected: 167, fromCredit: 500, checkoutRequestId: 'ws_up', now });
assert.equal(r.user.profile_id, fast.id); assert.equal(r.user.credit, 0); assert.equal(r.payment.kind, 'upgrade');
assert.equal(jobs().at(-1).reconnect, 1);
// A short upgrade payment is only credit.
r = billing.applyPayment({ userId: user.id, amount: 50, method: 'mpesa', purpose: 'upgrade', targetProfileId: home.id, expected: 100, checkoutRequestId: 'ws_short', now });
assert.equal(r.user.profile_id, fast.id); assert.equal(r.user.credit, 50); assert.equal(r.payment.kind, 'pay');
// A cheaper plan starts at renewal, then renewals charge its price.
user = billing.scheduleChange(r.user, basic.id);
assert.equal(billing.accountState(user, { now }).amountDue, 950, 'Basic 1,000 less 50 credit');
r = billing.applyPayment({ userId: user.id, amount: 950, method: 'cash', now });
assert.equal(r.user.profile_id, basic.id); assert.equal(r.user.next_profile_id, null); assert.equal(r.days, 30);
assert.equal(r.user.credit, 0);

// ---- Boosts -------------------------------------------------------------
user = r.user;
assert.deepEqual(billing.boostOptions(user).map((p) => p.id), [fast.id]);
r = billing.applyPayment({ userId: user.id, amount: 100, method: 'mpesa', purpose: 'boost', targetProfileId: fast.id, checkoutRequestId: 'ws_boost', now });
assert.equal(r.user.boost_profile_id, fast.id); assert.equal(Date.parse(r.user.boost_until), now + DAY);
let script = pppoe.scriptForLocation('l1', { now: now + 60_000 });
assert.match(script, /rate-limit="10M\/20M"/, 'the router gets the boost speed');
assert.match(script, /profile="fiti-pprof_[a-f0-9]+" disabled=no[^\n]*\/ppp active remove/, 'and drops the session so it applies');
assert.equal(billing.endBoosts(now + DAY + 1), 1);
assert.equal(billing.userFor('b1', user.id).boost_profile_id, null);
assert.equal(jobs().at(-1).reconnect, 1, 'the end of a boost reconnects at the normal speed');

// ---- Owner plan lapsed: payments are held as credit ----------------------
db.prepare(`UPDATE businesses SET pppoe_billing_expires_at=? WHERE id='b1'`).run(sql(T0 - 30 * DAY));
assert.equal(billing.ownerCanServe(db.prepare(`SELECT * FROM businesses WHERE id='b1'`).get()), false);
const u2 = billing.setupNewSubscriber(pppoe.userCreate({ businessId: 'b1', locationId: 'l1', profileId: home.id, username: 'otieno', secret: 'another-secret' }), { phone: '0722118904', fullName: 'Brian Otieno' });
r = billing.applyPayment({ userId: u2.id, amount: 1500, method: 'paybill', receipt: 'PB1', checkoutRequestId: 'c2b_PB1', now: T0 });
assert.equal(r.held, true); assert.equal(r.user.credit, 1500); assert.equal(r.user.status, 'awaiting_payment');
assert.match(billing.receiptView(r.payment).what, /Kept as credit until/);
// The owner renews: the sweep turns the held credit into days.
db.prepare(`UPDATE businesses SET pppoe_billing_expires_at=? WHERE id='b1'`).run(sql(Date.now() + 30 * DAY));
(async () => {
  const counts = await billing.sweep({ now: Date.now() });
  assert.equal(counts.renewedFromCredit, 1);
  const renewed = billing.userFor('b1', u2.id);
  assert.equal(renewed.status, 'active'); assert.equal(renewed.credit, 0);

  // ---- Reversal takes back what the payment gave ------------------------
  const before = billing.userFor('b1', u2.id);
  const extra = billing.applyPayment({ userId: u2.id, amount: 1700, method: 'paybill', receipt: 'PB2', checkoutRequestId: 'c2b_PB2' });
  assert.equal(extra.days, 30); assert.equal(extra.user.credit, 200);
  const back = billing.reverseByReceipt('b1', 'PB2');
  assert.equal(back.paid_until, before.paid_until); assert.equal(back.credit, 0);
  assert.equal(billing.reverseByReceipt('b1', 'PB2'), null, 'a reversal applies once');

  // ---- Reminders --------------------------------------------------------
  const sent = [];
  const send = async (businessId, eventId, to, text) => { sent.push({ eventId, to, text }); return { id: 'sms' }; };
  const due = Date.parse(back.paid_until);
  await billing.sweep({ now: due - 2 * DAY, send });
  assert.equal(sent.length, 1); assert.match(sent[0].text, /is paid until/); assert.match(sent[0].text, /\/pay\/[a-z0-9]+\/otieno\?k=/);
  assert.equal(sent[0].to, '+254722118904');
  await billing.sweep({ now: due - 2 * DAY + 3600_000, send });
  assert.equal(sent.length, 1, 'each reminder goes once');
  await billing.sweep({ now: due + 3600_000, send });
  assert.equal(sent.length, 2); assert.match(sent[1].text, /stays on until/, 'grace is explained');
  billing.saveSettings('b1', { remindAfter: false });
  assert.equal(billing.remindersDue(billing.userFor('b1', u2.id), { now: due + 2 * 3600_000, settings: billing.settingsFor('b1'), business: db.prepare(`SELECT * FROM businesses WHERE id='b1'`).get() }), null);

  // ---- Private link -------------------------------------------------------
  const token = billing.accountToken(u2);
  assert.equal(billing.accountTokenOk(u2, token), true);
  assert.equal(billing.accountTokenOk(u2, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), false);
  assert.equal(billing.accountTokenOk(user, token), false, 'a link opens only its own account');
  const pub = billing.publicAccount(billing.userFor('b1', u2.id));
  assert.equal(pub.maskedName, 'B**** O*****'); assert.equal(pub.name, undefined); assert.equal(pub.receipts, undefined);
  const mine = billing.privateAccount(billing.userFor('b1', u2.id));
  assert.equal(mine.name, 'Brian Otieno'); assert.ok(mine.receipts.length >= 3); assert.equal(mine.phone, '0722 *** 904');
  assert.equal(billing.businessForPayCode(billing.settingsFor('b1').payCode).id, 'b1');
  assert.equal(billing.userByUsername('b1', 'OTIENO').id, u2.id, 'M-Pesa account numbers match whatever the case');

  // ---- Expired pay page on the router (owner setting) -----------------------
  billing.saveSettings('b1', { expiredPage: true });
  db.prepare(`UPDATE pppoe_users SET expires_at=?, paid_until=? WHERE id=?`).run(new Date(Date.now() - 4 * DAY).toISOString(), new Date(Date.now() - 7 * DAY).toISOString(), u2.id);
  script = pppoe.scriptForLocation('l1', { now: Date.now() + 20 * 60_000 });
  assert.equal(billing.userFor('b1', u2.id).status, 'expired');
  assert.match(script, /\/ppp secret set \[find where name="otieno"\] profile="fiti-expired" disabled=no/);
  assert.match(script, /address-list="fiti-pppoe-expired"/);
  assert.match(script, /list="fiti-pay-host" address="cloud\.fiti\.test"/);
  assert.match(script, /action-data=\\"cloud\.fiti\.test\/pay\/[a-z0-9]+\\"/);
  assert.match(script, /redirect-to=\\"cloud\.fiti\.test\/pay\/[a-z0-9]+\\"/);
  assert.match(script, /:error "proxy_in_use"/, 'an owner web proxy on another port is never taken over');
  assert.match(script, /\} else=\{ :do \{ :if \(\[:len \[\/ppp secret find where name="otieno"\]\] > 0\) do=\{ \/ppp secret set \[find where name="otieno"\] disabled=yes \}/, 'without the page, it is cut off as before');
  const open = (script.match(/\{/g) || []).length; const close = (script.match(/\}/g) || []).length;
  assert.equal(open, close, 'balanced RouterOS blocks');
  console.log('PPPoE billing: install fee, credit, days, grace, plan changes, boosts, held payments, reversal, reminders, links, expired page - passed');
})().catch((error) => { console.error(error); process.exit(1); });

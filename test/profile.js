/* node test/profile.js - "My profile" in the business dashboard. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '174379';
process.env.MPESA_PASSKEY = 'p';
process.env.DATABASE_PATH = '/tmp/wifi-fiti-profile-test.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
}

const legacy = require('../src/lib/db');
const team = require('../src/lib/team');
const { createProfile } = require('../src/lib/profile');

// The same scheme as server.js.
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}
function passwordMatches(password, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex'); const actual = crypto.scryptSync(password, salt, 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
const profile = createProfile({ db: legacy.db, hashPassword, passwordMatches, roles: team.ROLES });

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
}
const throwsWith = (fn, status, pattern) => assert.throws(fn, (error) => error.status === status && pattern.test(error.message));

console.log('My profile');

legacy.addBusiness.run({ id: 'biz-pf', name: 'Kitale Cafe', ownerName: 'Morgan', ownerPhone: '254712345678',
  email: 'owner@fiti.test', passwordHash: hashPassword('owner-pass-1'), plan: 'starter', collectionMode: 'fiti' });
legacy.db.prepare(`INSERT INTO business_members (id, business_id, role, name, email, phone, password_hash)
  VALUES ('mem-1', 'biz-pf', 'attendant', 'Jane', 'jane@fiti.test', '254711111111', ?)`).run(hashPassword('jane-pass-1'));
const addSession = legacy.db.prepare(`INSERT INTO business_sessions (token_hash, business_id, member_id, expires_at)
  VALUES (?, 'biz-pf', ?, datetime('now', '+30 days'))`);
['owner-a', 'owner-b', 'owner-c'].forEach((hash) => addSession.run(hash, null));
['jane-a', 'jane-b'].forEach((hash) => addSession.run(hash, 'mem-1'));
const ownerSession = { businessId: 'biz-pf', member: null, role: 'owner' };
const janeSession = () => ({ businessId: 'biz-pf', member: legacy.db.prepare(`SELECT * FROM business_members WHERE id='mem-1'`).get(), role: 'attendant' });
const sessionsLeft = (memberId) => legacy.db.prepare(`SELECT COUNT(*) AS n FROM business_sessions WHERE business_id='biz-pf' AND member_id IS ?`).get(memberId).n;

t('the owner sees their own details, sign-ins and no password hash', () => {
  const view = profile.view(ownerSession, 'biz-pf', 'owner-a');
  assert.strictEqual(view.person.name, 'Morgan');
  assert.strictEqual(view.person.isOwner, true);
  assert.strictEqual(view.person.roleLabel, 'Owner');
  assert.strictEqual(view.business.name, 'Kitale Cafe');
  assert.strictEqual(view.sessions.length, 3);
  assert.strictEqual(view.sessions.filter((item) => item.current).length, 1);
  const hash = legacy.db.prepare(`SELECT password_hash FROM businesses WHERE id='biz-pf'`).get().password_hash;
  assert.ok(!JSON.stringify(view).includes(hash) && !JSON.stringify(view).includes('password_hash'));
});

t('a team member sees only themselves', () => {
  const view = profile.view(janeSession(), 'biz-pf', 'jane-a');
  assert.strictEqual(view.person.name, 'Jane');
  assert.strictEqual(view.person.isOwner, false);
  assert.strictEqual(view.person.roleLabel, 'Attendant');
  assert.strictEqual(view.sessions.length, 2);
  assert.strictEqual(view.business.hotspotName, undefined);
});

t('names are cleaned and saved to the right person', () => {
  assert.strictEqual(profile.rename(ownerSession, 'biz-pf', '  Morgan   Mfo '), 'Morgan Mfo');
  assert.strictEqual(profile.rename(janeSession(), 'biz-pf', 'Jane W'), 'Jane W');
  assert.strictEqual(legacy.db.prepare(`SELECT owner_name FROM businesses WHERE id='biz-pf'`).get().owner_name, 'Morgan Mfo');
  assert.strictEqual(legacy.db.prepare(`SELECT name FROM business_members WHERE id='mem-1'`).get().name, 'Jane W');
  throwsWith(() => profile.rename(ownerSession, 'biz-pf', '   '), 400, /Enter your name/);
  throwsWith(() => profile.rename(ownerSession, 'biz-pf', 'x'.repeat(81)), 400, /too long/);
});

t('a password change needs the right current password and a valid new one', () => {
  throwsWith(() => profile.changePassword(ownerSession, 'biz-pf', 'wrong-pass', 'new-pass-123', 'owner-a'), 403, /not correct/);
  throwsWith(() => profile.changePassword(ownerSession, 'biz-pf', 'owner-pass-1', 'short', 'owner-a'), 400, /at least 8/);
  throwsWith(() => profile.changePassword(ownerSession, 'biz-pf', 'owner-pass-1', 'owner-pass-1', 'owner-a'), 400, /different/);
  throwsWith(() => profile.changePassword(ownerSession, 'biz-pf', '', 'new-pass-123', 'owner-a'), 400, /current password/);
  assert.strictEqual(sessionsLeft(null), 3, 'nothing changed on a failed attempt');
});

t('changing the owner password keeps this device and signs out the others', () => {
  const result = profile.changePassword(ownerSession, 'biz-pf', 'owner-pass-1', 'owner-pass-2', 'owner-a');
  assert.strictEqual(result.signedOutOthers, 2);
  assert.strictEqual(sessionsLeft(null), 1);
  const hash = legacy.db.prepare(`SELECT password_hash FROM businesses WHERE id='biz-pf'`).get().password_hash;
  assert.ok(passwordMatches('owner-pass-2', hash) && !passwordMatches('owner-pass-1', hash));
  assert.strictEqual(sessionsLeft('mem-1'), 2, "the team's sign-ins are untouched");
});

t("a member's password change only touches that member", () => {
  const result = profile.changePassword(janeSession(), 'biz-pf', 'jane-pass-1', 'jane-pass-2', 'jane-a');
  assert.strictEqual(result.signedOutOthers, 1);
  assert.strictEqual(sessionsLeft('mem-1'), 1);
  assert.strictEqual(sessionsLeft(null), 1);
  const ownerHash = legacy.db.prepare(`SELECT password_hash FROM businesses WHERE id='biz-pf'`).get().password_hash;
  assert.ok(passwordMatches('owner-pass-2', ownerHash));
});

t('sign out other devices ends only that person’s other sign-ins', () => {
  addSession.run('owner-d', null); addSession.run('jane-c', 'mem-1');
  assert.strictEqual(profile.endOthers(ownerSession, 'biz-pf', 'owner-a'), 1);
  assert.strictEqual(sessionsLeft(null), 1);
  assert.strictEqual(sessionsLeft('mem-1'), 2);
});

t('a removed member has no profile', () => {
  const session = janeSession();
  legacy.db.prepare(`UPDATE business_members SET status='removed' WHERE id='mem-1'`).run();
  throwsWith(() => profile.view(session, 'biz-pf', 'jane-a'), 401, /sign in/);
  throwsWith(() => profile.changePassword(session, 'biz-pf', 'jane-pass-2', 'jane-pass-3', 'jane-a'), 401, /sign in/);
});

t('every signed-in role may use the profile routes, nobody else', () => {
  for (const [method, path] of [['GET', '/api/business/profile'], ['PATCH', '/api/business/profile'],
    ['POST', '/api/business/profile/password'], ['POST', '/api/business/profile/sessions/end-others']]) {
    const route = team.routeFor(method, path);
    assert.ok(route, `${method} ${path} is in the route table`);
    assert.strictEqual(route.permission, 'any');
    for (const role of team.STAFF_ROLES) assert.ok(team.roleCan(role, route.permission), `${role} may ${method} ${path}`);
  }
});

console.log(`\n${pass} passed`);

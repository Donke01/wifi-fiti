'use strict';

/**
 * "My profile" in the business dashboard: the signed-in person's own
 * details, password and sign-ins. It works the same for the owner (the
 * businesses row, a session with no member_id) and for a team member (a
 * business_members row). Nobody can reach another person's profile here:
 * every function acts on the session it is given.
 *
 * Password hashing is passed in from server.js so this module uses the
 * exact same scheme as sign-in and password reset.
 */

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const NAME_MAX = 80;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const cleanName = (value) => String(value == null ? '' : value)
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function createProfile({ db, hashPassword, passwordMatches, roles }) {
  const ownerRow = db.prepare(`SELECT id, name, owner_name, owner_phone, email, password_hash, plan, hotspot_name,
      owner_phone_verified, created_at FROM businesses WHERE id=?`);
  const memberRow = db.prepare(`SELECT id, business_id, role, name, email, phone, password_hash, created_at
      FROM business_members WHERE id=? AND business_id=? AND status='active'`);
  const setOwnerName = db.prepare(`UPDATE businesses SET owner_name=? WHERE id=?`);
  const setMemberName = db.prepare(`UPDATE business_members SET name=?, updated_at=datetime('now') WHERE id=? AND business_id=? AND status='active'`);
  const setOwnerPassword = db.prepare(`UPDATE businesses SET password_hash=? WHERE id=?`);
  const setMemberPassword = db.prepare(`UPDATE business_members SET password_hash=?, updated_at=datetime('now') WHERE id=? AND business_id=? AND status='active'`);
  const ownerSessions = db.prepare(`SELECT token_hash, created_at, expires_at FROM business_sessions
      WHERE business_id=? AND member_id IS NULL AND expires_at>datetime('now') ORDER BY created_at DESC`);
  const memberSessions = db.prepare(`SELECT token_hash, created_at, expires_at FROM business_sessions
      WHERE business_id=? AND member_id=? AND expires_at>datetime('now') ORDER BY created_at DESC`);
  const endOtherOwnerSessions = db.prepare(`DELETE FROM business_sessions WHERE business_id=? AND member_id IS NULL AND token_hash<>?`);
  const endOtherMemberSessions = db.prepare(`DELETE FROM business_sessions WHERE business_id=? AND member_id=? AND token_hash<>?`);
  const ownerActivity = db.prepare(`SELECT action, target, created_at FROM business_activity
      WHERE business_id=? AND member_id IS NULL ORDER BY id DESC LIMIT 12`);
  const memberActivity = db.prepare(`SELECT action, target, created_at FROM business_activity
      WHERE business_id=? AND member_id=? ORDER BY id DESC LIMIT 12`);

  const isOwner = (session) => !session || !session.member;

  /** The person behind this session, with the password hash (never sent out). */
  function person(session, businessId) {
    if (isOwner(session)) {
      const row = ownerRow.get(businessId);
      if (!row) throw fail('Your session has expired. Please sign in again.', 401);
      return { owner: true, row };
    }
    const row = memberRow.get(session.member.id, businessId);
    if (!row) throw fail('Your session has expired. Please sign in again.', 401);
    return { owner: false, row };
  }

  function sessionsFor(session, businessId, currentTokenHash) {
    const rows = isOwner(session) ? ownerSessions.all(businessId) : memberSessions.all(businessId, session.member.id);
    return rows.map((row) => ({ signedInAt: row.created_at, expiresAt: row.expires_at, current: row.token_hash === currentTokenHash }));
  }

  function view(session, businessId, currentTokenHash) {
    const { owner, row } = person(session, businessId);
    const business = ownerRow.get(businessId) || {};
    const role = owner ? 'owner' : row.role;
    const activity = owner ? ownerActivity.all(businessId) : memberActivity.all(businessId, row.id);
    return {
      person: {
        name: (owner ? row.owner_name : row.name) || '',
        email: row.email || '',
        phone: (owner ? row.owner_phone : row.phone) || '',
        phoneVerified: owner ? Boolean(row.owner_phone_verified && row.owner_phone_verified === row.owner_phone) : null,
        role,
        roleLabel: roles[role] ? roles[role].label : role,
        roleSummary: roles[role] ? roles[role].summary : '',
        isOwner: owner,
        memberSince: row.created_at,
      },
      business: { name: business.name || '', hotspotName: owner ? business.hotspot_name || '' : undefined },
      sessions: sessionsFor(session, businessId, currentTokenHash),
      activity: activity.map((item) => ({ action: item.action, target: item.target || '', at: item.created_at })),
      passwordRules: { minLength: PASSWORD_MIN },
    };
  }

  function rename(session, businessId, value) {
    const name = cleanName(value);
    if (!name) throw fail('Enter your name.');
    if (name.length > NAME_MAX) throw fail('That name is too long.');
    if (isOwner(session)) setOwnerName.run(name, businessId);
    else if (!setMemberName.run(name, session.member.id, businessId).changes) throw fail('Your session has expired. Please sign in again.', 401);
    return name;
  }

  /**
   * Needs the current password. On success every other sign-in of this
   * person ends; the device that changed it stays signed in.
   */
  function changePassword(session, businessId, currentPassword, newPassword, currentTokenHash) {
    const current = String(currentPassword || '');
    const next = String(newPassword || '');
    if (!current) throw fail('Enter your current password.');
    if (next.length < PASSWORD_MIN) throw fail(`Use a new password with at least ${PASSWORD_MIN} characters.`);
    if (next.length > PASSWORD_MAX) throw fail('That password is too long.');
    if (next === current) throw fail('Choose a password different from your current one.');
    const { owner, row } = person(session, businessId);
    if (!passwordMatches(current, row.password_hash)) throw fail('Your current password is not correct.', 403);
    const hash = hashPassword(next);
    if (owner) setOwnerPassword.run(hash, businessId);
    else setMemberPassword.run(hash, row.id, businessId);
    const ended = endOthers(session, businessId, currentTokenHash);
    return { signedOutOthers: ended };
  }

  function endOthers(session, businessId, currentTokenHash) {
    if (!currentTokenHash) return 0;
    return Number((isOwner(session)
      ? endOtherOwnerSessions.run(businessId, currentTokenHash)
      : endOtherMemberSessions.run(businessId, session.member.id, currentTokenHash)).changes || 0);
  }

  return { view, rename, changePassword, endOthers, PASSWORD_MIN };
}

module.exports = { createProfile };

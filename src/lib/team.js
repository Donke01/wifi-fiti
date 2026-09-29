'use strict';

/**
 * Team accounts: roles, the route → permission table, invites and the
 * activity log.
 *
 * The owner is the businesses row itself (a session with no member_id).
 * Everyone else is a business_members row. Every /api/business/* request
 * passes through `guard`, which looks the route up in ROUTES:
 *   - 'public'  no sign-in needed (login, register, invite accept …)
 *   - 'any'     any signed-in person (/me, logout)
 *   - 'owner'   the owner only
 *   - a permission (or a list: any one of them is enough)
 * A route that is not in the table is DENIED for everyone but the owner.
 * businessAuth() refuses a staff session the guard did not clear, so a
 * business-authenticated route outside /api/business/* is denied as well.
 */
const crypto = require('node:crypto');
const { db } = require('./db');
const { normalizePhone } = require('./mpesa');

const INVITE_DAYS = 7;

const ROLES = {
  owner: { label: 'Owner', summary: 'Everything, including money, payment settings and the team.' },
  manager: { label: 'Manager', summary: 'Packages, prices, vouchers, customers, routers, map and tools. Not payouts, payment settings, deleting routers or the team.' },
  attendant: { label: 'Attendant', summary: 'Vouchers, customer lookup, “Already paid?” help and today’s sales.' },
  technician: { label: 'Technician', summary: 'Routers, map, tools and remote access. No money, prices or backups.' },
  viewer: { label: 'Viewer', summary: 'Read-only sales, transactions and exports.' },
};
const STAFF_ROLES = ['manager', 'attendant', 'technician', 'viewer'];

// What each staff role may do. The owner may do everything.
const ROLE_PERMISSIONS = {
  manager: ['sales.view', 'packages.view', 'packages.edit', 'vouchers.view', 'vouchers.create', 'vouchers.manage',
    'customers.view', 'customers.edit', 'payments.recover', 'payments.record', 'routers.view', 'routers.edit',
    'map', 'tools', 'backups', 'remote', 'portal', 'sms', 'support'],
  attendant: ['sales.today', 'packages.view', 'vouchers.view', 'vouchers.create', 'customers.view', 'payments.recover'],
  technician: ['routers.view', 'routers.edit', 'map', 'tools', 'remote', 'support'],
  viewer: ['sales.view'],
};
const ALL_PERMISSIONS = [...new Set(Object.values(ROLE_PERMISSIONS).flat()), 'billing', 'payments.settings', 'payouts', 'routers.delete', 'team', 'settings'];

const SALES = ['sales.view', 'sales.today'];
const B = '/api/business';
// [method, path, permission, activity]. The activity text is written to the
// log after a successful write, with the router/package/person it touched.
const ROUTES = [
  // Signing in and joining
  ['POST', `${B}/register`, 'public'], ['POST', `${B}/verify-registration`, 'public'], ['POST', `${B}/login`, 'public'],
  ['GET', `${B}/google/start`, 'public'], ['GET', `${B}/google/callback`, 'public'], ['POST', `${B}/verify-login`, 'public'],
  ['POST', `${B}/resend-code`, 'public'], ['POST', `${B}/forgot-password`, 'public'], ['POST', `${B}/reset-password`, 'public'],
  ['POST', `${B}/invite/check`, 'public'], ['POST', `${B}/invite/accept`, 'public'],
  ['POST', `${B}/logout`, 'any'], ['GET', `${B}/me`, 'any'],

  // Owner only: business details, Wi-Fi Fiti billing, payment settings, payouts, team
  ['POST', `${B}/phone/verify/start`, 'owner'], ['POST', `${B}/phone/verify/confirm`, 'owner'],
  ['POST', `${B}/organisation`, 'owner', 'Changed business details'], ['PATCH', `${B}/organisation`, 'owner', 'Changed business details'],
  ['POST', `${B}/billing-plan`, 'owner', 'Changed the plan'],
  ['GET', `${B}/network-services`, 'owner'], ['POST', `${B}/network-services/plan`, 'owner', 'Changed service capacity'],
  ['GET', `${B}/network-services/upgrade-quote`, 'owner'], ['POST', `${B}/network-services/upgrade`, 'owner', 'Paid for more capacity'],
  ['POST', `${B}/network-services/checkout`, 'owner', 'Paid for services'], ['POST', `${B}/billing/checkout`, 'owner', 'Paid Wi-Fi Fiti'],
  ['GET', `${B}/billing/status/:checkoutRequestId`, 'owner'], ['GET', `${B}/billing/recover`, 'owner'],
  ['GET', `${B}/operations/billing`, 'owner'], ['GET', `${B}/operations/billing/:checkoutRequestId/receipt`, 'owner'],
  ['GET', `${B}/payment-collection`, 'owner'], ['POST', `${B}/payment-collection`, 'owner', 'Changed payment settings'],
  ['GET', `${B}/integrations`, 'owner'], ['POST', `${B}/integrations/select`, 'owner', 'Changed payment settings'],
  ['POST', `${B}/integrations/test`, 'owner'], ['GET', `${B}/integrations/c2b`, 'owner'],
  ['POST', `${B}/integrations/c2b`, 'owner', 'Changed PayBill settings'], ['GET', `${B}/integrations/c2b/reconciliation`, 'owner'],
  ['GET', `${B}/tuma/destinations`, 'owner'], ['GET', `${B}/tuma/settlement`, 'owner'],
  ['POST', `${B}/tuma/settlement`, 'owner', 'Changed Tuma payout'], ['POST', `${B}/tuma/link`, 'owner', 'Linked Tuma'],
  ['DELETE', `${B}/tuma/link`, 'owner', 'Unlinked Tuma'], ['GET', `${B}/tuma/fee`, 'owner'],
  ['POST', `${B}/tuma/fee/checkout`, 'owner', 'Paid the Tuma fee'],
  ['GET', `${B}/operations/payouts`, 'owner'], ['POST', `${B}/operations/payouts`, 'owner', 'Asked for a payout'],
  ['POST', `${B}/operations/payouts/:payoutId/cancel`, 'owner', 'Cancelled a payout'], ['GET', `${B}/operations/payouts/:payoutId`, 'owner'],
  ['POST', `${B}/sms/packages`, 'owner', 'Bought SMS credits'],
  ['DELETE', `${B}/locations/:locationId`, 'owner', 'Deleted a router'],
  ['GET', `${B}/team`, 'owner'], ['POST', `${B}/team/invites`, 'owner', 'Invited someone'],
  ['POST', `${B}/team/invites/:inviteId/link`, 'owner', 'Made a new invite link'],
  ['DELETE', `${B}/team/invites/:inviteId`, 'owner', 'Cancelled an invite'],
  ['PATCH', `${B}/team/members/:memberId`, 'owner', 'Changed a role'], ['DELETE', `${B}/team/members/:memberId`, 'owner', 'Removed someone'],
  ['POST', `${B}/team/members/:memberId/reset`, 'owner', 'Made a password reset link'],

  // Sales (an Attendant sees today only, enforced in the routes)
  ['GET', `${B}/dashboard`, SALES], ['GET', `${B}/tenant-dashboard`, SALES], ['GET', `${B}/pppoe/payments`, 'sales.view'],

  // Packages and prices
  ['POST', `${B}/packages`, 'packages.edit', 'Added a package'], ['PATCH', `${B}/packages/:packageId`, 'packages.edit', 'Changed a package'],
  ['DELETE', `${B}/packages/:packageId`, 'packages.edit', 'Deleted a package'],
  ['PATCH', `${B}/packages/:packageId/availability`, 'packages.edit', 'Turned a package on/off'],
  ['POST', `${B}/packages/starter`, 'packages.edit', 'Added starter packages'],
  ['POST', `${B}/pppoe/profiles`, 'packages.edit', 'Added a PPPoE plan'], ['PATCH', `${B}/pppoe/profiles/:profileId`, 'packages.edit', 'Changed a PPPoE plan'],
  ['PUT', `${B}/pppoe/billing/settings`, 'packages.edit', 'Changed PPPoE billing settings'],

  // Vouchers
  ['GET', `${B}/vouchers`, 'vouchers.view'], ['POST', `${B}/vouchers`, 'vouchers.create', 'Created vouchers'],
  ['POST', `${B}/vouchers/manage`, 'vouchers.manage', 'Changed vouchers'],

  // Customers and "Already paid?" help
  ['GET', `${B}/operations/customers`, 'customers.view'], ['GET', `${B}/operations/customers/:subscriptionId`, 'customers.view'],
  // Who is online on a router: the Technician sees it too (no money in it).
  ['GET', `${B}/locations/:locationId/online-users`, ['customers.view', 'routers.view']],
  // Support hub: find a customer by phone, voucher or M-Pesa code, and its numbers.
  ['GET', `${B}/support/search`, 'customers.view'], ['GET', `${B}/support/summary`, 'customers.view'],
  ['POST', `${B}/operations/transactions/:checkoutRequestId/retry`, 'payments.recover', 'Switched on a paid customer'],
  ['GET', `${B}/pppoe`, 'customers.view'], ['GET', `${B}/pppoe/billing`, 'customers.view'], ['GET', `${B}/pppoe/jobs/:jobId`, 'customers.view'],
  ['POST', `${B}/pppoe/users`, 'customers.edit', 'Added a PPPoE customer'],
  ['PATCH', `${B}/pppoe/users/:userId`, 'customers.edit', 'Changed a PPPoE customer'],
  ['POST', `${B}/pppoe/users/:userId/provision`, 'customers.edit', 'Sent a PPPoE customer to the router'],
  ['POST', `${B}/pppoe/users/:userId/lock`, 'customers.edit', 'Locked a PPPoE customer'],
  ['POST', `${B}/pppoe/users/:userId/unlock`, 'customers.edit', 'Unlocked a PPPoE customer'],
  ['POST', `${B}/pppoe/users/:userId/extend`, 'customers.edit', 'Extended a PPPoE customer'],
  ['POST', `${B}/pppoe/users/:userId/send-link`, 'customers.edit', 'Sent a PPPoE pay link'],
  ['POST', `${B}/pppoe/users/:userId/payments`, 'payments.record', 'Recorded a PPPoE payment'],

  // Routers, map, tools, remote access
  ['GET', `${B}/router-telemetry`, 'routers.view'], ['GET', `${B}/locations/:locationId/go-live`, 'routers.view'],
  ['GET', `${B}/locations/:locationId/router-topology`, 'routers.view'], ['GET', `${B}/pppoe/health/:locationId`, 'routers.view'],
  ['POST', `${B}/router-setup`, 'routers.edit', 'Added a router'], ['POST', `${B}/locations`, 'routers.edit', 'Added a router'],
  ['POST', `${B}/locations/:locationId/router-setup`, 'routers.edit', 'Made a new router kit'],
  ['POST', `${B}/locations/:locationId/router-token`, 'routers.edit', 'Made a new router key'],
  ['PATCH', `${B}/locations/:locationId`, 'routers.edit', 'Changed a router'],
  ['PUT', `${B}/locations/:locationId/network-plan`, 'map', 'Saved the router map'],
  ['DELETE', `${B}/locations/:locationId/network-plan`, 'map', 'Cleared the router map'],
  ['GET', `${B}/locations/:locationId/network-plan/review`, 'map'],
  ['POST', `${B}/locations/:locationId/network-plan/apply`, 'map', 'Applied a router change'],
  ['POST', `${B}/locations/:locationId/network-changes/:changeId/undo`, 'map', 'Undid a router change'],
  ['POST', `${B}/locations/:locationId/network-changes/:changeId/rename`, 'map', 'Renamed a router change'],
  ['PUT', `${B}/locations/:locationId/router-mapping`, 'map', 'Saved the router map'],
  ['GET', `${B}/locations/:locationId/mapped-deployment`, 'map'],
  ['POST', `${B}/locations/:locationId/mapped-deployment`, 'map', 'Started router setup from the map'],
  ['GET', `${B}/locations/:locationId/tools`, 'tools'], ['POST', `${B}/locations/:locationId/tools`, 'tools', 'Ran a router tool'],
  ['GET', `${B}/locations/:locationId/remote-access`, 'remote'],
  ['POST', `${B}/locations/:locationId/remote-access`, 'remote', 'Changed remote access'],
  ['PATCH', `${B}/locations/:locationId/remote-access`, 'remote', 'Changed remote access'],

  // Customer portal, SMS, support
  ['PATCH', `${B}/branding`, 'portal', 'Changed the customer portal'], ['POST', `${B}/branding/logo`, 'portal', 'Changed the logo'],
  ['POST', `${B}/onboarding/customer-portal`, 'portal', 'Set up the customer portal'],
  ['PATCH', `${B}/locations/:locationId/portal-address`, 'portal', 'Changed a portal address'],
  ['GET', `${B}/portal-templates`, 'portal'], ['POST', `${B}/portal-templates`, 'portal', 'Added a portal template'],
  ['PATCH', `${B}/portal-templates/:templateId`, 'portal', 'Changed a portal template'],
  ['POST', `${B}/portal-templates/:templateId/activate`, 'portal', 'Switched portal template'],
  ['DELETE', `${B}/portal-templates/:templateId`, 'portal', 'Deleted a portal template'],
  ['GET', `${B}/sms`, 'sms'], ['PUT', `${B}/sms/settings`, 'sms', 'Changed SMS settings'],
  ['GET', `${B}/operations/tickets`, 'support'], ['POST', `${B}/operations/tickets`, 'support', 'Opened a support ticket'],
  ['GET', `${B}/operations/tickets/:ticketId`, 'support'], ['POST', `${B}/operations/tickets/:ticketId/messages`, 'support'],
].map(([method, pattern, permission, activity]) => {
  const names = [];
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, name) => { names.push(name); return '([^/]+?)'; });
  // Express matches without case and with an optional trailing slash.
  return { method, pattern, permission, activity: activity || null, names, regex: new RegExp(`^${source}/?$`, 'i') };
});

function routeFor(method, path) {
  const verb = method === 'HEAD' ? 'GET' : method;
  for (const route of ROUTES) {
    if (route.method !== verb) continue;
    const match = route.regex.exec(path);
    if (match) {
      const params = {};
      route.names.forEach((name, index) => { try { params[name] = decodeURIComponent(match[index + 1]); } catch { params[name] = match[index + 1]; } });
      return { ...route, params };
    }
  }
  return null;
}

function permissionsFor(role) {
  return role === 'owner' ? ALL_PERMISSIONS.slice() : (ROLE_PERMISSIONS[role] || []).slice();
}
function roleCan(role, permission) {
  if (role === 'owner') return true;
  if (permission === 'any') return Boolean(ROLE_PERMISSIONS[role]);
  if (permission === 'owner' || !permission) return false;
  const wanted = Array.isArray(permission) ? permission : [permission];
  const granted = ROLE_PERMISSIONS[role] || [];
  return wanted.some((item) => granted.includes(item));
}

const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
const digest = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const newId = (prefix) => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** Midnight today in Kenya (EAT, UTC+3, no daylight saving), as SQL time. */
function todayStart(now = Date.now()) {
  const eat = 3 * 3600_000;
  return sqlTime(Math.floor((now + eat) / 86400_000) * 86400_000 - eat);
}

/* ---- Sessions -------------------------------------------------------- */
const sessionRow = db.prepare(`SELECT business_id, member_id FROM business_sessions WHERE token_hash=? AND expires_at>datetime('now')`);
const memberById = db.prepare(`SELECT * FROM business_members WHERE id=?`);
const activeMember = db.prepare(`SELECT * FROM business_members WHERE id=? AND business_id=? AND status='active'`);

/** { businessId, member, role } for a bearer token, or null. A session whose
 * person was removed (or no longer exists) is not valid. */
function sessionFor(token) {
  if (!token) return null;
  const row = sessionRow.get(digest(token));
  if (!row) return null;
  if (!row.member_id) return { businessId: row.business_id, member: null, role: 'owner' };
  const member = activeMember.get(row.member_id, row.business_id);
  if (!member || !ROLE_PERMISSIONS[member.role]) return null;
  return { businessId: row.business_id, member, role: member.role };
}
const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

/* ---- Activity log ---------------------------------------------------- */
const insertActivity = db.prepare(`INSERT INTO business_activity (business_id, member_id, actor_name, actor_role, action, target)
  VALUES (?, ?, ?, ?, ?, ?)`);
const purgeActivity = db.prepare(`DELETE FROM business_activity WHERE business_id=? AND created_at < datetime('now', '-180 days')`);
const recentActivity = db.prepare(`SELECT id, member_id, actor_name, actor_role, action, target, created_at
  FROM business_activity WHERE business_id=? ORDER BY id DESC LIMIT ?`);
const ownerName = db.prepare(`SELECT owner_name, email FROM businesses WHERE id=?`);

function actorOf(businessId, member) {
  if (member) return { memberId: member.id, name: member.name, role: member.role };
  const owner = ownerName.get(businessId) || {};
  return { memberId: null, name: owner.owner_name || owner.email || 'Owner', role: 'owner' };
}
function record(businessId, member, action, target = '') {
  const actor = actorOf(businessId, member);
  insertActivity.run(businessId, actor.memberId, String(actor.name || '').slice(0, 80), actor.role, String(action).slice(0, 120), String(target || '').slice(0, 240) || null);
  if (Math.random() < 0.05) purgeActivity.run(businessId);
}

const locationName = db.prepare(`SELECT name FROM locations WHERE id=? AND business_id=?`);
const packageName = db.prepare(`SELECT name, price FROM business_packages WHERE id=? AND business_id=?`);
const inviteById = db.prepare(`SELECT * FROM business_invites WHERE id=? AND business_id=?`);
/** A short, secret-free description of what a write touched. */
function describe(businessId, params, body) {
  const parts = [];
  const text = (value, max = 60) => String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const locationId = params.locationId || (body && typeof body.locationId === 'string' ? body.locationId : '');
  const packageId = params.packageId || (body && body.packageId);
  if (locationId) { const row = locationName.get(locationId, businessId); if (row || params.locationId) parts.push('Router: ' + text(row ? row.name : locationId)); }
  if (packageId) { const row = packageName.get(Number(packageId), businessId); if (row) parts.push(`Package: ${text(row.name)} (KES ${row.price})`); }
  if (params.memberId) { const row = memberById.get(params.memberId); if (row && row.business_id === businessId) parts.push(`${text(row.name)} (${ROLES[row.role] ? ROLES[row.role].label : row.role})`); }
  if (params.inviteId) { const row = inviteById.get(params.inviteId, businessId); if (row) parts.push(`Invite: ${text(row.name || 'unnamed')} (${ROLES[row.role] ? ROLES[row.role].label : row.role})`); }
  if (body && typeof body === 'object') {
    if (!params.packageId && body.name && typeof body.name === 'string' && !params.memberId) parts.push(text(body.name));
    if (body.price !== undefined && body.price !== '') parts.push('KES ' + text(body.price, 12));
    if (body.count) parts.push(text(body.count, 6) + ' codes');
    if (Array.isArray(body.codes)) parts.push(body.codes.length + ' codes');
    if (body.action && typeof body.action === 'string') parts.push(text(body.action, 20));
    if (body.tool && typeof body.tool === 'string') parts.push('Tool: ' + text(body.tool, 20));
    if (body.role && ROLES[body.role]) parts.push('Role: ' + ROLES[body.role].label);
  }
  if (params.checkoutRequestId) parts.push('Payment ' + text(params.checkoutRequestId, 40));
  return parts.join(' · ');
}

/* ---- The guard --------------------------------------------------------- */
/** Central permission check for every /api/business/* request. */
function guard(req, res, next) {
  if (!/^\/api\/business(\/|$)/i.test(req.path)) return next();
  const route = routeFor(req.method, req.path);
  if (route && route.permission === 'public') return next();
  const session = sessionFor(bearer(req));
  // No valid session: the route itself answers 401 ("Please sign in").
  req.teamSession = session;
  if (!session) return next();
  if (session.role !== 'owner') {
    if (!route || !roleCan(session.role, route.permission)) {
      return res.status(403).json({ error: `Your role (${ROLES[session.role].label}) can't do this. Ask the owner.`, role: session.role });
    }
    // An Attendant sees sales from midnight today only.
    if (!roleCan(session.role, 'sales.view') && roleCan(session.role, 'sales.today')) req.salesFrom = todayStart();
  }
  req.teamAllowed = true;
  if (route && route.activity && req.method !== 'GET') {
    const body = req.body; const params = route.params;
    // Describe before the write (a deleted package still has its name).
    let target = '';
    try { target = describe(session.businessId, params, body); } catch (_) { target = ''; }
    res.on('finish', () => {
      if (res.statusCode >= 400 || res.locals.skipActivity) return;
      try { record(session.businessId, session.member, res.locals.activity || route.activity, res.locals.activityTarget || target); }
      catch (error) { console.error('[team] activity log failed:', error.message); }
    });
  }
  next();
}

/** True when the signed-in person has this permission (owner: always). */
function can(req, permission) {
  const session = req.teamSession;
  return Boolean(session) && roleCan(session.role, permission);
}
/** The later of a route's own start date and the Attendant's "today". */
function salesSince(req, since) {
  return req.salesFrom && (!since || req.salesFrom > since) ? req.salesFrom : since;
}

/* ---- Members and invites ------------------------------------------- */
const membersFor = db.prepare(`SELECT id, role, name, email, phone, status, created_at, updated_at FROM business_members
  WHERE business_id=? AND status='active' ORDER BY created_at`);
const pendingInvites = db.prepare(`SELECT id, kind, role, name, email, phone, member_id, expires_at, created_at FROM business_invites
  WHERE business_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>datetime('now') ORDER BY created_at DESC`);
const inviteByHash = db.prepare(`SELECT i.*, b.name AS business_name FROM business_invites i JOIN businesses b ON b.id=i.business_id WHERE i.token_hash=?`);
const addInvite = db.prepare(`INSERT INTO business_invites (id, business_id, kind, role, name, email, phone, member_id, token_hash, created_by, expires_at)
  VALUES (@id, @businessId, @kind, @role, @name, @email, @phone, @memberId, @tokenHash, @createdBy, @expiresAt)`);
const useInvite = db.prepare(`UPDATE business_invites SET used_at=datetime('now') WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>datetime('now')`);
const revokeInviteRow = db.prepare(`UPDATE business_invites SET revoked_at=datetime('now') WHERE id=? AND business_id=? AND used_at IS NULL AND revoked_at IS NULL`);
const rotateInviteRow = db.prepare(`UPDATE business_invites SET token_hash=?, expires_at=? WHERE id=? AND business_id=? AND used_at IS NULL AND revoked_at IS NULL`);
const memberByEmail = db.prepare(`SELECT * FROM business_members WHERE email=? AND status='active'`);
const memberByPhone = db.prepare(`SELECT * FROM business_members WHERE phone=? AND status='active'`);
const ownerByEmail = db.prepare(`SELECT id FROM businesses WHERE email=?`);
const addMember = db.prepare(`INSERT INTO business_members (id, business_id, role, name, email, phone, password_hash, invited_by)
  VALUES (@id, @businessId, @role, @name, @email, @phone, @passwordHash, @invitedBy)`);
const setMemberRole = db.prepare(`UPDATE business_members SET role=?, updated_at=datetime('now') WHERE id=? AND business_id=? AND status='active'`);
const setMemberPassword = db.prepare(`UPDATE business_members SET password_hash=?, updated_at=datetime('now') WHERE id=? AND status='active'`);
const removeMemberRow = db.prepare(`UPDATE business_members SET status='removed', removed_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND business_id=? AND status='active'`);
const endMemberSessions = db.prepare(`DELETE FROM business_sessions WHERE member_id=?`);
const dropMemberInvites = db.prepare(`UPDATE business_invites SET revoked_at=datetime('now') WHERE member_id=? AND used_at IS NULL AND revoked_at IS NULL`);

const cleanText = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return null;
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120) throw fail('Enter a valid email address.');
  return email;
}
function cleanPhone(value) {
  if (!String(value || '').trim()) return null;
  const phone = normalizePhone(value);
  if (!phone) throw fail('Enter a valid Kenyan phone number.');
  return phone;
}
function staffRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (!STAFF_ROLES.includes(role)) throw fail('Choose a role: Manager, Attendant, Technician or Viewer.');
  return role;
}
function publicMember(member) {
  return member && { id: member.id, role: member.role, roleLabel: ROLES[member.role] ? ROLES[member.role].label : member.role,
    name: member.name, email: member.email || null, phone: member.phone || null, createdAt: member.created_at };
}
function publicInvite(invite) {
  return { id: invite.id, kind: invite.kind, role: invite.role, roleLabel: ROLES[invite.role] ? ROLES[invite.role].label : invite.role,
    name: invite.name || null, email: invite.email || null, phone: invite.phone || null, expiresAt: invite.expires_at, createdAt: invite.created_at };
}

/** A new one-time token for an invite; only its hash is stored. */
function freshToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: digest(token), expiresAt: sqlTime(Date.now() + INVITE_DAYS * 86400_000) };
}

function createInvite(businessId, { role, name, email, phone }, createdBy = null) {
  const invite = { id: newId('invite'), businessId, kind: 'join', role: staffRole(role), name: cleanText(name, 80) || null,
    email: cleanEmail(email), phone: cleanPhone(phone), memberId: null, createdBy };
  const { token, tokenHash, expiresAt } = freshToken();
  addInvite.run({ ...invite, tokenHash, expiresAt });
  return { token, invite: publicInvite(inviteById.get(invite.id, businessId)) };
}
function resetInvite(businessId, memberId, createdBy = null) {
  const member = activeMember.get(memberId, businessId);
  if (!member) throw fail('That person is not on your team.', 404);
  dropMemberInvites.run(member.id);
  const invite = { id: newId('invite'), businessId, kind: 'reset', role: member.role, name: member.name,
    email: member.email, phone: member.phone, memberId: member.id, createdBy };
  const { token, tokenHash, expiresAt } = freshToken();
  addInvite.run({ ...invite, tokenHash, expiresAt });
  return { token, invite: publicInvite(inviteById.get(invite.id, businessId)), member: publicMember(member) };
}
function rotateInvite(businessId, inviteId) {
  const { token, tokenHash, expiresAt } = freshToken();
  if (!rotateInviteRow.run(tokenHash, expiresAt, inviteId, businessId).changes) throw fail('That invite was used or cancelled.', 404);
  return { token, invite: publicInvite(inviteById.get(inviteId, businessId)) };
}
function revokeInvite(businessId, inviteId) {
  if (!revokeInviteRow.run(inviteId, businessId).changes) throw fail('That invite was already used or cancelled.', 404);
  return true;
}

/** The invite behind a token, if it can still be used. */
function openInvite(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw fail('This invite link is not valid.', 404);
  const invite = inviteByHash.get(digest(token));
  if (!invite) throw fail('This invite link is not valid.', 404);
  if (invite.revoked_at) throw fail('This invite was cancelled. Ask the owner for a new link.', 410);
  if (invite.used_at) throw fail('This invite link was already used. Sign in, or ask the owner for a new link.', 410);
  if (invite.expires_at <= sqlTime(Date.now())) throw fail('This invite link has expired. Ask the owner for a new link.', 410);
  if (invite.kind === 'reset' && !activeMember.get(invite.member_id, invite.business_id)) throw fail('This link is no longer valid. Ask the owner.', 410);
  return invite;
}
function inviteSummary(token) {
  const invite = openInvite(token);
  return { kind: invite.kind, businessName: invite.business_name || 'Your team', role: invite.role, roleLabel: ROLES[invite.role].label,
    roleSummary: ROLES[invite.role].summary, name: invite.name || '', email: invite.email || '', phone: invite.phone || '', expiresAt: invite.expires_at };
}

function assertLoginFree({ email, phone }, exceptMemberId = null) {
  if (email) {
    const other = memberByEmail.get(email);
    if (ownerByEmail.get(email) || (other && other.id !== exceptMemberId)) throw fail('That email is already used to sign in to Wi-Fi Fiti. Use another one.', 409);
  }
  if (phone) {
    const other = memberByPhone.get(phone);
    if (other && other.id !== exceptMemberId) throw fail('That phone number is already used to sign in to Wi-Fi Fiti. Use another one.', 409);
  }
}

/** Use an invite (single use). Returns the member who can now sign in. */
function acceptInvite(token, body, hashPassword) {
  const password = String(body && body.password || '');
  if (password.length < 8) throw fail('Use a password with at least 8 characters.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const invite = openInvite(token);
    let member;
    if (invite.kind === 'reset') {
      member = activeMember.get(invite.member_id, invite.business_id);
      setMemberPassword.run(hashPassword(password), member.id);
      // The old password (and anyone signed in with it) stops working.
      endMemberSessions.run(member.id);
    } else {
      const name = cleanText(body && body.name, 80);
      if (!name) throw fail('Enter your name.');
      const email = cleanEmail(body && body.email);
      const phone = cleanPhone(body && body.phone);
      if (!email && !phone) throw fail('Enter an email or phone number to sign in with.');
      assertLoginFree({ email, phone });
      member = { id: newId('member'), businessId: invite.business_id, role: invite.role, name, email, phone,
        passwordHash: hashPassword(password), invitedBy: invite.created_by };
      addMember.run(member);
      member = memberById.get(member.id);
    }
    if (!useInvite.run(invite.id).changes) throw fail('This invite link was already used.', 410);
    db.exec('COMMIT');
    record(invite.business_id, member, invite.kind === 'reset' ? 'Set a new password' : 'Joined the team', ROLES[member.role].label);
    return member;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw error;
  }
}

/** A staff login by email or phone. */
function memberForLogin(login) {
  const value = String(login || '').trim();
  if (!value) return null;
  if (value.includes('@')) return memberByEmail.get(value.toLowerCase()) || null;
  const phone = normalizePhone(value);
  return phone ? memberByPhone.get(phone) || null : null;
}

function changeRole(businessId, memberId, role) {
  const next = staffRole(role);
  if (!setMemberRole.run(next, memberId, businessId).changes) throw fail('That person is not on your team.', 404);
  // A new role takes effect at once: they sign in again.
  endMemberSessions.run(memberId);
  return publicMember(memberById.get(memberId));
}
function removeMember(businessId, memberId) {
  if (!removeMemberRow.run(memberId, businessId).changes) throw fail('That person is not on your team.', 404);
  endMemberSessions.run(memberId);
  dropMemberInvites.run(memberId);
  return true;
}

function teamFor(businessId) {
  const owner = db.prepare(`SELECT owner_name, email, owner_phone FROM businesses WHERE id=?`).get(businessId) || {};
  return {
    owner: { name: owner.owner_name || '', email: owner.email || '', role: 'owner', roleLabel: ROLES.owner.label },
    members: membersFor.all(businessId).map(publicMember),
    invites: pendingInvites.all(businessId).map(publicInvite),
    roles: Object.entries(ROLES).map(([id, value]) => ({ id, ...value, permissions: permissionsFor(id) })),
    inviteDays: INVITE_DAYS,
    activity: recentActivity.all(businessId, 100).map((row) => ({ ...row, roleLabel: ROLES[row.actor_role] ? ROLES[row.actor_role].label : row.actor_role })),
  };
}

/** Who is signed in, for /me and the dashboard. */
function whoFor(session, business) {
  if (!session || session.role === 'owner') {
    return { id: null, role: 'owner', roleLabel: ROLES.owner.label, name: business && business.owner_name || '', email: business && business.email || '', phone: null, permissions: permissionsFor('owner'), denied: [] };
  }
  const permissions = permissionsFor(session.role);
  return { ...publicMember(session.member), permissions, denied: ALL_PERMISSIONS.filter((item) => !permissions.includes(item)) };
}

module.exports = {
  INVITE_DAYS, ROLES, STAFF_ROLES, ROLE_PERMISSIONS, ROUTES,
  routeFor, roleCan, permissionsFor, guard, can, salesSince, todayStart, sessionFor, bearer,
  record, teamFor, whoFor, createInvite, resetInvite, rotateInvite, revokeInvite, inviteSummary, acceptInvite,
  memberForLogin, changeRole, removeMember, publicMember, assertLoginFree,
};

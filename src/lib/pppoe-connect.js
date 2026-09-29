'use strict';

/*
 * The public "Home internet" page of a PPPoE business, and the connection
 * requests it collects.
 *
 * The page (public/pppoe-home.html, /home/<pay code>, and /home on the
 * tenant's own address) shows the business's priced plans, the areas it
 * covers, how to pay and a few answers, with a "Get connected" form. It is
 * off until the owner turns it on (settings.homePage).
 *
 * A request is a name, a phone, where to connect and an optional plan. The
 * owner sees it under PPPoE, calls the customer and moves it along:
 *   new → contacted → scheduled → connected | declined
 * One open request per phone: asking again updates it instead of adding
 * another. Nothing here sends SMS or money; it only writes the request.
 */

const crypto = require('node:crypto');
const { db } = require('./db');
const mpesa = require('./mpesa');
const billing = require('./pppoe-billing');

db.exec(`
  CREATE TABLE IF NOT EXISTS pppoe_connection_requests (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    area TEXT NOT NULL,
    estate TEXT,
    landmark TEXT,
    profile_id TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    owner_note TEXT,
    user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pppoe_connection_requests ON pppoe_connection_requests(business_id, created_at);
`);

const STATUSES = ['new', 'contacted', 'scheduled', 'connected', 'declined'];
const OPEN = ['new', 'contacted', 'scheduled'];
// A business can't be flooded: past this many new requests in a day the
// form says to call instead.
const DAILY_LIMIT = 200;
const OTHER_AREA = 'Somewhere else';

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function text(value, max) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max); }
const parseTime = (value) => { const ms = Date.parse(String(value || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value || '')) ? '' : 'Z')); return Number.isFinite(ms) ? ms : null; };

/** A plan as the public page shows it: no ids of other businesses, no router details. */
function publicPlan(profile) {
  return {
    id: profile.id, name: profile.name, downloadRate: profile.download_rate, uploadRate: profile.upload_rate,
    price: Number(profile.price), periodDays: Number(profile.period_days) || 30,
    boostPrice: profile.boost_price == null ? null : Number(profile.boost_price),
  };
}

/** What the public page needs, or null when the page is off. */
function homeView(business, { payBill = null, logoUrl = null } = {}) {
  const settings = billing.settingsFor(business.id);
  if (!settings.homePage) return null;
  return {
    business: { ...billing.businessView(business), logoUrl },
    headline: settings.homeHeadline || null,
    areas: settings.homeAreas,
    otherArea: OTHER_AREA,
    installFee: settings.homeInstallFee,
    plans: billing.pricedPlans(business.id).map(publicPlan),
    payPath: `/pay/${settings.payCode}`,
    payBill,
    graceDays: settings.graceDays,
    features: { changePlan: settings.selfChangePlan, boosts: settings.boosts, payForOthers: settings.payForOthers },
  };
}

const openByPhone = db.prepare(`SELECT * FROM pppoe_connection_requests WHERE business_id=? AND phone=? AND status IN ('new','contacted','scheduled')
  ORDER BY created_at DESC LIMIT 1`);
const requestById = db.prepare('SELECT * FROM pppoe_connection_requests WHERE id=? AND business_id=?');

/**
 * Save a request from the public form. Returns { request, updated } where
 * updated says an open request from the same phone was refreshed.
 */
function createRequest(business, body = {}) {
  const settings = billing.settingsFor(business.id);
  if (!settings.homePage) throw fail('This page is not taking requests.', 404);
  const fullName = text(body.fullName, 80);
  if (fullName.length < 2) throw fail('Please enter your name.');
  const phone = mpesa.normalizePhone(body.phone);
  if (!phone) throw fail('Enter a Kenyan phone number, like 0712 345 678.');
  let area = text(body.area, 60);
  const areas = settings.homeAreas;
  if (areas.length) {
    const match = areas.find((a) => a.toLowerCase() === area.toLowerCase());
    if (match) area = match;
    else if (area.toLowerCase() === OTHER_AREA.toLowerCase()) area = OTHER_AREA;
    else throw fail('Choose your area from the list.');
  }
  if (!area) throw fail('Tell us your area.');
  const estate = text(body.estate, 80) || null;
  if (area === OTHER_AREA && !estate) throw fail('Tell us your estate or building so we can check.');
  const landmark = text(body.landmark, 80) || null;
  const note = text(body.note, 300) || null;
  let profileId = null;
  if (body.planId) {
    const plan = billing.pricedPlans(business.id).find((p) => p.id === String(body.planId));
    if (!plan) throw fail('That package is no longer offered. Choose another.');
    profileId = plan.id;
  }

  const existing = openByPhone.get(business.id, phone);
  if (existing) {
    db.prepare(`UPDATE pppoe_connection_requests SET full_name=?, area=?, estate=?, landmark=?, profile_id=?, note=?, updated_at=datetime('now')
      WHERE id=?`).run(fullName, area, estate, landmark, profileId, note, existing.id);
    return { request: requestById.get(existing.id, business.id), updated: true };
  }
  const today = db.prepare(`SELECT COUNT(*) AS n FROM pppoe_connection_requests WHERE business_id=? AND created_at >= datetime('now','-1 day')`).get(business.id).n;
  if (today >= DAILY_LIMIT) throw fail('We have many requests today. Please call us instead.', 429);
  const id = `req_${crypto.randomBytes(9).toString('base64url')}`;
  db.prepare(`INSERT INTO pppoe_connection_requests (id, business_id, full_name, phone, area, estate, landmark, profile_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, business.id, fullName, phone, area, estate, landmark, profileId, note);
  return { request: requestById.get(id, business.id), updated: false };
}

/** What the customer sees after sending: their own details only. */
function receiptView(request) {
  return { phone: mpesa.displayPhone(request.phone), area: request.area, at: new Date(parseTime(request.updated_at) || Date.now()).toISOString() };
}

function ownerView(request, plans) {
  const plan = request.profile_id ? plans.get(request.profile_id) : null;
  return {
    id: request.id, fullName: request.full_name, phone: mpesa.displayPhone(request.phone), phoneE164: `+${request.phone}`,
    area: request.area, estate: request.estate, landmark: request.landmark, note: request.note,
    plan: plan ? { id: plan.id, name: plan.name, price: plan.price == null ? null : Number(plan.price) } : null,
    status: request.status, ownerNote: request.owner_note, userId: request.user_id,
    createdAt: new Date(parseTime(request.created_at)).toISOString(), updatedAt: new Date(parseTime(request.updated_at)).toISOString(),
  };
}

/** The owner's list: open requests first (newest first), then the last closed ones. */
function listRequests(businessId, { limit = 100 } = {}) {
  const plans = new Map(db.prepare('SELECT * FROM pppoe_profiles WHERE business_id=?').all(businessId).map((p) => [p.id, p]));
  const rows = db.prepare(`SELECT * FROM pppoe_connection_requests WHERE business_id=?
    ORDER BY CASE WHEN status IN ('new','contacted','scheduled') THEN 0 ELSE 1 END, created_at DESC LIMIT ?`).all(businessId, Math.min(500, Math.max(1, limit)));
  const open = db.prepare(`SELECT status, COUNT(*) AS n FROM pppoe_connection_requests WHERE business_id=? AND status IN ('new','contacted','scheduled') GROUP BY status`).all(businessId);
  const counts = Object.fromEntries(OPEN.map((s) => [s, 0]));
  for (const row of open) counts[row.status] = row.n;
  return { requests: rows.map((r) => ownerView(r, plans)), counts };
}

function updateRequest(businessId, requestId, patch = {}) {
  const current = requestById.get(String(requestId || ''), businessId);
  if (!current) throw fail('That request was not found.', 404);
  const status = patch.status === undefined ? current.status : String(patch.status);
  if (!STATUSES.includes(status)) throw fail('Unknown status.');
  const ownerNote = patch.ownerNote === undefined ? current.owner_note : (text(patch.ownerNote, 300) || null);
  let userId = current.user_id;
  if (patch.userId !== undefined) {
    userId = patch.userId ? String(patch.userId) : null;
    if (userId && !db.prepare('SELECT 1 FROM pppoe_users WHERE id=? AND business_id=?').get(userId, businessId)) throw fail('That subscriber was not found.', 404);
  }
  db.prepare(`UPDATE pppoe_connection_requests SET status=?, owner_note=?, user_id=?, updated_at=datetime('now') WHERE id=? AND business_id=?`)
    .run(status, ownerNote, userId, current.id, businessId);
  const plans = new Map(db.prepare('SELECT * FROM pppoe_profiles WHERE business_id=?').all(businessId).map((p) => [p.id, p]));
  return ownerView(requestById.get(current.id, businessId), plans);
}

/** The short address on the tenant's own portal host when it is on, else cloud. */
function homePageUrl(businessId) {
  const address = require('./pppoe-address');
  const host = address.tenantHost({ businessId });
  return host ? `https://${host}/home` : `${address.cloudOrigin()}/home/${billing.settingsFor(businessId).payCode}`;
}

module.exports = { STATUSES, OTHER_AREA, homeView, createRequest, receiptView, listRequests, updateRequest, homePageUrl };

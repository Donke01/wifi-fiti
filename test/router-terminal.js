'use strict';

/* Router terminal core: blocklist, tickets, audit, sessions, eligibility. */

process.env.DATABASE_PATH = '/tmp/wifi-fiti-terminal-test.db';
process.env.PUBLIC_URL = 'https://fiti.test';
process.env.MPESA_CONSUMER_KEY = 'k';
process.env.MPESA_CONSUMER_SECRET = 's';
process.env.MPESA_SHORTCODE = '1';
process.env.MPESA_PASSKEY = 'p';
try { require('node:fs').unlinkSync('/tmp/wifi-fiti-terminal-test.db'); } catch (_) {}

const assert = require('node:assert/strict');
const terminal = require('../src/lib/router-terminal');

/* ---- Blocklist ---- */

assert.equal(terminal.blockedCommandLabel('/system reboot'), 'reboot');
assert.equal(terminal.blockedCommandLabel('reboot'), 'reboot');
assert.equal(terminal.blockedCommandLabel('/system shutdown'), 'shutdown');
assert.equal(terminal.blockedCommandLabel('/system reset-configuration'), 'reset-configuration');
assert.equal(terminal.blockedCommandLabel('/interface disable ether2'), 'disable');
assert.equal(terminal.blockedCommandLabel('disable'), 'disable');
assert.equal(terminal.blockedCommandLabel('/ip firewall filter remove 0'), 'remove');
assert.equal(terminal.blockedCommandLabel('/system backup load name=auto-before-upgrade'), 'backup load');
assert.equal(terminal.blockedCommandLabel('/system backup restore name=x'), 'restore');
assert.equal(terminal.blockedCommandLabel('  /SYSTEM REBOOT  '), 'reboot');

assert.equal(terminal.blockedCommandLabel('/ip address print'), null);
assert.equal(terminal.blockedCommandLabel('/system backup save name=auto'), null);
assert.equal(terminal.blockedCommandLabel('/interface wireless print'), null);
assert.equal(terminal.blockedCommandLabel(':put "do not remove me"'), null);
assert.equal(terminal.blockedCommandLabel('/system resource print'), null);
assert.equal(terminal.blockedCommandLabel(''), null);
assert.equal(terminal.blockedCommandLabel('   '), null);

/* ---- Tickets: single-use, expiring ---- */

const ticket = terminal.createTicket({ businessId: 'biz-1', locationId: 'loc-1', transport: 'direct' });
const claimed = terminal.consumeTicket(ticket);
assert.equal(claimed.businessId, 'biz-1');
assert.equal(claimed.locationId, 'loc-1');
assert.equal(claimed.transport, 'direct');
assert.equal(terminal.consumeTicket(ticket), null, 'ticket is single-use');
assert.equal(terminal.consumeTicket('term-ticket-nope'), null);

assert.throws(() => terminal.createTicket({ businessId: 'b', locationId: 'l', transport: 'bogus' }), /Unknown terminal transport/);

const expiring = terminal.createTicket({ businessId: 'biz-1', locationId: 'loc-2', transport: 'direct' });
terminal.sweepTickets(Date.now() + terminal.TICKET_TTL_MS + 1000);
assert.equal(terminal.consumeTicket(expiring), null, 'expired tickets are swept');

/* ---- Rate limit: 10 opens per business per hour ---- */

for (let i = 0; i < 10; i++) terminal.checkRateLimit('biz-rate');
assert.throws(() => terminal.checkRateLimit('biz-rate'), (error) => error.status === 429);
terminal.checkRateLimit('biz-other'); // independent bucket

/* ---- Session registry: one per router, bounded concurrency ---- */

const fakeSession = (businessId, locationId) => ({
  businessId, locationId, openedAt: Date.now(), lastActivityAt: Date.now(), closed: false,
  close(reason) { this.closed = true; this.closeReason = reason; },
});
const s1 = fakeSession('biz-a', 'loc-a');
terminal.registerSession(s1);
assert.throws(() => terminal.registerSession(fakeSession('biz-a', 'loc-a')), (error) => error.status === 429 || error.status === 409);
assert.equal(terminal.getSession('loc-a'), s1);
terminal.unregisterSession('loc-a');
assert.equal(terminal.getSession('loc-a'), null);

const many = [];
for (let i = 0; i < 5; i++) { const s = fakeSession('biz-cap', `loc-cap-${i}`); terminal.registerSession(s); many.push(s); }
assert.throws(() => terminal.registerSession(fakeSession('biz-cap', 'loc-cap-x')), (error) => error.status === 429);
many.forEach((s) => terminal.unregisterSession(s.locationId));

/* ---- Sweep: idle and over-long sessions are closed ---- */

const idle = fakeSession('biz-s', 'loc-idle');
idle.lastActivityAt = Date.now() - terminal.IDLE_TIMEOUT_MS - 1000;
terminal.registerSession(idle);
const long = fakeSession('biz-s', 'loc-long');
long.openedAt = Date.now() - terminal.MAX_SESSION_MS - 1000;
terminal.registerSession(long);
const fresh = fakeSession('biz-s', 'loc-fresh');
terminal.registerSession(fresh);
terminal.sweepSessions();
assert.equal(idle.closed, true);
assert.equal(idle.closeReason, 'idle timeout');
assert.equal(long.closed, true);
assert.equal(long.closeReason, 'maximum session length reached');
assert.equal(fresh.closed, false);
assert.equal(terminal.getSession('loc-fresh').locationId, 'loc-fresh');
terminal.unregisterSession('loc-fresh');

/* ---- Audit: sessions, lines, close stats ---- */

const auditId = terminal.auditSessionOpen({ businessId: 'biz-audit', locationId: 'loc-audit', transport: 'direct' });
terminal.auditLine(auditId, 'input', '/ip address print');
terminal.auditLine(auditId, 'input', '/system resource print');
terminal.auditLine(auditId, 'blocked', '/system reboot');
terminal.auditSessionClose(auditId, 'test done');
const [recent] = terminal.recentSessions('biz-audit', 5);
assert.equal(recent.id, auditId);
assert.equal(recent.transport, 'direct');
assert.equal(recent.lines_run, 2);
assert.equal(recent.lines_blocked, 1);
assert.equal(recent.close_reason, 'test done');
assert.ok(recent.closed_at, 'close timestamp recorded');

/* ---- Platform setting: gateway transport defaults to off ---- */

assert.equal(terminal.gatewayTransportApproved(), false);
terminal.setSetting('gateway_transport', 'on');
assert.equal(terminal.gatewayTransportApproved(), true);
terminal.setSetting('gateway_transport', 'off');
assert.equal(terminal.gatewayTransportApproved(), false);

/* ---- Eligibility: enrolled routers only ---- */

assert.equal(terminal.terminalEligible({ status: 'configured', gatewayState: 'ready', lastHandshakeAt: '2026-09-30 00:00:00' }), true);
assert.equal(terminal.terminalEligible({ status: 'configured', gatewayState: 'ready', lastHandshakeAt: null }), false);
assert.equal(terminal.terminalEligible({ status: 'configured', gatewayState: 'pending', lastHandshakeAt: 'x' }), false);
assert.equal(terminal.terminalEligible({ status: 'approved', gatewayState: 'ready', lastHandshakeAt: 'x' }), false);
assert.equal(terminal.terminalEligible(null), false);
assert.equal(terminal.terminalEligible({}), false);

console.log('router-terminal: all assertions passed');

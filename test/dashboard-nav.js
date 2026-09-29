'use strict';

// The business dashboard has exactly eight pages, and every older page name
// or #hash (bookmarks, emails, buttons, other scripts) lands on the page that
// now holds it. Unknown names land on Home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('public/business.html');

// The sidebar: exactly these eight buttons, in this order.
const aside = html.match(/<aside class="sidebar glass"[\s\S]*?<\/aside>/);
assert.ok(aside, 'the dashboard has its sidebar');
const nav = aside[0].match(/<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/)[1];
const items = [...nav.matchAll(/<button type="button" data-module="([a-z-]+)"><span class="symbol" aria-hidden="true">[^<]*<\/span>([^<]+)<\/button>/g)]
  .map((m) => [m[1], m[2].replace(/&amp;/g, '&')]);
assert.deepEqual(items, [
  ['overview', 'Home'], ['routers', 'Routers'], ['packages', 'Packages & vouchers'], ['customers', 'Customers'],
  ['money', 'Money'], ['portal', 'Customer portal'], ['sms', 'SMS'], ['settings', 'Settings'],
], 'the sidebar has exactly the eight pages');
assert.equal(nav.replace(/<button type="button" data-module="[a-z-]+"><span class="symbol" aria-hidden="true">[^<]*<\/span>[^<]+<\/button>/g, ''), '',
  'nothing else sits in the sidebar menu (no labels, links or extra pages)');
assert.doesNotMatch(html, /nav-extended'|installExtendedNavigation|installPppoeNavLink|data-pppoe-link/, 'no script adds more sidebar items later');
for (const file of ['public/billing-hub.js', 'public/tuma-payout.js', 'public/setup-flow.js', 'public/fiti-actions.js']) {
  assert.doesNotMatch(read(file), /\.sidebar|\.nav\b|data-module/, file + ' adds nothing to the sidebar');
}

// The page model, run as the page runs it.
const block = html.match(/ {6}var dashboardPages = \[[\s\S]*?\n {6}function moduleFromHash\(\)/);
assert.ok(block, 'the page model is present');
const context = { $: () => null, window: { location: { hash: '' } } };
vm.createContext(context);
vm.runInContext(block[0].replace(/\n {6}function moduleFromHash\(\)$/, ''), context);
vm.runInContext(html.match(/ {6}function moduleFromHash\(\) \{[^\n]*\}/)[0], context);
// Plain copies: arrays made inside the vm fail deepEqual's prototype check.
const dashboardPages = JSON.parse(JSON.stringify(context.dashboardPages)); const moduleSections = JSON.parse(JSON.stringify(context.moduleSections)); const { resolveModule } = context;
assert.deepEqual(dashboardPages.map((page) => page.id), items.map((item) => item[0]), 'each sidebar button opens one page');
assert.deepEqual(dashboardPages.map((page) => page.label), items.map((item) => item[1]), 'each page is named as in the sidebar');
const pageOf = (name) => dashboardPages.find((page) => page.parts.some((part) => part.id === resolveModule(name))).id;

const expected = {
  // New names and the pages themselves.
  overview: 'overview', home: 'overview', routers: 'routers', packages: 'packages', customers: 'customers', money: 'money',
  portal: 'portal', sms: 'sms', settings: 'settings',
  // Every older page name and hash.
  onboarding: 'overview', setup: 'overview', locations: 'routers', 'router-map': 'routers', 'router-setup': 'routers',
  tools: 'routers', 'router-tools': 'routers', remote: 'routers', 'remote-access': 'routers', pppoe: 'routers',
  vouchers: 'packages', support: 'customers', analytics: 'customers', sales: 'money', transactions: 'money',
  disbursements: 'money', payouts: 'money', branding: 'portal', 'portal-templates': 'portal', templates: 'portal',
  account: 'settings', billing: 'settings', payments: 'settings', plan: 'settings', 'payment-collection': 'settings',
  integrations: 'settings', team: 'settings', receipts: 'settings', tickets: 'settings', help: 'settings',
  // Unknown or empty → Home.
  '': 'overview', nonsense: 'overview', 'google_token=abc': 'overview', constructor: 'overview', ['__proto__']: 'overview', hasOwnProperty: 'overview',
};
for (const [name, page] of Object.entries(expected)) assert.equal(pageOf(name), page, '#' + name + ' opens ' + page);
assert.equal(resolveModule('money'), 'sales', 'Money opens on Sales');
assert.equal(resolveModule('settings'), 'account', 'Settings opens on Account & limits');
assert.equal(resolveModule('disbursements'), 'sales', 'the old Disbursements page is not shown; its link opens Sales');
assert.equal(resolveModule('vouchers'), 'vouchers', 'a part keeps its own hash');
assert.equal(resolveModule('tickets'), 'receipts', 'support tickets open Settings → Receipts & help');
assert.deepEqual(dashboardPages.find((page) => page.id === 'settings').parts.map((part) => [part.id, part.label, part.sections]), [
  ['account', 'Account & limits', ['account-section']],
  ['payments', 'Billing & payments', ['billing-section', 'network-services-section', 'integrations-section']],
  ['receipts', 'Receipts & help', ['receipts-section', 'tickets-section']],
  ['team', 'Team', ['team-section']],
], 'Settings has four tabs; plan receipts and support tickets have their own');
for (const [hash, part] of [['#vouchers', 'vouchers'], ['#module=tools', 'tools'], ['#payments', 'payments'], ['#disbursements', 'sales'], ['#nope', 'overview'], ['', 'overview']]) {
  context.window.location.hash = hash; assert.equal(context.moduleFromHash(), part, hash + ' → ' + part);
}

// Every section belongs to exactly one part; Disbursements is not a part.
const sections = Object.values(moduleSections).flat();
assert.equal(new Set(sections).size, sections.length, 'no section is on two pages');
assert.ok(!sections.includes('disbursements-section'), 'Disbursements is hidden');
assert.doesNotMatch(html, /id="disbursements-section"/, 'the placeholder Disbursements page is gone');
for (const id of ['locations-section', 'tools-section', 'pppoe-section', 'packages-section', 'vouchers-section', 'customers-section', 'support-section', 'sales-section', 'branding-section', 'sms-section', 'billing-section', 'integrations-section', 'network-services-section', 'receipts-section', 'tickets-section']) {
  assert.match(html, new RegExp('id="' + id + '"'), id + ' exists');
  assert.ok(sections.includes(id), id + ' is on a page');
}
for (const id of ['transactions-section', 'account-section', 'team-section', 'remote-section', 'portal-templates-section']) assert.ok(sections.includes(id), id + ' is on a page');

// Every page name used by a button, a card, another script, the server or an
// email is known (it does not silently fall back to Home).
const known = (name) => name === 'overview' || resolveModule(name) !== 'overview';
const used = new Set();
const collect = (text, pattern) => { for (const m of text.matchAll(pattern)) used.add(m[1]); };
collect(html, /goLiveGoTo\('([a-z-]+)'\)/g);
collect(html, /activateDashboardModule\('([a-z-]+)'/g);
collect(html, /data-open-module="([a-z-]+)"/g);
const cards = html.match(/var mappings = (\{[^}]*\});[\s\S]*?var labels = (\{[^}]*\});[\s\S]*?var insightModules = (\[[^\]]*\]);/);
for (const literal of cards.slice(1)) Object.values(vm.runInNewContext('(' + literal + ')')).forEach((name) => used.add(name));
collect(read('public/setup-flow.js'), /go: '([a-z-]+)'/g);
for (const file of ['public/billing-hub.js', 'public/setup-flow.js']) collect(read(file), /hash !== '#([a-z-]+)'/g);
collect(read('src/server.js'), /fix = '([a-z-]+)'/g);
collect(read('src/lib/service-reminders.js'), /\/business(?:\.html)?#([a-z-]+)/g);
collect(read('public/pppoe.html'), /\/business\.html#([a-z-]+)/g);
assert.ok(used.size > 10, 'the page names in use were found');
for (const name of used) assert.ok(known(name), name + ' is a known dashboard page');

// Receipts & help uses the owner's receipt and ticket APIs, and never payouts.
assert.match(html, /api\('\/api\/business\/operations\/billing\?offset=' \+ offset\)/, 'plan receipts come from the owner receipts API');
assert.match(html, /'\/api\/business\/operations\/billing\/' \+ encodeURIComponent\(record\.checkout_request_id\) \+ '\/receipt'/, 'each receipt downloads from the owner API');
assert.match(html, /api\('\/api\/business\/operations\/tickets\?offset=' \+ offset\)/, 'support tickets come from the owner tickets API');
assert.match(html, /api\('\/api\/business\/operations\/tickets', \{ method: 'POST'/, 'a new ticket is sent to the owner tickets API');
assert.match(html, /'\/api\/business\/operations\/tickets\/' \+ encodeURIComponent\(ticket\.id\) \+ '\/messages'/, 'a reply goes to the ticket');
assert.doesNotMatch(html, /\/payouts|admin-token|business-operations\/|\/operations\.html/, 'the dashboard neither shows payouts nor links operations.html');
assert.match(html, /if \(requested === 'receipts' && token && !\(options\.silent && helpLoaded\)\) loadReceiptsAndHelp\(\);/, 'the tab loads when opened, not on every redraw');

// Every message that sends the owner to Billing & payments says where it is:
// "Settings → Billing & payments" (SMS use ">" to stay in GSM-7).
const wordingFiles = ['public/business.html', ...fs.readdirSync(path.join(__dirname, '../public')).filter((f) => f.endsWith('.js')).map((f) => 'public/' + f),
  'src/server.js', ...fs.readdirSync(path.join(__dirname, '../src/lib')).filter((f) => f.endsWith('.js')).map((f) => 'src/lib/' + f)];
for (const file of wordingFiles) {
  const text = read(file);
  assert.doesNotMatch(text, /\b(?:in|under|from) (?:the )?Billing &(?:amp;)? payments|dashboard \(Billing &(?:amp;)? payments\)|Renew in your dashboard to|Pay it in your Wi-Fi Fiti dashboard by/, file + ' says Settings → Billing & payments');
}
const serviceBilling = require('../src/lib/service-billing');
assert.equal(serviceBilling.BILLING_PLACE, 'Settings > Billing & payments');
assert.match(serviceBilling.reminderText('hotspot', 'before', '2026-10-01 00:00:00', 'Shop'), /Renew in your dashboard \(Settings > Billing & payments\)/);
assert.match(serviceBilling.reminderText('hotspot', 'stopped', '2026-10-01 00:00:00', 'Shop'), /Renew in your dashboard \(Settings > Billing & payments\) to resume/);
for (const text of ['Renew it in Settings → Billing & payments.', 'Pay it in Settings → Billing & payments.', 'raise your plan in Settings → Billing & payments.']) {
  assert.ok(read('src/server.js').includes(text), 'server.js: ' + text);
}

// Guided setup still owns the screen while it runs, and the tabs stay out of it.
assert.match(html, /if \(model && onboardingFlowState\(model\)\.active\) \{ setSequentialOnboarding\(true\); moduleView = 'onboarding'; return; \}/);
assert.match(html, /#dashboard\.sequential-onboarding \.page-tabs,#dashboard:not\(\.module-view\) \.page-tabs\{display:none\}/);

console.log('Dashboard navigation: eight pages and every old link passed.');

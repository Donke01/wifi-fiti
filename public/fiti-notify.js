/* Floating notifications for the business dashboard.
 *
 *   FitiNotify.configure({ open: activateDashboardModule, storage })
 *   FitiNotify.sync(workspace)   // after every workspace load / live refresh
 *   FitiNotify.toast(message, tone, { action, onAction, sticky, key })
 *
 * sync() works out the reminders that matter most from data the dashboard
 * already loaded (workspace.services from src/lib/service-billing.js, and the
 * routers) and keeps one card per reminder: it adds new ones, updates their
 * wording as days count down and removes them when the condition clears, so
 * the 2-second live refresh never stacks duplicates. "Later" hides a reminder
 * until the next day (urgent ones come back after four hours).
 */
(function () {
  'use strict';

  var DAY = 86400000;
  var SNOOZE_PREFIX = 'fiti_notify_snooze:';
  var MAX_VISIBLE = 4;
  var openModule = function () {};
  var store = null;
  var stack = null;
  var cards = {};

  var ICONS = {
    danger: '<path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M10.3 3.9L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    warn: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    success: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>',
    router: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 17h.01M11 17h.01"/><path d="M8 10.5a5.5 5.5 0 0 1 8 0"/><path d="M5.5 8a9 9 0 0 1 13 0"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || ICONS.info) + '</svg>';
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function storage() {
    if (store) return store;
    try { return window.localStorage; } catch (_) { return null; }
  }

  function ensureStack() {
    if (stack && document.body.contains(stack)) return stack;
    stack = document.createElement('section');
    stack.className = 'fiti-notify-stack';
    stack.setAttribute('aria-label', 'Notifications');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
    return stack;
  }

  function snoozed(key) {
    var s = storage(); if (!s) return false;
    try { var until = Number(s.getItem(SNOOZE_PREFIX + key) || 0); return until > Date.now(); } catch (_) { return false; }
  }
  function snooze(key, ms) {
    var s = storage(); if (!s) return;
    try { s.setItem(SNOOZE_PREFIX + key, String(Date.now() + ms)); } catch (_) { /* private mode */ }
  }

  function remove(key) {
    var card = cards[key]; if (!card) return;
    delete cards[key];
    card.el.classList.add('leaving');
    setTimeout(function () { if (card.el.parentNode) card.el.parentNode.removeChild(card.el); updateOverflow(); }, 220);
  }

  function updateOverflow() {
    var order = { danger: 0, warn: 1, info: 2, success: 3 };
    var list = Object.keys(cards).map(function (k) { return cards[k]; })
      .sort(function (a, b) { return (order[a.tone] - order[b.tone]) || (a.created - b.created); });
    list.forEach(function (card, i) { card.el.style.order = String(i); card.el.classList.toggle('overflow', i >= MAX_VISIBLE); });
    var more = stack && stack.querySelector('.fiti-notify-more');
    var hidden = Math.max(0, list.length - MAX_VISIBLE);
    if (!stack) return;
    if (!hidden) { if (more) more.remove(); return; }
    if (!more) {
      more = document.createElement('button'); more.type = 'button'; more.className = 'fiti-notify-more';
      more.addEventListener('click', function () { stack.classList.toggle('expanded'); updateOverflow(); });
      stack.appendChild(more);
    }
    more.style.order = '999';
    more.textContent = stack.classList.contains('expanded') ? 'Show fewer' : '+' + hidden + ' more';
    if (stack.classList.contains('expanded')) list.forEach(function (card) { card.el.classList.remove('overflow'); });
  }

  /* One card. Same key = update in place (no flash, no duplicate). */
  function show(n) {
    var root = ensureStack();
    var existing = cards[n.key];
    var html = '<span class="fiti-notify-icon">' + icon(n.icon || n.tone) + '</span>' +
      '<div class="fiti-notify-body"><strong>' + esc(n.title) + '</strong>' + (n.message ? '<p>' + esc(n.message) + '</p>' : '') +
      '<div class="fiti-notify-actions">' +
      (n.action ? '<button type="button" class="fiti-notify-primary" data-act="go">' + esc(n.action) + '</button>' : '') +
      (n.snoozable ? '<button type="button" class="fiti-notify-ghost" data-act="later">Later</button>' : '') +
      '</div></div><button type="button" class="fiti-notify-close" data-act="close" aria-label="Dismiss notification">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    if (existing && existing.html === html) return existing.el;
    var el = existing ? existing.el : document.createElement('article');
    el.className = 'fiti-notify fiti-notify-' + n.tone + (existing ? '' : ' entering');
    el.setAttribute('role', n.tone === 'danger' ? 'alert' : 'status');
    el.innerHTML = html;
    el.onclick = function (event) {
      var button = event.target.closest('[data-act]'); if (!button) return;
      var act = button.getAttribute('data-act');
      if (act === 'go') { if (n.onAction) n.onAction(); else if (n.href) window.location.href = n.href; else if (n.module) openModule(n.module); if (!n.keepOnAction) remove(n.key); }
      var wait = n.snoozeDays ? n.snoozeDays * DAY : n.tone === 'danger' ? 4 * 3600000 : DAY;
      if (act === 'later') { snooze(n.key, wait); remove(n.key); }
      if (act === 'close') { if (n.snoozable) snooze(n.key, wait); remove(n.key); }
    };
    if (!existing) {
      root.appendChild(el);
      requestAnimationFrame(function () { el.classList.remove('entering'); });
      cards[n.key] = { el: el, tone: n.tone, created: Date.now(), html: html, managed: Boolean(n.managed) };
      if (!n.sticky) setTimeout(function () { remove(n.key); }, n.duration || 6000);
    } else {
      existing.html = html; existing.tone = n.tone;
    }
    updateOverflow();
    return el;
  }

  /* ---- What deserves a floating reminder ----------------------------- */
  function days(n) { return n === 1 ? '1 day' : n + ' days'; }
  function whenText(iso) {
    var t = Date.parse(iso || ''); if (!Number.isFinite(t)) return '';
    return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function serviceReminder(key, label, s, list) {
    if (!s || s.status === 'none') return;
    if (s.status === 'active' && s.daysLeft != null && s.daysLeft <= 5) {
      list.push({ key: key + ':renew', tone: s.daysLeft <= 2 ? 'danger' : 'warn', icon: 'warn',
        title: label + ' subscription ends in ' + days(s.daysLeft),
        message: 'Renew before ' + whenText(s.expiresAt) + ' so new customers can keep paying.',
        action: 'Renew now', module: 'payments' });
    } else if (s.status === 'grace') {
      list.push({ key: key + ':grace', tone: 'danger',
        title: label + ' subscription has expired',
        message: 'Sales keep running for ' + days(s.daysLeft) + ' more, then new payments stop. Customers online keep their time.',
        action: 'Renew now', module: 'payments' });
    } else if (s.status === 'expired') {
      list.push({ key: key + ':expired', tone: 'danger',
        title: label + ' sales are paused',
        message: 'The subscription and its grace period have ended. Renew to take new payments again.',
        action: 'Renew now', module: 'payments' });
    }
  }
  function remindersFor(ws) {
    var list = [];
    if (!ws || !ws.business) return list;
    var services = ws.services || {};
    var trial = services.trial || {};
    var business = ws.business;
    var usable = function (s) { return s && (s.status === 'active' || s.status === 'grace'); };
    var paid = usable(services.hotspot) || usable(services.pppoe) || usable(services.legacy);
    if (trial.active && trial.endsAt) {
      var left = Math.max(0, Math.ceil((Date.parse(trial.endsAt) - Date.now()) / DAY));
      if (left <= 3 && !paid) {
        list.push({ key: 'trial:ending', tone: left <= 1 ? 'danger' : 'warn', icon: 'warn',
          title: left <= 0 ? 'Your free trial ends today' : 'Your free trial ends in ' + days(left),
          message: 'Choose hotspot or PPPoE capacity now so customer payments don’t stop on ' + whenText(trial.endsAt) + '.',
          action: 'Choose services', module: 'payments' });
      }
    } else if (String(business.billing_status || '').toLowerCase() === 'trial' && !paid) {
      list.push({ key: 'trial:ended', tone: 'danger',
        title: 'Your free trial has ended',
        message: 'New customer payments are paused until you activate a hotspot or PPPoE service.',
        action: 'Activate a service', module: 'payments' });
    }
    if (String(business.billing_status || '').toLowerCase() === 'suspended') {
      list.push({ key: 'account:suspended', tone: 'danger', title: 'Your workspace is suspended',
        message: 'Customers can’t buy packages right now. Contact Wi-Fi Fiti support to restore it.',
        action: 'Contact support', module: 'tickets' });
    }
    serviceReminder('hotspot', 'Hotspot', services.hotspot, list);
    if (services.pppoe && (services.pppoe.capacity > 0 || services.pppoe.status !== 'none')) serviceReminder('pppoe', 'PPPoE', services.pppoe, list);
    if (!usable(services.hotspot) && !usable(services.pppoe)) serviceReminder('plan', 'Workspace plan', services.legacy, list);

    // PPPoE customers who pay the tenant's PayBill directly are only seen when
    // the tenant's own PayBill is connected for C2B (Tuma has no PayBill
    // collection). Otherwise those payments must be recorded by hand.
    var pppoe = services.pppoe || {};
    if (!ws.pppoePayBill && (Number(pppoe.capacity || 0) > 0 || (pppoe.status && pppoe.status !== 'none'))) {
      list.push({ key: 'pppoe:paybill-manual', tone: 'info', icon: 'info', snoozeDays: 30,
        title: 'Direct PayBill payments need recording',
        message: 'When a PPPoE customer pays your PayBill instead of their pay link, Wi-Fi Fiti isn’t told. Record it on the PPPoE page so their internet is extended.',
        action: 'Record a payment', href: '/pppoe' });
    }
    // The server calls a paired router offline after 90 s without a check-in;
    // wait 5 minutes before raising it so a short blip never nags.
    var offline = (ws.locations || []).filter(function (l) {
      if (String(l.router_status || '').toLowerCase() !== 'offline') return false;
      var raw = String(l.last_seen_at || '');
      var seen = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
      return !Number.isFinite(seen) || Date.now() - seen > 5 * 60000;
    });
    if (offline.length) {
      list.push({ key: 'routers:offline:' + offline.map(function (l) { return l.id; }).sort().join(','), tone: 'warn', icon: 'router',
        title: offline.length === 1 ? (offline[0].name || 'A router') + ' is offline' : offline.length + ' routers are offline',
        message: offline.length === 1 ? 'Customers at this location can’t connect or pay until it checks in again.' : offline.slice(0, 3).map(function (l) { return l.name; }).join(', ') + (offline.length > 3 ? '…' : '') + ' haven’t checked in.',
        action: 'Open routers', module: 'routers' });
    }
    return list;
  }

  function sync(ws) {
    var wanted = remindersFor(ws).filter(function (n) { return !snoozed(n.key); });
    var keep = {};
    wanted.forEach(function (n) { n.sticky = true; n.snoozable = true; n.managed = true; keep[n.key] = true; show(n); });
    Object.keys(cards).forEach(function (key) { if (cards[key].managed && !keep[key]) remove(key); });
  }

  var toastCount = 0;
  function toast(message, tone, options) {
    options = options || {};
    return show({ key: options.key || 'toast:' + (++toastCount), tone: tone || 'info', title: message, message: options.detail,
      action: options.action, onAction: options.onAction, sticky: Boolean(options.sticky), duration: options.duration });
  }

  window.FitiNotify = {
    configure: function (o) { o = o || {}; if (typeof o.open === 'function') openModule = o.open; if (o.storage) store = o.storage; },
    sync: sync,
    toast: toast,
    clear: function () { Object.keys(cards).forEach(remove); },
    _remindersFor: remindersFor
  };
}());

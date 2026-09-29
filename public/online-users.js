/* Active users: who is online on a router right now, and each customer's
 * history. Opened from the router card's "Active users" number.
 *
 *  - Online now: every customer the router reported in its last few
 *    minutes, with how long they have been on, idle time, data used, device
 *    and IP, package and time left. Refreshes every 20 seconds while open
 *    (the router reports faster while this is open).
 *  - Time left, offline: customers with a package who are not connected.
 *  - Tap a customer (roles with customers.view): package, time left and
 *    used, online or last seen, every session with its data, payments and
 *    vouchers.
 *
 * Data: GET /api/business/locations/:id/online-users and
 * GET /api/business/operations/customers/:subscriptionId (server checks the
 * role on both). Everything is written with textContent.
 *
 * window.FitiOnlineUsers.open({ id, name }) · .close() */
(function () {
  'use strict';
  var REFRESH_MS = 20000;
  var IDLE_AFTER_SECONDS = 5 * 60;
  var state = { location: null, tab: 'online', data: null, timer: null, detail: null, query: '' };

  function can(permission) { return !(window.FitiTeam && window.FitiTeam.can) || window.FitiTeam.can(permission); }
  function api(path) {
    var token = ''; try { token = localStorage.getItem('fiti_business_token') || ''; } catch (_) {}
    return fetch(path, { headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store' }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) { var error = new Error(body.error || 'Could not load this. Please try again.'); error.status = response.status; throw error; }
        return body;
      });
    });
  }

  /* ---- Formatting (also used by test/business-ui.js) ---------------- */
  function sqlTime(raw) {
    var text = String(raw || '');
    var time = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
    return Number.isFinite(time) ? time : 0;
  }
  function span(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    if (m) return m + 'm';
    return s + 's';
  }
  function bytes(value) {
    var n = Math.max(0, Number(value) || 0);
    var units = ['B', 'KB', 'MB', 'GB', 'TB']; var i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
    return (i && n < 10 ? n.toFixed(1) : String(Math.round(n))) + ' ' + units[i];
  }
  function clock(raw) {
    var time = sqlTime(raw); if (!time) return '—';
    return new Date(time).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });
  }
  function ago(raw, now) {
    var time = sqlTime(raw); if (!time) return 'never';
    var seconds = Math.max(0, Math.round(((now || Date.now()) - time) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
    return clock(raw);
  }
  function shortMac(mac) { var parts = String(mac || '').split(':'); return parts.length === 6 ? '••:' + parts[4] + ':' + parts[5] : (mac || 'Unknown device'); }
  function phone(value) { var raw = String(value || ''); return /^254\d{9}$/.test(raw) ? '0' + raw.slice(3) : (raw || 'Customer'); }
  /** How one online row reads: status pill, then the facts, in plain words. */
  function onlineRowView(row) {
    var idle = Number(row.idle_seconds);
    var isIdle = Number.isFinite(idle) && idle >= IDLE_AFTER_SECONDS;
    return {
      customer: phone(row.payer_phone || String(row.router_username || '').replace(/-tv$/, '')),
      tv: /-tv$/.test(String(row.router_username || '')),
      status: isIdle ? 'Idle ' + span(idle) : 'Online',
      idle: isIdle,
      device: shortMac(row.mac) + (row.ip ? ' · ' + row.ip : ''),
      onlineFor: span(row.uptime_seconds),
      data: '↓ ' + bytes(row.bytes_out) + ' · ↑ ' + bytes(row.bytes_in),
      plan: (row.package_name || 'Package') + (row.subscription_id ? ' · ' + span(row.seconds_left) + ' left' : ''),
      clickable: Boolean(row.subscription_id) && can('customers.view'),
    };
  }
  function offlineRowView(row, now) {
    return {
      customer: phone(row.payer_phone || row.router_username),
      tv: /-tv$/.test(String(row.router_username || '')),
      status: row.last_seen_at ? 'Last online ' + ago(row.last_seen_at, now) : 'Not connected yet',
      plan: (row.package_name || 'Package') + ' · ' + span(row.seconds_left) + ' left',
      clickable: can('customers.view'),
    };
  }
  function capacityText(capacity, reporting) {
    if (!capacity || !capacity.limit) return '';
    // Until a router reports, every package with time left counts, so a
    // sale is never allowed on a guess.
    var text = reporting === false
      ? capacity.online + ' of ' + capacity.limit + ' counted on your plan (every package with time left, until the router reports)'
      : capacity.online + ' of ' + capacity.limit + ' online on your plan';
    if (capacity.level === 'full') text += ' · Full: new customers wait until someone leaves. Customers with time left can still reconnect.';
    else if (capacity.level === 'near') text += ' · Almost full';
    return text;
  }

  /* ---- DOM helpers --------------------------------------------------- */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function styles() {
    if (document.getElementById('online-users-style')) return;
    var style = el('style'); style.id = 'online-users-style';
    style.textContent = [
      '.ou-backdrop{position:fixed;z-index:30;inset:0;display:flex;align-items:flex-start;justify-content:center;padding:28px 14px;background:rgba(8,24,45,.42);backdrop-filter:blur(6px);overflow:auto}',
      '.ou-card{width:min(980px,100%);padding:20px;border:1px solid #d8e7f4;border-radius:20px;background:#fff;box-shadow:0 24px 60px #0b2a4a33;color:#13294a}',
      '.ou-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ou-head h2{margin:0;font-size:20px}.ou-head p{margin:4px 0 0;color:#5f7892;font-size:13px}',
      '.ou-close{min-width:44px;min-height:44px;padding:0 14px;border:1px solid #d4e2ef;border-radius:12px;color:#13294a;background:#fff;box-shadow:none;font-weight:800}',
      '.ou-capacity{margin:14px 0 0;padding:10px 12px;border-radius:12px;background:#eef6ff;color:#1a4d80;font-size:13px;font-weight:700}.ou-capacity.full{background:#fff1f0;color:#9a2a1f}.ou-capacity:empty{display:none}',
      '.ou-note{margin:12px 0 0;padding:10px 12px;border-radius:12px;background:#fff8e6;color:#7a5200;font-size:13px}',
      '.ou-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:14px 0 10px}.ou-tab{min-height:40px;padding:8px 14px;border:1px solid #d4e2ef;border-radius:99px;color:#2e4d6d;background:#fff;box-shadow:none;font-weight:800}.ou-tab[aria-selected="true"]{border-color:#1769d8;color:#fff;background:#1769d8}',
      '.ou-search{flex:1 1 180px;min-width:0;min-height:40px;margin-left:auto;padding:8px 12px;border:1px solid #d4e2ef;border-radius:12px;color:#13294a;background:#fff;box-shadow:none}',
      '.ou-list{display:grid;gap:8px}.ou-row{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr);gap:6px 14px;align-items:center;width:100%;min-height:0;padding:12px 14px;border:1px solid #e1ebf5;border-radius:14px;color:#13294a;background:#fbfdff;box-shadow:none;text-align:left;font-weight:600}',
      'button.ou-row:hover{border-color:#8cc3ee;background:#f4faff}.ou-row b{display:block;font-size:14px}.ou-row small{display:block;margin-top:2px;color:#62809b;font-size:12px;font-weight:600}',
      '.ou-pill{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:99px;color:#0b6b3a;background:#e3f7ec;font-size:11px;font-weight:800}.ou-pill.idle{color:#7a5200;background:#fff3d6}.ou-pill.off{color:#5f7892;background:#eef2f7}',
      '.ou-empty{padding:26px 14px;border:1px dashed #cfdeec;border-radius:14px;color:#5f7892;text-align:center;font-size:14px}',
      '.ou-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0}.ou-stat{padding:12px;border:1px solid #e1ebf5;border-radius:14px;background:#fbfdff}.ou-stat span{display:block;color:#62809b;font-size:12px;font-weight:700}.ou-stat b{display:block;margin-top:4px;font-size:18px}',
      '.ou-h3{margin:18px 0 8px;font-size:15px}.ou-table{width:100%;border-collapse:collapse;font-size:13px}.ou-table th{padding:8px;color:#62809b;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:.04em}.ou-table td{padding:9px 8px;border-top:1px solid #edf2f7;vertical-align:top}',
      '.ou-scroll{overflow-x:auto}.ou-back{min-height:40px;padding:8px 14px;border:1px solid #d4e2ef;border-radius:12px;color:#13294a;background:#fff;box-shadow:none;font-weight:800}',
      '@media(max-width:760px){.ou-backdrop{padding:10px 8px}.ou-card{padding:14px}.ou-row{grid-template-columns:1fr 1fr}.ou-cards{grid-template-columns:1fr 1fr}.ou-search{flex-basis:100%}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ---- The dialog ---------------------------------------------------- */
  var root = null; var lastFocus = null; var bodyOverflow = '';
  function close() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (root) { root.remove(); root = null; document.body.style.overflow = bodyOverflow; }
    document.removeEventListener('keydown', onKey);
    state.detail = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(event) { if (event.key === 'Escape') { if (state.detail) { state.detail = null; draw(); } else close(); } }

  function open(location) {
    if (!location || !location.id) return;
    styles(); close();
    lastFocus = document.activeElement;
    state.location = location; state.tab = 'online'; state.data = null; state.detail = null; state.query = '';
    root = el('div', 'ou-backdrop'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'ou-title');
    root.addEventListener('click', function (event) { if (event.target === root) close(); });
    root.appendChild(el('div', 'ou-card'));
    // The page behind stays still while the dialog is open.
    bodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    document.body.appendChild(root);
    document.addEventListener('keydown', onKey);
    draw(); load();
    state.timer = setInterval(function () { if (!state.detail) load(); }, REFRESH_MS);
  }

  function load() {
    var id = state.location && state.location.id; if (!id) return;
    api('/api/business/locations/' + encodeURIComponent(id) + '/online-users').then(function (data) {
      if (!root || !state.location || state.location.id !== id) return;
      state.data = data; state.error = null; if (!state.detail) draw();
    }).catch(function (error) { state.error = error.message; if (root && !state.detail) draw(); });
  }

  function heading(card, title, subtitle) {
    var head = el('div', 'ou-head'); var text = el('div');
    var h2 = el('h2', '', title); h2.id = 'ou-title'; text.appendChild(h2);
    if (subtitle) text.appendChild(el('p', '', subtitle));
    var shut = el('button', 'ou-close', 'Close'); shut.type = 'button'; shut.addEventListener('click', close);
    head.appendChild(text); head.appendChild(shut); card.appendChild(head);
    return shut;
  }

  function draw() {
    if (!root) return;
    var card = root.firstChild; card.textContent = '';
    if (state.detail) return drawDetail(card);
    var data = state.data;
    var name = (state.location && state.location.name) || 'Router';
    var shut = heading(card, 'Active users · ' + name, data && data.reportedAt ? 'Updated ' + ago(data.reportedAt) + ' · refreshes every 20 seconds' : 'Asking the router who is online…');
    var capacity = el('p', 'ou-capacity', data ? capacityText(data.capacity, data.reporting) : '');
    if (data && data.capacity && data.capacity.level === 'full') capacity.className += ' full';
    card.appendChild(capacity);
    if (state.error) card.appendChild(el('p', 'ou-note', state.error));
    else if (data && !data.reporting) {
      card.appendChild(el('p', 'ou-note', !data.routerOnline
        ? 'This router is not checking in, so who is online is unknown. Customers with time left are listed under "Time left".'
        : data.reportedAt
          ? 'This router\'s last report was ' + ago(data.reportedAt) + '. Who is online shows again at its next report (about once a minute).'
          : 'This router has not sent who is online yet. It reports about once a minute; this updates by itself.'));
    }
    var online = (data && data.online) || []; var offline = (data && data.offline) || [];
    var bar = el('div', 'ou-bar'); bar.setAttribute('role', 'tablist');
    [['online', 'Online now (' + online.length + ')'], ['offline', 'Time left, offline (' + offline.length + ')']].forEach(function (tab) {
      var button = el('button', 'ou-tab', tab[1]); button.type = 'button'; button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.tab === tab[0]));
      button.addEventListener('click', function () { state.tab = tab[0]; draw(); });
      bar.appendChild(button);
    });
    var search = el('input', 'ou-search'); search.type = 'search'; search.placeholder = 'Find a phone or device'; search.value = state.query;
    search.setAttribute('aria-label', 'Find a phone or device');
    search.addEventListener('input', function () { state.query = search.value; drawList(list, online, offline); });
    bar.appendChild(search); card.appendChild(bar);
    var list = el('div', 'ou-list'); card.appendChild(list);
    drawList(list, online, offline);
    if (!data) list.appendChild(el('div', 'ou-empty', 'Loading…'));
    shut.focus();
  }

  function matches(row) {
    var q = String(state.query || '').replace(/\s+/g, '').toLowerCase(); if (!q) return true;
    return [row.payer_phone, row.router_username, row.mac, row.ip, phone(row.payer_phone)].some(function (value) { return String(value || '').toLowerCase().replace(/\s+/g, '').indexOf(q) >= 0; });
  }
  function drawList(list, online, offline) {
    list.textContent = '';
    var now = Date.now();
    var rows = (state.tab === 'online' ? online : offline).filter(matches);
    if (!rows.length) {
      list.appendChild(el('div', 'ou-empty', state.query ? 'No customer matches that.' : state.tab === 'online' ? 'Nobody is online on this router right now.' : 'No other customer has time left.'));
      return;
    }
    rows.forEach(function (row) {
      var view = state.tab === 'online' ? onlineRowView(row) : offlineRowView(row, now);
      var item = el(view.clickable ? 'button' : 'div', 'ou-row');
      if (view.clickable) { item.type = 'button'; item.addEventListener('click', function () { openDetail(row.subscription_id); }); }
      var who = el('div'); who.appendChild(el('b', '', view.customer + (view.tv ? ' · TV' : '')));
      who.appendChild(el('span', 'ou-pill' + (state.tab === 'offline' ? ' off' : view.idle ? ' idle' : ''), view.status));
      item.appendChild(who);
      if (state.tab === 'online') {
        var on = el('div'); on.appendChild(el('b', '', view.onlineFor)); on.appendChild(el('small', '', 'online this session')); item.appendChild(on);
        var use = el('div'); use.appendChild(el('b', '', view.data)); use.appendChild(el('small', '', view.device)); item.appendChild(use);
      }
      var plan = el('div'); plan.appendChild(el('b', '', view.plan)); if (view.clickable) plan.appendChild(el('small', '', 'Tap for history')); item.appendChild(plan);
      list.appendChild(item);
    });
  }

  /* ---- One customer -------------------------------------------------- */
  function openDetail(subscriptionId) {
    if (!subscriptionId) return;
    state.detail = { id: subscriptionId, loading: true };
    draw();
    api('/api/business/operations/customers/' + encodeURIComponent(subscriptionId)).then(function (body) {
      if (!state.detail || state.detail.id !== subscriptionId) return;
      state.detail = { id: subscriptionId, body: body }; draw();
    }).catch(function (error) { if (state.detail) { state.detail = { id: subscriptionId, error: error.message }; draw(); } });
  }
  function stat(parent, label, value) { var box = el('div', 'ou-stat'); box.appendChild(el('span', '', label)); box.appendChild(el('b', '', value)); parent.appendChild(box); }
  function table(parent, headings, rows) {
    var wrap = el('div', 'ou-scroll'); var t = el('table', 'ou-table'); var head = el('tr');
    headings.forEach(function (text) { head.appendChild(el('th', '', text)); }); t.appendChild(head);
    rows.forEach(function (cells) { var tr = el('tr'); cells.forEach(function (text) { tr.appendChild(el('td', '', text)); }); t.appendChild(tr); });
    wrap.appendChild(t); parent.appendChild(wrap);
  }
  function detailView(body, now) {
    var sub = body.subscription || {}; var activity = body.activity || {}; var totals = activity.totals || {};
    var left = Math.max(0, Math.round((sqlTime(sub.expires_at) - (now || Date.now())) / 1000));
    var sessions = (activity.sessions || []).map(function (s) {
      return [clock(s.started_at), s.online ? 'Online now' : clock(s.ended_at || s.last_seen_at), span(s.uptime_seconds), '↓ ' + bytes(s.bytes_out) + ' · ↑ ' + bytes(s.bytes_in), shortMac(s.mac) + (s.ip ? ' · ' + s.ip : '')];
    });
    var money = can('sales.view') || can('sales.today');
    var payments = (body.history || []).map(function (p) {
      return [clock(p.created_at), p.package_name || 'Package', money ? 'KES ' + Number(p.amount || 0).toLocaleString() : '—', p.status === 'paid' ? (p.mpesa_receipt || 'Paid') : String(p.status || '')];
    });
    return {
      title: phone(sub.payer_phone),
      status: activity.online ? 'Online now' : totals.last_seen_at ? 'Offline · last online ' + ago(totals.last_seen_at, now) : 'Not connected yet',
      online: Boolean(activity.online),
      stats: [['Time left', left ? span(left) : 'Ended'], ['Time used', span(sub.used_seconds)], ['Online in total', span(totals.seconds)],
        ['Data used', '↓ ' + bytes(totals.bytes_out) + ' · ↑ ' + bytes(totals.bytes_in)]],
      sessions: sessions, payments: payments, money: money,
      vouchers: (body.vouchers || []).map(function (v) { return [clock(v.redeemed_at), v.package_name || 'Voucher', span(v.seconds)]; }),
      device: shortMac(sub.mac) + (sub.location_name ? ' · ' + sub.location_name : ''),
    };
  }
  function drawDetail(card) {
    var detail = state.detail;
    var back = el('button', 'ou-back', '← All active users'); back.type = 'button';
    back.addEventListener('click', function () { state.detail = null; draw(); load(); });
    if (!detail.body) {
      heading(card, detail.error ? 'Could not open this customer' : 'Loading customer…', detail.error || '');
      card.appendChild(back); back.focus(); return;
    }
    var view = detailView(detail.body);
    heading(card, view.title, view.device);
    var status = el('span', 'ou-pill' + (view.online ? '' : ' off'), view.status); card.appendChild(status);
    var cards = el('div', 'ou-cards'); view.stats.forEach(function (item) { stat(cards, item[0], item[1]); }); card.appendChild(cards);
    card.appendChild(el('h3', 'ou-h3', 'Sessions'));
    if (view.sessions.length) table(card, ['Started', 'Ended', 'Online for', 'Data', 'Device'], view.sessions);
    else card.appendChild(el('div', 'ou-empty', 'No sessions reported yet. They appear once the router reports this customer online.'));
    card.appendChild(el('h3', 'ou-h3', 'Payments'));
    if (view.payments.length) table(card, ['When', 'Package', 'Amount', 'Receipt'], view.payments);
    else card.appendChild(el('div', 'ou-empty', 'No payments for this package.'));
    if (view.vouchers.length) { card.appendChild(el('h3', 'ou-h3', 'Vouchers')); table(card, ['Redeemed', 'Package', 'Time'], view.vouchers); }
    var foot = el('div', 'ou-bar'); foot.appendChild(back); card.appendChild(foot);
    back.focus();
  }

  window.FitiOnlineUsers = {
    open: open, close: close,
    _test: { span: span, bytes: bytes, ago: ago, shortMac: shortMac, phone: phone, onlineRowView: onlineRowView, offlineRowView: offlineRowView, capacityText: capacityText, detailView: detailView },
  };
})();

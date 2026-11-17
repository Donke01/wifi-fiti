/* Live Home view for the business dashboard.
 *
 *   FitiHomeLive.render(host, { dashboard, workspace, failed, open })
 *
 * Called after every overview load (the dashboard refreshes every few
 * seconds). The view is one persistent node: numbers count up to new values,
 * new payments slide into the activity feed and the "Live" label keeps
 * counting, instead of the whole page being redrawn.
 *
 * Data comes only from what the dashboard already loaded:
 *   dashboard.daily       per-day paid sales and failed attempts (this period
 *                         and the one before it), so trends compare like
 *                         with like
 *   dashboard.recentPayments, byLocation, gross, payments, period, since
 *   workspace.locations, monthlyActiveDevices, plan, member, business
 * A role that may not see sales gets no dashboard; then only the router and
 * device figures are shown.
 */
(function () {
  'use strict';

  var NAIROBI_MS = 3 * 3600000;
  var DAY = 86400000;
  var root = null;
  var seen = null;          // checkout ids already in the feed
  var lastRender = 0;
  var tickTimer = null;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function num(n) { return Math.round(Number(n || 0)).toLocaleString('en-KE'); }
  function kes(n) { return 'KES ' + num(n); }
  function nairobiDay(ms) { return new Date(ms + NAIROBI_MS).toISOString().slice(0, 10); }
  function parseSql(value) { var t = Date.parse(String(value || '').replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : null; }
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    var m = Math.round(s / 60); if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago');
  }
  function maskPhone(phone) {
    var p = String(phone || '').replace(/\D/g, '');
    if (p.indexOf('254') === 0) p = '0' + p.slice(3);
    return p.length >= 7 ? p.slice(0, 4) + ' ••• ' + p.slice(-3) : (p || 'Customer');
  }

  var ICON = {
    wallet: '<path d="M4 7a2 2 0 0 1 2-2h11v3"/><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M16 13.5h2"/>',
    cart: '<path d="M3 4h2l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.2"/><circle cx="9.5" cy="19.5" r="1.2"/><circle cx="17" cy="19.5" r="1.2"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M18 14a5 5 0 0 1 3 5"/>',
    pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
    router: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 17h.01M11 17h.01"/><path d="M8 10.5a5.5 5.5 0 0 1 8 0"/><path d="M5.5 8a9 9 0 0 1 13 0"/>',
    up: '<path d="M7 17L17 7M9 7h8v8"/>',
    down: '<path d="M7 7l10 10M17 9v8H9"/>'
  };
  function icon(name, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICON[name] + '</svg>';
  }

  /* ---------- Numbers ---------------------------------------------------- */
  function periodDays(period) { return period === 'today' ? 1 : period === '7d' ? 7 : period === '90d' ? 90 : 30; }
  function windowDays(n, endOffset) {
    var out = [];
    for (var i = n - 1 + (endOffset || 0); i >= (endOffset || 0); i--) out.push(nairobiDay(Date.now() - i * DAY));
    return out;
  }
  function byDay(daily) { var m = {}; (daily || []).forEach(function (r) { m[r.day] = r; }); return m; }
  function sum(days, map, key) { return days.reduce(function (s, d) { return s + Number((map[d] || {})[key] || 0); }, 0); }
  function trend(cur, prev, points) {
    if (points) { var diff = cur - prev; return { text: (diff >= 0 ? '+' : '') + diff.toFixed(1) + ' pts', dir: diff > 0.05 ? 'up' : diff < -0.05 ? 'down' : 'flat' }; }
    if (!prev) return cur ? { text: 'New', dir: 'up' } : { text: 'No change', dir: 'flat' };
    var pct = (cur - prev) / prev * 100;
    return { text: (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%', dir: pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat' };
  }

  function model(o) {
    var d = o.dashboard, ws = o.workspace || {};
    var locations = ws.locations || [];
    var online = locations.filter(function (l) { return String(l.router_status || '').toLowerCase() === 'online'; }).length;
    var m = {
      name: ((ws.member && ws.member.name) || (ws.business && ws.business.owner_name) || '').split(/\s+/)[0],
      business: (ws.business && ws.business.name) || 'your hotspot',
      routers: locations.length, online: online,
      devices: Number(ws.monthlyActiveDevices || 0),
      deviceLimit: ws.plan && ws.plan.activeDeviceLimit ? Number(ws.plan.activeDeviceLimit) : null,
      sales: Boolean(d) && !o.failed
    };
    if (!m.sales) return m;
    var n = periodDays(d.period), map = byDay(d.daily);
    var cur = windowDays(n, 0), prev = windowDays(n, n);
    m.period = d.period; m.since = d.since; m.n = n;
    m.gross = Number(d.gross || 0); m.payments = Number(d.payments || 0);
    var paidCur = sum(cur, map, 'payments'), failCur = sum(cur, map, 'failed');
    var paidPrev = sum(prev, map, 'payments'), failPrev = sum(prev, map, 'failed');
    m.success = paidCur + failCur ? paidCur / (paidCur + failCur) * 100 : null;
    var successPrev = paidPrev + failPrev ? paidPrev / (paidPrev + failPrev) * 100 : null;
    m.compare = n > 1;
    m.grossTrend = m.compare ? trend(sum(cur, map, 'gross'), sum(prev, map, 'gross')) : null;
    m.salesTrend = m.compare ? trend(paidCur, paidPrev) : null;
    m.successTrend = m.compare && m.success != null && successPrev != null ? trend(m.success, successPrev, true) : null;
    // Area chart: per day for the period, or per hour for "today".
    if (n === 1) {
      var hours = []; for (var h = 0; h < 24; h++) hours.push({ label: (h < 10 ? '0' : '') + h + ':00', value: 0 });
      (d.transactions || []).forEach(function (t) { if (t.status !== 'paid') return; var ms = parseSql(t.created_at); if (ms == null || nairobiDay(ms) !== nairobiDay(Date.now())) return; hours[new Date(ms + NAIROBI_MS).getUTCHours()].value += Number(t.amount || 0); });
      m.area = hours.slice(0, new Date(Date.now() + NAIROBI_MS).getUTCHours() + 1);
    } else {
      m.area = cur.map(function (day) { return { label: day, value: Number((map[day] || {}).gross || 0) }; });
    }
    m.week = n === 1 ? null : windowDays(7, 0).map(function (day) { return { day: day, value: Number((map[day] || {}).gross || 0), payments: Number((map[day] || {}).payments || 0) }; });
    m.recent = (d.recentPayments || []).slice(0, 7);
    var top = (d.byLocation || []).slice().sort(function (a, b) { return Number(b.gross || 0) - Number(a.gross || 0); })[0];
    m.topRouter = top && Number(top.gross) > 0 ? top : null;
    return m;
  }

  /* ---------- Charts (inline SVG, no library) ---------------------------- */
  function niceMax(v) { if (v <= 0) return 100; var p = Math.pow(10, Math.floor(Math.log10(v))); var f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  function shortKes(v) { return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(v)); }
  function dayLabel(day, withMonth) { var d = new Date(day + 'T12:00:00Z'); return withMonth ? d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : d.toLocaleDateString('en-KE', { weekday: 'short', timeZone: 'UTC' }); }

  function areaChart(points, hourly) {
    var W = 640, H = 220, L = 40, R = 8, T = 12, B = 26;
    var max = niceMax(Math.max.apply(null, points.map(function (p) { return p.value; }).concat([0])));
    var step = points.length > 1 ? (W - L - R) / (points.length - 1) : 0;
    var xy = points.map(function (p, i) { return [L + i * step, T + (H - T - B) * (1 - p.value / max)]; });
    var line = xy.map(function (p, i) {
      if (!i) return 'M' + p[0].toFixed(1) + ',' + p[1].toFixed(1);
      var a = xy[i - 1], cx = (a[0] + p[0]) / 2;
      return 'C' + cx.toFixed(1) + ',' + a[1].toFixed(1) + ' ' + cx.toFixed(1) + ',' + p[1].toFixed(1) + ' ' + p[0].toFixed(1) + ',' + p[1].toFixed(1);
    }).join('');
    var base = (H - B).toFixed(1);
    var area = line + 'L' + xy[xy.length - 1][0].toFixed(1) + ',' + base + 'L' + L + ',' + base + 'Z';
    var grid = [0, 0.25, 0.5, 0.75, 1].map(function (f) { var y = T + (H - T - B) * (1 - f); return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/><text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + shortKes(max * f) + '</text>'; }).join('');
    var every = Math.max(1, Math.ceil(points.length / 7));
    var labels = points.map(function (p, i) { if (i % every && i !== points.length - 1) return ''; return '<text x="' + xy[i][0].toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(hourly ? p.label : dayLabel(p.label, true)) + '</text>'; }).join('');
    var dots = xy.length <= 31 ? xy.map(function (p, i) { return '<circle class="hl-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.5" data-i="' + i + '"/>'; }).join('') : '';
    return '<svg class="hl-area" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Revenue chart">' +
      '<defs><linearGradient id="hlAreaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".32"/><stop offset="1" stop-color="currentColor" stop-opacity=".02"/></linearGradient></defs>' +
      '<g class="hl-grid">' + grid + '</g><path class="hl-fill" d="' + area + '"/><path class="hl-line" d="' + line + '" pathLength="1"/>' + dots +
      '<g class="hl-axis">' + labels + '</g><line class="hl-cursor" x1="0" x2="0" y1="' + T + '" y2="' + base + '"/>' +
      '<rect class="hl-hit" x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + H + '"/></svg>';
  }

  function barChart(week) {
    var max = niceMax(Math.max.apply(null, week.map(function (w) { return w.value; }).concat([0])));
    var today = nairobiDay(Date.now());
    return '<div class="hl-bars" role="img" aria-label="Revenue for the last seven days">' +
      '<div class="hl-bars-axis">' + [1, 0.75, 0.5, 0.25, 0].map(function (f) { return '<span>' + shortKes(max * f) + '</span>'; }).join('') + '</div>' +
      '<div class="hl-bars-plot">' + week.map(function (w) {
        var pct = max ? Math.max(w.value ? 3 : 0, Math.round(w.value / max * 100)) : 0;
        return '<div class="hl-bar-col' + (w.day === today ? ' today' : '') + '"><div class="hl-bar-track"><i style="--h:' + pct + '%"></i><b class="hl-bar-tip">' + esc(kes(w.value)) + '<small>' + esc(w.payments + (w.payments === 1 ? ' sale' : ' sales')) + '</small></b></div><span>' + esc(w.day === today ? 'Today' : dayLabel(w.day)) + '</span></div>';
      }).join('') + '</div></div>';
  }

  /* ---------- View --------------------------------------------------------- */
  function tile(key, label, value, display, iconName, tone, trendObj, caption, module) {
    var t = trendObj ? '<span class="hl-trend ' + trendObj.dir + '">' + (trendObj.dir === 'flat' ? '' : icon(trendObj.dir, 14)) + esc(trendObj.text) + '</span>' : '';
    return '<button type="button" class="hl-kpi" data-kpi="' + key + '"' + (module ? ' data-open="' + module + '"' : '') + '>' +
      '<span class="hl-kpi-top"><span class="hl-kpi-label">' + esc(label) + '</span><span class="hl-chip ' + tone + '">' + icon(iconName) + '</span></span>' +
      '<strong class="hl-kpi-value" data-value="' + value + '" data-format="' + display + '">' + esc(format(value, display)) + '</strong>' +
      '<span class="hl-kpi-foot">' + t + '<span class="hl-kpi-cap">' + esc(caption) + '</span></span></button>';
  }
  function format(value, display) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    if (display === 'kes') return kes(value);
    if (display === 'pct') return Number(value).toFixed(1) + '%';
    if (display === 'ratio') return value;
    return num(value);
  }
  function compareLabel(m) { return m.compare ? 'vs previous ' + (m.n === 7 ? '7 days' : m.n === 90 ? '90 days' : '30 days') : 'today'; }

  function activityItem(t, fresh) {
    var ms = parseSql(t.created_at);
    var status = t.status === 'paid' ? '' : '<span class="hl-status ' + (t.status === 'failed' ? 'bad' : 'warn') + '">' + (t.status === 'failed' ? 'Failed' : 'Waiting') + '</span>';
    var initials = String(t.package_name || '?').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    return '<li class="hl-act' + (fresh ? ' fresh' : '') + '" data-id="' + esc(t.checkout_request_id) + '">' +
      '<span class="hl-avatar">' + esc(initials || 'WF') + '</span>' +
      '<span class="hl-act-body"><strong>' + esc(maskPhone(t.phone)) + '</strong> bought <b>' + esc(t.package_name || 'a package') + '</b>' + (t.location_name ? ' at ' + esc(t.location_name) : '') +
      '<small data-ago="' + (ms || '') + '">' + esc(ms ? ago(ms) : '') + '</small></span>' +
      '<span class="hl-act-amt">' + status + esc(kes(t.amount)) + '</span></li>';
  }

  function stat(label, value, pct, tone, note) {
    return '<div class="hl-stat"><div class="hl-stat-head"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>' +
      (pct == null ? '' : '<div class="hl-meter ' + tone + '"><i style="--w:' + Math.max(0, Math.min(100, pct)).toFixed(1) + '%"></i></div>') +
      (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';
  }

  function build(m) {
    var hour = new Date(Date.now() + NAIROBI_MS).getUTCHours();
    var greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    var tiles = [];
    if (m.sales) {
      tiles.push(tile('gross', 'Revenue', m.gross, 'kes', 'wallet', 'green', m.grossTrend, compareLabel(m), 'money'));
      tiles.push(tile('sales', 'Sales', m.payments, 'num', 'cart', 'orange', m.salesTrend, compareLabel(m), 'money'));
    }
    tiles.push(tile('devices', 'Active devices', m.devices, 'num', 'users', 'blue', null, m.deviceLimit ? 'of ' + num(m.deviceLimit) + ' on your plan' : 'this month', 'customers'));
    if (m.sales) tiles.push(tile('success', 'Payment success', m.success, 'pct', 'pulse', 'purple', m.successTrend, m.successTrend ? compareLabel(m) : 'paid vs failed', 'money'));
    else tiles.push(tile('routers', 'Routers online', m.online + ' of ' + m.routers, 'ratio', 'router', 'purple', null, 'checked in now', 'routers'));

    var since = m.since ? new Date(String(m.since).replace(' ', 'T') + 'Z').toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    var charts = m.sales ?
      '<div class="hl-row hl-row-charts">' +
        '<article class="hl-card hl-revenue"><header><div><h3>Revenue overview</h3><p>' + (m.n === 1 ? 'Paid sales per hour today' : 'Paid sales per day') + '</p></div><span class="hl-card-total" data-total>' + esc(kes(m.gross)) + '</span></header>' +
          '<div class="hl-chart-wrap"><div data-area>' + areaChart(m.area, m.n === 1) + '</div><div class="hl-tooltip" hidden></div></div></article>' +
        (m.week ? '<article class="hl-card hl-weekly"><header><div><h3>This week</h3><p>Revenue for the last seven days</p></div></header><div data-week>' + barChart(m.week) + '</div></article>' : '') +
      '</div>' : '';
    var activity = m.sales ?
      '<article class="hl-card hl-activity"><header><div><h3>Live activity</h3><p>Payments as they happen</p></div><button type="button" class="hl-link" data-open="money">All sales</button></header>' +
        '<ul class="hl-feed" data-feed>' + (m.recent.length ? m.recent.map(function (t) { return activityItem(t, false); }).join('') : '<li class="hl-empty">No payments yet. New ones appear here the moment they’re paid.</li>') + '</ul></article>' : '';
    var stats = '<article class="hl-card hl-quick"><header><div><h3>Quick stats</h3><p>Key numbers at a glance</p></div></header><div data-stats>' + statsHtml(m) + '</div></article>';

    return '<div class="hl-head"><div><p class="hl-greet">' + esc(greet + (m.name ? ', ' + m.name : '')) + '</p><p class="hl-sub">Here’s what’s happening at ' + esc(m.business) + '.</p></div>' +
      '<span class="hl-live" role="status"><i aria-hidden="true"></i><span data-live>Live · just now</span></span></div>' +
      '<div class="hl-title"><div class="hl-title-text"><h2>Highlights</h2>' + (since ? '<p>Data from ' + esc(since) + '</p>' : '') + '</div><div class="hl-tools" data-tools></div></div>' +
      '<div class="hl-kpis">' + tiles.join('') + '</div>' + charts +
      '<div class="hl-row hl-row-bottom' + (m.sales ? '' : ' single') + '">' + activity + stats + '</div>';
  }

  function statsHtml(m) {
    var out = stat('Routers online', m.online + ' of ' + m.routers, m.routers ? m.online / m.routers * 100 : 0, m.online === m.routers ? 'good' : 'warn', m.routers ? (m.routers - m.online ? (m.routers - m.online) + ' not checked in' : 'All routers checked in') : 'No routers yet');
    if (m.sales && m.success != null) out += stat('Payment success', m.success.toFixed(1) + '%', m.success, m.success >= 90 ? 'good' : m.success >= 75 ? 'warn' : 'bad', 'Paid prompts out of all finished prompts');
    if (m.deviceLimit) out += stat('Plan usage', num(m.devices) + ' of ' + num(m.deviceLimit), m.devices / m.deviceLimit * 100, m.devices / m.deviceLimit >= 0.9 ? 'warn' : 'blue', 'Active devices this month');
    if (m.sales && m.topRouter) out += stat('Busiest router', m.topRouter.name, null, '', kes(m.topRouter.gross) + ' · ' + num(m.topRouter.payments) + ' sales');
    return out;
  }

  /* ---------- Live updates ------------------------------------------------- */
  function countTo(el, to, display) {
    var from = Number(el.getAttribute('data-value'));
    el.setAttribute('data-value', to);
    if (!Number.isFinite(from) || !Number.isFinite(Number(to)) || display === 'ratio' || reduceMotion || from === Number(to)) { el.textContent = format(to, display); return; }
    var start = performance.now(), dur = 700;
    el.classList.add('changed'); setTimeout(function () { el.classList.remove('changed'); }, 900);
    (function step(now) {
      var k = Math.min(1, (now - start) / dur); var e = 1 - Math.pow(1 - k, 3);
      el.textContent = format(from + (Number(to) - from) * e, display);
      if (k < 1) requestAnimationFrame(step); else el.textContent = format(to, display);
    }(start));
  }

  function update(m) {
    // KPI tiles: same set of tiles → animate values; otherwise rebuild.
    var keys = Array.prototype.map.call(root.querySelectorAll('.hl-kpi'), function (n) { return n.getAttribute('data-kpi'); }).join();
    var fresh = document.createElement('div'); fresh.innerHTML = build(m);
    var freshKeys = Array.prototype.map.call(fresh.querySelectorAll('.hl-kpi'), function (n) { return n.getAttribute('data-kpi'); }).join();
    if (keys !== freshKeys || Boolean(root.querySelector('[data-area]')) !== Boolean(fresh.querySelector('[data-area]'))) { mount(m); return; }
    fresh.querySelectorAll('.hl-kpi').forEach(function (n) {
      var key = n.getAttribute('data-kpi'), cur = root.querySelector('.hl-kpi[data-kpi="' + key + '"]');
      var v = n.querySelector('.hl-kpi-value'), cv = cur.querySelector('.hl-kpi-value');
      countTo(cv, v.getAttribute('data-value'), v.getAttribute('data-format'));
      cur.querySelector('.hl-kpi-foot').innerHTML = n.querySelector('.hl-kpi-foot').innerHTML;
    });
    ['[data-area]', '[data-week]', '[data-stats]', '[data-total]', '.hl-title-text'].forEach(function (sel) {
      var a = root.querySelector(sel), b = fresh.querySelector(sel);
      if (a && b && a.innerHTML !== b.innerHTML) { a.innerHTML = b.innerHTML; if (sel === '[data-area]') bindArea(m); }
    });
    // Feed: slide in payments we haven't shown yet.
    var feed = root.querySelector('[data-feed]');
    if (feed && m.recent) {
      var html = m.recent.map(function (t) { return activityItem(t, !seen[t.checkout_request_id]); }).join('') || '<li class="hl-empty">No payments yet. New ones appear here the moment they’re paid.</li>';
      if (feed.innerHTML.replace(/ fresh/g, '') !== html.replace(/ fresh/g, '')) feed.innerHTML = html;
      m.recent.forEach(function (t) { seen[t.checkout_request_id] = true; });
    }
  }

  function bindArea(m) {
    var svg = root.querySelector('.hl-area'); if (!svg) return;
    var tip = root.querySelector('.hl-tooltip'), cursor = svg.querySelector('.hl-cursor'), hit = svg.querySelector('.hl-hit');
    var pts = m.area, W = 640, L = 40, R = 8, step = pts.length > 1 ? (W - L - R) / (pts.length - 1) : 0;
    function show(evt) {
      var box = svg.getBoundingClientRect(); var x = (evt.clientX - box.left) / box.width * W;
      var i = Math.max(0, Math.min(pts.length - 1, Math.round((x - L) / (step || 1))));
      var px = L + i * step; cursor.setAttribute('x1', px); cursor.setAttribute('x2', px); cursor.style.opacity = 1;
      svg.querySelectorAll('.hl-dot').forEach(function (d) { d.classList.toggle('on', Number(d.getAttribute('data-i')) === i); });
      tip.hidden = false; tip.innerHTML = '<span>' + esc(m.n === 1 ? pts[i].label : dayLabel(pts[i].label, true)) + '</span><strong>' + esc(kes(pts[i].value)) + '</strong>';
      tip.style.left = (px / W * 100) + '%';
    }
    function hide() { tip.hidden = true; cursor.style.opacity = 0; svg.querySelectorAll('.hl-dot.on').forEach(function (d) { d.classList.remove('on'); }); }
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', hide);
  }

  function adoptTools() {
    var slot = root.querySelector('[data-tools]'), tools = document.querySelector('#dashboard .overview-controls');
    if (slot && tools && tools.parentNode !== slot) slot.appendChild(tools);
  }
  function mount(m) {
    var tools = document.querySelector('#dashboard .overview-controls');
    if (tools && root.contains(tools)) root.parentNode.insertBefore(tools, root.nextSibling); // keep it while rebuilding
    root.innerHTML = build(m);
    seen = {}; (m.recent || []).forEach(function (t) { seen[t.checkout_request_id] = true; });
    bindArea(m);
    if (!reduceMotion) { root.classList.remove('hl-in'); void root.offsetWidth; root.classList.add('hl-in'); }
  }

  function tick() {
    if (!root || !document.body.contains(root)) return;
    var label = root.querySelector('[data-live]');
    if (label) label.textContent = 'Live · ' + (Date.now() - lastRender < 8000 ? 'just now' : 'updated ' + ago(lastRender));
    root.querySelectorAll('[data-ago]').forEach(function (n) { var ms = Number(n.getAttribute('data-ago')); if (ms) n.textContent = ago(ms); });
  }

  function render(host, o) {
    if (!host) return;
    var m = model(o || {});
    if (!root) {
      root = document.createElement('section');
      root.className = 'hl-root';
      root.setAttribute('aria-label', 'Live overview');
      root.addEventListener('click', function (event) {
        var target = event.target.closest('[data-open]');
        if (target && typeof (o && o.open) === 'function') o.open(target.getAttribute('data-open'));
      });
    }
    // The host's contents are redrawn on every refresh; keep this one node.
    if (root.parentNode !== host || host.firstChild !== root) host.insertBefore(root, host.firstChild);
    if (!root.firstChild) mount(m); else update(m);
    adoptTools();
    document.body.classList.add('home-live-on');
    lastRender = Date.now();
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
  }

  window.FitiHomeLive = { render: render, _model: model };
}());

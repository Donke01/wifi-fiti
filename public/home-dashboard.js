/* Home page of the business dashboard: the rich overview.
 *
 * business.html calls window.FitiHome.html(ctx) from renderOverviewInsights()
 * and puts the result on the Home page. Everything shown is worked out from
 * data the dashboard already loaded (the period's sales and the workspace);
 * nothing is invented. When there is no data, a panel says so.
 *
 * ctx: { dashboard, workspace, paid (paid sales after the source filter),
 *        revenue ({granularity, buckets}), failed, sourceLabel, kes, plural,
 *        escapeHtml }
 * Cards with data-card-module open that page when clicked (business.html
 * handles the click), so the whole page is a set of shortcuts. */
(function () {
  'use strict';

  // Small line icons (24px grid, drawn with currentColor strokes).
  var ICONS = {
    cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>',
    wallet: '<path d="M4 7a2 2 0 0 1 2-2h11v3"/><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M16 13.5h2"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6M18 14a5 5 0 0 1 3 5"/>',
    router: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 17v.01M11 17v.01M8 10.5a5.5 5.5 0 0 1 8 0M5.5 8a9 9 0 0 1 13 0"/>',
    wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0"/><circle cx="12" cy="19.5" r=".8"/>',
    fee: '<circle cx="12" cy="12" r="9"/><path d="M9 15l6-6"/><circle cx="9.5" cy="9.5" r=".9"/><circle cx="14.5" cy="14.5" r=".9"/>',
    box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    ticket: '<path d="M4 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v1h16v-1a2 2 0 0 1 0-4v0a2 2 0 0 0 0-4V7H4z"/><path d="M14 7v10" stroke-dasharray="2 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M7 17L17 7M9 7h8v8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    pin: '<path d="M12 21s7-6.2 7-11.2A7 7 0 0 0 5 9.8C5 14.8 12 21 12 21z"/><circle cx="12" cy="10" r="2.5"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
    pie: '<path d="M12 3v9h9"/><path d="M20.5 15A9 9 0 1 1 9 3.5"/>',
    bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    users: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'
  };
  function icon(name, size) {
    var px = size || 18;
    return '<svg class="hd-icon" width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>';
  }

  var TONES = ['#1769d8', '#078d9b', '#7a5cd6', '#e08a1e', '#d6477a', '#168c62'];
  var SOURCE_NAMES = { fiti: 'Wi-Fi Fiti collection', own: 'Own Till / PayBill', c2b: 'Own Till / PayBill', tuma: 'Tuma', tuma_direct: 'Tuma' };

  function parseTime(raw) {
    var text = String(raw || '');
    var date = new Date(/(?:Z|[+-]\d\d:?\d\d)$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function dayKey(date) { return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate(); }
  function sum(rows) { return rows.reduce(function (total, row) { return total + Number(row.amount || 0); }, 0); }
  function group(rows, keyOf) {
    var map = {}; var order = [];
    rows.forEach(function (row) {
      var key = keyOf(row) || 'Not named';
      if (!map[key]) { map[key] = { name: key, amount: 0, count: 0 }; order.push(key); }
      map[key].amount += Number(row.amount || 0); map[key].count += 1;
    });
    return order.map(function (key) { return map[key]; }).sort(function (a, b) { return b.amount - a.amount || b.count - a.count; });
  }
  function ago(date, now) {
    var seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
    if (seconds < 7 * 86400) return Math.floor(seconds / 86400) + ' d ago';
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function phoneText(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(0, 4) + ' ••• ' + digits.slice(-3) : (digits || 'Voucher / no phone');
  }
  function shortMoney(value) {
    var n = Number(value || 0);
    if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (Math.round(n / 100) / 10) + 'k';
    return String(Math.round(n));
  }

  function spark(values, tone) {
    var max = Math.max.apply(null, [1].concat(values)); var n = values.length;
    if (n < 2) return '';
    var points = values.map(function (value, i) { return (Math.round(i / (n - 1) * 100 * 10) / 10) + ',' + (Math.round((26 - value / max * 24) * 10) / 10); });
    return '<svg class="hd-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + points.join(' ') + ' 100,28 0,28" fill="' + tone + '" fill-opacity=".12" stroke="none"/><polyline points="' + points.join(' ') + '" fill="none" stroke="' + tone + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
  }

  function tile(ctx, o) {
    var attr = o.module ? ' data-card-module="' + o.module + '" tabindex="0" role="button" aria-label="Open ' + o.label + ' details"' : '';
    return '<article class="hd-tile" style="--tone:' + o.tone + '"' + attr + '><div class="hd-tile-top"><span class="hd-chip">' + icon(o.icon, 17) + '</span><div class="overview-kpi-label">' + o.label + '</div></div>' +
      '<div class="hd-tile-value">' + o.value + '</div><div class="hd-tile-foot">' + (o.delta || '') + '<span>' + o.note + '</span></div>' + (o.bar != null ? '<div class="hd-meter"><i style="width:' + Math.max(0, Math.min(100, o.bar)) + '%"></i></div>' : '') + (o.spark || '') + '</article>';
  }
  function delta(now, before, unit) {
    if (!before && !now) return '';
    if (!before) return '<b class="hd-delta up">new</b>';
    var pct = Math.round((now - before) / before * 100);
    if (pct > 500) return '<b class="hd-delta up">▲ 5x+</b>';
    return '<b class="hd-delta ' + (pct >= 0 ? 'up' : 'down') + '">' + (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%' + (unit || '') + '</b>';
  }
  function panel(title, iconName, body, extra) {
    return '<section class="hd-panel"><header><h3>' + icon(iconName, 16) + title + '</h3>' + (extra || '') + '</header>' + body + '</section>';
  }
  function empty(text) { return '<p class="hd-empty">' + text + '</p>'; }
  function shareList(rows, ctx, total, limit) {
    if (!rows.length) return empty('Nothing yet.');
    return '<ul class="hd-shares">' + rows.slice(0, limit || 5).map(function (row, i) {
      var pct = total > 0 ? Math.round(row.amount / total * 100) : 0;
      return '<li><div class="hd-share-row"><span class="hd-dot" style="background:' + TONES[i % TONES.length] + '"></span><span class="hd-share-name">' + ctx.escapeHtml(row.name) + '</span><b>' + ctx.kes(row.amount) + '</b></div>' +
        '<div class="hd-bar"><i style="width:' + Math.max(2, pct) + '%;background:' + TONES[i % TONES.length] + '"></i></div><small>' + ctx.plural(row.count, 'sale') + ' · ' + pct + '%</small></li>';
    }).join('') + '</ul>';
  }

  function html(ctx) {
    var d = ctx.dashboard || {}; var w = ctx.workspace || {}; var kes = ctx.kes; var plural = ctx.plural; var esc = ctx.escapeHtml;
    var failed = Boolean(ctx.failed); var now = Date.now();
    var gross = Number(d.gross || 0); var fee = Number(d.platformFee || 0);
    var net = d.netToBusiness != null ? Number(d.netToBusiness) : gross - fee;
    var payments = Number(d.payments || 0); var customers = Number(d.customers || 0);
    var all = (d.transactions || []); var paidAll = all.filter(function (tx) { return String(tx.status || '').toLowerCase() === 'paid'; });
    var paid = ctx.paid || paidAll;
    var locations = w.locations || []; var packages = w.packages || [];
    var online = locations.filter(function (l) { return String(l.router_status || '').toLowerCase() === 'online'; }).length;
    var buckets = (ctx.revenue && ctx.revenue.buckets) || [];

    // Today against yesterday, from the sales list (local days).
    var today = new Date(); var yesterday = new Date(now - 86400000);
    var todaySales = paidAll.filter(function (tx) { var t = parseTime(tx.created_at); return t && dayKey(t) === dayKey(today); });
    var yesterdaySales = paidAll.filter(function (tx) { var t = parseTime(tx.created_at); return t && dayKey(t) === dayKey(yesterday); });
    var todayTotal = sum(todaySales); var yesterdayTotal = sum(yesterdaySales);

    var avgSale = payments ? gross / payments : 0;
    var bestBucket = buckets.reduce(function (best, bucket) { return bucket.revenueKes > (best ? best.revenueKes : 0) ? bucket : best; }, null);
    var feeShare = gross ? Math.round(fee / gross * 1000) / 10 : 0;

    var tiles = [
      tile(ctx, { icon: 'cash', tone: '#1769d8', label: 'Gross sales', value: failed ? '—' : kes(gross), note: payments ? plural(payments, 'payment') : 'No payments yet', module: 'money', spark: spark(buckets.map(function (b) { return b.revenueKes; }), '#1769d8') }),
      tile(ctx, { icon: 'wallet', tone: '#168c62', label: 'Net to business', value: failed ? '—' : kes(net), note: gross ? 'After ' + (feeShare ? feeShare + '% fee' : 'no platform fee') : 'Nothing earned yet', bar: gross ? net / gross * 100 : null, module: 'money' }),
      tile(ctx, { icon: 'fee', tone: '#e08a1e', label: 'Platform fee', value: failed ? '—' : kes(fee), note: fee ? 'Wi-Fi Fiti collection fee' : 'No platform fee in this period', module: 'money' }),
      tile(ctx, { icon: 'bolt', tone: '#7a5cd6', label: 'Today', value: failed ? '—' : kes(todayTotal), delta: delta(todayTotal, yesterdayTotal, ''), note: plural(todaySales.length, 'sale') + ' · yesterday ' + kes(yesterdayTotal), module: 'money' }),
      tile(ctx, { icon: 'receipt', tone: '#078d9b', label: 'Average sale', value: failed ? '—' : kes(Math.round(avgSale)), note: bestBucket && bestBucket.revenueKes ? 'Best ' + (ctx.revenue.granularity === 'hour' ? 'hour' : ctx.revenue.granularity === 'week' ? 'week' : 'day') + ': ' + esc(bestBucket.label) : 'Per completed payment', module: 'money' }),
      tile(ctx, { icon: 'people', tone: '#d6477a', label: 'Customers', value: failed ? '—' : String(customers.toLocaleString()), note: 'Different devices that paid', module: 'customers' }),
      tile(ctx, { icon: 'router', tone: online ? '#168c62' : '#bd3852', label: 'System insights', value: '<span class="overview-status">' + (online ? 'Online' : 'Offline') + '</span>', note: online + ' of ' + plural(locations.length, 'router') + ' online · ' + Number(w.monthlyActiveDevices || 0) + ' active devices', bar: locations.length ? online / locations.length * 100 : null, module: 'routers' }),
      tile(ctx, { icon: 'box', tone: '#1769d8', label: 'Packages', value: String(packages.length), note: packages.length ? 'On sale across your routers' : 'Add your first package', module: 'packages' })
    ].join('');

    // Revenue chart: bars with a scale, the average line and the peak marked.
    var max = Math.max.apply(null, [0].concat(buckets.map(function (b) { return b.revenueKes; })));
    var total = sum(paid);
    var activeBuckets = buckets.filter(function (b) { return b.revenueKes > 0; }).length;
    var chartTitle = ctx.revenue && ctx.revenue.granularity === 'hour' ? 'Revenue today, per hour' : ctx.revenue && ctx.revenue.granularity === 'week' ? 'Revenue per week' : 'Revenue per day';
    var chart;
    if (failed) chart = '<div class="module-empty"><strong>Sales could not be loaded</strong>Use Refresh overview to try again.</div>';
    else if (!paid.length) chart = '<div class="module-empty"><strong>No paid sales in this view</strong>' + (ctx.sourceLabel ? 'No ' + esc(ctx.sourceLabel) + ' payments in this period.' : 'New completed payments will appear here.') + '</div>';
    else {
      var every = Math.max(1, Math.ceil(buckets.length / 7));
      var avg = buckets.length ? total / buckets.length : 0;
      chart = '<div class="hd-chart" role="img" aria-label="' + chartTitle + ', total ' + kes(total) + '"><div class="hd-axis"><span>' + shortMoney(max) + '</span><span>' + shortMoney(max / 2) + '</span><span>0</span></div><div class="hd-plot">' +
        '<i class="hd-avg" style="bottom:' + (max ? Math.round(avg / max * 100) : 0) + '%"><em>avg ' + shortMoney(avg) + '</em></i><div class="hd-cols">' +
        buckets.map(function (b, i) {
          var peak = bestBucket && b === bestBucket && b.revenueKes > 0;
          return '<span class="hd-col' + (peak ? ' peak' : '') + '"><i style="height:calc((100% - 18px) * ' + (max > 0 ? Math.max(b.revenueKes ? 0.03 : 0.01, b.revenueKes / max) : 0.01).toFixed(3) + ')" title="' + esc(b.label) + ' · ' + kes(b.revenueKes) + ' · ' + plural(b.payments, 'payment') + '"></i><u>' + (i % every === 0 ? esc(b.label.replace('w/c ', '')) : '') + '</u></span>';
        }).join('') + '</div></div></div>' +
        '<div class="hd-chart-sum"><span><b>' + kes(total) + '</b> total</span><span><b>' + kes(Math.round(avg)) + '</b> average</span><span><b>' + activeBuckets + '</b> of ' + buckets.length + ' with sales</span></div>';
    }

    // Busiest hours (local time), from paid sales.
    var hours = []; for (var h = 0; h < 24; h += 1) hours.push(0);
    paid.forEach(function (tx) { var t = parseTime(tx.created_at); if (t) hours[t.getHours()] += 1; });
    var hourMax = Math.max.apply(null, [0].concat(hours));
    var peakHour = hourMax ? hours.indexOf(hourMax) : -1;
    var hourBody = hourMax ? '<div class="hd-hours" role="img" aria-label="Payments by hour of day">' + hours.map(function (count, hour) {
      var level = count ? Math.max(1, Math.ceil(count / hourMax * 4)) : 0;
      return '<i class="l' + level + '" title="' + String(hour).padStart(2, '0') + ':00 · ' + plural(count, 'payment') + '"></i>';
    }).join('') + '</div><div class="hd-hours-scale"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div><p class="hd-note">Busiest around <b>' + String(peakHour).padStart(2, '0') + ':00</b> with ' + plural(hourMax, 'payment') + '.</p>' : empty('Hours fill in as customers pay.');

    // Payment status ring.
    var counts = { paid: 0, pending: 0, failed: 0 };
    all.forEach(function (tx) { var s = String(tx.status || '').toLowerCase(); if (s === 'paid') counts.paid += 1; else if (s === 'pending' || s === 'initiated' || s === 'processing') counts.pending += 1; else counts.failed += 1; });
    var attempts = counts.paid + counts.pending + counts.failed; var rate = attempts ? Math.round(counts.paid / attempts * 100) : 0;
    var p1 = attempts ? counts.paid / attempts * 100 : 0; var p2 = attempts ? p1 + counts.pending / attempts * 100 : 0;
    var ring = attempts ? '<div class="hd-ring-wrap"><div class="hd-ring" style="background:conic-gradient(#168c62 0 ' + p1 + '%,#e0a21b ' + p1 + '% ' + p2 + '%,#d6566b ' + p2 + '% 100%)"><span><b>' + rate + '%</b>paid</span></div>' +
      '<ul class="hd-legend"><li><i style="background:#168c62"></i>Paid <b>' + counts.paid + '</b></li><li><i style="background:#e0a21b"></i>Waiting <b>' + counts.pending + '</b></li><li><i style="background:#d6566b"></i>Not completed <b>' + counts.failed + '</b></li></ul></div>' : empty('No payment attempts in this period.');

    // Breakdowns.
    var byRouter = group(paid, function (tx) { return tx.location_name; });
    var byPackage = group(paid, function (tx) { return tx.package_name; });
    var bySource = group(paidAll, function (tx) { return SOURCE_NAMES[String(tx.payment_source || '')] || 'Other'; });

    // Recent sales.
    var recent = (d.recentPayments && d.recentPayments.length ? d.recentPayments : all).slice(0, 7);
    var recentBody = failed ? empty('Sales could not be loaded.') : recent.length ? '<ul class="hd-feed">' + recent.map(function (tx) {
      var status = String(tx.status || '').toLowerCase(); var t = parseTime(tx.created_at);
      var tone = status === 'paid' ? 'ok' : (status === 'pending' || status === 'initiated' || status === 'processing') ? 'wait' : 'bad';
      return '<li><span class="hd-feed-ico ' + tone + '">' + icon(status === 'paid' ? 'check' : 'clock', 15) + '</span><div><b>' + esc(tx.package_name || 'Package') + '</b><small>' + esc(phoneText(tx.phone)) + ' · ' + esc(tx.location_name || 'Router') + '</small></div><div class="hd-feed-end"><b>' + kes(tx.amount) + '</b><small>' + (t ? ago(t, now) : '') + '</small></div></li>';
    }).join('') + '</ul>' : empty('Your first sale will show up here.');

    // Router health.
    var routerBody = locations.length ? '<ul class="hd-routers">' + locations.slice(0, 6).map(function (l) {
      var status = String(l.router_status || 'waiting').toLowerCase(); var up = status === 'online';
      var seen = parseTime(l.last_successful_sync_at);
      return '<li><span class="hd-router-ico ' + (up ? 'ok' : 'off') + '">' + icon('router', 16) + '</span><div><b>' + esc(l.name || l.router_name || 'Router') + '</b><small>' + (seen ? 'Checked in ' + ago(seen, now) : 'Not connected yet') + '</small></div><span class="hd-state ' + (up ? 'ok' : 'off') + '">' + (up ? 'Online' : status === 'waiting' ? 'Waiting' : 'Offline') + '</span></li>';
    }).join('') + '</ul>' + (locations.length > 6 ? '<p class="hd-note">+' + (locations.length - 6) + ' more on the Routers page.</p>' : '') : empty('Add a router to start selling.');


    // Needs your attention: things worth acting on, worked out from the data.
    var items = [];
    var offline = locations.filter(function (l) { return String(l.router_status || '').toLowerCase() !== 'online'; });
    offline.slice(0, 3).forEach(function (l) {
      var seen = parseTime(l.last_successful_sync_at);
      items.push({ tone: 'bad', pill: 'Offline', title: esc(l.name || l.router_name || 'Router') + ' is not online', text: seen ? 'Last checked in ' + ago(seen, now) + '. Customers cannot connect until it is back.' : 'It has not checked in yet. Finish its setup to start selling.', action: 'Open routers', module: 'routers' });
    });
    if (!failed && attempts >= 5 && rate < 80) items.push({ tone: 'warn', pill: 'At risk', title: 'Only ' + rate + '% of payment attempts complete', text: plural(counts.failed, 'attempt') + ' did not go through in this period. Check the transactions for the reasons.', action: 'Review sales', module: 'money' });
    if (!failed && counts.pending > 0) items.push({ tone: 'warn', pill: 'Waiting', title: plural(counts.pending, 'payment') + ' still waiting', text: 'Customers who started paying but have not confirmed yet.', action: 'Open sales', module: 'money' });
    if (!packages.length) items.push({ tone: 'warn', pill: 'Set up', title: 'No packages on sale', text: 'Customers need at least one package to buy.', action: 'Add package', module: 'packages' });
    if (!failed && locations.length && online && !todaySales.length && now - new Date().setHours(12, 0, 0, 0) > 0) items.push({ tone: 'info', pill: 'Quiet', title: 'No sales yet today', text: 'Yesterday you made ' + kes(yesterdayTotal) + '.', action: 'See customers', module: 'customers' });
    var attention = items.length ? '<ul class="hd-attn">' + items.slice(0, 4).map(function (it) {
      return '<li class="' + it.tone + '"><div class="hd-attn-head"><b>' + it.title + '</b><span class="hd-pill ' + it.tone + '">' + it.pill + '</span></div><p>' + it.text + '</p><button type="button" class="hd-btn" data-card-module="' + it.module + '">' + it.action + '</button></li>';
    }).join('') + '</ul>' : '<div class="hd-allgood">' + icon('check', 22) + '<b>All clear</b><span>Your routers are online and payments are going through.</span></div>';

    var actions = [['routers', 'router', 'Routers', 'Status and setup'], ['packages', 'ticket', 'Packages & vouchers', 'Prices and codes'], ['customers', 'users', 'Customers', 'Who paid and who is online'], ['money', 'wallet', 'Money', 'Sales and payouts'], ['portal', 'wifi', 'Customer portal', 'Look and wording'], ['sms', 'trend', 'SMS', 'Messages to customers']]
      .map(function (a) { return '<button type="button" class="hd-action" data-card-module="' + a[0] + '"><span class="hd-chip">' + icon(a[1], 18) + '</span><span><b>' + a[2] + '</b><small>' + a[3] + '</small></span>' + icon('arrow', 14) + '</button>'; }).join('');

    var attnHead = items.length ? '<span class="hd-count">' + Math.min(items.length, 4) + '</span>' : '';
    return '<div class="hd-tiles">' + tiles + '</div>' +
      '<div class="hd-grid hd-main"><section class="hd-panel hd-wide"><header><h3>' + icon('chart', 16) + chartTitle + '</h3><div class="overview-legend"><span>' + (ctx.sourceLabel ? 'Revenue · ' + esc(ctx.sourceLabel) : 'Revenue') + '</span></div></header>' + chart + '</section>' +
      panel('Needs your attention', 'bolt', attention, attnHead) + '</div>' +
      '<div class="hd-grid hd-three">' + panel('Recent sales', 'receipt', recentBody, '<button type="button" class="hd-link" data-card-module="money">All sales</button>') + panel('Router health', 'wifi', routerBody, '<button type="button" class="hd-link" data-card-module="routers">Manage</button>') + panel('Payment success', 'pie', ring + '<h4 class="hd-sub">Busiest hours</h4>' + hourBody) + '</div>' +
      '<div class="hd-grid hd-three">' + panel('Sales by router', 'pin', shareList(byRouter, ctx, sum(paid), 5)) + panel('Top packages', 'ticket', shareList(byPackage, ctx, sum(paid), 5)) + panel('How customers pay', 'wallet', shareList(bySource, ctx, sum(paidAll), 4)) + '</div>' +
      '<div class="hd-actions" aria-label="Go to">' + actions + '</div>';
  }

  window.FitiHome = { html: html, icon: icon };
})();

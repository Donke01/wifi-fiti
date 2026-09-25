/* Platform admin: "Demo requests" tab. Lists leads from the Request a demo
   form, lets the operator move them through the pipeline, and shows recent
   live-demo payments. Loaded after admin-modules.js on platform-admin.html. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var nav = document.querySelector('.tabs');
  if (!app || !nav) return;
  var esc = function (value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var password = function () { return String((document.getElementById('password') || {}).value || ''); };
  var request = function (path, options) {
    options = options || {};
    var headers = Object.assign({ 'x-admin-password': password(), 'Content-Type': 'application/json' }, options.headers || {});
    return fetch(path, Object.assign({ cache: 'no-store' }, options, { headers: headers })).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) { if (!response.ok) throw new Error(body.error || 'Request failed'); return body; });
    });
  };
  var LABELS = { new: 'New', contacted: 'Contacted', demo_done: 'Demo done', signed_up: 'Signed up', lost: 'Lost' };
  var style = document.createElement('style');
  style.textContent = '.demo-leads{display:grid;gap:10px}.demo-lead{padding:14px;border:1px solid var(--line);border-radius:12px;background:#fbfdff}' +
    '.demo-lead header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:baseline}.demo-lead h4{margin:0;font-size:16px}' +
    '.demo-lead .meta{color:var(--muted);font-size:13px}.demo-lead .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}' +
    '.demo-lead select,.demo-lead textarea{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:9px;background:#fff}.demo-lead textarea{flex:1;min-width:200px;min-height:38px}' +
    '.demo-badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef4ff;color:#1759bc;font-size:12px;font-weight:700}' +
    '.demo-badge.new{background:#fff3dc;color:#8a5a00}.demo-badge.signed_up{background:#e6f7f0;color:#08785b}.demo-badge.lost{background:#f3f4f6;color:#6b7280}' +
    '.demo-filter{display:flex;flex-wrap:wrap;gap:6px}.demo-filter button.active{outline:2px solid var(--blue)}' +
    '.demo-pay-table{width:100%;border-collapse:collapse;font-size:13px}.demo-pay-table td,.demo-pay-table th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}';
  document.head.appendChild(style);

  var tab = document.createElement('button'); tab.type = 'button'; tab.dataset.moduleTab = 'demo'; tab.textContent = 'Demo requests';
  nav.appendChild(tab);
  var panel = document.createElement('section'); panel.className = 'panel admin-module'; panel.id = 'demo-module';
  panel.innerHTML = '<h2>Demo requests</h2><p class="sub">Leads from the "Request a demo" page and recent live-demo payments.</p>' +
    '<div id="demo-counts" class="module-grid"></div>' +
    '<div class="module-toolbar" style="margin-top:14px"><div class="demo-filter" id="demo-filter"></div><button type="button" class="secondary" id="demo-refresh">Refresh</button></div>' +
    '<div id="demo-error" class="module-error"></div><div class="demo-leads" id="demo-leads"></div>' +
    '<div class="section"><h3>Live demo payments</h3><p class="sub" id="demo-pay-mode"></p><div class="table-wrap" id="demo-payments"></div></div>';
  var anchor = document.getElementById('pppoe-module') || document.getElementById('fiti-signal-module') || app.querySelector('.layout');
  anchor.insertAdjacentElement('afterend', panel);

  var state = { requests: [], counts: {}, filter: 'open' };

  var layout = app.querySelector('.layout');
  function activate() {
    if (layout) layout.style.display = 'none';
    document.querySelectorAll('.admin-module').forEach(function (p) { p.classList.toggle('active', p === panel); });
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('active', b === tab); });
  }
  function render() {
    var c = state.counts;
    document.getElementById('demo-counts').innerHTML = Object.keys(LABELS).map(function (k) {
      return '<div class="module-card"><span>' + LABELS[k] + '</span><strong>' + esc(c[k] || 0) + '</strong></div>';
    }).join('');
    var filters = [['open', 'Open'], ['all', 'All']].concat(Object.keys(LABELS).map(function (k) { return [k, LABELS[k]]; }));
    document.getElementById('demo-filter').innerHTML = filters.map(function (f) {
      return '<button type="button" class="secondary' + (state.filter === f[0] ? ' active' : '') + '" data-filter="' + f[0] + '">' + esc(f[1]) + '</button>';
    }).join('');
    var rows = state.requests.filter(function (r) {
      if (state.filter === 'all') return true;
      if (state.filter === 'open') return r.status === 'new' || r.status === 'contacted' || r.status === 'demo_done';
      return r.status === state.filter;
    });
    document.getElementById('demo-leads').innerHTML = rows.length ? rows.map(function (r) {
      var when = [r.preferredDate, r.preferredSlotLabel].filter(Boolean).join(' · ') || 'Any time';
      return '<article class="demo-lead" data-id="' + esc(r.id) + '"><header><h4>' + esc(r.name) + ' <span class="demo-badge ' + esc(r.status) + '">' + esc(LABELS[r.status] || r.status) + '</span></h4>' +
        '<span class="meta">' + esc(new Date(r.createdAt).toLocaleString('en-KE')) + '</span></header>' +
        '<div class="meta">' + esc(r.businessTypeLabel) + ' · ' + esc(r.town) + ' · ' + esc(r.locations) + ' location' + (r.locations === 1 ? '' : 's') + (r.routerModel ? ' · ' + esc(r.routerModel) : '') + '</div>' +
        '<div class="meta">Prefers <b>' + esc(r.contactLabel) + '</b> · ' + esc(when) + (r.estimateKes ? ' · est. KES ' + Number(r.estimateKes).toLocaleString('en-KE') + '/mo' : '') + '</div>' +
        (r.notes ? '<p style="margin:8px 0 0">' + esc(r.notes) + '</p>' : '') +
        '<div class="row"><a class="secondary" href="tel:+' + esc(r.phone) + '">Call ' + esc(r.phoneDisplay) + '</a>' +
        '<a class="secondary" href="' + esc(r.whatsappUrl) + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' +
        (r.email ? '<a class="secondary" href="mailto:' + esc(r.email) + '">Email</a>' : '') +
        '<span class="meta">Alerted: ' + esc(r.notified || 'pending') + '</span></div>' +
        '<div class="row"><select data-field="status" aria-label="Status">' + Object.keys(LABELS).map(function (k) { return '<option value="' + k + '"' + (k === r.status ? ' selected' : '') + '>' + LABELS[k] + '</option>'; }).join('') + '</select>' +
        '<textarea data-field="adminNotes" placeholder="Notes for your team" aria-label="Notes">' + esc(r.adminNotes || '') + '</textarea>' +
        '<button type="button" data-save>Save</button></div></article>';
    }).join('') : '<p class="sub">No demo requests here yet.</p>';
  }
  function load() {
    var error = document.getElementById('demo-error'); error.textContent = 'Loading…';
    return Promise.all([request('/api/admin/demo/requests'), request('/api/admin/demo/payments')]).then(function (result) {
      state.requests = result[0].requests || []; state.counts = result[0].counts || {};
      render();
      var pay = result[1];
      document.getElementById('demo-pay-mode').textContent = pay.live ? 'Live mode: prospects receive a real Tuma STK prompt.' : 'Practice mode: Tuma is not configured or DEMO_LIVE_PAYMENTS=off, so no money moves.';
      var list = pay.payments || [];
      document.getElementById('demo-payments').innerHTML = list.length ? '<table class="demo-pay-table"><thead><tr><th>When</th><th>Phone</th><th>Mode</th><th>KES</th><th>Status</th><th>Receipt / reason</th></tr></thead><tbody>' +
        list.map(function (p) { return '<tr><td>' + esc(new Date(p.createdAt).toLocaleString('en-KE')) + '</td><td>' + esc(p.phone) + '</td><td>' + esc(p.mode) + '</td><td>' + esc(p.amount) + '</td><td>' + esc(p.status) + '</td><td>' + esc(p.receipt || p.reason || '') + '</td></tr>'; }).join('') +
        '</tbody></table>' : '<p class="sub">Nobody has tried the live demo yet.</p>';
      error.textContent = '';
    }).catch(function (e) { error.textContent = e.message; });
  }

  tab.addEventListener('click', function () { activate(); load(); });
  document.getElementById('demo-refresh').addEventListener('click', load);
  panel.addEventListener('click', function (event) {
    var f = event.target.closest('[data-filter]');
    if (f) { state.filter = f.dataset.filter; render(); return; }
    var save = event.target.closest('[data-save]');
    if (!save) return;
    var card = save.closest('[data-id]');
    save.disabled = true; save.textContent = 'Saving…';
    request('/api/admin/demo/requests/' + encodeURIComponent(card.dataset.id), {
      method: 'PATCH',
      body: JSON.stringify({ status: card.querySelector('[data-field=status]').value, adminNotes: card.querySelector('[data-field=adminNotes]').value }),
    }).then(load).catch(function (e) { document.getElementById('demo-error').textContent = e.message; save.disabled = false; save.textContent = 'Save'; });
  });
  // Leaving for a built-in tab hides this panel like the other modules.
  document.querySelectorAll('.tabs [data-tab], .tabs [data-module-tab]').forEach(function (button) {
    if (button === tab) return;
    button.addEventListener('click', function () { panel.classList.remove('active'); tab.classList.remove('active'); if (layout) layout.style.display = ''; });
  });
}());

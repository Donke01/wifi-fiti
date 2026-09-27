/* Guided setup for new tenants.
 *  1. Choose services: shows "Pay now KES 0" on the trial and what it renews
 *     at, then "Save and continue" (no payment).
 *  2. Set up payments: opens Payment integrations with Tuma chosen and asks
 *     where Tuma should send the money.
 * Plus a setup checklist on Overview that always shows the next step. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function api(path, options) {
    options = options || {};
    var token = ''; try { token = localStorage.getItem('fiti_business_token') || ''; } catch (e) { token = ''; }
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {});
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) { var error = new Error(body.error || 'Something went wrong. Please try again.'); error.status = response.status; throw error; }
        return body;
      });
    });
  }
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key]; else if (key === 'class') node.className = attrs[key]; else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }
  function kes(n) { return 'KES ' + Math.round(Number(n) || 0).toLocaleString('en-KE'); }
  function day(raw) { var d = new Date(raw); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
  function daysLeft(raw) { var ms = new Date(raw).getTime() - Date.now(); return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86400000)) : 0; }
  // Same formula as the server (NETWORK_SERVICE_PRICING).
  function price(h, p) { var hk = h ? 1000 + Math.max(0, h - 100) * 10 : 0; var pk = p ? (p < 35 ? 500 : p * 15) : 0; return { hotspot: hk, pppoe: pk, total: hk + pk }; }

  var style = document.createElement('style');
  style.textContent = [
    '.gs-box{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}',
    '.gs-cell{padding:14px 16px;border:1px solid var(--line);border-radius:16px;background:var(--surface);text-align:left}',
    '.gs-cell small{display:block;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
    '.gs-cell b{display:block;margin-top:4px;font-size:26px;letter-spacing:-.04em;color:var(--ink)}',
    '.gs-cell span{display:block;margin-top:2px;color:var(--muted);font-size:13px}',
    '.gs-now b{color:var(--good)}',
    '.gs-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:4px 0 6px}',
    '.gs-msg{min-height:18px;color:var(--muted);font-size:13px}',
    '.gs-step{display:inline-flex;align-items:center;gap:8px;margin:0 0 10px;padding:6px 12px;border-radius:999px;background:rgba(23,105,216,.1);color:var(--blue);font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}',
    '.gs-banner{margin:0 0 14px;padding:14px 16px;border:1px solid rgba(23,105,216,.3);border-radius:16px;background:rgba(23,105,216,.06);text-align:left}',
    '.gs-banner b{display:block;color:var(--ink)}.gs-banner span{color:var(--muted);font-size:14px}',
    '.gs-list{max-width:760px;margin:22px auto 0;padding:18px;border:1px solid var(--line);border-radius:20px;background:var(--surface);text-align:left}',
    '.gs-list h3{margin:0 0 4px;font-size:18px;color:var(--ink)}.gs-list>p{margin:0 0 12px;color:var(--muted);font-size:14px}',
    '.gs-item{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}',
    '.gs-dot{display:grid;place-items:center;flex:0 0 28px;height:28px;border-radius:50%;border:2px solid var(--line);color:var(--muted);font-size:13px;font-weight:900}',
    '.gs-item.done .gs-dot{border-color:var(--good);background:var(--good);color:#fff}',
    '.gs-item.next .gs-dot{border-color:var(--blue);color:var(--blue)}',
    '.gs-item div{flex:1}.gs-item strong{display:block;color:var(--ink);font-size:15px}.gs-item small{color:var(--muted);font-size:13px}',
    '.gs-item.done strong{color:var(--muted);text-decoration:line-through}',
    '@media (max-width:620px){.gs-box{grid-template-columns:1fr}.gs-item{flex-wrap:wrap}.gs-item button{width:100%}}',
  ].join('');
  document.head.appendChild(style);

  var workspace = null;
  function refresh() {
    return api('/api/business/me').then(function (data) { workspace = data; renderServicesStep(); renderChecklist(); }).catch(function () { /* signed out */ });
  }

  // ---- Step 1: choose services -------------------------------------------
  var stepBox = null;
  function renderServicesStep() {
    var section = $('network-services-section'); var quote = $('network-service-quote');
    if (!section || !quote || !workspace) return;
    var trial = workspace.services && workspace.services.trial;
    var onTrial = Boolean(trial && trial.active);
    var hIn = $('service-hotspot-concurrent'); var pIn = $('service-pppoe-users'); var pay = $('network-service-pay');
    var plan = workspace.servicePlan || {};
    if (hIn && !hIn.value && plan.hotspotConcurrent) hIn.value = plan.hotspotConcurrent;
    if (pIn && !pIn.value && plan.pppoeUsers) pIn.value = plan.pppoeUsers;
    if (!stepBox) {
      stepBox = h('div', {});
      var connection = quote.closest('.connection') || quote.parentNode;
      connection.parentNode.insertBefore(stepBox, connection.nextSibling);
      [hIn, pIn].forEach(function (input) { if (input) input.addEventListener('input', paint); });
    }
    function paint() {
      var hv = Math.max(0, Math.floor(Number(hIn && hIn.value) || 0)); var pv = Math.max(0, Math.floor(Number(pIn && pIn.value) || 0));
      var cost = price(hv, pv); stepBox.replaceChildren();
      if (!onTrial) return;
      stepBox.appendChild(h('p', { class: 'gs-step', text: 'Step 1 of 2 · Choose your services' }));
      var parts = [cost.hotspot ? 'Hotspot ' + kes(cost.hotspot) : '', cost.pppoe ? 'PPPoE ' + kes(cost.pppoe) : ''].filter(Boolean).join(' + ');
      stepBox.appendChild(h('div', { class: 'gs-box' }, [
        h('div', { class: 'gs-cell gs-now' }, [h('small', { text: 'Pay now' }), h('b', { text: 'KES 0' }), h('span', { text: 'Free trial · ' + daysLeft(trial.endsAt) + ' days left' })]),
        h('div', { class: 'gs-cell' }, [h('small', { text: 'Renews on ' + day(trial.endsAt) }), h('b', { text: cost.total ? kes(cost.total) : 'KES 0' }), h('span', { text: cost.total ? 'per month · ' + parts : 'Enter your users above' })]),
      ]));
      var msg = h('p', { class: 'gs-msg' });
      var save = h('button', { type: 'button', text: 'Save and continue' });
      save.disabled = !cost.total;
      save.addEventListener('click', function () {
        save.disabled = true; msg.textContent = 'Saving…';
        api('/api/business/network-services/plan', { method: 'POST', body: JSON.stringify({ hotspotConcurrent: hv, pppoeUsers: pv }) }).then(function (result) {
          workspace.servicePlan = result.plan; msg.textContent = 'Saved. Nothing to pay until ' + day(trial.endsAt) + '.';
          goToPayments();
        }).catch(function (error) { msg.textContent = error.message; save.disabled = false; });
      });
      stepBox.appendChild(h('div', { class: 'gs-actions' }, [save]));
      stepBox.appendChild(msg);
    }
    paint();
    // On the trial, paying is optional: keep the button but make it secondary.
    if (pay) {
      if (onTrial) { pay.classList.add('secondary'); pay.textContent = 'Pay early instead (starts after the trial)'; }
      else if (pay.textContent.indexOf('Pay early') === 0) { pay.classList.remove('secondary'); pay.textContent = 'Pay and activate services'; }
    }
  }

  // ---- Step 2: payments (Tuma by default) ---------------------------------
  function goToPayments() {
    // With the tiles page, step 2 is the "How customers pay you" page with
    // Tuma chosen; the gateway card and payout form open inside it.
    if (window.fitiBillingHub) { window.fitiBillingHub.open('pay', { guided: true }); return; }
    if (window.location.hash !== '#payments') window.location.hash = '#payments';
    var select = $('integration-provider');
    var tries = 0;
    (function choose() {
      if (!select || !Array.prototype.some.call(select.options, function (o) { return o.value === 'tuma'; })) { if (++tries < 20) setTimeout(choose, 250); return; }
      if (select.value !== 'tuma') {
        select.value = 'tuma'; select.dispatchEvent(new Event('change', { bubbles: true }));
        var saveButton = $('save-integration'); if (saveButton) saveButton.click();
      }
      var section = $('integrations-section');
      if (section) {
        var old = $('gs-payments-banner'); if (old) old.remove();
        var banner = h('div', { class: 'gs-banner', id: 'gs-payments-banner' }, [
          h('p', { class: 'gs-step', text: 'Step 2 of 2 · Set up payments' }),
          h('b', { text: 'Tell Tuma where to send your money.' }),
          h('span', { text: 'Choose your bank, Sacco, M‑Pesa Till or PayBill, enter the account number and your full name as on your ID, then save. Customer payments then land in your account in real time.' }),
        ]);
        var panel = section.querySelector('.panel'); section.insertBefore(banner, panel || section.firstChild);
        setTimeout(function () { (document.getElementById('tuma-payout') || section).scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 400);
      }
    }());
  }

  // ---- Overview checklist -------------------------------------------------
  var listBox = null;
  function renderChecklist() {
    var hero = $('overview'); if (!hero || !workspace) return;
    Promise.all([
      api('/api/business/integrations').catch(function () { return {}; }),
      api('/api/business/tuma/settlement').catch(function () { return {}; }),
    ]).then(function (results) {
      var integrations = results[0] || {}; var settlement = results[1] || {};
      var locations = workspace.locations || []; var packages = workspace.packages || [];
      var trial = workspace.services && workspace.services.trial;
      var routerDone = locations.some(function (l) { return l.last_router_contact_at || l.last_successful_sync_at || /online/i.test(String(l.router_status || '')); });
      var servicesDone = Boolean(workspace.servicePlan && workspace.servicePlan.chosen);
      var paymentsDone = (integrations.selected === 'tuma' && settlement.connected) || (integrations.selected && integrations.selected !== 'tuma' && integrations.status === 'ready');
      var packagesDone = packages.length > 0;
      var steps = [
        { done: routerDone, title: 'Connect your router', text: 'Pair your MikroTik so customers can see your portal.', go: 'routers' },
        { done: servicesDone, title: 'Choose your services', text: trial && trial.active ? 'Hotspot and PPPoE capacity. KES 0 now; it renews when your trial ends.' : 'Hotspot and PPPoE capacity for the month.', go: 'payments', target: 'network-services-section' },
        { done: paymentsDone, title: 'Set up payments with Tuma', text: 'Choose where customer payments land: bank, Sacco, Till or PayBill.', go: 'payments', target: 'integrations-section', tuma: true },
        { done: packagesDone, title: 'Create your packages', text: 'Set the times and prices customers can buy.', go: 'packages' },
      ];
      if (!listBox) { listBox = h('div', { class: 'gs-list', id: 'setup-checklist' }); hero.appendChild(listBox); }
      if (steps.every(function (s) { return s.done; })) { listBox.remove(); listBox = null; return; }
      listBox.replaceChildren();
      var doneCount = steps.filter(function (s) { return s.done; }).length;
      listBox.appendChild(h('h3', { text: 'Finish setting up · ' + doneCount + ' of ' + steps.length + ' done' }));
      listBox.appendChild(h('p', { text: trial && trial.active ? 'Everything is free until ' + day(trial.endsAt) + '. Pay now: KES 0.' : 'Complete these steps to start taking payments.' }));
      var nextMarked = false;
      steps.forEach(function (step, index) {
        var isNext = !step.done && !nextMarked; if (isNext) nextMarked = true;
        var button = step.done ? null : h('button', { type: 'button', class: isNext ? '' : 'secondary', text: isNext ? 'Start' : 'Open' });
        if (button) button.addEventListener('click', function () {
          if (step.tuma) { goToPayments(); return; }
          if (step.target === 'network-services-section' && window.fitiBillingHub) { window.fitiBillingHub.open('plan'); return; }
          window.location.hash = '#' + step.go;
          if (step.target) setTimeout(function () { var el = $(step.target); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 400);
        });
        listBox.appendChild(h('div', { class: 'gs-item' + (step.done ? ' done' : isNext ? ' next' : '') }, [
          h('span', { class: 'gs-dot', text: step.done ? '✓' : String(index + 1) }),
          h('div', {}, [h('strong', { text: step.title }), h('small', { text: step.text })]),
          button,
        ]));
      });
    });
  }

  window.addEventListener('hashchange', function () { setTimeout(refresh, 300); });
  var started = false;
  (function wait() {
    if ($('dashboard') && !$('dashboard').classList.contains('hidden') && $('network-services-section')) { if (!started) { started = true; refresh(); } }
    else setTimeout(wait, 500);
  }());
})();

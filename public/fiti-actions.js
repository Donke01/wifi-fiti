/*
 * Wi-Fi Fiti in-place actions.
 *
 * When the server blocks an owner request because a step is missing, it
 * replies with `needs: { action, ... }`. Instead of telling the owner to go
 * to another page, the dashboard opens a pop-up that does that step right
 * there and, when it is done, repeats the original request.
 *
 *   FitiActions.open(needs, { message }) -> Promise<boolean>   (true = done)
 *
 * Actions: subscribe (hotspot / PPPoE, new, renew or more users),
 * verify_phone, organisation, confirm_router_map, create_package.
 */
(function () {
  'use strict';
  if (window.FitiActions) return;

  var TOKEN_KEY = 'fiti_business_token';
  var PRICING = { pppoe: { floorUsers: 35, floorKes: 500, perUserKes: 15 }, hotspot: { floorConcurrent: 100, floorKes: 1000, perExtraUserKes: 10 } };
  var LABEL = { pppoe: 'PPPoE + Static IP', hotspot: 'Hotspot' };

  function api(path, options) {
    options = options || {};
    var token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { /* storage blocked */ }
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}, token ? { Authorization: 'Bearer ' + token } : {});
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) { var error = new Error(body.error || 'Something went wrong. Please try again.'); error.status = response.status; error.body = body; throw error; }
        return body;
      });
    });
  }
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'class') node.className = attrs[key];
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== false && attrs[key] != null) node.setAttribute(key, attrs[key] === true ? '' : attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }
  function kes(value) { return 'KES ' + Math.round(Number(value) || 0).toLocaleString('en-KE'); }
  function field(label, input, hint) { return h('label', { class: 'fa-field' }, [h('span', { text: label }), input, hint ? h('small', { text: hint }) : null]); }
  function price(kind, users) {
    var n = Math.max(0, Math.floor(Number(users) || 0)); if (!n) return 0;
    if (kind === 'pppoe') return n < PRICING.pppoe.floorUsers ? PRICING.pppoe.floorKes : n * PRICING.pppoe.perUserKes;
    return PRICING.hotspot.floorKes + Math.max(0, n - PRICING.hotspot.floorConcurrent) * PRICING.hotspot.perExtraUserKes;
  }
  function when(raw) { if (!raw) return ''; var d = new Date(String(raw).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(raw)) ? '' : 'Z')); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }

  var STYLE = [
    '.fa-back{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:16px;background:rgba(8,24,44,.46);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:faFade .2s ease both}',
    '.fa-card{position:relative;width:min(480px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:24px 22px 20px;border:1px solid rgba(190,212,236,.9);border-radius:22px;background:linear-gradient(160deg,#fff,#f4f9ff);box-shadow:0 30px 70px rgba(10,40,80,.3);color:#0f2742;font:14px/1.45 Inter,system-ui,-apple-system,Segoe UI,sans-serif;animation:faRise .28s cubic-bezier(.2,.8,.2,1) both}',
    '.fa-card h3{margin:0 34px 6px 0;font-size:20px;letter-spacing:-.02em}',
    '.fa-card>p{margin:0 0 14px;color:#536b85}',
    '.fa-close{position:absolute;top:14px;right:14px;width:32px;height:32px;padding:0;border:1px solid #d7e4f1;border-radius:50%;background:#fff;color:#536b85;font-size:18px;line-height:1;cursor:pointer;box-shadow:none}',
    '.fa-why{margin:0 0 14px;padding:10px 12px;border:1px solid #f3d7a2;border-radius:12px;background:#fff9ec;color:#7a5200;font-size:13px}',
    '.fa-field{display:block;margin:0 0 12px}.fa-field>span{display:block;margin-bottom:5px;color:#34506e;font-size:12px;font-weight:700}',
    '.fa-field input,.fa-field select{width:100%;box-sizing:border-box;min-height:44px;padding:10px 12px;border:1px solid #cbdced;border-radius:12px;background:#fff;color:#0f2742;font:inherit}',
    '.fa-field small{display:block;margin-top:4px;color:#6a809a;font-size:12px}',
    '.fa-seg{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 0 14px;padding:4px;border-radius:14px;background:#e8f0f9}',
    '.fa-seg button{min-height:40px;border:0;border-radius:10px;background:transparent;color:#34506e;font:inherit;font-weight:700;cursor:pointer;box-shadow:none}',
    '.fa-seg button[aria-pressed="true"]{background:#fff;color:#1157ba;box-shadow:0 2px 8px rgba(17,87,186,.15)}',
    '.fa-total{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:4px 0 14px;padding:12px 14px;border-radius:14px;background:#eef6ff;color:#1157ba}',
    '.fa-total strong{font-size:22px;letter-spacing:-.02em}.fa-total small{color:#536b85}',
    '.fa-go{width:100%;min-height:50px;border:0;border-radius:14px;background:linear-gradient(110deg,#1157ba,#1769d8 55%,#3187e6);color:#fff;font:inherit;font-size:15px;font-weight:800;cursor:pointer;box-shadow:0 12px 26px rgba(23,105,216,.28)}',
    '.fa-go[disabled]{opacity:.6;cursor:default}',
    '.fa-err{min-height:0;margin:10px 0 0;color:#b6304a;font-size:13px;font-weight:600}.fa-err:empty{display:none}',
    '.fa-note{margin:10px 0 0;color:#536b85;font-size:12px}',
    '.fa-wait{display:flex;align-items:center;gap:10px;margin:12px 0 0;padding:12px;border-radius:12px;background:#f1f7ff;color:#1157ba;font-weight:700}',
    '.fa-wait i{width:16px;height:16px;border:2px solid #b9d3f2;border-top-color:#1769d8;border-radius:50%;animation:faSpin .8s linear infinite}',
    '.fa-done{padding:18px 4px 6px;text-align:center}.fa-done b{display:grid;place-items:center;width:52px;height:52px;margin:0 auto 10px;border-radius:50%;background:#e3f8ef;color:#08785b;font-size:26px}',
    '.fa-checks{display:flex;flex-wrap:wrap;gap:8px}.fa-checks label{display:inline-flex;align-items:center;gap:6px;padding:8px 10px;border:1px solid #d7e4f1;border-radius:10px;background:#fff;font-size:13px;cursor:pointer}',
    '.fa-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '@keyframes faFade{from{opacity:0}}@keyframes faRise{from{opacity:0;transform:translateY(14px) scale(.98)}}@keyframes faSpin{to{transform:rotate(360deg)}}',
    '@media(prefers-reduced-motion:reduce){.fa-back,.fa-card,.fa-wait i{animation:none}}',
    '@media(max-width:480px){.fa-card{padding:20px 16px 16px;border-radius:18px}.fa-row{grid-template-columns:1fr}}'
  ].join('');

  function mountStyle() { if (document.getElementById('fa-style')) return; var style = h('style', { id: 'fa-style' }); style.textContent = STYLE; document.head.appendChild(style); }

  /* Pop-ups stack: a step inside a pop-up (e.g. subscribing while creating a
   * package) opens on top and returns to it. `build` fills the card and
   * calls finish(true|false). */
  var stack = [];
  function modal(title, intro, message, build) {
    mountStyle();
    return new Promise(function (resolve) {
      var body = h('div');
      var card = h('div', { class: 'fa-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
        h('button', { class: 'fa-close', type: 'button', 'aria-label': 'Close', text: '×', onclick: function () { finish(false); } }),
        h('h3', { text: title }), intro ? h('p', { text: intro }) : null, message ? h('div', { class: 'fa-why', text: message }) : null, body]);
      var back = h('div', { class: 'fa-back', onclick: function (event) { if (event.target === back) finish(false); } }, [card]);
      back.style.zIndex = String(9999 + stack.length);
      var settled = false; var cleanups = []; var entry = { finish: finish };
      function onKey(event) { if (event.key === 'Escape' && stack[stack.length - 1] === entry) finish(false); }
      function finish(ok) {
        if (settled) return; settled = true;
        cleanups.forEach(function (fn) { try { fn(); } catch (_) {} });
        document.removeEventListener('keydown', onKey); back.remove();
        stack = stack.filter(function (item) { return item !== entry; });
        resolve(Boolean(ok));
      }
      stack.push(entry);
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      build(body, finish, function (fn) { cleanups.push(fn); });
      var first = card.querySelector('input,select,.fa-go'); if (first) setTimeout(function () { first.focus(); }, 30);
    });
  }
  function success(body, text, finish) {
    body.replaceChildren(h('div', { class: 'fa-done' }, [h('b', { text: '✓' }), h('strong', { text: text })]));
    setTimeout(function () { finish(true); }, 1400);
  }
  function busy(button, on, label) { if (!button.dataset.label) button.dataset.label = button.textContent; button.disabled = on; button.textContent = on ? label : button.dataset.label; }

  /* ---------------- Subscribe, renew or add users ---------------- */
  function subscribe(needs, opts) {
    var intro = needs.reason === 'router_limit' ? 'Add as many routers as you need once you subscribe.'
      : needs.reason === 'trial_limit' ? 'Subscribing lifts the free-trial limits straight away.' : 'Pay by M-Pesa here and carry on where you were.';
    return modal('Subscribe to continue', intro, opts.message, function (body, finish, onClose) {
      body.appendChild(h('div', { class: 'fa-wait' }, [h('i'), 'Loading your plan…']));
      Promise.all([api('/api/business/network-services'), api('/api/business/me').catch(function () { return {}; })]).then(function (results) {
        var data = results[0]; var me = results[1];
        if (data.pricing) { PRICING.pppoe = Object.assign({}, PRICING.pppoe, data.pricing.pppoe); PRICING.hotspot = Object.assign({}, PRICING.hotspot, data.pricing.hotspot); }
        var services = data.services || {}; var plan = data.plan || {};
        var kind = needs.service === 'pppoe' || needs.service === 'hotspot' ? needs.service : (services.pppoe && services.pppoe.status === 'active' && !(services.hotspot && services.hotspot.status === 'active') ? 'pppoe' : 'hotspot');
        var ownerPhone = (me.business && me.business.owner_phone) || '';
        var quoteTimer = null; var upgradeTotal = null; var pollTimer = null;
        onClose(function () { clearTimeout(quoteTimer); clearTimeout(pollTimer); });

        function state() { return services[kind] || { status: 'none', capacity: 0 }; }
        function mode() { return state().status === 'active' && state().capacity > 0 ? 'upgrade' : state().status === 'none' ? 'new' : 'renew'; }
        function suggested() {
          var s = state(); var planned = kind === 'pppoe' ? plan.pppoeUsers : plan.hotspotConcurrent;
          if (mode() === 'upgrade') return s.capacity + (kind === 'pppoe' ? 5 : 50);
          if (mode() === 'renew') return Math.max(s.capacity || 0, planned || 0) + (needs.reason === 'capacity' ? 5 : 0) || (kind === 'pppoe' ? PRICING.pppoe.floorUsers : PRICING.hotspot.floorConcurrent);
          return Math.max(planned || 0, kind === 'pppoe' ? PRICING.pppoe.floorUsers : PRICING.hotspot.floorConcurrent);
        }
        function render() {
          var s = state(); var m = mode();
          var users = h('input', { type: 'number', min: m === 'upgrade' ? s.capacity + 1 : 1, step: 1, inputmode: 'numeric', value: suggested() });
          var phone = h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0712 345 678', value: ownerPhone ? ('0' + String(ownerPhone).replace(/^\+?254/, '')) : '' });
          var total = h('strong', { text: '—' }); var totalNote = h('small', { text: '' });
          var go = h('button', { class: 'fa-go', type: 'button', text: 'Send M-Pesa prompt' });
          var err = h('div', { class: 'fa-err', 'aria-live': 'polite' }); var status = h('div', { 'aria-live': 'polite' });
          var headline = m === 'upgrade' ? 'You have ' + s.capacity + ' ' + (kind === 'pppoe' ? 'PPPoE users' : 'hotspot users') + ' until ' + when(s.expiresAt) + '. Add more and pay only for the days left.'
            : m === 'renew' ? 'Your ' + LABEL[kind] + ' plan has ended. Renew it for 30 days.' : 'Choose how many users you need. The plan runs for 30 days.';
          var nodes = [];
          if (needs.service !== 'pppoe' && needs.service !== 'hotspot') {
            nodes.push(h('div', { class: 'fa-seg', role: 'group', 'aria-label': 'Service' }, ['hotspot', 'pppoe'].map(function (value) {
              return h('button', { type: 'button', 'aria-pressed': String(kind === value), text: LABEL[value], onclick: function () { kind = value; render(); } });
            })));
          }
          nodes.push(h('p', { class: 'fa-note', text: headline, style: 'margin:0 0 12px' }));
          nodes.push(field(kind === 'pppoe' ? 'PPPoE + Static IP users' : 'Hotspot users online at once', users,
            kind === 'pppoe' ? 'KES ' + PRICING.pppoe.floorKes + ' for fewer than ' + PRICING.pppoe.floorUsers + ' users; from ' + PRICING.pppoe.floorUsers + ' users it is KES ' + PRICING.pppoe.perUserKes + ' per user.' : 'KES ' + PRICING.hotspot.floorKes + ' up to ' + PRICING.hotspot.floorConcurrent + ' users, then KES ' + PRICING.hotspot.perExtraUserKes + ' per extra user.'));
          nodes.push(h('div', { class: 'fa-total' }, [h('span', {}, [total, h('br'), totalNote]), h('small', { text: m === 'upgrade' ? 'for the rest of this period' : 'for 30 days' })]));
          nodes.push(field('M-Pesa number to pay', phone));
          if (services.trial && services.trial.active && m !== 'upgrade') nodes.push(h('p', { class: 'fa-note', text: 'Your free trial limits lift as soon as you pay. The 30 days start when the trial ends, so no trial day is lost.' }));
          nodes.push(go, err, status);
          body.replaceChildren.apply(body, nodes);

          function refreshQuote() {
            var n = Math.floor(Number(users.value) || 0); err.textContent = ''; upgradeTotal = null;
            if (m !== 'upgrade') { total.textContent = n ? kes(price(kind, n)) : '—'; totalNote.textContent = n ? n + ' users' : ''; go.disabled = !n; return; }
            if (n <= s.capacity) { total.textContent = '—'; totalNote.textContent = 'Enter more than ' + s.capacity; go.disabled = true; return; }
            total.textContent = '…'; go.disabled = true;
            clearTimeout(quoteTimer);
            quoteTimer = setTimeout(function () {
              api('/api/business/network-services/upgrade-quote?' + (kind === 'pppoe' ? 'pppoeUsers=' : 'hotspotConcurrent=') + n).then(function (q) {
                upgradeTotal = q.totalKes; total.textContent = kes(q.totalKes); totalNote.textContent = s.capacity + ' → ' + n + ' users'; go.disabled = false;
                go.textContent = q.totalKes ? 'Send M-Pesa prompt' : 'Add users (no charge)'; go.dataset.label = go.textContent;
              }).catch(function (e) { total.textContent = '—'; err.textContent = e.message; });
            }, 300);
          }
          users.addEventListener('input', refreshQuote); refreshQuote();

          function poll(id, tries) {
            api('/api/business/billing/status/' + encodeURIComponent(id)).then(function (r) {
              if (r.status === 'paid') return success(body, LABEL[kind] + ' is active. Carrying on…', finish);
              if (r.status === 'failed') { status.replaceChildren(); busy(go, false); err.textContent = r.reason || 'The payment did not go through. Try again.'; return; }
              if (tries > 60) { status.replaceChildren(); busy(go, false); err.textContent = 'Still waiting for M-Pesa. If you paid, it will show in Settings → Billing & payments shortly.'; return; }
              pollTimer = setTimeout(function () { poll(id, tries + 1); }, 3000);
            }).catch(function () { pollTimer = setTimeout(function () { poll(id, tries + 1); }, 4000); });
          }
          go.addEventListener('click', function () {
            var n = Math.floor(Number(users.value) || 0); if (!n) return;
            err.textContent = ''; busy(go, true, 'Sending…');
            var payload = { phone: phone.value }; payload[kind === 'pppoe' ? 'pppoeUsers' : 'hotspotConcurrent'] = n;
            var path = m === 'upgrade' ? '/api/business/network-services/upgrade' : '/api/business/network-services/checkout';
            api(path, { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
              if (r.applied) return success(body, 'Users added. Carrying on…', finish);
              busy(go, true, 'Waiting for payment…');
              status.replaceChildren(h('div', { class: 'fa-wait' }, [h('i'), 'Check ' + (r.phoneDisplay || 'your phone') + ' and enter your M-Pesa PIN.']));
              poll(r.checkoutRequestId, 0);
            }).catch(function (e) { busy(go, false); err.textContent = e.message; });
          });
        }
        render();
      }).catch(function (e) { body.replaceChildren(h('div', { class: 'fa-err', text: e.message })); });
    });
  }

  /* ---------------- Verify the owner's phone ---------------- */
  function verifyPhone(needs, opts) {
    return modal('Verify your phone', 'We send a 6-digit code by SMS. It confirms the number belongs to you.', opts.message, function (body, finish) {
      var phone = h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0712 345 678' });
      var code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '6-digit code' });
      var codeField = field('Code from SMS', code); codeField.hidden = true;
      var go = h('button', { class: 'fa-go', type: 'button', text: 'Send code' }); var err = h('div', { class: 'fa-err' }); var note = h('p', { class: 'fa-note' });
      body.append(field('Your phone number', phone), codeField, go, err, note);
      api('/api/business/me').then(function (me) { var p = me.business && me.business.owner_phone; if (p && !phone.value) phone.value = '0' + String(p).replace(/^\+?254/, ''); }).catch(function () {});
      var sent = false;
      go.addEventListener('click', function () {
        err.textContent = '';
        if (!sent) {
          busy(go, true, 'Sending…');
          api('/api/business/phone/verify/start', { method: 'POST', body: JSON.stringify({ phone: phone.value }) }).then(function (r) {
            sent = true; codeField.hidden = false; phone.disabled = true; busy(go, false); go.textContent = 'Verify'; go.dataset.label = 'Verify';
            note.textContent = 'Code sent to ' + (r.phoneDisplay || 'your phone') + '. It expires in 10 minutes.'; code.focus();
          }).catch(function (e) { busy(go, false); err.textContent = e.message; });
          return;
        }
        busy(go, true, 'Checking…');
        api('/api/business/phone/verify/confirm', { method: 'POST', body: JSON.stringify({ code: code.value }) })
          .then(function () { success(body, 'Phone verified. Carrying on…', finish); })
          .catch(function (e) { busy(go, false); err.textContent = e.message; });
      });
    });
  }

  /* ---------------- Organisation details ---------------- */
  function organisation(needs, opts) {
    return modal('Your organisation', 'Three details and you can carry on.', opts.message, function (body, finish) {
      var name = h('input', { maxlength: 80, placeholder: 'Kitale Cafe', autocomplete: 'organization' });
      var hotspot = h('input', { maxlength: 80, placeholder: 'Kitale Cafe Wi-Fi' });
      var phone = h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0712 345 678' });
      var go = h('button', { class: 'fa-go', type: 'button', text: 'Save and continue' }); var err = h('div', { class: 'fa-err' });
      body.append(field('Organisation name', name), field('Wi-Fi name customers see', hotspot), field('Your phone number', phone), go, err);
      api('/api/business/me').then(function (me) { var b = me.business || {}; if (b.name && !name.value) name.value = b.name; if (b.hotspot_name && !hotspot.value) hotspot.value = b.hotspot_name; if (b.owner_phone && !phone.value) phone.value = '0' + String(b.owner_phone).replace(/^\+?254/, ''); }).catch(function () {});
      go.addEventListener('click', function () {
        err.textContent = ''; busy(go, true, 'Saving…');
        api('/api/business/organisation', { method: 'POST', body: JSON.stringify({ organisationName: name.value, hotspotName: hotspot.value || name.value, phone: phone.value }) })
          .then(function () { success(body, 'Saved. Carrying on…', finish); })
          .catch(function (e) { busy(go, false); err.textContent = e.message; });
      });
    });
  }

  /* ---------------- Confirm a router's map ---------------- */
  function confirmRouterMap(needs, opts) {
    var locationId = String(needs.locationId || '');
    return modal('Confirm your router map', 'Tell Wi-Fi Fiti which port brings the internet in and which bridge your customers use. Nothing on the router changes.', opts.message, function (body, finish) {
      function load() {
        body.replaceChildren(h('div', { class: 'fa-wait' }, [h('i'), 'Reading the router’s ports…']));
        api('/api/business/locations/' + encodeURIComponent(locationId) + '/router-topology').then(function (result) {
          var topology = result.topology; var fresh = result.inventory && result.inventory.fresh;
          if (!topology || !fresh) {
            var again = h('button', { class: 'fa-go', type: 'button', text: 'Check again', onclick: load });
            body.replaceChildren(h('p', { class: 'fa-note', text: 'The router hasn’t reported its ports recently. Make sure it is powered on and online, wait a minute, then check again.' }), again);
            return;
          }
          var interfaces = topology.interfaces || []; var mapping = result.mapping || {};
          var ethernet = interfaces.filter(function (i) { return i.type === 'ether'; }); var bridges = interfaces.filter(function (i) { return i.type === 'bridge'; });
          var wifiNames = (topology.wifiInterfaces || []).map(function (i) { return i.name; });
          var wan = h('select'); ethernet.forEach(function (i) { wan.appendChild(h('option', { value: i.name, text: i.name + ' · ' + i.state })); });
          var bridge = h('select'); bridges.forEach(function (i) { bridge.appendChild(h('option', { value: i.name, text: i.name + ' · ' + i.state })); });
          wan.value = mapping.wanInterface || topology.wanInterface || (ethernet[0] && ethernet[0].name) || '';
          bridge.value = mapping.customerBridge || topology.customerBridge || (bridges[0] && bridges[0].name) || '';
          var members = h('div', { class: 'fa-field' });
          function drawMembers() {
            var inBridge = (topology.bridgePorts || []).filter(function (p) { return p.bridge === bridge.value; }).map(function (p) { return p.interface; });
            var wifi = interfaces.filter(function (i) { return wifiNames.indexOf(i.name) >= 0 && inBridge.indexOf(i.name) >= 0; });
            var ports = ethernet.filter(function (i) { return i.name !== wan.value && inBridge.indexOf(i.name) >= 0; });
            function group(title, items, name, chosen) {
              return h('div', { class: 'fa-field' }, [h('span', { text: title }), items.length ? h('div', { class: 'fa-checks' }, items.map(function (i) {
                return h('label', {}, [h('input', { type: 'checkbox', name: name, value: i.name, checked: chosen ? chosen.indexOf(i.name) >= 0 : true }), i.name + ' · ' + i.state]);
              })) : h('small', { text: 'None in this bridge.' })]);
            }
            members.replaceChildren(group('Customer Wi-Fi', wifi, 'wifi', mapping.wifiInterfaces), group('Customer Ethernet ports', ports, 'ports', mapping.customerPorts));
          }
          wan.addEventListener('change', drawMembers); bridge.addEventListener('change', drawMembers); drawMembers();
          var go = h('button', { class: 'fa-go', type: 'button', text: 'Confirm map' }); var err = h('div', { class: 'fa-err' });
          body.replaceChildren(h('div', { class: 'fa-row' }, [field('Internet (WAN) port', wan), field('Customer bridge', bridge)]), members, go, err);
          go.addEventListener('click', function () {
            var picked = function (name) { return Array.prototype.slice.call(body.querySelectorAll('input[name="' + name + '"]:checked')).map(function (i) { return i.value; }); };
            if (!wan.value || !bridge.value) { err.textContent = 'Choose the WAN port and the customer bridge.'; return; }
            err.textContent = ''; busy(go, true, 'Confirming…');
            api('/api/business/locations/' + encodeURIComponent(locationId) + '/router-mapping', { method: 'PUT', body: JSON.stringify({ wanInterface: wan.value, customerBridge: bridge.value, wifiInterfaces: picked('wifi'), customerPorts: picked('ports') }) })
              .then(function () { success(body, 'Router map confirmed.', finish); })
              .catch(function (e) { busy(go, false); err.textContent = e.message; });
          });
        }).catch(function (e) { body.replaceChildren(h('div', { class: 'fa-err', text: e.message })); });
      }
      load();
    });
  }

  /* ---------------- Create a package ---------------- */
  function createPackage(needs, opts) {
    return modal('Create a package', 'The time plan customers buy, for example 1 hour for KES 20.', opts.message, function (body, finish) {
      var name = h('input', { maxlength: 48, placeholder: '1 hour' });
      var amount = h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', placeholder: '20' });
      var length = h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', value: 1 });
      var unit = h('select', {}, [h('option', { value: 'm', text: 'minutes' }), h('option', { value: 'h', text: 'hours', selected: true }), h('option', { value: 'd', text: 'days' })]);
      var speed = h('input', { placeholder: 'Optional, e.g. 2M/5M' });
      var go = h('button', { class: 'fa-go', type: 'button', text: 'Create package' }); var err = h('div', { class: 'fa-err' });
      body.append(field('Package name', name), h('div', { class: 'fa-row' }, [field('Price (KES)', amount), h('div', { class: 'fa-row' }, [field('Lasts', length), field('Unit', unit)])]), field('Speed (upload/download)', speed), go, err);
      go.addEventListener('click', function () {
        var hours = Number(length.value) * ({ m: 1 / 60, h: 1, d: 24 })[unit.value];
        err.textContent = ''; busy(go, true, 'Creating…');
        request('/api/business/packages', { method: 'POST', body: JSON.stringify({ name: name.value, price: Number(amount.value), hours: hours, rateLimit: speed.value }) })
          .then(function (r) { opts.onResult && opts.onResult(r); success(body, 'Package created.', finish); })
          .catch(function (e) { busy(go, false); err.textContent = e.message; });
      });
    });
  }

  var ACTIONS = { subscribe: subscribe, verify_phone: verifyPhone, organisation: organisation, confirm_router_map: confirmRouterMap, create_package: createPackage };

  function open(needs, opts) {
    var fn = needs && ACTIONS[needs.action];
    if (!fn) return Promise.resolve(false);
    return fn(needs, opts || {});
  }

  /*
   * A request that, if the server says a step is missing, opens that step's
   * pop-up and repeats itself once it is done. Rejects with the original
   * error if the owner closes the pop-up.
   */
  function request(path, options, attempt) {
    var original = Object.assign({}, options || {}); attempt = attempt || 0;
    return api(path, Object.assign({}, original)).catch(function (error) {
      var needs = error.body && error.body.needs;
      if (!needs || attempt >= 2 || !ACTIONS[needs.action]) throw error;
      return open(needs, { message: error.message }).then(function (done) {
        if (!done) throw error;
        return request(path, original, attempt + 1);
      });
    });
  }

  window.FitiActions = { open: open, request: request, actions: Object.keys(ACTIONS) };
})();

/* Billing & payments as tiles, one service per page.
 *
 *   Tiles:  Your plan · How customers pay you · Tuma charges (Tuma only)
 *   Pages:  plan     → Prepaid network services (capacity, pay, add users)
 *           pay      → choose Wi‑Fi Fiti collection or My Till/PayBill/Tuma;
 *                      the gateway card animates in only for the latter
 *           charges  → Tuma's monthly fee (always shown to Tuma tenants)
 *
 * The existing forms are moved into these pages, so every button keeps its
 * behaviour. Saving a payment method closes the page and returns to tiles.
 * window.fitiBillingHub.open('plan' | 'pay' | 'charges') is used by the
 * setup checklist. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function api(path, options) {
    options = options || {};
    var token = ''; try { token = localStorage.getItem('fiti_business_token') || ''; } catch (e) { token = ''; }
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {});
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) { var error = new Error(body.error || 'Something went wrong. Please try again.'); error.status = response.status; if (body.needs && window.FitiActions && !options.fitiRetried) { return window.FitiActions.open(body.needs, { message: error.message }).then(function (done) { if (!done) throw error; options.fitiRetried = true; return api(path, options); }); } throw error; }
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

  var style = document.createElement('style');
  style.textContent = [
    // Hub and page visibility
    '#dashboard.bh-on #billing-section>.section-head,#dashboard.bh-on #billing-section>.panel,#dashboard.bh-on #billing-section>.toolbar-row,#dashboard.bh-on #billing-section>.export-note{display:none!important}',
    '#dashboard.bh-on #network-services-section,#dashboard.bh-on #integrations-section{display:none!important}',
    '#dashboard.bh-on.bh-page-plan #network-services-section{display:block!important}',
    '#dashboard.bh-on:not(.bh-hub) #bh-tiles{display:none}',
    '#dashboard.bh-on.bh-hub .bh-page{display:none}',
    '#dashboard.bh-on:not(.bh-page-pay) #bh-pay,#dashboard.bh-on:not(.bh-page-charges) #bh-charges{display:none}',
    '#network-services-section .bh-back-row{margin-bottom:10px}',
    // Tiles
    '#bh-root{max-width:980px;margin:0 auto}',
    '.bh-title{margin:0 0 4px;text-align:center;font-size:clamp(24px,3vw,32px);letter-spacing:-.04em;color:var(--ink)}',
    '.bh-lede{margin:0 0 20px;text-align:center;color:var(--muted);font-size:15px}',
    '.bh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}',
    '.bh-tile{position:relative;display:flex;flex-direction:column;gap:8px;padding:20px;border:1px solid var(--line);border-radius:22px;background:var(--surface);box-shadow:var(--shadow);text-align:left;transition:transform .2s ease,box-shadow .2s ease}',
    '.bh-tile:hover{transform:translateY(-2px)}',
    '.bh-tile small{color:var(--muted);font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}',
    '.bh-tile h3{margin:0;font-size:20px;letter-spacing:-.03em;color:var(--ink)}',
    '.bh-tile p{margin:0;color:var(--muted);font-size:14px;line-height:1.5}',
    '.bh-state{display:inline-flex;align-self:flex-start;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:800}',
    '.bh-state.ok{background:rgba(22,140,98,.12);color:var(--good)}.bh-state.warn{background:rgba(168,107,0,.12);color:var(--warn)}.bh-state.bad{background:rgba(189,56,82,.12);color:var(--bad)}',
    '.bh-bar{height:7px;border-radius:999px;background:rgba(127,150,180,.18);overflow:hidden}.bh-bar i{display:block;height:100%;border-radius:999px;background:var(--good)}',
    '.bh-foot{display:flex;flex-wrap:wrap;gap:8px;margin-top:auto;padding-top:6px}',
    '.bh-more{display:none;padding-top:8px;border-top:1px solid var(--line)}.bh-tile.open .bh-more{display:block}',
    '.bh-link{padding:0;border:0;background:none;color:var(--blue);font:inherit;font-size:14px;font-weight:800;cursor:pointer}',
    '.bh-toast{margin:0 auto 14px;max-width:980px;padding:12px 16px;border-radius:14px;background:rgba(22,140,98,.12);color:var(--good);font-weight:700;text-align:center;animation:bh-in .35s ease}',
    // Pages
    '.bh-page{max-width:880px;margin:0 auto}',
    '.bh-back{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);font:inherit;font-weight:800;cursor:pointer}',
    '.bh-page h2{margin:14px 0 4px;font-size:clamp(24px,3vw,30px);letter-spacing:-.04em;color:var(--ink)}',
    '.bh-page>p{margin:0 0 16px;color:var(--muted)}',
    '.bh-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
    '.bh-choice{display:flex;flex-direction:column;gap:6px;padding:18px;border:2px solid var(--line);border-radius:20px;background:var(--surface);color:var(--ink);font:inherit;text-align:left;cursor:pointer;transition:border-color .2s,box-shadow .2s,transform .2s}',
    '.bh-choice b{font-size:17px}.bh-choice span{color:var(--muted);font-size:14px;line-height:1.45}',
    '.bh-choice[aria-pressed="true"]{border-color:var(--blue);box-shadow:0 0 0 4px rgba(23,105,216,.12);transform:translateY(-1px)}',
    '.bh-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}',
    '.bh-msg{min-height:20px;margin-top:8px;color:var(--muted);font-size:14px}.bh-msg.bad{color:var(--bad)}',
    // Gateway card: animated entrance and a slowly moving gradient border
    '.bh-gateway{position:relative;margin-top:18px;padding:2px;border-radius:26px;background:linear-gradient(120deg,#1769d8,#078d9b,#34c38f,#1769d8);background-size:300% 300%;animation:bh-pop .5s cubic-bezier(.2,.9,.3,1.2) both,bh-flow 9s linear infinite}',
    '.bh-gateway-in{padding:22px;border-radius:24px;background:var(--surface)}',
    '.bh-gateway-head{display:flex;align-items:center;gap:14px;margin-bottom:14px}',
    '.bh-orb{position:relative;flex:0 0 46px;height:46px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#5fd1ff,#1769d8 60%,#0b3f8f)}',
    '.bh-orb:before,.bh-orb:after{content:"";position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(23,105,216,.35);animation:bh-ring 2.4s ease-out infinite}',
    '.bh-orb:after{animation-delay:1.2s}',
    '.bh-gateway-head b{display:block;font-size:19px;color:var(--ink)}.bh-gateway-head span{color:var(--muted);font-size:14px}',
    '.bh-providers{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}',
    '.bh-provider{padding:9px 14px;border:1.5px solid var(--line);border-radius:999px;background:transparent;color:var(--ink);font:inherit;font-weight:800;font-size:14px;cursor:pointer}',
    '.bh-provider[aria-pressed="true"]{border-color:var(--blue);background:rgba(23,105,216,.08);color:var(--blue)}',
    '.bh-provider em{margin-left:6px;font-style:normal;font-size:11px;color:var(--good)}',
    '.bh-charges{margin:0 0 14px;padding:14px 16px;border-radius:16px;border:1px solid rgba(168,107,0,.35);background:rgba(168,107,0,.07);color:var(--ink);font-size:14px;line-height:1.5}',
    '.bh-charges b{color:var(--warn)}',
    '.bh-gateway #integrations-panel-slot .fields:first-child{display:none}',
    // "Save and finish" saves the gateway; the old per-panel controls would only confuse.
    '.bh-gateway #save-integration{display:none!important}',
    '.bh-gateway.tuma #test-integration,.bh-gateway.tuma #integration-status{display:none!important}',
    '.bh-gateway #integrations-panel-slot>.panel{padding:0;border:0;box-shadow:none;background:transparent}',
    '@keyframes bh-pop{0%{opacity:0;transform:translateY(18px) scale(.96)}100%{opacity:1;transform:none}}',
    '@keyframes bh-flow{0%{background-position:0% 50%}100%{background-position:300% 50%}}',
    '@keyframes bh-ring{0%{transform:scale(.8);opacity:.9}100%{transform:scale(1.6);opacity:0}}',
    '@keyframes bh-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.bh-gateway,.bh-orb:before,.bh-orb:after,.bh-toast{animation:none}}',
    '@media (max-width:620px){.bh-choices{grid-template-columns:1fr}.bh-tile{padding:16px}}',
  ].join('');
  document.head.appendChild(style);

  var dashboard, billing, root, tiles, payPage, chargesPage, toastBox;
  var data = { me: null, services: null, integrations: null, settlement: null, fee: null };
  var page = 'hub';
  var choice = null; var provider = 'tuma'; var guidedStep = false;

  function setPage(next) {
    page = next;
    if (next !== 'pay') returnPanel();
    ['bh-hub', 'bh-page-plan', 'bh-page-pay', 'bh-page-charges'].forEach(function (c) { dashboard.classList.remove(c); });
    dashboard.classList.add(next === 'hub' ? 'bh-hub' : 'bh-page-' + next);
    if (next === 'pay') renderPay();
    if (next === 'charges') renderCharges();
    if (next === 'hub') renderTiles();
    var target = next === 'plan' ? $('network-services-section') : root;
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function load() {
    return Promise.all([
      api('/api/business/me').catch(function () { return null; }),
      api('/api/business/network-services').catch(function () { return null; }),
      api('/api/business/integrations').catch(function () { return null; }),
      api('/api/business/tuma/settlement').catch(function () { return null; }),
      api('/api/business/tuma/fee').catch(function () { return null; }),
    ]).then(function (r) {
      data.me = r[0]; data.services = r[1]; data.integrations = r[2]; data.settlement = r[3]; data.fee = r[4];
      if (page === 'hub') renderTiles();
    });
  }

  function paymentSummary() {
    var business = data.me && data.me.business || {};
    var integ = data.integrations || {}; var acct = data.settlement && data.settlement.account;
    if (business.collection_mode === 'fiti' || integ.selected === 'fiti') return { title: 'Wi‑Fi Fiti collection', text: 'We collect and pay out to you. 5% of each completed sale.', state: ['ok', 'Active'] };
    if (integ.selected === 'tuma') {
      if (data.settlement && data.settlement.connected && acct) {
        var where = acct.destinationType === 'own' ? 'your own Tuma account' : (acct.destinationType === 'till' ? 'M‑Pesa Till' : acct.destinationType === 'paybill' ? 'M‑Pesa PayBill' : acct.destinationName) + (acct.accountLast4 ? ' ending ' + acct.accountLast4 : '');
        return { title: 'Tuma → ' + where, text: 'Customer payments settle to you in real time.', state: acct.lastError ? ['bad', 'Needs attention'] : ['ok', 'Ready'] };
      }
      if (acct && acct.suspendedReason === 'trial-ended') return { title: 'Tuma (paused)', text: 'Paused because the free trial ended. It switches back on as soon as you choose a plan.', state: ['warn', 'Paused'] };
      return { title: 'Tuma', text: 'Add where Tuma should send your money to finish.', state: ['warn', 'Finish setup'] };
    }
    var name = ((integ.providers || []).find(function (p) { return p.id === integ.selected; }) || {}).name || 'Not chosen yet';
    return { title: name, text: integ.status === 'ready' || integ.status === 'active' ? 'Customer payments go to your own account.' : 'Choose how customers pay you.', state: integ.status === 'ready' || integ.status === 'active' ? ['ok', 'Ready'] : ['warn', 'Set up'] };
  }

  function renderTiles() {
    if (!tiles) return;
    tiles.replaceChildren();
    tiles.appendChild(h('h2', { class: 'bh-title', text: 'Billing & payments' }));
    tiles.appendChild(h('p', { class: 'bh-lede', text: 'Your plan, how customers pay you, and every charge in one place.' }));
    var grid = h('div', { class: 'bh-grid' });

    // 1. Your plan
    var services = data.services && data.services.services || {}; var usage = data.services && data.services.usage || {}; var plan = data.services && data.services.plan || {};
    var hot = services.hotspot || {}; var ppp = services.pppoe || {};
    var planLines = []; var planState = ['warn', 'Choose capacity'];
    if (services.trial && services.trial.active) {
      planState = ['ok', 'Free trial'];
      planLines.push(plan.renewKes ? 'Free until ' + day(services.trial.endsAt) + ', then ' + kes(plan.renewKes) + '/month.' : 'Everything is free until ' + day(services.trial.endsAt) + '.');
    }
    [['Hotspot', hot, usage.hotspot, 'online'], ['PPPoE', ppp, usage.pppoe, 'users']].forEach(function (s) {
      var st = s[1];
      if (st.status === 'active' || st.status === 'grace') {
        planState = st.status === 'grace' ? ['warn', 'Renew soon'] : planState[0] === 'ok' ? planState : ['ok', 'Active'];
        planLines.push(s[0] + ': ' + Number(st.capacity || 0).toLocaleString() + ' ' + s[3] + (st.status === 'grace' ? ' · sales stop ' + day(st.graceEndsAt) : ' · renews ' + day(st.expiresAt)));
      }
    });
    if (!planLines.length) planLines.push('Pick hotspot and PPPoE capacity. You pay by users, never per router.');
    var planTile = h('article', { class: 'bh-tile' }, [h('small', { text: 'Your plan' }), h('span', { class: 'bh-state ' + planState[0], text: planState[1] }), h('h3', { text: planLines[0] })]);
    planLines.slice(1).forEach(function (l) { planTile.appendChild(h('p', { text: l })); });
    if (usage.hotspot && usage.hotspot.capacity) { var bar = h('div', { class: 'bh-bar' }, [h('i', {})]); bar.firstChild.style.width = Math.min(100, usage.hotspot.pct) + '%'; planTile.appendChild(bar); planTile.appendChild(h('p', { text: usage.hotspot.used + ' of ' + usage.hotspot.capacity + ' users online now' })); }
    var managePlan = h('button', { type: 'button', text: 'Manage plan' }); managePlan.addEventListener('click', function () { setPage('plan'); });
    planTile.appendChild(h('div', { class: 'bh-foot' }, [managePlan]));
    grid.appendChild(planTile);

    // 2. How customers pay you (collapsed; expand to change)
    var pay = paymentSummary();
    var payTile = h('article', { class: 'bh-tile', role: 'button', tabindex: '0', 'aria-expanded': 'false' }, [h('small', { text: 'How customers pay you' }), h('span', { class: 'bh-state ' + pay.state[0], text: pay.state[1] }), h('h3', { text: pay.title }), h('p', { text: pay.text })]);
    var change = h('button', { type: 'button', class: 'bh-link', text: 'Change payment collection method' });
    change.addEventListener('click', function (event) { event.stopPropagation(); choice = null; setPage('pay'); });
    var configured = pay.state[0] === 'ok';
    if (configured) {
      payTile.appendChild(h('div', { class: 'bh-more' }, [change]));
      payTile.appendChild(h('div', { class: 'bh-foot' }, [h('span', { class: 'bh-link', text: 'Details ▾' })]));
      var toggle = function () { var open = payTile.classList.toggle('open'); payTile.setAttribute('aria-expanded', String(open)); };
      payTile.addEventListener('click', toggle);
      payTile.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    } else {
      var setup = h('button', { type: 'button', text: 'Set up payments' }); setup.addEventListener('click', function (event) { event.stopPropagation(); setPage('pay'); });
      payTile.appendChild(h('div', { class: 'bh-foot' }, [setup]));
    }
    grid.appendChild(payTile);

    // 3. Tuma charges: always shown to Tuma tenants
    if (data.integrations && data.integrations.selected === 'tuma' && data.fee) {
      var fee = data.fee.outstanding || data.fee.current;
      var feeState = fee.stage === 'paid' ? ['ok', 'Paid this month'] : fee.stage === 'overdue' ? ['bad', 'Sales paused'] : fee.stage === 'due' ? ['bad', 'Due now'] : fee.stage === 'approaching' ? ['warn', 'Close to threshold'] : ['ok', 'Not due'];
      var feeTile = h('article', { class: 'bh-tile' }, [h('small', { text: 'Tuma charges' }), h('span', { class: 'bh-state ' + feeState[0], text: feeState[1] }),
        h('h3', { text: kes(fee.feeKes) + ' a month at ' + kes(fee.thresholdKes) + ' in sales' }),
        h('p', { text: 'Tuma charges this flat fee in any calendar month your Tuma sales reach ' + kes(fee.thresholdKes) + '. You are notified at ' + kes(fee.warnAtKes) + '.' })]);
      var fbar = h('div', { class: 'bh-bar' }, [h('i', {})]); fbar.firstChild.style.width = Math.min(100, Math.round(100 * fee.salesKes / fee.thresholdKes)) + '%';
      feeTile.appendChild(fbar); feeTile.appendChild(h('p', { text: 'This month: ' + kes(fee.salesKes) + ' of ' + kes(fee.thresholdKes) }));
      var view = h('button', { type: 'button', class: fee.canPay || fee.stage === 'due' || fee.stage === 'overdue' ? '' : 'secondary', text: fee.canPay || fee.stage === 'due' || fee.stage === 'overdue' ? 'Pay ' + kes(fee.feeKes) : 'View charges' });
      view.addEventListener('click', function () { setPage('charges'); });
      feeTile.appendChild(h('div', { class: 'bh-foot' }, [view]));
      grid.appendChild(feeTile);
    }
    tiles.appendChild(grid);
  }

  function backButton() {
    var b = h('button', { type: 'button', class: 'bh-back', text: '← Billing & payments' });
    b.addEventListener('click', function () { setPage('hub'); load(); });
    return b;
  }

  // ---- Pay page -----------------------------------------------------------
  var gatewaySlot = null;
  // The integrations panel is borrowed into the gateway card; always put it
  // back before re-rendering so it is never detached and lost.
  function returnPanel() {
    var panel = gatewaySlot && gatewaySlot.firstChild; var home = $('integrations-section');
    if (panel && home) home.appendChild(panel);
  }
  function renderPay() {
    returnPanel();
    payPage.replaceChildren();
    var business = data.me && data.me.business || {}; var integ = data.integrations || {};
    if (choice === null) choice = business.collection_mode === 'fiti' || integ.selected === 'fiti' ? 'fiti' : (integ.selected ? 'own' : 'own');
    if (integ.selected && integ.selected !== 'fiti') provider = integ.selected;
    payPage.appendChild(backButton());
    if (guidedStep) payPage.appendChild(h('p', { class: 'gs-step', text: 'Step 2 of 2 · Set up payments' }));
    payPage.appendChild(h('h2', { text: 'How customers pay you' }));
    payPage.appendChild(h('p', { text: 'Choose one. You can change it later from the Billing & payments tile.' }));
    var own = h('button', { type: 'button', class: 'bh-choice', 'aria-pressed': String(choice === 'own') }, [h('b', { text: 'My Till / PayBill / Tuma' }), h('span', { text: 'Money settles straight to your own account. No Wi‑Fi Fiti sales fee.' })]);
    var fiti = h('button', { type: 'button', class: 'bh-choice', 'aria-pressed': String(choice === 'fiti') }, [h('b', { text: 'Wi‑Fi Fiti collection' }), h('span', { text: 'No setup: we collect for you and pay out from your balance. 5% of each completed sale.' })]);
    own.addEventListener('click', function () { choice = 'own'; renderPay(); });
    fiti.addEventListener('click', function () { choice = 'fiti'; renderPay(); });
    payPage.appendChild(h('div', { class: 'bh-choices' }, [own, fiti]));
    var msg = h('p', { class: 'bh-msg' });

    if (choice === 'own') {
      // The gateway card only exists for "My Till / PayBill / Tuma".
      var providers = (integ.providers || []).filter(function (p) { return p.available && p.id !== 'fiti' && p.id !== 'manual'; });
      var chips = h('div', { class: 'bh-providers', role: 'group', 'aria-label': 'Payment gateway' });
      providers.forEach(function (p) {
        var chip = h('button', { type: 'button', class: 'bh-provider', 'aria-pressed': String(provider === p.id) }, [p.id === 'tuma' ? 'Tuma' : p.name, p.id === 'tuma' ? h('em', { text: 'Recommended' }) : null]);
        chip.addEventListener('click', function () { provider = p.id; syncProvider(); renderPay(); });
        chips.appendChild(chip);
      });
      var inner = h('div', { class: 'bh-gateway-in' }, [
        h('div', { class: 'bh-gateway-head' }, [h('span', { class: 'bh-orb', 'aria-hidden': 'true' }), h('div', {}, [h('b', { text: 'Connect your payment gateway' }), h('span', { text: 'Pick where customer payments land.' })])]),
        chips,
      ]);
      if (provider === 'tuma') {
        var feeKes = data.fee && data.fee.current ? data.fee.current.feeKes : 3000;
        inner.appendChild(h('div', { class: 'bh-charges' }, [h('b', { text: 'Tuma charges: ' }), 'a flat ' + kes(feeKes) + ' in any calendar month your Tuma sales reach KES 100,000. You are notified at KES 80,000, and this charge always shows on your billing.']));
      }
      gatewaySlot = h('div', { id: 'integrations-panel-slot' });
      inner.appendChild(gatewaySlot);
      payPage.appendChild(h('div', { class: 'bh-gateway' + (provider === 'tuma' ? ' tuma' : '') }, [inner]));
      var panel = document.querySelector('#integrations-section > .panel') || (gatewaySlot && gatewaySlot.firstChild);
      if (panel && panel.parentNode !== gatewaySlot) gatewaySlot.appendChild(panel);
      syncProvider();
      var done = h('button', { type: 'button', text: 'Save and finish' });
      done.addEventListener('click', function () { saveOwn(done, msg); });
      payPage.appendChild(h('div', { class: 'bh-actions' }, [done]));
    } else {
      var save = h('button', { type: 'button', text: 'Save Wi‑Fi Fiti collection' });
      save.addEventListener('click', function () { saveFiti(save, msg); });
      payPage.appendChild(h('div', { class: 'bh-actions' }, [save]));
    }
    payPage.appendChild(msg);
  }

  function syncProvider() {
    var select = $('integration-provider');
    if (select && select.value !== provider && Array.prototype.some.call(select.options, function (o) { return o.value === provider; })) {
      select.value = provider; select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function saveCollection(mode) {
    var business = data.me && data.me.business || {};
    return api('/api/business/billing-plan', { method: 'POST', body: JSON.stringify({ plan: business.plan || 'starter', collectionMode: mode }) });
  }

  function saveFiti(button, msg) {
    button.disabled = true; msg.className = 'bh-msg'; msg.textContent = 'Saving…';
    saveCollection('fiti')
      .then(function () { return api('/api/business/integrations/select', { method: 'POST', body: JSON.stringify({ provider: 'fiti' }) }); })
      .then(function () { finish('Saved: customers now pay through Wi‑Fi Fiti collection.'); })
      .catch(function (error) { msg.className = 'bh-msg bad'; msg.textContent = error.message; button.disabled = false; });
  }

  function saveOwn(button, msg) {
    button.disabled = true; msg.className = 'bh-msg'; msg.textContent = 'Saving…';
    saveCollection('own')
      .then(function () { return api('/api/business/integrations/select', { method: 'POST', body: JSON.stringify({ provider: provider }) }); })
      .then(function () { return provider === 'tuma' ? api('/api/business/tuma/settlement') : api('/api/business/integrations'); })
      .then(function (status) {
        var ready = provider === 'tuma' ? Boolean(status.connected) : ['ready', 'active'].indexOf(status.status) >= 0 || provider === 'c2b' || provider === 'till';
        if (!ready) {
          msg.className = 'bh-msg bad';
          msg.textContent = provider === 'tuma' ? 'Saved. Now add where Tuma should send your money above (Save payout account), then tap Save and finish.' : 'Saved. Finish this gateway’s setup above, then run the readiness test.';
          button.disabled = false; return;
        }
        finish('Saved: customers now pay into your own account' + (provider === 'tuma' ? ' through Tuma.' : '.'));
      })
      .catch(function (error) { msg.className = 'bh-msg bad'; msg.textContent = error.message; button.disabled = false; });
  }

  function finish(text) {
    guidedStep = false;
    load().then(function () {
      setPage('hub');
      if (toastBox) { toastBox.replaceChildren(h('div', { class: 'bh-toast', text: '✓ ' + text })); setTimeout(function () { toastBox.replaceChildren(); }, 6000); }
    });
  }

  // ---- Charges page -------------------------------------------------------
  function renderCharges() {
    chargesPage.replaceChildren();
    chargesPage.appendChild(backButton());
    chargesPage.appendChild(h('h2', { text: 'Tuma charges' }));
    chargesPage.appendChild(h('p', { text: 'Tuma charges a flat fee in any calendar month your Tuma sales reach KES 100,000. It always shows here.' }));
    var card = window.fitiTumaFee && window.fitiTumaFee.card;
    if (card) { chargesPage.appendChild(card); if (window.fitiTumaFee.load) window.fitiTumaFee.load(); }
  }

  // ---- Mount --------------------------------------------------------------
  function mount() {
    dashboard = $('dashboard'); billing = $('billing-section');
    if (!dashboard || !billing || $('bh-root')) return;
    root = h('div', { id: 'bh-root' });
    toastBox = h('div', {});
    tiles = h('div', { id: 'bh-tiles' });
    payPage = h('div', { class: 'bh-page', id: 'bh-pay' });
    chargesPage = h('div', { class: 'bh-page', id: 'bh-charges' });
    root.appendChild(toastBox); root.appendChild(tiles); root.appendChild(payPage); root.appendChild(chargesPage);
    billing.insertBefore(root, billing.firstChild);
    // A back button on the plan page (the existing services section).
    var services = $('network-services-section');
    if (services && !services.querySelector('.bh-back-row')) services.insertBefore(h('div', { class: 'bh-back-row' }, [backButton()]), services.firstChild);
    dashboard.classList.add('bh-on', 'bh-hub');
    load();
  }

  window.fitiBillingHub = {
    open: function (target, options) {
      if (!root) mount(); if (window.location.hash !== '#payments') window.location.hash = '#payments';
      setTimeout(function () { guidedStep = Boolean(options && options.guided); if (target === 'pay') { choice = 'own'; provider = 'tuma'; } setPage(target || 'hub'); }, 150);
    },
    refresh: load,
  };

  window.addEventListener('hashchange', function () { if (window.location.hash === '#payments' && root) { setPage('hub'); load(); } });
  (function wait() { if ($('billing-section') && $('dashboard')) mount(); else setTimeout(wait, 400); }());
})();

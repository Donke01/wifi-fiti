/* Tuma payout destination for the business dashboard.
 * Shown under Payment integrations when "Tuma Gateway" is selected. Creates
 * the tenant's own Tuma business (or links an existing one) so customer
 * payments settle straight to their Till, PayBill or bank. */
(function () {
  'use strict';
  var select = document.getElementById('integration-provider');
  var anchor = document.getElementById('c2b-settings');
  if (!select || !anchor) return;

  var state = { loaded: false, loading: false, settlement: null, destinations: null, type: 'till', linkMode: false };

  function api(path, options) {
    options = options || {};
    var token = '';
    try { token = localStorage.getItem('fiti_business_token') || ''; } catch (e) { token = ''; }
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {});
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) { var error = new Error(body.error || 'Something went wrong. Please try again.'); error.field = body.field; throw error; }
        return body;
      });
    });
  }
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'class') node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  var style = document.createElement('style');
  style.textContent = [
    '.tp{margin:14px 0 6px;padding:18px;border:1px solid var(--line);border-radius:18px;background:var(--surface);text-align:left}',
    '.tp h3{margin:0 0 4px;font-size:18px;letter-spacing:-.02em;color:var(--ink)}',
    '.tp-lede{margin:0 0 14px;color:var(--muted);font-size:14px;line-height:1.5}',
    '.tp-state{display:flex;gap:10px;align-items:flex-start;margin:0 0 14px;padding:12px 14px;border-radius:14px;font-size:14px;line-height:1.45}',
    '.tp-state.ok{background:rgba(22,140,98,.09);color:var(--good)}.tp-state.warn{background:rgba(168,107,0,.09);color:var(--warn)}.tp-state.bad{background:rgba(189,56,82,.09);color:var(--bad)}',
    '.tp-state b{color:var(--ink)}',
    '.tp-chips{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 14px}',
    '.tp-chip{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border:1.5px solid var(--line);border-radius:14px;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}',
    '.tp-chip small{color:var(--muted);font-size:12px}',
    '.tp-chip[aria-pressed="true"]{border-color:var(--blue);box-shadow:0 0 0 3px rgba(23,105,216,.14)}',
    '.tp-chip:disabled{opacity:.45;cursor:not-allowed}',
    '.tp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}',
    '.tp-grid label.wide{grid-column:1/-1}',
    '.tp-err{min-height:18px;margin:6px 0 0;color:var(--bad);font-size:13px}',
    '.tp-foot{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px}',
    '.tp-link{padding:0;border:0;background:none;color:var(--blue);font:inherit;font-size:14px;font-weight:700;cursor:pointer}',
    '.tp [data-invalid="true"]{border-color:var(--bad)!important}',
    '@media (max-width:620px){.tp-chips{grid-template-columns:1fr}.tp-grid{grid-template-columns:1fr}}',
  ].join('');
  document.head.appendChild(style);

  var root = h('div', { class: 'tp hidden', id: 'tuma-payout', 'aria-live': 'polite' });
  anchor.parentNode.insertBefore(root, anchor.nextSibling);

  function kindLabel(type) { return type === 'till' ? 'M‑Pesa Till' : type === 'paybill' ? 'M‑Pesa PayBill' : type === 'own' ? 'Your own Tuma account' : 'Bank'; }

  function statusBox() {
    var s = state.settlement || {};
    var a = s.account;
    if (s.platformReady === false) return h('p', { class: 'tp-state warn', text: 'Wi‑Fi Fiti is finishing its Tuma connection. You can set this up as soon as it is ready.' });
    if (a && a.active) {
      var where = a.destinationType === 'own' ? 'your own Tuma account (' + a.email + ')'
        : kindLabel(a.destinationType) + (a.destinationType === 'bank' ? ' · ' + a.destinationName : '') + (a.accountLast4 ? ' ending ' + a.accountLast4 : '');
      var box = h('p', { class: 'tp-state ' + (a.lastError ? 'bad' : 'ok') }, [h('span', { text: a.lastError ? '⚠' : '✓' }), h('span', {}, [
        document.createTextNode(a.lastError ? 'Tuma reported a problem: ' + a.lastError + ' ' : 'Customer payments go straight to '),
        a.lastError ? null : h('b', { text: where }),
        a.lastError ? null : document.createTextNode('. Nothing passes through Wi‑Fi Fiti.'),
      ])]);
      return box;
    }
    return h('p', { class: 'tp-state warn' }, [h('span', { text: '!' }), h('span', { text: 'Not set yet. Until you add this, Tuma payments are collected by Wi‑Fi Fiti and paid out to you from your balance.' })]);
  }

  function field(label, input, wide) {
    return h('label', wide ? { class: 'wide' } : {}, [h('span', { text: label }), input]);
  }

  function render() {
    root.replaceChildren();
    root.appendChild(h('h3', { text: 'Where should Tuma send your money?' }));
    root.appendChild(h('p', { class: 'tp-lede', text: 'Each payment settles to your account as soon as the customer pays. Wi‑Fi Fiti never holds it.' }));
    if (!state.loaded) { root.appendChild(h('p', { class: 'tp-lede', text: 'Loading…' })); return; }
    root.appendChild(statusBox());
    var s = state.settlement || {};
    if (s.platformReady === false) return;
    var a = s.account;
    if (a && a.active && a.mode === 'linked') {
      var disconnect = h('button', { type: 'button', class: 'secondary', text: 'Disconnect this Tuma account' });
      disconnect.addEventListener('click', function () {
        disconnect.disabled = true;
        api('/api/business/tuma/link', { method: 'DELETE' }).then(function (result) { state.settlement = Object.assign({}, state.settlement, result); render(); })
          .catch(function (error) { disconnect.disabled = false; errorLine.textContent = error.message; });
      });
      var errorLine = h('p', { class: 'tp-err' });
      root.appendChild(h('div', { class: 'tp-foot' }, [disconnect])); root.appendChild(errorLine);
      return;
    }
    if (state.linkMode) return renderLink();
    renderDestination(a);
  }

  function renderDestination(account) {
    var d = state.destinations || { till: null, paybill: null, banks: [] };
    var chips = h('div', { class: 'tp-chips', role: 'group', 'aria-label': 'Payout destination' });
    [['till', 'M‑Pesa Till', 'Buy Goods number', d.till], ['paybill', 'M‑Pesa PayBill', 'Business PayBill', d.paybill], ['bank', 'Bank or Sacco', (d.banks || []).length + ' supported', (d.banks || []).length]].forEach(function (item) {
      var chip = h('button', { type: 'button', class: 'tp-chip', 'aria-pressed': String(state.type === item[0]) }, [h('b', { text: item[1] }), h('small', { text: item[2] })]);
      if (!item[3]) chip.disabled = true;
      chip.addEventListener('click', function () { state.type = item[0]; render(); });
      chips.appendChild(chip);
    });
    root.appendChild(chips);

    var grid = h('div', { class: 'tp-grid' });
    var bank = null;
    if (state.type === 'bank') {
      bank = h('select', { name: 'bankId' });
      bank.appendChild(h('option', { value: '', text: 'Choose your bank or Sacco' }));
      (d.banks || []).forEach(function (b) { var o = h('option', { value: b.id, text: b.name }); if (account && account.bankId === b.id) o.selected = true; bank.appendChild(o); });
      grid.appendChild(field('Bank or Sacco', bank, true));
    }
    var number = h('input', { name: 'accountNumber', inputmode: state.type === 'bank' ? 'text' : 'numeric', autocomplete: 'off',
      placeholder: state.type === 'till' ? 'e.g. 5123456' : state.type === 'paybill' ? 'e.g. 400200' : 'Account number' });
    grid.appendChild(field(state.type === 'till' ? 'Till number' : state.type === 'paybill' ? 'PayBill number' : 'Account number', number));
    var name = h('input', { name: 'settlementName', autocomplete: 'name', placeholder: 'e.g. Wanjiru Akinyi Otieno' });
    if (account && account.settlementName) name.value = account.settlementName;
    grid.appendChild(field('Full name as it appears on your ID', name));
    var mobile = h('input', { name: 'mobile', inputmode: 'tel', autocomplete: 'tel', placeholder: '0712 345 678' });
    if (account && account.mobile) mobile.value = '0' + String(account.mobile).slice(3);
    grid.appendChild(field('Contact phone', mobile));
    var email = null;
    if (!account) { email = h('input', { name: 'email', type: 'email', autocomplete: 'email', placeholder: 'Leave blank to use your sign-in email' }); grid.appendChild(field('Email for Tuma', email)); }
    root.appendChild(grid);

    var errorLine = h('p', { class: 'tp-err' });
    var save = h('button', { type: 'button', text: account ? 'Update payout account' : 'Save payout account' });
    var linkButton = h('button', { type: 'button', class: 'tp-link', text: 'Already have a Tuma account? Link it instead' });
    linkButton.addEventListener('click', function () { state.linkMode = true; render(); });
    save.addEventListener('click', function () {
      [bank, number, name, mobile, email].forEach(function (input) { if (input) input.removeAttribute('data-invalid'); });
      errorLine.textContent = '';
      save.disabled = true; save.textContent = 'Saving…';
      var body = { destinationType: state.type, bankId: bank ? bank.value : undefined, accountNumber: number.value,
        settlementName: name.value, mobile: mobile.value, email: email ? email.value : undefined };
      api('/api/business/tuma/settlement', { method: 'POST', body: JSON.stringify(body) }).then(function (result) {
        state.settlement = Object.assign({}, state.settlement, result);
        render();
        var test = document.getElementById('test-integration'); if (test) test.click();
      }).catch(function (error) {
        errorLine.textContent = error.message;
        var bad = { bankId: bank, accountNumber: number, settlementName: name, mobile: mobile, email: email }[error.field];
        if (bad) { bad.setAttribute('data-invalid', 'true'); bad.focus(); }
      }).finally(function () { save.disabled = false; save.textContent = account ? 'Update payout account' : 'Save payout account'; });
    });
    root.appendChild(h('div', { class: 'tp-foot' }, [save, account ? null : linkButton]));
    root.appendChild(errorLine);
  }

  function renderLink() {
    var grid = h('div', { class: 'tp-grid' });
    var email = h('input', { type: 'email', autocomplete: 'email', placeholder: 'you@business.co.ke' });
    var key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'tuma_…' });
    grid.appendChild(field('Tuma account email', email));
    grid.appendChild(field('Tuma API key', key));
    root.appendChild(h('p', { class: 'tp-lede', text: 'Payments will settle wherever your Tuma account is set to pay out. Find the API key in your Tuma dashboard.' }));
    root.appendChild(grid);
    var errorLine = h('p', { class: 'tp-err' });
    var save = h('button', { type: 'button', text: 'Link my Tuma account' });
    var back = h('button', { type: 'button', class: 'tp-link', text: 'Back' });
    back.addEventListener('click', function () { state.linkMode = false; render(); });
    save.addEventListener('click', function () {
      errorLine.textContent = ''; save.disabled = true; save.textContent = 'Checking with Tuma…';
      api('/api/business/tuma/link', { method: 'POST', body: JSON.stringify({ email: email.value, apiKey: key.value }) }).then(function (result) {
        state.settlement = Object.assign({}, state.settlement, result); state.linkMode = false; render();
        var test = document.getElementById('test-integration'); if (test) test.click();
      }).catch(function (error) { errorLine.textContent = error.message; })
        .finally(function () { save.disabled = false; save.textContent = 'Link my Tuma account'; });
    });
    root.appendChild(h('div', { class: 'tp-foot' }, [save, back]));
    root.appendChild(errorLine);
  }

  function load() {
    if (state.loading || state.loaded) return;
    state.loading = true;
    render();
    api('/api/business/tuma/settlement').then(function (settlement) {
      state.settlement = settlement;
      if (settlement.account && ['till', 'paybill', 'bank'].indexOf(settlement.account.destinationType) >= 0) state.type = settlement.account.destinationType;
      if (!settlement.platformReady) return null;
      return api('/api/business/tuma/destinations').then(function (d) { state.destinations = d; })
        .catch(function (error) { state.destinations = { till: null, paybill: null, banks: [] }; state.settlement.platformReady = true; state.loadError = error.message; });
    }).catch(function (error) { state.settlement = { account: null, platformReady: true }; state.loadError = error.message; })
      .finally(function () { state.loading = false; state.loaded = true; render(); if (state.loadError) root.appendChild(h('p', { class: 'tp-err', text: state.loadError })); });
  }

  // ---- Tuma monthly fee card (Billing & payments) --------------------------
  var feeStyle = document.createElement('style');
  feeStyle.textContent = [
    '.tf{margin:0 0 16px;padding:16px 18px;border:1px solid var(--line);border-radius:16px;background:var(--surface);text-align:left}',
    '.tf h3{margin:0 0 4px;font-size:16px;color:var(--ink)}.tf p{margin:0;color:var(--muted);font-size:14px;line-height:1.5}',
    '.tf-bar{height:8px;margin:12px 0 8px;border-radius:999px;background:rgba(127,150,180,.18);overflow:hidden}.tf-bar i{display:block;height:100%;border-radius:999px;background:var(--good)}',
    '.tf.approaching .tf-bar i,.tf.due .tf-bar i{background:var(--warn)}.tf.overdue .tf-bar i{background:var(--bad)}',
    '.tf.due,.tf.approaching{border-color:rgba(168,107,0,.35)}.tf.overdue{border-color:rgba(189,56,82,.45)}',
    '.tf-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px}.tf-row input{max-width:200px}',
    '.tf-msg{min-height:18px;margin-top:6px;font-size:13px;color:var(--muted)}',
  ].join('');
  document.head.appendChild(feeStyle);
  var feeCard = h('div', { class: 'tf hidden', id: 'tuma-fee-card', 'aria-live': 'polite' });
  var billing = document.getElementById('billing-section');
  var billingPanel = billing && billing.querySelector('.panel');
  if (billingPanel) billingPanel.insertBefore(feeCard, billingPanel.firstChild);
  var feePoll = null;
  function kesText(n) { return 'KES ' + Math.round(Number(n) || 0).toLocaleString('en-KE'); }
  function dayText(raw) { var d = new Date(raw); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
  function renderFee(data) {
    if (!billingPanel) return;
    var fee = data && (data.outstanding || data.current);
    if (!fee || (fee.stage === 'below' && !fee.salesKes)) { feeCard.classList.add('hidden'); return; }
    feeCard.className = 'tf ' + fee.stage; feeCard.replaceChildren();
    var title = fee.stage === 'paid' ? 'Tuma fee paid for this month'
      : fee.stage === 'overdue' ? 'Sales paused: Tuma fee unpaid'
      : fee.stage === 'due' ? 'Tuma fee due: ' + kesText(fee.feeKes)
      : fee.stage === 'approaching' ? 'You are close to the Tuma fee threshold' : 'Tuma sales this month';
    var text = fee.stage === 'paid' ? 'Thank you. No further Tuma fee is due this month.'
      : fee.stage === 'overdue' ? 'New customer payments are paused until the ' + kesText(fee.feeKes) + ' fee is paid. Customers already online keep their time.'
      : fee.stage === 'due' ? 'Your Tuma sales passed ' + kesText(fee.thresholdKes) + '. Pay by ' + dayText(fee.pauseAt) + ' to keep taking payments.'
      : 'When your Tuma sales reach ' + kesText(fee.thresholdKes) + ' in a month, a flat ' + kesText(fee.feeKes) + ' fee applies.' + (fee.canPay ? ' You can pay it early now to avoid any interruption.' : '');
    feeCard.appendChild(h('h3', { text: title }));
    feeCard.appendChild(h('p', { text: text }));
    var pct = Math.min(100, Math.round(100 * fee.salesKes / fee.thresholdKes));
    var bar = h('div', { class: 'tf-bar' }, [h('i', {})]); bar.firstChild.style.width = pct + '%';
    feeCard.appendChild(bar);
    feeCard.appendChild(h('p', { text: kesText(fee.salesKes) + ' of ' + kesText(fee.thresholdKes) + ' in Tuma sales this month' }));
    if (!fee.canPay && fee.stage !== 'due' && fee.stage !== 'overdue') return;
    var phone = h('input', { inputmode: 'tel', autocomplete: 'tel', placeholder: '0712 345 678', 'aria-label': 'M-Pesa number to pay' });
    var pay = h('button', { type: 'button', text: 'Pay ' + kesText(fee.feeKes) + ' by M‑Pesa' });
    var msg = h('p', { class: 'tf-msg' });
    pay.addEventListener('click', function () {
      pay.disabled = true; msg.textContent = 'Sending M‑Pesa prompt…';
      api('/api/business/tuma/fee/checkout', { method: 'POST', body: JSON.stringify({ phone: phone.value }) }).then(function (result) {
        msg.textContent = 'Prompt sent to ' + (result.phoneDisplay || 'your phone') + '. Enter your M‑Pesa PIN to pay.';
        var tries = 0; clearTimeout(feePoll);
        (function poll() {
          api('/api/business/billing/status/' + encodeURIComponent(result.checkoutRequestId)).then(function (s) {
            if (s.status === 'paid') { msg.textContent = 'Payment received.'; loadFee(); return; }
            if (s.status === 'failed') { msg.textContent = s.reason || 'Payment was not completed.'; pay.disabled = false; return; }
            if (++tries < 36) feePoll = setTimeout(poll, 5000); else pay.disabled = false;
          }).catch(function () { if (++tries < 36) feePoll = setTimeout(poll, 5000); });
        }());
      }).catch(function (error) { msg.textContent = error.message; pay.disabled = false; });
    });
    feeCard.appendChild(h('div', { class: 'tf-row' }, [phone, pay]));
    feeCard.appendChild(msg);
  }
  function loadFee() { api('/api/business/tuma/fee').then(renderFee).catch(function () { feeCard.classList.add('hidden'); }); }
  if (billingPanel) { loadFee(); setInterval(loadFee, 5 * 60 * 1000); }

  function sync() {
    var on = select.value === 'tuma';
    root.classList.toggle('hidden', !on);
    if (on) load();
  }
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, { childList: true, attributes: true });
  // renderIntegrations() sets .value programmatically (no change event).
  setInterval(function () { if ((select.value === 'tuma') === root.classList.contains('hidden')) sync(); }, 800);
  sync();
})();

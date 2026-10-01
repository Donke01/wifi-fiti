/* Settings → Payment methods.
 *
 * A business can hold many payment methods and give each router its own:
 * Wi-Fi Fiti collection, any number of its own Till / PayBill accounts
 * (Daraja), and its Tuma settlement account when connected. One method is
 * the default for routers without their own choice. Server side:
 * src/lib/payment-methods.js.
 *
 * business.html calls window.FitiPaymentMethods.load() when the tab opens. */
(function () {
  'use strict';
  var TOKEN_KEY = 'fiti_business_token';
  var data = null; var loading = false; var adding = false; var c2b = null; var addingC2b = false; var addingPayout = false; var addingTuma = false; var tumaBanks = null;

  function $(id) { return document.getElementById(id); }
  function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function api(path, options) {
    options = options || {};
    var bearer = token();
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, bearer ? { Authorization: 'Bearer ' + bearer } : {});
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
      var value = attrs[key]; if (value === undefined || value === null || value === false) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }
  function busy(button, on, label) {
    if (!button) return;
    if (on) { button.dataset.label = button.textContent; button.textContent = label || 'Saving…'; button.disabled = true; }
    else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; }
  }
  function say(id, text, ok) { var node = $(id); if (node) { node.textContent = text || ''; node.className = 'pm-msg' + (ok ? ' ok' : ''); } }
  var ICONS = { fiti: 'WF', daraja: 'M', tuma: 'T' };
  var KIND_NAMES = { fiti: 'Wi-Fi Fiti collects', daraja: 'Your own Till / PayBill', tuma: 'Tuma settlement' };
  var SOURCE_NAMES = { router: 'Chosen for this router', default: 'Business default', legacy: 'Current setting' };

  function save(path, method, body, messageId, done) {
    return api(path, { method: method, body: JSON.stringify(body || {}) })
      .then(function (result) { data = result; render(); if (done) say(messageId, done, true); return result; })
      .catch(function (error) { say(messageId, error.message); throw error; });
  }

  function methodOptions(selected, includeDefault) {
    var options = [];
    if (includeDefault) options.push(h('option', { value: '', text: 'Use the business default' }));
    data.methods.forEach(function (method) {
      var option = h('option', { value: method.id, text: method.label + (method.kind === 'daraja' ? '' : ' · ' + KIND_NAMES[method.kind]) });
      if (method.id === selected) option.selected = true;
      options.push(option);
    });
    return options;
  }

  function methodCard(method) {
    var actions = [];
    if (!method.isDefault) actions.push(h('button', { type: 'button', class: 'quiet', text: 'Make default', onclick: function (event) {
      var button = event.currentTarget; busy(button, true);
      save('/api/business/payment-methods/default', 'PUT', { method: method.id }, 'pm-methods-msg', method.label + ' is now the default.').catch(function () { busy(button, false); });
    } }));
    if (method.kind === 'tuma' && method.accountId) {
      actions.push(h('button', { type: 'button', class: 'quiet pm-danger', text: 'Remove', onclick: function (event) {
        var users = data.routers.filter(function (router) { return router.chosen === method.id; }).length;
        if (!window.confirm('Remove ' + method.label + '? Wi-Fi Fiti will switch this Tuma account off.' + (users ? ' ' + users + ' router' + (users === 1 ? '' : 's') + ' using it will switch to the business default.' : '') + ' Past payments are kept.')) return;
        var button = event.currentTarget; busy(button, true, 'Removing…');
        save('/api/business/payment-methods/' + encodeURIComponent(method.id), 'DELETE', {}, 'pm-methods-msg', method.label + ' removed.').catch(function () { busy(button, false); });
      } }));
    }
    if (method.kind === 'daraja') {
      actions.push(h('button', { type: 'button', class: 'quiet', text: 'Rename', onclick: function () {
        var label = window.prompt('Name for this account (e.g. Kitale Till):', method.label);
        if (label === null) return;
        save('/api/business/payment-methods/' + encodeURIComponent(method.id), 'PATCH', { label: label }, 'pm-methods-msg', 'Renamed.').catch(function () {});
      } }));
      actions.push(h('button', { type: 'button', class: 'quiet pm-danger', text: 'Remove', onclick: function (event) {
        var users = data.routers.filter(function (router) { return router.chosen === method.id; }).length;
        var warning = 'Remove ' + method.label + '?' + (users ? ' ' + users + ' router' + (users === 1 ? '' : 's') + ' using it will switch to the business default.' : '') + ' Past payments are kept.';
        if (!window.confirm(warning)) return;
        var button = event.currentTarget; busy(button, true, 'Removing…');
        save('/api/business/payment-methods/' + encodeURIComponent(method.id), 'DELETE', {}, 'pm-methods-msg', method.label + ' removed.').catch(function () { busy(button, false); });
      } }));
    }
    var users = data.routers.filter(function (router) { return router.effective.id === method.id; }).map(function (router) { return router.name; });
    return h('li', { class: 'pm-method' + (method.isDefault ? ' is-default' : '') }, [
      h('span', { class: 'pm-icon pm-' + method.kind, 'aria-hidden': 'true', text: ICONS[method.kind] || '•' }),
      h('div', { class: 'pm-body' }, [
        h('b', {}, [method.label, method.isDefault ? h('span', { class: 'pm-tag', text: 'Default' }) : null]),
        h('small', { text: method.detail || KIND_NAMES[method.kind] }),
        h('small', { class: 'pm-users', text: users.length ? 'Used by: ' + users.join(', ') : 'Not used by any router yet' }),
      ]),
      h('div', { class: 'pm-actions' }, actions),
    ]);
  }

  function addForm() {
    var form = h('form', { class: 'pm-add', novalidate: true, autocomplete: 'off', onsubmit: function (event) {
      event.preventDefault(); var button = form.querySelector('button[type="submit"]'); say('pm-add-msg', '');
      var body = {}; ['label', 'transactionType', 'shortcode', 'consumerKey', 'consumerSecret', 'passkey'].forEach(function (name) { body[name] = form.elements[name].value.trim(); });
      if (!/^\d{5,12}$/.test(body.shortcode)) { say('pm-add-msg', 'Enter the Till or PayBill number (digits only).'); return; }
      if (!body.consumerKey || !body.consumerSecret || !body.passkey) { say('pm-add-msg', 'Enter the consumer key, consumer secret and passkey from your Daraja app.'); return; }
      busy(button, true, 'Checking with M-Pesa…');
      api('/api/business/payment-methods/daraja', { method: 'POST', body: JSON.stringify(body) })
        .then(function (result) { data = result; adding = false; render(); say('pm-methods-msg', (result.method ? result.method.label : 'Account') + ' added. Choose which routers use it below.', true); })
        .catch(function (error) { busy(button, false); say('pm-add-msg', error.message); });
    } }, [
      h('h4', { text: 'Add a Till or PayBill' }),
      h('p', { class: 'pm-note', text: 'Use the keys from the Daraja app for this Till or PayBill. We check them with M-Pesa before saving, and store them encrypted.' }),
      h('div', { class: 'pm-fields' }, [
        field('Name (optional)', h('input', { name: 'label', maxlength: '60', placeholder: 'e.g. Kitale Till' })),
        field('Type', h('select', { name: 'transactionType' }, [h('option', { value: 'CustomerBuyGoodsOnline', text: 'Till (Buy Goods)' }), h('option', { value: 'CustomerPayBillOnline', text: 'PayBill' })])),
        field('Till / PayBill number', h('input', { name: 'shortcode', inputmode: 'numeric', maxlength: '12', placeholder: '123456' })),
        field('Consumer key', h('input', { name: 'consumerKey', autocomplete: 'off', spellcheck: 'false' })),
        field('Consumer secret', h('input', { name: 'consumerSecret', type: 'password', autocomplete: 'new-password' })),
        field('Passkey', h('input', { name: 'passkey', type: 'password', autocomplete: 'new-password' })),
      ]),
      h('div', { class: 'pm-msg', id: 'pm-add-msg', 'aria-live': 'polite' }),
      h('div', { class: 'buttons' }, [h('button', { type: 'submit', text: 'Check and add' }), h('button', { type: 'button', class: 'secondary', text: 'Cancel', onclick: function () { adding = false; render(); } })]),
    ]);
    return form;
  }
  function tumaForm() {
    var mode = h('select', { name: 'mode' }, [h('option', { value: 'managed', text: 'Wi-Fi Fiti creates a new Tuma account for me' }), h('option', { value: 'linked', text: 'Link a Tuma account I already have' })]);
    var type = h('select', { name: 'destinationType' }, [h('option', { value: 'till', text: 'M-Pesa Till' }), h('option', { value: 'paybill', text: 'M-Pesa PayBill' }), h('option', { value: 'bank', text: 'Bank or Sacco account' })]);
    var bank = h('select', { name: 'bankId' }, [h('option', { value: '', text: 'Loading banks…' })]);
    var bankField = field('Bank or Sacco', bank); bankField.classList.add('hidden');
    var managed = h('div', { class: 'pm-fields' }, [
      field('Tuma settles to', type), bankField,
      field('Till, PayBill or account number', h('input', { name: 'accountNumber', autocomplete: 'off', maxlength: '34' })),
      field('Your full name, as on your ID', h('input', { name: 'settlementName', autocomplete: 'name', maxlength: '120' })),
      field('Your mobile number', h('input', { name: 'mobile', inputmode: 'tel', autocomplete: 'tel', placeholder: '0712 345 678' })),
    ]);
    var linked = h('div', { class: 'pm-fields hidden' }, [
      field('Tuma account email', h('input', { name: 'email', type: 'email', autocomplete: 'off' })),
      field('Tuma API key', h('input', { name: 'apiKey', type: 'password', autocomplete: 'new-password' })),
    ]);
    function loadBanks() {
      if (tumaBanks) return fillBanks();
      api('/api/business/tuma/destinations').then(function (result) { tumaBanks = result.banks || []; fillBanks(); })
        .catch(function (error) { say('pm-tuma-msg', error.message); });
    }
    function fillBanks() { bank.replaceChildren.apply(bank, [h('option', { value: '', text: 'Choose your bank or Sacco' })].concat(tumaBanks.map(function (item) { return h('option', { value: item.id, text: item.name }); }))); }
    type.addEventListener('change', function () { var isBank = type.value === 'bank'; bankField.classList.toggle('hidden', !isBank); if (isBank) loadBanks(); });
    mode.addEventListener('change', function () { var isLinked = mode.value === 'linked'; managed.classList.toggle('hidden', isLinked); linked.classList.toggle('hidden', !isLinked); });
    var form = h('form', { class: 'pm-add', novalidate: true, autocomplete: 'off', onsubmit: function (event) {
      event.preventDefault(); var button = form.querySelector('button[type="submit"]'); say('pm-tuma-msg', '');
      var body = { mode: mode.value, label: form.elements.label.value.trim() };
      if (mode.value === 'linked') { body.email = form.elements.email.value.trim(); body.apiKey = form.elements.apiKey.value.trim(); }
      else ['destinationType', 'bankId', 'accountNumber', 'settlementName', 'mobile'].forEach(function (name) { body[name] = form.elements[name].value.trim(); });
      busy(button, true, 'Setting up with Tuma…');
      api('/api/business/payment-methods/tuma', { method: 'POST', body: JSON.stringify(body) })
        .then(function (result) { data = result; addingTuma = false; render(); say('pm-methods-msg', (result.account ? result.account.label : 'Tuma account') + ' added. Choose which routers use it below.', true); })
        .catch(function (error) { busy(button, false); say('pm-tuma-msg', error.message); });
    } }, [
      h('h4', { text: 'Add a Tuma settlement account' }),
      h('p', { class: 'pm-note', text: 'Tuma settles each payment straight to the Till, PayBill or bank you choose here. Your main Tuma account is not changed.' }),
      h('div', { class: 'pm-fields' }, [field('How', mode), field('Name (optional)', h('input', { name: 'label', maxlength: '60', placeholder: 'e.g. Eldoret bank' }))]),
      managed, linked,
      h('div', { class: 'pm-msg', id: 'pm-tuma-msg', 'aria-live': 'polite' }),
      h('div', { class: 'buttons' }, [h('button', { type: 'submit', text: 'Add Tuma account' }), h('button', { type: 'button', class: 'secondary', text: 'Cancel', onclick: function () { addingTuma = false; render(); } })]),
    ]);
    return form;
  }

  function field(label, input) { return h('label', { class: 'pm-field' }, [h('span', { text: label }), input]); }

  function routersTable() {
    if (!data.routers.length) return h('p', { class: 'pm-note', text: 'Add a router first, then choose where its payments go.' });
    return h('div', { class: 'pm-routers' }, data.routers.map(function (router) {
      var select = h('select', { 'aria-label': 'Payment method for ' + router.name, onchange: function (event) {
        var target = event.currentTarget; target.disabled = true;
        save('/api/business/locations/' + encodeURIComponent(router.locationId) + '/payment-method', 'PUT', { method: target.value || null }, 'pm-routers-msg', router.name + ' saved.')
          .catch(function () { target.disabled = false; });
      } }, methodOptions(router.chosen, true));
      var effective = router.effective;
      return h('div', { class: 'pm-router' }, [
        h('div', {}, [h('b', { text: router.name }), h('small', { class: effective.missing ? 'pm-warn' : '', text: effective.missing
          ? 'Payments are blocked: connect a Till / PayBill or choose another method.'
          : 'Payments go to ' + effective.label + ' · ' + (SOURCE_NAMES[effective.source] || '') })]),
        select,
      ]);
    }));
  }

  /* ---- C2B PayBills (customers pay a PayBill themselves) ---------- */
  function routerName(locationId) { var router = data.routers.find(function (item) { return item.locationId === locationId; }); return router ? router.name : 'A removed router'; }
  function copyButton(text) {
    return h('button', { type: 'button', class: 'quiet', text: 'Copy', onclick: function (event) { var button = event.currentTarget; if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { button.textContent = 'Copied'; }); } });
  }
  function c2bCard() {
    var accounts = (c2b && c2b.accounts) || [];
    var form = null;
    if (addingC2b) {
      var routerSelect = h('select', { name: 'locationId' }, data.routers.map(function (router) { return h('option', { value: router.locationId, text: router.name }); }));
      form = h('form', { class: 'pm-add', novalidate: true, onsubmit: function (event) {
        event.preventDefault(); var button = form.querySelector('button[type="submit"]'); say('pm-c2b-msg', '');
        var shortcode = form.elements.shortcode.value.trim();
        if (!/^\d{5,12}$/.test(shortcode)) { say('pm-c2b-msg', 'Enter the PayBill number (digits only).'); return; }
        busy(button, true);
        api('/api/business/integrations/c2b', { method: 'POST', body: JSON.stringify({ shortcode: shortcode, locationId: form.elements.locationId.value, accountPrefix: form.elements.accountPrefix.value.trim() }) })
          .then(function (result) { c2b = result; addingC2b = false; render(); say('pm-c2b-msg', 'PayBill ' + shortcode + ' saved. Register its links with Safaricom below.', true); })
          .catch(function (error) { busy(button, false); say('pm-c2b-msg', error.message); });
      } }, [
        h('h4', { text: 'Add a C2B PayBill' }),
        h('p', { class: 'pm-note', text: 'Customers pay this PayBill from the M-Pesa menu, using their phone number as the account. The payment is matched to the router you pick. One PayBill per router; adding another for the same router replaces it.' }),
        h('div', { class: 'pm-fields' }, [
          field('Router', routerSelect),
          field('PayBill number', h('input', { name: 'shortcode', inputmode: 'numeric', maxlength: '12', placeholder: '600555' })),
          field('Account prefix (optional)', h('input', { name: 'accountPrefix', maxlength: '20', placeholder: 'e.g. KIT' })),
        ]),
        h('div', { class: 'buttons' }, [h('button', { type: 'submit', text: 'Save PayBill' }), h('button', { type: 'button', class: 'secondary', text: 'Cancel', onclick: function () { addingC2b = false; render(); } })]),
      ]);
    }
    return h('div', { class: 'panel glass pm-card' }, [
      h('div', { class: 'pm-head' }, [h('h3', { text: 'C2B PayBills' }),
        addingC2b || !data.routers.length ? null : h('button', { type: 'button', class: 'secondary', text: '+ Add PayBill', onclick: function () { addingC2b = true; render(); } })]),
      h('p', { class: 'pm-note', text: 'For customers who pay with “Lipa na PayBill” instead of the M-Pesa prompt. Each router can have its own.' }),
      form,
      accounts.length ? h('ul', { class: 'pm-list' }, accounts.map(function (account) {
        return h('li', { class: 'pm-method pm-c2b-row' }, [
          h('span', { class: 'pm-icon pm-daraja', 'aria-hidden': 'true', text: 'PB' }),
          h('div', { class: 'pm-body' }, [
            h('b', { text: 'PayBill ' + account.shortcode }),
            h('small', { text: routerName(account.locationId) + (account.accountPrefix ? ' · account starts with ' + account.accountPrefix : ' · account is the phone number') }),
            h('small', { class: 'pm-users', text: 'Confirmation URL: ' + account.callbackUrl }),
          ]),
          h('div', { class: 'pm-actions' }, [copyButton(account.callbackUrl), h('button', { type: 'button', class: 'quiet pm-danger', text: 'Remove', onclick: function (event) {
            if (!window.confirm('Stop matching payments to PayBill ' + account.shortcode + '? Past payments are kept.')) return;
            var button = event.currentTarget; busy(button, true, 'Removing…');
            api('/api/business/integrations/c2b/' + encodeURIComponent(account.shortcode), { method: 'DELETE' })
              .then(function (result) { c2b = Object.assign({}, c2b, { accounts: result.accounts }); render(); say('pm-c2b-msg', 'PayBill ' + account.shortcode + ' removed.', true); })
              .catch(function (error) { busy(button, false); say('pm-c2b-msg', error.message); });
          } })]),
        ]);
      })) : (addingC2b ? null : h('p', { class: 'pm-note', text: data.routers.length ? 'No C2B PayBills yet.' : 'Add a router first.' })),
      h('div', { class: 'pm-msg', id: 'pm-c2b-msg', 'aria-live': 'polite' }),
    ]);
  }

  /* ---- Payout accounts (where Wi-Fi Fiti pays you) ----------------- */
  function payoutCard() {
    var accounts = data.payoutAccounts || [];
    var form = null;
    if (addingPayout) {
      form = h('form', { class: 'pm-add', novalidate: true, onsubmit: function (event) {
        event.preventDefault(); var button = form.querySelector('button[type="submit"]'); say('pm-payout-msg', '');
        var body = {}; ['label', 'destinationType', 'destinationName', 'destinationAccount'].forEach(function (name) { body[name] = form.elements[name].value.trim(); });
        busy(button, true);
        api('/api/business/payment-methods/payout', { method: 'POST', body: JSON.stringify(body) })
          .then(function (result) { data = result; addingPayout = false; render(); say('pm-payout-msg', 'Payout account saved.', true); })
          .catch(function (error) { busy(button, false); say('pm-payout-msg', error.message); });
      } }, [
        h('h4', { text: 'Add a payout account' }),
        h('div', { class: 'pm-fields' }, [
          field('Pay out to', h('select', { name: 'destinationType' }, [h('option', { value: 'mpesa', text: 'M-Pesa' }), h('option', { value: 'bank', text: 'Bank account' })])),
          field('Name on the account', h('input', { name: 'destinationName', maxlength: '60', autocomplete: 'name' })),
          field('M-Pesa number or bank account number', h('input', { name: 'destinationAccount', maxlength: '40', autocomplete: 'off', placeholder: '0712 345 678' })),
          field('Name (optional)', h('input', { name: 'label', maxlength: '60', placeholder: 'e.g. Equity savings' })),
        ]),
        h('div', { class: 'buttons' }, [h('button', { type: 'submit', text: 'Save account' }), h('button', { type: 'button', class: 'secondary', text: 'Cancel', onclick: function () { addingPayout = false; render(); } })]),
      ]);
    }
    return h('div', { class: 'panel glass pm-card' }, [
      h('div', { class: 'pm-head' }, [h('h3', { text: 'Payout accounts' }),
        addingPayout ? null : h('button', { type: 'button', class: 'secondary', text: '+ Add payout account', onclick: function () { addingPayout = true; render(); } })]),
      h('p', { class: 'pm-note', text: 'Where Wi-Fi Fiti sends sales it collected for you. Pick one when you request a payout; the default is filled in for you.' }),
      form,
      accounts.length ? h('ul', { class: 'pm-list' }, accounts.map(function (account) {
        var actions = [];
        if (!account.isDefault) actions.push(h('button', { type: 'button', class: 'quiet', text: 'Make default', onclick: function (event) {
          var button = event.currentTarget; busy(button, true);
          save('/api/business/payment-methods/payout/' + encodeURIComponent(account.id) + '/default', 'PUT', {}, 'pm-payout-msg', 'Default payout account saved.').catch(function () { busy(button, false); });
        } }));
        actions.push(h('button', { type: 'button', class: 'quiet pm-danger', text: 'Remove', onclick: function (event) {
          if (!window.confirm('Remove ' + account.label + '? Payouts already requested are not affected.')) return;
          var button = event.currentTarget; busy(button, true, 'Removing…');
          save('/api/business/payment-methods/payout/' + encodeURIComponent(account.id), 'DELETE', {}, 'pm-payout-msg', 'Payout account removed.').catch(function () { busy(button, false); });
        } }));
        return h('li', { class: 'pm-method' + (account.isDefault ? ' is-default' : '') }, [
          h('span', { class: 'pm-icon pm-payout', 'aria-hidden': 'true', text: account.destinationType === 'mpesa' ? 'M' : 'B' }),
          h('div', { class: 'pm-body' }, [
            h('b', {}, [account.label, account.isDefault ? h('span', { class: 'pm-tag', text: 'Default' }) : null]),
            h('small', { text: (account.destinationType === 'mpesa' ? 'M-Pesa' : 'Bank') + ' ••' + account.accountLast4 + ' · ' + account.destinationName }),
          ]),
          h('div', { class: 'pm-actions' }, actions),
        ]);
      })) : (addingPayout ? null : h('p', { class: 'pm-note', text: 'No payout accounts saved yet.' })),
      h('div', { class: 'pm-msg', id: 'pm-payout-msg', 'aria-live': 'polite' }),
    ]);
  }

  function render() {
    var section = $('payment-methods-section'); if (!section || !data) return;
    var hasMainTuma = data.methods.some(function (method) { return method.id === 'tuma'; });
    var defaultSelect = h('select', { 'aria-label': 'Business default payment method', onchange: function (event) {
      var target = event.currentTarget; target.disabled = true;
      save('/api/business/payment-methods/default', 'PUT', { method: target.value || null }, 'pm-methods-msg', 'Default saved.').catch(function () { target.disabled = false; });
    } }, (data.defaultMethod ? [] : [h('option', { value: '', text: 'Keep the current setting' })]).concat(methodOptions(data.defaultMethod, false)));
    section.replaceChildren(
      h('div', { class: 'module-heading' }, [h('div', {}, [h('h2', { text: 'Payment methods' }), h('p', { text: 'Add every Till, PayBill and payout account you use, then choose where each router’s customer payments go.' })])]),
      h('div', { class: 'panel glass pm-card' }, [
        h('div', { class: 'pm-head' }, [h('h3', { text: 'Your payment methods' }),
          adding || addingTuma ? null : h('div', { class: 'pm-head-actions' }, [
            hasMainTuma ? h('button', { type: 'button', class: 'secondary', text: '+ Add Tuma account', onclick: function () { addingTuma = true; render(); } }) : null,
            h('button', { type: 'button', text: '+ Add Till or PayBill', onclick: function () {
              if (!data.secureStorageReady) { say('pm-methods-msg', 'Secure payment storage is not set up by Wi-Fi Fiti yet, so accounts cannot be added.'); return; }
              adding = true; render(); var first = document.querySelector('#payment-methods-section .pm-add input'); if (first) first.focus();
            } })])]),
        adding ? addForm() : null,
        addingTuma ? tumaForm() : null,
        h('ul', { class: 'pm-list' }, data.methods.map(methodCard)),
        h('div', { class: 'pm-msg', id: 'pm-methods-msg', 'aria-live': 'polite' }),
        h('label', { class: 'pm-field pm-default' }, [h('span', { text: 'Default for routers without their own choice' }), defaultSelect]),
        hasMainTuma ? null : h('p', { class: 'pm-note', text: 'Tuma settlement appears here once your Tuma payout account is connected in Settings → Billing & payments. You can then add more Tuma accounts here.' }),
      ]),
      h('div', { class: 'panel glass pm-card' }, [
        h('h3', { text: 'Routers' }),
        h('p', { class: 'pm-note', text: 'Each router can send its customer payments to a different method. Changes apply to the next payment.' }),
        routersTable(),
        h('div', { class: 'pm-msg', id: 'pm-routers-msg', 'aria-live': 'polite' }),
      ]),
      c2bCard(),
      payoutCard()
    );
  }

  function load() {
    var section = $('payment-methods-section'); if (!section || !token() || loading) return Promise.resolve();
    if (!data) section.replaceChildren(h('div', { class: 'module-heading' }, [h('div', {}, [h('h2', { text: 'Payment methods' })])]), h('div', { class: 'panel glass' }, [h('p', { class: 'pm-note', text: 'Loading your payment methods…' })]));
    loading = true;
    return Promise.all([api('/api/business/payment-methods'), api('/api/business/integrations/c2b').catch(function () { return { accounts: [] }; })])
      .then(function (results) { data = results[0]; c2b = results[1]; if (!adding && !addingC2b && !addingPayout && !addingTuma) render(); })
      .catch(function (error) { if (!data) section.replaceChildren(h('div', { class: 'panel glass' }, [h('p', { class: 'pm-msg', text: error.message })])); })
      .then(function () { loading = false; });
  }

  window.FitiPaymentMethods = { load: load, forget: function () { data = null; c2b = null; adding = false; addingC2b = false; addingPayout = false; addingTuma = false; tumaBanks = null; } };
})();

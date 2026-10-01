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
  var data = null; var loading = false; var adding = false;

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

  function render() {
    var section = $('payment-methods-section'); if (!section || !data) return;
    var defaultSelect = h('select', { 'aria-label': 'Business default payment method', onchange: function (event) {
      var target = event.currentTarget; target.disabled = true;
      save('/api/business/payment-methods/default', 'PUT', { method: target.value || null }, 'pm-methods-msg', 'Default saved.').catch(function () { target.disabled = false; });
    } }, (data.defaultMethod ? [] : [h('option', { value: '', text: 'Keep the current setting' })]).concat(methodOptions(data.defaultMethod, false)));
    section.replaceChildren(
      h('div', { class: 'module-heading' }, [h('div', {}, [h('h2', { text: 'Payment methods' }), h('p', { text: 'Add every Till, PayBill and payout route you use, then choose where each router’s customer payments go.' })])]),
      h('div', { class: 'panel glass pm-card' }, [
        h('div', { class: 'pm-head' }, [h('h3', { text: 'Your payment methods' }),
          adding ? null : h('button', { type: 'button', text: '+ Add Till or PayBill', onclick: function () {
            if (!data.secureStorageReady) { say('pm-methods-msg', 'Secure payment storage is not set up by Wi-Fi Fiti yet, so accounts cannot be added.'); return; }
            adding = true; render(); var first = document.querySelector('#payment-methods-section .pm-add input'); if (first) first.focus();
          } })]),
        adding ? addForm() : null,
        h('ul', { class: 'pm-list' }, data.methods.map(methodCard)),
        h('div', { class: 'pm-msg', id: 'pm-methods-msg', 'aria-live': 'polite' }),
        h('label', { class: 'pm-field pm-default' }, [h('span', { text: 'Default for routers without their own choice' }), defaultSelect]),
        h('p', { class: 'pm-note', text: 'Tuma settlement appears here once your Tuma payout account is connected in Settings → Billing & payments.' }),
      ]),
      h('div', { class: 'panel glass pm-card' }, [
        h('h3', { text: 'Routers' }),
        h('p', { class: 'pm-note', text: 'Each router can send its customer payments to a different method. Changes apply to the next payment.' }),
        routersTable(),
        h('div', { class: 'pm-msg', id: 'pm-routers-msg', 'aria-live': 'polite' }),
      ])
    );
  }

  function load() {
    var section = $('payment-methods-section'); if (!section || !token() || loading) return Promise.resolve();
    if (!data) section.replaceChildren(h('div', { class: 'module-heading' }, [h('div', {}, [h('h2', { text: 'Payment methods' })])]), h('div', { class: 'panel glass' }, [h('p', { class: 'pm-note', text: 'Loading your payment methods…' })]));
    loading = true;
    return api('/api/business/payment-methods').then(function (result) { data = result; if (!adding) render(); })
      .catch(function (error) { if (!data) section.replaceChildren(h('div', { class: 'panel glass' }, [h('p', { class: 'pm-msg', text: error.message })])); })
      .then(function () { loading = false; });
  }

  window.FitiPaymentMethods = { load: load, forget: function () { data = null; adding = false; } };
})();

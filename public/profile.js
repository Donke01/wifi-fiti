/* My profile in the business dashboard.
 *
 * Opened from the round profile icon in the sidebar (or the name pill at
 * the top of the page). Works for the owner and for team members, always
 * about the signed-in person only:
 *   - who you are, your role and what it can do
 *   - change your display name
 *   - change your password (needs the current one); the owner can also get
 *     an emailed reset code if they never set or forgot it
 *   - see your active sign-ins and sign out the other devices
 *   - your recent actions in the dashboard
 *
 * business.html calls window.FitiProfile.load() when the page opens and
 * window.FitiProfile.setIdentity(who) after /api/business/me. */
(function () {
  'use strict';
  var TOKEN_KEY = 'fiti_business_token';
  var data = null; var mounted = false; var loading = false;

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
  function initials(name, email) {
    var source = String(name || '').trim() || String(email || '').split('@')[0] || '?';
    var parts = source.split(/[\s._-]+/).filter(Boolean);
    return ((parts[0] || '?').charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }
  function when(sql) {
    if (!sql) return '';
    var date = new Date(String(sql).replace(' ', 'T') + 'Z');
    if (isNaN(date.getTime())) return String(sql);
    return date.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function phoneText(value) { var digits = String(value || '').replace(/\D/g, ''); return /^254\d{9}$/.test(digits) ? '0' + digits.slice(3, 6) + ' ' + digits.slice(6, 9) + ' ' + digits.slice(9) : String(value || ''); }
  function busy(button, on, label) {
    if (!button) return;
    if (on) { button.dataset.label = button.textContent; button.textContent = label || 'Saving…'; button.disabled = true; }
    else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; }
  }
  function say(id, text, ok) { var node = $(id); if (!node) return; node.textContent = text || ''; node.className = 'pf-msg' + (ok ? ' ok' : ''); }

  /* ---- The icon ------------------------------------------------------ */
  function setIdentity(who) {
    var badge = $('profile-initials'); if (!badge || !who) return;
    badge.textContent = initials(who.name, who.email);
    var button = $('open-profile');
    if (button) button.setAttribute('title', 'My profile' + (who.name || who.email ? ' · ' + (who.name || who.email) : ''));
  }

  /* ---- The page ------------------------------------------------------ */
  function field(label, input, hint) {
    return h('label', { class: 'pf-field' }, [h('span', { text: label }), input, hint ? h('small', { text: hint }) : null]);
  }
  function passwordInput(name, autocomplete) {
    var input = h('input', { type: 'password', name: name, autocomplete: autocomplete, maxlength: '200', required: true });
    return h('div', { class: 'pf-pass' }, [input, h('button', { type: 'button', class: 'pf-eye', 'aria-label': 'Show password', onclick: function (event) {
      input.type = input.type === 'password' ? 'text' : 'password';
      event.currentTarget.textContent = input.type === 'password' ? 'Show' : 'Hide';
    }, text: 'Show' })]);
  }

  function render() {
    var section = $('profile-section'); if (!section || !data) return;
    var p = data.person;
    var heading = h('div', { class: 'module-heading' }, [h('div', {}, [h('h2', { text: 'My profile' }), h('p', { text: 'Your details, password and sign-ins. Only you can see and change these.' })])]);

    // Who you are
    var card = h('div', { class: 'panel glass pf-card pf-id' }, [
      h('div', { class: 'pf-avatar', 'aria-hidden': 'true', text: initials(p.name, p.email) }),
      h('div', { class: 'pf-who' }, [
        h('h3', { text: p.name || p.email || 'Your profile' }),
        h('p', {}, [h('span', { class: 'pf-role', text: p.roleLabel }), data.business.name ? ' at ' + data.business.name : '']),
        p.roleSummary ? h('small', { text: p.roleSummary }) : null,
      ]),
    ]);
    var facts = h('dl', { class: 'pf-facts' }, [
      h('dt', { text: 'Email' }), h('dd', { text: p.email || '—' }),
      h('dt', { text: 'Phone' }), h('dd', {}, [p.phone ? phoneText(p.phone) : '—', p.isOwner && p.phone ? h('span', { class: 'pf-tag' + (p.phoneVerified ? ' ok' : ''), text: p.phoneVerified ? 'Verified' : 'Not verified' }) : null]),
      p.isOwner && data.business.hotspotName ? h('dt', { text: 'Hotspot name' }) : null, p.isOwner && data.business.hotspotName ? h('dd', { text: data.business.hotspotName }) : null,
      h('dt', { text: p.isOwner ? 'Account created' : 'Joined the team' }), h('dd', { text: when(p.memberSince) || '—' }),
    ]);
    card.appendChild(facts);
    card.appendChild(h('p', { class: 'pf-note', text: p.isOwner
      ? 'Your sign-in email can only be changed by Wi-Fi Fiti support.'
      : 'To change your email, phone or role, ask the owner.' }));
    // The owner edits business details and verifies the phone with the
    // dashboard's existing pop-ups (fiti-actions.js), then this page reloads.
    if (p.isOwner && window.FitiActions) {
      var openAction = function (action) { return function () { window.FitiActions.open({ action: action }, {}).then(function () { load(true); }); }; };
      card.appendChild(h('div', { class: 'buttons pf-actions' }, [
        h('button', { type: 'button', class: 'secondary', text: 'Edit business details', onclick: openAction('organisation') }),
        p.phoneVerified ? null : h('button', { type: 'button', class: 'quiet', text: 'Verify phone number', onclick: openAction('verify_phone') }),
      ]));
    }

    // Name
    var nameInput = h('input', { name: 'name', value: p.name || '', maxlength: '80', autocomplete: 'name', required: true });
    var nameForm = h('form', { class: 'panel glass pf-card', novalidate: true, onsubmit: function (event) {
      event.preventDefault(); var button = event.currentTarget.querySelector('button[type="submit"]'); say('pf-name-msg', '');
      busy(button, true);
      api('/api/business/profile', { method: 'PATCH', body: JSON.stringify({ name: nameInput.value }) })
        .then(function (result) { data.person.name = result.name; setIdentity(data.person); render(); say('pf-name-msg', 'Name saved.', true); })
        .catch(function (error) { busy(button, false); say('pf-name-msg', error.message); });
    } }, [
      h('h3', { text: 'Your name' }),
      field('Display name', nameInput, 'Shown in the dashboard and in the team activity log.'),
      h('div', { class: 'pf-msg', id: 'pf-name-msg', 'aria-live': 'polite' }),
      h('div', { class: 'buttons' }, [h('button', { type: 'submit', text: 'Save name' })]),
    ]);

    // Password
    var currentPass = passwordInput('currentPassword', 'current-password');
    var newPass = passwordInput('newPassword', 'new-password');
    var confirmPass = passwordInput('confirmPassword', 'new-password');
    var passForm = h('form', { class: 'panel glass pf-card', novalidate: true, onsubmit: function (event) {
      event.preventDefault(); var form = event.currentTarget; var button = form.querySelector('button[type="submit"]'); say('pf-pass-msg', '');
      var current = form.elements.currentPassword.value; var next = form.elements.newPassword.value;
      if (!current) { say('pf-pass-msg', 'Enter your current password.'); return; }
      if (next.length < data.passwordRules.minLength) { say('pf-pass-msg', 'Use a new password with at least ' + data.passwordRules.minLength + ' characters.'); return; }
      if (next !== form.elements.confirmPassword.value) { say('pf-pass-msg', 'The new passwords do not match.'); return; }
      busy(button, true, 'Changing…');
      api('/api/business/profile/password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) })
        .then(function (result) { form.reset(); busy(button, false); say('pf-pass-msg', result.message || 'Password changed.', true); load(true); })
        .catch(function (error) { busy(button, false); say('pf-pass-msg', error.message); });
    } }, [
      h('h3', { text: 'Change password' }),
      field('Current password', currentPass),
      field('New password', newPass, 'At least ' + data.passwordRules.minLength + ' characters. Your other devices will be signed out.'),
      field('Confirm new password', confirmPass),
      h('div', { class: 'pf-msg', id: 'pf-pass-msg', 'aria-live': 'polite' }),
      h('div', { class: 'buttons' }, [h('button', { type: 'submit', text: 'Change password' })]),
      p.isOwner ? resetBlock(p.email) : h('p', { class: 'pf-note', text: 'Forgot your current password? Ask the owner for a password reset link.' }),
    ]);

    // Sign-ins
    var sessions = data.sessions || [];
    var others = sessions.filter(function (item) { return !item.current; }).length;
    var signins = h('div', { class: 'panel glass pf-card' }, [
      h('h3', { text: 'Where you are signed in' }),
      h('p', { class: 'pf-note', text: sessions.length === 1 ? 'Only this device is signed in.' : sessions.length + ' sign-ins are active. Each lasts 30 days.' }),
      h('ul', { class: 'pf-list' }, sessions.map(function (item) {
        return h('li', {}, [h('span', { text: item.current ? 'This device' : 'Another device' }), h('small', { text: 'Signed in ' + when(item.signedInAt) + ' · until ' + when(item.expiresAt) })]);
      })),
      h('div', { class: 'pf-msg', id: 'pf-sessions-msg', 'aria-live': 'polite' }),
      others ? h('div', { class: 'buttons' }, [h('button', { type: 'button', class: 'secondary', text: 'Sign out other devices', onclick: function (event) {
        var button = event.currentTarget; busy(button, true, 'Signing out…');
        api('/api/business/profile/sessions/end-others', { method: 'POST', body: '{}' })
          .then(function (result) { load(true).then(function () { say('pf-sessions-msg', (result.ended || 0) + ' other sign-in' + (result.ended === 1 ? '' : 's') + ' ended.', true); }); })
          .catch(function (error) { busy(button, false); say('pf-sessions-msg', error.message); });
      } })]) : null,
    ]);

    // Activity
    var activity = data.activity || [];
    var recent = h('div', { class: 'panel glass pf-card' }, [
      h('h3', { text: 'Your recent activity' }),
      activity.length ? h('ul', { class: 'pf-list' }, activity.map(function (item) {
        return h('li', {}, [h('span', { text: item.action }), h('small', { text: (item.target ? item.target + ' · ' : '') + when(item.at) })]);
      })) : h('p', { class: 'pf-note', text: 'Changes you make in the dashboard will show here.' }),
    ]);

    section.replaceChildren(heading, h('div', { class: 'pf-grid' }, [card, nameForm, passForm, signins, recent]));
  }

  // The owner can get an emailed code (the same one as "Forgot password"
  // on the sign-in page), e.g. after signing up with Google.
  function resetBlock(email) {
    var box = h('div', { class: 'pf-reset' });
    var verificationId = null;
    function step1() {
      box.replaceChildren(
        h('p', { class: 'pf-note', text: 'Forgot it, or signed up with Google and never set one?' }),
        h('button', { type: 'button', class: 'quiet', text: 'Email me a reset code', onclick: function (event) {
          var button = event.currentTarget; busy(button, true, 'Sending…');
          api('/api/business/forgot-password', { method: 'POST', body: JSON.stringify({ email: email }) })
            .then(function (result) { verificationId = result.verificationId || null; if (!verificationId) throw new Error(result.message || 'Email codes are not available right now.'); step2(); })
            .catch(function (error) { busy(button, false); say('pf-reset-msg', error.message); });
        } }),
        h('div', { class: 'pf-msg', id: 'pf-reset-msg', 'aria-live': 'polite' })
      );
    }
    function step2() {
      var code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12' });
      var pass = passwordInput('resetPassword', 'new-password');
      box.replaceChildren(
        h('p', { class: 'pf-note', text: 'We sent a code to ' + email + '. Enter it with your new password. You will be signed out everywhere and can sign in again with the new password.' }),
        field('Code from the email', code),
        field('New password', pass),
        h('div', { class: 'pf-msg', id: 'pf-reset-msg', 'aria-live': 'polite' }),
        h('button', { type: 'button', text: 'Set new password', onclick: function (event) {
          var button = event.currentTarget; var password = pass.querySelector('input').value;
          if (password.length < data.passwordRules.minLength) { say('pf-reset-msg', 'Use a password with at least ' + data.passwordRules.minLength + ' characters.'); return; }
          busy(button, true);
          api('/api/business/reset-password', { method: 'POST', body: JSON.stringify({ verificationId: verificationId, code: code.value, password: password }) })
            .then(function (result) {
              say('pf-reset-msg', (result.message || 'Password updated.') + ' Signing you out…', true);
              setTimeout(function () { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} window.location.reload(); }, 1800);
            })
            .catch(function (error) { busy(button, false); say('pf-reset-msg', error.message); });
        } })
      );
    }
    step1();
    return box;
  }

  function load(silent) {
    var section = $('profile-section'); if (!section || !token()) return Promise.resolve();
    if (!mounted || !data) { mounted = true; section.replaceChildren(h('div', { class: 'module-heading' }, [h('div', {}, [h('h2', { text: 'My profile' })])]), h('div', { class: 'panel glass' }, [h('p', { class: 'pf-note', text: 'Loading your profile…' })])); }
    if (loading) return Promise.resolve(); loading = true;
    return api('/api/business/profile').then(function (result) { data = result; setIdentity(result.person); render(); })
      .catch(function (error) { if (!silent || !data) section.replaceChildren(h('div', { class: 'panel glass' }, [h('p', { class: 'pf-msg', text: error.message })])); })
      .then(function () { loading = false; });
  }

  window.FitiProfile = { load: load, setIdentity: setIdentity, forget: function () { data = null; mounted = false; var badge = $('profile-initials'); if (badge) badge.textContent = ''; } };
})();

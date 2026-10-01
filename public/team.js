/* Team accounts in the business dashboard.
 *
 *  - Hides what the signed-in person's role can't use. This is data-driven,
 *    so it survives the pages being rearranged:
 *      SECTIONS  section id → permission. A page (data-module) shows in the
 *                menu when at least one of its sections is allowed.
 *      PARTS     CSS selector → permission, for pieces inside a page.
 *      data-permission="…" on any element (e.g. a Delete router button).
 *    A section or page not listed is for the owner only. The server checks
 *    every request anyway (src/lib/team.js); this only keeps the page tidy.
 *  - The Team page (owner): members, pending invites, invite link /
 *    WhatsApp share, role change, remove, password reset link, activity.
 *  - The join page: business.html#invite=<token>.
 *
 * window.FitiTeam.apply(member, moduleSections, pages) is called by business.html
 * after /api/business/me. */
(function () {
  'use strict';
  var SALES = ['sales.view', 'sales.today'];
  var SECTIONS = {
    overview: 'any', metrics: 'any', 'overview-golive': 'packages.edit', 'overview-insights-section': SALES, 'onboarding-section': 'routers.edit',
    'router-observability-section': 'routers.view', 'locations-section': 'routers.view', 'location-setup-section': 'routers.edit',
    'router-setup-section': 'routers.edit', 'remote-onboarding-section': 'remote', 'remote-section': 'remote', 'tools-section': 'tools',
    'packages-section': 'packages.edit', 'vouchers-section': 'vouchers.view', 'customers-section': 'customers.view',
    'sales-section': SALES, 'transactions-section': SALES, 'analytics-section': SALES,
    'branding-section': 'portal', 'portal-templates-section': 'portal', 'sms-section': 'sms', 'support-section': 'customers.view',
    'billing-section': 'billing', 'network-services-section': 'billing', 'account-section': 'billing',
    'collection-section': 'payments.settings', 'integrations-section': 'payments.settings',
    'disbursements-section': 'payouts', 'settings-section': 'settings', 'team-section': 'team',
    // Pages added with the 8-page dashboard. Plan receipts are the owner's own billing.
    'pppoe-section': 'customers.edit', 'support-tickets-section': 'support', 'receipts-section': 'owner-only',
    // Everyone has their own profile.
    'profile-section': 'any',
  };
  var PARTS = {
    '.overview-controls': 'sales.view', '#sales-period': 'sales.view', '#analytics-period': 'sales.view',
    '.plan-mini': 'billing', 'a[href="/operations.html"]': 'payouts', '[data-pppoe-link]': 'customers.view',
    '#voucher-form': 'vouchers.create', '.vm-select': 'vouchers.manage', '#vm-actions': 'vouchers.manage', '.vm-help': 'vouchers.manage',
  };
  var ROLE_KEY = 'fiti_business_role';
  var member = null;

  function $(id) { return document.getElementById(id); }
  function storedRole() { try { return JSON.parse(localStorage.getItem(ROLE_KEY) || 'null'); } catch (_) { return null; } }
  function remember(next) { member = next || null; try { if (next) localStorage.setItem(ROLE_KEY, JSON.stringify({ role: next.role, permissions: next.permissions || [], denied: next.denied || [] })); else localStorage.removeItem(ROLE_KEY); } catch (_) {} }
  function current() { return member || storedRole(); }
  /** True when the signed-in person may do this. Unknown yet (before the
   * first /me) counts as allowed; the server still decides. */
  function can(permission) {
    var who = current(); if (!who || who.role === 'owner') return true;
    if (permission === 'any') return true;
    var wanted = Array.isArray(permission) ? permission : [permission];
    return wanted.some(function (item) { return (who.permissions || []).indexOf(item) !== -1; });
  }
  function sectionAllowed(id) { return Object.prototype.hasOwnProperty.call(SECTIONS, id) ? can(SECTIONS[id]) : can('owner-only'); }
  function pageAllowed(module, moduleSections) {
    if (!moduleSections || !moduleSections[module]) return can('owner-only');
    return moduleSections[module].some(sectionAllowed);
  }
  function api(path, options) {
    options = options || {};
    var token = ''; try { token = localStorage.getItem('fiti_business_token') || ''; } catch (_) {}
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
      if (key === 'text') node.textContent = attrs[key]; else if (key === 'class') node.className = attrs[key];
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), attrs[key]); else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }
  function when(raw) { var text = String(raw || ''); var date = new Date(/Z$|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z'); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  function phoneText(msisdn) { var raw = String(msisdn || ''); return /^254\d{9}$/.test(raw) ? '0' + raw.slice(3) : raw; }
  function busy(button, on, text) { if (!button) return; if (on) { button.dataset.label = button.textContent; button.textContent = text || 'Working…'; button.disabled = true; } else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; } }

  var style = document.createElement('style');
  style.textContent = [
    '.tm-grid{display:grid;gap:16px}.tm-card{border:1px solid var(--line);border-radius:16px;padding:18px;background:var(--surface,#fff)}',
    '.tm-card h3{margin:0 0 4px;font-size:17px}.tm-card>p{margin:0 0 14px;color:var(--muted);font-size:14px;line-height:1.45}',
    '.tm-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px}.tm-form label{display:block;min-width:0}.tm-form .tm-wide{grid-column:1/-1}',
    '.tm-form input,.tm-form select{width:100%}.tm-role-help{margin:4px 0 0;color:var(--muted);font-size:13px;line-height:1.4}',
    '.tm-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.tm-row:first-of-type{border-top:0}',
    '.tm-who{min-width:0}.tm-who strong{display:block;overflow-wrap:anywhere}.tm-who small{display:block;color:var(--muted);overflow-wrap:anywhere;margin-top:2px}',
    '.tm-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}.tm-actions select{width:auto;min-width:130px}',
    '.tm-actions button{margin:0}.tm-pill{display:inline-flex;padding:4px 9px;border-radius:99px;font-size:12px;font-weight:800;color:var(--blue);background:#eaf2ff;white-space:nowrap}',
    '.tm-link{margin-top:14px;padding:14px;border:1px solid #bcd6f5;border-radius:14px;background:#f3f8ff}.tm-link input{width:100%;font-size:13px}',
    '.tm-link .tm-actions{justify-content:flex-start;margin-top:10px}.tm-link a.button{text-decoration:none}.tm-note{margin:8px 0 0;color:var(--muted);font-size:13px}',
    '.tm-log{list-style:none;margin:0;padding:0}.tm-log li{padding:10px 0;border-top:1px solid var(--line);font-size:14px;line-height:1.4}.tm-log li:first-child{border-top:0}',
    '.tm-log small{display:block;color:var(--muted);overflow-wrap:anywhere}.tm-roles{margin:0;padding-left:18px;color:var(--muted);font-size:14px;line-height:1.5}.tm-roles strong{color:var(--ink)}',
    '.tm-error{color:var(--bad);font-size:13px;min-height:18px;margin-top:6px}.tm-empty{color:var(--muted);font-size:14px;margin:0}',
    '.tm-signed{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}.tm-signed .tm-pill{font-size:11px}',
    '.tm-join{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:16px;overflow:auto;background:var(--night,#f6f8fc)}',
    '.tm-join .tm-card{width:min(460px,100%);box-shadow:var(--shadow)}.tm-join form label{display:block;margin-top:10px}.tm-join input{width:100%}',
    '.tm-join button[type=submit]{width:100%;margin-top:16px}.tm-join .tm-brand{font-weight:800;color:var(--blue);margin-bottom:12px}',
    '@media (max-width:620px){.tm-form{grid-template-columns:1fr}.tm-row{flex-direction:column;align-items:stretch}.tm-actions{justify-content:flex-start}.tm-actions select{flex:1 1 100%}}',
  ].join('');
  document.head.appendChild(style);
  var gate = document.createElement('style'); gate.id = 'team-permissions'; document.head.appendChild(gate);

  /* ---- Hide what the role can't use --------------------------------- */
  function apply(next, moduleSections, pages) {
    remember(next);
    var who = current(); var rules = [];
    if (who && who.role !== 'owner') {
      Object.keys(SECTIONS).forEach(function (id) { if (!sectionAllowed(id)) rules.push('#' + id); });
      // Sections nobody listed (a new page, say) are for the owner only.
      document.querySelectorAll('#dashboard .content > section[id], #dashboard .content > header[id]').forEach(function (node) { if (!Object.prototype.hasOwnProperty.call(SECTIONS, node.id)) rules.push('#' + node.id); });
      Object.keys(PARTS).forEach(function (selector) { if (!can(PARTS[selector])) rules.push(selector); });
      var modules = {};
      document.querySelectorAll('#dashboard [data-module], #dashboard [data-open-module], #dashboard [data-card-module]').forEach(function (node) { var m = node.getAttribute('data-module') || node.getAttribute('data-open-module') || node.getAttribute('data-card-module'); if (m) modules[m] = true; });
      Object.keys(moduleSections || {}).forEach(function (m) { modules[m] = true; });
      // A menu item is a page of tabs: it shows when any of its tabs is allowed.
      var pageById = {}; (pages || []).forEach(function (page) { pageById[page.id] = page; });
      Object.keys(modules).forEach(function (m) {
        var page = pageById[m];
        var menuAllowed = page ? page.parts.some(function (part) { return pageAllowed(part.id, moduleSections); }) : pageAllowed(m, moduleSections);
        var partAllowed = moduleSections && moduleSections[m] ? pageAllowed(m, moduleSections) : menuAllowed;
        if (!menuAllowed) rules.push('#dashboard .nav [data-module="' + m + '"]');
        if (!partAllowed) rules.push('#dashboard [data-open-module="' + m + '"]', '#dashboard [data-card-module="' + m + '"]');
      });
      (who.denied || []).forEach(function (permission) { rules.push('[data-permission~="' + permission + '"]'); });
    }
    gate.textContent = rules.length ? rules.join(',\n') + '{display:none!important}' : '';
    // A menu heading with nothing left under it goes too.
    document.querySelectorAll('#dashboard .nav .nav-label').forEach(function (label) {
      label.classList.remove('hidden');
      var next = label.nextElementSibling; var shown = false;
      while (next && !next.classList.contains('nav-label') && !next.querySelector('.nav-label')) { if (window.getComputedStyle(next).display !== 'none') shown = true; next = next.nextElementSibling; }
      if (!shown && who && who.role !== 'owner') label.classList.add('hidden');
    });
    showWho(who);
    // The Team page loads once here, and again each time it is opened.
    if (who && who.role === 'owner' && $('team-section') && !mounted) mountTeamPage();
  }
  function showWho(who) {
    var target = $('business-email'); if (!target || !who) return;
    var label = who.role === 'owner' ? (who.email || who.name || 'Owner') : (who.name || who.email || phoneText(who.phone));
    target.replaceChildren(h('span', { class: 'tm-signed' }, [h('span', { text: label }), h('span', { class: 'tm-pill', text: who.roleLabel || (who.role === 'owner' ? 'Owner' : who.role) })]));
  }

  /* ---- Team page (owner) -------------------------------------------- */
  var teamData = null; var teamRoot = null; var lastLink = null; var mounted = false;
  function mountTeamPage() {
    var section = $('team-section'); if (!section) return;
    if (!mounted || !section.contains(teamRoot)) {
      mounted = true;
      section.replaceChildren(h('div', { class: 'module-heading' }, [h('div', {}, [h('h2', { text: 'Team & roles' }), h('p', { text: 'Give staff their own login. Each role sees only what it needs.' })])]));
      teamRoot = h('div', { class: 'tm-grid' }); section.appendChild(teamRoot);
    }
    loadTeam();
  }
  function loadTeam() {
    return api('/api/business/team').then(function (data) { teamData = data; drawTeam(); }).catch(function (error) {
      teamRoot.replaceChildren(h('div', { class: 'tm-card' }, [h('p', { class: 'tm-error', text: error.message })]));
    });
  }
  function roleOptions(select, selected) {
    (teamData.roles || []).filter(function (role) { return role.id !== 'owner'; }).forEach(function (role) {
      var option = h('option', { value: role.id, text: role.label }); if (role.id === selected) option.selected = true; select.appendChild(option);
    });
  }
  function roleSummary(id) { var role = (teamData.roles || []).find(function (item) { return item.id === id; }); return role ? role.summary : ''; }
  function linkCard(result, heading) {
    var input = h('input', { type: 'text', readonly: 'readonly', value: result.link, 'aria-label': 'Invite link' });
    var copied = h('p', { class: 'tm-note', 'aria-live': 'polite' });
    var copy = h('button', { type: 'button', class: 'secondary', text: 'Copy invite link', onclick: function () {
      var done = function () { copied.textContent = 'Copied. Paste it in WhatsApp, SMS or email.'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(result.text || result.link).then(done).catch(function () { input.select(); document.execCommand('copy'); done(); });
      else { input.select(); document.execCommand('copy'); done(); }
    } });
    var share = h('a', { class: 'button', href: result.whatsappUrl, target: '_blank', rel: 'noopener', text: 'Share on WhatsApp' });
    var expires = result.invite && result.invite.expiresAt ? when(result.invite.expiresAt) : '';
    return h('div', { class: 'tm-link' }, [h('strong', { text: heading }), input, h('div', { class: 'tm-actions' }, [share, copy]),
      h('p', { class: 'tm-note', text: 'The link works once' + (expires ? ' and expires ' + expires : '') + '. Only send it to ' + ((result.invite && result.invite.name) || 'this person') + '.' + (result.emailed ? ' We also emailed it to ' + result.invite.email + '.' : '') }), copied]);
  }
  function drawTeam() {
    teamRoot.replaceChildren();
    // Invite
    var error = h('div', { class: 'tm-error', 'aria-live': 'polite' });
    var role = h('select', { name: 'role', required: 'required' }); roleOptions(role, 'attendant');
    var help = h('p', { class: 'tm-wide tm-role-help', text: roleSummary('attendant') }); role.addEventListener('change', function () { help.textContent = roleSummary(role.value); });
    var submit = h('button', { type: 'submit', text: 'Create invite link' });
    var form = h('form', { class: 'tm-form', novalidate: 'novalidate' }, [
      h('label', {}, [h('span', { text: 'Name' }), h('input', { name: 'name', maxlength: '80', placeholder: 'e.g. Mary', autocomplete: 'off' })]),
      h('label', {}, [h('span', { text: 'Role' }), role]),
      help,
      h('label', {}, [h('span', { text: 'Their phone (for WhatsApp)' }), h('input', { name: 'phone', inputmode: 'tel', placeholder: '07XX XXX XXX', autocomplete: 'off' })]),
      h('label', {}, [h('span', { text: 'Their email (optional)' }), h('input', { name: 'email', type: 'email', placeholder: 'name@example.com', autocomplete: 'off' })]),
      h('div', { class: 'tm-wide' }, [submit, error]),
    ]);
    var result = h('div', {}); if (lastLink) result.appendChild(linkCard(lastLink.result, lastLink.heading));
    form.addEventListener('submit', function (event) {
      event.preventDefault(); error.textContent = ''; busy(submit, true, 'Creating…');
      var body = Object.fromEntries(new FormData(form));
      api('/api/business/team/invites', { method: 'POST', body: JSON.stringify(body) }).then(function (made) {
        lastLink = { result: made, heading: 'Invite for ' + (made.invite.name || made.invite.roleLabel) + ' (' + made.invite.roleLabel + ')' };
        teamData = made.team; drawTeam();
      }).catch(function (err) { error.textContent = err.message; }).finally(function () { busy(submit, false); });
    });
    teamRoot.appendChild(h('div', { class: 'tm-card', id: 'team-invite' }, [h('h3', { text: 'Invite someone' }), h('p', { text: 'You get a one-time link to send on WhatsApp. It expires in ' + (teamData.inviteDays || 7) + ' days. They choose their own password.' }), form, result]));

    // Members
    var people = h('div', {});
    people.appendChild(h('div', { class: 'tm-row' }, [h('div', { class: 'tm-who' }, [h('strong', { text: (teamData.owner.name || 'You') + ' (you)' }), h('small', { text: teamData.owner.email })]), h('span', { class: 'tm-pill', text: 'Owner' })]));
    (teamData.members || []).forEach(function (person) {
      var rowError = h('div', { class: 'tm-error', 'aria-live': 'polite' });
      var select = h('select', { 'aria-label': 'Role for ' + person.name }); roleOptions(select, person.role);
      select.addEventListener('change', function () {
        if (!window.confirm('Change ' + person.name + ' to ' + select.options[select.selectedIndex].text + '? They will be signed out and sign in again.')) { select.value = person.role; return; }
        select.disabled = true;
        api('/api/business/team/members/' + encodeURIComponent(person.id), { method: 'PATCH', body: JSON.stringify({ role: select.value }) }).then(function (out) { teamData = out.team; drawTeam(); })
          .catch(function (err) { rowError.textContent = err.message; select.value = person.role; select.disabled = false; });
      });
      var reset = h('button', { type: 'button', class: 'secondary', text: 'Reset password', onclick: function () {
        busy(reset, true, 'Making link…');
        api('/api/business/team/members/' + encodeURIComponent(person.id) + '/reset', { method: 'POST', body: '{}' }).then(function (out) {
          lastLink = { result: out, heading: 'New password link for ' + person.name }; teamData = out.team; drawTeam();
          var card = $('team-invite'); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }).catch(function (err) { rowError.textContent = err.message; busy(reset, false); });
      } });
      var remove = h('button', { type: 'button', class: 'danger', text: 'Remove', onclick: function () {
        if (!window.confirm('Remove ' + person.name + ' from your team? They are signed out now and can no longer sign in.')) return;
        busy(remove, true, 'Removing…');
        api('/api/business/team/members/' + encodeURIComponent(person.id), { method: 'DELETE' }).then(function (out) { teamData = out.team; drawTeam(); })
          .catch(function (err) { rowError.textContent = err.message; busy(remove, false); });
      } });
      var login = [person.email, phoneText(person.phone)].filter(Boolean).join(' · ');
      people.appendChild(h('div', { class: 'tm-row' }, [h('div', { class: 'tm-who' }, [h('strong', { text: person.name }), h('small', { text: 'Signs in with ' + login + ' · joined ' + when(person.createdAt) }), rowError]), h('div', { class: 'tm-actions' }, [select, reset, remove])]));
    });
    if (!(teamData.members || []).length) people.appendChild(h('p', { class: 'tm-empty', text: 'No staff yet. Invite someone above.' }));
    teamRoot.appendChild(h('div', { class: 'tm-card', id: 'team-members' }, [h('h3', { text: 'People' }), people]));

    // Pending invites
    var pending = h('div', {});
    (teamData.invites || []).forEach(function (invite) {
      var rowError = h('div', { class: 'tm-error', 'aria-live': 'polite' });
      var relink = h('button', { type: 'button', class: 'secondary', text: 'New link', title: 'Makes a new link; the old one stops working', onclick: function () {
        busy(relink, true, 'Making link…');
        api('/api/business/team/invites/' + encodeURIComponent(invite.id) + '/link', { method: 'POST', body: '{}' }).then(function (out) {
          lastLink = { result: out, heading: 'New link for ' + (invite.name || invite.roleLabel) }; teamData = out.team; drawTeam();
          var card = $('team-invite'); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }).catch(function (err) { rowError.textContent = err.message; busy(relink, false); });
      } });
      var cancel = h('button', { type: 'button', class: 'danger', text: 'Cancel invite', onclick: function () {
        busy(cancel, true, 'Cancelling…');
        api('/api/business/team/invites/' + encodeURIComponent(invite.id), { method: 'DELETE' }).then(function (out) { lastLink = null; teamData = out.team; drawTeam(); })
          .catch(function (err) { rowError.textContent = err.message; busy(cancel, false); });
      } });
      var who = (invite.name || 'Someone') + (invite.kind === 'reset' ? ' · password reset' : ' · ' + invite.roleLabel);
      pending.appendChild(h('div', { class: 'tm-row' }, [h('div', { class: 'tm-who' }, [h('strong', { text: who }), h('small', { text: 'Not used yet · expires ' + when(invite.expiresAt) }), rowError]), h('div', { class: 'tm-actions' }, [relink, cancel])]));
    });
    if (!(teamData.invites || []).length) pending.appendChild(h('p', { class: 'tm-empty', text: 'No invites waiting.' }));
    teamRoot.appendChild(h('div', { class: 'tm-card', id: 'team-invites' }, [h('h3', { text: 'Waiting invites' }), pending]));

    // Roles
    teamRoot.appendChild(h('div', { class: 'tm-card' }, [h('h3', { text: 'What each role can do' }), h('ul', { class: 'tm-roles' }, (teamData.roles || []).map(function (item) { return h('li', {}, [h('strong', { text: item.label + ': ' }), item.summary]); })),
      h('p', { class: 'tm-note', text: 'Forgot their password? Use Reset password: it makes a one-time link like an invite.' })]));

    // Activity
    var rows = teamData.activity || []; var showing = 20;
    var log = h('ul', { class: 'tm-log' }); var more = h('button', { type: 'button', class: 'secondary', text: 'Show more' });
    function paint() {
      log.replaceChildren();
      rows.slice(0, showing).forEach(function (row) { log.appendChild(h('li', {}, [h('strong', { text: (row.actor_name || 'Someone') + ' (' + row.roleLabel + ')' }), ' ' + row.action.charAt(0).toLowerCase() + row.action.slice(1), h('small', { text: [row.target, when(row.created_at)].filter(Boolean).join(' · ') })])); });
      if (!rows.length) log.appendChild(h('li', { class: 'tm-empty', text: 'Nothing yet. Changes to money, packages, vouchers, routers and the team show here.' }));
      more.classList.toggle('hidden', rows.length <= showing);
    }
    more.addEventListener('click', function () { showing += 30; paint(); }); paint();
    teamRoot.appendChild(h('div', { class: 'tm-card', id: 'team-activity' }, [h('h3', { text: 'Recent activity' }), h('p', { text: 'Who did what, newest first.' }), log, more]));
  }

  /* ---- Join page: business.html#invite=<token> ---------------------- */
  function joinFromLink() {
    var match = /(?:^|[#&])invite=([^&]+)/.exec(window.location.hash || ''); if (!match) return;
    var token = ''; try { token = decodeURIComponent(match[1]); } catch (_) { token = match[1]; }
    // Keep the one-time token out of the address bar and history.
    try { window.history.replaceState(null, '', window.location.pathname); } catch (_) {}
    var card = h('div', { class: 'tm-card' }, [h('div', { class: 'tm-brand', text: 'Wi-Fi Fiti' }), h('p', { text: 'Checking your invite…' })]);
    var overlay = h('div', { class: 'tm-join', id: 'team-join', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Join the team' }, [card]);
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    api('/api/business/invite/check', { method: 'POST', body: JSON.stringify({ token: token }) }).then(function (invite) {
      var reset = invite.kind === 'reset';
      var error = h('div', { class: 'tm-error', 'aria-live': 'polite' });
      var submit = h('button', { type: 'submit', text: reset ? 'Save new password' : 'Join the team' });
      var fields = reset ? [] : [
        h('label', {}, [h('span', { text: 'Your name' }), h('input', { name: 'name', required: 'required', maxlength: '80', value: invite.name || '', autocomplete: 'name' })]),
        h('label', {}, [h('span', { text: 'Phone (to sign in)' }), h('input', { name: 'phone', inputmode: 'tel', value: invite.phone ? phoneText(invite.phone) : '', placeholder: '07XX XXX XXX', autocomplete: 'tel' })]),
        h('label', {}, [h('span', { text: 'Email (optional if you give a phone)' }), h('input', { name: 'email', type: 'email', value: invite.email || '', placeholder: 'name@example.com', autocomplete: 'email' })]),
      ];
      fields.push(h('label', {}, [h('span', { text: reset ? 'New password' : 'Choose a password' }), h('input', { name: 'password', type: 'password', required: 'required', minlength: '8', placeholder: 'At least 8 characters', autocomplete: 'new-password' })]));
      var form = h('form', { novalidate: 'novalidate' }, fields.concat([submit, error]));
      form.addEventListener('submit', function (event) {
        event.preventDefault(); error.textContent = ''; busy(submit, true, reset ? 'Saving…' : 'Joining…');
        var body = Object.fromEntries(new FormData(form)); body.token = token;
        api('/api/business/invite/accept', { method: 'POST', body: JSON.stringify(body) }).then(function (result) {
          try { localStorage.setItem('fiti_business_token', result.token); } catch (_) {}
          remember(result.member);
          window.location.reload();
        }).catch(function (err) { error.textContent = err.message; busy(submit, false); });
      });
      card.replaceChildren(h('div', { class: 'tm-brand', text: 'Wi-Fi Fiti' }),
        h('h2', { text: reset ? 'Set a new password' : 'Join ' + invite.businessName }),
        h('p', { text: reset ? 'For ' + (invite.name || 'your account') + ' at ' + invite.businessName + '.' : 'You are invited as ' + invite.roleLabel + '. ' + invite.roleSummary }),
        form, h('button', { type: 'button', class: 'quiet', text: 'Not now', onclick: close }));
    }).catch(function (err) {
      card.replaceChildren(h('div', { class: 'tm-brand', text: 'Wi-Fi Fiti' }), h('h2', { text: 'This link can’t be used' }), h('p', { text: err.message }), h('button', { type: 'button', class: 'secondary', text: 'Go to sign in', onclick: close }));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', joinFromLink); else joinFromLink();

  window.FitiTeam = { refresh: function () { var who = current(); if (who && who.role === 'owner' && $('team-section')) mountTeamPage(); }, apply: apply, can: can, pageAllowed: pageAllowed, remember: remember, forget: function () { remember(null); gate.textContent = ''; mounted = false; } };
})();

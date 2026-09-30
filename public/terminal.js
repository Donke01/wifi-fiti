/* Wi-Fi Fiti router terminal: arbitrary RouterOS commands over the WireGuard
 * management tunnel. Owner-only; every session is audit-logged server-side.
 *
 * This module is deliberately self-contained: it reads the business session
 * token from localStorage and talks to the terminal API directly.
 */
(function () {
  'use strict';

  var XTERM_JS = 'https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.js';
  var XTERM_CSS = 'https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.css';
  var FIT_ADDON_JS = 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js';

  function token() {
    try { return localStorage.getItem('fiti_business_token'); } catch (_) { return null; }
  }

  function api(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    options.headers = headers;
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          var error = new Error(body.error || 'Something went wrong. Please try again.');
          error.status = response.status;
          throw error;
        }
        return body;
      });
    });
  }

  /* Client-side mirror of the server blocklist (instant feedback; the
   * server enforces it independently on every completed line). */
  var BLOCKED_VERBS = { reboot: 1, shutdown: 1, 'reset-configuration': 1, remove: 1, disable: 1, restore: 1 };
  function blockedLabel(line) {
    var clean = String(line || '').replace(/^\s+|\s+$/g, '');
    if (!clean) return null;
    var unquoted = clean.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
    var words = unquoted.replace(/^\/+/, '').split(/[\s\/]+/)
      .map(function (w) { return w.toLowerCase(); }).filter(Boolean);
    for (var i = 0; i < words.length; i++) {
      if (BLOCKED_VERBS[words[i]]) return words[i];
      if (words[i] === 'backup' && words[i + 1] === 'load') return 'backup load';
    }
    return null;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-rt="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src; s.async = true; s.setAttribute('data-rt', src);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load the terminal library. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }

  function loadCss(href) {
    if (document.querySelector('link[data-rt="' + href + '"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-rt', href);
    document.head.appendChild(l);
  }

  var xtermReady = null;
  function ensureXterm() {
    if (xtermReady) return xtermReady;
    xtermReady = Promise.resolve()
      .then(function () { loadCss(XTERM_CSS); injectStyles(); })
      .then(function () { return loadScript(XTERM_JS); })
      .then(function () { return loadScript(FIT_ADDON_JS); })
      .then(function () {
        if (!window.Terminal) throw new Error('The terminal library did not initialise.');
      });
    return xtermReady;
  }

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var css = [
      '.rt-overlay{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:18px;background:rgba(8,24,45,.5);backdrop-filter:blur(8px);}',
      '.rt-card{width:min(880px,100%);max-height:92vh;display:flex;flex-direction:column;background:#0e1b30;border:1px solid rgba(255,255,255,.08);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden;color:#d7e3f4;}',
      '.rt-header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07);}',
      '.rt-title{font-size:17px;font-weight:700;letter-spacing:-.01em;}',
      '.rt-subtitle{font-size:12.5px;opacity:.65;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.rt-close{background:none;border:0;color:#d7e3f4;font-size:22px;line-height:1;cursor:pointer;opacity:.7;padding:4px 8px;}',
      '.rt-close:hover{opacity:1;}',
      '.rt-body{padding:18px;overflow:auto;}',
      '.rt-pane{display:flex;flex-direction:column;gap:12px;}',
      '.rt-note{font-size:13.5px;line-height:1.55;background:rgba(255,193,7,.08);border:1px solid rgba(255,193,7,.25);border-radius:8px;padding:10px 12px;margin:0;}',
      '.rt-hint{font-size:12px;opacity:.6;margin:6px 0 0;}',
      '.rt-error{font-size:13.5px;color:#ffb4a8;background:rgba(255,80,80,.08);border:1px solid rgba(255,80,80,.3);border-radius:8px;padding:10px 12px;}',
      '.rt-form{display:flex;flex-direction:column;gap:14px;}',
      '.rt-field label{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;opacity:.85;}',
      '.rt-radio{display:flex!important;align-items:flex-start;gap:8px;font-weight:400!important;font-size:13.5px;margin-bottom:8px;cursor:pointer;}',
      '.rt-radio input{margin-top:3px;}',
      '.rt-input{width:100%;box-sizing:border-box;background:#0b1526;border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#d7e3f4;padding:10px 12px;font-size:14px;}',
      '.rt-input:focus{outline:none;border-color:#4da3ff;}',
      '.rt-btn{align-self:flex-start;background:#2f7fe0;border:0;border-radius:8px;color:#fff;font-size:14px;font-weight:600;padding:10px 22px;cursor:pointer;}',
      '.rt-btn:disabled{opacity:.55;cursor:default;}',
      '.rt-btn:hover:not(:disabled){background:#3b8ef0;}',
      '.rt-term{height:min(58vh,520px);border-radius:8px;overflow:hidden;background:#0b1526;}',
      '.rt-term .xterm{height:100%;padding:8px;}',
    ].join('\n');
    var style = document.createElement('style');
    style.setAttribute('data-rt', 'styles');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function wsUrl(path) {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + window.location.host + path;
  }

  function openTerminal(location) {
    var locationId = location && (location.id || location.locationId);
    if (!locationId) return;

    // Modal shell
    var overlay = el('div', 'rt-overlay');
    var card = el('div', 'rt-card');
    var header = el('div', 'rt-header');
    header.appendChild(el('div', 'rt-title', 'Router terminal'));
    header.appendChild(el('div', 'rt-subtitle', location.name || locationId));
    var closeBtn = el('button', 'rt-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close terminal');
    header.appendChild(closeBtn);
    card.appendChild(header);
    var body = el('div', 'rt-body');
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    var state = { ws: null, term: null, fit: null, done: false };

    function setBody(node) { body.replaceChildren(node); }

    function showError(message) {
      var wrap = el('div', 'rt-pane');
      wrap.appendChild(el('div', 'rt-error', message));
      var retry = el('button', 'rt-btn', 'Close');
      retry.type = 'button';
      retry.addEventListener('click', destroy);
      wrap.appendChild(retry);
      setBody(wrap);
    }

    function destroy() {
      state.done = true;
      try { if (state.ws) state.ws.close(); } catch (_) {}
      try { if (state.term) state.term.dispose(); } catch (_) {}
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      for (var i = 0; i < closeListeners.length; i++) { try { closeListeners[i](); } catch (_) {} }
    }
    closeBtn.addEventListener('click', destroy);
    overlay.addEventListener('mousedown', function (event) { if (event.target === overlay) destroy(); });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape' && !state.done) { destroy(); document.removeEventListener('keydown', onKey); }
    });

    setBody(el('div', 'rt-pane', 'Checking the secure connection…'));

    api('/api/business/locations/' + encodeURIComponent(locationId) + '/terminal/status')
      .then(function (status) {
        if (!status.eligible) throw new Error(status.reason || 'The router terminal is not available for this router.');
        renderLogin(status);
      })
      .catch(function (error) { showError(error.message); });

    function renderLogin(status) {
      var pane = el('div', 'rt-pane');
      pane.appendChild(el('p', 'rt-note', 'You are opening a live command shell on this router. Every command you run is logged. Destructive commands (reboot, reset, remove, disable, backup restore) are blocked.'));
      var transports = status.transports || {};
      var form = el('div', 'rt-form');

      var transportWrap = el('div', 'rt-field');
      transportWrap.appendChild(el('label', '', 'Connection'));
      var direct = transports.direct || {};
      var gateway = transports.gateway || {};
      var options = [];
      if (direct.available) options.push(['direct', 'Direct — SSH terminates in the Wi-Fi Fiti app (recommended)']);
      if (gateway.available) options.push(['gateway', 'Gateway proxy — SSH terminates on the support gateway']);
      if (!options.length) {
        var reason = (direct.reason || gateway.reason || 'The gateway agent is not connected.');
        showError('No terminal transport is available right now. ' + reason);
        return;
      }
      options.forEach(function (opt, index) {
        var label = el('label', 'rt-radio');
        var input = el('input'); input.type = 'radio'; input.name = 'rt-transport'; input.value = opt[0];
        if (index === 0) input.checked = true;
        label.appendChild(input);
        label.appendChild(el('span', '', opt[1]));
        transportWrap.appendChild(label);
      });
      if (!gateway.available && gateway.reason) {
        transportWrap.appendChild(el('p', 'rt-hint', 'Gateway proxy unavailable: ' + gateway.reason));
      }
      form.appendChild(transportWrap);

      var userWrap = el('div', 'rt-field');
      userWrap.appendChild(el('label', '', 'Router username'));
      var userInput = el('input', 'rt-input'); userInput.value = 'admin'; userInput.autocomplete = 'off';
      userWrap.appendChild(userInput);
      form.appendChild(userWrap);

      var passWrap = el('div', 'rt-field');
      passWrap.appendChild(el('label', '', 'Router password'));
      var passInput = el('input', 'rt-input'); passInput.type = 'password'; passInput.autocomplete = 'off';
      passWrap.appendChild(passInput);
      passWrap.appendChild(el('p', 'rt-hint', 'Your password is used once to log in and is never stored.'));
      form.appendChild(passWrap);

      var connectBtn = el('button', 'rt-btn', 'Connect');
      connectBtn.type = 'button';
      var errLine = el('div', 'rt-error');
      errLine.style.display = 'none';
      form.appendChild(errLine);
      form.appendChild(connectBtn);
      pane.appendChild(form);
      setBody(pane);
      setTimeout(function () { passInput.focus(); }, 50);

      connectBtn.addEventListener('click', function () {
        var chosen = pane.querySelector('input[name="rt-transport"]:checked');
        var transport = chosen ? chosen.value : 'direct';
        var username = userInput.value.trim() || 'admin';
        var password = passInput.value;
        passInput.value = '';
        if (!password) { errLine.textContent = 'Enter the router password.'; errLine.style.display = ''; return; }
        errLine.style.display = 'none';
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting…';
        startSession(status, transport, username, password).catch(function (error) {
          connectBtn.disabled = false;
          connectBtn.textContent = 'Connect';
          errLine.textContent = error.message;
          errLine.style.display = '';
        });
      });
      passInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') connectBtn.click(); });
    }

    function startSession(status, transport, username, password) {
      return api('/api/business/locations/' + encodeURIComponent(locationId) + '/terminal', {
        method: 'POST',
        body: JSON.stringify({ transport: transport }),
      }).then(function (result) {
        if (!result.ticket) throw new Error('The server did not issue a terminal ticket.');
        return ensureXterm().then(function () { openSocket(result.ticket, username, password); });
      });
    }

    function openSocket(ticket, username, password) {
      setBody(el('div', 'rt-pane', 'Opening the secure shell…'));
      var termNode = el('div', 'rt-term');
      var pane = el('div', 'rt-pane');
      pane.appendChild(termNode);
      setBody(pane);

      var term = new window.Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        theme: { background: '#0b1526', foreground: '#d7e3f4' },
      });
      var fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(termNode);
      fit.fit();
      state.term = term;
      state.fit = fit;

      var ws = new WebSocket(wsUrl('/api/business/terminal-socket?ticket=' + encodeURIComponent(ticket)));
      state.ws = ws;
      var opened = false;

      function writeLine(text) { term.writeln(text.replace(/\n/g, '\r\n')); }

      ws.onopen = function () {
        ws.send(JSON.stringify({ type: 'start', username: username, password: password, cols: term.cols, rows: term.rows }));
        password = '';
      };
      ws.onmessage = function (event) {
        var msg = null;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === 'ready') {
          opened = true;
          term.focus();
        } else if (msg.type === 'data' && typeof msg.chunk === 'string') {
          term.write(msg.chunk);
        } else if (msg.type === 'blocked') {
          writeLine('\x1b[31m' + (msg.message || 'That command is blocked.') + '\x1b[0m');
        } else if (msg.type === 'closed') {
          writeLine('\r\n\x1b[33mSession closed: ' + (msg.reason || 'closed') + '\x1b[0m');
          term.blur();
        } else if (msg.type === 'error') {
          showError(msg.message || 'The terminal session failed.');
        }
      };
      ws.onclose = function () {
        if (!opened && !state.done) showError('The connection closed before the shell opened. The gateway agent may be offline.');
        else if (!state.done) writeLine('\r\n\x1b[33mDisconnected.\x1b[0m');
      };
      ws.onerror = function () { if (!opened && !state.done) showError('Could not reach the terminal service.'); };

      // Client-side pre-check mirrors the server blocklist for instant
      // feedback; the server still enforces it on every completed line.
      var lineBuffer = '';
      term.onData(function (data) {
        if (state.done || ws.readyState !== 1) return;
        lineBuffer += data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var idx = lineBuffer.indexOf('\n');
        if (idx !== -1) {
          var label = blockedLabel(lineBuffer.slice(0, idx));
          lineBuffer = lineBuffer.slice(idx + 1);
          if (label) {
            writeLine('\x1b[31mBlocked before sending: "' + label + '" is not allowed in the router terminal.\x1b[0m');
            return; // do not forward the line at all
          }
        }
        if (lineBuffer.length > 4096) lineBuffer = lineBuffer.slice(-4096);
        ws.send(JSON.stringify({ type: 'data', chunk: data }));
      });

      var resizeTimer = null;
      window.addEventListener('resize', function () {
        if (state.done) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          try { fit.fit(); } catch (_) {}
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }, 200);
      });
    }
  }

  var closeListeners = [];
  window.RouterTerminal = { open: openTerminal, blockedLabel: blockedLabel, onClose: function (fn) { if (typeof fn === 'function') closeListeners.push(fn); } };
})();

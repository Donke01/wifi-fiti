/*
 * Wi-Fi Fiti motion: applies the routerboard motion language (see
 * fiti-motion.css) to each page's symbolic parts. It only adds classes and
 * decorative, aria-hidden elements; it never changes text a page relies on,
 * except to count KPI numbers up once, and it stops if the page rewrites the
 * number itself. Dashboards re-render, so new parts are picked up as they
 * appear, and a card that re-renders with the same content does not replay
 * its entrance.
 */
(function () {
  'use strict';
  if (window.FitiMotion || typeof document === 'undefined' || !document.documentElement) return;
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

  // What counts as a symbol on each page, and what it becomes.
  var RULES = [
    // Status lights
    { sel: '.status, .pill, .live-pill, .delivery', add: led },
    // Symbols as board parts
    { sel: '.nav .symbol', add: chip },
    { sel: '.demo-icon, .strip-icon, .contact-icon, .icon, .next-icon', add: chip },
    // Logos and devices float
    { sel: '.sidebar .brand .mark, .brand-mark, .topbar .mark, header .mark, .brand img', add: floaty(7) },
    // Phone mock-ups people type into only bob gently.
    { sel: '.phone, .mini-phone', add: function (el) { el.classList.add('fm-bob'); el.style.setProperty('--fm-delay', (-Math.random() * 3).toFixed(2) + 's'); } },
    // KPI tiles: glass, a live light, and numbers that count up
    { sel: '.metric, .overview-kpi, .kpi, .router-status', add: kpi },
    // Cards and panels rise in
    { sel: '.panel, .card, .location-card, .package-card, .breakdown-card, .payment-card, .overview-chart, .overview-recent, .step, .router-map, .svc-state', add: reveal },
    // Charts grow
    { sel: '.overview-bar, .telemetry-bars > *, .bar', add: bar },
    // Setup checklist
    { sel: '.gs-dot', add: check },
    { sel: '.gs-now', add: function (el) { el.classList.add('fm-now'); } },
    // Hero art
    { sel: '.hero', add: tunnel },
  ];

  var seen = new Set();          // entrance already played for this content
  var counter = new WeakMap();   // per-parent index for staggering
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(onVisible, { rootMargin: '0px 0px -8% 0px' }) : null;

  function indexIn(el) {
    var parent = el.parentNode || document.body; var n = counter.get(parent) || 0; counter.set(parent, n + 1);
    el.style.setProperty('--fm-i', String(Math.min(n, 12)));
  }
  function signature(el) { return (el.className && el.className.baseVal === undefined ? el.className : '') + '|' + (el.textContent || '').trim().slice(0, 60); }

  function led(el) {
    // A pill is only a status light when it reads like one (not a link, a
    // button or a live badge that already has its own dot).
    if (el.matches('a, button, .live-pill, a *, button *')) return;
    if (el.classList.contains('pill') && !/^(paid|unpaid|online|offline|active|inactive|pending|failed|expired|live|idle|ok|error)$/i.test((el.textContent || '').trim())) return;
    var text = ((el.className && typeof el.className === 'string' ? el.className : '') + ' ' + (el.textContent || '')).toLowerCase();
    var state = /\b(fail|failed|bad|expired|paused|offline|stale|disabled|server_off|error)\b/.test(text) ? 'fm-bad'
      : /\b(wait|waiting|pending|unknown|warn|retry|retrying|idle|queued)\b/.test(text) ? 'fm-warn' : 'fm-good';
    el.classList.add('fm-led', state);
    var before = '';
    try { before = getComputedStyle(el, '::before').content; } catch (_) {}
    if ((!before || before === 'none' || before === 'normal') && !el.querySelector('.fm-dot')) {
      var dot = document.createElement('i'); dot.className = 'fm-dot'; dot.setAttribute('aria-hidden', 'true'); el.insertBefore(dot, el.firstChild);
    }
  }
  // Each symbol moves the way it reads: the gear turns, the arrow rises...
  var GLYPHS = { '⚙': 'spin', '↗': 'rise', '✉': 'bob', '✦': 'twinkle', '◎': 'ring', '◌': 'ring', '○': 'ring', '¤': 'coin', 'KSh': 'coin', '↔': 'swap', '⌂': 'bob', '⌘': 'twinkle', '◇': 'coin', '#': 'rise', '?': 'bob' };
  function chip(el) {
    el.classList.add('fm-chip'); indexIn(el);
    var text = (el.textContent || '').trim();
    if (GLYPHS[text] && el.childNodes.length === 1 && el.firstChild.nodeType === 3) {
      var glyph = document.createElement('span'); glyph.className = 'fm-glyph fm-g-' + GLYPHS[text]; glyph.textContent = el.textContent; el.textContent = ''; el.appendChild(glyph);
    }
    var host = el.closest && el.closest('button, a');
    var lit = function () { el.classList.toggle('fm-lit', Boolean(host && (host.classList.contains('active') || host.getAttribute('aria-current') === 'page' || host.getAttribute('aria-pressed') === 'true'))); };
    lit();
    if (host && 'MutationObserver' in window) new MutationObserver(lit).observe(host, { attributes: true, attributeFilter: ['class', 'aria-current', 'aria-pressed'] });
  }
  function floaty(seconds) {
    return function (el) { el.classList.add('fm-float'); el.style.setProperty('--fm-dur', seconds + 's'); el.style.setProperty('--fm-delay', (-Math.random() * seconds).toFixed(2) + 's'); };
  }
  function glass(el) {
    if (el.querySelector(':scope > .fm-sheen')) return;
    el.classList.add('fm-glass');
    var sheen = document.createElement('span'); sheen.className = 'fm-sheen'; sheen.setAttribute('aria-hidden', 'true');
    el.insertBefore(sheen, el.firstChild);
    el.style.setProperty('--fm-delay', (1 + Math.random() * 6).toFixed(2) + 's');
  }
  function kpi(el) {
    el.classList.add('fm-kpi'); glass(el); reveal(el);
    if (!el.querySelector(':scope > .fm-kpi-led') && !el.classList.contains('router-status')) {
      var light = document.createElement('i'); light.className = 'fm-kpi-led'; light.setAttribute('aria-hidden', 'true'); el.appendChild(light);
    }
    var value = el.querySelector('.metric-value, .overview-kpi-value, strong');
    if (value) countUp(value);
  }
  function reveal(el) {
    if (el.classList.contains('fm-reveal') || el.classList.contains('fm-in')) return;
    var key = signature(el);
    if (seen.has(key) || !io || reduced) { el.classList.add('fm-in'); return; }
    indexIn(el); el.classList.add('fm-reveal'); io.observe(el);
  }
  function onVisible(entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target; io.unobserve(el); seen.add(signature(el));
      requestAnimationFrame(function () { el.classList.add('fm-in'); });
    });
  }
  function bar(el) { if (typeof SVGElement !== 'undefined' && el instanceof SVGElement) return; el.classList.add(el.offsetWidth > el.offsetHeight * 3 ? 'fm-hbar' : 'fm-bar'); indexIn(el); }
  function check(el) { el.classList.add('fm-check'); indexIn(el); }

  // Count a KPI number up from zero, once, keeping its prefix and suffix.
  function countUp(el) {
    if (reduced || el.dataset.fmCounted) return;
    var start = function () {
      var text = (el.textContent || '').trim();
      var match = text.match(/^([^\d-]*?)(-?\d[\d,]*(?:\.\d+)?)(\s*[%A-Za-z]*)$/);
      if (!match) return false;
      var target = Number(match[2].replace(/,/g, '')); if (!isFinite(target) || target === 0) return false;
      var decimals = (match[2].split('.')[1] || '').length; var grouped = match[2].indexOf(',') >= 0 || target >= 1000;
      el.dataset.fmCounted = '1';
      var began = performance.now(); var last = text; var duration = 900;
      var format = function (n) { return match[1] + (grouped ? n.toLocaleString('en-KE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : n.toFixed(decimals)) + match[3]; };
      (function frame(now) {
        if ((el.textContent || '').trim() !== last) return; // the page updated it: stop
        var t = Math.min(1, (now - began) / duration); var eased = 1 - Math.pow(1 - t, 3);
        last = t < 1 ? format(target * eased) : text; el.textContent = last;
        if (t < 1) requestAnimationFrame(frame);
      })(began);
      return true;
    };
    if (start()) return;
    // Numbers often arrive after the first render; count up when they do.
    if ('MutationObserver' in window) {
      var watcher = new MutationObserver(function () { if (start()) watcher.disconnect(); });
      watcher.observe(el, { childList: true, characterData: true, subtree: true });
      setTimeout(function () { watcher.disconnect(); }, 15000);
    }
  }

  // PPPoE hero: a router and a home linked by an encrypted pipe.
  function tunnel(el) {
    if (!/pppoe/i.test(document.title + ' ' + location.pathname) || el.querySelector('.fm-tunnel')) return;
    var art = document.createElement('div'); art.className = 'fm-tunnel'; art.setAttribute('aria-hidden', 'true');
    art.innerHTML = '<span class="fm-node a"><i></i><i></i><i></i></span><span class="fm-pipe"><b></b><b></b><b class="up"></b></span><span class="fm-lock"></span><span class="fm-node b"></span><small class="a">Router</small><small class="b">Home</small>';
    el.classList.add('fm-tunnel-host'); el.appendChild(art);
  }

  function apply(root) {
    RULES.forEach(function (rule) {
      var nodes = [];
      if (root.matches && root.matches(rule.sel)) nodes.push(root);
      if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll(rule.sel)));
      nodes.forEach(function (el) {
        var mark = 'fm' + RULES.indexOf(rule);
        if (el.dataset && el.dataset[mark]) return;
        if (el.closest && el.closest('[data-fm-skip]')) return;
        if (el.dataset) el.dataset[mark] = '1';
        try { rule.add(el); } catch (_) { /* decoration only */ }
      });
    });
  }

  var pending = new Set(); var scheduled = false;
  function flush() { scheduled = false; pending.forEach(function (node) { if (node.isConnected) apply(node); }); pending.clear(); }
  function start() {
    document.documentElement.classList.add('fm-on');
    apply(document.body);
    if ('MutationObserver' in window) {
      new MutationObserver(function (mutations) {
        mutations.forEach(function (m) { m.addedNodes.forEach(function (node) { if (node.nodeType === 1 && !(node.classList && (node.classList.contains('fm-sheen') || node.classList.contains('fm-dot') || node.classList.contains('fm-kpi-led')))) pending.add(node); }); });
        if (pending.size && !scheduled) { scheduled = true; requestAnimationFrame(flush); }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.FitiMotion = { apply: apply };
})();

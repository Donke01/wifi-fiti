/* Shrink the open page so all of it fits one screen, no scrolling (phone and desktop). */
(function () {
  var MIN = 0.5, ROWS = 6, mq = window.matchMedia('(max-width:620px)'), timer = null, busy = false;
  function minScale() { return mq.matches ? 0.5 : 0.6; }
  function rowCap() { return mq.matches ? 6 : 8; }
  function content() { return document.querySelector('#dashboard .content'); }
  function nav() { return document.querySelector('#dashboard .sidebar .nav'); }
  function limitLists(root) {
    var lists = root.querySelectorAll('.customer-results, #transactions-list');
    lists.forEach(function (list) {
      var items = Array.prototype.filter.call(list.children, function (c) { return c.classList.contains('payment-card'); });
      if (list.dataset.fpAll === '1' || items.length <= rowCap()) { items.forEach(function (c) { c.classList.remove('fp-extra'); }); var old = list.querySelector('.fp-more'); if (old && items.length <= rowCap()) old.remove(); return; }
      items.forEach(function (c, i) { c.classList.toggle('fp-extra', i >= rowCap()); });
      if (!list.querySelector('.fp-more')) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'secondary fp-more'; b.textContent = 'Show all ' + items.length;
        b.addEventListener('click', function () { list.dataset.fpAll = '1'; b.remove(); schedule(); });
        list.appendChild(b);
      }
    });
  }
  function fit() {
    var c = content(); if (!c) return;
        busy = true;
    try {
      limitLists(c);
      window.scrollTo(0, 0); c.style.zoom = '1';
      var n = nav(); var navH = mq.matches && n ? n.getBoundingClientRect().height : 8;
      var scale = 1;
      for (var i = 0; i < 3; i++) {
        var top = c.getBoundingClientRect().top + window.scrollY;
        var avail = window.innerHeight - top - navH - 6;
        var natural = c.scrollHeight * (parseFloat(c.style.zoom) || 1);
        // natural height at the current zoom, converted back to zoom 1 equivalent by re-measuring
        c.style.zoom = '1'; natural = c.scrollHeight;
        scale = Math.max(minScale(), Math.min(1, avail / natural));
        c.style.zoom = String(scale);
        if (scale >= 1) break;
      }
      var fits = c.scrollHeight * scale <= window.innerHeight - (c.getBoundingClientRect().top + window.scrollY) - navH + 4;
      document.body.classList.add('fp-fit'); document.body.classList.toggle('fp-fit-tight', !fits);
    } finally { busy = false; }
  }
  function schedule() { if (busy) return; clearTimeout(timer); timer = setTimeout(fit, 120); }
  function start() {
    var c = content(); if (!c) { setTimeout(start, 400); return; }
    new MutationObserver(schedule).observe(c, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-current'] });
    window.addEventListener('resize', schedule); window.addEventListener('orientationchange', schedule);
    document.addEventListener('click', schedule, true);
    if (mq.addEventListener) mq.addEventListener('change', schedule);
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

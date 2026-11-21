/* GeoSwiper — the theme switch, shared by every page. Progressive enhancement only.
   The theme follows the device until the visitor picks one. Picking the device's
   own setting again hands control back to the device. */
(function () {
  'use strict';
  var d = document, root = d.documentElement;
  var wantsDark = window.matchMedia('(prefers-color-scheme: dark)');
  var switches = d.querySelectorAll('[data-theme-toggle]');
  /* the browser-bar tint follows the theme, except where a page fixes it (the home page's night window) */
  var tints = d.querySelectorAll('meta[name="theme-color"]:not([data-fixed])');
  function each(list, fn) { [].forEach.call(list, fn); }
  function theme() {
    return root.getAttribute('data-theme') || (wantsDark.matches ? 'dark' : 'light');
  }
  function paint() {
    var dark = theme() === 'dark';
    var forced = root.hasAttribute('data-theme');
    each(switches, function (b) {
      b.hidden = false;
      b.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
      b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    });
    each(tints, function (m) {
      if (!m.hasAttribute('data-auto')) m.setAttribute('data-auto', m.getAttribute('content'));
      m.setAttribute('content', forced ? (dark ? '#131210' : '#faf8f2') : m.getAttribute('data-auto'));
    });
  }
  each(switches, function (b) {
    b.addEventListener('click', function () {
      var next = theme() === 'dark' ? 'light' : 'dark';
      var device = wantsDark.matches ? 'dark' : 'light';
      try {
        if (next === device) {
          root.removeAttribute('data-theme');
          localStorage.removeItem('gs-theme');
        } else {
          root.setAttribute('data-theme', next);
          localStorage.setItem('gs-theme', next);
        }
      } catch (e) {
        if (next === device) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', next);
      }
      paint();
    });
  });
  if (wantsDark.addEventListener) wantsDark.addEventListener('change', paint);
  paint();
})();

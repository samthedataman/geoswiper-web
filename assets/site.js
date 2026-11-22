/* GeoSwiper — shared by every page. Progressive enhancement only.

   The App Store link. While this is empty every App Store button and plaque reads "Coming soon"
   and goes to the app section of the home page. Set it to the app's App Store address once the
   app is live, and they all read "Download on the App Store" and go there. */
var APP_STORE_URL = '';

/* The theme switch. The theme follows the device until the visitor picks one. Picking the
   device's own setting again hands control back to the device. */
(function () {
  'use strict';
  var d = document, root = d.documentElement;
  var wantsDark = window.matchMedia('(prefers-color-scheme: dark)');
  var switches = d.querySelectorAll('[data-theme-toggle]');
  /* the browser-bar tint follows the theme where the page's top is the paper header; the home page's
     top is the night header in both themes, so its tint is marked data-fixed and left alone */
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

  /* the App Store buttons (see APP_STORE_URL above) */
  var store = /^https:\/\/apps\.apple\.com\//.test(APP_STORE_URL) ? APP_STORE_URL : '';
  if (store) each(d.querySelectorAll('[data-app-store]'), function (el) {
    var a = el, line;
    if (el.tagName !== 'A') { /* a plaque: its contents become one link */
      a = d.createElement('a');
      a.className = 'plaque-a';
      while (el.firstChild) a.appendChild(el.firstChild);
      el.appendChild(a);
    }
    a.href = store;
    a.setAttribute('data-live', ''); /* lets the narrowest phones drop the top line (see .store in site.css) */
    line = a.querySelector('[data-store-line]');
    if (line) line.textContent = 'Download on the';
  });
})();

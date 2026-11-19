/* GeoSwiper — progressive enhancement only.
   The page is complete without this file. With it: a theme switch, a compact
   menu, small scroll reveals, and a hero round that plays itself until the
   visitor taps an answer, at which point it becomes theirs to play. */
(function () {
  'use strict';
  var d = document;
  var root = d.documentElement;
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canWatch = 'IntersectionObserver' in window;
  function each(list, fn) { [].forEach.call(list, fn); }

  /* Theme: follows the device until the visitor picks one. Picking the
     device's own setting again hands control back to the device. */
  var wantsDark = window.matchMedia('(prefers-color-scheme: dark)');
  var switches = d.querySelectorAll('[data-theme-toggle]');
  var tints = d.querySelectorAll('meta[name="theme-color"]');
  function theme() {
    return root.getAttribute('data-theme') || (wantsDark.matches ? 'dark' : 'light');
  }
  function paintTheme() {
    var dark = theme() === 'dark';
    var forced = root.hasAttribute('data-theme');
    each(switches, function (b) {
      b.hidden = false;
      b.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
      var label = b.querySelector('[data-theme-label]');
      if (label) label.textContent = dark ? 'Light theme' : 'Dark theme';
      else b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
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
        root.setAttribute('data-theme', next);
      }
      paintTheme();
    });
  });
  if (wantsDark.addEventListener) wantsDark.addEventListener('change', paintTheme);
  paintTheme();

  /* Compact menu: close after picking a link, pressing Escape or tapping away. */
  var more = d.querySelector('.nav-more');
  if (more) {
    more.addEventListener('click', function (e) {
      if (e.target.closest('a')) more.removeAttribute('open');
    });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && more.hasAttribute('open')) {
        more.removeAttribute('open');
        more.querySelector('summary').focus();
      }
    });
    d.addEventListener('click', function (e) {
      if (more.hasAttribute('open') && !more.contains(e.target)) more.removeAttribute('open');
    });
  }

  if (!still && canWatch) {
    /* Reveal: items below the fold rise a little as they arrive. Never hidden. */
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        seen.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    var vh = window.innerHeight;
    each(d.querySelectorAll('[data-rv]'), function (el) {
      if (el.getBoundingClientRect().top < vh) return;
      var sibs = el.parentNode.querySelectorAll(':scope > [data-rv]');
      el.style.setProperty('--i', [].indexOf.call(sibs, el) % 5);
      el.classList.add('rv');
      seen.observe(el);
    });

    /* How it works: each step's drawing plays once, the first time it is properly on screen. */
    var played = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-live');
        played.unobserve(en.target);
      });
    }, { threshold: 0.4 });
    each(d.querySelectorAll('[data-live] .step'), function (el) { played.observe(el); });
  }

  /* ── The hero round ──────────────────────────────────────────────────────
     Three first rounds, one per deck. Left alone it plays itself and ends on
     two real screens from the app. Tap an answer and the round is yours: the
     clock runs in real seconds and the next round waits for you.
     With reduced motion nothing plays by itself, but the answers still work. */
  var gs = d.querySelector('[data-demo]');
  if (!gs) return;

  var rounds = [
    { a: ['PT', 'Lisbon'], b: ['PE', 'Lima'], right: 'a', from: 30 },
    { a: ['OH', 'Ohio'], b: ['NM', 'New Mexico'], right: 'b', from: 17 },
    { a: ['JP', 'Japan'], b: ['BR', 'Brazil'], right: 'a', from: 5 }
  ];
  var card = gs.querySelector('.gs-card');
  var scenes = gs.querySelectorAll('.gs-scene');
  var clock = gs.querySelector('[data-time]');
  var bar = gs.querySelector('.gs-track i');
  var answers = { a: gs.querySelector('[data-ans="a"]'), b: gs.querySelector('[data-ans="b"]') };
  var tray = gs.querySelector('.gs-answers');
  var shots = { intro: gs.querySelector('[data-shot="intro"]'), result: gs.querySelector('[data-shot="result"]') };
  var seg = d.querySelector('[data-seg]');
  var segBtns = seg ? seg.querySelectorAll('button') : [];
  var pauseBtn = d.querySelector('[data-pause]');
  var tryNote = d.querySelector('[data-try]');
  var live = d.querySelector('[data-say]');

  var mode = still ? 'idle' : 'auto';  /* auto: plays itself · play: the visitor's · idle: waits (reduced motion) */
  var cur = 0;                         /* round on screen */
  var open = false;                    /* the round is waiting for an answer */
  var secs = 30;
  var at = 0, timer = 0, tick = 0, swap = 0, settle = 0, rew = 0;
  var userPaused = false, onScreen = true;

  function say(text) { if (live) live.textContent = text; }
  function mark(n) {
    each(segBtns, function (b, i) {
      b.classList.toggle('is-on', i === n);
      b.setAttribute('aria-pressed', String(i === n));
    });
  }
  function shot(name) {
    if (name) return shots[name].classList.add('is-on');
    Object.keys(shots).forEach(function (k) { shots[k].classList.remove('is-on'); });
  }
  function time(s) {
    secs = s;
    clock.textContent = s;
    card.style.setProperty('--p', Math.round(s / 30 * 100));
    gs.classList.toggle('is-hot', s <= 5);
  }
  function setOpen(yes) {
    open = yes;
    gs.classList.toggle('is-open', yes);
    ['a', 'b'].forEach(function (k) { answers[k].setAttribute('aria-disabled', String(!yes)); });
  }
  function label(r) {
    ['a', 'b'].forEach(function (k) {
      answers[k].classList.remove('is-picked', 'is-dim', 'is-wrong');
      answers[k].querySelector('[data-code]').textContent = r[k][0];
      answers[k].querySelector('[data-label]').textContent = r[k][1];
    });
    gs.setAttribute('data-pick', r.right);
    tray.classList.remove('is-swap');
    setOpen(true);
  }
  function deal(n) {
    var r = rounds[n];
    clearTimeout(rew);
    shot(null);
    setOpen(false);
    gs.classList.remove('is-reaching', 'is-pressed', 'is-done');
    clearTimeout(swap);
    if (n === cur) {
      label(r);
    } else {
      /* the old scene stays put while the new one drops over it */
      var old = scenes[cur];
      each(scenes, function (s, i) {
        s.classList.remove('was-on', 'is-on');
        s.setAttribute('aria-hidden', String(i !== n));
      });
      old.classList.add('was-on');
      scenes[n].classList.add('is-on');
      clearTimeout(settle);
      settle = setTimeout(function () { old.classList.remove('was-on'); }, 850);
      tray.classList.add('is-swap');
      swap = setTimeout(function () { label(r); }, 200);
      cur = n;
    }
    mark(n);
    bar.style.width = '0';
    time(r.from);
  }
  /* Put round one back with no animation. Only called once a real screenshot covers the
     phone, so the loop restarts clean instead of showing the last round's answer. */
  function rewind() {
    clearTimeout(swap);
    clearTimeout(settle);
    each(scenes, function (s, i) {
      s.style.transition = 'none';
      s.classList.remove('was-on');
      s.classList[i === 0 ? 'add' : 'remove']('is-on');
      s.setAttribute('aria-hidden', String(i !== 0));
    });
    cur = 0;
    gs.classList.remove('is-reaching', 'is-pressed', 'is-done');
    label(rounds[0]);
    setOpen(false);
    bar.style.width = '0';
    time(rounds[0].from);
    void gs.offsetWidth;
    each(scenes, function (s) { s.style.transition = ''; });
  }
  /* Show the outcome. `chosen` is 'a', 'b' or null when the clock ran out. */
  function reveal(chosen) {
    var r = rounds[cur], other = r.right === 'a' ? 'b' : 'a';
    setOpen(false);
    gs.classList.remove('is-reaching');
    gs.classList.add('is-done');
    answers[r.right].classList.add('is-picked');
    answers[other].classList.add(chosen === other ? 'is-wrong' : 'is-dim');
    if (chosen === r.right) bar.style.width = '5%';
  }

  /* The self-playing loop. */
  var steps = [], starts = [];
  rounds.forEach(function (r, n) {
    starts.push(steps.length);
    steps.push([900, function () { deal(n); }]);
    steps.push([900, function () { time(r.from - 1); }]);
    steps.push([800, function () { time(r.from - 2); }]);
    steps.push([520, function () { if (open) gs.classList.add('is-reaching'); }]);
    steps.push([1500, function () {
      if (!open) return;
      gs.classList.add('is-pressed');
      reveal(r.right);
    }]);
  });
  steps.push([2800, function () { setOpen(false); shot('result'); mark(-1); }]);
  var introStep = steps.length;
  steps.push([1700, function () {
    setOpen(false); shot('intro'); mark(-1);
    clearTimeout(rew);
    rew = setTimeout(rewind, 850);  /* the screenshot takes 800ms to drop into place */
  }]);

  function run() {
    if (mode !== 'auto') return;
    clearTimeout(timer);
    if (userPaused || !onScreen || d.hidden) return;
    var s = steps[at];
    s[1]();
    timer = setTimeout(function () { at = (at + 1) % steps.length; run(); }, s[0]);
  }

  /* The visitor's turn. */
  function countdown() {
    clearInterval(tick);
    tick = setInterval(function () {
      if (mode !== 'play' || !open || userPaused || !onScreen || d.hidden) return;
      time(secs - 1);
      if (secs > 0) return;
      clearInterval(tick);
      var r = rounds[cur];
      reveal(null);
      say('Out of time. It was ' + r[r.right][1] + '.');
      timer = setTimeout(next, 1900);
    }, 1000);
  }
  function next() {
    if (cur + 1 < rounds.length) {
      deal(cur + 1);
      if (mode === 'play') countdown();
    } else if (mode === 'idle') {
      deal(0);
    } else {
      /* back to the loop, starting on the real "You're dropped" screen */
      mode = 'auto';
      at = introStep;
      run();
    }
  }
  function choose(k) {
    if (!open) return;
    var r = rounds[cur];
    clearTimeout(timer);
    clearInterval(tick);
    if (mode === 'auto') mode = 'play';
    reveal(k);
    say(k === r.right ? 'Correct. ' + r[k][1] + '.' : 'Not this one. It was ' + r[r.right][1] + '.');
    timer = setTimeout(next, k === r.right ? 1500 : 2100);
  }
  ['a', 'b'].forEach(function (k) {
    answers[k].disabled = false;
    answers[k].addEventListener('click', function () { choose(k); });
  });
  if (tryNote) tryNote.hidden = false;

  if (seg) {
    seg.hidden = false;
    each(segBtns, function (b) {
      b.addEventListener('click', function () {
        var n = +b.getAttribute('data-go');
        clearTimeout(timer);
        clearInterval(tick);
        if (mode === 'idle') return deal(n);
        mode = 'auto';
        at = starts[n];
        steps[at][1]();
        if (!userPaused) timer = setTimeout(function () { at += 1; run(); }, steps[at][0]);
      });
    });
  }
  if (pauseBtn && !still) {
    pauseBtn.hidden = false;
    pauseBtn.addEventListener('click', function () {
      userPaused = !userPaused;
      /* one switch for all motion: the stylesheet pauses every CSS animation on [data-paused] */
      if (userPaused) root.setAttribute('data-paused', ''); else root.removeAttribute('data-paused');
      pauseBtn.setAttribute('aria-label', userPaused ? 'Play the demo' : 'Pause the demo');
      pauseBtn.querySelector('use').setAttribute('href', userPaused ? '#i-play' : '#i-pause');
      run();
    });
  }
  if (canWatch) {
    new IntersectionObserver(function (entries) {
      var now = entries[0].isIntersecting;
      if (now === onScreen) return;
      onScreen = now;
      run();
    }, { threshold: 0.2 }).observe(gs);
  }
  d.addEventListener('visibilitychange', run);

  if (mode === 'idle') deal(0); else run();
})();

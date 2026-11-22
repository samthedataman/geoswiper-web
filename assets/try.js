/* GeoSwiper — the try.
   The home page's stage plays one try of the game: you are dropped on a real street, two
   answers, play until your second miss. This file is the game itself (places, tiers, the
   gate, the state machine, the dock, the slate, the clock, score and best). It drives one
   "world" and knows nothing about Google:

     ready(place)            load whatever the world needs
     arrive(place, how)      how = 'fly' or 'cut'; resolves when the street is on screen
     reveal(place, right)    after an answer
     over(history)           the try has ended
     prepare(place) · skip() · canFly() · end()
     events through options.on: phase, alt, looked, walked, failed, title (the first picture is up)

   Two worlds exist. assets/flyin.js is Google's (a 3D map and live Street View, at most one
   of each per page view); it is fetched only when a key is installed, the browser can run it
   and the stage is on screen. The other is below: the six licensed 360° photographs in
   assets/pano.js. With an empty key nothing is ever requested from Google Maps.

   Where things stand is on the stage element: data-state, data-layer ('google' or 'photo'),
   data-tier, and data-layer-reason after a fallback. Tests read window.__try. */
(function () {
  'use strict';
  var w = window, d = document;
  var stage = d.getElementById('stage');
  if (!stage) return;
  function $(id) { return d.getElementById(id); }

  /* The flight on phones, one switch per platform. Off: that platform gets live Street View by a cut. */
  var PHONE_FLIGHT = { ios: true, android: true };
  /* Live Street View without the 3D map (reduced motion, no hardware WebGL2, a slow line, a flight that
     never starts). Off: those visits play on the photos, so a panorama is only ever made after a 3D map
     has loaded and one cap on map loads bounds both. Turn it off if the owner's quota test shows that a
     reached cap does not stop a panorama on its own. */
  var STREET_ALONE = true;

  var KEY = String(w.GEOSWIPER_MAPS_KEY || '').trim();
  var calm = w.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var tall = w.matchMedia('(max-aspect-ratio: 1/1)');
  var compact = w.matchMedia('(max-width: 899px), (max-height: 520px) and (orientation: landscape)');
  var RED = '██████, ██████', RED_AT = '██°██′N ██°██′E';

  /* ── Places ──────────────────────────────────────────────────────────────
     Live: the coordinates of a street we chose, its ground height (metres above sea level)
     and the way the street runs. The panorama is looked up live from the coordinates; no
     panorama id ships. Answers: [code, name] for plate 1 and plate 2. */
  function live(city, country, cc, decoy, right, lat, lng, alt, heading) {
    return { key: city, a: [cc, right === 1 ? city : decoy], b: [cc, right === 1 ? decoy : city], right: right,
      was: city, name: city + ', ' + country, lat: lat, lng: lng, alt: alt, heading: heading };
  }
  var LIVE = [
    live('Rouen', 'France', 'FR', 'Strasbourg', 1, 49.44070, 1.09190, 12, 297),
    live('Tokyo', 'Japan', 'JP', 'Osaka', 2, 35.71076, 139.79640, 5, 186),
    live('Quebec City', 'Canada', 'CA', 'Montreal', 1, 46.81150, -71.20630, 60, 149),
    live('Cape Town', 'South Africa', 'ZA', 'Durban', 2, -33.92210, 18.41950, 25, 222),
    live('Lisbon', 'Portugal', 'PT', 'Porto', 2, 38.71080, -9.13750, 8, 342),
    live('San Francisco', 'United States', 'US', 'San Diego', 1, 37.78480, -122.40730, 12, 44)
  ];
  /* Photos (credits: /credits/#photos): where the tall and the wide still look [yaw, pitch],
     and how far down the view may tilt before the tripod shows. */
  var PHOTO = [
    { slug: 'rouen', low: -90, view: [-70, 8], wide: [-58, 6], a: ['FR', 'Rouen'], b: ['FR', 'Strasbourg'], right: 1,
      was: 'Rouen', name: 'Rouen, France', where: 'Rue Eau-de-Robec, Rouen, France', by: 'DXR (Daniel Vorndran)', lic: 'CC BY-SA 4.0',
      alt: 'a cobbled old-town street lined with half-timbered houses.' },
    { slug: 'tokyo', low: -90, view: [-112, 6], wide: [-100, 6], a: ['JP', 'Osaka'], b: ['JP', 'Tokyo'], right: 2,
      was: 'Tokyo', name: 'Tokyo, Japan', where: 'Minami-Nagasaki, Toshima, Tokyo, Japan', by: 'heiwa4126', lic: 'CC BY 2.0',
      alt: 'a quiet residential corner with white houses, overhead wires, a zebra crossing and parked bicycles.' },
    { slug: 'quebec-city', low: -80, view: [30, 3], wide: [38, 4], a: ['CA', 'Quebec City'], b: ['CA', 'Montreal'], right: 1,
      was: 'Quebec City', name: 'Quebec City, Canada', where: 'Vieux-Limoilou, Quebec City, Canada', by: 'Wilfredor', lic: 'CC BY-SA 4.0',
      alt: 'a snowbound residential street with parked cars, bare trees and brick apartment rows under a bright sun.' },
    { slug: 'simons-town', low: -85, view: [98, -4], wide: [104, 1], a: ['ZA', 'Durban'], b: ['ZA', 'Cape Town'], right: 2,
      was: 'Cape Town', name: 'Cape Town, South Africa', where: 'Coast road south of Simon’s Town, Cape Town, South Africa', by: 'Greg Zaal (Poly Haven)', lic: 'CC0 1.0',
      alt: 'a coastal road curving past scrub-covered hills towards the sea.' },
    { slug: 'carquin', low: -54, view: [-128, 5], wide: [-112, 4], a: ['CL', 'Chile'], b: ['PE', 'Peru'], right: 2,
      was: 'Peru', name: 'Caleta de Carquín, Peru', where: 'Plazuela de Carquín, Caleta de Carquín, Peru', by: 'Yachaqruna', lic: 'CC BY-SA 4.0',
      alt: 'a small-town plaza in low golden light, with ornate lamp posts, low houses and a red moto-taxi.' },
    { slug: 'gaithersburg', low: -62, view: [-20, 4], wide: [-8, 5], a: ['US', 'United States'], b: ['CA', 'Canada'], right: 1,
      was: 'the United States', name: 'Gaithersburg, United States', where: 'Olde Towne, Gaithersburg, Maryland, United States', by: 'G. Edward Johnson', lic: 'CC BY 4.0',
      alt: 'a small-town crossroads with traffic signals, crosswalks and brick shopfronts under a deep blue sky.' }
  ];
  var N = LIVE.length;

  /* ── The page ── */
  var title = $('title'), say = $('say'), sub = $('sub'), hint = $('hint');
  var coachChip = $('coach'), coachLine = $('coach2');
  var plates = $('plates'), plate = [null].concat([].slice.call(plates.querySelectorAll('.plate')));
  var dropBtn = $('drop'), nextBtn = $('next'), ends = $('ends'), againBtn = $('again'), soonBtn = $('soon');
  var skipBtn = $('skip'), clockBtn = $('clock'), clockLabel = $('clock-label');
  var slateText = $('slate-text'), slateSr = $('slate-sr'), hair = $('hair');
  var photoBox = $('photo'), panoHost = $('pano'), mapHost = $('map3d'), shield = $('shield'), curtain = $('curtain');
  var dock = $('dock'), credit = $('credit'), liveRegion = $('live');

  /* ── State ── */
  var tier = 'photo', why = '', layer = 'photo', lean = false, flights = 0;
  var state = 'static', world = null, job = 0, started = false, opened = false, skipAsked = false;
  var index = 0, round = 0, rounds = 0, score = 0, misses = 0, best = null, newBest = false, skipped = 0;
  var seen = {}, hist = [], revealed = false, spot = null, altText = 'ACQUIRING', slateJob = 0, viaKey = false;
  var clockOn = !calm, clock = null, ratio = 1, looked = false, walked = false, booted = performance.now();

  var T = w.__try = { objects: { map3d: 0, panorama: 0 }, notes: [] };
  ['state', 'tier', 'why', 'layer', 'index', 'round', 'score', 'misses', 'best'].forEach(function (k) {
    Object.defineProperty(T, k, { enumerable: true, get: function () {
      return { state: state, tier: tier, why: why, layer: layer, index: index, round: round, score: score, misses: misses, best: best }[k];
    } });
  });
  Object.defineProperty(T, 'reason', { enumerable: true, get: function () { return stage.getAttribute('data-layer-reason') || ''; } });

  function P() { return (layer === 'google' ? LIVE : PHOTO)[index]; }
  /* is this share of the stage on screen? (a short window can never show all of a 560px stage) */
  function most(share) { return ratio >= Math.min(share, 0.9 * w.innerHeight / Math.max(1, stage.offsetHeight)); }
  function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function replay(el) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
  function stored(box, key) { try { return w[box].getItem(key); } catch (e) { return null; } }
  function store(box, key, v) { try { w[box].setItem(key, v); } catch (e) {} }
  function inject(src) {
    return new Promise(function (ok, no) {
      var s = d.createElement('script');
      s.src = src; s.async = true; s.onload = ok; s.onerror = no;
      d.head.appendChild(s);
    });
  }
  function announce(text) { liveRegion.textContent = ''; setTimeout(function () { liveRegion.textContent = text; }, 60); }

  /* ── What is on screen ── */
  function setState(s) {
    state = s;
    stage.setAttribute('data-state', s);
    stage.setAttribute('data-phase', !started ? 'title' : s === 'over' ? 'end' : 'round');
    skipBtn.hidden = !(layer === 'google' && tier === 'fly' && !skipAsked && (s === 'flying' || s === 'globe' || (!started && (s === 'idle' || s === 'loading'))));
    clockBtn.hidden = !started;
    caption();
  }
  function caption() {
    var g = layer === 'google', on = g && state !== 'idle' && state !== 'loading'; /* a Google layer is on screen */
    $('cap-photo').hidden = g;
    $('cap-game').hidden = on;
    $('cap-google').hidden = $('gterms').hidden = !on; /* Google's terms: under the stage, and in the dock beside the picture */
    if (!g) credited(P());
  }
  function credited(p) { /* the photographer's credit stays on screen for as long as the photo does */
    credit.firstElementChild.textContent = 'Photo: ' + p.by;
    credit.lastElementChild.textContent = p.lic;
  }
  function words(main, under) {
    if (main == null) say.hidden = true;
    else { say.textContent = main; say.hidden = false; replay(say); }
    sub.textContent = under || '';
    sub.hidden = !under;
  }
  function paintScore() {
    $('sc').textContent = score;
    $('bs').textContent = best == null ? '–' : best;
    [].forEach.call($('pips').querySelectorAll('i'), function (pip, i) { pip.classList.toggle('is-on', i < misses); });
    $('pips-sr').textContent = ['No misses.', 'One miss.', 'Two misses.'][Math.min(2, misses)];
  }
  function coach() {
    var t = '';
    if (state === 'playing' && world && (!world.canLook || world.canLook())) {
      if (rounds === 1 && !looked) t = 'Drag to turn around. The clue may be behind you.';
      else if (rounds === 2 && !walked && layer === 'google') t = 'Not sure? Follow the arrows and walk to the corner.';
    }
    if (coachChip.lastElementChild.textContent !== t) {
      coachChip.lastElementChild.textContent = coachLine.textContent = t;
      coachChip.hidden = coachLine.hidden = !t;
    }
  }

  /* The slate: one line of mono type. Redacted until the visitor answers; it carries the camera's
     height on the way down. The bars are our own letters, wrapped so they sit closed up. */
  function paintSlate(txt) {
    slateText.innerHTML = txt.replace(/[&<>]/g, '').replace(/█+/g, '<i class="red">$&</i>');
  }
  function slateNow() {
    var short = compact.matches, p = P();
    if (layer === 'photo') return revealed ? (short ? p.name : p.where).toUpperCase() : RED + ' · 360° PHOTO';
    if (revealed) return p.name.toUpperCase() + (short || !spot ? '' : ' · ' + dm(spot.lat, 'N', 'S') + ' ' + dm(spot.lng, 'E', 'W'));
    return RED + (short ? '' : ' · ' + RED_AT) + ' · ' + altText;
  }
  function slate() { slateJob++; paintSlate(slateNow()); }
  function dm(v, pos, neg) {
    var a = Math.abs(v), deg = Math.floor(a), min = Math.floor((a - deg) * 60);
    return deg + '°' + (min < 10 ? '0' : '') + min + '′' + (v < 0 ? neg : pos);
  }
  function unredact() {
    var from = slateText.textContent, to, n, i = 0, mine;
    revealed = true;
    to = slateNow();
    slateSr.textContent = P().name + '.';
    mine = ++slateJob;
    if (calm) return paintSlate(to);
    n = Math.max(from.length, to.length);
    (function step() {
      if (mine !== slateJob) return;
      i += 2;
      if (i >= n) return paintSlate(to);
      paintSlate(to.slice(0, i) + from.slice(i));
      setTimeout(step, 26);
    })();
  }
  function altitude(m, left) { /* metres above the landing point; how much of the fall is left, 1 to 0 */
    var km = m / 1000, n;
    if (m == null) altText = 'ALT --';
    else if (km >= 1) {
      n = km >= 1000 ? Math.round(km / 100) * 100 : km >= 100 ? Math.round(km / 10) * 10 : km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
      altText = 'ALT ' + n.toLocaleString('en-US') + ' KM';
    } else altText = 'ALT ' + (m >= 100 ? Math.round(m / 10) * 10 : Math.max(1, Math.round(m))) + ' M';
    if (left != null) hair.style.setProperty('--f', Math.max(0, Math.min(1, left)).toFixed(3));
    if (!revealed) slate();
  }

  /* ── The clock: the hairline under the slate, no numerals. It starts at the visitor's first
     action in the round, so watching is never failed, and it gets shorter as the try goes on
     (the app's own rule). It stops while the tab is hidden or the stage is mostly off screen. */
  function armClock() {
    var ms = Math.max(6, 20 - Math.max(0, round - 3)) * 1000;
    clock = { total: ms, left: ms, running: false, last: 0 };
    stage.removeAttribute('data-clock');
    hair.style.setProperty('--f', clockOn ? '1' : '0');
  }
  function startClock() {
    if (!clock || clock.running || state !== 'playing') return;
    clock.running = true;
    clock.last = performance.now();
    requestAnimationFrame(tick);
  }
  function tick(t) {
    if (!clock || !clock.running || state !== 'playing') return;
    var dt = t - clock.last;
    clock.last = t;
    if (clockOn && !d.hidden && most(0.5) && dt > 0 && dt < 400) clock.left -= dt;
    var f = Math.max(0, clock.left / clock.total);
    hair.style.setProperty('--f', clockOn ? f.toFixed(3) : '0');
    if (clockOn && f < 0.25) stage.setAttribute('data-clock', 'low'); else stage.removeAttribute('data-clock');
    if (clock.left <= 0) return verdict(0, true);
    requestAnimationFrame(tick);
  }
  function paintClock() {
    clockBtn.setAttribute('aria-checked', clockOn ? 'true' : 'false');
    clockLabel.textContent = clockOn ? 'Clock on' : 'Clock off';
  }
  clockBtn.addEventListener('click', function () {
    clockOn = !clockOn;
    paintClock();
    if (clock && state === 'playing') hair.style.setProperty('--f', clockOn ? Math.max(0, clock.left / clock.total).toFixed(3) : '0');
    if (!clockOn) stage.removeAttribute('data-clock');
  });

  /* ── Tier: decided once per page view, from cheap local checks, before any request to Google ── */
  function gl(kind, strict) {
    try {
      var c = d.createElement('canvas'), g = c.getContext(kind, strict ? { failIfMajorPerformanceCaveat: true } : undefined);
      if (!g) return false;
      var lose = g.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (e) { return false; }
  }
  function decide() {
    var n = navigator, net = n.connection || {}, ua = n.userAgent || '';
    if (!KEY) return ['photo', 'no-key'];
    if (net.saveData) return ['photo', 'save-data'];
    if (n.webdriver) return ['photo', 'automation'];
    if (stored('sessionStorage', 'gs-google') === 'down') return ['photo', 'google-down'];
    if (!gl('webgl2') && !gl('webgl')) return ['photo', 'no-webgl'];
    lean = w.matchMedia('(pointer: coarse)').matches || w.innerWidth < 768;
    flights = lean ? 1 : n.deviceMemory && n.deviceMemory < 8 ? 1 : 3;
    var ios = /iP(hone|ad|od)/.test(ua) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1);
    /* Chrome's own speed estimate is not used: on a fast line it starts far too low. A line that really is
       slow shows in how long the 3D library takes to arrive, and flyin.js then skips the flight. */
    var no = calm ? 'reduced-motion' : !gl('webgl2', true) ? 'no-webgl2' : /^(slow-2g|2g|3g)$/.test(net.effectiveType || '') ? 'slow-network' :
      n.deviceMemory && n.deviceMemory < 4 ? 'low-memory' : stored('sessionStorage', 'gs-fly') === 'started' ? 'flight-crashed' :
      lean && ((ios && !PHONE_FLIGHT.ios) || (/Android/.test(ua) && !PHONE_FLIGHT.android)) ? 'phone-flight-off' : '';
    return no ? [STREET_ALONE ? 'street' : 'photo', no] : ['fly', ''];
  }

  /* ── The gate: nothing is fetched (and Google is not contacted) until the stage is on screen
     in a visible tab. In the street tier the visitor must also have chosen to: a press, a tap or
     a key (moving the mouse or scrolling is not a choice), so a crawler that renders in software
     never loads a panorama. ── */
  function gate() {
    var onScreen = !('IntersectionObserver' in w), acted = tier !== 'street', held = 0;
    var signs = ['pointerdown', 'keydown'];
    /* A visit that opens further down (a link to #rules or #get, a reload, the back button) starts at
       the top and is then scrolled away: there the stage must stay on screen for a moment first. */
    var nav = (w.performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
    var dwell = location.hash.length > 1 || (nav.type && nav.type !== 'navigate') ? 900 : 0;
    function act() { acted = true; check(); }
    function check() {
      if (opened || !onScreen || !acted || d.visibilityState !== 'visible' || d.prerendering) return;
      opened = true;
      signs.forEach(function (t) { w.removeEventListener(t, act, true); });
      begin();
    }
    if (!onScreen) new IntersectionObserver(function (en) {
      ratio = en[en.length - 1].intersectionRatio;
      clearTimeout(held);
      if (!most(0.6)) { onScreen = false; return; }
      if (!dwell) { onScreen = true; return check(); }
      held = setTimeout(function () { onScreen = true; check(); }, dwell);
    }, { threshold: [0, 0.2, 0.3, 0.4, 0.5, 0.6, 1] }).observe(stage);
    d.addEventListener('visibilitychange', check);
    d.addEventListener('prerenderingchange', check);
    if (!acted) signs.forEach(function (t) { w.addEventListener(t, act, { capture: true, passive: true }); });
    dropBtn.addEventListener('click', act);
    check();
  }
  function begin() {
    altText = 'ACQUIRING';
    setState('loading');
    slate();
    dropBtn.hidden = true;
    if (layer === 'photo') return startPhoto(true);
    var cap = setTimeout(function () { toPhoto('load-timeout'); }, 10000);
    inject('/assets/flyin.js').then(function () {
      if (layer !== 'google') return;
      world = w.GeoFly.create({
        key: KEY, tier: tier, lean: lean, flights: flights, calm: calm, skipped: skipAsked, streetAlone: STREET_ALONE, objects: T.objects, notes: T.notes,
        hosts: { map: mapHost, pano: panoHost, shield: shield, curtain: curtain },
        on: { phase: phase, alt: altitude, looked: onLooked, walked: onWalked, failed: toPhoto, title: titleOff }
      });
      return world.ready(P());
    }).then(function () {
      clearTimeout(cap);
      if (layer === 'google') go(tier === 'fly' && !skipAsked ? 'fly' : 'cut');
    }, function () {
      clearTimeout(cap);
      toPhoto('adapter-load');
    });
  }
  function phase(name) { /* the world reports: globe (waiting to fall), flying (the camera moves), landing */
    if (layer !== 'google' || state === 'playing') return;
    setState(name);
    if (name === 'flying') {
      words('You’re dropped.', 'Watch the way down: it is your first clue.');
      announce('Flying to a street somewhere on Earth.');
    }
  }
  /* The title card: until the first picture is up (the Earth, the street or the photo) the headline stands
     in the window itself. It goes once, for the page view. */
  function titleOff() { if (stage.getAttribute('data-title') !== 'off') stage.setAttribute('data-title', 'off'); }
  function onLooked() { looked = true; startClock(); coach(); }
  function onWalked() { walked = true; startClock(); coach(); }

  /* ── One place ── */
  function go(how) {
    var p = P(), mine = ++job, a = d.activeElement;
    revealed = false; spot = null; altText = started ? 'ALT --' : 'ACQUIRING';
    slateSr.textContent = 'Location hidden until you answer.';
    hair.style.setProperty('--f', '0');
    stage.removeAttribute('data-clock');
    slate();
    /* the button that was pressed is about to go: focus stays in the stage, where the answers will be */
    if (a && (a === nextBtn || ends.contains(a))) $('answers').focus({ preventScroll: true });
    plates.hidden = nextBtn.hidden = ends.hidden = hint.hidden = true;
    if (started) { setState('landing'); words('You’re dropped.', ''); }
    world.arrive(p, how).then(function (at) {
      if (mine !== job) return;
      spot = at && at.lat != null ? at : null;
      skipAsked = false;
      startRound();
    }, function (err) {
      if (mine !== job) return;
      if (err && err.code === 'ZERO_RESULTS' && skipped < 2) { /* no imagery at that spot: the next place, twice at most */
        skipped++;
        index = (index + 1) % N;
        return go(how);
      }
      toPhoto(err && err.code === 'ZERO_RESULTS' ? 'no-imagery' : 'arrive-failed');
    });
  }
  function startRound() {
    var p = P();
    started = true;
    round++; rounds++;
    seen[index] = 1;
    titleOff();
    title.classList.add('vh'); /* the headline stays in the document, out of sight */
    setState('playing');
    words('Where are you?', '');
    [1, 2].forEach(function (n) {
      var b = plate[n], ans = n === 1 ? p.a : p.b;
      b.className = 'plate';
      b.setAttribute('aria-disabled', 'false');
      b.querySelector('.cc').textContent = ans[0];
      b.querySelector('.plate-name').textContent = ans[1];
    });
    plates.hidden = false;
    hint.hidden = false;
    altText = 'STREET LEVEL';
    slate();
    armClock();
    coach();
    announce('You are on a street. Where are you? Answer one: ' + p.a[1] + '. Answer two: ' + p.b[1] + '.');
  }
  function answer(n) { if (state === 'playing' && (n === 1 || n === 2)) verdict(n, false); }
  function verdict(pick, late) {
    if (state !== 'playing') return;
    var p = P(), right = !late && pick === p.right, mine = job, inStage = viaKey || stage.contains(d.activeElement);
    viaKey = false;
    if (clock) clock.running = false;
    setState('verdict');
    hint.hidden = true;
    coach();
    [1, 2].forEach(function (n) {
      var b = plate[n];
      b.setAttribute('aria-disabled', 'true');
      b.className = 'plate ' + (n === pick ? (right ? 'is-right' : 'is-wrong') : n === p.right ? 'is-answer' : 'is-dim');
    });
    if (right) {
      score++;
      if (best == null || score > best) { best = score; newBest = true; store('localStorage', 'gs-best', String(best)); }
    } else misses++;
    hist.push({ index: index, right: right });
    paintScore();
    words(right ? 'Correct.' : (late ? 'Out of time. It was ' : 'It was ') + p.was + '.', right || misses > 1 ? '' : 'One miss left.');
    unredact();
    announce((right ? 'Correct. ' : late ? 'Out of time. It was ' : 'Miss. It was ') + p.name + '. ' + (right ? 'Score ' + score + '.' : misses === 1 ? 'One miss left.' : ''));
    if (world.prepare && misses < 2) world.prepare((layer === 'google' ? LIVE : PHOTO)[(index + 1) % N]);
    world.reveal(p, right).then(function () { if (mine === job && state === 'verdict') after(inStage); });
  }
  function allSeen() { for (var i = 0; i < N; i++) if (!seen[i]) return false; return true; }
  function after(inStage) {
    if (inStage == null) inStage = stage.contains(d.activeElement);
    if (misses >= 2 || allSeen()) return endTry(inStage);
    setState('between');
    plates.hidden = true;
    nextBtn.hidden = false;
    if (inStage) nextBtn.focus({ preventScroll: true });
  }
  function endTry(inStage) {
    var all = allSeen(), n = score + (score === 1 ? ' place' : ' places');
    var bestLine = newBest && score > 0 ? 'New best.' : best == null ? '' : 'Best: ' + best + '.';
    setState('over');
    plates.hidden = nextBtn.hidden = true;
    words(all ? 'You’ve seen every street on this page.' : 'That’s the try.', 'You named ' + n + '. ' + bestLine);
    /* every street seen: the app is the next thing to do, playing them again comes second */
    ends.classList.toggle('is-seen', all);
    againBtn.className = 'btn ' + (all ? 'btn--line' : 'btn--go');
    soonBtn.className = 'btn ' + (all ? 'btn--go' : 'btn--line');
    againBtn.lastElementChild.textContent = all ? 'Play them again' : 'Try again';
    ends.hidden = false;
    if (inStage) (all ? soonBtn : againBtn).focus({ preventScroll: true });
    if (world.over) world.over(hist);
    announce('Try over. You named ' + n + '. ' + (best == null ? '' : 'Best: ' + best + '.'));
  }
  function advance() {
    index = (index + 1) % N;
    go(world.canFly && world.canFly() ? 'fly' : 'cut');
  }
  nextBtn.addEventListener('click', function () { if (state === 'between') advance(); });
  againBtn.addEventListener('click', function () {
    if (state !== 'over') return;
    if (allSeen()) seen = {};
    score = misses = round = 0; newBest = false; hist = [];
    paintScore();
    advance();
  });
  [1, 2].forEach(function (n) { plate[n].addEventListener('click', function () { answer(n); }); });

  /* Keys 1 and 2 answer, Enter goes on to the next place and Escape skips the fall, while focus is in
     the stage (or nowhere, with the stage on screen). Whoever answers by key gets the focus on "Next
     place", so the whole try can be played from the keyboard. Arrow keys are left to Street View,
     which uses them to look and walk; Enter is left to whatever control has the focus. */
  d.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    var a = d.activeElement;
    if (!((stage.contains(a) && !a.closest('.site-header')) || ((!a || a === d.body) && most(0.5)))) return;
    if (e.key === 'Escape' && !skipBtn.hidden) { e.preventDefault(); skipNow(); }
    else if (state === 'playing' && (e.key === '1' || e.key === '2')) { e.preventDefault(); viaKey = true; answer(+e.key); viaKey = false; }
    else if (state === 'between' && e.key === 'Enter' && !(a && a.closest && a.closest('a,button,summary,input,select,textarea,#pano,#map3d'))) { e.preventDefault(); advance(); }
  });
  /* the first thing the visitor does in a round starts its clock */
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) {
    stage.addEventListener(t, function (e) {
      if (state === 'playing' && !(e.target.closest && e.target.closest('.band, .site-header'))) startClock();
    }, { capture: true, passive: true });
  });
  /* touch: a sideways flick of the dock, towards a plate, answers */
  var flick = null;
  dock.addEventListener('pointerdown', function (e) {
    flick = e.pointerType === 'touch' && state === 'playing' ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  });
  dock.addEventListener('pointerup', function (e) {
    var f = flick;
    flick = null;
    if (!f || e.pointerId !== f.id || e.timeStamp - f.t > 600) return;
    var dx = e.clientX - f.x, dy = e.clientY - f.y;
    if (Math.abs(dx) > 56 && Math.abs(dx) > 2 * Math.abs(dy)) answer(dx < 0 ? 1 : 2);
  });
  dock.addEventListener('pointercancel', function () { flick = null; });

  /* "Skip to the two answers": focus goes to the first answer (or to where the answers will be), the page stays put */
  stage.querySelector('.skip--stage').addEventListener('click', function (e) {
    e.preventDefault();
    (state === 'playing' ? plate[1] : $('answers')).focus({ preventScroll: true });
  });
  function skipNow() {
    skipAsked = true;
    skipBtn.hidden = true;
    if (world && world.skip) world.skip();
  }
  skipBtn.addEventListener('click', skipNow);

  /* ── Any hard failure of Google's layers: they leave first, then the photo appears, for the rest
     of the page view. Score and misses carry over; an open round starts again on the photo. ── */
  function toPhoto(reason) {
    if (layer === 'photo') return;
    var was = state, old = world;
    layer = 'photo';
    stage.setAttribute('data-layer', 'photo');
    stage.setAttribute('data-layer-reason', String(reason || 'failed'));
    job++;
    mapHost.hidden = panoHost.hidden = shield.hidden = curtain.hidden = true;
    world = null;
    if (old && old.end) old.end();
    if (clock) clock.running = false;
    var open = was !== 'verdict' && was !== 'between' && was !== 'over';
    if (was === 'playing') { round--; rounds--; }
    if (!open) { revealed = true; slate(); }
    startPhoto(open);
    if (was === 'verdict') setTimeout(function () { if (state === 'verdict') after(); }, 900);
  }

  /* ── The photo world: assets/pano.js and six photographs. Each place drops in from above. ── */
  function startPhoto(open) {
    if (open) setState(started ? 'landing' : 'loading'); else caption();
    world = photoWorld();
    world.ready(P()).then(function () { if (open && layer === 'photo') go('cut'); });
  }
  function photoWorld() {
    var BASE = '/assets/panos/', RAD = Math.PI / 180;
    var WIDE = 2 * Math.atan(Math.tan(50 * RAD) / 2.4) / RAD; /* the wide still: 100° across at 2.4:1 */
    var view = null, first = true, canLive = gl('webgl'); /* no WebGL: the stills are the round, nothing to wait for */
    function frame(p) {
      var alt = 'Real 360° street photo: ' + p.alt;
      return tall.matches ? { src: BASE + p.slug + '-still.webp', w: 780, h: 1690, vfov: 90, yaw: p.view[0], pitch: p.view[1], alt: alt }
        : { src: BASE + p.slug + '-wide.webp', w: 1680, h: 700, vfov: WIDE, yaw: p.wide[0], pitch: p.wide[1], alt: alt };
    }
    function still(p) { /* put a place's still in the box (no viewer, or before there is one) */
      var f = frame(p), img = new Image();
      img.className = 'pano-still'; img.width = f.w; img.height = f.h; img.alt = f.alt; img.decoding = 'async'; img.src = f.src;
      [].forEach.call(photoBox.querySelectorAll('picture, .pano-still'), function (el) { el.remove(); });
      photoBox.insertBefore(img, photoBox.firstChild);
    }
    function drift() { /* the view turns 12 degrees and stops, as a landing does */
      if (calm || !view || !view.live) return;
      var f = frame(P()), r = photoBox.getBoundingClientRect(), a = r.width / r.height, a0 = f.w / f.h, t0 = Math.tan(f.vfov * RAD / 2);
      view.nudge(-12 * RAD * (r.height / 2 / (a >= a0 ? t0 * a0 / a : t0)), 0, 1600);
    }
    return {
      canLook: function () { return !!(view && view.live); },
      canFly: function () { return false; },
      ready: function (p) {
        if (p.slug !== 'rouen' || !photoBox.querySelector('.pano-still')) still(p);
        photoBox.classList.add('is-up'); /* its still waits above the window */
        photoBox.hidden = false;
        return inject('/assets/pano.js').then(function () {
          view = w.GeoPano.create(photoBox, {
            place: p, frame: frame, eager: true, drop: true,
            keen: true, /* the sharp photo as soon as the round can be played (large screens only: pano.js decides) */
            label: '360° street photo. Drag, or use the arrow keys, to look around.',
            ongrab: onLooked
          });
          if (view) view.hold(true); /* no slow turning by itself: this is a round, the visitor steers */
        }, function () {}); /* no viewer: the stills alone still make a round */
      },
      arrive: function (p) {
        var t0 = performance.now(), isFirst = first;
        first = false;
        credited(p);
        function landed() { return !view || !canLive || view.live && view.photo.indexOf(p.slug + '-') === 0; }
        function settle(cap) { /* the photo itself, not only its still: wait for it, but not for long */
          return new Promise(function (ok) {
            (function poll() { if (landed() || performance.now() - t0 > cap) ok(); else setTimeout(poll, 80); })();
          });
        }
        if (isFirst) {
          /* the title gets its moment, then the street drops into the window */
          return wait(calm || started ? 0 : Math.max(0, 900 - (performance.now() - booted))).then(function () {
            void photoBox.offsetWidth;
            titleOff();
            photoBox.classList.add('is-dropping');
            photoBox.classList.remove('is-up');
            return wait(calm ? 0 : 820);
          }).then(function () {
            photoBox.classList.remove('is-dropping');
            return settle(2600);
          }).then(function () { drift(); return {}; });
        }
        if (view) view.show(p); else still(p);
        return wait(calm ? 0 : 860).then(function () { return settle(4000); }).then(function () { drift(); return {}; });
      },
      prepare: function (p) { if (view) view.warm(p); else new Image().src = frame(p).src; },
      reveal: function () { return wait(900); }
    };
  }

  /* ── Boot ── */
  (function () {
    var b = parseInt(stored('localStorage', 'gs-best'), 10), t = decide();
    d.documentElement.classList.add('js'); /* index.html takes it off if this script is very late */
    if (b >= 0) best = b;
    tier = t[0]; why = t[1];
    layer = tier === 'photo' ? 'photo' : 'google';
    if (tier === 'street') altText = 'STANDING BY'; /* nothing is fetched until the visitor says so */
    stage.setAttribute('data-tier', tier);
    stage.setAttribute('data-layer', layer);
    if (layer === 'google') { photoBox.hidden = true; slate(); } /* the photo is never seen; the window is night */
    else photoBox.classList.add('is-up');
    paintScore();
    paintClock();
    setState('idle');
    words('You’re about to be dropped on a real street.', '');
    dropBtn.hidden = tier !== 'street';
    compact.addEventListener('change', function () { slate(); });
    gate();
  })();
})();

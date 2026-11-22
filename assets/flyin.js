/* GeoSwiper — the Google world for assets/try.js.
   Google's 3D map falls from the whole Earth to a real street and dissolves into live Street
   View at the same spot and heading. Everything is shown live through the Maps JavaScript API
   in the visitor's browser; nothing of Google's is stored, and nothing here styles or hides
   anything Google draws.

   Cost: at most ONE Map3DElement and ONE StreetViewPanorama per page view, reused for every
   place. The panorama is created late in the first flight; the map is removed for good
   ("retired") on phones after the first landing and after flights that could not run.
   Lookups (StreetViewService) are free.

   Any hard failure calls on.failed(reason) once; try.js then shows the licensed photos for the
   rest of the page view. The key comes from assets/maps-config.js and is never in this file. */
(function () {
  'use strict';
  var w = window, d = document, RAD = Math.PI / 180, EARTH = 6371000;
  /* The fall is Google's own camera animation, flown in legs so that each height can be read on the way
     down: the whole Earth, then the country (north up, as on a map), then the city seen a little from the
     side, then the last kilometres round into the line of the street. way: the stops before the landing
     (range in metres, tilt, heading relative to the street or null for north, milliseconds to get there).
     range, tilt, ms: the landing camera and the last leg. The dissolve into Street View may start once the
     camera is under `under` metres and nearly level. Google loads the way down before it starts a first
     flight, so that one begins a moment after it is asked for.
     (Placing the camera frame by frame instead was tried: the map cannot load its tiles that way.) */
  var FULL = { range: 110, tilt: 76, under: 240, ms: 3000, way: [{ range: 1000000, tilt: 0, turn: null, ms: 2300 }, { range: 3000, tilt: 55, turn: 322, ms: 2800 }] };
  var LEAN = { range: 150, tilt: 62, under: 330, ms: 2300, way: [{ range: 1000000, tilt: 0, turn: null, ms: 1800 }, { range: 3400, tilt: 46, turn: 322, ms: 2400 }] };
  /* the camera has not moved this long after it was told to: stop waiting. The first flight waits for
     the globe to load as well, so it gets longer. */
  var STALL_FIRST = 12000, STALL = 7000;
  var SLOW_LIB = 6000; /* the 3D library took longer than this to arrive: the line is too slow for a flight */

  function create(o) {
    var G, sv, m3, map = null, pano = null, svc = null;
    var hosts = o.hosts, on = o.on, cam = o.lean ? LEAN : FULL;
    var dead = false, alive = false, flights = o.flights, skipAsked = !!o.skipped, appended = 0, stalls = 0;
    var looks = {}, cur = null, place = null, flight = null, pins = {}, lift = 0;
    var status = '', fresh = false, setAt = 0, okAt = 0, waiters = [], isLive = false, drifting = false, base = 0, told = {}, parked = null;
    var altBusy = false, top = 1, shown = false, earth = false;

    function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
    function note(n) { o.notes.push(n); }
    function keep(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
    function since(t) { return Math.round(performance.now() - t); }

    /* ── failure: once, and for good ── */
    function fail(reason, detail, down) {
      if (dead) return;
      dead = true;
      if (down) keep('gs-google', 'down'); /* key, quota or script trouble: the next page view in this tab starts on the photos */
      note('failed:' + reason + (detail ? ':' + String(detail).slice(0, 80) : ''));
      end();
      on.failed(reason);
    }
    function end() {
      dead = true;
      isLive = false;
      clearTimeout(lift);
      if (flight) flight.cancel();
      retire();
      try { if (pano) pano.setVisible(false); } catch (e) {}
    }
    function retire() { /* remove the 3D map, once, for good */
      if (!map) return;
      alive = false;
      clearTimeout(lift);
      try { map.stopCameraAnimation(); } catch (e) {}
      try { map.remove(); } catch (e) {}
      map = null;
      hosts.map.hidden = true;
      hosts.shield.hidden = true;
    }

    /* Google reports key, referrer, billing and quota problems on the console. With only the 3D
       map and the lookup service on the page that line is the earliest signal there is. */
    ['error', 'warn'].forEach(function (level) {
      var orig = console[level];
      console[level] = function () {
        try {
          var m = /Google Maps JavaScript API error: (\w+MapError)/.exec([].map.call(arguments, String).join(' '));
          if (m) fail('google-error', m[1], true);
        } catch (e) {}
        return orig.apply(console, arguments);
      };
    });

    /* ── loader: one script tag, on demand ── */
    function load() {
      return new Promise(function (ok, no) {
        var t = setTimeout(function () { no('script-timeout'); }, 10000);
        w.gm_authFailure = function () { fail('auth-failure', '', true); };
        w.__geoswiperMaps = function () { clearTimeout(t); ok(w.google.maps); };
        var s = d.createElement('script');
        s.async = true;
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(o.key) + '&v=weekly&loading=async&libraries=' +
          (o.tier === 'fly' ? 'maps3d,streetView' : 'streetView') + '&callback=__geoswiperMaps&auth_referrer_policy=origin';
        s.onerror = function () { clearTimeout(t); no('script-load'); };
        d.head.appendChild(s);
      });
    }
    function ready(first) {
      return load().then(function (maps) {
        G = maps;
        return maps.importLibrary('streetView');
      }).then(function (lib) {
        sv = lib;
        find(first).catch(function () {}); /* the first lookup runs while the 3D library loads */
        /* "Skip the fall" before there is a map: no map at all (unless a panorama may only follow a map load) */
        if (o.tier !== 'fly' || dead || (skipAsked && o.streetAlone)) return;
        var t0 = performance.now();
        return G.importLibrary('maps3d').then(function (lib3) {
          m3 = lib3;
          if (dead) return;
          if (performance.now() - t0 > SLOW_LIB) { /* a line this slow would leave the globe waiting: live Street View by a cut */
            note('maps3d-slow+' + since(t0));
            if (!o.streetAlone) fail('slow-network', '', false);
            return;
          }
          if (!skipAsked || !o.streetAlone) makeMap(first);
        });
      }).catch(function (err) {
        fail(typeof err === 'string' ? err : 'init-error', err && err.message, true);
        throw err;
      });
    }

    /* ── cameras ── */
    function globeCam(p) {
      /* far enough that the whole globe fits the narrower side of the window (vertical fov 35°) */
      var half = 17.5 * RAD, r = hosts.map.getBoundingClientRect();
      var fit = Math.min(half, Math.atan(Math.tan(half) * Math.max(0.2, r.width / Math.max(1, r.height))));
      return { center: { lat: p.lat * 0.5, lng: wrap(p.lng - 38), altitude: 0 }, range: Math.min(6e7, Math.round(EARTH / Math.sin(fit) * 1.12 - EARTH)), tilt: 0, heading: 0 };
    }
    function wrap(lng) { return ((lng + 540) % 360) - 180; }
    function above(spot, range) { return { center: { lat: spot.lat, lng: spot.lng, altitude: 0 }, range: range, tilt: 0, heading: 0 }; }
    function height() { return map ? map.range * Math.cos((map.tilt || 0) * RAD) : 0; }

    /* ── the one 3D map ── */
    function makeMap(first) {
      hosts.map.hidden = false; /* the box needs its size before the globe is fitted to it */
      hosts.map.setAttribute('data-on', '0');
      var opts = {
        center: globeCam(first).center, range: globeCam(first).range, tilt: 0, heading: 0,
        mode: m3.MapMode.SATELLITE, /* no labels: a place name on the map would give the answer away */
        defaultUIHidden: true,
        gestureHandling: m3.GestureHandling ? m3.GestureHandling.COOPERATIVE : 'COOPERATIVE'
      };
      if (o.lean) { /* Google's own advice for phones */
        if (m3.QualityMode) opts.qualityMode = m3.QualityMode.PERFORMANCE;
        opts.maxMemoryMegabytes = 512;
      }
      keep('gs-fly', 'started'); /* if the tab dies mid-flight, the next page view in it does not fly */
      try { map = new m3.Map3DElement(opts); }
      catch (e) { delete opts.maxMemoryMegabytes; delete opts.qualityMode; map = new m3.Map3DElement(opts); }
      o.objects.map3d++;
      alive = true;
      map.addEventListener('gmp-error', function (e) { fail('map3d-error', e && e.message, true); });
      map.addEventListener('gmp-rangechange', moved);
      map.addEventListener('gmp-steadychange', function (e) { if (e && e.isSteady) drawn('steady'); });
      hosts.map.appendChild(map);
      appended = performance.now();
      top = height();
      shown = true;
      hosts.shield.hidden = false;
      watch();
      on.phase('globe');
    }
    /* The Earth comes up only once Google has drawn it (or, failing that, when the camera first moves).
       Until then the window keeps the title, so the first screen is never an empty box. Google gives no
       event for "the globe is on screen"; what the page can see is its own network log: once a handful
       of Google's Earth tiles have come back after the map was added, the globe is there. Nothing of
       Google's is read, only that the requests ended well. If Google ever names that host differently
       this simply never fires, and the Earth comes up when the camera moves, as it would without it. */
    function watch() {
      if (!w.PerformanceObserver) return; /* then the Earth comes up when the camera first moves */
      var n = 0, t0 = appended, po;
      try {
        po = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (e) {
            var ok = e.responseStatus == null || (e.responseStatus >= 200 && e.responseStatus < 300); /* not every browser reports it */
            if (ok && e.responseEnd >= t0 && /^https:\/\/(keyhole|khms?\d*|tile|earth)[\w-]*\.(googleapis|google)\.com\//.test(e.name)) n++;
          });
          if (n < 10) return;
          po.disconnect();
          setTimeout(function () { drawn('tiles'); }, 250); /* a moment for them to be painted */
        });
        po.observe({ type: 'resource' });
      } catch (e) {}
    }
    function drawn(how) {
      if (earth || !map) return;
      earth = true;
      note('earth:' + how + '+' + since(appended));
      if (!shown) return;
      hosts.map.setAttribute('data-on', '1');
      on.title();
    }
    function showMap(yes) {
      shown = yes;
      hosts.map.style.visibility = yes ? 'visible' : 'hidden';
      hosts.map.setAttribute('data-on', yes && earth ? '1' : '0');
      hosts.shield.hidden = !yes;
    }
    function moved() {
      if (!map) return;
      if (flight) flight.move();
      if (!flight || altBusy) return;
      altBusy = true;
      requestAnimationFrame(function () { /* the slate: height above the landing point, and how much of the fall is left */
        altBusy = false;
        if (!flight || !map) return;
        var h = Math.max(1, height()), low = cam.range * Math.cos(cam.tilt * RAD);
        on.alt(h, Math.log(h / low) / Math.log(Math.max(2, top / low)));
      });
    }

    /* ── Street View: one service, one panorama ── */
    function find(p) {
      if (looks[p.key]) return looks[p.key];
      if (!svc) svc = new sv.StreetViewService();
      var S = sv.StreetViewSource, first;
      function ask(sources) {
        return svc.getPanorama({ location: { lat: p.lat, lng: p.lng }, radius: 60, preference: sv.StreetViewPreference.NEAREST, sources: sources });
      }
      try { first = ask(S.GOOGLE ? [S.GOOGLE, S.OUTDOOR] : [S.OUTDOOR]); } catch (e) { first = null; }
      if (!first || typeof first.then !== 'function') { /* after a refused key the library hands back nothing */
        fail('streetview-service', 'disabled', true);
        return Promise.reject({ code: 'DEAD' });
      }
      var job = first.catch(function (err) {
        if (S.GOOGLE && err && err.code === 'ZERO_RESULTS') return ask([S.OUTDOOR]);
        throw err;
      }).then(function (res) {
        var data = res && res.data, links = data && data.links || [];
        if (!data || !data.location || !/Google/.test(data.copyright || '') || !links.length) throw { code: 'ZERO_RESULTS' };
        /* look down the road: the walking link closest to the way we wanted to face */
        var best = p.heading, gap = 999;
        links.forEach(function (l) {
          var g = Math.abs(((l.heading - p.heading + 540) % 360) - 180);
          if (g < gap) { gap = g; best = l.heading; }
        });
        return { id: data.location.pano, lat: data.location.latLng.lat(), lng: data.location.latLng.lng(), heading: (best + 360) % 360 };
      });
      job.catch(function (err) {
        if (!err || err.code !== 'ZERO_RESULTS') fail('streetview-service', err && (err.code || err.message), true);
      });
      return (looks[p.key] = job);
    }
    function setPano(spot) {
      if (cur === spot && (pano || dead)) return;
      cur = spot;
      setAt = performance.now();
      isLive = false;
      if (!pano) {
        hosts.pano.hidden = false;
        fresh = false;
        pano = new sv.StreetViewPanorama(hosts.pano, {
          pano: spot.id, pov: { heading: spot.heading, pitch: 0 }, zoom: 1,
          addressControl: false, showRoadLabels: false, /* both name the place */
          linksControl: true, clickToGo: true, panControl: false, zoomControl: false, fullscreenControl: false,
          enableCloseButton: false, motionTracking: false, motionTrackingControl: false, imageDateControl: false,
          scrollwheel: false
        });
        o.objects.panorama++;
        pano.addListener('status_changed', function () {
          status = pano.getStatus();
          fresh = true;
          okAt = performance.now();
          if (status !== 'OK') return fail('pano-status', status, false);
          setTimeout(function () { waiters.splice(0).forEach(function (f) { f(); }); }, 350); /* let the first tiles paint */
        });
        pano.addListener('pov_changed', function () {
          if (!isLive || drifting || told.look) return;
          var v = pano.getPov();
          if (Math.abs(((v.heading - base + 540) % 360) - 180) > 10 || Math.abs(v.pitch) > 8) { told.look = true; on.looked(); }
        });
        pano.addListener('pano_changed', function () {
          if (isLive && !told.walk && cur && pano.getPano() !== cur.id) { told.walk = true; on.walked(); }
        });
        w.addEventListener('resize', function () { if (pano) G.event.trigger(pano, 'resize'); });
        return;
      }
      pano.setPov({ heading: spot.heading, pitch: 0 });
      pano.setZoom(1);
      if (pano.getPano() === spot.id && status === 'OK') return; /* already there */
      fresh = false; /* the old OK is stale: wait for the next status_changed */
      pano.setPano(spot.id);
    }
    function panoOK() { return fresh && status === 'OK' && performance.now() - okAt > 350; }
    function whenPano() { /* resolves once the panorama is OK and settled; 8 s, then the photos */
      return new Promise(function (ok, no) {
        var done = false, t;
        function yes() { if (!done) { done = true; clearTimeout(t); ok(); } }
        if (fresh && status === 'OK') return setTimeout(yes, Math.max(0, 350 - (performance.now() - okAt)));
        waiters.push(yes);
        t = setTimeout(function () {
          if (done) return;
          done = true;
          fail('pano-timeout', '', true); /* quota has no callback: this watchdog is the only signal */
          no({ code: 'DEAD' });
        }, Math.max(1000, 8000 - (performance.now() - setAt)));
      });
    }
    function drape(yes) { /* the curtain: a full cover over picture and attribution, for cuts */
      hosts.curtain.hidden = false;
      void hosts.curtain.offsetWidth;
      hosts.curtain.setAttribute('data-on', yes ? '1' : '0');
      return wait(o.calm ? 0 : 240).then(function () { if (!yes) hosts.curtain.hidden = true; });
    }

    /* ── arriving ── */
    function arrive(p, how) {
      if (dead) return Promise.reject({ code: 'DEAD' });
      place = p;
      told = {};
      clearTimeout(lift);
      var late = new Promise(function (_, no) { setTimeout(function () { no({ code: 'TIMEOUT' }); }, 6000); });
      return Promise.race([find(p), late]).then(function (spot) {
        if (dead) throw { code: 'DEAD' };
        if (how === 'fly' && canFly() && !skipAsked) return fly(p, spot);
        return cut(spot);
      }, function (err) {
        if (err && err.code === 'TIMEOUT') fail('lookup-timeout', '', false);
        throw err;
      }).then(function () {
        skipAsked = false;
        if (appended) keep('gs-fly', 'ok'); /* the visitor reached a street: nothing died on the way */
        goLive();
        return { lat: cur.lat, lng: cur.lng };
      });
    }
    /* a flight needs a living map, flights left, and a globe that has been drawn (or is still to be, the first time) */
    function canFly() { return alive && flights > 0 && (earth || !pano); }
    function cut(spot, drop) { /* under the curtain; drop = the 3D map goes for good */
      on.phase('landing');
      return drape(true).then(function () {
        if (dead) throw { code: 'DEAD' };
        setPano(spot);
        return whenPano();
      }).then(function () {
        if (drop) retire(); else if (map) { showMap(false); park(900000); }
        on.title();
        return drape(false);
      });
    }
    function park(range) {
      /* A hidden map keeps loading tiles for the view it was left on. During a round it waits high above
         the country, a view the fall has already loaded; it comes down over the city only when the
         visitor answers, for the pull-up. */
      if (!map || parked === cur.id + range) return;
      parked = cur.id + range;
      try {
        map.stopCameraAnimation(); /* the dissolve starts before the fall has ended: a flight still running would carry the camera on down */
        map.flyCameraTo({ endCamera: above(cur, range), durationMillis: 0 });
      } catch (e) {}
    }
    function fly(p, spot) {
      var first = !pano, at = { lat: spot.lat, lng: spot.lng, altitude: p.alt };
      var stops = cam.way.map(function (s) {
        return { ms: s.ms, camera: { center: at, range: s.range, tilt: s.tilt, heading: s.turn == null ? 0 : (spot.heading + s.turn) % 360 } };
      });
      stops.push({ ms: cam.ms, camera: { center: at, range: cam.range, tilt: cam.tilt, heading: spot.heading } });
      return Promise.resolve().then(function () {
        if (dead) throw { code: 'DEAD' };
        if (skipAsked) return 'skipped';
        return new Promise(function (ok) {
          var timers = [], moving = 0, leg = 0, legAt = 0, from = 0, done = false, called = performance.now(), last = stops.length - 1;
          function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
          function finish(how) {
            if (done) return;
            done = true;
            note('flight:' + how + '+' + since(called) + (moving ? ',moved+' + Math.round(moving - called) : '') + ',leg=' + (leg + 1) + '/' + stops.length +
              ',range=' + Math.round(map.range) + ',tilt=' + Math.round(map.tilt || 0));
            flight = null;
            timers.forEach(clearTimeout);
            map.removeEventListener('gmp-animationend', ended);
            ok(how);
          }
          function begin(i) { /* leg i is under way */
            leg = i;
            legAt = performance.now();
            /* The panorama object is made only once the camera is coming down on the city in the first flight, so a
               visit that leaves early costs one load, not two. It needs most of a second to be ready for the dissolve. */
            if (first && i === last - 1) later(function () { setPano(spot); }, Math.max(0, stops[i].ms - 1300));
            later(function () { step(i); }, stops[i].ms + 1500); /* in case its end is never reported */
          }
          function step(i) { /* leg i is over: the next one, or the landing */
            if (done || leg !== i) return;
            if (i === last) return finish('ended');
            try { map.flyCameraTo({ endCamera: stops[i + 1].camera, durationMillis: stops[i + 1].ms }); } catch (e) { return finish('ended'); }
            begin(i + 1);
          }
          function ended() {
            /* only the end of our own leg counts: an animation stopped a moment ago can report here too */
            if (!done && moving && performance.now() - legAt > stops[leg].ms * 0.6) step(leg);
          }
          flight = {
            cancel: function () { finish('cancelled'); },
            skip: function () { finish('skipped'); },
            move: function () { /* the camera reports a change of range */
              if (!moving) {
                if (Math.abs(map.range - from) < from * 0.002) return;
                moving = performance.now();
                drawn('moved');
                on.phase('flying'); /* the words and the announcement wait for the camera to move */
                begin(0);
                if (o.lean) guard();
              }
              if (leg === last && map.range < cam.under && (map.tilt || 0) > cam.tilt - 11 && panoOK()) finish('under');
            }
          };
          function guard() { /* a phone that cannot hold the frame rate does not fly */
            var t0 = performance.now(), n = 0;
            requestAnimationFrame(function frame(t) {
              if (done) return;
              n++;
              if (t - t0 < 600) return requestAnimationFrame(frame);
              if ((t - t0) / n > 34) finish('slow');
            });
          }
          clearTimeout(lift);
          try { map.stopCameraAnimation(); } catch (e) {} /* a pull-up may still be running */
          from = map.range;
          top = Math.max(height(), cam.range * 2);
          parked = null;
          showMap(true);
          on.phase('globe'); /* waiting to fall: "Skip the fall" is offered until the camera lands */
          flights--;
          if (!first) setPano(spot); /* later flights: the same object gets its new place now, unseen under the map */
          map.addEventListener('gmp-animationend', ended);
          map.flyCameraTo({ endCamera: stops[0].camera, durationMillis: stops[0].ms });
          later(function () { if (!moving) finish('stalled'); }, first ? STALL_FIRST : STALL);
        });
      }).then(function (how) {
        if (dead || how === 'cancelled') throw { code: 'DEAD' };
        if (how === 'under' || how === 'ended' || how === 'timeout') {
          setPano(spot);
          return whenPano().then(function () { return dissolve(); });
        }
        /* skipped by the visitor, never started, or too slow for this device: straight to the street */
        try { map.stopCameraAnimation(); } catch (e) {}
        if (how === 'stalled') {
          stalls++;
          if (!o.streetAlone) { fail('flight-stalled', '', false); throw { code: 'DEAD' }; }
        }
        /* the map stays for later flights and pull-ups, except on phones, after a second stall, and when it
           has still drawn nothing */
        return cut(spot, o.lean || how === 'slow' || stalls > 1 || (how === 'stalled' && !earth));
      });
    }
    function dissolve() {
      /* the map fades out over the panorama: the mesh looks melted at eye level, so the last frame is never held */
      on.phase('landing');
      on.title();
      hosts.map.setAttribute('data-on', '0');
      return wait(o.calm ? 0 : 700).then(function () {
        if (dead) throw { code: 'DEAD' };
        showMap(false);
        if (o.lean) retire(); else park(900000);
      });
    }
    function goLive() {
      var h0 = pano.getPov().heading, t0 = performance.now();
      base = h0;
      isLive = true;
      if (o.calm) return;
      drifting = true; /* the view drifts 12 degrees and stops */
      function stop() { drifting = false; base = pano.getPov().heading; hosts.pano.removeEventListener('pointerdown', stop, true); }
      hosts.pano.addEventListener('pointerdown', stop, true);
      requestAnimationFrame(function step(t) {
        if (!drifting || dead || !isLive) return;
        var k = Math.min(1, (t - t0) / 1600);
        pano.setPov({ heading: h0 + 12 * (1 - Math.pow(1 - k, 3)), pitch: 0 });
        if (k < 1) requestAnimationFrame(step); else stop();
      });
    }

    /* ── after the answer: pull up and show where it was (desktop, while the map is alive) ── */
    function pin(right) {
      if (!map || !m3.Marker3DElement || !place) return;
      try {
        if (pins[place.key]) pins[place.key].remove(); /* one pin a place: a replay recolours it */
        var m = new m3.Marker3DElement({ position: { lat: cur.lat, lng: cur.lng, altitude: 0 }, altitudeMode: 'CLAMP_TO_GROUND', sizePreserved: true });
        var t = d.createElement('template');
        t.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="46" viewBox="0 0 36 46"><path d="M18 44C11 34 3 27 3 18a15 15 0 0 1 30 0c0 9-8 16-15 26Z" fill="' +
          (right ? '#35d07f' : '#ff5e4d') + '" stroke="#141311" stroke-width="3"/><circle cx="18" cy="18" r="5.5" fill="#141311"/></svg>';
        m.append(t);
        map.append(m);
        pins[place.key] = m;
      } catch (e) { note('pin-failed'); }
    }
    function reveal(p, right) {
      if (!dead && alive && earth && !o.lean && !o.calm) park(25000); /* unseen, straight above the city */
      return wait(900).then(function () {
        if (dead || !alive || !earth || o.lean || o.calm) return; /* a map that never drew is never shown */
        pin(right);
        showMap(true); /* Street View dissolves back to the map */
        /* the pull-up runs behind "Next place": nobody waits for it, and the next flight stops it */
        clearTimeout(lift);
        lift = setTimeout(function () {
          if (dead || !map || flight || !shown) return;
          parked = null;
          try { map.flyCameraTo({ endCamera: above(cur, 900000), durationMillis: 2400 }); } catch (e) {}
        }, 350);
      });
    }
    function over() {
      if (dead || !alive || !earth || o.lean || o.calm || !place) return;
      clearTimeout(lift);
      showMap(true);
      parked = null;
      try { map.flyCameraTo({ endCamera: globeCam(place), durationMillis: 2600 }); } catch (e) {}
    }

    return {
      ready: ready, arrive: arrive, reveal: reveal, over: over, end: end,
      prepare: function (p) { if (!dead && sv) find(p).catch(function () {}); },
      canFly: canFly,
      skip: function () { skipAsked = true; if (flight) flight.skip(); }
    };
  }

  w.GeoFly = { create: create };
})();

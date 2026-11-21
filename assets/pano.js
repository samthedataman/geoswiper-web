/* GeoSwiper — look-around viewer for 360° street photos. No dependencies.

   One full-canvas quad. For every pixel the fragment shader builds the ray a
   pinhole camera would see (yaw, pitch, field of view) and samples the
   equirectangular photo where that ray lands, so straight lines stay straight.

   A viewer always sits on a still image of the same view. The still is what
   is painted first, what stays if WebGL is missing, and what covers a change
   of place until that place's photo has arrived. The camera is fitted to the
   still the way object-fit:cover would fit it, so the two line up exactly.

   GeoPano.create(box, options) → viewer
     options.place      the first place: { slug, low }
     options.frame(p)   the still that stands in for place p in this box:
                        { src, w, h, vfov, yaw, pitch, alt }
     options.eager      fetch the first photo without waiting for the visitor
     options.drop       a new place drops in from above (default: cross-fade)
     options.keen       take the 4096 photo as soon as the visitor is here
                        (otherwise only once they take hold of this viewer)
     options.still      the box has no still in the page: add it when near
     options.speed      auto-pan, degrees a second
     options.label      accessible name once it can be steered
     options.onlive()   the photo is on screen and can be dragged
     options.ongrab()   the visitor took hold of it
   viewer.show(place, { turn, instant })   switch place
   viewer.warm(place)                      fetch a place's photo ahead of time
   viewer.nudge(dx, dy, ms)                move as a drag of dx,dy pixels would
   viewer.hold(yes)                        stop or allow the slow auto-pan
   viewer.live · viewer.yaw · viewer.pitch

   Until the visitor does something (moves, scrolls, taps, types) only the
   2048-pixel photos are fetched, and only by eager viewers. Small screens
   and devices whose MAX_TEXTURE_SIZE is under 4096 stay on 2048 throughout. */
(function () {
  'use strict';
  var w = window, d = document;
  var RAD = Math.PI / 180;
  var BASE = '/assets/panos/';
  var calm = w.matchMedia('(prefers-reduced-motion: reduce)');
  var net = navigator.connection || {};
  var viewers = [];

  /* ── Engagement ── */
  var engaged = false, waiting = [];
  var SIGNS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];
  function engage() {
    if (engaged) return;
    engaged = true;
    SIGNS.forEach(function (t) { w.removeEventListener(t, engage, true); });
    waiting.splice(0).forEach(function (fn) { fn(); });
  }
  SIGNS.forEach(function (t) { w.addEventListener(t, engage, { capture: true, passive: true }); });
  function whenEngaged(fn) { if (engaged) fn(); else waiting.push(fn); }

  /* ── Photos: fetched once, decoded off the main thread where the browser can ── */
  var jobs = {}, done = {};
  function fetchPhoto(url) {
    if (jobs[url]) return jobs[url];
    var p;
    if (w.createImageBitmap && w.fetch) {
      p = fetch(url).then(function (r) {
        if (!r.ok) throw new Error('photo ' + r.status);
        return r.blob();
      }).then(function (b) { return createImageBitmap(b); });
    } else {
      p = new Promise(function (ok, no) {
        var im = new Image();
        im.decoding = 'async';
        im.onload = function () { ok(im); };
        im.onerror = no;
        im.src = url;
      });
    }
    jobs[url] = p.then(function (bmp) { done[url] = bmp; return bmp; });
    jobs[url].catch(function () { delete jobs[url]; });
    return jobs[url];
  }
  function spend(url) { delete jobs[url]; delete done[url]; }

  function pause(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function settled(img) {
    if (img.decode) return img.decode().catch(function () {});
    return new Promise(function (ok) {
      if (img.complete) return ok();
      img.onload = img.onerror = function () { ok(); };
    });
  }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function land(t) { return 1 - Math.pow(1 - t, 4); }

  var VERT = 'attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.,1.);}';
  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec2 v;',
    'uniform sampler2D a,b;',          /* the photo on show, and the one arriving */
    'uniform vec2 t;',                 /* tan of half the field of view: across, up */
    'uniform vec4 ra,rb;',             /* each camera: sin yaw, cos yaw, sin pitch, cos pitch */
    'uniform float m,k;',              /* how far the change has got; 1 = drop in, 0 = cross-fade */
    'vec4 look(sampler2D s,vec2 q,vec4 r){',
    '  vec3 e=vec3(q.x*t.x,q.y*t.y,1.);',
    '  e=vec3(e.x,e.y*r.w+e.z*r.z,e.z*r.w-e.y*r.z);',
    '  e=vec3(e.x*r.y+e.z*r.x,e.y,e.z*r.y-e.x*r.x);',
    '  return texture2D(s,vec2(atan(e.x,e.z)*.15915494+.5,.5-asin(e.y/length(e))*.31830989));',
    '}',
    'void main(){',
    '  vec4 c=look(a,v,ra);',
    '  if(m>0.){',
    '    float edge=1.-2.*m;',
    '    if(k>.5){if(v.y>edge)c=look(b,vec2(v.x,v.y-edge-1.),rb);}',
    '    else c=mix(c,look(b,v,rb),m);',
    '  }',
    '  gl_FragColor=vec4(c.rgb,1.);',
    '}'
  ].join('\n');

  function create(box, o) {
    if (!box || !o || !o.place || !o.frame) return null;
    var place = o.place;
    var canvas = null, gl = null, U = {}, maxTex = 0;
    var live = false, dead = false, booted = false, loading = false;
    var keen = !!o.keen, sharp = '';
    var near = false, seen = false, running = false, held = false;
    var cur = null;                    /* { tex, slug, size } now on show */
    var chg = null;                    /* a change in flight: { tex, slug, size, t, ms, drop, cam } */
    var yaw = 0, pitch = 0, vyaw = 0, vpitch = 0;
    var tanH = 1, tanV = 1, focal = 300, loPitch = -30, hiPitch = 45;
    var cssW = 0, cssH = 0, scale = 1, slow = 0;
    var grab = null, glide = null, quiet = 1e4, drift = 0, last = 0, dirty = true;
    var seq = 0, raf = 0;

    function frameOf(p) { return o.frame(p); }

    /* Fit the camera to the still, the way object-fit:cover fits the still to the box. */
    function fit() {
      var f = frameOf(place), a0 = f.w / f.h, t0 = Math.tan(f.vfov * RAD / 2);
      var r = box.getBoundingClientRect();
      cssW = r.width; cssH = r.height;
      if (!cssW || !cssH) return;
      var a = cssW / cssH;
      tanV = a >= a0 ? t0 * a0 / a : t0;
      tanH = tanV * a;
      focal = cssH / 2 / tanV;
      var half = Math.atan(tanV) / RAD;
      loPitch = Math.min(f.pitch, Math.max(-30, (place.low == null ? -60 : place.low) + half));
      hiPitch = Math.max(f.pitch, Math.min(45, 88 - half));
    }
    function size() {
      if (!canvas || !cssW) return;
      var dpr = Math.min(w.devicePixelRatio || 1, 2);
      var s = Math.min(dpr, Math.sqrt(2600000 / (cssW * cssH))) * scale;
      var bw = Math.max(2, Math.round(cssW * s)), bh = Math.max(2, Math.round(cssH * s));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw; canvas.height = bh;
        gl.viewport(0, 0, bw, bh);
      }
      dirty = true;
    }
    function resized() {
      fit();
      if (!live) return;
      size();
      pitch = Math.max(loPitch, Math.min(hiPitch, pitch));
      draw();
    }

    /* Which file: the 4096 only on larger screens that can hold it, once the visitor is here,
       and only where the canvas has the pixels to show the difference. */
    function wanted() {
      var small = Math.min(screen.width, screen.height) < 600 || w.innerWidth < 700;
      if (!engaged || !keen || small || maxTex < 4096 || net.saveData) return 2048;
      var across = cssW * Math.min(w.devicePixelRatio || 1, 2);     /* canvas pixels across the view */
      return across * Math.PI / Math.atan(tanH) > 2700 ? 4096 : 2048;   /* …and so across the whole photo */
    }
    function urlOf(p, n) { return BASE + p.slug + '-' + n + '.webp'; }

    function setup() {
      canvas = d.createElement('canvas');
      canvas.className = 'pano-view';
      canvas.setAttribute('aria-hidden', 'true');
      var want = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
      try { gl = canvas.getContext('webgl', want) || canvas.getContext('experimental-webgl', want); } catch (e) { gl = null; }
      if (!gl) return false;
      function sh(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
      }
      var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
      if (!vs || !fs) return false;
      var pr = gl.createProgram();
      gl.attachShader(pr, vs); gl.attachShader(pr, fs);
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return false;
      gl.useProgram(pr);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var at = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      ['a', 'b', 't', 'ra', 'rb', 'm', 'k'].forEach(function (n) { U[n] = gl.getUniformLocation(pr, n); });
      gl.uniform1i(U.a, 0);
      gl.uniform1i(U.b, 1);
      maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        live = false; dead = true; stop();
        canvas.classList.remove('is-on');
        box.removeAttribute('data-live');
      });
      box.appendChild(canvas);
      return true;
    }
    function upload(bmp) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bmp);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);       /* the photo wraps round */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }
    function turnOf(c) {
      var y = c.yaw * RAD, p = c.pitch * RAD;
      return [Math.sin(y), Math.cos(y), Math.sin(p), Math.cos(p)];
    }
    function draw() {
      if (!gl || !cur) return;
      dirty = false;
      var me = turnOf({ yaw: yaw, pitch: pitch });
      gl.uniform2f(U.t, tanH, tanV);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      gl.activeTexture(gl.TEXTURE1);
      if (chg) {
        var was = chg.cam ? turnOf(chg.cam) : me;
        gl.bindTexture(gl.TEXTURE_2D, chg.tex);
        gl.uniform4f(U.ra, was[0], was[1], was[2], was[3]);
        gl.uniform4f(U.rb, me[0], me[1], me[2], me[3]);
        gl.uniform1f(U.m, chg.drop ? land(chg.t) : chg.t);
        gl.uniform1f(U.k, chg.drop ? 1 : 0);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, cur.tex);
        gl.uniform4f(U.ra, me[0], me[1], me[2], me[3]);
        gl.uniform1f(U.m, 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function finish() {
      if (!chg) return;
      if (cur.tex !== chg.tex) gl.deleteTexture(cur.tex);
      cur = { tex: chg.tex, slug: chg.slug, size: chg.size };
      chg = null;
      dirty = true;
      sharpen();
    }
    /* Bring a photo in over the one on show. cam: where the old one keeps looking (null = same view). */
    function change(tex, slug, n, ms, drop, cam) {
      finish();
      chg = { tex: tex, slug: slug, size: n, t: 0, ms: calm.matches ? 0 : ms, drop: drop, cam: cam };
      if (!chg.ms) finish();
      dirty = true;
      kick();
    }

    function tick(now) {
      raf = 0;
      if (!running) return;
      var dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      quiet += dt;
      var moving = false;
      if (chg) {
        chg.t = Math.min(1, chg.t + dt * 1000 / chg.ms);
        if (chg.cam && !held) chg.cam.yaw += drift * dt;
        if (chg.t >= 1) finish();
        moving = true;
      }
      if (glide) {
        glide.t = Math.min(1, glide.t + dt * 1000 / glide.ms);
        var e = ease(glide.t);
        yaw = glide.y0 + glide.dy * e;
        pitch = glide.p0 + glide.dp * e;
        if (glide.t >= 1) glide = null;
        quiet = 0;
        moving = true;
      } else if (!grab) {
        if (Math.abs(vyaw) > 0.4 || Math.abs(vpitch) > 0.4) {
          yaw += vyaw * dt; pitch += vpitch * dt;
          var fr = Math.exp(-5.6 * dt);              /* a short coast: about a sixth of a second's worth */
          vyaw *= fr; vpitch *= fr;
          quiet = 0;
          moving = true;
        }
        var goal = !held && !calm.matches && quiet > 3 ? (o.speed || 2.4) : 0;
        drift += (goal - drift) * Math.min(1, dt * 1.4);
        if (drift > 0.01) { yaw += drift * dt; moving = true; } else drift = 0;
      } else {
        quiet = 0;
        drift = 0;
      }
      pitch = Math.max(loPitch, Math.min(hiPitch, pitch));
      if (yaw > 360 || yaw < -360) yaw %= 360;
      if (moving || dirty) draw();
      /* too slow to keep up: draw fewer pixels */
      if (moving && scale > 0.5) {
        slow = dt > 0.036 ? slow + 1 : 0;
        if (slow > 24) { slow = 0; scale *= 0.75; size(); }
      }
      raf = w.requestAnimationFrame(tick);
    }
    function kick() {
      running = live && seen && !d.hidden;
      if (running && !raf) { last = w.performance.now(); raf = w.requestAnimationFrame(tick); }
    }
    function stop() { running = false; if (raf) w.cancelAnimationFrame(raf); raf = 0; }

    /* ── Stills ── */
    function swapStill(p, animate, hide) {
      var f = frameOf(p), job = seq;
      var img = new Image();
      img.width = f.w; img.height = f.h;
      img.alt = f.alt || '';
      img.className = 'pano-still';
      img.decoding = 'async';
      img.draggable = false;
      img.style.setProperty('--ar', (f.w / f.h).toFixed(4));
      img.src = f.src;
      return settled(img).then(function () {
        if (job !== seq) return false;
        var kind = animate && !calm.matches ? (o.drop ? 'is-drop' : 'is-fade') : '';
        if (kind) img.classList.add('is-over', kind);
        box.insertBefore(img, canvas && canvas.parentNode === box ? canvas : null);
        return pause(kind ? (o.drop ? 820 : 620) : 0).then(function () {
          if (job !== seq) return false;
          [].forEach.call(box.querySelectorAll('.pano-still'), function (s) {
            if (s !== img) (s.parentNode.nodeName === 'PICTURE' ? s.parentNode : s).remove();
          });
          if (hide && canvas) {                      /* the canvas still shows the last place: clear it at once, unseen */
            canvas.style.transition = 'none';
            canvas.classList.remove('is-on');
            void canvas.offsetWidth;
            canvas.style.transition = '';
          }
          img.classList.remove('is-over', 'is-drop', 'is-fade');
          return true;
        });
      });
    }

    /* ── Start: only when the box is near the screen, and never before first paint ── */
    function boot() {
      if (booted || dead || !near) return;
      if ((!o.eager || net.saveData) && !engaged) return;
      booted = true;
      if (!setup()) {
        dead = true;
        if (canvas && canvas.parentNode) canvas.remove();
        canvas = gl = null;
        return;
      }
      first();
    }
    function first() {
      if (loading || live || dead) return;
      fit();
      var p = place, n = wanted(), url = urlOf(p, n);
      loading = true;
      fetchPhoto(url).then(function (bmp) {
        loading = false;
        if (dead) return;
        if (p !== place) return first();             /* the place changed while this one loaded */
        spend(url);
        var f = frameOf(p);
        cur = { tex: upload(bmp), slug: p.slug, size: n };
        yaw = f.yaw; pitch = f.pitch;
        live = true;
        fit(); size(); draw();
        canvas.classList.add('is-on');
        box.setAttribute('data-live', '');
        box.tabIndex = 0;
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', o.label || '360° street photo. Drag, or use the arrow keys, to look around.');
        quiet = 2;
        kick();
        if (o.onlive) o.onlive();
        sharpen();
      }).catch(function () { loading = false; });
    }
    /* Swap the 2048 photo for the 4096 one in place, once it is worth it. */
    function sharpen() {
      if (!live || chg || !cur || cur.size >= 4096 || wanted() < 4096) return;
      var p = place, url = urlOf(p, 4096);
      if (sharp === url || cur.slug !== p.slug) return;
      sharp = url;
      fetchPhoto(url).then(function (bmp) {
        sharp = '';
        if (!live || place !== p || cur.slug !== p.slug || cur.size >= 4096) return;
        spend(url);
        change(upload(bmp), p.slug, 4096, 500, false, null);
      }).catch(function () { sharp = ''; });
    }

    function show(p, opt) {
      opt = opt || {};
      var job = ++seq, f = frameOf(p);
      place = p;
      fit();
      if (!live) { swapStill(p, !opt.instant); return; }   /* stills only, or the first photo is still on its way */
      finish();
      var first = { yaw: f.yaw + (opt.turn || 0), pitch: f.pitch };
      var n = wanted(), url = urlOf(p, n);
      var same = cur.slug === p.slug;
      if (!same && !done[url] && n > 2048 && done[urlOf(p, 2048)]) { n = 2048; url = urlOf(p, n); }
      if (same || done[url]) {
        var tex = same ? cur.tex : upload(done[url]);
        if (!same) spend(url);
        var was = { yaw: yaw, pitch: pitch };
        vyaw = vpitch = 0; glide = null;
        yaw = first.yaw; pitch = first.pitch;
        change(tex, p.slug, same ? cur.size : n, opt.instant ? 0 : (o.drop ? 800 : 700), !!o.drop, was);
        swapStill(p, false);
        return;
      }
      /* Not here yet: cover with its still, then bring the photo in behind it. */
      var photo = fetchPhoto(url);
      photo.catch(function () {});
      swapStill(p, !opt.instant, true).then(function (ok) {
        if (!ok || job !== seq || !live) return;
        photo.then(function (bmp) {
          if (job !== seq || !live) return;
          spend(url);
          finish();
          gl.deleteTexture(cur.tex);
          cur = { tex: upload(bmp), slug: p.slug, size: n };
          vyaw = vpitch = 0; glide = null;
          yaw = first.yaw; pitch = first.pitch;
          draw();
          canvas.classList.add('is-on');
          kick();
          sharpen();
        }).catch(function () {});
      });
    }
    function warm(p) {
      if (!p || (cur && cur.slug === p.slug)) return;
      new Image().src = frameOf(p).src;              /* its still too, for the handover */
      if (live) fetchPhoto(urlOf(p, wanted())).catch(function () {});
    }
    function nudge(dx, dy, ms) {
      if (!live) return;
      vyaw = vpitch = 0;
      glide = { t: 0, ms: Math.max(1, ms || 600), y0: yaw, p0: pitch, dy: -dx / focal / RAD, dp: dy / focal / RAD };
      kick();
    }

    /* ── Hands on ── */
    box.addEventListener('pointerdown', function (e) {
      if (!live || e.button) return;
      grab = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, far: 0 };
      vyaw = vpitch = 0; glide = null;
      try { box.setPointerCapture(e.pointerId); } catch (err) {}
      box.classList.add('is-held');
      if (!keen) { keen = true; engage(); sharpen(); }
    });
    box.addEventListener('pointermove', function (e) {
      if (!grab || e.pointerId !== grab.id) return;
      var dx = e.clientX - grab.x, dy = e.clientY - grab.y;
      var dt = Math.max(1, e.timeStamp - grab.t) / 1000;
      var by = -dx / focal / RAD, bp = dy / focal / RAD;
      yaw += by; pitch += bp;
      vyaw = vyaw * 0.4 + by / dt * 0.6;
      vpitch = vpitch * 0.4 + bp / dt * 0.6;
      grab.x = e.clientX; grab.y = e.clientY; grab.t = e.timeStamp;
      grab.far += Math.abs(dx) + Math.abs(dy);
      if (grab.far > 4 && !grab.told) { grab.told = true; if (o.ongrab) o.ongrab(); }
      dirty = true;
    });
    function letGo(e) {
      if (!grab || e.pointerId !== grab.id) return;
      /* no coasting after a pause, or when motion is unwelcome */
      if (calm.matches || e.timeStamp - grab.t > 90 || e.type === 'pointercancel') vyaw = vpitch = 0;
      vyaw = Math.max(-180, Math.min(180, vyaw));
      vpitch = Math.max(-80, Math.min(80, vpitch));
      grab = null;
      box.classList.remove('is-held');
    }
    box.addEventListener('pointerup', letGo);
    box.addEventListener('pointercancel', letGo);
    box.addEventListener('keydown', function (e) {
      if (!live || e.target !== box) return;
      var step = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, 7], ArrowDown: [0, -7] }[e.key];
      if (!step) return;
      e.preventDefault();
      vyaw = vpitch = 0;
      var y0 = glide ? glide.y0 + glide.dy : yaw, p0 = glide ? glide.p0 + glide.dp : pitch;
      glide = { t: 0, ms: calm.matches ? 1 : 260, y0: yaw, p0: pitch, dy: y0 + step[0] - yaw, dp: Math.max(loPitch, Math.min(hiPitch, p0 + step[1])) - pitch };
      if (o.ongrab) o.ongrab();
      kick();
    });

    /* ── Watching the box ── */
    if ('ResizeObserver' in w) new ResizeObserver(resized).observe(box);
    w.addEventListener('resize', resized);
    /* a move to a screen with another pixel ratio does not always resize anything */
    (function dpr() {
      if (!w.matchMedia) return;
      var q = w.matchMedia('(resolution: ' + (w.devicePixelRatio || 1) + 'dppx)');
      function moved() {
        if (q.removeEventListener) q.removeEventListener('change', moved); else q.removeListener(moved);
        resized();
        dpr();
      }
      if (q.addEventListener) q.addEventListener('change', moved); else if (q.addListener) q.addListener(moved);
    })();
    d.addEventListener('visibilitychange', function () { if (d.hidden) stop(); else kick(); });
    function watch() {
      if (!('IntersectionObserver' in w)) { near = seen = true; return boot(); }
      new IntersectionObserver(function (en) {
        near = en[0].isIntersecting;
        if (near && o.still && !box.querySelector('.pano-still')) swapStill(place, false);
        boot();
      }, { rootMargin: '320px 0px' }).observe(box);
      new IntersectionObserver(function (en) {
        seen = en[0].isIntersecting;
        if (seen) kick(); else stop();
      }).observe(box);
    }
    function begin() { setTimeout(watch, 40); }
    if (d.readyState === 'complete') begin(); else w.addEventListener('load', begin);
    whenEngaged(function () { boot(); sharpen(); });

    var api = {
      show: show,
      warm: warm,
      nudge: nudge,
      hold: function (yes) { held = !!yes; if (!held) quiet = 3; kick(); }
    };
    Object.defineProperties(api, {
      live: { get: function () { return live; } },
      yaw: { get: function () { return yaw; } },
      pitch: { get: function () { return pitch; } },
      photo: { get: function () { return cur ? cur.slug + '-' + cur.size : ''; } }
    });
    viewers.push(api);
    return api;
  }

  w.GeoPano = { create: create, whenEngaged: whenEngaged, views: viewers };
  Object.defineProperty(w.GeoPano, 'engaged', { get: function () { return engaged; } });
})();

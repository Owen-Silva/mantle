/* unfold-page.js - the full-screen unfold overlay page (lib/features/unfold.js; wave unfold, 2026-10-23).
 *
 * Main drives it with `unfold.cmd` {op, seq, ...} (ctx.push) and the page answers every op ONCE through
 * window.mantle.call('unfold.page', {seq, display, event, ...}):
 *
 *   arm      the unlit display: opaque black, nothing else. Put up while the screen is off or locked,
 *            so the first thing seen after an unlock is the screen opening, never the desktop
 *            flashing and then the effect.                                          -> 'armed'
 *   play     {still, size}  the unfold over the desktop's picture, then a dissolve into the live
 *            screen; still null (no picture, or reduced motion) = a short fade out of the black.
 *                                                                                   -> 'played'
 *   cover    {still}  the picture, sharp (so the cover's first frame IS the live screen), then folded
 *            into blur over --unfold-fold-ms.                                       -> 'covered'
 *   reveal   from wherever it is, unfold back into focus and dissolve into the live screen, fast.
 *                                                                                   -> 'revealed'
 *   finish   input arrived: whatever is playing jumps to a 90 ms fade out.          -> 'finished'
 *   skip     the picture did not come: the black fades out (no effect).             -> 'skipped'
 *   park     drop the pictures (memory) and hide everything.                        -> 'parked'
 *
 * Every animated op ends on a timer too (its duration + 400 ms), so a page that gets no frames (hidden
 * window, GPU stall) can never leave the screen covered: the end pose is set by hand.
 *
 * TECHNIQUE (the numbers are in lib/features/unfold.js "MEASURED"): only transform and opacity move,
 * as Web Animations with sampled keyframes (the compositor runs them; a busy page cannot stutter
 * them). Blur is never animated: the picture is blurred ONCE into small canvases (a quarter, an
 * eighth) and the focus pull is a cross-fade between those and the sharp picture.
 *
 * TEST: window.__unfold = { state(), stats(), cmd(op) } (always there, costs nothing).
 * BENCH: index.html?bench=layers|css&runs=N plays N full unfolds over a drawn desktop and leaves the
 * frame pacing in window.__bench (ui/unfold/pace.js reads it in a hidden Electron window). */
(function () {
  'use strict';

  var Q = new URLSearchParams(location.search);
  var DISPLAY = Q.get('display') || '0';
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), ground = $('ground'), tint = $('tint'), leaf = $('leaf'), leafIn = $('leaf-in'),
      sharp = $('sharp'), soft = $('soft'), smear = $('smear'), sheenL = $('sheen-l'), sheenR = $('sheen-r');
  var LAYERS = [stage, ground, tint, leaf, leafIn, sharp, soft, smear, sheenL, sheenR];

  var SEAM = 0.006;        // the opening starts as a hairline (0.6 % of the width)
  var OPEN_END = 0.80;     // the opening lands at 80 % of the time; the rest is focus and the hand-over
  var HANDOVER = 0.74;     // from here the stage dissolves into the live screen
  var COVER_TINT = 0.55;   // how much of the glass tint the covered screen wears
  var HARD_PAD = 400;      // every animated op ends by its duration + this, frames or not

  var S = { pose: 'parked', seq: 0, op: null, anims: [], hard: null, still: false, stillW: 0, stillH: 0,
    lastStats: null, runs: 0, errors: [] };

  /* ---- tokens and curves --------------------------------------------------------------------- */

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function ms(name, dflt) {
    var v = cssVar(name), n = parseFloat(v);
    if (!isFinite(n)) return dflt;
    return /ms$/.test(v) ? n : (/s$/.test(v) ? n * 1000 : n);
  }
  function num(name, dflt) { var n = parseFloat(cssVar(name)); return isFinite(n) ? n : dflt; }
  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function bezier(x1, y1, x2, y2) {
    function at(a1, a2, t) { var u = 1 - t; return 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t; }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var lo = 0, hi = 1, t = x;
      for (var i = 0; i < 28; i++) { var v = at(x1, x2, t); if (Math.abs(v - x) < 1e-5) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
      return at(y1, y2, t);
    };
  }
  /** a CSS easing value (cubic-bezier(...) or linear(...) with evenly spaced stops) as a function */
  function easing(text, fallback) {
    var m = /cubic-bezier\(([^)]*)\)/.exec(text || '');
    if (m) {
      var p = m[1].split(',').map(parseFloat);
      if (p.length === 4 && p.every(isFinite)) return bezier(p[0], p[1], p[2], p[3]);
    }
    m = /linear\(([^)]*)\)/.exec(text || '');
    if (m) {
      var pts = m[1].split(',').map(function (s) { return parseFloat(s); }).filter(isFinite);
      if (pts.length >= 2) {
        return function (x) {
          if (x <= 0) return pts[0];
          if (x >= 1) return pts[pts.length - 1];
          var f = x * (pts.length - 1), i = Math.floor(f);
          return pts[i] + (pts[i + 1] - pts[i]) * (f - i);
        };
      }
    }
    return fallback;
  }
  var E = {};
  function curves() {
    E.spring = easing(cssVar('--unfold-in'), bezier(0.2, 0.9, 0.25, 1));
    E.fadeIn = easing(cssVar('--m-fade-in'), bezier(0.2, 0, 0, 1));
    E.fadeOut = easing(cssVar('--m-fade-out'), bezier(0.4, 0, 1, 1));
  }
  function clamp(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function span(t, a, b) { return clamp((t - a) / (b - a)); }

  /* ---- the picture: decoded once, blurred once into small canvases -------------------------- */

  function decode(url) {
    var img = new Image();
    img.decoding = 'async';
    img.src = url;
    return (img.decode ? img.decode() : new Promise(function (res, rej) { img.onload = res; img.onerror = rej; }))
      .then(function () { return img; });
  }

  /** `img` drawn into `out` at cw x ch, blurred by blurPx (canvas pixels) and smeared sideways by
   * smearPx. The edges are extended before blurring, so the blur never pulls in the transparent
   * outside (which would show the black stage as a dark rim). */
  function blurInto(out, img, cw, ch, blurPx, smearPx) {
    var pad = Math.ceil(blurPx * 2.5 + smearPx + 2);
    var src = document.createElement('canvas');
    src.width = cw + pad * 2; src.height = ch + pad * 2;
    var g = src.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(img, pad, pad, cw, ch);
    g.drawImage(src, pad, pad, 1, ch, 0, pad, pad, ch);
    g.drawImage(src, pad + cw - 1, pad, 1, ch, pad + cw, pad, pad, ch);
    g.drawImage(src, 0, pad, src.width, 1, 0, 0, src.width, pad);
    g.drawImage(src, 0, pad + ch - 1, src.width, 1, 0, pad + ch, src.width, pad);
    out.width = cw; out.height = ch;
    var o = out.getContext('2d');
    o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high';
    o.filter = blurPx > 0 ? 'blur(' + blurPx.toFixed(2) + 'px)' : 'none';
    var k = smearPx > 0 ? 7 : 1;
    for (var i = 0; i < k; i++) {
      var dx = k === 1 ? 0 : smearPx * (i / (k - 1) * 2 - 1);
      o.globalAlpha = 1 / (i + 1);   // a running average: every copy weighs the same
      o.drawImage(src, -pad + dx, -pad);
    }
    o.globalAlpha = 1;
    o.filter = 'none';
  }

  function prepare(url) {
    var t0 = performance.now();
    return decode(url).then(function (img) {
      var W = img.naturalWidth, H = img.naturalHeight;
      var dpr = W / Math.max(1, innerWidth);           // the picture is at the screen's own pixels
      sharp.src = img.src;
      var fullBlur = num('--unfold-full-blur', 18) * dpr, coverBlur = num('--unfold-cover-blur', 28) * dpr;
      var stretch = num('--unfold-full-stretch', 1.06);
      blurInto(soft, img, Math.round(W / 4), Math.round(H / 4), fullBlur / 4, 0);
      blurInto(smear, img, Math.round(W / 8), Math.round(H / 8), fullBlur / 16, (stretch - 1) * W / 2 / 8);
      blurInto(ground, img, Math.round(W / 8), Math.round(H / 8), coverBlur / 8, 0);
      S.still = true; S.stillW = W; S.stillH = H;
      return sharp.decode ? sharp.decode().catch(function () {}) : null;
    }).then(function () { return Math.round(performance.now() - t0); });
  }

  function drop() {
    sharp.removeAttribute('src');
    [soft, smear, ground].forEach(function (c) { c.width = 1; c.height = 1; });
    S.still = false; S.stillW = S.stillH = 0;
  }

  /* ---- running a timeline -------------------------------------------------------------------- */

  function stopAnims(keep) {
    S.anims.forEach(function (a) {
      try { if (keep) a.commitStyles(); } catch (_) { /* a removed element: nothing to keep */ }
      try { a.cancel(); } catch (_) { /* gone */ }
    });
    S.anims = [];
    if (S.hard) { clearTimeout(S.hard); S.hard = null; }
  }

  function set(el, v) { if ('opacity' in v) el.style.opacity = String(v.opacity); if ('transform' in v) el.style.transform = v.transform; }

  /** pose by hand (no animation): every layer's values at once */
  function pose(name, values) {
    stopAnims(false);
    LAYERS.forEach(function (el) { el.style.opacity = ''; el.style.transform = ''; });
    for (var i = 0; i < values.length; i++) set(values[i][0], values[i][1]);
    stage.setAttribute('data-pose', name);
    S.pose = name;
  }

  /** frame pacing of one run, read off requestAnimationFrame */
  function pacer() {
    var deltas = [], last = 0, on = true;
    function tick(now) { if (!on) return; if (last) deltas.push(now - last); last = now; requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
    return function stop() {
      on = false;
      var s = deltas.slice().sort(function (a, b) { return a - b; });
      var q = function (p) { return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
      var vsync = s.length ? s[Math.floor(s.length / 2)] : 16.7;
      if (!(vsync > 4 && vsync < 40)) vsync = 16.7;
      var dropped = 0, long = 0;
      deltas.forEach(function (d) { if (d > vsync * 1.5) { long++; dropped += Math.max(1, Math.round(d / vsync) - 1); } });
      return { frames: deltas.length, p50: q(0.5), p95: q(0.95), max: s.length ? +s[s.length - 1].toFixed(1) : null,
        vsync: +vsync.toFixed(2), long: long, dropped: dropped };
    };
  }

  /** animate `tracks` ([el, fn(t) -> {opacity?, transform?}]) over D ms; resolves {timedOut} */
  function run(name, D, tracks, endPose) {
    stopAnims(false);
    stage.setAttribute('data-pose', name);
    S.pose = name;
    var n = Math.max(8, Math.min(90, Math.round(D / 10)));
    var stop = pacer();
    var anims = tracks.map(function (tr) {
      var frames = [];
      for (var i = 0; i <= n; i++) { var t = i / n, v = tr[1](t), f = { offset: t }; if ('opacity' in v) f.opacity = v.opacity; if ('transform' in v) f.transform = v.transform; frames.push(f); }
      return tr[0].animate(frames, { duration: D, easing: 'linear', fill: 'forwards' });
    });
    S.anims = anims;
    return new Promise(function (resolve) {
      var done = false;
      function end(timedOut) {
        if (done) return;
        done = true;
        if (S.hard) { clearTimeout(S.hard); S.hard = null; }
        var stats = stop();
        // the end pose by hand: a missed frame can never leave a half-open screen
        if (S.anims === anims) {
          anims.forEach(function (a) { try { a.commitStyles(); } catch (_) { /* gone */ } try { a.cancel(); } catch (_) { /* gone */ } });
          S.anims = [];
          if (endPose) endPose.forEach(function (p) { set(p[0], p[1]); });
        }
        stats.ms = D;
        S.lastStats = stats;
        resolve({ timedOut: !!timedOut, stats: stats, cancelled: S.anims !== anims && !!S.anims.length });
      }
      S.hard = setTimeout(function () { end(true); }, D + HARD_PAD);
      Promise.all(anims.map(function (a) { return a.finished.catch(function () { return null; }); })).then(function () { end(false); });
    });
  }

  function now(el) { var v = parseFloat(getComputedStyle(el).opacity); return isFinite(v) ? v : 0; }

  /* ---- the timelines ------------------------------------------------------------------------- */

  function unfoldTracks(D) {
    var W = innerWidth;
    var stretch = num('--unfold-full-stretch', 1.06);
    var open = function (t) { return E.spring(clamp(t / OPEN_END)); };
    var p = function (t) { return SEAM + (1 - SEAM) * open(t); };
    var sheenOp = function (t) { return E.fadeIn(span(t, 0, 0.1)) * (1 - E.fadeIn(span(t, 0.42, 0.84))); };
    return [
      [stage, function (t) { return { opacity: 1 - E.fadeOut(span(t, HANDOVER, 1)) }; }],
      [ground, function (t) { return { opacity: E.fadeIn(span(t, 0, 0.22)) }; }],
      [tint, function (t) { return { opacity: E.fadeIn(span(t, 0, 0.22)) }; }],
      [leaf, function (t) { return { transform: 'scaleX(' + p(t).toFixed(5) + ')' }; }],
      [leafIn, function (t) { return { transform: 'scaleX(' + (1 / p(t)).toFixed(5) + ')' }; }],
      [smear, function (t) { return { opacity: 0.85 * (1 - E.fadeIn(span(t, 0, 0.5))), transform: 'scaleX(' + (1 + (stretch - 1) * (1 - open(t))).toFixed(5) + ')' }; }],
      [soft, function (t) { return { opacity: 1 - E.fadeIn(span(t, 0.08, 0.86)), transform: 'scaleX(' + (1 + (stretch - 1) * 0.5 * (1 - open(t))).toFixed(5) + ')' }; }],
      [sheenL, function (t) { return { opacity: sheenOp(t), transform: 'translateX(' + (-p(t) * W / 2).toFixed(1) + 'px)' }; }],
      [sheenR, function (t) { return { opacity: sheenOp(t), transform: 'translateX(' + (p(t) * W / 2).toFixed(1) + 'px)' }; }],
    ];
  }

  function coverTracks() {
    var stretch = 1 + (num('--unfold-full-stretch', 1.06) - 1) * 0.5;
    return [
      [soft, function (t) { return { opacity: E.fadeIn(span(t, 0, 0.7)), transform: 'scaleX(' + (1 + (stretch - 1) * E.fadeIn(t)).toFixed(5) + ')' }; }],
      [ground, function (t) { return { opacity: E.fadeIn(span(t, 0.25, 1)), transform: 'scaleX(' + (1 + (stretch - 1) * E.fadeIn(t)).toFixed(5) + ')' }; }],
      [tint, function (t) { return { opacity: COVER_TINT * E.fadeIn(span(t, 0.25, 1)) }; }],
    ];
  }

  function revealTracks() {
    var g0 = now(ground), s0 = now(soft), t0 = now(tint), st0 = now(stage);
    return [
      [ground, function (t) { return { opacity: g0 * (1 - E.fadeIn(span(t, 0, 0.6))), transform: 'none' }; }],
      [soft, function (t) { return { opacity: s0 * (1 - E.fadeIn(span(t, 0.1, 0.9))), transform: 'none' }; }],
      [tint, function (t) { return { opacity: t0 * (1 - E.fadeIn(span(t, 0, 0.6))) }; }],
      [stage, function (t) { return { opacity: st0 * (1 - E.fadeIn(span(t, 0.3, 1))) }; }],
    ];
  }

  var OPEN_SHARP = [[leaf, { transform: 'scaleX(1)' }], [leafIn, { transform: 'scaleX(1)' }]];
  var GONE = [[stage, { opacity: 0 }]];

  /* ---- ops ----------------------------------------------------------------------------------- */

  function tell(seq, event, extra) {
    var msg = { seq: seq, display: DISPLAY, event: event, pose: S.pose };
    if (extra) for (var k in extra) msg[k] = extra[k];
    if (window.__unfoldTold) window.__unfoldTold.push(msg);
    try {
      if (window.mantle && window.mantle.call) return Promise.resolve(window.mantle.call('unfold.page', msg)).catch(function () {});
    } catch (_) { /* main is gone: the hard timers still end everything */ }
    return Promise.resolve();
  }

  /** two frames with every layer drawn at a level black hides, so the first moving frame does not
   * also pay for uploading the textures */
  function warm() {
    pose('warming', [[stage, { opacity: 1 }], [ground, { opacity: 0.004 }], [soft, { opacity: 0.004 }], [smear, { opacity: 0.004 }]]);
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  }

  function fadeOut(name, D, seq, event, extra) {
    var st0 = now(stage);
    return run(name, D, [[stage, function (t) { return { opacity: st0 * (1 - E.fadeOut(t)) }; }]], GONE).then(function (r) {
      S.pose = 'gone'; stage.setAttribute('data-pose', 'gone');
      return tell(seq, event, Object.assign({ stats: r.stats, timedOut: r.timedOut }, extra || {}));
    });
  }

  var ops = {
    arm: function (c) {
      pose('armed', [[stage, { opacity: 1 }]]);
      return tell(c.seq, 'armed');
    },
    play: function (c) {
      var D = ms('--unfold-' + (c.size || 'full') + '-ms', 700);
      if (!c.still || reduced() || c.reduced) return fadeOut('fading', 160, c.seq, 'played', { technique: 'fade', reduced: reduced() || !!c.reduced });
      var prepMs = 0;
      return prepare(c.still).then(function (m) { prepMs = m; return warm(); }).then(function () {
        if (S.op !== c) return null;   // finish/skip came while the picture was decoding
        if (c.tech === 'css') return cssPlay(D);
        pose('opening', [[stage, { opacity: 1 }], [soft, { opacity: 1 }], [smear, { opacity: 0.85 }],
          [leaf, { transform: 'scaleX(' + SEAM + ')' }], [leafIn, { transform: 'scaleX(' + (1 / SEAM) + ')' }]]);
        return run('opening', D, unfoldTracks(D), GONE);
      }).then(function (r) {
        if (!r) return null;
        S.pose = 'gone'; stage.setAttribute('data-pose', 'gone');
        S.runs++;
        return tell(c.seq, 'played', { stats: r.stats, timedOut: r.timedOut, prepMs: prepMs, technique: c.tech === 'css' ? 'css' : 'layers', still: [S.stillW, S.stillH] });
      }, function (err) {
        S.errors.push(String(err && err.message || err));
        return fadeOut('fading', 160, c.seq, 'played', { technique: 'fade', error: 'the desktop picture could not be shown (' + (err && err.message || err) + ')' });
      });
    },
    cover: function (c) {
      var F = ms('--unfold-fold-ms', 420);
      if (!c.still) return tell(c.seq, 'covered', { ok: false, error: 'no picture of the screen came' });
      var prepMs = 0;
      return prepare(c.still).then(function (m) {
        prepMs = m;
        if (S.op !== c) return null;
        pose('covering', [[stage, { opacity: 1 }]].concat(OPEN_SHARP));
        if (reduced()) return run('covering', 120, [[ground, function (t) { return { opacity: t }; }], [tint, function (t) { return { opacity: COVER_TINT * t }; }]], null);
        return run('covering', F, coverTracks(), null);
      }).then(function (r) {
        if (!r) return null;
        S.pose = 'covered'; stage.setAttribute('data-pose', 'covered');
        return tell(c.seq, 'covered', { ok: true, stats: r.stats, timedOut: r.timedOut, prepMs: prepMs });
      }, function (err) {
        return fadeOut('fading', 120, c.seq, 'covered', { ok: false, error: 'the screen picture could not be shown (' + (err && err.message || err) + ')' });
      });
    },
    reveal: function (c) {
      var R = reduced() ? 120 : (c.ms || ms('--unfold-reveal-ms', 200));
      if (S.pose === 'gone' || S.pose === 'parked') return tell(c.seq, 'revealed', { already: true });
      return run('revealing', R, revealTracks(), GONE).then(function (r) {
        S.pose = 'gone'; stage.setAttribute('data-pose', 'gone');
        return tell(c.seq, 'revealed', { stats: r.stats, timedOut: r.timedOut });
      });
    },
    finish: function (c) { return fadeOut('finishing', 90, c.seq, 'finished'); },
    skip: function (c) { return fadeOut('fading', 160, c.seq, 'skipped', { reason: c.reason || null }); },
    park: function (c) {
      pose('parked', [[stage, { opacity: 0 }]]);
      drop();
      return tell(c.seq, 'parked');
    },
  };

  /** the CSS technique, kept only for the bench (the contract's .unfold on one full-screen picture) */
  function cssPlay(D) {
    pose('opening', [[stage, { opacity: 1 }]]);
    var img = $('css-still');
    if (!img) { img = document.createElement('img'); img.id = 'css-still'; img.className = 'layer'; stage.appendChild(img); }
    img.src = sharp.src;
    window.MantleUnfold.rest(img, { state: 'folded', size: 'full' });
    var stop = pacer();
    return window.MantleUnfold.open(img, { size: 'full' }).then(function (r) {
      var stats = stop(); stats.ms = D;
      S.lastStats = stats;
      img.remove();
      pose('gone', GONE);
      return { timedOut: r.timedOut, stats: stats };
    });
  }

  function cmd(c) {
    if (!c || typeof c.op !== 'string' || !ops[c.op]) return Promise.resolve(tell(c && c.seq, 'error', { error: 'unknown op ' + (c && c.op) }));
    S.seq = c.seq; S.op = c;
    curves();
    try { return ops[c.op](c); } catch (err) {
      pose('gone', GONE);
      return tell(c.seq, 'error', { error: String(err && err.message || err) });
    }
  }

  window.__unfold = {
    state: function () {
      return { pose: S.pose, seq: S.seq, still: S.still, stillW: S.stillW, stillH: S.stillH, running: S.anims.length,
        stage: now(stage), runs: S.runs, errors: S.errors.slice(-5), reduced: reduced(), theme: document.documentElement.dataset.theme || 'light' };
    },
    stats: function () { return S.lastStats; },
    cmd: cmd,
  };

  if (window.mantle && window.mantle.on) window.mantle.on('unfold.cmd', cmd);
  curves();
  pose('parked', [[stage, { opacity: 0 }]]);
  tell(0, 'ready');

  /* ---- bench ---------------------------------------------------------------------------------- */

  /** a desktop-like picture at the screen's pixels: wallpaper, a few windows, lines of text */
  function drawnDesktop() {
    var dpr = window.devicePixelRatio || 1, W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d');
    var bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#5d6f8c'); bg.addColorStop(0.55, '#a7a19a'); bg.addColorStop(1, '#3f4a3a');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    for (var i = 0; i < 40; i++) { g.fillStyle = 'rgba(255,255,255,' + (0.03 + (i % 5) * 0.02) + ')'; g.beginPath(); g.arc((i * 397) % W, (i * 211) % H, 40 + (i * 37) % 180, 0, 7); g.fill(); }
    var wins = [[0.08, 0.1, 0.5, 0.62, '#f7f7f8'], [0.45, 0.22, 0.47, 0.6, '#1f2226'], [0.2, 0.55, 0.3, 0.3, '#ffffff']];
    wins.forEach(function (w, k) {
      var x = w[0] * W, y = w[1] * H, ww = w[2] * W, hh = w[3] * H;
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x + 6, y + 10, ww, hh);
      g.fillStyle = w[4]; g.fillRect(x, y, ww, hh);
      g.fillStyle = k === 1 ? '#d6d6d6' : '#24272c';
      g.font = Math.round(13 * dpr) + 'px "Segoe UI", sans-serif';
      for (var l = 0; l < hh / (20 * dpr) - 2; l++) g.fillText('The quick brown fox jumps over the lazy dog ' + (l * 7919 % 1000), x + 16 * dpr, y + (40 + l * 20) * dpr);
    });
    return c.toDataURL('image/png');
  }

  var bench = Q.get('bench');
  if (bench) {
    window.__bench = { done: false, tech: bench, results: [] };
    var runs = Math.max(1, Math.min(20, parseInt(Q.get('runs'), 10) || 6));
    var still = drawnDesktop();
    var go = function (i) {
      if (i >= runs) { window.__bench.done = true; return; }
      cmd({ op: 'arm', seq: i * 2 + 1 });
      setTimeout(function () {
        var c = { op: 'play', seq: i * 2 + 2, still: still, size: 'full', tech: bench };
        cmd(c).then(function () { window.__bench.results.push(S.lastStats); setTimeout(function () { go(i + 1); }, 350); });
      }, 250);
    };
    window.__unfoldTold = [];
    setTimeout(function () { go(0); }, 600);
  }
})();

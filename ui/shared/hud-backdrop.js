/* hud-backdrop.js - the blurred picture under a floating HUD, DARK ONLY (lanes see-huds + same-huds,
 * 2026-10-09).
 *
 * Owen, on dark Mantle: "mantle needs to be more see through everything", then "the reason i want
 * everything at 50% is cause it will all match way better if its the same". So a HUD (the volume
 * pop-up, clipboard, notes, the screenshot card, on-top, layouts, the timer, snap) is the same glass
 * as the bar and its pop-ups: a real blurred picture of what is behind it, then ONE --lg-fill layer
 * (.50). A HUD floats over ANY window, and with nothing blurred under it a .50 tint shows a terminal's
 * text sharp through the pane, so it takes the bar pop-ups' path:
 *
 *   1. the page asks, once per show:  MantleHudBackdrop.request('why', {hold: ms})
 *      -> mantle.call('hud.backdrop', {key}) (main.js hudBackdrop; dark only, never on a timer)
 *   2. main takes ONE protected shot of the window's content rectangle and sends it to this window
 *      alone as `<key>.backdrop` {png, w, h, at, win, ms}; `at` is where the shot sits in the window,
 *      as fractions of `win` (the content size in DIP when it was taken), as for the bar's pop-ups.
 *   3. this file blurs it ONCE onto a small canvas with the token's own --lg-blur and nothing else,
 *      and makes it the pane's own background under ONE --lg-fill layer (hud-backdrop.css). Baked,
 *      not a CSS filter: blur on tall layers dropped raster tiles (the bar's pop-ups found that); a
 *      background costs nothing at paint time.
 *   4. THE ONE readability guard every surface shares (ui/shared/glass-adapt.js guard(), the top
 *      bar's rule, same code, same 4.5:1 for --lg-ink-2): the TINT thickens, never the picture
 *      dimming, to the thinnest alpha that keeps the quietest word readable over the brightest
 *      blurred pixel under the pane, capped at --lg-fill-pop. Only then is --hud-tint set; over
 *      Owen's wallpaper it is not. One picture per show, so no hysteresis is needed.
 *
 * {hold: ms} keeps the pane invisible (opacity 0, class .hud-hold) until the picture is baked, for at
 * most that long, so a show is never a frame of the thick fallback face and then the glass. Until a
 * picture lands, and whenever one cannot, the pane keeps its own dark face (one --lg-fill-pop layer):
 * readable on its own. Why there is no picture: api.reason here, State.backdrop['hud-<key>'] in main.
 * The window grows (the volume panel opening): one more shot, the old one is baked into the new size
 * meanwhile. Hidden, or switched to light: the picture is dropped, so the next show never flashes a
 * stale photograph. Light never moves: nothing here runs unless <html data-theme="dark">.
 *
 *   <script src="../shared/glass-adapt.js"></script>
 *   <script src="../shared/hud-backdrop.js" data-event="osd.backdrop" data-pane="#osd"></script>
 *   (data-key defaults to the event without ".backdrop")
 */
(function () {
  'use strict';
  var me = document.currentScript;
  var EVENT = me && me.dataset.event;
  var SEL = me && me.dataset.pane;
  var KEY = (me && me.dataset.key) || (EVENT ? EVENT.replace(/\.backdrop$/, '') : '');
  var SCALE = 0.5;                  // the bake is half the pane's CSS size: under a 12px blur nobody can tell
  var TIMEOUT = 1500;               // a request main never answers is a failure, said as one
  var HOLD = 150;                   // {hold: true}: the longest a show waits, unseen, for its picture

  // ms: main's capture; wait: request -> baked; bake: the canvas work; reqs: requests made
  var api = { state: 'idle', reason: '', guard: null, bakes: 0, reqs: 0, ms: null, wait: null, bake: null, request: noop };
  window.__hudBackdrop = api;       // for the page tests and the shots
  window.MantleHudBackdrop = api;   // for the page's own show code
  function noop() { return Promise.resolve({ ok: false, reason: api.reason || 'not started' }); }

  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  function start() {
    var pane = SEL ? document.querySelector(SEL) : null;
    if (!EVENT || !pane) { api.state = 'off'; api.reason = 'hud-backdrop.js needs data-event and a data-pane that exists (' + SEL + ')'; return; }
    var bridge = window.mantle;
    if (!bridge || typeof bridge.on !== 'function') { api.state = 'off'; api.reason = 'no mantle.on() in this page'; return; }

    var pic = new Image();
    var have = false;
    var where = null;               // {x, y, w, h} in window DIP: where the picture sits
    var canvas = document.createElement('canvas');
    var waiters = [];               // request() promises waiting for this picture
    var inflight = null, asked = 0, holdT = 0;

    function settle(res) {
      var w = waiters; waiters = []; inflight = null;
      clearTimeout(holdT); holdT = 0;
      pane.classList.remove('hud-hold');
      if (res.ok && asked) api.wait = Date.now() - asked;
      w.forEach(function (f) { f(res); });
    }

    function clear(why) {
      have = false; where = null;
      pic.removeAttribute('src');
      pane.classList.remove('hud-bd');
      pane.style.removeProperty('--hud-bd-img');
      pane.style.removeProperty('--hud-tint');
      api.state = 'idle'; api.reason = why || ''; api.guard = null;
      if (waiters.length) settle({ ok: false, reason: api.reason });
    }

    /* the token, exactly: its blur is in CSS px of the pane and the canvas is SCALE of that */
    function filterOf() {
      var tok = getComputedStyle(document.documentElement).getPropertyValue('--lg-blur').trim();
      if (!tok) return 'none';
      return tok.replace(/blur\(\s*([\d.]+)px\s*\)/, function (_, n) { return 'blur(' + (parseFloat(n) * SCALE).toFixed(2) + 'px)'; });
    }

    function bake() {
      if (!have || !isDark() || !pic.naturalWidth || !where) return;
      var t0 = Date.now();
      var r = pane.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return;
      var fx = pic.naturalWidth / where.w, fy = pic.naturalHeight / where.h;
      // THE shared guard (glass-adapt.js guard(), the top bar's rule): the tint thickens only if
      // --lg-ink-2 would fall under 4.5:1 over the brightest blurred pixel under the pane
      var guard = null;
      var G = window.MantleGlassAdapt;
      if (G && G.guard) {
        var T = G.guardTokens(getComputedStyle(document.documentElement));
        // the ceiling (--lg-fill-pop) at or under --lg-fill leaves the guard nothing to thicken: the
        // same answer without blurring the picture in JS (measured 25-30 ms of a 40 ms bake)
        if (!(T.ceil > T.fill.a + 1e-9)) guard = { alpha: T.fill.a, ratio: null, short: false, engaged: false, tint: null };
        else {
          var px = G.pixelsOf(pic);
          guard = px && G.guard(px, { tokens: T, picPerCss: fx, rect: { x: (r.left - where.x) * fx, y: (r.top - where.y) * fy, w: r.width * fx, h: r.height * fy } });
        }
      }
      if (guard && guard.engaged) pane.style.setProperty('--hud-tint', guard.tint);
      else pane.style.removeProperty('--hud-tint');
      var cw = Math.max(1, Math.round(r.width * SCALE)), ch = Math.max(1, Math.round(r.height * SCALE));
      canvas.width = cw; canvas.height = ch;
      var g = canvas.getContext('2d');
      g.clearRect(0, 0, cw, ch);
      g.filter = filterOf();
      // the whole picture, offset so the pane's part lands on the canvas: the blur reads the shadow
      // margin round the pane instead of pulling transparency in from the edges
      g.drawImage(pic, (where.x - r.left) * SCALE, (where.y - r.top) * SCALE, where.w * SCALE, where.h * SCALE);
      g.filter = 'none';
      var url;
      try { url = canvas.toDataURL('image/png'); } catch (err) { clear('the picture could not be baked: ' + err.message); return; }
      pane.style.setProperty('--hud-bd-img', 'url("' + url + '")');
      pane.classList.add('hud-bd');
      api.state = 'on'; api.reason = G && G.guard ? '' : 'ui/shared/glass-adapt.js did not load, so the tint cannot thicken over a bright picture';
      api.guard = guard ? { alpha: guard.alpha, ratio: guard.ratio, engaged: guard.engaged, short: guard.short } : null; api.bakes++; api.bake = Date.now() - t0;
      if (waiters.length) settle({ ok: true, ms: api.ms, guard: api.guard });
    }

    function set(p) {
      if (p && p.clear) { clear(p.reason || 'main cleared the picture'); return; }
      if (!p || typeof p.png !== 'string' || p.png.slice(0, 5) !== 'data:') {
        clear('the ' + EVENT + ' payload had no png data URL' + (p && p.reason ? ': ' + p.reason : ''));
        return;
      }
      if (!isDark()) { clear('light theme: the pane keeps its own face'); return; }
      // where the shot sits in the window: main's `at` fractions of the window it was taken from, or the
      // whole window when there is none (the shots, the tests)
      var W = p.win && p.win.w > 0 ? p.win.w : window.innerWidth, H = p.win && p.win.h > 0 ? p.win.h : window.innerHeight;
      var at = p.at && p.at.w > 0 && p.at.h > 0 ? p.at : { x: 0, y: 0, w: 1, h: 1 };
      where = { x: at.x * W, y: at.y * H, w: at.w * W, h: at.h * H };
      have = true;
      api.ms = typeof p.ms === 'number' ? p.ms : null;
      pic.onload = bake;
      pic.onerror = function () { clear('the ' + EVENT + ' picture would not decode'); };
      pic.src = p.png;
    }

    /* One picture for this show. opts.hold: ms the pane stays invisible waiting for it (0 = none).
       Resolves {ok, ms, guard} once baked, or {ok:false, reason}; never rejects. */
    api.request = function (why, opts) {
      opts = opts || {};
      if (!isDark()) return Promise.resolve({ ok: false, reason: 'light: no picture is asked for' });
      if (typeof bridge.call !== 'function') { api.reason = 'no mantle.call() in this page'; return Promise.resolve({ ok: false, reason: api.reason }); }
      var p = new Promise(function (res) { waiters.push(res); });
      var hold = opts.hold === true ? HOLD : (opts.hold > 0 ? opts.hold : 0);
      if (hold) {
        pane.classList.add('hud-hold');
        clearTimeout(holdT);
        holdT = setTimeout(function () { holdT = 0; pane.classList.remove('hud-hold'); }, hold);
      }
      if (inflight) return p;       // one shot already on its way serves this show too
      api.reqs++;
      asked = Date.now();
      var mine = inflight = {};
      var t = setTimeout(function () { if (inflight === mine) settle({ ok: false, reason: 'main did not answer hud.backdrop in ' + TIMEOUT + ' ms' }); }, TIMEOUT);
      Promise.resolve(bridge.call('hud.backdrop', { key: KEY, why: String(why || '') })).then(function (r) {
        clearTimeout(t);
        // the picture itself comes as EVENT; a refusal comes back here (and as EVENT with its reason)
        if (r && r.ok === false && inflight === mine) { api.reason = r.reason || 'no picture'; settle({ ok: false, reason: api.reason }); }
      }, function (err) {
        clearTimeout(t);
        if (inflight === mine) { api.reason = 'hud.backdrop failed: ' + (err && err.message ? err.message : err); settle({ ok: false, reason: api.reason }); }
      });
      return p;
    };

    function paneUp() {
      if (pane.hidden || document.visibilityState === 'hidden') return false;
      var r = pane.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    /* The first filtered draw + PNG encode in a page cost ~770 ms (measured in a --test instance,
       2026-10-09; the next ones 6-38 ms), which ran the first show past its hold onto the thick face.
       So a dark page does one 8x8 bake, once, while idle after load. */
    function warm() {
      if (!isDark() || api.warm) return;
      var t0 = Date.now();
      try {
        var c = document.createElement('canvas'); c.width = 8; c.height = 8;
        var g = c.getContext('2d'); g.filter = filterOf(); g.fillRect(0, 0, 8, 8); g.drawImage(c, 0, 0); c.toDataURL('image/png');
        api.warm = Date.now() - t0;
      } catch (_) { api.warm = -1; }
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 2000 }); else setTimeout(warm, 500);

    bridge.on(EVENT, set);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') clear('the window was hidden'); });
    window.addEventListener('mantle-theme', function () {
      if (!isDark()) { clear('light theme'); return; }
      warm();
      if (have) bake(); else if (paneUp()) api.request('the theme turned dark');
    });
    // the pane changes size or place (a longer toast, the panel opening): bake again from the same
    // picture at once; the WINDOW changing size is a new rectangle, so one more shot follows
    if (typeof ResizeObserver === 'function') new ResizeObserver(function () { if (have) bake(); }).observe(pane);
    var lastW = window.innerWidth, lastH = window.innerHeight;
    window.addEventListener('resize', function () {
      if (window.innerWidth === lastW && window.innerHeight === lastH) return;
      lastW = window.innerWidth; lastH = window.innerHeight;
      if (have && isDark() && paneUp()) api.request('the window changed size');
    });
    api.state = 'idle';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

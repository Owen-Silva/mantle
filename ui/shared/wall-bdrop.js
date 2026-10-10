/* wall-bdrop.js - Helm's see-through for Mantle's APP windows, DARK ONLY (lane helm-wall-apps, 2026-10-09).
 *
 * Owen: "you need to get the see through to look just like helm". Helm does not ask Windows for acrylic: it
 * paints its own photo, blurred with a plain CSS blur, and lays its tint over it (helm ui/shell/shell.css
 * .bg-photo / .bg-wash). So in dark Files, Task Manager, Settings and Task view stop using DWM's acrylic /
 * blur-behind (the window is opaque, lib/features/_wall-window.js) and paint the DESKTOP WALLPAPER instead:
 *
 *   1. main hands the page ONE still of the wallpaper as Mantle's desktop shows it (ctx.host.wall.full():
 *      {png, w, h, display, source, key}; `display` = the DIP rectangle the still covers) as `<feature>.wall`,
 *      replayed on subscribe, pushed again when the wallpaper or the theme changes.
 *   2. this file blurs it ONCE onto a canvas with the --lg-blur token (dark: blur(5px), nothing else), scaled
 *      to canvas px, the image's edges clamped into a margin first so the blur never pulls transparency in.
 *      The canvas IS the picture: no PNG encode, no CSS filter at paint time (blur on tall layers dropped
 *      raster tiles, ui/shared/hud-backdrop.js), one texture the compositor moves.
 *   3. the canvas is display.width x display.height CSS px (= DIP) inside a fixed layer at z-index -1, and
 *      sits where the real wallpaper is: transform translate(display.x - winX, display.y - winY). main pushes
 *      the window's content origin (DIP) on every move / resize as `<feature>.wallpos` {x, y, t}; one transform
 *      write per push, no paint. Task view sizes itself to a display and says where (api.at(x, y)).
 *   4. over it ONE tint layer: var(--wall-tint), which each page sets to the SAME tint its root carried over
 *      the acrylic (Helm's content panel --lg-fill, the strip --lg-fill-bar). html.wall-on stands the root on
 *      the opaque --lg-ground (where the window runs off the display, the ground shows under the tint, never a
 *      hole) and clears body, so the tint is exactly one layer over the picture (wall-bdrop.css).
 *
 * No picture (main had none, the still would not decode, an old Mantle): the page keeps its v1 face and the
 * reason is api.reason, announced as the `mantle-wall` event so each page shows it where it already shows its
 * glass reasons. Light never moves: nothing here builds or paints unless <html data-theme="dark">.
 *
 *   <link rel="stylesheet" href="../shared/wall-bdrop.css">
 *   <script src="../shared/wall-bdrop.js" data-event="files.wall" data-pos="files.wallpos"></script>
 */
(function () {
  'use strict';
  var me = document.currentScript;
  var EVENT = me && me.dataset.event;
  var POS = me && me.dataset.pos;

  // state: 'idle' (light) | 'wait' (dark, no still yet) | 'on' (painted) | 'off' (dark, no picture: see reason)
  // lag: main's move -> this page's transform write (ms, main's clock); cost: the write itself (ms)
  var api = { state: 'idle', reason: '', key: null, source: null, display: null, pos: null, bakes: 0, bake: null,
    blur: null, moves: 0, lag: { n: 0, sum: 0, max: 0 }, cost: { n: 0, sum: 0, max: 0 }, at: noop, offset: null };
  window.MantleWallBdrop = api;     // the page's own reason surface + the tests
  function noop() {}

  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  function start() {
    var bridge = window.mantle;
    if (!EVENT) { off('wall-bdrop.js needs data-event'); return; }
    if (!bridge || typeof bridge.on !== 'function') { off('no mantle.on() in this page'); return; }
    var box = null, pic = null, seq = 0;

    function announce() {
      try { window.dispatchEvent(new CustomEvent('mantle-wall', { detail: { state: api.state, reason: api.reason } })); } catch (_) { /* old page */ }
    }
    function build() {
      if (box) return;
      box = document.createElement('div');
      box.id = 'wall-bdrop';
      box.setAttribute('aria-hidden', 'true');
      pic = document.createElement('canvas');
      pic.className = 'wall-pic';
      var tint = document.createElement('div');
      tint.className = 'wall-tint';
      box.appendChild(pic); box.appendChild(tint);
      document.body.insertBefore(box, document.body.firstChild);
    }
    function clear(state, why) {
      seq++;
      document.documentElement.classList.remove('wall-on');
      if (pic) { pic.width = 0; pic.height = 0; }      // let the texture go
      api.state = state; api.reason = why || ''; api.key = null; api.source = null; api.display = null; api.offset = null;
      announce();
    }
    off = function (why) { clear(isDark() ? 'off' : 'idle', why); };

    /* where the picture sits: the display's origin less the window's, in CSS px (= DIP) */
    function place() {
      if (!pic || !api.display || !api.pos) return;
      var dx = Math.round(api.display.x - api.pos.x), dy = Math.round(api.display.y - api.pos.y);
      if (api.offset && api.offset.x === dx && api.offset.y === dy) return;
      api.offset = { x: dx, y: dy };
      pic.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    api.at = function (x, y) {
      if (!(isFinite(x) && isFinite(y))) return;
      api.pos = { x: +x, y: +y };
      place();
    };

    /* the token, exactly, its blur scaled from CSS px to canvas px; null when there is no token */
    function filterOf(scale) {
      var tok = getComputedStyle(document.documentElement).getPropertyValue('--lg-blur').trim();
      if (!tok || tok === 'none') return null;
      var px = 0;
      var f = tok.replace(/blur\(\s*([\d.]+)px\s*\)/, function (_, n) { px = parseFloat(n) * scale; return 'blur(' + px.toFixed(2) + 'px)'; });
      return { filter: f, px: px };
    }

    function bake(img, p, mine) {
      if (mine !== seq || !isDark()) return;
      var t0 = performance.now();
      var iw = img.naturalWidth, ih = img.naturalHeight;
      var d = p.display;
      var w = p.w > 0 ? Math.round(p.w) : iw, h = p.h > 0 ? Math.round(p.h) : ih;
      var f = filterOf(w / d.width);
      var m = f ? Math.ceil(f.px * 3) : 0;
      build();
      // the still with its edge pixels clamped out into a margin: the blur then reads the edge colour
      // past the border instead of transparency (Helm insets its photo by -2.5x the blur for the same reason)
      var src = document.createElement('canvas');
      src.width = w + 2 * m; src.height = h + 2 * m;
      var g = src.getContext('2d');
      g.drawImage(img, 0, 0, iw, ih, m, m, w, h);
      if (m) {
        g.drawImage(img, 0, 0, iw, 1, m, 0, w, m);                    // top
        g.drawImage(img, 0, ih - 1, iw, 1, m, m + h, w, m);           // bottom
        g.drawImage(img, 0, 0, 1, ih, 0, m, m, h);                    // left
        g.drawImage(img, iw - 1, 0, 1, ih, m + w, m, m, h);           // right
        g.drawImage(img, 0, 0, 1, 1, 0, 0, m, m);                     // the four corners
        g.drawImage(img, iw - 1, 0, 1, 1, m + w, 0, m, m);
        g.drawImage(img, 0, ih - 1, 1, 1, 0, m + h, m, m);
        g.drawImage(img, iw - 1, ih - 1, 1, 1, m + w, m + h, m, m);
      }
      pic.width = w; pic.height = h;
      var o = pic.getContext('2d');
      o.filter = f ? f.filter : 'none';
      o.drawImage(src, -m, -m);
      o.filter = 'none';
      src.width = 0; src.height = 0;
      pic.style.width = d.width + 'px';
      pic.style.height = d.height + 'px';
      api.display = { x: d.x, y: d.y, width: d.width, height: d.height };
      api.key = p.key || null; api.source = p.source || null; api.blur = f ? f.filter : 'none';
      if (!api.pos) api.pos = { x: window.screenX, y: window.screenY };    // until main says where the window is
      api.offset = null;
      place();
      document.documentElement.classList.add('wall-on');
      api.state = 'on'; api.reason = ''; api.bakes++; api.bake = Math.round((performance.now() - t0) * 10) / 10;
      announce();
    }

    function take(p) {
      if (!p) return;
      if (!isDark()) { if (api.state !== 'idle') clear('idle', 'light theme'); return; }
      if (p.ok === false) { clear('off', p.reason || 'main had no wallpaper picture and did not say why'); return; }
      var d = p.display;
      if (typeof p.png !== 'string' || p.png.slice(0, 5) !== 'data:' || !d || !(d.width > 0) || !(d.height > 0)) {
        clear('off', 'the ' + EVENT + ' payload had no picture (a png data URL and the display it covers)');
        return;
      }
      if (api.state === 'on' && p.key && p.key === api.key && pic && pic.width) return;    // this one is painted
      var mine = ++seq;
      var img = new Image();
      img.onload = function () {
        try { bake(img, p, mine); } catch (err) { if (mine === seq) clear('off', 'the wallpaper picture could not be blurred: ' + (err && err.message)); }
        img.removeAttribute('src');
      };
      img.onerror = function () { if (mine === seq) clear('off', 'the wallpaper picture would not decode'); };
      img.src = p.png;
    }

    function pos(p) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
      var t0 = performance.now();
      api.pos = { x: +p.x, y: +p.y };
      api.moves++;
      place();
      var c = performance.now() - t0;
      api.cost.n++; api.cost.sum += c; if (c > api.cost.max) api.cost.max = c;
      if (p.t > 0) { var l = Date.now() - p.t; api.lag.n++; api.lag.sum += l; if (l > api.lag.max) api.lag.max = l; }
    }

    bridge.on(EVENT, take);
    if (POS) bridge.on(POS, pos);
    window.addEventListener('mantle-theme', function () {
      // main pushes the still again on a flip to dark (lib/features/_wall-window.js); light drops it
      if (!isDark()) clear('idle', 'light theme');
      else if (api.state === 'idle') { api.state = 'wait'; api.reason = 'waiting for the wallpaper picture'; announce(); }
    });
    if (!isDark()) api.state = 'idle';
    else { api.state = 'wait'; api.reason = 'waiting for the wallpaper picture'; }
  }
  var off = function (why) { api.state = 'off'; api.reason = why; };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

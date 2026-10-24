/* unfold-page.js - the full-screen unfold overlay page (lib/features/unfold.js; wave unfold, 2026-10-23).
 *
 * Main drives it with `unfold.cmd` {op, seq, ...} (ctx.push) and the page answers every op ONCE through
 * window.mantle.call('unfold.page', {seq, display, event, ...}):
 *
 *   arm      the unlit display: opaque black, nothing else. Put up while the screen is off or locked,
 *            so the first thing seen after an unlock is the screen opening, never the desktop
 *            flashing and then the effect.                                          -> 'armed'
 *   play     {still, size, tech}  the unfold over the desktop's picture, then a dissolve into the live
 *            screen; still null (no picture, or reduced motion) = a short fade out of the black.
 *                                                                                   -> 'played'
 *   cover    {still}  the picture, sharp (so the cover's first frame IS the live screen), then folded
 *            into blur over --unfold-fold-ms.                                       -> 'covered'
 *   reveal   from wherever it is, unfold back into focus and dissolve into the live screen, fast.
 *                                                                                   -> 'revealed'
 *   finish   input arrived: whatever is playing holds its frame and fades out in 90 ms. -> 'finished'
 *   skip     the picture did not come: the black fades out (no effect).             -> 'skipped'
 *   park     drop the pictures (memory) and hide everything.                        -> 'parked'
 *
 * Every animated op ends on a timer too (its duration + 400 ms), so a page that gets no frames (hidden
 * window, GPU stall) can never leave the screen covered: the end pose is set by hand.
 *
 * THE LOOK (Owen, 2026-10-23: LITERALLY the iPhone Duo, premium; after seeing it live: "way too blue",
 * "the blur showed steps", "more transparent so you can see the outline of the background"; the shared
 * description is in ui/shared/unfold.css; the numbers come from Apple's own clips, measured in
 * the wave's duo-ref notes, SPEC.md). A vertical hinge in the centre. The RIGHT half is the
 * fixed half: in place from the first frame, sharp, lit up out of the black and then at full
 * brightness throughout, as in Apple's clips. The LEFT half (the leaf) swings open around the hinge:
 * its visible width is the front view of a panel turning flat (sin of the swing, --unfold-hinge fitted
 * to the footage's widths: a slow first frames, fastest early, a long soft landing). The picture is ONE
 * image fixed in space; the halves are windows onto it. On the leaf the blur is per pixel: radius =
 * cap x strength x d (1.5 - 0.5 d), d = 0 at the hinge and 1 at the free edge (the panel's own
 * coordinate; fitted to the footage: sharp at the hinge, faster than linear), cap --unfold-edge-blur
 * (2.5 % of the width; mid-swing the leaf's outlines stay readable, as on Apple's clip). AFTER the blur the leaf dims by distance from the hinge as measured (a light
 * shading off the hinge that levels out, then the outer quarter falling away, its free edge at
 * --unfold-dark, never black), a NEUTRAL multiply toward black: the real Duo has no tint
 * (--unfold-shade is black). Outlines read through it at every moment. The leaf LANDS with its blur
 * (LAND_BLUR of it) and dimming still on, and they release together over about 0.35 s after the
 * landing, as the footage shows; then the stage dissolves into the live screen. Endpoints are sharp at
 * full brightness. The cover (look-away) folds the whole screen into blur, the outer edges first, the
 * hinge last, ending evenly out of focus and lightly dimmed (--unfold-dark-blur), neutral too.
 *
 * TECHNIQUE 'gl' (shipped): WebGL. The picture is uploaded once and blurred ONCE, on the GPU, into 12
 * levels (1.4 px to 150 px, each a factor of about 1.4, each at the smallest size that keeps 2.5 texels
 * per sigma, so reading it back between texels stays under one 8-bit step); every frame is then one
 * full-screen draw. Each pixel blends THREE neighbouring levels with quadratic B-spline weights over a
 * smooth level index (u = log_1.41(1 + r/2) - 1/2; u = -1/2, the sharp picture alone, at r = 0): the
 * weights and their slopes are continuous, so the blur grows as one smooth gradient with no band where
 * one level hands over to the next (a straight blend of two levels showed one at every level), and the
 * dimmed picture is dithered by under half an 8-bit step so a slow ramp shows no contour lines. The
 * sharp half reads one texel, the moving half three. No blur is computed per frame.
 * The programs are built and run once at page load (and again after the graphics card resets, which
 * waking from sleep can do), so the first unlock pays no shader compile; each play draws its first
 * frame and waits for the GPU before the clock starts.
 * TECHNIQUE 'layers' (fallback, and the bench's comparison): transform/opacity over pre-blurred
 * canvases. Used only when WebGL is missing or fails, and the answer says so (fallback: reason).
 * TECHNIQUE 'css' (bench only): the contract's element version on one full-screen picture.
 *
 * TEST: window.__unfold = { state(), stats(), cmd(op), freeze(f), gl() } (always there, costs nothing).
 * BENCH: index.html?bench=gl|layers|css&runs=N plays N full unfolds over a drawn desktop and leaves the
 * frame pacing in window.__bench (ui/unfold/pace.js reads it in a hidden Electron window). */
(function () {
  'use strict';

  var Q = new URLSearchParams(location.search);
  var DISPLAY = Q.get('display') || '0';
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), ground = $('ground'), tint = $('tint'), leaf = $('leaf'), leafIn = $('leaf-in'),
      sharp = $('sharp'), soft = $('soft'), smear = $('smear'), sheenL = $('sheen-l'), sheenR = $('sheen-r'),
      glCanvas = $('gl');
  var LAYERS = [stage, ground, tint, leaf, leafIn, sharp, soft, smear, sheenL, sheenR];

  var SEAM = 0.006;        // layers: the opening starts as a hairline (0.6 % of the width)
  // the timeline, as the real Duo (duo-ref SPEC: Apple's own clips): the leaf swings open and LANDS at
  // OPEN_END with its blur and dimming still on; they release together after the landing, over about
  // 0.35 s, ending at RELEASE_END; the stage dissolves into the live screen from HANDOVER
  var OPEN_END = 0.62;     // gl: the leaf lands at 62 % of --unfold-full-ms (layers: the opening's end)
  var RELEASE_END = 0.93;  // gl: blur and dimming fully released (sharp, full brightness)
  var HANDOVER = 0.86;     // from here the stage dissolves into the live screen
  var APPEAR = 0.065;      // gl: the screen lights up out of the black over the first 6.5 % (about 70 ms)
  var LAND_BLUR = 0.55;    // gl: the blur still on the landed leaf, of its start (1.4 % of the width at the free edge: Apple's
                           // landed leaf shows 1.3 %; it eases off late in the swing, as the swing's square)
  // layers: how much of the shade the covered screen and the not-yet-open screen wear (the gl look's values)
  function coverTint() { return num('--unfold-dark-blur', 0.24); }
  function playTint() { return num('--unfold-dark', 0.45); }
  var HARD_PAD = 400;      // every animated op ends by its duration + this, frames or not
  var BLACK_MAX = 8;       // a picture whose small copy is darker than this everywhere is a black capture
  var VSYNC = 1000 / 60;   // this laptop's panel; a median of the deltas lies when many frames drop

  var EARLY_MS = 200;      // the pacer counts the drops that began in the clock's first EARLY_MS apart
  var LAG_MS = 8;          // a frame callback this late after its frame began: the frame reached the page late

  var S = { pose: 'parked', seq: 0, op: null, anims: [], loop: null, hard: null, still: false, stillW: 0, stillH: 0,
    lastStats: null, runs: 0, errors: [], drawn: null, freezeT: null, glLast: null, prep: null };

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
    E.hinge = easing(cssVar('--unfold-hinge'), bezier(0.45, 0, 0.4, 1));
    E.fadeIn = easing(cssVar('--m-fade-in'), bezier(0.2, 0, 0, 1));
    E.fadeOut = easing(cssVar('--m-fade-out'), bezier(0.4, 0, 1, 1));
  }
  function clamp(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function span(t, a, b) { return clamp((t - a) / (b - a)); }
  function smooth(x) { x = clamp(x); return x * x * (3 - 2 * x); }
  function hexRgb(h, d) {
    var m = /^#?([0-9a-f]{6})$/i.exec((h || '').trim());
    if (!m) return d;
    var n = parseInt(m[1], 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  /* ---- the picture --------------------------------------------------------------------------- */

  /** an error whose message is already plain words, said to main as it is */
  function plainError(text) { var e = new Error(text); e.plain = true; return e; }
  function said(err, what) {
    if (err && err.plain) return err.message;
    return what + ' (' + String(err && err.message || err || 'no reason given').split('\n')[0] + ')';
  }

  function decode(url) {
    var img = new Image();
    img.decoding = 'async';
    img.src = url;
    return (img.decode ? img.decode() : new Promise(function (res, rej) { img.onload = res; img.onerror = rej; }))
      .then(function () {
        if (!img.naturalWidth || !img.naturalHeight) throw plainError('the picture of the screen was empty');
        return img;
      }, function () { throw plainError('the picture of the screen could not be read'); });
  }

  /** the brightest pixel of a small canvas, as luminance 0..255 (a capture of a protected or dark
   * desktop comes back as all black; unfolding that would be a black screen opening onto black) */
  function brightest(c) {
    var d;
    try { d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; } catch (_) { return 255; }   // unreadable: not known to be black, so play it
    var m = 0;
    for (var i = 0; i < d.length; i += 4) {
      var y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * d[i + 3] / 255;
      if (y > m) m = y;
    }
    return m;
  }
  var probe = document.createElement('canvas');
  function isBlack(img) {
    probe.width = Math.max(1, Math.round(img.naturalWidth / 16)); probe.height = Math.max(1, Math.round(img.naturalHeight / 16));
    var g = probe.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, probe.width, probe.height);
    var black = brightest(probe) < BLACK_MAX;
    probe.width = probe.height = 1;
    return black;
  }

  /* ---- gl: the Duo, per pixel ----------------------------------------------------------------- */

  // the blur levels: index 0 is the sharp picture, index k >= 1 the picture blurred by SIG(k) px (of the
  // picture): 1.36, 2.76, 4.73, 7.51, 11.5, 17.0, 24.9, 36.1, 51.8, 74.1. Level 1 has its own full-size
  // texture; levels 2..NLV are packed into the atlas, each at LV_K texels per sigma.
  var LV_A = 2, LV_Q = Math.SQRT2, NLV = 12, LV_K = 2.5;   // 11, 12: 105, 150 px (a 4K screen's scaled cap)
  function SIG(k) { return LV_A * (Math.pow(LV_Q, k + 0.5) - 1); }
  var NA = NLV - 1;
  var GUT = 2;             // atlas texels between levels
  var VS = 'attribute vec2 aP; varying vec2 v; void main() { v = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }';
  // one pass of a separable Gaussian: a region of the source (uFrom, uv) onto the whole viewport;
  // samples are clamped inside the region (the edge is extended, so no dark rim and no bleed)
  var FS_BLUR = [
    'precision highp float;',
    'varying vec2 v;',
    'uniform sampler2D uSrc;',
    'uniform vec4 uFrom;',
    'uniform vec2 uHalfT;',
    'uniform vec2 uStep;',
    'uniform float uSigma;',
    'void main() {',
    '  vec2 c = mix(uFrom.xy, uFrom.zw, v);',
    '  float n = ceil(uSigma * 3.0);',
    '  vec3 acc = vec3(0.0);',
    '  float ws = 0.0;',
    '  for (int i = -12; i <= 12; i++) {',
    '    float fi = float(i);',
    '    float w = abs(fi) <= n ? exp(-0.5 * fi * fi / (uSigma * uSigma)) : 0.0;',
    '    acc += texture2D(uSrc, clamp(c + uStep * fi, uFrom.xy + uHalfT, uFrom.zw - uHalfT)).rgb * w;',
    '    ws += w;',
    '  }',
    '  gl_FragColor = vec4(acc / ws, 1.0);',
    '}'].join('\n');
  // the frame: this pixel's radius and darkening, three neighbouring levels blended (quadratic B-spline
  // over the smooth level index), then the darkening (after the blur), the free edge, and a dither
  var FS_FRAME = [
    'precision highp float;',
    'varying vec2 v;',
    'uniform sampler2D uSharp;',
    'uniform sampler2D uAtlas;',
    'uniform sampler2D uLv1;',
    'uniform vec4 uBox[' + NA + '];',
    'uniform vec2 uHalfA;',
    'uniform vec2 uSize;',
    'uniform vec4 uPlay;',     // open (0..1 of the half), strength, the inner screen's darkening (both halves), its light
    'uniform vec4 uCover;',    // mode (0 play, 1 cover), fold 0..1, blur at full fold (px), darkening at full fold
    'uniform vec4 uEdge;',     // blur cap (px), dimming gain, dimming cap at the free edge, the dimming left (release)
    'uniform vec2 uMap;',      // 1 / LV_A, 1 / log2(LV_Q): radius -> level index
    'uniform vec3 uShade;',
    // level i (0 the sharp picture, 1 its own texture, 2..NLV in the atlas), edges extended
    'vec3 lev(float i) {',
    '  if (i < 0.5) return texture2D(uSharp, v).rgb;',
    '  if (i < 1.5) return texture2D(uLv1, v).rgb;',
    '  vec4 b = uBox[0];',
    '  for (int k = 1; k < ' + NA + '; k++) { if (abs(float(k + 2) - i) < 0.5) b = uBox[k]; }',
    '  return texture2D(uAtlas, clamp(mix(b.xy, b.zw, v), b.xy + uHalfA, b.zw - uHalfA)).rgb;',
    '}',
    // 1 - (1 - x)^2: rises like x, eases into 1 with no corner (a min() corner reads as a band)
    'float sat(float x) { x = clamp(x, 0.0, 1.0); return x * (2.0 - x); }',
    'void main() {',
    '  float hw = uSize.x * 0.5;',
    '  float x = v.x * uSize.x;',
    '  float r = 0.0;',
    '  float kb = 0.0;',          // neutral darkening (toward black)
    '  float ke = 0.0;',          // the edge darkening (toward the shade: the faint indigo)
    '  float a = 1.0;',
    '  vec3 shade = uShade;',
    '  if (uCover.x < 0.5) {',
    '    kb = uPlay.z;',
    '    a = uPlay.w;',
    '    if (x < hw) {',
    '      float w = uPlay.x * hw;',
    '      float dpx = hw - x;',
    '      a *= clamp(w - dpx + 0.5, 0.0, 1.0);',
    '      float d = clamp(dpx / max(w, 1.0), 0.0, 1.0);',
    // the blur by distance from the hinge, fitted to Apple's landed leaf (sigma 0.7, 0.7, 1.1, 1.4, 1.4,
    // 1.4, 2.1 % of the open width at d 0.07 .. 0.93): sharp AT the hinge, rising faster than linear,
    // easing toward the free edge (d (1.5 - 0.5 d): 0 at the hinge, 1 at the edge, no corner)
    '      r = uEdge.x * uPlay.y * d * (1.5 - 0.5 * d);',
    // the leaf's dimming by distance from the hinge, fitted to Apple's clip at the landing (gain 0.92
    // 0.86 0.85 0.83 0.81 0.75 0.58 0.38 at d 0.07 .. 0.97): a light shading off the hinge that levels
    // out, then the outer quarter falling away to the free edge (e = 1 there, so --unfold-dark is the
    // edge's dimming); a shade lighter than Apple's throughout, as Owen asked
    '      float q = 1.0 - d;',
    '      float d6 = d * d * d; d6 *= d6;',
    '      float e = 0.203 * (1.0 - q * q * q * q * q) + 0.797 * d6 * sqrt(d);',
    '      ke = uEdge.z * uEdge.w * clamp(uEdge.y * e, 0.0, 1.0);',
    '    }',
    '  } else {',
    '    float d = min(1.0, abs(x - hw) / hw);',
    '    float u = uCover.y;',
    // the outer edges lead, the hinge follows; it reaches the full cover exactly at u = 1, so the fold
    // moves for its whole duration (2u here saturated at u = 0.71 and then stood still)
    '    float g = sat(u * mix(d * d * d, 1.0, u));',
    '    r = uCover.z * g;',
    '    ke = uCover.w * g;',
    '  }',
    '  vec3 c;',
    '  if (r <= 0.0) c = texture2D(uSharp, v).rgb;',
    '  else {',
    '    float u = clamp(log2(1.0 + r * uMap.x) * uMap.y - 0.5, -0.5, ' + NLV + '.0);',
    '    float i0 = floor(u + 0.5);',
    '    float t = u - i0;',
    '    float wa = 0.5 * (0.5 - t) * (0.5 - t);',
    '    float wb = 0.75 - t * t;',
    '    c = lev(max(i0 - 1.0, 0.0)) * wa + lev(i0) * wb + lev(min(i0 + 1.0, ' + NLV + '.0)) * (1.0 - wa - wb);',
    '  }',
    '  c = mix(c * (1.0 - kb), shade, ke) * a;',
    // under half an 8-bit step of fixed noise wherever the picture is changed (a sharp, unshaded
    // pixel is left exact, so the hand-over to the live screen cannot shift by a step)
    '  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '  float touched = step(1e-4, r + kb + ke + (1.0 - a));',
    '  gl_FragColor = vec4(c + touched * (n - 0.5) * 0.98 / 255.0, 1.0);',
    '}'].join('\n');

  var G = { gl: null, ok: false, why: null, lost: false, ready: false, P: null, L: null, buf: null,
    sharp: null, lv1: null, lv1F: null, atlas: null, atlasF: null, scratch: null, scratchF: null, warmMs: null, builds: 0, last: null };
  var NO_GL = 'the graphics card did not offer the drawing the full unfold needs, so the simpler unfold plays';

  function glInit() {
    G.ok = false; G.ready = false; G.P = null;
    var attr = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false };
    var gl = G.gl;
    try { if (!gl) gl = glCanvas.getContext('webgl2', attr) || glCanvas.getContext('webgl', attr); } catch (_) { gl = null; }
    if (!gl) { G.why = NO_GL; return false; }
    G.gl = gl;
    try {
      var mk = function (type, src) {
        var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(String(gl.getShaderInfoLog(s)).slice(0, 300));
        return s;
      };
      var prog = function (fs, names) {
        var p = gl.createProgram();
        gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
        gl.bindAttribLocation(p, 0, 'aP');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(String(gl.getProgramInfoLog(p)).slice(0, 300));
        var u = { p: p };
        names.forEach(function (n) { u[n] = gl.getUniformLocation(p, n); });
        return u;
      };
      G.P = {
        blur: prog(FS_BLUR, ['uSrc', 'uFrom', 'uHalfT', 'uStep', 'uSigma']),
        frame: prog(FS_FRAME, ['uSharp', 'uAtlas', 'uLv1', 'uBox', 'uHalfA', 'uSize', 'uPlay', 'uCover', 'uEdge', 'uMap', 'uShade']),
      };
      G.buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, G.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      G.max = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
      G.ok = true; G.why = null;
      return true;
    } catch (e) {
      S.errors.push('gl: ' + String(e && e.message || e).split('\n')[0]);
      G.why = 'the graphics card could not build the full unfold, so the simpler unfold plays';
      return false;
    }
  }

  glCanvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    G.lost = true; G.ok = false; G.ready = false;
    G.why = 'the graphics card was resetting (it does after a wake from sleep), so the simpler unfold played';
  });
  glCanvas.addEventListener('webglcontextrestored', function () {
    G.lost = false;
    G.sharp = G.lv1 = G.lv1F = G.atlas = G.atlasF = G.scratch = G.scratchF = null;   // everything died with the old context
    if (glInit()) glWarm();
  });

  /** each level's size (the smallest that keeps LV_K texels per sigma, at most full size) and, for
   * levels 2..NLV, its place in the atlas: packed top-down in columns as tall as level 2 */
  function layout(W, H) {
    var f = 1;
    for (var tries = 0; tries < 6; tries++) {
      var lv = [];
      for (var k = 1; k <= NLV; k++) {
        var sg = SIG(k), sc = Math.min(1, LV_K / sg) * f;
        lv.push({ sig: sg, sc: sc, w: Math.max(1, Math.round(W * sc)), h: Math.max(1, Math.round(H * sc)) });
      }
      var colH = lv[1].h, x = 0, y = 0, colW = 0, AH = 0;
      lv.slice(1).forEach(function (l) {
        if (y > 0 && y + l.h > colH) { x += colW + GUT; y = 0; colW = 0; }
        l.x = x; l.y = y; y += l.h + GUT; colW = Math.max(colW, l.w); AH = Math.max(AH, l.y + l.h);
      });
      var AW = x + colW;
      if (AW <= G.max && AH <= G.max && lv[0].w <= G.max && lv[0].h <= G.max) return { lv: lv, AW: AW, AH: AH, W: W, H: H, f: f };
      f *= Math.min(G.max / AW, G.max / AH, G.max / lv[0].w, G.max / lv[0].h) * 0.98;
    }
    throw new Error('the screen is too large for the graphics card');
  }

  function texture(w, h, src) {
    var gl = G.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (src) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // the picture's top row at the top of the screen (GL counts from the bottom)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    return t;
  }
  function target(t) {
    var gl = G.gl, f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) throw new Error('a drawing target could not be made');
    return f;
  }

  function sizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(innerWidth * dpr)), h = Math.max(1, Math.round(innerHeight * dpr));
    if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
  }

  /** the picture (an image, or null for the load-time warm-up at the screen's size) onto the GPU and
   * blurred into level 1 and the atlas; ends with a 1-pixel read so the GPU has really done it. The
   * scratch (the across pass's target) is freed again at the end: only the levels stay. */
  function glBuild(src, W, H) {
    var gl = G.gl, P = G.P;
    glFree();
    var L = layout(W, H);
    G.L = L;
    G.sharp = texture(W, H, src);
    G.lv1 = texture(L.lv[0].w, L.lv[0].h, null); G.lv1F = target(G.lv1);
    G.atlas = texture(L.AW, L.AH, null); G.atlasF = target(G.atlas);
    var SW = L.lv[0].w, SH = H;
    G.scratch = texture(SW, SH, null); G.scratchF = target(G.scratch);
    gl.useProgram(P.blur.p);
    gl.uniform1i(P.blur.uSrc, 0);
    gl.activeTexture(gl.TEXTURE0);
    var pass = function (srcTex, tw, th, from, step, sigma, fbo, vx, vy, vw, vh) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(vx, vy, vw, vh);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform4f(P.blur.uFrom, from[0], from[1], from[2], from[3]);
      gl.uniform2f(P.blur.uHalfT, 0.5 / tw, 0.5 / th);
      gl.uniform2f(P.blur.uStep, step[0] / tw, step[1] / th);
      gl.uniform1f(P.blur.uSigma, Math.max(0.3, sigma));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    var prev = null;   // the level the next one is blurred from (null: the sharp picture)
    L.lv.forEach(function (l, i) {
      var sIn = prev ? prev.sc : 1, sigPrev = prev ? prev.sig : 0;
      var add = Math.sqrt(Math.max(0.01, l.sig * l.sig - sigPrev * sigPrev)) * sIn;   // in the source's texels
      var srcTex = G.sharp, tw = W, th = H, from = [0, 0, 1, 1], hIn = H;
      if (i === 1) { srcTex = G.lv1; tw = prev.w; th = prev.h; hIn = prev.h; }
      else if (i > 1) {
        srcTex = G.atlas; tw = L.AW; th = L.AH; hIn = prev.h;
        from = [prev.x / L.AW, prev.y / L.AH, (prev.x + prev.w) / L.AW, (prev.y + prev.h) / L.AH];
      }
      // across: the source region onto the scratch at the level's width and the source's height
      pass(srcTex, tw, th, from, [1, 0], add, G.scratchF, 0, 0, l.w, hIn);
      // down: the scratch onto level 1's own texture, or the level's place in the atlas
      if (i === 0) pass(G.scratch, SW, SH, [0, 0, l.w / SW, hIn / SH], [0, 1], add, G.lv1F, 0, 0, l.w, l.h);
      else pass(G.scratch, SW, SH, [0, 0, l.w / SW, hIn / SH], [0, 1], add, G.atlasF, l.x, l.y, l.w, l.h);
      prev = l;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(G.scratchF); gl.deleteTexture(G.scratch); G.scratch = G.scratchF = null;
    gl.useProgram(P.frame.p);
    gl.uniform1i(P.frame.uSharp, 0); gl.uniform1i(P.frame.uAtlas, 1); gl.uniform1i(P.frame.uLv1, 2);
    var box = new Float32Array(NA * 4);
    L.lv.slice(1).forEach(function (l, i) { box.set([l.x / L.AW, l.y / L.AH, (l.x + l.w) / L.AW, (l.y + l.h) / L.AH], i * 4); });
    gl.uniform4fv(P.frame.uBox, box);
    gl.uniform2f(P.frame.uHalfA, 0.5 / L.AW, 0.5 / L.AH);
    gl.uniform2f(P.frame.uMap, 1 / LV_A, 1 / Math.log2(LV_Q));
    var shade = hexRgb(cssVar('--unfold-shade'), [0, 0, 0]);
    gl.uniform3f(P.frame.uShade, shade[0], shade[1], shade[2]);
    var dpr = W / Math.max(1, innerWidth);
    G.cover = { blur: num('--unfold-cover-blur', 30) * dpr, dark: num('--unfold-dark-blur', 0.24) };
    // the cap is px of a 1920-wide picture (2.5 % of the width: under the footage's most, 3.3 %, so the swinging leaf's outlines stay readable), scaled to this one
    G.edge = { blur: Math.min(SIG(NLV) * 0.95, num('--unfold-edge-blur', 48) * W / 1920), gain: num('--unfold-edge-dark', 1), cap: num('--unfold-dark', 0.6) };
    G.darkFixed = num('--unfold-dark-cover', 0.12);
    G.ready = true; G.builds++;
    glSync();
  }

  function glSync() { var px = new Uint8Array(4); G.gl.readPixels(0, 0, 1, 1, G.gl.RGBA, G.gl.UNSIGNED_BYTE, px); }

  /** one frame: f = {cover, open, strength, fixedDark, fixedLight, fold} */
  function glDraw(f) {
    if (!G.ready || G.lost) return false;
    var gl = G.gl, P = G.P;
    sizeCanvas();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.useProgram(P.frame.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, G.sharp);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, G.atlas);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, G.lv1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(P.frame.uSize, glCanvas.width, glCanvas.height);
    gl.uniform4f(P.frame.uEdge, G.edge.blur, G.edge.gain, G.edge.cap, f.dark == null ? (f.strength || 0) : f.dark);
    gl.uniform4f(P.frame.uPlay, f.open || 0, f.strength || 0, f.fixedDark || 0, f.fixedLight == null ? 1 : f.fixedLight);
    gl.uniform4f(P.frame.uCover, f.cover ? 1 : 0, f.fold || 0, G.cover.blur, G.cover.dark);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    G.last = f;
    return true;
  }

  function glFree() {
    var gl = G.gl;
    if (!gl) return;
    [G.lv1F, G.atlasF, G.scratchF].forEach(function (f) { if (f) gl.deleteFramebuffer(f); });
    [G.sharp, G.lv1, G.atlas, G.scratch].forEach(function (t) { if (t) gl.deleteTexture(t); });
    G.sharp = G.lv1 = G.lv1F = G.atlas = G.atlasF = G.scratch = G.scratchF = null;
    G.ready = false;
  }

  /** the drop at park: the GPU copies freed, the surface cleared to black and hidden */
  function glDrop() {
    glFree();
    G.L = null; G.last = null;
    if (G.gl && !G.lost) {
      G.gl.bindFramebuffer(G.gl.FRAMEBUFFER, null);
      G.gl.clearColor(0, 0, 0, 1); G.gl.clear(G.gl.COLOR_BUFFER_BIT);
    }
    glCanvas.style.visibility = 'hidden';
  }

  /** at load (and after a reset): every program built AND run once at the screen's full size (the
   * driver finishes a program on its first draw), then everything freed again. Idle afterwards. */
  function glWarm() {
    if (!G.ok) return;
    var t0 = performance.now();
    try {
      var dpr = window.devicePixelRatio || 1;
      glBuild(null, Math.max(64, Math.round(innerWidth * dpr)), Math.max(36, Math.round(innerHeight * dpr)));
      glDraw(playFrame(0.3)); glDraw(coverFrame(0.6));
      glSync();
      G.warmMs = Math.round(performance.now() - t0);
    } catch (e) {
      S.errors.push('gl warm: ' + String(e && e.message || e).split('\n')[0]);
      G.ok = false; G.why = 'the graphics card could not draw the full unfold, so the simpler unfold plays';
    }
    glDrop();
  }

  function glPrepare(url) {
    var t0 = performance.now();
    S.prep = { decode: null, build: null };
    return decode(url).then(function (img) {
      var t1 = performance.now();
      S.prep.decode = Math.round(t1 - t0);
      if (isBlack(img)) { glFree(); drop(); throw plainError('the picture of the screen came back black'); }
      if (!G.ok || G.lost) throw new Error(G.why || NO_GL);
      glBuild(img, img.naturalWidth, img.naturalHeight);
      S.prep.build = Math.round(performance.now() - t1);   // the upload, every blur level and a GPU sync
      S.still = true; S.stillW = img.naturalWidth; S.stillH = img.naturalHeight;
      return Math.round(performance.now() - t0);
    });
  }

  /** what is left of the blur and dimming x (0..1) of the way through the release: it starts letting
   * go the moment the leaf lands and falls almost evenly, a touch faster toward the end, as Apple's
   * clip does in quarters of its release (blur 1, 0.75, 0.5, 0.25, 0; the free edge's dimming 1, 0.78,
   * 0.56, 0.22, 0); this gives 1, 0.78, 0.54, 0.28, 0 */
  function release(x) { x = clamp(x); return 1 - x * (0.85 + 0.15 * x); }
  /** the unfold at time t (0..1 of its duration): open (the leaf's visible width, 0..1 of the half),
   * strength (the blur, 0..1 of the cap), dark (the leaf's dimming, 0..1 of its profile) */
  function playFrame(t) {
    var swing = E.hinge(clamp(t / OPEN_END)), R = release(span(t, OPEN_END, RELEASE_END));
    return { cover: false, t: t, open: Math.sin(swing * Math.PI / 2), strength: (1 - (1 - LAND_BLUR) * swing * swing) * R, dark: R,
      fixedDark: (G.darkFixed == null ? 0 : G.darkFixed) * R, fixedLight: E.fadeIn(span(t, 0, APPEAR)),
      stage: 1 - E.fadeOut(span(t, HANDOVER, 1)) };
  }
  function coverFrame(u, stageOp) { return { cover: true, fold: clamp(u), stage: stageOp == null ? 1 : stageOp }; }
  function show(f) {
    if (glDraw(f)) { S.glLast = f; glCanvas.style.visibility = 'visible'; }
    stage.style.opacity = String(f.stage);
  }

  /** the first frame drawn and on screen, and the GPU idle, before the clock starts */
  function glFirst(f) {
    stage.setAttribute('data-pose', 'warming');
    show(f);
    glSync();
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  }

  /* ---- layers (the fallback): the picture blurred once into small canvases --------------------- */

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
      var fullBlur = num('--unfold-full-blur', 18) * dpr, coverBlur = num('--unfold-cover-blur', 28) * dpr;
      var stretch = num('--unfold-full-stretch', 1.06);
      // the ground first: it is the smallest, and it says whether the picture is worth showing at all
      blurInto(ground, img, Math.round(W / 8), Math.round(H / 8), coverBlur / 8, 0);
      if (brightest(ground) < BLACK_MAX) { drop(); throw plainError('the picture of the screen came back black'); }
      sharp.src = img.src;
      blurInto(soft, img, Math.round(W / 4), Math.round(H / 4), fullBlur / 4, 0);
      blurInto(smear, img, Math.round(W / 8), Math.round(H / 8), fullBlur / 16, (stretch - 1) * W / 2 / 8);
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
    if (S.loop) { S.loop.stop(); S.loop = null; }   // a gl run holds the frame it last drew
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

  /** frame pacing of one run, read off requestAnimationFrame. Besides the totals: `early`, the frames
   * dropped in gaps that began in the clock's first EARLY_MS; `worst` and `worstAt`, the longest gap and
   * when it began (ms into the clock); `lagged`, frames whose callback ran over LAG_MS after its frame
   * began, and `lagMax` (the frame signal came late: Mantle runs the GPU service inside its MAIN process,
   * so main's compositor thread or this page was short of processor time); `drawMax`, the longest the
   * page spent issuing one gl frame; `longTasks` / `longMs`, the page's tasks over 50 ms during the
   * clock. Drops with no lagged frames, no long tasks and a small drawMax waited on the GPU itself. */
  function pacer() {
    var deltas = [], starts = [], last = 0, t0 = 0, on = true, lagged = 0, lagMax = 0, meter = { max: 0 };
    var lt = { n: 0, ms: 0 }, obs = null, clock0 = performance.now();
    var take = function (list) { list.forEach(function (e) { if (e.startTime + e.duration >= clock0) { lt.n++; lt.ms += e.duration; } }); };
    try { obs = new PerformanceObserver(function (l) { take(l.getEntries()); }); obs.observe({ entryTypes: ['longtask'] }); } catch (_) { obs = null; }
    function tick(now) {
      if (!on) return;
      var lag = performance.now() - now;
      if (last) { deltas.push(now - last); starts.push(last - t0); if (lag > LAG_MS) lagged++; if (lag > lagMax) lagMax = lag; } else t0 = now;
      last = now; requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    var stop = function () {
      on = false;
      if (obs) { try { take(obs.takeRecords()); obs.disconnect(); } catch (_) { /* gone */ } }
      var s = deltas.slice().sort(function (a, b) { return a - b; });
      var q = function (p) { return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
      var dropped = 0, long = 0, early = 0, worst = 0, worstAt = null;
      deltas.forEach(function (d, i) {
        if (d > VSYNC * 1.5) { long++; var k = Math.max(1, Math.round(d / VSYNC) - 1); dropped += k; if (starts[i] < EARLY_MS) early += k; }
        if (d > worst) { worst = d; worstAt = starts[i]; }
      });
      return { frames: deltas.length, p50: q(0.5), p95: q(0.95), max: s.length ? +s[s.length - 1].toFixed(1) : null,
        vsync: +VSYNC.toFixed(2), long: long, dropped: dropped, early: early, worstAt: worstAt == null ? null : Math.round(worstAt),
        lagged: lagged, lagMax: +lagMax.toFixed(1), drawMax: +meter.max.toFixed(1), longTasks: lt.n, longMs: Math.round(lt.ms) };
    };
    stop.meter = meter;
    return stop;
  }

  /** a gl timeline: draw(t) every frame off the frame clock, t from 0 to 1 over D ms (or held at
   * S.freezeT); resolves when it has drawn t = 1 or is stopped. meter.max: the longest draw (ms). */
  function glLoop(D, draw, meter) {
    var on = true, t0 = null, raf = 0, last = -1, fin;
    var done = new Promise(function (r) { fin = r; });
    function tick(ts) {
      if (!on) return;
      if (t0 === null) t0 = ts;
      var t = S.freezeT != null ? S.freezeT : Math.min(1, (ts - t0) / D);
      if (t !== last) {
        last = t;
        var a = performance.now();
        try { draw(t); } catch (e) { S.errors.push('draw: ' + String(e && e.message || e)); }
        if (meter) meter.max = Math.max(meter.max, performance.now() - a);
      }
      if (t >= 1 && S.freezeT == null) { on = false; fin(); return; }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return { done: done, stop: function () { on = false; cancelAnimationFrame(raf); fin(); } };
  }

  /** animate `tracks` ([el, fn(t) -> {opacity?, transform?}]) and/or a gl `draw(t)` over D ms;
   * resolves {timedOut, stats, cancelled}.
   * keep: whatever was moving holds the frame it had reached (an interrupted unfold fades out from
   * where it is, never from a snapped-back pose) */
  function run(name, D, tracks, endPose, keep, draw) {
    stopAnims(!!keep);
    stage.setAttribute('data-pose', name);
    S.pose = name;
    var n = Math.max(8, Math.min(90, Math.round(D / 10)));
    var stop = pacer();
    var anims = tracks.map(function (tr) {
      var frames = [];
      for (var i = 0; i <= n; i++) { var t = i / n, v = tr[1](t), f = { offset: t }; if ('opacity' in v) f.opacity = v.opacity; if ('transform' in v) f.transform = v.transform; frames.push(f); }
      return tr[0].animate(frames, { duration: D, easing: 'linear', fill: 'forwards' });
    });
    if (S.freezeT != null) anims.forEach(function (a) { a.pause(); a.currentTime = S.freezeT * D; });
    var loop = draw ? glLoop(D, draw, stop.meter) : null;
    S.anims = anims; S.loop = loop;
    return new Promise(function (resolve) {
      var done = false, hard = null;
      function end(timedOut) {
        if (done) return;
        done = true;
        // only this run's own timer: a run cut short by the next op must not clear the next op's
        clearTimeout(hard);
        if (S.hard === hard) S.hard = null;
        var stats = stop(), mine = S.anims === anims;
        // the end pose by hand: a missed frame can never leave a half-open screen
        if (mine) {
          anims.forEach(function (a) { try { a.commitStyles(); } catch (_) { /* gone */ } try { a.cancel(); } catch (_) { /* gone */ } });
          S.anims = [];
          if (loop) { loop.stop(); S.loop = null; if (timedOut) { try { draw(1); } catch (_) { /* the end pose below still holds */ } } }
          if (endPose) endPose.forEach(function (p) { set(p[0], p[1]); });
        }
        stats.ms = D;
        if (mine) { S.lastStats = stats; S.freezeT = null; S.freezeHold = false; }   // a test's hold never outlives its run
        resolve({ timedOut: !!timedOut, stats: stats, cancelled: !mine });
      }
      // a test's hold with `hold` (shots, pixel checks) keeps the hard timer waiting too; a plain hold
      // (a renderer that gets no frames) does not
      var held = false;
      hard = S.hard = setTimeout(function fire() {
        if (S.freezeT != null && S.freezeHold) { held = true; hard = S.hard = setTimeout(fire, 100); return; }
        if (held) { held = false; hard = S.hard = setTimeout(fire, HARD_PAD); return; }   // let go: the pad again, for its last frame
        end(true);
      }, D + HARD_PAD);
      var all = anims.map(function (a) { return a.finished.catch(function () { return null; }); });
      if (loop) all.push(loop.done);
      Promise.all(all).then(function () { end(false); });
    });
  }

  function now(el) { var v = parseFloat(getComputedStyle(el).opacity); return isFinite(v) ? v : 0; }
  /** the horizontal scale an element is drawn at this frame (1 when it has no transform) */
  function scaleXOf(el) {
    var m = /matrix\(([^,]+)/.exec(getComputedStyle(el).transform || '');
    var v = m ? parseFloat(m[1]) : 1;
    return isFinite(v) && v > 0 ? v : 1;
  }

  /* ---- the layer timelines (fallback) ---------------------------------------------------------- */

  function unfoldTracks(D) {
    var W = innerWidth;
    var stretch = num('--unfold-full-stretch', 1.06), tintMax = playTint();
    var open = function (t) { return E.spring(clamp(t / OPEN_END)); };
    var p = function (t) { return SEAM + (1 - SEAM) * open(t); };
    var sheenOp = function (t) { return E.fadeIn(span(t, 0, 0.1)) * (1 - E.fadeIn(span(t, 0.42, 0.84))); };
    return [
      [stage, function (t) { return { opacity: 1 - E.fadeOut(span(t, HANDOVER, 1)) }; }],
      [ground, function (t) { return { opacity: E.fadeIn(span(t, 0, 0.22)) }; }],
      [tint, function (t) { return { opacity: tintMax * E.fadeIn(span(t, 0, 0.22)) }; }],
      [leaf, function (t) { return { transform: 'scaleX(' + p(t).toFixed(5) + ')' }; }],
      [leafIn, function (t) { return { transform: 'scaleX(' + (1 / p(t)).toFixed(5) + ')' }; }],
      [smear, function (t) { return { opacity: 0.85 * (1 - E.fadeIn(span(t, 0, 0.5))), transform: 'scaleX(' + (1 + (stretch - 1) * (1 - open(t))).toFixed(5) + ')' }; }],
      [soft, function (t) { return { opacity: 1 - E.fadeIn(span(t, 0.08, 0.86)), transform: 'scaleX(' + (1 + (stretch - 1) * 0.5 * (1 - open(t))).toFixed(5) + ')' }; }],
      [sheenL, function (t) { return { opacity: sheenOp(t), transform: 'translateX(' + (-p(t) * W / 2).toFixed(1) + 'px)' }; }],
      [sheenR, function (t) { return { opacity: sheenOp(t), transform: 'translateX(' + (p(t) * W / 2).toFixed(1) + 'px)' }; }],
    ];
  }

  function coverTracks() {
    var stretch = 1 + (num('--unfold-full-stretch', 1.06) - 1) * 0.5, ct = coverTint();
    return [
      [soft, function (t) { return { opacity: E.fadeIn(span(t, 0, 0.7)), transform: 'scaleX(' + (1 + (stretch - 1) * E.fadeIn(t)).toFixed(5) + ')' }; }],
      [ground, function (t) { return { opacity: E.fadeIn(span(t, 0.25, 1)), transform: 'scaleX(' + (1 + (stretch - 1) * E.fadeIn(t)).toFixed(5) + ')' }; }],
      [tint, function (t) { return { opacity: ct * E.fadeIn(span(t, 0.25, 1)) }; }],
    ];
  }

  function revealTracks() {
    var g0 = now(ground), s0 = now(soft), t0 = now(tint), st0 = now(stage), gx = scaleXOf(ground), sx = scaleXOf(soft);
    var back = function (x0, t) { return 'scaleX(' + (x0 + (1 - x0) * E.fadeIn(t)).toFixed(5) + ')'; };
    return [
      [ground, function (t) { return { opacity: g0 * (1 - E.fadeIn(span(t, 0, 0.6))), transform: back(gx, t) }; }],
      [soft, function (t) { return { opacity: s0 * (1 - E.fadeIn(span(t, 0.1, 0.9))), transform: back(sx, t) }; }],
      [tint, function (t) { return { opacity: t0 * (1 - E.fadeIn(span(t, 0, 0.6))) }; }],
      [stage, function (t) { return { opacity: st0 * (1 - E.fadeIn(span(t, 0.3, 1))) }; }],
    ];
  }

  var OPEN_SHARP = [[leaf, { transform: 'scaleX(1)' }], [leafIn, { transform: 'scaleX(1)' }]];
  var GONE = [[stage, { opacity: 0 }]];

  /* ---- ops ----------------------------------------------------------------------------------- */

  function tell(seq, event, extra) {
    var msg = { seq: seq, display: DISPLAY, event: event, pose: S.pose };
    if (extra) for (var k in extra) if (extra[k] !== undefined) msg[k] = extra[k];
    if (window.__unfoldTold) window.__unfoldTold.push(msg);
    try {
      if (window.mantle && window.mantle.call) return Promise.resolve(window.mantle.call('unfold.page', msg)).catch(function () {});
    } catch (_) { /* main is gone: the hard timers still end everything */ }
    return Promise.resolve();
  }

  /** layers: two frames with every layer drawn at a level black hides, so the first moving frame does
   * not also pay for uploading the textures */
  function warm() {
    pose('warming', [[stage, { opacity: 1 }], [ground, { opacity: 0.004 }], [soft, { opacity: 0.004 }], [smear, { opacity: 0.004 }]]);
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  }

  function fadeOut(name, D, seq, event, extra) {
    var st0 = now(stage);
    return run(name, D, [[stage, function (t) { return { opacity: st0 * (1 - E.fadeOut(t)) }; }]], GONE, true).then(function (r) {
      S.pose = 'gone'; stage.setAttribute('data-pose', 'gone');
      return tell(seq, event, Object.assign({ stats: r.stats, timedOut: r.timedOut }, extra || {}));
    });
  }

  /** which technique a play or cover gets: 'css' and 'layers' when asked (the bench), else gl when
   * the graphics card can, else layers with the reason */
  function pick(c) {
    if (c.tech === 'css' || c.tech === 'layers') return { name: c.tech, fallback: null };
    if (G.ok && !G.lost) return { name: 'gl', fallback: null };
    return { name: 'layers', fallback: G.why || NO_GL };
  }

  /** the picture made ready for `tech` (gl may fall back to layers here, with the reason) */
  function ready(c, tech) {
    if (tech.name !== 'gl') return prepare(c.still);
    return glPrepare(c.still).catch(function (err) {
      if (err && err.plain) throw err;          // the picture itself is bad: no technique can show it
      S.errors.push('gl: ' + String(err && err.message || err).split('\n')[0]);
      glFree();
      tech.name = 'layers';
      tech.fallback = G.lost ? G.why : 'the graphics card could not take the picture, so the simpler unfold played';
      return prepare(c.still);
    });
  }

  function hideGl() { glCanvas.style.visibility = 'hidden'; }

  var ops = {
    arm: function (c) {
      pose('armed', [[stage, { opacity: 1 }]]);
      hideGl(); S.drawn = null;
      return tell(c.seq, 'armed');
    },
    play: function (c) {
      var D = ms('--unfold-' + (c.size || 'full') + '-ms', 700);
      if (!c.still || reduced() || c.reduced) return fadeOut('fading', 160, c.seq, 'played', { technique: 'fade', reduced: reduced() || !!c.reduced });
      var prepMs = 0, tech = pick(c), parts = null, firstAt = 0;
      S.prep = null;
      return ready(c, tech).then(function (m) {
        prepMs = m;
        parts = S.prep ? { decode: S.prep.decode, build: S.prep.build } : {};
        if (S.op !== c) return null;   // finish/skip came while the picture was decoding
        if (tech.name !== 'gl') return warm();
        pose('opening', [[stage, { opacity: 1 }]]);
        firstAt = performance.now();
        return glFirst(playFrame(0));
      }).then(function () {
        if (S.op !== c) return null;
        if (parts && firstAt) parts.first = Math.round(performance.now() - firstAt);   // the first frame up to the clock's start
        S.drawn = tech.name;
        if (tech.name === 'css') return cssPlay(D);
        if (tech.name === 'gl') return run('opening', D, [], GONE, false, function (t) { show(playFrame(t)); });
        hideGl();
        pose('opening', [[stage, { opacity: 1 }], [soft, { opacity: 1 }], [smear, { opacity: 0.85 }],
          [leaf, { transform: 'scaleX(' + SEAM + ')' }], [leafIn, { transform: 'scaleX(' + (1 / SEAM) + ')' }]]);
        return run('opening', D, unfoldTracks(D), GONE);
      }).then(function (r) {
        if (!r) return null;
        if (!r.cancelled) { S.pose = 'gone'; stage.setAttribute('data-pose', 'gone'); }
        S.runs++;
        return tell(c.seq, 'played', { stats: r.stats, timedOut: r.timedOut, prepMs: prepMs, prep: parts || undefined, technique: tech.name,
          fallback: tech.fallback || (tech.name === 'gl' && G.lost ? G.why : undefined), still: [S.stillW, S.stillH] });
      }, function (err) {
        var why = said(err, 'the picture of the screen could not be shown');
        S.errors.push(why);
        return fadeOut('fading', 160, c.seq, 'played', { technique: 'fade', error: why });
      });
    },
    cover: function (c) {
      var F = ms('--unfold-fold-ms', 420);
      if (!c.still) return tell(c.seq, 'covered', { ok: false, error: 'no picture of the screen came' });
      var prepMs = 0, tech = pick(c);
      if (tech.name === 'css') tech.name = 'layers';
      return ready(c, tech).then(function (m) {
        prepMs = m;
        if (S.op !== c) return null;
        S.drawn = tech.name;
        if (tech.name === 'gl') {
          pose('covering', [[stage, { opacity: 1 }]]);
          return glFirst(coverFrame(0)).then(function () {
            if (S.op !== c) return null;
            var curve = reduced() ? function (t) { return t; } : E.fadeIn;   // eases into the covered state
            return run('covering', reduced() ? 120 : F, [], null, false, function (t) { show(coverFrame(curve(t))); });
          });
        }
        hideGl();
        pose('covering', [[stage, { opacity: 1 }]].concat(OPEN_SHARP));
        if (reduced()) return run('covering', 120, [[ground, function (t) { return { opacity: t }; }], [tint, function (t) { return { opacity: coverTint() * t }; }]], null);
        return run('covering', F, coverTracks(), null);
      }).then(function (r) {
        if (!r) return null;
        if (!r.cancelled) { S.pose = 'covered'; stage.setAttribute('data-pose', 'covered'); }
        return tell(c.seq, 'covered', { ok: true, stats: r.stats, timedOut: r.timedOut, prepMs: prepMs, technique: tech.name,
          fallback: tech.fallback || (tech.name === 'gl' && G.lost ? G.why : undefined) });
      }, function (err) {
        var why = said(err, 'the picture of the screen could not be shown');
        S.errors.push(why);
        return fadeOut('fading', 120, c.seq, 'covered', { ok: false, error: why });
      });
    },
    reveal: function (c) {
      var R = reduced() ? 120 : (c.ms || ms('--unfold-reveal-ms', 200));
      if (S.pose === 'gone' || S.pose === 'parked') return tell(c.seq, 'revealed', { already: true });
      var after = function (r) {
        S.pose = 'gone'; stage.setAttribute('data-pose', 'gone');
        return tell(c.seq, 'revealed', { stats: r.stats, timedOut: r.timedOut });
      };
      if (S.drawn === 'gl' && S.glLast && S.glLast.cover) {
        stopAnims(true);   // the fold holds where it got to, and the focus comes back from there
        var u0 = S.glLast.fold, st0 = now(stage);
        return run('revealing', R, [], GONE, true, function (t) { show(coverFrame(u0 * (1 - E.fadeIn(t)), st0 * (1 - E.fadeIn(span(t, 0.3, 1))))); }).then(after);
      }
      if (S.drawn === 'gl') return fadeOut('revealing', R, c.seq, 'revealed');   // a play under way: fade from where it is
      return run('revealing', R, revealTracks(), GONE, true).then(after);
    },
    finish: function (c) { return fadeOut('finishing', 90, c.seq, 'finished'); },
    skip: function (c) { return fadeOut('fading', 160, c.seq, 'skipped', { reason: c.reason || null }); },
    park: function (c) {
      pose('parked', [[stage, { opacity: 0 }]]);
      drop(); glDrop(); S.drawn = null; S.glLast = null;
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
      return { pose: S.pose, seq: S.seq, still: S.still, stillW: S.stillW, stillH: S.stillH, running: S.anims.length + (S.loop ? 1 : 0),
        stage: now(stage), runs: S.runs, errors: S.errors.slice(-5), reduced: reduced(), theme: document.documentElement.dataset.theme || 'light',
        technique: S.drawn, frame: S.glLast, glShown: glCanvas.style.visibility === 'visible' };
    },
    stats: function () { return S.lastStats; },
    gl: function () {
      return { ok: G.ok, why: G.why, lost: G.lost, ready: G.ready, warmMs: G.warmMs, builds: G.builds, max: G.max || null,
        version: G.gl ? (typeof WebGL2RenderingContext !== 'undefined' && G.gl instanceof WebGL2RenderingContext ? 2 : 1) : 0,
        atlas: G.L ? [G.L.AW, G.L.AH] : null, levels: G.L ? G.L.lv.map(function (l) { return [l.sig, l.w, l.h]; }) : null,
        canvas: [glCanvas.width, glCanvas.height] };
    },
    /** the gl frame on screen, drawn again and read back at once (the surface is cleared after it is
     * shown): one row y of canvas pixels from x0 to x1, as [[r,g,b], ...]; null when gl is not drawing.
     * Tests only; nothing calls it in use, and nothing it returns leaves the page but the numbers. */
    probe: function (y, x0, x1) {
      if (!G.ready || G.lost || !S.glLast) return null;
      glDraw(S.glLast);
      var gl = G.gl, w = Math.max(1, Math.round(x1 - x0)), px = new Uint8Array(w * 4), out = [];
      gl.readPixels(Math.round(x0), glCanvas.height - 1 - Math.round(y), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (var i = 0; i < w; i++) out.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);
      return out;
    },
    /** hold every timeline at fraction f (null lets go; hold: the hard timer waits too); resolves
     * once the held frame is drawn */
    freeze: function (f, hold) {
      S.freezeT = f == null ? null : clamp(f);
      S.freezeHold = S.freezeT != null && !!hold;
      if (S.freezeT != null) S.anims.forEach(function (a) { try { a.pause(); a.currentTime = S.freezeT * a.effect.getTiming().duration; } catch (_) { /* gone */ } });
      return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(window.__unfold.state()); }); }); });
    },
    cmd: cmd,
  };

  if (window.mantle && window.mantle.on) window.mantle.on('unfold.cmd', cmd);
  curves();
  pose('parked', [[stage, { opacity: 0 }]]);
  hideGl();
  sizeCanvas();
  if (glInit()) glWarm();
  tell(0, 'ready', { technique: G.ok ? 'gl' : 'layers', fallback: G.ok ? undefined : G.why, warmMs: G.warmMs == null ? undefined : G.warmMs });

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
    window.__bench = { done: false, tech: bench, results: [], gl: window.__unfold.gl() };
    var runs = Math.max(1, Math.min(20, parseInt(Q.get('runs'), 10) || 6));
    var idle = Math.max(0, Math.min(30000, parseInt(Q.get('idle'), 10) || 600));   // the page sits parked this long first
    var still = drawnDesktop();
    var go = function (i) {
      if (i >= runs) { window.__bench.done = true; return; }
      cmd({ op: 'arm', seq: i * 3 + 1 });
      setTimeout(function () {
        var c = { op: 'play', seq: i * 3 + 2, still: still, size: 'full', tech: bench };
        cmd(c).then(function () {
          var told = (window.__unfoldTold || []).filter(function (m) { return m.seq === c.seq; })[0] || {};
          var st = S.lastStats ? Object.assign({ prepMs: told.prepMs, technique: told.technique, fallback: told.fallback }, S.lastStats) : null;
          window.__bench.results.push(st);
          cmd({ op: 'park', seq: i * 3 + 3 });   // as main does after every play: the next play builds again
          setTimeout(function () { go(i + 1); }, 350);
        });
      }, 250);
    };
    window.__unfoldTold = [];
    setTimeout(function () { go(0); }, idle);
  }
})();

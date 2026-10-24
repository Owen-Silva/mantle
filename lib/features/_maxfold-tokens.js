'use strict';
/* _maxfold-tokens.js - the numbers the maximize/restore unfold plays with, read from the shared CSS
 * (lane unfold-max, 2026-10-23). Pure: every function takes CSS TEXT, so lib/features/maxfold.test.js
 * proves it against the real files and against broken ones. lib/features/maxfold.js reads the two
 * files at install and hands the result to the sidecar (sidecar/MaxFold.cs) as maxfold.config.
 *
 * Read (scratch/SPEC-LOOK.md "Main reads"), each with a documented fallback that is SAID once:
 *   ms        ui/shared/unfold.css :root --unfold-quick-ms                         else 240
 *   curve     unfold.css --unfold-quick-in, else --unfold-in (today var(--m-spring, ...)), else
 *             glass-light.css :root --m-spring; a linear() list or a cubic-bezier(), resampled to
 *             41 evenly spaced points                                               else ease-out cubic
 *   tint      unfold.css --unfold-tint, else glass-light.css :root --lg-acc           else #4436E8
 *   blurFrac  .018 * clamp(2 * quickBlur / fullBlur, .3, 1) from --unfold-quick-blur and
 *             --unfold-full-blur, capped at .027                                     else .012
 * Tolerant on purpose: lane unfold-unlock owns those files and may rename or add tokens. A missing or
 * bad value is never an error, only a fallback with its reason.
 *
 * The geometry constants (baseMix, innerDark, darkCap, strips, cover, holdMs) are not in the CSS:
 * they are the iPhone Duo reconstruction's, fixed here (SPEC-LOOK.md).
 */

const FALLBACK = Object.freeze({ ms: 240, tint: Object.freeze({ r: 0x44, g: 0x36, b: 0xE8 }), blurFrac: 0.012 });
const BLUR_FRAC_MAX = 0.027;
const CURVE_POINTS = 41;
const GEOMETRY = Object.freeze({ baseMix: 0.06, innerDark: 0.18, darkCap: 0.32, strips: 24, cover: 'left', holdMs: 300 });

/** CSS text without comments. */
function stripComments(css) {
  return String(css || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Custom properties of every rule whose selector list has a plain `:root` (not `:root[...]`),
 *  later rules winning. `{ '--name': 'value' }`. Never throws. */
function rootVars(css, selectorTest) {
  const test = selectorTest || ((sel) => sel.split(',').some((s) => s.trim() === ':root'));
  const out = {};
  const text = stripComments(css);
  // Flat walk: a selector, then its block. Nested blocks (@media) are entered, their own selectors kept.
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const sel = m[1].trim();
    if (!test(sel)) continue;
    for (const decl of splitDecls(m[2])) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim();
      if (!/^--[A-Za-z0-9_-]+$/.test(name)) continue;
      out[name] = decl.slice(i + 1).trim().replace(/\s*!important$/i, '').replace(/\s+/g, ' ');
    }
  }
  return out;
}

/** Split a block body on `;` outside parentheses. */
function splitDecls(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(body)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Replace every var(--x[, fallback]) using `vars`, recursively (depth-limited, so a cycle ends).
 *  An unknown var with no fallback leaves null (the whole value is unusable). */
function resolveVars(value, vars, depth) {
  const d = depth || 0;
  if (value == null) return null;
  let s = String(value);
  if (d > 12) return null;
  for (let guard = 0; guard < 50; guard++) {
    const at = s.indexOf('var(');
    if (at < 0) return s.trim();
    // the matching close paren
    let depthP = 0;
    let end = -1;
    for (let i = at + 3; i < s.length; i++) {
      if (s[i] === '(') depthP++;
      else if (s[i] === ')') { depthP--; if (depthP === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    const inner = s.slice(at + 4, end);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fb = comma < 0 ? null : inner.slice(comma + 1).trim();
    let rep = Object.prototype.hasOwnProperty.call(vars || {}, name) ? resolveVars(vars[name], vars, d + 1) : null;
    if (rep == null && fb != null) rep = resolveVars(fb, vars, d + 1);
    if (rep == null) return null;
    s = s.slice(0, at) + rep + s.slice(end + 1);
  }
  return null;
}

function topLevelComma(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) return i;
  }
  return -1;
}

/** "240ms" / "0.24s" -> 240. Only a sane quick duration (40..2000 ms), else null. */
function parseMs(v) {
  const m = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/i.exec(String(v == null ? '' : v));
  if (!m) return null;
  const ms = Number(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1);
  return Number.isFinite(ms) && ms >= 40 && ms <= 2000 ? Math.round(ms) : null;
}

/** "6px" -> 6 (0..500), else null. A bare 0 is 0. */
function parsePx(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '0') return 0;
  const m = /^(\d*\.?\d+)\s*px$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n <= 500 ? n : null;
}

/** #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() -> {r,g,b} (alpha dropped: the tint is a hue), else null. */
function parseColor(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16) };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(s);
  if (m) {
    const c = [m[1], m[2], m[3]].map(Number);
    if (c.every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) return { r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]) };
  }
  return null;
}

/** Evaluate a list of evenly spaced points at p (0..1), piecewise linear. */
function sampleCurve(points, p) {
  const pts = Array.isArray(points) && points.length >= 2 ? points : easeOutCubic();
  const t = Math.min(1, Math.max(0, Number(p) || 0)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(t));
  return pts[i] + (pts[i + 1] - pts[i]) * (t - i);
}

function round4(x) { return Math.round(x * 10000) / 10000; }

/** The fallback curve: ease-out cubic, 1 - (1-p)^3, as n evenly spaced points. */
function easeOutCubic(n) {
  const k = n || CURVE_POINTS;
  return Array.from({ length: k }, (_, i) => round4(1 - Math.pow(1 - i / (k - 1), 3)));
}

/** linear(0, 0.5 25%, 1) -> n evenly spaced points (CSS linear() rules: missing positions spread
 *  evenly between known ones, first 0 % and last 100 % when absent). Values must be -1..3. Else null. */
function parseLinear(v, n) {
  const m = /^\s*linear\(([\s\S]*)\)\s*$/i.exec(String(v == null ? '' : v));
  if (!m) return null;
  const stops = [];
  for (const raw of m[1].split(',')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (!parts.length || parts.length > 3) return null;
    const y = Number(parts[0]);
    if (!Number.isFinite(y) || y < -1 || y > 3) return null;
    const pos = parts.slice(1).map((q) => { const pm = /^(-?\d*\.?\d+)%$/.exec(q); return pm ? Number(pm[1]) / 100 : NaN; });
    if (pos.some((x) => !Number.isFinite(x))) return null;
    if (!pos.length) stops.push({ y, x: null });
    else for (const x of pos) stops.push({ y, x });
  }
  if (stops.length < 2) return null;
  if (stops[0].x == null) stops[0].x = 0;
  if (stops[stops.length - 1].x == null) stops[stops.length - 1].x = Math.max(1, ...stops.map((s) => (s.x == null ? 0 : s.x)));
  // a position below an earlier one is raised to it (the CSS rule)
  let maxX = -Infinity;
  for (const s of stops) if (s.x != null) { if (s.x < maxX) s.x = maxX; maxX = s.x; }
  // spread the missing ones
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].x != null) continue;
    let j = i;
    while (stops[j].x == null) j++;
    const a = stops[i - 1].x;
    const b = stops[j].x;
    for (let k = i; k < j; k++) stops[k].x = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  const k = n || CURVE_POINTS;
  // CSS: the LAST stop at or before x, then a straight line to the next one (coinciding stops = a step).
  const at = (x) => {
    if (x < stops[0].x) return stops[0].y;
    let i = 0;
    while (i + 1 < stops.length && stops[i + 1].x <= x) i++;
    if (i === stops.length - 1) return stops[i].y;
    const a = stops[i];
    const b = stops[i + 1];
    return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  };
  return Array.from({ length: k }, (_, i) => round4(at(i / (k - 1))));
}

const NAMED = { ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1], linear: [0, 0, 1, 1] };

/** cubic-bezier(x1,y1,x2,y2) (or a named easing) -> n evenly spaced points, else null. */
function parseCubicBezier(v, n) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  let c = NAMED[s] || null;
  if (!c) {
    const m = /^cubic-bezier\(([^)]*)\)$/.exec(s);
    if (!m) return null;
    c = m[1].split(',').map((q) => Number(q.trim()));
    if (c.length !== 4 || !c.every(Number.isFinite) || c[0] < 0 || c[0] > 1 || c[2] < 0 || c[2] > 1) return null;
  }
  const [x1, y1, x2, y2] = c;
  const bez = (t, a, b) => 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
  const k = n || CURVE_POINTS;
  return Array.from({ length: k }, (_, i) => {
    const x = i / (k - 1);
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (bez(mid, x1, x2) < x) lo = mid; else hi = mid; }
    return round4(bez((lo + hi) / 2, y1, y2));
  });
}

/** Any easing value -> points, else null. */
function parseEasing(v, n) {
  return parseLinear(v, n) || parseCubicBezier(v, n);
}

/**
 * Both files' text -> the tokens, and `fallbacks`: one plain line per value that fell back.
 * Missing text (a file that could not be read) is '' and every value falls back, said.
 */
function readTokens(unfoldCss, glassCss) {
  const u = rootVars(unfoldCss);
  const g = rootVars(glassCss);
  const vars = Object.assign({}, g, u); // unfold.css's own names win; var() chains reach glass-light
  const fallbacks = [];
  const get = (name) => (Object.prototype.hasOwnProperty.call(vars, name) ? resolveVars(vars[name], vars) : null);

  let ms = parseMs(get('--unfold-quick-ms'));
  if (ms == null) { ms = FALLBACK.ms; fallbacks.push(`--unfold-quick-ms ${vars['--unfold-quick-ms'] == null ? 'is missing' : 'is not a duration'}, so ${FALLBACK.ms} ms`); }

  let curve = null;
  let curveFrom = null;
  for (const name of ['--unfold-quick-in', '--unfold-in', '--m-spring']) {
    if (vars[name] == null) continue;
    const pts = parseEasing(get(name));
    if (pts) { curve = pts; curveFrom = name; break; }
  }
  if (!curve) { curve = easeOutCubic(); curveFrom = 'fallback'; fallbacks.push('no usable --unfold-in or --m-spring curve, so ease-out cubic'); }

  let tint = null;
  let tintFrom = null;
  if (u['--unfold-tint'] != null) { tint = parseColor(get('--unfold-tint')); tintFrom = tint ? '--unfold-tint' : null; }
  if (!tint && g['--lg-acc'] != null) { tint = parseColor(resolveVars(g['--lg-acc'], g)); tintFrom = tint ? '--lg-acc' : null; }
  if (!tint) { tint = Object.assign({}, FALLBACK.tint); tintFrom = 'fallback'; fallbacks.push('no usable --unfold-tint or --lg-acc colour, so Mantle indigo #4436E8'); }

  const quick = parsePx(get('--unfold-quick-blur'));
  const full = parsePx(get('--unfold-full-blur'));
  let blurFrac;
  let blurFrom;
  if (quick != null && full != null && full > 0) {
    blurFrac = Math.min(BLUR_FRAC_MAX, round4(0.018 * Math.min(1, Math.max(0.3, (2 * quick) / full))));
    blurFrom = 'tokens';
  } else {
    blurFrac = FALLBACK.blurFrac;
    blurFrom = 'fallback';
    fallbacks.push(`--unfold-quick-blur or --unfold-full-blur is missing or not px, so a blur of ${FALLBACK.blurFrac} of the width`);
  }
  return { ms, curve, curveFrom, tint, tintFrom, blurFrac, blurFrom, fallbacks };
}

/** The tokens -> the maxfold.config payload (scratch/SPEC-LOOK.md "Config"). `on:false` is just that. */
function buildConfig(tokens, opts) {
  const o = opts || {};
  if (!o.on) return { on: false };
  const t = tokens || readTokens('', '');
  const cfg = Object.assign({
    on: true,
    ms: t.ms,
    curve: t.curve.slice(),
    blurFrac: t.blurFrac,
    tint: { r: t.tint.r, g: t.tint.g, b: t.tint.b },
  }, GEOMETRY);
  if (o.test) cfg.invisible = true;
  return cfg;
}

module.exports = {
  FALLBACK, GEOMETRY, BLUR_FRAC_MAX, CURVE_POINTS,
  stripComments, rootVars, resolveVars, parseMs, parsePx, parseColor,
  parseLinear, parseCubicBezier, parseEasing, easeOutCubic, sampleCurve,
  readTokens, buildConfig,
};

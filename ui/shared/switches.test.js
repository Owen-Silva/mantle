require('../../tools/dev-env.js').lowcpu();
/* switches.test.js - ONE switch across Mantle, both themes (lane mantle-premium-switches, 2026-10-16).
 *
 * Mantle had five switch implementations that disagreed (Settings 40 x 20 travelling 20 px on 160 ms,
 * game mode and the Spotify row 26 x 14 with an 8 px knob, the record card on a 380 ms spring, the top
 * bar's App power at 32 x 18 on 120 ms). All five are now Helm's toggle (helm ui/styles/components.css
 * .toggle) in light AND dark: a 32 x 18 track with a 1px edge (a border, or an inset ring where the file
 * draws its edge with box-shadow), pill ends; a 12 x 12 knob 3 px in from the outer edge; on = the knob
 * at translateX(14px); the knob travels on the shared spring (--m-spring over --m-dur-xs, 240 ms) and
 * wears --shadow-knob; reduced motion = the knob does not travel-animate. Each theme keeps its colours.
 *
 * WHAT: headless Chromium over the REAL pages (file://, never Electron, never a window of the user's). Where
 * a page does not render the switch at load, the minimal markup with the real class names is injected
 * (every switch selector is unscoped, so the real CSS applies). Each site is read in light and in dark
 * (<html data-theme>, flipped live): first the motion (transitions live, and again under
 * prefers-reduced-motion: reduce), then the geometry with transitions off (a test-only style, CSP
 * bypassed for it) so the values read are the settled ones. Plus static checks over the CSS files.
 *
 *   node ui/shared/switches.test.js     -> "SWITCHES TEST: n passed, m failed"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../bar/page-harness.js');
const t = H.suite('SWITCHES TEST');
const UIDIR = path.resolve(__dirname, '..');
const UI = 'file:///' + UIDIR.replace(/\\/g, '/') + '/';

/* a wrapper on top of the page for injected markup (no layout of the page's own can squeeze it) */
const wrap = (id, html) => "if (!document.getElementById('" + id + "')) { var w = document.createElement('div'); w.id = '" + id + "';" +
  " w.style.cssText = 'position:fixed;left:8px;top:8px;width:320px;z-index:2147483647;display:block;visibility:visible;opacity:1';" +
  " w.innerHTML = '" + html + "'; document.body.appendChild(w); }";

/* name, page, setup (idempotent, run before every read), track selector, knob selector, knob pseudo,
   and the source that sets the state from a boolean ON (the class/attribute the page's JS sets) */
const SITES = [
  ['Settings switch (.sw)', 'settings/index.html',
    wrap('__swt', '<button type="button" class="sw" role="switch" aria-checked="false"></button>'),
    '#__swt .sw', '#__swt .sw', '::after',
    "document.querySelector('#__swt .sw').setAttribute('aria-checked', ON ? 'true' : 'false')"],
  ['game mode switch (.gmtrack)', 'bar/index.html?mode=pill',
    wrap('__swt', '<div class="gmline"><button type="button" class="gmswitch" role="switch"><span class="gmtrack" aria-hidden="true"><span class="gmknob"></span></span><span class="gmswtext">Turn on</span></button></div>'),
    '#__swt .gmtrack', '#__swt .gmknob', null,
    "document.querySelector('#__swt .gmswitch').classList.toggle('on', !!ON)"],
  ['Spotify auto-pause switch (.spq-apsw-track)', 'bar/index.html?mode=pill',
    wrap('__swt2', '<div class="spq-apsw"><button type="button" class="spq-apsw-btn" role="switch"><span class="spq-apsw-text">Pause Spotify for videos</span><span class="spq-apsw-track" aria-hidden="true"><span class="spq-apsw-knob"></span></span></button></div>'),
    '#__swt2 .spq-apsw-track', '#__swt2 .spq-apsw-knob', null,
    "document.querySelector('#__swt2 .spq-apsw-btn').classList.toggle('on', !!ON)"],
  ['record card Microphone switch (.sw i)', 'clips/record.html',
    "var c = document.getElementById('card'); if (c) c.hidden = false;",
    '#mic .sw', '#mic .sw i', null,
    "document.getElementById('mic').setAttribute('aria-checked', ON ? 'true' : 'false')"],
  ['top bar App power switch (.ap-sw)', 'topbar/index.html',
    wrap('__swt', '<div class="ap-ln"><span class="ap-lt">Eco</span><button type="button" class="ap-sw" role="switch" data-f="eco" aria-checked="false"><i></i></button></div>'),
    '#__swt .ap-sw', '#__swt .ap-sw i', null,
    "document.querySelector('#__swt .ap-sw').setAttribute('aria-checked', ON ? 'true' : 'false')"],
];

/* split a computed list ("a, linear(0, 0.1), b") at its top-level commas */
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(s || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/* {property: {dur, fn}} from computed transition-property / -duration / -timing-function (lists repeat) */
function transitions(tr) {
  const props = splitTop(tr.prop), durs = splitTop(tr.dur), fns = splitTop(tr.fn);
  const out = {};
  props.forEach((p, i) => { out[p] = { dur: durs[i % durs.length], fn: fns[i % fns.length] }; });
  return out;
}
const secs = (d) => (/ms$/.test(d) ? parseFloat(d) / 1000 : parseFloat(d)) || 0;

/* the page-side reader (serialised into the page): theme on, setup, state, then the computed values */
function readInPage([th, setupSrc, trackSel, knobSel, pseudo, stateSrc, on]) {
  if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
  window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: th || 'light' } }));
  try { if (setupSrc) (0, eval)(setupSrc); } catch (e) { /* page without its bridge */ }
  try { (0, eval)('(function (ON) { ' + stateSrc + ' })')(on); } catch (e) { return { err: 'state: ' + e.message }; }
  const track = document.querySelector(trackSel), knobEl = document.querySelector(knobSel);
  if (!track || !knobEl) return null;
  void track.offsetWidth;   // flush style
  const tcs = getComputedStyle(track), kcs = getComputedStyle(knobEl, pseudo || null);
  const r = track.getBoundingClientRect();
  const root = getComputedStyle(document.documentElement);
  const probe = (name) => { const d = document.createElement('div'); d.style.boxShadow = root.getPropertyValue(name).trim(); document.body.appendChild(d); const v = getComputedStyle(d).boxShadow; d.remove(); return v; };
  return {
    track: { w: r.width, h: r.height, cw: tcs.width, ch: tcs.height, bl: tcs.borderLeftWidth, bt: tcs.borderTopWidth,
      radius: tcs.borderTopLeftRadius, shadow: tcs.boxShadow, display: tcs.display,
      tr: { prop: tcs.transitionProperty, dur: tcs.transitionDuration, fn: tcs.transitionTimingFunction } },
    knob: { w: kcs.width, h: kcs.height, top: kcs.top, left: kcs.left, transform: kcs.transform, shadow: kcs.boxShadow,
      content: kcs.content, tr: { prop: kcs.transitionProperty, dur: kcs.transitionDuration, fn: kcs.transitionTimingFunction } },
    shadowKnob: probe('--shadow-knob'),
  };
}

async function site(browser, [name, page, setup, trackSel, knobSel, pseudo, stateSrc]) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 800 }, bypassCSP: true });
  const p = await ctx.newPage();
  p.on('pageerror', () => { /* a page without its bridge may complain; the CSS is what is read */ });
  try {
    await p.goto(UI + page, { waitUntil: 'load' });
    await p.waitForTimeout(300);
    const read = (theme, on) => p.evaluate(readInPage, [theme, setup, trackSel, knobSel, pseudo, stateSrc, on]);
    const themes = [['light', null], ['dark', 'dark']];

    /* 1. motion, transitions live */
    for (const [tn, th] of themes) {
      const r = await read(th, false);
      if (!t.check(`${name} [${tn}]: the switch is on the page (${trackSel})`, r && !r.err, r && r.err || page)) return;
      const k = transitions(r.knob.tr), tr = transitions(r.track.tr);
      const kt = k.transform || {};
      t.check(`${name} [${tn}]: knob travels on the shared spring (transform, linear(), 0.24s)`,
        secs(kt.dur) === 0.24 && /^linear\(/.test(kt.fn || ''), r.knob.tr);
      const kb = k['background-color'] || {};
      t.check(`${name} [${tn}]: knob colour cross-fades over the UI beat (background-color 0.12s, cubic-bezier(0.2, 0, 0, 1))`,
        secs(kb.dur) === 0.12 && /cubic-bezier\(0\.2, 0, 0, 1\)/.test(kb.fn || ''), r.knob.tr);
      const tb = tr['background-color'] || {};
      t.check(`${name} [${tn}]: track colour cross-fades over the UI beat (background-color 0.12s)`,
        secs(tb.dur) === 0.12 && /cubic-bezier\(0\.2, 0, 0, 1\)/.test(tb.fn || ''), r.track.tr);
      t.check(`${name} [${tn}]: the track itself never animates its size or position`,
        !Object.keys(tr).some((pr) => /^(all|width|height|transform|left|top)$/.test(pr) && secs(tr[pr].dur) > 0), r.track.tr);
    }

    /* 2. reduced motion: the knob does not travel-animate */
    await p.emulateMedia({ reducedMotion: 'reduce' });
    for (const [tn, th] of themes) {
      const r = await read(th, false);
      if (!r || r.err) { t.check(`${name} [${tn}, reduced motion]: read`, false, r && r.err); continue; }
      const k = transitions(r.knob.tr);
      t.check(`${name} [${tn}, reduced motion]: the knob does not travel-animate`,
        !Object.keys(k).some((pr) => /^(all|transform|left|translate)$/.test(pr) && secs(k[pr].dur) > 0), r.knob.tr);
    }
    await p.emulateMedia({ reducedMotion: 'no-preference' });

    /* 3. geometry, settled */
    await p.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
    for (const [tn, th] of themes) {
      const off = await read(th, false);
      const on = await read(th, true);
      if (!off || off.err || !on || on.err) { t.check(`${name} [${tn}]: geometry read`, false, (off && off.err) || (on && on.err)); continue; }
      const T = off.track, K = off.knob;
      t.check(`${name} [${tn}]: track is 32 x 18 outer`, T.w === 32 && T.h === 18, { w: T.w, h: T.h, cw: T.cw, ch: T.ch, display: T.display });
      t.check(`${name} [${tn}]: track has a 1px edge (border, or an inset 1px ring)`,
        T.bt === '1px' || /0px 0px 0px 1px inset/.test(T.shadow), { border: T.bt, shadow: T.shadow });
      t.check(`${name} [${tn}]: track has pill ends (radius >= 9px)`, parseFloat(T.radius) >= 9, T.radius);
      t.check(`${name} [${tn}]: knob is 12 x 12`, K.w === '12px' && K.h === '12px', { w: K.w, h: K.h });
      const inL = parseFloat(K.left) + parseFloat(T.bl), inT = parseFloat(K.top) + parseFloat(T.bt);
      t.check(`${name} [${tn}]: knob sits 3px in from the outer edge`, inL === 3 && inT === 3, { left: K.left, top: K.top, border: T.bl });
      t.check(`${name} [${tn}]: off = knob at rest (no transform)`, K.transform === 'none', K.transform);
      t.check(`${name} [${tn}]: on = translateX(14px)`, on.knob.transform === 'matrix(1, 0, 0, 1, 14, 0)', on.knob.transform);
      t.check(`${name} [${tn}]: knob wears this theme's --shadow-knob`,
        off.shadowKnob && off.shadowKnob !== 'none' && K.shadow === off.shadowKnob && on.knob.shadow === off.shadowKnob,
        { off: K.shadow, on: on.knob.shadow, want: off.shadowKnob });
      t.check(`${name} [${tn}]: on and off keep the same geometry`, on.track.w === 32 && on.track.h === 18 && on.knob.w === '12px', { track: [on.track.w, on.track.h], knob: on.knob.w });
    }
  } catch (e) {
    t.check(`${name}: the site run finished`, false, e && e.stack || String(e));
  } finally {
    await ctx.close();
  }
}

/* ---- static: the CSS itself --------------------------------------------------------------------- */
const CSS = {
  settings: 'settings/settings.css', gamemode: 'bar/gamemode.css', spotify: 'bar/spotify.css',
  record: 'clips/record.css', topbar: 'topbar/topbar.css', emoji: 'emoji/emoji.css', osd: 'osd/osd.css',
};
const src = {};
for (const [k, f] of Object.entries(CSS)) src[k] = fs.readFileSync(path.join(UIDIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/* [selector, body] for every plain rule (an @media's inner rules included) */
function rules(css) {
  const out = [];
  for (const chunk of css.split('}')) {
    const parts = chunk.split('{');
    if (parts.length < 2) continue;
    out.push([parts[parts.length - 2].trim(), parts[parts.length - 1]]);
  }
  return out;
}
function staticChecks() {
  /* the old geometry and timings are gone */
  const OLD = [
    ['settings', /translateX\(20px\)/],
    ['gamemode', /translateX\(12px\)/], ['gamemode', /width:\s*26px/], ['gamemode', /width:\s*8px/],
    ['spotify', /translateX\(12px\)/], ['spotify', /width:\s*26px/],
    ['record', /transform 380ms/],
  ];
  for (const [k, re] of OLD) t.check(`static: ${CSS[k]} no longer has ${re}`, !re.test(src[k]));
  /* each switch's base track rule is 32 x 18 */
  const TRACK = [['settings', /^\.sw$/], ['gamemode', /^\.gmtrack$/], ['spotify', /^\.spq-apsw-track$/], ['record', /^\.sw$/], ['topbar', /^\.ap-sw$/]];
  for (const [k, re] of TRACK) {
    const r = rules(src[k]).find(([sel]) => re.test(sel));
    t.check(`static: ${CSS[k]} ${re}: width 32px, height 18px`, !!r && /width:\s*32px/.test(r[1]) && /height:\s*18px/.test(r[1]), r && r[1].trim());
  }
  /* each switch's knob rule is on the shared spring and wears --shadow-knob */
  const KNOB = [['settings', /^\.sw::after$/], ['gamemode', /^\.gmknob$/], ['spotify', /^\.spq-apsw-knob$/], ['record', /^\.sw i$/], ['topbar', /^\.ap-sw i$/]];
  for (const [k, re] of KNOB) {
    const r = rules(src[k]).find(([sel]) => re.test(sel));
    t.check(`static: ${CSS[k]} ${re} rule exists`, !!r);
    if (!r) continue;
    t.check(`static: ${CSS[k]} ${re}: transform var(--m-dur-xs) var(--m-spring)`, /transform var\(--m-dur-xs\) var\(--m-spring\)/.test(r[1]), r[1].trim());
    t.check(`static: ${CSS[k]} ${re}: box-shadow var(--shadow-knob)`, /box-shadow:\s*var\(--shadow-knob\)/.test(r[1]), r[1].trim());
  }
  /* dark keeps colours only: no dark rule on a track/knob re-sizes, moves or re-times it */
  const SW = /\.sw(?![\w-])|\.gmtrack|\.gmknob|\.spq-apsw-track|\.spq-apsw-knob|\.ap-sw(?![\w-])/;
  for (const k of ['settings', 'gamemode', 'spotify', 'record', 'topbar']) {
    const bad = rules(src[k]).filter(([sel, body]) => /data-theme="dark"/.test(sel) && SW.test(sel) && !/\.sw-l/.test(sel)
      && /(^|[;\s])(width|height|top|left|transition)\s*:|translateX\((?!14px)/.test(body));
    t.check(`static: ${CSS[k]}: dark switch rules carry colour only (geometry and motion are the base rule)`, bad.length === 0, bad.map((b) => b[0]).join(' | '));
  }
  /* control shadows: no raw black inside a box-shadow in these files */
  for (const [k, f] of Object.entries(CSS)) {
    const raw = (src[k].match(/box-shadow\s*:[^;}]*/g) || []).filter((d) => /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(d));
    t.check(`static: ${f}: no raw rgba(0, 0, 0, a) in a box-shadow`, raw.length === 0, raw.join(' | '));
  }
  t.check('static: emoji .pill shadow is var(--shadow-ctl)', /\.pill\s*\{[^}]*box-shadow:[^;]*var\(--shadow-ctl\)/.test(src.emoji));
  t.check('static: osd slider thumb shadow is var(--shadow-knob)', /\.level::-webkit-slider-thumb\s*\{[^}]*box-shadow:\s*var\(--shadow-knob\)/.test(src.osd));
}

async function run() {
  staticChecks();
  if (H.gaming()) { console.log('a game is running: browser half skipped'); t.check('not skipped (a game was running)', false); return; }
  await H.withBrowser(async (open) => {
    const pg0 = await open('?mode=pill', { w: 300, h: 100, settle: 20 });
    const browser = pg0.page.context().browser();
    for (const s of SITES) await site(browser, s);
  });
}

run().catch((e) => { t.check('the run finished', false, e && e.stack || String(e)); }).then(() => t.done());

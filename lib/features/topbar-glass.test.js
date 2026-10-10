'use strict';
/* topbar-glass.test.js -- the top bar's frosted backdrop in dark (lane see-topbar, 2026-10-09):
 * the loop (lib/features/_topbar-glass.js), the strip reader (lib/topbar-strip.js) with a fake desktop
 * window, and the page's pure tint solve (ui/topbar/model.js). Plain node, no Electron.
 *   node lib/features/topbar-glass.test.js   -> "TOPBAR GLASS TEST: n passed, m failed" */
const path = require('path');
const fs = require('fs');
const GL = require('./_topbar-glass');
const TS = require(path.join(__dirname, '..', 'topbar-strip.js'));
const M = require(path.join(__dirname, '..', '..', 'ui', 'topbar', 'glass.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };

(async () => {
  /* ---- want: when the bar gets a picture ---- */
  const base = { dark: true, visible: true, pageOk: true, live: true, reserved: true, peek: false, cover: false, stopped: false };
  check('want: dark, shown, over the reserved strip -> on', GL.want(base).on === true);
  check('want: light -> off, nothing read', GL.want(Object.assign({}, base, { dark: false })).on === false && /light/.test(GL.want(Object.assign({}, base, { dark: false })).why));
  const hid = GL.want(Object.assign({}, base, { visible: false }));
  check('want: hidden -> off but the page keeps its picture', hid.on === false && hid.keep === true);
  check('want: a peek (strip let go) -> off, picture dropped', GL.want(Object.assign({}, base, { peek: true })).on === false && GL.want(Object.assign({}, base, { peek: true })).keep === false);
  check('want: over a full-screen window -> off', GL.want(Object.assign({}, base, { cover: true })).on === false);
  check('want: live strip not reserved yet -> off', GL.want(Object.assign({}, base, { reserved: false })).on === false);
  check('want: a test instance never reserves, and still gets a picture', GL.want(Object.assign({}, base, { live: false, reserved: false })).on === true);
  check('want: stopping / page not loaded -> off', !GL.want(Object.assign({}, base, { stopped: true })).on && !GL.want(Object.assign({}, base, { pageOk: false })).on);
  check('want: no app name in any reason', [{ cover: true }, { peek: true }, { reserved: false }].every((p) => !/[A-Z][a-z]+\.exe/.test(GL.want(Object.assign({}, base, p)).why)));

  /* ---- pace: still pictures slow down, moving ones do not ---- */
  let st = { period: GL.FAST_MS, idle: 0 };
  for (let i = 0; i < GL.IDLE_FRAMES - 1; i++) st = GL.pace(st, true);
  check('pace: fewer than IDLE_FRAMES identical pictures stay fast', st.period === GL.FAST_MS);
  st = GL.pace(st, true);
  check('pace: IDLE_FRAMES identical pictures slow to SLOW_MS', st.period === GL.SLOW_MS);
  check('pace: one changed picture is fast again', GL.pace(st, false).period === GL.FAST_MS && GL.pace(st, false).idle === 0);
  check('pace: the fast rate is the bottom bar\'s 4 fps, the slow one a still wallpaper\'s 0.5 fps', GL.FAST_MS === 250 && GL.SLOW_MS === 2000);

  /* ---- makeGlass with a fake clock ---- */
  function rig(reads) {
    const q = [];   // timers: {at, fn, id}
    let now = 0, id = 0;
    const pushed = [], logs = [];
    const c = Object.assign({}, base);
    let n = 0;
    const g = GL.makeGlass({
      read: async () => { const r = typeof reads === 'function' ? reads(n) : reads[Math.min(n, reads.length - 1)]; n++; return r; },
      cond: () => c,
      push: (p) => pushed.push(p),
      log: (l) => logs.push(l),
      later: (ms, fn) => { const t = { at: now + ms, fn, id: ++id }; q.push(t); return t; },
      cancel: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    });
    async function run(ms) {
      const end = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const t = q[0];
        if (!t || t.at > end) break;
        q.shift();
        now = t.at;
        t.fn();
        for (let k = 0; k < 5; k++) await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    }
    return { g, c, pushed, logs, run, reads: () => n, timers: () => q.length };
  }
  const pic = (s) => ({ ok: true, png: 'data:image/png;base64,' + s, under: null, ms: 3 });

  // a still wallpaper: one push, then reads slow down; no identical picture is pushed twice
  let R = rig(() => pic('A'));
  R.g.kick('start');
  await R.run(10000);
  check('loop: a still wallpaper is pushed ONCE', R.pushed.filter((p) => p.png).length === 1, JSON.stringify(R.pushed.map((p) => p.png ? 'png' : 'off')));
  const readsStill = R.reads();
  check('loop: a still wallpaper is read ~2 s apart once settled (10 s -> about 9 + 4 reads, not 40)', readsStill >= 8 && readsStill <= 16, `reads ${readsStill}`);
  check('loop: on is said once in the log', R.logs.filter((l) => /glass: on/.test(l)).length === 1, R.logs.join(' | '));

  // a moving wallpaper (every read different): 4 fps
  R = rig((n) => pic('V' + n));
  R.g.kick('start');
  await R.run(5000);
  check('loop: a moving wallpaper is read and pushed at 4 fps (5 s -> ~20)', R.pushed.length >= 19 && R.pushed.length <= 22, `pushed ${R.pushed.length}`);

  // hidden: off with keep, no reads while hidden, back on with a resend
  R = rig(() => pic('A'));
  R.g.kick('start');
  await R.run(1000);
  R.c.visible = false; R.g.kick('hidden');
  const at = R.reads();
  await R.run(10000);
  check('loop: hidden -> an off that KEEPS the picture, then no reads at all', R.pushed[R.pushed.length - 1].off === true && R.pushed[R.pushed.length - 1].keep === true && R.reads() === at, `reads ${at} -> ${R.reads()}`);
  check('loop: nothing left scheduled while hidden', R.timers() === 0);
  R.c.visible = true; R.g.kick('shown');
  await R.run(300);
  check('loop: shown again -> the picture is sent again at once', R.pushed[R.pushed.length - 1].png && !R.pushed[R.pushed.length - 1].off);

  // over a full-screen window: off, picture dropped, said once
  R.c.cover = true; R.g.kick('cover'); R.g.kick('cover'); R.g.kick('state');
  const offs = R.pushed.filter((p) => p.off && /full-screen/.test(p.why));
  check('loop: over a full-screen window -> one off (not one per kick), picture dropped, not a failure', offs.length === 1 && offs[0].keep === false && offs[0].failure === false);

  // light: nothing is ever read
  R = rig(() => pic('A'));
  R.c.dark = false;
  R.g.kick('start'); R.g.kick('state', true);
  await R.run(5000);
  check('loop: light reads NOTHING', R.reads() === 0 && R.timers() === 0);

  // failures: transient misses are not failures; three real ones are said, with the reason, and it recovers
  R = rig((n) => (n < 2 ? { ok: false, transient: true, reason: 'hidden for a moment' } : n < 6 ? { ok: false, reason: 'the layer is gone' } : pic('B')));
  R.g.kick('start');
  await R.run(600);
  check('loop: transient misses push nothing', R.pushed.length === 0, JSON.stringify(R.pushed));
  await R.run(1200);
  const fail = R.pushed.find((p) => p.off && p.failure);
  check('loop: MAX_FAILS real failures -> off, failure, with the reason', !!fail && fail.why === 'the layer is gone', JSON.stringify(R.pushed));
  check('loop: a failure is logged with its reason', R.logs.some((l) => /flat tint: the layer is gone/.test(l)), R.logs.join(' | '));
  check('loop: status says the failure', R.g.view().failure === true && R.g.view().why === 'the layer is gone');
  await R.run(GL.RETRY_MS * 2 + 500);
  check('loop: it keeps trying and recovers on its own', R.pushed[R.pushed.length - 1].png === pic('B').png && R.g.view().failure === false, JSON.stringify(R.g.view()));
  check('loop: recovery is logged', R.logs.some((l) => /reads again/.test(l)));

  // stop: nothing more
  R = rig(() => pic('A'));
  R.g.kick('start');
  await R.run(500);
  R.g.stop();
  const n0 = R.reads();
  R.g.kick('after stop', true);
  await R.run(5000);
  check('loop: stop() ends it', R.reads() === n0 && R.timers() === 0);

  /* ---- the strip reader, with a fake desktop window ---- */
  check('strip: minAlpha', TS.minAlpha(Buffer.from([1, 2, 3, 255, 1, 2, 3, 7])) === 7 && TS.minAlpha(Buffer.alloc(0)) === 255);
  check('strip: allClear', TS.allClear(Buffer.from([9, 9, 9, 0, 9, 9, 9, 0])) && !TS.allClear(Buffer.from([9, 9, 9, 0, 9, 9, 9, 1])));
  check('strip: the still\'s rows for 28 DIP of an 864 DIP layer at 1/8 (240x135 -> 4 rows)', TS.stillRows(135, 28, 864) === 4 && TS.stillRows(0, 28, 864) === 0);
  function fakeImg(w, h, alpha, tag) {
    return {
      isEmpty: () => w === 0, getSize: () => ({ width: w, height: h }),
      resize: (o) => fakeImg(o.width, o.height, alpha, tag),
      toBitmap: () => { const b = Buffer.alloc(w * h * 4, 80); for (let i = 3; i < b.length; i += 4) b[i] = alpha; return b; },
      toDataURL: () => `data:image/png;base64,${tag}${w}x${h}`,
      crop: (r) => fakeImg(r.width, r.height, 255, tag + 'crop'),
    };
  }
  function fakeWin(o) {
    return {
      isDestroyed: () => !!o.dead, isVisible: () => o.visible !== false,
      getContentBounds: () => ({ x: 0, y: 0, width: 1536, height: 864 }),
      webContents: { capturePage: async (r) => { o.asked = r; if (o.throws) throw new Error('nope'); return fakeImg(o.empty ? 0 : Math.round(r.width * 1.25), Math.round(r.height * 1.25), o.alpha == null ? 255 : o.alpha, 'S'); } },
    };
  }
  const NI = { createFromDataURL: () => fakeImg(240, 135, 255, 'W') };
  let fw = { };
  let rd = TS.makeStripReader({ win: () => fakeWin(fw), still: () => null, nativeImage: NI });
  let r = await rd.read({ h: 28 });
  check('strip: an opaque wallpaper strip -> ok, 1/4 scale, no under', r.ok && r.opaque && r.under === null && r.w === 480 && r.h === 9, JSON.stringify(r));
  check('strip: the rect asked is the top 28 DIP of the layer', fw.asked && fw.asked.x === 0 && fw.asked.y === 0 && fw.asked.width === 1536 && fw.asked.height === 28);
  fw = { alpha: 0 };
  rd = TS.makeStripReader({ win: () => fakeWin(fw), still: () => ({ png: 'data:image/png;base64,WALL' }), nativeImage: NI });
  r = await rd.read({ h: 28 });
  check('strip: a transparent desktop strip -> Windows\' wallpaper still goes under it, cut to the strip', r.ok && !r.opaque && /^data:image\/png;base64,Wcrop240x4$/.test(r.under), JSON.stringify(r));
  rd = TS.makeStripReader({ win: () => fakeWin(fw), still: () => ({ reason: 'the capture was refused' }), nativeImage: NI });
  r = await rd.read({ h: 28 });
  check('strip: transparent and no still -> a failure that says both', !r.ok && !r.transient && /draws no wallpaper/.test(r.reason) && /refused/.test(r.reason), JSON.stringify(r));
  rd = TS.makeStripReader({ win: () => null, still: () => null, nativeImage: NI });
  r = await rd.read({ h: 28 });
  check('strip: no desktop layer -> a failure (not transient)', !r.ok && !r.transient && /no desktop layer/.test(r.reason));
  rd = TS.makeStripReader({ win: () => fakeWin({ visible: false }), still: () => null, nativeImage: NI });
  r = await rd.read({ h: 28 });
  check('strip: the layer hidden for a re-shoot -> transient', !r.ok && r.transient === true);
  rd = TS.makeStripReader({ win: () => fakeWin({ empty: true }), still: () => null, nativeImage: NI });
  r = await rd.read({ h: 28 });
  check('strip: an empty frame -> transient', !r.ok && r.transient === true);
  rd = TS.makeStripReader({ win: () => fakeWin({ throws: true }), still: () => null, nativeImage: NI });
  r = await rd.read({ h: 28 });
  check('strip: capturePage throwing -> a failure with the reason, never a throw', !r.ok && /nope/.test(r.reason));

  /* ---- the page's tint solve (model.js) ---- */
  check('model: parseColor hex / rgba / rgb', JSON.stringify(M.parseColor('#C4C7CE')) === '{"r":196,"g":199,"b":206,"a":1}' &&
    M.parseColor('rgba(30,31,34,.34)').a === 0.34 && M.parseColor('rgb(1, 2, 3)').b === 3 && M.parseColor('nope') === null);
  const pf = M.parseFilter('blur(12px) saturate(140%) brightness(.86)');
  check('model: parseFilter reads --lg-blur', pf.blur === 12 && Math.abs(pf.saturate - 1.4) < 1e-9 && pf.brightness === 0.86, JSON.stringify(pf));
  check('model: parseFilter of light (no brightness) -> 1', M.parseFilter('blur(12px) saturate(150%)').brightness === 1);
  check('model: WCAG ratio white/black = 21', Math.abs(M.ratio(M.lum(255, 255, 255), M.lum(0, 0, 0)) - 21) < 0.01);
  const flat = (w, h, rgb) => { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255; } return a; };
  const gp = M.glassPixels(flat(20, 4, [200, 100, 50]), 20, 4, { sigma: 3, saturate: 1, brightness: 1 });
  check('model: a flat picture blurs to itself (mirrored edges: no fade at the screen edge)', Math.abs(gp[0] - 200) < 0.5 && Math.abs(gp[gp.length - 1] - 50) < 0.5, gp.slice(0, 3).join(','));
  const gb = M.glassPixels(flat(4, 2, [200, 200, 200]), 4, 2, { sigma: 0, saturate: 1.4, brightness: 0.86 });
  check('model: brightness .86 on grey 200 -> 172 (saturate leaves grey alone)', Math.abs(gb[0] - 172) < 0.01 && Math.abs(gb[1] - 172) < 0.01, gb.slice(0, 3).join(','));
  const tr = new Uint8ClampedArray(4 * 1 * 4);   // fully transparent: counted as white
  check('model: a transparent pixel counts as white (the worst case)', M.glassPixels(tr, 4, 1, {})[0] === 255);
  const ink2 = { r: 196, g: 199, b: 206 }, tint = { r: 30, g: 31, b: 34 };
  const dark = M.glassTint({ px: M.glassPixels(flat(40, 4, [40, 70, 80]), 40, 4, { sigma: 2, saturate: 1.4, brightness: 0.86 }), ink: ink2, tint, need: 4.5, floor: 0.34, ceil: 0.82 });
  check('model: a dark teal sky keeps the breath (--lg-fill .34)', dark.alpha === 0.34 && !dark.short && dark.ratio >= 4.5, JSON.stringify(dark));
  const bright = M.glassTint({ px: M.glassPixels(flat(40, 4, [235, 235, 230]), 40, 4, { sigma: 2, saturate: 1.4, brightness: 0.86 }), ink: ink2, tint, need: 4.5, floor: 0.34, ceil: 0.82 });
  check('model: a bright photo gets the tint it needs (thicker, still >= 4.5:1)', bright.alpha > 0.6 && bright.ratio >= 4.5 && !bright.short, JSON.stringify(bright));
  const white = M.glassTint({ px: M.glassPixels(flat(40, 4, [255, 255, 255]), 40, 4, { sigma: 2, saturate: 1, brightness: 1 }), ink: ink2, tint, need: 4.5, floor: 0.34, ceil: 0.7 });
  check('model: unreachable -> the ceiling, marked short', white.short === true && white.alpha === 0.7, JSON.stringify(white));
  // the solve is the THINNEST passing tint: one step thinner fails
  const thinner = M.glassTint({ px: M.glassPixels(flat(40, 4, [235, 235, 230]), 40, 4, { sigma: 2, saturate: 1.4, brightness: 0.86 }), ink: ink2, tint, need: 4.5, floor: 0.34, ceil: bright.alpha - 0.02 });
  check('model: one step thinner than the solve does NOT pass', thinner.short === true, JSON.stringify(thinner));
  check('model: settle: thicker at once', M.glassSettle({ cur: 0.4, lower: 0 }, 0.5).cur === 0.5);
  let s2 = { cur: 0.5, lower: 0 };
  for (let i = 0; i < 3; i++) s2 = M.glassSettle(s2, 0.44, 4);
  check('model: settle: a small drop waits (3 pictures)', s2.cur === 0.5);
  s2 = M.glassSettle(s2, 0.44, 4);
  check('model: settle: ...and lands on the 4th', s2.cur === 0.44);
  check('model: settle: a big drop (a new wallpaper) at once; a tiny one never', M.glassSettle({ cur: 0.7 }, 0.34).cur === 0.34 && M.glassSettle({ cur: 0.4 }, 0.38).cur === 0.4);
  const menu = [{ t: 'item', act: 'about' }];
  M.glassMenu(menu, 'the layer is gone');
  check('model: glassMenu puts the reason first, as a bad info row', menu.length === 2 && menu[0].t === 'info' && menu[0].bad && /not frosted: the layer is gone/.test(menu[0].text));
  M.glassMenu(menu, 'again');
  check('model: glassMenu replaces, never stacks', menu.length === 2 && /again/.test(menu[0].text));
  M.glassMenu(menu, null);
  check('model: glassMenu(null) takes it out', menu.length === 1 && menu[0].act === 'about');

  /* ---- light stays put: every glass rule in topbar.css is scoped to dark ---- */
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'topbar', 'topbar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const glassRules = css.split('}').filter((r) => /body\.glass|--tb-tint|backdrop-filter/.test(r));
  check('css: every glass rule is under :root[data-theme="dark"]', glassRules.length >= 2 && glassRules.every((r) => /:root\[data-theme="dark"\]/.test(r)), glassRules.join('}'));
  check('css: #bdrop is display:none outside dark', /#bdrop\s*\{\s*display:\s*none;\s*\}/.test(css));
  const feat = fs.readFileSync(path.join(__dirname, 'topbar.js'), 'utf8');
  check('feature: the loop is kicked on show, hide, cover, display, page load and theme', ['gk(\'shown\')', 'gk(\'hidden\')', 'gk(\'cover\')', 'gk(\'display changed\', true)', 'gk(\'the page loaded\', true)', 'gk(\'the theme changed\', true)'].every((s) => feat.includes(s)));
  check('feature: topbar.status carries the glass', /glass: glass\.view\(\)/.test(feat));

  /* ---- THE SHARED TOP-BAND DARKENING (lane guard-mantle): forwarder, page helpers, bottom bar untouched ---- */
  {
    let answer = { use: true, alpha: 0.54, contrast: 4.32, rev: 9 };
    const pushed = [], logs = [];
    const fw = GL.makeLookGuard({ get: () => answer, push: (g) => pushed.push(g), log: (l) => logs.push(l) });
    check('lookGuard: first sync pushes main\'s answer to the page', fw.sync(true) === true && pushed.length === 1 && pushed[0].alpha === 0.54 && fw.view().use === true);
    check('lookGuard: the same answer is not pushed twice', fw.sync(false) === false && pushed.length === 1);
    check('lookGuard: a page load forces a push', fw.sync(true) === true && pushed.length === 2);
    answer = { use: false, why: 'the shared darkening is out of date (...)', failure: true };
    fw.sync(false);
    check('lookGuard: a failure is pushed and logged once', pushed.length === 3 && pushed[2].failure === true && logs.filter((l) => /own darkening/.test(l)).length === 1, JSON.stringify(logs));
    fw.sync(true);
    check('lookGuard: ... not logged again for the same reason', logs.filter((l) => /own darkening/.test(l)).length === 1);
    answer = { use: true, alpha: 0.6, contrast: 4.4, rev: 10 };
    fw.sync(false);
    check('lookGuard: recovery is pushed and said', pushed[pushed.length - 1].alpha === 0.6 && /is back/.test(logs[logs.length - 1]), JSON.stringify(logs));
    const thrower = GL.makeLookGuard({ get: () => { throw new Error('host gone'); }, push: (g) => pushed.push(g), log: () => {} });
    thrower.sync(true);
    check('lookGuard: a throwing host is a said failure, not a silent own guard', pushed[pushed.length - 1].failure === true && /host gone/.test(pushed[pushed.length - 1].why));
    const none = GL.makeLookGuard({ get: null, push: (g) => pushed.push(g), log: () => {} });
    none.sync(true);
    check('lookGuard: no host -> a said failure', pushed[pushed.length - 1].failure === true && /no shared darkening/.test(pushed[pushed.length - 1].why));

    // the page's pure parts (ui/topbar/glass.js)
    check('page: a good shared answer is used', JSON.stringify(M.lookGuardOf({ use: true, alpha: 0.54, contrast: 4.32 })) === JSON.stringify({ use: true, alpha: 0.54, contrast: 4.32 }));
    check('page: a bad alpha is a said failure', M.lookGuardOf({ use: true, alpha: 3 }).use === false && M.lookGuardOf({ use: true, alpha: 3 }).failure === true);
    check('page: nothing sent is a said failure', M.lookGuardOf(null).failure === true && M.lookGuardOf(undefined).use === false);
    check('page: sync off keeps its why, not a failure', M.lookGuardOf({ use: false, why: 'look sync is off', failure: false }).failure === false);
    // the TOP BAR uses the shared alpha instead of its own solve
    const shared = M.barAlpha({ use: true, alpha: 0.54 }, 0.5, { cur: 0.5, lower: 0 });
    check('top bar: shared in use -> the shared alpha replaces its own (.50 -> .54)', shared.alpha === 0.54 && shared.source === 'shared' && shared.settle.cur === 0.54);
    const sharedLower = M.barAlpha({ use: true, alpha: 0.5 }, 0.56, { cur: 0.56, lower: 0 });
    check('top bar: ... even when its own would be thicker (one value for all three)', sharedLower.alpha === 0.5 && sharedLower.source === 'shared');
    const stale = M.barAlpha(M.lookGuardOf({ use: false, why: 'out of date', failure: true }), 0.56, null);
    check('top bar: stale / missing -> its own guard (glassSettle)', stale.alpha === 0.56 && stale.source === 'own');
    const own = M.barAlpha(null, 0.52, { cur: 0.6, lower: 0 });
    check('top bar: own guard keeps glassSettle\'s hysteresis', own.alpha === M.glassSettle({ cur: 0.6, lower: 0 }, 0.52, 4).cur && own.source === 'own');
    const menu = [{ t: 'item', text: 'Settings' }];
    M.guardMenu(menu, 'the shared darkening is missing (x), so the top bar works out its own');
    check('top bar: a failure puts one row at the top of the Mantle menu', menu.length === 2 && menu[0].lookGuard && /Top bar darkening: the shared darkening is missing/.test(menu[0].text) && menu[0].enabled === false);
    M.guardMenu(menu, 'another reason');
    check('top bar: ... replaced, never stacked', menu.length === 2 && /another reason/.test(menu[0].text));
    M.guardMenu(menu, null);
    check('top bar: ... and gone when the shared value is back', menu.length === 1 && !menu[0].lookGuard);

    // wiring (source): the page applies it in dark only, main forwards it only to the top bar's window,
    // and the BOTTOM bar is untouched (no shared value reaches it; it keeps its own guard() call)
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'topbar', 'topbar.js'), 'utf8');
    check('page: solveTint takes the shared alpha only in dark', /GM\.barAlpha\(isDark\(\) \? GS\.lookGuard : null, r\.alpha, GS\.settle\)/.test(page));
    check('page: listens for topbar.guard and re-solves', /mantle\.on\('topbar\.guard'/.test(page) && /GM\.guardMenu\(M\.MANTLE_MENU, why\)/.test(page));
    const feat = fs.readFileSync(path.join(__dirname, 'topbar.js'), 'utf8');
    check('feature: forwards on page load and on every look / theme change, unsubscribes at stop', /lookGuard\.sync\(true\); gk\('the page loaded', true\)/.test(feat)
      && /ctx\.host\.lookGuard\.onChange\(/.test(feat) && /lookGuardOff\(\)/.test(feat) && /lookGuard: lookGuard\.view\(\)/.test(feat));
    const bottom = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'bar', 'bar.js'), 'utf8');
    check('bottom bar: no shared darkening reaches it', !/lookGuard|topbar\.guard|desktop\.guard|guard\.dark/.test(bottom));
    check('bottom bar: still runs its own guard over its own picture', /G\.guard\(px, \{ tokens: T, picPerCss: sx/.test(bottom) && /guardTokens\(true\)/.test(bottom));
  }

  console.log(`TOPBAR GLASS TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length || !passed ? 1 : 0);
})().catch((e) => { console.log('TOPBAR GLASS TEST: crashed: ' + (e && e.stack || e)); process.exit(1); });

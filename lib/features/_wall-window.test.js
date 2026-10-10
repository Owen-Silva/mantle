'use strict';
/* _wall-window.test.js - main's half of the app windows' wallpaper glass (lane helm-wall-apps). Pure: fake
 * windows, fake host. Run: node lib/features/_wall-window.test.js */
const WW = require('./_wall-window.js');

let pass = 0, fail = 0;
function check(name, ok, info) { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${info !== undefined ? ` -- ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`); } }
const tick = () => new Promise((r) => setImmediate(r));

function fakeWin(b) {
  const h = {};
  const w = {
    b: b || { x: 100, y: 50, width: 800, height: 600 }, mat: 'acrylic', bg: '#00000000', destroyed: false, calls: [],
    on(ev, fn) { (h[ev] = h[ev] || []).push(fn); }, once(ev, fn) { this.on(ev, fn); },
    emit(ev) { (h[ev] || []).forEach((f) => f()); },
    isDestroyed() { return this.destroyed; },
    getContentBounds() { return Object.assign({}, this.b); },
    setBackgroundMaterial(m) { this.mat = m; this.calls.push(['mat', m]); },
    setBackgroundColor(c) { this.bg = c; this.calls.push(['bg', c]); },
    webContents: { on(ev, fn) { (h[`wc:${ev}`] = h[`wc:${ev}`] || []).push(fn); } },
  };
  return w;
}
function fakeCtx(theme, wall) {
  const th = { t: theme, fns: [] };
  const c = { pushes: [], logs: [], replays: new Map() };
  c.th = th;
  c.ctx = {
    log: (l) => c.logs.push(l),
    push: (w, ev, p) => { if (w.destroyed) return false; c.pushes.push({ w, ev, p }); return true; },
    replay: (ev, fn) => c.replays.set(ev, fn),
    host: { theme: { get: () => th.t, onChange: (fn) => { th.fns.push(fn); return () => {}; } }, wall },
  };
  c.flip = (t) => { th.t = t; th.fns.slice().forEach((f) => f(t)); };
  return c;
}
function fakeWall() {
  const W = { n: 0, fns: [], next: null };
  W.api = {
    full: async () => { W.n++; if (W.next) return W.next(); return { ok: true, png: 'data:image/png;base64,AAAA', w: 768, h: 432, display: { x: 0, y: 0, width: 1536, height: 864 }, source: 'mantle', key: `k${W.n}`, ms: 3 }; },
    onChange: (fn) => { W.fns.push(fn); return () => {}; },
  };
  W.change = (why) => W.fns.forEach((f) => f(why));
  return W;
}
const LIGHT = { material: 'acrylic', color: '#00000000' };

(async () => {
  // light: nothing moves
  {
    const W = fakeWall(), c = fakeCtx('light', W.api);
    const f = WW.feed(c.ctx, { event: 'files.wall', pos: 'files.wallpos', light: LIGHT });
    const w = fakeWin();
    f.attach(w);
    await tick();
    w.emit('move');
    check('light: the window look is never touched', w.calls.length === 0, w.calls);
    check('light: no still is asked for', W.n === 0, W.n);
    check('light: no push at all (no still, no origin)', c.pushes.length === 0, c.pushes.map((p) => p.ev));
    check('light: the replay answers nothing', c.replays.get('files.wall')() === null);
  }
  // dark: opaque window, one still, origin on move, replay
  {
    const W = fakeWall(), c = fakeCtx('dark', W.api);
    const f = WW.feed(c.ctx, { event: 'files.wall', pos: 'files.wallpos', light: LIGHT });
    const w = fakeWin();
    f.attach(w);
    await tick(); await tick();
    check('dark: no material + the dark ground', w.mat === 'none' && w.bg === WW.GROUND_DARK && WW.GROUND_DARK === '#131415', w.calls);
    check('dark: one still asked for', W.n === 1, W.n);
    const st = c.pushes.filter((p) => p.ev === 'files.wall');
    check('dark: the still is pushed to the window', st.length === 1 && st[0].p.ok === true && st[0].p.key === 'k1', st.map((p) => p.p.key));
    check('dark: the replay answers the still', c.replays.get('files.wall')().key === 'k1');
    w.b = { x: 300, y: 120, width: 800, height: 600 };
    w.emit('move');
    const pos = c.pushes.filter((p) => p.ev === 'files.wallpos');
    check('dark: a move pushes the content origin (DIP) with a time', pos.length === 1 && pos[0].p.x === 300 && pos[0].p.y === 120 && pos[0].p.t > 0, pos.map((p) => p.p));
    w.emit('resize'); w.emit('show');
    check('dark: resize and show push it too', c.pushes.filter((p) => p.ev === 'files.wallpos').length === 3);
    const s = f.state();
    check('dark: state says what, never the picture', s.still && s.still.ok && !('png' in s.still) && s.moves === 3 && s.moveCost && s.moveCost.n === 3, s);
    // a second window: the still is already here (replay), not asked again
    const w2 = fakeWin();
    f.attach(w2);
    await tick();
    check('dark: a second window reuses the still', W.n === 1 && w2.mat === 'none', W.n);
    // the wallpaper changes: one new still to both
    W.change('another wallpaper');
    await tick(); await tick();
    const st2 = c.pushes.filter((p) => p.ev === 'files.wall' && p.p.key === 'k2');
    check('dark: another wallpaper = one new still, pushed to every window', W.n === 2 && st2.length === 2, { n: W.n, pushed: st2.length });
    // flip to light: the look goes back exactly, the page is told, nothing kept
    c.flip('light');
    await tick();
    check('flip light: clear colour then acrylic, exactly as made', w.mat === 'acrylic' && w.bg === '#00000000' && w2.mat === 'acrylic', w.calls.slice(-2));
    const lt = c.pushes.filter((p) => p.ev === 'files.wall' && p.p.light);
    check('flip light: the pages are told (ok:false, light)', lt.length === 2 && lt[0].p.ok === false);
    check('flip light: the replay answers nothing', c.replays.get('files.wall')() === null);
    const nPos = c.pushes.filter((p) => p.ev === 'files.wallpos').length;
    w.emit('move');
    check('flip light: moves push nothing', c.pushes.filter((p) => p.ev === 'files.wallpos').length === nPos);
    // and back to dark: asked again
    c.flip('dark');
    await tick(); await tick();
    check('flip dark: opaque again + a fresh still', w.mat === 'none' && w.bg === '#131415' && W.n === 3 && c.replays.get('files.wall')().key === 'k3', { mat: w.mat, n: W.n });
    // closing every window drops the still
    w.destroyed = true; w.emit('closed'); w2.destroyed = true; w2.emit('closed');
    check('closed: no windows, no still kept', c.replays.get('files.wall')() === null && f.state().windows === 0);
  }
  // no provider, a failing provider, a refusing provider
  {
    const c = fakeCtx('dark', undefined);
    const f = WW.feed(c.ctx, { event: 'files.wall', pos: 'files.wallpos', light: LIGHT });
    f.attach(fakeWin());
    await tick();
    const p = c.pushes.find((x) => x.ev === 'files.wall');
    check('no provider: the page is told why', p && p.p.ok === false && p.p.reason === WW.NO_PROVIDER, p && p.p);
  }
  {
    const W = fakeWall(); W.next = () => { throw new Error('boom'); };
    const c = fakeCtx('dark', W.api);
    const f = WW.feed(c.ctx, { event: 'files.wall', pos: 'files.wallpos', light: LIGHT });
    f.attach(fakeWin());
    await tick(); await tick();
    const p = c.pushes.find((x) => x.ev === 'files.wall');
    check('a throwing provider: said, with its words', p && p.p.ok === false && /boom/.test(p.p.reason), p && p.p);
    check('a throwing provider: logged once', c.logs.filter((l) => /no wallpaper picture/.test(l)).length === 1, c.logs);
  }
  {
    const W = fakeWall(); W.next = () => ({ ok: false, reason: 'light: the glass keeps its own face' });
    const c = fakeCtx('dark', W.api);
    WW.feed(c.ctx, { event: 'files.wall' }).attach(fakeWin(), { follow: false });
    await tick(); await tick();
    const p = c.pushes.find((x) => x.ev === 'files.wall');
    check('a refusal: its reason is passed on as is', p && p.p.reason === 'light: the glass keeps its own face', p && p.p);
  }
  // follow:false (Task view) and no light look (a window that is transparent / sidecar-glassed)
  {
    const W = fakeWall(), c = fakeCtx('dark', W.api);
    const f = WW.feed(c.ctx, { event: 'taskview.wall' });
    const w = fakeWin();
    f.attach(w, { follow: false });
    await tick(); await tick();
    w.emit('move');
    check('follow:false: no origin pushes', !c.pushes.some((p) => p.ev === undefined || /pos/.test(p.ev)));
    check('no light look: the window look is not touched', w.calls.length === 0, w.calls);
    check('follow:false: the still still comes', c.pushes.some((p) => p.ev === 'taskview.wall' && p.p.ok));
  }
  // a newer ask decides (a slow first answer never overwrites a later one)
  {
    const W = fakeWall();
    let release;
    W.next = () => (W.n === 1 ? new Promise((r) => { release = () => r({ ok: true, png: 'data:x', w: 1, h: 1, display: { x: 0, y: 0, width: 1, height: 1 }, key: 'old' }); }) : { ok: true, png: 'data:x', w: 1, h: 1, display: { x: 0, y: 0, width: 1, height: 1 }, key: 'new' });
    const c = fakeCtx('dark', W.api);
    const f = WW.feed(c.ctx, { event: 'files.wall' });
    f.attach(fakeWin(), { follow: false });
    await tick();
    W.change('display');
    await tick(); await tick();
    release();
    await tick(); await tick();
    check('a newer ask decides', c.replays.get('files.wall')().key === 'new' && !c.pushes.some((p) => p.p.key === 'old'), c.pushes.map((p) => p.p.key));
  }
  // hold (lane helm-wall): a first show waits for the baked picture, at most the cap; no wait = synchronous
  {
    const c = fakeCtx('light', fakeWall().api);
    const f = WW.feed(c.ctx, { event: 'files.wall' });
    let shown = 0;
    f.hold(fakeWin(), () => { shown++; });
    check('hold: light shows at once, synchronously', shown === 1);
    const c2 = fakeCtx('dark', null);
    let shown2 = 0;
    WW.feed(c2.ctx, { event: 'files.wall' }).hold(fakeWin(), () => { shown2++; });
    check('hold: no provider shows at once', shown2 === 1);
    const W = fakeWall();
    const c3 = fakeCtx('dark', W.api);
    const f3 = WW.feed(c3.ctx, { event: 'files.wall' });
    const w3 = fakeWin();
    let code = '';
    w3.webContents.executeJavaScript = (js) => { code = js; return Promise.resolve('baked'); };
    let shown3 = 0;
    const r3 = await f3.hold(w3, () => { shown3++; });
    check('hold: dark waits for the page\'s "mantle-wall" on, then shows once', shown3 === 1 && r3.why === 'baked' && /mantle-wall/.test(code) && /state === "on"/.test(code), r3);
    const w4 = fakeWin();
    w4.webContents.executeJavaScript = () => new Promise(() => {});
    let shown4 = 0;
    const t0 = Date.now();
    const r4 = await f3.hold(w4, () => { shown4++; }, 60);
    check('hold: the cap shows it anyway, once', shown4 === 1 && /not baked within 60 ms/.test(r4.why) && Date.now() - t0 >= 55 && Date.now() - t0 < 400, r4);
    check('hold: state() says how the last hold ended', f3.state().hold && /not baked/.test(f3.state().hold.why));
    const w5 = fakeWin();
    w5.webContents.executeJavaScript = () => Promise.reject(new Error('page gone'));
    let shown5 = 0;
    const r5 = await f3.hold(w5, () => { shown5++; }, 60);
    check('hold: a page that cannot be asked still shows, with the reason', shown5 === 1 && /could not be asked \(page gone\)/.test(r5.why), r5);
    check('hold: default cap is 250 ms', WW.HOLD_MS === 250);
  }
  // setLook on a window without setBackgroundMaterial (an old Electron) still sets the ground
  {
    const w = fakeWin(); delete w.setBackgroundMaterial;
    check('setLook: no setBackgroundMaterial = the ground only, no throw', WW.setLook(w, true, LIGHT) === null && w.bg === '#131415');
    const w2 = fakeWin(); w2.setBackgroundColor = () => { throw new Error('gone'); };
    check('setLook: a throw comes back as words', WW.setLook(w2, true, LIGHT) === 'gone');
  }
  console.log(`WALL-WINDOW: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

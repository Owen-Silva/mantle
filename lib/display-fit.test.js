'use strict';
/* display-fit.test.js - after a resolution or scale change the desktop layer fills the main display
   again and the launcher opens centred on it (lane mn-display, 2026-10-12).
   Plain node, no Electron: lib/display-fit.js is driven with a FAKE screen whose metrics the test
   changes, a fake sidecar that does what Desktop.cs Fit does (puts the window on the main monitor's
   physical rect), and fake windows. The REAL main.js attachDesktop is cut out and run against fakes
   to prove a layer held hidden is sized before it is shown. Nothing here can change the real display.
   (The sidecar's Fit itself, on real windows, is lib/windows.test.js's Electron child.)
     node lib/display-fit.test.js   -> "DISPLAY FIT TEST: n passed, m failed" */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./display-fit');

let passed = 0;
const failures = [];
function ok(cond, what) { if (cond) passed++; else failures.push(what); }

/* ---- a fake screen and a fake desktop layer --------------------------------------------------- */
function rig(o) {
  const opts = o || {};
  const log = [];
  const state = [];
  const calls = [];
  const scr = {
    d: { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    getPrimaryDisplay() { return this.d; },
  };
  const phys = () => ({ x: 0, y: 0, w: Math.round(scr.d.bounds.width * scr.d.scaleFactor), h: Math.round(scr.d.bounds.height * scr.d.scaleFactor) });
  const win = {
    destroyed: false, held: !!opts.held, rect: { x: 0, y: 0, w: 1920, h: 1080 }, dprSeen: 1,
    isDestroyed() { return this.destroyed; },
  };
  const sidecar = {
    async call(cmd, args) {
      calls.push([cmd, Object.assign({}, args)]);
      if (opts.fail) throw new Error('desktop fit: SetWindowPos failed (Win32 error 5)');
      if (opts.failRescale && args.w !== undefined) throw new Error('desktop fit: SetWindowPos failed (Win32 error 5)');
      // a rect given ({x, y, w, h}) is used as is, as Desktop.cs Fit does; none = the main monitor
      const t = args.w !== undefined ? { x: args.x, y: args.y, w: args.w, h: args.h } : phys();
      const before = [win.rect.x, win.rect.y, win.rect.x + win.rect.w, win.rect.y + win.rect.h];
      const same = win.rect.x === t.x && win.rect.y === t.y && win.rect.w === t.w && win.rect.h === t.h;
      win.rect = { x: t.x, y: t.y, w: t.w, h: t.h };
      // Chromium, for a child window: staleDpr = the scale is re-read only when the window is RESIZED
      // (a scale-only change resizes nothing); 'always' = it is never re-read, resize or not
      if (!opts.staleDpr || (!same && opts.staleDpr !== 'always')) win.dprSeen = scr.d.scaleFactor;
      return { changed: !same, before, rect: [t.x, t.y, t.x + t.w, t.y + t.h], child: true };
    },
  };
  const fit = F.makeDesktopFit({
    win: () => (opts.noWin ? null : win),
    held: (w) => w.held,
    test: () => !!opts.test,
    paused: () => !!opts.paused,
    hwndOf: () => '4242',
    sidecar,
    screen: scr,
    // the page sees the window's physical size through the scale Chromium thinks it has
    page: async (w) => ({ w: Math.round(w.rect.w / w.dprSeen), h: Math.round(w.rect.h / w.dprSeen), dpr: w.dprSeen }),
    log: (t) => log.push(t),
    setState: (p) => state.push(p),
    wait: async () => {},
  });
  return { fit, scr, win, calls, log, state };
}

(async () => {
  /* centredRect / recentre */
  ok(JSON.stringify(F.centredRect({ x: 0, y: 0, width: 1920, height: 1080 }, 680, 460)) === JSON.stringify({ x: 620, y: 310, width: 680, height: 460 }), 'centredRect: 680x460 on 1920x1080 is at 620,310');
  ok(F.centredRect({ x: -1280, y: 0, width: 1280, height: 720 }, 680, 460).x === -980, 'centredRect: a display left of the origin keeps its offset');
  {
    const moves = [];
    const w = { b: { x: 620, y: 310, width: 680, height: 460 }, isDestroyed: () => false, getBounds() { return Object.assign({}, this.b); }, setBounds(r) { moves.push(r); this.b = r; } };
    const s = { d: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }, getPrimaryDisplay() { return this.d; } };
    ok(!F.recentre(w, s, 'the launcher').moved && moves.length === 0, 'recentre: already centred -> no setBounds');
    s.d = { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
    const r = F.recentre(w, s, 'the launcher');
    ok(r.moved && moves.length === 1 && w.b.x === 940 && w.b.y === 490, `recentre: 2560x1440 -> 940,490 (${JSON.stringify(w.b)})`);
    s.d = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 };
    s.d.bounds = { x: 0, y: 0, width: 1536, height: 864 };
    F.recentre(w, s, 'the launcher');
    ok(w.b.x === 428 && w.b.y === 202 && w.b.width === 680, `recentre: 125% (1536x864 DIP) -> 428,202, size kept (${JSON.stringify(w.b)})`);
    ok(!F.recentre(null, s, 'the launcher').moved && !F.recentre({ isDestroyed: () => true }, s, 'x').moved, 'recentre: no window / a destroyed one -> nothing, no throw');
    const bad = { getPrimaryDisplay() { throw new Error('no displays'); } };
    ok(/could not be read \(no displays\)/.test(F.recentre(w, bad, 'the launcher').reason), 'recentre: a screen that throws -> a reason, no throw');
  }

  /* desktopFitVerdict */
  ok(F.desktopFitVerdict({ alive: true }).act === 'fit', 'verdict: an attached, shown layer is fitted');
  ok(F.desktopFitVerdict({ alive: true, held: true }).act === 'later', 'verdict: held hidden on its way under the icons -> later, never now');
  ok(F.desktopFitVerdict({ alive: true, test: true }).act === 'skip', 'verdict: a test run -> skip');
  ok(F.desktopFitVerdict({ alive: true, paused: true }).act === 'skip', 'verdict: Windows put back -> skip');
  ok(F.desktopFitVerdict({ alive: false }).act === 'skip', 'verdict: no layer -> skip');

  /* pageFillVerdict */
  ok(F.pageFillVerdict({ w: 1920, h: 1080, dpr: 1 }, { bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }).ok === true, 'page: 1920x1080 at 1 fills 1920x1080 at 1');
  ok(F.pageFillVerdict({ w: 1919, h: 1081, dpr: 1.25 }, { bounds: { width: 1920, height: 1080 }, scaleFactor: 1.25 }).ok === true, 'page: one DIP of rounding is a fill');
  const stale = F.pageFillVerdict({ w: 1920, h: 1080, dpr: 1 }, { bounds: { width: 1536, height: 864 }, scaleFactor: 1.25 });
  ok(stale.ok === false && /1920x1080 at scale 1 but the main display is 1536x864 at scale 1.25/.test(stale.reason), `page: an old-scale page is named, with both sizes (${stale.reason})`);
  ok(F.pageFillVerdict(null, { bounds: { width: 1, height: 1 } }).ok === null, 'page: no answer -> unknown, not a pass');

  /* makeDesktopFit: a resolution change */
  {
    const R = rig();
    R.scr.d = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
    const r = await R.fit.run('display metrics changed');
    ok(r.act === 'fitted' && R.win.rect.w === 2560 && R.win.rect.h === 1440, `1920x1080 -> 2560x1440: the layer is 2560x1440 px (${JSON.stringify(R.win.rect)})`);
    ok(R.calls.length === 1 && R.calls[0][0] === 'desktop' && R.calls[0][1].fit === true && R.calls[0][1].hwnd === '4242' && R.calls[0][1].w === undefined,
      `the sidecar is asked desktop {hwnd, fit:true} with no rect (it reads the main monitor itself) (${JSON.stringify(R.calls)})`);
    ok(r.fill === true && /sized to the main display \(display metrics changed\): now 2560x1440 px, inside the desktop; the desktop page fills/.test(R.log[0]), `logged plainly (${R.log[0]})`);
    ok(R.state.length === 1 && R.state[0].fit === null, 'state: no fit warning when it filled');
    const again = await R.fit.run('display metrics changed');
    ok(again.act === 'same' && /already the main display's size/.test(R.log[1]), 'a second event at the same size: nothing moved, said so');
  }
  /* a scale change: same physical size, the page must take the new scale */
  {
    const R = rig();
    R.scr.d = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 };
    const r = await R.fit.run('display metrics changed');
    ok(r.act === 'same' && r.fill === true, `100% -> 125% on 1920x1080: the size is kept (same physical px) and the page fills at 1.25 (${r.reason})`);
  }
  {
    // M6: a scale-only change on a child layer resizes nothing, so Chromium keeps the old scale; one
    // resize (1 px shorter, then the full display) makes it re-read the scale
    const R = rig({ staleDpr: true });
    R.scr.d = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 };
    const r = await R.fit.run('display metrics changed');
    ok(r.act === 'same' && r.fill === true && r.rescaled === true && R.win.dprSeen === 1.25,
      `scale-only change, page at the old scale: re-scaled by one resize and it now fills at 1.25 (${JSON.stringify(r)})`);
    ok(R.calls.length === 3 && R.calls[1][1].w === 1920 && R.calls[1][1].h === 1079 && R.calls[1][1].x === 0 && R.calls[1][1].fit === true
      && R.calls[2][1].w === undefined && R.calls[2][1].fit === true,
      `the resize: a fit 1 physical px shorter, then a fit to the main monitor (${JSON.stringify(R.calls)})`);
    ok(R.win.rect.w === 1920 && R.win.rect.h === 1080, `it ends at the full display (${JSON.stringify(R.win.rect)})`);
    ok(R.state.length === 1 && R.state[0].fit === null && /after a resize made it re-read the scale/.test(R.log[0]), `no warning left, and the log says what was done (${R.log[0]})`);
    const again = await R.fit.run('display metrics changed');
    ok(again.rescaled === false && R.calls.length === 4, 'a later event with the page right: no resize');
  }
  {
    const R = rig({ staleDpr: 'always' });
    R.scr.d = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 };
    const r = await R.fit.run('display metrics changed');
    ok(r.fill === false && r.rescaled === false && R.state[0] && /but the desktop page is 1920x1080 at scale 1 but the main display is 1536x864 at scale 1.25/.test(R.state[0].fit)
      && /a resize to make it re-read the scale did not help/.test(R.state[0].fit),
      `a page the resize does not fix is NOT silent: the state says so (${R.state[0] && R.state[0].fit})`);
    ok(R.win.rect.h === 1080, 'and the layer is still left at the full display');
  }
  {
    const R = rig({ staleDpr: 'always', failRescale: true });
    R.scr.d = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 };
    const r = await R.fit.run('display metrics changed');
    ok(r.fill === false && /resizing it so it re-reads the scale failed \(desktop fit: SetWindowPos failed/.test(R.state[0] && R.state[0].fit),
      `a resize the sidecar refuses: the state says why (${R.state[0] && R.state[0].fit})`);
  }
  /* held hidden on its way under the icons: never sized then; sized by afterAttach */
  {
    const R = rig({ held: true });
    R.scr.d = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
    const r = await R.fit.run('a display was connected');
    ok(r.act === 'later' && R.calls.length === 0 && R.fit.pending() === 'a display was connected', 'held hidden: no sidecar call, the reason is kept for later');
    ok(/not sized yet \(a display was connected\): the desktop layer is waiting, hidden/.test(R.log[0]), 'held hidden: logged as waiting');
    const a = await R.fit.afterAttach();
    ok(a && a.act === 'fitted' && R.win.rect.w === 2560 && R.fit.pending() === null, 'afterAttach: sized at once, while still held (it is under the icons now), and the pending reason clears');
    ok(/now that it is under the icons/.test(R.log[1]), 'afterAttach: the log says why it ran now');
    ok((await R.fit.afterAttach()) === null && R.calls.length === 1, 'afterAttach with nothing pending: no call');
  }
  /* test run, paused, no window, sidecar failure */
  {
    const R = rig({ test: true });
    R.scr.d = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
    ok((await R.fit.run('x')).act === 'skip' && R.calls.length === 0, 'a test run: never sized (its layer is an ordinary small window)');
    const P = rig({ paused: true });
    ok((await P.fit.run('x')).act === 'skip' && P.calls.length === 0, 'Windows put back: never sized');
    const N = rig({ noWin: true });
    ok((await N.fit.run('x')).act === 'skip', 'no layer: skipped, no throw');
    const E = rig({ fail: true });
    const e = await E.fit.run('display metrics changed');
    ok(e.act === 'failed' && /could not be sized to the main display \(display metrics changed\): desktop fit: SetWindowPos failed/.test(E.state[0].fit), `a sidecar failure is in the state with its reason (${E.state[0] && E.state[0].fit})`);
  }
  /* runs never overlap: a burst landing mid-fit waits for it */
  {
    const R = rig();
    let release;
    let inFlight = 0, maxInFlight = 0;
    const sc = { call: async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => { release = r; }); inFlight--; return { changed: true, rect: [0, 0, 10, 10] }; } };
    const f = F.makeDesktopFit({ win: () => R.win, held: () => false, test: false, paused: () => false, hwndOf: () => '1', sidecar: sc, screen: R.scr, log: () => {} });
    const a = f.run('one'); const b = f.run('two');
    await new Promise((r) => setImmediate(r));
    release(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    release(); await a; await b;
    ok(maxInFlight === 1, `two runs in a burst: one at a time (${maxInFlight} at once)`);
  }

  /* a desktop page that never answers does not hold the queue (the picture retake waits on it) */
  {
    const R = rig();
    const f = F.makeDesktopFit({ win: () => R.win, held: () => false, test: false, paused: () => false, hwndOf: () => '1',
      sidecar: { call: async () => ({ changed: true, rect: [0, 0, 1920, 1080] }) }, screen: R.scr, page: () => new Promise(() => {}), log: () => {} });
    const t0 = Date.now();
    const r = await f.run('display metrics changed');
    const ms = Date.now() - t0;
    ok(r.act === 'fitted' && r.fill === null && /did not answer \(no answer in 2 s\)/.test(r.reason) && ms < 3000, `a page that never answers: the fit still ends in about 2 s, saying so (${ms} ms; ${r.reason})`);
  }

  /* main.js: attachDesktop sizes a held layer BEFORE it is shown; the burst fits before the reshoot */
  {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').split(String.fromCharCode(13)).join('');
    const a = SRC.indexOf('async function attachDesktop(');
    const fn = SRC.slice(a, SRC.indexOf('\n}\n', a) + 2);
    const order = [];
    const ctx = {
      desktopWin: { isDestroyed: () => false },
      hwndOf: () => '1',
      sidecar: { call: async () => ({ mode: 'progman-front' }) },
      state: { set: () => {} },
      armDesktopRecheck: () => order.push('recheck'),
      showDesktopWhenReady: () => order.push('show'),
      desktopFit: { pending: () => 'display metrics changed', afterAttach: async () => { await new Promise((r) => setTimeout(r, 5)); order.push('fit'); } },
      desktopShowGate: null,
    };
    vm.createContext(ctx);
    vm.runInContext(fn + '\nglobalThis.__a = attachDesktop;', ctx);
    const r = await ctx.__a();
    ok(r.ok && order.join(',') === 'recheck,fit,show', `attachDesktop: a pending fit runs (and finishes) before the layer is shown (${order.join(',')})`);
    order.length = 0;
    ctx.desktopFit = { pending: () => null, afterAttach: async () => { order.push('fit'); } };
    await ctx.__a();
    ok(order.join(',') === 'recheck,show', `attachDesktop: nothing pending -> no fit, shown as before (${order.join(',')})`);
    const burst = SRC.slice(SRC.indexOf('const displayBurst = makeBurst('), SRC.indexOf("screen.on('display-metrics-changed'"));
    ok(/desktopFit\.run\(why\)[^\n]*\.then\(\(\) => reshootDesktopBackdrop\(why\)\)/.test(burst), 'the display burst sizes the layer, THEN retakes its picture');
    ok(/if \(launcherAlive\(\) && launcherWin\.isVisible\(\)\) launcherRecentre\(why\)/.test(burst), 'the display burst re-centres a launcher that is up');
    ok(['display-metrics-changed', 'display-added', 'display-removed'].every((e) => SRC.includes(`screen.on('${e}', () => displayBurst(`)), 'all three screen events go through the one burst');
  }

  if (failures.length) for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`DISPLAY FIT TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((err) => { console.log(`DISPLAY FIT TEST: crashed (${err.stack})`); process.exitCode = 1; });

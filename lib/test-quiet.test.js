'use strict';
/*
 * test-quiet.test.js - A TEST INSTANCE PUTS NOTHING ON OWEN'S SCREEN (lane r8-quiet, 2026-10-01).
 *
 *   node lib/test-quiet.test.js                -> "QUIET TEST: n passed, m failed"
 *   node lib/test-quiet.test.js --no-electron  (the plain-node half only)
 *
 * 1. Plain node: which runs are quiet (only --test, never --live, never a plain `electron .`, never
 *    MANTLE_TEST_VISIBLE=1); the options a quiet window gets; LIVE IS UNCHANGED: in a child process with
 *    a stand-in electron module, live / default / visible-opt-in argv leave Module._load and
 *    require('electron') untouched, and lib/windows.js hands BrowserWindow exactly the options it did
 *    without lib/test-quiet.js (bar, launcher, desktop; live and test shapes). A --test run gets the
 *    quiet options and the read-back overrides. main.js installs it before its first require('electron').
 * 2. One Electron child (--electron-child), ITS OWN windows only, quiet: a transparent pop-up, a framed
 *    window left at Electron's default show:true, and one asking focusable:true. Each is shown and is:
 *    WS_VISIBLE, layered alpha 0, click-through, not activatable, a tool window; the foreground never
 *    becomes ours; WindowFromPoint at its centre is not it; capturePage still has the page's pixels;
 *    the desktop's own pixels (desktopCapturer, counted in memory, never saved) show none of its
 *    magenta. window.open children are quietened too. With MANTLE_TEST_VISIBLE=1 a 60x60 control
 *    window is shown for 300 ms to prove the pixel count can see a window at all.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

if (process.argv.includes('--electron-child')) { child(); return; }
if (process.argv.includes('--scenario')) { scenario(process.argv[process.argv.indexOf('--scenario') + 1]); return; }

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed++;
  else failures.push(detail === undefined ? name : `${name} (${String(detail).slice(0, 400)})`);
}

/* ---- a stand-in electron module, for the plain-node half ---- */
function fakeElectron(record) {
  const EventEmitter = require('events');
  const native = [];
  const anyFn = () => anything;
  const anything = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : anything), apply: () => anything });
  class BrowserWindow {
    constructor(o) {
      record.push(JSON.parse(JSON.stringify(o || {})));
      this.webContents = anything;
      this.native = native;
    }
    setOpacity(v) { this.native.push(['setOpacity', v]); }
    setIgnoreMouseEvents(v) { this.native.push(['setIgnoreMouseEvents', v]); }
    setSkipTaskbar(v) { this.native.push(['setSkipTaskbar', v]); }
    setFocusable(v) { this.native.push(['setFocusable', v]); }
    showInactive() { this.native.push(['showInactive']); }
    show() { this.native.push(['show']); }
    focus() { this.native.push(['focus']); }
    getNativeWindowHandle() { throw new Error('a stand-in window has no handle'); }
    isDestroyed() { return false; }
    isResizable() { return false; }
    setAlwaysOnTop() {}
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    on() { return this; }
    once() { return this; }
  }
  BrowserWindow.getAllWindows = () => [];
  class Tray extends EventEmitter { constructor() { super(); this.real = true; } }
  return {
    BrowserWindow, Tray, native,
    app: { on() {}, getPath: () => ROOT },
    screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, scaleFactor: 1 }) },
    ipcMain: anything, anyFn,
  };
}

/* One scenario in its own node process (Module._load is process-wide): prints SCENARIO <json>. */
function scenario(name) {
  const Module = require('module');
  const record = [];
  const fake = fakeElectron(record);
  // Electron's own resolution of require('electron'), as the main process has it.
  const base = Module._load;
  Module._load = function (request) { return request === 'electron' ? fake : base.apply(this, arguments); };
  const before = Module._load;
  const out = { name };
  const argvs = {
    none: null,
    live: ['electron.exe', '.', '--live'],
    plain: ['electron.exe', '.'],
    visible: ['electron.exe', '.', '--test', '--profile-name=x'],
    quiet: ['electron.exe', '.', '--test', '--profile-name=x'],
  };
  const env = name === 'visible' ? { MANTLE_TEST_VISIBLE: '1' } : {};
  const lines = [];
  if (argvs[name]) out.installed = require('./test-quiet').install(argvs[name], env, { log: (l) => lines.push(l) });
  out.loadUntouched = Module._load === before;
  out.sameElectron = require('electron') === fake;
  out.lines = lines;
  const W = require('./windows');
  const make = (fn, a) => { try { W[fn](a); } catch (_) { /* the stand-in stops short of a page; the options are recorded */ } };
  make('createBar', { root: ROOT, test: false, barEdge: 'bottom' });
  make('createBar', { root: ROOT, test: true, barEdge: 'bottom' });
  make('createBar', { root: ROOT, test: true, barEdge: 'bottom', liveShape: true });
  make('createLauncher', { root: ROOT, test: false });
  make('createLauncher', { root: ROOT, test: true });
  make('createDesktop', { root: ROOT, test: false });
  out.options = record;
  if (name === 'quiet') {
    const E = require('electron');
    out.viewKeys = Object.keys(E).sort();
    out.fakeKeys = Object.keys(fake).sort();
    out.appPassThrough = E.app === fake.app && E.screen === fake.screen;
    out.bwWrapped = E.BrowserWindow !== fake.BrowserWindow;
    fake.native.length = 0;
    const w = new E.BrowserWindow({ show: false, opacity: 0.9, focusable: true, width: 10, height: 10 });
    out.isInstance = w instanceof E.BrowserWindow && w instanceof fake.BrowserWindow;
    out.nativeAtCreate = fake.native.slice();
    w.setOpacity(0.5); w.setIgnoreMouseEvents(false); w.setFocusable(true); w.focus(); w.show();
    out.readBack = { opacity: w.getOpacity(), focusable: w.isFocusable() };
    out.nativeAfter = fake.native.slice(out.nativeAtCreate.length);
    out.ownKeys = Object.keys(w);
    fake.native.length = 0;
    // eslint-disable-next-line no-new
    new E.BrowserWindow({ width: 10, height: 10 });   // Electron's default show:true
    out.defaultShow = fake.native.slice();
    const t = new E.Tray(null);
    t.setContextMenu({ items: [] }); t.setToolTip('x'); t.displayBalloon({});
    out.tray = { quiet: t.quiet === true, real: t.real === true, menu: !!t._menu, destroyed: t.isDestroyed() };
  }
  process.stdout.write(`SCENARIO ${JSON.stringify(out)}\n`);
}

function runScenario(name) {
  const r = require('child_process').spawnSync(process.execPath, [__filename, '--scenario', name], { encoding: 'utf8', timeout: 30000 });
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('SCENARIO '));
  if (!line) { check(`scenario ${name}: it ran`, false, `${r.status} ${String(r.stderr || '').slice(-400)}`); return null; }
  return JSON.parse(line.slice(9));
}

(async () => {
  const Q = require('./test-quiet');

  /* ---- 1a. which runs are quiet ---- */
  const W = (argv, env) => Q.wanted(argv, env || {});
  check('quiet: a --test run', W(['e', '.', '--test', '--profile-name=a']) === true);
  check('quiet: --test=<x> is the same flag (lib/args.js name rule)', W(['e', '.', '--test=1', '--profile-name=a']) === true);
  check('not quiet: --live', W(['e', '.', '--live']) === false);
  check('not quiet: a plain `electron .` (the safe refusal)', W(['e', '.']) === false);
  check('not quiet: --test-live-bar without --test (another flag)', W(['e', '.', '--test-live-bar']) === false);
  check('not quiet: --test with --live (args.js refuses it anyway)', W(['e', '.', '--test', '--live']) === false);
  check('not quiet: MANTLE_TEST_VISIBLE=1 (the opt-in for on-screen checks)', W(['e', '.', '--test'], { MANTLE_TEST_VISIBLE: '1' }) === false);
  check('quiet: MANTLE_TEST_VISIBLE=0 / empty stays quiet', W(['e', '.', '--test'], { MANTLE_TEST_VISIBLE: '0' }) === true && W(['e', '.', '--test'], { MANTLE_TEST_VISIBLE: '' }) === true);
  check('not quiet: no argv at all', W(null) === false && W(undefined) === false);

  /* ---- 1b. the options a quiet window gets ---- */
  const src = { show: true, focusable: true, width: 5, transparent: true, webPreferences: { sandbox: true } };
  const qo = Q.quietOptions(src);
  check('quietOptions: never shown by Electron, not activatable, out of the taskbar, alpha 0',
    qo.show === false && qo.focusable === false && qo.skipTaskbar === true && qo.opacity === 0, JSON.stringify(qo));
  check('quietOptions: everything else is the caller\'s, the caller\'s object untouched',
    qo.width === 5 && qo.transparent === true && qo.webPreferences === src.webPreferences && src.show === true && src.focusable === true && !('opacity' in src));

  /* ---- 1c. live is unchanged ---- */
  const none = runScenario('none');
  for (const name of ['live', 'plain', 'visible']) {
    const s = runScenario(name);
    if (!s || !none) continue;
    check(`${name}: install() says no`, s.installed === false, JSON.stringify(s.installed));
    check(`${name}: Module._load untouched, require('electron') is Electron's own`, s.loadUntouched && s.sameElectron);
    check(`${name}: nothing logged`, s.lines.length === 0, JSON.stringify(s.lines));
    check(`${name}: bar/launcher/desktop get EXACTLY the options they got without lib/test-quiet.js (${none.options.length} windows)`,
      none.options.length >= 6 && JSON.stringify(s.options) === JSON.stringify(none.options), JSON.stringify({ s: s.options, none: none.options }).slice(0, 400));
  }
  const q = runScenario('quiet');
  if (q && none) {
    check('quiet: installed, one plain line said so (+ the stand-in having no handle, said ONCE)', q.installed === true && q.lines.length === 2 && /kept off the screen/.test(q.lines[0]) && /may still show in app lists/.test(q.lines[1]), JSON.stringify(q.lines));
    check('quiet: require(\'electron\') is the wrapped view (BrowserWindow wrapped, app/screen passed through)', !q.sameElectron && q.bwWrapped && q.appPassThrough);
    check('quiet: the view has the same keys as Electron\'s module', JSON.stringify(q.viewKeys) === JSON.stringify(q.fakeKeys), JSON.stringify([q.viewKeys, q.fakeKeys]));
    const want = none.options.map((o) => Object.assign({}, o, { show: false, focusable: false, skipTaskbar: true, opacity: 0 }));
    check('quiet: every window\'s options = its own + show:false, focusable:false, skipTaskbar:true, opacity:0',
      JSON.stringify(q.options.slice(0, want.length)) === JSON.stringify(want), JSON.stringify(q.options).slice(0, 400));
    check('quiet: still an instance of BrowserWindow (instanceof works through the wrap)', q.isInstance);
    check('quiet: at creation the native window gets alpha 0 + click-through + no taskbar, and is NOT shown (show:false)',
      JSON.stringify(q.nativeAtCreate) === JSON.stringify([['setOpacity', 0], ['setIgnoreMouseEvents', true], ['setSkipTaskbar', true]]), JSON.stringify(q.nativeAtCreate));
    check('quiet: its code reads back what it asked (opacity 0.5, focusable true)', q.readBack.opacity === 0.5 && q.readBack.focusable === true, JSON.stringify(q.readBack));
    check('quiet: setOpacity/setIgnoreMouseEvents/setFocusable/focus never reach the window; show() is showInactive()',
      JSON.stringify(q.nativeAfter) === JSON.stringify([['showInactive']]), JSON.stringify(q.nativeAfter));
    check('quiet: the overrides are not enumerable (Object.keys(win) unchanged)', JSON.stringify(q.ownKeys) === JSON.stringify(['webContents', 'native']), JSON.stringify(q.ownKeys));
    check('quiet: Electron\'s default show:true -> shown INACTIVE, after the quiet styles', JSON.stringify(q.defaultShow) === JSON.stringify([['setOpacity', 0], ['setIgnoreMouseEvents', true], ['setSkipTaskbar', true], ['showInactive']]), JSON.stringify(q.defaultShow));
    check('quiet: the tray is the stand-in (menu kept, no icon)', q.tray.quiet && !q.tray.real && q.tray.menu && !q.tray.destroyed, JSON.stringify(q.tray));
  }

  /* ---- 1d. main.js installs it first ---- */
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const at = main.indexOf("require('./lib/test-quiet').install(process.argv, process.env);");
  const el = main.indexOf("require('electron')");
  check('main.js: installs lib/test-quiet.js before its first require(\'electron\')', at > 0 && el > at, `${at} vs ${el}`);
  // CODE lines only: comments may point readers at lib/test-quiet.js (one at main.js ~9198 does), and
  // counting those made this fail on every machine (zero-fail lane, 2026-10-14).
  const quietCode = main.split(/\r?\n/).filter((l) => /test-quiet/.test(l) && !/^\s*(\/\/|\/?\*)/.test(l));
  check('main.js: one install line, nothing else of it (code lines naming test-quiet)', quietCode.length === 1 && /^require\('\.\/lib\/test-quiet'\)\.install\(process\.argv, process\.env\);$/.test(quietCode[0].trim()), quietCode.map((l) => l.trim().slice(0, 80)));
  const tq = fs.readFileSync(path.join(__dirname, 'test-quiet.js'), 'utf8');
  check('test-quiet.js: no window title or app name in its log lines', !/process\.stdout\.write\(`[^`]*\$\{[^}]*(title|getTitle|name)/.test(tq));

  /* ---- 2. real windows, in an Electron child ---- */
  if (!process.argv.includes('--no-electron')) {
    const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    let games = 0;
    try {
      const r = require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 20000 });
      games = parseInt(String(r.stdout).trim(), 10) || 0;
    } catch (_) { games = 0; }
    if (games) check('electron: no game running (the Electron part was not run)', false, `${games} game process(es)`);
    else if (!fs.existsSync(exe)) check('electron: node_modules/electron is installed', false, exe);
    else {
      const ud = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mantle-qtest-'));
      const r = require('child_process').spawnSync(exe, [__filename, '--electron-child', `--user-data-dir=${ud}`], { encoding: 'utf8', timeout: 90000, env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '' }) });
      try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* a temp dir */ }
      const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('QUIETCHILD '));
      if (!line) check('electron: the child ran and reported', false, `status ${r.status}; ${String(r.stderr || '').slice(-600)}`);
      else {
        const res = JSON.parse(line.slice(11));
        for (const c of res.checks) check(`electron: ${c.name}`, c.ok, c.detail);
        for (const n of res.notes || []) console.log(`  note: ${n}`);
      }
    }
  }

  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`QUIET TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length || !passed ? 1 : 0);
})().catch((err) => { console.log(`QUIET TEST: crashed: ${err && err.stack}`); process.exit(1); });

/* ===== the Electron child: its own windows only, all quiet ===== */
function child() {
  const visible = process.env.MANTLE_TEST_VISIBLE === '1';
  const Q = require('./test-quiet');
  const real = require('electron');   // Electron's own module, kept for the pixel control
  const installed = Q.install(['electron.exe', '.', '--test', '--profile-name=qtest'], {}, { log: () => {} });
  const { app, BrowserWindow, Tray, nativeImage, screen, desktopCapturer } = require('electron');
  const checks = [];
  const notes = [];
  const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, detail: cond ? undefined : detail });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const done = () => { process.stdout.write(`QUIETCHILD ${JSON.stringify({ checks, notes })}\n`); app.exit(0); };
  setTimeout(() => { ok('the child finished in time', false, '60 s'); done(); }, 60000).unref();
  app.whenReady().then(async () => {
    const made = [];
    try {
      ok('installed in the child', installed === true);
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const n = {
        ex: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
        layered: user32.func('int __stdcall GetLayeredWindowAttributes(intptr_t hwnd, void *key, void *alpha, void *flags)'),
        visible: user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)'),
        fg: user32.func('intptr_t __stdcall GetForegroundWindow()'),
        pidOf: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)'),
        fromPoint: user32.func('intptr_t __stdcall WindowFromPoint(int64 pt)'),
        ancestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 flags)'),
        rect: user32.func('int __stdcall GetWindowRect(intptr_t hwnd, void *rect)'),
      };
      const hwnd = (w) => { const b = w.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
      const pidOf = (h) => { const b = Buffer.alloc(4); n.pidOf(h, b); return b.readUInt32LE(0); };
      const alphaOf = (h) => {
        const ex = Number(n.ex(h, -20));
        if (!(ex & Q.WS.WS_EX_LAYERED)) return 255;
        const k = Buffer.alloc(4), a = Buffer.alloc(1), f = Buffer.alloc(4);
        if (!n.layered(h, k, a, f)) return 'unreadable';
        return (f.readUInt32LE(0) & 2) ? a.readUInt8(0) : 255;
      };
      const rectOf = (h) => { const b = Buffer.alloc(16); n.rect(h, b); return { l: b.readInt32LE(0), t: b.readInt32LE(4), r: b.readInt32LE(8), b: b.readInt32LE(12) }; };
      const fg0 = Number(n.fg());
      const fgOurs = () => { const f = Number(n.fg()); return f && pidOf(f) === process.pid; };
      const work = screen.getPrimaryDisplay().workArea;
      const page = 'data:text/html,' + encodeURIComponent('<body style="margin:0;background:#ff00ff"></body>');

      const pop = new BrowserWindow({ show: false, frame: false, transparent: true, width: 300, height: 200, x: work.x + 60, y: work.y + 60, webPreferences: { sandbox: true } });
      const framed = new BrowserWindow({ width: 320, height: 220, x: work.x + 420, y: work.y + 60, backgroundColor: '#ff00ff', title: 'qtest', webPreferences: { sandbox: true } });
      const asks = new BrowserWindow({ show: false, frame: false, transparent: true, focusable: true, width: 260, height: 160, x: work.x + 800, y: work.y + 60, webPreferences: { sandbox: true } });
      made.push(pop, framed, asks);
      await Promise.all(made.map((w) => w.loadURL(page)));
      pop.show();
      asks.show();
      asks.focus();
      pop.setOpacity(1);
      pop.setIgnoreMouseEvents(false);
      asks.setFocusable(true);
      await wait(700);

      for (const [what, w] of [['a transparent pop-up (show())', pop], ['a framed window left at show:true', framed], ['a pop-up asking focusable:true, then focus()', asks]]) {
        const h = hwnd(w);
        const ex = Number(n.ex(h, -20));
        const bits = { layered: !!(ex & Q.WS.WS_EX_LAYERED), through: !!(ex & Q.WS.WS_EX_TRANSPARENT), noact: !!(ex & Q.WS.WS_EX_NOACTIVATE), tool: !!(ex & Q.WS.WS_EX_TOOLWINDOW) };
        ok(`${what}: shown (WS_VISIBLE; isVisible())`, n.visible(h) && w.isVisible());
        ok(`${what}: layered alpha 0 (nothing drawn)`, alphaOf(h) === 0, String(alphaOf(h)));
        ok(`${what}: click-through, not activatable, a tool window`, bits.layered && bits.through && bits.noact && bits.tool, JSON.stringify(bits));
        ok(`${what}: never focused`, !w.isFocused());
        const r = rectOf(h);
        const pt = { x: Math.floor((r.l + r.r) / 2), y: Math.floor((r.t + r.b) / 2) };
        const hit = Number(n.fromPoint((BigInt(pt.y) << 32n) | BigInt(pt.x >>> 0)));
        const root = hit ? Number(n.ancestor(hit, 2)) || hit : 0;
        ok(`${what}: a click at its centre does not land on it`, root !== h);
      }
      ok('the window\'s code reads back what it asked (opacity 1, focusable true)', pop.getOpacity() === 1 && asks.isFocusable() === true, JSON.stringify([pop.getOpacity(), asks.isFocusable()]));
      ok('the foreground never became this test\'s', !fgOurs() && (fg0 === 0 || Number(n.fg()) === fg0 || pidOf(Number(n.fg())) !== process.pid));
      ok('BrowserWindow statics work through the wrap (getAllWindows, fromWebContents, instanceof)',
        BrowserWindow.getAllWindows().includes(pop) && BrowserWindow.fromWebContents(pop.webContents) === pop && pop instanceof BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function');

      // capturePage still renders at alpha 0
      for (const [what, w] of [['the transparent pop-up', pop], ['the framed window', framed]]) {
        const img = await w.webContents.capturePage();
        const sz = img.getSize();
        const bmp = img.toBitmap();
        const at = ((Math.floor(sz.height / 2) * sz.width) + Math.floor(sz.width / 2)) * 4;
        const px = { b: bmp[at], g: bmp[at + 1], r: bmp[at + 2] };
        ok(`capturePage of ${what} still has its page (magenta at the centre)`, !img.isEmpty() && px.r > 200 && px.g < 60 && px.b > 200, JSON.stringify({ sz, px }));
      }

      // window.open children are quietened too (the backstop)
      pop.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, width: 120, height: 80 } }));
      const kid = new Promise((resolve) => { pop.webContents.once('did-create-window', (w) => resolve(w)); setTimeout(() => resolve(null), 5000); });
      await pop.webContents.executeJavaScript('window.open("about:blank"); 1', true);
      const k = await kid;
      await wait(100);
      if (!k) ok('window.open: a child window was made', false);
      else {
        made.push(k);
        const h = hwnd(k);
        const ex = Number(n.ex(h, -20));
        ok('window.open: the child is quiet too (alpha 0, click-through, tool window)', alphaOf(h) === 0 && (ex & Q.WS.WS_EX_TRANSPARENT) && (ex & Q.WS.WS_EX_TOOLWINDOW), JSON.stringify({ a: alphaOf(h), ex }));
      }

      // the tray stand-in
      const t = new Tray(nativeImage.createEmpty());
      ok('the tray is the stand-in (no icon drawn)', t.quiet === true && !t.isDestroyed());
      t.destroy();

      // the desktop's own pixels: none of the windows' magenta (counted in memory, never saved)
      const d = screen.getPrimaryDisplay();
      const phys = { w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor) };
      const grab = async () => {
        const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: phys.w, height: phys.h } });
        const s = srcs.find((x) => String(x.display_id) === String(d.id)) || srcs[0];
        return s ? s.thumbnail : null;
      };
      const magenta = (img, w) => {
        const sz = img.getSize();
        const sx = sz.width / phys.w, sy = sz.height / phys.h;
        const r = rectOf(hwnd(w));
        const ox = d.bounds.x * d.scaleFactor, oy = d.bounds.y * d.scaleFactor;
        const bmp = img.toBitmap();
        let hits = 0, all = 0;
        for (let y = Math.max(0, Math.floor((r.t - oy) * sy)); y < Math.min(sz.height, Math.floor((r.b - oy) * sy)); y += 2) {
          for (let x = Math.max(0, Math.floor((r.l - ox) * sx)); x < Math.min(sz.width, Math.floor((r.r - ox) * sx)); x += 2) {
            const i = (y * sz.width + x) * 4;
            all++;
            if (bmp[i + 2] > 200 && bmp[i + 1] < 60 && bmp[i] > 200) hits++;
          }
        }
        return { hits, all, size: sz };
      };
      const img = await grab();
      if (!img || img.isEmpty()) notes.push('desktop pixels: the screen could not be read (display off?): not verified');
      else {
        for (const [what, w] of [['the transparent pop-up', pop], ['the framed window', framed], ['the focusable pop-up', asks]]) {
          const m = magenta(img, w);
          ok(`the desktop shows none of ${what} (magenta pixels in its place)`, m.all > 100 && m.hits / m.all < 0.02, JSON.stringify(m));
        }
        if (visible) {
          // The control (MANTLE_TEST_VISIBLE=1 only, while Owen is away): an ordinary window IS seen.
          const ctl = new real.BrowserWindow({ show: false, frame: false, width: 60, height: 60, x: work.x + 60, y: work.y + 300, backgroundColor: '#ff00ff', focusable: false, skipTaskbar: true });
          made.push(ctl);
          notes.push('pixel control: shown for 300 ms (MANTLE_TEST_VISIBLE=1)');
          ctl.showInactive();
          await wait(300);
          const img2 = await grab();
          ctl.hide();
          const m = magenta(img2, ctl);
          ok('pixel control: the count does see an ordinary window (MANTLE_TEST_VISIBLE=1)', m.hits / Math.max(1, m.all) > 0.5, JSON.stringify(m));
        } else notes.push('pixel control: skipped (it shows a 60x60 window for 300 ms; run with MANTLE_TEST_VISIBLE=1 while Owen is away)');
      }
    } catch (e) {
      ok('the child finished', false, e && e.stack);
    } finally {
      for (const w of made) { try { if (!w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ } }
      done();
    }
  });
}

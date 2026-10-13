'use strict';
/*
 * raise.test.js - EVERY MANTLE POP-UP IS ON TOP, EVERY TIME IT SHOWS (lane r7-ontop, 2026-10-01).
 *
 *   node lib/raise.test.js            -> "RAISE TEST: n passed, m failed[, 1 SKIPPED (needs MANTLE_TEST_VISIBLE=1)]"
 *   node lib/raise.test.js --no-electron   (the plain-node half only)
 *
 * Owen: "all that type of stuff should always be opened on top of everything". The volume pop-up was
 * shown at z 22, under three maximised apps: showInactive()/show() never re-order a window Windows has
 * let sink. lib/raise.js is the one fix every pop-up now uses.
 * 1. Plain node: raise()/check() against fake windows, and every pop-up's show path in the source
 *    calls it (the launcher, clipboard panel + notice, timer, notes pad, layouts and keep-on-top
 *    toasts; snap and Task View check). The desktop layer is never raised. A bar popover takes the
 *    volume pop-up down at once. No window title or app name in the lines touched.
 * 2. One Electron child (--electron-child), ITS OWN windows only, at 1% opacity, never focused, no input:
 *    a maximised non-topmost window of its own and a pop-up. The pop-up is sunk (Windows' way: put
 *    under every window while hidden; and the test's way: its own window lifted above it), then shown.
 *    showInactive() alone leaves it covered (the old code); raise() puts it where WindowFromPoint hits
 *    it. Then the REAL keep-on-top feature (lib/features/ontop.js, a fake sidecar, live flags) shows
 *    its toast after the same sink: on top on the new code, covered on the old
 *    (MANTLE_RAISE_TEST_ROOT=<a tree holding the old file> runs it against that tree).
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

if (process.argv.includes('--electron-child')) { child(); return; }

let passed = 0;
const failures = [];
const skipped = [];   // checks that need a real on-screen window and were not run (said in the summary)
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const after = (s, anchor, n) => { const i = s.indexOf(anchor); return i < 0 ? '' : s.slice(i, i + (n || 600)); };

// raise.check's timer is unref'd (it must never hold Mantle open): keep this run alive, and a run that
// ends without its summary line is a FAIL, never a silent exit 0.
const keepAlive = setInterval(() => {}, 1000);
let summarised = false;
process.on('exit', () => { if (!summarised) { console.log('RAISE TEST: ended before its summary line'); process.exitCode = 1; } });

(async () => {
  /* ---- 1a. the helper against fake windows ---- */
  const R = require('./raise');
  const fake = (o) => Object.assign({ calls: [], isDestroyed() { return false; },
    setAlwaysOnTop(on, level) { this.calls.push(`top:${on}:${level}`); }, moveTop() { this.calls.push('moveTop'); } }, o || {});
  let w = fake();
  check('raise: setAlwaysOnTop(true, level) THEN moveTop, no reason', R.raise(w, 'pop-up-menu') === null && w.calls.join() === 'top:true:pop-up-menu,moveTop', w.calls.join());
  w = fake();
  R.raise(w);
  check('raise: the default level is screen-saver (as snap and Task View)', w.calls[0] === 'top:true:screen-saver', w.calls.join());
  check('raise: a destroyed window is a reason, not a throw', R.raise(fake({ isDestroyed: () => true })) === 'the window is gone');
  const thrown = R.raise(fake({ moveTop() { throw new Error('boom'); } }));
  check('raise: a refusal is said in words', /^Windows would not put it on top \(boom\)$/.test(String(thrown)), thrown);

  let logs = [];
  let j = await R.check(fake(), { what: 'x', log: (l) => logs.push(l), delayMs: 0 });
  check('check: a fake window (no handle) is not judged and not logged', j.onTop === null && logs.length === 0, JSON.stringify(j));
  logs = [];
  j = await R.check(fake(), { what: 'x', log: (l) => logs.push(l), delayMs: 0, wanted: () => false, judge: () => ({ onTop: false, why: 'z' }) });
  check('check: closed again before the check -> nothing judged, nothing said', j.onTop === null && logs.length === 0, JSON.stringify(j));
  logs = [];
  w = fake();
  let n = 0;
  j = await R.check(w, { what: 'the test pop-up', log: (l) => logs.push(l), delayMs: 0, judge: () => (n++ ? { onTop: true, why: 'on top' } : { onTop: false, why: 'another window is in front of it at its centre' }) });
  check('check: covered once -> raised again and judged again; on top -> silent', j.onTop === true && j.why === 'on top after a second raise' && w.calls.join() === 'top:true:screen-saver,moveTop' && logs.length === 0, JSON.stringify({ j, calls: w.calls, logs }));
  logs = [];
  j = await R.check(fake(), { what: 'the test pop-up', log: (l) => logs.push(l), delayMs: 0, judge: () => ({ onTop: false, why: "another app's window (pid 4242) is in front of it at its centre" }) });
  check('check: still covered -> exactly ONE plain line, naming the pop-up and the reason', j.onTop === false && logs.length === 1 &&
    logs[0] === "the test pop-up: shown but NOT on top: another app's window (pid 4242) is in front of it at its centre", JSON.stringify(logs));
  logs = [];
  await R.check(fake(), { what: 'p', log: (l) => logs.push(l), delayMs: 0, judge: () => ({ onTop: null, why: 'the test could not look' }) });
  await R.check(fake(), { what: 'p', log: (l) => logs.push(l), delayMs: 0, judge: () => ({ onTop: null, why: 'the test could not look' }) });
  check('check: "could not be checked" is said once per reason, never silently', logs.length === 1 && /could not be checked: the test could not look/.test(logs[0]), JSON.stringify(logs));

  /* ---- 1a2. keyboard(): the keyboard the way the focus lane does it (lane mn-raise, 2026-10-12) ---- */
  {
    const kwin = (st) => ({ isDestroyed: () => false, isFocused: () => st.kb, focus() { st.calls.push('focus()'); if (st.inProcess) st.kb = true; } });
    const side = (st, ans) => ({ async send(cmd, a) { st.calls.push(`${cmd} ${a.hwnd}`); if (ans.ok) st.kb = !!ans.lands; return ans.ok ? { ok: true, result: ans.result } : { ok: false, error: ans.error }; } });
    let st = { kb: true, calls: [] };
    let k = await R.keyboard(kwin(st), { holds: () => st.kb, foreground: () => ({ hwnd: 1, mine: false }), sidecar: side(st, { ok: true }) , hwnd: 9 });
    check('keyboard: already holding it -> nothing asked', k.ok && k.how === 'already' && st.calls.length === 0, JSON.stringify({ k, st }));
    st = { kb: false, calls: [], inProcess: true };
    k = await R.keyboard(kwin(st), { holds: () => st.kb, foreground: () => ({ hwnd: 5, mine: true }), sidecar: side(st, { ok: true }), hwnd: 9 });
    check('keyboard: Mantle holds the foreground -> focus() in-process, the sidecar not asked', k.ok && k.how === 'in-process' && st.calls.join() === 'focus()', JSON.stringify({ k, st }));
    st = { kb: false, calls: [] };
    let granted = null;
    k = await R.keyboard(kwin(st), { holds: () => st.kb, foreground: () => ({ hwnd: 5, mine: false }), sidecar: side(st, { ok: true, lands: true, result: { how: 'alt', tried: ['direct: refused', 'attach: refused'], ms: 31 } }), hwnd: 9, sidecarPid: 77, grant: (pid) => { granted = pid; return { granted: false, reason: 'no right' }; } });
    check('keyboard: another app in front (a hot corner) -> the sidecar ladder, with the rung that won',
      k.ok && k.how === 'alt' && st.calls.join() === 'focus 9' && /the sidecar's ladder: alt after direct: refused; attach: refused, 31 ms; right not granted: no right/.test(k.words) && granted === 77, JSON.stringify({ k, st }));
    st = { kb: false, calls: [] };
    k = await R.keyboard(kwin(st), { holds: () => st.kb, foreground: () => ({ hwnd: 5, mine: false }), sidecar: side(st, { ok: true, lands: false, result: { how: 'direct' } }), hwnd: 9 });
    check('keyboard: the ladder says it landed but Windows says another window has it -> NOT ok, said', !k.ok && /but another window has the keyboard/.test(k.words) && !/right/.test(k.words), JSON.stringify(k));
    st = { kb: false, calls: [] };
    k = await R.keyboard(kwin(st), { holds: () => st.kb, foreground: () => null, sidecar: side(st, { ok: false, error: 'Windows refused the foreground change; tried direct: refused; attach: refused' }), hwnd: 9 });
    check('keyboard: the ladder lost -> NOT ok, with its rung-by-rung reason', !k.ok && k.words === 'Windows refused the foreground change (tried direct: refused; attach: refused)', JSON.stringify(k));
    k = await R.keyboard(kwin({ kb: false, calls: [] }), { holds: () => false, foreground: () => null, hwnd: 9 });
    check('keyboard: no sidecar -> NOT ok, said in words (never a throw)', !k.ok && /no sidecar/.test(k.words), JSON.stringify(k));
    k = await R.keyboard({ isDestroyed: () => true }, {});
    check('keyboard: a destroyed window -> NOT ok, said', !k.ok && k.words === 'the window is gone');
    const seen = [];
    await R.check(fake(), { log: () => {}, delayMs: 0, seeThrough: true, judge: (w, o) => { seen.push(o && o.seeThrough); return { onTop: true, why: 'on top' }; } });
    check('check: passes seeThrough on to the judge (a transparent window is judged by the z-order)', seen.length === 1 && seen[0] === true, JSON.stringify(seen));
    const f = R.foreground();
    check('foreground(): reads who has the keyboard, with no title or name in it', f === null || (typeof f.hwnd === 'number' && typeof f.mine === 'boolean' && !('title' in f) && !('exe' in f)), JSON.stringify(f));
  }

  /* ---- 1b. every pop-up's show path raises (each of these failed on the code before r7-ontop) ---- */
  const main = src('main.js');
  const launcher = after(main, 'const launcherGate = surfaceGate.createGate(', 1800);
  check('launcher: the live show raises it, at its own level (floating)', /launcherWin\.show\(\);\s*launcherWin\.focus\(\);[\s\S]{0,400}raiseWin\.up\(launcherWin, \{ level: 'floating'/.test(launcher));
  check('launcher: a --test show is still never raised (never in front of Owen)', /if \(flags\.test\) \{[\s\S]{0,120}launcherWin\.showInactive\(\);\s*\} else/.test(launcher));
  check('main.js requires the one helper', /const raiseWin = require\('\.\/lib\/raise'\);/.test(main));
  const clip = src('lib/features/clipboard.js');
  check('clipboard panel: the live show raises it', /win\.show\(\); win\.focus\(\);\s*\/\/[^\n]*\n\s*raiseWin\.up\(win, \{ what: 'the clipboard panel'/.test(clip));
  check('clipboard notice: raised every time it announces (never in a test)', /if \(!win\.isVisible\(\)\) win\.showInactive\(\);\s*\/\/[^\n]*\n\s*if \(!test\) raiseWin\.up\(win, \{ what: 'the clipboard notice'/.test(clip));
  const timer = src('lib/features/timer.js');
  check('timer pop-up: raised as it shows', /win\.showInactive\(\);[^\n]*\n\s*\/\/[^\n]*\n\s*raiseWin\.up\(win, \{ what: 'the timer pop-up'/.test(timer));
  const notes = src('lib/features/notes.js');
  check('notes pad: raised as it opens, at its own level (pop-up-menu)', /w\.show\(\); w\.focus\(\);\s*\/\/[^\n]*\n\s*raiseWin\.up\(w, \{ level: 'pop-up-menu', what: 'the notes pad'/.test(notes));
  const lay = src('lib/features/layouts.js');
  check('layouts toast: raised on every show, one already up included', /w\.showInactive\(\);\s*\/\/[^\n]*\n\s*raiseWin\.up\(w, \{ what: 'the layouts pop-up'/.test(lay));
  const ont = src('lib/features/ontop.js');
  check('keep-on-top toast: raised on every show', /w\.showInactive\(\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*raiseWin\.up\(w, \{ what: 'the keep-on-top pop-up'/.test(ont));
  check('keep-on-top toast: its failure line never carries the app name (res.text)', !/could not show \([^\n]*\$\{res\.text\}/.test(ont));
  for (const [f, what] of [['lib/features/snap.js', 'snap #'], ['lib/features/taskview.js', 'Task View #']]) {
    const s = src(f);
    check(`${f}: the reveal raises, then CHECKS`, /S\.win\.setAlwaysOnTop\(true, 'screen-saver'\);\s*S\.win\.moveTop\(\);[\s\S]{0,700}raiseWin\.check\(S\.win, \{ what: `/.test(s) && s.includes(what));
  }
  for (const f of ['lib/features/clipboard.js', 'lib/features/timer.js', 'lib/features/notes.js', 'lib/features/layouts.js', 'lib/features/ontop.js', 'lib/features/snap.js', 'lib/features/taskview.js']) {
    check(`${f} requires the one helper`, /const raiseWin = require\('\.\.\/raise'\);/.test(src(f)));
  }
  // Already on top on every show before r7-ontop: guarded so it stays that way.
  check('switcher: the summon places it HWND_TOPMOST (or setAlwaysOnTop + moveTop)', /top \? HWND_TOPMOST : 0/.test(src('lib/switcher.js')) && /if \(top\) \{ S\.win\.setAlwaysOnTop\(true, 'screen-saver'\); S\.win\.moveTop\(\); \}/.test(src('lib/switcher.js')));
  check('screenshot: overlays and the card are placed HWND_TOPMOST', /top \? HWND_TOPMOST : 0/.test(src('lib/features/screenshot.js')) && /place\(card, [^\n]*, true\)/.test(src('lib/features/screenshot.js')));
  check('bar: every reveal re-asserts the band and raises', (main.match(/barWin\.setAlwaysOnTop\(true, 'screen-saver'\);\s*\/\/[^\n]*\n\s*raiseBar\(why\);/g) || []).length === 2);
  check('bar: a popover opening raises the bar (its popovers live inside it)', /if \(open && !flags\.dock\) raiseBar\('a popover opened'\);/.test(main));
  // The desktop is the thing everything sits in front of: never raised.
  check('desktop layer: never raised, never made topmost', !/desktopWin\.(moveTop|setAlwaysOnTop)\(|raiseWin\.\w+\(desktopWin|raiseWin\.\w+\(g\.win/.test(main));
  check('bar: the "covered" log line carries no window title', !/the bar is covered by \$\{what\}/.test(main) && !/process\.stdout\.write\(`mantle: the bar is covered by[^\n]*o\.title/.test(main));

  /* ---- 1c. a bar popover takes the volume pop-up down at once ---- */
  const pop = after(main, "'bar.popover': async (a) => {", 1200);
  const di = pop.indexOf('if (open) dismissOsd(');
  check('bar popover: the volume pop-up is taken down BEFORE the popover opens', di > 0 && di < pop.indexOf("revealBar('a bar popover opened')"), `at ${di}`);
  check('dismissOsd: the pop-up\'s own unconditional hide (osd.faded, no seq), never a throw', /function dismissOsd\(why\) \{\s*const hide = COMMANDS\['osd\.faded'\];\s*if \(typeof hide !== 'function'\) return;[^\n]*\n\s*Promise\.resolve\(\)\.then\(\(\) => hide\(\{\}\)\)\.catch\(/.test(main));
  const osd = src('lib/features/osd.js');
  check('osd.faded with no seq still hides (the contract dismissOsd leans on)', /ctx\.command\('faded', async \(a\) => \{\s*const n = a && typeof a\.seq === 'number' \? a\.seq : null;\s*if \(n !== null && n < seq\) return[^\n]*\n\s*hide\(/.test(osd));

  /* ---- 2. real windows, in an Electron child ----
   * It judges with WindowFromPoint and the real z-order, so its windows must be REAL and clickable on
   * Owen's screen (1% opacity, but they take his clicks while up). Since r8-quiet (2026-10-01) it runs
   * only with MANTLE_TEST_VISIBLE=1, which uislot.sh / the ship's electron.sh give it once Owen has been
   * away 3 min; otherwise the summary says SKIPPED (never a silent pass). */
  const visible = process.env.MANTLE_TEST_VISIBLE === '1';
  if (!process.argv.includes('--no-electron') && !visible) {
    skipped.push('the Electron half (real windows judged by WindowFromPoint): run with MANTLE_TEST_VISIBLE=1 while Owen is away');
  } else if (!process.argv.includes('--no-electron')) {
    const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    let games = 0;
    try {
      const r = require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 20000 });
      games = parseInt(String(r.stdout).trim(), 10) || 0;
    } catch (_) { games = 0; }
    if (games) check('electron: no game running (the Electron part was not run)', false, `${games} game process(es)`);
    else if (!fs.existsSync(exe)) check('electron: node_modules/electron is installed', false, exe);
    else {
      const ud = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mantle-raise-test-'));
      const r = require('child_process').spawnSync(exe, [__filename, '--electron-child', `--user-data-dir=${ud}`], { encoding: 'utf8', timeout: 90000, env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '' }) });
      try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* a temp dir */ }
      const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RAISECHILD '));
      if (!line) check('electron: the child ran and reported', false, `status ${r.status}; ${String(r.stderr || '').slice(-600)}`);
      else for (const c of JSON.parse(line.slice(11)).checks) {
        check(`electron: ${c.name}`, c.ok, c.detail);
        if (process.env.MANTLE_RAISE_VERBOSE === '1') console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} electron: ${c.name}`);
      }
    }
  }

  for (const f of failures) console.log(`  FAIL ${f}`);
  for (const s of skipped) console.log(`  SKIPPED ${s}`);
  console.log(`RAISE TEST: ${passed} passed, ${failures.length} failed${skipped.length ? `, ${skipped.length} SKIPPED (needs MANTLE_TEST_VISIBLE=1)` : ''}`);
  summarised = true;
  clearInterval(keepAlive);
  process.exit(failures.length || !passed ? 1 : 0);
})().catch((err) => { console.log(`RAISE TEST: crashed: ${err && err.stack}`); process.exit(1); });

/* ===== the Electron child: its own windows only ===== */
function child() {
  const { app, BrowserWindow, screen } = require('electron');
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, detail: cond ? undefined : detail });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const done = () => { process.stdout.write(`RAISECHILD ${JSON.stringify({ checks })}\n`); app.exit(0); };
  setTimeout(() => { ok('the child finished in time', false, '60 s'); done(); }, 60000).unref();
  app.whenReady().then(async () => {
    try {
      const R = require('./raise');
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const setPos = user32.func('int __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)');
      const hwnd = (w) => { const b = w.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
      const HWND_BOTTOM = 1, SWP = 0x1 | 0x2 | 0x10;   // NOSIZE | NOMOVE | NOACTIVATE
      const work = screen.getPrimaryDisplay().workArea;
      const quiet = { show: false, frame: false, skipTaskbar: true, focusable: false, hasShadow: false, resizable: false, webPreferences: { sandbox: true } };

      // The test's own "maximised app": non-topmost, never focused, 1% opacity (nothing to see, nothing of Owen's).
      const app1 = new BrowserWindow(Object.assign({}, quiet, { x: work.x, y: work.y, width: work.width, height: work.height, backgroundColor: '#808080' }));
      app1.setOpacity(0.01);
      app1.showInactive();
      app1.maximize();
      await wait(250);

      const mk = (o) => {
        const p = new BrowserWindow(Object.assign({}, quiet, { width: 320, height: 180, x: Math.round(work.x + work.width / 2 - 160), y: Math.round(work.y + work.height / 2 - 90),
          alwaysOnTop: true, backgroundColor: '#404040' }, o || {}));
        p.setAlwaysOnTop(true, 'screen-saver');
        p.setOpacity(0.01);
        return p;
      };
      const show = async (p) => { p.showInactive(); await wait(150); };
      const sinkWindowsWay = async (p) => { p.hide(); await wait(60); setPos(hwnd(p), HWND_BOTTOM, 0, 0, 0, 0, SWP); };
      const sinkUnderOwn = async (p) => { p.hide(); await wait(60); app1.setAlwaysOnTop(true, 'screen-saver'); app1.moveTop(); await wait(60); };
      const unlift = () => app1.setAlwaysOnTop(false);

      for (const [kind, opts] of [['a clickable pop-up', {}], ['a click-through toast', { clickThrough: true }]]) {
        const p = mk();
        if (opts.clickThrough) p.setIgnoreMouseEvents(true);
        await show(p);
        ok(`${kind}: shown fresh, it is on top`, R.judge(p).onTop === true, JSON.stringify(R.judge(p)));
        for (const [how, sink] of [['sunk under every window while hidden (what Windows did)', sinkWindowsWay], ['the test\'s own window lifted above it with moveTop', sinkUnderOwn]]) {
          await sink(p);
          await show(p);
          const old = R.judge(p);
          ok(`${kind}, ${how}: showInactive() alone leaves it COVERED (the old code)`, old.onTop === false, JSON.stringify(old));
          ok(`${kind}, ${how}: raise() puts it on top`, R.raise(p) === null && R.judge(p).onTop === true, JSON.stringify(R.judge(p)));
          unlift();
        }
        // Each level a surface keeps: the launcher's 'floating' (Electron tucks that one under the
        // taskbar first; moveTop must still end on top) and the notes pad's 'pop-up-menu'.
        for (const level of ['floating', 'pop-up-menu']) {
          await sinkWindowsWay(p);
          await show(p);
          ok(`${kind}: raise() at '${level}' also ends on top`, R.raise(p, level) === null && R.judge(p).onTop === true, JSON.stringify(R.judge(p)));
        }
        // check(): the pop-up sunk again after its raise -> check raises once more and says nothing.
        await sinkUnderOwn(p);
        await show(p);
        R.raise(p);
        app1.moveTop();                                   // something lifted itself above it after the raise
        const logs = [];
        const c = await R.check(p, { what: 'the test pop-up', log: (l) => logs.push(l), delayMs: 0 });
        ok(`${kind}: check() finds it covered, raises it again, and it ends on top`, c.onTop === true && c.why === 'on top after a second raise' && R.judge(p).onTop === true && logs.length === 0, JSON.stringify({ c, logs }));
        unlift();
        p.destroy();
      }

      // THE REAL FEATURE: lib/features/ontop.js's toast, live flags, a fake sidecar, the same sink.
      const base = process.env.MANTLE_RAISE_TEST_ROOT || ROOT;
      const created = [];
      app.on('browser-window-created', (_e, w) => {
        created.push(w);
        try { w.setOpacity(0.01); } catch (_) { /* judged anyway */ }
        // Windows lets it sink: the test's own window goes above it before it ever shows.
        app1.setAlwaysOnTop(true, 'screen-saver'); app1.moveTop();
      });
      const wins = { 800: { pid: 20, topmost: false }, 801: { pid: 21, topmost: false } };
      let fg = '800';
      const send = async (cmd, a) => {
        const facts = (h) => ({ hwnd: h, pid: wins[h].pid, appPid: wins[h].pid, name: 'Test app', exe: 'test.exe', topmost: wins[h].topmost, refuse: null });
        if (cmd === 'ontop.front') return { ok: true, result: facts(fg) };
        if (cmd === 'ontop.info') return { ok: true, result: facts(a.hwnd) };
        if (cmd === 'ontop.check') return { ok: true, result: { windows: a.hwnds.map((x) => ({ hwnd: x.hwnd, alive: true, pid: wins[x.hwnd].pid, topmost: wins[x.hwnd].topmost })) } };
        if (cmd === 'ontop.set') { const was = wins[a.hwnd].topmost; wins[a.hwnd].topmost = !!a.on; return { ok: true, result: { hwnd: a.hwnd, pid: wins[a.hwnd].pid, was, topmost: !!a.on, changed: was !== !!a.on, tries: 1 } }; }
        return { ok: false, error: `unknown command ${cmd}` };
      };
      const cmds = {}, chords = {}, flogs = [];
      const store = {};
      const ctx = {
        name: 'ontop', flags: Object.freeze({ test: false, live: true }),
        log: (t) => flogs.push(t), health: () => {},
        sidecar: { send: (c, a) => send(c, a || {}), onReady: (fn) => { fn(); return () => {}; }, on: () => () => {}, ready: true },
        command: (v, fn) => { cmds[v] = fn; return `ontop.${v}`; },
        onChord: (c, fn) => { chords[c] = fn; return () => {}; },
        enabled: () => true, onEnabled: () => () => {}, replay: () => {}, broadcast: () => {},
        push: (w, name, p) => { try { w.webContents.send('mantle:event', { name, payload: p }); return true; } catch (_) { return false; } },
        page: (f) => path.join(base, 'ui', 'ontop', f || 'index.html'), preload: path.join(ROOT, 'preload.js'),
        settings: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
        host: { display: () => ({ workArea: work, bounds: screen.getPrimaryDisplay().bounds }), barRect: () => null },
        test: null,
      };
      const mod = require(path.join(base, 'lib', 'features', 'ontop.js'));
      const handle = mod.install(ctx);
      await wait(50);
      const r1 = await chords['Win+Ctrl+T']('Win+Ctrl+T');
      await wait(400);
      const toast = created.find((w) => !w.isDestroyed());
      ok('keep-on-top feature: the chord showed its toast (a window was made and shown)', !!toast && toast.isVisible(), JSON.stringify({ made: created.length, r1: r1 && r1.did }));
      if (toast) {
        const j1 = R.judge(toast);
        ok('keep-on-top feature: its toast is ON TOP though the window above it sank it first', j1.onTop === true, JSON.stringify(j1));
        // A second toast while the first is still up, after it sank again: the update path.
        unlift(); app1.setAlwaysOnTop(true, 'screen-saver'); app1.moveTop();
        await wait(60);
        fg = '801';
        await chords['Win+Ctrl+T']('Win+Ctrl+T');
        await wait(300);
        const j2 = R.judge(toast);
        ok('keep-on-top feature: a toast already up is raised again on the next show', j2.onTop === true, JSON.stringify(j2));
      }
      ok('keep-on-top feature: no on-top complaint was logged', !flogs.some((l) => /NOT on top|could not be put on top/.test(l)), `${flogs.filter((l) => /NOT on top|could not be put on top/.test(l)).length} complaint line(s)`);
      try { if (handle && typeof handle.stop === 'function') await handle.stop('the test is done'); } catch (_) { /* tidy-up only */ }
      unlift();
      /* ---- mn-raise (2026-10-12): a SEE-THROUGH window is judged by the z-order, and a parked window
       * given the keyboard first comes on screen in front with it ---- */
      try {
        const area = screen.getPrimaryDisplay().workArea;
        const box = { x: area.x + 80, y: area.y + 80, width: 640, height: 420 };
        const under = new BrowserWindow(Object.assign({}, box, { show: false, frame: false, skipTaskbar: true, focusable: true, resizable: false, backgroundColor: '#ffffff' }));
        try { under.setOpacity(0.01); } catch (_) { /* judged anyway */ }
        await under.loadURL('data:text/html,<body style="background:#fff"></body>');
        under.showInactive();
        const tvw = new BrowserWindow(Object.assign({}, box, { show: false, frame: false, transparent: true, backgroundColor: '#00000000', skipTaskbar: true, focusable: true, resizable: false, alwaysOnTop: true }));
        await tvw.loadURL('data:text/html,<body style="background:transparent;margin:0"></body>');
        tvw.showInactive();
        R.raise(tvw);
        await wait(250);
        const plain = R.judge(tvw);
        const seen = R.judge(tvw, { seeThrough: true });
        ok('see-through: a transparent window with nothing in front is judged ON TOP with seeThrough', seen.onTop === true, JSON.stringify({ plain, seen }));
        checks.push({ name: `see-through: (measured) WindowFromPoint alone says ${JSON.stringify(plain)}`, ok: true });
        const cover = new BrowserWindow(Object.assign({}, box, { show: false, frame: false, skipTaskbar: true, focusable: false, resizable: false, alwaysOnTop: true, backgroundColor: '#ffffff' }));
        try { cover.setOpacity(0.01); } catch (_) { /* judged anyway */ }
        await cover.loadURL('data:text/html,<body style="background:#fff"></body>');
        cover.showInactive();
        cover.setAlwaysOnTop(true, 'screen-saver'); cover.moveTop();
        await wait(150);
        const covered = R.judge(tvw, { seeThrough: true });
        ok('see-through: an opaque window really in front of it is still found (the walk is not blind)', covered.onTop === false && /another Mantle window is in front/.test(covered.why), JSON.stringify(covered));
        cover.destroy();

        // Keyboard first, then the screen: a PARKED window (off every monitor) takes the keyboard,
        // then moves on screen; it must arrive in front and still holding the keyboard.
        under.focus();
        await wait(150);
        const fg0 = R.foreground();
        const park = { x: -32000, y: -32000, width: box.width, height: box.height };
        const kw = new BrowserWindow(Object.assign({}, park, { show: false, frame: false, skipTaskbar: true, focusable: true, resizable: false, alwaysOnTop: true, backgroundColor: '#ffffff' }));
        try { kw.setOpacity(0.01); } catch (_) { /* judged anyway */ }
        await kw.loadURL('data:text/html,<body style="background:#fff"></body>');
        kw.showInactive();
        if (!(fg0 && fg0.mine)) {
          checks.push({ name: 'keyboard first: NOT RUN (the child could not hold the foreground itself, so the in-process path cannot be exercised; the ladder path needs a live sidecar)', ok: true });
        } else {
          const k = await R.keyboard(kw, {});
          ok('keyboard first: the parked window takes the keyboard in-process while off screen', k.ok && (k.how === 'in-process' || k.how === 'already') && R.hasKeyboard(kw) === true, JSON.stringify(k));
          R.raise(kw);
          kw.setBounds(box);
          await wait(200);
          const jk = R.judge(kw);
          ok('keyboard first: moved on screen, it is ON TOP and STILL has the keyboard', jk.onTop === true && R.hasKeyboard(kw) === true, JSON.stringify({ jk, kb: R.hasKeyboard(kw), fg: R.foreground() && R.foreground().mine }));
        }
        kw.destroy(); tvw.destroy(); under.destroy();
      } catch (err) {
        ok('mn-raise half ran without throwing', false, String(err && err.stack).slice(0, 600));
      }
      for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (_) { /* gone */ } }
    } catch (err) {
      ok('the child ran without throwing', false, String(err && err.stack).slice(0, 600));
    }
    done();
  });
}

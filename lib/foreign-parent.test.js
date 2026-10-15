'use strict';
/*
 * foreign-parent.test.js -- lib/foreign-parent.js and its wiring (lane mantle-crash, 2026-10-15).
 *   node lib/foreign-parent.test.js   -> "FOREIGN PARENT: n passed, m failed"
 * The real thing (a stand-in Progman killed under a live --test instance) is lib/explorer-exit.e2e.test.js.
 */
const fs = require('fs');
const path = require('path');
const fp = require('./foreign-parent');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 400) : ''));
}

/** A BrowserWindow stand-in: records hooks, hands out a fixed HWND. */
function fakeWin(hwnd, url) {
  const hooks = {};
  const buf = Buffer.alloc(8); buf.writeBigUInt64LE(BigInt(hwnd));
  return {
    hooks,
    hookWindowMessage(m, fn) { hooks[m] = fn; },
    getNativeWindowHandle() { return buf; },
    webContents: { getURL: () => url },
  };
}

// 1. the decision
check('WM_NCDESTROY after WM_DESTROY: nothing to do', fp.ncDestroyAction(true, false) === 'ok');
check('WM_NCDESTROY with no WM_DESTROY: finish the close', fp.ncDestroyAction(false, false) === 'finish');
check('finished once: never twice', fp.ncDestroyAction(false, true) === 'ok');

// 2. the dying-parent case: WM_NCDESTROY alone -> WM_DESTROY sent to the same window, once, logged with a name
{
  const sent = []; const lines = [];
  const w = fakeWin(0x1a2b3c, 'file:///C:/Users/x/mantle/ui/desktop/index.html');
  const ok = fp.guardWindow(w, { log: (l) => lines.push(l), sendDestroy: (h) => sent.push(h) });
  check('guardWindow hooks a window', ok === true);
  check('it hooks WM_DESTROY and WM_NCDESTROY', typeof w.hooks[fp.WM_DESTROY] === 'function' && typeof w.hooks[fp.WM_NCDESTROY] === 'function', Object.keys(w.hooks));
  check('a second guardWindow on the same window does nothing', fp.guardWindow(w, { sendDestroy: () => sent.push('again') }) === false);
  w.hooks[fp.WM_NCDESTROY]();
  check('orphaned: WM_DESTROY sent to that window, once', sent.length === 1 && sent[0] === 0x1a2b3c, sent);
  check('orphaned: one log line that names the window and says why', lines.length === 1 && /^the desktop window: its parent window in another process went away without closing it/.test(lines[0]) && /instead of crashing/.test(lines[0]), lines);
  w.hooks[fp.WM_NCDESTROY]();
  check('a second WM_NCDESTROY sends nothing more', sent.length === 1, sent);
}

// 3. the normal close: WM_DESTROY first -> nothing sent, nothing logged
{
  const sent = []; const lines = [];
  const w = fakeWin(0x777, 'file:///C:/m/ui/bar/index.html');
  fp.guardWindow(w, { log: (l) => lines.push(l), sendDestroy: (h) => sent.push(h) });
  w.hooks[fp.WM_DESTROY]();
  w.hooks[fp.WM_NCDESTROY]();
  check('normal close: nothing sent', sent.length === 0, sent);
  check('normal close: nothing logged', lines.length === 0, lines);
}

// 4. a send that fails is said, not thrown
{
  const lines = [];
  const w = fakeWin(0x888, 'about:blank');
  fp.guardWindow(w, { name: 'the test layer', log: (l) => lines.push(l), sendDestroy: () => { throw new Error('no such window'); } });
  let threw = false;
  try { w.hooks[fp.WM_NCDESTROY](); } catch (_) { threw = true; }
  check('a failed send never throws into the window procedure', !threw);
  check('a failed send is logged with its reason', lines.length === 1 && /could not finish the close in order: no such window/.test(lines[0]), lines);
}

// 5. junk in: no throw, no hook
check('guardWindow(null) is false', fp.guardWindow(null) === false);
check('guardWindow of a window with no hookWindowMessage is false', fp.guardWindow({ getNativeWindowHandle: () => Buffer.alloc(8) }) === false);

// 6. TaskbarCreated: the real registered message (RegisterWindowMessageW through koffi), hooked and delivered
{
  const id = fp.taskbarCreatedId();
  check('TaskbarCreated is a registered message (0xC000-0xFFFF)', id >= 0xC000 && id <= 0xFFFF, id);
  check('the same id every time', fp.taskbarCreatedId() === id);
  const heard = [];
  const w = fakeWin(0x999, 'file:///C:/m/ui/bar/index.html');
  check('hookShellRestart hooks it', fp.hookShellRestart(w, (how) => heard.push(how)) === true && typeof w.hooks[id] === 'function', Object.keys(w.hooks));
  w.hooks[id]();
  check('the listener hears TaskbarCreated', heard.length === 1 && heard[0] === 'TaskbarCreated', heard);
  const w2 = fakeWin(0x99a, 'x');
  fp.hookShellRestart(w2, () => { throw new Error('listener bug'); });
  let threw = false;
  try { w2.hooks[id](); } catch (_) { threw = true; }
  check('a listener that throws never throws into the window procedure', !threw);
  const p = fp.progmanThere();
  check('progmanThere answers true/false', p === true || p === false, p);
}

// 7. wiring: every window guarded from birth in main.js; nothing else hooks the same messages
{
  const root = path.join(__dirname, '..');
  const lf = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout may be CRLF
  const main = lf(path.join(root, 'main.js'));
  const reg = main.indexOf("app.on('browser-window-created', (_e, w) => {\n  foreignParent.guardWindow(w);\n  foreignParent.hookShellRestart(w, (how) => shellRestarted(how));");
  check('main.js guards every window and hooks TaskbarCreated on browser-window-created', reg > 0);
  const firstReady = main.indexOf('app.whenReady()');
  check('...registered at load, before any window can be made (before the first app.whenReady)', reg > 0 && firstReady > reg, { reg, firstReady });
  check('main.js: shellRestarted re-attaches (pending try now, made again, or re-check) and tells listeners',
    /function shellRestarted\(how\)/.test(main) && /remakeDesktop\(p\.n, p\.make, p\.when\)/.test(main) && /making it again now that Explorer is back/.test(main) && /recheck: true \}, 4000\)\s*\n\s*\.then\(\(r\) => process\.stdout\.write\(`mantle: desktop layer: re-checked after Explorer came back/.test(main));
  check('main.js: the features host has onShellRestart', /\n\s*onShellRestart,\n/.test(main));
  check('main.js: tries run out with no Progman -> wait for Explorer (poll), not "restart Mantle"', /if \(\/no Progman window\/\.test\(r\.reason \|\| ''\)\) \{[\s\S]{0,400}startShellPoll\(r\.reason\)/.test(main));
  const topbar = lf(path.join(root, 'lib', 'features', 'topbar.js'));
  check('topbar.js takes its strip again when Explorer restarts, and lets go of the listener at stop',
    /ctx\.host\.onShellRestart\(\(\) => \{ if \(!S\.stopped && ctx\.enabled\(\)\) reserve\('Explorer restarted'\)/.test(topbar) && /if \(shellOff\) \{ try \{ shellOff\(\); \}/.test(topbar));
  const taskbar = lf(path.join(root, 'sidecar', 'Taskbar.cs'));
  check('sidecar AppBars.Reserve registers again when the shell window changed', /shellThen != shellNow\)[\s\S]{0,200}_registered\.Remove\(key\)/.test(taskbar) && /_shellAt\[key\] = shellNow;/.test(taskbar));
  // one callback per message per window (hookWindowMessage): a second hook would silently replace the guard
  const offenders = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|\.git|bin|obj)$/.test(e.name)) scan(f); continue; }
      if (!/\.js$/.test(e.name) || /\.test\.js$/.test(e.name) || e.name === 'foreign-parent.js') continue;
      const s = fs.readFileSync(f, 'utf8');
      if (/hookWindowMessage\(\s*(0x0*2|2|0x0*82|130|WM_N?C?DESTROY|[^,]*[Tt]askbar)/.test(s)) offenders.push(path.relative(root, f));
    }
  };
  scan(path.join(root, 'lib'));
  if (/hookWindowMessage\(\s*(0x0*2|2|0x0*82|130|WM_N?C?DESTROY|[^,]*[Tt]askbar)/.test(main)) offenders.push('main.js');
  check('nothing else hooks WM_DESTROY, WM_NCDESTROY or TaskbarCreated (it would replace the guard)', offenders.length === 0, offenders);
}

// 8. what Explorer coming back does to the desktop layer (main.js shellBackAction, run from its tested region)
{
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const a = src.indexOf('// <mainrel:desktopremake>');
  const b = src.indexOf('// </mainrel:desktopremake>');
  const c = vm.createContext({ Array, Math, Date });
  vm.runInContext(`${src.slice(a, b)}\n;globalThis.__out = { shellBackAction };`, c);
  const act = c.__out.shellBackAction;
  const base = { test: false, shuttingDown: false, paused: false, pending: false, layer: false, held: false };
  const t = (o) => act(Object.assign({}, base, o));
  check('Explorer back: a test run re-attaches nothing', t({ test: true, pending: true }) === 'none');
  check('Explorer back: not while quitting or after "Put Windows back"', t({ shuttingDown: true }) === 'none' && t({ paused: true }) === 'none');
  check('Explorer back: a try waiting on its back-off runs NOW', t({ pending: true, layer: true, held: true }) === 'try-now');
  check('Explorer back: a layer given up on is made again', t({ layer: false }) === 'make');
  check('Explorer back: a try already on its way is left to finish', t({ layer: true, held: true }) === 'wait');
  check('Explorer back: a layer still there is re-checked (an orphan is rejoined)', t({ layer: true }) === 'recheck');
}

for (const f of failures) console.log('FAIL ' + f);
console.log(`FOREIGN PARENT: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;

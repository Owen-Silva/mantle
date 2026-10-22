'use strict';
/*
 * focus-pin.test.js -- an app switch on the real desktop must not close a --test bar's open dropdown
 * (lane mantle-idlefix-race, 2026-10-17). Pure node.
 *
 * THE FLAKE. lib/apppower.e2e.test.js failed ~3 runs in 10 at "cpu: the burner's row arrives decorated by
 * main ... -- []" (and, the same cause later in a run: "the CPU dropdown opens from its meter", "grow: the
 * window grew for the panel", "a click on the burner's row opens its panel", "keys: Down reaches ..."). Its
 * page recorder showed CPU detail samples with 5 decorated rows every second, then a topbar.focus for
 * ANOTHER window (the user switching between Quartz and Helm, his input idle 0 ms), then only plain samples:
 * the dropdown had closed. A --test instance never takes the keyboard (lib/test-quiet.js), so the
 * desktop's real foreground changes reach its bar through the sidecar's focus hook (main onTopbar), and
 * the page's takeFocus closes any open menu on a new app (right for the live bar: a menu belongs to the
 * app it opened over). The test then waited 60 s for rows in a closed menu. Nothing in the idle-CPU work
 * (game watch, stats gate, window list) is on that path: it fails the same on base.
 *
 * THE FIX (lib/features/topbar.js, TEST ONLY): MANTLE_TOPBAR_TEST_PIN_FOCUS=1 in a --test instance keeps
 * the bar on the first app it was given; a later foreground change to another window is counted and said
 * once in the log, not followed. Mantle's own windows, the pinned app's own events and every live bar are
 * unchanged. lib/apppower.e2e.test.js sets it.
 *
 * The REAL code runs, not a copy: main's onTopbar (and the pin line) out of lib/features/topbar.js, the
 * page's takeFocus, tellClosed and topbar.stats handler out of ui/topbar/topbar.js, in vms against fakes;
 * main's pushes are delivered to the page as the preload would.
 * Point it at other files (the fail-before proof): TOPBAR_MAIN=<lib/features/topbar.js> TOPBAR_PAGE=<ui/topbar/topbar.js>
 *   node ui/topbar/focus-pin.test.js   -> "TOPBAR FOCUS PIN: n passed, m failed"
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const MAIN = process.env.TOPBAR_MAIN || path.join(ROOT, 'lib', 'features', 'topbar.js');
const PAGE = process.env.TOPBAR_PAGE || path.join(__dirname, 'topbar.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
  return ok;
}

/** The block that starts at the line matching `start` and ends at the first later line matching `end`. */
function grab(src, start, end) {
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex((l) => start.test(l));
  if (i < 0) return '';
  for (let j = i + 1; j < lines.length; j++) if (end.test(lines[j])) return lines.slice(i, j + 1).join('\n');
  return '';
}
const line = (src, re) => (src.split(/\r?\n/).find((l) => re.test(l)) || '');

/* ---- main: onTopbar, with the pin line when the file has one ---------------------------------- */
function loadMain(o) {
  const src = fs.readFileSync(MAIN, 'utf8');
  const parts = [line(src, /^    const PIN_FOCUS = /), grab(src, /^    function onTopbar\(ev\) \{/, /^    \}$/)];
  const S = { focus: null, lastApp: null, guard: { last: null } };
  const logs = [], pushes = [];
  const ctx = {
    S, test: !!o.test, process: { env: Object.assign({}, o.env || {}) }, console, Object, Date,
    push: (name, payload) => { pushes.push([name, payload]); if (o.deliver) o.deliver(name, payload); },
    refresh: () => {}, under: { kick() {} },
    ctx: { log: (s) => logs.push(String(s)) },
  };
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n') + '\nthis.__onTopbar = onTopbar;', ctx, { filename: MAIN });
  return { S, logs, pushes, onTopbar: ctx.__onTopbar, found: { pin: !!parts[0], onTopbar: !!parts[1] } };
}

/* ---- the page: takeFocus / tellClosed / the topbar.stats handler ------------------------------- */
function loadPage() {
  const src = fs.readFileSync(PAGE, 'utf8');
  const parts = [
    grab(src, /^  function takeFocus\(f\) \{/, /^  \}$/),
    grab(src, /^  function tellClosed\(refocus\) \{/, /^  \}$/),
    grab(src, /^  mantle\.on\('topbar\.stats', \(ev\) => \{/, /^  \}\);$/),
  ];
  const S = { focus: null, menu: null, open: null, armed: null, uia: {}, asked: null, waitT: 0, stats: null, paused: null };
  const calls = [], drawn = { menus: 0, rows: 0, bar: 0 };
  const handlers = {};
  const ctx = {
    S, console, Object, Date, clearTimeout: () => {},
    menusEl: { innerHTML: '' },
    renderBar: () => { drawn.bar++; },
    renderStats: () => {}, tickStats: () => {}, renewDetail: () => {}, menuGlassEnd: () => {},
    // what the e2e waits for: renderStatMenu draws the CPU dropdown's rows (apppower.js render) from this sample
    renderStatMenu: (o2) => { drawn.menus++; const d = (S.stats || {})[o2.stat] || {}; if (Array.isArray(d.top) && d.top.some((e) => e && typeof e.ctl === 'boolean')) drawn.rows++; },
    call: (name, args) => { calls.push([name, args]); return Promise.resolve({ ok: true }); },
    mantle: { on: (name, fn) => { handlers[name] = fn; } },
  };
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n') + '\nthis.__takeFocus = takeFocus;', ctx, { filename: PAGE });
  const deliver = (name, payload) => {
    const p = JSON.parse(JSON.stringify(payload));   // the IPC copy
    if (name === 'topbar.focus') ctx.__takeFocus(p);
    else if (handlers[name]) handlers[name](p);
  };
  return { S, calls, drawn, deliver, found: parts.map((p) => !!p) };
}

/* ---- one run of the apppower e2e's CPU step ---------------------------------------------------- */
const APP_A = { kind: 'focus', hwnd: '1001', exe: 'a.exe', title: 'A', menu: null };
const APP_B = { kind: 'focus', hwnd: '2002', exe: 'b.exe', title: 'B', menu: null };
const SELF = { kind: 'focus', hwnd: '3003', self: true };
const sample = (n) => ({ detail: 'cpu', cpu: { pct: 30, top: [{ name: 'mpburn-x', exe: 'mpburn-x', pct: 25, key: 'mpburn-x', ctl: true, test: true }].concat(Array.from({ length: n - 1 }, (_, i) => ({ name: 'p' + i, pct: 1, key: null, ctl: false }))) } });

function scenario(o) {
  const page = loadPage();
  const main = loadMain({ test: o.test, env: o.env, deliver: page.deliver });
  main.onTopbar(APP_A);                         // the bar is shown over the app in front
  page.S.open = { stat: 'cpu' };                // the CPU dropdown opens from its meter (openStat)
  for (const ev of o.between || []) main.onTopbar(ev);   // ... and the desktop's foreground changes
  for (let i = 0; i < 3; i++) page.deliver('topbar.stats', sample(5));   // main's decorated detail samples, 1 s apart
  return { page, main, closedCalls: page.calls.filter(([n, a]) => n === 'topbar.menuState' && a && a.open === false) };
}

try {
  {
    const p = loadPage(), m = loadMain({ test: true, env: {} });
    check('the page functions were found (takeFocus, tellClosed, the topbar.stats handler)', p.found.every(Boolean), { found: p.found, PAGE });
    check('main\'s onTopbar was found', m.found.onTopbar, { MAIN });
  }

  /* 1. THE FLAKE, deterministic: the apppower e2e's instance (--test, MANTLE_TOPBAR_TEST_PIN_FOCUS=1), its CPU
   *    dropdown open, the user switches apps on his desktop before the burner's row is drawn */
  {
    const r = scenario({ test: true, env: { MANTLE_TOPBAR_TEST_PIN_FOCUS: '1' }, between: [APP_B] });
    check('pinned --test bar: an app switch on the desktop leaves the CPU dropdown open', !!(r.page.S.open && r.page.S.open.stat === 'cpu'), { open: r.page.S.open });
    check('pinned --test bar: the page never tells main the menu closed', r.closedCalls.length === 0, r.closedCalls);
    check('pinned --test bar: the burner\'s decorated row is drawn from the samples after the switch (3 of 3)', r.page.drawn.rows === 3, r.page.drawn);
    check('pinned --test bar: main keeps the first app (no topbar.focus for the other window)', r.main.S.focus && r.main.S.focus.hwnd === APP_A.hwnd && r.main.pushes.filter(([n, p]) => n === 'topbar.focus' && p.hwnd === APP_B.hwnd).length === 0,
      { focus: r.main.S.focus && r.main.S.focus.hwnd, pushes: r.main.pushes.map(([n, p]) => [n, p.hwnd]) });
    check('pinned --test bar: the page still shows the first app', r.page.S.focus && r.page.S.focus.hwnd === APP_A.hwnd, r.page.S.focus);
    const said = r.main.logs.filter((l) => /MANTLE_TOPBAR_TEST_PIN_FOCUS/.test(l));
    check('pinned --test bar: the pin is said in the log (no silent difference), with no app or title in it', said.length === 1 && !/a\.exe|b\.exe|\bA\b|\bB\b/.test(said[0]), r.main.logs);
  }
  {
    // many switches (the user moving between apps every few seconds through a 60 s run): said once, every one counted
    const r = scenario({ test: true, env: { MANTLE_TOPBAR_TEST_PIN_FOCUS: '1' }, between: [APP_B, APP_A, APP_B, { ...APP_B, hwnd: '4004' }] });
    check('pinned --test bar: four desktop switches, the dropdown still open and its rows drawn', !!(r.page.S.open && r.page.S.open.stat === 'cpu') && r.page.drawn.rows === 3, { open: r.page.S.open, drawn: r.page.drawn });
    check('pinned --test bar: the pin is said once however many switches come', r.main.logs.filter((l) => /MANTLE_TOPBAR_TEST_PIN_FOCUS/.test(l)).length === 1, r.main.logs);
    check('pinned --test bar: every switch to another window is counted (3: the first app coming back is followed)', r.main.S.pinned === 3, { pinned: r.main.S.pinned });
  }

  /* 2. what stays as it was */
  {
    const r = scenario({ test: true, env: { MANTLE_TOPBAR_TEST_PIN_FOCUS: '1' }, between: [SELF, { ...APP_A, title: 'A2' }] });
    check('pinned --test bar: Mantle\'s own window and the pinned app\'s own event still reach the page; the dropdown stays', r.main.pushes.filter(([n]) => n === 'topbar.focus').length === 3 && !!(r.page.S.open && r.page.S.open.stat === 'cpu'),
      { pushes: r.main.pushes.map(([n, p]) => [n, p.hwnd]), open: r.page.S.open });
    const t = loadMain({ test: true, env: { MANTLE_TOPBAR_TEST_PIN_FOCUS: '1' } });
    t.onTopbar(APP_A); t.onTopbar({ kind: 'title', hwnd: APP_A.hwnd, title: 'A again' });
    check('pinned --test bar: the pinned app\'s title change still goes to the page', t.pushes.some(([n, p]) => n === 'topbar.title' && p.hwnd === APP_A.hwnd), t.pushes);
  }
  {
    const r = scenario({ test: true, env: {}, between: [APP_B] });
    check('a --test bar without the pin follows the desktop as before (the self-test\'s fixture windows): the switch closes the dropdown', !r.page.S.open && r.closedCalls.length === 1 && r.page.drawn.rows === 0, { open: r.page.S.open, closed: r.closedCalls, drawn: r.page.drawn });
  }
  {
    const r = scenario({ test: false, env: { MANTLE_TOPBAR_TEST_PIN_FOCUS: '1' }, between: [APP_B] });
    check('the LIVE bar ignores the test switch: an app switch closes the open dropdown (a menu belongs to the app it opened over)', !r.page.S.open && r.closedCalls.length === 1, { open: r.page.S.open, closed: r.closedCalls });
    check('the LIVE bar follows the new app', r.main.S.focus && r.main.S.focus.hwnd === APP_B.hwnd && r.page.S.focus && r.page.S.focus.hwnd === APP_B.hwnd, { main: r.main.S.focus, page: r.page.S.focus });
  }
  {
    const r = scenario({ test: true, env: { MANTLE_TOPBAR_TEST_PIN_FOCUS: '1' }, between: [] });
    check('no switch: the rows are drawn and the dropdown stays open (the run as it passes)', !!r.page.S.open && r.page.drawn.rows === 3, r.page.drawn);
  }
} catch (e) {
  check('threw', false, e && e.stack || String(e));
}

for (const f of failures) console.log('  FAIL ' + f);
console.log(`TOPBAR FOCUS PIN: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;

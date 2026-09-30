/*
 * main-guard.test.js -- main.js's guard, tray, crash and report pieces (lane core-main, 2026-09-29),
 * run as the REAL code: each sits between `// <mainrel:NAME>` and `// </mainrel:NAME>` in main.js and
 * is lifted out and run in a vm with fakes, the lib/main-rel.test.js pattern (main.js needs Electron).
 *
 *   ipcguard     only Mantle's own ui/ pages are answered; no Mantle window navigates off ui/ or opens
 *                windows; `open` takes Settings pages and web links only; hwnds are whole numbers;
 *                a caller's own strings never reach the log.
 *   logtee       the log FILE has no user name, PC name or home folder in it (makeScrubber).
 *   tray         plain words, one line per cause, the ways out with their shortcuts, no rebuild when
 *                nothing changed, paused is not "7 things need a look".
 *   crash        a crash restarts Mantle at most 3 times in 10 minutes; the next start says so.
 *   report       the diagnostic report: every section present, nothing private in it.
 *   burst        a burst of display changes re-places the bar twice, not once per event.
 *
 * Pinned to the old code: the handler, `open` and the tray from the pre-lane main.js (MANTLE_BASE_MAIN,
 * default: this lane's snapshot) must show each fault.
 *
 *   node lib/main-guard.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const BASE_FILE = process.env.MANTLE_BASE_MAIN || '';
const BASE = BASE_FILE && fs.existsSync(BASE_FILE) ? fs.readFileSync(BASE_FILE, 'utf8') : '';

let passed = 0;
const failures = [];
const notes = [];
function ok(cond, what) { if (cond) passed++; else failures.push(what); }

function region(src, name) {
  const a = src.indexOf(`// <mainrel:${name}>`);
  const b = src.indexOf(`// </mainrel:${name}>`);
  if (a === -1 || b === -1) throw new Error(`main.js has no <mainrel:${name}> region`);
  return src.slice(a, b);
}
function run(code, ctx, expose) {
  const c = vm.createContext(Object.assign({ Buffer, Number, String, Math, Map, Set, Object, Array, JSON, Error, Promise, Date }, ctx));
  vm.runInContext(`${code}\n;globalThis.__out = { ${expose.join(', ')} };`, c);
  return c.__out;
}

/* ---- ipcguard ------------------------------------------------------------------------------ */
const UI = 'C:\\Users\\someone\\mantle\\ui';
const G = run(region(SRC, 'ipcguard'), { path: path.win32, nodeUrl: require('url') },
  ['isMantlePage', 'navigationVerdict', 'openTargetVerdict', 'hwndArg', 'logSafe', 'logView', 'guardContents', 'callerVerdict']);

const pages = [
  ['file:///C:/Users/someone/mantle/ui/bar/index.html', true, 'the bar'],
  ['file:///c:/users/SOMEONE/mantle/ui/settings/index.html?glass=acrylic', true, 'Settings with a query, other case'],
  ['file:///C:/Users/someone/mantle/ui/files/index.html#x', true, 'a hash'],
  ['file:///C:/Users/someone/mantle/ui', false, 'the ui folder itself'],
  ['file:///C:/Users/someone/mantle/main.js', false, 'outside ui/'],
  ['file:///C:/Users/someone/mantle/ui/../lib/x.html', false, 'a ../ climb'],
  ['file:///C:/Users/someone/mantle/ui/..%2Flib/x.html', false, 'an encoded / climb'],
  ['file:///C:/Users/someone/mantle/ui-evil/x.html', false, 'a sibling folder with the same prefix'],
  ['file://evilhost/share/mantle/ui/bar/index.html', false, 'a network share'],
  ['http://127.0.0.1:7373/', false, 'Mission Control over http'],
  ['https://example.com/ui/bar/index.html', false, 'the web'],
  ['data:text/html,<p>x', false, 'a data: page'],
  ['devtools://devtools/bundled/inspector.html', false, 'DevTools is not a caller'],
  ['', false, 'no address'],
  [null, false, 'null'],
];
for (const [u, want, what] of pages) ok(G.isMantlePage(u, UI) === want, `isMantlePage: ${what} -> ${want}`);

ok(G.navigationVerdict('file:///C:/Users/someone/mantle/ui/bar/index.html', UI).ok, 'navigation: a reload of a ui/ page is allowed');
ok(G.navigationVerdict('devtools://devtools/x', UI).ok, 'navigation: DevTools is allowed');
for (const u of ['https://evil.example/', 'http://127.0.0.1:7373/x', 'file:///C:/Windows/System32/', 'javascript:alert(1)', 'mantle-wp://abc/']) {
  const v = G.navigationVerdict(u, UI);
  ok(!v.ok && !v.why.includes(u.slice(8)), `navigation: ${u.split(':')[0]}: refused, and the reason names the scheme only (${v.why})`);
}

// guardContents: the handlers really prevent, and window.open is denied
function fakeContents(type) {
  const on = {};
  const c = { on: (ev, fn) => { on[ev] = fn; }, getType: () => type, setWindowOpenHandler: (fn) => { c.openHandler = fn; } };
  c.fire = (ev, url, isMain) => { let stopped = false; on[ev]({ url, isMainFrame: isMain !== false, preventDefault: () => { stopped = true; } }, url); return stopped; };
  return c;
}
const said = [];
const wc = fakeContents('window');
ok(G.guardContents(wc, UI, (l) => said.push(l)) === true, 'guardContents: a window is guarded');
ok(wc.fire('will-navigate', 'https://evil.example/') === true, 'guardContents: navigating a Mantle window to the web is stopped');
ok(wc.fire('will-navigate', 'file:///C:/Users/someone/mantle/ui/bar/index.html') === false, 'guardContents: a ui/ reload goes through');
ok(wc.fire('will-redirect', 'https://evil.example/', true) === true, 'guardContents: a main-frame redirect off ui/ is stopped');
ok(wc.fire('will-redirect', 'https://evil.example/', false) === false, "guardContents: an iframe's own redirect is its business");
ok(wc.openHandler({ url: 'https://evil.example/' }).action === 'deny', 'guardContents: window.open is denied');
ok(said.length === 3 && said.every((l) => !l.includes('evil.example')), `guardContents: one line per refusal, no address in it (${said.length})`);
ok(G.guardContents(fakeContents('webview'), UI, () => {}) === false, "guardContents: the PDF viewer's guest (not a window) is left alone");

// callerVerdict: the sender frame's address decides
ok(G.callerVerdict({ senderFrame: { url: 'file:///C:/Users/someone/mantle/ui/bar/index.html' } }, UI).ok, 'callerVerdict: the bar is answered');
ok(!G.callerVerdict({ senderFrame: { url: 'http://127.0.0.1:7373/' } }, UI).ok, 'callerVerdict: an http page is refused');
ok(!G.callerVerdict({ senderFrame: null }, UI).ok, 'callerVerdict: a frame already gone is refused');
ok(!G.callerVerdict({}, UI).ok, 'callerVerdict: no frame is refused');

// open: allowlist
const openOk = ['ms-settings:', 'ms-settings:network-wifi', 'ms-settings:batterysaver', 'ms-availablenetworks:', 'https://example.com/a?b=1', 'http://127.0.0.1:7373/'];
const openNo = ['C:\\Windows\\System32\\cmd.exe', '\\\\evilhost\\share\\x.exe', 'file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'javascript:alert(1)',
  'ms-settings:network&calc', 'https://a.example/"onload', 'steam://run/1', '', '   ', 42, null];
for (const t of openOk) ok(G.openTargetVerdict(t) === null, `open: allowed ${t}`);
for (const t of openNo) ok(typeof G.openTargetVerdict(t) === 'string', `open: refused ${JSON.stringify(t)}`);
ok(!/[a-z]:\\|%|0x/i.test(G.openTargetVerdict('C:\\x.exe')), 'open: the refusal is plain words');

// hwndArg
const hw = [[123456, '123456'], ['123456', '123456'], [' 42 ', '42'], ['007', '7'], [0, null], ['0', null], [-5, null], ['-5', null], ['0x1f', null], ['12abc', null], [1.5, null], ['', null], [null, null], [{}, null], ['12345678901234567890', null]];
for (const [v, want] of hw) ok(G.hwndArg(v) === want, `hwndArg(${JSON.stringify(v)}) -> ${want}`);

// logSafe / logView: the caller's strings are masked in the reason, Mantle's own words stay
const args = { ssid: 'Owen Home 5G', path: 'C:\\Users\\someone\\Documents\\taxes.pdf', action: 'connect' };
const masked = G.logSafe(args, 'Mantle could not connect to "Owen Home 5G": it is gone from disk: C:\\Users\\someone\\Documents\\taxes.pdf (connect)');
ok(!masked.includes('Owen Home 5G') && !masked.includes('taxes.pdf') && masked.includes('(connect)'), `logSafe: names and paths out, the action kept (${masked})`);
ok(G.logSafe({ q: 'ab' }, 'ab ab') === 'ab ab', 'logSafe: 1-2 letter strings are not hunted (they would shred the sentence)');
const lv = G.logView({ ssid: 'Owen Home 5G' }, { ok: false, reason: 'no "Owen Home 5G"', ssid: 'Owen Home 5G' });
ok(!lv.reason.includes('Owen') && lv.ssid === 'Owen Home 5G', 'logView: only the logged reason changes; the page still gets its own copy');
ok(G.logView({}, { ok: true, x: 1 }).x === 1, 'logView: a success is passed through as it is');

// baseline: the old handler answered a web page, and old `open` took anything
if (BASE) {
  const h0 = BASE.indexOf("ipcMain.handle('mantle:call', async (_e, name, args) => {");
  const h1 = BASE.indexOf('\n});', h0);
  const body = BASE.slice(h0 + "ipcMain.handle('mantle:call', ".length, h1 + 2);
  const old = run(`const handler = ${body.replace(/\)\s*$/, '')};`, { COMMANDS: { 'launcher.openFile': async () => 'opened' }, callLog: { result() {}, threw() {} } }, ['handler']).handler;
  old({ senderFrame: { url: 'https://evil.example/' } }, 'launcher.openFile', { path: 'x' }).then((r) => {
    ok(r && r.ok === true, 'baseline: the pre-lane handler answered a web page (the fault this closes)');
  });
  ok(/'open': async \(a\) => openRouted\(a && a\.target/.test(BASE), 'baseline: the pre-lane `open` passed any target straight on');
  ok(/app\.on\('web-contents-created'/.test(BASE) === false, 'baseline: the pre-lane main.js guarded no window it did not make itself');
  ok(/shutdown\('an uncaught exception'\);/.test(BASE) && !/exitCode/.test(BASE), 'baseline: the pre-lane crash path exited 0, so the logon task never restarted it');
  ok(/\$\{problems\.map\(\(p\) => p\.piece\)\.join\(', '\)\}/.test(BASE), 'baseline: the pre-lane tray printed internal piece names ("sidecar", "edge clip")');
} else notes.push('no MANTLE_BASE_MAIN: the pre-lane baselines were not run');

/* ---- logtee: scrubber ------------------------------------------------------------------------ */
const { makeScrubber, makeLogTee } = run(region(SRC, 'logtee'), { process, encodeURIComponent }, ['makeScrubber', 'makeLogTee']);
const scrub = makeScrubber({ home: 'C:\\Users\\jo smith', user: 'jo smith', host: 'DESKTOP-AB12' });
const lines = [
  ['mantle: started C:\\Users\\jo smith\\mantle-live\\main.js', 'mantle: started %USERPROFILE%\\mantle-live\\main.js'],
  ['at file:///C:/Users/jo%20smith/mantle/ui/bar/bar.js:12', 'at file:///%USERPROFILE%/mantle/ui/bar/bar.js:12'],
  ['{"p":"C:\\\\Users\\\\jo smith\\\\x"}', '{"p":"%USERPROFILE%\\\\x"}'],
  ['c:/users/JO SMITH/AppData', '%USERPROFILE%/AppData'],
  ['\\\\DESKTOP-AB12\\c$\\Users\\jo smith\\x', '\\\\<pc>\\c$\\Users\\<user>\\x'],
  ['the PC is desktop-ab12.', 'the PC is <pc>.'],
  ['C:\\Users\\jo smithy\\x', 'C:\\Users\\jo smithy\\x'],
];
for (const [inp, want] of lines) ok(scrub(inp) === want, `scrub: ${JSON.stringify(inp)} -> ${JSON.stringify(scrub(inp))}`);
// the real tee writes scrubbed lines to the file
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-guard-'));
const file = path.join(TMP, 'm.log');
const tee = makeLogTee(fs, file, { scrub: makeScrubber({ home: 'C:\\Users\\jo', user: 'jo', host: 'PC-9' }) });
tee.start('===== start: --log=C:\\Users\\jo\\AppData\\Roaming\\mantle\\mantle.log\n');
tee.write('mantle: loaded C:\\Users\\jo\\mantle\\ui\\bar\\index.html on PC-9\n');
const got = fs.readFileSync(file, 'utf8');
ok(!/\\jo\\|PC-9/.test(got) && got.includes('%USERPROFILE%\\mantle\\ui') && got.includes('<pc>'), `logtee: the file has no user or PC name (${got.replace(/\n/g, ' | ')})`);

/* ---- tray ----------------------------------------------------------------------------------- */
const T = run(region(SRC, 'tray'), {}, ['trayHealth', 'trayTemplate', 'menuSignature', 'wireTray', 'pieceWords', 'shortReason']);
const JARGON = /\bsidecar\b|\bhwnd\b|\bIPC\b|renderer|dryRun|AUMID|undefined|null|NaN|\[object/i;
const fine = T.trayHealth([], {});
ok(fine.head === 'Mantle is running normally' && fine.lines.length === 0 && fine.tip === 'Mantle\nRunning normally', 'tray: healthy says so, in words');
const down = 'sidecar exited with code 3221225477 and gave up after 3 restarts in a row; try again (retry) or restart Mantle';
const cascade = [
  { piece: 'sidecar', reason: down },
  { piece: 'taskbar', reason: `the Windows taskbar is untouched and still where Owen put it: ${down}` },
  { piece: 'desktop layer', reason: `the desktop layer is floating: ${down}` },
  { piece: 'Win key', reason: `the Win key still opens Start: ${down}` },
  { piece: 'edge clip', reason: 'the cursor is not confined; ClipCursor refused (error 5)' },
];
const hc = T.trayHealth(cascade, { sidecar: { status: 'down', gaveUp: true } });
ok(hc.head === '2 things need a look', `tray: one cause is one thing: ${hc.head}`);
ok(hc.lines[0] === "Mantle's link to Windows stopped (3 things wait on it)", `tray: the link line (${hc.lines[0]})`);
ok(hc.lines[1].startsWith('Bottom-edge guard: the cursor is not confined'), `tray: plain piece name, first clause only (${hc.lines[1]})`);
ok(hc.lines.every((l) => !JARGON.test(l) && l.length <= 90) && !JARGON.test(hc.head) && !JARGON.test(hc.tip), `tray: no jargon, short rows (${JSON.stringify(hc.lines)})`);
ok(hc.tip.length <= 120, 'tray: the hover text fits Windows\' 127-character limit');
const many = Array.from({ length: 9 }, (_, i) => ({ piece: `feature ${i}`, reason: 'off because of a thing' }));
const hm = T.trayHealth(many, {});
ok(hm.lines.length === 5 && /and 5 more, listed in Mantle Settings/.test(hm.lines[4]), `tray: at most 4 lines, the rest counted (${hm.lines.length})`);
const hp = T.trayHealth(cascade, { paused: true });
ok(hp.head === 'Paused: Windows is back to normal' && hp.lines[0] === 'Restart Mantle to use it again', 'tray: paused is not an alarm, and says the way back');
ok(T.trayHealth([], { test: true }).tip.startsWith('Mantle (test run)'), 'tray: a test run says so');
ok(T.pieceWords('bar backdrop') === 'Bar background' && T.pieceWords('Clipboard history') === 'Clipboard history', 'tray: backdrop and feature labels');

const feat = [{ label: 'Clipboard history', type: 'checkbox', checked: true, click: () => {} }];
const tpl = T.trayTemplate({ problems: [], shortcuts: { launcher: true, killSwitch: true }, hasSettings: true, featureItems: feat });
const ids = tpl.filter((i) => i.id).map((i) => i.id);
ok(ids.join(',') === 'launcher,settings,wallpapers,report,restart,restore,quit', `tray: the items, in order (${ids})`);
const byId = (items, id) => items.find((i) => i.id === id);
ok(byId(tpl, 'launcher').accelerator === 'Alt+Space' && byId(tpl, 'quit').accelerator === 'Ctrl+Alt+Shift+Backspace' && byId(tpl, 'settings').accelerator === 'Super+I', 'tray: shortcuts shown where they work');
ok(tpl.every((i) => i.registerAccelerator !== true), 'tray: showing a shortcut never registers it a second time');
const noKeys = T.trayTemplate({ problems: [], shortcuts: {}, featureItems: [] });
ok(!byId(noKeys, 'launcher').accelerator && !byId(noKeys, 'quit').accelerator && !byId(noKeys, 'settings'), 'tray: no shortcut shown that is not armed; no Settings item when it is off');
ok(tpl.find((i) => i.label === 'Features').submenu === feat, 'tray: the feature switches are one level down');
const labels = tpl.filter((i) => i.label).map((i) => i.label);
ok(labels.every((l) => !JARGON.test(l)), `tray: no jargon in any label (${labels.join(' | ')})`);
const tplDown = T.trayTemplate({ problems: cascade, sidecar: { status: 'down', gaveUp: true }, featureItems: [] });
const ri = tplDown.findIndex((i) => i.id === 'retry');
ok(ri > 0 && ri < tplDown.findIndex((i) => i.type === 'separator'), 'tray: "Reconnect Mantle to Windows" sits under the fault it fixes');
ok(!T.trayTemplate({ problems: cascade, sidecar: { status: 'down', gaveUp: false }, featureItems: [] }).some((i) => i.id === 'retry'), 'tray: no reconnect while it is still retrying by itself');
const tplPaused = T.trayTemplate({ problems: cascade, paused: true, sidecar: { gaveUp: true }, featureItems: [] });
ok(!tplPaused.some((i) => i.id === 'restore' || i.id === 'retry') && byId(tplPaused, 'restart').label === 'Restart Mantle to resume', 'tray: paused offers the way back, not "put Windows back" again');
ok(T.trayTemplate({ problems: [], recovery: 'Restarted by itself after an error at 14:02', featureItems: [] })[1].label.includes('Restarted by itself'), 'tray: the recovery line is under the head');
// signature: same look = same signature (no rebuild), a changed checkbox = a rebuild
const s1 = T.menuSignature(T.trayTemplate({ problems: [], featureItems: [{ label: 'A', type: 'checkbox', checked: true, click: () => 1 }] }));
const s2 = T.menuSignature(T.trayTemplate({ problems: [], featureItems: [{ label: 'A', type: 'checkbox', checked: true, click: () => 2 }] }));
const s3 = T.menuSignature(T.trayTemplate({ problems: [], featureItems: [{ label: 'A', type: 'checkbox', checked: false, click: () => 2 }] }));
ok(s1 === s2 && s1 !== s3, 'tray: the menu is rebuilt only when what it shows changes');
const wired = T.wireTray(T.trayTemplate({ problems: [], featureItems: [] }), { quit: () => 'q', report: () => 'r' });
ok(byId(wired, 'quit').click() === 'q' && byId(wired, 'report').click() === 'r' && !byId(wired, 'restart').click, 'tray: clicks are attached by id');
if (BASE) {
  const oldTray = BASE.slice(BASE.indexOf('function updateTray() {'), BASE.indexOf('function createTray() {'));
  ok(/Mantle — \$\{MODE\}/.test(oldTray) && !/Restart Mantle/.test(oldTray), 'baseline: the pre-lane tray had "Mantle — live" and no restart');
}

/* ---- crash ---------------------------------------------------------------------------------- */
const C = run(region(SRC, 'crash'), {}, ['crashPlan', 'recoveryLine', 'crashWhat', 'makeRejectionLog', 'CRASH_MAX_RESTARTS']);
const M = 60 * 1000;
let hist = [];
const plans = [];
for (const t of [0, 1 * M, 2 * M, 3 * M]) { const p = C.crashPlan(hist, t); plans.push(p.restart); hist = p.history; }
ok(plans.join(',') === 'true,true,true,false', `crash: 3 restarts in 10 min, the 4th stays down (${plans})`);
ok(C.crashPlan(hist, 20 * M).restart === true, 'crash: an hour-old history no longer counts');
ok(C.crashPlan([5 * M, 'junk', null, 99 * M], 6 * M).recent === 2, 'crash: junk and future entries are ignored');
ok(C.crashPlan(Array.from({ length: 50 }, (_, i) => i), 100).history.length <= 10, 'crash: the history file stays small');
const fmt = () => '14:02';
ok(C.recoveryLine({ at: 0, restarted: true }, 30 * M, fmt) === 'Restarted by itself after an error at 14:02', 'crash: the next start says it restarted');
ok(C.recoveryLine({ at: 0, restarted: false }, 30 * M, fmt) === 'Stopped after repeated errors at 14:02', 'crash: or that it had stopped');
ok(C.recoveryLine({ at: 0, restarted: true }, 61 * M, fmt) === null && C.recoveryLine(null, 0, fmt) === null, 'crash: an old or missing record says nothing');
const long = new Error(`boom at C:\\x\n${'y'.repeat(400)}`);
ok(C.crashWhat(long) === 'boom at C:\\x' && C.crashWhat('x'.repeat(300)).length === 160, 'crash: first line only, capped');
const rl = [];
const rej = C.makeRejectionLog((l) => rl.push(l));
for (let i = 0; i < 120; i++) rej(new Error('same'));
rej(new Error('other'));
ok(rl.length === 4 && /100 times/.test(rl[2]), `crash: 121 rejections wrote 4 lines, not 121 (${rl.length})`);

/* ---- report --------------------------------------------------------------------------------- */
const R = run(region(SRC, 'report'), {}, ['buildReport', 'makeRecentLines']);
const rec = R.makeRecentLines(3, () => new Date(2026, 8, 29, 14, 2, 3));
rec.add('mantle: a\nmantle: b\r\n\nmantle: c\nmantle: d');
ok(rec.list().length === 3 && rec.list()[0] === '14:02:03 mantle: b', 'report: the recent lines are bounded and stamped');
const snap = { when: '2026-09-29 14:02', version: '0.1.0', commit: 'abc1234', electron: '44.3.0', windows: '10.0.26200', mode: 'live', uptimeS: 3 * 3600 + 12 * 60,
  displays: [{ w: 2560, h: 1440, scale: 1.25, primary: true }, { w: 1920, h: 1080, scale: 1 }], memMB: { all: 612, processes: 14, main: 88 },
  health: hc, recovery: 'Restarted by itself after an error at 13:50', link: { status: 'down', restarts: 3, gaveUp: true }, features: { on: 18, off: 2, down: ['Clipboard history'] },
  recent: ['14:01:00 mantle: C:\\Users\\jo\\mantle\\x failed on PC-9'] };
const txt = R.buildReport(snap, makeScrubber({ home: 'C:\\Users\\jo', user: 'jo', host: 'PC-9' }));
for (const want of ['Mantle 0.1.0 (abc1234), running live, up 3 h 12 min', 'Windows 10.0.26200, Electron 44.3.0', '2560x1440 at 125% (main), 1920x1080 at 100%',
  'Memory: 612 MB in 14 processes', 'Health: 2 things need a look', "Mantle's link to Windows stopped", 'Restarted by itself after an error at 13:50',
  'Link to Windows: down, gave up restarting, 3 restart(s) in a row', 'Features: 18 on, 2 off; not working: Clipboard history', 'Last 1 warnings and errors']) {
  ok(txt.includes(want), `report: has "${want}"`);
}
ok(!/\\jo\\|PC-9/.test(txt) && txt.includes('%USERPROFILE%\\mantle'), 'report: no user name or PC name in it');
ok(R.buildReport({}, null).includes('No warnings or errors this run.'), 'report: an empty snapshot still reads as sentences');

/* ---- burst ---------------------------------------------------------------------------------- */
const B = run(region(SRC, 'burst'), {}, ['makeBurst']);
let now = 0;
const timers = [];
const clock = { setTimeout: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.live = false; } };
const advance = (ms) => { const end = now + ms; for (;;) { const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; now = due.at; due.live = false; due.fn(); } now = end; };
const runs = [];
const fire = B.makeBurst((why) => runs.push(why), Object.assign({ quietMs: 400 }, clock));
ok(fire('display metrics changed') === 'now' && runs.length === 1, 'burst: the first change runs at once');
for (let i = 0; i < 5; i++) { advance(50); fire('display metrics changed'); }
fire('a display was connected');
advance(2000);
ok(runs.length === 2 && /7 changes|6 changes/.test(runs[1]) && runs[1].includes('a display was connected'), `burst: 7 events -> 2 runs (${JSON.stringify(runs)})`);
fire('the PC woke from sleep');
ok(runs.length === 3, 'burst: after a quiet gap the next change runs at once again');

/* ---- done ----------------------------------------------------------------------------------- */
setTimeout(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  for (const n of notes) console.log('NOTE ' + n);
  for (const f of failures) console.log('FAIL ' + f);
  console.log('MAIN GUARD TEST: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
}, 50);

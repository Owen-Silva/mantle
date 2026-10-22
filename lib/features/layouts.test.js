'use strict';
/* layouts.test.js - window layouts, everything that needs no real window (lane layouts, 2026-09-27):
 * names, title words, the rect maths across scale factors and work areas, monitor choice, what a save
 * keeps, matching (exe + title words, one window per entry, missing entries), which apps may be
 * started, the summary line, the restore engine on a fake sidecar and clock, the feature's commands on
 * a fake ctx, and the launcher rows. The real windows half is sidecar/test-layouts.js.
 *
 *   node lib/features/layouts.test.js      -> "LAYOUTS UNIT TEST: n passed, m failed"
 */
const path = require('path');
const core = require('./_layouts-core');
const engine = require('./_layouts-run');
const bridge = require('../launcher-layouts');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(detail !== undefined ? `${name} (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : name);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- monitors used below (physical px) ---- */
const MON125 = { id: '1', device: '\\\\.\\DISPLAY1', primary: true, dpi: 120,
  bounds: { x: 0, y: 0, w: 1920, h: 1080 }, work: { x: 0, y: 44, w: 1920, h: 1036 } };   // a top bar of 44 px
const MON150 = { id: '2', device: '\\\\.\\DISPLAY2', primary: false, dpi: 144,
  bounds: { x: 1920, y: -200, w: 2560, h: 1440 }, work: { x: 1920, y: -200, w: 2560, h: 1392 } };
const MON100 = { id: '3', device: '\\\\.\\DISPLAY3', primary: false, dpi: 96,
  bounds: { x: -1280, y: 0, w: 1280, h: 1024 }, work: { x: -1280, y: 0, w: 1280, h: 984 } };

async function main() {
  /* ---- names ---- */
  check('name: trimmed and collapsed', core.cleanName('  Deep   work ').name === 'Deep work');
  check('name: empty refused in words', !core.cleanName('   ').ok && /needs a name/.test(core.cleanName('').reason));
  check('name: too long refused', !core.cleanName('x'.repeat(41)).ok);
  check('name: control characters removed', core.cleanName('a\u0007b').name === 'a b');
  check('find: case-insensitive', core.findLayout([{ name: 'Work' }], 'work').name === 'Work');

  /* ---- title words ---- */
  const tk = core.titleTokens('layouts.js - mantle - Visual Studio Code');
  check('title: hashed words, never the words', tk.length === 6 && tk.every((h) => /^[0-9a-f]{8}$/.test(h)) && !JSON.stringify(tk).includes('mantle'));
  check('title: bare numbers and 1-letter words dropped', eq(core.titleTokens('(3) Inbox a 2026'), core.titleTokens('Inbox')));
  check('title: same words, same tokens (case, order of repeats)', eq(core.titleTokens('Mantle mantle'), core.titleTokens('MANTLE')));
  const vs = (t) => core.titleTokens(t);
  check('title score: the same workspace scores higher', core.titleScore(vs('layouts.js - mantle - Visual Studio Code'), vs('features.js - mantle - Visual Studio Code')) >
    core.titleScore(vs('layouts.js - mantle - Visual Studio Code'), vs('server.js - northwind - Visual Studio Code')));
  check('title score: empty is 0', core.titleScore([], tk) === 0);

  /* ---- rect maths ---- */
  const f1 = { x: 7, y: 44, w: 953, h: 1036 };   // the left half of MON125's work area
  const rel = core.relRect(f1, MON125);
  check('rect: DIP relative to the work area at 125 %', eq(rel, { x: 5.6, y: 0, w: 762.4, h: 828.8 }), rel);
  check('rect: back to the same physical px at 125 %', eq(core.absRect(rel, core.workDip(MON125), MON125), f1), core.absRect(rel, core.workDip(MON125), MON125));
  for (const dpi of [96, 120, 144, 168, 192]) {
    const m = Object.assign({}, MON125, { dpi });
    const f = { x: 101, y: 53, w: 777, h: 555 };
    const back = core.absRect(core.relRect(f, m), core.workDip(m), m);
    check(`rect: exact round trip at ${Math.round(dpi / 0.96)} %`, eq(back, f), back);
  }
  // two windows side by side on MON125 keep sharing their edge on MON150 (another size and scale)
  const L = { x: 0, y: 44, w: 960, h: 1036 }, Rt = { x: 960, y: 44, w: 960, h: 1036 };
  const l2 = core.absRect(core.relRect(L, MON125), core.workDip(MON125), MON150);
  const r2 = core.absRect(core.relRect(Rt, MON125), core.workDip(MON125), MON150);
  check('rect: halves stay halves on another monitor (proportional, shared edge)', l2.x === MON150.work.x && l2.x + l2.w === r2.x &&
    r2.x + r2.w === MON150.work.x + MON150.work.w && l2.h === MON150.work.h, { l2, r2 });
  // the top bar hidden: the work area grows 44 px; a full-height window still fills it
  const noBar = Object.assign({}, MON125, { work: { x: 0, y: 0, w: 1920, h: 1080 } });
  const full = core.absRect(core.relRect(L, MON125), core.workDip(MON125), noBar);
  check('rect: a full-height window still fills a taller work area', full.y === 0 && full.h === 1080, full);
  const off = core.fitInto({ x: 1800, y: -50, w: 400, h: 300 }, MON125.work);
  check('rect: kept inside the work area', off.x === 1520 && off.y === 44 && off.w === 400, off);
  const huge = core.fitInto({ x: 0, y: 0, w: 5000, h: 5000 }, MON125.work);
  check('rect: never bigger than the work area', huge.w === 1920 && huge.h === 1036, huge);
  const neg = core.absRect({ x: 10, y: 10, w: 400, h: 300 }, core.workDip(MON100), MON100);
  check('rect: a monitor left of the primary (negative x)', neg.x === -1270 && neg.y === 10, neg);

  /* ---- monitors ---- */
  const mons = [MON125, MON150, MON100];
  check('monitor: the same one', core.pickMonitor(core.monKey(MON150), mons).mon === MON150);
  check('monitor: same device, new size', core.pickMonitor(Object.assign(core.monKey(MON150), { w: 3840 }), mons).how === 'device');
  check('monitor: gone -> the primary when it was the primary', core.pickMonitor({ device: 'X', primary: true }, mons).mon === MON125);
  check('monitor: gone, not primary -> one at the same place, else the primary',
    core.pickMonitor({ device: 'X', primary: false, x: -1280, y: 0 }, mons).mon === MON100 &&
    core.pickMonitor({ device: 'X', primary: false, x: 5, y: 5 }, mons).how === 'fallback');
  { /* re-ordered (lane windows-layouts, 2026-09-29): after a replug Windows can hand the two outer
     monitors each other's DISPLAYn names. The saved 1280x1024 at (-1280,0) is still at (-1280,0): its
     exact place + size beats a name that now belongs to another monitor. */
  const SW150 = Object.assign({}, MON150, { device: MON100.device });
  const SW100 = Object.assign({}, MON100, { device: MON150.device });
  const swapped = [MON125, SW150, SW100];
  const p100 = core.pickMonitor(core.monKey(MON100), swapped);
  check('monitor: re-ordered names -> the one at the same place and size', p100.mon === SW100 && p100.how === 'bounds', p100.how);
  check('monitor: re-ordered names, a maximised entry lands on the right one',
    core.targetOf({ state: 'max', mon: core.monKey(MON150), work: core.workDip(MON150), rect: { x: 0, y: 0, w: 800, h: 600 } }, swapped).mon === SW150);
  /* removed / moved / DPI changed: always inside a live work area */
  const inside = (f, m) => f.x >= m.work.x && f.y >= m.work.y && f.x + f.w <= m.work.x + m.work.w && f.y + f.h <= m.work.y + m.work.h;
  const onLeft = { mon: core.monKey(MON100), work: core.workDip(MON100), rect: { x: 900, y: 700, w: 700, h: 500 }, state: 'normal' };
  const t1 = core.targetOf(onLeft, [MON125]);
  check('monitor removed: goes to the primary, inside its work area', t1.mon === MON125 && inside(t1.frame, MON125), t1);
  const MOVED = Object.assign({}, MON100, { bounds: { x: 4480, y: 300, w: 1280, h: 1024 }, work: { x: 4480, y: 300, w: 1280, h: 984 } });
  const t2 = core.targetOf(onLeft, [MON125, MOVED]);
  check('monitor moved: same device follows it, inside its work area', t2.mon === MOVED && inside(t2.frame, MOVED), t2);
  const DPI150 = Object.assign({}, MON125, { dpi: 144 });
  const half = { mon: core.monKey(MON125), work: core.workDip(MON125), rect: { x: 0, y: 0, w: 768, h: 828.8 }, state: 'normal' };
  const t3 = core.targetOf(half, [DPI150]);
  check('DPI 125 -> 150 %: a left half stays a left half of the work area', t3.frame.x === 0 && Math.abs(t3.frame.w - 960) <= 1 && inside(t3.frame, DPI150), t3.frame);
  const tooBig = { mon: core.monKey(MON150), work: core.workDip(MON150), rect: { x: -500, y: -900, w: 9000, h: 9000 }, state: 'normal' };
  const t4 = core.targetOf(tooBig, [MON100]);
  check('a rect bigger than the screen, off its edges, on a negative-x monitor: clamped inside', inside(t4.frame, MON100), t4.frame);
  }

  /* ---- save ---- */
  const W = (o) => Object.assign({ pid: 10, exe: 'C:\\Apps\\code\\Code.exe', aumid: null, desc: 'Visual Studio Code', state: 'normal', monitor: '1',
    frame: { x: 100, y: 100, w: 800, h: 600 }, normal: { x: 100, y: 100, w: 800, h: 600 }, ours: true, title: 'x - mantle - Visual Studio Code' }, o);
  const ans = { monitors: mons, windows: [
    W({ hwnd: '1' }),
    W({ hwnd: '2', state: 'min' }),
    W({ hwnd: '3', state: 'max', frame: { x: 1920, y: -200, w: 2560, h: 1392 }, normal: { x: 2000, y: 0, w: 900, h: 700 }, monitor: '2' }),
    W({ hwnd: '4', elevated: true, exe: 'C:\\Windows\\System32\\Taskmgr.exe', desc: 'Task Manager' }),
    W({ hwnd: '5', frame: { x: -30000, y: -30000, w: 200, h: 100 }, monitor: '1' }),
    W({ hwnd: '6', ours: false }),
  ] };
  const snap = core.snapshot(ans, {});
  check('save: normal + maximised kept; minimised, elevated, off-screen left out', snap.entries.length === 3 &&
    snap.left.minimized === 1 && snap.left.offscreen === 1 && eq(snap.left.elevated, ['Task Manager']), snap.left);
  const mx = snap.entries.find((e) => e.state === 'max');
  check('save: a maximised window keeps its restore rect and monitor', mx && mx.mon.device === MON150.device && eq(mx.rect, { x: 53.33, y: 133.33, w: 600, h: 466.67 }), mx && mx.rect);
  check('save: no title is stored anywhere', !JSON.stringify(snap).includes('mantle - Visual'));
  check('save: app names from the exe', snap.entries[0].app === 'Visual Studio Code');
  check('save: a --test save takes only its fixtures', core.snapshot(ans, { test: true }).entries.length === 2 && core.snapshot(ans, { test: true }).left.test === 1);
  check('save: what was left out is said', core.leftWords(snap.left).some((l) => /Task Manager left out: it runs as administrator/.test(l)) &&
    core.leftWords(snap.left).some((l) => /1 minimised window left out/.test(l)));
  check('save: Quartz is named Quartz', core.appNameOf({ exe: core.BROWSER_EXE, desc: 'Electron' }) === 'Quartz');

  /* ---- matching ---- */
  const E = (o) => Object.assign({ app: 'Code', exe: 'C:\\Apps\\code\\Code.exe', aumid: null, t: [], state: 'normal', mon: core.monKey(MON125),
    work: core.workDip(MON125), rect: { x: 0, y: 0, w: 400, h: 300 } }, o);
  const eM = E({ t: vs('a.js - mantle - Visual Studio Code') }), eA = E({ t: vs('b.js - northwind - Visual Studio Code') });
  const wA = { hwnd: 'A', exe: 'c:\\apps\\CODE\\code.exe', title: 'server.js - northwind - Visual Studio Code', frame: { x: 0, y: 0, w: 10, h: 10 } };
  const wM = { hwnd: 'M', exe: 'C:\\Apps\\code\\Code.exe', title: 'z.js - mantle - Visual Studio Code', frame: { x: 0, y: 0, w: 10, h: 10 } };
  let m = core.match([eM, eA], [wA, wM]);
  check('match: title words pair two windows of one app', m[0].window === wM && m[1].window === wA, m.map((x) => x.window && x.window.hwnd));
  m = core.match([eM, eA], [wA]);
  check('match: each window used once; the better title wins it', m[1].window === wA && m[0].window === null);
  m = core.match([eM], [{ hwnd: 'X', exe: 'C:\\Other\\Code.exe', title: '' }]);
  check('match: same exe name elsewhere (an update moved it) still matches, tier 1', m[0].window && m[0].tier === 1);
  m = core.match([E({ exe: 'C:\\a\\electron.exe' })], [{ hwnd: 'X', exe: 'C:\\b\\electron.exe', title: '' }]);
  check('match: a host exe (electron.exe) at another path is another app', m[0].window === null);
  m = core.match([E({ aumid: 'Chrome' })], [{ hwnd: 'X', exe: 'C:\\Apps\\code\\Code.exe', aumid: 'Chrome.Profile2', title: '' }]);
  check('match: two different AUMIDs never match, whatever the exe', m[0].window === null);
  m = core.match([E({ aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', exe: 'C:\\WindowsApps\\v1\\CalculatorApp.exe' })],
    [{ hwnd: 'X', exe: 'C:\\WindowsApps\\v2\\CalculatorApp.exe', aumid: 'microsoft.windowscalculator_8wekyb3d8bbwe!app', title: '' }]);
  check('match: the same AUMID matches across versions', m[0].window && m[0].tier === 3);
  const t1 = { frame: { x: 0, y: 0, w: 100, h: 100 } }, t2 = { frame: { x: 1000, y: 0, w: 100, h: 100 } };
  const wFar = { hwnd: 'F', exe: 'C:\\Apps\\code\\Code.exe', title: '', frame: { x: 1000, y: 0, w: 100, h: 100 } };
  const wNear = { hwnd: 'N', exe: 'C:\\Apps\\code\\Code.exe', title: '', frame: { x: 0, y: 0, w: 100, h: 100 } };
  m = core.match([E(), E()], [wFar, wNear], [t1, t2]);
  check('match: equal titles -> the window already nearest its spot', m[0].window === wNear && m[1].window === wFar);
  check('match: no windows -> every entry missing', core.match([E(), E()], []).every((x) => x.window === null));

  /* ---- starting what is missing ---- */
  const yes = () => true, no = () => false;
  check('launch: an AUMID app starts through its AUMID', core.launchPlan(E({ aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' }), { exists: yes }).how === 'aumid');
  const q = core.launchPlan(E({ app: 'Quartz', exe: core.BROWSER_EXE }), { exists: yes });
  check('launch: Quartz starts as the launcher starts it (electron.exe + its folder)', q.how === 'exe' && eq(q.args, [core.BROWSER_DIR]));
  {
    // Quartz.exe (since 2026-10-10) and its bare electron.exe are one app (lib/quartz-exe.js)
    const [QX, EX] = core.BROWSER_EXES;
    const MANTLE_EL = path.join(path.dirname(core.BROWSER_DIR), 'mantle-live', 'node_modules', 'electron', 'dist', 'electron.exe');
    check('quartz: both candidates are under the browser folder, Quartz.exe first', /\\Quartz\.exe$/.test(QX) && /\\electron\.exe$/.test(EX) && QX.startsWith(core.BROWSER_DIR));
    check('quartz: the load-time BROWSER_EXE is one of the two', core.BROWSER_EXE === QX || core.BROWSER_EXE === EX);
    check('quartz save: Quartz.exe is named Quartz', core.appNameOf({ exe: QX, desc: 'Quartz' }) === 'Quartz');
    check('quartz save: the bare electron.exe under ~/browser is named Quartz', core.appNameOf({ exe: EX, desc: 'Electron' }) === 'Quartz');
    check('quartz save: Mantle\'s own electron.exe is not Quartz', core.appNameOf({ exe: MANTLE_EL, desc: 'Electron' }) !== 'Quartz');
    const wQ = { hwnd: 'Q', exe: QX, title: 'Video 4 - Quartz' }, wE = { hwnd: 'E', exe: EX, title: 'Video 4 - Quartz' };
    const wMantle = { hwnd: 'M', exe: MANTLE_EL, title: 'Video 4 - Quartz' };
    let mq = core.match([E({ app: 'Quartz', exe: EX })], [wQ]);
    check('quartz match: an entry saved as electron.exe finds Quartz now running as Quartz.exe (tier 2)', mq[0].window === wQ && mq[0].tier === 2, mq[0]);
    mq = core.match([E({ app: 'Quartz', exe: QX })], [wE]);
    check('quartz match: an entry saved as Quartz.exe finds a Quartz still running as electron.exe (tier 2)', mq[0].window === wE && mq[0].tier === 2, mq[0]);
    mq = core.match([E({ app: 'Quartz', exe: EX })], [wMantle]);
    check('quartz match: Mantle\'s own electron.exe (mantle-live) is never taken for Quartz', mq[0].window === null, mq[0]);
    mq = core.match([E({ app: 'Quartz', exe: QX })], [wMantle, { hwnd: 'O', exe: 'C:\\Tool\\electron.exe', title: '' }]);
    check('quartz match: nor is any other electron.exe', mq[0].window === null, mq[0]);
    mq = core.match([E({ app: 'Quartz', exe: QX })], [wMantle, wE]);
    check('quartz match: with Mantle and Quartz both open, the Quartz window is the one picked', mq[0].window === wE, mq[0]);
    const pq = core.launchPlan(E({ app: 'Quartz', exe: EX }), { exists: (p) => p === QX || p === EX });
    check('quartz launch: Quartz.exe present -> starts Quartz.exe, even for an entry saved as electron.exe', pq.how === 'exe' && pq.exe === QX && eq(pq.args, [core.BROWSER_DIR]), pq);
    const pe = core.launchPlan(E({ app: 'Quartz', exe: QX }), { exists: (p) => p === EX });
    check('quartz launch: Quartz.exe absent -> starts electron.exe, even for an entry saved as Quartz.exe', pe.how === 'exe' && pe.exe === EX && eq(pe.args, [core.BROWSER_DIR]), pe);
    const pn = core.launchPlan(E({ app: 'Quartz', exe: QX }), { exists: no });
    check('quartz launch: neither on disk -> "isn\'t installed any more"', pn.how === 'none' && pn.kind === 'missing', pn);
    const pm = core.launchPlan(E({ app: 'Mantle', exe: MANTLE_EL }), { exists: yes });
    check('quartz launch: Mantle\'s own electron.exe stays a host exe (never started as Quartz)', pm.how === 'none' && pm.kind === 'host', pm);
  }
  const h = core.launchPlan(E({ app: 'Tool', exe: 'C:\\x\\electron.exe' }), { exists: yes });
  check('launch: a host exe alone is never started, and says why', h.how === 'none' && /can't start it on its own/.test(h.why));
  const gone = core.launchPlan(E({ app: 'Notion', exe: 'C:\\Nope\\Notion.exe' }), { exists: no });
  check('launch: a program gone from disk is "isn\'t installed"', gone.how === 'none' && /^Notion isn't installed/.test(gone.why));
  check('launch: a plain exe starts with no arguments', eq(core.launchPlan(E(), { exists: yes }), { how: 'exe', exe: E().exe, args: [] }));

  /* ---- a hostile layouts.json (secreview-win, 2026-09-27): what it may start, and what it costs ---- */
  {
    const probed = [];
    const rec = (p) => { probed.push(p); return true; };
    const bad = ['\\\\198.51.100.7\\share\\evil.exe', '//198.51.100.7/share/evil.exe', '\\\\?\\UNC\\198.51.100.7\\s\\e.exe', '\\\\.\\C:\\x.exe',
      'C:\\Users\\Public\\payload.txt', 'C:\\Windows\\..\\Users\\Public\\x.exe', 'calc.exe', 'C:x.exe', 'C:\\a\\b.exe:ads.exe', 'C:\\a\\' + 'b'.repeat(600) + '.exe'];
    const plans = bad.map((exe) => core.launchPlan(E({ exe }), { exists: rec }));
    check('hostile: a UNC / device / relative / non-.exe / ".." / ADS / over-long exe is never started, and says why',
      plans.every((p) => p.how === 'none' && p.kind === 'unsafe' && /Mantle will not start it/.test(p.why)), plans.map((p) => p.how + ':' + p.kind));
    check('hostile: ... and never even probed (fs.existsSync on a UNC path signs in to that host)', probed.length === 0, probed);
    const ok = core.launchPlan(E({ exe: 'D:\\Games\\Tool.exe' }), { exists: rec });
    check('hostile: a local absolute .exe still starts', ok.how === 'exe' && ok.exe === 'D:\\Games\\Tool.exe' && probed.length === 1, ok);
    const au = ['\\\\198.51.100.7\\share\\evil.exe', '..\\..\\Windows\\System32\\calc.exe', 'C:\\x.exe', 'a/b', 'x'.repeat(129), 'a\u0000b'];
    const ap = au.map((aumid) => core.launchPlan(E({ aumid, exe: '\\\\198.51.100.7\\s\\f.exe' }), { exists: rec }));
    check('hostile: a path-shaped AUMID is never handed to shell:AppsFolder, and its UNC exe is not probed',
      ap.every((p) => p.how === 'none') && probed.length === 1, ap.map((p) => p.how));
    const au2 = core.launchPlan(E({ aumid: '..\\evil', exe: 'C:\\Apps\\code\\Code.exe' }), { exists: yes });
    check('hostile: a bad AUMID falls back to the (checked) exe', au2.how === 'exe' && au2.exe === 'C:\\Apps\\code\\Code.exe', au2);

    // a 10 MB file: 900,000 title words in one entry held match() 6 s on the main process before
    const t = [];
    for (let i = 0; i < 900000; i++) t.push(((i * 2654435761) >>> 0).toString(16).padStart(8, '0'));
    const raw = JSON.stringify([{ name: 'Big', entries: [E({ t, app: 'A'.repeat(1 << 20) })] }]);
    const parsed = JSON.parse(raw);
    let t0 = process.hrtime.bigint();
    const big = core.sanitize(parsed);
    const sanMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const wins = [];
    for (let i = 0; i < 20; i++) wins.push({ hwnd: String(i + 1), exe: 'C:\\Apps\\code\\Code.exe', title: 'some title ' + i, frame: { x: 0, y: 0, w: 10, h: 10 } });
    t0 = process.hrtime.bigint();
    core.match(big[0].entries, wins, null);
    const matchMs = Number(process.hrtime.bigint() - t0) / 1e6;
    check('hostile: 900,000 title words are cut to 16, a 1 MB app name to 64 characters', big[0].entries[0].t.length === 16 && big[0].entries[0].app.length === 64,
      { t: big[0].entries[0].t.length, app: big[0].entries[0].app.length });
    check('hostile: sanitize + match of a 10 MB entry stay under 50 ms', sanMs < 50 && matchMs < 50, { sanMs: Math.round(sanMs), matchMs: Math.round(matchMs) });

    // wrong types never reach the maths or the sidecar
    const why = {};
    const typed = core.sanitize([
      { name: 'T', entries: [E({ t: { length: 2 } }), E({ rect: { x: 'x', y: 0, w: 5, h: 5 } }), E({ rect: { x: 0, y: 0, w: 5, h: '7' } }),
        E({ exe: 42, aumid: null }), E({ mon: 'nope', work: { w: 'a' }, state: 'maximised', app: { toString: null } }), null, 7] },
      { name: 'T', entries: [] }, { name: 42, entries: [] }, 'x',
    ], why);
    const te = typed[0].entries;
    check('hostile: bad field types are rebuilt or dropped, and counted', typed.length === 1 && te.length === 2 && Array.isArray(te[0].t) && te[0].t.length === 0 &&
      te[1].mon === null && te[1].work === null && te[1].state === 'normal' && te[1].app === 'An app' && why.entries === 5 && why.layouts === 3, { te, why });
    const tg = core.targetOf(te[1], [MON125]);
    check('hostile: ... and still place on a real monitor', tg && Number.isFinite(tg.frame.x) && Number.isFinite(tg.frame.w), tg);
    const many = [];
    for (let i = 0; i < 1000; i++) many.push({ name: 'L' + i, entries: Array.from({ length: 200 }, () => E()) });
    t0 = process.hrtime.bigint();
    const kept = core.sanitize(many, why);
    const manyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    check('hostile: 1000 layouts x 200 windows -> 24 x 40 kept, in under 50 ms', kept.length === core.MAX_LAYOUTS && kept.every((l) => l.entries.length === core.MAX_ENTRIES) &&
      why.layouts === 976 && manyMs < 50, { n: kept.length, why, manyMs: Math.round(manyMs) });
    const e40 = Array.from({ length: 40 }, (_, i) => E({ t: core.titleTokens('doc ' + i + ' word'.repeat(40)) }));
    const w200 = Array.from({ length: 200 }, (_, i) => ({ hwnd: String(i), exe: 'C:\\Apps\\code\\Code.exe', title: ('title ' + i + ' ').repeat(40).slice(0, 256), frame: { x: 0, y: 0, w: 10, h: 10 } }));
    t0 = process.hrtime.bigint();
    core.match(e40, w200, null);
    const m40 = Number(process.hrtime.bigint() - t0) / 1e6;
    check('hostile: match of 40 entries x 200 titled windows of one app under 50 ms (was 265)', m40 < 50, Math.round(m40));
  }

  /* ---- the summary ---- */
  let sum = core.summarize('Work', [{ app: 'A', kind: 'placed' }, { app: 'B', kind: 'already' }, { app: 'C', kind: 'placed' },
    { app: 'D', kind: 'opened' }, { app: 'Notion', kind: 'notfound', why: "Notion isn't installed" }]);
  check('summary: the one line the user reads: counts only, the reason on its own line', sum.text === 'Work: 3 placed, 1 opened, 1 not found' && sum.lines.length === 1 && sum.lines[0] === "Notion isn't installed", sum);
  sum = core.summarize('Code', [{ app: 'A', kind: 'already' }, { app: 'B', kind: 'already' }]);
  check('summary: nothing to do says so', sum.text === 'Code: all 2 windows are already in place', sum.text);
  sum = core.summarize('Code', [{ app: 'A', kind: 'refused', why: 'X runs as administrator' }, { app: 'B', kind: 'refused', why: 'Y is not responding' }, { app: 'C', kind: 'placed', note: 'it kept a bigger size' }]);
  check('summary: several reasons go on their own lines, notes too; "couldn\u2019t move", not "refused"', sum.text === 'Code: 1 placed, 2 couldn\u2019t be moved' && sum.lines.length === 3, sum);
  sum = core.summarize('Code', [{ app: 'A', kind: 'wouldPlace', note: 'would put its frame at 0,0 10x10' }, { app: 'B', kind: 'wouldOpen' }], { dryRun: true });
  check('summary: a dry run says so', /^Code \(dry run\): would place 1, would open 1$/.test(sum.text) && sum.lines.length === 1, sum);

  /* ---- the engine on a fake sidecar ---- */
  function fakeSidecar(windows, opts) {
    const o = opts || {};
    const calls = [];
    let clock = 0;
    const later = o.later || [];   // windows that appear at a time: [{ at, w }]
    return {
      calls,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      send: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'layouts.windows') return { ok: true, result: { monitors: [MON125], windows: windows.concat(later.filter((x) => clock >= x.at).map((x) => x.w)) } };
        if (cmd === 'layouts.place') {
          if (o.refuse && o.refuse[args.hwnd]) return { ok: false, error: o.refuse[args.hwnd] };
          if (args.dryRun) return { ok: true, result: { dryRun: true, would: 'put its frame at somewhere' } };
          return { ok: true, result: { placed: true, already: false, state: args.state, exact: true } };
        }
        if (cmd === 'launch') return o.launchFails ? { ok: true, result: { ok: false, reason: 'no app with that id' } } : { ok: true, result: { ok: true } };
        return { ok: false, error: 'unknown command ' + cmd };
      },
    };
  }
  const layout = { name: 'Work', entries: [
    E({ app: 'Quartz', exe: core.BROWSER_EXE, t: vs('Video 4 - Quartz') }),
    E({ app: 'Notes', exe: 'C:\\Apps\\notes\\Notes.exe', t: vs('Biology - Notes') }),
    E({ app: 'Terminal', exe: 'C:\\WT\\WindowsTerminal.exe', aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' }),
    E({ app: 'Notion', exe: 'C:\\Nope\\Notion.exe' }),
    E({ app: 'Admin tool', exe: 'C:\\Apps\\admin\\Tool.exe' }),
  ] };
  const open = [
    { hwnd: '11', pid: 1, exe: core.BROWSER_EXE, title: 'Video 5 - Quartz', ours: true, frame: { x: 0, y: 44, w: 10, h: 10 } },
    { hwnd: '12', pid: 2, exe: 'C:\\Apps\\notes\\Notes.exe', title: 'Biology - Notes', ours: true, frame: { x: 0, y: 44, w: 10, h: 10 } },
    { hwnd: '13', pid: 3, exe: 'C:\\Apps\\admin\\Tool.exe', title: '', ours: true, frame: { x: 0, y: 44, w: 10, h: 10 } },
    { hwnd: '99', pid: 9, exe: 'C:\\Other\\Unrelated.exe', title: 'not in the layout', ours: true, frame: { x: 0, y: 44, w: 10, h: 10 } },
  ];
  const termWin = { hwnd: '21', pid: 4, exe: 'C:\\WT\\WindowsTerminal.exe', aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', title: 'PowerShell', ours: true, frame: { x: 0, y: 44, w: 10, h: 10 } };
  let fs1 = fakeSidecar(open, { refuse: { 13: 'Admin tool runs as administrator, and Windows does not let Mantle (which does not) move its windows (UIPI)' },
    later: [{ at: 1200, w: termWin }] });
  const spawned = [];
  let res = await engine.restore(layout, { send: fs1.send, now: fs1.now, sleep: fs1.sleep, test: false, pollMs: 400, settleMs: 700, waitMs: 10000,
    exists: (p) => !/Nope/.test(p), spawn: async (exe, args) => { spawned.push({ exe, args }); return { ok: true }; } });
  const placedHwnds = fs1.calls.filter((c) => c.cmd === 'layouts.place').map((c) => c.args.hwnd);
  check('engine: only the layout\'s windows are placed (never 99)', !placedHwnds.includes('99') && placedHwnds.includes('11') && placedHwnds.includes('12'), placedHwnds);
  check('engine: the missing AUMID app is started once, and its window placed after it settles', res.counts.opened === 1 && placedHwnds.includes('21') &&
    fs1.calls.filter((c) => c.cmd === 'launch').length === 1, res.text);
  check('engine: nothing is spawned for the uninstalled app', spawned.length === 0, spawned);
  check('engine: the whole line', res.text === 'Work: 2 placed, 1 opened, 1 not found, 1 couldn\u2019t be moved', res.text);
  check('engine: each reason on its own line, in plain words', res.lines.some((l) => l === "Notion isn't installed any more") &&
    res.lines.some((l) => /^Admin tool runs as administrator/.test(l)) && !res.lines.some((l) => /UIPI|\(which does not\)/.test(l)), res.lines);
  check('engine: ... and the counts still say which', res.counts.refused === 1 && res.counts.notfound === 1);
  /* UNDO A RESTORE (lane windows-layouts, 2026-09-29): a restore moves many windows at once, so it can
     be taken back. The engine keeps where each window it really MOVED stood before (not one already in
     place, not one it opened, not one that was refused); undo() puts exactly those back. */
  check('undo: the restore remembers the windows it moved, with where they were', Array.isArray(res.undo) &&
    eq(res.undo.map((u) => u.hwnd).sort(), ['11', '12']) && res.undo.every((u) => u.state === 'normal' && eq(u.frame, { x: 0, y: 44, w: 10, h: 10 }) && u.pid), res.undo);
  {
    const fu = fakeSidecar(open, {});
    const u = await engine.undo('Work', res.undo, { send: fu.send });
    const back = fu.calls.filter((c) => c.cmd === 'layouts.place');
    check('undo: puts exactly those windows back, where they were', u.ok && eq(back.map((c) => c.args.hwnd).sort(), ['11', '12']) &&
      back.every((c) => eq(c.args.frame, { x: 0, y: 44, w: 10, h: 10 }) && c.args.state === 'normal' && c.args.pid && !c.args.dryRun), back);
    check('undo: one plain line', u.text === 'Work: 2 windows back where they were' && u.lines.length === 0, u);
    const fr = fakeSidecar(open, { refuse: { 12: 'that window has closed' } });
    const u2 = await engine.undo('Work', res.undo, { send: fr.send });
    check('undo: a window that closed since is said, the others still go back', u2.ok && u2.text === 'Work: 1 window back where it was' &&
      u2.lines.length === 1 && /Notes: that window has closed/.test(u2.lines[0]), u2);
    const u3 = await engine.undo('Work', [], { send: fr.send });
    check('undo: nothing to put back says so', !u3.ok && /nothing to undo/.test(u3.reason), u3);
    // maximised and minimised windows go back maximised / minimised, with their restore rect
    const mm = [
      { hwnd: '41', pid: 41, exe: 'C:\\Apps\\notes\\Notes.exe', title: 'Biology - Notes', ours: true, state: 'max', frame: { x: 0, y: 44, w: 1920, h: 1036 }, normal: { x: 100, y: 144, w: 700, h: 500 } },
      { hwnd: '42', pid: 42, exe: core.BROWSER_EXE, title: 'Video 4 - Quartz', ours: true, state: 'min', frame: { x: -32000, y: -32000, w: 160, h: 28 }, normal: { x: 300, y: 244, w: 800, h: 600 } },
    ];
    const fm = fakeSidecar(mm, {});
    const rm = await engine.restore({ name: 'Work', entries: layout.entries.slice(0, 2) }, { send: fm.send, now: fm.now, sleep: fm.sleep, exists: () => true, spawn: async () => ({ ok: true }) });
    const um = rm.undo || [];
    check('undo: a maximised window is remembered maximised, with its restore rect', um.some((x) => x.hwnd === '41' && x.state === 'max' && eq(x.frame, mm[0].normal)), um);
    check('undo: a minimised window is remembered minimised, with its restore rect', um.some((x) => x.hwnd === '42' && x.state === 'min' && eq(x.frame, mm[1].normal)), um);
    const fm2 = fakeSidecar(mm, {});
    await engine.undo('Work', um, { send: fm2.send });
    const sentM = fm2.calls.filter((c) => c.cmd === 'layouts.place').map((c) => c.args.hwnd + ':' + c.args.state);
    check('undo: ... and they go back that way', sentM.includes('41:max') && sentM.includes('42:min'), sentM);
    const fd = fakeSidecar(open, {});
    const rd = await engine.restore(layout, { send: fd.send, now: fd.now, sleep: fd.sleep, dryRun: true, exists: () => true, spawn: async () => ({ ok: true }) });
    check('undo: a dry run has nothing to undo', !rd.undo || rd.undo.length === 0, rd.undo);
  }
  // a start that never shows a window
  fs1 = fakeSidecar([], {});
  const startLogs = [];
  res = await engine.restore({ name: 'Q', entries: [layout.entries[0]] }, { send: fs1.send, now: fs1.now, sleep: fs1.sleep, exists: () => true,
    spawn: async () => ({ ok: true }), waitMs: 10000, pollMs: 400, log: (t) => startLogs.push(t) });
  check('engine: a window that never shows is "not found" with the reason', res.counts.notfound === 1 && res.lines.some((l) => /no window of it showed within 10 s/.test(l)), res.lines);
  // lane r7-names (2026-10-01): the start is logged without the app's name or exe (BRIEF privacy rule)
  check('engine: the start is logged, but never by the app\'s name', startLogs.some((l) => /^started a program for layout \(1 window to place\)$/.test(l))
    && !startLogs.some((l) => /quartz|\.exe/i.test(l)), startLogs);
  // a start that fails
  res = await engine.restore({ name: 'Q', entries: [layout.entries[1]] }, { send: fakeSidecar([], {}).send, exists: () => true,
    spawn: async () => ({ ok: false, reason: 'the program is not there' }) });
  check('engine: a start that fails says so', res.lines.some((l) => /Notes isn't open, and it would not start \(the program is not there\)/.test(l)), res.lines);
  // --test: the user's windows are a dry run, nothing starts
  fs1 = fakeSidecar(open.map((w) => Object.assign({}, w, { ours: false })), {});
  const spawned2 = [];
  res = await engine.restore(layout, { send: fs1.send, now: fs1.now, sleep: fs1.sleep, test: true, exists: () => true, spawn: async (e) => { spawned2.push(e); return { ok: true }; } });
  const places = fs1.calls.filter((c) => c.cmd === 'layouts.place');
  check('engine --test: every place is a dryRun, nothing is started', places.length > 0 && places.every((c) => c.args.dryRun === true) &&
    spawned2.length === 0 && !fs1.calls.some((c) => c.cmd === 'launch'), places.map((c) => c.args.dryRun));
  check('engine --test: the line says dry run', /\(dry run\): would place 3, would open 2/.test(res.text), res.text);   // Notion "exists" here
  // the sidecar is down
  res = await engine.restore(layout, { send: async () => ({ ok: false, error: 'sidecar not running' }) });
  check('engine: no window list -> not ok, with the reason', !res.ok && /could not read the open windows \(.*try again in a moment\)/.test(res.reason) && !/sidecar/.test(res.reason), res.reason);

  /* ---- the feature on a fake ctx ---- */
  const settings = {};
  const commands = {};
  const logs = [];
  let enabled = true, failPlace = false;
  const onEn = [];
  const bc = [];
  const winList = { monitors: [MON125], windows: [
    { hwnd: '11', pid: 1, exe: core.BROWSER_EXE, desc: 'Electron', title: null, ours: false, state: 'normal', monitor: '1', frame: { x: 0, y: 44, w: 960, h: 1036 } },
    { hwnd: '31', pid: 5, exe: 'C:\\fx\\mantle-layouts-fixture.exe', desc: 'fixture', title: 'Mantle layouts fixture Alpha', ours: true, state: 'normal', monitor: '1', frame: { x: 960, y: 44, w: 960, h: 1036 } },
  ] };
  const sent = [];
  const ctx = {
    name: 'layouts', flags: Object.freeze({ test: true, live: false }),
    log: (t) => logs.push(t), health: () => {}, enabled: () => enabled, onEnabled: (fn) => onEn.push(fn),
    command: (verb, fn) => { commands[verb] = fn; return 'layouts.' + verb; },
    replay: () => {}, broadcast: (ev, p) => bc.push({ ev, p }), push: () => false,
    page: (f) => path.join(__dirname, '..', '..', 'ui', 'layouts', f || 'index.html'), preload: 'x',
    settings: { get: (k, d) => (k in settings ? JSON.parse(JSON.stringify(settings[k])) : d), set: (k, v) => { settings[k] = JSON.parse(JSON.stringify(v)); } },
    host: { display: () => ({ workArea: { x: 0, y: 0, width: 1536, height: 830 } }), barRect: () => null },
    sidecar: {
      ready: true,
      send: async (cmd, args) => {
        sent.push({ cmd, args });
        if (cmd === 'layouts.windows') return { ok: true, result: winList };
        if (cmd === 'layouts.place' && failPlace) return { ok: false, error: 'that window has closed' };
        if (cmd === 'layouts.place') return { ok: true, result: args.dryRun ? { dryRun: true, would: 'put its frame at x' } : { placed: true, already: false, exact: true } };
        return { ok: false, error: 'unknown command' };
      },
      onReady: () => () => {},
    },
  };
  const feature = require('./layouts');
  const handle = feature.install(ctx);
  check('feature: rest:true, no chords, the file name', feature.rest === true && feature.chords.length === 0 && feature.name === 'layouts');
  let r = await commands.save({ name: '  Work ' });
  check('feature: save (in --test only the fixture is saved, the rest is counted)', r.ok && r.count === 1 && r.lines.some((l) => /test run: fixtures only/.test(l)) &&
    settings.layouts && settings.layouts[0].name === 'Work', r);
  check('feature: nothing of a title reaches the settings file', !JSON.stringify(settings).includes('fixture Alpha'));
  r = await commands.save({ name: 'work' });
  check('feature: a second save of the same name needs replace', !r.ok && /already a layout with that name/.test(r.reason) && !/Work/.test(r.reason), r.reason);
  r = await commands.save({ name: 'WORK', replace: true });
  check('feature: replace keeps the name as it was', r.ok && r.replaced && settings.layouts.length === 1 && settings.layouts[0].name === 'Work', r);
  check('feature: the launcher gets a row for it', bridge.rows().some((x) => x.name === 'Layout: Work' && x.kind === 'setting' && x.path === 'mantle:layout:Work'));
  const idx = require('../launcher-index.js');
  const hits = idx.search('work', []);
  check('launcher: typing "work" shows Layout: Work', hits.length && hits[0].name === 'Layout: Work', hits.map((x) => x.name));
  r = await idx.launch(hits[0], { dryRun: true });
  check('launcher: choosing it puts the layout back (dry run quotes what it would do)', r.ok && /^dry run: Work/.test(r.reason || ''), r);
  r = await commands.restore({ name: 'work', wait: true });
  check('feature: restore finds it by name, any case', r.ok && r.name === 'Work' && r.counts.placed + r.counts.wouldPlace === 1, r.text);
  const realPlace = sent.filter((c) => c.cmd === 'layouts.place' && !c.args.dryRun).map((c) => c.args.hwnd);
  check('feature --test: only the fixture is really placed', eq(realPlace, ['31']), realPlace);
  {
    const st1 = await commands.state();
    check('feature: after a restore, Undo is offered for it', st1.canUndo && st1.canUndo.name === 'Work' && st1.canUndo.count === 1, st1.canUndo);
    const before = sent.length;
    const u = await commands.undo({});
    const back = sent.slice(before).filter((c) => c.cmd === 'layouts.place');
    check('feature: undo puts the moved window back where it was', u.ok && back.length === 1 && back[0].args.hwnd === '31' && eq(back[0].args.frame, { x: 960, y: 44, w: 960, h: 1036 }), { u, back });
    check('feature: ... says so', /^Work: 1 window back where it was$/.test(u.text || ''), u.text);
    const st2 = await commands.state();
    check('feature: undo is used up (no second undo)', !st2.canUndo, st2.canUndo);
    const u2 = await commands.undo({});
    check('feature: a second undo says there is nothing to undo', !u2.ok && /nothing to undo/.test(u2.reason), u2);
    const pu = await commands.pointer({ over: true });
    check('feature: the pop-up can be made clickable (for Undo) and back', pu && pu.ok === true);
  }
  /* privacy (lane r7-names, 2026-10-01; BRIEF: no app names in ANY log line): the pop-up names the
     apps, the log says "an app". Save with an administrator app left out, restore with the app gone,
     undo that fails: every one of those lines names an app on screen and must not in the log. */
  {
    const fxApp = settings.layouts[0].entries[0].app;
    const from = logs.length;
    const admin = { hwnd: '41', pid: 9, exe: 'C:\\Zq\\ZqAdmin.exe', desc: 'Zq Admin', title: 'Zq Admin secret', ours: true, elevated: true, state: 'normal', monitor: '1', frame: { x: 0, y: 44, w: 400, h: 400 } };
    winList.windows.push(admin);
    const sv = await commands.save({ name: 'Privacy' });
    winList.windows.pop();
    check('privacy: (the save pop-up still names the app left out)', sv.ok && sv.lines.some((l) => /^Zq Admin left out: it runs as administrator/.test(l)), sv.lines);
    await commands.delete({ name: 'Privacy' });
    const fx = winList.windows.splice(1, 1)[0];
    const gone = await commands.restore({ name: 'Work', wait: true });
    winList.windows.splice(1, 0, fx);
    check('privacy: (the restore pop-up still names the app that is gone)', gone.ok && gone.lines.some((l) => l.startsWith(`${fxApp} isn't`)), gone.lines);
    await commands.restore({ name: 'Work', wait: true });
    failPlace = true;
    const un = await commands.undo({});
    failPlace = false;
    check('privacy: (the undo pop-up still names the app it could not put back)', un.ok && un.lines.some((l) => l.startsWith(`${fxApp}: `)), un);
    const mine = logs.slice(from);
    const fxWord = new RegExp(`\\b${fxApp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);   // "fixture", not "fixtures only"
    const named = mine.filter((l) => /zq/i.test(l) || fxWord.test(l));
    check('privacy: no layout log line names an app', mine.length >= 3 && named.length === 0, named.length ? named : mine);
    check('privacy: the log keeps the reasons, without the name', mine.some((l) => /an app left out: it runs as administrator/.test(l))
      && mine.some((l) => /put a layout back.*; an app isn't/.test(l)) && mine.some((l) => /undid a layout restore: 0 of 1 window\(s\) back; an app: /.test(l)), mine);
  }
  r = await commands.rename({ from: 'Work', to: 'Writing' });
  check('feature: rename', r.ok && settings.layouts[0].name === 'Writing' && bridge.rows()[0].name === 'Layout: Writing', r);
  await commands.save({ name: 'Code' });
  r = await commands.rename({ from: 'Code', to: 'writing' });
  check('feature: rename onto another layout\'s name is refused', !r.ok && /already a layout with that name/.test(r.reason) && !/Writing/.test(r.reason), r.reason);
  r = await commands.delete({ name: 'Code' });
  check('feature: delete', r.ok && settings.layouts.length === 1, r);
  r = await commands.restore({ name: 'nope', wait: true });
  check('feature: an unknown layout says so', !r.ok && /no layout with that name/.test(r.reason) && !/nope/.test(r.reason), r.reason);
  const st = bc.filter((b) => b.ev === 'layouts.state').pop();
  check('feature: the top bar gets the list (names, counts, apps)', st && st.p.layouts.length === 1 && st.p.layouts[0].name === 'Writing' && st.p.layouts[0].count === 1, st && st.p);
  const TM = require('../../ui/topbar/model.js');
  const menus = TM.layoutMenus(TM.MANTLE_MENU.map((x) => Object.assign({}, x)), st.p);
  check('top bar: Layouts > Writing (restore) + Rename + Delete; Save layout > New / Replace', menus.restore[0].act === 'layoutRestore' &&
    menus.restore.some((x) => x.label === 'Rename') && menus.restore.some((x) => x.label === 'Delete') &&
    menus.save[0].act === 'layoutNew' && menus.save.some((x) => x.act === 'layoutSave' && x.confirm), menus);
  check('top bar: the Mantle menu has Layouts and Save layout…', TM.MANTLE_MENU.some((x) => x.act === 'layouts' && x.items) && TM.MANTLE_MENU.some((x) => x.act === 'layoutsSave' && x.items));
  enabled = false;
  onEn.forEach((fn) => fn(false));
  r = await commands.restore({ name: 'Writing', wait: true });
  check('feature: switched off -> refused in words, no launcher rows', !r.ok && /switched off/.test(r.reason) && bridge.rows().length === 0, r);
  enabled = true;
  onEn.forEach((fn) => fn(true));
  handle.stop('VALORANT runs', { rest: true });
  r = await bridge.run('mantle:layout:Writing', {});
  check('feature: resting -> the launcher row is gone and says why', bridge.rows().length === 0 && !r.ok && /resting while VALORANT runs/.test(r.reason), r);
  check('feature: the log has no title and no path', !logs.some((l) => /fixture Alpha|\\\\|[A-Z]:\\/.test(l)), logs);

  /* ---- an unreadable layouts.json is said and kept, never silently emptied (secreview-win) ---- */
  {
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-layouts-sec-'));
    const install2 = (file, stored) => {
      const hl = [], lg = [];
      const c2 = Object.assign({}, ctx, {
        log: (t) => lg.push(t), health: (ok, why) => hl.push({ ok, why }),
        settings: { file, get: (k, d) => (stored && k in stored ? JSON.parse(JSON.stringify(stored[k])) : d), set: (k, v) => { stored[k] = v; } },
      });
      const h = feature.install(c2);
      return { h, hl, lg, stored };
    };
    try {
      const f1 = path.join(dir, 'layouts.json');
      fs.writeFileSync(f1, '{"layouts":[{"name":"SecretProject","entries":[');   // cut short: features.js reads it as {}
      let x = install2(f1, {});
      const last = x.hl[x.hl.length - 1];
      check('stored: an unparseable file -> NOT healthy, in words, with the copy named', last && last.ok === false && /not valid JSON/.test(last.why) &&
        /layouts\.json\.unreadable/.test(last.why) && fs.existsSync(f1 + '.unreadable'), x.hl);
      check('stored: ... and neither the health reason nor the log quotes the file (layout names)', !x.hl.concat(x.lg).some((l) => /SecretProject/.test(JSON.stringify(l))), x.lg);
      x.h.stop('test over');
      const f2 = path.join(dir, 'b.json');
      fs.writeFileSync(f2, '{}');
      x = install2(f2, { layouts: [{ name: 'Good', entries: [E()] }, { name: 'Bad', entries: 'x' }, { name: 'Good2', entries: [E(), E({ exe: '\\\\h\\s\\e.exe', rect: 'no' })] }] });
      const l2 = x.hl[x.hl.length - 1];
      check('stored: dropped layouts / windows are counted in the health reason, and the file copied aside first',
        l2.ok === false && /1 saved layout and 1 saved window in it could not be read/.test(l2.why) && fs.existsSync(f2 + '.unreadable'), x.hl);
      const st2 = await commands.state();   // ctx.command re-registered: this is the second install's
      check('stored: the usable layouts stay, and state carries the problem', st2.layouts.length === 2 && st2.layouts[1].count === 1 && /could not be read/.test(st2.problem), st2);
      x.h.stop('test over');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
    }
  }

  console.log(`LAYOUTS UNIT TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.log('LAYOUTS UNIT TEST: crashed: ' + (err && err.stack)); process.exit(1); });

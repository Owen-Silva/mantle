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
  check('name: trimmed and collapsed', core.cleanName('  Work   work ').name === 'Work work');
  check('name: empty refused in words', !core.cleanName('   ').ok && /needs a name/.test(core.cleanName('').reason));
  check('name: too long refused', !core.cleanName('x'.repeat(41)).ok);
  check('name: control characters removed', core.cleanName('a\u0007b').name === 'a b');
  check('find: case-insensitive', core.findLayout([{ name: 'Work' }], 'school').name === 'Work');

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
  check('summary: the one line Owen reads', sum.text === "Work: 3 placed, 1 opened, 1 not found (Notion isn't installed)" && sum.lines.length === 0, sum);
  sum = core.summarize('Code', [{ app: 'A', kind: 'already' }, { app: 'B', kind: 'already' }]);
  check('summary: nothing to do says so', sum.text === 'Code: all 2 windows are already in place', sum.text);
  sum = core.summarize('Code', [{ app: 'A', kind: 'refused', why: 'X runs as administrator' }, { app: 'B', kind: 'refused', why: 'Y is not responding' }, { app: 'C', kind: 'placed', note: 'it kept a bigger size' }]);
  check('summary: several reasons go on their own lines, notes too', sum.text === 'Code: 1 placed, 2 refused' && sum.lines.length === 3, sum);
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
    E({ app: 'Quartz', exe: core.BROWSER_EXE, t: vs('Lesson 4 - Quartz') }),
    E({ app: 'Notes', exe: 'C:\\Apps\\notes\\Notes.exe', t: vs('Biology - Notes') }),
    E({ app: 'Terminal', exe: 'C:\\WT\\WindowsTerminal.exe', aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' }),
    E({ app: 'Notion', exe: 'C:\\Nope\\Notion.exe' }),
    E({ app: 'Admin tool', exe: 'C:\\Apps\\admin\\Tool.exe' }),
  ] };
  const open = [
    { hwnd: '11', pid: 1, exe: core.BROWSER_EXE, title: 'Lesson 5 - Quartz', ours: true, frame: { x: 0, y: 44, w: 10, h: 10 } },
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
  check('engine: the whole line', res.text === 'Work: 2 placed, 1 opened, 1 not found (Notion isn\'t installed (its program is gone from disk)), 1 refused (Admin tool runs as administrator, and Windows does not let Mantle (which does not) move its windows (UIPI))', res.text);
  // a start that never shows a window
  fs1 = fakeSidecar([], {});
  res = await engine.restore({ name: 'Q', entries: [layout.entries[0]] }, { send: fs1.send, now: fs1.now, sleep: fs1.sleep, exists: () => true,
    spawn: async () => ({ ok: true }), waitMs: 10000, pollMs: 400 });
  check('engine: a window that never shows is "not found" with the reason', res.counts.notfound === 1 && /no window of it showed within 10 s/.test(res.text), res.text);
  // a start that fails
  res = await engine.restore({ name: 'Q', entries: [layout.entries[1]] }, { send: fakeSidecar([], {}).send, exists: () => true,
    spawn: async () => ({ ok: false, reason: 'the program is not there' }) });
  check('engine: a start that fails says so', /Notes isn't open, and it would not start \(the program is not there\)/.test(res.text), res.text);
  // --test: Owen's windows are a dry run, nothing starts
  fs1 = fakeSidecar(open.map((w) => Object.assign({}, w, { ours: false })), {});
  const spawned2 = [];
  res = await engine.restore(layout, { send: fs1.send, now: fs1.now, sleep: fs1.sleep, test: true, exists: () => true, spawn: async (e) => { spawned2.push(e); return { ok: true }; } });
  const places = fs1.calls.filter((c) => c.cmd === 'layouts.place');
  check('engine --test: every place is a dryRun, nothing is started', places.length > 0 && places.every((c) => c.args.dryRun === true) &&
    spawned2.length === 0 && !fs1.calls.some((c) => c.cmd === 'launch'), places.map((c) => c.args.dryRun));
  check('engine --test: the line says dry run', /\(dry run\): would place 3, would open 2/.test(res.text), res.text);   // Notion "exists" here
  // the sidecar is down
  res = await engine.restore(layout, { send: async () => ({ ok: false, error: 'sidecar not running' }) });
  check('engine: no window list -> not ok, with the reason', !res.ok && /could not read the open windows \(sidecar not running\)/.test(res.reason), res.reason);

  /* ---- the feature on a fake ctx ---- */
  const settings = {};
  const commands = {};
  const logs = [];
  let enabled = true;
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
  r = await commands.save({ name: 'SCHOOL', replace: true });
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
  r = await commands.rename({ from: 'Work', to: 'Lessons' });
  check('feature: rename', r.ok && settings.layouts[0].name === 'Lessons' && bridge.rows()[0].name === 'Layout: Lessons', r);
  await commands.save({ name: 'Code' });
  r = await commands.rename({ from: 'Code', to: 'lessons' });
  check('feature: rename onto another layout\'s name is refused', !r.ok && /already a layout with that name/.test(r.reason) && !/Lessons/.test(r.reason), r.reason);
  r = await commands.delete({ name: 'Code' });
  check('feature: delete', r.ok && settings.layouts.length === 1, r);
  r = await commands.restore({ name: 'nope', wait: true });
  check('feature: an unknown layout says so', !r.ok && /no layout with that name/.test(r.reason) && !/nope/.test(r.reason), r.reason);
  const st = bc.filter((b) => b.ev === 'layouts.state').pop();
  check('feature: the top bar gets the list (names, counts, apps)', st && st.p.layouts.length === 1 && st.p.layouts[0].name === 'Lessons' && st.p.layouts[0].count === 1, st && st.p);
  const TM = require('../../ui/topbar/model.js');
  const menus = TM.layoutMenus(TM.MANTLE_MENU.map((x) => Object.assign({}, x)), st.p);
  check('top bar: Layouts > Lessons (restore) + Rename + Delete; Save layout > New / Replace', menus.restore[0].act === 'layoutRestore' &&
    menus.restore.some((x) => x.label === 'Rename') && menus.restore.some((x) => x.label === 'Delete') &&
    menus.save[0].act === 'layoutNew' && menus.save.some((x) => x.act === 'layoutSave' && x.confirm), menus);
  check('top bar: the Mantle menu has Layouts and Save layout…', TM.MANTLE_MENU.some((x) => x.act === 'layouts' && x.items) && TM.MANTLE_MENU.some((x) => x.act === 'layoutsSave' && x.items));
  enabled = false;
  onEn.forEach((fn) => fn(false));
  r = await commands.restore({ name: 'Lessons', wait: true });
  check('feature: switched off -> refused in words, no launcher rows', !r.ok && /switched off/.test(r.reason) && bridge.rows().length === 0, r);
  enabled = true;
  onEn.forEach((fn) => fn(true));
  handle.stop('VALORANT runs', { rest: true });
  r = await bridge.run('mantle:layout:Lessons', {});
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

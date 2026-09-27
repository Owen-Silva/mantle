'use strict';
/* topbar-peek.test.js - the PEEK at a top bar hidden by hand (lane tbpeek, 2026-09-27): the pure
 * step in lib/features/_topbar-peek.js driven with a FAKE clock, cursor and mouse buttons, plus the
 * quick-settings row's words (ui/bar/topbarhide.js view) and the Mantle menu's item (ui/topbar/model.js).
 * Plain node, no deps, no Electron, no sidecar; nothing on the real screen is read or moved.
 *   node lib/features/topbar-peek.test.js      -> "TOPBAR PEEK TEST: n passed, m failed" */
const path = require('path');
const fs = require('fs');
const PK = require('./_topbar-peek');
const TH = require(path.join(__dirname, '..', '..', 'ui', 'bar', 'topbarhide.js'));
const M = require(path.join(__dirname, '..', '..', 'ui', 'topbar', 'model.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };

/* ---- a fake world: a 1536 x 864 DIP display at 0,0, the bar 28 DIP across its top ---------------- */
const BOUNDS = { x: 0, y: 0, width: 1536, height: 864 };
const BAR = { x: 0, y: 0, width: 1536, height: 28 };
const EDGE = { x: 700, y: 0 };
const ON_BAR = { x: 700, y: 12 };
const AWAY = { x: 700, y: 400 };
const HIDDEN = { hidden: true, enabled: true, stopped: false, run: null, lock: null, game: null, fullscreen: null };

/** Drive step() over a script of [ms, point, opts] polls; returns every result and the reader's calls. */
function run(script, o) {
  o = o || {};
  let st = o.st || PK.initial();
  const out = [];
  let reads = 0;
  for (const [t, pt, x] of script) {
    const e = x || {};
    const btn = e.btn || o.btn || { ok: true, held: false, pressed: false };
    const r = PK.step(st, {
      now: t, pt, cursorWhy: e.cursorWhy, bounds: e.bounds || BOUNDS, bar: e.bar || BAR, menuOpen: !!e.menuOpen,
      guard: PK.blocker(Object.assign({}, HIDDEN, o.g || {}, e.g || {})),
      buttons: () => { reads++; if (e.btnThrow || o.btnThrow) throw new Error('boom'); return btn; },
    });
    st = r.st;
    out.push(Object.assign({ t }, r));
  }
  return { out, st, reads, shownAt: (out.find((r) => r.act === 'show') || {}).t, hiddenAt: (out.find((r) => r.act === 'hide') || {}).t };
}
const every = (from, to, pt, step, x) => { const s = []; for (let t = from; t <= to; t += step || PK.PEEK_POLL_MS) s.push([t, pt, x]); return s; };

/* ---- the constants (named, and inside the brief's ranges) ------------------------------------ */
check('dwell is 450-550 ms', PK.PEEK_DWELL_MS >= 450 && PK.PEEK_DWELL_MS <= 550, PK.PEEK_DWELL_MS);
check('grace is 500-700 ms', PK.PEEK_GRACE_MS >= 500 && PK.PEEK_GRACE_MS <= 700, PK.PEEK_GRACE_MS);
check('the edge band is the top row or two of DIP', PK.PEEK_BAND_DIP >= 1 && PK.PEEK_BAND_DIP <= 2, PK.PEEK_BAND_DIP);
check('the poll is 50-150 ms (dwell and grace stay within a poll of their names)', PK.PEEK_POLL_MS >= 50 && PK.PEEK_POLL_MS <= 150, PK.PEEK_POLL_MS);
check('the reader covers all five mouse buttons (a swapped mouse too)', JSON.stringify(PK.VK_MOUSE) === '[1,2,4,5,6]');

/* ---- the edge ----------------------------------------------------------------------------- */
check('edge: the top row is on it', PK.inBand({ x: 0, y: 0 }, BOUNDS) && PK.inBand({ x: 1535, y: 1 }, BOUNDS));
check('edge: 2 DIP down is off it', !PK.inBand({ x: 700, y: 2 }, BOUNDS));
check('edge: beside the display (another monitor) is off it', !PK.inBand({ x: 1536, y: 0 }, BOUNDS) && !PK.inBand({ x: -1, y: 0 }, BOUNDS));
check('edge: above the display (a monitor stacked on top) is off it', !PK.inBand({ x: 700, y: -1 }, BOUNDS));
check('edge: a primary display that does not start at 0,0', PK.inBand({ x: 1600, y: 100 }, { x: 1536, y: 100, width: 1920, height: 1080 }) && !PK.inBand({ x: 1600, y: 0 }, { x: 1536, y: 100, width: 1920, height: 1080 }));
check('edge: no point is never on it', !PK.inBand(null, BOUNDS));

/* ---- the dwell ------------------------------------------------------------------------------ */
{
  const r = run(every(0, 1000, EDGE));
  check('dwell: resting on the edge peeks once the dwell has passed, not before', r.shownAt === PK.PEEK_DWELL_MS, r.shownAt);
  check('dwell: it peeks exactly once', r.out.filter((x) => x.act === 'show').length === 1);
  check('dwell: the reason names how long the cursor rested', /rested on the top edge for 500 ms/.test(r.out.find((x) => x.act === 'show').why), r.out.find((x) => x.act === 'show').why);
}
{
  // a flick up to click a tab: on the edge for 300 ms, gone, back
  const r = run([...every(0, 300, EDGE), [400, AWAY], ...every(500, 1200, EDGE)]);
  check('dwell: a flick up to the edge and away never peeks, and coming back starts the dwell again', r.shownAt === 1000, r.shownAt);
}
check('dwell: a cursor 2 DIP below the edge never peeks', run(every(0, 3000, { x: 700, y: 2 })).shownAt === undefined);
check('dwell: a cursor away from the edge never reads the mouse buttons', run(every(0, 3000, AWAY)).reads === 0);

/* ---- the mouse buttons ---------------------------------------------------------------------------- */
{
  const held = { ok: true, held: true, pressed: true };
  const up = { ok: true, held: false, pressed: false };
  const r = run([...every(0, 1500, EDGE, 100, { btn: held }), ...every(1600, 3000, EDGE, 100, { btn: up })]);
  check('buttons: a button held on the edge (a window dragged up to snap / maximise) never peeks, even after it is let go on the edge', r.shownAt === undefined, r.shownAt);
  check('buttons: the refusal says why', /mouse button went down on the top edge/.test(r.out[0].blocked || ''), r.out[0].blocked);
  const r2 = run([...every(0, 500, EDGE, 100, { btn: held }), [600, AWAY, { btn: up }], ...every(700, 1400, EDGE, 100, { btn: up })]);
  check('buttons: leaving the edge re-arms it, and a fresh dwell peeks', r2.shownAt === 700 + PK.PEEK_DWELL_MS, r2.shownAt);
  // a quick click on a tab at the edge, pressed and let go between two polls
  const r3 = run([[0, EDGE], [100, EDGE], [200, EDGE, { btn: { ok: true, held: false, pressed: true } }], ...every(300, 2000, EDGE)]);
  check('buttons: a click that went down and up between two polls during the dwell disarms it', r3.shownAt === undefined, r3.shownAt);
  const r4 = run([[0, EDGE, { btn: { ok: true, held: false, pressed: true } }], ...every(100, 800, EDGE)]);
  check('buttons: "pressed since the last read" on the FIRST read (a click anywhere, long ago) does not disarm', r4.shownAt === 500, r4.shownAt);
  const r5 = run(every(0, 2000, EDGE), { btn: { ok: false, reason: 'koffi missing' } });
  check('buttons: buttons that cannot be read refuse every peek', r5.shownAt === undefined);
  check('buttons: ... and say why, with the reader\'s reason', /mouse buttons cannot be read \(koffi missing\)/.test(r5.out[0].blocked || ''), r5.out[0].blocked);
  const r6 = run(every(0, 2000, EDGE), { btnThrow: true });
  check('buttons: a reader that throws refuses the peek instead of throwing', r6.shownAt === undefined && /threw: boom/.test(r6.out[0].blocked || ''), r6.out[0].blocked);
  const r7 = run([...every(0, 600, EDGE), ...every(700, 3000, ON_BAR, 100, { btn: held })]);
  check('buttons: a button held while the bar is out (a click on the bar) neither hides it nor is even read', r7.hiddenAt === undefined && r7.reads === 6, `${r7.hiddenAt} ${r7.reads}`);
}

/* ---- never peek ------------------------------------------------------------------------------ */
const guards = [
  ['a known game is running', { run: 'VALORANT.exe' }, /VALORANT\.exe is running \(a known game\)/],
  ['the foreground is full screen (YouTube in a browser)', { fullscreen: 'Google Chrome' }, /Google Chrome is full screen/],
  ['a full-screen game verdict', { game: 'the sidecar said so' }, /full-screen game is in front/],
  ['the lock screen is in front', { lock: 'LockApp.exe' }, /LockApp\.exe is in front/],
  ['the top bar is stopped / resting (game mode)', { stopped: true }, /stopped \(Mantle is resting/],
  ['the top bar is switched off in the tray', { enabled: false }, /switched off in the tray/],
  ['the top bar is not hidden by hand', { hidden: false }, /not hidden by hand/],
];
for (const [name, g, re] of guards) {
  const r = run(every(0, 3000, EDGE), { g });
  check(`never: ${name}`, r.shownAt === undefined && re.test(r.out[0].blocked || ''), `${r.shownAt} ${r.out[0].blocked}`);
  check(`never: ${name}: the buttons are not even read`, r.reads === 0, r.reads);
  // the same thing arriving while the bar is out hides it at once, with the reason
  const r2 = run([...every(0, 600, EDGE), [700, ON_BAR, { g }]]);
  check(`never: ${name}, arriving mid-peek, hides it at once`, r2.hiddenAt === 700 && re.test(r2.out[r2.out.length - 1].why || ''), `${r2.hiddenAt} ${r2.out[r2.out.length - 1].why}`);
}
check('never: the guard lifting while the cursor still rests there peeks after a fresh dwell',
  run([...every(0, 1000, EDGE, 100, { g: { fullscreen: 'Google Chrome' } }), ...every(1100, 2000, EDGE)]).shownAt === 1100 + PK.PEEK_DWELL_MS);

/* ---- hiding again ------------------------------------------------------------------------------ */
{
  const shown = every(0, 500, EDGE);
  const r = run([...shown, ...every(600, 4000, ON_BAR)]);
  check('grace: the cursor on the bar keeps it out indefinitely', r.hiddenAt === undefined);
  const r2 = run([...shown, [600, AWAY], [700, AWAY], [1100, AWAY], [1150, AWAY], [1200, AWAY], [1300, AWAY]]);
  check('grace: the cursor leaving hides it once the grace has passed, not before', r2.hiddenAt === 600 + PK.PEEK_GRACE_MS, r2.hiddenAt);
  check('grace: the reason says how long the cursor had been away', /left the bar 600 ms ago/.test((r2.out.find((x) => x.act === 'hide') || {}).why || ''));
  const r3 = run([...shown, [600, AWAY], [900, ON_BAR], [1000, AWAY], [1500, AWAY], [1600, AWAY], [1700, AWAY]]);
  check('grace: coming back inside the grace restarts it', r3.hiddenAt === 1600, r3.hiddenAt);
  const r4 = run([...shown, ...every(600, 3000, AWAY, 100, { menuOpen: true }), ...every(3100, 4000, AWAY)]);
  check('grace: never while one of its menus is open, then the grace after it closes', r4.hiddenAt === 3100 + PK.PEEK_GRACE_MS, r4.hiddenAt);
  const tall = { x: 0, y: 0, width: 1536, height: 300 };
  const r5 = run([...shown, ...every(600, 3000, { x: 40, y: 250 }, 100, { bar: tall })]);
  check('grace: the cursor inside the grown window (a dropdown) counts as on the bar', r5.hiddenAt === undefined);
  const r6 = run([...shown, ...every(600, 3000, EDGE)]);
  check('grace: the cursor still on the edge keeps it out', r6.hiddenAt === undefined);
  const r7 = run([...shown, [600, null, { cursorWhy: 'GetCursorPos failed' }]]);
  check('cursor: a cursor that cannot be read while the bar is out hides it, with the reason', r7.hiddenAt === 600 && /could not be read \(GetCursorPos failed\)/.test(r7.out[r7.out.length - 1].why), r7.out[r7.out.length - 1].why);
  const r8 = run(every(0, 2000, null, 100, { cursorWhy: 'denied' }));
  check('cursor: a cursor that cannot be read never peeks, and says so', r8.shownAt === undefined && /could not be read \(denied\)/.test(r8.out[0].blocked || ''));
  const r9 = run([...shown, ...every(600, 1200, AWAY), ...every(1300, 2200, EDGE)]);
  check('grace: after it hid, the edge needs a whole new dwell', r9.out.filter((x) => x.act === 'show').map((x) => x.t).join() === `500,${1300 + PK.PEEK_DWELL_MS}`, r9.out.filter((x) => x.act === 'show').map((x) => x.t).join());
}

/* ---- a watch that has just started (Win+Alt+T pressed with the cursor resting on the edge) ----- */
{
  const r = run([...every(0, 2000, EDGE), [2100, AWAY], ...every(2200, 3000, EDGE)], { st: PK.startState() });
  check('start: hidden with the cursor on the edge does not peek straight back', !r.out.slice(0, 21).some((x) => x.act === 'show'));
  check('start: once the cursor has left the edge the peek works', r.shownAt === 2200 + PK.PEEK_DWELL_MS, r.shownAt);
  check('start: a cursor elsewhere is armed on the first poll', run([[0, AWAY], ...every(100, 700, EDGE)], { st: PK.startState() }).shownAt === 600);
}

/* ---- the manual state is never the peek's to change ------------------------------------------ */
{
  const st0 = PK.initial();
  const g = Object.assign({}, HIDDEN);
  const frozen = JSON.stringify({ st0, g });
  PK.step(st0, { now: 0, pt: EDGE, bounds: BOUNDS, bar: BAR, guard: PK.blocker(g), buttons: () => ({ ok: true }) });
  check('manual: step() never mutates the state or the inputs it was given', JSON.stringify({ st0, g }) === frozen);
  const src = fs.readFileSync(path.join(__dirname, 'topbar.js'), 'utf8');
  const a = src.indexOf('/* ---- PEEK while hidden by hand');
  const b = src.indexOf('function coverNote');
  const peekCode = a > 0 && b > a ? src.slice(a, b) : '';
  check('manual: topbar.js has its PEEK section', peekCode.length > 1000, `${a} ${b}`);
  check('manual: the PEEK code never writes S.hidden or the saved setting', peekCode && !/S\.hidden\s*=[^=]/.test(peekCode) && !/settings\.set\(/.test(peekCode));
  check('manual: the PEEK code never reserves or releases the strip, nor turns the drag guard on',
    peekCode && !/\breserve\(/.test(peekCode) && !/\brelease\(/.test(peekCode) && !/guardOn\(/.test(peekCode) && !/topbar\.guard/.test(peekCode));
  check('manual: the only writer of the saved hidden setting is setHidden', (src.match(/settings\.set\('hidden'/g) || []).length === 1 && /async function setHidden[\s\S]{0,200}settings\.set\('hidden'/.test(src));
}

/* ---- the real button reader: READS only (GetAsyncKeyState), never injects ---------------------- */
if (process.platform === 'win32') {
  const r = PK.nativeButtons()();
  check('reader: GetAsyncKeyState answers through koffi here', r.ok === true && typeof r.held === 'boolean' && typeof r.pressed === 'boolean', JSON.stringify(r));
}
check('reader: the module has no way to inject input', !/SendInput|mouse_event|SetCursorPos|keybd_event/.test(fs.readFileSync(path.join(__dirname, '_topbar-peek.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));

/* ---- quick settings: the Top bar row ------------------------------------------------------------ */
{
  const base = { hidden: true, chord: 'Win+Alt+T', enabled: true, visible: false, stepAside: true, kind: 'hidden', test: false };
  const ok = TH.view(Object.assign({}, base, { peek: { ok: true, reason: null, watching: true, shown: false } }));
  check('row: hidden says the top edge peeks', /^Hidden · point at the top to peek$/.test(ok.sub), ok.sub);
  check('row: ... and names Win+Alt+T as the way back for good, not as a warning', /Win\+Alt\+T or Show top bar brings it back for good/.test(ok.why) && !ok.warn, ok.why);
  check('row: the sub fits its one line (36 characters)', ok.sub.length <= 36, ok.sub.length);
  const bad = TH.view(Object.assign({}, base, { peek: { ok: false, reason: 'the cursor position could not be read (denied)', watching: true, shown: false } }));
  check('row: a watch that cannot work gets its own warning line with the reason', bad.warn && /cannot peek at it: the cursor position could not be read \(denied\)/.test(bad.why), JSON.stringify(bad));
  check('row: ... and the sub still names the chord', bad.sub === 'Hidden · Win+Alt+T to show', bad.sub);
  const old = TH.view(base);
  check('row: a top bar that sends no peek state (older) still reads as hidden with a way back', old.hidden && old.label === 'Show top bar' && !old.warn);
  const shown = TH.view(Object.assign({}, base, { hidden: false, stepAside: false, kind: null, peek: { ok: null, watching: false, shown: false } }));
  check('row: shown is unchanged', shown.sub === 'Shown · Win+Alt+T hides it' && shown.label === 'Hide top bar', shown.sub);
}

/* ---- the Mantle menu while it peeks ------------------------------------------------------------ */
{
  const menu = JSON.parse(JSON.stringify(M.MANTLE_MENU));
  const it = M.peekMenu(menu, true);
  check('menu: peeking, "Hide top bar" becomes "Show top bar" (for good)', it && it.act === 'show' && it.label === 'Show top bar' && it.key === 'Win+Alt+T');
  const back = M.peekMenu(menu, false);
  check('menu: the peek over, it is "Hide top bar" again', back && back.act === 'hide' && back.label === 'Hide top bar');
  check('menu: a menu without the item is left alone', M.peekMenu([{ t: 'item', act: 'about' }], true) === null);
  check('menu: the real menu is still "Hide top bar" (nothing peeks in a test)', M.MANTLE_MENU.some((i) => i.act === 'hide' && i.label === 'Hide top bar'));
}

console.log(`TOPBAR PEEK TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);

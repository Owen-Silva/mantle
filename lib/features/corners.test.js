'use strict';
/* corners.test.js - HOT CORNERS (lane corners, 2026-09-27): the pure step in lib/features/_corners.js
 * driven with a FAKE clock, cursor and mouse buttons; the zones (the bottom edge clip at every scale);
 * the check at the moment of firing; the claim table the top bar peek and the bottom bar reveal read;
 * every action through runAction with fake effects (lib/features/corners.js); the feature's contract;
 * and the quick-settings row's words (ui/bar/corners.js view).
 * Plain node, no deps, no Electron, no sidecar; nothing on the real screen is read or moved.
 *   node lib/features/corners.test.js      -> "CORNERS TEST: n passed, m failed" */
const path = require('path');
const C = require('./_corners');
const P = require('./_gamemode-plan');
const PK = require('./_topbar-peek');
const F = require('./corners');
const { validate } = require('../features');
const UI = require(path.join(__dirname, '..', '..', 'ui', 'bar', 'corners.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };

/* ---- a fake world: a 1536 x 864 DIP display at 0,0 (Owen's 1920x1080 at 125%) ------------------ */
const B = { x: 0, y: 0, width: 1536, height: 864 };
const PT = { tl: { x: 0, y: 0 }, tr: { x: 1535, y: 0 }, bl: { x: 0, y: 861 }, br: { x: 1535, y: 861 } };   // 861 = the edge-clip row at 125%
const MID = { x: 700, y: 400 };
const DEF = Object.assign({}, C.DEFAULTS);

/** Drive step() over [ms, point, opts] polls; returns every result, the fires and the reader's calls. */
function run(script, o) {
  o = o || {};
  let st = o.st || C.initial();
  const out = [];
  let reads = 0;
  for (const [t, pt, x] of script) {
    const e = x || {};
    const btn = e.btn || o.btn || { ok: true, held: false, pressed: false };
    const r = C.step(st, {
      now: t, pt, cursorWhy: e.cursorWhy, bounds: e.bounds || B, actions: e.actions || o.actions || DEF,
      guard: e.guard !== undefined ? e.guard : (o.guard || null),
      buttons: () => { reads++; if (e.btnThrow) throw new Error('boom'); return btn; },
    });
    st = r.st;
    out.push(Object.assign({ t }, r));
  }
  const fires = out.filter((r) => r.act === 'fire');
  return { out, st, reads, fires, firedAt: fires.map((r) => r.t) };
}
const every = (from, to, pt, x) => { const s = []; for (let t = from; t <= to; t += C.CORNER_POLL_MS) s.push([t, pt, x]); return s; };

/* ---- constants ----------------------------------------------------------------------------------- */
check('the dwell is 200-300 ms, the poll 100 ms, the square a few DIP',
  C.CORNER_DWELL_MS >= 200 && C.CORNER_DWELL_MS <= 300 && C.CORNER_POLL_MS === 100 && C.CORNER_ZONE_DIP >= 3 && C.CORNER_ZONE_DIP <= 8);
check('the defaults: top-left Task view, bottom-right Show desktop, the other two off',
  C.DEFAULTS.tl === 'taskview' && C.DEFAULTS.br === 'desktop' && C.DEFAULTS.tr === 'off' && C.DEFAULTS.bl === 'off');
check('the choices: Off, Task view, Show desktop, Launcher, Quick settings, Lock screen',
  JSON.stringify(C.ACTIONS) === '["off","taskview","desktop","launcher","qs","lock"]' && C.ACTIONS.every((a) => !!C.ACTION_NAMES[a]));

/* ---- saved settings ------------------------------------------------------------------------------ */
check('normalize: nothing saved -> the defaults', JSON.stringify(C.normalize(null)) === JSON.stringify(DEF));
check('normalize: a saved choice is kept, junk falls back per corner, unknown corners dropped',
  JSON.stringify(C.normalize({ tl: 'lock', tr: 'nope', br: 'off', xx: 'qs' })) === JSON.stringify({ tl: 'lock', tr: 'off', bl: 'off', br: 'off' }));
check('anyOn: all off is off', !C.anyOn({ tl: 'off', tr: 'off', bl: 'off', br: 'off' }) && C.anyOn(DEF) && !C.anyOn(null));

/* ---- zones --------------------------------------------------------------------------------------- */
check('cornerAt: the four corner pixels', C.cornerAt({ x: 0, y: 0 }, B) === 'tl' && C.cornerAt({ x: 1535, y: 0 }, B) === 'tr' &&
  C.cornerAt({ x: 0, y: 863 }, B) === 'bl' && C.cornerAt({ x: 1535, y: 863 }, B) === 'br');
check('cornerAt: a 6 DIP square - 5 in, 6 out, on each axis',
  C.cornerAt({ x: 5, y: 5 }, B) === 'tl' && C.cornerAt({ x: 6, y: 0 }, B) === null && C.cornerAt({ x: 0, y: 6 }, B) === null &&
  C.cornerAt({ x: 1530, y: 858 }, B) === 'br' && C.cornerAt({ x: 1529, y: 863 }, B) === null && C.cornerAt({ x: 1535, y: 857 }, B) === null);
check('cornerAt: the middle of an edge, off the display, and nonsense are no corner',
  C.cornerAt({ x: 700, y: 0 }, B) === null && C.cornerAt({ x: -1, y: 0 }, B) === null && C.cornerAt({ x: 0, y: 865 }, B) === null && C.cornerAt({ x: 1537, y: 0 }, B) === null &&
  C.cornerAt(null, B) === null && C.cornerAt({ x: NaN, y: 0 }, B) === null);
check('cornerAt: the last pixel rounded ONE DIP past a fractional display\'s width/height is still its corner', C.cornerAt({ x: 1536, y: 864 }, B) === 'br' && C.cornerAt({ x: 1536, y: 0 }, B) === 'tr');
/* MULTI-MONITOR (quality pass 2026-09-29): every display, OUTER corners only. Primary 1536x864 at 0,0;
   a taller second screen to its right (1920x1080 at 1536,0); a third above the primary (1536x864 at 0,-864). */
{
  const P1 = { x: 0, y: 0, width: 1536, height: 864 }, P2 = { x: 1536, y: 0, width: 1920, height: 1080 }, P3 = { x: 0, y: -864, width: 1536, height: 864 };
  const two = [P1, P2];
  check('screens: one display behaves exactly like cornerAt', ['tl', 'tr', 'bl', 'br'].every((c, i) => C.cornerOnScreens([{ x: 0, y: 0 }, { x: 1535, y: 0 }, { x: 0, y: 863 }, { x: 1535, y: 863 }][i], [P1]) === c));
  check('screens: a corner that touches another screen is not hot (the cursor passes through it)',
    C.cornerOnScreens({ x: 1535, y: 0 }, two) === null && C.cornerOnScreens({ x: 1535, y: 863 }, two) === null && C.cornerOnScreens({ x: 1536, y: 0 }, two) === null, [C.cornerOnScreens({ x: 1535, y: 0 }, two), C.cornerOnScreens({ x: 1536, y: 0 }, two)]);
  check('screens: the second screen\'s outer corners are hot (it had none before)',
    C.cornerOnScreens({ x: 3455, y: 0 }, two) === 'tr' && C.cornerOnScreens({ x: 3455, y: 1079 }, two) === 'br');
  check('screens: the taller screen\'s bottom-left is outer (nothing beside it below the primary)', C.cornerOnScreens({ x: 1536, y: 1079 }, two) === 'bl');
  check('screens: the primary\'s outer corners stay hot', C.cornerOnScreens({ x: 0, y: 0 }, two) === 'tl' && C.cornerOnScreens({ x: 0, y: 863 }, two) === 'bl');
  const three = [P1, P2, P3];
  check('screens: a screen above makes the primary\'s top-left inner, and its own top-left outer',
    C.cornerOnScreens({ x: 0, y: 0 }, three) === null && C.cornerOnScreens({ x: 0, y: -864 }, three) === 'tl', [C.cornerOnScreens({ x: 0, y: 0 }, three), C.cornerOnScreens({ x: 0, y: -864 }, three)]);
  check('screens: nonsense is no corner', C.cornerOnScreens(null, two) === null && C.cornerOnScreens({ x: 5, y: 5 }, []) === null && C.cornerOnScreens({ x: 5, y: 5 }, null) === null);
  // step() with displays fires on the second screen, and not at the inner corner
  const ACT = { tl: 'taskview', tr: 'qs', bl: 'off', br: 'desktop' };
  const run = (pt) => { let st = C.initial(); let fired = null; for (let t = 0; t <= 600; t += 100) { const r = C.step(st, { now: t, pt, bounds: P1, displays: two, actions: ACT, buttons: () => ({ ok: true }) }); st = r.st; if (r.act === 'fire') fired = r.corner; } return fired; };
  check('screens: step fires at the second screen\'s top-right and not at the primary\'s inner top-right', run({ x: 3455, y: 0 }) === 'tr' && run({ x: 1535, y: 0 }) === null, [run({ x: 3455, y: 0 }), run({ x: 1535, y: 0 })]);
  // the claim table: an inner corner is the edge's, not the corner's
  C.setClaims(ACT, two);
  check('screens: claims give an inner corner back to the edge, keep an outer one', C.claims({ x: 1535, y: 863 }, P1) === null && C.claims({ x: 0, y: 0 }, P1) === 'tl');
  C.setClaims(null, null);
}
check('cornerAt: a display that does not start at 0,0', C.cornerAt({ x: -1920, y: -200 }, { x: -1920, y: -200, width: 1920, height: 1080 }) === 'tl' &&
  C.cornerAt({ x: -1, y: 879 }, { x: -1920, y: -200, width: 1920, height: 1080 }) === 'br');
{
  // THE BOTTOM EDGE CLIP (main.js / sidecar/EdgeClip.cs): ClipCursor 0,0,W,H-2 -> the lowest row reachable is H-3 px.
  let bad = [];
  for (const [w, h] of [[1920, 1080], [2560, 1440], [3840, 2160], [1366, 768]]) {
    for (const s of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
      const b = { x: 0, y: 0, width: Math.round(w / s), height: Math.round(h / s) };
      for (const round of [Math.floor, Math.round]) {
        const y = round((h - 3) / s);                 // the edge-clip row in DIP, however Electron rounds it
        const x = round((w - 1) / s);
        if (C.cornerAt({ x, y }, b) !== 'br' || C.cornerAt({ x: 0, y }, b) !== 'bl') bad.push(`${w}x${h}@${s} y ${y}/${b.height}`);
        if (C.cornerAt({ x, y: round((h - 1) / s) }, b) !== 'br') bad.push(`${w}x${h}@${s} clip off`);
      }
    }
  }
  check('bottom corners: the edge-clip row (H-3 px) and the bottom row (clip off) are in the square at every scale', !bad.length, bad.slice(0, 4).join('; '));
}

/* ---- step: dwell, once, re-arm ------------------------------------------------------------------- */
{
  const r = run(every(0, 1000, PT.br));
  check('bottom-right: resting fires ONCE, after the dwell (250 ms from the first poll there)', r.fires.length === 1 && r.firedAt[0] === 300 &&
    r.fires[0].corner === 'br' && r.fires[0].action === 'desktop' && /bottom-right corner for 300 ms/.test(r.fires[0].why), JSON.stringify(r.firedAt));
  const early = run(every(0, 200, PT.br));
  check('under the dwell: nothing', early.fires.length === 0 && early.st.phase === 'dwell');
  const flick = run([[0, MID], [100, PT.tl], [200, PT.tl], [300, MID], [400, PT.tl], [500, MID]]);
  check('a flick through the corner (in and out inside the dwell) never fires', flick.fires.length === 0);
  const back = run(every(0, 500, PT.br).concat([[600, MID]], every(700, 1200, PT.br)));
  check('leaving re-arms: back in, it fires again after a fresh dwell', back.fires.length === 2 && back.firedAt[1] === 1000, JSON.stringify(back.firedAt));
  const nudge = run(every(0, 400, PT.br).concat(every(500, 1500, { x: 1532, y: 860 })));
  check('moving inside the square is still the same arrival: no second fire', nudge.fires.length === 1);
  const start = run(every(0, 1000, PT.tl), { st: C.startState() });
  check('a new watch starts DISARMED: a cursor already parked in a corner does not fire', start.fires.length === 0 && start.st.phase === 'disarmed' && /leave first/.test(start.out[0].blocked || ''));
  const start2 = run([[0, PT.tl], [100, MID]].concat(every(200, 600, PT.tl)), { st: C.startState() });
  check('...and leaving once arms it', start2.fires.length === 1 && start2.firedAt[0] === 500, JSON.stringify(start2.firedAt));
  const off = run(every(0, 1000, PT.tr));
  check('an Off corner never fires and never reads the buttons', off.fires.length === 0 && off.reads === 0 && off.st.phase === 'idle');
  const mid = run(every(0, 1000, MID));
  check('the buttons are read only while the cursor is in an active corner', mid.reads === 0);
  const two = run(every(0, 400, PT.tl).concat([[500, MID]], every(600, 1000, PT.br)));
  check('each corner fires its own action', two.fires.length === 2 && two.fires[0].action === 'taskview' && two.fires[1].action === 'desktop');
  const turnedOff = run(every(0, 400, PT.br).concat(every(500, 800, PT.br, { actions: Object.assign({}, DEF, { br: 'off' }) }), every(900, 1300, PT.br)));
  check('a corner switched Off under the cursor forgets its arrival; switched back on, a fresh dwell',
    turnedOff.fires.length === 2 && turnedOff.firedAt[1] === 1200, JSON.stringify(turnedOff.firedAt));
}

/* ---- step: guards -------------------------------------------------------------------------------- */
{
  const g = run(every(0, 1000, PT.br), { guard: 'the last corner action is still running' });
  check('a guard: nothing fires, and it says why', g.fires.length === 0 && g.st.phase === 'disarmed' && /still running/.test(g.out[g.out.length - 1].blocked));
  const cleared = run(every(0, 300, PT.br, { guard: 'busy' }).concat(every(400, 1000, PT.br, { guard: null })));
  check('a guard that clears with the cursor still there: still nothing (it has to leave first)', cleared.fires.length === 0);
  const after = run(every(0, 300, PT.br, { guard: 'busy' }).concat([[400, MID]], every(500, 900, PT.br, { guard: null })));
  check('...leave and come back and it fires', after.fires.length === 1 && after.firedAt[0] === 800, JSON.stringify(after.firedAt));
  const held = run(every(0, 1000, PT.br, { btn: { ok: true, held: true, pressed: true } }));
  check('a mouse button HELD in the corner (a drag): nothing, disarmed, and it says why', held.fires.length === 0 && held.st.phase === 'disarmed' && /mouse button went down/.test(held.st.why));
  const released = run(every(0, 200, PT.br, { btn: { ok: true, held: true } }).concat(every(300, 1000, PT.br)));
  check('the button let go, still in the corner: still nothing', released.fires.length === 0);
  const clickDwell = run([[0, PT.tl], [100, PT.tl, { btn: { ok: true, held: false, pressed: true } }]].concat(every(200, 800, PT.tl)));
  check('a click DURING the dwell (the Mantle menu under the corner) disarms it', clickDwell.fires.length === 0 && clickDwell.st.phase === 'disarmed');
  const stale = run([[0, PT.tl, { btn: { ok: true, held: false, pressed: true } }]].concat(every(100, 500, PT.tl)));
  check('the "pressed since last read" bit on ARRIVAL is not held against it (it can be a click from anywhere, long ago)', stale.fires.length === 1);
  const unread = run(every(0, 1000, PT.br, { btn: { ok: false, reason: 'no koffi' } }));
  check('a button reader that cannot read: nothing fires, with the reason', unread.fires.length === 0 && /cannot be read \(no koffi\)/.test(unread.out[0].blocked));
  const thrown = run(every(0, 1000, PT.br, { btnThrow: true }));
  check('a button reader that throws: nothing fires, with the reason', thrown.fires.length === 0 && /threw: boom/.test(thrown.out[0].blocked));
  const recover = run(every(0, 300, PT.br, { btn: { ok: false, reason: 'x' } }).concat(every(400, 800, PT.br)));
  check('...and once it reads again the dwell starts from there', recover.fires.length === 1 && recover.firedAt[0] === 700, JSON.stringify(recover.firedAt));
  const blind = run([[0, PT.br], [100, PT.br], [200, null, { cursorWhy: 'GetCursorPos failed' }]].concat(every(300, 700, PT.br)));
  check('a cursor that cannot be read ends a dwell (with the reason); the dwell starts again after',
    blind.out[2].blocked === 'the cursor could not be read (GetCursorPos failed)' && blind.fires.length === 1 && blind.firedAt[0] === 600, JSON.stringify(blind.firedAt));
  const blindFired = run(every(0, 400, PT.br).concat([[500, null]], every(600, 1000, PT.br)));
  check('a fired corner stays fired through an unreadable cursor (no second fire)', blindFired.fires.length === 1);
}

/* ---- the check at the moment of firing ------------------------------------------------------------- */
{
  const own = 1;
  const scan = (fg, procs) => ({ ok: true, ownSession: own, fg: Object.assign({ pid: 4, exe:'C:\\Windows\\explorer.exe', title: 'x', fullscreen: false }, fg || {}), procs: procs || [] });
  const fb = (s, o) => C.fireBlocker(s, P, o || {});
  check('fire: an ordinary window in front, no game: fires', fb(scan()) === null);
  check('fire: no answer from the sidecar refuses, with the reason', /could not be checked .*\(timed out\)/.test(fb({ ok: false, reason: 'timed out' })) && /no answer/.test(fb(null)));
  check('fire: a full-screen window in front refuses', /chrome\.exe is full screen in front/.test(fb(scan({ exe: 'C:\\x\\chrome.exe', fullscreen: true }))));
  check('fire: a known game running (not even in front) refuses', /VALORANT is running \(a known game\)/.test(fb(scan({}, [{ pid: 9, file: 'VALORANT-Win64-Shipping.exe', session: own }]))),
    fb(scan({}, [{ pid: 9, file: 'VALORANT-Win64-Shipping.exe', session: own }])));
  const winGame = String(fb(scan({ pid: 7, exe: 'C:\\Games\\VALORANT-Win64-Shipping.exe', fullscreen: false })));
  check('fire: a known game in front, WINDOWED, refuses', /VALORANT-Win64-Shipping\.exe is in front \(a known game\)/.test(winGame), winGame);
  check('fire: the lock screen in front refuses', /LockApp\.exe is in front/.test(fb(scan({ exe: 'C:\\Windows\\SystemApps\\Microsoft.LockApp_cw5n1h2txyewy\\LockApp.exe' }))));
  check('fire: a TEST stand-in game name counts (the self-test)', /running \(a known game\)/.test(String(fb(scan({}, [{ pid: 5, file: 'electron.exe', session: own }]), { extra: ['electron.exe'] }))));
  check('fire: another user\'s game does not count', fb(scan({}, [{ pid: 9, file: 'VALORANT.exe', session: 2 }])) === null);
}

/* ---- the claim table (the top bar peek and main.js's bottom bar reveal read it) --------------------- */
{
  C.setClaims(null);
  check('claims: no table (the corners stopped, rested, off) claims nothing', C.claims(PT.br, B) === null);
  C.setClaims({ tl: 'off', tr: 'off', bl: 'off', br: 'off' });
  check('claims: all four Off claims nothing', C.claims(PT.br, B) === null && C.claims(PT.tl, B) === null);
  C.setClaims(DEF);
  // main.js hoverTick: the reveal band is the bottom 4 DIP, full width
  const band = (pt) => pt.y >= B.height - 4 && !C.claims(pt, B);
  check('claims: the active bottom-right square is the corner\'s - the reveal band loses it (at the edge-clip row too)',
    C.claims(PT.br, B) === 'br' && !band(PT.br) && !band({ x: 1535, y: 863 }));
  check('claims: the Off bottom-left square stays the reveal band\'s', C.claims(PT.bl, B) === null && band(PT.bl));
  check('claims: the rest of the bottom edge reveals as before', band({ x: 700, y: 861 }) && band({ x: 1529, y: 861 }));
  const peek = (pt, t) => PK.step(PK.initial(), { now: t || 0, pt, bounds: B, bar: { x: 0, y: 0, width: 1536, height: 28 }, guard: null, claimed: !!C.claims(pt, B), buttons: () => ({ ok: true }) });
  check('claims: the top bar peek does not start its dwell in the active top-left square, does beside it',
    peek(PT.tl).st.phase === 'idle' && peek({ x: 6, y: 0 }).st.phase === 'dwell' && peek(PT.tr).st.phase === 'dwell');
  const copy = { tl: 'lock', tr: 'off', bl: 'off', br: 'off' };
  C.setClaims(copy);
  copy.tl = 'off';
  check('claims: the table is a copy (a later change to the caller\'s object does not leak in)', C.claims(PT.tl, B) === 'tl');
  C.setClaims(null);
}

/* ---- the actions (fake effects) ----------------------------------------------------------------- */
(async () => {
  const T = F._test;
  const calls = [];
  const fx = (o) => Object.assign({
    test: false,
    chord: (c, dry) => { calls.push(['chord', c, dry]); return dry ? { delivered: false, dryRun: true, feature: 'taskview' } : { delivered: true, feature: 'taskview' }; },
    desktop: async (dry) => { calls.push(['desktop', dry]); return dry ? { ok: true, dryRun: true, wouldCall: 'Shell.Application ToggleDesktop (IShellDispatch4)' } : { ok: true, called: 'Shell.Application ToggleDesktop (IShellDispatch4)' }; },
    launcher: (dry) => { calls.push(['launcher', dry]); },
    qs: async (dry) => { calls.push(['qs', dry]); return dry ? { ok: true, dryRun: true } : { ok: true }; },
    lock: (dry) => { calls.push(['lock', dry]); return dry ? { ok: true, dryRun: true, wouldCall: 'user32 LockWorkStation' } : { ok: true, called: 'LockWorkStation' }; },
  }, o || {});
  const live = {};
  for (const a of ['taskview', 'desktop', 'launcher', 'qs', 'lock']) live[a] = await T.runAction(a, fx());
  check('actions, live: each runs its effect once and says what it did',
    live.taskview.ok && /opened Task view/.test(live.taskview.said) && live.desktop.ok && /toggled Show desktop/.test(live.desktop.said) &&
    live.launcher.ok && live.qs.ok && /opened quick settings/.test(live.qs.said) && live.lock.ok && /locked/.test(live.lock.said) &&
    calls.length === 5 && calls.every((c) => c[c.length - 1] === false), JSON.stringify({ live, calls }));
  check('actions: Task view goes through Win+Tab (its own feature), never a key sent', calls[0][0] === 'chord' && calls[0][1] === 'Win+Tab');
  calls.length = 0;
  const dry = {};
  for (const a of ['taskview', 'desktop', 'launcher', 'qs', 'lock']) dry[a] = await T.runAction(a, fx({ test: true }));
  check('actions, --test: EVERY one is a dry run (asked with dry=true) and says so',
    Object.values(dry).every((r) => r.ok && r.dryRun && /^DRY RUN \(--test\)/.test(r.said)) && calls.length === 5 && calls.every((c) => c[c.length - 1] === true),
    JSON.stringify({ dry, calls }));
  check('actions, --test: Show desktop names the shell call it would make', /ToggleDesktop/.test(dry.desktop.said));
  const qsClosed = await T.runAction('qs', fx({ qs: async () => ({ ok: true, closed: true }) }));
  check('actions: quick settings already open closes, and says so', qsClosed.ok && /closed quick settings/.test(qsClosed.said));
  const fails = {
    taskview: await T.runAction('taskview', fx({ chord: () => ({ delivered: false, reason: 'Task View is switched off in the tray' }) })),
    taskviewDry: await T.runAction('taskview', fx({ test: true, chord: () => ({ delivered: false, reason: 'no feature takes Win+Tab' }) })),
    desktop: await T.runAction('desktop', fx({ desktop: async () => ({ ok: false, reason: 'refused: sidecar is passive (test mode)' }) })),
    launcher: await T.runAction('launcher', fx({ launcher: () => { throw new Error('there is no launcher window to open'); } })),
    qs: await T.runAction('qs', fx({ qs: async () => ({ ok: false, reason: 'the bar did not answer within 1500 ms' }) })),
    lock: await T.runAction('lock', fx({ lock: () => ({ ok: false, reason: 'koffi could not bind LockWorkStation (x)' }) })),
    reject: await T.runAction('desktop', fx({ desktop: async () => { throw new Error('sidecar gone'); } })),
    unknown: await T.runAction('explode', fx()),
    empty: await T.runAction('desktop', fx({ desktop: async () => null })),
  };
  check('actions: every failure is ok:false WITH its reason in the words (never thrown, never silent)',
    !fails.taskview.ok && /switched off in the tray/.test(fails.taskview.said) && !fails.taskviewDry.ok && /no feature takes Win\+Tab/.test(fails.taskviewDry.said) &&
    !fails.desktop.ok && /passive/.test(fails.desktop.said) && !fails.launcher.ok && /no launcher window/.test(fails.launcher.said) &&
    !fails.qs.ok && /did not answer/.test(fails.qs.said) && !fails.lock.ok && /koffi/.test(fails.lock.said) &&
    !fails.reject.ok && /sidecar gone/.test(fails.reject.said) && !fails.unknown.ok && /not a corner action/.test(fails.unknown.said) &&
    !fails.empty.ok && /no reason came back/.test(fails.empty.said), JSON.stringify(fails));

  /* ---- the feature's contract ---------------------------------------------------------------------- */
  check('feature: passes lib/features.js validate (name = file, rest: true, no chords)', validate(F, 'corners') === null && F.rest === true && F.defaultOn === true, validate(F, 'corners'));
  check('feature: the lock binder is lazy (nothing bound at require time)', typeof T.nativeLock === 'function' && T.ACK_MS >= 1000);

  /* ---- the quick-settings row's words (ui/bar/corners.js) ----------------------------------------- */
  const st = { enabled: true, test: false, actions: DEF, choices: C.ACTIONS.map((id) => ({ id, label: C.ACTION_NAMES[id] })), watch: { ok: true }, last: null, fails: {} };
  const v = UI.view(st);
  check('row: four cells in screen order with their action names, "2 on"',
    v.cells.map((c) => c.corner).join() === 'tl,tr,bl,br' && v.cells[0].actionLabel === 'Task view' && v.cells[3].actionLabel === 'Show desktop' &&
    v.cells[1].off && /^2 on/.test(v.sub) && !v.warn && !v.lines.length, JSON.stringify(v));
  const vf = UI.view(Object.assign({}, st, { fails: { br: { at: 1, action: 'desktop', said: 'Show desktop did not run: refused' } } }));
  check('row: a failed corner is marked and its reason is a warning line', vf.cells[3].failed && vf.warn && /Bottom right \(Show desktop\): Show desktop did not run: refused/.test(vf.lines[0].text));
  const vw = UI.view(Object.assign({}, st, { watch: { ok: false, reason: 'the mouse buttons cannot be read (x)' } }));
  check('row: a watch that cannot fire says why', vw.warn && /paused: The mouse buttons cannot be read/.test(vw.lines[0].text), vw.lines);
  const vb = UI.view(Object.assign({}, st, { last: { corner: 'br', action: 'desktop', blocked: true, said: 'VALORANT is running (a known game)' } }));
  check('row: a push that a game refused is said, not as a warning', !vb.warn && /bottom right: did nothing, VALORANT is running/.test(vb.lines[0].text));
  const vr = UI.view({ error: 'Hot corners is resting while VALORANT runs; it is back when the game exits' });
  check('row: resting while a game runs is said plainly', vr.dead && /Resting/.test(vr.sub) && !vr.warn);
  const vx = UI.view({ error: 'boom' });
  check('row: no answer is a warning with the reason', vx.dead && vx.warn && /didn't answer: Boom/.test(vx.lines[0].text), vx.lines);
  // quality pass 2026-09-29 (bar-ntf): the row flashed "Unavailable / did not answer" on every open until the first answer
  const vl = UI.view(null);
  check('row: before the first answer it is loading, not a failure', vl.dead && vl.loading && vl.sub === 'Loading…' && !vl.warn && !vl.lines.length, vl);
  const JARGON = /sidecar|koffi|dry ?run|0x[0-9a-f]{4,}|LockWorkStation|Shell\.Application|npm |undefined|\bnull\b/i;
  const vt = UI.view(Object.assign({}, st, { fails: { br: { at: 1, action: 'lock', said: 'the screen did not lock: koffi could not bind LockWorkStation (dlopen failed)' },
    tl: { at: 1, action: 'desktop', said: 'Show desktop did not run: the sidecar has no hotcorners.desktop (unknown command): run npm run build:sidecar' } },
    watch: { ok: false, reason: 'the mouse buttons cannot be read (the reader threw: koffi 0x80004005)' },
    last: { corner: 'tr', action: 'qs', blocked: true, said: 'the window in front could not be checked for a game or full screen (sidecar timeout), so nothing fired' } }));
  const vtText = vt.lines.map((l) => l.text).join(' | ');
  check('row: technical reasons never reach the screen; each line still names the corner and says what to do', !JARGON.test(vtText) &&
    /Top left \(Show desktop\): Show desktop didn't work last time/.test(vtText) && /Bottom right \(Lock screen\)/.test(vtText) && /paused/.test(vtText) && /Last push, top right: did nothing/.test(vtText), vtText);
  check('row: a plain reason is kept as is (sentence case, full stop)', /Bottom right \(Show desktop\): Show desktop did not run: refused\./.test(vf.lines[0].text), vf.lines[0].text);
  const vo = UI.view(Object.assign({}, st, { enabled: false }));
  check('row: switched off in the tray says so', /Switched off/.test(vo.sub) && vo.warn);
  const va = UI.view(Object.assign({}, st, { actions: { tl: 'off', tr: 'off', bl: 'off', br: 'off' } }));
  check('row: all off', va.sub === 'All off');
  check('row: the test instance says corners only pretend, without the words "dry run"', /test copy of Mantle: corners only pretend/.test(UI.view(Object.assign({}, st, { test: true })).lines.map((l) => l.text).join()));
  const clipLong = F._test && F._test.clipLong;
  check('ack: the bar page\'s reason is one line of at most 160 characters in the log', typeof clipLong === 'function' && clipLong('y'.repeat(1 << 16) + '\nfake').length === 160 && clipLong('a\nb') === 'a b');
  // secreview-win: corners.set echoed a renderer's corner / action / via into its reason and the log in full
  const clip = F._test && F._test.clip;
  const big = clip ? clip('x'.repeat(1 << 20) + '\nfake log line') : null;
  check('set: a renderer string in a reason or log line is cut to 40 characters on one line', typeof big === 'string' && big.length === 40 && !/\n/.test(big) &&
    clip('tl') === 'tl' && clip({}) === '[object Object]', big && big.length);

  // wk-mantle-focus (2026-10-14): while the PIN box has the input, GetCursorPos fails but Electron
  // still hands back a point, and Task View fired from the top-left corner after every unlock. The
  // cursor source asks GetCursorPos first; FALSE is a failed read, and a failed read never fires.
  const CC = F._test && F._test.checkedCursor;
  check('cursor: checkedCursor is exported for the test', typeof CC === 'function');
  if (typeof CC === 'function') {
    let reads = 0;
    const read = () => { reads++; return { x: 0, y: 0 }; };
    let threw = null;
    try { CC(read, () => () => 0)(); } catch (e) { threw = e.message; }
    check('cursor: GetCursorPos FALSE -> a throw in words, Electron\'s point never used', reads === 0 &&
      threw === 'Windows would not say where it is (GetCursorPos failed: the sign-in or lock screen has the input)', threw);
    reads = 0;
    const okPt = CC(read, () => () => 1)();
    check('cursor: GetCursorPos TRUE -> Electron\'s DIP point, unchanged', reads === 1 && okPt.x === 0 && okPt.y === 0, JSON.stringify(okPt));
    reads = 0;
    let binds = 0;
    const once = CC(read, () => { binds++; return () => 1; });
    once(); once(); once();
    check('cursor: the binding is made once, then reused', binds === 1 && reads === 3, `${binds} binds, ${reads} reads`);
    reads = 0;
    let noKoffi = null;
    try { noKoffi = CC(read, () => { throw new Error('no koffi'); })(); } catch (e) { noKoffi = e.message; }
    check('cursor: no koffi -> Electron\'s point alone, as before (never a throw)', reads === 1 && noKoffi && noKoffi.x === 0, JSON.stringify(noKoffi));
    // The real binding (koffi + user32 GetCursorPos) on this unlocked session: a point, no throw.
    let real = null;
    const realCursor = CC(() => ({ x: 1, y: 2 }));
    try { real = realCursor(); } catch (e) { real = e.message; }
    check('cursor: the real GetCursorPos binds (koffi) and answers TRUE while the session is unlocked', realCursor.checked() === true &&
      real && real.x === 1 && real.y === 2, JSON.stringify(real));
    // The real thing the PIN box does to Mantle: this thread moved onto a scratch desktop that is
    // never switched to (nothing is shown), so it is not on the input desktop, then moved back.
    let offDesk = null;
    try {
      const koffi = require('koffi');
      const u = koffi.load('user32.dll');
      const createDesk = u.func('intptr_t __stdcall CreateDesktopW(str16 n, intptr_t a, intptr_t b, uint32 f, uint32 acc, intptr_t sa)');
      const setDesk = u.func('int __stdcall SetThreadDesktop(intptr_t h)');
      const getDesk = u.func('intptr_t __stdcall GetThreadDesktop(uint32 tid)');
      const closeDesk = u.func('int __stdcall CloseDesktop(intptr_t h)');
      const home = getDesk(koffi.load('kernel32.dll').func('uint32 __stdcall GetCurrentThreadId()')());
      const d = createDesk(`mantle-corners-test-${process.pid}`, 0, 0, 0, 0x0001 | 0x0002, 0);
      offDesk = { made: !!d };
      if (d) {
        try {
          offDesk.moved = setDesk(d) === 1;
          try { offDesk.off = realCursor(); } catch (e) { offDesk.off = 'threw: ' + e.message; }
        } finally {
          offDesk.back = setDesk(home) === 1;
          closeDesk(d);
        }
        try { offDesk.after = realCursor(); } catch (e) { offDesk.after = 'threw: ' + e.message; }
      }
    } catch (e) { offDesk = { error: e.message }; }
    check('cursor: off the input desktop (what the PIN box does) the real read throws, and reads again once back',
      offDesk && offDesk.moved && offDesk.back && /^threw: Windows would not say where it is/.test(String(offDesk.off)) &&
      offDesk.after && offDesk.after.x === 1, JSON.stringify(offDesk));
    const noKoffiCursor = CC(read, () => { throw new Error('no koffi'); });
    noKoffiCursor();
    check('cursor: without koffi it says the answer is not checked', noKoffiCursor.checked() === false);
    // End to end through step(): the read failing on every tick while the "cursor" sits in the
    // top-left never fires, and an earlier dwell in that corner is dropped.
    const TL = { x: 0, y: 0 };
    const fail = (cursorWhy) => [null, { cursorWhy }];
    const after = run([[0, TL], [100, TL], [200].concat(fail('Windows would not say where it is')), [300].concat(fail('x')), [400].concat(fail('x')), [500].concat(fail('x')), [600].concat(fail('x'))]);
    const control = run([[0, TL], [100, TL], [200, TL], [300, TL], [400, TL], [500, TL], [600, TL]]);
    check('cursor: control - the same polls with good reads in the top-left DO fire Task view', control.fires.length === 1 &&
      control.fires[0].action === 'taskview', JSON.stringify(control.firedAt));
    check('cursor: failed reads in the top-left (the PIN box) never fire, the dwell is dropped', after.fires.length === 0, JSON.stringify(after.firedAt));
  }
})().catch((e) => check('the async checks finished', false, e.stack || e.message)).then(() => {
  console.log(`CORNERS TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length || !passed ? 1 : 0);
});

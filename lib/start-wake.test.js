'use strict';
/* start-wake.test.js - start-up and wake (lane mn-wake, 2026-10-12): the countdown, the first ping,
   the desktop layer held hidden until it is under the icons, the desktop picture kept across wakes,
   the sidecar started first and the hover watch waiting for the bar's first place.
   Plain node, no Electron: the rules in lib/start-wake.js are called directly, and the REAL main.js
   functions that use them (askProtocolAge, reshootDesktopBackdrop, the hover start) are cut out of
   main.js and run against fakes. Nothing reaches Windows.   node lib/start-wake.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const W = require('./start-wake');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
let passed = 0, failed = 0;
function ok(cond, what) {
  if (cond) passed++;
  else { failed++; console.log('FAIL ' + what); }
}
/** The top-level function that starts with `head`, up to its closing brace at column 0. */
function topFunction(head) {
  const a = SRC.indexOf(head);
  if (a === -1) return null;
  return SRC.slice(a, SRC.indexOf('\n}', a) + 2);
}
/** Run main.js code in a context of fakes; returns the context (its lets are its globals). */
function load(code, ctx) {
  const c = vm.createContext(Object.assign({ Object, Array, JSON, Error, Math, Number, String, Promise, Date }, ctx));
  vm.runInContext(code, c);
  return c;
}
const tick = () => new Promise((r) => setImmediate(r));

/* ---- the countdown ---------------------------------------------------------------------------- */
{
  const tty = W.countdownVerdict({ live: true, tty: true });
  ok(tty.pause === 3000 && /Ctrl\+C now/.test(tty.line), 'countdown: a live start in a console still pauses 3 s for Ctrl+C');
  const task = W.countdownVerdict({ live: true, tty: false });
  ok(task.pause === 0 && /no console to press Ctrl\+C in/.test(task.line) && /logon task/.test(task.line), `countdown: no console (the logon task): no pause, and the log says why (${task.line})`);
  const und = W.countdownVerdict({ live: true, tty: undefined });
  ok(und.pause === 0, 'countdown: an unknown console (isTTY undefined, as in a GUI start) is no console');
  const test = W.countdownVerdict({ live: false, tty: true });
  ok(test.pause === 0 && test.line === null, 'countdown: a test start never pauses and prints nothing');

  // wiring: the --live guard exits first, the way out is printed before the decision, the pause is the decision's
  const guard = SRC.indexOf("if (!flags.test && !flags.live) {");
  const exit2 = SRC.indexOf('app.exit(2);', guard);
  const rec = SRC.indexOf('mantle: if anything goes wrong, run this and Windows comes back');
  const stateLine = SRC.indexOf('mantle: the original shell state is recorded in ${STATE_FILE}');
  const verdict = SRC.indexOf("countdownVerdict({ live: true, tty: process.stdout.isTTY === true })");
  const pause = SRC.indexOf('if (countdown.pause) sleepSync(countdown.pause);');
  ok(guard > 0 && exit2 > guard && exit2 < rec, 'countdown: the --live guard still exits before anything else');
  ok(rec > 0 && stateLine > rec && verdict > stateLine && pause > verdict, 'countdown: the recovery command and the shell-state line are printed BEFORE the pause is decided');
  ok(!/sleepSync\(3000\)/.test(SRC), 'countdown: no unconditional 3 s pause is left');
  ok(SRC.indexOf('\nif (!app.requestSingleInstanceLock()) {') > pause && SRC.indexOf('app.whenReady().then(') > pause, 'countdown: still decided before the main single-instance lock and before the app is ready');
}

/* ---- the first ping ---------------------------------------------------------------------------- */
{
  const cur = { current: true, dpiAware: true, reason: 'sidecar 0.3.0 speaks the current protocol and is DPI-aware' };
  const old = { current: false, dpiAware: null, reason: 'sidecar exe is older than the protocol: run npm run build:sidecar' };
  const none = { current: false, dpiAware: null, reason: 'the sidecar would not answer ping, so Mantle cannot tell how old it is: timed out after 4000 ms' };
  ok(W.pingVerdict(cur, 0).next === 'go', 'ping: a current answer goes ahead');
  ok(W.pingVerdict(old, 0).next === 'old', 'ping: an exe that ANSWERED too old is final at once');
  ok(W.pingVerdict({ current: false, answered: true, reason: 'x' }, 0).next === 'old', 'ping: answered:true is honoured if protocolAge ever says it');
  const waits = [0, 1, 2].map((n) => W.pingVerdict(none, n));
  ok(waits.every((v) => v.next === 'retry') && waits.map((v) => v.waitMs).join() === '2000,5000,15000', `ping: no answer is asked again at 2, 5 and 15 s (${waits.map((v) => v.waitMs)})`);
  ok(/asking again in 2 s \(ask 2 of 4\)/.test(waits[0].reason) && /Windows is untouched for now/.test(waits[0].reason) && /timed out/.test(waits[0].reason), `ping: the waiting line says what, when and why (${waits[0].reason})`);
  const gave = W.pingVerdict(none, 3);
  ok(gave.next === 'give-up' && /asked 4 times over 22 s/.test(gave.reason) && /would not answer ping/.test(gave.reason), `ping: after four asks it gives up, with the reason (${gave.reason})`);

  // the REAL askProtocolAge from main.js, against a fake sidecar
  const code = 'var protocolAskGen = 0;\n' + topFunction('async function askProtocolAge(');   // var: visible on the context
  const mk = (answers) => {
    const log = [], waited = [], sets = [];
    const c = load(code, {
      StartWake: W, shuttingDown: false, shellPaused: null, desktopWin: { id: 1 },
      desktopHeld: () => true,
      sidecar: { protocolAge: async () => (answers.length > 1 ? answers.shift() : answers[0]) },
      state: { set: (k, v) => sets.push([k, v]) },
      wait: async (ms) => { waited.push(ms); },
      process: { stdout: { write: (s) => log.push(s) } },
    });
    return { c, log, waited, sets };
  };
  (async () => {
    let r = mk([none, cur]);
    let age = await r.c.askProtocolAge();
    ok(age && age.current === true && r.waited.join() === '2000', `askProtocolAge: one slow ping, then an answer: the shell is taken after 2 s (${r.waited})`);
    ok(r.log.some((l) => /answered its ping on ask 2/.test(l)), 'askProtocolAge: the log says it answered on the second ask');
    ok(['taskbar', 'desktop', 'hotkey'].every((k) => r.sets.some(([p, v]) => p === k && /^waiting: |waiting, hidden/.test(v.reason))), 'askProtocolAge: while waiting, the taskbar, desktop and Win key lines say so');
    ok(r.sets.some(([p, v]) => p === 'desktop' && /the desktop layer is waiting, hidden/.test(v.reason)), 'askProtocolAge: a held desktop layer is said to be waiting, hidden');

    r = mk([none]);
    age = await r.c.askProtocolAge();
    ok(age && age.current === false && /asked 4 times over 22 s/.test(age.reason) && r.waited.join() === '2000,5000,15000', `askProtocolAge: never answering ends as before (old-exe baseline), with the reason (${r.waited})`);

    r = mk([old]);
    age = await r.c.askProtocolAge();
    ok(age === old && r.waited.length === 0, 'askProtocolAge: an old exe is not waited on');

    // a newer applyLive (a sidecar restart) supersedes the asking one
    const slow = mk([none, cur]);
    let release;
    slow.c.wait = () => new Promise((res) => { release = res; });
    const first = slow.c.askProtocolAge();
    await tick();
    slow.c.wait = async () => {};
    const second = slow.c.askProtocolAge();
    release();
    ok((await first) === null && (await second).current === true, 'askProtocolAge: a newer ask supersedes the waiting one, which then does nothing');

    // "Put Windows back" while it waits
    const p = mk([none, cur]);
    p.c.wait = async () => { p.c.shellPaused = { why: 'the tray menu' }; };
    ok((await p.c.askProtocolAge()) === null, 'askProtocolAge: a pause while waiting touches nothing afterwards');

    await reshootTests();
    hoverTests();
    wiringTests();
    console.log('START WAKE TEST: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  })().catch((err) => { console.log('FAIL the test threw: ' + (err && err.stack ? err.stack : err)); process.exit(1); });
}

/* ---- the desktop picture ----------------------------------------------------------------------- */
{
  const a = { id: 7, w: 1920, h: 1080 };
  ok(W.desktopReshootVerdict({ last: a, now: { id: 7, w: 1920, h: 1080 } }).reshoot === false, 'reshoot: a wake or a work-area change on the same display keeps the picture');
  ok(/same picture; kept, with no blink/.test(W.desktopReshootVerdict({ last: a, now: a }).reason), 'reshoot: and says why');
  ok(W.desktopReshootVerdict({ last: a, now: { id: 7, w: 2560, h: 1440 } }).reshoot === true, 'reshoot: a resolution change takes it again');
  ok(W.desktopReshootVerdict({ last: a, now: { id: 9, w: 1920, h: 1080 } }).reshoot === true, 'reshoot: a different main display takes it again');
  ok(W.desktopReshootVerdict({ last: null, now: a }).reshoot === true, 'reshoot: no good picture yet (the first one failed) takes it');
  ok(W.desktopReshootVerdict({ last: a, now: null }).reshoot === false, 'reshoot: a display with no size keeps what it has');
  ok(W.desktopReshootVerdict({ last: { w: 1920, h: 1080 }, now: { id: 3, w: 1920, h: 1080 } }).reshoot === false, 'reshoot: an unknown id is not a different display');
}

async function reshootTests() {
  const code = 'var deskShotDisplay = null;\n' + topFunction('async function reshootDesktopBackdrop(');   // var: the test reads and sets it
  const ev = [], log = [];
  let display = { id: 1, w: 1920, h: 1080 };
  let shotOk = true;
  const win = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; },
    hide() { this.visible = false; ev.push('hide'); }, showInactive() { this.visible = true; ev.push('show'); } };
  const c = load(code, {
    desktopWin: win, StartWake: W, backdropQuiet: () => null, setBackdropPiece: () => {},
    mainDisplayPhys: () => display, wait: async () => {},
    desktopBackdrop: { once: async () => { ev.push('shot'); return shotOk; } },
    process: { stdout: { write: (s) => log.push(s) }, stderr: { write: (s) => log.push(s) } },
  });
  c.deskShotDisplay = { id: 1, w: 1920, h: 1080 };   // the start-up picture (showDesktopGated)
  for (const why of ['the PC woke from sleep', 'display metrics changed', 'display metrics changed']) await c.reshootDesktopBackdrop(why);
  ok(ev.length === 0, `reshoot: three wakes and work-area changes on the same display: no hide, no shot, no blink (${ev})`);
  ok(log.filter((l) => /desktop layer: picture kept \(the PC woke from sleep\)/.test(l)).length === 1, 'reshoot: each kept picture is one log line with the reason');
  display = { id: 1, w: 2560, h: 1440 };
  await c.reshootDesktopBackdrop('display metrics changed');
  ok(ev.join() === 'hide,shot,show' && c.deskShotDisplay.w === 2560, `reshoot: a real resolution change hides, shoots and shows once, and remembers the new size (${ev})`);
  ok(log.some((l) => /picture taken again \(display metrics changed\): the main display went from 1920x1080 to 2560x1440/.test(l)), 'reshoot: and says why');
  ev.length = 0;
  await c.reshootDesktopBackdrop('the PC woke from sleep');
  ok(ev.length === 0, 'reshoot: the next wake at the new size keeps it');
  display = { id: 1, w: 1280, h: 720 };
  shotOk = false;
  await c.reshootDesktopBackdrop('display metrics changed');
  ok(c.deskShotDisplay.w === 2560, 'reshoot: a failed shot does not count as a picture of the new size');
  ev.length = 0;
  shotOk = true;
  await c.reshootDesktopBackdrop('display metrics changed');
  ok(ev.join() === 'hide,shot,show', 'reshoot: so the next change tries again');
  // the game gate still comes before any hide (lib/main-rel.test.js pins the same)
  const body = topFunction('async function reshootDesktopBackdrop(');
  ok(body.indexOf("backdropQuiet('the desktop layer')") < body.indexOf('desktopReshootVerdict') && body.indexOf('desktopReshootVerdict') < body.indexOf('desktopWin.hide()'), 'reshoot: game quiet, then the verdict, then the hide');
  // the first picture is remembered too, and "shown" is said only after looking
  const gated = topFunction('function showDesktopGated(');
  ok(/if \(ok\) deskShotDisplay = display;/.test(gated) && /g\.win\.isVisible\(\) \?/.test(gated), 'gated show: the start-up picture is remembered, and "shown" is logged after a visibility check');
}

function hoverTests() {
  const a = SRC.indexOf('const HOVER_START_FALLBACK_MS');
  const b = SRC.indexOf('\n}', SRC.indexOf('function armHoverWatchStart(')) + 2;
  ok(a > 0 && b > a, 'hover: the start helpers are in main.js');
  const timers = [], log = [], bars = [];
  let starts = 0;
  const c = load(SRC.slice(a, b), {
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    startHoverWatch: () => { starts++; }, setBar: (p) => bars.push(p), barReason: (s) => s,
    process: { stdout: { write: (s) => log.push(s) } },
  });
  c.armHoverWatchStart();
  ok(starts === 0 && timers.length === 1 && timers[0].ms === 8000, 'hover: a live start does not watch the edge yet, with an 8 s fallback armed');
  ok(bars.length === 1 && bars[0].ok === true && /waiting for its first place/.test(bars[0].reason), 'hover: the bar line says it is waiting for its first place');
  c.startHoverWatchOnce('the bar has its first place on screen');
  c.startHoverWatchOnce('the bar has its first place on screen');
  ok(starts === 1 && timers[0].cleared, 'hover: the first placement starts it once and clears the fallback');
  ok(log.filter((l) => /hover watch started: the bar has its first place/.test(l)).length === 1, 'hover: said once in the log');
  timers[0].fn();
  ok(starts === 1, 'hover: a late fallback does not start it twice');
  // the fallback alone (an old exe, a paused shell, a sidecar that never answers)
  const t2 = [], l2 = [];
  let s2 = 0;
  const d = load(SRC.slice(a, b), {
    setTimeout: (fn, ms) => { const t = { fn, ms }; t2.push(t); return t; }, clearTimeout: () => {},
    startHoverWatch: () => { s2++; }, setBar: () => {}, barReason: (s) => s, process: { stdout: { write: (s) => l2.push(s) } },
  });
  d.armHoverWatchStart();
  t2[0].fn();
  ok(s2 === 1 && l2.some((l) => /had not placed the bar after 8 s, so it answers the edge anyway/.test(l)), 'hover: no placement in 8 s starts it anyway, saying why');
}

function wiringTests() {
  // the sidecar starts first in whenReady, once
  // The start-up whenReady is the one that starts the sidecar; main.js has others (e.g. the
  // resume/unlock re-reader, lane mn-recover), so the first match is not necessarily it.
  let wr = -1;
  for (let i = SRC.indexOf('app.whenReady().then(() => {'); i >= 0; i = SRC.indexOf('app.whenReady().then(() => {', i + 1)) {
    if (SRC.slice(i, SRC.indexOf('\n});', i)).includes('sidecar.start();')) { wr = i; break; }
  }
  if (wr < 0) throw new Error('main.js has no app.whenReady block that starts the sidecar');
  const body = SRC.slice(wr, SRC.indexOf('\n});', wr));
  const firstCode = body.split('\n').slice(1).map((l) => l.trim()).find((l) => l && !l.startsWith('//'));
  ok(firstCode === 'sidecar.start();', `whenReady: the sidecar starts first (${firstCode})`);
  ok((body.match(/^\s*sidecar\.start\(\);/gm) || []).length === 1, 'whenReady: and only once');
  ok(!/\bawait\b/.test(body.replace(/\/\/.*$/gm, '')), 'whenReady: no await in its body, so every ready listener is in place before the ready line can be read');
  // the start-up layer is held hidden live, as the Explorer-restart one is
  ok(body.includes("makeDesktopWindow('the desktop layer is starting', !flags.test || holdTest);") && /const holdTest = flags\.test && ARGV\.includes\('--test-desktop-hold'\);/.test(body),
    'desktop: the start-up layer is held hidden until it is under the icons (live; a test run only with --test-desktop-hold)');
  ok(SRC.includes("makeDesktopWindow('Explorer restarted: a new desktop layer', !flags.test)"), 'desktop: the Explorer-restart layer still is');
  // applyLive: ping, then the desktop, then the taskbar
  const al = topFunction('async function applyLive(');
  const iPing = al.indexOf('await askProtocolAge()');
  const iDesk = al.indexOf('await attachDesktop()');
  const iTask = al.indexOf("sidecar.call('taskbar', { mode: 'autohide' })");
  ok(iPing > 0 && iDesk > iPing && iTask > iDesk, `applyLive: the protocol check, then the desktop layer, then the taskbar (${iPing}, ${iDesk}, ${iTask})`);
  ok((al.match(/await attachDesktop\(\)/g) || []).length === 1, 'applyLive: the desktop layer is attached in one place');
  ok(/else if \(held && desktopHeld\(desktopWin\)\) scheduleDesktopAttach\(0, false, 'at start'\);/.test(al), 'applyLive: a held layer that could not go under is tried again, never shown');
  ok(/startHoverWatchOnce\(/.test(al) && al.indexOf('startHoverWatchOnce(') > al.indexOf("placeBottomStrip('startup'"), 'applyLive: the hover watch starts after the first placement');
  // applyMode: the glass and the tray poll survive a throw in applyLive
  const am = topFunction('async function applyMode(');
  ok(/try \{ await applyLive\(\); \} catch \(err\) \{ liveErr = err; \}/.test(am) && /finally \{ startTrayPoll\(\); \}/.test(am) && /if \(liveErr\) throw liveErr;/.test(am), 'applyMode: a throw in applyLive still gets the glass and the tray poll, and is still reported');
  // the give-up at start says "at start", not "after Explorer restarted"
  const gu = topFunction('function desktopGiveUp(');
  const E = load(gu, {});
  const st = [];
  E.desktopGiveUp({ win: null, clear() {}, releaseWallpaper() {}, stopRecheck() {}, setState: (v) => st.push(v), log: (l) => st.push(l), tries: 6, why: 'no Progman window', when: 'at start' });
  ok(/could not go under the icons at start \(6 tries: no Progman window\), so Windows' own wallpaper shows/.test(st[0].reason) && /could not go under the icons at start after 6 tries, so it was closed \(never shown over the apps\)/.test(st[1]), `give-up at start: says when, and that it was never shown (${st[0].reason})`);
}

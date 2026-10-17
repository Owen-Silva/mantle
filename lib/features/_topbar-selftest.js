'use strict';
/*
 * _topbar-selftest.js - the top bar proving itself inside an Electron --test instance
 * (MANTLE_TOPBAR_SELFTEST=1; loaded only by lib/features/topbar.js, and only in --test).
 *
 * WHAT IT DRIVES: the page's own bridge (window.mantle.call inside the bar's page, through preload
 * and main's command table - the path a click takes), the real passive sidecar (reads everything,
 * writes nothing of Owen's), and the feature's event handler fed a FAKE focus snapshot for the
 * game rules (no game has to run).
 *
 * WHAT IT MOVES: one window it creates itself for the full-screen measurement - opacity 0 (never
 * visible), focusable:false (WS_EX_NOACTIVATE), shown inactive, sent to the bottom of the z-order,
 * destroyed after ~4 s. The foreground window's HANDLE is read before and after every step and the
 * run fails if it ever changed. No titles of Owen's windows are read or written anywhere.
 *
 * Results: one line in mantle.log and %TEMP%\mantle-topbar\selftest.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.join(os.tmpdir(), 'mantle-topbar', 'selftest.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let halt = false;

function start(k) {
  const { ctx, S, screen, BrowserWindow, hwndOf, thumbs, BAR_DIP } = k;
  // PEEK (lane tbpeek): Owen's REAL cursor never drives this instance's peek. From the first moment a
  // FAKE cursor (parked mid-screen) and FAKE mouse buttons (all up) stand in; peekSection moves them.
  const fake = { pt: null, btn: { ok: true, held: false, pressed: false }, cursorErr: null, reads: 0, btnReads: 0 };
  if (k.peekSource) {
    k.peekSource({
      cursor: () => {
        fake.reads++;
        if (fake.cursorErr) throw new Error(fake.cursorErr);
        if (fake.pt) return fake.pt;
        const b = screen.getPrimaryDisplay().bounds;
        return { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) };
      },
      buttons: () => { fake.btnReads++; return fake.btn; },
    });
  }
  (async () => {
    const checks = [];
    const measured = {};
    const check = (name, ok, detail) => checks.push(ok ? { name, ok: true } : { name, ok: false, detail: String(detail) });
    const page = (js) => S.win.webContents.executeJavaScript(js, true);
    const call = (name, args) => page(`window.mantle.call(${JSON.stringify(name)}, ${JSON.stringify(args || {})})`).catch((e) => ({ ok: false, reason: 'threw: ' + e.message }));
    const fgNow = async () => { const r = await ctx.sidecar.send('topbar.focus', { menu: false }, { timeoutMs: 3000 }); return r.ok ? r.result.hwnd : null; };
    const ours = new Set();
    const fgBad = [];
    const fgCheck = async (when) => { const h = await fgNow(); if (h && ours.has(h)) fgBad.push(when); };
    const until = async (fn, ms) => { const t0 = Date.now(); while (!halt && Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); } return !!fn(); };

    // PERSISTENCE (lane tbvideo): a run started after one that left the bar hidden by hand
    // (MANTLE_TOPBAR_SELFTEST_EXPECT_HIDDEN=1) finds it hidden from the start, then shows it and goes on.
    if (process.env.MANTLE_TOPBAR_SELFTEST_EXPECT_HIDDEN === '1') {
      await until(() => S.pageOk && S.watch.ok && S.stepKind === 'hidden', 15000);
      const was = { hidden: S.hidden, kind: S.stepKind, vis: S.win.isVisible(), stats: S.stats_, guard: S.guard.ok, reserved: S.reserve.reserved };
      check('hide persists: after a restart the bar starts hidden by hand (not shown, stats off, drag guard off, no strip)',
        was.hidden && was.kind === 'hidden' && !was.vis && was.stats.on === false && was.guard === false && was.reserved === false, JSON.stringify(was));
      await until(() => S.peek.watching && S.peek.ok !== null, 3000);   // the watch starts at the end of apply()
      check('hide persists: the top edge is watched for a peek from the start (the fake cursor), and the watch works',
        S.peek.watching && S.peek.src.fake && S.peek.ok === true, JSON.stringify({ watching: S.peek.watching, fake: S.peek.src.fake, ok: S.peek.ok, reason: S.peek.reason }));
      const sh = await call('topbar.hidden', { on: false, via: 'the self-test' });
      await until(() => !S.stepAside && S.win.isVisible() && S.guard.ok, 4000);
      check('hide persists: shown again, the setting is cleared', sh.ok && !S.hidden && ctx.settings.get('hidden', null) === false && S.win.isVisible(), JSON.stringify(sh));
    }
    await until(() => S.pageOk && S.watch.ok && S.guard.ok, 20000);
    if (halt) return;
    ours.add(S.hwnd);
    check('page loaded, focus watch and drag guard on', S.pageOk && S.watch.ok && S.guard.ok, JSON.stringify({ page: S.pageReason, watch: S.watch, guard: S.guard }));
    const fg0 = await fgNow();

    // the window
    const b = S.win.getBounds(), p = screen.getPrimaryDisplay().bounds;
    check('window: titled exactly "Mantle top bar"', S.win.getTitle() === 'Mantle top bar', S.win.getTitle());
    const shaped = (h) => S.shape && S.shape.ok && S.shape.shown === h && (S.shape.window === h || S.shape.window > h);
    check('window: 28 DIP across the top of the primary display (cropped by a shape if Windows made it taller)',
      b.x === p.x && b.y === p.y && b.width === p.width && shaped(BAR_DIP), JSON.stringify({ b, shape: S.shape }));
    measured.windowHeight = { asked: BAR_DIP, got: b.height, shape: S.shape };
    check('window: not topmost and nothing reserved in --test', !S.win.isAlwaysOnTop() && S.reserve.reserved === false, JSON.stringify(S.reserve));

    // events reach the page
    await until(() => false, 300);
    const t = await page('({ focus: !!(window.__topbar.focus), stats: !!(window.__topbar.stats && window.__topbar.stats.cpu), titles: window.__topbar.titles.length })');
    await until(() => !!S.stats, 4000);
    const t2 = await page('({ stats: !!(window.__topbar.stats && window.__topbar.stats.cpu), cells: document.querySelectorAll("#right .st").length })');
    check('page: the focused app arrived (hello / topbar.focus) and titles rendered', t.focus && t.titles >= 2, JSON.stringify(t));
    check('page: a system sample arrived (topbarstats -> topbar.stats)', t2.stats, JSON.stringify(t2));
    measured.statCells = t2.cells;

    // the page's commands, through the real bridge
    const lock = await call('topbar.power', { action: 'lock' });
    check('power: Lock is a dry run in --test', lock.ok && lock.dryRun, JSON.stringify(lock));
    const rs = await call('topbar.power', { action: 'restart' });
    check('power: Restart refuses without the second click', rs.ok === false && /asks first/.test(rs.reason), JSON.stringify(rs));
    const rs2 = await call('topbar.power', { action: 'restart', confirmed: true });
    check('power: Restart confirmed is still only a dry run', rs2.ok && rs2.dryRun, JSON.stringify(rs2));
    for (const v of ['taskmgr', 'settings', 'winSettings']) { const r = await call('topbar.' + v); check(`${v}: dry run`, r.ok && r.dryRun, JSON.stringify(r)); }
    const nw = await call('topbar.newWindow', { exe: 'C:\\Windows\\explorer.exe', args: [] });
    check('newWindow: File Explorer is a dry run', nw.ok && nw.dryRun, JSON.stringify(nw));
    const nwBad = await call('topbar.newWindow', { exe: 'C:\\Windows\\explorer.exe', args: ['/e,C:\\'] });
    check('newWindow: arguments that are not the known table are refused', nwBad.ok === false, JSON.stringify(nwBad));
    // the page may only name the app it was given (lib/features/topbar.js checkArgs): main's own focus
    const stF = await call('topbar.status');
    const fgApp = (stF && stF.focus && stF.focus.hwnd) || fg0;
    const wBad = await call('topbar.window', { hwnd: '12345', action: 'minimize' });
    check('window action on a window the page was never given: refused in plain words', wBad.ok === false && /no longer the app in front/.test(wBad.reason), JSON.stringify(wBad));
    const wAct = await call('topbar.window', { hwnd: fgApp, action: 'format-c' });
    check('window action outside the fixed list: refused', wAct.ok === false && /does not know that window action/.test(wAct.reason), JSON.stringify(wAct));
    const wmin = await call('topbar.window', { hwnd: fgApp, action: 'minimize' });
    check('window action on the foreground app: dry run only', wmin.ok && wmin.dryRun === true, JSON.stringify(wmin));
    const inv = await call('topbar.invoke', { hwnd: fgApp, item: 1 });
    check('invoke on an app of Owen\'s: refused (passive), with a reason', inv.ok === false && !!inv.reason, JSON.stringify(inv));
    const ui = await call('topbar.uiaInvoke', { hwnd: fgApp, path: [0], names: ['File'] });
    check('uiaInvoke: never in --test', ui.ok === false && /never runs/.test(ui.reason), JSON.stringify(ui));
    const sd = await call('topbar.statsDetail', { kind: 'cpu' });
    check('statsDetail: the sampler adds top processes', sd.ok !== false, JSON.stringify(sd));
    const ab = await call('topbar.about');
    check('about: one line about Mantle and the machine', ab.ok && /^Mantle /.test(ab.text), JSON.stringify(ab));
    await fgCheck('after the commands');

    // a menu open grows the window, closing shrinks it; nothing is focused in --test
    const mo = await call('topbar.menuState', { open: true, height: 300 });
    const hOpen = S.win.getBounds().height;
    const mc = await call('topbar.menuState', { open: false, refocus: true });
    const hShut = S.win.getBounds().height;
    check('menuState: open grows to the menu, close shrinks to 28 (shape), no refocus in --test', mo.ok && hOpen === 300 && mc.ok && shaped(BAR_DIP) && mc.refocused === false,
      JSON.stringify({ mo, hOpen, mc, hShut, shape: S.shape }));

    // games step aside (a FAKE focus snapshot; the verdict itself is proven in sidecar/test-topbar.js)
    const real = S.focus;
    const game = { kind: 'focus', hwnd: '424242', self: false, exe: 'C:\\x\\VALORANT-Win64-Shipping.exe', desc: 'VALORANT', fullscreen: true,
      game: { stepAside: true, signal: 'selftest: a fake Valorant, borderless' } };
    k.onTopbar(game);
    await until(() => S.stepAside && !S.win.isVisible(), 1500);
    await sleep(300);
    const pz = await page('window.__topbar.paused');
    check('game: the bar steps aside (hidden), its stats pause, the signal is kept', S.stepAside && !S.win.isVisible() && S.stats_.on === false && /fake Valorant/.test(S.stepSignal) && !!pz,
      JSON.stringify({ step: S.stepAside, vis: S.win.isVisible(), stats: S.stats_, pz }));
    const og = await call('topbar.overGames', { on: true });
    check('game: "keep the bar over full-screen games" brings it back', og.ok && og.stepAside === false && S.win.isVisible(), JSON.stringify(og));
    const og2 = await call('topbar.overGames', { on: false });
    check('game: switching that off steps aside again', og2.ok && og2.stepAside === true && !S.win.isVisible(), JSON.stringify(og2));
    k.onTopbar(Object.assign({}, real || { kind: 'focus', hwnd: '0', self: false }, { kind: 'focus', game: { stepAside: false } }));
    await until(() => !S.stepAside && S.win.isVisible() && S.stats_.on, 3000);
    check('game: the game leaving the foreground brings the bar and its stats back', !S.stepAside && S.win.isVisible() && S.stats_.on, JSON.stringify({ step: S.stepAside, stats: S.stats_ }));
    await fgCheck('after the game rules');

    // the lock screen: always steps aside, even with "keep over games" on (a FAKE focus snapshot)
    k.onTopbar({ kind: 'focus', hwnd: '434343', self: false, exe: 'C:\\Windows\\SystemApps\\Microsoft.LockApp_cw5n1h2txyewy\\LockApp.exe', desc: 'LockApp.exe',
      fullscreen: true, game: { stepAside: false } });
    await until(() => S.stepAside && !S.win.isVisible(), 1500);
    const lk = { step: S.stepAside, vis: S.win.isVisible(), signal: S.stepSignal, cover: S.cover };
    const lkOg = await call('topbar.overGames', { on: true });
    const lkStill = S.stepAside && !S.win.isVisible();
    await call('topbar.overGames', { on: false });
    check('lock screen: LockApp.exe in front hides the bar (no "stays over its top 28 DIP"), even with "keep over games" on',
      lk.step && !lk.vis && /LockApp\.exe is in front/.test(lk.signal || '') && !lk.cover && lkOg.ok && lkStill, JSON.stringify({ lk, lkOg, lkStill }));
    k.onTopbar(Object.assign({}, real || { kind: 'focus', hwnd: '0', self: false }, { kind: 'focus', game: { stepAside: false } }));
    await until(() => !S.stepAside && S.win.isVisible() && S.stats_.on, 3000);
    check('lock screen: unlocking (another app in front) brings the bar back', !S.stepAside && S.win.isVisible(), JSON.stringify({ step: S.stepAside }));

    // FULL-SCREEN VIDEO and MANUAL HIDE (lane tbvideo): FAKE focus snapshots and a FAKE media session
    try { await videoAndHide(k, check, until, call, page, real); } catch (e) { check('video / hide: the run finished', false, e.stack || e.message); }
    finally { S.holdReal = false; }
    await fgCheck('after video and hide');

    // PEEK while hidden by hand (lane tbpeek): the FAKE cursor and buttons, FAKE focus snapshots
    try { await peekSection(k, check, until, call, page, real, fake); } catch (e) { check('peek: the run finished', false, e.stack || e.message); }
    finally { S.holdReal = false; }
    await fgCheck('after the peek');

    // THE TWO SMALL TOOLS (lane tbtools): the timer on a FAKE clock, the notes in a TEMP folder
    try { await toolsSection(k, check, until, call, page, fake); } catch (e) { check('tools: the run finished', false, e.stack || e.message); }
    finally { S.holdReal = false; }
    await fgCheck('after the tools');

    // KNOWN GAMES RUNNING (valofix): a STAND-IN process named by MANTLE_TOPBAR_TEST_GAME, never a game
    if (process.env.MANTLE_TOPBAR_TEST_GAME) {
      try { await gameProcess(k, check, until, call, real); } catch (e) { check('game process: the run finished', false, e.stack || e.message); }
      await fgCheck('after the game process');
    }

    // DROPDOWNS (Owen 2026-09-25: pressing a stat showed "a thin grey strip"): open each through the page
    try { await dropdowns(k, page, check, measured, until); } catch (e) { check('dropdowns: the run finished', false, e.stack || e.message); }
    await fgCheck('after the dropdowns');

    // DRIFT (lane tbdrift): no resize handles on the bar; a window moved by something else is put back and never given up on
    try { await driftSection(k, check, until, call); } catch (e) { check('drift: the run finished', false, e.stack || e.message); }
    await fgCheck('after the drift checks');

    // MEASUREMENT: borderless full screen (Chromium, as in a browser's F11 or video full screen) moved below the bar
    try { measured.fullscreen = await measureFullscreen(k, ours); } catch (e) { measured.fullscreen = { error: e.message }; }
    await fgCheck('after the full-screen measurement');

    // PERSISTENCE, first half: leave the bar hidden by hand so the next run can find it so
    if (process.env.MANTLE_TOPBAR_SELFTEST_LEAVE_HIDDEN === '1') {
      const lh = await call('topbar.hidden', { on: true, via: 'the self-test (left hidden for the restart check)' });
      check('hide persists: left hidden by hand, written to the settings file', lh.ok && S.hidden && ctx.settings.get('hidden', null) === true, JSON.stringify(lh));
    }
    // DISPLAY CHANGES and SESSION END (lane mn-topbar): the feature's own display handlers, fed FAKE events
    if (k.display) {
      try { await displaySection(k, check, until); } catch (e) { check('display: the run finished', false, e.stack || e.message); }
      await fgCheck('after the display checks');
    }
    const fg1 = await fgNow();
    check('the foreground never became a window of this test', fgBad.length === 0 && !ours.has(fg1), fgBad.join('; '));
    const passed = checks.filter((c) => c.ok).length, failed = checks.length - passed;
    const line = `selftest: ${passed} passed, ${failed} failed; ${failed ? 'FAIL ' + checks.filter((c) => !c.ok).map((c) => c.name + ' (' + c.detail + ')').join(' | ') : 'all green'}`;
    ctx.log(line);
    ctx.log(`selftest measured: ${JSON.stringify(measured)}`);
    // notesToken: the made-up note text the tools section typed; NOT in the log line above, so a runner
    // can grep the log for it and prove note text never reaches a log (lane tbtools)
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), passed, failed, checks, measured, notesToken: measuredToken.value }, null, 1)); } catch (_) { /* the log line has it */ }
  })().catch((e) => ctx.log(`selftest threw: ${e.stack || e.message}`));
}

/* THE TWO SMALL TOOLS (lane tbtools, 2026-09-27). The timer (lib/features/timer.js) and the notes
 * (lib/features/notes.js) put TEST hooks on lib/features/_tools-hub.js in a --test instance only.
 * The timer runs on a FAKE clock (never waits minutes) and its done pop-up is never shown or heard
 * (hidden window, muted chime, the beep counted not played); the notes live in a TEMP folder
 * (MANTLE_NOTES_DIR, never Documents) and the pad is never shown or focused. Everything the bar does
 * goes through its own page (the path a click takes). */
async function toolsSection(k, check, until, call, page, fake) {
  const { S, ctx, screen } = k;
  const hub = require('./_tools-hub');
  const T = hub.test.timer, N = hub.test.notes;
  check('tools: the timer and notes features put their test hooks up (both installed in this instance)', !!T && !!N, JSON.stringify({ timer: !!T, notes: !!N }));
  const cell = () => page('(() => { const b = document.querySelector(".tool.tm"); return b ? { text: b.querySelector(".v").textContent, cls: b.className, tick: !!window.__topbar.tickT } : { text: null, tick: !!window.__topbar.tickT, icon: !!document.querySelector(".tool[data-tool=timer]") }; })()');
  if (T) {
    const real0 = Date.now();
    let fakeNow = real0;
    T.now(() => fakeNow);
    try {
      await call('timer.cancel');
      const idle = await cell();
      check('timer: idle, the bar shows only the icon and nothing ticks', idle.text === null && idle.icon && !idle.tick, JSON.stringify(idle));
      const st = await call('timer.start', { ms: 25 * 60000 });
      check('timer: timer.start {25 min} from the bar\'s page runs, ending 25 min on (fake clock)', st && st.ok !== false && st.kind === 'timer' && st.endAt === fakeNow + 25 * 60000, JSON.stringify(st));
      fakeNow += 6 * 60000 + 18000;
      const pz = await call('timer.pause');
      await until(() => false, 300);
      const c1 = await cell();
      check('timer: paused 6:18 in, the bar shows 18:42 muted with the pause glyph and does not tick', c1.text === '18:42' && /\bpz\b/.test(c1.cls) && !c1.tick, JSON.stringify({ c1, pz }));
      await call('timer.resume');
      await until(() => false, 300);
      const c2 = await cell();
      check('timer: resumed, the bar counts again from 18:42 (a tick armed)', (c2.text === '18:42' || c2.text === '18:41') && c2.tick, JSON.stringify(c2));
      await until(() => false, 1300);
      const c3 = await cell();
      check('timer: one second later the bar says 18:41 (or 18:40): it ticks once a second', c3.text === '18:41' || c3.text === '18:40', JSON.stringify(c3));

      // hidden by hand, the PEEK (fake cursor on the top edge) shows the bar - and so the time
      const b = screen.getPrimaryDisplay().bounds;
      const AWAY = { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) };
      // a plain maximised app in front, as the peek section does: Owen's REAL front window (a full
      // screen video, a game) would rightly block the peek and make this check depend on his desktop
      const realFocus = S.focus, holdWas = S.holdReal;
      S.holdReal = true;
      k.onTopbar({ kind: 'focus', hwnd: '717171', self: false, shell: false, exe: 'C:\\Windows\\System32\\notepad.exe', desc: 'Notepad',
        fullscreen: false, zoomed: true, game: { stepAside: false } });
      fake.pt = AWAY; fake.btn = { ok: true, held: false, pressed: false };
      await call('topbar.hidden', { on: true, via: 'the self-test (tools)' });
      await until(() => S.hidden && !S.win.isVisible() && S.peek.watching, 4000);
      // the watch must SEE the cursor away first (a bar hidden with the cursor on the edge waits for it
      // to leave): two polls of the fake cursor, then onto the edge
      const r0 = fake.reads;
      await until(() => fake.reads >= r0 + 2, 2000);
      fake.pt = { x: AWAY.x, y: b.y };
      const peeked = await until(() => S.peek.shown && S.win.isVisible(), 5000);
      await until(() => false, 1200);
      const c4 = await cell();
      check('timer: hidden by hand, the peek shows the bar with the running time in it', peeked && /^1[78]:\d\d$/.test(c4.text || '') && c4.tick,
        JSON.stringify({ peeked, c4, peek: { shown: S.peek.shown, watching: S.peek.watching, ok: S.peek.ok, reason: S.peek.reason, blocked: S.peek.blocked, curWhy: S.peek.curWhy, btnWhy: S.peek.btnWhy } }));
      fake.pt = AWAY;
      await call('topbar.hidden', { on: false, via: 'the self-test (tools)' });
      await until(() => !S.hidden && S.win.isVisible(), 4000);
      if (realFocus) k.onTopbar(Object.assign({}, realFocus, { kind: 'focus', game: { stepAside: false } }));
      S.holdReal = holdWas;

      // the timer's menu from its button: the window grows to it, Escape shrinks it back
      await page('document.querySelector(".tool[data-tool=timer]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
      const grew = await until(() => S.menu.open && S.menu.height > 100, 3000);
      const rows = await page('[...document.querySelectorAll(".dd .r .lb, .dd .info")].map((e) => e.textContent)');
      check('timer: its menu opens under the button (Pause, Add 5 minutes, Cancel timer) and the window grows to it',
        grew && rows.includes('Pause') && rows.includes('Add 5 minutes') && rows.includes('Cancel timer'), JSON.stringify({ grew, rows, menu: S.menu }));
      await page('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      check('timer: Escape closes it and the window is the 28 DIP bar again', await until(() => !S.menu.open && S.menu.height === k.BAR_DIP, 3000), JSON.stringify(S.menu));

      // AT ZERO: done, a pop-up (hidden in --test), no sound in a test
      const beeps0 = T.beeps();
      T.fire();
      const done = await until(() => { const v = T.view(); return v.kind === 'idle' && v.done && v.done.popup === 'shown'; }, 4000);
      const pop = T.popup();
      let text = '';
      if (pop && !pop.isDestroyed()) {
        await until(() => !pop.webContents.isLoading(), 4000);
        await until(() => false, 400);
        text = await pop.webContents.executeJavaScript('document.body.innerText', true).catch((e) => 'threw ' + e.message);
      }
      check('timer: at zero, the done pop-up says "Timer done: 25 min" (a window made for it, never shown in --test)',
        done && pop && !pop.isDestroyed() && !pop.isVisible() && /Timer done: 25 min/.test(text), JSON.stringify({ done, text, vis: pop && !pop.isDestroyed() && pop.isVisible() }));
      check('timer: no sound in a test: the chime is muted and no beep ran', T.beeps() === beeps0, String(T.beeps() - beeps0));
      const c5 = await cell();
      check('timer: after zero the bar is back to the icon and nothing ticks', c5.text === null && !c5.tick, JSON.stringify(c5));
      await call('timer.dismiss');
      check('timer: Dismiss closes the pop-up (its window destroyed)', await until(() => !T.popup() || T.popup().isDestroyed(), 3000));

      // DURING A GAME (Mantle resting): no window at all, one beep (counted), the pop-up after the game
      await call('timer.start', { ms: 5 * 60000 });
      T.setResting('VALORANT.exe runs');
      T.fire();
      await until(() => T.view().held === true, 3000);
      const v1 = T.view();
      check('timer: ended during a game: held, beeped once (counted, not played in --test), NO window',
        v1.held === true && v1.done && v1.done.popup === 'held' && !T.popup() && T.beeps() === beeps0 + 1, JSON.stringify({ v1, beeps: T.beeps() - beeps0, pop: !!T.popup() }));
      T.setResting(null);
      const after = await until(() => T.popup() && !T.popup().isDestroyed() && T.view().held === false, 4000);
      let t2 = '';
      if (after) { await until(() => !T.popup().webContents.isLoading(), 4000); await until(() => false, 400); t2 = await T.popup().webContents.executeJavaScript('document.body.innerText', true).catch(() => ''); }
      check('timer: the game over, the held pop-up shows and names the game', after && /Timer done: 5 min/.test(t2) && /VALORANT/.test(t2), JSON.stringify({ after, t2 }));
      await call('timer.dismiss');

      // RESTART: a timer whose end passed while Mantle was off fires ONCE at start, with those words
      T.restore({ kind: 'timer', endAt: fakeNow - 90000, totalMs: 15 * 60000, label: '15 min', startedAt: fakeNow - 16.5 * 60000 });
      const off = await until(() => T.popup() && !T.popup().isDestroyed(), 4000);
      let t3 = '';
      if (off) { await until(() => !T.popup().webContents.isLoading(), 4000); await until(() => false, 400); t3 = await T.popup().webContents.executeJavaScript('document.body.innerText', true).catch(() => ''); }
      check('timer: restored after its end, it fires once with "while Mantle was off"', off && /15 min/.test(t3) && /while Mantle was off/i.test(t3), JSON.stringify({ off, t3 }));
      await call('timer.dismiss');
      await until(() => !T.popup() || T.popup().isDestroyed(), 3000);
      T.restore(ctx.settings && require('fs').existsSync(path.join(path.dirname(ctx.settings.file), 'timer.json'))
        ? JSON.parse(require('fs').readFileSync(path.join(path.dirname(ctx.settings.file), 'timer.json'), 'utf8')).clock : { kind: 'idle' });
      await until(() => false, 600);
      check('timer: the saved state after firing is idle: a second start fires nothing', !T.popup() && T.view().kind === 'idle', JSON.stringify(T.view()));

      // the stopwatch counts UP in the same cell
      await call('timer.stopwatch');
      await until(() => false, 300);
      const c6 = await cell();
      check('timer: the stopwatch shows 0:00 counting up', c6.text === '0:00' && / up\b|\bup\b/.test(c6.cls) && c6.tick, JSON.stringify(c6));
      await call('timer.cancel');
    } finally { T.now(null); }
  }

  if (N) {
    const dir = String(N.dir || '');
    check('notes: the folder is a temp one, never Documents', !!dir && !/\\documents\\/i.test(dir + '\\') && dir.toLowerCase().startsWith(os.tmpdir().toLowerCase()), dir);
    const icon = () => page('(() => { const b = document.querySelector(".tool[data-tool=notes]"); return b ? b.className : null; })()');
    // the button on the bar: notes.toggle, the pad "opens" (never shown or focused in --test), the icon shows it
    await page('document.querySelector(".tool[data-tool=notes]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
    const opened = await until(() => N.state().open === true, 5000);
    await until(() => false, 300);
    const i1 = await icon();
    const w = N.win();
    check('notes: the bar\'s button opens the pad (a window, hidden in --test) and shows pressed',
      opened && /\bopen\b/.test(i1 || '') && w && !w.isDestroyed() && !w.isVisible(), JSON.stringify({ opened, i1, st: N.state(), vis: w && !w.isDestroyed() && w.isVisible() }));
    // typing autosaves (debounced) to notes.md in the temp folder
    const TOKEN = 'selftest-note-' + Date.now().toString(36);
    if (w && !w.isDestroyed()) {
      await until(() => !w.webContents.isLoading(), 4000);
      await w.webContents.executeJavaScript(`(() => { const t = document.querySelector('textarea'); t.value = ${JSON.stringify('Chem lab\\n' + TOKEN)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`, true);
    }
    const file = path.join(dir, 'notes.md');
    const saved = await until(() => { try { return fs.readFileSync(file, 'utf8').includes(TOKEN); } catch (_) { return false; } }, 5000);
    check('notes: typing is saved to notes.md in the temp folder within the debounce, no tmp file left behind',
      saved && !fs.readdirSync(dir).some((f) => /\.tmp/.test(f)), JSON.stringify({ saved, files: fs.existsSync(dir) ? fs.readdirSync(dir) : null }));
    measuredToken.value = TOKEN;   // the runner greps the log for it afterwards: note text never reaches a log
    // the chord toggles it closed (routed exactly as the hook would), and the icon lets go
    const fr = ctx.test ? ctx.test.fireChord('Win+Alt+N') : { delivered: false, reason: 'no ctx.test' };
    const closed = await until(() => N.state().open === false, 4000);
    await until(() => false, 300);
    const i2 = await icon();
    check('notes: Win+Alt+N (fired through the chord router) closes it again and the icon lets go',
      fr && fr.delivered && closed && !/\bopen\b/.test(i2 || ''), JSON.stringify({ fr, closed, i2 }));
  }
}
const measuredToken = { value: null };

/* KNOWN GAMES RUNNING (valofix, 2026-09-26). A stand-in exe - compiled here, named by
 * MANTLE_TOPBAR_TEST_GAME, no window at all, exits by itself after 90 s - is started and killed BY
 * PID; topbar.js counts that name as a known game only in --test. Proves: the bar steps aside from
 * the process alone (no window, no focus event), stays aside through a focus change and through
 * "keep over games", and comes back when the process exits - with a plain log line each way. */
let standin = null;
const STANDIN_CS = 'class P { static void Main() { System.Threading.Thread.Sleep(90000); } }';
async function gameProcess(k, check, until, call, real) {
  const { ctx, S } = k;
  const cp = require('child_process');
  const name = String(process.env.MANTLE_TOPBAR_TEST_GAME).split(',')[0].trim();
  if (!/^[\w.-]+\.exe$/i.test(name) || /^(valorant|riot|roblox|minecraft|javaw|java)/i.test(name)) {
    check('game process: the stand-in name is a plain made-up exe name (never a real game\'s)', false, name);
    return;
  }
  const dir = path.join(os.tmpdir(), 'mantle-topbar');
  const exe = path.join(dir, name);
  if (!fs.existsSync(exe)) {
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'standin.cs');
    fs.writeFileSync(src, STANDIN_CS);
    const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    const r = cp.spawnSync(csc, ['/nologo', '/target:winexe', `/out:${exe}`, src], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) { check('game process: the stand-in compiled', false, (r.stdout || '') + (r.stderr || '')); return; }
  }
  const logs = [];
  const origLog = ctx.log;
  ctx.log = (t) => { logs.push(String(t)); origLog(t); };
  try {
    check('game process: no stand-in is running before the test, and the bar is back', !S.run && !S.stepAside && S.win.isVisible(), JSON.stringify({ run: S.run, step: S.stepAside }));
    const t0 = Date.now();
    standin = cp.spawn(exe, [], { windowsHide: true, detached: false, stdio: 'ignore' });
    const pid = standin.pid;
    // Waits for the WHOLE step (hidden, then stats, drag guard and the strip let go): checking the
    // moment the bar hides raced the rest of runChanged once decide() started publishing first.
    // A process with no window never takes the foreground, so game mode's shared watch (lane
    // mantle-idlefix-game, _game-watch.js) sees it at its 12 s backstop, not within a second: the bound
    // is the backstop plus the step (an accepted cost of not reading the process list every second).
    await until(() => S.run && S.stepAside && !S.win.isVisible() && S.run.released != null, 16000);
    const took = Date.now() - t0;
    check(`game process: the bar steps aside from the PROCESS alone, within ${took} ms (no window, no focus event: the 12 s backstop)`,
      !!S.run && S.run.pid === pid && S.stepAside && S.stepKind === 'run' && !S.win.isVisible() && S.stats_.on === false && took < 15000,
      JSON.stringify({ run: S.run && { pid: S.run.pid, file: S.run.file }, pid, step: S.stepAside, kind: S.stepKind, stats: S.stats_, took }));
    check('game process: the drag guard is off and the release was attempted (a dry run in --test)', S.guard.ok === false && S.run && S.run.released === 'dry run', JSON.stringify({ guard: S.guard, released: S.run && S.run.released }));
    check('game process: one plain log line says the game is running and the bar stepped aside until it exits',
      // no game name in the log any more (privacy pass, inc-tb-1): "a known game running; ..."
      logs.some((l) => l.includes('a known game running; the top bar stepped aside until it exits')), JSON.stringify(logs.slice(-6)));
    // an alt-tab to a non-game, and the "keep over games" switch: neither brings it back while the game runs
    k.onTopbar(Object.assign({}, real || { kind: 'focus', hwnd: '0', self: false }, { kind: 'focus', game: { stepAside: false } }));
    await new Promise((r) => setTimeout(r, 600));
    const afterFocus = S.stepAside && !S.win.isVisible();
    const og = await call('topbar.overGames', { on: true });
    const afterOg = S.stepAside && !S.win.isVisible();
    await call('topbar.overGames', { on: false });
    check('game process: another app in front and "keep over games" both leave it aside while the game runs', afterFocus && og.ok && og.stepAside === true && afterOg,
      JSON.stringify({ afterFocus, og, afterOg }));
    const st = await call('topbar.status');
    check('game process: topbar.status names the running game and the process watch is healthy', st && st.run && st.run.file.toLowerCase() === name.toLowerCase() && st.runWatch && st.runWatch.ok === true,
      JSON.stringify(st && { run: st.run, runWatch: st.runWatch }));
    // exit: killed BY PID (ours), and the bar, its stats and the guard come back
    const t1 = Date.now();
    try { process.kill(pid); } catch (e) { check('game process: the stand-in was killed', false, e.message); }
    await until(() => !S.run && !S.stepAside && S.win.isVisible() && S.stats_.on && S.guard.ok, 5000);
    const back = Date.now() - t1;
    check(`game process: its exit brings the bar, its stats and the drag guard back, within ${back} ms`,
      !S.run && !S.stepAside && S.win.isVisible() && S.stats_.on && S.guard.ok && back < 4000, JSON.stringify({ run: S.run, step: S.stepAside, stats: S.stats_, guard: S.guard, back }));
    check('game process: plain log lines say it exited and the strip is taken back (nothing to take back in --test)',
      logs.some((l) => /a known game exited after \d+ s; the top bar takes back/.test(l)) && logs.some((l) => /back \(game exited\): the game exited/.test(l)) &&
      logs.some((l) => /a --test instance never reserves space/.test(l)), JSON.stringify(logs.slice(-6)));
  } finally {
    ctx.log = origLog;
    if (standin && standin.exitCode === null) { try { standin.kill(); } catch (_) { /* gone */ } }
    standin = null;
  }
}

/* A frame-ful BrowserWindow (Chromium's own full-screen path, the one Chrome's F11 takes), made
   invisible (opacity 0) and harmless (no activation, bottom of the z-order), put in full screen,
   then moved below the bar from OUTSIDE with SetWindowPos exactly as the sidecar would. Measures
   whether Chromium puts it back, whether the page re-lays out, and whether it still thinks it is
   full screen. */
/* DROPDOWNS (2026-09-25). Each stat and two menus are opened by a press delivered to the PAGE
 * (webContents.sendInputEvent: Chromium input straight into this renderer, never an OS event;
 * a dispatched mousedown if that does not arrive), with a FIXTURE app and FIXTURE stats: the real
 * focus / stats pushes are held back while it runs, so nothing of Owen's is in a capture. Measured
 * per dropdown: what the page asked for, the window's bounds, its REGION (GetWindowRgnBox through
 * a hidden PowerShell, read-only), the dropdowns' layout boxes, and a 4 ms log from the press
 * until 900 ms later (was a dropdown ever visible past the window's bottom = a clipped slice?).
 * Captures of THIS window only (capturePage) go to %TEMP%\mantle-topbar\drop-*.png. */
const FIX_FOCUS = (() => {
  let id = 900;
  const it = (label, key, extra) => Object.assign({ t: 'item', pos: 0, label, key: key || '', mn: label[0].toLowerCase(), id: id++, enabled: true, checked: false, radio: false, items: null, lazy: false }, extra || {});
  const pos = (items) => items.map((x, i) => Object.assign(x, { pos: i }));
  const file = it('File', '', { id: null, items: pos([it('New', 'Ctrl+N'), it('Open…', 'Ctrl+O'), { t: 'sep' }, it('Save', 'Ctrl+S'), it('Save As…', 'Ctrl+Shift+S'),
    { t: 'sep' }, it('Page Setup…'), it('Print…', 'Ctrl+P'), { t: 'sep' }, it('Exit')]) });
  const edit = it('Edit', '', { id: null, items: pos([it('Undo', 'Ctrl+Z'), it('Cut', 'Ctrl+X'), it('Copy', 'Ctrl+C'), it('Paste', 'Ctrl+V')]) });
  return { kind: 'focus', hwnd: '515151', cls: 'FixtureClass', title: 'Fixture', exe: 'C:\\fixture\\Fixture.exe', desc: 'Fixture', product: 'Fixture',
    self: false, shell: false, fullscreen: false, zoomed: false, topmost: false, enabled: true, uia: 'not needed', game: { stepAside: false },
    // source 'fixture', not 'win32': the page then never asks the sidecar to read or prepare it (hwnd 515151 is no window of Owen's to touch)
    menu: { source: 'fixture', hwnd: '515151', owner: false, items: pos([file, edit]), count: 16, truncated: false } };
})();
const GB = 2 ** 30;
const FIX_STATS = { t: 1, cpu: { pct: 23.4, cores: [22, 61, 9, 14, 37, 5, 71, 18], top: [{ name: 'fixture-a', pct: 11.2 }, { name: 'fixture-b', pct: 6.1 }, { name: 'fixture-c', pct: 1.3 }] },
  mem: { used: 9.7 * GB, total: 15.7 * GB, commit: 13.1 * GB, commitLimit: 23.4 * GB, top: [{ name: 'fixture-a', bytes: 2.1 * GB }, { name: 'fixture-b', bytes: 1.4 * GB }] },
  gpu: { pct: 7.8, name: 'Fixture GPU', engines: [{ type: '3D', pct: 7.8 }, { type: 'VideoDecode', pct: 2.2 }, { type: 'Copy', pct: 0 }], dedicated: 0.13 * GB, shared: 1.2 * GB,
    top: [{ name: 'fixture-a', pct: 4.1 }] },
  net: { down: 2.4 * 2 ** 20, up: 88 * 1024, adapters: [{ name: 'Fixture adapter', down: 2.4 * 2 ** 20, up: 88 * 1024 }] }, costMs: 1 };

const RGN_PS1 = `param([Int64]$Hwnd)
Add-Type -Namespace MantleSelftest -Name Rgn -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
'@
[void][MantleSelftest.Rgn]::SetThreadDpiAwarenessContext([IntPtr](-4))
$b = New-Object MantleSelftest.Rgn+RECT; $w = New-Object MantleSelftest.Rgn+RECT
$k = [MantleSelftest.Rgn]::GetWindowRgnBox([IntPtr]$Hwnd, [ref]$b)
[void][MantleSelftest.Rgn]::GetWindowRect([IntPtr]$Hwnd, [ref]$w)
'{0} {1} {2} {3} {4} {5} {6} {7} {8}' -f $k, $b.left, $b.top, $b.right, $b.bottom, $w.left, $w.top, $w.right, $w.bottom
`;
// The window's rect and region in physical px (region kind 0 = none: the whole window is live).
function regionOf(hwnd) {
  const cp = require('child_process');
  const file = path.join(path.dirname(OUT), 'rgn.ps1');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, RGN_PS1); } catch (e) { return Promise.resolve({ error: e.message }); }
  return new Promise((resolve) => {
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Hwnd', String(hwnd)],
      { windowsHide: true, timeout: 20000 }, (err, out) => {
        const n = String(out || '').trim().split(/\s+/).map(Number);
        if (err || n.length !== 9 || n.some((x) => !Number.isFinite(x))) return resolve({ error: (err && err.message) || `unreadable: ${String(out).slice(0, 80)}` });
        resolve({ kind: n[0], box: { left: n[1], top: n[2], right: n[3], bottom: n[4] }, rect: { left: n[5], top: n[6], right: n[7], bottom: n[8] } });
      });
  });
}

async function dropdowns(k, page, check, measured, until) {
  const { ctx, S, screen, BAR_DIP } = k;
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const dir = path.dirname(OUT);
  // the live height of what is on: the region's box when there is one, else the whole window (DIP)
  const liveDip = (g) => (g.error ? null : (g.kind === 2 || g.kind === 3) ? (g.box.bottom - g.box.top) / scale : (g.rect.bottom - g.rect.top) / scale);
  const realPush = ctx.push;
  let held = false;
  try {
    ctx.push = function (win, ev, payload) {
      if (win === S.win && /^topbar\.(focus|title|stats|uia|geometry)$/.test(ev)) return undefined;
      return realPush.apply(this, arguments);
    };
    held = ctx.push !== realPush;
  } catch (_) { held = false; }
  const rows = [];
  try {
    await ctx.sidecar.send('topbar.stats', { on: false }, { timeoutMs: 3000 });
    realPush.call(ctx, S.win, 'topbar.focus', FIX_FOCUS);
    realPush.call(ctx, S.win, 'topbar.stats', FIX_STATS);
    await sleep(400);
    for (const [name, sel] of [['cpu', '.st[data-k="cpu"]'], ['mem', '.st[data-k="mem"]'], ['gpu', '.st[data-k="gpu"]'], ['net', '.st[data-k="net"]'],
      ['mantle', '.t[data-i="0"]'], ['file', '.t[data-i="2"]']]) {
      const q = JSON.stringify(sel);
      const pos = await page(`(() => { const b = document.querySelector(${q}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!pos) { check(`dropdown ${name}: its button is on the bar`, false, sel); continue; }
      const closed0 = { bounds: S.win.getBounds(), rgn: await regionOf(S.hwnd) };
      await page(`(() => { window.__dropLog = []; const t0 = performance.now(); const tick = () => { const dds = [...document.querySelectorAll('#menus .dd')];
        window.__dropLog.push({ t: Math.round(performance.now() - t0), ih: innerHeight, dds: dds.map((d) => ({ b: d.offsetTop + d.offsetHeight, hid: getComputedStyle(d).visibility === 'hidden' })) });
        if (performance.now() - t0 < 900) setTimeout(tick, 4); }; tick(); return true; })()`);
      let via = 'sendInputEvent';
      S.win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      S.win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      if (!(await until(() => S.menu.open, 1200))) {
        via = 'dispatched mousedown';
        await page(`document.querySelector(${q}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
        await until(() => S.menu.open, 1500);
      }
      await sleep(950);
      const pg = await page(`(() => { const dds = [...document.querySelectorAll('#menus .dd')];
        return { ih: innerHeight, dds: dds.map((d) => ({ top: d.offsetTop, bottom: d.offsetTop + d.offsetHeight, inner: d.scrollHeight, client: d.clientHeight, hidden: getComputedStyle(d).visibility === 'hidden' })),
          scroll: document.scrollingElement.scrollTop + document.getElementById('menus').scrollTop, log: window.__dropLog || [],
          cores: [...document.querySelectorAll('.core i')].map((i) => i.offsetHeight), note: (document.querySelector('.warn') || {}).textContent || '' }; })()`);
      const open = { asked: S.menu.open ? S.menu.height : null, bounds: S.win.getBounds(), shape: S.shape, rgn: await regionOf(S.hwnd) };
      let shot = null;
      if (held) {
        try { const img = await S.win.webContents.capturePage(); if (!img.isEmpty()) { shot = path.join(dir, `drop-${name}.png`); fs.writeFileSync(shot, img.toPNG()); } } catch (e) { shot = 'capture failed: ' + e.message; }
      }
      await page(`(() => { for (let i = 0; i < 3 && window.__topbar.open; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
      await until(() => !S.menu.open, 1500);
      await sleep(300);
      const shut = { bounds: S.win.getBounds(), shape: S.shape, rgn: await regionOf(S.hwnd) };
      const full = pg.dds.length ? Math.max(...pg.dds.map((d) => d.bottom)) : null;
      const live = liveDip(open.rgn);
      const clippedFrames = pg.log.filter((f) => f.dds.some((d) => !d.hid && d.b > f.ih));
      const row = { name, via, full, asked: open.asked, windowOpen: open.bounds.height, liveOpenDip: live, ih: pg.ih, dds: pg.dds, frames: pg.log.length,
        clippedFrames: clippedFrames.length, firstClipped: clippedFrames[0] || null, windowClosed: shut.bounds.height, liveClosedDip: liveDip(shut.rgn),
        rgnOpen: open.rgn, rgnClosed: shut.rgn, closed0: { h: closed0.bounds.height, live: liveDip(closed0.rgn) }, scroll: pg.scroll, note: pg.note, shot };
      if (name === 'cpu') row.cores = pg.cores;
      rows.push(row);
      const tag = `dropdown ${name} (${via})`;
      check(`${tag}: opens, and the height asked for covers the dropdown's full height`, full != null && open.asked >= full, JSON.stringify({ full, asked: open.asked }));
      check(`${tag}: the window grew to it and its live region (shape) holds the whole dropdown`,
        open.bounds.height >= full && live != null && live >= full - 1 && pg.ih >= full, JSON.stringify({ win: open.bounds.height, live, ih: pg.ih, full, rgn: open.rgn }));
      // "no note" means no note about THE MENU (cut off / cannot be shown). Other notes can still be up
      // from earlier steps: the About step's version line stays 8 s and failed cpu + mem on 2026-09-25.
      const menuNote = !!pg.note && /menu (is cut off|cannot be shown)/i.test(pg.note);
      check(`${tag}: shown whole (nothing hidden, nothing scrolling inside on this screen), the page not scrolled, no note about the menu`,
        pg.dds.every((d) => !d.hidden && d.bottom <= pg.ih && d.inner <= d.client + 1) && pg.scroll === 0 && !menuNote, JSON.stringify({ dds: pg.dds, scroll: pg.scroll, note: pg.note }));
      check(`${tag}: no clipped slice was ever shown while the window grew (${pg.log.length} samples)`, pg.log.length > 5 && clippedFrames.length === 0, JSON.stringify(clippedFrames.slice(0, 3)));
      check(`${tag}: closing shrinks the live part back to the ${BAR_DIP} DIP bar`, !S.menu.open && Math.abs(liveDip(shut.rgn) - BAR_DIP) <= 1, JSON.stringify({ shut, live: liveDip(shut.rgn) }));
      if (name === 'cpu') {
        const want = FIX_STATS.cpu.cores.map((p) => Math.round(26 * p / 100));
        check(`${tag}: the per-core bars are drawn (CSSOM heights; the CSP drops inline styles)`, pg.cores.length === 8 && pg.cores.every((h, i) => Math.abs(h - want[i]) <= 1), JSON.stringify([pg.cores, want]));
      }
    }
  } finally {
    measured.dropdowns = rows;
    if (held) ctx.push = realPush;
    if (S.stats_.on && !S.stepAside) await ctx.sidecar.send('topbar.stats', { on: true }, { timeoutMs: 3000 });
    if (S.focus) realPush.call(ctx, S.win, 'topbar.focus', S.focus);
  }
}

/* DRIFT (lane tbdrift, 2026-09-27). Owen's log: the bar's window shrank to 1477 / 1443 / 1359 / 673 wide
 * with its left edge at 0, then 1396 / 1345 / 1017 with its right edge at 1536: a mouse drag on resize
 * bands Electron gives any RESIZABLE frameless window. Everything here touches THIS instance's own bar
 * window only: WM_NCHITTEST is a question sent to it (no input), and SetWindowPos on it stands in for
 * "something outside Mantle" (Chromium's own work-area move, a DPI change) moving or resizing it. */
async function driftSection(k, check, until, call) {
  const { ctx, S, screen } = k;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const SendMessageW = user32.func('intptr_t __stdcall SendMessageW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)');
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
  const HT = { 1: 'CLIENT', 2: 'CAPTION', 10: 'LEFT', 11: 'RIGHT', 12: 'TOP', 13: 'TOPLEFT', 14: 'TOPRIGHT', 15: 'BOTTOM', 16: 'BOTTOMLEFT', 17: 'BOTTOMRIGHT' };
  const NOSIZE = 0x0001, NOMOVE = 0x0002, NOZORDER = 0x0004, NOACTIVATE = 0x0010;
  await until(() => !S.menu.open && S.win.isVisible() && !S.stepAside, 3000);
  const h = Number(S.hwnd);
  const b = S.win.getBounds();
  const want = { x: b.x, y: b.y, width: b.width };
  const inPlace = () => { const g = S.win.getBounds(); return g.x === want.x && g.y === want.y && g.width === want.width; };

  // 1. the cause: resize bands. A resizable frameless window answered TOPLEFT / TOPRIGHT / TOP here.
  const pts = { 'left end': [b.x + 2, b.y + 14], 'right end': [b.x + b.width - 2, b.y + 14], 'top edge': [b.x + Math.round(b.width / 2), b.y + 1],
    'top-left corner': [b.x + 1, b.y + 1], 'top-right corner': [b.x + b.width - 1, b.y + 1] };
  const hits = {};
  for (const [name, [x, y]] of Object.entries(pts)) {
    const p = screen.dipToScreenPoint({ x, y });
    const v = Number(SendMessageW(h, 0x0084 /* WM_NCHITTEST */, 0, ((p.y & 0xffff) << 16) | (p.x & 0xffff)));
    hits[name] = HT[v] || String(v);
  }
  check('drift: no resize handles: WM_NCHITTEST says CLIENT at both ends, the top edge and both top corners (a drag there used to resize the bar)',
    Object.values(hits).every((v) => v === 'CLIENT'), JSON.stringify(hits));
  check('drift: the bar window is not resizable', S.win.isResizable() === false, String(S.win.isResizable()));

  const logs = [];
  const healths = [];
  const origLog = ctx.log, origHealth = ctx.health;
  ctx.log = (t) => { logs.push(String(t)); return origLog(t); };
  ctx.health = (ok, why) => { healths.push({ ok, why }); return origHealth(ok, why); };
  try {
    // 2. a foreign resize cannot change its size (min = max on a non-resizable Electron window)
    const pr = screen.dipToScreenRect(S.win, { x: b.x, y: b.y, width: 900, height: b.height });
    SetWindowPos(h, 0, 0, 0, pr.width, pr.height, NOMOVE | NOZORDER | NOACTIVATE);
    await sleep(150);
    const sized = S.win.getBounds();
    check('drift: a foreign SetWindowPos to 900 DIP wide does not change the bar\'s width', sized.width === want.width, JSON.stringify(sized));
    await until(() => !S.drift || !S.drift.stuck, 1000);

    // 3. five foreign moves 0.4 s apart: 3 put-backs at once, then the fight (logged once, a health reason), never given up
    await sleep(600);
    const d0 = logs.length;
    const down = screen.dipToScreenPoint({ x: b.x, y: b.y + 28 });
    for (let i = 0; i < 5; i++) { SetWindowPos(h, 0, down.x, down.y, 0, 0, NOSIZE | NOZORDER | NOACTIVATE); await sleep(400); }
    const mine = () => logs.slice(d0);
    const bad = () => (healths.filter((x) => !x.ok).pop() || {}).why || '';
    const drifted = mine().filter((l) => /drifted to 0,28 /.test(l)).length;
    check('drift: 5 moves in 2 s: 3 put back at once, then "keeps leaving its place" once, and the fight is a health reason (not given up)',
      !!(S.drift && S.drift.stuck) && drifted === 3 && mine().filter((l) => /keeps leaving its place/.test(l)).length === 1 && /keeps moving or resizing the top bar's window/.test(bad()),
      JSON.stringify({ drift: S.drift, drifted, logs: mine(), health: bad() }));

    // 4. hidden by hand mid-fight: nothing is put back while hidden (never fights a hide), and the health reason goes
    const hid = await call('topbar.hidden', { on: true, via: 'the self-test (drift: hidden mid-fight)' });
    SetWindowPos(h, 0, down.x, down.y, 0, 0, NOSIZE | NOZORDER | NOACTIVATE);   // moved again while hidden
    await sleep(1600);   // a queued re-check lands while hidden
    const whileHidden = S.win.getBounds();
    const lastH = healths[healths.length - 1] || {};
    check('drift: hidden by hand mid-fight, nothing is put back while hidden (the window stays where it was moved, not shown) and the health reason goes',
      hid.ok && S.hidden && !S.win.isVisible() && whileHidden.y !== want.y && !/keeps moving or resizing/.test(lastH.why || ''),
      JSON.stringify({ hid, vis: S.win.isVisible(), whileHidden, lastH }));

    // 5. shown again: put back BEFORE it shows, and a re-check finding it in place ends the fight
    const sh = await call('topbar.hidden', { on: false, via: 'the self-test (drift: shown again)' });
    const shownAt = (await until(() => S.win.isVisible(), 2000)) ? S.win.getBounds() : null;   // polled every 80 ms, well inside the 250 ms drift debounce
    const back = await until(() => S.win.isVisible() && inPlace(), 2500);
    check('drift: shown again, it is put back before it shows (never drawn out of place)',
      sh.ok && back && !!shownAt && shownAt.y === want.y && shownAt.width === want.width, JSON.stringify({ sh, shownAt, got: S.win.getBounds() }));
    const settled = await until(() => !S.drift, 6000);
    const lastH2 = healths[healths.length - 1] || {};
    check('drift: a re-check finding it in place ends the fight: one "back in place" line, the health reason cleared',
      settled && mine().filter((l) => /back in place and stayed there/.test(l)).length === 1 && !/keeps moving or resizing/.test(lastH2.why || ''),
      JSON.stringify({ drift: S.drift, logs: mine(), lastH2 }));
  } finally {
    ctx.log = origLog;
    ctx.health = origHealth;
    if (S.hidden) await call('topbar.hidden', { on: false, via: 'the self-test (drift cleanup)' });
  }
}

async function measureFullscreen(k, ours) {
  const { screen, BrowserWindow, hwndOf, thumbs, BAR_DIP } = k;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
  const d = screen.getPrimaryDisplay();
  const w = new BrowserWindow({ show: false, frame: true, width: 400, height: 300, x: d.bounds.x + 40, y: d.bounds.y + 80,
    focusable: false, skipTaskbar: true, title: 'Mantle topbar full-screen probe', webPreferences: { sandbox: true, contextIsolation: true } });
  const hwnd = hwndOf(w);
  ours.add(hwnd);
  try {
    await w.loadURL('data:text/html,<body style="margin:0;background:#888">probe</body>');
    w.setOpacity(0);
    w.showInactive();
    thumbs.toBack(hwnd);
    const before = w.getBounds();
    w.setFullScreen(true);
    await sleep(900);
    thumbs.toBack(hwnd);
    const full = { bounds: w.getBounds(), isFull: w.isFullScreen(), innerHeight: await w.webContents.executeJavaScript('innerHeight') };
    const phys = screen.dipToScreenRect(null, d.bounds);
    const bar = Math.round(BAR_DIP * d.scaleFactor);
    const moved = SetWindowPos(BigInt(hwnd), 0n, phys.x, phys.y + bar, phys.width, phys.height - bar, 0x0004 | 0x0010);   // NOZORDER | NOACTIVATE
    await sleep(1500);
    const fit = { bounds: w.getBounds(), isFull: w.isFullScreen(), innerHeight: await w.webContents.executeJavaScript('innerHeight') };
    w.setFullScreen(false);
    await sleep(700);
    const after = { bounds: w.getBounds(), isFull: w.isFullScreen() };
    return {
      display: d.bounds, scale: d.scaleFactor, before, full, setWindowPos: moved, fit, after,
      chromiumPutItBack: fit.bounds.y === d.bounds.y && fit.bounds.height === d.bounds.height,
      pageRelaidOut: fit.innerHeight < full.innerHeight,
      exitRestored: after.bounds.width === before.width && after.bounds.height === before.height,
    };
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

/* FULL-SCREEN VIDEO + MANUAL HIDE (lane tbvideo, 2026-09-26). Owen's real focus changes and media
 * sessions are held back (S.holdReal) while FAKE ones drive the rules: no media plays, no window of
 * his is touched. The chord arrives through a SECOND INSTANCE (--test-chord=Win+Alt+T), the seam's
 * own test path: no keyboard hook, no synthetic key. */
async function videoAndHide(k, check, until, call, page, real) {
  const { S, ctx } = k;
  S.holdReal = true;
  const restore = () => k.onTopbar(Object.assign({}, real || { kind: 'focus', hwnd: '0', self: false }, { kind: 'focus', game: { stepAside: false } }));
  const shown = () => !S.stepAside && S.win.isVisible();
  const chrome = { kind: 'focus', hwnd: '525252', self: false, shell: false, exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    desc: 'Google Chrome', appid: 'Chrome', fullscreen: false, zoomed: true, game: { stepAside: false } };
  const media = (status) => ({ ok: true, sessions: [{ aumid: 'Spotify.exe', status: 'playing', playing: true, title: 'selftest song' },
    { aumid: 'Chrome', status, playing: status === 'playing', title: 'selftest video' }] });

  k.onMedia(media('playing'));
  k.onTopbar(chrome);
  await sleep(300);
  check('video: a WINDOWED browser playing video leaves the bar where it is', shown() && !S.video, JSON.stringify({ step: S.stepAside, video: S.video }));
  k.onTopbar({ kind: 'geometry', hwnd: chrome.hwnd, fullscreen: true, zoomed: false, game: { stepAside: false } });
  await until(() => S.stepAside && !S.win.isVisible(), 2000);
  await sleep(200);
  const v1 = { step: S.stepAside, kind: S.stepKind, vis: S.win.isVisible(), stats: S.stats_, video: S.video, signal: S.stepSignal, guard: S.guard.ok, cover: S.cover };
  check('video: the browser going full screen with its own session Playing steps the bar aside (hidden, stats paused, drag guard and strip kept)',
    v1.step && v1.kind === 'video' && !v1.vis && v1.stats.on === false && v1.video && v1.video.how === 'app id' && v1.guard === true && !v1.cover &&
    /Google Chrome is playing video full screen; the top bar stepped aside until it leaves full screen/.test(v1.signal || ''), JSON.stringify(v1));
  const st = await call('topbar.state');
  check('video: topbar.state says so (for quick settings)', st && st.kind === 'video' && st.video && st.video.app === 'Google Chrome' && st.hidden === false, JSON.stringify(st));
  k.onMedia(media('paused'));
  await sleep(400);
  check('video: PAUSED, still full screen: stays aside (no flicker)', S.stepAside && S.stepKind === 'video' && !S.win.isVisible(), JSON.stringify({ step: S.stepAside, kind: S.stepKind }));
  k.onMedia(media('playing'));
  await sleep(200);
  check('video: playing again: still aside, the same latch', S.stepAside && S.video && S.video.hwnd === chrome.hwnd, JSON.stringify(S.video));
  k.onTopbar({ kind: 'geometry', hwnd: chrome.hwnd, fullscreen: false, zoomed: true, game: { stepAside: false } });
  await until(() => shown() && S.stats_.on, 3000);
  check('video: leaving full screen brings the bar and its stats back', shown() && S.stats_.on && !S.video && S.videoEnd === 'left full screen',
    JSON.stringify({ step: S.stepAside, stats: S.stats_, video: S.video, end: S.videoEnd }));

  // a full-screen window that is not watching video: the old rule, the bar stays over its top strip
  k.onTopbar({ kind: 'focus', hwnd: '535353', self: false, exe: 'C:\\Windows\\explorer.exe', desc: 'Windows Explorer', appid: 'Microsoft.Windows.Explorer',
    fullscreen: true, game: { stepAside: false } });
  await sleep(400);
  check('video: a full-screen window with nothing of its own playing (File Explorer F11): the bar STAYS over it', shown() && !!S.cover && S.cover.app === 'File Explorer' && !S.video,
    JSON.stringify({ step: S.stepAside, cover: S.cover, video: S.video }));

  // a known player: no session needed
  k.onMedia({ ok: true, sessions: [] });
  k.onTopbar({ kind: 'focus', hwnd: '545454', self: false, exe: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', desc: 'VLC media player', appid: 'VideoLAN.VLC',
    fullscreen: true, game: { stepAside: false } });
  await until(() => S.stepAside && !S.win.isVisible(), 2000);
  check('video: a known player (vlc.exe) full screen steps aside with no media session at all', S.stepAside && S.stepKind === 'video' && !!S.video && S.video.how === 'player',
    JSON.stringify({ kind: S.stepKind, video: S.video }));
  restore();
  await until(() => shown() && S.stats_.on, 3000);
  check('video: another window taking the foreground brings the bar back', shown() && S.videoEnd === 'lost the foreground', JSON.stringify({ step: S.stepAside, end: S.videoEnd }));

  // MANUAL HIDE through the page's own menu: open the Mantle menu, press "Hide top bar"
  const clicked = await page(`(() => {
    const t = document.querySelector('.t[data-i="0"]');
    if (!t) return 'no Mantle title';
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return new Promise((res) => setTimeout(() => {
      const row = Array.from(document.querySelectorAll('.r[data-l="0"]')).find((r) => /Hide top bar/.test(r.textContent));
      if (!row) return res('no Hide top bar row');
      const kb = row.querySelector('.kb') ? row.querySelector('.kb').textContent : '';
      row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));   // re-renders the menu: find the row again
      const again = Array.from(document.querySelectorAll('.r[data-l="0"]')).find((r) => /Hide top bar/.test(r.textContent));
      if (!again) return res('the row went away after the hover');
      again.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      res('clicked ' + kb);
    }, 400));
  })()`).catch((e) => 'threw: ' + e.message);
  await until(() => S.hidden && !S.win.isVisible() && S.stats_.on === false && S.menu.open === false, 3000);
  const h1 = { clicked, hidden: S.hidden, kind: S.stepKind, vis: S.win.isVisible(), stats: S.stats_, guard: S.guard, reserve: S.reserve, saved: ctx.settings.get('hidden', null), menu: S.menu };
  check('hide: "Hide top bar" in the Mantle menu (shows Win+Alt+T) hides it: window hidden, stats and drag guard off, strip let go (dry run), saved',
    clicked === 'clicked Win+Alt+T' && h1.hidden && h1.kind === 'hidden' && !h1.vis && h1.stats.on === false && h1.guard.ok === false && h1.saved === true && h1.menu.open === false,
    JSON.stringify(h1));
  // manual hide wins: a video coming and going and ordinary windows never show it
  k.onMedia(media('playing'));
  k.onTopbar(Object.assign({}, chrome, { fullscreen: true }));
  await sleep(300);
  k.onTopbar(Object.assign({}, chrome, { fullscreen: false }));
  await sleep(300);
  restore();
  await sleep(500);
  check('hide: it wins: a video coming and going and another window in front never show the bar', S.hidden && S.stepKind === 'hidden' && !S.win.isVisible(),
    JSON.stringify({ hidden: S.hidden, kind: S.stepKind, vis: S.win.isVisible() }));
  const ov = await call('topbar.overGames', { on: true });
  check('hide: "keep the bar over full-screen games" does not show it either', ov.ok && S.hidden && !S.win.isVisible(), JSON.stringify(ov));
  await call('topbar.overGames', { on: false });

  // Show through the same bridge quick settings uses
  const sh = await call('topbar.hidden', { on: false, via: 'quick settings (self-test)' });
  await until(() => shown() && S.stats_.on && S.guard.ok, 4000);
  check('hide: "Show top bar" brings it back: visible, stats and drag guard on, saved as shown', sh.ok && sh.hidden === false && shown() && S.stats_.on && S.guard.ok && ctx.settings.get('hidden', null) === false,
    JSON.stringify({ sh, guard: S.guard, stats: S.stats_ }));

  // THE CHORD from a second instance, twice: hides, then shows.
  // A chord that reaches an UNHEALTHY feature goes back to Windows by design (features.js). On a loaded
  // machine the sidecar missed the 3 s game scan for a moment (lane r9-flake, 2026-10-01: "did not answer
  // "gamemode.scan" within 3s" just before the second chord, healthy again about 1 s later), so that chord
  // came back {"delivered":false} and the bar stayed hidden. So each chord waits until the sidecar-fed
  // checks are healthy, and a chord that met such a dip while in flight (a 50 ms sampler) is sent ONCE
  // more, said in the log. A chord that landed is never sent again (that would toggle it back).
  const sidecarOk = () => S.runWatch.ok !== false && S.watch.ok !== false;
  const chord = async (what, landed) => {
    const tries = [];
    for (let i = 0; i < 2; i++) {
      await until(sidecarOk, 10000);
      let dip = !sidecarOk();
      const sampler = setInterval(() => { if (!sidecarOk()) dip = true; }, 50);
      const r = await secondInstance(`--test-chord=${k.HIDE_CHORD}`);
      const ok = await until(() => { if (!sidecarOk()) dip = true; return landed(); }, 8000);
      clearInterval(sampler);
      tries.push({ err: r.err, landed: ok, dip });
      if (ok || !dip) break;
      ctx.log(`selftest: the ${what} chord met a health dip (${S.runWatch.reason || S.watch.reason || 'recovered'}) and did not land; sending it once more`);
    }
    return tries;
  };
  const t1 = await chord('hide', () => S.hidden && !S.win.isVisible());
  const c1ok = S.hidden && !S.win.isVisible() && S.stepKind === 'hidden';
  const t2 = await chord('show', () => shown() && S.guard.ok);
  check('hide: Win+Alt+T (the --test-chord of a second instance) hides the bar, and the same chord shows it again',
    c1ok && !S.hidden && shown() && S.guard.ok, JSON.stringify({ t1, t2, c1ok, hidden: S.hidden, vis: S.win.isVisible(), runWatch: S.runWatch }));
  restore();
}

/* PEEK while hidden by hand (lane tbpeek, 2026-09-27). The cursor and the mouse buttons are FAKES
 * (start() swapped them in through the feature's test-only peekSource), so nothing here reads where
 * Owen's cursor is, and nothing ever moves it or presses anything. Focus snapshots are fakes too
 * (S.holdReal), for the full-screen rule. What is REAL: the poll, the window showing and hiding, the
 * stats sampler, the strip and the drag guard staying as they were, the log, topbar.state. */
async function peekSection(k, check, until, call, page, real, fake) {
  const { S, ctx, screen } = k;
  const PK = require('./_topbar-peek');
  const b = screen.getPrimaryDisplay().bounds;
  const EDGE = { x: b.x + Math.round(b.width / 2), y: b.y };
  const ON_BAR = { x: EDGE.x, y: b.y + 12 };
  const AWAY = { x: EDGE.x, y: b.y + Math.round(b.height / 2) };
  const up = { ok: true, held: false, pressed: false };
  const vis = () => S.win.isVisible();
  const logs = [];
  const origLog = ctx.log;
  ctx.log = (t) => { logs.push(String(t)); origLog(t); };
  S.holdReal = true;
  const notepad = { kind: 'focus', hwnd: '616161', self: false, shell: false, exe: 'C:\\Windows\\System32\\notepad.exe', desc: 'Notepad',
    fullscreen: false, zoomed: true, game: { stepAside: false } };
  try {
    fake.pt = AWAY; fake.btn = up; fake.cursorErr = null;
    k.onTopbar(notepad);
    const hd = await call('topbar.hidden', { on: true, via: 'the self-test (peek)' });
    await until(() => S.hidden && !vis() && S.peek.watching && S.peek.ok === true, 4000);
    const st0 = await call('topbar.state');
    check('peek: hidden by hand, the top edge is watched (the FAKE cursor), and topbar.state says the watch works',
      hd.ok && S.hidden && !vis() && S.peek.watching && S.peek.src.fake && st0.peek && st0.peek.ok === true && st0.peek.watching === true && st0.peek.shown === false,
      JSON.stringify({ hd: hd.ok, hidden: S.hidden, vis: vis(), peek: st0.peek }));

    // the poll's cost: one cursor read per PEEK_POLL_MS, and no button read with the cursor off the edge
    const r0 = fake.reads, b0 = fake.btnReads;
    await sleep(1000);
    const perSec = fake.reads - r0;
    check(`peek: the poll reads the cursor ~${1000 / PK.PEEK_POLL_MS}x a second while hidden by hand, and never the buttons off the edge`,
      perSec >= 1000 / PK.PEEK_POLL_MS * 0.6 && perSec <= 1000 / PK.PEEK_POLL_MS * 1.3 && fake.btnReads === b0, JSON.stringify({ perSec, btn: fake.btnReads - b0 }));

    // a flick up to the edge (a tab click) is not a peek
    fake.pt = EDGE; await sleep(250); fake.pt = AWAY; await sleep(900);
    check('peek: a flick to the top edge (250 ms) and away does not peek', !vis() && !S.peek.shown);

    // a button held on the edge (a window dragged up to snap / maximise), then let go there
    fake.btn = { ok: true, held: true, pressed: true }; fake.pt = EDGE;
    await sleep(1200);
    const heldVis = vis();
    fake.btn = up;
    await sleep(1000);
    check('peek: a mouse button held on the edge never peeks, nor does letting it go there', !heldVis && !vis() && /mouse button went down/.test((S.peek.blocked || {}).why || ''),
      JSON.stringify({ heldVis, vis: vis(), blocked: S.peek.blocked }));
    fake.pt = AWAY; await sleep(300);

    // a full-screen window in front (YouTube / F11): no peek
    k.onTopbar(Object.assign({}, notepad, { hwnd: '636363', exe: 'C:\\Windows\\explorer.exe', desc: 'Windows Explorer', fullscreen: true, zoomed: false }));
    await sleep(200);
    fake.pt = EDGE;
    await sleep(1200);
    check('peek: never over a full-screen window in front (the sidecar\'s verdict)', !vis() && /is full screen/.test((S.peek.blocked || {}).why || ''), JSON.stringify({ vis: vis(), blocked: S.peek.blocked }));
    fake.pt = AWAY;
    k.onTopbar(notepad);
    await sleep(300);

    // THE PEEK: resting on the edge
    const logN = logs.length;
    const t0 = Date.now();
    fake.pt = EDGE;
    await until(() => vis(), 3000);
    const dt = Date.now() - t0;
    await until(() => S.stats_.on === true, 3000);
    const st1 = await call('topbar.state');
    const item = await page('JSON.stringify((window.TopbarModel.MANTLE_MENU.find(function (i) { return i.key === "Win+Alt+T"; }) || {}))').then(JSON.parse).catch((e) => ({ err: e.message }));
    check(`peek: resting on the top edge shows the bar after the dwell (${PK.PEEK_DWELL_MS} ms) and not before`,
      vis() && S.peek.shown && dt >= PK.PEEK_DWELL_MS - 30 && dt <= PK.PEEK_DWELL_MS + 3 * PK.PEEK_POLL_MS + 400, JSON.stringify({ vis: vis(), dt }));
    check('peek: it is still hidden by hand (state and the saved setting), the strip stays let go, the drag guard stays off',
      S.hidden && ctx.settings.get('hidden', null) === true && S.stepKind === 'hidden' && S.reserve.reserved === false && S.guard.ok === false && st1.hidden === true && st1.peek.shown === true,
      JSON.stringify({ hidden: S.hidden, saved: ctx.settings.get('hidden', null), kind: S.stepKind, reserve: S.reserve, guard: S.guard.ok, st: st1.peek }));
    check('peek: live stats while it is out', S.stats_.on === true, JSON.stringify(S.stats_));
    check('peek: its Mantle menu offers "Show top bar" (for good) instead of a no-op "Hide top bar"', item && item.act === 'show' && item.label === 'Show top bar', JSON.stringify(item));
    check('peek: one log line "peek shown" with the reason', logs.slice(logN).filter((l) => /^peek shown: the cursor rested on the top edge for \d+ ms/.test(l)).length === 1,
      JSON.stringify(logs.slice(logN)));

    // over the bar it stays; a menu open keeps it out with the cursor away; closed, it goes after the grace
    fake.pt = ON_BAR; await sleep(1500);
    const onBar = vis();
    await call('topbar.menuState', { open: true, height: 300 });
    fake.pt = AWAY; await sleep(1500);
    const menuVis = vis();
    const logM = logs.length;
    await call('topbar.menuState', { open: false });
    const t1 = Date.now();
    await until(() => !vis(), 3000);
    const gone = Date.now() - t1;
    await until(() => S.stats_.on === false, 3000);
    check('peek: stays while the cursor is on the bar and while one of its menus is open', onBar && menuVis, JSON.stringify({ onBar, menuVis }));
    check(`peek: gone ${PK.PEEK_GRACE_MS} ms after the cursor left (menu closed), stats off, still hidden by hand, nothing reserved`,
      !vis() && !S.peek.shown && gone >= PK.PEEK_GRACE_MS - 30 && gone <= PK.PEEK_GRACE_MS + 3 * PK.PEEK_POLL_MS + 400 && S.stats_.on === false &&
      S.hidden && ctx.settings.get('hidden', null) === true && S.reserve.reserved === false && S.guard.ok === false,
      JSON.stringify({ vis: vis(), gone, stats: S.stats_, hidden: S.hidden, reserve: S.reserve }));
    check('peek: one log line "peek hidden" with the reason', logs.slice(logM).filter((l) => /^peek hidden after [\d.]+ s: the cursor left the bar \d+ ms ago/.test(l)).length === 1,
      JSON.stringify(logs.slice(logM)));
    const item2 = await page('JSON.stringify((window.TopbarModel.MANTLE_MENU.find(function (i) { return i.key === "Win+Alt+T"; }) || {}))').then(JSON.parse).catch((e) => ({ err: e.message }));
    check('peek: the menu item is "Hide top bar" again', item2 && item2.act === 'hide', JSON.stringify(item2));

    // shown for good WHILE peeking: it stays, the strip / guard come back, the poll stops
    fake.pt = EDGE;
    await until(() => vis() && S.peek.shown, 3000);
    const sh = await call('topbar.hidden', { on: false, via: 'quick settings (self-test, while peeking)' });
    await until(() => !S.stepAside && S.guard.ok, 4000);
    const r1 = fake.reads;
    fake.pt = AWAY;
    await sleep(PK.PEEK_GRACE_MS + 800);
    check('peek: "Show top bar" during a peek keeps it up for good: not hidden, saved as shown, drag guard on, the poll stopped',
      sh.ok && vis() && !S.hidden && ctx.settings.get('hidden', null) === false && S.guard.ok && !S.peek.watching && !S.peek.shown && S.peek.t === null && fake.reads === r1,
      JSON.stringify({ vis: vis(), hidden: S.hidden, guard: S.guard.ok, watching: S.peek.watching, shown: S.peek.shown, reads: fake.reads - r1 }));

    // NO SILENT FAILURE: a cursor that cannot be read, and buttons that cannot, are said in topbar.state
    await call('topbar.hidden', { on: true, via: 'the self-test (peek failures)' });
    await until(() => S.hidden && !vis() && S.peek.watching, 4000);
    fake.cursorErr = 'selftest: the cursor is unavailable';
    await until(() => S.peek.ok === false, 2000);
    const stC = await call('topbar.state');
    fake.cursorErr = null;
    await until(() => S.peek.ok === true, 2000);
    const okAgain = S.peek.ok;
    fake.btn = { ok: false, reason: 'selftest: no button reader' };
    fake.pt = EDGE;
    await until(() => S.peek.ok === false, 2000);
    await sleep(1000);
    const stB = await call('topbar.state');
    const btnVis = vis();
    fake.btn = up;
    await until(() => S.peek.ok === true, 2000);
    fake.pt = AWAY;
    await until(() => !vis(), PK.PEEK_GRACE_MS + 2000);
    check('peek: a cursor that cannot be read is said in topbar.state with its reason, and recovers',
      stC.peek && stC.peek.ok === false && /cursor position could not be read \(selftest: the cursor is unavailable\)/.test(stC.peek.reason) && okAgain === true, JSON.stringify({ peek: stC.peek, okAgain }));
    check('peek: mouse buttons that cannot be read refuse the peek and say so',
      !btnVis && stB.peek && stB.peek.ok === false && /mouse buttons cannot be read \(selftest: no button reader\)/.test(stB.peek.reason), JSON.stringify({ btnVis, peek: stB.peek }));
  } finally {
    ctx.log = origLog;
    fake.pt = AWAY; fake.btn = up; fake.cursorErr = null;
    if (S.hidden) await call('topbar.hidden', { on: false, via: 'the self-test (peek done)' });
    await until(() => !S.stepAside && S.win.isVisible(), 4000);
    k.onTopbar(Object.assign({}, real || { kind: 'focus', hwnd: '0', self: false }, { kind: 'focus', game: { stepAside: false } }));
  }
}

/* DISPLAY CHANGES and SESSION END (lane mn-topbar, 2026-10-12). The feature's own listeners (the ones
 * on screen's display events), called with FAKE events: nothing is changed on the real screen and no
 * other listener in this process hears them. Proves a burst of scale changes is two runs, that a
 * work-area move Mantle made itself (or one on another screen) is not answered, and that once Windows
 * ends the session nothing is answered or reserved any more. Runs LAST: session end is final. */
async function displaySection(k, check, until) {
  const { S, screen } = k;
  const d = k.display;
  const prim = screen.getPrimaryDisplay();
  const snap = () => Object.assign({}, S.display);
  await new Promise((r) => setTimeout(r, 600));   // any burst still hot from the earlier sections is over
  const s0 = snap();
  S.ownAt = Date.now();   // as reserve() marks it
  d.metrics(null, prim, ['workArea']);
  const s1 = snap();
  check('display: a work-area move Mantle made itself is not answered (no re-place, no re-reserve)',
    s1.skipped === s0.skipped + 1 && s1.runs === s0.runs && /Mantle moved the work area itself/.test((s1.lastSkip || {}).why || ''), JSON.stringify({ s0, s1 }));
  S.ownAt = 0;
  d.metrics(null, { id: -12345 }, ['workArea']);
  const s2 = snap();
  check('display: a work-area move on another screen is not answered', s2.skipped === s1.skipped + 1 && s2.runs === s1.runs, JSON.stringify(s2));
  for (let i = 0; i < 6; i++) { d.metrics(null, prim, i === 5 ? ['bounds', 'scaleFactor'] : ['scaleFactor']); await new Promise((r) => setTimeout(r, 40)); }
  const s3 = snap();
  await until(() => S.display.runs >= s2.runs + 2, 2000);
  await new Promise((r) => setTimeout(r, 900));   // quiet: nothing more may follow
  const s4 = snap();
  check('display: a burst of 6 scale-change events is 2 runs (at once, then one when it is over), not 6',
    s3.runs === s2.runs + 1 && s4.runs === s2.runs + 2 && /^5 changes: the scale changed, the resolution changed$/.test((s4.last || {}).why || ''), JSON.stringify({ s2: s2.runs, s3: s3.runs, s4 }));
  const b = S.win.getBounds();
  check('display: after the burst the bar is still at the top of the main screen', b.y === prim.bounds.y && b.x === prim.bounds.x, JSON.stringify({ b, top: prim.bounds }));
  d.added(null, prim);
  await until(() => S.display.runs === s4.runs + 1, 1000);
  check('display: a display plugged in is answered at once', S.display.runs === s4.runs + 1 && /connected/.test((S.display.last || {}).why || ''), JSON.stringify(S.display));
  await new Promise((r) => setTimeout(r, 600));
  // SESSION END: final for this instance (it holds no strip in --test, so there is nothing to let go)
  const r0 = Object.assign({}, S.reserve);
  d.sessionEnd();
  const s5 = snap();
  d.metrics(null, prim, ['scaleFactor']);
  d.added(null, prim);
  await new Promise((r) => setTimeout(r, 600));
  check('session end: once Windows ends the session no display change is answered and nothing is reserved again',
    S.ending === true && S.display.events === s5.events && S.display.runs === s5.runs && JSON.stringify(S.reserve) === JSON.stringify(r0),
    JSON.stringify({ ending: S.ending, s5, now: S.display }));
}

/** A second test instance of the same profile that hands one argument to this one, then quits. */
function secondInstance(arg) {
  const cp = require('child_process');
  const prof = process.argv.find((a) => typeof a === 'string' && a.startsWith('--profile-name='));
  if (!prof) return Promise.resolve({ err: 'no --profile-name on this instance' });
  const env = Object.assign({}, process.env);
  delete env.MANTLE_TOPBAR_SELFTEST; delete env.MANTLE_TOPBAR_SELFTEST_EXPECT_HIDDEN; delete env.MANTLE_TOPBAR_SELFTEST_LEAVE_HIDDEN;
  return new Promise((res) => cp.execFile(process.execPath, [path.join(__dirname, '..', '..'), '--test', prof, arg],
    { env, timeout: 30000, windowsHide: true }, (err, out) => res({ err: err ? err.message : null, out: String(out || '').slice(-200) })));
}

function stop() { halt = true; if (standin && standin.exitCode === null) { try { standin.kill(); } catch (_) { /* gone */ } } }

module.exports = { start, stop };

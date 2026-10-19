'use strict';
/* ontop.test.js - "Keep on top" (lane ontop, 2026-09-27): the rules (_ontop-core.js) and the feature's
 * wiring (ontop.js: chord, menu command, stop, rest -> wake, crash tidy-up) against a FAKE Windows.
 * No Electron, no sidecar, no window of Owen's. Prints "ONTOP UNIT TEST: n passed, m failed".
 *   node lib/features/ontop.test.js
 */
const path = require('path');
const { createCore, PASSIVE } = require('./_ontop-core');
const { validate, CHORDS } = require('../features');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${detail})` : name); }

/* A fake Windows: hwnd -> { pid, topmost, alive, name, refuse, deny } and the sidecar's four commands. */
function fakeWindows(wins, opts) {
  const o = opts || {};
  const calls = [];
  const facts = (h) => { const w = wins[h]; return { hwnd: h, pid: w.pid, appPid: w.appPid || w.pid, name: w.name, exe: `${w.name}.exe`, topmost: !!w.topmost, refuse: w.refuse || null }; };
  async function send(cmd, a) {
    calls.push({ cmd, a });
    if (o.down) return { ok: false, error: 'the sidecar is not running' };
    if (cmd === 'ontop.front') return o.fg && wins[o.fg] && wins[o.fg].alive !== false ? { ok: true, result: facts(o.fg) } : { ok: true, result: { hwnd: '0', refuse: 'nothing is in front right now' } };
    const w = wins[a && a.hwnd];
    const gone = !w || w.alive === false || (a.pid && a.pid !== w.pid);
    if (cmd === 'ontop.info') return gone && (!w || w.alive === false) ? { ok: false, error: 'that window has closed' } : { ok: true, result: facts(a.hwnd) };
    if (cmd === 'ontop.check') {
      return { ok: true, result: { windows: a.hwnds.map((x) => { const v = wins[x.hwnd]; const alive = !!v && v.alive !== false && (!x.pid || x.pid === v.pid); return { hwnd: x.hwnd, alive, pid: v ? v.pid : 0, topmost: alive && !!v.topmost }; }) } };
    }
    if (cmd === 'ontop.set') {
      if (gone) return { ok: false, error: w && w.alive !== false ? 'that window has closed (its handle now belongs to another program)' : 'that window has closed' };
      if (o.passive && !w.fixture) return { ok: false, error: `${PASSIVE}: would have kept window ${a.hwnd} on top` };
      if (a.on && w.refuse) return { ok: false, error: w.refuse };
      if (w.deny) return { ok: false, error: w.deny };
      const was = !!w.topmost;
      w.topmost = !!a.on;
      return { ok: true, result: { hwnd: a.hwnd, pid: w.pid, was, topmost: w.topmost, changed: was !== w.topmost, tries: 1 } };
    }
    return { ok: false, error: `unknown command ${cmd}` };
  }
  return { send, calls, opts: o };
}

function core(wins, opts) {
  const fw = fakeWindows(wins, opts);
  const logs = [], saves = [];
  const c = createCore({ send: fw.send, log: (t) => logs.push(t), save: (l) => saves.push(l), test: !!(opts && opts.test) });
  return { c, fw, logs, saves, info: async (h) => (await fw.send('ontop.info', { hwnd: h })).result };
}

(async () => {
  /* ---- pin / unpin ---- */
  {
    const wins = { 100: { pid: 1, name: 'Calculator' } };
    const { c, logs, saves, info } = core(wins);
    const r1 = await c.toggle(await info('100'), 'Win+Ctrl+T');
    check('pin: a normal window is kept on top', r1.did === 'pinned' && r1.ok && r1.text === 'Kept on top: Calculator' && wins[100].topmost === true, JSON.stringify(r1));
    check('pin: recorded and saved', c.size === 1 && saves.length === 1 && saves[0][0].hwnd === '100' && saves[0][0].pid === 1);
    check('pin: ONE log line naming the window (by pid, not by name) and the way', logs.filter((l) => /^kept on top: an app window \(pid 1, window 100\) via Win\+Ctrl\+T$/.test(l)).length === 1, logs.join(' | '));
    const r2 = await c.toggle(await info('100'), 'Win+Ctrl+T');
    check('unpin: the same chord takes it off top', r2.did === 'unpinned' && r2.text === 'No longer on top: Calculator' && wins[100].topmost === false && c.size === 0, JSON.stringify(r2));
    check('unpin: one log line', logs.filter((l) => /^no longer on top: an app window \(pid 1, window 100\) via Win\+Ctrl\+T$/.test(l)).length === 1, logs.join(' | '));
  }

  /* ---- a window that was on top BEFORE Mantle touched it ---- */
  {
    const wins = { 200: { pid: 2, name: 'Task Manager', topmost: true }, 201: { pid: 3, name: 'Notes' } };
    const { c, fw, info } = core(wins);
    const r = await c.toggle(await info('200'), 'Win+Ctrl+T');
    check('prior on top: the chord REFUSES, in words, and leaves it on top', r.did === 'refused' && /already on top/.test(r.text) && /its own setting/.test(r.reason) &&
      wins[200].topmost === true && c.size === 0, JSON.stringify(r));
    check('prior on top: no ontop.set was ever sent for it', !fw.calls.some((x) => x.cmd === 'ontop.set' && x.a.hwnd === '200'));
    const m = await c.set(await info('200'), false, 'menu');
    check('prior on top: "stop" from the menu is refused too (Mantle did not put it there)', m.did === 'refused' && /keeps itself on top/.test(m.text) && wins[200].topmost === true, JSON.stringify(m));
    await c.toggle(await info('201'), 'menu');
    const rel = await c.releaseAll('quit');
    check('prior on top: quit puts back ONLY what Mantle pinned', wins[201].topmost === false && wins[200].topmost === true && rel.put.length === 1, JSON.stringify(rel));
  }

  /* ---- refusals and failures are never silent ---- */
  {
    const wins = { 300: { pid: 4, name: 'Admin Tool', refuse: 'Admin Tool runs as administrator, and Windows does not let Mantle (which does not) change its windows (UIPI)' },
      301: { pid: 5, name: 'Stubborn', deny: 'Windows accepted the change, but Stubborn is still not on top after 3 tries' } };
    const { c, logs, info } = core(wins);
    const a = await c.toggle(await info('300'), 'Win+Ctrl+T');
    check('elevated: refused with the UIPI reason for the pop-up', a.did === 'refused' && a.tone === 'warn' && /administrator/.test(a.reason) && c.size === 0, JSON.stringify(a));
    const b = await c.toggle(await info('301'), 'menu');
    check('a set that did not take: "Couldn\'t keep ... on top" + the sidecar\'s reason, not recorded', b.did === 'failed' && /Couldn’t keep Stubborn on top/.test(b.text) && /still not on top/.test(b.reason) && c.size === 0, JSON.stringify(b));
    check('both logged with their reasons', logs.some((l) => /^refused .*administrator/.test(l)) && logs.some((l) => /^failed .*still not on top/.test(l)), logs.join(' | '));
    const n = await c.toggle({ hwnd: '0', refuse: 'nothing is in front right now' }, 'Win+Ctrl+T');
    check('nothing in front: said, not silent', n.did === 'refused' && /nothing is in front/.test(n.reason));
    // PLAIN WORDS ON SCREEN (lane windows-layouts, 2026-09-29): no UIPI, API names, error numbers or "sidecar"
    check('elevated: the pop-up reason has no jargon', !/UIPI|\(which does not\)/.test(a.reason) && /administrator/.test(a.reason), a.reason);
    check('elevated: ... the log keeps the full reason', logs.some((l) => /UIPI/.test(l)));
  }
  {
    const { plain } = require('./_ontop-core');
    const J = /sidecar|UIPI|SetWindowPos|SetWindowPlacement|GetWindowPlacement|error \d|0x[0-9a-f]|ENOENT|EACCES|hwnd|dryRun|undefined|null|--test|npm/i;
    const samples = [
      'Admin Tool runs as administrator, and Windows does not let Mantle (which does not) change its windows (UIPI)',
      'Notes runs above Mantle (as administrator, or protected), and Windows refused the change (access denied, UIPI)',
      'Windows refused to change Notes (SetWindowPos error 1400)',
      'Windows refused to move Notes (access denied (it runs above Mantle, UIPI))',
      'Windows would not say where the window is (GetWindowPlacement error 5)',
      'could not send "ontop.set" to the sidecar: it is not running (stopped, or restarting)',
      'the sidecar exe is older than "keep on top" (npm run build:sidecar)',
      'unknown command ontop.front',
      PASSIVE + ': would have kept window 5 on top',
      'timed out after 4000 ms',
      undefined, null, '',
    ];
    const out = samples.map(plain);
    check('plain: no jargon survives in any sample', out.every((x) => !J.test(x)), JSON.stringify(out));
    check('plain: every sample still says something', out.every((x) => typeof x === 'string' && x.length > 8), JSON.stringify(out));
    check('plain: administrator stays said', /administrator/.test(out[0]) && /administrator/.test(out[1]));
    check('plain: a helper that is down says to try again', /try again/.test(out[5]) && /try again/.test(out[9]));
    check('plain: an ordinary reason passes through untouched', plain('Notes is not responding, so Windows cannot move it right now') === 'Notes is not responding, so Windows cannot move it right now');
  }

  /* ---- --test: every real window is a dry run ---- */
  {
    const wins = { 400: { pid: 6, name: 'Browser' }, 401: { pid: 7, name: 'fixture', fixture: true } };
    const { c, info } = core(wins, { passive: true, test: true });
    const d = await c.toggle(await info('400'), 'Win+Ctrl+T');
    check('--test: a real window is a DRY RUN, said so, nothing changed', d.did === 'dry' && /^Dry run: would keep Browser on top/.test(d.text) && wins[400].topmost !== true && c.size === 0, JSON.stringify(d));
    const f = await c.toggle(await info('401'), 'Win+Ctrl+T');
    check('--test: the fixture is really pinned', f.did === 'pinned' && wins[401].topmost === true);
  }

  /* ---- clean-up: closed, taken off by someone else, handle reused ---- */
  {
    const wins = { 500: { pid: 8, name: 'Video' }, 501: { pid: 9, name: 'Notes' }, 502: { pid: 10, name: 'Calc' } };
    const { c, fw, saves, logs, info } = core(wins);
    for (const h of ['500', '501', '502']) await c.toggle(await info(h), 'menu');
    wins[500].alive = false;              // closed
    wins[501].topmost = false;            // the app took itself off top
    const sw = await c.sweep();
    check('sweep: a closed window and one taken off top are forgotten', sw.dropped === 2 && c.size === 1 && c.list()[0].hwnd === '502', JSON.stringify(sw));
    check('sweep: saved, logged with why', saves[saves.length - 1].length === 1 && logs.some((l) => /forgot an app window \(pid 8, window 500\): its window closed/.test(l)) && logs.some((l) => /forgot an app window \(pid 9, window 501\): something else took it off top/.test(l)), logs.join(' | '));
    const setsBefore = fw.calls.filter((x) => x.cmd === 'ontop.set').length;
    await c.sweep();
    check('sweep: never re-pins or un-pins anything itself', fw.calls.filter((x) => x.cmd === 'ontop.set').length === setsBefore);
    wins[502].pid = 99;                   // the handle now belongs to another program
    const rel = await c.releaseAll('quit');
    check('reused handle: releaseAll never touches the other program\'s window', wins[502].topmost === true && rel.closed === 1 && rel.put.length === 0, JSON.stringify(rel));
  }

  /* ---- rest: off top while a game runs, back after ---- */
  {
    const wins = { 600: { pid: 11, name: 'Video' }, 601: { pid: 12, name: 'Notes' }, 602: { pid: 13, name: 'Calc' } };
    const { c, info, logs } = core(wins);
    for (const h of ['600', '601', '602']) await c.toggle(await info(h), 'menu');
    const saved = await c.suspend('VALORANT runs');
    check('rest: every pin goes off top (the game is never covered) and the list is kept', saved.length === 3 && [600, 601, 602].every((h) => wins[h].topmost === false) && c.size === 0, JSON.stringify(saved));
    wins[601].alive = false;              // closed during the game
    wins[602].topmost = true;             // went on top by itself during the game
    const r = await c.resume(saved, 'the game');
    check('wake: the still-open one is on top again and Mantle\'s again', r.back.join() === 'Video' && wins[600].topmost === true && c.size === 1, JSON.stringify(r));
    check('wake: a closed one and a self-pinned one are skipped, with why', r.skipped.length === 2 && r.skipped.some((s) => /Notes: it closed/.test(s)) && r.skipped.some((s) => /Calc: already on top by itself/.test(s)), JSON.stringify(r.skipped));
    check('wake: one summary line', logs.some((l) => /after the game: 1 of 3 window\(s\) on top again; not:/.test(l)), logs.join(' | '));
  }

  /* ---- after a crash: pins a dead Mantle left on top are KEPT (lane windows-layouts, 2026-09-29).
     They used to be taken off top, with only a log line: the video Owen pinned dropped behind with no
     word. They are Owen's choice, so the next Mantle takes them over: still on top, badge back. ---- */
  {
    const wins = { 700: { pid: 14, name: 'A', topmost: true }, 701: { pid: 15, name: 'B', topmost: true }, 702: { pid: 16, name: 'C', topmost: false } };
    const { c, fw, logs } = core(wins);
    const r = await c.adopt([{ hwnd: '700', pid: 14, name: 'A' }, { hwnd: '701', pid: 999, name: 'B-old' }, { hwnd: '702', pid: 16, name: 'C' }, { hwnd: '703', pid: 17, name: 'gone' }]);
    check('adopt: a left-over pin still on top stays on top and is known to Mantle again', wins[700].topmost === true && r.kept === 1 && c.size === 1 && c.list()[0].hwnd === '700', JSON.stringify(r));
    check('adopt: ... with no ontop.set sent at all', !fw.calls.some((x) => x.cmd === 'ontop.set'));
    check('adopt: one that went off top meanwhile is not taken over', !c.list().some((p) => p.hwnd === '702'));
    check('adopt: a reused handle (other pid) is left alone', wins[701].topmost === true);
    check('adopt: logged in words', logs.some((l) => /previous Mantle left 4 window\(s\) kept on top: 1 still on top, kept/.test(l)), logs.join(' | '));
    const none = await c.adopt([]);
    check('adopt: nothing saved = nothing sent', none.kept === 0);
  }

  /* ---- privacy: no app name and no exe in ANY log line (lane r7-names, 2026-10-01; BRIEF: no window
     titles or app names in logs). Every path that logs runs once with fake "Zq ..." names; the pop-up
     text may still name the app (it is on screen), the log may not. ---- */
  {
    const leaks = (ls) => ls.filter((l) => /zq|\.exe/i.test(l));
    const wins = {
      1001: { pid: 41, name: 'Zq Diary' },
      1002: { pid: 42, name: 'Zq Admin', refuse: 'Zq Admin runs as administrator, so Windows doesn’t let Mantle keep it on top' },
      1003: { pid: 43, name: 'Zq Sidecar Name', refuse: 'Zq Sidecar Name is not responding, so Windows cannot move it right now' },
      1004: { pid: 44, name: 'Zq Deny', deny: 'Windows refused to change Zq Deny (it may be closing, or protected)' },
      1005: { pid: 45, name: 'Zq Pip', topmost: true },
      1006: { pid: 46, name: 'Zq Loose' },
      1007: { pid: 47, name: 'Zq Stuck' },
      1008: { pid: 48, name: 'Zq Closes' },
      1009: { pid: 49, name: 'Zq Reused' },
      1010: { pid: 50, name: 'Zq Video' },
      1011: { pid: 51, name: 'Zq Gone' },
      1012: { pid: 52, name: 'Zq Stubborn', deny: 'Windows accepted the change, but Zq Stubborn is still not on top after 3 tries' },
    };
    const { c, logs, info } = core(wins);
    const r1 = await c.toggle(await info('1001'), 'Win+Ctrl+T');
    check('privacy: the pop-up still names the app', r1.did === 'pinned' && r1.text === 'Kept on top: Zq Diary', JSON.stringify(r1));
    await c.toggle(await info('1001'), 'Win+Ctrl+T');                                  // unpin
    await c.toggle(await info('1002'), 'Win+Ctrl+T');                                  // refused: administrator
    const bar = Object.assign(await info('1003'), { name: 'Zq Bar Name' });            // the bar's name, the sidecar's reason
    await c.set(bar, true, 'menu');
    await c.toggle(await info('1004'), 'menu');                                        // failed: Windows refused
    await c.toggle(await info('1012'), 'menu');                                        // failed: still not on top
    await c.toggle(await info('1005'), 'menu');                                        // already on top by itself
    await c.set(await info('1005'), false, 'menu');                                    // keeps itself on top
    await c.set(await info('1006'), false, 'menu');                                    // not kept on top
    await c.toggle(await info('1007'), 'menu');
    wins[1007].deny = 'Windows refused to change Zq Stuck (it may be closing, or protected)';
    const stuck = await c.toggle(await info('1007'), 'menu');                          // unpin fails
    check('privacy: (an unpin that fails still says so on screen)', stuck.did === 'failed' && /Zq Stuck/.test(stuck.text), JSON.stringify(stuck));
    await c.toggle(await info('1008'), 'menu');
    wins[1008].alive = false;
    await c.set({ hwnd: '1008', pid: 48, name: 'Zq Closes' }, false, 'menu');          // closed while pinned
    await c.toggle(await info('1009'), 'menu');
    wins[1009].pid = 99;                                                               // handle reused
    await c.toggle(await info('1009'), 'menu');
    await c.releaseAll('test');                                                        // Zq Stuck still denies
    delete wins[1007].deny;
    await c.toggle(await info('1010'), 'menu');
    await c.toggle(await info('1011'), 'menu');
    const saved = await c.suspend('a game');
    wins[1010].refuse = 'Zq Video is not showing (hidden, or on another desktop)';
    wins[1011].alive = false;
    const back = await c.resume(saved, 'the game');
    check('privacy: (the wake toast still names the app it could not put back)', back.skipped.some((s) => /^Zq Video: /.test(s)), JSON.stringify(back));
    await c.toggle(await info('1006'), 'menu');
    wins[1006].alive = false;
    await c.sweep();                                                                   // forgot: closed
    const dry = core({ 1020: { pid: 60, name: 'Zq Dry' } }, { test: true, passive: true });
    await dry.c.toggle(await dry.info('1020'), 'Win+Ctrl+T');                          // dry run
    const all = logs.concat(dry.logs);
    check('privacy: every path above logged', all.length >= 18, `${all.length} lines`);
    check('privacy: no log line names the app or its exe', leaks(all).length === 0, leaks(all).join(' | '));
    check('privacy: the log still says what happened, by pid', all.some((l) => /^refused \(Win\+Ctrl\+T\): Can’t keep the window on top: the window runs as administrator/.test(l))
      && all.some((l) => /^failed \(menu\): Couldn’t keep the window on top: Windows refused to change the window \(it may be closing/.test(l))
      && all.some((l) => /COULD NOT put back an app window \(pid 47, window 1007\): Windows refused to change the window/.test(l))
      && all.some((l) => /not: an app window \(pid 50, window 1010\): the window is not showing/.test(l)), all.join(' | '));
  }

  /* ---- sweep: one at a time (lane windows-layouts, 2026-09-29). The timer ticks every 2 s and a check
     may wait 4 s for a slow sidecar: overlapping checks stacked up. A second sweep while one runs
     returns at once and sends nothing. ---- */
  {
    const wins = { 900: { pid: 30, name: 'Slow' } };
    const fw = fakeWindows(wins);
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = async (cmd, a) => { if (cmd === 'ontop.check') await gate; return fw.send(cmd, a); };
    const c = createCore({ send: slow, log: () => {}, save: () => {} });
    await c.toggle((await fw.send('ontop.info', { hwnd: '900' })).result, 'test');
    const s1 = c.sweep();
    const s2 = await c.sweep();
    check('sweep: a second sweep while one is running sends nothing', s2.busy === true && fw.calls.filter((x) => x.cmd === 'ontop.check').length === 0, JSON.stringify(s2));
    release();
    const r1 = await s1;
    check('sweep: the first one still finishes', r1.checked === 1, JSON.stringify(r1));
    const r3 = await c.sweep();
    check('sweep: and the next one runs again', r3.checked === 1 && !r3.busy);
  }

  /* ---- the feature module: contract, chord, menu, stop, rest -> wake, tray off ---- */
  {
    const mod = require('./ontop');
    check('feature: meets the contract (validate)', validate(mod, 'ontop') === null, validate(mod, 'ontop'));
    check('feature: takes exactly Win+Ctrl+T, a chord the seam and the sidecar know', mod.chords.join() === 'Win+Ctrl+T' && CHORDS.includes('Win+Ctrl+T') && mod.rest === true);

    const wins = { 800: { pid: 20, name: 'Video' }, 801: { pid: 21, name: 'PiP', topmost: true }, 802: { pid: 22, name: 'Notes' }, 803: { pid: 30, appPid: 31, name: 'Calculator' } };
    const fwOpts = { fg: '800' };
    const fw = fakeWindows(wins, fwOpts);
    const store = {};
    function fakeCtx() {
      const h = { chords: {}, cmds: {}, enabledFns: [], ready: [], logs: [], pushes: [] , enabled: true };
      const ctx = {
        name: 'ontop', flags: Object.freeze({ test: false, live: true }),
        log: (t) => h.logs.push(t), health: () => {},
        sidecar: { send: (c, a) => fw.send(c, a || {}), onReady: (fn) => { h.ready.push(fn); fn(); return () => {}; }, on: () => () => {}, ready: true },
        command: (v, fn) => { h.cmds[v] = fn; return `ontop.${v}`; },
        onChord: (c, fn) => { h.chords[c] = fn; return () => {}; },
        enabled: () => h.enabled, onEnabled: (fn) => { h.enabledFns.push(fn); return () => {}; },
        replay: () => {}, broadcast: (ev, p) => h.pushes.push({ ev, p }), push: () => false,
        page: (f) => path.join(__dirname, '..', '..', 'ui', 'ontop', f || 'index.html'), preload: '',
        settings: { get: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
        host: { display: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), barRect: () => null },
        test: null,
      };
      return { ctx, h };
    }
    const tick = () => new Promise((r) => setTimeout(r, 20));
    let { ctx, h } = fakeCtx();
    let handle = mod.install(ctx);
    await tick();
    await h.chords['Win+Ctrl+T']('Win+Ctrl+T');
    check('feature: the chord keeps the window in front on top', wins[800].topmost === true, JSON.stringify(wins[800]));
    check('feature: the bar hears the new state', h.pushes.some((x) => x.ev === 'ontop.state' && x.p.pinned.length === 1 && x.p.pinned[0].hwnd === '800'));
    check('feature: the pin is saved for crash tidy-up', Array.isArray(store.pins) && store.pins.length === 1 && store.pins[0].pid === 20);
    const menu = await h.cmds.set({ hwnd: '801', on: true, name: 'Picture in picture' });
    check('feature: the menu on a self-pinned window is refused with the bar\'s name', menu.ok === false && menu.did === 'refused' && /Picture in picture is already on top/.test(menu.text), JSON.stringify(menu));
    // HANDLE REUSE (security review #19): the bar sends the pid it knew; a window that is now another
    // program's (Windows reused the handle) is refused, and nothing is pinned.
    const logsBefore = h.logs.length;
    const reused = await h.cmds.set({ hwnd: '802', on: true, pid: 999, name: 'Old app' });
    check('feature: a pid that no longer matches the handle is refused, in words', reused.ok === false && reused.did === 'refused' &&
      reused.text === 'That window has closed' && reused.reason === 'its handle now belongs to another program' && reused.tone === 'warn', JSON.stringify(reused));
    check('...and that window was NOT put on top', !wins[802].topmost && !store.pins.some((p) => p.hwnd === '802'));
    check('...and the log says why (no window name in it)', h.logs.slice(logsBefore).some((l) => l === 'refused (menu): That window has closed: its handle now belongs to another program'), h.logs.slice(logsBefore).join(' | '));
    const same = await h.cmds.set({ hwnd: '802', on: true, pid: 22, name: 'Notes' });
    check('feature: the matching pid pins as before', same.ok === true && same.did === 'pinned' && wins[802].topmost === true, JSON.stringify(same));
    const back = await h.cmds.set({ hwnd: '802', on: false, pid: 22 });
    check('feature: ...and the matching pid puts it back', back.ok === true && wins[802].topmost === false, JSON.stringify(back));
    const store1 = await h.cmds.set({ hwnd: '803', on: true, pid: 31, name: 'Calculator' });
    check('feature: a Store app window (frame host pid 30) matches its APP pid (31), as the bar knows it', store1.ok === true && wins[803].topmost === true, JSON.stringify(store1));
    await h.cmds.set({ hwnd: '803', on: false, pid: 30 });
    check('feature: ...or the frame host own pid', wins[803].topmost === false);
    const nopid = await h.cmds.set({ hwnd: '802', on: true });
    check('feature: no pid sent (an older bar) = no extra check', nopid.ok === true && wins[802].topmost === true, JSON.stringify(nopid));
    await h.cmds.set({ hwnd: '802', on: false });
    // rest: stop(rest) -> off top; install again (wake) -> back on top
    await handle.stop('VALORANT runs', { rest: true });
    check('feature rest: the pinned window is off top while the game runs', wins[800].topmost === false && wins[801].topmost === true);
    ({ ctx, h } = fakeCtx());
    handle = mod.install(ctx);
    await tick();
    check('feature wake: the pin is back on top, and Mantle\'s again', wins[800].topmost === true && store.pins.length === 1, JSON.stringify(store.pins));
    // tray off: everything Mantle pinned goes back
    h.enabled = false;
    for (const fn of h.enabledFns) fn(false);
    await tick();
    check('feature: switched off in the tray = put back', wins[800].topmost === false && wins[801].topmost === true);
    const off = await h.cmds.set({ hwnd: '800', on: true });
    check('feature: while off, the menu says so', off.ok === false && /switched off/.test(off.reason));
    h.enabled = true;
    await h.chords['Win+Ctrl+T']('Win+Ctrl+T');
    check('feature: on again, pinned again', wins[800].topmost === true);
    // quit: stop() puts back every Mantle pin
    await handle.stop('quit');
    check('feature quit: every Mantle pin put back, the self-pinned one untouched', wins[800].topmost === false && wins[801].topmost === true && store.pins.length === 0);
    // a crash: pins saved, no stop(); the next start keeps them on top and knows them
    ({ ctx, h } = fakeCtx());
    handle = mod.install(ctx);
    await tick();
    await h.chords['Win+Ctrl+T']('Win+Ctrl+T');
    check('crash: pinned and saved', wins[800].topmost === true && store.pins.length === 1);
    ({ ctx, h } = fakeCtx());                        // "Mantle restarted" (no stop() ran)
    handle = mod.install(ctx);
    await tick(); await tick();
    check('crash: the next start keeps the left-over pin on top', wins[800].topmost === true, JSON.stringify(wins[800]));
    check('crash: ... and the bar hears it again (badge back)', h.pushes.some((x) => x.ev === 'ontop.state' && x.p.pinned.length === 1 && x.p.pinned[0].hwnd === '800'));
    check('crash: and says so in the log', h.logs.some((l) => /previous Mantle left 1 window\(s\) kept on top: 1 still on top, kept/.test(l)), h.logs.join(' | '));
    await h.chords['Win+Ctrl+T']('Win+Ctrl+T');
    check('crash: Win+Ctrl+T then takes it off top as usual', wins[800].topmost === false);
    await handle.stop('test over');
  }

  console.log(`ONTOP UNIT TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length || !passed ? 1 : 0);
})().catch((e) => { console.log('ONTOP UNIT TEST: threw ' + (e && e.stack)); process.exit(1); });

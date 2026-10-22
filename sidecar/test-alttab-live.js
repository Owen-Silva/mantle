// test-alttab-live.js - the Alt+Tab list follows windows that open, close, minimise or cloak while the
// switcher is up (sidecar/AltTabLive.cs). Lane mn-alttab, 2026-10-12.
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-alttab-live.js
//
// A PASSIVE sidecar (no keyboard hook), so nothing is pressed and nothing is switched:
//   1. the merge rules on made-up lists (switcher.rehearse {op:'merge'}): places kept, new windows
//      after their neighbour and never before the window Alt+Tab came from, the selection kept by
//      handle or moved to the neighbour that slid into its place;
//   2. a REAL session on the live desktop (switcher.rehearse {op:'open'}) while this test's OWN
//      windows (sidecar/alttab-probe.js: invisible, never activated, on no bar) open, minimise,
//      cloak and close: every change arrives as one `windows` event, the selection stays put;
//   3. nothing at all once the session is down: the hooks are out and a window opening sends nothing.
// PRIVACY: the live list holds the user's window titles. Nothing here prints a title; failures print
// counts and the probe's own handles only.
//
// Prints one summary line, "ALTTAB LIVE TEST: n passed, m failed".
'use strict';

const T = require('./test-lib');
const Probe = require('./alttab-probe');

const sleep = T.sleep;

(async () => {
  const t = T.checker('ALTTAB LIVE');
  let s = null;
  let p = null;
  try {
    s = await T.startPassive();
    const ping = await s.call('ping', {}, 4000);
    const cmds = (ping.features && ping.features.commands) || [];
    t.check('ping lists switcher.rehearse', cmds.includes('switcher.rehearse'), String(cmds.length));

    /* ---- 1. the merge, pure ------------------------------------------------------------------- */
    const merge = (o) => s.call('switcher.rehearse', Object.assign({ op: 'merge' }, o), 4000);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const M = async (name, args, list, sel, extra) => {
      const r = await merge(args);
      const ok = same(r.list, list) && r.sel === sel && (!extra || extra(r));
      t.check(`merge: ${name}`, ok, JSON.stringify(r));
    };
    await M('nothing changed: same list, same selection, no update', { old: [1, 2, 3], fresh: [1, 2, 3], sel: 1 }, ['1', '2', '3'], 1, (r) => r.changed === false);
    await M('a reshuffle of most-recent order alone moves nothing on screen', { old: [1, 2, 3], fresh: [2, 3, 1], sel: 1 }, ['1', '2', '3'], 1, (r) => r.changed === false);
    await M('another window closes: the selection stays on the same window', { old: [1, 2, 3, 4], fresh: [1, 3, 4], sel: 2 }, ['1', '3', '4'], 1, (r) => r.changed && r.removed === 1);
    await M('the selected window closes: its neighbour slides in and is selected', { old: [1, 2, 3, 4], fresh: [1, 3, 4], sel: 1 }, ['1', '3', '4'], 1);
    await M('the selected LAST window closes: the one before it', { old: [1, 2, 3], fresh: [1, 2], sel: 2 }, ['1', '2'], 1);
    await M('two close at once, the selected and the next: the next survivor', { old: [1, 2, 3, 4], fresh: [1, 4], sel: 1 }, ['1', '4'], 1);
    await M('everything closes: no selection', { old: [1, 2], fresh: [], sel: 1 }, [], -1, (r) => r.changed && r.removed === 2);
    await M('from nothing, a window opens: it is selected', { old: [], fresh: [7], sel: -1 }, ['7'], 0, (r) => r.added === 1);
    await M('a new foreground window goes after the window Alt+Tab came from, not before it', { old: [1, 2, 3], fresh: [9, 1, 2, 3], sel: 1, pin: 1 }, ['1', '9', '2', '3'], 2, (r) => r.added === 1);
    await M('with no window to come back to, a new first window goes first', { old: [1, 2, 3], fresh: [9, 1, 2, 3], sel: 0, pin: 0 }, ['9', '1', '2', '3'], 1);
    await M('a new window goes after its neighbour in the fresh order', { old: [1, 2, 3], fresh: [1, 2, 9, 3], sel: 2 }, ['1', '2', '9', '3'], 3);
    await M('a new window at the end', { old: [1, 2], fresh: [1, 2, 9], sel: 1 }, ['1', '2', '9'], 1);
    await M('a title change is an update, in place', { old: [1, 2], fresh: [1, 2], sel: 0, titles: { 2: 'renamed' } }, ['1', '2'], 0, (r) => r.changed === true && r.added === 0 && r.removed === 0);
    await M('a minimise is an update, in place', { old: [1, 2], fresh: [1, 2], sel: 1, min: [2] }, ['1', '2'], 1, (r) => r.changed === true);
    await M('one closes and one opens in the same burst', { old: [1, 2, 3], fresh: [1, 3, 9], sel: 2 }, ['1', '3', '9'], 1);

    /* ---- 2. a real session, this test's own windows ----------------------------------------- */
    p = await Probe.start();
    const evs = () => s.collect('switcher');
    const mark = () => evs().length;
    const since = (n) => evs().slice(n);
    const windowsSince = (n) => since(n).filter((e) => e.op === 'windows');
    const until = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(20); } };
    const hw = (e) => (e.list || []).map((it) => String(it.hwnd));
    const selHwnd = (e) => (e.sel >= 0 && e.list && e.list[e.sel] ? String(e.list[e.sel].hwnd) : null);

    let m0 = mark();
    const open = await s.call('switcher.rehearse', { op: 'open' }, 6000);
    t.check('a rehearsal session opens with all four window-change hooks', open.hooks === 4, JSON.stringify({ hooks: open.hooks }));
    const opened = await until(() => since(m0).find((e) => e.op === 'open' && e.seq === open.seq), 2000);
    t.check('it says `open`, like a real Alt+Tab, with the live list', !!opened && Array.isArray(opened.list) && opened.rehearsal === true);
    let list = opened ? hw(opened) : [];
    const seq = open.seq;

    // A: opens while the switcher is up
    m0 = mark();
    let t0 = Date.now();
    const A = await p.open(1);
    let e = await until(() => windowsSince(m0).find((x) => hw(x).includes(A)), 2500);
    const msA = Date.now() - t0;
    t.check(`a window that opens appears in the list (${msA} ms)`, !!e && e.seq === seq, `probe ${A}`);
    t.check('...within half a second', !!e && msA <= 500, `${msA} ms`);
    t.check('...in ONE update, not one per WinEvent', windowsSince(m0).length === 1, `${windowsSince(m0).length} updates`);
    if (e) {
      const keptOrder = list.filter((h) => hw(e).includes(h));
      t.check('...and every window already there keeps its place', same(hw(e).filter((h) => h !== A), keptOrder), `${hw(e).length} vs ${list.length}`);
      list = hw(e);
    }

    // select A (what Tab does), then B opens: the selection stays on A
    m0 = mark();
    await s.call('switcher.rehearse', { op: 'select', hwnd: A }, 4000);
    e = await until(() => since(m0).find((x) => x.op === 'move'), 2000);
    t.check('select moves the selection to the window asked for', !!e && list[e.sel] === A, e ? String(e.sel) : 'no move');
    m0 = mark();
    const B = await p.open(2);
    e = await until(() => windowsSince(m0).find((x) => hw(x).includes(B)), 2500);
    t.check('a second window appears', !!e, `probe ${B}`);
    t.check('...and the selection stays on the window it was on', !!e && selHwnd(e) === A, e ? `sel ${selHwnd(e)}, want ${A}` : '');
    if (e) list = hw(e);

    // minimise and restore A: in place, flag follows
    m0 = mark();
    await p.min(1);
    e = await until(() => windowsSince(m0).find((x) => x.list.some((it) => String(it.hwnd) === A && it.minimized)), 2500);
    t.check('minimising a window updates it in place (minimized: true)', !!e && same(hw(e), list), e ? '' : 'no update');
    t.check('...and the selection stays on it', !!e && selHwnd(e) === A);
    m0 = mark();
    await p.restore(1);
    e = await until(() => windowsSince(m0).find((x) => x.list.some((it) => String(it.hwnd) === A && !it.minimized)), 2500);
    t.check('restoring it updates it back (minimized: false)', !!e && same(hw(e), list));

    // a title change, in place
    m0 = mark();
    await p.title(2, 'Mantle Alt+Tab probe 2 renamed');
    e = await until(() => windowsSince(m0).find((x) => x.list.some((it) => String(it.hwnd) === B && /renamed$/.test(it.title))), 2500);
    t.check('a title change updates the tile in place', !!e && same(hw(e), list) && selHwnd(e) === A);

    // cloak A (selected): it leaves, the selection goes to its neighbour; uncloak: it comes back
    const iA = list.indexOf(A);
    const want = list[iA + 1] || list[iA - 1] || null;
    m0 = mark();
    await p.cloak(1);
    e = await until(() => windowsSince(m0).find((x) => !hw(x).includes(A)), 2500);
    t.check('a cloaked window leaves the list', !!e);
    t.check('...and the selection moves to the neighbour that slid into its place', !!e && selHwnd(e) === want, e ? `sel ${selHwnd(e)}, want ${want}` : '');
    m0 = mark();
    await p.uncloak(1);
    e = await until(() => windowsSince(m0).find((x) => hw(x).includes(A)), 2500);
    t.check('uncloaked, it comes back', !!e);
    t.check('...and the selection stays where it went', !!e && selHwnd(e) === want);
    if (e) list = hw(e);

    // B closes (not selected): selection kept on want
    m0 = mark();
    await p.close(2);
    e = await until(() => windowsSince(m0).find((x) => !hw(x).includes(B)), 2500);
    t.check('a window that closes leaves the list', !!e, `probe ${B}`);
    t.check('...the selection is kept', !!e && selHwnd(e) === (want === B ? (list[list.indexOf(B) + 1] || list[list.indexOf(B) - 1]) : want));
    t.check('...and nothing else moved', !!e && same(hw(e), list.filter((h) => h !== B)));
    if (e) list = hw(e);

    // select A and close it: the neighbour
    m0 = mark();
    await s.call('switcher.rehearse', { op: 'select', hwnd: A }, 4000);
    await until(() => since(m0).find((x) => x.op === 'move'), 2000);
    const i2 = list.indexOf(A);
    const want2 = list[i2 + 1] || list[i2 - 1] || null;
    m0 = mark();
    await p.close(1);
    e = await until(() => windowsSince(m0).find((x) => !hw(x).includes(A)), 2500);
    t.check('the SELECTED window closes: it leaves', !!e);
    t.check('...and the selection is on its neighbour', !!e && selHwnd(e) === want2, e ? `sel ${selHwnd(e)}, want ${want2}` : '');

    const st = await s.call('switcher.rehearse', { op: 'status' }, 4000);
    t.check('status: open, the hooks in, updates counted', st.open === true && st.hooks === 4 && st.updates >= 7, JSON.stringify(st));

    // quiet: an update only ever carries a change. (the user's own windows can change while this runs, a
    // title that ticks, so "no update at all" cannot be asserted on a live desktop; "no EMPTY update" can.)
    await sleep(600);
    const face = (x) => JSON.stringify((x.list || []).map((it) => [String(it.hwnd), it.title, !!it.minimized, !!it.hung]));
    const sessEvs = evs().filter((x) => x.seq === seq && (x.op === 'open' || x.op === 'windows'));
    let empty = 0;
    for (let i = 1; i < sessEvs.length; i++) if (face(sessEvs[i]) === face(sessEvs[i - 1])) empty++;
    t.check(`every update carries a change (${sessEvs.length - 1} updates, none empty)`, empty === 0, `${empty} empty`);

    /* ---- 3. down: nothing ---------------------------------------------------------------------- */
    m0 = mark();
    const cl = await s.call('switcher.rehearse', { op: 'close' }, 6000);
    t.check('closing ends the session and takes every hook out', cl.closed === true && cl.hooks === 0, JSON.stringify(cl));
    t.check('...and says cancel', !!(await until(() => since(m0).find((x) => x.op === 'cancel' && x.seq === seq), 2000)));
    const marks0 = (await s.call('switcher.rehearse', { op: 'status' }, 4000)).marks;
    m0 = mark();
    await p.open(3);
    await sleep(500);
    await p.close(3);
    await sleep(400);
    const st2 = await s.call('switcher.rehearse', { op: 'status' }, 4000);
    t.check('switcher down: a window opening and closing sends nothing', windowsSince(m0).length === 0, `${windowsSince(m0).length} updates`);
    t.check('...and no hook even saw it (none is installed)', st2.hooks === 0 && st2.marks === marks0 && st2.open === false, JSON.stringify(st2));

    // a second session works the same (hooks back in)
    const o2 = await s.call('switcher.rehearse', { op: 'open' }, 6000);
    m0 = mark();
    const C = await p.open(4);
    e = await until(() => windowsSince(m0).find((x) => hw(x).includes(C)), 2500);
    t.check('a second session follows windows too', o2.hooks === 4 && !!e && e.seq === o2.seq);
    await p.close(4);
    await s.call('switcher.rehearse', { op: 'close' }, 6000);

    // refusals in words
    let err = null;
    try { await s.call('switcher.rehearse', { op: 'select', hwnd: '1' }, 4000); } catch (x) { err = x.message; }
    t.check('select with no session open says so', /no rehearsal open/.test(err || ''), err);
    err = null;
    try { await s.call('switcher.rehearse', { op: 'nope' }, 4000); } catch (x) { err = x.message; }
    t.check('an unknown op lists the real ones', /open, select, close, status, merge/.test(err || ''), err);
  } catch (err) {
    t.fail('the test ran to the end', err && err.message);
  } finally {
    if (p) p.quit();
    if (s) { try { await s.call('switcher.rehearse', { op: 'close' }, 4000); } catch (_) { /* none open */ } await s.stop(); }
  }
  process.exitCode = t.summary();
})();

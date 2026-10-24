'use strict';
/*
 * _maxfold-selftest.js - the maximize unfold proving itself inside ONE Electron --test instance
 * (lane unfold-max, 2026-10-23). Loaded ONLY by lib/features/maxfold.js, and only when
 * ctx.flags.test && MANTLE_MAXFOLD_SELFTEST=1. Driven by lib/features/maxfold.e2e.test.js.
 *
 * WHAT IT DRIVES: the REAL feature (its own apply(why) path, its event counts, its maxfold.state
 * command through a real Mantle page's window.mantle.call) and the REAL passive sidecar
 * (sidecar/MaxFold.cs), on ONE invisible test window (sidecar/maxfold-testwin.js, started from this
 * Electron MAIN process so the passive sidecar counts it as the harness's own). Nothing the user owns
 * is touched: the window is alpha 0, click-through, disabled, never activated; the overlay is
 * invisible in --test; the foreground window's handle is read before and after and must not change.
 *
 * Results: one mantle.log line "maxfold: SELFTEST n passed, m failed" and
 * %TEMP%\mantle-maxfold\selftest.json {at, passed, failed, skipped, checks:[{name, ok, detail}], numbers}.
 * Only numbers and the sidecar's own plain-word reasons are written: never a window title, app or path.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'mantle-maxfold', 'selftest.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESTORE_SELF = 'Windows animates this restore itself';
const NOT_OURS = 'a test run only animates its own test windows';
// a reason is free text from another process: only the feature's own known phrases are written anywhere
const clean = (r) => { try { return require('./maxfold.js')._cleanReason(r); } catch (_) { return 'another reason'; } };
const FULLSCREEN = 'a full-screen app or game is running';
const LAYERED = 0x80000, TRANSPARENT = 0x20, NOACTIVATE = 0x8000000, TOOLWINDOW = 0x80;

let halt = false;
let win = null;   // the test window, closed in stop() if the run did not get there
let offEv = null;
const logged = [];   // what the feature passed to ctx.log during this run (see start)

/** The --log=<file> this instance tees to (the e2e driver passes one), or null. */
function logFile() {
  const a = process.argv.slice(1).find((x) => typeof x === 'string' && x.startsWith('--log='));
  return a ? a.slice('--log='.length).replace(/^"|"$/g, '') : null;
}

/**
 * k = { ctx, apply(why) -> Promise<{ok, result|error}>, counts (the feature's live counts object) }
 */
function start(k) {
  halt = false;
  // the lines the feature hands its log (--test only): run-suite starts selftests without --log=<file>,
  // so with no file to read, the done-line check reads these instead of failing for want of a file
  logged.length = 0;
  if (k && k.ctx && typeof k.ctx.log === 'function' && !k.ctx.log.__selftestTap) {
    const orig = k.ctx.log;
    const tap = function (text) { logged.push(String(text)); if (logged.length > 400) logged.shift(); return orig.apply(this, arguments); };
    tap.__selftestTap = true;
    k.ctx.log = tap;
  }
  run(k).catch((e) => { try { k.ctx.log(`SELFTEST threw: ${e && e.stack ? e.stack : e}`); } catch (_) { /* stopped */ } });
}

async function run(k) {
  const { ctx } = k;
  const checks = [];
  const numbers = { plays: [], winAnim: null, reduced: null, cancelledRetries: 0 };
  let skipped = null;
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: ok ? undefined : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });
    return !!ok;
  };
  const W = require('../../sidecar/maxfold-testwin');

  // our own listener beside the feature's (an EventEmitter: a second one is allowed); never throws,
  // so it can never mark the feature unhealthy
  const events = [];
  const waiters = [];
  offEv = ctx.sidecar.on('maxfold', (ev) => {
    try {
      const e = ev || {};
      events.push(e);
      for (const w of waiters.slice()) if (w.test(e)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(e); }
    } catch (_) { /* never */ }
  });
  /** the next event (after now) of kind done/skip, for this action */
  const nextEnd = (action, ms) => new Promise((resolve) => {
    // events carry no window handle (privacy): a skip for someone else's window (the user maximizing an
    // app while this runs) says NOT_OURS and is never taken for the test window's answer
    const w = { test: (e) => (e.kind === 'done' || (e.kind === 'skip' && e.reason !== NOT_OURS)) && e.action === action, resolve, t: null };
    w.t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(null); }, ms);
    waiters.push(w);
  });
  const state = async () => { const r = await ctx.sidecar.send('maxfold.state', {}, { timeoutMs: 3000 }); return r.ok ? r.result : { error: r.error }; };
  const fg = async () => { try { return (await win.cmd('fg', 'FG', 4000)).replace(/^FG\s+/, ''); } catch (e) { return `unread (${e.message})`; } };
  const info = async (hwnd) => { try { return W.parseInfo(await win.cmd(`info ${hwnd}`, 'INFO', 4000)); } catch (e) { return null; } };
  const pick = (e) => (e ? { action: e.action, firstFrameMs: e.firstFrameMs, queueMs: e.queueMs, frames: e.frames, gapMedMs: e.gapMedMs,
    gapMaxMs: e.gapMaxMs, over20: e.over20, missedDelta: e.missedDelta, totalMs: e.totalMs, endedSharp: e.endedSharp, cancelled: e.cancelled, mode: e.mode } : null);

  /** send max/restore and wait for its done/skip; a play cancelled by the user's input is tried again (max 3) */
  async function act(line, action, undo) {
    for (let t = 0; t < 3 && !halt; t++) {
      const end = nextEnd(action, 4000);
      let ans = '';
      try { ans = await win.cmd(line, 'OK', 6000); } catch (e) { ans = `ERR ${e.message}`; }
      const ev = await end;
      if (ev && ev.kind === 'done' && ev.cancelled && t < 2 && undo) {
        numbers.cancelledRetries++;
        const back = nextEnd(undo.action, 4000);
        try { await win.cmd(undo.line, 'OK', 6000); } catch (_) { /* judged below */ }
        await back; await sleep(400);
        continue;
      }
      return { ans, ev };
    }
    return { ans: 'halted', ev: null };
  }

  try {
    for (let i = 0; i < 300 && !ctx.sidecar.ready && !halt; i++) await sleep(100);
    if (!check('the sidecar came up', ctx.sidecar.ready, 'not ready after 30 s')) return;

    // 1. the feature's own apply path: armed + hooked + passive in --test
    const cfg = await k.apply('selftest start');
    const c = (cfg && cfg.ok && cfg.result) || {};
    numbers.winAnim = c.winAnim; numbers.reduced = c.reduced;
    check('config (the feature\'s apply): armed, hooked and passive in --test', cfg && cfg.ok && c.armed === true && c.hooked === true && c.passive === true,
      cfg && cfg.ok ? { armed: c.armed, hooked: c.hooked, passive: c.passive, why: c.why } : (cfg && cfg.error));
    const s0 = await state();
    check('state: the overlay is invisible in --test', s0.invisible === true, { invisible: s0.invisible, error: s0.error });
    check('state: the thread runs while armed', s0.thread === 'running', { thread: s0.thread });

    // 2. the test window (a child of this Electron main = the harness's own)
    win = await W.start({ exe: process.env.MANTLE_MAXFOLD_TESTWIN || undefined, mode: 'normal', life: 120 });
    check('the test window started', !!win.hwnd, 'no handle');
    const fg0 = await fg();
    try { await win.cmd('seed', 'OK', 4000); } catch (e) { check('seed', false, e.message); }
    await sleep(300);

    // 3. maximize -> a done play
    const m1 = await act('max', 'maximize', { line: 'restore', action: 'restore' });
    if (m1.ev && m1.ev.kind === 'skip' && m1.ev.reason === FULLSCREEN) {
      skipped = `the sidecar skipped the play: ${FULLSCREEN} (Windows says so; nothing to judge)`;
      return;
    }
    check('maximize: the test window answered zoomed', /^OK max zoomed=true/.test(m1.ans), m1.ans.slice(0, 120));
    const d1 = m1.ev && m1.ev.kind === 'done' ? m1.ev : null;
    if (d1) numbers.plays.push(pick(d1));
    if (check('maximize: a done event', !!d1, m1.ev ? { kind: m1.ev.kind, reason: clean(m1.ev.reason) } : 'no done/skip event in 4 s')) {
      check('maximize: action maximize, not cancelled, ended sharp', d1.action === 'maximize' && d1.cancelled === false && d1.endedSharp === true, pick(d1));
      check('maximize: at least 6 frames', d1.frames >= 6, { frames: d1.frames });
      check('maximize: first frame under 34 ms', typeof d1.firstFrameMs === 'number' && d1.firstFrameMs < 34, { firstFrameMs: d1.firstFrameMs });
      check('maximize: the worst frame gap is reported', typeof d1.gapMaxMs === 'number' && Number.isFinite(d1.gapMaxMs), { gapMaxMs: d1.gapMaxMs });
    }
    await sleep(300);
    const s1 = await state();
    check('state.last is that play', s1.last && s1.last.action === 'maximize' && s1.plays >= 1, { last: s1.last && s1.last.action, plays: s1.plays, error: s1.error });
    const ov = Number(s1.overlay) || 0;
    if (check('state: an overlay window was made', ov > 0, { overlay: s1.overlay })) {
      const inf = await info(ov);
      check('after a play: the overlay is hidden', inf && inf.visible === false, inf || 'no INFO');
      check('the overlay is alpha 0 in --test (invisible)', inf && inf.lwaOk && inf.alpha === 0, inf || 'no INFO');
      const need = LAYERED | TRANSPARENT | NOACTIVATE | TOOLWINDOW;
      check('the overlay is layered, click-through, never activated, a tool window', inf && (inf.ex & need) === need, inf ? `ex=0x${inf.ex.toString(16)}` : 'no INFO');
    }
    // the feature's own log line
    const lf = logFile();
    if (lf) {
      let txt = '';
      for (let i = 0; i < 20 && !/maxfold: done: maximize, first frame/.test(txt); i++) { await sleep(100); try { txt = fs.readFileSync(lf, 'utf8'); } catch (_) { txt = ''; } }
      check('mantle.log has the feature\'s "done: maximize, first frame" line', /maxfold: done: maximize, first frame/.test(txt), 'not in the --log file');
    } else {
      // no --log file (run-suite's selftest runner): the line as the feature handed it to its log
      for (let i = 0; i < 20 && !logged.some((l) => /^done: maximize, first frame/.test(l)); i++) await sleep(100);
      check('the feature logged its "done: maximize, first frame" line (no --log file here, so read from its log calls)', logged.some((l) => /^done: maximize, first frame/.test(l)), `${logged.length} lines logged, none a maximize done line`);
    }

    // 4. restore without the flag -> Windows animates it itself (only while Windows animations are on)
    const r1 = await act('restore', 'restore', null);
    if (s1.winAnim === true || c.winAnim === true) {
      check('restore, not flagged: skipped with "Windows animates this restore itself"', r1.ev && r1.ev.kind === 'skip' && r1.ev.reason === RESTORE_SELF,
        r1.ev ? { kind: r1.ev.kind, reason: clean(r1.ev.reason) } : 'no event in 4 s');
    } else {
      numbers.restoreUnflagged = 'Windows animations are off here: the unflagged restore is not a skip (not judged)';
      if (r1.ev && r1.ev.kind === 'done') numbers.plays.push(pick(r1.ev));
    }
    check('restore: the test window answered not zoomed', /^OK restore zoomed=false/.test(r1.ans), r1.ans.slice(0, 120));
    await sleep(300);

    // 5. maximize again, flag, restore -> a done restore
    const m2 = await act('max', 'maximize', { line: 'restore', action: 'restore' });
    if (m2.ev && m2.ev.kind === 'done') numbers.plays.push(pick(m2.ev));
    check('second maximize: a done event', m2.ev && m2.ev.kind === 'done', m2.ev ? { kind: m2.ev.kind, reason: clean(m2.ev.reason) } : 'no event');
    await sleep(300);
    const fl = await ctx.sidecar.send('maxfold.flag', { window: win.hwnd, on: true }, { timeoutMs: 3000 });
    check('flag on (the harness\'s own window): taken', fl.ok && fl.result && fl.result.flagged === true, fl.ok ? fl.result : fl.error);
    const sf = await state();
    check('state: the flagged window is the test window', sf.flaggedHwnd === win.hwnd && sf.flagged >= 1, { flaggedHwnd: sf.flaggedHwnd, flagged: sf.flagged, mine: win.hwnd });
    const r2 = await act('restore', 'restore', { line: 'max', action: 'maximize' });
    const d2 = r2.ev && r2.ev.kind === 'done' ? r2.ev : null;
    if (d2) numbers.plays.push(pick(d2));
    if (check('flagged restore: a done event', !!d2, r2.ev ? { kind: r2.ev.kind, reason: clean(r2.ev.reason) } : 'no event in 4 s')) {
      check('flagged restore: action restore, not cancelled, ended sharp', d2.action === 'restore' && d2.cancelled === false && d2.endedSharp === true, pick(d2));
    }
    const fo = await ctx.sidecar.send('maxfold.flag', { window: win.hwnd, on: false }, { timeoutMs: 3000 });
    check('flag off: given back', fo.ok && fo.result && fo.result.flagged === false, fo.ok ? fo.result : fo.error);
    await sleep(300);
    const s2 = await state();
    const ov2 = Number(s2.overlay) || ov;
    if (ov2 > 0) {
      const inf2 = await info(ov2);
      check('after the restore play: the overlay is hidden and alpha 0', inf2 && inf2.visible === false && inf2.alpha === 0, inf2 || 'no INFO');
    }
    check('state: nothing flagged after flag off', s2.flagged === 0 && (s2.flaggedHwnd == null || s2.flaggedHwnd === 0), { flagged: s2.flagged, flaggedHwnd: s2.flaggedHwnd });

    // 6. the feature's maxfold.state command, through a real Mantle page's bridge
    const st = await viaPage('maxfold.state');
    check('maxfold.state (the feature\'s command, called from a Mantle page) counts at least 2 done plays',
      st.ok && st.value && st.value.counts && st.value.counts.done >= 2, st.ok ? { counts: st.value && st.value.counts } : st.error);
    check('... and its counts match the feature\'s own', st.ok && st.value && st.value.counts && st.value.counts.done === k.counts.done,
      { page: st.value && st.value.counts && st.value.counts.done, feature: k.counts.done });

    // 7. off through the tray switch -> the feature's apply('switched off') -> unarmed, thread ended; then on again
    const off = ctx.host && ctx.host.features ? ctx.host.features.setEnabled('maxfold', false) : { ok: false, reason: 'no ctx.host.features' };
    let so = null;
    for (let i = 0; i < 40 && !halt; i++) { await sleep(100); so = await state(); if (so.armed === false && so.thread === 'ended') break; }
    check('switched off (tray switch -> the feature\'s apply): armed false, thread ended', so && so.armed === false && so.thread === 'ended',
      { set: off, armed: so && so.armed, hooked: so && so.hooked, thread: so && so.thread, error: so && so.error });
    const on = ctx.host && ctx.host.features ? ctx.host.features.setEnabled('maxfold', true) : { ok: false };
    let sn = null;
    for (let i = 0; i < 40 && !halt; i++) { await sleep(100); sn = await state(); if (sn.armed === true) break; }
    check('switched on again: armed, hooked, thread running', sn && sn.armed === true && sn.hooked === true && sn.thread === 'running',
      { set: on, armed: sn && sn.armed, hooked: sn && sn.hooked, thread: sn && sn.thread, error: sn && sn.error });

    // 8. nothing took the focus; the window closes
    const fg1 = await fg();
    check('the foreground window is the same before and after', fg0 === fg1 && !/unread/.test(fg0), { before: fg0, after: fg1 });
    const sz = await state();
    check('the test window never took the foreground (state.fgHarness 0)', sz.fgHarness === 0, { fgHarness: sz.fgHarness, error: sz.error });
  } finally {
    if (win) {
      await win.close();
      check('the test window closed at the end', !!win.exited, 'still running after close');
      win = null;
    }
    if (offEv) { try { offEv(); } catch (_) { /* stopped */ } offEv = null; }
    const passed = checks.filter((x) => x.ok).length;
    const failed = checks.length - passed;
    numbers.counts = JSON.parse(JSON.stringify(k.counts));
    numbers.events = events.map((e) => (e.kind === 'skip' ? `skip ${e.action === 'maximize' || e.action === 'restore' ? e.action : '?'}: ${clean(e.reason)}` : `${e.kind} ${e.action || ''}`.trim())).slice(-30);
    try {
      ctx.log(`SELFTEST ${passed} passed, ${failed} failed${skipped ? ` (skipped: ${skipped})` : ''}` +
        (failed ? ` - ${checks.filter((x) => !x.ok).map((x) => `${x.name} (${x.detail})`).join('; ')}` : ''));
    } catch (_) { /* stopped */ }
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), passed, failed, skipped, checks, numbers }, null, 1));
    } catch (_) { /* the log line has it */ }
  }
}

/** Call a Mantle command the way a page does (window.mantle.call through preload + main's IPC). */
async function viaPage(name, args) {
  try {
    const { webContents } = require('electron');
    const pages = webContents.getAllWebContents().filter((w) => {
      try { return !w.isDestroyed() && !w.isLoading() && /^file:.*\/ui\//.test(w.getURL()); } catch (_) { return false; }
    });
    if (!pages.length) return { ok: false, error: 'no Mantle page is loaded to call from' };
    const expr = `(window.mantle && window.mantle.call) ? window.mantle.call(${JSON.stringify(name)}, ${JSON.stringify(args || {})}).then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: String(e && e.message || e) })) : ({ ok: false, error: 'no window.mantle on that page' })`;
    let last = null;
    for (const p of pages) {
      const r = await Promise.race([p.executeJavaScript(expr, true), sleep(4000).then(() => ({ ok: false, error: 'the page did not answer in 4 s' }))]);
      if (r && r.ok) return r;
      last = r;
    }
    return last || { ok: false, error: 'no answer' };
  } catch (e) { return { ok: false, error: e.message }; }
}

function stop() {
  halt = true;
  if (win) { const w = win; win = null; w.close().catch(() => {}); }
}

module.exports = { start, stop, OUT };

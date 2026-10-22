'use strict';
/*
 * corners.js - HOT CORNERS (lane corners, 2026-09-27). Push the cursor into a screen corner and an
 * action runs. The pure part (zones, dwell, re-arm, guards, the shared claim table) and its WHYs are
 * lib/features/_corners.js; this file owns the poll, the actions, the log and the quick-settings row's
 * commands (ui/bar/corners.js).
 *
 * THE ACTIONS
 *   Task view       Win+Tab's own handler (lib/features/taskview.js) through ctx.runChord: the same
 *                   entry the key takes, so a second push closes it again, like Win+Tab.
 *   Show desktop    the sidecar's hotcorners.desktop (sidecar/HotCorners.cs): Shell.Application
 *                   ToggleDesktop, Windows' own minimise-all / restore-all toggle. Never Win+D sent.
 *   Launcher        ctx.host.openLauncher (Mantle's Start).
 *   Quick settings  'corners.qs' to the bar page, which opens its panel and answers corners.ack (so a
 *                   bar that never opened it is a failure with a reason, not silence).
 *   Lock screen     user32 LockWorkStation through koffi (what the launcher's Lock runs, in-process).
 *
 * THE CHECKS AT THE MOMENT OF FIRING: one sidecar gamemode.scan {procs:true} - the window in front
 * (full screen? a known game? the lock screen?) and the process list (a known game running anywhere,
 * _gamemode-plan.js runningGames). A scan that does not come back refuses: nothing fires blind.
 * Mantle resting for a game stops this feature entirely (rest: true): no poll runs at all.
 *
 * NO SILENT FAILURES: every fire, refusal and failure is one log line; a failure stays on its corner
 * in the quick-settings row with its reason until that corner next works; a watch that cannot read
 * the cursor or the mouse buttons is this feature's health, with the reason.
 *
 * TEST (--test): EVERY action is a dry run - Task view asks only whether Win+Tab's feature could
 * take it, Show desktop asks the (passive) sidecar for a dry run, the launcher and quick settings
 * are only looked for, the lock is only bound. Nothing on the user's screen moves. A --test instance
 * with MANTLE_CORNERS_SELFTEST=1 drives the whole path with a FAKE cursor (_corners-selftest.js).
 */
const C = require('./_corners');
// A renderer's string in a reason or a log line is cut short and kept on one line (secreview-win):
// corners.set {corner: <1 MB>} put the whole megabyte into its ok:false reason, and so into mantle.log.
// eslint-disable-next-line no-control-regex
const clip = (v) => { const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' '); return s.length > 40 ? s.slice(0, 39) + '…' : s; };
// the bar page's own reason (corners.ack) is a renderer string too: one line, at most 160 characters
// eslint-disable-next-line no-control-regex
const clipLong = (v) => { const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' '); return s.length > 160 ? s.slice(0, 159) + '…' : s; };
const PK = require('./_topbar-peek');     // nativeButtons: GetAsyncKeyState, READ only
const P = require('./_gamemode-plan');    // runningGames / detectGame / gameLabel

const ACK_MS = 1500;   // how long the bar page gets to say it opened quick settings

/** The real lock: user32 LockWorkStation through koffi, bound on first use. dry = bind only. */
function nativeLock() {
  let fn = null;
  let why = null;
  return function lock(dry) {
    if (!fn && !why) {
      try { fn = require('koffi').load('user32.dll').func('bool __stdcall LockWorkStation()'); } catch (e) { why = `koffi could not bind LockWorkStation (${String(e && e.message).split('\n')[0]})`; }
    }
    if (!fn) return { ok: false, reason: why };
    if (dry) return { ok: true, dryRun: true, wouldCall: 'user32 LockWorkStation' };
    return fn() ? { ok: true, called: 'LockWorkStation' } : { ok: false, reason: 'LockWorkStation returned FALSE: Windows would not lock' };
  };
}

/**
 * The cursor, or a throw when Windows will not say where it is (lane wk-mantle-focus, 2026-10-14).
 * While the sign-in screen's PIN box (or a UAC prompt) has the input, GetCursorPos FAILS for every
 * thread on the user's desktop (error 5, measured on a thread moved off the input desktop), but Electron's
 * screen.getCursorScreenPoint() returns a point anyway. The live log, 10-13: Task View fired from the
 * TOP-LEFT corner 0.35-0.45 s after every "the lock screen closed" (5 of 5, never otherwise), behind
 * the PIN box, where nothing can take the keyboard (each one "Windows refused the foreground change").
 * So GetCursorPos is asked first, through koffi, and FALSE is a failed read: tick() then has no point,
 * step() drops the dwell, and nothing fires. Without koffi it is Electron's point, as before.
 * read: () -> {x, y} in DIP (Electron's); bind (tests): () -> fn(buf) -> 0|1.
 */
function checkedCursor(read, bind) {
  let fn;
  const buf = Buffer.alloc(8);
  cursor.checked = () => !!fn;   // after the first read: is GetCursorPos's answer being checked?
  return cursor;
  function cursor() {
    if (fn === undefined) {
      fn = null;
      try {
        fn = (bind || (() => require('koffi').load('user32.dll').func('int __stdcall GetCursorPos(void *pt)')))();
      } catch (_) { fn = null; /* no koffi: Electron's point alone, as before */ }
    }
    if (fn && !fn(buf)) throw new Error('Windows would not say where it is (GetCursorPos failed: the sign-in or lock screen has the input)');
    return read();
  }
}

/**
 * One action through the injected effects h = {test, chord(chord, dry) -> {delivered, dryRun, feature,
 * reason}, desktop(dry) -> Promise {ok, reason, wouldCall, called}, launcher(dry) (throws on failure),
 * qs(dry) -> Promise {ok, reason, dryRun}, lock(dry) -> {ok, reason, wouldCall}}. Never throws:
 * -> {ok, dryRun, said}. In --test (h.test) every action is a dry run.
 */
async function runAction(action, h) {
  const dry = !!h.test;
  const name = C.ACTION_NAMES[action] || String(action);
  const DRY = 'DRY RUN (--test): would have ';
  try {
    if (action === 'taskview') {
      const r = h.chord('Win+Tab', dry) || {};
      if (dry) return r.dryRun ? { ok: true, dryRun: true, said: `${DRY}opened Task view (${r.feature} takes Win+Tab)` }
        : { ok: false, dryRun: true, said: `Task view could not open: ${r.reason || 'no reason came back'}` };
      return r.delivered ? { ok: true, said: `opened Task view (${r.feature}'s Win+Tab)` } : { ok: false, said: `Task view did not open: ${r.reason || 'no reason came back'}` };
    }
    if (action === 'desktop') {
      const r = (await h.desktop(dry)) || {};
      if (!r.ok) return { ok: false, dryRun: dry, said: `Show desktop did not run: ${r.reason || 'no reason came back'}` };
      return dry ? { ok: true, dryRun: true, said: `${DRY}called ${r.wouldCall || 'Show desktop'}` } : { ok: true, said: `toggled Show desktop (${r.called || 'the shell'})` };
    }
    if (action === 'launcher') {
      h.launcher(dry);
      return dry ? { ok: true, dryRun: true, said: `${DRY}opened the launcher` } : { ok: true, said: 'opened the launcher' };
    }
    if (action === 'qs') {
      const r = (await h.qs(dry)) || {};
      if (!r.ok) return { ok: false, dryRun: dry, said: `Quick settings did not open: ${r.reason || 'no reason came back'}` };
      return dry ? { ok: true, dryRun: true, said: `${DRY}opened quick settings on the bar` } : { ok: true, said: r.closed ? 'closed quick settings (it was open)' : 'opened quick settings' };
    }
    if (action === 'lock') {
      const r = h.lock(dry) || {};
      if (!r.ok) return { ok: false, dryRun: dry, said: `the screen did not lock: ${r.reason || 'no reason came back'}` };
      return dry ? { ok: true, dryRun: true, said: `${DRY}called ${r.wouldCall || 'LockWorkStation'}` } : { ok: true, said: 'locked the screen' };
    }
    return { ok: false, dryRun: dry, said: `"${action}" is not a corner action` };
  } catch (e) {
    return { ok: false, dryRun: dry, said: `${name} failed: ${e && e.message ? e.message : e}` };
  }
}

module.exports = {
  name: 'corners',
  label: 'Hot corners',
  defaultOn: true,
  rest: true,                         // stopped while Mantle rests for a game: no poll at all then
  chords: [],
  observe: [],
  _test: { runAction, nativeLock, checkedCursor, ACK_MS, clip, clipLong },

  install(ctx) {
    const { screen } = require('electron');
    const test = !!ctx.flags.test;
    let saved = null;
    try { saved = ctx.settings.get('actions', null); } catch (e) { ctx.log(`the saved corners could not be read (${e.message}); using the defaults`); }
    const S = {
      actions: C.normalize(saved), stopped: false, watching: false, t: null, st: C.initial(), busy: false,
      src: { cursor: checkedCursor(() => screen.getCursorScreenPoint()), buttons: PK.nativeButtons(), fake: false },
      watch: { ok: null, reason: null }, blocked: null, last: null, fails: {}, fires: 0,
      seen: new Map(), extraGames: [], acks: new Map(), qsSeq: 0,
    };
    // TEST ONLY: MANTLE_CORNERS_TEST_GAME=<exe>[,<exe>] counts as a known game (the self-test's stand-in)
    if (test && process.env.MANTLE_CORNERS_TEST_GAME) S.extraGames = String(process.env.MANTLE_CORNERS_TEST_GAME).split(',').map((s) => s.trim()).filter(Boolean);
    const lock = nativeLock();
    const sc = async (cmd, args, ms) => {
      const r = await ctx.sidecar.send(cmd, args || {}, { timeoutMs: ms || 4000 });
      return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: r.error };
    };
    const primary = () => screen.getPrimaryDisplay().bounds;
    /* every display (multi-monitor, quality pass 2026-09-29): only OUTER corners are hot, on any screen
       (_corners.js cornerOnScreens). Re-read at most every 2 s: a display plugged in or rearranged is
       picked up without a listener to leak. The self-test's fake cursor keeps the primary only. */
    const DISPLAYS_MS = 2000;
    let disp = { at: 0, list: null };
    const displays = () => {
      if (S.src.fake) return null;
      const now = Date.now();
      if (!disp.list || now - disp.at > DISPLAYS_MS) {
        try { disp = { at: now, list: screen.getAllDisplays().map((d) => d.bounds) }; } catch (e) { disp = { at: now, list: null }; }
      }
      return disp.list;
    };
    const summary = () => C.CORNERS.filter((c) => S.actions[c] !== 'off').map((c) => `${C.CORNER_NAMES[c]} ${C.ACTION_NAMES[S.actions[c]]}`).join(', ') || 'every corner off';

    /* ---- the effects runAction uses -------------------------------------------------------- */
    const H = {
      test,
      chord: (chord, dry) => (typeof ctx.runChord === 'function' ? ctx.runChord(chord, 'a hot corner', { dryRun: dry })
        : { delivered: false, reason: 'this Mantle cannot run another feature\'s chord (lib/features.js has no runChord)' }),
      desktop: (dry) => sc('hotcorners.desktop', dry ? { dryRun: true } : {}, 3000).then((r) => (r.ok || !/unknown command|not a command/i.test(r.reason || '') ? r
        : { ok: false, reason: `the sidecar has no hotcorners.desktop (${r.reason}): run npm run build:sidecar` })),
      launcher: (dry) => {
        if (!ctx.host || typeof ctx.host.openLauncher !== 'function') throw new Error('this Mantle has no launcher to open');
        if (!dry) ctx.host.openLauncher({ mode: 'apps', query: '' });
      },
      qs: (dry) => new Promise((resolve) => {
        let rect = null;
        try { rect = ctx.host.barRect(); } catch (e) { resolve({ ok: false, reason: `there is no bar to open it on (${e.message})` }); return; }
        if (!rect) { resolve({ ok: false, reason: 'there is no bar to open it on' }); return; }
        if (dry) { resolve({ ok: true, dryRun: true }); return; }
        const seq = ++S.qsSeq;
        const t = setTimeout(() => { S.acks.delete(seq); resolve({ ok: false, reason: `the bar did not answer within ${ACK_MS} ms (its page may be reloading)` }); }, ACK_MS);
        S.acks.set(seq, (a) => { clearTimeout(t); S.acks.delete(seq); resolve(a && a.ok ? { ok: true, closed: !!a.closed } : { ok: false, reason: a && a.reason ? clipLong(a.reason) : 'the bar gave no reason' }); });
        ctx.broadcast('corners.qs', { seq });
      }),
      lock: (dry) => lock(dry),
    };

    /* ---- state for the row ----------------------------------------------------------------- */
    function view() {
      return {
        enabled: ctx.enabled(), test, actions: Object.assign({}, S.actions), corners: C.CORNERS.slice(), names: C.CORNER_NAMES,
        choices: C.ACTIONS.map((id) => ({ id, label: C.ACTION_NAMES[id] })), watching: S.watching,
        watch: S.watch, last: S.last, fails: S.fails, zone: C.CORNER_ZONE_DIP, dwell: C.CORNER_DWELL_MS,
      };
    }
    const publish = () => ctx.broadcast('corners.state', view());
    ctx.replay('corners.state', view);
    function health() {
      const why = S.watch.ok === false ? `the corners cannot fire: ${S.watch.reason}` : null;
      ctx.health(!why, why);
    }

    /* ---- the poll --------------------------------------------------------------------------- */
    const wanted = () => ctx.enabled() && !S.stopped && C.anyOn(S.actions);
    function sync(why) {
      if (wanted()) {
        C.setClaims(S.actions, displays());   // the top bar's peek and the bottom bar's reveal leave these squares alone
        if (!S.watching) {
          S.watching = true;
          S.st = C.startState();
          const b = primary();
          ctx.log(`watching the corners (${summary()}) of the ${b.width}x${b.height} DIP screen: a ${C.CORNER_ZONE_DIP} DIP square each, ` +
            `${C.CORNER_DWELL_MS} ms at rest fires once, polled every ${C.CORNER_POLL_MS} ms (${why})` + (S.src.fake ? ' (the self-test\'s FAKE cursor)' : ''));
          schedule();
        }
      } else {
        C.setClaims(null);
        if (S.watching) {
          S.watching = false;
          if (S.t) { clearTimeout(S.t); S.t = null; }
          S.st = C.initial();
          ctx.log(`stopped watching the corners: ${why}`);
        }
        if (S.watch.ok !== null) S.watch = { ok: null, reason: null };
      }
      publish();
      health();
    }
    function schedule() {
      if (S.t || !S.watching || S.stopped) return;
      S.t = setTimeout(() => { S.t = null; tick(); }, C.CORNER_POLL_MS);
    }
    function watchSays(why) {
      const ok = !why;
      if (S.watch.ok === ok && S.watch.reason === (why || null)) return;
      S.watch = { ok, reason: why || null };
      ctx.log(ok ? 'the corner watch reads the cursor and the mouse buttons again' : `the corners cannot fire: ${why}`);
      publish();
      health();
    }
    function tick() {
      if (!wanted()) { sync(S.stopped ? 'stopped' : !ctx.enabled() ? 'switched off in the tray' : 'every corner is off'); return; }
      let pt = null;
      let cursorWhy = null;
      try {
        pt = S.src.cursor();
        if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) { pt = null; cursorWhy = 'nothing came back'; }
      } catch (e) { cursorWhy = e.message; }
      const ds = displays();
      if (ds !== S.claimedDisplays) { S.claimedDisplays = ds; C.setClaims(S.actions, ds); }   // a screen added / moved
      let btn;   // undefined = not read this tick (the cursor was not in an active corner)
      const r = C.step(S.st, {
        now: Date.now(), pt, cursorWhy, bounds: primary(), displays: ds, actions: S.actions,
        guard: S.busy ? 'the last corner action is still running' : null,
        buttons: () => { try { btn = S.src.buttons(); } catch (e) { btn = { ok: false, reason: `the reader threw: ${e.message}` }; } return btn; },
      });
      S.st = r.st;
      if (r.blocked) S.blocked = { at: Date.now(), why: r.blocked };
      const curWhy = pt ? null : `the cursor position could not be read (${cursorWhy})`;
      if (btn !== undefined) S.btnWhy = btn && btn.ok ? null : `the mouse buttons cannot be read (${(btn && btn.reason) || 'no reason'}), so a corner could fire in the middle of a drag`;
      watchSays(curWhy || S.btnWhy || null);
      if (r.act === 'fire') fire(r.corner, r.action, r.why).catch((e) => ctx.log(`corner fire threw: ${e.message}`));
      schedule();
    }

    /* ---- firing ----------------------------------------------------------------------------- */
    function record(corner, action, r, why) {
      const where = C.CORNER_NAMES[corner];
      const name = C.ACTION_NAMES[action] || action;
      S.last = { corner, action, at: Date.now(), ok: !!r.ok, blocked: !!r.blocked, dryRun: !!r.dryRun, said: r.said };
      if (r.ok) delete S.fails[corner];
      else if (!r.blocked) S.fails[corner] = { at: S.last.at, action, said: r.said };
      ctx.log(r.ok ? `${where} corner -> ${name}: ${r.said} (${why})`
        : r.blocked ? `${where} corner -> ${name}: not run: ${r.said}`
        : `${where} corner -> ${name} FAILED: ${r.said}`);
      publish();
    }
    async function fire(corner, action, why) {
      S.fires++;
      S.busy = true;
      try {
        const scan = await sc('gamemode.scan', { procs: true }, 1500);
        const block = C.fireBlocker(scan, P, { seen: S.seen, extra: S.extraGames });
        if (block) { record(corner, action, { ok: false, blocked: true, said: block }, why); return; }
        if (S.stopped) return;
        record(corner, action, await runAction(action, H), why);
      } finally {
        S.busy = false;
      }
    }

    /* ---- the row's calls -------------------------------------------------------------------- */
    ctx.command('state', async () => view());
    ctx.command('set', async (a) => {
      const corner = a && a.corner;
      const action = a && a.action;
      if (!C.CORNERS.includes(corner)) return Object.assign({ ok: false, reason: `"${clip(corner)}" is not a corner (${C.CORNERS.join(', ')})` }, view());
      if (!C.ACTIONS.includes(action)) return Object.assign({ ok: false, reason: `"${clip(action)}" is not a corner action (${C.ACTIONS.join(', ')})` }, view());
      if (S.actions[corner] !== action) {
        const next = Object.assign({}, S.actions, { [corner]: action });
        try { ctx.settings.set('actions', next); } catch (e) {
          ctx.log(`the ${C.CORNER_NAMES[corner]} corner could not be saved as ${C.ACTION_NAMES[action]}: ${e.message}`);
          return Object.assign({ ok: false, reason: `it could not be saved: ${e.message}` }, view());
        }
        S.actions = next;
        delete S.fails[corner];
        ctx.log(`the ${C.CORNER_NAMES[corner]} corner is now ${C.ACTION_NAMES[action]} (${clip((a && a.via) || 'quick settings')}): ${summary()}`);
        if (S.watching) C.setClaims(S.actions, displays());
        sync('a corner changed');
      }
      return Object.assign({ ok: true }, view());
    });
    // the bar page's answer to 'corners.qs' {seq}: {seq, ok, reason}
    ctx.command('ack', async (a) => {
      const fn = a && S.acks.get(Number(a.seq));
      if (fn) fn(a);
      return { ok: !!fn };
    });

    ctx.onEnabled((on) => sync(on ? 'switched on in the tray' : 'switched off in the tray'));

    let selftest = null;
    if (test && process.env.MANTLE_CORNERS_SELFTEST === '1') {
      selftest = require('./_corners-selftest.js');
      selftest.start({ ctx, S, C, screen, sync, view });
    }
    sync('started');

    return {
      stop(why) {
        S.stopped = true;
        if (selftest) selftest.stop();
        if (S.t) { clearTimeout(S.t); S.t = null; }
        S.watching = false;
        C.setClaims(null);
        for (const fn of Array.from(S.acks.values())) fn({ ok: false, reason: `the corners stopped (${why || 'no reason'})` });
        S.acks.clear();
        ctx.log(`stopped: ${why || 'no reason given'}`);
      },
    };
  },
};

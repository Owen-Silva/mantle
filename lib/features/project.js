'use strict';
/*
 * lib/features/project.js - Win+P: Mantle's Project pop-up, in place of Windows' Project flyout, and
 * the state behind quick settings' Project and Cast tiles (lane qstiles, 2026-10-15; plan
 * design notes: mantle-replace-windows P8 + P12). The user: "i want you to do all of them".
 *
 * THE FOUR CHOICES are Windows' own (PC screen only / Duplicate / Extend / Second screen only), in
 * its order and words (_project-core.js). Win+P again moves to the next, as Windows' does; arrows
 * move, Enter picks, Esc closes. The current layout is marked. With one display it says so plainly
 * and only "PC screen only" can be picked. "Connect to a wireless display" is Windows' Cast panel
 * (Win+K): no public API lets another app start a whole-screen Miracast session (see the lane's
 * report), so Mantle hands that one to Windows.
 *
 * THE CHANGE is Mantle Settings' own: sysdisplay.topology (sidecar/SysDisplay.cs, SetDisplayConfig
 * SDC_TOPOLOGY_*), with its keep-or-revert armed IN THE SIDECAR: 15 s to keep it, else the sidecar
 * switches back by itself, also if this window, the page or Mantle dies (the sidecar's timer and its
 * exit hook). So a black screen undoes itself. The pop-up shows "Keep these display settings?" with
 * the count; Enter keeps, Esc (or closing it) switches back now.
 *
 * NOT WARM, ON PURPOSE (PERF R1's written reason): Win+P is pressed a few times a month, so a hidden
 * window kept for it would cost ~30 MB private around the clock for nothing. It is made on the key
 * and destroyed when it closes; the cold budget applies (<= 400 ms p95 quiet), logged per open (R7).
 * NOTHING WAITS before the paint (R3): the pop-up draws from the last read (`last`), and the fresh
 * read (sysdisplay.project, a few ms on the qs lane) replaces it after.
 *
 * FAIL-OPEN: the chord is Mantle's only while this is on, healthy and Mantle is not resting (a game):
 * otherwise Win+P is Windows' own. --test: never on screen, never focused, every change a dry run.
 */
const core = require('./_project-core');

const CHORD = 'Win+P';
const READY = 'Win+P opens Mantle\'s Project pop-up';
const CARD_W = 340, PAD = 16, EDGE = 12, GAP = 8;
const CLOSE_AFTER_MS = 1600;     // "Put back" / "Kept" stays readable this long, then the pop-up goes

function words(e) { return String((e && e.message) || e || 'no reason given').split('\n')[0]; }
function plainErr(e) {
  const m = words(e);
  return (/sidecar|ipc|timed? ?out|undefined|\bnull\b/i.test(m) || /\bE[A-Z]{3,}\b/.test(m)) ? 'Mantle\'s helper did not answer. Try again in a moment' : m;
}

module.exports = {
  name: 'project',
  label: 'Project (Win+P)',
  defaultOn: true,
  rest: true,                 // the pop-up is a window: while a game runs Win+P is Windows' own
  chords: [CHORD],
  observe: [],
  install(ctx) {
    const test = !!ctx.flags.test;
    let el = null;
    try { const e = require('electron'); el = e && typeof e === 'object' && e.BrowserWindow ? e : null; } catch (_) { el = null; }
    const raise = el ? require('../raise') : null;

    let stopped = false;
    let last = null, lastAt = 0, readError = null, reading = null;
    let win = null, phase = 'closed', sel = null, confirm = null, note = null, noteWarn = false;
    let opened = null;           // { t0, via, painted, shown, interactive } for the R7 line
    let closeTimer = null, tick = null;

    function state() {
      return { on: ctx.enabled(), read: last, readAt: lastAt, readError, phase, sel, confirm, note, noteWarn, open: !!win, test };
    }
    const emit = () => {
      if (stopped) return;
      const s = state();
      ctx.broadcast('project.state', s);
      if (win && !win.isDestroyed()) ctx.push(win, 'project.view', s);
    };
    ctx.replay('project.state', state);

    /** The fresh read, never awaited on an open path. One at a time. */
    function read(why) {
      if (stopped || reading) return reading || Promise.resolve();
      if (!ctx.sidecar.ready) { readError = 'Mantle\'s helper is starting'; return Promise.resolve(); }
      reading = ctx.sidecar.send('sysdisplay.project', {}, { timeoutMs: 3000 }).then((r) => {
        reading = null;
        if (stopped) return;
        if (r.ok && r.result && typeof r.result === 'object') {
          const x = r.result;
          last = { current: x.current || null, reason: x.reason || null, available: Array.isArray(x.available) ? x.available : [],
            unavailable: x.unavailable && typeof x.unavailable === 'object' ? x.unavailable : {},
            connected: typeof x.connected === 'number' ? x.connected : null, connectedWhy: x.connectedWhy || null,
            pending: x.pending || null };
          lastAt = Date.now(); readError = null;
          if (sel && core.whyNot(last, sel)) sel = core.startSel(last);
        } else {
          readError = plainErr(r.error);
          ctx.log(`the display read failed (${why}): ${words(r.error)}`);
        }
        emit();
      });
      return reading;
    }

    /* ---- the pop-up ---- */
    function place(w, primary) {
      try {
        let wa;
        if (primary && el) wa = el.screen.getPrimaryDisplay().workArea;
        else { const d = ctx.host.display(); wa = (d && (d.workArea || d.bounds)) || el.screen.getPrimaryDisplay().workArea; }
        const bar = primary ? null : ctx.host.barRect();
        const top = bar && bar.y + bar.height <= wa.y + 80 ? Math.max(wa.y, bar.y + bar.height) : wa.y;
        const [ww] = w.getSize();
        w.setPosition(Math.round(wa.x + wa.width - EDGE - CARD_W - PAD), Math.round(top + GAP - PAD));
        void ww;
      } catch (e) { ctx.log(`the pop-up could not be placed (${words(e)})`); }
    }

    function failed(w, why) {
      if (w && win !== w) return;
      ctx.log(`the pop-up failed: ${why}; Win+P goes back to Windows until it is fixed`);
      destroy();
      ctx.health(false, `the Project pop-up ${why}, so Win+P is Windows' again`);
    }

    function destroy(soon) {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      if (tick) { clearInterval(tick); tick = null; }
      const w = win; win = null; phase = 'closed'; note = null; noteWarn = false; opened = null;
      if (w) {
        const kill = () => { try { if (!w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ } };
        if (soon) { try { if (!w.isDestroyed()) w.hide(); } catch (_) { /* gone */ } setImmediate(kill); } else kill();
      }
      emit();
    }

    function open(via) {
      const t0 = Date.now();
      if (stopped) return { ok: false, reason: 'the Project pop-up is stopped' };
      if (!ctx.enabled()) return { ok: false, reason: 'Mantle\'s Project pop-up is switched off in the tray, so Win+P is Windows\' own' };
      if (win && !win.isDestroyed()) {
        // Win+P again: the next choice, as Windows' flyout does (not while a change waits to be kept)
        if (phase === 'choose') { sel = core.next(last, sel, 1); emit(); }
        return { ok: true, cycled: phase === 'choose', sel };
      }
      if (!el) return { ok: false, reason: 'there is no Electron here' };
      phase = 'choose'; sel = core.startSel(last); confirm = null; note = null; noteWarn = false;
      opened = { t0, via, painted: null, shown: null, interactive: null };
      let w;
      try {
        w = new el.BrowserWindow({
          show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false, focusable: !test,
          resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
          alwaysOnTop: !test, title: 'Mantle Project', width: CARD_W + PAD * 2, height: 420,
          webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
        });
        win = w;
        place(w, false);
        if (!test) w.setAlwaysOnTop(true, 'pop-up-menu');
        const wc = w.webContents;
        wc.on('will-navigate', (e) => e.preventDefault());
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        wc.on('render-process-gone', (_e, d) => failed(w, `crashed (${(d && d.reason) || 'no reason given'})`));
        wc.on('did-fail-load', (_e, code, desc) => failed(w, `did not load (${desc || code})`));
        wc.once('did-finish-load', () => {
          if (win !== w || w.isDestroyed()) return;
          if (!ctx.push(w, 'project.view', state())) failed(w, 'could not be told what to show');
        });
        // Clicking away closes it, as a flyout does; never while a change waits (the count must stay seen).
        w.on('blur', () => { if (win === w && phase === 'choose' && opened && opened.shown != null) destroy(); });
        const p = w.loadFile(ctx.page('index.html'));
        if (p && typeof p.catch === 'function') p.catch((e) => failed(w, `did not load (${words(e)})`));
      } catch (e) {
        failed(w || null, `could not be made (${words(e)})`);
        return { ok: false, reason: 'the Project pop-up could not open' };
      }
      emit();
      return { ok: true, opened: true, sel };
    }

    /** The page drew its first picture (two frames after project.view): show it and take the keyboard. */
    async function painted(how) {
      const w = win;
      if (!w || w.isDestroyed() || !opened || opened.painted != null) return { ok: true };
      const o = opened;
      o.painted = Date.now() - o.t0;
      if (test) {
        ctx.log(`opened (cold, kept hidden: --test) via ${o.via}: painted ${o.painted} ms (${how || 'frames'})`);
        read('after the paint');
        return { ok: true, test: true };
      }
      try { w.show(); w.focus(); } catch (_) { /* the ladder below */ }
      o.shown = Date.now() - o.t0;
      let k = { ok: w.isFocused(), words: 'in-process' };
      if (!k.ok && raise) {
        const buf = w.getNativeWindowHandle();
        const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
        k = await raise.keyboard(w, { sidecar: ctx.sidecar, sidecarPid: ctx.sidecar.pid, hwnd });
      }
      if (win !== w || w.isDestroyed()) return { ok: true };
      o.interactive = Date.now() - o.t0;
      if (raise) raise.up(w, { what: 'the Project pop-up', log: ctx.log, wanted: () => win === w && !w.isDestroyed() });
      ctx.log(`opened (cold) via ${o.via}: shown ${o.shown}, painted ${o.painted}, interactive ${o.interactive} ms` +
        (k.ok ? '' : `; it could not take the keyboard (${k.words}), so click a choice`));
      read('after the paint');
      return { ok: true };
    }

    function closeSoon(text, warn) {
      note = text; noteWarn = !!warn; phase = 'done'; confirm = null;
      if (tick) { clearInterval(tick); tick = null; }
      emit();
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { closeTimer = null; destroy(); }, CLOSE_AFTER_MS);
      if (closeTimer.unref) closeTimer.unref();
    }

    async function pick(mode) {
      if (!core.isMode(mode)) return { ok: false, reason: 'That is not one of the four choices' };
      if (phase !== 'choose') return { ok: false, reason: phase === 'confirm' ? 'Keep or put back the last change first' : 'A change is already on its way' };
      const why = core.whyNot(last, mode);
      if (why) { note = why; noteWarn = true; emit(); return { ok: false, reason: why }; }
      if (last && last.current === mode) { ctx.log(`${mode}: already the layout, closed`); destroy(true); return { ok: true, changed: false }; }
      sel = mode; phase = 'applying'; note = null; emit();
      const from = last ? last.current : null;
      const r = await ctx.sidecar.send('sysdisplay.topology', { mode, keepWithinMs: core.KEEP_MS, dryRun: test }, { timeoutMs: 10000 });
      if (stopped) return { ok: false, reason: 'stopped' };
      if (!r.ok) {
        phase = win ? 'choose' : 'closed';
        note = `The layout did not change: ${plainErr(r.error)}`; noteWarn = true;
        ctx.log(`${mode}: refused (${words(r.error)})`);
        emit(); read('after a refusal');
        return { ok: false, reason: note };
      }
      const x = r.result || {};
      if (x.dryRun) {
        if (x.refused || x.reason) { phase = 'choose'; note = `Windows would not take ${core.byId(mode).label}: ${x.reason || x.refused}`; noteWarn = true; emit(); return { ok: false, reason: note, dryRun: true }; }
        confirm = { token: 'dry-run', to: mode, from, endsAt: Date.now() + core.KEEP_MS, dry: true };
        ctx.log(`${mode}: dry run (--test): would switch from ${from || 'unknown'}; the keep-or-revert count shown, nothing changed`);
      } else if (x.changed === false) {
        ctx.log(`${mode}: Windows already had it`); destroy(true); read('unchanged'); return { ok: true, changed: false };
      } else {
        confirm = { token: x.token, to: mode, from: x.before || from, endsAt: Date.now() + (x.keepWithinMs || core.KEEP_MS), dry: false };
        ctx.log(`${mode}: switched from ${confirm.from}; switching back in ${Math.round((x.keepWithinMs || core.KEEP_MS) / 1000)} s unless kept`);
        if (win && !win.isDestroyed()) place(win, true);   // the screen it was on may be gone now
      }
      phase = 'confirm';
      if (tick) clearInterval(tick);
      tick = setInterval(() => {
        if (!confirm || phase !== 'confirm') { clearInterval(tick); tick = null; return; }
        if (confirm.dry && Date.now() >= confirm.endsAt) { confirm = null; closeSoon('Test run: it would have switched back now'); return; }
        emit();
      }, 1000);
      if (tick.unref) tick.unref();
      emit();
      return { ok: true, changed: !x.dryRun, dryRun: !!x.dryRun, token: confirm.token };
    }

    async function finish(keep, why) {
      if (phase !== 'confirm' || !confirm) return { ok: false, reason: 'No change is waiting' };
      const c = confirm;
      if (c.dry) { closeSoon(keep ? 'Test run: kept (nothing changed)' : 'Test run: put back (nothing changed)'); return { ok: true, dryRun: true, kept: keep }; }
      phase = 'applying'; emit();
      const r = await ctx.sidecar.send(keep ? 'sysdisplay.keep' : 'sysdisplay.revert', { token: c.token }, { timeoutMs: 10000 });
      ctx.log(`${keep ? 'kept' : 'put back'} (${why}): ${r.ok ? 'done' : words(r.error)}`);
      read('after keep/revert');
      if (!r.ok) {
        // gone already (the sidecar's own timer won the race): its event says what happened
        closeSoon(keep ? `It could not be kept: ${plainErr(r.error)}` : `It could not be put back: ${plainErr(r.error)}`, true);
        return { ok: false, reason: plainErr(r.error) };
      }
      closeSoon(keep ? 'Kept' : `Put back to ${core.byId(c.from) ? core.byId(c.from).label : 'the old layout'}`);
      return { ok: true, kept: keep };
    }

    /* ---- what the sidecar says about a waiting change (its timer, its exit, Mantle Settings) ---- */
    ctx.sidecar.on('sysdisplay', (ev) => {
      if (confirm && ev && ev.token === confirm.token && (ev.what === 'reverted' || ev.what === 'kept')) {
        if (ev.what === 'reverted') closeSoon(ev.ok === false ? `Mantle could not switch back: ${ev.reason || 'Windows refused'}` : 'No answer, so your display settings were put back', ev.ok === false);
        else closeSoon('Kept');
      }
      if (ev && (ev.what === 'reverted' || ev.what === 'kept')) read('a change was settled');
    });

    /* ---- commands (pages: the pop-up, quick settings' tiles) ---- */
    ctx.command('state', async () => state());
    ctx.command('open', async (a) => open((a && a.via === 'tile') ? 'the Project tile' : 'a page'));
    ctx.command('painted', async (a) => painted(a && typeof a.how === 'string' ? a.how.slice(0, 20) : null));
    ctx.command('move', async (a) => {
      if (phase !== 'choose') return { ok: false, reason: 'not choosing' };
      sel = a && core.isMode(a.to) ? a.to : core.next(last, sel, a && a.step < 0 ? -1 : 1);
      emit(); return { ok: true, sel };
    });
    ctx.command('pick', async (a) => pick(a && a.mode));
    ctx.command('keep', async () => finish(true, 'asked'));
    ctx.command('revert', async () => finish(false, 'asked'));
    ctx.command('close', async () => {
      if (phase === 'confirm') return finish(false, 'closed');   // closing the question = no, as Windows' dialog
      destroy(true); return { ok: true };
    });
    ctx.command('refresh', async () => { await read('asked'); return state(); });
    /** Cast: Windows' own panel (Win+K). Works with the pop-up switched off too: it takes nothing from Windows. */
    ctx.command('cast', async () => {
      if (win && phase === 'choose') destroy(true);
      if (test) return { ok: true, dryRun: true, reason: 'test run: would open Windows\' Cast panel (Win+K)' };
      if (!ctx.sidecar.ready) return { ok: false, reason: 'Mantle\'s helper is starting; press Win+K for Windows\' Cast panel' };
      const r = await ctx.sidecar.send('keys', { combo: 'win+k' }, { timeoutMs: 3000 });
      ctx.log(`cast: ${r.ok ? 'handed to Windows\' panel (Win+K)' : words(r.error)}`);
      return r.ok ? { ok: true, fellBack: true, reason: null } : { ok: false, reason: `Windows' Cast panel did not open (${plainErr(r.error)}); press Win+K` };
    });

    /* ---- keys, displays, switches ---- */
    ctx.onChord(CHORD, () => { const r = open('Win+P'); if (!r.ok) ctx.log(`Win+P: ${r.reason}`); });
    ctx.onEnabled((on) => { if (!on && win) { if (phase === 'confirm') finish(false, 'switched off'); else destroy(); } emit(); });
    let unscreen = null;
    if (el && el.screen && typeof el.screen.on === 'function') {
      const onScreen = () => { read('the displays changed'); if (win && !win.isDestroyed()) place(win, phase === 'confirm'); };
      for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) el.screen.on(ev, onScreen);
      unscreen = () => { for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) { try { el.screen.removeListener(ev, onScreen); } catch (_) { /* gone */ } } };
    }
    ctx.sidecar.onReady(() => { const t = setTimeout(() => read('start'), test ? 50 : 2500); if (t.unref) t.unref(); });
    ctx.health(true, READY);

    return {
      stop(why) {
        // a change still waiting is put back NOW (never left on without its way back); the sidecar's
        // own timer and exit hook do it too if this send is lost
        if (confirm && !confirm.dry && phase === 'confirm') { try { ctx.sidecar.send('sysdisplay.revert', { token: confirm.token }, { timeoutMs: 2000 }); } catch (_) { /* its timer does it */ } }
        stopped = true;
        if (unscreen) unscreen();
        if (closeTimer) clearTimeout(closeTimer);
        if (tick) clearInterval(tick);
        const w = win; win = null;
        try { if (w && !w.isDestroyed()) w.destroy(); } catch (_) { /* gone */ }
        ctx.log(`stopped (${why || 'no reason'}); Win+P is Windows' own again`);
      },
      // tests: the state without a page
      _test: { state, open, pick, finish, read, painted, destroy, choose() { phase = 'choose'; sel = core.startSel(last); emit(); } },
    };
  },
};

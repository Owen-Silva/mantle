'use strict';
/*
 * clipboard.js - Win+V: Mantle's clipboard history panel (wave 3, 2026-09-24).
 *
 * The history itself is the sidecar's (sidecar/ClipHistory.cs): Mantle's OWN, from
 * WM_CLIPBOARDUPDATE, in memory only, with pins DPAPI-encrypted in <userData>/features/. Windows'
 * own history (WinRT) was measured first and not used: on Owen's machine its Settings switch is off
 * (so it answers "ClipboardHistoryDisabled" with 0 items), it only works from an STA thread, and it
 * has no pin API at all. The reasoning and the numbers are at the top of ClipHistory.cs.
 *
 * WHAT A PASTE IS: Owen presses Win+V over a window, picks an item (Enter or a click). This file
 * hides the panel, and the sidecar puts the item on the clipboard, brings THAT window back to the
 * front and presses Ctrl+V into it (clip.paste). The product acting on Owen's own keypress. A
 * --test instance never does any of it: every paste there is a DRY RUN (formats built and decoded
 * back, nothing written, focused or typed), and the passive sidecar refuses the real one anyway.
 *
 * Nothing Owen copied is ever logged: log lines carry counts, kinds, formats and timings.
 */
const path = require('path');
const CM = require('../../ui/clipboard/model.js');
const raiseWin = require('../raise');
const surfaceGate = require('../surface-gate');

module.exports = {
  name: 'clipboard',
  label: 'Clipboard history (Win+V)',
  defaultOn: true,
  rest: true,                         // its window(s) close while a game runs (lib/features.js restAll)
  chords: ['Win+V'],
  observe: [],
  install(ctx) {
    const { BrowserWindow, screen } = require('electron');
    const test = !!ctx.flags.test;
    const pinsFile = path.join(path.dirname(ctx.settings.file), 'clipboard-pins.dat');
    const S = {
      win: null, open: false, arm: null, stopped: false, pageOk: false, pageWhy: null,
      sidecarWhy: null, painted: null, paintedWaiter: null, lastPaste: null, lastOpen: null,
      noticeTimer: null, opens: 0,
      kb: { ok: null, how: null, reason: null }, kbWatch: null, cancelled: 0,
    };

    // ---- health: one place decides, from the two things that can be wrong ------------------
    function judge() {
      if (S.stopped) return;
      const why = S.pageWhy || S.sidecarWhy;
      ctx.health(!why, why || undefined);
    }

    // ---- the window: pre-created, hidden, shown where the caret is --------------------------
    const win = new BrowserWindow({
      width: CM.PANEL_W + 2 * CM.MARGIN,
      height: CM.PANEL_H + 2 * CM.MARGIN,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      thickFrame: false,
      skipTaskbar: true,
      alwaysOnTop: !test,
      focusable: true,          // it takes typing: the filter
      hasShadow: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      title: 'Mantle clipboard',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
        spellcheck: false, backgroundThrottling: false,
      },
    });
    S.win = win;
    const wc = win.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('did-finish-load', () => { S.pageOk = true; S.pageWhy = null; judge(); });
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      S.pageWhy = `the clipboard panel failed to load (${description}, ${code})`;
      judge();
    });
    wc.on('render-process-gone', (_e, d) => {
      S.pageOk = false;
      S.pageWhy = `the clipboard panel crashed (${d && d.reason}); reopening it`;
      judge();
      if (!win.isDestroyed()) wc.reload();
    });
    wc.on('unresponsive', () => { S.pageWhy = 'the clipboard panel stopped responding'; judge(); });
    wc.on('responsive', () => { if (S.pageWhy === 'the clipboard panel stopped responding') { S.pageWhy = null; judge(); } });
    // Click-away closes, like Windows' panel. Only a focused (live) panel can lose focus.
    win.on('blur', () => { if (S.open && !test) hide('blur'); });
    win.on('focus', () => { if (S.open && S.kb.ok === false) kbVerdict({ ok: true, how: 'click' }); });
    win.loadFile(ctx.page('index.html'));

    // ---- the sidecar side --------------------------------------------------------------------
    async function startSidecar() {
      if (S.stopped || !ctx.enabled()) return;
      // A test instance does not listen at all: its items are seeded (the self-test), so none of
      // Owen's copies can reach a test page or a screenshot.
      const r = await ctx.sidecar.send('clip.start', { pinsFile, listen: !test }, { timeoutMs: 5000 });
      if (!r.ok) {
        S.sidecarWhy = /unknown|not a command|no such/i.test(String(r.error))
          ? 'the sidecar is too old for clipboard history (it has no clip.start)'
          : `clipboard history could not start: ${r.error}`;
      } else if (!test && r.result.mode !== 'history') {
        S.sidecarWhy = `not recording copies: ${r.result.error || 'the listener is off'}`;
      } else {
        S.sidecarWhy = null;
        ctx.log(`started: mode ${r.result.mode}, ${r.result.count} items (${r.result.pinned} pinned)` +
                (r.result.pinsError ? `, pins: ${r.result.pinsError}` : ''));
      }
      judge();
    }
    ctx.sidecar.onReady(() => { startSidecar(); });
    ctx.sidecar.on('clip', (ev) => {
      if (ev.what === 'changed' && S.open) refresh();
      else if (ev.what === 'skipped' && ev.reason === 'busy') ctx.log('a copy was missed: another app held the clipboard');
    });
    ctx.onEnabled((on) => {
      if (on) startSidecar();
      else { hide('off'); ctx.sidecar.send('clip.stop', {}); }
    });

    async function list() {
      const r = await ctx.sidecar.send('clip.list', {}, { timeoutMs: 2500 });
      if (!r.ok) throw new Error(`the clipboard history could not be read: ${r.error}`);
      return r.result;
    }
    async function refresh() {
      try { ctx.push(win, 'clipboard.changed', { list: await list() }); }
      catch (e) { ctx.log(e.message); }
    }

    // ---- open / hide ---------------------------------------------------------------------------
    function anchorDip(arm) {
      const p = arm && (arm.caret || arm.cursor);
      if (!p) { const c = screen.getCursorScreenPoint(); return { x: c.x, y: c.y, h: 0 }; }
      const d = screen.screenToDipPoint({ x: p.x, y: p.y });
      const disp = screen.getDisplayNearestPoint(d);
      return { x: d.x, y: d.y, h: arm.caret ? arm.caret.h / (disp.scaleFactor || 1) : 0 };
    }

    /* Every Win+V, Esc, click-away and paste goes through ONE state machine (lib/surface-gate.js,
       audit #14): opening waits up to ~1.1 s for clip.arm + clip.list, and a second Win+V in that
       gap used to start a second open; now it cancels the first, and the last press wins. */
    const gate = surfaceGate.createGate({
      isShown: () => S.open && !win.isDestroyed() && win.isVisible(),
      log: ctx.log,
      prepare: async ({ alive }) => {
        S.t0 = Date.now();
        clearTimeout(S.noticeTimer);
        // FIRST, before anything of ours can take the foreground: what Win+V was pressed over.
        const a = await ctx.sidecar.send('clip.arm', {}, { timeoutMs: 800 });
        if (!alive()) return;
        S.arm = a.ok ? a.result
          : { error: `Mantle could not tell which window you came from (${a.error}), so choosing an item will copy it but not paste it.` };
        let payload;
        try { payload = { list: await list(), arm: S.arm }; }
        catch (e) { payload = { list: null, error: e.message, arm: S.arm }; }
        if (!alive() || win.isDestroyed()) return;
        const anchor = anchorDip(S.arm);
        const work = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea;
        const r = CM.place(anchor, work);
        win.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
        const painted = new Promise((res) => { S.paintedWaiter = res; setTimeout(() => res(null), 300); });
        ctx.push(win, 'clipboard.show', payload);
        const pt = await painted;
        S.pending = { painted: !!pt, items: payload.list ? payload.list.count : null,
                      anchor: S.arm && S.arm.caret ? 'caret' : 'pointer', bounds: r, work };
      },
      reveal: ({ again, from }) => {
        if (win.isDestroyed()) throw new Error('the clipboard panel is gone');
        if (again) return;                 // Win+V is a toggle: an open over an open panel is never asked
        S.open = true;
        if (test) win.showInactive();       // never in front of Owen, never focused, in a test
        else {
          win.show(); win.focus();
          // On top EVERY time (r7-ontop): show() and focus() never lift a window Windows has let sink.
          raiseWin.up(win, { what: 'the clipboard panel', log: ctx.log, wanted: () => S.open && !win.isDestroyed() });
          armKeyboard();
        }
        S.opens++;
        S.lastOpen = Object.assign({ from, ms: Date.now() - S.t0 }, S.pending || {});
        ctx.log(`opened by ${from} in ${S.lastOpen.ms} ms: ${S.lastOpen.items} items, at the ${S.lastOpen.anchor}`);
      },
      conceal: (why) => conceal(why),
    });

    /** Win+V: open, or close if it is open or still opening. Resolves {opened} or {opened:false, reason}. */
    async function open(from) {
      if (S.stopped || !ctx.enabled() || win.isDestroyed()) return { opened: false, reason: 'off' };
      const r = await gate.toggle(from);
      if (r.closed !== undefined) return { opened: false, reason: r.was === 'opening' ? 'was opening: cancelled' : 'was open: closed' };
      if (!r.opened) S.cancelled++;
      return r;
    }

    function conceal(why) {
      stopKbWatch();
      if (win.isDestroyed()) return;
      if (S.open || win.isVisible()) { win.hide(); ctx.push(win, 'clipboard.hide', { why }); }
      S.open = false;
    }

    function hide(why) {
      if (win.isDestroyed()) return;
      gate.close(why);         // cancels an open still on its way
      conceal(why);            // and a notice's inactive panel, which the gate never opened
    }

    /* ---- its keyboard (audit #7): checked, retried once through the sidecar's focus ladder, else
       SAID in the panel, and a click outside or Esc still closes it. Live only. ---- */
    function stopKbWatch() { if (S.kbWatch) { S.kbWatch.stop(); S.kbWatch = null; } }
    function armKeyboard() {
      const seq = gate.seq;
      surfaceGate.ensureKeyboard({
        alive: () => S.open && gate.seq === seq && !win.isDestroyed() && win.isVisible(),
        isFocused: () => win.isFocused(),
        // Win+V never reached Mantle's own process (the sidecar's hook took it), so there is no
        // foreground right here to hand on (lib/fg-grant.js); the sidecar's ladder is the retry.
        retry: async () => {
          const buf = win.getNativeWindowHandle();
          const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
          const r = await ctx.sidecar.send('focus', { hwnd }, { timeoutMs: 2000 });
          if (!r.ok) throw new Error(String(r.error).split('; tried ')[0]);
        },
        onResult: kbVerdict,
      }).catch((e) => ctx.log(`the keyboard check threw (${e && e.message})`));
    }
    /** {ok, how} or {ok:false, reason}; a test drives it by hand (the self-test). */
    function kbVerdict(r, watchKeys) {
      if (win.isDestroyed()) return;
      stopKbWatch();
      if (r.ok) {
        if (S.kb.ok === false) ctx.push(win, 'clipboard.keyboard', { ok: true });
        S.kb = { ok: true, how: r.how, reason: null };
        return;
      }
      S.kbWatch = surfaceGate.watchOutside({
        keys: watchKeys,
        bounds: () => (win.isDestroyed() ? null : win.getBounds()),
        cursor: () => screen.getCursorScreenPoint(),
        onOutside: (why) => { S.kbWatch = null; hide(why); },
      });
      S.kb = { ok: false, how: null, reason: r.reason };
      ctx.push(win, 'clipboard.keyboard', { ok: false, text: surfaceGate.noKeyboardWords(r.reason, S.kbWatch.ok) });
      ctx.log(`shown WITHOUT the keyboard (${r.reason}); ${S.kbWatch.ok ? 'a click outside or Esc closes it' : `no outside-click watch: ${S.kbWatch.reason}`}`);
    }

    /** Main's own notice: the panel comes back WITHOUT focus for a few seconds, saying why. */
    function notice(title, text) {
      if (win.isDestroyed()) return;
      ctx.push(win, 'clipboard.notice', { title, text, ms: 6000 });
      if (!win.isVisible()) win.showInactive();
      // An announcement nobody can see is a silent failure: on top every time, never focused.
      if (!test) raiseWin.up(win, { what: 'the clipboard notice', log: ctx.log, wanted: () => !win.isDestroyed() && win.isVisible() });
      clearTimeout(S.noticeTimer);
      S.noticeTimer = setTimeout(() => { if (!S.open) hide('notice'); }, 6000);
    }

    // ---- paste ---------------------------------------------------------------------------------
    async function paste(item) {
      const target = S.arm && S.arm.hwnd;
      hide('paste');            // first: the window Owen came from has to be able to come back
      const dryRun = test;      // a test instance NEVER writes the clipboard or types
      const r = await ctx.sidecar.send('clip.paste', { item, hwnd: target || '0', dryRun }, { timeoutMs: 4000 });
      const res = r.ok ? r.result : null;
      S.lastPaste = { at: Date.now(), dryRun, ok: r.ok, error: r.ok ? null : r.error, target,
                      pasted: res ? !!res.pasted : false, reason: res ? res.reason || res.wouldSay || null : null,
                      formats: res && res.formats ? res.formats.map((f) => f.name) : [],
                      roundTrip: res ? res.roundTrip : undefined, wouldSend: res ? res.wouldSend : undefined,
                      ms: res ? res.ms : null };
      if (!r.ok) {
        ctx.log(`paste failed: ${r.error}`);
        notice('Not pasted', r.error);
      } else if (!dryRun && !res.pasted) {
        ctx.log(`copied, not pasted: ${res.reason}`);
        notice('Copied, not pasted', res.reason);
      } else {
        ctx.log(`${dryRun ? 'dry-run ' : ''}paste: ${S.lastPaste.formats.join('+')} in ${S.lastPaste.ms} ms`);
      }
      return { pasted: S.lastPaste.pasted, dryRun };
    }

    // ---- the page's commands -----------------------------------------------------------------
    const itemArg = (args) => {
      const item = args && typeof args.item === 'string' ? args.item : '';
      if (!/^c\d+$/.test(item)) throw new Error('no item was chosen');
      return item;
    };
    async function thenList(cmd, args) {
      const r = await ctx.sidecar.send(cmd, args, { timeoutMs: 2500 });
      if (!r.ok) throw new Error(r.error);
      return list();
    }
    ctx.command('paste', async (args) => paste(itemArg(args)));
    ctx.command('pin', async (args) => thenList('clip.pin', { item: itemArg(args), pinned: !!(args && args.pinned) }));
    ctx.command('delete', async (args) => thenList('clip.delete', { item: itemArg(args) }));
    ctx.command('clear', async () => thenList('clip.clear', {}));
    ctx.command('close', async () => { hide('esc'); return {}; });
    ctx.command('painted', async (args) => {
      S.painted = { at: Date.now(), count: args && args.count };
      if (S.paintedWaiter) { S.paintedWaiter(S.painted); S.paintedWaiter = null; }
      return {};
    });

    ctx.onChord('Win+V', () => open('Win+V'));

    let selftest = null;
    if (test && process.env.MANTLE_CLIP_SELFTEST === '1') {
      selftest = require('./_clipboard-selftest.js');
      selftest.start({ ctx, S, open, hide, list, gate, kbVerdict });
    }

    return {
      stop(why, how) {
        S.stopped = true;
        if (selftest && selftest.stop) selftest.stop();
        clearTimeout(S.noticeTimer);
        if (!win.isDestroyed()) win.destroy();
        // Resting while a game runs (lib/features.js restAll): only the window goes. The history
        // lives in the sidecar and keeps listening, so Win+V after the game still has it all.
        if (how && how.rest) return;
        // Nothing in Windows was changed: the clipboard listener dies with the sidecar, and the
        // memory-only history with it. clip.stop just says so early.
        ctx.sidecar.send('clip.stop', {}, { timeoutMs: 1500 });
      },
    };
  },
};

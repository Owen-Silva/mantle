'use strict';
/*
 * lib/features/emoji.js - Win+. and Win+;: Mantle's emoji picker, in place of Windows' emoji panel
 * (lane mantle-emoji, 2026-10-15; plan notes/mantle-replace-windows.md P11). Page: ui/emoji.
 * Sidecar: sidecar/Emoji.cs (arm, the key watch, Unicode typing, the hand-off to Windows' panel).
 *
 * THE APP KEEPS THE FOCUS. The panel is focusable:false (WS_EX_NOACTIVATE) and is shown inactive, so
 * the app you were typing in never loses the keyboard; the sidecar's watch takes the picker's keys
 * while the panel is open (emoji.watch) and they arrive here as `emoji` events, then at the page. A
 * pick is typed into that app with Unicode SendInput (emoji.type). If the watch cannot be had, the
 * panel takes the keyboard itself and the focus is handed back to the app before each pick is typed
 * (that mode closes after a pick: handing the keyboard back and forth would flicker the app).
 *
 * ADMIN APPS: Windows does not let Mantle (not elevated) type into an elevated window, and says
 * nothing when it blocks it. emoji.arm says `elevated`, so the press goes to Windows' own panel
 * (emoji.windows) and the panel says why for a few seconds.
 *
 * RAM (Owen's rule): no window until the first Win+.; after a close it is kept hidden IDLE_MS (a second
 * pick a minute later is warm) and then destroyed; nothing runs while hidden. A game rest destroys it.
 *
 * FAIL-OPEN: Win+. / Win+; are taken only while this is on, healthy and Mantle is not resting
 * (lib/features.js); an old sidecar exe without emoji.* hands both back to Windows (the probe).
 *
 * PRIVATE: what Owen picks is kept in <userData>/features/emoji.json (recents, his skin tone, and the
 * emoji he used per app, by exe file name only). Log lines carry timings and counts, never an emoji.
 */
const M = require('../../ui/emoji/model.js');
const raiseWin = require('../raise');

const CHORDS = ['Win+.', 'Win+;'];
const READY = 'Win+. opens the emoji picker';
const IDLE_MS = 2 * 60 * 1000;
const LEASE_MS = 6000, RENEW_MS = 2000;
const PER_APP = 12, APPS_MAX = 30;

module.exports = {
  name: 'emoji',
  label: 'Emoji picker (Win+.)',
  defaultOn: true,
  rest: true,
  chords: CHORDS,
  observe: [],
  options: [
    { key: 'closeAfterInsert', label: 'Close after picking', type: 'bool', default: false,
      help: "Off: Enter types the emoji and the picker stays open, as Windows' does (Shift+Enter types and closes). On: the other way round." },
  ],
  install(ctx) {
    const { BrowserWindow, screen, clipboard } = require('electron');
    const test = !!ctx.flags.test;
    const S = { win: null, loaded: null, open: false, arm: null, t0: 0, from: '', warm: false, idle: null, renew: null,
                watch: false, kbSelf: false, stopped: false, opens: 0, last: null, hideTimer: null, touched: false, seq: 0 };
    let recents = arr(ctx.settings.get('recents', []));
    let tone = M.clampTone(ctx.settings.get('tone', 0));
    let apps = obj(ctx.settings.get('apps', {}));

    function arr(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 64) : []; }
    function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    function save(k, v) { try { ctx.settings.set(k, v); } catch (e) { ctx.log(`${k} could not be saved: ${e.message}`); } }
    const closeAfter = () => !!ctx.settings.get('closeAfterInsert', false);
    const hwndOf = (w) => { const b = w.getNativeWindowHandle(); return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0)); };
    const appName = (exe) => (exe ? exe.replace(/\.exe$/i, '').replace(/^./, (c) => c.toUpperCase()) : null);

    // ---- the window: made on demand, kept hidden IDLE_MS after a close, then destroyed ----------
    function makeWindow() {
      const win = new BrowserWindow({
        width: M.PANEL_W + 2 * M.MARGIN, height: M.PANEL_H + 2 * M.MARGIN, show: false, frame: false,
        transparent: true, backgroundColor: '#00000000', hasShadow: false, thickFrame: false, resizable: false,
        skipTaskbar: true, focusable: false, alwaysOnTop: !test, fullscreenable: false, minimizable: false,
        maximizable: false, title: 'Mantle emoji',
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
                          spellcheck: false, backgroundThrottling: false },
      });
      if (!test) win.setAlwaysOnTop(true, 'pop-up-menu');
      const wc = win.webContents;
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('render-process-gone', (_e, d) => { ctx.log(`the picker page crashed (${d && d.reason}); it is made again on the next Win+.`); drop('crash'); });
      win.on('closed', () => { if (S.win === win) { S.win = null; S.loaded = null; S.open = false; } });
      S.win = win;
      S.loaded = new Promise((res) => {
        wc.once('did-finish-load', () => res(true));
        wc.once('did-fail-load', (_e, code, desc) => { ctx.log(`the picker page failed to load (${desc}, ${code})`); res(false); });
      });
      win.loadFile(ctx.page('index.html'));
      return win;
    }
    function drop(why) {
      clearTimeout(S.idle); S.idle = null;
      stopWatch(why);
      const w = S.win;
      S.win = null; S.loaded = null; S.open = false;
      if (w && !w.isDestroyed()) w.destroy();
    }

    // ---- open ------------------------------------------------------------------------------------
    async function open(from) {
      if (S.stopped || !ctx.enabled()) return { opened: false, reason: 'off' };
      if (S.open) { close('again'); return { opened: false, reason: 'was open: closed' }; }
      const seq = ++S.seq;
      S.t0 = Date.now(); S.from = from; S.touched = false;
      clearTimeout(S.idle); S.idle = null;
      S.warm = !!(S.win && !S.win.isDestroyed());
      const win = S.warm ? S.win : makeWindow();
      // what Win+. was pressed over (one Ui-lane read, ~1 ms); a --test run never reads the real foreground
      const armP = test ? Promise.resolve({ ok: true, result: testArm() }) : ctx.sidecar.send('emoji.arm', {}, { timeoutMs: 150 });
      const [a, loaded] = await Promise.all([armP, S.loaded]);
      if (seq !== S.seq || win.isDestroyed()) return { opened: false, reason: 'superseded' };
      if (!loaded) { drop('load'); return { opened: false, reason: 'the picker page did not load' }; }
      S.arm = a.ok ? a.result : { hwnd: null, error: a.error };
      const elevated = S.arm.elevated && !S.arm.selfElevated;
      if (elevated) {
        const h = test ? { ok: true, result: { dryRun: true } } : await ctx.sidecar.send('emoji.windows', {}, { timeoutMs: 1500 });
        const name = appName(S.arm.app) || 'That window';
        const text = `${name} runs as administrator, so Mantle can't type into it. ${h.ok ? "Windows' emoji panel opened instead." : `Press Win+. again once you are out of it (${h.error}).`}`;
        ctx.log(`over an administrator window: handed to Windows' panel (${h.ok ? 'sent' : h.error})`);
        notice(win, text);
        return { opened: false, reason: 'elevated', handedOff: !!h.ok };
      }
      const anchor = anchorDip(S.arm);
      const work = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea;
      const r = M.place(anchor, work);
      const above = r.y + M.MARGIN < anchor.y;
      win.setBounds(r);
      ctx.push(win, 'emoji.show', payload({ above, notice: S.arm.hwnd ? null : `Mantle couldn't tell which window you were in, so a pick is copied: paste it with Ctrl+V.` }));
      S.open = true;
      win.showInactive();
      if (!test) raiseWin.up(win, { what: 'the emoji picker', log: ctx.log, wanted: () => S.open && !win.isDestroyed() });
      S.shownMs = Date.now() - S.t0;
      S.opens++;
      startWatch(win);
      if (!test && !S.arm.caret && S.arm.hwnd) refineCaret(seq, win);
      return { opened: true, warm: S.warm, shownMs: S.shownMs, anchor: S.arm.caret ? S.arm.caret.via : 'pointer' };
    }

    function testArm() {
      const c = screen.getCursorScreenPoint();
      const p = screen.dipToScreenPoint(c);
      return { hwnd: '0', pid: 0, app: 'mantle-test.exe', cursor: { x: p.x, y: p.y }, caret: null, elevated: !!S.testElevated, selfElevated: false };
    }

    function anchorDip(arm) {
      const p = arm && (arm.caret || arm.cursor);
      if (!p) { const c = screen.getCursorScreenPoint(); return { x: c.x, y: c.y, h: 0 }; }
      const d = screen.screenToDipPoint({ x: p.x, y: p.y });
      const disp = screen.getDisplayNearestPoint(d);
      return { x: d.x, y: d.y, h: arm.caret ? arm.caret.h / (disp.scaleFactor || 1) : 0 };
    }

    /** No system caret: ask UI Automation (Slow lane, <= 300 ms) and move once if it answers before
        Owen has typed or pointed at anything. Never for Chromium windows (Emoji.cs says why). */
    async function refineCaret(seq, win) {
      const r = await ctx.sidecar.send('emoji.caret', { hwnd: S.arm.hwnd, pid: S.arm.pid }, { timeoutMs: 600 });
      if (seq !== S.seq || !S.open || S.touched || win.isDestroyed() || !r.ok || !r.result || !r.result.caret) return;
      if (Date.now() - S.t0 > 450) return;
      S.arm.caret = r.result.caret;
      const anchor = anchorDip(S.arm);
      const work = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea;
      const b = M.place(anchor, work);
      win.setBounds(b);
      ctx.push(win, 'emoji.moved', { above: b.y + M.MARGIN < anchor.y });
    }

    function payload(extra) {
      const app = S.arm && S.arm.app;
      return Object.assign({
        recents, tone, closeAfter: closeAfter(), app: appName(app), appPicks: app ? arr(apps[app]).slice(0, PER_APP) : [],
        warm: S.warm, t0: S.t0, kbSelf: false,
      }, extra || {});
    }

    function notice(win, text) {
      const c = screen.getCursorScreenPoint();
      const work = screen.getDisplayNearestPoint(c).workArea;
      win.setBounds(M.place({ x: c.x, y: c.y - M.PANEL_H, h: 0 }, work));
      ctx.push(win, 'emoji.notice', { text, ms: 4500 });
      win.showInactive();
      if (!test) raiseWin.up(win, { what: 'the emoji notice', log: ctx.log, wanted: () => !win.isDestroyed() && win.isVisible() });
      clearTimeout(S.hideTimer);
      S.hideTimer = setTimeout(() => { if (!S.open) hideNow('notice'); }, 4800);
    }

    // ---- the key watch -----------------------------------------------------------------------------
    async function startWatch(win) {
      S.kbSelf = false;
      if (test) { S.watch = false; return; }      // keys come from emoji.testkey in a test
      const args = { on: true, hwnd: S.arm.hwnd, panel: hwndOf(win), leaseMs: LEASE_MS };
      const r = S.arm.hwnd ? await ctx.sidecar.send('emoji.watch', args, { timeoutMs: 1500 }) : { ok: false, error: 'no window to type into' };
      if (!S.open || win.isDestroyed()) { if (r.ok) ctx.sidecar.send('emoji.watch', { on: false }); return; }
      if (r.ok) {
        S.watch = true;
        clearInterval(S.renew);
        S.renew = setInterval(() => { if (S.open) ctx.sidecar.send('emoji.watch', args, { timeoutMs: 1500 }); }, RENEW_MS);
        return;
      }
      // no watch: the panel takes the keyboard itself, and a pick hands the focus back first
      ctx.log(`the key watch could not start (${r.error}); the picker takes the keyboard itself`);
      S.kbSelf = true;
      win.setFocusable(true);
      win.focus();
      ctx.push(win, 'emoji.keyboard', { self: true, closeAfter: true });
    }
    function stopWatch() {
      clearInterval(S.renew); S.renew = null;
      if (S.watch) { S.watch = false; ctx.sidecar.send('emoji.watch', { on: false }, { timeoutMs: 1500 }); }
    }

    ctx.sidecar.on('emoji', (ev) => {
      if (!S.open || !S.win || S.win.isDestroyed()) return;
      if (ev.what === 'key') { S.touched = true; ctx.push(S.win, 'emoji.key', { key: ev.key, text: ev.text, shift: !!ev.shift }); }
      else { S.watch = false; close(ev.what === 'lost' ? 'lost' : (ev.why || ev.what)); }
    });

    // ---- close -------------------------------------------------------------------------------------
    function close(why) {
      if (!S.open) return;
      S.open = false;
      S.seq++;
      stopWatch(why);
      const win = S.win;
      if (!win || win.isDestroyed()) return;
      ctx.push(win, 'emoji.hide', { why });        // the page plays its exit, then says emoji.hidden
      clearTimeout(S.hideTimer);
      S.hideTimer = setTimeout(() => hideNow(why), 220);
      ctx.log(`closed (${why})`);
    }
    function hideNow() {
      clearTimeout(S.hideTimer);
      const win = S.win;
      if (!win || win.isDestroyed() || S.open) return;
      if (S.kbSelf) { win.setFocusable(false); S.kbSelf = false; }
      win.hide();
      clearTimeout(S.idle);
      S.idle = setTimeout(() => { if (!S.open) drop('idle'); }, IDLE_MS);
    }

    // ---- what the page asks ------------------------------------------------------------------------
    ctx.command('painted', async (a) => {
      // R7: one truthful line per open, after the page's second frame with real content
      if (!S.win || S.win.isDestroyed() || !S.win.isVisible()) return { ok: false };
      const painted = Date.now() - S.t0;
      const interactive = a && Number.isFinite(a.readyAt) ? Math.max(painted, a.readyAt - S.t0) : painted;
      S.last = { n: S.opens, warm: S.warm, from: S.from, shown: S.shownMs, painted, interactive, watch: S.watch, kbSelf: S.kbSelf };
      ctx.log(`emoji: opened (${S.warm ? 'warm' : 'cold'}) via ${S.from}: shown ${S.shownMs}, painted ${painted}, interactive ${interactive} ms`);
      return { ok: true };
    });
    ctx.command('hidden', async () => { hideNow('page'); return { ok: true }; });
    ctx.command('close', async (a) => { close((a && a.why) || 'page'); return { ok: true }; });
    ctx.command('tone', async (a) => { tone = M.clampTone(a && a.tone); save('tone', tone); return { tone }; });
    ctx.command('touched', async () => { S.touched = true; return { ok: true }; });
    ctx.command('insert', async (a) => {
      const ch = a && typeof a.ch === 'string' ? a.ch : '';
      if (!ch || ch.length > 64) return { typed: false, reason: 'nothing to type' };
      S.touched = true;
      const closeNow = !!(a && a.close) || S.kbSelf;
      const target = S.arm && S.arm.hwnd;
      let res;
      if (!target) {
        clipboard.writeText(ch);
        res = { typed: false, copied: true, reason: "Copied: paste it with Ctrl+V." };
      } else {
        if (S.kbSelf && S.win && !S.win.isDestroyed()) S.win.hide();   // the app must be able to come back
        const r = await ctx.sidecar.send(S.kbSelf && !test ? 'emoji.typeback' : 'emoji.type', { hwnd: target, text: ch, dryRun: test }, { timeoutMs: 2500 });
        res = r.ok ? { typed: !test, dryRun: test, units: r.result.units } : { typed: false, reason: r.error };
        if (!r.ok) {
          clipboard.writeText(ch);
          res.copied = true;
          res.reason = `${cap(r.error)}. It is copied: paste it with Ctrl+V.`;
        }
      }
      if (res.typed || res.dryRun || res.copied) {
        recents = M.remember(recents, ch); save('recents', recents);
        const app = S.arm && S.arm.app;
        if (app) {
          const next = Object.assign({}, apps);
          delete next[app];
          next[app] = M.remember(arr(apps[app]), ch).slice(0, PER_APP);
          const keys = Object.keys(next);
          while (keys.length > APPS_MAX) delete next[keys.shift()];
          apps = next; save('apps', apps);
        }
      }
      ctx.log(`pick: ${res.typed ? 'typed' : res.dryRun ? 'dry run' : res.copied ? 'copied' : 'refused'}${a && a.via ? ` by ${a.via}` : ''}`);
      if (closeNow || (!res.typed && !res.dryRun)) close(res.typed || res.dryRun ? 'insert' : 'not typed');
      return Object.assign(res, { recents });
    });
    function cap(s) { s = String(s || 'it was not typed'); return s.charAt(0).toUpperCase() + s.slice(1); }

    if (test) {
      // TEST ONLY: the e2e opens it as the chord would, and plays the watch's keys
      ctx.command('testopen', async (a) => { S.testElevated = !!(a && a.elevated); return open('test'); });
      ctx.command('testkey', async (a) => { if (S.open && S.win) ctx.push(S.win, 'emoji.key', a || {}); return { open: S.open }; });
      ctx.command('teststate', async () => {
        const w = S.win, live = !!(w && !w.isDestroyed());
        // the picker window's own renderer process, for the RAM it costs (emoji.e2e.test.js)
        const pid = live ? w.webContents.getOSProcessId() : 0;
        const m = pid ? require('electron').app.getAppMetrics().find((x) => x.pid === pid) : null;
        return { open: S.open, warm: S.warm, hasWindow: live, last: S.last, opens: S.opens, recents, tone,
          pid, memory: m ? m.memory : null, visible: live && w.isVisible(), bounds: live ? w.getBounds() : null,
          focusable: live ? w.isFocusable() : null };
      });
      ctx.command('testclose', async () => { close('test'); return { ok: true }; });
      ctx.command('testdrop', async () => { drop('test'); return { ok: true }; });
    }

    // ---- keys and health -----------------------------------------------------------------------------
    for (const c of CHORDS) {
      ctx.onChord(c, () => open(c).catch((e) => ctx.log(`open failed: ${e && e.stack ? e.stack.split('\n')[0] : e}`)));
    }
    ctx.onEnabled((on) => { if (!on) drop('off'); });
    ctx.sidecar.onReady(async () => {
      const r = await ctx.sidecar.send('emoji.verdict', { vk: 0x41 }, { timeoutMs: 3000 });
      if (r.ok) ctx.health(true, READY);
      else ctx.health(false, /unknown|no such|not a command/i.test(String(r.error)) ? 'the sidecar exe has no emoji commands yet: run npm run build:sidecar' : `the sidecar did not answer (${r.error})`);
    });
    ctx.health(true, READY);
    return {
      stop(why) { S.stopped = true; clearTimeout(S.hideTimer); drop(why || 'stop'); },
    };
  },
};

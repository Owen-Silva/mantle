'use strict';
/*
 * taskview.js - Mantle's Task View: Win+Tab opens a full-screen overview of the windows on this
 * desktop (live DWM pictures), with the virtual desktops across the top (wave 3, 2026-09-24).
 *
 * THE PIECES: sidecar/Desktops.cs (the Alt+Tab list tagged with desktops, the desktops, every write
 * with a dry run), ui/taskview/* (the page; layout.js is its geometry), and this file, which owns
 * the window, the session and the DWM thumbnails (lib/thumbs.js, a set of its own: 'taskview').
 *
 * ONE OPEN:
 *   chord  Win+Tab (the seam's hook; ctx.test.fireChord in --test)
 *   list   taskview.list: Switcher.ListNow + desktops. Measured 2026-09-24: 1-2 ms warm round
 *          trip, ~20 ms cold (Desktops.cs warms its COM objects at sidecar start).
 *   open   the PARKED window (pre-created, off screen above its monitor, compositor warm) is sized
 *          to the monitor and the page gets the session. It draws while still parked.
 *   paint  the page reports its preview boxes; the first 8 thumbnails are registered, the window
 *          comes on screen, then the rest are registered on the next turn (progressive fill).
 *   end    Esc, click-away, a switch, Win+Tab again: thumbnails unregistered FIRST, then parked.
 *
 * WHY PARKED AND NOT hide()/show(): lib/switcher.js measured it (a hide()/show() cycle cost a
 * transparent always-on-top window its mousedowns); parked also keeps the compositor warm.
 *
 * WHAT THE PAGE MAY ASK (quality pass, 2026-09-29): only about THIS session's windows and desktops.
 * activate / close / move name a window the session listed; switch / remove / rename / move name a
 * desktop it listed; a name is a string of at most 100 characters. Anything else is refused in plain
 * words before it reaches the sidecar, so a confused (or hostile) page cannot close or move a window
 * it never showed. Every reason the page shows is plain words; the technical one goes to the log.
 *
 * --test: the window is NEVER shown (its page still runs and is measured), nothing is focused,
 * and every action is a DRY RUN: activate / switch / create / remove / rename / move answer with
 * the plan and change nothing; close refuses outright. (The passive sidecar refuses real writes
 * too; this is the second lock.)
 */
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const thumbs = require('../thumbs');
const { hwndOf } = require('../windows');
const raiseWin = require('../raise');
const WW = require('./_wall-window.js');

const TITLE = 'Mantle task view';
const GAP = 64;                 // how far off the monitor the parked window waits
const FIRST_BATCH = 8;          // thumbnails registered before the reveal; the rest right after
const REVEAL_LATE_MS = 450;     // a page that has not painted by now is revealed anyway (and logged)
const KB_WAIT_MS = 350;         // drawn, still no keyboard: shown anyway at this point (the ladder goes on after)
const FOLD_CAP_MS = 400;        // ending: the page folds shut, then the park; at this point it is parked anyway (THE FOLD SHUT)
const FOLD_JS = 'window.MantleTaskViewFold && window.MantleTaskViewFold()';
const BLUR_GRACE_MS = 120;      // a blur that is back by now (focus hopping) is not a loss
/* SPEED DEBT (lane speeddebt, 2026-10-15; live before it: shown p50 86 / p95 287 ms, 77 opens). The
 * slow opens were the FIRST after each start: the sidecar's first desktops read (30-84 ms, COM cold)
 * and the page's first real drawing (150-230 ms from list to drawn: layout, text, icons, the wall
 * backdrop, each done for the first time). Two fixes, neither adds a window or any RAM:
 *   - THE LIST FROM A CACHE: the last list read is kept (one object). An open waits for the fresh
 *     list at most LIST_WAIT_MS (it is usually back in ~15 ms, so nothing stale is ever drawn);
 *     slower than that, the cached list is drawn and the fresh one replaces it (taskview.update),
 *     placement included, after the paint.
 *   - ONE REHEARSAL at start-up, once things are idle (WARM_DELAY_MS after the page loaded): the
 *     real list is read (warms the sidecar's COM and fills the cache) and drawn once in the parked
 *     window, then emptied (taskview.warm). The same idea as the switcher's warm-up. */
const LIST_WAIT_MS = 25;
const WARM_DELAY_MS = 4000;

function now() { return Number(process.hrtime.bigint()) / 1e6; }

const HWND_RE = /^[1-9]\d{0,19}$/;
const DESK_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** The sidecar CLIENT's own failures (not running, no answer) in words for the screen. The
 *  sidecar's answers themselves are already plain (sidecar/Desktops.cs). */
function plain(msg) {
  const m = String(msg || '');
  if (/sidecar|cannot run "|did not answer "|ready line/i.test(m)) return 'Mantle\'s window helper is restarting; try again in a moment';
  return m || 'no reason was given';
}
function r1(v) { return Math.round(v * 10) / 10; }

module.exports = {
  name: 'taskview',
  label: 'Task View (Win+Tab)',
  defaultOn: true,
  rest: true,                         // its window(s) close while a game runs (lib/features.js restAll)
  chords: ['Win+Tab'],
  observe: [],

  install(ctx) {
    const test = !!ctx.flags.test;
    const S = {
      win: null, hwnd: 0, seq: 0, sess: null, ready: false, stopped: false, fold: null,   // fold: the fold shut in progress
      tset: thumbs.set('taskview', 'the Task View window', 'Task View'),
      icons: new Map(),          // hwnd -> { icon, exe } from the sidecar's windows push
      glass: null, glassSeq: 0,
      cache: null,               // the last taskview.list result: { res, at } (see SPEED DEBT)
      drewOnce: false,           // this page has drawn a list (an open or the warm-up): opens are warm
      warm: null,                // the warm-up: { timer, t0, listMs, n } while it runs
    };
    /* lane helm-wall-apps (2026-10-09): in DARK no blur-behind (sidecar glass 'off'): the page paints the desktop
       wallpaper under its one --lg-fill, as Helm does (lib/features/_wall-window.js, ui/shared/wall-bdrop.js),
       placed by the display Task view opens on (taskview.open `at`). Light: the acrylic blur-behind, unchanged. */
    const wall = WW.feed(ctx, { event: 'taskview.wall' });
    const dark = () => wall.dark();

    // ---------------------------------------------------------------- the window
    function alive() { return !!(S.win && !S.win.isDestroyed() && !S.win.webContents.isDestroyed()); }

    function parkRect(b) {
      const all = screen.getAllDisplays().map((d) => d.bounds);
      const hit = (x, y) => all.some((d) => x < d.x + d.width && x + b.width > d.x && y < d.y + d.height && y + b.height > d.y);
      const cands = [
        { x: b.x, y: b.y - b.height - GAP }, { x: b.x, y: b.y + b.height + GAP },
        { x: b.x - b.width - GAP, y: b.y }, { x: b.x + b.width + GAP, y: b.y },
      ];
      for (const c of cands) if (!hit(c.x, c.y)) return { x: c.x, y: c.y, width: b.width, height: b.height };
      return { x: -32000, y: -32000, width: b.width, height: b.height };
    }

    function down(reason) { S.ready = false; ctx.health(false, reason); end(reason); }

    function createWindow() {
      const b = screen.getPrimaryDisplay().bounds;
      const p = parkRect(b);
      const win = new BrowserWindow({
        x: p.x, y: p.y, width: p.width, height: p.height,
        // NOT resizable (lane tbdrift, 2026-09-27): no drag handles at its edges (lib/windows.js
        // noDragHandles); it is only ever sized by setBounds, which sizes a non-resizable window too
        show: false, frame: false, transparent: true, resizable: false, thickFrame: false,
        skipTaskbar: true, alwaysOnTop: !test, focusable: true,     // it takes typing (the filter)
        hasShadow: false, fullscreenable: false, minimizable: false, maximizable: false,
        title: TITLE, backgroundColor: '#00000000',
        webPreferences: {
          preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
          spellcheck: false, backgroundThrottling: false,
        },
      });
      S.win = win;
      S.hwnd = Number(hwndOf(win)) || 0;
      wall.attach(win, { follow: false });
      const wc = win.webContents;
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('console-message', (...a) => {
        const d0 = a[1] && typeof a[1] === 'object' && 'message' in a[1] ? a[1] : null;
        const level = d0 ? d0.level : a[1];
        const bad = typeof level === 'string' ? (level === 'error' || level === 'warning') : level >= 2;
        if (bad) ctx.log(`[page] ${d0 ? d0.message : a[2]}`);
      });
      wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) down(`the Task View page failed to load (${description}, ${code})`);
      });
      wc.on('did-finish-load', () => { S.ready = true; S.drewOnce = false; ctx.health(true); scheduleWarm(); });
      wc.on('render-process-gone', (_e, d) => {
        down(`the Task View page's renderer died (${d && d.reason}); reloading it`);
        setTimeout(() => { if (alive() && !S.stopped) wc.reload(); }, 500);
      });
      wc.on('unresponsive', () => down('the Task View page stopped responding'));
      wc.on('responsive', () => { S.ready = true; ctx.health(true); });
      win.on('blur', () => { if (!test && S.sess && S.sess.shown) onBlur(S.sess); });
      win.on('closed', () => {
        if (S.win !== win) return;
        S.tset.clear('the Task View window closed');
        S.win = null; S.hwnd = 0;
        if (!S.stopped) ctx.health(false, 'the Task View window was closed');
      });
      win.once('ready-to-show', () => {
        if (test || !alive()) return;          // a test run never puts it on screen, parked or not
        try { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); } catch (err) { down(`the Task View window would not show, even parked: ${err.message}`); }
      });
      win.loadFile(ctx.page('index.html'));
    }

    async function applyGlass() {
      if (!S.hwnd) return;
      const mine = ++S.glassSeq;            // a theme flip mid-call: the newest ask decides
      if (dark()) {
        const r = await ctx.sidecar.send('glass', { hwnd: String(S.hwnd), mode: 'off' }, { timeoutMs: 3000 });
        if (mine !== S.glassSeq) return;
        S.glass = r.ok && r.result && r.result.applied ? { ok: true, mode: 'off' } : { ok: false, mode: 'off', reason: r.ok ? 'Windows did not take the blur-behind off' : r.error };
        if (!S.glass.ok) ctx.log(`the blur-behind is still on in dark: ${S.glass.reason}`);
        return;
      }
      const r = await ctx.sidecar.send('glass', { hwnd: String(S.hwnd), mode: 'acrylic' }, { timeoutMs: 3000 });
      if (mine !== S.glassSeq) return;
      S.glass = r.ok && r.result && r.result.applied ? { ok: true } : { ok: false, reason: r.ok ? 'Windows did not apply the blur-behind' : r.error };
      if (!S.glass.ok) ctx.log(`no blur: ${S.glass.reason}`);
    }
    if (ctx.host && ctx.host.theme && typeof ctx.host.theme.onChange === 'function') {
      ctx.host.theme.onChange(() => { S.glass = null; applyGlass().catch((err) => ctx.log(`glass: ${err.message}`)); });
    }

    // ---------------------------------------------------------------- the session
    function displayFor(mon) {
      try {
        if (Array.isArray(mon) && mon.length === 4) {
          const c = screen.screenToDipPoint({ x: (mon[0] + mon[2]) / 2, y: (mon[1] + mon[3]) / 2 });
          return screen.getDisplayNearestPoint(c);
        }
      } catch (_) { /* below */ }
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    }

    function appOf(exe) { return exe ? path.basename(String(exe)).replace(/\.exe$/i, '') : ''; }

    function norm(it) {
      const c = S.icons.get(String(it.hwnd)) || {};
      return { hwnd: String(it.hwnd), title: String(it.title || ''), minimized: !!it.minimized, hung: !!it.hung,
               desktop: it.desktop || null, icon: c.icon || null, app: appOf(c.exe),
               iconReason: c.icon ? null : 'no icon yet: Mantle is still reading this window\'s program' };
    }

    function payloadOf(res) {
      return { list: (res.list || []).map(norm), desktops: res.desktops || null, others: (res.others || []).map((o) => ({ hwnd: String(o.hwnd), title: String(o.title || ''), desktop: o.desktop })) };
    }

    /** What the page may name in this session (see WHAT THE PAGE MAY ASK). */
    function learn(sess, pl) {
      if (!sess || !pl) return;
      sess.hwnds = new Set((pl.list || []).map((it) => it.hwnd));
      sess.desks = new Set(((pl.desktops && pl.desktops.list) || []).map((d) => String(d.id)));
    }

    function sameRect(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height; }

    /** What a person can see of a payload (no icons: those come separately), to tell whether the
     *  fresh list differs from the cached one that was drawn. */
    function listKey(pl) {
      return JSON.stringify([
        (pl.list || []).map((it) => [it.hwnd, it.title, it.minimized, it.hung, it.desktop]),
        pl.desktops, (pl.others || []).map((o) => [o.hwnd, o.title, o.desktop]),
      ]);
    }

    /** The fresh list, after a cached one was drawn: replaces it (and moves the window, if the open
     *  belongs on another display) only when something differs. */
    function freshLanded(sess, r) {
      if (S.sess !== sess || !alive() || !r) return;
      sess.cached.freshMs = r1(now() - sess.t0);
      if (!r.ok) {
        sess.cached.fail = plain(r.error);
        ctx.log(`#${sess.seq}: the fresh window list failed (${r.error}); the last one read stays up`);
        // No silent fallback (review2): the screen says this list is an old one, and why it was not refreshed.
        const age = Math.round((sess.cached.ageMs || 0) / 1000);
        ctx.push(S.win, 'taskview.notice', { seq: sess.seq,
          text: `These are the windows from ${age} s ago: the current list could not be read (${sess.cached.fail}). Some may have closed.` });
        return;
      }
      sess.listMs = now() - sess.t0;
      sess.sidecarMs = r.result.ms || null;
      const pl = payloadOf(r.result);
      const d = displayFor(r.result.mon);
      const moved = d.id !== sess.display.id;
      if (moved) {
        sess.display = d;
        sess.park = parkRect(d.bounds);
        try { S.win.setBounds(sess.shown && !test ? d.bounds : sess.park); } catch (_) { /* the page's vw/vh check waits for it */ }
      }
      const key = listKey(pl);
      if (key === sess.drawnKey && !moved) { sess.cached.same = true; return; }
      learn(sess, pl);
      sess.n = pl.list.length;
      sess.drawnKey = key;
      sess.cached.replaced = true;
      ctx.push(S.win, 'taskview.update', Object.assign({ seq: sess.seq }, moved && dark() ? { at: { x: d.bounds.x, y: d.bounds.y } } : {}, pl));
      fillIcons(sess, pl.list).catch((err) => ctx.log(`icons: ${err.message}`));
    }

    /* ---- the warm-up (see SPEED DEBT): never on screen, never the keyboard, read-only ---- */
    function scheduleWarm() {
      if (S.warm && S.warm.timer) clearTimeout(S.warm.timer);
      if (process.env.MANTLE_TASKVIEW_WARMUP === '0') { S.warm = null; return; }
      const env = process.env.MANTLE_TASKVIEW_WARM_MS;           // the unit test's short delay
      const delay = env !== undefined && Number(env) >= 0 ? Number(env) : WARM_DELAY_MS;
      S.warm = { timer: setTimeout(() => { warmUp().catch((err) => { ctx.log(`warm-up threw: ${err.message}`); S.warm = null; }); }, delay) };
      if (S.warm.timer.unref) S.warm.timer.unref();
    }
    async function warmUp() {
      if (!S.warm) return;
      S.warm.timer = null;
      if (S.stopped || !ctx.enabled() || !alive() || !S.ready || S.sess || S.drewOnce) { S.warm = null; return; }
      for (let i = 0; i < 40 && ctx.sidecar.ready === false; i++) await new Promise((r) => setTimeout(r, 250));
      if (!S.warm || S.sess) return;
      const t0 = now();
      const r = await ctx.sidecar.send('taskview.list', {}, { timeoutMs: 3000 });
      if (!S.warm || S.sess || !alive()) return;
      if (!r.ok) { ctx.log(`warm-up skipped: the window list could not be read (${plain(r.error)})`); S.warm = null; return; }
      S.cache = { res: r.result, at: Date.now() };
      const pl = payloadOf(r.result);
      S.warm.t0 = now();
      S.warm.listMs = r1(S.warm.t0 - t0);
      S.warm.desktopsMs = r.result.ms ? r.result.ms.desktops : null;
      S.warm.n = pl.list.length;
      S.warm.timer = setTimeout(() => endWarm('the page did not draw it within 3 s'), 3000);
      ctx.push(S.win, 'taskview.warm', pl);
    }
    function endWarm(why, drawnMs) {
      const w = S.warm;
      if (!w) return;
      S.warm = null;
      if (w.timer) clearTimeout(w.timer);
      if (drawnMs !== undefined) S.drewOnce = true;
      if (w.t0) ctx.log(`warm-up: ${w.n} windows read in ${w.listMs} ms (desktops ${w.desktopsMs}), ` +
        `${drawnMs !== undefined ? `drawn in the parked window in ${drawnMs} ms` : `not drawn: ${why}`}`);
    }
    ctx.command('warmed', async (a) => {
      if (!S.warm || !S.warm.t0) return { ok: true, stale: true };
      endWarm(null, r1(now() - S.warm.t0));
      void a;
      return { ok: true };
    });

    /* R7: one truthful line per open, written only after the on-top check. */
    function openLine(sess, j) {
      if (sess.r7) return;
      sess.r7 = true;
      const k = (t) => (t ? r1(t - sess.t0) : '-');
      const list = sess.cached
        ? `list cached (${Math.round(sess.cached.ageMs / 1000)} s old), fresh ${sess.cached.freshMs === undefined ? 'not back' : `${sess.cached.freshMs} ms`}${sess.cached.replaced ? ', replaced' : sess.cached.same ? ', same' : ''}`
        : `list ${k(sess.t0 + (sess.listMs || 0))} ms`;
      const kbAt = sess.kbAt && sess.kbAt > sess.shownAt ? sess.kbAt : sess.shownAt;
      if (test) {
        ctx.log(`opened (${sess.cold ? 'cold' : 'warm'}) via ${sess.via}: shown - (test: stays hidden), painted ${k(sess.painted && sess.painted.at)}, interactive - ms (${list})`);
        return;
      }
      if (j && j.onTop === true && keyboardNow()) {
        ctx.log(`opened (${sess.cold ? 'cold' : 'warm'}) via ${sess.via}: shown ${k(sess.shownAt)}, painted ${k(sess.painted && sess.painted.at)}, interactive ${k(kbAt)} ms (${list})`);
      } else {
        ctx.log(`open via ${sess.via} NOT verified (${sess.cold ? 'cold' : 'warm'}): placed ${k(sess.shownAt)}, painted ${k(sess.painted && sess.painted.at)} ms; ` +
          `${j && j.onTop === false ? `not on top: ${j.why}` : !j || j.onTop === null ? `on top unchecked: ${(j && j.why) || 'no check'}` : 'no keyboard'} (${list})`);
      }
    }

    async function relist(sess) {
      const r = await ctx.sidecar.send('taskview.list', {}, { timeoutMs: 1500 });
      if (!r.ok) { ctx.log(`relist: ${r.error}`); throw new Error(`the window list could not be read again: ${plain(r.error)}`); }
      const pl = payloadOf(r.result);
      if (sess && S.sess === sess) learn(sess, pl);
      return pl;
    }

    /** The session a page call belongs to, or null (a stale call from an earlier open). */
    function current(a) {
      const sess = S.sess;
      if (!sess || !a || a.seq !== sess.seq) return null;
      return sess;
    }
    function checkHwnd(sess, h) {
      const v = String(h == null ? '' : h);
      if (!HWND_RE.test(v) || !sess.hwnds || !sess.hwnds.has(v)) throw new Error('that window is no longer in Task View');
      return v;
    }
    function checkDesk(sess, d) {
      const v = String(d == null ? '' : d);
      if (!DESK_RE.test(v) || !sess.desks || !sess.desks.has(v)) throw new Error('that desktop no longer exists');
      return v;
    }

    async function fillIcons(sess, list) {
      if (!list.some((it) => !it.icon)) return;
      const r = await ctx.sidecar.send('windows', {}, { timeoutMs: 3000 });
      if (!r.ok || S.sess !== sess) return;
      const icons = {};
      for (const w of Array.isArray(r.result) ? r.result : []) {
        S.icons.set(String(w.hwnd), { icon: w.icon || null, exe: w.exe || '' });
        if (list.some((it) => it.hwnd === String(w.hwnd) && !it.icon)) icons[String(w.hwnd)] = w.icon ? { icon: w.icon } : { icon: null, reason: 'no icon: Windows gave none for this program' };
      }
      if (Object.keys(icons).length) ctx.push(S.win, 'taskview.icons', { seq: sess.seq, icons });
    }

    async function open(via) {
      if (!ctx.enabled() || S.stopped) return;
      if (S.sess) { end('Win+Tab again'); return; }
      if (!alive() || !S.ready) { ctx.log(`Win+Tab (${via}) arrived but the page is not ready`); return; }
      const t0 = now();
      // The blur-behind is applied at sidecar start; if that failed (measured once in --test: the
      // ui lane did not answer "glass" within 3 s at startup), try again, without waiting for it.
      if (!S.glass || !S.glass.ok) applyGlass().catch((err) => ctx.log(`glass: ${err.message}`));
      const sess = { seq: ++S.seq, t0, via, shown: false, painted: null };
      S.sess = sess;
      // The last session still folding shut: this one wins. Its park is dropped (this open parks the
      // window itself, then reveals it); the reveal, or this session's own end, takes the click-through off.
      if (S.fold) { ctx.log(`#${S.fold.sess.seq}: its park after the fold was dropped: session #${sess.seq} started`); S.fold = null; }
      if (!test) {
        // Who had the keyboard (it goes back there on Esc), then take it, while still parked.
        const fg = raiseWin.foreground();
        sess.prevFg = fg && fg.hwnd && !fg.mine ? fg.hwnd : 0;
        sess.kbTake = takeKeyboard(sess, 'before the show');
      }
      sess.cold = !S.drewOnce;
      if (S.warm) endWarm('a real Win+Tab came first');
      // The fresh list, but never more than LIST_WAIT_MS of it when a cached one can be drawn meanwhile.
      const fresh = ctx.sidecar.send('taskview.list', {}, { timeoutMs: 1500 }).then((r) => {
        if (r.ok) S.cache = { res: r.result, at: Date.now() };
        return r;
      });
      let r = null;
      if (S.cache) {
        let timer = null;
        r = await Promise.race([fresh, new Promise((res) => { timer = setTimeout(() => res(null), LIST_WAIT_MS); })]);
        clearTimeout(timer);
      } else r = await fresh;
      if (S.sess !== sess) return;
      let res, why = null;
      if (r) {
        sess.listMs = now() - t0;
        if (!r.ok) ctx.log(`#${sess.seq}: the window list failed: ${r.error}`);
        why = r.ok ? null : plain(r.error);
        res = r.ok ? r.result : { list: [], desktops: { ok: false, reason: why, canWrite: false, writeReason: why, list: [] }, others: [] };
      } else {
        // Not back yet: draw the last list read, and let the fresh one replace it when it lands.
        res = S.cache.res;
        sess.cached = { ageMs: Date.now() - S.cache.at };
        fresh.then((r2) => freshLanded(sess, r2), (err) => ctx.log(`#${sess.seq}: the fresh window list failed: ${err.message}`));
      }
      const d = displayFor(res.mon);
      sess.display = d;
      sess.sidecarMs = r ? res.ms || null : null;
      const p = parkRect(d.bounds);
      // Placed only when it moves: a parked window already at this rect costs nothing to leave.
      let cur = null;
      try { cur = S.win.getBounds(); } catch (_) { /* unknown: place it */ }
      if (!sameRect(cur, p)) { try { S.win.setBounds(p); } catch (_) { /* measured by the page's vw/vh check */ } }
      sess.park = p;
      const pl = payloadOf(res);
      learn(sess, pl);
      sess.n = pl.list.length;
      sess.drawnKey = listKey(pl);
      S.drewOnce = true;
      ctx.push(S.win, 'taskview.open', Object.assign({ seq: sess.seq, glass: S.glass || { ok: false, reason: 'the blur-behind has not been applied yet' },
        selHwnd: pl.list[0] ? pl.list[0].hwnd : null, listReason: why }, dark() ? { at: { x: d.bounds.x, y: d.bounds.y } } : {}, pl));
      fillIcons(sess, pl.list).catch((err) => ctx.log(`icons: ${err.message}`));
      setTimeout(() => {
        if (S.sess === sess && !sess.shown) { ctx.log(`#${sess.seq}: the page had not drawn ${REVEAL_LATE_MS} ms after Win+Tab; showing it anyway`); reveal(sess); }
      }, REVEAL_LATE_MS);
    }

    function originOf() {
      const b = S.win.getContentBounds();
      return screen.dipToScreenPoint({ x: b.x, y: b.y });
    }

    /* THE KEYBOARD FIRST, THEN THE SCREEN (lane mn-raise, 2026-10-12). Live, 23 of 42 sessions logged
     * "shown but NOT on top" and 18 ended "another window took the keyboard": the window came on screen
     * and only THEN asked for the foreground, with Electron's focus(), which Windows refuses a process
     * that got no input - and a hot corner gives Mantle none. Now the PARKED window (visible, off
     * screen) takes the keyboard through raise.keyboard() (in-process when Mantle already holds the
     * foreground, else the sidecar's focus ladder) while the list is read and the page draws; the
     * reveal waits for that, at most KB_WAIT_MS after the page has drawn. Activation also puts it at
     * the top of its band, so it comes on screen already in front and already typing. */
    function takeKeyboard(sess, why) {
      const t = now();
      return raiseWin.keyboard(S.win, { sidecar: ctx.sidecar, hwnd: S.hwnd, timeoutMs: 1500, sidecarPid: ctx.sidecar.pid }).then((k) => {
        if (S.sess === sess) { sess.kb = Object.assign({ ms: r1(now() - t), why }, k); if (k.ok) sess.kbAt = now(); }
        // Ended while the ladder ran (Win+Tab twice, fast): it may have landed on the parked window.
        else if (k.ok && sess.giveBack && keyboardNow()) giveKeyboardBack(sess);
        return k;
      });
    }
    function giveKeyboardBack(sess) {
      ctx.sidecar.send('focus', { hwnd: String(sess.prevFg) }, { timeoutMs: 1500 }).then((f) => {
        if (!f.ok) ctx.log(`#${sess.seq}: the keyboard could not go back to the window that had it (${f.error})`);
      });
    }

    function reveal(sess) {
      if (sess.shown || S.sess !== sess || !alive()) return;
      if (!test && !sess.kb && sess.kbTake && !sess.kbWaited) {
        // The keyboard is still being taken: show when it is, or at KB_WAIT_MS, whichever is first.
        sess.kbWaited = true;
        const go = () => reveal(sess);
        const t = setTimeout(go, KB_WAIT_MS);
        sess.kbTake.then(() => { clearTimeout(t); go(); }, () => { clearTimeout(t); go(); });
        return;
      }
      sess.shown = true;
      sess.shownAt = now();
      if (test) return;                          // never on screen in a test run
      try {
        // Never click-through on screen (the last session's fold shut sets it; its park or this takes it off).
        try { S.win.setIgnoreMouseEvents(false); } catch (_) { /* a window that never had it set */ }
        // Top of the band while still parked, THEN on screen: it never appears under anything.
        S.win.setAlwaysOnTop(true, 'screen-saver');
        S.win.moveTop();
        S.win.setBounds(sess.display.bounds);
        S.win.show();
        // The page unfolds on this (THE UNFOLD, ui/taskview/taskview.js): the window IS on screen now.
        ctx.push(S.win, 'taskview.shown', { seq: sess.seq });
        if (!(sess.kb && sess.kb.ok)) S.win.focus();
      } catch (err) { ctx.log(`#${sess.seq}: could not come on screen: ${err.message}`); }
      // CHECKED, and only a checked window counts as shown (the end line says which): on top by the
      // z-order (a see-through window: WindowFromPoint alone would look through its clear pixels),
      // with the keyboard by Windows' own GetForegroundWindow, not Electron's word.
      raiseWin.check(S.win, { what: `Task View #${sess.seq}`, log: ctx.log, seeThrough: true, wanted: () => S.sess === sess && alive() }).then(async (j) => {
        if (S.sess !== sess || !alive()) return;
        sess.onTop = j;
        if (keyboardNow()) { sess.verified = j.onTop === true; openLine(sess, j); return; }
        // Not typing yet (the ladder lost, or ran out of KB_WAIT_MS): the ladder once more, now it is up.
        const k = await takeKeyboard(sess, 'after the show');
        if (S.sess !== sess || !alive()) return;
        if (k.ok) { sess.verified = j.onTop === true; openLine(sess, j); return; }
        ctx.log(`#${sess.seq}: no keyboard focus (${k.words})`);
        openLine(sess, j);
        ctx.push(S.win, 'taskview.notice', { seq: sess.seq, text: 'Windows kept the keyboard on another window, so typing won\'t reach Task View. Click a window to switch to it, or click an empty spot to close.' });
      });
    }

    /** Does Task View have the keyboard? Windows' answer; Electron's when Windows cannot be read. */
    function keyboardNow() {
      if (!alive()) return false;
      const k = raiseWin.hasKeyboard(S.win);
      return k === null ? S.win.isFocused() : k;
    }

    /* LOSING THE KEYBOARD (lane mn-raise). Task View covers its whole screen at the top of the topmost
     * band, so a window on that screen that takes the keyboard was not clicked by the user: it opened by
     * itself (an app finishing its start, a dialog). Ending the session there made Task View vanish
     * by itself 18 times. Now: such a window -> the keyboard is taken back ONCE; again -> Task View
     * stays open without it and says so (a click still switches or closes). A window on ANOTHER screen
     * (the user clicked there) or another Mantle window (the launcher) still ends it, as before. */
    function onBlur(sess) {
      if (S.sess !== sess || !sess.shown) return;
      setTimeout(() => {
        if (S.sess !== sess || !alive() || keyboardNow()) return;   // focus hopping back already
        const fg = raiseWin.foreground();
        if (fg && fg.mine && fg.hwnd !== S.hwnd) { end('another Mantle window took the keyboard'); return; }
        if (fg && fg.hwnd && fg.rect && !onMyScreen(sess, fg.rect)) { end('a window on another screen took the keyboard'); return; }
        if (!sess.retook) {
          sess.retook = true;
          takeKeyboard(sess, 'taken back').then((k) => {
            if (S.sess !== sess) return;
            ctx.log(`#${sess.seq}: a window that opened by itself took the keyboard ${r1(now() - sess.shownAt)} ms after the show; ` +
              (k.ok ? `took it back (${k.words})` : `could not take it back (${k.words}); staying open`));
            if (!k.ok) stayWithoutKeyboard(sess);
          });
          return;
        }
        ctx.log(`#${sess.seq}: a window that opened by itself took the keyboard again; staying open without it`);
        stayWithoutKeyboard(sess);
      }, BLUR_GRACE_MS);
    }
    function stayWithoutKeyboard(sess) {
      if (sess.toldNoKeyboard) return;
      sess.toldNoKeyboard = true;
      ctx.push(S.win, 'taskview.notice', { seq: sess.seq, text: 'Another window took the keyboard, so typing won\'t reach Task View. Click a window to switch to it, or click an empty spot to close.' });
    }
    function onMyScreen(sess, rect) {
      try {
        const c = screen.screenToDipPoint({ x: (rect.l + rect.r) / 2, y: (rect.t + rect.b) / 2 });
        const b = sess.display.bounds;
        return c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
      } catch (_) { return true; }   // unreadable: treated as on this screen (taken back, not closed)
    }

    /** The keyboard goes back to the window that had it before Task View, but only while Task View
     *  (parked now, invisible) still holds it: never taken from a window the user has moved on to.
     *  opts.giveBack=false: a switch, where the keyboard belongs where the user went. */
    function end(why, opts) {
      const sess = S.sess;
      if (!sess) return;
      S.sess = null;
      sess.giveBack = !test && !(opts && opts.giveBack === false) && !!sess.prevFg;
      const giveBack = sess.giveBack && keyboardNow();
      S.tset.clear(why);                        // FIRST: a picture left registered would sit on screen
      if (alive()) {
        // On screen and the page can answer: it folds shut first (live only; a test window is never shown)
        if (!test && sess.shown && S.ready && !S.stopped) foldThenPark(sess, why);
        else park(sess, why);
      }
      if (giveBack) giveKeyboardBack(sess);     // the keyboard goes back NOW, not after the fold
      const k = (t) => (t ? r1(t - sess.t0) : '-');
      ctx.log(`#${sess.seq} (${sess.via}): ${sess.n || 0} windows; ` +
        (sess.cached ? `list ${sess.cached.freshMs === undefined ? '- (not back)' : sess.cached.freshMs} ms, the cached list drawn first` : `list ${k(sess.t0 + (sess.listMs || 0))} ms`) +
        (sess.sidecarMs ? ` (sidecar windows ${sess.sidecarMs.windows}, desktops ${sess.sidecarMs.desktops})` : '') +
        `, drawn ${sess.painted ? k(sess.painted.at) : 'never'}, first ${sess.batch1 ? sess.batch1.n + ' pictures ' + k(sess.batch1.at) : '-'}` +
        `, ${shownWords(sess, k)}, all pictures ${sess.batch2 ? k(sess.batch2.at) + ' (' + sess.batch2.ok + '/' + sess.batch2.n + ' ok)' : '-'}; ended: ${why}`);
    }

    /* THE FOLD SHUT (wave unfold, 2026-10-23; lane unfold-wire). The page folds shut
     * (window.MantleTaskViewFold, ui/taskview/taskview.js: the iPhone Duo fold, size 'pop') before the
     * window is parked, so a close is seen; it used to be parked at once. The pictures went first
     * (S.tset.clear: DWM draws them over the page, where no fold reaches) and the keyboard goes back at
     * once (end); while it folds the window is click-through. Parked when the page says the fold has
     * landed or at FOLD_CAP_MS, whichever is first (a throw, a reject or no fold on the page: at once,
     * logged), then taskview.end, which empties the page (not earlier: the page snaps shut on it).
     * A NEW SESSION during the fold wins: open() drops the fold, so it never parks a window that session
     * placed or showed (its own open parks and reveals it; the reveal takes the click-through off). */
    function park(sess, why) {
      if (!alive()) return;
      try { S.win.setIgnoreMouseEvents(false); } catch (_) { /* never set, or parked anyway */ }
      try { if (!test) S.win.setBounds(sess.park || parkRect(sess.display.bounds)); } catch (_) { /* parked next time */ }
      ctx.push(S.win, 'taskview.end', { seq: sess.seq, why });
    }
    function foldThenPark(sess, why) {
      const win = S.win;
      const f = { sess, win, timer: null, done: false };
      S.fold = f;
      const finish = (words) => {
        if (f.done) return;
        f.done = true;
        if (f.timer) clearTimeout(f.timer);
        if (S.fold !== f) return;                 // a new session dropped it (or a newer fold owns the window)
        S.fold = null;
        if (words) ctx.log(`#${sess.seq}: parked ${words}`);
        if (S.win !== win || !alive()) return;    // remade or gone meanwhile: nothing of this one to park
        if (S.sess) return;                       // belt and braces: a live session owns the window's place
        park(sess, why);
      };
      try { win.setIgnoreMouseEvents(true); } catch (_) { /* then the folding page takes clicks for 0.4 s at most */ }
      let asked;
      try { asked = win.webContents.executeJavaScript(FOLD_JS, true); }
      catch (err) { finish(`at once: the page could not be asked to fold (${err.message})`); return; }
      f.timer = setTimeout(() => finish(`at the ${FOLD_CAP_MS} ms cap: the fold had not landed`), FOLD_CAP_MS);
      Promise.resolve(asked).then((r) => finish(foldWords(r)), (err) => finish(`at once: the page's fold failed (${(err && err.message) || err})`));
    }
    function foldWords(r) {
      if (!r || typeof r !== 'object') return 'at once: the page has no fold (window.MantleTaskViewFold is missing)';
      if (r.cancelled) return 'with its fold cut short';
      if (r.ok === false) return `without its fold: ${r.reason || 'the page said it could not fold'}`;
      if (r.timedOut) return 'after its fold ran on the page\'s own timer (no frames came)';
      return null;
    }

    /** "shown" only for a CHECKED window: on top and with the keyboard, or what was missing. */
    function shownWords(sess, k) {
      if (test) return `placed ${k(sess.shownAt)} (test: stays hidden)`;
      if (!sess.shownAt) return 'never on screen';
      const kb = sess.kb ? (sess.kb.ok ? `keyboard: ${sess.kb.how}, ${sess.kb.ms} ms ${sess.kb.why}` : `no keyboard (${sess.kb.words})`) : 'keyboard: not asked';
      if (sess.verified) return `shown ${k(sess.shownAt)}, checked on top (${kb})`;
      if (sess.onTop && sess.onTop.onTop === false) return `placed ${k(sess.shownAt)} but NOT on top: ${sess.onTop.why} (${kb})`;
      if (!sess.onTop) return `placed ${k(sess.shownAt)}, ended before the on-top check (${kb})`;
      return `placed ${k(sess.shownAt)}, ${sess.onTop.onTop ? 'on top' : `on top unchecked: ${sess.onTop.why}`} (${kb})`;
    }

    // ---------------------------------------------------------------- page commands
    ctx.command('painted', async (a) => {
      const sess = S.sess;
      if (!sess || !a || a.seq !== sess.seq || !alive()) return { ok: true, stale: true };
      const want = sess.display.bounds;
      if (Math.abs(Number(a.vw) - want.width) > 1.5 || Math.abs(Number(a.vh) - want.height) > 1.5) {
        return { ok: true, waiting: `the page is ${a.vw}x${a.vh}, the window is going to ${want.width}x${want.height}` };
      }
      const boxes = Array.isArray(a.boxes) ? a.boxes : [];
      // The FIRST drawing counts (a cached list replaced by the fresh one draws, and reports, again).
      if (!sess.painted) sess.painted = { at: now() };
      const dpr = Number(a.dpr) || sess.display.scaleFactor || 1;
      const r1st = S.tset.sync(S.hwnd, boxes.slice(0, FIRST_BATCH), dpr, originOf());
      sess.batch1 = { at: now(), n: Math.min(FIRST_BATCH, boxes.length) };
      reveal(sess);
      if (test && sess.shown) openLine(sess, null);
      const finish = () => {
        if (S.sess !== sess || !alive()) return;
        const res = boxes.length > FIRST_BATCH ? S.tset.sync(S.hwnd, boxes, dpr, originOf()) : r1st;
        sess.batch2 = { at: now(), n: boxes.length, ok: (res.thumbs || []).filter((t) => t.ok).length };
        ctx.push(S.win, 'taskview.thumbs', { seq: sess.seq, ok: res.ok, reason: res.reason || null, thumbs: res.thumbs || [] });
      };
      if (boxes.length > FIRST_BATCH) setImmediate(finish); else finish();
      return { ok: true, boxes: boxes.length };
    });

    ctx.command('activate', async (a) => {
      const sess = current(a);
      if (!sess) return { ok: true, stale: true };
      const hwnd = checkHwnd(sess, a.hwnd);
      // While Task View is up this process is the foreground one, and the sidecar is its child,
      // so Windows lets the sidecar hand the foreground on. Then park, so we are not over it.
      const r = await ctx.sidecar.send('taskview.activate', { hwnd, dry: test }, { timeoutMs: 2500 });
      if (!r.ok) throw new Error(plain(r.error));
      if (test) ctx.log(`#${sess.seq}: dry run, would switch to a window: ${JSON.stringify(r.result)}`);
      end(test ? 'switched to a window (dry run)' : `switched to a window (${r.result && r.result.how})`, { giveBack: false });
      return r.result;
    });

    // After a close the list is read again (350 ms) and, if the window is still there, once more
    // later. Still there then = the app is asking something ("save changes?") behind Task View,
    // which is said on screen instead of the tile silently staying.
    const CLOSE_RECHECK_MS = [350, 1600];
    ctx.command('close', async (a) => {
      const sess = current(a);
      if (!sess) return { ok: true, stale: true };
      const hwnd = checkHwnd(sess, a.hwnd);
      if (test) throw new Error('this is a test run, and a test run never closes your windows');
      const r = await ctx.sidecar.send('close', { hwnd }, { timeoutMs: 2500 });
      if (!r.ok) throw new Error(plain(r.error));
      const recheck = (i) => setTimeout(async () => {
        if (S.sess !== sess) return;
        let fresh;
        try { fresh = await relist(sess); } catch (err) { ctx.log(err.message); return; }
        if (S.sess !== sess) return;
        ctx.push(S.win, 'taskview.update', Object.assign({ seq: sess.seq }, fresh));
        const still = fresh.list.find((it) => it.hwnd === hwnd);
        if (!still) return;
        if (i + 1 < CLOSE_RECHECK_MS.length) { recheck(i + 1); return; }
        ctx.push(S.win, 'taskview.notice', { seq: sess.seq, kind: 'info',
          text: `"${still.title || 'That window'}" is still open. It may be asking you something, like whether to save. Switch to it to answer.` });
      }, CLOSE_RECHECK_MS[i] - (i ? CLOSE_RECHECK_MS[i - 1] : 0));
      recheck(0);
      return { ok: true };
    });

    const OPS = { switch: 'desktops.switch', create: 'desktops.create', remove: 'desktops.remove', rename: 'desktops.rename', move: 'desktops.move' };
    ctx.command('desk', async (a) => {
      const sess = current(a);
      if (!sess) return { ok: true, stale: true };
      const op = Object.prototype.hasOwnProperty.call(OPS, a.op) ? a.op : null;
      if (!op) throw new Error('Task View does not know that desktop action');
      const args = { dry: test };
      if (op !== 'create') args.desktop = checkDesk(sess, a.desktop);
      if (op === 'move') args.hwnd = checkHwnd(sess, a.hwnd);
      if (op === 'rename') {
        if (typeof a.name !== 'string') throw new Error('a desktop name has to be text');
        if (a.name.length > 100) throw new Error('a desktop name can be at most 100 characters');
        args.name = a.name;
      }
      const r = await ctx.sidecar.send(OPS[op], args, { timeoutMs: 4000 });
      if (!r.ok) throw new Error(plain(r.error));
      if (test) ctx.log(`dry run, ${op}: ${JSON.stringify(r.result)}`);
      if (op === 'switch' && !test && !(r.result && r.result.already)) { end('switched desktop', { giveBack: false }); return { ended: true }; }
      const fresh = await relist(sess);
      if (op === 'create' && r.result && r.result.id) {
        fresh.created = String(r.result.id);
        if (S.sess === sess && sess.desks) sess.desks.add(fresh.created);
      }
      return fresh;
    });

    ctx.command('dismiss', async (a) => {
      if (S.sess && a && a.seq === S.sess.seq) end(a.why === 'esc' ? 'Esc' : a.why === 'click-away' ? 'clicked away' : String(a.why || 'dismissed'));
      return { ok: true };
    });

    // ---------------------------------------------------------------- wiring
    // Each push is the WHOLE window list, so the map is rebuilt from it: a closed window's icon
    // does not stay behind (it grew forever before, one entry per window ever opened).
    ctx.sidecar.on('windows', (m) => {
      if (!m || !Array.isArray(m.list)) return;
      const next = new Map();
      for (const w of m.list) next.set(String(w.hwnd), { icon: w.icon || null, exe: w.exe || '' });
      S.icons = next;
    });
    ctx.sidecar.onReady(() => { applyGlass().catch((err) => ctx.log(`glass: ${err.message}`)); });
    ctx.onChord('Win+Tab', () => { open('Win+Tab').catch((err) => { ctx.log(`open failed: ${err.message}`); end('open failed'); }); });
    ctx.onEnabled((on) => { if (!on) end('Task View was turned off'); });
    createWindow();

    /* --test only: MANTLE_TASKVIEW_BENCH=<n> opens Task View n times in this never-shown copy and logs
       open -> painted for each (the first is the cold one when MANTLE_TASKVIEW_WARMUP=0). Read-only:
       a test run's window is never shown, never focused, and its sidecar refuses every write. */
    const benchN = test ? Math.min(30, Number(process.env.MANTLE_TASKVIEW_BENCH) || 0) : 0;
    if (benchN > 0) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        for (let i = 0; i < 100 && !S.ready; i++) await wait(100);
        await wait(WARM_DELAY_MS + 2500);
        const out = [];
        for (let i = 0; i < benchN && !S.stopped; i++) {
          await open('bench');
          const sess = S.sess;
          for (let j = 0; j < 50 && sess && S.sess === sess && !sess.painted; j++) await wait(20);
          if (sess) out.push(sess.painted ? r1(sess.painted.at - sess.t0) : null);
          end('bench');
          await wait(400);
        }
        const ok = out.filter((v) => v !== null).sort((a, b) => a - b);
        const q = (p) => (ok.length ? ok[Math.min(ok.length - 1, Math.floor(p * ok.length))] : '-');
        ctx.log(`bench: ${out.length} opens, painted ms ${JSON.stringify(out)}; p50 ${q(0.5)}, p95 ${q(0.95)}, never ${out.length - ok.length}`);
      })().catch((err) => ctx.log(`bench threw: ${err.message}`));
    }

    return {
      stop(why) {
        S.stopped = true;
        if (S.warm && S.warm.timer) clearTimeout(S.warm.timer);
        S.warm = null;
        wall.stop();
        end(why || 'Mantle is putting Windows back');
        S.tset.clear('stop');
        if (S.win && !S.win.isDestroyed()) S.win.destroy();
      },
    };
  },
};

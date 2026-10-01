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

const TITLE = 'Mantle task view';
const GAP = 64;                 // how far off the monitor the parked window waits
const FIRST_BATCH = 8;          // thumbnails registered before the reveal; the rest right after
const REVEAL_LATE_MS = 450;     // a page that has not painted by now is revealed anyway (and logged)

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
      win: null, hwnd: 0, seq: 0, sess: null, ready: false, stopped: false,
      tset: thumbs.set('taskview', 'the Task View window', 'Task View'),
      icons: new Map(),          // hwnd -> { icon, exe } from the sidecar's windows push
      glass: null,
    };

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
      wc.on('did-finish-load', () => { S.ready = true; ctx.health(true); });
      wc.on('render-process-gone', (_e, d) => {
        down(`the Task View page's renderer died (${d && d.reason}); reloading it`);
        setTimeout(() => { if (alive() && !S.stopped) wc.reload(); }, 500);
      });
      wc.on('unresponsive', () => down('the Task View page stopped responding'));
      wc.on('responsive', () => { S.ready = true; ctx.health(true); });
      win.on('blur', () => { if (!test && S.sess && S.sess.shown) end('another window took the keyboard'); });
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
      const r = await ctx.sidecar.send('glass', { hwnd: String(S.hwnd), mode: 'acrylic' }, { timeoutMs: 3000 });
      S.glass = r.ok && r.result && r.result.applied ? { ok: true } : { ok: false, reason: r.ok ? 'Windows did not apply the blur-behind' : r.error };
      if (!S.glass.ok) ctx.log(`no blur: ${S.glass.reason}`);
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
      const r = await ctx.sidecar.send('taskview.list', {}, { timeoutMs: 1500 });
      if (S.sess !== sess) return;
      sess.listMs = now() - t0;
      if (!r.ok) ctx.log(`#${sess.seq}: the window list failed: ${r.error}`);
      const why = r.ok ? null : plain(r.error);
      const res = r.ok ? r.result : { list: [], desktops: { ok: false, reason: why, canWrite: false, writeReason: why, list: [] }, others: [] };
      const d = displayFor(res.mon);
      sess.display = d;
      sess.sidecarMs = res.ms || null;
      const p = parkRect(d.bounds);
      try { S.win.setBounds(p); } catch (_) { /* measured by the page's vw/vh check */ }
      sess.park = p;
      const pl = payloadOf(res);
      learn(sess, pl);
      sess.n = pl.list.length;
      ctx.push(S.win, 'taskview.open', Object.assign({ seq: sess.seq, glass: S.glass || { ok: false, reason: 'the blur-behind has not been applied yet' },
        selHwnd: pl.list[0] ? pl.list[0].hwnd : null, listReason: why }, pl));
      fillIcons(sess, pl.list).catch((err) => ctx.log(`icons: ${err.message}`));
      setTimeout(() => {
        if (S.sess === sess && !sess.shown) { ctx.log(`#${sess.seq}: the page had not drawn ${REVEAL_LATE_MS} ms after Win+Tab; showing it anyway`); reveal(sess); }
      }, REVEAL_LATE_MS);
    }

    function originOf() {
      const b = S.win.getContentBounds();
      return screen.dipToScreenPoint({ x: b.x, y: b.y });
    }

    function reveal(sess) {
      if (sess.shown || S.sess !== sess || !alive()) return;
      sess.shown = true;
      sess.shownAt = now();
      if (test) return;                          // never on screen in a test run
      try {
        S.win.setBounds(sess.display.bounds);
        S.win.show();
        S.win.setAlwaysOnTop(true, 'screen-saver');
        S.win.moveTop();
        S.win.focus();
        // ...and CHECKED (r7-ontop): still covered after one more raise -> one plain log line.
        raiseWin.check(S.win, { what: `Task View #${sess.seq}`, log: ctx.log, wanted: () => S.sess === sess && alive() });
      } catch (err) { ctx.log(`#${sess.seq}: could not come on screen: ${err.message}`); }
      // Typing needs the keyboard. Windows may refuse a background process the foreground; the
      // sidecar (a child of this process) has the Alt+Tab ladder. Said on screen if both fail.
      setTimeout(async () => {
        if (S.sess !== sess || !alive() || S.win.isFocused()) return;
        const a = await ctx.sidecar.send('taskview.activate', { hwnd: String(S.hwnd) }, { timeoutMs: 1500 });
        if (S.sess === sess && alive() && !S.win.isFocused()) {
          ctx.log(`#${sess.seq}: no keyboard focus (${a.ok ? 'asked, not given' : a.error})`);
          ctx.push(S.win, 'taskview.notice', { seq: sess.seq, text: 'Windows kept the keyboard on another window, so typing won\'t reach Task View. Click a window to switch to it, or click an empty spot to close.' });
        }
      }, 60);
    }

    function end(why) {
      const sess = S.sess;
      if (!sess) return;
      S.sess = null;
      S.tset.clear(why);                        // FIRST: a picture left registered would sit on screen
      if (alive()) {
        try { if (!test) S.win.setBounds(sess.park || parkRect(sess.display.bounds)); } catch (_) { /* parked next time */ }
        ctx.push(S.win, 'taskview.end', { seq: sess.seq, why });
      }
      const k = (t) => (t ? r1(t - sess.t0) : '-');
      ctx.log(`#${sess.seq} (${sess.via}): ${sess.n || 0} windows; list ${k(sess.t0 + (sess.listMs || 0))} ms` +
        (sess.sidecarMs ? ` (sidecar windows ${sess.sidecarMs.windows}, desktops ${sess.sidecarMs.desktops})` : '') +
        `, drawn ${sess.painted ? k(sess.painted.at) : 'never'}, first ${sess.batch1 ? sess.batch1.n + ' pictures ' + k(sess.batch1.at) : '-'}` +
        `, shown ${k(sess.shownAt)}${test ? ' (test: stays hidden)' : ''}, all pictures ${sess.batch2 ? k(sess.batch2.at) + ' (' + sess.batch2.ok + '/' + sess.batch2.n + ' ok)' : '-'}; ended: ${why}`);
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
      sess.painted = { at: now() };
      const dpr = Number(a.dpr) || sess.display.scaleFactor || 1;
      const r1st = S.tset.sync(S.hwnd, boxes.slice(0, FIRST_BATCH), dpr, originOf());
      sess.batch1 = { at: now(), n: Math.min(FIRST_BATCH, boxes.length) };
      reveal(sess);
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
      end(test ? 'switched to a window (dry run)' : `switched to a window (${r.result && r.result.how})`);
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
      if (op === 'switch' && !test && !(r.result && r.result.already)) { end('switched desktop'); return { ended: true }; }
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

    return {
      stop(why) {
        S.stopped = true;
        end(why || 'Mantle is putting Windows back');
        S.tset.clear('stop');
        if (S.win && !S.win.isDestroyed()) S.win.destroy();
      },
    };
  },
};

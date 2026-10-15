'use strict';
/*
 * lib/features/toasts.js -- MANTLE'S OWN NOTIFICATION BANNERS (lane mantle-toasts, 2026-10-15).
 *
 * Owen, with a screenshot of Helm's stock Windows toast: "these notifications need to be in mantles
 * theme not the old windows". So when an app posts a toast, Mantle pops up its OWN banner (ui/toasts/,
 * the island glass, light and dark) and Windows' banner is turned off for that app
 * (_toasts-owner.js + sidecar/ToastBanners.cs: the per-app ShowBanner value, originals kept and put
 * back on every exit). The toast itself still lands in Windows' notification centre and Mantle's list.
 *
 * WHERE THE TOASTS COME FROM: lib/notifications.js (the bar's notification centre). The sidecar's watch
 * looks at a 0.06 ms database signature every 400 ms and main reads the list only when it changed, so a
 * banner costs no extra polling at all: this feature listens to that same payload (host.toasts.onList)
 * and diffs ids (_toasts-core.js createPicker). Typical delay from Windows' post to Mantle's banner: the
 * 400 ms poll + one list read (~70-700 ms measured) + the window's first load when none is open.
 *
 * WHERE: top right, under the top bar (the primary display's work area, which the top bar reserves).
 *   - the top bar is always on screen; the bottom bar hides itself, so a banner hung from it would
 *     float over nothing half the time;
 *   - bottom right is already busy: the screenshot card, the volume pop-up and the bar's own pop-ups
 *     (the bell, quick settings) open there, and a banner would cover them or be covered;
 *   - it is where macOS puts them, which Mantle's top bar already follows.
 *
 * RAM (Owen, 2026-10-15: "no i dont want these open in the backround i need to save ram"): there is NO
 * window until a banner shows; it is made on demand and destroyed IDLE_CLOSE_MS after the last banner
 * went. A game rest destroys it too (rest:true).
 *
 * WHEN NOT: the switch is off; Windows would not pop anything up either (_toasts-core.js quietWhy: Do
 * not disturb, a full-screen app or game, presentation mode, the lock screen); Mantle is resting for a
 * game (rest: true). The toast is in the list either way. An app Mantle does not cover (left to Windows,
 * notifications off, Owen's own banner-off) gets no Mantle banner: Windows' rules for it are untouched.
 *
 * A NEW APP: Windows makes an app's settings key on its FIRST toast, so Mantle cannot turn a banner off
 * before then. That first toast is Windows' (no Mantle banner, so no double); Mantle takes the app at
 * once and every later toast is Mantle's.
 *
 * CLICK (_toasts-core.js clickPlan): a link toast opens its link (exactly what Windows does); otherwise
 * the app's window comes to the front if it has one (Windows gives no other app a way to activate the
 * toast itself); otherwise Mantle's notification list opens. The X closes the banner only; the toast
 * stays in the list (Windows' X does the same).
 *
 * NO SILENT FAILURES: no notification access = Windows keeps its own banners (nothing is taken, what
 * was taken is put back) and the feature is unhealthy with the reason (Settings > Notifications shows
 * it with the one button that fixes it); a failed take or put-back is health(false) with the reason.
 */
const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen, app } = require('electron');
const raiseWin = require('../raise');
const { createOwner, leftToWindows } = require('./_toasts-owner');
const C = require('./_toasts-core');

const IDLE_CLOSE_MS = 30000;   // the window goes this long after its last banner (RAM)
const WIN_W = 392;             // DIP: a 360 px card + the page's 16 px margin each side (room for its shadow)
const APPLY_DEBOUNCE_MS = 800; // a burst of first toasts from new apps is one registry pass
const RECORD_FILE = 'notif-banners.json';
const FIX_URI = 'ms-settings:privacy-notifications';
const SAY = {
  noSource: 'This Mantle has no notification list to show banners from.',
  noAccess: 'Windows is not letting Mantle read notifications, so Windows keeps showing its own pop-ups. Allow it in Windows Settings > Privacy > Notifications.',
  notRead: 'Mantle could not read your notifications just now, so Windows keeps showing its own pop-ups.',
};

module.exports = {
  name: 'toasts',
  label: 'Show notifications in Mantle\'s style',
  defaultOn: true,
  chords: [],
  rest: true,
  install(ctx) {
    const test = !!ctx.flags.test;
    const host = ctx.host.toasts;
    const recordFile = path.join(app.getPath('userData'), RECORD_FILE);
    const S = {
      stopped: false, win: null, ready: false, queue: [], idleT: null, applyT: null, applyP: null,
      access: null, accessOk: false, accessWhy: null, lastApply: null, lastRestore: null, quiet: null, quietLogged: null,
      shown: 0, layout: null, madeAt: 0, makes: 0, firstPostAt: 0,
    };

    // ---- the registry and the record, for the owner
    const store = {
      load() {
        let raw;
        try { raw = fs.readFileSync(recordFile, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
        return JSON.parse(raw);
      },
      save(r) {
        const tmp = `${recordFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(r));
        fs.renameSync(tmp, recordFile);
      },
    };
    async function sc(cmd, args, ms) {
      const r = await ctx.sidecar.send(cmd, args, { timeoutMs: ms || 4000 });
      if (!r || !r.ok) throw new Error((r && r.error) || `${cmd} did not answer`);
      return r.result;
    }
    const reg = {
      read: () => sc('toasts.banners', { op: 'read', record: recordFile }),
      write: (set) => sc('toasts.banners', { op: 'write', record: recordFile, set }),
    };
    const owner = createOwner({ reg, store, log: (l) => ctx.log(l), test });
    owner.peek();

    // ---- health: one place decides, from access + the last take / put-back
    function judge() {
      if (S.stopped) return;
      if (!host) return ctx.health(false, SAY.noSource);
      if (!ctx.enabled()) return ctx.health(true);
      if (S.accessWhy) return ctx.health(false, S.accessWhy);
      if (S.lastApply && S.lastApply.ok === false) return ctx.health(false, `Windows' own pop-ups could not be turned off for every app: ${S.lastApply.reason}`);
      return ctx.health(true);
    }
    function accessOf(p) {
      if (!p) return null;
      if (p.access && p.access !== 'Allowed' && p.access !== 'unknown') return SAY.noAccess;
      if (p.ok === false && p.available === false) return SAY.notRead;
      return null;
    }

    // ---- take / put back
    function apply(why, opts) {
      if (S.stopped || !ctx.enabled() || !S.accessOk || S.accessWhy || !ctx.sidecar.ready) return Promise.resolve(null);
      S.applyP = owner.apply(why, opts).then((r) => { S.lastApply = r; judge(); return r; });
      return S.applyP;
    }
    function applySoon(why) {
      clearTimeout(S.applyT);
      S.applyT = setTimeout(() => { S.applyT = null; apply(why); }, APPLY_DEBOUNCE_MS);
    }
    function restore(why, opts) {
      return owner.restore(why, opts).then((r) => { S.lastRestore = r; if (r.ok === false) ctx.log(`put back: ${r.reason}`); return r; });
    }

    // ---- the window: made on demand, gone IDLE_CLOSE_MS after its last banner
    function workArea() {
      try { return screen.getPrimaryDisplay().workArea; } catch (_) { return { x: 0, y: 0, width: 1280, height: 720 }; }
    }
    function place(h) {
      if (!S.win || S.win.isDestroyed()) return;
      const wa = workArea();
      const height = Math.max(1, Math.min(Math.round(h || 1), wa.height));
      S.win.setBounds({ x: Math.round(wa.x + wa.width - WIN_W), y: Math.round(wa.y), width: WIN_W, height });
    }
    function makeWin() {
      const wa = workArea();
      S.ready = false;
      S.madeAt = Date.now();
      S.makes++;
      const w = new BrowserWindow({
        show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false,
        focusable: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        alwaysOnTop: !test, backgroundThrottling: false, title: 'Mantle notifications',
        width: WIN_W, height: 160, x: Math.round(wa.x + wa.width - WIN_W), y: Math.round(wa.y),
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      if (!test) w.setAlwaysOnTop(true, 'screen-saver');
      const wc = w.webContents;
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('render-process-gone', (_e, d) => {
        if (S.win !== w) return;
        ctx.log(`the banner page ${(d && d.reason) || 'went away'}; the banners on it are in the list, and the next one makes a new page`);
        dropWin('its page went away');
      });
      wc.on('did-fail-load', (_e, code, desc, _u, main) => {
        if (S.win !== w || main === false || code === -3) return;
        ctx.log(`the banner page did not load (${desc || code}); the toasts are in the list`);
        dropWin('its page did not load');
      });
      w.on('closed', () => { if (S.win === w) { S.win = null; S.ready = false; } });
      w.loadFile(ctx.page('index.html'));
      S.win = w;
      return w;
    }
    function dropWin(why) {
      clearTimeout(S.idleT); S.idleT = null;
      const w = S.win;
      S.win = null; S.ready = false; S.queue = []; S.layout = null;
      if (w && !w.isDestroyed()) { w.destroy(); ctx.log(`the banner window closed (${why})`); }
    }
    function send(ev, p) { if (S.win && !S.win.isDestroyed() && S.ready) ctx.push(S.win, ev, p); }
    function show(banners) {
      clearTimeout(S.idleT); S.idleT = null;
      if (!S.win || S.win.isDestroyed()) makeWin();
      if (!S.ready) { S.queue.push(...banners); return; }
      send('toasts.show', { banners, ids: null });
    }
    function reveal() {
      const w = S.win;
      if (!w || w.isDestroyed() || test) return;
      if (!w.isVisible()) w.showInactive();
      raiseWin.up(w, { what: 'the notification banners', log: (l) => ctx.log(l), wanted: () => S.win === w && !w.isDestroyed() && w.isVisible() });
    }

    // ---- the list changed
    /** What a payload says about access. Nothing is taken until a list has said "Allowed". */
    function learn(p) {
      if (!p) return;
      const was = S.accessWhy, wasOk = S.accessOk;
      if (p.access) S.access = p.access;
      S.accessWhy = accessOf(p);
      if (p.access === 'Allowed' && p.available !== false) S.accessOk = true;
      else if (S.accessWhy) S.accessOk = false;
      if (S.accessWhy && S.accessWhy !== was) {
        ctx.log(`no banners: ${S.accessWhy}`);
        if (owner.counts().owned) restore('notifications cannot be read', { keepReleased: true });
      } else if (S.accessOk && !wasOk) apply(was ? 'notifications can be read again' : 'notifications can be read');
      if (S.accessWhy !== was) judge();
    }
    async function onList(p) {
      if (S.stopped) return;
      learn(p);
      const fresh = S.picker.next(p, Date.now());
      if (S.win && S.ready) send('toasts.ids', { ids: S.picker.ids() });
      if (!fresh.length || !ctx.enabled() || S.accessWhy) return;
      const mine = [];
      let newApp = false;
      for (const t of fresh) {
        if (owner.owns(t.aumid)) mine.push(t);
        else if (!leftToWindows(t.aumid, test) && !owner.released(t.aumid)) newApp = true;
      }
      if (newApp) applySoon('an app notified for the first time');
      if (!mine.length) return;
      let q = null;
      try { q = await sc('toasts.quiet', {}, 2000); } catch (err) { ctx.log(`quiet check failed (${err.message}); showing the banner anyway`); }
      if (S.stopped || !ctx.enabled()) return;
      const why = C.quietWhy(q);
      S.quiet = why;
      if (why) {
        if (S.quietLogged !== why) { S.quietLogged = why; ctx.log(`no banner while ${why}; ${mine.length} new in the list`); }
        return;
      }
      S.quietLogged = null;
      S.shown += mine.length;
      show(mine.map((t) => C.bannerOf(t, Date.now())));
    }

    // ---- what the page asks
    ctx.command('layout', async (a) => {
      // the page drew its stack: h is the window height it needs, count the banners on it
      const w = S.win;
      if (!w || w.isDestroyed()) return { ok: false, reason: 'no banner window' };
      const count = Math.max(0, Number(a && a.count) || 0);
      S.layout = { h: Number(a && a.h) || 0, count, at: Date.now() };
      if (count > 0) {
        clearTimeout(S.idleT); S.idleT = null;
        place(S.layout.h);
        reveal();
      } else {
        if (!test && w.isVisible()) w.hide();
        clearTimeout(S.idleT);
        S.idleT = setTimeout(() => { S.idleT = null; if (S.win === w) dropWin(`no banner for ${IDLE_CLOSE_MS / 1000} s`); }, IDLE_CLOSE_MS);
      }
      return { ok: true };
    });
    ctx.command('ready', async () => {
      // the page listens: what arrived while it loaded goes up now
      if (!S.win || S.win.isDestroyed()) return { ok: false, reason: 'no banner window' };
      S.ready = true;
      if (S.madeAt) ctx.log(`the banner window was made and loaded in ${Date.now() - S.madeAt} ms`);
      S.madeAt = 0;
      const q = S.queue; S.queue = [];
      if (q.length) send('toasts.show', { banners: q, ids: S.picker.ids() });
      return { ok: true, test };
    });
    ctx.command('click', async (a) => {
      const id = Number(a && a.id);
      const b = a && a.banner;
      if (!Number.isInteger(id) || !b) return { ok: false, reason: 'that banner is not known' };
      const target = b.opens === 'protocol' || !host ? null : host.targetFor(b.aumid);
      const plan = C.clickPlan(b, target);
      if (plan.act === 'link') {
        const r = await host.open(id);
        if (r && r.ok) return { ok: true, act: 'link' };
        ctx.log(`click: the link did not open (${(r && r.reason) || 'no reason'}); opening the list instead`);
        host.openList();
        return { ok: true, act: 'list', reason: r && r.reason };
      }
      if (plan.act === 'window') {
        const r = await host.focus(plan.hwnd);
        if (r && r.ok) return { ok: true, act: 'window' };
        ctx.log(`click: the app's window did not come forward (${(r && r.reason) || 'no reason'}); opening the list instead`);
      }
      host.openList();
      return { ok: true, act: 'list' };
    });
    ctx.command('more', async () => { if (host) host.openList(); return { ok: true, act: 'list' }; });
    ctx.command('state', async () => {
      const c = owner.counts();
      return {
        ok: true, on: ctx.enabled(), access: S.access, accessOk: !S.accessWhy, accessWhy: S.accessWhy, fixUri: FIX_URI,
        covered: c.owned, released: c.released, recordWhy: c.recordWhy, quiet: S.quiet,
        reason: S.accessWhy || (S.lastApply && S.lastApply.ok === false ? S.lastApply.reason : null) || c.recordWhy || null,
      };
    });
    if (test) {
      // the e2e's window into main: the banner window's own process, for the RAM it costs
      ctx.command('debug', async () => {
        const w = S.win;
        const pid = w && !w.isDestroyed() ? w.webContents.getOSProcessId() : 0;
        const m = pid ? app.getAppMetrics().find((x) => x.pid === pid) : null;
        return { ok: true, win: !!(w && !w.isDestroyed()), ready: S.ready, pid, makes: S.makes, shown: S.shown,
          layout: S.layout, idleCloseMs: IDLE_CLOSE_MS, memory: m ? m.memory : null, visible: !!(w && !w.isDestroyed() && w.isVisible()), bounds: w && !w.isDestroyed() ? w.getBounds() : null };
      });
      ctx.command('apply', async () => apply('the test asked'));
    }

    // ---- start
    S.picker = C.createPicker();
    let offList = null;
    if (host) {
      const last = host.last ? host.last() : null;
      if (last) { S.picker.next(last, Date.now()); learn(last); }
      offList = host.onList((p) => { onList(p).catch((err) => ctx.log(`banner failed: ${err.message}`)); });
    }
    ctx.onEnabled((on) => {
      if (on) { S.picker.reset(); if (host && host.last && host.last()) S.picker.next(host.last(), Date.now()); apply('switched on', { fresh: true }); }
      else { dropWin('switched off'); restore('switched off'); }
      judge();
    });
    ctx.sidecar.onReady(() => {
      if (ctx.enabled()) apply('the sidecar started');
      else if (owner.counts().owned) restore('the switch is off');   // a run that died with it on
    });
    judge();

    return {
      stop(why, how) {
        S.stopped = true;
        clearTimeout(S.applyT); S.applyT = null;
        if (offList) offList();
        dropWin(how && how.rest ? 'Mantle is resting for a game' : 'Mantle stopped');
        // a game rest keeps Windows' banners off: the toasts wait in the list, as Owen asked
        if (how && how.rest) return undefined;
        return (S.applyP || Promise.resolve()).catch(() => {}).then(() => restore(why || 'Mantle stopped', { keepReleased: true }));
      },
    };
  },
};

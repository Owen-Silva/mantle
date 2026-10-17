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
 * and diffs ids (_toasts-core.js createPicker). Delay from Windows' post to Mantle's banner, IN SERIES:
 * the sidecar's poll wait (0-400 ms, PollMs), its listener read (1 toast 33-193 ms, median 67; 21 toasts
 * 233-765 ms), main's list + toasts.quiet calls (a few ms), and, with no window open, the window's make
 * and load (live log, 64 banners to 2026-10-16: median 206 ms, p75 317, 73-810). About 270 ms median with
 * a window up, about 480 ms without (measured BEFORE lane mantle-toastfast). Under 300 ms needs the
 * SIDECAR: night/toastfast does it (PollMs 100, and an early "toast coming" event that starts the window
 * while the listener read runs: PREWARM_MS). Main alone has nothing to overlap: the window is made on demand
 * (RAM, below) and the page is 42 KB that calls ready at once, so the 206 ms is Electron's renderer start.
 *
 * WHERE (lane mantle-toasts3, Owen 2026-10-15: "i want it to still show up in the bottom right"): bottom
 * right of the bar's monitor's work area, like Windows' own, newest nearest the corner and older ones
 * stacking upward. Above an open bar pop-up there, and above the screenshot card while it is up
 * (lib/corner.js, its real bounds). _toasts-core.js bannerSpot.
 * IN THE CORNER (lane mantle-corner, Owen 2026-10-16: "this ... needs to go in the corner not up like
 * this ... just have them smoothly move up if the taskbar comes up"): with the bar hidden they sit at the
 * corner itself; when the bar comes in they GLIDE up above it on the bar's own spring, started on the
 * same tick as the bar's page (host.bar.onMotion), and back down with the bar's own exit when it goes.
 * The glide is a transform in the page (the window never moves for the bar); the window's shape covers
 * the whole glide while it runs and narrows to the stack after (_toasts-core.js cornerSpots / spanTo).
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
 * SOUND (lane mantle-corner2, from code and docs, NOT by ear): Mantle plays no sound and touches no sound
 * setting; only the per-app ShowBanner is written. Windows keeps "Play a sound when a notification
 * arrives" as its own per-app switch beside the banner one (it is greyed out only when the app's
 * notifications are off altogether), and no app here has a sound value set, so each app's is at the
 * default, on. So the toast's sound is Windows' to play with the banner off, exactly as it was. No
 * Microsoft page says so in as many words, so it is unconfirmed until heard once.
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
const barShape = require('../bar-shape');
const corner = require('../corner');
const { createOwner, leftToWindows } = require('./_toasts-owner');
const C = require('./_toasts-core');

const IDLE_CLOSE_MS = 30000;   // the window goes this long after its last banner (RAM)
const WIN_W = 392;             // DIP: a 360 px card + the page's 16 px margin each side
const TOP_ROOM = 8;            // DIP: the column's top stays this far under the work area's top
/* The window's own surface: see-through, no Windows shadow, no Mica/acrylic. The dark SQUARE Owen saw
   round the first banners (2026-10-15) was NOT these: it was the card's dark --lg-shadow (black .34 +
   .42, 64 px blur) cut at the window's edge 16 px out, the bug 241c70e fixed on 14 other pop-ups. The
   card now ends on its hairline in dark (ui/toasts/toasts.css), and these stay pinned by the tests. */
const WIN_LOOK = Object.freeze({ transparent: true, backgroundColor: '#00000000', hasShadow: false, thickFrame: false });   // the screenshot card's (baseWindow)
const APPLY_DEBOUNCE_MS = 800; // a burst of first toasts from new apps is one registry pass
/* THE GLIDE's clock (lane mantle-corner). Up: the bar's own reveal (main's REVEAL_MS, the page's spring).
   Down: what the bar's page really runs for its exit, max(140, min(main's ms, 240)) (ui/bar/bar.js
   slide: OUT_MAX), on the bar's accelerate. A pop-up or the screen moving the target: --m-dur-xs. The
   shape narrows SETTLE_PAD_MS after the glide's end, never before. */
const GLIDE_IN_MS = 560, GLIDE_OUT_MAX = 240, GLIDE_OUT_MIN = 140, GLIDE_POP_MS = 240, SETTLE_PAD_MS = 60;
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
      spot: null, bounds: null, shape: null, shapeOk: null, shapeWhy: null, shapeChecked: false, hiddenWhy: null, offCorner: null,
      // the glide (lane mantle-corner): is the bar up, where the stack is aimed, the shape's span, the run
      barUp: barIsUp(), span: null, glide: null, settleT: null, offBar: null, glides: 0, testIds: [],
    };
    /** The bar's state as main knows it. No hook (an old host): treat it as always up, the old place. */
    function barIsUp() {
      const b = ctx.host && ctx.host.bar;
      if (!b || typeof b.up !== 'function') return true;
      try { return !!b.up(); } catch (_) { return true; }
    }

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
    /* WHERE (C.bannerSpot): a column at the bottom right of the bar's monitor, its bottom above the bar's
       resting shape (and any open bar pop-up) when that reaches the corner, and above the screenshot card
       (lib/corner.js) when it is up. The window is the whole column and never changes size while the
       banners come and go: the page stacks them at its bottom and main SHAPES the window to the stack
       (lib/bar-shape.js, the bar's own way: outside the shape nothing is drawn and clicks pass through).
       Resizing a bottom-anchored transparent window is what made the bar dip (339e911): DWM shows the old
       frame pinned to the new top-left. If the first shape does not stick (read back from Windows), the
       window is sized to the stack instead, bottom-anchored, and the log says why. */
    function display() {
      const bar = ctx.host && typeof ctx.host.barRect === 'function' ? ctx.host.barRect() : null;
      let d = null;
      try { d = bar && typeof screen.getDisplayMatching === 'function' ? screen.getDisplayMatching(bar) : screen.getPrimaryDisplay(); } catch (_) { d = null; }
      return { work: (d && d.workArea) || { x: 0, y: 0, width: 1280, height: 720 }, sf: (d && d.scaleFactor) || 1, bar };
    }
    /** The window's spot (the column as if the bar were not there) plus `lift`: how far up the stack
        rests right now (the bar up and reaching the corner), and hide/why for that resting place. */
    function spot() {
      const d = display();
      const c = C.cornerSpots({ work: d.work, bar: d.bar, others: corner.list(), w: WIN_W, top: TOP_ROOM, barUp: S.barUp });
      return Object.assign({}, c.low, { lift: c.lift, reach: c.reach, hide: c.hide, why: c.why, under: c.under, sf: d.sf });
    }
    function hwndOf(w) {
      try { const b = w.getNativeWindowHandle(); return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0)); } catch (_) { return '0'; }
    }
    function setBoundsOnce(b) {
      const was = S.bounds;
      if (was && was.x === b.x && was.y === b.y && was.width === b.width && was.height === b.height) return;
      S.bounds = b;
      S.win.setBounds(b);
    }
    /** The first shape on a window is read back: a column without its shape would be glass eating clicks. */
    function checkShape(w, rect, sf) {
      if (S.shapeChecked) return S.shapeOk;
      S.shapeChecked = true;
      const r = barShape.verify(hwndOf(w), rect, sf);
      S.shapeOk = !!r.ok;
      S.shapeWhy = r.ok ? null : r.reason;
      if (!r.ok) {
        ctx.log(`the banner window's shape did not stick (${r.reason}); it is sized to the banners instead`);
        barShape.apply(w, null);
        S.shape = null;
      }
      return S.shapeOk;
    }
    /** Put the window where the spot is, shaped (or sized) to the stack's height h. false = not on screen now. */
    function place() {
      const w = S.win;
      if (!w || w.isDestroyed()) return false;
      const sp = spot();
      S.spot = sp;
      if (sp.hide) {
        if (S.hiddenWhy !== sp.why) ctx.log(`banners held back: ${sp.why}; they come back when there is room`);
        S.hiddenWhy = sp.why;
        if (!test && w.isVisible()) w.hide();
        return false;
      }
      if (S.hiddenWhy) { ctx.log('banners back: there is room above the corner again'); S.hiddenWhy = null; }
      const h = Math.max(1, Math.min(Math.round((S.layout && S.layout.h) || 1), sp.height - sp.lift));
      if (!S.span) S.span = C.spanSettle({ to: sp.lift });   // the first place: stand where the stack rests
      if (S.shapeOk !== false) {
        // the column keeps its full height and MOVES for the card (a move is not a re-layout: no stale
        // frame), its bottom at the spot's. It does NOT move for the bar: the page lifts the stack and
        // the shape is the stack wherever it is, or every place it passes while it glides (C.rectFor)
        const bottom = sp.y + sp.height;
        setBoundsOnce({ x: sp.x, y: bottom - sp.full, width: WIN_W, height: sp.full });
        const rect = C.rectFor(S.span, h, sp.full, WIN_W);
        const r = barShape.apply(w, rect);
        if (!r.ok) {
          ctx.log(`the banner window could not be shaped (${r.reason}); it is sized to the banners instead`);
          S.shapeOk = false; S.shapeWhy = r.reason; S.shape = null;
        } else {
          S.shape = rect;
          if (checkShape(w, rect, sp.sf) !== false) return true;
        }
      }
      // no shape: the window is the stack, so it cannot glide inside itself; it goes straight to where
      // the stack rests (the page's lift is 0 on this road, see aim)
      setBoundsOnce({ x: sp.x, y: sp.y + sp.height - sp.lift - h, width: WIN_W, height: h });
      return true;
    }
    /** Aim the stack at `to` DIP up. With banners on screen it glides (kind 'up' = the bar's spring,
        'down' = the bar's exit) and the shape spans the glide until SETTLE_PAD_MS after it; with none,
        it simply stands there for the next one. false = it was already there. */
    function aim(to, kind, ms) {
      const from = S.span ? S.span.to : to;
      if (S.span && to === from) return false;   // already there, or already gliding there
      const moving = !!(S.ready && S.layout && S.layout.count > 0 && ms > 0 && S.shapeOk !== false && !S.hiddenWhy);   // held back = nothing to see glide
      S.span = moving ? C.spanTo(S.span, to) : C.spanSettle({ to });
      clearTimeout(S.settleT); S.settleT = null;
      S.glide = moving ? { kind, from, to, ms, at: Date.now() } : null;
      S.last = ms > 0 ? { kind, from, to, ms, at: Date.now() } : null;   // the motion, seen or not (catchUp)
      if (moving) {
        S.glides++;
        S.settleT = setTimeout(() => { S.settleT = null; S.glide = null; S.span = C.spanSettle(S.span); place(); }, ms + SETTLE_PAD_MS);
      }
      send('toasts.lift', { px: S.shapeOk === false ? 0 : to, kind, ms: moving ? ms : 0 });
      return true;
    }
    /** A banner coming on screen while the bar is still GOING (no banner was up to glide): it starts where
        the bar's top was and goes down with it over what is left of the exit, so it never lands on the
        pill on its way out. Coming up needs nothing: the stack already stands above where the bar lands.
        Called AFTER toasts.show, so the page has the card when the glide starts. true = it caught up. */
    function catchUp() {
      const g = S.last;
      if (!g || g.kind !== 'down' || S.shapeOk === false || S.glide || (S.layout && S.layout.count > 0)) return false;
      const left = Math.round(g.at + g.ms - Date.now());
      if (left <= 20 || g.from <= g.to) return false;
      send('toasts.lift', { px: g.from, kind: 'down', ms: 0 });
      send('toasts.lift', { px: g.to, kind: 'down', ms: left });
      S.span = C.spanTo(C.spanSettle({ to: g.from }), g.to);
      S.glide = { kind: 'down', from: g.from, to: g.to, ms: left, at: Date.now(), caughtUp: true };
      S.glides++;
      clearTimeout(S.settleT);
      S.settleT = setTimeout(() => { S.settleT = null; S.glide = null; S.span = C.spanSettle(S.span); place(); }, left + SETTLE_PAD_MS);
      return true;
    }
    /** The bar started coming in (up) or going (down), on the tick its page was told: go with it. */
    function onBarMotion(m) {
      if (S.stopped || !m) return;
      S.barUp = !!m.up;
      const ms = S.barUp ? (Number(m.ms) > 0 ? Number(m.ms) : GLIDE_IN_MS)
        : Math.max(GLIDE_OUT_MIN, Math.min(Number(m.ms) > 0 ? Number(m.ms) : GLIDE_OUT_MAX, GLIDE_OUT_MAX));
      replace(S.barUp ? 'the bar came up' : 'the bar went down', S.barUp ? 'up' : 'down', ms);
    }
    /** The corner changed (the screenshot card, a bar pop-up, the screen): the banners on screen follow. */
    function replace(why, kind, ms) {
      if (!S.win || S.win.isDestroyed()) return;
      const was = S.spot;
      const up = !!(S.layout && S.layout.count);
      // the stack's resting place first (the bar's glide, or a pop-up / the screen moving it: --m-dur-xs),
      // so the shape place() sets already spans the glide
      const to = spot().lift;
      const from = S.span ? S.span.to : to;
      aim(to, kind || (to > from ? 'up' : 'down'), kind ? ms : GLIDE_POP_MS);
      // with no banner up the (hidden) window still follows, so the next one comes up in the right place
      if (place() && up) {
        if (!kind && (!was || was.y !== S.spot.y || was.height !== S.spot.height || was.hide)) ctx.log(`banners moved: ${why}`);
        if (!S.win.isVisible()) reveal();
      }
    }
    function makeWin() {
      const sp = spot();
      S.ready = false;
      S.madeAt = Date.now();
      S.makes++;
      S.bounds = { x: sp.x, y: sp.y + sp.height - sp.full, width: WIN_W, height: sp.full };
      S.shape = null; S.shapeChecked = false; S.spot = sp;
      const w = new BrowserWindow(Object.assign({
        show: false, frame: false, skipTaskbar: true,
        focusable: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        alwaysOnTop: !test, backgroundThrottling: false, title: 'Mantle notifications',
        width: WIN_W, height: S.bounds.height, x: S.bounds.x, y: S.bounds.y,
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      }, WIN_LOOK));
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
      S.win = null; S.ready = false; S.queue = []; S.layout = null; S.bounds = null; S.shape = null; S.spot = null; S.hiddenWhy = null;
      clearTimeout(S.settleT); S.settleT = null; S.span = null; S.glide = null; S.last = null;   // a new window stands where the stack rests
      if (w && !w.isDestroyed()) { w.destroy(); ctx.log(`the banner window closed (${why})`); }
    }
    /** Every toast still in the list, plus (a --test run only) the test's own banners (testShow), so a
        list read never takes those down. */
    function idsNow() { return test && S.testIds.length ? S.picker.ids().concat(S.testIds) : S.picker.ids(); }
    function send(ev, p) { if (S.win && !S.win.isDestroyed() && S.ready) ctx.push(S.win, ev, p); }
    function show(banners) {
      clearTimeout(S.idleT); S.idleT = null;
      if (!S.win || S.win.isDestroyed()) makeWin();
      if (!S.ready) { S.queue.push(...banners); return; }
      send('toasts.show', { banners, ids: null });
      catchUp();
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
      if (S.win && S.ready) send('toasts.ids', { ids: idsNow() });
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
        if (place()) reveal();
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
      // where the stack rests, before any banner: mid-way through the bar going down it starts where the
      // bar was and goes down with it (never under the bar's pill); otherwise it simply stands there
      if (q.length) send('toasts.show', { banners: q, ids: idsNow() });
      if (!(q.length && catchUp())) send('toasts.lift', { px: S.shapeOk === false ? 0 : (S.span ? S.span.to : spot().lift), kind: 'up', ms: 0 });
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
        const live = !!(w && !w.isDestroyed());
        return { ok: true, win: live, ready: S.ready, pid, makes: S.makes, shown: S.shown,
          layout: S.layout, idleCloseMs: IDLE_CLOSE_MS, memory: m ? m.memory : null, visible: !!(live && w.isVisible()), bounds: live ? w.getBounds() : null,
          // the window's look as made, and what Windows holds: its region (the shape) and its background
          look: WIN_LOOK, background: live && w.getBackgroundColor ? w.getBackgroundColor() : null,
          shape: S.shape, shapeOk: S.shapeOk, shapeWhy: S.shapeWhy, region: live ? barShape.readBack(hwndOf(w)) : null,
          spot: S.spot, work: display().work, corner: corner.list(), hiddenWhy: S.hiddenWhy,
          barUp: S.barUp, span: S.span, glide: S.glide, last: S.last, glides: S.glides };
      });
      ctx.command('apply', async () => apply('the test asked'));
      // lane mantle-corner: a banner with NO Windows toast behind it (the mock bridge), for the corner trace:
      // nothing is posted to, read from or removed from Windows' notification centre
      ctx.command('testShow', async (a) => {
        const n = Math.max(1, Math.min(4, Number(a && a.n) || 1));
        const banners = [];
        for (let i = 0; i < n; i++) {
          const id = 990000 + S.testIds.length + 1;
          S.testIds.push(id);
          banners.push({ id, aumid: 'Mantle.ToastTest.corner', app: 'Mantle test', icon: null, logo: null, title: (a && a.title) || `Corner trace ${id}`, body: 'A test banner: no Windows toast behind it.', attribution: null, image: null, sticky: true, opens: 'list' });
        }
        show(banners);
        return { ok: true, ids: banners.map((b) => b.id) };
      });
      // ...and the window shown THROUGH lib/test-quiet.js (alpha 0, click-through, never activates), so its page
      // runs real frames for the trace; reveal() keeps a --test window hidden otherwise
      ctx.command('testReveal', async () => {
        if (!S.win || S.win.isDestroyed()) return { ok: false, reason: 'no banner window' };
        if (!S.win.isVisible()) S.win.showInactive();
        return { ok: true, visible: S.win.isVisible(), opacity: S.win.getOpacity ? S.win.getOpacity() : null };
      });
      // something else in the corner (the screenshot card's stand-in), so the e2e can see banners move up
      ctx.command('corner', async (a) => { corner.set('a test card', a && a.rect ? a.rect : null); return { ok: true, corner: corner.list() }; });
    }

    // ---- start
    S.picker = C.createPicker();
    let offList = null;
    if (host) {
      const last = host.last ? host.last() : null;
      if (last) { S.picker.next(last, Date.now()); learn(last); }
      offList = host.onList((p) => { onList(p).catch((err) => ctx.log(`banner failed: ${err.message}`)); });
    }
    // the corner changed (the screenshot card, a bar pop-up) or the screen did: the banners follow
    S.offCorner = corner.onChange((why) => replace(why));
    // the bar coming in or going: the banners go with it, started on the same tick (lane mantle-corner)
    if (ctx.host && ctx.host.bar && typeof ctx.host.bar.onMotion === 'function') S.offBar = ctx.host.bar.onMotion(onBarMotion);
    const onScreen = () => replace('the screen changed');
    if (typeof screen.on === 'function') { screen.on('display-metrics-changed', onScreen); screen.on('display-added', onScreen); screen.on('display-removed', onScreen); }
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
        if (S.offCorner) { S.offCorner(); S.offCorner = null; }
        if (typeof S.offBar === 'function') { S.offBar(); S.offBar = null; }
        if (typeof screen.removeListener === 'function') ['display-metrics-changed', 'display-added', 'display-removed'].forEach((e) => screen.removeListener(e, onScreen));
        dropWin(how && how.rest ? 'Mantle is resting for a game' : 'Mantle stopped');
        // a game rest keeps Windows' banners off: the toasts wait in the list, as Owen asked
        if (how && how.rest) return undefined;
        return (S.applyP || Promise.resolve()).catch(() => {}).then(() => restore(why || 'Mantle stopped', { keepReleased: true }));
      },
    };
  },
};

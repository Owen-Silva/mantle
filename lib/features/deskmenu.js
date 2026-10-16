'use strict';
/*
 * deskmenu.js -- Mantle's menu on a right-click on the empty desktop (lane mantle-deskmenu, 2026-10-15,
 * plan P6; Owen: "Yes, Mantle's menu", and Shift+right-click keeps Windows' own).
 *
 * THE CLICK is the sidecar's (sidecar/DeskClick.cs says why a hook, and why not the other two routes).
 * It sends 'deskmenu' events: down (a right-click on the empty desktop began), open (it ended: show the
 * menu at x,y, physical px) and fallback (Mantle did not answer in time, or said it could not: the
 * click went to Windows' own menu). It wants deskmenu.ack within 1 s of 'open', or it gives the click
 * back to Windows; deskmenu.nack gives it back at once, with the reason.
 *
 * THE MENU WINDOW. Owen's RAM rule: no new window kept hidden for good. The DESKTOP PAGE opens the menu
 * itself (window.open('about:blank', 'mantle-deskmenu')), so it lives in the desktop layer's renderer,
 * which always runs: no new renderer process, and the page draws the rows straight into it
 * (ui/desktop/deskmenu.js). It is made on the right-button DOWN (so the up finds it ready), shown
 * without taking the keyboard (focusable:false, like the bar's pop-ups: Alt+F4 and Delete still go
 * where they went), closed by a click outside or Esc (lib/popwatch.js), walked with Up/Down/Home/End
 * and picked with Enter (popwatch's MENU KEYS: the sidecar hands the bare keys over only while this
 * menu is the newest pop-up, so the app in front never sees them), and destroyed KEEP_MS after it
 * was last used. The desktop page may open THAT window and no other (openVerdict; main.js's guard
 * still refuses every other window.open, with the same words).
 *
 * BUDGET (plan R2): right-click -> menu painted, p95 <= 50 ms, timed from the 'open' event reaching
 * main to the menu window's second frame. One log line per open (plan R7).
 *
 * Off in the tray, stopped for a game (rest: true) or "Put Windows back": the hook is taken out, and a
 * right-click on the desktop is Windows' again. A --test copy arms only against a stand-in desktop
 * (MANTLE_DESKMENU_TEST_CLASS), never Owen's.
 */
const { screen, BrowserWindow } = require('electron');
const popwatch = require('../popwatch');

const NAME = 'mantle-deskmenu';
const KEEP_MS = 60000;
const STAND_DOWN_RETRY_MS = 30000;
const DESKTOP_PAGE_RE = /\/ui\/desktop\/index\.html(?:[?#].*)?$/;

/**
 * PURE: the menu window's bounds. pt = the click (DIP); size = {w, h} of the window; inset = the clear
 * margin around the panel (its shadow), so the PANEL's corner sits on the cursor; area = the work area of
 * the display under the click, or null for a point on no display (a test's stand-in desktop off every
 * monitor: placed as asked). Windows' rule: right of and below the cursor, flipped left / up when it
 * would leave the area, and never outside it.
 */
function place(pt, size, inset, area) {
  const i = Number.isFinite(inset) ? inset : 0;
  const w = Math.ceil(size.w), h = Math.ceil(size.h);
  let x = pt.x - i, y = pt.y - i;
  if (area) {
    if (x + w > area.x + area.width) x = pt.x - w + i;
    if (y + h > area.y + area.height) y = pt.y - h + i;
    x = Math.min(Math.max(area.x, x), area.x + area.width - w);
    y = Math.min(Math.max(area.y, y), area.y + area.height - h);
  }
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

/** PURE: may the desktop page open this window? Only the menu: about:blank under its own name. */
function openVerdict(d) {
  const url = (d && typeof d.url === 'string') ? d.url : '';
  if (d && d.frameName === NAME && (url === 'about:blank' || url === '')) return { ok: true, why: null };
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(url) || [])[1];
  return { ok: false, why: `a Mantle page asked to open a new window (${scheme ? `${scheme.toLowerCase()}:` : 'no address'}); Mantle pages open none` };
}

/** The menu window: no frame, no taskbar button, never takes the keyboard, over every app. */
function popupOptions() {
  return {
    show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true,
    hasShadow: false, thickFrame: false, width: 264, height: 260, x: -32000, y: -32000,
    backgroundColor: '#00000000', title: 'Mantle desktop menu',
  };
}

/** PURE: the p-th percentile (0..1) of numbers, or null for none. */
function pct(list, p) {
  const a = list.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(a.length * p) - 1))];
}

const inRect = (r, pt) => !!r && !!pt && pt.x >= r.x && pt.x < r.x + r.width && pt.y >= r.y && pt.y < r.y + r.height;
const now = () => performance.now();

module.exports = {
  name: 'deskmenu',
  label: 'Desktop right-click menu (Shift+right-click: Windows\' own)',
  defaultOn: true,
  rest: true,                       // the hook (every mouse event waits on it) is out while a game runs
  place, openVerdict, popupOptions, pct, NAME, KEEP_MS,

  install(ctx) {
    const test = !!ctx.flags.test;
    const testClass = test ? (process.env.MANTLE_DESKMENU_TEST_CLASS || null) : null;
    let stopped = false;
    let popup = null;               // the menu window (the desktop page opened it)
    let popupOf = null;             // the desktop page's webContents that did
    let showing = null;             // {seq, t0, shown, warm, bounds}
    let keepTimer = null;
    let standTimer = null;
    const pending = new Map();      // seq -> {t0, pt, area, warm}
    const wired = new WeakSet();
    const opens = [];               // the last 50 opens: {shown, painted, warm}

    const say = (line) => ctx.log(`desktop menu: ${line}`);

    function desktopWin() {
      return BrowserWindow.getAllWindows().find((w) => {
        try { return !w.isDestroyed() && DESKTOP_PAGE_RE.test(w.webContents.getURL().replace(/\\/g, '/')); } catch (_) { return false; }
      }) || null;
    }

    /** Lets the desktop page open the menu window (and nothing else), once per page. */
    function wire(dw) {
      const wc = dw.webContents;
      if (wired.has(wc)) return;
      wired.add(wc);
      wc.setWindowOpenHandler((d) => {
        const v = openVerdict(d);
        if (!v.ok) { process.stderr.write(`mantle: ${v.why}\n`); return { action: 'deny' }; }
        return { action: 'allow', overrideBrowserWindowOptions: popupOptions() };
      });
      wc.on('did-create-window', (w, details) => {
        if (!details || details.frameName !== NAME) return;
        if (popup && !popup.isDestroyed() && popup !== w) { try { popup.destroy(); } catch (_) { /* gone */ } }
        popup = w;
        popupOf = wc;
        try { w.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) { /* the option set it */ }
        // A window.open child does not take focusable:false from overrideBrowserWindowOptions (the e2e
        // read isFocusable() === true): say it again, so a click on the menu never takes the keyboard.
        try { w.setFocusable(false); } catch (_) { /* the option may have set it */ }
        // BUDGET: a hidden window's renderer is marked hidden and its first frames after showInactive
        // wait on Chromium waking it (warm opens measured 131 / 189 / 307 ms against a 42 ms median).
        // Not throttled, it stays ready while hidden; it draws only on change and lives KEEP_MS at most.
        try { w.webContents.setBackgroundThrottling(false); } catch (_) { /* older Electron: throttled */ }
        w.on('closed', () => {
          if (popup !== w) return;
          popup = null; popupOf = null;
          if (showing) { showing = null; popwatch.close('deskmenu'); }
        });
      });
    }

    function popupLive(dw) { return !!(popup && !popup.isDestroyed() && dw && popupOf === dw.webContents); }

    function ack(seq) {
      ctx.sidecar.send('deskmenu.ack', { seq }, { timeoutMs: 1500 }).then((r) => {
        if (r.ok && r.result && r.result.acked === false && showing && showing.seq === seq) {
          hide('the helper had already given this right-click to Windows');
        }
      });
    }
    function nack(seq, why) {
      pending.delete(seq);
      say(`could not open (${why}); the right-click goes to Windows' menu`);
      ctx.sidecar.send('deskmenu.nack', { seq, why }, { timeoutMs: 1500 });
    }

    function hide(why) {
      popwatch.close('deskmenu');
      if (popup && !popup.isDestroyed() && popup.isVisible()) { try { popup.hide(); } catch (_) { /* gone */ } }
      if (showing) say(`closed (${why})`);
      showing = null;
      clearTimeout(keepTimer);
      keepTimer = setTimeout(() => {
        if (popup && !popup.isDestroyed() && !showing) {
          try { popup.destroy(); } catch (_) { /* gone */ }
          say(`its window was closed after ${KEEP_MS / 1000} s unused (nothing is kept hidden for good)`);
        }
      }, KEEP_MS);
      if (keepTimer.unref) keepTimer.unref();
    }

    /** 'down': make the menu window now, so the up finds it ready. */
    function onDown(ev) {
      const dw = desktopWin();
      if (!dw) return;
      wire(dw);
      if (!popupLive(dw)) ctx.push(dw, 'deskmenu.prepare', { seq: ev.seq });
    }

    /** 'open': the right-click ended; the page draws the rows and calls deskmenu.place with their size. */
    function onOpen(ev) {
      const t0 = now();
      const dw = desktopWin();
      if (!dw) return nack(ev.seq, 'the desktop layer is not there');
      wire(dw);
      let dip, area = null;
      try {
        dip = screen.screenToDipPoint({ x: ev.x, y: ev.y });
        const disp = screen.getDisplayNearestPoint(dip);
        if (disp && inRect(disp.bounds, dip)) area = disp.workArea;
      } catch (err) { return nack(ev.seq, `the click's place on screen could not be read (${err.message})`); }
      if (showing) hide('another right-click on the desktop');
      pending.set(ev.seq, { t0, pt: dip, area, warm: popupLive(dw) });
      while (pending.size > 8) pending.delete(pending.keys().next().value);
      if (!ctx.push(dw, 'deskmenu.show', { seq: ev.seq })) nack(ev.seq, 'the desktop page could not be told');
    }

    function onFallback(ev) {
      pending.delete(ev.seq);
      if (showing && showing.seq === ev.seq) hide('the helper gave this right-click to Windows');
      say(`${ev.why}; ${ev.replayed ? 'Windows\' own menu opened instead' : 'the click was not given back to Windows'}`);
      if (ev.standDown) {
        ctx.health(false, ev.standWhy || 'right-clicks on the desktop go to Windows for now');
        clearTimeout(standTimer);
        standTimer = setTimeout(() => arm('trying again after standing down'), STAND_DOWN_RETRY_MS);
        if (standTimer.unref) standTimer.unref();
      }
    }

    async function arm(why) {
      if (stopped) return;
      if (!ctx.enabled()) {
        await ctx.sidecar.send('deskmenu.arm', { on: false });
        ctx.health(true, 'switched off: a right-click on the desktop gives Windows\' menu');
        return;
      }
      if (test && !testClass) { ctx.health(true, 'a test copy leaves the desktop\'s right-click to Windows'); return; }
      const r = await ctx.sidecar.send('deskmenu.arm', Object.assign({ on: true }, testClass ? { testClass } : {}));
      if (stopped) return;
      if (!r.ok) { ctx.health(false, `a right-click on the desktop gives Windows' menu: ${r.error}`); say(`not armed (${why}): ${r.error}`); return; }
      ctx.health(true, 'a right-click on the empty desktop opens Mantle\'s menu; Shift+right-click opens Windows\'');
      say(`armed (${why})${testClass ? ` on the stand-in desktop ${testClass}` : ''}`);
    }

    // The page measured the menu: put it at the click, show it without the keyboard, ack the helper.
    ctx.command('place', async (a) => {
      const seq = Number(a.seq);
      const w = Number(a.w), h = Number(a.h), inset = Number(a.inset) || 0;
      const p = pending.get(seq) || (showing && showing.seq === seq ? { t0: showing.t0, pt: showing.pt, area: showing.area, warm: showing.warm, again: true } : null);
      if (!p) return { ok: false, reason: 'that right-click is no longer waiting for its menu' };
      if (a.error || !(w > 0 && h > 0)) { nack(seq, a.error || 'the menu had no size'); return { ok: false, reason: a.error || 'the menu had no size' }; }
      const dw = desktopWin();
      if (!popupLive(dw)) { nack(seq, 'the menu window was not made'); return { ok: false, reason: 'the menu window was not made' }; }
      pending.delete(seq);
      const b = place(p.pt, { w, h }, inset, p.area);
      try {
        popup.setBounds(b);
        if (!popup.isVisible()) popup.showInactive();
        popup.moveTop();
      } catch (err) { nack(seq, `the menu window could not be shown (${err.message})`); return { ok: false, reason: err.message }; }
      clearTimeout(keepTimer);
      if (p.again) { showing.bounds = b; return { ok: true, bounds: b }; }
      showing = { seq, t0: p.t0, pt: p.pt, area: p.area, warm: p.warm, shown: now() - p.t0, bounds: b };
      popwatch.open('deskmenu', {
        contains: (pt) => !!showing && inRect(showing.bounds, pt),
        outside: () => hide('a click outside it'),
        esc: () => hide('Esc'),
        // MENU KEYS: Up/Down/Home/End move the highlight, Enter picks (the page draws and runs them).
        keys: (key) => {
          const d = desktopWin();
          if (!showing || !d || !ctx.push(d, 'deskmenu.key', { seq: showing.seq, key })) say(`the ${key} key could not reach the menu`);
        },
      });
      ack(seq);
      return { ok: true, bounds: b };
    });

    ctx.command('painted', async (a) => {
      const seq = Number(a.seq);
      if (!showing || showing.seq !== seq || showing.painted) return { ok: false, reason: 'that menu is not the one showing' };
      showing.painted = now() - showing.t0;
      opens.push({ shown: showing.shown, painted: showing.painted, warm: showing.warm });
      if (opens.length > 50) opens.shift();
      say(`opened (${showing.warm ? 'warm' : 'cold'}) via right-click: shown ${showing.shown.toFixed(1)}, painted ${showing.painted.toFixed(1)}, interactive ${showing.painted.toFixed(1)} ms`);
      return { ok: true, painted: showing.painted };
    });

    // A row ran (the page runs Mantle's own commands): log it; a failure keeps the menu up with the reason.
    ctx.command('picked', async (a) => {
      const id = String(a.id || '?').slice(0, 30);
      if (a.ok) { say(`${id}: done`); hide(`${id} picked`); } else say(`${id} did not work: ${String(a.reason || 'no reason was given').slice(0, 200)}`);
      return { ok: true };
    });
    ctx.command('hide', async (a) => { hide(String((a && a.why) || 'the page asked').slice(0, 80)); return { ok: true }; });
    ctx.command('status', async () => {
      const sc = await ctx.sidecar.send('deskmenu.status');
      const painted = opens.map((o) => o.painted);
      return {
        ok: true, enabled: ctx.enabled(), testClass, showing: !!showing, popup: !!(popup && !popup.isDestroyed()),
        opens: opens.length, paintedP50: pct(painted, 0.5), paintedP95: pct(painted, 0.95),
        shownP95: pct(opens.map((o) => o.shown), 0.95), last: opens.slice(-12), sidecar: sc.ok ? sc.result : { error: sc.error },
      };
    });
    if (test) {
      // TEST ONLY: one right-click through the helper's real decision (no input is made); see DeskClick.cs.
      ctx.command('testclick', async (a) => {
        const r = await ctx.sidecar.send('deskmenu.testclick', a);
        return r.ok ? r.result : { ok: false, reason: r.error };
      });
    }

    ctx.sidecar.on('deskmenu', (ev) => {
      if (stopped || !ev) return;
      if (ev.op === 'down') onDown(ev);
      else if (ev.op === 'open') onOpen(ev);
      else if (ev.op === 'fallback') onFallback(ev);
    });
    ctx.sidecar.onReady(() => { arm('the helper started'); });
    ctx.onEnabled((on) => { arm(on ? 'switched on' : 'switched off'); });

    return {
      stop() {
        stopped = true;
        clearTimeout(keepTimer); clearTimeout(standTimer);
        popwatch.close('deskmenu');
        if (popup && !popup.isDestroyed()) { try { popup.destroy(); } catch (_) { /* gone */ } }
        popup = null; popupOf = null; showing = null; pending.clear();
        ctx.sidecar.send('deskmenu.arm', { on: false });
      },
    };
  },
};

'use strict';
/* osd.js - Mantle's volume pop-up, the volume keys behind it, and the Android-style per-app volume
 * panel (osd lane, wave 3, 2026-09-24). The page is ui/osd/ (osd.js + osd-model.js); the sidecar half
 * is sidecar/Osd.cs; the level comes from the sidecar's CoreAudio watch (VolumeWatch.cs, ev 'volume').
 *
 * THE VOLUME KEYS ARE MANTLE'S. Windows' own volume/brightness flyout host could not be found on
 * Windows 11 25H2 or 26H2 (26200/26300.9550, sidecar/Osd.cs), so it cannot be hidden, and a pop-up on top of it
 * would be a second one. So this feature CLAIMS VolumeUp / VolumeDown / VolumeMute as chords: while
 * it is on and healthy the keyboard hook swallows them (Windows never sees the key, so shows
 * nothing), and each press is done here the way Windows does it (osd.volume: 2 per press, snapped,
 * unmutes; Mute toggles; a held Up/Down repeats) with Mantle's pop-up shown at once. Off in the tray,
 * or not healthy (the sidecar cannot step the volume, the page crashed, a handler threw): the seam
 * gives the keys straight back to Windows, whose own flyout then works as before.
 *
 * BRIGHTNESS (osd3, 2026-09-24). The laptop's brightness keys are firmware hotkeys (no key reaches the
 * hook), so they cannot be taken. Instead the sidecar watches for Windows' own brightness pop-up (an
 * explorer XamlExplorerHostIslandWindow, found by a live probe) and moves it off screen the moment it
 * shows WITH a brightness change (osd.bright, sidecar/Osd.cs OsdBright). Its push {ev:'osd',
 * kind:'brightness'} carries flyout: 'hidden' (moved and VERIFIED off screen: Mantle's pop-up shows
 * the level exactly like volume), 'dry' (--test: nothing moved, the page still draws it hidden),
 * 'none' (a change with no Windows pop-up - the slider, adaptive brightness - so Mantle shows none
 * either) or 'failed' (Windows' could not be hidden: Mantle shows NOTHING, never two pop-ups, and the
 * reason goes in this feature's note). Inside a burst explorer puts its pop-up back on most steps
 * (live 2026-09-25: 7 moves + 4 re-shows in 16 changes, each answered in a few ms); the sidecar
 * answers every one, with no cap, and gives up a burst only when answering stops working (on screen
 * >30 ms after it appeared, or >50 ms within any 250 ms: Osd.cs OsdBright.Judge). 3 failed bursts in
 * a row stop it until the watch restarts; a burst that ends hidden resets the count. The end-of-burst
 * log line carries moves, re-shows, answers, the worst on-screen span and, if it gave up, why.
 * A brightness failure never calls health(false): that would
 * hand the VOLUME keys back to Windows too. Off in the tray / stop(): the watch stops and every
 * window it moved is put back (and the sidecar puts them back at its next start after a crash).
 *
 * --test: a volume key is a DRY RUN. osd.volume {dry:true} runs the same arithmetic without writing
 * (from the real level, then from the pretend one, so a held key visibly climbs in the log), and
 * the log says what it WOULD have set. Owen's volume is never changed by a test.
 *
 * THE WINDOW: pre-created, parked, transparent, frameless, non-activating (focusable:false - it
 * takes clicks but never the keyboard), always on top; sized to what the page reports (osd.size)
 * and placed bottom-centre just above the bar (ui/osd/osd-model.js place). In --test it is never
 * put in front of Owen: it stays hidden and the page still runs, which the self-test logs prove.
 *
 * ON TOP EVERY TIME IT SHOWS (r7-mixer, 2026-10-01). Owen right-clicked the speaker again and again
 * and saw nothing, while the log said "opened". A read-only watch of the live desktop found the
 * hidden pop-up at z 22, BELOW three maximised app windows, though it still carried WS_EX_TOPMOST:
 * Windows had let it sink (the top bar, task view, snap and switcher windows sat down there too, and
 * only the bar, raised on every reveal, was above the apps). showInactive() never changes the
 * z-order, so the pop-up came back exactly there: shown, on screen, and covered. Each show now puts
 * it on top the way the other pop-ups do (setAlwaysOnTop + moveTop), and an app-volumes open is
 * CHECKED where Owen looks before the log says it was seen (seen() below).
 */
const M = require('../../ui/osd/osd-model.js');
const popwatch = require('../popwatch');   // Esc closes the app-volumes panel from any app (lane mn-pop)

const KEYS = ['VolumeUp', 'VolumeDown', 'VolumeMute'];
const OP = { VolumeUp: 'up', VolumeDown: 'down', VolumeMute: 'mute' };
const MARGIN = 18;            // ui/osd/osd.css --m: the transparent margin round the surface
const BACKSTOP_MS = 60000;    // hidden even if the page never says it faded
const MAX_WAITING = 6;        // presses queued behind a slow sidecar before more are dropped
const REPROBE_MS = 30000;     // while unhealthy: try again (the keys are Windows' meanwhile)
const SETTLE_MS = 300;        // after a key step lands, the watch's late readings wait this long (a held key repeats every ~33 ms)
const SEEN_MS = 120;          // an app-volumes open is checked on screen this long after it was asked (the page has drawn it)
const NOTE = 'volume keys show Mantle’s pop-up (Mantle takes the key, so Windows shows none)';

module.exports = {
  name: 'osd',
  label: 'Volume and brightness pop-up',
  defaultOn: true,
  rest: true,                         // its window(s) close while a game runs (lib/features.js restAll)
  chords: KEYS,
  observe: [],
  install(ctx) {
    const { BrowserWindow, screen } = require('electron');
    let win = null;
    let shown = false;
    let size = { w: 288 + 2 * MARGIN, h: 46 + 2 * MARGIN };
    let vol = null;            // {ok, level 0-100, muted, reason}: the real volume, from the watch
    let dryVol = null;         // --test only: the pretend volume the dry runs step
    let backstop = null;
    let reprobe = null;
    let stopped = false;
    let lastSkip = '';
    let healthy = true;
    let chain = Promise.resolve();
    let waiting = 0;
    let presses = 0;
    let seq = 0;               // each show's number; the page echoes it in osd.faded (see 'faded')
    let settleUntil = 0;       // a key burst's watch readings wait until this (see the 'volume' watch below)
    let settleT = null;
    let lateWatch = null;      // the newest watch reading held back during a burst

    function create() {
      win = new BrowserWindow({
        show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false,
        focusable: false, resizable: false, movable: false, minimizable: false, maximizable: false,
        alwaysOnTop: true, backgroundThrottling: false, width: size.w, height: size.h, x: -32000, y: -32000,
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      const wc = win.webContents;
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('render-process-gone', (_e, d) => setHealth(false, `the pop-up page crashed (${d && d.reason}), so the volume keys went back to Windows`));
      wc.on('unresponsive', () => setHealth(false, 'the pop-up page stopped responding, so the volume keys went back to Windows'));
      wc.on('did-fail-load', (_e, code, desc) => setHealth(false, `the pop-up page did not load (${desc || code}), so the volume keys went back to Windows`));
      win.loadFile(ctx.page('index.html'));
    }

    // ---- brightness: Windows' pop-up moved off screen, Mantle's shown (sidecar osd.bright)
    const bright = { watching: false, reason: 'the watch has not started yet', failed: null, level: null, sessions: 0, last: null };
    let shownKind = null;
    function note() {
      const b = bright.failed ? `Brightness keys: Windows’ own pop-up, because ${bright.failed}`
        : !bright.watching ? `Brightness keys: Windows’ own pop-up, because ${bright.reason}`
          : ctx.flags.test ? 'Brightness keys: watched; in --test Windows’ pop-up is never moved (dry run)'
            : 'Brightness keys: Windows’ pop-up is moved off screen as it appears and Mantle’s shows instead';
      return `${NOTE}. ${b}`;
    }
    function refreshNote() { if (healthy && !stopped) ctx.health(true, note()); }

    // A PC whose screen has no brightness Windows can report (a desktop, an external monitor only)
    // has no brightness keys to replace: say THAT, not WMI's "ManagementException: Not supported".
    function brightWhy(r) {
      if (!r) return r;
      if (/WMI: .*(not supported|invalid class|invalid namespace|not found)/i.test(r))
        return 'this screen has no brightness control Windows reports (a desktop monitor, for example), so there is no brightness pop-up to replace';
      return r;
    }

    async function brightWatch(on) {
      if (stopped && on) return;
      const r = await ctx.sidecar.send('osd.bright', { op: 'watch', on: !!on }, { timeoutMs: on ? 8000 : 2000 });
      if (!r.ok) {
        const e = String(r.error || 'no reason given');
        bright.watching = false;
        bright.reason = /unknown command/i.test(e) ? 'this sidecar exe predates osd.bright (run npm run build:sidecar)' : `the watch could not start (${e})`;
      } else {
        const x = r.result || {};
        bright.watching = x.watching === true;
        bright.reason = brightWhy(x.reason) || (on ? 'the watch did not say why it is off' : 'switched off');
        bright.failed = x.disabled || null;
        if (x.restored) ctx.log(`brightness: put ${x.restored} Windows pop-up window(s) back on screen`);
      }
      ctx.log(`brightness keys: ${!on ? 'watch off, Windows’ own pop-up is back'
        : bright.watching ? (ctx.flags.test ? 'watching Windows’ pop-up (--test: a dry run, never moved)' : 'Windows’ pop-up is moved off screen as it shows, and Mantle’s shows instead')
          : `Windows’ own pop-up (${bright.reason})`}`);
      refreshNote();
    }

    async function onBright(ev) {
      if (stopped) return;
      if (ev.phase === 'end') {
        bright.sessions++; bright.last = ev.summary || ev.flyout;
        if (ev.flyout !== 'none') ctx.log(`brightness pop-up: ${ev.summary || ev.flyout}`);
        return;
      }
      if (typeof ev.level === 'number') bright.level = ev.level;
      if (ev.flyout === 'failed') {
        bright.failed = ev.reason || 'Windows’ pop-up could not be moved off screen';
        if (shown && shownKind === 'brightness') hide('Windows’ brightness pop-up could not be hidden');
        skip(`brightness: ${bright.failed}; Mantle shows nothing (never two pop-ups)`);
        refreshNote();
        return;
      }
      if (ev.flyout !== 'hidden' && ev.flyout !== 'dry') return;   // 'none': Windows showed none, so Mantle shows none
      if (bright.failed) { bright.failed = null; refreshNote(); }
      if (ev.flyout === 'dry') ctx.log(`dry run (--test): Windows’ brightness pop-up would have been moved off screen${ev.simulated ? ' (simulated)' : ''}; Mantle’s shows ${ev.level}%`);
      if (!ctx.enabled()) return;
      const state = typeof ev.level === 'number' ? { ok: true, level: ev.level, present: true, reason: null }
        : { ok: false, level: null, reason: 'Windows reported a brightness change without a level' };
      const q = await ctx.sidecar.send('osd.qs', {}, { timeoutMs: 150 });
      if (q.ok && q.result && q.result.qsOpen === true) { skip('brightness: the quick-settings panel is open and shows the level'); return; }
      lastSkip = '';
      show('brightness', state, { via: 'brightness' });
    }

    function setHealth(ok, reason) {
      healthy = !!ok;
      ctx.health(ok, ok ? note() : reason);
      clearTimeout(reprobe);
      if (!ok && !stopped) reprobe = setTimeout(probe, REPROBE_MS);
    }

    function position() {
      if (!win || win.isDestroyed()) return null;
      const d = ctx.host.display();
      const bar = ctx.host.barRect();
      const p = M.place(bar, d.workArea, size, 0, d.bounds);   // the margin IS the gap: the pill sits 18 px above the bar
      const want = { x: p.x, y: p.y, width: p.width, height: p.height };
      win.setBounds(want);
      // Mixed DPI: a move onto a display with another scale factor can have its size rescaled on
      // the way (clipped pill, or a band of margin); a second set lands exactly, already on that display.
      const got = win.getBounds();
      if (got.width !== want.width || got.height !== want.height) win.setBounds(want);
      return p;
    }

    function show(kind, state, opts) {
      opts = opts || {};
      if (stopped || !ctx.enabled() || !win || win.isDestroyed()) return { ok: false, reason: stopped ? 'the pop-up is stopped' : !ctx.enabled() ? 'the pop-up is switched off in the tray' : 'the pop-up window is gone' };
      const p = position();
      shownKind = kind;
      ctx.push(win, 'osd.show', { kind, state, expand: !!opts.expand, below: !!(p && p.below), via: opts.via || 'unknown', seq: ++seq });
      if (!shown) {
        shown = true;
        // --test: never in front of Owen. The page runs hidden; its osd.size reply proves it drew.
        if (!ctx.flags.test) win.showInactive();
      }
      // EVERY show, every kind (volume, brightness, the panel), first or not: a pop-up already up can
      // have been sunk since (Owen, 2026-10-01: "all that type of stuff should always be opened on top
      // of everything"). Two in-process SetWindowPos calls; a held key repeats every ~33 ms, which is nothing.
      if (!ctx.flags.test) raise();
      clearTimeout(backstop);
      backstop = setTimeout(() => hide('backstop: the page never said it faded'), BACKSTOP_MS);
      return { ok: true, shown: !ctx.flags.test, test: !!ctx.flags.test, reason: null };
    }

    // WS_EX_TOPMOST alone is no promise of being in front (see the header): put it at the top of the
    // topmost windows, as the bar's reveal and the switcher, snap and screenshot windows do.
    function raise() {
      if (!win || win.isDestroyed()) return 'the pop-up window is gone';
      try { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); return null; } catch (err) { return err.message; }
    }

    // A new level for the pop-up that is already up: drawn, and put on top again with it (it may have
    // been sunk while it showed).
    function pushLevel(state) {
      if (!win || win.isDestroyed()) return;
      ctx.push(win, 'osd.level', { kind: 'volume', state });
      if (!ctx.flags.test) raise();
    }

    function hwndOf(w) {
      const buf = w.getNativeWindowHandle();
      return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
    }

    // SEEN, NOT ASKED. Checked where Owen looks, a moment after the open: the window visible, on the
    // display, not see-through, the page showing the panel, and the pop-up itself what a click at its
    // centre would hit (the sidecar's `raise`: topmost again, then WindowFromPoint, as the bar is
    // checked). Covered once: raised and checked again. -> { seen: true | false | null, why }; null =
    // it could not be checked (the sidecar did not answer), which is said, never counted as seen.
    async function seen() {
      await new Promise((r) => setTimeout(r, SEEN_MS));
      if (stopped || !win || win.isDestroyed()) return { seen: false, why: 'the pop-up window closed before it could be checked' };
      if (!shown) return { seen: false, why: 'it was closed again before it could be checked' };
      if (!win.isVisible()) return { seen: false, why: 'Windows did not show the pop-up window' };
      if (typeof win.getOpacity === 'function' && !(win.getOpacity() > 0)) return { seen: false, why: 'the pop-up window is fully see-through' };
      const b = win.getBounds(), d = ctx.host.display() || {}, on = d.bounds || d.workArea;
      if (on && !(b.x < on.x + on.width && b.x + b.width > on.x && b.y < on.y + on.height && b.y + b.height > on.y))
        return { seen: false, why: `the pop-up window is off the screen (at ${b.x},${b.y})` };
      let page = null;
      try {   // a hung page answers nothing: the check goes on without it rather than hold the bar's click
        page = await Promise.race([win.webContents.executeJavaScript('window.__osd ? window.__osd.state() : null'),
          new Promise((r) => setTimeout(() => r(null), 500))]);
      } catch (_) { page = null; }
      if (page && (!page.shown || !page.open)) return { seen: false, why: 'the pop-up page did not draw the app list' };
      let hwnd;
      try { hwnd = hwndOf(win); } catch (err) { return { seen: null, why: `its window handle could not be read (${err.message})` }; }
      for (let i = 0; i < 2; i++) {
        const r = await ctx.sidecar.send('raise', { hwnd }, { timeoutMs: 1500 });
        if (!r.ok) return { seen: null, why: `Mantle could not check it (${String(r.error || 'no reason given')})` };
        const x = r.result || {};
        if (x.onTop === true) return { seen: true, why: i ? 'on top after a second raise' : 'on top' };
        if (stopped || !shown || !win || win.isDestroyed()) return { seen: false, why: 'it was closed again while it was checked' };
        if (i === 0) { raise(); continue; }
        const o = x.over || {};
        const who = o.pid === process.pid ? 'another Mantle window' : o.cls ? 'another window' : null;
        return { seen: false, why: who ? `${who} stayed in front of it` : 'Windows found nothing of it at its own centre' };
      }
      return { seen: null, why: 'it could not be checked' };
    }

    function hide(why) {
      clearTimeout(backstop);
      popwatch.close('osd');
      if (!shown) return;
      shown = false;
      if (win && !win.isDestroyed()) {
        if (why) ctx.push(win, 'osd.hide', { why });
        win.hide();
        win.setBounds({ x: -32000, y: -32000, width: size.w, height: size.h });
      }
    }

    function skip(why) {
      if (why !== lastSkip) ctx.log(`no pop-up: ${why}`);   // once per reason, not once per key repeat
      lastSkip = why;
    }

    const current = () => (ctx.flags.test && dryVol ? Object.assign({ ok: true, reason: null }, dryVol) : vol) ||
      { ok: false, reason: 'the volume has not been read yet' };

    // ---- one press: the sidecar steps the volume (a dry run in --test), in press order
    async function doStep(key) {
      const dry = !!ctx.flags.test;
      const args = { op: OP[key] };
      if (dry) { args.dry = true; if (dryVol) args.from = dryVol; }
      const r = await ctx.sidecar.send('osd.volume', args, { timeoutMs: 1500 });
      if (!r.ok) {
        const e = String(r.error || 'no reason given');
        // No playback device: Windows' key would do nothing either. Say so on the pop-up; keep the key.
        if (/no default playback device/i.test(e)) return { ok: false, level: null, muted: false, reason: `the volume key did nothing: ${e}` };
        setHealth(false, `Mantle could not step the volume (${e}), so the volume keys went back to Windows`);
        return { ok: false, level: vol && vol.level, muted: !!(vol && vol.muted), reason: `the volume key failed: ${e}. The keys are Windows’ again` };
      }
      const x = r.result || {};
      const state = { ok: true, level: x.level, muted: !!x.muted, reason: null };
      settleUntil = Date.now() + SETTLE_MS;
      if (dry) {
        dryVol = { level: x.level, muted: !!x.muted };
        const f = x.from || {};
        ctx.log(`dry run (--test): ${key} would set the volume ${f.level}${f.muted ? ' (muted)' : ''} -> ${x.level}${x.muted ? ' (muted)' : ''}; Owen’s volume was not touched`);
      } else {
        vol = state;
      }
      return state;
    }

    function step(key) {
      if (waiting >= MAX_WAITING) {
        skip(`${key}: ${waiting} presses are already waiting on the sidecar, so this one was dropped`);
        return Promise.resolve(null);
      }
      waiting++;
      const p = chain.then(() => doStep(key)).then((s) => { waiting--; return s; }, (err) => { waiting--; throw err; });
      chain = p.catch(() => {});
      return p;
    }

    async function onVolumeKey(key) {
      if (!ctx.enabled() || stopped) return;
      presses++;
      const done = step(key);
      // The pop-up shows at once with the last level, and moves to the new one when the step lands.
      const q = await ctx.sidecar.send('osd.qs', {}, { timeoutMs: 150 });
      const qsOpen = q.ok && q.result && q.result.qsOpen === true;
      if (qsOpen) skip(`${key}: the quick-settings panel is open and shows the level`);
      else { lastSkip = ''; show('volume', current(), { via: key }); }
      const s = await done;
      if (!s || stopped) return;
      if (!s.ok || !qsOpen) {
        if (!shown) show('volume', s, { via: key });
        else pushLevel(s);
      }
    }

    // ---- can Mantle step the volume at all: a dry step changes nothing, and proves the command
    async function probe() {
      if (stopped) return;
      const r = await ctx.sidecar.send('osd.volume', { op: 'up', dry: true }, { timeoutMs: 3000 });
      if (r.ok) { setHealth(true); ctx.log(`volume keys: Mantle's while on (a dry step answered in ${r.result && r.result.ms} ms)`); return; }
      const e = String(r.error || 'no reason given');
      if (/no default playback device/i.test(e)) { setHealth(true); ctx.log(`volume keys: Mantle's, but there is no playback device right now (${e})`); return; }
      if (/unknown command/i.test(e)) setHealth(false, `this sidecar exe predates osd.volume, so Mantle cannot step the volume and the volume keys stay Windows’ (run npm run build:sidecar)`);
      else setHealth(false, `Mantle could not step the volume (${e}), so the volume keys stay Windows’`);
      ctx.log(`volume keys stay Windows': ${e}`);
    }

    create();
    ctx.health(true, note());
    // A DISPLAY CHANGE while the pop-up is up (resolution, scale, a monitor plugged or pulled): put it
    // back inside the display it belongs on now. Hidden, the next show places it anyway.
    const onDisplay = () => { if (!stopped && shown) { position(); if (!ctx.flags.test) raise(); } };
    const DISPLAY_EVENTS = ['display-metrics-changed', 'display-added', 'display-removed'];
    if (screen && typeof screen.on === 'function') DISPLAY_EVENTS.forEach((e) => screen.on(e, onDisplay));
    KEYS.forEach((k) => ctx.onChord(k, onVolumeKey));
    // THE WATCH vs A HELD KEY (capture-osd 2026-09-29). The watch reports each level a beat behind
    // the steps, so mid-burst it pushed an OLDER level and the number jumped back, then forward.
    // While steps are queued, and SETTLE_MS after the last one lands, the steps' own answers draw the
    // pop-up; the newest watch reading is kept and drawn once the burst settles (it has the last word:
    // another app or a device switch still shows). Outside a burst it is drawn at once, as before.
    function watchState(ev) {
      return ev.ok === false ? { ok: false, level: null, muted: false, reason: ev.reason || 'the volume watch failed without a reason' }
        : { ok: true, level: ev.level, muted: !!ev.muted, reason: null };
    }
    function drawWatch(s) {
      vol = s;
      if (!stopped && shown && !(ctx.flags.test && dryVol)) pushLevel(vol);
    }
    function settleLater() {
      clearTimeout(settleT);
      settleT = setTimeout(() => {
        settleT = null;
        if (stopped) return;
        if (waiting > 0 || Date.now() < settleUntil) { settleLater(); return; }
        const s = lateWatch; lateWatch = null;
        if (s && !(vol && s.ok === vol.ok && s.level === vol.level && s.muted === vol.muted)) drawWatch(s);
      }, Math.max(20, settleUntil - Date.now()));
    }
    ctx.sidecar.on('volume', (ev) => {
      if (stopped) return;
      const s = watchState(ev);
      if (waiting > 0 || Date.now() < settleUntil) { lateWatch = s; settleLater(); return; }
      drawWatch(s);
    });
    ctx.sidecar.onReady(async () => {
      const v = await ctx.sidecar.send('volume', {}, { timeoutMs: 3000 });
      if (v.ok && v.result && typeof v.result.level === 'number' && !vol) vol = { ok: true, level: v.result.level, muted: !!v.result.muted, reason: null };
      await probe();
      await brightWatch(ctx.enabled());
    });
    ctx.sidecar.on('osd', (ev) => { if (ev.kind === 'brightness') return onBright(ev); });
    ctx.onEnabled((on) => { if (!on) hide('switched off in the tray'); return brightWatch(on); });

    // ---- what the page and the bar ask
    ctx.command('size', async (a) => {
      const w = Math.max(80, Math.min(600, Math.round(Number(a && a.w) || 0)));
      const h = Math.max(40, Math.min(900, Math.round(Number(a && a.h) || 0)));
      size = { w, h };
      const p = shown ? position() : null;
      if (ctx.flags.test) ctx.log(`page drew ${w}x${h}${a && a.open ? ' (panel open)' : ''}${p ? ` at ${p.x},${p.y}` : ''}`);
      return { ok: true, w, h };
    });
    // THE FADE RACE (capture-osd 2026-09-29): the page's "faded" can cross main's next osd.show in
    // flight; hiding then took the window down under the pop-up the page had just drawn, so that key
    // showed nothing. The page echoes the seq of the show it faded; an older one is ignored.
    ctx.command('faded', async (a) => {
      const n = a && typeof a.seq === 'number' ? a.seq : null;
      if (n !== null && n < seq) return { ok: true, ignored: `a newer pop-up (${seq}) is showing` };
      hide(null);
      return { ok: true };
    });
    // the bar's wheel over the speaker: its set goes through qs.set; this shows the pop-up with it.
    // A renderer's state is checked before it reaches the page: a number 0-100 or the real reading.
    function pageState(s) {
      if (!s || typeof s !== 'object' || typeof s.level !== 'number' || !isFinite(s.level)) return current();
      return { ok: s.ok !== false, level: Math.max(0, Math.min(100, Math.round(s.level))), muted: !!s.muted,
        reason: typeof s.reason === 'string' ? s.reason.slice(0, 200) : null };
    }
    ctx.command('show', async (a) => show('volume', pageState(a && a.state),
      { via: a && typeof a.via === 'string' ? a.via.slice(0, 40) : 'bar' }));
    // the bar's right/middle-click on the speaker: the per-app panel, open
    // One log line per open (a person's click, so rare): "I right-clicked the speaker and nothing
    // came" (Owen, 2026-09-30) had no line at all to answer it from, opened or not. Where the panel
    // went, or why it did not open; never a name.
    // r7-mixer (2026-10-01): "opened" was logged when the open was ASKED, and Owen saw nothing. The
    // line now says what was SEEN (seen() above); one that was not seen is taken down, and the bar
    // opens Quick settings with the reason instead (ui/bar/bar.js openMixer), never a silent nothing.
    ctx.command('mixer', async () => {
      const r = show('volume', current(), { expand: true, via: 'bar' });
      if (!r.ok) { ctx.log(`app volumes: not opened from the bar's speaker: ${r.reason}`); return r; }
      // focusable:false, so its page's Escape never runs: the pop-up watch brings Esc from whichever
      // app has the keyboard (lib/popwatch.js) while the panel is up; hide() takes it out again.
      popwatch.open('osd', { esc: () => { ctx.log('app volumes: closed with Esc'); hide('Esc was pressed'); } });
      const where = () => { const b = win && !win.isDestroyed() ? win.getBounds() : null; return b ? ` at ${b.x},${b.y} ${b.width}x${b.height}` : ''; };
      if (ctx.flags.test) { ctx.log(`app volumes: opened from the bar's speaker${where()} (--test: the window stays hidden)`); return r; }
      const v = await seen();
      if (v.seen === false) {
        ctx.log(`app volumes: NOT seen after the bar's speaker opened it${where()}: ${v.why}`);
        hide('it could not be seen on screen');
        return { ok: false, shown: false, test: false, reason: v.why };
      }
      ctx.log(`app volumes: shown from the bar's speaker${where()}, ${v.seen ? v.why : `not checked: ${v.why}`}`);
      return Object.assign({}, r, { seen: v.seen });
    });
    ctx.command('state', async () => ({ ok: true, shown, size, vol, dryVol, healthy, presses, waiting,
      keys: 'VolumeUp, VolumeDown, VolumeMute: Mantle’s while this is on and healthy', brightness: bright }));

    // --test self-check (MANTLE_OSD_SELFTEST=1): open the panel as the bar's right-click would, so
    // the page's osd.size log line proves the whole road without a click on Owen's screen.
    if (ctx.flags.test && process.env.MANTLE_OSD_SELFTEST) {
      setTimeout(() => {
        const r = show('volume', current(), { expand: true, via: 'selftest' });
        ctx.log(`selftest: mixer ${JSON.stringify(r)} vol=${JSON.stringify(vol)}`);
      }, 4000);
      // brightness: a made-up Windows pop-up through the sidecar's real decision; passive makes it a
      // DRY event (nothing moved), which must come back here and draw the page's brightness mode.
      setTimeout(async () => {
        const r = await ctx.sidecar.send('osd.bright', { op: 'simulate', level: 70 }, { timeoutMs: 3000 });
        ctx.log(`selftest: brightness simulate ${JSON.stringify(r.ok ? r.result : r.error)}`);
      }, 7000);
    }

    return {
      stop() {
        stopped = true;
        clearTimeout(backstop);
        clearTimeout(reprobe);
        clearTimeout(settleT);
        if (screen && typeof screen.removeListener === 'function') DISPLAY_EVENTS.forEach((e) => screen.removeListener(e, onDisplay));
        // The keys are the hook's, and the seam releases them (and a dead sidecar's hook dies with it).
        // The volume Mantle set stays, as Windows' would. The ONE Windows change to put back: the
        // brightness pop-up window(s) the sidecar parked off screen (it also does this on its own exit
        // and at its next start, for a crash).
        if (win && !win.isDestroyed()) win.destroy();
        return ctx.sidecar.send('osd.bright', { op: 'watch', on: false }, { timeoutMs: 2000 }).then((r) => {
          ctx.log(`stop: brightness watch off${r.ok ? `, ${(r.result && r.result.restored) || 0} window(s) put back` : ` FAILED (${r.error}); the sidecar puts them back at its exit or next start`}`);
        });
      },
    };
  },
};

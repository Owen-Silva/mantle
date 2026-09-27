'use strict';
/* osd.js - Mantle's volume pop-up, the volume keys behind it, and the Android-style per-app volume
 * panel (osd lane, wave 3, 2026-09-24). The page is ui/osd/ (osd.js + osd-model.js); the sidecar half
 * is sidecar/Osd.cs; the level comes from the sidecar's CoreAudio watch (VolumeWatch.cs, ev 'volume').
 *
 * THE VOLUME KEYS ARE MANTLE'S. Windows' own volume/brightness flyout host could not be found on
 * Windows 11 25H2 (26200.9550, sidecar/Osd.cs), so it cannot be hidden, and a pop-up on top of it
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
 */
const M = require('../../ui/osd/osd-model.js');

const KEYS = ['VolumeUp', 'VolumeDown', 'VolumeMute'];
const OP = { VolumeUp: 'up', VolumeDown: 'down', VolumeMute: 'mute' };
const MARGIN = 18;            // ui/osd/osd.css --m: the transparent margin round the surface
const BACKSTOP_MS = 60000;    // hidden even if the page never says it faded
const MAX_WAITING = 6;        // presses queued behind a slow sidecar before more are dropped
const REPROBE_MS = 30000;     // while unhealthy: try again (the keys are Windows' meanwhile)
const NOTE = 'volume keys show Mantle’s pop-up (Mantle takes the key, so Windows shows none)';

module.exports = {
  name: 'osd',
  label: 'Volume and brightness pop-up',
  defaultOn: true,
  rest: true,                         // its window(s) close while a game runs (lib/features.js restAll)
  chords: KEYS,
  observe: [],
  install(ctx) {
    const { BrowserWindow } = require('electron');
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
        bright.reason = x.reason || (on ? 'the watch did not say why it is off' : 'switched off');
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
      const p = M.place(bar, d.workArea, size, 0);   // the margin IS the gap: the pill sits 18 px above the bar
      win.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height });
      return p;
    }

    function show(kind, state, opts) {
      opts = opts || {};
      if (stopped || !ctx.enabled() || !win || win.isDestroyed()) return { ok: false, reason: stopped ? 'the pop-up is stopped' : !ctx.enabled() ? 'the pop-up is switched off in the tray' : 'the pop-up window is gone' };
      const p = position();
      shownKind = kind;
      ctx.push(win, 'osd.show', { kind, state, expand: !!opts.expand, below: !!(p && p.below), via: opts.via || 'unknown' });
      if (!shown) {
        shown = true;
        // --test: never in front of Owen. The page runs hidden; its osd.size reply proves it drew.
        if (!ctx.flags.test) win.showInactive();
      }
      clearTimeout(backstop);
      backstop = setTimeout(() => hide('backstop: the page never said it faded'), BACKSTOP_MS);
      return { ok: true, shown: !ctx.flags.test, test: !!ctx.flags.test, reason: null };
    }

    function hide(why) {
      clearTimeout(backstop);
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
        else if (win && !win.isDestroyed()) ctx.push(win, 'osd.level', { kind: 'volume', state: s });
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
    KEYS.forEach((k) => ctx.onChord(k, onVolumeKey));
    ctx.sidecar.on('volume', (ev) => {
      vol = ev.ok === false ? { ok: false, level: null, muted: false, reason: ev.reason || 'the volume watch failed without a reason' }
        : { ok: true, level: ev.level, muted: !!ev.muted, reason: null };
      if (shown && win && !win.isDestroyed() && !(ctx.flags.test && dryVol)) ctx.push(win, 'osd.level', { kind: 'volume', state: vol });
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
    ctx.command('faded', async () => { hide(null); return { ok: true }; });
    // the bar's wheel over the speaker: its set goes through qs.set; this shows the pop-up with it
    ctx.command('show', async (a) => show('volume', (a && a.state) || current(), { via: (a && a.via) || 'bar' }));
    // the bar's right/middle-click on the speaker: the per-app panel, open
    ctx.command('mixer', async () => show('volume', current(), { expand: true, via: 'bar' }));
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

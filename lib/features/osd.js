'use strict';
/* osd.js - Mantle's volume/brightness pop-up and the Android-style per-app volume panel behind it
 * (osd lane, wave 3, 2026-09-24). The page is ui/osd/ (osd.js + osd-model.js); the sidecar half is
 * sidecar/Osd.cs; the level comes from the sidecar's CoreAudio watch (VolumeWatch.cs, ev 'volume').
 *
 * THREE WAYS IN
 *   the volume keys   observed, never swallowed (Windows still changes the volume). The pop-up
 *                     shows ONLY while Windows' own flyout is suppressed, so there is never a second
 *                     pop-up on top of Windows' one. On Windows 11 25H2 (26200) that flyout's host
 *                     could not be found (sidecar/Osd.cs WHY NOT YET), so today this path reports
 *                     health(false) with that reason and shows nothing.
 *   brightness        a WmiMonitorBrightnessEvent while the quick-settings panel is closed and the
 *                     change was not Mantle's own set - under the same flyout rule.
 *   the bar           right/middle-click on the speaker opens the per-app panel (osd.mixer), the
 *                     wheel over it changes the master volume and shows the pop-up (osd.show).
 *                     Windows shows nothing for these (a program's volume set has no flyout), so
 *                     they work whatever the flyout rule says.
 *
 * THE WINDOW: pre-created, parked, transparent, frameless, non-activating (focusable:false - it
 * takes clicks but never the keyboard), always on top; sized to what the page reports (osd.size)
 * and placed bottom-centre just above the bar (ui/osd/osd-model.js place). In --test it is never
 * put in front of Owen: it stays hidden and the page still runs, which the self-test logs prove.
 */
const M = require('../../ui/osd/osd-model.js');

const KEYS = ['VolumeUp', 'VolumeDown', 'VolumeMute'];
const MARGIN = 18;            // ui/osd/osd.css --m: the transparent margin round the surface
const BACKSTOP_MS = 60000;    // hidden even if the page never says it faded

module.exports = {
  name: 'osd',
  label: 'Volume and brightness pop-up',
  defaultOn: true,
  chords: [],
  observe: KEYS,
  install(ctx) {
    const { BrowserWindow } = require('electron');
    let win = null;
    let shown = false;
    let size = { w: 288 + 2 * MARGIN, h: 46 + 2 * MARGIN };
    let vol = null;            // {ok, level 0-100, muted, reason}
    let flyout = { checked: false, suppressed: false, reason: 'Windows’ own flyout has not been looked for yet' };
    let backstop = null;
    let stopped = false;
    let lastSkip = '';

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
      wc.on('render-process-gone', (_e, d) => ctx.health(false, `the pop-up page crashed (${d && d.reason})`));
      wc.on('unresponsive', () => ctx.health(false, 'the pop-up page stopped responding'));
      wc.on('did-fail-load', (_e, code, desc) => ctx.health(false, `the pop-up page did not load (${desc || code})`));
      win.loadFile(ctx.page('index.html'));
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

    // ---- the flyout rule: may a key press show the pop-up at all
    async function checkFlyout() {
      const r = await ctx.sidecar.send('osd.flyout', { op: 'find' }, { timeoutMs: 3000 });
      if (!r.ok) flyout = { checked: true, suppressed: false, reason: `Windows’ own flyout could not be looked for (${r.error})` };
      else flyout = { checked: true, suppressed: !!(r.result && r.result.suppressed), found: !!(r.result && r.result.found), reason: (r.result && r.result.reason) || 'no reason given' };
      if (flyout.suppressed) ctx.health(true);
      else ctx.health(false, `volume/brightness keys show Windows’ own pop-up, not Mantle’s: ${flyout.reason}. ` +
        'Right-click or scroll the bar’s speaker for Mantle’s per-app volume panel');
      ctx.log(`flyout: found=${!!flyout.found} suppressed=${flyout.suppressed} (${flyout.reason})`);
    }

    function skip(why) {
      if (why !== lastSkip) ctx.log(`no pop-up: ${why}`);   // once per reason, not once per key repeat
      lastSkip = why;
    }

    async function onVolumeKey(key) {
      if (!ctx.enabled()) return;
      if (!flyout.suppressed) return skip(`${key}: Windows’ own flyout is showing (${flyout.reason})`);
      const q = await ctx.sidecar.send('osd.qs', {}, { timeoutMs: 150 });
      if (q.ok && q.result && q.result.qsOpen === true) return skip(`${key}: the quick-settings panel is open and shows it`);
      lastSkip = '';
      show('volume', vol || { ok: false, reason: 'the volume has not been read yet' }, { via: key });
    }

    function onBrightness(ev) {
      if (!ctx.enabled() || !ev) return;
      const state = typeof ev.level === 'number' ? { ok: true, level: ev.level, present: true, reason: null } : { ok: false, reason: 'Windows reported a brightness change without a level' };
      if (shown) ctx.push(win, 'osd.level', { kind: 'brightness', state });
      if (ev.qsOpen === true) return skip('brightness: the quick-settings panel is open and shows it');
      if (typeof ev.ownMsAgo === 'number' && ev.ownMsAgo < 1500) return skip('brightness: Mantle’s own slider changed it');
      if (!flyout.suppressed) return skip(`brightness: Windows’ own flyout is showing (${flyout.reason})`);
      lastSkip = '';
      show('brightness', state, { via: 'brightness' });
    }

    create();
    KEYS.forEach((k) => ctx.onKey(k, onVolumeKey));
    ctx.sidecar.on('volume', (ev) => {
      vol = ev.ok === false ? { ok: false, level: null, muted: false, reason: ev.reason || 'the volume watch failed without a reason' }
        : { ok: true, level: ev.level, muted: !!ev.muted, reason: null };
      if (shown && win && !win.isDestroyed()) ctx.push(win, 'osd.level', { kind: 'volume', state: vol });
    });
    ctx.sidecar.on('osd', (ev) => { if (ev.kind === 'brightness') onBrightness(ev); });
    ctx.sidecar.onReady(async () => {
      const v = await ctx.sidecar.send('volume', {}, { timeoutMs: 3000 });
      if (v.ok && v.result && typeof v.result.level === 'number' && !vol) vol = { ok: true, level: v.result.level, muted: !!v.result.muted, reason: null };
      const w = await ctx.sidecar.send('osd.watch', { on: true }, { timeoutMs: 8000 });
      if (!w.ok || (w.result && w.result.watching === false)) ctx.log(`brightness changes are not watched: ${w.ok ? w.result.reason : w.error}`);
      await checkFlyout();
    });
    ctx.onEnabled((on) => { if (!on) hide('switched off in the tray'); });

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
    ctx.command('show', async (a) => show('volume', (a && a.state) || vol || { ok: false, reason: 'the volume has not been read yet' }, { via: (a && a.via) || 'bar' }));
    // the bar's right/middle-click on the speaker: the per-app panel, open
    ctx.command('mixer', async () => show('volume', vol || { ok: false, reason: 'the volume has not been read yet' }, { expand: true, via: 'bar' }));
    ctx.command('state', async () => ({ ok: true, shown, size, vol, flyout }));

    // --test self-check (MANTLE_OSD_SELFTEST=1): open the panel as the bar's right-click would, so
    // the page's osd.size log line proves the whole road without a click on Owen's screen.
    if (ctx.flags.test && process.env.MANTLE_OSD_SELFTEST) {
      setTimeout(() => {
        const r = show('volume', vol || { ok: false, reason: 'the volume has not been read yet' }, { expand: true, via: 'selftest' });
        ctx.log(`selftest: mixer ${JSON.stringify(r)} vol=${JSON.stringify(vol)}`);
      }, 4000);
    }

    return {
      stop() {
        stopped = true;
        clearTimeout(backstop);
        // Nothing of Windows' was changed (the flyout is never hidden until a host is found), so
        // there is nothing to put back; the brightness watcher is the sidecar's to drop.
        ctx.sidecar.send('osd.watch', { on: false }, { timeoutMs: 1500 });
        if (win && !win.isDestroyed()) win.destroy();
      },
    };
  },
};

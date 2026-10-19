'use strict';
/*
 * lib/features/clips.js - Win+G: Mantle's Record panel, and the Clips gallery (lane mantle-clips,
 * 2026-10-15; scope design notes: mantle-gamebar-scope).
 *
 * Owen uses Win+G "not much a all mostly just for recording", and "it should open a mantle remember i
 * want everything manlte". So Win+G opens a small Mantle panel (ui/clips/record.html) near the bottom
 * right, over the app in front, games included where a window can show:
 *   Record / Stop + a running timer, the mic switch, "Open Clips", the last clip's picture, and a
 *   "Record a region or window" row for Mantle's own recorder (lane mantle-screenrec: shown only while
 *   a `screenrec.start` command exists).
 *
 * RECORDING IS WINDOWS' OWN ENGINE (Game Bar / GameDVR: same quality, encoder and Captures folder).
 * MEASURED before any UI (sidecar/Record.cs header): no API starts it for another app, Win+G cannot
 * be registered (1409), and one SendInput of Win+Alt+R starts and stops it. The panel never takes
 * the foreground (focusable:false), so the app Owen is in is the one Windows records, and the panel
 * is excluded from every capture (setContentProtection), so it is never in the recording.
 *
 * GAMES (Vanguard): nothing is injected, hooked or drawn INTO a game. The panel is a normal topmost
 * window over a borderless or windowed game. The Record button never presses keys while a game is in
 * front: it shows "Win+Alt+R" for Owen to press, and the timer still runs (the file is watched).
 * Exclusive full screen (QUNS 3, where no window can show): Win+G goes to Windows' Game Bar, by
 * handing the chord back (ctx.keysAway) the moment it is seen, with one plain log line.
 * NO NEW HOOK IN GAMES: the keyboard hook already runs in games for Win+E (mantle.log "features:
 * keys resting while VALORANT runs: taking Win+E"), so Win+G adds one bit to its chord mask.
 *
 * THE GALLERY (ui/clips/index.html): the Captures folder (Videos\Captures, as Windows' Settings
 * shows it, sidecar gaming.get), videos and pictures newest first, thumbnails cached on disk
 * (%APPDATA%\mantle\clips-thumbs), inline play, lossless keyframe trim to a NEW file
 * (_clips-mp4.js), Copy (the file on the clipboard, for Discord), Windows' share sheet, delete to the
 * Recycle Bin with Undo, Open folder.
 *
 * ZERO RAM WHEN CLOSED: both windows are made on demand; the panel goes PANEL_IDLE_MS after it hides,
 * the gallery when it closes. Nothing polls while neither is open and nothing is recording.
 */
const fs = require('fs');
const path = require('path');
const C = require('./_clips-core');
const MP4 = require('./_clips-mp4');
const raiseWin = require('../raise');
const popwatch = require('../popwatch');
const WW = require('./_wall-window.js');
const BF = require('../bar-follow');
const barShape = require('../bar-shape');
const corner = require('../corner');
const CORNER_KEY = 'the record panel';

const CHORD = 'Win+G';
const PANEL_W = 340, MARGIN = 18;
const PANEL_IDLE_MS = 90 * 1000;
const START_WAIT_MS = 15000;          // measured 3.2-7.8 s from the keys to the file
const REC_POLL_MS = 1000;
/* WIN+G BACK AFTER EXCLUSIVE FULL SCREEN (lane mantle-clips2). Win+G in an exclusive full-screen game
 * goes to Windows' Game Bar (ctx.keysAway): the hook lets the chord through untouched from then on.
 * Taking it back must not cost a poll for the whole game, so: ONE sidecar read of
 * SHQueryUserNotificationState (record.target, ~1 ms in the sidecar) when the window list changes (the
 * game closed or another window came up), and a slow backstop every AWAY_POLL_MS while away only. The
 * moment the screen is no longer exclusive, Win+G is Mantle's again. Nothing runs while it is ours. */
const AWAY_POLL_MS = 5000;
const GAMEBAR_URI = 'ms-gamebar://launch/activate';
/* A trim the lossless cut refuses for its LAYOUT (not for damage, or a clip still recording) is
 * re-encoded by Windows' own encoder (sidecar/ClipsEncode.cs); these are the layout refusals. */
const REENCODE_FIXES = /fragmented|cannot be cut losslessly|chunk offsets|sample-to-chunk|too big to cut|single frame is bigger/;
const ENCODE_WAIT_MS = 30 * 60 * 1000;

module.exports = {
  name: 'clips',
  label: 'Clips and Record (Win+G)',
  defaultOn: true,
  rest: false,                        // nothing is kept warm to free, and Win+G works in games too
  chords: [CHORD],
  observe: [],
  options: [
    { key: 'winG', label: "Win+G opens Mantle's Record panel (Windows' Game Bar otherwise)", type: 'bool', default: true },
  ],
  install(ctx) {
    const { BrowserWindow, app, shell } = require('electron');
    const test = !!ctx.flags.test;
    const idleMs = test && Number(process.env.MANTLE_IDLE_UNLOAD_MS) > 0 ? Number(process.env.MANTLE_IDLE_UNLOAD_MS) : PANEL_IDLE_MS;
    const awayMs = test && Number(process.env.MANTLE_CLIPS_AWAY_POLL_MS) > 0 ? Number(process.env.MANTLE_CLIPS_AWAY_POLL_MS) : AWAY_POLL_MS;
    /* A --test Mantle NEVER lists, thumbnails or plays Owen's Captures: its folder is MANTLE_CLIPS_DIR
       (under %TEMP%) or an empty temp folder, and MANTLE_CLIPS_FAKE=1 swaps the recorder's sidecar
       calls for a fake (_clips-fake.js) so no test ever sends a real Win+Alt+R. */
    const testDir = test ? (process.env.MANTLE_CLIPS_DIR && require('./_clips-fake').underTemp(process.env.MANTLE_CLIPS_DIR)
      ? path.resolve(process.env.MANTLE_CLIPS_DIR) : path.join(require('os').tmpdir(), 'mantle-clips-test-empty')) : null;
    const fake = test && process.env.MANTLE_CLIPS_FAKE === '1'
      ? require('./_clips-fake').make({ dir: testDir, real: ctx.sidecar, startMs: Number(process.env.MANTLE_CLIPS_FAKE_START_MS) || 900 }) : null;
    const side = fake || ctx.sidecar;
    const S = {
      stopped: false, folder: testDir, panel: null, panelReady: false, panelShown: false, panelH: 260, idleT: null,
      gallery: null, watch: null, target: null, quns: -1, rest: null,
      rec: { on: false, since: null, file: null, app: null, by: null, pending: null, why: null }, recT: null,
      undo: new Map(), undoN: 0, mic: null,
      away: null, awayT: null, awayChecks: 0, gamebar: { n: 0, last: null, why: null },
      openSeq: 0, opening: null, opens: [], panelMakes: 0, galleryMakes: 0, encodes: 0,
      spot: null, shape: null, shapeOk: null, shapeWhy: null, shapeChecked: false, holdT: null,
    };
    /* lane corner-follow: the panel glides with the bar (lib/bar-follow.js, the banners' follower): the window
       sits in the corner as if the bar were not there, and the page lifts the card S.spot.reach while it is up */
    const F = BF.createFollower({
      bar: ctx.host && ctx.host.bar,
      target: (up) => (S.spot ? (up ? S.spot.reach : S.spot.rest) : 0),   // the bar up / hidden (lib/bar-follow.js)
      shown: () => !!(S.panel && !S.panel.isDestroyed() && S.panelShown && S.panelReady),
      flat: () => S.shapeOk === false,
      send: (p) => { if (S.panel && !S.panel.isDestroyed() && S.panelReady) ctx.push(S.panel, 'clips.lift', p); },
      settled: () => { if (S.panelShown) placePanel(); },
      moved: (plan) => { F.retarget(plan.kind, plan.ms); if (S.panelShown) placePanel(); },
    });
    const thumbDir = path.join(app.getPath('userData'), 'clips-thumbs');
    const get = (k, d) => { try { return ctx.settings.get(k, d); } catch (_) { return d; } };
    const winG = () => get('winG', true) !== false;
    // dark: the gallery paints the wallpaper under its tint, as Files and Task Manager do (light: acrylic)
    const wall = WW.feed(ctx, { event: 'clips.wall', pos: 'clips.wallpos', light: { material: 'acrylic', color: '#00000000' } });

    /* ---- the folder: Windows' own (gaming.get), else Videos\Captures ---- */
    function folder() {
      if (S.folder) return S.folder;
      try { S.folder = path.join(app.getPath('videos'), 'Captures'); } catch (_) { S.folder = null; }
      return S.folder;
    }
    side.onReady(() => {
      side.send('gaming.get', {}, { timeoutMs: 6000 }).then((r) => {
        const f = r.ok && r.result && (r.result.folder && (r.result.folder.value || r.result.folder.path || r.result.folder));
        if (typeof f === 'string' && path.isAbsolute(f) && !test) S.folder = f;
        const mic = r.ok && r.result && r.result.mic;
        if (mic && typeof mic.on === 'boolean') S.mic = mic.on;
      });
    });
    const full = (name) => {
      const dir = folder();
      const n = path.basename(String(name || ''));
      if (!dir || !n || n !== String(name)) throw new Error('that is not a file in the Captures folder');
      return path.join(dir, n);
    };
    async function entries() {
      const dir = folder();
      if (!dir) return [];
      let names = [];
      try { names = await fs.promises.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
      const out = [];
      for (const name of names) {
        if (!C.kindOf(name)) continue;
        try { const st = await fs.promises.stat(path.join(dir, name)); if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs }); } catch (_) { /* went */ }
      }
      return out;
    }

    /* ---- the recording's state: Windows records, Mantle watches the file ---- */
    async function newestVideo() {
      const list = (await entries()).filter((e) => C.kindOf(e.name) === 'video').sort((a, b) => b.birthtimeMs - a.birthtimeMs);
      return list[0] || null;
    }
    async function growing(e) {
      if (!e || Date.now() - e.mtimeMs > 3000) return false;
      await new Promise((r) => setTimeout(r, 700));
      try { const st = await fs.promises.stat(path.join(folder(), e.name)); return st.size !== e.size || st.mtimeMs !== e.mtimeMs; } catch (_) { return false; }
    }
    function pollRec(on) {
      clearTimeout(S.recT); S.recT = null;
      if (!on || S.stopped) return;
      S.recT = setTimeout(async () => {
        S.recT = null;
        try {
          if (S.rec.pending) {
            const e = await newestVideo();
            if (e && e.birthtimeMs >= S.rec.pending.at - 1500) {
              S.rec = { on: true, since: e.birthtimeMs, file: e.name, app: S.rec.pending.app, by: 'mantle', pending: null, why: null };
              ctx.log(`record: Windows is recording (${Date.now() - S.rec.since < 60000 ? 'started' : 'found'})`);   // never the file name: it is a window title
              push();
            } else if (Date.now() - S.rec.pending.at > START_WAIT_MS) {
              S.rec = { on: false, since: null, file: null, app: null, by: null, pending: null, why: 'Windows did not start a recording within 15 s (Game Bar may be off in Settings > Gaming, or this app cannot be recorded)' };
              ctx.log(`record: ${S.rec.why}`);
              push();
            }
          } else if (S.rec.on) {
            const st = await fs.promises.stat(path.join(folder(), S.rec.file)).catch(() => null);
            if (!st || Date.now() - st.mtimeMs > 4000) {
              ctx.log(`record: the recording ended (${C.clock(Date.now() - S.rec.since)})`);
              S.rec = { on: false, since: null, file: null, app: null, by: null, pending: null, why: null, last: st ? S.rec.file : null };
              push();
            }
          }
        } catch (err) { ctx.log(`record: could not read the Captures folder (${err.message})`); }
        pollRec(S.rec.on || !!S.rec.pending || (S.panelShown && false));
      }, REC_POLL_MS);
      if (S.recT.unref) S.recT.unref();
    }
    async function lookForRecording() {
      if (S.rec.on || S.rec.pending) return;
      const e = await newestVideo();
      if (e && await growing(e)) {
        S.rec = { on: true, since: e.birthtimeMs, file: e.name, app: null, by: 'windows', pending: null, why: null };
        pollRec(true);
      }
    }

    /* ---- what the panel shows ---- */
    async function readTarget() {
      const r = await side.send('record.target', {}, { timeoutMs: 1500 });
      if (!r.ok) return { target: null, why: r.error };
      S.quns = r.result.quns;
      return { target: r.result };
    }
    async function lastClip() {
      const list = C.gallery(await entries(), {}, {}).items;
      const it = list[0];
      if (!it) return null;
      return { name: it.name, kind: it.kind, title: it.title, at: it.at, thumb: await thumbFor(it).catch(() => null) };
    }
    function stateNow(extra) {
      const plan = C.recordPlan({ target: S.target, resting: !!S.rest, quns: S.quns, recording: S.rec.on });
      return Object.assign({
        rec: { on: S.rec.on, since: S.rec.since, pending: !!S.rec.pending, by: S.rec.by, why: S.rec.why },
        app: S.target ? C.appLabel(S.target) : null, plan, mic: S.mic,
        screenrec: ctx.hasCommand('screenrec.start'), now: Date.now(),
      }, extra || {});
    }
    function push(extra) { if (S.panel && !S.panel.isDestroyed() && S.panelReady) ctx.push(S.panel, 'clips.state', stateNow(extra)); }

    /* ---- the panel window: made on demand, never takes the foreground, never in a capture ---- */
    function makePanel() {
      const w = new BrowserWindow({
        show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false, focusable: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        alwaysOnTop: !test, backgroundThrottling: false, title: 'Mantle record',
        width: PANEL_W + 2 * MARGIN, height: S.panelH, x: -32000, y: -32000,
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      if (!test) w.setAlwaysOnTop(true, 'screen-saver');
      try { w.setContentProtection(true); } catch (_) { /* not on this build: the panel can show in a recording */ }
      const wc = w.webContents;
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('did-finish-load', () => { if (S.panel === w) { S.panelReady = true; push({ open: S.panelShown, seq: S.opening ? S.opening.seq : 0 }); F.stand(); } });
      wc.on('render-process-gone', (_e, d) => { if (S.panel === w) { ctx.log(`the record panel's page ${(d && d.reason) || 'went away'}; the next Win+G makes it again`); dropPanel('its page went away'); } });
      w.on('closed', () => { if (S.panel === w) { S.panel = null; S.panelReady = false; S.panelShown = false; } });
      w.loadFile(ctx.page('record.html'));
      S.panel = w; S.panelReady = false; S.panelMakes++;
      S.shape = null; S.shapeOk = null; S.shapeWhy = null; S.shapeChecked = false; F.reset();   // a new window: shaped afresh
      return w;
    }
    function dropPanel(why) {
      clearTimeout(S.idleT); S.idleT = null; clearTimeout(S.holdT); S.holdT = null;
      popwatch.close('clips');
      corner.set(CORNER_KEY, null);
      const w = S.panel; S.panel = null; S.panelReady = false; S.panelShown = false;
      if (w && !w.isDestroyed()) { w.destroy(); if (why) ctx.log(`the record panel closed (${why})`); }
    }
    /* WHERE (lane corner-follow, C.panelSpot): the corner as if the bar were not there; with the bar up the
       card stands S.spot.reach higher, clear of the pill's resting shape. The window is the card's h PLUS the
       reach, its bottom in the corner, SHAPED (lib/bar-shape.js) to the card wherever it is, or every place it
       passes while it glides (BF.rectFor), so the empty reach band never eats a click. If the first shape does
       not stick (read back from Windows) the window is sized to the card and placed straight at the target. */
    function hwndOf(w) {
      try { const b = w.getNativeWindowHandle(); return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0)); } catch (_) { return '0'; }
    }
    function flatten(why) {
      ctx.log(`the record panel's shape did not stick (${why}); it is sized to the card instead`);
      S.shapeOk = false; S.shapeWhy = why; S.shape = null;
      barShape.apply(S.panel, null);
    }
    function placePanel() {
      if (!S.panel || S.panel.isDestroyed()) return;
      const d = ctx.host.display() || {};
      const bar = typeof ctx.host.barRect === 'function' ? ctx.host.barRect() : null;
      const sp = S.spot = C.panelSpot({ work: d.workArea, bar, pill: F.pill(), w: PANEL_W + 2 * MARGIN, h: S.panelH });
      F.retarget();                     // the reach moved (the screen, the bar): glide there; else nothing
      const lift = F.span().to;         // where the card rests now (a first place stands there)
      let flat = S.shapeOk === false;
      if (!flat) {
        S.panel.setBounds({ x: sp.low.x, y: sp.low.y + sp.h - sp.full, width: sp.w, height: sp.full });
        const rect = BF.rectFor(F.span(), sp.h, sp.full, sp.w);
        const r = barShape.apply(S.panel, rect);
        if (!r.ok) { flatten(r.reason); flat = true; } else {
          S.shape = rect;
          if (!S.shapeChecked) {
            S.shapeChecked = true;
            const v = barShape.verify(hwndOf(S.panel), rect, d.scaleFactor || 1);
            if (!v.ok) { flatten(v.reason); flat = true; F.stand(); } else S.shapeOk = true;
          }
        }
      }
      // no shape: the window is the card, so it cannot glide inside itself: straight at the target
      if (flat) S.panel.setBounds({ x: sp.low.x, y: sp.low.y - lift, width: sp.w, height: sp.h });
      // the banners stand above the card (lib/corner.js; { lift }: where it is while the bar is up)
      if (S.panelShown) corner.set(CORNER_KEY, C.panelCard(sp.low, sp.h, 0, MARGIN), { lift: sp.reach, rest: sp.rest });
    }
    /** The card's screen rect now (the lifted one while the bar is up): popwatch's "inside". */
    function cardNow() {
      if (!S.panel || S.panel.isDestroyed() || !S.spot) return null;
      return C.panelCard(S.panel.getBounds(), S.spot.h, S.shapeOk === false ? 0 : F.span().to, MARGIN);
    }
    async function openPanel(via) {
      const t0 = Date.now();
      clearTimeout(S.idleT); S.idleT = null;
      const tg = await readTarget();
      S.target = tg.target;
      const where = C.route({ on: true, panel: winG(), quns: S.quns, target: S.target, game: C.knownGame(S.target) || S.rest });
      if (where.to === 'gamebar') {
        ctx.log(`Win+G: ${where.why}`);
        if (S.quns === 3) goAway();
        // the hook swallowed this one Win+G: Windows' Game Bar is opened for it, so the press is never lost
        openGamebar(where.why);
        return { ok: true, to: 'gamebar', why: where.why };
      }
      const cold = !(S.panel && !S.panel.isDestroyed());
      const w = cold ? makePanel() : S.panel;
      const was = S.panelShown;
      S.panelShown = true;
      S.opening = { seq: ++S.openSeq, t0, cold, via };
      placePanel();
      push({ open: true, seq: S.opening.seq });
      // where the card stands (after the page has it): with the bar still GOING it starts at the bar's top
      // and goes down with it (lib/bar-follow.js catchUp; the shape is re-set to span that), else it is there
      if (!was) { if (S.panelReady && F.catchUp(false)) placePanel(); else F.stand(); }
      lookForRecording().then(() => push()).catch(() => {});
      // a --test window shows too: lib/test-quiet.js keeps it invisible, click-through and unfocusable
      w.showInactive();
      if (S.opening) S.opening.shownAt = Date.now();   // main's share of the open time (route + make/show)
      if (!test) raiseWin.up(w, { what: 'the record panel', log: ctx.log, wanted: () => S.panel === w && !w.isDestroyed() && w.isVisible() });
      popwatch.open('clips', {
        esc: () => hidePanel('Esc'),
        // the card where it is NOW (lifted while the bar is up), never the window: the empty reach band is outside
        contains: (pt) => { const c = cardNow(); return !!(c && pt && pt.x >= c.x && pt.x < c.x + c.width && pt.y >= c.y && pt.y < c.y + c.height); },
        outside: () => hidePanel('a click outside it'),
        away: () => hidePanel('another app came to the front'),
      });
      ctx.log(`record panel: opened by ${via} in ${Date.now() - t0} ms${cold ? ' (made)' : ''}${S.rest ? ` (${S.rest})` : ''}`);
      return { ok: true, to: 'panel', ms: Date.now() - t0, cold, seq: S.opening.seq };
    }

    /* ---- Windows' Game Bar, and Win+G back after exclusive full screen ---- */
    function openGamebar(why) {
      S.gamebar.n++; S.gamebar.last = Date.now(); S.gamebar.why = why;
      if (test) { ctx.log(`Win+G: would open ${GAMEBAR_URI} (test: not opened)`); return; }
      shell.openExternal(GAMEBAR_URI).catch((err) => {
        S.gamebar.why = `Windows did not open the Game Bar (${err.message})`;
        ctx.log(`Win+G: ${S.gamebar.why}`);
      });
    }
    function goAway() {
      if (S.away) return;
      S.away = { since: Date.now() };
      ctx.keysAway('an exclusive full-screen app is in front');
      ctx.log('Win+G: handed to Windows\' Game Bar until the exclusive full-screen app is gone');
      armAway();
    }
    function armAway() {
      clearTimeout(S.awayT);
      S.awayT = setTimeout(() => { S.awayT = null; checkAway('the backstop'); }, awayMs);
      if (S.awayT.unref) S.awayT.unref();
    }
    async function checkAway(why) {
      if (!S.away || S.stopped || S.away.busy) return;
      S.awayChecks++;
      S.away.busy = true;
      const tg = await readTarget().catch(() => ({ target: null }));
      if (!S.away) return;
      S.away.busy = false;
      if (tg.target && S.quns !== 3) {
        const held = Math.round((Date.now() - S.away.since) / 1000);
        S.away = null; clearTimeout(S.awayT); S.awayT = null;
        ctx.keysAway(winG() ? null : 'the Win+G setting is off');
        ctx.log(`Win+G: Mantle's again (the exclusive full-screen app is gone; seen by ${why} after ${held} s)`);
        return;
      }
      armAway();
    }
    side.on('windows', () => { if (S.away) checkAway('a window change'); });
    function hidePanel(why) {
      popwatch.close('clips');
      clearTimeout(S.holdT); S.holdT = null;
      corner.set(CORNER_KEY, null);
      if (!S.panelShown) return;
      S.panelShown = false;
      if (S.panel && !S.panel.isDestroyed()) {
        ctx.push(S.panel, 'clips.hide', { why });
        S.panel.hide();
        S.panel.setBounds({ x: -32000, y: -32000, width: PANEL_W + 2 * MARGIN, height: S.panelH });
      }
      clearTimeout(S.idleT);
      S.idleT = setTimeout(() => dropPanel(`unused for ${Math.round(idleMs / 1000)} s`), idleMs);
      if (S.idleT.unref) S.idleT.unref();
    }

    /* ---- the record button ---- */
    async function record() {
      if (S.rec.pending) return { ok: true, state: stateNow(), why: 'waiting for Windows to start' };
      const tg = await readTarget();
      if (tg.target) S.target = tg.target;
      const plan = C.recordPlan({ target: S.target, resting: !!S.rest, quns: S.quns, recording: S.rec.on });
      if (!plan.can) return { ok: false, why: plan.why, how: plan.how, state: stateNow() };
      // a --test Mantle sends keys only to the FAKE recorder (MANTLE_CLIPS_FAKE); otherwise a dry run
      const dry = test && !fake;
      const r = await side.send('record.keys', { hwnd: S.target.hwnd, dryRun: dry }, { timeoutMs: 3000 });
      if (!r.ok) return { ok: false, why: r.error, state: stateNow() };
      if (dry) return { ok: true, dryRun: true, would: r.result && r.result.would, state: stateNow() };
      if (S.rec.on) { ctx.log('record: Stop pressed (Win+Alt+R)'); pollRec(true); return { ok: true, state: stateNow({ stopping: true }) }; }
      S.rec.pending = { at: Date.now(), app: C.appLabel(S.target) };
      S.rec.why = null;
      ctx.log('record: Record pressed (Win+Alt+R); waiting for Windows to start');
      pollRec(true);
      return { ok: true, state: stateNow() };
    }

    /* ---- thumbnails, cached on disk ---- */
    async function thumbFor(it) {
      const file = path.join(thumbDir, C.thumbKey(it));
      if (fs.existsSync(file)) return `file:///${file.replace(/\\/g, '/')}`;
      const r = await side.send('files.thumbs', { items: [full(it.name)], px: 320, mode: 'thumb' }, { timeoutMs: 12000 });
      const one = r.ok && r.result && Array.isArray(r.result.results) ? r.result.results[0] : null;
      if (!one || !one.png) return null;
      await fs.promises.mkdir(thumbDir, { recursive: true });
      await fs.promises.writeFile(file, Buffer.from(String(one.png).replace(/^data:image\/png;base64,/, ''), 'base64'));
      return `file:///${file.replace(/\\/g, '/')}`;
    }
    async function metaFor(list) {
      const out = {};
      const cacheFile = path.join(thumbDir, 'meta.json');
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { /* first time */ }
      let changed = false;
      for (const e of list) {
        if (C.kindOf(e.name) !== 'video') continue;
        const k = C.thumbKey(e);
        if (!cache[k]) { try { cache[k] = await MP4.quickInfo(path.join(folder(), e.name)); changed = true; } catch (_) { cache[k] = {}; } }
        out[e.name] = cache[k];
      }
      if (changed) { try { fs.mkdirSync(thumbDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (_) { /* next time */ } }
      return out;
    }

    /* ---- the gallery window ---- */
    function openGallery(focusName) {
      if (S.gallery && !S.gallery.isDestroyed()) {
        if (S.gallery.isMinimized() && !test) S.gallery.restore();
        S.gallery.show(); if (!test) S.gallery.focus();
        if (focusName) ctx.push(S.gallery, 'clips.focus', { name: focusName });
        return { ok: true, made: false };
      }
      const d = ctx.host.display() || {};
      const wa = d.workArea || { x: 0, y: 0, width: 1280, height: 720 };
      const W = Math.min(1180, wa.width - 80), H = Math.min(760, wa.height - 80);
      const w = new BrowserWindow({
        show: false, frame: false, title: 'Clips', backgroundMaterial: 'acrylic', backgroundColor: '#00000000',
        width: W, height: H, x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + (wa.height - H) / 2), minWidth: 640, minHeight: 420,
        skipTaskbar: test, webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
      });
      w.on('page-title-updated', (e) => e.preventDefault());
      w.webContents.on('will-navigate', (e) => e.preventDefault());
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('did-finish-load', () => { if (focusName) ctx.push(w, 'clips.focus', { name: focusName }); });
      wall.attach(w);
      // dark: the wallpaper is baked before the first show (lane helm-wall); a --test window shows
      // invisibly (lib/test-quiet.js), so the e2e reads a painted page
      w.once('ready-to-show', () => wall.hold(w, () => { if (S.gallery === w && !w.isDestroyed()) { w.show(); if (!test) w.focus(); } }));
      w.on('closed', () => { if (S.gallery === w) { S.gallery = null; unwatch(); ctx.log('clips: the gallery closed (its window and page are gone)'); } });
      w.loadFile(ctx.page('index.html'));
      S.gallery = w; S.galleryMakes++;
      watchFolder();
      return { ok: true, made: true };
    }
    function watchFolder() {
      unwatch();
      const dir = folder();
      if (!dir) return;
      let t = null;
      try {
        S.watch = fs.watch(dir, () => { clearTimeout(t); t = setTimeout(() => { if (S.gallery && !S.gallery.isDestroyed()) ctx.push(S.gallery, 'clips.changed', {}); }, 400); });
        S.watch.on('error', () => unwatch());
      } catch (_) { S.watch = null; }
    }
    function unwatch() { if (S.watch) { try { S.watch.close(); } catch (_) { /* gone */ } S.watch = null; } }

    /* ---- commands (the pages' API) ---- */
    ctx.command('state', async () => { const tg = await readTarget(); if (tg.target) S.target = tg.target; return Object.assign({ ok: true }, stateNow({ last: await lastClip().catch(() => null) }), test ? { follow: followState() } : null); });
    /** lane corner-follow: where the panel is and how it follows the bar (the trace and the dev console) */
    function followState() {
      const live = !!(S.panel && !S.panel.isDestroyed());
      return {
        bounds: live ? S.panel.getBounds() : null, shown: S.panelShown, spot: S.spot, reach: S.spot ? S.spot.reach : 0, rest: S.spot ? S.spot.rest : 0,
        lift: S.shapeOk === false ? 0 : (F.state().span ? F.state().span.to : 0), card: cardNow(), shape: S.shape, shapeOk: S.shapeOk, shapeWhy: S.shapeWhy,
        corner: corner.list().find((c) => c.key === CORNER_KEY) || null, holding: !!S.holdT, ...F.state(),
      };
    }
    ctx.command('record', () => record());
    ctx.command('mic', async (a) => {
      const on = !!(a && a.on);
      const r = await side.send('gaming.set', { key: 'mic', value: on, dryRun: test }, { timeoutMs: 4000 });
      if (!r.ok) return { ok: false, why: r.error, mic: S.mic };
      if (!test) S.mic = on;
      return { ok: true, mic: test ? on : S.mic, dryRun: test, note: S.rec.on ? 'from the next recording' : null };
    });
    ctx.command('size', (a) => { const h = Math.round(Number(a && a.h) || 0); if (h > 40 && h < 900) { S.panelH = h + 2 * MARGIN; if (S.panelShown) placePanel(); } return { ok: true }; });
    ctx.command('close', (a) => { hidePanel((a && a.why) || 'closed'); return { ok: true }; });
    ctx.command('open', (a) => { if (a && a.from === 'panel') hidePanel('Open Clips'); return openGallery(a && a.name); });
    ctx.command('list', async (a) => {
      const list = await entries();
      const g = C.gallery(list, await metaFor(list), { filter: a && a.filter });
      for (const it of g.items) it.url = `file:///${full(it.name).replace(/\\/g, '/')}`;
      return { ok: true, folder: folder(), items: g.items, groups: g.groups.map((x) => ({ label: x.label, names: x.items.map((i) => i.name) })), counts: g.counts, recording: S.rec.on ? S.rec.file : null };
    });
    ctx.command('thumbs', async (a) => {
      const out = {};
      const list = await entries();
      for (const name of (a && a.names) || []) {
        const e = list.find((x) => x.name === name);
        out[name] = e ? await thumbFor(e).catch(() => null) : null;
      }
      return { ok: true, thumbs: out };
    });
    ctx.command('trim', async (a) => {
      const src = full(a.name);
      if (S.rec.on && S.rec.file === a.name) return { ok: false, why: 'that clip is still recording' };
      const dir = path.dirname(src);
      const name = C.trimName(a.name, a.startMs, a.endMs, (n) => fs.existsSync(path.join(dir, n)));
      const startMs = Number(a.startMs) || 0, endMs = Number(a.endMs) || 0;
      let refused;
      try {
        const r = await MP4.cut(src, path.join(dir, name), startMs, endMs);
        ctx.log(`clips: trimmed losslessly in ${r.ms} ms (${Math.round(r.bytes / 1048576)} MB)`);
        return { ok: true, name, lossless: true, startMs: r.startMs, endMs: r.endMs, ms: r.ms };
      } catch (err) { refused = err.message; }
      if (!REENCODE_FIXES.test(refused) || C.extOf(a.name) !== '.mp4') {
        ctx.log(`clips: a trim was refused (${refused})`);
        return { ok: false, why: `${refused}; nothing was changed` };
      }
      // the lossless cut cannot read this layout: Windows' own encoder makes the new file instead
      ctx.log(`clips: the lossless cut was refused (${refused}); re-encoding with Windows' encoder`);
      const r = await reencode(a.name, src, path.join(dir, name), startMs, endMs);
      if (!r.ok) {
        ctx.log(`clips: the re-encode failed too (${r.why})`);
        return { ok: false, why: `${refused}, and Windows could not re-encode it either (${r.why}); nothing was changed` };
      }
      ctx.log(`clips: trimmed by re-encoding in ${Math.round(r.ms / 1000)} s (${Math.round(r.bytes / 1048576)} MB)`);
      return { ok: true, name, lossless: false, reencoded: true, startMs, endMs, ms: r.ms, why: refused };
    });
    async function reencode(shown, src, dst, startMs, endMs) {
      const job = `clips-enc-${++S.encodes}`;
      const toGallery = (ev, p) => { if (S.gallery && !S.gallery.isDestroyed()) ctx.push(S.gallery, ev, p); };
      let offP = null, offD = null, t = null;
      const done = new Promise((resolve) => {
        offP = side.on('clips.encoding', (m) => { if (m && m.job === job) toGallery('clips.encoding', { name: shown, pct: m.pct }); });
        offD = side.on('clips.encoded', (m) => { if (m && m.job === job) resolve(m); });
        t = setTimeout(() => resolve({ ok: false, why: `the encoder said nothing for ${ENCODE_WAIT_MS / 60000} min` }), ENCODE_WAIT_MS);
      });
      const fin = () => { clearTimeout(t); if (typeof offP === 'function') offP(); if (typeof offD === 'function') offD(); };
      const r = await side.send('clips.reencode', { src, dst, startMs: Math.round(startMs), endMs: Math.round(endMs), job }, { timeoutMs: 8000 });
      if (!r.ok) { fin(); return { ok: false, why: r.error }; }
      toGallery('clips.encoding', { name: shown, pct: 0 });
      const m = await done;
      fin();
      return m && m.ok ? { ok: true, ms: m.ms, bytes: m.bytes } : { ok: false, why: (m && m.why) || 'the encoder gave no reason' };
    }
    ctx.command('copy', async (a) => {
      const r = await side.send('files.clip.set', { paths: [full(a.name)], op: 'copy' }, { timeoutMs: 4000 });
      return r.ok ? { ok: true } : { ok: false, why: r.error };
    });
    ctx.command('share', async (a) => {
      const b = S.gallery && !S.gallery.isDestroyed() ? S.gallery.getBounds() : { x: 400, y: 300, width: 0, height: 0 };
      const r = await side.send('clips.share', { path: full(a.name), x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }, { timeoutMs: 10000 });
      return r.ok ? { ok: true } : { ok: false, why: r.error };
    });
    ctx.command('delete', async (a) => {
      const job = `clips-${++S.undoN}`;
      const done = new Promise((resolve) => {
        const off = side.on('files.opdone', (m) => { if (m && m.job === job) { off(); resolve(m); } });
        setTimeout(() => { off(); resolve(null); }, 15000);
      });
      const r = await side.send('files.op', { op: 'recycle', items: [full(a.name)], job, conflict: 'ask' }, { timeoutMs: 8000 });
      if (!r.ok) return { ok: false, why: r.error };
      const m = await done;
      const res = m && Array.isArray(m.results) ? m.results[0] : null;
      if (!res || res.ok === false) return { ok: false, why: (res && res.why) || (m ? m.reason : 'Windows did not say whether it went to the Recycle Bin') };
      const token = `u${S.undoN}`;
      if (res.key) S.undo.set(token, res.key);
      return { ok: true, undo: res.key ? token : null };
    });
    ctx.command('undo', async (a) => {
      const key = S.undo.get(a && a.token);
      if (!key) return { ok: false, why: 'there is nothing to undo' };
      const r = await side.send('files.recycle.restore', { keys: [key], job: `clips-undo-${++S.undoN}` }, { timeoutMs: 8000 });
      if (r.ok) S.undo.delete(a.token);
      return r.ok ? { ok: true } : { ok: false, why: r.error };
    });
    ctx.command('folder', async () => { const dir = folder(); const err = dir ? await shell.openPath(dir) : 'no Captures folder'; return err ? { ok: false, why: err } : { ok: true }; });
    ctx.command('panel', async (a) => {
      const r = await openPanel((a && a.via) || 'a command');
      // --test only (the corner-follow trace): {holdMs} hides it again after that long (at most 60 s); placed as live
      const hold = test ? Math.min(60000, Math.round(Number(a && a.holdMs) || 0)) : 0;
      if (hold > 0 && r && r.to === 'panel') { clearTimeout(S.holdT); S.holdT = setTimeout(() => { S.holdT = null; hidePanel(`the test's ${hold} ms hold`); }, hold); }
      return r;
    });
    /* the panel says when an open is ON SCREEN (its first frame after clips.state {open}): the open
       time measured is Win+G (or the command) to that frame, made-window or warm */
    ctx.command('painted', (a) => {
      const o = S.opening;
      if (!o || !a || a.seq !== o.seq) return { ok: true, stale: true };
      S.opening = null;
      const ms = Date.now() - o.t0;
      S.opens.push({ ms, cold: o.cold, via: o.via, how: a.how || null, mainMs: o.shownAt ? o.shownAt - o.t0 : null });
      if (S.opens.length > 40) S.opens.shift();
      ctx.log(`record panel: on screen ${ms} ms after ${o.via}${o.cold ? ' (window made)' : ''}`);
      return { ok: true, ms };
    });
    ctx.command('win', (a) => {
      const w = S.gallery;
      const op = a && a.op;
      if (!w || w.isDestroyed()) return { ok: false, why: 'the Clips window is not open' };
      if (op === 'close') { w.close(); return { ok: true }; }
      if (test) return { ok: true, dryRun: true, why: `test mode: would ${op} the window` };
      if (op === 'min') w.minimize();
      else if (op === 'max') { if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
      else return { ok: false, why: `unknown window op "${op}"` };
      return { ok: true, maximized: w.isMaximized() };
    });
    if (test) {
      // the e2e's window into main: windows made, their processes' RAM, open times, Win+G's route
      ctx.command('debug', () => {
        const mem = (w) => {
          if (!w || w.isDestroyed()) return null;
          const pid = w.webContents.getOSProcessId();
          const m = app.getAppMetrics().find((x) => x.pid === pid);
          return { pid, memory: m ? m.memory : null, visible: w.isVisible(), bounds: w.getBounds() };
        };
        return {
          ok: true, panel: mem(S.panel), panelReady: S.panelReady, panelShown: S.panelShown, gallery: mem(S.gallery),
          panelMakes: S.panelMakes, galleryMakes: S.galleryMakes, opens: S.opens.slice(), idleMs,
          away: S.away ? { since: S.away.since } : null, awayChecks: S.awayChecks, awayMs, gamebar: Object.assign({}, S.gamebar),
          rec: Object.assign({}, S.rec, { pending: !!S.rec.pending }), folder: folder(), fake: fake ? fake.state() : null, watching: !!S.watch,
          polling: !!S.recT, wall: wall.state(), follow: followState(),
        };
      });
      ctx.command('fake', (a) => (fake ? { ok: true, state: fake.set(a || {}) } : { ok: false, why: 'this --test Mantle has no fake recorder (MANTLE_CLIPS_FAKE=1)' }));
    }

    // the launcher's "Clips" row (lib/launcher-index.js mantle:clips): listened to only while this runs
    const onLaunch = () => { try { openGallery(null); } catch (err) { ctx.log(`clips: the gallery did not open (${err.message})`); } };
    if (app && typeof app.on === 'function') app.on('mantle-open:clips', onLaunch);
    ctx.onChord(CHORD, () => { openPanel(CHORD).catch((err) => ctx.log(`Win+G: the panel could not open (${err.message})`)); });
    // a game ended: Win+G is Mantle's again (unless the setting gives it to Windows)
    ctx.onRest(({ on, why }) => {
      S.rest = on ? why : null;
      if (!on) { S.away = null; clearTimeout(S.awayT); S.awayT = null; ctx.keysAway(winG() ? null : 'the Win+G setting is off'); }
    });
    ctx.onOption('winG', () => ctx.keysAway(!winG() ? 'the Win+G setting is off' : S.away ? 'an exclusive full-screen app is in front' : null));
    if (!winG()) ctx.keysAway('the Win+G setting is off');
    ctx.health(true);

    return {
      stop() {
        S.stopped = true;
        clearTimeout(S.recT); clearTimeout(S.idleT); clearTimeout(S.awayT);
        unwatch();
        if (fake) fake.stop();
        wall.stop();
        if (app && typeof app.removeListener === 'function') app.removeListener('mantle-open:clips', onLaunch);
        dropPanel(null);
        F.stop();
        if (S.gallery && !S.gallery.isDestroyed()) S.gallery.destroy();
        S.gallery = null;
      },
    };
  },
};

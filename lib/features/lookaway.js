'use strict';
/*
 * lookaway.js - blur the screen when Owen looks away from it, unblur when he looks back
 * (lane lookaway, 2026-10-23).
 *
 * WHO DOES WHAT
 *   ui/lookaway/          a HIDDEN page: the camera (320x240) and MediaPipe's face detector (WASM,
 *                         bundled, no network). It sends back numbers only: face yes/no, head yaw and
 *                         pitch, face size. Detector chosen by measurement on the i3-1215U (see the
 *                         lane report): BlazeFace short range at 3-5 looks a second.
 *   _lookaway-core.js     PURE decision: away held for the delay (glances filtered), relative to his
 *                         own usual pose; never within 3 s of keyboard/mouse input; reveal at once.
 *   _lookaway-camera.js   is ANOTHER app using the camera (Windows' own record, read-only)?
 *   _unfold-bus.js        the full-screen cover; lane unfold-unlock draws it. We only ask.
 *
 * THE CAMERA IS ON ONLY WHILE IT WATCHES. It is released (every track stopped, the light goes off)
 * and the reason is the state line (State: features.lookaway.reason) whenever:
 *   the switch is off · a game runs (rest: the whole feature stops) · the screen is locked or the PC
 *   sleeps · another app uses the camera (a video call) · a full-screen app is in front · the screen
 *   cover is not running (health false, the bus's reason) · the camera failed (health false).
 *
 * PRIVACY: frames stay inside the hidden page for the few ms the model needs and are closed; nothing
 * is drawn, saved, logged or sent. The page's session is in memory only, cancels every web request,
 * and grants the camera to this one page. Logs carry decisions and timings, never images, app names
 * or window titles.
 *
 * TESTS never open the real camera: in --test the page starts only when Chromium runs with
 * --use-fake-device-for-media-stream (lib/features/lookaway.e2e.test.js feeds it a y4m clip).
 */

const bus = require('./_unfold-bus');
const { createLookaway } = require('./_lookaway-core');
const camera = require('./_lookaway-camera');

const PARTITION = 'lookaway';          // no "persist:" = in memory, nothing written to disk
const FROM = 'lookaway';
const PARK_MS = 20000;                 // a paused page is destroyed after this (the camera is off at once)
const RETRY_MS = [10000, 30000, 120000];
const FULLSCREEN_EVERY = 2, CAMERA_EVERY = 3;   // governor ticks (1 s) between the two reads

const WORDS = {
  watching: 'Watching. The camera light is on',
  starting: 'Starting the camera',
  locked: 'Paused while the screen is locked. The camera is off',
  asleep: 'Paused while the PC sleeps. The camera is off',
  otherCam: 'Paused while another app uses the camera. The camera is off',
  fullscreen: 'Paused while a full-screen app is in front. The camera is off',
};

const secMs = (v, d) => { const n = Number(v); return Math.round((Number.isFinite(n) ? Math.min(10, Math.max(0.5, n)) : d) * 1000); };

module.exports = {
  name: 'lookaway',
  label: 'Blur the screen when I look away',
  defaultOn: false,                    // it uses the camera: Owen switches it on himself
  chords: [],
  observe: [],
  rest: true,
  options: [
    { key: 'delay', label: 'Blur after looking away for', help: 'Uses the camera while it is on, so the camera light stays on. Pictures never leave your PC.',
      type: 'number', min: 0.5, max: 10, step: 0.5, unit: 's', default: 1.5 },
    { key: 'turn', label: 'A turned head counts as away', type: 'choice',
      choices: [{ value: 'small', label: 'Small turn' }, { value: 'normal', label: 'Clear turn' }, { value: 'never', label: 'Never, only when no face is seen' }], default: 'normal' },
  ],

  install(ctx) {
    const { BrowserWindow, session, powerMonitor, app } = require('electron');
    const T = !!(ctx.flags && ctx.flags.test);
    const core = createLookaway({ delayMs: secMs(ctx.settings.get('delay', 1.5), 1.5), turn: ctx.settings.get('turn', 'normal') });
    const G = {
      on: ctx.enabled(), busOk: bus.available(), locked: false, asleep: false, fullscreen: false, otherCam: false,
      failed: '', failCount: 0, retryAt: 0,
      win: null, page: 'none', watching: false, parkTimer: null, timer: null, ticks: 0, hz: 0,
      covering: false, revealing: false, coverAskedAt: 0, revealAskedAt: 0, lastCoverFail: '',
      reason: '', stopped: false,
      reads: { fullscreen: null, camera: null },     // what the last real reads answered (for the status)
      test: { input: -Infinity, fullscreen: false, otherCam: false },
      costPrev: null, lastSeenAt: 0, lastObs: null,
    };
    const now = () => Date.now();
    const fakeCamera = () => app.commandLine.hasSwitch('use-fake-device-for-media-stream');
    const tlog = (s) => { if (T) ctx.log('LOOKAWAY ' + s); };

    /* ---------------- the hidden page ---------------- */

    let sessionReady = false;
    function prepareSession() {
      if (sessionReady) return;
      const ses = session.fromPartition(PARTITION);
      ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_d, cb) => cb({ cancel: true }));
      const mine = (wc) => !!(G.win && !G.win.isDestroyed() && wc && wc.id === G.win.webContents.id);
      ses.setPermissionRequestHandler((wc, permission, cb, details) => {
        const types = (details && details.mediaTypes) || [];
        cb(permission === 'media' && mine(wc) && types.length > 0 && types.every((t) => t === 'video'));
      });
      ses.setPermissionCheckHandler((wc, permission, _origin, details) => permission === 'media' && mine(wc) && (!details || !details.mediaType || details.mediaType === 'video'));
      sessionReady = true;
    }

    function createWindow() {
      prepareSession();
      const win = new BrowserWindow({
        show: false, width: 64, height: 48, frame: false, skipTaskbar: true, focusable: false, hasShadow: false, resizable: false,
        webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, partition: PARTITION, spellcheck: false },
      });
      G.win = win; G.page = 'loading';
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('render-process-gone', (_e, d) => { if (G.win === win) pageFailed('the look-away page stopped (' + ((d && d.reason) || 'gone') + ')', true); });
      win.webContents.on('unresponsive', () => { if (G.win === win) pageFailed('the look-away page stopped answering', true); });
      win.webContents.on('did-fail-load', (_e, code, desc) => { if (G.win === win) pageFailed('the look-away page did not load (' + desc + ' ' + code + ')', true); });
      win.on('closed', () => { if (G.win === win) { G.win = null; G.page = 'none'; G.watching = false; } });
      win.loadFile(ctx.page('index.html')).catch(() => { /* did-fail-load says why */ });
    }

    function destroyWindow() {
      clearTimeout(G.parkTimer); G.parkTimer = null;
      const w = G.win; G.win = null; G.page = 'none'; G.watching = false;
      if (w && !w.isDestroyed()) w.destroy();   // the renderer goes, and every camera track with it
    }

    const send = (msg) => !!(G.win && !G.win.isDestroyed() && ctx.push(G.win, 'lookaway.ctl', msg));

    function startCamera() {
      if (!G.win) { createWindow(); return; }   // 'loaded' from the page starts it
      if (G.page === 'loaded' || G.page === 'stopped' || G.page === 'ready') {
        G.page = 'starting';
        G.hz = 3;
        send({ op: 'start', model: 'detector', delegate: 'CPU', width: 320, height: 240, hz: G.hz });
      }
    }

    function stopCamera(why) {
      if (G.win && (G.page === 'watching' || G.page === 'starting' || G.page === 'ready')) send({ op: 'stop', why });
      G.watching = false;
      if (G.page === 'watching' || G.page === 'starting') G.page = 'stopping';
    }

    function pageFailed(reason, gone) {
      G.failCount++;
      const wait = RETRY_MS[Math.min(G.failCount - 1, RETRY_MS.length - 1)];
      G.failed = reason; G.retryAt = now() + wait;
      core.pause(reason, now());
      ctx.log(`camera stopped: ${reason}; trying again in ${Math.round(wait / 1000)} s`);
      if (gone) destroyWindow(); else stopCamera('failed');
      revealIfMine('the camera stopped');
      evaluate();
    }

    /* ---------------- why the camera is (not) on ---------------- */

    function pauseWhy() {
      if (G.stopped) return { why: 'stopped', down: false };
      if (!G.on) return { why: 'off', down: false };
      if (!G.busOk) return { why: bus.state().reason || 'the screen cover is not running', down: true };
      if (T && !fakeCamera()) return { why: 'in a test the camera only opens with a fake device (--use-fake-device-for-media-stream)', down: true };
      if (G.locked) return { why: WORDS.locked, down: false };
      if (G.asleep) return { why: WORDS.asleep, down: false };
      if (G.otherCam) return { why: WORDS.otherCam, down: false };
      if (G.fullscreen) return { why: WORDS.fullscreen, down: false };
      if (G.failed) {
        const left = Math.max(0, Math.ceil((G.retryAt - now()) / 1000));
        return { why: `${G.failed}. Trying again in ${left} s`, down: true };
      }
      return null;
    }

    function evaluate() {
      const p = pauseWhy();
      if (!p) {
        clearTimeout(G.parkTimer); G.parkTimer = null;
        startCamera();
        setReason((G.watching ? WORDS.watching : WORDS.starting) + notes(), true);
      } else {
        stopCamera(p.why);
        core.pause(p.why, now());
        revealIfMine(p.why);
        if (p.why === 'off' || p.why === 'stopped') destroyWindow();
        else if (G.win && !G.parkTimer) G.parkTimer = setTimeout(() => { G.parkTimer = null; if (pauseWhy()) destroyWindow(); }, PARK_MS);
        setReason(p.why === 'off' ? '' : p.why, !p.down);
      }
      governor();
    }

    /** What it cannot check right now, said on the state line (no silent fallbacks). */
    function notes() {
      const n = [];
      if (G.reads.fullscreen === null && G.ticks >= FULLSCREEN_EVERY) n.push('a full-screen app does not pause it: Mantle\'s helper did not answer');
      if (G.reads.camera && G.reads.camera.error) n.push('it cannot tell when another app uses the camera: ' + G.reads.camera.error);
      return n.length ? '. Note: ' + n.join('; ') : '';
    }

    function setReason(text, ok) {
      if (G.reason !== text || G.ok !== ok) {
        if (G.reason !== text) ctx.log(text ? `now: ${text}` : 'now: off (camera off)');
        G.reason = text; G.ok = ok;
      }
      if (G.stopped) return;
      ctx.health(ok, text || undefined);
    }

    /* ---------------- the 1 s governor: only while on and awake ---------------- */

    function governor() {
      const want = !G.stopped && G.on && G.busOk && !G.locked && !G.asleep && (!T || fakeCamera());
      if (want && !G.timer) G.timer = setInterval(tick, 1000);
      if (!want && G.timer) { clearInterval(G.timer); G.timer = null; }
    }

    async function tick() {
      G.ticks++;
      if (G.failed && now() >= G.retryAt) { G.failed = ''; evaluate(); }
      if (G.ticks % FULLSCREEN_EVERY === 0) readFullscreen();
      if (G.ticks % CAMERA_EVERY === 0) readCamera();
      if (G.watching) act();
    }

    async function readFullscreen() {
      let full = false;
      if (ctx.sidecar.ready) {
        const r = await ctx.sidecar.send('foreground', {}, { timeoutMs: 1500 });
        // only the yes/no is kept: the answer also names the window, which is never stored or logged
        G.reads.fullscreen = r && r.ok && r.result && typeof r.result.fullscreen === 'boolean' ? r.result.fullscreen : null;
        full = G.reads.fullscreen === true;
      } else G.reads.fullscreen = null;
      if (T) full = G.test.fullscreen;
      const failing = G.reads.fullscreen === null;
      if (full !== G.fullscreen || failing !== G.fsFailing) { G.fullscreen = full; G.fsFailing = failing; evaluate(); }
    }

    function readCamera() {
      const r = camera.check(process.execPath);
      G.reads.camera = r.ok ? { others: r.others, self: r.self } : { error: r.reason };
      let busy = r.ok && r.others > 0;
      if (T) busy = G.test.otherCam;
      const failing = !r.ok;
      if (busy !== G.otherCam || failing !== G.camFailing) { G.otherCam = busy; G.camFailing = failing; evaluate(); }
    }

    function lastInputAt() {
      if (T) return G.test.input;
      try { return now() - powerMonitor.getSystemIdleTime() * 1000; } catch (_) { return -Infinity; }
    }

    /* ---------------- deciding and asking the cover ---------------- */

    function act() {
      const t = now();
      core.input(lastInputAt());
      const d = core.tick(t);
      if (d.want === 'cover' && !G.covering && !G.revealing) cover(d.why);
      else if (d.want === 'reveal' && !G.revealing) reveal(d.why);
      const hz = core.rate(t);
      if (hz && hz !== G.hz && G.watching) { G.hz = hz; send({ op: 'rate', hz }); }
    }

    function cover(why) {
      G.covering = true; G.coverAskedAt = now();
      core.coverChanged(true, true);   // at once: a look back during the fold must reveal
      ctx.log(`cover: ${why}`);
      bus.cover({ from: FROM }).then((r) => {
        G.covering = false;
        tlog(`covered ok=${!!(r && r.ok)} in ${now() - G.coverAskedAt} ms`);
        if (!r || !r.ok) {
          core.coverChanged(false, true);
          const reason = (r && r.reason) || 'the screen cover did not answer';
          if (reason !== G.lastCoverFail) ctx.log(`cover failed: ${reason}`);
          G.lastCoverFail = reason;
        } else G.lastCoverFail = '';
      });
    }

    function reveal(why) {
      G.revealing = true; G.revealAskedAt = now();
      ctx.log(`reveal: ${why}`);
      bus.reveal({ from: FROM }).then((r) => {
        G.revealing = false;
        tlog(`revealed ok=${!!(r && r.ok)} in ${now() - G.revealAskedAt} ms`);
        if (r && r.ok) core.coverChanged(false, true);
      });
    }

    function revealIfMine(why) {
      if (core.status().covered && !G.revealing) reveal(why);
    }

    const unBus = bus.onChange((s) => {
      if (G.stopped) return;
      if (!!s.available !== G.busOk) { G.busOk = !!s.available; evaluate(); }
      if (!s.covered && core.status().covered && !G.revealing) {
        core.coverChanged(false, false);   // the provider took it down (input): wait for a fresh look away
        ctx.log('the cover was taken down by input or the provider: waiting for a fresh look away');
        tlog('shown by someone else');
      }
    });

    /* ---------------- page commands ---------------- */

    ctx.command('page', async (a) => {
      const st = String((a && a.state) || '');
      if (!G.win) return { ok: false };
      if (st === 'loaded') { G.page = 'loaded'; if (!pauseWhy()) startCamera(); }
      else if (st === 'ready') { if (G.page === 'starting') G.page = 'ready'; }
      else if (st === 'watching') {
        if (pauseWhy()) { send({ op: 'stop', why: 'paused while it started' }); G.page = 'stopping'; return { ok: true }; }
        G.page = 'watching'; G.watching = true; G.failCount = 0;
        core.start(now());
        tlog(`watching ${a.width}x${a.height}@${a.fps}`);
        setReason(WORDS.watching + notes(), true);
      } else if (st === 'stopped') {
        G.page = 'stopped'; G.watching = false; tlog(`page stopped released=${a.released}`);
        if (!pauseWhy()) startCamera();   // it was asked to start again while it was stopping
      }
      else if (st === 'failed') pageFailed(String(a.reason || 'the camera failed'), false);
      return { ok: true };
    });

    ctx.command('seen', async (o) => {
      if (!G.watching || !o) return { ok: false };
      const t = now();
      const obs = { face: !!o.face, yaw: num(o.yaw), pitch: num(o.pitch), size: num(o.size) || 0 };
      G.lastSeenAt = t; G.lastObs = obs;
      const j = core.see(obs, t);
      tlog(`seen face=${obs.face ? 1 : 0} verdict=${j.verdict}`);
      act();
      return { ok: true };
    });

    ctx.command('status', async () => ({
      on: G.on, watching: G.watching, page: G.page, reason: G.reason, ok: G.ok !== false,
      pauses: { locked: G.locked, asleep: G.asleep, otherApp: G.otherCam, fullscreen: G.fullscreen, cover: !G.busOk, failed: G.failed || null },
      reads: G.reads, core: core.status(), hz: G.hz, cost: cost(),
      cover: bus.state(),
    }));

    if (T) {
      ctx.command('testInput', async () => { G.test.input = now(); return { ok: true }; });
      ctx.command('testFullscreen', async (a) => { G.test.fullscreen = !!(a && a.on); await readFullscreen(); return { ok: true, read: G.reads.fullscreen }; });
      ctx.command('testOtherApp', async (a) => { G.test.otherCam = !!(a && a.on); readCamera(); return { ok: true, read: G.reads.camera }; });
      ctx.command('testLock', async (a) => { if (a && a.on) onLock(); else onUnlock(); return { ok: true }; });
    }

    /* ---------------- what it costs, measured live (for State and Owen's live check) ---------------- */

    function cost() {
      try {
        const pid = G.win && !G.win.isDestroyed() ? G.win.webContents.getOSProcessId() : 0;
        const list = app.getAppMetrics();
        const pick = list.filter((m) => m.pid === pid || (m.type === 'Utility' && /video capture/i.test(m.name || m.serviceName || '')));
        const t = now();
        const cum = {};
        let pct = null, ws = 0;
        for (const m of pick) { cum[m.pid] = m.cpu.cumulativeCPUUsage || 0; ws += m.memory.workingSetSize / 1024; }
        if (G.costPrev) {
          const dt = (t - G.costPrev.t) / 1000;
          pct = 0;
          for (const m of pick) if (typeof G.costPrev.cum[m.pid] === 'number') pct += (cum[m.pid] - G.costPrev.cum[m.pid]) / dt * 100;
          pct = Math.round(pct * 100) / 100;
        }
        G.costPrev = { t, cum };
        return { processes: pick.length, cpuPctOfOneCore: pct, workingSetMB: Math.round(ws), note: pct === null ? 'ask again for a CPU figure (it is measured between two asks)' : 'the page and the camera service only' };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    }

    /* ---------------- Windows events ---------------- */

    const onLock = () => { G.locked = true; evaluate(); };
    const onUnlock = () => { G.locked = false; evaluate(); };
    const onSuspend = () => { G.asleep = true; evaluate(); };
    const onResume = () => { G.asleep = false; evaluate(); };
    powerMonitor.on('lock-screen', onLock);
    powerMonitor.on('unlock-screen', onUnlock);
    powerMonitor.on('suspend', onSuspend);
    powerMonitor.on('resume', onResume);

    ctx.onEnabled((on) => { G.on = !!on; if (on) { G.failed = ''; G.failCount = 0; } evaluate(); });
    ctx.onOption('*', (value, key) => {
      if (key === 'delay') core.set({ delayMs: secMs(value, 1.5) });
      if (key === 'turn') core.set({ turn: typeof value === 'string' ? value : 'normal' });
    });

    evaluate();

    return {
      stop(why) {
        G.stopped = true;
        if (G.timer) { clearInterval(G.timer); G.timer = null; }
        unBus();
        powerMonitor.removeListener('lock-screen', onLock);
        powerMonitor.removeListener('unlock-screen', onUnlock);
        powerMonitor.removeListener('suspend', onSuspend);
        powerMonitor.removeListener('resume', onResume);
        if (core.status().covered) bus.reveal({ from: FROM }).catch(() => {});   // never leave a blur behind
        stopCamera(String(why || 'stopped'));
        destroyWindow();
      },
    };
  },
};

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

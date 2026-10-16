'use strict';
/*
 * screenrec.js - Mantle records an area of the screen or one window (lanes mantle-screenrec and
 * screenrec2, 2026-10-15). Owen: "i want everything manlte". Win+Shift+S has a Record button (or V); the
 * same picks as a screenshot (an area, a window, a screen) are recorded instead of copied, and the same
 * chord again stops it. The Win+G panel's "Record a region or window" row calls screenrec.start.
 *
 * THE PIECES
 *   sidecar/Recorder.cs          `Mantle.Sidecar.exe --record`: ONE process per recording, exits when the
 *                                file is done (Windows.Graphics.Capture -> Media Foundation H.264 + AAC).
 *   _screenrec-core.js           the pure half: targets, refusals, the spec, names, the card's words.
 *   _screenrec-hub.js            the link to screenshot.js (the overlay, the chord, the picker).
 *   ui/screenrec/                the Stop pill (a calm living timer) that becomes the end card in place:
 *                                Open, Copy (the FILE, to paste into Discord or a chat), Show in folder.
 *
 * ZERO COST IDLE (Owen's RAM rule). Nothing runs between recordings: no window, no process, no timer.
 * The pill's window is made when a recording starts and destroyed when its card goes; the recorder is a
 * child process that ends with the file.
 *
 * NEVER A GAME. rest: true (stopped while Mantle rests for a game; a running recording is finished and
 * saved first), and before every start one sidecar gamemode.scan (the window in front) and shot.owner
 * (the picked window's process): a game in front or a game's window is refused in plain words, pointing
 * at Game Bar's Win+Alt+R. A failed check refuses too: no check, no recording.
 *
 * NEVER ON CAMERA. The pill and the card are content-protected (WDA_EXCLUDEFROMCAPTURE, 0x11, read
 * back from Windows and kept in screenrec.state as `affinity`), so they never appear in a recording or
 * in any other capture.
 *
 * --test: every recording is of the test's own stand-in window (MANTLE_REC_TEST_STANDIN=<hwnd>:<pid>
 * [:<w>:<h>], made by `Mantle.Sidecar.exe --rec-standin`), an area becoming a crop INSIDE it; the
 * recorder itself refuses anything else (test:true + allowPid). Files go under %TEMP% only, Open and
 * Show in folder only log, and Copy never touches the clipboard. Windows are never shown.
 *
 * COMMANDS  screenrec.start {kind:'region',rect}|{kind:'window',hwnd}|{kind:'screen',rect}|{} (nothing:
 *           open Win+Shift+S with Record on) -> {ok, reason?, picking?, startMs?}
 *           screenrec.stop -> {ok, stopped}       screenrec.state -> the view below
 *           (the page's) screenrec.loaded / pointer / pillStop / cardOpen / cardCopy / cardFolder / cardClose
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const C = require('./_screenrec-core.js');
const HUB = require('./_screenrec-hub.js');

const ROOT = path.join(__dirname, '..', '..');
const SCAN_MS = 1500;          // gamemode.scan: a few ms normally; past this the start is refused
const OWNER_MS = 1000;         // shot.owner for a picked window
const START_WAIT_MS = 12000;   // spawn -> the first frame in (a cold Media Foundation start is ~1 s)
const STOP_WAIT_MS = 15000;    // "stop" -> done; past this the recorder (our own child, by pid) is ended
const REST_WAIT_MS = 8000;     // a game started: how long the recording may take to finish its file
const CARD_BACKSTOP_MS = 5 * 60 * 1000;   // the page closes its card itself (~12 s); this is in case it cannot
const WDA_EXCLUDEFROMCAPTURE = 0x11;
// DIP: ONE window for the pill and the card it becomes (no resize mid-morph), top centre; its see-through
// part lets every click through (setIgnoreMouseEvents forward), the page takes clicks only over its shape
const WIN = { w: 480, h: 248 };

function clip(s, n) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > (n || 300) ? t.slice(0, (n || 300) - 1) + '…' : t; }

/** MANTLE_REC_TEST_STANDIN "<hwnd>:<pid>[:<w>:<h>]" -> { hwnd, pid, w, h } | null */
function parseStandin(raw) {
  const m = /^\s*([1-9][0-9]{0,18})\s*[:,]\s*([1-9][0-9]{0,9})(?:\s*[:,]\s*([1-9][0-9]{0,4})\s*[:,]\s*([1-9][0-9]{0,4}))?\s*$/.exec(String(raw || ''));
  if (!m) return null;
  return { hwnd: m[1], pid: Number(m[2]), w: m[3] ? Number(m[3]) : null, h: m[4] ? Number(m[4]) : null };
}

/**
 * --test: what the stand-in records instead of the asked target. A window -> the whole stand-in; an area or
 * a screen -> a crop of the same size (at most the stand-in's), centred INSIDE the stand-in.
 */
function testTarget(target, standin) {
  const t = { mode: 'window', hwnd: standin.hwnd };
  if (target.mode === 'window' || !target.crop) return t;
  const sw = standin.w || target.crop.w, sh = standin.h || target.crop.h;
  const w = Math.max(C.MIN_SIDE, Math.min(target.crop.w, sw)) & ~1, h = Math.max(C.MIN_SIDE, Math.min(target.crop.h, sh)) & ~1;
  if (w >= sw && h >= sh) return t;
  t.crop = { x: Math.max(0, Math.floor((sw - w) / 2)), y: Math.max(0, Math.floor((sh - h) / 2)), w, h };
  return t;
}

/** Where recordings go: test -> under %TEMP% only; else the saveDir option, else Videos\Captures. */
function outDirFor(test, testDir, setting, videos, tmp) {
  if (test) {
    const d = path.resolve(testDir || path.join(tmp, 'mantle-rec-feature-test'));
    const t = path.resolve(tmp).toLowerCase() + path.sep;
    return d.toLowerCase().startsWith(t) ? { dir: d, why: 'test mode' } : { dir: null, why: `test mode only saves under ${tmp}, not ${d}` };
  }
  if (setting) return { dir: setting, why: 'the saveDir setting' };
  if (videos) return { dir: C.capturesDir(videos), why: 'Videos\\Captures (Game Bar\'s folder)' };
  return { dir: null, why: 'Windows did not say where the Videos folder is: pick a folder in Mantle Settings > Screen recording' };
}

/** The recorder's stdout -> one event per JSON line (a broken line is an event too, never a throw). */
function lineReader(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l) continue;
      let e;
      try { e = JSON.parse(l); } catch (err) { e = { ev: 'garbage', text: clip(l, 200) }; }
      onEvent(e);
    }
    if (buf.length > 65536) buf = '';
  };
}

/**
 * The engine: everything but Electron, so lib/features/screenrec.test.js drives it with a fake recorder.
 * d = { test, log, sc(cmd, args, ms) -> {ok, ...result} | {ok:false, reason}, resting() -> words|null,
 *       standin: {hwnd,pid,w,h}|null, outDir() -> {dir, why}, options() -> {fps, audio, mic},
 *       spawn() -> child (stdin, stdout, stderr, pid, on('exit'), kill()), mkdir(dir), now(),
 *       ui: { open(view, anchor), update(view), card(view), close() }, publish(view), pick(via),
 *       timers: { setTimeout, clearTimeout } }
 */
function createEngine(d) {
  const T = d.timers || { setTimeout, clearTimeout };
  const now = d.now || Date.now;
  const S = { rec: null, last: null, restWhy: null, starts: 0, refused: 0 };

  function view() {
    const r = S.rec;
    const st = r ? r.st : (S.last || { phase: 'idle' });
    const v = {
      phase: st.phase, secs: st.secs || 0, w: st.w || null, h: st.h || null, fps: st.fps || null,
      encoder: st.encoder || null, audio: st.audio || null, late: st.late || 0, frames: st.frames || 0, bytes: st.bytes || 0,
      startMs: r ? r.startMs : (S.last && S.last.startMs) || null,
      startedAt: r && r.startedAt ? r.startedAt : null,
      name: st.name || null, error: st.error || null, note: st.stopWords || null, why: st.why || null,
      words: st.refused ? { title: 'Not recording', detail: st.error, warn: true } : st.phase === 'done' || st.phase === 'failed' ? C.cardWords(st) : null,
      clock: C.clock(st.secs), test: !!d.test,
    };
    if (d.test && st.path) v.path = st.path;
    return v;
  }
  const publish = () => { try { if (d.publish) d.publish(view()); } catch (e) { /* the state piece is best effort */ } };

  function fail(reason, via) {
    S.refused++;
    S.last = { phase: 'failed', error: reason, refused: true };
    d.log(`not recording (${via}): ${reason}`);
    try { d.ui.card(view()); } catch (e) { d.log(`the card could not say it: ${e.message}`); }
    publish();
    return { ok: false, reason };
  }

  async function start(a, via) {
    const by = via || 'screenrec.start';
    if (S.rec) return { ok: false, reason: 'a recording is already running: press Win+Shift+S or Stop to end it' };
    if (S.restWhy) return fail(`Mantle is resting while ${S.restWhy}, so it does not record. ${C.GAME_BAR}`, by);
    const x = a || {};
    if (!x.kind && !x.mode) {
      // nothing picked yet (the Win+G panel's row): Win+Shift+S's overlay, with Record on, picks it
      const p = d.pick ? d.pick(by) : { ok: false, reason: 'there is no overlay to pick an area or a window in' };
      if (!p || !p.ok) return fail((p && p.reason) || 'the overlay did not open', by);
      d.log(`${by}: opened Win+Shift+S with Record on, to pick what to record`);
      return { ok: true, picking: true };
    }
    const t = C.targetFrom(x);
    if (!t.ok) return fail(t.reason, by);
    let target = t.target;
    if (d.test) {
      if (!d.standin) return fail('a test run records only its own stand-in window, and MANTLE_REC_TEST_STANDIN names none', by);
      target = testTarget(target, d.standin);
    }
    // claim the slot NOW: a second start while the checks run is refused, not raced
    const r = S.rec = { st: { phase: 'checking' }, t0: now(), via: by, target, child: null, startMs: null, startedAt: null, stopWhy: null, stopTimer: null, waiters: [] };
    S.starts++;
    // the pill is up AT ONCE ("Starting…"): its window loads while the checks and the recorder start
    d.ui.open(view(), x.rect || null);
    publish();
    const unclaim = (reason) => {
      if (S.rec === r) S.rec = null;
      if (r.stopWhy) { d.log(`${by}: stopped before it started`); d.ui.close(); publish(); return { ok: false, reason: 'it was stopped before it started' }; }
      return fail(reason, by);
    };
    // the checks: a game in front, a game's window, resting
    const scan = await d.sc('gamemode.scan', { procs: true }, SCAN_MS);
    if (!scan || scan.ok === false) return unclaim(`Mantle could not check for a game in front (${clip(scan && scan.reason, 160) || 'no answer'}), so it did not record`);
    let targetFile = '';
    if (target.mode === 'window') {
      const o = await d.sc('shot.owner', { windows: [target.hwnd] }, OWNER_MS);
      const row = o && o.ok && Array.isArray(o.owners) ? o.owners.find((w) => String(w.window) === String(target.hwnd)) : null;
      if (row && row.exists === false) return unclaim('that window closed before the recording could start');
      targetFile = (row && row.exe) || '';
    }
    const why = C.refusal({ scan, resting: d.resting ? d.resting() : null, target, targetFile, test: !!d.test,
      testPid: d.standin ? d.standin.pid : 0, targetPid: d.test && d.standin && target.hwnd === d.standin.hwnd ? d.standin.pid : 0 });
    if (why) return unclaim(why);
    if (S.rec !== r || r.stopWhy) return unclaim('it was stopped before it started');
    // where it goes
    const od = d.outDir();
    if (!od.dir) return unclaim(od.why);
    try { d.mkdir(od.dir); } catch (e) { return unclaim(`the folder ${od.dir} could not be made (${clip(e.message, 160)}): pick another in Mantle Settings > Screen recording`); }
    const opt = d.options();
    const out = path.join(od.dir, C.recordingName(new Date(now())));
    const spec = C.specFor(target, { fps: opt.fps, audio: opt.audio, mic: opt.mic, out, test: !!d.test,
      allowPid: d.test && d.standin ? d.standin.pid : 0, testSecs: d.test ? Math.min(600, Math.max(0, Number(x.testSecs) || 0)) : 0 });
    // the recorder
    let child;
    try { child = d.spawn(); } catch (e) { return unclaim(`the recorder did not start (${clip(e.message, 200)})`); }
    r.child = child;
    let errTail = '';
    if (child.stderr) child.stderr.on('data', (b) => { errTail = (errTail + b.toString('utf8')).slice(-600); });
    const startP = new Promise((resolve) => { r.waiters.push(resolve); });
    const settle = (res) => { const w = r.waiters; r.waiters = []; for (const f of w) f(res); };
    const startTimer = T.setTimeout(() => {
      if (r.st.phase === 'recording' || r.st.phase === 'done') return;
      d.log(`the recorder gave no first frame in ${START_WAIT_MS} ms; ending it`);
      r.stopWhy = r.stopWhy || 'no first frame';
      try { child.kill(); } catch (e) { /* gone */ }
    }, START_WAIT_MS);
    const onEvent = (e) => {
      if (S.rec !== r && e.ev !== 'done' && e.ev !== 'error') return;
      if (e.ev === 'garbage') { d.log(`the recorder said something that is not JSON: ${e.text}`); return; }
      if (e.ev === 'done' && r.stopWhy && (e.why === 'stop' || !e.why)) e = Object.assign({}, e, { why: r.stopWhy });
      if (e.ev === 'done') e = Object.assign({}, e, { name: path.basename(String(e.path || '')) });
      r.st = C.reduce(r.st, e);
      if (e.ev === 'ready') {
        d.log(`recording ${target.mode === 'window' ? `window ${target.hwnd}` : 'an area'}${target.crop ? ` (${target.crop.w} x ${target.crop.h})` : ''} at ${e.w} x ${e.h}, ${e.fps} fps, ${e.encoder && e.encoder.name}${e.encoder && e.encoder.hardware ? ' (hardware)' : ''}; border ${e.border}${e.borderWhy ? ` (${e.borderWhy})` : ''}`);
        d.ui.update(view());
      } else if (e.ev === 'started') {
        r.startMs = now() - r.t0;
        r.startedAt = now();
        T.clearTimeout(startTimer);
        d.log(`started ${r.startMs} ms after ${by} asked`);
        d.ui.update(view());
        settle({ ok: true, startMs: r.startMs, w: r.st.w, h: r.st.h, fps: r.st.fps });
      } else if (e.ev === 'tick') {
        d.ui.update(view());
      } else if (e.ev === 'done' || e.ev === 'error') {
        T.clearTimeout(startTimer);
        finish(r);
      }
      publish();
    };
    child.stdout.on('data', lineReader(onEvent));
    child.on('error', (e) => { r.st = C.reduce(r.st, { ev: 'error', error: `the recorder could not run (${clip(e.message, 200)})` }); T.clearTimeout(startTimer); finish(r); });
    child.on('exit', (code) => {
      T.clearTimeout(startTimer);
      if (r.st.phase !== 'done' && r.st.phase !== 'failed') {
        const tail = clip(errTail, 200);
        r.st = C.reduce(r.st, r.stopWhy === 'no first frame'
          ? { ev: 'error', error: 'the recorder never got a first frame from Windows, so nothing was saved' }
          : { ev: 'exit', code });
        if (tail) d.log(`the recorder's last words: ${tail}`);
      }
      finish(r);
    });
    try { child.stdin.write(JSON.stringify(spec) + '\n'); } catch (e) { d.log(`the spec could not be sent (${e.message})`); }
    d.log(`${by}: the recorder is pid ${child.pid}, writing ${d.test ? out : C.recordingName(new Date(now()))}`);
    return startP;
  }

  /** The file is done (or it failed): the pill becomes the card, the slot frees. Once per recording. */
  function finish(r) {
    if (r.finished) return;
    r.finished = true;
    if (r.stopTimer) { T.clearTimeout(r.stopTimer); r.stopTimer = null; }
    try { r.child && r.child.stdin && r.child.stdin.end(); } catch (e) { /* gone */ }
    const st = Object.assign({}, r.st, { startMs: r.startMs });
    if (st.phase !== 'done' && st.phase !== 'failed') Object.assign(st, { phase: 'failed', error: st.error || 'the recorder stopped without finishing the file' });
    if (S.rec === r) S.rec = null;
    S.last = st;
    if (st.phase === 'done') d.log(`saved ${st.name}: ${C.clock(st.secs)}, ${st.frames} frames (${st.late || 0} late), ${C.size(st.bytes)}${st.stopWords ? `; ${st.stopWords}` : ''}`);
    else d.log(`the recording failed: ${st.error}`);
    const v = view();
    if (r.quiet) d.ui.close(); else d.ui.card(v);
    const res = st.phase === 'done' ? { ok: true, startMs: r.startMs, name: st.name, secs: st.secs } : { ok: false, reason: st.error };
    const w = r.waiters; r.waiters = []; for (const f of w) f(res);
    for (const f of r.doneFns || []) { try { f(st); } catch (e) { /* a waiter */ } }
    publish();
  }

  /** "stop": the recorder finishes the file. -> true when a recording was told to stop. */
  function stop(via, why) {
    const r = S.rec;
    if (!r) return false;
    if (r.stopWhy && r.child) return true;   // already stopping
    r.stopWhy = why || 'stop';
    d.log(`stop (${via || 'screenrec.stop'})${why ? `: ${why}` : ''}`);
    if (!r.child) { publish(); return true; }   // still checking: start() sees stopWhy and gives up
    r.st = Object.assign({}, r.st, { phase: r.st.phase === 'recording' ? 'stopping' : r.st.phase });
    d.ui.update(view());
    try { r.child.stdin.write('stop\n'); } catch (e) { d.log(`"stop" could not be sent (${e.message}); ending the recorder`); try { r.child.kill(); } catch (_) { /* gone */ } }
    r.stopTimer = T.setTimeout(() => {
      if (r.finished) return;
      d.log(`the recorder did not finish within ${STOP_WAIT_MS} ms of "stop"; ending it (pid ${r.child.pid})`);
      try { r.child.kill(); } catch (e) { /* gone */ }
    }, STOP_WAIT_MS);
    publish();
    return true;
  }

  /** Stop and wait for the file (resting, quitting). -> the final state, or null when nothing ran. */
  function stopAndWait(why, ms, quiet) {
    const r = S.rec;
    if (!r) return Promise.resolve(null);
    r.quiet = !!quiet;
    return new Promise((resolve) => {
      let t = null;
      (r.doneFns = r.doneFns || []).push((st) => { if (t) T.clearTimeout(t); resolve(st); });
      t = T.setTimeout(() => { try { r.child && r.child.kill(); } catch (e) { /* gone */ } resolve(null); }, ms || REST_WAIT_MS);
      if (!stop('Mantle', why)) { T.clearTimeout(t); resolve(null); }
    });
  }

  return {
    start, stop, stopAndWait, view,
    active: () => !!S.rec,
    last: () => S.last,
    clearLast() { S.last = null; publish(); },
    setResting(why) { S.restWhy = why || null; publish(); },
    stats: () => ({ starts: S.starts, refused: S.refused }),
  };
}

module.exports = {
  name: 'screenrec',
  label: 'Screen recording (Record in Win+Shift+S)',
  defaultOn: true,
  rest: true,                  // stopped while Mantle rests for a game: Game Bar's Win+Alt+R records games
  chords: [],
  observe: [],
  options: [
    { key: 'fps', label: 'Frame rate', help: '60 is smoother for fast motion and makes bigger files', type: 'choice',
      choices: [{ value: 30, label: '30 frames a second' }, { value: 60, label: '60 frames a second' }], default: 30 },
    { key: 'audio', label: 'Record the sound playing on this PC', help: 'Whatever you hear while recording, in the video', type: 'bool', default: true },
    { key: 'mic', label: 'Record the microphone too', help: 'Your default microphone, mixed in with the PC\'s sound', type: 'bool', default: false },
    { key: 'saveDir', label: 'Save recordings to', help: 'Where every recording is saved as an MP4', type: 'folder', default: null, defaultLabel: 'Videos\\Captures' },
  ],
  _test: { createEngine, parseStandin, testTarget, outDirFor, lineReader, WDA_EXCLUDEFROMCAPTURE, WIN },

  install(ctx) {
    const { BrowserWindow, screen, shell, app } = require('electron');
    const cp = require('child_process');
    const test = !!ctx.flags.test;
    const standin = test ? parseStandin(process.env.MANTLE_REC_TEST_STANDIN) : null;
    const exe = test && process.env.MANTLE_SIDECAR_EXE ? path.resolve(ROOT, process.env.MANTLE_SIDECAR_EXE) : path.join(ROOT, 'sidecar', 'bin', 'Mantle.Sidecar.exe');
    let stopped = false;
    let resting = null;
    let state = null;   // the last view, for screenrec.state

    /* ---- the window: the pill, then the card, in one content-protected window ---------------------- */
    let nat;
    const native = () => {
      if (nat !== undefined) return nat;
      try {
        const user32 = require('koffi').load('user32.dll');
        nat = {
          affinity: user32.func('int __stdcall GetWindowDisplayAffinity(intptr_t hwnd, void *out)'),
          setAffinity: user32.func('int __stdcall SetWindowDisplayAffinity(intptr_t hwnd, uint32 affinity)'),
        };
      } catch (e) { nat = null; ctx.log(`koffi could not bind GetWindowDisplayAffinity (${clip(e.message, 160)}); the pill's capture exclusion is set but not read back`); }
      return nat;
    };
    const ui = {
      win: null, hwnd: null, loaded: false, pending: null, mode: null, anchor: null, affinity: null, backstop: null, size: null,
      /** WDA_EXCLUDEFROMCAPTURE, PROVEN: read back from Windows; when Electron's setContentProtection did not
       *  leave it at 0x11 (e2e 2026-10-16: a hidden --test window read 0), set it with user32 directly and
       *  read again. ui.affinity is what Windows says, never what was asked for. */
      protect(when) {
        const n = native();
        if (!n || !ui.hwnd) return;
        const read = () => { const out = Buffer.alloc(4); try { return n.affinity(Number(ui.hwnd), out) ? out.readUInt32LE(0) : null; } catch (e) { return null; } };
        let a = read();
        let via = 'Electron';
        if (a !== WDA_EXCLUDEFROMCAPTURE) {
          let ok = 0;
          try { ok = n.setAffinity(Number(ui.hwnd), WDA_EXCLUDEFROMCAPTURE); } catch (e) { ok = 0; }
          a = read();
          via = ok ? 'user32 SetWindowDisplayAffinity' : 'nothing (SetWindowDisplayAffinity failed)';
        }
        ui.affinity = a; ui.affinityVia = via;
        if (a !== WDA_EXCLUDEFROMCAPTURE) ctx.log(`the pill's display affinity is ${a == null ? 'unreadable' : '0x' + a.toString(16)} (${when}), not WDA_EXCLUDEFROMCAPTURE (0x11): it may show in captures`);
        else if (via !== 'Electron') ctx.log(`the pill is excluded from capture (0x11, ${when}) by ${via}: Electron's setContentProtection had left it at another value`);
      },
      hwndOf(win) { try { const b = win.getNativeWindowHandle(); return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0)); } catch (e) { return null; } },
      display() {
        try {
          const p = ui.anchor ? screen.screenToDipPoint({ x: ui.anchor.x + Math.floor(ui.anchor.w / 2), y: ui.anchor.y + Math.floor(ui.anchor.h / 2) }) : screen.getCursorScreenPoint();
          return screen.getDisplayNearestPoint(p);
        } catch (e) { return screen.getPrimaryDisplay(); }
      },
      /** top centre of the target's screen, under any top bar (its work area) */
      place(size) {
        if (!ui.win || ui.win.isDestroyed()) return;
        ui.size = size;
        const wa = ui.display().workArea;
        try { ui.win.setBounds({ x: Math.round(wa.x + (wa.width - size.w) / 2), y: Math.round(wa.y + 6), width: Math.round(size.w), height: Math.round(size.h) }); } catch (e) { ctx.log(`the pill could not be placed (${e.message})`); }
      },
      ensure() {
        if (ui.win && !ui.win.isDestroyed()) return ui.win;
        const win = new BrowserWindow({
          show: false, frame: false, transparent: true, skipTaskbar: true, hasShadow: false, resizable: false, thickFrame: false,
          fullscreenable: false, minimizable: false, maximizable: false, focusable: false, alwaysOnTop: !test, type: 'toolbar',
          backgroundColor: '#00000000', width: WIN.w, height: WIN.h, title: 'Mantle Recording',
          webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
        });
        // never in a recording or any other capture: WDA_EXCLUDEFROMCAPTURE, then read back from Windows
        try { win.setContentProtection(true); } catch (e) { ctx.log(`content protection could not be set (${e.message})`); }
        if (!test) try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { /* the plain always-on-top stays */ }
        try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { /* then the see-through part takes clicks */ }
        ui.win = win; ui.hwnd = ui.hwndOf(win); ui.loaded = false; ui.affinity = null;
        ui.protect('made');
        win.webContents.on('will-navigate', (e) => e.preventDefault());
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('render-process-gone', (_e, det) => { ctx.log(`the recording pill's page crashed (${det && det.reason}); the recording goes on (Win+Shift+S stops it)`); ui.close(); });
        win.webContents.on('did-finish-load', () => { ui.loaded = true; ui.flush(); });
        win.once('ready-to-show', () => { if (!test && ui.win === win && !win.isDestroyed()) { win.showInactive(); ui.protect('shown'); } });
        win.on('closed', () => { if (ui.win === win) { ui.win = null; ui.hwnd = null; ui.loaded = false; } });
        win.loadFile(ctx.page('index.html'));
        return win;
      },
      flush() { if (ui.loaded && ui.pending && ui.win && !ui.win.isDestroyed()) { const p = ui.pending; ui.pending = null; ctx.push(ui.win, 'screenrec.state', p); } },
      send(v) { ui.pending = Object.assign({}, v, { affinity: ui.affinity }); ui.flush(); },
      open(v, anchor) {
        ui.anchor = anchor && Number.isFinite(anchor.x) ? anchor : null;
        clearTimeout(ui.backstop);
        ui.ensure(); ui.mode = 'pill'; ui.place(WIN); ui.send(v);
      },
      update(v) { if (ui.win && !ui.win.isDestroyed()) ui.send(v); },
      card(v) {
        if (stopped) return;
        ui.ensure();
        if (!ui.mode) ui.place(WIN);
        ui.mode = 'card';
        ui.send(v);
        clearTimeout(ui.backstop);
        ui.backstop = setTimeout(() => ui.close(), CARD_BACKSTOP_MS);
      },
      close() {
        clearTimeout(ui.backstop);
        const w = ui.win;
        ui.win = null; ui.hwnd = null; ui.loaded = false; ui.pending = null; ui.mode = null; ui.anchor = null;
        try { if (w && !w.isDestroyed()) w.destroy(); } catch (e) { /* gone */ }
      },
    };

    /* ---- the engine, on the real things --------------------------------------------------------------- */
    const E = createEngine({
      test, standin,
      log: ctx.log,
      sc: async (cmd, args, ms) => {
        const r = await ctx.sidecar.send(cmd, args || {}, { timeoutMs: ms || 4000 });
        return r.ok ? Object.assign({ ok: true }, r.result) : { ok: false, reason: r.error };
      },
      resting: () => resting,
      outDir: () => outDirFor(test, process.env.MANTLE_REC_TEST_DIR || null, ctx.settings.get('saveDir', null), (() => { try { return app.getPath('videos'); } catch (e) { return null; } })(), os.tmpdir()),
      options: () => ({ fps: Number(ctx.settings.get('fps', 30)) === 60 ? 60 : 30, audio: ctx.settings.get('audio', true) !== false, mic: ctx.settings.get('mic', false) === true }),
      mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
      spawn: () => {
        if (!fs.existsSync(exe)) throw new Error(`${exe} is missing: run npm run build:sidecar`);
        const child = cp.spawn(exe, ['--record'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        // the encoder keeps up at Normal; a test run's recorder is Below Normal like every heavy test
        try { if (test && child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* stays Normal */ }
        return child;
      },
      ui,
      pick: (via) => HUB.pick(via),
      publish: (v) => { state = v; },
    });

    HUB.set({
      active: () => E.active(),
      stop: (via) => E.stop(via),
      startFrom: (a) => E.start(a, `Win+Shift+S (${(a && a.mode) || 'record'})`),
      available: () => !stopped && ctx.enabled(),
      why: () => (stopped ? 'screen recording is stopped' : !ctx.enabled() ? 'screen recording is switched off in the tray (Mantle Settings > Mantle)' : null),
    });

    /* ---- commands ------------------------------------------------------------------------------------ */
    const view = () => Object.assign({ enabled: ctx.enabled(), affinity: ui.affinity, affinityVia: ui.affinityVia || null, window: !!ui.win, picker: HUB.hasPicker() }, state || E.view(), E.stats());
    ctx.command('start', async (a) => {
      if (!ctx.enabled()) return { ok: false, reason: 'screen recording is switched off in the tray (Mantle Settings > Mantle)' };
      return E.start(a, (a && a.via) ? `screenrec.start (${clip(a.via, 40)})` : 'screenrec.start');
    });
    ctx.command('stop', async () => ({ ok: true, stopped: E.stop('screenrec.stop') }));
    ctx.command('state', async () => view());
    // the page
    ctx.command('loaded', async () => { ui.loaded = true; ui.flush(); return { ok: true }; });
    // the page: the pointer is over the pill or the card (take clicks) / left it (clicks go through again)
    ctx.command('pointer', async (a) => {
      const over = !!(a && a.over);
      if (ui.win && !ui.win.isDestroyed()) try { ui.win.setIgnoreMouseEvents(!over, { forward: true }); } catch (e) { /* gone */ }
      if (ui.mode === 'card') { clearTimeout(ui.backstop); ui.backstop = setTimeout(() => ui.close(), CARD_BACKSTOP_MS); }
      return { ok: true, over };
    });
    const file = () => { const l = E.last(); return l && l.phase === 'done' && l.path ? l.path : null; };
    ctx.command('cardOpen', async () => {
      const p = file();
      if (!p) return { ok: false, reason: 'there is no saved recording to open' };
      if (!fs.existsSync(p)) return { ok: false, reason: 'the file is not there any more (moved or deleted)' };
      if (test) { ctx.log(`TESTREC open ${path.basename(p)} (a test run never opens it)`); return { ok: true, test: true }; }
      const err = await shell.openPath(p);
      return err ? { ok: false, reason: `Windows could not open it: ${clip(err, 160)}` } : { ok: true };
    });
    ctx.command('cardFolder', async () => {
      const p = file();
      if (!p) return { ok: false, reason: 'there is no saved recording to show' };
      if (!fs.existsSync(p)) return { ok: false, reason: 'the file is not there any more (moved or deleted)' };
      if (test) { ctx.log(`TESTREC folder ${path.basename(p)} (a test run never opens Explorer)`); return { ok: true, test: true }; }
      shell.showItemInFolder(p);
      return { ok: true };
    });
    ctx.command('cardCopy', async () => {
      const p = file();
      if (!p) return { ok: false, reason: 'there is no saved recording to copy' };
      if (!fs.existsSync(p)) return { ok: false, reason: 'the file is not there any more (moved or deleted)' };
      if (test) { ctx.log(`TESTREC copy ${path.basename(p)} (a test run never touches the clipboard)`); return { ok: true, test: true }; }
      // the FILE (CF_HDROP, like Explorer's Copy), so Ctrl+V in Discord or a chat attaches the video
      const r = await ctx.sidecar.send('files.clip.set', { paths: [p], cut: false }, { timeoutMs: 4000 });
      return r.ok ? { ok: true } : { ok: false, reason: `Windows did not take it onto the clipboard (${clip(r.error, 160)})` };
    });
    ctx.command('cardClose', async () => {
      if (E.active()) return { ok: false, reason: 'a recording is running: its pill stays' };   // a late close of the last card
      ui.close(); E.clearLast(); return { ok: true };
    });
    ctx.command('pillStop', async () => ({ ok: true, stopped: E.stop('the pill\'s Stop') }));

    ctx.log(test ? `ready (test: ${standin ? `stand-in window ${standin.hwnd}, pid ${standin.pid}` : 'NO stand-in, so every start is refused'})` : 'ready: Win+Shift+S has Record (V); nothing runs until a recording starts');
    if (typeof ctx.health === 'function') { const has = fs.existsSync(exe); ctx.health(has, has ? '' : `${path.basename(exe)} is missing: run npm run build:sidecar`); }

    return {
      async stop(why, how) {
        const rest = !!(how && how.rest);
        if (rest) resting = String(why || 'a game runs').replace(/^resting while /, '');
        // a game started (or Mantle is stopping): finish the file first, quietly
        const st = await E.stopAndWait(rest ? 'a game started' : 'Mantle closed', REST_WAIT_MS, true);
        if (st) ctx.log(st.phase === 'done' ? `the recording was finished and saved as ${st.name} (${why})` : `the recording ended without a file (${why}): ${st.error}`);
        stopped = true;
        ui.close();
        if (rest) {
          const words = `Mantle is resting while ${resting}, so it does not record. ${C.GAME_BAR}`;
          HUB.set({ active: () => false, stop: () => false, startFrom: async () => ({ ok: false, reason: words }), available: () => false, why: () => words });
        } else HUB.set(null);
      },
    };
  },
};

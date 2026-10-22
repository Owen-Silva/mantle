'use strict';
/*
 * _screenrec-core.js - the pure half of screen recording (lane screenrec, 2026-10-15): what is recorded,
 * when Mantle refuses, the recorder's spec, the file name, and the words. No Electron, no processes, so
 * lib/features/_screenrec-core.test.js proves all of it in plain node.
 *
 * THE MODEL. A recording is of ONE target:
 *   { mode: 'window', hwnd }                        a window, followed as it moves (Windows.Graphics.Capture)
 *   { mode: 'monitor', x, y, crop: {x,y,w,h} }      an area of one screen, in VIRTUAL-screen physical px;
 *                                                   (x,y) is a point on that screen (the area's centre)
 * From the Win+Shift+S overlay: Rectangle -> an area, Window -> that window (the desktop under the pointer
 * -> its screen), Full screen -> the screen. From the screenrec.start command (the clips lane's Win+G panel):
 * { kind: 'region', rect } | { kind: 'window', hwnd } | { kind: 'screen', rect }.
 *
 * REFUSED, in plain words, before anything starts: a game in front (Game Bar's Win+Alt+R is the recorder
 * for games; Mantle never records, opens or injects into a game), a window that belongs to a game, an
 * area under 64 x 64 or over 4096 on a side, and in --test anything but the test's own stand-in window.
 */
const path = require('path');
const P = require('./_gamemode-plan.js');

const MIN_SIDE = 64;
const MAX_SIDE = 4096;
const FPS = [30, 60];
const GAME_BAR = 'Game Bar records games: press Win+Alt+R';

function pad2(n) { return String(n).padStart(2, '0'); }

/** "Recording 2026-10-15 213000.mp4": the screenshot's naming (ui/screenshot/geometry.js screenshotName). */
function recordingName(d) {
  return `Recording ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.mp4`;
}

/** Game Bar's own folder: Videos\Captures (the user's 4 Game Bar videos are there). */
function capturesDir(videosDir) { return path.win32.join(String(videosDir || ''), 'Captures'); }

function rectOk(r) { return r && [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n)); }

/** The overlay's commit ({mode, rect, hwnd, kind}) or the command's args -> { ok, target } | { ok:false, reason }. */
function targetFrom(a) {
  const x = a || {};
  const kind = x.kind === 'region' || x.mode === 'rect' ? 'region'
    : (x.kind === 'window' || x.mode === 'window') && x.kind !== 'desktop' && x.kind !== 'monitor' ? 'window'
    : x.kind === 'screen' || x.mode === 'full' || x.kind === 'monitor' || x.kind === 'desktop' ? 'screen' : null;
  if (!kind) return { ok: false, reason: 'say what to record: an area, a window or a screen' };
  if (kind === 'window') {
    const h = String(x.hwnd || '');
    if (!/^[1-9][0-9]{0,18}$/.test(h)) return { ok: false, reason: 'no window was picked to record' };
    return { ok: true, target: { mode: 'window', hwnd: h } };
  }
  if (!rectOk(x.rect)) return { ok: false, reason: kind === 'region' ? 'no area was picked to record' : 'no screen was picked to record' };
  const r = { x: Math.round(x.rect.x), y: Math.round(x.rect.y), w: Math.round(x.rect.w), h: Math.round(x.rect.h) };
  if (r.w < MIN_SIDE || r.h < MIN_SIDE) return { ok: false, reason: `the area is too small to record (${r.w} × ${r.h}; pick at least ${MIN_SIDE} × ${MIN_SIDE})` };
  if (r.w > MAX_SIDE || r.h > MAX_SIDE) return { ok: false, reason: `the area is too big to record (${r.w} × ${r.h}; at most ${MAX_SIDE} on a side)` };
  return { ok: true, target: { mode: 'monitor', x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2), crop: r } };
}

/**
 * Why not record now, or null. o = { scan: gamemode.scan's answer ({fg, procs}) or null, resting: the words
 * Mantle rests with (a game runs) or null, target, targetFile: the target window's process file (window mode),
 * test, testPid, targetPid }.
 */
function refusal(o) {
  const x = o || {};
  if (x.resting) return `Mantle is resting while ${x.resting}, so it does not record. ${GAME_BAR}`;
  const fg = x.scan ? P.detectGame(x.scan.fg, x.scan.procs) : null;
  if (fg && fg.game) return `${fg.file} is in front, and Mantle never records games. ${GAME_BAR}`;
  const t = x.target || {};
  if (t.mode === 'window' && x.targetFile && (P.KNOWN_GAMES.concat(P.RUN_EXES)).some((g) => P.sameFile(g, x.targetFile)))
    return `that window is ${x.targetFile}, a game, and Mantle never records games. ${GAME_BAR}`;
  if (x.test && !(t.mode === 'window' && x.testPid && x.targetPid === x.testPid))
    return 'a test run records only its own stand-in window, never the screen or another window';
  return null;
}

/** The recorder's stdin spec (sidecar/Recorder.cs). */
function specFor(target, o) {
  const x = o || {};
  const fps = FPS.includes(Number(x.fps)) ? Number(x.fps) : 30;
  return Object.assign({}, target, {
    fps, audio: x.audio !== false, mic: x.mic === true, out: x.out,
    maxSecs: x.maxSecs || 4 * 3600, minFreeMb: x.minFreeMb || 1024,
    test: !!x.test, allowPid: x.test ? (x.allowPid || 0) : 0, testSecs: x.test ? (x.testSecs || 0) : 0,
  });
}

/** 5 -> "0:05", 65 -> "1:05", 3725 -> "1:02:05" */
function clock(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
}

function size(bytes) {
  const b = Number(bytes) || 0;
  return b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(1)} GB` : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

/** Why it stopped, for the card: null when the user stopped it himself. */
function stopWords(why) {
  const w = String(why || 'stop');
  if (w === 'stop') return null;
  if (w === 'Mantle closed') return 'Stopped because Mantle closed';
  if (/^error: /.test(w)) return `Stopped early: ${w.slice(7)}`;
  return `Stopped because ${w}`;
}

/** The recorder's events -> the state the pill, the card and screenrec.state show. Never mutates. */
function reduce(st, ev) {
  const s = Object.assign({ phase: 'idle' }, st || {});
  const e = ev || {};
  switch (e.ev) {
    case 'ready': return Object.assign(s, { phase: 'starting', w: e.w, h: e.h, fps: e.fps, encoder: e.encoder, border: e.border, borderWhy: e.borderWhy || null, audio: e.audio });
    case 'started': return Object.assign(s, { phase: 'recording', secs: 0 });
    case 'tick': return Object.assign(s, { secs: e.secs, frames: e.frames, late: e.late, bytes: e.bytes, freeMb: e.freeMb });
    case 'done': return Object.assign(s, { phase: 'done', path: e.path, name: e.name, secs: e.secs, bytes: e.bytes, frames: e.frames, late: e.late, why: e.why, stopWords: stopWords(e.why) });
    case 'error': return Object.assign(s, { phase: 'failed', error: String(e.error || 'the recorder failed without saying why') });
    case 'exit': return s.phase === 'done' || s.phase === 'failed' ? s : Object.assign(s, { phase: 'failed', error: `the recorder stopped unexpectedly (exit ${e.code})` });
    default: return s;
  }
}

/** The end card's words. */
function cardWords(st) {
  const s = st || {};
  if (s.phase === 'failed') return { title: 'Recording not saved', detail: s.error, warn: true };
  return { title: 'Recording saved', detail: [clock(s.secs), s.w && s.h ? `${s.w} × ${s.h}` : null, s.bytes ? size(s.bytes) : null].filter(Boolean).join(' · '), note: s.stopWords || null, name: s.name };
}

module.exports = { MIN_SIDE, MAX_SIDE, FPS, GAME_BAR, recordingName, capturesDir, targetFrom, refusal, specFor, clock, size, stopWords, reduce, cardWords };

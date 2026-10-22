'use strict';
/**
 * lib/fg-grant.js - hand THIS process's right to set the foreground window on to the sidecar, at
 * the moment of a click (lane mn-focus, 2026-10-12).
 *
 * WHY: the bar is focusable:false, so a click on a pin leaves the app the user was in as the foreground
 * process, and the click is delivered to Electron's process. Windows lets "the process that received
 * the last input event" set the foreground - Electron here - but the process that actually calls
 * SetForegroundWindow is the sidecar, which never had that right. Live, 24 clicks in two days
 * answered "Windows refused the foreground change". AllowSetForegroundWindow(sidecar pid), from
 * the process that got the click, is the documented hand-over (switcher.pick has done it since it
 * shipped); the sidecar's plain SetForegroundWindow then lands (the ladder reports "direct").
 *
 * grant(pid) -> {granted, reason}: never throws. reason says why not, in words, for the log.
 */

let bound;          // undefined = not tried; null = could not bind (see bindWhy)
let bindWhy = null;

function native() {
  if (bound !== undefined) return bound;
  bound = null;
  if (process.platform !== 'win32') { bindWhy = 'this is not Windows'; return null; }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    bound = { allow: user32.func('int __stdcall AllowSetForegroundWindow(uint32 pid)') };
  } catch (err) {
    bindWhy = `koffi could not bind user32.dll (${String(err && err.message).split('\n')[0]})`;
  }
  return bound;
}

/** `impl` is for tests: {allow(pid) -> int}. */
function grant(pid, impl) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { granted: false, reason: 'the sidecar is not running (no pid)' };
  const api = impl || native();
  if (!api) return { granted: false, reason: bindWhy || 'no native binding' };
  try {
    return api.allow(n) !== 0
      ? { granted: true, reason: null }
      // FALSE: this process had no right to hand on (the click was not the last input any more,
      // or something holds LockSetForegroundWindow). The sidecar's ladder still runs.
      : { granted: false, reason: 'Windows did not let Mantle hand its foreground right on (the click was no longer the last input)' };
  } catch (err) {
    return { granted: false, reason: `AllowSetForegroundWindow threw (${String(err && err.message).split('\n')[0]})` };
  }
}

/** One short phrase for a log line: "granted" or "not granted: <why>". */
function words(g) { return g && g.granted ? 'granted' : `not granted: ${(g && g.reason) || 'unknown'}`; }

/** The ladder's report as log words, without names or titles: "direct", or "switch after direct: refused; ...". */
function howWords(r) {
  const x = r && typeof r === 'object' ? r : {};
  const how = x.how ? String(x.how) : 'unknown';
  const tried = Array.isArray(x.tried) && x.tried.length ? ` after ${x.tried.map(String).join('; ')}` : '';
  return `${how}${tried}${Number.isFinite(x.ms) ? `, ${x.ms} ms` : ''}`;
}

/**
 * The sidecar's refusal ends "; tried direct: refused; attach: ...". That list is for the log; the
 * bar shows the sentence before it. -> {shown, tried} (tried '' when there is none).
 */
function splitTried(message) {
  const m = String(message == null ? '' : message);
  const cut = m.indexOf('; tried ');
  return cut < 0 ? { shown: m, tried: '' } : { shown: m.slice(0, cut), tried: m.slice(cut + 2) };
}

module.exports = { grant, words, howWords, splitTried };
